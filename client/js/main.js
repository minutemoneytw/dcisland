// DC島 M0 — 本地單機 demo（將來改成 Durable Objects 同步）
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

let toastTimer = null;
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------- 全域狀態 ----------------
const TERRAIN_IDS = ['grass', 'beach', 'snow', 'night', 'forest', 'volcano'];
const S = {
  terrain: localStorage.getItem('dcisland.m0.terrain') || 'grass',
  terrains: {},                 // id -> manifest
  tImages: {},                  // id -> {file: Image}
  furn: null, furnImgs: {},
  avatar: null, bodyImgs: {}, hairImgs: {},
  charCache: new Map(),         // key -> {a: canvas, b: canvas}
  me: JSON.parse(localStorage.getItem('dcisland.m0.avatar') || 'null') || { skin: 'light', hair: 'hair1', shirt: 0, weapon: 'sword' },
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
  admin: false,                 // 我是不是管理員（伺服器告知；可以清空擺設）
  draft: [],                    // 裝飾模式未保存的操作
  baseFurn: [],                 // 草稿所依據的擺設（進入裝飾模式時、或最近一次伺服器同步）
  confirmOpen: false,           // 「要保存嗎？」視窗是否開著
  npcDB: null,                  // NPC 對話（assets/npcs/npcs.json）
  toolsDB: null,                // 採集工具與可破壞物件（assets/tools/tools.json）
  drops: [],                    // 地上的掉落物 {item,x,y,born}
  inv: JSON.parse(localStorage.getItem('dcisland.m0.inv') || '{}'),   // 背包：物品id -> 數量
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
const ATK_CD = 0.45, ATK_T = 0.22, ATK_RANGE = 58;
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
  const tgt = decoTarget(d), [bx, by] = decoBase(d), r = decoRect(d);
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
    localStorage.setItem('dcisland.m0.inv', JSON.stringify(S.inv));
    toast(`獲得 ${S.toolsDB.items[dr.item].name} ×1（共 ${S.inv[dr.item]}）`, 1600);
  }
}

function doAttack(auto) {
  const p = S.players[0];
  S._hits = 0;
  if (S.mode !== 'walk') return;
  if (p.pose) {   // 坐著/睡著不能揮擊；按 F（不是長按的自動重複）就起身
    if (auto && !quiet) { standUp(p); S.holdSkipF = true; }
    return;
  }
  if (auto) {   // F 鍵：前方有可破壞物件就自動用對應工具
    const d = decoNear(p);
    if (d) { S._hits = 1; useTool(d); return; }
    const seat = quiet ? null : seatNear(p);   // 身邊有椅子/沙發/床就坐下（長按自動連擊不會反覆切換）
    if (seat) { S._hits = 1; usePose(seat); S.holdSkipF = true; return; }
    const npc = quiet ? null : npcNear(p);       // 身邊有 NPC 就跟他說話
    if (npc) { S._hits = 1; talkTo(npc); S.holdSkipF = true; return; }
  }
  if (S.me.weapon === 'hands') { say('先在「造型」裡裝備武器！'); return; }
  if (!S.weaponImgs[S.me.weapon]) return;
  if (S.t - p.lastAtk < ATK_CD) return;
  p.lastAtk = S.t; p.swing = ATK_T; p.tool = null;
  S.net?.notifyAttack?.();          // M2：讓同島的人看到你的揮擊
  for (const a of S.animals) {
    if (a.dead) continue;
    const dx = a.x - p.x, dy = a.y - p.y, dist = Math.hypot(dx, dy);
    if (dist > ATK_RANGE || dist < 1) continue;
    if ((dx * p.dir) / dist < .15) continue; // 只有前方扇形
    S._hits++;
    const crit = Math.random() < .18;
    const dmg = crit ? 2 : 1;
    a.hp -= dmg; a.startle = 1; a.startleT = 3; a.target = null; a.idle = 0;
    S.floaters.push({ x: a.x + (Math.random() * 24 - 12), y: a.y - 42, v: String(dmg), life: .8, crit });
    a.target = fleeTarget(a, animalDef(a.id), p.x, p.y, 220);
    if (a.hp <= 0) {
      a.dead = true; a.dieT = .6;
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
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

function stepAnimal(a, dt) {
  const def = animalDef(a.id);
  // 只有「附近有人揮擊」才會被嚇到（自己或同島的人）；單純走過去、站在旁邊不會嚇跑牠
  if (S.t - (a.scaredAt ?? -9) > .4) {
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

function charSprite(skin, hairId, shirtIdx, frame) {   // frame：0/1 走路兩幀、2 坐姿
  const shirtHex = S.avatar.shirtColors[shirtIdx];
  const k = `${skin}|${hairId}|${shirtHex}`;
  let entry = S.charCache.get(k);
  if (!entry) entry = {};
  const fk = 'abc'[frame] || 'a';
  if (entry[fk]) return entry[fk];
  const src = S.bodyImgs[skin][fk];
  const cv = document.createElement('canvas'); cv.width = 16; cv.height = 24;
  const g = cv.getContext('2d');
  // 上衣換色
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, 16, 24), p = d.data;
  const [br, bg, bb] = hexRGB(S.avatar.recolor.shirtBase);
  const [sr, sg, sb] = hexRGB(S.avatar.recolor.shirtShadeBase);
  const [tr, tg, tb] = hexRGB(shirtHex);
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gg = p[i + 1], b = p[i + 2], a = p[i + 3];
    if (a === 0) continue;
    if (r === br && gg === bg && b === bb) { p[i] = tr; p[i + 1] = tg; p[i + 2] = tb; }
    else if (r === sr && gg === sg && b === sb) {
      p[i] = tr * .78 | 0; p[i + 1] = tg * .78 | 0; p[i + 2] = tb * .78 | 0;
    }
  }
  g.putImageData(d, 0, 0);
  const hair = S.hairImgs[hairId]; if (hair) g.drawImage(hair, 0, fk === 'c' ? 3 : 0);   // 坐姿的頭整體下移 3 列，頭髮跟著下移
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
  };
}

function playerSpriteDiv(p, frame) {
  // NPC 與遠端玩家都有自己的 look；自己（players[0]）則用當前造型
  if (p.look) return charSprite(p.look.skin, p.look.hair, p.look.shirt, frame);
  return charSprite(S.me.skin, S.me.hair, S.me.shirt, frame);
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
  r.z += ((r.tz ?? r.z) - r.z) * Math.min(1, dt * 12);
}

function stepPlayer(p, dt) {
  if (p.npc) { stepNPC(p, dt); return; }
  if (p.pose) {   // 坐/睡：不動；按移動鍵或跳躍就起身（也會一路走出去），家具被拿走也會起身
    const wantsMove = keys['a'] || keys['arrowleft'] || keys['d'] || keys['arrowright'] || keys['w'] || keys['arrowup'] || keys['s'] || keys['arrowdown'] || keys[' '];
    if (!seatItem(p) || wantsMove) standUp(p);
    else { p.moving = false; p.frame = 0; p.z = 0; p.vz = 0; return; }
  }
  let dx = 0, dy = 0;
  // 走路與裝飾模式都能移動（裝飾模式要邊走邊擺）
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  p.moving = dx !== 0 || dy !== 0;
  if (p.moving) {
    if (dx !== 0) p.dir = dx;
    const len = Math.hypot(dx, dy) || 1, sp = (keys['shift'] ? 200 : 120) * dt;
    const nx = clamp(p.x + dx / len * sp, 8, COLS * CELL - 8);
    const ny = clamp(p.y + dy / len * sp, 8, ROWS * CELL - 8);
    // 裝飾模式可穿過擺飾（避免被卡住）；已經被家具圍住/壓在家具上時（例如別人把家具擺在你腳下）也一樣可以走出來。水邊照樣擋
    const ig = S.mode === 'decor' || (blocked(p.x, p.y) && !blocked(p.x, p.y, true));
    if (!blocked(nx, p.y, ig)) p.x = nx;
    if (!blocked(p.x, ny, ig)) p.y = ny;
  }
  // 跳躍（裝飾模式不跳）
  if (S.mode === 'walk' && keys[' '] && p.z === 0 && p.vz === 0) p.vz = 240;
  if (p.z > 0 || p.vz > 0) {
    p.z += p.vz * dt; p.vz -= 780 * dt;
    if (p.z <= 0) { p.z = 0; p.vz = 0; }
  }
  if (p.swing > 0) p.swing -= dt;
  if (p.tool && S.t > p.toolUntil && !(p.swing > 0)) p.tool = null;
  if (p.moving) { p.animT += dt; if (p.animT > .16) { p.animT = 0; p.frame ^= 1; } }
  else p.frame = 0;
}

function stepNPC(p, dt) {
  if (p.idle > 0) { p.idle -= dt; p.moving = false; p.frame = 0; return; }
  if (!p.target || Math.hypot(p.target.x - p.x, p.target.y - p.y) < 4) {
    // 換目標
    for (let t = 0; t < 24; t++) {
      const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
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
    const img = playerSpriteDiv(p, pose ? 2 : (p.frame === 1 ? 1 : 0));
    ctx.save(); ctx.translate(p.x, p.y - p.z);
    if (p.dir < 0) ctx.scale(-1, 1);
    // 武器（背在肩上 / 揮擊時畫在身前）；坐著時不拿
    if (wi && !pose && !(p.swing > 0)) drawWeaponBack(wi);
    ctx.drawImage(img, -16, -48, 32, 48);
    if (wi && !pose && p.swing > 0) drawWeaponSwing(wi, p.swing);
    ctx.restore();
    if (pose) nameY = p.y - 46;
  }
  // 名牌（FFXIV 感：白字黑邊）
  ctx.font = '10px "Microsoft JhengHei"';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.8)';
  ctx.strokeText(p.name, p.x, nameY);
  ctx.fillStyle = nameColor;
  ctx.fillText(p.name, p.x, nameY);
  if (p.say && S.t < p.say.until) drawBubble(p.x, nameY - 14, p.say.text, Math.min(1, (p.say.until - S.t) / .4));
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
  let line;
  do { line = db.lines[Math.floor(Math.random() * db.lines.length)]; } while (db.lines.length > 1 && line === n.lastLine);   // 不連續說同一句
  n.lastLine = line;
  n.say = { text: line, until: S.t + db.duration };
  n.idle = db.duration + .5; n.moving = false; n.target = null;      // 停下來說話，面向玩家
  if (Math.abs(me.x - n.x) > 6) n.dir = Math.sign(me.x - n.x);
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
  if (p.pose) {   // 已經坐/睡著：再點同一件＝起身；點別件＝先起身再去
    const same = p.seat.type === it.type && p.seat.cell[0] === it.cell[0] && p.seat.cell[1] === it.cell[1];
    standUp(p);
    if (same) return;
  }
  const cx = (it.cell[0] + def.w / 2) * CELL, cy = (it.cell[1] + def.h / 2) * CELL;
  if (Math.hypot(cx - p.x, cy - p.y) > 80) { say(`靠近一點再${def.use === 'sit' ? '坐' : '躺'}`); return; }
  const sx = cx, sy = (it.cell[1] + def.h) * CELL - (def.use === 'sit' ? 2 : 0);
  for (const r of S.remotes.values()) if (r.pose && Math.abs(r.x - sx) < 10 && Math.abs(r.y - sy) < 10) { say('這裡有人了'); return; }
  p.pose = def.use; p.seat = { type: it.type, cell: [it.cell[0], it.cell[1]] }; p.seatType = it.type;
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

// ---------------- 繪製 ----------------
// 武器（ctx 已 translate 到角色腳底並依 dir 翻轉）。素材：刀刃在上、握柄在下。
// 沒揮擊：背在肩後（畫在身體之前，被身體擋住一部分）
function drawWeaponBack(wi) {
  ctx.save(); ctx.translate(-11, -26); ctx.rotate(-.55);
  ctx.drawImage(wi, -wi.width, -wi.height / 2, wi.width * 2, wi.height * 2); ctx.restore();
}
// 揮擊：握住劍柄（以握把為轉軸）、刀刃朝外，由後上方往前下方揮，畫在身體之後（身前）
function drawWeaponSwing(wi, swing) {
  const q = 1 - swing / ATK_T;
  ctx.save(); ctx.translate(3, -26); ctx.rotate(-.9 + q * 2.8);
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
        const shs = 1 - Math.min(.5, a.z / 60);
        ctx.fillStyle = `rgba(10,14,20,${.26 * shs + .03})`;
        ctx.beginPath(); ctx.ellipse(a.x, a.y + 1, 9 * shs, 3 * shs, 0, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(a.x, a.y - a.z);
        if (a.dead) {  // 死亡：縮小旋轉淡出
          const q = 1 - a.dieT / .6;
          ctx.globalAlpha = Math.max(0, 1 - q * 1.2);
          ctx.rotate(q * 1.1); ctx.scale(1 - q * .3, 1 - q * .3);
        }
        if (a.dir < 0) ctx.scale(-1, 1);
        ctx.drawImage(img, -img.width, -img.height * 2, img.width * 2, img.height * 2);
        ctx.restore();
        if (a.dead) return;
        // HP 小條（受過傷才顯示）
        if (a.hp < a.maxHp) {
          ctx.fillStyle = 'rgba(8,10,14,.7)'; ctx.fillRect(a.x - 11, a.y - a.z - 16, 22, 4);
          ctx.fillStyle = a.hp / a.maxHp > .4 ? '#7ac86c' : '#e07a68';
          ctx.fillRect(a.x - 10, a.y - a.z - 15, 20 * (a.hp / a.maxHp), 2);
        }
        // 驚嚇符號（FF14 「!」）
        if (a.startle && (S.t * 6 | 0) % 2 === 0) {
          ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
          ctx.fillStyle = '#e8c23a'; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.lineWidth = 3;
          ctx.strokeText('!', a.x, a.y - a.z - 26); ctx.fillText('!', a.x, a.y - a.z - 26);
        }
        // 小名牌
        ctx.font = '9px "Microsoft JhengHei"'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.75)';
        ctx.strokeText(def.name, a.x, a.y - a.z - 34);
        ctx.fillStyle = a.startle ? '#e8b2a2' : '#cfd8c8';
        ctx.fillText(def.name, a.x, a.y - a.z - 34);
      }
    });
  }
  for (const p of S.players) {
    list.push({
      y: p.y + (p.pose ? 2 : 0),      // 坐著/睡著的人要畫在自己的椅子/床之後（排序鍵比家具大一點）
      draw: () => {
        const wid = p.tool || S.me.weapon;      // 打石頭/樹木時暫時換成鎬子/斧頭
        const wi = !p.npc && wid !== 'hands' ? S.weaponImgs[wid] : null;
        drawPerson(p, wi, p.npc ? '#bcd8e8' : '#ffffff');
      }
    });
  }
  // M2：同島的其他玩家
  for (const r of S.remotes.values()) {
    list.push({
      y: r.y + (r.pose ? 2 : 0),
      draw: () => drawPerson(r, r.weapon && r.weapon !== 'hands' ? S.weaponImgs[r.weapon] : null, '#ffe9a8')   // 同島的人用暖金色名牌區分
    });
  }
  list.sort((a, b) => a.y - b.y).forEach(o => o.draw());

  // 裝飾模式 ghost
  if (S.mode === 'decor' && S.mouseCell && S.sel) {
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
    ctx.save(); ctx.translate(f.x, f.y);
    if (f.poof) {
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
  localStorage.setItem('dcisland.m0.layout.' + S.terrain, JSON.stringify(S.furnItems));
}
function loadLayout() {
  if (netOn()) { applyFurn(S.netFurn); return; }
  try { S.furnItems = JSON.parse(localStorage.getItem('dcisland.m0.layout.' + S.terrain)) || []; }
  catch { S.furnItems = []; }
  rebuildOcc();
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
const cloneFurn = list => list.map(it => ({ type: it.type, cell: [it.cell[0], it.cell[1]] }));
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
  S.mode = 'decor'; S.draft = []; S.baseFurn = cloneFurn(S.furnItems);
  $('btnDecor').classList.add('active'); $('furnPanel').classList.remove('hidden');
  S.sel = S.sel || S.furn.items[0].id; buildFurnPanel(); updateDecorUI();
  toast('裝飾模式：左鍵放置／右鍵移除（按「完成」才會保存）', 2600);
}
function exitDecor(save) {
  const n = S.draft.length;
  if (n && save) {
    if (netOn()) for (let i = 0; i < n; i += 80) S.net.commitFurn(S.draft.slice(i, i + 80));   // 結果以伺服器廣播的清單為準
    else saveLayout();
  } else if (n) {                                  // 不保存：回到進入裝飾模式（或最近一次同步）時的樣子
    S.furnItems = cloneFurn(S.baseFurn); rebuildOcc();
  }
  S.mode = 'walk'; S.draft = []; closeConfirm();
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
    S.terrain = id; localStorage.setItem('dcisland.m0.terrain', id);
    S.remotes.clear();                          // 換了地形，原地形的人都看不到了
    if (netOn()) S.netFurn = [];                // 等伺服器送該地形的擺設
    genWorld(id); loadLayout();
    // 留在原地（切地形不該把人吸到出生點）
    const me = S.players[0];
    const [nx, ny] = landNear(me.x, me.y);
    me.x = nx; me.y = ny;
    buildTerrainChips();
    toast(`${S.terrains[id].name} 島上線`);
    // M2：只有自己過去；告訴伺服器，讓新地形的人看到你、舊地形的人看不到你
    S.net?.enter?.(id);
  } catch (e) {
    // 不要靜默失敗：讓玩家看得到，也回報到伺服器日誌
    toast(`切換${id}失敗：${e.message || e}`, 4000);
    reportError('terrain-switch', id + ' | ' + (e.stack || e.message || e));
    console.error('switchTerrain', id, e);
  }
}

function buildFurnPanel() {
  const box = $('furnList'); box.innerHTML = '';
  for (const it of S.furn.items) {
    const div = document.createElement('div');
    div.className = 'fitem' + (S.sel === it.id ? ' sel' : '');
    const cv = document.createElement('canvas');
    const img = S.furnImgs[it.id];
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
  const sh = $('shirtOpts'); sh.innerHTML = '';
  S.avatar.shirtColors.forEach((hex, i) => {
    const o = document.createElement('div');
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
function saveAvatar() { localStorage.setItem('dcisland.m0.avatar', JSON.stringify(S.me)); }



// ---------------- 輸入 ----------------
const keys = {};
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (S.confirmOpen) { if (k === 'escape') closeConfirm(); return; }   // 「要保存嗎？」開著時：Esc＝繼續編輯，其他鍵不處理
  if (k === 'e' && !e.repeat) { if (S.mode === 'walk') enterDecor(); else if (S.mode === 'decor') requestExitDecor(); }
  if (k === 'escape' && S.mode === 'decor') requestExitDecor();     // Esc 也能離開裝飾模式
  if (k === 'f' && !e.repeat) doAttack(true);
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; if (e.key.toLowerCase() === 'f') S.holdSkipF = false; });
// 切走視窗時放開所有按住的鍵，避免卡住一直揮擊/走路
addEventListener('blur', () => { for (const k in keys) keys[k] = false; S.mouseHeld = false; });
addEventListener('mouseup', e => { if (e.button === 0) S.mouseHeld = false; });

canvas.addEventListener('mousemove', e => {
  S.mouseClient = [e.clientX, e.clientY];     // 長按左鍵時，鏡頭/角色移動後仍要用最新的游標位置
  const r = canvas.getBoundingClientRect();
  S.mouseCell = [Math.floor((e.clientX - r.left + S.cam.x) / CELL), Math.floor((e.clientY - r.top + S.cam.y) / CELL)];
});
canvas.addEventListener('mouseleave', () => S.mouseCell = null);
// 左鍵攻擊（世界座標 wx,wy 是游標指的位置）：先面向游標方向再揮
function clickAttack(wx, wy) {
  // 點到可坐/可睡的家具（椅子、沙發、床）→ 坐下/躺下；再點一次起身。長按自動連擊時不處理，避免反覆切換
  if (!quiet) {
    const f = furnAtPoint(wx, wy);
    if (f && furnitureDef(f.type)?.use) { usePose(f); return; }
    const n = npcAt(wx, wy);
    if (n) { talkTo(n); return; }                // 點 NPC：跟他說話（不是攻擊）
  }
  if (S.players[0].pose) return;                 // 坐著/睡著不能揮擊
  // 點到可破壞物件（且那裡沒有動物）→ 自動換工具去打它
  if (!S.animals.some(a => !a.dead && Math.hypot(a.x - wx, a.y - wy) < 30)) {
    const d = decoAt(wx, wy);
    if (d) { useTool(d); return; }
  }
  if (Math.abs(wx - S.players[0].x) > 6) S.players[0].dir = Math.sign(wx - S.players[0].x);
  doAttack();
  // 沒命中但點到了一隻動物 → 牠的致公告告（FF14 點動物 FU）
  if (!S._hits) {
    for (const a of S.animals) {
      if (!a.dead && Math.hypot(a.x - wx, a.y - wy) < 30) {
        say(animalDef(a.id).line, 2200);
        break;
      }
    }
  }
}
// 長按 F 或左鍵：冷卻一到就自動再揮（每幀呼叫；第一下由按下事件負責，之後這裡接手）
function autoAttack() {
  if (S.mode !== 'walk' || S.players[0].pose || S.t - S.players[0].lastAtk < ATK_CD) return;
  quiet = true;
  try {
    if (S.mouseHeld && S.mouseClient) {
      const r = canvas.getBoundingClientRect();
      clickAttack(S.mouseClient[0] - r.left + S.cam.x, S.mouseClient[1] - r.top + S.cam.y);
    } else if (keys['f'] && !S.holdSkipF) doAttack(true);     // F 剛拿來坐下/起身時，按住不放不要接著揮劍
  } finally { quiet = false; }
}
canvas.addEventListener('mousedown', e => {
  if (e.button !== 0 || S.confirmOpen) return;
  if (S.mode === 'walk') {
    const r = canvas.getBoundingClientRect();
    S.mouseHeld = true; S.mouseClient = [e.clientX, e.clientY];
    clickAttack(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y);
    return;
  }
  if (S.mode !== 'decor' || !S.mouseCell || !S.sel) return;
  const [x, y] = S.mouseCell;
  if (S.draft.length >= 300) { toast('未保存的變動太多了，請先按「完成」保存'); return; }
  if (canPlace(S.sel, x, y)) { stageOp({ t: 'place', type: S.sel, cell: [x, y] }); toast('放置'); }
  else toast('這裡放不下（水邊／已占用）');
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.confirmOpen) return;
  if (S.mode === 'walk') {   // 右鍵和左鍵一樣：點椅子/沙發/床就坐下/躺下，再點一次起身
    const r = canvas.getBoundingClientRect();
    const f = furnAtPoint(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y);
    if (f && furnitureDef(f.type)?.use) usePose(f);
    else { const n = npcAt(e.clientX - r.left + S.cam.x, e.clientY - r.top + S.cam.y); if (n) talkTo(n); }
    return;
  }
  if (S.mode !== 'decor' || !S.mouseCell) return;
  const [x, y] = S.mouseCell;
  const idx = S.occ.get(key(x, y));
  if (idx !== undefined) { stageOp({ t: 'remove', cell: [x, y] }); toast('收起擺設'); }
});

$('btnDecor').onclick = () => { if (S.mode === 'walk') enterDecor(); else requestExitDecor(); };
$('furnClose').onclick = () => exitDecor(true);                // 完成＝保存並離開
$('furnCancel').onclick = () => exitDecor(false);              // 取消變動＝不保存並離開
$('cfSave').onclick = () => exitDecor(true);
$('cfDiscard').onclick = () => exitDecor(false);
$('cfKeep').onclick = closeConfirm;
$('furnClear').onclick = () => {
  if (!canClear()) { toast('清空需要管理員權限'); return; }
  stageOp({ t: 'clear' }); toast('已清空（按「完成」才會保存，「取消變動」可還原）', 2600);
};

$('btnAvatar').onclick = () => { $('avatarPanel').classList.toggle('hidden'); buildAvatarPanel(); };
$('avatarClose').onclick = () => $('avatarPanel').classList.add('hidden');

// ---------------- 資源載入 ----------------
async function ensureTerrain(id) {
  if (S.tImages[id]) return;
  const man = S.terrains[id];
  const files = new Set([man.ground, man.edge, man.water]);
  for (const d of man.deco) files.add(d.sprite);
  const ims = {};
  await Promise.all([...files].map(async f => ims[f] = await loadImg(`assets/terrain/${id}/${f}`)));
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
  // manifest
  const tjson = await Promise.all(TERRAIN_IDS.map(id => loadJSON(`assets/terrain/${id}/terrain.json`)));
  TERRAIN_IDS.forEach((id, i) => S.terrains[id] = tjson[i]);
  S.furn = await loadJSON('assets/furniture/furniture.json');
  // 小動物（FF14 致敬）
  S.animalsDB = await loadJSON('assets/animals/animals.json');
  await Promise.all(S.animalsDB.animals.map(async a => S.anImgs[a.id] = await loadImg(`assets/animals/${a.sprite}`)));
  // 採集工具（鎬子/斧頭）：圖放進 weaponImgs，讓繪製與遠端玩家共用同一套武器繪製
  S.npcDB = await loadJSON('assets/npcs/npcs.json');
  S.toolsDB = await loadJSON('assets/tools/tools.json');
  await Promise.all(S.toolsDB.tools.map(async t => S.weaponImgs[t.id] = await loadImg(`assets/tools/${t.sprite}`)));
  S.avatar = await loadJSON('assets/avatar/avatar.json');
  if (!S.me.weapon) S.me.weapon = S.avatar.weapons?.find(w => w.sprite)?.id || 'hands';
  // 家具圖
  await Promise.all(S.furn.items.map(async it => S.furnImgs[it.id] = await loadImg(`assets/furniture/${it.sprite}`)));
  // 角色圖
  await Promise.all(S.avatar.skins.map(async s => {
    S.bodyImgs[s.id] = {
      a: await loadImg(`assets/avatar/body_${s.id}_a.png`),
      b: await loadImg(`assets/avatar/body_${s.id}_b.png`),
      c: await loadImg(`assets/avatar/body_${s.id}_sit.png`),
    };
  }));
  await Promise.all(S.avatar.hair.map(async h => S.hairImgs[h.id] = await loadImg(`assets/avatar/${h.sprite}`)));
  await Promise.all(S.avatar.weapons.filter(w => w.sprite).map(async w => S.weaponImgs[w.id] = await loadImg(`assets/avatar/${w.sprite}`)));

  await ensureTerrain(S.terrain);
  genWorld(S.terrain);
  loadLayout();
  buildTerrainChips();

  const looks = [
    { skin: 'pale', hair: 'hair3', shirt: 3 },
    { skin: 'tan', hair: 'hair2', shirt: 1 },
    { skin: 'deep', hair: 'hair1', shirt: 2 },
  ];
  S.players = [
    makePlayer('我', { dx: -40, dy: 10 }),
    makePlayer('訪客・波特', { look: looks[0], npc: true, dx: 52, dy: -8 }),
    makePlayer('訪客・ ooops', { look: looks[1], npc: true, dx: -10, dy: 64 }),
    makePlayer('會長', { look: looks[2], npc: true, dx: 74, dy: 48 }),
  ];

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    try {
      S.t += dt;
      autoAttack();
      for (const p of S.players) stepPlayer(p, dt);
      if (S.mouseCell && S.mouseClient) {      // 裝飾模式邊走邊擺：鏡頭在動，滑鼠指的格子要跟著重算
        const r = canvas.getBoundingClientRect();
        S.mouseCell = [Math.floor((S.mouseClient[0] - r.left + S.cam.x) / CELL), Math.floor((S.mouseClient[1] - r.top + S.cam.y) / CELL)];
      }
      for (const r of S.remotes.values()) stepRemote(r, dt);
      for (let i = S.animals.length - 1; i >= 0; i--) {
        const a = S.animals[i];
        if (a.dead) {
          a.dieT -= dt;
          if (a.dieT <= 0) { S.animals.splice(i, 1); S.respawn.push({ id: a.id, at: S.t + (S.animalsDB.respawn || 30) }); }
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
        f.life -= dt; f.y -= 34 * dt;
        if (f.life <= 0) S.floaters.splice(i, 1);
      }
      draw();
    } catch (e) { console.error('loop:', e); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.S = S; // debug / discord.js 接線用
  window.toast = toast;
  // 第一次來（這個瀏覽器沒看過）：多提示一次怎麼互動；之後只顯示簡短歡迎
  let first = true;
  try { first = !localStorage.getItem('dcisland.m0.seen'); localStorage.setItem('dcisland.m0.seen', '1'); } catch { /* 無痕等：當作第一次 */ }
  const welcomeMs = first ? 7000 : 3000;
  welcomeUntil = performance.now() + welcomeMs;           // 歡迎訊息顯示期間，不讓「已連上島」把它蓋掉
  if (first) toast('歡迎來到 DC島！左鍵／F 鍵互動（攻擊、採集、坐下、聊天）・WASD 走動・Shift 跑・Space 跳・E 裝飾', welcomeMs);
  else toast('歡迎來到 DC島！WASD 走動・Shift 跑・Space 跳・左鍵/F 攻擊・E 裝飾', welcomeMs);
  import('./discord.js').then(m => m.hookDiscord()).catch(err => console.warn('hookDiscord:', err));
  // M2：多人同步（同語音頻道＝同島；本機則 ?room= 或預設 local:local）
  import('./net.js').then(m => m.connectNet(S, {
    onFurn: onNetFurn,
    onAdmin: v => { S.admin = !!v; updateDecorUI(); },
    onCommitResult: onCommitResult,
    onDecos: onNetDecos,
    onDeco: onNetDeco,
    onOpen: net => { if (performance.now() >= welcomeUntil) toast(`已連上島（${net.room}）`, 2000); },
  })).catch(err => console.warn('net:', err));
}

boot().catch(err => {
  console.error(err);
  toast('載入失敗：' + err.message);
});
