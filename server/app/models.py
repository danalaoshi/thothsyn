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


def capture_to_dict(c: Capture) -> dict:
    return {k: getattr(c, k) for k in CAPTURE_FIELDS}


def folder_to_dict(f: Folder) -> dict:
    return {k: getattr(f, k) for k in FOLDER_FIELDS}
