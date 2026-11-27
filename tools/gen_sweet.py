"""甜美風格套裝（甜心小帽／甜心罩衫洋裝／甜心層疊裙／甜心蝴蝶結靴）的像素資料（2026-11-28，使用者給的甜美風格例圖：巧克力棕與粉色的洛麗塔風——
粉色泡泡袖罩衫＋大圓領＋胸前蝴蝶結、棕色吊帶背心裙〔正面兩條吊帶＋愛心扣、背面交叉吊帶＋腰後大蝴蝶結〕、粉色荷葉邊層疊短裙、棕色長襪＋蝴蝶結靴、頭頂歪戴一頂小圓帽）。
這是「外觀」（glam，不是職業裝備）：每個職業都可以在外觀一覽選。

做法同忍者／白魔法師（gen_ninja.py／gen_wmage.py）：幾何沿用男式西裝（gen_male.DATA，素體對位好的那份），逐字母換成粉色罩衫，再用規則疊特徵：
  上衣（top 層）：粉色罩衫（手臂泡泡袖、袖口荷葉邊）、大圓領（領緣荷葉邊）、胸前粉色蝴蝶結、棕色背心裙（正面吊帶＋愛心；背面交叉吊帶＋腰後大蝴蝶結）；
  裙子（bottom 層）：棕色裙＋兩圈粉色荷葉邊（扇形下緣），小腿是棕色長襪（上緣粉色荷葉邊）；
  鞋子（shoes 層）：棕色圓頭靴，靴口粉色荷葉邊，腳踝側邊蝴蝶結；
  帽子（hat 層）：棕色小圓帽（中間一圈粉色帶），歪戴在頭頂右後方，不遮頭髮。
輸出格式同 gen_ninja（sweet_sheets() 回 top／bottom／shoes／hat 四層）。顏色集中在最上面。
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

PINK = ramp((218, 164, 172), (255, 238, 234))          # 罩衫的粉色階（0 最暗 … 6 最亮）
BROWN = ramp((46, 30, 36), (120, 88, 90))              # 背心裙／短裙／靴子的棕色階
OUT = (88, 54, 62)                                      # 輪廓線（暖棕紅）
BOW = dict(d=(206, 120, 142), m=(240, 160, 180), l=(255, 200, 212))   # 蝴蝶結／愛心
SKIN = 'lmn'
SKINC = {'l': (255, 232, 210), 'm': (222, 178, 160), 'n': (179, 152, 148)}
PINK_IDX = (1, 2, 3, 3, 4, 5, 5)                        # 男式外套 a～g → 罩衫粉色階


class Grid:
    """相對於 (x0, y0) 的點陣；可往上、往左右、往下延伸（負座標／超出）。"""
    def __init__(self, x0, y0, rows, kind, ramp_=None, idx=None, drop_skin=False, cx_hint=None):
        self.x0, self.y0, self.kind = x0, y0, kind
        self.src, self.px = {}, {}
        for y, line in enumerate(rows):
            for x, ch in enumerate(line):
                if ch == '.':
                    continue
                i = MCH.index(ch)
                if drop_skin and (ch in SKIN or (i >= 7 and cx_hint is not None and abs(x - cx_hint) > 5)):
                    continue                  # 正面走路格：男式資料的手臂是影像抽出來的零碎像素（會破圖），改用素體自己的手
                self.src[(x, y)] = ch
                if ch in SKIN:
                    self.px[(x, y)] = SKINC[ch]
                elif i <= 6 and ramp_:
                    self.px[(x, y)] = ramp_[(idx or range(7))[i]]
                elif ramp_:
                    self.px[(x, y)] = ramp_[5]          # 男式襯衫（h～k）→ 亮色
        self.h = len(rows)

    def row_ext(self, y):
        xs = [x for (x, yy) in self.px if yy == y]
        return (min(xs), max(xs)) if xs else None

    def put(self, x, y, c):
        self.px[(x, y)] = c

    def hline(self, a, b, y, c):
        for x in range(a, b + 1):
            self.px[(x, y)] = c

    def out(self):
        return {(x + self.x0, y + self.y0): c for (x, y), c in self.px.items()}


def _outline(px, ramps, color):
    """輪廓線：這一層的邊緣像素（上下左右有透明的）如果是罩衫／棕色的色階，就換成 color（蝴蝶結、皮膚這些不動）。"""
    keep = set()
    for r in ramps:
        keep |= set(r)
    out = dict(px)
    for (x, y), c in px.items():
        if c in keep and any((x + dx, y + dy) not in px for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = color
    return out


# ---------- 上衣 ----------
def _bow(g, x, y, big=False):
    """蝴蝶結（x＝中心偏左欄、y＝上排）：兩個圈＋中間的結＋兩條尾巴。big＝背面腰後的大蝴蝶結。"""
    w = 3 if big else 2
    for r in range(3 if not big else 4):
        for dx in range(w):
            g.put(x - 1 - dx, y + r, BOW['m'] if r % 2 == 0 else BOW['l'])
            g.put(x + 2 + dx, y + r, BOW['m'] if r % 2 == 0 else BOW['l'])
        g.put(x - 1 - w + 1, y + r, BOW['d']) if r == 1 else None
    for r in range(1, (3 if not big else 4) - 1):
        g.put(x, y + r, BOW['d']); g.put(x + 1, y + r, BOW['d'])
    g.put(x, y + 1, BOW['m']); g.put(x + 1, y + 1, BOW['d'])
    ty = y + (3 if not big else 4)
    for r in range(3 if big else 2):
        g.put(x - 1 + (r > 0) * 0, ty + r, BOW['m']); g.put(x + 2, ty + r, BOW['m'])
    return


def _heart(g, x, y):
    for (dx, dy) in ((-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1), (0, 2)):
        g.put(x + dx, y + dy, BOW['m'] if dy < 1 else BOW['l'])
    g.put(x, y + 1, BOW['d'])


def sweet_top(kind, x0, y0, rows, step=0):
    drop = kind == 'front' and step != 0
    hx = [x for x, ch in enumerate(rows[-1]) if ch != '.']
    g = Grid(x0, y0, rows, 'top', PINK, PINK_IDX, drop, (min(hx) + max(hx)) // 2)
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    h = g.h
    # 袖口荷葉邊：每個手（皮膚）的上方兩排改成白粉相間的荷葉邊
    skin = {p for p, ch in g.src.items() if ch in SKIN}
    for (x, y) in sorted(skin):
        if (x, y - 1) not in skin:
            for dy in (1, 2):
                for dx in (-1, 0, 1):
                    q = (x + dx, y - dy)
                    if q in g.px and q not in skin:
                        g.px[q] = PINK[6] if (x + dx + dy) % 2 == 0 else PINK[4]
    bx0, bx1 = (cx - 5, cx + 4) if kind != 'left' else (cx - 3, cx + 4)
    # 棕色背心裙：胸下（第 7 排）到下襬
    top_r = 8 if kind != 'back' else 9
    for y in range(top_r, h):
        for x in range(bx0, bx1 + 1):
            if (x, y) in g.px and g.src.get((x, y)) not in SKIN:
                g.px[(x, y)] = BROWN[3] if (x + y) % 5 else BROWN[4]
    for x in range(bx0, bx1 + 1):                                   # 上緣粉色滾邊
        if (x, top_r) in g.px:
            g.px[(x, top_r)] = PINK[6]
    for y in range(h - 2, h):                                         # 下襬一圈深色
        for x in range(bx0, bx1 + 1):
            if (x, y) in g.px and g.src.get((x, y)) not in SKIN:
                g.px[(x, y)] = BROWN[1]
    # 吊帶
    if kind == 'front':
        for y in range(2, top_r):
            for x in (cx - 4, cx - 3, cx + 2, cx + 3):
                g.put(x, y, BROWN[3] if x in (cx - 3, cx + 2) else BROWN[2])
        _heart(g, cx - 4, top_r + 3)
        _heart(g, cx + 3, top_r + 3)
    elif kind == 'back':
        for i in range(0, 8):                                         # 交叉吊帶
            y = 2 + i
            for t in (0, 1):
                g.put(cx - 5 + i + t, y, BROWN[3] if t else BROWN[2])
                g.put(cx + 4 - i - t, y, BROWN[3] if t else BROWN[2])
        _bow(g, cx - 1, h - 6, True)
    else:
        for y in range(2, top_r):
            g.put(cx - 1, y, BROWN[2]); g.put(cx, y, BROWN[3])
        _bow(g, cx + 5, h - 5)
    # 大圓領＋領緣荷葉邊
    cw = {'front': (6, 7, 8), 'back': (6, 7, 8), 'left': (4, 5, 5)}[kind]
    for i, w in enumerate(cw):
        y = i
        lo, hi = (cx - w, cx + w - 1) if kind != 'left' else (cx - w + 1, cx + w)
        for x in range(lo, hi + 1):
            if kind == 'front' and i < 2 and abs(x - cx + 0.5) < 1.6:
                continue                                              # 領口留脖子
            g.px[(x, y)] = PINK[6] if (x + y) % 2 == 0 else PINK[5]
    lo, hi = (cx - cw[-1], cx + cw[-1] - 1) if kind != 'left' else (cx - cw[-1] + 1, cx + cw[-1])
    for x in range(lo, hi + 1, 2):                                    # 領緣扇形
        g.px[(x, 3)] = PINK[4]
    if kind == 'front':
        _bow(g, cx - 1, 3)
    return _outline(g.out(), (PINK, BROWN), OUT)


# ---------- 裙子（含長襪） ----------
def sweet_bottom(kind, x0, y0, rows, step=0):
    g = Grid(x0, y0, rows, 'bottom', BROWN, (1, 2, 3, 3, 4, 4, 5))
    h = g.h
    e0 = g.row_ext(0)
    cx = (e0[0] + e0[1]) // 2
    # 先整個清掉（只留最後兩排當長襪的腿形），再畫裙子
    legs = {p: c for p, c in g.px.items() if p[1] >= h - 2}
    g.px = {}
    ext_in = (lambda i: (cx - 8 - i // 2, cx + 7 + i // 2)) if kind != 'left' else (lambda i: (cx - 6 - i // 3, cx + 6 + i // 3))
    for i in range(0, 9):                                              # 裙子 9 排：棕、棕、棕、粉荷葉、棕、棕、棕、棕、粉荷葉
        lo, hi = ext_in(i + (1 if i >= 4 else 0))
        for x in range(lo, hi + 1):
            if i in (3, 8):
                c = PINK[6] if (x + i) % 2 == 0 else PINK[5]
                g.px[(x, i)] = c
            else:
                g.px[(x, i)] = BROWN[3] if (x * 3 + i) % 7 else BROWN[4]
        if i in (3, 8):                                                # 扇形下緣
            for x in range(lo, hi + 1, 2):
                g.px[(x, i + 1)] = PINK[4] if i == 3 else PINK[3]
    for (x, y), c in legs.items():                                     # 小腿：棕色長襪＋上緣粉色荷葉邊
        g.px[(x, y)] = BROWN[2] if y == h - 1 else PINK[5]
    return _outline(g.out(), (PINK, BROWN), OUT)


# ---------- 鞋子 ----------
def sweet_shoes(kind, x0, y0, rows, step=0):
    g = Grid(x0, y0, rows, 'shoes', BROWN, (1, 2, 3, 3, 4, 4, 5))
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = PINK[6] if x % 2 == 0 else PINK[4]          # 靴口荷葉邊
    if kind in ('front', 'back'):
        xs = sorted(x for (x, y) in g.px if y == 1)
        if xs:
            for xx in (xs[0] + 1, xs[-1] - 2):                         # 腳踝兩側的小蝴蝶結
                g.put(xx, 1, BOW['m']); g.put(xx + 1, 1, BOW['d'])
    else:
        xs = sorted(x for (x, y) in g.px if y == 1)
        if xs:
            g.put(xs[0] + 2, 1, BOW['m']); g.put(xs[0] + 3, 1, BOW['d'])
    return _outline(g.out(), (BROWN,), OUT)


# ---------- 帽子 ----------
def _head_box(kind, step):
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top):
    """棕色小圓帽（中間偏下一圈粉色帶），斜戴在頭頂：正面／背面偏右、右邊低；側面偏後、前面低。橢圓 17×9，轉 16°。"""
    hc = {'front': cx + 3.0, 'back': cx + 3.0, 'left': cx + 1.5}[kind]
    ang = {'front': 0.28, 'back': 0.28, 'left': -0.28}[kind]
    rx, ry = 8.3, 4.4
    yc = top - 1.0
    ca, sa = math.cos(ang), math.sin(ang)
    sil, out = set(), {}
    for y in range(int(yc - 9), int(yc + 10)):
        for x in range(int(hc - 11), int(hc + 12)):
            dx, dy = x - hc, y - yc
            u, v = dx * ca + dy * sa, -dx * sa + dy * ca
            if (u / rx) ** 2 + (v / ry) ** 2 > 1.0:
                continue
            sil.add((x, y))
            if v < -ry * 0.55:
                c = BROWN[5]
            elif v < 0.0:
                c = BROWN[3]
            elif v < ry * 0.2:
                c = BROWN[3]
            elif v < ry * 0.62:
                c = PINK[6] if (round(u) % 4 == 0) else PINK[5]
            else:
                c = BROWN[1]
            out[(x, y)] = c
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = OUT
    return out


# ---------- 組成 sheet ----------
def sweet_sheets():
    """回傳 {'top','bottom','shoes','hat': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': sweet_top, 'bottom': sweet_bottom, 'shoes': sweet_shoes}
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in list(fns) + ['hat']}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            cells = {}
            for nm, fn in fns.items():
                x0, y0, rows = DATA[(kind, step)][nm]
                cells[nm] = {(x + 16, y): c for (x, y), c in fn(kind, x0, y0, rows, step).items() if c is not None}
            if step == 0 and kind in ('front', 'back'):                  # 待機的正面／背面左右對稱（取左半邊鏡射到右半邊；格子中線在 x＝31.5）
                for nm in ('top', 'bottom', 'shoes'):
                    cell = cells[nm]
                    for (x, y), c in list(cell.items()):
                        if x <= 31:
                            cell[(63 - x, y)] = c
                    for (x, y) in [p for p in cell if p[0] >= 32 and (63 - p[0], p[1]) not in cell]:
                        del cell[(x, y)]
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
