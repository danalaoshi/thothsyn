"""管理页（superuser）API：查看全部用户 / 查看删除任意用户内容。"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import require_superuser, CurrentUser
from .. import models
from ..timeutil import now_ms

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users")
async def list_users(
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    rows = (
        await session.execute(
            text(
                "SELECT u.id, u.email, u.email_confirmed_at, u.created_at, "
                "p.level, p.is_paid, p.is_superuser "
                "FROM auth.users u "
                "LEFT JOIN public.profiles p ON p.id = u.id::text "
                "ORDER BY u.created_at DESC LIMIT 200"
            )
        )
    ).mappings().all()
    return {"items": [dict(r) for r in rows]}


@router.get("/captures")
async def admin_captures(
    user_id: str | None = None,
    limit: int = 200,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(models.Capture)
    if user_id:
        stmt = stmt.where(models.Capture.user_id == user_id)
    stmt = stmt.order_by(models.Capture.updated_at.desc()).limit(min(limit, 500))
    rows = (await session.execute(stmt)).scalars().all()
    return {"items": [models.capture_to_dict(c) for c in rows]}


@router.delete("/captures/{cap_id}")
async def admin_delete_capture(
    cap_id: str,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(models.Capture, cap_id)
    if not c:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    c.deleted_at = now_ms()
    c.updated_at = now_ms()
    await session.commit()
    return {"ok": True}
