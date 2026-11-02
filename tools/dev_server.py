#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 本機開發伺服器（M1）
# 1) 服務 client/ 靜態檔
# 2) /api/config   -> 從 dev_config.json 讀 client_id
# 3) /api/token    -> 用 code+secret 向 Discord 兌換 access_token（secret 只在本機/伺服器端）
# 用法: python tools/dev_server.py  (先填 tools/dev_config.json)
import json, math, os, re, sys, base64, hashlib, hmac, struct, threading, time, random, traceback
import urllib.request, urllib.parse, urllib.error, http.server, socketserver

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
MAX_MSG = 16384           # 裝飾模式的 commit 會一次帶多個操作
MAX_OPS = 100
MAX_PLAYERS = 64
RATE_MAX = 40
TERRAIN_RE = re.compile(r"^[a-z0-9_-]{1,24}$")

CELL = 32                # 與 client/js/main.js 一致
HIT_RANGE = 140          # 打可破壞物件時，玩家離目標最遠幾 px（客戶端範圍 72，留給延遲）
HIT_CD = 0.3             # 同一條連線兩次打擊最短間隔（秒）

# ---- 島主（伺服器端同步；與 worker/src/index.js 的常數與演算法保持一致，改一邊要改另一邊）----
# 被打 → 瞬移島緣 → 鎖定攻擊者 → 預警 1 秒 → 龍本體直線衝過島到對岸 → 停一下 → 在當地繼續閒晃。
# 客戶端只負責演出與自己有沒有被撞到的判定；伺服器只送「階段變更」事件，不需要每幀醒著跑。
OWNER_TERRAIN = "grass"
D_CAST_MS = 1000         # 島緣鎖定（預警）持續時間
D_DASH = 560             # 龍衝速度 px/s（比仇恨追殺的 180 更快：高速掠過才有威嚇感；與 client 的 OWNER_DASH_SPEED 一致）
D_REST_MS = 700          # 衝到底落地的停留時間
D_RAGE_MS = 12000        # 龍衝冷卻：到點才能再觸發龍衝；冷卻期間被打進入仇恨追殺
D_SAY_MS = 3000          # 被打後先在原地說台詞的時間（說完才瞬移反擊）
D_RESPAWN_MS = 30000     # 島主被打倒後的重生秒數
D_HP = 200
D_REGEN = 18             # 島主每秒回血（用牆鐘 lazy 計算；與 worker/src/index.js 的 D_REGEN 一致）
D_CHASE = 180.0          # 仇恨追殺速度 px/s（玩家走路 120／跑步 200：走路逃不掉，跑步才能拉開）
D_CLAW_RANGE = 36        # 爪擊範圍（前方扇形；約黃金肥龍大圖的 1/4）
D_CLAW_MS = 1000         # 爪擊間隔（每秒一下）
D_CLAW_DMG = 2           # 爪擊傷害（扣玩家 HP；被打倒由各客戶端自判，伺服器只廣播爪擊事件）
D_AGGRO_MS = 5000        # 仇恨換人週期：打牠的人有複數時，隨機換下一個攻擊者
D_DROPOUT = 30000        # 超過這時間沒有人攻擊島主：脫離仇恨回閒晃
D_RANGE = 70             # 玩家打島主的攻擊距離（客戶端 58，留延遲）
D_DRIFT_TOLER = 600      # 客戶端宣稱的龍位置與伺服器的最大容差（漏接一個路點事件的落後量）
D_CD = 0.3               # 同一條連線兩次打島主的最短間隔（秒）
D_WALK = 34              # 閒晃散步速度 px/s（與 client 的 OWNER_WALK_SPEED 一致）
D_WANDER_PAUSE = (1.5, 4.0)   # 每個路點之間站著休息的時間範圍（秒）
D_CENTER = ((COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL)

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

_FURN_DEFS = None
def furn_defs():
    """id -> (w, h)，取自前端 furniture.json，用來驗證擺放。"""
    global _FURN_DEFS
    if _FURN_DEFS is None:
        with open(os.path.join(CLIENT, "assets", "furniture", "furniture.json"), encoding="utf-8") as f:
            _FURN_DEFS = {it["id"]: (it["w"], it["h"]) for it in json.load(f)["items"]}
    return _FURN_DEFS

class Room:
    """一座島＝一個房間（鍵：guild:channel）。"""
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}   # cid -> {"sock":socket, "send":Lock, "state":dict}
        self.order = 0
        self.furn = {}          # 地形 -> [{"type","cell":[x,y]}]，擺設依地形各自一份
        self.decos = {}         # 地形 -> {物件編號: {"hp","cell","until"(ms)}}，只存受損/已破壞的
        # 島主（伺服器端同步）：龍的階段與島形位圖；只在草島
        self.dragon = None
        self.dragon_map = None
        self.dragon_hits = {}   # cid -> 上次打島主的時刻（秒）
        self.dragon_timer = None
        self.dragon_wander_timer = None
        self.wander_tick_seq = 0
        # 每位玩家各自在某個地形（client["terrain"]）；剛連上時為 None，等 enter

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

    def commit_furn(self, terrain, ops, admin):
        """一批擺設操作：每個各自驗證（不合法的跳過），「清空」只有管理員能做。回傳 (applied, rejected, denied)。"""
        applied = rejected = 0
        denied = False
        with self.lock:
            for op in ops[:MAX_OPS]:
                if not isinstance(op, dict):
                    rejected += 1
                elif op.get("t") == "clear" and not admin:
                    denied = True
                elif self.edit_furn(op, terrain):
                    applied += 1
                else:
                    rejected += 1
        return applied, rejected, denied

    # ---- 島主（伺服器端同步）----
    def dragon_state(self):
        """島主狀態（懒初始化；名稱不能叫 dragon——會被 self.dragon 屬性蓋掉）。"""
        if self.dragon is None:
            self.dragon = {"hp": D_HP, "st": "idle", "pos": list(D_CENTER), "aim_tms": 0.0, "dead_at": 0.0,
                           "gen": 0, "wander": None, "wander_gen": 0, "cooldown_until": 0.0, "say_until": 0.0,
                           "warp": [0, 0], "atk": [0, 0], "unit": [0, 0], "dest": [0, 0], "dash_len": 0.0,
                           "regen_t": 0.0, "aggro": None, "last_hit_at": 0.0}
        return self.dragon

    def dragon_regen(self, now):
        """回血：每秒回 D_REGEN 點（用牆鐘 lazy 計算，不需要計時器；滿血或死亡時把錨點重置為現在，
        扣血後才重新開始累積；與 worker/src/index.js 的 regenDragon 同一套演算法）。"""
        d = self.dragon
        if d["st"] == "dead" or d["hp"] >= D_HP:
            d["regen_t"] = now
            return
        n = int((now - d["regen_t"]) // 1000)
        if n > 0:
            d["hp"] = min(D_HP, d["hp"] + n * D_REGEN)
            d["regen_t"] = now if d["hp"] >= D_HP else d["regen_t"] + n * 1000

    # ---- 島主仇恨（龍衝冷卻中的追殺行為）----
    def aggro_candidates(self, now, win=D_DROPOUT):
        """D_DROPOUT（20 秒）內在草島打過島主、還在線上沒死的人：回 [(cid, client), ...]。"""
        out = []
        for cid, c in self.clients.items():
            if now - self.dragon_hits.get(cid, 0.0) > win:
                continue
            st = c.get("state")
            if c.get("terrain") == OWNER_TERRAIN and st and not st.get("dead"):
                out.append((cid, c))
        return out

    def aggro_target(self, cid):
        """依連線 id 找仇恨目標（斷線／離開草島／死了就找不到）。"""
        c = self.clients.get(cid)
        st = c.get("state") if c else None
        if c and c.get("terrain") == OWNER_TERRAIN and st and not st.get("dead"):
            return cid, c
        return None, None

    def _aggro_start(self, cid, c):
        """開始/切換追殺：設定狀態並回要廣播的訊息。需在鎖內。"""
        d = self.dragon
        d["aggro"] = {"id": cid, "rotate_at": time.time() * 1000 + D_AGGRO_MS,
                      "claw_at": time.time() * 1000 + D_CLAW_MS}
        d["wander"] = None
        print(f"[dragon {time.strftime('%H:%M:%S')}] 仇恨開始 → {cid}", file=sys.stderr, flush=True)
        return {"t": "dragon", "ev": "aggro", "id": cid,
                "name": (c.get("state") or {}).get("name") or "玩家"}

    def _aggro_drop(self, chill=True):
        """脫離仇恨：回要廣播的訊息清單。需在鎖內。"""
        d = self.dragon
        d["aggro"] = None
        return [{"t": "dragon", "ev": "chill"}] if chill else []

    def _aggro_start_leg(self, now, pos, tx, ty):
        """追殺腿：直線朝目標目前位置（速度 D_CHASE）。需在鎖內；回 wander 訊息。
        不走海：龍在陸地時，直線前方連續 3 格是水就截在海邊（0.6 秒後的重新瞄準會繼續沿岸繞）；
        龍本來就在水裡（舊狀態卡海）則不截，直線走回陸地。"""
        d = self.dragon
        if self.dragon_map:
            gx0, gy0 = int(pos[0] // CELL), int(pos[1] // CELL)
            on_land = 0 <= gx0 < COLS and 0 <= gy0 < ROWS and self.dragon_map[gy0 * COLS + gx0]
            steps = max(1, math.ceil(math.hypot(tx - pos[0], ty - pos[1]) / CELL))
            water = 0
            for s in range(1, steps + 1):
                t = s / steps
                sx, sy = pos[0] + (tx - pos[0]) * t, pos[1] + (ty - pos[1]) * t
                gx, gy = int(sx // CELL), int(sy // CELL)
                if on_land and (not (0 <= gx < COLS and 0 <= gy < ROWS) or not self.dragon_map[gy * COLS + gx]):
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

    def dragon_phase(self, now):
        """由 aim_tms 推導現在的階段（aim/dash/rest/gohome/idle/dead），回 (階段, 座標, 剩餘 ms)。"""
        d = self.dragon
        if d["st"] == "dead":
            return "dead", list(d["pos"]), 0
        if not d["aim_tms"]:
            if d["say_until"] and now < d["say_until"]:
                return "say", list(d["pos"]), int(d["say_until"] - now)   # 說台詞中：原地不動
            if not d["wander"]:
                return "idle", list(d["pos"]), 0
            w = d["wander"]
            t = max(0.0, min(1.0, (now - w["t0"]) / w["tms"]))
            return "idle", [w["fx"] + (w["tx"] - w["fx"]) * t, w["fy"] + (w["ty"] - w["fy"]) * t], 0
        dt = now - d["aim_tms"]
        if dt < D_CAST_MS:
            return "aim", list(d["warp"]), D_CAST_MS - dt
        dt -= D_CAST_MS
        dash_ms = d["dash_len"] / D_DASH * 1000
        if dt < dash_ms:
            p = dt / 1000 * D_DASH
            return "dash", [d["warp"][0] + d["unit"][0] * p, d["warp"][1] + d["unit"][1] * p], dash_ms - dt
        dt -= dash_ms
        if dt < D_REST_MS:
            return "rest", list(d["dest"]), D_REST_MS - dt
        return "idle", list(d["dest"]), 0   # 衝完在對岸就地閒晃（不回中心）

    def dragon_snapshot(self):
        """給剛進草島的玩家的島主快照（把現在階段包成客戶端能續播的欄位）。呼叫前需持有或取得狀態。"""
        now_ms = time.time() * 1000
        self.dragon_regen(now_ms)   # 讀快照前先把該補的血補上（快照帶 hp）
        ph, pos, ms = self.dragon_phase(now_ms)
        d = self.dragon
        o = {"ph": ph, "x": pos[0], "y": pos[1], "hp": d["hp"]}
        if ph == "aim":
            o.update(castMs=int(ms), tx=d["atk"][0], ty=d["atk"][1], dx=d["dest"][0], dy=d["dest"][1])
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
        return o

    def _dragon_start_leg(self):
        """idle 時挑一個新路點散步（附近 6～16 格陸地、直線別太抄水；與 client 的 ownerPickLeg 一致）。
        挑不到回 None。需在鎖內呼叫；回傳要廣播的 wander 訊息。"""
        d = self.dragon
        if d["st"] == "dead" or not self.dragon_map:
            return None
        ph, pos, _ = self.dragon_phase(time.time() * 1000)
        if ph != "idle":
            return None
        fx, fy = pos[0], pos[1]
        # 卡海自救（舊狀態）：龍在海裡時先拉回最近的陸地，散步才挑得到路點
        gx0, gy0 = int(fx // CELL), int(fy // CELL)
        if not (0 <= gx0 < COLS and 0 <= gy0 < ROWS and self.dragon_map[gy0 * COLS + gx0]):
            land = dragon_nearest_land(self.dragon_map, fx, fy)
            if land:
                fx, fy = land[0], land[1]
                d["pos"] = [fx, fy]
        for _ in range(24):
            ang = random.random() * math.pi * 2
            dist = (6 + random.random() * 10) * CELL
            tx, ty = fx + math.cos(ang) * dist, fy + math.sin(ang) * dist
            gx, gy = js_round(tx / CELL - .5), js_round(ty / CELL - .5)
            if not (1 <= gx < COLS - 1 and 1 <= gy < ROWS - 1) or not self.dragon_map[gy * COLS + gx]:
                continue
            steps = max(1, math.ceil(dist / CELL))
            water = 0
            for s in range(steps + 1):
                sx, sy = fx + (tx - fx) * s / steps, fy + (ty - fy) * s / steps
                if not self.dragon_map[math.floor(sy / CELL) * COLS + math.floor(sx / CELL)]:
                    water += 1
            if water / (steps + 1) > 0.1:
                continue
            tms = max(1500, int(dist / D_WALK * 1000))
            d["wander"] = {"fx": fx, "fy": fy, "tx": gx * CELL + CELL / 2, "ty": gy * CELL + CELL / 2, "tms": tms,
                           "t0": time.time() * 1000, "pause": random.uniform(*D_WANDER_PAUSE) * 1000}
            print(f"[dragon {time.strftime('%H:%M:%S')}] 散步腿（aggro={'有' if d.get('aggro') else '無'}）fx=({fx:.0f},{fy:.0f}) → ({d['wander']['tx']:.0f},{d['wander']['ty']:.0f})", file=sys.stderr, flush=True)
            return {"t": "dragon", "ev": "wander", "fx": fx, "fy": fy, "tx": d["wander"]["tx"],
                    "ty": d["wander"]["ty"], "tms": tms}
        return None

    def _has_grass_clients(self):
        return any(c.get("terrain") == OWNER_TERRAIN for c in self.clients.values())

    def _schedule_wander_tick(self, delay, gen):
        """排下一次散步狀態機 tick；只讓「最新排程」生效（多次 enter 不會堆出重複計時器）。"""
        self.wander_tick_seq = getattr(self, "wander_tick_seq", 0) + 1
        seq = self.wander_tick_seq
        t = threading.Timer(delay, self._wander_tick, (gen, seq))
        t.daemon = True
        self.dragon_wander_timer = t
        t.start()

    def _wander_tick(self, gen, seq):
        """散步/仇恨狀態機：到期推進路點、或仇恨追殺的每秒 tick。序號/代數不符＝被更新的排程或反擊/死亡作廢；草島沒人＝停擺。"""
        outs = []
        next_delay = None
        with self.lock:
            d = self.dragon
            if seq != getattr(self, "wander_tick_seq", 0) or gen != d["wander_gen"]:
                return
            if d["st"] == "dead" or not self._has_grass_clients():
                return
            now = time.time() * 1000
            if d.get("aggro"):   # 仇恨中：追殺＋爪擊（tick 自己排下一次）；掛保險：tick 出錯就清仇恨讓散步接手，不會卡死
                try:
                    outs, next_delay = self._aggro_tick_locked(now)
                except Exception:
                    traceback.print_exc()
                    d["aggro"] = None
                    next_delay = 0.5
            elif d["say_until"] and now >= d["say_until"]:   # 說完台詞：瞬移島緣，開始反擊循環
                msg = self._dragon_start_cycle(now)
                next_delay = ((D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS) / 1000 + 0.1) if msg else 2.0
                outs = [msg] if msg else []
            elif d["say_until"]:   # 還在說台詞：說完再醒
                next_delay = (d["say_until"] - now) / 1000 + 0.05
            else:
                ph, _, _ = self.dragon_phase(now)
                if ph != "idle":   # 反擊循環中：循環結束時再續
                    cycle_end = d["aim_tms"] + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS
                    next_delay = max(0.1, cycle_end / 1000 - time.time() + 0.1)
                else:
                    if d["aim_tms"]:   # 反擊循環剛結束：落在對岸（dest），從這裡接續散步（清 aim_tms 讓散步插值生效）
                        d["aim_tms"] = 0.0
                        d["pos"] = list(d["dest"])
                    w = d["wander"]
                    if w and now < w["t0"] + w["tms"] + w["pause"]:
                        next_delay = (w["t0"] + w["tms"] + w["pause"] - now) / 1000 + 0.05
                    else:
                        out = self._dragon_start_leg()
                        if out: outs.append(out)
                        next_delay = ((d["wander"]["tms"] + d["wander"]["pause"]) / 1000 + 0.05) if out else 2.0
        # 帶傷回血：補血並把變化廣播出去（lazy 回血原本只在被打／快照時結算，血條會卡住不動）
        if d["st"] != "dead" and d["hp"] < D_HP:
            before = d["hp"]
            self.dragon_regen(now)
            if d["hp"] != before:
                outs.append({"t": "dragon", "ev": "hp", "hp": d["hp"]})
        for m in outs:
            self.broadcast(m, terrain=OWNER_TERRAIN)
        if next_delay is not None:
            if d["st"] != "dead" and d["hp"] < D_HP:   # 帶傷：下一次醒來提早到「回滿血時刻」，屆時補滿並廣播一次（不用定期輪詢）
                full_at = d["regen_t"] + math.ceil((D_HP - d["hp"]) / D_REGEN) * 1000
                next_delay = min(next_delay, max(0.1, (full_at - now) / 1000 + 0.05))
            self._schedule_wander_tick(next_delay, gen)

    def _aggro_tick_locked(self, now):
        """仇恨狀態的 tick（需在鎖內）：追殺目標（每腿重新瞄準目標目前位置）、進爪擊範圍就站定每秒一抓、
        目標死了或 5 秒到隨機換攻擊者、龍衝 CD 一到自動放龍衝、超過 D_DROPOUT 沒人打就脫離仇恨回閒晃。
        回 (要廣播的訊息清單, 下一次 tick 延遲秒數)。"""
        d = self.dragon
        ag = d["aggro"]
        outs = []
        # 太久沒有人攻擊／沒有島形：脫離仇恨，回閒晃
        if not self.dragon_map or now - d.get("last_hit_at", 0.0) > D_DROPOUT:
            print(f"[dragon {time.strftime('%H:%M:%S')}] 脫離仇恨（最後被打在 {now - d.get('last_hit_at', 0.0):.0f}ms 前）", file=sys.stderr, flush=True)
            outs += self._aggro_drop()
            return outs, 0.15
        cid, c = self.aggro_target(ag["id"])
        if cid is None or now >= ag["rotate_at"]:
            # 目標死了或 5 秒到：隨機換下一個攻擊者（沒有其他人就維持原目標）
            cands = [(i, cc) for i, cc in self.aggro_candidates(now) if i != ag["id"]]
            if cands:
                cid, c = random.choice(cands)
                ag["id"] = cid
                ag["rotate_at"] = now + D_AGGRO_MS
                ag["claw_at"] = now + D_CLAW_MS
                print(f"[dragon {time.strftime('%H:%M:%S')}] 仇恨換目標 → {cid}", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "aggro", "id": cid,
                             "name": (c.get("state") or {}).get("name") or "玩家"})
            elif cid is None:   # 目標死了又沒有其他人可換：脫離仇恨回閒晃
                print("[dragon] 目標已死且無人可換：脫離仇恨", file=sys.stderr, flush=True)
                outs += self._aggro_drop()
                return outs, 0.15
        # 龍衝冷卻到了：直接對現在的仇恨目標發動龍衝（瞬移島緣→預警→衝穿牠）；仇恨保持，落地後不用再被打就接著追殺
        if now >= d["cooldown_until"]:
            st = c["state"]
            ph, pos2, _ = self.dragon_phase(now)
            d["wander"] = None
            d["pos"] = [pos2[0], pos2[1]]   # 打斷追腿：位置同步到目前插值點（同 say 的理由）
            d["atk"] = [float(st.get("x", 0)), float(st.get("y", 0))]
            msg = self._dragon_start_cycle(now)
            print(f"[dragon {time.strftime('%H:%M:%S')}] 仇恨中 CD 到：自動對目標放龍衝", file=sys.stderr, flush=True)
            if msg:
                outs.append(msg)
            return outs, 0.15
        ph, pos, _ = self.dragon_phase(now)
        if ph == "say":   # 還在說台詞：說完（會由鬧鐘接手瞬移島緣）再醒，期間不追不抓
            return outs, (d["say_until"] - now) / 1000 + 0.08
        if ph != "idle":   # 預警/龍衝/歇腳中：不追不抓、不發 wander（避免 client 的衝刺演出被 wander 事件打斷瞬移），等循環結束再醒
            cycle_end = d["aim_tms"] + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS
            return outs, max(0.1, cycle_end / 1000 - time.time() + 0.08)
        if d["aim_tms"]:   # 龍衝循環剛結束（仇恨中沒有人清 aim_tms）：落在對岸（dest），清掉讓之後的追腿正常插值
            d["aim_tms"] = 0.0
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
                print(f"[dragon {time.strftime('%H:%M:%S')}] 爪擊 → {cid}（距離 {dist:.0f}）", file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "claw", "x": pos[0], "y": pos[1], "tx": tx, "ty": ty, "id": cid})
        else:
            w = d["wander"]
            # 腿走完、或走了 0.6 秒就重新瞄準：緊咬目標現在的位置（否則龍只會抓到幾秒前的舊位置＝抓空氣）
            if not w or now >= w["t0"] + w["tms"] or now >= w["t0"] + 600:
                print(f"[dragon {time.strftime('%H:%M:%S')}] 追殺腿 → 目標 {cid}（距離 {dist:.0f}）", file=sys.stderr, flush=True)
                outs.append(self._aggro_start_leg(now, pos, tx, ty))
        # 下一個醒的時間：腿走完／爪擊／換人／龍衝 CD／脫離時限，取最近
        ends = [ag["rotate_at"], d["cooldown_until"], d.get("last_hit_at", 0.0) + D_DROPOUT, ag["claw_at"]]
        w = d["wander"]
        if w:
            ends.append(w["t0"] + w["tms"] + 50)
        return outs, max(0.08, min(ends) / 1000 - time.time() + 0.02)

    def dragon_hit(self, cid, msg):
        """打到島主：扣血；閒置且冷卻過了 → 開始反擊；冷卻中 → 納入仇恨。回傳要廣播的訊息清單（空清單＝無效/太遠/飛行中）。"""
        d = self.dragon_state()
        outs = []
        dead_gen = None
        post_cycle = None
        ph = pos = None
        with self.lock:
            c = self.clients.get(cid)
            if c is None or not c["terrain"] or not c["state"]:
                return None
            if d["st"] == "dead":
                return None
            now = time.time() * 1000
            self.dragon_regen(now)   # 扣血前先把該補的血補上（之後廣播的 hp 是回血後的值）
            dmg = 2 if msg.get("dmg") == 2 else 1
            ph, pos, _ = self.dragon_phase(now)
            if ph == "dash":
                return self._drej(f"衝刺中")
            try:
                ax, ay = float(msg.get("x")), float(msg.get("y"))
            except (TypeError, ValueError):
                return self._drej("座標格式壞")
            dist = math.hypot(ax - pos[0], ay - pos[1])
            # 客戶端可能漏接一個路點事件（散步腿落後）：只要它宣稱的龍位置離伺服器的不遠、且玩家貼著宣稱的龍，就接受
            try:
                cdx, cdy = float(msg.get("ddx")), float(msg.get("ddy"))
                near = dist <= D_RANGE or (math.hypot(ax - cdx, ay - cdy) <= D_RANGE
                                           and math.hypot(cdx - pos[0], cdy - pos[1]) <= D_DRIFT_TOLER)
            except (TypeError, ValueError):
                near = dist <= D_RANGE
            if not near:
                return self._drej(f"太遠 dist={dist:.0f}（龍=({pos[0]:.0f},{pos[1]:.0f}) 打擊點=({ax:.0f},{ay:.0f}) ph={ph}）")
            self.dragon_hits[cid] = now   # 仇恨計時用：D_DROPOUT 內打過就算現役攻擊者
            d["hp"] -= dmg
            d["last_hit_at"] = now
            if d["hp"] <= 0:
                d["st"], d["hp"], d["pos"], d["aim_tms"], d["dead_at"] = "dead", 0, list(pos), 0.0, now
                d["gen"] += 1
                d["wander"] = None
                d["aggro"] = None
                d["wander_gen"] += 1   # 作廢散步 tick
                dead_gen = d["gen"]
                outs.append({"t": "dragon", "ev": "dead", "x": pos[0], "y": pos[1]})
            elif ph == "idle" and self.dragon_map and now >= d["cooldown_until"]:
                # 一被打就先建立仇恨（20 秒從最後一次被打起算）；龍衝照樣先放：說台詞 → 瞬移島緣 → 龍衝，
                # 落地後不用再被打就馬上接著追殺同一個攻擊者（循環由 tick 在說完/落地時接手啟動）
                d["aggro"] = {"id": cid, "rotate_at": now + D_AGGRO_MS, "claw_at": now + D_CLAW_MS}
                d["say_until"] = now + D_SAY_MS
                d["atk"] = [ax, ay]   # 記住攻擊者位置，說完台詞後龍衝要穿過這裡
                d["wander"] = None
                d["pos"] = [pos[0], pos[1]]   # 打斷散步腿：把位置同步到目前插值點（否則之後的追腿會從舊腿起點出發，client 看起來像瞬移）
                d["wander_gen"] += 1
                post_cycle = D_SAY_MS / 1000 + 0.1
                outs.append({"t": "dragon", "ev": "aggro", "id": cid,
                             "name": (c.get("state") or {}).get("name") or "玩家"})
                outs.append({"t": "dragon", "ev": "say", "x": pos[0], "y": pos[1], "ms": D_SAY_MS})
            else:
                why = []
                if ph != "idle":
                    why.append(f"ph={ph}")
                if not self.dragon_map:
                    why.append("無島形")
                cd_left = d["cooldown_until"] - now
                if cd_left > 0:
                    why.append(f"怒氣冷卻剩 {cd_left:.0f}ms")
                print(f"[dragon] 命中但沒反擊: {' / '.join(why) or '未知'}"
                      f"（仇恨={'有' if d.get('aggro') else '無'} 現役攻擊者={len(self.aggro_candidates(now))}）",
                      file=sys.stderr, flush=True)
                outs.append({"t": "dragon", "ev": "hp", "hp": d["hp"]})
                # 龍衝冷卻中：把攻擊者納入仇恨（從 D_DROPOUT 內打過牠的人隨機挑一位開始追殺；已有目標時由 tick 負責換人）
                if not d.get("aggro") and ph == "idle" and cd_left > 0 and self.dragon_map:
                    cands = self.aggro_candidates(now)
                    if cands:
                        rcid, rc = random.choice(cands)
                        outs.append(self._aggro_start(rcid, rc))
                        self._schedule_wander_tick(0.1, d["wander_gen"])   # 快點醒來開始追殺
                    else:
                        print("[dragon] 冷卻中被打但沒有可用攻擊者：不開仇恨", file=sys.stderr, flush=True)
        if dead_gen is not None:   # 打倒了：重生計時（鎖外，避免 broadcast 卡住其他人）
            t = threading.Timer(D_RESPAWN_MS / 1000, self._dragon_respawn, (dead_gen,))
            t.daemon = True
            self.dragon_timer = t
            t.start()
        elif post_cycle is not None:
            self._schedule_wander_tick(post_cycle, self.dragon["wander_gen"])
        return outs

    def _drej(self, why):
        """打擊被拒（暫時性診斷日誌）。"""
        print(f"[dragon] 打擊拒絕: {why}", file=sys.stderr, flush=True)
        return None

    def _dragon_start_cycle(self, now):
        """說完台詞：瞬移島緣鎖定 d["atk"] 的攻擊者，進入預警→龍衝循環。需在鎖內；回傳 aim 廣播訊息。"""
        d = self.dragon
        if d["st"] == "dead" or not self.dragon_map:
            return None
        warp = dragon_edge(self.dragon_map, random.random() * math.pi * 2)
        ax, ay = d["atk"][0], d["atk"][1]
        ux, uy = ax - warp[0], ay - warp[1]
        ul = math.hypot(ux, uy) or 1
        d.update(warp=warp, unit=[ux / ul, uy / ul])
        d["dest"] = dragon_dash_dest(self.dragon_map, warp[0], warp[1], d["unit"][0], d["unit"][1])
        d["dash_len"] = math.hypot(d["dest"][0] - warp[0], d["dest"][1] - warp[1])
        d["aim_tms"] = now
        d["say_until"] = 0.0
        d["cooldown_until"] = now + D_CAST_MS + d["dash_len"] / D_DASH * 1000 + D_REST_MS + D_RAGE_MS
        return {"t": "dragon", "ev": "aim", "x": warp[0], "y": warp[1], "fx": d["pos"][0], "fy": d["pos"][1],
                "tx": ax, "ty": ay, "dx": d["dest"][0], "dy": d["dest"][1], "castMs": D_CAST_MS, "hp": d["hp"]}

    def _dragon_respawn(self, gen):
        out2 = leg_delay = None
        with self.lock:
            d = self.dragon
            if d["st"] != "dead" or d["gen"] != gen:   # 期間已有別的變動（例如伺服器重啟重建）
                return
            pos = dragon_edge(self.dragon_map, random.random() * math.pi * 2) if self.dragon_map else list(D_CENTER)
            d.update(st="idle", hp=D_HP, pos=pos, aim_tms=0.0, atk=[0, 0], wander=None, aggro=None)
            d["wander_gen"] += 1   # 作廢舊散步 tick
            out = {"t": "dragon", "ev": "spawn", "x": pos[0], "y": pos[1], "hp": d["hp"]}
            if self._has_grass_clients():
                out2 = self._dragon_start_leg()
                if out2:
                    leg_delay = (d["wander"]["tms"] + d["wander"]["pause"]) / 1000 + 0.05
            wgen = d["wander_gen"]
        self.broadcast(out, terrain=OWNER_TERRAIN)
        if out2:
            self.broadcast(out2, terrain=OWNER_TERRAIN)
        if leg_delay is not None:
            self._schedule_wander_tick(leg_delay, wgen)

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

    def terrain_of(self, cid):
        with self.lock:
            c = self.clients.get(cid)
            return c["terrain"] if c else None

    def enter(self, cid, v):
        """玩家進入地形 v。回傳 (舊地形, 同地形其他玩家快照, 該地形擺設, 家具, 島主快照或 None)；無變動回 None。"""
        with self.lock:
            c = self.clients.get(cid)
            if c is None or c["terrain"] == v:
                return None
            old, c["terrain"] = c["terrain"], v
            players = {k: dict(o["state"]) for k, o in self.clients.items()
                       if k != cid and o["terrain"] == v and o["state"]}
            dragon = None
            if v == OWNER_TERRAIN:   # 島主同步：進草島附帶當下的島主快照（客戶端據此續播任意階段）
                self.dragon_state()
                dragon = self.dragon_snapshot()
                if self.dragon["st"] == "idle":   # 有人進草島了：排一次 tick 恢復散步（沒人看時是停擺的）
                    self._schedule_wander_tick(1.0, self.dragon["wander_gen"])
            return old, players, list(self.furn_list(v)), self.deco_list(v), dragon

    # terrain 有給時只送給「目前在該地形」的連線；沒給就是全部
    def broadcast(self, msg, skip=None, terrain=None):
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
                        with c["send"]:
                            ws_send(sock, json.dumps({"t": "me", "admin": c["admin"]}))
                elif t == "state":
                    c = room.clients.get(cid)
                    st = msg.get("s") if isinstance(msg.get("s"), dict) else {}
                    # 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）
                    user = c.get("user") if c else None
                    if user:
                        st["name"], st["uid"] = user["name"], user["id"]
                    else:
                        st.pop("uid", None)
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
                    old, players, furn, decos, dragon = res
                    if old:   # leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
                        room.broadcast({"t": "leave", "id": cid, "to": v}, skip=cid, terrain=old)
                    with room.clients[cid]["send"]:
                        ws_send(sock, json.dumps({"t": "enter", "terrain": v, "players": players, "furn": furn, "decos": decos, "dragon": dragon}))
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
                elif t == "dragonMap":   # 島主：陸地位圖（各客戶端島形相同，誰上傳都一樣；後上傳的覆蓋也無妨）
                    land = dragon_land(msg.get("v"))
                    if land:
                        room.dragon_map = land
                elif t == "dragonHit":   # 打島主：驗證後廣播 hp/aim/dead/aggro 事件（回傳訊息清單）
                    now = time.time()
                    if now - last_dragon_hit < D_CD:
                        continue
                    res = room.dragon_hit(cid, msg)
                    if res:
                        last_dragon_hit = now
                        for m in res:
                            room.broadcast(m, terrain=OWNER_TERRAIN)
                elif t == "dragonSnap":   # 客戶端凍結恢復：回一份島主即時快照（只給這條連線）
                    c2 = room.clients.get(cid)
                    if c2 and c2.get("terrain") == OWNER_TERRAIN:
                        room.dragon_state()
                        snap = room.dragon_snapshot()
                        with c2["send"]:
                            ws_send(sock, json.dumps({"t": "dragon", "ev": "state", **snap}))
                elif t in ("commit", "place", "remove", "clear"):
                    # 裝飾模式的變動是草稿，按保存才送 commit（一批操作）；舊客戶端的單一操作也走同一套驗證與權限
                    cur = room.terrain_of(cid)
                    ops = msg.get("ops") if t == "commit" else [msg]
                    if cur and isinstance(ops, list):
                        c = room.clients.get(cid) or {}
                        applied, rejected, denied = room.commit_furn(cur, ops, c.get("admin", is_admin(None)))
                        with c["send"]:
                            ws_send(sock, json.dumps({"t": "commit_result", "applied": applied, "rejected": rejected, "denied": denied}))
                        if applied:
                            room.broadcast({"t": "furn", "items": list(room.furn_list(cur))}, terrain=cur)
                elif t == "event":   # 揮擊等瞬時事件
                    cur = room.terrain_of(cid)
                    if cur:
                        room.broadcast({"t": "event", "id": cid, "kind": msg.get("kind")}, skip=cid, terrain=cur)
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
