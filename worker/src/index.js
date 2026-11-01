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
  }

  async fetch(request) {
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

    server.send(JSON.stringify({ t: "init", id: seq, players, terrain }));
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

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() || {};

    if (msg.t === "state") {
      att.state = msg.s || {};
      ws.serializeAttachment(att);
      this.broadcast({ t: "p", id: att.id, s: msg.s }, ws);
    } else if (msg.t === "terrain") {
      const v = String(msg.v).slice(0, 40);
      await this.state.storage.put("terrain", v);
      this.broadcast({ t: "terrain", v }, ws);
    } else if (msg.t === "event") {
      this.broadcast({ t: "event", id: att.id, kind: msg.kind }, ws);
    }
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast({ t: "leave", id: att.id });
  }
}
