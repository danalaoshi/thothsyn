"""时间工具：统一用 epoch 毫秒作为 updated_at / cursor / 软删时间戳。"""
from __future__ import annotations
import time


def now_ms() -> int:
    return int(time.time() * 1000)
