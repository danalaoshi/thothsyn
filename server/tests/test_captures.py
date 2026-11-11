"""收藏/文件夹 列表、删除、标签过滤、用户隔离（管理页侧）。"""
from __future__ import annotations
import pytest


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


async def _verify(client, token, user_id):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        p = await s.get(models.Profile, user_id)
        if p is None:
            s.add(models.Profile(id=user_id, level="formal", created_at=1, updated_at=1))
        else:
            p.level = "formal"
        await s.commit()


async def test_list_and_delete(client, token_a):
    await _verify(client, token_a, "11111111-1111-1111-1111-111111111111")
    # 通过 sync push 塞入两条
    ch = [
        {"entity": "capture", "op": "upsert",
         "record": {"id": "c1", "title": "Alpha", "url": "u", "html": "", "text": "hello", "kind": "full",
                    "folder_id": None, "tags": ["work"], "created_at": 10, "updated_at": 10}},
        {"entity": "capture", "op": "upsert",
         "record": {"id": "c2", "title": "Beta", "url": "u", "html": "", "text": "world", "kind": "partial",
                    "folder_id": None, "tags": ["life"], "created_at": 20, "updated_at": 20}},
    ]
    await client.post("/api/sync", json={"mode": "push", "changes": ch}, headers=auth(token_a))

    r = await client.get("/api/captures", headers=auth(token_a))
    assert r.status_code == 200
    items = r.json()["items"]
    assert {i["id"] for i in items} == {"c1", "c2"}

    # 标签过滤
    r2 = await client.get("/api/captures?tag=work", headers=auth(token_a))
    assert {i["id"] for i in r2.json()["items"]} == {"c1"}

    # 删除
    r3 = await client.delete("/api/captures/c1", headers=auth(token_a))
    assert r3.status_code == 200
    r4 = await client.get("/api/captures", headers=auth(token_a))
    assert {i["id"] for i in r4.json()["items"]} == {"c2"}


async def test_cannot_access_others_capture(client, token_a, token_b):
    await _verify(client, token_a, "11111111-1111-1111-1111-111111111111")
    await _verify(client, token_b, "22222222-2222-2222-2222-222222222222")
    ch = [{"entity": "capture", "op": "upsert",
           "record": {"id": "own", "title": "Mine", "url": "u", "html": "", "text": "x", "kind": "full",
                      "folder_id": None, "tags": [], "created_at": 1, "updated_at": 1}}]
    await client.post("/api/sync", json={"mode": "push", "changes": ch}, headers=auth(token_a))
    # B 删除 A 的条目应 404
    r = await client.delete("/api/captures/own", headers=auth(token_b))
    assert r.status_code == 404
