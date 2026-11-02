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
const SIGN_MAX = 100;        // 看板文字上限（字）
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
const D_DASH = 560;          // 龍衝速度 px/s（比仇恨追殺的 180 更快：高速掠過才有威嚇感）
const D_REST_MS = 700;       // 衝到底落地的停留時間
const D_WALK = 34;           // 閒晃散步速度 px/s（與 client 的 OWNER_WALK_SPEED 一致）
const D_WANDER_PAUSE = [1500, 4000];   // 每個路點之間站著休息的時間範圍 ms
const D_RAGE_MS = 12000;     // 龍衝冷卻：到點才能再觸發龍衝；冷卻期間被打進入仇恨追殺
const D_SAY_MS = 3000;       // 被打後先在原地說台詞的時間（說完才瞬移反擊）
const D_RESPAWN_MS = 30000;  // 島主被打倒後的重生秒數
const D_HP = 200;
const D_REGEN = 18;      // 島主每秒回血（用牆鐘 lazy 計算，DO 休眠也照補；約 7 人打不贏、8 人圍毆約 70 秒擊殺，client 的 OWNER_REGEN 與本機 dev_server 的 D_REGEN 要同值）
const D_CHASE = 180;         // 仇恨追殺速度 px/s（玩家走路 120／跑步 200：走路逃不掉，跑步才能拉開）
const D_CLAW_RANGE = 36;     // 爪擊範圍（前方扇形；約黃金肥龍大圖的 1/4）
const D_CLAW_MS = 1000;      // 爪擊間隔（每秒一下）
const D_CLAW_DMG = 2;        // 爪擊傷害（扣玩家 HP；被打倒由各客戶端自判，伺服器只廣播爪擊事件）
const D_AGGRO_MS = 5000;     // 仇恨換人週期：打牠的人有複數時，隨機換下一個攻擊者
const D_DROPOUT = 30000;     // 超過這時間沒有人攻擊島主：脫離仇恨回閒晃
const D_RANGE = 70;          // 玩家打島主的攻擊距離（客戶端 58，留延遲）
const D_DRIFT_TOLER = 600;   // 客戶端宣稱的龍位置與伺服器的最大容差（漏接一個路點事件的落後量）
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

// 地板層：每格一種地板（鍵＝y*COLS+x，值＝地板 id）。op＝{t:"floor", cell:[x,y], type:"wood"|null}（null＝拆除）
function applyFloorOp(floor, ids, op) {
  const cell = op.cell;
  if (!Array.isArray(cell) || cell.length !== 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return false;
  const [x, y] = cell;
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  const k = y * COLS + x;
  if (op.type === null) return floor.delete(k);
  if (typeof op.type !== "string" || !ids.has(op.type) || floor.get(k) === op.type) return false;
  floor.set(k, op.type);
  return true;
}
const floorToList = floor => [...floor].map(([k, id]) => [k % COLS, Math.floor(k / COLS), id]);

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
    this.floorIds = null;        // 地板 id 集合，由 floors.json 載入
    this.targets = null;         // 可破壞物件定義（tools.json 的 targets）
    this.lastHit = new Map();    // ws -> 上次打擊的時間
    this.dragonLoaded = false;   // 島主狀態只在第一次用到時從 storage 拉回（休眠後記憶體會清空）
    this.dragon = null;
    this.dragonMapLoaded = false;   // 島形位圖存在 storage（懒載入）——只放記憶體的話 DO 休眠後就沒了，打島主不會反擊
    this.dragonMap = null;
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
      this.furnDefs = new Map(man.items.map(it => [it.id, { w: it.w, h: it.h, text: !!it.text }]));
    } catch (e) {
      console.log("[furn] manifest 載入失敗", String(e));
      return new Map();          // 載入失敗就不接受擺放，下次再試
    }
    return this.furnDefs;
  }

  // 地板種類取自前端 floors.json
  async getFloorIds() {
    if (this.floorIds) return this.floorIds;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/floors/floors.json"));
      this.floorIds = new Set((await res.json()).items.map(it => it.id));
    } catch (e) {
      console.log("[floor] manifest 載入失敗", String(e));
      return new Set();
    }
    return this.floorIds;
  }

  async getFloor(terrain) {   // 儲存格式 [[x,y,id],…]；記憶體裡用 Map 方便逐格改
    return new Map(((await this.state.storage.get("floor:" + terrain)) || []).map(([x, y, id]) => [y * COLS + x, id]));
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
      await this.state.storage.setAlarm(Date.now() + 1000);   // 有人進草島了：1 秒後醒來恢復散步（alarm 會照 phase 自行安排）
    }
    ws.send(JSON.stringify({ t: "enter", terrain: v, players, furn: await this.getFurn(v), floor: floorToList(await this.getFloor(v)), decos, dragon }));
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
      if (land) {
        this.dragonMap = land;
        this.dragonMapLoaded = true;
        await this.state.storage.put("dragonMap", msg.v);   // 一定要存：DO 休眠會清空記憶體，沒存的話之後打島主不會反擊
      }
    } else if (msg.t === "dragonSnap") {   // 客戶端凍結恢復：回一份島主即時快照（只給這條連線，走 dragon 事件的 state）
      if (att.terrain === OWNER_TERRAIN) {
        await this.getDragon();
        ws.send(JSON.stringify({ t: "dragon", ev: "state", ...this.dragonSnapshot() }));
      }
    } else if (msg.t === "dragonHit") {
      await this.dragonHit(ws, att, msg);
    } else if (msg.t === "commit" || msg.t === "place" || msg.t === "remove" || msg.t === "clear") {
      // 舊客戶端的單一操作（place/remove/clear）也走同一套驗證與權限
      if (att.terrain) await this.commitFurn(ws, att, msg.t === "commit" ? msg.ops : [msg]);
    } else if (msg.t === "sign") {
      if (att.terrain) await this.editSign(ws, att, msg);
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
    if (!this.dragon) this.dragon = { hp: D_HP, st: "idle", pos: [...D_CENTER], aimTms: 0, deadAt: 0, wander: null, cooldownUntil: 0, sayUntil: 0, regenT: 0, aggro: null, lastHitAt: 0 };
    if (this.dragon.wander === undefined) this.dragon.wander = null;   // 舊存檔沒有這個欄位
    if (this.dragon.cooldownUntil === undefined) this.dragon.cooldownUntil = 0;
    if (this.dragon.sayUntil === undefined) this.dragon.sayUntil = 0;
    if (this.dragon.regenT === undefined) this.dragon.regenT = Date.now();   // 舊存檔從現在起算（不憑空補血）
    if (this.dragon.aggro === undefined) this.dragon.aggro = null;
    if (this.dragon.lastHitAt === undefined) this.dragon.lastHitAt = 0;
    return this.dragon;
  }
  saveDragon() { return this.state.storage.put("dragon", this.dragon); }
  // ---- 島主仇恨（龍衝冷卻期間的追殺行為；client 的演出在 ownerAggro 系列）----
  // D_DROPOUT（20 秒）內在草島打過島主、還在線上沒死的連線名單（仇恨換人從這裡隨機挑）
  aggroCandidates(now, win = D_DROPOUT) {
    const out = [];
    for (const [ws, t] of this.dragonHits) {
      if (now - t > win) continue;
      const att = ws.deserializeAttachment?.() || {};
      if (att.terrain === OWNER_TERRAIN && att.state && !att.state.dead) out.push(att);
    }
    return out;
  }
  // 依連線編號找仇恨目標（斷線／離開草島／死了就找不到）
  aggroTarget(id) {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id === id && att.terrain === OWNER_TERRAIN && att.state && !att.state.dead) return att;
    }
    return null;
  }
  // 開始/切換追殺目標：廣播 aggro 事件（id＝被鎖定的連線編號，客戶端用來鎖定自己）；存檔由呼叫端負責
  startAggro(now, att) {
    const d = this.dragon;
    d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
    d.wander = null;
    this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, OWNER_TERRAIN);
  }
  dropAggro(chill = true) {
    this.dragon.aggro = null;
    if (chill) this.broadcast({ t: "dragon", ev: "chill" }, null, OWNER_TERRAIN);
  }
  // 回血：每秒回 D_REGEN 點（用牆鐘 lazy 計算，不需要計時器；滿血或死亡時把錨點重置為現在，扣血後才重新開始累積）
  regenDragon(now) {
    const d = this.dragon;
    if (d.st === "dead" || d.hp >= D_HP) { d.regenT = now; return; }
    const n = Math.floor((now - d.regenT) / 1000);
    if (n > 0) {
      d.hp = Math.min(D_HP, d.hp + n * D_REGEN);
      d.regenT = d.hp >= D_HP ? now : d.regenT + n * 1000;
    }
  }
  // 島形位圖：玩家上傳後存 storage（懒載入）。各客戶端的島相同，誰上傳都一樣
  async getDragonMap() {
    if (!this.dragonMapLoaded) {
      this.dragonMapLoaded = true;
      const v = await this.state.storage.get("dragonMap");
      this.dragonMap = typeof v === "string" ? dragonLand(v) : null;
    }
    return this.dragonMap;
  }
  // 由 aimTms 推導現在的階段（閒置/瞬移鎖定/龍衝/停留/回中心），不需要每幀醒著跑
  dragonPhase(now) {
    const d = this.dragon;
    if (d.st === "dead") return ["dead", d.pos, 0];
    if (!d.aimTms) {
      if (d.sayUntil && now < d.sayUntil) return ["say", d.pos, d.sayUntil - now];   // 說台詞中：原地不動
      if (!d.wander) return ["idle", d.pos, 0];
      const t = Math.min(1, Math.max(0, (now - d.wander.t0) / d.wander.tms));
      return ["idle", [d.wander.fx + (d.wander.tx - d.wander.fx) * t, d.wander.fy + (d.wander.ty - d.wander.fy) * t], 0];
    }
    let dt = now - d.aimTms;
    if (dt < D_CAST_MS) return ["aim", d.warp, D_CAST_MS - dt];
    dt -= D_CAST_MS;
    const dashMs = d.dashLen / D_DASH * 1000;
    if (dt < dashMs) return ["dash", [d.warp[0] + d.unit[0] * (dt / 1000 * D_DASH), d.warp[1] + d.unit[1] * (dt / 1000 * D_DASH)], dashMs - dt];
    dt -= dashMs;
    if (dt < D_REST_MS) return ["rest", d.dest, D_REST_MS - dt];
    return ["idle", d.dest, 0];   // 衝完在對岸就地閒晃（不回中心）
  }
  // idle 開始的時間（沒被觸發過就是 0）；用於 D_RAGE_MS 冷卻
  dragonIdleAt() {
    const d = this.dragon;
    if (!d.aimTms) return 0;
    return d.aimTms + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS;
  }
  dragonSnapshot() {
    const now = Date.now();
    this.regenDragon(now);   // 讀快照前先把該補的血補上（快照帶 hp）
    const [ph, pos, ms] = this.dragonPhase(now);
    const d = this.dragon;
    const o = { ph, x: pos[0], y: pos[1], hp: d.hp };
    if (ph === "aim") { o.castMs = Math.round(ms); o.tx = d.atk[0]; o.ty = d.atk[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "dash") { o.ux = d.unit[0]; o.uy = d.unit[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "rest") o.restMs = Math.round(ms);
    if (ph === "say") o.sayMs = Math.round(ms);   // 說台詞中：附上剩餘時間
    if (ph === "idle" && d.wander) {   // 散步中：附上路點與已走時間，客戶端接著插值
      const w = d.wander;
      o.wleg = { fx: w.fx, fy: w.fy, tx: w.tx, ty: w.ty, tms: w.tms, el: Math.max(0, Math.min(w.tms, now - w.t0)) };
    }
    return o;
  }
  // 打到島主：扣血；若在閒置且冷卻過了 → 開始反擊（瞬移島緣鎖定攻擊者）
  async dragonHit(ws, att, msg) {
    if (!att.state || !att.terrain) return;
    const d = await this.getDragon();
    const now = Date.now();
    if (now - (this.dragonHits.get(ws) || 0) < D_CD_MS) return;
    if (d.st === "dead") return;
    this.regenDragon(now);   // 扣血前先把該補的血補上（之後廣播的 hp 是回血後的值）
    const dmg = Math.max(1, Math.min(2, Math.round(Number(msg.dmg) || 1)));
    const [ph, pos] = this.dragonPhase(now);
    if (ph === "dash") return;     // 衝刺中打不到（落地歇腳與散步時都打得到）
    // 客戶端可能漏接一個路點事件（散步腿落後）：只要它宣稱的龍位置離伺服器的不遠、且玩家貼著宣稱的龍，就接受
    const distSrv = Math.hypot(Number(msg.x) - pos[0], Number(msg.y) - pos[1]);
    const cdx = Number(msg.ddx), cdy = Number(msg.ddy);
    let near = distSrv <= D_RANGE;
    if (!near && Number.isFinite(cdx) && Number.isFinite(cdy)) {
      near = Math.hypot(Number(msg.x) - cdx, Number(msg.y) - cdy) <= D_RANGE
          && Math.hypot(cdx - pos[0], cdy - pos[1]) <= D_DRIFT_TOLER;
    }
    if (!near) return;
    this.dragonHits.set(ws, now);
    d.lastHitAt = now;   // 仇恨計時：D_DROPOUT 內沒有人再打牠就脫離追殺
    d.hp -= dmg;
    if (d.hp <= 0) {   // 打倒了：全島廣播死亡，30 秒後用鬧鐘重生
      d.st = "dead"; d.hp = 0; d.pos = [pos[0], pos[1]]; d.aimTms = 0; d.deadAt = now; d.wander = null; d.aggro = null;
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "dead", x: pos[0], y: pos[1] }, null, OWNER_TERRAIN);
      await this.scheduleDragonRespawn(d);
      return;
    }
    // 反擊：閒置且冷卻過了才觸發。一被打就先建立仇恨（20 秒從最後一次被打起算）；
    // 龍衝照樣先放：說台詞 → 瞬移島緣 → 龍衝，落地後不用再被打就馬上接著追殺同一個攻擊者
    const map = await this.getDragonMap();
    if (ph === "idle" && map && now >= (d.cooldownUntil || 0)) {
      d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
      d.sayUntil = now + D_SAY_MS;
      d.atk = [Number(msg.x), Number(msg.y)];   // 記住攻擊者位置，說完台詞後龍衝要穿過這裡
      d.wander = null;
      d.pos = [pos[0], pos[1]];   // 打斷散步腿：把位置同步到目前插值點（否則之後的追腿會從舊腿起點出發，client 看起來像瞬移）
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, OWNER_TERRAIN);
      this.broadcast({ t: "dragon", ev: "say", x: pos[0], y: pos[1], ms: D_SAY_MS }, null, OWNER_TERRAIN);
      await this.state.storage.setAlarm(d.sayUntil + 50);
      return;
    }
    // 龍衝冷卻中：把攻擊者納入仇恨（從 D_DROPOUT 內打過牠的人隨機挑一位開始追殺；已有目標時由 tick 負責換人）
    if (!d.aggro && ph === "idle" && now < (d.cooldownUntil || 0) && map) {
      const cands = this.aggroCandidates(now);
      if (cands.length) this.startAggro(now, cands[Math.floor(Math.random() * cands.length)]);
    }
    await this.saveDragon();   // 扣血就存（DO 休眠後才不會從上次存檔的 血量回復）
    this.broadcast({ t: "dragon", ev: "hp", hp: d.hp }, null, OWNER_TERRAIN);
    if (d.aggro && this.hasGrassPlayers()) await this.state.storage.setAlarm(now + 60);   // 仇恨開始：快點醒來追殺
  }
  // 仇恨狀態的 tick（鬧鐘）：追殺目標（每腿重新瞄準目標目前位置）、進爪擊範圍就站定每秒一抓、
  // 目標死了或 5 秒到隨機換攻擊者、龍衝 CD 一到自動放龍衝、超過 D_DROPOUT 沒人打就脫離仇恨回閒晃
  async aggroTick(now) {
    const d = this.dragon;
    const ag = d.aggro;
    await this.syncRegen(now);   // 帶傷回血同步：追殺途中沒人打牠時血條也要爬升
    const map = await this.getDragonMap();
    // 太久沒人攻擊／沒有島形：脫離仇恨；鬧鐘照 一般 idle 路徑（aggro 已清）走散步
    if (!map || now - (d.lastHitAt || 0) > D_DROPOUT) {
      this.dropAggro();
      await this.saveDragon();
      return this.scheduleFirstIdle(now);
    }
    let att = this.aggroTarget(ag.id);
    if (!att || now >= ag.rotateAt) {   // 目標死了或 5 秒到：隨機換下一個攻擊者（沒有其他人就維持原目標）
      const cands = this.aggroCandidates(now).filter(v => v.id !== ag.id);
      if (cands.length) {
        att = cands[Math.floor(Math.random() * cands.length)];
        ag.id = att.id; ag.rotateAt = now + D_AGGRO_MS;
        await this.saveDragon();
        this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, OWNER_TERRAIN);
      } else if (!att) {   // 目標死了又沒有其他人可換：脫離仇恨
        this.dropAggro();
        await this.saveDragon();
        return this.scheduleFirstIdle(now);
      }
    }
    // 龍衝冷卻到了：直接對現在的仇恨目標發動龍衝（瞬移島緣→預警→衝穿牠）；仇恨保持，落地後不用再被打就接著追殺
    if (now >= (d.cooldownUntil || 0)) {
      const [, pos2] = this.dragonPhase(now);
      d.wander = null;
      d.pos = [pos2[0], pos2[1]];   // 打斷追腿：位置同步到目前插值點（同 say 的理由）
      d.atk = [att.state.x, att.state.y];
      const ok = await this.startCycle(now);
      await this.saveDragon();
      if (ok) await this.state.storage.setAlarm(this.dragonIdleAt() + 100);
      else await this.scheduleFirstIdle(now);
      return;
    }
    const [ph2, pos] = this.dragonPhase(now);
    if (ph2 === "say") {   // 還在說台詞：說完（鬧鐘接手瞬移島緣）再醒，期間不追不抓
      await this.state.storage.setAlarm((d.sayUntil || now) + 80);
      return;
    }
    if (ph2 !== "idle") {   // 預警/龍衝/歇腳中：不追不抓、不發 wander（避免 client 的衝刺演出被 wander 事件打斷瞬移），等循環結束再醒
      const cycleEnd = d.aimTms + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS;
      await this.state.storage.setAlarm(Math.max(60, cycleEnd - now) + now + 80);
      return;
    }
    if (d.aimTms) {   // 龍衝循環剛結束（仇恨中沒有人清 aimTms）：落在對岸（dest），清掉讓之後的追腿正常插值
      d.aimTms = 0;
      d.pos = [...d.dest];
      await this.saveDragon();
    }
    const dist = Math.hypot(att.state.x - pos[0], att.state.y - pos[1]);
    if (dist <= D_CLAW_RANGE) {   // 進爪擊範圍：站定連抓（每秒一下）；記下位置，快照不會跳回舊點
      d.pos = [pos[0], pos[1]];
      d.wander = null;
      if (now >= ag.clawAt) {
        ag.clawAt = now + D_CLAW_MS;
        await this.saveDragon();
        this.broadcast({ t: "dragon", ev: "claw", x: pos[0], y: pos[1], tx: att.state.x, ty: att.state.y, id: att.id }, null, OWNER_TERRAIN);
      }
    } else {   // 追殺腿：接着上一腿走完就重新瞄準目標目前位置（ev: wander 重用同一套客户端插值）
      const w = d.wander;
      // 腿走完、或走了 0.6 秒就重新瞄準：緊咬目標現在的位置（否則龍只會抓到幾秒前的舊位置＝抓空氣）
      if (!w || now >= w.t0 + w.tms || now >= w.t0 + 600) {
        let tx = att.state.x, ty = att.state.y;
        // 不走海：龍在陸地時，直線前方連續 3 格是水就截在海邊（0.6 秒後的重新瞄準會繼續沿岸繞）；
        // 龍本來就在水裡（舊狀態卡海）則不截，直線走回陸地
        if (map) {
          const gx0 = Math.floor(pos[0] / CELL), gy0 = Math.floor(pos[1] / CELL);
          const onLand = gx0 >= 0 && gy0 >= 0 && gx0 < COLS && gy0 < ROWS && !!map[gy0 * COLS + gx0];
          const steps = Math.max(1, Math.ceil(Math.hypot(tx - pos[0], ty - pos[1]) / CELL));
          let water = 0;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const gx = Math.floor((pos[0] + (tx - pos[0]) * t) / CELL), gy = Math.floor((pos[1] + (ty - pos[1]) * t) / CELL);
            if (onLand && (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS || !map[gy * COLS + gx])) {
              if (++water >= 3) {   // 連續 3 格水：截在海邊最後的陸地
                const tt = Math.max(0, (s - water) / steps);
                tx = pos[0] + (tx - pos[0]) * tt;
                ty = pos[1] + (ty - pos[1]) * tt;
                break;
              }
            } else water = 0;
          }
        }
        const tms = Math.max(80, Math.round(Math.hypot(tx - pos[0], ty - pos[1]) / D_CHASE * 1000));
        d.wander = { fx: pos[0], fy: pos[1], tx, ty, tms, t0: now, pause: 0 };
        await this.saveDragon();
        this.broadcast({ t: "dragon", ev: "wander", fx: pos[0], fy: pos[1], tx, ty, tms }, null, OWNER_TERRAIN);
      }
    }
    // 下一個醒的時間：腿走完／爪擊／換人／龍衝 CD／脫離時限，取最近
    const w = d.wander;
    const ends = [ag.rotateAt, d.cooldownUntil || now, (d.lastHitAt || 0) + D_DROPOUT, ag.clawAt];
    if (w) ends.push(w.t0 + w.tms + 60);
    await this.state.storage.setAlarm(Math.max(60, Math.min(...ends) - now) + now + 25);
  }
  // 回血同步：補血後若 hp 有變化就廣播 hp 事件（lazy 回血只在被打／快照時結算，血條會卡住不動）
  async syncRegen(now) {
    const d = this.dragon;
    if (d.st === "dead" || d.hp >= D_HP) { this.regenDragon(now); return false; }
    const before = d.hp;
    this.regenDragon(now);
    if (d.hp !== before) {
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "hp", hp: d.hp }, null, OWNER_TERRAIN);
      return true;
    }
    return false;
  }
  // 仇恨結束後把鬧鐘排到不久後醒來，讓一般 idle 散步路徑接手
  async scheduleFirstIdle(now) {
    await this.state.storage.setAlarm(now + 100);
  }
  async scheduleDragonRespawn(d) {
    await this.state.storage.setAlarm((d.deadAt || Date.now()) + D_RESPAWN_MS);
  }
  // 草島上還有沒有人（沒人的話島主停擺省資源，有人進來再恢復散步）
  hasGrassPlayers() {
    for (const ws of this.state.getWebSockets()) {
      if ((ws.deserializeAttachment() || {}).terrain === OWNER_TERRAIN) return true;
    }
    return false;
  }
  // idle 時挑一個新路點散步：附近 6～16 格的隨機陸地，直線別太抄水（與 client 的 ownerPickLeg 一致）
  async startWanderLeg() {
    const d = this.dragon;
    const map = await this.getDragonMap();
    if (d.st === "dead" || !map) return null;
    const [, pos] = this.dragonPhase(Date.now());
    let fx = pos[0], fy = pos[1];
    // 卡海自救（舊狀態）：龍在海裡時先拉回最近的陸地，散步才挑得到路點
    const gx0 = Math.floor(fx / CELL), gy0 = Math.floor(fy / CELL);
    if (!(gx0 >= 0 && gy0 >= 0 && gx0 < COLS && gy0 < ROWS && map[gy0 * COLS + gx0])) {
      const land = this.nearestLand(fx, fy, map);
      if (land) { fx = land[0]; fy = land[1]; d.pos = [fx, fy]; }
    }
    for (let tries = 0; tries < 24; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = (6 + Math.random() * 10) * CELL;
      const tx = fx + Math.cos(ang) * dist, ty = fy + Math.sin(ang) * dist;
      const gx = jsRound(tx / CELL - .5), gy = jsRound(ty / CELL - .5);
      if (gx < 1 || gy < 1 || gx >= COLS - 1 || gy >= ROWS - 1) continue;
      if (!map[gy * COLS + gx]) continue;
      const steps = Math.max(1, Math.ceil(dist / CELL));
      let water = 0;
      for (let s = 0; s <= steps; s++) {
        const sx = fx + (tx - fx) * s / steps, sy = fy + (ty - fy) * s / steps;
        if (!map[Math.floor(sy / CELL) * COLS + Math.floor(sx / CELL)]) water++;
      }
      if (water / (steps + 1) > .1) continue;
      d.wander = { fx, fy, tx: gx * CELL + CELL / 2, ty: gy * CELL + CELL / 2,
                   tms: Math.max(1500, Math.round(dist / D_WALK * 1000)), t0: Date.now(),
                   pause: D_WANDER_PAUSE[0] + Math.round(Math.random() * (D_WANDER_PAUSE[1] - D_WANDER_PAUSE[0])) };
      this.broadcast({ t: "dragon", ev: "wander", fx: d.wander.fx, fy: d.wander.fy, tx: d.wander.tx, ty: d.wander.ty, tms: d.wander.tms }, null, OWNER_TERRAIN);
      return d.wander;
    }
    return null;   // 挑不到合適的路點：原地下次再試
  }
  // 從 (x,y) 找最近的陸地格中心（卡海自救用）；找不到回 null
  nearestLand(x, y, map) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx >= 0 && gy >= 0 && gx < COLS && gy < ROWS && map[gy * COLS + gx]) return [gx * CELL + CELL / 2, gy * CELL + CELL / 2];
    for (let r = 1; r <= 44; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只看外圈
          const nx = gx + dx, ny = gy + dy;
          if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && map[ny * COLS + nx]) {
            return [nx * CELL + CELL / 2, ny * CELL + CELL / 2];
          }
        }
      }
    }
    return null;
  }
  async scheduleWanderAlarm() {
    const w = this.dragon.wander;
    const d = this.dragon;
    let at = w ? w.t0 + w.tms + w.pause : Date.now() + 2000;   // 挑不到路點：2 秒後再試
    if (d.st !== "dead" && d.hp < D_HP) {   // 帶傷：散步鬧鐘提前到「回滿血時刻」，醒來補滿並廣播一次
      at = Math.min(at, d.regenT + Math.ceil((D_HP - d.hp) / D_REGEN) * 1000);
    }
    await this.state.storage.setAlarm(at + 50);
  }
  // 說完台詞：瞬移島緣鎖定 d.atk 的攻擊者，進入預警→龍衝循環。回傳是否成功啟動
  async startCycle(now) {
    const d = this.dragon;
    const map = await this.getDragonMap();
    if (d.st === "dead" || !map) return false;
    const warp = dragonEdge(map, Math.random() * Math.PI * 2);
    const ax = d.atk[0], ay = d.atk[1];
    const ux = ax - warp[0], uy = ay - warp[1];
    const ul = Math.hypot(ux, uy) || 1;
    d.warp = warp; d.unit = [ux / ul, uy / ul];
    d.dest = dragonDashDest(map, warp[0], warp[1], d.unit[0], d.unit[1]);
    d.dashLen = Math.hypot(d.dest[0] - warp[0], d.dest[1] - warp[1]);
    d.aimTms = now; d.sayUntil = 0;
    d.cooldownUntil = now + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS + D_RAGE_MS;
    await this.saveDragon();
    this.broadcast({ t: "dragon", ev: "aim", x: warp[0], y: warp[1], fx: d.pos[0], fy: d.pos[1], tx: ax, ty: ay, dx: d.dest[0], dy: d.dest[1], castMs: D_CAST_MS, hp: d.hp }, null, OWNER_TERRAIN);
    return true;
  }
  // 島主鬧鐘（唯一一個鬧鐘）：死→重生；說完台詞→開始反擊循環；閒置→推進散步路點；飛行循環中→回中心時再醒。
  // 草島沒有人在線時不排下一輪（島主停擺，等有人進草島的 enter 再恢復）。
  async alarm() {
    const d = await this.getDragon();
    const now = Date.now();
    if (d.st === "dead") {
      if (now < d.deadAt + D_RESPAWN_MS - 500) { await this.state.storage.setAlarm(d.deadAt + D_RESPAWN_MS); return; }
      const pos = this.dragonMap ? dragonEdge(this.dragonMap, Math.random() * Math.PI * 2) : [...D_CENTER];
      d.st = "idle"; d.hp = D_HP; d.pos = pos; d.aimTms = 0; d.wander = null; d.sayUntil = 0; d.aggro = null;
      await this.saveDragon();
      this.broadcast({ t: "dragon", ev: "spawn", x: pos[0], y: pos[1], hp: d.hp }, null, OWNER_TERRAIN);
      if (this.hasGrassPlayers()) {
        await this.startWanderLeg();
        await this.saveDragon();
        await this.scheduleWanderAlarm();
      }
      return;
    }
    if (!this.hasGrassPlayers()) return;   // 沒人看：停擺（enter 時會恢復）
    if (d.sayUntil && now >= d.sayUntil - 50) {   // 說完台詞：瞬移島緣，開始反擊循環
      d.sayUntil = 0;
      const ok = await this.startCycle(now);
      if (ok) await this.state.storage.setAlarm(this.dragonIdleAt() + 100);
      return;
    }
    if (d.sayUntil) {   // 還在說台詞：說完再醒
      await this.state.storage.setAlarm(d.sayUntil + 50);
      return;
    }
    const [ph] = this.dragonPhase(now);
    if (ph === "idle") {
      if (d.aggro) {   // 仇恨中：追殺（tick 自己排下一個鬧鐘）；保險：tick 出錯就清仇恨讓散步接手，不會卡死
        try { await this.aggroTick(now); }
        catch (e) { console.error("[dragon] aggroTick 錯誤：", e); d.aggro = null; await this.saveDragon(); await this.scheduleFirstIdle(now); }
        return;
      }
      if (d.aimTms) {   // 反擊循環剛結束：落在對岸（dest），清掉 aimTms 讓散步插值生效，從這裡接續
        d.aimTms = 0;
        d.pos = [...d.dest];
      }
      // 帶傷回血：補血；並把鬧鐘排到「回滿血的那一刻」醒來廣播一次（不用定期輪詢，省資源）
      const damaged = d.st !== "dead" && d.hp < D_HP;
      if (damaged) await this.syncRegen(now);
      const healedNow = damaged && d.hp >= D_HP;
      const w = d.wander;
      if (w && now < w.t0 + w.tms + w.pause) {   // 腿還沒走完／還在休息：照表再睡（帶傷時改到回滿血時刻醒）
        let at = w.t0 + w.tms + w.pause + 50;
        if (damaged && !healedNow) at = Math.min(at, d.regenT + Math.ceil((D_HP - d.hp) / D_REGEN) * 1000 + 50);
        await this.state.storage.setAlarm(at);
        return;
      }
      await this.startWanderLeg();
      await this.saveDragon();
      await this.scheduleWanderAlarm();
    } else {
      // 反擊循環中：回中心、idle 開始時醒來接著散步
      await this.state.storage.setAlarm(this.dragonIdleAt() + 100);
    }  }

  // 家具編輯：伺服器是唯一權威。裝飾模式的變動是「草稿」，客戶端按保存才送 commit（一批操作）；
  // 每個操作各自驗證（不合法的跳過，不影響其他），「清空」只有管理員能做。改完把整份清單廣播給同地形的人
  async commitFurn(ws, att, ops) {
    if (!Array.isArray(ops) || !att.terrain) return;
    const terrain = att.terrain, defs = await this.getFurnDefs();
    const items = await this.getFurn(terrain);
    let floor = null, floorIds = null, furnApplied = 0, floorApplied = 0;
    let applied = 0, rejected = 0, denied = false;
    for (const op of ops.slice(0, MAX_OPS)) {
      if (!op || typeof op !== "object") { rejected++; continue; }
      if (op.t === "floor") {      // 地板層：與家具各自獨立，不看家具、不看身分
        if (!floor) { floor = await this.getFloor(terrain); floorIds = await this.getFloorIds(); }
        if (applyFloorOp(floor, floorIds, op)) { applied++; floorApplied++; } else rejected++;
        continue;
      }
      if (op.t === "clear" && !att.admin) { denied = true; continue; }
      if (applyFurnOp(items, defs, op)) { applied++; furnApplied++; } else rejected++;
    }
    if (furnApplied) {
      await this.state.storage.put("furn:" + terrain, items);
      this.broadcast({ t: "furn", items }, null, terrain);
    }
    if (floorApplied) {
      await this.state.storage.put("floor:" + terrain, floorToList(floor));
      this.broadcast({ t: "floor", items: floorToList(floor) }, null, terrain);
    }
    try { ws.send(JSON.stringify({ t: "commit_result", applied, rejected, denied })); } catch { /* 對方已斷線 */ }
  }

  // 看板改字：所有人都能改（與一般家具同樣開放）。只接受 manifest 標了 text 的家具、文字最多 SIGN_MAX 字，改完廣播整份擺設
  async editSign(ws, att, msg) {
    const cell = msg.cell;
    if (!Array.isArray(cell) || cell.length !== 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return;
    const defs = await this.getFurnDefs(), items = await this.getFurn(att.terrain);
    const it = items.find(o => {
      const d = defs.get(o.type);
      return d && d.text && cell[0] >= o.cell[0] && cell[0] < o.cell[0] + d.w && cell[1] >= o.cell[1] && cell[1] < o.cell[1] + d.h;
    });
    if (!it) return;
    const text = String(msg.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, SIGN_MAX).trim();
    if (text) it.text = text; else delete it.text;
    await this.state.storage.put("furn:" + att.terrain, items);
    this.broadcast({ t: "furn", items }, null, att.terrain);
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
