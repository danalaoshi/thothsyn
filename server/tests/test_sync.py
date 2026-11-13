"""同步核心测试：push/pull/both、LWW 冲突、软删传播、用户隔离、注册即可同步。"""
from __future__ import annotations
import pytest


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def cap(id_: str, updated_at: int, **kw) -> dict:
    base = {
        "id": id_, "title": "t", "url": "https://x.com", "html": "", "text": "x",
        "kind": "full", "folder_id": None, "tags": [], "created_at": updated_at, "updated_at": updated_at,
    }
    base.update(kw)
    return base


async def test_registered_user_can_sync_without_email_confirmation(client, token_a):
    """0.1.11 起注册即可同步：profile 仍是 unverified 也不该被 403 挡住。"""
    r = await client.post("/api/sync", json={"mode": "both", "changes": []}, headers=auth(token_a))
    assert r.status_code == 200
    assert r.json()["server_cursor"] == 0


async def test_push_then_pull_roundtrip(client, token_a):
    # 先让 profile 变为 verified（直接写库，绕过邮件确认）
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        p = await s.get(models.Profile, "11111111-1111-1111-1111-111111111111")
        if p is None:
            p = models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1)
        else:
            p.level = "formal"
        s.add(p)
        await s.commit()

    changes = [{"entity": "capture", "op": "upsert", "record": cap("cap-1", 1000, title="A")}]
    r = await client.post("/api/sync", json={"mode": "push", "changes": changes}, headers=auth(token_a))
    assert r.status_code == 200
    # 游标是服务端自增 rev（不是客户端时间戳），只要写入就会前进
    assert r.json()["server_cursor"] >= 1

    # pull 自 cursor=0 应返回该条
    r2 = await client.post("/api/sync", json={"mode": "pull", "cursor": 0}, headers=auth(token_a))
    assert r2.status_code == 200
    ids = [c["record"]["id"] for c in r2.json()["changes"]]
    assert "cap-1" in ids


async def test_both_mode_returns_server_changes(client, token_a):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        await s.commit()
    # 云端已有一条更旧的记录（由服务端直接写，updated_at=500）
    async with app.db.SessionLocal() as s:
        c = models.Capture(id="srv-1", user_id="11111111-1111-1111-1111-111111111111",
                           title="srv", url="u", created_at=500, updated_at=500)
        s.add(c)
        await s.commit()
    r = await client.post("/api/sync", json={"mode": "both", "cursor": 0, "changes": []}, headers=auth(token_a))
    ids = [c["record"]["id"] for c in r.json()["changes"]]
    assert "srv-1" in ids


async def test_lww_client_wins(client, token_a):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        # 服务端已有 cap-2 @ updated_at=800
        s.add(models.Capture(id="cap-2", user_id="11111111-1111-1111-1111-111111111111",
                             title="old", url="u", created_at=800, updated_at=800))
        await s.commit()
    # 客户端推 cap-2 @ updated_at=900 -> 更新
    changes = [{"entity": "capture", "op": "upsert", "record": cap("cap-2", 900, title="new")}]
    r = await client.post("/api/sync", json={"mode": "push", "changes": changes}, headers=auth(token_a))
    assert r.status_code == 200
    assert r.json()["conflicts"] == []
    async with app.db.SessionLocal() as s:
        c = await s.get(models.Capture, "cap-2")
        assert c.title == "new"
        assert c.updated_at == 900


async def test_lww_server_wins_returns_conflict(client, token_a):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        s.add(models.Capture(id="cap-3", user_id="11111111-1111-1111-1111-111111111111",
                             title="server-new", url="u", created_at=2000, updated_at=2000))
        await s.commit()
    # 客户端推 cap-3 @ updated_at=1000（更旧）-> 服务端胜，返回 conflict
    changes = [{"entity": "capture", "op": "upsert", "record": cap("cap-3", 1000, title="client-old")}]
    r = await client.post("/api/sync", json={"mode": "push", "changes": changes}, headers=auth(token_a))
    assert r.status_code == 200
    assert len(r.json()["conflicts"]) == 1
    assert r.json()["conflicts"][0]["record"]["title"] == "server-new"


async def test_soft_delete_propagation(client, token_a):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        s.add(models.Capture(id="cap-4", user_id="11111111-1111-1111-1111-111111111111",
                             title="del", url="u", created_at=100, updated_at=100))
        await s.commit()
    # 推送删除
    del_changes = [{"entity": "capture", "op": "delete", "record": {"id": "cap-4", "updated_at": 500}}]
    r = await client.post("/api/sync", json={"mode": "push", "changes": del_changes}, headers=auth(token_a))
    assert r.status_code == 200
    # pull 应返回 tombstone
    r2 = await client.post("/api/sync", json={"mode": "pull", "cursor": 0}, headers=auth(token_a))
    tomb = [c for c in r2.json()["changes"] if c["record"]["id"] == "cap-4"]
    assert tomb and tomb[0]["op"] == "delete"
    async with app.db.SessionLocal() as s:
        c = await s.get(models.Capture, "cap-4")
        assert c.deleted_at is not None


async def test_user_isolation(client, token_a, token_b):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        s.add(models.Profile(id="22222222-2222-2222-2222-222222222222", level="formal", created_at=1, updated_at=1))
        s.add(models.Capture(id="cap-a", user_id="11111111-1111-1111-1111-111111111111",
                             title="A", url="u", created_at=1, updated_at=1))
        await s.commit()
    # B 拉取应看不到 A 的数据
    r = await client.post("/api/sync", json={"mode": "pull", "cursor": 0}, headers=auth(token_b))
    ids = [c["record"]["id"] for c in r.json()["changes"]]
    assert "cap-a" not in ids
    # B 推一条，A 拉取也看不到
    await client.post("/api/sync", json={"mode": "push", "changes": [{"entity": "capture", "op": "upsert", "record": cap("cap-b", 10, title="B")}]}, headers=auth(token_b))
    r2 = await client.post("/api/sync", json={"mode": "pull", "cursor": 0}, headers=auth(token_a))
    ids2 = [c["record"]["id"] for c in r2.json()["changes"]]
    assert "cap-b" not in ids2
