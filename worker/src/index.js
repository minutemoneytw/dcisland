// DC島 — Cloudflare Worker 版伺服器
//   /api/config  給前端讀 client_id
//   /api/token   用 code 向 Discord 兌換 access_token，並順手回傳使用者名稱
//   /api/log     開發期信標（前端錯誤/步驟）→ 進 Worker 日誌（wrangler tail 可見）
//   /ws          WebSocket → Durable Object（一座島＝一個實例，鍵：guild:channel）
//   其他          前端靜態檔（由 [assets] 直接服務）

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// 與 client/js/main.js 的島尺寸一致（改一邊要改另一邊）
const COLS = 88, ROWS = 56;
const MAX_FURN = 500;        // 每個地形的擺設上限
const MAX_MSG = 16384;       // 單則訊息長度上限（字元）；裝飾模式的 commit 會一次帶多個操作
const MAX_OPS = 100;         // 一次 commit 最多處理幾個操作（超過的忽略，客戶端會分批送）
const MAX_PLAYERS = 64;      // 一座島同時在線上限
const RATE_MAX = 40;         // 每條連線每秒最多處理幾則訊息（state 約 12 則/秒）
const TERRAIN_RE = /^[a-z0-9_-]{1,24}$/;
const CELL = 32;             // 與 client/js/main.js 一致
const HIT_RANGE = 140;       // 打可破壞物件時，玩家離目標最遠幾 px（客戶端範圍 72，留給延遲）
const HIT_CD_MS = 300;       // 同一條連線兩次打擊最短間隔

// ---- 島主（伺服器端同步）----
// 野外動物維持刻意不同步；島主會撞死人，流程必須全島一致，由伺服器權威模擬：
// 被打 → 瞬移島緣 → 鎖定攻擊者 → 預警 1 秒 → 龍本體直線衝過島到對岸 → 停一下 → 飛回中心。
// 客戶端只負責演出（移動插值、預警虛線）和自己有沒有被撞到的判定（受害者自己死，死亡照既有 state.dead 同步）。
// 伺服器本來不知道島的形狀（世界由前端種子生成），由玩家上傳陸地位圖（RLE）；各客戶端的島相同，誰上傳都一樣。
const OWNER_TERRAIN = "grass";
const D_CAST_MS = 1000;      // 島緣鎖定（預警）持續時間
const D_DASH = 460;          // 龍衝速度 px/s
const D_REST_MS = 700;       // 衝到底落地的停留時間
const D_FLY = 240;           // 回中心飛行速度 px/s
const D_RAGE_MS = 5000;      // 反擊結束後多久內不被再觸發
const D_RESPAWN_MS = 30000;  // 島主被打倒後的重生秒數
const D_HP = 30;
const D_RANGE = 70;          // 玩家打島主的攻擊距離（客戶端 58，留延遲）
const D_CD_MS = 300;         // 同一條連線兩次打島主的最短間隔
const D_CENTER = [(COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL];
const jsRound = v => Math.floor(v + .5);   // 與前端 Math.round 同義（明寫以防其他語言實作四捨五入規則不同）

function dragonLand(v) {   // RLE 位圖 → Uint8Array（1＝陸地）；回 null 表示格式錯
  if (typeof v !== "string" || v.length > 20000) return null;
  const p = v.split(":");
  const land = new Uint8Array(COLS * ROWS);
  let val = p[0] === "1" ? 1 : 0, i = 0;
  for (let k = 1; k < p.length; k++) {
    const n = Number(p[k]);
    if (!(n > 0) || i + n > COLS * ROWS) return null;
    land.fill(val, i, i + n); i += n; val ^= 1;
  }
  return i === COLS * ROWS ? land : null;
}
// 島心沿角度找最後一格陸地（島緣）；演算法與 client/js/main.js 相同，兩邊結果一致
function dragonEdge(map, angle) {
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let last = [cx, cy];
  for (let r = 1; r <= 44; r++) {
    const x = jsRound(cx + ux * r), y = jsRound(cy + uy * r);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
    if (!map[y * COLS + x]) break;
    last = [x, y];
  }
  return [last[0] * CELL + CELL / 2, last[1] * CELL + CELL / 2];
}
// 龍衝終點：沿方向找最後一格陸地（島邊緣對岸）
function dragonDashDest(map, fx, fy, ux, uy) {
  const gx = Math.floor(fx / CELL), gy = Math.floor(fy / CELL);
  let last = [gx, gy];
  for (let r = 1; r <= 50; r++) {
    const x = jsRound(gx + ux * r), y = jsRound(gy + uy * r);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
    if (!map[y * COLS + x]) break;
    last = [x, y];
  }
  return [last[0] * CELL + CELL / 2, last[1] * CELL + CELL / 2];
}

// 管理員：Worker 環境變數 ADMIN_IDS（逗號分隔的 Discord 使用者 ID）。沒設就沒有管理員
function isAdminId(env, id) {
  return !!id && String(env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).includes(String(id));
}

// 對一份擺設清單套用單一操作（place / remove / clear），成功回 true。清空的權限在呼叫端檢查
function applyFurnOp(items, defs, op) {
  const cell = op.cell;
  const validCell = Array.isArray(cell) && cell.length === 2 && Number.isInteger(cell[0]) && Number.isInteger(cell[1]);
  if (op.t === "place") {
    const def = defs.get(String(op.type));
    if (!def || !validCell || items.length >= MAX_FURN) return false;
    const [x, y] = cell;
    if (x < 0 || y < 0 || x + def.w > COLS || y + def.h > ROWS) return false;
    for (const it of items) {
      const d = defs.get(it.type);
      if (!d) continue;
      if (x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h) return false;
    }
    items.push({ type: String(op.type), cell: [x, y] });
    return true;
  }
  if (op.t === "remove") {
    if (!validCell) return false;
    const i = items.findIndex(it => {
      const d = defs.get(it.type) || { w: 1, h: 1 };
      return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
    });
    if (i < 0) return false;
    items.splice(i, 1);
    return true;
  }
  if (op.t === "clear") { items.length = 0; return true; }
  return false;
}

// 該格有沒有家具（家具佔 w×h 格）
function cellHasFurn(items, defs, cell) {
  return items.some(it => {
    const d = defs.get(it.type) || { w: 1, h: 1 };
    return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
  });
}
const SESSION_TTL_MS = 12 * 3600 * 1000;   // 簽章憑證有效期

// ---- 身分憑證：/api/token 兌換成功後簽發，/ws 的 hello 訊息驗證 ----
// 格式：base64url(JSON{id,name,exp}) + "." + base64url(HMAC-SHA256)；密鑰為 env.SESSION_SECRET
// 沒設密鑰時不簽發（維持訪客模式），不影響既有功能。
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signSession(env, user) {
  if (!env.SESSION_SECRET || !user) return null;
  const body = b64u(new TextEncoder().encode(JSON.stringify({ id: String(user.id), name: String(user.name), exp: Date.now() + SESSION_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(body));
  return body + "." + b64u(sig);
}

// 驗證成功回 {id,name}，否則 null
async function verifySession(env, token) {
  if (!env.SESSION_SECRET || typeof token !== "string" || token.length > 1024) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), unb64u(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const u = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!u.id || !u.name || !(u.exp > Date.now())) return null;
    return { id: u.id, name: u.name };
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      return json({ client_id: env.DISCORD_CLIENT_ID || "" });
    }

    if (url.pathname === "/api/log") {
      const body = await request.text();
      console.log("[beacon]", body.slice(0, 500));
      return json({ ok: true });
    }

    if (url.pathname === "/api/token" && request.method === "POST") {
      return exchangeToken(request, env);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const room = (url.searchParams.get("room") || "local").slice(0, 120);
      const stub = env.ISLANDS.get(env.ISLANDS.idFromName(room));
      return stub.fetch(request);
    }

    // 靜態檔（多半不會走到這裡；[assets] 會先處理）
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("not found", { status: 404 });
  },
};

async function exchangeToken(request, env) {
  let code = "";
  try { code = (await request.json()).code || ""; } catch { /* 空 body */ }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return json({ error: "尚未設定 DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET" }, 500);
  }

  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  const tok = await res.json();
  if (!res.ok) return json({ error: "discord", status: res.status, detail: tok }, 400);

  // 順手問「這是誰」，前端就不必再對外連線（也免 URL Mapping）
  let user = null;
  if (tok.access_token) {
    try {
      const r = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: "Bearer " + tok.access_token },
      });
      if (r.ok) {
        const me = await r.json();
        user = { id: me.id, name: me.global_name || me.username };
      }
    } catch { /* 名字拿不到不影響上島 */ }
  }
  return json({ access_token: tok.access_token, scope: tok.scope, user, session: await signSession(env, user) });
}

// ============ 一座島 ============
// 用 WebSocket Hibernation：沒人講話時 DO 可以休眠，不計費也省資源
export class Island {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rate = new Map();       // ws -> {sec, n}；休眠醒來會重置，無妨
    this.furnDefs = null;        // id -> {w,h}，由 furniture.json 載入
    this.targets = null;         // 可破壞物件定義（tools.json 的 targets）
    this.lastHit = new Map();    // ws -> 上次打擊的時間
    this.dragonLoaded = false;   // 島主狀態只在第一次用到時從 storage 拉回（休眠後記憶體會清空）
    this.dragon = null;
    this.dragonMap = null;       // 陸地位圖（玩家上傳，來源的島到處都一樣就對了）
    this.dragonHits = new Map(); // ws -> 上次打島主的時間
  }

  // 可破壞物件的血量/重生秒數取自前端 tools.json
  async getTargets() {
    if (this.targets) return this.targets;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/tools/tools.json"));
      this.targets = (await res.json()).targets || {};
    } catch (e) {
      console.log("[deco] tools.json 載入失敗", String(e));
      return {};
    }
    return this.targets;
  }

  // 每個地形一份「受損/已破壞」的可破壞物件：{ 物件編號: {hp, cell, until} }（沒受損的不存）
  async getDecos(terrain) {
    return (await this.state.storage.get("deco:" + terrain)) || {};
  }

  // 已破壞、到了重生時間、且該格沒有家具的 → 回到滿血（移除紀錄）
  async pruneDecos(terrain, map) {
    const items = await this.getFurn(terrain), defs = await this.getFurnDefs();
    let changed = false;
    for (const [i, e] of Object.entries(map)) {
      if (e.hp <= 0 && e.until <= Date.now() && !cellHasFurn(items, defs, e.cell)) { delete map[i]; changed = true; }
    }
    if (changed) await this.state.storage.put("deco:" + terrain, map);
    return map;
  }

  decoList(map) {
    return Object.entries(map).map(([i, e]) => ({ i: Number(i), hp: e.hp, ttl: e.hp <= 0 ? Math.max(0, e.until - Date.now()) : 0 }));
  }

  // 家具尺寸取自前端 manifest，伺服器據此驗證擺放
  async getFurnDefs() {
    if (this.furnDefs) return this.furnDefs;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/furniture/furniture.json"));
      const man = await res.json();
      this.furnDefs = new Map(man.items.map(it => [it.id, { w: it.w, h: it.h }]));
    } catch (e) {
      console.log("[furn] manifest 載入失敗", String(e));
      return new Map();          // 載入失敗就不接受擺放，下次再試
    }
    return this.furnDefs;
  }

  async getFurn(terrain) {
    return (await this.state.storage.get("furn:" + terrain)) || [];
  }

  async fetch(request) {
    if (this.state.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("island full", { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 連線編號（島內遞增）
    const seq = ((await this.state.storage.get("seq")) || 0) + 1;
    await this.state.storage.put("seq", seq);
    server.serializeAttachment({ id: seq });

    this.state.acceptWebSocket(server);

    // 剛連上時還沒進任何地形（terrain 為空）：看不到也不被看到，等客戶端送 enter
    server.send(JSON.stringify({ t: "init", id: seq, admin: false }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // terrain 有給時只送給「目前在該地形」的連線；沒給就是全部
  broadcast(msg, skip, terrain) {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip) continue;
      if (terrain !== undefined && (ws.deserializeAttachment() || {}).terrain !== terrain) continue;
      try { ws.send(data); } catch { /* 對方已斷線 */ }
    }
  }

  // 玩家進入某地形：每個人各自在自己的地形，只有同地形的人看得到彼此
  async enter(ws, att, v) {
    if (!TERRAIN_RE.test(v) || att.terrain === v) return;
    const old = att.terrain;
    // leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
    if (old) this.broadcast({ t: "leave", id: att.id, to: v }, ws, old);
    att.terrain = v;
    ws.serializeAttachment(att);

    const players = {};
    for (const o of this.state.getWebSockets()) {
      if (o === ws) continue;
      const oa = o.deserializeAttachment() || {};
      if (oa.terrain === v && oa.state) players[oa.id] = oa.state;
    }
    await this.getFurnDefs();     // 先載入（pruneDecos 會用到）
    const decos = this.decoList(await this.pruneDecos(v, await this.getDecos(v)));
    let dragon;
    if (v === OWNER_TERRAIN) {    // 島主同步：進草島時給一份當下的島主快照（重算現在的階段）
      await this.getDragon();
      dragon = this.dragonSnapshot();
    }
    ws.send(JSON.stringify({ t: "enter", terrain: v, players, furn: await this.getFurn(v), decos, dragon }));
    this.broadcast({ t: "join", id: att.id, name: att.state && att.state.name }, ws, v);
    if (att.state) this.broadcast({ t: "p", id: att.id, s: att.state }, ws, v);
  }

  // 簡易限流：超過就丟棄，不回應
  overRate(ws) {
    const sec = Math.floor(Date.now() / 1000);
    let r = this.rate.get(ws);
    if (!r || r.sec !== sec) r = { sec, n: 0 };
    r.n++;
    this.rate.set(ws, r);
    return r.n > RATE_MAX;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    if (this.overRate(ws)) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const att = ws.deserializeAttachment() || {};

    if (msg.t === "hello") {
      // 帶簽章憑證表明身分；驗證失敗就維持訪客
      att.user = await verifySession(this.env, msg.s);
      att.admin = !!att.user && isAdminId(this.env, att.user.id);
      ws.serializeAttachment(att);
      ws.send(JSON.stringify({ t: "me", admin: att.admin }));
    } else if (msg.t === "state") {
      const s = msg.s && typeof msg.s === "object" ? msg.s : {};
      // 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）
      if (att.user) { s.name = att.user.name; s.uid = att.user.id; } else delete s.uid;
      att.state = s;
      ws.serializeAttachment(att);
      if (att.terrain) this.broadcast({ t: "p", id: att.id, s }, ws, att.terrain);
    } else if (msg.t === "enter" || msg.t === "terrain") {
      // "terrain" 是舊客戶端的訊息名，當作 enter 處理
      await this.enter(ws, att, String(msg.v));
    } else if (msg.t === "hit") {
      await this.hitDeco(ws, att, msg);
    } else if (msg.t === "dragonMap") {   // 島主：陸地位圖（各客戶端島形相同，誰上傳都一樣；後上傳的覆蓋也無妨）
      const land = dragonLand(msg.v);
      if (land) this.dragonMap = land;
    } else if (msg.t === "dragonHit") {
      await this.dragonHit(ws, att, msg);
    } else if (msg.t === "commit" || msg.t === "place" || msg.t === "remove" || msg.t === "clear") {
      // 舊客戶端的單一操作（place/remove/clear）也走同一套驗證與權限
      if (att.terrain) await this.commitFurn(ws, att, msg.t === "commit" ? msg.ops : [msg]);
    } else if (msg.t === "event") {
      if (att.terrain) this.broadcast({ t: "event", id: att.id, kind: msg.kind }, ws, att.terrain);
    }
  }

  // 打可破壞物件：血量由伺服器扣，改完廣播給同地形的所有人（含打的人）
  // 物件編號（i）是客戶端依地形種子確定性產生的順序；伺服器不重建世界，只驗證格式、距離與目標種類
  async hitDeco(ws, att, msg) {
    const terrain = att.terrain, cell = msg.cell, i = msg.i;
    if (!terrain || !att.state) return;
    if (!Number.isInteger(i) || i < 0 || i >= 5000) return;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger) || cell[0] < 0 || cell[1] < 0 || cell[0] >= COLS || cell[1] >= ROWS) return;
    const now = Date.now();
    if (now - (this.lastHit.get(ws) || 0) < HIT_CD_MS) return;
    const tgt = (await this.getTargets())[String(msg.sprite)];
    if (!tgt) return;
    const dx = cell[0] * CELL + CELL / 2 - att.state.x, dy = (cell[1] + .5) * CELL - att.state.y;
    if (!(Math.hypot(dx, dy) <= HIT_RANGE)) return;     // 也擋掉 NaN／缺座標
    this.lastHit.set(ws, now);

    await this.getFurnDefs();
    const map = await this.pruneDecos(terrain, await this.getDecos(terrain));
    const e = map[i] || { hp: tgt.hp, cell };
    if (e.hp <= 0) return;                               // 已經壞了
    e.hp -= 1; e.cell = cell;
    const ttl = (tgt.respawn || 60) * 1000;
    if (e.hp <= 0) e.until = now + ttl;
    map[i] = e;
    await this.state.storage.put("deco:" + terrain, map);
    this.broadcast({ t: "deco", i, hp: e.hp, ttl: e.hp <= 0 ? ttl : 0, by: att.id }, null, terrain);
  }

  // ---- 島主（伺服器端同步）----
  async getDragon() {
    if (!this.dragonLoaded) {
      this.dragonLoaded = true;
      this.dragon = await this.state.storage.get("dragon") || null;
      if (this.dragon && this.dragon.st === "dead") await this.scheduleDragonRespawn(this.dragon);   // 休眠醒來仍在死，把鬧鐘補回來
    }
    if (!this.dragon) this.dragon = { hp: D_HP, st: "idle", pos: [...D_CENTER], aimTms: 0, deadAt: 0 };
    return this.dragon;
  }
  saveDragon() { return this.state.storage.put("dragon", this.dragon); }
  // 由 aimTms 推導現在的階段（閒置/瞬移鎖定/龍衝/停留/回中心），不需要每幀醒著跑
  dragonPhase(now) {
    const d = this.dragon;
    if (d.st === "dead") return ["dead", d.pos, 0];
    if (!d.aimTms) return ["idle", d.pos, 0];
    let dt = now - d.aimTms;
    if (dt < D_CAST_MS) return ["aim", d.warp, D_CAST_MS - dt];
    dt -= D_CAST_MS;
    const dashMs = d.dashLen / D_DASH * 1000;
    if (dt < dashMs) return ["dash", [d.warp[0] + d.unit[0] * (dt / 1000 * D_DASH), d.warp[1] + d.unit[1] * (dt / 1000 * D_DASH)], dashMs - dt];
    dt -= dashMs;
    if (dt < D_REST_MS) return ["rest", d.dest, D_REST_MS - dt];
    dt -= D_REST_MS;
    const hx = D_CENTER[0] - d.dest[0], hy = D_CENTER[1] - d.dest[1];
    const hhyp = Math.hypot(hx, hy) || 1, homeMs = hhyp / D_FLY * 1000;
    if (dt < homeMs) return ["gohome", [d.dest[0] + hx / hhyp * (dt / 1000 * D_FLY), d.dest[1] + hy / hhyp * (dt / 1000 * D_FLY)], homeMs - dt];
    return ["idle", D_CENTER, 0];
  }
  // idle 開始的時間（沒被觸發過就是 0）；用於 D_RAGE_MS 冷卻
  dragonIdleAt() {
    const d = this.dragon;
    if (!d.aimTms) return 0;
    return d.aimTms + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS + Math.hypot(D_CENTER[0] - d.dest[0], D_CENTER[1] - d.dest[1]) / D_FLY * 1000;
  }
  dragonSnapshot() {
    const now = Date.now();
    const [ph, pos, ms] = this.dragonPhase(now);
    const d = this.dragon;
    const o = { ph, x: pos[0], y: pos[1], hp: d.hp };
    if (ph === "aim") { o.castMs = Math.round(ms); o.tx = d.atk[0]; o.ty = d.atk[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "dash") { o.ux = d.unit[0]; o.uy = d.unit[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "rest") o.restMs = Math.round(ms);
    return o;
  }
  // 打到島主：扣血；若在閒置且冷卻過了 → 開始反擊（瞬移島緣鎖定攻擊者）
  async dragonHit(ws, att, msg) {
    if (!att.state || !att.terrain) return;
    const d = await this.getDragon();
    const now = Date.now();
    if (now - (this.dragonHits.get(ws) || 0) < D_CD_MS) return;
    if (d.st === "dead") return;
    const dmg = Math.max(1, Math.min(2, Math.round(Number(msg.dmg) || 1)));
    const [ph, pos] = this.dragonPhase(now);
    if (ph === "dash" || ph === "gohome") return;     // 飛行中打不到
    if (!(Math.hypot(Number(msg.x) - pos[0], Number(msg.y) - pos[1]) <= D_RANGE)) return;
    this.dragonHits.set(ws, now);
    d.hp -= dmg;
    if (d.hp <= 0) {   // 打倒了：全島廣播死亡，30 秒後用鬧鐘重生
      d.st = "dead"; d.hp = 0; d.pos = [pos[0], pos[1]]; d.aimTms = 0; d.deadAt = now;
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "dead", x: pos[0], y: pos[1] }, null, OWNER_TERRAIN);
      await this.scheduleDragonRespawn(d);
      return;
    }
    // 反擊：閒置且冷卻過了才觸發；沒有島形位圖就只能扣血（無法挑島緣）
    const idleAt = this.dragonIdleAt(now);
    if (ph === "idle" && this.dragonMap && now - idleAt >= D_RAGE_MS) {
      const warp = dragonEdge(this.dragonMap, Math.random() * Math.PI * 2);          // 島隨機邊緣
      const ux = Number(msg.x) - warp[0], uy = Number(msg.y) - warp[1];
      const ul = Math.hypot(ux, uy) || 1;
      d.warp = warp; d.atk = [Number(msg.x), Number(msg.y)];
      d.unit = [ux / ul, uy / ul];
      d.dest = dragonDashDest(this.dragonMap, warp[0], warp[1], d.unit[0], d.unit[1]);
      d.dashLen = Math.hypot(d.dest[0] - warp[0], d.dest[1] - warp[1]);
      d.aimTms = now;
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "aim", x: warp[0], y: warp[1], fx: pos[0], fy: pos[1], tx: d.atk[0], ty: d.atk[1], dx: d.dest[0], dy: d.dest[1], castMs: D_CAST_MS, hp: d.hp }, null, OWNER_TERRAIN);
      return;
    }
    await this.saveDragon();   // 扣血就存（DO 休眠後才不會從上次存檔的 血量回復）
    this.broadcast({ t: "dragon", ev: "hp", hp: d.hp }, null, OWNER_TERRAIN);
  }
  async scheduleDragonRespawn(d) {
    await this.state.storage.setAlarm((d.deadAt || Date.now()) + D_RESPAWN_MS);
  }
  // 島主重生鬧鐘（Durable Object 鬧鐘；休眠時也會準時醒）
  async alarm() {
    const d = await this.getDragon();
    if (d.st !== "dead" || Date.now() < d.deadAt + D_RESPAWN_MS - 500) return;
    const pos = this.dragonMap ? dragonEdge(this.dragonMap, Math.random() * Math.PI * 2) : [...D_CENTER];
    d.st = "idle"; d.hp = D_HP; d.pos = pos; d.aimTms = 0;
    await this.saveDragon();
    this.broadcast({ t: "dragon", ev: "spawn", x: pos[0], y: pos[1], hp: d.hp }, null, OWNER_TERRAIN);
  }

  // 家具編輯：伺服器是唯一權威。裝飾模式的變動是「草稿」，客戶端按保存才送 commit（一批操作）；
  // 每個操作各自驗證（不合法的跳過，不影響其他），「清空」只有管理員能做。改完把整份清單廣播給同地形的人
  async commitFurn(ws, att, ops) {
    if (!Array.isArray(ops) || !att.terrain) return;
    const terrain = att.terrain, defs = await this.getFurnDefs();
    const items = await this.getFurn(terrain);
    let applied = 0, rejected = 0, denied = false;
    for (const op of ops.slice(0, MAX_OPS)) {
      if (!op || typeof op !== "object") { rejected++; continue; }
      if (op.t === "clear" && !att.admin) { denied = true; continue; }
      if (applyFurnOp(items, defs, op)) applied++; else rejected++;
    }
    if (applied) {
      await this.state.storage.put("furn:" + terrain, items);
      this.broadcast({ t: "furn", items }, null, terrain);
    }
    try { ws.send(JSON.stringify({ t: "commit_result", applied, rejected, denied })); } catch { /* 對方已斷線 */ }
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    this.rate.delete(ws);
    this.lastHit.delete(ws);
    const att = ws.deserializeAttachment() || {};
    if (att.terrain) this.broadcast({ t: "leave", id: att.id }, ws, att.terrain);
  }
}
