// DC島 M2 — 多人同步（同語音頻道＝同一座島）
// 房間鍵：Discord 的 guild_id:channel_id（本機則 local:local，可用 ?room= 指定）
// 之後搬上 Cloudflare Durable Objects 時，這支的介面不變，只換連線位址。

const SEND_HZ = 12;          // 每秒送幾次自己的位置
const STALE_MS = 15000;      // 超過這麼久沒收到訊息就當對方離線

export function connectNet(S, opts = {}) {
  const q = new URLSearchParams(location.search);
  const room = opts.room
    || q.get('room')
    || `${q.get('guild_id') || 'local'}:${q.get('channel_id') || 'local'}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`;

  let ws = null, closed = false, backoff = 600;
  const net = { room, url, id: null, connected: false, close() { closed = true; ws && ws.close(); } };
  S.net = net;

  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function myState() {
    const p = S.players[0];
    return {
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      dir: p.dir,
      moving: p.moving,
      z: Math.round(p.z),
      name: p.name,
      look: { skin: S.me.skin, hair: S.me.hair, shirt: S.me.shirt },
      weapon: S.me.weapon,
    };
  }

  function upsert(id, st) {
    let r = S.remotes.get(id);
    if (!r) {
      r = { id, name: '訪客', look: { skin: 'light', hair: 'hair1', shirt: 0 }, weapon: 'hands',
            x: 0, y: 0, tx: 0, ty: 0, dir: 1, moving: false, frame: 0, animT: 0,
            z: 0, tz: 0, swing: 0, remote: true, seen: performance.now() };
      // 首次出現先放到自己附近，避免從地圖角落滑過來
      const me = S.players[0];
      r.x = r.tx = me.x + (Math.random() * 60 - 30);
      r.y = r.ty = me.y + (Math.random() * 40 - 20);
      S.remotes.set(id, r);
    }
    if (st) {
      r.name = st.name || r.name;
      if (st.look) r.look = st.look;
      r.weapon = st.weapon || r.weapon;
      r.tx = st.x; r.ty = st.y; r.dir = st.dir ?? r.dir; r.z = st.z ?? r.z;
      r.moving = !!st.moving;
      r.seen = performance.now();
    }
    return r;
  }

  const areaName = id => S.terrains?.[id]?.name || id;
  const notice = text => window.toast?.(text, 2500);

  function handle(msg) {
    switch (msg.t) {
      case 'init':
        net.id = msg.id;
        S.remotes.clear();
        break;
      case 'enter': {
        // 進入（或切換到）某地形：每個人各自在自己的地形，只看得到同地形的人
        S.remotes.clear();
        for (const [id, st] of Object.entries(msg.players || {})) {
          const r = upsert(Number(id), st);
          r.x = r.tx; r.y = r.ty;               // 一進場就在對方位置，不用滑過來
        }
        if (opts.onFurn) opts.onFurn(msg.furn || []);
        break;
      }
      case 'join': {
        const r = upsert(msg.id, null);
        if (msg.name) r.name = msg.name;
        notice(`${r.name} 進入${areaName(S.terrain)}區域`);
        break;
      }
      case 'p': upsert(msg.id, msg.s); break;
      case 'leave': {
        const r = S.remotes.get(msg.id);
        // 帶 to 才是「換地形」；斷線的 leave 不提示
        if (r && msg.to) notice(`${r.name} 移動到了${areaName(msg.to)}區域`);
        S.remotes.delete(msg.id);
        break;
      }
      case 'furn': if (opts.onFurn) opts.onFurn(msg.items || []); break;
      case 'event': {
        const r = S.remotes.get(msg.id);
        if (r && msg.kind === 'attack') r.swing = 0.22;
        break;
      }
    }
  }

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      net.connected = true; backoff = 600;
      net.hello();                          // 先表明身分（有憑證才送）
      send({ t: 'state', s: myState() });   // 先送狀態，別人收到 join 時才知道名字
      net.enter(S.terrain);                 // 再宣告自己在哪個地形（斷線重連也會重進）
      opts.onOpen && opts.onOpen(net);
    };
    ws.onmessage = ev => { try { handle(JSON.parse(ev.data)); } catch (e) { console.warn('net msg', e); } };
    ws.onclose = () => {
      net.connected = false; S.remotes.clear();
      if (closed) return;
      setTimeout(open, backoff);            // 斷線自動重連，指數退讓
      backoff = Math.min(backoff * 1.6, 8000);
    };
    ws.onerror = () => { /* onclose 會接手 */ };
  }
  open();

  // 定期上報自己的狀態 + 清掉失聯的遠端玩家
  setInterval(() => {
    if (net.connected) send({ t: 'state', s: myState() });
    const now = performance.now();
    for (const [id, r] of S.remotes) if (now - r.seen > STALE_MS) S.remotes.delete(id);
  }, 1000 / SEND_HZ);

  // 出示伺服器簽發的身分憑證（Discord 授權完成後才有）；伺服器驗證成功後，名字與 uid 以它為準
  net.hello = () => { if (S.session) send({ t: 'hello', s: S.session }); };
  // 攻擊等瞬時事件（doAttack 會呼叫）
  net.notifyAttack = () => net.connected && send({ t: 'event', kind: 'attack' });
  // 宣告自己進入某地形：只有自己過去，同地形的人才看得到你
  net.enter = v => net.connected && send({ t: 'enter', v });
  // 家具編輯：只送意圖，結果以伺服器廣播的 furn 清單為準
  net.placeFurn = (type, x, y) => net.connected && send({ t: 'place', type, cell: [x, y] });
  net.removeFurn = (x, y) => net.connected && send({ t: 'remove', cell: [x, y] });
  net.clearFurn = () => net.connected && send({ t: 'clear' });

  return net;
}
