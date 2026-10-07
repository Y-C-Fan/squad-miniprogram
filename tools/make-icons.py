#!/usr/bin/env python3
"""
生成 PWA 图标（纯标准库，不装 Pillow）

    python tools/make-icons.py

图形：深色底 + 柠檬绿圆环（计数环）+ 环内向下箭头（下蹲）
为什么要脚本生成：图标是构建产物，手改的话下次重建就丢了。
"""

import zlib
import struct
import os

BG = (11, 12, 15)        # #0b0c0f，和页面背景一致
FG = (198, 242, 78)      # #c6f24e，主题柠檬绿


def smoothstep(a, b, x):
    t = (x - a) / (b - a)
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return t * t * (3 - 2 * t)


def arrow_sdf(x, y, disc_r=0.40):
    """向下箭头的符号距离场。x,y 以中心为原点、按 size 归一化。负数=在图形内。
    屏幕坐标 y 正方向朝下。箭头尺寸随圆盘半径等比缩放。"""
    k = disc_r / 0.40
    x, y = x / k, y / k
    # 竖条：x ∈ [-0.056, 0.056]，y ∈ [-0.19, 0.075]
    bar = max(abs(x) - 0.056, -0.19 - y, y - 0.075)
    # 三角（顶点朝下）：上底边 y=0.0625 半宽 0.21，顶点 (0, 0.2125)
    tri = max(0.0625 - y, y - 0.2125, abs(x) - 1.4 * (0.2125 - y))
    return min(bar, tri) * k


def color_at(x_px, y_px, size, disc_r=0.40):
    """按像素坐标返回 RGB。3x3 超采样抗锯齿。"""
    acc = [0.0, 0.0, 0.0]
    SS = 3
    for j in range(SS):
        for i in range(SS):
            px = (x_px + (i + 0.5) / SS) / size
            py = (y_px + (j + 0.5) / SS) / size
            x = px - 0.5
            y = py - 0.5
            r = (x * x + y * y) ** 0.5
            # 柠檬绿圆盘
            disc = smoothstep(0.0035, -0.0035, r - disc_r)
            # 盘内挖出向下箭头
            arrow = smoothstep(0.0035, -0.0035, arrow_sdf(x, y, disc_r))
            a = disc * (1.0 - arrow)
            for k in range(3):
                acc[k] += BG[k] * (1 - a) + FG[k] * a
    n = SS * SS
    return tuple(int(round(c / n)) for c in acc)


def write_png(path, size, disc_r=0.40):
    rows = []
    for y_px in range(size):
        row = bytearray()
        for x_px in range(size):
            r, g, b = color_at(x_px, y_px, size, disc_r)
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)
    print(f"OK  {path}  {size}x{size}  {len(png) / 1024:.1f} KB")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "web")
    os.makedirs(out, exist_ok=True)
    # 普通图标：圆盘占满 80%
    for size in (180, 192, 512):
        write_png(os.path.join(out, f"icon-{size}.png"), size, disc_r=0.40)
    # maskable：Android 会按厂商形状裁切，图形收到安全区（内切圆 80%）以内
    write_png(os.path.join(out, "icon-maskable-512.png"), 512, disc_r=0.30)
