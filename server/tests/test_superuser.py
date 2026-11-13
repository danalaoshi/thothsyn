"""超管提权（0.1.14）：名单驱动自愈 + 本地引导 + prod 强制禁用。

背景：0.1.13 及以前 `SUPERUSER_EMAILS` 只有配置项、没有任何调用点，
`is_superuser` 默认 false 且生产代码没有写入路径；pytest 的 teardown 又会
`DELETE FROM profiles`，跑完测试就把超管标记清光，管理页的「消息」「用户留言」
两个 Tab 随之消失。这批用例锁死修复后的行为。
"""
from __future__ import annotations

import uuid

import jwt
import pytest
from sqlalchemy import text

import app.db
from app import models
from app.config import settings


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def token(email: str | None = "someone@example.com", sub: str | None = None) -> str:
    """用项目保留的 HS256 兜底通道签发本地测试 token（无需真实 GoTrue 密码）。"""
    payload = {
        "sub": sub or str(uuid.uuid4()),
        "role": "authenticated",
        "aud": "authenticated",
    }
    if email is not None:
        payload["email"] = email
    return jwt.encode(payload, settings.supabase_jwt_secret, algorithm="HS256")


@pytest.fixture(autouse=True)
def _clean_policy(monkeypatch):
    """每个用例都从「无名单、无引导、dev」起步，避免 .env 的真实配置串进来。"""
    monkeypatch.setattr(settings, "superuser_emails", "")
    monkeypatch.setattr(settings, "bootstrap_first_superuser", False)
    monkeypatch.setattr(settings, "env", "dev")


async def test_allowlist_promotes_and_unlocks_admin(client, monkeypatch):
    # 名单里的大小写与首尾空格都要被归一化
    monkeypatch.setattr(settings, "superuser_emails", "  Boss@Example.COM , second@example.com ")
    t = token(email="boss@example.com")

    me = await client.get("/api/me", headers=auth(t))
    assert me.status_code == 200
    assert me.json()["is_superuser"] is True
    assert me.json()["level"] == "superuser"

    admin = await client.get("/api/admin/users", headers=auth(t))
    assert admin.status_code == 200


async def test_allowlist_does_not_promote_other_emails(client, monkeypatch):
    monkeypatch.setattr(settings, "superuser_emails", "boss@example.com")
    t = token(email="stranger@example.com")

    me = await client.get("/api/me", headers=auth(t))
    assert me.json()["is_superuser"] is False
    assert (await client.get("/api/admin/users", headers=auth(t))).status_code == 403


async def test_token_without_email_is_not_promoted(client, monkeypatch):
    monkeypatch.setattr(settings, "superuser_emails", "boss@example.com")
    me = await client.get("/api/me", headers=auth(token(email=None)))
    assert me.json()["is_superuser"] is False


async def test_allowlist_self_heals_after_profile_wipe(client, monkeypatch):
    """复现真实故障：pytest teardown 清空 profiles 后，管理员下次访问自动恢复。"""
    monkeypatch.setattr(settings, "superuser_emails", "boss@example.com")
    uid = str(uuid.uuid4())
    t = token(email="boss@example.com", sub=uid)

    assert (await client.get("/api/me", headers=auth(t))).json()["is_superuser"] is True

    async with app.db.SessionLocal() as s:
        await s.execute(text("DELETE FROM profiles"))
        await s.commit()

    again = await client.get("/api/me", headers=auth(t))
    assert again.json()["is_superuser"] is True
    assert (await client.get("/api/admin/users", headers=auth(t))).status_code == 200


async def test_promoted_account_can_read_feedback(client, monkeypatch):
    """端到端目标：名单账号能直接看到用户留言管理接口。"""
    async with app.db.SessionLocal() as s:
        s.add(
            models.Feedback(
                contact_type="im",
                contact="1234533",
                content="测试留言系统",
                created_at=1,
            )
        )
        await s.commit()

    monkeypatch.setattr(settings, "superuser_emails", "boss@example.com")
    r = await client.get("/api/admin/feedback", headers=auth(token(email="boss@example.com")))
    assert r.status_code == 200
    body = r.json()
    assert body["unread"] == 1
    assert any(item["content"] == "测试留言系统" for item in body["items"])


async def test_bootstrap_promotes_only_first_account(client, monkeypatch):
    monkeypatch.setattr(settings, "bootstrap_first_superuser", True)

    first = await client.get("/api/me", headers=auth(token(email="first@example.com")))
    assert first.json()["is_superuser"] is True

    second = await client.get("/api/me", headers=auth(token(email="second@example.com")))
    assert second.json()["is_superuser"] is False


async def test_bootstrap_is_off_by_default(client):
    # 安全默认：不显式开启就不给任何人自动提权
    me = await client.get("/api/me", headers=auth(token(email="first@example.com")))
    assert me.json()["is_superuser"] is False
    assert (await client.get("/api/admin/users", headers=auth(token(email="first@example.com")))).status_code == 403


async def test_bootstrap_forced_off_in_prod(client, monkeypatch):
    monkeypatch.setattr(settings, "bootstrap_first_superuser", True)
    monkeypatch.setattr(settings, "env", "prod")
    me = await client.get("/api/me", headers=auth(token(email="first@example.com")))
    assert me.json()["is_superuser"] is False


async def test_bootstrap_skipped_when_allowlist_configured(client, monkeypatch):
    # 配了名单就以名单为准，不再走「首个账号」引导
    monkeypatch.setattr(settings, "bootstrap_first_superuser", True)
    monkeypatch.setattr(settings, "superuser_emails", "boss@example.com")
    me = await client.get("/api/me", headers=auth(token(email="first@example.com")))
    assert me.json()["is_superuser"] is False


async def test_bootstrap_skipped_when_superuser_already_exists(client, monkeypatch):
    monkeypatch.setattr(settings, "bootstrap_first_superuser", True)
    async with app.db.SessionLocal() as s:
        s.add(
            models.Profile(
                id=str(uuid.uuid4()),
                level="superuser",
                is_superuser=True,
                created_at=1,
                updated_at=1,
            )
        )
        await s.commit()

    me = await client.get("/api/me", headers=auth(token(email="first@example.com")))
    assert me.json()["is_superuser"] is False
