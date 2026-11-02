#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 本機開發伺服器（M1）
# 1) 服務 client/ 靜態檔
# 2) /api/config   -> 從 dev_config.json 讀 client_id
# 3) /api/token    -> 用 code+secret 向 Discord 兌換 access_token（secret 只在本機/伺服器端）
# 用法: python tools/dev_server.py  (先填 tools/dev_config.json)
import json, math, os, re, sys, base64, hashlib, hmac, struct, threading, time
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
        """玩家進入地形 v。回傳 (舊地形, 同地形其他玩家快照, 該地形擺設)；無變動回 None。"""
        with self.lock:
            c = self.clients.get(cid)
            if c is None or c["terrain"] == v:
                return None
            old, c["terrain"] = c["terrain"], v
            players = {k: dict(o["state"]) for k, o in self.clients.items()
                       if k != cid and o["terrain"] == v and o["state"]}
            return old, players, list(self.furn_list(v)), self.deco_list(v)

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
                    old, players, furn, decos = res
                    if old:   # leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
                        room.broadcast({"t": "leave", "id": cid, "to": v}, skip=cid, terrain=old)
                    with room.clients[cid]["send"]:
                        ws_send(sock, json.dumps({"t": "enter", "terrain": v, "players": players, "furn": furn, "decos": decos}))
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
