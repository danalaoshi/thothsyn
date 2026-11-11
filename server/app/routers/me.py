"""账户与等级：/api/me 同步邮箱确认态并返回 profile。"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_current_user, CurrentUser, recompute_level
from .. import models
from ..supabase_client import gotrue_get_user
from ..schemas import MeResponse

router = APIRouter(tags=["account"])


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/me")
async def me(
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    gu = await gotrue_get_user(cur.token)
    email = cur.email
    email_confirmed = None
    if gu:
        email = gu.get("email") or email
        email_confirmed = bool(gu.get("email_confirmed_at"))
        recompute_level(cur.profile, email_confirmed)
        await session.commit()
    return MeResponse(
        id=cur.user_id,
        email=email,
        level=cur.profile.level,
        is_paid=cur.profile.is_paid,
        is_superuser=cur.profile.is_superuser,
        email_confirmed=email_confirmed,
    )
