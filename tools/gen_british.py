"""英倫風格外觀（報童帽／格紋披肩外套／長褲／皮靴）的像素資料（2026-11-27，使用者給的英倫偵探例圖：棕色格紋八角報童帽＋帽帶金扣、
格紋短披肩外套＋米白滾邊、胸前酒紅背心＋白襯衫領＋領帶、深棕長褲反摺褲管、棕色皮靴）。這是「外觀」（glam，不是職業裝備）。

做法同 gen_bard.py：幾何（9 格的輪廓、肩寬、袖子、手、腿）沿用男式西裝（gen_male.DATA），逐字母換成英倫配色，再用規則疊特徵：
  外套（top 層）：整件棕色格紋（底色三階＋米色格線每 5 欄／4 排一道）；肩膀到胸口一圈較亮的格紋短披肩，下緣米白滾邊、左右多出 1 格的披肩角；
                  正面中間（男式的襯衫領口）＝白襯衫領＋酒紅領帶＋酒紅背心（金釦）；袖口一排米白；背面＝整片格紋＋棕色腰帶金扣；
  長褲：深棕灰，褲管最後兩排反摺（淺一階）；靴子：棕色皮靴，靴口一排淺棕；
  帽子（hat 層）：八角報童帽——蓬起的格紋圓頂＋頂上小釦＋棕色帽帶（金扣）＋短帽舌（正面小、側面往前伸）；位置跟著頭走（用素體的頭定位）。
輸出格式與 gen_bard.bard_sheets() 相同（top／bottom／shoes／hat 四層）。顏色集中在最上面。
"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_body as gb
from gen_male import DATA, WALK_COLS, ROW, CH as MCH


def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

TWEED = ramp((44, 30, 26), (168, 136, 112))          # 格紋外套／帽子的棕色（0 最暗 … 6 最亮）；dye 的主色＝TWEED[3]
PANTS = ramp((30, 24, 24), (118, 100, 92))           # 深棕灰長褲
BOOT = ramp((36, 22, 16), (150, 100, 66))            # 棕色皮靴
CREAM = dict(d=(190, 168, 140), m=(226, 208, 178), l=(250, 242, 222))   # 格線、滾邊、襯衫領
VEST = dict(d=(86, 22, 30), m=(128, 34, 42), l=(172, 56, 58))           # 酒紅背心／領帶
GOLD = dict(d=(128, 96, 56), m=(190, 150, 90), l=(236, 204, 140))       # 金釦、帽帶扣
BAND = dict(d=(52, 34, 26), m=(86, 58, 40), l=(122, 86, 58))            # 皮帶、帽帶（棕色皮革）
OUT = (30, 20, 18)                                                      # 帽子外框
SKIN = 'lmn'
SHIRT = {'h': (206, 196, 176), 'i': (222, 212, 192), 'j': (236, 228, 208), 'k': (246, 240, 224)}


def plaid(x, y, base, light=False):
    """格紋：base＝TWEED 的第幾階（2～4）；每 5 欄一道直線、每 4 排一道橫線＝米色細格線（交叉處最亮）。"""
    v = (x % 5 == 2)
    h = (y % 4 == 1)
    c = TWEED[base]
    if v and h:
        return CREAM['m']
    if v or h:
        return TWEED[min(6, base + 2)] if not light else CREAM['d']
    return c


def _src_idx(ch):
    return MCH.index(ch)


class Grid:
    def __init__(self, x0, y0, rows, kind):
        self.x0, self.y0, self.kind = x0, y0, kind
        self.src = {}
        self.px = {}
        for y, line in enumerate(rows):
            for x, ch in enumerate(line):
                if ch == '.':
                    continue
                self.src[(x, y)] = ch
        self.h = len(rows)
        self.hands = {}

    def row_ext(self, y):
        xs = [x for (x, yy) in self.src if yy == y]
        return (min(xs), max(xs)) if xs else None

    def out(self):
        return {(x + self.x0, y + self.y0): c for (x, y), c in self.px.items()}


def british_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    ext = g.row_ext(g.h - 1)
    cx = (ext[0] + ext[1]) // 2
    for (x, y), ch in g.src.items():
        i = _src_idx(ch)
        if ch in SKIN:
            g.px[(x, y)] = gb_skin(ch)
        elif ch in SHIRT:
            g.px[(x, y)] = SHIRT[ch]
        else:
            # 外套本體：男式外套的 a（描邊）→ 最暗；b/c＝暗面；d＝中間色；e,f,g＝亮面
            if ch == 'a':
                g.px[(x, y)] = TWEED[0]
            elif ch == 'b':
                g.px[(x, y)] = plaid(x, y, 2)
            elif ch == 'c':
                g.px[(x, y)] = plaid(x, y, 3)
            elif ch == 'd':
                g.px[(x, y)] = plaid(x, y, 3) if (x - cx) >= 0 else plaid(x, y, 4)
            else:
                g.px[(x, y)] = plaid(x, y, 4)
    # 披肩：肩膀到胸口 6 排，較亮的格紋；下緣米白滾邊（最後一排）；左右各多 1 格的披肩角（第 5、6 排）
    CAPE = 6
    for y in range(CAPE):
        e = g.row_ext(y)
        if not e:
            continue
        for x in range(e[0], e[1] + 1):
            if (x, y) in g.px and g.src.get((x, y)) not in SKIN and g.src.get((x, y)) not in SHIRT:
                g.px[(x, y)] = plaid(x, y, 4 if x <= cx else 3)
    e = g.row_ext(CAPE - 1)
    if e:
        for x in range(e[0], e[1] + 1):
            if (x, CAPE - 1) in g.px and g.src.get((x, CAPE - 1)) not in SKIN and g.src.get((x, CAPE - 1)) not in SHIRT:
                g.px[(x, CAPE - 1)] = CREAM['m'] if x <= cx else CREAM['d']
        if kind != 'left':                                   # 披肩角：正面／背面左右各外凸 1 格
            for y in (CAPE - 2, CAPE - 1):
                for x in (e[0] - 1, e[1] + 1):
                    if (x, y) not in g.px and (x, y) not in g.src:
                        g.px[(x, y)] = CREAM['m'] if y == CAPE - 1 else TWEED[0]
    # 袖口：手上面 1 排換米白（正面／背面兩隻手、側面一隻手）
    skin = [(x, y) for (x, y), ch in g.src.items() if ch in SKIN and y >= 8]
    for (x, y) in skin:
        for dy in (-1,):
            p = (x, y + dy)
            if p in g.px and g.src.get(p) not in SKIN and g.src.get(p) not in SHIRT:
                g.px[p] = CREAM['m']
    # 正面／側面：襯衫領口（白領）＋領帶＋背心（原本男式的襯衫那條）
    shirt = sorted((p for p, ch in g.src.items() if ch in SHIRT))
    if kind in ('front', 'left') and shirt:
        for (x, y) in shirt:
            if y <= 3:
                g.px[(x, y)] = CREAM['l'] if y <= 1 else CREAM['m']          # 襯衫領
            else:
                g.px[(x, y)] = VEST['l'] if (x - cx) <= 0 else VEST['m']      # 酒紅背心
        if kind == 'front':
            for (x, y) in shirt:
                if 2 <= y <= 6 and x in (cx, cx + 1) or (y in (2, 3) and abs(x - cx) <= 1):
                    pass
            for y in range(2, 7):                                              # 領帶：中間 1～2 格酒紅
                for x in (cx, cx + 1):
                    if (x, y) in g.px and g.src.get((x, y)) in SHIRT:
                        g.px[(x, y)] = VEST['d'] if y % 2 else VEST['m']
            for y in (8, 11, 14):                                              # 背心的金釦
                for x in (cx, cx + 1):
                    if (x, y) in g.px and g.src.get((x, y)) in SHIRT:
                        g.px[(x, y)] = GOLD['l']
                        break
    if kind == 'back':
        by = g.h - 8                                                          # 背面：棕色腰帶＋金扣
        a, b = g.row_ext(by) or (cx - 6, cx + 6)
        for x in range(a + 1, b):
            if (x, by) in g.px:
                g.px[(x, by)] = BAND['l']
            if (x, by + 1) in g.px:
                g.px[(x, by + 1)] = BAND['m']
        for x in (cx, cx + 1):
            if (x, by) in g.px:
                g.px[(x, by)] = GOLD['l']
            if (x, by + 1) in g.px:
                g.px[(x, by + 1)] = GOLD['m']
    if kind == 'left':
        by = g.h - 8
        a, b = g.row_ext(by) or (cx - 5, cx + 5)
        for x in range(a + 1, b):
            if (x, by) in g.px and g.src.get((x, by)) not in SKIN:
                g.px[(x, by)] = BAND['l']
                if (x, by + 1) in g.px and g.src.get((x, by + 1)) not in SKIN:
                    g.px[(x, by + 1)] = BAND['m']
    # 手最後蓋回去（保持男式的手）
    for (x, y), ch in g.src.items():
        if ch in SKIN:
            g.px[(x, y)] = gb_skin(ch)
    return g.out()


_SKIN_COL = {'l': (255, 232, 210), 'm': (222, 178, 160), 'n': (179, 152, 148)}
def gb_skin(ch):
    return _SKIN_COL[ch]


def british_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    for (x, y), ch in g.src.items():
        i = min(6, _src_idx(ch))
        g.px[(x, y)] = PANTS[i]
    n = g.h
    for (x, y), ch in g.src.items():                        # 褲管反摺：最後兩排淺一階，上緣一條淺線
        if y == n - 2:
            g.px[(x, y)] = PANTS[5]
        elif y == n - 1:
            g.px[(x, y)] = PANTS[4]
        elif y == n - 3:
            g.px[(x, y)] = PANTS[1]
    return g.out()


def british_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    for (x, y), ch in g.src.items():
        i = min(6, _src_idx(ch))
        g.px[(x, y)] = BOOT[i]
        if y == 0:
            g.px[(x, y)] = BOOT[5]                            # 靴口一排淺棕
        elif y == 1:
            g.px[(x, y)] = BOOT[3]
    return g.out()


# ---------- 帽子 ----------
def _head_box(kind, step):
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top):
    """八角報童帽：帽帶（3 排，緊貼頭）＋蓬起的格紋圓頂（帽帶上面 6 排，比頭寬 1～2 格）＋頂上小釦；帽舌：正面小片、側面往前伸 4 格。"""
    center = {'front': cx, 'back': cx, 'left': cx + 1.5}[kind]
    band_y = top + 5                          # 帽帶第一排（共 3 排：top+5、top+6、top+7，剛好壓在眉毛上方）
    sil = {}
    HW_BAND = 10.0                            # 帽帶半寬（頭約 9）
    for i in range(3):
        for x in range(round(center - HW_BAND), round(center + HW_BAND) + 1):
            sil[(x, band_y + i)] = ('band', i, x - center, HW_BAND)
    CROWN = 9
    for r in range(CROWN):                    # 圓頂：由下（r=CROWN-1，最寬）往上收，上緣微圓
        t = (r + 1) / CROWN
        hw = 3.5 + 8.0 * (t ** 0.62)
        for x in range(round(center - hw), round(center + hw) + 1):
            sil[(x, band_y - CROWN + r)] = ('crown', r, x - center, hw)
    peak = {}
    if kind == 'front':                       # 正面帽舌：帽帶下緣中間 2 排小片（深棕皮革）
        for i in range(2):
            hw = 6 - i * 2
            for x in range(round(center - hw), round(center + hw) + 1):
                peak[(x, band_y + 3 + i)] = i
    elif kind == 'left':                      # 側面帽舌：從帽帶往前（左）伸出 5 格，2～3 排
        for i, ln in enumerate((6, 5, 3)):
            for x in range(round(center - HW_BAND) - ln + 4, round(center - HW_BAND) + 5):
                peak[(x, band_y + 1 + i)] = i
    for p in peak:
        sil[p] = ('peak', peak[p], 0, 0)
    out = {}
    for (x, y), (part, i, dx, hw) in sil.items():
        if part == 'crown':
            base = 4 if dx < -hw * 0.25 else (3 if dx < hw * 0.35 else 2)
            if i <= 1:
                base = min(6, base + 1)
            elif i >= 7:
                base = max(1, base - 1)                      # 帽帶上緣的陰影
            out[(x, y)] = plaid(x, y, base)
        elif part == 'band':
            out[(x, y)] = BAND['l'] if i == 0 else (BAND['m'] if i == 1 else BAND['d'])
        else:
            out[(x, y)] = BAND['m'] if i == 0 else BAND['d']
    # 頂上小釦（圓頂最上排中央）
    for dx in (0, 1):
        if (round(center) + dx, band_y - CROWN) in sil:
            out[(round(center) + dx, band_y - CROWN)] = TWEED[1]
    # 金扣：正面＝帽帶左側、側面＝帽帶靠近帽舌處；背面＝帽帶後方的小扣環
    if kind == 'front':
        fx = round(center - 7)
        for (dx, dy, c) in ((0, 0, GOLD['l']), (1, 0, GOLD['m']), (0, 1, GOLD['m'])):
            out[(fx + dx, band_y + 1 + dy)] = c
    elif kind == 'left':
        fx = round(center - 6)
        for (dx, dy, c) in ((0, 0, GOLD['l']), (1, 0, GOLD['m']), (0, 1, GOLD['m']), (1, 1, GOLD['d'])):
            out[(fx + dx, band_y + dy)] = c
    else:
        out[(round(center), band_y + 1)] = GOLD['m']; out[(round(center) + 1, band_y + 1)] = GOLD['d']
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = OUT
    return out


def british_sheets():
    fns = {'top': british_top, 'bottom': british_bottom, 'shoes': british_shoes}
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in list(fns) + ['hat']}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            cells = {}
            for nm, fn in fns.items():
                x0, y0, rows = DATA[(kind, step)][nm]
                cells[nm] = {(x + 16, y): c for (x, y), c in fn(kind, x0, y0, rows).items() if c is not None}
            cx, top = _head_box(kind, step)
            cells['hat'] = hat_pixels(kind, cx, top)
            for nm, cell in cells.items():
                for (x, y), c in cell.items():
                    px = 63 - x if d == 'right' else x
                    if not (0 <= px < 64 and 0 <= y < 64):
                        continue
                    for col in cols:
                        out[nm].px[row * gs.CELL + y][col * gs.CELL + px] = c
    return out
