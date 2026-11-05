#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 本機開發伺服器（M1）
# 1) 服務 client/ 靜態檔
# 2) /api/config   -> 從 dev_config.json 讀 client_id
# 3) /api/token    -> 用 code+secret 向 Discord 兌換 access_token（secret 只在本機/伺服器端）
# 用法: python tools/dev_server.py  (先填 tools/dev_config.json)
import json, math, os, re, sys, base64, hashlib, hmac, struct, threading, time, random, traceback
import subprocess, urllib.request, urllib.parse, urllib.error, http.server, socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.join(HERE, "..", "client")
CONFIG = os.path.join(HERE, "dev_config.json")
PORT = 8787

def config():
    if not os.path.exists(CONFIG):
        return {}
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)

# ---- 身分憑證（與 worker/src/index.js 相同格式）----
# 密鑰：dev_config.json 的 session_secret；沒填就每次啟動隨機產生（重啟後舊憑證失效，開發用夠了）
SESSION_TTL = 12 * 3600
_SESSION_SECRET = None

def session_secret():
    global _SESSION_SECRET
    if _SESSION_SECRET is None:
        _SESSION_SECRET = (config().get("session_secret") or os.urandom(16).hex()).encode()
    return _SESSION_SECRET

def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def _unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def sign_session(user):
    if not user:
        return None
    body = _b64u(json.dumps({"id": str(user["id"]), "name": str(user["name"]), "exp": int((time.time() + SESSION_TTL) * 1000)},
                            ensure_ascii=False, separators=(",", ":")).encode())
    sig = hmac.new(session_secret(), body.encode(), hashlib.sha256).digest()
    return body + "." + _b64u(sig)

def verify_session(token):
    """成功回 {"id","name"}，否則 None。"""
    if not isinstance(token, str) or len(token) > 1024 or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    try:
        want = hmac.new(session_secret(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, _unb64u(sig)):
            return None
        u = json.loads(_unb64u(body).decode())
        if not u.get("id") or not u.get("name") or u.get("exp", 0) <= time.time() * 1000:
            return None
        return {"id": u["id"], "name": u["name"]}
    except Exception:
        return None

def is_admin(user):
    """管理員：dev_config.json 的 admin_ids（Discord 使用者 ID 清單）。
    ⚠️ 沒設定 admin_ids 時，本機開發讓所有人（含訪客）都是管理員，方便測試；正式版（Worker）沒設就沒有管理員。"""
    ids = config().get("admin_ids")
    if ids is None:
        return True
    return bool(user) and str(user["id"]) in [str(i) for i in ids]

def discord_me(access_token):
    """用 access_token 問 Discord 這是誰。失敗回 None（名字可之後再補）。"""
    try:
        req = urllib.request.Request(
            "https://discord.com/api/v10/users/@me",
            headers={"Authorization": "Bearer " + access_token, "User-Agent": "DCIslandDev/0.1"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"[me] {e}", file=sys.stderr, flush=True)
        return None

def exchange_code(code, cfg):
    data = urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "grant_type": "authorization_code",
        "code": code,
    }).encode()
    req = urllib.request.Request(
        "https://discord.com/api/oauth2/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "DCIslandDev/0.1"},  # Discord 會擋 Python 預設 UA（403）
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

# ============ M2：WebSocket 多人同步（同語音頻道＝同一座島）============
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# 以下限制與 worker/src/index.js 一致（改一邊要改另一邊）
COLS, ROWS = 88, 56
MAX_FURN = 500
SIGN_MAX = 100            # 看板文字上限（字）
MAX_MSG = 16384           # 裝飾模式的 commit 會一次帶多個操作
MAX_OPS = 100
MAX_PLAYERS = 64
RATE_MAX = 40
TERRAIN_RE = re.compile(r"^[a-z0-9_-]{1,24}$")

CELL = 32                # 與 client/js/main.js 一致

# ---- 玩家 state 封包白名單（與 worker/src/index.js 的 sanitizeState 一致，改一邊要改另一邊）----
ID_RE = re.compile(r"^[a-z0-9_-]{1,24}$")
NAME_MAX = 24
D8 = ("down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left")   # 與 client 的 CHAR_DIR8 一致


def _num(v, lo, hi, fb):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return min(hi, max(lo, v))
    return fb


HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# 職業 → 職能（與 client/assets/jobs/jobs.json、worker 的 JOB_ROLE 一致；新增職業要一起加）
JOB_ROLE = {"knight": "tank", "warrior": "tank", "whitemage": "healer", "sage": "healer", "ninja": "melee", "bard": "ranged", "blackmage": "ranged"}
JOB_LEGACY = {"tank": "knight", "healer": "whitemage", "dps": "ninja"}   # 舊客戶端的職業 id
JOB_DEFAULT = "ninja"
RANGED_WEAPONS = ("staff", "scepter", "tome", "harpbow")   # 遠距攻擊的武器（法杖、咒杖、魔導書、豎琴弓）
D_DEBUFF_MS = 10000      # 破綻／降傷的持續時間（與 worker、client 一致）
D_DEBUFF_CD_MS = 30000   # 破綻／降傷冷卻（每條連線、每種各算）
# 職業技能打島主／深海魚人（與 worker 的 SKILL_HITS、client 的 JOB_SKILLS 一致）
SKILL_HITS = {
    "ninjutsu": {"job": "ninja", "dmg": 6, "cd_ms": 19000, "range": 170},
    "poison": {"job": "bard", "dmg": 1, "cd_ms": 2700, "range": 2000},   # 吟遊詩人上毒：每 3 秒跳一次（持續傷害不看距離）
}
FX_MAX = 8


def _hex_or(v):
    return v.lower() if isinstance(v, str) and HEX_RE.match(v) else None


def _job_or(v):
    return v if v in JOB_ROLE else JOB_LEGACY.get(v, JOB_DEFAULT)


def role_of(st):
    return JOB_ROLE.get((st or {}).get("job"))


def _id_or(v, fb):
    return v if isinstance(v, str) and ID_RE.match(v) else fb


def sanitize_state(s, prev):
    prev = prev or {}
    look = s.get("look") if isinstance(s.get("look"), dict) else {}
    pl = prev.get("look") or {}
    name = s.get("name")
    fs = s.get("fish")
    name = "".join(ch for ch in name if ord(ch) >= 32 and ord(ch) != 127)[:NAME_MAX] if isinstance(name, str) else (prev.get("name") or "")
    return {
        "x": _num(s.get("x"), 0, COLS * CELL, prev.get("x", (COLS / 2 - .5) * CELL)),
        "y": _num(s.get("y"), 0, ROWS * CELL, prev.get("y", (ROWS / 2 - .5) * CELL)),
        "dir": -1 if s.get("dir") == -1 else 1,
        "moving": bool(s.get("moving")),
        "z": _num(s.get("z"), 0, 200, 0),
        "name": name,
        "look": {
            "skin": _id_or(look.get("skin"), pl.get("skin", "light")),
            "hair": _id_or(look.get("hair"), pl.get("hair", "hair1")),
            "shirt": round(_num(look.get("shirt"), 0, 99, pl.get("shirt", 0))),
            "pants": round(_num(look.get("pants"), 0, 99, pl.get("pants", 0))),
            "hat": _id_or(look.get("hat"), None),        # 顯示中的帽子 id（裝備或外觀，客戶端已決定好；None＝沒戴）
            "top": _id_or(look.get("top"), None),        # 顯示中的上衣 id（None＝預設款）
            "bottom": _id_or(look.get("bottom"), None),  # 顯示中的褲子 id（None＝預設款）
            "hatC": _hex_or(look.get("hatC")),           # 換色色碼（None＝原色）
            "topC": _hex_or(look.get("topC")),
            "botC": _hex_or(look.get("botC")),
            "wlook": _id_or(look.get("wlook"), None),    # 武器外觀 id
        },
        "d8": s.get("d8") if s.get("d8") in D8 else None,   # 畫面用的 8 方向朝向（只轉發；玩法看 face）
        "weapon": _id_or(s.get("weapon"), "hands"),
        "pose": s.get("pose") if s.get("pose") in ("sit", "sleep") else None,
        "face": s.get("face") if s.get("face") in ("up", "side") else "down",
        "seat": _id_or(s.get("seat"), None),
        "job": _job_or(s.get("job")),   # 職業：白名單（JOB_ROLE），舊客戶端的 tank/healer/dps 轉換，不合法＝忍者（職能驗證靠這欄）
        "fx": [v for v in s.get("fx") if isinstance(v, str) and ID_RE.match(v)][:FX_MAX] if isinstance(s.get("fx"), list) else [],   # 持續型技能效果：只轉發
        "circle": {"x": _num(s["circle"].get("x"), 0, COLS * CELL, 0), "y": _num(s["circle"].get("y"), 0, ROWS * CELL, 0)}
                  if isinstance(s.get("circle"), dict) else None,   # 黑魔法師的魔法陣位置（只轉發）
        "title": _id_or(s.get("title"), None),   # 稱號 id（None＝不顯示；只轉發 id，文字由各客戶端查 titles.json，解鎖與否不驗證）
        "hp": round(_num(s.get("hp"), 0, 20, 10)),
        "dead": 1 if s.get("dead") else 0,
        # 釣魚：浮標位置與階段（只轉發；釣到什麼由 fish 訊息決定）
        "fish": {"x": _num(fs.get("x"), 0, COLS * CELL, 0), "y": _num(fs.get("y"), 0, ROWS * CELL, 0), "ph": fs["ph"]}
                if isinstance(fs, dict) and fs.get("ph") in FISH_PHASES else None,
    }


# ---- 釣魚（魚類圖鑑）：與 worker/src/index.js 一致（改一邊要改另一邊）----
# 釣到什麼由伺服器抽；登入的人記進圖鑑（本機版存在記憶體，重開就清空；正式站存在 Worker 的全域 Registry）
FISH_PHASES = ("wait", "bite", "reel")
FISH_CD = 2.5            # 同一條連線兩次釣魚結果的最短間隔（秒）
_FISH_DB = None
def fish_db():
    """fish.json（各地形的魚與稀有度）。"""
    global _FISH_DB
    if _FISH_DB is None:
        with open(os.path.join(CLIENT, "assets", "fish", "fish.json"), encoding="utf-8") as f:
            _FISH_DB = json.load(f)
    return _FISH_DB

def roll_fish(terrain):
    """先脫鉤判定，再依權重抽稀有度，從該地形同稀有度的魚裡平均抽一種；尺寸越大越難（範圍內取 r^1.6）。"""
    db = fish_db()
    lst = db.get("terrains", {}).get(terrain) or []
    if not lst or random.random() < db.get("escape", 0):
        return {"terrain": terrain, "escaped": True}
    rars = [(k, v) for k, v in db["rarity"].items() if any(f["rarity"] == k for f in lst)]
    r, rar = random.random() * sum(v["weight"] for _, v in rars), rars[-1][0]
    for k, v in rars:
        r -= v["weight"]
        if r < 0:
            rar = k
            break
    f = random.choice([f for f in lst if f["rarity"] == rar])
    size = round((f["size"][0] + (f["size"][1] - f["size"][0]) * random.random() ** 1.6) * 10) / 10
    return {"terrain": terrain, "id": f["id"], "size": size, "rarity": rar}

FISH_DEX = {}            # Discord 使用者 ID -> {地形: {魚id: {max, n, first}}}（對應 Worker 的 Registry）
FISH_DEX_LOCK = threading.Lock()

def dex_catch(uid, terrain, fid, size):
    """記一筆釣到的魚，回 (entry, is_new, is_record)。"""
    with FISH_DEX_LOCK:
        t = FISH_DEX.setdefault(uid, {}).setdefault(terrain, {})
        e = t.get(fid)
        is_new, is_record = e is None, e is None or size > e["max"]
        t[fid] = {"max": max(e["max"], size) if e else size, "n": (e["n"] if e else 0) + 1,
                  "first": e["first"] if e else int(time.time() * 1000)}
        return dict(t[fid]), is_new, is_record


HIT_RANGE = 140          # 打可破壞物件時，玩家離目標最遠幾 px（客戶端範圍 72，留給延遲）
HIT_CD = 0.3             # 同一條連線兩次打擊最短間隔（秒）
SIGN_CD = 1.0            # 同一條連線兩次改看板的最短間隔（秒；與 Worker 的 SIGN_CD_MS 一致）
COMMIT_BURST = 20        # 保存擺設的令牌桶：一次可連發幾批（客戶端一次保存最多約 19 批；與 Worker 一致）
COMMIT_REFILL = 0.5      # 每幾秒回一批（與 Worker 的 COMMIT_REFILL_MS 一致）

# ---- 島主（伺服器端同步；與 worker/src/index.js 的常數與演算法保持一致，改一邊要改另一邊）----
# 被打 → 說台詞 → 反擊（樣式照 OWNER_TERRAINS：dash＝瞬移島緣＋龍衝；gaze＝原地開眼＋石化；beam＝原地讀條＋波動砲直線）→ 仇恨追殺 → 冷靜回閒晃。
# 客戶端只負責演出與自己有沒有被打到的判定；伺服器只送「階段變更」事件，不需要每幀醒著跑。
# 每座地形各自的島主（地形 → 攻擊樣式；要與 client assets 的 terrain.json owner／mobs.json atk 一致）
OWNER_TERRAINS = {"grass": "dash", "night": "gaze", "volcano": "beam"}
D_CAST_MS = 2000         # 龍衝的島緣鎖定（預警）持續時間（頭上有讀條，跟石化之瞳一樣 2 秒；與 Worker、client 的 OWNER_CAST 一致）
D_GAZE_CAST_MS = 2000    # 石化之瞳的開眼預警持續時間（與 client 的 OWNER_GAZE_CAST 一致）
D_BEAM_CAST_MS = 2000    # 波動砲的讀條持續時間（與 client 的 OWNER_BEAM_CAST 一致）
D_DASH = 560             # 龍衝速度 px/s（比仇恨追殺的 180 更快：高速掠過才有威嚇感；與 client 的 OWNER_DASH_SPEED 一致）
D_REST_MS = 700          # 衝到底落地的停留時間
D_RAGE_MS = 12000        # 龍衝冷卻：到點才能再觸發龍衝；冷卻期間被打進入仇恨追殺
D_SAY_MS = 3000          # 被打後先在原地說台詞的時間（說完才瞬移反擊）
Q_GAP_MS = 3000          # 台詞招式：說完台詞後每隔幾 ms 放一招（第一招在說完後 Q_GAP_MS；與 Worker 一致）
D_RESPAWN_MS = 30000     # 島主被打倒後的重生秒數
D_HP = 200
D_REGEN = 18             # 島主每秒回血（用牆鐘 lazy 計算；與 worker/src/index.js 的 D_REGEN 一致）
D_CHASE = 180.0          # 仇恨追殺速度 px/s（玩家走路 120／跑步 200：走路逃不掉，跑步才能拉開）
D_CLAW_RANGE = 36        # 爪擊範圍（前方扇形；約黃金肥龍大圖的 1/4）
D_CLAW_MS = 1000         # 爪擊間隔（每秒一下）
D_CLAW_DMG = 2           # 爪擊傷害（扣玩家 HP；被打倒由各客戶端自判，伺服器只廣播爪擊事件）
D_AGGRO_MS = 5000        # 仇恨換人週期：打牠的人有複數時，隨機換下一個攻擊者
D_DROPOUT = 30000        # 超過這時間沒有人攻擊島主：脫離仇恨回閒晃
D_STAFF_RANGE = 440       # 法杖（遠距詠唱）打島主的最大距離：客戶端射程 320 + 判定圈 58 + 緩衝；只有 state.weapon＝staff 的連線才適用
D_RANGE = 100            # 玩家打島主的攻擊距離（客戶端以武器尖端為準：判定圈 58 + 武器伸出 30 = 88，留延遲）
D_DRIFT_TOLER = 600      # 客戶端宣稱的龍位置與伺服器的最大容差（漏接一個路點事件的落後量）
D_CD = 0.3               # 同一條連線兩次打島主的最短間隔（秒）
D_PROVOKE_CD = 15.0      # 挑釁冷卻（每條連線，秒；與 worker/src/index.js 的 D_PROVOKE_CD_MS 一致）
D_PROVOKE_RANGE = 240    # 挑釁範圍（比攻擊距離寬：把島主拉過來的是「聲東擊西」，不需要貼臉）
D_WALK = 34              # 閒晃散步速度 px/s（與 client 的 OWNER_WALK_SPEED 一致）
D_WANDER_PAUSE = (1.5, 4.0)   # 每個路點之間站著休息的時間範圍（秒）
D_CENTER = ((COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL)

# ---- 釣上來的敵對怪物（lurker；fish.json 的 lurker／lurkerChance）----
# 拉竿成功時極低機率釣到：落在浮標旁最近的陸地、追殺釣到牠的人（仇恨換人、爪擊與島主同一套規則），
# L_DROPOUT 內沒人打就原地消失，被打倒也消失（不重生）。每個地形同時最多一隻；該地形沒人時直接消失。
# 常數與 worker/src/index.js 的 L_* 一致（改一邊要改另一邊）
# 強度以「一個人也打得倒」為準（釣魚通常是單人）：一般揮擊約 8 秒打死；貼身時每 1.5 秒抓一下、每下只扣 1
L_HP = 20
L_CHASE = 150.0
L_CLAW_RANGE = 30
L_CLAW_MS = 1500
L_DROPOUT = 30000
L_RANGE = 90
L_STAFF_RANGE = 400

def js_round(v):
    """與前端 Math.round 同義（floor(v+0.5)），避免各家四捨五入規則不同。"""
    return math.floor(v + 0.5)

def dragon_land(v):
    """RLE 位圖字串 → list[int]（1＝陸地）。格式錯回 None。"""
    if not isinstance(v, str) or len(v) > 20000:
        return None
    p = v.split(":")
    land = [0] * (COLS * ROWS)
    try:
        val = 1 if p[0] == "1" else 0
        i = 0
        for k in p[1:]:
            n = int(k)
            if n <= 0 or i + n > COLS * ROWS:
                return None
            land[i:i + n] = [val] * n
            i += n
            val ^= 1
    except ValueError:
        return None
    return land if i == COLS * ROWS else None

def dragon_edge(m, ang):
    """島心沿角度找最後一格陸地（島緣）；演算法與 client/js/main.js 相同，兩邊結果一致。"""
    cx, cy = COLS / 2 - .5, ROWS / 2 - .5
    ux, uy = math.cos(ang), math.sin(ang)
    lx, ly = cx, cy
    for r in range(1, 45):
        x, y = js_round(cx + ux * r), js_round(cy + uy * r)
        if not (0 <= x < COLS and 0 <= y < ROWS) or not m[y * COLS + x]:
            break
        lx, ly = x, y
    return [lx * CELL + CELL / 2, ly * CELL + CELL / 2]

def dragon_dash_dest(m, fx, fy, ux, uy):
    """龍衝終點：沿方向找最後一格陸地（島邊緣對岸）。"""
    gx, gy = math.floor(fx / CELL), math.floor(fy / CELL)
    lx, ly = gx, gy
    for r in range(1, 51):
        x, y = js_round(gx + ux * r), js_round(gy + uy * r)
        if not (0 <= x < COLS and 0 <= y < ROWS) or not m[y * COLS + x]:
            break
        lx, ly = x, y
    return [lx * CELL + CELL / 2, ly * CELL + CELL / 2]


def dragon_nearest_land(m, x, y):
    """從 (x,y) 找最近的陸地格中心（卡海自救用）；找不到回 None。"""
    gx, gy = int(x // CELL), int(y // CELL)
    if 0 <= gx < COLS and 0 <= gy < ROWS and m[gy * COLS + gx]:
        return [gx * CELL + CELL / 2, gy * CELL + CELL / 2]
    for r in range(1, 45):
        cand = None
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue   # 只看外圈
                nx, ny = gx + dx, gy + dy
                if 0 <= nx < COLS and 0 <= ny < ROWS and m[ny * COLS + nx]:
                    cand = [nx * CELL + CELL / 2, ny * CELL + CELL / 2]
                    break
            if cand:
                break
        if cand:
            return cand
    return None

_TARGETS = None
def deco_targets():
    """可破壞物件定義（前端 tools.json 的 targets），血量/重生秒數據此判斷。"""
    global _TARGETS
    if _TARGETS is None:
        with open(os.path.join(CLIENT, "assets", "tools", "tools.json"), encoding="utf-8") as f:
            _TARGETS = json.load(f).get("targets", {})
    return _TARGETS

def cell_has_furn(items, cell):
    """該格有沒有家具（家具佔 w×h 格）。"""
    defs = furn_defs()
    for it in items:
        w, h = defs.get(it["type"], (1, 1))
        if it["cell"][0] <= cell[0] < it["cell"][0] + w and it["cell"][1] <= cell[1] < it["cell"][1] + h:
            return True
    return False

_TEXT_TYPES = None
def text_types():
    """可編輯文字的家具種類（furniture.json 標了 text 的，例如看板）。"""
    global _TEXT_TYPES
    if _TEXT_TYPES is None:
        with open(os.path.join(CLIENT, "assets", "furniture", "furniture.json"), encoding="utf-8") as f:
            _TEXT_TYPES = {it["id"] for it in json.load(f)["items"] if it.get("text")}
    return _TEXT_TYPES

_FURN_DEFS = None
def furn_defs():
    """id -> (w, h)，取自前端 furniture.json，用來驗證擺放。"""
    global _FURN_DEFS
    if _FURN_DEFS is None:
        with open(os.path.join(CLIENT, "assets", "furniture", "furniture.json"), encoding="utf-8") as f:
            _FURN_DEFS = {it["id"]: (it["w"], it["h"]) for it in json.load(f)["items"]}
    return _FURN_DEFS

_SKILL_DEFS = None
def owner_says(terrain):
    """這座島的島主放招前要不要先講台詞：取自前端 skills.json（key＝攻擊樣式），say:false 就被打直接開始預警。
    與 Worker 的 ownerSays 一致；檔案讀不到就當作要講（與以前行為相同）。"""
    global _SKILL_DEFS
    if _SKILL_DEFS is None:
        try:
            with open(os.path.join(CLIENT, "assets", "skills", "skills.json"), encoding="utf-8") as f:
                _SKILL_DEFS = json.load(f).get("skills", {})
        except (OSError, ValueError):
            return True
    sk = _SKILL_DEFS.get(OWNER_TERRAINS.get(terrain))
    return not sk or sk.get("say") is not False

_MOB_DEFS = None
def mob_defs():
    global _MOB_DEFS
    if _MOB_DEFS is None:
        try:
            with open(os.path.join(CLIENT, "assets", "mobs", "mobs.json"), encoding="utf-8") as f:
                _MOB_DEFS = json.load(f).get("mobs", [])
        except (OSError, ValueError):
            return []
    return _MOB_DEFS

def quote_def(terrain):
    """台詞招式設定：(quoteChance, lineSkills) 或 None（與 Worker 的 pickQuote 同一套）。"""
    owner_says(terrain)   # 確保 skills.json 已載入
    style = OWNER_TERRAINS.get(terrain)
    sk = (_SKILL_DEFS or {}).get(style) or {}
    ch = sk.get("quoteChance") or 0
    if ch <= 0:
        return None
    for m in mob_defs():
        if m.get("owner") and m.get("atk") == style and isinstance(m.get("lineSkills"), list):
            return ch, m["lineSkills"]
    return None

_FLOOR_DEFS = None
def floor_defs():
    """地板 id -> (w, h)，取自前端 floors.json（沒標的是 1×1），用來驗證地板操作。"""
    global _FLOOR_DEFS
    if _FLOOR_DEFS is None:
        with open(os.path.join(CLIENT, "assets", "floors", "floors.json"), encoding="utf-8") as f:
            _FLOOR_DEFS = {it["id"]: (it.get("w", 1), it.get("h", 1)) for it in json.load(f)["items"]}
    return _FLOOR_DEFS

FLOOR_MAX = 4   # 多格地板的最大邊長（與 Worker 一致）

def floor_at(floor, x, y):
    """蓋住 (x,y) 的地板錨點 (ax, ay)，沒有回 None。多格地板（例如地毯 2×2）只在錨點格（左上）存一筆。"""
    defs = floor_defs()
    for dy in range(FLOOR_MAX):
        for dx in range(FLOOR_MAX):
            a = (x - dx, y - dy)
            if a[0] < 0 or a[1] < 0 or a not in floor:
                continue
            w, h = defs.get(floor[a], (1, 1))
            if dx < w and dy < h:
                return a
    return None

def floor_to_list(floor):
    """地板 {(x,y): id} → [[x,y,id],…]（與 Worker 的儲存/廣播格式相同）。"""
    return [[x, y, fid] for (x, y), fid in floor.items()]

class Room:
    """一座島＝一個房間（鍵：guild:channel）。"""
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}   # cid -> {"sock":socket, "send":Lock, "state":dict}
        self.order = 0
        self.furn = {}          # 地形 -> [{"type","cell":[x,y]}]，擺設依地形各自一份
        self.floor = {}         # 地形 -> {(x,y): 地板id}，地板層（與家具各自獨立）
        self.decos = {}         # 地形 -> {物件編號: {"hp","cell","until"(ms)}}，只存受損/已破壞的
        # 島主（伺服器端同步）：每座有島主的地形各一隻（狀態/島形/計時器都以地形為 key）
        self.dragons = {}        # 地形 -> 島主狀態 dict（懒初始化）
        self.dragon_maps = {}    # 地形 -> 陸地位圖 list[int]
        self.dragon_hits = {}    # cid -> (地形, 上次打島主的時刻 ms)
        self.provokes = {}       # cid -> 上次挑釁的時刻（ms）（挑釁冷卻只在成功出手時計）
        self.debuffs = {}        # cid -> {"vuln": ms, "weak": ms}：上次放破綻／降傷的時刻
        self.skill_hits = {}     # cid -> {"技能:owner|lurker": ms}：職業技能打怪的冷卻
        self.dragon_timers = {}  # 地形 -> 重生計時器
        self.wander_tick_seq = {}   # 地形 -> 散步 tick 序號（只讓最新排程生效）
        self.lurkers = {}        # 地形 -> 釣上來的敵對怪物狀態（每個地形同時最多一隻）
        self.lurk_hits = {}      # cid -> (地形, 上次打怪物的時刻 ms)
        self.lurk_seq = {}       # 地形 -> 怪物 tick 序號（只讓最新排程生效）
        # 每位玩家各自在某個地形（client["terrain"]）；剛連上時為 None，等 enter

    def floor_map(self, terrain):
        return self.floor.setdefault(terrain, {})

    def edit_floor(self, op, terrain):
        """地板操作 {"t":"floor","cell":[x,y],"type":id|None}（None＝拆除）。回傳 True 表示有變動。呼叫時需持有 self.lock。
        多格地板彼此不重疊、單格地板不能鋪在多格地板上；鋪多格地板會取代範圍內的單格地板；拆除點到任一格就整塊拆。
        地板可以鋪在水上；水上那格有家具時不能拆（要先拿走家具），陸地上的地板不受限制（還沒收到島形時不檢查）。
        規則與 worker/src/index.js、client/js/main.js 的 applyFloorOp 一致（改一邊要改另一邊）。"""
        cell = op.get("cell")
        if not (isinstance(cell, list) and len(cell) == 2 and all(isinstance(v, int) and not isinstance(v, bool) for v in cell)):
            return False
        x, y = cell
        if x < 0 or y < 0 or x >= COLS or y >= ROWS:
            return False
        floor, typ, defs = self.floor_map(terrain), op.get("type"), floor_defs()
        if typ is None:
            a = floor_at(floor, x, y)
            if a is None:
                return False
            land, items = self.dragon_maps.get(terrain), self.furn_list(terrain)
            if land:   # 拆掉後水上那格會沒有地板：上面有家具就不能拆
                w, h = defs.get(floor[a], (1, 1))
                for dy in range(h):
                    for dx in range(w):
                        cx, cy = a[0] + dx, a[1] + dy
                        if cx < COLS and cy < ROWS and not land[cy * COLS + cx] and cell_has_furn(items, [cx, cy]):
                            return False
            return floor.pop(a, None) is not None
        if not isinstance(typ, str) or typ not in defs:
            return False
        w, h = defs[typ]
        if x + w > COLS or y + h > ROWS:
            return False
        cov = []
        for dy in range(h):
            for dx in range(w):
                a = floor_at(floor, x + dx, y + dy)
                if a is None:
                    continue
                tw, th = defs.get(floor[a], (1, 1))
                if tw * th > 1:
                    return False   # 壓到多格地板（地毯）：不重疊
                cov.append(a)
        if w * h == 1 and len(cov) == 1 and floor[cov[0]] == typ:
            return False   # 同一種，沒變
        for a in cov:
            floor.pop(a, None)
        floor[(x, y)] = typ
        return True

    def furn_list(self, terrain):
        return self.furn.setdefault(terrain, [])

    def prune_decos(self, terrain):
        """已破壞、到了重生時間、且該格沒有家具的 → 回到滿血（移除紀錄）。呼叫時需持有 self.lock。"""
        m, items, now = self.decos.setdefault(terrain, {}), self.furn_list(terrain), time.time() * 1000
        for i in [i for i, e in m.items() if e["hp"] <= 0 and e["until"] <= now and not cell_has_furn(items, e["cell"])]:
            del m[i]
        return m

    def deco_list(self, terrain):
        now = time.time() * 1000
        return [{"i": i, "hp": e["hp"], "ttl": max(0, int(e["until"] - now)) if e["hp"] <= 0 else 0}
                for i, e in self.prune_decos(terrain).items()]

    def hit_deco(self, cid, msg):
        """打可破壞物件：血量由伺服器扣。回傳要廣播的 (地形, 訊息)；無效回 None。
        物件編號 i 是客戶端依地形種子確定性產生的順序；伺服器不重建世界，只驗證格式、距離與目標種類。"""
        i, cell = msg.get("i"), msg.get("cell")
        isint = lambda v: isinstance(v, int) and not isinstance(v, bool)
        if not isint(i) or not 0 <= i < 5000:
            return None
        if not (isinstance(cell, list) and len(cell) == 2 and all(isint(v) for v in cell)
                and 0 <= cell[0] < COLS and 0 <= cell[1] < ROWS):
            return None
        tgt = deco_targets().get(str(msg.get("sprite")))
        if not tgt:
            return None
        with self.lock:
            c = self.clients.get(cid)
            if c is None or not c["terrain"] or not c["state"]:
                return None
            st = c["state"]
            try:
                d = math.hypot(cell[0] * CELL + CELL / 2 - float(st["x"]), (cell[1] + .5) * CELL - float(st["y"]))
            except Exception:
                return None
            if not d <= HIT_RANGE:
                return None
            terrain = c["terrain"]
            m = self.prune_decos(terrain)
            e = m.get(i) or {"hp": tgt["hp"], "cell": cell}
            if e["hp"] <= 0:
                return None
            e["hp"] -= 1
            e["cell"] = cell
            ttl = int((tgt.get("respawn") or 60) * 1000)
            if e["hp"] <= 0:
                e["until"] = time.time() * 1000 + ttl
            m[i] = e
            return terrain, {"t": "deco", "i": i, "hp": e["hp"], "ttl": ttl if e["hp"] <= 0 else 0, "by": cid}

    def edit_furn(self, msg, terrain):
        """家具編輯（伺服器為唯一權威）。回傳 True 表示有變動。呼叫時需持有 self.lock。"""
        defs, items, t = furn_defs(), self.furn_list(terrain), msg.get("t")
        cell = msg.get("cell")
        valid = isinstance(cell, list) and len(cell) == 2 and all(isinstance(v, int) and not isinstance(v, bool) for v in cell)
        if t == "place":
            d = defs.get(str(msg.get("type")))
            if not d or not valid or len(items) >= MAX_FURN:
                return False
            x, y = cell
            if x < 0 or y < 0 or x + d[0] > COLS or y + d[1] > ROWS:
                return False
            land = self.dragon_maps.get(terrain)
            if land:   # 水上的格子要有地板（與 Worker 的 applyFurnOp、main.js 的 canPlaceIn 一致；還沒收到島形時不檢查）
                floor = self.floor_map(terrain)
                for dy in range(d[1]):
                    for dx in range(d[0]):
                        if not land[(y + dy) * COLS + x + dx] and floor_at(floor, x + dx, y + dy) is None:
                            return False
            for it in items:
                w, h = defs.get(it["type"], (1, 1))
                if x < it["cell"][0] + w and it["cell"][0] < x + d[0] and y < it["cell"][1] + h and it["cell"][1] < y + d[1]:
                    return False
            items.append({"type": str(msg["type"]), "cell": [x, y]})
            return True
        if t == "remove":
            if not valid:
                return False
            for i, it in enumerate(items):
                w, h = defs.get(it["type"], (1, 1))
                if it["cell"][0] <= cell[0] < it["cell"][0] + w and it["cell"][1] <= cell[1] < it["cell"][1] + h:
                    del items[i]
                    return True
            return False
        if t == "clear":
            items.clear()
            return True
        return False

    def edit_sign(self, terrain, cell, text):
        """看板改字：所有人都能改。只接受標了 text 的家具、最多 SIGN_MAX 字。回傳 True 表示有變動。"""
        if not (isinstance(cell, list) and len(cell) == 2 and all(isinstance(v, int) and not isinstance(v, bool) for v in cell)):
            return False
        text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(text if text is not None else ""))[:SIGN_MAX].strip()
        defs = furn_defs()
        with self.lock:
            for it in self.furn_list(terrain):
                w, h = defs.get(it["type"], (1, 1))
                if it["type"] in text_types() and it["cell"][0] <= cell[0] < it["cell"][0] + w and it["cell"][1] <= cell[1] < it["cell"][1] + h:
                    if text:
                        it["text"] = text
                    else:
                        it.pop("text", None)
                    return True
        return False

    def commit_furn(self, terrain, ops, admin):
        """一批擺設操作：每個各自驗證（不合法的跳過），「清空」只有管理員能做。回傳 (applied, rejected, denied)。"""
        applied = rejected = 0
        denied = False
        furn_changed = floor_changed = False
        with self.lock:
            for op in ops[:MAX_OPS]:
                if not isinstance(op, dict):
                    rejected += 1
                elif op.get("t") == "floor":   # 地板層：不看身分；水上有家具的地板不能拆
                    if self.edit_floor(op, terrain):
                        applied += 1; floor_changed = True
                    else:
                        rejected += 1
                elif op.get("t") == "clear" and not admin:
                    denied = True
                elif self.edit_furn(op, terrain):
                    applied += 1; furn_changed = True
                else:
                    rejected += 1
        return applied, rejected, denied, furn_changed, floor_changed

    # ---- 島主（伺服器端同步）----
    def dragon_state(self, terrain):
        """該地形島主的狀態（懒初始化；每座地形各一隻）。"""
        d = self.dragons.get(terrain)
        if d is None:
            d = self.dragons[terrain] = {"hp": D_HP, "st": "idle", "pos": list(D_CENTER), "aim_tms": 0.0, "dead_at": 0.0,
                           "gen": 0, "wander": None, "wander_gen": 0, "cooldown_until": 0.0, "say_until": 0.0,
                           "warp": [0, 0], "atk": [0, 0], "unit": [0, 0], "dest": [0, 0], "dash_len": 0.0, "beam": [0, 0],
                           "regen_t": 0.0, "aggro": None, "last_hit_at": 0.0, "quote": None, "last_line": -1}
        return d

    def dragon_regen(self, terrain, now):
        """回血：每秒回 D_REGEN 點（用牆鐘 lazy 計算，不需要計時器；滿血或死亡時把錨點重置為現在，
        扣血後才重新開始累積；與 worker/src/index.js 的 regenDragon 同一套演算法）。"""
        d = self.dragon_state(terrain)
        if d["st"] == "dead" or d["hp"] >= D_HP:
            d["regen_t"] = now
            return
        n = int((now - d["regen_t"]) // 1000)
        if n > 0:
            d["hp"] = min(D_HP, d["hp"] + n * D_REGEN)
            d["regen_t"] = now if d["hp"] >= D_HP else d["regen_t"] + n * 1000

    # ---- 島主仇恨（反擊冷卻中的追殺行為）----
    def aggro_candidates(self, now, terrain, win=D_DROPOUT):
        """D_DROPOUT（30 秒）內在該地形打過島主、還在線上沒死的人：回 [(cid, client), ...]。"""
        out = []
        for cid, c in self.clients.items():
            h = self.dragon_hits.get(cid)
            if not h or h[0] != terrain or now - h[1] > win:
                continue
            st = c.get("state")
            if c.get("terrain") == terrain and st and not st.get("dead"):
                out.append((cid, c))
        return out

    def aggro_target(self, cid, terrain):
        """依連線 id 找仇恨目標（斷線／離開該地形／死了就找不到）。"""
        c = self.clients.get(cid)
        st = c.get("state") if c else None
        if c and c.get("terrain") == terrain and st and not st.get("dead"):
            return cid, c
        return None, None

    def _aggro_start(self, cid, c, terrain):
        """開始/切換追殺：設定狀態並回要廣播的訊息。需在鎖內。"""
        d = self.dragon_state(terrain)
        d["aggro"] = {"id": cid, "rotate_at": time.time() * 1000 + D_AGGRO_MS,
                      "claw_at": time.time() * 1000 + D_CLAW_MS}
        d["wander"] = None
        print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 仇恨開始 → {cid}", file=sys.stderr, flush=True)
        return {"t": "dragon", "ev": "aggro", "id": cid,
                "name": (c.get("state") or {}).get("name") or "玩家"}

    def _aggro_drop(self, terrain, chill=True):
        """脫離仇恨：回要廣播的訊息清單。需在鎖內。"""
        d = self.dragon_state(terrain)
        d["aggro"] = None
        return [{"t": "dragon", "ev": "chill"}] if chill else []

    def _aggro_start_leg(self, now, pos, tx, ty, terrain):
        """追殺腿：直線朝目標目前位置（速度 D_CHASE）。需在鎖內；回 wander 訊息。
        不走海：島主在陸地時，直線前方連續 3 格是水就截在海邊（0.6 秒後的重新瞄準會繼續沿岸繞）；
        本來就在水裡（舊狀態卡海）則不截，直線走回陸地。"""
        d = self.dragon_state(terrain)
        m = self.dragon_maps.get(terrain)
        if m:
            gx0, gy0 = int(pos[0] // CELL), int(pos[1] // CELL)
            on_land = 0 <= gx0 < COLS and 0 <= gy0 < ROWS and m[gy0 * COLS + gx0]
            steps = max(1, math.ceil(math.hypot(tx - pos[0], ty - pos[1]) / CELL))
            water = 0
            for s in range(1, steps + 1):
                t = s / steps
                sx, sy = pos[0] + (tx - pos[0]) * t, pos[1] + (ty - pos[1]) * t
                gx, gy = int(sx // CELL), int(sy // CELL)
                if on_land and (not (0 <= gx < COLS and 0 <= gy < ROWS) or not m[gy * COLS + gx]):
                    water += 1
                    if water >= 3:   # 連續 3 格水：截在海邊最後的陸地
                        t = max(0.0, (s - water) / steps)
                        tx = pos[0] + (tx - pos[0]) * t
                        ty = pos[1] + (ty - pos[1]) * t
                        break
                else:
                    water = 0
        dist = math.hypot(tx - pos[0], ty - pos[1])
        tms = max(80, int(dist / D_CHASE * 1000))
        d["wander"] = {"fx": pos[0], "fy": pos[1], "tx": tx, "ty": ty, "tms": tms, "t0": now, "pause": 0}
        return {"t": "dragon", "ev": "wander", "fx": pos[0], "fy": pos[1], "tx": tx, "ty": ty, "tms": tms}

    def dragon_phase(self, now, terrain):
        """由 aim_tms 推導現在的階段（cast/aim/dash/rest/idle/dead），回 (階段, 座標, 剩餘 ms)。"""
        d = self.dragon_state(terrain)
        if d["st"] == "dead":
            return "dead", list(d["pos"]), 0
        if not d["aim_tms"]:
            if d["say_until"] and now < d["say_until"]:
                return "say", list(d["pos"]), int(d["say_until"] - now)   # 說台詞中：原地不動
            if d.get("quote"):
                return "quote", list(d["pos"]), 0   # 台詞招式放招中：原地不動
            if not d["wander"]:
                return "idle", list(d["pos"]), 0
            w = d["wander"]
            t = max(0.0, min(1.0, (now - w["t0"]) / w["tms"]))
            return "idle", [w["fx"] + (w["tx"] - w["fx"]) * t, w["fy"] + (w["ty"] - w["fy"]) * t], 0
        style = OWNER_TERRAINS.get(terrain)
        if style in ("gaze", "beam"):   # 原地施放（石化之瞳開眼／波動砲讀條）：不瞬移不移動，放完就地回 idle
            cast_ms = D_GAZE_CAST_MS if style == "gaze" else D_BEAM_CAST_MS
            dt = now - d["aim_tms"]
            if dt < cast_ms:
                return "cast", list(d["pos"]), int(cast_ms - dt)
            return "idle", list(d["pos"]), 0
        dt = now - d["aim_tms"]
        if dt < D_CAST_MS:
            return "aim", list(d["warp"]), int(D_CAST_MS - dt)
        dt -= D_CAST_MS
        dash_ms = d["dash_len"] / D_DASH * 1000
        if dt < dash_ms:
            p = dt / 1000 * D_DASH
            return "dash", [d["warp"][0] + d["unit"][0] * p, d["warp"][1] + d["unit"][1] * p], dash_ms - dt
        dt -= dash_ms
        if dt < D_REST_MS:
            return "rest", list(d["dest"]), int(D_REST_MS - dt)
        return "idle", list(d["dest"]), 0   # 衝完在對岸就地閒晃（不回中心）

    def dragon_snapshot(self, terrain):
        """給剛進該地形的玩家的島主快照（把現在階段包成客戶端能續播的欄位）。呼叫前需持有或取得狀態。"""
        now_ms = time.time() * 1000
        self.dragon_regen(terrain, now_ms)   # 讀快照前先把該補的血補上（快照帶 hp）
        ph, pos, ms = self.dragon_phase(now_ms, terrain)
        d = self.dragon_state(terrain)
        o = {"ph": ph, "x": pos[0], "y": pos[1], "hp": d["hp"]}
        if d["aggro"]:   # 仇恨中：附上追殺目標（中途進場的人才知道牠在戰鬥）
            o["aggro"] = d["aggro"]["id"]
        if ph == "aim":
            o.update(castMs=int(ms), tx=d["atk"][0], ty=d["atk"][1], dx=d["dest"][0], dy=d["dest"][1])
        elif ph == "cast":   # 石化之瞳：開眼中（直線已鎖定）
            o.update(castMs=int(ms), tx=d["atk"][0], ty=d["atk"][1], bx=d["beam"][0], by=d["beam"][1])
        elif ph == "dash":
            o.update(ux=d["unit"][0], uy=d["unit"][1], dx=d["dest"][0], dy=d["dest"][1])
        elif ph == "rest":
            o["restMs"] = int(ms)
        elif ph == "idle" and d["wander"]:   # 散步中：附上路點與已走時間，客戶端接著插值
            w = d["wander"]
            now_ms = time.time() * 1000
            o["wleg"] = {"fx": w["fx"], "fy": w["fy"], "tx": w["tx"], "ty": w["ty"], "tms": w["tms"],
                         "el": int(max(0, min(w["tms"], now_ms - w["t0"])))}
        elif ph == "say":   # 說台詞中：附上剩餘時間
            o["sayMs"] = int(ms)
        if d.get("quote"):   # 台詞招式中：哪一句（中途進場的人也看到同一句）
            o["line"] = d["quote"]["line"]
        for k in ("vuln", "weak"):   # 破綻／降傷剩餘時間
            if now_ms < d.get(k + "_until", 0.0):
                o[k + "Ms"] = int(d[k + "_until"] - now_ms)
        return o

    def _dragon_start_leg(self, terrain):
        """idle 時挑一個新路點散步（附近 6～16 格陸地、直線別太抄水；與 client 的 ownerPickLeg 一致）。
        挑不到回 None。需在鎖內呼叫；回傳要廣播的 wander 訊息。"""
        d = self.dragon_state(terrain)
        m = self.dragon_maps.get(terrain)
        if d["st"] == "dead" or not m:
            return None
        ph, pos, _ = self.dragon_phase(time.time() * 1000, terrain)
        if ph != "idle":
            return None
        fx, fy = pos[0], pos[1]
        # 卡海自救（舊狀態）：島主在海裡時先拉回最近的陸地，散步才挑得到路點
        gx0, gy0 = int(fx // CELL), int(fy // CELL)
        if not (0 <= gx0 < COLS and 0 <= gy0 < ROWS and m[gy0 * COLS + gx0]):
            land = dragon_nearest_land(m, fx, fy)
            if land:
                fx, fy = land[0], land[1]
                d["pos"] = [fx, fy]
        for _ in range(24):
            ang = random.random() * math.pi * 2
            dist = (6 + random.random() * 10) * CELL
            tx, ty = fx + math.cos(ang) * dist, fy + math.sin(ang) * dist
            gx, gy = js_round(tx / CELL - .5), js_round(ty / CELL - .5)
            if not (1 <= gx < COLS - 1 and 1 <= gy < ROWS - 1) or not m[gy * COLS + gx]:
                continue
            steps = max(1, math.ceil(dist / CELL))
            water = 0
            for s in range(steps + 1):
                sx, sy = fx + (tx - fx) * s / steps, fy + (ty - fy) * s / steps
                if not m[math.floor(sy / CELL) * COLS + math.floor(sx / CELL)]:
                    water += 1
            if water / (steps + 1) > 0.1:
                continue
            tms = max(1500, int(dist / D_WALK * 1000))
            d["wander"] = {"fx": fx, "fy": fy, "tx": gx * CELL + CELL / 2, "ty": gy * CELL + CELL / 2, "tms": tms,
                           "t0": time.time() * 1000, "pause": random.uniform(*D_WANDER_PAUSE) * 1000}
            print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 散步腿（aggro={'有' if d.get('aggro') else '無'}）fx=({fx:.0f},{fy:.0f}) → ({d['wander']['tx']:.0f},{d['wander']['ty']:.0f})", file=sys.stderr, flush=True)
            return {"t": "dragon", "ev": "wander", "fx": fx, "fy": fy, "tx": d["wander"]["tx"],
                    "ty": d["wander"]["ty"], "tms": tms}
        return None

    def _has_clients(self, terrain):
        return any(c.get("terrain") == terrain for c in self.clients.values())

    def _schedule_wander_tick(self, delay, gen, terrain):
        """排下一次散步狀態機 tick；只讓「最新排程」生效（多次 enter 不會堆出重複計時器）。"""
        seq = self.wander_tick_seq.get(terrain, 0) + 1
        self.wander_tick_seq[terrain] = seq
        t = threading.Timer(delay, self._wander_tick, (terrain, gen, seq))
        t.daemon = True
        t.start()

    def _wander_tick(self, terrain, gen, seq):
        """散步/仇恨狀態機：到期推進路點、或仇恨追殺的每秒 tick。序號/代數不符＝被更新的排程或反擊/死亡作廢；該地形沒人＝停擺。"""
        outs = []
        next_delay = None
        with self.lock:
            d = self.dragon_state(terrain)
            if seq != self.wander_tick_seq.get(terrain, 0) or gen != d["wander_gen"]:
                return
            if d["st"] == "dead" or not self._has_clients(terrain):
                return
            now = time.time() * 1000
            if d.get("quote"):   # 台詞招式：說完台詞後依序放招
                outs, next_delay = self._quote_tick_locked(now, terrain)
            elif d.get("aggro"):   # 仇恨中：追殺＋爪擊（tick 自己排下一次）；掛保險：tick 出錯就清仇恨讓散步接手，不會卡死
                try:
                    outs, next_delay = self._aggro_tick_locked(now, terrain)
                except Exception:
                    traceback.print_exc()
                    d["aggro"] = None
                    next_delay = 0.5
            elif d["say_until"] and now >= d["say_until"]:   # 說完台詞：開始反擊循環
                msg = self._dragon_start_cycle(now, terrain)
                style = OWNER_TERRAINS.get(terrain)
                if style == "gaze":
                    next_delay = (D_GAZE_CAST_MS / 1000 + 0.1) if msg else 2.0
                elif style == "beam":
                    next_delay = (D_BEAM_CAST_MS / 1000 + 0.1) if msg else 2.0
                else:
                    next_delay = ((D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS) / 1000 + 0.1) if msg else 2.0
                outs = [msg] if msg else []
            elif d["say_until"]:   # 還在說台詞：說完再醒
                next_delay = (d["say_until"] - now) / 1000 + 0.05
            else:
                ph, _, _ = self.dragon_phase(now, terrain)
                if ph != "idle":   # 反擊循環中：循環結束時再續
                    next_delay = max(0.1, self._cycle_end(terrain, now) / 1000 - time.time() + 0.1)
                else:
                    if d["aim_tms"]:   # 反擊循環剛結束：龍衝落在對岸（dest）；石化之瞳／波動砲留在原地。清 aim_tms 讓散步插值生效
                        d["aim_tms"] = 0.0
                        if OWNER_TERRAINS.get(terrain) not in ("gaze", "beam"):
                            d["pos"] = list(d["dest"])
                    w = d["wander"]
                    if w and now < w["t0"] + w["tms"] + w["pause"]:
                        next_delay = (w["t0"] + w["tms"] + w["pause"] - now) / 1000 + 0.05
                    else:
                        out = self._dragon_start_leg(terrain)
                        if out: outs.append(out)
                        next_delay = ((d["wander"]["tms"] + d["wander"]["pause"]) / 1000 + 0.05) if out else 2.0
        # 帶傷回血：補血並把變化廣播出去（lazy 回血原本只在被打／快照時結算，血條會卡住不動）
        if d["st"] != "dead" and d["hp"] < D_HP:
            before = d["hp"]
            self.dragon_regen(terrain, now)
            if d["hp"] != before:
                outs.append({"t": "dragon", "ev": "hp", "hp": d["hp"]})
        for m in outs:
            self.broadcast(m, terrain=terrain)
        if next_delay is not None:
            if d["st"] != "dead" and d["hp"] < D_HP:   # 帶傷：下一次醒來提早到「回滿血時刻」，屆時補滿並廣播一次（不用定期輪詢）
                full_at = d["regen_t"] + math.ceil((D_HP - d["hp"]) / D_REGEN) * 1000
                next_delay = min(next_delay, max(0.1, (full_at - now) / 1000 + 0.05))
            self._schedule_wander_tick(next_delay, gen, terrain)

    # ---- 台詞招式（黃金肥龍；與 Worker 的 pickQuote／startQuote／quoteTargets／stepQuote 同一套）----
    def _pick_quote(self, terrain):
        """被激怒時要不要改放台詞招式：回 {"line","skills"} 或 None。需在鎖內。"""
        qd = quote_def(terrain)
        if not qd or random.random() >= qd[0]:
            return None
        d = self.dragon_state(terrain)
        cands = [i for i, v in enumerate(qd[1]) if v and i != d.get("last_line", -1)]
        if not cands:
            return None
        line = random.choice(cands)
        d["last_line"] = line
        return {"line": line, "skills": list(qd[1][line])[:3]}

    def _start_quote(self, now, terrain, q, pos):
        """開始台詞招式：原地說台詞，之後每 Q_GAP_MS 放一招。需在鎖內；回 say 訊息與下一次 tick 延遲（秒）。"""
        d = self.dragon_state(terrain)
        d["wander"] = None
        d["aim_tms"] = 0.0
        d["pos"] = [pos[0], pos[1]]
        d["say_until"] = now + D_SAY_MS
        fires = [d["say_until"] + Q_GAP_MS * (i + 1) for i in range(len(q["skills"]))]
        d["quote"] = {"line": q["line"], "skills": q["skills"], "fires": fires, "fired": 0}
        d["cooldown_until"] = fires[-1] + D_RAGE_MS   # 不動 wander_gen：仇恨 tick 裡呼叫時，這次 tick 排的下一次還要有效
        print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 台詞招式 #{q['line']} {q['skills']}", file=sys.stderr, flush=True)
        return ({"t": "dragon", "ev": "say", "x": d["pos"][0], "y": d["pos"][1], "ms": D_SAY_MS, "line": q["line"]},
                (fires[0] - now) / 1000)

    def _quote_targets(self, terrain, skill, d):
        alive = [cid for cid, c in self.clients.items()
                 if c.get("terrain") == terrain and c.get("state") and not c["state"].get("dead")]
        if not alive:
            return []
        if skill == "meteor":
            return alive
        if skill == "dive":
            ag = d.get("aggro")
            return [ag["id"] if ag and ag["id"] in alive else random.choice(alive)]
        if skill == "ion":
            return [random.choice(alive)]
        return []

    def _quote_tick_locked(self, now, terrain):
        """推進台詞招式：到點的招式依序廣播 qfire；放完結束（仇恨保持，接著追殺）。需在鎖內；回 (訊息, 延遲秒)。"""
        d = self.dragon_state(terrain)
        q = d["quote"]
        outs = []
        while q["fired"] < len(q["skills"]) and now >= q["fires"][q["fired"]] - 30:
            sk = q["skills"][q["fired"]]
            outs.append({"t": "dragon", "ev": "qfire", "skill": sk, "i": q["fired"], "x": d["pos"][0], "y": d["pos"][1],
                         "ids": self._quote_targets(terrain, sk, d)})
            q["fired"] += 1
        if q["fired"] >= len(q["skills"]):
            d["quote"] = None
            d["say_until"] = 0.0
            return outs, 0.4
        return outs, max(0.05, (q["fires"][q["fired"]] - now) / 1000)

    def _cycle_end(self, terrain, now):
        """反擊循環（aim_tms 起算）結束的絕對時間 ms。"""
        d = self.dragon_state(terrain)
        style = OWNER_TERRAINS.get(terrain)
        if style == "gaze":
            return d["aim_tms"] + D_GAZE_CAST_MS
        if style == "beam":
            return d["aim_tms"] + D_BEAM_CAST_MS
        return d["aim_tms"] + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS

    def _aggro_tick_locked(self, now, terrain):
        """仇恨狀態的 tick（需在鎖內）：追殺目標（每腿重新瞄準目標目前位置）、進爪擊範圍就站定每秒一抓、
        目標死了或 5 秒到隨機換攻擊者、反擊 CD 一到自動放招、超過 D_DROPOUT 沒人打就脫離仇恨回閒晃。
        回 (要廣播的訊息清單, 下一次 tick 延遲秒數)。"""
        d = self.dragon_state(terrain)
        ag = d["aggro"]
        outs = []
        # 太久沒有人攻擊／沒有島形：脫離仇恨，回閒晃
        if not self.dragon_maps.get(terrain) or now - d.get("last_hit_at", 0.0) > D_DROPOUT:
            print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 脫離仇恨（最後被打在 {now - d.get('last_hit_at', 0.0):.0f}ms 前）", file=sys.stderr, flush=True)
            outs += self._aggro_drop(terrain)
            return outs, 0.15
        cid, c = self.aggro_target(ag["id"], terrain)
        if cid is None or now >= ag["rotate_at"]:
            # 目標死了或 5 秒到：隨機換下一個攻擊者（沒有其他人就維持原目標）
            cands = [(i, cc) for i, cc in self.aggro_candidates(now, terrain) if i != ag["id"]]
            if cands:
                cid, c = random.choice(cands)
                ag["id"] = cid
                ag["rotate_at"] = now + D_AGGRO_MS
                ag["claw_at"] = now + D_CLAW_MS
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 仇恨換目標 → {cid}", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "aggro", "id": cid,
                             "name": (c.get("state") or {}).get("name") or "玩家"})
            elif cid is None:   # 目標死了又沒有其他人可換：脫離仇恨回閒晃
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 目標已死且無人可換：脫離仇恨", file=sys.stderr, flush=True)
                outs += self._aggro_drop(terrain)
                return outs, 0.15
        # 反擊冷卻到了：直接對現在的仇恨目標放招（龍衝＝瞬移島緣→預警→衝穿牠；石化之瞳＝原地開眼）；仇恨保持
        if now >= d["cooldown_until"]:
            st = c["state"]
            ph, pos2, _ = self.dragon_phase(now, terrain)
            q = self._pick_quote(terrain)
            if q:   # 台詞招式：原地說台詞後依序放招，仇恨保持
                say, delay = self._start_quote(now, terrain, q, pos2)
                outs.append(say)
                return outs, D_SAY_MS / 1000 + 0.05
            d["wander"] = None
            d["pos"] = [pos2[0], pos2[1]]   # 打斷追腿：位置同步到目前插值點（同 say 的理由）
            d["atk"] = [float(st.get("x", 0)), float(st.get("y", 0))]
            msg = self._dragon_start_cycle(now, terrain)
            print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 仇恨中 CD 到：自動對目標放招", file=sys.stderr, flush=True)
            if msg:
                outs.append(msg)
            return outs, 0.15
        ph, pos, _ = self.dragon_phase(now, terrain)
        if ph == "say":   # 還在說台詞：說完（會由 tick 接手反擊）再醒，期間不追不抓
            return outs, (d["say_until"] - now) / 1000 + 0.08
        if ph != "idle":   # 預警/龍衝/開眼中：不追不抓、不發 wander（避免 client 的演出被 wander 事件打斷），等循環結束再醒
            return outs, max(0.1, self._cycle_end(terrain, now) / 1000 - time.time() + 0.08)
        if d["aim_tms"]:   # 反擊循環剛結束（仇恨中沒有人清 aim_tms）：清掉讓之後的追腿正常插值
            d["aim_tms"] = 0.0
            if OWNER_TERRAINS.get(terrain) not in ("gaze", "beam"):
                d["pos"] = list(d["dest"])
        st = c["state"]
        tx, ty = float(st.get("x", 0)), float(st.get("y", 0))
        dist = math.hypot(tx - pos[0], ty - pos[1])
        if dist <= D_CLAW_RANGE:
            # 進爪擊範圍：站定連抓（每秒一下）；記下位置，快照不會跳回舊點
            if now >= ag["claw_at"]:
                ag["claw_at"] = now + D_CLAW_MS
                d["wander"] = None
                d["pos"] = [pos[0], pos[1]]
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 爪擊 → {cid}（距離 {dist:.0f}）", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "claw", "x": pos[0], "y": pos[1], "tx": tx, "ty": ty, "id": cid})
        else:
            w = d["wander"]
            # 腿走完、或走了 0.6 秒就重新瞄準：緊咬目標現在的位置（否則島主只會抓到幾秒前的舊位置＝抓空氣）
            if not w or now >= w["t0"] + w["tms"] or now >= w["t0"] + 600:
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 追殺腿 → 目標 {cid}（距離 {dist:.0f}）", file=sys.stderr, flush=True)
                outs.append(self._aggro_start_leg(now, pos, tx, ty, terrain))
        # 下一個醒的時間：腿走完／爪擊／換人／反擊 CD／脫離時限，取最近
        ends = [ag["rotate_at"], d["cooldown_until"], d.get("last_hit_at", 0.0) + D_DROPOUT, ag["claw_at"]]
        w = d["wander"]
        if w:
            ends.append(w["t0"] + w["tms"] + 50)
        return outs, max(0.08, min(ends) / 1000 - time.time() + 0.02)

    def _skill_hit(self, cid, st, msg, kind, now):
        """職業技能的命中（msg.sk）：回 dict(dmg, range)；不是技能＝None；不合法（職業不對、冷卻中）＝False。呼叫前要持有 lock。"""
        if not msg.get("sk"):
            return None
        sk = SKILL_HITS.get(msg.get("sk"))
        if not sk or st.get("job") != sk["job"] or st.get("dead"):
            return False
        book = self.skill_hits.setdefault(cid, {})
        key = f'{msg["sk"]}:{kind}'
        if now - book.get(key, 0.0) < sk["cd_ms"]:
            return False
        book[key] = now
        return {"dmg": sk["dmg"], "range": sk["range"]}

    def dragon_debuff(self, cid, msg):
        """破綻／降傷（R 鍵，近戰／遠程輸出）：驗證職能、距離、冷卻後記在島主狀態；回 (地形, 廣播訊息) 或 None。"""
        with self.lock:
            c = self.clients.get(cid)
            if c is None or not c["terrain"] or not c["state"]:
                return None
            terrain, st = c["terrain"], c["state"]
            if terrain not in OWNER_TERRAINS:
                return None
            kind = msg.get("kind") if msg.get("kind") in ("vuln", "weak") else None
            if not kind or st.get("dead") or role_of(st) != ("melee" if kind == "vuln" else "ranged"):
                return None
            d = self.dragon_state(terrain)
            if d["st"] == "dead":
                return None
            now = time.time() * 1000
            book = self.debuffs.setdefault(cid, {})
            if now - book.get(kind, 0.0) < D_DEBUFF_CD_MS - 1000:
                return None
            _, pos, _ = self.dragon_phase(now, terrain)
            if math.hypot(float(st.get("x") or 0) - pos[0], float(st.get("y") or 0) - pos[1]) > D_PROVOKE_RANGE:
                return None
            book[kind] = now
            d[kind + "_until"] = now + D_DEBUFF_MS
            return terrain, {"t": "dragon", "ev": "debuff", "kind": kind, "ms": D_DEBUFF_MS, "id": cid, "name": st.get("name") or "玩家"}

    def dragon_hit(self, cid, msg):
        """打到島主：扣血；閒置且冷卻過了 → 開始反擊；冷卻中 → 納入仇恨。回傳要廣播的訊息清單（空清單＝無效/太遠/飛行中）。
        攻擊者所在地形決定打的是哪座島的島主。"""
        outs = []
        dead_gen = None
        post_cycle = None
        terrain = None
        with self.lock:
            c = self.clients.get(cid)
            if c is None or not c["terrain"] or not c["state"]:
                return None
            terrain = c["terrain"]
            if terrain not in OWNER_TERRAINS:
                return None
            d = self.dragon_state(terrain)
            if d["st"] == "dead":
                return None
            now = time.time() * 1000
            sk = self._skill_hit(cid, c["state"], msg, "owner", now)
            if sk is False:
                return None
            self.dragon_regen(terrain, now)   # 扣血前先把該補的血補上（之後廣播的 hp 是回血後的值）
            dmg = sk["dmg"] if sk else (2 if msg.get("dmg") == 2 else 1)
            if now < d.get("vuln_until", 0.0):
                dmg += 1   # 破綻（近戰輸出的職能技能）：每擊 +1
            ph, pos, _ = self.dragon_phase(now, terrain)
            if ph == "dash":
                return self._drej(terrain, "衝刺中")
            try:
                ax, ay = float(msg.get("x")), float(msg.get("y"))
            except (TypeError, ValueError):
                return self._drej(terrain, "座標格式壞")
            dist = math.hypot(ax - pos[0], ay - pos[1])
            # 客戶端可能漏接一個路點事件（散步腿落後）：只要它宣稱的島主位置離伺服器的不遠、且玩家貼著宣稱的位置，就接受
            max_r = sk["range"] if sk else D_STAFF_RANGE if (msg.get("staff") and (c["state"] or {}).get("weapon") in RANGED_WEAPONS) else D_RANGE   # 法杖旗標要配上 state 裡真的拿著法杖／咒杖才算
            try:
                cdx, cdy = float(msg.get("ddx")), float(msg.get("ddy"))
                near = dist <= max_r or (math.hypot(ax - cdx, ay - cdy) <= max_r
                                         and math.hypot(cdx - pos[0], cdy - pos[1]) <= D_DRIFT_TOLER)
            except (TypeError, ValueError):
                near = dist <= max_r
            if not near:
                return self._drej(terrain, f"太遠 dist={dist:.0f}（島主=({pos[0]:.0f},{pos[1]:.0f}) 打擊點=({ax:.0f},{ay:.0f}) ph={ph}）")
            self.dragon_hits[cid] = (terrain, now)   # 仇恨計時用：D_DROPOUT 內打過就算現役攻擊者
            d["hp"] -= dmg
            d["last_hit_at"] = now
            if d["hp"] <= 0:
                d["st"], d["hp"], d["pos"], d["aim_tms"], d["dead_at"] = "dead", 0, list(pos), 0.0, now
                d["quote"] = None
                d["say_until"] = 0.0
                d["gen"] += 1
                d["wander"] = None
                d["aggro"] = None
                d["wander_gen"] += 1   # 作廢散步 tick
                dead_gen = d["gen"]
                outs.append({"t": "dragon", "ev": "dead", "x": pos[0], "y": pos[1]})
            elif ph == "idle" and self.dragon_maps.get(terrain) and now >= d["cooldown_until"] and (q := self._pick_quote(terrain)):
                # 黃金肥龍：80% 台詞招式（說台詞→依序放招）
                d["aggro"] = {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + D_CLAW_MS}
                outs.append({"t": "dragon", "ev": "aggro", "id": cid, "name": (c.get("state") or {}).get("name") or "玩家"})
                say, _ = self._start_quote(now, terrain, q, pos)
                outs.append(say)
                post_cycle = D_SAY_MS / 1000 + 0.05
            elif ph == "idle" and self.dragon_maps.get(terrain) and now >= d["cooldown_until"]:
                # 一被打就先建立仇恨（30 秒從最後一次被打起算）；反擊照樣先放：說台詞 →（龍衝＝瞬移島緣／蛇女＝原地開眼），
                # 放完不用再被打就馬上接著追殺同一個攻擊者（循環由 tick 在說完/放完時接手啟動）
                says = owner_says(terrain)   # skills.json 的 say:false＝不講台詞，直接開始預警
                d["aggro"] = {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + D_CLAW_MS}
                d["say_until"] = now + D_SAY_MS if says else 0.0
                d["atk"] = [ax, ay]   # 記住攻擊者位置：龍衝要穿過這裡／石化之瞳要朝這裡射
                d["wander"] = None
                d["pos"] = [pos[0], pos[1]]   # 打斷散步腿：把位置同步到目前插值點（否則之後的追腿會從舊腿起點出發，client 看起來像瞬移）
                d["wander_gen"] += 1
                outs.append({"t": "dragon", "ev": "aggro", "id": cid,
                             "name": (c.get("state") or {}).get("name") or "玩家"})
                if says:
                    post_cycle = D_SAY_MS / 1000 + 0.1
                    outs.append({"t": "dragon", "ev": "say", "x": pos[0], "y": pos[1], "ms": D_SAY_MS})
                else:   # 直接開始反擊循環；放完再醒（與 tick 裡「說完台詞」那段同樣的醒來時間）
                    cyc = self._dragon_start_cycle(now, terrain)
                    if cyc:
                        outs.append(cyc)
                    style = OWNER_TERRAINS.get(terrain)
                    if style == "gaze":
                        post_cycle = (D_GAZE_CAST_MS / 1000 + 0.1) if cyc else 2.0
                    elif style == "beam":
                        post_cycle = (D_BEAM_CAST_MS / 1000 + 0.1) if cyc else 2.0
                    else:
                        post_cycle = ((D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS) / 1000 + 0.1) if cyc else 2.0
            else:
                why = []
                if ph != "idle":
                    why.append(f"ph={ph}")
                if not self.dragon_maps.get(terrain):
                    why.append("無島形")
                cd_left = d["cooldown_until"] - now
                if cd_left > 0:
                    why.append(f"怒氣冷卻剩 {cd_left:.0f}ms")
                print(f"[dragon] {terrain} 命中但沒反擊: {' / '.join(why) or '未知'}"
                      f"（仇恨={'有' if d.get('aggro') else '無'} 現役攻擊者={len(self.aggro_candidates(now, terrain))}）",
                      file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "hp", "hp": d["hp"]})
                # 反擊冷卻中：把攻擊者納入仇恨（從 D_DROPOUT 內打過牠的人隨機挑一位開始追殺；已有目標時由 tick 負責換人）
                if not d.get("aggro") and ph == "idle" and cd_left > 0 and self.dragon_maps.get(terrain):
                    cands = self.aggro_candidates(now, terrain)
                    if cands:
                        rcid, rc = random.choice(cands)
                        outs.append(self._aggro_start(rcid, rc, terrain))
                        self._schedule_wander_tick(0.1, d["wander_gen"], terrain)   # 快點醒來開始追殺
                    else:
                        print(f"[dragon] {terrain} 冷卻中被打但沒有可用攻擊者：不開仇恨", file=sys.stderr, flush=True)
        if dead_gen is not None:   # 打倒了：重生計時（鎖外，避免 broadcast 卡住其他人）
            t = threading.Timer(D_RESPAWN_MS / 1000, self._dragon_respawn, (dead_gen, terrain))
            t.daemon = True
            self.dragon_timers[terrain] = t
            t.start()
        elif post_cycle is not None:
            self._schedule_wander_tick(post_cycle, self.dragon_state(terrain)["wander_gen"], terrain)
        return outs

    def _drej(self, terrain, why):
        """打擊被拒（暫時性診斷日誌）。"""
        print(f"[dragon] {terrain} 打擊拒絕: {why}", file=sys.stderr, flush=True)
        return None

    def dragon_provoke(self, cid):
        """挑釁（R 鍵，坦職限定，玩家自選）：把島主的仇恨拉到自己身上，不扣龍的血。
        已有仇恨 → 直接轉向；沒有仇恨且閒置 → 照「被打」的同一套反擊流程演出（說台詞→反擊，樣式照 OWNER_TERRAINS）。
        挑釁者所在地形決定挑釁的是哪座島的島主。
        回傳要廣播的訊息清單（None＝拒絕：非坦、死了、冷卻中、太遠、龍衝循環中）。"""
        outs = []
        post_cycle = None
        terrain = None
        with self.lock:
            c = self.clients.get(cid)
            if c is None or not c["terrain"] or not c["state"]:
                return None
            terrain = c["terrain"]
            if terrain not in OWNER_TERRAINS:
                return None
            st = c["state"]
            if role_of(st) != "tank" or st.get("dead"):   # 坦克職能限定（騎士、戰士）
                print("[dragon] 挑釁拒絕: 非坦職或已倒地", file=sys.stderr, flush=True)
                return None
            d = self.dragon_state(terrain)
            if d["st"] == "dead":
                return None
            now = time.time() * 1000
            if now - self.provokes.get(cid, 0.0) < D_PROVOKE_CD * 1000:
                return None   # 冷卻中：忽略（冷卻只在成功出手時計）
            ph, pos, _ = self.dragon_phase(now, terrain)
            if ph == "dash" or ph == "aim":
                return self._drej(terrain, "挑釁拒絕: 龍衝/預警進行中")
            dist = math.hypot(float(st.get("x") or 0) - pos[0], float(st.get("y") or 0) - pos[1])
            if dist > D_PROVOKE_RANGE:
                return self._drej(terrain, f"挑釁拒絕: 太遠 dist={dist:.0f}（島主=({pos[0]:.0f},{pos[1]:.0f}) ph={ph}）")
            self.provokes[cid] = now
            self.dragon_hits[cid] = (terrain, now)   # 挑釁者視同現役攻擊者：進仇恨換人的候選池、並重置脫離計時
            d["last_hit_at"] = now
            if d.get("aggro"):   # 已在追殺別人（含說台詞中）：仇恨直接轉向挑釁者
                d["aggro"] = {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + D_CLAW_MS}
                if d["say_until"] and now < d["say_until"]:
                    d["atk"] = [float(st.get("x") or 0), float(st.get("y") or 0)]   # 還在說台詞：反擊目標改成挑釁者
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 挑釁 → 仇恨轉向 {cid}", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "aggro", "id": cid, "name": st.get("name") or "玩家"})
                self._schedule_wander_tick(0.1, d["wander_gen"], terrain)   # 快點醒來，追殺改鎖定挑釁者
                return outs
            if ph == "idle" and self.dragon_maps.get(terrain) and now >= d["cooldown_until"]:
                # 沒有仇恨且閒置：照被打的反擊流程（台詞招式，或照樣式：要講台詞就先講再反擊）
                d["aggro"] = {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + D_CLAW_MS}
                d["atk"] = [float(st.get("x") or 0), float(st.get("y") or 0)]
                d["wander"] = None
                d["pos"] = [pos[0], pos[1]]   # 打斷散步腿：位置同步到目前插值點（同 dragon_hit 的理由）
                d["wander_gen"] += 1
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 挑釁 → 反擊流程（鎖定 {cid}）", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "aggro", "id": cid, "name": st.get("name") or "玩家"})
                q = self._pick_quote(terrain)
                if q:
                    say, _ = self._start_quote(now, terrain, q, pos)
                    outs.append(say)
                    post_cycle = D_SAY_MS / 1000 + 0.05
                elif owner_says(terrain):
                    d["say_until"] = now + D_SAY_MS
                    post_cycle = D_SAY_MS / 1000 + 0.1
                    outs.append({"t": "dragon", "ev": "say", "x": pos[0], "y": pos[1], "ms": D_SAY_MS})
                else:
                    cyc = self._dragon_start_cycle(now, terrain)
                    if cyc:
                        outs.append(cyc)
                    post_cycle = max(0.1, self._cycle_end(terrain, now) / 1000 - time.time() + 0.1) if cyc else 2.0
            elif ph == "idle" and self.dragon_maps.get(terrain):
                # 反擊冷卻中且沒有仇恨：直接進入追殺（同 dragon_hit 的冷卻路徑）
                d["pos"] = [pos[0], pos[1]]
                print(f"[dragon {time.strftime('%H:%M:%S')}] {terrain} 挑釁 → 冷卻中直接進仇恨（{cid}）", file=sys.stderr, flush=True)
                outs.append(self._aggro_start(cid, c, terrain))
                self._schedule_wander_tick(0.1, d["wander_gen"], terrain)
        if post_cycle is not None:
            self._schedule_wander_tick(post_cycle, self.dragon_state(terrain)["wander_gen"], terrain)
        return outs

    def _dragon_start_cycle(self, now, terrain):
        """說完台詞：開始反擊循環。龍衝＝瞬移島緣鎖定 d["atk"] 的攻擊者（預警→衝穿）；
        石化之瞳＝原地開眼，直線朝攻擊者方向射到島緣對岸。需在鎖內；回傳要廣播的訊息。"""
        d = self.dragon_state(terrain)
        m = self.dragon_maps.get(terrain)
        if d["st"] == "dead" or not m:
            return None
        d["say_until"] = 0.0
        ax, ay = d["atk"][0], d["atk"][1]
        style = OWNER_TERRAINS.get(terrain)
        if style in ("gaze", "beam"):   # 原地施放：石化之瞳開眼／波動砲讀條；直線朝攻擊者方向鎖到島緣對岸（光束幾何）
            ux, uy = ax - d["pos"][0], ay - d["pos"][1]
            ul = math.hypot(ux, uy) or 1
            d["unit"] = [ux / ul, uy / ul]
            d["beam"] = dragon_dash_dest(m, d["pos"][0], d["pos"][1], d["unit"][0], d["unit"][1])
            d["aim_tms"] = now
            cast_ms = D_GAZE_CAST_MS if style == "gaze" else D_BEAM_CAST_MS
            d["cooldown_until"] = now + cast_ms + D_RAGE_MS
            return {"t": "dragon", "ev": ("gaze" if style == "gaze" else "beam"), "x": d["pos"][0], "y": d["pos"][1],
                    "tx": ax, "ty": ay, "bx": d["beam"][0], "by": d["beam"][1], "castMs": cast_ms, "hp": d["hp"]}
        warp = dragon_edge(m, random.random() * math.pi * 2)
        ux, uy = ax - warp[0], ay - warp[1]
        ul = math.hypot(ux, uy) or 1
        d.update(warp=warp, unit=[ux / ul, uy / ul])
        d["dest"] = dragon_dash_dest(m, warp[0], warp[1], d["unit"][0], d["unit"][1])
        d["dash_len"] = math.hypot(d["dest"][0] - warp[0], d["dest"][1] - warp[1])
        d["aim_tms"] = now
        d["cooldown_until"] = now + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS + D_RAGE_MS
        return {"t": "dragon", "ev": "aim", "x": warp[0], "y": warp[1], "fx": d["pos"][0], "fy": d["pos"][1],
                "tx": ax, "ty": ay, "dx": d["dest"][0], "dy": d["dest"][1], "castMs": D_CAST_MS, "hp": d["hp"]}

    def _dragon_respawn(self, gen, terrain):
        out2 = leg_delay = None
        with self.lock:
            d = self.dragon_state(terrain)
            if d["st"] != "dead" or d["gen"] != gen:   # 期間已有別的變動（例如伺服器重啟重建）
                return
            m = self.dragon_maps.get(terrain)
            pos = dragon_edge(m, random.random() * math.pi * 2) if m else list(D_CENTER)
            d.update(st="idle", hp=D_HP, pos=pos, aim_tms=0.0, atk=[0, 0], wander=None, aggro=None, quote=None, say_until=0.0)
            d["wander_gen"] += 1   # 作廢舊散步 tick
            out = {"t": "dragon", "ev": "spawn", "x": pos[0], "y": pos[1], "hp": d["hp"]}
            if self._has_clients(terrain):
                out2 = self._dragon_start_leg(terrain)
                if out2:
                    leg_delay = (d["wander"]["tms"] + d["wander"]["pause"]) / 1000 + 0.05
            wgen = d["wander_gen"]
        self.broadcast(out, terrain=terrain)
        if out2:
            self.broadcast(out2, terrain=terrain)
        if leg_delay is not None:
            self._schedule_wander_tick(leg_delay, wgen, terrain)

    # ---- 釣上來的敵對怪物（lurker；與 worker/src/index.js 的 spawnLurker／lurkerHit／stepLurker 同一套）----
    def lurker_pos(self, L, now):
        w = L["wander"]
        if not w:
            return list(L["pos"])
        t = max(0.0, min(1.0, (now - w["t0"]) / w["tms"]))
        return [w["fx"] + (w["tx"] - w["fx"]) * t, w["fy"] + (w["ty"] - w["fy"]) * t]

    def lurker_snapshot(self, terrain):
        """需在鎖內。沒有怪物回 None。"""
        L = self.lurkers.get(terrain)
        if not L:
            return None
        now = time.time() * 1000
        pos = self.lurker_pos(L, now)
        o = {"mob": L["mob"], "x": pos[0], "y": pos[1], "hp": L["hp"], "max": L["max"], "aggro": L["aggro"]["id"]}
        w = L["wander"]
        if w:
            o["wleg"] = {"fx": w["fx"], "fy": w["fy"], "tx": w["tx"], "ty": w["ty"], "tms": w["tms"],
                         "el": int(max(0, min(w["tms"], now - w["t0"])))}
        return o

    def spawn_lurker(self, cid, mob):
        """釣到怪物：落在浮標旁最近的陸地（沒有島形就落在釣的人旁邊），鎖定釣到牠的人。回 spawn 訊息；不能生成回 None。"""
        with self.lock:
            c = self.clients.get(cid)
            terrain = c and c.get("terrain")
            if not terrain or terrain in self.lurkers:
                return None
            st = c.get("state") or {}
            fs = st.get("fish") or {}
            fx = fs.get("x", st.get("x")); fy = fs.get("y", st.get("y"))
            if not isinstance(fx, (int, float)) or not isinstance(fy, (int, float)):
                return None
            m = self.dragon_maps.get(terrain)
            land = dragon_nearest_land(m, fx, fy) if m else None
            pos = list(land) if land else [st.get("x", fx), st.get("y", fy)]
            now = time.time() * 1000
            self.lurkers[terrain] = {"mob": mob, "hp": L_HP, "max": L_HP, "pos": pos, "wander": None, "last_hit_at": now,
                                     "aggro": {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + L_CLAW_MS}}
            self.lurk_hits[cid] = (terrain, now)
            print(f"[lurker {time.strftime('%H:%M:%S')}] {terrain} 釣到 {mob} @({pos[0]:.0f},{pos[1]:.0f})", file=sys.stderr, flush=True)
            msg = {"t": "lurker", "ev": "spawn", "terrain": terrain, "mob": mob, "x": pos[0], "y": pos[1], "fx": fx, "fy": fy,
                   "hp": L_HP, "max": L_HP, "id": cid, "name": st.get("name") or "玩家"}
        self._schedule_lurker_tick(0.06, terrain)
        return terrain, msg

    def lurker_hit(self, cid, msg):
        """打釣上來的怪物：回 (地形, 要廣播的訊息) 或 None。"""
        with self.lock:
            c = self.clients.get(cid)
            terrain = c and c.get("terrain")
            L = self.lurkers.get(terrain) if terrain else None
            st = (c or {}).get("state") or {}
            if not L or not st:
                return None
            now = time.time() * 1000
            sk = self._skill_hit(cid, st, msg, "lurker", now)
            if sk is False:
                return None
            h = self.lurk_hits.get(cid)
            if not sk and h and h[0] == terrain and now - h[1] < D_CD * 1000:
                return None
            pos = self.lurker_pos(L, now)
            max_r = sk["range"] if sk else L_STAFF_RANGE if msg.get("staff") and st.get("weapon") in RANGED_WEAPONS else L_RANGE
            try:
                px, py = float(msg.get("x")), float(msg.get("y"))
            except (TypeError, ValueError):
                return None
            near = math.hypot(px - pos[0], py - pos[1]) <= max_r
            lx, ly = msg.get("lx"), msg.get("ly")
            if not near and isinstance(lx, (int, float)) and isinstance(ly, (int, float)):
                near = math.hypot(px - lx, py - ly) <= max_r and math.hypot(lx - pos[0], ly - pos[1]) <= D_DRIFT_TOLER
            if not near:
                return None
            if not sk:
                self.lurk_hits[cid] = (terrain, now)
            elif not h or h[1] < now - D_CD * 1000:
                self.lurk_hits[cid] = (terrain, now - D_CD * 1000)   # 技能命中也算攻擊者（仇恨候選），但不佔一般攻擊的間隔
            L["last_hit_at"] = now
            try:
                dmg = sk["dmg"] if sk else max(1, min(2, round(float(msg.get("dmg") or 1))))
            except (TypeError, ValueError):
                dmg = 1
            L["hp"] -= dmg
            if L["hp"] <= 0:
                del self.lurkers[terrain]
                return terrain, {"t": "lurker", "ev": "dead", "x": pos[0], "y": pos[1]}
            return terrain, {"t": "lurker", "ev": "hp", "hp": L["hp"]}

    def _schedule_lurker_tick(self, delay, terrain):
        seq = self.lurk_seq.get(terrain, 0) + 1
        self.lurk_seq[terrain] = seq
        t = threading.Timer(delay, self._lurker_tick, (terrain, seq))
        t.daemon = True
        t.start()

    def _lurker_tick(self, terrain, seq):
        """推進一步：沒人看／太久沒人打／目標死了又沒人可換 → 原地消失；否則追殺、貼近就每秒爪擊。"""
        outs, next_delay = [], None
        with self.lock:
            if seq != self.lurk_seq.get(terrain, 0):
                return
            L = self.lurkers.get(terrain)
            if not L:
                return
            if not self._has_clients(terrain):   # 沒人在這個地形：直接消失
                del self.lurkers[terrain]
                return
            now = time.time() * 1000
            pos = self.lurker_pos(L, now)
            gone = {"t": "lurker", "ev": "gone", "x": pos[0], "y": pos[1]}
            ag = L["aggro"]
            tid, tc = self.aggro_target(ag["id"], terrain)
            if now - L["last_hit_at"] > L_DROPOUT:
                del self.lurkers[terrain]; outs = [gone]
            else:
                if tc is None or now >= ag["rotate_at"]:   # 目標死了／離開，或 5 秒到：從最近打過牠的人裡隨機換
                    cands = []
                    for k, cc in self.clients.items():
                        h = self.lurk_hits.get(k)
                        st0 = cc.get("state")
                        if k != ag["id"] and h and h[0] == terrain and now - h[1] <= L_DROPOUT and cc.get("terrain") == terrain and st0 and not st0.get("dead"):
                            cands.append((k, cc))
                    if cands:
                        tid, tc = random.choice(cands)
                        ag["id"] = tid; ag["rotate_at"] = now + D_AGGRO_MS
                        outs.append({"t": "lurker", "ev": "aggro", "id": tid, "name": (tc.get("state") or {}).get("name") or "玩家"})
                    elif tc is None:   # 仇恨對象沒了又沒人可換：原地消失
                        del self.lurkers[terrain]
                        outs = [gone]
                    else:
                        ag["rotate_at"] = now + D_AGGRO_MS
                if terrain in self.lurkers:
                    tst = tc["state"]
                    tx0, ty0 = tst.get("x", pos[0]), tst.get("y", pos[1])
                    if math.hypot(tx0 - pos[0], ty0 - pos[1]) <= L_CLAW_RANGE:   # 貼近：站定每秒一抓
                        L["pos"] = pos; L["wander"] = None
                        if now >= ag["claw_at"]:
                            ag["claw_at"] = now + L_CLAW_MS
                            outs.append({"t": "lurker", "ev": "claw", "x": pos[0], "y": pos[1], "tx": tx0, "ty": ty0, "id": tid})
                    else:
                        w = L["wander"]
                        if not w or now >= w["t0"] + w["tms"] or now >= w["t0"] + 600:   # 每 0.6 秒重新瞄準
                            tx, ty = self._chase_dest(terrain, pos, tx0, ty0)
                            tms = max(80, int(math.hypot(tx - pos[0], ty - pos[1]) / L_CHASE * 1000))
                            L["pos"] = pos
                            L["wander"] = {"fx": pos[0], "fy": pos[1], "tx": tx, "ty": ty, "tms": tms, "t0": now}
                            outs.append({"t": "lurker", "ev": "wander", "fx": pos[0], "fy": pos[1], "tx": tx, "ty": ty, "tms": tms})
                    ends = [ag["rotate_at"], L["last_hit_at"] + L_DROPOUT, ag["claw_at"], now + 600]
                    if L["wander"]:
                        ends.append(L["wander"]["t0"] + L["wander"]["tms"] + 60)
                    next_delay = max(0.06, (min(ends) + 25 - now) / 1000)
        for m in outs:
            self.broadcast(m, terrain=terrain)
        if next_delay is not None:
            self._schedule_lurker_tick(next_delay, terrain)

    def _chase_dest(self, terrain, pos, tx, ty):
        """追殺腿的終點：在陸地上時直線前方連續 3 格是水就截在海邊（與島主追腿、Worker 的 chaseDest 同規則）。"""
        m = self.dragon_maps.get(terrain)
        if not m:
            return tx, ty
        gx0, gy0 = int(pos[0] // CELL), int(pos[1] // CELL)
        if not (0 <= gx0 < COLS and 0 <= gy0 < ROWS and m[gy0 * COLS + gx0]):
            return tx, ty
        steps = max(1, math.ceil(math.hypot(tx - pos[0], ty - pos[1]) / CELL))
        water = 0
        for s in range(1, steps + 1):
            t = s / steps
            gx, gy = int((pos[0] + (tx - pos[0]) * t) // CELL), int((pos[1] + (ty - pos[1]) * t) // CELL)
            if not (0 <= gx < COLS and 0 <= gy < ROWS) or not m[gy * COLS + gx]:
                water += 1
                if water >= 3:
                    t = max(0.0, (s - water) / steps)
                    return pos[0] + (tx - pos[0]) * t, pos[1] + (ty - pos[1]) * t
            else:
                water = 0
        return tx, ty

    def add(self, sock):
        with self.lock:
            if len(self.clients) >= MAX_PLAYERS:
                return None
            self.order += 1
            cid = self.order
            self.clients[cid] = {"sock": sock, "send": threading.Lock(), "state": {}, "terrain": None}
            return cid

    def remove(self, cid):
        with self.lock:
            self.clients.pop(cid, None)
            self.dragon_hits.pop(cid, None)
            self.lurk_hits.pop(cid, None)
            self.debuffs.pop(cid, None)
            self.skill_hits.pop(cid, None)

    def terrain_of(self, cid):
        with self.lock:
            c = self.clients.get(cid)
            return c["terrain"] if c else None

    def enter(self, cid, v):
        """玩家進入地形 v。回傳 (舊地形, 同地形其他玩家快照, 該地形擺設, 地板, 家具, 島主快照或 None)；無變動回 None。"""
        with self.lock:
            c = self.clients.get(cid)
            if c is None or c["terrain"] == v:
                return None
            old, c["terrain"] = c["terrain"], v
            players = {k: dict(o["state"]) for k, o in self.clients.items()
                       if k != cid and o["terrain"] == v and o["state"]}
            dragon = None
            if v in OWNER_TERRAINS:   # 島主同步：進有島主的地形附帶當下的快照（客戶端據此續播任意階段）
                d = self.dragon_state(v)
                dragon = self.dragon_snapshot(v)
                if d["st"] == "idle":   # 有人進來了：排一次 tick 恢復散步（沒人看時是停擺的）
                    self._schedule_wander_tick(1.0, d["wander_gen"], v)
            lurker = self.lurker_snapshot(v)   # 釣上來的怪物（沒有就是 None，客戶端據此清掉殘留的）
            return old, players, list(self.furn_list(v)), floor_to_list(self.floor_map(v)), self.deco_list(v), dragon, lurker

    # terrain 有給時只送給「目前在該地形」的連線；沒給就是全部
    def broadcast(self, msg, skip=None, terrain=None):
        if terrain is not None and msg.get("t") in ("dragon", "lurker") and "terrain" not in msg:
            msg = {**msg, "terrain": terrain}   # 島主事件註明是哪座地形的，客戶端才能擋掉切地形空檔收到的舊島事件
        data = json.dumps(msg)
        with self.lock:
            targets = [(c, v["sock"], v["send"]) for c, v in self.clients.items()
                       if c != skip and (terrain is None or v["terrain"] == terrain)]
        dead = []
        for cid, sock, lk in targets:
            try:
                with lk:
                    ws_send(sock, data)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self.remove(cid)

ROOMS = {}
ROOMS_LOCK = threading.Lock()

def get_room(name):
    with ROOMS_LOCK:
        r = ROOMS.get(name)
        if r is None:
            r = ROOMS[name] = Room()
        return r

def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf

def ws_read(sock):
    """回傳 (opcode, payload) 或 None（關閉/錯誤）。"""
    h = recv_exact(sock, 2)
    if not h:
        return None
    op, masked, ln = h[0] & 0x0f, h[1] & 0x80, h[1] & 0x7f
    if ln == 126:
        ln = struct.unpack(">H", recv_exact(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if masked else None
    data = recv_exact(sock, ln) if ln else b""
    if data is None:
        return None
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return op, data

def ws_send(sock, payload):
    if isinstance(payload, str):
        payload = payload.encode()
    head = bytes([0x81])
    n = len(payload)
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += b"\x7e" + struct.pack(">H", n)
    else:
        head += b"\x7f" + struct.pack(">Q", n)
    sock.sendall(head + payload)

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # cloudflared 隧道需要 1.1 keep-alive 對接
    # Windows 上 Python 會從登錄檔讀 MIME，.js 可能變成 text/plain 而被 ES module 拒載，這裡明確指定
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=CLIENT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[-] %s\n" % (fmt % args))

    def end_headers(self):
        # 開發期禁快取：Discord webview 會咬住 304，改完 JS 看不到
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/version.json":   # 本機：目前 HEAD 的前 7 碼（正式站由 CI 寫成同名靜態檔）
            try:
                sha = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=HERE, capture_output=True, text=True, timeout=5).stdout.strip()
            except Exception:
                sha = ""
            return self._json({"commit": sha})
        if self.path == "/api/config":
            cfg = config()
            return self._json({"client_id": cfg.get("client_id", "")})
        if self.path.split("?")[0] == "/ws":
            return self.handle_ws()
        return super().do_GET()

    # ---- WebSocket：同房間＝同座島 ----
    def handle_ws(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._json({"error": "不是 websocket 請求"}, 400)
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        qs = urllib.parse.urlparse(self.path).query
        room_name = urllib.parse.parse_qs(qs).get("room", ["local"])[0][:120]
        room = get_room(room_name)
        sock = self.connection
        cid = room.add(sock)
        if cid is None:   # 島滿了：直接關閉連線，客戶端會自動退讓重連
            self.close_connection = True
            return
        print(f"[ws] +{cid} @{room_name}（{len(room.clients)} 人在線）", file=sys.stderr, flush=True)
        win_sec, win_n = 0, 0
        last_hit = 0.0
        last_dragon_hit = 0.0   # 打島主的每連線冷卻（與 last_hit 同款）
        last_fish = 0.0         # 釣魚結果的每連線冷卻
        last_sign = 0.0         # 改看板的每連線冷卻
        commit_tokens, commit_t = float(COMMIT_BURST), time.time()   # 保存擺設的令牌桶
        try:
            # 剛連上時還沒進任何地形：看不到也不被看到，等客戶端送 enter
            ws_send(sock, json.dumps({"t": "init", "id": cid, "admin": is_admin(None)}))
            while True:
                fr = ws_read(sock)
                if fr is None:
                    break
                op, data = fr
                if op == 0x8:      # close
                    break
                if op == 0x9:      # ping -> pong
                    with room.clients.get(cid, {}).get("send", threading.Lock()):
                        sock.sendall(b"\x8a" + bytes([len(data)]) + data)
                    continue
                if op not in (0x1, 0x2) or len(data) > MAX_MSG:
                    continue
                sec = int(time.time())     # 簡易限流：超過就丟棄
                win_n = win_n + 1 if sec == win_sec else 1
                win_sec = sec
                if win_n > RATE_MAX:
                    continue
                try:
                    msg = json.loads(data.decode())
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                t = msg.get("t")
                if t == "hello":
                    # 帶簽章憑證表明身分；驗證失敗就維持訪客
                    c = room.clients.get(cid)
                    if c is not None:
                        c["user"] = verify_session(msg.get("s"))
                        c["admin"] = is_admin(c["user"])
                        if c["user"] and c.get("state"):   # 與 Worker 一致：已送過的狀態立刻改用驗證過的名字與 uid
                            c["state"] = {**c["state"], "name": str(c["user"]["name"])[:NAME_MAX], "uid": c["user"]["id"]}
                        with c["send"]:
                            ws_send(sock, json.dumps({"t": "me", "admin": c["admin"], "auth": bool(c["user"])}))   # auth＝憑證驗證成功；失敗客戶端會重新授權
                            if c["user"]:   # 登入的人：送他的魚類圖鑑
                                with FISH_DEX_LOCK:
                                    dex = json.loads(json.dumps(FISH_DEX.get(c["user"]["id"], {})))
                                ws_send(sock, json.dumps({"t": "dex", "dex": dex}))
                elif t == "state":
                    c = room.clients.get(cid)
                    st = sanitize_state(msg.get("s") if isinstance(msg.get("s"), dict) else {}, c.get("state") if c else None)
                    # 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）；訪客沒有 uid
                    user = c.get("user") if c else None
                    if user:
                        st["name"], st["uid"] = str(user["name"])[:NAME_MAX], user["id"]
                    if c:
                        c["state"] = st
                    cur = room.terrain_of(cid)
                    if cur:
                        room.broadcast({"t": "p", "id": cid, "s": st}, skip=cid, terrain=cur)
                elif t in ("enter", "terrain"):   # "terrain" 是舊客戶端的訊息名
                    # 每位玩家各自在自己的地形，只有同地形的人看得到彼此
                    v = str(msg.get("v"))
                    if not TERRAIN_RE.match(v):
                        continue
                    res = room.enter(cid, v)
                    if res is None:
                        continue
                    old, players, furn, floor, decos, dragon, lurker = res
                    if old:   # leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
                        room.broadcast({"t": "leave", "id": cid, "to": v}, skip=cid, terrain=old)
                    with room.clients[cid]["send"]:
                        ws_send(sock, json.dumps({"t": "enter", "terrain": v, "players": players, "furn": furn, "floor": floor, "decos": decos, "dragon": dragon, "lurker": lurker}))
                    st = room.clients[cid]["state"]
                    room.broadcast({"t": "join", "id": cid, "name": st.get("name")}, skip=cid, terrain=v)
                    if st:
                        room.broadcast({"t": "p", "id": cid, "s": st}, skip=cid, terrain=v)
                elif t == "hit":
                    now = time.time()
                    if now - last_hit < HIT_CD:
                        continue
                    res = room.hit_deco(cid, msg)
                    if res:
                        last_hit = now
                        room.broadcast(res[1], terrain=res[0])
                elif t == "dragonMap":   # 陸地位圖（島主路徑＋擺設的水邊驗證；各客戶端島形相同，誰上傳都一樣；後上傳的覆蓋也無妨）。上傳者所在地形決定是哪座島的
                    c3 = room.clients.get(cid)
                    cur = c3.get("terrain") if c3 else None
                    if cur:
                        land = dragon_land(msg.get("v"))
                        if land:
                            room.dragon_maps[cur] = land
                elif t == "dragonHit":   # 打島主：驗證後廣播 hp/aim/gaze/beam/dead/aggro 事件（回傳訊息清單）
                    now = time.time()
                    if not msg.get("sk") and now - last_dragon_hit < D_CD:   # 職業技能另有自己的冷卻（_skill_hit）
                        continue
                    res = room.dragon_hit(cid, msg)
                    if res and not msg.get("sk"):
                        last_dragon_hit = now
                    if res:
                        cur = room.terrain_of(cid)
                        for m in res:
                            room.broadcast(m, terrain=cur)
                elif t == "lurkerHit":   # 打釣上來的敵對怪物
                    res = room.lurker_hit(cid, msg)
                    if res:
                        room.broadcast(res[1], terrain=res[0])
                elif t == "debuff":    # 破綻（近戰輸出）／降傷（遠程輸出）：職能/距離/冷卻由伺服器驗證
                    res = room.dragon_debuff(cid, msg)
                    if res:
                        room.broadcast(res[1], terrain=res[0])
                elif t == "provoke":   # 挑釁（坦職限定）：把島主的仇恨拉到自己身上（職業/距離/冷卻由伺服器驗證）
                    res = room.dragon_provoke(cid)
                    if res:
                        cur = room.terrain_of(cid)
                        for m in res:
                            room.broadcast(m, terrain=cur)
                elif t == "dragonSnap":   # 客戶端凍結恢復：回一份島主即時快照（只給這條連線）
                    c2 = room.clients.get(cid)
                    if c2 and c2.get("terrain") in OWNER_TERRAINS:
                        snap = room.dragon_snapshot(c2["terrain"])
                        with c2["send"]:
                            ws_send(sock, json.dumps({"t": "dragon", "ev": "state", "terrain": c2["terrain"], **snap}))
                elif t in ("commit", "place", "remove", "clear"):
                    # 裝飾模式的變動是草稿，按保存才送 commit（一批操作）；舊客戶端的單一操作也走同一套驗證與權限
                    cur = room.terrain_of(cid)
                    ops = msg.get("ops") if t == "commit" else [msg]
                    if cur and isinstance(ops, list):
                        c = room.clients.get(cid) or {}
                        now = time.time()
                        commit_tokens = min(float(COMMIT_BURST), commit_tokens + (now - commit_t) / COMMIT_REFILL)
                        commit_t = now
                        if commit_tokens < 1:   # 保存太頻繁：整批不處理，回報給客戶端（與 Worker 一致）
                            with c.get("send") or threading.Lock():
                                ws_send(sock, json.dumps({"t": "commit_result", "applied": 0, "rejected": min(len(ops), MAX_OPS), "denied": False, "limited": True}))
                            continue
                        commit_tokens -= 1
                        applied, rejected, denied, furn_changed, floor_changed = room.commit_furn(cur, ops, c.get("admin", is_admin(None)))
                        # 與 Worker 一致：先廣播新清單，再回 commit_result（客戶端收到結果時以最新清單為準）
                        if furn_changed:
                            room.broadcast({"t": "furn", "items": list(room.furn_list(cur))}, terrain=cur)
                        if floor_changed:
                            room.broadcast({"t": "floor", "items": floor_to_list(room.floor_map(cur))}, terrain=cur)
                        with c.get("send") or threading.Lock():
                            ws_send(sock, json.dumps({"t": "commit_result", "applied": applied, "rejected": rejected, "denied": denied}))
                elif t == "sign":   # 看板改字（所有人都能改）
                    cur = room.terrain_of(cid)
                    now = time.time()
                    if not cur or now - last_sign < SIGN_CD:
                        continue
                    last_sign = now
                    if room.edit_sign(cur, msg.get("cell"), msg.get("text")):
                        room.broadcast({"t": "furn", "items": list(room.furn_list(cur))}, terrain=cur)
                elif t == "event":   # 揮擊等瞬時事件
                    cur = room.terrain_of(cid)
                    if cur:
                        room.broadcast({"t": "event", "id": cid, "kind": msg.get("kind")}, skip=cid, terrain=cur)
                elif t == "fish":   # 釣魚：拉竿成功，伺服器抽魚（登入的人記進圖鑑）
                    cur = room.terrain_of(cid)
                    now = time.time()
                    if not cur or now - last_fish < FISH_CD:
                        continue
                    last_fish = now
                    res = roll_fish(cur)
                    db = fish_db()
                    # 極低機率釣到敵對怪物（該地形沒有其他還在的怪物時才會）：不記圖鑑，改成在浮標旁落地追殺釣到牠的人
                    if not res.get("escaped") and db.get("lurker") and random.random() < db.get("lurkerChance", 0):
                        sp = room.spawn_lurker(cid, str(db["lurker"]))
                        if sp:
                            room.broadcast(sp[1], terrain=sp[0])
                            with (room.clients.get(cid) or {}).get("send") or threading.Lock():
                                ws_send(sock, json.dumps({"t": "fish_result", "terrain": cur, "lurker": str(db["lurker"]), "saved": False}))
                            continue
                    out = {"t": "fish_result", **res, "saved": False}
                    user = (room.clients.get(cid) or {}).get("user")
                    if not res.get("escaped") and user:
                        entry, is_new, is_record = dex_catch(user["id"], res["terrain"], res["id"], res["size"])
                        out.update(saved=True, entry=entry, isNew=is_new, isRecord=is_record)
                    with (room.clients.get(cid) or {}).get("send") or threading.Lock():
                        ws_send(sock, json.dumps(out))
        except Exception as e:
            print(f"[ws] !{cid} {e}", file=sys.stderr, flush=True)
        finally:
            last = room.terrain_of(cid)
            room.remove(cid)
            if last:
                room.broadcast({"t": "leave", "id": cid}, terrain=last)
            print(f"[ws] -{cid} @{room_name}（剩 {len(room.clients)} 人）", file=sys.stderr, flush=True)
            self.close_connection = True

    def do_POST(self):
        # 一律先消費 request body，避免 HTTP/1.1 keep-alive desync（否則殘body黏成下一個請求行）
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode(errors="replace") if length else "{}"
        try: body = json.loads(raw or "{}")
        except Exception: body = {}
        if self.path == "/api/log":
            print(f"[beacon] {raw[:500]}", file=sys.stderr, flush=True)
            return self._json({"ok": True})
        if self.path == "/api/token":
            cfg = config()
            if not cfg.get("client_id") or not cfg.get("client_secret"):
                return self._json({"error": "dev_config.json 未設定 client_id/client_secret"}, 500)
            try:
                tok = exchange_code(body.get("code", ""), cfg)
                me = discord_me(tok.get("access_token", "")) if tok.get("access_token") else None
                user = {"id": me["id"], "name": me.get("global_name") or me.get("username")} if me else None
                return self._json({
                    "access_token": tok.get("access_token"),
                    "scope": tok.get("scope"),
                    "user": user,
                    "session": sign_session(user),
                })
            except urllib.error.HTTPError as e:
                # 透傳 Discord 的錯誤內容（勿用 502：trycloudflare 會把 502 蓋成自家錯誤頁）
                detail = e.read().decode(errors="replace")[:300]
                try: detail = json.loads(detail)
                except Exception: pass
                return self._json({"error": "discord", "status": e.code, "detail": detail}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 400)
        return self._json({"error": "not found"}, 404)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 客戶端（瀏覽器/Discord）中途關閉連線很正常，不要洗版 traceback
        import traceback
        et = sys.exc_info()[0]
        if et in (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            return
        traceback.print_exc()

if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"DC島 dev server: http://localhost:{PORT}  （/api/config /api/token 已開啟）")
        httpd.serve_forever()
