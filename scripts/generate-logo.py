#!/usr/bin/env python3
"""G Code 视觉资产生成器。

用法（需要 Pillow + numpy，仓库 venv 已带）：
    python3 scripts/generate-logo.py

生成：
- packages/desktop/build/{icon.png,icon.ico,icon.icns,icon_installer.*,
  icon_windows.png,icons/<size>.png,dmg_background*.png}
- public/logo/icons/{<size>x<size>.png,icon.ico,icon.icns}

设计：深蓝渐变圆角底 + 蓝紫渐变 "G"（圆弧 + 终端光标横杠），
4x 超采样绘制后 LANCZOS 缩放抗锯齿。
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# 主色：深蓝底 → 靛蓝；标识描边：电光蓝 → 紫。
BG_TOP = (13, 21, 38)
BG_BOTTOM = (30, 48, 85)
STROKE_A = (86, 145, 255)
STROKE_B = (154, 108, 255)
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def diagonal_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    x = np.linspace(0, 1, size, dtype=np.float32)
    y = np.linspace(0, 1.35, size, dtype=np.float32)
    t = np.clip((x[None, :] + y[:, None]) / 2.35, 0, 1)
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = np.round(top[i] + (bottom[i] - top[i]) * t).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def gradient_arc(draw: ImageDraw.ImageDraw, cx: float, cy: float, radius: float,
                 width: float, start: float, end: float, color_a: tuple, color_b: tuple,
                 steps: int = 288) -> None:
    """PIL 不支持描边渐变，按角度分段插值绘制。"""
    total = end - start
    for i in range(steps):
        t0 = start + total * i / steps
        t1 = start + total * (i + 1) / steps
        color = lerp(color_a, color_b, i / (steps - 1))
        draw.arc([cx - radius, cy - radius, cx + radius, cy + radius],
                 t0, t1 + 0.4, fill=color, width=int(width))


def build_master(ss: int = 4, out: int = 1024) -> Image.Image:
    """ss=超采样倍数；返回 out×out RGBA 主图。"""
    s = out * ss
    img = diagonal_gradient(s, BG_TOP, BG_BOTTOM).convert("RGBA")

    # 圆角底 + 顶部高光描边。
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.223), fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    d.rounded_rectangle([int(s*0.008)]*2 + [s - int(s*0.008)]*2, radius=int(s * 0.218),
                        outline=(96, 130, 190, 90), width=int(s * 0.006))

    # "G"：右开口圆环（缺口 ±30°）+ 接弧线下端的终端横杠。
    cx, cy = s * 0.5, s * 0.5
    r_mid = s * 0.30
    stroke = s * 0.088
    gap = 30.0
    # 渐变从缺口下端（36° 侧，蓝）沿逆时针绕到缺口上端（紫），
    # 横杠取下端同色，保证衔接处无色阶。
    gradient_arc(d, cx, cy, r_mid, stroke, gap, 360 - gap, STROKE_A, STROKE_B)

    # 圆头端帽：两个弧线端口补圆，避免平切截断感。
    for angle, color in ((gap, STROKE_A), (360 - gap, STROKE_B)):
        tx = cx + r_mid * math.cos(math.radians(angle))
        ty = cy + r_mid * math.sin(math.radians(angle))
        d.ellipse([tx - stroke / 2, ty - stroke / 2, tx + stroke / 2, ty + stroke / 2],
                  fill=color)

    # 横杠：右端与弧线下端端帽同心，向左伸到中心。
    end_x = cx + r_mid * math.cos(math.radians(gap))
    end_y = cy + r_mid * math.sin(math.radians(gap))
    x_end = end_x + stroke * 0.30
    x_start = cx - r_mid * 0.08
    d.rounded_rectangle([x_start, end_y - stroke / 2, x_end, end_y + stroke / 2],
                        radius=stroke / 2, fill=STROKE_A)
    # 光标端头小竖块（终端 caret 语汇），略向紫色过渡。
    d.rounded_rectangle([x_end - stroke * 1.02, end_y - stroke * 0.92,
                         x_end, end_y + stroke * 0.92],
                        radius=stroke * 0.28, fill=lerp(STROKE_A, STROKE_B, 0.35))

    return img.resize((out, out), Image.LANCZOS)


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
    img = diagonal_gradient_h(w, h, (10, 16, 30), (22, 34, 60))
    d = ImageDraw.Draw(img, "RGBA")
    # 右下角低对比 "G" 弧线水印。
    cx, cy, r, stroke = w * 0.82, h * 0.5, min(w, h) * 0.28, min(w, h) * 0.075
    gradient_arc(d, cx, cy, r, stroke, 36, 324, (*STROKE_A, 60), (*STROKE_B, 60), steps=180)
    return img


def diagonal_gradient_h(w: int, h: int, top: tuple, bottom: tuple) -> Image.Image:
    x = np.linspace(0, 1, w, dtype=np.float32)
    y = np.linspace(0, 1.2, h, dtype=np.float32)
    t = np.clip((x[None, :] + y[:, None]) / 2.2, 0, 1)
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = np.round(top[i] + (bottom[i] - top[i]) * t).astype(np.uint8)
    return Image.fromarray(arr, "RGB").convert("RGBA")


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
