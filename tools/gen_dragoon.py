"""龍騎士套裝（龍騎士角盔／龍騎士鎧甲／龍騎士腿甲／龍騎士靴）的像素資料（2026-11-27，使用者給的龍騎士例圖：深藍紫底的板甲＋香檳銀色滾邊、尖刺肩甲、
下襬破碎的藍紫色戰裙〔正面前片、背面整片、側面往後飄〕、棕色腰帶、深色手套、帶長角與翼片的頭盔）。這是龍騎士職業的「裝備」（jobs.json 的 gear；keepGear），不是外觀；
戴頭盔時不顯示頭髮（款式 hideHair），換色只換盔甲的深藍紫色階（香檳銀邊、藍紫戰裙、棕色腰帶不換）。

做法同騎士 gen_knight.py（複製過來換配色與特徵）：幾何沿用男式西裝（gen_male.DATA）；
  鎧甲（top 層）：肩甲外擴加尖刺、領口立領（藍紫）、腰帶、正面戰裙前片／背面披片／側面飄片的下襬都做成鋸齒破碎、正面前片中間香檳銀十字紋；
  腿甲／靴：深藍紫板甲＋香檳銀邊；
  頭盔（hat 層）：圓頂＋眉線下留出臉＋耳側護片，再加長角（正面／背面＝兩側向外上彎的尖角、側面＝往後上掃的長角），頭頂香檳銀冠脊。
輸出格式同 gen_knight（dragoon_sheets() 回 top／bottom／shoes／hat 四層）。顏色集中在最上面。
"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_body as gb
from gen_male import DATA, WALK_COLS, ROW, CH as MCH


def ramp(dark, light, n=7):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) for t in range(n)]

ARMOR = ramp((26, 24, 44), (132, 124, 170))        # 盔甲的白色階（0 最暗＝陰影／輪廓 … 6 最亮）
BLACK = {'h': (40, 38, 46), 'i': (52, 50, 60), 'j': (66, 64, 74), 'k': (80, 78, 90)}   # 領口交襟處的黑色內襯
GLOVE = {'l': (74, 72, 82), 'm': (50, 48, 58), 'n': (34, 32, 42)}                        # 黑色手套
RED = dict(d=(50, 48, 86), m=(80, 80, 134), l=(122, 122, 182))                              # 旗袍／披風／圍巾
GOLD = dict(d=(120, 106, 96), m=(176, 160, 140), l=(228, 214, 186))   # 香檳銀
BROWN = dict(d=(46, 34, 34), m=(78, 58, 52), l=(112, 86, 72))
SKIN = 'lmn'
HELM = dict(a=(22, 20, 36), b=(58, 54, 90), c=(80, 76, 118), d=(108, 102, 148), e=(140, 134, 182))
ARM_IDX = (1, 2, 3, 4, 4, 5, 5)                       # 男式外套的 a～g → 盔甲白色階（只用亮的幾階，才不髒）


def _base(ch, kind):
    i = MCH.index(ch)
    if i <= 6:
        return ARMOR[ARM_IDX[i]]
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
                elif ch in BLACK:
                    self.px[(x, y)] = BLACK[ch]
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


def _isskin(g, x, y):
    ch = g.src.get((x, y))
    return ch is not None and ch in SKIN


def _pauldrons(g):
    """肩甲：肩外側往外多一欄（第 1～4 排），外緣金邊、上緣最亮、下緣一道陰影。"""
    for n, y in enumerate((1, 2, 3, 4)):
        e = g.row_ext(y)
        if not e:
            continue
        a, b = e
        spans = [(a - 1, a + 3)] if g.kind == 'left' else [(a - 1, a + 3), (b - 3, b + 1)]
        for lo, hi in spans:
            for x in range(lo, hi + 1):
                if _isskin(g, x, y):
                    continue
                c = ARMOR[6] if n == 0 else (ARMOR[5] if n < 3 else ARMOR[3])
                if x == lo or x == hi:
                    c = GOLD['m'] if n % 2 == 0 else GOLD['l']
                g.px[(x, y)] = c
    e0 = g.row_ext(1)
    if e0:                                                  # 尖刺：肩外側往外上斜（實心的小三角）
        a, b = e0
        L = [(-1, 0), (-2, 0), (-2, -1), (-3, -1), (-3, -2), (-4, -2)]
        for n, (dx, dy) in enumerate(L):
            for t in (0, 1):
                g.px[(a + dx, dy + t)] = GOLD['l'] if n >= 4 else GOLD['m']
                if g.kind != 'left':
                    g.px[(b - dx, dy + t)] = GOLD['l'] if n >= 4 else GOLD['m']
    return


def _scarf(g, cx):
    """紅色圍巾：脖子一圈（兩排）；側面往後飄一小段。"""
    k = g.kind
    if k in ('front', 'back'):
        g.hline(cx - 5, cx + 4, -1, RED['l']); g.hline(cx - 6, cx + 5, 0, RED['m'])
        g.put(cx - 6, 0, RED['d']); g.put(cx + 5, 0, RED['d'])
        if k == 'front':
            g.put(cx - 1, 1, RED['m']); g.put(cx, 1, RED['d'])
    else:
        g.hline(cx + 0, cx + 5, -1, RED['l']); g.hline(cx - 1, cx + 6, 0, RED['m'])


def _belt(g, cx, y):
    k = g.kind
    a, b = (cx - 5, cx + 5) if k == 'left' else (cx - 6, cx + 5)
    for x in range(a, b + 1):
        g.put(x, y, BROWN['l']); g.put(x, y + 1, BROWN['m'])
    if k == 'front':
        for dx in (-1, 0):
            g.put(cx + dx, y, GOLD['l']); g.put(cx + dx, y + 1, GOLD['m'])


def _skirt(g, cx, by, E):
    """戰裙：腰帶下面往下垂的幾片布片（不是披風）。正面＝左右兩片寬的＋中間一片窄而長的（尖角往下）；背面＝左右兩片；側面＝一片從腰垂到後面。
    每片下襬鋸齒破碎，布片外緣香檳銀邊，中間片有香檳銀十字。"""
    k = g.kind
    top = by + 2
    hy = g.h - 1
    last = hy + E
    a, b = g.row_ext(hy)
    cuts = (0, 3, 1, 4, 0, 2, 3, 1)

    def plate(x0, x1, shade, jag, dirn=0):
        """一片布片；dirn＝往外斜的方向（-1 往左、+1 往右、0 垂直）：每往下 3 排整片多挪 1 欄。"""
        for x in range(x0, x1 + 1):
            L = last - cuts[(x - x0 + jag) % 8]
            for y in range(top, L + 1):
                sx = x + dirn * ((y - top) // 3)
                c = RED['m'] if (x - x0) % 3 else RED['l']
                if shade:
                    c = RED['d'] if (x - x0) % 3 else RED['m']
                if (x == x0 and dirn <= 0) or (x == x1 and dirn > 0):
                    c = GOLD['m'] if dirn <= 0 else GOLD['d']      # 只有外側那一欄鑲邊
                g.put(sx, y, c)
                if dirn and (y - top) % 3 == 2:                  # 斜出去留下的縫補一格，才不會斷開
                    g.put(sx + dirn, y, c)
    if k == 'front':
        plate(a - 1, cx - 3, False, 0, -1)
        plate(cx + 2, b + 1, True, 3, 1)
        for x in range(cx - 2, cx + 2):                         # 中間窄片：尖角往下
            L = last + 0 - (0 if x in (cx - 1, cx) else 2)
            for y in range(top, L + 1):
                g.put(x, y, RED['m'] if x < cx else RED['d'])
            g.put(x, top, GOLD['m'])
        for y in range(top + 1, last + 1):
            g.put(cx - 2, y, GOLD['m']) if y <= last - 2 else None
            g.put(cx + 1, y, GOLD['d']) if y <= last - 2 else None
        cy = top + 3
        for dy in range(-1, 5):                                  # 中間片的香檳銀十字
            g.put(cx - 1, cy + dy, GOLD['l']); g.put(cx, cy + dy, GOLD['m'])
        for dx in (-2, 1):
            g.put(cx + dx, cy, GOLD['l']); g.put(cx + dx, cy + 1, GOLD['m'])
    elif k == 'back':
        plate(a - 1, cx - 1, False, 1, -1)
        plate(cx, b + 1, True, 4, 1)
        for y in range(top, last - 1):
            g.put(cx - 1, y, GOLD['d']); g.put(cx, y, GOLD['m'])    # 中縫
    else:                                                       # 側面：前緣往前（左）斜、後緣往後（右）斜
        for y in range(top, last + 1):
            lo = a + 1 - (y - top) // 4
            hi = b + 2 + (y - top) // 3
            for x in range(lo, hi + 1):
                if y > last - cuts[(x - lo) % 8]:
                    continue
                c = RED['m'] if (x - lo) % 3 else RED['l']
                if x == lo:
                    c = GOLD['m']
                elif x == hi:
                    c = GOLD['d']
                g.put(x, y, c)
    g.h += E


def _arms(g):
    """側面近側手臂最後畫：手套上面 9 排換成盔甲色（比軀幹深一階）＋深色描邊，手套上面兩排黑色護腕。"""
    skin = {p for p, ch in g.src.items() if ch in SKIN and p[1] >= 8}
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
        ys = [y for (x, y) in skin if x0 <= x <= x1]
        if not ys:
            continue
        y0 = min(ys)
        for y in range(max(0, y0 - 9), y0):
            for x in range(x0 - 1, x1 + 2):
                if (x, y) not in g.px or _isskin(g, x, y):
                    continue
                edge = (x == x0 - 1 or x == x1 + 1)
                g.px[(x, y)] = GLOVE['n'] if edge else ARMOR[3 if (x + y) % 4 else 2]
        for y in (y0 - 1, y0 - 2):
            for x in range(x0 - 1, x1 + 2):
                if (x, y) in g.px and not _isskin(g, x, y):
                    g.px[(x, y)] = GLOVE['m'] if y == y0 - 1 else GLOVE['l']


def dragoon_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    by = g.h - 8
    _pauldrons(g)
    _scarf(g, cx)
    _skirt(g, cx, by, 8)
    _belt(g, cx, by)                                    # 腰帶蓋在戰裙上緣
    if kind == 'left':
        _arms(g)
    g.restore_hands()
    return _outline(g.out(), ARMOR, HELM['a'])                 # 輪廓線跟頭盔一樣（使用者要求明顯一點）


def dragoon_bottom(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'bottom')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        i = MCH.index(ch)
        if i <= 6:
            g.px[(x, y)] = ARMOR[ARM_IDX[i]]
    for y in range(g.h):
        e = g.row_ext(y)
        if not e:
            continue
        a, b = e
        g.put(a, y, GOLD['d'])
        if kind != 'left':
            g.put(b, y, GOLD['m'])
    ky = g.h // 2                                          # 膝蓋一道深色（板甲關節）
    e = g.row_ext(ky)
    if e:
        for x in range(e[0], e[1] + 1):
            g.put(x, ky, ARMOR[1])
    return _outline(g.out(), ARMOR, HELM['a'])


def dragoon_shoes(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'shoes')
    g.kind = kind
    for (x, y), ch in list(g.src.items()):
        i = MCH.index(ch)
        if i <= 6:
            g.px[(x, y)] = ARMOR[ARM_IDX[i]]
        if y == 0:
            g.px[(x, y)] = GOLD['m']                       # 靴口金邊
    if kind == 'front':
        ex = sorted(x for (x, y) in g.px if y == g.h - 2)
        if ex:
            g.put(ex[0], g.h - 2, GOLD['m']); g.put(ex[-1], g.h - 2, GOLD['m'])
    return _outline(g.out(), ARMOR, HELM['a'])


def _outline(px, ramp, color):
    """輪廓線：這一層的邊緣像素（上下左右有透明的）如果是盔甲／袍子本身的色階，就換成 color（金邊、紅色披風這些裝飾色不動）。"""
    keep = set(ramp)
    out = dict(px)
    for (x, y), c in px.items():
        if c in keep and any((x + dx, y + dy) not in px for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = color
    return out


# ---------- 頭盔 ----------
def _head_box(kind, step):
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    xs = [x0 + x for y in range(18) for x, ch in enumerate(rows[y]) if ch != '.']
    return (min(xs) + max(xs) + 1) / 2.0, y0


def _head_ext(kind, step):
    """素體的頭（前 19 排）每一排在 sheet 格座標的左右界：{y: (xa, xb)}。"""
    x0, y0, rows = gb.DATA[(kind, step)]['body']
    out = {}
    for r in range(19):
        xs = [x0 + x for x, ch in enumerate(rows[r]) if ch != '.']
        if xs:
            out[y0 + r] = (min(xs), max(xs))
    return out


def hat_pixels(kind, cx, top, ext=None):
    """頭盔（2026-11-26 使用者修改）：
    - 圓頂蓋住頭頂與頭的兩側，眉線（頭頂下 8 排）以上整個包住；
    - 正面：眉線以下兩側的臉頰護片「緊貼臉型」（沿著頭的輪廓、各 3 欄寬），長度到下巴往上數 3 排（頭頂下 14 排），中間留出臉；
    - 側面（臉朝左）：前面留出臉，後面完整包覆整個後腦——從耳側（護片位置）往後斜向下一直包到後頸（下緣是斜的）；
    - 背面：整個後腦包住，沿著頭的輪廓到後頸。"""
    ext = ext or {}
    ry_top = top - 3
    brow = top + 8
    guard_bot = top + 14
    nape = top + 16
    rx = 10.5        # 圓（橢圓）形：寬度只比頭多 1～2 排（頭寬 18～19），不是蘑菇狀（2026-11-26 使用者要求）
    cyc = top + 7
    last_y = max(ext) if ext else top + 18

    def hx(y):
        yy = min(max(y, min(ext)), last_y) if ext else None
        return ext[yy] if ext else (round(cx - 11), round(cx + 11))

    sil = {}
    c = cx
    for y in range(ry_top, brow + 1):                       # 圓頂（眉線以上）
        hw = rx * math.sqrt(max(0.0, 1 - ((cyc - y) / (cyc - ry_top + 0.7)) ** 2)) if y <= cyc else rx
        for x in range(round(c - hw), round(c + hw) + 1):
            sil[(x, y)] = 1
    ear_x = round(cx)                                         # 側面：耳側（護片）的欄
    if kind == 'front':
        for y in range(brow + 1, guard_bot + 1):
            xa, xb = hx(y)
            for x in (xa - 2, xa - 1, xa, xa + 1, xb - 1, xb, xb + 1, xb + 2):      # 各 4 欄寬：外 2 欄＋頭輪廓內 2 欄（緊貼臉型）
                sil[(x, y)] = 1
    elif kind == 'left':
        for y in range(brow + 1, nape + 1):
            xa, xb = hx(y)
            xf = ear_x + (y - (brow + 1))                     # 前緣往後斜：從耳側斜向下到後頸
            for x in range(xf, xb + 2):
                sil[(x, y)] = 1
    else:
        for y in range(brow + 1, nape + 1):
            xa, xb = hx(y)
            for x in range(xa - 1, xb + 2):
                sil[(x, y)] = 1
    out = {}
    for (x, y) in sil:
        t = (x - (cx - rx)) / (2 * rx)
        col = HELM['d'] if (t < .32 and y < top + 4) else (HELM['c'] if t < .62 else HELM['b'])
        if y < top + 1:
            col = HELM['e'] if t < .5 else HELM['d']
        out[(x, y)] = col
    # 眉線金邊（臉的上緣）
    if kind in ('front', 'left'):
        for x in range(round(c - rx) + 3, round(c + rx) - 2):
            if (x, brow) in sil:
                out[(x, brow)] = GOLD['m']
    # 冠飾：正面＝頭頂中間一條金色縱帶（頂端展開成箭頭），側面＝沿頭頂的金色脊，背面＝縱縫＋橫縫
    if kind == 'front':
        for y in range(ry_top, brow):
            for x in (round(cx) - 1, round(cx)):
                if (x, y) in sil:
                    out[(x, y)] = GOLD['l'] if x == round(cx) - 1 else GOLD['m']
        for dx in (-3, 2):
            for y in (ry_top + 2, ry_top + 3):
                if (round(cx) + dx, y) in sil:
                    out[(round(cx) + dx, y)] = GOLD['m']
    elif kind == 'left':
        for x in range(round(cx) - 8, round(cx) + 10):
            ys = [y for (xx, y) in sil if xx == x]
            if ys and min(ys) < top + 3:
                out[(x, min(ys) + 1)] = GOLD['l']; out[(x, min(ys) + 2)] = GOLD['m']
    else:
        for y in range(ry_top, nape):
            if (round(cx), y) in sil:
                out[(round(cx) - 1, y)] = GOLD['l']; out[(round(cx), y)] = GOLD['m']
        for x in range(round(cx - rx) + 2, round(cx + rx) - 1):
            if (x, top + 6) in sil:
                out[(x, top + 6)] = GOLD['m']
    # 耳側金盤（圓盤，半徑約 2）：正面／背面＝護片上（頭的兩側），側面＝耳側
    ey = top + 11
    if kind == 'left':
        ex = [(ear_x + 1, ey)]
    else:
        xa, xb = hx(ey)
        ex = [(xa, ey), (xb, ey)]
    for (ecx, ecy) in ex:
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                if dx * dx + dy * dy <= (2 if kind != 'left' else 5):       # 正面／背面的護片窄，金盤小一點（十字形），不然護片整條變金色
                    p = (ecx + dx, ecy + dy)
                    if p in sil or kind == 'left':
                        out[p] = GOLD['l'] if (dx + dy) < 0 else GOLD['m']
                        sil[p] = 1
        out[(ecx, ecy)] = GOLD['d']
    # 三根貼著頭盔的凸角：中間一根（頭頂中線的三角鰭）＋左右各一根（頭盔上緣兩側，往外上彎一點點）；正面眉線中間再有一個尖角往下
    hornpx = {}
    if kind == 'left':
        cxr = round(cx)
        for i in range(0, 12):                                         # 遠側的角（最後面、略暗）：從耳上後面往後上
            for t in range(2):
                hornpx[(cxr + 3 + i, top + 1 - i // 3 + t)] = GOLD['d'] if t == 1 else GOLD['m']
        for i in range(0, 11):                                         # 近側的角：從耳上（耳朵上方）貼著盔面往後延伸
            for t in range(2):
                hornpx[(cxr + 1 + i, top + 4 - i // 4 + t)] = GOLD['l'] if t == 0 else GOLD['m']
        for i in range(0, 16):                                         # 中間的角：從頭頂中間往後上掃（最長）
            n = 3 if i < 6 else (2 if i < 12 else 1)
            for t in range(n):
                hornpx[(cxr - 3 + i, top - 3 - i // 3 + t)] = GOLD['l'] if t == 0 else (GOLD['m'] if t == 1 else GOLD['d'])
    else:
        mx = round(cx)
        for r, hw in enumerate((0, 1, 1, 2, 2)):                       # 中間：三角鰭，頂端在頭頂上方 4 排
            for x in range(mx - 1 - hw + (1 if hw == 0 else 0), mx + hw + (0 if hw else 0) + 1):
                hornpx[(x, top - 7 + r)] = GOLD['l'] if x < mx else GOLD['m']
        pts = [(0, 2), (1, 2), (1, 1), (1, 0), (2, 0), (2, -1), (2, -2), (3, -3), (3, -4)]
        for sgn in (-1, 1):                                            # 左右：貼著盔頂兩側的短角
            bx = round(cx) + sgn * 9 + (0 if sgn > 0 else -1)
            for n, (dx, dy) in enumerate(pts):
                for t in range(2 if n < 7 else 1):
                    hornpx[(bx + sgn * dx - sgn * t, top + dy + 1)] = GOLD['l'] if t == 0 else GOLD['m']
        if kind == 'front':                                            # 眉線中間：尖角往下
            for r, (xa_, xb_) in enumerate(((mx - 2, mx + 1), (mx - 1, mx), (mx - 1, mx))):
                for x in range(xa_, xb_ + 1):
                    hornpx[(x, brow + 1 + r)] = GOLD['l'] if x < mx else GOLD['m']
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HELM['a']
    for (x, y), c in hornpx.items():                       # 長角在外框之後畫：自己再描一圈深色邊
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = (x + dx, y + dy)
            if nb not in hornpx and nb not in sil:
                out[nb] = HELM['a']
    for p, c in hornpx.items():
        out[p] = c
    return out


def dragoon_sheets():
    fns = {'top': dragoon_top, 'bottom': dragoon_bottom, 'shoes': dragoon_shoes}
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in list(fns) + ['hat']}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            cells = {}
            for nm, fn in fns.items():
                x0, y0, rows = DATA[(kind, step)][nm]
                cells[nm] = {(x + 16, y): c for (x, y), c in fn(kind, x0, y0, rows).items() if c is not None}
            cx, top = _head_box(kind, step)
            cells['hat'] = hat_pixels(kind, cx, top, _head_ext(kind, step))
            for nm, cell in cells.items():
                for (x, y), c in cell.items():
                    px = 63 - x if d == 'right' else x
                    if not (0 <= px < 64 and 0 <= y < 64):
                        continue
                    for col in cols:
                        out[nm].px[row * gs.CELL + y][col * gs.CELL + px] = c
    return out
