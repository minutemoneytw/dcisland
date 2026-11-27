"""新風格人物的職業武器（2026-11-27，使用者要求「重新生成武器素材，人物素材格數這麼多、武器應該更精緻」）。

舊的武器小圖只有 6×18～12×20，而且標 scale: 2 畫 2 倍（像素比人物粗一倍）。這裡每把武器都照人物的 1 倍像素重畫（人物約 53 排高），
全部「武器頭在上、握柄在下，握把在離圖底 3 格處」（引擎 drawWeaponSwing／drawWeaponWaist／drawWeaponBack 的轉軸慣例）。
光源左上：左緣亮、右緣暗；最外圈一圈暖黑輪廓（跟衣服一樣）。

輸出（Canvas 介面同 gen_assets.save：.w .h .get(x, y) → (r,g,b,a)）：
  sword（長劍，手上拿的）／sword_sheath（劍鞘裡的劍，掛在腰間時畫這張）、waraxe（戰斧，雙面斧刃）、staff（白魔法師的法杖）、
  scepter（黑魔法師的咒杖）、dagger（短刀；忍者左右腰各掛一把＝畫兩次）、lance（龍騎士的長槍）、harpbow（吟遊詩人的豎琴弓）。
"""
import math

OUT = (34, 26, 24, 255)


def ramp(dark, light, n):
    return [tuple(round(dark[i] + (light[i] - dark[i]) * t / (n - 1)) for i in range(3)) + (255,) for t in range(n)]


STEEL = ramp((92, 104, 132), (244, 248, 255), 6)       # 0 最暗 … 5 最亮
GOLD = ramp((126, 82, 40), (255, 236, 160), 5)
LEATHER = ramp((58, 38, 30), (140, 94, 64), 4)
WOOD = ramp((92, 62, 42), (196, 150, 104), 4)
IVORY = ramp((176, 164, 140), (255, 250, 236), 4)
VIOLET = ramp((36, 26, 56), (118, 90, 168), 4)
BLUE = ramp((44, 48, 108), (132, 140, 220), 4)
RED = ramp((96, 24, 34), (214, 76, 76), 4)
GEM_P = ramp((88, 40, 150), (226, 170, 255), 4)
PEARL = ramp((150, 196, 214), (255, 255, 255), 4)


class W:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.buf = [[(0, 0, 0, 0)] * w for _ in range(h)]

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.buf[y][x] = c

    def get(self, x, y):
        return self.buf[y][x]

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c):
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(n + 1):
            self.set(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n), c)

    def disc(self, cx, cy, r, c):
        for y in range(math.floor(cy - r), math.ceil(cy + r) + 1):
            for x in range(math.floor(cx - r), math.ceil(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.set(x, y, c)

    def poly(self, pts, c):
        ys = [p[1] for p in pts]
        for y in range(math.floor(min(ys)), math.ceil(max(ys)) + 1):
            xs = []
            for i in range(len(pts)):
                (xa, ya), (xb, yb) = pts[i], pts[(i + 1) % len(pts)]
                if (ya <= y + .5 < yb) or (yb <= y + .5 < ya):
                    xs.append(xa + (y + .5 - ya) * (xb - xa) / (yb - ya))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                for x in range(round(xs[k]), round(xs[k + 1])):
                    self.set(x, y, c)

    def filled(self, x, y):
        return 0 <= x < self.w and 0 <= y < self.h and self.buf[y][x][3] > 0

    def shade_edges(self, light, dark, skip=None):
        """左邊沒有東西的像素＝亮緣；右邊沒有東西的像素＝暗緣（只動 skip 之外的像素）。"""
        src = [row[:] for row in self.buf]
        for y in range(self.h):
            for x in range(self.w):
                if src[y][x][3] == 0 or (skip and skip(x, y)):
                    continue
                if x == 0 or src[y][x - 1][3] == 0:
                    self.buf[y][x] = light
                elif x == self.w - 1 or src[y][x + 1][3] == 0:
                    self.buf[y][x] = dark

    def outline(self, oc=OUT):
        marks = []
        for y in range(self.h):
            for x in range(self.w):
                if self.buf[y][x][3] == 0 and any(self.filled(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    marks.append((x, y))
        for x, y in marks:
            self.buf[y][x] = oc


def _hilt(cv, cx, gy):
    """劍柄：護手（金）＋握柄（皮革纏帶）＋劍首。gy＝護手上緣那排。"""
    for i, row in enumerate((GOLD[4], GOLD[3], GOLD[1])):       # 護手三排：上亮下暗
        cv.rect(cx - 4, gy + i, cx + 4, gy + i, row)
    cv.set(cx - 4, gy + 1, GOLD[4]); cv.set(cx + 4, gy + 1, GOLD[1])
    cv.set(cx - 4, gy, GOLD[2]); cv.set(cx + 4, gy, GOLD[2])
    for i in range(6):                                           # 握柄 6 排：兩色交替的纏帶
        c = LEATHER[2] if i % 2 == 0 else LEATHER[0]
        cv.rect(cx - 1, gy + 3 + i, cx + 1, gy + 3 + i, c)
        cv.set(cx - 1, gy + 3 + i, LEATHER[3] if i % 2 == 0 else LEATHER[1])
    cv.rect(cx - 1, gy + 9, cx + 1, gy + 9, GOLD[3])             # 劍首
    cv.rect(cx - 2, gy + 10, cx + 2, gy + 10, GOLD[2]); cv.set(cx - 2, gy + 10, GOLD[4]); cv.set(cx - 1, gy + 10, GOLD[4])
    cv.rect(cx - 1, gy + 11, cx + 1, gy + 11, GOLD[1])


def sword():
    """長劍（騎士，拿在手上）：11×38，劍尖在上。"""
    cv = W(11, 38)
    cx = 5
    for y in range(1, 24):                                       # 劍刃：尖端 1→3→5 格寬
        hw = 0 if y < 3 else 1 if y < 6 else 2
        for x in range(cx - hw, cx + hw + 1):
            cv.set(x, y, STEEL[3])
    cv.shade_edges(STEEL[5], STEEL[1], skip=lambda x, y: y >= 24)
    for y in range(7, 22):                                       # 血槽：中線一條暗線
        cv.set(cx, y, STEEL[2])
    cv.set(cx - 1, 7, STEEL[4])
    _hilt(cv, cx, 24)
    cv.outline()
    return cv


def sword_sheath():
    """劍鞘裡的劍（騎士，掛在腰間時畫這張）：同樣 11×38，上面是皮革劍鞘＋金色鞘口與鞘尖，只露出護手與握柄。"""
    cv = W(11, 38)
    cx = 5
    for y in range(1, 24):
        cv.rect(cx - 1, y, cx + 1, y, LEATHER[1])
        cv.set(cx - 1, y, LEATHER[3]); cv.set(cx + 1, y, LEATHER[0])
    cv.rect(cx - 1, 1, cx + 1, 2, GOLD[3]); cv.set(cx - 1, 1, GOLD[4]); cv.set(cx, 0 + 1, GOLD[3])   # 鞘尖（金屬套）
    cv.rect(cx - 1, 11, cx + 1, 12, GOLD[2]); cv.set(cx - 1, 11, GOLD[4])                          # 中段的金屬環
    cv.rect(cx - 2, 21, cx + 2, 23, GOLD[3]); cv.rect(cx - 2, 21, cx - 2, 23, GOLD[4])            # 鞘口
    _hilt(cv, cx, 24)
    cv.outline()
    return cv


def waraxe():
    """戰斧（戰士）：17×44，雙面斧刃在上、紅色纏帶斧柄。"""
    cv = W(17, 44)
    cx = 8
    # 斧柄
    cv.rect(cx - 1, 12, cx + 1, 41, WOOD[2])
    cv.rect(cx - 1, 12, cx - 1, 41, WOOD[3]); cv.rect(cx + 1, 12, cx + 1, 41, WOOD[0])
    for y in range(28, 36):                                      # 紅色纏帶（握把）
        cv.rect(cx - 1, y, cx + 1, y, RED[1] if (y % 2) else RED[2])
        cv.set(cx - 1, y, RED[3]); cv.set(cx + 1, y, RED[0])
    cv.rect(cx - 1, 40, cx + 1, 41, GOLD[2]); cv.set(cx - 1, 40, GOLD[4]); cv.set(cx + 1, 41, GOLD[1])   # 柄尾金屬套
    # 斧頭：左右對稱的兩片新月形斧刃，中間是方形的斧眼
    left = [(7, 3), (4, 1), (1, 4), (0, 8), (1, 12), (4, 14), (7, 12)]
    right = [(17 - 1 - x + 1, y) for x, y in left]
    for pts in (left, right):
        cv.poly(pts, STEEL[2])
    # 斧面：外緣 2 格是磨亮的刃（左片亮、右片稍暗），裡面的斧面深一階，靠斧眼那邊再深一點
    for y in range(0, 15):
        row = [x for x in range(17) if cv.filled(x, y) and abs(x - cx) > 1]
        for side, xs in (('L', [x for x in row if x < cx]), ('R', [x for x in row if x > cx])):
            if not xs:
                continue
            xs.sort()
            outer = xs[:2] if side == 'L' else xs[-2:]
            for x in xs:
                if x in outer:
                    cv.set(x, y, STEEL[5] if (side == 'L' and x == outer[0]) else STEEL[4] if side == 'L' else STEEL[3] if x == outer[-1] else STEEL[2])
                else:
                    cv.set(x, y, STEEL[2] if side == 'L' else STEEL[1])
    cv.rect(cx - 2, 4, cx + 2, 11, STEEL[3])                     # 斧眼（中間那塊方形的金屬）
    cv.rect(cx - 1, 5, cx + 1, 10, STEEL[2])
    cv.set(cx - 1, 5, STEEL[5]); cv.set(cx - 1, 6, STEEL[4]); cv.set(cx + 1, 10, STEEL[1])
    cv.rect(cx - 1, 0, cx + 1, 3, STEEL[3]); cv.set(cx, 0, STEEL[5]); cv.set(cx - 1, 1, STEEL[4])   # 頂端的小尖
    cv.outline()
    return cv


def staff():
    """法杖（白魔法師）：11×46，象牙色杖身、金環包著珍珠。"""
    cv = W(11, 46)
    cx = 5
    cv.rect(cx - 1, 13, cx + 1, 43, IVORY[2])
    cv.rect(cx - 1, 13, cx - 1, 43, IVORY[3]); cv.rect(cx + 1, 13, cx + 1, 43, IVORY[0])
    for y in (18, 19, 34, 35):                                   # 金色箍
        cv.rect(cx - 1, y, cx + 1, y, GOLD[3]); cv.set(cx - 1, y, GOLD[4]); cv.set(cx + 1, y, GOLD[1])
    cv.rect(cx - 1, 42, cx + 1, 43, GOLD[2])                     # 杖尾
    # 杖頭：金環（外圈 r≈4.6）、裡面一顆珍珠，環的上端有一個小飾尖
    for y in range(0, 14):
        for x in range(0, 11):
            d = math.hypot(x - cx, y - 7)
            if 3.3 <= d <= 4.9:
                cv.set(x, y, GOLD[3])
    for y in range(0, 14):
        for x in range(0, 11):
            d = math.hypot(x - cx, y - 7)
            if 3.3 <= d <= 4.9 and (x - cx) + (y - 7) < -1:
                cv.set(x, y, GOLD[4])
            elif 3.3 <= d <= 4.9 and (x - cx) + (y - 7) > 3:
                cv.set(x, y, GOLD[1])
    cv.disc(cx, 7, 2.6, PEARL[1])
    cv.disc(cx - .5, 6.5, 1.7, PEARL[2])
    cv.set(cx - 1, 6, PEARL[3]); cv.set(cx - 1, 5, PEARL[3])
    cv.rect(cx - 1, 11, cx + 1, 12, GOLD[2])                     # 環底座
    cv.set(cx, 1, GOLD[4]); cv.set(cx, 0, GOLD[3])
    cv.outline()
    return cv


def scepter():
    """咒杖（黑魔法師）：11×46，暗紫杖身、金爪托著紫水晶。"""
    cv = W(11, 46)
    cx = 5
    cv.rect(cx - 1, 14, cx + 1, 43, VIOLET[1])
    cv.rect(cx - 1, 14, cx - 1, 43, VIOLET[2]); cv.rect(cx + 1, 14, cx + 1, 43, VIOLET[0])
    for y in (20, 21, 33, 34):
        cv.rect(cx - 1, y, cx + 1, y, GOLD[2]); cv.set(cx - 1, y, GOLD[4]); cv.set(cx + 1, y, GOLD[0])
    cv.rect(cx - 1, 42, cx + 1, 43, GOLD[1])
    # 金爪：左右各一條往上彎的爪，底下一個小碗
    for (x, y) in [(2, 12), (2, 11), (2, 9), (2, 7), (3, 5), (3, 4)]:
        cv.set(x, y, GOLD[3]); cv.set(10 - x, y, GOLD[2])
    for (x, y) in [(2, 7), (3, 4)]:
        cv.set(x, y, GOLD[4])
    cv.rect(cx - 2, 12, cx + 2, 13, GOLD[2]); cv.rect(cx - 2, 12, cx - 2, 13, GOLD[4])
    # 水晶（菱形）
    cv.poly([(cx, 0), (cx + 3, 4), (cx, 11), (cx - 3, 4)], GEM_P[1])
    cv.poly([(cx, 1), (cx - 2, 4), (cx, 8)], GEM_P[2])
    cv.set(cx - 1, 3, GEM_P[3]); cv.set(cx - 1, 4, GEM_P[3]); cv.set(cx, 2, GEM_P[3])
    cv.set(cx + 1, 6, GEM_P[0]); cv.set(cx, 8, GEM_P[0]); cv.set(cx + 1, 5, GEM_P[0])
    cv.outline()
    return cv


def dagger():
    """短刀（忍者，左右腰各一把）：7×22，刀尖在上。"""
    cv = W(7, 22)
    cx = 3
    for y in range(1, 13):
        hw = 0 if y < 3 else 1
        for x in range(cx - hw, cx + hw + 1):
            cv.set(x, y, STEEL[3])
    cv.shade_edges(STEEL[5], STEEL[1], skip=lambda x, y: y >= 13)
    cv.rect(cx - 2, 13, cx + 2, 13, GOLD[3]); cv.set(cx - 2, 13, GOLD[4]); cv.set(cx + 2, 13, GOLD[1])
    for i in range(5):
        c = LEATHER[2] if i % 2 == 0 else LEATHER[0]
        cv.rect(cx - 1, 14 + i, cx + 1, 14 + i, c)
        cv.set(cx - 1, 14 + i, LEATHER[3] if i % 2 == 0 else LEATHER[1])
    cv.rect(cx - 1, 19, cx + 1, 19, GOLD[2]); cv.set(cx - 1, 19, GOLD[4])
    cv.rect(cx - 1, 20, cx + 1, 20, GOLD[1])
    cv.outline()
    return cv


def lance():
    """長槍（龍騎士）：13×70，槍尖在上；葉形槍頭、紅色槍纓、藍紫色槍桿與銀色箍。"""
    cv = W(13, 70)
    cx = 6
    cv.poly([(cx, 1), (cx + 3, 6), (cx + 3, 10), (cx + 1.5, 14), (cx - 1.5, 14), (cx - 3, 10), (cx - 3, 6)], STEEL[3])
    for y in range(2, 14):
        cv.set(cx - 1, y, STEEL[5] if y < 11 else STEEL[4]); cv.set(cx, y, STEEL[3]); cv.set(cx + 1, y, STEEL[2])
    for y in range(5, 11):
        cv.set(cx - 2, y, STEEL[4]); cv.set(cx + 2, y, STEEL[1]); cv.set(cx + 3, y, STEEL[0]) if y > 6 else None
    cv.rect(cx - 2, 15, cx + 2, 16, GOLD[3]); cv.rect(cx - 2, 15, cx - 2, 16, GOLD[4]); cv.rect(cx + 2, 15, cx + 2, 16, GOLD[1])   # 槍頭套筒
    # 槍纓：紅色，從套筒往兩側垂下
    for i, (x0, x1) in enumerate([(cx - 5, cx + 5), (cx - 5, cx + 5), (cx - 4, cx + 4), (cx - 4, cx + 4), (cx - 3, cx + 3), (cx - 2, cx + 2)]):
        y = 17 + i
        for x in range(x0, x1 + 1):
            if abs(x - cx) > 1:
                cv.set(x, y, RED[2] if x < cx else RED[1])
        cv.set(x0, y, RED[3]); cv.set(x1, y, RED[0])
    cv.rect(cx - 1, 17, cx + 1, 66, BLUE[1])
    cv.rect(cx - 1, 17, cx - 1, 66, BLUE[2]); cv.rect(cx + 1, 17, cx + 1, 66, BLUE[0])
    for y in (24, 25, 44, 45, 62, 63):                           # 銀色箍
        cv.rect(cx - 1, y, cx + 1, y, STEEL[3]); cv.set(cx - 1, y, STEEL[5]); cv.set(cx + 1, y, STEEL[1])
    cv.rect(cx - 1, 66, cx + 1, 67, STEEL[2]); cv.set(cx - 1, 66, STEEL[4])        # 槍尾套
    cv.set(cx, 68, STEEL[1])
    cv.outline()
    return cv


def harpbow():
    """豎琴弓（吟遊詩人）：18×32，弓身彎成豎琴的樣子（左邊的金色弓臂、右邊一條弦、中間幾條橫向的細弦）。"""
    cv = W(18, 32)
    top, bot, tx = 2, 29, 15
    pts = []
    for y in range(top, bot + 1):
        t = (y - top) / (bot - top)
        x = tx - 12 * math.sin(math.pi * t) ** 0.85
        pts.append((round(x), y))
    for (x, y) in pts:                                          # 弓臂 2 格寬
        cv.set(x, y, GOLD[3]); cv.set(x + 1, y, GOLD[2])
    for (x, y) in pts:
        cv.set(x, y, GOLD[4] if (y % 3) else GOLD[3])
    for (x, y) in pts:
        if (y - top) % 6 == 5:                                  # 弓臂的小段裝飾（暗紋）
            cv.set(x + 1, y, GOLD[1])
    cv.rect(pts[13][0] - 0, 13, pts[16][0] + 1, 17, LEATHER[2]) if False else None
    for y in range(13, 19):                                     # 握把（弓臂最凸出的地方包皮革）
        x = pts[y - top][0]
        cv.set(x, y, LEATHER[3] if y % 2 else LEATHER[2]); cv.set(x + 1, y, LEATHER[1] if y % 2 else LEATHER[0])
    cv.disc(tx, top - 0.5, 1.3, GOLD[4]); cv.disc(tx, bot + 0.5, 1.3, GOLD[3])        # 弓梢的小圓頭
    for y in range(top + 1, bot):                               # 弦（右邊那條，淺米色）
        cv.set(tx, y, (244, 236, 210, 255))
    arc_x = {y: x for (x, y) in pts}
    # 豎琴的弦：一條條「直的」弦（跟弓弦平行），夾在弓臂與右邊那條弦之間；越靠弓臂凸出的地方弦越短（跟真的豎琴一樣長短漸變）
    for x in range(min(arc_x.values()) + 3, tx - 1, 2):
        ys = [y for y in range(top + 1, bot) if arc_x[y] + 2 <= x]
        if len(ys) >= 3:
            for y in range(min(ys) + 1, max(ys)):
                cv.set(x, y, (236, 224, 190, 255) if (x // 2) % 2 == 0 else (214, 200, 164, 255))
    cv.outline()
    return cv


# ---- 側面版（2026-11-27，使用者：每把武器要有正面和側面，掛在背上側著走只看得到側面）----
# 同樣的圖高、同樣的轉軸（握把離圖底 3 格），只是畫「從側邊看」：薄的東西變成一條細線、環／水晶／斧頭變窄。光源仍在左。
def _shaft(cv, cx, y0, y1, ramp_, w=3):
    """側面的桿：跟正面一樣寬的桿（桿本來就是圓的）。"""
    cv.rect(cx - w // 2, y0, cx + w // 2, y1, ramp_[2])
    cv.rect(cx - w // 2, y0, cx - w // 2, y1, ramp_[3]); cv.rect(cx + w // 2, y0, cx + w // 2, y1, ramp_[0])


def sword_sheath_side():
    """劍鞘裡的劍（側面）：鞘與劍柄都是薄的——劍鞘 3 格寬、護手只剩 3 格厚。"""
    cv = W(11, 38)
    cx = 5
    for y in range(1, 24):
        cv.rect(cx - 1, y, cx + 1, y, LEATHER[1])
        cv.set(cx - 1, y, LEATHER[3]); cv.set(cx + 1, y, LEATHER[0])
    cv.rect(cx - 1, 1, cx + 1, 2, GOLD[3]); cv.set(cx - 1, 1, GOLD[4])
    cv.rect(cx - 1, 11, cx + 1, 12, GOLD[2]); cv.set(cx - 1, 11, GOLD[4])
    cv.rect(cx - 1, 21, cx + 1, 23, GOLD[3]); cv.rect(cx - 1, 21, cx - 1, 23, GOLD[4])
    cv.rect(cx - 1, 24, cx + 1, 25, GOLD[3]); cv.set(cx - 1, 24, GOLD[4]); cv.set(cx + 1, 25, GOLD[1])      # 護手（側看只剩厚度）
    for i in range(6):
        c = LEATHER[2] if i % 2 == 0 else LEATHER[0]
        cv.rect(cx - 1, 27 + i, cx + 1, 27 + i, c)
        cv.set(cx - 1, 27 + i, LEATHER[3] if i % 2 == 0 else LEATHER[1])
    cv.rect(cx - 1, 33, cx + 1, 34, GOLD[2]); cv.set(cx - 1, 33, GOLD[4])
    cv.rect(cx - 1, 35, cx + 1, 35, GOLD[1])
    cv.outline()
    return cv


def waraxe_side():
    """戰斧（側面）：斧頭只剩薄薄一片刃口（上下各一個楔形），斧眼在中間，柄同正面。"""
    cv = W(9, 44)
    cx = 4
    _shaft(cv, cx, 12, 41, WOOD)
    for y in range(28, 36):
        cv.rect(cx - 1, y, cx + 1, y, RED[1] if (y % 2) else RED[2])
        cv.set(cx - 1, y, RED[3]); cv.set(cx + 1, y, RED[0])
    cv.rect(cx - 1, 40, cx + 1, 41, GOLD[2]); cv.set(cx - 1, 40, GOLD[4]); cv.set(cx + 1, 41, GOLD[1])
    for y in range(1, 14):                                        # 斧頭側看：中間 3 格厚，上下兩端收尖，刃口那邊（左）略凸
        hw = 1 if 4 <= y <= 11 else 0
        for x in range(cx - 1 - hw, cx + 2):
            cv.set(x, y, STEEL[3])
        cv.set(cx - 1 - hw, y, STEEL[5]); cv.set(cx + 1, y, STEEL[1])
    cv.rect(cx - 1, 0, cx, 0, STEEL[4])
    cv.rect(cx - 2, 6, cx + 2, 9, STEEL[2]); cv.set(cx - 2, 6, STEEL[4]); cv.rect(cx + 2, 6, cx + 2, 9, STEEL[1])   # 斧眼的箍
    cv.outline()
    return cv


def staff_side():
    """法杖（側面）：金環側看是一個細長的橢圓，只露出一小段珍珠。"""
    cv = W(7, 46)
    cx = 3
    _shaft(cv, cx, 13, 43, IVORY)
    for y in (18, 19, 34, 35):
        cv.rect(cx - 1, y, cx + 1, y, GOLD[3]); cv.set(cx - 1, y, GOLD[4]); cv.set(cx + 1, y, GOLD[1])
    cv.rect(cx - 1, 42, cx + 1, 43, GOLD[2])
    for y in range(2, 12):                                        # 環：兩片細金邊夾著一條珍珠色
        cv.set(cx - 1, y, GOLD[4]); cv.set(cx, y, PEARL[2] if 4 <= y <= 9 else GOLD[3]); cv.set(cx + 1, y, GOLD[1])
    cv.rect(cx - 1, 11, cx + 1, 12, GOLD[2]); cv.set(cx, 1, GOLD[3]); cv.set(cx, 0, GOLD[4])
    cv.outline()
    return cv


def scepter_side():
    """咒杖（側面）：爪與水晶都變窄，水晶是細長的菱形。"""
    cv = W(7, 46)
    cx = 3
    _shaft(cv, cx, 14, 43, VIOLET)
    for y in (20, 21, 33, 34):
        cv.rect(cx - 1, y, cx + 1, y, GOLD[2]); cv.set(cx - 1, y, GOLD[4]); cv.set(cx + 1, y, GOLD[0])
    cv.rect(cx - 1, 42, cx + 1, 43, GOLD[1])
    cv.rect(cx - 1, 11, cx + 1, 13, GOLD[2]); cv.set(cx - 1, 11, GOLD[4])
    cv.poly([(cx, 0), (cx + 2, 4), (cx, 11), (cx - 2, 4)], GEM_P[1])
    cv.set(cx - 1, 3, GEM_P[3]); cv.set(cx - 1, 4, GEM_P[2]); cv.set(cx, 2, GEM_P[3]); cv.set(cx + 1, 6, GEM_P[0]); cv.set(cx, 8, GEM_P[0])
    cv.outline()
    return cv


def dagger_side():
    """短刀（側面）：刀身只剩一條細線（刃口那邊亮），護手也只剩厚度。"""
    cv = W(5, 22)
    cx = 2
    for y in range(1, 13):
        cv.set(cx, y, STEEL[4]); cv.set(cx + 1, y, STEEL[1]) if y >= 3 else None
    cv.rect(cx - 1, 13, cx + 1, 13, GOLD[3]); cv.set(cx - 1, 13, GOLD[4])
    for i in range(5):
        c = LEATHER[2] if i % 2 == 0 else LEATHER[0]
        cv.rect(cx - 1, 14 + i, cx + 1, 14 + i, c)
        cv.set(cx - 1, 14 + i, LEATHER[3] if i % 2 == 0 else LEATHER[1])
    cv.rect(cx - 1, 19, cx + 1, 19, GOLD[2]); cv.rect(cx - 1, 20, cx + 1, 20, GOLD[1])
    cv.outline()
    return cv


def lance_side():
    """長槍（側面）：槍頭變成細長的菱形（薄），槍纓垂在槍桿兩邊但窄，槍桿同正面。"""
    cv = W(9, 70)
    cx = 4
    cv.poly([(cx, 1), (cx + 2, 6), (cx + 2, 10), (cx + 1, 14), (cx - 1, 14), (cx - 2, 10), (cx - 2, 6)], STEEL[3])
    for y in range(2, 14):
        cv.set(cx - 1, y, STEEL[5] if y < 11 else STEEL[4]); cv.set(cx + 1, y, STEEL[2])
    cv.rect(cx - 1, 15, cx + 1, 16, GOLD[3]); cv.set(cx - 1, 15, GOLD[4]); cv.set(cx - 1, 16, GOLD[4])
    for i, hw in enumerate((3, 3, 2, 2, 1, 1)):                    # 槍纓：側看只看到往後飄的一小束
        y = 17 + i
        for x in range(cx - hw, cx + hw + 1):
            if abs(x - cx) > 1:
                cv.set(x, y, RED[1])
        cv.set(cx + hw, y, RED[0])
    _shaft(cv, cx, 17, 66, BLUE)
    for y in (24, 25, 44, 45, 62, 63):
        cv.rect(cx - 1, y, cx + 1, y, STEEL[3]); cv.set(cx - 1, y, STEEL[5]); cv.set(cx + 1, y, STEEL[1])
    cv.rect(cx - 1, 66, cx + 1, 67, STEEL[2]); cv.set(cx - 1, 66, STEEL[4]); cv.set(cx, 68, STEEL[1])
    cv.outline()
    return cv


def harpbow_side():
    """豎琴弓（側面）：豎琴的面對著背，側看只剩弓臂的剖面——一條帶點弧度的金色窄條，弦只剩一條淺線。"""
    cv = W(8, 32)
    top, bot = 2, 29
    for y in range(top, bot + 1):
        t = (y - top) / (bot - top)
        x = 5 - round(2.2 * math.sin(math.pi * t) ** 0.85)
        cv.set(x, y, GOLD[4] if y % 3 else GOLD[3]); cv.set(x + 1, y, GOLD[2])
        if 13 <= y <= 18:
            cv.set(x, y, LEATHER[3] if y % 2 else LEATHER[2]); cv.set(x + 1, y, LEATHER[1] if y % 2 else LEATHER[0])
        cv.set(6, y, (244, 236, 210, 255)) if x + 1 < 6 else None
    cv.disc(5, top - .5, 1.2, GOLD[4]); cv.disc(5, bot + .5, 1.2, GOLD[3])
    cv.outline()
    return cv


ALL = dict(sword_sheath_side=sword_sheath_side, waraxe_side=waraxe_side, staff_side=staff_side, scepter_side=scepter_side, dagger_side=dagger_side,
           lance_side=lance_side, harpbow_side=harpbow_side,
           sword=sword, sword_sheath=sword_sheath, waraxe=waraxe, staff=staff, scepter=scepter, dagger=dagger, lance=lance, harpbow=harpbow)


if __name__ == '__main__':      # 預覽：python tools/gen_weapons.py <輸出.png>  把所有武器並排放大 6 倍
    import sys, struct, zlib
    s = 6
    imgs = [f() for f in ALL.values()]
    H = max(i.h for i in imgs) + 2
    Wd = sum(i.w + 2 for i in imgs)
    rows = []
    for y in range(H):
        row = []
        for im in imgs:
            for x in range(im.w + 2):
                c = im.get(x - 1, y - 1) if 0 <= x - 1 < im.w and 0 <= y - 1 < im.h else (0, 0, 0, 0)
                row.append(tuple(c[:3]) if c[3] else (70, 74, 96))
        rows.append(row)
    raw = b''
    for row in rows:
        big = b''.join(bytes(p) * s for p in row)
        raw += (b'\x00' + big) * s
    def ch(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d))
    open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', Wd * s, H * s, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 9)) + ch(b'IEND', b''))
    print('ok', Wd * s, H * s)
