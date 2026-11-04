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

def hair_back(style):
    """背面（往上走）的頭髮：整顆頭被頭髮蓋住（連眼睛都蓋掉，身體圖不用另畫背面），疊在 body 上。"""
    hh = hx("#4a3428"); hhd = hx("#7a5a44")
    cv = Canvas(16, 24)
    if style == "short":
        cv.rect(4, 2, 11, 8, hh)
        cv.rect(5, 2, 5, 2, hhd); cv.vline(8, 4, 7, shade(hh, 0.85))
    elif style == "side":      # 長髮：披到肩膀
        cv.rect(4, 2, 11, 11, hh)
        cv.rect(5, 2, 5, 2, hhd); cv.vline(8, 4, 10, shade(hh, 0.85))
    else:  # fluffy
        cv.rect(3, 2, 12, 9, hh)
        cv.rect(4, 10, 5, 10, hh); cv.rect(10, 10, 11, 10, hh)
        cv.set(4, 1, hhd); cv.set(6, 1, hhd); cv.set(9, 1, hhd)
        cv.vline(8, 4, 9, shade(hh, 0.85))
    return cv

# ---------------- 人物分層 sheet（client 由下往上疊：軀幹 → 褲子 → 衣服 → 頭髮 → 帽子）----------------
# 每一層都是同一個標準排列的水平 sheet（CHAR_FRAMES 幀、每幀 CHAR_FW×CHAR_FH），所有層幀號一致、同步切換：
#   8 個方向（CHAR_DIRS 順序）× [待機 4 幀, 走路 4 幀] ＝ 64 幀，最後 1 幀坐姿（共 65 幀）
# 之後換成正式素材只要照這個排列畫、覆蓋同名檔案；排列寫在 avatar.json 的 frames（client 依它取幀）。
# 這裡先用現有的 16×24 圖轉出 placeholder（置中放進 24×24，左右各留 4px 給寬帽子）：
#   軀幹／衣服／褲子＝把 body() 依顏色拆開（SHIRT、PANTS 的顏色歸衣服、褲子，其餘含輪廓歸軀幹）；
#   還沒有圖的方向沿用舊規則：上、斜上＝背面頭髮；其餘＝正面；左邊幾個方向＝右邊左右翻轉；待機 4 幀＝同一張；走路＝a,b,a,b
CHAR_FW, CHAR_FH = 24, 24
CHAR_DIRS = ["down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left"]
CHAR_FRAMES = len(CHAR_DIRS) * 8 + 1
CHAR_SIT = len(CHAR_DIRS) * 8

def char_states():
    st = {}
    for i, d in enumerate(CHAR_DIRS):
        st[f"{d}_idle"] = [i * 8 + k for k in range(4)]
        st[f"{d}_walk"] = [i * 8 + 4 + k for k in range(4)]
    st["sit"] = [CHAR_SIT]
    return st

def _split(cv, part):
    """把 16×24 的 body 依顏色拆層：part＝'torso'|'top'|'bottom'。"""
    out = Canvas(cv.w, cv.h)
    for y in range(cv.h):
        for x in range(cv.w):
            c = cv.get(x, y)
            if not c[3]:
                continue
            kind = "top" if c in SHIRT else "bottom" if c in PANTS else "torso"
            if kind == part:
                out.set(x, y, c)
    return out

def char_sheet(draw):
    """draw(back, walk_frame, sit) → 16×24 Canvas（或 None＝該層這幀沒東西），排成標準排列的 sheet。"""
    sheet = Canvas(CHAR_FW * CHAR_FRAMES, CHAR_FH)
    ox = (CHAR_FW - 16) // 2
    def blit(cv, fi, mirror=False):
        if cv is None:
            return
        for y in range(min(cv.h, CHAR_FH)):
            for x in range(cv.w):
                c = cv.get(x, y)
                if c[3]:
                    sheet.set(fi * CHAR_FW + ox + ((cv.w - 1 - x) if mirror else x), y + CHAR_FH - cv.h, c)
    for i, d in enumerate(CHAR_DIRS):
        back, mirror = d.startswith("up"), "left" in d
        for k in range(4):
            blit(draw(back, 0, False), i * 8 + k, mirror)              # 待機
            blit(draw(back, k % 2, False), i * 8 + 4 + k, mirror)      # 走路 a,b,a,b
    blit(draw(False, 0, True), CHAR_SIT)
    return sheet

def char_body_sheet(skin, part):
    return char_sheet(lambda back, f, sit: _split(body_sit(skin) if sit else body(skin, f), part))

def char_hair_sheet(style):
    def draw(back, f, sit):
        src = hair_back(style) if back else hair(style)
        if not sit:
            return src
        cv = Canvas(16, 24)                                            # 坐姿：頭整體下移 3 列
        for y in range(24 - 3):
            for x in range(16):
                cv.set(x, y + 3, src.get(x, y))
        return cv
    return char_sheet(draw)

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

def golden_dragon():  # 島主黃金肥龍（正面、雙翼上展、金黃配色；自製 placeholder，非 SE 素材）
    cv = Canvas(24, 20)
    y1 = hx("#e8c23a"); yl = shade(y1, 0.92); yd = shade(y1, 0.72); ys = shade(y1, 0.5); yhi = shade(y1, 1.25)
    dark = (30, 24, 22, 255)

    def poly_fill(pts, c):   # 多邊形掃描填色（畫翼膜用）
        top = min(p[1] for p in pts); bot = max(p[1] for p in pts)
        for y in range(top, bot + 1):
            xs = []
            for i in range(len(pts)):
                (xa, ya), (xb, yb) = pts[i], pts[(i + 1) % len(pts)]
                if (ya <= y < yb) or (yb <= y < ya):
                    xs.append(xa + (xb - xa) * (y - ya) / (yb - ya))
            if len(xs) >= 2:
                cv.rect(round(min(xs)), y, round(max(xs)), y, c)

    # ---- 雙翼（上展的尖三角＋扇貝形下緣），左右鏡像 ----
    wing = [(2, 1), (11, 6), (9, 13), (6, 10), (3, 13)]
    for mx in (0, 1):
        pts = [(x if mx == 0 else 23 - x, y) for x, y in wing]
        poly_fill(pts, yl)
        # 翼骨：肩→翼尖的斜線（連續短筆避免斷點）
        (x0, y0), (x1, y1p) = pts[0], pts[1]
        for i in range(10):
            xx = round(x0 + (x1 - x0) * i / 9)
            cv.rect(xx, round(y0 + (y1p - y0) * i / 9), xx + 1, round(y0 + (y1p - y0) * i / 9), ys)
        # 撐出扇貝的兩根輔骨：肩→下緣兩個凹谷（近垂直，畫短豎線）
        for j in (2, 4):
            (x0, y0), (x1, y1p) = pts[1], pts[j]
            for i in range(6):
                yv = round(y0 + (y1p - y0) * i / 5)
                cv.rect(round(x0 + (x1 - x0) * i / 5), yv, round(x0 + (x1 - x0) * i / 5), yv + 1, yd)
    # ---- 腿與爪 ----
    cv.rect(8, 13, 10, 17, y1); cv.rect(13, 13, 15, 17, y1)
    cv.rect(6, 17, 10, 18, yl); cv.rect(13, 17, 17, 18, yl)
    for cx in (6, 8, 10): cv.rect(cx, 18, cx, 19, yhi)
    for cx in (13, 15, 17): cv.rect(cx, 18, cx, 19, yhi)
    # ---- 軀幹、頸、頭（畫在最上層，覆蓋翼根）----
    cv.rect(10, 6, 13, 13, y1)
    cv.ellipse(11.5, 10.5, 2.0, 3.0, yd)          # 肚
    cv.rect(10, 4, 13, 6, y1)
    cv.ellipse(11.5, 3.4, 2.3, 2.5, y1)
    cv.rect(10, 5, 13, 5, yd)                     # 下顎
    cv.set(10, 2, dark); cv.set(13, 2, dark)      # 眼
    cv.rect(9, 0, 9, 2, yd); cv.rect(14, 0, 14, 2, yd)  # 頭冠角
    cv.rect(10, 0, 13, 0, yd)                     # 冠
    cv.outline()
    return cv

def snake_queen():  # 島主笨蛋蛇女（夜光島）：正面、蛇髮、紅冠、金甲、蛇尾，一手黑劍一手鬼火（FF14 T7 蛇女造型的致敬 placeholder，非 SE 素材）
    cv = Canvas(24, 36)
    tail = hx("#5c4a80"); tail_d = shade(tail, 0.78); belly = shade(tail, 1.42)
    skin = hx("#a88cc4"); skin_d = shade(skin, 0.82)
    hair = hx("#322c3e"); hair_l = shade(hair, 1.35)
    crest = hx("#c43a4e"); crest_hi = shade(crest, 1.3)
    gold = hx("#d8a838"); gold_d = shade(gold, 0.7); gold_hi = shade(gold, 1.32)
    face = hx("#efe0ea")
    blade = hx("#3a3444"); blade_e = hx("#8a80a4")
    fire_o = hx("#ff9a2e"); fire = hx("#ffd23a"); fire_hi = hx("#fff0a0")
    dark = (24, 20, 26, 255)

    # ---- 蛇尾（下半身）：粗尾從臀寬平滑漸細、先微右弓再向左勾，尾端鰭狀尖；左緣淺色鱗紋（照參考圖）----
    cv.rect(8, 15, 15, 18, tail)                    # 臀（接軀幹）
    cv.rect(8, 19, 16, 22, tail)                    # 粗身（最寬、微向右弓）
    cv.rect(7, 23, 15, 25, tail)                    # 開始收窄
    cv.rect(6, 26, 13, 28, tail)
    cv.rect(5, 29, 10, 31, tail)
    cv.rect(4, 32, 7, 33, tail)                     # 向左勾
    cv.set(3, 33, tail)                             # 鰭狀尾尖（上尖）
    cv.rect(3, 34, 5, 35, tail)                     # 尾尖貼地
    for y0, x0 in [(19, 9), (22, 9), (25, 8), (28, 7), (31, 6)]:
        cv.rect(x0, y0, x0 + 1, y0 + 1, belly)      # 左緣分段淺鱗
    cv.set(12, 20, tail_d); cv.set(14, 21, tail_d)  # 鱗片暗點（交錯）
    cv.set(11, 23, tail_d); cv.set(13, 24, tail_d)
    cv.set(10, 26, tail_d); cv.set(12, 27, tail_d)
    cv.set(9, 29, tail_d); cv.set(7, 30, tail_d)
    cv.rect(7, 15, 8, 16, gold)                     # 腰帶垂飾（臀側金飾，照參考圖）
    cv.rect(15, 15, 16, 16, gold)

    # ---- 軀幹：紫膚＋金色胸甲與腰帶 ----
    cv.rect(9, 8, 14, 14, skin)
    cv.rect(9, 8, 14, 10, gold)                    # 金色胸甲
    cv.rect(9, 10, 14, 10, gold_d)                 # 胸甲下緣
    cv.rect(8, 13, 15, 14, gold)                   # 腰帶
    cv.set(11, 13, gold_hi); cv.set(12, 13, gold_hi)

    # ---- 左手（畫面左）舉黑劍，右手（畫面右）托鬼火 ----
    cv.rect(7, 9, 8, 11, skin)                     # 左上臂
    cv.rect(5, 7, 6, 8, skin)                      # 左前臂（舉起）
    cv.rect(4, 1, 5, 6, blade)                     # 黑劍劍身（劍尖朝上）
    cv.rect(4, 1, 4, 6, blade_e)                   # 刃光
    cv.set(4, 0, blade_e)                          # 劍尖
    cv.rect(3, 7, 6, 7, gold_d)                    # 護手
    cv.rect(15, 9, 16, 12, skin)                   # 右臂垂下
    cv.ellipse(19.5, 10.5, 1.9, 2.8, fire_o)       # 鬼火外焰
    cv.ellipse(19.5, 11, 1.1, 1.8, fire)           # 內焰
    cv.set(19, 13, fire_hi)                        # 火心

    # ---- 頭：蒼白臉＋蛇髮＋紅冠 ----
    cv.ellipse(11.5, 2.2, 4.2, 2.2, hair)          # 髮頂（先畫，臉疊上去）
    cv.ellipse(11.5, 4.5, 3.1, 3.0, face)          # 臉
    cv.rect(7, 3, 8, 8, hair)                      # 兩側垂髮
    cv.rect(15, 3, 16, 8, hair)
    cv.set(10, 4, dark); cv.set(13, 4, dark)       # 眼
    cv.hline(11, 12, 6, skin_d)                    # 嘴
    cv.rect(6, 4, 6, 6, hair); cv.set(5, 5, hair_l)     # 左小蛇頭探出
    cv.rect(17, 4, 17, 6, hair); cv.set(18, 5, hair_l)  # 右小蛇頭探出
    cv.rect(11, 0, 12, 1, crest)                   # 紅色頭冠
    cv.set(10, 1, crest); cv.set(13, 1, crest)
    cv.set(11, 0, crest_hi)
    cv.outline()
    return cv

def tombstone():  # 死亡墓碑（被島主打倒後原地出現，30 秒後復活；自製 placeholder）
    cv = Canvas(14, 16)
    st = hx("#b9b4a8"); std = shade(st, 0.78); std2 = shade(st, 0.62)
    cv.rect(3, 3, 10, 14, st)                 # 碑身
    cv.rect(4, 1, 9, 2, st)                   # 圓弧頂
    cv.rect(2, 14, 11, 15, std2)              # 底座
    cv.rect(3, 13, 10, 13, std2)
    cv.rect(6, 4, 7, 9, std); cv.hline(5, 8, 5, std); cv.hline(5, 8, 6, std)   # 十字刻痕
    cv.set(5, 11, std2)                       # 小裂痕
    cv.outline((30, 26, 28, 255))
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

def weapon_rod():  # 釣竿（與木劍同方向：竿尖在上、握把在下；轉軸在離底 3 格處）
    cv = Canvas(6, 26)
    pole, pole_hi = hx("#8a6238"), hx("#b48a58")
    cv.vline(3, 1, 18, pole)              # 竿身（上細下粗）
    cv.vline(2, 9, 18, pole)
    cv.vline(3, 1, 8, pole_hi)            # 竿尖一段較淺
    cv.set(3, 1, hx("#e8e0d0"))           # 竿尖
    for y in (5, 11, 16):                 # 導線環
        cv.set(4, y, hx("#c9d2d9"))
    cv.rect(1, 18, 4, 20, hx("#9aa4ad"))  # 捲線器
    cv.set(4, 19, hx("#dfe6ec"))
    cv.rect(2, 21, 3, 25, hx("#3a3a44"))  # 握把
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
        dict(id="rug",   name="地毯",  w=2, h=2, solid=False, sprite="rug.png", legacy=True),   # 已改為地板（floor_rug）；保留定義讓舊存檔擺著的還看得到、拿得走，但不列在面板
        dict(id="lamp",  name="電燈",  w=1, h=1, solid=True,  sprite="lamp.png"),
        dict(id="tv",    name="電視",  w=1, h=1, solid=True,  sprite="tv.png"),
        dict(id="bed",   name="床",    w=1, h=1, solid=True,  sprite="bed.png", use="sleep", quiltRow=13),
        dict(id="shelf", name="書架",  w=1, h=1, solid=True,  sprite="shelf.png"),
        dict(id="sign",  name="看板",  w=1, h=1, solid=True,  sprite="sign.png", text=True),
    ],
)

# FF14 致敬野生動物（三種）＋各地形島主 + 各地形出現組合
ANIMAL_MANIFEST = dict(
    scale=2, respawn=30,
    animals=[
        dict(id="bird",  name="圓喙鳥", sprite="bird.png",  swim=True, speed=42, flee=95, hp=3,
             line="「圓喙鳥」用圓圓的眼神看著你。"),
        dict(id="sheep", name="波波羊", sprite="sheep.png", speed=30, flee=80, hp=4,
             line="「波波羊」慢悠悠地嚼著草。"),
        dict(id="frog",  name="大肚蛙", sprite="frog.png",  swim=True, speed=26, flee=70, hp=3,
             line="「大肚蛙」的眼神飄向遠方。"),
        # 島主：terrain.json 的 owner 指定的動物；big=N＝比普通動物大 N 倍；owner=True＝不會被嚇跑、金色名牌
        # atk＝攻擊樣式：dash＝龍衝（黃金肥龍）、gaze＝石化之瞳（笨蛋蛇女：開眼 2 秒→全地圖、面向她的人石化，背對就安全）
        # ownerLines＝被激怒的台詞：發動反擊前隨機說一句（不連續重複），泡泡 3 秒；line 則是平常點牠時的描述
        # anim＝多幀動畫（有它就用 sheet 畫，sprite 只在 sheet 載入失敗時當備用）：
        #   sheet＝相對 client/assets/ 的路徑（等寬水平排列，由左至右循環）、frames＝幀數、fps／dashFps＝平常／龍衝時每秒幾幀、
        #   scale＝畫面上 1 個 sheet 像素畫幾 px（只管外觀；判定圈、龍衝碰撞等玩法仍看 big）、keyBg＝把從圖邊連進來的背景色去掉（素材不是透明底時用）
        dict(id="gold_dragon", name="黃金肥龍", sprite="golden_dragon.png", owner=True, big=5, atk="dash",
             speed=16, flee=110, hp=200,
             anim=dict(sheet="external/img2pixel/bahamut_fly_sheet.png", frames=6, fps=8, dashFps=16, scale=4, keyBg=True),
             line="「黃金肥龍」抖了抖金色的肚皮，打了一個不容小覷的呵欠。",
             # 黃金肥龍：暫時代用（說這些台詞的本人還沒做）。使用者提供的正式翻譯，字句照原文（全形空白是刻意的停頓），不要自行潤飾；
             # 每句之後會對應一個招式，關鍵字對照見 docs/notes.md「島主與戰鬥」
             ownerLines=["我降臨於此對月長嘯！　召喚星降之夜！", "我自月而來降臨於此，　召喚星降之夜！",
                         "鋼鐵燃燒吧！　成為我降臨於此的刀劍吧！", "鋼鐵成為我降臨於此的燃燒之劍！",
                         "我自月而來降臨於此，　踏過熾熱之地！", "我自月而來攜鋼鐵降臨於此！",
                         "超新星啊，更加閃耀吧！　在星降之夜，稱讚紅月！", "超新星啊，更加閃耀吧！　照亮紅月下熾熱之地！",
                         "我降臨於此，　對月長嘯！", "我降臨於此，　征戰鐵血霸道！",
                         "熾熱燃燒！　給予我月亮的祝福！", "被熾熱灼燒過的軌跡　乃成鐵血霸道！",
                         "月光啊！　照亮鐵血霸道！", "月光啊！　用你的熾熱燒盡敵人！"]),
        dict(id="snake_queen", name="笨蛋蛇女", sprite="snake_queen.png", owner=True, big=4, atk="gaze",
             speed=16, flee=110, hp=200,
             # 外觀是使用者自製的 4 幀（88×85，透明底），external/ 不由產生器畫；重跑不會動到那張 sheet
             anim=dict(sheet="external/img2pixel/snake_queen_sheet.png", frames=4, fps=8, scale=3, keyBg=False),
             line="「笨蛋蛇女」半閉著眼，慢半拍地捲了一下蛇尾。",
             ownerLines=["石化之瞳啊，睜開吧！", "蠢貨們，在我的面前化為石像吧！", "美，就該凝固在最完美的一刻！",
                         "蛇髮的詛咒啊，貫穿眼前的一切！", "別亂動喔……一動就變石頭了。", "乖乖站好，這可是你最後一次能動了。"]),
    ],
)

# 每座地形的島主（id＝animals.json 裡的動物 id；沒列的就是還沒有島主）
OWNER_BY_TERRAIN = {
    "grass": "gold_dragon",
    "night": "snake_queen",
}

# 各地形出現的小動物（id=權重）
ANIMALS_BY_TERRAIN = {
    "grass":   [("sheep", 2), ("bird", 1), ("frog", 1)],
    "beach":   [("bird", 2), ("frog", 1)],
    "snow":    [("sheep", 2), ("bird", 1)],
    "night":   [("frog", 2), ("sheep", 1)],
    "forest":  [("sheep", 2), ("bird", 2)],
    "volcano": [("frog", 1), ("bird", 1)],
}

# ---------------- 地板（裝飾模式的地板層，16×16 無縫磚，畫在地面與家具之間）----------------
# 多格地板（manifest 標 w/h，例如地毯 2×2）是一整張圖，從錨點格（左上）畫起；鋪下去會取代範圍內的單格地板，多格地板彼此不重疊
def floor_wood():
    base, dark, hi = hx("#b98a5a"), hx("#8a6038"), hx("#cfa26e")
    cv = Canvas(16, 16)
    cv.rect(0, 0, 15, 15, base)
    for row, y0 in enumerate((0, 4, 8, 12)):          # 四排橫木板，接縫左右錯開
        cv.hline(0, 15, y0 + 3, dark)
        cv.hline(0, 15, y0, hi)
        jx = (3, 11, 7, 14)[row]
        cv.vline(jx, y0, y0 + 2, dark)
        for gx in (1 + row * 3, 9 - row):              # 一點木紋
            cv.set(gx % 16, y0 + 1, shade(base, 0.9)); cv.set((gx + 1) % 16, y0 + 2, shade(base, 0.9))
    return cv

def floor_stone():
    base, dark, hi = hx("#9a9aa2"), hx("#6a6a74"), hx("#b4b4bc")
    cv = Canvas(16, 16)
    cv.rect(0, 0, 15, 15, base)
    # 不規則石板：先畫縫（可無縫重複），再各板點亮上緣
    for y in (0, 8): cv.hline(0, 15, y, dark)
    for x, y0, y1 in ((0, 0, 7), (6, 0, 7), (12, 0, 7), (3, 8, 15), (9, 8, 15), (15, 8, 15)):
        cv.vline(x, y0, y1, dark)
    for x0, x1, y in ((1, 5, 1), (7, 11, 1), (13, 15, 1), (4, 8, 9), (10, 14, 9), (0, 2, 9)):
        cv.hline(x0, x1, y, hi)
    for pt in ((2, 4), (9, 5), (14, 3), (6, 12), (12, 13), (1, 14)):
        cv.set(pt[0], pt[1], shade(base, 0.88))
    return cv

FLOOR_MANIFEST = dict(
    tile=16,
    items=[
        dict(id="wood", name="木紋地板", sprite="floor_wood.png"),
        dict(id="stone", name="石製地板", sprite="floor_stone.png"),
        dict(id="rug", name="地毯", sprite="floor_rug.png", w=2, h=2),   # 多格地板：一次鋪 w×h 格（圖 16w×16h），彼此不重疊
    ],
)

# ---------------- 釣魚：魚類圖鑑（16×16，頭朝右；自製 placeholder）----------------
# 每座地形 10 種（常見 5／罕見 3／稀有 2），圖由下面幾個參數化的形狀畫出來。
# 清單與屬性在 FISH_TABLE；產生 client/assets/fish/<id>.png 與 fish.json
FISH_EYE = hx("#1a1418")   # 魚的眼睛（不要叫 EYE：會蓋掉人物用的同名常數）

def _in_ell(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0

def _over(cv, pts, c):   # 只畫在已經有顏色的格子上（條紋、斑點不超出身體）
    for x, y in pts:
        if 0 <= x < cv.w and 0 <= y < cv.h and cv.get(x, y)[3]:
            cv.set(x, y, c)

def fish(body, belly=None, fin=None, L=11, H=6, stripes=(), spots=(), band=None, horn=None,
         whisker=False, alpha=255, glow=None):
    cv = Canvas(16, 16)
    b = hx(body, alpha)
    f = hx(fin, alpha) if fin else shade(b, .78)
    cx, cy, rx, ry = 8.5, 8, L / 2, H / 2
    x0 = math.ceil(cx - rx)
    for i in range(3):                                   # 尾鰭（越往左越開）
        cv.vline(x0 - 1 - i, round(cy - 1 - i), round(cy + 1 + i), f)
    cv.ellipse(cx, cy, rx, ry, b)
    top = math.ceil(cy - ry)
    cv.hline(round(cx - 2), round(cx), top - 1, f)       # 背鰭
    cv.set(round(cx - 1), top - 2, f)
    if belly:
        _over(cv, [(x, y) for y in range(round(cy) + 1, 16) for x in range(16) if _in_ell(x, y, cx, cy, rx, ry)], hx(belly, alpha))
    for sx in stripes:
        _over(cv, [(sx, y) for y in range(16)], shade(b, .55))
    if band:
        _over(cv, [(x, round(cy)) for x in range(x0, 15)], hx(band, alpha))
    for p in spots:
        _over(cv, [p], hx(glow or "#ffffff", alpha) if glow else shade(b, .6))
    hx_ = round(cx + rx)
    if horn:
        cv.hline(hx_, 15, round(cy) - 1, hx(horn))
    if whisker:
        cv.set(hx_, round(cy) + 1, f); cv.set(hx_ + 1, round(cy) + 2, f)
    cv.outline((30, 24, 22, alpha))
    cv.set(hx_ - 2, round(cy) - 1, FISH_EYE)
    return cv

def eel(body, belly, alpha=255):
    cv = Canvas(16, 16)
    b, bl = hx(body, alpha), hx(belly, alpha)
    for x in range(1, 15):
        y = 8 + round(math.sin(x * .7) * 1.6)
        cv.vline(x, y - 1, y + 1, b)
        cv.set(x, y + 1, bl)
    cv.outline()
    y = 8 + round(math.sin(14 * .7) * 1.6)
    cv.set(13, y - 1, FISH_EYE)
    return cv

def shrimp(c):
    cv = Canvas(16, 16)
    b = hx(c)
    for (x, y) in ((4, 10), (6, 8.5), (8, 7.5), (10, 7.5), (12, 8)):
        cv.ellipse(x, y, 2, 2, b)
    cv.vline(2, 10, 13, shade(b, .8)); cv.vline(3, 11, 13, shade(b, .8))   # 尾扇
    for x in (6, 8, 10):                                                     # 腳
        cv.set(x, 11, shade(b, .7))
    for i in range(4):                                                       # 觸鬚
        cv.set(13 + i // 2, 6 - i, shade(b, 1.15))
    cv.outline()
    cv.set(12, 7, FISH_EYE)
    return cv

def crab(c, shell=None):
    cv = Canvas(16, 16)
    b = hx(c)
    if shell:                                                                # 寄居蟹：背著螺殼
        s = hx(shell)
        cv.ellipse(6, 8, 5, 5, s)
        for (x, y) in ((6, 8), (7, 7), (5, 7), (5, 9), (7, 10), (8, 9)):
            cv.set(x, y, shade(s, .65))
        cv.ellipse(12, 10, 2.5, 2.5, b)
        cv.ellipse(14, 7, 1.5, 1.5, b)
        for x in (10, 12): cv.vline(x, 12, 14, shade(b, .8))
        cv.outline()
        cv.set(13, 9, FISH_EYE)
        return cv
    cv.ellipse(8, 9, 5, 3, b)
    cv.ellipse(2.5, 6, 2, 2, b); cv.ellipse(13.5, 6, 2, 2, b)               # 螯
    cv.set(4, 8, b); cv.set(12, 8, b)
    for x in (4, 6, 10, 12): cv.vline(x, 12, 14, shade(b, .8))               # 腳
    cv.vline(6, 5, 6, b); cv.vline(10, 5, 6, b)                              # 眼柄
    cv.outline()
    cv.set(6, 4, FISH_EYE); cv.set(10, 4, FISH_EYE)
    return cv

def starfish(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 8.5, 2.5, 2.5, b)
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        for r in range(2, 8):
            cv.ellipse(8 + math.cos(a) * r, 8.5 + math.sin(a) * r, max(.8, 1.6 - r * .15), max(.8, 1.6 - r * .15), b)
    for (x, y) in ((8, 8), (7, 10), (9, 10), (6, 8), (10, 8)):
        cv.set(x, y, shade(b, 1.2))
    cv.outline()
    return cv

def octopus(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 6, 5, 4.5, b)
    for i, x in enumerate((3, 5, 7, 9, 11, 13)):
        for y in range(9, 15):
            cv.set(x + (1 if (y + i) % 4 < 2 else 0), y, b)
    cv.outline()
    cv.set(6, 7, FISH_EYE); cv.set(10, 7, FISH_EYE)
    return cv

def squid(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 5.5, 3, 5, b)
    cv.hline(4, 12, 2, shade(b, .85)); cv.hline(5, 11, 1, shade(b, .85))    # 鰭
    for x in (5, 7, 9, 11):
        cv.vline(x, 10, 14, b)
    cv.vline(6, 10, 15, b); cv.vline(10, 10, 15, b)
    cv.outline()
    cv.set(7, 8, FISH_EYE); cv.set(9, 8, FISH_EYE)
    return cv

def jelly(c, alpha=210):
    cv = Canvas(16, 16)
    b = hx(c, alpha)
    for y in range(2, 9):
        for x in range(16):
            if _in_ell(x, y, 8, 8, 6, 6):
                cv.set(x, y, b)
    cv.hline(2, 14, 8, shade(b, 1.2))
    for i, x in enumerate((4, 6, 8, 10, 12)):
        for y in range(9, 15):
            cv.set(x + (1 if (y + i) % 3 == 0 else 0), y, shade(b, .85))
    cv.outline((30, 24, 22, alpha))
    return cv

def turtle(shell, skin, spots=None):
    cv = Canvas(16, 16)
    s, k = hx(shell), hx(skin)
    cv.ellipse(4, 12, 2, 1.5, k); cv.ellipse(11, 12.5, 2, 1.5, k)          # 鰭肢
    cv.ellipse(4, 5, 2, 1.5, k); cv.ellipse(11, 4.5, 2, 1.5, k)
    cv.ellipse(13.5, 8.5, 2, 1.8, k)                                         # 頭
    cv.ellipse(7.5, 8.5, 5.5, 4, s)
    for (x, y) in ((6, 7), (9, 7), (7, 10), (10, 10), (5, 9)):
        cv.set(x, y, hx(spots) if spots else shade(s, .7))
    cv.outline()
    cv.set(14, 8, FISH_EYE)
    return cv

def snail(shell, body):
    cv = Canvas(16, 16)
    s, b = hx(shell), hx(body)
    cv.rect(3, 12, 14, 13, b)
    cv.vline(13, 9, 12, b); cv.set(14, 8, b); cv.set(12, 8, b)
    cv.ellipse(7, 8.5, 4.5, 4.5, s)
    for (x, y) in ((7, 8), (8, 8), (8, 9), (7, 10), (6, 10), (5, 9), (5, 8), (6, 6), (8, 6), (9, 7)):
        cv.set(x, y, shade(s, .65))
    cv.outline()
    return cv

def tadpole(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(10.5, 8, 3, 2.5, b)
    for x in range(2, 8):
        cv.set(x, 8 + round(math.sin(x * 1.1)), b)
        cv.set(x, 9 + round(math.sin(x * 1.1)), shade(b, .8))
    cv.outline()
    cv.set(12, 7, FISH_EYE)
    return cv

def ray(c, belly):
    cv = Canvas(16, 16)
    b = hx(c)
    for y in range(3, 14):
        w = 6 - abs(y - 8) * 1.1
        if w > 0:
            cv.hline(round(9 - w), round(9 + w * .6), y, b)
    cv.hline(1, 4, 8, shade(b, .8))                                          # 尾
    cv.outline()
    for (x, y) in ((8, 6), (10, 9), (7, 10), (11, 6)):
        cv.set(x, y, hx(belly))
    cv.set(11, 7, FISH_EYE); cv.set(11, 9, FISH_EYE)
    return cv

def angler(c, lure):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.vline(2, 7, 11, shade(b, .8)); cv.vline(1, 6, 12, shade(b, .8))       # 尾
    cv.ellipse(8.5, 9, 6, 4.5, b)
    cv.hline(10, 14, 11, hx("#2a1418"))                                      # 大嘴
    for x in (11, 13): cv.set(x, 10, hx("#f0f0e0"))
    cv.vline(10, 2, 4, shade(b, .8)); cv.set(11, 2, shade(b, .8))            # 燈籠觸手
    cv.outline()
    cv.ellipse(12.5, 2, 1.2, 1.2, hx(lure))
    cv.set(11, 7, FISH_EYE)
    return cv

def boot(c, sole="#3a2a22"):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 2, 8, 11, b)
    cv.rect(4, 9, 13, 12, b)
    cv.rect(12, 10, 13, 12, shade(b, 1.15))
    cv.rect(3, 13, 13, 13, hx(sole))
    cv.hline(4, 8, 3, shade(b, .75))
    for y in (5, 7): cv.set(8, y, hx("#e8dcc4"))                             # 鞋帶
    cv.set(10, 11, shade(b, .6)); cv.set(6, 6, shade(b, .6))                 # 破洞
    cv.outline()
    return cv

def can(c, band):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 4, 11, 13, b)
    cv.rect(4, 7, 11, 10, hx(band))
    cv.hline(5, 10, 3, shade(b, 1.2)); cv.hline(5, 10, 14, shade(b, .7))
    cv.vline(5, 4, 13, shade(b, 1.25))
    cv.set(10, 8, shade(hx(band), .6)); cv.set(9, 9, shade(hx(band), .6))    # 凹痕
    cv.outline()
    return cv

def bottle(c, alpha=200):
    cv = Canvas(16, 16)
    b = hx(c, alpha)
    cv.rect(5, 6, 10, 14, b)
    cv.rect(7, 2, 8, 5, b)
    cv.rect(7, 1, 8, 1, hx("#8a6238"))                                       # 軟木塞
    cv.rect(6, 8, 9, 11, hx("#f0e6c8"))                                      # 裡面的信
    cv.vline(6, 6, 13, shade(b, 1.3))
    cv.outline((30, 24, 22, alpha))
    return cv

def glove(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 7, 11, 13, b)
    for x in (4, 6, 8, 10):
        cv.vline(x, 3, 7, b)
    cv.rect(12, 8, 13, 10, b)
    cv.hline(4, 11, 12, shade(b, .75))                                       # 袖口
    cv.set(7, 9, hx("#ffffff")); cv.set(9, 10, hx("#ffffff"))                # 雪花
    cv.outline()
    return cv

def kelp(c):
    cv = Canvas(16, 16)
    b = hx(c)
    for i, x0 in enumerate((4, 8, 11)):
        for y in range(2 + i, 15):
            x = x0 + round(math.sin(y * .8 + i) * 1.2)
            cv.hline(x, x + 1, y, b if (y + i) % 3 else shade(b, 1.2))
    cv.outline()
    return cv

def stick(c, leaf):
    cv = Canvas(16, 16)
    b = hx(c)
    for i in range(12):
        cv.rect(2 + i, 12 - i, 3 + i, 13 - i, b)
    cv.rect(7, 4, 7, 7, b); cv.set(6, 3, b)                                  # 分枝
    cv.ellipse(5, 2.5, 1.5, 1, hx(leaf))
    cv.outline()
    return cv

C, U, R = "common", "uncommon", "rare"
# (地形, id, 名稱, 稀有度, 尺寸 cm 範圍, 畫圖)
FISH_TABLE = [
    # 草島：池塘與小溪
    ("grass", "crucian", "鯽魚", C, (10, 25), lambda: fish("#8a8a52", "#c8c48a", L=10, H=6)),
    ("grass", "medaka", "青鱂魚", C, (3, 6), lambda: fish("#b8d0c8", "#e8f0e8", L=7, H=3)),
    ("grass", "river_shrimp", "小河蝦", C, (3, 8), lambda: shrimp("#9ab8a8")),
    ("grass", "old_boot", "破舊靴子", C, (25, 30), lambda: boot("#6a4a32")),
    ("grass", "loach", "泥鰍", C, (8, 20), lambda: eel("#7a6a44", "#b8a878")),
    ("grass", "perch", "鱸魚", U, (30, 80), lambda: fish("#6a8a6a", "#d0d8c0", L=12, H=6, stripes=(6, 9, 12))),
    ("grass", "green_crab", "綠背蟹", U, (8, 20), lambda: crab("#4a8a4a")),
    ("grass", "catfish", "鯰魚", U, (30, 100), lambda: fish("#5a5048", "#a89c88", L=13, H=5, whisker=True)),
    ("grass", "koi", "錦鯉", R, (40, 90), lambda: fish("#f0f0e8", fin="#e86a3a", L=12, H=6, spots=((6, 7), (7, 7), (10, 8), (11, 9), (9, 6)), glow="#e8582a")),
    ("grass", "meadow_trout", "草原之王鱒", R, (60, 120), lambda: fish("#7aa86a", "#f0e0c0", L=13, H=6, band="#e88aa0", spots=((5, 6), (9, 6), (12, 7)))),
    # 沙灘：近海
    ("beach", "sardine", "沙丁魚", C, (10, 20), lambda: fish("#6a8ab8", "#e0e8f0", L=10, H=4)),
    ("beach", "horse_mackerel", "竹莢魚", C, (15, 35), lambda: fish("#8aa0a8", "#e8e0c8", L=11, H=5, band="#c8b860")),
    ("beach", "hermit_crab", "寄居蟹", C, (3, 10), lambda: crab("#d8703a", shell="#e8d0a8")),
    ("beach", "kelp", "海帶", C, (30, 150), lambda: kelp("#5a7a3a")),
    ("beach", "empty_can", "空罐頭", C, (8, 12), lambda: can("#b8bec6", "#d84a4a")),
    ("beach", "clownfish", "小丑魚", U, (6, 11), lambda: fish("#f08a2a", L=10, H=6, stripes=(6, 10), fin="#f0f0f0")),
    ("beach", "octopus", "章魚", U, (30, 90), lambda: octopus("#c8584a")),
    ("beach", "starfish", "海星", U, (10, 30), lambda: starfish("#e88a4a")),
    ("beach", "mahi", "鬼頭刀", R, (80, 180), lambda: fish("#4aa86a", "#f0d84a", L=14, H=6, fin="#3a88c8")),
    ("beach", "golden_turtle", "黃金海龜", R, (60, 120), lambda: turtle("#d8a830", "#a8c870", "#f8e8a0")),
    # 雪島：冰海
    ("snow", "cod", "鱈魚", C, (30, 90), lambda: fish("#8a8070", "#e0d8c8", L=12, H=6, spots=((6, 7), (9, 6), (11, 8)))),
    ("snow", "capelin", "柳葉魚", C, (10, 18), lambda: fish("#9aa8b0", "#f0f0e8", L=10, H=3)),
    ("snow", "ice_shrimp", "冰晶蝦", C, (3, 8), lambda: shrimp("#a8d8f0")),
    ("snow", "frozen_glove", "凍僵的手套", C, (20, 25), lambda: glove("#c84a4a")),
    ("snow", "hairy_crab", "毛蟹", C, (8, 15), lambda: crab("#8a6a4a")),
    ("snow", "salmon", "鮭魚", U, (50, 100), lambda: fish("#8a98a8", "#f0a080", L=13, H=6, band="#e88870")),
    ("snow", "icefish", "冰魚", U, (20, 40), lambda: fish("#d8f0f8", "#ffffff", L=12, H=4, alpha=170)),
    ("snow", "squid", "烏賊", U, (20, 60), lambda: squid("#e8d8e0")),
    ("snow", "narwhal_calf", "獨角鯨寶寶", R, (100, 200), lambda: fish("#a8b0c0", "#e8ecf0", L=12, H=6, horn="#f8f0d8", spots=((6, 6), (8, 7), (10, 6)))),
    ("snow", "aurora_trout", "極光鱒", R, (50, 90), lambda: fish("#4ab8a8", "#e0f0f8", L=12, H=6, band="#b88ae8", spots=((6, 6), (9, 6)), glow="#a8f0d8")),
    # 夜光島：發光的夜海
    ("night", "lanternfish", "燈籠魚", C, (5, 12), lambda: fish("#3a4a6a", "#6a7aa0", L=9, H=4, spots=((6, 9), (8, 9), (10, 9)), glow="#8af0f0")),
    ("night", "glow_jelly", "夜光水母", C, (10, 40), lambda: jelly("#8ad8f0")),
    ("night", "black_bass", "黑鱸", C, (20, 50), lambda: fish("#3a3a48", "#6a6a78", L=11, H=6)),
    ("night", "message_bottle", "漂流瓶", C, (20, 30), lambda: bottle("#4a9a6a")),
    ("night", "glow_shrimp", "螢光蝦", C, (3, 8), lambda: shrimp("#7af0b0")),
    ("night", "moon_eel", "月光鰻", U, (50, 150), lambda: eel("#5a5a8a", "#d8d8f0")),
    ("night", "star_ray", "星斑魟", U, (40, 120), lambda: ray("#3a4a7a", "#f0e88a")),
    ("night", "anglerfish", "深海鮟鱇", U, (20, 60), lambda: angler("#4a3a4a", "#f0f08a")),
    ("night", "ghost_fish", "幽靈魚", R, (30, 70), lambda: fish("#e0e8f0", "#ffffff", L=12, H=6, alpha=140)),
    ("night", "moon_arowana", "月影龍魚", R, (60, 130), lambda: fish("#b8b0d8", "#f0e8f8", L=14, H=5, whisker=True, fin="#8a6ac8", glow="#f8f0a0", spots=((6, 7), (9, 7), (12, 7)))),
    # 森林島：林間溪流
    ("forest", "minnow", "溪哥", C, (8, 15), lambda: fish("#a8b08a", "#e8e8d0", L=9, H=4, band="#d88a6a")),
    ("forest", "tadpole", "蝌蚪", C, (1, 4), lambda: tadpole("#4a4a3a")),
    ("forest", "dead_branch", "枯枝", C, (20, 60), lambda: stick("#7a5a3a", "#6a9a4a")),
    ("forest", "crayfish", "小龍蝦", C, (6, 12), lambda: crab("#c83a2a")),
    ("forest", "moss_snail", "苔蘚螺", C, (2, 6), lambda: snail("#6a8a4a", "#c8b898")),
    ("forest", "rainbow_trout", "虹鱒", U, (30, 70), lambda: fish("#8aa878", "#f0e8d8", L=12, H=5, band="#e87a9a", spots=((6, 6), (9, 6), (11, 6)))),
    ("forest", "softshell_turtle", "甲魚", U, (20, 40), lambda: turtle("#6a7a4a", "#8a9a6a")),
    ("forest", "largemouth_bass", "大口黑鱸", U, (30, 60), lambda: fish("#5a7a4a", "#d8d8b0", L=12, H=6, band="#3a4a2a")),
    ("forest", "ancient_fish", "森林古代魚", R, (80, 150), lambda: fish("#4a5a7a", "#8a9ab0", L=14, H=6, fin="#3a4a6a", spots=((5, 7), (7, 6), (9, 8), (11, 6), (12, 9)), glow="#d8e0f0")),
    ("forest", "jade_carp", "翡翠鯉", R, (40, 90), lambda: fish("#3ab88a", "#c8f0d8", L=12, H=6, whisker=True, fin="#2a8a6a", spots=((7, 6), (10, 6)), glow="#f0f8a0")),
    # 熔岩島：熱泉與熔岩海
    ("volcano", "char_fish", "焦炭魚", C, (10, 30), lambda: fish("#3a3030", "#6a5048", L=11, H=5, spots=((7, 8), (10, 7)), glow="#e8582a")),
    ("volcano", "lava_shrimp", "火山蝦", C, (4, 10), lambda: shrimp("#e86a2a")),
    ("volcano", "burnt_boot", "烤焦的靴子", C, (25, 30), lambda: boot("#2a2420", "#1a1410")),
    ("volcano", "magma_snail", "熔岩蝸牛", C, (3, 8), lambda: snail("#5a3a30", "#e8883a")),
    ("volcano", "ash_goby", "灰燼鰕虎", C, (5, 12), lambda: fish("#8a8080", "#c8c0b8", L=9, H=5, spots=((6, 7), (8, 6), (10, 8)))),
    ("volcano", "flame_ray", "火焰魟", U, (50, 120), lambda: ray("#c84a2a", "#f8c84a")),
    ("volcano", "lava_crab", "熔岩蟹", U, (10, 30), lambda: crab("#5a3a3a")),
    ("volcano", "sulfur_eel", "硫磺鰻", U, (60, 140), lambda: eel("#c8b83a", "#f0e88a")),
    ("volcano", "phoenix_fish", "鳳凰魚", R, (50, 100), lambda: fish("#e8582a", "#f8d84a", L=12, H=6, fin="#f8a83a", spots=((6, 7), (9, 6)), glow="#fff0a0")),
    ("volcano", "fire_dragon_carp", "火龍鯉", R, (70, 150), lambda: fish("#c83a3a", "#f0b84a", L=14, H=6, whisker=True, fin="#f0d84a", spots=((6, 6), (8, 6), (10, 6), (12, 7)), glow="#f8e070")),
]

def fish_manifest():
    out = dict(
        _comment="釣魚與魚類圖鑑。由 tools/gen_assets.py 的 FISH_TABLE 產生（改這裡要改產生器再重跑）。稀有度先依 weight 抽，再從該地形同稀有度的魚裡平均抽一種；尺寸在 size 範圍內、越大越難（兩份伺服器與單機模擬一致）。",
        escape=0.01,
        rarity=dict(common=dict(name="常見", weight=60, color="#c8d0bc"),
                    uncommon=dict(name="罕見", weight=35, color="#7ab8f0"),
                    rare=dict(name="稀有", weight=5, color="#f0c84a")),
        terrains={},
    )
    for t, fid, name, rar, size, _ in FISH_TABLE:
        out["terrains"].setdefault(t, []).append(dict(id=fid, name=name, rarity=rar, size=list(size), sprite=f"{fid}.png"))
    return out

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
        td = dict(id=t["id"], name=t["name"], scale=2, tile=TILE,
                  ground="ground.png", edge="edge.png", water="water.png",
                  deco=[dict(sprite=s, weight=w) for s, w in t["deco"]],
                  animals=[dict(id=i, weight=w) for i, w in ANIMALS_BY_TERRAIN.get(t["id"], [])],
                  uiColor=t["ui"])
        if t["id"] in OWNER_BY_TERRAIN:
            td["owner"] = OWNER_BY_TERRAIN[t["id"]]
        if t.get("anims"):   # 動畫：{ 檔名: anim }（地面/岸邊/水/點綴物都可以；格式見 README「內容擴充」）。寫在 TERRAINS 的該地形裡，重跑才不會被蓋掉
            td["anims"] = t["anims"]
        json.dump(td, open(os.path.join(ASSETS, sub, "terrain.json"), "w", encoding="utf-8"),
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

    print("== 地板 ==")
    save(floor_wood(), "floor_wood.png", "floors")
    save(floor_stone(), "floor_stone.png", "floors")
    save(rug(), "floor_rug.png", "floors")            # 地毯：2×2 格（32×32），沿用家具地毯的圖
    json.dump(FLOOR_MANIFEST, open(os.path.join(ASSETS, "floors", "floors.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("  floors/floors.json")

    print("== 小動物（FF14 致敬）==")
    adir = os.path.join(ASSETS, "animals")
    for fn, cv in [("bird", bird()), ("sheep", sheep()), ("frog", frog()), ("golden_dragon", golden_dragon()),
                   ("snake_queen", snake_queen())]:
        save(cv, fn + ".png", "animals")
    json.dump(ANIMAL_MANIFEST, open(os.path.join(adir, "animals.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("  animals/animals.json")

    print("== 一般素材 ==")
    save(tombstone(), "tombstone.png")
    print("== 武器 ==")
    save(weapon_sword(), "weapon_sword.png", "avatar")
    save(weapon_rod(), "weapon_rod.png", "avatar")
    print("== 釣魚：魚類圖鑑 ==")
    for t, fid, name, rar, size, draw in FISH_TABLE:
        save(draw(), f"{fid}.png", "fish")
    json.dump(fish_manifest(), open(os.path.join(ASSETS, "fish", "fish.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("  fish/fish.json")
    print("== 採集工具（tools.json 為手寫資料，這裡只畫圖）==")
    save(tool_pickaxe(), "tool_pickaxe.png", "tools")
    save(tool_axe(), "tool_axe.png", "tools")

    print("== 角色（分層 sheet）==")
    sub = "avatar"
    for key, skin in SKINS.items():
        save(char_body_sheet(skin, "torso"), f"char_body_{key}.png", sub)
    save(char_body_sheet(SKINS["light"], "top"), "char_top_basic.png", sub)        # 衣服、褲子的形狀與膚色無關，只出一張
    save(char_body_sheet(SKINS["light"], "bottom"), "char_bottom_basic.png", sub)
    for i, st in enumerate(["short", "side", "fluffy"]):
        save(char_hair_sheet(st), f"char_hair{i + 1}.png", sub)
    json.dump(dict(
        scale=2,
        # 人物分層的幀表（所有層共用）：w×h＝每幀大小；states＝狀態 → 幀號（8 方向 × idle/walk，加 sit）；fps＝待機／走路每秒幾幀；
        # anchors＝武器掛點（sheet 像素座標，腳底中心＝(w/2, h)）：back 背上、backView 背面時背上、waist 腰間、hand 手（揮擊／拋竿轉軸）；
        # frameAnchors＝{幀號: {掛點: [x, y]}} 逐幀覆寫（素材有上下晃時讓武器跟著動）。碰撞與點擊判定都看腳底，與幀大小無關
        frames=dict(w=CHAR_FW, h=CHAR_FH, count=CHAR_FRAMES, dirs=CHAR_DIRS, states=char_states(),
                    fps=dict(idle=4, walk=6),
                    anchors=dict(back=[6.5, 11], backView=[9.5, 11], waist=[8, 15], hand=[13.5, 11]),
                    frameAnchors={}),
        skins=[dict(id=k, name=n, base=SKINS[k][0], shade=SKINS[k][1], sheet=f"char_body_{k}.png")
               for k, n in [("pale", "白皙"), ("light", "自然"), ("tan", "小麥"), ("deep", "深膚")]],
        hair=[dict(id="hair1", name="短髮", sheet="char_hair1.png"),
              dict(id="hair2", name="披髮", sheet="char_hair2.png"),
              dict(id="hair3", name="蓬鬆", sheet="char_hair3.png")],
        # 衣服／褲子／帽子：每款一張 sheet；有 recolor 就能再換色（base／shade＝圖上要被換掉的顏色，shade 換成所選顏色的 78%）
        tops=[dict(id="basic", name="基本", sheet="char_top_basic.png", recolor=dict(base="#d95c68", shade="#aa474f"))],
        bottoms=[dict(id="basic", name="基本", sheet="char_bottom_basic.png", recolor=dict(base="#4a54a0", shade="#38417c"))],
        hats=[],
        hairColor="#4a3428",
        shirtColors=['#d95c68', '#4a90d9', '#4aa564', '#c9a227', '#8a5cc9', '#e0e0e0', '#4a4a52', '#d97a3a', '#f2a1b5', '#b5303f', '#f0c93a', '#8fd0e8', '#2e5fa8', '#3a3f8c', '#6fcfc0', '#2f8a78', '#8fc455', '#3e6b3a', '#b48be0', '#6a3f9a', '#8a5a3a', '#c8b08a', '#9aa0aa', '#f4ede0'],
        pantsColors=['#4a54a0', '#2f3548', '#4a4a52', '#8a8f99', '#d8d4c8', '#8a6a46', '#c8b08a', '#5a4a3a', '#3e6b3a', '#6a8a4a', '#2f8a78', '#3a78c8', '#2e5fa8', '#7aa8d8', '#6a3f9a', '#a63d4a', '#d97a3a', '#e0b840', '#e8a0b8', '#b5303f', '#1f1f26', '#f0f0f0', '#6fcfc0', '#b48be0'],
        weapons=[
            dict(id="hands", name="空手", sprite=None),
            # carry：不拿在手上時掛哪裡（back＝背上、waist＝腰間）；back: "hilt"＝背著時劍柄朝上（沒寫＝頭朝上，例如釣竿）
            dict(id="sword", name="木劍", sprite="weapon_sword.png", carry="back", back="hilt"),
            dict(id="rod", name="釣竿", sprite="weapon_rod.png", carry="back", fishing=True),   # fishing：拿著時左鍵／F 是釣魚，不能攻擊
        ],
    ), open(os.path.join(ASSETS, sub, "avatar.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("  avatar/avatar.json")

if __name__ == "__main__":
    main()
