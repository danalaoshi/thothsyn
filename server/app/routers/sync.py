"""双向增量同步：/api/sync

统一端点，支持三模式：
- push : 仅把本地变更上传到云端（本地→云）
- pull : 仅拉取云端自 cursor 起的变更（云→本地）
- both : 双向，取最大内容集合（默认）

两个时间轴必须分清（这是最容易踩的坑）：
- `updated_at` 是**内容版本**，由客户端时钟决定，用于 LWW 冲突裁决；
- `rev` 是**服务端自增版本号**（Postgres 序列），只用于拉取游标。
如果用 updated_at 当游标，客户端时钟比服务端快/慢几毫秒，就会让刚写入的
记录「比游标还旧」而永远拉不下来。

冲突裁决：同 id 两端都改过 → LWW（updated_at 大者胜），败方写入 conflicts。
软删传播：delete 上传 {op:delete, id, updated_at}；服务端置 deleted_at，
拉取时以 tombstone 返回（同样带 rev，保证能拉到）。
安全：所有写入强制 user_id = 当前用户，拒绝跨用户写。
"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import require_sync_enabled, CurrentUser
from .. import models
from ..timeutil import now_ms
from ..schemas import SyncRequest, SyncResponse, ChangeItem

router = APIRouter(prefix="/sync", tags=["sync"])

_ENTITY_MODEL = {"capture": models.Capture, "folder": models.Folder}
# 建表时与 migrations/002_sync_rev.sql 一起创建；nextval 不会回滚，
# 因此并发写入也不会拿到重复的 rev。
_REV_SEQ = "thoth_sync_rev_seq"


async def _next_rev(session: AsyncSession) -> int:
    return int(
        (await session.execute(text(f"SELECT nextval('{_REV_SEQ}')"))).scalar_one()
    )


async def _max_rev(session: AsyncSession, user_id: str) -> int:
    """该用户当前的最大 rev，作为下一次拉取的游标。"""
    a = (
        await session.execute(
            select(func.max(models.Capture.rev)).where(models.Capture.user_id == user_id)
        )
    ).scalar()
    b = (
        await session.execute(
            select(func.max(models.Folder.rev)).where(models.Folder.user_id == user_id)
        )
    ).scalar()
    return int(max(a or 0, b or 0))


def _coerce(entity: str, rec: dict) -> dict:
    fields = models.CAPTURE_FIELDS if entity == "capture" else models.FOLDER_FIELDS
    out: dict = {}
    for k in fields:
        if k in rec:
            out[k] = rec[k]
    for k in ("created_at", "updated_at", "deleted_at"):
        if k in out and out[k] is not None:
            out[k] = int(out[k])
    if "tags" in out and not isinstance(out["tags"], list):
        out["tags"] = list(out["tags"]) if out["tags"] else []
    return out


def _to_change(entity: str, obj) -> ChangeItem:
    return ChangeItem(
        entity=entity,
        op="delete" if obj.deleted_at else "upsert",
        record=models.capture_to_dict(obj) if entity == "capture" else models.folder_to_dict(obj),
    )


@router.post("")
async def sync(
    req: SyncRequest,
    cur: CurrentUser = Depends(require_sync_enabled),
    session: AsyncSession = Depends(get_session),
) -> SyncResponse:
    user_id = cur.user_id
    conflicts: list[dict] = []
    # 本次刚写入的 rev：both 模式下别再原样回传一遍，省一半流量
    written_revs: set[int] = set()

    if req.mode in ("push", "both"):
        for ch in req.changes:
            entity = ch.entity
            if entity not in _ENTITY_MODEL:
                continue
            Model = _ENTITY_MODEL[entity]
            data = _coerce(entity, ch.record or {})
            rid = data.get("id")
            if not rid:
                continue
            incoming_updated = int(data.get("updated_at") or now_ms())
            existing = await session.get(Model, rid)

            if ch.op == "upsert":
                if existing is None:
                    data["user_id"] = user_id
                    data.setdefault("created_at", now_ms())
                    data["updated_at"] = incoming_updated
                    data.setdefault("deleted_at", None)
                    data["rev"] = await _next_rev(session)
                    session.add(Model(**data))
                    written_revs.add(data["rev"])
                else:
                    if existing.user_id != user_id:
                        continue
                    if incoming_updated >= (existing.updated_at or 0):
                        for k, v in data.items():
                            setattr(existing, k, v)
                        existing.user_id = user_id
                        existing.updated_at = incoming_updated
                        existing.deleted_at = None
                        existing.rev = await _next_rev(session)
                        written_revs.add(existing.rev)
                    else:
                        conflicts.append(
                            {"entity": entity, "id": rid, "record": _to_change(entity, existing).record}
                        )
            elif ch.op == "delete":
                if existing and existing.user_id == user_id:
                    if incoming_updated >= (existing.updated_at or 0):
                        existing.deleted_at = incoming_updated
                        existing.updated_at = incoming_updated
                        existing.rev = await _next_rev(session)
                        written_revs.add(existing.rev)
                    else:
                        conflicts.append(
                            {"entity": entity, "id": rid, "record": _to_change(entity, existing).record}
                        )
        await session.commit()

    changes_out: list[ChangeItem] = []
    cursor = int(req.cursor or 0)
    if req.mode in ("pull", "both"):
        for entity, Model in _ENTITY_MODEL.items():
            stmt = select(Model).where(Model.user_id == user_id)
            # cursor=0 表示「从零开始的全量快照」，此时连 rev=0 的存量行也要给；
            # 之后的增量一律取 rev > cursor。
            if cursor > 0:
                stmt = stmt.where(Model.rev > cursor)
            rows = (await session.execute(stmt)).scalars().all()
            for r in rows:
                if r.rev in written_revs:
                    continue
                changes_out.append(_to_change(entity, r))

    return SyncResponse(
        server_cursor=await _max_rev(session, user_id),
        changes=changes_out,
        conflicts=conflicts,
    )
