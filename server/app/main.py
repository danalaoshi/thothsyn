"""FastAPI 应用入口。

- CORS 放开（使用 Bearer Token，不依赖 cookie，dev 阶段允许任意源）
- 挂载各业务路由到 API_PREFIX（默认 /api）
- 构建后的管理页（web/dist）静态托管在 /manage
"""
from __future__ import annotations
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from .config import settings
from .routers import me, captures, folders, sync, billing, admin, config, auth, mail

app = FastAPI(title="Thothsyn v2 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(me.router, prefix=settings.api_prefix)
app.include_router(captures.router, prefix=settings.api_prefix)
app.include_router(folders.router, prefix=settings.api_prefix)
app.include_router(sync.router, prefix=settings.api_prefix)
app.include_router(billing.router, prefix=settings.api_prefix)
app.include_router(admin.router, prefix=settings.api_prefix)
app.include_router(config.router, prefix=settings.api_prefix)
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(mail.router, prefix=settings.api_prefix)


@app.get("/", include_in_schema=False)
async def root():
    # GoTrue 认证邮件的 redirect_to 取自 GOTRUE_SITE_URL（http://127.0.0.1:3000），
    # 点完确认链接会落到这里；不重定向就是一个 404 空白页，链路看着像「没生效」。
    return RedirectResponse(url="/manage/", status_code=302)


# 管理页静态产物（React 构建后放到 web/dist）
WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "dist"))
if os.path.isdir(WEB_DIR):
    from fastapi.staticfiles import StaticFiles

    app.mount("/manage", StaticFiles(directory=WEB_DIR, html=True), name="manage")
