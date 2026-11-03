// DC島 — 遊戲本體（世界生成、移動、繪圖、戰鬥、動物、裝飾、造型、UI）。多人同步在 net.js，連線時以伺服器（Worker／dev_server）為準
const CELL = 32, COLS = 88, ROWS = 56;   // 島放大：鏡頭跟隨
const VIEW_W = 29 * 32, VIEW_H = 17 * 32;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ---------------- 工具 ----------------
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 1779033703; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return h >>> 0; }

function loadJSON(url) { return fetch(url).then(r => r.json()); }
function loadImg(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(url)); i.src = url; }); }
// 非必要的圖（家具/地板/動物/武器/地形點綴…）：缺一張只略過那一樣並回報，不要讓整個遊戲載入失敗
function optImg(url) {
  return loadImg(url).catch(() => { console.warn('缺圖:', url); reportError('asset-missing', url); return null; });
}

let toastTimer = null;
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// localStorage 可能被擋（Discord webview／無痕）或存了壞掉的值：讀寫都不能讓遊戲掛掉
function lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
function lsRaw(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 存不了就算了，不影響遊戲 */ }
}
const lsObj = (key, def) => { const v = lsGet(key, null); return v && typeof v === 'object' && !Array.isArray(v) ? v : def; };

// ---------------- 全域狀態 ----------------
const TERRAIN_IDS = ['grass', 'beach', 'snow', 'night', 'forest', 'volcano'];
const S = {
  terrain: (t => TERRAIN_IDS.includes(t) ? t : 'grass')(lsRaw('dcisland.m0.terrain')),   // 舊資料是純字串（非 JSON）
  terrains: {},                 // id -> manifest
  tImages: {},                  // id -> {file: Image}
  furn: null, furnImgs: {},
  avatar: null, bodyImgs: {}, hairImgs: {}, hairBackImgs: {},
  charCache: new Map(),         // key -> {a: canvas, b: canvas}
  me: lsObj('dcisland.m0.avatar', null) || { skin: 'light', hair: 'hair1', shirt: 0, weapon: 'sword' },
  world: null,                  // {types: Uint8Array, decos: []}
  furnItems: [],                // [{type, cell:[x,y]}]
  occ: new Map(),               // "x,y" -> furniture index
  players: [],
  animals: [],                  // FF14 致敬小動物
  animalsDB: null, anImgs: {},
  mode: 'walk', sel: null,
  mouseCell: null,
  t: 0,
  cam: { x: 0, y: 0 },
  respawn: [],                  // 動物重生佇列 [{id, at}]
  floaters: [],                 // 傷害飄字 {x,y,v,life,poof}
  weaponImgs: {},
  remotes: new Map(),           // M2：同島的其他玩家（id -> player-like）
  net: null,                    // M2：連線物件（net.js）
  netFurn: [],                  // 伺服器端目前地形的擺設（連線時以此為準）
  floors: null, floorImgs: {},  // 地板 manifest / 圖
  floorMap: new Map(),          // 地板層：y*COLS+x -> 地板 id（畫在地面與家具之間）
  netFloor: [],                 // 伺服器端目前地形的地板 [[x,y,id],…]
  baseFloor: new Map(),         // 地板草稿所依據的底（同 baseFurn）
  decorTab: 'furn',             // 裝飾模式分頁：'furn'（擺設）| 'floor'（地板：只能鋪/拆，長按左鍵鋪、長按右鍵拆）
  selFloor: null, paint: null,  // 選中的地板 id；長按中的動作 'add' | 'del'
  admin: false,                 // 我是不是管理員（伺服器告知；可以清空擺設）
  draft: [],                    // 裝飾模式未保存的操作
  baseFurn: [],                 // 草稿所依據的擺設（進入裝飾模式時、或最近一次伺服器同步）
  confirmOpen: false,           // 「要保存嗎？」視窗是否開著
  listOpen: false,              // 線上列表視窗是否開著
  helpOpen: false,              // 嚮導的操作說明視窗是否開著
  signOpen: false, signItem: null,   // 看板編輯視窗是否開著／正在編輯哪一塊
  npcDB: null,                  // NPC 對話（assets/npcs/npcs.json）
  toolsDB: null,                // 採集工具與可破壞物件（assets/tools/tools.json）
  drops: [],                    // 地上的掉落物 {item,x,y,born}
  inv: lsObj('dcisland.m0.inv', {}),   // 背包：物品id -> 數量
  fishDB: null, fishImgs: {},          // 釣魚：魚類 manifest（assets/fish/fish.json）與圖
  dex: lsObj('dcisland.m0.fishdex', {}),   // 魚類圖鑑：地形 -> 魚id -> {max（最大尺寸 cm）, n（釣到次數）}；登入後換成伺服器的
  dexSource: 'local',                  // 'local'＝訪客／未連線（存本機）；'server'＝伺服器依 Discord 帳號保存
  dexOpen: false, dexTab: null,        // 圖鑑視窗是否開著／正在看哪個地形
};

// ---------------- 世界生成 ----------------
function key(x, y) { return x + ',' + y; }

function genWorld(id) {
  const rng = mulberry32(hashStr(id));
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5, rx = 26, ry = 17.5;   // 放大 5 倍級
  const types = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    let d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
    d += (rng() - .5) * .22;
    types[y * COLS + x] = d < .7 ? 2 : d < 1.1 ? 1 : 0;
  }
  // 自動點綴（避開中央出生點）
  const decos = [];
  const td = S.terrains[id];
  const pool = [];
  for (const d of td.deco) for (let i = 0; i < d.weight; i++) pool.push(d.sprite);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (types[y * COLS + x] !== 2) continue;
    if (Math.abs(x - cx) < 2.5 && Math.abs(y - cy) < 2) continue; // 出生區淨空
    if (rng() < .045) decos.push({ i: decos.length, sprite: pool[Math.floor(rng() * pool.length)], cell: [x, y], flip: rng() < .5 });
  }
  S.world = { types, decos };
  S.drops = [];
  spawnAnimals();
}

// ---- FF14 致敬野生動物 ----
function animalDef(id) { return S.animalsDB.animals.find(x => x.id === id); }

function spawnAnimals() {
  S.animals = [];
  const td = S.terrains[S.terrain];
  if (!S.animalsDB || !td.animals?.length) return;
  const pool = [];
  for (const a of td.animals) for (let i = 0; i < a.weight; i++) pool.push(a.id);
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  for (let n = 0; n < 6; n++) {
    const id = pool[Math.floor(Math.random() * pool.length)];
    for (let tries = 0; tries < 40; tries++) {
      const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
      if (S.world.types[y * COLS + x] !== 2) continue;
      if (Math.abs(x - cx) < 2 && Math.abs(y - cy) < 2) continue;
      if (S.occ.get(key(x, y)) !== undefined) continue;
      S.animals.push({ id, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: Math.random() * 2, startle: 0, z: 0, bounce: 0,
                       hp: animalDef(id).hp, maxHp: animalDef(id).hp, dead: false, dieT: 0 });
      break;
    }
  }
  // 島主：terrain.json 的 owner 指定的動物，每座地形固定一隻（不會被嚇跑、被打倒會重生；攻擊方式照 animals.json 的 atk）
  // 連線時島主由伺服器同步（進場快照與事件），只在單機時本地生成
  const odef = td.owner && animalDef(td.owner);
  if (odef && !netOn()) for (let tries = 0; tries < 40; tries++) {
    const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
    if (S.world.types[y * COLS + x] !== 2) continue;
    if (Math.abs(x - cx) < 5 && Math.abs(y - cy) < 4) continue;   // 大隻的，出生點周圍留空
    if (S.occ.get(key(x, y)) !== undefined) continue;
    S.animals.push({ id: td.owner, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: Math.random(), startle: 0, z: 0, bounce: 0,
                     hp: odef.hp, maxHp: odef.hp, dead: false, dieT: 0 });
    break;
  }
}

function respawnAnimal(id) {
  const def = animalDef(id);
  for (let tries = 0; tries < 60; tries++) {
    const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
    if (S.world.types[y * COLS + x] !== 2) continue;
    if (Math.hypot(x * CELL - S.players[0].x, y * CELL - S.players[0].y) < 8 * CELL) continue; // 離玩家遠一點
    S.animals.push({ id, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: 1.2, startle: 0, z: 0, bounce: 0,
                     hp: def.hp, maxHp: def.hp, dead: false, dieT: 0 });
    toast(`${def.name} 回來了！`, 1600);
    return;
  }
}

// ---- 攻擊（武器） ----
const ATK_CD = 0.45, ATK_T = 0.22, ATK_RANGE = 58;   // ATK_RANGE：最大怪物（big=5，黃金肥龍）的判定圈半徑，其餘依體型縮小（見 hitRadius）
// 攻擊判定以「武器尖端」為準、不看人：武器在人臉朝向那一側 WEAPON_REACH 處；怪物腳底中心 + 判定圈（半徑 hitRadius），
// 武器點進了圈內就打得到，不需要「面向」的扇形限制（背對時武器在另一側，自然要看武器落在哪）
const WEAPON_REACH = 30;
const weaponPt = p => ({ x: p.x + (p.dir || 1) * WEAPON_REACH, y: p.y });
const hitRadius = def => 34 + 6 * ((def?.big || 1) - 1);   // big=1：34（與舊版正前方約 58px 的觸及距離相近）、big=5：58
const inHit = (p, a) => { const w = weaponPt(p); return Math.hypot(a.x - w.x, a.y - w.y) <= hitRadius(animalDef(a.id)); };
// 長按自動連擊時，「太遠了」「沒裝備武器」這類提示只在第一下顯示，不要每幀洗版
let quiet = false;
const say = (msg, ms) => { if (!quiet) toast(msg, ms); };

// ---- 採集工具：點到石頭自動換鎬子、點到樹木/蘑菇自動換斧頭，其餘維持用劍 ----
// 哪些東西可破壞、用什麼工具、血量、掉落物，全在 assets/tools/tools.json（key＝地形 deco 的圖檔名）
function decoTarget(d) { return S.toolsDB?.targets[d.sprite]; }
function decoRect(d) {
  const img = S.tImages[S.terrain]?.[d.sprite]; if (!img) return null;
  const sc = S.terrains[S.terrain].scale, w = img.width * sc, h = img.height * sc;
  return { x: d.cell[0] * CELL, y: (d.cell[1] + 1) * CELL - h, w, h };
}
function decoBase(d) { return [d.cell[0] * CELL + CELL / 2, (d.cell[1] + .5) * CELL]; }
// 滑鼠點到哪個可破壞物件（多個重疊時取底部最近的）
function decoAt(wx, wy) {
  let best = null, bd = 1e9;
  for (const d of S.world.decos) {
    if (d.dead || !decoTarget(d)) continue;
    const r = decoRect(d); if (!r) continue;
    if (wx < r.x || wx > r.x + r.w || wy < r.y || wy > r.y + r.h) continue;
    const dist = Math.hypot(wx - (r.x + r.w / 2), wy - (r.y + r.h));
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}
// F 鍵（沒有滑鼠位置）：自己前方、範圍內最近的可破壞物件
function decoNear(p) {
  let best = null, bd = S.toolsDB.range + 1;
  for (const d of S.world.decos) {
    if (d.dead || !decoTarget(d)) continue;
    const [bx, by] = decoBase(d), dx = bx - p.x, dist = Math.hypot(dx, by - p.y);
    if (dist >= bd || dx * p.dir < -8) continue;
    bd = dist; best = d;
  }
  return best;
}
function useTool(d) {
  const p = S.players[0], tgt = decoTarget(d), [bx, by] = decoBase(d);
  if (Math.hypot(bx - p.x, by - p.y) > S.toolsDB.range) { say(`離${tgt.name}太遠了，靠近一點`); return; }
  if (Math.abs(bx - p.x) > 6) p.dir = Math.sign(bx - p.x);
  if (S.t - p.lastAtk < ATK_CD) return;
  p.lastAtk = S.t; p.swing = ATK_T;
  p.tool = tgt.tool; p.toolUntil = S.t + S.toolsDB.hold;     // 自動換工具，一陣子沒用就換回劍
  S.net?.notifyAttack?.();
  // 連線時血量由伺服器扣，結果以伺服器廣播的 deco 訊息為準（同地形的人都會看到）；沒連線才在本機算
  if (netOn()) { S.net.hitDeco(d.i, d.sprite, d.cell); return; }
  d.hp ??= tgt.hp; d.hp -= 1;
  applyDecoHit(d, d.hp, d.hp <= 0, (tgt.respawn || 60) * 1000, true);
}
// 套用一次打擊的結果（本機算的或伺服器廣播的）。mine＝自己打的：只有打壞的人拿掉落物、看到訊息
function applyDecoHit(d, hp, dead, ttl, mine) {
  const tgt = decoTarget(d), [bx, by] = decoBase(d), r = decoRect(d) || { y: by - CELL, h: CELL };   // 缺圖時用一格高估位置
  d.hp = hp; d.shake = .25;
  S.floaters.push({ x: bx + (Math.random() * 16 - 8), y: r.y + r.h * .4, v: '1', life: .8, crit: false });
  if (!dead) return;
  d.dead = true; d.respawnAt = S.t + ttl / 1000;
  S.floaters.push({ x: bx, y: r.y + r.h * .5, poof: true, life: .55 });
  if (mine) { spawnDrops(tgt, bx, by); toast(`${tgt.name}被破壞了`, 1600); }
}
// 進入地形時伺服器給的完整狀態：先全部還原，再套用受損/已破壞的
function onNetDecos(terrain, list) {
  if (terrain !== S.terrain) return;
  for (const d of S.world.decos) { d.dead = false; d.hp = undefined; d.shake = 0; }
  for (const e of list) {
    const d = S.world.decos[e.i]; if (!d) continue;
    d.hp = e.hp;
    if (e.hp <= 0) { d.dead = true; d.respawnAt = S.t + e.ttl / 1000; }
  }
}
function onNetDeco(m) {
  const d = S.world.decos[m.i];
  if (d && decoTarget(d)) applyDecoHit(d, m.hp, m.hp <= 0, m.ttl, m.by === S.net?.id);
}
// 掉落物：tools.json 的 drops 為空就什麼都不會掉；格式見該檔 _drops_format
function spawnDrops(tgt, x, y) {
  for (const e of tgt.drops || []) {
    if (!S.toolsDB.items[e.item] || Math.random() >= (e.chance ?? 1)) continue;
    const lo = e.min ?? 1, n = lo + Math.floor(Math.random() * ((e.max ?? lo) - lo + 1));
    for (let i = 0; i < n; i++) S.drops.push({ item: e.item, x: x + Math.random() * 30 - 15, y: y + Math.random() * 16 - 4, born: S.t });
  }
}
function stepDecos(dt) {
  for (const d of S.world.decos) {
    if (d.shake > 0) d.shake -= dt;
    // 重生：時間到，且該格沒有家具（有家具就一直等到家具被拿走）
    if (d.dead && S.t >= d.respawnAt && !S.occ.has(key(d.cell[0], d.cell[1]))) { d.dead = false; d.hp = undefined; d.shake = 0; }
  }
}
function stepDrops(dt) {
  const p = S.players[0];
  for (let i = S.drops.length - 1; i >= 0; i--) {
    const dr = S.drops[i];
    if (S.t - dr.born < .5 || Math.hypot(dr.x - p.x, dr.y - p.y) > 24) continue;
    S.drops.splice(i, 1);
    S.inv[dr.item] = (S.inv[dr.item] || 0) + 1;
    lsSet('dcisland.m0.inv', S.inv);
    toast(`獲得 ${S.toolsDB.items[dr.item].name} ×1（共 ${S.inv[dr.item]}）`, 1600);
  }
}

function doAttack(auto, wx, wy) {   // wx,wy：滑鼠點的世界座標（F 鍵沒有）
  const p = S.players[0];
  S._hits = 0;
  if (S.mode !== 'walk') return;
  if (p.dead) return;
  if (S.t < (p.petUntil ?? 0)) { if (!quiet) say('被石化了，動彈不得', 1200); return; }   // 石化：不能揮擊／採集／互動（長按時不重複提示）
  if (p.fish) { if (!quiet) fishAction(); S._hits = 1; return; }   // 釣魚中：F／點擊＝收竿或拉竿，不做別的事
  if (p.pose) {   // 坐著/睡著不能揮擊；按 F（不是長按的自動重複）就起身
    if (auto && !quiet) { standUp(p); S.holdSkipF = true; }
    return;
  }
  if (auto) {   // F 鍵：前方有可破壞物件就自動用對應工具
    // 島主在揮擊範圍內就優先打牠：採集／座位／NPC 都讓位（島主常駐重生點，旁邊一堆家具，按 F 不該變成坐下）
    const own = S.animals.find(a => {
      const od = animalDef(a.id);
      return od?.owner && !a.dead && !a.fly && inHit(p, a);
    });
    const ownerFirst = !!own;
    if (!ownerFirst) {
      const d = decoNear(p);
      if (d) { S._hits = 1; useTool(d); return; }
      const sgn = quiet ? null : signNear(p);    // 身邊有看板就打開（長按自動連擊不會反覆打開）
      if (sgn) { S._hits = 1; openSign(sgn); S.holdSkipF = true; return; }
      const seat = quiet ? null : seatNear(p);   // 身邊有椅子/沙發/床就坐下（長按自動連擊不會反覆切換）
      if (seat) { S._hits = 1; usePose(seat); S.holdSkipF = true; return; }
      const npc = quiet ? null : npcNear(p);       // 身邊有 NPC 就跟他說話
      if (npc) { S._hits = 1; talkTo(npc); S.holdSkipF = true; return; }
    }
  }
  if (isRod()) { S._hits = 1; if (!quiet) fishAction(wx, wy); return; }   // 拿著釣竿：拋竿（不能攻擊）
  if (S.me.weapon === 'hands') { say('先在「造型」裡裝備武器！'); return; }
  if (!S.weaponImgs[S.me.weapon]) return;
  if (S.t - p.lastAtk < ATK_CD) return;
  p.lastAtk = S.t; p.swing = ATK_T; p.tool = null;
  S.net?.notifyAttack?.();          // M2：讓同島的人看到你的揮擊
  for (const a of S.animals) {
    if (a.dead || a.fly) continue;   // 島主飛在空中打不到
    if (!inHit(p, a)) continue;      // 武器尖端進了怪物的判定圈才算（不看面向）
    S._hits++;
    const crit = Math.random() < .18;
    const dmg = crit ? 2 : 1;
    const od = animalDef(a.id);
    if (od.owner && a.proxy) {   // 島主連線時由伺服器權威：送意圖（座標＋傷害＋我們看到的龍位置），本地不扣血（血量等伺服器廣播）
      S.net?.dragonHit?.(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, dmg, Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10);
    } else {
      a.hp -= dmg;
      a.startle = 1; a.startleT = 3; a.target = null; a.idle = 0;
    }
    S.floaters.push({ x: a.x + (Math.random() * 24 - 12), y: a.y - 42, v: String(dmg), life: .8, crit });
    if (od.owner) {   // 打到島主：不逃跑，觸發反擊（龍衝＝瞬移島緣、蛇女＝原地開眼；飛行/預警/歇腳或冷卻中不重觸發；連線時反擊由伺服器觸發）
      if (!a.proxy) {
        // 單機：記住攻擊者（仇恨換人用）與最後被打時刻；龍衝 CD 中被打是進仇恨追殺
        a.hitBook = a.hitBook || new Map(); a.hitBook.set(p, S.t);
        a.lastHitAt = S.t;
        if (!a.fly && !a.cast && !a.rest && !a.sayPhase && S.t >= (a.rageCd ?? 0)) ownerTakeoff(a, p);
        else if (!a.aggro && !a.fly && !a.cast && !a.rest && !a.sayPhase && !a.wleg && S.t < (a.rageCd ?? 0)) ownerAggroStart(a, p);
      }
    } else {
      a.target = fleeTarget(a, od, p.x, p.y, 220);
    }
    if (a.hp <= 0) {
      a.dead = true; a.dieT = .6;
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      if (!od.owner) {   // 殺到動物回 1 HP（島主是伺服器權威事件，不算在此）
        const me = S.players[0];
        me.hp = Math.min(PLAYER_HP, (me.hp ?? PLAYER_HP) + 1);
        S.floaters.push({ x: me.x, y: me.y - 50, v: '+1', life: .7 });
      }
      toast(`${animalDef(a.id).name} 被打倒了！${S.animalsDB.respawn || 30} 秒後重生`, 2200);
    }
  }
}

// ---- 動物的可站位置：只有會游泳的（animals.json 的 swim:true，例如蛙）能進海，其餘只在陸地/岸邊 ----
function animalCanStand(def, x, y) {
  const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
  if (gx < 1 || gy < 1 || gx > COLS - 1 || gy > ROWS - 1) return false;
  return !!def.swim || S.world.types[gy * COLS + gx] !== 0;
}
// 逃跑目標：朝「遠離來源」的方向跑，但不會游泳的不能越過水邊；被海擋住就往旁邊繞，挑跑得最遠的方向
function fleeTarget(a, def, srcX, srcY, dist) {
  const base = Math.atan2(a.y - srcY, a.x - srcX);
  let best = null, bestR = -9;
  for (const off of [0, .6, -.6, 1.2, -1.2, 1.8, -1.8]) {
    const cx = Math.cos(base + off), cy = Math.sin(base + off);
    let r = 0;
    while (r < dist && animalCanStand(def, a.x + cx * (r + 8), a.y + cy * (r + 8))) r += 8;
    if (r > bestR + 8) { best = { x: a.x + cx * r, y: a.y + cy * r }; bestR = r; }   // 偏好正前方，別的方向要明顯更遠才換
  }
  return { x: best.x, y: best.y, flee: true };
}
// 站在水裡/岸邊時，找最近的陸地（游泳的逃到海上後要游回來）；已在陸地回 null
function nearestLand(a) {
  const gx = Math.floor(a.x / CELL), gy = Math.floor(a.y / CELL);
  const land = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && S.world.types[y * COLS + x] === 2;
  if (land(gx, gy)) return null;
  for (let r = 1; r <= 14; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (land(gx + dx, gy + dy)) return { x: (gx + dx) * CELL + CELL / 2, y: (gy + dy) * CELL + CELL / 2 };
    }
  }
  return null;
}

// ---- 島主的龍衝反擊（連線時由伺服器權威同步，這裡是單機模擬與共用演出）：被打後先說台詞，再瞬間消失、在島隨機邊緣現蹤瞄準攻擊者 ----
// 預警範圍提示 1 秒後，以龍本體直線飛衝過島（攻擊範圍＝龍的大小，被撞到＝KO），衝到對岸落地歇一下後就地繼續散步／追殺
const OWNER_FLY_SPEED = 240, OWNER_DASH_SPEED = 560, OWNER_CAST = 1, OWNER_CD = 12;
const OWNER_GAZE_CAST = 2;      // 石化之瞳的開眼預警秒數（與兩份伺服器的 D_GAZE_CAST_MS 一致）
const OWNER_PETRIFY_MS = 10000; // 石化時長：不能移動＋每秒扣 1 HP（判定在各人自己的畫面，不進同步協定）
const OWNER_WALK_SPEED = 34, OWNER_LEG_MIN = 1500, OWNER_PAUSE = [1.5, 4];   // 閒晃：路點間散步速度／每腿最短時長／休息範圍（秒）
const OWNER_REGEN = 18;   // 島主每秒回血（單機本地模擬；連線時血量由伺服器權威，與兩份伺服器的 D_REGEN 一致）
const OWNER_CHASE_SPEED = 180, OWNER_CLAW_RANGE = 36, OWNER_CLAW_CD = 1, OWNER_CLAW_DMG = 2;   // 仇恨追殺：速度（比玩家走路快、比跑步慢）／爪擊範圍／間隔／傷害（與伺服器 D_* 一致）
const OWNER_AGGRO_MS = 5, OWNER_DROPOUT = 30;                              // 仇恨換人週期／多久沒被打就脫離仇恨（秒）
const PLAYER_REGEN = 1;   // 玩家脫離戰鬥後每秒回幾點血（場上有島主處於仇恨／攻擊狀態、或自己被石化時不回）
const PLAYER_HP = 10;     // 玩家血量上限：爪擊扣 2（5 下倒地）、龍衝直接倒地、石化每秒扣 1、殺一隻動物回 1、復活即滿血
// 島主攻擊樣式（animals.json 的 atk 欄位）：dash＝龍衝（黃金肥龍）、gaze＝石化之瞳（笨蛋蛇女）
const ownerAtk = def => def.atk || 'dash';
// 島主被激怒的台詞（per 島主 id）：發動反擊前隨機說一句（不連續重複）
const OWNER_LINES = {
  gold_dragon: ['紅月啊，用你的熾熱燒盡敵人！', '紅月啊，照亮我征服的道路！', '熾熱的通路啊，引導我走向征服！',
                '皎潔的紅月啊，傾注你的光芒！', '我自高空降臨，將敵人全部擊碎！', '我自高空降臨，重塑這個世界！'],
  snake_queen: ['石化之瞳啊，睜開吧！', '蠢貨們，在我的面前化為石像吧！', '美，就該凝固在最完美的一刻！',
                '蛇髮的詛咒啊，貫穿眼前的一切！', '別亂動喔……一動就變石頭了。', '乖乖站好，這可是你最後一次能動了。'],
};
function ownerSay(a) {
  const lines = OWNER_LINES[a.id] || OWNER_LINES.gold_dragon;
  let line;
  do { line = lines[Math.floor(Math.random() * lines.length)]; } while (lines.length > 1 && line === a.lastLine);
  a.lastLine = line;
  a.say = { text: line, until: S.t + 3 };
}
function ownerEdgeAt(angle) {
  // 從島心沿指定角度找最後一格陸地（島邊緣）
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let last = [cx, cy];
  for (let r = 1; r <= 44; r++) {
    const x = Math.round(cx + ux * r), y = Math.round(cy + uy * r);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
    if (S.world.types[y * COLS + x] === 0) break;
    last = [x, y];
  }
  return { x: last[0] * CELL + CELL / 2, y: last[1] * CELL + CELL / 2 };
}
function ownerTakeoff(a, src) {
  // 被打：先在原地說台詞（3 秒泡泡），說完才瞬移到島緣（ownerStep 的 sayPhase 接手）。
  // 一被打就建立仇恨（龍衝照放），落地歇完就接著追殺同一個攻擊者，不用再被打一次
  ownerSay(a);
  a.sayPhase = S.t + 3; a.saySrc = { x: src.x, y: src.y };
  a.target = null; a.idle = 0; a.wleg = null;
  a.aggro = { target: src, rotateAt: S.t + OWNER_AGGRO_MS, clawAt: 0 };
  a.rageCd = S.t + 4;   // 說台詞＋開眼/預警期間被打不重觸發（發射時會再設為 OWNER_CD）
}
function ownerWarp(a, src) {   // 說完台詞：瞬移到島緣鎖定攻擊者，準備龍衝
  const def = animalDef(a.id);
  S.floaters.push({ x: a.x, y: a.y - 40, poof: true, life: .55 });   // 原地消失
  const to = ownerEdgeAt(Math.random() * Math.PI * 2);               // 島隨機邊緣現蹤
  a.x = to.x; a.y = to.y; a.z = 0; a.target = null; a.idle = 0; a.bounce = 0;
  a.dir = src.x < a.x ? -1 : 1;
  S.floaters.push({ x: a.x, y: a.y - 40, poof: true, life: .55 });
  a.cast = OWNER_CAST; a.castFrom = { x: src.x, y: src.y };   // 鎖定攻擊者位置＝龍衝方向（走位就能躲）
  a.dashDest = null; a.wleg = null;
  toast(`${def.name} 瞬間消失，在島緣現出蹤影鎖定了你！`, 2400);
}
function ownerStep(a, dt, def) {
  if (a.sayPhase) {   // 說台詞：原地不動（泡泡顯示中），說完照攻擊樣式接手（龍衝＝瞬移島緣；蛇女＝原地開眼）
    if (S.t < a.sayPhase) { a.z = 0; return; }
    const src = a.saySrc;
    a.sayPhase = 0; a.saySrc = null;
    if (ownerAtk(def) === 'gaze') ownerGazeCast(a, src);
    else ownerWarp(a, src);
    return;
  }
  if (a.cast) {
    a.cast -= dt;   // 預警：龍衝＝金色虛線鎖定攻擊範圍；石化之瞳＝大眼睛＋綠色虛線
    if (a.cast <= 0) {
      a.cast = 0;
      if (ownerAtk(def) === 'gaze') gazeFire(a, def);
      else ownerDive(a, def);
    }
    return;
  }
  if (a.rest) {   // 龍衝結束在邊緣歇腳：停一下，然後就在當地繼續閒晃（不回中心）
    a.rest -= dt;
    if (a.rest <= 0) {
      a.rest = 0;
      a.idle = .5 + Math.random() * 1.5;   // 單機：歇完由路點挑選接手；連線：等伺服器的 wander 事件
    }
    return;
  }
  // 飛行（龍衝或回中心）：直線掠過（飛在空中，龍也可以越過海）
  const dx = a.flyTo.x - a.x, dy = a.flyTo.y - a.y, d = Math.hypot(dx, dy);
  if (d < 14) {
    if (a.dashU) {   // 龍衝到底（島邊緣對岸）：落地停下歇一下
      a.fly = false; a.dashU = null; a.z = 0; a.bounce = 0;
      a.rest = .7;
      return;
    }
    // 飛回中心：落地下來，恢復一般漫步
    a.fly = false; a.retHome = false; a.z = 0; a.bounce = 0;
    return;
  }
  if (dx) a.dir = Math.sign(dx);
  const sp = a.dashU ? OWNER_DASH_SPEED : OWNER_FLY_SPEED;
  a.x += dx / d * sp * dt; a.y += dy / d * sp * dt;
  a.bounce += dt * (a.dashU ? 14 : 8);
  if (a.dashU) {
    a.z = 34 + Math.sin(a.bounce * 1.4) * 5;   // 龍衝：貼地高速掠過
    // 攻擊範圍＝龍的大小：路徑上被龍本體撞到（貼太近）就被打倒
    const q = S.players[0];
    if (!q.dead && Math.hypot(q.x - a.x, q.y - a.y) < 20 * (def.big || 1)) killPlayer(q, def.name, '龍衝');
  } else {
    a.z = 70 + Math.sin(a.bounce) * 7;   // 升空高度
  }
}
function ownerDive(a, def) {
  const u = { x: a.castFrom.x - a.x, y: a.castFrom.y - a.y };
  const len = Math.hypot(u.x, u.y) || 1;
  u.x /= len; u.y /= len;
  a.castFrom = null; a.rageCd = S.t + OWNER_CD;
  // 龍衝：直線飛越整座島，終點是這個方向上的島邊緣對岸（最後一格陸地）；連線時終點由伺服器算好（dashDest）
  const dest = a.dashDest || (() => {
    const gx = Math.floor(a.x / CELL), gy = Math.floor(a.y / CELL);
    let last = [gx, gy];
    for (let r = 1; r <= 50; r++) {
      const x = Math.round(gx + u.x * r), y = Math.round(gy + u.y * r);
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
      if (S.world.types[y * COLS + x] === 0) break;
      last = [x, y];
    }
    return { x: last[0] * CELL + CELL / 2, y: last[1] * CELL + CELL / 2 };
  })();
  a.dashDest = null;
  a.fly = true; a.dashU = u;
  a.flyTo = dest;
  a.dir = u.x < 0 ? -1 : 1;
  toast(`${def.name} 發動龍衝！`, 2000);
}

// ---- 石化之瞳（笨蛋蛇女的攻擊，atk: "gaze"）：不瞬移，原地開眼 2 秒 → 全地圖「正面朝著她」的人石化 ----
// 沒有直線、不看距離：發射瞬間臉朝向蛇女的人（左右朝向）都會石化，背對她／看向另一邊就安全。
// 石化由各客戶端自判（跟龍衝的受害者自判同源）；伺服器仍會帶光束幾何（舊協定），客戶端不再用它判定
function ownerGazeCast(a, src) {   // 說完台詞：原地開眼（大眼睛預警），蛇女轉向攻擊者
  const def = animalDef(a.id);
  a.cast = OWNER_GAZE_CAST; a.castFrom = { x: src.x, y: src.y };
  a.wleg = null; a.z = 0; a.fly = false;
  a.dir = src.x < a.x ? -1 : 1;
  toast(`${def.name} 睜開了石化之瞳——面向她就會石化，快轉身背對她！`, 2600);
}
// 這個人是不是「正面朝著」蛇女：朝向向量（往上走＝(0,-1)、往下＝(0,1)、側面＝(dir,0)）與「到蛇女的方向」夾角小於約 80°。
// 背對（往上走而蛇女在下方）或看向旁邊（側面而蛇女在正上/正下方）都安全；重疊（距離<1）算面對
const facingVec = q => q.face === 'up' ? [0, -1] : q.face === 'down' ? [0, 1] : [q.dir || 1, 0];
const facingGazer = (q, a) => {
  const dx = a.x - q.x, dy = a.y - q.y, d = Math.hypot(dx, dy);
  if (d < 1) return true;
  const [fx, fy] = facingVec(q);
  return (fx * dx + fy * dy) / d > .17;
};
function gazeFire(a, def) {   // 開眼結束：石化之瞳發射（全地圖光閃一下），判定在各人自己的畫面
  a.castFrom = null;
  a.rageCd = S.t + OWNER_CD;
  S.floaters.push({ beam: true, x1: a.x, y1: a.y - 24 * (def.big || 1), life: .7 });
  gazePetrify(a, def);
  toast(`${def.name} 的石化之瞳發射了！`, 2000);
}
function gazePetrify(a, def) {   // 面向蛇女的玩家石化（全地圖）：自己不能動＋每秒扣 1 HP；別人只做灰階演出（由對方畫面自判）
  const hit = q => !q.dead && facingGazer(q, a);
  const me = S.players[0];
  if (hit(me)) petrifyPlayer(me, def.name);
  for (const r of S.remotes.values()) {
    if (hit(r)) r.petUntil = S.t + OWNER_PETRIFY_MS / 1000;
  }
}
function petrifyPlayer(p, cause) {   // 石化：10 秒不能移動／跳躍／揮擊／採集／F 互動，每秒扣 1 HP；扣死照既有墓碑機制
  if (p.dead) return;
  if (p.pose) standUp(p);
  p.petUntil = S.t + OWNER_PETRIFY_MS / 1000;
  p.petTick = S.t + 1; p.petCause = cause;
  p.moving = false;
  S.floaters.push({ x: p.x, y: p.y - 46, v: '石化', life: 1.1, crit: true });
  toast(`被 ${cause} 石化了！${OWNER_PETRIFY_MS / 1000} 秒動彈不得（每秒扣 1 HP）`, 3000);
}

// ---- 玩家血量＋島主仇恨（龍衝冷卻中的追殺）----
// 單機本地模擬在這裡；連線時追殺流程由伺服器權威（aggro/claw/wander 事件），但「自己有沒有被打到」仍是各人自判
function playerDamage(p, dmg, cause) {
  if (p.dead) return;
  p.hp = Math.max(0, (p.hp ?? PLAYER_HP) - dmg);
  S.floaters.push({ x: p.x + (Math.random() * 20 - 10), y: p.y - 50, v: String(dmg), life: .8, crit: true });
  if (p.hp <= 0) killPlayer(p, cause);
}
// 場上有沒有島主正在戰鬥（仇恨追殺、預警、龍衝、開眼、說台詞、歇腳都算）；連線時這些旗標由伺服器事件驅動
function ownerEngaged() {
  return S.animals.some(a => !a.dead && animalDef(a.id)?.owner &&
    (a.aggro || a.fly || a.cast || a.castFrom || a.rest || a.sayPhase || a.cycle || a.gaze));
}
// 龍衝 CD 中被打：進入仇恨（單機版；連線版由伺服器廣播 aggro 事件）
function ownerAggroStart(a, src) {
  const def = animalDef(a.id);
  a.aggro = { target: src, rotateAt: S.t + OWNER_AGGRO_MS, clawAt: S.t + OWNER_CLAW_CD };
  a.wleg = null; a.target = null; a.idle = 0;
  if (src === S.players[0]) toast(`${def.name} 火冒三丈地追殺你！快跑！`, 2600);
  else if (!src.npc) toast(`${def.name} 追殺 ${src.name}！`, 2200);
}
// 最近打過牠的攻擊者（hitBook：玩家→最後攻擊時刻），仇恨換人從這裡隨機挑
function ownerAggroPick(a, ag) {
  const cands = [...(a.hitBook?.entries() || [])]
    .filter(([p, t]) => S.t - t <= OWNER_DROPOUT && !p.dead && p !== ag.target)
    .map(([p]) => p);
  return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
}
// 仇恨狀態的單機 tick：追（每腿重瞄目標、速度 180）、進範圍就每秒一抓（扣 2 HP）、
// 目標死了／5 秒到隨機換攻擊者、龍衝 CD 到了自動對目標放龍衝、30 秒（OWNER_DROPOUT）沒人打就脫離回閒晃
function ownerAggroStep(a, dt, def) {
  const ag = a.aggro;
  if (S.t - (a.lastHitAt ?? 0) > OWNER_DROPOUT) {   // 太久沒人打：脫離仇恨
    a.aggro = null; a.idle = .8;
    toast(`${def.name} 冷靜下來，繼續散步。`, 1600);
    return;
  }
  if (S.t >= (a.rageCd ?? 0)) {   // 龍衝 CD 到了：對現在的仇恨目標自動放龍衝
    const t = ag.target;
    a.aggro = null;
    ownerTakeoff(a, t);
    return;
  }
  let t = ag.target;
  if (!t || t.dead) {   // 目標死了：隨機換下一個攻擊者；沒有就脫離仇恨
    const np = ownerAggroPick(a, ag);
    if (!np) { a.aggro = null; a.idle = .8; toast(`${def.name} 冷靜下來，繼續散步。`, 1600); return; }
    ag.target = np; ag.rotateAt = S.t + OWNER_AGGRO_MS; ag.clawAt = S.t + OWNER_CLAW_CD;
    toast(np === S.players[0] ? `${def.name} 換成追殺你！` : `${def.name} 換成追殺 ${np.name}！`, 2200);
  } else if (ag.rotateAt && S.t >= ag.rotateAt) {   // 5 秒到：複數攻擊者時隨機換目標
    const np = ownerAggroPick(a, ag);
    if (np) {
      ag.target = np; ag.rotateAt = S.t + OWNER_AGGRO_MS; ag.clawAt = S.t + OWNER_CLAW_CD;
      if (np === S.players[0] && t !== np) toast(`${def.name} 換成追殺你！`, 2200);
    }
  }
  t = ag.target;
  const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy);
  if (d <= OWNER_CLAW_RANGE) {   // 爪擊範圍內：站定連抓，每秒一下（前方扇形由範圍貼著目標的方向決定）
    a.wleg = null; a.z = 0;
    if (dx) a.dir = Math.sign(dx);
    if (S.t >= ag.clawAt) {
      ag.clawAt = S.t + OWNER_CLAW_CD;
      // 爪擊特效：三道金色抓痕掃向目標（龍與目標之間 45% 處）＋被打者紅色衝擊圈
      S.floaters.push({ x: a.x + (t.x - a.x) * .45, y: a.y - 30 + (t.y - a.y) * .45,
                        ang: Math.atan2(t.y - a.y, t.x - a.x), slash: true, life: .45 });
      if (t.remote) {   // 遠端玩家的血量由對方自己的畫面計算（刻意不同步傷害），這裡只演出
        S.floaters.push({ x: (a.x + t.x) / 2, y: (a.y + t.y) / 2 - 24, v: '2', life: .8, crit: true });
        S.floaters.push({ x: t.x, y: t.y - 24, ring: true, life: .35 });
      } else {
        playerDamage(t, 2, def.name);
        S.floaters.push({ x: t.x, y: t.y - 24, ring: true, life: .35 });
      }
    }
    return;
  }
  // 追：跟散步同一套腿插值，每腿結束就重新瞄目標目前位置
  if (a.wleg) { stepOwnerWalk(a, dt); return; }
  const tms = Math.max(120, Math.round(d / OWNER_CHASE_SPEED * 1000));
  a.wleg = { fx: a.x, fy: a.y, tx: t.x, ty: t.y, tms, t0ms: Date.now() };
}

// ---- 島主閒晃：idle 時在島上四處散步（連線時路點由伺服器廣播，單機自己挑；兩邊演算法一致）----
// 挑路點：附近 6～16 格的隨機陸地，直線不能太抄水；每腿最短 1.5 秒
function ownerPickLeg(x, y) {
  for (let tries = 0; tries < 24; tries++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = (6 + Math.random() * 10) * CELL;
    const tx = x + Math.cos(ang) * dist, ty = y + Math.sin(ang) * dist;
    const gx = Math.round(tx / CELL - .5), gy = Math.round(ty / CELL - .5);
    if (gx < 1 || gy < 1 || gx >= COLS - 1 || gy >= ROWS - 1) continue;
    if (S.world.types[gy * COLS + gx] === 0) continue;
    const steps = Math.max(1, Math.ceil(dist / CELL));
    let water = 0;
    for (let s = 0; s <= steps; s++) {
      const sx = x + (tx - x) * s / steps, sy = y + (ty - y) * s / steps;
      if (S.world.types[Math.floor(sy / CELL) * COLS + Math.floor(sx / CELL)] === 0) water++;
    }
    if (water / (steps + 1) > .1) continue;
    return { fx: x, fy: y, tx: gx * CELL + CELL / 2, ty: gy * CELL + CELL / 2,
             tms: Math.max(OWNER_LEG_MIN, Math.round(dist / OWNER_WALK_SPEED * 1000)) };
  }
  return null;
}
// 路點插值：位置由牆鐘 (Date.now()-t0ms)/tms 決定，跟伺服器的演算法一致（分頁凍結後恢復也能直接跳到正確位置）
function stepOwnerWalk(a, dt) {
  const w = a.wleg;
  const t = Math.min(1, Math.max(0, (Date.now() - w.t0ms) / w.tms));
  a.x = w.fx + (w.tx - w.fx) * t;
  a.y = w.fy + (w.ty - w.fy) * t;
  if (w.tx !== w.fx) a.dir = Math.sign(w.tx - w.fx);
  a.bounce += dt * 8;
  a.z = Math.abs(Math.sin(a.bounce * Math.PI)) * 4;
  if (t >= 1) { a.wleg = null; a.z = 0; a.legEndedAt = Date.now(); }
}
// 連線的島主：整個反擊循環（預警→龍衝→歇腳）用牆鐘插值，與伺服器的 dragonPhase 同軸——
// webview 的 rAF 被節流也不會慢動作或只瞬移，每一幀都畫在伺服器時序的正確位置
function stepOwnerProxy(a, dt, def) {
  if (a.gaze) {   // 石化之瞳：原地開眼（牆鐘與伺服器同軸），castMs 到就本地發射（光束＋石化判定，受害者自判）
    const g = a.gaze, el = Date.now() - g.t0ms;
    a.x = g.x; a.y = g.y; a.z = 0; a.fly = false;
    a.cast = Math.max(0, (g.castMs - el) / 1000); a.castFrom = g.from;
    if (el >= g.castMs) {
      a.gaze = null; a.cast = 0; a.castFrom = null;
      gazeFire(a, def);
    }
    return;
  }
  const c = a.cycle;
  if (!c) {   // 沒有進行中的反擊循環：散步或站著等伺服器
    if (a.wleg) { stepOwnerWalk(a, dt); return; }
    a.z = 0; a.fly = false;
    // 腿走完超過 6 秒還沒有新的 wander 事件（正常歇腳 ≤4 秒）＝漏接事件：向伺服器要快照自癒
    if (a.legEndedAt && Date.now() - a.legEndedAt > 6000) {
      a.legEndedAt = Date.now();
      S.net?.requestDragonSnap?.();
    }
    return;
  }
  const el = Date.now() - c.t0ms;
  if (el < c.castMs) {   // 島緣鎖定（預警）：站在定點，畫金色虛線
    a.x = c.warp.x; a.y = c.warp.y; a.z = 0; a.fly = false;
    a.cast = (c.castMs - el) / 1000; a.castFrom = c.from;
    return;
  }
  a.cast = 0; a.castFrom = null;
  const dp = Math.min(1, (el - c.castMs) / c.dashMs);
  a.x = c.warp.x + (c.dest.x - c.warp.x) * dp;
  a.y = c.warp.y + (c.dest.y - c.warp.y) * dp;
  a.dir = c.dest.x < c.warp.x ? -1 : 1;
  if (dp < 1) {   // 龍衝：貼地高速掠過，路徑上的玩家被撞倒（受害者自己判定）
    a.fly = true;
    a.bounce += dt * 14;
    a.z = 34 + Math.sin(a.bounce * 1.4) * 5;
    const q = S.players[0];
    if (!q.dead && Math.hypot(q.x - a.x, q.y - a.y) < 20 * (def.big || 1)) killPlayer(q, def.name, '龍衝');
    return;
  }
  a.fly = false; a.z = 0;   // 落地歇腳（restMs），之後等伺服器的 wander 事件接續散步
  if (el > c.castMs + c.dashMs + c.restMs) a.cycle = null;
}

// ---- 島主的伺服器同步：連線時島主本體與流程由伺服器權威，客戶端只負責演出和自己有沒有被打到 ----
// 事件：aim（龍衝：瞬移島緣鎖定攻擊者）/ gaze（石化之瞳：原地開眼鎖定直線）/ hp（扣血）/ dead（被打倒）/ spawn（重生）/ state（進有島主的地形時的快照）
// 陸地位圖：世界由前端種子生成，伺服器不知道島形；進有島主的地形時上傳（RLE，1＝陸地，與 ownerEdgeAt 的判定一致：types!==0）
function landRLE() {
  const t = S.world.types, n = COLS * ROWS;
  const runs = [t[0] !== 0 ? 1 : 0];   // 第一個值是起始值，之後交替
  let val = runs[0], run = 0;
  for (let i = 0; i < n; i++) {
    const v = t[i] !== 0 ? 1 : 0;
    if (v === val) run++;
    else { runs.push(run); val = v; run = 1; }
  }
  runs.push(run);
  return runs.join(':');
}
// 上傳島形：每條連線、每個有島主的地形只傳一次（約 20KB；以前切地形、每次島主快照都重傳，Worker 每次都寫儲存）。
// S.landSent 記「這條連線已傳過的地形」，重連時（onOpen）清掉
function uploadLandMap() {
  if (!netOn() || !S.world || !S.terrains[S.terrain]?.owner || S.landSent === S.terrain) return;
  S.landSent = S.terrain;
  S.net.sendDragonMap(landRLE());
}
// 取得（或建立）伺服器同步的島主 proxy；單機本地模擬的島主沒有 proxy 旗標
function dragonEnsure(x, y, hp) {
  const oid = S.terrains[S.terrain]?.owner;
  if (!oid) return null;
  let a = S.animals.find(v => v.id === oid);
  if (!a) {
    const def = animalDef(oid);
    a = { id: oid, x, y, dir: 1, target: null, idle: 0, startle: 0, z: 0, bounce: 0,
          hp: hp ?? def.hp, maxHp: def.hp, dead: false, dieT: 0, proxy: true };
    S.animals.push(a);
  }
  a.proxy = true;   // 開機時（還沒連線）可能已本地生成了島主，接手時補上 proxy 旗標改為伺服器同步
  return a;
}
// 套用進草島時的島主快照：不論收到時龍在哪個階段都接得上（預警剩餘時間、衝刺位置、歇腳…）
function applyDragonSnap(o) {
  if (o.ph === 'dead') return;   // 死了就先不生成，等 spawn 事件
  const a = dragonEnsure(o.x, o.y, o.hp);
  if (!a) return;
  a.hp = o.hp; a.dead = false; a.dieT = 0; a.startle = 0; a.target = null; a.wleg = null; a.cycle = null; a.gaze = null;
  a.aggro = o.aggro != null;   // 快照帶仇恨目標（連線編號）：中途進場也知道牠在追殺（戰鬥中不自動回血、之後會提示冷靜）
  if (o.ph === 'aim') {   // 島緣鎖定中：還原成循環（扣掉已過的預警時間）
    const total = 1000;
    a.cycle = {
      t0ms: Date.now() - (total - (o.castMs || total)), castMs: total, restMs: 700,
      dashMs: Math.max(1, Math.hypot(o.dx - o.x, o.dy - o.y) / OWNER_DASH_SPEED * 1000),
      warp: { x: o.x, y: o.y }, from: { x: o.tx, y: o.ty }, dest: { x: o.dx, y: o.dy },
    };
    a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
    a.dir = o.tx < o.x ? -1 : 1;
  } else if (o.ph === 'dash') {   // 龍衝中：從目前位置以剩餘距離還原衝刺段（castMs=0 直接進衝刺）
    a.cycle = {
      t0ms: Date.now(), castMs: 0, restMs: 700,
      dashMs: Math.max(1, Math.hypot(o.dx - o.x, o.dy - o.y) / OWNER_DASH_SPEED * 1000),
      warp: { x: o.x, y: o.y }, from: null, dest: { x: o.dx, y: o.dy },
    };
    a.x = o.x; a.y = o.y; a.dir = o.dx < o.x ? -1 : 1;
  } else if (o.ph === 'rest') {   // 衝到底歇腳中：瞬間落地，歇剩餘時間
    a.cycle = { t0ms: Date.now(), castMs: 0, dashMs: 1, restMs: o.restMs || 700,
                warp: { x: o.x, y: o.y }, from: null, dest: { x: o.x, y: o.y } };
    a.x = o.x; a.y = o.y; a.z = 0;
  } else if (o.ph === 'say') {   // 說台詞中：站在原地（說完才會收到 aim/gaze 事件）
    a.cycle = null; a.wleg = null;
    a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
    ownerSay(a);
  } else if (o.ph === 'cast') {   // 石化之瞳開眼中：原地站定，接續剩餘的開眼時間後本地發射
    a.cycle = null; a.wleg = null;
    const total = 2000, remain = Math.max(0, Math.min(total, o.castMs || total));
    a.gaze = { t0ms: Date.now() - (total - remain), castMs: total,
               from: { x: o.tx, y: o.ty }, x: o.x, y: o.y, bx: o.bx, by: o.by };
    a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
    a.dir = o.tx < a.x ? -1 : 1;
  } else if (o.ph === 'gohome') {   // 舊伺服器相容：當作在當地站著
    a.cycle = null;
    a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
  } else {   // idle：站著，或接續伺服器正在走的散步腿
    a.cycle = null;
    a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
    if (o.wleg) a.wleg = { fx: o.wleg.fx, fy: o.wleg.fy, tx: o.wleg.tx, ty: o.wleg.ty, tms: o.wleg.tms, t0ms: Date.now() - (o.wleg.el || 0) };
  }
}
function onNetDragon(m) {
  if (!S.terrains[S.terrain]?.owner) return;   // 島主事件只跟有島主的地形有關（伺服器只會廣播給同地形的人）
  if (m.terrain && m.terrain !== S.terrain) return;   // 切地形的空檔還收得到舊島的事件（客戶端先換、伺服器後處理 enter），別套到新島的島主上
  if (m.ev === 'state') {
    applyDragonSnap(m);
    uploadLandMap();   // 保險：這條連線在這個地形還沒傳過島形就補傳（已傳過就不重送）
    return;
  }
  const a = S.animals.find(v => v.id === S.terrains[S.terrain].owner);
  if (m.ev === 'hp') {   // 別人（或自己）打到牠：更新血條
    if (a) a.hp = m.hp;
    return;
  }
  if (m.ev === 'dead') {   // 被打倒了：原地死亡；重生等伺服器的 spawn 事件，不排本地重生
    if (a && !a.dead) {
      a.dead = true; a.dieT = .6; a.fly = false; a.dashU = null; a.cast = 0; a.castFrom = null; a.rest = 0; a.wleg = null; a.cycle = null; a.gaze = null; a.aggro = false;
      if (m.x !== undefined) { a.x = m.x; a.y = m.y; }
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      toast(`${animalDef(a.id).name} 被打倒了！30 秒後重生`, 2200);
    }
    return;
  }
  if (m.ev === 'spawn') {   // 重生：在島緣（沒島形時中心）現蹤
    const na = dragonEnsure(m.x, m.y, m.hp);
    if (na) {
      na.dead = false; na.dieT = 0; na.x = m.x; na.y = m.y; na.hp = m.hp; na.z = 0;
      na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.idle = 1.2; na.wleg = null; na.cycle = null; na.gaze = null; na.aggro = false;
    }
    toast(`${animalDef(S.terrains[S.terrain].owner).name} 回來了！`, 1600);
    return;
  }
  if (m.ev === 'say') {   // 島主被激怒：先在原地說台詞（泡泡 3 秒），說完才反擊（龍衝＝瞬移島緣；蛇女＝原地開眼）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.wleg = null;
    na.x = m.x; na.y = m.y;
    ownerSay(na);
    return;
  }
  if (m.ev === 'gaze') {   // 蛇女開眼：原地石化預警（castMs 後本地發射；發射瞬間面向她的人石化）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.rest = 0; na.retHome = false; na.cycle = null; na.wleg = null;
    na.x = m.x; na.y = m.y; na.z = 0;
    if (m.hp != null) na.hp = m.hp;
    na.dir = m.tx < na.x ? -1 : 1;
    na.gaze = { t0ms: Date.now(), castMs: m.castMs || OWNER_GAZE_CAST * 1000,
                from: { x: m.tx, y: m.ty }, x: m.x, y: m.y, bx: m.bx, by: m.by };
    const me = S.players[0];
    const facing = !me.dead && facingGazer(me, na);
    toast(facing ? `${animalDef(na.id).name} 睜開了石化之瞳——你正面對她，快轉身背對她！`
                 : `${animalDef(na.id).name} 睜開了石化之瞳——別面向她！`, 2600);
    return;
  }
  if (m.ev === 'wander') {   // 島主往新路點散步（伺服器帶路；插值與伺服器一致，凍結恢復也正確）
    const na = a || dragonEnsure(m.fx, m.fy);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null;
    na.wleg = { fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty, tms: m.tms, t0ms: Date.now() };
    na.legEndedAt = 0;
    na.x = m.fx; na.y = m.fy; na.dir = m.tx < m.fx ? -1 : 1;
    return;
  }
  if (m.ev === 'aim') {   // 被打 → 伺服器把龍瞬移到島緣鎖定攻擊者（攻擊者可能是自己，也可能是別人）
    if (!a) { applyDragonSnap({ ...m, ph: 'aim' }); return; }
    S.floaters.push({ x: a.x, y: a.y - 40, poof: true, life: .55 });   // 原地消失
    a.x = m.x; a.y = m.y; a.z = 0; a.target = null; a.idle = 0; a.bounce = 0; a.wleg = null; a.rest = 0;
    S.floaters.push({ x: a.x, y: a.y - 40, poof: true, life: .55 });
    a.hp = m.hp;
    a.cycle = {   // 整個反擊循環用牆鐘（預警→龍衝→歇腳），與伺服器同軸
      t0ms: Date.now(), castMs: m.castMs || 1000, restMs: 700,
      dashMs: Math.max(1, Math.hypot(m.dx - m.x, m.dy - m.y) / OWNER_DASH_SPEED * 1000),
      warp: { x: m.x, y: m.y }, from: { x: m.tx, y: m.ty }, dest: { x: m.dx, y: m.dy },
    };
    a.dir = m.tx < a.x ? -1 : 1;
    const me = S.players[0];
    const aimedAtMe = Math.abs(m.tx - me.x) < CELL && Math.abs(m.ty - me.y) < CELL;
    toast(aimedAtMe ? `${animalDef(a.id).name} 瞬間消失，在島緣現出蹤影鎖定了你！`
                    : `${animalDef(a.id).name} 被惹怒了，在島緣鎖定了攻擊者！`, 2400);
    return;
  }
  if (m.ev === 'aggro') {   // 仇恨開始／換人：龍衝冷卻期間改為追殺（id＝被鎖定的連線；追路腿部份照 wander 事件走）
    const ownerName = () => animalDef(S.terrains[S.terrain]?.owner || a?.id || 'gold_dragon')?.name || '島主';
    const r = S.remotes.get(m.id);
    if (a) {
      a.aggro = true; a.wleg = null; a.cast = 0; a.castFrom = null;
      a.fly = false; a.dashU = null; a.cycle = null; a.gaze = null; a.rest = 0; a.retHome = false;
    }
    if (m.id === S.net?.id) toast(`${ownerName()} 火冒三丈地追殺你！快跑！`, 2600);
    else if (r) toast(`${ownerName()} 追殺 ${r.name}！`, 2200);
    else toast(`${ownerName()} 進入追殺狀態！`, 2200);
    return;
  }
  if (m.ev === 'chill') {   // 脫離仇恨：30 秒沒人打牠了
    const was = a?.aggro;   // 剛進島時快照不含仇恨狀態（a.aggro 是 false），沒看過牠發怒就不提示冷靜
    if (a) a.aggro = false;
    if (!was) return;
    toast(`${animalDef(S.terrains[S.terrain]?.owner || a?.id || 'gold_dragon')?.name || '島主'} 冷靜下來，繼續散步。`, 1800);
    return;
  }
  if (m.ev === 'claw') {   // 島主爪擊（每秒一下）：範圍內＋前方扇形的自己扣 2 HP（與龍衝同源：受害者自判）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.x = m.x; na.y = m.y; na.fly = false; na.dashU = null; na.cast = 0; na.rest = 0;
    na.cycle = null; na.wleg = null; na.dead = false; na.dieT = 0;
    na.dir = m.tx < na.x ? -1 : 1;
    // 爪擊特效：三道金色抓痕掃向目標（畫在龍與目標之間 45% 處，夠大才看得到）＋被打者紅色衝擊圈
    S.floaters.push({ x: m.x + (m.tx - m.x) * .45, y: m.y - 30 + (m.ty - m.y) * .45,
                      ang: Math.atan2(m.ty - m.y, m.tx - m.x), slash: true, life: .45 });
    const me = S.players[0];
    const dx = me.x - m.x, dy = me.y - m.y;
    const dd = Math.hypot(dx, dy) || 1;
    const to = Math.hypot(m.tx - m.x, m.ty - m.y) || 1;
    const front = (dx * (m.tx - m.x) + dy * (m.ty - m.y)) / (dd * to) >= .15;   // 前方扇形：到我的方向與到目標的方向夾角小於約 80°
    // 伺服器已用它的狀態驗證過距離；事件帶 id：抓的是我就結算（含紅圈），否則只看特效
    if (!me.dead && (m.id === S.net?.id || (dd <= OWNER_CLAW_RANGE && front))) {
      playerDamage(me, OWNER_CLAW_DMG, animalDef(na.id).name);
      S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
    }
    return;
  }
}

function stepAnimal(a, dt) {
  const def = animalDef(a.id);
  // 島主：連線時整個狀態機用牆鐘（與伺服器同軸，webview 節流也不影響）；單機沿用 dt 積分
  if (def.owner) {
    if (a.proxy) { stepOwnerProxy(a, dt, def); return; }
    // 單機本地模擬：島主每秒回 OWNER_REGEN 血（連線時血量由伺服器權威，本地不補）
    if (!a.dead && a.hp < a.maxHp) {
      a.regenAcc = (a.regenAcc || 0) + dt * OWNER_REGEN;
      const n = Math.floor(a.regenAcc);
      if (n > 0) { a.regenAcc -= n; a.hp = Math.min(a.maxHp, a.hp + n); }
    }
    if (a.fly || a.cast || a.rest || a.sayPhase) { ownerStep(a, dt, def); return; }
    if (a.aggro) { ownerAggroStep(a, dt, def); return; }   // 龍衝 CD 中：仇恨追殺（單機模擬）
    if (a.wleg) { stepOwnerWalk(a, dt); return; }
    if (a.idle > 0) { a.idle -= dt; a.z = 0; return; }
    const leg = ownerPickLeg(a.x, a.y);   // 單機：自己挑路點散步
    if (leg) a.wleg = { ...leg, t0ms: Date.now() };
    else a.idle = 2;
    return;
  }
  // 只有「附近有人揮擊」才會被嚇到（自己或同島的人）；單純走過去、站在旁邊不會嚇跑牠
  // 島主大隻又沉穩：近距離揮擊也不會嚇到（`owner: true`）
  if (!def.owner && S.t - (a.scaredAt ?? -9) > .4) {
    const src = [S.players[0], ...S.remotes.values()]
      .find(q => q.swing > 0 && Math.hypot(q.x - a.x, q.y - a.y) < def.flee);
    if (src) {
      a.startle = 1; a.startleT = 3; a.scaredAt = S.t;
      a.target = fleeTarget(a, def, src.x, src.y, 190);
      a.idle = 0;
    }
  }
  if (a.startleT > 0 && (a.startleT -= dt) <= 0) a.startle = 0;      // 驚嚇一陣子後恢復平靜
  if (a.idle > 0) { a.idle -= dt; a.z = 0; return; }
  if (!a.target || Math.hypot(a.target.x - a.x, a.target.y - a.y) < 5) {
    if (a.target?.flee) { a.idle = 1 + Math.random() * 2; a.target = null; return; }
    const home = nearestLand(a);
    if (home) a.target = home;
    else for (let t = 0; t < 20; t++) { // 漫一步（限制活動半徑 6 格）
      const nx = a.x + (Math.random() * 2 - 1) * 6, ny = a.y + (Math.random() * 2 - 1) * 6;
      const gx = Math.floor(nx / CELL), gy = Math.floor(ny / CELL);
      if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) continue;
      if (S.world.types[gy * COLS + gx] !== 2) continue;
      if (S.occ.get(key(gx, gy)) !== undefined && furnitureDef(S.furnItems[S.occ.get(key(gx, gy))]?.type)?.solid) continue;
      a.target = { x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2 };
      break;
    }
    if (!a.target) { a.idle = .5; return; }
  }
  const sp = (a.startle ? def.speed * 2.6 : def.speed) * dt;
  const dx = a.target.x - a.x, dy = a.target.y - a.y, len = Math.hypot(dx, dy) || 1;
  if (dx) a.dir = Math.sign(dx);
  const nx = clamp(a.x + dx / len * sp, CELL, (COLS - 1) * CELL), ny = clamp(a.y + dy / len * sp, CELL, (ROWS - 1) * CELL);
  const ox = a.x, oy = a.y;
  if (animalCanStand(def, nx, a.y)) a.x = nx;
  if (animalCanStand(def, a.x, ny)) a.y = ny;
  if (Math.hypot(a.x - ox, a.y - oy) < sp * .2) { a.target = null; a.idle = .5; a.z = 0; return; }   // 被海擋住：停下，不要一直頂
  // 贊跳感：走動時上下彈
  const rate = a.startle ? 16 : 8;
  a.bounce += dt * rate;
  a.z = Math.abs(Math.sin(a.bounce * Math.PI)) * 4;
}

function rebuildOcc() {
  S.occ.clear();
  S.furnItems.forEach((it, idx) => {
    const def = S.furn.items.find(f => f.id === it.type);
    for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++)
      S.occ.set(key(it.cell[0] + dx, it.cell[1] + dy), idx);
  });
}

function furnitureDef(id) { return S.furn.items.find(f => f.id ===id); }

// ---------------- 遮擋 / 碰撞 ----------------
function blocked(px, py, ignoreFurn) { // 像素座標（腳底）；ignoreFurn＝只看地形（水邊），不管家具
  const x = Math.floor(px / CELL), y = Math.floor(py / CELL);
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true;
  const type = S.world.types[y * COLS + x];
  if (type === 0) return true;
  if (ignoreFurn) return false;
  const fi = S.occ.get(key(x, y));
  if (fi !== undefined) {
    const def = S.furn.items.find(f => f.id === S.furnItems[fi].type);
    if (def.solid) return true;
  }
  return false;
}

// ---------------- 造型合成 ----------------
function hexRGB(h) { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; }

function charSprite(skin, hairId, shirtIdx, frame, pantsIdx) {   // frame：0/1 走路兩幀、2 坐姿、3/4 背面（往上走）的站/走
  // 索引超出範圍（舊存檔/別人送來的怪值）就用 0 號，避免畫圖當掉
  const shirtHex = S.avatar.shirtColors[shirtIdx] ?? S.avatar.shirtColors[0];
  const pantsHex = S.avatar.pantsColors[pantsIdx || 0] ?? S.avatar.pantsColors[0];
  const k = `${skin}|${hairId}|${shirtHex}|${pantsHex}`;
  let entry = S.charCache.get(k);
  if (!entry) entry = {};
  const fk = 'abcde'[frame] || 'a';
  if (entry[fk]) return entry[fk];
  const src = S.bodyImgs[skin][fk === 'd' ? 'a' : fk === 'e' ? 'b' : fk];   // 背面沿用正面的身體，頭髮整顆蓋住臉
  const cv = document.createElement('canvas'); cv.width = 16; cv.height = 24;
  const g = cv.getContext('2d');
  // 上衣換色
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, 16, 24), p = d.data;
  const [br, bg, bb] = hexRGB(S.avatar.recolor.shirtBase);
  const [sr, sg, sb] = hexRGB(S.avatar.recolor.shirtShadeBase);
  const [tr, tg, tb] = hexRGB(shirtHex);
  const [pbr, pbg, pbb] = hexRGB(S.avatar.recolor.pantsBase);
  const [psr, psg, psb] = hexRGB(S.avatar.recolor.pantsShadeBase);
  const [ptr, ptg, ptb] = hexRGB(pantsHex);
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gg = p[i + 1], b = p[i + 2], a = p[i + 3];
    if (a === 0) continue;
    if (r === br && gg === bg && b === bb) { p[i] = tr; p[i + 1] = tg; p[i + 2] = tb; }
    else if (r === sr && gg === sg && b === sb) {
      p[i] = tr * .78 | 0; p[i + 1] = tg * .78 | 0; p[i + 2] = tb * .78 | 0;
    } else if (r === pbr && gg === pbg && b === pbb) { p[i] = ptr; p[i + 1] = ptg; p[i + 2] = ptb; }      // 褲子
    else if (r === psr && gg === psg && b === psb) {
      p[i] = ptr * .78 | 0; p[i + 1] = ptg * .78 | 0; p[i + 2] = ptb * .78 | 0;
    }
  }
  g.putImageData(d, 0, 0);
  const back = fk === 'd' || fk === 'e';
  const hair = (back ? S.hairBackImgs[hairId] : null) || S.hairImgs[hairId];
  if (hair) g.drawImage(hair, 0, fk === 'c' ? 3 : 0);   // 坐姿的頭整體下移 3 列，頭髮跟著下移；背面用整顆蓋住的頭髮
  entry[fk] = cv;
  S.charCache.set(k, entry);
  return cv;
}

// ---------------- 玩家 ----------------
function makePlayer(name, opts) {
  return {
    name, x: (COLS / 2 - .5) * CELL + (opts?.dx || 0), y: (ROWS / 2 - .5) * CELL + (opts?.dy || 0),
    dir: 1, moving: false, frame: 0, animT: 0,
    z: 0, vz: 0,
    look: opts?.look || null, // NPC 用固定造型
    npc: !!opts?.npc,
    target: null, idle: opts?.npc ? 1 : 0,
    swing: 0, lastAtk: 0,
    dead: false, deadAt: 0,       // 死亡（墓碑）：被島主的龍衝打倒倒數復活
    hp: PLAYER_HP,                // 血量（爪擊扣 2 歸零倒地；殺動物回 1；NPC 不用）
  };
}

// ---- NPC：每張地圖各自一組（assets/npcs/npcs.json 的 terrains），切換地圖時換成新地圖的 NPC，不會跟著玩家過去 ----
function spawnNPCs() {
  const defs = S.npcDB?.terrains[S.terrain] || [], out = [];
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  for (const d of defs) {
    let pos = null;
    for (let t = 0; t < 80 && !pos; t++) {   // 在島中央附近找沒有家具、彼此不太近的陸地格
      const gx = Math.floor(cx + (Math.random() * 2 - 1) * 7), gy = Math.floor(cy + (Math.random() * 2 - 1) * 5);
      if (S.world.types[gy * COLS + gx] !== 2 || S.occ.has(key(gx, gy))) continue;
      const px = gx * CELL + CELL / 2, py = gy * CELL + CELL / 2;
      if (out.some(o => Math.hypot(o.x - px, o.y - py) < 3 * CELL)) continue;
      pos = [px, py];
    }
    pos ||= [cx * CELL, cy * CELL];
    const p = makePlayer(d.name, { look: d.look, npc: true });
    p.x = pos[0]; p.y = pos[1]; p.home = { x: pos[0], y: pos[1] };
    p.roam = d.guide ? 96 : 192;              // 嚮導只在原地附近晃，好找
    p.lines = d.lines; p.guide = !!d.guide; p.idle = Math.random() * 2;
    out.push(p);
  }
  S.players = [S.players[0], ...out];
}

function playerSpriteDiv(p, frame) {
  // NPC 與遠端玩家都有自己的 look；自己（players[0]）則用當前造型
  if (p.look) return charSprite(p.look.skin, p.look.hair, p.look.shirt, frame, p.look.pants);
  return charSprite(S.me.skin, S.me.hair, S.me.shirt, frame, S.me.pants);
}

// ---- M2：遠端玩家（位置用內插，避免網路抖動造成瞬移）----
function stepRemote(r, dt) {
  if (r.pose) r.frame = 0;
  const k = Math.min(1, dt * 14);
  const dx = r.tx - r.x, dy = r.ty - r.y;
  r.x += dx * k; r.y += dy * k;
  r.moving = Math.hypot(dx, dy) > 1.5;
  if (r.moving) { r.animT += dt; if (r.animT > .16) { r.animT = 0; r.frame ^= 1; } }
  else r.frame = 0;
  if (r.swing > 0) r.swing -= dt;
  r.z += ((r.tz ?? r.z) - r.z) * Math.min(1, dt * 22);   // 跳躍高度追目標（封包 12Hz，這個速度追得上又夠平滑）
}

// ---- 角色死亡：被島主的龍衝撞倒後原地變墓碑，30 秒後復活（NPC／遠端玩家也適用） ----
const DEAD_SECONDS = 30;
function killPlayer(p, cause, label) {   // label：頭上飄字（龍衝撞倒傳 '龍衝'，其餘預設「倒地」）
  if (p.npc || p.remote || p.dead) return;
  p.dead = true; p.deadAt = performance.now();   // 牆鐘毫秒：畫面被凍結（切走 DC）時倒數照樣走
  p.pose = null; p.seatType = null; p.moving = false; p.frame = 0; p.swing = 0; p.tool = null; p.fish = null;
  S.floaters.push({ x: p.x, y: p.y - 46, v: label || '倒地', life: 1.1, crit: true });
  toast(`${cause} 把你打倒了！${DEAD_SECONDS} 秒後在出生點復活`, 3200);
}
function revivePlayer(p) {
  p.dead = false; p.deadAt = 0;
  p.pose = null; p.seat = null; p.seatType = null;                 // 復活後一定是站著的
  p.hp = PLAYER_HP;   // 復活即滿血
  p.petUntil = 0; p.petTick = 0; p.petWas = false;   // 復活順便清石化（石化時長比死亡短，正常輪不到）
  const [nx, ny] = landNear((COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL);
  p.x = nx; p.y = ny; p.z = 0; p.vz = 0; p.dir = 1;
  S.floaters.push({ x: p.x, y: p.y - 46, v: '復活！', life: 1.2, crit: true });
  toast('毫髮無傷地復活了！', 1800);
}

// 脫離戰鬥後自動回血（坐著睡著也算；被石化中不回）
function regenPlayer(p, dt) {
  if (p.dead || S.t < (p.petUntil ?? 0) || (p.hp ?? PLAYER_HP) >= PLAYER_HP || ownerEngaged()) { p.regenAcc = 0; return; }
  p.regenAcc = (p.regenAcc || 0) + dt * PLAYER_REGEN;
  const n = Math.floor(p.regenAcc);
  if (n > 0) { p.regenAcc -= n; p.hp = Math.min(PLAYER_HP, (p.hp ?? PLAYER_HP) + n); }
}

function stepPlayer(p, dt) {
  if (p.npc) { stepNPC(p, dt); return; }
  regenPlayer(p, dt);
  if (p.dead) {   // 死亡：原地長出墓碑，期間不動/不跳/不揮擊
    p.z = 0; p.vz = 0; p.moving = false; p.frame = 0; p.swing = 0;
    if (performance.now() - p.deadAt >= DEAD_SECONDS * 1000) revivePlayer(p);
    return;
  }
  if (p.pose) {   // 坐/睡：不動；按移動鍵或跳躍就起身（也會一路走出去），家具被拿走也會起身
    const wantsMove = keys['a'] || keys['arrowleft'] || keys['d'] || keys['arrowright'] || keys['w'] || keys['arrowup'] || keys['s'] || keys['arrowdown'] || keys[' '];
    if (!seatItem(p) || wantsMove) standUp(p);
    else { p.moving = false; p.frame = 0; p.z = 0; p.vz = 0; return; }
  }
  let dx = 0, dy = 0;
  // 走路與裝飾模式都能移動（裝飾模式要邊走邊擺）；被石化時不能移動（揮擊也不行，在 doAttack／clickAttack 擋）
  const pet = S.t < (p.petUntil ?? 0);
  const reeling = p.fish?.ph === 'reel';   // 拉竿的 1 秒拉扯中站定（不能走、不能跳，結果揭曉後才能動）
  if (!pet && !reeling) {
    if (keys['a'] || keys['arrowleft']) dx -= 1;
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (keys['w'] || keys['arrowup']) dy -= 1;
    if (keys['s'] || keys['arrowdown']) dy += 1;
  }
  p.moving = dx !== 0 || dy !== 0;
  // 釣魚中（拉扯以外）：可以走、可以跳，離浮標太遠（FISH_LEASH）才收竿；換掉釣竿、進裝飾模式、被石化也會收竿
  if (p.fish && !reeling) {
    if (Math.hypot(p.fish.x - p.x, p.fish.y - p.y) > FISH_LEASH) stopFishing(p, '離浮標太遠，收竿了');
    else if (S.mode !== 'walk' || !isRod() || pet) stopFishing(p);
  }
  stepFishing(p);
  if (p.moving) {
    if (S.mode === 'walk' && S.mouseHeld && S.mouseClient) {   // 按住滑鼠攻擊時，面向跟著游標（可以一邊朝右攻擊一邊往左退）
      const wx = S.mouseClient[0] - canvas.getBoundingClientRect().left + S.cam.x;
      if (Math.abs(wx - p.x) > 6) p.dir = Math.sign(wx - p.x);
      p.face = 'side';
    } else {   // 四方向朝向：只往上＝背面、只往下＝正面、有左右分量＝側（dir 左右）；站著不動維持上次的朝向
      if (dx !== 0) { p.dir = dx; p.face = 'side'; }
      else p.face = dy < 0 ? 'up' : 'down';
    }
    const len = Math.hypot(dx, dy) || 1, sp = (keys['shift'] ? 200 : 120) * dt;
    const nx = clamp(p.x + dx / len * sp, 8, COLS * CELL - 8);
    const ny = clamp(p.y + dy / len * sp, 8, ROWS * CELL - 8);
    // 裝飾模式可穿過擺飾（避免被卡住）；已經被家具圍住/壓在家具上時（例如別人把家具擺在你腳下）也一樣可以走出來。水邊照樣擋
    const ig = S.mode === 'decor' || (blocked(p.x, p.y) && !blocked(p.x, p.y, true));
    if (!blocked(nx, p.y, ig)) p.x = nx;
    if (!blocked(p.x, ny, ig)) p.y = ny;
  }
  // 跳躍（走路與裝飾模式都能跳；石化中不能跳）
  if (!pet && !reeling && keys[' '] && p.z === 0 && p.vz === 0) p.vz = 240;
  if (p.z > 0 || p.vz > 0) {
    p.z += p.vz * dt; p.vz -= 780 * dt;
    if (p.z <= 0) { p.z = 0; p.vz = 0; }
  }
  if (p.swing > 0) { p.swing -= dt; p.face = 'side'; }   // 揮擊／採集是朝左右揮，轉成側面
  if (p.fish) {   // 釣魚中走動：身體一直面向浮標（倒退著走），釣竿才會指著浮標、釣線不會從背後繞過去
    if (Math.abs(p.fish.x - p.x) > 4) p.dir = Math.sign(p.fish.x - p.x);
    p.face = 'side';
  }
  if (p.tool && S.t > p.toolUntil && !(p.swing > 0)) p.tool = null;
  if (p.moving) { p.animT += dt; if (p.animT > .16) { p.animT = 0; p.frame ^= 1; } }
  else p.frame = 0;
  if (pet && S.t >= (p.petTick ?? 0)) {   // 石化每秒扣 1 HP（死者走既有墓碑機制）
    p.petTick = S.t + 1;
    playerDamage(p, 1, p.petCause || '石化');
  }
  if (p.petWas && !pet && !p.dead) toast('石化解除了！', 1600);   // 自然倒數結束（復活/換地形有清 petWas，不會誤報）
  p.petWas = pet;
}

function stepNPC(p, dt) {
  if (p.idle > 0) { p.idle -= dt; p.moving = false; p.frame = 0; return; }
  if (!p.target || Math.hypot(p.target.x - p.x, p.target.y - p.y) < 4) {
    // 換目標
    const h = p.home || { x: p.x, y: p.y }, rr = p.roam || 192;
    for (let t = 0; t < 24; t++) {
      const x = Math.floor((h.x + (Math.random() * 2 - 1) * rr) / CELL), y = Math.floor((h.y + (Math.random() * 2 - 1) * rr * .7) / CELL);
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      if (S.world.types[y * COLS + x] === 2) {
        let ok = true;
        const fi = S.occ.get(key(x, y));
        if (fi !== undefined && furnitureDef(S.furnItems[fi].type).solid) ok = false;
        if (ok) { p.target = { x: x * CELL + CELL / 2, y: y * CELL + CELL / 2 }; break; }
      }
    }
    return;
  }
  p.moving = true;
  const dx = p.target.x - p.x, dy = p.target.y - p.y, len = Math.hypot(dx, dy) || 1, sp = 55 * dt;
  if (dx) p.dir = Math.sign(dx);
  const nx = clamp(p.x + dx / len * sp, 8, COLS * CELL - 8), ny = clamp(p.y + dy / len * sp, 8, ROWS * CELL - 8);
  if (!blocked(nx, p.y)) p.x = nx;
  if (!blocked(p.x, ny)) p.y = ny;
  p.animT += dt; if (p.animT > .18) { p.animT = 0; p.frame ^= 1; }
  if (Math.random() < .002) p.idle = .8 + Math.random() * 1.6;
}

// 畫一個人（本人/NPC/同島玩家共用）：影子、身體（站/坐/睡）、武器、名牌。ctx 在世界座標
function drawPerson(p, wi, nameColor) {
  const pose = p.pose === 'sit' || p.pose === 'sleep' ? p.pose : null;
  let nameY = p.y - p.z - 52;
  if (pose === 'sleep') {
    drawSleeper(p);
    nameY = p.y - 46;
  } else {
    if (!pose) {   // 影子（跳起來時縮小變淡）；坐著的不畫（會蓋在椅子上）
      const shs = 1 - Math.min(.55, p.z / 80);
      ctx.fillStyle = `rgba(10,14,20,${.32 * shs + .04})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 11 * shs, 4 * shs, 0, 0, Math.PI * 2); ctx.fill();
    }
    const img = playerSpriteDiv(p, pose ? 2 : p.face === 'up' ? (p.frame === 1 ? 4 : 3) : (p.frame === 1 ? 1 : 0));   // 往上走＝背面
    const pet = S.t < (p.petUntil ?? 0);   // 石化：身體灰階（自己的石化即時同步；遠端玩家的石化由光束事件就地推斷，純演出）
    if (pet) { ctx.save(); ctx.filter = 'grayscale(1) brightness(.92)'; }
    ctx.save(); ctx.translate(p.x, p.y - p.z);
    if (p.dir < 0) ctx.scale(-1, 1);
    // 武器（背在肩上 / 揮擊時畫在身前）；坐著時不拿；釣魚時釣竿拋向前方
    const fish = wi && !pose && p.fish ? p.fish : null;
    if (wi && !pose && !fish && !(p.swing > 0)) drawWeaponBack(wi);
    ctx.drawImage(img, -16, -48, 32, 48);
    if (wi && !pose && !fish && p.swing > 0) drawWeaponSwing(wi, p.swing);
    if (fish) drawRodCast(wi, rodAngle(fish));
    ctx.restore();
    if (pet) ctx.restore();
    if (fish) drawLineAndBobber(p, wi, fish);
    if (pose) nameY = p.y - 46;
  }
  // 名牌（FFXIV 感：白字黑邊）
  ctx.font = '10px "Microsoft JhengHei"';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.8)';
  ctx.strokeText(p.name, p.x, nameY);
  ctx.fillStyle = nameColor;
  ctx.fillText(p.name, p.x, nameY);
  // 血量條（掉血才畫，名牌正下方）：爪擊扣 2、殺動物回 1、龍衝直接倒地
  if (!p.npc && p.hp != null && p.hp < PLAYER_HP) {
    const bw = 30, by = nameY + 3;
    ctx.fillStyle = 'rgba(8,10,14,.72)'; ctx.fillRect(p.x - bw / 2, by, bw, 3);
    ctx.fillStyle = '#e07a68'; ctx.fillRect(p.x - bw / 2 + 1, by + 1, Math.max(0, (bw - 2) * p.hp / PLAYER_HP), 1.6);
  }
  if (S.t < (p.petUntil ?? 0)) {   // 石化倒數：名牌（與血條）下方顯示還剩幾秒
    const ty = nameY + (!p.npc && p.hp != null && p.hp < PLAYER_HP ? 16 : 12), txt = `石化 ${Math.ceil(p.petUntil - S.t)}`;
    ctx.font = 'bold 10px "Microsoft JhengHei"'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#9ff0b4';
    ctx.strokeText(txt, p.x, ty); ctx.fillText(txt, p.x, ty);
  }
  if (p.say && S.t < p.say.until) drawBubble(p.x, nameY - 14, p.say.text, Math.min(1, (p.say.until - S.t) / .4));
  else if (p.fish?.ph === 'bite') {   // 魚上鉤：頭上跳動的「!」（同地形的人也看得到）
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
    const yy = nameY - 14 - Math.abs(Math.sin(S.t * 10)) * 4;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.9)'; ctx.fillStyle = '#ffd84a';
    ctx.strokeText('!', p.x, yy); ctx.fillText('!', p.x, yy);
  } else if (p.guide) {   // 嚮導頭上有個會晃動的「？」，提示可以問他
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    const yy = nameY - 14 + Math.sin(S.t * 4) * 2;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#ffd86b';
    ctx.strokeText('?', p.x, yy); ctx.fillText('?', p.x, yy);
  }
}
// 石化之瞳的預警大眼睛：暗紅眼眶＋紅虹膜＋直瞳，疊在蛇女身上；pul＝脈動（越接近發射越亮）
function drawGazeEye(x, y, r, pul) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = `rgba(40,12,16,${.72 + .2 * pul})`;
  ctx.strokeStyle = `rgba(255,90,80,${.45 + .4 * pul})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, 0, r * 1.28, r, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = `rgb(${210 + 40 * pul | 0},${28 + 20 * pul | 0},${28 + 12 * pul | 0})`;   // 紅色虹膜，越接近發射越亮
  ctx.beginPath(); ctx.ellipse(0, 0, r * .55, r * .66, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1a0608';
  ctx.beginPath(); ctx.ellipse(0, 0, r * .16, r * .58, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// 睡覺：只畫頭與肩膀躺在枕頭上，再把棉被蓋回去（p.x＝床的水平中心、p.y＝床的底邊）
function drawSleeper(p) {
  const img = playerSpriteDiv(p, 0);
  ctx.drawImage(img, 0, 2, 16, 11, p.x - 16, p.y - 33, 32, 22);   // 頭的水平中心對準枕頭（單人床中央）
  const def = furnitureDef(p.seatType || 'bed'), bed = S.furnImgs[p.seatType || 'bed'];
  if (bed && def?.quiltRow) {
    const rows = bed.height - def.quiltRow;
    ctx.drawImage(bed, 0, def.quiltRow, bed.width, rows, p.x - bed.width, p.y - rows * 2, bed.width * 2, rows * 2);
  }
  // Zzz 飄字
  const ph = (S.t * 1.2) % 1;
  ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = `rgba(190,215,255,${1 - ph})`; ctx.strokeStyle = `rgba(8,10,14,${.8 * (1 - ph)})`; ctx.lineWidth = 3;
  ctx.strokeText('Z', p.x + 6 + ph * 14, p.y - 40 - ph * 16); ctx.fillText('Z', p.x + 6 + ph * 14, p.y - 40 - ph * 16);
}

// ---------------- 坐下 / 睡覺（家具 manifest 的 use: "sit" | "sleep"）----------------
function seatItem(p) {      // 現在坐/睡的那件家具（家具被拿走或換地形就找不到）
  return p.seat && S.furnItems.find(it => it.type === p.seat.type && it.cell[0] === p.seat.cell[0] && it.cell[1] === p.seat.cell[1]);
}
function furnAtPoint(wx, wy) {   // 世界座標點到哪件家具（依繪製範圍，後放的在上面）
  for (let i = S.furnItems.length - 1; i >= 0; i--) {
    const it = S.furnItems[i], def = furnitureDef(it.type), img = S.furnImgs[it.type];
    if (!def || !img) continue;
    const sc = S.furn.scale || 2, x0 = it.cell[0] * CELL, y1 = (it.cell[1] + def.h) * CELL;
    if (wx >= x0 && wx <= x0 + Math.max(def.w * CELL, img.width * sc) && wy >= y1 - img.height * sc && wy <= y1) return it;
  }
  return null;
}
// ---------------- NPC 對話 ----------------
// 點 NPC（左鍵/右鍵）或在旁邊按 F，NPC 會隨機說 npcs.json 裡的一句，頭上冒泡泡。NPC 與對話只存在自己的畫面（不同步）
function npcAt(wx, wy) {
  return S.players.find(n => n.npc && wx >= n.x - 18 && wx <= n.x + 18 && wy >= n.y - 52 && wy <= n.y + 4) || null;
}
function npcNear(p) {
  let best = null, bd = 56;
  for (const n of S.players) {
    if (!n.npc) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
function talkTo(n) {
  const me = S.players[0], db = S.npcDB;
  if (Math.hypot(n.x - me.x, n.y - me.y) > db.range) { say(`靠近一點再跟${n.name}說話`); return; }
  const lines = n.lines?.length ? n.lines : ['……'];
  let line;
  do { line = lines[Math.floor(Math.random() * lines.length)]; } while (lines.length > 1 && line === n.lastLine);   // 不連續說同一句
  n.lastLine = line;
  n.say = { text: line, until: S.t + db.duration };
  n.idle = db.duration + .5; n.moving = false; n.target = null;      // 停下來說話，面向玩家
  if (Math.abs(me.x - n.x) > 6) n.dir = Math.sign(me.x - n.x);
  if (n.guide) {                              // 嚮導：先說一句話，讓台詞看得到，約 1.5 秒後再跳出簡易操作說明
    clearTimeout(S.helpTimer);
    S.helpTimer = setTimeout(() => { if (S.players.includes(n) && !S.helpOpen && !S.confirmOpen) openHelp(); }, 1500);
  }
}
// 嚮導的簡易操作說明視窗（內容在 npcs.json 的 help）
function openHelp() {
  const h = S.npcDB?.help; if (!h) return;
  $('helpTitle').textContent = h.title || '操作說明';
  const body = $('helpBody'); body.innerHTML = '';
  for (const sec of h.sections || []) {
    const t = document.createElement('div'); t.className = 'help-sec'; t.textContent = sec.title; body.appendChild(t);
    const ul = document.createElement('ul');
    for (const it of sec.items || []) { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); }
    body.appendChild(ul);
  }
  S.helpOpen = true; $('helpBox').classList.remove('hidden');
}
function closeHelp() { S.helpOpen = false; $('helpBox').classList.add('hidden'); }

// ---- 線上列表（L）：列出同地形的線上玩家，點名字傳送到他的位置（伺服器只告知同地形的人，所以只列得到同一座地形的）----
function buildPlayerList() {
  const body = $('listBody');
  const rs = [...S.remotes.values()];
  const sig = rs.map(r => r.id + '|' + r.name + '|' + !!r.dead).join(',');
  if (sig === S.listSig && body.children.length === rs.length) return;   // 名單沒變就不重建，免得點擊到一半元素被換掉
  S.listSig = sig; body.innerHTML = '';
  $('listHint').textContent = rs.length ? '點選玩家名字，傳送到他身邊' : '這座島上目前沒有其他玩家';
  for (const r of rs) {
    const o = document.createElement('div'); o.className = 'opt name' + (r.dead ? ' dead' : '');
    o.textContent = (r.name || '玩家') + (r.dead ? '（墓碑）' : '');
    o.onclick = () => teleportTo(r);
    body.appendChild(o);
  }
}
function openList() {
  if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
  buildPlayerList();
  S.listOpen = true; $('listBox').classList.remove('hidden');
  clearInterval(S.listTimer); S.listTimer = setInterval(buildPlayerList, 1000);   // 有人進出時跟著更新
}
function closeList() { S.listOpen = false; $('listBox').classList.add('hidden'); clearInterval(S.listTimer); }
function teleportTo(r) {
  const me = S.players[0];
  if (!S.remotes.has(r.id) || me.dead) { buildPlayerList(); return; }
  standUp(me);
  me.x = r.x; me.y = r.y; me.z = 0; me.vz = 0;
  closeList();
  toast('傳送到 ' + (r.name || '玩家') + ' 身邊', 1800);
}

// ---- 看板：點它（或旁邊按 F）打開視窗，所有人都能看、都能改；文字由伺服器同步（沒連線時存本機）----
const SIGN_RANGE = 90;
function signNear(p) {     // F 鍵：身邊最近的看板
  let best = null, bd = 56;
  for (const it of S.furnItems) {
    const def = furnitureDef(it.type); if (!def?.text) continue;
    const d = Math.hypot((it.cell[0] + def.w / 2) * CELL - p.x, (it.cell[1] + def.h / 2) * CELL - p.y);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}
function openSign(it) {
  const p = S.players[0], def = furnitureDef(it.type);
  if (p.dead) { say('你在墓碑裡動不了', 1400); return; }
  if (Math.hypot((it.cell[0] + def.w / 2) * CELL - p.x, (it.cell[1] + def.h / 2) * CELL - p.y) > SIGN_RANGE) { say('靠近一點再看'); return; }
  S.signOpen = true; S.signItem = { type: it.type, cell: [it.cell[0], it.cell[1]] };
  for (const k in keys) keys[k] = false; S.mouseHeld = false;
  $('signText').value = it.text || '';
  $('signBox').classList.remove('hidden');
  setTimeout(() => { $('signText').focus(); $('signText').select(); }, 0);
}
function closeSign() { S.signOpen = false; S.signItem = null; $('signBox').classList.add('hidden'); $('signText').blur(); }
function saveSign() {
  const it = S.signItem; if (!it) return;
  const text = $('signText').value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 100).trim();
  if (netOn()) S.net.editSign(it.cell, text);           // 結果以伺服器廣播的擺設為準
  else {                                                // 單機：直接改本機並存檔
    const cur = S.furnItems.find(o => o.type === it.type && o.cell[0] === it.cell[0] && o.cell[1] === it.cell[1]);
    if (cur) { if (text) cur.text = text; else delete cur.text; saveLayout(); }
  }
  closeSign(); toast(text ? '看板已更新' : '看板已清空', 1600);
}
// 對話泡泡（畫在名牌上方）
function drawBubble(x, y, text, alpha) {
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = '11px "Microsoft JhengHei"'; ctx.textAlign = 'center';
  const w = Math.ceil(ctx.measureText(text).width) + 14, h = 18, bx = Math.round(x - w / 2), by = Math.round(y - h);
  ctx.fillStyle = 'rgba(252,250,242,.96)'; ctx.strokeStyle = 'rgba(30,24,22,.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 5); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x, by + h + 5); ctx.lineTo(x + 4, by + h); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(252,250,242,.96)'; ctx.fillRect(x - 3, by + h - 1, 6, 2);       // 蓋掉尾巴與泡泡相接的線
  ctx.fillStyle = '#2a2420'; ctx.fillText(text, x, by + 13);
  ctx.restore();
}

function seatNear(p) {     // F 鍵：身邊最近的可坐/可睡家具
  let best = null, bd = 56;
  for (const it of S.furnItems) {
    const def = furnitureDef(it.type); if (!def?.use) continue;
    const d = Math.hypot((it.cell[0] + def.w / 2) * CELL - p.x, (it.cell[1] + def.h / 2) * CELL - p.y);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}
function usePose(it) {
  const p = S.players[0], def = furnitureDef(it.type);
  if (p.dead) { say('你在墓碑裡動不了', 1400); return; }          // 死亡（墓碑）期間不能坐/躺，否則墓碑會被帶到家具上
  if (p.pose) {   // 已經坐/睡著：再點同一件＝起身；點別件＝先起身再去
    const same = p.seat.type === it.type && p.seat.cell[0] === it.cell[0] && p.seat.cell[1] === it.cell[1];
    standUp(p);
    if (same) return;
  }
  const cx = (it.cell[0] + def.w / 2) * CELL, cy = (it.cell[1] + def.h / 2) * CELL;
  if (Math.hypot(cx - p.x, cy - p.y) > 80) { say(`靠近一點再${def.use === 'sit' ? '坐' : '躺'}`); return; }
  const sx = cx, sy = (it.cell[1] + def.h) * CELL - (def.use === 'sit' ? 2 : 0);
  for (const r of S.remotes.values()) if (r.pose && Math.abs(r.x - sx) < 10 && Math.abs(r.y - sy) < 10) { say('這裡有人了'); return; }
  p.pose = def.use; p.seat = { type: it.type, cell: [it.cell[0], it.cell[1]] }; p.seatType = it.type; p.face = 'down';
  p.x = sx; p.y = sy; p.z = 0; p.vz = 0; p.moving = false; p.frame = 0; p.swing = 0; p.tool = null;
  say(def.use === 'sit' ? '坐下了（移動、F 或再點一次起身）' : '晚安～（移動、F 或再點一次起身）', 1800);
}
function standUp(p) {
  if (!p.pose) return;
  const seat = p.seat;
  p.pose = null; p.seat = null; p.seatType = null;
  if (seat) {   // 起身時站到家具前面（前面有東西擋就原地，仍可走出來）
    const def = furnitureDef(seat.type), ny = (seat.cell[1] + (def?.h || 1)) * CELL + 6;
    if (!blocked(p.x, ny)) p.y = ny;
  }
}

// ---------------- 釣魚 ----------------
// 造型的武器換成釣竿（avatar.json 的 fishing: true）後，面向水邊按 F 或點水面就拋竿：浮標在水面上下飄，
// 幾秒後魚上鉤（浮標被拉下水、頭上「!」），FISH_BITE 秒內再按一次就拉竿（FISH_REEL 秒的拉扯動畫）釣上來，超過就跑掉。
// 釣到什麼：連線時由伺服器抽（結果與圖鑑存在伺服器，依 Discord 帳號；訪客只存本機），沒連線才在本機抽（rollFish，與兩份伺服器同演算法）。
// 浮標位置與階段走 state.fish 同步，同地形的人看得到你在釣魚；釣到的東西只有自己知道
const FISH_WAIT = [3, 8];        // 拋竿後幾秒魚上鉤（隨機）
const FISH_BITE = 2;             // 上鉤後幾秒內要拉竿
const FISH_REEL = 1;             // 拉竿的拉扯動畫秒數
const FISH_RANGE = [36, 140];    // 浮標離人的距離（px）
const FISH_LEASH = 5 * CELL;     // 釣魚中可以走動，離浮標超過這個距離（5 格）才自動收竿
const FISH_RESULT_WAIT = 4;      // 連線時拉竿後，最多再等伺服器結果幾秒
const isRod = () => !!S.avatar?.weapons.find(w => w.id === S.me.weapon)?.fishing;
const isWater = (wx, wy) => {
  const x = Math.floor(wx / CELL), y = Math.floor(wy / CELL);
  return x >= 0 && y >= 0 && x < COLS && y < ROWS && S.world.types[y * COLS + x] === 0;
};
const fishDef = (terrain, id) => S.fishDB?.terrains[terrain]?.find(f => f.id === id);
// 拋竿落點：點擊＝點的位置（要在範圍內的水面上）；F＝沿面向找範圍內第一片水，再往外一點
function castPoint(p, wx, wy) {
  if (wx !== undefined) {
    const d = Math.hypot(wx - p.x, wy - p.y);
    if (!isWater(wx, wy) || d > FISH_RANGE[1]) { say('點附近的水面就能拋竿'); return null; }
    return { x: wx, y: wy };
  }
  const [fx, fy] = facingVec(p);
  for (let r = FISH_RANGE[0]; r <= FISH_RANGE[1]; r += 8) {
    if (isWater(p.x + fx * r, p.y + fy * r)) {
      const r2 = isWater(p.x + fx * (r + 20), p.y + fy * (r + 20)) ? r + 20 : r;
      return { x: p.x + fx * r2, y: p.y + fy * r2 };
    }
  }
  say('前方沒有水，面向水邊再拋竿');
  return null;
}
// 左鍵／F（拿著釣竿時）：沒在釣＝拋竿；等魚中＝收竿；魚上鉤＝拉竿；拉扯中＝不理
function fishAction(wx, wy) {
  const p = S.players[0], f = p.fish;
  if (!f) {
    if (!S.fishDB?.terrains[S.terrain]?.length) { say('這裡釣不到東西'); return; }
    const pt = castPoint(p, wx, wy);
    if (!pt) return;
    p.fish = { ph: 'wait', x: Math.round(pt.x), y: Math.round(pt.y), t: S.t, biteAt: S.t + FISH_WAIT[0] + Math.random() * (FISH_WAIT[1] - FISH_WAIT[0]) };
    if (Math.abs(pt.x - p.x) > 4) p.dir = Math.sign(pt.x - p.x);
    p.face = 'side'; p.tool = null;
    toast('拋竿了，等魚上鉤…（再按一次收竿）', 1800);
  } else if (f.ph === 'wait') stopFishing(p, '收竿了');
  else if (f.ph === 'bite') {
    f.ph = 'reel'; f.t = S.t; f.result = null;
    if (netOn()) S.net.fishCatch();            // 伺服器抽魚並記進圖鑑，結果由 fish_result 回來
    else f.result = rollFish(S.terrain);
  }
}
function stopFishing(p, msg) {
  if (!p.fish) return;
  p.fish = null;
  if (msg) toast(msg, 1800);
}
// 每幀：等魚 → 上鉤 → 逾時跑掉；拉扯動畫結束時揭曉結果
function stepFishing(p) {
  const f = p.fish;
  if (!f) return;
  if (f.ph === 'wait' && S.t >= f.biteAt) { f.ph = 'bite'; f.t = S.t; }
  else if (f.ph === 'bite' && S.t - f.t > FISH_BITE) stopFishing(p, '魚逃走了…');
  else if (f.ph === 'reel' && S.t - f.t >= FISH_REEL) {
    if (f.result) { p.fish = null; showCatch(p, f.result); }
    else if (S.t - f.t > FISH_REEL + FISH_RESULT_WAIT) stopFishing(p, '連線不穩，魚跑掉了…');
  }
}
// 單機抽魚（與 Worker 的 rollFish、dev_server 的 roll_fish 同演算法）：先脫鉤判定，再依權重抽稀有度，
// 從該地形同稀有度的魚裡平均抽一種；尺寸越大越難（範圍內取 r^1.6）
function rollFish(terrain) {
  const db = S.fishDB, list = db?.terrains[terrain] || [];
  if (!list.length || Math.random() < db.escape) return { terrain, escaped: true };
  const rars = Object.entries(db.rarity).filter(([k]) => list.some(f => f.rarity === k));
  let r = Math.random() * rars.reduce((s, [, v]) => s + v.weight, 0), rar = rars[rars.length - 1][0];
  for (const [k, v] of rars) { if ((r -= v.weight) < 0) { rar = k; break; } }
  const cands = list.filter(f => f.rarity === rar), f = cands[Math.floor(Math.random() * cands.length)];
  const size = Math.round((f.size[0] + (f.size[1] - f.size[0]) * Math.random() ** 1.6) * 10) / 10;
  return { terrain, id: f.id, size, rarity: rar };
}
// 伺服器回來的結果：正在拉扯就等動畫結束再揭曉；其餘情況（例如拉扯中斷線又重連）直接記錄
function onFishResult(m) {
  const p = S.players[0];
  if (p.fish?.ph === 'reel' && !p.fish.result) p.fish.result = m;
  else showCatch(p, m);
}
// 記進圖鑑：伺服器存好的（saved）直接用它回的資料；訪客／單機記在本機 localStorage
function recordCatch(m) {
  const dex = S.dex[m.terrain] ||= {};
  if (m.saved && m.entry) { dex[m.id] = m.entry; return { isNew: !!m.isNew, isRecord: !!m.isRecord }; }
  const e = dex[m.id], isNew = !e, isRecord = !e || m.size > e.max;
  dex[m.id] = { max: Math.max(e?.max || 0, m.size), n: (e?.n || 0) + 1 };
  if (S.dexSource === 'local') lsSet('dcisland.m0.fishdex', S.dex);
  return { isNew, isRecord };
}
function showCatch(p, m) {
  if (m.escaped) { toast('魚脫鉤逃走了！', 2200); return; }
  const def = fishDef(m.terrain, m.id), rar = S.fishDB.rarity[m.rarity];
  if (!def) return;
  const { isNew, isRecord } = recordCatch(m);
  if (S.fishImgs[m.id]) S.floaters.push({ x: p.x, y: p.y - 64, fishImg: S.fishImgs[m.id], life: 1.8 });
  toast(`釣到了 ${def.name}！${m.size} cm（${rar?.name || ''}）${isNew ? ' · 新發現！' : isRecord ? ' · 尺寸新紀錄！' : ''}`, 3400);
  if (S.dexOpen) buildDex();
}
// 釣竿拋出去的姿勢角度（正值＝竿尖往面向那側前傾）：等魚前傾、上鉤被往下拉、拉扯時往後上方甩
function rodAngle(f) {
  return f.ph === 'reel' ? -.25 + Math.sin(S.t * 30) * .12 : f.ph === 'bite' ? 1 + Math.sin(S.t * 40) * .08 : .8;
}
// 畫拋出去的釣竿（ctx 已 translate 到角色腳底並依 dir 翻轉；轉軸同揮擊＝握把）
function drawRodCast(wi, a) {
  ctx.save(); ctx.translate(3, -26); ctx.rotate(a);
  ctx.drawImage(wi, -wi.width, -(wi.height - 3) * 2, wi.width * 2, wi.height * 2); ctx.restore();
}
// 釣線與浮標（世界座標）：從竿尖拉到浮標；上鉤時浮標沉下去、水面起漣漪；拉扯時浮標往人這邊收
function drawLineAndBobber(p, wi, f) {
  const a = rodAngle(f), L = (wi.height - 3) * 2 - 2, dir = p.dir < 0 ? -1 : 1;
  const tx = p.x + dir * (3 + L * Math.sin(a)), ty = p.y - p.z - 26 - L * Math.cos(a);
  let bx = f.x, by = f.y;
  const since = S.t - (f.t ?? S.t);
  if (f.ph === 'reel') { const q = Math.min(1, since / FISH_REEL); bx += (p.x - bx) * q * .6; by += (p.y - 10 - by) * q * .6; }
  else if (f.ph === 'wait') by += Math.sin(S.t * 3) * 1.5;
  else by += 3;
  ctx.save();
  ctx.strokeStyle = 'rgba(240,240,232,.85)'; ctx.lineWidth = 1;
  const sag = f.ph === 'wait' ? 18 : 4;     // 等魚時線鬆鬆的，上鉤／拉扯時繃緊
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo((tx + bx) / 2, Math.max(ty, by) + sag, bx, by - 3); ctx.stroke();
  if (f.ph !== 'reel') {                   // 水面漣漪
    const q = (S.t * (f.ph === 'bite' ? 2.5 : .8)) % 1;
    ctx.strokeStyle = `rgba(230,245,255,${.55 * (1 - q)})`;
    ctx.beginPath(); ctx.ellipse(f.x, f.y + 1, 4 + q * (f.ph === 'bite' ? 12 : 6), 1.5 + q * (f.ph === 'bite' ? 4 : 2), 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (f.ph === 'bite') {                   // 上鉤：浮標被拉下水，只露出一點紅頂
    ctx.fillStyle = '#e04a3a'; ctx.beginPath(); ctx.ellipse(bx, by - 2, 2.5, 1.2, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#f4f0e6'; ctx.beginPath(); ctx.arc(bx, by - 2, 3, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#e04a3a'; ctx.beginPath(); ctx.arc(bx, by - 2, 3, Math.PI, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(30,24,22,.9)'; ctx.beginPath(); ctx.arc(bx, by - 2, 3, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// ---- 魚類圖鑑：每個地形一頁，各 10 種；沒釣過的是黑色剪影＋「？？？」，釣過的顯示圖、名稱、稀有度、最大尺寸與次數 ----
function openDex() {
  S.dexOpen = true; S.dexTab = S.fishDB?.terrains[S.terrain] ? S.terrain : TERRAIN_IDS[0];
  buildDex(); $('dexBox').classList.remove('hidden');
}
function closeDex() { S.dexOpen = false; $('dexBox').classList.add('hidden'); }
function buildDex() {
  const tabs = $('dexTabs'); tabs.innerHTML = '';
  for (const id of TERRAIN_IDS) {
    if (!S.fishDB.terrains[id]) continue;
    const b = document.createElement('button');
    b.className = 'ff-btn small' + (id === S.dexTab ? ' active' : '');
    b.textContent = S.terrains[id].name;
    b.onclick = () => { S.dexTab = id; buildDex(); };
    tabs.appendChild(b);
  }
  const list = S.fishDB.terrains[S.dexTab] || [], seen = S.dex[S.dexTab] || {};
  const n = list.filter(f => seen[f.id]).length;
  $('dexHint').textContent = `已發現 ${n}／${list.length}` + (S.dexSource === 'server' ? ' · 以 Discord 帳號保存' : ' · 訪客／未連線：只存在這台電腦');
  const grid = $('dexGrid'); grid.innerHTML = '';
  for (const f of list) {
    const e = seen[f.id], rar = S.fishDB.rarity[f.rarity];
    const card = document.createElement('div'); card.className = 'dex-card' + (e ? '' : ' unknown');
    const cv = document.createElement('canvas'); cv.width = 48; cv.height = 48;
    const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
    const img = S.fishImgs[f.id];
    if (img) {
      g.drawImage(img, 0, 0, 48, 48);
      if (!e) { g.globalCompositeOperation = 'source-in'; g.fillStyle = '#07090c'; g.fillRect(0, 0, 48, 48); }   // 剪影
    }
    const nm = document.createElement('div'); nm.className = 'dex-name'; nm.textContent = e ? f.name : '？？？';
    card.append(cv, nm);
    if (e) {
      const r = document.createElement('div'); r.className = 'dex-rar'; r.textContent = rar?.name || ''; r.style.color = rar?.color || '';
      const s = document.createElement('div'); s.className = 'dex-size'; s.textContent = `最大 ${e.max} cm · ${e.n} 次`;
      card.append(r, s);
    }
    grid.appendChild(card);
  }
}

// ---------------- 繪製 ----------------
// 武器（ctx 已 translate 到角色腳底並依 dir 翻轉）。素材：刀刃在上、握柄在下。
// 沒揮擊：背在肩後（畫在身體之前，被身體擋住一部分）。
// 以「圖的底端」對齊（木劍 18 格高、畫成 36px 時底端在轉軸下 27px）：比較長的武器（釣竿）往上伸出肩頭，不會穿過腳底。
// avatar.json 標 back: "hilt" 的（木劍）上下翻過來＝劍柄在肩後（約肩膀高度）、劍身朝下藏在身體後面
const WEAPON_BACK_BOTTOM = 27, WEAPON_HILT_LIFT = 0;
function drawWeaponBack(wi) {
  ctx.save(); ctx.translate(-11, -26); ctx.rotate(-.55);
  if (wi.hiltUp) { ctx.scale(1, -1); ctx.drawImage(wi, -wi.width, WEAPON_HILT_LIFT - WEAPON_BACK_BOTTOM, wi.width * 2, wi.height * 2); }
  else ctx.drawImage(wi, -wi.width, WEAPON_BACK_BOTTOM - wi.height * 2, wi.width * 2, wi.height * 2);
  ctx.restore();
}
// 揮擊：握住劍柄（以握把為轉軸）、刀刃朝外，由後上方往前下方揮，畫在身體之後（身前）
// 劍柄朝上背著的（hiltUp）：前 35% 手從肩後的劍柄位置（約 -13,-29，與 drawWeaponBack 的握把一致）移到身前，看起來是從背上拔劍再揮出去
const SWING_HILT_FROM = [-13, -29], SWING_HILT_DRAW = .35;
function drawWeaponSwing(wi, swing) {
  const q = 1 - swing / ATK_T;
  let px = 3, py = -26;
  if (wi.hiltUp) {
    const k = Math.min(1, q / SWING_HILT_DRAW);
    px = SWING_HILT_FROM[0] + (3 - SWING_HILT_FROM[0]) * k; py = SWING_HILT_FROM[1] + (-26 - SWING_HILT_FROM[1]) * k;
  }
  ctx.save(); ctx.translate(px, py); ctx.rotate(-.9 + q * 2.8);
  ctx.drawImage(wi, -wi.width, -(wi.height - 3) * 2, wi.width * 2, wi.height * 2); ctx.restore();   // 轉軸＝離圖底 3 格的握把
}

function draw() {
  const T = S.terrain, tMan = S.terrains[T], ims = S.tImages[T];
  const SC = tMan.scale;
  if (!ims) return; // 載圖中略過本幀
  // 鏡頭跟隨（任何人多時也可提供跟隨對象）
  const me = S.players[0] || { x: 0, y: 0 };
  S.cam.x = clamp(me.x - canvas.width / 2, 0, COLS * CELL - canvas.width);
  S.cam.y = clamp(me.y - canvas.height * .58, 0, ROWS * CELL - canvas.height);
  const x0 = Math.max(0, Math.floor(S.cam.x / CELL)), y0 = Math.max(0, Math.floor(S.cam.y / CELL));
  const x1 = Math.min(COLS - 1, Math.ceil((S.cam.x + canvas.width) / CELL));
  const y1 = Math.min(ROWS - 1, Math.ceil((S.cam.y + canvas.height) / CELL));
  ctx.save();
  ctx.translate(-S.cam.x, -S.cam.y);
  // 底：水
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = S.world.types[y * COLS + x];
    const img = t === 2 ? ims[tMan.ground] : t === 1 ? ims[tMan.edge] : ims[tMan.water];
    if (!img) continue;
    ctx.drawImage(img, x * CELL, y * CELL, CELL, CELL);
  }
  // 地板層：蓋在地面上、家具與角色之下（多格地板從錨點畫整張，錨點在鏡頭左上外也要畫，所以往外多看幾格）
  for (let y = Math.max(0, y0 - FLOOR_MAX + 1); y <= y1; y++) for (let x = Math.max(0, x0 - FLOOR_MAX + 1); x <= x1; x++) {
    const fid = S.floorMap.get(y * COLS + x), img = fid && S.floorImgs[fid];
    if (!img) continue;
    const s = floorSize(fid);
    ctx.drawImage(img, x * CELL, y * CELL, s.w * CELL, s.h * CELL);
  }
  // 裝飾模式半透明格線
  if (S.mode === 'decor') {
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (S.world.types[y * COLS + x]) ctx.strokeRect(x * CELL + .5, y * CELL + .5, CELL - 1, CELL - 1);
  }

  // 收集繪製項目（y 排序）
  const list = [];
  for (const d of S.world.decos) {
    if (d.dead) continue;
    const img = ims[d.sprite]; if (!img) continue;
    list.push({
      y: (d.cell[1] + 1) * CELL,
      draw: () => {
        const w = img.width * SC, h = img.height * SC;
        const sx = d.shake > 0 ? Math.sin(S.t * 70) * 2 * (d.shake / .25) : 0;   // 受擊抖動
        if (d.flip) {
          ctx.save(); ctx.translate(d.cell[0] * CELL + w + sx, (d.cell[1] + 1) * CELL - h); ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, w, h); ctx.restore();
        } else ctx.drawImage(img, d.cell[0] * CELL + sx, (d.cell[1] + 1) * CELL - h, w, h);
      }
    });
  }
  // 掉落物
  for (const dr of S.drops) {
    const def = S.toolsDB.items[dr.item];
    list.push({
      y: dr.y, draw: () => {
        const bob = Math.sin(S.t * 5 + dr.x) * 2;
        ctx.fillStyle = 'rgba(10,14,20,.3)';
        ctx.beginPath(); ctx.ellipse(dr.x, dr.y, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = def?.color || '#fff'; ctx.strokeStyle = 'rgba(20,16,12,.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(dr.x, dr.y - 7 - bob, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    });
  }
  S.furnItems.forEach((it, idx) => {
    const def = furnitureDef(it.type), img = S.furnImgs[it.type]; if (!img) return;
    list.push({
      y: (it.cell[1] + def.h) * CELL - 1,
      draw: () => {
        ctx.save();
        if (idx === S.pickedIdx) ctx.globalAlpha = .5;
        ctx.drawImage(img, it.cell[0] * CELL, (it.cell[1] + def.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
        if (def.text && it.text) {   // 看板的字：走近（約 4 格內）才顯示在上方，只顯示第一行前 16 字，點開看全文
          const me = S.players[0], cx = (it.cell[0] + def.w / 2) * CELL, cy = (it.cell[1] + def.h) * CELL;
          if (Math.hypot(cx - me.x, cy - me.y) < 130) {
            const line = it.text.split('\n')[0], txt = line.length > 16 ? line.slice(0, 16) + '…' : line;
            ctx.font = '10px "Microsoft JhengHei"'; ctx.textAlign = 'center';
            const ty = cy - img.height * SC - 6, w = ctx.measureText(txt).width + 10;
            ctx.fillStyle = 'rgba(20,16,12,.78)'; ctx.fillRect(cx - w / 2, ty - 11, w, 15);
            ctx.fillStyle = '#ffe9a8'; ctx.fillText(txt, cx, ty);
          }
        }
        ctx.restore();
      }
    });
  });
  // 小動物
  for (const a of S.animals) {
    const img = S.anImgs[a.id]; if (!img) continue;
    const def = animalDef(a.id);
    list.push({
      y: a.y - (a.z ? .5 : 1),
      draw: () => {
        const bs = def.big || 1, W = img.width * 2 * bs, H = img.height * 2 * bs;   // big=N＝比普通動物大 N 倍；錨點在腳底中央
        const shs = 1 - Math.min(.5, a.z / 60);
        ctx.fillStyle = `rgba(10,14,20,${.26 * shs + .03})`;
        ctx.beginPath(); ctx.ellipse(a.x, a.y + 1, 9 * bs * shs, 3 * shs * Math.max(1, bs * .6), 0, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(a.x, a.y - a.z);
        if (a.dead) {  // 死亡：縮小旋轉淡出
          const q = 1 - a.dieT / .6;
          ctx.globalAlpha = Math.max(0, 1 - q * 1.2);
          ctx.rotate(q * 1.1); ctx.scale(1 - q * .3, 1 - q * .3);
        }
        if (a.dir < 0) ctx.scale(-1, 1);
        ctx.drawImage(img, -W / 2, -H, W, H);
        ctx.restore();
        if (a.dead) return;
        if (def.owner && !a.fly) {   // 島主腳下判定圈：以「武器尖端」為準——武器點（人前方 WEAPON_REACH 處的小圓點）進圈就打得到，不看面向。靠近（約 220px 內）才顯示
          const me = S.players[0], d = Math.hypot(a.x - me.x, a.y - me.y);
          if (d < 220 && !me.dead && !me.pose && S.me.weapon !== 'hands') {   // 空手（沒裝備武器）不顯示
            const R = hitRadius(def), wp = weaponPt(me), ok = Math.hypot(a.x - wp.x, a.y - wp.y) <= R, bodyIn = d <= R;
            ctx.save();
            ctx.beginPath(); ctx.arc(a.x, a.y, R, 0, Math.PI * 2);
            if (ok) { ctx.fillStyle = 'rgba(120,255,150,.14)'; ctx.fill(); }
            ctx.strokeStyle = ok ? 'rgba(120,255,150,.95)' : bodyIn ? 'rgba(255,214,90,.7)' : 'rgba(255,255,255,.3)';   // 綠＝武器在圈內（打得到）、黃＝人在圈內但武器在圈外（轉向）、白＝圈外
            ctx.lineWidth = ok ? 2.5 : 1.5; ctx.setLineDash(ok ? [] : [6, 6]); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = ok ? 'rgba(120,255,150,.95)' : 'rgba(255,255,255,.45)';
            ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2); ctx.fill();   // 怪物腳底中心點
            ctx.strokeStyle = ok ? 'rgba(120,255,150,1)' : 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(wp.x, wp.y - 20, 4, 0, Math.PI * 2); ctx.stroke();   // 武器點（畫在身體高度，方便看）
            ctx.restore();
          }
        }
        const top = a.y - a.z - H - 2;   // 圖的頂端（名牌/驚嘆號/血條貼這條線往下排）
        // 島主預警：龍衝＝金色虛線＝衝刺路徑；石化之瞳＝只有大眼睛（沒有直線，全地圖面向她的人都會石化）
        if (a.cast > 0 && a.castFrom) {
          const cf = a.castFrom, L = 1700;
          const ux = cf.x - a.x, uy = cf.y - a.y, ul = Math.hypot(ux, uy) || 1;
          const pul = Math.sin(S.t * 12) * .5 + .5;
          const gaze = ownerAtk(def) === 'gaze';
          if (!gaze) {
            ctx.save();
            ctx.strokeStyle = `rgba(255,214,90,${.28 + .34 * pul})`;
            ctx.lineWidth = 2 + 2 * pul; ctx.setLineDash([10, 12]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y - H * .5);
            ctx.lineTo(a.x + ux / ul * L, a.y - H * .5 + uy / ul * L);
            ctx.stroke(); ctx.setLineDash([]); ctx.restore();
          }
          if (gaze) drawGazeEye(a.x, a.y - H * .62, 9 * bs + 6 * (1 - a.cast / OWNER_GAZE_CAST), pul);
        }
        // HP 小條（受過傷才顯示；島主加寬）
        if (a.hp < a.maxHp) {
          const bw = 22 * (def.big || 1) ** .45;   // bs=1 → 22（同舊版）；大隻的加寬
          ctx.fillStyle = 'rgba(8,10,14,.7)'; ctx.fillRect(a.x - bw / 2 - 1, top + 18, bw + 2, 4);
          ctx.fillStyle = a.hp / a.maxHp > .4 ? '#7ac86c' : '#e07a68';
          ctx.fillRect(a.x - bw / 2, top + 19, bw * (a.hp / a.maxHp), 2);
        }
        // 驚嚇符號（FF14 「!」）
        if (a.startle && (S.t * 6 | 0) % 2 === 0) {
          ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
          ctx.fillStyle = '#e8c23a'; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.lineWidth = 3;
          ctx.strokeText('!', a.x, top + 8); ctx.fillText('!', a.x, top + 8);
        }
        // 名牌（島主用金色，與嚮導同色）
        ctx.font = (bs > 1 ? 'bold 12px ' : '9px ') + '"Microsoft JhengHei"'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.75)';
        ctx.strokeText(def.name, a.x, top);
        ctx.fillStyle = a.startle ? '#e8b2a2' : (def.owner ? '#ffd86b' : '#cfd8c8');
        ctx.fillText(def.name, a.x, top);
        // 島主的台詞泡泡（被打反擊前隨機一句；與 NPC 泡泡同款，畫在名牌上方）
        if (a.say && S.t < a.say.until) drawBubble(a.x, top - 8, a.say.text, Math.min(1, (a.say.until - S.t) / .4));
      }
    });
  }
  // 死亡：原地墓碑（本地或同島的人都一樣畫）
  function tombEntry(x, y, name, secsLeft) {
    return {
      y,
      draw: () => {
        const img = S.tombImg; if (!img) return;
        ctx.fillStyle = 'rgba(10,14,20,.22)';
        ctx.beginPath(); ctx.ellipse(x, y + 1, 7, 2.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.drawImage(img, x - img.width * 2 / 2, y - img.height * 2, img.width * 2, img.height * 2);
        ctx.font = '9px "Microsoft JhengHei"'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.75)';
        ctx.strokeText(name, x, y - img.height * 2 - 4);
        ctx.fillStyle = '#cfd8c8';
        ctx.fillText(name, x, y - img.height * 2 - 4);
        if (secsLeft != null) {   // 復活倒數（遠端玩家是依「我看到他倒下」起算，與本人畫面可能差一點點）
          ctx.font = 'bold 9px "Microsoft JhengHei"';
          ctx.strokeText(`${Math.max(1, Math.ceil(secsLeft))} 秒後復活`, x, y + 11);
          ctx.fillStyle = '#ffd86b';
          ctx.fillText(`${Math.max(1, Math.ceil(secsLeft))} 秒後復活`, x, y + 11);
        }
      }
    };
  }
  for (const p of S.players) {
    if (p.dead) { list.push(tombEntry(p.x, p.y, p.name, DEAD_SECONDS - (performance.now() - p.deadAt) / 1000)); continue; }   // 死亡：畫墓碑不畫人（NPC 不會死，不受影響）
    list.push({
      y: p.y + (p.pose ? 2 : 0),      // 坐著/睡著的人要畫在自己的椅子/床之後（排序鍵比家具大一點）
      draw: () => {
        const wid = p.tool || S.me.weapon;      // 打石頭/樹木時暫時換成鎬子/斧頭
        const wi = !p.npc && wid !== 'hands' ? S.weaponImgs[wid] : null;
        drawPerson(p, wi, p.npc ? (p.guide ? '#ffd86b' : '#bcd8e8') : '#ffffff');
      }
    });
  }
  // M2：同島的其他玩家
  for (const r of S.remotes.values()) {
    if (r.dead) { list.push(tombEntry(r.x, r.y, r.name, DEAD_SECONDS - (performance.now() - (r.deadAt || performance.now())) / 1000)); continue; }
    list.push({
      y: r.y + (r.pose ? 2 : 0),
      draw: () => drawPerson(r, r.weapon && r.weapon !== 'hands' ? S.weaponImgs[r.weapon] : null, '#ffe9a8')   // 同島的人用暖金色名牌區分
    });
  }
  list.sort((a, b) => a.y - b.y).forEach(o => o.draw());

  // 地板模式 ghost：游標所在格（長按右鍵時顯示拆除）
  if (S.mode === 'decor' && S.decorTab === 'floor' && S.mouseCell) {
    const [mx, my] = S.mouseCell, del = S.paint === 'del';
    // 預覽範圍：鋪設＝選中地板的大小（地毯 2×2）；拆除＝游標下那塊地板的整個範圍
    let rx = mx, ry = my, rw = 1, rh = 1, ok;
    if (del) {
      const k = floorAt(S.floorMap, mx, my);
      ok = floorCellOk(mx, my);
      if (k >= 0) { const s = floorSize(S.floorMap.get(k)); rx = k % COLS; ry = Math.floor(k / COLS); rw = s.w; rh = s.h; }
    } else {
      const s = floorSize(S.selFloor); rw = s.w; rh = s.h;
      ok = !!S.selFloor && !!floorCovered(S.floorMap, S.selFloor, mx, my);
      if (ok && S.floorImgs[S.selFloor]) {
        ctx.globalAlpha = .7; ctx.drawImage(S.floorImgs[S.selFloor], mx * CELL, my * CELL, rw * CELL, rh * CELL); ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = !ok ? 'rgba(220,80,80,.3)' : del ? 'rgba(230,150,60,.3)' : 'rgba(90,220,120,.18)';
    ctx.fillRect(rx * CELL, ry * CELL, rw * CELL, rh * CELL);
    ctx.strokeStyle = !ok ? 'rgba(255,120,120,.8)' : del ? 'rgba(255,190,90,.9)' : 'rgba(120,255,160,.8)';
    ctx.strokeRect(rx * CELL + .5, ry * CELL + .5, rw * CELL - 1, rh * CELL - 1);
  }
  // 裝飾模式 ghost
  if (S.mode === 'decor' && S.decorTab === 'furn' && S.mouseCell && S.sel && S.furnImgs[S.sel]) {
    const def = furnitureDef(S.sel), img = S.furnImgs[S.sel];
    const [mx, my] = S.mouseCell, w = def.w * CELL, h = def.h * CELL;
    const valid = canPlace(S.sel, mx, my);
    ctx.fillStyle = valid ? 'rgba(90,220,120,.28)' : 'rgba(220,80,80,.3)';
    ctx.fillRect(mx * CELL, my * CELL, w, h);
    ctx.globalAlpha = .75;
    ctx.drawImage(img, mx * CELL, (my + def.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = valid ? 'rgba(120,255,160,.8)' : 'rgba(255,120,120,.8)';
    ctx.strokeRect(mx * CELL + .5, my * CELL + .5, w - 1, h - 1);
  }
  // 傷害飄字 / 消失特效
  for (const f of S.floaters) {
    ctx.save();
    if (f.beam) {   // 石化之瞳發射：以蛇女為中心的綠白光環快速擴散到全地圖（0.7 秒淡出）
      const q = 1 - f.life / .7;
      ctx.strokeStyle = `rgba(160,255,180,${.9 * (1 - q)})`;
      ctx.lineWidth = 26 * (1 - q) + 4;
      ctx.beginPath(); ctx.arc(f.x1, f.y1, 40 + q * 2200, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,240,${.7 * (1 - q)})`;
      ctx.lineWidth = 8 * (1 - q) + 1;
      ctx.beginPath(); ctx.arc(f.x1, f.y1, 40 + q * 2200, 0, Math.PI * 2); ctx.stroke();
      ctx.restore(); continue;
    }
    ctx.translate(f.x, f.y);
    if (f.fishImg) {   // 釣到的東西：從頭上浮起來再淡出
      ctx.globalAlpha = Math.min(1, f.life / .5);
      ctx.drawImage(f.fishImg, -24, -24, 48, 48);
    } else if (f.ring) {   // 被爪擊打中的衝擊圈：紅圈快速擴散淡出
      const q = 1 - f.life / .35;
      ctx.strokeStyle = `rgba(255,110,80,${1 - q})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 6 + q * 26, 0, Math.PI * 2); ctx.stroke();
    } else if (f.slash) {   // 爪擊特效：三道金色抓痕往目標方向掃過去（0.45 秒內淡出）
      const q = 1 - f.life / .45;
      ctx.rotate(f.ang);
      ctx.lineCap = 'round'; ctx.lineWidth = 4;
      for (let i = -1; i <= 1; i++) {
        ctx.strokeStyle = `rgba(255,218,120,${(.95 - Math.abs(i) * .12) * (1 - q)})`;
        const off = i * 16, x0 = -8 + q * 30;
        ctx.beginPath(); ctx.moveTo(x0, off + 22);
        ctx.quadraticCurveTo(x0 + 40, off - 2, x0 + 58, off - 26); ctx.stroke();
      }
    } else if (f.poof) {
      const q = 1 - f.life / .55;
      ctx.strokeStyle = `rgba(250,250,240,${1 - q})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 4 + q * 18, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(250,250,240,${(1 - q) * .5})`;
      for (let i = 0; i < 6; i++) {
        const an = i * Math.PI / 3, r = q * 16;
        ctx.fillRect(Math.cos(an) * r - 1, Math.sin(an) * r - 1, 2, 2);
      }
    } else {
      ctx.font = (f.crit ? 'bold 13px' : 'bold 11px') + ' "Microsoft JhengHei"';
      ctx.textAlign = 'center';
      ctx.fillStyle = f.crit ? '#ffb347' : '#ffffff';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
      const pop = f.life > .66 ? (0.8 - f.life) * 15 : 0; // 初段放大
      ctx.strokeText(f.crit ? f.v + ' !' : f.v, 0, -pop);
      ctx.fillText(f.crit ? f.v + ' !' : f.v, 0, -pop);
    }
    ctx.restore();
  }
  ctx.restore();
}

const MAX_FURN = 500;   // 每個地形的擺設上限（與兩份伺服器的 MAX_FURN 一致）
function canPlace(typeId, x, y) {
  const def = furnitureDef(typeId);
  for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) return false;
    if (!S.world.types[yy * COLS + xx]) return false;
    if (S.occ.get(key(xx, yy)) !== undefined) return false;
  }
  return true;
}

// ---------------- 裝飾資料存取 ----------------
// 連線時擺設由伺服器管（同島共用）；沒連線才退回瀏覽器本機存檔
function netOn() { return !!S.net?.connected; }
function saveLayout() {
  if (netOn()) return;
  lsSet('dcisland.m0.layout.' + S.terrain, S.furnItems);
  lsSet('dcisland.m0.floor.' + S.terrain, floorToList(S.floorMap));
}
function loadLayout() {
  if (netOn()) { applyFurn(S.netFurn); applyFloor(S.netFloor); return; }
  try { S.furnItems = JSON.parse(localStorage.getItem('dcisland.m0.layout.' + S.terrain)) || []; }
  catch { S.furnItems = []; }
  rebuildOcc();
  try { applyFloor(JSON.parse(localStorage.getItem('dcisland.m0.floor.' + S.terrain)) || []); }
  catch { applyFloor([]); }
}

// ---- 地板層 ----
// 資料格式與伺服器相同：[[x,y,id],…]；記憶體裡用 Map（y*COLS+x -> id）。略過 manifest 沒有的種類
const floorToList = m => [...m].map(([k, id]) => [k % COLS, Math.floor(k / COLS), id]);
function listToFloor(items) {
  const m = new Map();
  for (const it of items) {
    if (!Array.isArray(it) || !S.floors?.items.some(f => f.id === it[2])) continue;
    if (Number.isInteger(it[0]) && Number.isInteger(it[1]) && it[0] >= 0 && it[0] < COLS && it[1] >= 0 && it[1] < ROWS) m.set(it[1] * COLS + it[0], it[2]);
  }
  return m;
}
function applyFloor(items) { S.floorMap = listToFloor(items); }
function onNetFloor(items) {
  S.netFloor = items;
  if (!S.floors) return;
  if (S.mode === 'decor') {      // 別人保存了新的地板：以它為底，把我的地板草稿重新疊上去
    S.baseFloor = listToFloor(items);
    S.floorMap = applyFloorOps(S.baseFloor, S.draft);
  } else applyFloor(items);
}
// 把草稿裡的地板操作套到一份地板上（回傳新 Map；不合法的操作略過）
function applyFloorOps(base, ops) {
  const m = new Map(base);
  for (const op of ops) if (op.t === 'floor') applyFloorOp(m, op);
  return m;
}
// 多格地板（floors.json 標 w/h，例如地毯 2×2）：只在錨點格（左上）存一筆，其餘格子視為被它蓋住。
// 規則與兩份伺服器的 applyFloorOp 一致：多格地板彼此不重疊、單格地板不能鋪在多格地板上；
// 鋪多格地板會取代範圍內的單格地板；拆除點到多格地板的任一格就整塊拆掉
const FLOOR_MAX = 4;   // 多格地板的最大邊長（找「誰蓋住這格」時往左上回找的範圍；與伺服器一致）
const floorSize = id => S.floorSizes?.get(id) || { w: 1, h: 1 };
function floorAt(m, x, y) {   // 蓋住 (x,y) 的地板錨點 key（單格地板就是自己），沒有回 -1
  for (let dy = 0; dy < FLOOR_MAX; dy++) for (let dx = 0; dx < FLOOR_MAX; dx++) {
    const ax = x - dx, ay = y - dy;
    if (ax < 0 || ay < 0) continue;
    const id = m.get(ay * COLS + ax);
    if (id === undefined) continue;
    const s = floorSize(id);
    if (dx < s.w && dy < s.h) return ay * COLS + ax;
  }
  return -1;
}
// 在 (x,y) 鋪 type 時會被取代的單格地板 key 清單；鋪不下（水上／出界／壓到多格地板）回 null
function floorCovered(m, type, x, y) {
  const s = floorSize(type), out = [];
  for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) {
    if (!floorCellOk(x + dx, y + dy)) return null;
    const k = floorAt(m, x + dx, y + dy);
    if (k < 0) continue;
    const t = floorSize(m.get(k));
    if (t.w * t.h > 1) return null;
    out.push(k);
  }
  return out;
}
function applyFloorOp(m, op) {   // 有變動回 true
  const [x, y] = op.cell;
  if (op.type === null) { const k = floorAt(m, x, y); return k >= 0 && m.delete(k); }
  const cov = floorCovered(m, op.type, x, y), s = floorSize(op.type);
  if (!cov) return false;
  if (s.w * s.h === 1 && cov.length === 1 && m.get(cov[0]) === op.type) return false;   // 同一種，沒變
  for (const k of cov) m.delete(k);
  m.set(y * COLS + x, op.type);
  return true;
}
const floorCellOk = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !!S.world.types[y * COLS + x];
// 長按鋪設/拆除：游標所在格套用目前動作（沒有變化的不記草稿；地毯掃過去會一塊接一塊鋪，不會重疊）
function paintFloor() {
  if (S.mode !== 'decor' || S.decorTab !== 'floor' || !S.paint || !S.mouseCell || S.players[0].dead) return;
  const [x, y] = S.mouseCell;
  const type = S.paint === 'add' ? S.selFloor : null;
  if (S.paint === 'add' && !type) return;
  const op = { t: 'floor', cell: [x, y], type };
  if (S.draft.length >= 1200) { toast('未保存的變動太多了，請先按「完成」保存'); S.paint = null; return; }
  if (!applyFloorOp(S.floorMap, op)) return;
  S.draft.push(op);
  updateDecorUI();
}

// 套用伺服器送來的擺設清單（略過 manifest 沒有的種類，避免壞資料讓繪圖當掉）
function applyFurn(items) {
  S.furnItems = items.filter(it => it && furnitureDef(it.type) && Array.isArray(it.cell));
  rebuildOcc();
}
function onNetFurn(items) {
  S.netFurn = items;
  if (!S.furn) return;
  if (S.mode === 'decor') {      // 別人保存了新的擺設：以它為底，把我的草稿重新疊上去
    S.baseFurn = cloneFurn(items.filter(it => it && furnitureDef(it.type) && Array.isArray(it.cell)));
    S.furnItems = applyOps(S.baseFurn, S.draft); rebuildOcc(); updateDecorUI();
  } else applyFurn(items);
}

// ---------------- 裝飾模式：草稿＋保存 ----------------
// 裝飾模式的變動先記成「操作清單」S.draft（{t:'place',type,cell} / {t:'remove',cell} / {t:'clear'}），
// 畫面上立刻看得到，但要按「完成」（或離開時選保存）才會真的送給伺服器；「取消變動」就全部丟掉。
// 同島的人在你保存之前看不到。保存時伺服器會逐一驗證（被別人搶先占用的會被跳過），清空只有管理員能做。
const cloneFurn = list => list.map(it => it.text ? { type: it.type, cell: [it.cell[0], it.cell[1]], text: it.text } : { type: it.type, cell: [it.cell[0], it.cell[1]] });
const furnCovers = (it, cell) => {
  const d = furnitureDef(it.type) || { w: 1, h: 1 };
  return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
};
// 在指定清單上能不能放（範圍、水邊、與清單內家具重疊）
function canPlaceIn(list, typeId, x, y) {
  const def = furnitureDef(typeId); if (!def) return false;
  for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS || !S.world.types[yy * COLS + xx]) return false;
  }
  return !list.some(it => { const d = furnitureDef(it.type) || { w: 1, h: 1 };
    return x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h; });
}
// 把一串操作套到一份清單上（回傳新清單；不合法的操作略過）
function applyOps(base, ops) {
  const list = cloneFurn(base);
  for (const op of ops) {
    if (op.t === 'clear') list.length = 0;
    else if (op.t === 'remove') { const i = list.findIndex(it => furnCovers(it, op.cell)); if (i >= 0) list.splice(i, 1); }
    else if (op.t === 'place' && canPlaceIn(list, op.type, op.cell[0], op.cell[1])) list.push({ type: op.type, cell: [op.cell[0], op.cell[1]] });
  }
  return list;
}
function stageOp(op) {
  S.draft.push(op);
  S.furnItems = applyOps(S.furnItems, [op]);
  rebuildOcc(); updateDecorUI();
}
const canClear = () => !netOn() || S.admin;      // 連線時要管理員；沒連線（單機）自己的島自己清
function updateDecorUI() {
  const n = S.draft.length, el = $('furnDirty');
  el.classList.toggle('hidden', !n);
  el.textContent = `有 ${n} 項未保存的變動`;
  $('furnClear').classList.toggle('disabled', !canClear());
  $('furnClear').title = canClear() ? '' : '需要管理員權限';
}
function enterDecor() {
  S.mode = 'decor'; S.draft = []; S.baseFurn = cloneFurn(S.furnItems); S.baseFloor = new Map(S.floorMap); S.paint = null;
  $('btnDecor').classList.add('active'); $('furnPanel').classList.remove('hidden');
  S.sel = S.sel || S.furn.items.find(it => S.furnImgs[it.id] && !it.legacy)?.id || null;   // 缺圖／legacy 的種類不列出、也不預選
  S.selFloor = S.selFloor || S.floors.items.find(it => S.floorImgs[it.id])?.id || null;
  buildFurnPanel(); updateDecorUI();
  toast('裝飾模式：左鍵放置／右鍵移除（按「完成」才會保存）', 2600);
}
function exitDecor(save) {
  const n = S.draft.length;
  if (n && save) {
    if (netOn()) for (let i = 0; i < n; i += 80) S.net.commitFurn(S.draft.slice(i, i + 80));   // 結果以伺服器廣播的清單為準
    else saveLayout();
  } else if (n) {                                  // 不保存：回到進入裝飾模式（或最近一次同步）時的樣子
    S.furnItems = cloneFurn(S.baseFurn); rebuildOcc(); S.floorMap = new Map(S.baseFloor);
  }
  S.mode = 'walk'; S.draft = []; S.paint = null; closeConfirm();
  $('btnDecor').classList.remove('active'); $('furnPanel').classList.add('hidden');
  if (!n) toast('已離開裝飾模式');
  else if (!save) toast('已取消變動');
  else if (!netOn()) toast('擺設已保存');          // 連線時等伺服器的 commit_result 再提示
}
// E / Esc / 按鈕：有未保存的變動就先問
function requestExitDecor() {
  if (S.confirmOpen) { closeConfirm(); return; }
  if (!S.draft.length) { exitDecor(false); return; }
  S.confirmOpen = true;
  $('confirmMsg').textContent = `有 ${S.draft.length} 項擺設變動還沒保存，要保存嗎？`;
  $('confirmBox').classList.remove('hidden');
}
function closeConfirm() { S.confirmOpen = false; $('confirmBox').classList.add('hidden'); }
function onCommitResult(m) {
  // 伺服器先廣播 furn/floor 再回 commit_result：此時 netFurn/netFloor 已是保存後的權威結果。
  // 一項都沒套用時伺服器不廣播，畫面會停在草稿的樣子（別人看不到），所以這裡一律以伺服器版本為準
  if (S.mode === 'walk') { applyFurn(S.netFurn); applyFloor(S.netFloor); }
  if (m.denied) toast('清空需要管理員權限，這項已略過' + (m.applied ? `（其他 ${m.applied} 項已保存）` : ''), 3200);
  else if (m.rejected) toast(`已保存（${m.rejected} 項因被別人搶先占用或不合法而未套用）`, 3200);
  else toast('擺設已保存');
}

// ---------------- UI ----------------
function buildTerrainChips() {
  const box = $('terrainChips'); box.innerHTML = '';
  for (const id of TERRAIN_IDS) {
    const b = document.createElement('div');
    b.className = 'chip' + (id === S.terrain ? ' active' : '');
    b.textContent = S.terrains[id].name;
    b.onclick = () => switchTerrain(id);
    box.appendChild(b);
  }
}

// 站在水裡／家具上時，往最近的可行走位置挪（找不到才回出生點）
function landNear(px, py) {
  if (!blocked(px, py)) return [px, py];
  for (let r = 1; r <= 14; r++) {
    for (let a = 0; a < 20; a++) {
      const ang = a / 20 * Math.PI * 2;
      const nx = px + Math.cos(ang) * r * CELL, ny = py + Math.sin(ang) * r * CELL;
      if (!blocked(nx, ny)) return [nx, ny];
    }
  }
  return [(COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL];
}

async function switchTerrain(id) {
  if (id === S.terrain) return;
  if (S.mode === 'decor' && S.draft.length) { toast('有未保存的擺設變動，請先按「完成」保存或「取消變動」', 3000); return; }
  try {
    if (S.mode === 'decor') exitDecor(false);
    await ensureTerrain(id);      // 先載好圖，再切地形
    S.terrain = id; try { localStorage.setItem('dcisland.m0.terrain', id); } catch { /* 存不了不影響換地形 */ }
    S.remotes.clear();                          // 換了地形，原地形的人都看不到了
    if (netOn()) { S.netFurn = []; S.netFloor = []; }   // 等伺服器送該地形的擺設與地板
    genWorld(id); loadLayout();
    spawnNPCs();                                // 這張地圖自己的 NPC（上一張地圖的留在原地）
    // 留在原地（切地形不該把人吸到出生點）
    const me = S.players[0];
    const [nx, ny] = landNear(me.x, me.y);
    me.x = nx; me.y = ny;
    me.petUntil = 0; me.petTick = 0; me.petWas = false;   // 石化判定只在畫面本地，換地形就解除
    me.fish = null;                                        // 換地形就收竿
    buildTerrainChips();
    toast(`已移動到${S.terrains[id].name}`);
    // M2：只有自己過去；告訴伺服器，讓新地形的人看到你、舊地形的人看不到你
    S.net?.enter?.(id);
    // 島主同步：進有島主的地形就把陸地位圖交給伺服器（島形只有客戶端知道）
    uploadLandMap();
  } catch (e) {
    // 不要靜默失敗：讓玩家看得到，也回報到伺服器日誌
    toast(`切換${id}失敗：${e.message || e}`, 4000);
    reportError('terrain-switch', id + ' | ' + (e.stack || e.message || e));
    console.error('switchTerrain', id, e);
  }
}

function setDecorTab(tab) {
  S.decorTab = tab; S.paint = null; buildFurnPanel();
  toast(tab === 'floor' ? '地板模式：長按左鍵鋪設／長按右鍵拆除' : '擺設模式：左鍵放置／右鍵移除', 2200);
}
function buildFurnPanel() {
  const floorTab = S.decorTab === 'floor';
  $('tabFurn').classList.toggle('active', !floorTab); $('tabFloor').classList.toggle('active', floorTab);
  $('furnHint').textContent = floorTab ? '長按左鍵鋪設／長按右鍵拆除 · 按「完成」才會保存 · E／Esc 離開'
                                       : '左鍵放置／右鍵移除 · 按「完成」才會保存 · E／Esc 離開';
  $('furnClear').classList.toggle('hidden', floorTab);        // 清空只針對擺設，地板用長按右鍵拆
  const box = $('furnList'); box.innerHTML = '';
  if (floorTab) {
    for (const it of S.floors.items) {
      if (!S.floorImgs[it.id]) continue;   // 缺圖的地板不列出
      const div = document.createElement('div');
      div.className = 'fitem' + (S.selFloor === it.id ? ' sel' : '');
      const cv = document.createElement('canvas');
      cv.width = 44; cv.height = 40; cv.style.height = '40px';
      const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
      g.drawImage(S.floorImgs[it.id], 6, 4, 32, 32);
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = it.name;
      div.appendChild(cv); div.appendChild(nm);
      div.onclick = () => { S.selFloor = it.id; buildFurnPanel(); };
      box.appendChild(div);
    }
    return;
  }
  for (const it of S.furn.items) {
    const img = S.furnImgs[it.id];
    if (!img || it.legacy) continue;       // 缺圖的家具不列出；legacy＝已改成別的東西（例如地毯改為地板），舊存檔照畫但不能再擺
    const div = document.createElement('div');
    div.className = 'fitem' + (S.sel === it.id ? ' sel' : '');
    const cv = document.createElement('canvas');
    cv.width = 44; cv.height = 40; cv.style.height = '40px';
    const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
    const w = img.width * 2, h = img.height * 2, s2 = Math.min(1, 44 / w, 40 / h);
    g.drawImage(img, (44 - w * s2) / 2, 40 - h * s2, w * s2, h * s2);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = it.name;
    div.appendChild(cv); div.appendChild(nm);
    div.onclick = () => { S.sel = it.id; buildFurnPanel(); };
    box.appendChild(div);
  }
}

// 色票的「顯示順序」：色系（紅粉→棕橙→黃→綠→青→藍→靛紫）由深到淺，灰白黑類放最後。
// 只影響面板怎麼排，顏色編號（存檔/同步用的索引）不變，所以舊存檔的造型不會跑掉；新增顏色也會自動排進去
function swatchOrder(colors) {
  return colors.map((hex, i) => {
    const [r, g, b] = hexRGB(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { i, neutral: (mx ? d / mx : 0) < .12 || mx < .2, fam: Math.floor(((h + 25) % 360) / 30), l: (mx + mn) / 2 };
  }).sort((a, b) => (a.neutral - b.neutral) || (a.neutral ? a.l - b.l : (a.fam - b.fam) || (a.l - b.l))).map(x => x.i);
}

function buildAvatarPanel() {
  const sk = $('skinOpts'); sk.innerHTML = '';
  for (const s of S.avatar.skins) {
    const o = document.createElement('div');
    o.className = 'opt' + (S.me.skin === s.id ? ' sel' : '');
    o.style.background = s.base; o.title = s.name;
    o.onclick = () => { S.me.skin = s.id; saveAvatar(); buildAvatarPanel(); };
    sk.appendChild(o);
  }
  const hr = $('hairOpts'); hr.innerHTML = '';
  for (const h of S.avatar.hair) {
    const o = document.createElement('div');
    o.className = 'opt name' + (S.me.hair === h.id ? ' sel' : '');
    o.textContent = h.name;
    o.onclick = () => { S.me.hair = h.id; saveAvatar(); buildAvatarPanel(); };
    hr.appendChild(o);
  }
  const pn = $('pantsOpts'); pn.innerHTML = '';
  swatchOrder(S.avatar.pantsColors).forEach(i => {
    const hex = S.avatar.pantsColors[i], o = document.createElement('div');
    o.className = 'opt' + ((S.me.pants || 0) === i ? ' sel' : '');
    o.style.background = hex;
    o.onclick = () => { S.me.pants = i; saveAvatar(); buildAvatarPanel(); };
    pn.appendChild(o);
  });
  const sh = $('shirtOpts'); sh.innerHTML = '';
  swatchOrder(S.avatar.shirtColors).forEach(i => {
    const hex = S.avatar.shirtColors[i], o = document.createElement('div');
    o.className = 'opt' + (S.me.shirt === i ? ' sel' : '');
    o.style.background = hex;
    o.onclick = () => { S.me.shirt = i; saveAvatar(); buildAvatarPanel(); };
    sh.appendChild(o);
  });
  // 武器（影響攻擊）
  const wp = $('weaponOpts'); wp.innerHTML = '';
  for (const w of S.avatar.weapons) {
    const o = document.createElement('div');
    o.className = 'opt name' + (S.me.weapon === w.id ? ' sel' : '');
    o.textContent = w.name;
    o.onclick = () => { S.me.weapon = w.id; saveAvatar(); buildAvatarPanel(); };
    wp.appendChild(o);
  }
}
function saveAvatar() { lsSet('dcisland.m0.avatar', S.me); }



// ---------------- 輸入 ----------------
const keys = {};
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (S.signOpen) {                                             // 看板視窗開著：Esc 取消、Ctrl+Enter 儲存，其他鍵留給輸入框
    if (k === 'escape') { e.preventDefault(); closeSign(); }
    else if (k === 'enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveSign(); }
    return;
  }
  keys[k] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (S.listOpen) { if (k === 'escape' || k === 'l') closeList(); return; }                // 線上列表開著：Esc / L 關閉
  if (S.dexOpen) { if (k === 'escape') closeDex(); return; }                               // 圖鑑開著：Esc 關閉（仍可走路）
  if (S.helpOpen) { if (k === 'escape' || k === 'enter') closeHelp(); return; }       // 操作說明開著：Esc / Enter 關閉，其他鍵不處理
  if (S.confirmOpen) { if (k === 'escape') closeConfirm(); return; }   // 「要保存嗎？」開著時：Esc＝繼續編輯，其他鍵不處理
  if (k === 'e' && !e.repeat) {
    if (S.mode === 'decor') requestExitDecor();                       // 離開不受死亡影響
    else if (S.mode === 'walk') { if (S.players[0].dead) toast('你在墓碑裡動不了', 1400); else enterDecor(); }
  }
  if (k === 'escape' && S.mode === 'decor') requestExitDecor();     // Esc 也能離開裝飾模式
  if (k === 'l' && !e.repeat && S.mode === 'walk' && !S.confirmOpen) openList();
  if (k === 'f' && !e.repeat) doAttack(true);
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; if (e.key.toLowerCase() === 'f') S.holdSkipF = false; });
// 切走視窗時放開所有按住的鍵，避免卡住一直揮擊/走路
addEventListener('blur', () => { for (const k in keys) keys[k] = false; S.mouseHeld = false; S.paint = null; });
addEventListener('mouseup', e => { if (e.button === 0) S.mouseHeld = false; if (e.button === 0 || e.button === 2) S.paint = null; });

canvas.addEventListener('mousemove', e => {
  S.mouseClient = [e.clientX, e.clientY];     // 長按左鍵時，鏡頭/角色移動後仍要用最新的游標位置
  const r = canvas.getBoundingClientRect();
  S.mouseCell = [Math.floor((e.clientX - r.left + S.cam.x) / CELL), Math.floor((e.clientY - r.top + S.cam.y) / CELL)];
  paintFloor();   // 長按鋪地板：滑鼠移動時就套用（不只靠每幀），掉幀時掃過的格子也不會漏
});
canvas.addEventListener('mouseleave', () => S.mouseCell = null);
// 左鍵攻擊（世界座標 wx,wy 是游標指的位置）：先面向游標方向再揮
function clickAttack(wx, wy) {
  if (S.players[0].fish) { doAttack(false); return; }   // 釣魚中：點哪裡都是收竿／拉竿（不會去坐椅子、跟 NPC 說話）
  // 點在島主身上：優先攻擊島主，點擊不讓牠腳下的椅子／NPC 攔走
  const onOwner = S.animals.some(a => {
    const od = animalDef(a.id);
    return od?.owner && !a.dead && Math.hypot(a.x - wx, a.y - wy) < 30 * (od.big || 1);
  });
  // 點到可坐/可睡的家具（椅子、沙發、床）→ 坐下/躺下；再點一次起身。長按自動連擊時不處理，避免反覆切換
  if (!onOwner && !quiet) {
    const f = furnAtPoint(wx, wy);
    if (f && furnitureDef(f.type)?.use) { usePose(f); return; }
    if (f && furnitureDef(f.type)?.text) { openSign(f); return; }
    const n = npcAt(wx, wy);
    if (n) { talkTo(n); return; }                // 點 NPC：跟他說話（不是攻擊）
  }
  if (S.players[0].pose) return;                 // 坐著/睡著不能揮擊
  if (S.players[0].dead) {                       // 死亡（墓碑）：不能攻擊，長按時不重複提示
    if (!quiet) toast('你在墓碑裡動不了', 1400);
    return;
  }
  if (S.t < (S.players[0].petUntil ?? 0)) { if (!quiet) say('被石化了，動彈不得', 1200); return; }   // 石化：不能打動物／採集
  // 點到可破壞物件（且那裡沒有動物）→ 自動換工具去打它
  if (!S.animals.some(a => !a.dead && Math.hypot(a.x - wx, a.y - wy) < 30 * (animalDef(a.id).big || 1))) {
    const d = decoAt(wx, wy);
    if (d) { useTool(d); return; }
  }
  if (Math.abs(wx - S.players[0].x) > 6) S.players[0].dir = Math.sign(wx - S.players[0].x);
  doAttack(false, wx, wy);
  // 沒命中但點到了一隻動物 → 牠的致公告告（FF14 點動物 FU）
  if (!S._hits) {
    for (const a of S.animals) {
      if (!a.dead && Math.hypot(a.x - wx, a.y - wy) < 30 * (animalDef(a.id).big || 1)) {   // 島主很大隻：點擊範圍跟著放大
        say(animalDef(a.id).line, 2200);
        break;
      }
    }
  }
}
// 長按 F 或左鍵：冷卻一到就自動再揮（每幀呼叫；第一下由按下事件負責，之後這裡接手）
function autoAttack() {
  if (S.mode !== 'walk' || S.helpOpen || S.listOpen || S.signOpen || S.dexOpen || S.players[0].pose || S.t - S.players[0].lastAtk < ATK_CD) return;
  if (isRod() || S.players[0].fish) return;   // 釣竿不連擊：長按不會一直拋竿／收竿
  quiet = true;
  try {
    if (S.mouseHeld && S.mouseClient) {
      const r = canvas.getBoundingClientRect();
      clickAttack(S.mouseClient[0] - r.left + S.cam.x, S.mouseClient[1] - r.top + S.cam.y);
    } else if (keys['f'] && !S.holdSkipF) doAttack(true);     // F 剛拿來坐下/起身時，按住不放不要接著揮劍
  } finally { quiet = false; }
}
canvas.addEventListener('mousedown', e => {
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen) return;
  if (S.mode === 'decor' && S.decorTab === 'floor' && (e.button === 0 || e.button === 2)) {   // 地板模式：長按左鍵鋪、長按右鍵拆
    if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
    const r = canvas.getBoundingClientRect();
    S.mouseClient = [e.clientX, e.clientY];
    S.mouseCell = [Math.floor((e.clientX - r.left + S.cam.x) / CELL), Math.floor((e.clientY - r.top + S.cam.y) / CELL)];
    S.paint = e.button === 0 ? 'add' : 'del';
    paintFloor();
    return;
  }
  if (e.button !== 0) return;
  if (S.mode === 'walk') {
    const r = canvas.getBoundingClientRect();
    S.mouseHeld = true; S.mouseClient = [e.clientX, e.clientY];
    clickAttack(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y);
    return;
  }
  if (S.mode !== 'decor' || !S.mouseCell || !S.sel) return;
  if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
  const [x, y] = S.mouseCell;
  if (S.draft.length >= 300) { toast('未保存的變動太多了，請先按「完成」保存'); return; }
  if (S.furnItems.length >= MAX_FURN) { toast(`這個地形的擺設已達上限（${MAX_FURN} 件）`); return; }
  if (canPlace(S.sel, x, y)) { stageOp({ t: 'place', type: S.sel, cell: [x, y] }); toast('放置'); }
  else toast('這裡放不下（水邊／已占用）');
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen) return;
  if (S.mode === 'walk') {   // 右鍵和左鍵一樣：點椅子/沙發/床就坐下/躺下，再點一次起身
    const r = canvas.getBoundingClientRect();
    const f = furnAtPoint(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y);
    if (f && furnitureDef(f.type)?.use) usePose(f);
    else if (f && furnitureDef(f.type)?.text) openSign(f);
    else { const n = npcAt(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y); if (n) talkTo(n); }
    return;
  }
  if (S.mode !== 'decor' || !S.mouseCell || S.decorTab === 'floor') return;   // 地板模式的拆除由 mousedown 處理
  if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
  const [x, y] = S.mouseCell;
  const idx = S.occ.get(key(x, y));
  if (idx !== undefined) { stageOp({ t: 'remove', cell: [x, y] }); toast('收起擺設'); }
});

$('btnDecor').onclick = () => {
  if (S.mode === 'decor') { requestExitDecor(); return; }
  if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
  enterDecor();
};
$('tabFurn').onclick = () => { if (S.decorTab !== 'furn') setDecorTab('furn'); };
$('tabFloor').onclick = () => { if (S.decorTab !== 'floor') setDecorTab('floor'); };
$('furnClose').onclick = () => exitDecor(true);                // 完成＝保存並離開
$('furnCancel').onclick = () => exitDecor(false);              // 取消變動＝不保存並離開
$('cfSave').onclick = () => exitDecor(true);
$('cfDiscard').onclick = () => exitDecor(false);
$('cfKeep').onclick = closeConfirm;
$('helpClose').onclick = closeHelp;
$('signSave').onclick = saveSign;
$('signCancel').onclick = closeSign;
$('furnClear').onclick = () => {
  if (S.players[0].dead) { toast('你在墓碑裡動不了', 1400); return; }
  if (!canClear()) { toast('清空需要管理員權限'); return; }
  stageOp({ t: 'clear' }); toast('已清空（按「完成」才會保存，「取消變動」可還原）', 2600);
};

$('listClose').onclick = closeList;
$('btnHelp').onclick = openHelp;       // 右上「操作說明」：和嚮導一樣的操作說明
$('btnAvatar').onclick = () => { $('avatarPanel').classList.toggle('hidden'); buildAvatarPanel(); };
$('avatarClose').onclick = () => $('avatarPanel').classList.add('hidden');
$('btnDex').onclick = () => { if (S.dexOpen) closeDex(); else if (S.fishDB) openDex(); };   // 右上「圖鑑」：魚類圖鑑
$('dexClose').onclick = closeDex;

// ---------------- 資源載入 ----------------
async function ensureTerrain(id) {
  if (S.tImages[id]) return;
  const man = S.terrains[id];
  const files = new Set([man.ground, man.edge, man.water]);
  for (const d of man.deco) files.add(d.sprite);
  const ims = {};
  await Promise.all([...files].map(async f => ims[f] = await optImg(`assets/terrain/${id}/${f}`)));
  for (const f of [...files]) if (!ims[f]) console.warn('缺地形圖:', id, f);
  S.tImages[id] = ims;
}

// 前端錯誤回報（開發期）：打到伺服器 /api/log，這樣「沒反應」不會變成懸案
function reportError(tag, detail) {
  try {
    fetch('/api/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, extra: String(detail).slice(0, 500) }),
    });
  } catch { /* 回報失敗不影響遊戲 */ }
}
window.addEventListener('error', e => reportError('client-error', `${e.message} @${e.filename || '?'}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => reportError('client-reject', (e.reason && (e.reason.stack || e.reason.message)) || e.reason));

let welcomeUntil = 0;
async function boot() {
  $('btnDecor').disabled = false;
  // manifest：互不相依，一次全部並行抓（以前是一個接一個，首次進島要等一長串往返）
  const [tjson, furn, floors, animalsDB, npcDB, toolsDB, avatar, fishDB] = await Promise.all([
    Promise.all(TERRAIN_IDS.map(id => loadJSON(`assets/terrain/${id}/terrain.json`))),
    loadJSON('assets/furniture/furniture.json'),
    loadJSON('assets/floors/floors.json'),
    loadJSON('assets/animals/animals.json'),    // 小動物（FF14 致敬）
    loadJSON('assets/npcs/npcs.json'),
    loadJSON('assets/tools/tools.json'),        // 採集工具（鎬子/斧頭）：圖放進 weaponImgs，讓繪製與遠端玩家共用同一套武器繪製
    loadJSON('assets/avatar/avatar.json'),
    loadJSON('assets/fish/fish.json'),          // 釣魚：各地形的魚與稀有度
  ]);
  TERRAIN_IDS.forEach((id, i) => S.terrains[id] = tjson[i]);
  Object.assign(S, { furn, floors, animalsDB, npcDB, toolsDB, avatar, fishDB });
  S.floorSizes = new Map(floors.items.map(f => [f.id, { w: f.w || 1, h: f.h || 1 }]));   // 地板占幾格（地毯 2×2，其餘 1×1）
  if (!S.me.weapon) S.me.weapon = S.avatar.weapons?.find(w => w.sprite)?.id || 'hands';
  // 圖片：同樣全部並行（含目前所在地形的圖）。只有角色身體是必要的（缺了畫不出人），其餘缺圖就略過該項
  await Promise.all([
    ...S.floors.items.map(async f => S.floorImgs[f.id] = await optImg(`assets/floors/${f.sprite}`)),
    ...S.animalsDB.animals.map(async a => S.anImgs[a.id] = await optImg(`assets/animals/${a.sprite}`)),
    ...S.toolsDB.tools.map(async t => S.weaponImgs[t.id] = await optImg(`assets/tools/${t.sprite}`)),
    optImg('assets/tombstone.png').then(im => S.tombImg = im),   // 死亡墓碑（島主龍衝打倒後原地出現）
    ...S.furn.items.map(async it => S.furnImgs[it.id] = await optImg(`assets/furniture/${it.sprite}`)),
    ...S.avatar.skins.map(async s => {
      const [a, b, c] = await Promise.all(['a', 'b', 'sit'].map(k => loadImg(`assets/avatar/body_${s.id}_${k}.png`)));
      S.bodyImgs[s.id] = { a, b, c };
    }),
    ...S.avatar.hair.map(async h => {
      const [im, back] = await Promise.all([optImg(`assets/avatar/${h.sprite}`), h.back ? optImg(`assets/avatar/${h.back}`) : null]);
      S.hairImgs[h.id] = im;
      if (back) S.hairBackImgs[h.id] = back;
    }),
    ...S.avatar.weapons.filter(w => w.sprite).map(async w => {
      const im = await optImg(`assets/avatar/${w.sprite}`);
      if (im && w.back === 'hilt') im.hiltUp = true;   // 背在背上時劍柄朝上（drawWeaponBack 看這個旗標）
      S.weaponImgs[w.id] = im;
    }),
    ...Object.values(S.fishDB.terrains).flat().map(async f => S.fishImgs[f.id] = await optImg(`assets/fish/${f.sprite}`)),
    ensureTerrain(S.terrain),
  ]);

  genWorld(S.terrain);
  loadLayout();
  buildTerrainChips();

  S.players = [makePlayer('訪客', { dx: -40, dy: 10 })];
  spawnNPCs();

  fetch('version.json', { cache: 'no-store' }).then(r => r.json()).then(v => { if (v.commit) $('verTag').textContent = v.commit; }).catch(() => {});   // 左上角顯示版本（commit 前 7 碼）

  let last = performance.now();
  function loop(now) {
    if (now - last > 2000) S.net?.requestDragonSnap?.();   // 分頁被凍結過（切視窗回來）：要一份島主即時快照，別用舊位置打人
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    try {
      S.t += dt;
      autoAttack();
      for (const p of S.players) stepPlayer(p, dt);
      if (S.mouseCell && S.mouseClient) {      // 裝飾模式邊走邊擺：鏡頭在動，滑鼠指的格子要跟著重算
        const r = canvas.getBoundingClientRect();
        S.mouseCell = [Math.floor((S.mouseClient[0] - r.left + S.cam.x) / CELL), Math.floor((S.mouseClient[1] - r.top + S.cam.y) / CELL)];
      }
      paintFloor();                            // 地板模式長按中：游標掃過的格子持續鋪/拆
      for (const r of S.remotes.values()) stepRemote(r, dt);
      for (let i = S.animals.length - 1; i >= 0; i--) {
        const a = S.animals[i];
        if (a.dead) {
          a.dieT -= dt;
          if (a.dieT <= 0) {
            S.animals.splice(i, 1);
            if (!a.proxy) S.respawn.push({ id: a.id, at: S.t + (S.animalsDB.respawn || 30) });   // 島主（proxy）重生由伺服器的 spawn 事件驅動
          }
          continue;
        }
        stepAnimal(a, dt);
      }
      for (let i = S.respawn.length - 1; i >= 0; i--) {
        const r = S.respawn[i];
        if (S.t >= r.at) { S.respawn.splice(i, 1); respawnAnimal(r.id); }
      }
      stepDecos(dt); stepDrops(dt);
      for (let i = S.floaters.length - 1; i >= 0; i--) {
        const f = S.floaters[i];
        f.life -= dt;
        if (!f.slash && !f.beam) f.y -= 34 * dt;   // 爪擊/光束特效固定在原座標，不隨飄字上浮
        if (f.life <= 0) S.floaters.splice(i, 1);
      }
      draw();
    } catch (e) { console.error('loop:', e); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.S = S; // debug / discord.js 接線用
  window.toast = toast;
  // 進島只提示歡迎；操作方式看右上「操作說明」或問嚮導
  const welcomeMs = 3000;
  welcomeUntil = performance.now() + welcomeMs;           // 歡迎訊息顯示期間，不讓「已連上島」把它蓋掉
  toast('歡迎來到 DC島！', welcomeMs);
  import('./discord.js').then(m => m.hookDiscord()).catch(err => console.warn('hookDiscord:', err));
  // M2：多人同步（同語音頻道＝同島；本機則 ?room= 或預設 local:local）
  import('./net.js').then(m => m.connectNet(S, {
    onFurn: onNetFurn,
    onFloor: onNetFloor,
    onAdmin: v => { S.admin = !!v; updateDecorUI(); },
    onCommitResult: onCommitResult,
    onDecos: onNetDecos,
    onDeco: onNetDeco,
    onDragon: onNetDragon,   // 島主事件（aim/hp/dead/spawn/state 快照）
    onFishResult,            // 釣魚結果（伺服器抽的魚；登入的人已記進伺服器的圖鑑）
    onDex: dex => { S.dex = dex || {}; S.dexSource = 'server'; if (S.dexOpen) buildDex(); },   // 登入後伺服器送來的圖鑑
    onOpen: net => {
      if (performance.now() >= welcomeUntil) toast(`已連上島（${net.room}）`, 2000);
      // 島主同步：連上（或重連）時人在有島主的地形就補傳陸地位圖（新連線重新算「傳過沒」）
      S.landSent = null;
      uploadLandMap();
    },
  })).catch(err => console.warn('net:', err));
}

boot().catch(err => {
  console.error(err);
  toast('載入失敗：' + err.message);
});
