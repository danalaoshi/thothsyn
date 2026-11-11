"""文件夹（folders）云端镜像：列表 / 软删。"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_current_user, CurrentUser
from .. import models
from ..timeutil import now_ms

router = APIRouter(prefix="/folders", tags=["folders"])


@router.get("")
async def list_folders(
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    rows = (
        await session.execute(
            select(models.Folder)
            .where(models.Folder.user_id == cur.user_id, models.Folder.deleted_at.is_(None))
            .order_by(models.Folder.created_at.desc())
        )
    ).scalars().all()
    return {"items": [models.folder_to_dict(f) for f in rows]}


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: str,
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    f = await session.get(models.Folder, folder_id)
    if not f or f.user_id != cur.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    f.deleted_at = now_ms()
    f.updated_at = now_ms()
    await session.commit()
    return {"ok": True}
