"""0.1.12 用户留言通道回归测试。

覆盖：匿名/登录提交、500 字上限、联系方式必填与类型校验、60 秒轻量防刷、
正文纯文本、读写权限分离（只有超管能看/标记/删）、未读筛选与删除。
"""
from __future__ import annotations

USER_A = "11111111-1111-1111-1111-111111111111"


def auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def fb(content: str = "建议加一个深色主题", contact: str = "wechat:demo", **kw):
    return {"content": content, "contact_type": "im", "contact": contact, **kw}


async def test_anonymous_can_leave_feedback(client, token_admin, superuser_profile):
    """不登录也能留言：这是设置页留言窗口的立身之本。"""
    r = await client.post("/api/feedback", json=fb())
    assert r.status_code == 200
    assert r.json()["ok"] is True

    got = await client.get("/api/admin/feedback", headers=auth(token_admin))
    assert got.status_code == 200
    item = got.json()["items"][0]
    assert item["content"] == "建议加一个深色主题"
    assert item["contact_type"] == "im"
    assert item["contact"] == "wechat:demo"
    assert item["user_id"] is None
    assert item["account_email"] is None
    assert item["is_read"] is False
    assert got.json()["unread"] == 1


async def test_logged_in_feedback_carries_account(client, token_a, token_admin, superuser_profile):
    r = await client.post(
        "/api/feedback",
        json=fb(contact="reader@example.com", contact_type="email", client_version="0.1.12"),
        headers=auth(token_a),
    )
    assert r.status_code == 200
    item = (
        await client.get("/api/admin/feedback", headers=auth(token_admin))
    ).json()["items"][0]
    assert item["user_id"] == USER_A
    assert item["account_email"] == "tester@example.com"
    assert item["client_version"] == "0.1.12"


async def test_bad_token_degrades_to_anonymous(client, token_admin, superuser_profile):
    """坏令牌只降级为匿名，不能把公开提交接口变成 401。"""
    r = await client.post(
        "/api/feedback",
        json=fb(contact="im:badtoken"),
        headers={"Authorization": "Bearer definitely-not-a-jwt"},
    )
    assert r.status_code == 200
    item = (
        await client.get("/api/admin/feedback", headers=auth(token_admin))
    ).json()["items"][0]
    assert item["user_id"] is None


async def test_500_character_limit_and_blank_checks(client):
    ok = await client.post("/api/feedback", json=fb(content="字" * 500, contact="im:a"))
    assert ok.status_code == 200
    too_long = await client.post(
        "/api/feedback", json=fb(content="字" * 501, contact="im:b")
    )
    assert too_long.status_code == 422
    for bad in (
        fb(content="   \n  ", contact="im:blank"),
        fb(contact="   ", content="内容"),
        fb(contact="not-an-email", contact_type="email"),
        fb(contact="im:badtype", contact_type="phone"),
    ):
        assert (await client.post("/api/feedback", json=bad)).status_code == 422


async def test_contact_cooldown(client):
    first = await client.post("/api/feedback", json=fb(contact="im:spam"))
    assert first.status_code == 200
    second = await client.post(
        "/api/feedback", json=fb(content="再来一条", contact="im:spam")
    )
    assert second.status_code == 429
    assert "频繁" in second.json()["detail"]
    # 换联系方式不受影响
    assert (await client.post("/api/feedback", json=fb(contact="im:other"))).status_code == 200


async def test_content_is_stored_as_plain_text(client, token_admin, superuser_profile):
    raw = "<script>alert(1)</script> & <img src=x>"
    await client.post("/api/feedback", json=fb(content=raw, contact="im:html"))
    item = (
        await client.get("/api/admin/feedback", headers=auth(token_admin))
    ).json()["items"][0]
    assert item["content"] == raw  # 服务端原样返回，渲染责任在两端用纯文本方式展示


async def test_only_superuser_can_read_mark_or_delete(client, token_a):
    assert (await client.get("/api/admin/feedback")).status_code == 401
    assert (await client.get("/api/admin/feedback", headers=auth(token_a))).status_code == 403
    assert (
        await client.post("/api/admin/feedback/1/read", headers=auth(token_a))
    ).status_code == 403
    assert (
        await client.delete("/api/admin/feedback/1", headers=auth(token_a))
    ).status_code == 403


async def test_mark_read_unread_filter_and_delete(client, token_admin, superuser_profile):
    await client.post("/api/feedback", json=fb(contact="im:one"))
    await client.post("/api/feedback", json=fb(contact="im:two"))
    h = auth(token_admin)

    before = (await client.get("/api/admin/feedback", headers=h)).json()
    assert before["unread"] == 2

    one_id = next(i["id"] for i in before["items"] if i["contact"] == "im:one")
    marked = await client.post(f"/api/admin/feedback/{one_id}/read", headers=h)
    assert marked.status_code == 200
    assert marked.json()["item"]["is_read"] is True
    assert marked.json()["item"]["read_at"] > 0

    after = (await client.get("/api/admin/feedback", headers=h)).json()
    assert after["unread"] == 1
    only_unread = (
        await client.get("/api/admin/feedback?only_unread=true", headers=h)
    ).json()
    assert [i["contact"] for i in only_unread["items"]] == ["im:two"]

    assert (await client.delete(f"/api/admin/feedback/{one_id}", headers=h)).status_code == 200
    assert (
        await client.get("/api/admin/feedback", headers=h)
    ).json()["total_shown"] == 1
    assert (
        await client.delete("/api/admin/feedback/999999", headers=h)
    ).status_code == 404
