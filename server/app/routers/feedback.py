"""用户留言（0.1.12）：设置页 → 数据库 → 超管管理页。

与 messages.py 的方向相反，而且是**唯一不需要登录的写接口**：
扩展定位是本地优先、不登录也能用，留言窗口不能反过来逼用户先注册。
已登录时通过可选鉴权附带 user_id / 账号邮箱，匿名时靠必填联系方式回访。

安全取舍：
- 正文按不可信纯文本原样存储，服务端不解析、不拼接 HTML
- 前后端双重限制 500 字（字符数，非字节）
- 轻量防刷：同一联系方式 60 秒内只收一条；这是单表查询，跨进程/多 worker
  同样有效。公网部署仍应在网关层再叠加 IP 限流或验证码
- 匿名写不返回任何东西，也不给客户端查询/删除/标记已读的能力
"""
from __future__ import annotations
import re
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import get_optional_user, CurrentUser
from .. import models
from ..schemas import FeedbackCreate
from ..timeutil import now_ms

router = APIRouter(prefix="/feedback", tags=["feedback"])

CONTACT_COOLDOWN_MS = 60_000
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("")
async def create_feedback(
    payload: FeedbackCreate,
    cur: CurrentUser | None = Depends(get_optional_user),
    session: AsyncSession = Depends(get_session),
):
    content = payload.content.strip()
    contact = payload.contact.strip()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="留言内容不能为空",
        )
    if not contact:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="请填写联系方式，方便回访",
        )
    if payload.contact_type == "email" and not EMAIL_RE.match(contact):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="邮箱格式看起来不对",
        )

    # 同一联系方式 60 秒一条：挡住手抖重复提交与最朴素的脚本刷屏
    dup = await session.execute(
        select(models.Feedback.id)
        .where(models.Feedback.contact == contact)
        .where(models.Feedback.created_at > now_ms() - CONTACT_COOLDOWN_MS)
        .limit(1)
    )
    if dup.first() is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="提交太频繁，请稍后再试",
        )

    item = models.Feedback(
        user_id=cur.user_id if cur else None,
        account_email=cur.email if cur else None,
        contact_type=payload.contact_type,
        contact=contact,
        content=content,
        client_version=payload.client_version,
        created_at=now_ms(),
        is_read=False,
        read_at=None,
    )
    session.add(item)
    await session.commit()
    await session.refresh(item)
    return {"ok": True, "id": item.id}
