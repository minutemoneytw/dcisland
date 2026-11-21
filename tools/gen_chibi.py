#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新風格人物（階段 1：分層 sheet）產生器（2026-11-21，使用者定案整套換成自製 Q 版像素風格，見 docs/notes.md「新風格人物」）。

把 `chibi_pilot2.py` 試作的角色拆成圖層，輸出成跟 LPC 同格式的 sheet（832×1856、64×64 一格；只填走路列 8～11：上／左／下／右，
欄 0＝待機、1／3／5／7＝走路，偶數欄複製前一欄），遊戲引擎照 LPC 的方式一層一層疊。圖層（由下往上，跟引擎疊圖順序一致）：
  body 皮膚（手、脖子）→ bottom 下身（圍裙下擺、褲子）→ shoes 靴子 → top 上身（袖子、圍裙上半、肩帶、皮帶、圍巾）→
  hairbg 後髮（頭頂、頭側、髮尖、馬尾；在臉的下面）→ face 臉（皮膚＋眼睛＋眉毛＋腮紅＋嘴）→ hair 前髮（瀏海、臉旁髮束；在臉的上面）→ hat 護目鏡。
**描邊不在圖層裡**：整圈近黑紫色的外框由遊戲引擎在合成完成後統一畫（每層各自描邊的話，層與層之間會多出不該有的線）。
用法：python tools/gen_chibi.py [輸出資料夾]   （預設輸出到 client/assets/avatar/；另外輸出 chibi_check.png 合成預覽）
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi_pilot as cp
import chibi_pilot2 as p2
from chibi_pilot import Img, write_png
from chibi_pilot2 import W, H, TOP, CX, trap, trap_side

LAYERS = ['body', 'bottom', 'shoes', 'top', 'hairbg', 'face', 'hair', 'hat']   # 由下往上
SHEET_W, SHEET_H = 832, 1856          # 跟 LPC 一樣：13 欄 × 29 列、每格 64×64
CELL = 64
OX, OY = 12, 7                        # 一幀（W×(H+TOP)）放進 64×64 格子的位置：腳底落在格子第 60～62 列（footDy 再往下 2）
WALK_ROW = {'up': 8, 'left': 9, 'down': 10, 'right': 11}
WALK_FRAMES = [0, 1, 1, 0, 0, 2, 2, 0, 0]   # 欄 0..8 用哪一個 step：0＝待機、1／2＝兩個步伐（引擎只用 0、1、3、5、7）


class LImg(Img):
    """分層畫布：座標往下平移 TOP 列（馬尾可以畫在 y < 0），每個圖層一張。"""
    def __init__(self):
        super().__init__(W, H + TOP)
        self.top = TOP
        self.lay = {n: [[None] * W for _ in range(H + TOP)] for n in LAYERS}
        self.cur = 'body'

    def L(self, name):
        self.cur = name

    def set(self, x, y, c):
        y += self.top
        if 0 <= x < self.w and 0 <= y < self.h and c is not None:
            self.lay[self.cur][y][x] = c if isinstance(c, tuple) else cp.P[c]

    def get(self, x, y):
        y += self.top
        if not (0 <= x < self.w and 0 <= y < self.h):
            return None
        for n in reversed(LAYERS):
            v = self.lay[n][y][x]
            if v is not None:
                return v
        return None

    def composite(self):
        out = Img(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                for n in reversed(LAYERS):
                    v = self.lay[n][y][x]
                    if v is not None:
                        out.px[y][x] = v
                        break
        return out

    def mirrored(self):
        m = LImg()
        for n in LAYERS:
            for y in range(self.h):
                m.lay[n][y] = self.lay[n][y][::-1]
        return m


def shade_hair(im):
    """頭髮的暗色髮絲（短直條），前後髮各自處理。"""
    for ln in ('hairbg', 'hair'):
        g = im.lay[ln]
        for y in range(im.h):
            for x in range(im.w):
                if g[y][x] == cp.P['h'] and cp.strand(x, y - im.top):
                    g[y][x] = cp.P['h_m'] if (x + y - im.top) % 2 else cp.P['h_d']


def arms(im, dy, side_hand_layer='body'):
    """手臂（酒紅袖子，從肩膀到手腕一條斜線）與手；正面／背面用。"""
    im.L('top')
    for y in range(28, 38):
        L = int(13 - (y - 28) * .45)
        R = min(14, L + 4)
        for side in (0, 1):
            xa, xb = (L, R) if side == 0 else (39 - R, 39 - L)
            im.hline(xa, xb, y + dy, 'mr')
            outer = xa if side == 0 else xb
            im.set(outer, y + dy, 'mr_d')
            if 31 <= y <= 34:
                im.set(outer + (2 if side == 0 else -2), y + dy, 'mr_l')
    im.L(side_hand_layer)
    im.rect(7, 38 + dy, 9, 39 + dy, 'sk'); im.rect(30, 38 + dy, 32, 39 + dy, 'sk')


def boots(im, lift_l, lift_r, side=False):
    pass


def hem(im, dy, fn):
    """圍裙下擺（梯形的下半）：bottom 層。"""
    im.L('bottom')
    for y in range(39, 43):
        a, b = fn(y)
        im.hline(a, b, y + dy, 'cr'); im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    a42, b42 = fn(42)
    im.hline(a42, b42, 42 + dy, 'cr_d'); im.hline(a42, b42, 43 + dy, 'mr'); im.hline(a42, b42, 44 + dy, 'mr_d')


# ================= 正面 =================
def draw_front(step=0):
    im = LImg()
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    for x0, lift in ((14, lift_l), (21, lift_r)):
        im.L('bottom'); im.rect(x0 + 1, 41 - lift, x0 + 3, 43 - lift, 'pr')                       # 褲管（深紫）
        im.L('shoes')
        xa, xb = (x0, x0 + 3) if x0 < 20 else (x0 + 1, x0 + 4)
        im.rect(xa, 44 - lift, xb, 49 - lift, 'br'); im.rect(xa, 44 - lift, xb, 44 - lift, 'br_l'); im.rect(xa, 49 - lift, xb, 50 - lift, 'br_d')
        for y in range(44, 49):
            im.set(xb, y - lift, 'br_d')
    hem(im, dy, trap)
    arms(im, dy)
    # 圍裙上半
    im.L('top')
    span = {y: trap(y) for y in range(28, 39)}
    for y, (a, b) in span.items():
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    for y in range(28, 35):
        a, b = span[y]
        im.hline(a, a + 1, y + dy, 'br'); im.hline(b - 1, b, y + dy, 'br')
        im.set(a, y + dy, 'br_d'); im.set(b, y + dy, 'br_d')
    a35, b35 = span[35]
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')
    im.rect(19, 35 + dy, 21, 36 + dy, 'br_l')
    im.rect(23, 37 + dy, 24, 38 + dy, 'gem'); im.set(23, 37 + dy, 'ew')
    im.hline(18, 22, 31 + dy, 'cr_d'); im.hline(17, 23, 33 + dy, 'cr_d')
    im.rect(16, 27 + dy, 24, 28 + dy, 'mr'); im.hline(16, 24, 28 + dy, 'mr_d'); im.hline(17, 19, 27 + dy, 'mr_l')   # 領口圍巾
    im.L('body'); im.rect(18, 27 + dy, 21, 27 + dy, 'sk_d')                                           # 脖子
    # 後髮（臉的下面）：頭頂、頭側、髮尖、馬尾
    im.L('hairbg')
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')
    for y in range(13 + dy, 24 + dy):
        im.hline(9, 13, y, 'h'); im.hline(26, 30, y, 'h')
    for x0, sgn in ((9, -1), (31, 1)):
        for i in range(1, 5):
            im.hline(min(x0, x0 + sgn * i), max(x0, x0 + sgn * i), 16 + dy + (0 if i < 3 else 1), 'h')
    im.ellipse(CX, .5 + dy, 5.2, 3.0, 'h')
    # 臉
    im.L('face')
    face = {13: (18, 21), 14: (17, 22), 15: (16, 23), 16: (15, 24)}
    for y in range(17, 24):
        face[y] = (14, 25)
    face.update({24: (15, 24), 25: (16, 23), 26: (18, 21)})
    for y, (a, b) in face.items():
        im.hline(a, b, y + dy, 'sk')
    for ex, flip in ((14, False), (22, True)):
        xs = [ex + i for i in range(4)]
        if flip:
            xs = xs[::-1]
        if not flip:
            im.hline(ex, ex + 2, 18 + dy, 'la'); im.hline(ex + 1, ex + 3, 19 + dy, 'la')
        else:
            im.hline(ex + 1, ex + 3, 18 + dy, 'la'); im.hline(ex, ex + 2, 19 + dy, 'la')
        row1 = ['lb', 'ir', 'pu', 'ir']
        row2 = ['ew', 'ir_l', 'ir_l', 'ir']
        for k, x in enumerate(xs):
            im.set(x, 20 + dy, row1[k]); im.set(x, 21 + dy, row2[k])
    im.set(14, 19 + dy, 'ew'); im.set(25, 19 + dy, 'ew')
    for bx in (15, 16, 17, 22, 23, 24):
        im.set(bx, (17 if bx in (17, 22) else 16) + dy, 'brow')
    im.hline(13, 15, 22 + dy, 'bl'); im.hline(24, 26, 22 + dy, 'bl')
    im.hline(13, 14, 23 + dy, 'bl'); im.hline(25, 26, 23 + dy, 'bl')
    im.set(19, 24 + dy, 'mo'); im.set(20, 24 + dy, 'bl')
    # 前髮（臉的上面）：瀏海、臉旁髮束
    im.L('hair')
    for y in range(13 + dy, 24 + dy):
        a, b = face.get(y - dy, (18, 21))
        for x in range(11, a):
            im.set(x, y, 'h')
        for x in range(b + 1, 29):
            im.set(x, y, 'h')
    for y in range(13, 27):
        xa = 11 if y <= 21 else 12 if y <= 24 else 13
        im.hline(xa, 13, y + dy, 'h'); im.hline(26, 39 - xa, y + dy, 'h')
    # 護目鏡
    im.L('hat')
    for lx in (12, 22):
        for (dx0, dy0, w_) in ((1, 0, 4), (0, 1, 6), (0, 2, 6), (0, 3, 6), (0, 4, 6), (1, 5, 4)):
            im.hline(lx + dx0, lx + dx0 + w_ - 1, 8 + dy + dy0, 'gf')
        im.rect(lx + 1, 9 + dy, lx + 4, 12 + dy, 'ln'); im.rect(lx + 1, 11 + dy, lx + 4, 12 + dy, 'ln_d')
        im.rect(lx + 1, 9 + dy, lx + 2, 10 + dy, 'ln_h')
        im.set(lx, 11 + dy, 'gf_d'); im.set(lx + 5, 11 + dy, 'gf_d')
    im.rect(18, 10 + dy, 21, 11 + dy, 'gf_d')
    im.rect(10, 10 + dy, 11, 11 + dy, 'gf_d'); im.rect(28, 10 + dy, 29, 11 + dy, 'gf_d')
    shade_hair(im)
    for y in range(14 + dy, 25 + dy):                                                                  # 髮束的藍紫色反光
        im.L('hair')
        im.set(12, y, 'h_b') if y % 3 else im.set(12, y, 'h_p')
        im.set(27, y, 'h_b') if y % 3 else im.set(27, y, 'h_p')
    im.L('hairbg')
    for (x, y) in ((16, -1), (17, -2), (18, -2)):
        im.set(x, y + dy, 'h_b')
    return im


# ================= 背面 =================
def draw_back(step=0):
    im = LImg()
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    for x0, lift in ((14, lift_l), (21, lift_r)):
        im.L('bottom'); im.rect(x0 + 1, 41 - lift, x0 + 3, 43 - lift, 'pr')
        im.L('shoes')
        xa, xb = (x0, x0 + 3) if x0 < 20 else (x0 + 1, x0 + 4)
        im.rect(xa, 44 - lift, xb, 49 - lift, 'br'); im.rect(xa, 49 - lift, xb, 50 - lift, 'br_d')
        for y in range(44, 49):
            im.set(xb, y - lift, 'br_d')
    hem(im, dy, trap)
    arms(im, dy)
    im.L('top')
    for y in range(28, 39):
        a, b = trap(y)
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    for i, y in enumerate(range(28, 35)):                                                              # 兩條肩帶在背後交叉
        xl, xr = 16 + int(i * .5), 24 - int(i * .5)
        im.hline(xl, xl + 1, y + dy, 'br'); im.hline(xr - 1, xr, y + dy, 'br')
        im.set(xl, y + dy, 'br_d'); im.set(xr, y + dy, 'br_d')
    a35, b35 = trap(35)
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')
    im.hline(18, 22, 31 + dy, 'cr_d')
    im.rect(16, 27 + dy, 24, 28 + dy, 'mr'); im.hline(16, 24, 28 + dy, 'mr_d')
    im.L('body'); im.rect(18, 27 + dy, 21, 27 + dy, 'sk_d')
    # 後髮：整個後腦
    im.L('hairbg')
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')
    for y in range(13 + dy, 24 + dy):
        im.hline(9, 30, y, 'h')
    im.hline(13, 26, 24 + dy, 'h'); im.hline(15, 24, 25 + dy, 'h'); im.hline(17, 22, 26 + dy, 'h')
    for x0, sgn in ((9, -1), (31, 1)):
        for i in range(1, 5):
            im.hline(min(x0, x0 + sgn * i), max(x0, x0 + sgn * i), 16 + dy + (0 if i < 3 else 1), 'h')
    # 馬尾（背面看得到整條，蓋在護目鏡皮帶上面，所以放前髮層，皮帶避開馬尾）
    im.L('hair')
    im.ellipse(CX, .5 + dy, 5.2, 3.0, 'h')
    tail = {}
    for y in range(2, 31):
        w_ = 6 if y < 14 else 5 if y < 22 else 4 if y < 27 else 3
        a = 20 - w_ // 2
        tail[y] = (a, a + w_ - 1)
        im.hline(a, a + w_ - 1, y + dy, 'h')
        im.set(a, y + dy, 'h_d'); im.set(a + w_ - 1, y + dy, 'h_d')
    im.L('hat')                                                                                        # 護目鏡皮帶繞過後腦（馬尾那一段被馬尾蓋住）
    for y in (10, 11):
        a, b = tail[y]
        im.hline(10, a - 1, y + dy, 'gf_d'); im.hline(b + 1, 29, y + dy, 'gf_d')
    shade_hair(im)
    im.L('hair')
    for y in range(3 + dy, 26 + dy):
        if y % 4:
            im.set(18, y, 'h_b')
    im.L('hairbg')
    for (x, y) in ((16, -1), (17, -2), (18, -2)):
        im.set(x, y + dy, 'h_b')
    return im


# ================= 側面（臉朝左）=================
def draw_side(step=0):
    im = LImg()
    dy = -1 if step else 0
    sh = {0: (0, 0), 1: (-2, 2), 2: (2, -2)}[step]
    for sx, back in ((sh[1], True), (sh[0], False)):
        xa = 18 + sx
        col = 'br_d' if back else 'br'
        im.L('bottom'); im.rect(xa + 1, 41, xa + 3, 43, 'pr')
        im.L('shoes')
        im.rect(xa + 1, 44, xa + 4, 49, col); im.rect(xa, 47, xa, 49, col)
        im.hline(xa, xa + 4, 50, 'br_d')
        if not back:
            im.hline(xa + 1, xa + 4, 44, 'br_l')
    hem(im, dy, trap_side)
    im.L('top')
    for y in range(28, 39):
        a, b = trap_side(y)
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    for y in range(28, 35):
        im.hline(21, 22, y + dy, 'br'); im.set(21, y + dy, 'br_d')
    a35, b35 = trap_side(35)
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')
    im.rect(16, 37 + dy, 17, 38 + dy, 'gem'); im.set(16, 37 + dy, 'ew')
    im.rect(17, 27 + dy, 24, 28 + dy, 'mr'); im.hline(17, 24, 28 + dy, 'mr_d')
    for y in range(28, 38):                                                                            # 靠近我們的手臂（往前微微斜下）
        L = int(19 - (y - 28) * .25)
        im.hline(L, L + 4, y + dy, 'mr'); im.set(L, y + dy, 'mr_d')
        if 31 <= y <= 34:
            im.set(L + 2, y + dy, 'mr_l')
    im.rect(16, 38 + dy, 18, 39 + dy, 'sk')                                                            # 手（跟袖子同層：會蓋在圍裙下擺前面）
    im.L('body'); im.rect(19, 27 + dy, 20, 27 + dy, 'sk_d')
    # 後髮：頭頂、後腦、馬尾（垂在腦後）
    im.L('hairbg')
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')
    for y in range(13 + dy, 25 + dy):
        im.hline(22, 30, y, 'h')
    im.ellipse(CX + 3, .5 + dy, 4.8, 3.0, 'h')
    for y in range(2, 27):
        c = 26 + int(y * .25)
        w_ = 5 if y < 10 else 4 if y < 18 else 3
        a = c - w_ // 2
        im.hline(a, a + w_ - 1, y + dy, 'h'); im.set(a + w_ - 1, y + dy, 'h_d')
    # 臉
    im.L('face')
    face = {13: (16, 19), 14: (15, 20), 15: (14, 21), 16: (13, 21), 23: (13, 21), 24: (14, 21), 25: (15, 21), 26: (17, 20)}
    for y in range(17, 23):
        face[y] = (12, 21)
    for y, (a, b) in face.items():
        im.hline(a, b, y + dy, 'sk')
    ex = 14
    im.hline(ex + 1, ex + 3, 18 + dy, 'la'); im.hline(ex, ex + 2, 19 + dy, 'la')
    for k, (r1, r2) in enumerate((('ir', 'ir'), ('pu', 'ir_l'), ('ir', 'ir_l'), ('lb', 'ew'))):
        im.set(ex + k, 20 + dy, r1); im.set(ex + k, 21 + dy, r2)
    im.set(ex + 3, 19 + dy, 'ew')
    for (bx, by) in ((14, 17), (15, 16), (16, 16), (17, 16), (18, 17)):
        im.set(bx, by + dy, 'brow')
    im.hline(15, 19, 22 + dy, 'bl'); im.hline(17, 19, 23 + dy, 'bl'); im.hline(14, 15, 24 + dy, 'mo')
    # 前髮：瀏海與臉旁髮束
    im.L('hair')
    for y in range(13 + dy, 17 + dy):
        a, b = face.get(y - dy, (16, 19))
        for x in range(11, a):
            im.set(x, y, 'h')
    for y in range(13, 27):
        w_ = 3 if y <= 21 else 2 if y <= 24 else 1
        im.hline(19, 19 + w_ - 1, y + dy, 'h')
    im.L('hat')
    im.rect(10, 8 + dy, 14, 13 + dy, 'gf'); im.rect(11, 9 + dy, 13, 12 + dy, 'ln')
    im.rect(11, 11 + dy, 13, 12 + dy, 'ln_d'); im.hline(11, 12, 9 + dy, 'ln_h')
    im.hline(15, 30, 10 + dy, 'gf_d'); im.hline(15, 30, 11 + dy, 'gf_d')
    shade_hair(im)
    im.L('hair')
    for y in range(14 + dy, 25 + dy):
        im.set(20, y, 'h_b') if y % 3 else im.set(20, y, 'h_p')
    im.L('hairbg')
    for y in range(4 + dy, 22 + dy):
        if y % 3:
            im.set(26 + int(y * .25) - 1, y, 'h_b')
    return im


def frame(direction, step):
    """一個方向、一個步伐的分層畫布（右＝左的鏡像）。"""
    if direction == 'down':
        return draw_front(step)
    if direction == 'up':
        return draw_back(step)
    im = draw_side(step)
    return im.mirrored() if direction == 'right' else im


def build_sheets():
    """回傳 {圖層名: Img(832×1856)}：每個圖層一張 LPC 格式的 sheet（只填走路列）。"""
    sheets = {n: Img(SHEET_W, SHEET_H) for n in LAYERS}
    for d, row in WALK_ROW.items():
        cache = {s: frame(d, s) for s in (0, 1, 2)}
        for col, st in enumerate(WALK_FRAMES):
            fr = cache[st]
            for n in LAYERS:
                dst, src = sheets[n], fr.lay[n]
                for y in range(fr.h):
                    for x in range(fr.w):
                        v = src[y][x]
                        if v is not None:
                            dst.px[row * CELL + OY + y][col * CELL + OX + x] = v
    return sheets


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'client', 'assets', 'avatar')
    os.makedirs(out, exist_ok=True)
    sheets = build_sheets()
    for n, im in sheets.items():
        write_png(os.path.join(out, f'chibi_{n}.png'), im)
    if len(sys.argv) > 1:   # 有指定輸出資料夾（測試用）才另外輸出合成預覽；預設（寫進 client/assets/avatar/）不放預覽圖
        prev = Img(W * 3 + 16, (H + TOP + 4) * 4 + 4)
        for r, d in enumerate(['down', 'right', 'up', 'left']):
            for s in range(3):
                c = frame(d, s).composite()
                p2.outline_fixed(c, cp.P['ol'])
                for y in range(c.h):
                    for x in range(c.w):
                        if c.px[y][x] is not None:
                            prev.px[4 + r * (H + TOP + 4) + y][4 + s * (W + 4) + x] = c.px[y][x]
        write_png(os.path.join(out, 'chibi_check.png'), prev, 4, bg=(255, 255, 255))
    print('ok', out)


if __name__ == '__main__':
    main()
