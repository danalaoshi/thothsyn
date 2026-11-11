"""请求/响应 Pydantic 模型。"""
from __future__ import annotations
from typing import Any
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
