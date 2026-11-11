"""Supabase（GoTrue）JWT 校验。

GoTrue 真实签发的用户 token 默认用 **ES256（椭圆曲线）** 签名（本地栈与托管版一致），
其公钥通过 JWKS 端点 `/auth/v1/.well-known/jwks.json` 公开。因此生产/真实场景下应
用 JWKS 异步校验。同时保留 HS256 兜底，兼容：
  - 本地测试用同一 JWT secret 伪造的 token；
  - 任何以 HS256 + 该 secret 签发的 token。

校验顺序：先试 HS256（无网络、快），失败再异步拉 JWKS 校验 ES256/RS256。
用户 token 的 claim：
- sub   : auth.users.id（即我们的 user_id）
- role  : "authenticated"
- email : 用户邮箱
"""
from __future__ import annotations

import time
import jwt
from jwt import PyJWK
import httpx
from fastapi import HTTPException, status
from .config import settings

# 极简 JWKS 缓存：避免每个请求都拉一次公钥
_jwks_cache: dict[str, tuple[float, dict]] = {}


def _assert_user_claims(payload: dict) -> dict:
    if payload.get("role") != "authenticated" or not payload.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not an authenticated user token",
        )
    return payload


async def decode_supabase_jwt(token: str) -> dict:
    # 1) HS256 兜底：本地测试 / 以 JWT secret 签发的 token（同步、无网络）
    if settings.supabase_jwt_secret:
        try:
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
            return _assert_user_claims(payload)
        except jwt.PyJWTError:
            pass

    # 2) JWKS：异步拉取并校验 GoTrue 真实签发的 ES256/RS256 token
    if settings.supabase_url:
        try:
            jwks_url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
            now = time.time()
            cached = _jwks_cache.get(jwks_url)
            if cached and now - cached[0] < 600:
                jwks = cached[1]
            else:
                async with httpx.AsyncClient(timeout=10) as client:
                    r = await client.get(jwks_url)
                    r.raise_for_status()
                    jwks = r.json()
                _jwks_cache[jwks_url] = (now, jwks)

            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            key_dict = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
            if key_dict:
                public_key = PyJWK(key_dict).key
                payload = jwt.decode(
                    token,
                    public_key,
                    algorithms=["ES256", "RS256"],
                    options={"verify_aud": False},
                )
                return _assert_user_claims(payload)
        except Exception:
            # JWKS 拉取失败或 token 不匹配，交下方统一 401
            pass

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired token",
    )
