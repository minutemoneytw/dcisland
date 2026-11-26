"""忍者套裝（忍者服／忍者褲／忍者靴）的像素資料（2026-11-25，使用者給的忍者參考圖：黑衣、紅圍巾、紅腰帶、肩甲、護腕、紮腳褲、紅棕靴）。

做法：幾何（9 格的輪廓、肩寬、袖子、手、腿）直接沿用男式西裝（gen_male.DATA，素體對位好的那份），
逐字母換成忍者的配色，再用規則疊上忍者的特徵：
  上衣：紅圍巾（領口一圈，正面＋側面往後飄一條、背面中間垂一條）、紅腰帶（腰一圈，正面垂一條帶牌）、肩甲（金屬灰）、護腕（手的上緣兩排纏布）、
        領口的交襟改成深色內衣；
  褲子：深紫褐色寬褲，褲口往下接腳踝的纏布；
  靴子：紅棕色，上緣一圈淡色綁帶。
輸出格式與 gen_male.male_sheets() 相同（832×1856，只填走路列；右＝左的鏡像）。要改哪個特徵就改下面對應的函式；顏色集中在最上面。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
from gen_male import DATA, WALK_COLS, ROW, CH as MCH

# ---------- 顏色 ----------
def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

CLOTH = ramp((26, 22, 30), (92, 82, 98))          # 衣服／褲子的深色階（a 最暗 … g 最亮）
PANTS = ramp((32, 26, 34), (104, 90, 104))
BOOT = ramp((56, 24, 32), (160, 78, 78))
METAL = ramp((60, 62, 78), (186, 190, 204), 5)     # 肩甲
RED = dict(d=(86, 20, 28), m=(124, 30, 40), l=(164, 48, 56))   # 圍巾／腰帶
TAN = dict(d=(98, 82, 70), m=(150, 130, 108), l=(190, 170, 146))   # 護腕／纏布／綁帶／帶牌
UNDER = {'h': (50, 44, 56), 'i': (66, 58, 72), 'j': (88, 78, 96), 'k': (110, 100, 118)}   # 領口交襟（原本男式西裝的襯衫）
SKIN = 'lmn'


def _base(ch, kind):
    """男式西裝的字母 → 忍者配色（None＝透明）。a～g 暗到亮；h～k 襯衫；l～n 皮膚（手）。"""
    i = MCH.index(ch)
    if i <= 6:
        return {'top': CLOTH, 'bottom': PANTS, 'shoes': BOOT}[kind][i]
    return None


class Grid:
    """相對於 (x0, y0) 的點陣；可往上、往左延伸（負座標）。"""
    def __init__(self, x0, y0, rows, kind):
        self.x0, self.y0, self.kind = x0, y0, kind
        self.src = {}                                  # (x, y) → 原字母
        self.px = {}                                   # (x, y) → 顏色
        for y, line in enumerate(rows):
            for x, ch in enumerate(line):
                if ch == '.':
                    continue
                self.src[(x, y)] = ch
                if ch in SKIN:
                    self.px[(x, y)] = {'l': (255, 232, 210), 'm': (222, 178, 160), 'n': (179, 152, 148)}[ch]
                elif ch in UNDER:
                    self.px[(x, y)] = UNDER[ch]
                else:
                    self.px[(x, y)] = _base(ch, kind)
        self.h = len(rows)

    def row_ext(self, y):
        xs = [x for (x, yy) in self.px if yy == y]
        return (min(xs), max(xs)) if xs else None

    def put(self, x, y, c, over=True):
        if over or (x, y) not in self.px:
            self.px[(x, y)] = c

    def hline(self, a, b, y, c, over=True):
        for x in range(a, b + 1):
            self.put(x, y, c, over)

    def out(self):
        return {(x + self.x0, y + self.y0): c for (x, y), c in self.px.items()}


def _bracers(g):
    """手的上緣兩排改成護腕：最上一排深色綁帶、第二排淡色纏布（手的下半還是皮膚）。"""
    skin = {p for p, ch in g.src.items() if ch in SKIN}
    for (x, y) in sorted(skin):
        up = 0
        while (x, y - 1 - up) in skin:
            up += 1
        if up == 0:
            g.px[(x, y)] = TAN['d']
        elif up == 1:
            g.px[(x, y)] = TAN['m']
        elif up == 2 and (x, y + 1) in skin:
            g.px[(x, y)] = TAN['l']


def _pauldrons(g, ys=(1, 2, 3, 4)):
    """肩甲：肩的外側 5 欄換成金屬灰（上緣最亮）。側面只做近側的肩。"""
    for n, y in enumerate(ys):
        a, b = g.row_ext(y)
        if g.kind == 'left':
            spans = [(a + 2, a + 6)]
        else:
            spans = [(a, a + 4), (b - 4, b)]
        for lo, hi in spans:
            for x in range(lo, hi + 1):
                if (x, y) in g.px and g.src.get((x, y)) not in SKIN:
                    t = 4 - n if n < 4 else 0
                    v = g.src.get((x, y), 'd')
                    k = MCH.index(v) if v in MCH and MCH.index(v) <= 6 else 3
                    g.px[(x, y)] = METAL[min(4, max(0, (k * 4) // 6 + (1 if n == 0 else 0)))]
        # 下緣一道深色
    a, b = g.row_ext(ys[-1])


def _scarf(g, cx):
    k = g.kind
    R = RED
    if k in ('front', 'back'):
        for y, (w, c) in enumerate(((5, R['l']), (6, R['m']))):
            g.hline(cx - w, cx + w - 1, y, c)
        g.hline(cx - 6, cx + 5, 1, R['m'])
        g.put(cx - 6, 1, R['d']); g.put(cx + 5, 1, R['d'])
        g.hline(cx - 5, cx + 4, 2, R['d'])               # 圍巾下緣的陰影
        if k == 'front':
            # 結＋垂在右肩前的一條尾巴（往下 6 排，尾端缺一角）
            tx = cx + 2
            for y in range(2, 8):
                w = 3 if y < 6 else 2
                g.hline(tx, tx + w - 1, y, R['m'] if y % 2 else R['l'])
                g.put(tx + w - 1, y, R['d'])
        else:
            # 背面：中間垂一條長尾（往下 10 排，尾端三角缺口）
            for y in range(2, 12):
                g.hline(cx - 1, cx + 1, y, R['m'] if y % 3 else R['l'])
                g.put(cx + 1, y, R['d'])
            g.put(cx, 11, R['d']); g.px.pop((cx - 1, 11), None); g.px.pop((cx + 1, 11), None)
    else:
        # 側面（臉朝左）：脖子一圈＋尾巴往後（右）飄成一條斜帶
        a, b = g.row_ext(0) if g.row_ext(0) else (cx - 3, cx + 3)
        g.hline(cx - 3, cx + 2, 0, R['l'])
        g.hline(cx - 4, cx + 3, 1, R['m'])
        g.hline(cx - 3, cx + 2, 2, R['d'])
        for i, y in enumerate(range(1, 7)):
            g.hline(cx + 3 + i // 2, cx + 5 + i // 2, y + (1 if i else 0), R['m'] if i % 2 else R['l'])
            g.put(cx + 5 + i // 2, y + (1 if i else 0), R['d'])


def _sash(g, ys):
    """腰帶：torso 寬度（用下襬那排的左右界）一圈，2 排；正面垂一條帶牌。"""
    a, b = g.hem
    R, T = RED, TAN
    if g.kind == 'left':
        a, b = a, b - 1
    for n, y in enumerate(ys):
        g.hline(a, b, y, R['l'] if n == 0 else R['m'])
    g.hline(a, b, ys[-1] + 1, R['d'])
    g.put(a, ys[0], R['d']); g.put(b, ys[0], R['d'])
    if g.kind == 'front':
        cx = (a + b) // 2
        for i, y in enumerate(range(ys[-1] + 2, ys[-1] + 8)):
            g.hline(cx - 1, cx + 1, y, R['m'])
            g.put(cx - 1, y, R['d']); g.put(cx + 1, y, R['d'])
            if 1 <= i <= 3:
                g.put(cx, y, T['l'] if i != 2 else T['m'])
    elif g.kind == 'back':
        cx = (a + b) // 2
        for i, y in enumerate(range(ys[-1] + 2, ys[-1] + 5)):
            g.hline(cx - 1, cx, y, R['m']); g.put(cx - 1, y, R['d'])
    else:
        for i, y in enumerate(range(ys[-1] + 2, ys[-1] + 5)):
            g.hline(b - 1, b, y, R['m']); g.put(b, y, R['d'])


def ninja_top(kind, x0, y0, rows):
    # 先在最上面補一排（圍巾比原本的上衣高一排）
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    g.hem = g.row_ext(g.h - 1)
    cx = (g.hem[0] + g.hem[1]) // 2
    _bracers(g)
    hands = {p: g.px[p] for p, ch in g.src.items() if ch in SKIN}      # 護腕之後的手：最後蓋回去（側面的腰帶、圍巾尾巴不要遮住手）
    _pauldrons(g)
    # 領口交襟：正面中間的襯衫條換成深色內衣（_base 已處理）；腰帶位置＝手的位置往上一點
    sash_y = g.h - 7 if kind != 'left' else g.h - 8
    _sash(g, (sash_y, sash_y + 1))
    _scarf(g, cx)
    for p, c in hands.items():
        g.px[p] = c
    return g.out()


def ninja_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    n = g.h
    # 褲口的腳踝纏布：最後兩排淡色纏布＋上面一排深色綁線
    for (x, y), ch in list(g.src.items()):
        if y == n - 2:
            g.px[(x, y)] = TAN['m']
        elif y == n - 1:
            g.px[(x, y)] = TAN['d']
    return g.out()


def ninja_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = TAN['m']                     # 靴口的綁帶
        elif y == 1:
            g.px[(x, y)] = BOOT[3]
    return g.out()


def ninja_sheets():
    """回傳 {'top': Img, 'bottom': Img, 'shoes': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': ninja_top, 'bottom': ninja_bottom, 'shoes': ninja_shoes}
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in fns}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            for nm, fn in fns.items():
                x0, y0, rows = DATA[(kind, step)][nm]
                for (x, y), c in fn(kind, x0, y0, rows).items():
                    if c is None:
                        continue
                    px = x + 16
                    if d == 'right':
                        px = 63 - px
                    for col in cols:
                        out[nm].px[row * gs.CELL + y][col * gs.CELL + px] = c
    return out
