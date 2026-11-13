"""支付通道（0.1.11 起停用）。

产品决策：注册用户即可同步收藏，不再设付费分层，`is_paid` 仅作为历史字段
保留用于展示。原先 `/api/billing/upgrade` 是「登录即可自封付费」的联调空壳，
放开同步后它只剩越权风险、没有任何业务价值，因此显式关停。

保留路径并返回 410（Gone）而不是删掉：老客户端调到这里能拿到明确信号，
不会被当成路由写错而反复重试。
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/billing", tags=["billing"])


@router.post("/upgrade")
async def upgrade():
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="paid tier removed: sync is available to every registered user",
    )
