"""黑魔法師套裝（黑魔法師帽／黑魔法師長袍／長褲／靴子）的像素資料（2026-11-26，使用者給的黑魔法師例圖：深藍黑底、金邊、紫色披風、
寬帽沿的尖帽＋金色月亮帽帶、高領、肩甲、腰帶紫寶石、靴子金邊）。這是黑魔法師職業的「裝備」（jobs.json 的 gear；keepGear），不是外觀。

做法（同忍者 gen_ninja.py）：幾何（9 格的輪廓、肩寬、袖子、手、腿）直接沿用男式西裝（gen_male.DATA，素體對位好的那份），
逐字母換成黑魔法師的配色，再用規則疊上特徵：
  長袍（top 層）：手改成深色手套；肩甲與袖口金邊；高領（脖子兩側／後面往上翹）；正面中間的襯衫條兩側鑲金邊；腰帶＋紫寶石（正面垂一條帶牌）；
                  下襬往下接長（正面左右兩片＋中間露出褲子、側面往後飄、背面整片加金色菱形圖案），外緣是紫色披風，下襬一道金邊；
  長褲：深紫黑，每條腿外緣一條金線；
  靴子：深紫黑，靴口一圈金邊＋正面一顆紫寶石；
  帽子（hat 層，另一張 sheet）：寬帽沿＋尖頂（尖往後彎）＋紫色帽帶（正面有金色月亮），位置跟著頭走（用素體的頭定位）。
輸出格式與 gen_male.male_sheets() 相同（832×1856，只填走路列；右＝左的鏡像）；blm_sheets() 回 top／bottom／shoes／hat 四層。顏色集中在最上面。
"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_body as gb
from gen_male import DATA, WALK_COLS, ROW, CH as MCH

# ---------- 顏色 ----------
def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

ROBE = ramp((20, 16, 34), (112, 98, 146))         # 長袍的深色階（a 最暗 … g 最亮）
PANTS = ramp((22, 18, 36), (92, 80, 120))
BOOT = ramp((20, 16, 30), (84, 70, 104))
UNDER = {'h': (38, 30, 56), 'i': (54, 42, 78), 'j': (72, 58, 100), 'k': (90, 74, 122)}   # 領口交襟的內衣
GLOVE = {'l': (68, 56, 78), 'm': (46, 38, 58), 'n': (30, 24, 40)}                        # 手（深色手套）
GOLD = dict(d=(128, 92, 58), m=(188, 144, 92), l=(236, 200, 140))
CAPE = dict(d=(60, 42, 98), m=(92, 66, 140), l=(128, 98, 182))
GEM = dict(m=(158, 102, 228), l=(214, 176, 255))
SKIN = 'lmn'
HAT = dict(a=(16, 12, 28), b=(34, 28, 54), c=(54, 44, 82), d=(82, 68, 116), p=(92, 62, 142), g=GOLD['m'], G=GOLD['l'], q=GEM['m'])


def _base(ch, kind):
    i = MCH.index(ch)
    if i <= 6:
        return {'top': ROBE, 'bottom': PANTS, 'shoes': BOOT}[kind][i]
    return None


class Grid:
    """相對於 (x0, y0) 的點陣；可往上、往左右、往下延伸（負座標／超出）。"""
    def __init__(self, x0, y0, rows, kind):
        self.x0, self.y0, self.kind = x0, y0, kind
        self.src = {}
        self.px = {}
        for y, line in enumerate(rows):
            for x, ch in enumerate(line):
                if ch == '.':
                    continue
                self.src[(x, y)] = ch
                if ch in SKIN:
                    self.px[(x, y)] = GLOVE[ch]
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


# ---------- 長袍 ----------
def _shoulders(g):
    """肩甲＋袖口：肩外側四欄（最上三排）金邊，袖子接手套的那一排金色袖口。"""
    for n, y in enumerate((1, 2, 3)):
        e = g.row_ext(y)
        if not e:
            continue
        a, b = e
        spans = [(a + 2, a + 5)] if g.kind == 'left' else [(a, a + 3), (b - 3, b)]
        for lo, hi in spans:
            for x in range(lo, hi + 1):
                if (x, y) in g.px and g.src.get((x, y)) not in SKIN:
                    g.px[(x, y)] = GOLD['l'] if (n == 0) else (GOLD['m'] if (x + n) % 2 == 0 else GOLD['d'])
    skin = {p for p, ch in g.src.items() if ch in SKIN}
    for (x, y) in skin:
        if (x, y - 1) not in skin:                       # 手套最上面一排之上＝袖口
            for dx in (-1, 0, 1):
                if (x + dx, y - 1) in g.px and g.src.get((x + dx, y - 1)) not in SKIN:
                    g.px[(x + dx, y - 1)] = GOLD['m']


def _collar(g, cx):
    """高領：脖子兩側（側面＝脖子後面）往上翹 2 排，上緣金邊。"""
    k = g.kind
    if k == 'front':
        for dy, (w0, w1) in ((-2, (5, 7)), (-1, (4, 7))):
            for sgn in (-1, 1):
                for w in range(w0, w1 + 1):
                    x = cx + (w if sgn > 0 else -w - 1)
                    g.put(x, dy, ROBE[2] if sgn < 0 else ROBE[1])
        g.hline(cx - 8, cx - 6, -2, GOLD['m']); g.hline(cx + 5, cx + 7, -2, GOLD['m'])
    elif k == 'back':
        for dy in (-2, -1):
            g.hline(cx - 6, cx + 5, dy, ROBE[2] if dy == -1 else ROBE[3])
        g.hline(cx - 6, cx + 5, -2, GOLD['m'])
    else:
        for dy in (-2, -1):
            g.hline(cx + 1, cx + 5, dy, ROBE[2] if dy == -1 else ROBE[3])
        g.hline(cx + 1, cx + 5, -2, GOLD['m'])


def _opening(g, cx):
    """正面：襯衫條（交襟）兩側鑲金邊。"""
    if g.kind != 'front':
        return
    for y in range(0, g.h):
        xs = [x for (x, yy), ch in g.src.items() if yy == y and ch in 'hijk']
        if xs:
            g.put(min(xs) - 1, y, GOLD['m'])
            g.put(max(xs) + 1, y, GOLD['d'])


def _belt(g, cx, y):
    """腰帶（兩排）：深色帶＋上下金邊；正面中間一顆紫寶石，垂一條帶牌。"""
    k = g.kind
    if k == 'left':
        a, b = cx - 5, cx + 5
    else:
        a, b = cx - 6, cx + 5
    for x in range(a, b + 1):
        g.put(x, y, GOLD['m']); g.put(x, y + 1, ROBE[1]); g.put(x, y + 2, GOLD['d'])
    if k == 'front':
        g.put(cx - 1, y + 1, GEM['m']); g.put(cx, y + 1, GEM['l']); g.put(cx - 1, y, GOLD['l']); g.put(cx, y, GOLD['l'])
        g.put(cx - 2, y + 1, GOLD['l']); g.put(cx + 1, y + 1, GOLD['l'])
    elif k == 'back':
        g.put(cx - 1, y + 1, GOLD['l']); g.put(cx, y + 1, GOLD['l'])


def _skirt(g, cx, E=7):
    """長袍下襬往下接長 E 排（比外套下襬再往下）。正面：左右兩片＋中間露出褲子；背面整片；側面前片短、後片長。"""
    k = g.kind
    a, b = g.row_ext(g.h - 1)
    hy = g.h - 1
    cl = CAPE['m']
    for i in range(1, E + 1):
        y = hy + i
        fl = i // 3                                           # 越往下越外擴
        last = (i == E)
        if k == 'front':
            for x in range(a - fl, b + fl + 1):
                if cx - 3 <= x <= cx + 2:
                    continue                                  # 中間留縫，露出褲子
                edge = min(abs(x - (a - fl)), abs(x - (b + fl)))
                c = CAPE['m'] if edge <= 2 else (ROBE[2] if x < cx else ROBE[1])
                if edge == 0 and not last:
                    c = CAPE['d']
                g.put(x, y, GOLD['m'] if last else c)
            g.put(cx - 3, y, GOLD['m']); g.put(cx + 2, y, GOLD['d'])   # 縫邊金線
            if i % 2 == 0:
                g.put(a - fl + 3, y, CAPE['l'])
        elif k == 'back':
            for x in range(a - fl, b + fl + 1):
                edge = min(abs(x - (a - fl)), abs(x - (b + fl)))
                c = CAPE['m'] if edge <= 2 else (ROBE[2] if x < cx else ROBE[1])
                g.put(x, y, GOLD['m'] if last else c)
            if (i % 2) == 0:
                g.put(a - fl + 3, y, CAPE['l'])
        else:   # 側面（臉朝左）：前片短、往後（右）飄
            lo = a + 2 - (1 if i > 2 else 0)
            hi = b + 2 + fl
            front_end = E - 2
            for x in range(lo, hi + 1):
                if i > front_end and x < cx + 1:
                    continue
                edge = hi - x
                c = CAPE['m'] if edge <= 2 else ROBE[2]
                g.put(x, y, GOLD['m'] if last else c)
            if i % 2 == 0:
                g.put(hi - 1, y, CAPE['l'])
    if k == 'back':                                           # 背面的金色菱形圖案
        for r, w in enumerate((1, 2, 3, 2, 1)):
            y = hy - 4 + r
            for x in range(cx - w + 1, cx + w):
                g.put(x, y, GOLD['m'] if (x + y) % 2 else GOLD['l'])
        for r in range(1, E):
            g.put(cx, hy + r, GOLD['d'] if r % 2 else GOLD['m'])   # 背中線
    g.h += E


def blm_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    _shoulders(g)
    _opening(g, cx)
    _collar(g, cx)
    by = g.h - 8
    _belt(g, cx, by)
    _skirt(g, cx)
    if kind == 'front':                                       # 帶牌（腰帶中間往下垂到下襬附近）
        for i, y in enumerate(range(by + 3, by + 9)):
            g.put(cx - 1, y, GOLD['d']); g.put(cx, y, GOLD['m'] if i % 2 else GOLD['l'])
            if i == 2:
                g.put(cx - 1, y, GEM['m']); g.put(cx, y, GEM['l'])
    return g.out()


# ---------- 長褲、靴子 ----------
def blm_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    for y in range(g.h):
        e = g.row_ext(y)
        if not e:
            continue
        a, b = e
        if kind == 'left':
            g.put(a, y, GOLD['d'])
        else:
            g.put(a, y, GOLD['d']); g.put(b, y, GOLD['m'])
    return g.out()


def blm_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = GOLD['m']                              # 靴口的金邊
        elif y == 1:
            g.px[(x, y)] = BOOT[3]
    if kind == 'front':
        ex = sorted(x for (x, y) in g.px if y == 2)
        if ex:
            g.put(ex[0] + 2, 2, GEM['m']); g.put(ex[-1] - 2, 2, GEM['m'])
    return g.out()


# ---------- 帽子 ----------
def _head_box(kind, step):
    """素體的頭（前 18 排）在 sheet 格座標的左右界與頭頂排。"""
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top):
    """帽子的 {(x, y): 色}；cx＝頭的中心欄（小數）、top＝頭頂排（素體 body 的第一排）。帽子從 top-9 排開始：11 排尖頂＋5 排帽沿。"""
    R = {'front': 16.5, 'back': 16.5, 'left': 17.5}[kind]          # 帽沿半寬（2026-11-26 使用者要求左右各加寬 1）
    lean = {'front': 2.0, 'back': -2.0, 'left': 5.0}[kind]           # 尖頂往哪邊彎（側面往後＝往右）
    center = {'front': cx, 'back': cx, 'left': cx + 2.0}[kind]
    y_top = top - 9                                                    # 2026-11-26 使用者要求帽子比原本（top-8）低 2 排；頭髮切掉的位置不變（款式的 hairCutDy）
    CONE = 11                                                           # 尖頂 11 排（2026-11-26 使用者要求整頂帽子往上移 3 排：帽沿從 top+5 變 top+2；頂端不能超出格子上緣〔頭頂 top 最小 9〕，所以尖頂比之前的 13 排少 2 排）
    sil = {}
    for r in range(CONE):
        hw = 1.0 + r * 0.6
        off = lean * (1 - r / (CONE - 1)) ** 1.6
        lo, hi = round(center + off - hw), round(center + off + hw)
        for x in range(lo, hi + 1):
            sil[(x, y_top + r)] = ('cone', r, x - (center + off))
    BR = 5
    for i in range(BR):
        t = (i - 2.0) / 2.6
        rx = R * math.sqrt(max(0.0, 1 - t * t))
        for x in range(round(center - rx), round(center + rx) + 1):
            sil[(x, y_top + CONE + i)] = ('brim', i, x - center)
    out = {}
    for (x, y), (part, i, dx) in sil.items():
        if part == 'cone':
            hw = 1.0 + i * 0.6
            if dx < -hw * 0.45:
                c = HAT['c']
            elif dx > hw * 0.35:
                c = HAT['b']
            else:
                c = HAT['b'] if i % 2 else HAT['c']
            if dx <= -hw + 0.9 and i > 1:
                c = HAT['d']                                    # 左緣的亮線
        else:
            c = HAT['d'] if i == 0 else (HAT['c'] if i == 1 else (HAT['b'] if i == 2 else HAT['a']))
            if i == 3:
                c = HAT['b']
        out[(x, y)] = c
    # 帽帶（尖頂下方 3 排：上下金線＋紫色帶；正面有金色月亮）
    bandy = y_top + CONE - 4
    for (x, y) in list(out):
        if bandy <= y <= bandy + 2 and sil[(x, y)][0] == 'cone':
            out[(x, y)] = HAT['g'] if y in (bandy, bandy + 2) else HAT['p']
    if kind == 'front':
        mx = round(center)
        for (dx, dy) in ((0, 1), (1, 1), (-1, 1), (-1, 0), (-1, 2), (0, 2)):
            if (mx + dx, bandy + dy) in out and dy == 1:
                out[(mx + dx, bandy + dy)] = HAT['G']
        out[(mx - 2, bandy + 1)] = HAT['G'] if (mx - 2, bandy + 1) in out else None
        for k in [k for k, v in out.items() if v is None]:
            del out[k]
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HAT['a']
    # 尖頂的金色小吊飾（正面／側面：尖端旁邊）
    if kind != 'back':
        tx = round(center + lean)
        for (dx, dy) in ((2, 1), (3, 2), (2, 3), (3, 3)):
            out[(tx + dx, y_top + dy)] = HAT['G'] if (dx, dy) != (3, 3) else HAT['g']
    return out


# ---------- 組成 sheet ----------
def blm_sheets():
    """回傳 {'top','bottom','shoes','hat': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': blm_top, 'bottom': blm_bottom, 'shoes': blm_shoes}
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
