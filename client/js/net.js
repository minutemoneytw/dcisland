// DC島 M2 — 多人同步（同語音頻道＝同一座島）
// 房間鍵：Discord 的 guild_id:channel_id（本機則 local:local，可用 ?room= 指定）
// 之後搬上 Cloudflare Durable Objects 時，這支的介面不變，只換連線位址。

const SEND_HZ = 12;          // 每秒送幾次自己的位置
const HEARTBEAT_MS = 1000;   // 狀態沒變時的心跳間隔（必須遠小於 STALE_MS，否則站著不動的人會被當成離線）
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
      look: { skin: S.me.skin, hair: S.me.hair, shirt: S.me.shirt, pants: S.me.pants || 0 },
      job: S.me.job,                       // 職業（坦/補/輸出）：伺服器原樣轉發，各畫面用 jobOf() 解讀
      weapon: p.tool || S.me.weapon,       // 手上拿的（打石頭/樹木時是工具）
      pose: p.pose || null,                // 'sit' | 'sleep'（坐/睡在家具上）
      face: p.face || 'down',              // 四方向朝向：'up'（背面）| 'down'（正面）| 'side'（側，dir 決定左右）
      seat: p.seatType || null,            // 坐/睡的家具種類（畫圖用）
      hp: p.dead ? 0 : Math.round(p.hp ?? 10),   // 血量（島主爪擊扣 2、殺動物回 1；龍衝直接倒地）
      dead: p.dead ? 1 : 0,                // 死亡（墓碑）：被島主打倒後倒數復活
    };
  }

  function upsert(id, st) {
      let r = S.remotes.get(id);
      if (!r) {
        r = { id, name: '訪客', look: { skin: 'light', hair: 'hair1', shirt: 0, pants: 0 }, weapon: 'hands',
              x: 0, y: 0, tx: 0, ty: 0, dir: 1, moving: false, frame: 0, animT: 0,
              z: 0, tz: 0, swing: 0, hp: 10, dead: false, remote: true, seen: performance.now() };
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
      r.pose = st.pose === 'sit' || st.pose === 'sleep' ? st.pose : null;
      r.face = st.face === 'up' || st.face === 'side' ? st.face : 'down';
      r.seatType = typeof st.seat === 'string' ? st.seat : null;
      const wasDead = !!r.dead;
      r.dead = !!st.dead;                  // 死亡（墓碑）：進出死亡時跟同島的人說一聲
      if (st.hp != null) r.hp = st.hp;     // 血量同步（對方自己算好的）
      if (st.job) r.job = st.job;          // 職業（坦/補/輸出）：只收字串，main.js 的 jobOf() 會做白名單解讀
      if (!r.dead) {                       // 死亡時位置凍結（墓碑不會被推著走）
        r.tx = st.x; r.ty = st.y; r.dir = st.dir ?? r.dir; r.tz = st.z ?? r.tz;   // 高度只設目標，由 stepRemote 平滑追上（直接覆蓋會每次封包都彈回 0 → 跳躍抽動）
        r.moving = !!st.moving;
      } else r.moving = false;
      if (r.dead && !wasDead) r.deadAt = performance.now();   // 復活倒數的起點（本地時鐘）
      if (r.dead && !wasDead) notice(`${r.name} 倒地了，躺在墓碑裡…`);
      else if (!r.dead && wasDead) notice(`${r.name} 復活了！`);
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
        if (opts.onAdmin) opts.onAdmin(!!msg.admin);        // 重連後先當一般人，hello 驗證成功後 me 會更新
        break;
      case 'me': if (opts.onAdmin) opts.onAdmin(!!msg.admin); break;
      case 'commit_result': if (opts.onCommitResult) opts.onCommitResult(msg); break;
      case 'enter': {
        // 進入（或切換到）某地形：每個人各自在自己的地形，只看得到同地形的人
        S.remotes.clear();
        for (const [id, st] of Object.entries(msg.players || {})) {
          const r = upsert(Number(id), st);
          r.x = r.tx; r.y = r.ty;               // 一進場就在對方位置，不用滑過來
        }
        if (opts.onFurn) opts.onFurn(msg.furn || []);
        if (opts.onFloor) opts.onFloor(msg.floor || []);
        if (opts.onDecos) opts.onDecos(msg.terrain, msg.decos || []);   // 在擺設之後（重生判斷要看家具）
        if (msg.dragon && opts.onDragon) opts.onDragon({ ...msg.dragon, ev: 'state' });   // 進草島時的島主快照
        break;
      }
      case 'deco': if (opts.onDeco) opts.onDeco(msg); break;
      case 'dragon': if (opts.onDragon) opts.onDragon(msg); break;   // 島主事件（aim/hp/dead/spawn）由 main.js 演出
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
      case 'floor': if (opts.onFloor) opts.onFloor(msg.items || []); break;
      case 'event': {
        const r = S.remotes.get(msg.id);
        if (r && msg.kind === 'attack') r.swing = 0.22;
        else if (r && msg.kind === 'heal' && opts.onHeal) opts.onHeal(msg.id);   // 補師的群補：每個收到的人自判自己是否被補到
        break;
      }
    }
  }

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      net.connected = true; backoff = 600;
      net.resetSent?.();
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
  // 只在狀態有變（位置/動作/血量/死亡…）時送；站著不動只送心跳，省下全島的廣播與伺服器寫入。
  // 死亡／復活／血量都在 myState() 裡，變了下一個 tick（約 83ms）就會送，不靠心跳。
  let lastSent = '', lastSentAt = 0;
  net.resetSent = () => { lastSent = ''; };   // 重連後強制送一次完整狀態
  setInterval(() => {
    const now = performance.now();
    if (net.connected) {
      const st = JSON.stringify(myState());
      if (st !== lastSent || now - lastSentAt >= HEARTBEAT_MS) {
        send({ t: 'state', s: JSON.parse(st) });
        lastSent = st; lastSentAt = now;
      }
    }
    for (const [id, r] of S.remotes) if (now - r.seen > STALE_MS) S.remotes.delete(id);
  }, 1000 / SEND_HZ);

  // 出示伺服器簽發的身分憑證（Discord 授權完成後才有）；伺服器驗證成功後，名字與 uid 以它為準
  net.hello = () => { if (S.session) send({ t: 'hello', s: S.session }); };
  // 攻擊等瞬時事件（doAttack 會呼叫）
  net.notifyAttack = () => net.connected && send({ t: 'event', kind: 'attack' });
  // 補師打倒動物／發動群療時的群補廣播（泛型 event：kind: 'heal'，兩份伺服器都會原樣轉發）
  net.heal = () => net.connected && send({ t: 'event', kind: 'heal' });
  // 挑釁（坦職限定，main.js 的 R 鍵會呼叫）：伺服器驗證職業/範圍/冷卻後轉向或觸發反擊
  net.provoke = () => net.connected && send({ t: 'provoke' });
  // 宣告自己進入某地形：只有自己過去，同地形的人才看得到你
  net.enter = v => net.connected && send({ t: 'enter', v });
  // 家具編輯：只送意圖，結果以伺服器廣播的 furn 清單為準
  net.commitFurn = ops => net.connected && send({ t: 'commit', ops });       // 裝飾模式保存：一批操作（place/remove/clear/floor）
  // 看板改字：送意圖，結果以伺服器廣播的 furn 清單為準
  net.editSign = (cell, text) => net.connected && send({ t: 'sign', cell, text });
  // 打可破壞物件：只送意圖（物件編號、圖檔名、所在格），血量由伺服器扣
  net.hitDeco = (i, sprite, cell) => net.connected && send({ t: 'hit', i, sprite, cell });
  // 島主：上傳陸地位圖（進草島時）／打到島主時送意圖（座標＋傷害＋我們看到的龍位置），流程由伺服器權威
  net.sendDragonMap = v => net.connected && send({ t: 'dragonMap', v });
  net.dragonHit = (x, y, dmg, ddx, ddy) => net.connected && send({ t: 'dragonHit', x, y, dmg, ddx, ddy });
  // 分頁凍結恢復後要島主即時快照（伺服器用 dragon 事件的 state 回這條連線）
  net.requestDragonSnap = () => net.connected && send({ t: 'dragonSnap' });

  return net;
}
