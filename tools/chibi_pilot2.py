#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新風格人物試作 第二版（2026-11-21，使用者換了一張參考圖：戴護目鏡、深紫色頭髮帶藍色反光、金色大眼睛、米色圍裙＋酒紅袖子＋棕色靴子的像素角色）。

跟 chibi_pilot.py 一樣只是試作，**還沒接進遊戲**；先只畫正面（參考圖只有正面），風格確認後再補其他方向與走路。
特色（取自參考圖）：近黑紫色的描邊（連膚色周圍也是）、頭髮用深紫＋藍色反光、臉很大很白、眼睛 4 格寬（金色眼珠＋淺藍上緣＋深色睫毛）、
額頭上兩顆圓形護目鏡（金框＋淺藍鏡片＋白色反光）、領口酒紅色圍巾、米色圍裙＋棕色皮帶與肩帶、綠色小寶石、棕色靴子。
用法：python tools/chibi_pilot2.py [輸出資料夾]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi_pilot as cp
from chibi_pilot import Img, blit, write_png

W, H = 40, 52
CX = 20          # 臉的中心在第 19、20 格之間

cp.P.update({
    'ol': (30, 12, 30),
    'h': (60, 30, 68), 'h_m': (82, 52, 100), 'h_d': (40, 18, 46), 'h_b': (88, 122, 168), 'h_p': (112, 102, 172),
    'sk': (248, 226, 218), 'sk_d': (222, 170, 160), 'bl': (214, 136, 128), 'mo': (150, 52, 84),
    'ir': (240, 176, 64), 'ir_l': (255, 236, 150), 'pu': (86, 50, 28), 'lb': (160, 208, 232), 'ew': (255, 255, 255), 'la': (58, 28, 28),
    'gf': (234, 178, 66), 'gf_d': (130, 82, 44), 'ln': (160, 208, 232), 'ln_d': (92, 134, 182), 'ln_h': (255, 255, 255),
    'cr': (246, 232, 200), 'cr_d': (168, 152, 136), 'br': (122, 76, 44), 'br_d': (66, 34, 18), 'br_l': (170, 116, 70),
    'mr': (138, 44, 80), 'mr_d': (92, 32, 58), 'mr_l': (176, 70, 108), 'pr': (58, 34, 74),
    'gem': (24, 200, 88), 'brow': (70, 42, 60),
})


def outline_fixed(im, color):
    """整個角色外圍描一圈近黑紫色（參考圖連膚色周圍都是深色描邊）。"""
    out = []
    for y in range(im.h):
        for x in range(im.w):
            if im.px[y][x] is not None:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = im.get(x + dx, y + dy)
                if n is not None and len(n) == 3:
                    out.append((x, y))
                    break
    for x, y in out:
        im.px[y][x] = color


def trap(y):
    """圍裙（直的梯形，使用者要求）每一列的左右邊界：胸口 11 格寬，每往下 7 列左右各多 1 格，沒有鼓出來或收腰的弧度。"""
    k = (y - 28 + 3) // 7                      # 0 → 11 格、1 → 13 格、2 → 15 格
    return 15 - k, 25 + k


TOP = 4          # 上面多留幾列：高馬尾會超出原本的畫面上緣


class ShiftImg(Img):
    """座標往下平移 top 列的畫布：畫的時候還是用原本的座標，馬尾可以畫在 y < 0。"""
    def __init__(self, w, h, top):
        super().__init__(w, h + top)
        self.top = top

    def set(self, x, y, c):
        super().set(x, y + self.top, c)

    def get(self, x, y):
        return super().get(x, y + self.top)


def draw_front(step=0):
    im = ShiftImg(W, H, TOP)
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    # ---------- 靴子與腿 ----------
    for x0, lift in ((14, lift_l), (21, lift_r)):
        im.rect(x0 + 1, 41 - lift, x0 + 3, 43 - lift, 'pr')                        # 腿（深紫色褲）
        xa, xb = (x0, x0 + 3) if x0 < 20 else (x0 + 1, x0 + 4)                        # 靴子只縮內側一格（使用者要求；5 格寬 → 4 格寬）：左腳縮右邊、右腳縮左邊
        im.rect(xa, 44 - lift, xb, 49 - lift, 'br')                                  # 靴子
        im.rect(xa, 44 - lift, xb, 44 - lift, 'br_l')
        im.rect(xa, 49 - lift, xb, 50 - lift, 'br_d')                                # 鞋底
        im.vline = None
        for y in range(44, 49):
            im.set(xb, y - lift, 'br_d')
    # ---------- 圍裙下擺與褲子 ----------
    for y in range(39, 43):                                                             # 圍裙下擺：沿著梯形的斜邊繼續往下
        a, b = trap(y)
        im.hline(a, b, y + dy, 'cr')
        im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    a42, b42 = trap(42)
    im.hline(a42, b42, 42 + dy, 'cr_d'); im.hline(a42 + 2, b42 - 2, 41 + dy, 'cr_d')
    im.hline(a42, b42, 43 + dy, 'mr'); im.hline(a42, b42, 44 + dy, 'mr_d')
    # ---------- 手臂（酒紅袖子）：從肩膀到手腕是一條斜線（使用者要求），往外往下張開 ----------
    for y in range(28, 38):
        L = int(13 - (y - 28) * .45)                                                  # 外緣：每往下一列往外 0.45 格（斜度不要太誇張）
        R = min(14, L + 4)                                                            # 內緣：前幾列貼著身體，之後跟著外緣走（寬 5 格）
        for side in (0, 1):
            xa, xb = (L, R) if side == 0 else (39 - R, 39 - L)
            im.hline(xa, xb, y + dy, 'mr')
            outer = xa if side == 0 else xb
            im.set(outer, y + dy, 'mr_d')
            if 31 <= y <= 34:
                im.set(outer + (2 if side == 0 else -2), y + dy, 'mr_l')
    im.rect(7, 38 + dy, 9, 39 + dy, 'sk'); im.rect(30, 38 + dy, 32, 39 + dy, 'sk')   # 手（接在手腕斜線的末端）
    # ---------- 上身：圍裙、肩帶、皮帶 ----------
    # 圍裙上身：直的梯形（使用者要求，不要鼓胸、不要收腰），邊界由 trap() 決定
    span = {y: trap(y) for y in range(28, 39)}
    for y, (a, b) in span.items():
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')                    # 兩側的陰影
    for y in range(28, 35):                                                         # 肩帶：貼著圍裙邊緣走
        a, b = span[y]
        im.hline(a, a + 1, y + dy, 'br'); im.hline(b - 1, b, y + dy, 'br')
        im.set(a, y + dy, 'br_d'); im.set(b, y + dy, 'br_d')
    a35, b35 = span[35]
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')           # 皮帶
    im.rect(19, 35 + dy, 21, 36 + dy, 'br_l')                                          # 皮帶扣
    im.rect(23, 37 + dy, 24, 38 + dy, 'gem'); im.set(23, 37 + dy, 'ew')               # 綠色小寶石
    im.hline(18, 22, 31 + dy, 'cr_d'); im.hline(17, 23, 33 + dy, 'cr_d')              # 圍裙的皺褶
    # ---------- 領口酒紅色圍巾與脖子 ----------
    im.rect(18, 27 + dy, 21, 27 + dy, 'sk_d')
    im.rect(16, 27 + dy, 24, 28 + dy, 'mr'); im.hline(16, 24, 28 + dy, 'mr_d'); im.hline(17, 19, 27 + dy, 'mr_l')
    # ---------- 頭髮（2026-11-21 使用者改：不是長直髮——臉兩側各一搓，外面往後綁，再外面是翹出去的髮尖，頭頂高馬尾）----------
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')                                           # 頭頂圓弧
    for y in range(13 + dy, 24 + dy):                                                 # 耳朵高度的頭側（外側的頭髮往後綁，所以只到這裡，不往下垂）
        im.hline(9, 13, y, 'h'); im.hline(26, 30, y, 'h')
    for x0, sgn in ((9, -1), (31, 1)):                                                # 兩側往外翹的髮尖（維持第一版的樣子：橫向、尖尖的，使用者要求）
        for i in range(1, 5):
            im.hline(min(x0, x0 + sgn * i), max(x0, x0 + sgn * i), 16 + dy + (0 if i < 3 else 1), 'h')
    # 高馬尾（使用者要求是圓的，不是尖的）：從正面只看得到馬尾的上緣——一個圓弧凸在頭頂上，髮尾在頭後面看不到
    im.ellipse(CX, .5 + dy, 5.2, 3.0, 'h')
    # ---------- 臉（上窄下寬再收下巴）----------
    face = {13: (18, 21), 14: (17, 22), 15: (16, 23), 16: (15, 24)}
    for y in range(17, 24):
        face[y] = (14, 25)
    face.update({24: (15, 24), 25: (16, 23), 26: (18, 21)})
    for y, (a, b) in face.items():
        im.hline(a, b, y + dy, 'sk')
    # ---------- 眼睛（4 格寬：外側眼白、淺藍上緣、金色眼珠、整排睫毛，睫毛上面再加中間兩格做圓弧）+ 眉毛 ----------
    for ex, flip in ((14, False), (22, True)):
        xs = [ex + i for i in range(4)]
        if flip:
            xs = xs[::-1]                                                            # 讓外側永遠是第 0 個
        if not flip:                                                                 # 睫毛：整排 4 格，最外側那格往上一格（使用者要求），上緣變圓
            im.hline(ex, ex + 2, 18 + dy, 'la'); im.hline(ex + 1, ex + 3, 19 + dy, 'la')
        else:
            im.hline(ex + 1, ex + 3, 18 + dy, 'la'); im.hline(ex, ex + 2, 19 + dy, 'la')
        row1 = ['lb', 'ir', 'pu', 'ir']
        row2 = ['ew', 'ir_l', 'ir_l', 'ir']
        for k, x in enumerate(xs):
            im.set(x, 20 + dy, row1[k]); im.set(x, 21 + dy, row2[k])
    im.set(14, 19 + dy, 'ew'); im.set(25, 19 + dy, 'ew')                              # 睫毛最外側往上移後，原本那格補眼白
    for bx in (15, 16, 17, 22, 23, 24):                                               # 眉毛：3 格，最內側那格往下一格（使用者要求，不皺眉）
        im.set(bx, (17 if bx in (17, 22) else 16) + dy, 'brow')
    im.hline(13, 15, 22 + dy, 'bl'); im.hline(24, 26, 22 + dy, 'bl')                  # 腮紅
    im.hline(13, 14, 23 + dy, 'bl'); im.hline(25, 26, 23 + dy, 'bl')
    im.set(19, 24 + dy, 'mo'); im.set(20, 24 + dy, 'bl')                              # 小嘴
    # ---------- 瀏海與臉兩側的髮束（各一搓，往下變細，到下巴）----------
    for y in range(13 + dy, 24 + dy):
        a, b = face.get(y - dy, (18, 21))
        for x in range(11, a):
            im.set(x, y, 'h')
        for x in range(b + 1, 29):
            im.set(x, y, 'h')
    for y in range(13, 27):
        xa = 11 if y <= 21 else 12 if y <= 24 else 13
        im.hline(xa + dy * 0, 13, y + dy, 'h'); im.hline(26, 39 - xa, y + dy, 'h')
    # ---------- 護目鏡（額頭上兩顆圓鏡片）----------
    for lx in (12, 22):
        for (dx0, dy0, w_) in ((1, 0, 4), (0, 1, 6), (0, 2, 6), (0, 3, 6), (0, 4, 6), (1, 5, 4)):
            im.hline(lx + dx0, lx + dx0 + w_ - 1, 8 + dy + dy0, 'gf')                # 金框
        for (dx0, dy0, w_) in ((2, 1, 2), (1, 2, 4), (1, 3, 4), (1, 4, 4), (2, 5, 2)):
            pass
        im.rect(lx + 1, 9 + dy, lx + 4, 12 + dy, 'ln'); im.rect(lx + 1, 11 + dy, lx + 4, 12 + dy, 'ln_d')   # 鏡片
        im.rect(lx + 1, 9 + dy, lx + 2, 10 + dy, 'ln_h')                              # 反光
        im.set(lx, 11 + dy, 'gf_d'); im.set(lx + 5, 11 + dy, 'gf_d')
    im.rect(18, 10 + dy, 21, 11 + dy, 'gf_d')                                          # 兩顆鏡片中間的鼻樑
    im.rect(10, 10 + dy, 11, 11 + dy, 'gf_d'); im.rect(28, 10 + dy, 29, 11 + dy, 'gf_d')   # 兩側的皮帶
    # ---------- 頭髮的亮部與暗部（藍色反光）----------
    for y in range(-7 + dy, 27 + dy):
        for x in range(4, 37):
            if im.get(x, y) == cp.P['h']:
                if cp.strand(x, y):
                    im.set(x, y, 'h_m' if (x + y) % 2 else 'h_d')
    for y in range(14 + dy, 25 + dy):                                                  # 臉旁髮束的藍紫色反光
        im.set(12, y, 'h_b') if y % 3 else im.set(12, y, 'h_p')
        im.set(27, y, 'h_b') if y % 3 else im.set(27, y, 'h_p')
    for (x, y) in ((16, -1), (17, -2), (18, -2)):                                       # 馬尾上緣左邊的藍色反光（沿著圓弧）
        im.set(x, y + dy, 'h_b')
    return im


def shade_hair(im, dy, x0=4, x1=37):
    """頭髮的暗色髮絲（短直條）。"""
    for y in range(-7 + dy, 36 + dy):
        for x in range(x0, x1):
            if im.get(x, y) == cp.P['h'] and cp.strand(x, y):
                im.set(x, y, 'h_m' if (x + y) % 2 else 'h_d')


def trap_side(y):
    """側面的圍裙（直的梯形，比正面窄）：胸口 9 格寬，每往下 7 列左右各多 1 格。"""
    k = (y - 28 + 3) // 7
    return 16 - k, 24 + k


# ================= 背面 =================
def draw_back(step=0):
    im = ShiftImg(W, H, TOP)
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    # 靴子（跟正面一樣：只縮內側一格）
    for x0, lift in ((14, lift_l), (21, lift_r)):
        im.rect(x0 + 1, 41 - lift, x0 + 3, 43 - lift, 'pr')
        xa, xb = (x0, x0 + 3) if x0 < 20 else (x0 + 1, x0 + 4)
        im.rect(xa, 44 - lift, xb, 49 - lift, 'br'); im.rect(xa, 49 - lift, xb, 50 - lift, 'br_d')
        for y in range(44, 49):
            im.set(xb, y - lift, 'br_d')
    # 圍裙下擺
    for y in range(39, 43):
        a, b = trap(y)
        im.hline(a, b, y + dy, 'cr'); im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    a42, b42 = trap(42)
    im.hline(a42, b42, 42 + dy, 'cr_d'); im.hline(a42, b42, 43 + dy, 'mr'); im.hline(a42, b42, 44 + dy, 'mr_d')
    # 手臂（跟正面一樣的斜線）
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
    im.rect(7, 38 + dy, 9, 39 + dy, 'sk'); im.rect(30, 38 + dy, 32, 39 + dy, 'sk')
    # 圍裙背面：兩條肩帶在背後交叉到腰上
    for y in range(28, 39):
        a, b = trap(y)
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    for i, y in enumerate(range(28, 35)):
        xl, xr = 16 + int(i * .5), 24 - int(i * .5)
        im.hline(xl, xl + 1, y + dy, 'br'); im.hline(xr - 1, xr, y + dy, 'br')
        im.set(xl, y + dy, 'br_d'); im.set(xr, y + dy, 'br_d')
    a35, b35 = trap(35)
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')
    im.hline(18, 22, 31 + dy, 'cr_d')
    # 領口圍巾
    im.rect(18, 27 + dy, 21, 27 + dy, 'sk_d')
    im.rect(16, 27 + dy, 24, 28 + dy, 'mr'); im.hline(16, 24, 28 + dy, 'mr_d')
    # 頭髮：整個後腦都是頭髮
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')
    for y in range(13 + dy, 24 + dy):
        im.hline(9, 30, y, 'h')
    im.hline(13, 26, 24 + dy, 'h'); im.hline(15, 24, 25 + dy, 'h'); im.hline(17, 22, 26 + dy, 'h')          # 後頸的髮根
    for x0, sgn in ((9, -1), (31, 1)):
        for i in range(1, 5):
            im.hline(min(x0, x0 + sgn * i), max(x0, x0 + sgn * i), 16 + dy + (0 if i < 3 else 1), 'h')
    # 護目鏡的皮帶繞過後腦（正中央有個扣環）
    im.rect(10, 10 + dy, 29, 11 + dy, 'gf_d'); im.rect(19, 10 + dy, 20, 11 + dy, 'gf')
    # 高馬尾：背面看得到整條——圓圓的馬尾根在頭頂，髮尾垂在背後到肩胛骨
    im.ellipse(CX, .5 + dy, 5.2, 3.0, 'h')
    for y in range(2, 31):
        w_ = 6 if y < 14 else 5 if y < 22 else 4 if y < 27 else 3
        a = 20 - w_ // 2
        im.hline(a, a + w_ - 1, y + dy, 'h')
        im.set(a, y + dy, 'h_d'); im.set(a + w_ - 1, y + dy, 'h_d')
    shade_hair(im, dy)
    for y in range(3 + dy, 26 + dy):                                                                        # 馬尾上的藍色反光
        if y % 4:
            im.set(18, y, 'h_b')
    for (x, y) in ((16, -1), (17, -2), (18, -2)):
        im.set(x, y + dy, 'h_b')
    return im


# ================= 側面（臉朝左）=================
def draw_side(step=0):
    im = ShiftImg(W, H, TOP)
    dy = -1 if step else 0
    sh = {0: (0, 0), 1: (-2, 2), 2: (2, -2)}[step]                 # (前腳, 後腳) 的水平位移
    # 腳：後腳（暗一點）先畫，前腳再蓋上去；腳尖往左
    for sx, back in ((sh[1], True), (sh[0], False)):
        xa = 18 + sx                                                  # 腳放在身體正下方（身體中心在第 20 格；使用者說原本偏左）
        col = 'br_d' if back else 'br'
        im.rect(xa + 1, 41, xa + 3, 43, 'pr')
        im.rect(xa + 1, 44, xa + 4, 49, col); im.rect(xa, 47, xa, 49, col)
        im.hline(xa, xa + 4, 50, 'br_d')
        if not back:
            im.hline(xa + 1, xa + 4, 44, 'br_l')
    # 圍裙下擺
    for y in range(39, 43):
        a, b = trap_side(y)
        im.hline(a, b, y + dy, 'cr'); im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    a42, b42 = trap_side(42)
    im.hline(a42, b42, 42 + dy, 'cr_d'); im.hline(a42, b42, 43 + dy, 'mr'); im.hline(a42, b42, 44 + dy, 'mr_d')
    # 圍裙上身（側面）
    for y in range(28, 39):
        a, b = trap_side(y)
        im.hline(a, b, y + dy, 'cr')
        if y >= 31:
            im.set(a, y + dy, 'cr_d'); im.set(b, y + dy, 'cr_d')
    for y in range(28, 35):                                                                              # 肩帶（從肩膀往下，靠背側）
        im.hline(21, 22, y + dy, 'br'); im.set(21, y + dy, 'br_d')
    a35, b35 = trap_side(35)
    im.hline(a35, b35, 35 + dy, 'br'); im.hline(a35, b35, 36 + dy, 'br_d')
    im.rect(16, 37 + dy, 17, 38 + dy, 'gem'); im.set(16, 37 + dy, 'ew')                                   # 前面的綠寶石
    # 領口圍巾與脖子
    im.rect(19, 27 + dy, 20, 27 + dy, 'sk_d')
    im.rect(17, 27 + dy, 24, 28 + dy, 'mr'); im.hline(17, 24, 28 + dy, 'mr_d')
    # 靠近我們的那隻手臂：往前（左）微微斜下
    for y in range(28, 38):
        L = int(19 - (y - 28) * .25)
        im.hline(L, L + 4, y + dy, 'mr'); im.set(L, y + dy, 'mr_d')
        if 31 <= y <= 34:
            im.set(L + 2, y + dy, 'mr_l')
    im.rect(16, 38 + dy, 18, 39 + dy, 'sk')
    # 頭髮：後腦＋頭側
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')
    for y in range(13 + dy, 25 + dy):
        im.hline(22, 30, y, 'h')
    # 高馬尾：頂在頭頂靠後，髮尾往後垂在頭後面（使用者說髮尾在頭後面）
    im.ellipse(CX + 3, .5 + dy, 4.8, 3.0, 'h')
    for y in range(2, 27):
        c = 26 + int(y * .25)
        w_ = 5 if y < 10 else 4 if y < 18 else 3
        a = c - w_ // 2
        im.hline(a, a + w_ - 1, y + dy, 'h'); im.set(a + w_ - 1, y + dy, 'h_d')
    # 臉（朝左）
    face = {13: (16, 19), 14: (15, 20), 15: (14, 21), 16: (13, 21), 23: (13, 21), 24: (14, 21), 25: (15, 21), 26: (17, 20)}
    for y in range(17, 23):
        face[y] = (12, 21)
    for y, (a, b) in face.items():
        im.hline(a, b, y + dy, 'sk')
    # 眼睛：只有一隻（眼白在後面、眼珠看前面）＋眉毛
    ex = 14
    im.hline(ex + 1, ex + 3, 18 + dy, 'la'); im.hline(ex, ex + 2, 19 + dy, 'la')
    for k, (r1, r2) in enumerate((('ir', 'ir'), ('pu', 'ir_l'), ('ir', 'ir_l'), ('lb', 'ew'))):
        im.set(ex + k, 20 + dy, r1); im.set(ex + k, 21 + dy, r2)
    im.set(ex + 3, 19 + dy, 'ew')
    for (bx, by) in ((14, 17), (15, 16), (16, 16), (17, 16), (18, 17)):                                           # 眉毛往後腦方向多 1 格、再多 1 格往下（使用者要求）
        im.set(bx, by + dy, 'brow')
    im.hline(15, 19, 22 + dy, 'bl'); im.hline(17, 19, 23 + dy, 'bl'); im.hline(14, 15, 24 + dy, 'mo')       # 腮紅：貼著髮束的那邊寬、往前變細，往後退一格；嘴巴比腮紅低一格（使用者要求）
    # 瀏海蓋住額頭（往前垂），臉旁一搓髮束
    for y in range(13 + dy, 17 + dy):
        a, b = face.get(y - dy, (16, 19))
        for x in range(11, a):
            im.set(x, y, 'h')
    for y in range(13, 27):
        w_ = 3 if y <= 21 else 2 if y <= 24 else 1
        im.hline(19, 19 + w_ - 1, y + dy, 'h')                                                           # 髮束往眼睛（前）方向移了一格（使用者要求）
    # 護目鏡（側面只看得到一顆鏡片的邊，皮帶往後繞）
    im.rect(10, 8 + dy, 14, 13 + dy, 'gf'); im.rect(11, 9 + dy, 13, 12 + dy, 'ln')
    im.rect(11, 11 + dy, 13, 12 + dy, 'ln_d'); im.hline(11, 12, 9 + dy, 'ln_h')
    im.hline(15, 30, 10 + dy, 'gf_d'); im.hline(15, 30, 11 + dy, 'gf_d')
    shade_hair(im, dy)
    for y in range(14 + dy, 25 + dy):
        im.set(20, y, 'h_b') if y % 3 else im.set(20, y, 'h_p')
    for y in range(4 + dy, 22 + dy):
        if y % 3:
            im.set(26 + int(y * .25) - 1, y, 'h_b')
    return im


DIRS = ['down', 'right', 'up', 'left']


def build_frame(direction='down', step=0):
    src = {'down': draw_front, 'up': draw_back, 'left': draw_side, 'right': draw_side}[direction](step)
    im = Img(W, H + TOP)
    im.px = src.px
    if direction == 'right':
        im = cp.mirror(im)
    outline_fixed(im, cp.P['ol'])
    sh = Img(W, H + TOP)
    sh.ellipse(CX, 50 + TOP, 10, 2.6, cp.SHADOW)
    for y in range(H + TOP):
        for x in range(W):
            if im.px[y][x] is None and sh.px[y][x] is not None:
                im.px[y][x] = sh.px[y][x]
    return im


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out, exist_ok=True)
    FH = H + TOP
    sheet = Img(W * 3, FH * 4)
    for r, d in enumerate(DIRS):
        for st in range(3):
            blit(sheet, build_frame(d, st), st * W, r * FH)
    write_png(os.path.join(out, 'chibi2_sheet.png'), sheet)
    prev = Img(W * 4 + 5 * 4, FH + 8)                           # 4 個方向的待機格並排
    for i, d in enumerate(DIRS):
        blit(prev, build_frame(d, 0), 4 + i * (W + 4), 4)
    write_png(os.path.join(out, 'chibi2_preview.png'), prev, 6, bg=(255, 255, 255))
    walk = Img(W * 3 + 4 * 4, (FH + 4) * 4 + 4)                 # 4 個方向 × 3 格
    for r, d in enumerate(DIRS):
        for st in range(3):
            blit(walk, build_frame(d, st), 4 + st * (W + 4), 4 + r * (FH + 4))
    write_png(os.path.join(out, 'chibi2_walk_preview.png'), walk, 4, bg=(255, 255, 255))
    print('ok', out)


if __name__ == '__main__':
    main()
