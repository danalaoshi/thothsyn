"""收藏（captures）云端镜像：列表 / 详情 / 软删。

写路径主要由 /api/sync 承担（来自扩展端增量同步）；此处提供管理页所需的查看与删除。
所有查询按 user_id 行级隔离。
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_current_user, CurrentUser
from .. import models
from ..timeutil import now_ms

router = APIRouter(prefix="/captures", tags=["captures"])


@router.get("")
async def list_captures(
    folder_id: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    limit: int = 200,
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(models.Capture).where(
        models.Capture.user_id == cur.user_id,
        models.Capture.deleted_at.is_(None),
    )
    if folder_id:
        stmt = stmt.where(models.Capture.folder_id == folder_id)
    if tag:
        stmt = stmt.where(models.Capture.tags.contains([tag]))
    if q:
        stmt = stmt.where(or_(models.Capture.title.ilike(f"%{q}%"), models.Capture.text.ilike(f"%{q}%")))
    stmt = stmt.order_by(models.Capture.created_at.desc()).limit(min(limit, 500))
    rows = (await session.execute(stmt)).scalars().all()
    return {"items": [models.capture_to_dict(c) for c in rows]}


@router.get("/{cap_id}")
async def get_capture(
    cap_id: str,
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(models.Capture, cap_id)
    if not c or c.user_id != cur.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return models.capture_to_dict(c)


@router.delete("/{cap_id}")
async def delete_capture(
    cap_id: str,
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(models.Capture, cap_id)
    if not c or c.user_id != cur.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    c.deleted_at = now_ms()
    c.updated_at = now_ms()
    await session.commit()
    return {"ok": True}
