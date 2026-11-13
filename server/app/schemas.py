"""请求/响应 Pydantic 模型。"""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, Field


class ChangeItem(BaseModel):
    entity: str                       # "capture" | "folder"
    op: str                           # "upsert" | "delete"
    record: dict[str, Any] = Field(default_factory=dict)


class SyncRequest(BaseModel):
    mode: str = "both"                # "push" | "pull" | "both"
    cursor: int = 0                   # 客户端上次见到的 server updated_at 上限
    changes: list[ChangeItem] = Field(default_factory=list)


class SyncResponse(BaseModel):
    server_cursor: int
    changes: list[ChangeItem] = Field(default_factory=list)
    conflicts: list[dict] = Field(default_factory=list)


class SessionOut(BaseModel):
    """归一化后的登录会话（扩展端直接消费）。"""
    access_token: str | None = None
    refresh_token: str | None = None
    expires_at: int | None = None          # epoch 秒
    user_id: str | None = None
    email: str | None = None
    email_confirmed: bool = False
    needs_confirmation: bool = False       # 需要用户点邮件里的确认链接


class MeResponse(BaseModel):
    id: str
    email: str | None = None
    level: str
    is_paid: bool
    is_superuser: bool
    email_confirmed: bool | None = None


class MessageCreate(BaseModel):
    """超管下发消息。正文按纯文本处理，两端都不得解析 HTML。"""
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=2000)
    # 空 = 全体用户；非空 = 只发给这个 user_id
    recipient_id: str | None = Field(default=None, max_length=36)


class FeedbackCreate(BaseModel):
    """用户留言（0.1.12）。不需要登录；联系方式必填，便于超管回访。

    content 用字符数（不是字节）限制 500 字，中文一个字算一个；
    前端用 Array.from(...).length 按码点计数，与 Python len() 对齐。
    """
    content: str = Field(min_length=1, max_length=500)
    contact_type: Literal["im", "email"]
    contact: str = Field(min_length=1, max_length=200)
    client_version: str = Field(default="", max_length=20)
