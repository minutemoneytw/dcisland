#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 本機開發伺服器（行為要與正式站 worker/src/index.js 保持一致）
# 1) 服務 client/ 靜態檔
# 2) /api/config   -> 從 dev_config.json 讀 client_id
# 3) /api/token    -> 用 code+secret 向 Discord 兌換 access_token（secret 只在本機/伺服器端）
# 4) /api/log      -> 前端信標（錯誤／步驟）印到主控台
# 5) /ws           -> 多人同步（島、島主、遊戲桌；跨島的玩家資料本機只存記憶體）
# 用法: python tools/dev_server.py  （純本機不需要憑證；要測真 Discord 身分才填 tools/dev_config.json）
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
COLS, ROWS = 108, 72   # 前七座島半徑 ×1.5（2026-11-09）
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
# 遊戲戰績（2026-11-13，使用者要求「幫小遊戲設計稱號」）：跟著 Discord 帳號（Worker 存 Registry 的 gstats:<uid>，這裡只存記憶體 GSTATS）。各遊戲結算時在 result["gs"]
# （依「結算後留下的座位」順序，與 result["xp"] 同；None＝這一局不記）帶每位入座者的戰績增量 {add: 累加, max: 取較大, min: 取較小}，伺服器照著記進 GSTATS 並把整份送給本人；
# result["gs"] 不含 uid，訪客由客戶端本機套用。每局都有 p（局數）。與 worker 的 gsMk／tableStats 同一套
GS_GAMES = {"oldmaid", "gomoku", "dodge", "uno", "typing", "zhtyping", "intel", "mage", "blokus", "trigon", "arcade", "maze", "hockey"}
GS_CAP, GS_KEYS_MAX = 1000000, 24
GSTATS = {}

def gs_mk(add=None, mx=None, mn=None):
    return {"add": {"p": 1, **(add or {})}, "max": mx or {}, "min": mn or {}}

def gstats_apply(uid, game, gs):
    """把一局的戰績增量併進帳號的戰績；回整份（深拷貝）。"""
    all_ = GSTATS.setdefault(uid, {})
    if game in GS_GAMES and gs:
        m = all_.setdefault(game, {})
        for mode, src in (("add", gs.get("add")), ("max", gs.get("max")), ("min", gs.get("min"))):
            for k, raw in (src or {}).items():
                if not isinstance(raw, (int, float)) or isinstance(raw, bool) or not re.fullmatch(r"[a-z0-9_]{1,12}", str(k)):
                    continue
                v = max(0, min(GS_CAP, int(raw)))
                if k not in m and len(m) >= GS_KEYS_MAX:
                    continue
                if mode == "add":
                    m[k] = min(GS_CAP, m.get(k, 0) + v)
                elif mode == "max":
                    m[k] = max(m.get(k, 0), v)
                else:
                    m[k] = v if k not in m else min(m[k], v)
    return json.loads(json.dumps(all_))
# 暱稱（2026-11-13，使用者要求）：跟著 Discord 帳號（Worker 存 Registry 的 nick:<uid>，這裡只存記憶體），只改「顯示名稱」——state.name 對登入者＝暱稱，沒設就是 Discord 名稱；
# 身分仍是 uid（管理員、XP、圖鑑、排行榜去重都看 uid，與名稱無關）。不擋撞名。與 worker 的 nickClean 同一套
NICK_MAX, NICK_CD_MS = 12, 2000
NICKS = {}

def nick_clean(v):
    return re.sub(r"[\x00-\x1f\x7f]", "", re.sub(r"\s+", " ", v)).strip()[:NICK_MAX] if isinstance(v, str) else ""
D8 = ("down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left")   # 與 client 的 CHAR_DIR8 一致


def _num(v, lo, hi, fb):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return min(hi, max(lo, v))
    return fb


HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# 職業 → 職能（與 client/assets/jobs/jobs.json、worker 的 JOB_ROLE 一致；新增職業要一起加）
JOB_ROLE = {"knight": "tank", "warrior": "tank", "whitemage": "healer", "sage": "healer", "ninja": "melee", "dragoon": "melee", "bard": "ranged", "blackmage": "ranged"}
JOB_LEGACY = {"tank": "knight", "healer": "whitemage", "dps": "ninja"}   # 舊客戶端的職業 id
JOB_DEFAULT = "ninja"
RANGED_WEAPONS = ("staff", "scepter", "tome", "harpbow")   # 遠距攻擊的武器（法杖、咒杖、魔導書、豎琴弓）
D_DEBUFF_MS = 10000      # 破綻／降傷的持續時間（與 worker、client 一致）
D_DEBUFF_CD_MS = 30000   # 破綻／降傷冷卻（每條連線、每種各算）
# 職業技能打島主／深海魚人（與 worker 的 SKILL_HITS、client 的 JOB_SKILLS 一致）
SKILL_HITS = {
    "ninjutsu": {"job": "ninja", "dmg": 6, "cd_ms": 19000, "range": 170},
    "jump": {"job": "dragoon", "dmg": 5, "cd_ms": 14000, "range": 170},   # 龍騎士高跳：落在敵人身上
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
            "gender": "female" if look.get("gender") == "female" else "male",
            "race": look.get("race") if look.get("race") in ("human", "elf", "cat", "lalafell", "giant") else "human",  # 種族（人類/精靈/貓族/拉拉肥/巨人）
            "hair": _id_or(look.get("hair"), pl.get("hair", "hair1")),
            "shirt": round(_num(look.get("shirt"), 0, 99, pl.get("shirt", 0))),
            "pants": round(_num(look.get("pants"), 0, 99, pl.get("pants", 0))),
            "hat": _id_or(look.get("hat"), None),        # 顯示中的帽子 id（裝備或外觀，客戶端已決定好；None＝沒戴）
            "top": _id_or(look.get("top"), None),        # 顯示中的上衣 id（None＝預設款）
            "bottom": _id_or(look.get("bottom"), None),  # 顯示中的褲子 id（None＝預設款）
            "shoe": _id_or(look.get("shoe"), None),      # 顯示中的鞋子 id（None＝預設款）
            "face": _id_or(look.get("face"), "normal"),  # 臉型（頭型）id
            "eyes": _id_or(look.get("eyes"), "default_brown"), # 眼睛（表情_顏色）id
            "hatC": _hex_or(look.get("hatC")),           # 換色色碼（None＝原色）
            "topC": _hex_or(look.get("topC")),
            "botC": _hex_or(look.get("botC")),
            "shoeC": _hex_or(look.get("shoeC")),
            "wlook": _id_or(look.get("wlook"), None),    # 武器外觀 id
            "hairC": _hex_or(look.get("hairC")),         # 調色盤自訂的髮色（None＝用選的那一色）
            "eyeC": _hex_or(look.get("eyeC")),           # 調色盤自訂的眼睛顏色
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
        # 等級（名牌顯示用）：登入者由伺服器以存檔的 XP 覆寫；訪客照客戶端報的（只影響顯示）
        "lvl": max(1, round(_num(s.get("lvl"), 1, 2000, (prev.get("lvl") or 1)))),
        # 釣魚：浮標位置與階段（只轉發；釣到什麼由 fish 訊息決定）
        "fish": {"x": _num(fs.get("x"), 0, COLS * CELL, 0), "y": _num(fs.get("y"), 0, ROWS * CELL, 0), "ph": fs["ph"]}
                if isinstance(fs, dict) and fs.get("ph") in FISH_PHASES else None,
    }


# ---- 腳色等級 XP（2026-11-07 第 2 步：登入者的 XP 由伺服器權威記帳）----
# 與 worker/src/index.js 的 XP_* 同值同演算法（改一邊要改另一邊）。
# 非主動怪是「刻意不同步」的本機動物，伺服器驗證不到擊倒屬實：信任事件＋夾頻（XP_MOB_CD，使用者同意）
# 2026-11-09：事件帶數量 n（會反擊的野怪＝島主經驗 1/10，使用者同意延伸），伺服器夾 1～25 照帶記
XP_XPE_MAX = 25          # 擊倒非主動怪單次事件的 XP 上限（防亂報；一般野怪是 1）
XP_MAX = 200000          # XP 總量上限（防灌分的保險；等級無上限是設計，這裡只是存檔安全閥）
XP_MOB_CD = 1.0          # 擊倒非主動怪的 XP 冷卻（秒；每條連線，每來源每秒最多 1 次）
XP_NEED = lambda lv: 10 + 5 * (lv - 1)   # 每級需求 XP；與 client/js/main.js、worker 相同（改記得三邊都改）


def xp_info(xp):
    """XP 換等級：與 client 的 lvInfo 同演算法。"""
    lv, rest = 1, max(0, int(xp or 0))
    while lv < 2000 and rest >= XP_NEED(lv):
        rest -= XP_NEED(lv)
        lv += 1
    return {"lv": lv, "cur": rest, "need": XP_NEED(lv)}


def xp_death_loss(xp):
    """死亡扣款（與 client 的 loseExp 同值）：扣「升這級還需要的 XP」5%（整數、至少 1、最低扣到 0 不掉級）。"""
    i = xp_info(xp)
    return min(i["cur"], max(1, math.ceil(i["need"] * .05)))


# ---- 島主與深海魚人的等級（第 3 步；與 worker/src/index.js 的 dl* 及 client/js/main.js 同式，三邊一起改）----
# 島主：等級跟島主狀態存一起（dragon_state 加 "xp" 欄位，本機版重開就清空），永不重置、無上限；擊倒玩家得 XP＝10＋2×受害者等級。
# 每級需求 20＋10×(Lv−1)；每級血量上限 +25（基礎 D_HP）；爪擊與台詞招式每 2 級 +1（命令檢定不隨等級變強：倒地不看血量）
DL_HP_UP = 25


def dl_xp_need(lv):
    """島主每級需求 XP：20＋10×(Lv−1)。"""
    return 20 + 10 * (lv - 1)


def dl_lv(xp):
    """島主等級（XP 無上限直算；XP_MAX 200000 也只到約 200 級，迴圈安全）。"""
    lv, rest = 1, max(0, int(xp or 0))
    while rest >= dl_xp_need(lv):
        rest -= dl_xp_need(lv)
        lv += 1
    return lv


def dragon_max_hp(d):
    """目前等級的島主血量上限（回血夾這裡）。"""
    return D_HP + DL_HP_UP * (dl_lv(d.get("xp", 0)) - 1)


def dl_dmg_bonus(lv):
    """島主爪擊／台詞招式的等級傷害加成：每 2 級 +1。"""
    return (max(1, int(lv)) - 1) // 2


# 深海魚人：session 制——等級只在「這一隻」存活期成長（每殺 1 人 +1 級），消失／被打倒就重來（只放記憶體，天然重置）；
# 每級血量上限 +5（基礎 L_HP）；爪擊每 3 級 +1
L_HP_UP = 5


def lurk_dmg_bonus(lv):
    """魚人爪擊的等級傷害加成：每 3 級 +1。"""
    return (max(1, int(lv)) - 1) // 3


def lurker_max_hp(L):
    """目前等級的魚人血量上限。"""
    return L_HP + L_HP_UP * ((L.get("lvl") or 1) - 1)


# 擊倒獎勵：玩家擊倒島主／魚人由伺服器發 XP 給「30 秒內打過牠、還在線沒死」的所有參與者（與擊倒稱號的參與擊倒同一批）
def owner_kill_xp(lv):
    return 20 + 5 * lv


def lurk_kill_xp(lv):
    return 4 + 2 * lv


def dl_hit_max(lvl):
    """一般攻擊打島主／魚人的夾值隨攻擊者等級放寬：每 3 級 +1（與 client 的 lvAtkBonus 同式）。"""
    return D_HIT_MAX + (max(1, int(lvl)) - 1) // 3


def dragon_hp_msg(d):
    """島主 hp 廣播：把等級與血量上限一起帶出（升級時客戶端靠這則跟上）。"""
    return {"t": "dragon", "ev": "hp", "hp": d["hp"], "lvl": dl_lv(d.get("xp", 0)), "max": dragon_max_hp(d)}


def player_lvl_of(c):
    """玩家等級（打島主／魚人的傷害上限用）：登入且伺服器有存檔才採用存檔等級，其餘一律 Lv 1（不信客戶端自報的 state.lvl）。"""
    if c and c.get("user") and c.get("xp_known") and isinstance(c.get("xp"), (int, float)):
        return xp_info(c["xp"])["lv"]
    return 1


XP_DB = {}               # Discord 使用者 ID -> 總 XP（本機版存記憶體，重開就清空；正式站存在 Registry 的 xp:<uid>）
XP_DB_LOCK = threading.Lock()


def xp_grant(c, d, k):
    """記一次 XP（登入者）：累加進 XP_DB、更新連線的 xp／state.lvl、回給本人（不廣播）。"""
    user = c.get("user")
    if not user or not isinstance(d, int) or d == 0:
        return False
    with XP_DB_LOCK:
        nv = max(0, min(XP_MAX, XP_DB.get(user["id"], 0) + d))
        if nv != XP_DB.get(user["id"]):
            XP_DB[user["id"]] = nv
    c["xp"] = nv
    c["xp_known"] = True
    if c.get("state"):
        c["state"]["lvl"] = xp_info(nv)["lv"]   # 自己的名牌與之後的 p 廣播即時跟上
    with c.get("send") or threading.Lock():
        ws_send(c["sock"], json.dumps({"t": "xp", "xp": nv, "d": d, "k": k}))
    return True


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

CRAFT_KINDS = ("mat", "furn", "rec")   # 合成解鎖紀錄的三類（對應 Worker 的 Registry `craft:<uid>`）
CRAFT_MAX = 300           # 每類最多存幾筆
CRAFT_SYNC_MAX = 100      # craftsync 每類一次最多收幾筆
CRAFT_DB = {}             # Discord 使用者 ID -> {mat: {id: 時間}, furn: {...}, rec: {...}}（只存記憶體）
CRAFT_LOCK = threading.Lock()
CRAFT_ID_RE = re.compile(r"^[a-z0-9_-]{1,24}$")

def craft_add(uid, add):
    """併進解鎖紀錄（已有的不動；每類上限 CRAFT_MAX），回整份（複本）。"""
    with CRAFT_LOCK:
        c = CRAFT_DB.setdefault(uid, {})
        for k in CRAFT_KINDS:
            m = c.setdefault(k, {})
            ids = add.get(k) if isinstance(add, dict) else None
            for i in (ids if isinstance(ids, list) else []):
                i = str(i)
                if CRAFT_ID_RE.match(i) and i not in m and len(m) < CRAFT_MAX:
                    m[i] = int(time.time() * 1000)
        return json.loads(json.dumps(c))

KILLS_DB = {}             # Discord 使用者 ID -> {有島主的地形: 時間}（擊倒島主紀錄；對應 Worker 的 Registry `kills:<uid>`，只存記憶體）
KILLS_LOCK = threading.Lock()

def kills_add(uid, add):
    """併進擊倒島主紀錄（只收 OWNER_TERRAINS 的地形，已有的不動），回整份（複本）。"""
    with KILLS_LOCK:
        k = KILLS_DB.setdefault(uid, {})
        for t in (add if isinstance(add, list) else []):
            t = str(t)
            if t in OWNER_TERRAINS and t not in k:
                k[t] = int(time.time() * 1000)
        return dict(k)

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
OWNER_TERRAINS = {"grass": "dash", "night": "gaze", "volcano": "beam", "machine": "command"}
D_CAST_MS = 2000         # 龍衝的島緣鎖定（預警）持續時間（頭上有讀條，跟石化之瞳一樣 2 秒；與 Worker、client 的 OWNER_CAST 一致）
D_GAZE_CAST_MS = 2000    # 石化之瞳的開眼預警持續時間（與 client 的 OWNER_GAZE_CAST 一致）
D_BEAM_CAST_MS = 2000    # 波動砲的讀條持續時間（與 client 的 OWNER_BEAM_CAST 一致）
D_COMMAND_CAST_MS = 2000 # 命令（行動／靜止命令）的讀條持續時間（與 client 的 OWNER_COMMAND_CAST 一致；檢定在各客戶端本地）
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
DEATH_CREDIT_MIN = 25.0  # 同一條連線的「倒地記帳」（餵島主 XP／魚人升級）最短間隔（秒；與 worker 的 DEATH_CREDIT_MIN_MS 一致）：復活要 30 秒，正常玩法不會更密；擋住反覆切 state.dead 灌島主等級
D_HIT_MAX = 6            # 一般攻擊打島主／深海魚人的傷害上限（與 worker 的 D_HIT_MAX 一致；2026-11-05 由 2 放寬到 4，2026-11-07 再放寬到 6：黑魔法師咒杖 4＋輸出 1＝5，留 1 的餘裕）。夾值隨攻擊者等級放寬（每 3 級 +1，見 dl_hit_max）
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

# ============ 和平島：遊戲桌（第一桌：抽鬼牌；2026-11-08，使用者要求）============
# 牌局由伺服器權威：洗牌、發牌、抽牌、判定都在這裡，手牌只送給本人（別人只看得到張數）。
# 與 worker/src/index.js 的 TABLE_DEFS／om* 同一套邏輯，改規則兩邊一起改。桌子的位置與外觀在客戶端 terrain.json 的 tables。
TABLE_DEFS = {"peace": {"t1": "oldmaid", "t2": "gomoku", "t5": "dodge", "t6": "uno", "t7": "typing", "t8": "intel", "t9": "zhtyping", "t10": "mage", "t11": "blokus", "t12": "trigon", "t13": "arcade", "t14": "maze", "t15": "hockey", "t16": "hockey"}}   # 地形 → 桌 id → 遊戲 id（客戶端 terrain.json 的 tables 要一致）
GAME_LIMITS = {"oldmaid": (2, 4), "gomoku": (2, 2), "dodge": (1, 8), "uno": (2, 6), "typing": (1, 8), "zhtyping": (1, 8), "intel": (3, 8), "mage": (1, 4), "blokus": (2, 4), "trigon": (2, 4), "arcade": (1, 4), "maze": (1, 5), "hockey": (2, 8)}           # 遊戲 → (開局最少人數, 入座上限)
TBL_TYP_CD = 0.2                              # 英文打字競賽的打字進度回報（typ）：每條連線最短間隔（秒）
TBL_POS_CD = 0.06                           # 躲彈幕的位置回報、英文打字競賽的分數回報：每條連線最短間隔（秒，約 16 次／秒上限；客戶端實際約 8 次／秒）
TBL_CD = 0.1                                # 每條連線兩次牌桌操作的最短間隔（秒）
# 玩小遊戲得 XP（2026-11-08，使用者要求；數值是助手先訂的）：對局正常結束（沒人中途離開）時，每位入座者各得一份，寫在 result.xp（依座位順序）
# 輸贏經驗一樣（使用者定）：抽鬼牌每位 +4；五子棋勝／負／平手都 +5（下不到 10 手就結束的不給，擋刷分）。
# 登入者由伺服器記帳（同一帳號兩次得分最短間隔 GAME_XP_CD 秒）；訪客由客戶端看 result.xp 本機補發
GAME_XP_CD = 30.0
OM_XP = 4             # 抽鬼牌：每位入座者（過關者與輸家一樣）
GM_XP = 5             # 五子棋：勝／負／平手都一樣
GM_XP_MIN_MOVES = 10
OM_SUITS = "SHDC"
OM_SYM = {"S": "♠", "H": "♥", "D": "♦", "C": "♣"}

def om_rank(card):
    return None if card == "JK" else int(card[1:])

def om_label(card):
    r = om_rank(card)
    return "鬼牌" if r is None else OM_SYM[card[0]] + {1: "A", 11: "J", 12: "Q", 13: "K"}.get(r, str(r))

def om_drop_pairs(hand):
    """丟掉成對的牌（同點數兩張一對；鬼牌不成對）。回 (剩下的牌（已洗亂）, 丟掉的牌)。"""
    by = {}
    for c in hand:
        by.setdefault(om_rank(c), []).append(c)
    keep, gone = [], []
    for r, cs in by.items():
        if r is None:
            keep += cs
            continue
        n = len(cs) // 2 * 2
        gone += cs[:n]
        keep += cs[n:]
    random.shuffle(keep)
    return keep, gone

def tbl_new(tid, game):
    return {"id": tid, "game": game, "phase": "lobby", "seats": [], "specs": [], "turn": -1, "result": None, "log": [], "g": None}   # g：遊戲自己的狀態（五子棋的棋盤；抽鬼牌用不到）

def tbl_find(t, cid):
    for i, s in enumerate(t["seats"]):
        if s["cid"] == cid:
            return "seat", i
    for i, s in enumerate(t["specs"]):
        if s["cid"] == cid:
            return "spec", i
    return None, -1

def tbl_log(t, text):
    t["log"].append(text)
    del t["log"][:-8]

def tbl_next_active(t, i):
    """座位 i 之後（順時針）第一個還沒出局的座位；沒有回 -1。"""
    n = len(t["seats"])
    for k in range(1, n + 1):
        j = (i + k) % n
        if not t["seats"][j]["out"]:
            return j
    return -1

def tbl_reset_seats(t):
    for s in t["seats"]:
        s["ready"], s["hand"], s["out"] = False, [], False
    t["phase"], t["turn"], t["g"] = "lobby", -1, None

def tbl_join(t, cid, name, want="seat", uid=None):
    """want＝'seat'（有空位且還沒開局才會入座，否則自動觀戰）或 'spec'（使用者自己選觀戰：沒滿人也可以）。"""
    if tbl_find(t, cid)[0]:
        return
    mn, mx = GAME_LIMITS[t["game"]]
    if want != "spec" and t["phase"] == "lobby" and len(t["seats"]) < mx:
        t["seats"].append({"cid": cid, "name": name, "uid": uid, "ready": False, "hand": [], "out": False})
        tbl_log(t, f"{name} 入座了")
    else:
        t["specs"].append({"cid": cid, "name": name, "uid": uid})
        tbl_log(t, f"{name} 來觀戰")

def tbl_leave(t, cid):
    role, i = tbl_find(t, cid)
    if role == "spec":
        t["specs"].pop(i)
    elif role == "seat":
        name = t["seats"][i]["name"]
        if t["game"] == "arcade":   # 俄羅斯方塊：單人局作廢、聯機照當時分數排名，不中斷其他人
            ar_leave(t, i)
            return
        if t["phase"] == "playing" and t["game"] == "trigon":   # Blokus Trigon：離開不中斷，棋子留在棋盤上、之後跳過
            tg_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and t["game"] == "blokus":   # Blokus：離開不中斷，棋子留在棋盤上、之後跳過
            bk_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and t["game"] == "maze":   # 豆豆迷宮：幽靈離開改由電腦控制、豆豆離開＝幽靈方贏
            mz_leave(t, i)
            return
        if t["phase"] == "playing" and t["game"] == "dodge":   # 躲彈幕：離開不中斷，視同淘汰，到場上沒有活人為止
            dg_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and t["game"] == "mage":   # 見習驅魔師：離開不中斷，視同倒下，到場上沒有活人為止
            mg_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and t["game"] == "uno":   # UNO：離開不中斷，手牌收回牌堆，只剩 1 人時那人獲勝
            un_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and ty_is(t):   # 英文打字競賽：離開不中斷，照當時分數排名
            ty_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing" and t["game"] == "intel":   # 秘藥情報戰：離開不中斷，翻開身分，場上只剩一個陣營時結束
            it_leave(t, i, int(time.time() * 1000))
            return
        if t["phase"] == "playing":   # 使用者定：有人離開（含斷線）直接結束這一局
            t["result"] = {"aborted": True, "text": f"{name} 離開了，這一局結束"}
            tbl_reset_seats(t)
            tbl_log(t, t["result"]["text"])
        else:
            tbl_log(t, f"{name} 離開了座位")
        t["seats"].pop(i)

def tbl_check_start(t):
    mn, mx = GAME_LIMITS[t["game"]]
    if t["phase"] == "lobby" and len(t["seats"]) >= mn and all(s["ready"] for s in t["seats"]):   # 使用者定：全員按「準備」才開始
        GAME_START[t["game"]](t)

def tbl_stand(t, cid):
    """入座的人改成觀戰（只有還沒開局時；進行中要離開就是 leave，會結束這一局）。剩下的人若都已準備就開局。"""
    role, i = tbl_find(t, cid)
    if role != "seat" or t["phase"] != "lobby" or t["game"] == "arcade":
        return
    s = t["seats"].pop(i)
    t["specs"].append({"cid": cid, "name": s["name"], "uid": s.get("uid")})
    tbl_log(t, f"{s['name']} 改為觀戰")
    tbl_check_start(t)

def tbl_sit(t, cid):
    role, i = tbl_find(t, cid)
    mn, mx = GAME_LIMITS[t["game"]]
    if role != "spec" or t["phase"] != "lobby" or len(t["seats"]) >= mx or t["game"] == "arcade":   # 俄羅斯方塊：要入座就走到空機台
        return
    s = t["specs"].pop(i)
    t["seats"].append({"cid": cid, "name": s["name"], "uid": s.get("uid"), "ready": False, "hand": [], "out": False})
    tbl_log(t, f"{s['name']} 入座了")

def tbl_ready(t, cid, v):
    role, i = tbl_find(t, cid)
    if role != "seat" or t["phase"] != "lobby" or t["game"] == "arcade":
        return
    t["seats"][i]["ready"] = bool(v)
    tbl_check_start(t)

def om_start(t):
    deck = [f"{s}{r}" for s in OM_SUITS for r in range(1, 14)] + ["JK"]
    random.shuffle(deck)
    n = len(t["seats"])
    for k, s in enumerate(t["seats"]):
        s["hand"], s["out"], s["ready"] = deck[k::n], False, False
    t["result"] = None
    t["phase"] = "playing"
    tbl_log(t, "牌局開始，發牌！")
    for s in t["seats"]:
        s["hand"], gone = om_drop_pairs(s["hand"])
        if gone:
            tbl_log(t, f"{s['name']} 先丟掉了 {len(gone) // 2} 對牌")
        s["out"] = not s["hand"]
    alive = [i for i, s in enumerate(t["seats"]) if not s["out"]]
    if len(alive) <= 1:
        om_finish(t, alive[0])
        return
    t["turn"] = random.choice(alive)
    tbl_log(t, f"由 {t['seats'][t['turn']]['name']} 先抽牌")

def om_finish(t, loser):
    name = t["seats"][loser]["name"]
    t["result"] = {"loser": loser, "name": name, "text": f"{name} 抽到鬼牌，輸了！", "rid": random.getrandbits(32),
                   "xp": [OM_XP] * len(t["seats"]), "gs": [gs_mk({"l": 1} if k == loser else {"s": 1}) for k in range(len(t["seats"]))]}
    tbl_log(t, t["result"]["text"])
    tbl_reset_seats(t)

def om_draw(t, cid, idx):
    role, i = tbl_find(t, cid)
    if t["game"] != "oldmaid" or role != "seat" or t["phase"] != "playing" or i != t["turn"]:
        return
    tgt = tbl_next_active(t, i)
    if tgt < 0 or tgt == i:
        return
    me, th = t["seats"][i], t["seats"][tgt]
    if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < len(th["hand"]):
        return
    card = th["hand"].pop(idx)
    me["hand"].insert(random.randint(0, len(me["hand"])), card)   # 抽到的牌插在隨機位置（不是固定最右邊，否則對方避開最右邊就不會抽到剛換手的鬼牌）
    tbl_log(t, f"{me['name']} 從 {th['name']} 手上抽了一張牌")
    if card != "JK":
        mate = next((c for c in me["hand"] if c != card and om_rank(c) == om_rank(card)), None)
        if mate:
            me["hand"].remove(card)
            me["hand"].remove(mate)
            tbl_log(t, f"{me['name']} 湊成一對（{om_label(card)}、{om_label(mate)}）丟掉")
    # 不自動洗牌：對方點的是「第幾張牌背」，要和這個人畫面上手牌的順序一致，洗牌是玩家自己的心理戰（om_shuffle）
    for s in (me, th):
        if not s["hand"] and not s["out"]:
            s["out"] = True
            tbl_log(t, f"{s['name']} 的牌出完了，安全過關！")
    alive = [k for k, s in enumerate(t["seats"]) if not s["out"]]
    if len(alive) <= 1:
        om_finish(t, alive[0])
        return
    t["turn"] = tbl_next_active(t, i)

def om_shuffle(t, cid):
    """玩家自己洗牌（心理戰：讓對方猜不到鬼牌在哪）；手牌順序就是對方看到的牌背順序。"""
    role, i = tbl_find(t, cid)
    if t["game"] != "oldmaid" or role != "seat" or t["phase"] != "playing":
        return
    me = t["seats"][i]
    if len(me["hand"]) < 2:
        return
    random.shuffle(me["hand"])
    tbl_log(t, f"{me['name']} 洗了牌")

# ---- 五子棋（第二桌；2026-11-08，使用者要求）：15×15、兩人、黑棋先下（開局隨機決定誰執黑）、橫直斜連成五子（含以上）就贏、棋盤滿了平手 ----
GM_N = 15

def gm_start(t):
    black = random.randrange(2)   # 座位 0／1 誰執黑
    t["g"] = {"board": [0] * (GM_N * GM_N), "black": black, "last": None, "line": None, "moves": []}   # moves：每一手的 [x, y]（第 0 手是黑棋；結束後給客戶端復盤）   # board：0 空、1 黑、2 白
    t["result"] = None
    t["phase"] = "playing"
    t["turn"] = black   # 黑先
    for s in t["seats"]:
        s["ready"] = False
    tbl_log(t, f"對局開始，{t['seats'][black]['name']} 執黑先下")

def gm_line(board, x, y, color):
    """剛下在 (x, y) 的棋是否連成五子（含以上）：回連成的那一排（座標清單），沒有回 None。"""
    for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
        cells = [[x, y]]
        for sgn in (1, -1):
            cx, cy = x + dx * sgn, y + dy * sgn
            while 0 <= cx < GM_N and 0 <= cy < GM_N and board[cy * GM_N + cx] == color:
                cells.append([cx, cy])
                cx, cy = cx + dx * sgn, cy + dy * sgn
        if len(cells) >= 5:
            return sorted(cells)
    return None

def gm_finish(t, winner, line):
    """對局結束：winner＝座位編號，None＝平手。棋盤留著給大家看（到下一局開始才清掉）。"""
    g = t.get("g")
    enough = len(g["moves"]) >= GM_XP_MIN_MOVES
    nm = len(g["moves"])
    gs = [gs_mk({"w": 1} if winner == k else {}, {}, {"fm": nm} if winner == k else {}) if enough else None for k in range(2)]   # 下不到 10 手的不記（同 XP，擋互刷）；fm＝獲勝時的總手數（取最小）
    if winner is None:
        t["result"] = {"draw": True, "text": "棋盤下滿了，平手！", "rid": random.getrandbits(32), "xp": [GM_XP if enough else 0] * 2, "gs": gs}
    else:
        name = t["seats"][winner]["name"]
        t["result"] = {"winner": winner, "name": name, "text": f"{name} 五子連線，獲勝！", "rid": random.getrandbits(32),
                       "xp": [GM_XP if enough else 0] * 2, "gs": gs}
    tbl_log(t, t["result"]["text"])
    tbl_reset_seats(t)
    t["g"] = g

def gm_move(t, cid, x, y):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "gomoku" or role != "seat" or t["phase"] != "playing" or i != t["turn"] or not g:
        return
    if not all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v < GM_N for v in (x, y)):
        return
    if g["board"][y * GM_N + x]:
        return
    color = 1 if i == g["black"] else 2
    g["board"][y * GM_N + x] = color
    g["last"] = [x, y]
    g["moves"].append([x, y])
    line = gm_line(g["board"], x, y, color)
    if line:
        g["line"] = line
        gm_finish(t, i, line)
    elif all(g["board"]):
        gm_finish(t, None, None)
    else:
        t["turn"] = 1 - i

# ---- Blokus（第十一桌 t11；2026-11-13，使用者要求）：2～4 人、20×20、每人 21 塊（1～5 格，共 89 格）、標準規則 ----
# 第一塊要蓋住自己的角落；之後每塊都要「角對角」接到自己的舊方塊，且不能「邊對邊」；碰到別人的不限。放不下的人自動跳過（之後一直跳過），全員放不下就結束。
# 計分＝−剩下的格數；全部放完 +15、最後一塊是單格再 +5。每手限時 BK_TURN_MS（客戶端到時送 timeout，伺服器核對時鐘；連續超時 BK_IDLE_MAX 次視為棄權）。
# 排行榜沒有（使用者定）。與 worker/src/index.js 的 bk* 同一套。
BK_N, BK_TURN_MS, BK_IDLE_MAX, BK_XP, BK_TOTAL = 20, 45000, 2, 6, 89
BK_SHAPES = [["#"], ["##"], ["###"], ["##", "#."], ["####"], ["##", "##"], ["###", ".#."], ["###", "#.."], [".##", "##."],
             [".##", "##.", ".#."], ["#####"], ["####", "#..."], ["##..", ".###"], ["##", "##", "#."], ["###", ".#.", ".#."], ["#.#", "###"],
             ["#..", "#..", "###"], ["#..", "##.", ".##"], [".#.", "###", ".#."], ["####", ".#.."], ["##.", ".#.", ".##"]]   # 21 塊：1／2／3×2／4×5／5×12
BK_PIECES = [[(x, y) for y, r in enumerate(rows) for x, ch in enumerate(r) if ch == "#"] for rows in BK_SHAPES]
BK_CORNERS = [(0, 0), (BK_N - 1, 0), (BK_N - 1, BK_N - 1), (0, BK_N - 1)]
# 2 人局用 Blokus Duo 規則（2026-11-13，使用者要求）：14×14 的棋盤，兩人的起始格是 (4, 4) 與 (9, 9)（不是角落）；3～4 人仍是 20×20、四個角落。
BK_DUO_N = 14
BK_DUO_START = {0: (4, 4), 2: (9, 9)}   # 顏色 → 起始格（Duo；2 人用顏色 0 與 2）

def bk_size(g):
    return g.get("size", BK_N)

def bk_start_of(g, k):
    return g["start"][k] if g.get("start") else BK_CORNERS[g["col"][k]]   # 顏色 0～3 的起始角落（藍左上、黃右上、紅右下、綠左下）
BK_DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1)]
BK_DIAGS = [(1, 1), (1, -1), (-1, 1), (-1, -1)]

def bk_norm(cells):
    mx, my = min(c[0] for c in cells), min(c[1] for c in cells)
    return sorted(((x - mx, y - my) for x, y in cells), key=lambda c: (c[1], c[0]))

def bk_key(cells):
    return ";".join(f"{x},{y}" for x, y in bk_norm(cells))

def _bk_orients(cells):
    """每塊的所有不重複方向（旋轉 4 × 翻面 2）。"""
    seen = {}
    c = list(cells)
    for _f in range(2):
        for _r in range(4):
            n = bk_norm(c)
            seen[bk_key(n)] = n
            c = [(-y, x) for x, y in c]
        c = [(-x, y) for x, y in c]
    return list(seen.values())

BK_ORI = [_bk_orients(c) for c in BK_PIECES]
BK_ORI_KEYS = [set(bk_key(o) for o in os_) for os_ in BK_ORI]

def bk_legal(g, k, cells):
    """座標 cells（絕對座標）放給座位 k 合不合法。"""
    N, col = bk_size(g), g["col"][k] + 1
    sx, sy = bk_start_of(g, k)
    first = g["sd"][k]["placed"] == 0
    board = g["board"]
    corner = start = False
    for x, y in cells:
        if x < 0 or y < 0 or x >= N or y >= N or board[y * N + x]:
            return False
        if x == sx and y == sy:
            start = True
        for dx, dy in BK_DIRS:
            a, b = x + dx, y + dy
            if 0 <= a < N and 0 <= b < N and board[b * N + a] == col:
                return False
        for dx, dy in BK_DIAGS:
            a, b = x + dx, y + dy
            if 0 <= a < N and 0 <= b < N and board[b * N + a] == col:
                corner = True
    return start if first else corner

def bk_moves(g, k, one=False):
    """座位 k 所有合法放法 [(p, key, cells)]（依 key 排序，測試用）；one＝True 時找到一個就回（判斷有沒有地方放）。"""
    N, col, sd = bk_size(g), g["col"][k] + 1, g["sd"][k]
    board = g["board"]
    out, seen, anchors = [], set(), []
    if sd["placed"] == 0:
        anchors.append(bk_start_of(g, k))
    else:
        mark = set()
        for y in range(N):
            for x in range(N):
                if board[y * N + x] != col:
                    continue
                for dx, dy in BK_DIAGS:
                    a, b = x + dx, y + dy
                    if a < 0 or b < 0 or a >= N or b >= N or board[b * N + a] or (b * N + a) in mark:
                        continue
                    if any(0 <= a + ex < N and 0 <= b + ey < N and board[(b + ey) * N + a + ex] == col for ex, ey in BK_DIRS):
                        continue
                    mark.add(b * N + a)
                    anchors.append((a, b))
    for p in range(len(BK_PIECES)):
        if p in sd["used"]:
            continue
        for o in BK_ORI[p]:
            for cx, cy in o:
                for ax, ay in anchors:
                    cells = [(x - cx + ax, y - cy + ay) for x, y in o]
                    if not bk_legal(g, k, cells):
                        continue
                    key = f"{p}:" + ",".join(str(v) for v in sorted(c[1] * N + c[0] for c in cells))
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append((p, key, cells))
                    if one:
                        return out
    return sorted(out, key=lambda m: m[1])

def bk_rem(g, k):
    return BK_TOTAL - sum(len(BK_PIECES[p]) for p in g["sd"][k]["used"])

def bk_score(g, k):
    r = bk_rem(g, k)
    return -r + (15 + (5 if g["sd"][k]["mono"] else 0) if r == 0 else 0)

def bk_start(t):
    n, now = len(t["seats"]), int(time.time() * 1000)
    cols = [0, 2] if n == 2 else [0, 1, 2, 3][:n]   # 2 人坐對角；顏色隨機分配
    random.shuffle(cols)
    size = BK_DUO_N if n == 2 else BK_N   # 2 人＝Blokus Duo（14×14、起始格 (4, 4)／(9, 9)）
    t["g"] = {"size": size, "start": [BK_DUO_START[c] if n == 2 else BK_CORNERS[c] for c in cols], "board": [0] * (size * size), "col": cols,
              "sd": [{"used": [], "placed": 0, "done": False, "idle": 0, "forfeit": False, "mono": False} for _ in cols],
              "last": None, "moves": 0, "deadline": now + BK_TURN_MS}
    t["result"], t["phase"], t["turn"] = None, "playing", cols.index(0)   # 藍色先下
    for s in t["seats"]:
        s["ready"], s["left"] = False, False
    tbl_log(t, f"Blokus 開始！{n} 人參加，{t['seats'][t['turn']]['name']}（藍）先下")

def bk_advance(t, frm, now):
    """輪到 frm 之後的下一位還能下的人；放不下的人標成 done（之後一直跳過）；沒有人能下就結束。"""
    g, n = t["g"], len(t["seats"])
    for k in range(1, n + 1):
        j = (frm + k) % n
        sd = g["sd"][j]
        if sd["done"]:
            continue
        if not bk_moves(g, j, True):
            sd["done"] = True
            tbl_log(t, f"{t['seats'][j]['name']} 沒有地方可以放了，之後跳過")
            continue
        t["turn"], g["deadline"] = j, now + BK_TURN_MS
        return
    bk_finish(t)

def bk_finish(t):
    g = t["g"]
    players = [{"name": s["name"], "col": g["col"][k], "rem": bk_rem(g, k), "score": bk_score(g, k), "left": bool(s.get("left")), "forfeit": bool(g["sd"][k]["forfeit"])}
               for k, s in enumerate(t["seats"])]
    best = max(p["score"] for p in players)
    winners = [k for k, p in enumerate(players) if p["score"] == best]
    stay = [(k, s) for k, s in enumerate(t["seats"]) if not s.get("left")]
    active = sum(1 for k, s in enumerate(t["seats"]) if not s.get("left") and not g["sd"][k]["forfeit"])
    xp = [BK_XP if active >= 2 and not g["sd"][k]["forfeit"] else 0 for k, s in stay]
    gs = [gs_mk({**({"w": 1} if k in winners else {}), **({"all": 1} if players[k]["rem"] == 0 else {}), **({"mono": 1} if players[k]["rem"] == 0 and g["sd"][k]["mono"] else {}), **({"duo": 1} if k in winners and bk_size(g) == 14 else {})})
          if active >= 2 and not players[k]["forfeit"] else None for k, s in stay]   # all＝21 塊全放完、mono＝最後一塊是單格、duo＝2 人局（Duo）獲勝
    names = "、".join(players[k]["name"] for k in winners)
    text = f"{names} 同分平手（{best} 分）" if len(winners) > 1 else f"{names} 獲勝！（{best} 分）"
    t["seats"] = [s for _k, s in stay]
    t["result"] = {"text": text, "rid": random.getrandbits(32), "xp": xp, "players": players, "winners": winners, "draw": len(winners) > 1, "gs": gs}
    tbl_log(t, text)
    tbl_reset_seats(t)
    t["g"] = g   # 最後的棋盤留著給大家看，到下一局開始才清掉

def bk_place(t, cid, p, cs, now):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "blokus" or role != "seat" or t["phase"] != "playing" or i != t["turn"] or not g:
        return
    if type(p) is not int or p < 0 or p >= len(BK_PIECES) or p in g["sd"][i]["used"] or type(cs) is not list or len(cs) != len(BK_PIECES[p]):
        return
    cells = []
    for c in cs:
        if type(c) is not list or len(c) != 2 or type(c[0]) is not int or type(c[1]) is not int:
            return
        cells.append((c[0], c[1]))
    if bk_key(cells) not in BK_ORI_KEYS[p] or not bk_legal(g, i, cells):
        return
    sd = g["sd"][i]
    for x, y in cells:
        g["board"][y * bk_size(g) + x] = g["col"][i] + 1
    sd["used"].append(p)
    sd["placed"] += 1
    sd["idle"] = 0
    sd["mono"] = p == 0
    g["last"] = {"seat": i, "cells": [[x, y] for x, y in cells]}
    g["moves"] += 1
    bk_advance(t, i, now)

def bk_timeout(t, now):
    """回合限時到了：跳過；連續超時 BK_IDLE_MAX 次視為棄權（不然一個人掛機整桌會一直等）。"""
    g = t.get("g")
    if t["game"] != "blokus" or t["phase"] != "playing" or not g or now < g["deadline"] - 300:
        return
    i = t["turn"]
    sd = g["sd"][i]
    sd["idle"] += 1
    if sd["idle"] >= BK_IDLE_MAX:
        sd["done"], sd["forfeit"] = True, True
        tbl_log(t, f"{t['seats'][i]['name']} 連續超時，視為棄權")
    else:
        tbl_log(t, f"{t['seats'][i]['name']} 超時，跳過這一手")
    bk_advance(t, i, now)

def bk_leave(t, i, now):
    """遊戲進行中有人離開：棋子留在棋盤上、之後跳過；沒人能下就結束。"""
    s, g = t["seats"][i], t["g"]
    if s.get("left"):
        return
    s["left"], s["cid"] = True, None
    g["sd"][i]["done"] = True
    tbl_log(t, f"{s['name']} 離開了")
    if i == t["turn"]:
        bk_advance(t, i, now)
    elif all(d["done"] for d in g["sd"]):
        bk_finish(t)

# ---- Blokus Trigon（第十二桌 t12；2026-11-13，使用者要求）：2～4 人、正六邊形的三角格棋盤（邊長 9，共 486 格）、每人 22 塊（1～6 個三角形，共 110 格）----
# 規則與座標系說明見 worker/src/index.js 的 tg*（同一套）：三角形 (x, y)、(x + y) 偶數＝朝上；頂點是格點 (i, j)；方向轉換用軸座標 ((i − j) / 2, j)。
TG_N, TG_CX, TG_W, TG_ROWS, TG_VW, TG_TURN_MS, TG_IDLE_MAX, TG_XP, TG_TOTAL = 9, 19, 39, 18, 41, 45000, 2, 6, 110
TG_PIECES = [[(0, 0)], [(0, 0), (0, 1)], [(0, 0), (-1, 1), (0, 1)], [(0, 0), (-1, 1), (0, 1), (-1, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1)], [(0, 0), (-2, 1), (-1, 1), (0, 1)], [(0, 0), (-1, 1), (0, 1), (-1, 2), (0, 2)], [(0, 0), (-1, 1), (0, 1), (-2, 2), (-1, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1), (-1, 2)], [(0, 0), (1, 0), (0, 1), (1, 1), (2, 1)], [(0, 0), (-1, 1), (0, 1), (-1, 2), (0, 2), (0, 3)], [(0, 0), (-1, 1), (0, 1), (-1, 2), (0, 2), (1, 2)], [(0, 0), (-1, 1), (0, 1), (-2, 2), (-1, 2), (-2, 3)], [(0, 0), (-1, 1), (0, 1), (-2, 2), (-1, 2), (0, 2)], [(0, 0), (-1, 1), (0, 1), (-3, 2), (-2, 2), (-1, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1), (-1, 2), (0, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1), (-1, 2), (1, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1), (2, 1), (-1, 2)], [(0, 0), (-1, 1), (0, 1), (1, 1), (2, 1), (1, 2)], [(0, 0), (-2, 1), (-1, 1), (0, 1), (-2, 2), (-1, 2)], [(0, 0), (-3, 1), (-2, 1), (-1, 1), (0, 1), (-3, 2)], [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]]   # 22 塊 polyiamond（1／1／1／3／4／12 種，三角形的 (x, y)，已正規化；與客戶端、Worker 同一份）

def tg_verts(x, y):
    return [(x, y), (x - 1, y + 1), (x + 1, y + 1)] if (x + y) % 2 == 0 else [(x - 1, y), (x + 1, y), (x, y + 1)]

def tg_from_verts(vs):
    jm = min(v[1] for v in vs)
    top = [v for v in vs if v[1] == jm]
    if len(top) == 2:
        return (next(v for v in vs if v[1] != jm)[0], jm)
    return (top[0][0], jm)

def tg_xform(c, rot, flip):
    out = []
    for i, j in tg_verts(c[0], c[1]):
        a, b = (i - j) // 2, j
        for _ in range(rot):
            a, b = -b, a + b
        if flip:
            a, b = -a - b, b
        out.append((2 * a + b, b))
    return tg_from_verts(out)

def tg_norm(cells):
    y0 = min(c[1] for c in cells)
    x0 = min(c[0] for c in cells if c[1] == y0)
    p = (x0 + y0) % 2
    dx, dy = -x0 + p, -y0
    return sorted(((c[0] + dx, c[1] + dy) for c in cells), key=lambda c: (c[1], c[0]))

def tg_key(cells):
    return ";".join(f"{x},{y}" for x, y in tg_norm(cells))

def _tg_orients(cells):
    seen = {}
    for f in (0, 1):
        for r in range(6):
            n = tg_norm([tg_xform(c, r, f) for c in cells])
            seen[tg_key(n)] = n
    return list(seen.values())

TG_ORI = [_tg_orients(c) for c in TG_PIECES]
TG_ORI_KEYS = [set(tg_key(o) for o in os_) for os_ in TG_ORI]

def tg_left(j): return TG_CX - TG_N - j if j <= TG_N else TG_CX - 3 * TG_N + j
def tg_right(j): return TG_CX + TG_N + j if j <= TG_N else TG_CX + 3 * TG_N - j
def tg_in_v(i, j): return 0 <= j <= 2 * TG_N and tg_left(j) <= i <= tg_right(j)

TG_CORNERS = [(TG_CX - TG_N, 0), (TG_CX + TG_N, 0), (TG_CX + 2 * TG_N, TG_N), (TG_CX + TG_N, 2 * TG_N), (TG_CX - TG_N, 2 * TG_N), (TG_CX - 2 * TG_N, TG_N)]   # 六個頂點（左上起順時針）
TG_SLOTS = {2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4]}   # 各人數用哪幾個頂點（2 人對角、3 人隔一個、4 人兩兩對稱）
TG_VALID = [0] * (TG_W * TG_ROWS)
TG_EDGE, TG_CELLV, TG_AROUND = {}, {}, {}
for _y in range(TG_ROWS):
    for _x in range(TG_W):
        if all(tg_in_v(i, j) for i, j in tg_verts(_x, _y)):
            TG_VALID[_y * TG_W + _x] = 1
for _y in range(TG_ROWS):
    for _x in range(TG_W):
        _c = _y * TG_W + _x
        if not TG_VALID[_c]:
            continue
        TG_EDGE[_c] = [b * TG_W + a for a, b in ((_x - 1, _y), (_x + 1, _y), (_x, _y + 1 if (_x + _y) % 2 == 0 else _y - 1))
                       if 0 <= a < TG_W and 0 <= b < TG_ROWS and TG_VALID[b * TG_W + a]]
        TG_CELLV[_c] = [j * TG_VW + i for i, j in tg_verts(_x, _y)]
        for _v in TG_CELLV[_c]:
            TG_AROUND.setdefault(_v, []).append(_c)

def tg_vid(p):
    return p[1] * TG_VW + p[0]

def tg_legal(g, k, cells):
    """座位 k 放這些格子（格子編號 y * TG_W + x）合不合法。"""
    col, corner, first, b = g["col"][k] + 1, tg_vid(TG_CORNERS[g["corner"][k]]), g["sd"][k]["placed"] == 0, g["board"]
    touch = start = False
    for c in cells:
        if not TG_VALID[c] or b[c]:
            return False
        for e in TG_EDGE[c]:
            if b[e] == col:
                return False
        for v in TG_CELLV[c]:
            if v == corner:
                start = True
            if not touch:
                for t in TG_AROUND[v]:
                    if t != c and b[t] == col:
                        touch = True
                        break
    return start if first else touch

def tg_moves(g, k, one=False):
    """座位 k 所有合法放法 [(p, key, cells)]（依 key 排序，測試用）；one＝True 時找到一個就回。"""
    col, sd, b = g["col"][k] + 1, g["sd"][k], g["board"]
    out, seen, anchors, mark = [], set(), [], set()
    if sd["placed"] == 0:
        anchors = [t for t in TG_AROUND[tg_vid(TG_CORNERS[g["corner"][k]])] if not b[t]]
    else:
        for c in range(len(b)):
            if b[c] != col:
                continue
            for v in TG_CELLV[c]:
                for t in TG_AROUND[v]:
                    if b[t] or t in mark or any(b[e] == col for e in TG_EDGE[t]):
                        continue
                    mark.add(t)
                    anchors.append(t)
    anchors.sort()
    for p in range(len(TG_PIECES)):
        if p in sd["used"]:
            continue
        for o in TG_ORI[p]:
            for ox, oy in o:
                for a in anchors:
                    ax, ay = a % TG_W, a // TG_W
                    if ((ox + oy) ^ (ax + ay)) & 1:
                        continue   # 方向（朝上／朝下）要一樣，平移才合法
                    dx, dy = ax - ox, ay - oy
                    cells = []
                    okb = True
                    for x, y in o:
                        X, Y = x + dx, y + dy
                        if X < 0 or X >= TG_W or Y < 0 or Y >= TG_ROWS:
                            okb = False
                            break
                        cells.append(Y * TG_W + X)
                    if not okb or not tg_legal(g, k, cells):
                        continue
                    cells.sort()
                    key = f"{p}:" + ",".join(str(c) for c in cells)
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append((p, key, cells))
                    if one:
                        return out
    return sorted(out, key=lambda m: m[1])

def tg_rem(g, k):
    return TG_TOTAL - sum(len(TG_PIECES[p]) for p in g["sd"][k]["used"])

def tg_score(g, k):
    r = tg_rem(g, k)
    return -r + (15 + (5 if g["sd"][k]["mono"] else 0) if r == 0 else 0)

def tg_start(t):
    n, now = len(t["seats"]), int(time.time() * 1000)
    cols = [0, 1, 2, 3][:n]   # 顏色隨機分配；顏色 c 固定用第 c 個頂點（TG_SLOTS）
    random.shuffle(cols)
    t["g"] = {"board": [0] * (TG_W * TG_ROWS), "col": cols, "corner": [TG_SLOTS[n][c] for c in cols],
              "sd": [{"used": [], "placed": 0, "done": False, "idle": 0, "forfeit": False, "mono": False} for _ in cols],
              "last": None, "moves": 0, "deadline": now + TG_TURN_MS}
    t["result"], t["phase"], t["turn"] = None, "playing", cols.index(0)   # 藍色先下
    for s in t["seats"]:
        s["ready"], s["left"] = False, False
    tbl_log(t, f"Blokus Trigon 開始！{n} 人參加，{t['seats'][t['turn']]['name']}（藍）先下")

def tg_advance(t, frm, now):
    g, n = t["g"], len(t["seats"])
    for k in range(1, n + 1):
        j = (frm + k) % n
        sd = g["sd"][j]
        if sd["done"]:
            continue
        if not tg_moves(g, j, True):
            sd["done"] = True
            tbl_log(t, f"{t['seats'][j]['name']} 沒有地方可以放了，之後跳過")
            continue
        t["turn"], g["deadline"] = j, now + TG_TURN_MS
        return
    tg_finish(t)

def tg_finish(t):
    g = t["g"]
    players = [{"name": s["name"], "col": g["col"][k], "rem": tg_rem(g, k), "score": tg_score(g, k), "left": bool(s.get("left")), "forfeit": bool(g["sd"][k]["forfeit"])}
               for k, s in enumerate(t["seats"])]
    best = max(p["score"] for p in players)
    winners = [k for k, p in enumerate(players) if p["score"] == best]
    stay = [(k, s) for k, s in enumerate(t["seats"]) if not s.get("left")]
    active = sum(1 for k, s in enumerate(t["seats"]) if not s.get("left") and not g["sd"][k]["forfeit"])
    xp = [TG_XP if active >= 2 and not g["sd"][k]["forfeit"] else 0 for k, s in stay]
    gs = [gs_mk({**({"w": 1} if k in winners else {}), **({"all": 1} if players[k]["rem"] == 0 else {})}) if active >= 2 and not players[k]["forfeit"] else None for k, s in stay]
    names = "、".join(players[k]["name"] for k in winners)
    text = f"{names} 同分平手（{best} 分）" if len(winners) > 1 else f"{names} 獲勝！（{best} 分）"
    t["seats"] = [s for _k, s in stay]
    t["result"] = {"text": text, "rid": random.getrandbits(32), "xp": xp, "players": players, "winners": winners, "draw": len(winners) > 1, "gs": gs}
    tbl_log(t, text)
    tbl_reset_seats(t)
    t["g"] = g   # 最後的棋盤留著給大家看，到下一局開始才清掉

def tg_place(t, cid, p, cs, now):
    """cs：這塊佔用的格子的絕對座標 [[x, y], …]。"""
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "trigon" or role != "seat" or t["phase"] != "playing" or i != t["turn"] or not g:
        return
    if type(p) is not int or p < 0 or p >= len(TG_PIECES) or p in g["sd"][i]["used"] or type(cs) is not list or len(cs) != len(TG_PIECES[p]):
        return
    cells, idx = [], []
    for c in cs:
        if type(c) is not list or len(c) != 2 or type(c[0]) is not int or type(c[1]) is not int or not (0 <= c[0] < TG_W) or not (0 <= c[1] < TG_ROWS):
            return
        cells.append((c[0], c[1]))
        idx.append(c[1] * TG_W + c[0])
    if tg_key(cells) not in TG_ORI_KEYS[p] or not tg_legal(g, i, idx):
        return
    sd = g["sd"][i]
    for c in idx:
        g["board"][c] = g["col"][i] + 1
    sd["used"].append(p)
    sd["placed"] += 1
    sd["idle"] = 0
    sd["mono"] = p == 0
    g["last"] = {"seat": i, "cells": [[x, y] for x, y in cells]}
    g["moves"] += 1
    tg_advance(t, i, now)

def tg_timeout(t, now):
    g = t.get("g")
    if t["game"] != "trigon" or t["phase"] != "playing" or not g or now < g["deadline"] - 300:
        return
    i = t["turn"]
    sd = g["sd"][i]
    sd["idle"] += 1
    if sd["idle"] >= TG_IDLE_MAX:
        sd["done"], sd["forfeit"] = True, True
        tbl_log(t, f"{t['seats'][i]['name']} 連續超時，視為棄權")
    else:
        tbl_log(t, f"{t['seats'][i]['name']} 超時，跳過這一手")
    tg_advance(t, i, now)

def tg_leave(t, i, now):
    """遊戲進行中有人離開：棋子留在棋盤上、之後跳過；沒人能下就結束。"""
    s, g = t["seats"][i], t["g"]
    if s.get("left"):
        return
    s["left"], s["cid"] = True, None
    g["sd"][i]["done"] = True
    tbl_log(t, f"{s['name']} 離開了")
    if i == t["turn"]:
        tg_advance(t, i, now)
    elif all(d["done"] for d in g["sd"]):
        tg_finish(t)

# ---- 躲彈幕（第五桌 t5；2026-11-08，使用者要求）：1～8 人、每人 3 條命、只能躲不能攻擊，依存活秒數評分 ----
# 彈幕由客戶端用伺服器給的 seed 與開始時間 t0 決定性地各自產生（每個畫面看到的彈幕一樣）；被打到由各客戶端自判並回報 hit（和島主的招式同一原則，信任客戶端），
# 伺服器管命數（被打後 DG_INV_MS 內不重複扣）、淘汰、評分與結束：入座的人全部淘汰、或滿 DG_DUR 秒（客戶端時間到時送 finish，伺服器核對時鐘）就結束；
# 中途離開的人視同在離開那一刻淘汰（照該刻的存活秒數計分），遊戲繼續到場上沒有活人為止。
DG_DUR = 300          # 最長秒數（使用者定，「暫時」；到了強制結束）
DG_LIVES = 3
DG_INV_MS = 1500      # 被打到後的無敵時間（與客戶端一致）
DG_COUNTDOWN_MS = 3000
DG_W, DG_H = 640, 400   # 場地大小（客戶端畫面用；伺服器只用來夾位置）

# 道具（2026-11-12，使用者要求）：分數＝存活秒數×1＋道具分。道具的位置、出現時間、種類由 seed 與編號 n 決定性地算出（客戶端畫面用同一個函式，
# 與 worker 的 dgItem／client 的 dodgeItem 同一套）：伺服器只在收到 pick {n} 時驗證（時間、距離、沒被別人先吃）並結算。
# 金幣 +10 分／愛心 +1 命（滿命改 +5 分）／骷髏 領先的對手 −10 分／蝸牛 其他人減速 5 秒／準星 6 秒內場上多出「只會打到別人」的子彈；單人局只有金幣與愛心
DG_ITEM_LIFE = 9.0          # 道具停留秒數
DG_ITEM_GAP = 4.0           # 平均每幾秒出現一個
DG_ITEM_R = 9               # 道具半徑（撿取距離＝道具半徑＋玩家半徑 5，伺服器放寬到 60 以容許延遲）
DG_COIN, DG_SKULL_PTS, DG_HEART_FULL_PTS = 10, 10, 5
DG_SLOW_SEC, DG_BUL_SEC = 5.0, 6.0

def dg_hash(a, b):
    M = 0xFFFFFFFF
    x = ((((a & M) ^ 0x9e3779b9) * 0x85ebca6b) & M) ^ (((((b & M) + 0x7f4a7c15) & M) * 0xc2b2ae35) & M)
    x &= M
    x ^= x >> 15
    x = (x * 0x2c1b3c6d) & M
    x ^= x >> 12
    x = (x * 0x297a2d39) & M
    x ^= x >> 15
    return x & M

def dg_item(seed, n, players):
    """第 n 個道具：{ts 出現秒數, x, y, kind}。kind：coin／heart／skull／slow／bul。"""
    h = lambda k: dg_hash(seed, n * 8 + k)
    r = h(3) % 100
    if players <= 1:
        kind = "coin" if r < 70 else "heart"
    else:
        kind = "coin" if r < 38 else "heart" if r < 55 else "skull" if r < 70 else "slow" if r < 85 else "bul"
    return {"ts": 3 + DG_ITEM_GAP * n + (h(0) % 2000) / 1000.0, "x": 30 + h(1) % (DG_W - 60), "y": 30 + h(2) % (DG_H - 60), "kind": kind}

def dg_score(s):
    """分數＝存活秒數（取整）＋道具分，最低 0。"""
    return max(0, int(s["died"] if s.get("died") is not None else 0) + s.get("bonus", 0))

def dg_pick(t, cid, n, now, x=None, y=None):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "dodge" or role != "seat" or t["phase"] != "playing" or not g or type(n) is not int or n < 0 or n > 10000:
        return
    s = t["seats"][i]
    if s["out"]:
        return
    e = (now - g["t0"]) / 1000.0
    it = dg_item(g["seed"], n, g["n"])
    if e < it["ts"] - 0.3 or e > it["ts"] + DG_ITEM_LIFE + 0.6 or any(x["n"] == n for x in g["taken"]):
        return
    # 位置驗證：客戶端回報撿到時的座標要在道具旁（半徑 22），且離伺服器最後知道的位置不能太遠（pos 約 8 次／秒，留延遲餘裕 120）
    if type(x) not in (int, float) or type(y) not in (int, float) or (x - it["x"]) ** 2 + (y - it["y"]) ** 2 > 22 * 22:
        return
    if s.get("px") is not None and (s["px"] - x) ** 2 + (s["py"] - y) ** 2 > 120 * 120:
        return
    k = it["kind"]
    g["taken"].append({"n": n, "by": i, "k": k})
    nm = s["name"]
    if k == "coin":
        s["coins"] = s.get("coins", 0) + 1
        s["bonus"] += DG_COIN
        tbl_log(t, f"{nm} 吃到金幣 +{DG_COIN} 分")
    elif k == "heart":
        if s["lives"] < DG_LIVES:
            s["lives"] += 1
            tbl_log(t, f"{nm} 吃到愛心，回復 1 條命")
        else:
            s["bonus"] += DG_HEART_FULL_PTS
            tbl_log(t, f"{nm} 吃到愛心（命已滿）+{DG_HEART_FULL_PTS} 分")
    elif k == "skull":
        others = [x for j, x in enumerate(t["seats"]) if j != i and not x["out"]]
        if others:
            lead = max(others, key=lambda x: int(e) + x["bonus"])
            lead["bonus"] -= DG_SKULL_PTS
            tbl_log(t, f"{nm} 吃到骷髏：領先的 {lead['name']} −{DG_SKULL_PTS} 分")
        else:
            tbl_log(t, f"{nm} 吃到骷髏，但沒有對手")
    elif k == "slow":
        g["fx"].append({"k": "slow", "by": i, "from": round(e, 2), "until": round(e + DG_SLOW_SEC, 2), "n": n})
        tbl_log(t, f"{nm} 吃到蝸牛：其他人減速 {int(DG_SLOW_SEC)} 秒")
    else:
        g["fx"].append({"k": "bul", "by": i, "from": round(e, 2), "until": round(e + DG_BUL_SEC, 2), "n": n})
        tbl_log(t, f"{nm} 吃到準星：{int(DG_BUL_SEC)} 秒內場上多出只會打到別人的子彈")

def dg_xp(sec):
    """存活秒數 → XP：不到 10 秒不給（擋刷分）；之後每 30 秒 +1，起跳 1、上限 10。"""
    return 0 if sec < 10 else min(10, 1 + int(sec // 30))

def dg_elapsed(t, now):
    return max(0.0, min(float(DG_DUR), (now - t["g"]["t0"]) / 1000.0))

def dg_start(t):
    now = int(time.time() * 1000)
    t["g"] = {"seed": random.getrandbits(31), "t0": now + DG_COUNTDOWN_MS, "n": len(t["seats"]), "taken": [], "fx": []}
    t["result"] = None
    t["phase"] = "playing"
    for s in t["seats"]:
        s["lives"], s["out"], s["died"], s["last_hit"], s["left"], s["ready"] = DG_LIVES, False, None, 0, False, False
        s["bonus"], s["px"], s["py"] = 0, None, None
        s["coins"] = 0
    tbl_log(t, f"挑戰開始！{len(t['seats'])} 人參加，每人 {DG_LIVES} 條命")

def dg_out(t, s, now, why):
    s["out"] = True
    s["died"] = round(dg_elapsed(t, now), 1)
    tbl_log(t, f"{s['name']} {why}，存活 {s['died']} 秒")

def dg_finish(t, now):
    for s in t["seats"]:
        if not s["out"]:   # 時間到還活著的：存活到最後
            s["out"] = True
            s["died"] = round(dg_elapsed(t, now), 1)
    ranking = sorted(({"name": s["name"], "uid": s.get("uid"), "sec": s["died"], "bonus": s["bonus"], "score": dg_score(s), "left": bool(s.get("left"))} for s in t["seats"]), key=lambda r: (-r["score"], -r["sec"]))
    stay = [s for s in t["seats"] if not s.get("left")]
    xp = [dg_xp(s["died"]) for s in stay]   # 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
    top = ranking[0] if ranking else None
    text = f"挑戰結束！第一名 {top['name']}，{top['score']} 分" if top else "挑戰結束"
    board_record(t, [(r["name"], r["score"], r.get("uid")) for r in ranking if not r["left"]])
    gs = [gs_mk({}, {"best": max(0, dg_score(s)), "bsec": int(s.get("died") or 0), "coin": s.get("coins", 0)}) for s in stay]   # best＝分數、bsec＝存活秒數、coin＝這局吃到的金幣數（都取最大）
    t["seats"] = stay
    t["result"] = {"text": text, "rid": random.getrandbits(32), "ranking": ranking, "xp": xp, "gs": gs}
    tbl_log(t, text)
    tbl_reset_seats(t)
    t["g"] = None

def dg_check_end(t, now):
    """場上沒有活人，或時間到了：結束。"""
    if t["game"] != "dodge" or t["phase"] != "playing" or not t.get("g"):
        return
    if now >= t["g"]["t0"] + DG_DUR * 1000 or all(s["out"] for s in t["seats"]):
        dg_finish(t, now)

def dg_hit(t, cid, now):
    role, i = tbl_find(t, cid)
    if t["game"] != "dodge" or role != "seat" or t["phase"] != "playing" or not t.get("g"):
        return
    s = t["seats"][i]
    if s["out"] or now < t["g"]["t0"] or now - s["last_hit"] < DG_INV_MS - 400:   # 還沒開始、已出局、無敵時間內（留 400ms 的網路抖動餘裕）
        return
    s["last_hit"] = now
    s["lives"] -= 1
    if s["lives"] <= 0:
        dg_out(t, s, now, "出局")
    dg_check_end(t, now)

def dg_leave(t, i, now):
    """遊戲進行中有人離開：視同淘汰（照這一刻的存活秒數計分），遊戲繼續到場上沒有活人為止（使用者定）。"""
    s = t["seats"][i]
    if not s["out"]:
        dg_out(t, s, now, "離開了")
    else:
        tbl_log(t, f"{s['name']} 離開了")
    s["left"], s["cid"] = True, None
    dg_check_end(t, now)

# ---- 見習驅魔師（第十桌 t10；2026-11-12，使用者要求）：1～4 人合作，玩家在場地正中央，幽靈從四面八方飄向中央，用滑鼠畫出幽靈身上的符號消除它 ----
# 3 波小怪＋1 隻 Boss；沒被消除的幽靈碰到中央就扣某位玩家 1 滴血，全員死亡失敗、打贏 Boss 勝利。幽靈由 seed 決定性地產生（與 worker 的 mgGhosts、client 的
# mageGhosts 同一套，隨機只用 mg_hash，不用 sin/cos，兩邊結果完全一致）；符號辨識在客戶端，伺服器權威管血量、擊殺（先到先得）、Boss 血量與勝負；
# 沒被消除的幽靈扣血由伺服器在收到任何訊息時按時間懶惰結算（mg_tick，客戶端每秒送 sync）。只有單人勝利進排行榜。與 worker 的 mg* 同一套。
MG_HP = 5
MG_WAVE_START, MG_WAVE_LEN, MG_WAVE_GAP = 3.0, 28.0, 4.0           # 第 k 波＝[3+32k, 3+32k+28)
MG_BOSS_START = 3.0 + 3 * (MG_WAVE_LEN + MG_WAVE_GAP)              # Boss 出場時間（99 秒）；Boss 出場後 1.5 秒才能開始打
MG_BOSS_LIMIT = 180.0                                              # Boss 出場後打不贏的上限（秒）
MG_R0, MG_R_HIT = 390.0, 28.0                                      # 幽靈出現半徑（場外）與碰到中央的半徑
MG_GRACE = 0.8                                                     # 幽靈抵達後多久才結算扣血（容許延遲）
MG_N_SYMS = 10                                                     # 符號種類（不分難度、波數，一開始就有全部 10 種；2026-11-13 加了 M）
MG_SYMS = [[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6]]             # 各難度（簡易／中等／困難／超難）每波「一隻幽靈身上的符號個數」；Boss 戰時的小鬼用第 1 波的個數
MG_SYM_PTS = 5                                                     # 計分：每畫對一個符號（小怪身上的、Boss 的都算）+5 分
MG_INTERVAL = [2.6, 2.6, 2.6, 2.6]                                 # 各難度小怪生成間隔（秒，1 人）；2026-11-13 起各難度一樣，難度只靠每隻幽靈的符號數量
MG_SPEED = [38.0, 46.0, 55.0, 66.0]                                # 各難度幽靈速度（px/s）；2026-11-13 使用者要求速度隨難度增加（生成間隔各難度一樣）
MG_WAVE_MULT = [1.0, 0.85, 0.7, 1.8]                               # 各波間隔倍率（第 4 項＝Boss 戰時的小鬼騷擾，比較稀）
MG_BOSS_HP = [12, 18, 26, 38]                                      # 各難度 Boss 血量（1 人），每多 1 人 +60%
MG_MULT = [1.0, 1.5, 2.2, 3.2]                                     # 分數的難度倍率
MG_XP = [4, 6, 8, 10]                                              # 勝利每位入座者的 XP（失敗 1）
MG_DIFF_NAMES = ["簡易", "中等", "困難", "超難"]

def mg_hash(a, b):
    return dg_hash(a, b)

def mg_boss_hp(diff, n):
    return int(math.ceil(MG_BOSS_HP[diff] * (1 + 0.6 * (n - 1)) - 1e-9))

def mg_boss_sym(seed, k, diff):
    """Boss 的第 k 個符號（k＝已被打中的次數）。"""
    return mg_hash(seed, 5000 + k) % MG_N_SYMS

def mg_gen(g, upto):
    """產生 ts <= upto 的幽靈，附加到 g["gh"]。每隻 {i, ts, syms（要依序畫的符號）, arr, tgt, w}；之後可以再接著產生（g["cur"] 是下一隻的出現時間）。
    符號個數愈多的幽靈飄得愈慢、出現間隔愈長（給玩家畫完的時間）。"""
    d, n, seed = g["diff"], g["n"], g["seed"]
    while True:
        t = g["cur"]
        if t < MG_BOSS_START:
            k = int((t - MG_WAVE_START) // (MG_WAVE_LEN + MG_WAVE_GAP))
            if (t - MG_WAVE_START) - k * (MG_WAVE_LEN + MG_WAVE_GAP) >= MG_WAVE_LEN:   # 波與波之間的空檔：跳到下一波開頭
                t = MG_WAVE_START + (k + 1) * (MG_WAVE_LEN + MG_WAVE_GAP)
        if t >= MG_BOSS_START and t < MG_BOSS_START + 2:
            t = MG_BOSS_START + 2.0
        g["cur"] = t
        if t > upto:
            return
        i = len(g["gh"])
        w = 3 if t >= MG_BOSS_START else int((t - MG_WAVE_START) // (MG_WAVE_LEN + MG_WAVE_GAP))
        m = MG_SYMS[d][0] if w == 3 else MG_SYMS[d][w]
        h = lambda j: mg_hash(seed, 10000 + i * 16 + j)
        u = lambda j: h(j) / 4294967296.0
        sp = MG_SPEED[d] * (0.85 + 0.3 * u(2)) * (0.9 if w == 3 else 1.0) / (1 + 0.3 * (m - 1))
        g["gh"].append({"i": i, "ts": t, "syms": [h(8 + j) % MG_N_SYMS for j in range(m)], "arr": t + (MG_R0 - MG_R_HIT) / sp, "tgt": h(3), "w": w})
        g["cur"] = t + MG_INTERVAL[d] * MG_WAVE_MULT[w] / (1 + 0.5 * (n - 1)) * (0.7 + 0.6 * u(4)) * (1 + 0.3 * (m - 1))

def mg_elapsed(t, now):
    return (now - t["g"]["t0"]) / 1000.0

def mg_alive(t):
    return [i for i, s in enumerate(t["seats"]) if not s.get("dead")]

def mg_start(t):
    now = int(time.time() * 1000)
    diff = t.get("diff", 0) if t.get("diff", 0) in (0, 1, 2, 3) else 0
    n = len(t["seats"])
    t["g"] = {"seed": random.getrandbits(31), "t0": now + DG_COUNTDOWN_MS, "diff": diff, "n": n, "cur": MG_WAVE_START, "gh": [],
              "killed": {}, "prog": {}, "last": {}, "rp": {}, "boss": mg_boss_hp(diff, n), "dmg": 0, "hits": 0, "lastBossAt": 0, "credit": [], "kills": 0}
    t["result"] = None
    t["phase"] = "playing"
    for s in t["seats"]:
        s["hp"], s["dead"], s["syms"], s["left"], s["ready"] = MG_HP, False, 0, False, False
    tbl_log(t, f"見習驅魔師（{MG_DIFF_NAMES[diff]}）開始！{n} 人參加，每人 {MG_HP} 滴血")

def mg_finish(t, now, win):
    g = t["g"]
    e = max(0.0, mg_elapsed(t, now))
    hp_left = sum(s["hp"] for s in t["seats"] if not s.get("dead"))
    syms = sum(s.get("syms", 0) for s in t["seats"])
    score = int(1000 * MG_MULT[g["diff"]] + syms * MG_SYM_PTS + hp_left * 50 + max(0.0, 240.0 - e) * 5) if win else 0
    ranking = [{"name": s["name"], "uid": s.get("uid"), "syms": s.get("syms", 0), "hp": max(0, s["hp"]), "dead": bool(s.get("dead")), "left": bool(s.get("left"))} for s in t["seats"]]
    stay = [s for s in t["seats"] if not s.get("left")]
    xp = [MG_XP[g["diff"]] if win else 1 for s in stay]
    solo = g["n"] == 1
    text = f"驅魔師們打倒了 Boss！{MG_DIFF_NAMES[g['diff']]}模式通關，{score} 分" if win else f"驅魔師們全軍覆沒…（{MG_DIFF_NAMES[g['diff']]}模式）"
    if not win and e >= MG_BOSS_START and mg_alive(t):
        text = f"Boss 太強了，撐不住…（{MG_DIFF_NAMES[g['diff']]}模式）"
    if win and solo:
        board_record(t, [(t["seats"][0]["name"], score, t["seats"][0].get("uid"))])
    gs = [gs_mk({"syms": s.get("syms", 0), **({f"c{g['diff']}": 1, **({"solo": 1} if solo else {}), **({"nd": 1} if not s.get("dead") and s["hp"] >= MG_HP else {})} if win else {})}) for s in stay]   # syms＝畫對的符號數；c0～c3＝各難度通關；solo＝單人通關；nd＝通關且自己沒掉血
    t["seats"] = stay
    t["result"] = {"text": text, "rid": random.getrandbits(32), "ranking": ranking, "xp": xp, "win": win, "score": score, "diff": g["diff"], "solo": solo, "syms": syms, "gs": gs}
    tbl_log(t, text)
    tbl_reset_seats(t)
    t["g"] = None

def mg_tick(t, now):
    """依時間結算：抵達中央卻沒被消除的幽靈扣血、全員死亡或 Boss 戰超時就失敗。回傳這次有沒有改變狀態。"""
    if t["game"] != "mage" or t["phase"] != "playing" or not t.get("g"):
        return False
    g = t["g"]
    e = mg_elapsed(t, now)
    if e < 0:
        return False
    changed = False
    mg_gen(g, e + 0.001)
    for gh in g["gh"]:   # 還沒結算過的（killed 的不用扣）
        if str(gh["i"]) in g["rp"]:
            continue
        if gh["arr"] + MG_GRACE > e:
            continue
        g["rp"][str(gh["i"])] = 1
        g["prog"].pop(str(gh["i"]), None)
        if str(gh["i"]) in g["killed"]:
            continue
        al = mg_alive(t)
        if not al:
            continue
        s = t["seats"][al[gh["tgt"] % len(al)]]
        s["hp"] -= 1
        changed = True
        if s["hp"] <= 0:
            s["dead"] = True
            tbl_log(t, f"{s['name']} 倒下了")
    if g["dmg"] >= g["boss"]:   # Boss 倒下優先於全員倒下（打倒的瞬間就算贏）
        mg_finish(t, now, True)
        return True
    if not mg_alive(t):
        mg_finish(t, now, False)
        return True
    if e >= MG_BOSS_START + MG_BOSS_LIMIT:
        mg_finish(t, now, False)
        return True
    return changed

def mg_kill(t, cid, i, p, now):
    """畫對幽靈 i 的第 p 個符號（p＝這隻已完成的符號數）。全部畫完才算消除；同一個符號幾乎同時（700ms 內）畫對的隊友也行（不重複計）。"""
    role, k = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "mage" or role != "seat" or t["phase"] != "playing" or not g or type(i) is not int or i < 0 or type(p) is not int or p < 0:
        return
    s = t["seats"][k]
    if s.get("dead"):
        return
    e = mg_elapsed(t, now)
    mg_gen(g, e + 0.001)
    if i >= len(g["gh"]) or str(i) in g["killed"]:
        return
    gh = g["gh"][i]
    if gh["ts"] > e + 0.3 or e > gh["arr"] + MG_GRACE:
        return
    key = str(i)
    cur = g["prog"].get(key, 0)
    if p == cur:
        g["prog"][key] = cur + 1
        g["last"][key] = {"at": now, "by": [k]}
        s["syms"] += 1   # 每畫對一個符號就算一個（計分用）
    elif p == cur - 1 and key in g["last"] and now - g["last"][key]["at"] <= 700 and k not in g["last"][key]["by"]:
        g["last"][key]["by"].append(k)   # 同一個符號幾乎同時畫對的隊友：接受（不重複前進），符號數也算他一個
        s["syms"] += 1
        return
    else:
        return
    if g["prog"][key] >= len(gh["syms"]):   # 最後一個符號畫完：消除
        g["killed"][key] = k
        g["prog"].pop(key, None)

def mg_boss_hit(t, cid, kk, now):
    role, k = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "mage" or role != "seat" or t["phase"] != "playing" or not g or type(kk) is not int or t["seats"][k].get("dead"):
        return
    e = mg_elapsed(t, now)
    if e < MG_BOSS_START + 1.5 or g["dmg"] >= g["boss"]:
        return
    if kk == g["hits"]:   # 這個符號第一個畫對的人：Boss 換下一個符號
        g["dmg"] += 1
        g["hits"] += 1
        g["lastBossAt"], g["credit"] = now, [k]
    elif kk == g["hits"] - 1 and now - g["lastBossAt"] <= 700 and k not in g["credit"]:   # 同一個符號幾乎同時畫對的隊友：也算一次傷害（合作）
        g["dmg"] += 1
        g["credit"].append(k)
    else:
        return
    t["seats"][k]["syms"] += 1

def mg_leave(t, i, now):
    """遊戲進行中有人離開：視同倒下，遊戲繼續到場上沒有活人為止。"""
    s = t["seats"][i]
    s["dead"], s["left"], s["cid"] = True, True, None
    tbl_log(t, f"{s['name']} 離開了")
    mg_tick(t, now)
    if t["phase"] == "playing" and not mg_alive(t):
        mg_finish(t, now, False)

def mg_set_diff(t, cid, v):
    """桌主（第一位入座的人）在開局前選難度；改了大家要重新準備。"""
    role, i = tbl_find(t, cid)
    if t["game"] != "mage" or role != "seat" or i != 0 or t["phase"] != "lobby" or v not in (0, 1, 2, 3) or type(v) is not int or t.get("diff", 0) == v:
        return
    t["diff"] = v
    for s in t["seats"]:
        s["ready"] = False
    tbl_log(t, f"{t['seats'][0]['name']} 把難度改成{MG_DIFF_NAMES[v]}")

# ---- 英文打字競賽（第七桌 t7；2026-11-10，使用者要求）：1～8 人、倒數 3 秒後 30 秒內比誰打完的英文單字多 ----
# 題目由客戶端用伺服器給的 seed 決定性地產生（大家同一串單字，單字表在 games.json 的 typing.words）；打字與錯字鎖定都在客戶端，
# 每打完一個字回報 word {n}（n＝目前總分，信任客戶端；伺服器只收「比上次多 1～3」的值），伺服器記分、轉發 tsc {i, n} 給同桌其他人。
# 時間到後留 TY_SETTLE_MS 收最後的分數，客戶端再送 finish，伺服器核對時鐘才結算。中途離開不中斷（座位留空殼、照當時分數排名、不給 XP）。
# 與 worker/src/index.js 的 ty* 同一套。
# 中文打字競賽（第九桌 t9，2026-11-11，使用者要求）：規則與英打完全一樣（同一套 ty_*），只是題目換成 games.json 的 zhtyping.words；game id＝zhtyping
def ty_is(t):
    return t["game"] in ("typing", "zhtyping")

def ty_unit(t):
    return "詞" if t["game"] == "zhtyping" else "單字"

# 排行榜（2026-11-12，使用者要求）：英文打字競賽、中文打字競賽、躲彈幕各記前三名（打字＝分數、躲彈幕＝存活秒數）；同一個人只留最好的一筆；
# 這裡記在記憶體（重啟就清掉），Worker 版記在島的 storage；table 畫面帶 board 給客戶端顯示。與 worker 的 boardMerge 同一套
BOARD_GAMES = {"typing", "zhtyping", "dodge", "mage", "arcade", "maze"}   # 俄羅斯方塊／豆豆迷宮：只記單人模式（使用者定）
BOARD_N = 3
BOARDS = {}

def board_record(t, entries):
    """entries：[(名字, 成績)]（沒離開、成績 > 0 的入座者）；合併進前三名。"""
    ts = int(time.time() * 1000)
    best = {}
    for e in BOARDS.get(t["game"], []) + [{"name": n, "uid": uid, "score": sc, "ts": ts} for n, sc, uid in entries if sc > 0]:
        k = ("u", e["uid"]) if e.get("uid") else ("n", e["name"])   # 同一個人只留最好的一筆：登入者用 uid（改名也算同一人），訪客用名字
        o = best.get(k)
        if o is None or e["score"] > o["score"]:
            best[k] = e
    BOARDS[t["game"]] = sorted(best.values(), key=lambda e: (-e["score"], e["ts"]))[:BOARD_N]

def board_rename(uid, name):
    """暱稱改了：排行榜裡有這個 uid 的項目改成新的顯示名稱。"""
    for lst in BOARDS.values():
        for e in lst:
            if e.get("uid") == uid:
                e["name"] = name

TY_DUR = 30              # 比賽秒數（使用者定）
TY_COUNTDOWN_MS = 3000   # 開局倒數（使用者定）
TY_SETTLE_MS = 1000      # 時間到後再收分數的寬限（最後一個字的回報可能晚到）
TY_STEP_MAX = 3          # 一次回報最多比上次多幾分（漏掉的回報由下一次補上）
TY_XP, TY_XP_MIN = 3, 5  # 正常打完、至少 TY_XP_MIN 個字的入座者 +TY_XP（助手先訂的數值）

def ty_start(t):
    t["g"] = {"seed": random.getrandbits(31), "t0": int(time.time() * 1000) + TY_COUNTDOWN_MS}
    t["result"] = None
    t["phase"] = "playing"
    for s in t["seats"]:
        s["score"], s["out"], s["left"], s["ready"] = 0, False, False, False
    tbl_log(t, f"比賽開始！{len(t['seats'])} 人參加，限時 {TY_DUR} 秒")

def ty_finish(t):
    ranking = sorted(({"name": s["name"], "uid": s.get("uid"), "score": s.get("score", 0), "left": bool(s.get("left"))} for s in t["seats"]), key=lambda r: -r["score"])
    stay = [s for s in t["seats"] if not s.get("left")]
    xp = [TY_XP if s.get("score", 0) >= TY_XP_MIN else 0 for s in stay]   # 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
    top = ranking[0] if ranking else None
    text = f"比賽結束！第一名 {top['name']}，打了 {top['score']} 個{ty_unit(t)}" if top else "比賽結束"
    board_record(t, [(r["name"], r["score"], r.get("uid")) for r in ranking if not r["left"]])
    gs = [gs_mk({}, {"best": s.get("score", 0)}) for s in stay]   # best＝單局最高分（取最大）
    t["seats"] = stay
    t["result"] = {"text": text, "rid": random.getrandbits(32), "ranking": ranking, "xp": xp, "gs": gs}
    tbl_log(t, text)
    tbl_reset_seats(t)

def ty_check_end(t, now):
    """時間到（含寬限），或入座的人全部離開：結算。"""
    if not ty_is(t) or t["phase"] != "playing" or not t.get("g"):
        return
    if now >= t["g"]["t0"] + TY_DUR * 1000 + TY_SETTLE_MS or all(s.get("left") for s in t["seats"]):
        ty_finish(t)

def ty_word(t, cid, n, now):
    """回報分數：有更新回 True（呼叫端轉發給同桌）。"""
    role, i = tbl_find(t, cid)
    if not ty_is(t) or role != "seat" or t["phase"] != "playing" or not t.get("g"):
        return False
    if now < t["g"]["t0"] or now > t["g"]["t0"] + TY_DUR * 1000 + TY_SETTLE_MS:
        return False
    s = t["seats"][i]
    cur = s.get("score", 0)
    if type(n) is not int or n <= cur or n > cur + TY_STEP_MAX:
        return False
    s["score"] = n
    return True

def ty_leave(t, i, now):
    s = t["seats"][i]
    tbl_log(t, f"{s['name']} 離開了（{s.get('score', 0)} 個{ty_unit(t)}）")
    s["left"], s["cid"] = True, None
    ty_check_end(t, now)

# ---- 秘藥情報戰（第八桌 t8；2026-11-10，使用者要求，原創規則）：3～8 人、隱藏身分（沙都／水都／第三方咒術師）、蓋著投遞密函 ----
# 規則說明見 worker/src/index.js 的 it* 與 notes「和平島與遊戲桌」；兩邊同一套，改規則一起改。
IT_TURN_MS = 30000   # 投遞回合限時
IT_HOLD_MS = 15000   # 收／轉限時
IT_PEND_MS = 5000    # 行動（含識破）打出後的識破時間（使用者定 5 秒；識破本身也能被識破，每次重新計時）
IT_WIN, IT_DEATH = 3, 3
IT_XP = 6            # 正常結束：每位入座者 +6（輸贏一樣；助手先訂的數值）
IT_HAND0 = 4         # 開局手牌
# 加時（2026-11-11，使用者要求；只有限時模式）：倒數中任何活著的入座玩家可以按「加時」，這段倒數變成「該段上限秒數 ×5」（從按下時起算），
# 同一段倒數最多 2 個人加時（後按的人一樣重設成上限 ×5），所有加時的人都按「跳過」才縮回剩 3 秒（原本剩的比 3 秒短就不變）；每人每局 3 次。
# 「一段倒數」＝識破時間（每張出的牌／識破各自一段）、投遞回合、每次有人拿到情報的收／轉；換下一段就重新算。與 worker 的 itExtend／itSkip 同一套
IT_EXT_MUL, IT_EXT_MAX, IT_EXT_PER, IT_EXT_SKIP_MS = 5, 2, 3, 3000
IT_MSGS = {"isend", "itake", "ifwd", "iact", "timeout", "imode", "iok", "iext", "iskip", "ians", "ichars", "ipick", "iskill", "iprompt"}
IT_ACT = {"P": "截閱", "S": "調包", "F": "鎖定", "X": "焚信", "H": "搜身", "W": "洗白", "C": "識破", "I": "攔截", "T": "轉移", "B": "阻擋", "N": "無人倖免", "V": "查驗", "D": "補給", "R": "竊取"}
IT_KIND = {"seal": "密函", "pub": "公開情報", "direct": "直達情報"}   # 投遞方式（由卡面決定，不是玩家選）：蓋著照座位傳／翻開照座位傳／直接指定一人（對方必須收下）
IT_KIND_CODE = {"s": "seal", "p": "pub", "d": "direct"}
IT_KIND_CYCLE = "sspsd"   # 牌組依序循環分配投遞方式：密函 60%、公開 20%、直達 20%
IT_CNAME = {"Y": "黃", "B": "藍", "K": "黑"}   # 2026-11-11 使用者要求移除灰（廢紙）
IT_ROLE = {"sand": "沙都", "water": "水都", "mage": "咒術師"}
# 牌組（現在 77 張，2026-11-13 起沒有黃藍雙色牌）：印記 → 各行動的張數（雙色牌同時算兩種顏色；沒有灰）。2026-11-11 使用者要求重配：黃藍雙色減少、黃黑／藍黑增加；
# 焚信 −4、洗白 +2、搜身 −2、攔截 +2、阻擋 +2，新增補給 D 4 張、竊取 R 3 張（顏色由助手分配）。含黃 35、含藍 35、含黑 33（與 worker 的 IT_DECK 一致）
# （2026-11-11 再改：洗白 +2，加在純黃、純藍各 1 張，共 77 張；含黃 36、含藍 36、含黑 33；押送改名鎖定）
IT_DECK = {"Y": "P2S2F2X1H1W2C3I1T1B1N1V1D1", "B": "P2S2F2X1H1W2C3I1T1B1N1V1D1", "K": "P1S1F1H1W1C1I1B1V1D1R1", "YK": "P2S2F2H1C2I2T1B1R1", "BK": "P1S1F2W1C2I1T1B2R1V1D1"}   # 2026-11-13 使用者要求：取消黃藍雙色牌，那 6 張平均分給黃黑（加 P／S／I）與藍黑（加 B／V／D）各 3 張，各行動總張數不變；現在含黃 33、含藍 33、含黑 39
IT_PICK_MS = 30000   # 選角時限（限時模式；逾時沒選的自動選第一張；不限時模式等大家選完）
# 角色卡（2026-11-11 使用者提供規格，完整文字見 docs/intel-characters.md）：桌主在開局前開「角色卡」才會用。每人開局拿 1 張身分＋2 張角色、選 1 張。
# type：public 選完就翻開／hidden 選完仍覆蓋（只有本人與觀戰者看得到）。第 0 階段只做「選角＋咒術師身分的勝利條件＋宣告勝利結算」，技能第 1 階段起才實作
IT_CHARS = {
    "poisoner": ("毒藥師", "public"), "healer": ("解藥師", "hidden"), "doubleagent": ("雙面間諜", "public"), "cautious": ("謹慎者", "public"),
    "judge": ("審判者", "public"), "fisher": ("漁翁", "hidden"), "desperate": ("絕望者", "public"), "harmonizer": ("調和者", "public"),
    "killer": ("殺手", "public"), "collector": ("收藏家", "public"), "fencesitter": ("牆頭草", "public"), "usurper": ("篡奪者", "public"),
    "broker": ("情報商", "public"), "assassin": ("暗殺者", "public"), "helper": ("助人者", "public"), "sniper": ("狙擊手", "public"),
    "outsider": ("局外人", "public"), "blackcollector": ("咒函蒐集者", "public"),
}
IT_MAGES = {3: 1, 4: 0, 5: 1, 6: 2, 7: 1, 8: 2}   # 人數 → 咒術師人數（使用者定：4 人局 2 對 2）；其餘沙都、水都平分

def it_deck():
    d = []
    for col, spec in IT_DECK.items():
        for act, n in re.findall(r"([A-Z])(\d+)", spec):
            d += [f"{col}.{act}"] * int(n)
    return [f"{c}.{IT_KIND_CYCLE[k % len(IT_KIND_CYCLE)]}" for k, c in enumerate(d)]   # 牌＝「印記.行動.投遞方式」（例 YB.F.p）；投遞方式由卡面決定

def it_cols(c):
    return c.split(".")[0]

def it_kind_of(c):
    p = c.split(".")
    return IT_KIND_CODE.get(p[2] if len(p) > 2 else "", "seal")

def it_act(c):
    return c.split(".")[1]

def it_count(intel, col):
    return sum(1 for c in intel if col in it_cols(c))

def it_label(c):
    return "".join(IT_CNAME[x] for x in it_cols(c)) + "·" + IT_ACT[it_act(c)]

def it_ok(t, i):
    return type(i) is int and 0 <= i < len(t["seats"]) and not t["seats"][i].get("out") and not t["seats"][i].get("left")

def it_alive(t):
    return [i for i in range(len(t["seats"])) if it_ok(t, i)]

def it_next(t, i):
    n = len(t["seats"])
    for k in range(1, n + 1):
        j = (i + k) % n
        if it_ok(t, j):
            return j
    return -1

def it_next_untouched(t, i, seen):
    """照座位順序，從 i 往後第一個還沒碰過這封情報（seen）的活人；沒有＝-1。"""
    n = len(t["seats"])
    for k in range(1, n):
        j = (i + k) % n
        if it_ok(t, j) and j not in seen:
            return j
    return -1

def it_fwd_target(t, L):
    """拿著情報的人能轉給誰（-1＝只能收下）：蓋著／公開＝座位順序的下一個沒碰過的人；直達＝拿著的人（目標本人或攔截者）可以不收、退回給發信者，發信者必須收下。"""
    if it_locked(t["g"], L["at"]):   # 被鎖定的人：情報到他手上就只能收下（不能傳走、不能退回）
        return -1
    nx = -1 if L["kind"] == "direct" else it_next_untouched(t, L["at"], L["seen"])   # 直達不照座位傳，不收就直接退回發信者
    if nx >= 0:
        return nx
    return L["from"] if L["at"] != L["from"] and it_ok(t, L["from"]) else -1   # 大家都不收：退回給發信者，發信者必須收下

def it_dl(g, now, ms):
    g["ext"] = None   # 開始新的一段倒數：清掉上一段的加時
    return 0 if g["untimed"] else now + ms   # 不限時模式：期限＝0（沒有倒數）

def it_top(t):
    """牌堆頂一張（牌堆空了就把棄牌堆洗回去）；都沒有＝None。"""
    g = t["g"]
    if not g["deck"] and g["discard"]:
        g["deck"] = g["discard"]
        g["discard"] = []
        random.shuffle(g["deck"])
        tbl_log(t, "牌堆抽完了，把丟出的密函洗回牌堆")
    return g["deck"].pop() if g["deck"] else None

def it_draw(t, i, n):
    hand = t["seats"][i]["hand"]
    for _ in range(n):
        c = it_top(t)
        if c is None:
            break
        hand.append(c)

def it_blocked(g, i):
    """阻擋：本回不能「收下」情報的人（g["blocked"]，換回合就清空）。"""
    return i in g.get("blocked", [])

def it_locked(g, i):
    """鎖定（F，原押送；2026-11-11 使用者改）：輪到的人在自己的回合（投遞前或傳遞中）指定一人，本回情報到他手上就必須收下（g["locked"]，換回合清空）；
    鎖定的人沒有可轉的對象（it_fwd_target＝-1），所以阻擋對他不生效（鎖定優先於阻擋），也不能用轉移把情報丟給別人。"""
    return i in (g.get("locked") or [])

def it_has_k(c):
    return "K" in it_cols(c)

def it_black(intel):
    """咒函＝含黑的情報。"""
    return sum(1 for c in intel if it_has_k(c))

def it_pure_black(c):
    return it_cols(c) == "K"

def it_hide_black(t, i):
    """搜身／竊取能選到的手牌：咒函蒐集者「藏鋒」（角色卡已翻開）不會被選到純黑牌。"""
    h = t["seats"][i]["hand"]
    return [c for c in h if not it_pure_black(c)] if t["g"].get("chars") and it_skill_ready(t, i, "blackcollector") else list(h)

def it_kill(t, i, cause=-1):
    """因咒函出局（死亡＝出局）：記錄出局者、「親手殺掉」的人（killer）、第幾位出局、他出局時是不是手牌最多（或之一）的人（狙擊手用）。"""
    g, s = t["g"], t["seats"][i]
    alive = it_alive(t)
    most = max(len(t["seats"][j]["hand"]) for j in alive)
    g["deaths"].append({"seat": i, "killer": cause if cause is not None and cause >= 0 and cause != i else -1, "order": len(g["deaths"]), "maxHand": len(s["hand"]) == most})
    s["out"] = True
    if g.get("chars") and s.get("faceUp") and not s.get("left"):   # 出局時觸發、要做決定的技能：遺言（絕望者，一局一次）、殉道（助人者）
        if s.get("char") == "desperate" and not s.get("onceUsed"):
            g.setdefault("dieQ", []).append({"kind": "will", "seat": i})
        if s.get("char") == "helper":
            g.setdefault("dieQ", []).append({"kind": "martyr", "seat": i})
    if g.get("chars"):   # 漁翁「得利」：有人出局時，可在另一位玩家面前放最多 2 張咒函
        for k in range(len(t["seats"])):
            if k != i and it_skill_ready(t, k, "fisher"):
                g.setdefault("dieQ", []).append({"kind": "profit", "seat": k, "victim": i})
    if g.get("chars") and any(k != i and it_skill_ready(t, k, "collector") for k in range(len(t["seats"]))):
        g["lootQ"].append(i)   # 收藏家可以搜刮：死者的手牌先留著，等 it_loot_run 處理
    else:
        g["discard"] += s["hand"]
        s["hand"] = []
    tbl_log(t, f"{s['name']} 收到 {IT_DEATH} 封咒函，暴露出局！身分是{IT_ROLE[s['role']]}")

def it_char_win(t, i):
    """咒術師身分的角色卡勝利條件（自己達成就宣告）。牆頭草／篡奪者／助人者／局外人是「別人宣告時」才生效，見 it_declare。"""
    g, s = t["g"], t["seats"][i]
    cid = s.get("char")
    if not cid:
        return False
    intel, alive = s["intel"], not s.get("out") and not s.get("left")
    cnt = lambda col: it_count(intel, col)
    died_role = lambda role: any(t["seats"][d["seat"]]["role"] == role for d in g["deaths"])
    def team_out(role):
        m = [x for x in t["seats"] if x["role"] == role]
        return bool(m) and all(x.get("out") for x in m)
    if cid == "poisoner": return alive and cnt("Y") >= 3
    if cid == "healer": return alive and cnt("B") >= 3
    if cid == "doubleagent": return alive and sum(1 for c in intel if len(it_cols(c)) == 2) >= 3
    if cid == "cautious": return alive and len(intel) >= 4 and it_black(intel) == 0
    if cid in ("judge", "fisher"): return alive and died_role("sand") and died_role("water")
    if cid == "desperate": return (len(g["deaths"]) > 0 and g["deaths"][0]["seat"] == i) or team_out("sand") or team_out("water")
    if cid == "harmonizer": return alive and cnt("Y") >= 2 and cnt("B") >= 2 and cnt("K") >= 2
    if cid == "killer": return any(d["killer"] == i for d in g["deaths"][1:])
    if cid == "collector": return alive and len(intel) >= 6
    if cid == "broker": return alive and len(s["hand"]) >= 10
    if cid == "assassin": return alive and any(d["killer"] == i for d in g["deaths"]) and it_black(intel) == 0
    if cid == "sniper": return any(d["killer"] == i and d["maxHand"] for d in g["deaths"])
    if cid == "blackcollector": return alive and sum(1 for c in s["hand"] if it_pure_black(c)) >= 5
    return False

def it_char_mages(t):
    return [s for i, s in enumerate(t["seats"]) if s["role"] == "mage" and not s.get("left") and s.get("char") and it_char_win(t, i)]

def it_char_check(t, frm=0):
    """檢查所有咒術師身分的角色卡勝利條件。咒術師各自計算勝利：同一瞬間有多位達成就一起獲勝（除非像篡奪者那樣讓別人落敗，見 it_declare）。回傳 True＝遊戲結束。"""
    g = t.get("g")
    if not g or not g.get("chars"):
        return False
    ok = it_char_mages(t)
    if not ok:
        return False
    n = len(t["seats"])
    ok.sort(key=lambda s: (t["seats"].index(s) - frm) % n)
    first = t["seats"].index(ok[0])
    if len(ok) == 1:
        text = f"{ok[0]['name']} 是咒術師，達成了【{IT_CHARS[ok[0]['char']][0]}】的勝利條件！"
    else:
        text = "、".join(f"{s['name']}【{IT_CHARS[s['char']][0]}】" for s in ok) + " 同時達成各自的勝利條件，一起獲勝！"
    return it_declare(t, first, ok, text)

def it_declare(t, i, winners, text):
    """宣告勝利（結算勝利的瞬間）：角色卡模式下先看篡奪者（場上無人出局時，別人宣告的瞬間奪走勝利、原宣告者落敗），再加上「一起獲勝」的咒術師身分角色卡
    （局外人：活著且情報區 ≤1；牆頭草：沙都或水都獲勝時活著且情報區有 2 張以上咒函；助人者：已出局且曾洗白獲勝者的咒函）。沒開角色卡就直接結束。"""
    g = t["g"]
    if not g.get("chars"):
        return it_finish(t, text, winners, True)
    n = len(t["seats"])
    first = t["seats"][i]
    for s in it_char_mages(t):   # 同一瞬間也達成自己條件的咒術師一起獲勝（各自計算、共同勝利）
        if not any(s is w for w in winners):
            winners = list(winners) + [s]
    if not g["deaths"]:
        for k in range(1, n):
            j = (i + k) % n
            u = t["seats"][j]
            if u["role"] == "mage" and u.get("char") == "usurper" and not u.get("out") and not u.get("left"):
                winners, i = [u], j
                text = f"{u['name']} 是咒術師【篡奪者】，在 {first['name']} 宣告勝利的瞬間奪走了勝利！"
                break
    decl = t["seats"][i]
    win = list(winners)
    joined = []
    for s in t["seats"]:
        if s["role"] != "mage" or s.get("left") or any(s is w for w in win) or not s.get("char"):
            continue
        alive = not s.get("out")
        ok = ((s["char"] == "outsider" and alive and len(s["intel"]) <= 1)
              or (s["char"] == "fencesitter" and alive and decl["role"] in ("sand", "water") and it_black(s["intel"]) >= 2)
              or (s["char"] == "helper" and not alive and any(t["seats"].index(w) in s.get("washedFor", []) for w in win)))
        if ok:
            win.append(s)
            joined.append(f"{s['name']}【{IT_CHARS[s['char']][0]}】")
    fin = text + (f"　{'、'.join(joined)} 一起獲勝" if joined else "")
    hz = next((w for w in win if w.get("char") == "harmonizer" and w.get("faceUp") and not w.get("left")), None)   # 調和者「救助」：獲勝時可以指定一位玩家一同勝利（先暫停問他，回答完才結束）
    if hz and any(not any(x is w for w in win) and not x.get("left") for x in t["seats"]):
        it_prompt(t, int(time.time() * 1000), {"kind": "rescue", "seat": t["seats"].index(hz), "win": [t["seats"].index(w) for w in win], "text": fin, "cont": None})
        return True
    return it_finish(t, fin, win, True)

def it_pick_done(t, now):
    """選角：每人 2 張選 1 張，其餘棄掉；全員選完（或逾時自動選第一張）後，公開型的翻開，開始第一個回合。"""
    g = t["g"]
    for s in t["seats"]:
        if not s.get("left") and not s.get("char"):
            s["char"] = s["choices"][0]
    for s in t["seats"]:
        if not s.get("char"):
            continue
        s["choices"] = None
        s["faceUp"] = IT_CHARS[s["char"]][1] == "public"
        if s["faceUp"]:
            tbl_log(t, f"{s['name']} 的角色卡：【{IT_CHARS[s['char']][0]}】")
    tbl_log(t, "選角完成，隱藏型的角色卡維持覆蓋")
    it_begin_turn(t, g["first"], now)

def it_pick_check(t, now):
    g = t.get("g")
    if not g or g["step"] != "pick":
        return
    if all(s.get("left") or s.get("char") for s in t["seats"]):
        it_pick_done(t, now)

def it_lock_apply(t, by, tgt, now):
    """鎖定生效（鎖定牌、殺手的標記目標／死亡預告、漁翁的灑網）：他正拿著情報就立刻收下；還沒拿到就標記，本回情報到他手上時只能收下。"""
    g = t["g"]
    if not it_locked(g, tgt):
        g.setdefault("locked", []).append(tgt)
    L = g["letter"]
    if L and g["step"] == "pass" and L["at"] == tgt:
        tbl_log(t, f"{t['seats'][tgt]['name']} 被鎖定，必須收下情報")
        L["cause"] = by
        it_receive(t, now)
    else:
        tbl_log(t, f"{t['seats'][by]['name']} 鎖定了 {t['seats'][tgt]['name']}：本回情報到他手上就必須收下")

def it_cold_eye(t, i):
    """局外人「冷眼旁觀」：情報區 ≤1 張時（角色卡已翻開），不能被搜身、竊取、查驗指定。"""
    return bool(t["g"].get("chars")) and it_skill_ready(t, i, "outsider") and len(t["seats"][i]["intel"]) <= 1

def it_immune_end(t):
    """篡奪者「死裡逃生」（一局一次）：用的那個回合收到咒函不會出局，回合結束時洗白自己該回合收到的咒函。"""
    g = t["g"]
    for s in t["seats"]:
        if not s.get("immuneTurn") or s["immuneTurn"] != g.get("turnNo"):
            continue
        for c in s.get("immuneCards", []):
            if c in s["intel"]:
                s["intel"].remove(c)
                g["discard"].append(c)
        if s.get("immuneCards"):
            tbl_log(t, f"{s['name']}【篡奪者】死裡逃生：回合結束，洗白了這回合收到的 {len(s['immuneCards'])} 封咒函")
        s["immuneTurn"], s["immuneCards"] = 0, []

def it_flip(t, i):
    """翻開角色卡（隱藏型用「公開角色牌」的技能時）。"""
    s = t["seats"][i]
    if s.get("faceUp"):
        return
    s["faceUp"] = True
    tbl_log(t, f"{s['name']} 翻開了角色卡：【{IT_CHARS[s['char']][0]}】")

def it_can_take(t, L, i):
    """沒有可轉的人時（只能收下）阻擋不生效，避免卡死；押送優先於阻擋（押送直接走 it_receive）。"""
    return not it_blocked(t["g"], i) or it_fwd_target(t, L) < 0

def it_start(t):
    n = len(t["seats"])
    m = IT_MAGES.get(n, 1)
    half = (n - m) // 2
    roles = ["sand"] * half + ["water"] * half + ["mage"] * m
    random.shuffle(roles)
    deck = it_deck()
    random.shuffle(deck)
    for k, s in enumerate(t["seats"]):
        s["hand"] = [deck.pop() for _ in range(IT_HAND0)]
        s["intel"], s["role"], s["out"], s["left"], s["ready"], s["note"], s["extLeft"] = [], roles[k], False, False, False, None, IT_EXT_PER
        s["char"], s["choices"], s["faceUp"], s["washedFor"], s["onceUsed"] = None, None, False, [], False
    t["g"] = {"deck": deck, "discard": [], "step": "turn", "letter": None, "pend": None, "arrive": None, "blocked": [], "deadline": 0, "untimed": bool(t.get("untimed")),
              "chars": bool(t.get("chars")), "deaths": [], "lootQ": [], "prompt": None, "first": random.randrange(n)}
    t["result"] = None
    t["phase"] = "playing"
    tbl_log(t, f"牌局開始！沙都 {half} 人、水都 {half} 人" + (f"、咒術師 {m} 人" if m else "") + f"，每人 {IT_HAND0} 張" + ("（不限時）" if t.get("untimed") else "") + ("（角色卡）" if t.get("chars") else ""))
    if t.get("chars"):   # 角色卡：每人 2 張不重複的角色卡，先選角再開始
        ids = list(IT_CHARS)
        random.shuffle(ids)
        for k, s in enumerate(t["seats"]):
            s["choices"] = [ids[2 * k], ids[2 * k + 1]]
        t["g"]["step"] = "pick"
        t["g"]["deadline"] = it_dl(t["g"], int(time.time() * 1000), IT_PICK_MS)
        tbl_log(t, "請從兩張角色卡中選一張")
        return
    it_begin_turn(t, t["g"]["first"], int(time.time() * 1000))

def it_clear_stolen(t):
    """被竊取的提示：到下一階段（投遞出情報、換下一位）就清掉。"""
    for s in t["seats"]:
        s["stolen"] = None

def it_begin_turn(t, i, now):
    """輪到座位 i：抽 2 張；手上沒牌（牌堆也空）就跳過，所有人都沒牌就平手。"""
    g = t["g"]
    for _ in range(len(t["seats"])):
        if i < 0:
            break
        it_immune_end(t)   # 上一個回合結束：死裡逃生的洗白
        t["turn"] = i
        g["step"], g["letter"], g["pend"], g["arrive"], g["blocked"], g["deadline"] = "turn", None, None, None, [], it_dl(g, now, IT_TURN_MS)
        g["locked"] = []
        g["ask"] = None
        it_clear_stolen(t)
        g["turnNo"] = g.get("turnNo", 0) + 1   # 第幾個回合（狙擊手「瞄準」每回合一次用）
        t["seats"][i]["note"] = None   # 上一輪偷看到的東西：輪到自己時清掉
        if g.get("chars") and it_draw_choice(t, i, now):   # 抽牌階段可以改做別的（暗計、採集）：先暫停問他，回答後走 it_turn_resume
            return
        if it_turn_draw(t, i, True):
            return
        tbl_log(t, f"{t['seats'][i]['name']} 沒有牌可以投遞，跳過")
        i = it_next(t, i)
    it_finish(t, "沒有人有牌可以投遞了，平手", [], True)

def it_turn_draw(t, i, draw):
    """抽牌階段：draw＝照常抽牌（2 張；囤貨、背水一戰多抽）。回傳 True＝回合繼續（有牌可以投遞，或遊戲已經結束）。"""
    g, s = t["g"], t["seats"][i]
    if draw:
        n = 2
        if g.get("chars") and it_skill_ready(t, i, "broker") and len(s["hand"]) < 5:   # 情報商「囤貨」：手牌少於 5 張時多抽 1 張
            n += 1
        if g.get("chars") and it_skill_ready(t, i, "desperate") and it_black(s["intel"]) > 0:
            n += 1
            tbl_log(t, f"{s['name']}【絕望者】背水一戰：情報區有咒函，多抽 1 張")
        it_draw(t, i, n)
    if g.get("chars") and it_char_check(t, i):   # 手牌累積型的勝利條件（情報商、咒函蒐集者）
        return True
    return bool(s["hand"])

def it_turn_resume(t, now, i, alt):
    """抽牌階段的選擇回答完：重新給完整的投遞時間；沒牌可以投遞就換下一位。"""
    g = t.get("g")
    if not g:
        return
    g["deadline"] = it_dl(g, now, IT_TURN_MS)
    if it_turn_draw(t, i, not alt):
        return
    tbl_log(t, f"{t['seats'][i]['name']} 沒有牌可以投遞，跳過")
    it_end_letter(t, now)

def it_draw_choice(t, i, now):
    """抽牌階段可以改做別的技能：暗殺者「暗計」（場上有咒函時）、咒函蒐集者「採集」。開了暫停就回 True。"""
    if it_skill_ready(t, i, "assassin") and any(it_ok(t, k) and it_black(x["intel"]) > 0 for k, x in enumerate(t["seats"])):
        it_prompt(t, now, {"kind": "scheme", "seat": i, "cont": {"kind": "draw", "seat": i, "alt": False}})
        return True
    if it_skill_ready(t, i, "blackcollector"):
        it_prompt(t, now, {"kind": "gather", "seat": i, "cont": {"kind": "draw", "seat": i, "alt": False}})
        return True
    return False

def it_finish(t, text, winners, xp):
    reveal = [{"name": s["name"], "role": s.get("role"), "char": s.get("char"), "intel": list(s.get("intel") or []), "win": any(s is w for w in winners),
               "left": bool(s.get("left")), "out": bool(s.get("out"))} for s in t["seats"]]
    stay = [s for s in t["seats"] if not s.get("left")]
    camp = {"sand": {"ws": 1}, "water": {"wb": 1}, "mage": {"wm": 1}}
    gs = [gs_mk({"w": 1, **camp.get(s.get("role"), {})} if any(s is w for w in winners) else {}) for s in stay] if xp else None   # ws／wb／wm＝以沙都／水都／咒術師獲勝；有人中途離開（xp＝False）的局不記
    t["result"] = {"text": text, "rid": random.getrandbits(32), "xp": [IT_XP if xp else 0 for _ in stay], "reveal": reveal, "gs": gs}
    tbl_log(t, text)
    t["seats"] = stay
    tbl_reset_seats(t)
    return True

def it_check_faction(t, by_leave):
    """場上只剩一個陣營（或沒人）：結束。by_leave＝因為有人離開才結束（不給 XP）。"""
    alive = it_alive(t)
    if not alive:
        return it_finish(t, "所有人都出局了，平手", [], not by_leave)
    roles = {t["seats"][i]["role"] for i in alive}
    if len(roles) > 1:
        return False
    r = roles.pop()
    if r == "mage":   # 咒術師各自計算勝利（使用者 2026-11-11）：場上只剩咒術師不算陣營獲勝，繼續玩到有人達成自己的條件（或沒牌平手）；只剩 1 個人時沒人能傳情報，最後的倖存者獲勝
        if len(alive) > 1:
            return False
        s = t["seats"][alive[0]]
        return it_finish(t, f"{s['name']} 是最後的倖存者，咒術師獲勝！", [s], not by_leave)
    winners = [s for s in t["seats"] if s["role"] == r]
    return it_finish(t, f"場上只剩{IT_ROLE[r]}，{IT_ROLE[r]}陣營獲勝！", winners, not by_leave)

def it_check_intel(t, i, cause=-1):
    """座位 i 的情報區變多了：先看有沒有人獲勝，再看有沒有人出局。cause＝「親手」使他獲得這封情報的人（傳遞者、轉移者、鎖定者、無人倖免的使用者），殺手／暗殺者／狙擊手用。"""
    s = t["seats"][i]
    chars = bool(t["g"].get("chars"))
    if not chars and s["role"] == "mage" and it_count(s["intel"], "K") >= IT_WIN:
        return it_finish(t, f"{s['name']} 是咒術師！集滿 {IT_WIN} 封咒函，獲勝！", [s], True)
    if s["role"] == "sand" and it_count(s["intel"], "Y") >= IT_WIN:
        return it_declare(t, i, [x for x in t["seats"] if x["role"] == "sand"], f"{s['name']} 集滿 {IT_WIN} 封黃色密函，沙都陣營獲勝！")
    if s["role"] == "water" and it_count(s["intel"], "B") >= IT_WIN:
        return it_declare(t, i, [x for x in t["seats"] if x["role"] == "water"], f"{s['name']} 集滿 {IT_WIN} 封藍色密函，水都陣營獲勝！")
    if (chars or s["role"] != "mage") and it_count(s["intel"], "K") >= IT_DEATH and not s.get("out"):
        if chars and s.get("immuneTurn") and s["immuneTurn"] == t["g"].get("turnNo"):
            tbl_log(t, f"{s['name']}【篡奪者】死裡逃生：這回合收到咒函不會出局")
            return it_char_check(t, i)
        it_kill(t, i, cause)
        if it_char_check(t, i):   # 先結算勝利（含絕望者「第一個死亡」）再看場上陣營
            return True
        return it_check_faction(t, False)
    return it_char_check(t, i) if chars else False

def it_end_letter(t, now):
    nx = it_next(t, t["turn"])
    if nx < 0:
        it_check_faction(t, False)
        return
    it_begin_turn(t, nx, now)

# ---- 角色技能（第 1 階段，2026-11-11）：謹慎者、雙面間諜、牆頭草、收藏家、情報商（規格見 docs/intel-characters.md）----
# 角色技能預設不能被識破（只有「把 XX 卡當成 OO 卡使用」的偷天換日走行動牌、可被識破）。技能需要角色卡已翻開（faceUp）；公開型選完就翻開。
# 自動觸發（抽牌）直接生效；需要玩家決定的觸發用 g["prompt"] 暫停遊戲（it_prompt／it_prompt_done），限時模式 15 秒逾時當作不用，不限時等玩家。
def it_char_is(t, i, cid):
    g = t.get("g")
    return bool(g and g.get("chars")) and t["seats"][i].get("char") == cid and not t["seats"][i].get("left")

def it_skill_ready(t, i, cid):
    s = t["seats"][i]
    return it_char_is(t, i, cid) and not s.get("out") and bool(s.get("faceUp"))

def it_prompt(t, now, p):
    g = t["g"]
    p["until"] = 0 if g["untimed"] else now + IT_HOLD_MS
    g["prompt"] = p

def it_cont(t, now, c):
    """暫停結束後接著做原本的流程。"""
    if not t.get("g") or not c:
        return
    if c["kind"] == "recv":
        it_recv(t, now, c)
    elif c["kind"] == "recvEnd":
        it_recv_end(t, now, c["ack"], c["at"])
    elif c["kind"] == "resolveEnd":
        it_resolve_end(t, now, c["by"])
    elif c["kind"] == "draw":
        it_turn_resume(t, now, c["seat"], c["alt"])

def it_receive(t, now, ack=False):
    """收下情報的流程（可被暫停）：0 牆頭草「保命」→ 1 放進情報區＋自動技能（雙面、兩邊倒）→ 2 情報商「順水推舟」→ 3 結算勝利／出局 → 4 收藏家「搜刮／偽造遺囑」→ 收尾。"""
    L = t["g"]["letter"]
    it_recv(t, now, {"kind": "recv", "at": L["at"], "card": L["card"], "cause": L.get("cause", L["from"]), "from": L["from"], "ack": ack, "stage": 0})

def it_recv(t, now, r):
    g, s, card = t["g"], t["seats"][r["at"]], r["card"]
    has_k = it_has_k(card)
    if r["stage"] == 0 and not r.get("layoutAsked"):   # 暗殺者「布局」：即將收下情報時，可以直接放進別人的情報區（親手＝暗殺者）
        r["layoutAsked"] = True
        if it_skill_ready(t, r["at"], "assassin") and any(k != r["at"] for k in it_alive(t)):
            it_prompt(t, now, {"kind": "layout", "seat": r["at"], "card": card, "cont": r})
            return
    if r["stage"] == 0 and not r.get("burnAsked"):   # 局外人「無關緊要」（一局一次）：一封情報將被你收下時（含鎖定、轉移、布局），改為燒掉
        r["burnAsked"] = True
        if it_skill_ready(t, r["at"], "outsider") and not s.get("onceUsed"):
            it_prompt(t, now, {"kind": "burn", "seat": r["at"], "card": card, "cont": r})
            return
    if r["stage"] == 0:
        r["stage"] = 1
        if has_k and it_skill_ready(t, r["at"], "fencesitter") and not s.get("onceUsed") and len(s["hand"]) >= 2 and it_black(s["intel"]) == 2:
            it_prompt(t, now, {"kind": "savelife", "seat": r["at"], "cont": r})
            return
    if r["stage"] == 1 and not r.get("subAsked"):   # 助人者「替死」（一局一次）：一位玩家將因這張咒函出局時，可改放進助人者的情報區
        r["subAsked"] = True
        h = next((k for k, x in enumerate(t["seats"]) if k != r["at"] and it_skill_ready(t, k, "helper") and not x.get("onceUsed")), -1) if has_k and it_black(s["intel"]) >= IT_DEATH - 1 else -1
        if h >= 0:
            it_prompt(t, now, {"kind": "sub", "seat": h, "victim": r["at"], "card": card, "cont": r})
            return
    if r["stage"] == 1:
        r["stage"] = 2
        s["intel"].append(card)
        g["letter"] = None
        g["arrive"] = None
        if has_k and s.get("immuneTurn") and s["immuneTurn"] == g.get("turnNo"):
            s.setdefault("immuneCards", []).append(card)   # 篡奪者「死裡逃生」：記下這回合收到的咒函
        tbl_log(t, f"{s['name']} 收下了密函：{it_label(card)}")
        if it_skill_ready(t, r["at"], "doubleagent") and len(it_cols(card)) == 2:
            it_draw(t, r["at"], 1)
            tbl_log(t, f"{s['name']}【雙面間諜】收下雙色情報，抽 1 張")
        if it_skill_ready(t, r["at"], "fencesitter") and has_k:
            it_draw(t, r["at"], 1)
            tbl_log(t, f"{s['name']}【牆頭草】收下含咒函的情報，抽 1 張")
        if it_skill_ready(t, r["at"], "healer"):   # 解藥師「製藥」：獲得情報時多抽 1 張
            it_draw(t, r["at"], 1)
            tbl_log(t, f"{s['name']}【解藥師】製藥：獲得情報，多抽 1 張")
        if it_skill_ready(t, r["at"], "judge") and has_k:   # 審判者「審判」：抽 2 張，等一下可以放 1 張咒函；將因此出局時「最終審判」（一局一次）再多一次
            r["judgeN"] = 1
            if it_black(s["intel"]) >= IT_DEATH and not s.get("onceUsed"):
                r["judgeN"] = 2
                s["onceUsed"] = True
                tbl_log(t, f"{s['name']}【審判者】最終審判：死前再審判一次")
            it_draw(t, r["at"], 2 * r["judgeN"])
            tbl_log(t, f"{s['name']}【審判者】審判：獲得咒函，抽 {2 * r['judgeN']} 張")
        if it_skill_ready(t, r["at"], "poisoner") and has_k:   # 毒藥師「試毒」：抽 3 張，等一下選 1 張放回牌庫頂
            got = []
            for _ in range(3):
                c = it_top(t)
                if c is None:
                    break
                s["hand"].append(c)
                got.append(c)
            if got:
                r["taste"] = got
                tbl_log(t, f"{s['name']}【毒藥師】試毒：獲得咒函，抽 {len(got)} 張")
    if r["stage"] == 2:
        if r.get("taste"):
            cards = r["taste"]
            r["taste"] = None
            it_prompt(t, now, {"kind": "taste", "seat": r["at"], "cards": cards, "cont": r})
            return
        while r.get("judgeN", 0) > 0:
            r["judgeN"] -= 1
            if any(it_has_k(c) for c in s["hand"]):
                it_prompt(t, now, {"kind": "judge", "seat": r["at"], "cont": r})
                return
        fr = r.get("from", -1)
        if fr is None:
            fr = -1
        if not r.get("markAsked"):   # 毒藥師「製毒」：一位玩家獲得毒藥師傳出的黃藍情報（含黃或含藍，使用者 2026-11-12 說明）時，毒藥師可在他面前再放 1 張咒函（從手牌）
            r["markAsked"] = True
            if ("Y" in it_cols(card) or "B" in it_cols(card)) and fr >= 0 and fr != r["at"] and it_skill_ready(t, fr, "poisoner") and any(it_has_k(c) for c in t["seats"][fr]["hand"]):
                it_prompt(t, now, {"kind": "mark", "seat": fr, "tgt": r["at"], "cont": r})
                return
        if not r.get("chaseAsked"):   # 殺手「追殺」：一位玩家獲得殺手傳出的咒函時，殺手抽 2 張，並可在他面前再放 1 張咒函（從手牌）
            r["chaseAsked"] = True
            if has_k and fr >= 0 and fr != r["at"] and it_skill_ready(t, fr, "killer"):
                it_draw(t, fr, 2)
                tbl_log(t, f"{t['seats'][fr]['name']}【殺手】追殺：{s['name']} 獲得了他傳出的咒函，抽 2 張")
                if any(it_has_k(c) for c in t["seats"][fr]["hand"]):
                    it_prompt(t, now, {"kind": "chase", "seat": fr, "tgt": r["at"], "cont": r})
                    return
        r["stage"] = 3
        if has_k and it_skill_ready(t, r["at"], "broker") and any(k != r["at"] and x["hand"] for k, x in enumerate(t["seats"])):
            it_prompt(t, now, {"kind": "dig", "seat": r["at"], "cont": r})
            return
    if r["stage"] == 3:
        r["stage"] = 4
        if it_check_intel(t, r["at"], r["cause"]):
            return   # 遊戲結束
    if r["stage"] == 4:
        r["stage"] = 5
        if (g["lootQ"] or g.get("dieQ")) and it_loot_run(t, now, {"kind": "recvEnd", "ack": r["ack"], "at": r["at"]}):
            return
    it_recv_end(t, now, r["ack"], r["at"])

def it_recv_end(t, now, ack, at):
    g = t.get("g")
    if not g:
        return
    if ack and g["untimed"]:   # 不限時模式：收下後要所有活人按「準備繼續」才換下一位
        g["step"], g["ack"] = "ack", {"by": at, "ok": []}
        it_ack_check(t, now)
        return
    it_end_letter(t, now)

def it_resolve_end(t, now, by):
    """行動生效後的收尾：角色卡勝利條件、收藏家搜刮、輪到的人沒牌。"""
    g = t.get("g")
    if not g:
        return
    if g.get("chars") and it_char_check(t, by):
        return
    if (g["lootQ"] or g.get("dieQ")) and it_loot_run(t, now, {"kind": "resolveEnd", "by": by}):
        return
    it_no_hand(t, now)

def it_loot_run(t, now, cont):
    """有人出局後：場上有收藏家就讓他選要不要搜刮（死者的手牌先留著）；沒有就把手牌丟進棄牌堆。回傳 True＝開了暫停。"""
    g = t["g"]
    while g["lootQ"]:
        vi = g["lootQ"].pop(0)
        v = t["seats"][vi]
        ci = next((k for k in range(len(t["seats"])) if k != vi and it_skill_ready(t, k, "collector")), -1)
        if ci < 0 or (not v["hand"] and not v["intel"]):
            g["discard"] += v["hand"]
            v["hand"] = []
            continue
        it_prompt(t, now, {"kind": "loot", "seat": ci, "victim": vi, "cont": cont})
        return True
    while g.get("dieQ"):   # 出局者自己的技能：遺言（看一人的手牌拿走 2 張丟棄）、殉道（洗白任一玩家的一張咒函）
        q = g["dieQ"].pop(0)
        if t["seats"][q["seat"]].get("left"):
            continue
        if q["kind"] == "will" and any(k != q["seat"] and it_ok(t, k) and x["hand"] for k, x in enumerate(t["seats"])):
            it_prompt(t, now, {"kind": "will", "seat": q["seat"], "cont": cont})
            return True
        if q["kind"] == "martyr" and any(it_ok(t, k) and it_black(x["intel"]) > 0 for k, x in enumerate(t["seats"])):
            it_prompt(t, now, {"kind": "martyr", "seat": q["seat"], "cont": cont})
            return True
        if q["kind"] == "profit" and it_skill_ready(t, q["seat"], "fisher") and any(it_has_k(c) for c in t["seats"][q["seat"]]["hand"]) and any(k != q["victim"] for k in it_alive(t)):
            it_prompt(t, now, {"kind": "profit", "seat": q["seat"], "victim": q["victim"], "cont": cont})
            return True
    return False

def it_place_black(t, frm, to, card, label):
    """從自己手牌放一張咒函到某人的情報區（審判、製毒、追殺、劇毒）：放完照常結算勝利／出局（親手＝放的人）。回傳 True＝遊戲結束。"""
    s, o = t["seats"][frm], t["seats"][to]
    if card not in s["hand"]:
        return False
    s["hand"].remove(card)
    o["intel"].append(card)
    tbl_log(t, f"{s['name']}【{IT_CHARS[s['char']][0]}】{label}：在 {o['name']} 的情報區放了一張咒函（{it_label(card)}）")
    return bool(it_check_intel(t, to, frm))

def it_prompt_data(t, p):
    """暫停中給這位玩家看的資料（只給 p["seat"]）。"""
    k = p["kind"]
    if k == "savelife":
        return {"card": p["cont"]["card"]}
    if k == "dig":
        return {"hands": [[] if j == p["seat"] else list(x["hand"]) for j, x in enumerate(t["seats"])]}
    if k == "merge":
        return {"tgt": p["tgt"], "hand": list(t["seats"][p["tgt"]]["hand"])}
    if k == "loot":
        v = t["seats"][p["victim"]]
        return {"victim": p["victim"], "hand": list(v["hand"]), "intel": list(v["intel"]), "will": not t["seats"][p["seat"]].get("onceUsed")}
    if k == "taste":
        return {"cards": list(p["cards"])}
    if k in ("mark", "chase", "venom"):
        return {"tgt": p["tgt"]}
    if k in ("layout", "burn"):
        return {"card": p["card"]}
    if k == "rescue":
        return {"cands": [j for j, x in enumerate(t["seats"]) if j not in p["win"] and not x.get("left")]}
    if k == "profit":
        return {"victim": p["victim"]}
    if k == "sub":
        return {"victim": p["victim"], "card": p["card"]}
    if k == "will2":
        return {"tgt": p["tgt"], "hand": list(t["seats"][p["tgt"]]["hand"])}
    if k == "martyr":
        return {"intels": [[j for j, c in enumerate(x["intel"]) if it_has_k(c)] if it_ok(t, n) else [] for n, x in enumerate(t["seats"])]}
    if k == "scheme":
        return {"intels": [[j for j, c in enumerate(x["intel"]) if it_has_k(c)] if it_ok(t, n) else [] for n, x in enumerate(t["seats"])]}
    return {}

def _ok_idx(k, arr):
    return type(k) is int and 0 <= k < len(arr)

def it_prompt_done(t, ans, now):
    """玩家回答（ans＝None：不用／逾時）。答案不合法就回 False、暫停繼續；成功回 True。"""
    g = t["g"]
    p = g.get("prompt")
    if not p:
        return False
    s = t["seats"][p["seat"]]
    k = p["kind"]
    if k == "savelife":   # 牆頭草「保命」：將收下第 3 張咒函時，棄 2 張手牌，改為燒掉該情報
        if ans and ans.get("yes"):
            hi = list(dict.fromkeys(ans["idx"])) if isinstance(ans.get("idx"), list) else []
            if len(hi) != 2 or not all(_ok_idx(x, s["hand"]) for x in hi):
                return False
            g["prompt"] = None
            for x in sorted(hi, reverse=True):
                g["discard"].append(s["hand"].pop(x))
            s["onceUsed"] = True
            g["discard"].append(p["cont"]["card"])
            g["letter"] = None
            g["arrive"] = None
            tbl_log(t, f"{s['name']}【牆頭草】發動保命：棄 2 張手牌，把第 3 張咒函燒掉了（{it_label(p['cont']['card'])}）")
            it_end_letter(t, now)
            return True
        g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "dig":   # 情報商「順水推舟」：檢視任一玩家的手牌，選 1 張當自己的手牌
        if ans and ans.get("tgt") is not None:
            tg = ans["tgt"]
            if type(tg) is not int or not 0 <= tg < len(t["seats"]) or tg == p["seat"] or not _ok_idx(ans.get("idx"), t["seats"][tg]["hand"]):
                return False
            g["prompt"] = None
            o = t["seats"][tg]
            s["hand"].append(o["hand"].pop(ans["idx"]))
            tbl_log(t, f"{s['name']}【情報商】順水推舟：從 {o['name']} 手上拿了一張牌")
        else:
            g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "merge":   # 情報商「併購」：看他的全部手牌，拿走 1 張，再給他自己的 1 張
        if ans and ans.get("take") is not None:
            o = t["seats"][p["tgt"]]
            if not it_ok(t, p["tgt"]) or not _ok_idx(ans["take"], o["hand"]) or not _ok_idx(ans.get("give"), s["hand"]):
                return False
            g["prompt"] = None
            a = o["hand"].pop(ans["take"])
            b = s["hand"].pop(ans["give"])
            s["hand"].append(a)
            o["hand"].append(b)
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【情報商】併購了 {o['name']}：拿走他的一張牌，再給他一張")
            if it_char_check(t, p["seat"]):
                return True
            it_no_hand(t, now)
            return True
        g["prompt"] = None
        return True
    if k == "loot":   # 收藏家：搜刮（選死者 1 張手牌當自己的手牌或放進自己的情報區）／偽造遺囑（一局一次：死者的情報全部納為手牌）
        v = t["seats"][p["victim"]]
        take, dest, will = -1, "hand", False
        if ans:
            take = ans.get("take") if ans.get("take") is not None else -1
            dest = "intel" if ans.get("dest") == "intel" else "hand"
            will = bool(ans.get("will"))
            if (take != -1 and not _ok_idx(take, v["hand"])) or (will and s.get("onceUsed")):
                return False
        g["prompt"] = None
        if will:
            s["hand"] += v["intel"]
            tbl_log(t, f"{s['name']}【收藏家】偽造遺囑：把 {v['name']} 情報區的 {len(v['intel'])} 張情報納為手牌")
            v["intel"] = []
            s["onceUsed"] = True
        ended = False
        if take != -1:
            c = v["hand"].pop(take)
            if dest == "intel":
                s["intel"].append(c)
                tbl_log(t, f"{s['name']}【收藏家】搜刮：把 {v['name']} 的一張牌放進自己的情報區（{it_label(c)}）")
                ended = bool(it_check_intel(t, p["seat"], -1))
            else:
                s["hand"].append(c)
                tbl_log(t, f"{s['name']}【收藏家】搜刮：拿走 {v['name']} 的一張手牌")
        if not t.get("g") or ended:
            return True
        g["discard"] += v["hand"]   # 死者剩下的手牌丟掉
        v["hand"] = []
        if not it_loot_run(t, now, p["cont"]):
            it_cont(t, now, p["cont"])
        return True
    if k == "layout":   # 暗殺者「布局」：把這封情報直接放進別人的情報區（不用＝自己照常收下）
        if ans and ans.get("tgt") is not None:
            tg = ans.get("tgt")
            if not it_ok(t, tg) or tg == p["seat"]:
                return False
            g["prompt"] = None
            tbl_log(t, f"{s['name']}【暗殺者】布局：把情報直接放進 {t['seats'][tg]['name']} 的情報區")
            r = p["cont"]
            r["at"], r["cause"], r["stage"] = tg, p["seat"], 0   # 換成對方收下（照常走他的保命／替死／自動技能、結算），親手＝暗殺者
            it_cont(t, now, r)
            return True
        g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "profit":   # 漁翁「得利」：在另一位玩家（不是出局的那位）面前放最多 2 張咒函（從手牌）
        if ans and ans.get("tgt") is not None and isinstance(ans.get("idx"), list) and ans["idx"]:
            tg, hi = ans.get("tgt"), list(dict.fromkeys(ans["idx"]))
            if tg == p["victim"] or not it_ok(t, tg) or len(hi) > 2 or not all(_ok_idx(x, s["hand"]) and it_has_k(s["hand"][x]) for x in hi):
                return False
            g["prompt"] = None
            for c in [s["hand"][x] for x in hi]:
                if it_place_black(t, p["seat"], tg, c, "得利"):
                    return True
                if not it_ok(t, tg):
                    break
            if not t.get("g"):
                return True
        else:
            g["prompt"] = None
        if not it_loot_run(t, now, p["cont"]):
            it_cont(t, now, p["cont"])
        return True
    if k in ("judge", "mark", "chase"):   # 放 1 張咒函（審判：任一活人；製毒／追殺：獲得情報的那位）。不用＝不放
        if ans and ans.get("idx") is not None:
            tg = ans.get("tgt") if k == "judge" else p["tgt"]
            x = ans.get("idx")
            if not _ok_idx(x, s["hand"]) or not it_has_k(s["hand"][x]) or not it_ok(t, tg):
                return False
            g["prompt"] = None
            if it_place_black(t, p["seat"], tg, s["hand"][x], {"judge": "審判", "mark": "製毒", "chase": "追殺"}[k]):
                return True
            if not t.get("g"):
                return True
        else:
            g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "venom":   # 毒藥師「劇毒」（一局一次）：識破了你的查驗的人，在他面前放最多 2 張咒函（從手牌）
        if ans and isinstance(ans.get("idx"), list) and ans["idx"]:
            hi = list(dict.fromkeys(ans["idx"]))
            if len(hi) > 2 or not all(_ok_idx(x, s["hand"]) and it_has_k(s["hand"][x]) for x in hi) or not it_ok(t, p["tgt"]):
                return False
            g["prompt"] = None
            s["onceUsed"] = True
            for c in [s["hand"][x] for x in hi]:
                if it_place_black(t, p["seat"], p["tgt"], c, "劇毒"):
                    return True
                if not it_ok(t, p["tgt"]):
                    break
            if not t.get("g"):
                return True
        else:
            g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "burn":   # 局外人「無關緊要」（一局一次）：改為燒掉這封情報
        g["prompt"] = None
        if ans and ans.get("yes"):
            s["onceUsed"] = True
            g["discard"].append(p["cont"]["card"])
            g["letter"] = None
            g["arrive"] = None
            tbl_log(t, f"{s['name']}【局外人】無關緊要：把要收下的情報燒掉了（{it_label(p['cont']['card'])}）")
            it_end_letter(t, now)
            return True
        it_cont(t, now, p["cont"])
        return True
    if k == "rescue":   # 調和者「救助」：獲勝時，指定一位玩家一同勝利
        extra = -1
        if ans and ans.get("tgt") is not None:
            tg = ans["tgt"]
            if type(tg) is not int or tg in p["win"] or not 0 <= tg < len(t["seats"]) or t["seats"][tg].get("left"):
                return False
            extra = tg
        g["prompt"] = None
        ws = [t["seats"][j] for j in p["win"]]
        if extra >= 0:
            ws.append(t["seats"][extra])
        it_finish(t, p["text"] + (f"　{s['name']}【調和者】救助：{t['seats'][extra]['name']} 一起獲勝" if extra >= 0 else ""), ws, True)
        return True
    if k == "sub":   # 助人者「替死」（一局一次）：改把這張咒函放進自己的情報區
        g["prompt"] = None
        if ans and ans.get("yes"):
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【助人者】替死：把要讓 {t['seats'][p['victim']]['name']} 出局的咒函收進自己的情報區")
            p["cont"]["at"] = p["seat"]
        it_cont(t, now, p["cont"])
        return True
    if k == "will":   # 絕望者「遺言」（一局一次，出局時）：先指定一位玩家
        if ans and ans.get("tgt") is not None:
            tg = ans.get("tgt")
            if tg == p["seat"] or not it_ok(t, tg) or not t["seats"][tg]["hand"]:
                return False
            s["onceUsed"] = True
            g["prompt"] = None
            it_prompt(t, now, {"kind": "will2", "seat": p["seat"], "tgt": tg, "cont": p["cont"]})
            tbl_log(t, f"{s['name']}【絕望者】遺言：檢視 {t['seats'][tg]['name']} 的手牌")
            return True
        g["prompt"] = None
        if not it_loot_run(t, now, p["cont"]):
            it_cont(t, now, p["cont"])
        return True
    if k == "will2":   # 遺言：拿走他 2 張手牌，丟進棄牌堆（不選／逾時＝拿走前 2 張）
        o = t["seats"][p["tgt"]]
        need = min(2, len(o["hand"]))
        hi = list(dict.fromkeys(ans["idx"])) if ans and isinstance(ans.get("idx"), list) else list(range(need))
        if len(hi) != need or not all(_ok_idx(x, o["hand"]) for x in hi):
            return False
        g["prompt"] = None
        for x in sorted(hi, reverse=True):
            g["discard"].append(o["hand"].pop(x))
        tbl_log(t, f"{s['name']}【絕望者】遺言：拿走 {o['name']} 的 {need} 張手牌丟進棄牌堆")
        if not it_loot_run(t, now, p["cont"]):
            it_cont(t, now, p["cont"])
        return True
    if k == "martyr":   # 助人者「殉道」（出局時）：洗白任一活人情報區的一張咒函（不需要洗白牌）
        if ans and ans.get("tgt") is not None:
            tg = ans.get("tgt")
            if not it_ok(t, tg) or not _ok_idx(ans.get("idx"), t["seats"][tg]["intel"]) or not it_has_k(t["seats"][tg]["intel"][ans["idx"]]):
                return False
            g["prompt"] = None
            o = t["seats"][tg]
            c = o["intel"].pop(ans["idx"])
            g["discard"].append(c)
            if tg not in s["washedFor"]:
                s["washedFor"].append(tg)
            tbl_log(t, f"{s['name']}【助人者】殉道：洗白了 {o['name']} 情報區的一封咒函（{it_label(c)}）")
            if it_char_check(t, tg):
                return True
        else:
            g["prompt"] = None
        if not it_loot_run(t, now, p["cont"]):
            it_cont(t, now, p["cont"])
        return True
    if k == "taste":   # 毒藥師「試毒」：剛抽的 3 張選 1 張放回牌庫頂（不選／逾時＝放回第一張）
        x = ans.get("idx") if ans and type(ans.get("idx")) is int else 0
        if not 0 <= x < len(p["cards"]):
            return False
        g["prompt"] = None
        c = p["cards"][x]
        if c in s["hand"]:
            at = len(s["hand"]) - 1 - s["hand"][::-1].index(c)
            g["deck"].append(s["hand"].pop(at))
            tbl_log(t, f"{s['name']}【毒藥師】試毒：選了 1 張放回牌庫頂")
        it_cont(t, now, p["cont"])
        return True
    if k == "scheme":   # 暗殺者「暗計」：放棄抽牌，把任一玩家情報區的一張咒函加入自己的手牌（不用／逾時＝照常抽牌）
        if ans and ans.get("tgt") is not None:
            tg = ans.get("tgt")
            if not it_ok(t, tg) or not _ok_idx(ans.get("idx"), t["seats"][tg]["intel"]) or not it_has_k(t["seats"][tg]["intel"][ans["idx"]]):
                return False
            g["prompt"] = None
            o = t["seats"][tg]
            c = o["intel"].pop(ans["idx"])
            s["hand"].append(c)
            tbl_log(t, f"{s['name']}【暗殺者】暗計：放棄抽牌，把 {o['name']} 情報區的一封咒函（{it_label(c)}）拿進手牌")
            it_turn_resume(t, now, p["seat"], True)
            return True
        g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    if k == "gather":   # 咒函蒐集者「採集」：改為翻開牌堆頂 3 張，純黑的全拿，其餘放到牌堆底（不用／逾時＝照常抽牌）
        if ans and ans.get("yes"):
            g["prompt"] = None
            got, rest = [], []
            for _ in range(3):
                c = it_top(t)
                if c is None:
                    break
                (got if it_pure_black(c) else rest).append(c)
            s["hand"] += got
            g["deck"][0:0] = rest
            shown = "、".join(it_label(c) for c in got + rest) or "沒有牌"
            tbl_log(t, f"{s['name']}【咒函蒐集者】採集：翻開牌堆頂 {len(got) + len(rest)} 張（{shown}），拿走 {len(got)} 張純黑，其餘放到牌堆底")
            it_turn_resume(t, now, p["seat"], True)
            return True
        g["prompt"] = None
        it_cont(t, now, p["cont"])
        return True
    g["prompt"] = None
    return True

def it_wash_own(t, i, msg, now, label):
    """避險／調節：棄 2 張手牌，洗白自己情報區的一張咒函。"""
    g, s = t["g"], t["seats"][i]
    hi = list(dict.fromkeys(msg["hand"])) if isinstance(msg.get("hand"), list) else []
    k = msg.get("intel")
    if len(hi) != 2 or not all(_ok_idx(x, s["hand"]) for x in hi) or not _ok_idx(k, s["intel"]) or not it_has_k(s["intel"][k]):
        return
    c = s["intel"].pop(k)
    for x in sorted(hi, reverse=True):
        g["discard"].append(s["hand"].pop(x))
    g["discard"].append(c)
    if i not in s["washedFor"]:
        s["washedFor"].append(i)
    tbl_log(t, f"{s['name']}【{IT_CHARS[s['char']][0]}】{label}：棄 2 張手牌，洗白了自己情報區的一封咒函（{it_label(c)}）")
    if it_char_check(t, i):
        return
    it_no_hand(t, now)

def it_skill(t, i, msg, now):
    """主動技能：k＝技能編號（0／1 不限次數，2 一局一次）。"""
    g, s, k = t["g"], t["seats"][i], msg.get("k")
    L = g["letter"]
    flip_k = (s.get("char") in ("healer", "fisher") and k == 0) or (s.get("char") == "usurper" and k == 1)   # 求知慾、埋伏、轉機；   # 求知慾、埋伏：「公開角色牌」的技能＝只有覆蓋中能用（用了就翻開；使用者 2026-11-12 定）
    if flip_k and s.get("faceUp"):
        return
    if not g.get("chars") or not s.get("char") or s.get("out") or s.get("left") or (not s.get("faceUp") and not flip_k) or g.get("ask") or g.get("prompt") or g["step"] == "pick":
        return
    idle = not g["pend"]
    mine = g["step"] == "turn" and t["turn"] == i and not L
    cid = s["char"]
    if cid == "cautious":
        if k == 0:   # 審慎：蓋著的密函傳到你手上時，可偷看內容（不算使用行動牌）
            if not idle or g["step"] != "pass" or not L or L["at"] != i or L["kind"] == "pub" or L.get("open"):
                return
            s["note"] = {"k": "peek", "card": L["card"]}
            tbl_log(t, f"{s['name']}【謹慎者】審慎：偷看了手上的密函")
        elif k == 1:   # 避險：棄 2 張手牌，洗白自己情報區的一張咒函
            if idle:
                it_wash_own(t, i, msg, now, "避險")
        elif k == 2:   # 絕對謹慎（一局一次）：被鎖定或被轉移選為對象時，取消該效果，情報照一般流程處理（在識破時間內使用）
            if not g["pend"] or s.get("onceUsed"):
                return
            r = g["pend"]
            while r["under"]:
                r = r["under"]
            if r["a"] not in ("F", "T") or r["tgt"] != i:
                return
            r["void"] = True
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【謹慎者】絕對謹慎：取消了對自己的{IT_ACT[r['a']]}")
    elif cid == "doubleagent":
        if k == 2 and idle and not s.get("onceUsed"):   # 雙面人生（一局一次）：從牌堆中找一張雙色牌加入手牌，然後洗牌
            c = msg.get("c")
            if c not in g["deck"] or len(it_cols(c)) != 2:
                return
            g["deck"].remove(c)
            s["hand"].append(c)
            random.shuffle(g["deck"])
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【雙面間諜】雙面人生：從牌堆找了一張雙色牌加入手牌，牌堆重洗")
    elif cid == "fencesitter":
        if k == 1 and idle and mine:   # 調節：自己回合、投遞前，棄 2 張手牌，洗白自己情報區的一張咒函
            it_wash_own(t, i, msg, now, "調節")
    elif cid == "healer":
        tg = msg.get("tgt")
        if k == 0:   # 求知慾：他人回合的情報傳遞階段，公開角色牌並視為使用了攔截（技能，不能被識破）
            if not idle or g["step"] != "pass" or not L or t["turn"] == i or L["at"] == i or L["from"] == i:
                return
            it_flip(t, i)
            tbl_log(t, f"{s['name']}【解藥師】求知慾：視為使用了攔截")
            it_apply(t, {"a": "I", "by": i}, now)
        elif k == 2 and idle and not s.get("onceUsed") and type(tg) is int and tg != i and it_ok(t, tg):   # 公開（一局一次）：暴露自己的陣營，並指定一人也暴露陣營
            o = t["seats"][tg]
            s["exposed"] = o["exposed"] = True
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【解藥師】公開：{s['name']} 是{IT_ROLE[s['role']]}，{o['name']} 是{IT_ROLE[o['role']]}")
    elif cid == "fisher":
        tg = msg.get("tgt")
        if k == 0:   # 埋伏：情報傳遞階段，公開角色牌，把一位其他玩家情報區的 1 張情報放回牌庫頂
            if not idle or g["step"] != "pass" or not L or type(tg) is not int or tg == i or not it_ok(t, tg) or not _ok_idx(msg.get("intel"), t["seats"][tg]["intel"]):
                return
            it_flip(t, i)
            o = t["seats"][tg]
            c = o["intel"].pop(msg["intel"])
            g["deck"].append(c)
            tbl_log(t, f"{s['name']}【漁翁】埋伏：把 {o['name']} 情報區的一張情報（{it_label(c)}）放回牌庫頂")
            it_char_check(t, i)
        elif k == 2 and idle and not s.get("onceUsed") and t["turn"] != i and g["step"] in ("turn", "pass") and type(tg) is int and tg != i and it_ok(t, tg) and not it_locked(g, tg):   # 灑網（一局一次）：在別人的回合指定一人被鎖定
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【漁翁】灑網")
            it_lock_apply(t, i, tg, now)
    elif cid == "assassin":
        tg = list(dict.fromkeys(msg["tgts"])) if isinstance(msg.get("tgts"), list) else []
        if k == 2 and idle and not s.get("onceUsed") and g["step"] == "pass" and L and tg and all(it_ok(t, x) for x in tg):   # 煙霧彈（一局一次）：情報傳遞階段，指定任意數量的玩家被阻擋
            s["onceUsed"] = True
            for x in tg:
                if not it_blocked(g, x):
                    g["blocked"].append(x)
            tbl_log(t, f"{s['name']}【暗殺者】煙霧彈：{'、'.join(t['seats'][x]['name'] for x in tg)} 本回不能收下情報")
    elif cid == "desperate":
        tg, hi = msg.get("tgt"), (list(dict.fromkeys(msg["hand"])) if isinstance(msg.get("hand"), list) else [])
        if k == 1 and idle and len(hi) == 4 and all(_ok_idx(x, s["hand"]) for x in hi) and type(tg) is int and tg != i and it_ok(t, tg) and _ok_idx(msg.get("intel"), t["seats"][tg]["intel"]):   # 交易：4 張手牌交給他，拿走他情報區的一張情報（放進自己手牌）
            o = t["seats"][tg]
            give = [s["hand"].pop(x) for x in sorted(hi, reverse=True)]
            o["hand"] += give
            c = o["intel"].pop(msg["intel"])
            s["hand"].append(c)
            tbl_log(t, f"{s['name']}【絕望者】交易：把 4 張手牌交給 {o['name']}，拿走他情報區的一張情報（{it_label(c)}）")
            if it_char_check(t, i):
                return
            it_no_hand(t, now)
    elif cid == "judge":
        tg = msg.get("tgt")
        if k == 0 and idle and type(tg) is int and tg != i and it_ok(t, tg) and it_black(t["seats"][tg]["intel"]) >= 2:   # 旁聽：情報區有 2 張以上咒函的玩家，檢視他的手牌
            o = t["seats"][tg]
            s["note"] = {"k": "view", "tgt": o["name"], "cards": list(o["hand"])}
            tbl_log(t, f"{s['name']}【審判者】旁聽：檢視了 {o['name']} 的手牌")
    elif cid == "sniper":
        tgs = list(dict.fromkeys(msg["tgts"])) if isinstance(msg.get("tgts"), list) else []
        if k == 1 and idle and mine and s.get("shotTurn") != g.get("turnNo") and tgs and all(x != i and it_ok(t, x) for x in tgs):   # 亂槍打鳥（自己回合開始時，每回合一次）：指定任意數量的玩家被鎖定
            s["shotTurn"] = g.get("turnNo")
            for x in tgs:
                if not it_locked(g, x):
                    g.setdefault("locked", []).append(x)
            tbl_log(t, f"{s['name']}【狙擊手】亂槍打鳥：{'、'.join(t['seats'][x]['name'] for x in tgs)} 本回情報到他手上就必須收下")
            return
        tg = msg.get("tgt")
        if k == 0 and idle and mine and s.get("aimTurn") != g.get("turnNo") and type(tg) is int and tg != i and it_ok(t, tg):   # 瞄準（自己回合、投遞前，每回合一次）：手牌最多（或之一）的玩家，偷看他 1 張隨機手牌
            o = t["seats"][tg]
            most = max(len(t["seats"][j]["hand"]) for j in it_alive(t) if j != i)
            if not o["hand"] or len(o["hand"]) != most:
                return
            s["aimTurn"] = g.get("turnNo")
            s["note"] = {"k": "aim", "tgt": o["name"], "card": random.choice(o["hand"])}
            tbl_log(t, f"{s['name']}【狙擊手】瞄準：偷看了 {o['name']} 的一張手牌")
    elif cid == "blackcollector":
        tg = msg.get("tgt")
        if k == 2 and idle and not s.get("onceUsed") and type(tg) is int and tg != i and it_ok(t, tg):   # 搶購（一局一次）：拿走他所有純黑手牌，再從牌堆頂給他等量的牌
            o = t["seats"][tg]
            got = [c for c in o["hand"] if it_pure_black(c)]
            o["hand"] = [c for c in o["hand"] if not it_pure_black(c)]
            s["hand"] += got
            s["onceUsed"] = True
            n = 0
            while n < len(got):
                c = it_top(t)
                if c is None:
                    break
                o["hand"].append(c)
                n += 1
            tbl_log(t, f"{s['name']}【咒函蒐集者】搶購：拿走 {o['name']} 的 {len(got)} 張純黑手牌，再從牌堆頂補給他 {n} 張")
            if it_char_check(t, i):
                return
            it_no_hand(t, now)
    elif cid == "outsider":
        if k == 1 and idle and mine:   # 撇清：自己回合、投遞前，棄 2 張手牌，丟棄自己情報區的一張非咒函
            hi = list(dict.fromkeys(msg["hand"])) if isinstance(msg.get("hand"), list) else []
            q = msg.get("intel")
            if len(hi) != 2 or not all(_ok_idx(x, s["hand"]) for x in hi) or not _ok_idx(q, s["intel"]) or it_has_k(s["intel"][q]):
                return
            c = s["intel"].pop(q)
            for x in sorted(hi, reverse=True):
                g["discard"].append(s["hand"].pop(x))
            g["discard"].append(c)
            tbl_log(t, f"{s['name']}【局外人】撇清：棄 2 張手牌，丟棄了自己情報區的一張情報（{it_label(c)}）")
            if it_char_check(t, i):
                return
            it_no_hand(t, now)
    elif cid == "usurper":
        tg = msg.get("tgt")
        if k == 0 and idle and g["step"] == "pass" and L and s.get("faceUp") and type(tg) is int and it_ok(t, tg) and not it_blocked(g, tg):   # 妨礙：情報傳遞階段，覆蓋角色卡並指定一位玩家被阻擋（可以再翻開：轉機）
            s["faceUp"] = False
            g["blocked"].append(tg)
            tbl_log(t, f"{s['name']}【篡奪者】妨礙：覆蓋了角色卡，{t['seats'][tg]['name']} 本回不能收下情報")
        elif k == 1 and idle and not s.get("faceUp") and not s["hand"]:   # 轉機：沒有手牌時，翻開角色卡並抽 2 張牌
            it_flip(t, i)
            it_draw(t, i, 2)
            tbl_log(t, f"{s['name']}【篡奪者】轉機：沒有手牌，翻開角色卡並抽 2 張")
            if it_char_check(t, i):
                return
        elif k == 2 and idle and not s.get("onceUsed") and not (s.get("immuneTurn") and s["immuneTurn"] == g.get("turnNo")):   # 死裡逃生（一局一次）：這回合收到咒函不會出局，回合結束時洗白這回合收到的咒函
            s["onceUsed"], s["immuneTurn"], s["immuneCards"] = True, g.get("turnNo"), []
            tbl_log(t, f"{s['name']}【篡奪者】死裡逃生：這回合收到咒函不會出局，回合結束時洗白這回合收到的咒函")
    elif cid == "broker":
        tg = msg.get("tgt")
        if k == 2 and idle and not s.get("onceUsed") and type(tg) is int and tg != i and it_ok(t, tg) and t["seats"][tg]["hand"] and s["hand"]:   # 併購（一局一次）：先看他的全部手牌
            it_prompt(t, now, {"kind": "merge", "seat": i, "tgt": tg, "cont": None})

def it_arrive(g):
    """不限時：情報每次「到達」一個人手上（投遞、傳給下一位、被攔截、退回發信者）都先確認：所有活人（持有者自動算）按「準備繼續」，
    持有者才能決定收下／傳走；期間其他人可以出押送／攔截／焚信（出牌後確認重來），攔截或傳走後在新持有者手上再確認一次。"""
    if g["untimed"]:
        g["arrive"] = {"ok": []}

def it_arrive_check(t, now):
    g = t.get("g")
    L = g and g["letter"]
    if not g or not g.get("arrive") or not L:
        return
    if all(i == L["at"] or i in g["arrive"]["ok"] for i in it_alive(t)):
        g["arrive"] = None

def it_ack_check(t, now):
    """不限時：收下情報後的確認（所有活人，收下的人自動算）都按了才換下一位。"""
    g = t.get("g")
    a = g and g.get("ack")
    if not a or g["step"] != "ack":
        return
    if all(i == a["by"] or i in a["ok"] for i in it_alive(t)):
        g["ack"] = None
        it_end_letter(t, now)

def it_resolve(t, now):
    """行動生效：chain 由上（最後出的）往下，識破（C）會取消它底下那一張，被取消的識破就不會取消底下的（識破可以被識破）；最底下是真正的行動。"""
    g = t["g"]
    p, act, last_c = g["pend"], True, -1
    g["pend"] = None
    if not g["untimed"]:
        g["deadline"] = max(g["deadline"], now + 5000)   # 生效後至少留 5 秒給拿著密函／輪到的人反應
    while p:
        if p["a"] == "C":
            act = not act
            last_c = p["by"]   # 最後處理到的識破＝緊貼在行動上面那張（行動被取消時，就是他識破的）
            p = p["under"]
            continue
        if act:
            it_apply(t, p, now)
        else:
            tbl_log(t, f"{t['seats'][p['by']]['name']} 的{IT_ACT[p['a']]}被識破，沒有生效")
            pz = t["seats"][p["by"]]   # 毒藥師「劇毒」（一局一次）：查驗被識破時，可在識破的人面前放最多 2 張咒函
            if p["a"] == "V" and last_c >= 0 and last_c != p["by"] and it_skill_ready(t, p["by"], "poisoner") and not pz.get("onceUsed") and it_ok(t, last_c) and any(it_has_k(c) for c in pz["hand"]):
                it_prompt(t, now, {"kind": "venom", "seat": p["by"], "tgt": last_c, "cont": {"kind": "resolveEnd", "by": p["by"]}})
                return
        it_resolve_end(t, now, p["by"])   # 行動可能改變手牌／情報區（竊取、補給、洗白…）：檢查角色卡勝利條件、收藏家搜刮、沒牌跳過
        return

def it_no_hand(t, now):
    """輪到的人把最後一張牌當行動用掉、手上沒牌可以投遞：直接換下一位（限時模式靠逾時，不限時模式沒有逾時，一定要在這裡處理）。"""
    g = t.get("g")
    if not g or t["phase"] != "playing" or g["step"] != "turn" or g["pend"] or g.get("ask") or g["letter"] or t["seats"][t["turn"]]["hand"]:
        return
    tbl_log(t, f"{t['seats'][t['turn']]['name']} 沒有牌可以投遞，跳過")
    it_end_letter(t, now)

def it_apply(t, p, now):
    g = t["g"]
    by = t["seats"][p["by"]]
    if p.get("void"):   # 謹慎者「絕對謹慎」
        tbl_log(t, f"{by['name']} 的{IT_ACT[p['a']]}被取消了，情報照一般流程處理")
        return
    L = g["letter"]
    a = p["a"]
    if a == "P" and L and L["kind"] != "pub" and not L.get("open"):
        col = p.get("col")
        if col:   # 宣告了顏色：一定公開；猜對（雙色只要包含）就抽 1 張，猜錯只是不能抽（2026-11-11 使用者定）
            hit = col in it_cols(L["card"])
            L["open"] = True
            tbl_log(t, f"{by['name']} 宣告{IT_CNAME[col]}色並公開了密函：{it_label(L['card'])}，{'猜對了，抽 1 張' if hit else '猜錯了'}")
            if hit:
                it_draw(t, p["by"], 1)
                if it_skill_ready(t, p["by"], "collector"):
                    it_draw(t, p["by"], 1)
                    tbl_log(t, f"{by['name']}【收藏家】鑑識：宣告成功，額外抽 1 張")
        else:
            by["note"] = {"k": "peek", "card": L["card"]}
            tbl_log(t, f"{by['name']} 截閱了密函")
    elif a == "S" and L and L["kind"] != "pub" and not L.get("open"):   # 調包：換上去的牌公開（所有人看得到），被換掉的牌棄掉
        if p["sel"] not in by["hand"]:
            return
        by["hand"].remove(p["sel"])
        g["discard"].append(L["card"])
        L["card"], L["open"] = p["sel"], True
        tbl_log(t, f"{by['name']} 調包了密函：換上 {it_label(p['sel'])}（公開），原本的牌被丟棄")
    elif a == "F" and it_ok(t, p["tgt"]):   # 鎖定：他正拿著情報就立刻收下；還沒拿到就標記，情報到他手上時只能收下
        it_lock_apply(t, p["by"], p["tgt"], now)
    elif a == "X" and L:
        g["discard"].append(L["card"])
        g["letter"] = None
        tbl_log(t, f"{by['name']} 燒掉了密函")
        it_end_letter(t, now)
    elif a == "I" and L and g["step"] == "pass" and L["at"] != p["by"] and L["from"] != p["by"] and it_ok(t, p["by"]):
        was = t["seats"][L["at"]]["name"]
        L["at"], L["icpt"] = p["by"], p["by"]
        if p["by"] not in L["seen"]:
            L["seen"].append(p["by"])
        g["deadline"] = it_dl(g, now, IT_HOLD_MS)
        it_arrive(g)
        tbl_log(t, f"{by['name']} 從 {was} 手上攔截了{IT_KIND[L['kind']]}")
    elif a == "H" and it_ok(t, p["tgt"]) and not it_cold_eye(t, p["tgt"]):
        th = t["seats"][p["tgt"]]
        cards = it_hide_black(t, p["tgt"])
        random.shuffle(cards)
        by["note"] = {"k": "search", "tgt": th["name"], "cards": cards[:2]}
        tbl_log(t, f"{by['name']} 搜了 {th['name']} 的身")
    elif a == "D" and g["step"] == "turn" and t["turn"] == p["by"] and not L:   # 補給：自己的回合抽 2 張
        it_draw(t, p["by"], 2)
        tbl_log(t, f"{by['name']} 補給，抽了 2 張")
    elif a == "R" and g["step"] == "turn" and t["turn"] == p["by"] and not L and it_ok(t, p["tgt"]) and not it_cold_eye(t, p["tgt"]):   # 竊取：從他手上隨機拿 1 張（被竊取的人到下一階段前看得到提示）
        th = t["seats"][p["tgt"]]
        pool = it_hide_black(t, p["tgt"])
        if not pool:
            tbl_log(t, f"{th['name']} 沒有可以拿的手牌，竊取落空")
            return
        card = random.choice(pool)
        th["hand"].remove(card)
        by["hand"].append(card)
        by["note"] = {"k": "steal", "tgt": th["name"], "card": card}
        th["stolen"] = {"by": by["name"], "card": card}
        tbl_log(t, f"{by['name']} 從 {th['name']} 手上竊取了一張牌")
    elif a == "V" and it_ok(t, p["tgt"]) and not it_cold_eye(t, p["tgt"]):   # 查驗：被查驗的人能自己決定回答（it_can_lie）就等他回答；否則照實回答
        th = t["seats"][p["tgt"]]
        tbl_log(t, f"{by['name']} 查驗了 {th['name']}")
        if it_can_lie(t, p["tgt"]):
            g["ask"] = {"by": p["by"], "tgt": p["tgt"], "dl": g["deadline"], "ext": g.get("ext")}   # 暫停投遞回合：記下原本的期限與加時，回答後還原
            g["deadline"] = it_dl(g, now, IT_HOLD_MS)
            tbl_log(t, f"等 {th['name']} 回答查驗")
        else:
            by["note"] = {"k": "verify", "tgt": th["name"], "ans": th["role"]}
    elif a == "W" and it_ok(t, p["tgt"]):   # 洗白：任何階段，可以對任何人情報區裡含黑的情報使用
        th = t["seats"][p["tgt"]]
        if p["sel"] not in th["intel"]:
            return
        th["intel"].remove(p["sel"])
        g["discard"].append(p["sel"])
        if p["tgt"] not in by.setdefault("washedFor", []):
            by["washedFor"].append(p["tgt"])   # 助人者：曾洗白某位玩家的咒函
        tbl_log(t, f"{by['name']} 洗白了 {th['name']} 情報區的一封情報：{it_label(p['sel'])}")
        if it_skill_ready(t, p["by"], "helper"):
            it_draw(t, p["by"], 1)
            tbl_log(t, f"{by['name']}【助人者】援手：使用洗白，抽 1 張")
    elif a == "T" and L and g["step"] == "pass" and L["at"] == p["by"] and it_ok(t, p["tgt"]) and p["tgt"] != p["by"]:   # 轉移：面前的情報交給另一位，對方不能拒收（被阻擋的人不能當對象）
        if it_blocked(g, p["tgt"]):
            tbl_log(t, f"轉移失敗：{t['seats'][p['tgt']]['name']} 被阻擋，不能收下")
            return
        tbl_log(t, f"{by['name']} 把情報轉移給 {t['seats'][p['tgt']]['name']}，他不能拒收")
        L["at"], L["cause"] = p["tgt"], p["by"]
        if p["tgt"] not in L["seen"]:
            L["seen"].append(p["tgt"])
        it_receive(t, now, True)
    elif a == "B" and L and g["step"] == "pass" and it_ok(t, p["tgt"]):   # 阻擋：指定一人，本回（到換下一位投遞前）不能收下情報
        if not it_blocked(g, p["tgt"]):
            g["blocked"].append(p["tgt"])
        tbl_log(t, f"{by['name']} 阻擋了 {t['seats'][p['tgt']]['name']}：本回他不能收下情報")
    elif a == "N" and g["step"] == "turn" and t["turn"] == p["by"] and not L:   # 無人倖免：從出牌的人開始，照座位順序從牌堆頂各拿一張直接放進情報區，有人勝利就停
        tbl_log(t, f"{by['name']} 發動了無人倖免！")
        n = len(t["seats"])
        for k in range(n):
            j = (p["by"] + k) % n
            if not it_ok(t, j):
                continue
            card = it_top(t)
            if card is None:
                tbl_log(t, "牌堆沒有牌了，無人倖免結束")
                break
            t["seats"][j]["intel"].append(card)
            tbl_log(t, f"{t['seats'][j]['name']} 的情報區多了：{it_label(card)}")
            if it_check_intel(t, j, p["by"]):
                return   # 有人勝利（或場上只剩一個陣營）：遊戲結束
        if t.get("g") and not it_ok(t, t["turn"]):
            it_end_letter(t, now)   # 發動的人自己被黑函淘汰：直接換下一位

def it_tick(t, now):
    """時間檢查（每個操作進來先跑；客戶端時間到時送 timeout）：識破時間過了就生效；回合／收轉逾時就自動處理。不限時模式沒有任何計時。"""
    g = t.get("g")
    if t["game"] != "intel" or t["phase"] != "playing" or not g or g["untimed"]:
        return
    if g.get("prompt"):   # 等玩家決定（技能）：逾時當作不用
        if g["prompt"]["until"] and now >= g["prompt"]["until"]:
            it_prompt_done(t, None, now)
        return
    if g["step"] == "pick":   # 選角逾時：沒選的自動選第一張
        if now >= g["deadline"]:
            it_pick_done(t, now)
        return
    if g["pend"]:
        if now >= g["pend"]["until"]:
            it_resolve(t, now)
        return
    if now < g["deadline"]:
        return
    if g.get("ask"):   # 查驗逾時：照實回答
        it_answer(t, None, now)
        return
    if g["step"] == "pass" and g["letter"]:
        L = g["letter"]
        to = it_fwd_target(t, L) if it_blocked(g, L["at"]) else -1   # 被阻擋的持有者不能收：超時改成自動傳走
        if to >= 0:
            tbl_log(t, f"{t['seats'][L['at']]['name']} 超時（被阻擋），自動把情報傳給 {t['seats'][to]['name']}")
            L["at"] = to
            if to not in L["seen"]:
                L["seen"].append(to)
            g["deadline"] = it_dl(g, now, IT_HOLD_MS)
        else:
            tbl_log(t, f"{t['seats'][L['at']]['name']} 超時，自動收下")
            it_receive(t, now)
    elif g["step"] == "turn":
        s = t["seats"][t["turn"]]
        if not s["hand"]:
            it_end_letter(t, now)
            return
        k = random.randrange(len(s["hand"]))
        kind = it_kind_of(s["hand"][k])   # 投遞方式由卡面決定；直達的目標隨機挑一位
        others = [j for j in it_alive(t) if j != t["turn"]]
        to = random.choice(others) if kind == "direct" and others else it_next_untouched(t, t["turn"], [t["turn"]])
        if to < 0:
            it_end_letter(t, now)
            return
        card = s["hand"].pop(k)
        g["letter"] = {"card": card, "orig": card, "from": t["turn"], "cause": t["turn"], "at": to, "seen": [t["turn"], to], "kind": kind, "icpt": None}
        g["step"], g["deadline"] = "pass", it_dl(g, now, IT_HOLD_MS)
        it_clear_stolen(t)
        tbl_log(t, f"{s['name']} 超時，自動把一封{IT_KIND[kind]}交給 {t['seats'][to]['name']}")

def it_ok_check(t, now):
    """不限時模式：識破時間不倒數，要所有活人（出牌的人自動算）按「準備繼續」才生效；有人出識破就重新計。"""
    g = t["g"]
    p = g["pend"]
    if not p or not g["untimed"]:
        return
    if all(i == p["by"] or i in p["ok"] for i in it_alive(t)):
        it_resolve(t, now)

def it_can_lie(t, i):
    """查驗：被查驗的人能不能自己決定回答（謊報／不透露）。目前還沒有身分牌，一律照實回答；之後「可以謊報查驗」的身分牌在這裡回 True。"""
    return False

IT_ANS = ("sand", "water", "mage", "hide")   # 回答：沙都／水都／咒術師／不透露

def it_answer(t, ans, now):
    """被查驗的人回答（ans＝None：照實回答，逾時或離開時用）。"""
    g = t["g"]
    q = g["ask"]
    th = t["seats"][q["tgt"]]
    g["ask"] = None
    t["seats"][q["by"]]["note"] = {"k": "verify", "tgt": th["name"], "ans": ans or th["role"]}
    tbl_log(t, f"{th['name']} 回答了 {t['seats'][q['by']]['name']} 的查驗" if ans else f"{th['name']} 沒有回答，照實告知查驗結果")
    g["ext"] = q["ext"]
    g["deadline"] = 0 if g["untimed"] else max(q["dl"], now + 5000)   # 回到投遞回合：還原原本的期限（至少留 5 秒）與加時
    it_no_hand(t, now)

def it_ext_of(g, make):
    """加時：目前這段倒數的加時紀錄（識破時間記在 pend 上、其他記在 g["ext"]）；make＝沒有就建立。"""
    o = g["pend"] or g
    if not o.get("ext") and make:
        o["ext"] = {"by": [], "skip": []}
    return o.get("ext")

def it_extend(t, i, now):
    g, s = t["g"], t["seats"][i]
    if g["untimed"] or s.get("extLeft", 0) <= 0 or g["step"] not in ("turn", "pass"):
        return
    e = it_ext_of(g, True)
    if i in e["by"] or len(e["by"]) >= IT_EXT_MAX:
        return
    e["by"].append(i)
    s["extLeft"] -= 1
    base = IT_PEND_MS if g["pend"] else IT_HOLD_MS if g.get("ask") else IT_TURN_MS if g["step"] == "turn" else IT_HOLD_MS
    until = now + base * IT_EXT_MUL
    if g["pend"]:
        g["pend"]["until"] = until
        g["deadline"] = max(g["deadline"], until + 5000)
    else:
        g["deadline"] = until
    tbl_log(t, f"{s['name']} 申請加時（{base * IT_EXT_MUL // 1000} 秒，本局還剩 {s['extLeft']} 次）")

def it_skip(t, i, now):
    g = t["g"]
    e = it_ext_of(g, False)
    if g["untimed"] or not e or i not in e["by"] or i in e["skip"]:
        return
    e["skip"].append(i)
    tbl_log(t, f"{t['seats'][i]['name']} 跳過")
    if not all(j in e["skip"] for j in e["by"]):   # 所有加時的人都跳過才縮回
        return
    if g["pend"]:
        g["pend"]["until"] = min(g["pend"]["until"], now + IT_EXT_SKIP_MS)
    else:
        g["deadline"] = min(g["deadline"], now + IT_EXT_SKIP_MS)

def it_chain(p):
    """識破串：由最底下的行動到最上面（最後出的）。"""
    c = []
    while p:
        c.insert(0, {"a": p["a"], "by": p["by"], "tgt": p["tgt"], "col": p.get("col")})
        p = p["under"]
    return c

def it_msg(t, cid, msg, now):
    role, i = tbl_find(t, cid)
    g, a = t.get("g"), msg.get("a")
    if a == "imode":   # 桌主（第一位入座的人）在開局前選：限時／不限時
        v = msg.get("v")
        if t["game"] != "intel" or role != "seat" or i != 0 or t["phase"] != "lobby" or v not in ("timed", "untimed") or bool(t.get("untimed")) == (v == "untimed"):
            return
        t["untimed"] = v == "untimed"
        for s in t["seats"]:
            s["ready"] = False
        tbl_log(t, f"{t['seats'][0]['name']} 把模式改成{'不限時' if t['untimed'] else '限時'}")
        return
    if a == "ichars":   # 桌主在開局前開關「角色卡」模式
        v = msg.get("v")
        if t["game"] != "intel" or role != "seat" or i != 0 or t["phase"] != "lobby" or type(v) is not bool or bool(t.get("chars")) == v:
            return
        t["chars"] = v
        for s in t["seats"]:
            s["ready"] = False
        tbl_log(t, f"{t['seats'][0]['name']} {'開啟' if v else '關閉'}了角色卡")
        return
    if a == "timeout":
        it_tick(t, now + 300)
        return
    if t["game"] != "intel" or role != "seat" or t["phase"] != "playing" or not g:
        return
    if not it_ok(t, i) and not (a == "iprompt" and g.get("prompt") and g["prompt"]["seat"] == i and not t["seats"][i].get("left")):   # 出局的人只能回答自己的技能選擇（遺言、殉道）
        return
    s, L = t["seats"][i], g["letter"]
    idx, to, sel = msg.get("idx"), msg.get("to"), msg.get("sel")
    if a == "ipick":   # 選角：c＝兩張候選之一
        if g["step"] == "pick" and not s.get("char") and s.get("choices") and msg.get("c") in s["choices"]:
            s["char"] = msg.get("c")
            it_pick_check(t, now)
        return
    if g["step"] == "pick":   # 選角階段只能選角
        return
    if a == "iprompt":   # 回答技能的選擇（no：不用）
        if g.get("prompt") and g["prompt"]["seat"] == i:
            it_prompt_done(t, None if msg.get("no") else msg, now)
        return
    if g.get("prompt"):   # 等玩家決定：其他動作都暫停
        return
    if a == "iskill":   # 角色技能（k＝技能編號）
        it_skill(t, i, msg, now)
        return
    if a == "iext":   # 加時（限時模式）
        it_extend(t, i, now)
        return
    if a == "iskip":   # 加時的人放棄行動：所有加時的人都跳過就縮回 3 秒
        it_skip(t, i, now)
        return
    if a == "ians":   # 回答查驗（只有能謊報的人會被問）
        q = g.get("ask")
        if q and q["tgt"] == i and msg.get("v") in IT_ANS:
            it_answer(t, msg.get("v"), now)
        return
    if g.get("ask"):   # 等查驗回答：其他動作都暫停
        return
    if a == "iok":   # 不限時：按「準備繼續」（識破時間內沒有要識破；或收下情報後的確認）
        p = g["pend"]
        if p:   # 識破／行動確認中：先處理這個
            if g["untimed"] and p["by"] != i and i not in p["ok"]:
                p["ok"].append(i)
                it_ok_check(t, now)
            return
        ar = g.get("arrive")
        if ar and g["untimed"] and g["letter"]:
            if g["letter"]["at"] != i and i not in ar["ok"]:
                ar["ok"].append(i)
                it_arrive_check(t, now)
            return
        ak = g.get("ack")
        if g["step"] == "ack" and ak and g["untimed"]:
            if ak["by"] != i and i not in ak["ok"]:
                ak["ok"].append(i)
                it_ack_check(t, now)
            return
    elif a == "isend":   # 投遞：idx＝手牌；投遞方式由卡面決定（密函／公開情報照座位順序交給下一位；直達情報要帶 to，對方可以不收、退回給發信者）
        if g["pend"] or g["step"] != "turn" or i != t["turn"] or type(idx) is not int or not 0 <= idx < len(s["hand"]):
            return
        intent = msg.get("as") == "direct" and it_skill_ready(t, i, "sniper") and not s.get("onceUsed") and it_has_k(s["hand"][idx])   # 狙擊手「殺意」（一局一次）：一張咒函當作直達送出
        kind = "direct" if intent else it_kind_of(s["hand"][idx])
        dst = to if kind == "direct" else it_next_untouched(t, i, [i])
        if not it_ok(t, dst) or dst == i:
            return
        if intent:
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【狙擊手】殺意：把一張咒函當作直達送出")
        card = s["hand"].pop(idx)
        g["letter"] = {"card": card, "orig": card, "from": i, "cause": i, "at": dst, "seen": [i, dst], "kind": kind, "icpt": None}
        g["step"], g["deadline"] = "pass", it_dl(g, now, IT_HOLD_MS)
        it_clear_stolen(t)
        it_arrive(g)
        dn = t["seats"][dst]["name"]
        tbl_log(t, f"{s['name']} 公開了一則情報（{it_label(card)}），交給 {dn}" if kind == "pub" else f"{s['name']} 把一封直達情報交給 {dn}" if kind == "direct" else f"{s['name']} 把一封密函交給 {dn}")
    elif a == "itake":   # 收下
        if g["pend"] or g.get("arrive") or g["step"] != "pass" or not L or L["at"] != i or not it_can_take(t, L, i):
            return
        it_receive(t, now, True)
    elif a == "ifwd":   # 轉手：只能轉給座位順序的下一個沒碰過的人（直達情報：被攔截的人退回給發信者）
        if g["pend"] or g.get("arrive") or g["step"] != "pass" or not L or L["at"] != i:
            return
        dst = it_fwd_target(t, L)
        if dst < 0:
            return
        L["at"] = dst
        if dst not in L["seen"]:
            L["seen"].append(dst)
        g["deadline"] = it_dl(g, now, IT_HOLD_MS)
        it_arrive(g)
        dn = t["seats"][dst]["name"]
        tbl_log(t, f"{s['name']} 不收，把直達情報退回給 {dn}" if L["kind"] == "direct" else f"{s['name']} 把{IT_KIND[L['kind']]}轉給 {dn}")
    elif a == "iact":   # 使用行動牌：idx＝手牌；搜身帶 tgt、調包帶 sel（換進去的手牌 idx）、洗白帶 sel（情報區 idx）
        if type(idx) is not int or not 0 <= idx < len(s["hand"]):
            return
        card = s["hand"][idx]
        as_f = (msg.get("as") == "F" and it_skill_ready(t, i, "killer") and it_kind_of(card) == "seal") or (msg.get("as") == "F!" and not s.get("onceUsed") and (it_skill_ready(t, i, "killer") or (it_skill_ready(t, i, "harmonizer") and it_kind_of(card) == "direct")))   # 殺手：標記目標（密函）／死亡預告（任一張，一局一次，不能被識破）；調和者「調和」（直達牌，一局一次，不能被識破）
        act = "F" if as_f else "S" if msg.get("as") == "S" and it_skill_ready(t, i, "doubleagent") and len(it_cols(card)) == 2 else it_act(card)   # 雙面間諜「偷天換日」：雙色牌可當作調包使用（是行動牌，可被識破）
        if g["pend"]:   # 識破時間內只能出識破（不能識破自己出的那張）；識破本身也能被識破，每次重新計時
            if act != "C" or g["pend"]["by"] == i:
                return
            s["hand"].pop(idx)
            g["discard"].append(card)
            tbl_log(t, f"{s['name']} 識破了 {t['seats'][g['pend']['by']]['name']} 的{IT_ACT[g['pend']['a']]}！")
            g["pend"] = {"a": "C", "by": i, "tgt": -1, "sel": None, "until": now + IT_PEND_MS, "under": g["pend"], "ok": []}
            if not g["untimed"]:
                g["deadline"] = max(g["deadline"], now + IT_PEND_MS + 5000)
            it_ok_check(t, now)
            return
        passing = g["step"] == "pass" and L
        mine = g["step"] == "turn" and i == t["turn"]
        tgt, pick = -1, None
        if act in ("P", "S") and (not passing or L["at"] != i or L["kind"] == "pub" or L.get("open")):   # 截閱、調包：蓋著的密函（非公開、沒被調包過）在自己手上時
            return
        if act == "S":
            if type(sel) is not int or not 0 <= sel < len(s["hand"]) or sel == idx:
                return
            pick = s["hand"][sel]
        harm = it_skill_ready(t, i, "harmonizer")   # 調和者「平等」：可以在他人的回合使用鎖定（投遞前或傳遞中）
        if act == "F":                                     # 鎖定：輪到的人（或平等的調和者），投遞前或傳遞中，指定另一位玩家
            tg = msg.get("tgt")
            if (i != t["turn"] and not harm) or g.get("ask") or not ((g["step"] == "turn" and not L and (i == t["turn"] or harm)) or passing) or not it_ok(t, tg) or tg == i or it_locked(g, tg):
                return
            tgt = tg
        if act == "X" and not passing:                    # 焚信：情報傳遞中
            return
        if act == "I" and (not passing or L["at"] == i or L["from"] == i):   # 攔截：別人拿著情報時（不能攔自己發出去的）
            return
        if act in ("H", "V"):                              # 搜身、查驗：自己的回合（局外人「冷眼旁觀」不能被指定）
            tg = msg.get("tgt")
            if not mine or not it_ok(t, tg) or tg == i or it_cold_eye(t, tg):
                return
            tgt = tg
        if act == "W":                                     # 洗白：任何階段，對任何活人情報區裡含黑的情報（tgt＝座位、sel＝他情報區的 idx）
            tg = msg.get("tgt")
            if not it_ok(t, tg) or type(sel) is not int or not 0 <= sel < len(t["seats"][tg]["intel"]) or "K" not in it_cols(t["seats"][tg]["intel"][sel]):
                return
            tgt, pick = tg, t["seats"][tg]["intel"][sel]
        if act == "T":                                     # 轉移：情報在自己面前時，交給另一位（被阻擋的人不行）
            tg = msg.get("tgt")
            if not passing or L["at"] != i or it_locked(g, i) or not it_ok(t, tg) or tg == i or it_blocked(g, tg):
                return
            tgt = tg
        if act == "B":                                     # 阻擋：情報傳遞中（自己或別人的），指定一人
            tg = msg.get("tgt")
            if not passing or not it_ok(t, tg) or it_blocked(g, tg):
                return
            tgt = tg
        if act == "N" and (not mine or L):                 # 無人倖免：自己的回合、發送情報之前
            return
        if act == "D" and (not mine or L):                 # 補給：自己的回合、發送情報之前
            return
        if act == "R":                                     # 竊取：自己的回合，指定另一位玩家（局外人「冷眼旁觀」不能被指定）
            tg = msg.get("tgt")
            if not mine or L or not it_ok(t, tg) or tg == i or it_cold_eye(t, tg):
                return
            tgt = tg
        col = msg.get("col") if act == "P" and msg.get("col") in ("Y", "B", "K") else None   # 截閱：可以宣告一個顏色（宣告就公開）
        if act == "C":   # 識破只能在別人的行動生效前出
            return
        if as_f and msg.get("as") == "F!":   # 死亡預告：不能被識破，直接生效
            s["hand"].pop(idx)
            g["discard"].append(card)
            s["onceUsed"] = True
            tbl_log(t, f"{s['name']}【調和者】調和：把一張直達當作鎖定使用（對 {t['seats'][tgt]['name']}，不能被識破）" if s.get("char") == "harmonizer" else f"{s['name']}【殺手】死亡預告：把一張牌當作鎖定使用（對 {t['seats'][tgt]['name']}，不能被識破）")
            it_lock_apply(t, i, tgt, now)
            it_resolve_end(t, now, i)
            return
        s["hand"].pop(idx)
        g["discard"].append(card)
        g["pend"] = {"a": act, "by": i, "tgt": tgt, "sel": pick, "until": now + IT_PEND_MS, "under": None, "ok": []}
        if g.get("arrive"):
            g["arrive"]["ok"] = []   # 有人出牌：到達確認重來
        if g.get("ack"):
            g["ack"]["ok"] = []      # 收下確認中出牌：確認重來
        if col:
            g["pend"]["col"] = col
        on = f"（對 {t['seats'][tgt]['name']}）" if act in ("F", "H", "V", "R", "W", "T", "B") else f"（對 {t['seats'][L['at']]['name']}）" if act == "I" else f"（宣告{IT_CNAME[col]}色）" if col else ""
        tbl_log(t, s["name"] + ("【殺手】標記目標：把密函當作鎖定" if as_f else " 使用了" + IT_ACT[act]) + on)
        it_ok_check(t, now)   # 不限時：只剩出牌的人自己活著的極端情況，直接生效

def it_leave(t, i, now):
    """遊戲進行中有人離開：翻開身分、手牌丟棄，遊戲繼續；場上只剩一個陣營時結束（無 XP）。"""
    g, s = t["g"], t["seats"][i]
    if g.get("prompt") and g["prompt"]["seat"] == i:   # 他正在做技能選擇：當作不用，先讓流程走完
        it_prompt_done(t, None, now)
        if not t.get("g"):
            return
    g["discard"] += s["hand"]
    s["hand"], s["left"], s["cid"] = [], True, None
    tbl_log(t, f"{s['name']} 離開了（身分：{IT_ROLE[s['role']]}）")
    g["pend"] = None   # 進行中的行動作廢（牌已經丟了）
    q = g.get("ask")
    if q and q["tgt"] == i and q["by"] != i and it_ok(t, q["by"]):   # 被查驗的人離開：照實告知
        it_answer(t, None, now)
    elif q:
        g["ask"] = None
    advance = g["step"] == "turn" and t["turn"] == i
    if g["letter"] and g["letter"]["at"] == i:
        g["discard"].append(g["letter"]["card"])
        g["letter"] = None
        g["arrive"] = None
        advance = True
        tbl_log(t, "他手上的密函作廢")
    if it_check_faction(t, True):
        return
    if g["step"] == "pick":   # 選角中有人離開：剩下的人選完就開始
        it_pick_check(t, now)
        return
    if g.get("chars") and it_char_check(t, i):
        return
    if g["step"] == "ack":   # 不限時：有人離開，剩下的人都按了就繼續
        it_ack_check(t, now)
        return
    if g.get("arrive"):   # 不限時：到達確認中有人離開，剩下的人按完就讓持有者決定
        it_arrive_check(t, now)
    if advance:
        it_end_letter(t, now)

# ---- UNO（第六桌 t6；2026-11-08，使用者要求，名稱沿用 UNO（商標風險由使用者決定）；牌面是原創繪製）：2～6 人、標準 108 張、手牌剩 1 張要喊 UNO ----
# 牌的編碼：顏色字母 RYGB（紅黃綠藍）＋點數 0～9／s（跳過）／r（反轉）／d（+2），例如 R5、Gs；W＝變色牌、F＝變色 +4（沒有顏色）。
# 兩種玩法（桌主＝第一位入座者在開局前選，t["mode"]）：
#   傳統 classic：出牌要同色或同點數（或變色牌）；+4 只能在手上沒有「目前顏色」的牌時出；+2／+4 不可疊加（受罰者直接抽牌並跳過回合）；跳過直接生效；
#     沒牌可出時抽 1 張，抽到的牌能出就可以出、也可以放棄。
#   無限制 wild（使用者定）：① +2／+4 沒有上限：被加牌的人手上有任何 + 牌（+2 或 +4，不看顏色）就可以接著出，累積 pending 張數傳給下一位，沒有 + 牌的人一次抽完累積的張數並跳過；
#     ② 跳過也可以傳遞：被跳過的人手上有跳過牌（不看顏色）可以再出，讓下一位被跳過，沒有（或選擇放棄）就被跳過；
#     ③ 沒牌可出時，抽牌沒有限制：可以一直抽到有牌可出為止；+4 也沒有「手上沒有目前顏色」的限制。
# 共通：出到手牌剩 1 張時要在下一個人動作前喊 UNO（uno），沒喊被別人抓到（catch）罰抽 2 張；先出完手牌的人獲勝。起始牌一律是數字牌。
# 回合限時 UN_TURN_MS，超時由客戶端送 timeout（伺服器核對時鐘）：有累積加牌就吃下、被跳過就放棄、否則抽 1 張並跳過；中途離開的人手牌收回牌堆，遊戲繼續，只剩 1 人時那人獲勝（無 XP）。
UN_COLORS = "RYGB"
UN_TURN_MS = 30000
UN_XP = 5   # 輸贏一樣（使用者定）：每位入座者 +5
UN_MODES = ("classic", "wild")

def un_deck():
    d = []
    for c in UN_COLORS:
        d.append(c + "0")
        for v in "123456789srd":
            d += [c + v, c + v]
    return d + ["W"] * 4 + ["F"] * 4

def un_cname(c):
    return {"R": "紅", "Y": "黃", "G": "綠", "B": "藍"}.get(c, "")

def un_label(card):
    if card == "W":
        return "變色牌"
    if card == "F":
        return "變色 +4"
    return un_cname(card[0]) + {"s": "跳過", "r": "反轉", "d": "+2"}.get(card[1:], card[1:])

def un_is_plus(card):
    return card == "F" or (card not in ("W",) and card[1:] == "d")

def un_is_skip(card):
    return card not in ("W", "F") and card[1:] == "s"

def un_playable(g, hand, card):
    """目前情境下這張牌能不能出（含無限制玩法的累積加牌／跳過傳遞）。"""
    if g["pending"] > 0:   # 無限制：只能接著出 + 牌（不看顏色）傳下去
        return un_is_plus(card)
    if g["skip"]:          # 無限制：被跳過時只能出跳過牌（不看顏色）傳下去
        return un_is_skip(card)
    if card == "W":
        return True
    if card == "F":        # 傳統：+4 只能在手上沒有「目前顏色」的牌時出；無限制沒有這個限制
        return g["mode"] == "wild" or not any(c[0] == g["color"] for c in hand if c not in ("W", "F"))
    return card[0] == g["color"] or card[1:] == g["topval"]

def un_active(t):
    return [i for i, s in enumerate(t["seats"]) if not s.get("left")]

def un_next(t, i, steps=1):
    n, j, moved = len(t["seats"]), i, 0
    while moved < steps:
        j = (j + t["g"]["dir"]) % n
        if not t["seats"][j].get("left"):
            moved += 1
    return j

def un_set_turn(t, i, now):
    t["turn"] = i
    t["g"]["drawn"] = False
    t["g"]["deadline"] = now + UN_TURN_MS

def un_draw_cards(t, i, n):
    g, hand = t["g"], t["seats"][i]["hand"]
    for _ in range(n):
        if not g["deck"]:   # 牌堆空了：把棄牌堆（留最上面那張）洗回去
            top = g["discard"].pop()
            g["deck"], g["discard"] = g["discard"], [top]
            random.shuffle(g["deck"])
        if not g["deck"]:
            break
        hand.append(g["deck"].pop())

def un_has_playable(t, i):
    g, hand = t["g"], t["seats"][i]["hand"]
    return any(un_playable(g, hand, c) for c in hand)

def un_start(t):
    now = int(time.time() * 1000)
    deck = un_deck()
    random.shuffle(deck)
    n = len(t["seats"])
    for s in t["seats"]:
        s["hand"], s["out"], s["ready"], s["left"], s["said"] = [deck.pop() for _ in range(7)], False, False, False, False
    while deck[-1][0] not in UN_COLORS or deck[-1][1:] not in list("0123456789"):   # 起始牌一律是數字牌：功能牌／變色牌放回去重洗
        random.shuffle(deck)
    top = deck.pop()
    mode = t.get("mode") if t.get("mode") in UN_MODES else "classic"
    t["g"] = {"deck": deck, "discard": [top], "color": top[0], "topval": top[1:], "dir": 1, "drawn": False, "pend": -1, "deadline": 0,
              "mode": mode, "pending": 0, "skip": False}   # pending：無限制玩法累積的加牌張數；skip：輪到的人正被跳過、可以傳遞
    t["result"] = None
    t["phase"] = "playing"
    un_set_turn(t, random.randrange(n), now)
    tbl_log(t, f"牌局開始（{'無限制玩法' if mode == 'wild' else '傳統玩法'}）！每人 7 張，起始牌 {un_label(top)}，由 {t['seats'][t['turn']]['name']} 先出")

def un_finish(t, winner, xp):
    name = t["seats"][winner]["name"]
    stay = [s for s in t["seats"] if not s.get("left")]
    win = t["seats"][winner]
    wild = bool(t.get("g") and t["g"].get("mode") == "wild")
    gs = [gs_mk({"w": 1, **({"ww": 1} if wild else {})} if s is win else {}) for s in stay] if xp else None   # ww＝無限制玩法獲勝；有人中途離開（xp＝False）的局不記
    t["result"] = {"winner": winner, "name": name, "text": f"{name} 出完手牌，獲勝！", "rid": random.getrandbits(32), "xp": [UN_XP if xp else 0] * len(stay), "gs": gs}
    tbl_log(t, t["result"]["text"])
    t["seats"] = stay
    tbl_reset_seats(t)
    t["g"] = None

def un_check_last(t):
    """只剩 1 位玩家：那位獲勝（其他人都離開了；無 XP，擋「開了就等別人離開」的刷分）；一個人都不剩就直接清桌。"""
    act = un_active(t)
    if t["phase"] != "playing" or len(act) > 1:
        return False
    if act:
        un_finish(t, act[0], False)
    else:
        t["seats"] = []
        tbl_reset_seats(t)
        t["g"] = None
    return True

def un_pass_on(t, v, now):
    """輪到 v 面對累積加牌／跳過：v 手上沒有能接的牌就直接吃下、換下一位（不用等他按）；有就把決定權交給 v。"""
    g, hand = t["g"], t["seats"][v]["hand"]
    if g["pending"] > 0:
        if any(un_is_plus(c) for c in hand):
            un_set_turn(t, v, now)
            return
        n = g["pending"]
        un_draw_cards(t, v, n)
        g["pending"] = 0
        tbl_log(t, f"{t['seats'][v]['name']} 抽 {n} 張")
        un_set_turn(t, un_next(t, v), now)
    elif g["skip"]:
        if any(un_is_skip(c) for c in hand):
            un_set_turn(t, v, now)
            return
        g["skip"] = False
        tbl_log(t, f"{t['seats'][v]['name']} 被跳過")
        un_set_turn(t, un_next(t, v), now)
    else:
        un_set_turn(t, v, now)

def un_play(t, cid, idx, color, now, say=False):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "uno" or role != "seat" or t["phase"] != "playing" or not g or i != t["turn"]:
        return
    s = t["seats"][i]
    if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < len(s["hand"]):
        return
    if g["drawn"] and idx != len(s["hand"]) - 1:   # 傳統：剛抽的牌只能出那一張（或放棄）
        return
    card = s["hand"][idx]
    if not un_playable(g, s["hand"], card):
        return
    if card in ("W", "F") and (not isinstance(color, str) or len(color) != 1 or color not in UN_COLORS):   # 變色牌要指定四色之一（型別／長度要檢查：None 會出錯、"RY" 會被當成子字串通過）
        return
    wild = g["mode"] == "wild"
    s["hand"].pop(idx)
    g["pend"] = -1   # 輪到下一個人動作了：上一位忘記喊 UNO 的抓不到了
    g["discard"].append(card)
    if card in ("W", "F"):
        g["color"], g["topval"] = color, card
        tbl_log(t, f"{s['name']} 出了 {un_label(card)}，選了{un_cname(color)}色")
    else:
        g["color"], g["topval"] = card[0], card[1:]
        tbl_log(t, f"{s['name']} 出了 {un_label(card)}")
    if not s["hand"]:   # 出完了：獲勝
        un_finish(t, i, True)
        return
    if len(s["hand"]) == 1:
        if s.get("said") or say:   # say＝「出牌並喊 UNO」
            s["said"] = False
            if say:
                tbl_log(t, f"{s['name']} 喊了 UNO！")
        else:
            g["pend"] = i   # 還沒喊 UNO：下一個人動作前，任何人可以抓
    g["skip"] = False
    if un_is_skip(card):    # 跳過
        v = un_next(t, i)
        if wild:
            g["skip"] = True
            un_pass_on(t, v, now)
        else:
            tbl_log(t, f"{t['seats'][v]['name']} 被跳過")
            un_set_turn(t, un_next(t, i, 2), now)
    elif card not in ("W", "F") and card[1:] == "r":   # 反轉（兩人時也是換對方出牌，使用者定）
        g["dir"] = -g["dir"]
        tbl_log(t, "方向反轉")
        un_set_turn(t, un_next(t, i), now)
    elif un_is_plus(card):   # +2／+4
        n = 4 if card == "F" else 2
        v = un_next(t, i)
        if wild:   # 累積：傳給下一位，他有 + 牌就可以接著傳
            g["pending"] += n
            tbl_log(t, f"累積 {g['pending']} 張")
            un_pass_on(t, v, now)
        else:
            un_draw_cards(t, v, n)
            tbl_log(t, f"{t['seats'][v]['name']} 抽 {n} 張")
            un_set_turn(t, un_next(t, i, 2), now)
    else:
        un_set_turn(t, un_next(t, i), now)

def un_draw(t, cid, now):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "uno" or role != "seat" or t["phase"] != "playing" or not g or i != t["turn"]:
        return
    s = t["seats"][i]
    wild = g["mode"] == "wild"
    if wild and g["pending"] > 0:   # 無限制：吃下累積的加牌，被跳過這一回合
        n = g["pending"]
        g["pend"] = -1
        un_draw_cards(t, i, n)
        g["pending"] = 0
        if len(s["hand"]) > 2:
            s["said"] = False
        tbl_log(t, f"{s['name']} 抽 {n} 張")
        un_set_turn(t, un_next(t, i), now)
        return
    if wild and g["skip"]:   # 被跳過要用 pass 放棄，不能抽牌
        return
    if wild:   # 無限制：手上沒有能出的牌時可以一直抽（有能出的牌就不能抽）
        if un_has_playable(t, i):
            return
        g["pend"] = -1
        un_draw_cards(t, i, 1)
        if len(s["hand"]) > 2:
            s["said"] = False
        tbl_log(t, f"{s['name']} 抽了一張牌")
        return
    if g["drawn"]:
        return
    g["pend"] = -1
    un_draw_cards(t, i, 1)
    if len(s["hand"]) > 2:
        s["said"] = False
    card = s["hand"][-1] if s["hand"] else None
    if card and un_playable(g, s["hand"], card):
        g["drawn"] = True   # 抽到的牌能出：可以出、也可以放棄（pass）
        tbl_log(t, f"{s['name']} 抽了一張牌")
    else:
        tbl_log(t, f"{s['name']} 抽了一張牌，沒有可以出的牌")
        un_set_turn(t, un_next(t, i), now)

def un_pass(t, cid, now):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "uno" or role != "seat" or t["phase"] != "playing" or not g or i != t["turn"]:
        return
    s = t["seats"][i]
    if g["mode"] == "wild" and g["skip"]:   # 無限制：接受被跳過
        g["pend"] = -1
        g["skip"] = False
        tbl_log(t, f"{s['name']} 被跳過")
        un_set_turn(t, un_next(t, i), now)
        return
    if g["mode"] == "wild" and g["pending"] == 0 and not g["drawn"] and not un_has_playable(t, i) and not g["deck"] and len(g["discard"]) <= 1:
        g["pend"] = -1   # 牌抽光了、也沒牌可出：只能放棄
        tbl_log(t, f"{s['name']} 沒有牌可出也沒牌可抽，放棄")
        un_set_turn(t, un_next(t, i), now)
        return
    if not g["drawn"]:
        return
    g["pend"] = -1
    tbl_log(t, f"{s['name']} 放棄出牌")
    un_set_turn(t, un_next(t, i), now)

def un_say(t, cid):
    """喊 UNO：剛出到只剩 1 張時（pend）補喊；或手上只剩 1～2 張時先喊好（出到 1 張就不會被抓）。"""
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "uno" or role != "seat" or t["phase"] != "playing" or not g:
        return
    s = t["seats"][i]
    if g["pend"] == i:
        g["pend"] = -1
        tbl_log(t, f"{s['name']} 喊了 UNO！")
    elif len(s["hand"]) <= 2:
        s["said"] = True
        tbl_log(t, f"{s['name']} 喊了 UNO！")

def un_catch(t, cid):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "uno" or role != "seat" or t["phase"] != "playing" or not g or g["pend"] < 0 or g["pend"] == i:
        return
    v = g["pend"]
    g["pend"] = -1
    un_draw_cards(t, v, 2)
    tbl_log(t, f"{t['seats'][i]['name']} 抓到 {t['seats'][v]['name']} 沒喊 UNO，罰抽 2 張")

def un_timeout(t, now):
    """回合限時到了（客戶端送 timeout，伺服器核對時鐘）：有累積加牌就吃下、被跳過就放棄、否則抽 1 張並跳過（剛抽過就直接跳過）。"""
    g = t.get("g")
    if t["game"] != "uno" or t["phase"] != "playing" or not g or now < g["deadline"] - 300:
        return
    i = t["turn"]
    s = t["seats"][i]
    g["pend"] = -1
    if g["pending"] > 0:
        n = g["pending"]
        un_draw_cards(t, i, n)
        g["pending"] = 0
        tbl_log(t, f"{s['name']} 超時，吃下 {n} 張")
    elif g["skip"]:
        g["skip"] = False
        tbl_log(t, f"{s['name']} 超時，被跳過")
    else:
        if not g["drawn"]:
            un_draw_cards(t, i, 1)
        tbl_log(t, f"{s['name']} 超時，自動{'' if g['drawn'] else '抽牌並'}跳過")
    un_set_turn(t, un_next(t, i), now)

def un_leave(t, i, now):
    """遊戲進行中有人離開：手牌收回牌堆，遊戲繼續；只剩 1 人時那人獲勝（無 XP）。"""
    g, s = t["g"], t["seats"][i]
    g["deck"] += s["hand"]
    random.shuffle(g["deck"])
    s["hand"], s["left"], s["cid"] = [], True, None
    tbl_log(t, f"{s['name']} 離開了，手牌收回牌堆")
    if g["pend"] == i:
        g["pend"] = -1
    if un_check_last(t):
        return
    if i == t["turn"]:
        g["pending"], g["skip"] = 0, False   # 正在被加牌／被跳過的人離開：累積的懲罰作廢
        un_set_turn(t, un_next(t, i), now)

def un_set_mode(t, cid, mode):
    """桌主（第一位入座者）在開局前選玩法；換玩法會讓大家的「準備」重來。"""
    role, i = tbl_find(t, cid)
    if t["game"] != "uno" or role != "seat" or i != 0 or t["phase"] != "lobby" or mode not in UN_MODES or t.get("mode", "classic") == mode:
        return
    t["mode"] = mode
    for s in t["seats"]:
        s["ready"] = False
    tbl_log(t, f"{t['seats'][0]['name']} 把玩法改成{'無限制' if mode == 'wild' else '傳統'}")

# ---- 俄羅斯方塊（第十三桌 t13，2026-11-13，使用者要求）：場地上方 4 台街機共用這一張邏輯桌 ----
# 每個座位綁一台機台（cab 0～3；同一台只能坐一個人）。每台都是單人遊玩：
#   單人模式（solo）：各自獨立的一局，結束分數進排行榜；
#   聯機模式（link）：發起的人（host）開邀請，其他機台「閒置中」的人會看到「要接受聯機邀請嗎？」，最多 4 人；
#     host 選「一般模式」（各自玩到全員出局，依分數排名）或「對戰模式」（消 2／3／4 行送每個對手 1／2／4 行垃圾，使用者定），聯機分數不進排行榜。
# 方塊遊戲本身在客戶端跑（信任客戶端，同打字競賽）：伺服器只給 seed／t0、轉發盤面快照（ttb）與垃圾行（tgb）、收結算分數。
# 與 worker/src/index.js 的 ar* 同一套，改規則兩邊一起改。
AR_CABS = 4
AR_COUNTDOWN_MS = 3000          # 聯機開局倒數
AR_SOLO_COUNTDOWN_MS = 1500     # 單人開局倒數
AR_GARBAGE = {2: 1, 3: 2, 4: 4}  # 對戰模式：一次消幾行 → 送每個對手幾行垃圾（使用者定；消 1 行本身不送）


def ar_combo_bonus(c):
    """連擊額外送的垃圾行（2026-11-14 使用者要求）：連擊數 1～2＝0、3～4＝1、5～6＝2、7～8＝3、9～11＝4、12 以上＝5；與 main.js 的 arComboBonus 同一張表。"""
    return 5 if c >= 12 else 4 if c >= 9 else 3 if c >= 7 else 2 if c >= 5 else 1 if c >= 3 else 0
AR_XP, AR_XP_MIN = 4, 10        # 一局消了至少 AR_XP_MIN 行的人 +AR_XP（助手先訂的數值）
AR_SCORE_MAX = 99999999

def ar_seat(t, cab):
    for i, s in enumerate(t["seats"]):
        if s.get("cab") == cab:
            return i, s
    return -1, None

def ar_join(t, cid, name, want, uid, cab):
    """走到第 cab 台：那台空著且想入座就坐那台，否則觀戰；已經在這桌觀戰的人也可以藉此坐上空機台。"""
    role, i = tbl_find(t, cid)
    if role == "seat":
        return
    free = type(cab) is int and 0 <= cab < AR_CABS and ar_seat(t, cab)[1] is None
    if want != "spec" and free:
        if role == "spec":
            t["specs"].pop(i)
        t["seats"].append({"cid": cid, "name": name, "uid": uid, "ready": False, "hand": [], "out": False, "cab": cab,
                           "st": "idle", "sc": 0, "ln": 0, "dead": False, "last": None})
        tbl_log(t, f"{name} 坐上了 {cab + 1} 號機")
    elif role is None:
        t["specs"].append({"cid": cid, "name": name, "uid": uid})
        tbl_log(t, f"{name} 來觀戰")

def ar_playing(t, s):
    g = t.get("g")
    return s["st"] == "solo" or (s["st"] == "link" and g is not None and g["phase"] == "playing")

def ar_link_cancel(t, why):
    for s in t["seats"]:
        if s["st"] == "link":
            s["st"] = "idle"
    t["g"] = None
    tbl_log(t, why)

def ar_check_end(t):
    """聯機進行中：還在場上的成員全部出局（或都離開了）就結算。"""
    g = t.get("g")
    if not g or g["phase"] != "playing":
        return
    mem = [ar_seat(t, c)[1] for c in g["mem"]]
    if any(s is not None and not s["dead"] for s in mem):
        return
    rows = [{"name": s["name"], "uid": s.get("uid"), "score": s["sc"], "lines": s["ln"], "left": False, "cab": s["cab"]} for s in mem if s is not None]
    rows += [dict(x, left=True) for x in g["gone"]]
    rows.sort(key=lambda r: -r["score"])
    xp = [AR_XP if (s["cab"] in g["mem"] and s["ln"] >= AR_XP_MIN) else 0 for s in t["seats"]]
    top = rows[0] if rows else None
    mode = "對戰" if g["mode"] == "battle" else "一般"
    text = f"聯機（{mode}模式）結束！第一名 {top['name']}，{top['score']} 分" if top else "聯機結束"
    gs = [gs_mk({"lw": 1} if top and not top.get("left") and top.get("cab") == s["cab"] and len(rows) >= 2 else {}, {"lines": s["ln"]}) if s["cab"] in g["mem"] else None for s in t["seats"]]   # lw＝聯機獲勝（第一名且至少 2 人）、lines＝單局消行（取最大）；依 t["seats"] 順序（同 xp）
    t["result"] = {"link": True, "mode": g["mode"], "text": text, "rid": random.getrandbits(32), "ranking": rows, "xp": xp, "cabs": list(g["mem"]), "gs": gs}
    for s in t["seats"]:
        if s["st"] == "link":
            s["st"], s["dead"] = "idle", False
    t["g"] = None
    tbl_log(t, text)

def ar_solo_over(t, i):
    s = t["seats"][i]
    s["st"], s["last"] = "idle", {"sc": s["sc"], "ln": s["ln"]}
    xp = [AR_XP if (k == i and s["ln"] >= AR_XP_MIN) else 0 for k in range(len(t["seats"]))]
    text = f"{s['name']}（{s['cab'] + 1} 號機）單人模式結束：{s['sc']} 分、{s['ln']} 行"
    t["result"] = {"solo": True, "cab": s["cab"], "text": text, "rid": random.getrandbits(32), "xp": xp,
                   "ranking": [{"name": s["name"], "uid": s.get("uid"), "score": s["sc"], "lines": s["ln"], "left": False}],
                   "gs": [gs_mk({}, {"best": s["sc"], "lines": s["ln"]}) if k == i else None for k in range(len(t["seats"]))]}   # best＝單人最高分、lines＝單局消行（都取最大）
    tbl_log(t, text)
    if s["sc"] > 0:
        board_record(t, [(s["name"], s["sc"], s.get("uid"))])   # 只有單人模式進排行榜（使用者定）

def ar_leave(t, i):
    """離開機台（Esc、換地形、斷線）：單人局直接作廢（不進排行榜）；聯機中照離開時的分數排名、不中斷其他人。"""
    s = t["seats"].pop(i)
    g = t.get("g")
    if s["st"] == "link" and g:
        if g["phase"] == "invite":
            if g["host"] == s["cab"]:
                ar_link_cancel(t, f"{s['name']} 離開了，聯機邀請取消")
            else:
                g["mem"].remove(s["cab"])
                tbl_log(t, f"{s['name']} 離開了聯機")
        else:
            g["mem"].remove(s["cab"])
            g["gone"].append({"name": s["name"], "uid": s.get("uid"), "score": s["sc"], "lines": s["ln"], "cab": s["cab"]})
            tbl_log(t, f"{s['name']} 離開了聯機（{s['sc']} 分）")
            ar_check_end(t)
    else:
        if g and s["cab"] in g["no"]:
            g["no"].remove(s["cab"])
        tbl_log(t, f"{s['name']} 離開了 {s['cab'] + 1} 號機")

def _int_in(v, lo, hi):
    return type(v) is int and lo <= v <= hi

def ar_msg(t, cid, msg, now):
    """回 (畫面有變要通知, 額外要送的訊息 [(cid, msg)])。"""
    role, i = tbl_find(t, cid)
    a = msg.get("a")
    if t["game"] != "arcade" or role != "seat":
        return False, []
    s, g = t["seats"][i], t.get("g")
    if a == "solo":
        if s["st"] != "idle":
            return False, []
        s.update(st="solo", sc=0, ln=0, dead=False, seed=random.getrandbits(31), t0=now + AR_SOLO_COUNTDOWN_MS)
        if g and s["cab"] in g["no"]:
            g["no"].remove(s["cab"])
        tbl_log(t, f"{s['name']} 開始了單人模式")
        return True, []
    if a == "link":   # 發起聯機邀請（同時只能有一場聯機）
        if s["st"] != "idle" or g:
            return False, []
        t["g"] = {"host": s["cab"], "mode": "normal", "phase": "invite", "mem": [s["cab"]], "no": [], "gone": []}
        s["st"] = "link"
        tbl_log(t, f"{s['name']} 發起了聯機邀請")
        return True, []
    if a == "lmode":
        if g and g["phase"] == "invite" and g["host"] == s["cab"] and msg.get("v") in ("normal", "battle") and g["mode"] != msg.get("v"):
            g["mode"] = msg.get("v")
            tbl_log(t, f"聯機改成{'對戰' if g['mode'] == 'battle' else '一般'}模式")
            return True, []
        return False, []
    if a == "ljoin":
        if g and g["phase"] == "invite" and s["st"] == "idle" and len(g["mem"]) < AR_CABS:
            g["mem"].append(s["cab"])
            if s["cab"] in g["no"]:
                g["no"].remove(s["cab"])
            s["st"] = "link"
            tbl_log(t, f"{s['name']} 接受了聯機邀請")
            return True, []
        return False, []
    if a == "lno":
        if g and g["phase"] == "invite" and s["st"] == "idle" and s["cab"] not in g["no"]:
            g["no"].append(s["cab"])
            return True, []
        return False, []
    if a == "lquit":   # 聯機等待中退出（host 退出＝取消邀請）
        if g and g["phase"] == "invite" and s["st"] == "link":
            if g["host"] == s["cab"]:
                ar_link_cancel(t, f"{s['name']} 取消了聯機邀請")
            else:
                g["mem"].remove(s["cab"])
                s["st"] = "idle"
                tbl_log(t, f"{s['name']} 退出了聯機")
            return True, []
        return False, []
    if a == "lstart":
        if g and g["phase"] == "invite" and g["host"] == s["cab"] and len(g["mem"]) >= 2:
            g.update(phase="playing", seed=random.getrandbits(31), t0=now + AR_COUNTDOWN_MS, no=[])
            for c in g["mem"]:
                ar_seat(t, c)[1].update(sc=0, ln=0, dead=False)
            t["result"] = None
            tbl_log(t, f"聯機開始！{len(g['mem'])} 人，{'對戰' if g['mode'] == 'battle' else '一般'}模式")
            return True, []
        return False, []
    if a == "clr":   # 一次消了 n 行：對戰模式送其他還活著的成員垃圾行
        n = msg.get("n")
        if not (_int_in(n, 1, 4) and s["st"] == "link" and g and g["phase"] == "playing" and g["mode"] == "battle" and not s["dead"] and now >= g["t0"]):
            return False, []
        combo = msg.get("combo")
        combo = combo if _int_in(combo, 0, 1000) else 0   # 舊版客戶端沒帶 combo＝0
        k = AR_GARBAGE.get(n, 0) + ar_combo_bonus(combo)
        out = []
        if k:
            for c in g["mem"]:
                m = ar_seat(t, c)[1]
                if m is not None and c != s["cab"] and not m["dead"] and m["cid"] is not None:
                    out.append((m["cid"], {"t": "tgb", "n": k, "from": s["cab"]}))
        return False, out
    if a == "tb":   # 盤面快照：轉發給觀戰者與同一場聯機的其他成員（不通知整個畫面）
        b, sc, ln = msg.get("b"), msg.get("sc"), msg.get("ln")
        if not (ar_playing(t, s) and not s["dead"] and type(b) is str and len(b) == 200 and all(ch in "012345678" for ch in b)
                and _int_in(sc, 0, AR_SCORE_MAX) and _int_in(ln, 0, 100000)):
            return False, []
        s["sc"], s["ln"] = sc, ln
        data = {"t": "ttb", "cab": s["cab"], "b": b, "sc": sc, "ln": ln}
        out = [(m["cid"], data) for m in t["specs"] if m["cid"] is not None]
        if s["st"] == "link":
            for c in g["mem"]:
                m = ar_seat(t, c)[1]
                if m is not None and c != s["cab"] and m["cid"] is not None:
                    out.append((m["cid"], data))
        return False, out
    if a == "over":   # 這局結束（方塊頂到最上面）：回報最後分數
        sc, ln = msg.get("sc"), msg.get("ln")
        if not (ar_playing(t, s) and not s["dead"] and _int_in(sc, 0, AR_SCORE_MAX) and _int_in(ln, 0, 100000)):
            return False, []
        s["sc"], s["ln"] = sc, ln
        if s["st"] == "solo":
            ar_solo_over(t, i)
        else:
            s["dead"] = True
            tbl_log(t, f"{s['name']} 出局了（{sc} 分）")
            ar_check_end(t)
        return True, []
    return False, []

def ar_view(t, cid, v):
    role, i = tbl_find(t, cid)
    g = t.get("g")
    me = t["seats"][i] if role == "seat" else None
    v["phase"] = "playing" if me is not None and ar_playing(t, me) else "lobby"
    v["cab"] = me["cab"] if me is not None else -1
    v["sn"] = int(time.time() * 1000)
    for k, s in enumerate(t["seats"]):
        v["seats"][k].update(cab=s["cab"], st=s["st"], sc=s["sc"], ln=s["ln"], dead=s["dead"], last=s.get("last"), play=ar_playing(t, s))
    if me is not None and me["st"] == "solo":
        v["tt"] = {"seed": me["seed"], "t0": me["t0"]}
    v["link"] = None if not g else {"host": g["host"], "mode": g["mode"], "phase": g["phase"], "mem": list(g["mem"]), "no": list(g["no"]),
                                    "seed": g.get("seed"), "t0": g.get("t0"), "gone": [dict(x) for x in g["gone"]]}
    return v

def ar_info(t):
    """tblinfo 多帶：每台機台的狀態（島上機台頭上的標籤）、是否有人在等聯機、哪些連線在遊戲中（名牌〔遊戲中〕）。"""
    g = t.get("g")
    cabs = [None] * AR_CABS
    for s in t["seats"]:
        st = s["st"] if s["st"] != "link" else ("link" if g and g["phase"] == "playing" else "inv")
        cabs[s["cab"]] = {"n": s["name"], "st": st}
    return {"cabs": cabs, "inv": bool(g and g["phase"] == "invite" and len(g["mem"]) < AR_CABS),
            "playing": [s["cid"] for s in t["seats"] if ar_playing(t, s)]}

# ---- 豆豆迷宮（吃豆迷宮類；第十四桌 t14，2026-11-13，使用者要求）：1～5 人，一人當豆豆、其他人當幽靈 ----
# 1 人＝單人模式：自己當豆豆、對 4 隻電腦幽靈，一關接一關到命用完，分數進排行榜（使用者定）；
# 2～5 人＝對抗：桌主（第一位入座的人）在開局前指定誰當豆豆（預設自己，使用者定），其他人依序當幽靈、空的幽靈由電腦控制；
#   豆子吃光＝豆豆方贏，3 條命用完（或時間到）＝幽靈方贏，不進排行榜。進行中幽靈離開改由電腦控制、豆豆離開＝幽靈方贏。
# 遊戲本身在客戶端跑：豆豆那台是權威，伺服器只轉發豆豆的快照（ms → tms）與幽靈玩家的位置（mp → tmp），並收結算（over）。
# 與 worker/src/index.js 的 mz* 同一套，改規則兩邊一起改。
MZ_GHOSTS = 4
MZ_COUNTDOWN_MS, MZ_SOLO_COUNTDOWN_MS = 3000, 1500
MZ_VS_MS = 240000              # 對抗一局的時間上限（豆豆那台到時間就結算；伺服器多等 20 秒還沒結算就自己結）
MZ_XP, MZ_XP_MIN = 4, 3000     # 單人 ≥ MZ_XP_MIN 分、對抗贏的那一方 +MZ_XP（助手先訂的數值）
MZ_SCORE_MAX = 99999999
_MZ_HEX = re.compile(r"^[0-9a-f]{1,120}$")

def _mz_int(v, lo, hi):
    return type(v) is int and lo <= v <= hi

def mz_pac_idx(t):
    pc = t.get("pac_cid")
    for i, s in enumerate(t["seats"]):
        if s["cid"] is not None and s["cid"] == pc:
            return i
    return 0

def mz_set_pac(t, cid, v):
    """桌主在開局前指定誰當豆豆；改了大家要重新準備。"""
    role, i = tbl_find(t, cid)
    if t["game"] != "maze" or role != "seat" or i != 0 or t["phase"] != "lobby" or not _mz_int(v, 0, len(t["seats"]) - 1) or mz_pac_idx(t) == v:
        return
    t["pac_cid"] = t["seats"][v]["cid"]
    for s in t["seats"]:
        s["ready"] = False
    tbl_log(t, f"{t['seats'][0]['name']} 指定 {t['seats'][v]['name']} 當豆豆")

def mz_start(t):
    now = int(time.time() * 1000)
    n, pac = len(t["seats"]), mz_pac_idx(t)
    gh = [k for k in range(n) if k != pac][:MZ_GHOSTS]
    gh += [-1] * (MZ_GHOSTS - len(gh))
    t["g"] = {"seed": random.getrandbits(31), "t0": now + (MZ_SOLO_COUNTDOWN_MS if n == 1 else MZ_COUNTDOWN_MS), "pac": pac, "gh": gh, "solo": n == 1}
    t["result"], t["phase"] = None, "playing"
    for s in t["seats"]:
        s.update(ready=False, left=False, sc=0, lvl=1)
    tbl_log(t, f"{t['seats'][0]['name']} 開始挑戰（單人）" if n == 1 else f"對抗開始！{t['seats'][pac]['name']} 當豆豆，{n - 1} 人當幽靈")

def mz_finish(t, win, why, ct=None):
    g = t.get("g")
    if not g:
        return
    stay = [s for s in t["seats"] if not s.get("left")]
    pac_seat = t["seats"][g["pac"]]
    if g["solo"]:
        s = t["seats"][0]
        if s.get("left"):
            t["result"] = {"aborted": True, "text": f"{s['name']} 離開了，這一局不算"}
        else:
            t["result"] = {"solo": True, "text": f"挑戰結束！{s['name']} {s['sc']} 分（第 {s['lvl']} 關）", "rid": random.getrandbits(32),
                           "ranking": [{"name": s["name"], "uid": s.get("uid"), "score": s["sc"], "lvl": s["lvl"], "left": False}],
                           "xp": [MZ_XP if x["sc"] >= MZ_XP_MIN else 0 for x in stay],
                           "gs": [gs_mk({}, {"best": x["sc"], "lvl": x["lvl"]}) for x in stay]}   # best＝單人最高分、lvl＝抵達的關卡（都取最大）
            if s["sc"] > 0:
                board_record(t, [(s["name"], s["sc"], s.get("uid"))])   # 只有單人模式進排行榜（使用者定）
    else:
        ranking = []
        for k, s in enumerate(t["seats"]):
            gk = g["gh"].index(k) if k in g["gh"] else -1
            ranking.append({"name": s["name"], "uid": s.get("uid"), "role": "pac" if k == g["pac"] else "ghost",
                            "score": s["sc"] if k == g["pac"] else (ct[gk] if ct and gk >= 0 else 0), "left": bool(s.get("left"))})
        ranking.sort(key=lambda r: 0 if r["role"] == "pac" else 1)
        xp = [MZ_XP if ((s is pac_seat) == (win == "pac")) else 0 for s in stay]   # 中途離開的人不給 XP；依「留下來的座位」順序
        gs = [gs_mk({"w": 1, **({"wp": 1} if s is pac_seat else {"wg": 1})} if ((s is pac_seat) == (win == "pac")) else {}) for s in stay]   # w＝對抗獲勝、wp／wg＝以豆豆／幽靈方獲勝
        t["result"] = {"win": win, "text": f"{'豆豆方獲勝' if win == 'pac' else '幽靈方獲勝'}！（{why}）", "rid": random.getrandbits(32), "ranking": ranking, "xp": xp, "gs": gs}
    tbl_log(t, t["result"]["text"])
    t["seats"] = stay
    tbl_reset_seats(t)
    t["g"] = None

def mz_tick(t, now):
    """豆豆那台當掉、沒回報結算：對抗的時間上限過了 20 秒，伺服器自己結（幽靈方贏）。"""
    g = t.get("g")
    if t["game"] == "maze" and t["phase"] == "playing" and g and not g["solo"] and now > g["t0"] + MZ_VS_MS + 20000:
        mz_finish(t, "ghost", "時間到")
        return True
    return False

def mz_leave(t, i):
    """遊戲進行中有人離開：幽靈→改由電腦控制，遊戲繼續；豆豆→幽靈方贏（單人＝這局不算）。"""
    s, g = t["seats"][i], t["g"]
    s["left"], s["cid"] = True, None
    if i == g["pac"]:
        mz_finish(t, "ghost", f"{s['name']}（豆豆）離開了")
        return
    if i in g["gh"]:
        g["gh"][g["gh"].index(i)] = -1
    tbl_log(t, f"{s['name']} 離開了，那隻幽靈改由電腦控制")

def mz_snap(msg):
    """豆豆的快照檢查（欄位見 worker 的 mzSnap）；不合法回 None。"""
    p, g, d = msg.get("p"), msg.get("g"), msg.get("d")
    def pt(v):
        return isinstance(v, list) and len(v) >= 3 and _mz_int(v[0], -20, 400) and _mz_int(v[1], -20, 400) and _mz_int(v[2], -1, 3)
    if not pt(p) or not isinstance(g, list) or len(g) != MZ_GHOSTS or not all(pt(x) and len(x) >= 4 and _mz_int(x[3], 0, 3) for x in g):
        return None
    if not isinstance(d, str) or not _MZ_HEX.match(d):
        return None
    for k, lo, hi in (("pw", 0, 60000), ("sc", 0, MZ_SCORE_MAX), ("lv", 0, 9), ("lvl", 1, 999), ("rs", 0, 100000), ("fz", 0, 10000), ("bn", 0, 1)):
        if not _mz_int(msg.get(k), lo, hi):
            return None
    return {"p": p[:3], "g": [x[:4] for x in g], "d": d, "pw": msg["pw"], "sc": msg["sc"], "lv": msg["lv"], "lvl": msg["lvl"], "rs": msg["rs"], "fz": msg["fz"], "bn": msg["bn"]}

def mz_relay(t, cid, msg):
    """快照／幽靈位置：回要轉發的 [(cid, msg)]（給同桌其他人與觀戰者）。"""
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "maze" or role != "seat" or t["phase"] != "playing" or not g:
        return []
    data = None
    if msg.get("a") == "ms" and i == g["pac"]:
        d = mz_snap(msg)
        if d is None:
            return []
        t["seats"][i]["sc"], t["seats"][i]["lvl"] = d["sc"], d["lvl"]
        data = dict(t="tms", i=i, **d)
    elif msg.get("a") == "mp" and i in g["gh"]:
        x, y, dd, m = msg.get("x"), msg.get("y"), msg.get("d"), msg.get("m")
        if not (_mz_int(x, -20, 400) and _mz_int(y, -20, 400) and _mz_int(dd, -1, 3) and _mz_int(m, 0, 3)):
            return []
        data = {"t": "tmp", "i": i, "k": g["gh"].index(i), "x": x, "y": y, "d": dd, "m": m}
    if data is None:
        return []
    return [(m["cid"], data) for m in t["seats"] + t["specs"] if m["cid"] is not None and m["cid"] != cid]

def mz_over(t, cid, msg):
    """豆豆那台回報結束：單人＝命用完（帶 lvl）；對抗＝win（豆子吃光）或沒有（命用完／tu 時間到），ct＝各幽靈位置抓到幾次。"""
    role, i = tbl_find(t, cid)
    g = t.get("g")
    sc = msg.get("sc")
    if t["game"] != "maze" or role != "seat" or t["phase"] != "playing" or not g or i != g["pac"] or not _mz_int(sc, 0, MZ_SCORE_MAX):
        return
    s = t["seats"][i]
    s["sc"] = sc
    if g["solo"]:
        if _mz_int(msg.get("lvl"), 1, 999):
            s["lvl"] = msg["lvl"]
        mz_finish(t, None, "命用完了")
        return
    ct = msg.get("ct")
    ct = ct if isinstance(ct, list) and len(ct) == MZ_GHOSTS and all(_mz_int(x, 0, 99) for x in ct) else None
    win = msg.get("win") is True
    mz_finish(t, "pac" if win else "ghost", "豆子全部吃光" if win else ("時間到" if msg.get("tu") is True else "豆豆的命用完了"), ct)

# ---- 空氣曲棍球（第十五、十六桌 t15／t16，2026-11-13，使用者要求）：2～8 人分藍紅兩隊（座位 0、2、4、6 藍隊，1、3、5、7 紅隊），人數要偶數 ----
# 先得 HK_GOALS 分、或 HK_LIM_MS 到時分數高的隊伍贏（同分平手），不進排行榜；有人離開＝這一局結束（一般桌子的規則）。
# 物理在桌主（座位 0）的客戶端跑：桌主送圓盤快照 hs → ths，每個人送自己握把的位置 hp → thp，桌主判斷結束送 hend。
# 與 worker/src/index.js 的 hk* 同一套，改規則兩邊一起改。
HK_W, HK_H, HK_GOALS, HK_LIM_MS, HK_COUNTDOWN_MS, HK_XP = 640, 320, 7, 180000, 3000, 3

def _hk_num(v, lo, hi):
    return type(v) in (int, float) and not isinstance(v, bool) and math.isfinite(v) and lo <= v <= hi

def _hk_score(v):
    return type(v) is int and 0 <= v <= 99

def hk_start(t):
    if len(t["seats"]) % 2:   # 人數要偶數（全員準備了也不開始，畫面會提示）
        return
    now = int(time.time() * 1000)
    t["g"] = {"seed": random.getrandbits(31), "t0": now + HK_COUNTDOWN_MS, "sa": 0, "sb": 0}
    t["result"], t["phase"] = None, "playing"
    for s in t["seats"]:
        s["ready"] = False
    tbl_log(t, f"比賽開始！{len(t['seats']) // 2} 對 {len(t['seats']) // 2}")

def hk_finish(t, sa, sb, why):
    win = 0 if sa > sb else 1 if sb > sa else -1
    text = f"藍隊 {sa} : {sb} 紅隊，{'平手' if win < 0 else '藍隊獲勝' if win == 0 else '紅隊獲勝'}！" + (f"（{why}）" if why else "")
    t["result"] = {"text": text, "sa": sa, "sb": sb, "win": win, "rid": random.getrandbits(32),
                   "ranking": [{"name": s["name"], "uid": s.get("uid"), "team": i % 2, "left": False} for i, s in enumerate(t["seats"])],
                   "xp": [HK_XP if i % 2 == win else 0 for i in range(len(t["seats"]))],
                   "gs": [gs_mk({"w": 1} if i % 2 == win else {}) for i in range(len(t["seats"]))]}   # w＝獲勝（平手沒人記）
    tbl_log(t, text)
    tbl_reset_seats(t)

def hk_tick(t, now):
    """桌主那台當掉沒回報：時間上限過了 20 秒，伺服器照最後的比分結算。"""
    g = t.get("g")
    if t["game"] == "hockey" and t["phase"] == "playing" and g and now > g["t0"] + HK_LIM_MS + 20000:
        hk_finish(t, g["sa"], g["sb"], "時間到")
        return True
    return False

def hk_relay(t, cid, msg):
    """握把位置／圓盤快照：回要轉發的 [(cid, msg)]（給同桌其他人與觀戰者）。"""
    role, i = tbl_find(t, cid)
    g = t.get("g")
    if t["game"] != "hockey" or role != "seat" or t["phase"] != "playing" or not g:
        return []
    data = None
    if msg.get("a") == "hp":
        x, y = msg.get("x"), msg.get("y")
        if not (_hk_num(x, 0, HK_W) and _hk_num(y, 0, HK_H)):
            return []
        data = {"t": "thp", "i": i, "x": round(x), "y": round(y)}
    elif msg.get("a") == "hs" and i == 0:
        x, y, vx, vy, sa, sb, f = (msg.get(k) for k in ("x", "y", "vx", "vy", "sa", "sb", "f"))
        if not (_hk_num(x, -60, HK_W + 60) and _hk_num(y, -60, HK_H + 60) and _hk_num(vx, -3000, 3000) and _hk_num(vy, -3000, 3000)
                and _hk_score(sa) and _hk_score(sb) and _hk_num(f, 0, 5000)):
            return []
        g["sa"], g["sb"] = sa, sb
        data = {"t": "ths", "x": round(x), "y": round(y), "vx": round(vx), "vy": round(vy), "sa": sa, "sb": sb, "f": round(f)}
    if data is None:
        return []
    to = [m for m in t["seats"] + t["specs"] if m["cid"] is not None and m["cid"] != cid]
    out = [(m["cid"], data) for m in to]
    px, py = msg.get("px"), msg.get("py")
    if msg.get("a") == "hs" and _hk_num(px, 0, HK_W) and _hk_num(py, 0, HK_H):   # 桌主自己的握把位置也夾在快照裡（hp 與 hs 共用限流，分開送會被吃掉）
        pd = {"t": "thp", "i": 0, "x": round(px), "y": round(py)}
        out += [(m["cid"], pd) for m in to]
    return out

def hk_end(t, cid, msg):
    """桌主那台回報結束（有一隊到 HK_GOALS 分，或時間到）。"""
    role, i = tbl_find(t, cid)
    if t["game"] != "hockey" or role != "seat" or i != 0 or t["phase"] != "playing" or not t.get("g"):
        return
    sa, sb = msg.get("sa"), msg.get("sb")
    if not (_hk_score(sa) and _hk_score(sb)):
        return
    hk_finish(t, sa, sb, "" if sa >= HK_GOALS or sb >= HK_GOALS else "時間到")

GAME_START = {"arcade": lambda t: None, "maze": mz_start, "hockey": hk_start, "oldmaid": om_start, "gomoku": gm_start, "dodge": dg_start, "uno": un_start, "typing": ty_start, "zhtyping": ty_start, "intel": it_start, "mage": mg_start, "blokus": bk_start, "trigon": tg_start}   # 遊戲 → 開局函式（tbl_ready 全員準備時呼叫）

def tbl_view(t, cid):
    """給某條連線看的版本：自己的手牌完整，別人只有張數。"""
    role, i = tbl_find(t, cid)
    mn, mx = GAME_LIMITS[t["game"]]
    playing = t["phase"] == "playing"
    seats = [{"name": s["name"], "n": len(s["hand"]) if playing else 0, "ready": s["ready"], "out": s["out"] if playing else False,
              "you": role == "seat" and k == i} for k, s in enumerate(t["seats"])]
    v = {"id": t["id"], "game": t["game"], "phase": t["phase"], "min": mn, "max": mx, "role": role,
         "me": i if role == "seat" else -1, "seats": seats, "specs": len(t["specs"]),
         "board": list(BOARDS.get(t["game"], [])) if t["game"] in BOARD_GAMES else None,
         "turn": t["turn"] if playing else -1, "target": tbl_next_active(t, t["turn"]) if playing else -1,
         "result": t["result"], "log": list(t["log"])}
    g = t.get("g")
    if t["game"] == "dodge":   # 躲彈幕：每個座位的命數／淘汰秒數／是否已離開；進行中附上 seed 與開始時間（彈幕由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
        for k, s in enumerate(t["seats"]):
            seats[k].update(lives=s.get("lives", 0), died=s.get("died"), left=bool(s.get("left")), bonus=s.get("bonus", 0))
        if g and playing:
            v["dg"] = {"seed": g["seed"], "t0": g["t0"], "dur": DG_DUR, "sn": int(time.time() * 1000), "n": g["n"], "taken": list(g["taken"]), "fx": list(g["fx"])}
    elif t["game"] == "hockey":   # 空氣曲棍球：進行中附上 seed、開始時間、伺服器時間、時間上限、目標分數
        if g and playing:
            v["hk"] = {"seed": g["seed"], "t0": g["t0"], "sn": int(time.time() * 1000), "lim": HK_LIM_MS, "goals": HK_GOALS}
    elif t["game"] == "maze":   # 豆豆迷宮：誰當豆豆（開局前＝桌主指定的人）、分數／關卡／離開；進行中附上 seed、開始時間、伺服器時間、幽靈位置分配
        v["pac"] = g["pac"] if (g and playing) else mz_pac_idx(t)
        for k, s in enumerate(t["seats"]):
            seats[k].update(sc=s.get("sc", 0), lvl=s.get("lvl", 1), left=bool(s.get("left")))
        if g and playing:
            v["mz"] = {"seed": g["seed"], "t0": g["t0"], "sn": int(time.time() * 1000), "pac": g["pac"], "gh": list(g["gh"]), "solo": g["solo"], "lim": MZ_VS_MS}
    elif t["game"] == "mage":   # 見習驅魔師：血量／擊殺數／倒下／離開；進行中附上 seed、難度、人數、已擊殺的幽靈編號、Boss 血量與被打中的次數
        v["diff"] = t.get("diff", 0)
        for k, s in enumerate(t["seats"]):
            seats[k].update(hp=max(0, s.get("hp", 0)), syms=s.get("syms", 0), dead=bool(s.get("dead")), left=bool(s.get("left")))
        if g and playing:
            v["mg"] = {"seed": g["seed"], "t0": g["t0"], "sn": int(time.time() * 1000), "diff": g["diff"], "n": g["n"], "killed": [int(x) for x in g["killed"]],
                       "prog": [[int(x), y] for x, y in g["prog"].items()],
                       "boss": g["boss"], "dmg": g["dmg"], "hits": g["hits"]}
    elif ty_is(t):   # 英打／中文打字競賽：每個座位的分數／是否已離開；進行中附上 seed 與開始時間（題目由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
        for k, s in enumerate(t["seats"]):
            seats[k].update(score=s.get("score", 0), left=bool(s.get("left")))
        if g and playing:
            v["ty"] = {"seed": g["seed"], "t0": g["t0"], "dur": TY_DUR, "sn": int(time.time() * 1000)}
    elif t["game"] == "intel":   # 秘藥情報戰：情報區公開；身分只給本人、已出局／離開的人、觀戰者（使用者定：觀戰者看得到全部資訊）
        see_all = role == "spec"
        for k, s in enumerate(t["seats"]):
            seats[k]["intel"] = list(s.get("intel") or []) if playing else []
            seats[k]["left"] = bool(s.get("left"))
            if playing and (see_all or s.get("out") or s.get("left") or s.get("exposed") or (role == "seat" and k == i)):   # exposed：被解藥師「公開」暴露的陣營
                seats[k]["role"] = s.get("role")
            if playing and g and g.get("chars"):   # 角色卡：公開型選完就翻開；隱藏型只有本人與觀戰者看得到；選角中只看得到「選好了沒」
                seats[k]["picked"], seats[k]["up"] = bool(s.get("char")), bool(s.get("faceUp"))
                if s.get("char") and (see_all or s.get("faceUp") or (role == "seat" and k == i)):
                    seats[k]["char"] = s["char"]
                if role == "seat" and k == i and s.get("choices"):
                    v["choices"] = list(s["choices"])
                if see_all and s.get("choices"):
                    seats[k]["choices"] = list(s["choices"])
        if playing and g:
            L = g["letter"]
            v["it"] = {"step": g["step"], "deck": len(g["deck"]), "discard": len(g["discard"]), "deadline": g["deadline"], "sn": int(time.time() * 1000),
                       "untimed": bool(g["untimed"]), "blocked": list(g.get("blocked", [])), "locked": list(g.get("locked") or []), "arrive": {"at": L["at"], "ok": list(g["arrive"]["ok"])} if g.get("arrive") and L else None, "ack": {"by": g["ack"]["by"], "ok": list(g["ack"]["ok"])} if g.get("ack") else None,
                       "letter": {"from": L["from"], "at": L["at"], "seen": list(L["seen"]), "kind": L["kind"], "open": bool(L.get("open")), "next": it_fwd_target(t, L), "icpt": L.get("icpt")} if L else None,
                       "pend": {"a": g["pend"]["a"], "by": g["pend"]["by"], "tgt": g["pend"]["tgt"], "until": g["pend"]["until"], "ok": list(g["pend"]["ok"]), "chain": it_chain(g["pend"])} if g["pend"] else None}
            v["it"]["ask"] = {"by": g["ask"]["by"], "tgt": g["ask"]["tgt"]} if g.get("ask") else None   # 等誰回答查驗
            v["it"]["chars"] = bool(g.get("chars"))
            v["it"]["deaths"] = [{"seat": d["seat"]} for d in g["deaths"]]   # 出局順序（公開）
            pr = g.get("prompt")
            v["it"]["prompt"] = {"kind": pr["kind"], "seat": pr["seat"], "until": pr["until"]} if pr else None   # 等誰做技能決定
            if role == "seat" and pr and pr["seat"] == i:
                v["prompt"] = it_prompt_data(t, pr)
            if g.get("chars"):
                for k, x in enumerate(t["seats"]):
                    if x.get("char"):
                        seats[k]["used"] = bool(x.get("onceUsed"))   # 一局一次的技能用過沒（公開）
                if role == "seat":
                    v["aimed"] = t["seats"][i].get("aimTurn") == g.get("turnNo")   # 狙擊手「瞄準」這回合用過了
                    v["shot"] = t["seats"][i].get("shotTurn") == g.get("turnNo")   # 狙擊手「亂槍打鳥」這回合用過了
                if role == "seat" and it_skill_ready(t, i, "doubleagent") and not t["seats"][i].get("onceUsed"):
                    v["deckDouble"] = list(dict.fromkeys(c for c in g["deck"] if len(it_cols(c)) == 2))   # 雙面人生可以找的雙色牌
            ex = it_ext_of(g, False)
            v["it"]["ext"] = {"by": list(ex["by"]), "skip": list(ex["skip"])} if ex else None   # 目前這段倒數的加時（誰按了、誰跳過了）
            for k, s in enumerate(t["seats"]):
                seats[k]["ext"] = s.get("extLeft", 0)   # 每人本局還剩幾次加時
            if L and (see_all or L["kind"] == "pub" or L.get("open")):
                v["it"]["letter"]["card"] = L["card"]          # 觀戰者：看得到密函；公開情報：所有人都看得到
            elif L and role == "seat" and L["from"] == i:
                v["it"]["letter"]["card"] = L["orig"]          # 投遞的人：只知道自己送出的是哪張（被調包了也不知道）
            if role == "seat":
                v["hand"] = list(t["seats"][i]["hand"])
                v["note"] = t["seats"][i].get("note")
                v["stolen"] = t["seats"][i].get("stolen")
            if see_all:
                v["hands"] = [list(s["hand"]) for s in t["seats"]]
    elif g and t["game"] == "trigon":   # Blokus Trigon：棋盤（702 個字元：0 空／1～4 顏色，格子編號 y * 39 + x）、各座位顏色、每人用掉的方塊、最後一手、期限；全部公開
        v["tg"] = {"board": "".join(str(c) for c in g["board"]), "col": list(g["col"]), "corner": list(g["corner"]), "used": [list(d["used"]) for d in g["sd"]], "done": [d["done"] for d in g["sd"]],
                   "last": g["last"], "moves": g["moves"], "deadline": g["deadline"] if playing else 0, "sn": int(time.time() * 1000)}
        if playing:
            for k, s in enumerate(t["seats"]):
                v["seats"][k]["left"] = bool(s.get("left"))
                v["seats"][k]["rem"] = tg_rem(g, k)
    elif g and t["game"] == "blokus":   # Blokus：棋盤（400 個字元：0 空／1～4 顏色）、各座位顏色、每人用掉的方塊、最後一手、期限（sn＝伺服器現在時間，客戶端對時用）；全部公開
        v["bk"] = {"size": bk_size(g), "start": [list(bk_start_of(g, k)) for k in range(len(g["col"]))], "board": "".join(str(c) for c in g["board"]), "col": list(g["col"]), "used": [list(d["used"]) for d in g["sd"]], "done": [d["done"] for d in g["sd"]],
                   "last": g["last"], "moves": g["moves"], "deadline": g["deadline"] if playing else 0, "sn": int(time.time() * 1000)}
        if playing:
            for k, s in enumerate(t["seats"]):
                v["seats"][k]["left"] = bool(s.get("left"))
                v["seats"][k]["rem"] = bk_rem(g, k)
    elif g and t["game"] == "gomoku":   # 五子棋：棋盤（225 個字元：0 空／1 黑／2 白）、最後一手、執黑的座位、連線的五子（結束時）；棋盤公開，觀戰者也看得到
        v["board"] = "".join(str(c) for c in g["board"])
        v["last"], v["black"], v["line"], v["moves"] = g["last"], g["black"], g["line"], g["moves"]   # moves：每一手的座標（偶數手＝黑棋）；結束後客戶端用來復盤
    if t["game"] == "intel":
        v["untimed"] = bool(t.get("untimed"))   # 模式（桌主在開局前選）：限時／不限時
        v["chars"] = bool(t.get("chars"))       # 角色卡模式（桌主在開局前選）
    if t["game"] == "uno":
        v["mode"] = t.get("mode", "classic")   # 玩法（桌主在開局前選）：classic 傳統／wild 無限制
    if t["game"] == "uno" and playing and t.get("g"):   # UNO：目前顏色、方向、最上面一張、牌堆張數、這回合的期限（sn＝伺服器現在時間，客戶端對時用）、誰沒喊 UNO（可以抓）、累積加牌張數、是否正被跳過
        g = t["g"]
        v["un"] = {"color": g["color"], "dir": g["dir"], "top": g["discard"][-1], "deck": len(g["deck"]), "drawn": g["drawn"], "pend": g["pend"],
                   "pending": g["pending"], "skip": g["skip"], "deadline": g["deadline"], "sn": int(time.time() * 1000)}
        for k, s in enumerate(t["seats"]):
            seats[k]["left"] = bool(s.get("left"))
        if role == "seat":
            me = t["seats"][i]
            mine = i == t["turn"]
            v["playable"] = [k for k, c in enumerate(me["hand"]) if un_playable(g, me["hand"], c) and (not g["drawn"] or k == len(me["hand"]) - 1)] if mine else []
            if g["mode"] == "wild":   # 無限制：有累積加牌時可以吃下；沒牌可出時可以一直抽；被跳過時只能出跳過牌或放棄
                v["canDraw"] = mine and (g["pending"] > 0 or (not g["skip"] and not un_has_playable(t, i)))
                v["canPass"] = mine and (g["skip"] or (g["pending"] == 0 and not un_has_playable(t, i) and not g["deck"] and len(g["discard"]) <= 1))
            else:
                v["canDraw"] = mine and not g["drawn"]
                v["canPass"] = mine and g["drawn"]
    if t["game"] == "arcade":   # 俄羅斯方塊：每台機台的狀態、聯機狀況；phase 依「我自己是不是正在玩」
        return ar_view(t, cid, v)
    if role == "spec" and playing and t["game"] in ("oldmaid", "uno"):   # 觀戰者看得到每個人的手牌（使用者要求，2026-11-08），順序＝對手看到的牌背順序
        v["hands"] = [list(s["hand"]) for s in t["seats"]]
    if role == "seat" and playing and t["game"] in ("oldmaid", "uno"):
        v["hand"] = list(t["seats"][i]["hand"])   # 照伺服器順序（不排序）：對方抽的第 k 張牌背＝這裡從左數第 k 張
    return v

def tbl_info(t):
    mn, mx = GAME_LIMITS[t["game"]]
    return {"game": t["game"], "n": len(t["seats"]), "s": len(t["specs"]), "max": mx, "play": t["phase"] == "playing",
            "seated": [s["cid"] for s in t["seats"]], **(ar_info(t) if t["game"] == "arcade" else {})}   # 入座中的連線編號：客戶端在他們的名牌後面加「入座中／遊戲中」

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
        self.tables = {}         # 桌 id -> 牌桌狀態（和平島的遊戲桌；只放記憶體）
        self.tlock = threading.Lock()   # 牌桌操作串行（table_op）
        self._xp_pending = []           # 對局結束待發的 XP：[(連線編號, XP)]（table_do 在鎖內收集、table_op 在鎖外發）
        self._gs_pending = []           # 對局結束待記的戰績：[(連線編號, 遊戲 id, 戰績增量)]
        self.game_xp_at = {}            # 帳號 id -> 上次玩小遊戲得 XP 的時間（GAME_XP_CD）
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
                           "regen_t": 0.0, "aggro": None, "last_hit_at": 0.0, "quote": None, "last_line": -1, "xp": 0}
        return d

    def dragon_regen(self, terrain, now):
        """回血：每秒回 D_REGEN 點（用牆鐘 lazy 計算，不需要計時器；滿血或死亡時把錨點重置為現在，
        扣血後才重新開始累積；與 worker/src/index.js 的 regenDragon 同一套演算法）。"""
        d = self.dragon_state(terrain)
        mx = dragon_max_hp(d)
        if d["st"] == "dead" or d["hp"] >= mx:
            d["regen_t"] = now
            return
        n = int((now - d["regen_t"]) // 1000)
        if n > 0:
            d["hp"] = min(mx, d["hp"] + n * D_REGEN)
            d["regen_t"] = now if d["hp"] >= mx else d["regen_t"] + n * 1000

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
        if style in ("gaze", "beam", "command"):   # 原地施放（石化之瞳開眼／波動砲讀條／命令讀條）：不瞬移不移動，放完就地回 idle
            cast_ms = D_GAZE_CAST_MS if style == "gaze" else D_BEAM_CAST_MS if style == "beam" else D_COMMAND_CAST_MS
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
        o = {"ph": ph, "x": pos[0], "y": pos[1], "hp": d["hp"], "lvl": dl_lv(d.get("xp", 0)), "max": dragon_max_hp(d)}
        if d["aggro"]:   # 仇恨中：附上追殺目標（中途進場的人才知道牠在戰鬥）
            o["aggro"] = d["aggro"]["id"]
        if ph == "aim":
            o.update(castMs=int(ms), tx=d["atk"][0], ty=d["atk"][1], dx=d["dest"][0], dy=d["dest"][1])
        elif ph == "cast":   # 石化之瞳：開眼中（直線已鎖定）；命令：帶 kind
            o.update(castMs=int(ms))
            if d.get("command"):
                o["kind"] = d["command"]
            else:
                o.update(tx=d["atk"][0], ty=d["atk"][1], bx=d["beam"][0], by=d["beam"][1])
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
                    if d["aim_tms"]:   # 反擊循環剛結束：龍衝落在對岸（dest）；石化之瞳／波動砲／命令留在原地。清 aim_tms 讓散步插值生效
                        d["aim_tms"] = 0.0
                        if OWNER_TERRAINS.get(terrain) not in ("gaze", "beam", "command"):
                            d["pos"] = list(d["dest"])
                    w = d["wander"]
                    if w and now < w["t0"] + w["tms"] + w["pause"]:
                        next_delay = (w["t0"] + w["tms"] + w["pause"] - now) / 1000 + 0.05
                    else:
                        out = self._dragon_start_leg(terrain)
                        if out: outs.append(out)
                        next_delay = ((d["wander"]["tms"] + d["wander"]["pause"]) / 1000 + 0.05) if out else 2.0
        # 帶傷回血：補血並把變化廣播出去（lazy 回血原本只在被打／快照時結算，血條會卡住不動）
        if d["st"] != "dead" and d["hp"] < dragon_max_hp(d):
            before = d["hp"]
            self.dragon_regen(terrain, now)
            if d["hp"] != before:
                outs.append(dragon_hp_msg(d))
        for m in outs:
            self.broadcast(m, terrain=terrain)
        if next_delay is not None:
            if d["st"] != "dead" and d["hp"] < dragon_max_hp(d):   # 帶傷：下一次醒來提早到「回滿血時刻」，屆時補滿並廣播一次（不用定期輪詢）
                full_at = d["regen_t"] + math.ceil((dragon_max_hp(d) - d["hp"]) / D_REGEN) * 1000
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
        return ({"t": "dragon", "ev": "say", "x": d["pos"][0], "y": d["pos"][1], "ms": D_SAY_MS, "line": q["line"],
                 "lvl": dl_lv(d.get("xp", 0))},
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
                         "lvl": dl_lv(d.get("xp", 0)), "ids": self._quote_targets(terrain, sk, d)})
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
        if style == "command":
            return d["aim_tms"] + D_COMMAND_CAST_MS
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
            if OWNER_TERRAINS.get(terrain) not in ("gaze", "beam", "command"):
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
                outs.append({"t": "dragon", "ev": "claw", "x": pos[0], "y": pos[1], "tx": tx, "ty": ty,
                             "lvl": dl_lv(d.get("xp", 0)), "id": cid})
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
        award_lv = None   # 擊倒島主時的獎勵等級（獎勵在鎖外發）
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
            try:
                dmg = sk["dmg"] if sk else max(1, min(dl_hit_max(player_lvl_of(c)), round(float(msg.get("dmg") or 1))))   # 夾值隨攻擊者等級放寬（dl_hit_max）
            except (TypeError, ValueError):
                dmg = 1
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
                award_lv = dl_lv(d["xp"])   # 獎勵按被擊倒當下的等級；xp 不清零（島主等級存一起、永不重置）
                outs.append({"t": "dragon", "ev": "dead", "x": pos[0], "y": pos[1], "lvl": award_lv})
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
                outs.append(dragon_hp_msg(d))
                # 反擊冷卻中：把攻擊者納入仇恨（從 D_DROPOUT 內打過牠的人隨機挑一位開始追殺；已有目標時由 tick 負責換人）
                if not d.get("aggro") and ph == "idle" and cd_left > 0 and self.dragon_maps.get(terrain):
                    cands = self.aggro_candidates(now, terrain)
                    if cands:
                        rcid, rc = random.choice(cands)
                        outs.append(self._aggro_start(rcid, rc, terrain))
                        self._schedule_wander_tick(0.1, d["wander_gen"], terrain)   # 快點醒來開始追殺
                    else:
                        print(f"[dragon] {terrain} 冷卻中被打但沒有可用攻擊者：不開仇恨", file=sys.stderr, flush=True)
        if dead_gen is not None:   # 打倒了：重生計時與參與者獎勵（鎖外，避免 broadcast 卡住其他人）
            t = threading.Timer(D_RESPAWN_MS / 1000, self._dragon_respawn, (dead_gen, terrain))
            t.daemon = True
            self.dragon_timers[terrain] = t
            t.start()
            # 擊倒獎勵：D_DROPOUT（30 秒）內打過牠、還在線沒死的所有人（與擊倒稱號「參與擊倒」同一批）
            with self.lock:
                for ac, cc in self.aggro_candidates(time.time() * 1000, terrain):
                    xp_grant(cc, owner_kill_xp(award_lv), "owner")
                    if cc.get("user"):   # 擊倒島主紀錄跟著帳號
                        full = kills_add(cc["user"]["id"], [terrain])
                        with cc.get("send") or threading.Lock():
                            ws_send(cc["sock"], json.dumps({"t": "kills", "kills": full}))
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
        if style in ("gaze", "beam", "command"):   # 原地施放：石化之瞳開眼／波動砲讀條／命令讀條（命令隨機二選一，檢定在各客戶端本地）
            if style == "command":
                d["command"] = random.choice(("act", "still"))
            else:
                d["command"] = None
                ux, uy = ax - d["pos"][0], ay - d["pos"][1]
                ul = math.hypot(ux, uy) or 1
                d["unit"] = [ux / ul, uy / ul]
                d["beam"] = dragon_dash_dest(m, d["pos"][0], d["pos"][1], d["unit"][0], d["unit"][1])
            d["aim_tms"] = now
            cast_ms = D_GAZE_CAST_MS if style == "gaze" else D_BEAM_CAST_MS if style == "beam" else D_COMMAND_CAST_MS
            d["cooldown_until"] = now + cast_ms + D_RAGE_MS
            ev = "gaze" if style == "gaze" else "beam" if style == "beam" else "command"
            msg = {"t": "dragon", "ev": ev, "x": d["pos"][0], "y": d["pos"][1], "castMs": cast_ms, "hp": d["hp"],
                   "lvl": dl_lv(d.get("xp", 0)), "max": dragon_max_hp(d)}
            if style == "command":
                msg["kind"] = d["command"]
            else:
                msg.update(tx=ax, ty=ay, bx=d["beam"][0], by=d["beam"][1])
            return msg
        warp = dragon_edge(m, random.random() * math.pi * 2)
        ux, uy = ax - warp[0], ay - warp[1]
        ul = math.hypot(ux, uy) or 1
        d.update(warp=warp, unit=[ux / ul, uy / ul])
        d["dest"] = dragon_dash_dest(m, warp[0], warp[1], d["unit"][0], d["unit"][1])
        d["dash_len"] = math.hypot(d["dest"][0] - warp[0], d["dest"][1] - warp[1])
        d["aim_tms"] = now
        d["cooldown_until"] = now + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS + D_RAGE_MS
        return {"t": "dragon", "ev": "aim", "x": warp[0], "y": warp[1], "fx": d["pos"][0], "fy": d["pos"][1],
                "tx": ax, "ty": ay, "dx": d["dest"][0], "dy": d["dest"][1], "castMs": D_CAST_MS, "hp": d["hp"],
                "lvl": dl_lv(d.get("xp", 0)), "max": dragon_max_hp(d)}

    def _dragon_respawn(self, gen, terrain):
        out2 = leg_delay = None
        with self.lock:
            d = self.dragon_state(terrain)
            if d["st"] != "dead" or d["gen"] != gen:   # 期間已有別的變動（例如伺服器重啟重建）
                return
            m = self.dragon_maps.get(terrain)
            pos = dragon_edge(m, random.random() * math.pi * 2) if m else list(D_CENTER)
            d.update(st="idle", hp=dragon_max_hp(d), pos=pos, aim_tms=0.0, atk=[0, 0], wander=None, aggro=None, quote=None, say_until=0.0, command=None)
            d["wander_gen"] += 1   # 作廢舊散步 tick
            out = {"t": "dragon", "ev": "spawn", "x": pos[0], "y": pos[1], "hp": d["hp"],
                   "lvl": dl_lv(d.get("xp", 0)), "max": dragon_max_hp(d)}
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

    def credit_mob_kill(self, cid, victim_lvl, terrain):
        """島主／深海魚人擊倒玩家的等級記帳（第 3 步；與 worker/src/index.js 的 creditMobKill 同一套）：
        死因都是客戶端自判（state.dead 0→1），伺服器用「誰在追他」推斷凶手——該地形魚人的 aggro.id 是死者＝牠殺的
        （session 等級 +1，血量上限 +5 並回一點血）；否則該地形島主活著就記牠的 XP
        （爪擊／龍衝／石化／波動砲／台詞招式都可能害死；石化每秒扣 1 的 tick 不隨等級變）。
        島主得 XP＝10＋2×受害者等級、順手回一點血；xp 存 dragon_state（等級存一起、永不重置）。
        需在鎖內算（broadcast 不能在鎖內呼叫）；回要廣播的訊息或 None。"""
        if not terrain:
            return None
        with self.lock:
            L = self.lurkers.get(terrain)
            if L and isinstance(L.get("aggro"), dict) and L["aggro"].get("id") == cid:
                L["lvl"] = (L["lvl"] or 1) + 1
                L["max"] = lurker_max_hp(L)
                L["hp"] = min(L["max"], L["hp"] + L_HP_UP)
                return {"t": "lurker", "ev": "hp", "hp": L["hp"], "lvl": L["lvl"], "max": L["max"]}
            d = self.dragons.get(terrain)
            if not d or d["st"] == "dead":
                return None   # 沒有島主／已被擊倒：記不到任何人頭上
            d["xp"] = max(0, d.get("xp", 0)) + 10 + 2 * max(1, int(victim_lvl or 1))   # 擊倒玩家得 XP＝10＋2×受害者等級
            d["hp"] = min(dragon_max_hp(d), d["hp"] + DL_HP_UP)
            return dragon_hp_msg(d)

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
        o = {"mob": L["mob"], "x": pos[0], "y": pos[1], "hp": L["hp"], "max": L["max"], "lvl": L["lvl"] or 1, "aggro": L["aggro"]["id"]}
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
            self.lurkers[terrain] = {"mob": mob, "hp": L_HP, "max": L_HP, "lvl": 1, "pos": pos, "wander": None, "last_hit_at": now,
                                     "aggro": {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + L_CLAW_MS}}
            self.lurk_hits[cid] = (terrain, now)
            print(f"[lurker {time.strftime('%H:%M:%S')}] {terrain} 釣到 {mob} @({pos[0]:.0f},{pos[1]:.0f})", file=sys.stderr, flush=True)
            msg = {"t": "lurker", "ev": "spawn", "terrain": terrain, "mob": mob, "x": pos[0], "y": pos[1], "fx": fx, "fy": fy,
                   "hp": L_HP, "max": L_HP, "lvl": 1, "id": cid, "name": st.get("name") or "玩家"}
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
                dmg = sk["dmg"] if sk else max(1, min(dl_hit_max(player_lvl_of(c)), round(float(msg.get("dmg") or 1))))   # 夾值隨攻擊者等級放寬（dl_hit_max）
            except (TypeError, ValueError):
                dmg = 1
            L["hp"] -= dmg
            if L["hp"] <= 0:
                kill_lv = L.get("lvl") or 1
                del self.lurkers[terrain]
                # 擊倒獎勵：L_DROPOUT（30 秒）內打過牠、還在線沒死的所有人（與擊倒稱號「參與擊倒」同一批；鎖內發，xp_grant 不會等房間鎖）
                for k2, cc2 in self.clients.items():
                    h2 = self.lurk_hits.get(k2)
                    s2 = cc2.get("state")
                    if h2 and h2[0] == terrain and now - h2[1] <= L_DROPOUT and cc2.get("terrain") == terrain and s2 and not s2.get("dead"):
                        xp_grant(cc2, lurk_kill_xp(kill_lv), "lurk")
                return terrain, {"t": "lurker", "ev": "dead", "x": pos[0], "y": pos[1], "lvl": kill_lv}
            return terrain, {"t": "lurker", "ev": "hp", "hp": L["hp"], "lvl": L["lvl"] or 1, "max": lurker_max_hp(L)}

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
                            outs.append({"t": "lurker", "ev": "claw", "x": pos[0], "y": pos[1], "tx": tx0, "ty": ty0,
                                         "lvl": L["lvl"] or 1, "id": tid})
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


    # ---- 和平島遊戲桌：每個操作回 (待送清單[(cid, 訊息)], tblinfo 訊息或 None, 地形)，由呼叫端在鎖外送出 ----
    def table_info_msg(self, terrain):
        info = {}
        for tid, game in TABLE_DEFS.get(terrain, {}).items():
            t = self.tables.get(tid)
            info[tid] = tbl_info(t) if t else {"game": game, "n": 0, "s": 0, "max": GAME_LIMITS[game][1], "play": False}
        return {"t": "tblinfo", "info": info}

    def _table_notify_locked(self, t, out):
        for m in t["seats"] + t["specs"]:
            out.append((m["cid"], {"t": "table", "id": t["id"], "v": tbl_view(t, m["cid"])}))

    def _table_collect_xp(self, t, before):
        """這個操作結束了一局：把各入座者的 XP 記進待發清單（鎖外發；中途離開的 aborted 結果沒有 xp）。"""
        r = t.get("result")
        if r is not None and r is not before and not r.get("aborted") and r.get("xp"):
            for i, s in enumerate(t["seats"]):
                if s["cid"] is not None and i < len(r["xp"]) and r["xp"][i] > 0:
                    self._xp_pending.append((s["cid"], r["xp"][i]))
        if r is not None and r is not before and not r.get("aborted") and isinstance(r.get("gs"), list) and t["game"] in GS_GAMES:
            for i, s in enumerate(t["seats"]):   # 戰績（result["gs"]）：登入者鎖外記進帳號並把整份送給本人；訪客由客戶端本機套用
                if s["cid"] is not None and i < len(r["gs"]) and r["gs"][i]:
                    self._gs_pending.append((s["cid"], t["game"], r["gs"][i]))

    def _table_leave_locked(self, cid, out):
        c = self.clients.get(cid)
        tid = c.pop("table", None) if c else None
        t = self.tables.get(tid) if tid else None
        if not t:
            return
        before = t.get("result")
        tbl_leave(t, cid)
        self._table_collect_xp(t, before)
        out.append((cid, {"t": "table", "id": tid, "v": None}))
        if not t["seats"] and not t["specs"]:
            self.tables.pop(tid, None)   # 沒人了：整桌重來
        else:
            self._table_notify_locked(t, out)

    def table_do(self, cid, msg):
        out = []
        with self.lock:
            c = self.clients.get(cid)
            if not c or not c.get("terrain"):
                return [], None, None
            terr, a = c["terrain"], msg.get("a")
            if a == "join":
                tid = str(msg.get("id") or "")
                game = TABLE_DEFS.get(terr, {}).get(tid)
                if not game:
                    return [], None, None
                if c.get("table") and c["table"] != tid:
                    self._table_leave_locked(cid, out)
                t = self.tables.setdefault(tid, tbl_new(tid, game))
                name = str((c.get("state") or {}).get("name") or (c.get("user") or {}).get("name") or f"玩家{cid}")[:12]
                if game == "arcade":   # 俄羅斯方塊：坐哪一台由 cab 決定
                    ar_join(t, cid, name, "spec" if msg.get("role") == "spec" else "seat", (c.get("user") or {}).get("id"), msg.get("cab"))
                else:
                    tbl_join(t, cid, name, "spec" if msg.get("role") == "spec" else "seat", (c.get("user") or {}).get("id"))
                c["table"], c["table_terr"] = tid, terr
                self._table_notify_locked(t, out)
            else:
                t = self.tables.get(c.get("table") or "")
                if not t:
                    return [], None, None
                before = t.get("result")
                now_ms = int(time.time() * 1000)
                if t["game"] == "hockey" and a in ("hp", "hs"):   # 空氣曲棍球：握把位置／圓盤快照，只轉發；時間上限過了才順便結算
                    out = hk_relay(t, cid, msg)
                    if not hk_tick(t, now_ms):
                        return out, None, None
                    self._table_notify_locked(t, out)
                    self._table_collect_xp(t, before)
                    return out, self.table_info_msg(c.get("table_terr") or terr), c.get("table_terr") or terr
                if t["game"] == "maze" and a in ("ms", "mp"):   # 豆豆迷宮：豆豆的快照／幽靈玩家的位置，只轉發；對抗時間上限過了才順便結算
                    out = mz_relay(t, cid, msg)
                    if not mz_tick(t, now_ms):
                        return out, None, None
                    self._table_notify_locked(t, out)
                    self._table_collect_xp(t, before)
                    return out, self.table_info_msg(c.get("table_terr") or terr), c.get("table_terr") or terr
                if a == "pos":   # 躲彈幕：位置回報，轉發給同桌其他人（不通知畫面、不廣播 tblinfo）
                    role, i = tbl_find(t, cid)
                    if t["game"] == "dodge" and role == "seat" and t["phase"] == "playing" and not t["seats"][i]["out"]:
                        x = max(0.0, min(float(DG_W), _num(msg.get("x"), -1e6, 1e6, 0.0)))
                        y = max(0.0, min(float(DG_H), _num(msg.get("y"), -1e6, 1e6, 0.0)))
                        t["seats"][i]["px"], t["seats"][i]["py"] = x, y   # 道具撿取驗證用
                        for m in t["seats"] + t["specs"]:
                            if m["cid"] is not None and m["cid"] != cid:
                                out.append((m["cid"], {"t": "tpos", "i": i, "x": round(x, 1), "y": round(y, 1)}))
                    return out, None, None
                if a == "miss":   # 英文／中文打字競賽：我剛打錯一次，轉發 tmx {i} 給同桌其他人與觀戰者（對手的分數框閃紅；看不到字）
                    role, i = tbl_find(t, cid)
                    if ty_is(t) and role == "seat" and t["phase"] == "playing" and t.get("g"):
                        for m in t["seats"] + t["specs"]:
                            if m["cid"] is not None and m["cid"] != cid:
                                out.append((m["cid"], {"t": "tmx", "i": i}))
                    return out, None, None
                if a == "typ":   # 英文打字競賽：打字進度 {n 第幾個字, p 已打對幾個字母, e 是否剛打錯}，只轉發給觀戰者（tpg）；不存檔、不通知畫面
                    role, i = tbl_find(t, cid)
                    n, p = msg.get("n"), msg.get("p")
                    ok = (ty_is(t) and role == "seat" and t["phase"] == "playing" and t.get("g")
                          and type(n) is int and 0 <= n <= 100000 and type(p) is int and 0 <= p <= 64)
                    if ok:
                        for m in t["specs"]:
                            if m["cid"] is not None:
                                out.append((m["cid"], {"t": "tpg", "i": i, "n": n, "p": p, "e": 1 if msg.get("e") == 1 else 0}))
                    return out, None, None
                if a == "word":   # 英文打字競賽：分數回報，轉發 tsc 給同桌其他人（不通知整個畫面、不廣播 tblinfo）
                    n = msg.get("n")
                    if ty_word(t, cid, n, now_ms):
                        i = tbl_find(t, cid)[1]
                        for m in t["seats"] + t["specs"]:
                            if m["cid"] is not None and m["cid"] != cid:
                                out.append((m["cid"], {"t": "tsc", "i": i, "n": n}))
                    return out, None, None
                if t["game"] == "arcade" and a in ("tb", "clr"):   # 俄羅斯方塊：盤面快照／垃圾行，只轉發（不通知整個畫面、不廣播 tblinfo）
                    return ar_msg(t, cid, msg, now_ms)[1], None, None
                if a == "leave":
                    self._table_leave_locked(cid, out)
                else:
                    dg_check_end(t, now_ms)   # 時間到了就先結算（下面的動作若是 finish／hit 就只是確認）
                    ty_check_end(t, now_ms)
                    it_tick(t, now_ms)   # 秘藥情報戰：識破時間過了就生效、逾時自動處理
                    mg_changed = mg_tick(t, now_ms)   # 見習驅魔師：沒被消除的幽靈扣血、勝負
                    mz_tick(t, now_ms)   # 豆豆迷宮：對抗超過時間上限還沒結算
                    hk_tick(t, now_ms)   # 空氣曲棍球：超過時間上限還沒結算
                    if t["game"] == "intel" and a in IT_MSGS:   # 秘藥情報戰：投遞／收下／轉手／行動牌／逾時
                        it_msg(t, cid, msg, now_ms)
                    elif t["game"] == "arcade":   # 俄羅斯方塊：單人／聯機邀請／接受／拒絕／開始／結束
                        changed, extra = ar_msg(t, cid, msg, now_ms)
                        out.extend(extra)
                        if not changed:
                            return out, None, None
                    elif a == "ready":
                        tbl_ready(t, cid, msg.get("v"))
                    elif a == "sit":
                        tbl_sit(t, cid)
                    elif a == "stand":
                        tbl_stand(t, cid)
                    elif a == "draw":
                        if t["game"] == "uno":
                            un_draw(t, cid, now_ms)   # UNO：抽牌
                        else:
                            om_draw(t, cid, msg.get("idx"))
                    elif a == "shuffle":
                        om_shuffle(t, cid)
                    elif a == "move":
                        gm_move(t, cid, msg.get("x"), msg.get("y"))
                    elif a == "play":   # UNO：出牌（idx、變色牌帶 color）
                        un_play(t, cid, msg.get("idx"), msg.get("color"), now_ms, msg.get("uno") is True)
                    elif a == "pass":
                        un_pass(t, cid, now_ms)
                    elif a == "uno":
                        un_say(t, cid)
                    elif a == "catch":
                        un_catch(t, cid)
                    elif a == "timeout":   # UNO／Blokus：回合限時到了（伺服器核對時鐘）
                        if t["game"] == "blokus":
                            bk_timeout(t, now_ms)
                        elif t["game"] == "trigon":
                            tg_timeout(t, now_ms)
                        else:
                            un_timeout(t, now_ms)
                    elif a == "place":   # Blokus：放方塊 {p 第幾塊, c 佔用的格子座標}
                        if t["game"] == "trigon":
                            tg_place(t, cid, msg.get("p"), msg.get("c"), now_ms)
                        else:
                            bk_place(t, cid, msg.get("p"), msg.get("c"), now_ms)
                    elif a == "mode":   # UNO：桌主在開局前選玩法（classic／wild）
                        un_set_mode(t, cid, msg.get("v"))
                    elif a == "hit":   # 躲彈幕：我被打到（客戶端自判，伺服器管命數與無敵時間）
                        dg_hit(t, cid, now_ms)
                    elif a == "kill":   # 見習驅魔師：我消除了幽靈 i（符號辨識在客戶端，伺服器驗時間與先到先得）
                        mg_kill(t, cid, msg.get("i"), msg.get("p"), now_ms)
                    elif a == "boss":   # 見習驅魔師：我畫對了 Boss 的第 k 個符號
                        mg_boss_hit(t, cid, msg.get("k"), now_ms)
                    elif a == "hend":   # 空氣曲棍球：桌主那台回報結束
                        hk_end(t, cid, msg)
                    elif a == "mpac":   # 豆豆迷宮：桌主指定誰當豆豆
                        mz_set_pac(t, cid, msg.get("v"))
                    elif a == "over" and t["game"] == "maze":   # 豆豆迷宮：豆豆那台回報結束
                        mz_over(t, cid, msg)
                    elif a == "mdiff":   # 見習驅魔師：桌主選難度
                        mg_set_diff(t, cid, msg.get("v"))
                    elif a == "sync":   # 見習驅魔師：客戶端每秒一次，讓伺服器結算沒被消除的幽靈（上面已 mg_tick）；沒有變化就不通知畫面
                        if not mg_changed and t["phase"] == "playing":
                            return [], None, None
                    elif a == "pick":   # 躲彈幕：我吃到道具 n（客戶端自判，伺服器驗時間／距離／先到先得並結算）
                        dg_pick(t, cid, msg.get("n"), now_ms, msg.get("x"), msg.get("y"))
                    elif a == "finish":   # 躲彈幕／英文打字競賽：客戶端看時間到了請求結算（伺服器核對時鐘，沒到時間不理）
                        dg_check_end(t, now_ms + 300)
                        ty_check_end(t, now_ms + 300)
                    else:
                        return [], None, None
                    self._table_notify_locked(t, out)
                    self._table_collect_xp(t, before)   # 這個操作結束了對局：收集 XP（鎖外發）
            return out, self.table_info_msg(c.get("table_terr") or terr), c.get("table_terr") or terr

    def table_drop(self, cid):
        """連線離開地形或斷線：離開牌桌（牌局進行中就結束這一局）。"""
        out = []
        with self.lock:
            c = self.clients.get(cid)
            terr = c.get("table_terr") if c else None
            if not c or not c.get("table"):
                return [], None, None
            self._table_leave_locked(cid, out)
            c.pop("table_terr", None)
            return out, self.table_info_msg(terr), terr

    def send_to(self, cid, msg):
        with self.lock:
            c = self.clients.get(cid)
            sock, lk = (c["sock"], c["send"]) if c else (None, None)
        if not sock:
            return
        try:
            with lk:
                ws_send(sock, json.dumps(msg))
        except Exception:
            pass

    def table_flush(self, res):
        out, info, terr = res
        for cid, m in out:
            self.send_to(cid, m)
        if info and terr:
            self.broadcast(info, terrain=terr)

    def table_op(self, fn, *args):
        """牌桌操作（算結果＋送出）整段串行：不同連線的操作在不同執行緒，先算好的 tblinfo 若晚送到，客戶端會停在過期的人數／入座名單。"""
        with self.tlock:
            self.table_flush(fn(*args))
            gpend, self._gs_pending = self._gs_pending, []
            for cid, game, gs in gpend:
                with self.lock:
                    c = self.clients.get(cid)
                user = c.get("user") if c else None
                if user:
                    self.send_to(cid, {"t": "gstats", "gstats": gstats_apply(user["id"], game, gs)})
            pend, self._xp_pending = self._xp_pending, []
            for cid, n in pend:   # 對局結束：登入者的 XP 由伺服器記（同一帳號 GAME_XP_CD 內只算一次）；訪客由客戶端本機補發
                with self.lock:
                    c = self.clients.get(cid)
                user = c.get("user") if c else None
                now = time.time()
                if not user or now - self.game_xp_at.get(user["id"], 0) < GAME_XP_CD:
                    continue
                self.game_xp_at[user["id"]] = now
                try:
                    xp_grant(c, n, "game")
                except Exception:
                    pass

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
        last_tbl = 0.0   # 牌桌操作的每連線限流（TBL_CD）
        last_pos = 0.0   # 躲彈幕位置回報的限流（TBL_POS_CD）
        last_typ = 0.0   # 英打進度回報的限流（TBL_TYP_CD）
        last_dragon_hit = 0.0   # 打島主的每連線冷卻（與 last_hit 同款）
        last_fish = 0.0         # 釣魚結果的每連線冷卻
        last_xp_mob = 0.0       # 擊倒非主動怪的 XP 冷卻（2026-11-07）
        last_death_credit = 0.0   # 倒地記帳的每連線冷卻（DEATH_CREDIT_MIN）
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
                        xp_known = False
                        if c["user"]:   # 登入者：把伺服器存檔的 XP 讀回來（之後 state.lvl 與記帳都靠它）
                            with XP_DB_LOCK:
                                c["xp"] = XP_DB.get(c["user"]["id"], 0)
                                xp_known = c["xp_known"] = c["user"]["id"] in XP_DB
                            if c.get("state") and xp_known:
                                c["state"]["lvl"] = xp_info(c["xp"])["lv"]
                        c["nick"] = NICKS.get(c["user"]["id"], "") if c["user"] else ""   # 暱稱（顯示名稱）
                        if c["user"] and c.get("state"):   # 與 Worker 一致：已送過的狀態立刻改用驗證過的名字與 uid
                            c["state"] = {**c["state"], "name": c["nick"] or str(c["user"]["name"])[:NAME_MAX], "uid": c["user"]["id"]}
                        with c["send"]:
                            ws_send(sock, json.dumps({"t": "me", "admin": c["admin"], "auth": bool(c["user"]),
                                                      # uid／xpKnown：客戶端據此決定 XP 記帳走伺服器（xpKnown=false 時要把本機存檔一次性上繳）
                                                      "uid": c["user"]["id"] if c["user"] else None, "xpKnown": xp_known}))
                            if c["user"]:
                                ws_send(sock, json.dumps({"t": "nick", "nick": c["nick"]}))   # 我的暱稱（客戶端據此顯示自己的名字與設定面板）
                            if c["user"]:   # 登入的人：送他的魚類圖鑑
                                with FISH_DEX_LOCK:
                                    dex = json.loads(json.dumps(FISH_DEX.get(c["user"]["id"], {})))
                                ws_send(sock, json.dumps({"t": "dex", "dex": dex}))
                                ws_send(sock, json.dumps({"t": "craftdb", "craft": craft_add(c["user"]["id"], {})}))   # 合成解鎖紀錄
                                ws_send(sock, json.dumps({"t": "kills", "kills": kills_add(c["user"]["id"], [])}))   # 擊倒島主紀錄
                                ws_send(sock, json.dumps({"t": "gstats", "gstats": gstats_apply(c["user"]["id"], "", None)}))   # 遊戲戰績（稱號用）
                                if xp_known:   # XP 只在「伺服器有紀錄」時送 init；沒有就等 xpsync 上繳
                                    ws_send(sock, json.dumps({"t": "xp", "xp": c.get("xp", 0), "d": 0, "k": "init"}))
                elif t == "state":
                    c = room.clients.get(cid)
                    st = sanitize_state(msg.get("s") if isinstance(msg.get("s"), dict) else {}, c.get("state") if c else None)
                    # 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）；等級以伺服器存檔為準（訪客照客戶端報的，只影響名牌）
                    user = c.get("user") if c else None
                    if user:
                        st["name"], st["uid"] = c.get("nick") or str(user["name"])[:NAME_MAX], user["id"]
                        if c.get("xp_known") and isinstance(c.get("xp"), (int, float)):
                            st["lvl"] = xp_info(c["xp"])["lv"]
                    was_dead = bool((c.get("state") or {}).get("dead")) if c else False
                    if c:
                        c["state"] = st
                    cur = room.terrain_of(cid)
                    if cur:
                        room.broadcast({"t": "p", "id": cid, "s": st}, skip=cid, terrain=cur)
                    # 倒地扣 XP（2026-11-07）：死因都是客戶端自判（state.dead），伺服器只看「本連線首次 dead」抽 10%
                    if user and c.get("xp_known") and not was_dead and st["dead"]:
                        loss = xp_death_loss(c.get("xp") or 0)
                        if loss > 0 and random.random() < .1:
                            xp_grant(c, -loss, "death")
                    # 島主／魚人擊倒玩家的等級記帳（第 3 步）：0→1 的那格才判
                    if not was_dead and st["dead"]:
                        t_now = time.time()
                        if t_now - last_death_credit >= DEATH_CREDIT_MIN:   # 同一條連線的最短間隔
                            last_death_credit = t_now
                            # 受害者等級：只有登入、且等級是伺服器存檔算出來的才採用；其餘（訪客／還沒有紀錄）客戶端自己報的一律當 Lv 1
                            victim_lvl = (st.get("lvl") or 1) if (user and c and c.get("xp_known")) else 1
                            kill_out = room.credit_mob_kill(cid, victim_lvl, cur)
                            if kill_out and cur:
                                room.broadcast(kill_out, terrain=cur)
                elif t == "nick":   # 改暱稱 {v}（空字串＝恢復 Discord 名稱）：只有登入者；之後的 state 帶新名字給大家；兩次最短間隔 NICK_CD_MS
                    c = room.clients.get(cid)
                    now_ms = int(time.time() * 1000)
                    if c is not None and c.get("user") and now_ms - c.get("nick_at", 0) >= NICK_CD_MS:
                        c["nick_at"] = now_ms
                        nick = nick_clean(msg.get("v"))
                        uid = c["user"]["id"]
                        if nick:
                            NICKS[uid] = nick
                        else:
                            NICKS.pop(uid, None)
                        name = nick or str(c["user"]["name"])[:NAME_MAX]
                        c["nick"] = nick
                        if c.get("state"):
                            c["state"] = {**c["state"], "name": name}
                        with c["send"]:
                            ws_send(sock, json.dumps({"t": "nick", "nick": nick}))
                        board_rename(uid, name)
                        outs = []
                        with room.lock:
                            for tb in room.tables.values():
                                if tb["game"] in BOARD_GAMES:
                                    room._table_notify_locked(tb, outs)   # 正在看排行榜的人：換上新名字
                        for to, m in outs:
                            if to is not None:
                                room.send_to(to, m)
                elif t == "xpsync":   # 舊存檔一次性上繳（2026-11-07 使用者定 (a)）：伺服器沒有紀錄才收，有就回現值（冪等）
                    c = room.clients.get(cid)
                    user = c.get("user") if c else None
                    if user:
                        v = max(0, min(XP_MAX, int(_num(msg.get("v"), 0, XP_MAX, 0))))
                        with XP_DB_LOCK:
                            if user["id"] not in XP_DB:
                                XP_DB[user["id"]] = v
                            nv = XP_DB[user["id"]]
                        c["xp"], c["xp_known"] = nv, True
                        if c.get("state"):
                            c["state"]["lvl"] = xp_info(nv)["lv"]
                        with c.get("send") or threading.Lock():
                            ws_send(sock, json.dumps({"t": "xp", "xp": nv, "d": 0, "k": "init"}))
                elif t == "craft":   # 合成解鎖一筆（素材／家具／配方；客戶端自判，伺服器只存，不驗證 id 是否存在；訪客略過）
                    c = room.clients.get(cid)
                    if c and c.get("user") and msg.get("k") in CRAFT_KINDS:
                        craft_add(c["user"]["id"], {msg["k"]: [msg.get("id")]})
                elif t == "craftsync":   # 補傳本機有、伺服器沒有的解鎖（訪客時期的進度併進帳號）；回整份 craftdb
                    c = room.clients.get(cid)
                    if c and c.get("user"):
                        add = {k: (msg.get(k) if isinstance(msg.get(k), list) else [])[:CRAFT_SYNC_MAX] for k in CRAFT_KINDS}
                        full = craft_add(c["user"]["id"], add)
                        with c.get("send") or threading.Lock():
                            ws_send(sock, json.dumps({"t": "craftdb", "craft": full}))
                elif t == "xpe":   # 擊倒非主動怪的 XP 事件（伺服器無法驗證：信任事件＋夾頻；2026-11-07 使用者同意）
                    c = room.clients.get(cid)
                    if c and c.get("user") and room.terrain_of(cid) and msg.get("k") in ("mob", "petkill"):
                        now = time.time()
                        if now - last_xp_mob >= XP_MOB_CD:
                            last_xp_mob = now
                            if msg.get("k") == "mob":
                                # 數量照客戶端帶的（會反擊的野怪＝島主經驗 1/10，2026-11-09 使用者同意延伸）；夾 1～25，防亂報
                                amt = min(XP_XPE_MAX, max(1, int(msg.get("n") or 1)))
                                xp_grant(c, amt, "mob")
                            else:   # 和平島殺寵懲罰（2026-11-13 使用者定）：扣「掉一等」＝這級累積＋前一級需求，Lv1 扣到 0。限定和平島；扣量照 XP_DB 現值自己算
                                with XP_DB_LOCK:
                                    i = xp_info(XP_DB.get(c["user"]["id"], 0))
                                loss = i["cur"] + XP_NEED(i["lv"] - 1) if i["lv"] > 1 else i["cur"]
                                if loss > 0:
                                    xp_grant(c, -loss, "petkill")
                elif t == "tbl":   # 和平島遊戲桌（join／leave／ready／sit／draw）；牌局邏輯全在伺服器
                    now = time.time()
                    if msg.get("a") in ("pos", "word", "tb", "ms", "mp", "hp", "hs"):   # 躲彈幕的位置回報、英文打字競賽的分數回報：自己的限流，不影響 hit／finish 等操作
                        if now - last_pos < TBL_POS_CD:
                            continue
                        last_pos = now
                    elif msg.get("a") in ("typ", "sync"):   # 英文打字競賽的打字進度（只轉發給觀戰者）、見習驅魔師的每秒對時：自己的限流
                        if now - last_typ < TBL_TYP_CD:
                            continue
                        last_typ = now
                    elif msg.get("a") in ("kill", "boss", "clr"):   # 見習驅魔師的擊殺／打 Boss、俄羅斯方塊的消行：不限流（兩次之間本來就隔著一筆畫，限流反而會吃掉擊殺）
                        pass
                    else:
                        if now - last_tbl < TBL_CD:
                            continue
                        last_tbl = now
                    room.table_op(room.table_do, cid, msg)
                elif t in ("enter", "terrain"):   # "terrain" 是舊客戶端的訊息名
                    # 每位玩家各自在自己的地形，只有同地形的人看得到彼此
                    v = str(msg.get("v"))
                    if not TERRAIN_RE.match(v):
                        continue
                    res = room.enter(cid, v)
                    if res is None:
                        continue
                    room.table_op(room.table_drop, cid)   # 換地形：離開牌桌
                    old, players, furn, floor, decos, dragon, lurker = res
                    if old:   # leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
                        room.broadcast({"t": "leave", "id": cid, "to": v}, skip=cid, terrain=old)
                    with room.clients[cid]["send"]:
                        ws_send(sock, json.dumps({"t": "enter", "terrain": v, "players": players, "furn": furn, "floor": floor, "decos": decos, "dragon": dragon, "lurker": lurker}))
                    if v in TABLE_DEFS:   # 和平島：給這位玩家各桌目前的人數／狀態
                        room.send_to(cid, room.table_info_msg(v))
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
                        if res[1].get("hp", 1) <= 0:   # 打壞了：採集 +1 XP（只有打壞的這條連線；2026-11-07）
                            c4 = room.clients.get(cid)
                            if c4 and c4.get("user"):
                                xp_grant(c4, 1, "mine")
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
                    if not res.get("escaped") and db.get("lurker") and cur not in (db.get("noLurker") or []) and random.random() < db.get("lurkerChance", 0):   # noLurker：和平島不會釣到
                        sp = room.spawn_lurker(cid, str(db["lurker"]))
                        if sp:
                            room.broadcast(sp[1], terrain=sp[0])
                            with (room.clients.get(cid) or {}).get("send") or threading.Lock():
                                ws_send(sock, json.dumps({"t": "fish_result", "terrain": cur, "lurker": str(db["lurker"]), "saved": False}))
                            continue
                    out = {"t": "fish_result", **res, "saved": False}
                    c5 = room.clients.get(cid)
                    user = (c5 or {}).get("user")
                    if not res.get("escaped") and user:
                        entry, is_new, is_record = dex_catch(user["id"], res["terrain"], res["id"], res["size"])
                        out.update(saved=True, entry=entry, isNew=is_new, isRecord=is_record)
                        xp_grant(c5, 5 if is_new else 1, "first" if is_new else "fish")   # 釣到 +1、首捕 +5（2026-11-07）
                    with (room.clients.get(cid) or {}).get("send") or threading.Lock():
                        ws_send(sock, json.dumps(out))
        except Exception as e:
            print(f"[ws] !{cid} {e}", file=sys.stderr, flush=True)
        finally:
            last = room.terrain_of(cid)
            room.table_op(room.table_drop, cid)   # 斷線：離開牌桌（牌局進行中就結束這一局）
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
