#!/usr/bin/env python3
"""G Code 视觉资产生成器。

用法（需要 Pillow + numpy，仓库 venv 已带）：
    python3 scripts/generate-logo.py

生成：
- packages/desktop/build/{icon.png,icon.ico,icon.icns,icon_installer.*,
  icon_windows.png,icons/<size>.png,dmg_background*.png}
- public/logo/icons/{<size>x<size>.png,icon.ico,icon.icns}

设计：以 Grok favicon（grok.com，黑底圆角方块 + 双弧线笔画）的剪影为基，
改动两点形成 G Code 自有标识：
1. 底色从纯黑 #050505 改为带极淡深蓝对角渐变的近黑；
2. 双弧线笔画从纯白改为 G Code 的电光蓝→紫对角渐变。
几何为矢量重绘（路径数据取自 favicon.svg，8x 超采样后 LANCZOS 缩放）。
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# G Code 配色：近黑底 + 淡深蓝渐变；笔画电光蓝 → 紫。
BG_A = (5, 5, 5)
BG_B = (11, 19, 34)
STROKE_A = (90, 145, 255)
STROKE_B = (154, 108, 255)
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# --- Grok favicon.svg 路径数据（viewBox 0 0 512 512） ---
TILE_PATH = (
    "M0 256C0 166.392 0 121.587 17.439 87.3615C32.7787 57.2556 57.2556 32.7787 "
    "87.3615 17.439C121.587 0 166.392 0 256 0C345.608 0 390.413 0 424.638 17.439"
    "C454.744 32.7787 479.221 57.2556 494.561 87.3615C512 121.587 512 166.392 512 256"
    "C512 345.608 512 390.413 494.561 424.638C479.221 454.744 454.744 479.221 "
    "424.638 494.561C390.413 512 345.608 512 256 512C166.392 512 121.587 512 "
    "87.3615 494.561C57.2556 479.221 32.7787 454.744 17.439 424.638C0 390.413 0 "
    "345.608 0 256Z"
)
SWOOSH_A = (
    "M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117"
    "C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 "
    "219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251"
    "C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.1C424.555 237.113 "
    "447.02 241.397 468.088 233.253C437.688 234.363 407.434 219.049 390.913 191.309"
    "L210.484 312.759Z"
)
SWOOSH_B = (
    "M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 "
    "261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 "
    "318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 "
    "100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 80.0917 384.104"
    "C100.602 397.249 128.617 399.244 152.799 386.323C163.656 380.536 174.282 371.746 "
    "183.042 337.641Z"
)


# --- 极简 SVG path 解析（仅 M/L/C/Z，绝对坐标） ---
TOKEN = re.compile(r"([MLCZ])|(-?\d*\.?\d+(?:e-?\d+)?)")


def parse_path(d: str) -> list[list[tuple[float, float]]]:
    tokens = [(m.group(1), m.group(2)) for m in TOKEN.finditer(d)]
    subpaths: list[list[tuple[float, float]]] = []
    pts: list[tuple[float, float]] = []
    nums: list[float] = []
    cmd = None
    cur = (0.0, 0.0)

    def flush_polygon() -> None:
        if len(pts) >= 3:
            subpaths.append(pts.copy())

    it = iter(tokens)
    for kind, num in it:
        if kind:  # 新命令
            cmd = kind
            nums = []
            if kind == "Z":
                flush_polygon()
                pts = []
            continue
        nums.append(float(num))
        take = {"M": 2, "L": 2, "C": 6}[cmd]
        if len(nums) == take:
            x = nums[-2]
            y = nums[-1]
            if cmd == "M":
                flush_polygon()
                pts = [(x, y)]
            elif cmd == "L":
                pts.append((x, y))
            else:  # C：三次贝塞尔拍平
                x0, y0 = cur
                x1, y1, x2, y2, x3, y3 = nums
                for i in range(1, 13):
                    t = i / 12
                    mt = 1 - t
                    bx = (mt**3) * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t**3 * x3
                    by = (mt**3) * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t**3 * y3
                    pts.append((bx, by))
                x, y = x3, y3
            cur = (x, y)
            nums = []
    flush_polygon()
    return subpaths


def scale_points(subpaths: list[list[tuple[float, float]]], s: float):
    return [[(x * s, y * s) for x, y in poly] for poly in subpaths]


def diagonal_gradient(size: int, a: tuple, b: tuple, span: float = 2.2) -> Image.Image:
    x = np.linspace(0, 1, size, dtype=np.float32)
    y = np.linspace(0, 1.2, size, dtype=np.float32)
    t = np.clip((x[None, :] + y[:, None]) / span, 0, 1)
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = np.round(a[i] + (b[i] - a[i]) * t).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def build_master(out: int = 1024, ss: int = 8) -> Image.Image:
    s = out * ss
    tile = scale_points(parse_path(TILE_PATH), s / 512)
    swooshes = scale_points(parse_path(SWOOSH_A) + parse_path(SWOOSH_B), s / 512)

    # 底：近黑 + 极淡深蓝对角渐变，裁进方块。
    bg = diagonal_gradient(s, BG_A, BG_B).convert("RGBA")
    tile_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(tile_mask).polygon(
        [p for poly in tile for p in poly], fill=255)
    bg.putalpha(tile_mask)

    # 笔画：电光蓝→紫对角渐变，按对角 t 取色，贴合笔画左上→右下走向。
    xx = np.linspace(0, 1, s, dtype=np.float32)[None, :]
    yy = np.linspace(0, 1, s, dtype=np.float32)[:, None]
    t = np.clip((xx + yy) / 2.0, 0, 1)
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = np.round(STROKE_A[i] + (STROKE_B[i] - STROKE_A[i]) * t).astype(np.uint8)
    stroke_img = Image.fromarray(arr, "RGB").convert("RGBA")

    swoosh_mask = Image.new("L", (s, s), 0)
    dm = ImageDraw.Draw(swoosh_mask)
    for poly in swooshes:
        dm.polygon(poly, fill=255)
    stroke_img.putalpha(swoosh_mask)

    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(bg)
    canvas.alpha_composite(stroke_img)
    return canvas.resize((out, out), Image.LANCZOS)


def save_pngs(master: Image.Image, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    for size in PNG_SIZES:
        master.resize((size, size), Image.LANCZOS).save(dest_dir / f"{size}x{size}.png")


def save_ico(master: Image.Image, path: Path) -> None:
    base = master.resize((256, 256), Image.LANCZOS)
    base.save(path, sizes=[(s, s) for s in ICO_SIZES])


def save_icns(master: Image.Image, path: Path) -> None:
    master.save(path)


def build_dmg_background(w: int, h: int) -> Image.Image:
    x = np.linspace(0, 1, w, dtype=np.float32)
    y = np.linspace(0, 1.2, h, dtype=np.float32)
    t = np.clip((x[None, :] + y[:, None]) / 2.2, 0, 1)
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = np.round(BG_A[i] + (BG_B[i] * 2 - BG_A[i]) * t).astype(np.uint8)
    img = Image.fromarray(arr, "RGB").convert("RGBA")

    # 右侧低透明度双弧线水印。
    ss = 4
    side = min(w, h) * ss
    swooshes = scale_points(parse_path(SWOOSH_A) + parse_path(SWOOSH_B), side / 512)
    offset_x = int(w * ss * 0.82 - side / 2)
    offset_y = int(h * ss / 2 - side / 2)
    mask = Image.new("L", (w * ss, h * ss), 0)
    dm = ImageDraw.Draw(mask)
    for poly in swooshes:
        dm.polygon([(px + offset_x, py + offset_y) for px, py in poly], fill=48)
    mask = mask.resize((w, h), Image.LANCZOS)
    watermark = Image.new("RGBA", (w, h), STROKE_A + (255,))
    watermark.putalpha(mask)
    img.alpha_composite(watermark)
    return img


def main() -> None:
    master = build_master()
    master.save(ROOT / "packages/desktop/build/icon.png")
    master.save(ROOT / "packages/desktop/build/icon_windows.png")
    master.save(ROOT / "packages/desktop/build/icon_installer.png")

    desktop_build = ROOT / "packages/desktop/build"
    save_pngs(master, desktop_build / "icons")
    save_ico(master, desktop_build / "icon.ico")
    save_icns(master, desktop_build / "icon.icns")
    save_ico(master, desktop_build / "icon_installer.ico")
    save_icns(master, desktop_build / "icon_installer.icns")

    logo = ROOT / "public/logo/icons"
    save_pngs(master, logo)
    save_ico(master, logo / "icon.ico")
    save_icns(master, logo / "icon.icns")

    build_dmg_background(540, 380).save(desktop_build / "dmg_background.png")
    build_dmg_background(1080, 760).save(desktop_build / "dmg_background@2x.png")
    print("done")


if __name__ == "__main__":
    main()
