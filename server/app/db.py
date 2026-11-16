"""SQLAlchemy 异步引擎与会话（连接 Supabase Postgres）。"""
from __future__ import annotations
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from .config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=True,
    # Supabase Supavisor 事务池（6543）不支持命名 prepared statement，
    # asyncpg 默认会缓存语句导致 "already exists" 报错，必须关闭。
    # 会话池（5432）虽支持，但关掉缓存对两种模式都安全。
    connect_args={"statement_cache_size": 0},
)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
