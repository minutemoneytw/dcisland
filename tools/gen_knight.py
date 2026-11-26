"""騎士套裝（騎士頭盔／騎士鎧甲／騎士腿甲／騎士靴）的像素資料（2026-11-26，使用者給的騎士例圖：白色板甲、金邊、紅色十字旗袍（前片垂在身前、背面整片紅披風）、
紅色圍巾、棕色腰帶金扣、黑色手套、白色頭盔＋金色冠飾與耳側金盤）。這是騎士職業的「裝備」（jobs.json 的 gear；keepGear），不是外觀；
戴頭盔時不顯示頭髮（款式 hideHair），換色只換盔甲的白色階（金邊、紅色旗袍／披風、棕色腰帶不換）。

做法同 gen_blm.py／gen_bard.py：幾何（9 格的輪廓、肩寬、袖子、手、腿）沿用男式西裝（gen_male.DATA），逐字母換成盔甲的白色階，再用規則疊特徵：
  鎧甲（top 層）：肩甲（外擴一圈、金邊）、紅色圍巾、棕色腰帶金扣、正面紅色十字旗袍從腰帶垂到膝蓋（尖尖的下襬、金邊、金色十字）、
                  背面整片紅披風＋金色十字、側面紅披風往後飄；黑色手套；側面近側手臂最後畫（才看得到）；
  腿甲／靴：白色板甲，金邊（靴口、腿外緣）；
  頭盔（hat 層）：圓頂（蓋住頭頂與頭的兩側）、眉線以下留出臉、耳側金盤、頭頂金色冠飾；背面整個後腦包住；位置跟著頭走（用素體的頭定位）。
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

ARMOR = ramp((132, 128, 142), (255, 253, 250))        # 盔甲的白色階（0 最暗＝陰影／輪廓 … 6 最亮）
BLACK = {'h': (40, 38, 46), 'i': (52, 50, 60), 'j': (66, 64, 74), 'k': (80, 78, 90)}   # 領口交襟處的黑色內襯
GLOVE = {'l': (74, 72, 82), 'm': (50, 48, 58), 'n': (34, 32, 42)}                        # 黑色手套
RED = dict(d=(92, 24, 30), m=(138, 38, 44), l=(180, 64, 66))                              # 旗袍／披風／圍巾
GOLD = dict(d=(128, 94, 58), m=(190, 148, 90), l=(238, 206, 142))
BROWN = dict(d=(58, 38, 28), m=(98, 66, 44), l=(140, 100, 68))
SKIN = 'lmn'
HELM = dict(a=(128, 124, 140), b=(188, 184, 198), c=(224, 222, 230), d=(246, 244, 248), e=(255, 254, 252))
ARM_IDX = (2, 3, 4, 5, 5, 6, 6)                       # 男式外套的 a～g → 盔甲白色階（只用亮的幾階，才不髒）


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


def _tabard_front(g, cx, by, E):
    """正面：紅色十字旗袍從腰帶垂到下襬下面（尖尖的下襬、金邊、金色十字）。"""
    top = by + 2
    last = g.h - 1 + E
    for y in range(top, last + 1):
        t = y - top
        n = last - top
        w = 3 if y < last - 2 else max(0, 3 - (y - (last - 2)))     # 半寬：最後 3 排縮成尖角
        for x in range(cx - w, cx + w):
            g.put(x, y, RED['m'] if x < cx else RED['d'])
        if w:
            g.put(cx - w, y, GOLD['m']); g.put(cx + w - 1, y, GOLD['d'])
    cy = top + 4
    for dy in range(-1, 5):                                          # 金色十字
        g.put(cx - 1, cy + dy, GOLD['l']); g.put(cx, cy + dy, GOLD['m'])
    for dx in (-2, 1):
        g.put(cx + dx, cy + 0, GOLD['l']); g.put(cx + dx, cy + 1, GOLD['m'])


def _cape(g, cx, E=8):
    """披風：正面＝兩側紅色披片（披在手臂後面）；背面＝整片紅披風＋金色十字；側面＝往後飄的紅披風。"""
    k = g.kind
    hy = g.h - 1
    a, b = g.row_ext(hy)
    last = hy + E
    if k == 'front':
        for y in range(6, last + 1):
            t = (y - 6) / max(1, last - 6)
            fl = 1 + int(t * 2)
            for x in range(a - fl, a):
                g.put(x, y, GOLD['m'] if x == a - fl else RED['m'])
            for x in range(b + 1, b + fl + 1):
                g.put(x, y, GOLD['d'] if x == b + fl else RED['d'])
    elif k == 'back':
        for y in range(5, last + 1):
            if y > last - 2 and False:
                continue
            for x in range(cx - 7, cx + 7):
                edge = x in (cx - 7, cx + 6)
                g.put(x, y, GOLD['m'] if (edge or y == last) else (RED['m'] if x < cx else RED['d']))
        cyx = 9
        for dy in range(-2, 6):                                      # 金色十字
            g.put(cx - 1, cyx + dy + 5, GOLD['l']); g.put(cx, cyx + dy + 5, GOLD['m'])
        for dx in (-3, -2, 1, 2):
            g.put(cx + dx, cyx + 5, GOLD['l']); g.put(cx + dx, cyx + 6, GOLD['m'])
    else:
        for y in range(3, last + 1):
            t = (y - 3) / max(1, last - 3)
            lo = b - 1 + int(t * 2)
            hi = b + 2 + int(t * 5)
            for x in range(lo, hi + 1):
                g.put(x, y, GOLD['m'] if (x == hi or y == last) else (RED['m'] if (x + y) % 3 else RED['d']))
    # 下襬接長：正面中間（旗袍）、背面／側面延伸過的那幾排已在上面畫完
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


def knight_top(kind, x0, y0, rows):
    g = Grid(x0, y0, rows, 'top')
    g.kind = kind
    hem = g.row_ext(g.h - 1)
    cx = (hem[0] + hem[1]) // 2
    by = g.h - 8
    E = 8
    if kind == 'back':
        pass
    _cape(g, cx, 0) if False else None
    h0 = g.h
    _pauldrons(g)
    _scarf(g, cx)
    _belt(g, cx, by)
    # 披風先畫（在盔甲底下），所以要在盔甲上色之後、旗袍之前：cape 會用 put 覆蓋，所以先存下盔甲再疊披風只畫在空格
    saved = dict(g.px)
    _cape(g, cx, E)
    for p, c in saved.items():                          # 盔甲本體蓋回披風上面（披風只留在盔甲外面）
        if kind == 'back' and p[1] >= 5 and abs(p[0] - cx - 0.5) <= 6.5 and not _isskin(g, *p):
            continue                                    # 背面：背上整片都是披風
        g.px[p] = c
    if kind == 'front':
        _tabard_front(g, cx, by, E)
        _belt(g, cx, by)
    if kind == 'left':
        _arms(g)
    return g.out()


def knight_bottom(kind, x0, y0, rows):
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
    return g.out()


def knight_shoes(kind, x0, y0, rows):
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
    return g.out()


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
    rx = 13.0
    cyc = top + 6
    last_y = max(ext) if ext else top + 18

    def hx(y):
        yy = min(max(y, min(ext)), last_y) if ext else None
        return ext[yy] if ext else (round(cx - 11), round(cx + 11))

    sil = {}
    c = cx if kind != 'left' else cx + 1.5
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
    # 外框
    for (x, y) in list(sil):
        if any((x + dx, y + dy) not in sil for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            out[(x, y)] = HELM['a']
    return out


def knight_sheets():
    fns = {'top': knight_top, 'bottom': knight_bottom, 'shoes': knight_shoes}
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
