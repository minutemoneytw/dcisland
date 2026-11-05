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
const TERRAIN_IDS = ['grass', 'beach', 'snow', 'night', 'forest', 'volcano', 'machine'];
const S = {
  terrain: (t => TERRAIN_IDS.includes(t) ? t : 'grass')(lsRaw('dcisland.m0.terrain')),   // 舊資料是純字串（非 JSON）
  terrains: {},                 // id -> manifest
  tImages: {},                  // id -> {file: Image}
  furn: null, furnImgs: {},
  avatar: null,
  charImgs: {},                 // 人物分層 sheet：檔名 -> Image（軀幹／頭髮／衣服／褲子／帽子）
  charCache: new Map(),         // (造型, 幀號) -> 合成好的一幀
  recolorCache: new Map(),      // (sheet, 顏色) -> 換好色的整張 sheet
  me: lsObj('dcisland.m0.avatar', null) || { skin: 'light', hair: 'hair1', shirt: 0, weapon: 'sword' },
  world: null,                  // {types: Uint8Array, decos: []}
  furnItems: [],                // [{type, cell:[x,y]}]
  occ: new Map(),               // "x,y" -> furniture index
  players: [],
  mobs: [],                     // 會動的非玩家生物（mobs）：FF14 致敬小動物、各島島主；資料在 assets/mobs/mobs.json
  mobsDB: null, mobImgs: {},
  mobAnims: {},                  // 多幀動畫（mobs.json 的 anim）：id -> {img, frames, fps, dashFps, scale, fw, fh}
  mode: 'walk', sel: null,
  mouseCell: null,
  t: 0,
  cam: { x: 0, y: 0 },
  respawn: [],                  // 動物重生佇列 [{id, at}]
  floaters: [],                 // 傷害飄字 {x,y,v,life,poof}
  weaponImgs: {},
  ownerSayIdx: {},              // 照順序說台詞的島主（ownerLinesSeq）目前說到第幾句，key＝島主 id
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
  titlesDB: { titles: [] },            // 稱號清單（assets/titles/titles.json，手寫）
  titleBook: lsObj('dcisland.m0.titles', {}),   // 稱號的本機紀錄：kills＝參與擊倒過的島主 {mob id: 1}；known＝已經提示過解鎖的稱號 id（避免重複跳提示）
  titleOpen: false,                    // 稱號一覽視窗是否開著
  ownerHitAt: {},                      // 自己最後一次打到各島主的時刻（S.t；「參與擊倒」＝島主倒下前 TITLE_ASSIST 秒內打過）
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
  spawnMobs();
}

// ---- FF14 致敬野生動物 ----
function mobDef(id) { return S.mobsDB.mobs.find(x => x.id === id); }

// ---- 可動畫的圖（sprite 描述）：地形磚、點綴物、家具、地板、動物共用 ----
// 每種圖都可以在 manifest 加 anim（等寬水平 sheet，由左至右循環）：
//   sheet（相對 client/assets/）、frames（幀數）、fps（每秒幾幀，預設 8）、keyBg（從圖邊去掉背景色，給不是透明底的素材）、
//   stagger（地形磚／地板：各格錯開不同幀，預設整張地圖同步）；動物另有 dashFps、scale（見 loadAnim）
// 沒有 anim＝單張圖＝1 幀的 sheet，畫法完全相同；之後只要準備 sheet、在 manifest 加 anim，不用改程式。
// 描述物件：{img, frames, fps, stagger, fw, fh, width, height}；width/height＝單幀大小（讓原本讀「圖片大小」的程式不用改）
function makeSpr(img, spec) {
  const frames = Math.max(1, (spec && spec.frames | 0) || 1), fw = Math.floor(img.width / frames), fh = img.height;
  return { img: spec?.keyBg ? keyBackground(img) : img, frames, fps: spec?.fps || 8, stagger: !!spec?.stagger, fw, fh, width: fw, height: fh };
}
// 載入一張可動畫的圖：manifest 有 anim.sheet 就載 sheet（失敗退回單張 url），否則載單張
async function loadSpr(url, spec) {
  if (spec?.sheet) {
    const sh = await optImg(`assets/${spec.sheet}`);
    if (sh) return makeSpr(sh, spec);
  }
  const im = await optImg(url);
  return im ? makeSpr(im, spec?.sheet ? null : spec) : null;
}
// 第幾幀：依遊戲時間循環；phase＝起始相位（秒），讓同種的東西不會一起動；fps 可覆寫（動物龍衝時）
function sprFrame(s, phase = 0, fps = s.fps) {
  return s.frames > 1 ? Math.floor((S.t + phase) * fps) % s.frames : 0;
}
// 畫第 fi 幀（ctx 座標）
function drawSpr(s, fi, dx, dy, dw = s.fw, dh = s.fh) {
  ctx.drawImage(s.img, fi * s.fw, 0, s.fw, s.fh, dx, dy, dw, dh);
}
// 依格子決定的固定相位（地形點綴物、家具：各自錯開，但每個人畫面一樣、重新整理也不變）
const cellPhase = (x, y) => ((x * 7 + y * 13) % 29) * .137;

// 動物多幀動畫（mobs.json 的 anim）：除了共通欄位，還有 dashFps（龍衝／飛行時）與 scale（1 個 sheet 像素畫幾 px，只管外觀）
function loadAnim(sheet, spec) {
  return { ...makeSpr(sheet, spec), dashFps: spec.dashFps || spec.fps || 8, scale: spec.scale || 2 };
}
// 去背：素材不是透明底時，從圖的四邊開始，把和角落顏色相近且連在一起的像素變透明（被輪廓線圍住的亮色不會被吃掉）
function keyBackground(img) {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const W = cv.width, H = cv.height, im = g.getImageData(0, 0, W, H), d = im.data;
  const kr = d[0], kg = d[1], kb = d[2], TOL = 28;
  const isBg = i => d[i + 3] === 0 || (Math.abs(d[i] - kr) <= TOL && Math.abs(d[i + 1] - kg) <= TOL && Math.abs(d[i + 2] - kb) <= TOL);
  const seen = new Uint8Array(W * H), stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p] || !isBg(p * 4)) continue;
    seen[p] = 1; d[p * 4 + 3] = 0;
    const x = p % W;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (p >= W) stack.push(p - W);
    if (p < W * (H - 1)) stack.push(p + W);
  }
  g.putImageData(im, 0, 0);
  return cv;
}
// 現在該畫第幾幀：依遊戲時間循環；龍衝／飛行中用 dashFps（拍得比較快）。每隻動物有自己的起始相位，不會整群同步拍動
function animFrame(a, an) {
  a.animPhase ??= Math.random() * 10;
  return sprFrame(an, a.animPhase, a.fly ? an.dashFps : an.fps);
}

function spawnMobs() {
  S.mobs = [];
  const td = S.terrains[S.terrain];
  if (!S.mobsDB || !td.mobs?.length) return;
  const pool = [];
  for (const a of td.mobs) for (let i = 0; i < a.weight; i++) pool.push(a.id);
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  for (let n = 0; n < 6; n++) {
    const id = pool[Math.floor(Math.random() * pool.length)];
    for (let tries = 0; tries < 40; tries++) {
      const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
      if (S.world.types[y * COLS + x] !== 2) continue;
      if (Math.abs(x - cx) < 2 && Math.abs(y - cy) < 2) continue;
      if (S.occ.get(key(x, y)) !== undefined) continue;
      S.mobs.push({ id, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: Math.random() * 2, startle: 0, z: 0, bounce: 0,
                       hp: mobDef(id).hp, maxHp: mobDef(id).hp, dead: false, dieT: 0 });
      break;
    }
  }
  // 島主：terrain.json 的 owner 指定的動物，每座地形固定一隻（不會被嚇跑、被打倒會重生；攻擊方式照 mobs.json 的 atk）
  // 連線時島主由伺服器同步（進場快照與事件），只在單機時本地生成
  const odef = td.owner && mobDef(td.owner);
  if (odef && !netOn()) for (let tries = 0; tries < 40; tries++) {
    const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
    if (S.world.types[y * COLS + x] !== 2) continue;
    if (Math.abs(x - cx) < 5 && Math.abs(y - cy) < 4) continue;   // 大隻的，出生點周圍留空
    if (S.occ.get(key(x, y)) !== undefined) continue;
    S.mobs.push({ id: td.owner, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: Math.random(), startle: 0, z: 0, bounce: 0,
                     hp: odef.hp, maxHp: odef.hp, dead: false, dieT: 0 });
    break;
  }
}

function respawnMob(id) {
  const def = mobDef(id);
  for (let tries = 0; tries < 60; tries++) {
    const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
    if (S.world.types[y * COLS + x] !== 2) continue;
    if (Math.hypot(x * CELL - S.players[0].x, y * CELL - S.players[0].y) < 8 * CELL) continue; // 離玩家遠一點
    S.mobs.push({ id, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: 1.2, startle: 0, z: 0, bounce: 0,
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
const inHit = (p, a) => { const w = weaponPt(p); return Math.hypot(a.x - w.x, a.y - w.y) <= hitRadius(mobDef(a.id)); };
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
    const rg0 = rangedDef();
    const own = S.mobs.find(a => {
      const od = mobDef(a.id);
      return od?.owner && !a.dead && !a.fly && (rg0 ? inCastRange(p, a, rg0) : inHit(p, a));
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
  if (S.fx.seal) { if (!quiet) say('結印中，不能攻擊', 900); return; }
  if (p.leap) return;   // 跳躍中不能攻擊   // 忍術結印中（可移動、不能攻擊）
  if (isRod()) { S._hits = 1; if (!quiet) fishAction(wx, wy); return; }   // 拿著釣竿：拋竿（不能攻擊）
  if (S.me.weapon === 'hands') { say('先用左上角的武器列裝備武器！'); return; }
  if (!S.weaponImgs[S.me.weapon]) return;
  if (S.t - p.lastAtk < ATK_CD) return;
  const rg = rangedDef();
  if (rg) { startCast(p, rg, wx, wy); return; }   // 法杖：遠距詠唱（以滑鼠瞄準，讀條完才出傷害）
  p.lastAtk = S.t; p.swing = ATK_T; p.tool = null;
  S.net?.notifyAttack?.();          // M2：讓同島的人看到你的揮擊
  for (const a of S.mobs) {
    if (a.dead || a.fly) continue;   // 島主飛在空中打不到
    if (!inHit(p, a)) continue;      // 武器尖端進了怪物的判定圈才算（不看面向）
    hitMob(p, a, false);
  }
}

// ---- 法杖：遠距詠唱（自動瞄準）----
// 武器的 ranged 欄位（avatar.json）：range＝射程 px（算到怪物判定圈邊緣）、cast＝詠唱秒數、dmg＝傷害。
// 按攻擊就挑射程內的目標（島主優先，否則最近的活動物），頭上出現詠唱倒數條、高舉法杖；
// 詠唱中目標超出射程（或死亡／飛走）、自己死亡／被石化／坐下／換武器／進裝飾模式就中斷；讀完自動命中目標。
const rangedDef = () => S.avatar?.weapons.find(w => w.id === S.me.weapon)?.ranged || null;
const inCastRange = (p, a, rg) => Math.hypot(a.x - p.x, a.y - p.y) - hitRadius(mobDef(a.id)) <= rg.range;
// 瞄準點（世界座標）：左鍵點擊的位置；F 鍵就用游標目前的位置（游標不在畫面上＝沒有瞄準點）
function castAim(wx, wy) {
  if (wx != null) return [wx, wy];
  if (S.mouseCell && S.mouseClient) { const r = canvas.getBoundingClientRect(); return [S.mouseClient[0] - r.left + S.cam.x, S.mouseClient[1] - r.top + S.cam.y]; }
  return null;
}
// 游標正指著的動物（以身體範圍判斷：島主很大隻，點身體任何地方都算）
function mobUnder(wx, wy) {
  let best = null, bd = Infinity;
  for (const a of S.mobs) {
    if (a.dead || a.fly) continue;
    const big = mobDef(a.id).big || 1;
    if (Math.abs(wx - a.x) > 30 * big || wy > a.y + 12 || wy < a.y - 48 * big) continue;
    const d = Math.hypot(wx - a.x, wy - a.y);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
// 沒有直接點到目標時挑誰：有瞄準點就挑「最接近游標方向」的（夾角最小），沒有就島主優先、再最近的
function pickCastTarget(p, rg, aim) {
  const ax = aim ? aim[0] - p.x : 0, ay = aim ? aim[1] - p.y : 0, useAim = !!aim && Math.hypot(ax, ay) > 8;
  let best = null, bs = Infinity;
  for (const a of S.mobs) {
    if (a.dead || a.fly || !inCastRange(p, a, rg)) continue;
    const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy);
    const score = useAim ? Math.abs(Math.atan2(ax * dy - ay * dx, ax * dx + ay * dy)) + d / 1e5
                         : d - (mobDef(a.id).owner ? 1e6 : 0);
    if (score < bs) { bs = score; best = a; }
  }
  return best;
}
function startCast(p, rg, wx, wy) {
  if (p.cast || S.t - p.lastAtk < ATK_CD) return;
  if (rg.cast && (p.moving || p.z > 0)) { say('站定才能詠唱'); return; }   // 詠唱時不能移動（移動會中斷）；不用詠唱的弓可以邊走邊射
  const aim = castAim(wx, wy);
  let a = null;
  const under = aim ? mobUnder(aim[0], aim[1]) : null;   // 游標點在動物身上：就打牠（超出射程不改選別的）
  if (under) {
    if (!inCastRange(p, under, rg)) { say('目標超出射程'); return; }
    a = under;
  } else a = pickCastTarget(p, rg, aim);
  if (!a) { say('射程內沒有目標'); return; }
  const tr = S.fx.triple, instant = !rg.cast;   // cast 0（豎琴弓）＝不用詠唱，直接射
  if (instant || (tr && tr.n > 0 && S.t < tr.until)) {   // 三重：這一擊不用詠唱
    if (!instant) tr.n--;
    p.lastAtk = S.t; p.swing = 0; p.tool = null; S._hits = 1;
    if (Math.abs(a.x - p.x) > 6) p.dir = Math.sign(a.x - p.x);
    S.net?.notifyAttack?.();
    const ty = a.y - 24 * (mobDef(a.id).big || 1) * .6;
    if (rg.shot === 'arrow') S.floaters.push({ fxk: 'arrow', x1: p.x + p.dir * 8, y1: p.y - 30, x2: a.x, y2: ty, life: .2 });
    else S.floaters.push({ orb: true, x1: p.x + p.dir * 4, y1: p.y - 52, x2: a.x, y2: ty, life: .22 });
    hitMob(p, a, true);
    return;
  }
  p.cast = { t0: S.t, dur: rg.cast * castMul(p), a };   // 黑魔法師站在魔法陣內：詠唱 −50%
  p.swing = 0; p.tool = null; S._hits = 1;   // 算有互動，點到動物時不要再跳動物的台詞
}
function cancelCast(p, why) { if (!p.cast) return; p.cast = null; if (why) toast(why, 1500); }
function stepCast(p) {   // 每幀（只有本機玩家）：檢查中斷條件、讀條完就出傷害
  const c = p.cast, rg = rangedDef();
  if (!c) return;
  if (p.dead || S.t < (p.petUntil ?? 0) || p.pose || p.fish || S.mode !== 'walk' || !rg) { cancelCast(p); return; }
  const a = c.a;
  if (p.moving || p.z > 0 || p.vz > 0) { cancelCast(p, '詠唱中斷：移動了'); return; }   // 詠唱時不能移動（跳躍也算）
  if (!S.mobs.includes(a) || a.dead || a.fly) { cancelCast(p, '詠唱中斷：目標消失了'); return; }
  if (!inCastRange(p, a, rg)) { cancelCast(p, '詠唱中斷：目標超出射程'); return; }
  if (Math.abs(a.x - p.x) > 6) p.dir = Math.sign(a.x - p.x);   // 面向目標
  if (S.t - c.t0 < c.dur) return;
  p.cast = null; p.lastAtk = S.t;
  S.net?.notifyAttack?.();   // 讓同島的人看到你出手
  S.floaters.push({ orb: true, x1: p.x + p.dir * 4, y1: p.y - 52, x2: a.x, y2: a.y - 24 * (mobDef(a.id).big || 1) * .6, life: .22 });
  hitMob(p, a, true);
}

// 命中一隻動物（近戰揮擊、法杖／咒杖詠唱完、職業技能共用）：ranged＝遠距詠唱（傷害固定取武器的 dmg、不暴擊）；
// force＝職業技能 {dmg, sk}：傷害固定、不吃職能的 +1，打島主／深海魚人時帶 sk 給伺服器驗證
function hitMob(p, a, ranged, force) {
  {
    S._hits++;
    const critP = (ranged ? 0 : .18) + (p === S.players[0] && fxOn('song') ? JOB_SKILLS.song.crit : 0);   // 吟遊詩人的唱歌：爆擊率 +25%
    const crit = !force && Math.random() < critP;
    let dmg = force ? force.dmg : ranged ? (rangedDef()?.dmg || 2) + (crit ? 1 : 0) : (crit ? 2 : 1);
    const jd = jobOf(p);
    if (jd?.dmgPlus && !force) dmg += jd.dmgPlus;   // 輸出：每擊 +1（打島主也算；伺服器的上限是 4）
    const od = mobDef(a.id);
    const sendDmg = force ? force.dmg : Math.min(4, dmg);   // 送給伺服器的值（上限 4＝兩份伺服器的 D_HIT_MAX；破綻的 +1 由伺服器自己加）
    if (od.owner && S.t < (a.vulnUntil ?? 0)) dmg += 1;      // 破綻：每擊 +1（單機在這裡扣、連線只是飄字）
    if (od.owner && p === S.players[0]) S.ownerHitAt[a.id] = S.t;   // 稱號「參與擊倒」用
    if (od.owner && a.proxy) {   // 島主連線時由伺服器權威：送意圖（座標＋傷害＋我們看到的龍位置），本地不扣血（血量等伺服器廣播）
      S.net?.dragonHit?.(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, sendDmg, Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10, ranged, force?.sk);
    } else if (od.lurker && a.proxy) {   // 釣上來的怪物連線時也由伺服器權威扣血
      S.net?.lurkerHit?.(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, sendDmg, Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10, ranged, force?.sk);
    } else {
      a.hp -= dmg;
      a.startle = 1; a.startleT = 3; a.target = null; a.idle = 0;
    }
    // 補師：揮擊命中動物就吸回自己一點血（血量走既有 state 封包同步）；翅膀期間 +1
    const heal = force?.dot ? 0 : (jd?.healHit ? jd.healHit + (p === S.players[0] && fxOn('wings') ? 1 : 0) : 0) + (p === S.players[0] && fxOn('vamp') ? 1 : 0);   // 戰士吸血：命中回 1；毒箭的持續傷害不算「命中」
    const care = p === S.players[0] && S.fx.care && S.t < S.fx.care.until ? S.fx.care : null;   // 賢者關心：每造成一次傷害，被關心的人回 1
    if (care) {
      const amt = JOB_SKILLS.care.amt + (fxOn('save') ? JOB_SKILLS.save.plus : 0);   // 拯救期間：關心的回血變多
      if (care.self) healMe(amt);
      else S.net?.skillEvent?.(`careheal:${care.id}:${amt}`);
    }
    if (heal) {
      const cap = hpCap(p) ?? PLAYER_HP;
      if (p.hp < cap) {
        p.hp = Math.min(cap, p.hp + heal);
        S.floaters.push({ x: p.x + (Math.random() * 16 - 8), y: p.y - 50, v: '+' + heal, life: .7 });
        if (fxOn('vamp')) S.floaters.push({ fxk: 'drain', x1: a.x, y1: a.y - 20, x2: p.x, y2: p.y - 30, life: .4 });
      }
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
    } else if (od.lurker) {   // 釣上來的怪物：不逃跑；單機記下最後被打的時刻（30 秒沒人打就消失）
      if (!a.proxy) a.lastHitAt = S.t;
      a.startle = 0;
    } else {
      a.target = fleeTarget(a, od, p.x, p.y, 220);
    }
    if (a.hp <= 0) {
      a.dead = true; a.dieT = .6;
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      if (!od.owner && !od.lurker) {   // 殺到動物回 1 HP（島主是伺服器權威事件，不算在此；釣上來的怪物也不算）
        const me = S.players[0];
        me.hp = Math.min(hpCap(me), (me.hp ?? hpCap(me)) + 1);
        S.floaters.push({ x: me.x, y: me.y - 50, v: '+1', life: .7 });
        // 補師：打倒動物補周遭 3 格內所有人 2。遠端玩家的血量由對方自己的畫面計算（與爪擊
        // 「受害者自判」同一原則），所以只廣播 heal 事件，各客戶端收到後自判是否在半徑內。
        if (jd?.healAoE) {
          S.net?.heal?.();
          const amt = jd.healAoE + (fxOn('wings') ? 1 : 0);   // 翅膀：治療量 +1
          S.floaters.push({ x: me.x, y: me.y - 24, healPulse: true, life: .35 });
          me.hp = Math.min(hpCap(me), me.hp + amt);
          S.floaters.push({ x: me.x + (Math.random() * 12 - 6), y: me.y - 50, v: '+' + amt, life: .75 });
        }
      }
      toast(od.lurker ? `${od.name} 被打倒了！` : `${mobDef(a.id).name} 被打倒了！${S.mobsDB.respawn || 30} 秒後重生`, 2200);
      if (od.owner) titleOwnerDown(a.id);   // 單機打倒島主
    }
  }
}

// ---- 動物的可站位置：只有會游泳的（mobs.json 的 swim:true，例如蛙）能進海，其餘只在陸地/岸邊 ----
function mobCanStand(def, x, y) {
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
    while (r < dist && mobCanStand(def, a.x + cx * (r + 8), a.y + cy * (r + 8))) r += 8;
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
const OWNER_FLY_SPEED = 240, OWNER_DASH_SPEED = 560, OWNER_CAST = 2, OWNER_CD = 12;   // OWNER_CAST＝龍衝讀條秒數（與兩份伺服器的 D_CAST_MS 一致）
// 台詞招式（黃金肥龍：mobs.json 的 lineSkills＋skills.json 的 quoteChance）：說完台詞（3 秒）後每 QUOTE_GAP 秒放一招，放招期間原地不動。
// 沒有預警：放出的瞬間才畫範圍並結算（各人自判，與爪擊同一原則）。數值以職業血量（輸出 8／補師 10／坦克 20 且減半）設計：
//   ring 月環：島主中心 r1～r2 之間的環形扣 dmg（最內圈與最外圈之外安全）
//   iron 鋼鐵：島主中心半徑 r 內扣 dmg 並擊飛 kb px
//   dive 月華衝：仇恨目標身邊半徑 r 扣 dmg（坦克滿血單吃剩 12；其他人太近也會中）
//   meteor 隕石流：每個人身上一圈半徑 r、每圈扣 dmg，站太近會多吃別人的（三人疊 9：輸出死、補師剩 1）
//   ion 離子砲：隨機一人身邊半徑 r，total 由圈內人數平分（兩人分攤各 7 不會死，單吃 14）
const QUOTE_GAP = 3;   // 與兩份伺服器的 Q_GAP_MS 一致
const QUOTE = { ring: { r1: 110, r2: 330, dmg: 4 }, iron: { r: 200, dmg: 4, kb: 160 }, dive: { r: 64, dmg: 16 },
                meteor: { r: 56, dmg: 3 }, ion: { r: 64, total: 14 } };
const quoteName = sk => S.skillsDB?.quotes?.[sk]?.name || sk;
const OWNER_GAZE_CAST = 2;      // 石化之瞳的開眼預警秒數（與兩份伺服器的 D_GAZE_CAST_MS 一致）
const OWNER_BEAM_CAST = 2;      // 波動砲的讀條秒數（與兩份伺服器的 D_BEAM_CAST_MS 一致）
const OWNER_COMMAND_CAST = 2;   // 命令（行動／靜止命令）的讀條秒數（與兩份伺服器的 D_COMMAND_CAST_MS 一致）
const OWNER_CMD_LEEWAY = .5;    // 命令檢定的寬限：讀條結束前後 0.5 秒內「有移動輸入」算行動中（純客戶端判定）
const CMD_ICONS = {   // 命令提示圖示（行人號誌風，gen_assets.py 產出）：act＝行動（走路小綠人）、still＝靜止（站立小紅人）
  act: Object.assign(new Image(), { src: 'assets/ui/command_act.png' }),
  still: Object.assign(new Image(), { src: 'assets/ui/command_still.png' }),
};
const OWNER_BEAM_DMG = 4;       // 波動砲命中的扣血（比爪擊重、非即死；與伺服器一樣是各客戶端自判）
const OWNER_PETRIFY_MS = 10000; // 石化時長：不能移動＋每秒扣 1 HP（判定在各人自己的畫面，不進同步協定）
const OWNER_WALK_SPEED = 34, OWNER_LEG_MIN = 1500, OWNER_PAUSE = [1.5, 4];   // 閒晃：路點間散步速度／每腿最短時長／休息範圍（秒）
const OWNER_REGEN = 18;   // 島主每秒回血（單機本地模擬；連線時血量由伺服器權威，與兩份伺服器的 D_REGEN 一致）
const OWNER_CHASE_SPEED = 180, OWNER_CLAW_RANGE = 36, OWNER_CLAW_CD = 1, OWNER_CLAW_DMG = 2;   // 仇恨追殺：速度（比玩家走路快、比跑步慢）／爪擊範圍／間隔／傷害（與伺服器 D_* 一致）
const OWNER_AGGRO_MS = 5, OWNER_DROPOUT = 30;                              // 仇恨換人週期／多久沒被打就脫離仇恨（秒）
const OWNER_PROVOKE_RANGE = 240, OWNER_PROVOKE_CD = 15;                    // 挑釁：有效距離／冷卻（秒；與伺服器 D_PROVOKE_* 一致）
const PLAYER_REGEN = 1;   // 玩家脫離戰鬥後每秒回幾點血（場上有島主處於仇恨／攻擊狀態、或自己被石化時不回）
const PLAYER_HP = 10;     // 玩家血量上限：爪擊扣 2（5 下倒地）、龍衝直接倒地、石化每秒扣 1、殺一隻動物回 1、復活即滿血
// ---------------- 職能與職業 ----------------
// 職能（ROLES）＝被動特性＋R 鍵職能技能；職業（assets/jobs/jobs.json，boot 時載入到 JOBS）＝職能＋唯一的職業武器＋一套裝備＋1／2 鍵技能。
// JOBS[id]＝{ ...職能的被動數值, ...jobs.json 的條目, role }，所以原本讀 jd.hpMax／jd.takenHalf／jd.dmgPlus／jd.healHit 的地方不用改。
// 被打與打野外動物都是各畫面自算（野外動物刻意不同步、爪擊是受害者自判），被動效果在客戶端生效；
// 打島主的傷害由兩份伺服器夾值（一般攻擊 1～4，職業技能另有上限與冷卻，見 JOB_SKILLS）。
const ROLES = {
  tank:   { name: '坦克', color: '#7cc0ff', hpMax: 20, takenHalf: true, provoke: true,
            desc: '血量上限 20、被打傷害減半；R＝挑釁（把島主拉到自己身上，龍衝仍直接倒地）' },
  healer: { name: '補師', color: '#8fe08a', hpMax: 10, healHit: 1, healAoE: 2, groupHeal: true,
            desc: '血量上限 10；揮擊命中動物吸回自己 1、打倒動物補周遭所有人 2；R＝群療（補周遭所有人 2，含自己）' },
  melee:  { name: '近戰輸出', color: '#ff9a8a', hpMax: 8, dmgPlus: 1, vuln: true,
            desc: '血量上限 8、每擊 +1 傷害；R＝破綻（島主 10 秒內受到的傷害每擊 +1，所有人打都算）' },
  ranged: { name: '遠程輸出', color: '#ff9a8a', hpMax: 8, dmgPlus: 1, weak: true,
            desc: '血量上限 8、每擊 +1 傷害；R＝降傷（島主 10 秒內對所有人造成的傷害 −30%）' },
};
const JOBS = {};          // boot() 由 jobs.json 填
const JOB_SKILLS = {};    // 職業技能（1／2 鍵），見下方「職業技能」
let JOB_LEGACY = {};      // 舊存檔／舊客戶端的職業 id（tank／healer／dps）→ 新職業 id
const DEFAULT_JOB = 'ninja';
const jobIdOf = id => JOBS[id] ? id : (JOBS[JOB_LEGACY[id]] ? JOB_LEGACY[id] : null);
function loadJobs(db) {
  JOB_LEGACY = db?.legacy || {};
  for (const j of db?.jobs || []) if (ROLES[j.role]) JOBS[j.id] = { ...ROLES[j.role], ...j, roleName: ROLES[j.role].name, color: ROLES[j.role].color };
}
const ALWAYS_WEAPONS = ['hands', 'rod'];   // 所有職業都能用的武器（空手、釣竿）；其餘只有職業武器
const weaponAllowed = (job, id) => ALWAYS_WEAPONS.includes(id) || JOBS[job]?.weapon === id;
const allowedWeapons = () => S.avatar.weapons.filter(w => !w.glam && weaponAllowed(S.me.job, w.id));   // 武器列：職業武器＋空手＋釣竿（依 avatar.json 的順序）
const HEAL_RADIUS = 110;  // 補師打倒動物／群療時的治療半徑（約 3.4 格；2026-11-05 由 96 調大，與月環內圈安全區同大）
// 自己看「造型」面板選的職業（S.me.job）；別人看 state 封包同步的 job（舊客戶端的 tank／healer／dps 照 legacy 轉）；NPC 沒有職業（回 null）
const jobOf = p => JOBS[jobIdOf(p === S.players[0] ? S.me.job : p.job)] || null;
// 血量上限：有職業用職業的上限，沒有（NPC／未設定）就 PLAYER_HP
const hpCap = p => jobOf(p)?.hpMax ?? PLAYER_HP;
// 島主攻擊樣式（mobs.json 的 atk 欄位）：dash＝龍衝（黃金肥龍）、gaze＝石化之瞳（笨蛋蛇女）、beam＝波動砲（蓋老師）
// gaze／beam 都是「原地施放」（不瞬移），dash 會瞬移到島緣再衝
const ownerAtk = def => def.atk || 'dash';
const ownerStationary = def => ownerAtk(def) === 'gaze' || ownerAtk(def) === 'beam' || ownerAtk(def) === 'command';
// 島主招式設定：assets/skills/skills.json（key＝攻擊樣式）。name＝招式名稱、bar＝預警時頭上畫黃色倒數條、say＝放招前先講台詞
// （false＝被打直接開始預警；兩份伺服器也讀同一個檔決定要不要跳過說話階段）
const ownerSkill = def => S.skillsDB?.skills?.[ownerAtk(def)] || {};
const ownerCastTotal = def => ownerAtk(def) === 'gaze' ? OWNER_GAZE_CAST : ownerAtk(def) === 'beam' ? OWNER_BEAM_CAST : ownerAtk(def) === 'command' ? OWNER_COMMAND_CAST : OWNER_CAST;   // 預警總秒數（倒數條的分母）
// 島主被激怒的台詞：mobs.json 該島主條目的 ownerLines（由 gen_assets.py 的 MOB_MANIFEST 產生）。
// 發動反擊前隨機說一句（不連續重複）；沒寫台詞的島主就不說話。
// 例外：mobs.json 標了 ownerLinesSeq（目前只有蓋老師）的島主照順序一句一句說，說完一輪回到第一句。
// 順序號記在 S.ownerSayIdx（key＝島主 id，不跟島主物件走，物件重建、換地形後再回來都接著說）；
// 純客戶端計數，沒有同步——每個畫面各自從頭數，中途才進來的人看到的句子可能和別人差幾句
function ownerSay(a, idx) {   // idx＝指定第幾句（台詞招式由伺服器挑，全島同一句）；沒給照下面的規則挑
  const def = mobDef(a.id), lines = def?.ownerLines;
  if (!Array.isArray(lines) || !lines.length) return;
  let line;
  if (Number.isInteger(idx) && lines[idx]) line = lines[idx];
  else if (def.ownerLinesSeq) {
    const idx = (S.ownerSayIdx[a.id] ||= 0);
    line = lines[idx % lines.length]; S.ownerSayIdx[a.id] = idx + 1;
  } else {
    do { line = lines[Math.floor(Math.random() * lines.length)]; } while (lines.length > 1 && line === a.lastLine);
  }
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
  // 被打：先在原地說台詞（3 秒泡泡），說完才瞬移到島緣（ownerStep 的 sayPhase 接手）；skills.json 的 say:false 就不講、直接開始預警。
  // 一被打就建立仇恨（龍衝照放），落地歇完就接著追殺同一個攻擊者，不用再被打一次
  const def = mobDef(a.id), sk = ownerSkill(def);
  if (Array.isArray(def.lineSkills) && sk.quoteChance > 0 && Math.random() < sk.quoteChance) {   // 台詞招式（單機；連線時由伺服器挑）
    const cands = def.lineSkills.map((v, i) => i).filter(i => def.lineSkills[i].length && i !== a.lastQuote);
    if (cands.length) {
      const idx = cands[Math.floor(Math.random() * cands.length)], skills = def.lineSkills[idx].slice(0, 3);
      a.lastQuote = idx;
      ownerSay(a, idx);
      a.sayPhase = S.t + 3; a.saySrc = null;
      a.quote = { skills, fires: skills.map((_, i) => S.t + 3 + QUOTE_GAP * (i + 1)), fired: 0 };
      a.target = null; a.idle = 0; a.wleg = null;
      a.aggro = { target: src, rotateAt: S.t + OWNER_AGGRO_MS, clawAt: 0 };
      a.rageCd = a.quote.fires[a.quote.fires.length - 1] + OWNER_CD;
      return;
    }
  }
  const says = sk.say !== false;
  if (says) ownerSay(a);
  a.sayPhase = says ? S.t + 3 : S.t; a.saySrc = { x: src.x, y: src.y };
  a.target = null; a.idle = 0; a.wleg = null;
  a.aggro = { target: src, rotateAt: S.t + OWNER_AGGRO_MS, clawAt: 0 };
  a.rageCd = S.t + 4;   // 說台詞＋開眼/預警期間被打不重觸發（發射時會再設為 OWNER_CD）
}
function ownerWarp(a, src) {   // 說完台詞：瞬移到島緣鎖定攻擊者，準備龍衝
  const def = mobDef(a.id);
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
  if (a.sayPhase) {   // 說台詞：原地不動（泡泡顯示中），說完照攻擊樣式接手（龍衝＝瞬移島緣；蛇女／蓋老師＝原地施放）
    if (S.t < a.sayPhase) { a.z = 0; return; }
    const src = a.saySrc;
    a.sayPhase = 0; a.saySrc = null;
    if (a.quote) return;   // 台詞招式：說完由下面的 quote 段依序放招
    if (ownerAtk(def) === 'gaze') ownerGazeCast(a, src);
    else if (ownerAtk(def) === 'beam') ownerBeamCast(a, src);
    else if (ownerAtk(def) === 'command') ownerCommandCast(a, src);
    else ownerWarp(a, src);
    return;
  }
  if (a.quote) {   // 台詞招式（單機）：原地不動，到點依序放招；目標只有自己
    a.z = 0;
    const q = a.quote;
    while (q.fired < q.skills.length && S.t >= q.fires[q.fired]) {
      const skn = q.skills[q.fired++];
      if (skn === 'act' || skn === 'still') { startCommandCheck(a, skn, OWNER_COMMAND_CAST * 1000); continue; }   // 命令檢定：讀條 2 秒後本地判定（不進 quoteFire）
      quoteFire(a, skn, skn === 'ring' || skn === 'iron' ? [] : ['me'], a.x, a.y);
    }
    if (q.fired >= q.skills.length) a.quote = null;
    return;
  }
  if (a.command) { stepCommandCheck(a, def); return; }   // 命令讀條中：原地不動（單機與連線共用牆鐘）
  if (a.cast) {
    a.cast -= dt;   // 預警：龍衝＝金色虛線鎖定攻擊範圍；石化之瞳＝大眼睛；波動砲＝光波帶狀預警（命令走 a.command 牆鐘，不經這裡）
    if (a.cast <= 0) {
      a.cast = 0;
      if (ownerAtk(def) === 'gaze') gazeFire(a, def);
      else if (ownerAtk(def) === 'beam') beamFire(a, def);
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

// ---- 台詞招式的放出與結算（單機與連線共用；ids＝目標：'me' 或連線編號）----
function quoteFire(a, skill, ids, bx, by) {
  const def = mobDef(a.id), me = S.players[0], Q = QUOTE[skill], nm = quoteName(skill);
  if (!Q) return;
  const posOf = id => (id === 'me' || id === S.net?.id) ? me : S.remotes.get(id);
  const dist = (p, c) => Math.hypot(p.x - c.x, p.y - c.y);
  const b = { x: bx ?? a.x, y: by ?? a.y };
  const hurt = dmg => {
    if (me.dead || !(dmg > 0)) return;
    playerDamage(me, dmg, `${def.name}的${nm}`);
    S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
  };
  if (skill === 'ring') {
    S.floaters.push({ aoe: 'ring', x: b.x, y: b.y, r1: Q.r1, r2: Q.r2, life: .7 });
    const d = dist(me, b);
    if (d > Q.r1 && d < Q.r2) hurt(Q.dmg);
  } else if (skill === 'iron') {
    S.floaters.push({ aoe: 'circle', x: b.x, y: b.y, r: Q.r, life: .7 });
    const d = dist(me, b);
    if (d < Q.r && !me.dead) {
      hurt(Q.dmg);
      if (!me.dead) { const l = d || 1; me.knock = { ux: (me.x - b.x) / l || 1, uy: (me.y - b.y) / l, left: Q.kb }; }   // 擊飛：往遠離島主的方向（stepPlayer 推）
    }
  } else if (skill === 'dive' || skill === 'ion') {
    const t = posOf(ids?.[0]);
    if (t) {
      S.floaters.push({ aoe: 'circle', x: t.x, y: t.y, r: Q.r, life: .7, hot: skill === 'dive' });
      if (dist(me, t) <= Q.r) {
        if (skill === 'dive') hurt(Q.dmg);
        else {   // 離子砲：圈內的人平分（以我畫面上的位置算人數，含自己）
          const n = [me, ...S.remotes.values()].filter(q => !q.dead && dist(q, t) <= Q.r).length;
          hurt(Math.ceil(Q.total / Math.max(1, n)));
        }
      }
    }
  } else if (skill === 'meteor') {
    const cs = (ids || []).map(posOf).filter(Boolean).map(t => ({ x: t.x, y: t.y }));
    for (const c of cs) S.floaters.push({ aoe: 'circle', x: c.x, y: c.y, r: Q.r, life: .7 });
    hurt(Q.dmg * cs.filter(c => dist(me, c) <= Q.r).length);
  }
  toast(`${def.name}：${nm}！`, 1400);
}

// ---- 石化之瞳（笨蛋蛇女的攻擊，atk: "gaze"）：不瞬移，原地開眼 2 秒 → 全地圖「正面朝著她」的人石化 ----
// 沒有直線、不看距離：發射瞬間臉朝向蛇女的人（左右朝向）都會石化，背對她／看向另一邊就安全。
// 石化由各客戶端自判（跟龍衝的受害者自判同源）；伺服器仍會帶光束幾何（舊協定），客戶端不再用它判定
function ownerGazeCast(a, src) {   // 說完台詞：原地開眼（大眼睛預警），蛇女轉向攻擊者
  const def = mobDef(a.id);
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

// ---- 波動砲（蓋老師的攻擊，atk: "beam"）：不瞬移，原地讀條 2 秒 → 朝攻擊者發射一道跟島主一樣寬的直線光波 ----
// 光波沿讀條時鎖定的方向直射出去；「站在光波帶狀範圍內」（與光束中線的垂直距離 < 島主一半寬）的人受傷。
// 命中由各客戶端自判（跟龍衝／石化同源）；伺服器只負責階段與方向
function ownerSize(a, def) {   // 島主畫面上的寬高（光波跟島主一樣寬）；有動畫看 anim.scale，否則看圖大小 ×2×big
  const an = S.mobAnims[a.id];
  if (an) return { W: an.fw * an.scale, H: an.fh * an.scale };
  const im = S.mobImgs[a.id];
  return { W: (im?.width || 24) * 2 * (def.big || 1), H: (im?.height || 24) * 2 * (def.big || 1) };
}
function ownerBeamCast(a, src) {   // 說完台詞：原地讀條（光波預警），蓋老師轉向攻擊者
  const def = mobDef(a.id);
  a.cast = OWNER_BEAM_CAST; a.castFrom = { x: src.x, y: src.y };
  a.wleg = null; a.z = 0; a.fly = false;
  a.dir = src.x < a.x ? -1 : 1;
  toast(`${def.name} 開始凝聚波動砲——別站在砲口前面！`, 2600);
}
// 這個人是不是站在光波裡：把 (q - 島主) 投影到光束方向，只要在前方、離中線的垂直距離 < 半寬就算
function inBeam(q, ax, ay, ux, uy, half) {
  const dx = q.x - ax, dy = q.y - ay;
  if (dx * ux + dy * uy < -half * .5) return false;   // 在島主背後（留一點餘裕）
  return Math.abs(ux * dy - uy * dx) <= half;
}
function beamFire(a, def) {   // 讀條結束：發射直線光波（方向＝讀條時鎖定的攻擊者方向），判定在各人自己的畫面
  const cf = a.castFrom;
  let ux = cf ? cf.x - a.x : (a.dir || 1), uy = cf ? cf.y - a.y : 0;
  const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
  a.castFrom = null; a.rageCd = S.t + OWNER_CD;
  const { W, H } = ownerSize(a, def), half = W / 2;
  S.floaters.push({ beamLine: true, x: a.x, y: a.y - H * .5, ang: Math.atan2(uy, ux), len: 1700, wid: W, life: .5 });   // 光波特效：射到畫面外
  const hit = q => !q.dead && inBeam(q, a.x, a.y, ux, uy, half);
  const me = S.players[0];
  if (hit(me)) { playerDamage(me, OWNER_BEAM_DMG, def.name); S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 }); }
  for (const r of S.remotes.values()) if (hit(r)) S.floaters.push({ x: r.x, y: r.y - 24, ring: true, life: .35 });   // 遠端由對方自判，這裡只演出
  toast(`${def.name} 的波動砲發射了！`, 2000);
}

// ---- 命令（壓力山大的攻擊，atk: "command"）：不瞬移，原地讀條 2 秒 → 下達「行動命令」或「靜止命令」----
// 讀條結束的瞬間檢查玩家：「行動命令」＝最近 0.5 秒內有移動輸入、「靜止命令」＝最近 0.5 秒完全沒動；不服從就強制倒地（不看血量）。
// 判定在各人自己的畫面（跟龍衝／石化同源）；伺服器只決定時間點與命令種類。台詞招式（lineSkills 的 act／still）與普攻共用同一套讀條檢定
// （a.command 牆鐘，單機與連線同構）；p.lastMoveAt 在 stepPlayer／stepRemote 隨移動輸入更新（石化／擊飛／坐睡中不更新＝視為靜止）。
function startCommandCheck(a, kind, castMs) {   // 開始一次命令讀條（kind＝'act'｜'still'）；島主原地不動
  const def = mobDef(a.id);
  a.command = { t0ms: Date.now(), castMs, kind, x: a.x, y: a.y };
  a.wleg = null; a.z = 0; a.fly = false;
  toast(kind === 'act'
    ? `${def.name} 下達了行動命令——讀條結束前開始移動！`
    : `${def.name} 下達了靜止命令——立刻停住不動！`, 2600);
}
function stepCommandCheck(a, def) {   // 命令讀條推進（牆鐘與伺服器同軸）：到點就本地檢定
  const c = a.command, el = Date.now() - c.t0ms;
  a.x = c.x; a.y = c.y; a.z = 0; a.fly = false;
  a.cast = Math.max(0, (c.castMs - el) / 1000);   // 給倒數條沿用既有繪製（cast > 0 且 bar:true 就會畫）
  if (el >= c.castMs) commandFire(a, def);
}
function commandFire(a, def) {   // 讀條結束：檢定（自己＝真判定；遠端＝只畫演出，由對方畫面自判）
  const kind = a.command?.kind;
  a.command = null; a.cast = 0;
  a.rageCd = S.t + OWNER_CD;
  const me = S.players[0];
  const moving = q => q.lastMoveAt != null && (S.t - q.lastMoveAt) < OWNER_CMD_LEEWAY;   // 最近 0.5 秒內有移動＝行動中
  if (!me.dead) {
    if (kind === 'act' && !moving(me)) killPlayer(me, def.name, '行動命令');
    if (kind === 'still' && moving(me)) killPlayer(me, def.name, '靜止命令');
  }
  for (const r of S.remotes.values()) {
    if (r.dead) continue;
    if ((kind === 'act' && !moving(r)) || (kind === 'still' && moving(r))) S.floaters.push({ x: r.x, y: r.y - 40, v: '……', life: .8 });
  }
}

// ---- 玩家血量＋島主仇恨（龍衝冷卻中的追殺）----
// 單機本地模擬在這裡；連線時追殺流程由伺服器權威（aggro/claw/wander 事件），但「自己有沒有被打到」仍是各人自判
function playerDamage(p, dmg, cause) {
  if (p.dead) return;
  // 減傷相乘後無條件進位、最少 1：坦克職能 ×0.5、單盾 ×0.5、戰士群盾 ×0.7、島主被降傷 ×0.7；騎士群盾整擊擋掉（用掉護盾）。
  // 龍衝不經過這裡（直接 killPlayer），不受任何減傷影響
  let m = jobOf(p)?.takenHalf ? .5 : 1;
  if (p === S.players[0]) {
    if (fxOn('guard')) m *= .5;
    if (fxOn('wshield')) m *= JOB_SKILLS.wshield.mul;
    if (S.mobs.some(a => !a.dead && mobDef(a.id)?.owner && mobDef(a.id).name === cause && S.t < (a.weakUntil ?? 0))) m *= ROLE_DEBUFF.weakMul;
    if (fxOn('kshield')) {
      S.fx.kshield = 0;
      S.floaters.push({ x: p.x, y: p.y - 50, v: '擋下', life: .8 });
      S.floaters.push({ fxk: 'pop', kind: 'kshield', x: p.x, y: p.y, life: .4 });
      return;
    }
  }
  if (m < 1) dmg = Math.max(1, Math.ceil(dmg * m));
  p.hp = Math.max(0, (p.hp ?? hpCap(p)) - dmg);
  S.floaters.push({ x: p.x + (Math.random() * 20 - 10), y: p.y - 50, v: String(dmg), life: .8, crit: true });
  if (p.hp <= 0) killPlayer(p, cause);
}
// 補師打倒動物／發動群療時的群體補血（heal 事件）：每個收到的人自判「我在不在補師周遭半徑內」再補自己，
// 與爪擊「受害者自判」同一原則；來源不是補師（舊客戶端／不可能值）就忽略
function onNetHeal(healerId) {
  const me = S.players[0];
  if (me.dead) return;
  const src = S.remotes.get(healerId);
  const ao = src && jobOf(src)?.healAoE && jobOf(src).healAoE + (src.fx?.includes('wings') ? 1 : 0);   // 翅膀：治療量 +1
  if (!ao) return;
  if (Math.hypot(me.x - src.x, me.y - src.y) <= HEAL_RADIUS) {
    me.hp = Math.min(hpCap(me), (me.hp ?? hpCap(me)) + ao);
    S.floaters.push({ x: me.x + (Math.random() * 12 - 6), y: me.y - 50, v: '+' + ao, life: .75 });
  }
}
// 場上有沒有島主正在戰鬥（仇恨追殺、預警、龍衝、開眼、說台詞、歇腳都算）；連線時這些旗標由伺服器事件驅動。
// 釣上來的怪物只要還在就一定在追殺人，也算戰鬥中（玩家不自動回血，否則每秒回 1 比牠的爪擊快，站著不動也打不死）
function ownerEngaged() {
  return S.mobs.some(a => !a.dead && a.lurker) || S.mobs.some(a => !a.dead && mobDef(a.id)?.owner &&
    (a.aggro || a.fly || a.cast || a.castFrom || a.rest || a.sayPhase || a.quote || a.cycle || a.gaze || a.beam || a.command));
}
// 龍衝 CD 中被打：進入仇恨（單機版；連線版由伺服器廣播 aggro 事件）
function ownerAggroStart(a, src) {
  const def = mobDef(a.id);
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

// ---------------- 職業技能（1／2 鍵）與職能技能（R 鍵）的共用狀態 ----------------
// S.fx：自己身上的技能狀態（都是遊戲時間 S.t 的到期時刻；0＝沒有）。被打時的減傷／護盾在 playerDamage 套用（受害者自判）；
// 給隊友的增益（兩種群盾）走泛型 event 廣播，收到的人自判「在不在放的人周圍 SHIELD_RADIUS 內」再套在自己身上（與群療同一原則）。
// 持續型效果（翅膀、護盾、結印、三重、法陣）走 state 的 fx／circle 給同地形的人畫特效（myFx）。
S.fx = { cd: {}, guard: 0, kshield: 0, wshield: 0, vamp: 0, wings: 0, seal: null, triple: null, circle: null, care: null, cared: 0, song: 0, save: 0 };
const SHIELD_RADIUS = 300;   // 兩種群盾的範圍（px，約 9 格；使用者定）
const ROLE_DEBUFF = { dur: 10, cd: 30, weakMul: .7 };   // 破綻／降傷：持續 10 秒、冷卻 30 秒、降傷 −30%（與兩份伺服器的 D_DEBUFF_* 一致）
const fxOn = k => S.t < (S.fx[k] || 0);
const skillCdLeft = id => Math.max(0, (S.fx.cd[id] || 0) - S.t);
function myFx() {   // 給 state 的持續型效果清單（id 要符合伺服器的 ID_RE）
  const F = S.fx, out = [];
  for (const k of ['guard', 'kshield', 'wshield', 'vamp', 'wings', 'cared', 'song', 'save']) if (fxOn(k)) out.push(k);   // cared＝被賢者關心中、song＝唱歌加成中、save＝拯救中
  if (F.seal) out.push('seal');
  if (F.triple && F.triple.n > 0 && S.t < F.triple.until) out.push('triple' + F.triple.n);
  return out;
}
S.myFx = myFx;
// 職業技能：jobs.json 的 skills 依序對應 1、2 鍵。name／desc 顯示在技能列與造型面板；cd＝冷卻秒數；
// run(me) 回 true＝放出去了（才開始冷卻）；usable() 回 null＝可以放、字串＝不能放的原因（圖示變暗）
Object.assign(JOB_SKILLS, {
  guard:    { name: '單盾', cd: 25, dur: 8, desc: '8 秒內自己受到的傷害 −50%',
              run() { S.fx.guard = S.t + this.dur; fxBurst('guard'); return true; } },
  kshield:  { name: '群盾', cd: 40, dur: 15, desc: `周圍 ${SHIELD_RADIUS}px 內所有人（含自己）上護盾，${15} 秒內擋下一次傷害`,
              run() { S.fx.kshield = S.t + this.dur; S.net?.skillEvent?.('kshield'); fxBurst('kshield'); return true; } },
  vamp:     { name: '吸血', cd: 25, dur: 10, desc: '10 秒內揮擊命中敵人回自己 1',
              run() { S.fx.vamp = S.t + this.dur; fxBurst('vamp'); return true; } },
  wshield:  { name: '群盾', cd: 40, dur: 8, desc: `周圍 ${SHIELD_RADIUS}px 內所有人（含自己）8 秒內受到的傷害 −30%`, mul: .7,
              run() { S.fx.wshield = S.t + this.dur; S.net?.skillEvent?.('wshield'); fxBurst('wshield'); return true; } },
  sheal:    { name: '單補', cd: 12, amt: 4, range: 320, desc: '瞬發恢復滑鼠方向上最近的一位玩家 4 血（射程 320px；附近沒有別人就補自己；翅膀期間 +1）',
              run(me) {
                const t = pickHealTarget(me, this.range), amt = this.amt + (fxOn('wings') ? 1 : 0);
                S.floaters.push({ fxk: 'sheal', x1: me.x, y1: me.y - 40, x2: t.x, y2: t.y - 24, life: .5 });
                if (t === me) healMe(amt);
                else S.net?.skillEvent?.('sheal:' + t.id);   // 對方收到後自己補（血量由各人自己算，與群療同一原則）
                return true;
              } },
  song:     { name: '唱歌', cd: 40, dur: 15, r: 300, crit: .25, desc: '周圍 300px 內所有人（含自己）15 秒內爆擊率 +25%（遠程攻擊平常不會爆擊，唱歌期間也會）',
              run(me) { S.fx.song = S.t + this.dur; S.net?.skillEvent?.('song'); S.floaters.push({ fxk: 'song', x: me.x, y: me.y, r: this.r, life: .7 }); return true; } },
  poison:   { name: '毒箭', cd: 12, dur: 30, every: 3, dmg: 1, range: 320, desc: '對滑鼠方向的敵人射一支毒箭：射中當下先受到 1 傷害，之後 30 秒內每 3 秒 1 傷害（共 10 下）',
              usable() { return pickCastTarget(S.players[0], this, castAim()) ? null : '射程內沒有目標'; },
              run(me) {
                const a = pickCastTarget(me, this, castAim());
                if (!a) { say('射程內沒有目標'); return false; }
                // 每跳由自己這邊送（stepSkills），島主／深海魚人由伺服器驗證 sk:'poison'。射中的當下（第 0 秒）先跳一次，之後每 3 秒一次（0、3…27 秒共 10 下）；
                // 目標已經中毒就只延長時間、照原本的節奏跳（不另外多跳一次，也避免撞到伺服器每 2.7 秒一次的限制）
                const big = mobDef(a.id).big || 1;
                S.floaters.push({ fxk: 'arrow', poison: true, x1: me.x + me.dir * 8, y1: me.y - 30, x2: a.x, y2: a.y - 20 * big, life: .2 });
                S.floaters.push({ fxk: 'poisonpop', x: a.x, y: a.y - 20 * big, big, life: .6 });
                if (a.poison) { a.poison.until = S.t + this.dur; return true; }
                a.poison = { until: S.t + this.dur, next: S.t + this.every };
                hitMob(me, a, true, { dmg: this.dmg, sk: 'poison', dot: true });
                return true;
              } },
  care:     { name: '關心', cd: 20, dur: 30, amt: 1, range: 320, desc: '指定滑鼠方向最近的一位玩家（附近沒人就是自己）：30 秒內賢者每造成一次傷害，對方回 1 血',
              run(me) {
                const t = pickHealTarget(me, this.range);
                S.fx.care = { id: t === me ? null : String(t.id), self: t === me, until: S.t + this.dur, name: t === me ? '自己' : t.name };
                S.floaters.push({ fxk: 'heart', x1: me.x, y1: me.y - 40, x2: t.x, y2: t.y - 30, life: .6 });
                if (t === me) S.fx.cared = S.t + this.dur;
                else S.net?.skillEvent?.('care:' + t.id);
                toast(`關心了 ${S.fx.care.name}`, 1400);
                return true;
              } },
  save:     { name: '拯救', cd: 30, dur: 8, plus: 2, desc: '8 秒內關心的回血從 1 變 3（要先關心一位玩家）',
              usable() { return S.fx.care && S.t < S.fx.care.until ? null : '還沒有關心的人'; },
              run() {
                if (!(S.fx.care && S.t < S.fx.care.until)) { toast('先用「關心」指定一位玩家', 1600); return false; }
                S.fx.save = S.t + this.dur; fxBurst('save'); return true;
              } },
  wings:    { name: '翅膀', cd: 45, dur: 15, desc: '15 秒內所有治療量 +1',
              run() { S.fx.wings = S.t + this.dur; fxBurst('wings'); return true; } },
  ninjutsu: { name: '忍術', cd: 20, cast: 1.5, r: 80, dmg: 6, desc: '結印 1.5 秒（可移動、不能攻擊），結完對身邊 80px 內的敵人各造成 6 傷害',
              run() { S.fx.seal = { t0: S.t, until: S.t + this.cast }; return true; } },
  highjump: { name: '高跳', cd: 15, dmg: 5, range: 200, desc: '跳到滑鼠方向 200px 內的敵人身上造成 5 傷害，再跳回原位',
              usable() { return pickCastTarget(S.players[0], this, castAim()) ? null : '範圍內沒有敵人'; },
              run(me) {
                const a = pickCastTarget(me, this, castAim());
                if (!a) { say('範圍內沒有敵人'); return false; }
                const ux = me.x - a.x, uy = me.y - a.y, l = Math.hypot(ux, uy) || 1;
                const tx = a.x + ux / l * 14, ty = a.y + uy / l * 6;   // 落在敵人身上（稍微偏向自己這側）
                const home = { x: me.x, y: me.y };
                startLeap(me, tx, ty, .42, 120, () => {
                  S.floaters.push({ fxk: 'jumpboom', x: a.x, y: a.y, life: .5 });
                  if (S.mobs.includes(a) && !a.dead) hitMob(me, a, false, { dmg: this.dmg, sk: 'jump' });
                  S.net?.skillEvent?.('highjump');
                  startLeap(me, home.x, home.y, .38, 60);   // 跳回原位
                });
                if (Math.abs(a.x - me.x) > 6) me.dir = Math.sign(a.x - me.x);
                return true;
              } },
  backjump: { name: '後跳', cd: 8, dist: 120, desc: '往滑鼠的反方向跳 120px（遇水或家具停在最後能站的點）',
              run(me) {
                const aim = castAim();
                let ux = aim ? me.x - aim[0] : -me.dir, uy = aim ? me.y - aim[1] : 0;
                const l = Math.hypot(ux, uy); if (l < 1) { ux = -me.dir; uy = 0; } else { ux /= l; uy /= l; }
                let bx = me.x, by = me.y;
                for (let s = 4; s <= this.dist; s += 4) {
                  const nx = me.x + ux * s, ny = me.y + uy * s;
                  if (blocked(nx, ny)) break;
                  bx = nx; by = ny;
                }
                if (Math.hypot(bx - me.x, by - me.y) < 8) { say('後面過不去'); return false; }
                startLeap(me, bx, by, .32, 40);   // 面向不變（往後跳）
                S.floaters.push({ fxk: 'smoke', x: me.x, y: me.y, life: .4 });
                return true;
              } },
  blink:    { name: '縮地', cd: 8, dist: 120, desc: '朝滑鼠方向瞬移 120px（遇水或家具停在最後能站的點）',
              run(me) { return blinkMe(me, this.dist); } },
  circle:   { name: '魔法陣', cd: 40, dur: 15, r: 72, desc: '腳下放一個慢慢自轉的魔法陣（15 秒），站在陣內詠唱時間 −50%',
              run(me) { S.fx.circle = { x: me.x, y: me.y, until: S.t + this.dur, t0: S.t }; return true; } },
  triple:   { name: '三重', cd: 30, dur: 15, n: 3, desc: '接下來 3 次攻擊不用詠唱（15 秒內有效）',
              run() { S.fx.triple = { n: this.n, until: S.t + this.dur }; fxBurst('triple'); return true; } },
});
const jobSkillIds = () => JOBS[S.me.job]?.skills || [];
// 單補的目標：射程內（含自己）。游標點在某人身上就補他；否則挑「游標方向」夾角最小的別人（60° 以內，夾角相近挑近的）；
// 沒有游標、游標在自己身上、或那個方向沒人 → 補自己
function pickHealTarget(me, range) {
  const cands = [...S.remotes.values()].filter(r => !r.dead && Math.hypot(r.x - me.x, r.y - me.y) <= range);
  const aim = castAim();
  if (!aim) return me;
  const [ax, ay] = aim, onBody = q => Math.abs(ax - q.x) <= 14 && ay <= q.y + 4 && ay >= q.y - 50;
  const hitOne = cands.find(onBody);
  if (hitOne) return hitOne;
  const ux = ax - me.x, uy = ay - me.y;
  if (onBody(me) || Math.hypot(ux, uy) < 16) return me;
  let best = me, bs = Math.PI / 3;
  for (const r of cands) {
    const dx = r.x - me.x, dy = r.y - me.y, ang = Math.abs(Math.atan2(ux * dy - uy * dx, ux * dx + uy * dy)), sc = ang + Math.hypot(dx, dy) / 2000;
    if (sc < bs) { bs = sc; best = r; }
  }
  return best;
}
function healMe(amt) {
  const me = S.players[0];
  if (me.dead) return;
  me.hp = Math.min(hpCap(me), (me.hp ?? hpCap(me)) + amt);
  S.floaters.push({ x: me.x + (Math.random() * 12 - 6), y: me.y - 50, v: '+' + amt, life: .75 });
}
function tryJobSkill(slot) {   // slot：0＝1 鍵、1＝2 鍵
  const me = S.players[0], id = jobSkillIds()[slot], sk = JOB_SKILLS[id];
  if (!sk || S.mode !== 'walk' || me.dead || me.pose || S.t < (me.petUntil ?? 0)) return;
  const left = skillCdLeft(id);
  if (left > 0) { toast(`${sk.name}還要 ${Math.ceil(left)} 秒`, 1200); return; }
  if (S.fx.seal) { say('結印中'); return; }
  if (me.leap) return;   // 跳躍中
  if (sk.run(me)) S.fx.cd[id] = S.t + sk.cd;
}
// 龍騎士的跳躍：dur 秒內從目前位置拋物線移到 (tx, ty)，最高 h px（z 走 state 同步，別人也看得到跳起來）；落地呼叫 onLand。
// 跳躍中不能自己走、不能攻擊或放技能；倒地或被石化就中斷（停在原地）
function startLeap(p, tx, ty, dur, h, onLand) {
  p.leap = { fx: p.x, fy: p.y, tx, ty, t0: S.t, dur, h, onLand };
  p.target = null; p.pose = null; cancelCast(p);
}
function stepLeap(p) {   // stepPlayer 每幀呼叫；回 true＝這幀在跳（不處理其他移動）
  const L = p.leap;
  if (!L) return false;
  if (p.dead || S.t < (p.petUntil ?? 0)) { p.leap = null; p.z = 0; return false; }
  const q = Math.min(1, (S.t - L.t0) / L.dur);
  p.x = L.fx + (L.tx - L.fx) * q; p.y = L.fy + (L.ty - L.fy) * q;
  p.z = Math.sin(Math.PI * q) * L.h; p.vz = 0; p.moving = false;
  if (q >= 1) { p.leap = null; p.z = 0; L.onLand?.(); }
  return true;
}
// 黑魔法師：詠唱時間（站在自己的魔法陣內 −50%）
function castMul(p) {
  const c = S.fx.circle;
  return c && S.t < c.until && Math.hypot(p.x - c.x, p.y - c.y) <= JOB_SKILLS.circle.r ? .5 : 1;
}
// 縮地：朝游標方向（沒有游標＝面向）一步一步往前，停在最後一個能站的點
function blinkMe(me, dist) {
  const aim = castAim();
  let ux = aim ? aim[0] - me.x : me.dir, uy = aim ? aim[1] - me.y : 0;
  const l = Math.hypot(ux, uy); if (l < 1) { ux = me.dir; uy = 0; } else { ux /= l; uy /= l; }
  let bx = me.x, by = me.y;
  for (let s = 4; s <= dist; s += 4) {
    const nx = me.x + ux * s, ny = me.y + uy * s;
    if (blocked(nx, ny)) break;
    bx = nx; by = ny;
  }
  if (Math.hypot(bx - me.x, by - me.y) < 8) { say('那邊過不去'); return false; }
  for (let i = 0; i < 4; i++) S.floaters.push({ fxk: 'after', x: me.x + (bx - me.x) * i / 4, y: me.y + (by - me.y) * i / 4, life: .35 + i * .06, d8: d8Of(me) });
  S.floaters.push({ fxk: 'smoke', x: me.x, y: me.y, life: .45 });
  me.x = bx; me.y = by; me.target = null; cancelCast(me);
  if (Math.abs(ux) > .2) me.dir = Math.sign(ux);
  S.floaters.push({ fxk: 'smoke', x: bx, y: by, life: .5 });
  S.net?.skillEvent?.('blink');
  return true;
}
// 每幀：忍術結印完成、三重／法陣過期
function stepSkills() {
  const F = S.fx, me = S.players[0];
  if (S.jobSwapUsed && !ownerEngaged()) S.jobSwapUsed = false;   // 戰鬥結束：戰鬥中換職業的次數重置
  if (F.seal && (me.dead || S.t < (me.petUntil ?? 0))) F.seal = null;
  if (F.seal && S.t >= F.seal.until) {
    F.seal = null;
    const sk = JOB_SKILLS.ninjutsu;
    S.floaters.push({ fxk: 'boom', x: me.x, y: me.y, r: sk.r, life: .6 });
    S.net?.skillEvent?.('ninjutsu');
    for (const a of S.mobs) {
      if (a.dead || a.fly) continue;
      if (Math.hypot(a.x - me.x, a.y - me.y) - hitRadius(mobDef(a.id)) > sk.r) continue;
      hitMob(me, a, false, { dmg: sk.dmg, sk: 'ninjutsu' });
    }
  }
  if (F.triple && (F.triple.n <= 0 || S.t >= F.triple.until)) F.triple = null;
  if (F.care && S.t >= F.care.until) F.care = null;
  for (const a of S.mobs) {   // 吟遊詩人的毒箭：每 3 秒跳一次（自己上的毒，自己這邊送）；換掉職業或倒地就停
    const po = a.poison;
    if (!po) continue;
    if (a.dead || S.t >= po.until || me.dead || S.me.job !== 'bard') { a.poison = null; continue; }
    if (S.t >= po.next) { po.next += JOB_SKILLS.poison.every; hitMob(me, a, true, { dmg: JOB_SKILLS.poison.dmg, sk: 'poison', dot: true }); }
  }
  if (F.circle && S.t >= F.circle.until) F.circle = null;
}
// 別人的技能事件：群盾自判是否在範圍內；其餘只演出
function onSkillEvent(kind, r) {
  const me = S.players[0];
  if (kind === 'song') {   // 吟遊詩人的唱歌：在範圍內就套上爆擊率加成
    S.floaters.push({ fxk: 'song', x: r.x, y: r.y, r: JOB_SKILLS.song.r, life: .7 });
    if (me.dead || Math.hypot(me.x - r.x, me.y - r.y) > JOB_SKILLS.song.r) return;
    S.fx.song = S.t + JOB_SKILLS.song.dur;
    toast(`${r.name} 的歌聲讓你更容易爆擊`, 1800);
  } else if (kind === 'kshield' || kind === 'wshield') {
    S.floaters.push({ fxk: kind, x: r.x, y: r.y, r: SHIELD_RADIUS, life: .6 });
    if (me.dead || Math.hypot(me.x - r.x, me.y - r.y) > SHIELD_RADIUS) return;
    S.fx[kind] = S.t + JOB_SKILLS[kind].dur;
    toast(`${r.name} 的${JOB_SKILLS[kind].name}罩住了你`, 1800);
  } else if (kind === 'highjump') S.floaters.push({ fxk: 'jumpboom', x: r.x, y: r.y, life: .5 });
  else if (kind === 'ninjutsu') S.floaters.push({ fxk: 'boom', x: r.x, y: r.y, r: JOB_SKILLS.ninjutsu.r, life: .6 });
  else if (kind === 'blink') { S.floaters.push({ fxk: 'smoke', x: r.x, y: r.y, life: .45 }); r.snapNext = true; }
  else if (kind.startsWith('care:') || kind.startsWith('careheal:')) {   // 賢者的關心：目標是我才處理
    const heal = kind.startsWith('careheal:'), [tid, a] = kind.slice(heal ? 9 : 5).split(':');
    if (tid !== String(S.net?.id)) return;
    if (!heal) { S.fx.cared = S.t + JOB_SKILLS.care.dur; S.floaters.push({ fxk: 'heart', x1: r.x, y1: r.y - 40, x2: me.x, y2: me.y - 30, life: .6 }); toast(`${r.name} 關心了你`, 1600); }
    else if (fxOn('cared')) healMe(Math.max(1, Math.min(JOB_SKILLS.care.amt + JOB_SKILLS.save.plus, Math.round(+a) || JOB_SKILLS.care.amt)));   // 回血量由賢者帶（拯救期間較多），夾在合理範圍
  }
  else if (kind.startsWith('sheal:')) {   // 單補：目標是我就補自己（翅膀看放的人 state 的 fx），其他人只畫特效
    const tid = kind.slice(6), t = tid === String(S.net?.id) ? me : [...S.remotes.values()].find(q => String(q.id) === tid);   // 連線編號可能是數字
    if (t) S.floaters.push({ fxk: 'sheal', x1: r.x, y1: r.y - 40, x2: t.x, y2: t.y - 24, life: .5 });
    if (t === me) { healMe(JOB_SKILLS.sheal.amt + (r.fx?.includes('wings') ? 1 : 0)); toast(`${r.name} 幫你補血`, 1400); }
  }
  else if (kind === 'vuln' || kind === 'weak' || kind === 'provoke') S.floaters.push({ fxk: 'shout', x: r.x, y: r.y, kind, life: .5 });
}
// 放出瞬間的小特效（自己畫面；別人畫面靠 state 的 fx 看到持續效果）
function fxBurst(kind) {
  const me = S.players[0];
  S.floaters.push({ fxk: kind === 'kshield' || kind === 'wshield' ? kind : 'pop', kind, x: me.x, y: me.y, r: SHIELD_RADIUS, life: .6 });
}

// ---------------- 破綻／降傷（R 鍵，近戰／遠程輸出）----------------
// 對所在地形的島主下負面效果：破綻＝10 秒內受到的傷害每擊 +1（所有人打都算；連線時由伺服器加）；
// 降傷＝10 秒內對所有人造成的傷害 −30%（受害者自判，看島主的 weakUntil）。連線時送 debuff，伺服器驗證職能/距離/冷卻後廣播 dragon debuff
function ownerHere() { return S.mobs.find(v => !v.dead && mobDef(v.id).owner) || null; }
function tryDebuff(kind) {
  const me = S.players[0], jd = JOBS[S.me.job];
  if (S.mode !== 'walk' || me.dead || S.t < (me.petUntil ?? 0) || !(kind === 'vuln' ? jd?.vuln : jd?.weak)) return;
  const left = skillCdLeft(kind);
  if (left > 0) { toast(`${kind === 'vuln' ? '破綻' : '降傷'}還要 ${Math.ceil(left)} 秒`, 1200); return; }
  const a = ownerHere();
  if (!a) { toast('這裡沒有島主', 1400); return; }
  if (Math.hypot(me.x - a.x, me.y - a.y) > OWNER_PROVOKE_RANGE) { toast('離島主太遠了，靠近一點', 1800); return; }
  S.fx.cd[kind] = S.t + ROLE_DEBUFF.cd;
  S.floaters.push({ fxk: 'shout', x: me.x, y: me.y, kind, life: .5 });
  if (S.net?.connected && a.proxy) { S.net.debuff(kind); S.net.skillEvent?.(kind); return; }   // 結果走 dragon debuff 廣播（含自己）
  applyDebuff(a, kind, ROLE_DEBUFF.dur, S.players[0].name);
}
function applyDebuff(a, kind, secs, who) {
  a[kind + 'Until'] = S.t + secs;
  const big = mobDef(a.id).big || 1;
  S.floaters.push({ fxk: kind === 'vuln' ? 'crack' : 'fog', x: a.x, y: a.y - 22 * big, big, life: .8 });
  toast(kind === 'vuln' ? `${who} 看穿了 ${mobDef(a.id).name} 的破綻！受到的傷害 +1` : `${who} 削弱了 ${mobDef(a.id).name}！造成的傷害 −30%`, 2200);
}

// ---------------- 挑釁（R 鍵，坦克限定，玩家自選）----------------
let provokeCd = 0;   // 本地冷卻（連線時真正的冷卻在伺服器，這裡擋連打；成功請求也照計）
// 挑釁：把島主的仇恨拉到自己身上。連線時送 provoke 給伺服器（職業/距離/冷卻由伺服器驗證，
// 結果走既有 aggro/say/aim 事件廣播）；單機退回本地模擬，行為與伺服器一致。
function tryProvoke() {
  const me = S.players[0];
  if (S.mode !== 'walk' || me.dead || S.t < (me.petUntil ?? 0) || !JOBS[S.me.job]?.provoke) return;   // 坦克限定（其他職業按了沒反應）；石化中不能放
  if (S.t < provokeCd) return;
  const a = S.mobs.find(v => !v.dead && mobDef(v.id).owner);
  if (!a) return;   // 沒有島主（不在有島主的地形）
  if (Math.hypot(me.x - a.x, me.y - a.y) > OWNER_PROVOKE_RANGE) { toast('離島主太遠了，靠近一點再挑釁', 1800); return; }
  provokeCd = S.t + OWNER_PROVOKE_CD;
  if (S.net?.connected) { S.net.provoke(); return; }   // 成敗由伺服器廣播；冷卻中也會被伺服器擋下
  if (a.proxy) return;   // 連線中島主由伺服器帶（proxy 不做本地模擬）
  // ---- 以下單機本地模擬（與 worker/dev_server 的 dragon_provoke 同一套流程）----
  if (a.fly || a.cast || a.rest || a.sayPhase) { provokeCd = 0; return; }   // 反擊循環中：不打斷（不消耗冷卻）
  a.hitBook = a.hitBook || new Map(); a.hitBook.set(me, S.t);   // 挑釁者視同現役攻擊者
  a.lastHitAt = S.t;
  if (a.aggro) {   // 已在追殺別人（含說台詞中）：仇恨轉向挑釁者
    ownerAggroStart(a, me);
    return;
  }
  if (S.t >= (a.rageCd ?? 0)) ownerTakeoff(a, me);   // 閒置且冷卻過了：照被打的反擊流程（說台詞→攻擊）
  else ownerAggroStart(a, me);                       // 反擊冷卻中：直接進入追殺
}

// ---------------- 群療（R 鍵，補職限定，玩家自選）----------------
const GROUP_HEAL_CD = 8;   // 群療冷卻（秒；目前純客戶端，要加伺服器驗證時與兩份實作一起對齊）
let groupHealCd = 0;       // 本地冷卻（純客戶端，這裡擋連打）
// 群療：補周遭 3 格內所有人 2（含自己）。重用打倒動物群補的 `event kind:'heal'` 廣播（net.heal），
// 遠端玩家收到後各自自判是否在 HEAL_RADIUS 內（onNetHeal）；沒連線時只有自己補得到。
function tryGroupHeal() {
  const me = S.players[0];
  if (S.mode !== 'walk' || me.dead || S.t < (me.petUntil ?? 0) || !JOBS[S.me.job]?.groupHeal) return;   // 補職限定（其他職業按了沒反應）；石化中不能放
  if (S.t < groupHealCd) { toast(`群療還要 ${Math.ceil(groupHealCd - S.t)} 秒`, 1200); return; }
  groupHealCd = S.t + GROUP_HEAL_CD;
  S.net?.heal?.();   // 同島的人（不含自己：對方畫面自補，走 onNetHeal）
  const amt = (JOBS[S.me.job].healAoE || 2) + (fxOn('wings') ? 1 : 0);   // 翅膀：治療量 +1
  S.floaters.push({ x: me.x, y: me.y - 24, healPulse: true, life: .35 });   // 綠圈從腳下擴散
  me.hp = Math.min(hpCap(me), (me.hp ?? hpCap(me)) + amt);
  S.floaters.push({ x: me.x + (Math.random() * 12 - 6), y: me.y - 50, v: '+' + amt, life: .75 });
}
// ---------------- 技能列（畫面底部正中間）：1、2＝職業技能、R＝職能技能；圖示＋冷卻倒數 ----------------
// 冷卻用順時針退去的暗色扇形（conic-gradient）＋秒數，冷卻結束閃一下。冷卻取本地計時（伺服器另有自己的冷卻）
const ROLE_SKILLS = {
  tank:   { id: 'provoke', name: '挑釁', total: () => OWNER_PROVOKE_CD, until: () => provokeCd, run: () => tryProvoke(),
            usable() { const a = ownerHere(); if (!a) return '這裡沒有島主'; return Math.hypot(S.players[0].x - a.x, S.players[0].y - a.y) > OWNER_PROVOKE_RANGE ? '離島主太遠' : null; } },
  healer: { id: 'groupHeal', name: '群療', total: () => GROUP_HEAL_CD, until: () => groupHealCd, run: () => tryGroupHeal(), usable: () => null },
  melee:  { id: 'vuln', name: '破綻', total: () => ROLE_DEBUFF.cd, until: () => S.fx.cd.vuln || 0, run: () => tryDebuff('vuln'),
            usable() { const a = ownerHere(); if (!a) return '這裡沒有島主'; return Math.hypot(S.players[0].x - a.x, S.players[0].y - a.y) > OWNER_PROVOKE_RANGE ? '離島主太遠' : null; } },
  ranged: { id: 'weak', name: '降傷', total: () => ROLE_DEBUFF.cd, until: () => S.fx.cd.weak || 0, run: () => tryDebuff('weak'),
            usable() { const a = ownerHere(); if (!a) return '這裡沒有島主'; return Math.hypot(S.players[0].x - a.x, S.players[0].y - a.y) > OWNER_PROVOKE_RANGE ? '離島主太遠' : null; } },
};
const roleSkill = () => ROLE_SKILLS[JOBS[S.me.job]?.role] || null;
// 目前職業的三格：[1 鍵, 2 鍵, R 鍵]
function skillSlots() {
  const out = jobSkillIds().map((id, i) => {
    const d = JOB_SKILLS[id]; if (!d) return null;
    return { id, key: String(i + 1), name: d.name, total: () => d.cd, until: () => S.fx.cd[id] || 0, run: () => tryJobSkill(i),
             usable: () => (S.fx.seal ? '結印中' : d.usable ? d.usable() : null) };
  }).filter(Boolean);
  const r = roleSkill(); if (r) out.push({ ...r, key: 'R' });
  return out;
}
const skillUI = { job: null, slots: [] };
// 技能圖示（40×40，程式畫的 placeholder）：依技能 id 畫
function drawSkillIcon(c, id) {
  const g = c.getContext('2d'), P = Math.PI;
  g.clearRect(0, 0, 40, 40);
  const bg = (col) => { g.fillStyle = col; g.fillRect(0, 0, 40, 40); };
  const shield = (x, y, w, h, fill) => { g.fillStyle = fill; g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h * .55); g.quadraticCurveTo(x + w, y + h * .9, x + w / 2, y + h); g.quadraticCurveTo(x, y + h * .9, x, y + h * .55); g.closePath(); g.fill(); g.strokeStyle = '#0e1626'; g.lineWidth = 2; g.stroke(); };
  switch (id) {
    case 'provoke':
      bg('#1d2a44'); g.strokeStyle = 'rgba(160,210,255,.75)'; g.lineWidth = 2;
      for (const r of [13, 18]) { g.beginPath(); g.arc(20, 21, r, -.9, .9); g.stroke(); g.beginPath(); g.arc(20, 21, r, P - .9, P + .9); g.stroke(); }
      shield(11, 9, 18, 26, '#6fb4ff'); g.fillStyle = '#fff'; g.fillRect(18.5, 13, 3, 11); g.fillRect(18.5, 27, 3, 3); break;
    case 'groupHeal':
      bg('#16301f'); g.strokeStyle = 'rgba(150,240,160,.7)'; g.lineWidth = 2; g.beginPath(); g.arc(20, 20, 16, 0, P * 2); g.stroke();
      g.fillStyle = '#7ee08a'; g.fillRect(16.5, 7, 7, 26); g.fillRect(7, 16.5, 26, 7); g.fillStyle = '#e8ffe8'; g.fillRect(18.5, 12, 3, 16); g.fillRect(12, 18.5, 16, 3); break;
    case 'vuln':   // 破綻：紅色裂紋
      bg('#3a1418'); g.strokeStyle = '#ff6a5a'; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(20, 4); g.lineTo(16, 14); g.lineTo(23, 20); g.lineTo(15, 30); g.lineTo(19, 37); g.stroke();
      g.lineWidth = 2; g.beginPath(); g.moveTo(23, 20); g.lineTo(32, 17); g.moveTo(16, 14); g.lineTo(8, 12); g.stroke(); break;
    case 'weak':   // 降傷：紫霧＋向下箭頭
      bg('#241a34'); for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(170,140,220,${.25 + i * .05})`; g.beginPath(); g.arc(8 + i * 5, 14 + (i % 2) * 5, 7, 0, P * 2); g.fill(); }
      g.fillStyle = '#e8d8ff'; g.beginPath(); g.moveTo(14, 22); g.lineTo(26, 22); g.lineTo(26, 28); g.lineTo(31, 28); g.lineTo(20, 37); g.lineTo(9, 28); g.lineTo(14, 28); g.closePath(); g.fill(); break;
    case 'guard': bg('#1d2a44'); shield(9, 6, 22, 30, '#8fb8ff'); g.fillStyle = '#e0b840'; g.fillRect(18, 11, 4, 18); g.fillRect(13, 16, 14, 4); break;
    case 'kshield': bg('#1d2a44'); for (const [x, y] of [[4, 10], [20, 10], [12, 4]]) shield(x, y, 16, 22, 'rgba(150,200,255,.85)'); g.strokeStyle = 'rgba(200,230,255,.8)'; g.lineWidth = 2; g.beginPath(); g.arc(20, 22, 17, P * 1.1, P * 1.9); g.stroke(); break;
    case 'vamp': bg('#2e1014'); g.fillStyle = '#d83a3a'; g.beginPath(); g.moveTo(20, 6); g.quadraticCurveTo(32, 22, 20, 34); g.quadraticCurveTo(8, 22, 20, 6); g.fill(); g.fillStyle = '#ffb0a8'; g.fillRect(16, 18, 3, 8); break;
    case 'wshield': bg('#3a2412'); g.strokeStyle = '#ff9a4a'; g.lineWidth = 3; for (const r of [8, 13, 18]) { g.globalAlpha = 1 - r / 26; g.beginPath(); g.arc(20, 26, r, P, P * 2); g.stroke(); } g.globalAlpha = 1; shield(14, 12, 12, 16, '#ffb060'); break;
    case 'sheal': bg('#16301f'); g.fillStyle = '#7ee08a'; g.fillRect(14, 8, 10, 26); g.fillRect(6, 16, 26, 10); g.fillStyle = '#e8ffe8'; g.fillRect(17, 12, 4, 18); g.fillRect(10, 19, 18, 4);
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(30, 4); g.lineTo(37, 4); g.lineTo(37, 11); g.closePath(); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(27, 14); g.lineTo(35, 6); g.stroke(); break;
    case 'poison': bg('#221830'); g.fillStyle = '#9ad850'; g.beginPath(); g.moveTo(20, 5); g.quadraticCurveTo(32, 22, 20, 34); g.quadraticCurveTo(8, 22, 20, 5); g.fill();
      g.fillStyle = '#b060d8'; for (const [x, y, r] of [[10, 30, 3], [30, 28, 4], [27, 10, 2.5]]) { g.beginPath(); g.arc(x, y, r, 0, P * 2); g.fill(); } g.fillStyle = '#e8ffd0'; g.fillRect(16, 18, 3, 8); break;
    case 'song': bg('#2e2814'); g.fillStyle = '#ffe17a'; g.strokeStyle = '#ffe17a'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(13, 29, 5, 4, -.4, 0, P * 2); g.fill(); g.beginPath(); g.ellipse(27, 25, 5, 4, -.4, 0, P * 2); g.fill();
      g.beginPath(); g.moveTo(17.5, 28); g.lineTo(17.5, 9); g.lineTo(31.5, 5); g.lineTo(31.5, 24); g.stroke(); g.lineWidth = 4; g.beginPath(); g.moveTo(17.5, 11); g.lineTo(31.5, 7); g.stroke(); break;
    case 'save': bg('#33280e'); g.strokeStyle = 'rgba(255,215,110,.8)'; g.lineWidth = 2; g.beginPath(); g.arc(20, 21, 16, 0, P * 2); g.stroke();
      g.fillStyle = '#ffd76e'; g.fillRect(16.5, 7, 7, 26); g.fillRect(7, 16.5, 26, 7); g.fillStyle = '#ff82aa'; g.beginPath(); g.arc(20, 20, 4.5, 0, P * 2); g.fill(); break;
    case 'care': bg('#34202a'); { const h = (x, y, s, c) => { g.fillStyle = c; g.beginPath(); g.moveTo(x, y + s * .9); g.bezierCurveTo(x - s * 1.4, y - s * .1, x - s * .6, y - s * 1.1, x, y - s * .35); g.bezierCurveTo(x + s * .6, y - s * 1.1, x + s * 1.4, y - s * .1, x, y + s * .9); g.fill(); };
      h(20, 22, 13, '#ff82aa'); h(20, 21, 7, '#ffd0e0'); } break;
    case 'wings': bg('#2a3440'); g.fillStyle = '#f4f4ff'; for (const s of [-1, 1]) { g.beginPath(); g.moveTo(20, 22); g.quadraticCurveTo(20 + s * 18, 2, 20 + s * 18, 14); g.quadraticCurveTo(20 + s * 14, 20, 20 + s * 16, 28); g.quadraticCurveTo(20 + s * 8, 26, 20, 22); g.fill(); } break;
    case 'ninjutsu': bg('#241c36'); g.strokeStyle = '#e8d0ff'; g.lineWidth = 2.5; g.strokeRect(9, 9, 22, 22); g.beginPath(); g.moveTo(9, 20); g.lineTo(31, 20); g.moveTo(20, 9); g.lineTo(20, 31); g.stroke(); g.fillStyle = '#c83a3a'; g.beginPath(); g.arc(20, 20, 5, 0, P * 2); g.fill(); break;
    case 'highjump': bg('#1c2440'); g.strokeStyle = 'rgba(170,200,255,.8)'; g.lineWidth = 2; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(6, 34); g.quadraticCurveTo(20, -6, 34, 30); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#c9d2d9'; g.beginPath(); g.moveTo(34, 36); g.lineTo(29, 26); g.lineTo(37, 26); g.closePath(); g.fill(); g.fillStyle = '#3a4a8a'; g.fillRect(31, 14, 3, 13); break;
    case 'backjump': bg('#1c2440'); g.strokeStyle = 'rgba(170,200,255,.8)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(30, 32); g.quadraticCurveTo(20, 6, 8, 26); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(3, 30); g.lineTo(6, 20); g.lineTo(13, 27); g.closePath(); g.fill(); break;
    case 'blink': bg('#1c2436'); for (let i = 0; i < 3; i++) { g.fillStyle = `rgba(180,200,255,${.25 + i * .3})`; g.beginPath(); g.ellipse(9 + i * 9, 22, 4, 9, 0, 0, P * 2); g.fill(); } g.fillStyle = '#fff'; g.beginPath(); g.moveTo(28, 14); g.lineTo(36, 22); g.lineTo(28, 30); g.closePath(); g.fill(); break;
    case 'circle': bg('#1a1430'); g.strokeStyle = '#b88aff'; g.lineWidth = 2; g.beginPath(); g.arc(20, 20, 15, 0, P * 2); g.stroke(); g.beginPath(); g.arc(20, 20, 9, 0, P * 2); g.stroke();
      g.beginPath(); for (let i = 0; i <= 5; i++) { const an = i * P * 4 / 5 - P / 2; g.lineTo(20 + Math.cos(an) * 15, 20 + Math.sin(an) * 15); } g.stroke(); break;
    case 'triple': bg('#1a1430'); for (let i = 0; i < 3; i++) { const an = i * P * 2 / 3 - P / 2; const gr = g.createRadialGradient(20 + Math.cos(an) * 10, 20 + Math.sin(an) * 10, 0, 20 + Math.cos(an) * 10, 20 + Math.sin(an) * 10, 7); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(170,110,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(20 + Math.cos(an) * 10, 20 + Math.sin(an) * 10, 7, 0, P * 2); g.fill(); } break;
    default: bg('#333');
  }
}
function buildSkillBar() {
  const bar = $('skillBar'); bar.innerHTML = '';
  skillUI.slots = skillSlots().map(sk => {
    const el = document.createElement('div'); el.className = 'skslot';
    el.innerHTML = '<div class="skbtn"><canvas width="40" height="40"></canvas><div class="skcd"></div><div class="sknum"></div><span class="skkey"></span></div><div class="skname"></div>';
    drawSkillIcon(el.querySelector('canvas'), sk.id);
    el.querySelector('.skkey').textContent = sk.key; el.querySelector('.skname').textContent = sk.name;
    el.querySelector('.skbtn').onclick = () => sk.run();
    bar.appendChild(el);
    return { sk, btn: el.querySelector('.skbtn'), cd: el.querySelector('.skcd'), num: el.querySelector('.sknum'), cdLeft: 0, dim: null, ready: null, n: '' };
  });
  const on = skillUI.slots.length > 0;
  bar.classList.toggle('hidden', !on); $('app').classList.toggle('has-skill', on);
}
function updateSkillBar() {   // 每幀：換職業就重建三格；更新冷卻扇形與秒數（只在值變了才改 DOM）
  if (skillUI.job !== S.me.job) { skillUI.job = S.me.job; buildSkillBar(); }
  const me = S.players[0], busy = me.dead || S.t < (me.petUntil ?? 0) || S.mode !== 'walk';
  for (const u of skillUI.slots) {
    const total = u.sk.total(), left = Math.max(0, u.sk.until() - S.t);
    const why = busy ? '現在不能使用' : u.sk.usable();
    if (left > 0) {
      const deg = Math.min(360, (1 - left / total) * 360);
      u.cd.style.background = `conic-gradient(rgba(0,0,0,0) 0deg ${deg.toFixed(1)}deg, rgba(8,10,14,.72) ${deg.toFixed(1)}deg 360deg)`;
      const num = left < 1 ? left.toFixed(1) : String(Math.ceil(left));
      if (num !== u.n) { u.num.textContent = num; u.n = num; }
    } else if (u.cdLeft > 0 || u.n) {
      u.cd.style.background = 'none'; u.num.textContent = ''; u.n = '';
      if (u.cdLeft > 0) { u.btn.classList.remove('flash'); void u.btn.offsetWidth; u.btn.classList.add('flash'); }   // 冷卻結束閃一下
    }
    u.cdLeft = left;
    const dim = !!why, ready = !why && left <= 0;
    if (dim !== u.dim) { u.btn.classList.toggle('dim', dim); u.dim = dim; }
    if (ready !== u.ready) { u.btn.classList.toggle('ready', ready); u.ready = ready; }
    u.btn.title = `${u.sk.name}（${u.sk.key}）` + (why ? ` — ${why}` : '');
  }
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
  if (a.command) {   // 命令讀條（牆鐘與伺服器同軸），castMs 到就本地檢定（行動／靜止，各人自判）
    stepCommandCheck(a, def);
    return;
  }
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
  if (a.beam) {   // 波動砲：原地讀條（牆鐘與伺服器同軸），castMs 到就本地發射（光波＋命中判定，受害者自判）
    const b = a.beam, el = Date.now() - b.t0ms;
    a.x = b.x; a.y = b.y; a.z = 0; a.fly = false;
    a.cast = Math.max(0, (b.castMs - el) / 1000); a.castFrom = b.from;
    if (el >= b.castMs) {
      a.command = null; a.beam = null; a.cast = 0; a.castFrom = null;
      beamFire(a, def);
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
// 陸地位圖：世界由前端種子生成，伺服器不知道島形；進每個地形時上傳（島主路徑＋擺設的水邊驗證）（RLE，1＝陸地，與 ownerEdgeAt 的判定一致：types!==0）
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
// 上傳島形：每條連線、每個地形只傳一次（約 20KB；以前切地形、每次島主快照都重傳，Worker 每次都寫儲存）。
// 所有地形都傳：島主用它算路徑，擺設用它驗證水邊（水上要有地板才能放家具）。
// S.landSent 記「這條連線已傳過的地形」，重連時（onOpen）清掉
function uploadLandMap() {
  if (!netOn() || !S.world || S.landSent === S.terrain) return;
  S.landSent = S.terrain;
  S.net.sendDragonMap(landRLE());
}
// 取得（或建立）伺服器同步的島主 proxy；單機本地模擬的島主沒有 proxy 旗標
function dragonEnsure(x, y, hp) {
  const oid = S.terrains[S.terrain]?.owner;
  if (!oid) return null;
  let a = S.mobs.find(v => v.id === oid);
  if (!a) {
    const def = mobDef(oid);
    a = { id: oid, x, y, dir: 1, target: null, idle: 0, startle: 0, z: 0, bounce: 0,
          hp: hp ?? def.hp, maxHp: def.hp, dead: false, dieT: 0, proxy: true };
    S.mobs.push(a);
  }
  a.proxy = true;   // 開機時（還沒連線）可能已本地生成了島主，接手時補上 proxy 旗標改為伺服器同步
  return a;
}
// 套用進草島時的島主快照：不論收到時龍在哪個階段都接得上（預警剩餘時間、衝刺位置、歇腳…）
function applyDragonSnap(o) {
  if (o.ph === 'dead') return;   // 死了就先不生成，等 spawn 事件
  const a = dragonEnsure(o.x, o.y, o.hp);
  if (!a) return;
  a.hp = o.hp; a.dead = false; a.dieT = 0; a.startle = 0; a.target = null; a.wleg = null; a.cycle = null; a.gaze = null; a.command = null; a.beam = null;
  a.aggro = o.aggro != null;   // 快照帶仇恨目標（連線編號）：中途進場也知道牠在追殺（戰鬥中不自動回血、之後會提示冷靜）
  a.vulnUntil = o.vulnMs ? S.t + o.vulnMs / 1000 : 0; a.weakUntil = o.weakMs ? S.t + o.weakMs / 1000 : 0;   // 破綻／降傷剩餘時間
  if (o.ph === 'aim') {   // 島緣鎖定中：還原成循環（扣掉已過的預警時間）
    const total = OWNER_CAST * 1000;
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
    if (o.line != null) ownerSay(a, o.line);   // 台詞招式：伺服器帶的那一句
    else if (ownerSkill(mobDef(a.id)).say !== false) ownerSay(a);
  } else if (o.ph === 'cast') {   // 原地施放中（石化之瞳開眼／波動砲讀條／命令讀條）：站定，接續剩餘時間後本地發射／檢定
    a.cycle = null; a.wleg = null;
    const atk = ownerAtk(mobDef(a.id));
    if (atk === 'command') {   // 命令：快照帶 kind（中途進場的人也知道現在讀的是行動還是靜止）
      const total = OWNER_COMMAND_CAST * 1000, remain = Math.max(0, Math.min(total, o.castMs || total));
      a.command = { t0ms: Date.now() - (total - remain), castMs: total, kind: o.kind || 'act', x: o.x, y: o.y };
      a.x = o.x; a.y = o.y; a.z = 0; a.fly = false;
      return;
    }
    const beam = atk === 'beam';
    const total = (beam ? OWNER_BEAM_CAST : OWNER_GAZE_CAST) * 1000, remain = Math.max(0, Math.min(total, o.castMs || total));
    const st = { t0ms: Date.now() - (total - remain), castMs: total,
                 from: { x: o.tx, y: o.ty }, x: o.x, y: o.y, bx: o.bx, by: o.by };
    if (beam) a.beam = st; else a.gaze = st;
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
  const a = S.mobs.find(v => v.id === S.terrains[S.terrain].owner);
  if (m.ev === 'debuff') {   // 破綻／降傷（伺服器驗證過才廣播）
    if (a && (m.kind === 'vuln' || m.kind === 'weak')) applyDebuff(a, m.kind, (m.ms || 10000) / 1000, m.name || '玩家');
    return;
  }
  if (m.ev === 'hp') {   // 別人（或自己）打到牠：更新血條
    if (a) a.hp = m.hp;
    return;
  }
  if (m.ev === 'dead') {   // 被打倒了：原地死亡；重生等伺服器的 spawn 事件，不排本地重生
    if (a && !a.dead) {
      a.dead = true; a.dieT = .6; a.fly = false; a.dashU = null; a.cast = 0; a.castFrom = null; a.rest = 0; a.wleg = null; a.cycle = null; a.gaze = null; a.command = null; a.beam = null; a.aggro = false;
      if (m.x !== undefined) { a.x = m.x; a.y = m.y; }
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      toast(`${mobDef(a.id).name} 被打倒了！30 秒後重生`, 2200);
      titleOwnerDown(a.id);   // 連線：伺服器宣告島主倒下，最近打過牠的人算參與擊倒
    }
    return;
  }
  if (m.ev === 'spawn') {   // 重生：在島緣（沒島形時中心）現蹤
    const na = dragonEnsure(m.x, m.y, m.hp);
    if (na) {
      na.dead = false; na.dieT = 0; na.x = m.x; na.y = m.y; na.hp = m.hp; na.z = 0;
      na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.idle = 1.2; na.wleg = null; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.aggro = false;
    }
    toast(`${mobDef(S.terrains[S.terrain].owner).name} 回來了！`, 1600);
    return;
  }
  if (m.ev === 'say') {   // 島主被激怒：先在原地說台詞（泡泡 3 秒），說完才反擊（龍衝＝瞬移島緣；蛇女＝原地開眼）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.wleg = null;
    na.x = m.x; na.y = m.y;
    ownerSay(na, m.line);   // 台詞招式帶台詞編號（全島同一句）
    return;
  }
  if (m.ev === 'qfire') {   // 台詞招式放出：島主原地不動，範圍與傷害各人自判
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.cycle = null; na.wleg = null; na.fly = false; na.z = 0;
    na.x = m.x; na.y = m.y;
    if (m.skill === 'act' || m.skill === 'still') { startCommandCheck(na, m.skill, m.castMs || OWNER_COMMAND_CAST * 1000); return; }   // 命令檢定：讀條 2 秒後本地判定
    quoteFire(na, m.skill, m.ids, m.x, m.y);
    return;
  }
  if (m.ev === 'command') {   // 壓力山大下達命令：原地讀條（castMs 後本地檢定；行動＝要動、靜止＝不能動）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.wleg = null;
    na.x = m.x; na.y = m.y; na.z = 0;
    if (m.hp != null) na.hp = m.hp;
    startCommandCheck(na, m.kind || 'act', m.castMs || OWNER_COMMAND_CAST * 1000);
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
    toast(facing ? `${mobDef(na.id).name} 睜開了石化之瞳——你正面對她，快轉身背對她！`
                 : `${mobDef(na.id).name} 睜開了石化之瞳——別面向她！`, 2600);
    return;
  }
  if (m.ev === 'beam') {   // 蓋老師凝聚波動砲：原地讀條（castMs 後本地發射；站在光波帶狀範圍裡的人受傷）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.wleg = null;
    na.x = m.x; na.y = m.y; na.z = 0;
    if (m.hp != null) na.hp = m.hp;
    na.dir = m.tx < na.x ? -1 : 1;
    na.beam = { t0ms: Date.now(), castMs: m.castMs || OWNER_BEAM_CAST * 1000,
                from: { x: m.tx, y: m.ty }, x: m.x, y: m.y, bx: m.bx, by: m.by };
    toast(`${mobDef(na.id).name} 凝聚波動砲——別站在砲口前面！`, 2600);
    return;
  }
  if (m.ev === 'wander') {   // 島主往新路點散步（伺服器帶路；插值與伺服器一致，凍結恢復也正確）
    const na = a || dragonEnsure(m.fx, m.fy);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.command = null; na.beam = null;
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
      t0ms: Date.now(), castMs: m.castMs || OWNER_CAST * 1000, restMs: 700,
      dashMs: Math.max(1, Math.hypot(m.dx - m.x, m.dy - m.y) / OWNER_DASH_SPEED * 1000),
      warp: { x: m.x, y: m.y }, from: { x: m.tx, y: m.ty }, dest: { x: m.dx, y: m.dy },
    };
    a.dir = m.tx < a.x ? -1 : 1;
    const me = S.players[0];
    const aimedAtMe = Math.abs(m.tx - me.x) < CELL && Math.abs(m.ty - me.y) < CELL;
    toast(aimedAtMe ? `${mobDef(a.id).name} 瞬間消失，在島緣現出蹤影鎖定了你！`
                    : `${mobDef(a.id).name} 被惹怒了，在島緣鎖定了攻擊者！`, 2400);
    return;
  }
  if (m.ev === 'aggro') {   // 仇恨開始／換人：龍衝冷卻期間改為追殺（id＝被鎖定的連線；追路腿部份照 wander 事件走）
    const ownerName = () => mobDef(S.terrains[S.terrain]?.owner || a?.id || 'gold_dragon')?.name || '島主';
    const r = S.remotes.get(m.id);
    if (a) {
      a.aggro = true; a.wleg = null; a.cast = 0; a.castFrom = null;
      a.fly = false; a.dashU = null; a.cycle = null; a.gaze = null; a.command = null; a.beam = null; a.rest = 0; a.retHome = false;
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
    toast(`${mobDef(S.terrains[S.terrain]?.owner || a?.id || 'gold_dragon')?.name || '島主'} 冷靜下來，繼續散步。`, 1800);
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
      playerDamage(me, OWNER_CLAW_DMG, mobDef(na.id).name);
      S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
    }
    return;
  }
}

// ---- 釣上來的敵對怪物（lurker；fish.json 的 lurker／lurkerChance）----
// 拉竿成功時極低機率釣到：從浮標跳上最近的陸地，追殺釣到牠的人（仇恨換人、爪擊與島主同一套規則），
// 30 秒沒人打就原地消失，被打倒也消失（不重生、沒有獎勵）。連線時由伺服器權威（兩份伺服器的 lurker 系列），
// 客戶端只演出與自判爪擊；單機在這裡本地模擬。強度以一個人打得倒為準：血 20、每 1.5 秒抓一下、每下扣 1。
const LURK_CHASE = 150, LURK_CLAW_RANGE = 30, LURK_CLAW_CD = 1.5, LURK_CLAW_DMG = 1, LURK_DROPOUT = 30;   // 與兩份伺服器的 L_* 一致
const LURK_STALE_MS = 8000;   // 連線時這麼久沒收到牠的任何事件（追殺中最多 1.5 秒就有一則）＝伺服器那邊已經沒了：自己移除
function lurkerNew(mob, x, y, hp, max, proxy) {
  const def = mobDef(mob);
  const a = { id: mob, x, y, dir: 1, target: null, idle: 0, startle: 0, z: 0, bounce: 0,
              hp: hp ?? def.hp, maxHp: max ?? def.hp, dead: false, dieT: 0, lurker: true, proxy, seenMs: Date.now() };
  S.mobs.push(a);
  return a;
}
function lurkerRemove(a, msg) {
  const i = S.mobs.indexOf(a);
  if (i >= 0) S.mobs.splice(i, 1);
  S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
  if (msg) toast(msg, 2200);
}
// 從浮標跳上岸（演出）：0.55 秒拋物線，起點冒水花
function lurkerLeap(a, fx, fy) {
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
  a.jump = { fx, fy, tx: a.x, ty: a.y, t0: S.t, dur: .55 };
  S.floaters.push({ x: fx, y: fy - 10, poof: true, life: .5 });
}
function lurkerSpawnLocal(mob, bx, by) {   // 單機：落在浮標旁最近的陸地，鎖定自己
  if (!mobDef(mob)) return;
  const land = nearestLand({ x: bx, y: by }) || { x: bx, y: by };
  const a = lurkerNew(mob, land.x, land.y, null, null, false);
  a.lastHitAt = S.t; a.clawAt = S.t + LURK_CLAW_CD; a.prey = S.players[0];
  lurkerLeap(a, bx, by);
  toast(`釣上來的不是魚——是${mobDef(mob).name}！快逃或打倒牠！`, 3200);
}
function stepLurker(a, dt, def) {
  if (a.jump) {   // 跳上岸中
    const j = a.jump, q = (S.t - j.t0) / j.dur;
    if (q < 1) {
      a.x = j.fx + (j.tx - j.fx) * q; a.y = j.fy + (j.ty - j.fy) * q; a.z = Math.sin(q * Math.PI) * 46;
      if (j.tx !== j.fx) a.dir = Math.sign(j.tx - j.fx);
      return;
    }
    a.jump = null; a.z = 0;
    if (!a.wleg) { a.x = j.tx; a.y = j.ty; }
  }
  if (a.proxy) {   // 連線：位置跟伺服器的追殺腿插值；太久沒消息＝伺服器那邊已經沒了
    if (Date.now() - (a.seenMs || 0) > LURK_STALE_MS) { lurkerRemove(a); return; }
    if (a.wleg) stepOwnerWalk(a, dt); else a.z = 0;
    return;
  }
  // ---- 單機本地模擬（與伺服器同規則）----
  if (S.t - (a.lastHitAt ?? S.t) > LURK_DROPOUT) { lurkerRemove(a, `${def.name} 失去興趣，潛回水裡消失了。`); return; }
  const t = a.prey;
  if (!t || t.dead) { lurkerRemove(a, `${def.name} 潛回水裡消失了。`); return; }   // 單機只有自己：倒下就沒人可追
  const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy);
  if (d <= LURK_CLAW_RANGE) {
    a.wleg = null; a.z = 0;
    if (dx) a.dir = Math.sign(dx);
    if (S.t >= (a.clawAt ?? 0)) {
      a.clawAt = S.t + LURK_CLAW_CD;
      S.floaters.push({ x: a.x + dx * .45, y: a.y - 20 + dy * .45, ang: Math.atan2(dy, dx), slash: true, life: .45 });
      playerDamage(t, LURK_CLAW_DMG, def.name);
      S.floaters.push({ x: t.x, y: t.y - 24, ring: true, life: .35 });
    }
    return;
  }
  if (a.wleg && Date.now() - a.wleg.t0ms < 600) { stepOwnerWalk(a, dt); return; }   // 每 0.6 秒重新瞄準
  a.wleg = { fx: a.x, fy: a.y, tx: t.x, ty: t.y, tms: Math.max(80, Math.round(d / LURK_CHASE * 1000)), t0ms: Date.now() };
  stepOwnerWalk(a, dt);
}
// 連線：伺服器的怪物事件（spawn/state 快照/none/wander/claw/aggro/hp/dead/gone）
function onNetLurker(m) {
  if (m.terrain && m.terrain !== S.terrain) return;   // 切地形空檔收到的舊島事件
  let a = S.mobs.find(v => v.lurker && !v.dead);
  const me = S.players[0], mine = m.id != null && m.id === S.net?.id;
  if (m.ev === 'none') { if (a) lurkerRemove(a); return; }   // 進場快照：這個地形沒有怪物
  if (m.ev === 'state' || m.ev === 'spawn') {
    if (!mobDef(m.mob)) return;
    if (!a) a = lurkerNew(m.mob, m.x, m.y, m.hp, m.max, true);
    Object.assign(a, { x: m.x, y: m.y, hp: m.hp, maxHp: m.max ?? a.maxHp, proxy: true, seenMs: Date.now(), wleg: null });
    if (m.wleg) a.wleg = { fx: m.wleg.fx, fy: m.wleg.fy, tx: m.wleg.tx, ty: m.wleg.ty, tms: m.wleg.tms, t0ms: Date.now() - (m.wleg.el || 0) };
    if (m.ev === 'spawn') {
      lurkerLeap(a, m.fx, m.fy);
      const nm = mobDef(m.mob).name;
      toast(mine ? `釣上來的不是魚——是${nm}！快逃或打倒牠！` : `${m.name || '有人'} 釣上了${nm}！`, 3200);
    }
    return;
  }
  if (!a) return;   // 沒看過牠（例如剛連線的空檔）：等下一次進場快照
  a.seenMs = Date.now();
  const nm = mobDef(a.id).name;
  if (m.ev === 'hp') { a.hp = m.hp; return; }
  if (m.ev === 'dead') {
    a.dead = true; a.dieT = .6; a.wleg = null; a.jump = null; a.z = 0;
    if (m.x !== undefined) { a.x = m.x; a.y = m.y; }
    S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
    toast(`${nm} 被打倒了！`, 2200);
    return;
  }
  if (m.ev === 'gone') { lurkerRemove(a, `${nm} 失去興趣，潛回水裡消失了。`); return; }
  if (m.ev === 'wander') {
    a.wleg = { fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty, tms: m.tms, t0ms: Date.now() };
    if (!a.jump) { a.x = m.fx; a.y = m.fy; }
    if (m.tx !== m.fx) a.dir = Math.sign(m.tx - m.fx);
    return;
  }
  if (m.ev === 'aggro') {
    const r = S.remotes.get(m.id);
    toast(mine ? `${nm} 改追你了！` : r ? `${nm} 改追 ${r.name}！` : `${nm} 換了追殺目標！`, 2000);
    return;
  }
  if (m.ev === 'claw') {   // 爪擊：抓的是我（或我也貼在旁邊）就扣血（受害者自判，與島主爪擊同一套）
    if (!a.jump) { a.x = m.x; a.y = m.y; }
    a.wleg = null; a.z = 0;
    a.dir = m.tx < m.x ? -1 : 1;
    S.floaters.push({ x: m.x + (m.tx - m.x) * .45, y: m.y - 20 + (m.ty - m.y) * .45, ang: Math.atan2(m.ty - m.y, m.tx - m.x), slash: true, life: .45 });
    if (!me.dead && (mine || Math.hypot(me.x - m.x, me.y - m.y) <= LURK_CLAW_RANGE)) {
      playerDamage(me, LURK_CLAW_DMG, nm);
      S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
    }
  }
}

function stepMob(a, dt) {
  const def = mobDef(a.id);
  if (a.lurker) { stepLurker(a, dt, def); return; }   // 釣上來的敵對怪物
  // 島主：連線時整個狀態機用牆鐘（與伺服器同軸，webview 節流也不影響）；單機沿用 dt 積分
  if (def.owner) {
    if (a.proxy) { stepOwnerProxy(a, dt, def); return; }
    // 單機本地模擬：島主每秒回 OWNER_REGEN 血（連線時血量由伺服器權威，本地不補）
    if (!a.dead && a.hp < a.maxHp) {
      a.regenAcc = (a.regenAcc || 0) + dt * OWNER_REGEN;
      const n = Math.floor(a.regenAcc);
      if (n > 0) { a.regenAcc -= n; a.hp = Math.min(a.maxHp, a.hp + n); }
    }
    if (a.fly || a.cast || a.rest || a.sayPhase || a.quote) { ownerStep(a, dt, def); return; }
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
  if (mobCanStand(def, nx, a.y)) a.x = nx;
  if (mobCanStand(def, a.x, ny)) a.y = ny;
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
    if (!def || !Array.isArray(it.cell)) return;   // manifest 沒有的種類／壞格子：略過（本地舊存檔可能有，別讓 boot 當掉）
    for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++)
      S.occ.set(key(it.cell[0] + dx, it.cell[1] + dy), idx);
  });
}

function furnitureDef(id) { return S.furn.items.find(f => f.id ===id); }

// ---------------- 遮擋 / 碰撞 ----------------
// 格子能不能站人／放家具：陸地，或水上鋪了地板（m＝要看的地板，預設目前畫面上的）
function groundAt(x, y, m = S.floorMap) {
  return !!S.world.types[y * COLS + x] || (!!m && floorAt(m, x, y) >= 0);
}
function blocked(px, py, ignoreFurn) { // 像素座標（腳底）；ignoreFurn＝只看地形（水邊），不管家具
  const x = Math.floor(px / CELL), y = Math.floor(py / CELL);
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true;
  if (!groundAt(x, y)) return true;   // 水（水上鋪了地板的可以走）
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

// 人物＝五層由下往上疊：軀幹（膚色）→ 褲子 → 衣服 → 頭髮 → 帽子。每層一張 sheet，排列＝avatar.json 的 frames（所有層共用同一套幀號，同步切換）
// look：{skin, hair, hat（null＝沒戴）, top／bottom（衣服／褲子款式 id）, shirt／pants（衣服／褲子顏色編號）}；缺的欄位用各類第一項
const CHAR_DIR8 = ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'];
const CHAR_MIRROR = { left: 'right', up_left: 'up_right', down_left: 'down_right', right: 'left', up_right: 'up_left', down_right: 'down_left' };
const lookItem = (list, id) => list?.find(it => it.id === id) || null;
// 換色：素材上「可染色」的原色（avatar.json 各件的 dye，第一個是主色）換成所選顏色；其他可染色的顏色依與主色的明暗比例跟著換
// （比主色暗的乘上比例、比主色亮的往白色推）。舊格式 recolor: {base, shade} 視同 dye: [base, shade]。結果依 (sheet, 顏色) 快取整張
const dyeList = it => it?.dye || (it?.recolor ? [it.recolor.base, it.recolor.shade].filter(Boolean) : null);
const lum = ([r, g, b]) => .299 * r + .587 * g + .114 * b;
function dyeSheet(img, dye, hex) {
  const key = img.src + '|' + dye.join(',') + '|' + hex;
  let cv = S.recolorCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height), p = d.data;
  const T = hexRGB(hex), base = Math.max(1, lum(hexRGB(dye[0])));
  const map = new Map(dye.map(c => {   // 原色（整數 rgb）→ 換成的顏色
    const src = hexRGB(c), k = lum(src) / base;
    const out = T.map(v => Math.round(k <= 1 ? v * k : v + (255 - v) * Math.min(1, k - 1)));
    return [(src[0] << 16) | (src[1] << 8) | src[2], out];
  }));
  for (let i = 0; i < p.length; i += 4) {
    if (!p[i + 3]) continue;
    const o = map.get((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    if (o) { p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; }
  }
  g.putImageData(d, 0, 0);
  S.recolorCache.set(key, cv);
  return cv;
}
// 合成一幀（24×24 之類，大小看 frames.w/h），依 (造型, 幀號) 快取。
// look：{skin, hair, hat, top, bottom（顯示用的款式 id，裝備／外觀已在送出前決定好）, hatC／topC／botC（換色色碼，null＝原色）}；
// 沒有 topC／botC 欄位（NPC、舊格式）就用 shirt／pants 顏色編號（shirtColors／pantsColors）
function charSprite(look, fi) {
  const A = S.avatar, F = A.frames;
  const legacy = (key, idx, list) => key in look ? (look[key] || null) : (list[idx || 0] ?? list[0]);
  const shirtHex = legacy('topC', look.shirt, A.shirtColors), pantsHex = legacy('botC', look.pants, A.pantsColors);
  const hatHex = look.hatC || null;
  const skin = lookItem(A.skins, look.skin) || A.skins[0], hair = lookItem(A.hair, look.hair) || A.hair[0];
  const top = lookItem(A.tops, look.top) || A.tops?.[0], bottom = lookItem(A.bottoms, look.bottom) || A.bottoms?.[0];
  const hat = lookItem(A.hats, look.hat);
  const k = [skin.id, hair.id, hat?.id || '', hatHex, top?.id, shirtHex, bottom?.id, pantsHex, fi].join('|');
  let cv = S.charCache.get(k);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = F.w; cv.height = F.h;
  const g = cv.getContext('2d');
  // 由下往上：軀幹 → 褲子 → 衣服 → 頭髮 → 帽子
  for (const [it, hex] of [[skin], [bottom, pantsHex], [top, shirtHex], [hair], [hat, hatHex]]) {
    const img = it && S.charImgs[it.sheet];
    if (!img || (fi + 1) * F.w > img.width) continue;   // 缺圖／這張 sheet 沒有這一幀：這層略過
    const dye = dyeList(it), src = dye && hex ? dyeSheet(img, dye, hex) : img;
    g.drawImage(src, fi * F.w, 0, F.w, F.h, 0, 0, F.w, F.h);
  }
  S.charCache.set(k, cv);
  return cv;
}
// 8 方向視覺朝向：移動時依 (dx, dy) 的角度取最近的方向（鍵盤 8 向剛好一一對應）；玩法（石化等）仍看 face
function dir8Of(dx, dy) {
  const s = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));   // 扇區：0＝右、2＝下、-2＝上、±4＝左（畫面 y 向下）
  return CHAR_DIR8[((2 - s) % 8 + 8) % 8];
}
// 沒有 d8（舊客戶端／NPC 剛生成）時，從 face＋dir 推
const d8Of = p => p.d8 || (p.face === 'up' ? 'up' : p.face === 'side' ? (p.dir < 0 ? 'left' : 'right') : 'down');
// 這個人現在該畫哪一幀：坐／睡＝sit；否則「朝向_待機或走路」，依遊戲時間循環（每人有自己的起始相位）。
// 幀表沒有這個狀態時：左右對稱的方向改用另一邊再左右翻轉（mirror）；再沒有就退回正上／正下
function charFrame(p) {
  const F = S.avatar.frames, st = F.states;
  if (p.pose) return { fi: (st.sit || st.down_idle)[0], mirror: false };
  const mode = p.moving ? 'walk' : 'idle', d = d8Of(p);
  let list = st[`${d}_${mode}`], mirror = false;
  if (!list && CHAR_MIRROR[d]) { list = st[`${CHAR_MIRROR[d]}_${mode}`]; mirror = !!list; }
  if (!list) list = st[`${d.startsWith('up') ? 'up' : 'down'}_${mode}`] || st.down_idle;
  p.animPhase ??= Math.random() * 4;
  return { fi: list[Math.floor((S.t + p.animPhase) * (F.fps?.[mode] || 6)) % list.length], mirror };
}
// 武器掛點（back／backView／waist／hand）換成相對腳底的畫面座標（2 倍）；frameAnchors 可逐幀覆寫
function charAnchor(fi, kind) {
  const F = S.avatar.frames, a = F.frameAnchors?.[fi]?.[kind] || F.anchors[kind];
  return [(a[0] - F.w / 2) * 2, (a[1] - F.h) * 2];
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
    hp: opts?.npc ? PLAYER_HP : (JOBS[S.me.job]?.hpMax ?? PLAYER_HP),   // 血量上限隨職業（NPC 沒有職業用 PLAYER_HP）                // 血量（爪擊扣 2 歸零倒地；殺動物回 1；NPC 不用）
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

function playerSpriteDiv(p, fi) {
  // NPC 與遠端玩家都有自己的 look；自己（players[0]）則用當前職業的裝備＋外觀（myLook）
  return charSprite(p.look || myLook(), fi);
}
// 武器的圖：拿著職業武器且有選同類型的武器外觀（glam）時畫外觀的圖；玩法（射程、詠唱等）照拿著的武器
function weaponImgFor(wid, wlook) {
  if (!wid || wid === 'hands') return null;
  if (wlook && wlook !== wid) {
    const ws = S.avatar.weapons, g = ws.find(w => w.id === wlook), base = ws.find(w => w.id === wid);
    if (g?.glam && base && g.type === base.type && S.weaponImgs[wlook]) return S.weaponImgs[wlook];
  }
  return S.weaponImgs[wid];
}

// ---- M2：遠端玩家（位置用內插，避免網路抖動造成瞬移）----
function stepRemote(r, dt) {
  const k = Math.min(1, dt * 14);
  const dx = r.tx - r.x, dy = r.ty - r.y;
  r.x += dx * k; r.y += dy * k;
  r.moving = Math.hypot(dx, dy) > 1.5;   // 走路／待機的幀由 charFrame 依時間取
  if (r.moving) r.lastMoveAt = S.t;   // 命令檢定的畫面演出用（真判定在對方自己的畫面）
  if (r.swing > 0) r.swing -= dt;
  r.z += ((r.tz ?? r.z) - r.z) * Math.min(1, dt * 22);   // 跳躍高度追目標（封包 12Hz，這個速度追得上又夠平滑）
}

// ---- 角色死亡：被島主的龍衝撞倒後原地變墓碑，30 秒後復活（NPC／遠端玩家也適用） ----
const DEAD_SECONDS = 30;
function killPlayer(p, cause, label) {   // label：頭上飄字（龍衝撞倒傳 '龍衝'，其餘預設「倒地」）
  if (p.npc || p.remote || p.dead) return;
  p.dead = true; p.deadAt = performance.now();   // 牆鐘毫秒：畫面被凍結（切走 DC）時倒數照樣走
  p.pose = null; p.seatType = null; p.moving = false; p.frame = 0; p.swing = 0; p.tool = null; p.fish = null; p.cast = null;
  S.floaters.push({ x: p.x, y: p.y - 46, v: label || '倒地', life: 1.1, crit: true });
  toast(`${cause} 把你打倒了！${DEAD_SECONDS} 秒後在出生點復活`, 3200);
}
function revivePlayer(p) {
  p.dead = false; p.deadAt = 0;
  p.pose = null; p.seat = null; p.seatType = null;                 // 復活後一定是站著的
  p.hp = hpCap(p);   // 復活即滿血（上限隨職業）
  p.petUntil = 0; p.petTick = 0; p.petWas = false;   // 復活順便清石化（石化時長比死亡短，正常輪不到）
  const [nx, ny] = landNear((COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL);
  p.x = nx; p.y = ny; p.z = 0; p.vz = 0; p.dir = 1; p.d8 = 'down';
  S.floaters.push({ x: p.x, y: p.y - 46, v: '復活！', life: 1.2, crit: true });
  toast('毫髮無傷地復活了！', 1800);
}

// 脫離戰鬥後自動回血（坐著睡著也算；被石化中不回；回血上限隨職業）
function regenPlayer(p, dt) {
  const capHp = hpCap(p);
  if (p.dead || S.t < (p.petUntil ?? 0) || (p.hp ?? capHp) >= capHp || ownerEngaged()) { p.regenAcc = 0; return; }
  p.regenAcc = (p.regenAcc || 0) + dt * PLAYER_REGEN;
  const n = Math.floor(p.regenAcc);
  if (n > 0) { p.regenAcc -= n; p.hp = Math.min(capHp, (p.hp ?? capHp) + n); }
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
  if (stepLeap(p)) return;   // 龍騎士的高跳／後跳中
  if (p.knock) {   // 被鋼鐵擊飛：0.25 秒內往外推（撞到水邊／家具就停），期間不能自己走
    const k = p.knock, st = Math.min(k.left, 640 * dt), nx = p.x + k.ux * st, ny = p.y + k.uy * st;
    if (!blocked(nx, ny)) { p.x = nx; p.y = ny; k.left -= st; } else k.left = 0;
    p.z = Math.max(p.z, 10 * Math.sin(Math.PI * Math.min(1, 1 - k.left / QUOTE.iron.kb)));
    if (k.left <= 0) { p.knock = null; p.z = 0; }
    p.moving = false;
    return;
  }
  // 腳下的水上地板被拆掉（自己或別人）：挪到最近能站的地方，不會泡在水裡動不了
  if (p === S.players[0] && blocked(p.x, p.y, true)) [p.x, p.y] = landNear(p.x, p.y);
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
  if (p.moving) p.lastMoveAt = S.t;   // 命令檢定用（行動命令／靜止命令）：最後一次有移動輸入的時間
  // 釣魚中（拉扯以外）：可以走、可以跳，離浮標太遠（FISH_LEASH）才收竿；換掉釣竿、進裝飾模式、被石化也會收竿
  if (p.fish && !reeling) {
    if (Math.hypot(p.fish.x - p.x, p.fish.y - p.y) > FISH_LEASH) stopFishing(p, '離浮標太遠，收竿了');
    else if (S.mode !== 'walk' || !isRod() || pet) stopFishing(p);
  }
  stepFishing(p);
  if (p === S.players[0]) stepCast(p);
  if (p.moving) {
    if (S.mode === 'walk' && S.mouseHeld && S.mouseClient) {   // 按住滑鼠攻擊時，面向跟著游標（可以一邊朝右攻擊一邊往左退）
      const wx = S.mouseClient[0] - canvas.getBoundingClientRect().left + S.cam.x;
      if (Math.abs(wx - p.x) > 6) p.dir = Math.sign(wx - p.x);
      p.face = 'side'; p.d8 = p.dir < 0 ? 'left' : 'right';
    } else {   // 朝向：有往上的分量（含斜上）＝背面、只往下＝正面、其餘有左右分量（左右、斜下）＝側（dir 左右）；站著不動維持上次的朝向
      if (dx !== 0) p.dir = dx;
      p.face = dy < 0 ? 'up' : dx !== 0 ? 'side' : 'down';
      p.d8 = dir8Of(dx, dy);   // 畫面用的 8 方向（玩法仍看 face）
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
  if (p.swing > 0) { p.swing -= dt; p.face = 'side'; p.d8 = p.dir < 0 ? 'left' : 'right'; }   // 揮擊／採集是朝左右揮，轉成側面
  if (p.fish) {   // 釣魚中走動：身體一直面向浮標（倒退著走），釣竿才會指著浮標、釣線不會從背後繞過去
    if (Math.abs(p.fish.x - p.x) > 4) p.dir = Math.sign(p.fish.x - p.x);
    p.face = 'side'; p.d8 = p.dir < 0 ? 'left' : 'right';
  }
  if (p.tool && S.t > p.toolUntil && !(p.swing > 0)) p.tool = null;
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
  p.d8 = dir8Of(dx, dy);   // NPC 也用 8 方向的幀（往上走會看到背面）
  const nx = clamp(p.x + dx / len * sp, 8, COLS * CELL - 8), ny = clamp(p.y + dy / len * sp, 8, ROWS * CELL - 8);
  if (!blocked(nx, p.y)) p.x = nx;
  if (!blocked(p.x, ny)) p.y = ny;
  if (Math.random() < .002) p.idle = .8 + Math.random() * 1.6;
}

// 畫一個人（本人/NPC/同島玩家共用）：影子、身體（站/坐/睡）、武器、名牌。ctx 在世界座標
// ---------------- 技能特效（全部程式畫的 placeholder；之後可以逐一換成 manifest 的多幀素材）----------------
// 人物身上的持續效果：ctx 已平移到腳底（身體約 y=-48～0）；phase＝'back'（畫在身體後面）／'front'（畫在身體前面）
function drawPersonFx(p, fx, backView, phase) {
  const has = k => fx.includes(k), t = S.t, dir = p.dir < 0 ? -1 : 1;
  if (has('wings') && (phase === 'back') !== backView) {   // 翅膀：正面時在身後，背面時疊在身上
    const flap = Math.sin(t * 6) * .18;
    ctx.save(); ctx.translate(0, -30);
    for (const s of [-1, 1]) {
      ctx.save(); ctx.scale(s, 1); ctx.rotate(-flap);
      ctx.fillStyle = 'rgba(250,250,255,.92)'; ctx.strokeStyle = 'rgba(150,170,210,.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.quadraticCurveTo(14, -22, 26, -16); ctx.quadraticCurveTo(22, -8, 25, -4);
      ctx.quadraticCurveTo(19, -2, 22, 4); ctx.quadraticCurveTo(14, 4, 15, 10); ctx.quadraticCurveTo(8, 6, 2, 4); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    if (phase === 'front' || !backView) for (let i = 0; i < 2; i++) {   // 飄落的羽毛
      const q = (t * .6 + i * .5) % 1, fx2 = Math.sin((t + i) * 3) * 10 + (i ? 12 : -12);
      ctx.fillStyle = `rgba(255,255,255,${.8 * (1 - q)})`;
      ctx.beginPath(); ctx.ellipse(fx2, -40 + q * 40, 2.5, 1.2, q * 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (phase !== 'front') return;
  if (has('wshield')) {   // 戰士群盾：橘紅色外框
    const pul = .5 + .5 * Math.sin(t * 5);
    ctx.strokeStyle = `rgba(255,150,70,${.45 + .3 * pul})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, -22, 15, 26, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (has('kshield')) {   // 騎士群盾：藍色泡泡
    const pul = .5 + .5 * Math.sin(t * 3);
    ctx.fillStyle = `rgba(150,200,255,${.12 + .06 * pul})`; ctx.strokeStyle = `rgba(190,225,255,${.6 + .3 * pul})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, -24, 19, 28, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(-8, -40, 3, 5, -.5, 0, Math.PI * 2); ctx.fill();
  }
  if (has('guard')) {   // 騎士單盾：身前一面半透明盾形光
    ctx.save(); ctx.translate(dir * 15, -24); ctx.globalAlpha = .55 + .2 * Math.sin(t * 4);
    ctx.fillStyle = 'rgba(140,190,255,.8)'; ctx.strokeStyle = '#e8f2ff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-6, -11); ctx.lineTo(6, -11); ctx.lineTo(6, 2); ctx.quadraticCurveTo(6, 9, 0, 12); ctx.quadraticCurveTo(-6, 9, -6, 2); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.fillStyle = '#e0b840'; ctx.fillRect(-1, -8, 2, 14); ctx.fillRect(-4, -4, 8, 2);
    ctx.restore();
  }
  if (has('vamp')) for (let i = 0; i < 4; i++) {   // 戰士吸血：身邊冒起的紅色光點
    const q = (t * .8 + i * .25) % 1, x = Math.sin(i * 2.1 + t) * 13;
    ctx.fillStyle = `rgba(230,50,60,${.75 * (1 - q)})`;
    ctx.beginPath(); ctx.arc(x, -6 - q * 40, 2, 0, Math.PI * 2); ctx.fill();
  }
  if (has('song')) for (let i = 0; i < 3; i++) {   // 唱歌加成中：身邊飄著音符
    const q = (t * .5 + i / 3) % 1, x = Math.sin(i * 2 + t * 1.5) * 16;
    drawNote(x, -20 - q * 34, `rgba(255,225,120,${.9 * (1 - q)})`);
  }
  if (has('save')) {   // 拯救中：腳下一圈金色光環
    ctx.strokeStyle = `rgba(255,215,110,${.55 + .3 * Math.sin(t * 6)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (has('cared')) drawHeart(-dir * 16, -40 + Math.sin(t * 3) * 2, 4.5, 'rgba(255,130,170,.95)');   // 被賢者關心中
  const tri = fx.find(k => /^triple\d$/.test(k));
  if (tri) {   // 三重：身邊繞著剩下幾次的光球
    const n = +tri.slice(6);
    for (let i = 0; i < n; i++) {
      const an = t * 2.4 + i * Math.PI * 2 / 3, x = Math.cos(an) * 18, y = -26 + Math.sin(an) * 7;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 6);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(170,110,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (has('seal')) {   // 忍術結印：頭旁依序浮出三個手印符號（自創）
    const own = p === S.players[0] && S.fx.seal, q = own ? Math.min(.999, (t - S.fx.seal.t0) / JOB_SKILLS.ninjutsu.cast) : (t * .67) % 1;
    const k = Math.floor(q * 3);
    for (let i = 0; i <= k; i++) drawSealGlyph(dir * 22, -44 + (i - k) * 3, i, i === k ? (q * 3) % 1 : 1);
  }
}
function drawSealGlyph(x, y, kind, a) {   // 三款自創手印符號：方印、交叉、三角
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = Math.min(1, a * 2);
  ctx.fillStyle = 'rgba(30,20,50,.7)'; ctx.fillRect(-7, -7, 14, 14);
  ctx.strokeStyle = '#e8d0ff'; ctx.lineWidth = 1.5; ctx.strokeRect(-7, -7, 14, 14);
  ctx.strokeStyle = '#ff8a8a'; ctx.beginPath();
  if (kind === 0) { ctx.rect(-3, -3, 6, 6); }
  else if (kind === 1) { ctx.moveTo(-4, -4); ctx.lineTo(4, 4); ctx.moveTo(4, -4); ctx.lineTo(-4, 4); }
  else { ctx.moveTo(0, -5); ctx.lineTo(5, 4); ctx.lineTo(-5, 4); ctx.closePath(); }
  ctx.stroke(); ctx.restore();
}
function drawMagicCircle(x, y, left) {   // 黑魔法師的魔法陣：慢慢自轉的紫色雙圈＋星形＋符文點；最後 2 秒閃爍
  const R = JOB_SKILLS.circle.r, rot = S.t * .5, al = left < 2 ? .4 + .4 * Math.abs(Math.sin(S.t * 8)) : .8;
  ctx.save(); ctx.translate(x, y); ctx.scale(1, .5);   // 壓扁成地上的橢圓
  ctx.globalAlpha = al;
  ctx.fillStyle = 'rgba(150,90,255,.12)'; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#b88aff'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, R * .72, 0, Math.PI * 2); ctx.stroke();
  ctx.rotate(rot);
  ctx.beginPath(); for (let i = 0; i <= 5; i++) { const an = i * Math.PI * 4 / 5; ctx.lineTo(Math.cos(an) * R * .72, Math.sin(an) * R * .72); } ctx.stroke();
  ctx.fillStyle = '#e0c8ff';
  for (let i = 0; i < 12; i++) { const an = i * Math.PI / 6; ctx.fillRect(Math.cos(an) * R * .86 - 2, Math.sin(an) * R * .86 - 2, 4, 4); }
  ctx.restore();
}
function drawPoison(x, y, W, H) {   // 毒箭：身上冒起紫綠色毒泡泡（只有射毒箭的人自己看得到）
  for (let i = 0; i < 6; i++) {
    const q = (S.t * .7 + i / 6) % 1, bx = x + Math.sin(i * 2.3 + S.t) * W * .28, by = y - H * .2 - q * H * .6;
    ctx.fillStyle = i % 2 ? `rgba(150,220,90,${.75 * (1 - q)})` : `rgba(170,90,210,${.75 * (1 - q)})`;
    ctx.beginPath(); ctx.arc(bx, by, 2.5 + (i % 3), 0, Math.PI * 2); ctx.fill();
  }
}
function drawNote(x, y, col) {   // 八分音符
  ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(x, y, 3, 2.2, -.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + 2.6, y - 1); ctx.lineTo(x + 2.6, y - 10); ctx.quadraticCurveTo(x + 6, y - 8, x + 6, y - 5); ctx.stroke();
}
function drawHeart(x, y, s, col) {
  ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(x, y + s * .9);
  ctx.bezierCurveTo(x - s * 1.4, y - s * .1, x - s * .6, y - s * 1.1, x, y - s * .35);
  ctx.bezierCurveTo(x + s * .6, y - s * 1.1, x + s * 1.4, y - s * .1, x, y + s * .9);
  ctx.fill();
}
function drawOwnerDebuff(a, W, H) {   // 島主身上：破綻＝紅色裂紋閃爍、降傷＝紫灰色的霧
  const cy = a.y - a.z - H * .45, s = Math.max(1, W / 120);
  if (S.t < (a.vulnUntil ?? 0) && (S.t * 3 | 0) % 2 === 0) {
    ctx.save(); ctx.translate(a.x, cy); ctx.scale(s, s);
    ctx.strokeStyle = 'rgba(255,90,70,.9)'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-4, -22); ctx.lineTo(-10, -8); ctx.lineTo(2, 0); ctx.lineTo(-6, 14); ctx.lineTo(0, 24);
    ctx.moveTo(2, 0); ctx.lineTo(14, -4); ctx.moveTo(-10, -8); ctx.lineTo(-20, -10); ctx.stroke();
    ctx.restore();
  }
  if (S.t < (a.weakUntil ?? 0)) {
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const an = S.t * .7 + i * .9, x = a.x + Math.cos(an) * W * .32, y = cy + Math.sin(an * 1.3) * H * .25;
      ctx.fillStyle = `rgba(150,120,190,${.16 + .06 * Math.sin(S.t * 2 + i)})`;
      ctx.beginPath(); ctx.arc(x, y, 14 * s, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
// 瞬間特效（S.floaters 裡帶 fxk 的；ctx 在世界座標、外層已 save/restore）
function drawFxFloater(f) {
  const L = { jumpboom: .5, arrow: .2, song: .7, poisonpop: .6, heart: .6, sheal: .5, smoke: .5, after: .6, boom: .6, kshield: .6, wshield: .6, pop: .6, shout: .5, crack: .8, fog: .8, drain: .4 }[f.fxk] || .5;
  const q = Math.min(1, Math.max(0, 1 - f.life / L)), al = 1 - q;
  switch (f.fxk) {
    case 'jumpboom': {   // 高跳落地：藍白色衝擊圈＋往外噴的碎片
      ctx.save(); ctx.translate(f.x, f.y); ctx.scale(1, .45);
      ctx.strokeStyle = `rgba(170,200,255,${al})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, 10 + q * 46, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      for (let i = 0; i < 8; i++) {
        const an = i * Math.PI / 4 + .3, r = 8 + q * 34;
        ctx.fillStyle = `rgba(230,240,255,${al})`;
        ctx.fillRect(f.x + Math.cos(an) * r - 2, f.y - 10 + Math.sin(an) * r * .5 - q * 12, 4, 4);
      }
      break;
    }
    case 'arrow': {   // 豎琴弓的箭／毒箭（綠色箭羽）：從弓飛向目標
      const x = f.x1 + (f.x2 - f.x1) * q, y = f.y1 + (f.y2 - f.y1) * q, ang = Math.atan2(f.y2 - f.y1, f.x2 - f.x1);
      ctx.translate(x, y); ctx.rotate(ang);
      ctx.strokeStyle = '#e8d8b0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(4, 0); ctx.stroke();
      ctx.fillStyle = '#dfe6ec'; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(3, -3); ctx.lineTo(3, 3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = f.poison ? '#9ad850' : '#c83a3a'; ctx.fillRect(-15, -3, 4, 2); ctx.fillRect(-15, 1, 4, 2);
      break;
    }
    case 'song': {   // 唱歌：音符往外散開到範圍邊緣
      ctx.save(); ctx.translate(f.x, f.y); ctx.scale(1, .5);
      ctx.strokeStyle = `rgba(255,225,120,${.6 * al})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 12 + q * (f.r - 12), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      for (let i = 0; i < 8; i++) {
        const an = i * Math.PI / 4, r = 10 + q * 60;
        drawNote(f.x + Math.cos(an) * r, f.y - 30 + Math.sin(an) * r * .5, `rgba(255,225,120,${al})`);
      }
      break;
    }
    case 'poisonpop': {   // 毒箭：命中處一圈紫綠色毒霧
      for (let i = 0; i < 7; i++) {
        const an = i * Math.PI * 2 / 7, r = (8 + q * 18) * Math.max(1, f.big * .6);
        ctx.fillStyle = i % 2 ? `rgba(150,220,90,${.6 * al})` : `rgba(170,90,210,${.6 * al})`;
        ctx.beginPath(); ctx.arc(f.x + Math.cos(an) * r, f.y + Math.sin(an) * r * .6, 5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'heart': {   // 關心：一顆愛心從賢者飄向對方
      const x = f.x1 + (f.x2 - f.x1) * q, y = f.y1 + (f.y2 - f.y1) * q - Math.sin(q * Math.PI) * 18;
      drawHeart(x, y, 5 + 2 * Math.sin(q * Math.PI), `rgba(255,130,170,${Math.min(1, al * 1.5)})`);
      break;
    }
    case 'sheal': {   // 單補：放的人到目標一道綠光，目標身上綠色十字光往上飄
      ctx.globalCompositeOperation = 'lighter';
      const self = Math.hypot(f.x2 - f.x1, f.y2 - f.y1) < 20;
      if (!self) {
        ctx.strokeStyle = `rgba(140,240,160,${.85 * al})`; ctx.lineWidth = 3 * al + 1; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
      }
      ctx.translate(f.x2, f.y2 - q * 14);
      const s = 8 + q * 10;
      ctx.fillStyle = `rgba(150,255,170,${al})`;
      ctx.fillRect(-s, -2.5, s * 2, 5); ctx.fillRect(-2.5, -s, 5, s * 2);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.6); g.addColorStop(0, `rgba(200,255,210,${.7 * al})`); g.addColorStop(1, 'rgba(120,230,150,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, s * 1.6, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'smoke':   // 縮地的煙
      for (let i = 0; i < 6; i++) {
        const an = i * Math.PI / 3, r = 6 + q * 16;
        ctx.fillStyle = `rgba(220,220,230,${.7 * al})`;
        ctx.beginPath(); ctx.arc(f.x + Math.cos(an) * r, f.y - 14 + Math.sin(an) * r * .6, 6 + q * 4, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'after': {   // 縮地殘影：自己的身影淡淡留在原地
      const F = S.avatar.frames, fi = (F.states[`${f.d8}_idle`] || F.states.down_idle)[0];
      ctx.globalAlpha = .4 * al; ctx.filter = 'brightness(1.6) saturate(.3)';
      ctx.drawImage(charSprite(myLook(), fi), f.x - F.w, f.y - F.h * 2, F.w * 2, F.h * 2);
      break;
    }
    case 'boom': {   // 忍術：範圍圈＋紫紅色煙爆
      ctx.save(); ctx.translate(f.x, f.y); ctx.scale(1, .5);
      ctx.strokeStyle = `rgba(255,120,160,${al})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, f.r * (.4 + .6 * q), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      for (let i = 0; i < 9; i++) {
        const an = i * Math.PI * 2 / 9, r = f.r * .7 * q;
        ctx.fillStyle = i % 2 ? `rgba(190,90,220,${.6 * al})` : `rgba(255,110,110,${.6 * al})`;
        ctx.beginPath(); ctx.arc(f.x + Math.cos(an) * r, f.y - 18 + Math.sin(an) * r * .5, 9 + q * 6, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'kshield': case 'wshield': {   // 群盾：從放的人腳下擴散到範圍邊緣的波
      ctx.translate(f.x, f.y); ctx.scale(1, .5);
      ctx.strokeStyle = f.fxk === 'kshield' ? `rgba(160,210,255,${.8 * al})` : `rgba(255,150,70,${.8 * al})`;
      ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 12 + q * (f.r - 12), 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'pop': {   // 放出瞬間的小光環（顏色看技能）
      const col = { guard: '140,190,255', kshield: '180,220,255', vamp: '230,60,70', wings: '255,255,255', triple: '190,130,255', save: '255,215,110' }[f.kind] || '255,255,255';
      ctx.strokeStyle = `rgba(${col},${al})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(f.x, f.y - 24, 10 + q * 18, 16 + q * 18, 0, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'shout':   // 放職能技能的人：挑釁＝紅「!」、破綻＝紅色斬痕、降傷＝紫色波
      ctx.translate(f.x, f.y - 30);
      if (f.kind === 'weak') { ctx.strokeStyle = `rgba(180,140,230,${al})`; ctx.lineWidth = 2; for (const r of [10, 18]) { ctx.beginPath(); ctx.arc(0, 0, r + q * 14, 0, Math.PI * 2); ctx.stroke(); } }
      else if (f.kind === 'vuln') { ctx.strokeStyle = `rgba(255,90,70,${al})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-14 + q * 6, -14); ctx.lineTo(14, 14); ctx.moveTo(14 - q * 6, -14); ctx.lineTo(-14, 14); ctx.stroke(); }
      else { ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(255,90,70,${al})`; ctx.fillText('!', 0, -24 - q * 8); }
      break;
    case 'crack':   // 破綻剛下：島主身上裂開一下
      ctx.translate(f.x, f.y); ctx.scale(f.big * .8, f.big * .8);
      ctx.strokeStyle = `rgba(255,90,70,${al})`; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-6, -24); ctx.lineTo(-12, -8); ctx.lineTo(4, 0); ctx.lineTo(-8, 16); ctx.lineTo(0, 26); ctx.stroke();
      ctx.font = 'bold 14px "Microsoft JhengHei"'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(255,220,200,${al})`; ctx.fillText('破綻', 0, -32 - q * 10);
      break;
    case 'fog':     // 降傷剛下：島主身上罩一陣紫霧
      for (let i = 0; i < 8; i++) {
        const an = i * Math.PI / 4, r = (20 + q * 30) * f.big * .6;
        ctx.fillStyle = `rgba(160,130,200,${.5 * al})`;
        ctx.beginPath(); ctx.arc(f.x + Math.cos(an) * r, f.y + Math.sin(an) * r * .6, 12 * f.big * .5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'drain': {  // 吸血：紅色光點從敵人飛回自己
      const x = f.x1 + (f.x2 - f.x1) * q, y = f.y1 + (f.y2 - f.y1) * q - Math.sin(q * Math.PI) * 20;
      ctx.fillStyle = `rgba(240,60,70,${.9})`; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
}

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
    const cf = charFrame(p), img = playerSpriteDiv(p, cf.fi), F = S.avatar.frames;   // 方向已畫在幀裡，只有借用另一邊的幀時才左右翻轉
    charAnch = { back: charAnchor(cf.fi, 'back'), backView: charAnchor(cf.fi, 'backView'), waist: charAnchor(cf.fi, 'waist'), hand: charAnchor(cf.fi, 'hand') };
    const pet = S.t < (p.petUntil ?? 0);   // 石化：身體灰階（自己的石化即時同步；遠端玩家的石化由光束事件就地推斷，純演出）
    if (pet) { ctx.save(); ctx.filter = 'grayscale(1) brightness(.92)'; }
    ctx.save(); ctx.translate(p.x, p.y - p.z);
    // 武器（背在背上／掛在腰間；揮擊時畫在身前）；坐著時不拿；釣魚時釣竿拋向前方
    const fish = wi && !pose && p.fish ? p.fish : null;
    const carry = wi && !pose && !fish && !(p.swing > 0) && !p.cast;   // 不拿在手上（詠唱中高舉法杖）
    const backView = d8Of(p).startsWith('up');                // 背面（往上、斜上）：背著的武器疊在身體上面，其餘方向被身體擋住
    // 掛著的武器畫在左右翻轉之外：固定在同一側，人物轉向時不會跟著換邊
    const drawCarry = onBack => wi.carry === 'waist' ? drawWeaponWaist(wi) : drawWeaponBack(wi, onBack);
    if (carry && !backView) drawCarry(false);
    const pfx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);   // 技能效果（自己看本地狀態，別人看 state 同步的 fx）
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'back');
    ctx.save();
    if (cf.mirror) ctx.scale(-1, 1);
    ctx.drawImage(img, -F.w, -F.h * 2, F.w * 2, F.h * 2);   // 錨點＝腳底中央，畫 2 倍
    ctx.restore();
    if (carry && backView) drawCarry(true);
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'front');
    if (p.dir < 0) ctx.scale(-1, 1);                          // 揮擊、拋竿朝面向那側（要翻轉）
    if (wi && !pose && !fish && p.swing > 0) drawWeaponSwing(wi, p.swing, p.dir < 0 ? -1 : 1);
    if (fish) drawRodCast(wi, rodAngle(fish));
    if (wi && !pose && !fish && p.cast) drawStaffRaise(wi, Math.min(1, (S.t - p.cast.t0) / p.cast.dur));
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
  // 稱號：名字正上方一行《稱號》（自己看 S.me.title，同島的人看 state 同步來的 id）；有稱號時，泡泡／倒數條／「!」跟著往上移
  const tt = p.npc ? null : titleText(p === S.players[0] ? S.me.title : p.title);
  let headY = nameY;
  if (tt) {
    headY = nameY - 12;
    ctx.font = '9px "Microsoft JhengHei"';
    ctx.strokeText(tt, p.x, headY);
    ctx.fillStyle = '#f0dc9a'; ctx.fillText(tt, p.x, headY);
    ctx.font = '10px "Microsoft JhengHei"';   // 職業圓點的位置要用名字的字型量寬
  }
  if (p.cast) drawCastBar(p.x, headY - 30, (S.t - p.cast.t0) / p.cast.dur, '詠唱');   // 詠唱倒數條（同島島主的招式條同一個樣式）
  const jd = jobOf(p);
  if (jd) {   // 職業小圓點（FF14 職業徽章的簡化）：名牌左邊一顆角色色圓點
    const px = p.x - ctx.measureText(p.name).width / 2 - 9;
    ctx.beginPath(); ctx.arc(px, nameY - 3, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = jd.color; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(8,10,14,.8)'; ctx.stroke();
  }
  // 血量條（掉血才畫，名牌正下方）：爪擊扣 2、殺動物回 1、龍衝直接倒地（上限隨職業）
  const capHp = (!p.npc && p.hp != null) ? hpCap(p) : 0;
  if (capHp && p.hp < capHp) {
    const bw = 30, by = nameY + 3;
    ctx.fillStyle = 'rgba(8,10,14,.72)'; ctx.fillRect(p.x - bw / 2, by, bw, 3);
    ctx.fillStyle = '#e07a68'; ctx.fillRect(p.x - bw / 2 + 1, by + 1, Math.max(0, (bw - 2) * p.hp / capHp), 1.6);
  }
  if (S.t < (p.petUntil ?? 0)) {   // 石化倒數：名牌（與血條）下方顯示還剩幾秒
    const ty = nameY + (!p.npc && p.hp != null && p.hp < hpCap(p) ? 16 : 12), txt = `石化 ${Math.ceil(p.petUntil - S.t)}`;
    ctx.font = 'bold 10px "Microsoft JhengHei"'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#9ff0b4';
    ctx.strokeText(txt, p.x, ty); ctx.fillText(txt, p.x, ty);
  }
  if (p.say && S.t < p.say.until) drawBubble(p.x, headY - 14, p.say.text, Math.min(1, (p.say.until - S.t) / .4));
  else if (p.fish?.ph === 'bite') {   // 魚上鉤：頭上跳動的「!」（同地形的人也看得到）
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
    const yy = headY - 14 - Math.abs(Math.sin(S.t * 10)) * 4;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.9)'; ctx.fillStyle = '#ffd84a';
    ctx.strokeText('!', p.x, yy); ctx.fillText('!', p.x, yy);
  } else if (p.guide) {   // 嚮導頭上有個會晃動的「？」，提示可以問他
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    const yy = nameY - 14 + Math.sin(S.t * 4) * 2;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#ffd86b';
    ctx.strokeText('?', p.x, yy); ctx.fillText('?', p.x, yy);
  }
}
// 波動砲的預警：從島主朝攻擊者方向畫一道跟島主同寬的帶狀範圍（讀條越滿越亮）；砲口有充能亮核
function drawBeamWarn(cx, cy, ux, uy, L, W, frac, pul) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(uy, ux));
  const half = W / 2, grow = .35 + .65 * frac;
  ctx.fillStyle = `rgba(120,200,255,${(.06 + .12 * frac) * (.75 + .25 * pul)})`;
  ctx.fillRect(0, -half, L, half * 2);
  ctx.strokeStyle = `rgba(190,240,255,${.25 + .45 * frac})`;
  ctx.lineWidth = 1.5; ctx.setLineDash([14, 12]);
  ctx.beginPath(); ctx.moveTo(0, -half); ctx.lineTo(L, -half); ctx.moveTo(0, half); ctx.lineTo(L, half); ctx.stroke();
  ctx.setLineDash([]);
  const ch = L * .28 * grow, grd = ctx.createLinearGradient(0, 0, ch, 0);
  grd.addColorStop(0, `rgba(255,255,255,${.15 + .7 * frac})`);
  grd.addColorStop(1, 'rgba(150,220,255,0)');
  ctx.fillStyle = grd; ctx.fillRect(0, -half * .5, ch, half);
  ctx.restore();
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
  const F = S.avatar.frames, img = playerSpriteDiv(p, (F.states.down_idle || [0])[0]);   // 用正面待機的第 1 幀切出頭與肩膀
  ctx.drawImage(img, F.w / 2 - 8, 2, 16, 11, p.x - 16, p.y - 33, 32, 22);   // 頭的水平中心對準枕頭（單人床中央）
  const def = furnitureDef(p.seatType || 'bed'), bed = S.furnImgs[p.seatType || 'bed'];
  if (bed && def?.quiltRow) {   // 被子：從床的「同一幀」切出被子那幾列蓋回去（床有動畫時才對得上）
    const rows = bed.height - def.quiltRow, fi = sprFrame(bed, p.seat ? cellPhase(p.seat.cell[0], p.seat.cell[1]) : 0);
    ctx.drawImage(bed.img, fi * bed.fw, def.quiltRow, bed.fw, rows, p.x - bed.width, p.y - rows * 2, bed.width * 2, rows * 2);
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
  n.d8 = n.dir < 0 ? 'left' : 'right';   // 轉向玩家
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
// 放招倒數條：中心 (cx, y)（條的上緣），frac＝進度（0→1，黃色由左往右填，填滿就放招），name＝右上角的招式名稱
function drawCastBar(cx, y, frac, name) {
  const w = 72, h = 6, x = Math.round(cx - w / 2);
  frac = Math.max(0, Math.min(1, frac));
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,.78)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);   // 底
  ctx.fillStyle = '#f3c93e'; ctx.fillRect(x, y, w * frac, h);                      // 黃色倒數
  ctx.fillStyle = 'rgba(255,246,200,.55)'; ctx.fillRect(x, y, w * frac, 2);        // 上緣亮線
  ctx.strokeStyle = 'rgba(214,180,96,.9)'; ctx.lineWidth = 1; ctx.strokeRect(x - .5, y - .5, w + 1, h + 1);   // 細金邊
  if (name) {
    ctx.font = 'bold 11px "Microsoft JhengHei"'; ctx.textAlign = 'right';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
    ctx.strokeText(name, x + w, y - 3);
    ctx.fillStyle = '#ffe08a'; ctx.fillText(name, x + w, y - 3);
  }
  ctx.restore();
}
function drawBubble(x, y, text, alpha) {
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = '11px "Microsoft JhengHei"'; ctx.textAlign = 'center';
  const rows = String(text).split(String.fromCharCode(10));   // 台詞裡的換行字元＝泡泡內換行（島主的長台詞用）；單行跟以前一樣
  const w = Math.ceil(Math.max(...rows.map(r => ctx.measureText(r).width))) + 14, h = 5 + rows.length * 13, bx = Math.round(x - w / 2), by = Math.round(y - h);
  ctx.fillStyle = 'rgba(252,250,242,.96)'; ctx.strokeStyle = 'rgba(30,24,22,.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 5); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x, by + h + 5); ctx.lineTo(x + 4, by + h); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(252,250,242,.96)'; ctx.fillRect(x - 3, by + h - 1, 6, 2);       // 蓋掉尾巴與泡泡相接的線
  ctx.fillStyle = '#2a2420'; rows.forEach((r, i) => ctx.fillText(r, x, by + 13 + i * 13));
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
  p.pose = def.use; p.seat = { type: it.type, cell: [it.cell[0], it.cell[1]] }; p.seatType = it.type; p.face = 'down'; p.d8 = 'down';
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
// 用左上角武器列把武器換成釣竿（avatar.json 的 fishing: true）後，面向水邊按 F 或點水面就拋竿：浮標在水面上下飄，
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
  return x >= 0 && y >= 0 && x < COLS && y < ROWS && S.world.types[y * COLS + x] === 0 && !(S.floorMap && floorAt(S.floorMap, x, y) >= 0);   // 鋪了地板的水面不能拋竿
};
const fishDef = (terrain, id) => S.fishDB?.terrains[terrain]?.find(f => f.id === id);
// 沿 (ux,uy) 方向找拋竿範圍內第一片水，再往外一點（外面也是水的話）；沒有回 null
function castRay(p, ux, uy) {
  for (let r = FISH_RANGE[0]; r <= FISH_RANGE[1]; r += 8) {
    if (isWater(p.x + ux * r, p.y + uy * r)) {
      const r2 = r + 20 <= FISH_RANGE[1] && isWater(p.x + ux * (r + 20), p.y + uy * (r + 20)) ? r + 20 : r;
      return { x: p.x + ux * r2, y: p.y + uy * r2 };
    }
  }
  return null;
}
// 拋竿落點（只要人在水邊，不必點得很準）：
// 1) 點擊且點到範圍內的水面 → 就拋到那裡；2) 朝想拋的方向（點擊＝游標方向；F＝面向）找範圍內的水；
// 3) 那個方向沒有水 → 身邊各方向找，挑最接近想拋方向的水面；都沒有才提示
function castPoint(p, wx, wy) {
  const click = wx !== undefined;
  if (click && isWater(wx, wy) && Math.hypot(wx - p.x, wy - p.y) <= FISH_RANGE[1]) return { x: wx, y: wy };
  let ux, uy;
  if (click && Math.hypot(wx - p.x, wy - p.y) > 1) { const d = Math.hypot(wx - p.x, wy - p.y); ux = (wx - p.x) / d; uy = (wy - p.y) / d; }
  else [ux, uy] = facingVec(p);
  const hit = castRay(p, ux, uy);
  if (hit) return hit;
  const want = Math.atan2(uy, ux);
  let best = null, bestDiff = Infinity;
  for (let k = 0; k < 24; k++) {                       // 每 15° 一個方向
    const a = k * Math.PI / 12, pt = castRay(p, Math.cos(a), Math.sin(a));
    if (!pt) continue;
    const diff = Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want)));
    if (diff < bestDiff) { bestDiff = diff; best = pt; }
  }
  if (!best) say('附近沒有水，走到水邊再拋竿');
  return best;
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
    else f.result = rollFish(S.terrain, f);
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
function rollFish(terrain, bob) {
  const db = S.fishDB, list = db?.terrains[terrain] || [];
  if (!list.length || Math.random() < db.escape) return { terrain, escaped: true };
  // 極低機率釣到敵對怪物（場上已經有一隻就照常釣魚）；與兩份伺服器的 fishCatch 同規則
  if (db.lurker && mobDef(db.lurker) && !S.mobs.some(v => v.lurker && !v.dead) && Math.random() < (db.lurkerChance || 0))
    return { terrain, lurker: db.lurker, bx: bob?.x, by: bob?.y };
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
  if (m.lurker) {   // 釣到的是怪物：連線時伺服器已廣播 spawn（牠已經跳上岸了），單機在這裡生成
    if (!netOn()) lurkerSpawnLocal(m.lurker, m.bx ?? p.x, m.by ?? p.y);
    return;
  }
  const def = fishDef(m.terrain, m.id), rar = S.fishDB.rarity[m.rarity];
  if (!def) return;
  const { isNew, isRecord } = recordCatch(m);
  if (S.fishImgs[m.id]) S.floaters.push({ x: p.x, y: p.y - 64, fishImg: S.fishImgs[m.id], life: 1.8 });
  const big = def.big != null && m.size >= def.big;
  toast(`釣到了 ${def.name}！${m.size} cm（${rar?.name || ''}）${big ? ' · 大尺寸！' : ''}${isNew ? ' · 新發現！' : isRecord ? ' · 尺寸新紀錄！' : ''}`, 3400);
  if (S.dexOpen) buildDex();
  checkTitles(false);
}
// 釣竿拋出去的姿勢角度（正值＝竿尖往面向那側前傾）：等魚前傾、上鉤被往下拉、拉扯時往後上方甩
function rodAngle(f) {
  return f.ph === 'reel' ? -.25 + Math.sin(S.t * 30) * .12 : f.ph === 'bite' ? 1 + Math.sin(S.t * 40) * .08 : .8;
}
// 詠唱中：雙手高舉法杖過頭，杖頂的寶珠隨進度聚光（ctx 已 translate 到角色腳底並依 dir 翻轉）
function drawStaffRaise(wi, q) {
  const [hx, hy] = charAnch.hand;
  ctx.save(); ctx.translate(hx, hy - 10); ctx.rotate(Math.sin(S.t * 9) * .05);
  ctx.drawImage(wi, -wi.width, -(wi.height - 3) * 2, wi.width * 2, wi.height * 2);
  const ty = -(wi.height - 3) * 2;   // 杖頂
  ctx.globalCompositeOperation = 'lighter';
  const r = 3 + 7 * q + Math.sin(S.t * 24) * 1.2;
  const g = ctx.createRadialGradient(0, ty, 0, 0, ty, r);
  g.addColorStop(0, `rgba(190,255,200,${.55 + .4 * q})`); g.addColorStop(1, 'rgba(120,230,160,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, ty, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// 畫拋出去的釣竿（ctx 已 translate 到角色腳底並依 dir 翻轉；轉軸同揮擊＝握把）
function drawRodCast(wi, a) {
  ctx.save(); ctx.translate(charAnch.hand[0], charAnch.hand[1]); ctx.rotate(a);
  ctx.drawImage(wi, -wi.width, -(wi.height - 3) * 2, wi.width * 2, wi.height * 2); ctx.restore();
}
// 釣線與浮標（世界座標）：從竿尖拉到浮標；上鉤時浮標沉下去、水面起漣漪；拉扯時浮標往人這邊收
function drawLineAndBobber(p, wi, f) {
  const a = rodAngle(f), L = (wi.height - 3) * 2 - 2, dir = p.dir < 0 ? -1 : 1;
  const tx = p.x + dir * (charAnch.hand[0] + L * Math.sin(a)), ty = p.y - p.z + charAnch.hand[1] - L * Math.cos(a);
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

// ---- 魚類圖鑑：每個地形一頁，各 30 種；沒釣過的是黑色剪影＋「？？？」，釣過的顯示圖、名稱、稀有度、最大尺寸與次數 ----
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
  // 依稀有度排（常見→罕見→稀有，順序照 fish.json 的 rarity）；同稀有度維持 fish.json 的順序（sort 是穩定排序）
  const rarOrder = Object.keys(S.fishDB.rarity || {});
  const list = [...(S.fishDB.terrains[S.dexTab] || [])].sort((a, b) => rarOrder.indexOf(a.rarity) - rarOrder.indexOf(b.rarity));
  const seen = S.dex[S.dexTab] || {};
  const n = list.filter(f => seen[f.id]).length, nBig = list.filter(f => bigCaught(S.dexTab, f)).length;
  $('dexHint').textContent = `已發現 ${n}／${list.length} · 大尺寸 ${nBig}` + (S.dexSource === 'server' ? ' · 以 Discord 帳號保存' : ' · 訪客／未連線：只存在這台電腦');
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
      if (bigCaught(S.dexTab, f)) {   // 最大尺寸達到大尺寸門檻（fish.json 的 big）：稀有度旁加金色「大」（放尺寸那行會擠到換行）
        const bg = document.createElement('span'); bg.className = 'dex-big'; bg.textContent = '大'; bg.title = `大尺寸（≥ ${f.big} cm）`;
        r.append(bg);
      }
      card.append(r, s);
    }
    grid.appendChild(card);
  }
}

// ---- 稱號：達成條件就解鎖（assets/titles/titles.json），在造型面板的「稱號設定」選一個顯示在名字上方 ----
// 解鎖純客戶端判斷（與職業同樣信任客戶端）：釣魚類從圖鑑推算（登入的人用伺服器存的圖鑑）；擊倒島主記在 localStorage 的 dcisland.m0.titles。
// 同步只送稱號 id（state.title），文字由各畫面查 titles.json。
const TITLE_ASSIST = 30;   // 島主倒下前幾秒內打過牠算「參與擊倒」
const titleDef = id => (id && S.titlesDB?.titles?.find(t => t.id === id)) || null;
const titleText = id => { const t = titleDef(id); return t ? `《${t.name}》` : null; };
const allFish = () => Object.entries(S.fishDB?.terrains || {}).flatMap(([t, l]) => l.map(f => ({ t, f })));
const bigCaught = (t, f) => { const e = S.dex[t]?.[f.id]; return !!e && f.big != null && e.max >= f.big; };
// 條件進度：{cur, need}；cur ≥ need 就算解鎖
function titleProgress(c, depth = 0) {
  if (!c || depth > 3) return { cur: 0, need: 1 };
  switch (c.type) {
    case 'owner': return { cur: S.titleBook.kills?.[c.mob] ? 1 : 0, need: 1 };
    case 'dex': {
      const seen = S.dex[c.terrain] || {};
      return { cur: (S.fishDB?.terrains[c.terrain] || []).filter(f => seen[f.id]).length, need: c.n || 1 };
    }
    case 'big': {
      const l = allFish().filter(x => !c.rarity || x.f.rarity === c.rarity);
      return { cur: l.filter(x => bigCaught(x.t, x.f)).length, need: c.n || Math.max(1, l.length) };
    }
    case 'titles': {
      const ids = c.ids || [];
      return { cur: ids.filter(id => { const d = titleDef(id); return d && titleMet(d.cond, depth + 1); }).length, need: Math.max(1, ids.length) };
    }
  }
  return { cur: 0, need: 1 };   // 不認得的條件：不解鎖
}
function titleMet(c, depth = 0) { const p = titleProgress(c, depth); return p.cur >= p.need; }
function unlockedTitles() { return new Set((S.titlesDB?.titles || []).filter(t => titleMet(t.cond)).map(t => t.id)); }
// 重算解鎖狀態；silent＝不跳提示（開機、伺服器送來圖鑑時）。剛解鎖的稱號延遲一下再提示，免得蓋掉釣到魚／打倒島主的提示
function checkTitles(silent) {
  const got = unlockedTitles(), known = new Set(S.titleBook.known || []);
  const fresh = [...got].filter(id => !known.has(id));
  if (fresh.length) {
    S.titleBook.known = [...known, ...fresh];
    lsSet('dcisland.m0.titles', S.titleBook);
    if (!silent) setTimeout(() => toast(`獲得稱號 ${fresh.map(titleText).join('')}！可在「造型」的稱號設定中使用`, 3600), 2000);
  }
  // 外觀：解鎖條件與稱號同一套（avatar.json 各件的 unlock）；剛解鎖的跳提示（比稱號晚一點，不要疊在一起）
  const gk = new Set(S.titleBook.glams || []), gFresh = allGlams().filter(it => it.unlock && glamUnlocked(it) && !gk.has(it.id));
  if (gFresh.length) {
    S.titleBook.glams = [...gk, ...gFresh.map(it => it.id)];
    lsSet('dcisland.m0.titles', S.titleBook);
    if (!silent) setTimeout(() => toast(`解鎖外觀「${gFresh.map(it => it.name).join('」「')}」！可在「造型」的裝備與外觀中使用`, 3600), 4200);
  }
  if (S.titleOpen) buildTitles();
}
// 島主倒下：TITLE_ASSIST 秒內自己打過牠就記一筆「參與擊倒」
function titleOwnerDown(mob) {
  if (!(S.t - (S.ownerHitAt[mob] ?? -1e9) <= TITLE_ASSIST)) return;
  const kills = S.titleBook.kills ||= {};
  if (!kills[mob]) { kills[mob] = 1; lsSet('dcisland.m0.titles', S.titleBook); }
  checkTitles(false);
}
function setTitle(id) {
  S.me.title = id; saveAvatar();
  toast(id ? `稱號設定為 ${titleText(id)}` : '不顯示稱號', 1600);
  buildTitles(); buildAvatarPanel();
}
function openTitles() { S.titleOpen = true; buildTitles(); $('titleBox').classList.remove('hidden'); }
function closeTitles() { S.titleOpen = false; $('titleBox').classList.add('hidden'); }
function buildTitles() {
  const list = S.titlesDB?.titles || [], got = unlockedTitles();
  $('titleHint').textContent = `已解鎖 ${got.size}／${list.length}` + (S.dexSource === 'server' ? '' : ' · 訪客／未連線：釣魚紀錄只存在這台電腦') + ' · 擊倒島主的紀錄存在這台電腦';
  const box = $('titleList'); box.innerHTML = '';
  const row = (id, name, desc, ok, prog) => {
    const o = document.createElement('div');
    o.className = 'title-row' + (ok ? '' : ' locked') + ((S.me.title || null) === id ? ' sel' : '');
    const nm = document.createElement('div'); nm.className = 'title-name'; nm.textContent = name;
    const ds = document.createElement('div'); ds.className = 'title-desc'; ds.textContent = desc + (prog ? `（${prog}）` : '');
    o.append(nm, ds);
    if (ok) o.onclick = () => setTitle(id);
    box.appendChild(o);
  };
  row(null, '無', '不顯示稱號', true, '');
  for (const t of list) {
    const ok = got.has(t.id), p = titleProgress(t.cond);
    row(t.id, `《${t.name}》`, t.desc, ok, ok ? '已解鎖' : p.need > 1 ? `${Math.min(p.cur, p.need)}／${p.need}` : '未解鎖');
  }
}

// ---------------- 繪製 ----------------
// 武器（ctx 已 translate 到角色腳底並依 dir 翻轉）。素材：刀刃在上、握柄在下。
// 沒揮擊：背在肩後（畫在身體之前，被身體擋住一部分）。
// 以「圖的底端」對齊（木劍 18 格高、畫成 36px 時底端在轉軸下 27px）：比較長的武器（釣竿）往上伸出肩頭，不會穿過腳底。
// avatar.json 標 back: "hilt" 的（木劍）上下翻過來＝劍柄在肩後（約肩膀高度）、劍身朝下藏在身體後面
const WEAPON_BACK_BOTTOM = 27, WEAPON_HILT_LIFT = 0;
// 武器掛點（畫面座標，相對腳底）：drawPerson 依這一幀的 avatar.json frames.anchors（可逐幀覆寫）算好放這裡；
// 預設值＝以前寫死的常數（背上 -11,-26／背面 -5,-26／腰 -8,-18／手 3,-26）
let charAnch = { back: [-11, -26], backView: [-5, -26], waist: [-8, -18], hand: [3, -26] };
// onBack＝背面視角（畫在身體之上）：用 backView 掛點（往背的中間靠，看起來是斜背在背上）
function drawWeaponBack(wi, onBack) {
  const [ax, ay] = onBack ? charAnch.backView : charAnch.back;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(-.55);
  if (wi.hiltUp) { ctx.scale(1, -1); ctx.drawImage(wi, -wi.width, WEAPON_HILT_LIFT - WEAPON_BACK_BOTTOM, wi.width * 2, wi.height * 2); }
  else ctx.drawImage(wi, -wi.width, WEAPON_BACK_BOTTOM - wi.height * 2, wi.width * 2, wi.height * 2);
  ctx.restore();
}
// 掛在腰間（avatar.json 的 carry: "waist"）：握把在腰的掛點，武器頭朝下、往身後斜（劍柄朝上，像插在腰帶上）
function drawWeaponWaist(wi) {
  const [ax, ay] = charAnch.waist;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.PI + .45);
  ctx.drawImage(wi, -wi.width, -(wi.height - 3) * 2, wi.width * 2, wi.height * 2); ctx.restore();   // 轉軸＝離圖底 3 格的握把
}
// 揮擊：握住劍柄（以握把為轉軸）、刀刃朝外，由後上方往前下方揮，畫在身體之後（身前）
// 劍柄朝上背著的（hiltUp）或掛腰間的：前 35% 手從掛著的位置（背上劍柄＝back 掛點往左上 2,3；腰間＝waist 掛點）移到手的掛點，看起來是拔出來再揮。
// 掛著的武器不隨人物翻轉（固定在畫面左側），ctx 卻已依面向翻轉，所以起點 x 要乘上 dir 換回同一側
const SWING_HILT_DRAW = .35;
function drawWeaponSwing(wi, swing, dir = 1) {
  const q = 1 - swing / ATK_T;
  let [px, py] = charAnch.hand;
  if (wi.hiltUp || wi.carry === 'waist') {
    const from = wi.carry === 'waist' ? charAnch.waist : [charAnch.back[0] - 2, charAnch.back[1] - 3];
    const k = Math.min(1, q / SWING_HILT_DRAW), fx = from[0] * dir;
    px = fx + (px - fx) * k; py = from[1] + (py - from[1]) * k;
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
  // 底：地面／岸邊／水（可動畫：每種磚這一幀先算好，整張地圖同步；stagger 的各格再錯開）
  const tiles = [ims[tMan.water], ims[tMan.edge], ims[tMan.ground]], tileFi = tiles.map(s => s ? sprFrame(s) : 0);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = S.world.types[y * COLS + x], spr = tiles[t];
    if (!spr) continue;
    drawSpr(spr, spr.stagger ? (tileFi[t] + x * 7 + y * 13) % spr.frames : tileFi[t], x * CELL, y * CELL, CELL, CELL);
  }
  // 地板層：蓋在地面上、家具與角色之下（多格地板從錨點畫整張，錨點在鏡頭左上外也要畫，所以往外多看幾格）
  for (let y = Math.max(0, y0 - FLOOR_MAX + 1); y <= y1; y++) for (let x = Math.max(0, x0 - FLOOR_MAX + 1); x <= x1; x++) {
    const fid = S.floorMap.get(y * COLS + x), spr = fid && S.floorImgs[fid];
    if (!spr) continue;
    const s = floorSize(fid);
    drawSpr(spr, sprFrame(spr, spr.stagger ? cellPhase(x, y) : 0), x * CELL, y * CELL, s.w * CELL, s.h * CELL);
  }
  // 裝飾模式半透明格線
  if (S.mode === 'decor') {
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (S.world.types[y * COLS + x]) ctx.strokeRect(x * CELL + .5, y * CELL + .5, CELL - 1, CELL - 1);
  }

  // 收集繪製項目（y 排序）
  // 畫面外的點綴物／家具不收：圖以「格子底邊」往上畫，所以用圖的實際範圍判斷（pad＝受擊抖動、看板文字的餘裕）
  const vx0 = S.cam.x, vy0 = S.cam.y, vx1 = vx0 + canvas.width, vy1 = vy0 + canvas.height;
  const offView = (left, bottom, w, h, pad) => left + w + pad < vx0 || left - pad > vx1 || bottom + pad < vy0 || bottom - h - pad > vy1;
  const list = [];
  for (const d of S.world.decos) {
    if (d.dead) continue;
    const img = ims[d.sprite]; if (!img) continue;
    if (offView(d.cell[0] * CELL, (d.cell[1] + 1) * CELL, img.width * SC, img.height * SC, 4)) continue;
    list.push({
      y: (d.cell[1] + 1) * CELL,
      draw: () => {
        const w = img.width * SC, h = img.height * SC, fi = sprFrame(img, cellPhase(d.cell[0], d.cell[1]));   // 點綴物可動畫：依格子錯開相位
        const sx = d.shake > 0 ? Math.sin(S.t * 70) * 2 * (d.shake / .25) : 0;   // 受擊抖動
        if (d.flip) {
          ctx.save(); ctx.translate(d.cell[0] * CELL + w + sx, (d.cell[1] + 1) * CELL - h); ctx.scale(-1, 1);
          drawSpr(img, fi, 0, 0, w, h); ctx.restore();
        } else drawSpr(img, fi, d.cell[0] * CELL + sx, (d.cell[1] + 1) * CELL - h, w, h);
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
    if (offView(it.cell[0] * CELL, (it.cell[1] + def.h) * CELL, Math.max(def.w * CELL, img.width * SC), img.height * SC, def.text ? 90 : 4)) return;
    list.push({
      y: (it.cell[1] + def.h) * CELL - 1,
      draw: () => {
        ctx.save();
        if (idx === S.pickedIdx) ctx.globalAlpha = .5;
        drawSpr(img, sprFrame(img, cellPhase(it.cell[0], it.cell[1])), it.cell[0] * CELL, (it.cell[1] + def.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
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
  // 黑魔法師的魔法陣（地上，先畫＝在所有角色腳底下）
  if (S.fx.circle && S.t < S.fx.circle.until) drawMagicCircle(S.fx.circle.x, S.fx.circle.y, S.fx.circle.until - S.t);
  for (const r of S.remotes.values()) if (r.circle) drawMagicCircle(r.circle.x, r.circle.y, 99);
  // 小動物
  for (const a of S.mobs) {
    const img = S.mobImgs[a.id], an = S.mobAnims[a.id]; if (!img && !an) continue;
    const def = mobDef(a.id);
    list.push({
      y: a.y - (a.z ? .5 : 1),
      draw: () => {
        // big=N＝比普通動物大 N 倍（判定圈等玩法也看它）；有多幀動畫時畫面大小改看 anim.scale。錨點在腳底中央
        const bs = def.big || 1, W = an ? an.fw * an.scale : img.width * 2 * bs, H = an ? an.fh * an.scale : img.height * 2 * bs;
        const shs = 1 - Math.min(.5, a.z / 60);
        // 影子：預設依 big 算大小、貼在腳底中央；素材的腳印寬度與 big 不成比例、或腳不在正中央時（例如蓋老師），
        // mobs.json 可寫 shadow:{rx, ry, dx, dy}（px，ry/rx 是半徑，dx/dy 是相對腳底中央的位移，dy 負＝往上；dx 以素材原本的朝向為準，圖翻轉時跟著翻）
        // 素材預設面向右邊（往左走才左右翻轉）；mobs.json 標 faceLeft: true 的素材本身面向左邊（例如壓力山大），翻轉條件相反
        const flip = (a.dir < 0) !== !!def.faceLeft;
        const sd = def.shadow;
        ctx.fillStyle = `rgba(10,14,20,${.26 * shs + .03})`;
        ctx.beginPath(); ctx.ellipse(a.x + (sd?.dx || 0) * (flip ? -1 : 1), a.y + (sd ? sd.dy : 1), (sd ? sd.rx : 9 * bs) * shs, (sd ? sd.ry : 3 * Math.max(1, bs * .6)) * shs, 0, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(a.x, a.y - a.z);
        if (a.dead) {  // 死亡：縮小旋轉淡出
          const q = 1 - a.dieT / .6;
          ctx.globalAlpha = Math.max(0, 1 - q * 1.2);
          ctx.rotate(q * 1.1); ctx.scale(1 - q * .3, 1 - q * .3);
        }
        if (flip) ctx.scale(-1, 1);
        // footDx：素材的腳底中心不在圖的正中央時（px，以素材原本的朝向為準，負＝偏左），把圖往反方向挪，讓腳底中心對準 a.x——
        // 判定圈、影子、名牌、血條都以 a.x 為準，這樣才會在正腳下（翻轉時 ctx 已經左右翻，挪的方向自動跟著翻）
        const fdx = def.footDx || 0;
        if (an) drawSpr(an, animFrame(a, an), -W / 2 - fdx, -H, W, H);
        else ctx.drawImage(img, -W / 2 - fdx, -H, W, H);
        ctx.restore();
        if (a.dead) return;
        if (def.owner && (S.t < (a.vulnUntil ?? 0) || S.t < (a.weakUntil ?? 0))) drawOwnerDebuff(a, W, H);
        if (a.poison) drawPoison(a.x, a.y - a.z, W, H);
        if (def.owner && !a.fly) {   // 島主腳下判定圈：以「武器尖端」為準——武器點（人前方 WEAPON_REACH 處的小圓點）進圈就打得到，不看面向。靠近（約 220px 內）才顯示
          const me = S.players[0], d = Math.hypot(a.x - me.x, a.y - me.y);
          if (d < 220 && !me.dead && !me.pose && S.me.weapon !== 'hands' && !rangedDef()) {   // 空手（沒裝備武器）、拿法杖（遠距詠唱，沒有近戰判定）不顯示
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
        // 島主預警：龍衝＝金色虛線＝衝刺路徑；石化之瞳＝大眼睛（全地圖面向她的人石化）；波動砲＝光波帶狀範圍；命令＝頭上大字（行動！／靜止！）
        if (a.command) {   // 命令讀條：行人號誌風圖示（行動＝走路小綠人、靜止＝站立小紅人），全地圖可見、隨時間呼吸閃爍
          const ic = CMD_ICONS[a.command.kind] || CMD_ICONS.act;
          if (ic.complete && ic.naturalWidth) {
            const s = 64, pul = .7 + .3 * (Math.sin(S.t * 10) * .5 + .5);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = pul;
            ctx.drawImage(ic, a.x - s / 2, Math.max(top - 20 - s, S.cam.y + 8), s, s);
            ctx.restore();
          }
        }
        if (a.cast > 0 && a.castFrom) {
          const cf = a.castFrom, L = 1700;
          const ux = cf.x - a.x, uy = cf.y - a.y, ul = Math.hypot(ux, uy) || 1;
          const pul = Math.sin(S.t * 12) * .5 + .5;
          const atk = ownerAtk(def);
          if (atk === 'gaze') drawGazeEye(a.x, a.y - H * .62, 9 * bs + 6 * (1 - a.cast / OWNER_GAZE_CAST), pul);
          else if (atk === 'beam') drawBeamWarn(a.x, a.y - H * .5, ux / ul, uy / ul, L, W, 1 - a.cast / OWNER_BEAM_CAST, pul);
          else {
            ctx.save();
            ctx.strokeStyle = `rgba(255,214,90,${.28 + .34 * pul})`;
            ctx.lineWidth = 2 + 2 * pul; ctx.setLineDash([10, 12]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y - H * .5);
            ctx.lineTo(a.x + ux / ul * L, a.y - H * .5 + uy / ul * L);
            ctx.stroke(); ctx.setLineDash([]); ctx.restore();
          }
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
        ctx.fillStyle = a.startle ? '#e8b2a2' : (def.owner ? '#ffd86b' : def.lurker ? '#ff8f7a' : '#cfd8c8');   // 釣上來的怪物用紅色名牌
        ctx.fillText(def.name, a.x, top);
        // 島主的台詞泡泡（被打反擊前隨機一句；與 NPC 泡泡同款，畫在名牌上方）
        if (a.say && S.t < a.say.until) drawBubble(a.x, top - 8, a.say.text, Math.min(1, (a.say.until - S.t) / .4));
        // 島主放招倒數條（skills.json 標 bar 的招式）：預警期間畫在名牌上方，黃色由左往右填，填滿就放招；右上角是招式名稱。
        // 島主很高，人站在牠腳邊時頭會超出畫面上緣：倒數條貼齊畫面上緣，不會看不到
        if (def.owner && a.cast > 0 && ownerSkill(def).bar)
          drawCastBar(a.x, Math.max(top - 16, S.cam.y + 20), 1 - a.cast / ownerCastTotal(def),
                      a.command ? quoteName(a.command.kind) : ownerSkill(def).name);
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
        const wi = !p.npc ? weaponImgFor(wid, p.tool ? null : myLook().wlook) : null;
        drawPerson(p, wi, p.npc ? (p.guide ? '#ffd86b' : '#bcd8e8') : '#ffffff');
      }
    });
  }
  // M2：同島的其他玩家
  for (const r of S.remotes.values()) {
    if (r.dead) { list.push(tombEntry(r.x, r.y, r.name, DEAD_SECONDS - (performance.now() - (r.deadAt || performance.now())) / 1000)); continue; }
    list.push({
      y: r.y + (r.pose ? 2 : 0),
      draw: () => drawPerson(r, weaponImgFor(r.weapon, r.look?.wlook), '#ffe9a8')   // 同島的人用暖金色名牌區分
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
        const fs = S.floorImgs[S.selFloor];
        ctx.globalAlpha = .7; drawSpr(fs, sprFrame(fs), mx * CELL, my * CELL, rw * CELL, rh * CELL); ctx.globalAlpha = 1;
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
    drawSpr(img, sprFrame(img), mx * CELL, (my + def.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = valid ? 'rgba(120,255,160,.8)' : 'rgba(255,120,120,.8)';
    ctx.strokeRect(mx * CELL + .5, my * CELL + .5, w - 1, h - 1);
  }
  // 傷害飄字 / 消失特效
  for (const f of S.floaters) {
    ctx.save();
    if (f.fxk) { drawFxFloater(f); ctx.restore(); continue; }   // 技能特效（世界座標）
    if (f.orb) {   // 法杖光球：從杖頂飛向目標（0.22 秒）
      const q = 1 - f.life / .22, x = f.x1 + (f.x2 - f.x1) * q, y = f.y1 + (f.y2 - f.y1) * q;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
      g.addColorStop(0, 'rgba(230,255,235,.95)'); g.addColorStop(.5, 'rgba(120,230,160,.6)'); g.addColorStop(1, 'rgba(120,230,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
      ctx.restore(); continue;
    }
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
    if (f.aoe) {   // 台詞招式的範圍：放出瞬間亮起再淡出（circle＝圓形、ring＝月環的環形）
      const q = 1 - f.life / .7, al = 1 - q;
      ctx.beginPath();
      if (f.aoe === 'ring') { ctx.arc(f.x, f.y, f.r2, 0, Math.PI * 2); ctx.arc(f.x, f.y, f.r1, 0, Math.PI * 2, true); }
      else ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = f.hot ? `rgba(255,70,60,${.42 * al})` : `rgba(255,150,70,${.34 * al})`;
      ctx.fill('evenodd');
      ctx.strokeStyle = `rgba(255,236,170,${.9 * al})`; ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore(); continue;
    }
    if (f.beamLine) {   // 波動砲：從島主沿光束方向射出的帶狀光波（0.5 秒淡出）
      const q = 1 - f.life / .5;
      ctx.translate(f.x, f.y); ctx.rotate(f.ang);
      ctx.fillStyle = `rgba(150,215,255,${.55 * (1 - q)})`;
      ctx.fillRect(0, -f.wid / 2, f.len, f.wid);
      ctx.fillStyle = `rgba(255,255,255,${.85 * (1 - q)})`;
      ctx.fillRect(0, -f.wid * .13, f.len, f.wid * .26);
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
    } else if (f.healPulse) {   // 補師的補血脈衝：綠圈從補師腳下擴散淡出
      const q = 1 - f.life / .35;
      ctx.strokeStyle = `rgba(130,224,138,${1 - q})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 8 + q * (HEAL_RADIUS - 8), 0, Math.PI * 2); ctx.stroke();
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
    if (!groundAt(xx, yy)) return false;   // 水上要先鋪地板
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
  // 沒連線才走 localStorage：套用與 applyFurn 同一層過濾（manifest 沒有的種類直接略過，
  // 不讓舊存檔裡的殘留家具在 boot 的 rebuildOcc 時炸掉整個遊戲——正式站黑畫面就是這條路徑炸的）
  let items = [];
  try { items = JSON.parse(localStorage.getItem('dcisland.m0.layout.' + S.terrain)) || []; }
  catch { items = []; }
  S.furnItems = items.filter(it => it && furnitureDef(it.type) && Array.isArray(it.cell));
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
  if (S.mode === 'decor') {      // 別人保存了新的地板：以它為底，把我的草稿重新疊上去
    S.baseFloor = listToFloor(items);
    replayDraft(); updateDecorUI();
  } else applyFloor(items);
}
// 以 S.baseFurn／S.baseFloor 為底，依原順序重播整份草稿（家具與地板互相影響：水上家具要有地板、有家具的水上地板不能拆；
// 順序與伺服器逐一驗證時相同）。不合法的操作略過
function replayDraft() {
  const furn = cloneFurn(S.baseFurn), floor = new Map(S.baseFloor);
  for (const op of S.draft) {
    if (op.t === 'floor') applyFloorOp(floor, op, furn);
    else applyFurnOpTo(furn, op, floor);
  }
  S.furnItems = furn; S.floorMap = floor; rebuildOcc();
}
// 多格地板（floors.json 標 w/h，例如地毯 2×2）：只在錨點格（左上）存一筆，其餘格子視為被它蓋住。
// 規則與兩份伺服器的 applyFloorOp 一致：多格地板彼此不重疊、單格地板不能鋪在多格地板上；
// 鋪多格地板會取代範圍內的單格地板；拆除點到多格地板的任一格就整塊拆掉。
// 地板可以鋪在水上；水上那格有家具時不能拆（要先拿走家具），陸地上的地板不受限制
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
// 拆掉錨點 k 的地板後，水上會不會有家具懸空（items＝要看的擺設清單）
function floorHoldsFurn(m, k, items) {
  const s = floorSize(m.get(k)), ax = k % COLS, ay = Math.floor(k / COLS);
  for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) {
    const cx = ax + dx, cy = ay + dy;
    if (cx < COLS && cy < ROWS && !S.world.types[cy * COLS + cx] && items.some(it => furnCovers(it, [cx, cy]))) return true;
  }
  return false;
}
function applyFloorOp(m, op, items = S.furnItems) {   // 有變動回 true
  const [x, y] = op.cell;
  if (op.type === null) { const k = floorAt(m, x, y); return k >= 0 && !floorHoldsFurn(m, k, items) && m.delete(k); }
  const cov = floorCovered(m, op.type, x, y), s = floorSize(op.type);
  if (!cov) return false;
  if (s.w * s.h === 1 && cov.length === 1 && m.get(cov[0]) === op.type) return false;   // 同一種，沒變
  for (const k of cov) m.delete(k);
  m.set(y * COLS + x, op.type);
  return true;
}
const floorCellOk = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;   // 地板可以鋪在水上
// 長按鋪設/拆除：游標所在格套用目前動作（沒有變化的不記草稿；地毯掃過去會一塊接一塊鋪，不會重疊）
function paintFloor() {
  if (S.mode !== 'decor' || S.decorTab !== 'floor' || !S.paint || !S.mouseCell || S.players[0].dead) return;
  const [x, y] = S.mouseCell;
  const type = S.paint === 'add' ? S.selFloor : null;
  if (S.paint === 'add' && !type) return;
  const op = { t: 'floor', cell: [x, y], type };
  if (S.draft.length >= 1200) { toast('未保存的變動太多了，請先按「完成」保存'); S.paint = null; return; }
  if (!applyFloorOp(S.floorMap, op)) {
    if (!type) { const k = floorAt(S.floorMap, x, y); if (k >= 0 && floorHoldsFurn(S.floorMap, k, S.furnItems)) toast('水上的地板有家具，先拿走家具才能拆', 1600); }
    return;
  }
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
    replayDraft(); updateDecorUI();
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
// 在指定清單上能不能放（範圍、水邊〔水上要有地板 floor〕、與清單內家具重疊）；規則與兩份伺服器一致
function canPlaceIn(list, typeId, x, y, floor = S.floorMap) {
  const def = furnitureDef(typeId); if (!def) return false;
  for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS || !groundAt(xx, yy, floor)) return false;
  }
  return !list.some(it => { const d = furnitureDef(it.type) || { w: 1, h: 1 };
    return x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h; });
}
// 把一個家具操作套到清單上（直接改 list；不合法的略過）
function applyFurnOpTo(list, op, floor = S.floorMap) {
  if (op.t === 'clear') list.length = 0;
  else if (op.t === 'remove') { const i = list.findIndex(it => furnCovers(it, op.cell)); if (i >= 0) list.splice(i, 1); }
  else if (op.t === 'place' && canPlaceIn(list, op.type, op.cell[0], op.cell[1], floor)) list.push({ type: op.type, cell: [op.cell[0], op.cell[1]] });
}
function stageOp(op) {
  S.draft.push(op);
  const list = cloneFurn(S.furnItems);
  applyFurnOpTo(list, op);
  S.furnItems = list;
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
  if (m.limited) toast('保存太頻繁，這批變動沒有保存，請稍等幾秒再試', 3200);
  else if (m.denied) toast('清空需要管理員權限，這項已略過' + (m.applied ? `（其他 ${m.applied} 項已保存）` : ''), 3200);
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
  // 死亡（墓碑）中、或戰鬥中（島主仇恨／放招中、釣上來的怪物還在＝ownerEngaged）不能換島（使用者定）
  if (S.players[0]?.dead) { toast('倒地中不能換島，等復活後再走', 2000); return; }
  if (ownerEngaged()) { toast('戰鬥中不能換島，等仇恨解除後再走', 2000); return; }
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
    me.fish = null; me.cast = null;                        // 換地形就收竿、中斷詠唱
    buildTerrainChips();
    toast(`已移動到${S.terrains[id].name}`);
    // M2：只有自己過去；告訴伺服器，讓新地形的人看到你、舊地形的人看不到你
    S.net?.enter?.(id);
    // 把陸地位圖交給伺服器（島形只有客戶端知道；島主路徑與擺設的水邊驗證都要用）
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
      const fs = S.floorImgs[it.id];
      g.drawImage(fs.img, 0, 0, fs.fw, fs.fh, 6, 4, 32, 32);   // 面板縮圖：第 1 幀
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
    g.drawImage(img.img, 0, 0, img.fw, img.fh, (44 - w * s2) / 2, 40 - h * s2, w * s2, h * s2);   // 面板縮圖：第 1 幀
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

// ---------------- 裝備與外觀 ----------------
// 部位：帽子／上衣／褲子／武器。裝備＝職業固定的一套（jobs.json 的 gear／weapon）；外觀（avatar.json 標 glam 的那些）每個職業各記一套，
// 某部位有選外觀就顯示外觀、沒選就顯示裝備。換色（帽子／上衣／褲子）也是每個職業各記一套，套在該部位顯示中的那件。
// 存檔：S.me.wardrobe[職業 id] = { glam: {hat, top, bottom, weapon}, color: {hat, top, bottom} }（色碼 '#rrggbb'，沒有＝原色）
const SLOTS = [['hat', '帽子'], ['top', '上衣'], ['bottom', '褲子'], ['weapon', '武器']];
const slotList = s => s === 'hat' ? S.avatar.hats : s === 'top' ? S.avatar.tops : s === 'bottom' ? S.avatar.bottoms : S.avatar.weapons;
const allGlams = () => SLOTS.flatMap(([s]) => (slotList(s) || []).filter(it => it.glam));
const glamUnlocked = it => !it.unlock || titleMet(it.unlock);
const jobWeaponDef = (job = S.me.job) => S.avatar.weapons.find(w => w.id === JOBS[job]?.weapon) || null;
// 這件外觀能不能給這個職業的這個部位用（不管解鎖）：要標 glam、jobs 沒限定或包含這個職業；武器還要和職業武器同類型
function glamFits(slot, it, job = S.me.job) {
  if (!it?.glam || (it.jobs && !it.jobs.includes(job))) return false;
  return slot !== 'weapon' || it.type === jobWeaponDef(job)?.type;
}
function wardrobe(job = S.me.job) {
  const w = (S.me.wardrobe && typeof S.me.wardrobe === 'object') ? S.me.wardrobe : (S.me.wardrobe = {});
  const e = w[job] && typeof w[job] === 'object' ? w[job] : (w[job] = {});
  e.glam ||= {}; e.color ||= {};
  return e;
}
// 某部位現在顯示哪一件（外觀優先；外觀失效＝沒解鎖／不適用就退回裝備）
function shownItem(slot, job = S.me.job) {
  const g = wardrobe(job).glam[slot], it = g && lookItem(slotList(slot), g);
  if (it && glamFits(slot, it, job) && glamUnlocked(it)) return it;
  return slot === 'weapon' ? jobWeaponDef(job) : lookItem(slotList(slot), JOBS[job]?.gear?.[slot]);
}
// 自己的顯示造型（畫自己、送給同島的人都用這個；外觀與裝備在這裡就決定好，別人只看結果）
function myLook() {
  const c = wardrobe().color, w = shownItem('weapon');
  return { skin: S.me.skin, hair: S.me.hair,
           hat: shownItem('hat')?.id || null, top: shownItem('top')?.id || null, bottom: shownItem('bottom')?.id || null,
           hatC: c.hat || null, topC: c.top || null, botC: c.bottom || null,
           wlook: w && w.id !== JOBS[S.me.job]?.weapon ? w.id : null,
           shirt: 0, pants: 0 };   // shirt／pants：給舊客戶端的顏色編號（舊版只認這兩個）
}

function buildAvatarPanel() {
  // 職業：jobs.json（職能＝圓點顏色；滑鼠停留顯示職能說明）
  const jb = $('jobOpts'); jb.innerHTML = '';
  for (const id of Object.keys(JOBS)) {
    const jd = JOBS[id], o = document.createElement('div');
    o.className = 'opt name' + (S.me.job === id ? ' sel' : '');
    o.textContent = jd.name; o.title = `${jd.roleName}：${jd.desc}`;
    const dot = document.createElement('span');
    dot.style.color = jd.color; dot.style.marginRight = '4px'; dot.textContent = '●';
    o.prepend(dot);
    o.onclick = () => setJob(id);
    jb.appendChild(o);
  }
  const jd = JOBS[S.me.job];
  $('titleCur').textContent = titleText(S.me.title) || '無';   // 稱號：按「稱號設定」開稱號一覽選
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
  // 裝備與外觀：每個部位一列——顯示中的那件（裝備，或套了外觀時的外觀名）＋「外觀」鈕（開外觀一覽選）＋換色鈕
  const box = $('gearRows'); box.innerHTML = '';
  const wr = wardrobe();
  for (const [slot, label] of SLOTS) {
    const row = document.createElement('div'); row.className = 'gear-row';
    const lb = document.createElement('div'); lb.className = 'gear-lb'; lb.textContent = label; row.appendChild(lb);
    const gearIt = slot === 'weapon' ? jobWeaponDef() : lookItem(slotList(slot), jd?.gear?.[slot]);
    const cur = shownItem(slot), isGlam = cur && gearIt && cur.id !== gearIt.id;
    const nm = document.createElement('div'); nm.className = 'gear-name' + (isGlam ? ' glam' : '');
    nm.textContent = cur ? cur.name : '（無）';
    nm.title = (cur ? cur.name : '（無）') + (isGlam ? `（外觀；裝備：${gearIt.name}）` : '（職業裝備）');   // 名稱太長被截斷時，滑鼠停留看全名
    row.appendChild(nm);
    const gb = document.createElement('button'); gb.className = 'ff-btn small'; gb.textContent = '外觀';
    gb.onclick = () => openGlams(slot);
    row.appendChild(gb);
    if (slot !== 'weapon') {   // 換色：顯示中的那件有可染色的顏色才能換
      const b = document.createElement('button'); b.className = 'ff-btn small dye-btn';
      const dye = dyeList(cur);
      b.disabled = !dye;
      b.title = dye ? '換色' : '這件不能換色';
      const sw = document.createElement('span'); sw.className = 'dye-sw';
      sw.style.background = wr.color[slot] || dye?.[0] || 'transparent';
      b.append(sw, document.createTextNode('換色'));
      b.onclick = () => openColor(slot, cur);
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}
// ---------------- 外觀一覽（比照稱號一覽）：某部位可用的外觀，已解鎖的可以選、沒解鎖的變暗並顯示條件；開著仍可走路、Esc 關閉 ----------------
let glamSlot = null;
function openGlams(slot) { glamSlot = slot; S.glamOpen = true; buildGlams(); $('glamBox').classList.remove('hidden'); }
function closeGlams() { S.glamOpen = false; glamSlot = null; $('glamBox').classList.add('hidden'); }
function buildGlams() {
  const slot = glamSlot; if (!slot) return;
  const label = SLOTS.find(x => x[0] === slot)[1], jd = JOBS[S.me.job], wr = wardrobe();
  const gearIt = slot === 'weapon' ? jobWeaponDef() : lookItem(slotList(slot), jd?.gear?.[slot]);
  const list = (slotList(slot) || []).filter(it => glamFits(slot, it)), cur = shownItem(slot);
  $('glamTitle').textContent = `${label}外觀`;
  $('glamHint').textContent = `${jd?.name || ''}：已解鎖 ${list.filter(glamUnlocked).length}／${list.length}` + (slot === 'weapon' ? ' · 武器外觀只能選同類型的樣子' : '');
  const box = $('glamList'); box.innerHTML = '';
  const row = (id, name, desc, ok) => {
    const o = document.createElement('div');
    o.className = 'title-row' + (ok ? '' : ' locked') + ((id ? cur?.id === id && cur?.id !== gearIt?.id : !wr.glam[slot] || cur?.id === gearIt?.id) ? ' sel' : '');
    const nm = document.createElement('div'); nm.className = 'title-name'; nm.textContent = name;
    const ds = document.createElement('div'); ds.className = 'title-desc'; ds.textContent = desc;
    o.append(nm, ds);
    if (ok) o.onclick = () => { if (id) wr.glam[slot] = id; else delete wr.glam[slot]; saveAvatar(); buildAvatarPanel(); buildGlams(); };
    box.appendChild(o);
  };
  row(null, '不使用外觀', `顯示職業裝備：${gearIt ? gearIt.name : '（無）'}`, true);
  for (const it of list) {
    const ok = glamUnlocked(it);
    row(it.id, it.name, ok ? '已解鎖' : `未解鎖${it.hint ? '：' + it.hint : ''}`, ok);
  }
  if (!list.length) { const d = document.createElement('div'); d.className = 'title-desc'; d.style.padding = '6px 2px'; d.textContent = '這個部位還沒有外觀'; box.appendChild(d); }
}
$('glamClose').onclick = closeGlams;

// ---------------- 選色視窗（換色）：色相條＋飽和度／明度方塊＋色碼輸入＋常用色；拖曳時即時預覽，取消就還原 ----------------
const colorUI = { slot: null, before: null, h: 0, s: 1, v: 1 };
function hsv2hex(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function hex2hsv(hex) {
  const [r, g, b] = hexRGB(hex).map(x => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function openColor(slot, item) {
  const dye = dyeList(item); if (!dye) return;
  const wr = wardrobe();
  colorUI.slot = slot; colorUI.before = wr.color[slot] || null; colorUI.orig = dye[0];
  Object.assign(colorUI, hex2hsv(wr.color[slot] || dye[0]));
  $('colorTitle').textContent = `${SLOTS.find(x => x[0] === slot)[1]}換色：${item.name}`;
  const ps = $('colorPresets'); ps.innerHTML = '';
  for (const hex of [dye[0], ...new Set([...S.avatar.shirtColors, ...S.avatar.pantsColors])]) {
    const o = document.createElement('div'); o.className = 'opt'; o.style.background = hex; o.title = hex === dye[0] ? '原色' : hex;
    o.onclick = () => { Object.assign(colorUI, hex2hsv(hex)); colorApply(); };
    ps.appendChild(o);
  }
  $('colorBox').classList.remove('hidden'); S.colorOpen = true;
  colorApply();
}
function colorApply(fromHex) {   // 依 colorUI 的 hsv 重畫方塊與色相條、更新預覽（即時套在自己身上）
  const hex = fromHex || hsv2hex(colorUI.h, colorUI.s, colorUI.v);
  const sv = $('colorSV'), g = sv.getContext('2d'), W = sv.width, H = sv.height;
  g.fillStyle = hsv2hex(colorUI.h, 1, 1); g.fillRect(0, 0, W, H);
  let gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, '#000'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  const cx = colorUI.s * W, cy = (1 - colorUI.v) * H;
  g.lineWidth = 2; g.strokeStyle = colorUI.v > .5 ? '#000' : '#fff'; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke();
  const hu = $('colorHue'), h2 = hu.getContext('2d');
  gr = h2.createLinearGradient(0, 0, hu.width, 0);
  for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, hsv2hex(i * 60 % 360, 1, 1));
  h2.fillStyle = gr; h2.fillRect(0, 0, hu.width, hu.height);
  const hx = colorUI.h / 360 * hu.width;
  h2.fillStyle = '#fff'; h2.fillRect(hx - 2, 0, 4, hu.height); h2.strokeStyle = '#000'; h2.lineWidth = 1; h2.strokeRect(hx - 2.5, .5, 5, hu.height - 1);
  if (document.activeElement !== $('colorHex')) $('colorHex').value = hex;
  $('colorNow').style.background = hex;
  const wr = wardrobe();
  if (hex.toLowerCase() === colorUI.orig.toLowerCase()) delete wr.color[colorUI.slot]; else wr.color[colorUI.slot] = hex;   // 選回原色＝不換色
}
function closeColor(ok) {
  if (!S.colorOpen) return;
  const wr = wardrobe();
  if (!ok) { if (colorUI.before) wr.color[colorUI.slot] = colorUI.before; else delete wr.color[colorUI.slot]; }
  $('colorBox').classList.add('hidden'); S.colorOpen = false;
  saveAvatar(); buildAvatarPanel();
}
function colorDrag(el, fn) {   // 方塊／色相條：按下拖曳都會更新
  const at = e => { const r = el.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))); colorApply(); };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); at(e); });
  el.addEventListener('pointermove', e => { if (e.buttons & 1) at(e); });
}
colorDrag($('colorSV'), (x, y) => { colorUI.s = x; colorUI.v = 1 - y; });
colorDrag($('colorHue'), x => { colorUI.h = Math.min(359.9, x * 360); });
$('colorHex').addEventListener('input', e => {
  const v = e.target.value.trim(), m = /^#?([0-9a-f]{6})$/i.exec(v);
  if (m) { Object.assign(colorUI, hex2hsv('#' + m[1])); colorApply('#' + m[1].toLowerCase()); }
});
$('colorOk').onclick = () => closeColor(true);
$('colorCancel').onclick = () => closeColor(false);
$('colorReset').onclick = () => { Object.assign(colorUI, hex2hsv(colorUI.orig)); colorApply(); };

function saveAvatar() { lsSet('dcisland.m0.avatar', S.me); }

// ---------------- 武器列（左上角，橫向只有圖示）：滑鼠滾輪切換目前拿的武器；選到的那格才顯示名稱 ----------------
// 這是換武器的唯一入口（造型面板已沒有武器選項）；S.me.weapon，存檔沿用 dcisland.m0.avatar；拿著釣竿／法杖時換掉會自己收竿／中斷詠唱（各自每幀檢查）
let weaponBarKey = '';
function updateWeaponBar() {
  const bar = $('weaponBar'); if (!S.avatar) return;
  const key = S.me.weapon + '|' + S.me.job; if (key === weaponBarKey && bar.childElementCount) return;   // 武器或職業變了就重畫
  weaponBarKey = key; bar.innerHTML = '';
  for (const w of allowedWeapons()) {
    const row = document.createElement('div'); row.className = 'wrow' + (w.id === S.me.weapon ? ' cur' : '');
    const im = w.sprite && S.weaponImgs[w.id];
    if (im) { const cv = document.createElement('canvas'); cv.width = cv.height = 24; const g = cv.getContext('2d'); g.imageSmoothingEnabled = false; const sc = Math.min(24 / im.width, 24 / im.height); g.drawImage(im, (24 - im.width * sc) / 2, (24 - im.height * sc) / 2, im.width * sc, im.height * sc); row.appendChild(cv); }
    else { const ic = document.createElement('span'); ic.className = 'wic'; ic.textContent = '✋'; row.appendChild(ic); }
    row.dataset.name = w.name;   // 名稱只在選到的那格顯示（CSS ::after 讀這個）
    row.onclick = () => setWeapon(w.id);
    bar.appendChild(row);
  }
  bar.classList.remove('hidden');
}
function setWeapon(id) {
  if (S.me.weapon === id || !allowedWeapons().some(w => w.id === id)) return;   // 只能換成這個職業能用的武器
  S.me.weapon = id; saveAvatar(); updateWeaponBar();
}
function cycleWeapon(step) {
  const ws = allowedWeapons(), i = Math.max(0, ws.findIndex(w => w.id === S.me.weapon));
  setWeapon(ws[(i + step + ws.length) % ws.length].id);
}
let wheelAcc = 0, wheelAt = 0;
const wheelBlocked = () => S.mode !== 'walk' || S.helpOpen || S.listOpen || S.dexOpen || S.titleOpen || S.colorOpen || S.glamOpen || S.signOpen || S.confirmOpen;
document.addEventListener('wheel', e => {
  const t = e.target;
  if (t !== canvas && !t.closest?.('#weaponBar')) return;   // 只有在遊戲畫面或武器列上滾才切換（面板、視窗要照常捲動）
  e.preventDefault();
  if (wheelBlocked()) return;
  const now = performance.now();
  if (now - wheelAt > 400) wheelAcc = 0;   // 隔一陣子重新累積（觸控板會連發很多小量）
  wheelAcc += e.deltaY; wheelAt = now;
  if (Math.abs(wheelAcc) < 40) return;
  cycleWeapon(wheelAcc > 0 ? 1 : -1); wheelAcc = 0;
}, { passive: false });

// 換職業：特性立即生效（血量截到新上限，不回滿，避免換職業當補血用）；裝備自動換成該職業那套（外觀與換色每個職業各記一套）；
// 手上拿的是舊職業的武器就換成新職業的武器（空手／釣竿不動）；存檔沿用 dcisland.m0.avatar 這支 key
// 戰鬥中（場上有島主在仇恨／放招、或釣上來的怪物還在＝ownerEngaged）只能換一次職業，要等戰鬥結束才能再換（使用者定；純客戶端）
function setJob(id) {
  if (!JOBS[id] || S.me.job === id) return;
  if (ownerEngaged()) {
    if (S.jobSwapUsed) { toast('戰鬥中只能換一次職業，等仇恨解除後才能再換', 2200); return; }
    S.jobSwapUsed = true;
  }
  S.me.job = id;
  const p = S.players[0];
  if (p) { p.hp = Math.min(p.hp ?? Infinity, hpCap(p)); cancelCast(p); }
  if (!weaponAllowed(id, S.me.weapon)) S.me.weapon = JOBS[id].weapon || 'hands';
  saveAvatar(); buildAvatarPanel(); updateWeaponBar(); if (S.glamOpen) buildGlams();
  toast(`轉職「${JOBS[id].name}」（${JOBS[id].roleName}）`, 2600);
}



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
  if (S.titleOpen) { if (k === 'escape') closeTitles(); return; }                          // 稱號一覽開著：Esc 關閉（仍可走路）
  if (S.colorOpen) { if (k === 'escape') closeColor(false); return; }                      // 選色視窗開著：Esc 取消
  if (S.glamOpen) { if (k === 'escape') closeGlams(); return; }                            // 外觀一覽開著：Esc 關閉（仍可走路）
  if (S.helpOpen) { if (k === 'escape' || k === 'enter') closeHelp(); return; }       // 操作說明開著：Esc / Enter 關閉，其他鍵不處理
  if (S.confirmOpen) { if (k === 'escape') closeConfirm(); return; }   // 「要保存嗎？」開著時：Esc＝繼續編輯，其他鍵不處理
  if (k === 'escape' && !$('avatarPanel').classList.contains('hidden')) { $('avatarPanel').classList.add('hidden'); return; }   // 造型面板開著：Esc 先關面板（不會同時離開裝飾模式）；其他鍵照常
  if (k === 'e' && !e.repeat) {
    if (S.mode === 'decor') requestExitDecor();                       // 離開不受死亡影響
    else if (S.mode === 'walk') { if (S.players[0].dead) toast('你在墓碑裡動不了', 1400); else enterDecor(); }
  }
  if (k === 'escape' && S.mode === 'decor') requestExitDecor();     // Esc 也能離開裝飾模式
  if (k === 'l' && !e.repeat && S.mode === 'walk' && !S.confirmOpen) openList();
  if (k === 'f' && !e.repeat) doAttack(true);
  if (k === 'r' && !e.repeat) roleSkill()?.run();   // R：職能技能（坦克＝挑釁、補師＝群療、近戰輸出＝破綻、遠程輸出＝降傷）
  if ((k === '1' || k === '2') && !e.repeat) tryJobSkill(+k - 1);   // 1／2：職業技能
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
  const onOwner = S.mobs.some(a => {
    const od = mobDef(a.id);
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
  if (!S.mobs.some(a => !a.dead && Math.hypot(a.x - wx, a.y - wy) < 30 * (mobDef(a.id).big || 1))) {
    const d = decoAt(wx, wy);
    if (d) { useTool(d); return; }
  }
  if (Math.abs(wx - S.players[0].x) > 6) S.players[0].dir = Math.sign(wx - S.players[0].x);
  doAttack(false, wx, wy);
  // 沒命中但點到了一隻動物 → 牠的致公告告（FF14 點動物 FU）
  if (!S._hits) {
    for (const a of S.mobs) {
      if (!a.dead && Math.hypot(a.x - wx, a.y - wy) < 30 * (mobDef(a.id).big || 1)) {   // 島主很大隻：點擊範圍跟著放大
        say(mobDef(a.id).line, 2200);
        break;
      }
    }
  }
}
// 長按 F 或左鍵：冷卻一到就自動再揮（每幀呼叫；第一下由按下事件負責，之後這裡接手）
function autoAttack() {
  if (S.mode !== 'walk' || S.helpOpen || S.listOpen || S.signOpen || S.dexOpen || S.titleOpen || S.players[0].pose || S.t - S.players[0].lastAtk < ATK_CD) return;
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
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen || S.titleOpen) return;
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
  else toast('這裡放不下（水上要先鋪地板／已占用）');
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen || S.titleOpen) return;
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
$('btnHelp').onclick = () => { if (S.helpOpen) closeHelp(); else openHelp(); };   // 右上「操作說明」：和嚮導一樣的操作說明；開著時再按就關閉（同「圖鑑」）
$('btnAvatar').onclick = () => { $('avatarPanel').classList.toggle('hidden'); buildAvatarPanel(); };
$('avatarClose').onclick = () => { closeColor(false); closeGlams(); $('avatarPanel').classList.add('hidden'); };
$('btnDex').onclick = () => { if (S.dexOpen) closeDex(); else if (S.fishDB) openDex(); };   // 右上「圖鑑」：魚類圖鑑
$('dexClose').onclick = closeDex;
$('btnTitles').onclick = () => { if (S.titleOpen) closeTitles(); else openTitles(); };   // 造型面板的「稱號設定」：稱號一覽
$('titleClose').onclick = closeTitles;

// ---------------- 資源載入 ----------------
async function ensureTerrain(id) {
  if (S.tImages[id]) return;
  const man = S.terrains[id];
  const files = new Set([man.ground, man.edge, man.water]);
  for (const d of man.deco) files.add(d.sprite);
  const ims = {};
  // terrain.json 的 anims：{ 檔名: anim }，地面／岸邊／水／點綴物都可以各自設定動畫（沒設＝單張圖）
  await Promise.all([...files].map(async f => ims[f] = await loadSpr(`assets/terrain/${id}/${f}`, man.anims?.[f])));
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
  const [tjson, furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB] = await Promise.all([
    Promise.all(TERRAIN_IDS.map(id => loadJSON(`assets/terrain/${id}/terrain.json`))),
    loadJSON('assets/furniture/furniture.json'),
    loadJSON('assets/floors/floors.json'),
    loadJSON('assets/mobs/mobs.json'),    // 小動物（FF14 致敬）
    loadJSON('assets/npcs/npcs.json'),
    loadJSON('assets/tools/tools.json'),        // 採集工具（鎬子/斧頭）：圖放進 weaponImgs，讓繪製與遠端玩家共用同一套武器繪製
    loadJSON('assets/avatar/avatar.json'),
    loadJSON('assets/fish/fish.json'),          // 釣魚：各地形的魚與稀有度
    loadJSON('assets/skills/skills.json').catch(() => ({ skills: {} })),   // 島主招式（倒數條／招式名／要不要講台詞）；讀不到就照舊
    loadJSON('assets/titles/titles.json').catch(() => ({ titles: [] })),   // 稱號；讀不到就沒有稱號可選
    loadJSON('assets/jobs/jobs.json'),          // 職業（職能、職業武器、裝備、技能）
  ]);
  TERRAIN_IDS.forEach((id, i) => S.terrains[id] = tjson[i]);
  Object.assign(S, { furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB });
  loadJobs(jobsDB);
  S.myLook = myLook;   // net.js 送 state 時用（自己的顯示造型）
  S.floorSizes = new Map(floors.items.map(f => [f.id, { w: f.w || 1, h: f.h || 1 }]));   // 地板占幾格（地毯 2×2，其餘 1×1）
  S.me.job = jobIdOf(S.me.job) || DEFAULT_JOB;   // 舊存檔的坦克／補師／輸出照 legacy 轉成騎士／白魔法師／忍者；沒有或不合法＝忍者
  if (S.me.title && !titleDef(S.me.title)) S.me.title = null;   // 稱號已從清單移除：不顯示
  checkTitles(true);                       // 依現有紀錄算一次已解鎖的稱號（不跳提示）
  if (!S.me.weapon || !weaponAllowed(S.me.job, S.me.weapon)) S.me.weapon = JOBS[S.me.job].weapon || 'hands';   // 舊存檔的武器（例如圓盾）這個職業不能用／沒武器欄：換成職業武器
  // 圖片：同樣全部並行（含目前所在地形的圖）。只有角色身體是必要的（缺了畫不出人），其餘缺圖就略過該項
  await Promise.all([
    ...S.floors.items.map(async f => S.floorImgs[f.id] = await loadSpr(`assets/floors/${f.sprite}`, f.anim)),
    ...S.mobsDB.mobs.filter(a => a.sprite).map(async a => S.mobImgs[a.id] = await optImg(`assets/mobs/${a.sprite}`)),   // 外部素材為主的島主可以沒有 sprite（沒有圖可退回）
    ...S.mobsDB.mobs.filter(a => a.anim?.sheet).map(async a => {   // 多幀動畫：sheet 載入失敗就退回單張 sprite
      const sh = await optImg(`assets/${a.anim.sheet}`);
      if (sh) S.mobAnims[a.id] = loadAnim(sh, a.anim);
    }),
    ...S.toolsDB.tools.map(async t => S.weaponImgs[t.id] = await optImg(`assets/tools/${t.sprite}`)),
    optImg('assets/tombstone.png').then(im => S.tombImg = im),   // 死亡墓碑（島主龍衝打倒後原地出現）
    ...S.furn.items.map(async it => S.furnImgs[it.id] = await loadSpr(`assets/furniture/${it.sprite}`, it.anim)),
    // 人物分層 sheet：軀幹（膚色）是必要的（缺了畫不出人），頭髮／衣服／褲子／帽子缺圖就略過那一層
    ...S.avatar.skins.map(async s => S.charImgs[s.sheet] = await loadImg(`assets/avatar/${s.sheet}`)),
    ...[...S.avatar.hair, ...(S.avatar.tops || []), ...(S.avatar.bottoms || []), ...(S.avatar.hats || [])].filter(it => it.sheet)   // 沒有圖的（不戴帽子）不用載
      .map(async it => S.charImgs[it.sheet] = await optImg(`assets/avatar/${it.sheet}`)),
    ...S.avatar.weapons.filter(w => w.sprite).map(async w => {
      const im = await optImg(`assets/avatar/${w.sprite}`);
      if (im && w.back === 'hilt') im.hiltUp = true;   // 背在背上時劍柄朝上（drawWeaponBack 看這個旗標）
      if (im) im.carry = w.carry === 'waist' ? 'waist' : 'back';   // 不拿在手上時掛哪裡
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
      for (let i = S.mobs.length - 1; i >= 0; i--) {
        const a = S.mobs[i];
        if (a.dead) {
          a.dieT -= dt;
          if (a.dieT <= 0) {
            S.mobs.splice(i, 1);
            if (!a.proxy && !a.lurker) S.respawn.push({ id: a.id, at: S.t + (S.mobsDB.respawn || 30) });   // 島主（proxy）重生由伺服器的 spawn 事件驅動；釣上來的怪物不重生
          }
          continue;
        }
        stepMob(a, dt);
      }
      for (let i = S.respawn.length - 1; i >= 0; i--) {
        const r = S.respawn[i];
        if (S.t >= r.at) { S.respawn.splice(i, 1); respawnMob(r.id); }
      }
      stepDecos(dt); stepDrops(dt);
      for (let i = S.floaters.length - 1; i >= 0; i--) {
        const f = S.floaters[i];
        f.life -= dt;
        if (!f.slash && !f.beam && !f.beamLine && !f.healPulse && !f.orb && !f.aoe && !f.fxk) f.y -= 34 * dt;   // 爪擊/光束/綠圈特效固定在原座標，不隨飄字上浮
        if (f.life <= 0) S.floaters.splice(i, 1);
      }
      stepSkills();
      updateSkillBar();
      updateWeaponBar();
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
    onHeal: onNetHeal,       // 補師的群補事件（各客戶端自判自己是否在半徑內）
    onSkillEvent,            // 職業技能事件（群盾自判、別人畫面上的特效）
    onAdmin: v => { S.admin = !!v; updateDecorUI(); },
    onCommitResult: onCommitResult,
    onDecos: onNetDecos,
    onDeco: onNetDeco,
    onDragon: onNetDragon,   // 島主事件（aim/hp/dead/spawn/state 快照）
    onLurker: onNetLurker,   // 釣上來的敵對怪物（spawn/wander/claw/aggro/hp/dead/gone/state 快照）
    onFishResult,            // 釣魚結果（伺服器抽的魚；登入的人已記進伺服器的圖鑑）
    onDex: dex => { S.dex = dex || {}; S.dexSource = 'server'; if (S.dexOpen) buildDex(); checkTitles(true); },   // 登入後伺服器送來的圖鑑（稱號跟著重算，不跳提示）
    onOpen: net => {
      if (performance.now() >= welcomeUntil) toast(`已連上島（${net.room}）`, 2000);
      // 連上（或重連）時補傳目前地形的陸地位圖（新連線重新算「傳過沒」）
      S.landSent = null;
      uploadLandMap();
    },
  })).catch(err => console.warn('net:', err));
}

boot().catch(err => {
  console.error(err);
  toast('載入失敗：' + err.message);
});
