"""本地开发收件箱代理（仅 dev）。

`supabase start` 会起一个 Mailpit 容器，GoTrue 发出的注册确认、找回密码、
邮箱变更等邮件全部被它捕获，不会投递到真实邮箱。用户以为「没收到邮件」，
其实是邮件在 http://127.0.0.1:54324 里。

浏览器直连 Mailpit 有跨域问题，所以由 FastAPI 代理一层。这里只返回精简字段，
并且只把 GoTrue 的 verify 链接透出去 —— 邮件正文属于不可信输入，不原样渲染。

生产环境（env != dev 或 MAIL_PROXY_ENABLED=false）直接 404，避免暴露确认令牌。
"""
from __future__ import annotations

import html
import re
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException

from ..config import settings

router = APIRouter(tags=["mail"])

_HREF = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.I)
_URL = re.compile(r"https?://[^\s\"'<>]+")


def _guard() -> None:
    if settings.env != "dev" or not settings.mail_proxy_enabled:
        raise HTTPException(status_code=404, detail="not found")


def _same_gotrue_host(url: str) -> bool:
    try:
        a, b = urlparse(url), urlparse(settings.supabase_url)
        return a.netloc == b.netloc and "/auth/v1/verify" in a.path
    except ValueError:
        return False


def _confirm_links(text: str, html_body: str) -> list[str]:
    candidates = _HREF.findall(html_body) + _URL.findall(text)
    found: list[str] = []
    for raw in candidates:
        u = html.unescape(raw).strip().rstrip(".,)>")
        if _same_gotrue_host(u) and u not in found:
            found.append(u)
    return found[:4]


def _addr(value) -> str:
    if isinstance(value, list):
        return ", ".join(
            x.get("Address", "") for x in value if isinstance(x, dict) and x.get("Address")
        )
    if isinstance(value, dict):
        return value.get("Address", "") or ""
    return str(value or "")


async def _fetch(path: str, params: dict | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{settings.mail_api_url.rstrip('/')}{path}", params=params)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"本地邮箱不可达：{e}") from e
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"本地邮箱返回 {r.status_code}")
    try:
        return r.json()
    except ValueError as e:
        raise HTTPException(status_code=502, detail="本地邮箱返回内容不是 JSON") from e


@router.get("/mail/messages")
async def list_messages(limit: int = 20) -> dict:
    _guard()
    raw = await _fetch("/api/v1/messages", {"limit": max(1, min(limit, 50))})
    items = [
        {
            "id": m.get("ID") or "",
            "subject": m.get("Subject") or "(无主题)",
            "to": _addr(m.get("To")),
            "created": m.get("Created") or "",
            "read": bool(m.get("Read")),
        }
        for m in (raw.get("messages") or [])
        if m.get("ID")
    ]
    return {"items": items, "total": raw.get("total", len(items))}


@router.get("/mail/messages/{msg_id}")
async def get_message(msg_id: str) -> dict:
    _guard()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", msg_id):
        raise HTTPException(status_code=400, detail="invalid message id")
    raw = await _fetch(f"/api/v1/message/{msg_id}")
    text = str(raw.get("Text") or "")
    return {
        "id": msg_id,
        "subject": raw.get("Subject") or "(无主题)",
        "to": _addr(raw.get("To")),
        "created": raw.get("Date") or raw.get("Created") or "",
        "text": text[:1200],
        "links": _confirm_links(text, str(raw.get("HTML") or "")),
    }
