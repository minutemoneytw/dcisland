"""側面坐姿（2026-11-25，使用者定的做法）：從「朝左待機格」的腿用規則變出坐姿，不另外畫圖。

做法（人類；腿＝身體層第 42～62 排共 21 排，腿的外觀＝身體的腿＋褲子＋鞋子三層用同一條線切）：
1. 上 10 排（大腿）整塊轉 90°，從髖關節往前伸平（朝左的圖往左）。
2. 下 11 排（小腿＋鞋）往上 4 排、往前 7 欄。
3. 下 11 排最上面 2 排再複製兩份補膝蓋的縫：一份往上 2、往後 1；一份往上 4、往後 2（「後」＝朝左的圖往右）。
4. 上衣、頭髮、臉都不動（引擎用待機格的那一欄畫）。
結果放進每張腿層 sheet 的第 9 欄：朝左＝第 9 列、朝右＝第 11 列（朝左的鏡像）；引擎的 sit_left／sit_right 幀指到這兩格（main.js 的 chibiSprite 對 body／bottom／shoes 用這一欄、其他層用待機欄）。

矮人、巨人的腿長不同（18、25 排）：大腿／小腿的排數與位移依腿長等比例換算（10／11、上 4、前 7 都乘 腿長÷21 取整），大腿的粗細就是各自的腿寬。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img

SIT_COL = 9            # 坐姿放在腿層 sheet 的第幾欄（走路用 0～8）
ROW_LEFT, ROW_RIGHT = 9, 11
LEG_BASE = 21          # 人類的腿長（排）
# 大腿後端（髖）離身體後緣往前幾欄、大腿上緣在腿頂下面幾排（人類的數字；其他種族等比例）
BACK_IN = 5
THIGH_TOP_DY = 5          # 大腿上緣＝外套下襬（腿頂 42＋5＝47）的下一排


def _cell_pixels(img, row, col, cell):
    return {(x, y): img.px[row * cell + y][col * cell + x]
            for y in range(cell) for x in range(cell) if img.px[row * cell + y][col * cell + x] is not None}


def leg_geometry(body, cell, leg_len):
    """用身體層的朝左待機格量出：腳底排、腿頂排、腿的前緣 xa／後緣 xb。回 dict。"""
    px = _cell_pixels(body, ROW_LEFT, 0, cell)
    foot = max(y for _, y in px)
    top = foot - leg_len + 1
    xs = [x for (x, y) in px if top <= y <= top + 2]
    low = [x for (x, y) in px if top + round(leg_len * 10 / LEG_BASE) <= y <= top + round(leg_len * 10 / LEG_BASE) + 3]   # 小腿那幾排的腿寬（人類 28..34）
    return dict(foot=foot, top=top, xa=min(xs), xb=max(xs), la=min(low), lb=max(low), cell=cell, leg_len=leg_len)


def sit_pixels(px, g, params=None):
    """px＝{(x,y): 色}（朝左待機格的某一層）→ 坐姿的 {(x,y): 色}（只處理腿頂以下的排；其餘原樣不動）。"""
    ll = g['leg_len']
    s = ll / LEG_BASE
    thigh = round(10 * s)
    up = round(4 * s)
    fwd = round(7 * s)
    top, foot = g['top'], g['foot']
    split = top + thigh                                  # 小腿第一排
    xb_hip = g['xb'] - round(BACK_IN * s)                # 大腿後端的欄
    yt = top + round(THIGH_TOP_DY * s)                   # 大腿上緣的排
    out = {}
    # 腿頂以上的像素（上衣以外的圖層若有）不動
    for (x, y), c in px.items():
        if y < top:
            out[(x, y)] = c
    # 1. 大腿：(u, v)＝離「前緣、腿頂」的位移，轉 90° → x' ＝ 後端 − v、y' ＝ 上緣 + u
    for (x, y), c in px.items():
        if top <= y < split and g['la'] <= x <= g['lb']:   # 大腿的粗細取小腿的腿寬（外套下面看到的大腿比髖寬細）
            nx, ny = xb_hip - (y - top), yt + (x - g['la'])
            out[(nx, ny)] = c
    # 3. 膝蓋補縫：小腿最上面 2 排（已經往上、往前挪過）再複製兩份
    low = {(x - fwd, y - up): c for (x, y), c in px.items() if y >= split}
    first2 = {k: v for k, v in low.items() if split - up <= k[1] < split - up + 2}
    for dy, dx in ((4, 2), (2, 1)):                       # 先畫上 4 後 2 的，再畫上 2 後 1 的
        for (x, y), c in first2.items():
            out[(x + dx, y - dy)] = c
    # 2. 小腿＋鞋（蓋在最上面）
    out.update(low)
    return out


def add_sit_cells(sheets, cell, leg_len, names=('body', 'bottom', 'shoes'), geom=None):
    """在 sheets（{圖層名: Img}）的每張腿層加上坐姿格（第 9 欄；朝左＝第 9 列、朝右＝第 11 列）。
    geom：已經量好的腿幾何（沒給就用 sheets['body'] 量）。回 geom。"""
    g = geom or leg_geometry(sheets['body'], cell, leg_len)
    for n in names:
        img = sheets.get(n)
        if img is None:
            continue
        src = _cell_pixels(img, ROW_LEFT, 0, cell)
        if n == 'bottom' and src:   # 褲子／裙子的最上面幾排被外套蓋住、圖裡沒有：把最上面那排往上補到腿頂，大腿轉過去才整條都有褲子
            y0 = min(y for _, y in src)
            for y in range(g['top'], y0):
                for (x, yy), c in list(src.items()):
                    if yy == y0:
                        src[(x, y)] = c
        res = sit_pixels(src, g)
        for (x, y), c in res.items():
            if 0 <= x < cell and 0 <= y < cell:
                img.px[ROW_LEFT * cell + y][SIT_COL * cell + x] = c
                img.px[ROW_RIGHT * cell + y][SIT_COL * cell + (cell - 1 - x)] = c   # 朝右＝朝左的左右鏡像（格子中線）
    return g
