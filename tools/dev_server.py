#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 本機開發伺服器（M1）
# 1) 服務 client/ 靜態檔
# 2) /api/config   -> 從 dev_config.json 讀 client_id
# 3) /api/token    -> 用 code+secret 向 Discord 兌換 access_token（secret 只在本機/伺服器端）
# 用法: python tools/dev_server.py  (先填 tools/dev_config.json)
import json, os, re, sys, base64, hashlib, hmac, struct, threading, time
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
MAX_MSG = 2048
MAX_PLAYERS = 64
RATE_MAX = 40
TERRAIN_RE = re.compile(r"^[a-z0-9_-]{1,24}$")

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
        self.terrain = "grass"  # 島的固定地形（之後可由島主/管理切換），不隨進場順序改變
        self.furn = {}          # 地形 -> [{"type","cell":[x,y]}]，擺設依地形各自一份

    def furn_list(self, terrain=None):
        return self.furn.setdefault(terrain or self.terrain, [])

    def edit_furn(self, msg):
        """家具編輯（伺服器為唯一權威）。回傳 True 表示有變動。呼叫時需持有 self.lock。"""
        defs, items, t = furn_defs(), self.furn_list(), msg.get("t")
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

    def add(self, sock):
        with self.lock:
            if len(self.clients) >= MAX_PLAYERS:
                return None
            self.order += 1
            cid = self.order
            self.clients[cid] = {"sock": sock, "send": threading.Lock(), "state": {}}
            snapshot = {c: dict(v["state"]) for c, v in self.clients.items() if v["state"]}
            return cid, snapshot, self.terrain, list(self.furn_list())

    def remove(self, cid):
        with self.lock:
            self.clients.pop(cid, None)

    def snapshot_except(self, cid):
        with self.lock:
            return {c: dict(v["state"]) for c, v in self.clients.items() if c != cid and v["state"]}

    def broadcast(self, msg, skip=None):
        data = json.dumps(msg)
        with self.lock:
            targets = [(c, v["sock"], v["send"]) for c, v in self.clients.items() if c != skip]
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
        added = room.add(sock)
        if added is None:   # 島滿了：直接關閉連線，客戶端會自動退讓重連
            self.close_connection = True
            return
        cid, snapshot, terrain, furn = added
        print(f"[ws] +{cid} @{room_name}（{len(room.clients)} 人在線）", file=sys.stderr, flush=True)
        win_sec, win_n = 0, 0
        try:
            ws_send(sock, json.dumps({"t": "init", "id": cid, "players": snapshot, "terrain": terrain, "furn": furn}))
            room.broadcast({"t": "join", "id": cid}, skip=cid)
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
                    # 地形只由明確的 terrain 訊息改變，不從狀態封包推斷
                    room.broadcast({"t": "p", "id": cid, "s": st}, skip=cid)
                elif t == "terrain":
                    v = str(msg.get("v"))
                    if not TERRAIN_RE.match(v):
                        continue
                    room.terrain = v
                    room.broadcast({"t": "terrain", "v": v}, skip=cid)
                    # 擺設依地形各自一份：切地形後讓所有人換成該地形的擺設
                    room.broadcast({"t": "furn", "items": list(room.furn_list())})
                elif t in ("place", "remove", "clear"):
                    with room.lock:
                        changed = room.edit_furn(msg)
                    if changed:
                        room.broadcast({"t": "furn", "items": list(room.furn_list())})
                elif t == "event":   # 揮擊等瞬時事件
                    room.broadcast({"t": "event", "id": cid, "kind": msg.get("kind")}, skip=cid)
        except Exception as e:
            print(f"[ws] !{cid} {e}", file=sys.stderr, flush=True)
        finally:
            room.remove(cid)
            room.broadcast({"t": "leave", "id": cid})
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
