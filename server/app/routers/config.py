"""公开运行配置：供管理页（React SPA）初始化 Supabase 客户端。

仅暴露「本就公开」的信息（anon/publishable key、网关地址、本地邮箱入口），
不暴露 service_role / JWT secret。
"""
from __future__ import annotations

from fastapi import APIRouter

from ..config import settings

router = APIRouter(tags=["config"])


@router.get("/config")
async def public_config() -> dict:
    return {
        "supabase_url": settings.supabase_url,
        "supabase_anon_key": settings.supabase_anon_key,
        # 本地栈把所有认证邮件投递到 Mailpit，不发真实邮箱。
        # 前端据此显示「本地邮箱」入口与准确提示；生产环境应关掉。
        "mail_url": settings.mail_url,
        "mail_proxy_enabled": settings.env == "dev" and settings.mail_proxy_enabled,
    }
