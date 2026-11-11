#!/usr/bin/env python3
"""用 docs/icons/ 下的两张原图生成 Chrome 工具栏两帧静态 PNG。

Chrome 的 action.setIcon() 只接受静态图片，扩展本身不支持动画图标；
闪烁由 background.ts 收到可见标签页的 ICON_TICK 后交替 setIcon() 两帧实现。
这里只负责把原图缩成 16/32/48/128 四个尺寸，写入 public/icon/{a,b}/。

换图时把新图放进 docs/icons/（保持 icon1.png / icon2.png 文件名），重跑：
    python3 scripts/gen-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "docs" / "icons"
OUT = ROOT / "public" / "icon"
SIZES = (16, 32, 48, 128)
FRAMES = {"a": "icon1.png", "b": "icon2.png"}
LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


def main() -> None:
    for frame, name in FRAMES.items():
        src = SRC / name
        if not src.is_file():
            raise SystemExit(f"missing source image: {src}")
        with Image.open(src) as im:
            # 原图是接近正方形的满幅插画：统一缩到正方形，轻微拉伸以保留
            # 完整画面，不做居中裁切（裁掉福袋主体在 16px 下会看不清）。
            rgba = im.convert("RGBA")
            w, h = rgba.size
            for n in SIZES:
                dest = OUT / frame / f"{n}.png"
                dest.parent.mkdir(parents=True, exist_ok=True)
                rgba.resize((n, n), LANCZOS).save(dest, "PNG", optimize=True)
                print(f"{frame}/{n}.png  {n}x{n}  <- {name} ({w}x{h})")


if __name__ == "__main__":
    main()
