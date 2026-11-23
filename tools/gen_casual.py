"""預設的中性服裝：T恤（短袖）／長褲／鞋子（球鞋）的像素資料（2026-11-23，使用者要求依現在的身形與給過的參考圖重畫、中性）。

來源：以男式西裝（gen_male.py）的 9 格輪廓當幾何模板，用規則重畫（不是換色，換色會留著外套的領子折痕與雜亂的明暗）——
T恤＝外套輪廓去掉肘以下的袖子，外框一圈、右／下邊 1 格陰影、左邊 1 格亮部、領口與下襬各一道陰影、袖口一條線，肘以下畫皮膚的前臂（3 欄皮膚＋外側外框＋內側陰影，接到我們身體層自己的手，所以 T恤款式不擦掉身體的手）；
長褲＝褲子輪廓畫成深藍牛仔（兩腿中間一條暗縫、褲口一排陰影）；鞋子＝鞋子輪廓畫成淺色球鞋（上緣亮、鞋面淺、最下面兩排鞋底灰、外框深）。
正面／背面的步 B＝步 A 左右鏡像。位置、顏色、手的樣式都可以直接改這裡的字母。
資料格式、對位、右＝左鏡像都跟 gen_male.py 一樣（預覽座標：x＝sheet 格內 x−16、y＝格內 y）。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chibi_pilot import Img
import gen_school as gs
from gen_male import WALK_COLS, ROW

PAL = [
    (38, 46, 68),
    (48, 50, 66),
    (60, 74, 104),
    (82, 100, 134),
    (96, 102, 124),
    (104, 106, 124),
    (106, 126, 160),
    (168, 176, 198),
    (179, 152, 148),
    (206, 210, 222),
    (206, 212, 226),
    (222, 178, 160),
    (232, 236, 244),
    (238, 240, 246),
    (255, 232, 210),
]
CH = 'abcdefghijklmno'
SKIN_LETTERS = 'iol'   # PAL 裡的皮膚色（fk／sk／sk_d）：T恤的前臂

DATA = {
    ('back', 0): {
        'top': (5, 28, [
            '.......ehhhhhee.......',
            '....eeekkkkkkkkeee....',
            '...emkkkkkkkkkkkkhe...',
            '...emkkkkkkkkkkkkhe...',
            '...emkkkkkkkkkkkkhe...',
            '...emkkkkkkkkkkkkhe...',
            '...ehkkkkkkkkkkkkhe...',
            '...eekkkkkkkkkkkkee...',
            '.ioolehkkkkkkkkhelooi.',
            'iool.emkkkkkkkkhe.looi',
            'iool.emkkkkkkkkhe.looi',
            'iool.emkkkkkkkkhe.looi',
            'iool.emkkkkkkkkhe.looi',
            'iool.emkkkkkkkkhe.looi',
            '.....emkkkkkkkkhe.....',
            '.....emkkkkkkkkhe.....',
            '.....emkkkkkkkkhe.....',
            '....ehhhhhhhhhhhhe....',
            '....eeeeeeeeeeeeee....',
        ]),
        'bottom': (9, 47, [
            'aaaaaaaaaaaaaa',
            'agddddddddddca',
            'agddddddddddca',
            'agddddddddddca',
            '.agddddddddca.',
            '.agddddddddca.',
            '.agddddddddca.',
            '.agddddddddca.',
            '.agddddddddca.',
            '.acccccccccca.',
            '.aaaaaaaaaaaa.',
        ]),
        'shoes': (9, 58, [
            'bbbbbbbbbbbbbb',
            'bnnnnnnnnnnnnb',
            '.bjjjjjjjjjjb.',
            '.bffffbbffffb.',
            '..bbbb..bbbb..',
        ]),
    },
    ('back', 1): {
        'top': (6, 28, [
            '.....eehhhhheee.....',
            '.....emkkkkkkhe.....',
            '....emkkkkkkkkhe....',
            '...emkkkkkkkkkkhe...',
            '...emkkkkkkkkkkkhe..',
            '..emkkkkkkkkkkkkkhe.',
            '..emkkkkkkkkkkkkkkhe',
            '..emkkkkkkkkkkkkkkhe',
            '.emkkkkkkkkkkkkkkkhe',
            '.emkkkkkkkkkkkkkkkhe',
            '.emkkkkkkkkkkkkkkkhe',
            'emkkkkkkkkkkkkkkkhhe',
            'emkkkkkkkkkkkkkkkee.',
            'ehhhhkkkkkkkkkkhe...',
            'eeeeekkkkkkkkkkhe...',
            '.....emkkkkkkkkhe...',
            '.....emkkkkkkkkhe...',
            '.....ehhhhhhhhhhe...',
            '.....eeeeeeeeeeee...',
        ]),
        'bottom': (10, 47, [
            'aaaaaaaaaaaaa',
            'agdddddddddca',
            'agdddddddddca',
            'agdddddddddca',
            'agdddddddddca',
            'agddddddddca.',
            'agddddddddca.',
            'agddadddddca.',
            'agdddaddddca.',
            'acccccccccca.',
            'aaaaaaaaaaaa.',
        ]),
        'shoes': (10, 58, [
            'bbbbbbbbbbbb',
            'bnnnnnnnnnnb',
            '.bjjjjjjjjjb',
            '.bbbbjjjjjjb',
            '.....bfffffb',
            '.....bbbbbb.',
        ]),
    },
    ('back', 2): {
        'top': (6, 28, [
            '.....eeehhhhhee.....',
            '.....ehkkkkkkme.....',
            '....ehkkkkkkkkme....',
            '...ehkkkkkkkkkkme...',
            '..ehkkkkkkkkkkkme...',
            '.ehkkkkkkkkkkkkkme..',
            'ehkkkkkkkkkkkkkkme..',
            'ehkkkkkkkkkkkkkkme..',
            'ehkkkkkkkkkkkkkkkme.',
            'ehkkkkkkkkkkkkkkkme.',
            'ehkkkkkkkkkkkkkkkme.',
            'ehhkkkkkkkkkkkkkkkme',
            '.eekkkkkkkkkkkkkkkme',
            '...ehkkkkkkkkkkhhhhe',
            '...ehkkkkkkkkkkeeeee',
            '...ehkkkkkkkkme.....',
            '...ehkkkkkkkkme.....',
            '...ehhhhhhhhhhe.....',
            '...eeeeeeeeeeee.....',
        ]),
        'bottom': (9, 47, [
            'aaaaaaaaaaaaa',
            'acdddddddddga',
            'acdddddddddga',
            'acdddddddddga',
            'acdddddddddga',
            '.acddddddddga',
            '.acddddddddga',
            '.acdddddaddga',
            '.acddddadddga',
            '.acccccccccca',
            '.aaaaaaaaaaaa',
        ]),
        'shoes': (10, 58, [
            'bbbbbbbbbbbb',
            'bnnnnnnnnnnb',
            'bjjjjjjjjjb.',
            'bjjjjjjbbbb.',
            'bfffffb.....',
            '.bbbbbb.....',
        ]),
    },
    ('front', 0): {
        'top': (4, 28, [
            '........ehh..hee........',
            '.....eeekhhhhhkkeee.....',
            '....emkkkkkkkkkkkkhe....',
            '....emkkkkkkkkkkkkhe....',
            '....emkkkkkkkkkkkkhe....',
            '....emkkkkkkkkkkkkhe....',
            '....emkkkkkkkkkkkkhe....',
            '....ehkkkkkkkkkkkkhe....',
            '.ioolehkkkkkkkkkkhelooi.',
            '.iool.emkkkkkkkkhe.looi.',
            '.iool.emkkkkkkkkhe.looi.',
            'iool..emkkkkkkkkhe..looi',
            'iool..emkkkkkkkkhe..looi',
            'iool..emkkkkkkkkhe..looi',
            '......emkkkkkkkkhe......',
            '......emkkkkkkkkhe......',
            '.....emkkkkkkkkkkhe.....',
            '.....ehhhhhhhhhhhhe.....',
            '.....eeeeeeeeeeeeee.....',
        ]),
        'bottom': (9, 47, [
            'aaaaaaaaaaaaaa',
            'agddddddddddca',
            'agddddddddddca',
            '.agddddddddca.',
            '.agddddddddca.',
            '.agddddddddca.',
            '.agdddaadddca.',
            '.agddddddddca.',
            'agddddddddddca',
            'acccccaaccccca',
            'aaaaaaaaaaaaaa',
        ]),
        'shoes': (9, 58, [
            'bbbbbbbbbbbbbb',
            'bnnnnnnnnnnnnb',
            'bjjjjjjjjjjjjb',
            'bfffffbbfffffb',
            'bbbbbb..bbbbbb',
        ]),
    },
    ('front', 1): {
        'top': (4, 28, [
            '........eh..hhee........',
            '.....eeekhhhhhkkee......',
            '....emkkkkkkkkkkkhe.....',
            '....emkkkkkkkkkkkkhe....',
            '....emkkkkkkkkkkkkkhe...',
            '....emkkkkkkkkkkkkkkhe..',
            '...ehkkkkkkkkkkkkkhhee..',
            '...eehkkkkkkkkkkkhelooi.',
            '.ioolehkkkkkkkkkhe.looi.',
            '.iool.emkkkkkkkkhe.looi.',
            '.iool.emkkkkkkkkhe..looi',
            'iool..emkkkkkkkkhe..looi',
            'iool..emkkkkkkkkhe......',
            'iool..ehkkkkkkkkhe......',
            '.......emkkkkkkkkhe.....',
            '........emkkkkkkkhe.....',
            '........ehhhhhhhhhe.....',
            '........eeeeeeeeeee.....',
        ]),
        'bottom': (10, 46, [
            'aaaaaaaaaaaaa',
            'agdddddddddca',
            'agdddddddddca',
            'agdddddddddca',
            'agddddddddca.',
            '.agddaddddca.',
            '.agdadddddca.',
            '.agddaddddca.',
            '.agddaddddca.',
            '.acccaccccca.',
            '.aaaaaaaaaaa.',
        ]),
        'shoes': (10, 57, [
            '.bbbbbbbbbbb',
            'bnnnnnnnnnnb',
            'bjjjjjjjjjjb',
            'bbbbbjjjjjjb',
            '.....bfffffb',
            '.....bbbbbbb',
        ]),
    },
    ('front', 2): {
        'top': (4, 28, [
            '........eehh..he........',
            '......eekkhhhhhkeee.....',
            '.....ehkkkkkkkkkkkme....',
            '....ehkkkkkkkkkkkkme....',
            '...ehkkkkkkkkkkkkkme....',
            '..ehkkkkkkkkkkkkkkme....',
            '..eehhkkkkkkkkkkkkkhe...',
            '.ioolehkkkkkkkkkkkhee...',
            '.iool.ehkkkkkkkkkhelooi.',
            '.iool.ehkkkkkkkkme.looi.',
            'iool..ehkkkkkkkkme.looi.',
            'iool..ehkkkkkkkkme..looi',
            '......ehkkkkkkkkme..looi',
            '......ehkkkkkkkkhe..looi',
            '.....ehkkkkkkkkme.......',
            '.....ehkkkkkkkme........',
            '.....ehhhhhhhhhe........',
            '.....eeeeeeeeeee........',
        ]),
        'bottom': (9, 46, [
            'aaaaaaaaaaaaa',
            'acdddddddddga',
            'acdddddddddga',
            'acdddddddddga',
            '.acddddddddga',
            '.acddddaddga.',
            '.acdddddadga.',
            '.acddddaddga.',
            '.acddddaddga.',
            '.acccccaccca.',
            '.aaaaaaaaaaa.',
        ]),
        'shoes': (10, 57, [
            'bbbbbbbbbbb.',
            'bnnnnnnnnnnb',
            'bjjjjjjjjjjb',
            'bjjjjjjbbbbb',
            'bfffffb.....',
            'bbbbbbb.....',
        ]),
    },
    ('left', 0): {
        'top': (10, 29, [
            '....hhhhhe.',
            '..eekkkkhe.',
            '.emkkkkkhe.',
            '.emkkkkkhe.',
            'emkkkkkkkhe',
            'emkkkkkkkhe',
            'emkkkkkkkhe',
            'emhioolihhe',
            'emkioolikhe',
            'emkioolikhe',
            'emkkioolihe',
            'emkkioolihe',
            'emkkioolihe',
            'emkhe...ehe',
            'emkhe...ehe',
            'emkhe...ehe',
            '.ehhheeehhe',
            '.eeeeeeeeee',
        ]),
        'bottom': (11, 47, [
            'aaaaaaaaaa',
            'agddddddca',
            '.agddddca.',
            '.agddddca.',
            '.agdddca..',
            '.agdddca..',
            '.agdddca..',
            '.agdddca..',
            '.agdddca..',
            'acccccca..',
            'aaaaaaaa..',
        ]),
        'shoes': (9, 58, [
            '..bbbbbbbb',
            '.bnnnnnnnb',
            'bjjjjjjjjb',
            'bffffffffb',
            'bbbbbbbbbb',
        ]),
    },
    ('left', 1): {
        'top': (10, 28, [
            '........hhh...',
            '........ee....',
            '....eeeee.....',
            '..eekkkhe.....',
            '.emkkkkkhe....',
            '.emkkkkkhe....',
            'emkkkkkkkhe...',
            'emkkkkkkkhe...',
            'emkkhhioolie..',
            'emkkkkkioolie.',
            'emkkkkkioolihe',
            'emkkkkkkioolie',
            'emkkkkkkkiooli',
            'emkkkkkkkkheee',
            'emkkkkkkkhe...',
            'emkkkkkkhe....',
            'emkkkkkkhe....',
            'ehhhhhhhhe....',
            '.eeeeeeeee....',
        ]),
        'bottom': (5, 47, [
            '......aaaaaaaaaa....',
            '......agddddddca....',
            '......agddddddca....',
            '.....agdddddddca....',
            '.....agdddddddca....',
            '.....agdddccaaaaa...',
            '....agdddaaaaaaaa...',
            '...agdddaa..aaaaaa..',
            '...agddca...aaaaaaa.',
            '..accccca....aaaaaaa',
            'aaaaaaaaa.....aaaaaa',
        ]),
        'shoes': (3, 58, [
            'bbbbbbbbbb......bbbbbbb',
            'bnnnnnnnnb......bnnnnnb',
            '.bbbbjjjjb......bjjjbb.',
            '.....bffb......bfffb...',
            '......bbb......bbbb....',
        ]),
    },
    ('left', 2): {
        'top': (10, 28, [
            '.......hhh.',
            '.......ee..',
            '...eeeehe..',
            '..emkkkhe..',
            '.emkkkkkhe.',
            '.emkkkkkhe.',
            'emkkkkkkkhe',
            'emkkkkkkkhe',
            'ehioolihkhe',
            'ehioolikkhe',
            'eeioolikkhe',
            '.ioolikkkhe',
            '.ioolikkkhe',
            '.ioolimkkhe',
            '......emkhe',
            '......emkhe',
            '......emkhe',
            'ee...ehhhhe',
            'eeeeeeeeeee',
        ]),
        'bottom': (5, 47, [
            '.....aaaaaaaaaaa....',
            '.....agdddddddca....',
            '.....agdddddddca....',
            '.....agdddddddca....',
            '.....agdddddddca....',
            '.....aaaaaccdddca...',
            '....aaaaaaaadddca...',
            '...aaaaaaa..agddca..',
            '...aaaaaa...acdddca.',
            '..aaaaaaa....accccca',
            'aaaaaaaaa.....aaaaaa',
        ]),
        'shoes': (3, 58, [
            'bbbbbbbbbb......bbbbbbb',
            'bbnnnnnnnb......bnnnnnb',
            '..bbbjjjjb......bjjjbb.',
            '.....bffb......bfffb...',
            '......bbb......bbbb....',
        ]),
    },
}


def hoodie(kind, x0, rows):
    """T恤的上衣資料 → 帽T：長袖（前臂的皮膚字母換成袖子色＋袖口一圈）、正面加袋鼠口袋與帽繩、背面加帽子堆在後頸。"""
    g = [list(r) for r in rows]
    W = max(len(r) for r in g)
    for r in g:
        r.extend('.' * (W - len(r)))
    # 長袖：i（外框）→e、o（袖面）→k、l（內側陰影）→h
    last = {}
    for y, r in enumerate(g):
        for x, ch in enumerate(r):
            if ch in SKIN_LETTERS:
                r[x] = {'i': 'e', 'o': 'k', 'l': 'h'}[ch]
                last.setdefault(x, y)
                last[x] = y
    # 袖口：每欄袖子的最後一格換成袖口色（h），再往下補一格外框
    for x, y in last.items():
        g[y][x] = 'h'
        if y + 1 >= len(g):
            g.append(['.'] * W)
        if g[y + 1][x] == '.':
            g[y + 1][x] = 'e'
    # 袖口兩旁的外框
    for x, y in list(last.items()):
        pass
    if kind == 'front':
        # 袋鼠口袋：腰上方一道橫線，兩端往下各一格
        ys = [y for y, r in enumerate(g) if 'k' in r and 12 <= y <= 15]
        for i, y in enumerate(ys):
            r = g[y]
            xs = [x for x, c in enumerate(r) if c == 'k']
            a, b = xs[0] + 2, xs[-1] - 2
            if i == 0:
                for x in range(a, b + 1):
                    r[x] = 'h'
            elif i == 1:
                r[a] = 'h'; r[b] = 'h'
        # 帽子：領口一圈厚的帽緣（兩排），中間留脖子，帽繩兩條垂下
        r0 = g[0]
        gap = [x for x, c in enumerate(r0) if c == '.' and 4 < x < W - 4]
        if gap:
            cx = (gap[0] + gap[-1]) // 2
            lo, hi = cx - 1, cx + 2          # 脖子的洞
            for x in range(lo - 3, hi + 4):
                if lo <= x < hi:
                    continue
                g[0][x] = 'e' if x in (lo - 3, hi + 3) else 'h'
                if g[1][x] != '.':
                    g[1][x] = 'm' if x not in (lo - 3, hi + 3) else 'e'
            for y in (2, 3, 4, 5):
                for x in (lo - 1, hi + 1 - 1):
                    if g[y][x] == 'k':
                        g[y][x] = 'm'
                if y == 5:
                    for x in (lo - 1, hi):
                        g[y][x] = 'e'
    elif kind == 'back':
        # 帽子堆在後頸：領口下一個 U 形
        xs = [x for x, c in enumerate(g[2]) if c == 'k']
        a, b = xs[0] + 3, xs[-1] - 3
        for x in range(a, b + 1):
            g[1][x] = 'm'
        for y, (aa, bb) in ((2, (a, b)), (3, (a + 1, b - 1)), (4, (a + 2, b - 2))):
            g[y][aa] = 'e'; g[y][bb] = 'e'
            for x in range(aa + 1, bb):
                g[y][x] = 'h' if y == 4 else 'm'
        for x in range(a + 3, b - 2):
            g[4][x] = 'e' if g[4][x] != 'h' else g[4][x]
    return x0, [''.join(r) for r in g]


def casual_sheets():
    """回傳 {'top': Img, 'bottom': Img, 'shoes': Img}（832×1856，只填走路列；右＝左的鏡像）。"""
    out = {n: Img(gs.SHEET_W, gs.SHEET_H) for n in ('top', 'bottom', 'shoes')}
    for d, row in gs.WALK_ROW.items():
        kind = ROW['left' if d == 'right' else d]
        for step, cols in WALK_COLS.items():
            for nm, (x0, y0, rows) in ((n, DATA[(kind, step)][n]) for n in ('top', 'bottom', 'shoes')):
                if nm == 'top' and kind in ('front', 'back', 'left'):
                    x0, rows = hoodie(kind, x0, rows)
                for yy, line in enumerate(rows):
                    for xx, ch in enumerate(line):
                        if ch == '.':
                            continue   # T恤不畫前臂（素體自己的手臂會從袖口露出來；之前畫了一份對不上素體的前臂，會變成雙層手）
                        px = x0 + xx + 16
                        if d == 'right':
                            px = 63 - px
                        for col in cols:
                            out[nm].px[row * gs.CELL + y0 + yy][col * gs.CELL + px] = PAL[CH.index(ch)]
    return out
