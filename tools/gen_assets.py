#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 素材產生器 v0.2：地形、家具、地板、魚、圖示等是程式畫的自製 placeholder；
# 人物／服裝／武器（LPC）與部分怪物、島主用外部素材（EXTERNAL_BUNDLES 登記，授權逐條記在 docs/assets-license.md）。
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

# 室內房間的牆（2026-11-13，使用者要求：和平島東、北、西三面牆）：北牆畫正面（WALL_H 格高，貼在房間上緣外面），
# 東西牆是從上往下看到的牆頂（1 格寬的長條，貼在房間左右外側）；南面不畫牆。客戶端看 terrain.json 的 walls 畫（drawRoomWalls）
WALL_H = 3   # 北牆正面高幾格（比人物與街機高，才像牆）

def wall_face():
    """北牆正面（16×16·WALL_H，scale 2＝1 格寬）：上緣深色木飾條、米色條紋壁紙、腰線、木護牆板、踢腳板，可左右無縫重複。"""
    h = 16 * WALL_H
    cv = Canvas(16, h)
    trim, paper, stripe, wood = hx("#5a3a28"), hx("#e6d8b8"), hx("#d8c7a0"), hx("#a8744a")
    cv.rect(0, 0, 15, 2, trim); cv.hline(0, 15, 0, shade(trim, 1.35)); cv.hline(0, 15, 2, shade(trim, .75))
    pb = h - 13   # 壁紙下緣
    cv.rect(0, 3, 15, pb, paper)
    for x in (3, 4, 11, 12):
        cv.vline(x, 3, pb, stripe)
    for y in range(6, pb, 6):   # 小菱形花紋
        cx = 8 if (y // 6) % 2 else 0
        cv.set(cx, y, hx("#c9a878")); cv.set(cx - 1, y + 1, hx("#c9a878")); cv.set(cx + 1, y + 1, hx("#c9a878")); cv.set(cx, y + 2, hx("#c9a878"))
    cv.rect(0, pb + 1, 15, pb + 2, hx("#8a5a34")); cv.hline(0, 15, pb + 1, hx("#b07a4a"))   # 腰線
    cv.rect(0, pb + 3, 15, h - 3, wood)
    cv.rect(2, pb + 4, 13, h - 4, shade(wood, .9)); cv.hline(2, 13, pb + 4, shade(wood, .75)); cv.vline(2, pb + 4, h - 4, shade(wood, .75)); cv.hline(2, 13, h - 4, shade(wood, 1.15))   # 護牆板的鑲板
    cv.rect(0, h - 2, 15, h - 1, hx("#4a3020"))   # 踢腳板
    return cv

def wall_side(inner_right):
    """東／西牆的牆頂（16×16，scale 2＝1 格）：深色木頭牆頂，靠房間那一側有亮邊與陰影；inner_right＝房間在右邊（西牆）。"""
    cv = Canvas(16, 16)
    top = hx("#6a4630")
    cv.rect(0, 0, 15, 15, top)
    for y in (3, 11):
        cv.hline(0, 15, y, shade(top, .88))   # 木紋
    ix, ox = (15, 0) if inner_right else (0, 15)
    step = -1 if inner_right else 1
    cv.vline(ix, 0, 15, shade(top, 1.4)); cv.vline(ix + step, 0, 15, shade(top, 1.2))   # 靠房間的亮邊
    cv.vline(ox, 0, 15, shade(top, .6))
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
# ---------------- 人物幀表（8 方向 ×［待機 4 幀＋走路 4 幀］＋坐姿；素材一律用 LPC，見下面「LPC 通用格式」）----------------
# 幀表由 avatar.json 輸出（frames 的 w/h＝CHAR_FW/CHAR_FH、scale＝CHAR_SCALE）。
CHAR_FW, CHAR_FH = 64, 64
CHAR_SCALE = 1                                  # 遊戲把每幀放大幾倍畫（引擎讀 avatar.json 的 frames.scale）；底圖已是 64px，畫 1 倍
CHAR_DIRS = ["down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left"]
CHAR_FRAMES = len(CHAR_DIRS) * 8 + 1
CHAR_SIT = len(CHAR_DIRS) * 8

def char_states():
    st = {}
    for i, d in enumerate(CHAR_DIRS):
        st[f"{d}_idle"] = [i * 8 + k for k in range(4)]
        st[f"{d}_walk"] = [i * 8 + 4 + k for k in range(4)]
    st["sit"] = [CHAR_SIT]
    if "char_attack_frames" in globals():
        st.update(char_attack_frames()[1])   # 攻擊動作（LPC 揮砍／突刺／施法／射擊）
    return st

# ---------------- 髮型模組（LPC 通用格式外部素材）----------------
# 使用者提供的髮型是 LPC 通用格式：832×1344＝13 欄 × 21 列、每格 64×64（單層、透明底、12 種顏色）。
# LPC 的列＝動作：0-3 施法(7 幀)、4-7 突刺(8)、8-11 走路(9)、12-15 揮砍(6)、16-19 射擊(13)、20 受擊(6)；
#   每組四列的順序＝朝上/朝左/朝下/朝右（走路＝列 8 上、9 左、10 下、11 右）。
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
    # 白魔法師／黑魔法師／吟遊詩人／龍騎士（2026-11-09；男女：上身 teen／female、其餘 thin，見 docs/notes.md）
    ("top_whm_m", "top_whm_m.png"), ("top_whm_f", "top_whm_f.png"), ("hat_hood", "hat_hood.png"),
    ("top_blm_m", "top_blm_m.png"), ("top_blm_f", "top_blm_f.png"), ("hat_wizard", "hat_wizard.png"),
    ("top_brd_m", "top_brd_m.png"), ("top_brd_f", "top_brd_f.png"),
    ("bottom_brd_m", "bottom_brd_m.png"), ("bottom_brd_f", "bottom_brd_f.png"),
    ("shoes_brd_m", "shoes_brd_m.png"), ("shoes_brd_f", "shoes_brd_f.png"), ("hat_cavalier", "hat_cavalier.png"),
    ("top_drg_m", "top_drg_m.png"), ("top_drg_f", "top_drg_f.png"),
    ("top_sge_m", "top_sge_m.png"), ("top_sge_f", "top_sge_f.png"),   # 賢者：白色開衩和服＋寬袖，青綠滾邊
    # 戰士：鎖子甲（底下暗紅無袖衣）＋皮肩甲＋護腕、深褐長褲、褐色長靴、蠻族頭盔
    ("top_war_m", "top_war_m.png"), ("top_war_f", "top_war_f.png"),
    ("bottom_war_m", "bottom_war_m.png"), ("bottom_war_f", "bottom_war_f.png"),
    ("shoes_war_m", "shoes_war_m.png"), ("shoes_war_f", "shoes_war_f.png"), ("hat_barbarian", "hat_barbarian.png"),
    # 忍者：深色長袖、深色長褲、分趾襪（tabi）、紅色綁帶頭巾
    ("top_nin_m", "top_nin_m.png"), ("top_nin_f", "top_nin_f.png"),
    ("bottom_nin_m", "bottom_nin_m.png"), ("bottom_nin_f", "bottom_nin_f.png"),
    ("shoes_nin_m", "shoes_nin_m.png"), ("shoes_nin_f", "shoes_nin_f.png"), ("hat_ninja", "hat_ninja.png"),
    ("bottom_drg_m", "bottom_drg_m.png"), ("bottom_drg_f", "bottom_drg_f.png"),
    ("shoes_drg_m", "shoes_drg_m.png"), ("shoes_drg_f", "shoes_drg_f.png"), ("hat_horned", "hat_horned.png"),
    # LPC 武器圖層（一般格：走路列＝拿在手上；bg＝身體後面、fg＝最上面）
    ("weapon_arming_bg", "weapon_arming_bg.png"), ("weapon_arming_fg", "weapon_arming_fg.png"),
    ("weapon_loop_bg", "weapon_loop_bg.png"), ("weapon_loop_fg", "weapon_loop_fg.png"),
    ("weapon_s_bg", "weapon_s_bg.png"), ("weapon_s_fg", "weapon_s_fg.png"),
    ("weapon_waraxe_bg", "weapon_waraxe_bg.png"), ("weapon_waraxe_fg", "weapon_waraxe_fg.png"),   # 戰士：LPC 戰斧
    ("weapon_dagger_bg", "weapon_dagger_bg.png"), ("weapon_dagger_fg", "weapon_dagger_fg.png"),   # 忍者：LPC 短劍（揮砍／突刺都是一般格，放在 act/）
]
LPC_WEAPON_OVER = [             # LPC 武器的超大格動作 sheet（128×128；直接複製）：(遊戲檔名, external 底下的檔名)
    ("weapon_arming_slash_bg", "weapon_arming_slash_bg.png"), ("weapon_arming_slash_fg", "weapon_arming_slash_fg.png"),
    ("weapon_arming_halfslash_bg", "weapon_arming_halfslash_bg.png"), ("weapon_arming_halfslash_fg", "weapon_arming_halfslash_fg.png"),
    # 杖的突刺（192×192）：白魔法師 loop、黑魔法師 s
    ("weapon_loop_thrust_bg", "weapon_loop_thrust_bg.png"), ("weapon_loop_thrust_fg", "weapon_loop_thrust_fg.png"),
    ("weapon_s_thrust_bg", "weapon_s_thrust_bg.png"), ("weapon_s_thrust_fg", "weapon_s_thrust_fg.png"),
    # 龍槍：走路（128×128）＋突刺（192×192）
    ("weapon_dragonspear_walk_bg", "weapon_dragonspear_walk_bg.png"), ("weapon_dragonspear_walk_fg", "weapon_dragonspear_walk_fg.png"),
    ("weapon_dragonspear_thrust_bg", "weapon_dragonspear_thrust_bg.png"), ("weapon_dragonspear_thrust_fg", "weapon_dragonspear_thrust_fg.png"),
    # 戰斧：揮砍（192×192）
    ("weapon_waraxe_slash_bg", "weapon_waraxe_slash_bg.png"), ("weapon_waraxe_slash_fg", "weapon_waraxe_slash_fg.png"),
    # 反曲弓：走路（128×128）
    ("weapon_recurve_walk_bg", "weapon_recurve_walk_bg.png"), ("weapon_recurve_walk_fg", "weapon_recurve_walk_fg.png"),
    # 釣竿：LPC Fishing Rod（13 格 × 4 方向，128×128；只在釣魚時畫，見 avatar.json 的 lpc.fishOnly）
    ("weapon_rod_fish_bg", "weapon_rod_fish_bg.png"), ("weapon_rod_fish_fg", "weapon_rod_fish_fg.png"),
]
LPC_WEAPON_ROWS = [             # 只有某些動作的一般格武器（64×64）：(遊戲檔名, [(動作, external 底下的檔名)])，放到該動作的列
    ("weapon_recurve_bg", [("shoot", "weapon_recurve_shoot_bg.png")]),
    ("weapon_recurve_fg", [("shoot", "weapon_recurve_shoot_fg.png")]),   # 前層含箭矢（LPC Ammo: arrow）
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

# ---------------- LPC 通用格式（2026-11-08 大改：角色整個改用 LPC 通用格式）----------------
# 角色每個部位都是一張 832×1344＝13 欄 × 21 列、每格 64×64 的 LPC 通用格式 sheet（下載的 LPC 素材可直接用）。
# 列＝動作組：0-3 施法(7)、4-7 突刺(8)、8-11 走路(9)、12-15 揮砍(6)、16-19 射擊(13)、20 受擊(6)；
#   每組四列的順序＝上/左/下/右。遊戲只用「走路」組（列 8-11）：待機＝該列第 0 幀、走路＝第 1,3,5,7 幀、斜角沿用同側。
# 素體＝LPC 的 body＋head＋eyes 三層疊成（source 在 external/img2pixel/lpc/）。
LPC_COLS, LPC_ROWS = 13, 25   # 21 列＝LPC 原本的動作；第 21～24 列放半揮（LPC 新動作 halfslash，原本在擴充版的第 50 列，這裡接在後面）
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
    "halfslash": (21, [0, 1, 2, 3, 4, 5]),              # 半揮：由上往下劈（騎士；2026-11-09 使用者要「從上往下」）
}
LPC_DIR4 = ["up", "left", "down", "right"]
CHAR_IDLE_OF4 = {"up": CHAR_DIRS.index("up") * 8, "left": CHAR_DIRS.index("left") * 8,
                 "down": CHAR_DIRS.index("down") * 8, "right": CHAR_DIRS.index("right") * 8}

# 工具動作（LPC 的 custom animation：身體借用某個動作列的幀，工具是 128 超大格、每一格各自一張）：
# 釣竿（2026-11-09，使用者要求四方向釣魚）＝LPC Fishing Rod 的 tool_rod：13 格，身體依序用突刺列的這幾欄
LPC_TOOL_ANIMS = {
    "rod": (4, [0, 1, 2, 3, 4, 5, 4, 4, 4, 5, 4, 2, 3]),
}

def char_attack_frames():
    """攻擊動作與工具動作的邏輯幀：回 (map 條目清單, states)；邏輯幀編號從 CHAR_FRAMES 往後排。
    工具動作的 map 條目＝[欄, 列, 退回幀, 動作名, 工具第幾格, 方向(0上1左2下3右)]。"""
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
    for anim, (row0, cols) in LPC_TOOL_ANIMS.items():
        by4 = {}
        for k, d4 in enumerate(LPC_DIR4):
            by4[d4] = []
            for j, c in enumerate(cols):
                m.append([c, row0 + k, CHAR_IDLE_OF4[d4], anim, j, k])
                by4[d4].append(fi); fi += 1
        for d in CHAR_DIRS:
            st[f"{anim}_{d}"] = by4[LPC_DIR4[LPC_DIR[d]]]
    return m, st

def rod_tips(rel_bg, rel_fg, size=128, n=13):
    """量釣竿每一格的竿尖：從離手最近的釣竿像素（手大約在格子的 (64, 80)）沿著釣竿走（可跨過 6 像素以內的缺口），走最遠的那一點＝竿尖
    （釣竿是彎的，直線距離最遠的常是弧頂而不是竿尖）。回 [方向][格] = [x, y]（格內像素）；那一格沒有釣竿就回 [64, 80]。"""
    ims = [read_png_pixels(os.path.join(ASSETS, r)) for r in (rel_bg, rel_fg)]
    GAP = 6
    out = []
    for d in range(4):
        row = []
        for k in range(n):
            pts = set()
            for w, h, data in ims:
                for y in range(size):
                    for x in range(size):
                        i = ((d * size + y) * w + k * size + x) * 4
                        if data[i + 3] > 16:
                            pts.add((x, y))
            if not pts:
                row.append([64, 80]); continue
            start = min(pts, key=lambda q: (q[0] - 64) ** 2 + (q[1] - 80) ** 2)
            dist, frontier, far = {start: 0}, [start], start
            while frontier:
                nxt = []
                for (x, y) in frontier:
                    for dx in range(-GAP, GAP + 1):   # 可以跨過小缺口：釣竿在手握處被分成前後兩層、中間斷開（只走 8 連通會停在握把）
                        for dy in range(-GAP, GAP + 1):
                            q = (x + dx, y + dy)
                            if q in pts and q not in dist:
                                dist[q] = dist[(x, y)] + 1
                                nxt.append(q)
                                if dist[q] > dist[far]:
                                    far = q
                frontier = nxt
            row.append([far[0], far[1]])
        out.append(row)
    return out

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
    眼白不在這層（在素體頭層），所以不用怕；以虹膜主色亮度為基準，瞳孔輪廓變成深色的目標色。
    （2026-11-09 為 Q 版動漫風重畫過[先是白鞏膜圓眼再改黑框點眼]，使用者看過後決定改回
    較寫實的風格＝LPC 原始眼睛，重畫的行程式碼已移除。）"""
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


def lpc_face_sheet(rel):
    """臉型（頭型）圖層＋Q 版小嘴（2026-11-09，使用者要求加可愛的小嘴；LPC 的臉本來沒有嘴）：
    每個有臉的格（四方向組的第 1~3 列＝左／下／右；朝上不畫）依臉部像素範圍貼 1～2px 的固定小嘴——嘴色**不在
    膚色 dye 調色盤**（dyeSheet 是整色 exact-match），所以不管換成哪種膚色／自訂色，小嘴都不會被重上色。
    臉上的斜陰影／光澤與舊眼球畫法**照上游**（2026-11-09 一度壓平臉、清舊眼球配 Q 版眼，使用者決定
    改回較寫實的風格＝LPC 原始眼睛，那些處理都撤了；上游的眼睛層跟臉型像素本來就對得上）。"""
    sheet = lpc_layer_sheet(f"external/img2pixel/lpc/{rel}")
    mouth = (172, 100, 94)               # 淡玫瑰棕的小嘴色（比膚色深一階、不搶眼）
    for r in range(sheet.h // CHAR_FH):
        d4 = (r - 21 if r >= 21 else     # 半揮是接在 21 起（其餘動作組都是 4 的倍數起）
              r % 4) % 4                  # LPC 四列一組：0 上／1 左／2 下／3 右
        if d4 == 0:
            continue                      # 朝上（背面）不露臉
        for c in range(sheet.w // CHAR_FW):
            ox, oy = c * CHAR_FW, r * CHAR_FH
            pts = [(x, y) for y in range(CHAR_FH) for x in range(CHAR_FW)
                   if sheet.get(ox + x, oy + y)[3] > 16]
            if not pts:
                continue
            x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts)
            y0 = min(p[1] for p in pts); y1 = max(p[1] for p in pts)
            my = y1 - 2                   # 下巴上方一列（y1 是下巴的輪廓弧）
            mx = (x0 + x1) // 2 if d4 == 2 else (x1 - 3 if d4 == 3 else x0 + 3)   # 正面置中；側面貼在前緣內縮處
            spot = sheet.get(ox + mx, oy + my)
            if spot[3] > 16 and (spot[0], spot[1], spot[2]) in {(249, 213, 186), (228, 164, 124), (204, 134, 101)}:   # 臉色系（含陰影層）
                sheet.set(ox + mx, oy + my, (*mouth, 255))            # 1～2px 的小嘴（正面再補第二 px）
                if d4 == 2 and sheet.get(ox + mx + 1, oy + my)[3] > 16:
                    sheet.set(ox + mx + 1, oy + my, (*mouth, 255))
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

def lpc_dye_of(*files, n=8, min_lum=50):
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
            if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < min_lum:
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

# ---------------- 發光武器外觀（2026-11-09，使用者要求）----------------
# 取得稱號《究極》→ 每個職業的武器都有天藍發光版；《傳奇》→ 金黃發光版（avatar.json 的武器外觀 glam，unlock＝稱號）。
# 圖＝原本的 LPC 武器圖層（與武器小圖）依亮度重上色成該色，外圍再加兩圈半透明光暈（只在同一格內，不會滲到隔壁格）。
WEAPON_GLOWS = [   # (後綴, 名稱, 主色, 光暈色, 解鎖條件, 提示)
    ("sky", "天藍輝光", "#5cc8ff", (150, 225, 255), dict(type="titles", ids=["ultima"]), "取得稱號《究極》（參與擊倒熔岩島的蓋老師）"),
    ("gold", "金黃輝光", "#f2c230", (255, 228, 130), dict(type="titles", ids=["legend"]), "取得稱號《傳奇》（參與擊倒草島的黃金肥龍）"),
    ("pink", "粉金輝光", "#e8b43a", (255, 130, 200), dict(type="titles", ids=["perfect"]), "取得稱號《完美》（參與擊倒機械島的壓力山大）"),   # 金色武器＋粉紅光暈（2026-11-09，使用者要求）
]
GLOW_JOB_WEAPONS = ["sword", "waraxe", "staff", "tome", "daggers", "lance", "harpbow", "scepter"]

def glow_image(src_name, dst_name, color, halo, cell):
    """avatar/ 底下的一張圖 → 重上色＋光暈，存成 dst_name。cell＝格子邊長（光暈不跨格；小圖傳整張寬高）。"""
    r = read_png_pixels(os.path.join(ASSETS, "avatar", src_name))
    if r is None:
        raise SystemExit(f"找不到 {src_name}")
    w, h, data = r
    cnt, opaque = {}, []
    for i in range(0, len(data), 4):
        if data[i + 3] > 16:
            c = (data[i], data[i + 1], data[i + 2])
            opaque.append(i // 4)
            if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] >= 40:
                cnt[c] = cnt.get(c, 0) + 1
    cv = Canvas(w, h)
    if not opaque:
        save(cv, dst_name, "avatar"); return
    top = max(cnt, key=cnt.get) if cnt else (128, 128, 128)
    ref = max(1.0, 0.299 * top[0] + 0.587 * top[1] + 0.114 * top[2])
    tr = hx(color)
    cw, ch = cell if isinstance(cell, tuple) else (cell, cell)
    solid = set(opaque)
    # 光暈：每個不透明像素往外 1～2 格（同一格內）點上半透明光，近的比較亮
    glow = {}
    for k in opaque:
        x, y = k % w, k // w
        gx0, gy0 = x // cw * cw, y // ch * ch
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nx, ny = x + dx, y + dy
                if not (gx0 <= nx < gx0 + cw and gy0 <= ny < gy0 + ch and 0 <= nx < w and 0 <= ny < h):
                    continue
                kk = ny * w + nx
                if kk in solid:
                    continue
                a = 150 if max(abs(dx), abs(dy)) == 1 else 60
                if glow.get(kk, 0) < a:
                    glow[kk] = a
    for kk, a in glow.items():
        cv.set(kk % w, kk // w, (halo[0], halo[1], halo[2], a))
    for k in opaque:
        i = k * 4
        f = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / ref
        f = 0.35 + 0.75 * f   # 壓縮明暗：深色部分也帶一點顏色，看起來像在發光
        if f <= 1:
            out = (min(255, round(tr[0] * f)), min(255, round(tr[1] * f)), min(255, round(tr[2] * f)))
        else:
            w2 = min(1.0, f - 1)
            out = (round(tr[0] + (255 - tr[0]) * w2), round(tr[1] + (255 - tr[1]) * w2), round(tr[2] + (255 - tr[2]) * w2))
        cv.set(k % w, k // w, (out[0], out[1], out[2], data[i + 3]))
    save(cv, dst_name, "avatar")

def with_glow(weapons):
    """在武器清單後面加上每把職業武器的發光外觀（並產生圖）：LPC 圖層逐張重上色，小圖（武器列／外觀清單的圖示）也一起。"""
    out = list(weapons)
    by_id = {w["id"]: w for w in weapons}
    for wid in GLOW_JOB_WEAPONS:
        base = by_id[wid]
        for suf, gname, color, halo, unlock, hint in WEAPON_GLOWS:
            g = dict(id=f"{wid}_{suf}", name=f"{base['name']}・{gname}", type=base["type"], glam=True, unlock=unlock, hint=hint)
            for k in ("carry", "back", "scale"):
                if k in base:
                    g[k] = base[k]
            spr = base["sprite"]
            glow_image(spr, spr.replace(".png", f"_{suf}.png"), color, halo, (10 ** 6, 10 ** 6))
            g["sprite"] = spr.replace(".png", f"_{suf}.png")
            lpc = base.get("lpc")
            if lpc:
                gl = {}
                for k in ("bg", "fg"):
                    if lpc.get(k):
                        glow_image(lpc[k], lpc[k].replace(".png", f"_{suf}.png"), color, halo, CHAR_FW)
                        gl[k] = lpc[k].replace(".png", f"_{suf}.png")
                if lpc.get("over"):
                    gl["over"] = {}
                    for an, o in lpc["over"].items():
                        go = dict(size=o["size"])
                        for k in ("bg", "fg"):
                            if o.get(k):
                                glow_image(o[k], o[k].replace(".png", f"_{suf}.png"), color, halo, o["size"])
                                go[k] = o[k].replace(".png", f"_{suf}.png")
                        gl["over"][an] = go
                g["lpc"] = gl
            out.append(g)
    return out

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
         layout="room", campfire=False),   # room＝像室內：整張地圖都是地板（水只有 POOLS_BY_TERRAIN 的室內釣魚池）；campfire=False＝沒有營火
]

# 室內釣魚池（像室內的地形才用）：地形 → [池]。cell＝水面左上角格、w／h＝水面幾格；外圍一圈是池邊（岸，可以走）
POOLS_BY_TERRAIN = {
    # 2026-11-14 使用者要求：水池搬到房間左上角（原本在左側中間 [26,33]）；同日一度加過池邊裝飾，使用者又要求拿掉
    # （2026-11-09 使用者要求和平島找一小塊做室內釣魚場，遠離中央的遊戲桌；水面 8×6、外圍一圈池邊 → 佔 x 25～34、y 17～24）
    "peace": [dict(cell=[26, 18], w=8, h=6)],
}

# 室內地形的方形房間範圍 [x0,y0,x1,y1]（含邊界，格）：2026-11-09 使用者要求和平島縮小到「剛好包含中央到釣魚池再多一點」，且仍是室內（方形、沒有水）。
# 釣魚池左緣離島心 (53.5,35.5) 27.5 格 → 橫向半寬 31（x 23～84）；縱向取 20（y 16～55，62×40，比例同舊地圖 88×56）。
ROOM_BOX = {"peace": [23, 16, 84, 55]}

# 和平島的遊戲桌：地形 → [桌]。id＝桌 id（兩份伺服器的 TABLE_DEFS 要一致）、game＝client/assets/games/games.json 的遊戲 id、
# cell＝左上角格、w／h＝占幾格（圖 48×32 以 scale 2 畫＝3×2 格）。桌子是島上固定物件，不是可擺設的家具
TABLES_BY_TERRAIN = {
    # 2026-11-09 使用者要求：五子棋、抽鬼牌改回各一桌（t3／t4 拿掉，兩份伺服器的 TABLE_DEFS 一起改），
    # 四桌排成 2×2、圍著島中央（44, 28），左右相距 8 格、上下相距 7 格（中間留空給重生點）
    # （2026-11-09 地圖放大成 108×72，島心移到 (54,36)，桌子座標整體加 (10,8)）
    # 2026-11-13 使用者重排：桌子排成格子，第 (x, y) 格（x 往右、y 往下）＝cell [48 + 8x, 32 + 7y]，五子棋 (0,0) 為基準
    "peace": [dict(id="t2", game="gomoku", cell=[48, 32], w=3, h=2),     # (0,0)
              dict(id="t6", game="uno", cell=[48, 39], w=3, h=2),        # (0,1) UNO（2026-11-08，使用者要求）
              dict(id="t1", game="oldmaid", cell=[48, 46], w=3, h=2),    # (0,2)
              dict(id="t8", game="intel", cell=[56, 32], w=3, h=2),      # (1,0) 秘藥情報戰（2026-11-10，使用者要求）
              dict(id="t11", game="blokus", cell=[56, 39], w=3, h=2),    # (1,1) Blokus（2026-11-13，使用者要求）
              dict(id="t12", game="trigon", cell=[56, 46], w=3, h=2),    # (1,2) Blokus Trigon（2026-11-13，使用者要求）
              dict(id="t10", game="mage", cell=[64, 32], w=3, h=2),      # (2,0) 見習驅魔師（2026-11-12，使用者要求）
              dict(id="t5", game="dodge", cell=[64, 39], w=3, h=2),      # (2,1) 躲彈幕只有一桌（2026-11-08，使用者要求）
              dict(id="t14", game="maze", cell=[64, 46], w=3, h=2),      # (2,2) 豆豆迷宮（2026-11-13，使用者要求）
              # 空氣曲棍球兩桌（2026-11-13，使用者要求）：俄羅斯方塊機台底下，4×2.5 格的長桌，相距 2 格
              dict(id="t15", game="hockey", cell=[48, 21], w=4, h=2.5),
              dict(id="t16", game="hockey", cell=[54, 21], w=4, h=2.5),
              dict(id="t9", game="zhtyping", cell=[72, 32], w=3, h=2),   # (3,0) 中文打字競賽（2026-11-11，使用者要求）
              dict(id="t7", game="typing", cell=[72, 39], w=3, h=2),     # (3,1) 英文打字競賽（2026-11-10，使用者要求）
              # 俄羅斯方塊（2026-11-13，使用者要求）：場地上方一排 4 台，造型一樣、配色不同，間距約一個人（1 格）。
              # 4 台共用同一張邏輯桌 t13（伺服器的 TABLE_DEFS 只有 t13），cab＝第幾台（0～3），img＝這台的圖（配色）
              *[dict(id="t13", game="arcade", cab=k, img=f"arcade_{k}.png", cell=[48 + k * 3, 14.5], w=2, h=3) for k in range(4)]],   # y＝14.5：機台上半截疊在北牆前（靠牆），一半在房間外（2026-11-13 使用者要求）
}

# 和平島的固定小物件（不是遊戲桌、不是可擺設的家具）：地形 → [物件]。kind＝互動種類（drink 喝飲料／food 吃點心，客戶端 useProp）、
# img＝這個地形資料夾裡的圖、cell＝左上角格（可以是小數）、w／h＝占幾格。擋路、不能在上面擺家具。
# 餐飲區（2026-11-13，使用者要求）：房間右上角、靠北牆，自助飲料機＋點心吧（網咖／卡拉 OK 那種）
PROPS_BY_TERRAIN = {
    "peace": [dict(id="drink", kind="drink", name="自助飲料", img="drink_bar.png", cell=[77, 14.5], w=2, h=3),
              dict(id="snack", kind="food", name="點心吧", img="snack_bar.png", cell=[80, 15], w=4, h=2.5),
              # 餐飲區的隔板與地毯（2026-11-13，使用者要求）：kind＝deco（擋路、不能互動、沒有名稱）／rug（畫在地板層、不擋路、可以走上去）
              dict(id="dine_wall", kind="deco", img="dine_partition.png", cell=[75, 14.5], w=1, h=5.5),   # 西側一道矮隔板，從北牆伸到 y＝20（南邊開口當入口）
              dict(id="dine_rug", kind="rug", img="dine_rug.png", cell=[76, 16], w=9, h=5),                # 地毯鋪滿隔板右邊到東牆
              # 夾娃娃機與扭蛋機（2026-11-14，使用者要求）：俄羅斯方塊機台右側、靠北牆；底邊要跟俄羅斯方塊機台對齊（y＋h＝17.5，所以夾娃娃機比較高、y 從 14 開始）。先只做外觀框架（kind=deco：擋路、沒有名稱、不能互動），
              # 獎勵怎麼處理還沒決定，之後要開放時把 kind 改成新的互動種類（客戶端 propUse／useProp）
              dict(id="claw", kind="deco", img="claw_machine.png", cell=[61, 14], w=3, h=3.5),
              dict(id="gacha", kind="deco", img="gacha_machine.png", cell=[65, 14.5], w=2, h=3)],
}

def drink_bar():
    """自助飲料機（32×48，畫 scale 2＝2×3 格）：不鏽鋼機身、上方藍色燈箱、四個出水口（可樂／柳橙／綠茶／奶茶色的按鈕）、
    下方滴水盤，側邊一疊紙杯。"""
    cv = Canvas(32, 48)
    steel, dark = hx("#c4c9d2"), hx("#7a808c")
    cv.rect(3, 2, 28, 46, steel)
    cv.rect(3, 2, 4, 46, shade(steel, .8)); cv.rect(27, 2, 28, 46, shade(steel, .75))
    cv.rect(4, 3, 27, 12, hx("#2f6fd0")); cv.hline(4, 27, 3, hx("#7ab0ff"))   # 燈箱
    for k, c in enumerate(["#e84848", "#f0a020", "#40b060", "#e0c090"]):   # 燈箱上四種飲料的色塊
        x = 6 + k * 5; cv.rect(x, 6, x + 3, 9, hx(c)); cv.set(x, 6, shade(hx(c), 1.4))
    cv.rect(5, 14, 26, 31, hx("#20242c"))                       # 出水區（暗）
    for k, c in enumerate(["#3a2018", "#f08a20", "#8ac060", "#c8a070"]):
        x = 7 + k * 5
        cv.rect(x, 15, x + 2, 17, hx("#9aa0aa")); cv.set(x + 1, 18, hx("#9aa0aa"))   # 出水口
        cv.rect(x, 21, x + 2, 22, hx(c)); cv.hline(x, x + 2, 21, shade(hx(c), 1.35))   # 按鈕（飲料顏色）
    cv.rect(6, 26, 11, 30, hx("#e8eef4")); cv.rect(7, 27, 10, 29, hx("#3a2018"))   # 一杯可樂
    cv.rect(5, 31, 26, 33, dark); cv.hline(5, 26, 31, shade(dark, 1.3))   # 滴水盤
    for k in range(4): cv.hline(7 + k * 5, 9 + k * 5, 32, hx("#4a505c"))
    cv.rect(5, 35, 26, 45, shade(steel, .9)); cv.rect(13, 38, 18, 41, dark)   # 下櫃與把手
    cv.rect(0, 20, 2, 33, hx("#f4f4f0")); cv.hline(0, 2, 20, hx("#d84040"))  # 側邊的一疊紙杯
    for y in range(23, 33, 3): cv.hline(0, 2, y, hx("#d8d8d0"))
    cv.outline()
    return cv

def dine_partition():
    """餐飲區隔板（16×88，畫 scale 2＝1×5.5 格）：從北牆往房間裡伸出去的一道矮隔板，從側面看是一條細長的深色木框，
    中間三段毛玻璃，頂端橫木、尾端一盆小觀葉植物收邊。"""
    cv = Canvas(16, 88)
    wood, glass = hx("#6a4428"), hx("#cfe4ec")
    cv.rect(5, 4, 10, 76, wood)                                   # 木框
    for y0, y1 in ((7, 26), (29, 48), (51, 70)):                  # 三段毛玻璃
        cv.rect(6, y0, 9, y1, glass); cv.vline(7, y0 + 1, y1 - 1, shade(glass, 1.08)); cv.hline(6, 9, y1, shade(glass, .82))
    cv.rect(4, 2, 11, 4, shade(wood, 1.25))                       # 頂端橫木
    cv.rect(3, 78, 12, 86, hx("#b06a3a")); cv.hline(3, 12, 78, shade(hx("#b06a3a"), 1.25)); cv.hline(3, 12, 86, shade(hx("#b06a3a"), .7))   # 花盆
    leaf = hx("#3c9a4a")
    for cx, cy, rx, ry in ((7.5, 74, 4, 3), (4.5, 76, 2.5, 2), (10.5, 76, 2.5, 2), (7.5, 70.5, 2.5, 2.5)):
        cv.ellipse(cx, cy, rx, ry, leaf)
    cv.set(6, 72, shade(leaf, 1.35)); cv.set(9, 74, shade(leaf, 1.35))
    cv.outline()
    return cv

def dine_rug():
    """餐飲區地毯（144×80，畫 scale 2＝9×5 格）：酒紅底、米金色雙線邊框，中間一排排小菱形花紋（網咖／卡拉 OK 那種耐髒地毯）。"""
    W, H = 144, 80
    cv = Canvas(W, H)
    base, deep, gold = hx("#8a2f3a"), hx("#6a2230"), hx("#e0c080")
    cv.rect(0, 0, W - 1, H - 1, deep)
    cv.rect(3, 3, W - 4, H - 4, base)
    cv.rect(1, 1, W - 2, 1, gold); cv.rect(1, H - 2, W - 2, H - 2, gold); cv.rect(1, 1, 1, H - 2, gold); cv.rect(W - 2, 1, W - 2, H - 2, gold)   # 外框
    cv.rect(5, 5, W - 6, 5, gold); cv.rect(5, H - 6, W - 6, H - 6, gold); cv.rect(5, 5, 5, H - 6, gold); cv.rect(W - 6, 5, W - 6, H - 6, gold)   # 內框
    dia = shade(base, 1.22)
    for k, y in enumerate(range(13, H - 9, 10)):                  # 菱形花紋（隔排錯開）
        for x in range(13 + (k % 2) * 6, W - 10, 12):
            for d in range(3):
                cv.set(x - d, y - 2 + d, dia); cv.set(x + d, y - 2 + d, dia); cv.set(x - d, y + 2 - d, dia); cv.set(x + d, y + 2 - d, dia)
            cv.set(x, y, gold)
    return cv

def snack_bar():
    """點心吧（64×40，畫 scale 2＝4×2.5 格）：木頭櫃台、檯面上有薯條、熱狗、爆米花桶、關東煮鍋（冒熱氣）、布丁與鬆餅。"""
    cv = Canvas(64, 40)
    wood, top = hx("#8a5a34"), hx("#d8c8a8")
    cv.rect(0, 14, 63, 39, wood)
    cv.rect(0, 14, 63, 18, top); cv.hline(0, 63, 14, shade(top, 1.15)); cv.hline(0, 63, 18, shade(top, .7))   # 檯面
    for x in range(4, 60, 15):   # 櫃台正面的鑲板
        cv.rect(x, 22, x + 11, 35, shade(wood, .88)); cv.hline(x, x + 11, 22, shade(wood, .7)); cv.hline(x, x + 11, 35, shade(wood, 1.15))
    cv.rect(0, 37, 63, 39, shade(wood, .6))
    # 爆米花桶（紅白條紋）
    for y in range(4, 16):
        for x in range(3, 11):
            cv.set(x, y, hx("#e84848") if (x // 2) % 2 == 0 else hx("#f8f4ec"))
    for x, y in [(3, 2), (5, 1), (7, 2), (9, 1), (4, 3), (6, 3), (8, 3), (10, 3), (6, 0)]:
        cv.rect(x, y, x + 1, y + 1, hx("#fff4c0"))
    # 薯條（紅盒＋黃條）
    cv.rect(14, 9, 19, 16, hx("#d83838")); cv.hline(14, 19, 9, hx("#f06060"))
    for x in (14, 16, 17, 19): cv.vline(x, 5 + (x % 3), 9, hx("#f8d040"))
    # 熱狗（盤子上）
    cv.rect(22, 13, 31, 15, hx("#f4f4f0")); cv.rect(23, 11, 30, 13, hx("#e8b060")); cv.rect(24, 10, 29, 11, hx("#c0503a")); cv.hline(25, 28, 10, hx("#f0d040"))
    # 關東煮鍋（冒熱氣）
    cv.rect(34, 8, 45, 16, hx("#9aa0aa")); cv.rect(35, 9, 44, 11, hx("#c89050"))
    for x, c in [(36, "#f4f0e0"), (39, "#c84040"), (42, "#e8c070")]: cv.rect(x, 9, x + 1, 10, hx(c))
    for x, y in [(37, 5), (38, 3), (41, 6), (42, 4), (40, 1)]: cv.set(x, y, hx("#ffffff"))
    # 布丁兩個、鬆餅一盤
    for x in (48, 52):
        cv.rect(x, 12, x + 3, 15, hx("#f0d070")); cv.rect(x, 11, x + 3, 12, hx("#8a4a20"))
    cv.rect(56, 13, 62, 15, hx("#f4f4f0")); cv.rect(57, 11, 61, 13, hx("#e0a050")); cv.set(59, 10, hx("#ffe8a0"))
    cv.outline()
    return cv

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

def table_maze():
    """豆豆迷宮：深青色桌面（有桌腳），桌上一塊螢幕，裡面是青綠色迷宮線、一排豆子、能量豆、黃色小雞造型的豆豆和兩隻水滴形小幽靈。"""
    cv = Canvas(48, 32)
    wood, screen = hx("#2f4a4a"), hx("#06101c")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.3))
    cv.rect(3, 7, 44, 24, screen)
    wall = hx("#2fc8b0")
    cv.hline(5, 42, 8, wall); cv.hline(5, 42, 23, wall); cv.vline(5, 8, 23, wall); cv.vline(42, 8, 23, wall)   # 迷宮外框
    cv.rect(9, 11, 15, 12, wall); cv.rect(32, 11, 38, 12, wall); cv.rect(13, 19, 34, 20, wall); cv.rect(23, 8, 24, 13, wall)
    for x in range(8, 41, 3): cv.set(x, 16, hx("#ffe0a0"))     # 一排豆子
    for y in (10, 13): cv.set(7, y, hx("#ffe0a0")); cv.set(40, y, hx("#ffe0a0"))
    cv.ellipse(8, 21, 1.4, 1.4, hx("#ffd04a"))                  # 能量豆
    cv.ellipse(28, 16, 2.2, 2.2, hx("#ffd860")); cv.set(29, 15, hx("#1a1a22")); cv.set(31, 16, hx("#ff9a30")); cv.set(28, 13, hx("#f0b830"))   # 豆豆（黃色小雞：眼睛、橘色尖嘴、呆毛；2026-11-13 使用者選的方案 B）
    for gx, gc in ((17, "#ff6a6a"), (36, "#5aa8ff")):           # 兩隻小幽靈（水滴形）
        cv.ellipse(gx, 16, 2, 1.8, hx(gc)); cv.set(gx + 2, 17, hx(gc)); cv.set(gx + 3, 17, hx(gc)); cv.set(gx - 1, 16, hx("#ffffff")); cv.set(gx + 1, 16, hx("#ffffff"))
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_hockey():
    """空氣曲棍球（64×40，畫 scale 2＝4×2.5 格）：亮藍色機身的長桌，白色檯面上滿是出風小孔，中線紅色、兩端各一個球門，
    左邊藍色握把、右邊紅色握把，中間一顆黑色圓盤，四隻桌腳。"""
    cv = Canvas(64, 40)
    body = hx("#2a5aa8")
    cv.rect(0, 4, 63, 31, body); cv.hline(0, 63, 4, shade(body, 1.35)); cv.rect(0, 30, 63, 31, shade(body, .7))   # 機身（外框）
    ice = hx("#eef6fa")
    cv.rect(3, 7, 60, 28, ice)
    for y in range(9, 28, 3):                                     # 出風小孔
        for x in range(5 + (y // 3) % 2, 60, 3): cv.set(x, y, hx("#c8dce6"))
    cv.vline(31, 7, 28, hx("#e04848")); cv.vline(32, 7, 28, hx("#e04848"))   # 中線
    for k in range(16):
        cv.set(round(31.5 + 4.5 * math.cos(k * math.pi / 8)), round(17.5 + 4.5 * math.sin(k * math.pi / 8)), hx("#e04848"))   # 中圈
    cv.rect(3, 13, 4, 22, hx("#1a1a22")); cv.rect(59, 13, 60, 22, hx("#1a1a22"))   # 兩端球門
    for x in (8, 54): cv.vline(x, 11, 24, hx("#9ab8e8") if x < 32 else hx("#f0a8a8"))   # 球門前的線
    for cx, c in ((14, "#3b78e8"), (49, "#e04848")):              # 握把（圓盤＋中間的握柄）
        cv.ellipse(cx, 17.5, 3.6, 3.6, hx(c)); cv.ellipse(cx, 17.5, 1.6, 1.6, shade(hx(c), 1.35)); cv.set(cx - 1, 15, shade(hx(c), 1.5))
    cv.ellipse(38, 15, 2, 2, hx("#2a2a30")); cv.set(37, 14, hx("#6a6a78"))   # 圓盤
    for x in (2, 58): cv.rect(x, 32, x + 3, 39, shade(body, .6))  # 桌腳
    cv.outline()
    return cv

def table_typing():
    """英文打字競賽：桌上一台鍵盤＋螢幕上的單字。"""
    cv = Canvas(48, 32)
    wood, screen = hx("#5a4a3a"), hx("#141826")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.25))
    cv.rect(12, 6, 35, 14, hx("#2a2e3a")); cv.rect(13, 7, 34, 13, screen)          # 螢幕
    for x in (15, 17, 19, 21, 23): cv.rect(x, 9, x, 11, hx("#7ae8d0"))              # 螢幕上的「字」
    cv.rect(26, 9, 26, 11, hx("#ff5a5a")); cv.rect(28, 9, 31, 11, hx("#5a6a88"))
    kb = hx("#d8d4c8")
    cv.rect(6, 16, 41, 24, shade(kb, .7)); cv.rect(7, 17, 40, 23, kb)                # 鍵盤
    for y in (18, 20):
        for x in range(9, 39, 3): cv.rect(x, y, x + 1, y, shade(kb, .78))
    cv.rect(15, 22, 32, 22, shade(kb, .78))                                           # 空白鍵
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_zhtyping():
    """中文打字競賽：同英打的桌子，螢幕上換成兩個「方塊字」、桌面偏紅褐色。"""
    cv = Canvas(48, 32)
    wood, screen = hx("#6a403a"), hx("#141826")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.25))
    cv.rect(12, 6, 35, 14, hx("#2a2e3a")); cv.rect(13, 7, 34, 13, screen)          # 螢幕
    for x0, col in ((16, "#f0d070"), (24, "#7ae8d0")):                               # 螢幕上兩個方塊字（外框＋十字）
        cv.rect(x0, 8, x0 + 5, 8, hx(col)); cv.rect(x0, 12, x0 + 5, 12, hx(col))
        cv.rect(x0, 8, x0, 12, hx(col)); cv.rect(x0 + 5, 8, x0 + 5, 12, hx(col))
        cv.rect(x0 + 2, 9, x0 + 2, 11, hx(col)); cv.rect(x0 + 1, 10, x0 + 4, 10, hx(col))
    cv.rect(31, 9, 31, 12, hx("#ff5a5a"))                                            # 游標
    kb = hx("#d8d4c8")
    cv.rect(6, 16, 41, 24, shade(kb, .7)); cv.rect(7, 17, 40, 23, kb)                # 鍵盤
    for y in (18, 20):
        for x in range(9, 39, 3): cv.rect(x, y, x + 1, y, shade(kb, .78))
    cv.rect(15, 22, 32, 22, shade(kb, .78))                                           # 空白鍵
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_mage():
    """見習驅魔師：深色桌面（有桌腳），中間一本皮革封面的書（金色十字），右邊一瓶聖水，左邊一隻白色小幽靈（有臉）。"""
    cv = Canvas(48, 32)
    wood = hx("#3a2a4a")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.35))
    cv.rect(2, 6, 45, 25, hx("#2a2038"))
    leather = hx("#7a4a2a")                                                                                             # 皮書（中間）
    cv.rect(16, 9, 30, 22, leather); cv.rect(16, 9, 18, 22, shade(leather, .7)); cv.rect(30, 9, 30, 22, shade(leather, .7))   # 書背與書緣
    cv.rect(19, 10, 29, 10, shade(leather, 1.3)); cv.rect(19, 21, 29, 21, shade(leather, .8))                           # 封面高光與下緣
    gold = hx("#e8c040")
    cv.rect(23, 12, 24, 19, gold); cv.rect(21, 14, 26, 15, gold)                                                        # 封面的金色十字
    gh = hx("#eef0ff")                                                                                                  # 小幽靈（左邊）
    cv.ellipse(8.5, 13.5, 4.5, 5, gh); cv.rect(4, 14, 13, 19, gh)
    for x in (4, 7, 10): cv.rect(x, 20, x + 1, 21, gh)                                                                  # 下擺鋸齒
    cv.rect(6, 12, 7, 13, hx("#20204a")); cv.rect(10, 12, 11, 13, hx("#20204a")); cv.rect(8, 16, 9, 16, hx("#20204a")) # 臉：眼睛與嘴
    glass = hx("#c8e4f0")                                                                                               # 聖水瓶（右邊）：瓶身、藍白色的水、軟木塞、瓶上的小十字
    cv.rect(36, 12, 42, 22, glass); cv.rect(37, 9, 41, 11, glass); cv.rect(38, 7, 40, 8, hx("#9a6a3a"))
    cv.rect(37, 16, 41, 21, hx("#6ab8ff")); cv.rect(37, 16, 41, 16, hx("#d8f0ff"))
    cv.rect(39, 17, 39, 20, hx("#ffffff")); cv.rect(38, 18, 40, 18, hx("#ffffff"))
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))                                 # 桌腳
    cv.outline()
    return cv

def table_blokus():
    """Blokus：深藍桌面（有桌腳），桌上散著藍／黃／紅／綠四色的方塊（每格 3×3 像素，有亮邊與暗邊）。"""
    cv = Canvas(48, 32)
    wood = hx("#3a4260")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.3))
    cv.rect(2, 6, 45, 25, hx("#1c2236"))
    def piece(ox, oy, col, cells):
        c = hx(col)
        for cx, cy in cells:
            x, y = ox + cx * 4, oy + cy * 4
            cv.rect(x, y, x + 3, y + 3, c); cv.hline(x, x + 3, y, shade(c, 1.35)); cv.vline(x, y, y + 3, shade(c, 1.35)); cv.hline(x, x + 3, y + 3, shade(c, .7)); cv.vline(x + 3, y, y + 3, shade(c, .7))
    piece(5, 9, "#3b78e8", [(0, 0), (0, 1), (0, 2), (1, 2)])             # 藍 L
    piece(14, 8, "#f0c020", [(0, 0), (1, 0), (1, 1), (2, 1)])            # 黃 Z
    piece(28, 9, "#e04848", [(0, 0), (1, 0), (2, 0), (1, 1)])            # 紅 T
    piece(36, 13, "#3cb45a", [(0, 0), (1, 0), (0, 1), (1, 1)])           # 綠 O
    piece(18, 16, "#3b78e8", [(0, 0), (1, 0), (1, 1)])                   # 藍 V3
    piece(28, 17, "#f0c020", [(0, 0), (0, 1)])                           # 黃 I2
    piece(6, 20, "#e04848", [(0, 0)])                                    # 紅 單格
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_trigon():
    """Blokus Trigon：深藍桌面（有桌腳），桌上一片三角形拼成的色塊（藍／黃／紅／綠四色，每個三角形有亮邊與暗邊）。"""
    cv = Canvas(48, 32)
    wood = hx("#3a4260")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.3))
    cv.rect(2, 6, 45, 25, hx("#1c2236"))
    def tri(cx, y, h, col, up):
        c = hx(col)
        for r in range(h):
            w = r if up else (h - 1 - r)
            cv.rect(cx - w, y + r, cx + w, y + r, c)
        for r in range(h):   # 邊：左邊亮、右邊暗
            w = r if up else (h - 1 - r)
            cv.set(cx - w, y + r, shade(c, 1.35)); cv.set(cx + w, y + r, shade(c, .7))
    h = 6
    row1 = [(9, "#3b78e8", True), (15, "#f0c020", False), (21, "#e04848", True), (27, "#3cb45a", False), (33, "#3b78e8", True), (39, "#f0c020", False)]
    row2 = [(6, "#e04848", False), (12, "#3cb45a", True), (18, "#3b78e8", False), (24, "#f0c020", True), (30, "#e04848", False), (36, "#3cb45a", True)]
    for cx, col, up in row1: tri(cx, 8, h, col, up)
    for cx, col, up in row2: tri(cx, 15, h, col, up)
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

def table_intel():
    """秘藥情報戰：桌上幾封蠟封密函（黃／藍／黑）和一瓶秘藥。"""
    cv = Canvas(48, 32)
    wood = hx("#4a3a5a")
    cv.rect(0, 4, 47, 27, wood); cv.rect(0, 4, 47, 5, shade(wood, 1.3))
    cv.rect(2, 6, 45, 25, hx("#3a2e48"))
    paper = hx("#efe4c8")
    for x, y, seal in ((5, 9, "#e8b820"), (15, 14, "#2f66d8"), (25, 8, "#2a2238")):   # 密函＋蠟封
        cv.rect(x, y, x + 9, y + 6, paper); cv.hline(x, x + 9, y, shade(paper, .8))
        cv.set(x + 4, y + 2, shade(paper, .75)); cv.set(x + 5, y + 2, shade(paper, .75))
        cv.ellipse(x + 4.5, y + 4, 1.6, 1.6, hx(seal))
    cv.rect(37, 9, 39, 11, hx("#c8c0d8"))                                              # 秘藥瓶：瓶頸
    cv.ellipse(38, 16, 4, 4.5, hx("#9a5ad8")); cv.ellipse(37, 15, 1.4, 1.6, hx("#e0c8ff"))
    cv.rect(37, 7, 39, 8, hx("#8a5a34"))                                                # 瓶塞
    cv.rect(2, 26, 5, 31, shade(wood, .75)); cv.rect(42, 26, 45, 31, shade(wood, .75))
    cv.outline()
    return cv

# 街機外殼的配色（第 k 台）：主色、側板暗色
ARCADE_COLORS = ["#d84a4a", "#3b78e8", "#3cb45a", "#9a5ad8"]

def arcade_cabinet(col):
    """俄羅斯方塊街機（32×48，畫 scale 2＝2×3 格）：老街機造型——上方發光招牌、黑框螢幕裡有掉落中的方塊、
    斜面操作台（搖桿＋按鈕）、下方投幣口。4 台造型一樣，只換外殼主色。"""
    cv = Canvas(32, 48)
    c = hx(col); dark = shade(c, .62); lite = shade(c, 1.3)
    cv.rect(2, 0, 29, 47, c)                                   # 外殼
    cv.rect(2, 0, 4, 47, dark); cv.rect(27, 0, 29, 47, dark)   # 側板
    cv.rect(5, 1, 26, 7, hx("#fff0b0")); cv.hline(5, 26, 1, hx("#fffbe0")); cv.hline(5, 26, 7, hx("#e8c060"))   # 招牌（發光）
    for k, bc in enumerate(["#e04848", "#f0c020", "#3cb45a", "#3b78e8", "#9a5ad8"]):   # 招牌上一排小方塊
        x = 7 + k * 4; cv.rect(x, 3, x + 2, 5, hx(bc))
    cv.rect(4, 8, 27, 9, dark)                                 # 招牌下緣
    cv.rect(5, 10, 26, 24, hx("#1a1a22"))                      # 螢幕框
    cv.rect(7, 11, 24, 23, hx("#0c1830"))                      # 螢幕
    def blk(x, y, bc):
        b = hx(bc); cv.rect(x, y, x + 1, y + 1, b); cv.set(x, y, shade(b, 1.4))
    for x, y, bc in [(8, 21, "#3cb45a"), (10, 21, "#3cb45a"), (12, 21, "#e04848"), (16, 21, "#3b78e8"), (18, 21, "#3b78e8"), (20, 21, "#f0c020"), (22, 21, "#f0c020"),
                     (8, 19, "#9a5ad8"), (10, 19, "#3cb45a"), (18, 19, "#3b78e8"), (22, 19, "#f0c020"), (12, 19, "#e04848"),
                     (14, 13, "#40c8e0"), (14, 15, "#40c8e0"), (16, 15, "#40c8e0"), (16, 13, "#40c8e0")]:
        blk(x, y, bc)
    cv.hline(7, 24, 11, hx("#22304c"))                         # 螢幕反光
    cv.rect(3, 25, 28, 30, lite); cv.hline(3, 28, 25, shade(c, 1.5)); cv.hline(3, 28, 30, dark)   # 操作台（斜面）
    cv.rect(8, 27, 9, 29, hx("#2a2a30")); cv.rect(7, 25, 10, 27, hx("#e83a3a")); cv.set(8, 25, hx("#ff9a9a"))   # 搖桿
    for x, bc in [(15, "#f0c020"), (19, "#3b78e8"), (23, "#3cb45a")]:
        cv.rect(x, 27, x + 2, 28, hx(bc)); cv.hline(x, x + 2, 27, shade(hx(bc), 1.4))   # 按鈕
    cv.rect(5, 32, 26, 46, shade(c, .85))                      # 下半身
    cv.rect(12, 35, 19, 41, hx("#2a2a30")); cv.rect(13, 36, 14, 40, hx("#e8a030")); cv.rect(17, 36, 18, 40, hx("#e8a030"))   # 投幣口
    cv.rect(2, 46, 29, 47, dark)
    cv.outline()
    return cv

def claw_machine():
    """夾娃娃機（48×56，畫 scale 2＝3×3.5 格）：粉紅外殼與發光招牌、玻璃櫃裡堆著各色玩偶、頂端軌道垂下一支爪子，
    下方操作台（搖桿＋大按鈕）、投幣口與右下角的取物口。目前只是外觀（不能互動）。"""
    cv = Canvas(48, 56)
    c = hx("#e8648c"); dark, lite = shade(c, .62), shade(c, 1.3)
    cv.rect(1, 0, 46, 55, c)                                           # 外殼
    cv.rect(1, 0, 3, 55, dark); cv.rect(44, 0, 46, 55, dark)           # 側板
    cv.rect(4, 1, 43, 8, hx("#fff0b0")); cv.hline(4, 43, 1, hx("#fffbe0")); cv.hline(4, 43, 8, hx("#e8c060"))   # 招牌（發光）
    for k, bc in enumerate(["#e04848", "#f0c020", "#3cb45a", "#3b78e8", "#9a5ad8", "#e04848", "#f0c020"]):
        cv.ellipse(8 + k * 5.2, 5, 1.8, 1.8, hx(bc))                   # 招牌上一排彩球
    cv.rect(4, 9, 43, 10, dark)                                        # 招牌下緣
    cv.rect(4, 11, 43, 38, hx("#1a1a22"))                              # 玻璃框
    cv.rect(6, 12, 41, 37, hx("#bfe3f0"))                              # 玻璃（淺藍）
    cv.rect(6, 12, 41, 14, hx("#dff3f9")); cv.vline(8, 14, 36, hx("#e8f7fb")); cv.vline(9, 18, 30, hx("#e8f7fb"))   # 反光
    cv.hline(6, 41, 13, hx("#7a808c")); cv.rect(22, 11, 25, 14, hx("#5a606c"))   # 頂端軌道與滑車
    cv.vline(23, 14, 20, hx("#5a606c")); cv.vline(24, 14, 20, hx("#5a606c"))      # 吊線
    cv.rect(21, 21, 26, 22, hx("#8a909c"))                                        # 爪座
    for x0, x1 in ((19, 21), (26, 28)): cv.vline(x0, 22, 27, hx("#8a909c")); cv.set(x1, 27, hx("#8a909c"))   # 兩側爪子
    cv.set(20, 28, hx("#8a909c")); cv.set(27, 28, hx("#8a909c"))
    for cx, cy, r, bc in ((10, 33, 3.2, "#f0c020"), (16, 34, 3, "#3b78e8"), (22, 33, 3.4, "#e84848"), (29, 34, 3, "#3cb45a"),
                          (35, 33, 3.2, "#9a5ad8"), (13, 29, 2.6, "#ff9ad0"), (32, 29, 2.6, "#40c8e0"), (38, 35, 2.6, "#f0c020"), (7, 35, 2.4, "#e84848")):
        b = hx(bc); cv.ellipse(cx, cy, r, r, b); cv.set(int(cx) - 1, int(cy) - 1, shade(b, 1.4))   # 玩偶（圓滾滾的一團）
        cv.set(int(cx) - 1, int(cy), hx("#1a1a22")); cv.set(int(cx) + 1, int(cy), hx("#1a1a22"))   # 眼睛
    cv.rect(4, 39, 43, 44, lite); cv.hline(4, 43, 39, shade(c, 1.5)); cv.hline(4, 43, 44, dark)   # 操作台（斜面）
    cv.rect(11, 41, 12, 44, hx("#2a2a30")); cv.rect(9, 39, 14, 41, hx("#3b78e8")); cv.set(10, 39, hx("#9ac0ff"))   # 搖桿
    cv.ellipse(30, 42, 3, 2, hx("#e83a3a")); cv.set(29, 41, hx("#ff9a9a"))                                         # 大按鈕
    cv.rect(35, 40, 40, 43, hx("#2a2a30")); cv.rect(36, 41, 39, 42, hx("#e8a030"))                                 # 投幣口
    cv.rect(4, 45, 43, 54, shade(c, .85))                              # 下半身
    cv.rect(26, 46, 41, 53, hx("#1a1a22")); cv.rect(27, 47, 40, 52, hx("#0c0c12")); cv.hline(26, 41, 46, hx("#5a606c"))   # 取物口
    cv.rect(1, 54, 46, 55, dark)
    cv.outline()
    return cv

def gacha_machine():
    """扭蛋機（32×48，畫 scale 2＝2×3 格）：上方透明圓罩裡裝滿彩色扭蛋、紅色機身中間一個黃色轉鈕，下方出蛋口。目前只是外觀（不能互動）。"""
    cv = Canvas(32, 48)
    cv.rect(4, 36, 27, 46, hx("#5a606c")); cv.rect(4, 36, 27, 37, hx("#7a808c"))     # 底座
    cv.ellipse(15.5, 13, 13, 13, hx("#bfe3f0")); cv.ellipse(15.5, 13, 11, 11, hx("#d4eef7"))   # 圓罩（外圈＋內層）
    for cx, cy, bc in ((9, 17, "#e84848"), (15, 19, "#f0c020"), (21, 17, "#3b78e8"), (12, 12, "#3cb45a"), (19, 12, "#ff9ad0"),
                       (8, 11, "#9a5ad8"), (23, 11, "#e84848"), (15, 6, "#40c8e0"), (11, 7, "#f0c020"), (20, 7, "#3cb45a")):
        b = hx(bc); cv.ellipse(cx, cy, 3, 3, b); cv.hline(int(cx) - 2, int(cx) + 2, int(cy), shade(b, .78)); cv.set(int(cx) - 1, int(cy) - 2, shade(b, 1.5))   # 扭蛋（上下殼的接縫＋高光）
    cv.set(8, 6, hx("#ffffff")); cv.set(9, 5, hx("#ffffff")); cv.set(10, 4, hx("#ffffff"))   # 圓罩反光
    red = hx("#d83a3a")
    cv.rect(5, 24, 26, 35, red); cv.rect(5, 24, 6, 35, shade(red, .7)); cv.rect(25, 24, 26, 35, shade(red, .7)); cv.hline(5, 26, 24, shade(red, 1.35))   # 機身
    cv.rect(4, 22, 27, 24, shade(red, .85))                                          # 圓罩底環
    cv.ellipse(15.5, 29, 4.5, 4.5, hx("#f0c020")); cv.rect(14, 26, 17, 32, hx("#d8a010")); cv.rect(15, 26, 16, 32, hx("#f8dc60"))   # 轉鈕（黃）
    cv.rect(9, 33, 22, 35, shade(red, .55)); cv.rect(11, 33, 20, 34, hx("#14141a"))   # 出蛋口
    cv.rect(6, 37, 25, 38, hx("#3a3e48"))
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

def _mat_egg(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 4.5, 5.5, c); cv.ellipse(6.5, 6.5, 1.4, 2, shade(c, 1.12)); cv.outline(); return cv
def _mat_gel(c):
    cv = Canvas(16, 16); cv.ellipse(8, 10, 6, 4, c); cv.ellipse(8, 7, 4, 3.5, c); cv.ellipse(6, 6, 1.5, 1.2, shade(c, 1.45))
    cv.set(10, 10, shade(c, .75)); cv.outline(); return cv
def _mat_fang(c):
    cv = Canvas(16, 16)
    for i in range(9): cv.rect(6 + i // 3, 3 + i, 9 - i // 4, 3 + i, c)
    cv.vline(7, 4, 9, shade(c, 1.2)); cv.rect(5, 2, 10, 3, shade(c, .8)); cv.outline(); return cv
def _mat_felt(c):
    cv = Canvas(16, 16); cv.rect(2, 4, 13, 11, c); cv.rect(2, 4, 13, 5, shade(c, 1.15))
    for x in range(3, 13, 3): cv.set(x, 8, shade(c, .85)); cv.set(x + 1, 10, shade(c, .85))
    cv.outline(); return cv

MATERIAL_ICONS.update(
    egg=(_mat_egg, "#f4e8d0"), slime_gel=(_mat_gel, "#6ad08a"), rabbit_fur=(_mat_fluff, "#e0c8a8"),
    dragon_scale=(_mat_scale, "#c84a4a"), dragon_fang=(_mat_fang, "#f0ead8"),
    felt=(_mat_felt, "#c8a888"), dragon_plate=(_mat_bar, "#a8404a"),
)

MATERIAL_ICONS.update(
    petal=(_mat_petal, "#f08ab8"), bark=(_mat_bark, "#8a5e3a"), charcoal=(_mat_chunk, "#3a3a40"), sand=(_mat_sand, "#e8d49a"),
    sulfur=(_mat_crystal, "#e8e03a"), ice=(_mat_cube, "#bfe6f8"), moonstone=(_mat_chunk, "#b8c0f0"), iron_ore=(_mat_ore, "#d88a4a"),
    frog_skin=(_mat_skin, "#6ab04a"), pearl=(_mat_pearl, "#f4f0ec"),
    brick=(_mat_brick, "#c4684a"), paper=(_mat_paper, "#f0ead8"), iron_ingot=(_mat_bar, "#6a7480"), leather=(_mat_leather, "#9a6a40"),
)

def _mat_bone(c):
    cv = Canvas(16, 16)
    for i in range(9): cv.rect(3 + i, 11 - i, 4 + i, 12 - i, c)
    for x, y in ((2, 11), (4, 13), (11, 2), (13, 4)): cv.ellipse(x + 1, y + 1, 1.6, 1.6, c)
    cv.set(6, 9, shade(c, 1.3)); cv.outline(); return cv
def _mat_horn(c):
    cv = Canvas(16, 16)
    for i in range(10): cv.rect(4 + i // 2, 12 - i, 8 + i // 2 - i // 3, 12 - i, c)
    cv.rect(3, 12, 9, 13, shade(c, .75)); cv.vline(6, 5, 11, shade(c, 1.25)); cv.outline(); return cv
def _mat_wing(c):
    cv = Canvas(16, 16)
    for i in range(4): cv.ellipse(4 + i * 3, 9 + (i % 2) * 2, 2.6, 4.5 - i * .3, c)
    cv.hline(2, 14, 5, shade(c, .6)); cv.set(4, 6, shade(c, 1.3)); cv.outline(); return cv
def _mat_ear(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 3, 6, c); cv.ellipse(8, 10, 1.4, 3.6, shade(c, 1.25)); cv.set(7, 5, shade(c, 1.4)); cv.outline(); return cv
def _mat_meat(c):
    cv = Canvas(16, 16); cv.ellipse(8, 9, 6, 4.5, c); cv.ellipse(6, 8, 2, 1.4, shade(c, 1.3)); cv.set(10, 10, shade(c, .7)); cv.set(11, 8, hx("#6a8a3a")); cv.outline(); return cv
def _mat_core(c):
    cv = Canvas(16, 16); cv.ellipse(8, 8, 5.5, 5.5, shade(c, .7)); cv.ellipse(8, 8, 4, 4, c); cv.ellipse(7, 7, 1.6, 1.6, shade(c, 1.5))
    cv.hline(2, 4, 8, shade(c, .7)); cv.hline(12, 14, 8, shade(c, .7)); cv.outline(); return cv
def _mat_bundle(c):
    cv = Canvas(16, 16); cv.rect(4, 4, 11, 12, c); cv.rect(4, 4, 11, 5, shade(c, 1.25)); cv.rect(4, 8, 11, 8, shade(c, .6)); cv.rect(7, 3, 8, 13, shade(c, .7)); cv.outline(); return cv

MATERIAL_ICONS.update(
    goblin_ear=(_mat_ear, "#6ab04a"), imp_horn=(_mat_horn, "#a8a0d8"), rotten_flesh=(_mat_meat, "#8a9a5a"), bone=(_mat_bone, "#ece4cc"),
    antler=(_mat_horn, "#b88a5a"), tusk=(_mat_fang, "#e8dcc0"), hide=(_mat_leather, "#7a5a3a"), bear_claw=(_mat_fang, "#d8d0c4"),
    bat_wing=(_mat_wing, "#6a5a8a"), demon_horn=(_mat_horn, "#c83a3a"), golem_core=(_mat_core, "#7ad0e8"),
    thick_leather=(_mat_leather, "#6a4a2a"), bone_beam=(_mat_bar, "#d8cfb0"), bat_silk=(_mat_cloth, "#7a5a9a"), demon_steel=(_mat_bar, "#8a2a3a"),
    golem_engine=(_mat_gear, "#58a8c8"), compost=(_mat_bundle, "#6a5a3a"), polished_tusk=(_mat_fang, "#fff4dc"), polished_antler=(_mat_horn, "#d8b078"),
    imp_charm=(_mat_bundle, "#9a6ad8"), claw_charm=(_mat_bundle, "#c8b090"),
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

def rabbit_rug():   # 兔毛小地毯
    c = hx("#e0c8a8"); cv = Canvas(16, 12)
    cv.ellipse(8, 6, 7, 4.5, c); cv.ellipse(8, 6, 5, 3, shade(c, 1.12))
    for x in (3, 6, 9, 12): cv.set(x, 10, shade(c, .8))
    cv.outline(); return cv

def jelly_lamp():   # 果凍燈：玻璃罩裡一團發光的凝膠
    cv = Canvas(16, 24)
    cv.rect(4, 20, 11, 22, hx("#55525e")); cv.rect(5, 6, 10, 19, hx("#bfe8f0"))
    cv.ellipse(7.5, 14, 2.5, 3.5, hx("#6ad08a")); cv.ellipse(8.5, 9.5, 1.6, 1.8, hx("#9af0b0")); cv.set(6, 8, hx("#ffffff"))
    cv.rect(5, 4, 10, 5, hx("#55525e")); cv.outline(); return cv

def slime_sofa():   # 彈彈沙發：史萊姆凝膠坐墊
    g = hx("#6ad08a"); w = hx("#8a5a34"); cv = Canvas(16, 15)
    cv.rect(2, 3, 13, 6, shade(g, .9)); cv.rect(2, 7, 13, 10, g); cv.ellipse(5, 8, 1.5, 1, shade(g, 1.3)); cv.ellipse(10, 8, 1.5, 1, shade(g, 1.3))
    cv.rect(1, 6, 2, 11, w); cv.rect(13, 6, 14, 11, w); cv.rect(2, 11, 13, 12, shade(w, .8)); cv.rect(3, 13, 4, 13, shade(w, .6)); cv.rect(11, 13, 12, 13, shade(w, .6))
    cv.outline(); return cv

def egg_nest():   # 鳥巢擺飾：樹皮編的窩裡有兩顆蛋
    b = hx("#8a5e3a"); cv = Canvas(16, 14)
    cv.ellipse(8, 9, 6.5, 3.5, b); cv.hline(3, 12, 8, shade(b, 1.25)); cv.hline(4, 11, 11, shade(b, .75))
    cv.ellipse(6.5, 6.5, 2, 2.5, hx("#f4e8d0")); cv.ellipse(9.5, 6.5, 2, 2.5, hx("#e8dcc0")); cv.set(6, 5, hx("#ffffff"))
    cv.set(12, 6, hx("#e8c070")); cv.set(13, 5, hx("#e8c070"))   # 一根羽毛
    cv.outline(); return cv

def park_bench():   # 長椅：公園那種木長椅，鐵腳
    w = hx("#b8864e"); iron = hx("#4a4e58"); cv = Canvas(16, 16)
    cv.rect(1, 3, 14, 4, w); cv.rect(1, 6, 14, 7, w); cv.hline(1, 14, 3, shade(w, 1.25)); cv.hline(1, 14, 6, shade(w, 1.25))   # 椅背兩條板
    cv.rect(1, 4, 2, 11, iron); cv.rect(13, 4, 14, 11, iron)                                                                   # 椅背立柱（兼扶手）
    cv.rect(0, 9, 15, 11, w); cv.hline(0, 15, 9, shade(w, 1.3)); cv.hline(0, 15, 11, shade(w, .7))                             # 椅面
    cv.rect(2, 12, 3, 14, iron); cv.rect(12, 12, 13, 14, iron)                                                                 # 椅腳
    cv.outline(); return cv

def beanbag():   # 懶骨頭：圓滾滾、頂端凹下去的坐墊
    c = hx("#e8648c"); cv = Canvas(16, 14)
    cv.ellipse(8, 8, 7, 5, c); cv.ellipse(8, 5.5, 4.5, 2.4, shade(c, .8))   # 本體與頂端的凹陷
    cv.ellipse(5, 8, 1.6, 1.2, shade(c, 1.3)); cv.set(11, 10, shade(c, .75)); cv.hline(4, 12, 12, shade(c, .7))
    cv.outline(); return cv

def wardrobe():   # 衣櫃：深色木頭雙開門，門上兩個把手
    w = hx("#7a5230"); cv = Canvas(16, 24)
    cv.rect(2, 1, 13, 22, w); cv.rect(2, 1, 13, 2, shade(w, 1.3)); cv.rect(1, 0, 14, 1, shade(w, 1.15))   # 櫃身與頂板
    cv.rect(3, 3, 7, 20, shade(w, 1.1)); cv.rect(8, 3, 12, 20, shade(w, 1.1)); cv.vline(7, 3, 20, shade(w, .6))   # 兩扇門
    for x0 in (3, 8): cv.rect(x0 + 1, 5, x0 + 3, 9, shade(w, .92)); cv.rect(x0 + 1, 12, x0 + 3, 18, shade(w, .92))   # 門板的凹格
    cv.set(6, 11, hx("#e8c070")); cv.set(8, 11, hx("#e8c070"))   # 把手
    cv.rect(3, 22, 4, 23, shade(w, .6)); cv.rect(11, 22, 12, 23, shade(w, .6))   # 櫃腳
    cv.outline(); return cv

def coffee_table():   # 茶几：矮矮的圓木桌，上面一杯茶和一本書
    w = hx("#c89a5a"); cv = Canvas(16, 14)
    cv.ellipse(8, 6, 7, 3.5, shade(w, 1.1)); cv.ellipse(8, 5.5, 5.5, 2.4, shade(w, 1.25))   # 桌面
    cv.rect(7, 9, 8, 12, shade(w, .8)); cv.rect(4, 12, 11, 12, shade(w, .65))                 # 桌腳與底座
    cv.rect(4, 3, 7, 5, hx("#6a8ac8")); cv.hline(4, 7, 3, hx("#9ab8f0"))                      # 一本書
    cv.rect(10, 2, 12, 5, hx("#f4f0e4")); cv.hline(10, 12, 2, hx("#8a5a34")); cv.set(13, 3, hx("#e8e4d8"))   # 茶杯
    cv.outline(); return cv

def piano():   # 鋼琴：黑色直立式鋼琴，前面一排黑白琴鍵
    cv = Canvas(16, 18); k = hx("#22222a")
    cv.rect(1, 1, 14, 11, k); cv.rect(1, 1, 14, 2, shade(k, 1.8)); cv.rect(3, 4, 12, 8, shade(k, 1.25)); cv.rect(5, 4, 10, 7, hx("#f0e6c8")); cv.hline(6, 9, 5, hx("#6a6a72")); cv.hline(6, 9, 6, hx("#6a6a72"))   # 琴身與譜架（上面一張樂譜）
    cv.rect(0, 12, 15, 13, shade(k, 1.4))                                                                                     # 琴鍵蓋
    cv.rect(1, 13, 14, 14, hx("#f4f0e4"))
    for x in (2, 4, 7, 9, 11): cv.rect(x, 13, x, 14, k)                                                                       # 黑鍵
    cv.rect(2, 15, 3, 17, shade(k, .8)); cv.rect(12, 15, 13, 17, shade(k, .8))                                                # 琴腳
    cv.outline(); return cv

def fireplace():   # 壁爐：磚砌的壁爐，爐膛裡燒著火，上面一塊木頭爐台
    b = hx("#b4583e"); cv = Canvas(16, 22)
    cv.rect(1, 2, 14, 21, b)
    for y in range(3, 21, 3):
        cv.hline(1, 14, y, shade(b, .7))
        for x in range(2 + (y // 3 % 2) * 3, 14, 6): cv.vline(x, y - 2 if y > 3 else y, y, shade(b, .7))
    cv.rect(0, 0, 15, 2, hx("#8a5a34")); cv.hline(0, 15, 0, hx("#b07a44"))   # 爐台
    cv.rect(4, 9, 11, 21, hx("#1c1214"))                                       # 爐膛
    cv.ellipse(7.5, 18, 3.5, 2.6, hx("#e8801a")); cv.ellipse(7.5, 17, 2.2, 3.2, hx("#f8c030")); cv.set(7, 15, hx("#fff0a0")); cv.set(8, 14, hx("#f8c030"))   # 火
    cv.rect(4, 20, 11, 21, hx("#5a4a3a"))                                      # 柴
    cv.outline(); return cv

def floor_mirror():   # 落地鏡：木框的長鏡子，斜斜的反光
    w = hx("#8a5a34"); cv = Canvas(16, 24)
    cv.rect(3, 1, 12, 20, w); cv.rect(4, 2, 11, 19, hx("#bfe3f0"))
    for i in range(5): cv.set(5 + i, 6 - i + 8, hx("#ffffff")); cv.set(6 + i, 6 - i + 8, hx("#e8f7fb"))   # 斜向反光
    cv.hline(4, 11, 2, hx("#dff3f9")); cv.rect(7, 20, 8, 21, shade(w, .8)); cv.rect(4, 22, 11, 22, shade(w, .65))   # 支架與底座
    cv.outline(); return cv

def folding_screen():   # 屏風：木框紙面的三折屏風，畫著遠山與月亮
    w = hx("#8a5a34"); paper = hx("#f0e6c8"); cv = Canvas(16, 24)
    cv.rect(1, 2, 14, 21, w)
    for x0 in (2, 6, 10):
        cv.rect(x0, 3, x0 + 3, 20, paper); cv.hline(x0, x0 + 3, 3, shade(paper, 1.08))
    cv.ellipse(11.5, 7, 1.6, 1.6, hx("#e8c070"))                                                  # 月亮
    for x, y in ((3, 16), (4, 15), (5, 14), (6, 14), (7, 15), (8, 16), (9, 15), (10, 14), (11, 15), (12, 16)): cv.rect(x, y, x, 19, hx("#6a8a7a") if x < 7 else hx("#5a7a6a"))   # 遠山
    cv.rect(1, 21, 14, 22, shade(w, .6)); cv.outline(); return cv

def antler_rack():   # 鹿角掛架：木板底座，頂上一對分岔的鹿角
    a = hx("#d8b078"); w = hx("#8a5a34"); cv = Canvas(16, 24)
    cv.rect(7, 12, 8, 20, w); cv.rect(4, 20, 11, 22, shade(w, .7)); cv.rect(5, 9, 10, 12, shade(w, 1.15)); cv.hline(5, 10, 9, shade(w, 1.35))   # 立柱、底座、頭骨板
    for sx, d in ((6, -1), (9, 1)):   # 左右兩支鹿角：主幹往外上方、分出三叉
        for i in range(7): cv.set(sx + d * (i // 2), 8 - i, a)
        for ox, oy in ((1, 5), (2, 3), (3, 1)): cv.set(sx + d * ox, 8 - oy, a); cv.set(sx + d * (ox + 1), 8 - oy - 1, a)
    cv.set(6, 6, shade(a, 1.3)); cv.outline(); return cv

def hide_rug():   # 獸皮地毯：攤開的獸皮，四肢往外撐
    c = hx("#7a5a3a"); cv = Canvas(16, 13)
    cv.ellipse(8, 6.5, 5.5, 4, c); cv.ellipse(3, 3, 2, 1.6, c); cv.ellipse(13, 3, 2, 1.6, c); cv.ellipse(3, 10, 2, 1.6, c); cv.ellipse(13, 10, 2, 1.6, c)
    cv.ellipse(8, 6.5, 3.4, 2.4, shade(c, 1.18)); cv.set(7, 5, shade(c, 1.4)); cv.set(10, 8, shade(c, .75)); cv.set(5, 8, shade(c, .8))
    cv.outline(); return cv

def bone_bench():   # 骨梁長椅：粗骨梁當椅身與腳，皮革坐墊
    b = hx("#d8cfb0"); lt = hx("#6a4a2a"); cv = Canvas(16, 15)
    cv.rect(1, 6, 14, 8, b); cv.hline(1, 14, 6, shade(b, 1.2)); cv.hline(1, 14, 8, shade(b, .75))   # 骨梁椅身
    cv.rect(2, 4, 13, 5, shade(lt, 1.1)); cv.hline(2, 13, 4, shade(lt, 1.35))                          # 皮革坐墊
    for x in (0, 14): cv.ellipse(x + .5, 7, 1.6, 1.8, b)                                               # 梁端的骨節
    for x in (3, 11): cv.rect(x, 9, x + 1, 13, shade(b, .85)); cv.rect(x - 1, 13, x + 2, 13, shade(b, .6))   # 兩隻骨腳
    cv.outline(); return cv

def demon_candelabra():   # 魔鋼燭台：暗紅魔鋼的三叉燭台，上面飄著硫磺色的火
    m = hx("#8a2a3a"); f = hx("#e8e03a"); cv = Canvas(16, 24)
    cv.rect(7, 12, 8, 20, m); cv.rect(4, 20, 11, 22, shade(m, .75)); cv.rect(6, 19, 9, 20, shade(m, 1.2))   # 柱身與底座
    cv.rect(3, 11, 12, 11, m); cv.vline(3, 8, 11, m); cv.vline(12, 8, 11, m); cv.vline(7, 8, 11, m); cv.vline(8, 8, 11, m)   # 三叉
    for x in (3, 7, 12):   # 燭與火
        cv.rect(x, 6, x + (1 if x == 7 else 0), 8, hx("#f0ead8"))
        cv.ellipse(x + (.5 if x == 7 else 0), 3.5, 1.4, 2.4, f); cv.set(x, 2, hx("#ff9a40")); cv.set(x, 4, hx("#ffffff"))
    cv.outline(); return cv

def bat_screen():   # 蝠翼綢屏風：三折的紫色蝠翼綢，下緣一圈木框
    p = hx("#7a5a9a"); w = hx("#8a5a34"); cv = Canvas(16, 24)
    cv.rect(1, 3, 14, 21, shade(w, .8))
    for k, x0 in enumerate((2, 6, 10)):
        c = p if k % 2 == 0 else shade(p, .85); cv.rect(x0, 4, x0 + 3, 20, c); cv.hline(x0, x0 + 3, 4, shade(c, 1.25))
        cv.set(x0 + 1, 9, hx("#2a1a3a")); cv.set(x0 + 2, 10, hx("#2a1a3a")); cv.set(x0, 11, hx("#2a1a3a")); cv.set(x0 + 3, 11, hx("#2a1a3a")); cv.hline(x0, x0 + 3, 12, hx("#3a2a4a"))   # 蝠翼圖樣
    cv.rect(1, 21, 14, 22, shade(w, .6)); cv.outline(); return cv

def golem_gadget():   # 魔像機關擺飾：玻璃罩裡一個發藍光的魔像核心，兩側嵌著齒輪
    cv = Canvas(16, 24); g = hx("#58a8c8")
    cv.rect(3, 19, 12, 22, hx("#6a7480")); cv.rect(3, 19, 12, 19, hx("#9aa4b0"))   # 底座
    cv.rect(4, 6, 11, 18, hx("#cfe8f0")); cv.hline(4, 11, 6, hx("#ffffff")); cv.rect(3, 4, 12, 5, hx("#55525e"))   # 玻璃罩
    cv.ellipse(7.5, 12, 3.4, 3.4, shade(g, .7)); cv.ellipse(7.5, 12, 2.4, 2.4, hx("#7ad0e8")); cv.set(6, 11, hx("#ffffff"))   # 發光核心
    for x, y in ((5, 8), (10, 16)):   # 小齒輪
        cv.ellipse(x, y, 1.6, 1.6, hx("#a8b0b8")); cv.set(x, y, hx("#55525e"))
    cv.outline(); return cv

def charm_curtain():   # 護符門簾：橫桿上垂下一排串飾——紫色護符、熊爪、布條
    cv = Canvas(16, 24)
    cv.rect(1, 3, 14, 4, hx("#8a5a34")); cv.hline(1, 14, 3, hx("#b07a44")); cv.rect(0, 2, 0, 5, hx("#6a4424")); cv.rect(15, 2, 15, 5, hx("#6a4424"))   # 橫桿
    for k, x in enumerate((3, 6, 9, 12)):
        cv.vline(x, 5, 9 + (k % 2) * 3, hx("#c9b27a"))   # 繩
        y = 10 + (k % 2) * 3
        if k % 2 == 0:
            cv.rect(x - 1, y, x + 1, y + 4, hx("#9a6ad8")); cv.set(x, y + 1, hx("#fff0b0")); cv.set(x - 1, y + 4, shade(hx("#9a6ad8"), .7)); cv.set(x + 1, y + 4, shade(hx("#9a6ad8"), .7))   # 護符
        else:
            for i in range(5): cv.set(x - (i // 3), y + i, hx("#d8d0c4")); cv.set(x - (i // 3) + 1, y + i, hx("#c8b090"))   # 熊爪
    for x in (4, 8, 11): cv.rect(x, 15, x, 21, hx("#d878a0")); cv.set(x, 21, shade(hx("#d878a0"), .7))   # 垂下的布條
    cv.outline(); return cv

def compost_bed():   # 花圃：木框裡一壟深色堆肥土，長出花
    cv = Canvas(16, 16); w = hx("#8a5a34"); soil = hx("#4a3a2a")
    cv.rect(1, 9, 14, 14, w); cv.hline(1, 14, 9, shade(w, 1.25)); cv.rect(2, 10, 13, 12, soil); cv.hline(2, 13, 10, shade(soil, .75))
    for x in (4, 8, 12): cv.vline(x, 6, 9, hx("#4d9e46"))
    for cx, cy, c in ((4, 5, "#f08ab8"), (8, 3, "#f2d14a"), (12, 5, "#e8e4f0")): cv.ellipse(cx, cy, 1.9, 1.9, hx(c)); cv.set(cx, cy, hx("#f2a030"))
    cv.set(5, 11, shade(soil, 1.4)); cv.set(10, 11, shade(soil, 1.4)); cv.outline(); return cv

def dragon_shield():   # 龍鱗盾牌擺飾（立在鐵架上）
    r = hx("#a8404a"); cv = Canvas(16, 24)
    cv.rect(7, 18, 8, 21, hx("#6a7480")); cv.rect(4, 21, 11, 22, hx("#55525e"))
    cv.rect(3, 3, 12, 11, r); cv.rect(4, 12, 11, 14, r); cv.rect(6, 15, 9, 16, r); cv.set(7, 17, r); cv.set(8, 17, r)
    for y in (5, 8, 11): cv.hline(4, 11, y, shade(r, .75))
    cv.vline(7, 4, 15, hx("#d8b050")); cv.set(5, 4, shade(r, 1.4))
    cv.outline(); return cv

def dragon_trophy():   # 龍牙獎盃
    cv = Canvas(16, 24); gold = hx("#e8b83a")
    cv.rect(4, 20, 11, 22, hx("#8a5a34")); cv.rect(6, 17, 9, 19, gold); cv.rect(4, 13, 11, 16, gold); cv.rect(4, 13, 11, 13, shade(gold, 1.2))
    f = hx("#f0ead8")
    for i in range(10): cv.rect(6 + i // 4, 3 + i, 9 - i // 5, 3 + i, f)   # 立起來的龍牙
    cv.vline(7, 4, 10, hx("#ffffff")); cv.set(8, 15, hx("#f4f0ec"))   # 一顆珍珠
    cv.outline(); return cv

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
        # 2026-11-14：新增的預設家具（不用合成）
        dict(id="park_bench",      name="長椅",   w=1, h=1, solid=True, sprite="park_bench.png", use="sit"),
        dict(id="beanbag",         name="懶骨頭", w=1, h=1, solid=True, sprite="beanbag.png", use="sit"),
        dict(id="wardrobe",        name="衣櫃",   w=1, h=1, solid=True, sprite="wardrobe.png"),
        dict(id="coffee_table",    name="茶几",   w=1, h=1, solid=True, sprite="coffee_table.png"),
        dict(id="piano",           name="鋼琴",   w=1, h=1, solid=True, sprite="piano.png"),
        dict(id="fireplace",       name="壁爐",   w=1, h=1, solid=True, sprite="fireplace.png"),
        dict(id="floor_mirror",    name="落地鏡", w=1, h=1, solid=True, sprite="floor_mirror.png"),
        dict(id="folding_screen",  name="屏風",   w=1, h=1, solid=True, sprite="folding_screen.png"),
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
        # 2026-11-09：用新怪物的掉落合成的家具
        dict(id="rabbit_rug",     name="兔毛小地毯", w=1, h=1, solid=False, sprite="rabbit_rug.png", craft=True),
        dict(id="jelly_lamp",     name="果凍燈",   w=1, h=1, solid=True, sprite="jelly_lamp.png", craft=True),
        dict(id="slime_sofa",     name="彈彈沙發", w=1, h=1, solid=True, sprite="slime_sofa.png", use="sit", craft=True),
        dict(id="egg_nest",       name="鳥巢擺飾", w=1, h=1, solid=True, sprite="egg_nest.png", craft=True),
        dict(id="dragon_shield",  name="龍鱗盾牌", w=1, h=1, solid=True, sprite="dragon_shield.png", craft=True),
        dict(id="dragon_trophy",  name="龍牙獎盃", w=1, h=1, solid=True, sprite="dragon_trophy.png", craft=True),
        # 2026-11-14：用新怪物（哥布林、小鬼、骷髏、鹿、野豬、白熊、蝙蝠、小惡魔、魔像、殭屍）的掉落合成的家具
        dict(id="antler_rack",      name="鹿角掛架",   w=1, h=1, solid=True,  sprite="antler_rack.png", craft=True),
        dict(id="hide_rug",         name="獸皮地毯",   w=1, h=1, solid=False, sprite="hide_rug.png", craft=True),
        dict(id="bone_bench",       name="骨梁長椅",   w=1, h=1, solid=True,  sprite="bone_bench.png", use="sit", craft=True),
        dict(id="demon_candelabra", name="魔鋼燭台",   w=1, h=1, solid=True,  sprite="demon_candelabra.png", craft=True),
        dict(id="bat_screen",       name="蝠翼綢屏風", w=1, h=1, solid=True,  sprite="bat_screen.png", craft=True),
        dict(id="golem_gadget",     name="魔像機關擺飾", w=1, h=1, solid=True, sprite="golem_gadget.png", craft=True),
        dict(id="charm_curtain",    name="護符門簾",   w=1, h=1, solid=True,  sprite="charm_curtain.png", craft=True),
        dict(id="compost_bed",      name="花圃",       w=1, h=1, solid=True,  sprite="compost_bed.png", craft=True),
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
    dict(sheet="external/img2pixel/dragon_sheet.png", frames=3, rows=4, fw=191, fh=161, what="飛龍的 4 方向（上飛／朝右／下飛／朝左）× 3 幀（各島不同色靠 tint）"),
    dict(sheet="external/img2pixel/goblin_sheet.png", frames=8, rows=2, fw=32, fh=32, what="小鬼（原哥布林自製素材）的走路 2 方向（朝右／朝左）× 8 幀（雪島白／機械島灰靠 tint）"),
    dict(sheet="external/img2pixel/goblin_folk_sheet.png", frames=9, rows=4, fw=64, fh=64, what="哥布林（LPC folk 頭＋LPC 身體合成）的 4 方向（上／左／下／右）× 9 幀走路（草島／森林島，原色綠）"),
    dict(sheet="external/img2pixel/zombie_sheet.png", frames=9, rows=4, fw=64, fh=64, what="殭屍（LPC）的 4 方向（上／左／下／右）× 9 幀走路（夜光原色／雪島白／機械島灰靠 tint）"),
    dict(sheet="external/img2pixel/skeleton_sheet.png", frames=9, rows=4, fw=64, fh=64, what="骷髏（LPC）的 4 方向（上／左／下／右）× 9 幀走路（夜光島，原色白骨）"),
    dict(sheet="external/img2pixel/bahamut_fly_sheet.png", frames=6, fw=88, fh=59, what="黃金肥龍的飛行 6 幀（草島島主）"),
    dict(sheet="external/img2pixel/snake_queen_sheet.png", frames=4, fw=88, fh=85, what="笨蛋蛇女的 4 幀（夜光島島主）"),
    dict(sheet="external/img2pixel/ultima_weapon_sheet.png", frames=6, fw=88, fh=74, what="蓋老師（究極神兵）的走路 6 幀（熔岩島島主）"),
    dict(sheet="external/img2pixel/alexander_idle_sheet.png", frames=4, fw=88, fh=77, what="壓力山大的待機 4 幀（機械島島主）"),
    # 2026-11-12 素材庫第一批（OpenGameArt LPC；sheet 已裁成只用到的格）：
    dict(sheet="external/img2pixel/deer_sheet.png", frames=4, rows=4, fw=64, fh=96, what="鹿的 4 方向（下／左／右／上）× 4 幀走路（草島）"),
    dict(sheet="external/img2pixel/cat_sheet.png", frames=3, rows=3, fw=32, fh=32, what="貓的 3 方向（上／下／左）× 3 幀走路（和平島；白貓原色，靠 tint 可換色）"),
    dict(sheet="external/img2pixel/dog_sheet.png", frames=3, rows=3, fw=32, fh=32, what="狗的 3 方向（上／下／左）× 3 幀走路（和平島；白狗原色，靠 tint 可換色）"),
    dict(sheet="external/img2pixel/boar_sheet.png", frames=3, rows=4, fw=64, fh=64, what="野豬的 4 方向（上／右／下／左）× 3 幀走路（森林島）"),
    dict(sheet="external/img2pixel/bear_sheet.png", frames=4, rows=4, fw=64, fh=64, what="白熊的 4 方向（下／右／上／左）× 4 幀走路（雪島；原圖三色只取白熊那一區）"),
    dict(sheet="external/img2pixel/bat_sheet.png", frames=4, fw=32, fh=32, what="蝙蝠的正面拍翅 4 幀（夜光島；單列，左右靠鏡像）"),
    dict(sheet="external/img2pixel/imp_sheet.png", frames=4, rows=4, fw=64, fh=64, what="小惡魔的 4 方向（下／上／左／右）× 4 幀走路（熔岩島）"),
    dict(sheet="external/img2pixel/golem_sheet.png", frames=7, rows=3, fw=64, fh=64, what="魔像的 3 方向（下／右／左）× 7 幀走路（機械島；沒有背面，朝上用正面鏡像）"),
    dict(sheet="external/img2pixel/campfire_sheet.png", frames=8, fw=32, fh=32, what="營火 8 幀（世界物件，不是動物：main.js 直接載入，不經 manifest）"),
    dict(sheet="external/img2pixel/fireball_sheet.png", frames=8, fw=64, fh=64, what="飛龍火球的 8 幀（特效投射物，不是動物：main.js 直接載入，不經 manifest）"),
    dict(sheet="external/img2pixel/fireball_burst.png", frames=12, fw=32, fh=32, what="火球命中爆炸的 12 幀（特效，不是動物：main.js 直接載入，不經 manifest）"),
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

# 和平島貓狗花色（2026-11-13 使用者定：黑貓／花貓／橘貓、黑狗／花狗／黃狗各 2 隻，白色的數量不變）。
# 黑／橘／黃用 mobs.json 的 tint 就好（同一張白貓／白狗 sheet 重上色）；花貓（橘黑斑）與花狗（黑斑）
# 是「白底＋斑塊」，平面 tint 做不出斑塊 → 由白貓／白狗 sheet 現場合成專屬 sheet（value noise 長斑塊，
# 只染淺色毛、輪廓／眼睛／鼻子不動）。素材來源與授權跟 cat_sheet／dog_sheet 同一份（同一張圖衍生）。
def pet_variant_sheet(src_name, out_name, patches, fw=32, fh=32, cell=7.0, salt=1):
    """src_name／out_name：external/img2pixel 底下的檔名。patches＝[(RGBA, 佔比), ...]（依 noise 值依序落入）。
    fw/fh＝sheet 的格大小：雜訊用「格內座標」算——每幀的斑塊是同一份；用整張 sheet 座標的話，
    走路換幀會取到完全不同的斑塊分布＝整隻顏色一直閃（實測踩過）。"""
    src = os.path.join(ASSETS, "external", "img2pixel", src_name)
    px = read_png_pixels(src)
    if not px:
        print(f"  ! 貓狗花色 sheet：找不到來源 {src_name}，跳過 {out_name}")
        return
    w, h, pix = px
    def rnd(ix, iy):
        n = (ix * 374761393 + iy * 668265263 + salt * 1274126177) & 0xffffffff
        n = ((n ^ (n >> 13)) * 1274126177) & 0xffffffff
        return ((n ^ (n >> 16)) & 0xffffffff) / 0xffffffff
    def noise(x, y):
        gx, gy = (x % fw) / cell, (y % fh) / cell   # 格內座標：每幀同一份斑塊
        ix, iy = int(gx), int(gy)
        fx, fy = gx - ix, gy - iy
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
        v00, v10, v01, v11 = rnd(ix, iy), rnd(ix + 1, iy), rnd(ix, iy + 1), rnd(ix + 1, iy + 1)
        return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
    new = bytearray(pix)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if not new[i + 3]:
                continue
            l = 0.2126 * new[i] + 0.7152 * new[i + 1] + 0.0722 * new[i + 2]
            if l < 150:   # 只染淺色毛（白毛本體）；輪廓／眼睛／深色細節不動
                continue
            v = noise(x, y); acc = 0.0
            for col, share in patches:
                acc += share
                if v < acc:
                    new[i:i + 3] = bytes(col[:3])
                    break
    write_png(os.path.join(ASSETS, "external", "img2pixel", out_name), w, h,
              lambda x, y: tuple(new[(y * w + x) * 4:(y * w + x) * 4 + 4]))
pet_variant_sheet("cat_sheet.png", "cat_calico_sheet.png", [((224, 150, 62, 255), 0.24), ((42, 38, 46, 255), 0.20)], cell=6.0, salt=10)
pet_variant_sheet("dog_sheet.png", "dog_spotted_sheet.png", [((44, 40, 48, 255), 0.22)], cell=6.0, salt=10)

MOB_MANIFEST = dict(
    scale=2, respawn=30,
    mobs=[
        dict(id="bird",  name="圓喙鳥", sprite="bird.png",  swim=True, speed=42, flee=95, ownerFrac=60,
             line="「圓喙鳥」用圓圓的眼神看著你。"),
        dict(id="sheep", name="波波羊", sprite="sheep.png", speed=30, flee=80, ownerFrac=50,
             line="「波波羊」慢悠悠地嚼著草。"),
        dict(id="frog",  name="大肚蛙", sprite="frog.png",  swim=True, speed=26, flee=70, ownerFrac=60,
             line="「大肚蛙」的眼神飄向遠方。"),
        # 咕咕雞：草島／森林島（4 方向：後／右／前／左，各 3 幀）
        dict(id="chicken", name="咕咕雞", fixed=3, speed=30, flee=80, ownerFrac=100,
             anim=dict(sheet="external/img2pixel/chicken_sheet.png", frames=3, rows=4, fw=32, fh=32,
                       rowDir=["up", "right", "down", "left"], fps=6, scale=0.85),   # scale：畫面約 17×24（人物約 46px 高；2026-11-09 使用者嫌太大，由 1.6 縮小）
             line="「咕咕雞」歪著頭啄了啄地面。"),
        # 史萊姆：所有地形各一種顏色（和平島除外），同一張 sheet 依島調色；3 方向（背／右／前），往左用「右」那一列鏡像
        *[dict(id=f"slime_{isl}", name="史萊姆", fixed=3, speed=22, flee=70, ownerFrac=60,
               anim=dict(sheet="external/img2pixel/slime_sheet.png", frames=3, rows=3, fw=48, fh=48,
                         rowDir=["up", "right", "down"], fps=5, scale=0.65),   # 畫面約 26×21（2026-11-09 由 1.1 縮小）
               tintBase="#ff8080", tint=col,
               line="「史萊姆」果凍般晃了兩下。")
          for isl, col in SLIME_TINTS.items()],
        # 跳跳兔：沙灘島（原色棕）、雪島（白）、機械島（灰）；左／右各有專屬列不鏡像（sheet 第 3 列 2 幀未用到）
        *[dict(id=bid, name="跳跳兔", fixed=3, speed=44, flee=110, ownerFrac=100,
               anim=dict(sheet="external/img2pixel/bunny_sheet.png", frames=4, rows=2, row0=0, fw=48, fh=32,
                         rowDir=["left", "right"], fps=9, scale=0.65),   # 畫面約 31×20（2026-11-09 由 1.1 縮小）
               **({"tint": tint, "tintBase": "#ab7943"} if tint else {}),
               line="「跳跳兔」豎起耳朵，隨時準備蹦走。")
          for bid, tint in [("bunny", None), ("bunny_snow", "#f2f6ff"), ("bunny_machine", "#9aa4b0")]],
        # 哥布林：草島、森林島（都原色綠）。2026-11-11 使用者定換模組：LPC folk 的哥布林頭（放大版）＋ repo 的 LPC
        # 基底身體合成（9 幀 × 4 方向，同殭屍／骷髏做法）；原自製素材改名「小鬼」搬到雪島／機械島（下面）。
        # 反擊型野怪（跟飛龍同一套：被打不逃、追咬；2026-11-09 使用者定），
        # 血量／攻擊力／經驗值＝該地形島主的 1/12（ownerFrac，最低 1）；下面的 post-pass 依 OWNER_BY_TERRAIN 算
        # 素材來源 OpenGameArt「LPC folk」（CC-BY-SA 3.0；哥布林頭 by bluecarrot16／Redshrike／William.Thompsonj）；
        # 畫面約 46×52（scale 1：頭是放大版，略高於人物 46px）
        *[dict(id=gid, name="哥布林", fixed=6, speed=34, flee=85, retaliate=True, ownerFrac=12, noBounce=True,
               anim=dict(sheet="external/img2pixel/goblin_folk_sheet.png", frames=9, rows=4, row0=0, fw=64, fh=64,
                         rowDir=["up", "left", "down", "right"], fps=5, scale=1.0),
               line="「哥布林」敲了敲手裡的長矛，警惕地看著你。")
          for gid in ["goblin_grass", "goblin_forest"]],
        # 小鬼（原「哥布林」自製素材，2026-11-11 使用者定改名搬家）：雪島（白化 tint）、機械島（灰 tint）；設定照舊
        *[dict(id=iid, name="小鬼", fixed=6, speed=34, flee=85, retaliate=True, ownerFrac=12, noBounce=True,
               anim=dict(sheet="external/img2pixel/goblin_sheet.png", frames=8, rows=2, row0=0, fw=32, fh=32,
                         rowDir=["right", "left"], fps=8, scale=1.0),
               **({"tint": tint} if tint else {}),
               line="「小鬼」吱吱叫著，揮舞手裡的長矛。")
          for iid, tint in [("imp_snow", "#dfe9ff"), ("imp_machine", "#9aa4b0")]],
        # 殭屍（LPC；反擊型）：夜光島（原色）、雪島（白）、機械島（灰）；走路 4 方向 × 9 幀；數量走隨機池（不固定）
        # 反擊型但三個比例各給各的（使用者定）：血量 1/5（ownerFrac=5）、攻擊力 1/10（atkFrac=10）、經驗值 1/8（xpFrac=8），都最低 1
        # noBounce：不套用「走動時上下彈」（LPC 本身有走路動畫，再彈會腳離地＝看起來浮起來；2026-11-09 使用者回報）
        # 素材來源 OpenGameArt「LPC zombie」（CC-BY-SA 3.0，BenCreating）；畫面約 47px 高（scale 1：人物約 46px，成人體型）
        *[dict(id=zid, name="殭屍", speed=20, flee=100, retaliate=True, ownerFrac=5, atkFrac=10, xpFrac=8, noBounce=True,
               anim=dict(sheet="external/img2pixel/zombie_sheet.png", frames=9, rows=4, row0=0, fw=64, fh=64,
                         rowDir=["up", "left", "down", "right"], fps=5, scale=1.0),
               **({"tint": tint} if tint else {}),
               line="「殭屍」拖著沉重的腳步，發出低沉的呻吟。")
          for zid, tint in [("zombie_night", None), ("zombie_snow", "#dfe9ff"), ("zombie_machine", "#9aa4b0")]],
        # 骷髏（LPC；反擊型）：夜光島固定 6 隻（fixed；使用者定 2026-11-10）；走路 4 方向 × 9 幀；不套走動彈跳（有真走路動畫）
        # swarm:10（使用者定 2026-11-11）：場上存活骷髏低於 10 隻＝全部自動群攻本地玩家（不用被打、距離不限），
        # 回補到 10 隻以上（擊倒的約 30 秒重生）就脫離；實作在 main.js 的 retaliateStep
        # 反擊型比例 1/12（跟哥布林一樣，使用者定）：血／攻擊／經驗都＝島主（笨蛋蛇女）的 1/12、最低 1（產生器 post-pass 算 hp／atk，
        # main.js 的 mobKillXp 算 XP）→ hp 16（200÷12）、atk 1（爪擊 2÷12 落最低值）、擊倒 XP 2（25÷12 無條件捨去）
        # 素材來源 OpenGameArt「LPC skeleton」（CC-BY-SA 3.0；rhimlock 補上刺擊、動畫本體 by wulax／Johannes Sjölund，
        # 改建自 Redshrike 的 LPC 基底）；畫面約 47px 高（scale 1：人物約 46px）
        dict(id="skeleton_night", name="骷髏", fixed=6, speed=30, flee=110, retaliate=True, ownerFrac=12, noBounce=True, swarm=10,
             anim=dict(sheet="external/img2pixel/skeleton_sheet.png", frames=9, rows=4, row0=0, fw=64, fh=64,
                       rowDir=["up", "left", "down", "right"], fps=5, scale=1.0),
             line="「骷髏」喀啦喀啦地轉過頭來，空洞的眼窩盯著你。"),
        # ---- 2026-11-12 第一批「依等級分素質」的新怪（素材庫：OpenGameArt LPC）----
        # lv＝怪物等級，素質由下面的 post-pass 算（hp＝2×lv、攻擊力＝1+lv÷8、經驗值＝1+lv÷4，都無條件捨去、最低 1）；
        # 各島等級帶＝每島差 10 級：草島 1~10、沙灘 11~20、森林 21~30、雪島 31~40、夜光 41~50、熔岩 51~60、機械 61~70。
        # 舊怪（ownerFrac 那組）維持原值不動；這一組之後加主動怪時沿用同 sheet＋加 aggro（見 docs/notes.md「野外動物」）。
        # 鹿（草島）：被動（道德性怪物），4 方向走路
        dict(id="deer", name="鹿", lv=5, speed=40, flee=120, noBounce=True,
             anim=dict(sheet="external/img2pixel/deer_sheet.png", frames=4, rows=4, fw=64, fh=96,
                       rowDir=["down", "left", "right", "up"], fps=6, scale=0.52),   # 格內實際內容 22×78，畫面約 41px 高（人物約 46px；2026-11-13 使用者定「大隻一點，比雞大」，由 0.4 放大——雞只有約 24px）
             line="「鹿」豎起耳朵看了你一眼，又低頭繼續啃草。"),
        # 貓／狗（和平島）：被動、固定生成，補和平島「島上沒有動物」的空虛感；和平島不得放敵對怪，這兩隻是安全的
        dict(id="cat", name="貓", lv=2, fixed=2, speed=34, flee=60, noBounce=True,
             anim=dict(sheet="external/img2pixel/cat_sheet.png", frames=3, rows=3, fw=32, fh=32,
                       rowDir=["up", "down", "left"], fps=6, scale=0.9),
             line="「貓」瞇著眼，蹭了蹭你的腳邊。"),
        dict(id="dog", name="狗", lv=3, fixed=2, speed=40, flee=60, noBounce=True,
             anim=dict(sheet="external/img2pixel/dog_sheet.png", frames=3, rows=3, fw=32, fh=32,
                       rowDir=["up", "down", "left"], fps=6, scale=0.9),
             line="「狗」開心地搖著尾巴，繞著你轉圈。"),
        # 貓狗花色（2026-11-13 使用者定）：黑貓／花貓／橘貓、黑狗／花狗／黃狗各 2 隻，白色的數量不變；
        # 都是被動小動物（lv 沿用貓 2／狗 3），不違反「和平島不得放敵對怪」。
        # 黑＝tint 位移法（乘法會整隻全黑）；橘／黃＝tint 乘法；花貓／花狗＝上面的 pet_variant_sheet 合成斑塊 sheet。
        *[dict(id=pid, name=pname, lv=lv_, fixed=2, speed=sp, flee=60, noBounce=True,
               anim=dict(sheet=f"external/img2pixel/{sheet}", frames=3, rows=3, fw=32, fh=32,
                         rowDir=["up", "down", "left"], fps=6, scale=0.9),
               **({"tint": tint, "tintMode": mode} if tint else {}),
               line=line)
          for pid, pname, lv_, sp, sheet, tint, mode, line in [
              ("cat_black",   "黑貓", 2, 34, "cat_sheet.png",          "#2a2730", "off",  "「黑貓」在暗處只剩兩個亮點盯著你。"),
              ("cat_calico",  "花貓", 2, 34, "cat_calico_sheet.png",  None,      None,   "「花貓」舔了舔腳掌，瞇起眼睛。"),
              ("cat_orange",  "橘貓", 2, 34, "cat_sheet.png",         "#e09a3e", None,   "「橘貓」翻出肚皮滾了兩圈。"),
              ("dog_black",   "黑狗", 3, 40, "dog_sheet.png",         "#2a2730", "off",  "「黑狗」汪了一聲，尾巴搖個不停。"),
              ("dog_spotted", "花狗", 3, 40, "dog_spotted_sheet.png", None,      None,   "「花狗」歪著頭看你，耳朵抖了抖。"),
              ("dog_yellow",  "黃狗", 3, 40, "dog_sheet.png",         "#c8924a", None,   "「黃狗」把下巴擱在你的膝蓋上。"),
          ]],
        # 野豬（森林島）：反擊型野怪，最低階的主動威脅（Lv25）
        dict(id="boar", name="野豬", lv=25, speed=30, flee=85, retaliate=True, noBounce=True,
             anim=dict(sheet="external/img2pixel/boar_sheet.png", frames=3, rows=4, fw=64, fh=64,
                       rowDir=["up", "right", "down", "left"], fps=6, scale=0.8),   # 2026-11-14 修正左右（第 2 列面向右、第 4 列面向左，原本寫反）；格內實際內容側視 55×30／正面 21×47，畫面側視約 44×24（2026-11-13 使用者定「比羊大隻」——羊約 30×26；原 0.55 側視只有 30×16.5 反而比羊小）
             line="「野豬」磨了磨獠牙，從鼻子裡哼出一團白氣。"),
        # 白熊（雪島）：反擊型、血厚慢速
        dict(id="bear_snow", name="白熊", lv=35, speed=26, flee=90, retaliate=True, noBounce=True,
             anim=dict(sheet="external/img2pixel/bear_sheet.png", frames=4, rows=4, fw=64, fh=64,
                       rowDir=["down", "right", "up", "left"], fps=5, scale=0.6),
             line="「白熊」直起身子吼了一聲，腳邊的雪屑簌簌落下。"),
        # 蝙蝠（夜光島）：被動、會飛（swim＝能過海）；飛行不套 footDy、影子另調（同飛龍的作法）
        dict(id="bat_night", name="蝙蝠", lv=45, swim=True, speed=55, flee=90, noBounce=True, footDy=0,
             anim=dict(sheet="external/img2pixel/bat_sheet.png", frames=4, fw=32, fh=32, fps=9, scale=0.85),
             shadow=dict(rx=9, ry=3, dx=0, dy=-2),
             line="「蝙蝠」倒掛著晃了兩下，忽然撲稜稜地飛起來。"),
        # 小惡魔（熔岩島）：反擊型（補熔岩島沒有人形反擊怪的洞）
        dict(id="imp_volcano", name="小惡魔", lv=55, speed=40, flee=85, retaliate=True, noBounce=True,
             anim=dict(sheet="external/img2pixel/imp_sheet.png", frames=4, rows=4, fw=64, fh=64,
                       rowDir=["down", "up", "left", "right"], fps=7, scale=0.6),
             line="「小惡魔」朝你彈了個火苗，咯咯咯地笑。"),
        # 魔像（機械島）：反擊型、慢但硬（big=2＝判定圈 46，比一般野生小動物大一號）
        dict(id="golem_machine", name="魔像", lv=65, big=2, speed=20, flee=80, retaliate=True, noBounce=True,
             anim=dict(sheet="external/img2pixel/golem_sheet.png", frames=7, rows=3, fw=64, fh=64,
                       rowDir=["down", "right", "left"], fps=6, scale=0.7),
             line="「魔像」緩緩轉過頭，關節發出石磨般的聲音。"),
        # 飛龍：夜光島（黑）、熔岩島（原色紅）、沙灘島（沙）。四列都是飛行視角＝上飛／朝右／下飛／朝左（方向網格）；
        # swim＝會飛所以能過海；big=5＝判定圈 34+6*(5-1)=58（大隻）；shadow 依體型放大、貼在正下方
        # retaliate＝會反擊的野怪：被打不逃、鎖定攻擊者；血量／攻擊力由下面的 post-pass 依該地形島主 1/10 算
        # atkStyle="fireball"＝遠距攻擊（2026-11-10 使用者定）：進射程（main.js 的 FIREBALL_RANGE）就站定吐火球，不貼身咬（哥布林／殭屍沒設＝照舊抓咬）
        *[dict(id=did, name="飛龍", fixed=3, swim=True, big=5, speed=46, flee=150, retaliate=True, ownerFrac=10, atkStyle="fireball",
               footDy=0,   # 會飛：不套用底部留白對齊（讓牠浮在影子之上，不貼地）
               anim=dict(sheet="external/img2pixel/dragon_sheet.png", frames=3, rows=4, fw=191, fh=161,
                         rowDir=["up", "right", "down", "left"], fps=7, scale=0.9),
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

# 血量連動島主（ownerFrac，使用者定 2026-11-09）：條目標 ownerFrac: N，血量＝該地形島主血量 ÷ N（無條件捨去、最低 1）。
# 反擊型野怪（retaliate）除了血量，攻擊力也連動：島主爪擊標準傷害（兩份伺服器的 D_CLAW_DMG＝2）÷ N、最低 1；
# 經驗值在 main.js 的 mobKillXp 算（反擊型＝島主經驗 1/N；被動怪照舊 +1）。
# 條目 id 的尾碼（dragon_night→night、sheep→不是地形）就是該怪所屬的地形；沒有島主的地形（沙灘／森林／雪島）用黃金肥龍當基準
# （目前各島主血量都是 200，所以同一種怪跨島血量相同；哪天島主血量分島不同，就要拆分島條目如 sheep_snow）。
OWNER_CLAW_DMG = 2
_TERRAIN_IDS = {"grass", "beach", "snow", "night", "forest", "volcano", "machine", "peace"}
for _m in MOB_MANIFEST["mobs"]:
    if not _m.get("ownerFrac"):
        continue
    _tid = _m["id"].rsplit("_", 1)[-1]
    _om = next(_x for _x in MOB_MANIFEST["mobs"] if _x["id"] == OWNER_BY_TERRAIN.get(_tid if _tid in _TERRAIN_IDS else "", "gold_dragon"))
    _frac = max(1, int(_m["ownerFrac"]))
    _m["hp"] = max(1, _om["hp"] // _frac)
    if _m.get("retaliate"):   # 攻擊力可另給 atkFrac（例如殭屍：血 1/5、攻擊 1/10）；沒給就跟血量同一個分母
        _m["atk"] = max(1, OWNER_CLAW_DMG // max(1, int(_m.get("atkFrac", _frac))))

# 等級制素質（2026-11-12 使用者定）：條目標 lv: N 的怪，血量＝2×lv、攻擊力＝1+lv÷8、經驗值＝1+lv÷4（都無條件捨去、最低 1）。
# 舊怪（ownerFrac 那組）維持原值不動、兩套並存；之後加主動怪沿用同一張 sheet＋把 lv 拉高就好（再配 aggro）。
# 注意：XP 事件由兩份伺服器夾在 1~XP_XPE_MAX（＝25），所以 lv > 96 的怪要一起調高那個上限（worker/src/index.js ＋ tools/dev_server.py）。
for _m in MOB_MANIFEST["mobs"]:
    if not _m.get("lv"):
        continue
    _m["hp"] = max(1, 2 * _m["lv"])
    if _m.get("retaliate"):
        _m["atk"] = max(1, 1 + _m["lv"] // 8)
    _m["xp"] = max(1, 1 + _m["lv"] // 4)

# 各地形出現的小動物（id=權重）
MOBS_BY_TERRAIN = {
    "grass":   [("sheep", 2), ("bird", 1), ("frog", 1), ("chicken", 2), ("slime_grass", 1), ("goblin_grass", 2), ("deer", 2)],
    "beach":   [("bird", 2), ("frog", 1), ("bunny", 2), ("slime_beach", 1), ("dragon_beach", 1)],
    "snow":    [("sheep", 2), ("bird", 1), ("bunny_snow", 2), ("slime_snow", 1), ("zombie_snow", 2), ("bear_snow", 1), ("imp_snow", 2)],
    "night":   [("frog", 2), ("sheep", 1), ("slime_night", 1), ("dragon_night", 1), ("zombie_night", 2), ("bat_night", 2), ("skeleton_night", 2)],
    "forest":  [("sheep", 2), ("bird", 2), ("chicken", 2), ("slime_forest", 1), ("goblin_forest", 2), ("boar", 2)],
    "volcano": [("frog", 1), ("bird", 1), ("slime_volcano", 1), ("dragon_volcano", 1), ("imp_volcano", 2)],
    "machine": [("bunny_machine", 2), ("slime_machine", 1), ("zombie_machine", 2), ("golem_machine", 1), ("imp_machine", 2)],   # 機械島原本沒有野生動物；2026-11-08 使用者指定加跳跳兔（灰）與史萊姆（灰）
    "peace":   [],   # 和平島（2026-11-14 使用者定）：貓狗收掉，目前不放任何動物；和平島不得放敵對怪（貓狗過去放過：2026-11-12 被動貓狗、2026-11-13 加花色，怪種定義與花色 sheet 都留在 manifest 裡，之後要放回來隨時可以）
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

def duck(c="#f8d83a"):   # 橡皮小鴨（和平島）
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 10.5, 5, 3, b)              # 身體
    cv.ellipse(10.5, 6, 2.5, 2.5, b)          # 頭
    cv.rect(13, 6, 14, 7, hx("#f08a2a"))      # 嘴
    cv.hline(5, 8, 9, shade(b, 1.12))         # 翅膀亮面
    cv.outline()
    cv.set(11, 5, FISH_EYE)
    return cv

def dice(c="#f4f0e8", pip="#2a2a32", gold=False):   # 骰子（和平島；gold＝黃金骰子）
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(3, 3, 12, 12, b)
    cv.hline(3, 12, 3, shade(b, 1.1)); cv.vline(12, 4, 12, shade(b, .8)); cv.hline(4, 12, 12, shade(b, .8))
    p = hx(pip)
    for x, y in ((5, 5), (10, 5), (5, 10), (10, 10), (7, 7), (8, 8)):
        cv.set(x, y, p)
    cv.outline()
    if gold:
        cv.set(4, 4, hx("#fffbe0")); cv.set(5, 4, hx("#fffbe0"))
    return cv

def card(c="#d84a4a", mark="#f8f0e0"):   # 泡水的紙牌（和平島）
    cv = Canvas(16, 16)
    b = hx(c)
    cv.rect(4, 2, 11, 13, b)
    cv.rect(5, 3, 10, 12, shade(b, 1.08))
    m = hx(mark)
    cv.ellipse(7.5, 7.5, 2, 3, m)              # 中間的橢圓
    cv.set(5, 3, m); cv.set(10, 12, m)
    cv.outline()
    return cv

def stone(c="#2a2a30"):   # 五子棋子（和平島）
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(8, 8.5, 5, 3.5, b)
    cv.set(6, 7, shade(b, 1.6 if sum(b[:3]) < 200 else 1.05)); cv.set(7, 7, shade(b, 1.4 if sum(b[:3]) < 200 else 1.02))
    cv.outline()
    return cv

def seahorse(c):   # 海馬（和平島）
    cv = Canvas(16, 16)
    b = hx(c)
    cv.ellipse(9, 4.5, 2, 2, b)                # 頭
    cv.hline(10, 13, 5, b)                     # 吻
    for y, x in ((7, 8), (8, 8), (9, 8), (10, 8), (11, 7), (12, 7)):
        cv.rect(x - 1, y, x + 1, y, b)          # 身體
    cv.set(6, 13, b); cv.set(5, 12, b); cv.set(5, 11, b); cv.set(6, 11, shade(b, .8))   # 捲尾
    cv.vline(10, 7, 10, shade(b, 1.15))        # 背鰭
    cv.outline()
    cv.set(9, 4, FISH_EYE)
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
    # 和平島：室內釣魚場（2026-11-09 使用者要求）——觀賞魚，加上從遊戲桌掉進池子的小東西
    ("peace", "goldfish", "金魚", C, (5, 15), lambda: fish("#f0782a", "#f8c070", L=9, H=6, fin="#f8a050")),
    ("peace", "guppy", "孔雀魚", C, (3, 6), lambda: fish("#8a9aa8", "#d8e0e8", L=7, H=4, fin="#e85ab8")),
    ("peace", "neon_tetra", "霓虹燈魚", C, (2, 4), lambda: fish("#3a4a8a", "#e84a4a", L=8, H=4, band="#4ae8f8")),
    ("peace", "zebra_danio", "斑馬魚", C, (3, 6), lambda: fish("#d8d0a8", "#f0ece0", L=8, H=4, stripes=(6, 8, 10))),
    ("peace", "cherry_shrimp", "櫻桃蝦", C, (2, 4), lambda: shrimp("#e84a5a")),
    ("peace", "tank_snail", "缸壁螺", C, (1, 3), lambda: snail("#8a6a48", "#c8b898")),
    ("peace", "platy", "滿魚", C, (4, 7), lambda: fish("#f8a03a", "#f8d8a0", L=8, H=5)),
    ("peace", "black_molly", "黑摩利", C, (5, 10), lambda: fish("#2a2a32", "#5a5a68", L=9, H=5)),
    ("peace", "mosquitofish", "大肚魚", C, (3, 6), lambda: fish("#a8a890", "#e0e0c8", L=7, H=5)),
    ("peace", "corydoras", "鼠魚", C, (4, 7), lambda: fish("#b8a888", "#e8e0c8", L=8, H=5, whisker=True, spots=((6, 7), (8, 6), (10, 7)))),
    ("peace", "water_wisteria", "水蘊草", C, (10, 40), lambda: kelp("#4aa84a")),
    ("peace", "rubber_duck", "橡皮小鴨", C, (8, 12), lambda: duck()),
    ("peace", "lost_dice", "遺落的骰子", C, (1, 2), lambda: dice()),
    ("peace", "soggy_card", "泡水的紙牌", C, (8, 9), lambda: card()),
    ("peace", "go_stone", "五子棋子", C, (2, 3), lambda: stone()),
    ("peace", "betta", "鬥魚", U, (5, 8), lambda: fish("#c83a5a", "#e87a8a", L=8, H=5, fin="#8a3ad8")),
    ("peace", "angelfish", "神仙魚", U, (10, 20), lambda: fish("#e8e4d8", "#f8f8f0", L=9, H=8, stripes=(7, 10))),
    ("peace", "axolotl", "六角恐龍", U, (15, 30), lambda: eel("#f0a8c0", "#f8d8e0")),
    ("peace", "pea_puffer", "豆豆河豚", U, (2, 4), lambda: fish("#d8c870", "#f8f4e0", L=10, H=9, spots=((6, 6), (9, 5), (11, 7), (7, 8)))),
    ("peace", "dwarf_seahorse", "侏儒海馬", U, (2, 5), lambda: seahorse("#e8a03a")),
    ("peace", "apple_snail", "蘋果螺", U, (4, 8), lambda: snail("#e8c83a", "#f0e0a0")),
    ("peace", "crystal_shrimp", "水晶蝦", U, (2, 4), lambda: shrimp("#f0e8f0")),
    ("peace", "tiger_barb", "虎皮魚", U, (4, 7), lambda: fish("#e8b84a", "#f8e8b0", L=8, H=6, stripes=(5, 8, 11), fin="#e84a3a")),
    ("peace", "glass_catfish", "玻璃貓", U, (6, 12), lambda: fish("#d8e8f0", "#ffffff", L=10, H=4, alpha=120)),
    ("peace", "arowana", "金龍魚", R, (40, 90), lambda: fish("#e8b83a", "#f8e8a0", L=14, H=5, whisker=True, glow="#fff0a0", spots=((6, 7), (9, 7), (12, 7)))),
    ("peace", "discus", "七彩神仙", R, (12, 20), lambda: fish("#3a8ac8", "#e86a3a", L=10, H=9, stripes=(6, 9, 12), glow="#f8c84a")),
    ("peace", "ranchu", "蘭壽金魚", R, (10, 20), lambda: fish("#f04a2a", "#f8e0d0", L=9, H=8, fin="#f8f0e8", glow="#ffd0c0")),
    ("peace", "dove_fish", "和平鴿魚", R, (20, 40), lambda: fish("#f8f8f4", "#ffffff", L=11, H=6, fin="#a8c870", glow="#e8f8d8")),
    ("peace", "rainbow_koi", "彩虹錦鯉", R, (40, 90), lambda: fish("#f0f0e8", fin="#5ab8f0", L=12, H=6, band="#e85ab8", spots=((6, 7), (9, 6), (11, 8)), glow="#f8e84a")),
    ("peace", "golden_dice", "黃金骰子", R, (1, 2), lambda: dice("#f2c230", "#8a5a10", gold=True)),
]
FISH_NO_LURKER = ["peace"]   # 不會釣到敵對怪物（lurker）的地形：和平島不能有任何敵對 NPC／怪物（使用者定）

def fish_manifest():
    out = dict(
        _comment="釣魚與魚類圖鑑。由 tools/gen_assets.py 的 FISH_TABLE 產生（改這裡要改產生器再重跑）。稀有度先依 weight 抽，再從該地形同稀有度的魚裡平均抽一種；尺寸在 size 範圍內、越大越難（兩份伺服器與單機模擬一致）。",
        escape=0.002,
        lurker="fishman", lurkerChance=0.002, noLurker=FISH_NO_LURKER,
        _lurkerComment="lurker＝釣上來的敵對怪物（mobs.json 的 id）；lurkerChance＝每次拉竿成功（沒脫鉤）時釣到牠的機率（約 500 竿一次）。同一地形已經有一隻還沒消失時照常釣魚。noLurker＝不會釣到牠的地形（和平島；兩份伺服器與單機都照這個判斷）。",
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
        if t["id"] in POOLS_BY_TERRAIN:
            td["pools"] = POOLS_BY_TERRAIN[t["id"]]
        if t.get("layout"):
            td["layout"] = t["layout"]
            if t["layout"] == "room":
                td["groundRepeat"] = INDOOR_REPEAT
                if t["id"] in ROOM_BOX:
                    td["roomBox"] = ROOM_BOX[t["id"]]
                    save(wall_face(), "wall.png", sub); save(wall_side(True), "wall_w.png", sub); save(wall_side(False), "wall_e.png", sub)
                    td["walls"] = dict(n="wall.png", w="wall_w.png", e="wall_e.png", h=WALL_H)   # 東北西三面牆（南面不畫）
        if t["id"] in PROPS_BY_TERRAIN:   # 固定小物件（餐飲區等）：圖放在地形資料夾
            td["props"] = PROPS_BY_TERRAIN[t["id"]]
            save(drink_bar(), "drink_bar.png", sub); save(snack_bar(), "snack_bar.png", sub); save(dine_partition(), "dine_partition.png", sub); save(dine_rug(), "dine_rug.png", sub); save(claw_machine(), "claw_machine.png", sub); save(gacha_machine(), "gacha_machine.png", sub)   # 室內房間的方形範圍 [x0,y0,x1,y1]（含邊界）；範圍外不畫、不能走   # ground.png 是 n×n 格的大圖，每格各畫其中一塊（方磚放大 n 倍）
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
                   ("iron_chair", iron_chair()), ("lava_lamp", lava_lamp()), ("leather_chair", leather_chair()), ("pearl_statue", pearl_statue()),
                   ("rabbit_rug", rabbit_rug()), ("jelly_lamp", jelly_lamp()), ("slime_sofa", slime_sofa()), ("egg_nest", egg_nest()),
                   ("dragon_shield", dragon_shield()), ("dragon_trophy", dragon_trophy()),
                   ("park_bench", park_bench()), ("beanbag", beanbag()), ("wardrobe", wardrobe()), ("coffee_table", coffee_table()),
                   ("piano", piano()), ("fireplace", fireplace()), ("floor_mirror", floor_mirror()), ("folding_screen", folding_screen()),
                   ("antler_rack", antler_rack()), ("hide_rug", hide_rug()), ("bone_bench", bone_bench()), ("demon_candelabra", demon_candelabra()),
                   ("bat_screen", bat_screen()), ("golem_gadget", golem_gadget()), ("charm_curtain", charm_curtain()), ("compost_bed", compost_bed())]:
        save(cv, fn + ".png", "furniture")
    write_json(os.path.join(ASSETS, "furniture", "furniture.json"), FURN_MANIFEST)
    print("  furniture/furniture.json")
    print("== 和平島遊戲桌 ==")
    save(table_oldmaid(), "table_oldmaid.png", "games")
    save(table_gomoku(), "table_gomoku.png", "games")
    save(table_dodge(), "table_dodge.png", "games")
    save(table_uno(), "table_uno.png", "games")
    save(table_typing(), "table_typing.png", "games")
    save(table_intel(), "table_intel.png", "games")
    save(table_zhtyping(), "table_zhtyping.png", "games")
    save(table_mage(), "table_mage.png", "games")
    save(table_maze(), "table_maze.png", "games")
    save(table_hockey(), "table_hockey.png", "games")
    save(table_blokus(), "table_blokus.png", "games")
    save(table_trigon(), "table_trigon.png", "games")
    for k, col in enumerate(ARCADE_COLORS):
        save(arcade_cabinet(col), f"arcade_{k}.png", "games")
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
    for fid, _fname, rel in LPC_FACES:               # 臉型（頭型；原色，跟膚色用 dye 重上色）＋Q 版小嘴
        save(lpc_face_sheet(rel), f"char_face_{fid}.png", sub)
    for eid, rel in LPC_EARS:                        # 種族耳朵（精靈／貓）
        save(lpc_layer_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{eid}.png", sub)
    # 基本服裝（LPC 原檔，走路列）
    for cid, rel in LPC_CLOTHES:
        save(lpc_cloth_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{cid}.png", sub)
    for cid, rel in LPC_WEAPON_OVER:
        save(lpc_read_sheet(f"external/img2pixel/lpc/{rel}"), f"char_{cid}.png", sub)
    for cid, parts in LPC_WEAPON_ROWS:
        sheet = Canvas(LPC_COLS * CHAR_FW, LPC_ROWS * CHAR_FH)
        for anim, rel in parts:
            _lpc_overlay(sheet, f"external/img2pixel/lpc/{rel}", LPC_ATTACKS[anim][0] * CHAR_FH)
        save(sheet, f"char_{cid}.png", sub)
    # 短髮：2026-11-09 起改用 LPC repo 的 idol 短髮（同一款；k-idol 外部素材沒有半揮等新動作），依亮度重上色成 12 色；
    # 檔名、id 照舊（char_hair1～12），k-idol 原檔只拿來取 12 色的主色（kidol_main_hex）
    for i, (cid, _cname) in enumerate(KIDOL_HAIR):
        save(lpc_hair_tinted("external/img2pixel/lpc/hair_idol.png", kidol_main_hex(cid)), f"char_hair{i + 1}.png", sub)
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
    # 髮色／眼睛顏色的調色盤自訂色：每個樣式拿棕色版當底圖（亮度夠、層次完整），取可染色顏色（只排除最暗的輪廓）
    hair_dye = {"short": lpc_dye_of("char_hair1.png", n=10, min_lum=25)}
    for sid, _sname, _fn in LPC_HAIR_STYLES:
        hair_dye[sid] = lpc_dye_of(f"char_hair_{sid}_brown.png", n=10, min_lum=25)
    eye_dye = {eid: lpc_dye_of(f"char_eyes_{eid}_brown.png", n=10, min_lum=0) for eid, _en, _rel in LPC_EYES}
    # 換色以 dye 的第一個顏色當主色（依它算明暗比例）：最常出現的常是暗部輪廓，所以把棕色的主色（kidol_hex["brown"]）排到第一個
    main_brown = kidol_hex["brown"]
    for dd in (hair_dye, eye_dye):
        for k2, lst in dd.items():
            dd[k2] = [main_brown] + [c for c in lst if c != main_brown]
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
        # dyeFrom／dye＝玩家用調色盤自訂顏色時的底圖（該樣式的棕色版）與它的可染色顏色（整層依明暗換成自訂色）
        eyes=[dict(id=f"{eid}_{cid}", name=cname, style=eid, styleName=en, color=cid, hex=kidol_hex[cid], sheet=f"char_eyes_{eid}_{cid}.png",
                   dyeFrom=f"char_eyes_{eid}_brown.png", dye=eye_dye[eid])
              for eid, en, _rel in LPC_EYES for cid, cname in KIDOL_HAIR],
        races=LPC_RACES,
        # 髮型：style／styleName＝造型、color／name／hex＝顏色；面板分成「髮型」（文字鈕）與「髮色」（色塊）兩列，換一邊另一邊保持不變
        # hex＝該款髮色的主色（貓耳跟髮色重上色用）
        hair=[dict(id=f"hair{i + 1}", name=cname, style="short", styleName="短髮", color=cid, sheet=f"char_hair{i + 1}.png", hex=kidol_hex[cid],
                   dyeFrom="char_hair1.png", dye=hair_dye["short"])
              for i, (cid, cname) in enumerate(KIDOL_HAIR)] +
             [dict(id=f"{sid}_{cid}", name=cname, style=sid, styleName=sname, color=cid, sheet=f"char_hair_{sid}_{cid}.png", hex=kidol_hex[cid],
                   dyeFrom=f"char_hair_{sid}_brown.png", dye=hair_dye[sid])
              for sid, sname, _fn in LPC_HAIR_STYLES for cid, cname, _hx in hair_colors],
        # 基本服裝（LPC 原檔；gender＝之後選性別用）
        # 服裝：男女共用一個 id（sheet＝男、sheetF＝女，client 依角色性別挑；外觀清單一件只出現一次）；
        # dye＝可染色的顏色（lpc_dye_of 自動從圖上取，第一個是主色）；glam＝可當外觀（沒寫 unlock＝一開始就能用）
        tops=[lpc_garment("tshirt", "T恤", "char_top_tshirt_m.png", "char_top_tshirt_f.png", glam=True),
              lpc_garment("plate", "騎士板甲", "char_top_plate_m.png", "char_top_plate_f.png"),
              lpc_garment("whm_robe", "白魔道袍", "char_top_whm_m.png", "char_top_whm_f.png"),
              lpc_garment("blm_robe", "黑魔道袍", "char_top_blm_m.png", "char_top_blm_f.png"),
              lpc_garment("brd_vest", "詩人皮背心", "char_top_brd_m.png", "char_top_brd_f.png"),
              lpc_garment("drg_plate", "龍騎士鎧甲", "char_top_drg_m.png", "char_top_drg_f.png"),
              lpc_garment("sge_robe", "賢者長袍", "char_top_sge_m.png", "char_top_sge_f.png"),
              lpc_garment("war_mail", "戰士鎖子甲", "char_top_war_m.png", "char_top_war_f.png"),
              lpc_garment("nin_top", "忍者上衣", "char_top_nin_m.png", "char_top_nin_f.png")],
        bottoms=[lpc_garment("pants", "長褲", "char_bottom_pants_m.png", "char_bottom_pants_f.png", glam=True),
                 lpc_garment("plate_legs", "騎士腿甲", "char_bottom_plate_m.png", "char_bottom_plate_f.png"),
                 lpc_garment("brd_pants", "燈籠褲", "char_bottom_brd_m.png", "char_bottom_brd_f.png"),
                 lpc_garment("drg_legs", "龍騎士腿甲", "char_bottom_drg_m.png", "char_bottom_drg_f.png"),
                 lpc_garment("war_pants", "戰士長褲", "char_bottom_war_m.png", "char_bottom_war_f.png"),
                 lpc_garment("nin_pants", "忍者長褲", "char_bottom_nin_m.png", "char_bottom_nin_f.png")],
        shoes=[lpc_garment("shoes", "鞋子", "char_shoes_m.png", "char_shoes_f.png", glam=True),
               lpc_garment("plate_boots", "騎士板甲靴", "char_shoes_plate_m.png", "char_shoes_plate_f.png"),
               lpc_garment("brd_boots", "翻邊皮靴", "char_shoes_brd_m.png", "char_shoes_brd_f.png"),
               lpc_garment("drg_boots", "龍騎士鐵靴", "char_shoes_drg_m.png", "char_shoes_drg_f.png"),
               lpc_garment("war_boots", "戰士長靴", "char_shoes_war_m.png", "char_shoes_war_f.png"),
               lpc_garment("nin_tabi", "分趾襪", "char_shoes_nin_m.png", "char_shoes_nin_f.png")],
        hats=[dict(id="nohat", name="不戴帽子", sheet=None, glam=True),
              dict(id="armet", name="騎士頭盔", sheet="char_hat_armet.png", hideHair=True, dye=lpc_dye_of("char_hat_armet.png")),   # hideHair＝全罩式，不畫頭髮
              dict(id="hood", name="白魔兜帽", sheet="char_hat_hood.png", hideHair=True, dye=lpc_dye_of("char_hat_hood.png")),
              dict(id="wizard", name="尖頂帽", sheet="char_hat_wizard.png", dye=lpc_dye_of("char_hat_wizard.png")),
              dict(id="cavalier", name="羽毛帽", sheet="char_hat_cavalier.png", dye=lpc_dye_of("char_hat_cavalier.png")),
              dict(id="horned", name="龍騎士角盔", sheet="char_hat_horned.png", hideHair=True, dye=lpc_dye_of("char_hat_horned.png")),
              dict(id="barbarian", name="蠻族頭盔", sheet="char_hat_barbarian.png", dye=lpc_dye_of("char_hat_barbarian.png")),
              dict(id="headband", name="忍者頭巾", sheet="char_hat_ninja.png", dye=lpc_dye_of("char_hat_ninja.png"))],
        hairColor="#4a3428",
        shirtColors=['#d95c68', '#4a90d9', '#4aa564', '#c9a227', '#8a5cc9', '#e0e0e0', '#4a4a52', '#d97a3a', '#f2a1b5', '#b5303f', '#f0c93a', '#8fd0e8', '#2e5fa8', '#3a3f8c', '#6fcfc0', '#2f8a78', '#8fc455', '#3e6b3a', '#b48be0', '#6a3f9a', '#8a5a3a', '#c8b08a', '#9aa0aa', '#f4ede0'],
        pantsColors=['#4a54a0', '#2f3548', '#4a4a52', '#8a8f99', '#d8d4c8', '#8a6a46', '#c8b08a', '#5a4a3a', '#3e6b3a', '#6a8a4a', '#2f8a78', '#3a78c8', '#2e5fa8', '#7aa8d8', '#6a3f9a', '#a63d4a', '#d97a3a', '#e0b840', '#e8a0b8', '#b5303f', '#1f1f26', '#f0f0f0', '#6fcfc0', '#b48be0'],
        # 武器外觀：每把職業武器各有天藍／金黃發光版（with_glow；2026-11-09 取代舊的「金劍」）
        weapons=with_glow([
            # type＝武器類型（武器外觀只能換成同類型的樣子）；職業武器由 jobs.json 的 weapon 指定，武器列只列「職業武器＋空手＋釣竿」
            dict(id="hands", name="空手", type="hands", sprite=None),
            # carry：不拿在手上時掛哪裡（back＝背上、waist＝腰間）；back: "hilt"＝背著時劍柄朝上（沒寫＝頭朝上，例如釣竿）
            # scale：這張圖畫幾倍（沒寫＝與人物同倍率）。目前這些是舊 24px placeholder（人物當時畫 2 倍）＝標 scale 2；
            #        之後的 64px 武器模組照人物規格畫、不寫 scale 就是 1 倍
            # lpc＝LPC 武器圖層（畫在人物圖裡、跟手完全對齊；有這欄就不畫舊的小圖）：bg／fg＝一般格（走路、待機時拿在手上；bg 在身體後面、fg 在最上面），
            # over＝某個攻擊動作的超大格 sheet（size＝每格邊長，人物畫在格子正中央）。2026-11-09 騎士先換：LPC Arming Sword（steel）
            dict(id="sword", name="長劍", type="sword", sprite="weapon_sword.png", carry="back", back="hilt", scale=2,
                 lpc=dict(bg="char_weapon_arming_bg.png", fg="char_weapon_arming_fg.png",
                          over=dict(slash=dict(size=128, bg="char_weapon_arming_slash_bg.png", fg="char_weapon_arming_slash_fg.png"),
                                    halfslash=dict(size=128, bg="char_weapon_arming_halfslash_bg.png", fg="char_weapon_arming_halfslash_fg.png")))),
            dict(id="waraxe", name="戰斧", type="axe", sprite="weapon_waraxe.png", carry="back", scale=2,
                 lpc=dict(bg="char_weapon_waraxe_bg.png", fg="char_weapon_waraxe_fg.png",   # LPC 戰斧（waraxe）：走路一般格、揮砍 192 超大格
                          over=dict(slash=dict(size=192, bg="char_weapon_waraxe_slash_bg.png", fg="char_weapon_waraxe_slash_fg.png")))),
            dict(id="staff", name="法杖", type="staff", sprite="weapon_staff.png", scale=2, ranged=dict(range=320, cast=1.2, dmg=2),   # LPC 環頭杖（loop）；LPC 的杖只有突刺，攻擊／詠唱都播突刺
                 lpc=dict(bg="char_weapon_loop_bg.png", fg="char_weapon_loop_fg.png",
                          over=dict(thrust=dict(size=192, bg="char_weapon_loop_thrust_bg.png", fg="char_weapon_loop_thrust_fg.png")))),   # ranged：遠距詠唱——射程 px、詠唱秒數、傷害；按攻擊會自動瞄準（島主優先）
            dict(id="tome", name="賢具", type="tome", sprite="weapon_tome.png", carry="waist", scale=2, ranged=dict(range=320, cast=0, dmg=1, shot="funnels")),   # 賢具＝浮游炮（FF14 nouliths）：不用詠唱，攻擊時四座賢具飛出、各朝目標射一道光束（main.js 的 fxk 'funnels'）；不用詠唱的 dmg 1（使用者定的平衡，同豎琴弓）
            # 豎琴弓：遠程但不用詠唱（cast 0＝按攻擊直接射箭；shot: "arrow"＝畫箭矢而不是光球）。dmg 1：加上輸出的 +1＝2，
            # 和忍者一樣；要詠唱的武器（咒杖等）才是 2＋1＝3（使用者定：不用詠唱的普攻都是 2）
            dict(id="harpbow", name="豎琴弓", type="bow", sprite="weapon_harpbow.png", carry="back", ranged=dict(range=320, cast=0, dmg=1, shot="arrow"),
                 lpc=dict(bg="char_weapon_recurve_bg.png", fg="char_weapon_recurve_fg.png",   # LPC 反曲弓：射擊是一般格（前層含箭矢），走路是 128 超大格
                          over=dict(walk=dict(size=128, bg="char_weapon_recurve_walk_bg.png", fg="char_weapon_recurve_walk_fg.png")))),
            dict(id="lance", name="長槍", type="lance", sprite="weapon_lance.png", carry="back",
                 lpc=dict(over=dict(walk=dict(size=128, bg="char_weapon_dragonspear_walk_bg.png", fg="char_weapon_dragonspear_walk_fg.png"),   # LPC 龍槍：走路 128、突刺 192
                                    thrust=dict(size=192, bg="char_weapon_dragonspear_thrust_bg.png", fg="char_weapon_dragonspear_thrust_fg.png")))),
            dict(id="daggers", name="短劍", type="daggers", sprite="weapon_daggers.png", carry="waist",   # 2026-11-09 換 LPC 短劍（dagger，單手；LPC 沒有雙持），名稱由「雙劍」改「短劍」
                 lpc=dict(bg="char_weapon_dagger_bg.png", fg="char_weapon_dagger_fg.png")),
            dict(id="scepter", name="咒杖", type="scepter", sprite="weapon_scepter.png", ranged=dict(range=320, cast=1.0, dmg=4, gap=0),
                 lpc=dict(bg="char_weapon_s_bg.png", fg="char_weapon_s_fg.png",   # LPC S 形杖（s）；只有突刺
                          over=dict(thrust=dict(size=192, bg="char_weapon_s_thrust_bg.png", fg="char_weapon_s_thrust_fg.png")))),   # gap：詠唱放完到下一次能開始的間隔（秒）；沒寫＝ATK_CD（0.45）。咒杖 gap=0＝連續施放，間隔就是詠唱時間
            dict(id="rod", name="釣竿", type="rod", sprite="weapon_rod.png", carry="back", fishing=True,   # fishing：拿著時左鍵／F 是釣魚，不能攻擊
                 # 釣魚中改畫 LPC 釣竿（人物圖層，四方向）；沒在釣魚時照舊背著小圖。tips＝每格竿尖（釣線從這裡拉到浮標）
                 lpc=dict(fishOnly=True, over=dict(rod=dict(size=128, bg="char_weapon_rod_fish_bg.png", fg="char_weapon_rod_fish_fg.png")),
                          tips=rod_tips("external/img2pixel/lpc/weapon_rod_fish_bg.png", "external/img2pixel/lpc/weapon_rod_fish_fg.png"))),
            # 武器外觀（glam）：只換樣子，玩法照職業武器；type 要和職業武器相同才能選
        ]),
    ))
    print("  avatar/avatar.json")

if __name__ == "__main__":
    main()
