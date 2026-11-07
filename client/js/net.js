// DC島 M2 — 多人同步（同語音頻道＝同一座島）
// 房間鍵：Discord 的 guild_id:channel_id（本機則 local:local，可用 ?room= 指定）
// 連到同網域的 /ws：正式站是 Cloudflare Worker（Durable Object，一座島一個實例），本機是 tools/dev_server.py，協定相同。

const SEND_HZ = 12;          // 每秒送幾次自己的位置
const HEARTBEAT_MS = 1000;   // 狀態沒變時的心跳間隔（必須遠小於 STALE_MS，否則站著不動的人會被當成離線）
const STALE_MS = 15000;      // 超過這麼久沒收到訊息就當對方離線
const D8 = ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'];   // 與 main.js 的 CHAR_DIR8、兩份伺服器一致

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
      // 顯示用的造型：帽子／上衣／褲子（裝備或外觀，已決定好）、換色色碼（null＝原色）、武器外觀；shirt／pants 是給舊客戶端的顏色編號
      look: S.myLook ? S.myLook() : { skin: S.me.skin, hair: S.me.hair, shirt: 0, pants: 0 },
      job: S.me.job,                       // 職業（坦克/補師/輸出）：伺服器原樣轉發，各畫面用 jobOf() 解讀
      title: S.me.title || null,           // 稱號 id（null＝不顯示）：各畫面查 titles.json 取文字
      d8: p.d8 || null,                    // 畫面用的 8 方向朝向（down/down_right/right/…；玩法仍看 face）
      weapon: p.tool || S.me.weapon,       // 手上拿的（打石頭/樹木時是工具）
      pose: p.pose || null,                // 'sit' | 'sleep'（坐/睡在家具上）
      face: p.face || 'down',              // 四方向朝向：'up'（背面）| 'down'（正面）| 'side'（側，dir 決定左右）
      seat: p.seatType || null,            // 坐/睡的家具種類（畫圖用）
      hp: p.dead ? 0 : Math.round(p.hp ?? 10),   // 血量（島主爪擊扣 2、殺動物回 1；龍衝直接倒地）
      dead: p.dead ? 1 : 0,                // 死亡（墓碑）：被島主打倒後倒數復活
      lvl: S.myLvl ? S.myLvl() : 1,        // 等級（名牌顯示用）：登入者由伺服器覆寫，訪客照客戶端報的
      fish: p.fish ? { x: p.fish.x, y: p.fish.y, ph: p.fish.ph } : null,   // 釣魚：浮標位置與階段（wait 等魚／bite 上鉤／reel 拉扯）
      fx: S.myFx ? S.myFx() : [],          // 持續型技能效果（翅膀、護盾、結印…）：給同地形的人畫特效
      circle: S.fx?.circle && S.t < S.fx.circle.until ? { x: S.fx.circle.x, y: S.fx.circle.y } : null,   // 黑魔法師的魔法陣
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
      r.d8 = D8.includes(st.d8) ? st.d8 : null;   // 舊客戶端沒送就從 face＋dir 推
      r.seatType = typeof st.seat === 'string' ? st.seat : null;
      // 釣魚：浮標位置與階段；階段變了就重新起算（拉扯動畫要知道從什麼時候開始）
      const fs = st.fish && ['wait', 'bite', 'reel'].includes(st.fish.ph) ? st.fish : null;
      r.fish = fs ? { x: fs.x, y: fs.y, ph: fs.ph, t: r.fish?.ph === fs.ph ? r.fish.t : S.t } : null;
      const wasDead = !!r.dead;
      r.dead = !!st.dead;                  // 死亡（墓碑）：進出死亡時跟同島的人說一聲
      if (st.hp != null) r.hp = st.hp;     // 血量同步（對方自己算好的）
      r.title = typeof st.title === 'string' ? st.title : null;   // 稱號 id（舊客戶端沒送＝不顯示；main.js 的 titleText() 查不到也不顯示）
      if (st.lvl != null) r.lvl = st.lvl;   // 等級（名牌的 Lv.N；舊客戶端沒送＝不顯示；登入者由伺服器算好）
      if (st.job) r.job = st.job;          // 職業：只收字串，main.js 的 jobOf() 會做白名單解讀（舊客戶端的 tank/healer/dps 照 legacy 轉）
      r.fx = Array.isArray(st.fx) ? st.fx.filter(v => typeof v === 'string') : [];
      r.circle = st.circle && typeof st.circle.x === 'number' ? { x: st.circle.x, y: st.circle.y } : null;
      if (r.snapNext) { r.snapNext = false; r.x = st.x; r.y = st.y; }   // 縮地：不要從原地滑過去，直接跳到新位置
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
      case 'me':
        net.uid = typeof msg.uid === 'string' ? msg.uid : null;   // 登入成功才有 uid（決定 XP 記帳走伺服器還是本機）
        if (opts.onMe) opts.onMe(msg);
        if (opts.onAdmin) opts.onAdmin(!!msg.admin);
        // 有憑證卻驗證失敗（12 小時過期等）：請 discord.js 重新授權拿新憑證，拿到後會自動再送 hello（舊伺服器沒有 auth 欄位就不動作）
        if (S.session && msg.auth === false) S.reauth?.();
        break;
      case 'xp': if (opts.onXp) opts.onXp(msg); break;   // 自己的 XP 記帳結果（伺服器權威；不廣播）
      case 'commit_result': if (opts.onCommitResult) opts.onCommitResult(msg); break;
      case 'fish_result': if (opts.onFishResult) opts.onFishResult(msg); break;   // 釣魚結果（伺服器抽）
      case 'table': if (opts.onTable) opts.onTable(msg); break;           // 和平島遊戲桌：我這桌的畫面（v＝null＝我已離開）
      case 'tblinfo': if (opts.onTblInfo) opts.onTblInfo(msg.info); break;   // 和平島各桌的人數／狀態
      case 'craftdb': if (opts.onCraftDb) opts.onCraftDb(msg.craft); break;   // 合成解鎖紀錄（登入後由伺服器送來）
      case 'dex': if (opts.onDex) opts.onDex(msg.dex); break;                     // 魚類圖鑑（登入後由伺服器送來）
      case 'enter': {
        // 進入（或切換到）某地形：每個人各自在自己的地形，只看得到同地形的人
        // 快速連切地形時，舊地形的回應會晚到：不是現在所在的地形就丟掉（之後還會收到新地形的 enter）
        if (msg.terrain && msg.terrain !== S.terrain) break;
        S.remotes.clear();
        for (const [id, st] of Object.entries(msg.players || {})) {
          const r = upsert(Number(id), st);
          r.x = r.tx; r.y = r.ty;               // 一進場就在對方位置，不用滑過來
        }
        if (opts.onFurn) opts.onFurn(msg.furn || []);
        if (opts.onFloor) opts.onFloor(msg.floor || []);
        if (opts.onDecos) opts.onDecos(msg.terrain, msg.decos || []);   // 在擺設之後（重生判斷要看家具）
        if (msg.dragon && opts.onDragon) opts.onDragon({ ...msg.dragon, ev: 'state', terrain: msg.terrain });   // 進有島主的地形時的快照（帶地形，別套到別座島的島主上）
        if (opts.onLurker) opts.onLurker({ ...(msg.lurker || {}), ev: msg.lurker ? 'state' : 'none', terrain: msg.terrain });   // 釣上來的怪物快照（沒有＝清掉殘留的）
        break;
      }
      case 'deco': if (opts.onDeco) opts.onDeco(msg); break;
      case 'dragon': if (opts.onDragon) opts.onDragon(msg); break;   // 島主事件（aim/hp/dead/spawn）由 main.js 演出
      case 'lurker': if (opts.onLurker) opts.onLurker(msg); break;   // 釣上來的敵對怪物事件（spawn/wander/claw/aggro/hp/dead/gone）
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
        else if (r && typeof msg.kind === 'string' && opts.onSkillEvent) opts.onSkillEvent(msg.kind, r);   // 職業技能（群盾、忍術、縮地…）：各人自判／演出
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
  // 挑釁（坦克限定，main.js 的 R 鍵會呼叫）：伺服器驗證職業/範圍/冷卻後轉向或觸發反擊
  net.provoke = () => net.connected && send({ t: 'provoke' });
  // 破綻／降傷（近戰／遠程輸出的 R 鍵）：伺服器驗證職能/距離/冷卻後記在島主狀態並廣播 dragon debuff
  net.debuff = kind => net.connected && send({ t: 'debuff', kind });
  // 職業技能的瞬時事件（泛型 event，兩份伺服器原樣轉發 kind）：群盾的各人自判、別人畫面上的特效
  net.skillEvent = kind => net.connected && send({ t: 'event', kind });
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
  // staff：法杖／咒杖遠距詠唱（伺服器放寬射程，並核對 state.weapon）；sk：職業技能（忍術／閃耀，伺服器驗證職業與冷卻、傷害照技能）
  net.dragonHit = (x, y, dmg, ddx, ddy, staff, sk) => net.connected && send({ t: 'dragonHit', x, y, dmg, ddx, ddy, ...(staff ? { staff: 1 } : {}), ...(sk ? { sk } : {}) });
  // 釣魚：魚上鉤後拉竿成功，請伺服器抽一條魚（登入的人順便記進伺服器的圖鑑），結果用 fish_result 回來
  net.fishCatch = () => net.connected && send({ t: 'fish' });
  // 分頁凍結恢復後要島主即時快照（伺服器用 dragon 事件的 state 回這條連線）
  net.requestDragonSnap = () => net.connected && send({ t: 'dragonSnap' });
  // 打釣上來的怪物（伺服器權威扣血）：lx/ly＝我們畫面上怪物的位置（伺服器容許漏接一腿的落後）
  net.lurkerHit = (x, y, dmg, lx, ly, staff, sk) => net.connected && send({ t: 'lurkerHit', x, y, dmg, lx, ly, ...(staff ? { staff: 1 } : {}), ...(sk ? { sk } : {}) });
  // 腳色等級 XP（2026-11-07 第 2 步）：登入者的 XP 由伺服器記帳。
  // xpSync：舊存檔一次性上繳（伺服器沒有紀錄才會收）；xpEvent：擊倒非主動怪（伺服器無法驗證，信任＋夾頻）
  net.xpSync = v => net.connected && send({ t: 'xpsync', v });
  net.xpEvent = k => net.connected && send({ t: 'xpe', k });
  // 合成解鎖（素材圖鑑／配方筆記）：登入者由伺服器存（訪客伺服器會略過）。craftUnlock＝解鎖一筆（k：mat／furn／rec）；craftSync＝補傳本機有、伺服器沒有的
  // 和平島遊戲桌（牌局由伺服器權威）：a＝join（id；role＝'spec' 表示選觀戰）／leave／stand（入座改觀戰）／ready（v）／sit／draw（idx）／shuffle（抽鬼牌）／move（x, y；五子棋）
  net.tbl = m => net.connected && send({ t: 'tbl', ...m });
  net.craftUnlock = (k, id) => net.connected && send({ t: 'craft', k, id });
  net.craftSync = v => net.connected && send({ t: 'craftsync', mat: v.mat || [], furn: v.furn || [], rec: v.rec || [] });

  return net;
}
