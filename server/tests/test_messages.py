"""0.1.11 消息推送通道 + 权限放开回归测试。

覆盖：注册即可同步、超管专属发送、全体/定向可见性、自增游标增量、
正文纯文本不渲染、撤回、支付空壳已关停。
"""
from __future__ import annotations

USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


async def test_non_superuser_cannot_send(client, token_a):
    r = await client.post(
        "/api/admin/messages",
        json={"title": "hi", "body": "x"},
        headers=auth(token_a),
    )
    assert r.status_code == 403


async def test_unauthenticated_cannot_read(client):
    assert (await client.get("/api/messages")).status_code == 401


async def test_broadcast_reaches_every_registered_user(
    client, token_admin, superuser_profile, token_a, token_b
):
    r = await client.post(
        "/api/admin/messages",
        json={"title": "版本更新", "body": "v0.1.11 已发布"},
        headers=auth(token_admin),
    )
    assert r.status_code == 200
    assert r.json()["item"]["recipient_id"] is None

    for tok in (token_a, token_b, token_admin):
        got = await client.get("/api/messages", headers=auth(tok))
        assert got.status_code == 200
        titles = [m["title"] for m in got.json()["items"]]
        assert "版本更新" in titles


async def test_direct_message_only_target_sees(
    client, token_admin, superuser_profile, token_a, token_b
):
    await client.post(
        "/api/admin/messages",
        json={"title": "只给 B", "body": "定向", "recipient_id": USER_B},
        headers=auth(token_admin),
    )
    a = (await client.get("/api/messages", headers=auth(token_a))).json()["items"]
    b = (await client.get("/api/messages", headers=auth(token_b))).json()["items"]
    assert [m["title"] for m in a] == []
    assert [m["title"] for m in b] == ["只给 B"]


async def test_cursor_is_strictly_incremental(client, token_admin, superuser_profile, token_a):
    await client.post(
        "/api/admin/messages", json={"title": "第一条"}, headers=auth(token_admin)
    )
    await client.post(
        "/api/admin/messages", json={"title": "第二条"}, headers=auth(token_admin)
    )
    first = (await client.get("/api/messages", headers=auth(token_a))).json()
    assert [m["title"] for m in first["items"]] == ["第一条", "第二条"]
    assert first["cursor"] == first["items"][-1]["id"]

    second = (
        await client.get(f"/api/messages?since={first['cursor']}", headers=auth(token_a))
    ).json()
    assert second["items"] == []          # 没有新消息
    assert second["cursor"] == first["cursor"]  # 水位不倒退、也不盲目前进


async def test_body_is_plain_text_and_length_limited(
    client, token_admin, superuser_profile, token_a
):
    raw = "<script>alert(1)</script> & <img src=x>"
    await client.post(
        "/api/admin/messages",
        json={"title": "纯文本", "body": raw},
        headers=auth(token_admin),
    )
    items = (await client.get("/api/messages", headers=auth(token_a))).json()["items"]
    # 服务端原样返回字符串，不解析、不转义成 HTML；渲染责任在两端用纯文本方式展示
    assert items[0]["body"] == raw

    too_long = await client.post(
        "/api/admin/messages",
        json={"title": "x", "body": "a" * 2001},
        headers=auth(token_admin),
    )
    assert too_long.status_code == 422


async def test_revoke_message(client, token_admin, superuser_profile, token_a):
    sent = (
        await client.post(
            "/api/admin/messages", json={"title": "撤回我"}, headers=auth(token_admin)
        )
    ).json()["item"]
    assert len((await client.get("/api/messages", headers=auth(token_a))).json()["items"]) == 1
    r = await client.delete(f"/api/admin/messages/{sent['id']}", headers=auth(token_admin))
    assert r.status_code == 200
    assert (await client.get("/api/messages", headers=auth(token_a))).json()["items"] == []


async def test_billing_upgrade_is_gone(client, token_a):
    """支付分层已取消：老的自封付费端点必须关停，且不改任何等级字段。"""
    r = await client.post("/api/billing/upgrade", headers=auth(token_a))
    assert r.status_code == 410
    me = (await client.get("/api/me", headers=auth(token_a))).json()
    assert me["is_paid"] is False
