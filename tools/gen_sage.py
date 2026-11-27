"""賢者套裝（賢者帽／賢者長外套／長褲／靴子）的像素資料（2026-11-27，使用者給的賢者例圖：米白貝雷帽＋深色帽帶＋青色水晶飾品與垂帶、
米白長外套〔前面敞開、青色滾邊、金色十字紋〕、深色內搭、腰帶掛青色玻璃管、深色手套與長褲、棕色靴）。這是賢者職業的「裝備」（jobs.json 的 gear；keepGear），不是外觀。

做法同白魔法師 gen_wmage.py（複製過來換配色與特徵）：幾何沿用男式西裝（gen_male.DATA），逐字母換配色再疊特徵：
  長外套（top 層）：米白、肩膀金邊、高領、前面敞開（中間露出深色內搭與長褲，兩片外緣青色滾邊＋金色十字）、深色腰帶＋青色扣、腰帶掛兩串青色玻璃管、深色手套；
  長褲：深灰；靴子：深棕＋金邊；
  帽子（hat 層，另一張 sheet）：貝雷帽（扁圓帽身＋深色帽帶，青色水晶飾品在一側、垂一條米白綢帶），位置跟著頭走（用素體的頭定位）。
輸出格式同 gen_wmage（sage_sheets() 回 top／bottom／shoes／hat 四層）。顏色集中在最上面。
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

ROBE = ramp((200, 190, 186), (252, 250, 246))         # 長袍的深色階（a 最暗 … g 最亮）
PANTS = ramp((34, 34, 42), (102, 102, 114))
BOOT = ramp((44, 32, 28), (124, 94, 72))
UNDER = {'h': (34, 34, 42), 'i': (46, 46, 56), 'j': (60, 60, 72), 'k': (78, 80, 94)}   # 領口交襟＝深色內搭
GLOVE = {'l': (74, 66, 66), 'm': (54, 48, 50), 'n': (38, 34, 38)}                        # 手（深色手套）
GOLD = dict(d=(150, 108, 66), m=(206, 164, 100), l=(244, 216, 160))
TEAL = dict(d=(46, 130, 142), m=(100, 198, 198), l=(180, 240, 236))
RED = dict(d=(46, 130, 142), m=(100, 198, 198), l=(180, 240, 236))    # 沿用 wmage 的名字（這裡是青色）
BELT = dict(d=(40, 36, 44), m=(66, 60, 70))
OUT = (104, 96, 100)   # 長外套的輪廓線
CAPE = dict(d=(46, 130, 142), m=(100, 198, 198), l=(180, 240, 236))
GEM = dict(m=TEAL['m'], l=TEAL['l'])
SKIN = 'lmn'
HAT = dict(a=(104, 96, 100), b=(222, 218, 214), c=(242, 240, 236), d=(254, 253, 250), p=(50, 48, 58), g=GOLD['m'], G=GOLD['l'], q=TEAL['m'], t=TEAL['l'], T=TEAL['d'])


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
    """腰帶（兩排）：深色帶＋上緣金邊；正面中間一顆青色扣，兩側各掛一串青色玻璃管；背面中間金扣；側面掛一串。"""
    k = g.kind
    if k == 'left':
        a, b = cx - 5, cx + 5
    else:
        a, b = cx - 6, cx + 5
    for x in range(a, b + 1):
        g.put(x, y, GOLD['m']); g.put(x, y + 1, BELT['m']); g.put(x, y + 2, BELT['d'])
    def tube(x, n=6):
        g.put(x, y + 3, GOLD['m'])
        for i in range(1, n):
            g.put(x, y + 3 + i, TEAL['l'] if i % 2 else TEAL['m'])
            if k != 'left':
                g.put(x + 1, y + 3 + i, TEAL['d'])
        g.put(x, y + 3 + n, GOLD['d'])
    if k == 'front':
        g.put(cx - 1, y + 1, TEAL['m']); g.put(cx, y + 1, TEAL['l']); g.put(cx - 2, y + 1, GOLD['l']); g.put(cx + 1, y + 1, GOLD['l'])
        tube(cx - 5); tube(cx + 3)
    elif k == 'back':
        g.put(cx - 1, y + 1, GOLD['l']); g.put(cx, y + 1, GOLD['l'])
    else:
        tube(cx - 1)


def _skirt(g, cx, E=8):
    """長外套下襬往下接長 E 排：正面敞開（中間露出深色內搭與長褲，兩片外緣青色滾邊＋金色十字）；背面整片（中線＋兩個金色十字）；側面前片短、往後（右）飄；最下一排金邊。"""
    k = g.kind
    a, b = g.row_ext(g.h - 1)
    hy = g.h - 1
    for i in range(1, E + 1):
        y = hy + i
        fl = i // 4                                           # 越往下越外擴
        last = (i == E)
        if k == 'front':
            for x in range(a - fl, b + fl + 1):
                if cx - 3 <= x <= cx + 2:
                    continue                                  # 中間敞開，露出長褲
                edge = min(abs(x - (a - fl)), abs(x - (b + fl)))
                c = ROBE[5] if x < cx else ROBE[4]
                if edge <= 1:
                    c = TEAL['m'] if edge == 0 else TEAL['l']
                g.put(x, y, GOLD['m'] if last else c)
            g.put(cx - 3, y, GOLD['m']); g.put(cx + 2, y, GOLD['d'])   # 門襟金線
        elif k == 'back':
            for x in range(a - fl, b + fl + 1):
                edge = min(abs(x - (a - fl)), abs(x - (b + fl)))
                c = ROBE[5] if x < cx else ROBE[4]
                if edge <= 1:
                    c = TEAL['m'] if edge == 0 else TEAL['l']
                if x in (cx - 1, cx):
                    c = ROBE[3]                               # 背中線
                g.put(x, y, GOLD['m'] if last else c)
        else:   # 側面（臉朝左）：前片短、往後（右）飄
            lo = a + 2 - (1 if i > 2 else 0)
            hi = b + 2 + fl
            front_end = E - 2
            for x in range(lo, hi + 1):
                if i > front_end and x < cx + 1:
                    continue
                c = ROBE[4]
                if hi - x == 0:
                    c = TEAL['m']
                elif hi - x == 1:
                    c = TEAL['l']
                g.put(x, y, GOLD['m'] if last else c)
    # 金色十字（3×3 的加號）：正面兩片各一個、背面兩個
    if k in ('front', 'back'):
        for sx in ((-7, 5) if k == 'front' else (-5, 4)):
            for dx, dy in ((0, 0), (-1, 1), (0, 1), (1, 1), (0, 2)):
                g.put(cx + sx + dx, hy + 3 + dy, GOLD['m'] if dy != 1 else GOLD['l'])
    else:
        for dx, dy in ((0, 0), (-1, 1), (0, 1), (1, 1), (0, 2)):
            g.put(cx + 3 + dx, hy + 3 + dy, GOLD['l'] if dy == 1 else GOLD['m'])
    g.h += E


def sage_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    _shoulders(g)
    _opening(g, cx)
    _collar(g, cx)
    by = g.h - 9
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
def sage_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    return g.out()


def sage_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = GOLD['m']                              # 靴口一圈金邊
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
    """貝雷帽的 {(x, y): 色}；cx＝頭的中心欄（小數）、top＝頭頂排。扁圓帽身 7 排（top-6～top）＋深色帽帶 3 排（top+1～top+3）；青色水晶飾品在一側（正面右、背面左、側面前方），垂一條米白綢帶。"""
    center = {'front': cx, 'back': cx, 'left': cx + 1.5}[kind]
    prof = (5.5, 8.5, 10.5, 11.5, 11.5, 11.0, 10.0)                          # 帽身每排半寬
    y0 = top - 6
    sil = {}
    part = {}
    for i, hw in enumerate(prof):
        for x in range(round(center - hw), round(center + hw) + 1):
            sil[(x, y0 + i)] = 1
            part[(x, y0 + i)] = ('crown', i, x - center, hw)
    for j in range(3):                                                  # 帽帶：比頭寬 1 欄
        hw = 9.5 if kind != 'left' else 10.0
        for x in range(round(center - hw), round(center + hw) + 1):
            sil[(x, y0 + 7 + j)] = 1
            part[(x, y0 + 7 + j)] = ('band', j, x - center, hw)
    out = {}
    for (x, y), (nm, i, dx, hw) in part.items():
        if nm == 'band':
            c = HAT['p']
            if i == 0:
                c = (74, 72, 84)
        else:
            c = HAT['c'] if dx < -hw * 0.2 else HAT['b']
            if i == 0 or (i == 1 and dx < -hw * 0.5):
                c = HAT['d']
            if dx > hw * 0.55 and i >= 2:
                c = HAT['b']
            if i == 6 and abs(dx) < hw - 1:
                c = HAT['b']
        out[(x, y)] = c
    # 帽身的一道摺線
    for i in range(2, 6):
        x = round(center + {'front': 3, 'back': -3, 'left': 4}[kind]) + (i - 2) // 2
        if (x, y0 + i) in out:
            out[(x, y0 + i)] = HAT['a']
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HAT['a']
    # 青色水晶飾品（金框，菱形 5 排高）＋垂下的米白綢帶（8 排）
    ox = {'front': round(cx) + 6, 'back': round(cx) - 7, 'left': round(center) - 9}[kind]
    oy = y0 + 6
    gem = {(0, -2): 'G', (-1, -1): 'g', (0, -1): 't', (1, -1): 'g', (-1, 0): 'g', (0, 0): 'q', (1, 0): 't', (2, 0): 'g',
           (-1, 1): 'g', (0, 1): 'T', (1, 1): 'q', (0, 2): 'G'}
    for (dx, dy), k in gem.items():
        out[(ox + dx, oy + dy)] = HAT[k]
        sil[(ox + dx, oy + dy)] = 1
    tail_x = ox - 1 if kind == 'back' else ox + 1
    for i in range(1, 9):
        y = oy + 2 + i
        for x in (tail_x, tail_x + 1):
            out[(x, y)] = HAT['c'] if x == tail_x else HAT['b']
        out[(tail_x - 1, y)] = HAT['a']; out[(tail_x + 2, y)] = HAT['a']
        if i == 4:
            out[(tail_x, y)] = HAT['G']; out[(tail_x + 1, y)] = HAT['g']
    for x in (tail_x, tail_x + 1):
        out[(x, oy + 11)] = HAT['a']
    return out


# ---------- 組成 sheet ----------
HAND_TOP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand', 'sage_top_human.png')   # 使用者給的長外套圖（走路列 9 欄×4 方向，在整張 sheet 的 (20, 538) 起），疊在舊版上存成整張 RGBA；改圖直接改這個檔再重跑 gen_assets.py


HAND_HAT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand', 'sage_hat_human.png')   # 使用者給的貝雷帽圖（走路列 9 欄×4 方向，在整張 sheet 的 (19, 516) 起）疊在舊版上存成整張 RGBA


def sage_sheets():
    """回傳 {'top','bottom','shoes','hat': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    fns = {'top': sage_top, 'bottom': sage_bottom, 'shoes': sage_shoes}
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
    if os.path.exists(HAND_TOP):      # 使用者手畫的人類賢者長外套（2026-11-27）：整張換成他畫的（矮人、巨人由它縮放而來），不再用上面的規則畫
        from gen_wmage import _read_rgba
        out['top'] = _read_rgba(HAND_TOP)
    if os.path.exists(HAND_HAT):      # 使用者手畫的人類賢者貝雷帽（2026-11-27；右側面的垂尾被他拿掉了）
        from gen_wmage import _read_rgba
        out['hat'] = _read_rgba(HAND_HAT)
    return out
