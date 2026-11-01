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
const MAX_MSG = 2048;        // 單則訊息長度上限（字元）
const MAX_PLAYERS = 64;      // 一座島同時在線上限
const RATE_MAX = 40;         // 每條連線每秒最多處理幾則訊息（state 約 12 則/秒）
const TERRAIN_RE = /^[a-z0-9_-]{1,24}$/;
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
    server.send(JSON.stringify({ t: "init", id: seq }));
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
    ws.send(JSON.stringify({ t: "enter", terrain: v, players, furn: await this.getFurn(v) }));
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
      ws.serializeAttachment(att);
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
    } else if (msg.t === "place" || msg.t === "remove" || msg.t === "clear") {
      if (att.terrain) await this.editFurn(msg, att.terrain);
    } else if (msg.t === "event") {
      if (att.terrain) this.broadcast({ t: "event", id: att.id, kind: msg.kind }, ws, att.terrain);
    }
  }

  // 家具編輯：伺服器是唯一權威，改完把整份清單廣播給同地形的所有人（含發送者）
  async editFurn(msg, terrain) {
    let items = await this.getFurn(terrain);
    const cell = msg.cell;
    const validCell = Array.isArray(cell) && cell.length === 2 && Number.isInteger(cell[0]) && Number.isInteger(cell[1]);
    const defs = await this.getFurnDefs();

    if (msg.t === "place") {
      const def = defs.get(String(msg.type));
      if (!def || !validCell || items.length >= MAX_FURN) return;
      const [x, y] = cell;
      if (x < 0 || y < 0 || x + def.w > COLS || y + def.h > ROWS) return;
      for (const it of items) {
        const d = defs.get(it.type);
        if (!d) continue;
        if (x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h) return;
      }
      items.push({ type: String(msg.type), cell: [x, y] });
    } else if (msg.t === "remove") {
      if (!validCell) return;
      const i = items.findIndex(it => {
        const d = defs.get(it.type) || { w: 1, h: 1 };
        return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
      });
      if (i < 0) return;
      items.splice(i, 1);
    } else {
      items = [];
    }
    await this.state.storage.put("furn:" + terrain, items);
    this.broadcast({ t: "furn", items }, null, terrain);
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    this.rate.delete(ws);
    const att = ws.deserializeAttachment() || {};
    if (att.terrain) this.broadcast({ t: "leave", id: att.id }, ws, att.terrain);
  }
}
