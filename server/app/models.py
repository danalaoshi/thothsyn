"""云端数据模型（落在 Supabase Postgres 的 public schema）。

设计要点：
- auth.users 由 GoTrue 托管，本应用不自建 users 表。
- profiles.id == auth.users.id（UUID 字符串），等级语义映射见 deps.recompute_level。
- folders / captures 的 id 由客户端生成（UUIDv4）并作为主键 —— 这是本地↔云端同步对齐的关键。
- updated_at 为 epoch 毫秒，是增量同步游标与 LWW 冲突裁决的依据。
- deleted_at 非空表示软删（tombstone），用于跨端删除传播。
"""
from __future__ import annotations
from sqlalchemy import String, Text, Boolean, BigInteger, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# 同步时允许落库的字段白名单（防止客户端写入 user_id 等越权字段）
CAPTURE_FIELDS = {
    "id", "user_id", "title", "url", "html", "text",
    "kind", "folder_id", "tags", "created_at", "updated_at", "deleted_at",
}
FOLDER_FIELDS = {
    "id", "user_id", "name", "type",
    "created_at", "updated_at", "deleted_at",
}


class Base(DeclarativeBase):
    pass


class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # = auth.users.id
    level: Mapped[str] = mapped_column(String(20), default="unverified")
    is_paid: Mapped[bool] = mapped_column(Boolean, default=False)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0)


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(20))  # business | tag
    created_at: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    # 服务端自增版本号（同步拉取游标）。**不能用 updated_at 当游标**：
    # updated_at 来自客户端时钟，而游标来自服务端时钟，两端偏差几毫秒就会
    # 让新写入的记录"看起来比游标还旧"，从此再也拉不下来。
    rev: Mapped[int] = mapped_column(BigInteger, default=0, index=True)


class Capture(Base):
    __tablename__ = "captures"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    title: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(Text, default="")
    html: Mapped[str] = mapped_column(Text, default="")       # full 类只存 url（html 空）；partial 存 dom html
    text: Mapped[str] = mapped_column(Text, default="")       # 预览/搜索用纯文本
    kind: Mapped[str] = mapped_column(String(20), default="full")  # full | partial
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    rev: Mapped[int] = mapped_column(BigInteger, default=0, index=True)


class Message(Base):
    """后台下发的站内消息（0.1.11）。

    `id` 由 Postgres BIGSERIAL 生成，同时充当客户端增量拉取的游标：
    服务端自增、严格单调，不会像客户端时钟那样出现「新消息比游标还旧」。
    `recipient_id` 为空 = 全体用户可见；非空 = 只对该 user_id 可见。
    正文按不可信输入处理：两端都只当纯文本，绝不解析 HTML。
    """
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sender_id: Mapped[str] = mapped_column(String(36))
    recipient_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[int] = mapped_column(BigInteger, default=0)


class Feedback(Base):
    """用户留言（0.1.12）：设置页 → 数据库 → 管理页，方向与其它通道相反。

    user_id / account_email 可空：不登录也能留言，联系方式必填承担回访入口。
    content 按不可信纯文本处理，两端都不得解析 HTML。
    is_read 只影响超管的未读计数，不给客户端任何回写权限。
    """
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    account_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_type: Mapped[str] = mapped_column(String(10))       # im | email
    contact: Mapped[str] = mapped_column(String(200), index=True)
    content: Mapped[str] = mapped_column(Text)
    client_version: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    read_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


def capture_to_dict(c: Capture) -> dict:
    return {k: getattr(c, k) for k in CAPTURE_FIELDS}


def folder_to_dict(f: Folder) -> dict:
    return {k: getattr(f, k) for k in FOLDER_FIELDS}


def message_to_dict(m: Message) -> dict:
    return {
        "id": m.id,
        "sender_id": m.sender_id,
        "recipient_id": m.recipient_id,
        "title": m.title,
        "body": m.body,
        "created_at": m.created_at,
    }


def feedback_to_dict(f: Feedback) -> dict:
    return {
        "id": f.id,
        "user_id": f.user_id,
        "account_email": f.account_email,
        "contact_type": f.contact_type,
        "contact": f.contact,
        "content": f.content,
        "client_version": f.client_version,
        "created_at": f.created_at,
        "is_read": bool(f.is_read),
        "read_at": f.read_at,
    }
