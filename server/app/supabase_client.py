"""GoTrue（Supabase Auth）辅助：用当前用户 JWT 拉取邮箱确认状态。

仅用于 /api/me 同步等级（邮箱是否已确认）。GoTrue 不可达时返回 None，
由调用方按既有 profile 降级处理（不阻断主流程）。
"""
from __future__ import annotations
import httpx
from .config import settings


async def gotrue_get_user(token: str) -> dict | None:
    if not settings.supabase_url or not settings.supabase_anon_key:
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{settings.supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": settings.supabase_anon_key,
                },
            )
            if r.status_code == 200:
                return r.json()
    except Exception:
        return None
    return None
