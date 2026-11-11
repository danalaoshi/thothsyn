"""管理页门禁：superuser 才能访问 /api/admin/*。"""
from __future__ import annotations
import pytest


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


async def test_admin_requires_superuser(client, token_a):
    # A 不是 superuser -> 403
    r = await client.get("/api/admin/users", headers=auth(token_a))
    assert r.status_code == 403


async def test_admin_lists_users(client, token_admin, superuser_profile):
    r = await client.get("/api/admin/users", headers=auth(token_admin))
    assert r.status_code == 200
    # Supabase 自带 auth.users；列表中至少能返回（可能为空数组或含用户）
    assert "items" in r.json()


async def test_admin_delete_capture(client, token_admin, superuser_profile, token_a):
    import app.db
    from app import models
    async with app.db.SessionLocal() as s:
        s.add(models.Profile(id="11111111-1111-1111-1111-111111111111", level="formal", created_at=1, updated_at=1))
        s.add(models.Capture(id="admin-c1", user_id="11111111-1111-1111-1111-111111111111",
                             title="x", url="u", created_at=1, updated_at=1))
        await s.commit()
    r = await client.delete("/api/admin/captures/admin-c1", headers=auth(token_admin))
    assert r.status_code == 200
    async with app.db.SessionLocal() as s:
        c = await s.get(models.Capture, "admin-c1")
        assert c.deleted_at is not None
