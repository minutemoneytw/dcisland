#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 素材產生器 v0.2（程序化繪圖版，全自製 placeholder，零授權風險）
# 用法: python tools/gen_assets.py
import struct, zlib, os, random, json, math

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "client", "assets")
TILE = 16

# ---------------- PNG（內容感知寫檔）----------------
# 地雷：不同 Python 版本內建的 zlib 壓縮結果不同，重跑會把幾十個「畫面完全一樣」的 PNG 弄成二進位落差，
# git 看起來全被改過、逼著要 git checkout 還原。所以寫檔前先把既有 PNG 解碼回像素，一模一樣就跳過不寫。

def decode_png_bytes(data):
    """把 PNG 位元組解碼成原始像素：回傳 (w, h, 每列 RGBA 連續位元組)；不支援或壞掉的格式回 None。
    專案內的 PNG 都是 8-bit RGBA 非交錯，剛好覆蓋會被覆寫的目標與外部 img2pixel 匯出的素材。"""
    try:
        pos, w, h, idat = 8, None, None, b""
        while pos + 8 <= len(data):
            ln = struct.unpack(">I", data[pos:pos+4])[0]
            typ = data[pos+4:pos+8]; chunk = data[pos+8:pos+8+ln]
            if typ == b"IHDR":
                w, h, bit, color, _, _, inter = struct.unpack(">IIBBBBB", chunk)
                if bit != 8 or color != 6 or inter != 0:
                    return None
            elif typ == b"IDAT":
                idat += chunk
            elif typ == b"IEND":
                break
            pos += 12 + ln
        if w is None or h is None:
            return None
        raw = zlib.decompress(idat)
    except (OSError, ValueError, struct.error, zlib.error):
        return None
    stride = w * 4; out = bytearray(); prev = bytearray(stride); i = 0
    try:
        for y in range(h):
            f = raw[i]; i += 1; row = bytearray(raw[i:i+stride]); i += stride
            if f == 0: pass
            elif f == 1:
                for x in range(stride): row[x] = (row[x] + (row[x-4] if x >= 4 else 0)) & 255
            elif f == 2:
                for x in range(stride): row[x] = (row[x] + prev[x]) & 255
            elif f == 3:
                for x in range(stride):
                    row[x] = (row[x] + (((row[x-4] if x >= 4 else 0) + prev[x]) // 2)) & 255
            elif f == 4:
                for x in range(stride):
                    a = row[x-4] if x >= 4 else 0; b = prev[x]; c = prev[x-4] if x >= 4 else 0
                    p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                    row[x] = (row[x] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
            else:
                return None
            out += row; prev = row
    except IndexError:
        return None
    return w, h, bytes(out)

def read_png_pixels(path):
    """讀檔後解碼成像素（見 decode_png_bytes）；讀不到回 None"""
    if not os.path.exists(path):
        return None
    try:
        return decode_png_bytes(open(path, "rb").read())
    except OSError:
        return None

def write_png(path, w, h, get_px):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    pix = b"".join(b"".join(bytes(get_px(x, y)) for x in range(w)) for y in range(h))   # 純像素（不含 filter byte）
    if os.path.exists(path):
        old = read_png_pixels(path)
        if old == (w, h, pix):   # 解碼後像素一模一樣：不重寫（重跑不再弄出一堆壓縮落差造成的變更）
            print(f"  {os.path.relpath(path, HERE)}  ({w}x{h})　像素相同，不重寫")
            return
    raw = b"".join(b"\x00" + pix[y * w * 4:(y + 1) * w * 4] for y in range(h))   # PNG 列格式：每列一個 filter byte（這裡固定 0）
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  {os.path.relpath(path, HERE)}  ({w}x{h})")

def hx(s, a=255):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)

def shade(c, f=0.78):
    return (min(255, int(c[0] * f)), min(255, int(c[1] * f)), min(255, int(c[2] * f)), c[3])

T8 = (0, 0, 0, 0)

# ---------------- 畫布 ----------------
class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.buf = [[T8] * w for _ in range(h)]
    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h and len(c) == 4:
            self.buf[y][x] = c
    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)
    def hline(self, x0, x1, y, c): self.rect(x0, y, x1, y, c)
    def vline(self, x, y0, y1, c): self.rect(x, y0, x, y1, c)
    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(math.ceil(cy - ry), math.floor(cy + ry) + 1):
            for x in range(math.ceil(cx - rx), math.floor(cx + rx) + 1):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    self.set(x, y, c)
    def outline(self, oc=(40, 32, 30, 255)):
        marks = []
        for y in range(self.h):
            for x in range(self.w):
                if self.buf[y][x][3] == 0:
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < self.w and 0 <= yy < self.h and self.buf[yy][xx][3] != 0:
                            marks.append((x, y)); break
        for x, y in marks:
            self.buf[y][x] = oc
    def get(self, x, y):
        return self.buf[y][x]

def save(cv, name, sub=""):
    path = os.path.join(ASSETS, sub, name) if sub else os.path.join(ASSETS, name)
    write_png(path, cv.w, cv.h, lambda x, y: cv.get(x, y))

def write_json(path, obj):
    """manifest JSON 一律用 LF 寫出、內容一模一樣就不重寫。
    地雷：直接 open(..., 'w') 在 Windows 會把 \\n 轉成 CRLF，而 repo 的 .gitattributes 設了 eol=lf，
    結果重跑每次都把所有 manifest 弄成「假變更」。"""
    text = json.dumps(obj, ensure_ascii=False, indent=1)
    if os.path.exists(path):
        try:
            if open(path, "rb").read() == text.encode("utf-8"):
                print(f"  {os.path.relpath(path, HERE)}　內容相同，不重寫")
                return
        except OSError:
            pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"  {os.path.relpath(path, HERE)}")

# ---------------- 地形 tile ----------------
INDOOR_REPEAT = 3   # 室內地板的方磚放大倍數：圖是 16n×16n，客戶端用 groundRepeat 分成 n×n 格各畫一塊（方磚邊長＝8n 像素）

def indoor_tile(a, b, n=INDOOR_REPEAT):
    """室內地板磚（16n×16n、可無縫重複）：兩色方磚交錯（每塊 8n×8n）、磚縫較深、磚面上緣一條亮邊。"""
    cv = Canvas(16 * n, 16 * n)
    sq = 8 * n
    for y in range(16 * n):
        for x in range(16 * n):
            c = a if ((x // sq) + (y // sq)) % 2 == 0 else b
            if x % sq == 0 or y % sq == 0:
                c = shade(c, .86)
            elif y % sq == 1:
                c = shade(c, 1.06)
            cv.set(x, y, c)
    return cv

def dither_tile(base, dot, seed, n=None):
    rng = random.Random(seed)
    cv = Canvas(TILE, TILE)
    cv.rect(0, 0, TILE - 1, TILE - 1, base)
    for _ in range(n or (TILE * TILE // 9)):
        cv.set(rng.randrange(TILE), rng.randrange(TILE), dot)
    return cv

# ---------------- 小物 ----------------
def tree(leaf, leaf_d, trunk):
    cv = Canvas(16, 24)
    cv.ellipse(8, 9, 6.4, 5.8, leaf)
    cv.ellipse(8, 12, 5.0, 4.2, leaf)          # 下層葉
    cv.rect(6, 14, 7, 15, leaf_d)              # 內側陰影
    cv.ellipse(6, 8, 2.2, 1.6, shade(leaf, 1.15))
    cv.rect(7, 17, 8, 22, trunk)
    cv.rect(6, 19, 6, 22, shade(trunk, 0.9))
    cv.outline()
    return cv

def pine(leaf, trunk):
    cv = Canvas(16, 24)
    tiers = [(8, 3, 2.0), (7, 7, 3.4), (6, 11, 4.8), (5, 15, 6.4)]
    for cy, y0, rx in tiers:
        for y in range(y0, y0 + 5):
            t = (y - y0) / 5.0
            w = rx * (0.55 + 0.75 * t)
            x0 = 8 - w
            cv.hline(int(x0), int(8 + w), y, leaf if (y - y0) < 3 else shade(leaf, 0.85))
    cv.rect(7, 19, 8, 22, trunk)
    cv.outline()
    return cv

def palm(leaf, leaf_d, trunk):
    cv = Canvas(16, 24)
    for y in range(11, 24):
        x = 7 + (1 if y >= 16 else 0)
        cv.set(x, y, trunk); cv.set(x + 1, y, trunk)
        if (y - 11) % 3 == 2: cv.set(x, y, shade(trunk, 0.85))
    for cx, cy in [(8, 6), (5, 8), (11, 8)]:
        cv.ellipse(cx, cy, 3.2, 2.2, leaf)
    cv.ellipse(8, 5, 2.4, 1.6, leaf_d)
    for dx, i in [(1, 0), (-1, 1)]:
        for k in range(3):
            cv.set(14 + dx, 10 + k, leaf)
            cv.set(1 - dx + 0, 9 + k, leaf)
    cv.outline()
    return cv

def rock():
    cv = Canvas(16, 10)
    s = hx("#9a948c")
    cv.ellipse(8, 7, 5.5, 2.8, s)
    cv.ellipse(7, 6, 3.0, 1.8, shade(s, 1.18))
    cv.ellipse(10, 8, 2.0, 1.2, shade(s, 0.8))
    cv.outline()
    return cv

def stump():
    cv = Canvas(16, 12)
    w = hx("#a57c4e")
    cv.rect(5, 5, 10, 10, w)
    cv.rect(5, 5, 10, 6, shade(w, 1.2))
    cv.ellipse(7.5, 5.5, 2.8, 1.2, shade(w, 1.35))
    cv.ellipse(7.5, 7.5, 1.0, 0.5, shade(w, 0.7))
    cv.outline()
    return cv

def gear():   # 機械島的擺設：半埋在土裡的廢棄齒輪（金屬灰＋鏽點）
    cv = Canvas(16, 12)
    body, dark, hi = hx("#8a94a4"), hx("#5a6070"), hx("#a8b2c2")
    cx, cy, r = 8.0, 7.0, 4.2
    for i in range(8):   # 八根齒
        a = math.pi * 2 * i / 8
        gx, gy = cx + math.cos(a) * (r + .8), cy + math.sin(a) * (r + .8) * .9
        cv.rect(round(gx) - 1, round(gy) - 1, round(gx) + 1, round(gy) + 1, body)
    cv.ellipse(cx, cy, r, r * .9, body)
    cv.ellipse(cx, cy, r * .45, r * .4, dark)   # 中孔
    for px, py in ((5, 5), (11, 6), (8, 10), (10, 4)):   # 鏽點與亮部
        cv.set(px, py, hx("#9a6a3a")); cv.set(px + 1, py, shade(body, 1.15))
    cv.hline(4, 12, 3, hi)
    cv.outline()
    return cv

# 命令提示圖示（壓力山大；行人號誌風，16×16，顯示時放大＋關閉平滑）：
# act＝行動命令＝綠框黑底＋走路小綠人；still＝靜止命令＝黑底圓角＋站立小紅人。字元：#=框 O=人 .=底
_ICON_ACT = [
    "################",
    "#..............#",
    "#.......OO.....#",
    "#......OOOO....#",
    "#......OOOO....#",
    "#..O...OOO.....#",
    "#..OO.OOOO.O...#",
    "#...OOOOOO.O...#",
    "#.....OOOO.....#",
    "#....OO.OO.....#",
    "#...OO...OO....#",
    "#..OO.....OO...#",
    "#..O.......OO..#",
    "#...........O..#",
    "#..............#",
    "################",
]
_ICON_STILL = [
    "................",
    "....OOOOOO......",
    "...OOOOOOOO.....",
    "...OOOOOOOO.....",
    "...OOOOOOOO.....",
    "..OO.OOOO.OO....",
    "..OO.OOOO.OO....",
    "..OO.OOOO.OO....",
    "..OO.OOOO.OO....",
    "..OO.OOOO.OO....",
    "....OOOOOO......",
    "...OOOOOOOO.....",
    "...OOO..OOO.....",
    "...OOO..OOO.....",
    "..OOOO..OOOO....",
    "................",
]

def _icon_from(rows, frame, person, bg):
    """把字元矩陣畫成 16×16 圖示：frame＝框色（None＝無框）、person＝人形色、bg＝底色。"""
    cv = Canvas(16, 16)
    cv.rect(0, 0, 15, 15, hx(bg))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "O":
                cv.set(x, y, hx(person))
            elif ch == "#":
                cv.set(x, y, hx(frame))
    return cv

def command_icon_act():
    return _icon_from(_ICON_ACT, frame="#3ad45a", person="#4ae06a", bg="#141018")

def command_icon_still():
    return _icon_from(_ICON_STILL, frame=None, person="#f04a3a", bg="#1a1214")


def flower(petal="#e26a8a"):
    cv = Canvas(8, 8)
    cv.vline(3, 5, 7, hx("#4d8a3a"))
    cv.ellipse(3, 2, 2.4, 2.0, hx(petal))
    cv.set(3, 2, hx("#f2d24e"))
    return cv

def shell():
    cv = Canvas(12, 10)
    p = hx("#f2b8c6")
    cv.ellipse(6, 8, 4.5, 3.0, p)
    cv.vline(6, 5, 10, shade(p, 0.75))
    cv.outline()
    return cv

def mushroom():
    cv = Canvas(12, 14)
    cap = hx("#c9503c")
    cv.rect(4, 6, 7, 11, hx("#e8dcc4"))
    cv.ellipse(5.5, 4.5, 5.0, 3.6, cap)
    cv.set(4, 3, hx("#f2e4d0")); cv.set(7, 4, hx("#f2e4d0"))
    cv.outline()
    return cv

def glowshroom():
    cv = Canvas(16, 18)
    m = hx("#4fd8b8")
    cv.rect(6, 8, 9, 13, hx("#2a3a58"))
    cv.ellipse(7.5, 6, 5.2, 3.4, m)
    cv.ellipse(7, 5, 2.0, 1.2, shade(m, 1.3))
    for dx, dy in [(0, 2), (3, 1), (-2, 3), (1, -1), (-1, 4)]:
        cv.set(6 + dx, 5 + dy, shade(m, 1.45))
    cv.outline()
    return cv

def lantern():
    cv = Canvas(12, 20)
    f = hx("#8a7a4a"); g = hx("#ffe27a")
    cv.rect(5, 12, 6, 18, f)
    cv.rect(4, 5, 7, 11, g)
    cv.rect(3, 4, 8, 5, f)
    cv.rect(3, 5, 3, 11, f); cv.rect(8, 5, 8, 11, f)
    cv.rect(3, 11, 8, 12, f)
    cv.outline()
    return cv

def volcanic():
    cv = Canvas(16, 14)
    lv = hx("#ff8a3a")
    cv.rect(2, 3, 13, 10, hx("#4a3a38"))
    cv.rect(6, 4, 9, 9, lv)
    cv.ellipse(7.5, 4, 3.0, 1.2, shade(lv, 1.35))
    for i, dx in enumerate([1, 2, 0]):
        cv.set(5 + dx, 9 + i, shade(lv, 0.9))
    cv.outline((28, 22, 20, 255))
    return cv

# ---------------- 角色 (16x24) ----------------
SKINS = {
    "pale":  ("#f7ddbf", "#dcb992"),
    "light": ("#f0c8a0", "#d4a37c"),
    "tan":   ("#d9a06a", "#b27e4f"),
    "deep":  ("#9c6238", "#7a4a2a"),
}
# ---------------- 人物分層 sheet（外部底圖，2026-11-07）----------------
# 底圖＝使用者自製的像素小人：client/assets/external/img2pixel/char_base_walk.png
#   （256×256；4 列方向 × 2 幀、每格 64×64；列0 正面、列1 朝右、列2 朝左、列3 背面；每列只有 a,b 兩張走路輪播）
# 這裡把底圖拆成「軀幹（膚色）」與「褲子」兩層，再依遊戲的標準排列重排：
#   8 方向（CHAR_DIRS）× [待機 4 幀, 走路 4 幀] ＋ 最後 1 幀坐姿 ＝ 65 幀，每幀 64×64（CHAR_FW×CHAR_FH）、1:1 不縮放。
#   沒有斜角方向的專用圖：斜角沿用同側的側面圖（BASE_ROW）；待機＝該方向的第 1 幀；坐姿暫用正面待機。
# 衣服／頭髮／帽子沒有獨立素材，先用同一張底圖的輪廓現地生成 placeholder（見 _draw_part）；
# 之後換正式素材＝照同一排列畫好、覆蓋同名檔（char_body_*／char_bottom_basic／char_top_*／char_hat_*／char_hair*）。
# 幀表由下面的 avatar.json 輸出（frames 的 w/h＝CHAR_FW/CHAR_FH、scale＝CHAR_SCALE）。
BASE_CHAR = "external/img2pixel/char_base_walk.png"
CHAR_FW, CHAR_FH = 64, 64
CHAR_SCALE = 1                                  # 遊戲把每幀放大幾倍畫（引擎讀 avatar.json 的 frames.scale）；底圖已是 64px，畫 1 倍
CHAR_DIRS = ["down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left"]
BASE_ROW = {"down": 0, "down_right": 2, "right": 2, "up_right": 2, "up": 3, "up_left": 1, "left": 1, "down_left": 1}   # 列1 朝左、列2 朝右（依頭部輪廓的不對稱實測：列1 左側突出＝臉朝左）
CHAR_FRAMES = len(CHAR_DIRS) * 8 + 1
CHAR_SIT = len(CHAR_DIRS) * 8
BASE_SKIN = ((255, 225, 183), (247, 175, 143))   # 底圖膚色：亮／暗（做 4 種膚色時以這兩個為對應基準）
BASE_PANTS_BRIGHT, BASE_PANTS_MID = (164, 165, 181), (106, 108, 130)   # 底圖牛仔褲：亮／中（深的是輪廓）

def char_states():
    st = {}
    for i, d in enumerate(CHAR_DIRS):
        st[f"{d}_idle"] = [i * 8 + k for k in range(4)]
        st[f"{d}_walk"] = [i * 8 + 4 + k for k in range(4)]
    st["sit"] = [CHAR_SIT]
    if "char_attack_frames" in globals():
        st.update(char_attack_frames()[1])   # 攻擊動作（LPC 揮砍／突刺／施法／射擊）
    return st

_base_px = None
def _base():
    global _base_px
    if _base_px is None:
        p = read_png_pixels(os.path.join(ASSETS, BASE_CHAR))
        if p is None:
            raise SystemExit(f"找不到人物底圖 {BASE_CHAR}（授權見 docs/assets-license.md）")
        _base_px = p
    return _base_px

def _bpx(x, y):
    w, h, d = _base()
    i = (y * w + x) * 4
    return (d[i], d[i + 1], d[i + 2], d[i + 3])

def _is_skin(c):
    r, g, b, a = c
    return a > 16 and r > 175 and g > 120 and b < 215 and r > b + 12 and r >= g

def _is_gray(c):   # 底圖烘進去的腳下陰影（低飽和灰）：砍掉，遊戲自己會畫影子
    r, g, b, a = c
    return a > 16 and abs(r - g) < 12 and abs(g - b) < 20 and 45 < r < 110

_regions_cache = {}
def _base_regions(fx, fy):
    """回傳 (minx, miny, maxx, maxy, head_bottom, pants_top, foot_bottom)；座標為幀內 0..63。"""
    key = (fx, fy)
    if key in _regions_cache:
        return _regions_cache[key]
    minx, miny, maxx, maxy = 999, 999, -1, -1
    for y in range(CHAR_FH):
        for x in range(CHAR_FW):
            if _bpx(fx + x, fy + y)[3] > 16:
                minx, miny = min(minx, x), min(miny, y)
                maxx, maxy = max(maxx, x), max(maxy, y)
    H = maxy - miny + 1
    foot = maxy
    for y in range(CHAR_FH - 1, -1, -1):
        if any(_bpx(fx + x, fy + y)[3] > 16 and not _is_gray(_bpx(fx + x, fy + y)) for x in range(CHAR_FW)):
            foot = y
            break
    # 腳（膚色）從哪一列開始：那列以下算軀幹（腿＝褲子、腳＝膚色）
    foot_top = foot + 1
    for y in range(miny + round(0.62 * H), foot + 1):
        if any(_is_skin(_bpx(fx + x, fy + y)) for x in range(CHAR_FW)):
            foot_top = y
            break
    reg = (minx, miny, maxx, maxy, miny + round(0.24 * H), miny + round(0.62 * H), foot, foot_top)
    _regions_cache[key] = reg
    return reg

def _src_frame(d, f):
    return (f % 2) * CHAR_FW, BASE_ROW[d] * CHAR_FH

def _align(cv, foot):
    """把腳對齊到幀底（第 CHAR_FH-1 列），讓所有方向的腳站在同一條地上（底圖腳下留了空＋影子列）。"""
    out = Canvas(CHAR_FW, CHAR_FH)
    dy = (CHAR_FH - 1) - foot
    for y in range(CHAR_FH):
        for x in range(CHAR_FW):
            c = cv.get(x, y)
            if c[3]:
                out.set(x, y + dy, c)
    return out

_split_cache = {}
def _draw_split(d, f, part):
    """part＝'torso'（膚色）或 'pants'（褲子）：把底圖那一幀依腰線／腳切開。"""
    key = (d, f, part)
    if key in _split_cache:
        return _split_cache[key]
    fx, fy = _src_frame(d, f)
    minx, miny, maxx, maxy, head_b, pants_t, foot, foot_top = _base_regions(fx, fy)
    cv = Canvas(CHAR_FW, CHAR_FH)
    for y in range(CHAR_FH):
        for x in range(CHAR_FW):
            c = _bpx(fx + x, fy + y)
            if c[3] <= 16 or y > foot or _is_gray(c):
                continue
            is_pants = pants_t <= y < foot_top and not _is_skin(c)
            if (part == "pants") == is_pants:
                cv.set(x, y, c)
    out = _align(cv, foot)
    _split_cache[key] = out
    return out

def _recolor_skin(cv, tb, ts):
    out = Canvas(cv.w, cv.h)
    for y in range(cv.h):
        for x in range(cv.w):
            c = cv.get(x, y)
            if c[3] == 0:
                continue
            rgb = (c[0], c[1], c[2])
            if rgb == BASE_SKIN[0] or (rgb[0] > 235 and rgb[1] > 200 and rgb[2] > 160):
                out.set(x, y, (tb[0], tb[1], tb[2], c[3]))
            elif rgb == BASE_SKIN[1]:
                out.set(x, y, (ts[0], ts[1], ts[2], c[3]))
            else:
                out.set(x, y, c)
    return out

def _recolor_pants(cv, main, shd):
    out = Canvas(cv.w, cv.h)
    dk = shade(main, 0.5)
    for y in range(cv.h):
        for x in range(cv.w):
            c = cv.get(x, y)
            if c[3] == 0:
                continue
            lum = .299 * c[0] + .587 * c[1] + .114 * c[2]
            col = main if lum > 140 else shd if lum > 95 else dk
            out.set(x, y, (col[0], col[1], col[2], c[3]))
    return out

def _char_sheet(draw):
    """draw(d, f) → Canvas(CHAR_FW×CHAR_FH) 或 None；排成 65 幀的 sheet（置中、不縮放）。"""
    sheet = Canvas(CHAR_FW * CHAR_FRAMES, CHAR_FH)
    def blit(fi, cv):
        if cv is None:
            return
        for y in range(CHAR_FH):
            for x in range(CHAR_FW):
                c = cv.get(x, y)
                if c[3]:
                    sheet.set(fi * CHAR_FW + x, y, c)
    for i, d in enumerate(CHAR_DIRS):
        for k in range(4):
            blit(i * 8 + k, draw(d, 0))            # 待機 4 幀（同一張）
        for k in range(4):
            blit(i * 8 + 4 + k, draw(d, k % 2))    # 走路 a,b,a,b
    blit(CHAR_SIT, draw("down", 0))                # 坐姿暫用正面待機
    return sheet

def char_body_sheet(skin_key):
    tb, ts = hx(SKINS[skin_key][0]), hx(SKINS[skin_key][1])
    return _char_sheet(lambda d, f: _recolor_skin(_draw_split(d, f, "torso"), tb, ts))

def char_bottom_sheet(main_hex, shd_hex):
    main, shd = hx(main_hex), hx(shd_hex)
    return _char_sheet(lambda d, f: _recolor_pants(_draw_split(d, f, "pants"), main, shd))

_part_cache = {}
def _draw_part(d, f, kind, main, shd, back):
    """沒有獨立素材的衣服／頭髮／帽子 placeholder：用底圖的輪廓現地塗色。
    kind：'top'（軀幹膚色範圍＝上衣）／'hair'（頭部上緣＋兩側，正面留臉）／'hat'（頭頂一小塊）。"""
    key = (d, f, kind, main, shd, back)
    if key in _part_cache:
        return _part_cache[key]
    fx, fy = _src_frame(d, f)
    minx, miny, maxx, maxy, head_b, pants_t, foot, foot_top = _base_regions(fx, fy)
    H = maxy - miny + 1
    cv = Canvas(CHAR_FW, CHAR_FH)
    for y in range(CHAR_FH):
        for x in range(CHAR_FW):
            c = _bpx(fx + x, fy + y)
            if c[3] <= 16 or y > foot or _is_gray(c) or not _is_skin(c):
                continue
            col = None
            if kind == "top" and head_b <= y < foot_top:
                col = main if y < (head_b + foot_top) // 2 else shd
            elif kind == "hair" and miny <= y < head_b:
                face = (not back) and y >= miny + round(0.16 * H) and minx + 4 <= x <= maxx - 4
                if not face:
                    col = main if y < miny + round(0.10 * H) else shd
            elif kind == "hat" and y < miny + round(0.15 * H):
                col = main if y < miny + round(0.07 * H) else shd
            if col:
                cv.set(x, y, col)
    out = _align(cv, foot)
    _part_cache[key] = out
    return out

# ---------------- 職業裝備與外觀（帽子／上衣／褲子）----------------
# 每件一張標準排列的 sheet（與 char_top_basic 等同一套排列）。dye＝可染色的原色（第一個是主色；client 換色時
# 主色換成玩家選的顏色、其他依與主色的明暗比例跟著換），其餘顏色（點綴）不換色。
# 形狀：上衣／褲子沿用 body() 依顏色拆出的範圍（換成各職業的顏色＋點綴），長袍類（robe）把上衣往下蓋住褲子前 3 列；
# 帽子另外畫（正面／背面；坐姿整體下移 3 列）。之後換成正式素材只要照排列畫、覆蓋同名檔。
GEAR_TOPS = {   # id: (名稱, 主色, 陰影, 點綴函式, 長袍)
    "knight_top":    ("騎士鎧甲", "#8fa6c8", "#6a7f9e", "plate", False),
    "warrior_top":   ("戰士皮甲", "#b5452f", "#8a3322", "fur", False),
    "whitemage_top": ("白魔長袍", "#f0ece0", "#c8c0ac", "trim_red", True),
    "sage_top":      ("賢者長袍", "#3a9a8a", "#2a7466", "trim_gold", True),
    "ninja_top":     ("忍者上衣", "#4a3a6a", "#352a4e", "sash", False),
    "dragoon_top":   ("龍騎士鎧甲", "#3a4a8a", "#2a3668", "plate", False),
    "bard_top":      ("詩人外衣", "#4a8a3a", "#366a2a", "trim_gold", False),
    "blackmage_top": ("黑魔長袍", "#2e3a7a", "#1f2858", "trim_gold", True),
}
GEAR_BOTTOMS = {
    "knight_bottom":    ("騎士腿甲", "#5a6a88", "#46536c"),
    "warrior_bottom":   ("戰士褲", "#5a4030", "#45301f"),
    "whitemage_bottom": ("白魔長褲", "#d8d0bc", "#b0a890"),
    "sage_bottom":      ("賢者長褲", "#2e6a62", "#1f4e48"),
    "ninja_bottom":     ("忍者褲", "#3a2e52", "#2a2140"),
    "dragoon_bottom":   ("龍騎士腿甲", "#2e3a6a", "#222b50"),
    "bard_bottom":      ("詩人長褲", "#5a4a3a", "#45382a"),
    "blackmage_bottom": ("黑魔長褲", "#2a3060", "#1d2246"),
}
GEAR_HATS = {   # id: (名稱, 主色, 陰影, 畫法)
    "knight_hat":    ("騎士頭盔", "#a8b8d0", "#7a8aa4", "helm"),
    "warrior_hat":   ("戰士角盔", "#8a5a3a", "#6a4228", "horned"),
    "whitemage_hat": ("白魔兜帽", "#f0ece0", "#c8c0ac", "hood"),
    "sage_hat":      ("賢者頭冠", "#e0c040", "#b08a28", "circlet"),
    "ninja_hat":     ("忍者頭巾", "#4a3a6a", "#352a4e", "band"),
    "dragoon_hat":   ("龍騎士頭盔", "#3a4a8a", "#2a3668", "dragoon"),
    "bard_hat":      ("羽毛帽", "#4a8a3a", "#366a2a", "feather"),
    "blackmage_hat": ("黑魔尖帽", "#2e3a7a", "#1f2858", "pointy"),
}
# ---------------- 衣服／頭髮／帽子的 sheet（用上面的 _draw_part 現地生成 placeholder）----------------
# 便服上衣（第一款；也是舊客戶端／沒指定時的預設款）；顏色與 avatar.json 的 dye 對應
def basic_top_sheet():
    return _char_sheet(lambda d, f: _draw_part(d, f, "top", hx("#d95c68"), hx("#aa474f"), d == "up"))

# ---------------- 髮型模組（LPC 通用格式外部素材）----------------
# 使用者提供的髮型是 LPC 通用格式：832×1344＝13 欄 × 21 列、每格 64×64（單層、透明底、12 種顏色）。
# LPC 的列＝動作：0-3 施法(7 幀)、4-7 突刺(8)、8-11 走路(9)、12-15 揮砍(6)、16-19 射擊(13)、20 受擊(6)；
#   每組四列的順序＝朝上/朝左/朝下/朝右（走路＝列 8 上、9 左、10 下、11 右）。
# 這裡只取走路四列、縮放 LPC_SCALE 對齊我們底圖的頭部，重排成遊戲的 65 幀髮型 sheet（疊在頭髮層）。
# 之後再加別的 LPC 髮型：把檔名加進 KIDOL_HAIR（或另開清單）呼叫 lpc_hair_sheet 即可。
LPC_SCALE = 0.72                 # LPC 模組 → 遊戲底圖的縮放比例（以 64px 底圖的頭部對齊校準；見 docs/notes.md）
LPC_ROW_OF = {"down": 10, "down_right": 11, "right": 11, "up_right": 11, "up": 8, "up_left": 9, "left": 9, "down_left": 9}
LPC_PICK = [0, 1, 2, 1]          # 走路 9 幀循環取 4 幀（觸地-通過-觸地-通過）；待機＝站立幀 0
KIDOL_HAIR = [                   # LPC 短髮模組的 12 種顏色 (檔名後綴, 名稱)
    ("brown", "棕"), ("brown2", "深棕"), ("black", "黑"), ("blonde", "金"),
    ("ashblonde", "灰金"), ("ashplatinum", "銀白"), ("red", "紅"), ("orange", "橘"),
    ("rosepink", "玫瑰粉"), ("green", "綠"), ("blue", "藍"), ("purple", "紫"),
]
LPC_CLOTHES = [                  # 基本服裝與職業裝備（LPC 原檔）：(遊戲檔名, external 底下的檔名)
    ("top_tshirt_m", "top_tshirt_m.png"), ("top_tshirt_f", "top_tshirt_f.png"),
    ("bottom_pants_m", "bottom_pants_m.png"), ("bottom_pants_f", "bottom_pants_f.png"),
    ("shoes_m", "shoes_m.png"), ("shoes_f", "shoes_f.png"),
    # 騎士（2026-11-09）：板甲（上身＋護臂合成一張）、板甲腿甲、板甲靴、Armet 頭盔（男女共用）
    ("top_plate_m", "top_plate_m.png"), ("top_plate_f", "top_plate_f.png"),
    ("bottom_plate_m", "bottom_plate_m.png"), ("bottom_plate_f", "bottom_plate_f.png"),
    ("shoes_plate_m", "shoes_plate_m.png"), ("shoes_plate_f", "shoes_plate_f.png"),
    ("hat_armet", "hat_armet.png"),
    # LPC 武器圖層（一般格：走路列＝拿在手上；bg＝身體後面、fg＝最上面）
    ("weapon_arming_bg", "weapon_arming_bg.png"), ("weapon_arming_fg", "weapon_arming_fg.png"),
]
LPC_WEAPON_OVER = [             # LPC 武器的超大格動作 sheet（128×128；直接複製）：(遊戲檔名, external 底下的檔名)
    ("weapon_arming_slash_bg", "weapon_arming_slash_bg.png"), ("weapon_arming_slash_fg", "weapon_arming_slash_fg.png"),
]
LPC_HAIR_STYLES = [              # 其他 LPC 髮型（走路列，原檔是單色，這裡依亮度重上色成多色）：(id, 名稱, external 檔名)
    ("afro", "爆炸頭", "hair_afro.png"),
    ("bob", "鮑伯頭", "hair_bob.png"),
    ("curly", "捲長髮", "hair_curly.png"),
    ("long", "長髮", "hair_long.png"),
]
LPC_SKIN_DYE = ["#f9d5ba", "#e4a47c", "#cc8665", "#99423c", "#faecd7"]   # LPC 膚色調色盤（臉型跟膚色重上色用）
LPC_CAT_FUR = ["#ff8a00", "#e55600", "#bf4000", "#a42600"]   # LPC 貓耳毛色（依亮度映射成髮色；深色輪廓與耳內白不在此列＝保留／粉肉色）
LPC_FACES = [                    # 臉型（頭型）：(id, 名稱, external 檔名)
    ("normal", "普通", "f_normal.png"), ("gaunt", "瘦長", "f_gaunt.png"),
    ("plump", "圓胖", "f_plump.png"), ("small", "小頭", "f_small.png"), ("old", "老臉", "f_old.png"),
]
LPC_EYES = [                     # 眼睛（表情）：(id, 名稱, external 檔名)
    ("default", "預設", "e_default.png"), ("angry", "生氣", "e_angry.png"), ("sad", "難過", "e_sad.png"),
    ("lookl", "看左", "e_lookl.png"), ("lookr", "看右", "e_lookr.png"),
]
LPC_EYE_IRIS = [(126, 78, 32)]   # LPC 眼睛的虹膜主色（整層重上色的明暗基準）
LPC_EARS = [                     # 種族耳朵圖層：(遊戲檔名, external 檔名)
    ("ears_elven", "ear_elven.png"), ("ears_cat_bg", "ear_cat_bg.png"), ("ears_cat_fg", "ear_cat_fg.png"),
]
# 種族：人類＝無耳朵；精靈＝精靈耳（跟膚色）；貓族＝貓耳（bg+fg）；拉拉肥/巨人＝找人類模組縮放（LPC 沒有專用體型）
LPC_RACES = [                    # 種族：耳朵圖層＝sheet（來自 LPC ears）；scale＝人類模組整體縮放倍率
    dict(id="human", name="人類", scale=1.0),
    dict(id="elf", name="精靈", scale=1.0, ear="char_ears_elven.png", earDye=LPC_SKIN_DYE),   # 精靈耳跟膚色
    dict(id="cat", name="貓族", scale=1.0, earBg="char_ears_cat_bg.png", earFg="char_ears_cat_fg.png",
         earFur=LPC_CAT_FUR, earInner="#f5b8ad"),   # 貓耳：毛色跟髮色（earFur）、耳內白眼底＝粉肉色（earInner）、深色輪廓保留原色
    dict(id="lalafell", name="拉拉肥", scale=0.5),    # LPC 沒有小人體型 → 人類模組縮小
    dict(id="giant", name="巨人", scale=1.5),         # LPC 沒有巨人體型 → 人類模組放大
]

def kidol_main_hex(cid):
    """取 k-idol 短髮某色 sheet 的「主色」（走路列）→ '#rrggbb'。其他髮型照這 12 色重上色。
    取色法：先排除深色輪廓（亮度 < 55）；「最亮」的常見色（升列 ≥ 2%）當上限，
    不是直接取最常見——最常見的常是暗階陰影（例如銀白取到棕色會變「褐色銀白」）。"""
    r = read_png_pixels(os.path.join(ASSETS, f"external/img2pixel/hair_kidol/kidol_hairstyle_male_{cid}.png"))
    if r is None:
        raise SystemExit(f"找不到 k-idol 髮型 {cid}")
    w, h, data = r
    cnt = {}
    for y in range(LPC_WALK_BASE * CHAR_FH, min(h, (LPC_WALK_BASE + 4) * CHAR_FH)):
        for x in range(w):
            i = (y * w + x) * 4
            if data[i + 3] <= 16:
                continue
            if 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 55:
                continue   # 輪廓／陰影不算
            k = (data[i] >> 3, data[i + 1] >> 3, data[i + 2] >> 3)
            cnt[k] = cnt.get(k, 0) + 1
    tot = sum(cnt.values())
    top_lum = max((0.299 * (k[0] << 3) + 0.587 * (k[1] << 3) + 0.114 * (k[2] << 3)) for k, n in cnt.items() if n >= tot * .02)
    k = max((k for k, n in cnt.items()
             if 0.299 * (k[0] << 3) + 0.587 * (k[1] << 3) + 0.114 * (k[2] << 3) >= top_lum * .45),
            key=lambda k: cnt[k])   # 常見色裡取「亮度 ≥ 上限 45%」的最常見者
    return "#%02x%02x%02x" % (k[0] << 3, k[1] << 3, k[2] << 3)

def _lpc_hair_cell(w, data, row, f):
    """把 LPC sheet 的 (列, 幀) 那格縮放 LPC_SCALE、對齊我們的頭部，回傳 Canvas(64×64)。"""
    k = LPC_SCALE
    dx = round(CHAR_FW / 2 - CHAR_FW / 2 * k)   # 水平置中
    dy = round(14 - 13 * k)                      # 髮帽頂（LPC y13）對到我們底圖頭頂上方一點（y14），貼緊頭皮
    cv = Canvas(CHAR_FW, CHAR_FH)
    for oy in range(round(CHAR_FH * k)):
        sy = row * CHAR_FH + min(CHAR_FH - 1, int(round(oy / k)))
        for ox in range(round(CHAR_FW * k)):
            sx = f * CHAR_FW + min(CHAR_FW - 1, int(round(ox / k)))
            i = (sy * w + sx) * 4
            if data[i + 3] > 16:
                cv.set(ox + dx, oy + dy, (data[i], data[i + 1], data[i + 2], data[i + 3]))
    return cv

def lpc_hair_sheet(rel):
    """rel＝相對 client/assets/ 的 LPC 髮型檔（832×1344）→ 遊戲 65 幀髮型 sheet。"""
    r = read_png_pixels(os.path.join(ASSETS, rel))
    if r is None:
        raise SystemExit(f"找不到髮型模組 {rel}")
    w, h, data = r
    cache = {}
    def cell(d, f):
        key = (d, f)
        if key not in cache:
            cache[key] = _lpc_hair_cell(w, data, LPC_ROW_OF[d], f)
        return cache[key]
    sheet = Canvas(CHAR_FW * CHAR_FRAMES, CHAR_FH)
    def blit(fi, cv):
        for y in range(CHAR_FH):
            for x in range(CHAR_FW):
                c = cv.get(x, y)
                if c[3]:
                    sheet.set(fi * CHAR_FW + x, y, c)
    for i, d in enumerate(CHAR_DIRS):
        for k2 in range(4):
            blit(i * 8 + k2, cell(d, 0))                 # 待機 4 幀＝站立
        for k2 in range(4):
            blit(i * 8 + 4 + k2, cell(d, LPC_PICK[k2]))  # 走路 4 幀
    blit(CHAR_SIT, cell("down", 0))                      # 坐姿暫用正面站立
    return sheet

# ---------------- LPC 通用格式（2026-11-08 大改：角色整個改用 LPC 通用格式）----------------
# 角色每個部位都是一張 832×1344＝13 欄 × 21 列、每格 64×64 的 LPC 通用格式 sheet（下載的 LPC 素材可直接用）。
# 列＝動作組：0-3 施法(7)、4-7 突刺(8)、8-11 走路(9)、12-15 揮砍(6)、16-19 射擊(13)、20 受擊(6)；
#   每組四列的順序＝上/左/下/右。遊戲只用「走路」組（列 8-11）：待機＝該列第 0 幀、走路＝第 1,3,5,7 幀、斜角沿用同側。
# 素體＝LPC 的 body＋head＋eyes 三層疊成（source 在 external/img2pixel/lpc/）。
LPC_COLS, LPC_ROWS = 13, 21
LPC_WALK_BASE = 8
LPC_DIR = {"down": 2, "down_right": 3, "right": 3, "up_right": 3, "up": 0, "up_left": 1, "left": 1, "down_left": 1}
LPC_WALK_COLS = [1, 3, 5, 7]

# 攻擊動作（LPC 通用格式的動作組）：id → (起始列, 用到的欄)。每組四列＝上/左/下/右。
# 加在 65 個基本邏輯幀之後；states 多出「動作_8方向」（斜角沿用同側，同 LPC_DIR）。
# map 的第三格＝退回幀：素材缺這個動作（例如只下載了走路列）時，改畫該方向的待機幀（main.js 的 charSprite 檢查素體那一格有沒有圖）。
LPC_ATTACKS = {
    "slash": (12, [0, 1, 2, 3, 4, 5]),                   # 揮砍：騎士、戰士、忍者、採集
    "thrust": (4, [0, 1, 2, 3, 4, 5, 6, 7]),            # 突刺：龍騎士
    "spellcast": (0, [0, 1, 2, 3, 4, 5, 6]),            # 施法：法杖／咒杖／魔導書（詠唱中依讀條進度播）
    "shoot": (16, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),   # 射擊：豎琴弓
}
LPC_DIR4 = ["up", "left", "down", "right"]
CHAR_IDLE_OF4 = {"up": CHAR_DIRS.index("up") * 8, "left": CHAR_DIRS.index("left") * 8,
                 "down": CHAR_DIRS.index("down") * 8, "right": CHAR_DIRS.index("right") * 8}

def char_attack_frames():
    """攻擊動作的邏輯幀：回 (map 條目清單, states)；邏輯幀編號從 CHAR_FRAMES 往後排。"""
    m, st, fi = [], {}, CHAR_FRAMES
    for anim, (row0, cols) in LPC_ATTACKS.items():
        by4 = {}
        for k, d4 in enumerate(LPC_DIR4):
            by4[d4] = []
            for c in cols:
                m.append([c, row0 + k, CHAR_IDLE_OF4[d4]])
                by4[d4].append(fi); fi += 1
        for d in CHAR_DIRS:
            st[f"{anim}_{d}"] = by4[LPC_DIR4[LPC_DIR[d]]]
    return m, st

def char_frame_map():
    """遊戲 65 個邏輯幀 → LPC sheet 的 [欄, 列]（之後接攻擊動作的幀，見 char_attack_frames）。"""
    m = []
    for d in CHAR_DIRS:
        row = LPC_WALK_BASE + LPC_DIR[d]
        for _ in range(4):
            m.append([0, row])                 # 待機 4 幀＝站立
        for k in range(4):
            m.append([LPC_WALK_COLS[k], row])   # 走路 4 幀
    m.append([0, LPC_WALK_BASE + 2])            # 坐姿暫用正面走路幀 0
    return m + char_attack_frames()[0]

def lpc_act_sources(rel):
    """一張 LPC 走路來源圖（external/img2pixel/lpc/<名稱>.png）＋它的攻擊動作檔（同資料夾 act/<名稱>_<動作>.png）：
    回 [(相對路徑, 要放的起始 y)]；攻擊動作放在 LPC_ATTACKS 的起始列（揮砍 12、突刺 4、施法 0、射擊 16），沒有檔就略過。"""
    out = [(rel, LPC_WALK_BASE * CHAR_FH)]
    d, fn = os.path.split(rel)
    stem = fn[:-4]
    for anim, (row0, _cols) in LPC_ATTACKS.items():
        a = f"{d}/act/{stem}_{anim}.png"
        if os.path.exists(os.path.join(ASSETS, a)):
            out.append((a, row0 * CHAR_FH))
    return out

def _lpc_overlay(sheet, rel, oy0):
    if oy0 == LPC_WALK_BASE * CHAR_FH and "/act/" not in rel:   # 走路列：順便把攻擊動作檔疊到各自的列
        for r2, oy in lpc_act_sources(rel)[1:]:
            _lpc_overlay(sheet, r2, oy)
    r = read_png_pixels(os.path.join(ASSETS, rel))
    if r is None:
        raise SystemExit(f"找不到 LPC 素材 {rel}")
    w, h, data = r
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if data[i + 3] > 16:
                sheet.set(x, oy0 + y, (data[i], data[i + 1], data[i + 2], data[i + 3]))

def lpc_body_sheet(gender="male", skin_key="light"):
    """身體（不含頭與眼睛）→ 832×1344；再把膚色重上色成目標膚色。頭/眼睛是另外的圖層（臉型/眼睛）。"""
    body = "base_body_walk.png" if gender == "male" else "base_body_female.png"
    sheet = Canvas(LPC_COLS * CHAR_FW, LPC_ROWS * CHAR_FH)
    _lpc_overlay(sheet, f"external/img2pixel/lpc/{body}", LPC_WALK_BASE * CHAR_FH)
    # 膚色重上色：LPC 膚色以主色 (249,213,186) 的亮度為基準，換成目標膚色（保留明暗）
    tr = hx(SKINS[skin_key][0])
    ref = 0.299 * 249 + 0.587 * 213 + 0.114 * 186
    for y in range(sheet.h):
        for x in range(sheet.w):
            c = sheet.get(x, y)
            if c[3] == 0:
                continue
            r, g, b = c[0], c[1], c[2]
            if r > 110 and r >= g and g >= b - 12:   # 膚色系才換
                f = (0.299 * r + 0.587 * g + 0.114 * b) / ref
                sheet.set(x, y, (min(255, round(tr[0] * f)), min(255, round(tr[1] * f)), min(255, round(tr[2] * f)), c[3]))
    return sheet

def lpc_layer_sheet(rel):
    """把一張 LPC 走路圖層（頭/眼睛/…576×256）疊到走路列 → 832×1344（原色，不重上色）。"""
    sheet = Canvas(LPC_COLS * CHAR_FW, LPC_ROWS * CHAR_FH)
    _lpc_overlay(sheet, rel, LPC_WALK_BASE * CHAR_FH)
    return sheet

def lpc_eyes_sheet(rel, target):
    """眼睛圖層：整層像素依明暗重上色成目標色（跟髮色 12 色同一套）→ 832×1344。
    眼白不在這層（在素體頭層），所以不用怕；以虹膜主色亮度為基準，瞳孔輪廓變成深色的目標色。"""
    sheet = lpc_layer_sheet(f"external/img2pixel/lpc/{rel}")
    tr = hx(target)
    b0 = 0.299 * LPC_EYE_IRIS[0][0] + 0.587 * LPC_EYE_IRIS[0][1] + 0.114 * LPC_EYE_IRIS[0][2]
    for y in range(sheet.h):
        for x in range(sheet.w):
            c = sheet.get(x, y)
            if c[3] == 0:
                continue
            f = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / b0
            f = min(f, 1.7)   # 比虹膜主色亮的（沒有）保底；瞳孔變成深色調
            sheet.set(x, y, (min(255, round(tr[0] * f)), min(255, round(tr[1] * f)), min(255, round(tr[2] * f)), c[3]))
    return sheet

def lpc_cloth_sheet(rel):
    """LPC 服裝（走路 9 幀×4 向、576×256）→ 疊到走路列 → 832×1344。"""
    sheet = Canvas(LPC_COLS * CHAR_FW, LPC_ROWS * CHAR_FH)
    _lpc_overlay(sheet, rel, LPC_WALK_BASE * CHAR_FH)
    return sheet

def lpc_hair_tinted(rel, target_hex):
    """LPC 髮型原檔是單色（ginger）；依每個像素亮度相對主色縮放目標色＝重上色成指定顏色，排到走路列。"""
    r = read_png_pixels(os.path.join(ASSETS, rel))
    if r is None:
        raise SystemExit(f"找不到 LPC 髮型 {rel}")
    tr = hx(target_hex)
    ref = 0.299 * 229 + 0.587 * 86 + 0.114 * 0     # 下載檔主色 (229,86,0) 的亮度當基準
    sheet = Canvas(LPC_COLS * CHAR_FW, LPC_ROWS * CHAR_FH)
    for src, oy0 in lpc_act_sources(rel):            # 走路列＋攻擊動作各列
        r = read_png_pixels(os.path.join(ASSETS, src))
        w, h, data = r
        _lpc_hair_tint_into(sheet, w, h, data, tr, ref, oy0)
    return sheet

def _lpc_hair_tint_into(sheet, w, h, data, tr, ref, oy0):
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if data[i + 3] <= 16:
                continue
            f = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / ref
            # ≤1＝乘上比例（變暗）；>1＝往白色推（與 dyeSheet 同步，避免各通道各自封頂造成偏色）
            if f <= 1:
                out = (min(255, round(tr[0] * f)), min(255, round(tr[1] * f)), min(255, round(tr[2] * f)))
            else:
                w2 = min(1.0, f - 1)
                out = (round(tr[0] + (255 - tr[0]) * w2), round(tr[1] + (255 - tr[1]) * w2), round(tr[2] + (255 - tr[2]) * w2))
            sheet.set(x, oy0 + y, (out[0], out[1], out[2], data[i + 3]))
    return sheet

def lpc_dye_of(*files, n=8):
    """從已產生的人物 sheet（client/assets/avatar/ 底下）取「可染色的顏色」：不透明像素依出現次數排序，
    去掉很暗的輪廓色（亮度 < 50），取前 n 個；第一個（最多的）當主色。給 manifest 的 dye 用（client 的 dyeSheet 依明暗比例換色）。"""
    cnt = {}
    for f in files:
        r = read_png_pixels(os.path.join(ASSETS, "avatar", f))
        if r is None:
            continue
        _w, _h, data = r
        for i in range(0, len(data), 4):
            if data[i + 3] <= 16:
                continue
            c = (data[i], data[i + 1], data[i + 2])
            if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 50:
                continue
            cnt[c] = cnt.get(c, 0) + 1
    top = sorted(cnt, key=lambda c: -cnt[c])[:n]
    return ["#%02x%02x%02x" % c for c in top]

def lpc_garment(gid, name, sheet_m, sheet_f, **kw):
    """一件服裝（男女共用一個 id）：sheet＝男、sheetF＝女（client 依角色性別挑），dye＝兩張圖的可染色顏色。"""
    return dict(id=gid, name=name, sheet=sheet_m, sheetF=sheet_f, dye=lpc_dye_of(sheet_m, sheet_f), **kw)

def lpc_read_sheet(rel):
    """直接讀一張 LPC 通用格式 sheet（832×1344）成 Canvas（頭髮等外部素材 1:1，不轉檔）。"""
    r = read_png_pixels(os.path.join(ASSETS, rel))
    if r is None:
        raise SystemExit(f"找不到 LPC 素材 {rel}")
    w, h, data = r
    cv = Canvas(w, h)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if data[i + 3] > 16:
                cv.set(x, y, (data[i], data[i + 1], data[i + 2], data[i + 3]))
    return cv

def gear_top_sheet(tid):
    _, main, shd = GEAR_TOPS[tid][0], GEAR_TOPS[tid][1], GEAR_TOPS[tid][2]
    return _char_sheet(lambda d, f: _draw_part(d, f, "top", hx(main), hx(shd), d == "up"))

def gear_bottom_sheet(bid):
    _, main, shd = GEAR_BOTTOMS[bid]
    return char_bottom_sheet(main, shd)

def gear_hat_sheet(hid):
    _, main, shd, _kind = GEAR_HATS[hid]
    return _char_sheet(lambda d, f: _draw_part(d, f, "hat", hx(main), hx(shd), d == "up"))

# ---------------- 家具 ----------------
def sofa():
    r = hx("#c9544f"); rd = shade(r, 0.72)
    cv = Canvas(16, 15)
    cv.rect(2, 4, 13, 10, r)      # 座面+背
    cv.rect(2, 4, 13, 5, shade(r, 1.12))
    cv.rect(2, 7, 13, 7, shade(r, 0.9))
    cv.rect(2, 4, 3, 11, rd); cv.rect(12, 4, 13, 11, rd)  # 手臂
    cv.rect(2, 11, 13, 12, rd)
    cv.rect(4, 13, 5, 13, hx("#4a3630")); cv.rect(10, 13, 11, 13, hx("#4a3630"))
    cv.outline()
    return cv

def table():
    w = hx("#a57c4e")
    cv = Canvas(16, 14)
    cv.rect(2, 6, 13, 8, w)
    cv.rect(2, 6, 13, 6, shade(w, 1.15))
    cv.rect(2, 8, 13, 8, shade(w))
    cv.rect(4, 9, 5, 12, shade(w, 0.85)); cv.rect(10, 9, 11, 12, shade(w, 0.85))
    cv.outline()
    return cv

def chair():
    w = hx("#b8865a")
    cv = Canvas(16, 14)
    # 比角色（含手臂 10 格寬）更寬一點，坐上去時椅背/椅面才會從兩側露出來
    cv.rect(2, 3, 13, 5, w)      # 背
    cv.rect(2, 6, 13, 8, shade(w, 1.1))   # 座
    cv.rect(2, 6, 2, 8, shade(w, 0.8)); cv.rect(13, 6, 13, 8, shade(w, 0.8))
    cv.rect(3, 9, 3, 12, shade(w, 0.85)); cv.rect(12, 9, 12, 12, shade(w, 0.85))
    cv.outline()
    return cv

def plant():
    cv = Canvas(16, 24)
    leaf = hx("#4d9e46")
    for cx, cy, rx, ry, c in [(8, 8, 4.5, 3.5, leaf), (5, 11, 3.2, 2.6, leaf),
                              (11, 11, 3.2, 2.6, leaf), (8, 12, 2.4, 2.0, shade(leaf, 0.85))]:
        cv.ellipse(cx, cy, rx, ry, c)
    cv.ellipse(6, 7, 1.8, 1.2, shade(leaf, 1.18))
    pot = hx("#b0703f")
    cv.rect(4, 16, 11, 18, pot)
    for x in range(5, 11):
        grad = (min(15, 4 + (x - 4) // 2), 16 + (2 if x == 4 or x == 11 else 0), 21)
    cv.rect(5, 18, 10, 21, shade(pot, 0.85))
    cv.rect(4, 16, 11, 17, pot)
    cv.outline()
    return cv

def rug():
    P = hx("#b3544e"); W = hx("#e8dcc4"); E = hx("#c9807a")
    cv = Canvas(32, 32)
    cv.rect(0, 0, 31, 31, P)
    cv.rect(2, 2, 29, 29, W)
    cv.rect(4, 4, 27, 27, E)
    for y in range(6, 27, 4):
        for x in range(6, 27, 4):
            cv.set(x, y, W)
            if (x + y) % 8 == 0:
                cv.set(x + 2, y + 2, W)
    cv.rect(0, 0, 31, 0, shade(P, 0.8)); cv.rect(0, 31, 31, 31, shade(P, 0.8))
    cv.rect(0, 0, 0, 31, shade(P, 0.8)); cv.rect(31, 0, 31, 31, shade(P, 0.8))
    return cv

def lamp():
    cv = Canvas(16, 24)
    cv.rect(5, 2, 10, 7, hx("#f2e2b0"))
    cv.rect(5, 7, 10, 8, shade(hx("#f2e2b0"), 0.8))
    cv.rect(7, 8, 8, 19, hx("#5a4632"))
    cv.rect(6, 20, 9, 21, shade(hx("#5a4632"), 0.8))
    cv.outline()
    return cv

def tv():
    cv = Canvas(16, 16)
    cv.rect(3, 4, 12, 12, hx("#3c3a44"))
    cv.rect(4, 5, 11, 10, hx("#7ec8e8"))
    cv.rect(10, 5, 10, 10, shade(hx("#7ec8e8"), 0.85))
    cv.rect(5, 13, 6, 14, hx("#2a2830")); cv.rect(9, 13, 10, 14, hx("#2a2830"))
    cv.outline()
    return cv

def cat():
    cv = Canvas(16, 12)
    f = hx("#8a8a94"); fd = shade(f, 0.8)
    cv.ellipse(7, 8, 4.5, 3.0, f)
    cv.ellipse(7, 4.5, 3.0, 2.6, f)
    cv.set(5, 1, f); cv.set(4, 0, f); cv.set(8, 1, f); cv.set(9, 0, f)  # 耳
    cv.set(5, 2, f); cv.set(8, 2, f)
    cv.set(6, 4, (48, 42, 52, 255)); cv.set(8, 4, (48, 42, 52, 255))
    for k, y in enumerate([8, 9, 10]):
        cv.set(12 + k - 1, y - 1, f)
    cv.set(14, 7, f); cv.set(13, 6, f); cv.set(12, 5, f)
    cv.rect(5, 10, 6, 10, fd); cv.rect(9, 10, 10, 10, fd)
    cv.outline()
    return cv

def sign():
    cv = Canvas(16, 24)
    w = hx("#c49a62")
    cv.rect(2, 4, 13, 11, w)
    cv.rect(3, 5, 12, 10, shade(w, 1.18))
    cv.rect(3, 10, 12, 10, shade(w, 0.85))
    cv.hline(4, 11, 7, shade(w, 0.6)); cv.hline(4, 9, 9, shade(w, 0.6))
    cv.rect(7, 12, 8, 21, shade(w, 0.8))
    cv.outline()
    return cv

# ---- 小動物（FF14 野生動物致敬：自製點陣，非 SE 素材）----
def bird():  # 圓喙鳥（大朵金色巨嘴，為黃色大鳥風致敬）
    cv = Canvas(16, 16)
    y1 = hx("#e8b23a"); yd = shade(y1, 0.82)
    bk = hx("#f08828")
    cv.ellipse(8, 10, 4.6, 3.6, y1)          # 身體
    cv.ellipse(7, 9, 2.6, 2.2, shade(y1, 1.15))
    cv.ellipse(7, 4.6, 2.8, 2.4, y1)         # 頭
    cv.rect(9, 4, 12, 5, bk); cv.rect(10, 6, 11, 6, bk)  # 巨嘴
    cv.set(6, 4, (40, 32, 30, 255)); cv.set(5, 3, y1)    # 眼+冠羽
    cv.rect(5, 14, 5, 15, bk); cv.rect(10, 14, 10, 15, bk)  # 腳
    cv.rect(3, 10, 4, 13, yd)                # 尾羽
    cv.outline()
    return cv

def sheep():  # 波波羊（雪球肚+黑臉）
    cv = Canvas(16, 14)
    w1 = hx("#f4f0e6"); wd = shade(w1, 0.85); bl = hx("#3a3632")
    cv.ellipse(8, 8, 5.4, 4.0, w1)
    cv.ellipse(4, 6, 2.0, 1.6, w1); cv.ellipse(12, 6, 2.0, 1.6, w1)   # 蓬肚
    cv.ellipse(8, 9, 3.0, 2.2, wd)
    cv.rect(6, 3, 9, 7, bl)                  # 臉
    cv.set(6, 2, bl); cv.set(9, 2, bl)       # 耳
    cv.set(7, 5, hx("#fdfdfd")); cv.set(9, 5, hx("#fdfdfd"))  # 眼
    cv.rect(5, 11, 5, 13, bl); cv.rect(10, 11, 10, 13, bl)    # 腿
    cv.outline()
    return cv

def frog():  # 大肚蛙（眼神無辜）
    cv = Canvas(16, 12)
    g1 = hx("#5aa838"); gd = shade(g1, 0.8); bl2 = hx("#e8f2d8")
    cv.ellipse(8, 8, 6.0, 3.8, g1)
    cv.ellipse(8, 9, 4.0, 2.2, bl2)          # 肚
    cv.ellipse(5.5, 3.5, 2.0, 2.0, g1); cv.ellipse(10.5, 3.5, 2.0, 2.0, g1)  # 眼球
    cv.set(5, 3, (30, 26, 24, 255)); cv.set(10, 3, (30, 26, 24, 255))
    cv.hline(6, 9, 9, shade(g1, 0.65))       # 嘴
    cv.rect(4, 10, 4, 11, gd); cv.rect(11, 10, 11, 11, gd)   # 後腳
    cv.outline()
    return cv

def fishman():  # 深海魚人（釣魚時極低機率釣上來的敵對怪物：藍綠鱗片、背鰭、死魚眼、手拿魚叉；自製 placeholder）
    cv = Canvas(18, 22)
    s1 = hx("#3f8f8a"); sd = shade(s1, 0.72); sl = shade(s1, 1.22); belly = hx("#b8d8b0")
    fin = hx("#c84a4a"); find = shade(fin, 0.75); eye = hx("#f4f0d8"); dark = (26, 22, 22, 255)
    wood = hx("#8a6236"); steel = hx("#cfd6dc")
    # 魚叉（握在右手，立在身側）
    cv.rect(15, 2, 15, 21, wood)
    cv.set(14, 2, steel); cv.set(15, 1, steel); cv.set(16, 2, steel); cv.set(15, 0, steel)
    # 背鰭（頭頂到背後的紅色鋸齒）
    for x, y0 in [(5, 3), (6, 1), (7, 2), (8, 0), (9, 2), (10, 1), (11, 3)]:
        cv.rect(x, y0, x, 4, fin if x % 2 else find)
    # 頭（扁圓魚頭）＋大嘴
    cv.ellipse(8.5, 6.5, 4.6, 3.4, s1)
    cv.ellipse(7.5, 5.5, 2.4, 1.4, sl)
    cv.rect(5, 8, 12, 8, dark); cv.set(6, 9, eye); cv.set(9, 9, eye); cv.set(11, 9, eye)   # 嘴與尖牙
    cv.set(5, 5, eye); cv.set(11, 5, eye); cv.set(5, 6, dark); cv.set(11, 6, dark)          # 死魚眼（左右兩側）
    # 身體（駝背、肚子淺色）
    cv.ellipse(8.5, 13.5, 4.4, 4.2, s1)
    cv.ellipse(8.5, 14.5, 2.6, 3.0, belly)
    cv.rect(4, 12, 5, 13, sd); cv.rect(12, 12, 13, 13, sd)   # 鱗片陰影
    # 手臂（右手握叉）
    cv.rect(3, 12, 3, 16, s1); cv.set(3, 17, sd)
    cv.rect(13, 12, 14, 13, s1); cv.set(14, 14, sd)
    # 腿與蹼腳
    cv.rect(6, 18, 7, 20, sd); cv.rect(10, 18, 11, 20, sd)
    cv.rect(5, 21, 7, 21, fin); cv.rect(10, 21, 12, 21, fin)
    cv.outline()
    return cv

def golden_dragon():  # 島主黃金肥龍（正面、雙翼上展、金黃配色；自製 placeholder，非 SE 素材）
    cv = Canvas(24, 20)
    y1 = hx("#e8c23a"); yl = shade(y1, 0.92); yd = shade(y1, 0.72); ys = shade(y1, 0.5); yhi = shade(y1, 1.25)
    dark = (30, 24, 22, 255)

    def poly_fill(pts, c):   # 多邊形掃描填色（畫翼膜用）
        top = min(p[1] for p in pts); bot = max(p[1] for p in pts)
        for y in range(top, bot + 1):
            xs = []
            for i in range(len(pts)):
                (xa, ya), (xb, yb) = pts[i], pts[(i + 1) % len(pts)]
                if (ya <= y < yb) or (yb <= y < ya):
                    xs.append(xa + (xb - xa) * (y - ya) / (yb - ya))
            if len(xs) >= 2:
                cv.rect(round(min(xs)), y, round(max(xs)), y, c)

    # ---- 雙翼（上展的尖三角＋扇貝形下緣），左右鏡像 ----
    wing = [(2, 1), (11, 6), (9, 13), (6, 10), (3, 13)]
    for mx in (0, 1):
        pts = [(x if mx == 0 else 23 - x, y) for x, y in wing]
        poly_fill(pts, yl)
        # 翼骨：肩→翼尖的斜線（連續短筆避免斷點）
        (x0, y0), (x1, y1p) = pts[0], pts[1]
        for i in range(10):
            xx = round(x0 + (x1 - x0) * i / 9)
            cv.rect(xx, round(y0 + (y1p - y0) * i / 9), xx + 1, round(y0 + (y1p - y0) * i / 9), ys)
        # 撐出扇貝的兩根輔骨：肩→下緣兩個凹谷（近垂直，畫短豎線）
        for j in (2, 4):
            (x0, y0), (x1, y1p) = pts[1], pts[j]
            for i in range(6):
                yv = round(y0 + (y1p - y0) * i / 5)
                cv.rect(round(x0 + (x1 - x0) * i / 5), yv, round(x0 + (x1 - x0) * i / 5), yv + 1, yd)
    # ---- 腿與爪 ----
    cv.rect(8, 13, 10, 17, y1); cv.rect(13, 13, 15, 17, y1)
    cv.rect(6, 17, 10, 18, yl); cv.rect(13, 17, 17, 18, yl)
    for cx in (6, 8, 10): cv.rect(cx, 18, cx, 19, yhi)
    for cx in (13, 15, 17): cv.rect(cx, 18, cx, 19, yhi)
    # ---- 軀幹、頸、頭（畫在最上層，覆蓋翼根）----
    cv.rect(10, 6, 13, 13, y1)
    cv.ellipse(11.5, 10.5, 2.0, 3.0, yd)          # 肚
    cv.rect(10, 4, 13, 6, y1)
    cv.ellipse(11.5, 3.4, 2.3, 2.5, y1)
    cv.rect(10, 5, 13, 5, yd)                     # 下顎
    cv.set(10, 2, dark); cv.set(13, 2, dark)      # 眼
    cv.rect(9, 0, 9, 2, yd); cv.rect(14, 0, 14, 2, yd)  # 頭冠角
    cv.rect(10, 0, 13, 0, yd)                     # 冠
    cv.outline()
    return cv

def snake_queen():  # 島主笨蛋蛇女（夜光島）：正面、蛇髮、紅冠、金甲、蛇尾，一手黑劍一手鬼火（FF14 T7 蛇女造型的致敬 placeholder，非 SE 素材）
    cv = Canvas(24, 36)
    tail = hx("#5c4a80"); tail_d = shade(tail, 0.78); belly = shade(tail, 1.42)
    skin = hx("#a88cc4"); skin_d = shade(skin, 0.82)
    hair = hx("#322c3e"); hair_l = shade(hair, 1.35)
    crest = hx("#c43a4e"); crest_hi = shade(crest, 1.3)
    gold = hx("#d8a838"); gold_d = shade(gold, 0.7); gold_hi = shade(gold, 1.32)
    face = hx("#efe0ea")
    blade = hx("#3a3444"); blade_e = hx("#8a80a4")
    fire_o = hx("#ff9a2e"); fire = hx("#ffd23a"); fire_hi = hx("#fff0a0")
    dark = (24, 20, 26, 255)

    # ---- 蛇尾（下半身）：粗尾從臀寬平滑漸細、先微右弓再向左勾，尾端鰭狀尖；左緣淺色鱗紋（照參考圖）----
    cv.rect(8, 15, 15, 18, tail)                    # 臀（接軀幹）
    cv.rect(8, 19, 16, 22, tail)                    # 粗身（最寬、微向右弓）
    cv.rect(7, 23, 15, 25, tail)                    # 開始收窄
    cv.rect(6, 26, 13, 28, tail)
    cv.rect(5, 29, 10, 31, tail)
    cv.rect(4, 32, 7, 33, tail)                     # 向左勾
    cv.set(3, 33, tail)                             # 鰭狀尾尖（上尖）
    cv.rect(3, 34, 5, 35, tail)                     # 尾尖貼地
    for y0, x0 in [(19, 9), (22, 9), (25, 8), (28, 7), (31, 6)]:
        cv.rect(x0, y0, x0 + 1, y0 + 1, belly)      # 左緣分段淺鱗
    cv.set(12, 20, tail_d); cv.set(14, 21, tail_d)  # 鱗片暗點（交錯）
    cv.set(11, 23, tail_d); cv.set(13, 24, tail_d)
    cv.set(10, 26, tail_d); cv.set(12, 27, tail_d)
    cv.set(9, 29, tail_d); cv.set(7, 30, tail_d)
    cv.rect(7, 15, 8, 16, gold)                     # 腰帶垂飾（臀側金飾，照參考圖）
    cv.rect(15, 15, 16, 16, gold)

    # ---- 軀幹：紫膚＋金色胸甲與腰帶 ----
    cv.rect(9, 8, 14, 14, skin)
    cv.rect(9, 8, 14, 10, gold)                    # 金色胸甲
    cv.rect(9, 10, 14, 10, gold_d)                 # 胸甲下緣
    cv.rect(8, 13, 15, 14, gold)                   # 腰帶
    cv.set(11, 13, gold_hi); cv.set(12, 13, gold_hi)

    # ---- 左手（畫面左）舉黑劍，右手（畫面右）托鬼火 ----
    cv.rect(7, 9, 8, 11, skin)                     # 左上臂
    cv.rect(5, 7, 6, 8, skin)                      # 左前臂（舉起）
    cv.rect(4, 1, 5, 6, blade)                     # 黑劍劍身（劍尖朝上）
    cv.rect(4, 1, 4, 6, blade_e)                   # 刃光
    cv.set(4, 0, blade_e)                          # 劍尖
    cv.rect(3, 7, 6, 7, gold_d)                    # 護手
    cv.rect(15, 9, 16, 12, skin)                   # 右臂垂下
    cv.ellipse(19.5, 10.5, 1.9, 2.8, fire_o)       # 鬼火外焰
    cv.ellipse(19.5, 11, 1.1, 1.8, fire)           # 內焰
    cv.set(19, 13, fire_hi)                        # 火心

    # ---- 頭：蒼白臉＋蛇髮＋紅冠 ----
    cv.ellipse(11.5, 2.2, 4.2, 2.2, hair)          # 髮頂（先畫，臉疊上去）
    cv.ellipse(11.5, 4.5, 3.1, 3.0, face)          # 臉
    cv.rect(7, 3, 8, 8, hair)                      # 兩側垂髮
    cv.rect(15, 3, 16, 8, hair)
    cv.set(10, 4, dark); cv.set(13, 4, dark)       # 眼
    cv.hline(11, 12, 6, skin_d)                    # 嘴
    cv.rect(6, 4, 6, 6, hair); cv.set(5, 5, hair_l)     # 左小蛇頭探出
    cv.rect(17, 4, 17, 6, hair); cv.set(18, 5, hair_l)  # 右小蛇頭探出
    cv.rect(11, 0, 12, 1, crest)                   # 紅色頭冠
    cv.set(10, 1, crest); cv.set(13, 1, crest)
    cv.set(11, 0, crest_hi)
    cv.outline()
    return cv

def tombstone():  # 死亡墓碑（被島主打倒後原地出現，30 秒後復活；自製 placeholder）
    cv = Canvas(14, 16)
    st = hx("#b9b4a8"); std = shade(st, 0.78); std2 = shade(st, 0.62)
    cv.rect(3, 3, 10, 14, st)                 # 碑身
    cv.rect(4, 1, 9, 2, st)                   # 圓弧頂
    cv.rect(2, 14, 11, 15, std2)              # 底座
    cv.rect(3, 13, 10, 13, std2)
    cv.rect(6, 4, 7, 9, std); cv.hline(5, 8, 5, std); cv.hline(5, 8, 6, std)   # 十字刻痕
    cv.set(5, 11, std2)                       # 小裂痕
    cv.outline((30, 26, 28, 255))
    return cv

def weapon_sword():  # 木劍（M0 武器 1 號；輸出職的專屬武器）
    cv = Canvas(6, 18)
    sv = hx("#c9b98a"); hi = hx("#e8d8a8")
    cv.rect(2, 2, 3, 11, sv)          # 劍刃（第 0 列留給輪廓，第 1 列是劍尖）
    cv.rect(2, 2, 2, 11, hi)          # 刃光
    cv.set(2, 1, hi)                  # 劍尖：單點收尖，不是平頭
    cv.rect(0, 12, 5, 12, hx("#8a6238"))   # 護手
    cv.rect(2, 13, 3, 17, hx("#5a4028"))   # 握柄
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_staff():  # 法杖（補職的專屬武器）：頂端一顆回復色（綠）寶珠的細杖
    cv = Canvas(6, 18)
    wood = hx("#9a6f46"); orb = hx("#7ee2a8"); orb_hi = hx("#d8ffe4")
    cv.rect(2, 4, 3, 17, wood)            # 杖身
    cv.rect(2, 15, 2, 17, hx("#6f4a2c"))  # 杖尾陰影
    cv.ellipse(2.5, 2.5, 2, 2, orb)       # 寶珠（治療綠）
    cv.set(1, 2, orb_hi); cv.set(2, 1, orb_hi)   # 光點
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_waraxe():  # 戰斧（戰士的職業武器）：比採集用的斧頭大、紅色斧柄纏帶、雙面斧刃
    cv = Canvas(12, 20)
    wood = hx("#6a4228"); wrap = hx("#b5452f")
    st = hx("#a4aeb8"); st_hi = hx("#e4eaf0"); st_d = hx("#6c7680")
    cv.rect(5, 2, 6, 19, wood)
    for y in (12, 14, 16):
        cv.hline(5, 6, y, wrap)               # 握柄纏帶
    cv.rect(1, 2, 10, 7, st)                  # 雙面斧刃
    cv.rect(2, 1, 9, 1, st); cv.rect(2, 8, 9, 8, st)
    cv.vline(1, 3, 6, st_hi); cv.vline(10, 3, 6, st_hi)
    cv.rect(5, 2, 6, 8, st_d)                 # 斧心
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_daggers():  # 雙劍（忍者的職業武器）：兩把並排的短刀（右邊那把高一格）
    cv = Canvas(12, 17)
    bl = hx("#c9d2d9"); hi = hx("#f0f4f8"); grip = hx("#3a2e52"); guard = hx("#c83a3a")
    for ox, oy in ((1, 1), (7, 0)):
        cv.rect(ox + 1, oy + 2, ox + 2, oy + 9, bl)      # 刀身
        cv.vline(ox + 1, oy + 2, oy + 9, hi)            # 刃光
        cv.set(ox + 1, oy + 1, hi)                      # 刀尖
        cv.hline(ox, ox + 3, oy + 10, guard)            # 護手
        cv.rect(ox + 1, oy + 11, ox + 2, oy + 14, grip) # 握柄
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_scepter():  # 咒杖（黑魔法師的職業武器）：深色杖身，頂端金框包著紫色水晶
    cv = Canvas(8, 20)
    wood = hx("#3a2a4a"); gold = hx("#e0c040"); gem = hx("#9a5ad8"); gem_hi = hx("#e0c8ff")
    cv.rect(3, 6, 4, 19, wood)
    cv.hline(2, 5, 6, gold); cv.hline(2, 5, 17, gold)
    cv.ellipse(3.5, 3, 2.6, 3, gem)
    cv.set(2, 2, gem_hi); cv.set(3, 1, gem_hi)
    cv.vline(1, 2, 5, gold); cv.vline(6, 2, 5, gold)
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_tome():  # 賢具（賢者的職業武器，FF14 的 nouliths／浮游炮）：一座白色鏢形機身、深色座艙、
                    # 機尾兩道藍色能量翼（攻擊時的浮游炮特效見 main.js 的 drawNoulith，同一套造型）
    cv = Canvas(16, 16)
    body = hx("#eef1f6"); shade = hx("#c6cdd9"); dark = hx("#343b49")
    fin = hx("#d8dde8"); blue = hx("#7d9dff"); blue2 = hx("#aec2ff")
    for x, y in ((6, 12), (6, 13), (5, 14), (5, 15), (9, 12), (9, 13), (10, 14), (10, 15)):
        cv.set(x, y, blue)                  # 機尾兩道藍色能量翼
    cv.set(5, 15, blue2); cv.set(10, 15, blue2)
    cv.set(4, 9, fin); cv.set(3, 10, fin)   # 後掠小翼
    cv.set(11, 9, fin); cv.set(12, 10, fin)
    rows = ((1, 8, 8), (2, 7, 8), (3, 7, 8), (4, 6, 9), (5, 6, 9), (6, 5, 10),
            (7, 5, 10), (8, 5, 10), (9, 6, 9), (10, 6, 9), (11, 7, 8), (12, 7, 8))
    for y, x0, x1 in rows:
        cv.rect(x0, y, x1, y, body)         # 機身（鏢形，針尖朝上）
        cv.set(x1, y, shade)                # 右緣一點灰階
    cv.rect(6, 7, 9, 9, dark)               # 深色座艙
    cv.outline((30, 28, 38, 255))
    return cv

def weapon_harpbow():  # 豎琴弓（吟遊詩人的職業武器）：弓身彎成豎琴的樣子，中間幾條金色弦
    cv = Canvas(10, 20)
    wood = hx("#8a5a32"); wood_hi = hx("#b88a52"); gold = hx("#e0c040")
    for y, x in ((1, 6), (2, 5), (3, 4), (4, 3), (5, 3), (6, 2), (7, 2), (8, 2), (9, 2), (10, 2), (11, 2), (12, 2), (13, 3), (14, 3), (15, 4), (16, 5), (17, 6)):
        cv.set(x, y, wood); cv.set(x + 1, y, wood_hi)
    cv.vline(7, 1, 17, gold)                  # 弓弦
    for y in (6, 9, 12):
        cv.hline(4, 6, y, gold)               # 豎琴弦
    cv.rect(2, 18, 3, 19, wood)               # 握把尾
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_lance():  # 長槍（龍騎士的職業武器）：長木桿＋銀色槍頭與紅色槍纓
    cv = Canvas(6, 28)
    wood = hx("#6a4a32"); st = hx("#c9d2d9"); hi = hx("#f0f4f8"); red = hx("#c83a3a")
    cv.rect(2, 7, 3, 27, wood)
    cv.rect(2, 1, 3, 5, st); cv.vline(2, 1, 5, hi); cv.set(2, 0, hi)   # 槍頭
    cv.rect(1, 6, 4, 6, st)                    # 槍頭底座
    cv.set(1, 7, red); cv.set(4, 7, red); cv.set(1, 8, red); cv.set(4, 8, red)   # 槍纓
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_goldsword():  # 金劍（範例武器外觀，劍類；打倒黃金肥龍解鎖）
    cv = Canvas(6, 18)
    sv = hx("#e0b840"); hi = hx("#fff0a0")
    cv.rect(2, 2, 3, 11, sv); cv.rect(2, 2, 2, 11, hi); cv.set(2, 1, hi)
    cv.rect(0, 12, 5, 12, hx("#c83a3a"))
    cv.rect(2, 13, 3, 17, hx("#6a3a1a"))
    cv.outline((30, 24, 22, 255))
    return cv

# 採集工具（與 weapon_sword 同方向：工具頭在上、握柄在下；握把在左右正中，轉軸在離底 3 格處）
def tool_pickaxe():  # 鎬子
    cv = Canvas(12, 18)
    wood = hx("#8a6238"); wood_d = hx("#5a4028")
    st = hx("#9aa4ad"); st_hi = hx("#c9d2d9")
    cv.rect(5, 3, 6, 17, wood)            # 握柄
    cv.rect(5, 15, 6, 17, wood_d)         # 握柄尾端
    cv.rect(4, 1, 7, 1, st_hi)            # 鎬頭（兩端下垂的弧形）
    cv.rect(2, 2, 9, 2, st)
    cv.rect(1, 3, 3, 3, st); cv.rect(8, 3, 10, 3, st)
    cv.rect(5, 3, 6, 3, st)               # 與握柄相接處
    cv.set(1, 3, st_hi); cv.set(10, 3, st_hi)   # 兩端尖角反光
    cv.outline((30, 24, 22, 255))
    return cv

def weapon_rod():  # 釣竿（與木劍同方向：竿尖在上、握把在下；轉軸在離底 3 格處）
    cv = Canvas(6, 26)
    pole, pole_hi = hx("#8a6238"), hx("#b48a58")
    cv.vline(3, 1, 18, pole)              # 竿身（上細下粗）
    cv.vline(2, 9, 18, pole)
    cv.vline(3, 1, 8, pole_hi)            # 竿尖一段較淺
    cv.set(3, 1, hx("#e8e0d0"))           # 竿尖
    for y in (5, 11, 16):                 # 導線環
        cv.set(4, y, hx("#c9d2d9"))
    cv.rect(1, 18, 4, 20, hx("#9aa4ad"))  # 捲線器
    cv.set(4, 19, hx("#dfe6ec"))
    cv.rect(2, 21, 3, 25, hx("#3a3a44"))  # 握把
    cv.outline((30, 24, 22, 255))
    return cv

def tool_axe():  # 斧頭（斧刃在右側＝揮向前方時朝外）
    cv = Canvas(12, 18)
    wood = hx("#8a6238"); wood_d = hx("#5a4028")
    st = hx("#9aa4ad"); st_hi = hx("#dfe6ec"); st_d = hx("#6c7680")
    cv.rect(5, 1, 6, 17, wood)            # 握柄
    cv.rect(5, 15, 6, 17, wood_d)
    cv.rect(5, 1, 8, 1, st)               # 斧頭
    cv.rect(4, 2, 9, 2, st)
    cv.rect(4, 3, 10, 5, st)
    cv.rect(4, 6, 9, 6, st)
    cv.rect(5, 7, 7, 7, st)
    cv.rect(4, 2, 4, 6, st_d)             # 背面（斧背）較暗
    cv.rect(10, 3, 10, 5, st_hi)          # 刃口反光
    cv.outline((30, 24, 22, 255))
    return cv

def bed():   # 單人床（一格寬）：一個枕頭，睡覺時頭靠在枕頭上；quiltRow=13（被子從第 13 列開始）
    cv = Canvas(16, 24)
    cf = hx("#4a6ab0"); cfd = shade(cf, 0.8)
    cv.rect(1, 8, 14, 20, hx("#a57c4e"))       # 床架
    cv.rect(2, 9, 13, 12, hx("#f2ede0"))       # 枕頭帶
    cv.ellipse(8, 10, 4.5, 2.0, hx("#ffffff"))  # 枕頭
    cv.rect(2, 13, 13, 19, cf)                 # 棉被
    cv.rect(2, 13, 13, 13, shade(cf, 1.15))
    cv.rect(1, 20, 14, 21, cfd)
    cv.rect(2, 22, 3, 23, hx("#4a3630")); cv.rect(12, 22, 13, 23, hx("#4a3630"))
    cv.outline()
    return cv

def shelf():
    cv = Canvas(16, 24)
    w = hx("#8a6238")
    cv.rect(2, 3, 13, 21, w)
    cv.rect(3, 4, 12, 20, shade(w, 1.1))
    for y in (7, 12, 17):
        cv.rect(3, y, 12, y, shade(w, 0.7))
        for i, x in enumerate((4, 7, 10)):
            cv.rect(x, y - 2, x + 1, y - 1, [hx("#c9544f"), hx("#4078b0"), hx("#4a9e5a")][i])
    cv.outline()
    return cv

# ---------------- 地形定義 ----------------
TERRAINS = [
    dict(id="grass",   name="草島",
         ground=("#6aaa5a", "#5b9a4e"), edge=("#e0c184", "#cfae72"),
         water=("#3f7ec4", "#336aae"), leaf=("#3f8f4f", "#2f7a3f"), trunk="#6b4a32",
         deco=[("tree.png", 3), ("flower.png", 2), ("rock.png", 1)], ui="#6aaa5a"),
    dict(id="beach",   name="沙灘島",
         ground=("#e6cf96", "#d8bd82"), edge=("#cbb27a", "#b89e68"),
         water=("#47a6d9", "#3a8ec2"), leaf=("#4fa06a", "#3f8455"), trunk="#7a5e42",
         deco=[("palm.png", 3), ("shell.png", 2), ("rock.png", 1)], ui="#e6cf96"),
    dict(id="snow",    name="雪島",
         ground=("#ecf2f8", "#d6e2ee"), edge=("#b9d4e6", "#a2c2d8"),
         water=("#3873b8", "#2d5fa0"), leaf=("#2f7a52", "#256040"), trunk="#5a4632",
         deco=[("pine.png", 3), ("rock.png", 2), ("stump.png", 1)], ui="#ecf2f8"),
    dict(id="night",   name="夜光島",
         ground=("#37406e", "#2d3560"), edge=("#57496e", "#4a3d5e"),
         water=("#20264a", "#181d3c"), leaf=("#3aa88c", "#2d8670"), trunk="#4a3a2a",
         deco=[("glowshroom.png", 3), ("lantern.png", 2), ("rock.png", 1)], ui="#6b74b8"),
    dict(id="forest",  name="森林島",
         ground=("#5b8f46", "#4d7c3a"), edge=("#8a6b46", "#75583a"),
         water=("#35658f", "#2c5578"), leaf=("#2f6b35", "#24552a"), trunk="#54402c",
         deco=[("tree.png", 4), ("mushroom.png", 2), ("stump.png", 1)], ui="#5b8f46"),
    dict(id="volcano", name="熔岩島",
         ground=("#5a4a48", "#4c3e3c"), edge=("#8a5040", "#744234"),
         water=("#c23a1e", "#a83018"), leaf=("#6a6a46", "#54543a"), trunk="#3c2a22",
         deco=[("rock.png", 3), ("volcanic.png", 3), ("stump.png", 1)], ui="#6c5a58"),
    dict(id="machine", name="機械島",
         ground=("#8a8f98", "#7a7f88"), edge=("#5a5f68", "#4c5058"),
         water=("#2a7ea8", "#226a90"), leaf=("#5a6a7a", "#4a5a6a"), trunk="#4a5058",
         deco=[("gear.png", 3), ("rock.png", 1)], ui="#8a94a4"),
    # 和平島（2026-11-08）：沒有採集物件、野生動物、NPC、島主、魚；之後當小遊戲區域，中央附近有遊戲桌（TABLES_BY_TERRAIN）
    dict(id="peace", name="和平島",
         ground=("#d9c9a6", "#c8b690"), edge=("#ecdfb4", "#dfd09e"),
         water=("#5ab8d8", "#4aa8c8"), leaf=("#6ab85a", "#58a04a"), trunk="#8a6a46",
         deco=[], ui="#d9c9a6",
         layout="room", campfire=False),   # room＝像室內：整張地圖都是地板（沒有水）；campfire=False＝沒有營火
]

# 和平島的遊戲桌：地形 → [桌]。id＝桌 id（兩份伺服器的 TABLE_DEFS 要一致）、game＝client/assets/games/games.json 的遊戲 id、
# cell＝左上角格、w／h＝占幾格（圖 48×32 以 scale 2 畫＝3×2 格）。桌子是島上固定物件，不是可擺設的家具
TABLES_BY_TERRAIN = {
    "peace": [dict(id="t1", game="oldmaid", cell=[50, 24], w=3, h=2),
              dict(id="t2", game="gomoku", cell=[34, 24], w=3, h=2),
              dict(id="t3", game="oldmaid", cell=[50, 31], w=3, h=2),   # 各遊戲都有兩桌（2026-11-08，使用者要求）：t3 是 t1 的複本、t4 是 t2 的複本
              dict(id="t4", game="gomoku", cell=[34, 31], w=3, h=2),
              dict(id="t5", game="dodge", cell=[42, 38], w=3, h=2),
              dict(id="t6", game="uno", cell=[34, 38], w=3, h=2)],   # UNO（2026-11-08，使用者要求）   # 躲彈幕只有一桌（2026-11-08，使用者要求）
}

# ---------------- 和平島的遊戲桌（48×32，畫 scale 2＝3×2 格）----------------
def table_oldmaid():
    cv = Canvas(48, 32)
    wood, felt = hx("#8a5a34"), hx("#2f8a5a")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.2))
    cv.rect(3, 7, 44, 24, felt)
    for x in range(4, 44, 3):
        cv.set(x, 8 + (x * 7) % 15, shade(felt, 1.12))
    cv.rect(3, 7, 44, 7, shade(felt, .8))
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    # 桌上的牌：一疊牌背、幾張散牌（紅心、黑桃）與一張鬼牌
    for dx in range(3):
        cv.rect(21 + dx, 13 - dx, 28 + dx, 20 - dx, hx("#c9544f")); cv.rect(22 + dx, 14 - dx, 27 + dx, 19 - dx, hx("#a83a38"))
    cv.rect(9, 12, 14, 19, hx("#f4f0e4")); cv.rect(10, 13, 13, 15, hx("#d83a3a")); cv.rect(11, 17, 12, 18, hx("#d83a3a"))
    cv.rect(34, 11, 39, 18, hx("#f4f0e4")); cv.rect(35, 12, 38, 14, hx("#2a2a30")); cv.rect(36, 16, 37, 17, hx("#2a2a30"))
    cv.set(17, 20, hx("#f4f0e4")); cv.rect(15, 18, 19, 22, hx("#f4f0e4")); cv.rect(16, 19, 18, 21, hx("#e8c050"))
    cv.outline()
    return cv

def table_uno():
    cv = Canvas(48, 32)
    wood, felt = hx("#6a4a2a"), hx("#7a2a2a")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.25))
    cv.rect(3, 7, 44, 24, felt); cv.rect(3, 7, 44, 7, shade(felt, .8))
    # 桌上一疊牌背與四張散開的色牌（紅黃綠藍）
    cv.rect(20, 12, 27, 20, hx("#1e1e24")); cv.rect(21, 13, 26, 19, hx("#f4f0e4")); cv.ellipse(23.5, 16, 2, 3, hx("#d83a3a"))
    for x, y, c in ((7, 11, "#d83a3a"), (13, 15, "#e8b820"), (32, 11, "#2ea84a"), (37, 16, "#2f66d8")):
        cv.rect(x, y, x + 5, y + 7, hx(c)); cv.rect(x, y, x + 5, y, shade(hx(c), 1.3)); cv.set(x + 2, y + 3, hx("#ffffff")); cv.set(x + 3, y + 3, hx("#ffffff"))
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_dodge():
    cv = Canvas(48, 32)
    wood, screen = hx("#3a3f52"), hx("#141826")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.3))
    cv.rect(3, 7, 44, 24, screen)
    for x, y, c in ((8, 10, "#ff5a5a"), (14, 18, "#ffb347"), (20, 9, "#ff5a5a"), (27, 15, "#7ae8d0"), (33, 21, "#ff5a5a"), (38, 11, "#ffb347"), (12, 22, "#7ae8d0"), (30, 8, "#ffb347")):
        cv.ellipse(x, y, 1.6, 1.6, hx(c))
    cv.rect(23, 17, 25, 19, hx("#f4f0e4")); cv.set(24, 16, hx("#f4f0e4"))   # 中間一個小小的「玩家」
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_gomoku():
    cv = Canvas(48, 32)
    wood, board = hx("#8a5a34"), hx("#d8a860")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.2))
    cv.rect(2, 6, 45, 25, board)
    line = shade(board, .55)
    for x in range(5, 44, 4): cv.vline(x, 8, 23, line)
    for y in range(9, 24, 3): cv.hline(5, 41, y, line)
    for x, y in ((13, 12), (17, 15), (21, 12), (25, 15), (29, 18)): cv.ellipse(x, y, 1.7, 1.7, hx("#1e1e24"))
    for x, y in ((17, 12), (21, 15), (25, 12), (33, 18)): cv.ellipse(x, y, 1.7, 1.7, hx("#f4f0e4"))
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

# ---------------- 合成：素材圖示（16×16）與可合成家具 ----------------
# 素材清單與配方在 client/assets/craft/craft.json（手寫資料，不由這裡產生）；這裡只畫圖。素材 id 與檔名對應：craft/<id>.png
def _mat_log(c):
    cv = Canvas(16, 16); cv.rect(2, 5, 13, 11, c); cv.ellipse(13, 8, 2, 3, shade(c, 1.25)); cv.set(13, 8, shade(c, .8)); cv.hline(3, 11, 7, shade(c, .85)); cv.outline(); return cv
def _mat_stone(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 6, 4.5, c); cv.ellipse(6, 7, 2.5, 1.6, shade(c, 1.25)); cv.outline(); return cv
def _mat_leaf(c):
    cv = Canvas(16, 16)
    for i in range(10): cv.ellipse(3 + i, 12 - i * .8, 2.2, 1.4, c)
    for i in range(9): cv.set(3 + i, 12 - int(i * .8), shade(c, .7))
    cv.outline(); return cv
def _mat_shell(c):
    cv = Canvas(16, 16); cv.ellipse(8, 8, 6, 5, c); cv.rect(5, 12, 10, 13, c)
    for x in (4, 6, 8, 10, 12): cv.vline(x, 5, 11, shade(c, .8))
    cv.outline(); return cv
def _mat_drop(c):
    cv = Canvas(16, 16); cv.ellipse(8, 10, 4, 4, c); cv.rect(7, 3, 8, 6, c); cv.rect(6, 6, 9, 7, c); cv.set(6, 9, shade(c, 1.4)); cv.outline(); return cv
def _mat_cap(c):
    cv = Canvas(16, 16); cv.ellipse(8, 7, 6, 4.5, c); cv.rect(0, 8, 15, 8, T8); cv.rect(6, 9, 9, 13, hx("#e8dcc4"))
    for x, y in ((5, 5), (9, 4), (11, 7)): cv.set(x, y, hx("#fff4e0"))
    cv.outline(); return cv
def _mat_shard(c):
    cv = Canvas(16, 16)
    for i in range(6): cv.rect(8 - i, 2 + i * 2, 8 + i // 2, 3 + i * 2, c)
    cv.vline(8, 3, 11, shade(c, 1.35)); cv.outline(); return cv
def _mat_spark(c):
    cv = Canvas(16, 16)
    for i in range(1, 7):
        cv.set(8, 8 - i, c); cv.set(8, 8 + i, c); cv.set(8 - i, 8, c); cv.set(8 + i, 8, c)
    cv.ellipse(8, 8, 2.5, 2.5, shade(c, 1.3)); cv.outline(); return cv
def _mat_gear(c):
    cv = Canvas(16, 16); cv.ellipse(8, 8, 5, 5, c)
    for a in range(8):
        x = 8 + round(math.cos(a * math.pi / 4) * 6); y = 8 + round(math.sin(a * math.pi / 4) * 6); cv.rect(x - 1, y - 1, x + 1, y + 1, c)
    cv.ellipse(8, 8, 2, 2, T8); cv.outline(); return cv
def _mat_scale(c):
    cv = Canvas(16, 16); cv.ellipse(8, 8, 5, 6, c); cv.ellipse(6, 6, 1.5, 2, shade(c, 1.35))
    for y in (6, 9, 12): cv.hline(5, 11, y, shade(c, .8))
    cv.outline(); return cv
def _mat_fluff(c):
    cv = Canvas(16, 16)
    for cx, cy in ((5, 8), (8, 6), (11, 8), (7, 10), (10, 11), (5, 11)): cv.ellipse(cx, cy, 3, 3, c)
    cv.set(6, 6, shade(c, 1.1)); cv.outline(); return cv
def _mat_feather(c):
    cv = Canvas(16, 16)
    for i in range(10): cv.ellipse(4 + i, 11 - i * .8, 2.4, 1.6, c)
    for i in range(12): cv.set(2 + i, 13 - int(i * .85), shade(c, .6))
    cv.outline(); return cv
def _mat_plank(c):
    cv = Canvas(16, 16); cv.rect(1, 3, 14, 12, c)
    for y in (6, 9): cv.hline(1, 14, y, shade(c, .8))
    cv.set(3, 4, shade(c, .6)); cv.set(12, 10, shade(c, .6)); cv.outline(); return cv
def _mat_rope(c):
    cv = Canvas(16, 16)
    for i in range(4): cv.ellipse(8, 8, 6 - i, 5 - i, c if i % 2 == 0 else shade(c, .75))
    cv.ellipse(8, 8, 1, 1, T8); cv.outline(); return cv
def _mat_cloth(c):
    cv = Canvas(16, 16); cv.rect(2, 3, 13, 12, c)
    for x in range(2, 14, 3): cv.vline(x, 3, 12, shade(c, .88))
    for y in range(3, 13, 3): cv.hline(2, 13, y, shade(c, 1.1))
    cv.outline(); return cv
def _mat_glue(c):
    cv = Canvas(16, 16); cv.rect(4, 6, 11, 13, c); cv.rect(5, 3, 10, 5, shade(c, .7)); cv.rect(6, 7, 7, 11, shade(c, 1.3)); cv.outline(); return cv
def _mat_pane(c):
    cv = Canvas(16, 16); cv.rect(2, 2, 13, 13, c)
    for i in range(5): cv.set(4 + i, 10 - i, hx("#ffffff"))
    cv.outline(hx("#3a5a70")); return cv
def _mat_bar(c):
    cv = Canvas(16, 16); cv.rect(2, 6, 12, 12, c); cv.rect(2, 6, 12, 7, shade(c, 1.3)); cv.rect(11, 6, 13, 11, shade(c, .8)); cv.outline(); return cv

# 素材 id → (畫法, 顏色)；顏色也寫在 craft.json 的 color（掉落物小圓點用），兩邊要一致
MATERIAL_ICONS = dict(
    wood=(_mat_log, "#a9743f"), stone=(_mat_stone, "#8d939b"), palm_leaf=(_mat_leaf, "#5fae4e"), shell=(_mat_shell, "#f0c4b0"),
    pine_resin=(_mat_drop, "#e0a63a"), mushroom_cap=(_mat_cap, "#c8503c"), glow_spore=(_mat_spark, "#7ae8d0"), glass_shard=(_mat_shard, "#9fd8f0"),
    obsidian=(_mat_stone, "#3a2f4a"), gear=(_mat_gear, "#a8b0b8"), fish_scale=(_mat_scale, "#7fc6e8"), wool=(_mat_fluff, "#f0ede4"),
    feather=(_mat_feather, "#e8c070"),
    plank=(_mat_plank, "#c89a5a"), rope=(_mat_rope, "#c9b27a"), cloth=(_mat_cloth, "#d878a0"), glue=(_mat_glue, "#e8d890"),
    glass_pane=(_mat_pane, "#a8dcf0"), steel=(_mat_bar, "#8aa0b8"),
)

def stool():
    w = hx("#c89a5a"); cv = Canvas(16, 14)
    cv.rect(3, 4, 12, 6, shade(w, 1.1)); cv.rect(4, 7, 4, 12, shade(w, .8)); cv.rect(11, 7, 11, 12, shade(w, .8)); cv.hline(4, 11, 10, shade(w, .7))
    cv.outline(); return cv

def glow_lamp():
    cv = Canvas(16, 24); g = hx("#7ae8d0")
    cv.rect(7, 10, 8, 20, hx("#6e6a78")); cv.rect(4, 20, 11, 22, hx("#55525e"))
    cv.ellipse(8, 7, 5, 5.5, hx("#bff8ec")); cv.ellipse(8, 7, 3, 3.5, g); cv.set(6, 5, hx("#ffffff"))
    cv.outline(); return cv

def fish_tank():
    cv = Canvas(16, 16)
    cv.rect(1, 3, 14, 13, hx("#4a7ea0")); cv.rect(2, 4, 13, 12, hx("#8ed0ea"))
    cv.rect(1, 12, 14, 13, hx("#6b5a4a")); cv.rect(3, 10, 6, 11, hx("#e8c070")); cv.rect(8, 8, 11, 9, hx("#f08a50")); cv.set(12, 7, hx("#f08a50")); cv.set(7, 6, hx("#ffffff"))
    cv.rect(4, 11, 4, 11, hx("#5a9a50")); cv.outline(); return cv

def steel_shelf():
    cv = Canvas(16, 24); m = hx("#8aa0b8")
    cv.rect(2, 2, 13, 22, shade(m, .75)); cv.rect(3, 3, 12, 21, shade(m, 1.1))
    for y in (8, 14, 20): cv.rect(2, y, 13, y + 1, m)
    for x, y, c in ((4, 5, "#d4604a"), (7, 5, "#4a8ad4"), (10, 4, "#e8c070"), (5, 11, "#6ac07a"), (9, 11, "#d878a0"), (6, 17, "#e8dcc4")):
        cv.rect(x, y, x + 1, 7 if y < 8 else y + 2, hx(c))
    cv.outline(); return cv

def _mat_petal(c):
    cv = Canvas(16, 16)
    for a in range(5):
        x = 8 + round(math.cos(a * 2 * math.pi / 5 - math.pi / 2) * 3.6); y = 8 + round(math.sin(a * 2 * math.pi / 5 - math.pi / 2) * 3.6); cv.ellipse(x, y, 2.6, 2.6, c)
    cv.ellipse(8, 8, 2, 2, hx("#f2d14a")); cv.outline(); return cv
def _mat_pearl(c):
    cv = Canvas(16, 16); cv.ellipse(8, 8, 5, 5, c); cv.ellipse(6, 6, 1.6, 1.6, hx("#ffffff")); cv.set(10, 10, shade(c, .8)); cv.outline(hx("#6a6a88")); return cv
def _mat_cube(c):
    cv = Canvas(16, 16); cv.rect(3, 4, 12, 13, c); cv.rect(3, 4, 12, 5, shade(c, 1.25)); cv.rect(11, 4, 12, 13, shade(c, .85)); cv.set(5, 8, hx("#ffffff")); cv.set(6, 7, hx("#ffffff")); cv.outline(hx("#3a5a80")); return cv
def _mat_crystal(c):
    cv = Canvas(16, 16)
    for bx, h in ((4, 6), (8, 9), (11, 5)):
        cv.rect(bx, 13 - h, bx + 1, 13, c); cv.set(bx, 12 - h, shade(c, 1.3)); cv.set(bx + 1, 12 - h, shade(c, 1.3))
    cv.outline(); return cv
def _mat_chunk(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 5.5, 4.5, c); cv.ellipse(6, 7, 1.5, 1.2, shade(c, 1.6)); cv.set(10, 10, shade(c, 1.6)); cv.outline(); return cv
def _mat_ore(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 6, 4.5, hx("#7a7f88"))
    for x, y in ((5, 8), (8, 11), (10, 7), (7, 6), (11, 10)): cv.rect(x, y, x + 1, y + 1, c)
    cv.outline(); return cv
def _mat_sand(c):
    cv = Canvas(16, 16)
    for y in range(7, 13):
        w = 2 + (y - 7) * 1.2
        cv.rect(int(8 - w), y, int(8 + w), y, c if y % 2 else shade(c, .92))
    cv.set(6, 11, shade(c, .7)); cv.set(10, 9, shade(c, 1.2)); cv.outline(); return cv
def _mat_skin(c):
    cv = Canvas(16, 16); cv.rect(3, 4, 12, 12, c); cv.rect(2, 6, 3, 7, c); cv.rect(12, 9, 13, 10, c)
    for x, y in ((5, 6), (8, 9), (10, 6), (6, 10)): cv.set(x, y, shade(c, .7)); cv.set(x + 1, y, shade(c, 1.3))
    cv.outline(); return cv
def _mat_brick(c):
    cv = Canvas(16, 16); cv.rect(1, 3, 14, 12, c)
    for y in (6, 9): cv.hline(1, 14, y, shade(c, .7))
    for x, y0 in ((5, 3), (10, 3), (3, 7), (8, 7), (12, 7), (5, 10), (10, 10)): cv.vline(x, y0, y0 + 2, shade(c, .7))
    cv.outline(); return cv
def _mat_paper(c):
    cv = Canvas(16, 16); cv.rect(3, 2, 12, 13, c); cv.rect(10, 2, 12, 4, shade(c, .85))
    for y in (6, 8, 10): cv.hline(5, 10, y, shade(c, .6))
    cv.outline(); return cv
def _mat_bark(c):
    cv = Canvas(16, 16); cv.rect(3, 3, 12, 12, c)
    for x in (5, 8, 11): cv.vline(x, 3, 12, shade(c, .7))
    cv.set(6, 7, shade(c, 1.3)); cv.set(9, 5, shade(c, 1.3)); cv.outline(); return cv
def _mat_leather(c):
    cv = Canvas(16, 16); cv.rect(2, 4, 13, 12, c); cv.rect(2, 4, 13, 5, shade(c, 1.2))
    for x in range(3, 13, 2): cv.set(x, 11, shade(c, .6))
    cv.outline(); return cv

MATERIAL_ICONS.update(
    petal=(_mat_petal, "#f08ab8"), bark=(_mat_bark, "#8a5e3a"), charcoal=(_mat_chunk, "#3a3a40"), sand=(_mat_sand, "#e8d49a"),
    sulfur=(_mat_crystal, "#e8e03a"), ice=(_mat_cube, "#bfe6f8"), moonstone=(_mat_chunk, "#b8c0f0"), iron_ore=(_mat_ore, "#d88a4a"),
    frog_skin=(_mat_skin, "#6ab04a"), pearl=(_mat_pearl, "#f4f0ec"),
    brick=(_mat_brick, "#c4684a"), paper=(_mat_paper, "#f0ead8"), iron_ingot=(_mat_bar, "#6a7480"), leather=(_mat_leather, "#9a6a40"),
)

def flower_pot():
    cv = Canvas(16, 24); pot = hx("#c4684a")
    cv.rect(4, 16, 11, 21, pot); cv.rect(4, 16, 11, 17, shade(pot, 1.2)); cv.rect(5, 19, 10, 21, shade(pot, .85))
    cv.rect(7, 9, 8, 15, hx("#4d9e46"))
    for cx, cy, c in ((8, 6, "#f08ab8"), (5, 9, "#f2d14a"), (11, 9, "#e8e4f0")): cv.ellipse(cx, cy, 2.6, 2.6, hx(c)); cv.set(cx, cy, hx("#f2d14a") if c != "#f2d14a" else hx("#d88a4a"))
    cv.outline(); return cv

def desk():
    w = hx("#c89a5a"); cv = Canvas(16, 16)
    cv.rect(1, 5, 14, 7, shade(w, 1.1)); cv.rect(1, 7, 14, 8, shade(w, .8)); cv.rect(2, 9, 3, 14, shade(w, .8)); cv.rect(12, 9, 13, 14, shade(w, .8)); cv.rect(4, 9, 6, 11, shade(w, .9))
    cv.rect(8, 3, 11, 4, hx("#f0ead8")); cv.outline(); return cv

def ice_sculpture():
    cv = Canvas(16, 24); c = hx("#bfe6f8")
    cv.rect(3, 19, 12, 21, shade(c, .8))
    cv.rect(6, 8, 9, 18, c); cv.rect(4, 12, 11, 15, c); cv.rect(7, 4, 8, 8, shade(c, 1.2)); cv.set(7, 3, shade(c, 1.2)); cv.set(8, 3, shade(c, 1.2))
    cv.vline(7, 6, 17, hx("#ffffff")); cv.outline(hx("#3a5a80")); return cv

def moon_lamp():
    cv = Canvas(16, 24)
    cv.rect(7, 12, 8, 20, hx("#6e6a78")); cv.rect(4, 20, 11, 22, hx("#55525e"))
    cv.ellipse(8, 7, 5, 5.5, hx("#dfe4ff")); cv.ellipse(10, 7, 3.4, 4.4, hx("#6a70b8")); cv.set(5, 5, hx("#ffffff"))   # 月牙
    cv.outline(); return cv

def iron_chair():
    w = hx("#6a7480"); cv = Canvas(16, 14)
    cv.rect(2, 3, 13, 5, w); cv.rect(2, 6, 13, 8, shade(w, 1.2)); cv.rect(2, 6, 2, 8, shade(w, .8)); cv.rect(13, 6, 13, 8, shade(w, .8))
    cv.rect(3, 9, 3, 12, shade(w, .85)); cv.rect(12, 9, 12, 12, shade(w, .85)); cv.hline(3, 12, 5, hx("#d88a4a"))
    cv.outline(); return cv

def lava_lamp():
    cv = Canvas(16, 24)
    cv.rect(4, 20, 11, 22, hx("#55525e")); cv.rect(5, 5, 10, 19, hx("#7a2a1a")); cv.rect(6, 6, 9, 18, hx("#f06a2a"))
    cv.ellipse(8, 10, 1.8, 1.8, hx("#f8d04a")); cv.ellipse(8, 15, 2, 2, hx("#f8d04a")); cv.rect(5, 3, 10, 4, hx("#55525e")); cv.set(6, 7, hx("#ffe9b0"))
    cv.outline(); return cv

def leather_chair():
    w = hx("#9a6a40"); cv = Canvas(16, 14)
    cv.rect(2, 3, 13, 5, shade(w, 1.1)); cv.rect(2, 6, 13, 8, shade(w, 1.25)); cv.rect(2, 6, 2, 8, shade(w, .8)); cv.rect(13, 6, 13, 8, shade(w, .8))
    cv.rect(3, 9, 3, 12, hx("#5a3e24")); cv.rect(12, 9, 12, 12, hx("#5a3e24")); cv.set(5, 4, shade(w, .7)); cv.set(10, 4, shade(w, .7))
    cv.outline(); return cv

def pearl_statue():
    cv = Canvas(16, 24); b = hx("#c4684a")
    cv.rect(3, 17, 12, 21, b); cv.rect(3, 17, 12, 18, shade(b, 1.2)); cv.rect(4, 20, 11, 21, shade(b, .8))
    cv.ellipse(8, 11, 5, 5, hx("#f4f0ec")); cv.ellipse(6, 9, 1.8, 1.8, hx("#ffffff")); cv.set(10, 13, hx("#c8c0e0"))
    cv.outline(hx("#6a6a88")); return cv

FURN_MANIFEST = dict(
    scale=2, tile=TILE,
    items=[
        dict(id="sofa",  name="沙發",  w=1, h=1, solid=True,  sprite="sofa.png", use="sit"),
        dict(id="table", name="桌子",  w=1, h=1, solid=True,  sprite="table.png"),
        dict(id="chair", name="椅子",  w=1, h=1, solid=True,  sprite="chair.png", use="sit"),
        dict(id="plant", name="植栽",  w=1, h=1, solid=True,  sprite="plant.png"),
        dict(id="rug",   name="地毯",  w=2, h=2, solid=False, sprite="rug.png", legacy=True),   # 已改為地板（floor_rug）；保留定義讓舊存檔擺著的還看得到、拿得走，但不列在面板
        dict(id="lamp",  name="電燈",  w=1, h=1, solid=True,  sprite="lamp.png"),
        dict(id="tv",    name="電視",  w=1, h=1, solid=True,  sprite="tv.png"),
        dict(id="bed",   name="床",    w=1, h=1, solid=True,  sprite="bed.png", use="sleep", quiltRow=13),
        dict(id="shelf", name="書架",  w=1, h=1, solid=True,  sprite="shelf.png"),
        dict(id="sign",  name="看板",  w=1, h=1, solid=True,  sprite="sign.png", text=True),
        # 以下是「合成家具」：craft=True＝要在合成面板做出來才解鎖（解鎖後無限使用），配方在 client/assets/craft/craft.json
        dict(id="stool",       name="木凳",   w=1, h=1, solid=True,  sprite="stool.png", use="sit", craft=True),
        dict(id="glow_lamp",   name="螢光燈", w=1, h=1, solid=True,  sprite="glow_lamp.png", craft=True),
        dict(id="fish_tank",   name="魚缸",   w=1, h=1, solid=True,  sprite="fish_tank.png", craft=True),
        dict(id="steel_shelf", name="鋼架",   w=1, h=1, solid=True,  sprite="steel_shelf.png", craft=True),
        dict(id="flower_pot",     name="花盆",     w=1, h=1, solid=True, sprite="flower_pot.png", craft=True),
        dict(id="desk",           name="書桌",     w=1, h=1, solid=True, sprite="desk.png", craft=True),
        dict(id="ice_sculpture",  name="冰雕",     w=1, h=1, solid=True, sprite="ice_sculpture.png", craft=True),
        dict(id="moon_lamp",      name="月光燈",   w=1, h=1, solid=True, sprite="moon_lamp.png", craft=True),
        dict(id="iron_chair",     name="鐵椅",     w=1, h=1, solid=True, sprite="iron_chair.png", use="sit", craft=True),
        dict(id="lava_lamp",      name="熔岩燈",   w=1, h=1, solid=True, sprite="lava_lamp.png", craft=True),
        dict(id="leather_chair",  name="皮椅",     w=1, h=1, solid=True, sprite="leather_chair.png", use="sit", craft=True),
        dict(id="pearl_statue",   name="珍珠擺飾", w=1, h=1, solid=True, sprite="pearl_statue.png", craft=True),
    ],
)

# FF14 致敬野生動物（三種）＋各地形島主 + 各地形出現組合
# ---------------- 外部（img2pixel 自製）素材登記簿 ----------------
# 產生器「不畫」client/assets/external/img2pixel/ 下手放的 sheet；這裡只登記它們、在重跑開頭檢查存在與尺寸。
# 加新外部素材的流程：
#   1. 逐幀 PNG（zip 或資料夾）丟 tools/import_external.py 拼成水平 sheet，放進 client/assets/external/img2pixel/
#   2. 這裡加一條 dict
#   3. 在 MOB_MANIFEST 的動物／島主條目加 anim（sheet／frames／fps／scale／keyBg）；是島主就再登記 OWNER_BY_TERRAIN
#   4. 素材來源與授權記到 docs/assets-license.md
EXTERNAL_BUNDLES = [
    # 小動物（方向網格；見 docs/notes.md「野外動物」的新增怪物規範）：rows＝列數（每個方向一列）、row0＝從第幾列開始用
    dict(sheet="external/img2pixel/chicken_sheet.png", frames=3, rows=4, fw=32, fh=32, what="咕咕雞的 4 方向 × 3 幀（草島／森林島）"),
    dict(sheet="external/img2pixel/slime_sheet.png", frames=3, rows=3, fw=48, fh=48, what="史萊姆的 3 方向（背／側／前）× 3 幀（各島不同色，靠 tint）"),
    dict(sheet="external/img2pixel/bunny_sheet.png", frames=4, rows=2, row0=0, fw=48, fh=32, what="跳跳兔的左／右各 4 幀（沙灘／雪島白／機械島灰；sheet 第 3 列 2 幀沒用到）"),
    dict(sheet="external/img2pixel/dragon_sheet.png", frames=3, rows=2, fw=191, fh=161, what="飛龍的上飛／下飛各 3 幀（sheet 共 4 列，只用第 0、2 列＝rowIndex；各島不同色靠 tint）"),
    dict(sheet="external/img2pixel/bahamut_fly_sheet.png", frames=6, fw=88, fh=59, what="黃金肥龍的飛行 6 幀（草島島主）"),
    dict(sheet="external/img2pixel/snake_queen_sheet.png", frames=4, fw=88, fh=85, what="笨蛋蛇女的 4 幀（夜光島島主）"),
    dict(sheet="external/img2pixel/ultima_weapon_sheet.png", frames=6, fw=88, fh=74, what="蓋老師（究極神兵）的走路 6 幀（熔岩島島主）"),
    dict(sheet="external/img2pixel/alexander_idle_sheet.png", frames=4, fw=88, fh=77, what="壓力山大的待機 4 幀（機械島島主）"),
    dict(sheet="external/img2pixel/campfire_sheet.png", frames=8, fw=32, fh=32, what="營火 8 幀（世界物件，不是動物：main.js 直接載入，不經 manifest）"),
]

def check_external():
    """重跑開頭的健檢：sheet 存在、寬＝frames×fw、高至少涵蓋用到的列（row0+rows）；對不上只印警告（錯的 anim 設定不擋重跑，但要在輸出裡看得見）"""
    for e in EXTERNAL_BUNDLES:
        px = read_png_pixels(os.path.join(ASSETS, e["sheet"]))
        if px is None:
            print(f"  ⚠ {e['sheet']}：不存在或無法解碼")
            continue
        w, h = px[0], px[1]
        rows, row0 = e.get("rows", 1), e.get("row0", 0)
        if w != e["frames"] * e["fw"] or h < (row0 + rows) * e["fh"]:
            print(f"  ⚠ {e['sheet']}：實際 {w}x{h}，與登記（{e['frames']} 幀 × {rows} 列 × 每格 {e['fw']}x{e['fh']}）不符")
            continue
        print(f"  {e['sheet']}: {e['frames']} 幀 x {rows} 列 x {e['fw']}x{e['fh']} — {e['what']}")

# 新怪物（使用者提供的 img2pixel 素材，方向網格）：anim 用 fw／fh 指定單格尺寸、row0／rows 用哪幾列、
# rowDir＝每一列是哪個方向（順序＝列的順序），沒畫的方向由程式用對向那一列左右鏡像；tint／tintBase＝一張基準圖調成不同色系。
# 史萊姆每個地形一種顏色（同一張紅史萊姆 sheet 調色），id＝slime_<地形>
SLIME_TINTS = {
    "grass": "#58b24a", "forest": "#2f8a4a", "beach": "#3aa0d8", "snow": "#bfe6f5",
    "night": "#8a5ad8", "volcano": "#ff6a2a", "machine": "#9aa4b0",
}
MOB_MANIFEST = dict(
    scale=2, respawn=30,
    mobs=[
        dict(id="bird",  name="圓喙鳥", sprite="bird.png",  swim=True, speed=42, flee=95, hp=3,
             line="「圓喙鳥」用圓圓的眼神看著你。"),
        dict(id="sheep", name="波波羊", sprite="sheep.png", speed=30, flee=80, hp=4,
             line="「波波羊」慢悠悠地嚼著草。"),
        dict(id="frog",  name="大肚蛙", sprite="frog.png",  swim=True, speed=26, flee=70, hp=3,
             line="「大肚蛙」的眼神飄向遠方。"),
        # 咕咕雞：草島／森林島（4 方向：後／右／前／左，各 3 幀）
        dict(id="chicken", name="咕咕雞", fixed=3, speed=30, flee=80, hp=2,
             anim=dict(sheet="external/img2pixel/chicken_sheet.png", frames=3, rows=4, fw=32, fh=32,
                       rowDir=["up", "right", "down", "left"], fps=6, scale=0.85),   # scale：畫面約 17×24（人物約 46px 高；2026-11-09 使用者嫌太大，由 1.6 縮小）
             line="「咕咕雞」歪著頭啄了啄地面。"),
        # 史萊姆：所有地形各一種顏色（和平島除外），同一張 sheet 依島調色；3 方向（背／右／前），往左用「右」那一列鏡像
        *[dict(id=f"slime_{isl}", name="史萊姆", fixed=3, speed=22, flee=70, hp=3,
               anim=dict(sheet="external/img2pixel/slime_sheet.png", frames=3, rows=3, fw=48, fh=48,
                         rowDir=["up", "right", "down"], fps=5, scale=0.65),   # 畫面約 26×21（2026-11-09 由 1.1 縮小）
               tintBase="#ff8080", tint=col,
               line="「史萊姆」果凍般晃了兩下。")
          for isl, col in SLIME_TINTS.items()],
        # 跳跳兔：沙灘島（原色棕）、雪島（白）、機械島（灰）；左／右各有專屬列不鏡像（sheet 第 3 列 2 幀未用到）
        *[dict(id=bid, name="跳跳兔", fixed=3, speed=44, flee=110, hp=2,
               anim=dict(sheet="external/img2pixel/bunny_sheet.png", frames=4, rows=2, row0=0, fw=48, fh=32,
                         rowDir=["left", "right"], fps=9, scale=0.65),   # 畫面約 31×20（2026-11-09 由 1.1 縮小）
               **({"tint": tint, "tintBase": "#ab7943"} if tint else {}),
               line="「跳跳兔」豎起耳朵，隨時準備蹦走。")
          for bid, tint in [("bunny", None), ("bunny_snow", "#f2f6ff"), ("bunny_machine", "#9aa4b0")]],
        # 飛龍：夜光島（黑）、熔岩島（原色紅）、沙灘島（沙）。用 sheet 的第 0、2 列（上飛、下飛）當方向網格；
        # swim＝會飛所以能過海；big=4＝判定圈 34+6*(4-1)=52（大隻）；shadow 依體型放大、貼在正下方
        *[dict(id=did, name="飛龍", fixed=3, swim=True, big=5, speed=46, flee=150, hp=4,
               footDy=0,   # 會飛：不套用底部留白對齊（讓牠浮在影子之上，不貼地）
               anim=dict(sheet="external/img2pixel/dragon_sheet.png", frames=3, rows=2, rowIndex=[0, 2], fw=191, fh=161,
                         rowDir=["up", "down"], fps=7, scale=0.9),
               shadow=dict(rx=46, ry=10, dx=0, dy=-4),
               **_tk,
               line="「飛龍」拍了拍翅膀，掀起一陣風。")
          for did, _tk in [
              ("dragon_night",   dict(tint="#1a1a1a", tintBase="#8b1030", tintMode="off")),   # 夜光島：黑（位移法保留明暗，不然會整隻全黑）
              ("dragon_volcano", dict()),                                                    # 熔岩島：原色紅（不調色）
              ("dragon_beach",   dict(tint="#d8c090", tintBase="#8b1030")),                   # 沙灘島：沙色
          ]],
        # 釣上來的敵對怪物（lurker=True）：不在任何地形的 mobs 裡自然出現，只會在釣魚時以 fish.json 的 lurkerChance 機率被釣上來；
        # 落在浮標旁的陸地、直接追殺釣到牠的人（與島主同一套仇恨／爪擊），30 秒沒人打就原地消失，被打倒也消失（不重生、沒有獎勵）
        dict(id="fishman", name="深海魚人", sprite="fishman.png", lurker=True, swim=True, big=2,
             speed=16, flee=110, hp=20,
             line="「深海魚人」瞪著死魚眼，嘴角一直滴著海水。"),
        # 島主：terrain.json 的 owner 指定的動物；big=N＝比普通動物大 N 倍；owner=True＝不會被嚇跑、金色名牌
        # atk＝攻擊樣式：dash＝龍衝（黃金肥龍）、gaze＝石化之瞳（笨蛋蛇女：開眼 2 秒→全地圖、面向她的人石化，背對就安全）、
        #   beam＝波動砲（蓋老師：原地讀條 2 秒→朝攻擊者發射一道跟島主同寬的直線光波，站在光波裡的人受傷）
        # ownerLines＝被激怒的台詞：發動反擊前隨機說一句（不連續重複），泡泡 3 秒；line 則是平常點牠時的描述
        # anim＝多幀動畫（有它就用 sheet 畫，sprite 只在 sheet 載入失敗時當備用）：
        #   sheet＝相對 client/assets/ 的路徑（等寬水平排列，由左至右循環）、frames＝幀數、fps／dashFps＝平常／龍衝時每秒幾幀、
        #   scale＝畫面上 1 個 sheet 像素畫幾 px（只管外觀；判定圈、龍衝碰撞等玩法仍看 big）、keyBg＝把從圖邊連進來的背景色去掉（素材不是透明底時用）
        dict(id="gold_dragon", name="黃金肥龍", sprite="golden_dragon.png", owner=True, big=5, atk="dash",
             speed=16, flee=110, hp=200,
             anim=dict(sheet="external/img2pixel/bahamut_fly_sheet.png", frames=6, fps=8, dashFps=16, scale=4, keyBg=True),
             line="「黃金肥龍」抖了抖金色的肚皮，打了一個不容小覷的呵欠。",
             # 黃金肥龍：暫時代用（說這些台詞的本人還沒做）。使用者提供的正式翻譯，字句照原文（全形空白是刻意的停頓），不要自行潤飾；
             # 每句台詞依關鍵字對應招式（QUOTE_KEYWORDS，產生 lineSkills），讀完台詞後依序放出；關鍵字對照見 docs/notes.md「島主與戰鬥」
             ownerLines=["我降臨於此對月長嘯！　召喚星降之夜！", "我自月而來降臨於此，　召喚星降之夜！",
                         "鋼鐵燃燒吧！　成為我降臨於此的刀劍吧！", "鋼鐵成為我降臨於此的燃燒之劍！",
                         "我自月而來降臨於此，　踏過熾熱之地！", "我自月而來攜鋼鐵降臨於此！",
                         "超新星啊，更加閃耀吧！　在星降之夜，稱讚紅月！", "超新星啊，更加閃耀吧！　照亮紅月下熾熱之地！",
                         "我降臨於此，　對月長嘯！", "我降臨於此，　征戰鐵血霸道！",
                         "熾熱燃燒！　給予我月亮的祝福！", "被熾熱灼燒過的軌跡　乃成鐵血霸道！",
                         "月光啊！　照亮鐵血霸道！", "月光啊！　用你的熾熱燒盡敵人！"]),
        dict(id="snake_queen", name="笨蛋蛇女", sprite="snake_queen.png", owner=True, big=4, atk="gaze",
             speed=16, flee=110, hp=200,
             # 外觀是使用者自製的 4 幀（88×85，透明底），external/ 不由產生器畫；重跑不會動到那張 sheet
             anim=dict(sheet="external/img2pixel/snake_queen_sheet.png", frames=4, fps=8, scale=3, keyBg=False),
             line="「笨蛋蛇女」半閉著眼，慢半拍地捲了一下蛇尾。",
             ownerLines=["石化之瞳啊，睜開吧！", "蠢貨們，在我的面前化為石像吧！", "美，就該凝固在最完美的一刻！",
                         "蛇髮的詛咒啊，貫穿眼前的一切！", "別亂動喔……一動就變石頭了。", "乖乖站好，這可是你最後一次能動了。"]),
        # 蓋老師（究極神兵）：外觀是使用者自製的 6 幀走路圖（88×74，透明底），external/ 不由產生器畫，
        # 所以它沒有 sprite（沒有圖檔可退回）；被打先講台詞（skills.json 的 beam.say:true）再原地讀條放波動砲
        dict(id="ultima_weapon", name="蓋老師", owner=True, big=5, atk="beam",
             speed=16, flee=110, hp=200,
             anim=dict(sheet="external/img2pixel/ultima_weapon_sheet.png", frames=6, fps=8, scale=3, keyBg=False),
             shadow=dict(rx=100, ry=20, dx=3, dy=-12),   # 影子：素材的腳印很寬（約 190px）、貼近畫面底，預設的 big 影子又小又偏下，看起來飄在空中
             line="「蓋老師」的裝甲縫隙透出紅光，發出低沉的機械運轉聲。",
             # 台詞由使用者提供，字句照原文（含原文的用字與標點，不要自行潤飾）；一句裡的換行是泡泡裡的換行（\n）；
             # 發動反擊前隨機說一句（泡泡 3 秒）
             ownerLines=["冒險者，你是為了什麼而戰鬥的？",
                         "那麼我倒想問，\n你認為，艾奧傑亞存在真實嗎？",
                         "由虛偽所塗抹出來的共存。\n由欺騙所搭建出來的城市。\n由謊言所塑造出來的偽神。",
                         "艾奧傑亞從上到下布滿了欺瞞，\n這裡真的存在真實嗎？",
                         "蠻神的出現令人們感到恐懼，\n為了驅散恐懼，人們進行戰鬥。\n難道你就不認為這很奇怪！",
                         "你們既然信仰著所謂的十二神。\n那麼就如加爾提諾戰役中那樣，\n遇到危難時再次召喚出來又有何妨。",
                         "於是作為召喚神明的代價，\n讓這片大地水晶和以太之力都被吸走又如何！",
                         "你們也應該已經意識到了。\n十二神和蠻神並無任何本質上的不同，\n過於依靠他們的力量終將導致大地的滅亡。",
                         "然而即使知道了真相，\n為什麼愚蠢的人民仍然在依賴著這些偽神？\n睿智如路易索瓦賢者，為什麼也在其中？",
                         "原因很簡單，\n一切都是因為你們的長者、王者、執政者，\n所有的人都是軟弱無能之輩！",
                         "所謂人世，只有處於人的支配下才有存在的價值！",
                         "人類自古以來就在與他人的鬥爭中磨練自己，\n通過掠奪獲得財富，通過支配創造繁榮。",
                         "也就是說，鬥爭之後敗下陣來的弱者，\n只有在強者的領導下，才能夠走向未來！",
                         "正因為現在的民眾被無能之人所領導，\n才會召喚出虛偽的神靈，導致大地幹枯，生靈塗炭。",
                         "所以只要遵從強者的統治便好。\n要將愚蠢的人民從充滿謊言的這片大地上拯救出來，\n除此之外別無他法！",
                         "我會打倒你們這些所謂的「英雄」，\n讓世人見識到我的力量！\n足以統治艾奧傑亞的天命之人的力量！",
                         "只有在我的鐵腕統治之下，\n艾奧傑亞才會獲得新生！",
                         "英雄……也只是虛偽的偶像。\n就由我來打破！"],
             ownerLinesSeq=True),   # 蓋老師的台詞照順序一句一句說（說完一輪回到第一句）；其他島主維持隨機
        # 壓力山大（機械島島主）：外觀是使用者自製的 4 幀待機圖（88×77，透明底），external/ 不由產生器畫，沒有 sprite 備用圖（同蓋老師）。
        # 台詞由使用者提供（2026-11-05），字句照原文（含原文的用字與標點，不要自行潤飾）；一句裡的換行（\n）是泡泡裡的換行。
        # atk="command"＝命令（行動命令／靜止命令：讀條 2 秒，結束時玩家必須處於行動／靜止狀態，否則強制倒地，見 main.js 的 commandFire）。
        # lineSkills 與 ownerLines 一一對應（手寫、不走 QUOTE_KEYWORDS）：第 1、2 句＝行動命令、第 3 句（時間牢獄＝不能動）＝靜止命令。
        # ownerLinesSeq=True：照順序一句一句說（敘事順序：出場自介 → 合神完畢 → 時間牢獄）。
        dict(id="alexander", name="壓力山大", owner=True, big=5, atk="command",
             speed=16, flee=110, hp=200,
             anim=dict(sheet="external/img2pixel/alexander_idle_sheet.png", frames=4, fps=8, scale=4, keyBg=False),
             faceLeft=True,   # 素材本身面向左邊（預設是面向右），往右走時才左右翻轉
             footDx=-20,      # 兩腳的中心在圖正中央偏左 20px：畫圖時往右挪回來，讓判定圈、影子在正腳下
             shadow=dict(rx=108, ry=20, dx=0, dy=-10),   # 影子：兩腳張開約 210px 寬，預設的 big 影子太小，看起來飄在空中（同蓋老師的做法）
             line="「壓力山大」的關節噴出一縷白色蒸氣，眼睛閃過一道冷冽的紅光。",
             ownerLines=["我乃机械之神，通過改良自身，可達究极完美之境!!",
                         "合神完畢……\n我壓力山大……將引领你體驗最深的绝望!!",
                         "時空干涉解除，你會在“時間牢獄”中被永遠囚禁!!"],
             ownerLinesSeq=True,
             lineSkills=[["act"], ["act"], ["still"]]),
    ],
)

# 台詞招式（黃金肥龍）：台詞裡的關鍵字 → 招式 id（使用者定，2026-11-05）。
# 依關鍵字在句中出現的順序放招；同一招在一句裡重複只放一次（隕石流例外：可放兩次，星降、降臨各算一次）；先比對長的（「紅月」不另外算成「月」）。
# 招式 id 與名稱、數值見 client/assets/skills/skills.json 的 quotes 與 main.js 的 QUOTE_*；「超新星」不對應招式
QUOTE_KEYWORDS = [("紅月", "dive"), ("月光", "ring"), ("月亮", "ring"), ("月", "ring"),
                  ("熾熱", "ion"), ("燃燒", "ion"), ("鐵血", "iron"), ("鋼鐵", "iron"), ("星降", "meteor"), ("降臨", "meteor")]

def quote_skills(line):
    """一句台詞 → 依序要放的招式 id 清單（最多 3 個）。"""
    out, i = [], 0
    while i < len(line):
        for kw, sk in QUOTE_KEYWORDS:
            if line.startswith(kw, i):
                if sk not in out or (sk == "meteor" and out.count(sk) < 2):   # 其他招同一句只放一次；隕石流可以放兩次（星降、降臨各算一次）
                    out.append(sk)
                i += len(kw)
                break
        else:
            i += 1
    return out[:3]

for _m in MOB_MANIFEST["mobs"]:
    if _m.get("id") == "gold_dragon":
        _m["lineSkills"] = [quote_skills(l) for l in _m["ownerLines"]]   # 與 ownerLines 一一對應

def anim_bottom_pad(sheet, fw, fh, frames, rows, row0):
    """量方向網格 sheet 每格「底部留白」的最大值（像素）：腳沒踩到格子底時，畫面上要往下挪這麼多才會踩到影子。
    （素材每格大小固定，底部常有幾列透明；島主／飛行怪不套用，牠們另有調好的影子偏移。）"""
    px = read_png_pixels(os.path.join(ASSETS, sheet))
    if px is None:
        return 0
    w, h, data = px
    pad = 0
    for r in range(row0, min(row0 + rows, h // fh)):
        for c in range(frames):
            last = -1
            for y in range(fh):
                base = ((r * fh + y) * w + c * fw) * 4
                if any(data[base + x * 4 + 3] > 16 for x in range(fw)):
                    last = y
            if last >= 0:
                pad = max(pad, fh - 1 - last)
    return pad

# 小動物（方向網格）：自動量底部留白 → footDy（像素＝留白 × scale），讓腳／底部踩到地面（島主、釣上來的怪不套用）
for _m in MOB_MANIFEST["mobs"]:
    _a = _m.get("anim")
    if not _a or "footDy" in _m or _m.get("owner") or _m.get("lurker"):
        continue
    _pad = anim_bottom_pad(_a["sheet"], _a["fw"], _a["fh"], _a["frames"], _a.get("rows", 1), _a.get("row0", 0))
    if _pad:
        _m["footDy"] = round(_pad * (_a.get("scale", 2)))

# 每座地形的島主（id＝mobs.json 裡的動物 id；沒列的就是還沒有島主）
OWNER_BY_TERRAIN = {
    "grass": "gold_dragon",
    "night": "snake_queen",
    "volcano": "ultima_weapon",
    "machine": "alexander",
}

# 各地形出現的小動物（id=權重）
MOBS_BY_TERRAIN = {
    "grass":   [("sheep", 2), ("bird", 1), ("frog", 1), ("chicken", 2), ("slime_grass", 1)],
    "beach":   [("bird", 2), ("frog", 1), ("bunny", 2), ("slime_beach", 1), ("dragon_beach", 1)],
    "snow":    [("sheep", 2), ("bird", 1), ("bunny_snow", 2), ("slime_snow", 1)],
    "night":   [("frog", 2), ("sheep", 1), ("slime_night", 1), ("dragon_night", 1)],
    "forest":  [("sheep", 2), ("bird", 2), ("chicken", 2), ("slime_forest", 1)],
    "volcano": [("frog", 1), ("bird", 1), ("slime_volcano", 1), ("dragon_volcano", 1)],
    "machine": [("bunny_machine", 2), ("slime_machine", 1)],   # 機械島原本沒有野生動物；2026-11-08 使用者指定加跳跳兔（灰）與史萊姆（灰）
}

# ---------------- 地板（裝飾模式的地板層，16×16 無縫磚，畫在地面與家具之間）----------------
# 多格地板（manifest 標 w/h，例如地毯 2×2）是一整張圖，從錨點格（左上）畫起；鋪下去會取代範圍內的單格地板，多格地板彼此不重疊
def floor_wood():
    base, dark, hi = hx("#b98a5a"), hx("#8a6038"), hx("#cfa26e")
    cv = Canvas(16, 16)
    cv.rect(0, 0, 15, 15, base)
    for row, y0 in enumerate((0, 4, 8, 12)):          # 四排橫木板，接縫左右錯開
        cv.hline(0, 15, y0 + 3, dark)
        cv.hline(0, 15, y0, hi)
        jx = (3, 11, 7, 14)[row]
        cv.vline(jx, y0, y0 + 2, dark)
        for gx in (1 + row * 3, 9 - row):              # 一點木紋
            cv.set(gx % 16, y0 + 1, shade(base, 0.9)); cv.set((gx + 1) % 16, y0 + 2, shade(base, 0.9))
    return cv

def floor_stone():
    base, dark, hi = hx("#9a9aa2"), hx("#6a6a74"), hx("#b4b4bc")
    cv = Canvas(16, 16)
    cv.rect(0, 0, 15, 15, base)
    # 不規則石板：先畫縫（可無縫重複），再各板點亮上緣
    for y in (0, 8): cv.hline(0, 15, y, dark)
    for x, y0, y1 in ((0, 0, 7), (6, 0, 7), (12, 0, 7), (3, 8, 15), (9, 8, 15), (15, 8, 15)):
        cv.vline(x, y0, y1, dark)
    for x0, x1, y in ((1, 5, 1), (7, 11, 1), (13, 15, 1), (4, 8, 9), (10, 14, 9), (0, 2, 9)):
        cv.hline(x0, x1, y, hi)
    for pt in ((2, 4), (9, 5), (14, 3), (6, 12), (12, 13), (1, 14)):
        cv.set(pt[0], pt[1], shade(base, 0.88))
    return cv

FLOOR_MANIFEST = dict(
    tile=16,
    items=[
        dict(id="wood", name="木紋地板", sprite="floor_wood.png"),
        dict(id="stone", name="石製地板", sprite="floor_stone.png"),
        dict(id="rug", name="地毯", sprite="floor_rug.png", w=2, h=2),   # 多格地板：一次鋪 w×h 格（圖 16w×16h），彼此不重疊
    ],
)

# ---------------- 釣魚：魚類圖鑑（16×16，頭朝右；自製 placeholder）----------------
# 每座地形 30 種（常見 15／罕見 9／稀有 6），圖由下面幾個參數化的形狀畫出來。
# 清單與屬性在 FISH_TABLE；產生 client/assets/fish/<id>.png 與 fish.json
FISH_EYE = hx("#1a1418")   # 魚的眼睛（不要叫 EYE：會蓋掉人物用的同名常數）

def _in_ell(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0

def _over(cv, pts, c):   # 只畫在已經有顏色的格子上（條紋、斑點不超出身體）
    for x, y in pts:
        if 0 <= x < cv.w and 0 <= y < cv.h and cv.get(x, y)[3]:
            cv.set(x, y, c)

def fish(body, belly=None, fin=None, L=11, H=6, stripes=(), spots=(), band=None, horn=None,
         whisker=False, alpha=255, glow=None):
    cv = Canvas(16, 16)
    b = hx(body, alpha)
    f = hx(fin, alpha) if fin else shade(b, .78)
    cx, cy, rx, ry = 8.5, 8, L / 2, H / 2
    x0 = math.ceil(cx - rx)
    for i in range(3):                                   # 尾鰭（越往左越開）
        cv.vline(x0 - 1 - i, round(cy - 1 - i), round(cy + 1 + i), f)
    cv.ellipse(cx, cy, rx, ry, b)
    top = math.ceil(cy - ry)
    cv.hline(round(cx - 2), round(cx), top - 1, f)       # 背鰭
    cv.set(round(cx - 1), top - 2, f)
    if belly:
        _over(cv, [(x, y) for y in range(round(cy) + 1, 16) for x in range(16) if _in_ell(x, y, cx, cy, rx, ry)], hx(belly, alpha))
    for sx in stripes:
        _over(cv, [(sx, y) for y in range(16)], shade(b, .55))
    if band:
        _over(cv, [(x, round(cy)) for x in range(x0, 15)], hx(band, alpha))
    for p in spots:
        _over(cv, [p], hx(glow or "#ffffff", alpha) if glow else shade(b, .6))
    hx_ = round(cx + rx)
    if horn:
        cv.hline(hx_, 15, round(cy) - 1, hx(horn))
    if whisker:
        cv.set(hx_, round(cy) + 1, f); cv.set(hx_ + 1, round(cy) + 2, f)
    cv.outline((30, 24, 22, alpha))
    cv.set(hx_ - 2, round(cy) - 1, FISH_EYE)
    return cv

def eel(body, belly, alpha=255):
    cv = Canvas(16, 16)
    b, bl = hx(body, alpha), hx(belly, alpha)
    for x in range(1, 15):
        y = 8 + round(math.sin(x * .7) * 1.6)
        cv.vline(x, y - 1, y + 1, b)
        cv.set(x, y + 1, bl)
    cv.outline()
    y = 8 + round(math.sin(14 * .7) * 1.6)
    cv.set(13, y - 1, FISH_EYE)
    return cv

def shrimp(c):
    cv = Canvas(16, 16)
    b = hx(c)
    for (x, y) in ((4, 10), (6, 8.5), (8, 7.5), (10, 7.5), (12, 8)):
        cv.ellipse(x, y, 2, 2, b)
    cv.vline(2, 10, 13, shade(b, .8)); cv.vline(3, 11, 13, shade(b, .8))   # 尾扇
    for x in (6, 8, 10):                                                     # 腳
        cv.set(x, 11, shade(b, .7))
    for i in range(4):                                                       # 觸鬚
        cv.set(13 + i // 2, 6 - i, shade(b, 1.15))
    cv.outline()
    cv.set(12, 7, FISH_EYE)
    return cv

def crab(c, shell=None):
    cv = Canvas(16, 16)
    b = hx(c)
    if shell:                                                                # 寄居蟹：背著螺殼
        s = hx(shell)
        cv.ellipse(6, 8, 5, 5, s)
        for (x, y) in ((6, 8), (7, 7), (5, 7), (5, 9), (7, 10), (8, 9)):
            cv.set(x, y, shade(s, .65))
        cv.ellipse(12, 10, 2.5, 2.5, b)
        cv.ellipse(14, 7, 1.5, 1.5, b)
        for x in (10, 12): cv.vline(x, 12, 14, shade(b, .8))
        cv.outline()
        cv.set(13, 9, FISH_EYE)
        return cv
    cv.ellipse(8, 9, 5, 3, b)
    cv.ellipse(2.5, 6, 2, 2, b); cv.ellipse(13.5, 6, 2, 2, b)               # 螯
    cv.set(4, 8, b); cv.set(12, 8, b)
    for x in (4, 6, 10, 12): cv.vline(x, 12, 14, shade(b, .8))               # 腳
    cv.vline(6, 5, 6, b); cv.vline(10, 5, 6, b)                              # 眼柄
    cv.outline()
    cv.set(6, 4, FISH_EYE); cv.set(10, 4, FISH_EYE)
    return cv

def starfish(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 8.5, 2.5, 2.5, b)
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        for r in range(2, 8):
            cv.ellipse(8 + math.cos(a) * r, 8.5 + math.sin(a) * r, max(.8, 1.6 - r * .15), max(.8, 1.6 - r * .15), b)
    for (x, y) in ((8, 8), (7, 10), (9, 10), (6, 8), (10, 8)):
        cv.set(x, y, shade(b, 1.2))
    cv.outline()
    return cv

def octopus(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 6, 5, 4.5, b)
    for i, x in enumerate((3, 5, 7, 9, 11, 13)):
        for y in range(9, 15):
            cv.set(x + (1 if (y + i) % 4 < 2 else 0), y, b)
    cv.outline()
    cv.set(6, 7, FISH_EYE); cv.set(10, 7, FISH_EYE)
    return cv

def squid(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 5.5, 3, 5, b)
    cv.hline(4, 12, 2, shade(b, .85)); cv.hline(5, 11, 1, shade(b, .85))    # 鰭
    for x in (5, 7, 9, 11):
        cv.vline(x, 10, 14, b)
    cv.vline(6, 10, 15, b); cv.vline(10, 10, 15, b)
    cv.outline()
    cv.set(7, 8, FISH_EYE); cv.set(9, 8, FISH_EYE)
    return cv

def jelly(c, alpha=210):
    cv = Canvas(16, 16)
    b = hx(c, alpha)
    for y in range(2, 9):
        for x in range(16):
            if _in_ell(x, y, 8, 8, 6, 6):
                cv.set(x, y, b)
    cv.hline(2, 14, 8, shade(b, 1.2))
    for i, x in enumerate((4, 6, 8, 10, 12)):
        for y in range(9, 15):
            cv.set(x + (1 if (y + i) % 3 == 0 else 0), y, shade(b, .85))
    cv.outline((30, 24, 22, alpha))
    return cv

def turtle(shell, skin, spots=None):
    cv = Canvas(16, 16)
    s, k = hx(shell), hx(skin)
    cv.ellipse(4, 12, 2, 1.5, k); cv.ellipse(11, 12.5, 2, 1.5, k)          # 鰭肢
    cv.ellipse(4, 5, 2, 1.5, k); cv.ellipse(11, 4.5, 2, 1.5, k)
    cv.ellipse(13.5, 8.5, 2, 1.8, k)                                         # 頭
    cv.ellipse(7.5, 8.5, 5.5, 4, s)
    for (x, y) in ((6, 7), (9, 7), (7, 10), (10, 10), (5, 9)):
        cv.set(x, y, hx(spots) if spots else shade(s, .7))
    cv.outline()
    cv.set(14, 8, FISH_EYE)
    return cv

def snail(shell, body):
    cv = Canvas(16, 16)
    s, b = hx(shell), hx(body)
    cv.rect(3, 12, 14, 13, b)
    cv.vline(13, 9, 12, b); cv.set(14, 8, b); cv.set(12, 8, b)
    cv.ellipse(7, 8.5, 4.5, 4.5, s)
    for (x, y) in ((7, 8), (8, 8), (8, 9), (7, 10), (6, 10), (5, 9), (5, 8), (6, 6), (8, 6), (9, 7)):
        cv.set(x, y, shade(s, .65))
    cv.outline()
    return cv

def tadpole(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(10.5, 8, 3, 2.5, b)
    for x in range(2, 8):
        cv.set(x, 8 + round(math.sin(x * 1.1)), b)
        cv.set(x, 9 + round(math.sin(x * 1.1)), shade(b, .8))
    cv.outline()
    cv.set(12, 7, FISH_EYE)
    return cv

def ray(c, belly):
    cv = Canvas(16, 16)
    b = hx(c)
    for y in range(3, 14):
        w = 6 - abs(y - 8) * 1.1
        if w > 0:
            cv.hline(round(9 - w), round(9 + w * .6), y, b)
    cv.hline(1, 4, 8, shade(b, .8))                                          # 尾
    cv.outline()
    for (x, y) in ((8, 6), (10, 9), (7, 10), (11, 6)):
        cv.set(x, y, hx(belly))
    cv.set(11, 7, FISH_EYE); cv.set(11, 9, FISH_EYE)
    return cv

def angler(c, lure):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.vline(2, 7, 11, shade(b, .8)); cv.vline(1, 6, 12, shade(b, .8))       # 尾
    cv.ellipse(8.5, 9, 6, 4.5, b)
    cv.hline(10, 14, 11, hx("#2a1418"))                                      # 大嘴
    for x in (11, 13): cv.set(x, 10, hx("#f0f0e0"))
    cv.vline(10, 2, 4, shade(b, .8)); cv.set(11, 2, shade(b, .8))            # 燈籠觸手
    cv.outline()
    cv.ellipse(12.5, 2, 1.2, 1.2, hx(lure))
    cv.set(11, 7, FISH_EYE)
    return cv

def boot(c, sole="#3a2a22"):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 2, 8, 11, b)
    cv.rect(4, 9, 13, 12, b)
    cv.rect(12, 10, 13, 12, shade(b, 1.15))
    cv.rect(3, 13, 13, 13, hx(sole))
    cv.hline(4, 8, 3, shade(b, .75))
    for y in (5, 7): cv.set(8, y, hx("#e8dcc4"))                             # 鞋帶
    cv.set(10, 11, shade(b, .6)); cv.set(6, 6, shade(b, .6))                 # 破洞
    cv.outline()
    return cv

def can(c, band):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 4, 11, 13, b)
    cv.rect(4, 7, 11, 10, hx(band))
    cv.hline(5, 10, 3, shade(b, 1.2)); cv.hline(5, 10, 14, shade(b, .7))
    cv.vline(5, 4, 13, shade(b, 1.25))
    cv.set(10, 8, shade(hx(band), .6)); cv.set(9, 9, shade(hx(band), .6))    # 凹痕
    cv.outline()
    return cv

def bottle(c, alpha=200):
    cv = Canvas(16, 16)
    b = hx(c, alpha)
    cv.rect(5, 6, 10, 14, b)
    cv.rect(7, 2, 8, 5, b)
    cv.rect(7, 1, 8, 1, hx("#8a6238"))                                       # 軟木塞
    cv.rect(6, 8, 9, 11, hx("#f0e6c8"))                                      # 裡面的信
    cv.vline(6, 6, 13, shade(b, 1.3))
    cv.outline((30, 24, 22, alpha))
    return cv

def glove(c):
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 7, 11, 13, b)
    for x in (4, 6, 8, 10):
        cv.vline(x, 3, 7, b)
    cv.rect(12, 8, 13, 10, b)
    cv.hline(4, 11, 12, shade(b, .75))                                       # 袖口
    cv.set(7, 9, hx("#ffffff")); cv.set(9, 10, hx("#ffffff"))                # 雪花
    cv.outline()
    return cv

def kelp(c):
    cv = Canvas(16, 16)
    b = hx(c)
    for i, x0 in enumerate((4, 8, 11)):
        for y in range(2 + i, 15):
            x = x0 + round(math.sin(y * .8 + i) * 1.2)
            cv.hline(x, x + 1, y, b if (y + i) % 3 else shade(b, 1.2))
    cv.outline()
    return cv

def stick(c, leaf):
    cv = Canvas(16, 16)
    b = hx(c)
    for i in range(12):
        cv.rect(2 + i, 12 - i, 3 + i, 13 - i, b)
    cv.rect(7, 4, 7, 7, b); cv.set(6, 3, b)                                  # 分枝
    cv.ellipse(5, 2.5, 1.5, 1, hx(leaf))
    cv.outline()
    return cv

C, U, R = "common", "uncommon", "rare"
# (地形, id, 名稱, 稀有度, 尺寸 cm 範圍, 畫圖)
FISH_TABLE = [
    # 草島：池塘與小溪
    ("grass", "crucian", "鯽魚", C, (10, 25), lambda: fish("#8a8a52", "#c8c48a", L=10, H=6)),
    ("grass", "medaka", "青鱂魚", C, (3, 6), lambda: fish("#b8d0c8", "#e8f0e8", L=7, H=3)),
    ("grass", "river_shrimp", "小河蝦", C, (3, 8), lambda: shrimp("#9ab8a8")),
    ("grass", "old_boot", "破舊靴子", C, (25, 30), lambda: boot("#6a4a32")),
    ("grass", "loach", "泥鰍", C, (8, 20), lambda: eel("#7a6a44", "#b8a878")),
    ("grass", "perch", "鱸魚", U, (30, 80), lambda: fish("#6a8a6a", "#d0d8c0", L=12, H=6, stripes=(6, 9, 12))),
    ("grass", "green_crab", "綠背蟹", U, (8, 20), lambda: crab("#4a8a4a")),
    ("grass", "catfish", "鯰魚", U, (30, 100), lambda: fish("#5a5048", "#a89c88", L=13, H=5, whisker=True)),
    ("grass", "koi", "錦鯉", R, (40, 90), lambda: fish("#f0f0e8", fin="#e86a3a", L=12, H=6, spots=((6, 7), (7, 7), (10, 8), (11, 9), (9, 6)), glow="#e8582a")),
    ("grass", "meadow_trout", "草原之王鱒", R, (60, 120), lambda: fish("#7aa86a", "#f0e0c0", L=13, H=6, band="#e88aa0", spots=((5, 6), (9, 6), (12, 7)))),
    # 沙灘：近海
    ("beach", "sardine", "沙丁魚", C, (10, 20), lambda: fish("#6a8ab8", "#e0e8f0", L=10, H=4)),
    ("beach", "horse_mackerel", "竹莢魚", C, (15, 35), lambda: fish("#8aa0a8", "#e8e0c8", L=11, H=5, band="#c8b860")),
    ("beach", "hermit_crab", "寄居蟹", C, (3, 10), lambda: crab("#d8703a", shell="#e8d0a8")),
    ("beach", "kelp", "海帶", C, (30, 150), lambda: kelp("#5a7a3a")),
    ("beach", "empty_can", "空罐頭", C, (8, 12), lambda: can("#b8bec6", "#d84a4a")),
    ("beach", "clownfish", "小丑魚", U, (6, 11), lambda: fish("#f08a2a", L=10, H=6, stripes=(6, 10), fin="#f0f0f0")),
    ("beach", "octopus", "章魚", U, (30, 90), lambda: octopus("#c8584a")),
    ("beach", "starfish", "海星", U, (10, 30), lambda: starfish("#e88a4a")),
    ("beach", "mahi", "鬼頭刀", R, (80, 180), lambda: fish("#4aa86a", "#f0d84a", L=14, H=6, fin="#3a88c8")),
    ("beach", "golden_turtle", "黃金海龜", R, (60, 120), lambda: turtle("#d8a830", "#a8c870", "#f8e8a0")),
    # 機械島：前 10 種沿用近海組合（同 id 共用圖檔）；機械限定的 20 種在最後的第二批
    ("machine", "sardine", "沙丁魚", C, (10, 20), lambda: fish("#6a8ab8", "#e0e8f0", L=10, H=4)),
    ("machine", "horse_mackerel", "竹莢魚", C, (15, 35), lambda: fish("#8aa0a8", "#e8e0c8", L=11, H=5, band="#c8b860")),
    ("machine", "hermit_crab", "寄居蟹", C, (3, 10), lambda: crab("#d8703a", shell="#e8d0a8")),
    ("machine", "kelp", "海帶", C, (30, 150), lambda: kelp("#5a7a3a")),
    ("machine", "empty_can", "空罐頭", C, (8, 12), lambda: can("#b8bec6", "#d84a4a")),
    ("machine", "clownfish", "小丑魚", U, (6, 11), lambda: fish("#f08a2a", L=10, H=6, stripes=(6, 10), fin="#f0f0f0")),
    ("machine", "octopus", "章魚", U, (30, 90), lambda: octopus("#c8584a")),
    ("machine", "starfish", "海星", U, (10, 30), lambda: starfish("#e88a4a")),
    ("machine", "mahi", "鬼頭刀", R, (80, 180), lambda: fish("#4aa86a", "#f0d84a", L=14, H=6, fin="#3a88c8")),
    ("machine", "golden_turtle", "黃金海龜", R, (60, 120), lambda: turtle("#d8a830", "#a8c870", "#f8e8a0")),
    # 雪島：冰海
    ("snow", "cod", "鱈魚", C, (30, 90), lambda: fish("#8a8070", "#e0d8c8", L=12, H=6, spots=((6, 7), (9, 6), (11, 8)))),
    ("snow", "capelin", "柳葉魚", C, (10, 18), lambda: fish("#9aa8b0", "#f0f0e8", L=10, H=3)),
    ("snow", "ice_shrimp", "冰晶蝦", C, (3, 8), lambda: shrimp("#a8d8f0")),
    ("snow", "frozen_glove", "凍僵的手套", C, (20, 25), lambda: glove("#c84a4a")),
    ("snow", "hairy_crab", "毛蟹", C, (8, 15), lambda: crab("#8a6a4a")),
    ("snow", "salmon", "鮭魚", U, (50, 100), lambda: fish("#8a98a8", "#f0a080", L=13, H=6, band="#e88870")),
    ("snow", "icefish", "冰魚", U, (20, 40), lambda: fish("#d8f0f8", "#ffffff", L=12, H=4, alpha=170)),
    ("snow", "squid", "烏賊", U, (20, 60), lambda: squid("#e8d8e0")),
    ("snow", "narwhal_calf", "獨角鯨寶寶", R, (100, 200), lambda: fish("#a8b0c0", "#e8ecf0", L=12, H=6, horn="#f8f0d8", spots=((6, 6), (8, 7), (10, 6)))),
    ("snow", "aurora_trout", "極光鱒", R, (50, 90), lambda: fish("#4ab8a8", "#e0f0f8", L=12, H=6, band="#b88ae8", spots=((6, 6), (9, 6)), glow="#a8f0d8")),
    # 夜光島：發光的夜海
    ("night", "lanternfish", "燈籠魚", C, (5, 12), lambda: fish("#3a4a6a", "#6a7aa0", L=9, H=4, spots=((6, 9), (8, 9), (10, 9)), glow="#8af0f0")),
    ("night", "glow_jelly", "夜光水母", C, (10, 40), lambda: jelly("#8ad8f0")),
    ("night", "black_bass", "黑鱸", C, (20, 50), lambda: fish("#3a3a48", "#6a6a78", L=11, H=6)),
    ("night", "message_bottle", "漂流瓶", C, (20, 30), lambda: bottle("#4a9a6a")),
    ("night", "glow_shrimp", "螢光蝦", C, (3, 8), lambda: shrimp("#7af0b0")),
    ("night", "moon_eel", "月光鰻", U, (50, 150), lambda: eel("#5a5a8a", "#d8d8f0")),
    ("night", "star_ray", "星斑魟", U, (40, 120), lambda: ray("#3a4a7a", "#f0e88a")),
    ("night", "anglerfish", "深海鮟鱇", U, (20, 60), lambda: angler("#4a3a4a", "#f0f08a")),
    ("night", "ghost_fish", "幽靈魚", R, (30, 70), lambda: fish("#e0e8f0", "#ffffff", L=12, H=6, alpha=140)),
    ("night", "moon_arowana", "月影龍魚", R, (60, 130), lambda: fish("#b8b0d8", "#f0e8f8", L=14, H=5, whisker=True, fin="#8a6ac8", glow="#f8f0a0", spots=((6, 7), (9, 7), (12, 7)))),
    # 森林島：林間溪流
    ("forest", "minnow", "溪哥", C, (8, 15), lambda: fish("#a8b08a", "#e8e8d0", L=9, H=4, band="#d88a6a")),
    ("forest", "tadpole", "蝌蚪", C, (1, 4), lambda: tadpole("#4a4a3a")),
    ("forest", "dead_branch", "枯枝", C, (20, 60), lambda: stick("#7a5a3a", "#6a9a4a")),
    ("forest", "crayfish", "小龍蝦", C, (6, 12), lambda: crab("#c83a2a")),
    ("forest", "moss_snail", "苔蘚螺", C, (2, 6), lambda: snail("#6a8a4a", "#c8b898")),
    ("forest", "rainbow_trout", "虹鱒", U, (30, 70), lambda: fish("#8aa878", "#f0e8d8", L=12, H=5, band="#e87a9a", spots=((6, 6), (9, 6), (11, 6)))),
    ("forest", "softshell_turtle", "甲魚", U, (20, 40), lambda: turtle("#6a7a4a", "#8a9a6a")),
    ("forest", "largemouth_bass", "大口黑鱸", U, (30, 60), lambda: fish("#5a7a4a", "#d8d8b0", L=12, H=6, band="#3a4a2a")),
    ("forest", "ancient_fish", "森林古代魚", R, (80, 150), lambda: fish("#4a5a7a", "#8a9ab0", L=14, H=6, fin="#3a4a6a", spots=((5, 7), (7, 6), (9, 8), (11, 6), (12, 9)), glow="#d8e0f0")),
    ("forest", "jade_carp", "翡翠鯉", R, (40, 90), lambda: fish("#3ab88a", "#c8f0d8", L=12, H=6, whisker=True, fin="#2a8a6a", spots=((7, 6), (10, 6)), glow="#f0f8a0")),
    # 熔岩島：熱泉與熔岩海
    ("volcano", "char_fish", "焦炭魚", C, (10, 30), lambda: fish("#3a3030", "#6a5048", L=11, H=5, spots=((7, 8), (10, 7)), glow="#e8582a")),
    ("volcano", "lava_shrimp", "火山蝦", C, (4, 10), lambda: shrimp("#e86a2a")),
    ("volcano", "burnt_boot", "烤焦的靴子", C, (25, 30), lambda: boot("#2a2420", "#1a1410")),
    ("volcano", "magma_snail", "熔岩蝸牛", C, (3, 8), lambda: snail("#5a3a30", "#e8883a")),
    ("volcano", "ash_goby", "灰燼鰕虎", C, (5, 12), lambda: fish("#8a8080", "#c8c0b8", L=9, H=5, spots=((6, 7), (8, 6), (10, 8)))),
    ("volcano", "flame_ray", "火焰魟", U, (50, 120), lambda: ray("#c84a2a", "#f8c84a")),
    ("volcano", "lava_crab", "熔岩蟹", U, (10, 30), lambda: crab("#5a3a3a")),
    ("volcano", "sulfur_eel", "硫磺鰻", U, (60, 140), lambda: eel("#c8b83a", "#f0e88a")),
    ("volcano", "phoenix_fish", "鳳凰魚", R, (50, 100), lambda: fish("#e8582a", "#f8d84a", L=12, H=6, fin="#f8a83a", spots=((6, 7), (9, 6)), glow="#fff0a0")),
    ("volcano", "fire_dragon_carp", "火龍鯉", R, (70, 150), lambda: fish("#c83a3a", "#f0b84a", L=14, H=6, whisker=True, fin="#f0d84a", spots=((6, 6), (8, 6), (10, 6), (12, 7)), glow="#f8e070")),
    # ---- 第二批（每座地形再加 20 種：常見 10／罕見 6／稀有 4，合計每座 30 種）----
    # 草島：池塘與小溪
    ("grass", "pond_snail", "田螺", C, (2, 6), lambda: snail("#7a6a4a", "#a89878")),
    ("grass", "pond_weed", "水草", C, (20, 80), lambda: kelp("#4a8a3a")),
    ("grass", "bluegill", "太陽魚", C, (8, 20), lambda: fish("#5a8aa8", "#e8c868", L=8, H=7, stripes=(6, 9), fin="#e88a3a")),
    ("grass", "bitterling", "鱊魚", C, (4, 9), lambda: fish("#a8b8a0", "#e8d8e0", L=8, H=4, band="#d86a8a")),
    ("grass", "stickleback", "刺魚", C, (4, 8), lambda: fish("#8a8a60", "#d8d0a0", L=8, H=3, spots=((7, 8), (9, 8)))),
    ("grass", "old_flask", "舊水壺", C, (15, 25), lambda: bottle("#6a8ab8")),
    ("grass", "marsh_crab", "沼澤蟹", C, (4, 10), lambda: crab("#7a6a4a")),
    ("grass", "rusty_can", "生鏽鐵罐", C, (8, 12), lambda: can("#8a6a4a", "#a88a68")),
    ("grass", "rice_shrimp", "米蝦", C, (2, 5), lambda: shrimp("#c8b898")),
    ("grass", "grass_carp", "草魚", C, (30, 80), lambda: fish("#7a9a6a", "#e0e0c0", L=12, H=5)),
    ("grass", "paddy_eel", "黃鱔", U, (30, 80), lambda: eel("#c8a850", "#e8d898")),
    ("grass", "pond_slider", "巴西龜", U, (15, 30), lambda: turtle("#5a7a3a", "#8aa85a", "#d8e078")),
    ("grass", "carp", "鯉魚", U, (30, 90), lambda: fish("#c8a850", "#f0e0b0", L=12, H=6, whisker=True)),
    ("grass", "mandarin_fish", "鱖魚", U, (25, 50), lambda: fish("#b8a860", "#e8e0a8", L=11, H=6, stripes=(5, 8, 11), fin="#8a7a3a")),
    ("grass", "black_carp", "青魚", U, (40, 100), lambda: fish("#4a5a5a", "#a8b0a8", L=13, H=5)),
    ("grass", "silver_carp", "白鰱", U, (40, 100), lambda: fish("#b8c0c8", "#f0f4f8", L=13, H=6, fin="#a0a8b0")),
    ("grass", "goldfish_king", "金魚王", R, (25, 45), lambda: fish("#f08a2a", "#f8d878", L=11, H=7, fin="#f8a850", spots=((6, 7), (8, 8), (10, 7)), glow="#fff0a0")),
    ("grass", "platinum_koi", "白金錦鯉", R, (50, 100), lambda: fish("#f8f8f0", "#ffffff", L=13, H=6, fin="#d8e0f0", spots=((6, 7), (9, 8), (11, 7)), glow="#a8d8f8")),
    ("grass", "marsh_sturgeon", "沼澤守護鱘", R, (100, 220), lambda: fish("#5a6a5a", "#c8d0b8", L=14, H=4, horn="#a8b098", spots=((6, 7), (8, 7), (10, 7)))),
    ("grass", "amber_trout", "琥珀鱒", R, (50, 90), lambda: fish("#d8a030", "#f8e0a0", L=12, H=6, band="#a86020", spots=((6, 6), (9, 6), (11, 7)), glow="#fff0b0")),
    # 沙灘：近海
    ("beach", "conch", "海螺", C, (3, 10), lambda: snail("#e8c8a0", "#c8a880")),
    ("beach", "sand_crab", "沙蟹", C, (3, 8), lambda: crab("#d8c898")),
    ("beach", "anchovy", "鯷魚", C, (5, 12), lambda: fish("#8a9ab0", "#e8f0f8", L=9, H=3)),
    ("beach", "flounder", "比目魚", C, (20, 50), lambda: fish("#a89870", "#d8d0b0", L=12, H=7, spots=((6, 7), (9, 6), (11, 8)))),
    ("beach", "sea_lettuce", "海萵苣", C, (10, 40), lambda: kelp("#2a6a4a")),
    ("beach", "plastic_bottle", "寶特瓶", C, (20, 30), lambda: bottle("#a8d8e8")),
    ("beach", "sand_shrimp", "沙蝦", C, (3, 8), lambda: shrimp("#e8d8b8")),
    ("beach", "mullet", "烏魚", C, (30, 70), lambda: fish("#8a9aa8", "#e0e4e8", L=12, H=5)),
    ("beach", "beach_sandal", "海灘拖鞋", C, (20, 28), lambda: boot("#d8b878", "#a88858")),
    ("beach", "moon_jelly", "海月水母", C, (10, 30), lambda: jelly("#e8d0f0")),
    ("beach", "pufferfish", "河豚", U, (15, 40), lambda: fish("#d8c880", "#f8f0d0", L=8, H=8, spots=((6, 7), (8, 6), (10, 8)))),
    ("beach", "seahorse", "海馬", U, (8, 20), lambda: fish("#e8a838", "#f8d878", L=5, H=9, fin="#f8c850")),
    ("beach", "grouper", "石斑魚", U, (30, 100), lambda: fish("#a8584a", "#d8a898", L=13, H=7, spots=((5, 7), (8, 6), (10, 8), (12, 7)))),
    ("beach", "black_porgy", "黑鯛", U, (25, 50), lambda: fish("#4a5058", "#a8acb0", L=11, H=7, stripes=(7,))),
    ("beach", "stingray", "魟魚", U, (40, 120), lambda: ray("#8a7a5a", "#e8d8a8")),
    ("beach", "lobster", "龍蝦", U, (20, 50), lambda: shrimp("#c84a3a")),
    ("beach", "sailfish", "旗魚", R, (150, 300), lambda: fish("#3a5aa8", "#d8e0f0", L=14, H=5, horn="#8aa0d0", fin="#2a4a98")),
    ("beach", "pearl_starfish", "珍珠海星", R, (10, 30), lambda: starfish("#f8e8f0")),
    ("beach", "rainbow_wrasse", "彩虹隆頭魚", R, (20, 50), lambda: fish("#4ad8a8", "#f8e870", L=11, H=6, band="#f87aa8", glow="#fff8c0", spots=((6, 6), (9, 6)))),
    ("beach", "leafy_sea_dragon", "葉海龍", R, (20, 40), lambda: fish("#a8c838", "#e0f088", L=9, H=7, whisker=True, fin="#78a820", spots=((6, 7), (8, 8)), glow="#f8ffa8")),
    # 雪島：冰海
    ("snow", "smelt", "胡瓜魚", C, (10, 20), lambda: fish("#b8c8d0", "#f0f4f8", L=9, H=3)),
    ("snow", "herring", "鯡魚", C, (20, 35), lambda: fish("#7a8aa0", "#e0e8f0", L=10, H=4)),
    ("snow", "pollock", "狹鱈", C, (30, 60), lambda: fish("#8a8a68", "#d8d8c0", L=11, H=5, band="#b8b898")),
    ("snow", "frost_snail", "霜螺", C, (2, 6), lambda: snail("#c8d8e8", "#a8b8c8")),
    ("snow", "ice_kelp", "冰藻", C, (20, 100), lambda: kelp("#6aa8a8")),
    ("snow", "iced_bottle", "冰封瓶", C, (18, 28), lambda: bottle("#a8d0e8")),
    ("snow", "wool_glove", "毛線手套", C, (20, 25), lambda: glove("#4a7ac8")),
    ("snow", "arctic_shrimp", "北極蝦", C, (4, 10), lambda: shrimp("#f0a8a0")),
    ("snow", "sculpin", "杜父魚", C, (8, 20), lambda: fish("#6a6a58", "#b8b498", L=9, H=6, spots=((6, 7), (8, 8), (10, 7)))),
    ("snow", "icicle", "冰柱", C, (20, 50), lambda: stick("#c8e8f8", "#a8d8e8")),
    ("snow", "halibut", "大比目魚", U, (60, 150), lambda: fish("#8a8068", "#e8e0d0", L=13, H=7, spots=((6, 7), (9, 6), (11, 8)))),
    ("snow", "arctic_char", "北極紅點鮭", U, (40, 80), lambda: fish("#6a7a88", "#f0c8a8", L=12, H=5, spots=((6, 6), (9, 6), (11, 7)), band="#e8a078")),
    ("snow", "wolffish", "狼魚", U, (60, 120), lambda: fish("#5a6a78", "#a0acb8", L=13, H=5, whisker=True)),
    ("snow", "ice_octopus", "冰章魚", U, (30, 80), lambda: octopus("#a8c8e8")),
    ("snow", "king_crab", "帝王蟹", U, (15, 40), lambda: crab("#c8584a")),
    ("snow", "snowflake_jelly", "雪花水母", U, (10, 40), lambda: jelly("#e8f4ff")),
    ("snow", "beluga_calf", "白鯨幼崽", R, (150, 250), lambda: fish("#f0f4f8", "#ffffff", L=13, H=7, fin="#d0d8e8", glow="#b8e0ff")),
    ("snow", "crystal_fish", "水晶魚", R, (30, 60), lambda: fish("#c8f0ff", "#ffffff", L=11, H=6, alpha=130, glow="#e8f8ff", spots=((6, 7), (9, 7)))),
    ("snow", "frost_dragon_eel", "霜龍鰻", R, (100, 250), lambda: eel("#6ab8d8", "#e8f8ff")),
    ("snow", "glacier_turtle", "冰川龜", R, (60, 120), lambda: turtle("#a8c8e0", "#c8e0f0", "#f0f8ff")),
    # 夜光島：發光的夜海
    ("night", "glow_snail", "螢光螺", C, (2, 6), lambda: snail("#6ad8c8", "#2a4a6a")),
    ("night", "night_crab", "夜蟹", C, (5, 15), lambda: crab("#4a4a8a")),
    ("night", "moon_kelp", "月藻", C, (20, 100), lambda: kelp("#4a8aa8")),
    ("night", "spark_minnow", "螢光小魚", C, (3, 8), lambda: fish("#4a6aa8", "#8ad8f0", L=8, H=3, glow="#a8f8f8", spots=((6, 8), (9, 8)))),
    ("night", "dusk_perch", "暮鱸", C, (20, 45), lambda: fish("#4a4a78", "#8a8ab8", L=11, H=6, stripes=(6, 9))),
    ("night", "drift_can", "漂流罐", C, (8, 12), lambda: can("#6a7a9a", "#a8d8e8")),
    ("night", "star_shrimp", "星蝦", C, (3, 8), lambda: shrimp("#a8a8f0")),
    ("night", "firefly_squid", "螢烏賊", C, (5, 12), lambda: squid("#8af0d8")),
    ("night", "midnight_crucian", "午夜鯽", C, (15, 30), lambda: fish("#2a3a5a", "#5a6a8a", L=10, H=6)),
    ("night", "lost_boot", "遺落的靴子", C, (25, 30), lambda: boot("#3a3a5a", "#2a2a3a")),
    ("night", "vampire_squid", "吸血烏賊", U, (15, 30), lambda: squid("#5a2a4a")),
    ("night", "comet_eel", "彗星鰻", U, (60, 160), lambda: eel("#3a5aa8", "#a8d8f8")),
    ("night", "dream_ray", "夢魘魟", U, (50, 130), lambda: ray("#4a2a7a", "#e8a8f8")),
    ("night", "opah", "月魚", U, (80, 180), lambda: fish("#c85a6a", "#f8c8c8", L=11, H=8, fin="#e88a8a", spots=((6, 7), (8, 6), (10, 8), (9, 9)))),
    ("night", "lamp_octopus", "燈籠章魚", U, (30, 70), lambda: octopus("#6a5ac8")),
    ("night", "abyss_crab", "深淵蟹", U, (15, 40), lambda: crab("#3a3a6a")),
    ("night", "starlight_whale", "星光鯨幼體", R, (150, 300), lambda: fish("#2a3a8a", "#6a8ad8", L=14, H=7, spots=((5, 7), (7, 6), (9, 8), (11, 6), (12, 8)), glow="#fff8b0")),
    ("night", "aurora_jelly", "極光水母", R, (20, 60), lambda: jelly("#a8f0c8", 190)),
    ("night", "shadow_angler", "影子鮟鱇", R, (40, 100), lambda: angler("#1a1a2a", "#a8f8f8")),
    ("night", "comet_arowana", "彗尾龍魚", R, (70, 140), lambda: fish("#7a5ac8", "#f8e8ff", L=14, H=5, whisker=True, fin="#c8a8f8", glow="#fff8c8", spots=((6, 7), (9, 7), (12, 7)))),
    # 森林島：林間溪流
    ("forest", "creek_chub", "石斑溪魚", C, (8, 16), lambda: fish("#8a9a6a", "#d8d8b8", L=9, H=4, spots=((6, 7), (8, 8), (10, 7)))),
    ("forest", "pine_twig", "松枝", C, (15, 40), lambda: stick("#8a6a3a", "#4a7a3a")),
    ("forest", "mud_snail", "泥螺", C, (2, 5), lambda: snail("#6a5a3a", "#a8987a")),
    ("forest", "water_cress", "水芹", C, (10, 40), lambda: kelp("#5a9a4a")),
    ("forest", "brook_crab", "溪蟹", C, (3, 8), lambda: crab("#6a5a3a")),
    ("forest", "glass_shrimp", "透明蝦", C, (2, 5), lambda: shrimp("#d8e8d0")),
    ("forest", "spring_bottle", "山泉瓶", C, (15, 25), lambda: bottle("#8ac8a8")),
    ("forest", "moss_carp", "苔鯉", C, (20, 40), lambda: fish("#6a8a5a", "#b8c898", L=11, H=6)),
    ("forest", "hiking_boot", "登山靴", C, (25, 30), lambda: boot("#5a6a4a", "#3a3a2a")),
    ("forest", "birch_fish", "樺葉魚", C, (8, 15), lambda: fish("#a8b858", "#e0e8a0", L=10, H=3)),
    ("forest", "mountain_char", "山女鮭", U, (30, 60), lambda: fish("#6a8a7a", "#e8c8b0", L=12, H=5, band="#e8a078", spots=((6, 6), (9, 6)))),
    ("forest", "giant_salamander", "大鯢", U, (60, 150), lambda: eel("#7a6a4a", "#b8a888")),
    ("forest", "pike", "白斑狗魚", U, (60, 120), lambda: fish("#5a7a4a", "#d8d8a8", L=14, H=4, spots=((5, 7), (7, 7), (9, 7), (11, 7)))),
    ("forest", "forest_turtle", "森林龜", U, (20, 40), lambda: turtle("#5a6a3a", "#7a8a4a", "#c8d868")),
    ("forest", "rock_crab", "岩蟹", U, (5, 12), lambda: crab("#8a5a3a")),
    ("forest", "river_eel", "河鰻", U, (50, 120), lambda: eel("#4a5a3a", "#b8c8a0")),
    ("forest", "emerald_salamander", "翡翠蠑螈", R, (25, 50), lambda: eel("#3aa86a", "#d8f0a8")),
    ("forest", "spirit_trout", "精靈鱒", R, (50, 100), lambda: fish("#a8d8b8", "#f0fff0", L=12, H=6, alpha=200, glow="#e8ffc0", spots=((6, 6), (9, 6), (11, 7)))),
    ("forest", "elder_pike", "古木狗魚", R, (90, 160), lambda: fish("#4a5a3a", "#9aa878", L=14, H=5, whisker=True, fin="#6a7a4a", glow="#c8e090", spots=((5, 7), (8, 7), (11, 7)))),
    ("forest", "moss_dragon_turtle", "苔龍龜", R, (60, 120), lambda: turtle("#4a8a5a", "#6aa870", "#d8f0a8")),
    # 熔岩島：熱泉與熔岩海
    ("volcano", "cinder_snail", "灰燼螺", C, (3, 8), lambda: snail("#6a5a58", "#a89890")),
    ("volcano", "steam_shrimp", "溫泉蝦", C, (3, 8), lambda: shrimp("#e89a6a")),
    ("volcano", "obsidian_crab", "黑曜蟹", C, (5, 12), lambda: crab("#2a2a3a")),
    ("volcano", "hot_spring_fish", "溫泉魚", C, (5, 12), lambda: fish("#d8a878", "#f8e0c8", L=9, H=4)),
    ("volcano", "soot_loach", "煤灰鰍", C, (10, 25), lambda: eel("#4a4040", "#8a7a70")),
    ("volcano", "ember_goby", "餘燼鰕虎", C, (4, 9), lambda: fish("#8a4a3a", "#d8886a", L=8, H=4, glow="#f8a03a", spots=((6, 8), (8, 7)))),
    ("volcano", "scorched_can", "燒焦的罐頭", C, (8, 12), lambda: can("#4a4040", "#8a3a2a")),
    ("volcano", "basalt_carp", "玄武鯽", C, (15, 30), lambda: fish("#4a4a50", "#8a8a90", L=10, H=6)),
    ("volcano", "sulfur_kelp", "硫磺藻", C, (10, 50), lambda: kelp("#b8a83a")),
    ("volcano", "melted_bottle", "熔化的瓶子", C, (15, 25), lambda: bottle("#d88a3a", 220)),
    ("volcano", "magma_eel", "熔岩鰻", U, (60, 150), lambda: eel("#a83a2a", "#f8a83a")),
    ("volcano", "ash_octopus", "灰燼章魚", U, (30, 80), lambda: octopus("#6a5a58")),
    ("volcano", "cinder_squid", "餘燼烏賊", U, (20, 50), lambda: squid("#c8583a")),
    ("volcano", "fire_bass", "烈焰鱸", U, (30, 70), lambda: fish("#c8483a", "#f8b878", L=12, H=6, stripes=(6, 9), fin="#f8883a")),
    ("volcano", "ember_turtle", "餘燼龜", U, (30, 60), lambda: turtle("#6a4038", "#8a5a48", "#f8883a")),
    ("volcano", "caldera_angler", "火口鮟鱇", U, (30, 80), lambda: angler("#5a2a2a", "#f8d83a")),
    ("volcano", "magma_dragon", "熔岩龍魚", R, (100, 200), lambda: fish("#b82a2a", "#f8a03a", L=14, H=5, whisker=True, fin="#f8d83a", glow="#fff0a0", spots=((6, 7), (9, 7), (12, 7)))),
    ("volcano", "obsidian_ray", "黑曜魟", R, (70, 150), lambda: ray("#1a1a2a", "#f84a3a")),
    ("volcano", "sun_koi", "烈日錦鯉", R, (50, 100), lambda: fish("#f8c83a", "#fff0b0", L=12, H=6, fin="#f87a2a", glow="#fff8d0", spots=((6, 7), (9, 8), (11, 7)))),
    ("volcano", "salamander_fish", "火蠑魚", R, (40, 90), lambda: eel("#f84a2a", "#f8d870")),    # 機械島：機械海（第二批 20 種；前面 10 種沿用近海組合，同 id 共用圖檔）
    ("machine", "oil_shrimp", "機油蝦", C, (3, 8), lambda: shrimp("#4a4a5a")),
    ("machine", "verdigris_crab", "銅鏽蟹", C, (5, 12), lambda: crab("#4aa88a")),
    ("machine", "gear_snail", "齒輪螺", C, (3, 8), lambda: snail("#8a8a98", "#c8a050")),
    ("machine", "rust_carp", "鐵鏽鯽", C, (10, 30), lambda: fish("#a8603a", "#d8a878", L=10, H=6)),
    ("machine", "cable_kelp", "電纜藻", C, (20, 90), lambda: kelp("#3a5a6a")),
    ("machine", "oil_drum", "廢油桶", C, (30, 40), lambda: can("#5a6a7a", "#d8a830")),
    ("machine", "old_bulb", "舊燈泡", C, (6, 12), lambda: bottle("#e8e0a0", 200)),
    ("machine", "soda_can", "汽水罐", C, (8, 12), lambda: can("#d84a4a", "#e8e8e8")),
    ("machine", "bolt_loach", "螺絲鰍", C, (8, 20), lambda: eel("#7a7a88", "#b8b8c8")),
    ("machine", "iron_goby", "鐵砂鰕虎", C, (5, 12), lambda: fish("#6a6a78", "#a8a8b8", L=9, H=5, spots=((6, 7), (8, 6), (10, 8)))),
    ("machine", "cog_octopus", "齒輪章魚", U, (30, 80), lambda: octopus("#7a8aa8")),
    ("machine", "electric_eel", "電鰻", U, (60, 150), lambda: eel("#3a5a8a", "#f8e83a")),
    ("machine", "steel_turtle", "鋼甲龜", U, (30, 70), lambda: turtle("#7a8aa0", "#a8b4c8", "#d8e0f0")),
    ("machine", "turbine_squid", "渦輪烏賊", U, (20, 60), lambda: squid("#5a7aa8")),
    ("machine", "dynamo_ray", "發電魟", U, (50, 120), lambda: ray("#4a6a8a", "#f8e83a")),
    ("machine", "neon_angler", "霓虹鮟鱇", U, (30, 80), lambda: angler("#3a3a5a", "#4af8c8")),
    ("machine", "clockwork_fish", "發條魚", R, (30, 60), lambda: fish("#c8a850", "#f0e0a0", L=12, H=6, fin="#a88a3a", spots=((6, 7), (9, 6)), glow="#fff0a0")),
    ("machine", "circuit_fish", "電路魚", R, (40, 90), lambda: fish("#2a8a6a", "#8af8c8", L=12, H=5, stripes=(5, 8, 11), glow="#8af8e8")),
    ("machine", "tungsten_marlin", "鎢鋼旗魚", R, (100, 220), lambda: fish("#9aa8b8", "#e0e8f0", L=14, H=5, horn="#e8e8f0")),
    ("machine", "steam_whale", "蒸汽鯨", R, (150, 300), lambda: fish("#8a98a8", "#e8eef4", L=14, H=7, fin="#c8d0d8", glow="#f0f4f8")),
]

def fish_manifest():
    out = dict(
        _comment="釣魚與魚類圖鑑。由 tools/gen_assets.py 的 FISH_TABLE 產生（改這裡要改產生器再重跑）。稀有度先依 weight 抽，再從該地形同稀有度的魚裡平均抽一種；尺寸在 size 範圍內、越大越難（兩份伺服器與單機模擬一致）。",
        escape=0.002,
        lurker="fishman", lurkerChance=0.002,
        _lurkerComment="lurker＝釣上來的敵對怪物（mobs.json 的 id）；lurkerChance＝每次拉竿成功（沒脫鉤）時釣到牠的機率（約 500 竿一次）。同一地形已經有一隻還沒消失時照常釣魚。",
        _bigComment="big＝大尺寸門檻（cm，釣到 ≥ big 就算大尺寸；稱號用）。取尺寸範圍的 75% 處四捨五入，每次釣到該魚時約一到兩成機率是大尺寸（尺寸取 r^1.6）。",
        rarity=dict(common=dict(name="常見", weight=60, color="#c8d0bc"),
                    uncommon=dict(name="罕見", weight=35, color="#7ab8f0"),
                    rare=dict(name="稀有", weight=5, color="#f0c84a")),
        terrains={},
    )
    for t, fid, name, rar, size, _ in FISH_TABLE:
        big = round(size[0] + (size[1] - size[0]) * 0.75)   # 大尺寸門檻：範圍的 75% 處
        out["terrains"].setdefault(t, []).append(dict(id=fid, name=name, rarity=rar, size=list(size), big=big, sprite=f"{fid}.png"))
    return out

def main():
    print("== 外部素材（img2pixel）登記檢查 ==")
    check_external()
    print("== 地形 ==")
    for t in TERRAINS:
        sub = os.path.join("terrain", t["id"])
        la, ld = hx(t["leaf"][0]), hx(t["leaf"][1]); trunk = hx(t["trunk"])
        save(indoor_tile(hx(t["ground"][0]), hx(t["ground"][1])) if t.get("layout") == "room" else dither_tile(hx(t["ground"][0]), hx(t["ground"][1]), t["id"] + "g"), "ground.png", sub)
        save(dither_tile(hx(t["edge"][0]), hx(t["edge"][1]), t["id"] + "e"), "edge.png", sub)
        save(dither_tile(hx(t["water"][0]), hx(t["water"][1]), t["id"] + "w", n=TILE * TILE // 14), "water.png", sub)
        save(tro := tree(la, ld, trunk), "tree.png", sub)
        save(rock(), "rock.png", sub)
        save(stump(), "stump.png", sub)
        save(flower(), "flower.png", sub)
        pine_rows = pine(la, trunk)
        palm_rows = palm(la, ld, trunk)
        if t["id"] in ("snow",):
            save(pine_rows, "pine.png", sub)
        if t["id"] == "beach":
            save(palm_rows, "palm.png", sub)
            save(shell(), "shell.png", sub)
        if t["id"] == "night":
            save(glowshroom(), "glowshroom.png", sub)
            save(lantern(), "lantern.png", sub)
        if t["id"] == "forest":
            save(mushroom(), "mushroom.png", sub)
        if t["id"] == "volcano":
            save(volcanic(), "volcanic.png", sub)
        if t["id"] == "machine":
            save(gear(), "gear.png", sub)
        td = dict(id=t["id"], name=t["name"], scale=2, tile=TILE,
                  ground="ground.png", edge="edge.png", water="water.png",
                  deco=[dict(sprite=s, weight=w) for s, w in t["deco"]],
                  mobs=[dict(id=i, weight=w) for i, w in MOBS_BY_TERRAIN.get(t["id"], [])],
                  uiColor=t["ui"])
        if t["id"] in OWNER_BY_TERRAIN:
            td["owner"] = OWNER_BY_TERRAIN[t["id"]]
        if t["id"] in TABLES_BY_TERRAIN:
            td["tables"] = TABLES_BY_TERRAIN[t["id"]]
        if t.get("layout"):
            td["layout"] = t["layout"]
            if t["layout"] == "room":
                td["groundRepeat"] = INDOOR_REPEAT   # ground.png 是 n×n 格的大圖，每格各畫其中一塊（方磚放大 n 倍）
        if t.get("campfire") is False:
            td["campfire"] = False
        if t.get("anims"):   # 動畫：{ 檔名: anim }（地面/岸邊/水/點綴物都可以；格式見 README「內容擴充」）。寫在 TERRAINS 的該地形裡，重跑才不會被蓋掉
            td["anims"] = t["anims"]
        write_json(os.path.join(ASSETS, sub, "terrain.json"), td)
        print(f"  terrain/{t['id']}/terrain.json")

    print("== 家具 ==")
    for fn, cv in [("sofa", sofa()), ("table", table()), ("chair", chair()),
                   ("plant", plant()), ("rug", rug()), ("lamp", lamp()),
                   ("tv", tv()), ("cat", cat()), ("bed", bed()),
                   ("shelf", shelf()), ("sign", sign()),
                   ("stool", stool()), ("glow_lamp", glow_lamp()), ("fish_tank", fish_tank()), ("steel_shelf", steel_shelf()),
                   ("flower_pot", flower_pot()), ("desk", desk()), ("ice_sculpture", ice_sculpture()), ("moon_lamp", moon_lamp()),
                   ("iron_chair", iron_chair()), ("lava_lamp", lava_lamp()), ("leather_chair", leather_chair()), ("pearl_statue", pearl_statue())]:
        save(cv, fn + ".png", "furniture")
    write_json(os.path.join(ASSETS, "furniture", "furniture.json"), FURN_MANIFEST)
    print("  furniture/furniture.json")
    print("== 和平島遊戲桌 ==")
    save(table_oldmaid(), "table_oldmaid.png", "games")
    save(table_gomoku(), "table_gomoku.png", "games")
    save(table_dodge(), "table_dodge.png", "games")
    save(table_uno(), "table_uno.png", "games")
    print("== 合成素材圖示 ==")
    for mid, (fn, col) in MATERIAL_ICONS.items():
        save(fn(hx(col)), mid + ".png", "craft")

    print("== 地板 ==")
    save(floor_wood(), "floor_wood.png", "floors")
    save(floor_stone(), "floor_stone.png", "floors")
    save(rug(), "floor_rug.png", "floors")            # 地毯：2×2 格（32×32），沿用家具地毯的圖
    write_json(os.path.join(ASSETS, "floors", "floors.json"), FLOOR_MANIFEST)
    print("  floors/floors.json")

    print("== 小動物（FF14 致敬）==")
    adir = os.path.join(ASSETS, "mobs")
    for fn, cv in [("bird", bird()), ("sheep", sheep()), ("frog", frog()), ("fishman", fishman()), ("golden_dragon", golden_dragon()),
                   ("snake_queen", snake_queen())]:
        save(cv, fn + ".png", "mobs")
    write_json(os.path.join(adir, "mobs.json"), MOB_MANIFEST)
    print("  mobs/mobs.json")

    print("== 一般素材 ==")
    save(tombstone(), "tombstone.png")
    save(command_icon_act(), "command_act.png", "ui")      # 命令提示圖示（壓力山大）：行動＝走路小綠人
    save(command_icon_still(), "command_still.png", "ui")  # 靜止＝站立小紅人（main.js 的 CMD_ICONS 載入）
    print("== 武器 ==")
    save(weapon_sword(), "weapon_sword.png", "avatar")
    save(weapon_waraxe(), "weapon_waraxe.png", "avatar")
    save(weapon_daggers(), "weapon_daggers.png", "avatar")
    save(weapon_scepter(), "weapon_scepter.png", "avatar")
    save(weapon_goldsword(), "weapon_goldsword.png", "avatar")
    save(weapon_tome(), "weapon_tome.png", "avatar")
    save(weapon_harpbow(), "weapon_harpbow.png", "avatar")
    save(weapon_lance(), "weapon_lance.png", "avatar")
    save(weapon_staff(), "weapon_staff.png", "avatar")
    save(weapon_rod(), "weapon_rod.png", "avatar")
    print("== 釣魚：魚類圖鑑 ==")
    for t, fid, name, rar, size, draw in FISH_TABLE:
        save(draw(), f"{fid}.png", "fish")
    write_json(os.path.join(ASSETS, "fish", "fish.json"), fish_manifest())
    print("  fish/fish.json")
    print("== 採集工具（tools.json 為手寫資料，這裡只畫圖）==")
    save(tool_pickaxe(), "tool_pickaxe.png", "tools")
    save(tool_axe(), "tool_axe.png", "tools")

    print("== 角色（LPC 通用格式）==")
    sub = "avatar"
    # 素體：LPC 的 body＋head＋eyes 疊成 832×1344（走路列）；男（預設）＋女（之後選性別）；4 種膚色暫共用
    for key in SKINS:
        save(lpc_body_sheet("male", key), f"char_body_{key}.png", sub)
        save(lpc_body_sheet("female", key), f"char_body_female_{key}.png", sub)
    for fid, _fname, rel in LPC_FACES:               # 臉型（頭型；原色，跟膚色用 dye 重上色）
        save(lpc_layer_sheet(f"external/img2pixel/lpc/{rel}"), f"char_face_{fid}.png", sub)
    for eid, rel in LPC_EARS:                        # 種族耳朵（精靈／貓）
        save(lpc_layer_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{eid}.png", sub)
    # 基本服裝（LPC 原檔，走路列）
    for cid, rel in LPC_CLOTHES:
        save(lpc_cloth_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{cid}.png", sub)
    for cid, rel in LPC_WEAPON_OVER:
        save(lpc_read_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{cid}.png", sub)
    # 頭髮：LPC 通用格式外部素材（k-idol 短髮 12 色），1:1 直接用
    for i, (cid, _cname) in enumerate(KIDOL_HAIR):
        save(lpc_read_sheet(f"external/img2pixel/hair_kidol/kidol_hairstyle_male_{cid}.png"),
             f"char_hair{i + 1}.png", sub)
    # 其他 LPC 髮型（走路列；依亮度重上色成「與短髮相同的 12 色」）
    hair_colors = [(cid, cname, kidol_main_hex(cid)) for cid, cname in KIDOL_HAIR]
    kidol_hex = {cid: chex for cid, _cname, chex in hair_colors}   # 髮色主色（manifest 帶給面板／貓耳染色用）
    for sid, _sname, fn in LPC_HAIR_STYLES:
        for cid, _cname, chex in hair_colors:
            save(lpc_hair_tinted(f"external/img2pixel/lpc/{fn}", chex), f"char_hair_{sid}_{cid}.png", sub)
    # 眼睛：5 種表情 × 12 色（虹膜重上色成與髮型相同的 12 色系；眼白／瞳孔輪廓不動）
    for eid, _ename, rel in LPC_EYES:
        for cid, _cname in KIDOL_HAIR:
            save(lpc_eyes_sheet(rel, kidol_hex[cid]), f"char_eyes_{eid}_{cid}.png", sub)
    write_json(os.path.join(ASSETS, sub, "avatar.json"), dict(
        scale=CHAR_SCALE,
        # 人物分層的幀表（所有層共用）：每層都是 832×1344 的 LPC 通用格式 sheet；map＝65 個邏輯幀 → sheet 的 [欄, 列]；
        # w/h＝每格大小、scale＝引擎放大倍率；anchors＝武器掛點（格內像素座標，腳底中心＝(w/2, h)）；frameAnchors 逐幀覆寫
        # footDy＝畫圖時往下挪幾 px：LPC 的腳底在格子第 60～62 列（不是 64），不挪的話人和影子之間有空隙
        frames=dict(w=CHAR_FW, h=CHAR_FH, scale=CHAR_SCALE, footDy=2, count=CHAR_FRAMES + len(char_attack_frames()[0]), dirs=CHAR_DIRS, states=char_states(),
                    map=char_frame_map(),
                    # 攻擊動作在 sheet 上的起始列與用到的欄（引擎用來判斷某一幀屬於哪個動作，LPC 武器的超大格靠它對位）
                    attacks={k: dict(row=r, cols=c) for k, (r, c) in LPC_ATTACKS.items()},
                    fps=dict(idle=4, walk=6),
                    anchors=dict(back=[23, 32], backView=[41, 32], waist=[23, 48], hand=[40, 40]),
                    frameAnchors={}),
        skins=[dict(id=k, name=n, base=SKINS[k][0], shade=SKINS[k][1], sheet=f"char_body_{k}.png")
               for k, n in [("pale", "白皙"), ("light", "自然"), ("tan", "小麥"), ("deep", "深膚")]],
        # 臉型（頭型；原色，執行時用 dye 跟膚色重上色）與眼睛（固定色）
        faces=[dict(id=fid, name=fn, sheet=f"char_face_{fid}.png", dye=LPC_SKIN_DYE) for fid, fn, _r in LPC_FACES],
        # 眼睛：5 種眼神（style）× 12 色（color，虹膜＝髮色同一套）；面板分成「眼神」（文字鈕）與「眼睛顏色」（色塊）兩列
        eyes=[dict(id=f"{eid}_{cid}", name=cname, style=eid, styleName=en, color=cid, hex=kidol_hex[cid], sheet=f"char_eyes_{eid}_{cid}.png")
              for eid, en, _rel in LPC_EYES for cid, cname in KIDOL_HAIR],
        races=LPC_RACES,
        # 髮型：style／styleName＝造型、color／name／hex＝顏色；面板分成「髮型」（文字鈕）與「髮色」（色塊）兩列，換一邊另一邊保持不變
        # hex＝該款髮色的主色（貓耳跟髮色重上色用）
        hair=[dict(id=f"hair{i + 1}", name=cname, style="short", styleName="短髮", color=cid, sheet=f"char_hair{i + 1}.png", hex=kidol_hex[cid])
              for i, (cid, cname) in enumerate(KIDOL_HAIR)] +
             [dict(id=f"{sid}_{cid}", name=cname, style=sid, styleName=sname, color=cid, sheet=f"char_hair_{sid}_{cid}.png", hex=kidol_hex[cid])
              for sid, sname, _fn in LPC_HAIR_STYLES for cid, cname, _hx in hair_colors],
        # 基本服裝（LPC 原檔；gender＝之後選性別用）
        # 服裝：男女共用一個 id（sheet＝男、sheetF＝女，client 依角色性別挑；外觀清單一件只出現一次）；
        # dye＝可染色的顏色（lpc_dye_of 自動從圖上取，第一個是主色）；glam＝可當外觀（沒寫 unlock＝一開始就能用）
        tops=[lpc_garment("tshirt", "T恤", "char_top_tshirt_m.png", "char_top_tshirt_f.png", glam=True),
              lpc_garment("plate", "騎士板甲", "char_top_plate_m.png", "char_top_plate_f.png")],
        bottoms=[lpc_garment("pants", "長褲", "char_bottom_pants_m.png", "char_bottom_pants_f.png", glam=True),
                 lpc_garment("plate_legs", "騎士腿甲", "char_bottom_plate_m.png", "char_bottom_plate_f.png")],
        shoes=[lpc_garment("shoes", "鞋子", "char_shoes_m.png", "char_shoes_f.png", glam=True),
               lpc_garment("plate_boots", "騎士板甲靴", "char_shoes_plate_m.png", "char_shoes_plate_f.png")],
        hats=[dict(id="nohat", name="不戴帽子", sheet=None, glam=True),
              dict(id="armet", name="騎士頭盔", sheet="char_hat_armet.png", hideHair=True, dye=lpc_dye_of("char_hat_armet.png"))],   # hideHair＝全罩式，不畫頭髮
        hairColor="#4a3428",
        shirtColors=['#d95c68', '#4a90d9', '#4aa564', '#c9a227', '#8a5cc9', '#e0e0e0', '#4a4a52', '#d97a3a', '#f2a1b5', '#b5303f', '#f0c93a', '#8fd0e8', '#2e5fa8', '#3a3f8c', '#6fcfc0', '#2f8a78', '#8fc455', '#3e6b3a', '#b48be0', '#6a3f9a', '#8a5a3a', '#c8b08a', '#9aa0aa', '#f4ede0'],
        pantsColors=['#4a54a0', '#2f3548', '#4a4a52', '#8a8f99', '#d8d4c8', '#8a6a46', '#c8b08a', '#5a4a3a', '#3e6b3a', '#6a8a4a', '#2f8a78', '#3a78c8', '#2e5fa8', '#7aa8d8', '#6a3f9a', '#a63d4a', '#d97a3a', '#e0b840', '#e8a0b8', '#b5303f', '#1f1f26', '#f0f0f0', '#6fcfc0', '#b48be0'],
        weapons=[
            # type＝武器類型（武器外觀只能換成同類型的樣子）；職業武器由 jobs.json 的 weapon 指定，武器列只列「職業武器＋空手＋釣竿」
            dict(id="hands", name="空手", type="hands", sprite=None),
            # carry：不拿在手上時掛哪裡（back＝背上、waist＝腰間）；back: "hilt"＝背著時劍柄朝上（沒寫＝頭朝上，例如釣竿）
            # scale：這張圖畫幾倍（沒寫＝與人物同倍率）。目前這些是舊 24px placeholder（人物當時畫 2 倍）＝標 scale 2；
            #        之後的 64px 武器模組照人物規格畫、不寫 scale 就是 1 倍
            # lpc＝LPC 武器圖層（畫在人物圖裡、跟手完全對齊；有這欄就不畫舊的小圖）：bg／fg＝一般格（走路、待機時拿在手上；bg 在身體後面、fg 在最上面），
            # over＝某個攻擊動作的超大格 sheet（size＝每格邊長，人物畫在格子正中央）。2026-11-09 騎士先換：LPC Arming Sword（steel）
            dict(id="sword", name="長劍", type="sword", sprite="weapon_sword.png", carry="back", back="hilt", scale=2,
                 lpc=dict(bg="char_weapon_arming_bg.png", fg="char_weapon_arming_fg.png",
                          over=dict(slash=dict(size=128, bg="char_weapon_arming_slash_bg.png", fg="char_weapon_arming_slash_fg.png")))),
            dict(id="waraxe", name="戰斧", type="axe", sprite="weapon_waraxe.png", carry="back", scale=2),
            dict(id="staff", name="法杖", type="staff", sprite="weapon_staff.png", scale=2, ranged=dict(range=320, cast=1.2, dmg=2)),   # ranged：遠距詠唱——射程 px、詠唱秒數、傷害；按攻擊會自動瞄準（島主優先）
            dict(id="tome", name="賢具", type="tome", sprite="weapon_tome.png", carry="waist", scale=2, ranged=dict(range=320, cast=0, dmg=1, shot="funnels")),   # 賢具＝浮游炮（FF14 nouliths）：不用詠唱，攻擊時四座賢具飛出、各朝目標射一道光束（main.js 的 fxk 'funnels'）；不用詠唱的 dmg 1（使用者定的平衡，同豎琴弓）
            # 豎琴弓：遠程但不用詠唱（cast 0＝按攻擊直接射箭；shot: "arrow"＝畫箭矢而不是光球）。dmg 1：加上輸出的 +1＝2，
            # 和忍者一樣；要詠唱的武器（咒杖等）才是 2＋1＝3（使用者定：不用詠唱的普攻都是 2）
            dict(id="harpbow", name="豎琴弓", type="bow", sprite="weapon_harpbow.png", carry="back", ranged=dict(range=320, cast=0, dmg=1, shot="arrow")),
            dict(id="lance", name="長槍", type="lance", sprite="weapon_lance.png", carry="back"),
            dict(id="daggers", name="雙劍", type="daggers", sprite="weapon_daggers.png", carry="waist"),
            dict(id="scepter", name="咒杖", type="scepter", sprite="weapon_scepter.png", ranged=dict(range=320, cast=1.0, dmg=4, gap=0)),   # gap：詠唱放完到下一次能開始的間隔（秒）；沒寫＝ATK_CD（0.45）。咒杖 gap=0＝連續施放，間隔就是詠唱時間
            dict(id="rod", name="釣竿", type="rod", sprite="weapon_rod.png", carry="back", fishing=True),   # fishing：拿著時左鍵／F 是釣魚，不能攻擊
            # 武器外觀（glam）：只換樣子，玩法照職業武器；type 要和職業武器相同才能選
            dict(id="goldsword", name="金劍", type="sword", sprite="weapon_goldsword.png", carry="back", back="hilt", scale=2,
                 glam=True, unlock=dict(type="owner", mob="gold_dragon"), hint="打倒黃金肥龍"),
        ],
    ))
    print("  avatar/avatar.json")

if __name__ == "__main__":
    main()
