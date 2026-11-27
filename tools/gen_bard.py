"""吟遊詩人套裝（吟遊詩人帽／吟遊詩人斗篷／長褲／靴子）的像素資料（2026-11-26，使用者給的吟遊詩人例圖：綠色羽毛帽＋白羽毛＋棕色帽帶金花、
綠色披肩斗篷＋高領、米白長袖、棕色手套、交叉的棕色背帶＋背後的箭袋、棕色腰帶金扣、棕色長褲、棕色高筒靴金邊）。這是吟遊詩人職業的「裝備」
（jobs.json 的 gear；keepGear），不是外觀。

做法同 gen_blm.py／gen_ninja.py：幾何（9 格的輪廓、肩寬、袖子、手、腿）沿用男式西裝（gen_male.DATA），逐字母換成吟遊詩人的配色，再用規則疊特徵：
  斗篷（top 層）：肩膀到胸口一圈綠色披肩（下緣金線）、袖子與軀幹米白、手改成棕色手套、高領（綠色）、X 形交叉背帶＋腰帶金扣（正面）、
                  兩側綠色斗篷片垂到下襬下面（尖尖的下襬，外緣金線）、背面整片綠色長斗篷＋斜背的箭袋（箭羽露在肩上）、側面斗篷往後飄＋箭袋；
  長褲：棕色；靴子：棕色，靴口金邊；
  帽子（hat 層）：圓頂軟帽＋窄帽沿，棕色帽帶＋金色花飾，白色羽毛往後上方翹；位置跟著頭走（用素體的頭定位）。
輸出格式與 gen_blm.blm_sheets() 相同（top／bottom／shoes／hat 四層）。顏色集中在最上面。
"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_body as gb
from gen_male import DATA, WALK_COLS, ROW, CH as MCH


def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

CREAM = ramp((150, 138, 116), (248, 241, 226))       # 米白襯衫（a 最暗 … g 最亮）
GREEN = ramp((20, 30, 20), (122, 140, 94))           # 綠色斗篷／披肩
PANTS = ramp((34, 22, 16), (128, 92, 62))            # 棕色長褲
BOOT = ramp((30, 18, 14), (110, 76, 52))             # 棕色靴
UNDER = {'h': (206, 196, 176), 'i': (222, 212, 192), 'j': (236, 228, 208), 'k': (246, 240, 224)}   # 領口交襟（襯衫）
GLOVE = {'l': (112, 78, 52), 'm': (78, 52, 36), 'n': (48, 32, 24)}                            # 手（棕色手套）
BROWN = dict(d=(58, 38, 28), m=(98, 66, 44), l=(140, 100, 68))                                 # 背帶／腰帶／箭袋
GOLD = dict(d=(128, 96, 56), m=(190, 150, 90), l=(236, 204, 140))
FEATHER = dict(l=(250, 246, 234), m=(222, 216, 198), d=(172, 164, 146))
SLEEVE = ((174, 146, 108), (150, 122, 88))   # 袖子（比軀幹的淺米白深一階、偏暖，手臂才跟身體分得開）
SKIN = 'lmn'
HAT = dict(a=(18, 26, 16), b=(50, 62, 38), c=(72, 88, 54), d=(98, 114, 76))


def _base(ch, kind):
    i = MCH.index(ch)
    if i <= 6:
        if kind == 'top':
            i = (3, 3, 4, 4, 5, 5, 6)[i]       # 米白襯衫：只用亮的那幾階（男式外套的暗色塊太花、會髒髒的）
        return {'top': CREAM, 'bottom': PANTS, 'shoes': BOOT}[kind][i]
    return None


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
                if ch in SKIN:
                    self.px[(x, y)] = GLOVE[ch]
                elif ch in UNDER:
                    self.px[(x, y)] = UNDER[ch]
                else:
                    self.px[(x, y)] = _base(ch, kind)
        self.h = len(rows)
        self.hands = {p: self.px[p] for p, ch in self.src.items() if ch in SKIN}    # 手套：最後蓋回去

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


# ---------- 斗篷 ----------
def _isskin(g, x, y):
    ch = g.src.get((x, y))
    return ch is not None and ch in SKIN


def _sleeves(g, cx=None):
    """手臂（袖子）：手套上面 9 排、手套左右各多 1 欄＝袖子，換成比軀幹深一階的米白（軀幹是淺米白，不然手臂跟身體糊成一片），
    外緣一欄棕色描邊、手套上面兩排棕色護腕。正面／背面＝兩隻手，側面＝近側那隻手。"""
    skin = {p for p, ch in g.src.items() if ch in SKIN and p[1] >= 8}      # y>=8：上面幾排零星的皮膚像素（脖子）不是手
    cols = sorted({x for x, y in skin})
    groups, cur = [], []
    for x in cols:
        if cur and x - cur[-1] > 1:
            groups.append(cur); cur = []
        cur.append(x)
    if cur:
        groups.append(cur)
    for grp in groups:
        x0, x1 = grp[0], grp[-1]
        if cx is not None and g.kind != 'left' and abs((x0 + x1) / 2 - cx) < 6:
            continue                                                # 正面／背面：手在身體前面（走路的某一幀）時，不當袖子（不然整個軀幹被染成袖子色）
        ys = [y for (x, y) in skin if x0 <= x <= x1]
        if not ys:
            continue
        y0 = min(ys)
        for y in range(max(0, y0 - 9), y0):
            for x in range(x0 - 1, x1 + 2):
                if (x, y) not in g.px or _isskin(g, x, y):
                    continue
                if g.kind != 'left' and (g.px[(x, y)] in GREEN or g.px[(x, y)] in (GOLD['d'], GOLD['m'])):
                    continue                                           # 披肩、金線不動（側面的手臂最後畫、蓋在斗篷與箭袋上面，所以不跳過）
                edge = (x == x0 - 1 or x == x1 + 1)
                g.px[(x, y)] = BROWN['d'] if edge else SLEEVE[0 if (x + y) % 4 else 1]
        for y in (y0 - 1, y0 - 2, y0 - 3):
            for x in range(x0 - 1, x1 + 2):
                if (x, y) in g.px and not _isskin(g, x, y):
                    g.px[(x, y)] = BROWN['l'] if y == y0 - 1 else (BROWN['m'] if y == y0 - 2 else BROWN['d'])       # 護腕（三排）


def _mantle(g, cx, rows=6):
    """肩膀到胸口一圈綠色披肩（前 rows 排），下緣一道金線；正面中間留一個 V 形襯衫領口。"""
    k = g.kind
    for y in range(rows):
        e = g.row_ext(y)
        if not e:
            continue
        a, b = e
        for x in range(a, b + 1):
            if (x, y) not in g.px or g.src.get((x, y)) in SKIN:
                continue
            t = (x - a) / max(1, (b - a))
            c = GREEN[4] if t < .35 else (GREEN[3] if t < .7 else GREEN[2])
            if y == 0:
                c = GREEN[5]
            g.px[(x, y)] = c
    # 下緣金線
    y = rows - 1
    e = g.row_ext(y)
    if e:
        for x in range(e[0], e[1] + 1):
            if (x, y) in g.px and g.src.get((x, y)) not in SKIN:
                g.px[(x, y)] = GOLD['d'] if (x + y) % 2 else GOLD['m']
    if k == 'front':
        for y, w in enumerate((1, 1, 1, 1, 0, 0)):
            if w:
                for x in range(cx - 1, cx + 1):
                    if (x, y) in g.px:
                        g.px[(x, y)] = UNDER['k'] if y < 3 else UNDER['j']


def _straps(g, cx, by):
    """X 形交叉背帶（正面：從兩肩斜到對側腰）。背面／側面：一條斜背帶。"""
    k = g.kind
    top, bot = 1, by - 1
    n = bot - top
    if k == 'front':
        for i in range(n + 1):
            x1 = cx - 5 + round(i * 9 / n)
            x2 = cx + 4 - round(i * 9 / n)
            for x, c in ((x1, BROWN['m']), (x2, BROWN['m'])):
                if (x, top + i) in g.px:
                    g.px[(x, top + i)] = c
                if (x + 1, top + i) in g.px and g.src.get((x + 1, top + i)) not in SKIN:
                    g.px[(x + 1, top + i)] = BROWN['d']
        g.put(cx - 1, top + n // 2, GOLD['m']); g.put(cx, top + n // 2, GOLD['l'])   # 交叉處的金扣
    elif k == 'back':
        for i in range(n + 1):
            x1 = cx - 5 + round(i * 9 / n)
            if (x1, top + i) in g.px:
                g.px[(x1, top + i)] = BROWN['m']
                if (x1 + 1, top + i) in g.px:
                    g.px[(x1 + 1, top + i)] = BROWN['d']


def _quiver(g, cx):
    """箭袋：背面＝斜背在背上（箭羽從左肩上方露出來）；側面＝背在背後（右邊），箭羽在肩上；正面＝箭羽從身後露出一點。"""
    k = g.kind
    if k == 'back':
        for i in range(0, 12):
            x = cx - 4 + round(i * 8 / 11)
            for w in range(3):
                g.put(x + w, 1 + i, BROWN['l'] if w == 0 else (BROWN['m'] if w == 1 else BROWN['d']))
        for (dx, dy) in ((-4, -1), (-3, -2), (-5, 0), (-3, -1), (-2, 0)):
            g.put(cx + dx, dy, FEATHER['l'] if dy < 0 else FEATHER['m'])
        g.put(cx - 4, -2, FEATHER['d'])
    elif k == 'left':
        a, b = g.row_ext(3) or (cx - 4, cx + 4)
        for i in range(0, 9):
            for w in range(3):
                g.put(b - 1 + w + i // 4, 1 + i, BROWN['l'] if w == 0 else (BROWN['m'] if w == 1 else BROWN['d']))
        for (dx, dy) in ((0, -1), (1, -2), (2, -1), (1, -1), (2, 0)):
            g.put(b - 1 + dx, dy, FEATHER['l'] if dy < 0 else FEATHER['m'])
    else:
        a, b = g.row_ext(2) or (cx - 5, cx + 5)
        for (dx, dy) in ((1, -1), (2, -2), (3, -1), (2, -1)):
            g.put(b - 2 + dx, dy, FEATHER['l'])


def _collar(g, cx):
    """高領：綠色，脖子兩側（側面＝脖子後面；背面＝整圈）往上翹 2 排，上緣金線。"""
    k = g.kind
    if k == 'front':
        for dy, (w0, w1) in ((-2, (4, 6)), (-1, (3, 6))):
            for sgn in (-1, 1):
                for w in range(w0, w1 + 1):
                    x = cx + (w if sgn > 0 else -w - 1)
                    g.put(x, dy, GREEN[4] if sgn < 0 else GREEN[3])
        g.hline(cx - 7, cx - 5, -2, GOLD['m']); g.hline(cx + 4, cx + 6, -2, GOLD['m'])
    elif k == 'back':
        for dy in (-2, -1):
            g.hline(cx - 6, cx + 5, dy, GREEN[4] if dy == -1 else GREEN[5])
        g.hline(cx - 6, cx + 5, -2, GOLD['m'])
    else:
        for dy in (-2, -1):
            g.hline(cx + 1, cx + 5, dy, GREEN[3] if dy == -1 else GREEN[4])
        g.hline(cx + 1, cx + 5, -2, GOLD['m'])


def _belt(g, cx, y):
    k = g.kind
    a, b = (cx - 5, cx + 5) if k == 'left' else (cx - 6, cx + 5)
    for x in range(a, b + 1):
        g.put(x, y, BROWN['l']); g.put(x, y + 1, BROWN['m'])
    if k == 'front':
        for dx in (-1, 0):
            g.put(cx + dx, y, GOLD['l']); g.put(cx + dx, y + 1, GOLD['m'])


def _cloak(g, cx, by, E=6):
    """斗篷：兩側綠色披片從肩膀垂到下襬下面（尖尖的下襬、外緣金線）；背面整片；側面往後飄。"""
    k = g.kind
    a, b = g.row_ext(g.h - 1)
    hy = g.h - 1
    top = 5
    last_y = hy + E
    # 外側披片：從胸口一路垂下
    for y in range(top, last_y + 1):
        t = (y - top) / max(1, (last_y - top))
        fl = 1 + int(t * 3)
        if k in ('front', 'back'):
            L = (a - fl, a - 1)
            R = (b + 1, b + fl)
            if y > last_y - 2:                                 # 尖尖的下襬：最後兩排往內縮
                shrink = y - (last_y - 2) + 1
                L = (L[0] + shrink, L[1]); R = (R[0], R[1] - shrink)
            for x in range(L[0], L[1] + 1):
                g.put(x, y, GOLD['m'] if x == L[0] else (GREEN[3] if (x + y) % 3 else GREEN[4]))
            for x in range(R[0], R[1] + 1):
                g.put(x, y, GOLD['d'] if x == R[1] else (GREEN[2] if (x + y) % 3 else GREEN[3]))
        else:                                                  # 側面：往後（右）飄成斜片
            lo = b - 1 + int(t * 2)
            hi = b + 1 + int(t * 4)
            for x in range(lo, hi + 1):
                g.put(x, y, GOLD['m'] if x == hi else (GREEN[3] if (x + y) % 3 else GREEN[4]))
    # 下襬往下接長：正面左右兩片、背面整片
    for i in range(1, E + 1):
        y = hy + i
        fl = 1 + (i // 2)
        last = i >= E - 1
        if k == 'front':
            for x in range(a - 0, b + 1):
                if cx - 7 <= x <= cx + 6:
                    continue                                          # 腿（褲子）的範圍不蓋：斗篷只在腿的兩側（使用者：斗篷不要穿過褲子）
                if last and (x - a < i - (E - 2) or b - x < i - (E - 2)):
                    continue
                c = GREEN[4] if x < cx else GREEN[3]
                g.put(x, y, GOLD['m'] if i == E else c)
        elif k == 'back':
            for x in range(a, b + 1):
                if last and (x - a < i - (E - 2) or b - x < i - (E - 2)):
                    continue
                g.put(x, y, GOLD['m'] if i == E else (GREEN[4] if x < cx else GREEN[3]))
        else:
            for x in range(b - 1, b + 2 + fl):                       # 側面：下襬接長的部分只在腿的後面（身體後緣以外）
                g.put(x, y, GOLD['m'] if i == E else GREEN[4])
    if k == 'back':                                            # 背面斗篷的尖角金色紋樣（下襬上方一排 V）
        for x in range(a + 2, b - 1, 4):
            g.put(x, hy + E - 2, GOLD['d']); g.put(x + 1, hy + E - 3, GOLD['d'])
    g.h += E


def bard_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    by = g.h - 8
    if kind == 'back':   # 背面：背後整片都是綠色斗篷（袖子在兩側仍是米白）
        for (x, y) in list(g.px):
            if y >= 6 and abs(x - cx - 0.5) <= 6.5 and g.src.get((x, y)) not in SKIN:
                g.px[(x, y)] = GREEN[4] if x < cx else GREEN[3]
    _belt(g, cx, by)
    _mantle(g, cx)
    if kind != 'left':
        _sleeves(g, cx)
    _straps(g, cx, by)
    _collar(g, cx)
    _cloak(g, cx, by)
    _quiver(g, cx)
    if kind == 'left':      # 側面：近側那隻手臂最後畫（蓋在斗篷與箭袋上面；手往後擺的那幀手臂才不會被斗篷吃掉）
        _sleeves(g)
    g.restore_hands()
    return g.out()


def bard_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    return g.out()


def bard_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        if y == 0:
            g.px[(x, y)] = GOLD['m']                              # 靴口金邊
        elif y == 1:
            g.px[(x, y)] = BOOT[4]
    return g.out()


# ---------- 帽子 ----------
def _head_box(kind, step):
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def hat_pixels(kind, cx, top):
    """圓頂軟帽＋窄帽沿＋白羽毛。帽沿從頭頂下 3 排開始（4 排），圓頂在帽沿上面 7 排，羽毛再往後上方翹。"""
    R = {'front': 17.0, 'back': 17.0, 'left': 18.0}[kind]          # 帽沿半寬（2026-11-26 使用者要求帽子左右加寬 2 格＝每邊 +1，頭髮才不會像從帽子上長出來）
    center = {'front': cx, 'back': cx, 'left': cx + 1.5}[kind]
    brim_y = top + 3
    CROWN = 9
    sil = {}
    for r in range(CROWN):
        t = (r + 1) / CROWN                                      # 0（頂）→ 1（底）
        hw = 6.5 + 5.5 * math.sqrt(max(0.0, 1 - (1 - t) ** 2))   # 圓頂：越往下越寬
        for x in range(round(center - hw), round(center + hw) + 1):
            sil[(x, brim_y - CROWN + r)] = ('crown', r, x - center, hw)
    for i in range(4):
        tt = (i - 1.5) / 2.2
        rx = R * math.sqrt(max(0.0, 1 - tt * tt))
        for x in range(round(center - rx), round(center + rx) + 1):
            sil[(x, brim_y + i)] = ('brim', i, x - center, rx)
    out = {}
    for (x, y), (part, i, dx, hw) in sil.items():
        if part == 'crown':
            c = HAT['c'] if dx < -hw * 0.2 else HAT['b']
            if dx < -hw * 0.55 and i > 1:
                c = HAT['d']
        else:
            c = HAT['d'] if i == 0 else (HAT['c'] if i == 1 else (HAT['b'] if i == 2 else HAT['a']))
        out[(x, y)] = c
    # 帽帶：圓頂最下面 2 排棕色，正面／側面有金色花飾
    for (x, y), (part, i, dx, hw) in sil.items():
        if part == 'crown' and i >= CROWN - 2:
            out[(x, y)] = BROWN['m'] if i == CROWN - 2 else BROWN['d']
    if kind == 'front':
        fx = round(center - 4)
        for (dx, dy, c) in ((0, 0, GOLD['l']), (-1, 0, GOLD['m']), (1, 0, GOLD['m']), (0, -1, GOLD['m']), (0, 1, GOLD['m'])):
            out[(fx + dx, brim_y - 2 + dy + 1)] = c
    elif kind == 'left':
        fx = round(center - 2)
        for (dx, dy, c) in ((0, 0, GOLD['l']), (-1, 0, GOLD['m']), (1, 0, GOLD['m']), (0, -1, GOLD['m']), (0, 1, GOLD['m'])):
            out[(fx + dx, brim_y - 2 + dy + 1)] = c
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HAT['a']
    # 白羽毛：從帽帶往後上方翹（正面＝右上、側面＝往後、背面＝左上）
    dirx = {'front': 1, 'back': -1, 'left': 1}[kind]
    sx0 = round(center + dirx * (3 if kind != 'left' else 6))
    sy0 = brim_y - CROWN + 4
    pts = [(0, 0), (1, -1), (2, -2), (3, -3), (3, -4), (4, -5), (4, -6), (5, -7), (5, -8)]
    for n, (px_, py_) in enumerate(pts):
        x, y = sx0 + dirx * px_, sy0 + py_
        out[(x, y)] = FEATHER['l']
        out[(x - dirx, y)] = FEATHER['l'] if n % 2 == 0 else FEATHER['m']
        out[(x - 2 * dirx, y)] = FEATHER['m']
        if n in (1, 3, 5, 7):
            out[(x + dirx, y)] = FEATHER['d']
    return out


HAND_HAT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand', 'bard_hat_human.png')   # 使用者給的帽子圖（走路列 9 欄×4 方向，在整張 sheet 的 (13, 512) 起），疊在舊版上存成整張 RGBA；改圖直接改這個檔再重跑 gen_assets.py


def bard_sheets():
    fns = {'top': bard_top, 'bottom': bard_bottom, 'shoes': bard_shoes}
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
    if os.path.exists(HAND_HAT):      # 使用者手畫的人類吟遊詩人帽（2026-11-27）：整張換成他畫的（矮人、巨人由它縮放而來）
        from gen_wmage import _read_rgba
        out['hat'] = _read_rgba(HAND_HAT)
    return out
