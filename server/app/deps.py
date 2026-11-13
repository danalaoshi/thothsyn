"""当前用户依赖：校验 Supabase JWT → 取 user_id → 懒加载/创建 profiles 行。

门禁（0.1.11 起）：
- require_sync_enabled : 注册用户即可同步，不再校验邮箱确认态或付费等级
- require_superuser   : 非 superuser → 403（管理接口、发消息）

超管来源（0.1.14）：`SUPERUSER_EMAILS` 名单 + 可选的本地引导，见 apply_superuser_policy。
`level` / `is_paid` 字段保留用于展示与超管体系，但不再作为同步开关。
"""
from __future__ import annotations
from dataclasses import dataclass
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from .config import settings
from .db import get_session
from .security import decode_supabase_jwt
from . import models
from .timeutil import now_ms

bearer = HTTPBearer(auto_error=False)


def recompute_level(profile: models.Profile, email_confirmed: bool) -> None:
    """等级推导：superuser > paid > 已验证(formal) > 未验证(unverified)。"""
    if profile.is_superuser:
        profile.level = "superuser"
    elif profile.is_paid:
        profile.level = "paid"
    elif email_confirmed:
        profile.level = "formal"
    else:
        profile.level = "unverified"


@dataclass
class CurrentUser:
    user_id: str
    profile: models.Profile
    token: str
    email: str | None


# 事务级 advisory lock 的固定 key：只用于「库中尚无超管时的首个账号引导」。
# 取一个项目专属常数，避免和别的锁撞车。
_BOOTSTRAP_LOCK_KEY = 730913001


async def apply_superuser_policy(
    profile: models.Profile,
    email: str | None,
    session: AsyncSession,
) -> bool:
    """按配置确保超管身份，返回本次是否发生了提权。

    两条授权来源（**只提权、不自动降级**）：

    1. `SUPERUSER_EMAILS` 名单：JWT 里的 email claim 命中名单即确保
       `is_superuser=true`。每次鉴权都检查，因此名单改动、或 profiles 行
       被测试清掉之后，管理员下次访问就能自动恢复，不需要手工改库。
    2. 本地引导：名单为空 + `BOOTSTRAP_FIRST_SUPERUSER=true` + 非 prod，
       且库中尚无任何超管时，把第一个通过鉴权的账号提为超管。

    刻意不自动降级：配置写错一个字母就立刻把自己锁在管理台外面，代价比
    「多留一个超管」大得多；撤销权限目前需要直接改 profiles 行。

    邮箱取 JWT 的 email claim（由可信 IdP 签发），GoTrue 里改邮箱后需重新登录
    才会反映到 token；`/api/me` 回查到的真实邮箱只用于展示与等级推导。
    """
    if profile.is_superuser:
        return False

    normalized = (email or "").strip().lower()
    should_promote = bool(normalized and normalized in settings.superuser_email_set)

    if not should_promote and settings.allow_first_user_bootstrap:
        # pg_advisory_xact_lock 在当前事务内持锁，commit 后释放；两个并发首登
        # 只有一个能看到「库中无超管」，避免同时提权出两个超管。
        await session.execute(text(f"SELECT pg_advisory_xact_lock({_BOOTSTRAP_LOCK_KEY})"))
        existing = await session.scalar(
            select(models.Profile.id)
            .where(models.Profile.is_superuser.is_(True))
            .limit(1)
        )
        should_promote = existing is None

    if not should_promote:
        return False

    profile.is_superuser = True
    profile.level = "superuser"
    profile.updated_at = now_ms()
    await session.commit()
    return True


async def get_token(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> str:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return creds.credentials


async def get_current_user(
    token: str = Depends(get_token),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser:
    payload = await decode_supabase_jwt(token)
    user_id = payload["sub"]
    profile = await session.get(models.Profile, user_id)
    if profile is None:
        # 首次访问：懒创建 profile，默认 unverified（/api/me 会依据邮箱确认态修正）
        profile = models.Profile(
            id=user_id, level="unverified", created_at=now_ms(), updated_at=now_ms()
        )
        session.add(profile)
        await session.commit()
        await session.refresh(profile)
    # 名单驱动的自愈提权：放在懒建之后，新账号和 profiles 被清空后的老账号都能覆盖。
    await apply_superuser_policy(profile, payload.get("email"), session)
    return CurrentUser(user_id=user_id, profile=profile, token=token, email=payload.get("email"))


async def require_sync_enabled(
    cur: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """同步准入（0.1.11 起）：只要持有有效 GoTrue JWT 就放行。

    产品侧已取消付费分层与「必须验证邮箱」的门槛，避免收款通道缺失卡住上线；
    保留这个依赖名，是为了让 sync.py 的调用点仍表达「这里是同步入口」，
    将来要加配额/限流只改这一处，不必动同步逻辑本身。
    """
    return cur


async def require_superuser(cur: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not cur.profile.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="superuser required")
    return cur


async def get_optional_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser | None:
    """可选鉴权（0.1.12 留言通道）：带合法 JWT 就识别身份，没带或带错了当匿名。

    留言是「用户 → 后台」的反向通道，扩展定位是本地优先、不登录也能用，
    所以不能反过来逼用户先注册。已登录的留言会附带 user_id / 账号邮箱，
    便于超管回访；匿名留言靠必填的联系方式承担回访入口。

    这里刻意吞掉所有异常：无效/过期令牌只降级为匿名，绝不能把提交接口
    变成 401（否则等于变相强制登录），也不能让坏令牌打挂整个请求。
    """
    if not creds or not creds.credentials:
        return None
    try:
        return await get_current_user(creds.credentials, session)
    except Exception:
        return None
