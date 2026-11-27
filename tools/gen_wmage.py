"""白魔法師套裝（白魔法師帽／白魔法師長袍／長褲／靴子）的像素資料（2026-11-26，使用者給的白魔法師例圖：米白長袍加紅色披肩與紅色前襟〔金十字〕、棕色腰帶、
寬帽沿尖頂白帽＋紅色帽帶與金十字、棕色手套、棕色靴）。這是白魔法師職業的「裝備」（jobs.json 的 gear；keepGear），不是外觀。

做法同黑魔法師 gen_blm.py（複製過來換配色與特徵）：幾何沿用男式西裝（gen_male.DATA），逐字母換配色再疊特徵：
  長袍（top 層）：肩膀金邊、袖口紅色、棕色手套、高領、正面／背面中間一條紅色前襟（金邊＋金十字）、棕色腰帶＋金扣、下襬往下接長（整片白色、下襬一道金邊、最下一排露出紅色襯裡）；
  長褲：灰棕色（長袍下面只露出一小截）；靴子：棕色，靴口淡色一圈；
  帽子（hat 層，另一張 sheet）：寬帽沿＋尖頂（尖往後彎）＋紅色帽帶（正面有金色十字），位置跟著頭走。
輸出格式同 gen_blm（wm_sheets() 回 top／bottom／shoes／hat 四層）。顏色集中在最上面。
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

ROBE = ramp((206, 184, 172), (255, 250, 240))         # 長袍的深色階（a 最暗 … g 最亮）
PANTS = ramp((84, 68, 62), (176, 154, 136))
BOOT = ramp((58, 36, 30), (158, 112, 84))
UNDER = {'h': (122, 32, 40), 'i': (146, 40, 48), 'j': (168, 52, 58), 'k': (190, 70, 70)}   # 領口交襟＝紅色前襟
GLOVE = {'l': (120, 84, 66), 'm': (92, 62, 50), 'n': (66, 44, 38)}                        # 手（棕色手套）
GOLD = dict(d=(158, 112, 66), m=(212, 164, 96), l=(246, 214, 150))
RED = dict(d=(104, 26, 34), m=(150, 40, 48), l=(188, 64, 64))
BELT = dict(d=(70, 46, 38), m=(104, 70, 52))
OUT = (150, 108, 98)   # 長袍的輪廓線（白色衣服用暖棕）
CAPE = dict(d=(104, 26, 34), m=(150, 40, 48), l=(188, 64, 64))   # 紅色披肩／襯裡
GEM = dict(m=(212, 164, 96), l=(246, 214, 150))
SKIN = 'lmn'
HAT = dict(a=(142, 100, 92), b=(226, 208, 194), c=(244, 234, 222), d=(255, 250, 242), p=(150, 40, 48), g=GOLD['m'], G=GOLD['l'], q=GEM['m'])


def _base(ch, kind):
    i = MCH.index(ch)
    if i <= 6:
        if kind == 'top':
            i = (2, 2, 3, 3, 4, 4, 5)[i]      # 長袍：只用中亮的幾階，輪廓線（最暗）才分得出來（2026-11-26 使用者要求輪廓線明顯一點）
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
                    self.px[(x, y)] = ROBE[4] if kind == 'left' else UNDER[ch]   # 側面看不到前襟，用長袍的白色（不然會有紅色雜點）
                else:
                    self.px[(x, y)] = _base(ch, kind)
        self.h = len(rows)
        self.hands = {p: self.px[p] for p, ch in self.src.items() if ch in SKIN}    # 手套：最後蓋回去（側面的線條不要遮住手）

    def restore_hands(self):
        for p, c in self.hands.items():
            self.px[p] = c

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
                    g.px[(x, y)] = GOLD['l'] if n == 0 else (ROBE[5] if n == 1 else GOLD['d'])
    skin = {p for p, ch in g.src.items() if ch in SKIN}
    for (x, y) in skin:
        if (x, y - 1) not in skin:                       # 手套最上面一排之上＝袖口
            for dx in (-1, 0, 1):
                if (x + dx, y - 1) in g.px and g.src.get((x + dx, y - 1)) not in SKIN:
                    g.px[(x + dx, y - 1)] = RED['m']


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
        g.put(x, y, BELT['m']); g.put(x, y + 1, BELT['d']); g.put(x, y + 2, BELT['d'])
    if k == 'front':
        g.put(cx - 1, y + 1, GOLD['m']); g.put(cx, y + 1, GOLD['m']); g.put(cx - 1, y, GOLD['l']); g.put(cx, y, GOLD['l'])
        g.put(cx - 1, y + 2, GOLD['d']); g.put(cx, y + 2, GOLD['d'])
    elif k == 'back':
        g.put(cx - 1, y + 1, GOLD['l']); g.put(cx, y + 1, GOLD['l'])


def _skirt(g, cx, E=7):
    """長袍下襬往下接長 E 排：整片白色（越往下越外擴）、中間一條紅色前襟（金邊＋金十字）、下襬一道金邊。側面：前緣一條紅色前襟、後緣露出紅色襯裡。"""
    k = g.kind
    a, b = g.row_ext(g.h - 1)
    hy = g.h - 1
    for i in range(1, E + 1):
        y = hy + i
        fl = i // 3                                           # 越往下越外擴
        last = (i == E)
        if k in ('front', 'back'):
            for x in range(a - fl, b + fl + 1):
                edge = min(x - (a - fl), (b + fl) - x)
                c = ROBE[5] if x < cx else ROBE[4]
                if (x - cx) % 5 == 0 and not last:
                    c = ROBE[3]                               # 衣褶
                if edge == 0 and not last:
                    c = RED['d']                              # 外緣露一點紅色襯裡
                g.put(x, y, GOLD['m'] if last else c)
            if not last:
                for x in range(cx - 2, cx + 2):               # 紅色前襟（4 欄）
                    g.put(x, y, RED['m'] if x < cx + 1 else RED['d'])
                g.put(cx - 3, y, GOLD['m']); g.put(cx + 2, y, GOLD['d'])
            else:
                g.put(cx - 1, y, RED['d']); g.put(cx, y, RED['d'])
            for r, y2 in enumerate(range(hy + 1, hy + 6)):    # 金十字
                if r == 2:
                    for x in range(cx - 2, cx + 2):
                        g.put(x, y2, GOLD['l'])
                elif r < 5:
                    g.put(cx - 1, y2, GOLD['l']); g.put(cx, y2, GOLD['m'])
        else:   # 側面（臉朝左）：前片短、往後（右）飄
            lo = a + 2 - (1 if i > 2 else 0)
            hi = b + 2 + fl
            front_end = E - 2
            for x in range(lo, hi + 1):
                if i > front_end and x < cx + 1:
                    continue
                c = RED['d'] if hi - x == 0 else ROBE[4]
                if x - lo <= 1 and i > 0:
                    c = RED['m']                              # 前緣的紅色前襟
                if (x - cx) % 5 == 0:
                    c = ROBE[3] if c == ROBE[4] else c
                g.put(x, y, GOLD['m'] if last else c)
    g.h += E


def wm_top(kind, x0, y0, rows):
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
    g.restore_hands()
    return _outline(g.out(), ROBE, OUT)


def _outline(px, ramp, color):
    """輪廓線：這一層的邊緣像素（上下左右有透明的）如果是盔甲／袍子本身的色階，就換成 color（金邊、紅色披風這些裝飾色不動）。"""
    keep = set(ramp)
    out = dict(px)
    for (x, y), c in px.items():
        if c in keep and any((x + dx, y + dy) not in px for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = color
    return out


# ---------- 長褲、靴子 ----------
def wm_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    return g.out()


def wm_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = (196, 170, 140)                        # 靴口一圈淡色
        elif y == 1:
            g.px[(x, y)] = BOOT[4]
    return g.out()


# ---------- 帽子 ----------
def _head_box(kind, step):
    """素體的頭（前 18 排）在 sheet 格座標的左右界與頭頂排。"""
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top):
    """帽子的 {(x, y): 色}；cx＝頭的中心欄（小數）、top＝頭頂排（素體 body 的第一排）。帽子從 top-9 排開始：11 排尖頂＋5 排帽沿。"""
    R = {'front': 19.0, 'back': 19.0, 'left': 20.0}[kind]          # 帽沿半寬（2026-11-26 使用者要求左右各加寬 1；之後再要求加寬 2 格＝每邊再 +1，頭髮才不會像從帽子上長出來）
    lean = {'front': 2.0, 'back': -2.0, 'left': 5.0}[kind]           # 尖頂往哪邊彎（側面往後＝往右）
    center = {'front': cx, 'back': cx, 'left': cx + 2.0}[kind]
    y_top = top - 9                                                    # 2026-11-26 使用者要求帽子比原本（top-8）低 2 排；頭髮切掉的位置不變（款式的 hairCutDy）
    CONE = 11                                                           # 尖頂 11 排（2026-11-26 使用者要求整頂帽子往上移 3 排：帽沿從 top+5 變 top+2；頂端不能超出格子上緣〔頭頂 top 最小 9〕，所以尖頂比之前的 13 排少 2 排）
    sil = {}
    for r in range(CONE):
        hw = 1.0 + r * 0.9
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
            hw = 1.0 + i * 0.9
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
    if kind == 'front':                                       # 金十字：帽帶中間偏右（5 排高）
        mx = round(center) + 4
        for dy in range(-1, 4):
            out[(mx, bandy + dy)] = HAT['G']
            out[(mx + 1, bandy + dy)] = HAT['g']
        for dx in (-1, 2):
            out[(mx + dx, bandy + 1)] = HAT['G'] if dx < 0 else HAT['g']
        for (x, y) in [(mx + dx, bandy + dy) for dy in range(-1, 4) for dx in range(-1, 3)]:
            sil.setdefault((x, y), ('cone', 0, 0))
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HAT['a']
    return out


def _read_rgba(path):
    """讀 8 位元 RGBA PNG → Img（透明＝None）。tools/hand/ 裡的圖都存成 RGBA。"""
    import struct, zlib
    b = open(path, 'rb').read()
    pos, idat = 8, b''
    while pos < len(b):
        ln, = struct.unpack('>I', b[pos:pos + 4]); tag = b[pos + 4:pos + 8]; data = b[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if tag == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
        elif tag == b'IDAT':
            idat += data
    assert bd == 8 and ct == 6, '手畫圖要存成 8 位元 RGBA PNG（tools/hand/README.md）'
    raw = zlib.decompress(idat); stride = w * 4; prev = bytearray(stride); i = 0
    im = Img(w, h)
    for y in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0; up = prev[x]; c = prev[x - 4] if x >= 4 else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + up) & 255
            elif f == 3: line[x] = (line[x] + ((a + up) >> 1)) & 255
            elif f == 4:
                p = a + up - c; pa, pb, pc = abs(p - a), abs(p - up), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else (up if pb <= pc else c))) & 255
        prev = line
        for x in range(w):
            r, g, bb, al = line[x * 4:x * 4 + 4]
            im.px[y][x] = None if al == 0 else ((r, g, bb) if al == 255 else (r, g, bb, al))
    return im


# ---------- 組成 sheet ----------
HAND_TOP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand', 'wmage_top_human.png')   # 使用者給的長袍圖（走路列 9 欄×4 方向，在整張 sheet 的 (20, 538) 起），疊在舊版上存成整張 RGBA；改圖直接改這個檔再重跑 gen_assets.py

def wm_sheets():
    """回傳 {'top','bottom','shoes','hat': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': wm_top, 'bottom': wm_bottom, 'shoes': wm_shoes}
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
    if os.path.exists(HAND_TOP):      # 使用者手畫的人類白魔法師長袍（2026-11-27）：整張換成他畫的（矮人、巨人由它縮放而來），不再用上面的規則畫
        out['top'] = _read_rgba(HAND_TOP)
    return out
