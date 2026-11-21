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
    'gem': (24, 200, 88),
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


def draw_front(step=0):
    im = Img(W, H)
    dy = -1 if step else 0
    lift_l, lift_r = (1 if step == 1 else 0), (1 if step == 2 else 0)
    # ---------- 靴子與腿 ----------
    for x0, lift in ((14, lift_l), (21, lift_r)):
        im.rect(x0 + 1, 41 - lift, x0 + 3, 43 - lift, 'pr')                        # 腿（深紫色褲）
        im.rect(x0, 44 - lift, x0 + 4, 49 - lift, 'br')                              # 靴子
        im.rect(x0, 44 - lift, x0 + 4, 44 - lift, 'br_l')
        im.rect(x0, 49 - lift, x0 + 5, 50 - lift, 'br_d')                            # 鞋底
        im.vline = None
        for y in range(44, 49):
            im.set(x0 + 4, y - lift, 'br_d')
    # ---------- 圍裙下擺與褲子 ----------
    im.rect(14, 38 + dy, 26, 42 + dy, 'cr')
    im.hline(14, 26, 42 + dy, 'cr_d'); im.hline(15, 25, 41 + dy, 'cr_d')
    im.rect(14, 43 + dy, 26, 43 + dy, 'mr'); im.hline(14, 26, 44 + dy, 'mr_d')
    # ---------- 手臂（酒紅袖子）----------
    for sx, hx in ((1, 27), (-1, 9)):
        pass
    for x0, hx in ((8, 8), (27, 28)):                                                # 左手、右手
        im.rect(x0, 29 + dy, x0 + 4, 37 + dy, 'mr')
        im.rect(x0 + (0 if x0 < 15 else 4), 29 + dy, x0 + (0 if x0 < 15 else 4), 37 + dy, 'mr_d')
        im.rect(x0 + 1, 30 + dy, x0 + 1, 34 + dy, 'mr_l') if x0 < 15 else im.rect(x0 + 3, 30 + dy, x0 + 3, 34 + dy, 'mr_l')
        im.rect(hx, 38 + dy, hx + 2, 39 + dy, 'sk')                                  # 手
    # ---------- 上身：圍裙、肩帶、皮帶 ----------
    im.rect(15, 28 + dy, 25, 38 + dy, 'cr')
    im.rect(15, 30 + dy, 17, 30 + dy, 'cr_d'); im.rect(23, 30 + dy, 25, 30 + dy, 'cr_d')
    for y in range(31 + dy, 37 + dy):                                              # 圍裙兩側的陰影
        im.set(15, y, 'cr_d'); im.set(25, y, 'cr_d')
    im.rect(15, 28 + dy, 16, 34 + dy, 'br'); im.rect(24, 28 + dy, 25, 34 + dy, 'br')   # 肩帶
    im.rect(15, 28 + dy, 15, 34 + dy, 'br_d'); im.rect(25, 28 + dy, 25, 34 + dy, 'br_d')
    im.rect(14, 35 + dy, 26, 36 + dy, 'br'); im.hline(14, 26, 36 + dy, 'br_d')       # 皮帶
    im.rect(19, 35 + dy, 21, 36 + dy, 'br_l')                                          # 皮帶扣
    im.rect(23, 37 + dy, 24, 38 + dy, 'gem'); im.set(23, 37 + dy, 'ew')               # 綠色小寶石
    im.hline(18, 22, 31 + dy, 'cr_d'); im.hline(17, 23, 33 + dy, 'cr_d')              # 圍裙的皺褶
    # ---------- 領口酒紅色圍巾與脖子 ----------
    im.rect(18, 27 + dy, 21, 27 + dy, 'sk_d')
    im.rect(16, 27 + dy, 24, 28 + dy, 'mr'); im.hline(16, 24, 28 + dy, 'mr_d'); im.hline(17, 19, 27 + dy, 'mr_l')
    # ---------- 後面的頭髮 ----------
    im.rect(10, 14 + dy, 30, 29 + dy, 'h')                                            # 頭髮在身體後面墊一整塊，脖子兩側才不會露出背景
    im.ellipse(CX, 11 + dy, 11.6, 9.6, 'h')                                           # 頭頂圓弧
    im.ellipse(19, 4 + dy, 3.6, 3.0, 'h')                                             # 頭頂的小髮髻
    for y in range(14 + dy, 29 + dy):                                                 # 兩側垂下的髮束
        w = 5 if y < 24 + dy else 4
        im.hline(9, 9 + w - 1, y, 'h'); im.hline(31 - w + 1, 31, y, 'h')
    for x0, sgn in ((9, -1), (31, 1)):                                                # 兩側往外翹的髮尖
        for i in range(1, 5):
            im.hline(min(x0, x0 + sgn * i), max(x0, x0 + sgn * i), 16 + dy + (0 if i < 3 else 1), 'h')
    # ---------- 臉（上窄下寬再收下巴）----------
    face = {13: (18, 21), 14: (17, 22), 15: (16, 23), 16: (15, 24)}
    for y in range(17, 24):
        face[y] = (14, 25)
    face.update({24: (15, 24), 25: (16, 23), 26: (18, 21)})
    for y, (a, b) in face.items():
        im.hline(a, b, y + dy, 'sk')
    # ---------- 眼睛（4 格寬：外側眼白、淺藍上緣、金色眼珠、深色睫毛）----------
    for ex, flip in ((14, False), (22, True)):
        xs = [ex + i for i in range(4)]
        if flip:
            xs = xs[::-1]                                                            # 讓外側永遠是第 0 個
        im.hline(ex, ex + 3, 19 + dy, 'la')
        row1 = ['lb', 'ir', 'pu', 'ir']
        row2 = ['ew', 'ir_l', 'ir_l', 'ir']
        for k, x in enumerate(xs):
            im.set(x, 20 + dy, row1[k]); im.set(x, 21 + dy, row2[k])
    im.hline(13, 15, 22 + dy, 'bl'); im.hline(24, 26, 22 + dy, 'bl')                  # 腮紅
    im.hline(13, 14, 23 + dy, 'bl'); im.hline(25, 26, 23 + dy, 'bl')
    im.set(19, 24 + dy, 'mo'); im.set(20, 24 + dy, 'bl')                              # 小嘴
    # ---------- 瀏海：臉的兩側（V 字形）----------
    for y in range(13 + dy, 24 + dy):
        a, b = face.get(y - dy, (18, 21))
        for x in range(11, a):
            im.set(x, y, 'h')
        for x in range(b + 1, 30):
            im.set(x, y, 'h')
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
    for y in range(3 + dy, 29 + dy):
        for x in range(8, 33):
            if im.get(x, y) == cp.P['h']:
                if cp.strand(x, y):
                    im.set(x, y, 'h_m' if (x + y) % 2 else 'h_d')
    for y in range(15 + dy, 27 + dy):                                                  # 臉旁髮束內側的藍紫色反光
        im.set(12, y, 'h_b') if y % 3 else im.set(12, y, 'h_p')
        im.set(28, y, 'h_b') if y % 3 else im.set(28, y, 'h_p')
    im.rect(17, 2 + dy, 19, 3 + dy, 'h_b'); im.rect(11, 8 + dy, 12, 9 + dy, 'h_b')
    return im


def build_frame(step=0):
    im = draw_front(step)
    outline_fixed(im, cp.P['ol'])
    sh = Img(W, H)
    sh.ellipse(CX, 50, 10, 2.6, cp.SHADOW)
    for y in range(H):
        for x in range(W):
            if im.px[y][x] is None and sh.px[y][x] is not None:
                im.px[y][x] = sh.px[y][x]
    return im


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out, exist_ok=True)
    prev = Img(W * 3 + 4 * 4, H + 8)
    for s in range(3):
        blit(prev, build_frame(s), 4 + s * (W + 4), 4)
    write_png(os.path.join(out, 'chibi2_preview.png'), prev, 8, bg=(255, 255, 255))
    face = Img(34, 24)
    f = build_frame(0)
    for y in range(24):
        for x in range(34):
            face.px[y][x] = f.px[y + 1][x + 3]
    write_png(os.path.join(out, 'chibi2_face.png'), face, 16, bg=(255, 255, 255))
    print('ok', out)


if __name__ == '__main__':
    main()
