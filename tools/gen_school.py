#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「新人類」分層 sheet 產生器（2026-11-22，使用者定案：先定義為新的人類種族，之後再加其他種族與動作）。

角色（藍髮、黑色女式西裝外套＋襯衫＋西裝短裙）是照使用者給的參考圖逐格量出座標、用規則重畫（正面／側面／背面）：
  - 正面：`ref_girl()` 畫待機，`girl_walk()` 由待機的分層圖產生左右腳抬起的走路格；
  - 側面（臉朝左，朝右＝鏡射）：`girl_side(step)`（逐排照參考圖；step 0＝兩腳併攏的過渡格、1／2＝兩個大步）；
  - 背面：`girl_back(step)`，由參考圖 1:1 還原（`BACK_MAPS`）再分層。
每格 28×62，分 body／bottom／shoes／top／hairbg／face／hair／hat 圖層（跟 gen_chibi、引擎的疊法一致；hairbg、hat 目前是空的）。
**外框已經畫在每層的輪廓內側**（邊緣一格＝顏色×0.52），所以引擎不要再統一畫一圈（race 的 own.outline 留空）。
輸出：`build_sheets()` 回傳 {圖層: Img(832×1856)}，跟 LPC 同格式（64×64 一格；只填走路列 8～11＝上／左／下／右，
欄 0＝待機、1／3／5／7＝走路，其餘欄照 WALK_FRAMES 複製），由 `gen_assets.py` 存成 `human2_<圖層>.png`；
`dye_rules(sheets)` 依實際用到的顏色（含外框變暗的色）產生引擎 `own.dye` 要的換色規則。
用法：python tools/gen_school.py [輸出資料夾]（輸出每層一張 3 排×3 格的預覽與 girl_dye.json，除錯用）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img, write_png

W, H = 32, 62   # 角色本體 32×62；貼進 64×64 的格子（置中）
C = {
    'hair': (140, 92, 58), 'hair_l': (192, 140, 94), 'hair_d': (100, 62, 42), 'hair_dd': (74, 44, 32),
    'skin': (250, 216, 190), 'skin_d': (228, 172, 142), 'blush': (240, 164, 152),
    'eye': (58, 34, 30), 'eye_l': (255, 255, 255), 'e0': (34, 20, 26), 'e1': (58, 36, 40), 'e2': (74, 48, 62), 'e3': (128, 96, 120), 'e4': (246, 240, 246), 'mouth': (190, 96, 90),
    'white': (244, 246, 250), 'white_d': (196, 206, 224),
    'blue': (74, 108, 176), 'blue_d': (52, 76, 132), 'blue_l': (110, 146, 212), 'ribbon': (206, 62, 72), 'ribbon_d': (150, 40, 52),
    'hn': (34, 40, 70), 'hd': (60, 74, 124), 'hm': (116, 130, 178), 'hl': (132, 148, 192), 'hh': (200, 212, 248),
    'sk': (255, 232, 210), 'sk_d': (222, 178, 160), 'chin': (150, 100, 82),
    'k': (60, 52, 52), 'k_l': (78, 70, 70), 'k_d': (34, 28, 28), 'shirt': (214, 200, 202), 'shirt_d': (170, 156, 160), 'shoe_k': (46, 32, 30), 'shoe_kl': (92, 84, 88),
    'hs': (100, 114, 162), 'fb': (143, 117, 106), 'fk': (179, 152, 148), 'fc': (116, 74, 60), 'hv': (140, 122, 172), 'eg1': (85, 82, 100), 'eg2': (120, 119, 128), 'eg3': (74, 66, 66), 'eg4': (56, 46, 47), 'hp': (240, 226, 236), 'sdk': (58, 25, 15),
    'ol': (0, 0, 0), 'ho': (0xb6, 0xa2, 0x99), 'hand': (0xf8, 0xe1, 0xdb),
    'ci': (236, 160, 172),
    'sock': (240, 242, 248), 'sock_d': (198, 204, 220), 'shoe': (100, 66, 50), 'shoe_l': (140, 98, 74),
}


class I(Img):
    def set(self, x, y, c):
        super().set(x, y, C[c] if isinstance(c, str) else c)

    def hline(self, x0, x1, y, c):
        for x in range(x0, x1 + 1):
            self.set(x, y, c)

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            self.hline(x0, x1, y, c)

    def ellipse(self, cx, cy, rx, ry, c, clip=None):
        for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
            for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
                if ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1 and (clip is None or clip(x, y)):
                    self.set(x, y, c)


LAYERS = ['body', 'bottom', 'shoes', 'top', 'hairbg', 'face', 'hair', 'hat']   # 由下到上（跟 gen_chibi 的疊法一樣）


class LI(I):
    """分層畫布：每次 set 寫進目前的圖層；compose() 依 LAYERS 順序疊成 px。"""

    def __init__(self, w, h):
        super().__init__(w, h)
        self.layers = {n: Img(w, h) for n in LAYERS}
        self.layer = 'body'

    def set(self, x, y, c):
        self.layers[self.layer].set(x, y, C[c] if isinstance(c, str) else c)

    def erase(self, layer, x, y):
        self.layers[layer].px[y][x] = None

    def compose(self):
        self.px = [[None] * self.w for _ in range(self.h)]
        for n in LAYERS:
            for y in range(self.h):
                for x in range(self.w):
                    c = self.layers[n].px[y][x]
                    if c is not None:
                        self.px[y][x] = c


def layered_outline(im, skin_edge=False):
    """外框畫在輪廓裡面（邊緣格子顏色×0.52），逐層烤進去；邊緣以「疊起來的整體輪廓」判斷。"""
    im.compose()
    edge = set()
    for y in range(im.h):
        for x in range(im.w):
            if im.px[y][x] is None:
                continue
            for xx, yy in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if not (0 <= xx < im.w and 0 <= yy < im.h) or im.px[yy][xx] is None:
                    edge.add((x, y)); break
    for n in LAYERS:
        for x, y in edge:
            c = im.layers[n].px[y][x]
            if c is not None:
                if c[:3] in (C['ol'], C['ho'], C['hand']):
                    continue
                if skin_edge and c[:3] == C['sk']:
                    # 腿（y>=50）：只有前後兩側的輪廓用皮膚陰影色，上下邊緣（接裙子、接鞋）不變暗，中間整條填滿皮膚色
                    side = y >= 50 and (im.px[y][x - 1] is None or im.px[y][x + 1] is None or im.px[y - 1][x] is None) if 0 < x < im.w - 1 else True   # 前後兩側、以及露在裙子外面的頂端
                    im.layers[n].px[y][x] = C['sk_d'] if (y < 50 or side) else c
                else:
                    im.layers[n].px[y][x] = tuple(int(v * 0.52) for v in c[:3])
    im.compose()


def ref_girl():
    """照使用者給的參考圖（藍髮、黑西裝外套的女生，28×62）逐排量出的座標，用規則重畫（第 2 版）。"""
    im = LI(28, 62)
    im.layer = 'hair'
    # --- 頭髮：照原圖量出的色塊配置（左半 0～13 欄，右半左右鏡射）。
    #     n 最深外框、d 深藍、m 中藍、l 偏亮、h 亮帶（淡藍白）、s 邊緣偏暗 ---
    HAIR_L = {
        1: '..........nnnn', 2: '........dddssn', 3: '......nnlmssnn', 4: '.....nmlmdnnmd',
        5: '....smmmdllmmd', 6: '...smmllmmmlld', 7: '...smmmlmllmll', 8: '..nmmmmmmmllmm',
        9: '..nmlhhmmmmmlm', 10: '.nmmmhhdhhmmhh', 11: '.nmmmlldhhlmhh', 12: '.nmmmmdlmmlmmm',
        13: '.nmmlldmlmllmm', 14: '.nmmlmdmmlmdmm', 15: '.nmmldmllmmdmm', 16: '.nmmmdlmmm',
        17: '.nmmmdmlmn', 18: '.nmmmd', 19: '.nmmmd', 20: '.nmmmd', 21: '.dsmmd', 22: '..nmld', 23: '..nsmd',
    }
    HKEY = {'n': 'hn', 'd': 'hd', 'm': 'hm', 'l': 'hl', 'h': 'hh', 's': 'hs'}
    for y, row in HAIR_L.items():
        for x, ch in enumerate(row):
            if ch in HKEY:
                im.set(x, y, HKEY[ch]); im.set(27 - x, y, HKEY[ch])
    # 外側髮絲：從臉的兩旁朝外下方的斜線（每往下 3 排往外 1 欄），深／亮／中三色輪替
    for y in range(8, 24):
        for x in range(2, 10):
            if HAIR_L[y][x:x + 1] in ('m', 'l', 'd') and x < len(HAIR_L[y]):
                u = (x + (y - 8) // 3) % 6
                c = 'hd' if u == 0 else ('hl' if u in (2, 3) else 'hm')
                im.set(x, y, c); im.set(27 - x, y, c)
    # 髮尾：兩側髮束最靠近臉的那欄最長，往外逐欄變短，下緣形成一道弧（欄 → 最後一排）
    BOTTOM = {1: 21, 2: 23, 3: 24, 4: 25, 5: 26, 6: 26}
    for x, yb in BOTTOM.items():
        for y in range(22, 27):
            for xx in (x, 27 - x):
                if y <= yb:
                    if im.layers['hair'].px[y][xx] is None:
                        im.set(xx, y, 'hs' if x <= 3 else ('hd' if x == 6 else ('hl' if (x + y) % 2 else 'hm')))
                else:
                    im.erase('hair', xx, y)
    im.set(6, 23, 'hd'); im.set(21, 23, 'hd')
    # --- 臉：額頭完全被瀏海蓋住（y16～17 是瀏海髮絲：中間淡紫、兩邊深色、髮尖淺色），皮膚從 y18 才開始 ---
    for y in (16, 17):                          # 瀏海兩側（蓋住額頭）：中藍，帶一點深色髮絲
        im.hline(10, 17, y, 'hm')
        im.set(10 if y == 16 else 11, y, 'hd'); im.set(17 if y == 16 else 16, y, 'hd')
    im.set(10, 17, 'hm'); im.set(17, 17, 'hm')                  # 原本是淺白髮尖（看起來像白點），改成頭髮色
    # 尖瀏海：中央一撮往下的三角（外側深色、裡面淡紫），尖端到 y18，比兩側長
    for y, (x0, x1) in {16: (11, 16), 17: (12, 15)}.items():
        im.hline(x0, x1, y, 'hv'); im.set(x0, y, 'hd'); im.set(x1, y, 'hd')
    im.layer = 'body'                           # 頭部皮膚、脖子、手、腿
    for y in range(18, 24):
        im.hline(7, 20, y, 'sk')
    im.hline(8, 19, 24, 'sk'); im.hline(10, 17, 25, 'sk')
    # 臉頰外側：最外一欄深棕（髮絲陰影）、再內一欄粉灰（臉頰）
    for y in range(19, 23):
        im.layer = 'hair'; im.set(6, y, 'sdk'); im.set(21, y, 'sdk')     # 貼著臉頰的深棕髮絲屬於頭髮層
        im.layer = 'body'; im.set(7, y, 'fk'); im.set(20, y, 'fk')
    for x, y in ((7, 23), (8, 24), (9, 25), (10, 25), (8, 23), (9, 24), (11, 25)):   # 下頜線：外側棕、內側粉灰
        c = 'fc' if (x, y) in ((7, 23), (8, 24), (9, 25), (10, 25)) else 'fk'
        im.set(x, y, c); im.set(27 - x, y, c)
    im.hline(11, 16, 26, 'fc')                  # 下巴
    im.hline(12, 15, 26, 'fc')
    # 眼睛：睫毛排 3 格黑，下面 2 欄 × 4 排的灰色眼珠，外側一欄淡粉灰（含一格偏白的高光）
    def eye_ref(sym_):
        px_ = {  # (dx, y): 顏色；dx 以左眼為準，8～11 欄
            (8, 18): 'e0', (9, 18): 'e0', (10, 18): 'e0',
            (8, 19): 'fk', (9, 19): 'e0', (10, 19): 'e1',
            (8, 20): 'shirt', (9, 20): 'eg1', (10, 20): 'eg2',
            (9, 21): 'eg3', (10, 21): 'eg2',
            (9, 22): 'eg4', (10, 22): 'eg3',
        }
        for (x, y), c in px_.items():
            im.set(x, y, c); im.set(27 - x, y, c)
    im.layer = 'face'
    eye_ref(None)
    # --- 脖子：很短，左右是白襯衫領 ---
    def tset(x, y, c):                                          # 脖子那兩排：外套／襯衫的顏色進上衣層，皮膚進身體層
        im.layer = 'top' if c in ('k_d', 'k', 'shirt') else 'body'
        im.set(x, y, c)
    for x, c in zip(range(9, 19), ('k_d', 'fk', 'shirt', 'fk', 'fc', 'fc', 'fk', 'shirt', 'fk', 'k_d')):
        tset(x, 27, c)                                       # 脖子根（y27 寬 10）
    for x, c in zip(range(8, 20), ('k_d', 'k', 'shirt', 'sk', 'sk', 'sk', 'sk', 'sk', 'sk', 'shirt', 'k', 'k_d')):
        tset(x, 28, c)                                       # y28 寬 12：肩線從這裡開始斜出，跟 y29 的 14 銜接成一道弧
    # --- 外套：肩線斜出，袖子垂到 y39，下襬到 y43 ---
    im.layer = 'top'
    sh = {29: (7, 20), 30: (7, 20), 31: (6, 21), 32: (6, 21), 33: (5, 22), 34: (5, 22), 35: (5, 22), 36: (4, 23), 37: (4, 23), 38: (3, 24), 39: (3, 24)}
    for y, (a, b) in sh.items():
        for x in range(a, b + 1):
            im.set(x, y, 'k_l' if (x * 3 + y * 5) % 7 == 0 else 'k')
    for y in range(40, 44):
        im.hline(6, 21, y, 'k')
    # 外套前襟 V 形開口（y30～37），裡面是白襯衫；左右對稱，鏡射用 27-x
    def sym(x, y, c):
        im.set(x, y, c); im.set(27 - x, y, c)
    for y in range(30, 38):
        a = 12 if y < 34 else 13                                                # V 形：上寬下窄
        for x in range(a, 14):
            sym(x, y, 'shirt' if y < 36 else 'shirt_d')
    for y in range(33, 38):                                                    # 襯衫門襟線
        sym(13, y, 'shirt_d')
    for y, x0, x1 in ((29, 9, 11), (30, 10, 12), (31, 11, 12)):                # 襯衫領子（領尖壓在翻領上）
        for x in range(x0, x1 + 1):
            sym(x, y, 'shirt')
    for y, x in ((29, 12), (30, 13), (31, 13)):
        sym(x, y, 'shirt_d')
    lap = {30: (8, 10), 31: (8, 10), 32: (8, 11), 33: (9, 11), 34: (10, 11), 35: (10, 11), 36: (11, 12), 37: (11, 12)}
    for y, (x0, x1) in lap.items():                                            # 戧駁領：外緣暗線、內緣亮邊
        for x in range(x0, x1 + 1):
            sym(x, y, 'k')
        sym(x0, y, 'k_d'); sym(x1, y, 'k_l')
    sym(8, 32, 'k'); sym(9, 32, 'k_d')                                         # 缺口
    for y in range(34, 41):                                                    # 公主線
        sym(9 if y > 36 else 10, y, 'k_d')
    for y in range(38, 44):                                                    # 腰身收一點＋前襟重疊線
        sym(6, y, 'k_d')
    for y in range(38, 44):
        im.set(14, y, 'k_d')
    im.hline(8, 11, 41, 'k_d'); im.hline(16, 19, 41, 'k_d'); im.hline(8, 11, 42, 'k_l'); im.hline(16, 19, 42, 'k_l')   # 口袋蓋
    im.hline(6, 21, 43, 'k_d')                                                 # 下襬
    for y in range(32, 40):                                                    # 袖子與身體分界
        im.set(8, y, 'k_d') if y > 32 else None; im.set(19, y, 'k_d') if y > 32 else None
    for y in (30, 31):
        im.set(7, y, 'k_l'); im.set(20, y, 'k_l')                              # 肩線亮
    im.rect(3, 38, 5, 39, 'k_d'); im.rect(22, 38, 24, 39, 'k_d')              # 袖口暗
    im.set(13, 39, 'shoe_kl'); im.set(13, 42, 'shoe_kl')                       # 釦子（兩顆）
    im.layer = 'body'
    for sx in (3, 22):                                                         # 手：3 格寬 3 排高，棕色外框
        im.rect(sx, 40, sx + 2, 42, 'sk')
        ox = sx - 1 if sx == 3 else sx + 3          # 手比袖口再往外一格：外側棕框
        for y in (40, 41, 42):
            im.set(ox, y, 'fb')
        bx = sx + 3 if sx == 3 else sx - 1
        im.erase('top', bx, 41)                          # 手掌內側微凸：這一格原本是外套下襬，讓出來給身體層
        im.set(bx, 41, 'sk')
        im.hline(sx, sx + 2, 43, 'fb')
    # --- 裙子 ---
    im.layer = 'bottom'
    for y in range(44, 50):
        for x in range(7, 21):
            im.set(x, y, 'k_l' if (x * 5 + y * 3) % 9 == 0 else 'k')
        im.set(7, y, 'k_d'); im.set(20, y, 'k_d')
    for y in range(45, 49):                                                    # 套裝短裙：中線縫、兩側腰褶、下襬
        im.set(13, y, 'k_d')
    for y in (44, 45, 46):
        im.set(10, y, 'k_d'); im.set(17, y, 'k_d')
    # 裙擺是往下的圓弧：兩側短、中間長，最下面一排是裙底陰影
    for x in list(range(7, 9)) + list(range(19, 21)):
        im.erase('bottom', x, 49)
    im.hline(9, 18, 50, 'sdk')
    im.set(9, 50, 'fb'); im.set(18, 50, 'fb')
    im.layer = 'body'
    # --- 腿：每隻 3 格寬，外側棕框，中間棕縫；兩隻鞋連成一塊 ---
    for y in range(51, 57):
        im.hline(10, 12, y, 'sk'); im.hline(15, 17, y, 'sk')
        im.set(9, y, 'fb'); im.set(18, y, 'fb')
        im.hline(13, 14, y, 'fc')
    for y in (51, 53):
        im.set(11, y, 'fk'); im.set(16, y, 'fk')
    im.layer = 'shoes'
    im.hline(8, 19, 57, 'shoe_k')
    for y in (58, 59):
        im.hline(7, 20, y, 'shoe_k')
    im.hline(7, 12, 60, 'shoe_k'); im.hline(15, 20, 60, 'shoe_k')
    for x in list(range(8, 12)) + list(range(16, 20)):
        im.set(x, 58, 'shoe_kl')
    layered_outline(im)
    return im


def merge_img(*imgs):
    o = Img(imgs[0].w, imgs[0].h)
    for im in imgs:
        for y in range(o.h):
            for x in range(o.w):
                if im.px[y][x] is not None:
                    o.px[y][x] = im.px[y][x]
    return o


def split_img(img, pred):
    """把圖層分成兩張：符合 pred(x, y) 的格子、不符合的格子。"""
    yes = Img(img.w, img.h); no = Img(img.w, img.h)
    for y in range(img.h):
        for x in range(img.w):
            c = img.px[y][x]
            if c is not None:
                (yes if pred(x, y) else no).px[y][x] = c
    return yes, no


def move_img(img, dx, dy):
    o = Img(img.w, img.h)
    for y in range(img.h):
        for x in range(img.w):
            c = img.px[y][x]
            if c is not None and 0 <= x + dx < img.w and 0 <= y + dy < img.h:
                o.px[y + dy][x + dx] = c
    return o


def girl_walk(base, step):
    """由待機的分層圖產生走路格（正面）。step 1＝左腳抬、step 2＝右腳抬。
    規則：整個上半身（頭髮／臉／頭部皮膚／脖子／上衣／裙子）一起上抬 1 格，臉的各層永遠同步，不會錯位；
    抬腳那隻腿連鞋上移 2 格（腿頂被裙子蓋住）；站著那隻腿的頂端補一排接到裙底；
    手隨步伐上下擺（抬左腳→右手往前＝上、左手往後＝下）。"""
    L = {n: base[n] for n in LAYERS}
    if step == 0:
        return L
    lift_left = step == 1
    is_lift_leg = (lambda x: x <= 13) if lift_left else (lambda x: x >= 14)
    out = {}
    for n in ('hair', 'face', 'top', 'bottom', 'hairbg', 'hat'):
        out[n] = move_img(L[n], 0, -1)
    top = out['top']                              # 待機時手掌微凸那格讓給了身體層；手動後補回外套
    for x, nx in ((6, 7), (21, 20)):
        for y in range(39, 43):
            if top.px[y][x] is None and top.px[y][nx] is not None:
                top.px[y][x] = top.px[y][nx]
    body = L['body']
    legs, upper = split_img(body, lambda x, y: y >= 50)
    hand_l, upper = split_img(upper, lambda x, y: 40 <= y <= 43 and x <= 6)
    hand_r, upper = split_img(upper, lambda x, y: 40 <= y <= 43 and x >= 21)
    upper = move_img(upper, 0, -1)                # 頭部皮膚、脖子：跟頭髮／臉一起上抬 1
    hand_l = move_img(hand_l, 0, -1 + (1 if lift_left else -1))    # 抬左腳：左手往後（下）、右手往前（上）
    hand_r = move_img(hand_r, 0, -1 + (-1 if lift_left else 1))
    lift_leg, stay_leg = split_img(legs, lambda x, y: is_lift_leg(x))
    lift_leg = move_img(lift_leg, 0, -2)
    for x in range(body.w):                       # 站著那隻腿：頂端補一排，接到上移後的裙底
        if stay_leg.px[51][x] is not None:
            stay_leg.px[50][x] = stay_leg.px[51][x]
    out['body'] = merge_img(upper, hand_l, hand_r, stay_leg, lift_leg)
    shoes_lift, shoes_stay = split_img(L['shoes'], lambda x, y: is_lift_leg(x))
    out['shoes'] = merge_img(shoes_stay, move_img(shoes_lift, 0, -2))
    return out


def compose_layers(layers, w=28, h=62):
    o = Img(w, h)
    for n in LAYERS:
        for y in range(h):
            for x in range(w):
                c = layers[n].px[y][x]
                if c is not None:
                    o.px[y][x] = c
    return o


def girl_side(step=0):
    """藍髮女生（西裝）側面，臉朝左，28×62，分層。尺寸照使用者給的側面參考圖量（轉成我的座標：欄＝圖上欄－2、排＝圖上排－6）。
    step 0＝雙腳併攏（過渡）、1＝近側腳大步往前（手往後）、2＝近側腳往後（手往前）。走路格整個上半身上抬 1。臉朝右＝整張鏡射。"""
    im = LI(28, 62)
    dyb = -1 if step == 0 else 0                              # 照參考圖：過渡格（腿併攏、身體最高）上抬 1，大步格身體最低
    # ---------- 頭髮：外形照參考圖逐排的左右界；髮球整顆 27 寬，眼睛在臉的後緣、前面是臉頰皮膚 ----------
    im.layer = 'hair'
    edge = {1: (11, 18), 2: (9, 20), 3: (6, 21), 4: (4, 22), 5: (3, 23), 6: (2, 24), 7: (2, 24), 8: (1, 25), 9: (1, 25),
            10: (1, 26), 11: (0, 26), 12: (0, 26), 13: (0, 26), 14: (0, 26), 15: (0, 26), 16: (0, 26), 17: (0, 26)}
    HAIR_L = {   # 頭頂到額頭的色塊：沿用正面（左右鏡射成完整一排，再取側面需要的左右界）
        1: '..........nnnn', 2: '........dddssn', 3: '......nnlmssnn', 4: '.....nmlmdnnmd',
        5: '....smmmdllmmd', 6: '...smmllmmmlld', 7: '...smmmlmllmll', 8: '..nmmmmmmmllmm',
        9: '..nmlhhmmmmmlm', 10: '.nmmmhhdhhmmhh', 11: '.nmmmlldhhlmhh', 12: '.nmmmmdlmmlmmm',
        13: '.nmmlldmlmllmm', 14: '.nmmlmdmmlmdmm', 15: '.nmmldmllmmdmm', 16: '.nmmmdlmmmmmmm',
        17: '.nmmmdmlmnmmmm',
    }
    HKEY = {'n': 'hn', 'd': 'hd', 'm': 'hm', 'l': 'hl', 'h': 'hh', 's': 'hs'}
    for y, (a_, b_) in edge.items():
        full = HAIR_L[y] + HAIR_L[y][::-1]
        for x in range(a_, b_ + 1):
            ch = full[x + 1] if 0 <= x + 1 < len(full) else 'm'
            if ch == '.':
                ch = 'm'
            im.set(x, y, HKEY.get(ch, 'hm'))
    # 前髮束（臉前面）：rows 18～21，cols 1～4，垂在臉頰前
    for y in range(18, 22):
        for x in range(1, 5):
            im.set(x, y, 'hs' if x == 1 else ('hl' if (x + y) % 2 else 'hm'))
    # 後腦髮束：cols 13～26、rows 18 起；下緣到 row 27，最後面往上收成弧
    def back_bottom(x):
        return 27 if x <= 22 else 27 - (x - 22)
    for y in range(18, 28):
        for x in range(13, 27):
            if y > back_bottom(x):
                continue
            u = (x - (y - 8) // 3) % 6
            c = 'hd' if u == 0 else ('hl' if u in (2, 3) else 'hm')
            if x == 13:
                c = 'hd'
            if x >= 25 or y == back_bottom(x):
                c = 'hs'
            im.set(x, y, c)
    # 瀏海尖（蓋在眼睛前上方）
    for x, y in ((5, 18), (6, 18), (7, 18), (8, 18), (9, 18), (6, 19), (7, 19), (8, 19)):
        im.set(x, y, 'hd' if y == 19 else 'hm')
    # ---------- 臉（皮膚在身體層、眼睛在臉層）：臉頰皮膚在前（左），眼睛 3×5 在 cols 10～12 ----------
    im.layer = 'body'
    for y in range(19, 24):
        im.hline(5, 12, y, 'sk')
    im.hline(6, 12, 24, 'sk'); im.hline(7, 12, 25, 'sk')
    for y in range(20, 23):
        im.set(5, y, 'fk')
    for x, y in ((5, 23), (6, 24), (7, 25)):
        im.set(x, y, 'fc')
    im.hline(8, 12, 26, 'fc')
    im.layer = 'face'
    for (x, y), c in {(10, 19): 'e0', (11, 19): 'e0', (12, 19): 'e0',
                      (10, 20): 'e1', (11, 20): 'e0', (12, 20): 'fk',
                      (10, 21): 'eg2', (11, 21): 'eg1', (12, 21): 'shirt',
                      (10, 22): 'eg2', (11, 22): 'eg3',
                      (10, 23): 'eg3', (11, 23): 'eg4'}.items():
        im.set(x, y, c)
    # ---------- 瀏海與臉：照側面頭的 1:1 還原（待機格）重畫，取代上面的前髮束／瀏海尖／臉 ----------
    #   原圖第 15～26 排、第 0～12 欄；我的排＝原圖排＋1。瀏海是往左下斜垂的幾撮尖髮絲，額頭整個蓋住，臉從第 20 排才露出。
    for lay in ('hair', 'body', 'face'):
        for y in range(16, 28):
            for x in range(0, 13):
                im.erase(lay, x, y)
    FRONT = ['59DIMMIF3EFIH', '266MK2GG55KKK', '866F35GM3M3II', '.854414G4P42G', '.952A41G1P000',
             '.92.A1P41P01N', '.8..AJPPPPA7P', '....7JPPPPJ7P', '.....JPPPP41P', '......7PPPPPP',
             '.......7PPPPP', '........NJ7A7']
    DARK = set('01234568 9'.replace(' ', ''))
    EYE = {(10, 19): 'e0', (11, 19): 'e0', (12, 19): 'e0', (10, 20): 'e0', (11, 20): 'e1', (12, 20): 'shirt',
           (10, 21): 'eg3', (11, 21): 'eg3', (10, 22): 'eg2', (11, 22): 'eg3', (10, 23): 'e1', (11, 23): 'e0'}
    for i, row in enumerate(FRONT):
        ry = 15 + i
        y = ry + 1
        for x, ch in enumerate(row):
            if ch == '.':
                continue
            if (x, ry) in EYE:
                im.layer = 'face'; im.set(x, y, EYE[(x, ry)])
            elif ch in 'PN':
                im.layer = 'body'; im.set(x, y, 'sk')
            elif ch == 'J':
                im.layer = 'body'; im.set(x, y, 'fk')
            elif ch in '7A':
                im.layer = 'body'; im.set(x, y, 'fc')
            elif ch in DARK:
                im.layer = 'hair'; im.set(x, y, 'hd')
            elif ch == 'O':
                im.layer = 'hair'; im.set(x, y, 'hh')
            else:
                im.layer = 'hair'; im.set(x, y, 'hm' if ch in 'GIFEHD' else 'hl')
    # ---------- 另一邊的眼睛（2026-11-23 使用者要求；參考素體圖：側臉前緣、貼著輪廓有一小條深色，約 2 欄寬、跟近側眼睛差不多高）----------
    #   座標是上抬前的排（下面整個上半身會一起上抬）；5 排高、2 欄寬，**比近側眼睛高一格**（使用者要求；素體參考圖裡靠外側的眼睛本來就比近側的高），中長髮／蓬蓬短髮的瀏海抬高、前緣露得出來（鮑伯的瀏海蓋住上半）；排 19～23、欄 4～5
    im.layer = 'face'
    # 顏色＝近側眼睛左邊兩欄（EYE 的 x=10、11）的上下漸層：上深（e0／e1）→ 中間灰階（eg3／eg2）→ 下深，所以跟著眼睛顏色（eg*）一起換色
    for (x, y), c in {(4, 19): 'e0', (5, 19): 'e0', (4, 20): 'e0', (5, 20): 'e1', (4, 21): 'eg3', (5, 21): 'eg3', (4, 22): 'eg2', (5, 22): 'eg3', (4, 23): 'e1', (5, 23): 'e0'}.items():
        im.set(x, y, c)
    # ---------- 後腦髮束與髮尾：同樣照 1:1 還原（原圖第 16～27 排、第 13～26 欄；我的排＝原圖排＋1）----------
    #   髮尾下緣大致平，在欄 19、欄 22 各有一撮往下的尖；欄 13～15 有一條很深的髮絲（貼著臉後緣），欄 19 也有一條
    for y in range(17, 30):
        for x in range(13, 27):
            im.erase('hair', x, y)
    BACK = ['IMBLFE5BILII95', 'IIBKIF3CIIIF95', '539KDK3BLLIM65', '256DMF3BHL6EC2', 'N59III3CLECK85',
            'N59FMF56BM9D95', 'N58KFK3C6M9882', 'J19GKK3698985.', 'A48GG3385982..', 'A18G2.59285...',
            '......52.2....', '......2.......']
    for i, row in enumerate(BACK):
        y = 16 + i + 1
        for j, ch in enumerate(row):
            x = 13 + j
            if ch == '.':
                continue
            if x == 13 and ch in 'NJA':                          # 欄 13 有幾格是臉後緣的皮膚
                im.layer = 'body'; im.set(x, y, {'N': 'sk', 'J': 'fk', 'A': 'fc'}[ch])
                continue
            im.layer = 'hair'
            if ch in '01235':
                im.set(x, y, 'hn')
            elif ch in '4689BC':
                im.set(x, y, 'hd')
            elif ch in 'DEFGHIK':
                im.set(x, y, 'hm')
            elif ch in 'LM':
                im.set(x, y, 'hl')
            else:
                im.set(x, y, 'hh')
    # 脖子
    im.layer = 'body'
    for y in (27, 28):
        im.hline(9, 13, y, 'sk')
    im.hline(9, 13, 27, 'fc')
    # ---------- 上衣 ----------
    im.layer = 'top'
    torso = {28: (9, 15), 29: (9, 16), 30: (8, 17)}                # 背部變窄：軀幹 10 格寬（欄 8～17）
    for y in range(31, 44):
        torso[y] = (8, 17)
    for y, (a_, b_) in torso.items():
        for x in range(a_, b_ + 1):
            im.set(x, y, 'k_l' if (x * 3 + y * 5) % 7 == 0 else 'k')
    for y in range(30, 44):
        im.set(torso[y][0], y, 'k_d')                         # 前襟邊（深）
        im.set(torso[y][1], y, 'k_d')                         # 背側邊
    im.hline(9, 12, 28, 'shirt'); im.hline(9, 12, 29, 'shirt'); im.set(8, 30, 'shirt'); im.set(9, 30, 'shirt_d')   # 襯衫領
    im.set(9, 31, 'k_l'); im.set(9, 32, 'k_l'); im.set(10, 33, 'k_l')          # 翻領亮邊
    im.hline(9, 12, 41, 'k_d'); im.hline(9, 12, 42, 'k_l')   # 口袋蓋
    im.set(8, 36, 'shoe_kl'); im.set(8, 39, 'shoe_kl')       # 釦子
    im.hline(8, 17, 43, 'k_d')
    # ---------- 下裝（裙）----------
    im.layer = 'bottom'
    for y in range(44, 52):
        for x in range(7, 19):
            im.set(x, y, 'k_l' if (x * 5 + y * 3) % 9 == 0 else 'k')
        im.set(7, y, 'k_d'); im.set(18, y, 'k_d')
    for y in (45, 46, 47, 48, 49, 50):
        im.set(11, y, 'k_d')
    for x in (7, 18):
        im.erase('bottom', x, 51)
    im.hline(10, 17, 52, 'k')
    im.hline(10, 17, 52, 'k_d')
    # ---------- 整個上半身上抬 ----------
    if dyb:
        for n in LAYERS:
            im.layers[n] = move_img(im.layers[n], 0, dyb)
    # ---------- 手臂（近側）、腿、鞋：依步伐重畫 ----------
    # 手臂：照使用者標好色的參考圖（O＝手臂輪廓 #000000、H＝手的輪廓 #b6a299、S＝手的皮膚 #f8e1db）逐格畫。
    #   座標＝參考圖的欄、排（我的排＝參考排＋1）。手臂是兩條輪廓線夾著外套色，手 4 格寬。
    ARM = {
        1: {29: '.................O', 30: '.................O', 31: '..................O', 32: '..................O',
            33: '.............O.....O', 34: '..............O.....O', 35: '..............O......O', 36: '..............O......O',
            37: '...............O...OOO', 38: '...............OOOOSSH', 39: '...............OOSSSSH',
            40: '................OSSSSH', 41: '................O.SSSH', 42: '.................OHHH'},
        0: {30: '............O', 31: '............O', 32: '............O.....O', 33: '............O.....O',
            34: '............O.....O', 35: '...........O......O', 36: '...........O......O', 37: '...........O......O',
            38: '...........OOOOO..O', 39: '...........OHSSSOO', 40: '...........OHSSSHO', 41: '...........OHHHHO'},
        2: {31: '............O...O', 32: '............O...O', 33: '............O...O', 34: '...........O....O',
            35: '..........OO....O', 36: '..........O.....O', 37: '..........O....O', 38: '.........OOOO..O',
            39: '........OSSSSO.O', 40: '........OHSSSSOO', 41: '........OHSSSHOO', 42: '........OHHHH'},
    }[step]
    arm_cls = {'O': ('top', 'k_d'), 'H': ('body', 'ho'), 'S': ('body', 'hand')}
    for ry, line in ARM.items():
        y = ry + 1
        xs = [x for x, ch in enumerate(line) if ch == 'O']
        if ry < 38 and len(xs) >= 2:                              # 兩條輪廓線之間填外套色（超出軀幹的部分）
            im.layer = 'top'
            for x in range(xs[0] + 1, xs[-1]):
                im.set(x, y, 'k')                                 # 蓋掉被手臂擋住的軀幹背緣線
        for x, ch in enumerate(line):
            if ch in arm_cls:
                layer, col = arm_cls[ch]
                im.layer = layer
                im.set(x, y, col)
                if layer == 'body':
                    im.erase('top', x, y)                         # 手露在外套外面：外套層讓出這一格
    # 腿與鞋：逐排照側面參考圖（藍髮女生）量出的形狀。{參考圖排: [(左欄, 右欄, 種類)]}，sk＝皮膚、sh＝鞋；畫在「參考排＋1」
    A_FRONT = {51: [(8, 9, 'sk')], 52: [(7, 11, 'sk')], 53: [(7, 10, 'sk')], 54: [(6, 10, 'sk'), (1, 3, 'sh')],
               55: [(1, 6, 'sh'), (7, 10, 'sk')], 56: [(1, 7, 'sh'), (8, 10, 'sk')], 57: [(2, 9, 'sh')],
               58: [(6, 9, 'sh')], 59: [(7, 9, 'sh')]}
    A_BACK = {50: [(18, 18, 'sk')], 51: [(17, 19, 'sk')], 52: [(16, 20, 'sk')], 53: [(17, 20, 'sk'), (21, 22, 'sh')],
              54: [(17, 19, 'sk'), (20, 23, 'sh')], 55: [(18, 19, 'sk'), (20, 23, 'sh')], 56: [(18, 23, 'sh')],
              57: [(17, 22, 'sh')], 58: [(16, 20, 'sh')], 59: [(16, 19, 'sh')]}
    B_FRONT = {51: [(7, 9, 'sk')], 52: [(7, 11, 'sk')], 53: [(7, 11, 'sk')], 54: [(6, 10, 'sk'), (1, 3, 'sh')],
               55: [(1, 7, 'sh'), (8, 10, 'sk')], 56: [(1, 9, 'sh'), (10, 10, 'sk')], 57: [(3, 9, 'sh')],
               58: [(6, 9, 'sh')], 59: [(7, 9, 'sh')]}
    B_BACK = {50: [(18, 18, 'sk')], 51: [(17, 19, 'sk')], 52: [(16, 20, 'sk')], 53: [(17, 21, 'sk'), (22, 22, 'sh')],
              54: [(17, 21, 'sk'), (22, 23, 'sh')], 55: [(18, 19, 'sk'), (20, 23, 'sh')], 56: [(18, 23, 'sh')],
              57: [(17, 23, 'sh')], 58: [(16, 20, 'sh')], 59: [(16, 19, 'sh')]}
    PASS = {51: [(11, 15, 'sk')], 52: [(11, 15, 'sk')], 53: [(11, 15, 'sk')], 54: [(11, 15, 'sk')], 55: [(11, 15, 'sk')],
            56: [(8, 11, 'sh'), (12, 15, 'sk'), (16, 16, 'sh')], 57: [(7, 16, 'sh')], 58: [(7, 16, 'sh')], 59: [(7, 16, 'sh')]}
    shapes = [PASS] if step == 0 else ([A_FRONT, A_BACK] if step == 1 else [B_FRONT, B_BACK])
    for shape in shapes:                                      # 每隻腿的最上面一排往上延伸進裙子（裙子層蓋住它），不留縫
        top = min(shape)
        for x0, x1, kind in list(shape[top]):
            x1 = min(x1, 17)                                   # 只延伸到裙子寬度以內（裙子層蓋住），不要從裙邊冒出來
            if x0 > x1:
                continue
            for ry in range(top - 3, top):
                shape.setdefault(ry, []).append((x0, x1, kind))
    for shape in shapes:
        for ry, segs in shape.items():
            for x0, x1, kind in segs:
                im.layer = 'body' if kind == 'sk' else 'shoes'
                im.hline(x0, x1, ry + 1, 'sk' if kind == 'sk' else 'shoe_k')
    im.layer = 'shoes'                                        # 鞋面亮邊
    if step == 0:
        im.hline(8, 11, 58, 'shoe_kl'); im.hline(8, 11, 59, 'shoe_kl')
    else:
        im.hline(3, 4, 56, 'shoe_kl')
    layered_outline(im, skin_edge=True)
    if step != 0:                                             # 大步格：後腿左上角多了一格皮膚，裙底那格仍保持邊緣的深色輪廓（使用者手修）
        im.layers['bottom'].px[52][16] = tuple(int(v * 0.52) for v in C['k_d'])
        im.compose()
    return im


def mirror_layers(layers, w=28):
    out = {}
    for n, img in layers.items():
        m = Img(img.w, img.h)
        for y in range(img.h):
            for x in range(img.w):
                m.px[y][x] = img.px[y][w - 1 - x]
        out[n] = m
    return out


BACK_MAPS = [
    # 大步A
    [
        '..........................',
        '.........85555558.........',
        '.......66FFF66FFF66.......',
        '.....4BKKFF6666FFKKB4.....',
        '....6OLLG47DGGD74GLLO6....',
        '...FHLNHLPNL77LNPLHNLHF...',
        '..FKOPMMMLPPGGPPLMMMPOKF..',
        '..GKOJMPPMMMMMMMMPPMJOKG..',
        '.6ORPNNLJPLNPPNLPJLNNPRO6.',
        '.FLPRRLONLNOJJONLNOLRRPLF.',
        '4GKPRRLRRLLRRRRLLRRLRRPKG4',
        '6HNMPNLRRNLRRRRLNRRLNPMNH6',
        '6KPMMPNLNPPNJJNPPNLNPMMPK6',
        '6KNMMMPMMMMMPPMLMMMPMMMNK6',
        '6LNMMMLGJMMPMMPMMJGLMMMLL6',
        '4ONMPPMGPMMMMMMMMPGMPPMNO4',
        '4ONJPNNDNNNNLLNNNNDNNPJNO4',
        'BJLHMLPDNNLNNNNLNNDPLMHLJB',
        '4OOGMNL7LMMMPPMMML7LNMGOO4',
        '4KGGPNN7JPMMMMMMPJ7NNPGGK4',
        '6ODGMLN7PMPMMMMPMP7NNMGDO6',
        '6KGGLON7LLMPPPPMLL7NOLGGK6',
        '4BDDOGL7GPLJMMJLPG7LGPDDB4',
        '64GDP4O7DLPGNNGPLD7O4PDG46',
        '66FGK7K6DGODOODOGD6K7KGF66',
        '466DG646FFD7DD7DFF646GD664',
        '8.4FF6..4FFBBBBFF6..4FF4.8',
        '..6.45..4FBBBBBFB6..64.6..',
        '.......5888A8CA88A5.......',
        '......2588CCCCCC8A22......',
        '......2A5A5ACCACCA25......',
        '.....08C885CAACCCA220.....',
        '.....CCCA82ACCACAA222.....',
        '....2C8CCA5CAACCAC5022....',
        '....0CAC885CACCCAC331EI...',
        '....2CAA550CCCCCA939CII...',
        '....2AACAA2AAAACC99IIII...',
        '....2CC98A5CACACC99III....',
        '....2993332AACCC8C0.......',
        '....51RRC52ACACCCC0.......',
        '....CRRRE33CACCCAC2.......',
        '....FRRRE99CACCCC825......',
        '....FIRRC99AAA855550......',
        '.....EEI31325558ACA2......',
        '.....113039CCACCCA82......',
        '.....33325AAACCCCCA2......',
        '.....00258CCCAACCCA2......',
        '.....2225ACCCCCCAAA2......',
        '.....52258AAAAACAA85......',
        '......2225ACCCCCA550......',
        '........IR11111130........',
        '........IRRREERRRI........',
        '........ERRREEQQRI........',
        '........9RRREERRRI........',
        '........EQEEEERRRQ........',
        '........3QQQEERRRQ........',
        '........3IEIEERRRQ........',
        '........3331EERRQQ........',
        '........50139ERRRQ9.......',
        '............39999F5.......',
        '............55QIF5........',
        '.............22505........',
    ],
    # 待機（過渡）
    [
        '.........26644662.........',
        '.......85BFBBBBFB56.......',
        '.....77PNDD7777DDLP77.....',
        '....6NPJG77DGGD77GJPN6....',
        '...FHNNGJOLL77LLOJGNNHF...',
        '..FKONLNPNONDDNONPNLNOKF..',
        '..GKKPNPLJONLLNOJLPNPKKG..',
        '.6ORPJNNNPNLPPLNPNNNJOOO6.',
        '.FKPRRPJPNLOLJOLNPJPRROKF.',
        '6FONRRLRRLNRRRRNLRRLRRNOF6',
        '4KNMMNPRRPPPRRPPPRRPNMMNK4',
        '4KNMMLLNPLLPPPPLLPNLLMMNK6',
        '6KNMMNPJLPPMMMMPPLJPNMMNK6',
        '6KNPMNNGJPPMLLMNPJGNNMPNK6',
        '6KNMMNNGNNPMMMPPMNGNNMMNK6',
        '6KNJMNLDPLMMMMMLLPDLNMJNK6',
        '6KNHMNPDPMMMMMMMMPDPNMHNK6',
        '6KLGMLP7LMMMMMMMML7PLMGLK6',
        '6OGGNLN7PNLLPPLLNP7NLNGGO6',
        '4KGGLLL7NNPLLLLPNN7LLLGGK4',
        '6OGDPJL7NPLMMMMLPN7LJPDGO6',
        '64GGKGK7GLNNMMMNLG7KGKGG46',
        '44GDO7H7GOLHLLHLOG7H7ODG44',
        '46FDOBHBDGJGLLGKGDBHBODF64',
        '646GD4B4BGG6GG7FGB4B4FG646',
        '5.4FFB..6BF6FF6FB6..BFF4.5',
        '..6.68..8BBBBBBBB8..86.6..',
        '.......0888A88A8880.......',
        '......5558CCCCCC8555......',
        '......08CAAACCAAAC80......',
        '.....08CCAACCCCAACC80.....',
        '.....5C8CCCACCACCC8C5.....',
        '....0ACACCCCAACCCCACA0....',
        '....5AC5ACCCCCCCCA5CA5....',
        '....25A2ACCCCCCCCA2A52....',
        '...588C2CCACCCCACC2C885...',
        '...5AAC2ACCCAACCCA2CAA5...',
        '..58CAC2CCACCCCACC2CAC85..',
        '..282AA2ACCCAACCCA2AA282..',
        '...IR222CACCCCCCAC222RI...',
        '...IRR828ACACCACA828RRI...',
        '....II50528ACCA82505II....',
        '.....55ACA502205ACA55.....',
        '.....20AACCACCACCAA02.....',
        '.....528AAAACCAAAA825.....',
        '.....2288ACCCCCCA8822.....',
        '.....22ACCCACCACCCA22.....',
        '.....22ACACC88CCACA22.....',
        '......808CC8CC8CC808......',
        '........I82222228I........',
        '........IRRREERRRI........',
        '........IRQEEEEQRI........',
        '........IRRREERRRI........',
        '........QRRREERRRQ........',
        '........QRRREERRRQ........',
        '.......0QRRREERRRQ0.......',
        '.......50QRREERRQ05.......',
        '.......589C9119C985.......',
        '.......5FIIE33EIIF5.......',
        '........0805..5080........',
        '..........................',
        '..........................',
    ],
    # 大步B
    [
        '..........................',
        '.........85555558.........',
        '.......66FFF66FFF66.......',
        '.....4BKKFF6666FFKKB4.....',
        '....6OLLG47DGGD74GLLO6....',
        '...FHLNHLPNL77LNPLHNLHF...',
        '..FKOPMMMLPPGGPPLMMMPOKF..',
        '..GKOJMPPMMMMMMMMPPMJOKG..',
        '.6ORPNNLJPLNPPNLPJLNNPRO6.',
        '.FLPRRLONLNOJJONLNOLRRPLF.',
        '4GKPRRLRRLLRRRRLLRRLRRPKG4',
        '6HNMPNLRRNLRRRRLNRRLNPMNH6',
        '6KPMMPNLNPPNJJNPPNLNPMMPK6',
        '6KNMMMPMMMMMPPMLMMMPMMMNK6',
        '6LNMMMLGJMMPMMPMMJGLMMMLL6',
        '4ONMPPMGPMMMMMMMMPGMPPMNO4',
        '4ONJPNNDNNNNLLNNNNDNNPJNO4',
        'BJLHMLPDNNLNNNNLNNDPLMHLJB',
        '4OOGMNL7LMMMPPMMML7LNMGOO4',
        '4KGGPNN7JPMMMMMMPJ7NNPGGK4',
        '6ODGMLN7PMPMMMMPMP7NNMGDO6',
        '6KGGLON7LLMPPPPMLL7NOLGGK6',
        '4BDDOGL7GPLJMMJLPG7LGPDDB4',
        '64GDP4O7DLPGNNGPLD7O4PDG46',
        '66FGK7K6DGODOODOGD6K7KGF66',
        '466DG646FFD7DD7DFF646GD664',
        '8.4FF4..6FFBBBBFF4..6FF4.8',
        '..6.45..6BFBBBBBF4..54.6..',
        '.......5A88AC8A8885.......',
        '......22A8CCCCCC8852......',
        '......52ACC8CCA5A5A2......',
        '.....022ACCCAAC588C80.....',
        '.....222AACACCA28ACCC.....',
        '....2205CACCAAC5ACC8C2....',
        '...IE133CACCCAC588CAC0....',
        '...IIC939ACCCCC055AAC2....',
        '...IIII59CCACAA2AACAA2....',
        '....III99CCACAC5A89CC2....',
        '.......0C8CCCAA2333992....',
        '.......0CCCCACA25CRR15....',
        '.......2CACCCAC33ERRRC....',
        '......528CCCCAC99ERRRF....',
        '......055558AAA99CRRIF....',
        '......2ACA85552313IEE.....',
        '......28ACCCACC930311.....',
        '......2ACCCCCAAA52333.....',
        '......2ACCCAACCC85200.....',
        '......2AAACCCCCCA5222.....',
        '......58AACAAAAA85225.....',
        '......055ACCCCCA5222......',
        '........03111111RI........',
        '........IRRREERRRI........',
        '........IRQQEERRRE........',
        '........IRRREERRR9........',
        '........QRRREEEEQE........',
        '........QRRREEQQQ3........',
        '........QRRREEIEI3........',
        '........QQRREE1333........',
        '.......9QRRRE93105........',
        '.......5F99993............',
        '........5FIQ55............',
        '........50522.............',
    ],
]


BACK_HAIR = {**{c: 'hn' for c in '0123'}, **{c: 'hd' for c in '456789ABCDFG'}, **{c: 'hm' for c in 'HJKLN'},
             **{c: 'hl' for c in 'MOP'}, **{c: 'hh' for c in 'QR'}}


def girl_back(step=0):
    """背面。step 0＝待機（過渡格）、1＝大步 A、2＝大步 B。回傳 LI（28×62；圖是 26 欄，放在欄 1～26）。"""
    src = BACK_MAPS[{0: 1, 1: 0, 2: 2}[step]]
    im = LI(28, 62)
    for y, row in enumerate(src):
        for x0, ch in enumerate(row):
            if ch == '.':
                continue
            x = x0 + 1
            if y <= 26:                                              # 頭髮（含髮尾的尖）
                im.layer = 'hair'; im.set(x, y, BACK_HAIR.get(ch, 'hm'))
            elif y <= 42 and (36 <= y and (x0 <= 5 or x0 >= 20)) and ch in 'IRQE':     # 垂在身側的手
                im.layer = 'body'; im.set(x, y, {'I': 'ho', 'R': 'hand', 'Q': 'fk', 'E': 'fc'}[ch])
            elif y <= 42:                                            # 外套
                im.layer = 'top'; im.set(x, y, 'k_d' if ch in '0125' else ('k_l' if ch == 'C' else ('k_d' if ch == '8' else 'k')))
            elif y <= 48:                                            # 短裙
                im.layer = 'bottom'; im.set(x, y, 'k_d' if ch in '0125' or ch == '8' else ('k_l' if ch == 'C' else 'k'))
            elif y == 49 and ch in '82':                             # 裙底陰影
                im.layer = 'bottom'; im.set(x, y, 'k_d')
            elif y <= 56 or (y >= 57 and ch in 'RQ'):                # 腿（皮膚；走路格鞋下面的小腿也是）
                im.layer = 'body'
                im.set(x, y, {'R': 'sk', 'Q': 'fk', 'E': 'fc', 'I': 'fb'}.get(ch, 'fb'))
            else:                                                    # 鞋
                im.layer = 'shoes'; im.set(x, y, 'shoe_kl' if ch in 'FIE' else 'shoe_k')
    dy = {0: 1, 1: -1, 2: -1}[step]                          # 參考圖背面的腳底比正面／側面低（待機 59、大步 61），對齊成 60
    for n in LAYERS:
        im.layers[n] = move_img(im.layers[n], 0, dy)
    im.compose()
    # 清掉孤立的碎格：髮尾兩側各有 2 格只靠一個鄰居連著（還原時留下的雜點），整個背面每格 4 個
    iso = [(x, y) for y in range(im.h) for x in range(im.w) if im.px[y][x] is not None and
           sum(1 for xx, yy in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
               if 0 <= xx < im.w and 0 <= yy < im.h and im.px[yy][xx] is not None) <= 1]
    for x, y in iso:
        for n in LAYERS:
            im.erase(n, x, y)
    ty = {0: 27, 1: 26, 2: 26}[step]                          # 髮尾兩側最下面那一排的小尖（每側 2 格，看起來像碎格）也拿掉
    for x in (5, 6, 21, 22):
        for n in LAYERS:
            im.erase(n, x, ty)
    im.compose()
    return im

# ---------------- sheet 輸出與換色規則 ----------------
def _lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def _with_dark(cols):
    """顏色集合＋它們外框變暗（×0.52）後的顏色。"""
    out = []
    for k in cols:
        c = C[k]
        out += [c, tuple(int(v * 0.52) for v in c)]
    return out


# 換色欄位：引擎的 look 欄位 → (圖層, 該層裡要換的顏色集合或 None＝整層, 基準色)。襯衫不開放換色；膚色（skin）看 look.skin 的色塊（見 main.js 的 chibiSprite）
DYE_SLOTS = {
    'hair':   {'layer': 'hair',   'only': None, 'main': 'hm'},
    'top':    {'layer': 'top',    'only': _with_dark(['k', 'k_l', 'k_d']), 'main': 'k'},
    'bottom': {'layer': 'bottom', 'only': None, 'main': 'k'},
    'shoe':   {'layer': 'shoes',  'only': None, 'main': 'shoe_k'},
    'skin':   {'layer': 'body',   'only': None, 'main': 'sk', 'also': ['hair', 'top']},   # 髮型裡畫的皮膚陰影（油頭的額頭陰影）、男式外套 top 層的手也要跟膚色換：hair／top 層只有顏色表裡的皮膚色會被換、髮色與衣服色不受影響   # 膚色（2026-11-23 開放換色）：body 層整層（皮膚＋外框陰影色）；elf2 的耳朵（hat 層）另外加進這條規則（gen_assets）
    'eye':    {'layer': 'face',   'only': _with_dark(['eg1', 'eg2', 'eg3', 'eg4']), 'main': 'eg2'},   # 眼珠的 4 階灰（睫毛／瞳孔的黑、高光不換）
}
CELL = 64
SHEET_W, SHEET_H = 832, 1856          # 跟 LPC 一樣：13 欄 × 29 列、每格 64×64
WALK_ROW = {'up': 8, 'left': 9, 'down': 10, 'right': 11}
WALK_FRAMES = [0, 1, 1, 0, 0, 2, 2, 0, 0]   # 欄 0..8 用哪一個 step：0＝待機（側面＝兩腳併攏）、1／2＝兩個步伐（引擎只用 0、1、3、5、7）
OX, OY = 18, 2                        # 28×62 放進 64×64：左右置中；腳底（第 60 排）落在格子第 62 列（跟 gen_chibi 一樣）


def all_frames():
    """回傳 {'front': [step0..2 的圖層組], 'side': [...]（臉朝左）, 'back': [...]}。"""
    base = ref_girl()
    return {'front': [girl_walk(base.layers, k) for k in (0, 1, 2)],
            'side': [girl_side(k).layers for k in (0, 1, 2)],
            'back': [girl_back(k).layers for k in (0, 1, 2)]}


EAR_TOP = 2                           # 耳朵圖層上方多留的排數（貓耳的尖在頭頂上面）；貼到 sheet 時往上偏 EAR_TOP
EAR_EX = 4                            # 耳朵／尾巴圖層比角色多的欄數（尾巴尖會伸出角色外面）
# 妖精耳朵（使用者標的位置：臉兩側的鬢髮上、眼睛外側偏上，尖在外上方、往裡面變粗）：{排: [欄...]}，欄是角色座標；右耳＝左右鏡射（欄 27-x）
# 正面（使用者逐格標的）：左耳＝棕色外圈 b＋皮膚 s，從左上角的尖往右下斜到耳根（欄 3～5、排 17～21），右耳左右鏡射（欄 27-x）；蓋在頭髮上面
EAR_FRONT = ['3,17,b', '3,18,b', '4,18,b', '3,19,b', '4,19,s', '5,19,b', '4,20,b', '5,20,s', '5,21,b']
# 側面（臉朝左）看到的那隻耳朵：蓋在頭髮上面，尖在最外面（後上方），往耳根（欄 13）變粗
EAR_SIDE = {19: [16], 20: [15, 16], 21: [14, 15, 16], 22: [13, 14, 15], 23: [13, 14]}
EAR_DY = {'front': {0: 0, 1: -1, 2: -1}, 'side': {0: -1, 1: 0, 2: 0}}   # 跟頭一起上下（見 girl_walk／girl_side 的上抬）；背面的髮型把耳朵蓋住，不畫


def _ear_img(rows, dy, both):
    """耳朵畫成 Img(28+2*EAR_EX, 62)。rows 是字串清單 'x,y,b|s'（逐格上色：b＝棕色外圈 fb、s＝皮膚 sk）時照格子畫；
    是 {排: [欄]} 字典時畫成皮膚色 sk、最下面一格 fk。both＝左右各一隻（右耳鏡射）。"""
    img = Img(28 + 2 * EAR_EX, 62 + EAR_TOP)
    cells = {}
    if isinstance(rows, dict):
        for y, xs in rows.items():
            for x in xs:
                cells[(x, y)] = None
    else:
        for t in rows:
            x, y, k = t.split(',')
            cells[(int(x), int(y))] = C['fb'] if k == 'b' else C['sk']
    for (x, y), col in cells.items():
        if col is None:
            col = C['fk'] if (x, y + 1) not in cells else C['sk']
        for xx in ((x, 27 - x) if both else (x,)):
            img.px[y + dy + EAR_TOP][xx + EAR_EX] = col
    return img


# 貓耳（2026-11-23，參考 LPC 貓耳：頭頂兩側的三角形耳朵、深色外圈、內側粉紅）：模板以耳尖為 (0,0)，(dx, kind)：o 外圈、f 毛、i 內側
CAT_EAR = {0: [(0, 'o')], 1: [(-1, 'o'), (0, 'f'), (1, 'o')], 2: [(-1, 'o'), (0, 'f'), (1, 'f'), (2, 'o')],
           3: [(-2, 'o'), (-1, 'f'), (0, 'i'), (1, 'f'), (2, 'f'), (3, 'o')],
           4: [(-2, 'o'), (-1, 'f'), (0, 'i'), (1, 'i'), (2, 'f'), (3, 'f'), (4, 'o')],
           5: [(-2, 'o'), (-1, 'f'), (0, 'f'), (1, 'i'), (2, 'f'), (3, 'f'), (4, 'f'), (5, 'o')]}
# 側面的貓耳（使用者照我的第三版改的）：形狀一樣，內側粉紅往外側（前面）偏一欄
CAT_EAR_SIDE = {0: [(0, 'o')], 1: [(-1, 'o'), (0, 'f'), (1, 'o')], 2: [(-1, 'o'), (0, 'f'), (1, 'f'), (2, 'o')],
                3: [(-2, 'o'), (-1, 'i'), (0, 'f'), (1, 'f'), (2, 'f'), (3, 'o')],
                4: [(-2, 'o'), (-1, 'i'), (0, 'i'), (1, 'f'), (2, 'f'), (3, 'f'), (4, 'o')],
                5: [(-2, 'o'), (-1, 'f'), (0, 'i'), (1, 'f'), (2, 'f'), (3, 'f'), (4, 'f'), (5, 'o')]}
CAT_COLOR = {'o': 'hn', 'f': 'hm', 'i': 'ci'}   # 外圈／毛用頭髮的顏色（跟髮色一起換色），內側粉紅不換


def _cat_img(tips, mirror_tips, dy, inner=True, tpl=None):
    """tips＝[(尖的欄, 尖的排)]（照順序疊，後面的蓋住前面）；mirror_tips＝True 時每隻另外畫一隻左右鏡射（欄 27-x）的耳朵。"""
    img = Img(28 + 2 * EAR_EX, 62 + EAR_TOP)   # inner＝False：背面看不到耳朵內側，粉紅的部分改成毛
    for tx, ty in tips:
        for r, cells in (tpl or CAT_EAR).items():
            for dx, k in cells:
                for x in ((tx + dx, 27 - (tx + dx)) if mirror_tips else (tx + dx,)):
                    img.px[ty + r + dy + EAR_TOP][x + EAR_EX] = C[CAT_COLOR['f' if (k == 'i' and not inner) else k]]
    return img


# 貓尾巴（2026-11-23）：側面的形狀是使用者在圖上逐格畫的（待機格座標，下面 +1 換成基準座標），1 格寬的毛 hm＋兩側外圈 hn，
# 從腰後往後、往上，豎直到胸部高度，尖端往右（後）勾。在 hairbg 層（蓋在外套／裙子上面、頭髮下面）。正面藏在身體後面，不畫。
_TAIL_SIDE_IDLE = {
    32: 'hn:23,24,25', 33: 'hn:22,26 hm:23,24,25', 34: 'hn:22,24,25,27 hm:23,26', 35: 'hn:22,24,26,27 hm:23',
    36: 'hn:22,24 hm:23', 37: 'hn:22,24 hm:23', 38: 'hn:22,24 hm:23', 39: 'hn:22,24 hm:23',
    40: 'hn:21,24 hm:22,23', 41: 'hn:19,20,23 hm:21,22', 42: 'hn:18,22 hm:19,20,21', 43: 'hn:20,21 hm:19'}


def _parse_tail(rows, dy=1):
    cells = {}
    for y, t in rows.items():
        for part in t.split():
            k, xs = part.split(':')
            for x in xs.split(','):
                cells[(int(x), y + dy)] = k
    return cells


TAIL_SIDE = _parse_tail(_TAIL_SIDE_IDLE)
# 背面（使用者逐格畫的，待機格座標；全部在身體範圍內，所以正面看不到）：形狀跟側面一樣（1 格寬的毛＋外圈，上端往右勾），
# 但整條只有短短一段，沿著背從左下往右上斜到胸部高度
_TAIL_BACK_ROWS = {
    33: 'hn:17,18,19', 34: 'hn:16,20 hm:17,18,19', 35: 'hn:16,18,19,21 hm:17,20', 36: 'hn:16,18,20,21 hm:17',
    37: 'hn:16,18 hm:17', 38: 'hn:16,18 hm:17', 39: 'hn:16,18 hm:17', 40: 'hn:16,18 hm:17',
    41: 'hn:15,18 hm:16,17', 42: 'hn:17 hm:15,16', 43: 'hn:13,14,16 hm:15', 44: 'hn:15 hm:13,14', 45: 'hn:13,14'}
TAIL_BACK = _parse_tail(_TAIL_BACK_ROWS, dy=0)
TAIL_SWAY = {'side': {0: 0, 1: 2, 2: -2}, 'back': {0: 0, 1: 2, 2: -2}}   # 走路時尾巴尖左右擺（越高擺越多）
TAIL_DY = {'back': {0: 0, 1: -1, 2: -1}, 'side': {0: -1, 1: 0, 2: 0}}   # 跟身體一起上下（跟 EAR_DY 的頭一樣的規則）


def _tail_img(cells, dy, sway):
    img = Img(28 + 2 * EAR_EX, 62 + EAR_TOP)
    for (x, y), k in cells.items():
        t = max(0, min(1, (44 - y) / 10))          # 越高擺越多
        xx = x + round(sway * t)
        img.px[y + dy + EAR_TOP][xx + EAR_EX] = C[k]
    return img


def ear_frames(kind='elf'):
    """{'front': [3 格], 'side': [...], 'back': [...]}：每格是 {'hat': Img}（蓋在頭髮上面）。
    kind＝'elf'：妖精耳朵（背面沒有，髮型蓋住）；kind＝'cat'：貓耳（四個方向都有；側面是前後兩隻）。"""
    out = {}
    if kind == 'cat':
        dyk = {'front': EAR_DY['front'], 'back': EAR_DY['front'], 'side': EAR_DY['side']}
        out['front'] = [{'hat': _cat_img([(5, -1)], True, dyk['front'][st])} for st in (0, 1, 2)]
        out['back'] = [{'hat': _cat_img([(5, -1)], True, dyk['back'][st], inner=False),
                        'hairbg': _tail_img(TAIL_BACK, TAIL_DY['back'][st], TAIL_SWAY['back'][st])} for st in (0, 1, 2)]
        out['side'] = [{'hat': _cat_img([(12, 2), (5, 0)], False, dyk['side'][st], tpl=CAT_EAR_SIDE),
                       'hairbg': _tail_img(TAIL_SIDE, TAIL_DY['side'][st], TAIL_SWAY['side'][st])} for st in (0, 1, 2)]   # 一前一後（使用者標的位置）：前面（臉那邊）的耳朵尖在 (5,0)，後面那隻低 2 排、往後 7 欄，尖在 (12,2)
        return out
    for key, rows, both in (('front', EAR_FRONT, True), ('side', EAR_SIDE, False)):
        out[key] = [{'hat': _ear_img(rows, EAR_DY[key][st], both)} for st in (0, 1, 2)]
    return out


def build_sheets(ears=False):   # ears：False／True（＝'elf'）／'cat'
    """回傳 {圖層名: Img(832×1856)}：每個圖層一張 LPC 格式的 sheet（只填走路列）。右＝左的鏡像。
    ears＝True：多畫妖精耳朵（hairbg／hat 兩層才有內容）。"""
    fr = all_frames()
    sheets = {n: Img(SHEET_W, SHEET_H) for n in LAYERS}
    src = {'down': ('front', False), 'up': ('back', False), 'left': ('side', False), 'right': ('side', True)}
    for d, row in WALK_ROW.items():
        key, mir = src[d]
        for col, st in enumerate(WALK_FRAMES):
            layers = mirror_layers(fr[key][st]) if mir else fr[key][st]
            for n in LAYERS:
                dst, img = sheets[n], layers[n]
                for y in range(img.h):
                    for x in range(img.w):
                        c = img.px[y][x]
                        if c is not None:
                            dst.px[row * CELL + OY + y][col * CELL + OX + x] = c
    if ears:
        ef = ear_frames('cat' if ears == 'cat' else 'elf')
        for d, row in WALK_ROW.items():
            key, mir = src[d]
            for col, st in enumerate(WALK_FRAMES):
                for n, img in ef.get(key, [{}, {}, {}])[st].items():
                    if mir:
                        img = mirror_layers({n: img}, w=img.w)[n]
                    dst = sheets[n]
                    for y in range(img.h):
                        for x in range(img.w):
                            c = img.px[y][x]
                            if c is not None and 0 <= row * CELL + OY - EAR_TOP + y and dst.px[row * CELL + OY - EAR_TOP + y][col * CELL + OX - EAR_EX + x] is None:
                                dst.px[row * CELL + OY - EAR_TOP + y][col * CELL + OX - EAR_EX + x] = c
    if not ears:
        complete_head(sheets)
    return sheets


# 矮人（2026-11-23，使用者要求：偏小孩體型）：把新人類每格的軀幹、小腿各拿掉幾排（格子座標，0～63），上半身整段往下移，腳底仍在第 62 列。
# 頭不變（頭身比變大）；軀幹 32～35 是外套中段、小腿 54～57 是襪子／小腿，這幾排各方向、各步伐都是一樣寬的直條，拿掉不會斷肢。
DWARF_DROP = (32, 33, 34, 35, 54, 55, 56, 57)


def shrink_sheets(sheets, drop=DWARF_DROP):
    """每個格子拿掉 drop 的那幾排，上面的排往下補（只處理走路列）。回傳新的 {圖層名: Img}。"""
    out = {n: Img(SHEET_W, SHEET_H) for n in sheets}
    for n, src in sheets.items():
        for row in WALK_ROW.values():
            for y in range(CELL):
                if y in drop:
                    continue
                ny = y + sum(1 for d in drop if d > y)
                if ny >= CELL:
                    continue
                out[n].px[row * CELL + ny][:] = src.px[row * CELL + y]
    return out


# 巨人（預覽用）：新人類每格的軀幹、小腿各複製幾排（格子座標，各複製一次），頭不變；格子變高（原本 64 排放不下，所以不能直接貼回 64×64 的 sheet）
# 巨人比人類高多少＝矮人比人類矮多少（8 排）：軀幹 +4、小腿 +4。軀幹複製外套中段 37～40 排（走路時身體會上下動 1 排，複製的排數要跟著動，見 giant_sheets 的 dy，
# 不然領口／領帶每一格被複製的位置不一樣，往下走時領口會跳）；小腿只複製沒有膝蓋陰影點的排（正面 53、55 排各有兩個陰影點，複製會變成一條條直線），
# 兩腿中間的暗縫（kk 兩欄）本來就是直的，拉長沒關係
GIANT_TORSO = (37, 38, 39, 40)
GIANT_LEGS = (54, 56, 57, 58)
GIANT_DUP = GIANT_TORSO + GIANT_LEGS


def grow_cell(sheets, row, col, dup=GIANT_DUP):
    """回傳 {圖層名: [每排的像素列]}：該格複製 dup 的排數後的樣子，高度 CELL+len(dup)，腳底仍貼著底部。"""
    out = {}
    for n, src in sheets.items():
        rows = []
        for y in range(CELL):
            line = src.px[row * CELL + y][col * CELL:(col + 1) * CELL]
            rows.append(line)
            rows.extend([line] * dup.count(y))
        out[n] = rows
    return out


def widen_cell(cl, y0=30, big=4, small=2):
    """壯一點（巨人預覽用）：從第 y0 排（脖子以下，頭不動）起，每排把各圖層合起來的連續色塊（run）加寬——寬 ≥ 12 的（軀幹＋手臂）加 big 欄、
    寬 4～11 的（腿、單隻手臂）加 small 欄，加寬的方式是在 run 內均分的位置複製欄；所有圖層共用同一份對應（對齊不會跑掉），整排再左右置中。"""
    layers = list(cl)
    n = len(cl[layers[0]])
    W = CELL
    for y in range(y0, n):
        occ = [any(cl[l][y][x] is not None for l in layers) for x in range(W)]
        runs, x = [], 0
        while x < W:
            if occ[x]:
                a = x
                while x < W and occ[x]:
                    x += 1
                runs.append((a, x - 1))
            else:
                x += 1
        dup = {}   # 舊 x → 要多複製幾次
        for a, b in runs:
            w = b - a + 1
            k = big if w >= 12 else small if w >= 4 else 0
            for i in range(k):
                xx = a + (i + 1) * w // (k + 1)
                dup[xx] = dup.get(xx, 0) + 1
        add = sum(dup.values())
        if not add:
            continue
        for l in layers:
            src = cl[l][y]
            out = []
            for x in range(W):
                out.append(src[x])
                out.extend([src[x]] * dup.get(x, 0))
            sh = add // 2
            out = out[sh:] + [None] * sh
            cl[l][y] = (out + [None] * W)[:W]
    return cl


GIANT_CELL = 96                        # 巨人的格子 96×96（身高 86 排放不進 64×64）
GIANT_OX, GIANT_OY = 16, 32            # 原本 64×64 的格子（引擎的「邏輯格」）放在 96×96 格子裡的位置（左右置中、貼底）：引擎用它對腳底與掛點


def giant_sheets(sheets):
    """新人類的 sheet → 巨人的 96×96 格 sheet（13 欄 × 29 列，只填走路列）：每格拉長（grow_cell）、加寬（widen_cell），腳底落在格子第 94 列
    （＝邏輯格第 62 列，所以引擎的腳底對齊、影子都不用改），左右置中。"""
    W, H = 13 * GIANT_CELL, 29 * GIANT_CELL
    out = {n: Img(W, H) for n in sheets}
    foot = CELL - 1 - 1                     # 邏輯格裡腳底那一排（第 62 排）
    for row in WALK_ROW.values():
        for col in range(9):
            top = lambda c: min((y for y in range(CELL) if any(v is not None for v in sheets['hair'].px[row * CELL + y][c * CELL:(c + 1) * CELL])), default=0)
            dy_bob = top(col) - top(0)       # 這一格的身體比這個方向的待機格高／低幾排（走路的上下起伏）：軀幹複製的排跟著動
            dup = tuple(d + dy_bob for d in GIANT_TORSO) + GIANT_LEGS
            cl = widen_cell(grow_cell(sheets, row, col, dup))
            for n, rows in cl.items():
                # rows 共 CELL+len(GIANT_DUP) 排，腳底那排（原第 62 排）在新排號 foot + 軀幹／小腿複製的排數
                foot_new = foot + sum(1 for d in GIANT_DUP if d <= foot)
                dy = GIANT_OY + foot - foot_new          # 新排 r → 格子第 r + dy 列
                for r, line in enumerate(rows):
                    y = r + dy
                    if not 0 <= y < GIANT_CELL:
                        assert all(v is None for v in line), 'giant: row out of cell'
                        continue
                    for x, v in enumerate(line):
                        if v is not None:
                            out[n].px[row * GIANT_CELL + y][col * GIANT_CELL + GIANT_OX + x] = v
    return out


def complete_head(sheets):
    """完整素體（頭）：body 層原本只有被瀏海露出來的下半臉、手、腿，換成別的髮型（短髮、馬尾…）會露出空洞。這裡每一格在 body 層補一顆完整的頭（橢圓頭骨，
    大小跟著該格頭髮的輪廓：寬＝頭髮最寬處−6、高 25 排、頭頂在髮頂下 2 排）＋脖子，外框用皮膚陰影色（跟其他皮膚外框一樣畫在輪廓內側）。只補 body 層還是空的像素。
    就地修改 sheets（build_sheets 最後呼叫）。"""
    body, hair = sheets['body'], sheets['hair']
    for row in WALK_ROW.values():
        for col in range(9):
            x0, y0 = col * CELL, row * CELL
            hrows = [y for y in range(CELL) if any(hair.px[y0 + y][x0 + x] is not None for x in range(CELL))]
            if not hrows:
                continue
            ht = hrows[0]
            band = [x for y in range(ht + 5, ht + 13) for x in range(CELL) if hair.px[y0 + y][x0 + x] is not None]
            cx, rx = (min(band) + max(band) + 1) / 2, (max(band) - min(band) + 1) / 2 - 3
            ry, cy = 12.0, ht + 14.0
            cells = set()
            for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
                for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
                    if ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1:
                        cells.add((x, y))
            for y in range(ht + 23, ht + 28):          # 脖子：6 欄，在頭下面
                for x in range(int(cx - 3), int(cx + 3)):
                    cells.add((x, y))
            old = {(x, y) for y in range(CELL) for x in range(CELL) if body.px[y0 + y][x0 + x] is not None and y < ht + 28}
            allc = cells | old
            for (x, y) in cells:
                if body.px[y0 + y][x0 + x] is None:
                    edge = any((xx, yy) not in allc for xx, yy in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
                    body.px[y0 + y][x0 + x] = C['sk_d'] if edge else C['sk']


# 中長髮（2026-11-23，使用者給的參考圖：正面／側面／背面各一張；參考圖是縮放過的雜色圖，這裡只取輪廓與明暗，重新對應成髮色代號——
# n 外框、d 深、m 基本、l 淺、h 高光，對應 C 的 hn／hd／hm／hl／hh，所以換髮色（dye）照常運作）。'.' ＝透明。側面是臉朝左（朝右＝左右鏡射）。
# 位置：每格把圖的左上角放在該格原本髮型（鮑伯）的左上角（隨走路頭上下起伏），見 long_hair_sheet。
LONG_HAIR_FRONT = [
    '.........nnnnnnnn.........',
    '.......nnddddddddnn.......',
    '.....nnddddddddddddnn.....',
    '....nmmddddddddddddmmn....',
    '...nmmmddmmddddmmddmmmn...',
    '..nmmmddmmmmddmmmmmmmmmn..',
    '..nmmmmmmmmmmmmmmmmmmmmn..',
    '.nmmmmmmmmmmmmmmmmmmmmmmn.',
    '.nmmhhmmmmmmmmmmmmmmhhmmn.',
    '.nmmhhdhhmdhhhhdmhhdhhmmn.',
    '.nmmmmdhhmdhhhhdmhhdmmmmn.',
    'ndmmmdmmmmmmddmmmmmmdmmddn',
    'ndmmmdmmmmddmmddmmmmdmmddn',
    'ndmmmdmlmmddllddmmlmdmmddn',
    'ndmmmddlmmddddddmmlddmmmdn',
    'ndmmmdddmmnnmmnnmmdddmmmdn',
    'ndmmmddnnn..nn..nnnddmmmdn',
    'nddmmdn............ndmmddn',
    'ndddddn............ndddddn',
    'ndddddn............ndddddn',
    'ndddddn............ndddddn',
    'ndddddn............ndddddn',
    'ndddddn............ndddddn',
    'ndddddn............ndddddn',
    '.ndddddn..........ndddddn.',
    '..ndddddnn......nndddddn..',
    '...ndddnn........nndddn...',
    '....ndn............ndn....',
    '.....nn............nn.....',
    '....................n.....',
]
LONG_HAIR_SIDE = [   # 側面紋路（照參考圖：大致平滑，只有頭頂髮旋縫、一排高光、後面下半 3 條長的深色細線、尖端分隔線，其餘是疏疏的 1～3 格細點）
    '...........nnnnnnnn........',
    '.........nnmmmdmmmmnn......',
    '......nnnmmmmdddmmmmmn.....',
    '....nnmmmmmmddddmmmmmmn....',
    '...nmmmmlmmmdlldmmmmmmmn...',
    '..nmdmmmmmmmdmmmmmmmmmmmn..',
    '..nmmmmmmmmmmlmmmmmdmmmmn..',
    '.nmmhmmmmmmmmlmmmmmmmmmhmn.',
    '.nmmmhhmmmmmmmmmmmmmhhhmmn.',
    '.nmmmhhmhhhmmhmmmmmmhhhmmmn',
    'nmmmmmmmhhhmmmmmmmmmmmmmmmn',
    'nmlmmmmmmmlmmdmmmmmmmdmmlmn',
    'nmlmmmmmmmmmmmmmmmmmddmmmmn',
    'nmdmmmmmmmmlmmmmmdmmmdmmmmn',
    'nddmdmmmmmlmmmmmmmlmdlmmmdn',
    'nddmmmmmmmlmmmmmmdlldllmmdn',
    '.ndmmnnnmmmmmmmdmdmddmlmmdn',
    '.nnnn...nnmmmmmdmdmddmdmmdn',
    '..........nnnnmmmdmdmmdmmdn',
    '..............ndmdmdmmdmldn',
    '..............ndmdmdmldddn.',
    '..............ndmdddmmdddn.',
    '..............ndmdmdmmdddn.',
    '..............ndmdmdmdldn..',
    '..............ndmdddmdddn..',
    '...............nddddmdddn..',
    '...............nddddmdddn..',
    '...............nddddmldn...',
    '................ndddnddn...',
    '.................ndn.nn....',
    '.................nn..n.....',
    '..................n..n.....',
]
LONG_HAIR_BACK = [
    '.........nnnnnnnn.........',
    '.......nnddddddddnn.......',
    '.....nnddddddddddddnn.....',
    '....nmmmddddddddddmmmn....',
    '...nmmmdmmmddddmmmdmmmn...',
    '..nmmmddlmmmddmmmlddmmmn..',
    '..nmmmmmlmmmmmmmmllmmmmn..',
    '.nmmmllmmmmmmmmmmddllmmmn.',
    '.nmmhhmmmmmmddmmmmmmhhmmn.',
    '.nmmhhmhhmmmhhmmmhhmhhmmn.',
    'nmmmmmmhhmmmhhmmmhhmmmmmmn',
    'nmmmmmmmmmmmmmmmmmmmmmmmmn',
    'nmmmmmmmmmmmmmmmmmmmmmmmmn',
    'nmmmdmmmmmmmmmmmmmmdddmmmn',
    'nmmddmmmmmmmmmmmmmmmmddmmn',
    'ndmmdmmmddmmmmmmddmmmdmmdn',
    'ndddddmmddmmmmmmddmmdddddn',
    'ndddddddddmmmmmmdddddddddn',
    'nddddddddddddddddddddddddn',
    'nddddddddddddddddddddddddn',
    '.nddddddddddddddddddddddn.',
    '.nddddddddddddddddddddddn.',
    '.ndddddddmddddddmdddddddn.',
    '.nddddddmmmdmmmmmmddddddn.',
    '..nddddddmmdmmmmlddddddn..',
    '..nddddddmmdmmmmlddddddn..',
    '..nddddddlmdlldmdddddddn..',
    '..nddddddlmmmmdmdddddddn..',
    '..nddndddmmmmmdmmddddddn..',
    '..ndn.ndddmmmmdddddddddn..',
    '..nn..nddnddmmddnddddddn..',
    '......ndn.nnmmnn.nddddn...',
    '......nn....nn....nddnn...',
    '..................nnn.....',
]
LONG_HAIR_KEY = {'n': 'hn', 'd': 'hd', 'm': 'hm', 'l': 'hl', 'h': 'hh', 'k': 'sk_d', 'f': 'fk', 'c': 'fc'}   # k／f＝頭髮投在額頭上的陰影（皮膚的陰影色；只有油頭用）、c＝臉前緣的輪廓（深棕，跟下半臉的輪廓同色），皮膚換色時一起換


def hair_style_sheet(sheets, maps, center=False, side_dx=0, top_row=0, side_dy=0, side_shadow_dy=0):
    """回傳 Img(832×1856)：某個髮型的 hair 層（只填走路列；右＝左的鏡像）。sheets＝新人類的各層 sheet（用原本髮型的位置對齊）。
    maps＝{'down': 正面, 'up': 背面, 'left': 側面（臉朝左）}，各是字串列（見 LONG_HAIR_*）；
    center＝True：正面／背面依原本髮型的左右中心置中（髮型比頭寬時用），否則圖的左緣對齊原本髮型的左緣；side_dx＝側面再往右偏幾欄；
    top_row＝圖的第幾排（從 0 算）對齊原本髮型的頭頂（圖頂端有一小撮翹毛時用）；side_dy＝側面再往下偏幾排（側面頭頂與前髮的相對位置跟正面不同時用）。side_shadow_dy＝側面的額頭陰影（k／f／c）相對於頭髮再偏幾排（陰影要留在原位、頭髮往下時用，負數＝往上）；陰影先畫、頭髮蓋在上面。"""
    hair = sheets['hair']
    out = Img(SHEET_W, SHEET_H)
    for d, row in WALK_ROW.items():
        src_d = 'left' if d == 'right' else d
        mp = maps[src_d]
        for col in range(9):
            x0, y0 = col * CELL, row * CELL
            if d == 'right':                       # 右＝左那一格鏡像（原圖的 row 9）
                hx0, hy0 = col * CELL, WALK_ROW['left'] * CELL
            else:
                hx0, hy0 = x0, y0
            ys = [y for y in range(CELL) if any(hair.px[hy0 + y][hx0 + x] is not None for x in range(CELL))]
            xs = [x for y in ys for x in range(CELL) if hair.px[hy0 + y][hx0 + x] is not None]
            if not ys:
                continue
            top, left = ys[0] - top_row, min(xs)
            if src_d == 'left':
                top += side_dy
            if center and src_d != 'left':
                left = (min(xs) + max(xs) + 1) // 2 - len(mp[0]) // 2
            elif src_d == 'left':
                left += side_dx
            sdy = side_shadow_dy if src_d == 'left' else 0
            for shadow_pass in (True, False):          # 先畫陰影（k／f／c），再畫頭髮（蓋在陰影上面）
                for y, line in enumerate(mp):
                    for x, ch in enumerate(line):
                        if ch == '.' or (ch in 'kfc') != shadow_pass:
                            continue
                        px = left + x
                        if d == 'right':
                            px = 63 - px           # 鏡像：左面向的格 x → 63-x（OX=18、框寬 28）
                        yy = y0 + top + y + (sdy if shadow_pass else 0)
                        if shadow_pass and sheets['face'].px[yy][x0 + px] is not None:
                            continue   # 額頭陰影不蓋住眼睛：這一格臉層有眼睛就不畫
                        out.px[yy][x0 + px] = C[LONG_HAIR_KEY[ch]]
    return out


def long_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': LONG_HAIR_FRONT, 'up': LONG_HAIR_BACK, 'left': LONG_HAIR_SIDE})


# 蓬蓬短髮（2026-11-23，使用者給的第二個參考圖：綠色、蘑菇頭帶尖尖的鬢角；正面／側面／背面並排在同一張圖，這裡取輪廓與明暗，重新對應成髮色代號）。
# 比頭寬（30 欄），所以正面／背面置中、側面往前凸 1 欄；圖第 2 排是頭頂（上面 2 排是頭頂的一小撮翹毛）。
PUFF_HAIR_FRONT = [
    '........nnnn..................',
    '..........nnnn................',
    '...........nnnnnnnn...........',
    '.........nndddnnnddnn.........',
    '.......nnmmddddndddmmnn.......',
    '......nmmmmmndddddmmmmmn......',
    '.....nmmmmmmmmdddmmmmmmmn.....',
    '....nmmmmmmmmmmmmmmmmmmmmn....',
    '...nmmmmmmmmmmmmmmmmmmmmmmn...',
    '..ndmmmmmmmllmmmmmmmmmmmmmdn..',
    '.nddmmmhmmllllmmmmmmmmhhmmddn.',
    '.nndmmmhmhhllhhhmmmhhdhhmmdnn.',
    'n.nmmmmmmhhllhhhhmmhhdmmmmmn.n',
    '..nmmmmmmmmmmlllmmmmmldmmmmn..',
    '.nmmmmmmmmmmmlllmmmmmldmmmmmn.',
    '.nmmmmmmlmmmllllmmmmmmdmmmmmn.',
    '.nmmmmmmlmmmllllmmmmmmmmmmmmn.',
    '.nmddmnllmmnlmmldnnmmmmmmddmn.',
    '.nddddnlmnnddmmmn..nmmmnddddn.',
    '..nndnnnnn.nnmmn...nnmnnndnn..',
    '..n.nnnnn...nmmn.....nnnnn.n..',
    '....nnnn.....nn.......nnnn....',
    '.....nnn......n.......nnn.....',
    '.....nnn..............nnn.....',
    '.....n.n..............n.n.....',
    '.......n..............n.......',
]
PUFF_HAIR_SIDE = [
    '............nnn..............',
    '.............nnn.............',
    '.........nnnnnnnnnnnn........',
    '...........nddmnnnnnmnn......',
    '........nnnmmmnnnnnmmmmn.....',
    '......nnmmmmmmmmmmmmmmmmn....',
    '.....nmmmmmmmmmmmmmmmmmmmn...',
    '....nmmmmmmmmmmmmmmmmmmmmmn..',
    '...nmmmmmmmmmmmmmmmmmmmmmln..',
    '..nmmmmmhmmmmmmmmmmmmmmmmmmn.',
    '.nmmmmmhhmmmmmmmmmmmmmhhhmmn.',
    '.nnmmmmhhmhhhmlmmmmhhlhhhmmdn',
    'n..nmmmllmhhhlllmmllllllllmdn',
    '...nmmmlllmmmllllmmllllllmmdn',
    '..nmmmmmlmmmmmmlmmmmlllmmmmdn',
    '..ndmmmmmmmmmmmmmmmmllmmmmmdn',
    '.ndndmmmmmmmmmmmmmllmmmmmmmdn',
    '.nn.nmmmmmmmmmmmmllllmmmmmmdn',
    '.n..nmmnnmmmmddnmllllmmmmnmdn',
    '....nnn..nmmnnnnllllmnmmmnmdn',
    '....nn....nmnnnnmmnmmnnmmnnnn',
    '....n......nn..ndmnmmnnnnnnnn',
    '...........n....nnnnnnnnnn.nn',
    '................nnnnnnnnnn..n',
    '................nnnnnnnn.n...',
    '................nnnnnnnn.....',
    '................nnnnnnnn.....',
    '................nnnnnnn......',
]
PUFF_HAIR_BACK = [
    '..................nnnn........',
    '................nnnn..........',
    '...........nnnnnnnn...........',
    '.........nnddnnndddnn.........',
    '.......nnmmmddndddmmmnn.......',
    '......nmmmmmnddddnmmmmmn......',
    '.....nnmmmmmmddddmmmmmmnn.....',
    '....nmmmmmmmmmddmmmmmmmmmn....',
    '...nmmmmmmmmmmmmmmmmmmmmmmn...',
    '..nmmmmmmmmmmmmmmmmmmmmmmmmn..',
    '.nddmmhhmmllmmllmmllmmhhmmddn.',
    '.nndmmmhdhhlmmhhmmlhhdhmmmdnn.',
    'n.ndmmmmdhhlmmhhmmlhhdmmmmdn.n',
    '..nmmmmmmllmmmmmmmmllmmmmmmn..',
    '.nmmmmmmmmmmmmmmmmmmmmmmmmmmn.',
    '.nmmmmmmmmmmmmmmmmmmmmmmmmmmn.',
    '.nmmmmmmmmmmmmmmmmmmmmmmmmmmn.',
    '.nmmmmmmmmmmmmmmmmmmmmmmmmmmn.',
    '.ndnmmmmmmmmmmmmmmmmmmmmmmndn.',
    '..nnnnnmmmmmmmmmmmmmmmmnnnnn..',
    '..n.nnnndmmmmmmmmmmmmdnnnn.n..',
    '....nnnnddmmmmmmmmmmddnnnn....',
    '.....nnndddmmmddmmddddnnn.....',
    '.....nnnddddddddddddddnnn.....',
    '.....n.nnddddddddddddnn.n.....',
    '.......n.nddddddddddn.n.......',
    '..........nnnnddnnnn..........',
    '...........nnnnnnnn...........',
]


def puff_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': PUFF_HAIR_FRONT, 'up': PUFF_HAIR_BACK, 'left': PUFF_HAIR_SIDE}, center=True, side_dx=-1, top_row=2)


# 外翹髮（2026-11-23，使用者給的第三個參考圖：橘色、中短髮、髮尾往外翹；正面／側面／背面各一張，這裡取輪廓與明暗，重新對應成髮色代號）。
# 比頭寬（32 欄；髮尾翹出去的那排最寬），正面／背面置中；圖第 0 排就是頭頂。
# 髮束的分界線（暗橘色的 1 欄細線，亮度約 85～130 → d）照參考圖的位置畫，不是自己加的；閾值：<85 n、<130 d、<205 m、<218 l、其餘 h；只去掉孤立的單格，不做多數決平滑（會把 1 格寬的分界線抹掉）。
FLIP_HAIR_FRONT = [
    '............nnnnnnnn............',
    '..........nnmmmddmmmnn..........',
    '........nnmmmmddddmmmmnn........',
    '.......nmmmmddmmmmddmmmmn.......',
    '......nmmmmmmmmddmmmmmmmmn......',
    '.....nmmmmmmmmmmmmmmmmmmmmn.....',
    '.....nmmmmmmmmmmmmmmmmmmmmn.....',
    '....nmmmmmmmmmmmmmmmmmmmmmmn....',
    '....nmmhhmmmmmmmmmmmmmmhhmmn....',
    '....nmmmhmhhmmhhhhmmhhmhmmmn....',
    '...nmmmmmmhhmmhhhhmmhhmmmmmmn...',
    '...nmmmmmmmmmmmmmmmmmmmmmmmmn...',
    '...nmmmmmmmmmmmmmmmmmmmmmmmmn...',
    '...nmmmmmmmmdmmmmmmdmmmmmmmmn...',
    '...nmmmdmmmmdmmmmmmdmmmmdmmmn...',
    '...nmmmdmmmnnmmmmmmnnmmmdmmmn...',
    '...nmmmdmmn..nmmmmn..nmmdmmmn...',
    '...nmmmdmn...nnmmnn...nmdmmmn...',
    '...nmmmddn.....nn.....nddmmmn...',
    '..nmmmmdn..............ndmmmmn..',
    '.nmmmmmmn..............nmmmmmmn.',
    'nnnddmddn..............nddmddnnn',
    '...nmmmddn............nddmmmn...',
    '...nmnddmdn..........ndmddnmn...',
    '...nn.ndnddnn......nnddndn.nn...',
    '...n..nn.nnnnn....nnnnn.nn..n...',
    '......n..................n......',
]
FLIP_HAIR_SIDE = [
    '...........nnnnnnnn.........',
    '.........nnmmmdmmmmnn.......',
    '......nnnmmdddmddmmmmn......',
    '....nnmmmmmmmmmmmmmmmmn.....',
    '...nmmmmmmmmmmmmmmmmmmmn....',
    '..nmmmmmmmmmmmmmmmmmmmmmn...',
    '..nmmmmmmmmmmmmmmmmmmmmmn...',
    '.nmmmmmmmmmmmmmmmmmmmmmmmn..',
    '.nmmmhhmmmmmmmmmmmmmhhhmmn..',
    '.nmmmhhmhhhmmhhmmhhmhhmmmmn.',
    'nmmmmmmmhhhmmhhmmhhmmmmmmmn.',
    'nmmmmmmmmmmmmmmmmmmmmmmmmmn.',
    'nmmmmmdmmmmmmmmmmmmmmmmmmmn.',
    'nmmmmmdmmmmmmmmmmmmmmmmmmmn.',
    'nmmmmmdmmmmdmmmmmmmmmmmmmmn.',
    'nmmmmmnmmmmdmmmmmmmmmmmmmmn.',
    '.nmmmn.nmmnddmmmmmmdmmmmmmn.',
    '.nmdn...nn.nndmmmmmdmmmmmmn.',
    '.nmn.........ndmmmmdmmmmmn..',
    '.nn...........nmmmmdmmdmmn..',
    '.n............nmmmmdmmdmmmn.',
    '..............nmmmmdmmddmmmn',
    '..............nmmmddmmdddnn.',
    '..............ndmmddmmddn...',
    '...............nmmddmmnnnn..',
    '...............nnnmdnn......',
    '..................nn........',
]
FLIP_HAIR_BACK = [
    '............nnnnnnnn............',
    '..........nnmmmddmmmnn..........',
    '........nnmmmmddddmmmmnn........',
    '.......nmmmmddmmmmddmmmmn.......',
    '......nmmmmmmmmddmmmmmmmmn......',
    '.....nmmmmmmmmmmmmmmmmmmmmn.....',
    '.....nmmmmmmmmmmmmmmmmmmmmn.....',
    '....nmmmmmmmmmmmmmmmmmmmmmmn....',
    '....nmmhhmmmmmmmmmmmmmmhhmmn....',
    '....nmmhhmhhmmhhhhmmhhmhhmmn....',
    '...nmmmmmmhhmmhhhhmmhhmmmmmmn...',
    '...nmmmmmmmmmmmmmmmmmmmmmmmmn...',
    '...nmmmmmmmmmmmmmmmmmmmmmmmmn...',
    '...nmmmmmmmmmmmmmmmmmmmmmmmmn...',
    '...nmmmdmmmmmmmmmmmmmmmmdmmmn...',
    '...nmmmdmmmmmmmmmmmmmmmmdmmmn...',
    '...nmmmdmmdmmmmmmmmmmdmmdmmmn...',
    '...nmmmdmmdmmmmmmmmmmdmmdmmmn...',
    '...nmmmdmddmmmmmmmmmmddmdmmmn...',
    '..nmmmmddmdmmmmmmmmmmdmddmmmmn..',
    '.nmmmmmmdmdmmmmmmmmmmdmdmmmmmmn.',
    'nnnddmdddmdmmmmmmmmmmdmdddmddnnn',
    '...nmmdddmddmmmmmmmmddmdddmmn...',
    '...nmnddmmddmmmmmmmmddmmddnmn...',
    '...nn.ndnddndmdmmdmdnddndn.nn...',
    '...n..nn.nn.nnnmmnnn.nn.nn..n...',
    '......n...n.n..nn..n.n...n......',
]


def flip_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': FLIP_HAIR_FRONT, 'up': FLIP_HAIR_BACK, 'left': FLIP_HAIR_SIDE}, center=True, side_dx=-1, top_row=0)


# 馬尾（2026-11-23，使用者給的第四個參考圖：粉色；正面是頭兩側各垂一束、側面是頭後面一條馬尾＋前面一束、背面是頭後面一整條馬尾；
# 取輪廓與明暗，重新對應成髮色代號）。分界線／陰影的暗色（亮度約 85～150）→ d，其餘規則同外翹髮（只去掉孤立單格，不平滑）。
# 側面圖 33 欄寬（頭 26 欄＋後面的馬尾），圖第 0 排就是頭頂。
PONY_HAIR_FRONT = [
    '.........nnnnnnnn.........',
    '.......nnddddddddnn.......',
    '.....nnmmddnnnnddmmnn.....',
    '....nmmmmnnmddmnnmmmmn....',
    '...nmmmmmlllnnlllmmmmmn...',
    '..nmmmmmmmmmddmmmmmmmmmn..',
    '..nmmmmmmmmmmmmmmmmmmmmn..',
    '.nmmllmmmmmmllmmmmmmllmmn.',
    '.nmmhhdmmmmhmmhmmmmdhhmmn.',
    'nmmmhhdhhmmhhhhmmhhdhhmmmn',
    'nmmlldmhhmmhhhhmmhhmdmmmmn',
    'nmmmmdmmmmdmmmmdmmmmdmmmmn',
    'nmmmmmmmmmdmmmmdmmmmmnmmmn',
    'nmmmnmmdmmnmmmmnmmdmmnmmmn',
    'ndmmnmmdmmnmmmmnmmdmmnmmdn',
    '.nmmdmdnnnnmmmmnnnndmddmn.',
    '.ndndmdn...nnnn...ndmdndn.',
    '.nnnmmn............nmmnnn.',
    '.ndnmmn............nmmndn.',
    '.ndnmmn............nmmndn.',
    '.nddmmn............nmmddn.',
    '..nnlln............nllnn..',
    '...nmmn............nmmn...',
    '...nmmn............nmmn...',
    '....nmnn..........nnmn....',
    '....nmmn..........nmmn....',
    '.....nmdn........ndmn.....',
    '......ndn........ndn......',
    '......nnn........nnn......',
]
PONY_HAIR_SIDE = [
    '...........nnnnnnnn.......nnn....',
    '.........nndddnmmmlnn....nmmmn...',
    '......nnnmmnnndnnmlmmn..nmmhhmn..',
    '....nnmmmmmmmmdllmmllmnnnmmhhmn..',
    '...nmmmmmmmmmmdmmmmmmmmdddmmllln.',
    '..nmmlmmmmmmmmdmmlmmmmmmdmmmmmmn.',
    '..nmmlmmmmlmmmmmllmmmmmmddmmllmn.',
    '.nmmmmmmmmlmmmmmmmmmmmmmmdddlmmmn',
    '.nmmmhhmmmmmmmmmmmmmhhhmmdddmmmmn',
    '.nmmmhhmhhhmmhhmmhhmhhhmmdddmmmmn',
    'nllmmlldhhhmmhhmmhhmmmmmmmdddmmmn',
    'nmmmmmmdmmmmmmmmmmdmmmmmmddddmmmn',
    'nmmllmmmmmmmmmmmmmdmmmmmdndddmmmn',
    'ndmmmlnmmmmmmmmmmmdmmmmmdnmddmmmn',
    'ndmmllnmmmmmmmdmmmdllmmddndddmmmn',
    'ndddddnmmmmmmmdmmmdmmmmmdddddmmmn',
    '.nmddnnnmmnmmmdmmmnmmdmddnddddmmn',
    '.nnnn...nnnnnmdmmmnmdddddndnddmmn',
    '....n........ndllmdddmdddddnddmmn',
    '..............nmmmddmmdddddnndmmn',
    '..............nmmmnddddddnndddmmn',
    '..............nmdlndddddn.nnndmn.',
    '..............nmdlddmddn...nndmn.',
    '..............nmdmdndnn....nndmn.',
    '..............nmdmnnn......nnddn.',
    '..............nmdmn.........nnn..',
    '..............nmdn..........nnn..',
    '..............nmdn..........nn...',
    '..............nddn..........n....',
    '...............nn................',
    '...............n.................',
]
PONY_HAIR_BACK = [
    '.........nnnnnnnn.........',
    '.......nnddddddddnn.......',
    '.....nnmmddmddmddmmnn.....',
    '....nmmddnnddddnnddmmn....',
    '...nmmmmmmdnnnndmmmmmmn...',
    '..nmmmmmmmdmmmmdmmmmmmmn..',
    '..nmllmmmdmmmmmmdmmmllmn..',
    '.nmmmmmlldmmllmmdllmmmmmn.',
    '.nmmhhmmdmmmmmmmmdmmhhmmn.',
    'nmmmhhmmdmmhhhhmmdmmhhmmmn',
    'nmmmmmmddmmhhhhmmddmmmmmmn',
    'ndmmmmdddmmmmmmmmdddmmmmdn',
    'nmmmmdmdmmmmmmmmmmdmdmmmmn',
    'ndmmmdmddmmmmmmmmddmddmmdn',
    'nddddmddmddmmmmddmddmddmmn',
    '.ndmmddddddddddddddddmmdn.',
    '.nddddddnddddddddnddddddn.',
    '.nmdmdddnddddddddndddmdmn.',
    '..ndddmdnddddddddndmdddn..',
    '..ndddmdnmmmmmmmmndmdddn..',
    '..nnnndddmmmmmmmmdddnnnn..',
    '..nnndddnmmmmmmmmndddnnn..',
    '..nn.ndmnmmmllmmmnmdn.nn..',
    '..nn..nnmmmmmmmmmmnn..nn..',
    '..nn....ndmmddmmdn....nn..',
    '...nn...nddddddddn...nn...',
    '.....n..nnddddddnn..n.....',
    '.........nddddddn.........',
    '..........nnddnn..........',
    '............nn............',
]


def pony_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': PONY_HAIR_FRONT, 'up': PONY_HAIR_BACK, 'left': PONY_HAIR_SIDE}, center=True, side_dx=-1, top_row=0)


# 雙馬尾（2026-11-23，使用者給的第五個參考圖：綠色；正面頭兩側各一條馬尾垂到肩膀以下、側面頭後一條（另一條被擋住）、背面頭兩側兩條；
# 取輪廓與明暗，重新對應成髮色代號）。分界線的暗色（亮度 < 58）→ n、陰影（< 100）→ d，其餘規則同外翹髮（只去掉孤立單格，不平滑）。
# 圖第 2 排是頭頂（上面 2 排是兩條馬尾綁點的小撮）；比頭寬（30 欄），正面／背面置中。
TWIN_HAIR_FRONT = [
    '....nnnn..............nnnn....',
    '...ndmmmn............nmmmdn...',
    '..nmmmmmmn.nnnnnnnn.nmmmmmmn..',
    '..nmmmmmmnnmmmnnmmmnmmmmmmmn..',
    '.nmmmmmnnmmmmmndmmmmmmmmmmmmn.',
    '.nmmmmmmmmmnnmmdmmmmmmmmmmmmn.',
    '.nmmdmmmmmmmmmnnmmmmmmmmmdmmn.',
    'nmmmdmmmmmmmmmmmmmmmmmmmmdmmmn',
    'nmmmmmmmmmmmmmmmmmmmmmmmmmmmmn',
    'nmmmmmmmmmmmmmmmmmmmmmmmmmmmmn',
    'nmmmmmhhmmmmmmmmmmmmmmhhmmnmmn',
    'nmnmmmhhmhhmmhhhhmmhhmhhmmnmmn',
    'nmnmmmmmmhhmmhhhhmmhhmmmmmddmn',
    'nmnmmmmmmmmmmmmmmmmmmmmmmmnnmn',
    'nmnmmmnmmmmmmmmmmmmmmmmmmmnnmn',
    'nmnmmmnmmmmnmmmmmmnmmmmnmmnnmn',
    'nmnmmmmmmmmnmmmmmmnmmmmnmmnmmn',
    'nmnmmmnmmnmnnmmmmnnmnmmnmmnnmn',
    'nmnnmmnmnnn..nnnn..nnnmnmmnnmn',
    'nmnnmmmnn............nnmmmnnmn',
    'nmnnmmmnn............nnmmmnnmn',
    'nmnmmdmn..............nmmmmnmn',
    'nnnmmdn................nnmmnnn',
    'n.nmmnn................nnmmn.n',
    '..ndnn..................nndn..',
    '..nmnn..................nnmn..',
    '..nmnn..................nnmn..',
    '..nmnn..................nnmn..',
    '..nn.n..................n.nn..',
    '..nn.n..................n.nn..',
    '..nn......................nn..',
    '...n......................n...',
    '...n......................n...',
]
TWIN_HAIR_SIDE = [
    '...........nnnnnn...nn.....',
    '.........nnmmmnmmn.nmmn....',
    '......nnnmmnnnmnnmnnnmmn...',
    '....nnmmmmmmmmmmmmnmmmmmn..',
    '...nmmmmmmmmmmmmmmnmmmmmn..',
    '..nmmmmmmmmmmmmmmddmmmmmmn.',
    '..nmmmmmmmmmmmmmmmnmmmmmmn.',
    '.nmmmmmmmmmmmmmmmmnmmhhmmmn',
    '.nmmmhhmmmmmmmmmmmnmmhhmmmn',
    '.nmmmhhmhhhmmhhmmmnmmmmmmmn',
    'nmmmmmmmhhhmmhhmmmnmmmmmmmn',
    'nmmmmmmmmmmmmmmmmmnmmmmmmmn',
    'nmmmmmmmmmmmmmmmmmnmmmmmmmn',
    'nmmmmmnmmmmmmmmmmmnmmmmmmmn',
    '.nmmmmnmmmmmmmmmmmnmmmmmmmn',
    '.nmddmnnmmmnmmmmmddmmmmmmmn',
    '..nmnn..nmmnmmmmmmmnmmmmdmn',
    '...n.....nnnndmnmmmnmmmmdmn',
    '.............nmnmmdddmmmmmn',
    '.............nmnmmmnmmmmmmn',
    '..............nnmmmnmmmmmn.',
    '..............nnmmmnmnmmmn.',
    '................nmnnmnmmmn.',
    '................nmmnnmmnmn.',
    '................nmn.nnmnmn.',
    '................nn..nmmnnn.',
    '....................nnmn.n.',
    '.....................nmn...',
    '.....................nnn...',
    '.....................n.n...',
    '.....................n.....',
]
TWIN_HAIR_BACK = [
    '....nnnn..............nnnn....',
    '...nmmmmn............nmmmmn...',
    '..nnnnnmdn.nnnnnnnn.ndmnnnnn..',
    '..nmmmmmdmnmmmnnmmmnmdmmmmmn..',
    '.nmmmmmmmmnmmnnnnmmnmmmmmmmmn.',
    '.nmmmmmmmmnddmmmmddnmmmmmmmmn.',
    '.nmmmmmmmmmmmmnnmmmmmmmmmmmmn.',
    'nmmmmmmnnnnmmmddmmmnnnnmmmmmmn',
    'nmmmmmmmnnmmmmmmmmmmnnmmmmmmmn',
    'nmmmmmmmnnmmmmmmmmmmnnmmmmmmmn',
    'nmmmhhmmnmmmmmmmmmmmmnmmhhmmmn',
    'nmmmhhmmnmmmmhhhhmmmmnmmhhmmmn',
    'nmmmmmmmnmmmmhhhhmmmmnmmmmmmmn',
    'nmmmmmmmnmmmmmmmmmmmmnmmmmmmmn',
    'nmnmmmmmnmmmmmmmmmmmmnmmmmmnmn',
    'nmnmmmmmndmmmmmmmmmmdnmmmmmnmn',
    'nmmmmmmmndmmmmmmmmmmdnmmmmmmmn',
    'nmnmmmmmnmmmmmmmmmmmmnmmmmmnmn',
    'nmnmmmmmnmmmmmmmmmmmmnmmmmmnmn',
    'nmnmmmmmnmmmmmmmmmmmmnmmmmmnmn',
    'nmnmmmmmnmmmmmmmmmmmmnmmmmmnmn',
    'nmnmmmmmndmmmmmmmmmmdnmmmmmnmn',
    'nnnmmmmmndmmmmmmmmmmdnmmmmmnnn',
    'n.ndmmmmnnmmmmmmmmmmnnmmmmdn.n',
    '..nmmnmmnndmmmmmmmmdnnmmnmmn..',
    '..ndmnmmnddmmmmmmmmddnmmnmdn..',
    '..nmmnmmnmnmmmmmmmmnmnmmnmmn..',
    '..nmnnnnnnnnnmmmmnnnnnnnnnmn..',
    '..nn.nn...nn.nnnn.nn...nn.nn..',
    '..nn.n..................n.nn..',
    '..nn......................nn..',
    '...n......................n...',
    '...n......................n...',
]


def twin_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': TWIN_HAIR_FRONT, 'up': TWIN_HAIR_BACK, 'left': TWIN_HAIR_SIDE}, center=True, side_dx=0, top_row=2, side_dy=3)   # 側面（臉朝左）再往右 1 欄、往下 1 排＝比對齊頭頂的位置右 0 欄、下 3 排（2026-11-23 使用者：側面頭髮太高，先下 2 排、再要求往右 1、往下 1 看看）


# 油頭（2026-11-23，使用者給的第六個參考圖：灰髮、頭髮往後梳、額頭整個露出來、兩側髮束垂到耳朵一帶；正面／側面／背面各一張，
# 第四張是頭髮跟頭的對應位置參考，量得髮線（瀏海下緣）到眼睛約 5～7 排，跟「頭頂對齊」的結果一致）。取輪廓與明暗，重新對應成髮色代號；
# 正面／側面用使用者後來補上陰影的版本（21／22.png）：髮際線下緣的橘色＝頭髮投在額頭上的陰影，畫成皮膚的陰影色（k＝sk_d、較暗的線＝f＝fk），
# 所以換膚色時陰影跟著換（skin 換色規則連 hair 層一起套）；背面沒有陰影。暗色（亮度 100～150）→ d、<100 → n，其餘規則同外翹髮（只去掉孤立單格，不平滑）。
OIL_HAIR_FRONT = [
    '........nnnnnnnn........',
    '......nnmddddddmnn......',
    '....nnmmddmmmmddmmnn....',
    '..nnmmmmmmmddmmmmmmmnn..',
    '.ndmmmmmmmmddmmmmmmmmdn.',
    '.nmmmmmmmmmddmmmmmmmmmn.',
    '.nmmmmmmmdmmmmdmmmmmmmn.',
    '.nmlmmmmmdmdmmdmmmmmlmn.',
    'nmmlhldmmdmddmdmmdlhlmmn',
    'nddhhldmmdmddmdmmdlhhddn',
    'ndmmmmmdmdmddmdmdmmmmmdn',
    'ndmmdmmdmdmnnmdmdmmdmmdn',
    'nmmndmmdnnffffnndmmdnmmn',
    'ndmndmmmkkfkkfkkkmmdnmdn',
    '.nmnmmkkkkkkkkkkkkmmnmn.',
    '.nmnmfkkkkkkkkkkkkfmnmn.',
    '.ndnfkkkkkkkkkkkkkkfndn.',
    '.ndddn............ndddn.',
    '..ndn..............ndn..',
    '..ndf..............fdn..',
    '..nn................nn..',
    '...n................n...',
]
OIL_HAIR_SIDE = [   # 側面第 3 排複製了一排（使用者要頭髮再往下一格；整張下移會露出頭頂的頭皮，所以改成把頭髮拉高 1 排）
    '........nnnnnnnnnn........',
    '....nnnnddmmmmmmmmnnn.....',
    '...nddmmmmmmddddnndddn....',
    '..nmmmmmmmmmmmmmmmmmmmnn..',
    '..nmmmmmmmmmmmmmmmmmmmnn..',
    '.nddmmmmmmmmmmmmmmmddddn..',
    '.nmmmmmmmllmddmmmddmmmnnn.',
    'nmmmmmmmmmmddmmmmmmmmmmmn.',
    'nmmmmmdmmmmdmmmddmmmmmmdn.',
    'nmdhhmdmmmmmmmmmmmhhhmmdn.',
    'nmdhhmhhhmdhhmmmhmhhhmmnnn',
    'nmdmmmhhhmdhhmmhhmmmmmdddn',
    '.ndmmmmmmmnmmmmmmmmmmmmmdn',
    '.ndnnmmmmmnmmmmmmdmmmmmddn',
    '.nnmckkkkfffkmmmmdmmmmmmdn',
    '.n.ckkkkkkkkkkmmmdmmmmddmn',
    '...ckkkkkkkkkkmmmdmmdmdddn',
    '...ckkkkkkkkkkmmmndmdmdddn',
    '....ckkkkkkkkkkmmndmddddn.',
    '....ckk.....kkkfmdddddddn.',
    '..............kfnndddddn..',
    '...............f.ndddddn..',
    '...............f.ndddnnn..',
    '..................nnn..n..',
    '..................n.n.....',
]
OIL_HAIR_BACK = [
    '........nnnnnnnn........',
    '......nnmddnnddmnn......',
    '....nnmmmmdmmdmmmmnn....',
    '..nnmmmmmmmddmmmmmmmnn..',
    '.ndllmmmmmmddmmmmmmlldn.',
    '.nmmmmmmmmmddmmmmmmmmmn.',
    '.nmmmmmmmmmllmmmmmmmmmn.',
    'nnmlmmmmmmmddmmmmmmmlmnn',
    'ndmlhmdmmmmddmmmmdmhlmdn',
    'nddhhmdmmmmddmmmmdmhhddn',
    'ndmmmmdmmmmmmmmmmdmmmmdn',
    'ndmmdmdmmmmllmmmmdmdmmdn',
    'nmmndmdmmmmmmmmmmdmdnmmn',
    'ndmndmdmmmmmmmmmmdmdnmdn',
    '.nmnmmdmmmlmmlmmmdmmnmn.',
    '.nmnmmdmmmlmmlmmmdmmnmn.',
    '.ndnmmddmdmmmmdmddmmndn.',
    '.nddmmddmdmmmmdmddmmddn.',
    '..ndmmdnmdmmmmdmndmmdn..',
    '..ndmmdndmmmmmmdndmmdn..',
    '..ndmdmnddmllmddnmdmdn..',
    '...nddddddddddddddddn...',
    '....nndnmdmmmmdmndnn....',
    '......nnddnddnddnn......',
    '.......nnnnddnnnn.......',
    '..........nnnn..........',
]


def oil_hair_sheet(sheets):
    return hair_style_sheet(sheets, {'down': OIL_HAIR_FRONT, 'up': OIL_HAIR_BACK, 'left': OIL_HAIR_SIDE}, center=True, side_dx=0, top_row=0, side_dy=2, side_shadow_dy=-1)   # 側面：頭頂往下 2 排；地圖第 3 排多複製一排所以下面的髮際線再往下 1 排，額頭陰影（k／f／c）用 side_shadow_dy 抵回去留在原位（2026-11-23 使用者：油頭側面太高；陰影維持原位、頭髮再往下一格）


def _hex(c):
    return '#%02x%02x%02x' % tuple(c[:3])


def dye_rules(sheets):
    """引擎 own.dye 要的規則：[{slot, layers, colors}]；colors 第一個是主色，其餘是該層實際用到的顏色（含外框變暗的色），
    換色時依 亮度／主色亮度 的比例縮放（見 main.js dyeSheet）。"""
    out = []
    for slot, d in DYE_SLOTS.items():
        used = {}
        img = sheets[d['layer']]
        for row in img.px:
            for c in row:
                if c is not None and (d['only'] is None or any(max(abs(c[i] - t[i]) for i in range(3)) == 0 for t in d['only'])):
                    used[tuple(c[:3])] = True
        main = C[d['main']]
        cols = [main] + sorted((c for c in used if c != main), key=lambda c: -_lum(c))
        out.append(dict(slot=slot, layers=[d['layer']] + d.get('also', []), colors=[_hex(c) for c in cols]))
    return out


def main():
    """除錯用：輸出每個圖層的 sheet 與疊起來的預覽（四個方向×三格）到指定資料夾。"""
    outdir = sys.argv[1] if len(sys.argv) > 1 else 'school_out'
    os.makedirs(outdir, exist_ok=True)
    sheets = build_sheets()
    for n in LAYERS:
        write_png(os.path.join(outdir, 'human2_%s.png' % n), sheets[n], 1)
    prev = Img(SHEET_W, 4 * CELL)
    for i, row in enumerate((8, 9, 10, 11)):
        for n in LAYERS:
            for y in range(CELL):
                for x in range(SHEET_W):
                    c = sheets[n].px[row * CELL + y][x]
                    if c is not None:
                        prev.px[i * CELL + y][x] = c
    write_png(os.path.join(outdir, 'human2_check.png'), prev, 2, bg=(220, 220, 220))
    print('ok', outdir, '換色規則：', [(r['slot'], len(r['colors'])) for r in dye_rules(sheets)])


if __name__ == '__main__':
    main()
