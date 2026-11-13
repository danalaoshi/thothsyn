"""pytest 公共 fixture。

核心约束：SQLAlchemy 异步 engine 必须在「被使用的那个事件循环」里创建并绑定。
pytest-asyncio 在 asyncio_mode="auto" + asyncio_default_fixture_loop_scope="function"
下，会给每个测试协程及其函数级 async fixture 同一个 function 级事件循环。

因此这里把 engine 做成 **函数级**（每个测试各自建/拆），并打补丁替换
app.db.engine / app.db.SessionLocal，使 FastAPI 端点与测试直连 DB 都在同一循环里
使用同一个 engine，避免 "Task ... attached to a different loop"。
"""
from __future__ import annotations

import uuid
import jwt
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

import app.db as dbmod
from app import models
from app.config import settings

# 固定测试用户（sub 即 auth.users.id 占位）
USER_A = str(uuid.UUID(int=0x11111111111111111111111111111111))
USER_B = str(uuid.UUID(int=0x22222222222222222222222222222222))
ADMIN = str(uuid.UUID(int=0x33333333333333333333333333333333))


def make_token(sub: str, email: str = "tester@example.com") -> str:
    return jwt.encode(
        {"sub": sub, "role": "authenticated", "email": email, "aud": "authenticated"},
        settings.supabase_jwt_secret,
        algorithm="HS256",
    )


@pytest_asyncio.fixture(autouse=True)
async def _db():
    # 函数级：在本测试的事件循环里建 engine，与测试协程同循环
    eng = create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)
    sl = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    dbmod.engine = eng
    dbmod.SessionLocal = sl
    async with eng.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
        # 同步游标用的序列由 migrations/002 创建；测试库也要有，否则 nextval 报错
        await conn.execute(
            text("CREATE SEQUENCE IF NOT EXISTS thoth_sync_rev_seq START 1")
        )
    yield sl
    # 清行不删表：drop_all 会清空「实时库」的表，冲掉正在运行的 server 数据；
    # 测试间隔离用逐行 DELETE 维持。
    async with eng.begin() as conn:
        await conn.execute(text("DELETE FROM captures"))
        await conn.execute(text("DELETE FROM folders"))
        await conn.execute(text("DELETE FROM messages"))
        await conn.execute(text("DELETE FROM feedback"))
        await conn.execute(text("DELETE FROM profiles"))
    await eng.dispose()


@pytest_asyncio.fixture
async def client(_db):
    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
def token_a():
    return make_token(USER_A)


@pytest_asyncio.fixture
def token_b():
    return make_token(USER_B)


@pytest_asyncio.fixture
def token_admin():
    return make_token(ADMIN, email="admin@example.com")


@pytest_asyncio.fixture
async def superuser_profile(_db):
    async with dbmod.SessionLocal() as s:
        s.add(
            models.Profile(
                id=ADMIN,
                level="superuser",
                is_superuser=True,
                created_at=1,
                updated_at=1,
            )
        )
        await s.commit()
    return ADMIN
