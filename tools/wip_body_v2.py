#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""【進行中】把新人類系列的身體換成使用者給的「素體」（docs/ref/body_v2_reference.png）——第一階段的工作腳本。
交接說明在 docs/handoff-body-v2.md（先讀那份）。這支腳本做的事：

1. 讀素體圖（120×294，4 排×3 欄，每格 40 寬；排＝正面／朝左／朝右／背面，欄＝步 A／待機／步 B），量化成 9 色、去背
2. 拆成 body（皮膚＋外框）與 face（眼睛）兩層：頭內部的深色＝眼睛；皮膚色的雜點用 3×3 多數決整理掉
3. 眼睛依「從上到下」上色：深、深、灰（虹膜）、灰、深——跟現有眼睛的上色規則一致，眼睛顏色換色鈕才有東西可換（eg2／eg3）
4. 輸出預覽圖：素體疊上男式西裝（gen_male.py），確認對位

用法：python tools/wip_body_v2.py [輸出資料夾]   （只用標準庫＋ tools/ 裡的 gen_school／gen_male；不會寫 client/assets）

對位規則（已量過、預覽確認過）：
- 格內座標 → sheet 格座標：y＋10（素體 53 排高，腳底落在格子第 62 列＝跟現有圖層同一個基準）；
- x：**不能用固定偏移**。素體圖的人物在 3 欄裡本來就往右走（步 A 頭中心約 11.5、待機 19.5、步 B 27.5），要每一格各自平移讓頭中心對到男式西裝那格的領口中心：
  DX（格 x＝素體格內 x＋dx）＝ 正面 (步0,步1,步2)＝(12,20,4)、側面＝(10,18,5)、背面＝(12,20,4)；右面向＝左面向的鏡像（跟其他圖層一樣）。
- 我們的 step 0／1／2 ↔ 素體圖的欄 1／0／2（待機／步 A／步 B）；走路 sheet 的欄 0,3,4,7,8＝步 0、欄 1,2＝步 1、欄 5,6＝步 2（gen_school.WALK_FRAMES）。
"""
import os, sys, struct, zlib
from collections import Counter, deque

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_school as gs

REF = os.path.join(HERE, '..', 'docs', 'ref', 'body_v2_reference.png')
C = gs.C


def read_png(path):
    """8 位元 RGB／RGBA PNG → (w, h, bytes-per-pixel, rows[bytearray])"""
    b = open(path, 'rb').read()
    pos, idat = 8, b''
    while pos < len(b):
        ln, = struct.unpack('>I', b[pos:pos + 4]); tag = b[pos + 4:pos + 8]; data = b[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if tag == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
        elif tag == b'IDAT':
            idat += data
    assert bd == 8 and ct in (2, 6)
    bpp = 3 if ct == 2 else 4
    raw = zlib.decompress(idat); stride = w * bpp; out = []; prev = bytearray(stride); i = 0
    for y in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; up = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + up) & 255
            elif f == 3: line[x] = (line[x] + ((a + up) >> 1)) & 255
            elif f == 4:
                p = a + up - c; pa, pb, pc = abs(p - a), abs(p - up), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (up if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out.append(line); prev = line
    return w, h, bpp, out


W, H, BPP, ROWS_RAW = read_png(REF)
X0 = (0, 40, 80); Y0 = (0, 79, 159, 239)
CENT = [(254, 230, 201), (187, 150, 132), (254, 237, 215), (252, 219, 192), (253, 224, 206), (102, 65, 54), (148, 111, 98), (241, 222, 198), (240, 210, 183)]
SKINL = {(254, 230, 201), (254, 237, 215), (253, 224, 206), (241, 222, 198)}
SHADE = {(252, 219, 192), (240, 210, 183)}
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
DX = {('front', 0): 12, ('front', 1): 20, ('front', 2): 4, ('left', 0): 10, ('left', 1): 18, ('left', 2): 2, ('back', 0): 12, ('back', 1): 20, ('back', 2): 4}   # 左面向步 B 原本 5 → 2（2026-11-23 使用者回報男式西裝側面走路第三格沒對齊；用「頭以下沒被衣服蓋到的皮膚像素」當分數，dx=2 是 0、5 是 91）
DYS = {('front', 1): 9, ('front', 2): 9, ('back', 1): 9, ('back', 2): 9}   # 正面／背面的走路格：衣服比待機格高 1 排（隨步伐起伏），身體也跟著高 1 排（同樣用分數量的）
DY = 10
STEPS = {0: 1, 1: 0, 2: 2}       # 我們的 step → 素體圖的欄
ROWS = {'front': 0, 'left': 1, 'back': 3}


def quant(c):
    return min(CENT, key=lambda p: sum((c[j] - p[j]) ** 2 for j in range(3)))


def cell(ci, ri):
    """{(x, y): 量化色}（格內座標，x 0..39、y 0..55）；透明＝不收"""
    P = {}
    x0, y0 = X0[ci], Y0[ri]
    for y in range(56):
        for x in range(40):
            xx, yy = x0 + x, y0 + y
            if xx < W and yy < H:
                r = ROWS_RAW[yy]
                if BPP == 4 and r[xx * 4 + 3] < 128:
                    continue
                P[(x, y)] = quant(tuple(r[xx * BPP:xx * BPP + 3]))
    return P


def classify(P):
    """→ (body, face)：頭內部（y<20、不貼著外緣）的最深色＝眼睛 → face；其餘皮膚／外框 → body（對成我們的膚色代號 sk／sk_d／fk／fc，換膚色才會跟著換）"""
    body, face = {}, {}

    def isedge(p):
        return any((p[0] + dx, p[1] + dy) not in P for dx, dy in N4)
    for p, c in P.items():
        if c == (102, 65, 54) and not isedge(p) and p[1] < 20:
            face[p] = (60, 38, 31)
        elif c in SKINL: body[p] = C['sk']
        elif c in SHADE: body[p] = C['sk_d']
        elif c == (187, 150, 132): body[p] = C['fk']
        else: body[p] = C['fc']
    return body, face


def clean_body(body):
    skin = {C['sk'], C['sk_d']}
    for _ in range(3):
        N = dict(body)
        for p, c in body.items():
            if c not in skin:
                continue
            cnt = Counter(body.get((p[0] + dx, p[1] + dy)) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if body.get((p[0] + dx, p[1] + dy)) in skin)
            m, n = cnt.most_common(1)[0]
            if m != c and n >= 5:
                N[p] = m
        body = N
    return body


EYE_ROWS = [C['e0'], C['e0'], C['eg3'], C['eg2'], C['e1'], C['e1']]


def eyes_from(face):
    out, seen = {}, set()
    for p in face:
        if p in seen:
            continue
        comp, st = [], [p]; seen.add(p)
        while st:
            q = st.pop(); comp.append(q)
            for dx, dy in N4:
                n = (q[0] + dx, q[1] + dy)
                if n in face and n not in seen:
                    seen.add(n); st.append(n)
        y0 = min(y for _, y in comp)
        for (x, y) in comp:
            out[(x, y)] = EYE_ROWS[min(y - y0, len(EYE_ROWS) - 1)]
    return out


def body_cells():
    """{(方向, 步): (body{(x,y):色}, face{(x,y):色})}（素體格內座標；放進 sheet 格要 x＋DX、y＋DY）"""
    R = {}
    for kind, ri in ROWS.items():
        for step, ci in STEPS.items():
            body, face = classify(cell(ci, ri))
            R[(kind, step)] = (clean_body(body), eyes_from(face))
    return R


def preview(outdir):
    import gen_male as gm
    R = body_cells()
    img = gs.Img(9 * 48, 64); idx = 0
    for kind in ('front', 'left', 'back'):
        for step in (0, 1, 2):
            body, face = R[(kind, step)]
            ox = idx * 48 - 8; dx = DX[(kind, step)]; dy = DYS.get((kind, step), DY)
            for layer in (body, face):
                for (x, y), c in layer.items():
                    X, Y = x + dx + ox, y + dy
                    if 0 <= X < 9 * 48 and 0 <= Y < 64:
                        img.px[Y][X] = c
            for nm in ('bottom', 'shoes', 'top'):
                x0, y0, rows = gm.DATA[(kind, step)][nm]
                for yy, line in enumerate(rows):
                    for xx, ch in enumerate(line):
                        if ch != '.':
                            X = x0 + xx + 16 + ox
                            if 0 <= X < 9 * 48 and 0 <= y0 + yy < 64:
                                img.px[y0 + yy][X] = gm.PAL[gm.CH.index(ch)]
            idx += 1
    os.makedirs(outdir, exist_ok=True)
    gs.write_png(os.path.join(outdir, 'body_v2_male.png'), img, 4, bg=(205, 235, 205))
    print('ok', outdir)


if __name__ == '__main__':
    preview(sys.argv[1] if len(sys.argv) > 1 else 'wip_out')
