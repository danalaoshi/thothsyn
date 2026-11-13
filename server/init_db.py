"""建表脚本（开发用）：创建 profiles / folders / captures / messages / feedback 五表并补齐增量结构。

运行：在 server/ 目录下 `uv run python -m init_db`
幂等：可反复执行。已有库不会被删表，只补列/索引/序列。
"""
from __future__ import annotations
import asyncio
import pathlib
import re
from sqlalchemy import text
from app.db import engine
from app import models

MIGRATIONS = pathlib.Path(__file__).parent / "migrations"


def _split_statements(raw: str) -> list[str]:
    """去掉 -- 行注释后再按分号拆。

    先剥注释是必须的：001_init.sql 的注释里带分号（"-- full: 仅存链接(html 空);
    partial: 存 dom html"），直接 split(';') 会把注释劈成半句话送进数据库。
    """
    no_comments = re.sub(r"--[^\n]*", "", raw)
    return [s.strip() for s in no_comments.split(";") if s.strip()]


async def _apply_sql_files(conn) -> None:
    """按序号执行 migrations/*.sql。

    只用于「结构升级」这类幂等 DDL（CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
    EXISTS）。asyncpg 不接受一次调用里带多条语句，所以逐条执行。
    """
    for path in sorted(MIGRATIONS.glob("*.sql")):
        for stmt in _split_statements(path.read_text(encoding="utf-8")):
            await conn.execute(text(stmt))


async def init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
        await _apply_sql_files(conn)
        # 确保 profiles 行级安全关闭（我们使用应用层 user_id 隔离，连接以 postgres 角色直连）
        for tbl in ("profiles", "folders", "captures", "messages", "feedback"):
            await conn.execute(text(f"ALTER TABLE {tbl} DISABLE ROW LEVEL SECURITY"))
    await engine.dispose()
    print("tables ensured: profiles, folders, captures, messages, feedback (+ rev / tombstones)")


if __name__ == "__main__":
    asyncio.run(init())
