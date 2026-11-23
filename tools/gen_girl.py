"""女式西裝（女式西裝外套／西裝短裙／尖皮鞋）在素體上的像素資料（2026-11-24，階段 C）。

素體換掉之後，舊的程序畫女式西裝（gen_school.py 的 girl_*）是照舊身體畫的、手與腿的位置對不上，所以改成：
  外套＝男式西裝外套（gen_male.py，已經照素體對過、含手）的輪廓與明暗，顏色換成女式西裝的代號（k_d／k／k_l＋襯衫＋皮膚，跟舊的一樣會跟「上衣」換色走）；
  短裙＝男式西裝褲最上面的幾排（腰到大腿）截掉，下襬一排深色，外框／亮邊／兩道褶線用規則畫，膝蓋以下露出素體的腿；
  尖皮鞋＝男式皮鞋的輪廓換成女式皮鞋的代號（顏色跟著「鞋子」換色）。
每格的位置都跟男式西裝一樣（所以走路時手腳對得上），想改某個像素：改 SKIRT_CUT／HEM 或直接改 gen_male 的字母。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
import gen_male

DARK = 0.52   # 外框烤進去的變暗比例（跟 gen_school 的 _with_dark 一樣）


def _dark(c):
    return tuple(int(v * DARK) for v in c)


def _map_top():
    C = gs.C
    # 男式外套的 PAL 字母 → 女式西裝的顏色
    return {
        'a': _dark(C['k_d']), 'b': C['k_d'], 'c': C['k_d'], 'd': C['k'], 'e': C['k'], 'f': C['k_l'], 'g': C['k_l'],
        'h': C['shirt_d'], 'i': C['shirt_d'], 'j': C['shirt'], 'k': C['shirt'],
        'l': C['sk'], 'm': C['sk_d'], 'n': C['fk'],
    }


def _map_shoe():
    C = gs.C
    return {'a': _dark(C['shoe_k']), 'b': _dark(C['shoe_k']), 'c': C['shoe_k'], 'd': C['shoe_k'], 'e': C['shoe_k'],
            'f': C['shoe_kl'], 'g': C['shoe_kl'], 'h': C['shoe_kl'], 'i': C['shoe_kl'], 'j': C['shoe_kl'],
            'k': C['shoe_kl'], 'l': C['shoe_kl'], 'm': C['shoe_kl'], 'n': C['shoe_kl']}


# 短裙的下襬在哪一排（格內 y）：男式褲子 47 起，裙子約 6～7 排（腰在 47）
SKIRT_TOP = 45   # 男式褲子從 46～47 排起；外套下緣到 45～46，裙子往上接到沒有縫
SKIRT_HEM = {('front', 0): 53, ('front', 1): 52, ('front', 2): 52,
             ('left', 0): 53, ('left', 1): 53, ('left', 2): 53,
             ('back', 0): 53, ('back', 1): 52, ('back', 2): 52}


def _drop_specks(px, maxn=2):
    """拿掉 ≤maxn 個像素的孤立小點（八鄰接）。px＝{(x,y): c}。"""
    seen, out = set(), dict(px)
    for p in list(px):
        if p in seen:
            continue
        comp, st = [], [p]
        seen.add(p)
        while st:
            q = st.pop()
            comp.append(q)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    r = (q[0] + dx, q[1] + dy)
                    if r in px and r not in seen:
                        seen.add(r)
                        st.append(r)
        if len(comp) <= maxn:
            for q in comp:
                out.pop(q, None)
    return out


# 正面待機的尖頭鞋（一隻的圖，7 欄×5 排：左腳、外側在左；右腳左右鏡射接在後面；a 外框、c 鞋面、f 亮部）：鞋頭往外下方收尖
FRONT_SHOE_IDLE = [
    '.aaaaaa',
    '.accfca',
    'accfcca',
    'aaccca.',
    '.aaaa..',
]
# 背面待機：從後面看到的尖頭鞋——後跟圓、鞋頭在外下方露出一角（同樣是左腳，右腳鏡射）
BACK_SHOE_IDLE = [
    '..aaaaa',
    '..accca',
    '.acfcca',
    'accccca',
    'aaaaaa.',
]
FRONT_SHOE_X, FRONT_SHOE_Y = 25, 58   # 左腳左上角（格內座標）；右腳鏡射（欄 63-x 對稱於格中線……這裡直接接在左腳右邊）


def _front_idle_shoes(shoe_map, shape=None):
    px = {}
    for yy, line in enumerate(shape or FRONT_SHOE_IDLE):
        for xx, ch in enumerate(line):
            if ch != '.':
                px[(FRONT_SHOE_X + xx, FRONT_SHOE_Y + yy)] = shoe_map[ch]
                px[(FRONT_SHOE_X + 13 - xx, FRONT_SHOE_Y + yy)] = shoe_map[ch]   # 右腳：以欄 31.5 為軸鏡射（欄 25～31 ↔ 38～32）
    return px


def _sharpen_front(px, shoe_map):
    """正面走路格的鞋：每隻（八鄰接的一塊）最下面一排左右各收 1 格、整排畫成外框色，鞋頭變尖。"""
    seen, out = set(), dict(px)
    for p in list(px):
        if p in seen:
            continue
        comp, st = [], [p]
        seen.add(p)
        while st:
            q = st.pop()
            comp.append(q)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    r = (q[0] + dx, q[1] + dy)
                    if r in px and r not in seen:
                        seen.add(r)
                        st.append(r)
        yb = max(q[1] for q in comp)
        row = sorted(q[0] for q in comp if q[1] == yb)
        if len(row) > 4:
            for x in (row[0], row[-1]):
                out.pop((x, yb), None)
            for x in row[1:-1]:
                out[(x, yb)] = shoe_map['a']
    return out


def girl_sheets():
    """回傳 {'top','bottom','shoes': Img(832×1856)}（只填走路列；右＝左鏡像）。"""
    C = gs.C
    top_map, shoe_map = _map_top(), _map_shoe()
    out = {n: gs.Img(gs.SHEET_W, gs.SHEET_H) for n in ('top', 'bottom', 'shoes')}
    for d, row in gs.WALK_ROW.items():
        kind = gen_male.ROW['left' if d == 'right' else d]
        for step, cols in gen_male.WALK_COLS.items():
            data = gen_male.DATA[(kind, step)]
            layers = {}
            # 外套／鞋：直接換色
            for nm, cmap in (('top', top_map), ('shoes', shoe_map)):
                x0, y0, rows = data[nm]
                px = {}
                for yy, line in enumerate(rows):
                    for xx, ch in enumerate(line):
                        if ch != '.':
                            px[(x0 + xx + 16, y0 + yy)] = cmap[ch]
                if nm == 'shoes':
                    px = _drop_specks(px)
                    if kind in ('front', 'back'):
                        px = _front_idle_shoes(cmap, BACK_SHOE_IDLE if kind == 'back' else None) if step == 0 else _sharpen_front(px, cmap)
                layers[nm] = px
            # 短裙：男式褲子的 SKIRT_TOP 到下襬那幾排，改成裙子的明暗
            x0, y0, rows = data['bottom']
            hem = SKIRT_HEM[(kind, step)]
            cells = {}
            for yy, line in enumerate(rows):
                y = y0 + yy
                if y > hem or y < SKIRT_TOP:
                    continue
                for xx, ch in enumerate(line):
                    if ch != '.':
                        cells[(x0 + xx + 16, y)] = True
            # 側面走路時兩腿張開，裙子只留髖部那一塊（腿根以外的點拿掉）：取最上面一排的左右界往下 1 格內擴
            if cells:
                ys = sorted({p[1] for p in cells})
                xs0 = [p[0] for p in cells if p[1] == ys[0]]
                lo, hi = min(xs0), max(xs0)
                if kind == 'left' and step != 0:
                    cells = {p: v for p, v in cells.items() if lo - 1 <= p[0] <= hi + 1}
            skirt = {}
            for (x, y) in cells:
                edge = any((x + dx, y + dy) not in cells for dx, dy in ((-1, 0), (1, 0), (0, -1)))
                if y == hem or (x + 1, y) not in cells or (x - 1, y) not in cells:
                    c = C['k_d']
                elif (x + y // 3) % 5 == 0:
                    c = C['k_d']                       # 褶線
                elif (x - 1, y) not in cells or (x - 2, y) not in cells:
                    c = C['k_l']
                else:
                    c = C['k']
                skirt[(x, y)] = c
            layers['bottom'] = skirt
            for nm, px in layers.items():
                for (x, y), c in px.items():
                    xx = 63 - x if d == 'right' else x
                    if 0 <= xx < 64 and 0 <= y < 64:
                        for col in cols:
                            out[nm].px[row * gs.CELL + y][col * gs.CELL + xx] = c
    return out


def apply(sheets):
    """把 sheets 的 top／bottom／shoes 換成女式西裝（就地改）。"""
    for n, im in girl_sheets().items():
        sheets[n] = im
