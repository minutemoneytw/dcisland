#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 素材產生器 v0.2（程序化繪圖版，全自製 placeholder，零授權風險）
# 用法: python tools/gen_assets.py
import struct, zlib, os, random, json, math

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "client", "assets")
TILE = 16

# ---------------- PNG ----------------
def write_png(path, w, h, get_px):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    raw = b"".join(b"\x00" + b"".join(bytes(get_px(x, y)) for x in range(w)) for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  {os.path.relpath(path, HERE)}  ({w}x{h})")

def hx(s, a=255):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)

def shade(c, f=0.78):
    return (min(255, int(c[0] * f)), min(255, int(c[1] * f)), min(255, int(c[2] * f)), c[3])

T8 = (0, 0, 0, 0)

# ---------------- 畫布 ----------------
class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.buf = [[T8] * w for _ in range(h)]
    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h and len(c) == 4:
            self.buf[y][x] = c
    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)
    def hline(self, x0, x1, y, c): self.rect(x0, y, x1, y, c)
    def vline(self, x, y0, y1, c): self.rect(x, y0, x, y1, c)
    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(math.ceil(cy - ry), math.floor(cy + ry) + 1):
            for x in range(math.ceil(cx - rx), math.floor(cx + rx) + 1):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    self.set(x, y, c)
    def outline(self, oc=(40, 32, 30, 255)):
        marks = []
        for y in range(self.h):
            for x in range(self.w):
                if self.buf[y][x][3] == 0:
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < self.w and 0 <= yy < self.h and self.buf[yy][xx][3] != 0:
                            marks.append((x, y)); break
        for x, y in marks:
            self.buf[y][x] = oc
    def get(self, x, y):
        return self.buf[y][x]

def save(cv, name, sub=""):
    path = os.path.join(ASSETS, sub, name) if sub else os.path.join(ASSETS, name)
    write_png(path, cv.w, cv.h, lambda x, y: cv.get(x, y))

# ---------------- 地形 tile ----------------
def dither_tile(base, dot, seed, n=None):
    rng = random.Random(seed)
    cv = Canvas(TILE, TILE)
    cv.rect(0, 0, TILE - 1, TILE - 1, base)
    for _ in range(n or (TILE * TILE // 9)):
        cv.set(rng.randrange(TILE), rng.randrange(TILE), dot)
    return cv

# ---------------- 小物 ----------------
def tree(leaf, leaf_d, trunk):
    cv = Canvas(16, 24)
    cv.ellipse(8, 9, 6.4, 5.8, leaf)
    cv.ellipse(8, 12, 5.0, 4.2, leaf)          # 下層葉
    cv.rect(6, 14, 7, 15, leaf_d)              # 內側陰影
    cv.ellipse(6, 8, 2.2, 1.6, shade(leaf, 1.15))
    cv.rect(7, 17, 8, 22, trunk)
    cv.rect(6, 19, 6, 22, shade(trunk, 0.9))
    cv.outline()
    return cv

def pine(leaf, trunk):
    cv = Canvas(16, 24)
    tiers = [(8, 3, 2.0), (7, 7, 3.4), (6, 11, 4.8), (5, 15, 6.4)]
    for cy, y0, rx in tiers:
        for y in range(y0, y0 + 5):
            t = (y - y0) / 5.0
            w = rx * (0.55 + 0.75 * t)
            x0 = 8 - w
            cv.hline(int(x0), int(8 + w), y, leaf if (y - y0) < 3 else shade(leaf, 0.85))
    cv.rect(7, 19, 8, 22, trunk)
    cv.outline()
    return cv

def palm(leaf, leaf_d, trunk):
    cv = Canvas(16, 24)
    for y in range(11, 24):
        x = 7 + (1 if y >= 16 else 0)
        cv.set(x, y, trunk); cv.set(x + 1, y, trunk)
        if (y - 11) % 3 == 2: cv.set(x, y, shade(trunk, 0.85))
    for cx, cy in [(8, 6), (5, 8), (11, 8)]:
        cv.ellipse(cx, cy, 3.2, 2.2, leaf)
    cv.ellipse(8, 5, 2.4, 1.6, leaf_d)
    for dx, i in [(1, 0), (-1, 1)]:
        for k in range(3):
            cv.set(14 + dx, 10 + k, leaf)
            cv.set(1 - dx + 0, 9 + k, leaf)
    cv.outline()
    return cv

def rock():
    cv = Canvas(16, 10)
    s = hx("#9a948c")
    cv.ellipse(8, 7, 5.5, 2.8, s)
    cv.ellipse(7, 6, 3.0, 1.8, shade(s, 1.18))
    cv.ellipse(10, 8, 2.0, 1.2, shade(s, 0.8))
    cv.outline()
    return cv

def stump():
    cv = Canvas(16, 12)
    w = hx("#a57c4e")
    cv.rect(5, 5, 10, 10, w)
    cv.rect(5, 5, 10, 6, shade(w, 1.2))
    cv.ellipse(7.5, 5.5, 2.8, 1.2, shade(w, 1.35))
    cv.ellipse(7.5, 7.5, 1.0, 0.5, shade(w, 0.7))
    cv.outline()
    return cv

def flower(petal="#e26a8a"):
    cv = Canvas(8, 8)
    cv.vline(3, 5, 7, hx("#4d8a3a"))
    cv.ellipse(3, 2, 2.4, 2.0, hx(petal))
    cv.set(3, 2, hx("#f2d24e"))
    return cv

def shell():
    cv = Canvas(12, 10)
    p = hx("#f2b8c6")
    cv.ellipse(6, 8, 4.5, 3.0, p)
    cv.vline(6, 5, 10, shade(p, 0.75))
    cv.outline()
    return cv

def mushroom():
    cv = Canvas(12, 14)
    cap = hx("#c9503c")
    cv.rect(4, 6, 7, 11, hx("#e8dcc4"))
    cv.ellipse(5.5, 4.5, 5.0, 3.6, cap)
    cv.set(4, 3, hx("#f2e4d0")); cv.set(7, 4, hx("#f2e4d0"))
    cv.outline()
    return cv

def glowshroom():
    cv = Canvas(16, 18)
    m = hx("#4fd8b8")
    cv.rect(6, 8, 9, 13, hx("#2a3a58"))
    cv.ellipse(7.5, 6, 5.2, 3.4, m)
    cv.ellipse(7, 5, 2.0, 1.2, shade(m, 1.3))
    for dx, dy in [(0, 2), (3, 1), (-2, 3), (1, -1), (-1, 4)]:
        cv.set(6 + dx, 5 + dy, shade(m, 1.45))
    cv.outline()
    return cv

def lantern():
    cv = Canvas(12, 20)
    f = hx("#8a7a4a"); g = hx("#ffe27a")
    cv.rect(5, 12, 6, 18, f)
    cv.rect(4, 5, 7, 11, g)
    cv.rect(3, 4, 8, 5, f)
    cv.rect(3, 5, 3, 11, f); cv.rect(8, 5, 8, 11, f)
    cv.rect(3, 11, 8, 12, f)
    cv.outline()
    return cv

def volcanic():
    cv = Canvas(16, 14)
    lv = hx("#ff8a3a")
    cv.rect(2, 3, 13, 10, hx("#4a3a38"))
    cv.rect(6, 4, 9, 9, lv)
    cv.ellipse(7.5, 4, 3.0, 1.2, shade(lv, 1.35))
    for i, dx in enumerate([1, 2, 0]):
        cv.set(5 + dx, 9 + i, shade(lv, 0.9))
    cv.outline((28, 22, 20, 255))
    return cv

# ---------------- 角色 (16x24) ----------------
SKINS = {
    "pale":  ("#f7ddbf", "#dcb992"),
    "light": ("#f0c8a0", "#d4a37c"),
    "tan":   ("#d9a06a", "#b27e4f"),
    "deep":  ("#9c6238", "#7a4a2a"),
}
SHIRT = (hx("#d95c68"), hx("#aa474f"))   # runtime 換色的比對基準
EYE = (48, 36, 40, 255)
PANTS = (hx("#4a54a0"), hx("#38417c"))
SHOE = hx("#3c3038")

def body(skin, frame):
    f, sf = hx(skin[0]), hx(skin[1])
    sh, shd = SHIRT
    cv = Canvas(16, 24)
    cv.rect(5, 3, 10, 8, f)                    # 頭
    cv.hline(6, 7, 5, f); cv.hline(8, 9, 5, f)
    cv.set(7, 6, EYE); cv.set(9, 6, EYE)       # 眼睛
    cv.rect(4, 9, 11, 14, sh)                  # 身體
    cv.rect(4, 12, 11, 14, shd)                # 下擺陰影
    cv.rect(3, 10, 3, 13, sh); cv.rect(12, 10, 12, 13, sh)   # 手臂
    cv.rect(3, 13, 3, 13, sf); cv.rect(12, 13, 12, 13, sf)   # 手
    cv.rect(5, 15, 10, 18, PANTS[0])
    cv.rect(5, 18, 10, 18, PANTS[1])
    cv.rect(5, 19, 7, 21, PANTS[0]); cv.rect(8, 19, 10, 21, PANTS[0])  # 雙腿
    if frame == 0:
        cv.rect(4, 20, 7, 21, PANTS[1]); cv.rect(8, 20, 11, 21, PANTS[1])
        cv.rect(4, 22, 7, 22, SHOE); cv.rect(8, 22, 11, 22, SHOE)
    else:  # 走路幀
        cv.rect(4, 19, 7, 20, PANTS[1]); cv.rect(4, 21, 7, 22, SHOE)
        cv.rect(9, 19, 10, 19, PANTS[1]); cv.rect(9, 20, 11, 21, SHOE)
    cv.outline()
    return cv

def body_sit(skin):
    """坐姿（正面）：頭與上身整體下移 3 列（head/hair 疊圖時 client 也要往下 3 列），大腿縮短、小腿朝前，手放在腿上。
    上衣顏色與 body() 相同，client 的換色邏輯可直接套用。"""
    f, sf = hx(skin[0]), hx(skin[1])
    sh, shd = SHIRT
    d = 3
    cv = Canvas(16, 24)
    cv.rect(5, 3 + d, 10, 8 + d, f)                    # 頭
    cv.hline(6, 7, 5 + d, f); cv.hline(8, 9, 5 + d, f)
    cv.set(7, 6 + d, EYE); cv.set(9, 6 + d, EYE)       # 眼睛
    cv.rect(4, 9 + d, 11, 14 + d, sh)                  # 身體
    cv.rect(4, 12 + d, 11, 14 + d, shd)                # 下擺陰影
    cv.rect(3, 10 + d, 3, 12 + d, sh); cv.rect(12, 10 + d, 12, 12 + d, sh)   # 手臂（較短）
    cv.rect(3, 13 + d, 3, 13 + d, sf); cv.rect(12, 13 + d, 12, 13 + d, sf)   # 手放在腿上
    cv.rect(4, 18, 11, 19, PANTS[0])                   # 大腿（正面看很短）
    cv.rect(4, 19, 11, 19, PANTS[1])
    cv.rect(4, 20, 7, 21, PANTS[0]); cv.rect(8, 20, 11, 21, PANTS[0])        # 小腿
    cv.rect(4, 22, 7, 22, SHOE); cv.rect(8, 22, 11, 22, SHOE)
    cv.outline()
    return cv

def hair(style):
    hh = hx("#4a3428"); hhd = hx("#7a5a44")
    cv = Canvas(16, 24)
    if style == "short":
        cv.rect(4, 2, 11, 3, hh)
        cv.rect(4, 4, 4, 7, hh); cv.rect(11, 4, 11, 7, hh)
        cv.rect(5, 2, 5, 2, hhd)
    elif style == "side":
        cv.rect(4, 2, 11, 3, hh)
        cv.rect(4, 4, 4, 11, hh); cv.rect(11, 4, 11, 11, hh)
        cv.hline(5, 10, 8, hh)
    else:  # fluffy
        cv.rect(3, 2, 12, 3, hh)
        cv.rect(3, 4, 3, 8, hh); cv.rect(12, 4, 12, 8, hh)
        cv.rect(4, 8, 5, 9, hh); cv.rect(10, 8, 11, 9, hh)
        cv.set(4, 1, hhd); cv.set(6, 1, hhd); cv.set(9, 1, hhd)
    return cv

# ---------------- 家具 ----------------
def sofa():
    r = hx("#c9544f"); rd = shade(r, 0.72)
    cv = Canvas(16, 15)
    cv.rect(2, 4, 13, 10, r)      # 座面+背
    cv.rect(2, 4, 13, 5, shade(r, 1.12))
    cv.rect(2, 7, 13, 7, shade(r, 0.9))
    cv.rect(2, 4, 3, 11, rd); cv.rect(12, 4, 13, 11, rd)  # 手臂
    cv.rect(2, 11, 13, 12, rd)
    cv.rect(4, 13, 5, 13, hx("#4a3630")); cv.rect(10, 13, 11, 13, hx("#4a3630"))
    cv.outline()
    return cv

def table():
    w = hx("#a57c4e")
    cv = Canvas(16, 14)
    cv.rect(2, 6, 13, 8, w)
    cv.rect(2, 6, 13, 6, shade(w, 1.15))
    cv.rect(2, 8, 13, 8, shade(w))
    cv.rect(4, 9, 5, 12, shade(w, 0.85)); cv.rect(10, 9, 11, 12, shade(w, 0.85))
    cv.outline()
    return cv

def chair():
    w = hx("#b8865a")
    cv = Canvas(16, 14)
    # 比角色（含手臂 10 格寬）更寬一點，坐上去時椅背/椅面才會從兩側露出來
    cv.rect(2, 3, 13, 5, w)      # 背
    cv.rect(2, 6, 13, 8, shade(w, 1.1))   # 座
    cv.rect(2, 6, 2, 8, shade(w, 0.8)); cv.rect(13, 6, 13, 8, shade(w, 0.8))
    cv.rect(3, 9, 3, 12, shade(w, 0.85)); cv.rect(12, 9, 12, 12, shade(w, 0.85))
    cv.outline()
    return cv

def plant():
    cv = Canvas(16, 24)
    leaf = hx("#4d9e46")
    for cx, cy, rx, ry, c in [(8, 8, 4.5, 3.5, leaf), (5, 11, 3.2, 2.6, leaf),
                              (11, 11, 3.2, 2.6, leaf), (8, 12, 2.4, 2.0, shade(leaf, 0.85))]:
        cv.ellipse(cx, cy, rx, ry, c)
    cv.ellipse(6, 7, 1.8, 1.2, shade(leaf, 1.18))
    pot = hx("#b0703f")
    cv.rect(4, 16, 11, 18, pot)
    for x in range(5, 11):
        grad = (min(15, 4 + (x - 4) // 2), 16 + (2 if x == 4 or x == 11 else 0), 21)
    cv.rect(5, 18, 10, 21, shade(pot, 0.85))
    cv.rect(4, 16, 11, 17, pot)
    cv.outline()
    return cv

def rug():
    P = hx("#b3544e"); W = hx("#e8dcc4"); E = hx("#c9807a")
    cv = Canvas(32, 32)
    cv.rect(0, 0, 31, 31, P)
    cv.rect(2, 2, 29, 29, W)
    cv.rect(4, 4, 27, 27, E)
    for y in range(6, 27, 4):
        for x in range(6, 27, 4):
            cv.set(x, y, W)
            if (x + y) % 8 == 0:
                cv.set(x + 2, y + 2, W)
    cv.rect(0, 0, 31, 0, shade(P, 0.8)); cv.rect(0, 31, 31, 31, shade(P, 0.8))
    cv.rect(0, 0, 0, 31, shade(P, 0.8)); cv.rect(31, 0, 31, 31, shade(P, 0.8))
    return cv

def lamp():
    cv = Canvas(16, 24)
    cv.rect(5, 2, 10, 7, hx("#f2e2b0"))
    cv.rect(5, 7, 10, 8, shade(hx("#f2e2b0"), 0.8))
    cv.rect(7, 8, 8, 19, hx("#5a4632"))
    cv.rect(6, 20, 9, 21, shade(hx("#5a4632"), 0.8))
    cv.outline()
    return cv

def tv():
    cv = Canvas(16, 16)
    cv.rect(3, 4, 12, 12, hx("#3c3a44"))
    cv.rect(4, 5, 11, 10, hx("#7ec8e8"))
    cv.rect(10, 5, 10, 10, shade(hx("#7ec8e8"), 0.85))
    cv.rect(5, 13, 6, 14, hx("#2a2830")); cv.rect(9, 13, 10, 14, hx("#2a2830"))
    cv.outline()
    return cv

def cat():
    cv = Canvas(16, 12)
    f = hx("#8a8a94"); fd = shade(f, 0.8)
    cv.ellipse(7, 8, 4.5, 3.0, f)
    cv.ellipse(7, 4.5, 3.0, 2.6, f)
    cv.set(5, 1, f); cv.set(4, 0, f); cv.set(8, 1, f); cv.set(9, 0, f)  # 耳
    cv.set(5, 2, f); cv.set(8, 2, f)
    cv.set(6, 4, (48, 42, 52, 255)); cv.set(8, 4, (48, 42, 52, 255))
    for k, y in enumerate([8, 9, 10]):
        cv.set(12 + k - 1, y - 1, f)
    cv.set(14, 7, f); cv.set(13, 6, f); cv.set(12, 5, f)
    cv.rect(5, 10, 6, 10, fd); cv.rect(9, 10, 10, 10, fd)
    cv.outline()
    return cv

def sign():
    cv = Canvas(16, 24)
    w = hx("#c49a62")
    cv.rect(2, 4, 13, 11, w)
    cv.rect(3, 5, 12, 10, shade(w, 1.18))
    cv.rect(3, 10, 12, 10, shade(w, 0.85))
    cv.hline(4, 11, 7, shade(w, 0.6)); cv.hline(4, 9, 9, shade(w, 0.6))
    cv.rect(7, 12, 8, 21, shade(w, 0.8))
    cv.outline()
    return cv

# ---- 小動物（FF14 野生動物致敬：自製點陣，非 SE 素材）----
def bird():  # 圓喙鳥（大朵金色巨嘴，為黃色大鳥風致敬）
    cv = Canvas(16, 16)
    y1 = hx("#e8b23a"); yd = shade(y1, 0.82)
    bk = hx("#f08828")
    cv.ellipse(8, 10, 4.6, 3.6, y1)          # 身體
    cv.ellipse(7, 9, 2.6, 2.2, shade(y1, 1.15))
    cv.ellipse(7, 4.6, 2.8, 2.4, y1)         # 頭
    cv.rect(9, 4, 12, 5, bk); cv.rect(10, 6, 11, 6, bk)  # 巨嘴
    cv.set(6, 4, (40, 32, 30, 255)); cv.set(5, 3, y1)    # 眼+冠羽
    cv.rect(5, 14, 5, 15, bk); cv.rect(10, 14, 10, 15, bk)  # 腳
    cv.rect(3, 10, 4, 13, yd)                # 尾羽
    cv.outline()
    return cv

def sheep():  # 波波羊（雪球肚+黑臉）
    cv = Canvas(16, 14)
    w1 = hx("#f4f0e6"); wd = shade(w1, 0.85); bl = hx("#3a3632")
    cv.ellipse(8, 8, 5.4, 4.0, w1)
    cv.ellipse(4, 6, 2.0, 1.6, w1); cv.ellipse(12, 6, 2.0, 1.6, w1)   # 蓬肚
    cv.ellipse(8, 9, 3.0, 2.2, wd)
    cv.rect(6, 3, 9, 7, bl)                  # 臉
    cv.set(6, 2, bl); cv.set(9, 2, bl)       # 耳
    cv.set(7, 5, hx("#fdfdfd")); cv.set(9, 5, hx("#fdfdfd"))  # 眼
    cv.rect(5, 11, 5, 13, bl); cv.rect(10, 11, 10, 13, bl)    # 腿
    cv.outline()
    return cv

def frog():  # 大肚蛙（眼神無辜）
    cv = Canvas(16, 12)
    g1 = hx("#5aa838"); gd = shade(g1, 0.8); bl2 = hx("#e8f2d8")
    cv.ellipse(8, 8, 6.0, 3.8, g1)
    cv.ellipse(8, 9, 4.0, 2.2, bl2)          # 肚
    cv.ellipse(5.5, 3.5, 2.0, 2.0, g1); cv.ellipse(10.5, 3.5, 2.0, 2.0, g1)  # 眼球
    cv.set(5, 3, (30, 26, 24, 255)); cv.set(10, 3, (30, 26, 24, 255))
    cv.hline(6, 9, 9, shade(g1, 0.65))       # 嘴
    cv.rect(4, 10, 4, 11, gd); cv.rect(11, 10, 11, 11, gd)   # 後腳
    cv.outline()
    return cv

def weapon_sword():  # 木劍（M0 武器 1 號）
    cv = Canvas(6, 18)
    sv = hx("#c9b98a"); hi = hx("#e8d8a8")
    cv.rect(2, 2, 3, 11, sv)          # 劍刃（第 0 列留給輪廓，第 1 列是劍尖）
    cv.rect(2, 2, 2, 11, hi)          # 刃光
    cv.set(2, 1, hi)                  # 劍尖：單點收尖，不是平頭
    cv.rect(0, 12, 5, 12, hx("#8a6238"))   # 護手
    cv.rect(2, 13, 3, 17, hx("#5a4028"))   # 握柄
    cv.outline((30, 24, 22, 255))
    return cv

# 採集工具（與 weapon_sword 同方向：工具頭在上、握柄在下；握把在左右正中，轉軸在離底 3 格處）
def tool_pickaxe():  # 鎬子
    cv = Canvas(12, 18)
    wood = hx("#8a6238"); wood_d = hx("#5a4028")
    st = hx("#9aa4ad"); st_hi = hx("#c9d2d9")
    cv.rect(5, 3, 6, 17, wood)            # 握柄
    cv.rect(5, 15, 6, 17, wood_d)         # 握柄尾端
    cv.rect(4, 1, 7, 1, st_hi)            # 鎬頭（兩端下垂的弧形）
    cv.rect(2, 2, 9, 2, st)
    cv.rect(1, 3, 3, 3, st); cv.rect(8, 3, 10, 3, st)
    cv.rect(5, 3, 6, 3, st)               # 與握柄相接處
    cv.set(1, 3, st_hi); cv.set(10, 3, st_hi)   # 兩端尖角反光
    cv.outline((30, 24, 22, 255))
    return cv

def tool_axe():  # 斧頭（斧刃在右側＝揮向前方時朝外）
    cv = Canvas(12, 18)
    wood = hx("#8a6238"); wood_d = hx("#5a4028")
    st = hx("#9aa4ad"); st_hi = hx("#dfe6ec"); st_d = hx("#6c7680")
    cv.rect(5, 1, 6, 17, wood)            # 握柄
    cv.rect(5, 15, 6, 17, wood_d)
    cv.rect(5, 1, 8, 1, st)               # 斧頭
    cv.rect(4, 2, 9, 2, st)
    cv.rect(4, 3, 10, 5, st)
    cv.rect(4, 6, 9, 6, st)
    cv.rect(5, 7, 7, 7, st)
    cv.rect(4, 2, 4, 6, st_d)             # 背面（斧背）較暗
    cv.rect(10, 3, 10, 5, st_hi)          # 刃口反光
    cv.outline((30, 24, 22, 255))
    return cv

def bed():   # 單人床（一格寬）：一個枕頭，睡覺時頭靠在枕頭上；quiltRow=13（被子從第 13 列開始）
    cv = Canvas(16, 24)
    cf = hx("#4a6ab0"); cfd = shade(cf, 0.8)
    cv.rect(1, 8, 14, 20, hx("#a57c4e"))       # 床架
    cv.rect(2, 9, 13, 12, hx("#f2ede0"))       # 枕頭帶
    cv.ellipse(8, 10, 4.5, 2.0, hx("#ffffff"))  # 枕頭
    cv.rect(2, 13, 13, 19, cf)                 # 棉被
    cv.rect(2, 13, 13, 13, shade(cf, 1.15))
    cv.rect(1, 20, 14, 21, cfd)
    cv.rect(2, 22, 3, 23, hx("#4a3630")); cv.rect(12, 22, 13, 23, hx("#4a3630"))
    cv.outline()
    return cv

def shelf():
    cv = Canvas(16, 24)
    w = hx("#8a6238")
    cv.rect(2, 3, 13, 21, w)
    cv.rect(3, 4, 12, 20, shade(w, 1.1))
    for y in (7, 12, 17):
        cv.rect(3, y, 12, y, shade(w, 0.7))
        for i, x in enumerate((4, 7, 10)):
            cv.rect(x, y - 2, x + 1, y - 1, [hx("#c9544f"), hx("#4078b0"), hx("#4a9e5a")][i])
    cv.outline()
    return cv

# ---------------- 地形定義 ----------------
TERRAINS = [
    dict(id="grass",   name="草島",
         ground=("#6aaa5a", "#5b9a4e"), edge=("#e0c184", "#cfae72"),
         water=("#3f7ec4", "#336aae"), leaf=("#3f8f4f", "#2f7a3f"), trunk="#6b4a32",
         deco=[("tree.png", 3), ("flower.png", 2), ("rock.png", 1)], ui="#6aaa5a"),
    dict(id="beach",   name="沙灘島",
         ground=("#e6cf96", "#d8bd82"), edge=("#cbb27a", "#b89e68"),
         water=("#47a6d9", "#3a8ec2"), leaf=("#4fa06a", "#3f8455"), trunk="#7a5e42",
         deco=[("palm.png", 3), ("shell.png", 2), ("rock.png", 1)], ui="#e6cf96"),
    dict(id="snow",    name="雪島",
         ground=("#ecf2f8", "#d6e2ee"), edge=("#b9d4e6", "#a2c2d8"),
         water=("#3873b8", "#2d5fa0"), leaf=("#2f7a52", "#256040"), trunk="#5a4632",
         deco=[("pine.png", 3), ("rock.png", 2), ("stump.png", 1)], ui="#ecf2f8"),
    dict(id="night",   name="夜光島",
         ground=("#37406e", "#2d3560"), edge=("#57496e", "#4a3d5e"),
         water=("#20264a", "#181d3c"), leaf=("#3aa88c", "#2d8670"), trunk="#4a3a2a",
         deco=[("glowshroom.png", 3), ("lantern.png", 2), ("rock.png", 1)], ui="#6b74b8"),
    dict(id="forest",  name="森林島",
         ground=("#5b8f46", "#4d7c3a"), edge=("#8a6b46", "#75583a"),
         water=("#35658f", "#2c5578"), leaf=("#2f6b35", "#24552a"), trunk="#54402c",
         deco=[("tree.png", 4), ("mushroom.png", 2), ("stump.png", 1)], ui="#5b8f46"),
    dict(id="volcano", name="熔岩島",
         ground=("#5a4a48", "#4c3e3c"), edge=("#8a5040", "#744234"),
         water=("#c23a1e", "#a83018"), leaf=("#6a6a46", "#54543a"), trunk="#3c2a22",
         deco=[("rock.png", 3), ("volcanic.png", 3), ("stump.png", 1)], ui="#6c5a58"),
]

FURN_MANIFEST = dict(
    scale=2, tile=TILE,
    items=[
        dict(id="sofa",  name="沙發",  w=1, h=1, solid=True,  sprite="sofa.png", use="sit"),
        dict(id="table", name="桌子",  w=1, h=1, solid=True,  sprite="table.png"),
        dict(id="chair", name="椅子",  w=1, h=1, solid=True,  sprite="chair.png", use="sit"),
        dict(id="plant", name="植栽",  w=1, h=1, solid=True,  sprite="plant.png"),
        dict(id="rug",   name="地毯",  w=2, h=2, solid=False, sprite="rug.png"),
        dict(id="lamp",  name="電燈",  w=1, h=1, solid=True,  sprite="lamp.png"),
        dict(id="tv",    name="電視",  w=1, h=1, solid=True,  sprite="tv.png"),
        dict(id="cat",   name="貓",    w=1, h=1, solid=False, sprite="cat.png"),
        dict(id="bed",   name="床",    w=1, h=1, solid=True,  sprite="bed.png", use="sleep", quiltRow=13),
        dict(id="shelf", name="書架",  w=1, h=1, solid=True,  sprite="shelf.png"),
        dict(id="sign",  name="看板",  w=1, h=1, solid=True,  sprite="sign.png"),
    ],
)

# FF14 致敬野生動物（三種）+ 各地形出現組合
ANIMAL_MANIFEST = dict(
    scale=2, respawn=30,
    animals=[
        dict(id="bird",  name="圓喙鳥", sprite="bird.png",  swim=True, speed=42, flee=95, hp=3,
             line="「圓喙鳥」用圓圓的眼神看著你。"),
        dict(id="sheep", name="波波羊", sprite="sheep.png", speed=30, flee=80, hp=4,
             line="「波波羊」慢悠悠地嚼著草。"),
        dict(id="frog",  name="大肚蛙", sprite="frog.png",  swim=True, speed=26, flee=70, hp=3,
             line="「大肚蛙」的眼神飄向遠方。"),
    ],
)

# 各地形出現的小動物（id=權重）
ANIMALS_BY_TERRAIN = {
    "grass":   [("sheep", 2), ("bird", 1), ("frog", 1)],
    "beach":   [("bird", 2), ("frog", 1)],
    "snow":    [("sheep", 2), ("bird", 1)],
    "night":   [("frog", 2), ("sheep", 1)],
    "forest":  [("sheep", 2), ("bird", 2)],
    "volcano": [("frog", 1), ("bird", 1)],
}

def main():
    print("== 地形 ==")
    for t in TERRAINS:
        sub = os.path.join("terrain", t["id"])
        la, ld = hx(t["leaf"][0]), hx(t["leaf"][1]); trunk = hx(t["trunk"])
        save(dither_tile(hx(t["ground"][0]), hx(t["ground"][1]), t["id"] + "g"), "ground.png", sub)
        save(dither_tile(hx(t["edge"][0]), hx(t["edge"][1]), t["id"] + "e"), "edge.png", sub)
        save(dither_tile(hx(t["water"][0]), hx(t["water"][1]), t["id"] + "w", n=TILE * TILE // 14), "water.png", sub)
        save(tro := tree(la, ld, trunk), "tree.png", sub)
        save(rock(), "rock.png", sub)
        save(stump(), "stump.png", sub)
        save(flower(), "flower.png", sub)
        pine_rows = pine(la, trunk)
        palm_rows = palm(la, ld, trunk)
        if t["id"] in ("snow",):
            save(pine_rows, "pine.png", sub)
        if t["id"] == "beach":
            save(palm_rows, "palm.png", sub)
            save(shell(), "shell.png", sub)
        if t["id"] == "night":
            save(glowshroom(), "glowshroom.png", sub)
            save(lantern(), "lantern.png", sub)
        if t["id"] == "forest":
            save(mushroom(), "mushroom.png", sub)
        if t["id"] == "volcano":
            save(volcanic(), "volcanic.png", sub)
        json.dump(dict(id=t["id"], name=t["name"], scale=2, tile=TILE,
                       ground="ground.png", edge="edge.png", water="water.png",
                       deco=[dict(sprite=s, weight=w) for s, w in t["deco"]],
                       animals=[dict(id=i, weight=w) for i, w in ANIMALS_BY_TERRAIN.get(t["id"], [])],
                       uiColor=t["ui"]),
                  open(os.path.join(ASSETS, sub, "terrain.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"  terrain/{t['id']}/terrain.json")

    print("== 家具 ==")
    for fn, cv in [("sofa", sofa()), ("table", table()), ("chair", chair()),
                   ("plant", plant()), ("rug", rug()), ("lamp", lamp()),
                   ("tv", tv()), ("cat", cat()), ("bed", bed()),
                   ("shelf", shelf()), ("sign", sign())]:
        save(cv, fn + ".png", "furniture")
    json.dump(FURN_MANIFEST, open(os.path.join(ASSETS, "furniture", "furniture.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("  furniture/furniture.json")

    print("== 小動物（FF14 致敬）==")
    adir = os.path.join(ASSETS, "animals")
    for fn, cv in [("bird", bird()), ("sheep", sheep()), ("frog", frog())]:
        save(cv, fn + ".png", "animals")
    json.dump(ANIMAL_MANIFEST, open(os.path.join(adir, "animals.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("  animals/animals.json")

    print("== 武器 ==")
    save(weapon_sword(), "weapon_sword.png", "avatar")
    print("== 採集工具（tools.json 為手寫資料，這裡只畫圖）==")
    save(tool_pickaxe(), "tool_pickaxe.png", "tools")
    save(tool_axe(), "tool_axe.png", "tools")

    print("== 角色 ==")
    sub = "avatar"
    for key, skin in SKINS.items():
        save(body(skin, 0), f"body_{key}_a.png", sub)
        save(body(skin, 1), f"body_{key}_b.png", sub)
        save(body_sit(skin), f"body_{key}_sit.png", sub)
    for i, st in enumerate(["short", "side", "fluffy"]):
        save(hair(st), f"hair{i + 1}.png", sub)
    json.dump(dict(
        scale=2, px=16, py=24,
        skins=[dict(id=k, name=n, base=SKINS[k][0], shade=SKINS[k][1])
               for k, n in [("pale", "白皙"), ("light", "自然"), ("tan", "小麥"), ("deep", "深膚")]],
        hair=[dict(id="hair1", name="短髮", sprite="hair1.png"),
              dict(id="hair2", name="披髮", sprite="hair2.png"),
              dict(id="hair3", name="蓬鬆", sprite="hair3.png")],
        hairColor="#4a3428",
        shirtColors=["#d95c68", "#4a90d9", "#4aa564", "#c9a227", "#8a5cc9", "#e0e0e0", "#4a4a52", "#d97a3a"],
        recolor=dict(shirtBase="#d95c68", shirtShadeBase="#aa474f"),
        weapons=[
            dict(id="hands", name="空手", sprite=None),
            dict(id="sword", name="木劍", sprite="weapon_sword.png"),
        ],
    ), open(os.path.join(ASSETS, sub, "avatar.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("  avatar/avatar.json")

if __name__ == "__main__":
    main()
