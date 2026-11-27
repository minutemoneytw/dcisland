"""街頭寬鬆風格外觀套裝（街頭毛帽／寬鬆夾克／工作寬褲／厚底球鞋）的像素資料（2026-11-28，使用者給的街頭風格例圖：深灰毛帽加米色綁帶與扣環、
耳邊吊一塊米色名牌、米色寬鬆連帽夾克〔深色連帽領、斜背帶、側背小包〕、深色寬鬆工作褲〔米色側條、口袋〕、米色厚底球鞋）。
這是「外觀」（glam，不是職業裝備）：每個職業都可以在外觀一覽選。

做法同甜心套裝 gen_sweet.py（沒有手畫的圖，全部程式畫）：幾何沿用男式西裝（gen_male.DATA），逐字母換配色再疊特徵：
  上衣（top 層）：米色寬鬆夾克（手套的位置改成寬袖口）、深色連帽領（脖子一圈往下垂）、正面中間露出深色內搭、斜背帶（右肩到左腰，金屬扣）、側面／背面一個小側背包；
  褲子（bottom 層）：喇叭褲——男式褲子上面不變、往下每排撐開到左右各 4 格（側面站姿 2 格、側面走路 1 格：腿是斜的，橫向撐開會多出很多格），深灰色＋米色側條＋口袋方框；
  鞋子（shoes 層）：男式鞋子換米色，厚底（底一排最亮）；
  帽子（hat 層）：深灰色毛帽（直紋）＋米色綁帶與扣環，帽沿往下蓋住額頭上緣，耳邊吊米色名牌。
輸出格式同 gen_sweet（street_sheets() 回 top／bottom／shoes／hat 四層）。顏色集中在最上面。
"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_body as gb
from gen_male import DATA, WALK_COLS, ROW, CH as MCH


def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

BEIGE = ramp((150, 128, 108), (244, 230, 204))          # 夾克／球鞋／綁帶的米色階（0 最暗 … 6 最亮）
DARK = ramp((34, 30, 34), (108, 94, 92))                # 毛帽／褲子／連帽領的深灰色階
OUT = (50, 40, 42)                                      # 輪廓線
METAL = (190, 180, 168)                                 # 扣環
SKIN = 'lmn'
BEIGE_IDX = (1, 2, 3, 3, 4, 5, 5)


class Grid:
    def __init__(self, x0, y0, rows, kind, ramp_, idx, skin_to=None):
        self.x0, self.y0, self.kind = x0, y0, kind
        self.src, self.px = {}, {}
        for y, line in enumerate(rows):
            for x, ch in enumerate(line):
                if ch == '.':
                    continue
                self.src[(x, y)] = ch
                i = MCH.index(ch)
                if ch in SKIN:
                    if skin_to is not None:
                        self.px[(x, y)] = skin_to
                elif i <= 6:
                    self.px[(x, y)] = ramp_[idx[i]]
                else:
                    self.px[(x, y)] = ramp_[5]
        self.h = len(rows)

    def row_ext(self, y):
        xs = [x for (x, yy) in self.px if yy == y]
        return (min(xs), max(xs)) if xs else None

    def put(self, x, y, c):
        self.px[(x, y)] = c

    def out(self):
        return {(x + self.x0, y + self.y0): c for (x, y), c in self.px.items()}


def _outline(px, ramps, color):
    keep = set()
    for r in ramps:
        keep |= set(r)
    out = dict(px)
    for (x, y), c in px.items():
        if c in keep and any((x + dx, y + dy) not in px for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = color
    return out


def _dilate(px, n, h=None):
    """水平往左右各膨脹 n 格（只補空格，顏色用原本那格的）。h 有給時是喇叭褲：第 y 排膨脹 n×y÷(h-1) 格（上窄下寬）。"""
    out = dict(px)
    for (x, y), c in px.items():
        k = n if h is None else (n * y) // max(1, h - 1)
        for d in range(1, k + 1):
            out.setdefault((x - d, y), c)
            out.setdefault((x + d, y), c)
    return out


# ---------- 上衣 ----------
def street_top(kind, x0, y0, rows, right=False):
    g = Grid(x0, y0, rows, 'top', BEIGE, BEIGE_IDX, skin_to=BEIGE[2])           # 手的位置改成寬袖口（米色）
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    h = g.h
    # 寬袖口：手那幾排的最下一排加深色束口
    skin = {p for p, ch in g.src.items() if ch in SKIN}
    for (x, y) in skin:
        if (x, y + 1) not in skin:
            g.px[(x, y)] = DARK[3]
    # 正面：中間的襯衫條（h～k）改深色內搭
    for (x, y), ch in g.src.items():
        if ch in 'hijk':
            g.px[(x, y)] = DARK[1] if kind == 'front' else BEIGE[4]
    # 連帽領：脖子一圈（深色），正面往下垂兩條帽帶；背面是垂下的帽子
    cw = {'front': (5, 6, 7, 7), 'back': (5, 6, 7, 7), 'left': (3, 4, 5, 5)}[kind]
    for i, w in enumerate(cw):
        lo, hi = (cx - w, cx + w - 1) if kind != 'left' else (cx - w + 1, cx + w)
        for x in range(lo, hi + 1):
            if kind == 'front' and i < 2 and abs(x - cx + 0.5) < 2:
                g.px[(x, i)] = DARK[1]
                continue
            g.px[(x, i)] = DARK[3] if (x + i) % 3 else DARK[4]
    if kind == 'back':
        for i in range(4, 8):                                                 # 帽子垂在背上
            w = 6 - (i - 4)
            for x in range(cx - w, cx + w):
                g.px[(x, i)] = DARK[3] if (x + i) % 3 else DARK[2]
    if kind == 'front':
        for y in range(4, 9):
            g.px[(cx - 3, y)] = DARK[3]; g.px[(cx + 2, y)] = DARK[3]
    # 斜背帶：正面／側面從右肩（畫面左）到左腰；背面反過來；金屬扣
    if kind == 'front':
        for i in range(0, 12):
            g.px[(cx - 4 + i, 4 + i)] = DARK[2]; g.px[(cx - 3 + i, 4 + i)] = DARK[3]
        g.px[(cx + 1, 9)] = METAL; g.px[(cx + 2, 9)] = METAL
    elif kind == 'back':
        for i in range(0, 12):
            g.px[(cx + 3 - i, 4 + i)] = DARK[2]; g.px[(cx + 4 - i, 4 + i)] = DARK[3]
    elif not right:                                                          # 朝右時背帶在身體另一側，看不到
        for i in range(0, 10):
            g.px[(cx - 2 + i // 2, 4 + i)] = DARK[2]
    # 側背小包：側面／背面在腰側
    bx = {'left': cx + 3, 'back': cx - 6, 'front': cx - 7}[kind]
    by = h - 7
    for yy in range(4):
        for xx in range(4):
            g.px[(bx + xx, by + yy)] = DARK[3] if yy else BEIGE[2]
    g.px[(bx + 1, by + 1)] = METAL
    # 正面袖子與身體之間的輪廓線（比外框淡一點的深色，讓袖子輪廓明顯）
    if kind == 'front':
        a_, b_ = hem
        for y in range(7, h - 1):                                           # 第 6、7 排（y＝5、6）不畫：那兩排中間跟袖子之間不要輪廓線
            for x in (a_ - 1, b_ + 1):
                if (x, y) in g.px and g.px[(x, y)] in BEIGE:
                    g.px[(x, y)] = (92, 74, 66)
    # 不要筒狀：肩膀與袖子中段往外撐 1 格（寬鬆蓬袖）、下襬往下越來越寬（A 字，最多 2 格）、下襬一圈深色束帶、正面拉鍊與口袋
    if kind in ('front', 'back'):
        for y in range(5, h - 4):
            xs = [x for (x, yy) in g.px if yy == y]
            if xs:
                lo, hi = min(xs), max(xs)
                g.px[(lo - 1, y)] = g.px[(lo, y)]; g.px[(hi + 1, y)] = g.px[(hi, y)]
    for i, y in enumerate(range(h - 4, h)):
        xs = [x for (x, yy) in g.px if yy == y and (g.src.get((x, y)) or '.') not in SKIN]
        if xs and kind != 'left':
            lo, hi = min(xs), max(xs)
            for d in range(1, 1 + (i + 1) // 2 + (1 if i == 3 else 0)):
                g.px[(lo - d, y)] = g.px[(lo, y)]; g.px[(hi + d, y)] = g.px[(hi, y)]
        elif xs:
            lo, hi = min(xs), max(xs)
            for d in range(1, 1 + (i + 1) // 2 + 1):
                g.px[(lo - d, y)] = g.px[(lo, y)]
            for d in range(1, 2 + i):
                g.px[(hi + d, y)] = g.px[(hi, y)]
    for x in range(cx - 8, cx + 8):                                          # 下襬束帶
        if (x, h - 2) in g.px:
            g.px[(x, h - 2)] = DARK[3]
    if kind == 'front':
        for y in range(5, h - 2):                                            # 拉鍊
            g.px[(cx - 1, y)] = DARK[2]
        for sgn in (-1, 1):                                                  # 口袋斜線
            for i in range(3):
                g.px[(cx + sgn * (5 - i) - (1 if sgn < 0 else 0), h - 7 + i)] = DARK[2]
    # 夾克下襬：深色束邊
    for x in range(cx - 10, cx + 10):
        if (x, h - 1) in g.px:
            g.px[(x, h - 1)] = BEIGE[1]
    return _outline(g.out(), (BEIGE, DARK), OUT)


# ---------- 褲子 ----------
def street_bottom(kind, x0, y0, rows, step=0):
    g = Grid(x0, y0, rows, 'bottom', DARK, (1, 2, 3, 3, 4, 4, 5))
    px = _dilate(g.px, 4 if kind != 'left' else (2 if step == 0 else 1), g.h)                                  # 喇叭褲：上面維持男式褲子的寬度，往下每排慢慢撐開到左右各 4 格
    # 米色側條：每排每一段的最外側往內第 2 格
    out = dict(px)
    for y in range(g.h):
        xs = sorted(x for (x, yy) in px if yy == y)
        if not xs:
            continue
        segs, cur = [], [xs[0]]
        for x in xs[1:]:
            if x - cur[-1] > 1:
                segs.append(cur); cur = []
            cur.append(x)
        segs.append(cur)
        for sg in segs:
            if len(sg) >= 6:
                out[(sg[1], y)] = BEIGE[3] if y % 3 else BEIGE[2]
                out[(sg[-2], y)] = BEIGE[2] if kind != 'left' else out[(sg[-2], y)]
    # 口袋：每條腿大腿外側一個方框（米色細線）
    segs0 = []
    xs = sorted(x for (x, yy) in px if yy == 3)
    cur = [xs[0]]
    for x in xs[1:]:
        if x - cur[-1] > 1:
            segs0.append(cur); cur = []
        cur.append(x)
    segs0.append(cur)
    for sg in segs0:
        if len(sg) >= 8:
            px0 = sg[2] if kind != 'left' else sg[1]
            for xx in range(px0, px0 + 4):
                out[(xx, 2)] = BEIGE[1]; out[(xx, 5)] = BEIGE[1]
            for yy in range(2, 6):
                out[(px0, yy)] = BEIGE[1]; out[(px0 + 3, yy)] = BEIGE[1]
    return _outline({(x + x0, y + y0): c for (x, y), c in out.items()}, (DARK, BEIGE), OUT)


# ---------- 鞋子 ----------
def street_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes', BEIGE, (2, 3, 4, 4, 5, 5, 6))
    px = g.px
    out = dict(px)
    h = g.h
    for (x, y) in list(px):
        if y == h - 1:
            out[(x, y)] = BEIGE[6]                      # 厚底（最亮一排）
        elif y == h - 2:
            out[(x, y)] = BEIGE[1]                      # 底上緣的陰影
        elif y == 0:
            out[(x, y)] = DARK[3] if x % 2 else DARK[2] # 鞋帶／鞋口
    return _outline({(x + x0, y + y0): c for (x, y), c in out.items()}, (BEIGE, DARK), OUT)


# ---------- 帽子（毛帽） ----------
def _head_box(kind, step):
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top, right=False):
    """深灰色毛帽：圓頂（top-4 起）往下蓋到額頭上緣（top+6），直紋；下緣一條米色綁帶（3 排，有扣環），耳邊垂米色名牌（5 排）。"""
    hc = cx + (1.5 if kind == 'left' else 0.0)
    prof = (4.5, 8.0, 10.5, 12.0, 13.0, 13.5, 13.5, 13.5, 14.0, 14.0, 14.0)   # 圓頂（上窄下寬）＋最下面 5 排是反折的帽緣（比帽身再寬 0.5）
    y0 = top - 4
    cuff0 = top + 2                                                          # 反折帽緣從這排開始（到 top+6）
    sil, out = set(), {}
    for i, w in enumerate(prof):
        y = y0 + i
        lo, hi = hc - w, hc + w
        if kind == 'left' and y < cuff0:                                      # 側面：帽頂往後（右）垮一點
            hi += 1.5 + (cuff0 - y) * 0.2
        if kind == 'back' and y < cuff0:
            lo -= 0.5; hi += 0.5
        for x in range(round(lo), round(hi) + 1):
            sil.add((x, y))
            u = x - round(hc)
            if y >= cuff0:                                                    # 帽緣：橫向羅紋（每排深淺交替）＋立體的上緣亮線
                c = DARK[4] if y == cuff0 else (DARK[3] if (y + x) % 2 == 0 else DARK[2])
                if y == top + 6:
                    c = DARK[1]
            else:                                                             # 帽身：直向羅紋，兩排一組錯開（針織）
                c = DARK[3] if (u + (y // 2)) % 3 else DARK[2]
                if y - y0 < 2:
                    c = DARK[4] if (u + y) % 2 else DARK[3]
                elif u < -w * 0.4 and (u + y) % 4 == 0:
                    c = DARK[4]                                               # 左上的反光
            out[(x, y)] = c
    # 米色綁帶：壓在帽緣中間 3 排（比帽緣窄 1 格），扣環
    for y in range(top + 3, top + 6):
        for x in range(round(hc - 13), round(hc + 13) + 1):
            if (x, y) in sil:
                out[(x, y)] = BEIGE[4] if y == top + 4 else (BEIGE[3] if y == top + 3 else BEIGE[2])
    bx = round(hc) + (3 if kind == 'front' else (-3 if kind == 'back' else 0))     # 扣環
    for yy in range(top + 3, top + 6):
        for xx in range(bx, bx + 3):
            if (xx, yy) in sil:
                out[(xx, yy)] = METAL if (xx, yy) != (bx + 1, top + 4) else DARK[1]
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = OUT
    if right:                                                              # 名牌在人物的左側：朝右時看到的是右側，沒有名牌
        return out
    tx = {'front': round(hc) + 12, 'back': round(hc) - 13, 'left': round(hc) - 1}[kind]   # 耳邊的名牌
    for yy in range(top + 8, top + 13):
        for xx in (tx, tx + 1):
            out[(xx, yy)] = BEIGE[5] if xx == tx else BEIGE[4]
        out[(tx - 1, yy)] = OUT; out[(tx + 2, yy)] = OUT
    out[(tx, top + 7)] = OUT; out[(tx + 1, top + 7)] = OUT
    out[(tx, top + 13)] = OUT; out[(tx + 1, top + 13)] = OUT
    return out


# ---------- 組成 sheet ----------
def street_sheets():
    """回傳 {'top','bottom','shoes','hat': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': street_top, 'bottom': street_bottom, 'shoes': street_shoes}
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in list(fns) + ['hat']}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            cells = {}
            for nm, fn in fns.items():
                x0, y0, rows = DATA[(kind, step)][nm]
                kw = {'right': d == 'right'} if nm == 'top' else ({'step': step} if nm == 'bottom' else {})
                cells[nm] = {(x + 16, y): c for (x, y), c in fn(kind, x0, y0, rows, **kw).items() if c is not None}
            cx, top = _head_box(kind, step)
            cells['hat'] = hat_pixels(kind, cx, top, right=(d == 'right'))
            for nm, cell in cells.items():
                for (x, y), c in cell.items():
                    px = 63 - x if d == 'right' else x
                    if not (0 <= px < 64 and 0 <= y < 64):
                        continue
                    for col in cols:
                        out[nm].px[row * gs.CELL + y][col * gs.CELL + px] = c
    return out
