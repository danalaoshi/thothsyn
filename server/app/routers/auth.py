"""鉴权代理：把 GoTrue（Supabase Auth）包一层，给浏览器扩展用。

为什么不让扩展直连 GoTrue：
- 扩展只需要记一个「服务器地址」，不用同时配 Supabase 网关地址与 anon key；
- 扩展页 / Service Worker 的跨域预检少一跳，出错面更小；
- anon key 不必随扩展产物分发（虽然它是公开 key，但少一处泄露面）。

本路由只做协议转换与错误归一，**不**自建用户表、不签发 token —— 令牌一律由 GoTrue 签发，
FastAPI 侧仍然只校验 JWT（见 app/security.py）。
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from ..config import settings
from ..schemas import SessionOut

router = APIRouter(prefix="/auth", tags=["auth"])

TIMEOUT = 10.0


def _headers() -> dict[str, str]:
    key = settings.supabase_anon_key or settings.supabase_service_role_key
    h = {"Content-Type": "application/json"}
    if key:
        h["apikey"] = key
        h["Authorization"] = f"Bearer {key}"
    return h


def _error_detail(resp: httpx.Response) -> str:
    """GoTrue 的错误体字段不统一（msg / error_description / message），逐个兜。"""
    try:
        data = resp.json()
    except Exception:
        return f"鉴权服务返回 {resp.status_code}"
    for k in ("msg", "error_description", "message", "error"):
        v = data.get(k)
        if isinstance(v, str) and v:
            return v
    return f"鉴权服务返回 {resp.status_code}"


async def _gotrue(
    method: str,
    path: str,
    *,
    json: dict | None = None,
    params: dict | None = None,
) -> dict:
    url = f"{settings.supabase_url.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.request(
                method, url, headers=_headers(), json=json, params=params
            )
    except httpx.HTTPError as e:  # 连不上 GoTrue
        raise HTTPException(status_code=503, detail=f"鉴权服务不可用：{e}") from e
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    try:
        return resp.json()
    except Exception:
        return {}


def _session_from(payload: dict) -> SessionOut:
    """把 GoTrue 的会话对象裁成扩展真正需要的字段。

    expires_at 用 epoch 秒（与 JWT exp 一致），扩展据此决定何时刷新。
    """
    user = payload.get("user") or {}
    expires_in = payload.get("expires_in")
    access = payload.get("access_token")
    expires_at = None
    if access and isinstance(expires_in, int):
        # 由 GoTrue 给的相对秒数换算；不解析 JWT，避免依赖 token 内部结构
        import time

        expires_at = int(time.time()) + expires_in
    return SessionOut(
        access_token=access,
        refresh_token=payload.get("refresh_token"),
        expires_at=expires_at,
        user_id=user.get("id"),
        email=user.get("email"),
        email_confirmed=bool(user.get("email_confirmed_at") or user.get("confirmed_at")),
        needs_confirmation=not bool(access),
    )


class Credentials(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class EmailIn(BaseModel):
    email: EmailStr


@router.post("/signup", response_model=SessionOut)
async def signup(body: Credentials) -> SessionOut:
    """注册。本地 Supabase 默认开启邮箱自动确认，会直接返回会话；
    若部署环境要求邮件确认，则返回 needs_confirmation=true 且不带 token。"""
    data = await _gotrue(
        "POST",
        "/auth/v1/signup",
        json={"email": body.email, "password": body.password},
    )
    return _session_from(data)


@router.post("/login", response_model=SessionOut)
async def login(body: Credentials) -> SessionOut:
    data = await _gotrue(
        "POST",
        "/auth/v1/token",
        params={"grant_type": "password"},
        json={"email": body.email, "password": body.password},
    )
    return _session_from(data)


@router.post("/refresh", response_model=SessionOut)
async def refresh(body: RefreshIn) -> SessionOut:
    data = await _gotrue(
        "POST",
        "/auth/v1/token",
        params={"grant_type": "refresh_token"},
        json={"refresh_token": body.refresh_token},
    )
    return _session_from(data)


@router.post("/recover")
async def recover(body: EmailIn) -> dict:
    """发送重置密码邮件。无论邮箱是否存在都返回 ok，避免枚举用户。"""
    try:
        await _gotrue("POST", "/auth/v1/recover", json={"email": body.email})
    except HTTPException:
        pass
    return {"ok": True}
