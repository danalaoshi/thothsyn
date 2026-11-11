"""当前用户依赖：校验 Supabase JWT → 取 user_id → 懒加载/创建 profiles 行。

等级门禁：
- require_sync_enabled : 未验证邮箱(unverified 且非 superuser) → 403，禁止同步
- require_superuser   : 非 superuser → 403
"""
from __future__ import annotations
from dataclasses import dataclass
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from .db import get_session
from .security import decode_supabase_jwt
from .supabase_client import gotrue_get_user
from . import models
from .timeutil import now_ms

bearer = HTTPBearer(auto_error=False)


def recompute_level(profile: models.Profile, email_confirmed: bool) -> None:
    """等级推导：superuser > paid > 已验证(formal) > 未验证(unverified)。"""
    if profile.is_superuser:
        profile.level = "superuser"
    elif profile.is_paid:
        profile.level = "paid"
    elif email_confirmed:
        profile.level = "formal"
    else:
        profile.level = "unverified"


@dataclass
class CurrentUser:
    user_id: str
    profile: models.Profile
    token: str
    email: str | None


async def get_token(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> str:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return creds.credentials


async def get_current_user(
    token: str = Depends(get_token),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser:
    payload = await decode_supabase_jwt(token)
    user_id = payload["sub"]
    profile = await session.get(models.Profile, user_id)
    if profile is None:
        # 首次访问：懒创建 profile，默认 unverified（/api/me 会依据邮箱确认态修正）
        profile = models.Profile(
            id=user_id, level="unverified", created_at=now_ms(), updated_at=now_ms()
        )
        session.add(profile)
        await session.commit()
        await session.refresh(profile)
    return CurrentUser(user_id=user_id, profile=profile, token=token, email=payload.get("email"))


async def require_sync_enabled(
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser:
    if cur.profile.is_superuser:
        if cur.profile.level != "superuser":
            cur.profile.level = "superuser"
            await session.commit()
        return cur
    if cur.profile.level == "unverified":
        # 自愈：刚注册的账号在调用 /api/me 之前 profile 仍是 unverified。
        # 直接用 GoTrue 的真实确认态修正一次，避免「已经登录、邮箱也确认了，
        # 却因为没先打开设置页而同步被拒」这种莫名其妙的 403。
        gu = await gotrue_get_user(cur.token)
        if gu and gu.get("email_confirmed_at"):
            recompute_level(cur.profile, True)
            await session.commit()
        else:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="email not verified; sync is disabled until you confirm your email",
            )
    return cur


async def require_superuser(cur: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not cur.profile.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="superuser required")
    return cur
