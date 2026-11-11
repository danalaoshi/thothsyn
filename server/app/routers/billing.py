"""支付空壳：/api/billing/upgrade

按需求：支付方案待定，仅做状态翻转用于联调（标 TODO 真实支付）。
付费后等级由 unverified/formal 升为 paid；superuser 保持。
"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_current_user, CurrentUser
from ..supabase_client import gotrue_get_user
from ..routers.me import recompute_level

router = APIRouter(prefix="/billing", tags=["billing"])


@router.post("/upgrade")
async def upgrade(
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # TODO: 真实支付集成（Stripe / 微信支付 / 支付宝等）尚未确定，先翻转状态供联调。
    gu = await gotrue_get_user(cur.token)
    email_confirmed = bool(gu.get("email_confirmed_at")) if gu else False
    cur.profile.is_paid = True
    recompute_level(cur.profile, email_confirmed)
    await session.commit()
    return {"ok": True, "level": cur.profile.level, "is_paid": True}
