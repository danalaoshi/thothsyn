"""站内消息拉取（0.1.11）：登录用户按服务端自增 id 做增量拉取。

可见性只有两种：
- recipient_id IS NULL  → 全体用户可见
- recipient_id == me    → 定向消息，只有目标用户能拉到

`since` 用服务端 BIGSERIAL 的 id，不用 created_at：created_at 来自服务端时钟，
同一毫秒内可能连发多条，拿它当游标会漏消息；自增主键严格单调，天然安全。

正文一律当作纯文本返回，服务端不解析、不拼接 HTML；扩展端用 textContent /
已转义的 innerHTML 展示，网页端交给 React 自动转义，绝不进 innerHTML 原文。
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_current_user, CurrentUser
from .. import models

router = APIRouter(prefix="/messages", tags=["messages"])


@router.get("")
async def list_messages(
    since: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    cur: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = (
        select(models.Message)
        .where(models.Message.id > since)
        .where(
            or_(
                models.Message.recipient_id.is_(None),
                models.Message.recipient_id == cur.user_id,
            )
        )
        .order_by(models.Message.id.asc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    items = [models.message_to_dict(m) for m in rows]
    # 没有新消息时水位不动，避免下次仍以 0 全量拉一遍
    return {"items": items, "cursor": items[-1]["id"] if items else since}
