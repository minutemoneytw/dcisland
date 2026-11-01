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
  return json({ access_token: tok.access_token, scope: tok.scope, user });
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

    // 島的地形：固定存在 DO 儲存，不隨進場順序改變
    const terrain = (await this.state.storage.get("terrain")) || "grass";

    // 現有玩家快照
    const players = {};
    for (const ws of this.state.getWebSockets()) {
      if (ws === server) continue;
      const att = ws.deserializeAttachment();
      if (att && att.state) players[att.id] = att.state;
    }

    const furn = await this.getFurn(terrain);
    server.send(JSON.stringify({ t: "init", id: seq, players, terrain, furn }));
    this.broadcast({ t: "join", id: seq }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg, skip) {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip) continue;
      try { ws.send(data); } catch { /* 對方已斷線 */ }
    }
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

    if (msg.t === "state") {
      att.state = msg.s || {};
      ws.serializeAttachment(att);
      this.broadcast({ t: "p", id: att.id, s: msg.s }, ws);
    } else if (msg.t === "terrain") {
      const v = String(msg.v);
      if (!TERRAIN_RE.test(v)) return;
      await this.state.storage.put("terrain", v);
      this.broadcast({ t: "terrain", v }, ws);
      // 擺設依地形各自一份：切地形後讓所有人換成該地形的擺設
      this.broadcast({ t: "furn", items: await this.getFurn(v) }, null);
    } else if (msg.t === "place" || msg.t === "remove" || msg.t === "clear") {
      await this.editFurn(msg);
    } else if (msg.t === "event") {
      this.broadcast({ t: "event", id: att.id, kind: msg.kind }, ws);
    }
  }

  // 家具編輯：伺服器是唯一權威，改完把整份清單廣播給所有人（含發送者）
  async editFurn(msg) {
    const terrain = (await this.state.storage.get("terrain")) || "grass";
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
    this.broadcast({ t: "furn", items }, null);
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    this.rate.delete(ws);
    const att = ws.deserializeAttachment() || {};
    this.broadcast({ t: "leave", id: att.id });
  }
}
