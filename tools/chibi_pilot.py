#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新風格人物試作（2026-11-21，使用者提供一張 Q 版像素角色設定圖，要求先做小範圍試作）。

只有試作：產生 4 方向（下／右／上／左）× 3 格（待機、走路兩步）的人物 sheet 與放大預覽圖，**還沒接進遊戲**
（遊戲目前的人物仍是 LPC；要接進去得先決定分層與動畫格式，見 docs/notes.md「美術：多幀動畫與人物分層」）。
只用 Python 標準庫（自己寫 PNG）。用法：python tools/chibi_pilot.py [輸出資料夾]
產出：chibi_sheet.png（每格 W×H、3 欄 × 4 列）、chibi_preview.png（放大 8 倍、米色底，跟設定圖同樣的排法）。
"""
import math
import os
import struct
import sys
import zlib

W, H = 44, 52          # 一格的大小；腳底中心在 (22, 47)
CX = 22

# ---- 配色（取自設定圖的「配色參考」）----
P = {
    'hair': (176, 138, 106), 'hair_d': (146, 108, 82), 'hair_dd': (118, 84, 64), 'hair_l': (206, 168, 138),
    'skin': (253, 240, 230), 'skin_d': (244, 214, 202), 'blush': (241, 166, 166), 'mouth': (190, 100, 108),
    'eye': (78, 120, 190), 'eye_d': (40, 56, 110), 'eye_l': (150, 190, 235), 'white': (255, 255, 255), 'eye_w': (222, 230, 246),
    'blouse': (246, 240, 228), 'blouse_d': (216, 202, 192),
    'dress': (122, 54, 76), 'dress_d': (90, 38, 58), 'dress_l': (160, 84, 102),
    'gold': (216, 176, 88), 'gold_d': (176, 136, 60),
    'bow': (126, 50, 74), 'bow_d': (92, 34, 56),
    'petal': (248, 238, 216), 'petal_d': (222, 204, 176), 'flower_c': (178, 128, 74),
    'sock': (255, 250, 242), 'sock_d': (226, 214, 204),
    'shoe': (84, 60, 56), 'shoe_l': (118, 88, 82),
}
SHADOW = (120, 100, 104, 90)


class Img:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h and c is not None:
            self.px[y][x] = c if isinstance(c, tuple) else P[c]

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def hline(self, x0, x1, y, c):
        self.rect(x0, y, x1, y, c)

    def ellipse(self, cx, cy, rx, ry, c, clip=None):
        for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
            for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
                if ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1 and (clip is None or clip(x, y)):
                    self.set(x, y, c)

    def outline(self):
        """選擇性描邊：貼著透明的像素外圍，用「鄰近那個顏色變暗」當描邊色（設定圖的描邊不是純黑）。"""
        out = []
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is not None:
                    continue
                best = None
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    n = self.get(x + dx, y + dy)
                    if n is not None and len(n) == 3:
                        best = n
                        break
                if best:
                    out.append((x, y, tuple(max(0, int(v * .52)) for v in best)))
        for x, y, c in out:
            self.px[y][x] = c


def blit(dst, src, ox, oy):
    for y in range(src.h):
        for x in range(src.w):
            c = src.px[y][x]
            if c is not None and 0 <= x + ox < dst.w and 0 <= y + oy < dst.h:
                dst.px[y + oy][x + ox] = c


def mirror(src):
    m = Img(src.w, src.h)
    for y in range(src.h):
        for x in range(src.w):
            m.px[y][x] = src.px[y][src.w - 1 - x]
    return m


def strand(x, y):
    """頭髮的暗色髮絲：短短的直條，不是規則的點點。"""
    return ((x * 5) % 7 < 2) and ((y + x * 3) % 7 < 3)


def wave(y, k=1.0, ph=0.0):
    return int(round(k * math.sin(y * .9 + ph)))


# ================= 前面 =================
def eye(im, ex, ey):
    """正面的眼睛（2026-11-21 使用者要求照設定圖）：4 格寬、2 格高——左右各 1 格眼白、中間 2 格眼瞳（上深下淺藍）；上面隔一排畫 3 格的眉毛。"""
    im.hline(ex, ex + 2, ey - 2, 'hair_dd')                                    # 眉毛
    im.set(ex, ey, 'eye_w'); im.set(ex + 3, ey, 'eye_w'); im.set(ex, ey + 1, 'eye_w'); im.set(ex + 3, ey + 1, 'eye_w')
    im.set(ex + 1, ey, 'eye_d'); im.set(ex + 2, ey, 'eye_d')
    im.set(ex + 1, ey + 1, 'eye'); im.set(ex + 2, ey + 1, 'eye_l')


def eye_side(im, ex, ey):
    """側面（臉朝左）的眼睛：前面（左）2 格眼瞳、後面 1 格眼白，一樣上面一排眉毛。"""
    im.hline(ex, ex + 2, ey - 2, 'hair_dd')
    im.set(ex, ey, 'eye_d'); im.set(ex + 1, ey, 'eye_d'); im.set(ex + 2, ey, 'eye_w')
    im.set(ex, ey + 1, 'eye'); im.set(ex + 1, ey + 1, 'eye_l'); im.set(ex + 2, ey + 1, 'eye_w')


def flower(im, fx, fy):
    im.rect(fx - 1, fy, fx + 1, fy, 'petal'); im.rect(fx, fy - 1, fx, fy + 1, 'petal')
    im.set(fx - 1, fy - 1, 'petal'); im.set(fx + 1, fy - 1, 'petal'); im.set(fx - 1, fy + 1, 'petal'); im.set(fx + 1, fy + 1, 'petal_d')
    im.set(fx, fy, 'flower_c')


def draw_front(step):
    im = Img(W, H)
    dy = -1 if step else 0                       # 走路時上半身往上彈 1 格
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    # 後面的頭髮：頭頂圓弧＋兩側往下長的波浪（身體畫在它前面，所以袖子會蓋住髮束）
    im.ellipse(CX, 13 + dy, 13.5, 11, 'hair')
    for y in range(18 + dy, 37 + dy):
        xl, xr = 6 + wave(y, 1.3), 37 - wave(y, 1.3, 1.3)
        im.hline(xl, 15, y, 'hair'); im.hline(29, xr, y, 'hair')
    for x0 in (7, 31):                                                                                     # 髮尾捲起來
        im.hline(x0, x0 + 4, 37 + dy, 'hair')
    # 腿、襪子、鞋
    for x0, lift in ((16, lift_l), (25, lift_r)):
        im.rect(x0, 41 - lift, x0 + 2, 42 - lift, 'dress_d')
        im.rect(x0, 43 - lift, x0 + 2, 45 - lift, 'sock'); im.set(x0 + 2, 44 - lift, 'sock_d'); im.set(x0 + 2, 45 - lift, 'sock_d')
        im.rect(x0 - 1, 46 - lift, x0 + 3, 47 - lift, 'shoe'); im.hline(x0 - 1, x0 + 3, 46 - lift, 'shoe_l')
    # 袖子（泡泡袖）與手
    for x0 in (11, 29):
        im.rect(x0, 27 + dy, x0 + 4, 33 + dy, 'blouse')
        im.rect(x0, 33 + dy, x0 + 4, 33 + dy, 'blouse_d'); im.set(x0 if x0 < 20 else x0 + 4, 30 + dy, 'blouse_d')
        im.rect(x0 + 1, 34 + dy, x0 + 3, 35 + dy, 'skin')
    # 上衣、脖子、背帶裙上身
    im.rect(15, 26 + dy, 29, 33 + dy, 'blouse')
    im.rect(21, 24 + dy, 23, 26 + dy, 'skin')
    im.rect(17, 28 + dy, 27, 34 + dy, 'dress'); im.rect(17, 26 + dy, 18, 28 + dy, 'dress'); im.rect(26, 26 + dy, 27, 28 + dy, 'dress')
    for y in range(28 + dy, 34 + dy):
        im.set(17, y, 'dress_d'); im.set(27, y, 'dress_d')
    for y in (30, 33):
        im.set(22, y + dy, 'gold')
    # 領口蝴蝶結（深紅，兩條緞帶垂下）
    im.rect(19, 26 + dy, 21, 28 + dy, 'bow'); im.rect(23, 26 + dy, 25, 28 + dy, 'bow'); im.set(22, 27 + dy, 'bow_d')
    im.rect(21, 29 + dy, 22, 32 + dy, 'bow'); im.set(21, 29 + dy, 'bow_d')
    # 裙子：往下變寬，裙襬有金邊
    for i, y in enumerate(range(34 + dy, 42 + dy)):
        half = 7 + int(i * .75)
        im.hline(CX - half, CX + half - 1, y, 'dress')
        im.set(CX - half, y, 'dress_d'); im.set(CX + half - 1, y, 'dress_d')
    im.hline(CX - 12, CX + 11, 41 + dy, 'gold'); im.hline(CX - 11, CX + 10, 40 + dy, 'dress_d')
    for x in range(CX - 11, CX + 11, 3):
        im.set(x, 39 + dy, 'dress_d')
    im.rect(CX - 6, 35 + dy, CX - 6, 38 + dy, 'dress_l'); im.rect(CX + 5, 35 + dy, CX + 5, 38 + dy, 'dress_d')
    # 臉
    im.ellipse(CX, 18 + dy, 9.6, 8.2, 'skin')
    im.hline(14, 30, 25 + dy, 'skin_d')
    eye(im, 16, 19 + dy); eye(im, 24, 19 + dy)
    im.hline(14, 16, 22 + dy, 'blush'); im.hline(28, 30, 22 + dy, 'blush')
    im.set(21, 23 + dy, 'mouth'); im.set(22, 23 + dy, 'mouth')
    # 瀏海：中分，髮尾一撮一撮的（尖尖的）
    for x in range(11, 34):
        edge = 11 + int(abs(x - 22) * .28) + (2 if x % 4 == 0 else 1 if x % 4 == 2 else 0)
        if x in (22, 23):
            edge = 9 + (x - 22)
        for y in range(3 + dy, edge + dy):
            if ((x - CX) / 13.0) ** 2 + ((y - (13 + dy)) / 10.5) ** 2 <= 1.15:
                im.set(x, y, 'hair')
    for y in range(11 + dy, 25 + dy):                                                                       # 臉旁髮束（往下變細）
        w_ = 3 if y < 17 + dy else 2 if y < 22 + dy else 1
        im.hline(10, 10 + w_, y, 'hair'); im.hline(33 - w_, 33, y, 'hair')
        im.set(10 + w_, y, 'hair_d'); im.set(33 - w_, y, 'hair_d')
    # 髮絲陰影與亮部
    for y in range(4 + dy, 37 + dy):
        for x in range(6, 38):
            if im.get(x, y) == P['hair'] and strand(x, y):
                im.set(x, y, 'hair_d')
    for x in range(15, 30):
        if im.get(x, 5 + dy) == P['hair']:
            im.set(x, 5 + dy, 'hair_l')
    # 花與蝴蝶結（頭的右上方）
    flower(im, 30, 9 + dy)
    im.rect(33, 12 + dy, 36, 15 + dy, 'bow'); im.rect(34, 16 + dy, 36, 20 + dy, 'bow'); im.set(33, 12 + dy, 'bow_d'); im.rect(35, 13 + dy, 36, 14 + dy, 'bow_d')
    return im


# ================= 後面 =================
def draw_back(step):
    im = Img(W, H)
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    for x0, lift in ((16, lift_l), (25, lift_r)):
        im.rect(x0, 41 - lift, x0 + 2, 42 - lift, 'dress_d')
        im.rect(x0, 43 - lift, x0 + 2, 45 - lift, 'sock'); im.set(x0, 44 - lift, 'sock_d'); im.set(x0, 45 - lift, 'sock_d')
        im.rect(x0 - 1, 46 - lift, x0 + 3, 47 - lift, 'shoe'); im.hline(x0 - 1, x0 + 3, 46 - lift, 'shoe_l')
    for i, y in enumerate(range(34 + dy, 42 + dy)):
        half = 7 + int(i * .75)
        im.hline(CX - half, CX + half - 1, y, 'dress')
        im.set(CX - half, y, 'dress_d'); im.set(CX + half - 1, y, 'dress_d')
    im.hline(CX - 12, CX + 11, 41 + dy, 'gold'); im.hline(CX - 11, CX + 10, 40 + dy, 'dress_d')
    for x0 in (11, 29):
        im.rect(x0, 27 + dy, x0 + 4, 33 + dy, 'blouse'); im.hline(x0, x0 + 4, 33 + dy, 'blouse_d')
        im.rect(x0 + 1, 34 + dy, x0 + 3, 35 + dy, 'skin')
    im.rect(15, 26 + dy, 29, 33 + dy, 'blouse'); im.rect(17, 29 + dy, 27, 34 + dy, 'dress')
    # 一整片頭髮：頭頂＋背後長髮到腰，越往下越窄
    im.ellipse(CX, 13 + dy, 14, 11.5, 'hair')
    for y in range(18 + dy, 38 + dy):
        t = (y - 18 - dy) / 20.0
        xl, xr = 7 + int(t * 5) + wave(y, 1.1), 36 - int(t * 5) - wave(y, 1.1, 1.3)
        im.hline(xl, xr, y, 'hair')
    for x in range(10, 34):                                                                                 # 髮尾波浪
        im.set(x, 37 + dy + (1 if x % 4 < 2 else 0), 'hair')
    for y in range(4 + dy, 39 + dy):
        for x in range(6, 38):
            if im.get(x, y) == P['hair'] and (strand(x, y) or (x == CX and y > 22)):
                im.set(x, y, 'hair_d')
    for x in range(14, 31):
        if im.get(x, 5 + dy) == P['hair']:
            im.set(x, 5 + dy, 'hair_l')
    im.rect(CX, 8 + dy, CX, 16 + dy, 'hair_d')
    bx, by = CX, 15 + dy
    im.rect(bx - 6, by - 3, bx - 2, by + 3, 'bow'); im.rect(bx + 2, by - 3, bx + 6, by + 3, 'bow')
    im.rect(bx - 2, by - 1, bx + 2, by + 1, 'bow_d')
    im.hline(bx - 5, bx - 3, by - 2, 'dress_l'); im.hline(bx + 3, bx + 5, by - 2, 'dress_l')
    im.rect(bx - 4, by + 4, bx - 3, by + 8, 'bow'); im.rect(bx + 3, by + 4, bx + 4, by + 8, 'bow')
    return im


# ================= 側面（臉朝左）=================
def draw_side(step):
    im = Img(W, H)
    dy = -1 if step else 0
    sh = {0: (0, 0), 1: (-3, 3), 2: (3, -3)}[step]                                                           # 兩隻腳前後錯開
    # 後面的頭髮：頭頂＋背後長髮（只在身體後面那一側，身體會蓋在前面）
    im.ellipse(23, 13 + dy, 13, 11, 'hair')
    for y in range(18 + dy, 38 + dy):
        xl, xr = 24 + wave(y, 1.0), 37 - wave(y, 1.2, 1.3)
        im.hline(xl, xr, y, 'hair')
    for x in range(26, 36):
        im.set(x, 37 + dy + (1 if x % 4 < 2 else 0), 'hair')
    # 腳（後腳在前、前腳在後）
    for sx, back in ((sh[1], True), (sh[0], False)):
        x0 = 19 + sx
        im.rect(x0, 41, x0 + 3, 42, 'dress_d')
        im.rect(x0, 43, x0 + 2, 45, 'sock_d' if back else 'sock')
        im.rect(x0 - 2, 46, x0 + 3, 47, 'shoe'); im.hline(x0 - 2, x0 + 3, 46, 'shoe_l')
    # 裙子（側面窄一點）
    for i, y in enumerate(range(34 + dy, 42 + dy)):
        half = 5 + int(i * .7)
        im.hline(CX - half - 1, CX + half, y, 'dress')
        im.set(CX - half - 1, y, 'dress_d'); im.set(CX + half, y, 'dress_d')
    im.hline(CX - 9, CX + 8, 41 + dy, 'gold'); im.hline(CX - 8, CX + 7, 40 + dy, 'dress_d')
    # 身體
    im.rect(17, 26 + dy, 27, 33 + dy, 'blouse')
    im.rect(17, 28 + dy, 27, 34 + dy, 'dress'); im.rect(17, 26 + dy, 19, 28 + dy, 'dress')
    im.set(18, 31 + dy, 'gold'); im.set(18, 34 + dy, 'gold')
    im.rect(16, 27 + dy, 21, 33 + dy, 'blouse'); im.hline(16, 21, 33 + dy, 'blouse_d')                       # 袖子（前面那隻手）
    im.rect(17, 34 + dy, 19, 35 + dy, 'skin')
    im.rect(15, 25 + dy, 17, 26 + dy, 'skin')
    # 臉（朝左）：先畫整個臉，再用髮蓋掉後半
    im.ellipse(19, 18 + dy, 8.4, 8.2, 'skin')
    im.hline(12, 25, 25 + dy, 'skin_d')
    cut = lambda y: 24 + int(round(2 * math.sin((y - 10) * .45)))
    for y in range(8 + dy, 27 + dy):
        for x in range(cut(y), 33):
            if ((x - 23) / 13.0) ** 2 + ((y - (13 + dy)) / 11.0) ** 2 <= 1.1 or y > 17 + dy:
                im.set(x, y, 'hair')
    im.rect(21, 20 + dy, 22, 22 + dy, 'skin_d')                                                              # 耳朵
    eye_side(im, 13, 19 + dy)
    im.hline(12, 14, 22 + dy, 'blush'); im.set(11, 23 + dy, 'mouth')
    # 瀏海（臉朝左：往前垂）
    for x in range(11, 30):
        edge = 11 + int(abs(x - 16) * .22) + (2 if x % 4 == 0 else 1 if x % 4 == 2 else 0)
        for y in range(3 + dy, edge + dy):
            if ((x - 22) / 13.0) ** 2 + ((y - (13 + dy)) / 10.5) ** 2 <= 1.15:
                im.set(x, y, 'hair')
    # 前面垂在胸前的一束
    for y in range(24 + dy, 37 + dy):
        xl = 14 + wave(y, 1.0)
        im.hline(xl, xl + 2, y, 'hair'); im.set(xl, y, 'hair_d')
    for y in range(4 + dy, 38 + dy):
        for x in range(12, 38):
            if im.get(x, y) == P['hair'] and strand(x, y):
                im.set(x, y, 'hair_d')
    for x in range(16, 30):
        if im.get(x, 5 + dy) == P['hair']:
            im.set(x, 5 + dy, 'hair_l')
    flower(im, 25, 10 + dy)
    im.rect(28, 14 + dy, 32, 18 + dy, 'bow'); im.rect(29, 19 + dy, 31, 22 + dy, 'bow'); im.rect(30, 15 + dy, 31, 16 + dy, 'bow_d')
    return im


def build_frame(direction, step):
    if direction == 'down':
        im = draw_front(step)
    elif direction == 'up':
        im = draw_back(step)
    else:
        im = draw_side(step)
        if direction == 'right':
            im = mirror(im)
    im.outline()
    # 腳下的影子（描邊之後再畫，才不會被描邊吃掉；半透明）
    sh = Img(W, H)
    sh.ellipse(CX, 48, 12, 3.2, SHADOW)
    for y in range(H):
        for x in range(W):
            if im.px[y][x] is None and sh.px[y][x] is not None:
                im.px[y][x] = sh.px[y][x]
    return im


# ---- PNG ----
def write_png(path, img, scale=1, bg=None):
    w, h = img.w * scale, img.h * scale
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            c = img.px[y // scale][x // scale]
            if c is None:
                r, g, b, a = (*bg, 255) if bg else (0, 0, 0, 0)
            elif len(c) == 4:
                if bg:
                    k = c[3] / 255
                    r, g, b, a = int(c[0] * k + bg[0] * (1 - k)), int(c[1] * k + bg[1] * (1 - k)), int(c[2] * k + bg[2] * (1 - k)), 255
                else:
                    r, g, b, a = c
            else:
                r, g, b, a = (*c, 255)
            raw += bytes((r, g, b, a))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out, exist_ok=True)
    dirs = ['down', 'right', 'up', 'left']
    sheet = Img(W * 3, H * 4)
    for r, d in enumerate(dirs):
        for step in range(3):
            blit(sheet, build_frame(d, step), step * W, r * H)
    write_png(os.path.join(out, 'chibi_sheet.png'), sheet)
    # 預覽：4 個方向的待機格並排，米色底、放大 8 倍（跟設定圖同樣的排法）
    prev = Img(W * 4 + 5 * 6, H + 12)
    for i, d in enumerate(dirs):
        blit(prev, build_frame(d, 0), 6 + i * (W + 6), 6)
    write_png(os.path.join(out, 'chibi_preview.png'), prev, 8, bg=(238, 226, 220))
    # 走路預覽：每個方向 3 格
    walk = Img(W * 3 + 4 * 6, (H + 6) * 4 + 6)
    for r, d in enumerate(dirs):
        for s in range(3):
            blit(walk, build_frame(d, s), 6 + s * (W + 6), 6 + r * (H + 6))
    write_png(os.path.join(out, 'chibi_walk_preview.png'), walk, 4, bg=(238, 226, 220))
    print('ok', out)


if __name__ == '__main__':
    main()
