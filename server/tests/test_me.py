"""账户 / 等级门禁测试：JWT 校验、/me 返回等级、recompute_level 推导。"""
from __future__ import annotations

import jwt
import pytest
from app import models
from app.config import settings
from app.routers.me import recompute_level


async def test_me_requires_valid_jwt(client):
    # 无 token / 伪造 token 应被拒
    r = await client.get("/api/me")
    assert r.status_code == 401
    bad = jwt.encode({"sub": "x", "role": "authenticated"}, "wrong-secret", algorithm="HS256")
    r = await client.get("/api/me", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


async def test_me_returns_unverified_by_default(client, token_a):
    # 未验证用户：默认等级 unverified
    r = await client.get("/api/me", headers={"Authorization": f"Bearer {token_a}"})
    assert r.status_code == 200
    body = r.json()
    assert body["level"] == "unverified"
    assert body["email_confirmed"] is None  # gotrue 不可达（fake token），不重算


async def test_me_superuser_level(client, token_admin, superuser_profile):
    r = await client.get("/api/me", headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert r.json()["level"] == "superuser"
    assert r.json()["is_superuser"] is True


def test_recompute_level_priority():
    # superuser > paid > formal > unverified
    p = models.Profile(id="u", is_superuser=True, is_paid=True)
    recompute_level(p, email_confirmed=True)
    assert p.level == "superuser"

    p = models.Profile(id="u", is_superuser=False, is_paid=True)
    recompute_level(p, email_confirmed=False)
    assert p.level == "paid"

    p = models.Profile(id="u", is_superuser=False, is_paid=False)
    recompute_level(p, email_confirmed=True)
    assert p.level == "formal"

    p = models.Profile(id="u", is_superuser=False, is_paid=False)
    recompute_level(p, email_confirmed=False)
    assert p.level == "unverified"
