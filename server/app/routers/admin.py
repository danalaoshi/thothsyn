"""管理页（superuser）API：查看全部用户 / 查看删除任意用户内容 / 下发站内消息 / 查看留言。"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import require_superuser, CurrentUser
from .. import models
from ..schemas import MessageCreate
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


# ---- 消息推送通道（0.1.11）：只有超管能发 / 看已发 / 撤回 ----

@router.post("/messages")
async def send_message(
    payload: MessageCreate,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="title must not be blank",
        )
    msg = models.Message(
        sender_id=cur.user_id,
        recipient_id=payload.recipient_id or None,
        title=title,
        body=payload.body,
        created_at=now_ms(),
    )
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    return {"ok": True, "item": models.message_to_dict(msg)}


@router.get("/messages")
async def list_sent_messages(
    limit: int = 50,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    stmt = (
        select(models.Message)
        .order_by(models.Message.id.desc())
        .limit(min(max(limit, 1), 200))
    )
    rows = (await session.execute(stmt)).scalars().all()
    return {"items": [models.message_to_dict(m) for m in rows]}


@router.delete("/messages/{msg_id}")
async def revoke_message(
    msg_id: int,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    msg = await session.get(models.Message, msg_id)
    if not msg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    await session.delete(msg)
    await session.commit()
    return {"ok": True}


# ---- 用户留言（0.1.12）：只有超管能看 / 标记已读 / 删除 ----
# 客户端写入走公开的 POST /api/feedback，读写权限刻意分离。

@router.get("/feedback")
async def list_feedback(
    limit: int = 100,
    only_unread: bool = False,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(models.Feedback)
    if only_unread:
        stmt = stmt.where(models.Feedback.is_read.is_(False))
    stmt = stmt.order_by(models.Feedback.id.desc()).limit(min(max(limit, 1), 300))
    rows = (await session.execute(stmt)).scalars().all()
    unread = await session.scalar(
        select(func.count())
        .select_from(models.Feedback)
        .where(models.Feedback.is_read.is_(False))
    )
    return {
        "items": [models.feedback_to_dict(f) for f in rows],
        "unread": int(unread or 0),
        "total_shown": len(rows),
    }


@router.post("/feedback/{fb_id}/read")
async def mark_feedback_read(
    fb_id: int,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    item = await session.get(models.Feedback, fb_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if not item.is_read:
        item.is_read = True
        item.read_at = now_ms()
        await session.commit()
        await session.refresh(item)
    return {"ok": True, "item": models.feedback_to_dict(item)}


@router.delete("/feedback/{fb_id}")
async def delete_feedback(
    fb_id: int,
    cur: CurrentUser = Depends(require_superuser),
    session: AsyncSession = Depends(get_session),
):
    item = await session.get(models.Feedback, fb_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    await session.delete(item)
    await session.commit()
    return {"ok": True}
