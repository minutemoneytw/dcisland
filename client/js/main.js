// DC島 — 遊戲本體（世界生成、移動、繪圖、戰鬥、動物、裝飾、造型、UI）。多人同步在 net.js，連線時以伺服器（Worker／dev_server）為準
const CELL = 32, COLS = 108, ROWS = 72;   // 島放大：鏡頭跟隨（2026-11-09 前七座島半徑 ×1.5：88×56 → 108×72，島心 (43.5,27.5) → (53.5,35.5)；舊家具座標不遷移）
const ISLAND_AREA = 2.25;   // 前七座島的面積倍數（半徑 1.5 倍）：野生動物數量照這個放大，素材（點綴物）本來就是每格機率，自動跟著多
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
const TERRAIN_IDS = ['grass', 'beach', 'snow', 'night', 'forest', 'volcano', 'machine', 'peace'];
const S = {
  terrain: (t => TERRAIN_IDS.includes(t) ? t : 'grass')(lsRaw('dcisland.m0.terrain')),   // 舊資料是純字串（非 JSON）
  terrains: {},                 // id -> manifest
  tImages: {},                  // id -> {file: Image}
  furn: null, furnImgs: {},
  avatar: null,
  charImgs: {},                 // 人物分層 sheet：檔名 -> Image（軀幹／頭髮／衣服／褲子／帽子）
  charCache: new Map(),         // (造型, 幀號) -> 合成好的一幀
  recolorCache: new Map(),      // (sheet, 顏色) -> 換好色的整張 sheet
  me: lsObj('dcisland.m0.avatar', null) || { skin: 'light', hair: 'hair1', race: 'human', gender: 'male', shirt: 0, weapon: 'sword' },
  profile: lsObj('dcisland.m0.profile', null) || { xp: 0, showLv: true },   // 等級等個人資料（跟著人走，換職業繼承；key＝dcisland.m0.profile）
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
  fireballs: [],                // 飛龍吐的火球（純客戶端投射物）：{x,y,tx,ty,ang,life,life0,dmg,name}
  campfire: null,               // 島上的營火（世界物件）：{terrain, slot, cell, x, y}；每 3 分鐘換位置
  campfireSpr: null,            // 營火 8 幀動畫（外部素材 campfire_sheet.png）
  fireballSpr: null,            // 飛龍火球 8 幀動畫（外部素材 fireball_sheet.png，特效不是 mob）
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
  craftDB: null, craftImgs: {},         // 合成：assets/craft/craft.json（手寫）與素材圖
  craft: craftNorm(lsObj('dcisland.m0.craft', {})),   // 解鎖紀錄 { mat, furn, rec }（登入者以伺服器為準）
  craftOpen: false, craftTab: null, craftSlots: [], craftMsg: '', craftFail: false,
  gamesDB: null, tableImgs: {},        // 和平島遊戲桌：遊戲定義（assets/games/games.json，手寫）與桌子圖
  ar: null, arOpp: {}, arRaf: 0, tableCab: -1,   // 俄羅斯方塊：自己這一局的本機狀態／別台的盤面快照／畫面迴圈／我走到的是第幾台
  tableOpen: false, tableId: null, tableView: null, tableChoice: false, gmStep: null, bk: null, tg: null, bkTimer: 0, bkOff: 0, bkTimeoutAt: 0, unTimer: 0, unOff: 0, unTimeoutAt: 0, unPick: null, dg: null, dgRaf: 0, dgLast: 0, ty: null, gamePlayed: false, gameXpSeen: 0, tblInfo: {},   // 遊戲畫面是否開著／哪一桌／伺服器給我的牌桌畫面／各桌人數（tblinfo）
  dexOpen: false, dexTab: null,        // 圖鑑視窗是否開著／正在看哪個地形
  titlesDB: { titles: [] },            // 稱號清單（assets/titles/titles.json，手寫）
  titleBook: lsObj('dcisland.m0.titles', {}), gstatsLocal: lsObj('dcisland.m0.gstats', {}), gstats: null, gstatsSrc: 'local', titleTab: 'battle',   // 稱號的本機紀錄：kills＝參與擊倒過的島主 {mob id: 1}；known＝已經提示過解鎖的稱號 id（避免重複跳提示）
  titleOpen: false,                    // 稱號一覽視窗是否開著
  ownerHitAt: {},                      // 自己最後一次打到各島主／魚人的時刻（S.t；「參與擊倒」＝倒下前 TITLE_ASSIST 秒內打過；訪客的擊倒 XP 獎勵也看這個）
};
// 舊存檔／被亂改的 localStorage 也要夾在安全範圍：與兩份伺服器的 XP_MAX 同值（2026-11-07 檢查時補）
S.profile.xp = Math.max(0, Math.min(200000, Math.floor(Number(S.profile.xp) || 0)));
if (typeof S.profile.showLv !== 'boolean') S.profile.showLv = true;
if (typeof S.profile.showHp !== 'boolean') S.profile.showHp = true;   // 底部 HUD：血量條（設定可關）
if (typeof S.profile.showXp !== 'boolean') S.profile.showXp = true;   // 底部 HUD：經驗條（設定可關）

// ---------------- 世界生成 ----------------
function key(x, y) { return x + ',' + y; }

// 室內房間的牆（2026-11-13，使用者要求）：北牆畫正面（walls.h 格高，貼在房間上緣外）、東西牆畫牆頂（1 格寬，貼在房間左右外側，
// 從北牆頂端一路到房間底部）；南面不畫。北牆在地板上投一道淡陰影。靠牆的街機（y＝14.5）上半截疊在北牆前面
function drawRoomWalls(W, ims, [bx0, by0, bx1, by1]) {
  const h = W.h || 2, top = by0 - h, n = ims[W.n], w = ims[W.w], e = ims[W.e];
  if (n) for (let x = bx0; x <= bx1; x++) drawSpr(n, 0, x * CELL, top * CELL, CELL, h * CELL);
  for (let y = top; y <= by1; y++) {
    if (w) drawSpr(w, 0, (bx0 - 1) * CELL, y * CELL, CELL, CELL);
    if (e) drawSpr(e, 0, (bx1 + 1) * CELL, y * CELL, CELL, CELL);
  }
  const g = ctx.createLinearGradient(0, by0 * CELL, 0, by0 * CELL + 12);
  g.addColorStop(0, 'rgba(0,0,0,.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(bx0 * CELL, by0 * CELL, (bx1 - bx0 + 1) * CELL, 12);
}
// 室內地形（layout:'room'）的方形房間範圍 roomBox＝[x0,y0,x1,y1]（含邊界的格）；範圍外不畫、不能走、不能釣魚。沒有 roomBox＝整張地圖
function inRoom(x, y, id = S.terrain) {
  const td = S.terrains[id], b = td?.layout === 'room' && td.roomBox;
  return !b || (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
}
function genWorld(id) {
  const rng = mulberry32(hashStr(id));
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5, rx = 43.5, ry = 29.25;   // 放大 5 倍級（2026-11-07 再放大約 24% 面積：原本 26／17.5；2026-11-09 半徑再 ×1.5：原本 29／19.5）
  const types = new Uint8Array(COLS * ROWS);
  const room = S.terrains[id]?.layout === 'room';   // 和平島：像室內——整張地圖都是地板，沒有水（2026-11-08 使用者要求移除最外圈的水；地圖邊界本來就走不出去）
  // 室內釣魚池（terrain.json 的 pools；2026-11-09）：池內是水（types 0，可以拋竿），外圍一圈是池邊（types 1，可以走）
  const inPool = (x, y, m) => (S.terrains[id]?.pools || []).some(p => x >= p.cell[0] - m && x < p.cell[0] + p.w + m && y >= p.cell[1] - m && y < p.cell[1] + p.h + m);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (room) {   // 和平島：方形房間 roomBox 內是地板（池另算）；房間外填 0（走不進去，但不畫也不能釣魚，見 inRoom）
      types[y * COLS + x] = !inRoom(x, y) ? 0 : inPool(x, y, 0) ? 0 : inPool(x, y, 1) ? 1 : 2;
      continue;
    }
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
    if (pool.length && rng() < .036) decos.push({ i: decos.length, sprite: pool[Math.floor(rng() * pool.length)], cell: [x, y], flip: rng() < .5 });
  }
  S.world = { types, decos };
  S.drops = [];
  S.fireballs = [];   // 換島：飛行中的火球作廢（純客戶端，不跨地形）
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
  const frames = Math.max(1, (spec && spec.frames | 0) || 1);
  const rows = Math.max(1, (spec && spec.rows | 0) || 1);
  // 單格尺寸：manifest 明確給 fw／fh 就用（多列 sheet、或素材有留邊／多餘的列），否則由圖片大小推（欄＝frames、列＝rows）
  const fw = (spec && spec.fw | 0) || Math.floor(img.width / frames);
  const fh = (spec && spec.fh | 0) || Math.floor(img.height / rows);
  return { img: spec?.keyBg ? keyBackground(img) : img, frames, rows, row0: (spec && spec.row0 | 0) || 0,
           rowIndex: spec?.rowIndex || null,   // 選用：這一列用 sheet 的第幾列（不連續時用，如 [0,2]）；沒給＝row0 起連續 rows 列
           fps: spec?.fps || 8, stagger: !!spec?.stagger, fw, fh, width: fw, height: fh };
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
function drawSpr(s, fi, dx, dy, dw = s.fw, dh = s.fh, row = 0) {
  const srow = s.rowIndex ? (s.rowIndex[row] ?? s.row0 + row) : s.row0 + row;
  ctx.drawImage(s.img, fi * s.fw, srow * s.fh, s.fw, s.fh, dx, dy, dw, dh);
}
// 依格子決定的固定相位（地形點綴物、家具：各自錯開，但每個人畫面一樣、重新整理也不變）
const cellPhase = (x, y) => ((x * 7 + y * 13) % 29) * .137;

// 動物多幀動畫（mobs.json 的 anim）：除了共通欄位，還有 dashFps（龍衝／飛行時）與 scale（1 個 sheet 像素畫幾 px，只管外觀）。
// 方向網格（選用）：rows／row0＝用哪幾列、rowDir＝每列是哪個方向（例如 ["up","right","down","left"]），
// 程式依動物的移動方向挑列、素材沒畫的方向用對向那一列左右鏡像（見 mobRowFor）。
function loadAnim(sheet, spec) {
  return { ...makeSpr(sheet, spec), dashFps: spec.dashFps || spec.fps || 8, scale: spec.scale || 2, rowDir: spec.rowDir || null };
}
// 方向網格：依朝向挑第幾列並決定要不要左右鏡像。素材只有「右」沒「左」時，往左＝畫右邊那一列再鏡像
const MOB_OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
function mobRowFor(an, face) {
  const rd = an.rowDir;
  let i = rd.indexOf(face);
  if (i >= 0) return { row: i, flip: false };
  i = rd.indexOf(MOB_OPP[face]);
  if (i >= 0) return { row: i, flip: true };
  i = rd.indexOf('right');                 // 上下等沒有專屬列：退回側面（朝右）
  return { row: i >= 0 ? i : 0, flip: false };
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
  S.respawn = [];   // 換島（或重生成世界）時重生佇列清空：新的島自己生一批，別島擊倒的不會跟過來（2026-11-09 修正：會在和平島冒出怪）
  const td = S.terrains[S.terrain];
  if (!S.mobsDB || !td.mobs?.length) return;
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  const spawnWild = (id) => {   // 找一塊陸地空格生一隻野外動物（生不下就放棄）
    for (let tries = 0; tries < 40; tries++) {
      const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
      if (S.world.types[y * COLS + x] !== 2) continue;
      if (Math.abs(x - cx) < 2 && Math.abs(y - cy) < 2) continue;
      if (S.occ.get(key(x, y)) !== undefined) continue;
      S.mobs.push({ id, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, dir: 1, target: null, idle: Math.random() * 2, startle: 0, z: 0, bounce: 0,
                       hp: mobDef(id).hp, maxHp: mobDef(id).hp, dead: false, dieT: 0 });
      return true;
    }
    return false;
  };
  // mobs.json 標 fixed: N 的種類（例如新怪）：在該島固定生 N 隻（保證一定看得到），不參與下面的隨機池
  const AREA = S.terrains[S.terrain]?.layout === 'room' ? 1 : ISLAND_AREA;
  for (const a of td.mobs) { const n = Math.round((mobDef(a.id)?.fixed || 0) * AREA); for (let i = 0; i < n; i++) spawnWild(a.id); }
  // 其他種類照舊：從權重池隨機抽 6 隻
  const pool = [];
  for (const a of td.mobs) if (!mobDef(a.id)?.fixed) for (let i = 0; i < a.weight; i++) pool.push(a.id);
  for (let n = 0; n < Math.round(6 * AREA) && pool.length; n++) spawnWild(pool[Math.floor(Math.random() * pool.length)]);
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
  if (!def || !(S.terrains[S.terrain]?.mobs || []).some(m => m.id === id)) return;   // 這座島本來就沒有這種動物（例如和平島）：不生
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
// 四方向攻擊（2026-11-09 使用者要求）：朝上下左右都能打。攻擊方向 p.adir＝出手當下朝向目標（滑鼠點的位置／目標）的四方向，
// F 鍵沒有目標就用目前面向；揮擊動作期間身體轉向 adir（LPC 的攻擊幀本來就有四方向）。上下的武器點比左右短一點（WEAPON_REACH_V）
const WEAPON_REACH = 30, WEAPON_REACH_V = 26;
const DIR4_VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// 向量 → 四方向：垂直分量比較大才算上下（斜的算左右，用側面揮）；向量太短就維持目前面向
const dir4To = (dx, dy, p) => Math.hypot(dx, dy) < 4 ? face4(p) : Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'left' : 'right');
// 目前面向的四方向：攻擊動作中＝adir；否則看畫面朝向（正上／正下才算上下，斜的算左右）
function face4(p) {
  if (p.adir && atkActive(p)) return p.adir;
  const d = p.d8;
  return d === 'up' || d === 'down' ? d : (p.dir < 0 ? 'left' : 'right');
}
const atkActive = p => p.swing > 0 || !!p.cast || (p.atkT0 != null && S.t - p.atkT0 < ATK_ANIM);
// 轉向目標：左右的 dir 照舊（左右翻轉、掛著的武器用），攻擊方向取四方向
function aimAt(p, tx, ty) {
  if (Math.abs(tx - p.x) > 6) p.dir = Math.sign(tx - p.x);
  p.adir = dir4To(tx - p.x, ty - p.y, p);
  p.d8 = p.adir; p.face = p.adir === 'up' || p.adir === 'down' ? p.adir : 'side';   // 立刻轉身（notifyAttack 會先送這個朝向）
}
const weaponPt = p => {
  const f = face4(p), [vx, vy] = DIR4_VEC[f];
  return { x: p.x + vx * WEAPON_REACH, y: p.y + vy * WEAPON_REACH_V };
};
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
    const [bx, by] = decoBase(d), dx = bx - p.x, dist = Math.hypot(dx, by - p.y), [vx, vy] = DIR4_VEC[face4(p)];
    if (dist >= bd || dx * vx + (by - p.y) * vy < -8) continue;   // 在背後的不算
    bd = dist; best = d;
  }
  return best;
}
function useTool(d) {
  const p = S.players[0], tgt = decoTarget(d), [bx, by] = decoBase(d);
  if (Math.hypot(bx - p.x, by - p.y) > S.toolsDB.range) { say(`離${tgt.name}太遠了，靠近一點`); return; }
  if (S.t - p.lastAtk < ATK_CD) return;
  aimAt(p, bx, by);
  p.lastAtk = S.t; p.swing = ATK_T; p.atkT0 = S.t;
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
  if (mine) { spawnDrops(tgt, bx, by); spawnCraftDrops(craftDecoDrops(d.sprite), bx, by); grantExp(1, bx, by - 40, 'mine'); toast(`${tgt.name}被破壞了`, 1600); }   // 採集成功（打壞的人）＋1 XP（登入者由伺服器記）
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
    if (matDef(dr.item)) { collectMaterial(dr.item, p.x, p.y); continue; }   // 合成素材：解鎖進圖鑑（不進背包、無限使用）
    S.inv[dr.item] = (S.inv[dr.item] || 0) + 1;
    lsSet('dcisland.m0.inv', S.inv);
    toast(`獲得 ${S.toolsDB.items[dr.item].name} ×1（共 ${S.inv[dr.item]}）`, 1600);
  }
}

// 空手揍人的特效（純畫面，沒有傷害）：出拳點在出手者面前 PUNCH_REACH 處，圈內的其他玩家（含自己）身上冒一個衝擊星。
// 自己出拳時本機呼叫；別人出拳時由 net.js 的 attack 事件（對方武器是空手）呼叫，各畫面自己算，不需要伺服器
const PUNCH_REACH = 34, PUNCH_R = 30;
function punchFx(a) {
  const [vx, vy] = DIR4_VEC[face4(a)], px = a.x + vx * PUNCH_REACH, py = a.y + vy * PUNCH_REACH;
  for (const q of [S.players[0], ...S.remotes.values()]) {
    if (!q || q === a || q.dead || q.pose) continue;
    if (Math.hypot(q.x - px, q.y - py) > PUNCH_R) continue;
    S.floaters.push({ x: q.x, y: q.y - 24, punch: true, life: .3 });
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
      const prop = quiet ? null : propNear(p);     // 身邊有餐飲區就吃喝（長按不重複）
      if (prop) { S._hits = 1; useProp(prop); S.holdSkipF = true; return; }
      const tbl = quiet ? null : tableNear(p);     // 身邊有遊戲桌就入座／觀戰（長按不重複開）
      if (tbl) { S._hits = 1; openTable(tbl); S.holdSkipF = true; return; }
      const npc = quiet ? null : npcNear(p);       // 身邊有 NPC 就跟他說話
      if (npc) { S._hits = 1; talkTo(npc); S.holdSkipF = true; return; }
    }
  }
  if (S.fx.seal) { if (!quiet) say('結印中，不能攻擊', 900); return; }
  if (p.leap) return;   // 跳躍中不能攻擊   // 忍術結印中（可移動、不能攻擊）
  if (isRod()) { S._hits = 1; if (!quiet) fishAction(wx, wy); return; }   // 拿著釣竿：拋竿（不能攻擊）
  if (S.me.weapon === 'hands') {   // 空手：揍人（純特效，沒有傷害、不打怪；2026-11-10 使用者要求）
    if (S.t - p.lastAtk < ATK_CD) return;
    if (wx != null) aimAt(p, wx, wy); else { p.adir = face4(p); p.d8 = p.adir; }
    p.lastAtk = S.t; p.swing = ATK_T; p.tool = null; p.atkT0 = S.t; S._hits = 1;
    S.net?.notifyAttack?.();   // 同島的人看到你出拳；他們的畫面會自己算打到誰（onPunch，不送新訊息）
    punchFx(p);
    return;
  }
  if (!S.weaponImgs[S.me.weapon]) return;
  if (S.t - p.lastAtk < ATK_CD) return;
  const rg = rangedDef();
  if (rg) { startCast(p, rg, wx, wy); return; }   // 法杖：遠距詠唱（以滑鼠瞄準，讀條完才出傷害）
  if (wx != null) aimAt(p, wx, wy); else { p.adir = face4(p); p.d8 = p.adir; }   // 四方向：朝點的位置揮；F 鍵朝目前面向
  p.lastAtk = S.t; p.swing = ATK_T; p.tool = null; p.atkT0 = S.t;
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
    p.lastAtk = S.t; p.swing = 0; p.tool = null; S._hits = 1; p.atkT0 = S.t;
    aimAt(p, a.x, a.y);
    S.net?.notifyAttack?.();
    const ty = a.y - 24 * (mobDef(a.id).big || 1) * .6;
    if (rg.shot === 'arrow') S.floaters.push({ fxk: 'arrow', x1: p.x + p.dir * 8, y1: p.y - 30, x2: a.x, y2: ty, life: .2 });
    else if (rg.shot === 'funnels') S.floaters.push({ fxk: 'funnels', x2: a.x, y2: ty, slots: noulithSlots(p.x, p.y, S.t, noulithSeed(p)).map(s => [s.x, s.y]), life: .45 });   // 賢具普攻：本體待機不動，四座依序從陣位射光束
    else S.floaters.push({ orb: true, x1: p.x + p.dir * 4, y1: p.y - 52, x2: a.x, y2: ty, life: .22 });
    hitMob(p, a, true);
    return;
  }
  p.cast = { t0: S.t, dur: rg.cast * castMul(p), a };   // 黑魔法師站在魔法陣內：詠唱 −50%
  aimAt(p, a.x, a.y);
  p.swing = 0; p.tool = null; S._hits = 1;   // 算有互動，點到動物時不要再跳動物的台詞
}
const CAST_SLIDE = 0.3;   // 滑步窗口（秒）：詠唱剩下這麼久時移動／跳躍不再中斷；武器的 ranged.slide 可覆蓋；窗口最多占詠唱的一半（魔法陣內詠唱減半時不會整段都能動）
const castSlideLen = c => Math.min(rangedDef()?.slide ?? CAST_SLIDE, c.dur * .5);
const inCastSlide = c => S.t - c.t0 >= c.dur - castSlideLen(c);
function cancelCast(p, why) { if (!p.cast) return; p.cast = null; if (why) toast(why, 1500); }
function stepCast(p) {   // 每幀（只有本機玩家）：檢查中斷條件、讀條完就出傷害
  const c = p.cast, rg = rangedDef();
  if (!c) return;
  if (p.dead || S.t < (p.petUntil ?? 0) || p.pose || p.fish || S.mode !== 'walk' || !rg) { cancelCast(p); return; }
  const a = c.a;
  if ((p.moving || p.z > 0 || p.vz > 0) && !inCastSlide(c)) { cancelCast(p, '詠唱中斷：移動了'); return; }   // 詠唱時不能移動（跳躍也算）；最後 CAST_SLIDE 秒是滑步窗口，移動不中斷（同 FF14）
  if (!S.mobs.includes(a) || a.dead || a.fly) { cancelCast(p, '詠唱中斷：目標消失了'); return; }
  if (!inCastRange(p, a, rg)) { cancelCast(p, '詠唱中斷：目標超出射程'); return; }
  aimAt(p, a.x, a.y);   // 面向目標（四方向）
  if (S.t - c.t0 < c.dur) return;
  p.cast = null; p.lastAtk = S.t - (ATK_CD - Math.min(ATK_CD, rg.gap ?? ATK_CD));   // 放完到下一次的間隔：預設 ATK_CD；武器的 ranged.gap 可縮短（咒杖 0＝連續施放）
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
    if (jd?.dmgPlus && !force) dmg += jd.dmgPlus;   // 輸出：每擊 +1（打島主也算；伺服器的上限是 HIT_MAX_BASE＝6）
    if (!force) dmg += lvAtkBonus(levelOf(p));      // 等級攻擊加成：每 3 級 +1（兩份伺服器的夾值同式放寬）
    const od = mobDef(a.id);
    const sendDmg = force ? force.dmg : Math.min(HIT_MAX_BASE + lvAtkBonus(levelOf(p)), dmg);   // 送給伺服器的值（上限 4＋攻擊者等級加成＝兩份伺服器的 dlHitMax；破綻的 +1 由伺服器自己加）
    if (od.owner && S.t < (a.vulnUntil ?? 0)) dmg += 1;      // 破綻：每擊 +1（單機在這裡扣、連線只是飄字）
    if ((od.owner || od.lurker) && p === S.players[0]) S.ownerHitAt[a.id] = S.t;   // 稱號「參與擊倒」＋擊倒獎勵（訪客）用：30 秒內打過牠
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
    const care = p === S.players[0] ? S.fx.care : null;   // 賢者關心：永久有效（改關別人／轉職才解除），每造成一次傷害就累積補血量
    if (care) {
      care.acc = (care.acc || 0) + JOB_SKILLS.care.amt + (fxOn('save') ? JOB_SKILLS.save.plus : 0);   // 拯救期間：累積速度變 5 倍（0.5→2.5／下）
      while (care.acc >= 1) {                             // 補血量是 0.5／下的零頭：累積湊滿 1 才補，畫面與血量都保持整數
        care.acc -= 1;
        if (care.self) healMe(1);
        else S.net?.skillEvent?.(`careheal:${care.id}:1`);
      }
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
    } else if (od.retaliate) {   // 反擊型野怪（飛龍／哥布林）：被打不逃，鎖定攻擊者（純客戶端；打野怪的只有本地玩家）
      a.startle = 0;
      // 咬擊節奏：只有「剛開始鎖定」才排下一口（2026-11-11 使用者回報修正：原本每被打一下就重設
      // clawAt，連續揮牠就永遠輪不到咬＝跑過來呆站給人打）；已經在咬的照自己的 1.5 秒節奏交換攻擊
      if (!a.aggroT) a.clawAt = S.t + 1.5;
      a.aggroT = p; a.lastHitAt = S.t;
      for (const b of S.mobs) {   // 群起（2026-11-09 使用者定，哥布林）：被打那隻 200px 內的「同種」一起鎖定攻擊者
        if (b !== a && !b.dead && b.id === a.id && Math.hypot(b.x - a.x, b.y - a.y) <= RETAL_PACK_R) {
          if (!b.aggroT) b.clawAt = S.t + 1.5;
          b.aggroT = p; b.lastHitAt = S.t;
        }
      }
    } else {
      a.target = fleeTarget(a, od, p.x, p.y, 220);
    }
    if (a.hp <= 0) {
      a.dead = true; a.dieT = .6;
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      if (p === S.players[0] && !od.owner && !od.lurker) { grantExp(mobKillXp(od), p.x, p.y - 60, 'mob'); spawnCraftDrops(S.craftDB?.sources.mob[od.id], a.x, a.y); }   // 合成素材：擊倒野外動物掉落   // 非主動怪（羊／鳥／蛙）：擊倒 +1 XP、會反擊的野怪＝島主經驗 1/10（登入者上報事件由伺服器記；島主／魚人那步由伺服器計）
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

// ---- 營火（2026-11-07 使用者定）----
// 島上隨機一處（只在陸地格、不進海裡），每 CAMPFIRE_PERIOD 秒換一個位置；站在 CAMPFIRE_R 內每 CAMPFIRE_HEAL_SEC 秒回 CAMPFIRE_HEAL HP。
// 位置由「地形＋時段」的種子決定：世界生成對所有玩家一致，所以大家算出來的營火位置一樣（不必動同步協定、不是伺服器狀態）。
// 回血只算自己（玩家血量本來就是各客戶端自判）；不論有沒有在戰鬥都能回（營火是補血點）。
const CAMPFIRE_PERIOD = 180, CAMPFIRE_R = 200, CAMPFIRE_HEAL = 1, CAMPFIRE_HEAL_SEC = 3;
const campfireSlot = () => Math.floor(Date.now() / (CAMPFIRE_PERIOD * 1000));
function campfireCellFor(terrain, slot) {   // 只挑陸地（types 2；0＝海、1＝岸邊）且沒有點綴物的格子
  const rng = mulberry32(hashStr(terrain + ':campfire:' + slot));
  const decos = new Set(S.world.decos.map(d => d.cell[0] + ',' + d.cell[1]));
  const cand = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (S.world.types[y * COLS + x] !== 2) continue;
    if (decos.has(x + ',' + y)) continue;
    cand.push([x, y]);
  }
  return cand.length ? cand[Math.floor(rng() * cand.length)] : null;
}
function updateCampfire() {   // 每幀呼叫：換時段（或換地形）就重擲一次位置
  if (S.terrains[S.terrain]?.campfire === false) { S.campfire = null; return; }   // 這座島沒有營火（和平島）
  const slot = campfireSlot(), c = S.campfire;
  if (c && c.terrain === S.terrain && c.slot === slot) return;
  const cell = campfireCellFor(S.terrain, slot);
  S.campfire = cell ? { terrain: S.terrain, slot, cell, x: cell[0] * CELL + CELL / 2, y: (cell[1] + 1) * CELL } : null;
}
function campfireHeal(p, dt) {   // 站在營火範圍內：每 3 秒回 1 HP（自己）
  const c = S.campfire, capHp = hpCap(p);
  if (!c || p.dead || (p.hp ?? capHp) >= capHp || Math.hypot(p.x - c.x, p.y - c.y) > CAMPFIRE_R) { p.cfAcc = 0; return; }
  p.cfAcc = (p.cfAcc || 0) + dt;
  if (p.cfAcc >= CAMPFIRE_HEAL_SEC) {
    p.cfAcc -= CAMPFIRE_HEAL_SEC;
    p.hp = Math.min(capHp, (p.hp ?? capHp) + CAMPFIRE_HEAL);
    S.floaters.push({ x: p.x + (Math.random() * 12 - 6), y: p.y - 50, v: `+${CAMPFIRE_HEAL}`, life: .8 });
  }
}
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
// ---------------- 等級（2026-11-06）----------------
// 個人資料：跨職業繼承、跨島不重置；XP 由本機先記（之後同步那步改成伺服器權威記帳＋夾頻，body 只上報事件種類）
// 每級需求線性（無上限）10 + 5×(Lv−1)；每級血量上限 +1、每 3 級攻擊 +1（第 4／7／10…級）。
const xpNeed = lv => 10 + 5 * (lv - 1);   // 從 lv 升到 lv+1 所需 XP
function lvInfo(xp) {                     // XP 換等級：lv＝目前等級、cur＝這級累積、need＝這級需求
  let lv = 1, rest = Math.max(0, Math.floor(xp ?? 0));
  while (lv < 2000 && rest >= xpNeed(lv)) { rest -= xpNeed(lv); lv++; }   // 上限 2000 級：與兩份伺服器一致，也防亂改的存檔讓迴圈跑不完
  return { lv, cur: rest, need: xpNeed(lv) };
}
const HIT_MAX_BASE = 6;   // 打島主／魚人的單擊上限基底（與兩份伺服器的 D_HIT_MAX 一致；實際上限＝這個＋lvAtkBonus）
const lvAtkBonus = lv => Math.floor((lv - 1) / 3);   // 攻擊加成：每 3 級 +1
const levelOf = p => p === S.players[0] ? lvInfo(S.profile.xp).lv : (p.lvl ?? 1);   // 自己看本機資料；別人等 state 廣播 lvl（同步那步），沒有就當 Lv 1
// ---- 島主／深海魚人的等級（第 3 步；與 worker/src/index.js、tools/dev_server.py 的 helper 同式，三邊一起改）----
// 連線時等級由伺服器事件帶出（事件欄位 lvl／max）；單機「本地模擬」才在記憶體累積（session 內有效、不存存檔）
const dlXpNeed = lv => 20 + 10 * (lv - 1);   // 島主每級需求 XP
function dlLvOf(xp) {                        // 島主等級：XP 無上限直算（僅單機模擬用）
  let lv = 1, rest = Math.max(0, Math.floor(xp ?? 0));
  while (rest >= dlXpNeed(lv)) { rest -= dlXpNeed(lv); lv++; }
  return lv;
}
const dlHpUp = 25, lurkHpUp = 5;   // 島主／魚人每級血量上限加成（基礎 200／20，max 取 mobs.json 的 hp）
const ownerDmgBonus = lv => Math.floor((Math.max(1, lv) - 1) / 2);   // 島主爪擊與台詞招式每 2 級 +1（命令檢定不隨等級變強：倒地不看血量）
const lurkDmgBonus = lv => Math.floor((Math.max(1, lv) - 1) / 3);    // 魚人爪擊每 3 級 +1
const ownerKillXp = lv => 20 + 5 * lv;   // 擊倒島主的 XP 獎勵（30 秒內的參與者）
const lurkKillXp = lv => 4 + 2 * lv;     // 擊倒魚人的 XP 獎勵（登入者由伺服器在 dead 時直給；訪客在本機記）
const mobKillXp = def => {   // 擊倒野外動物的 XP（2026-11-09 使用者定）：一般野怪 +1；反擊型野怪＝本島島主經驗值的 1/N、最低 1（N＝def.xpFrac，沒給就用 def.ownerFrac：飛龍 10、哥布林 12、殭屍 8）
  if (def.xp) return def.xp;   // 等級制新怪（2026-11-12）：產生器依 lv 算好寫在 mobs.json（1+lv÷4），被動怪也有分
  if (!def.retaliate) return 1;
  const ol = S.mobs.find(v => !v.dead && mobDef(v.id)?.owner)?.lvl ?? 1;   // 本島島主現在的等級（島主升級就跟著漲）；沒有島主的地形當 Lv 1
  return Math.max(1, Math.floor(ownerKillXp(ol) / (def.xpFrac || def.ownerFrac || 10)));
};
function saveProfile() { lsSet('dcisland.m0.profile', S.profile); }
const xpServer = () => !!(S.net?.connected && S.net.uid);   // 登入＆連線：XP 由伺服器記帳（2026-11-07 第 2 步）；訪客／沒連線照舊本機記
function levelUpFx(p, afterLv) {         // 升級演出（本機記帳與伺服器回覆共用）：回滿血＋金光＋飄字
  p.hp = hpCap(p);                       // 升級回滿血
  p.regenAcc = 0;
  S.floaters.push({ x: p.x, y: p.y - 56, v: `升級！Lv ${afterLv}`, life: 1.6, crit: true });
  S.floaters.push({ x: p.x, y: p.y, gold: true, life: .7 });   // 金光：金環擴散＋小光點
  toast(`升級了！Lv ${afterLv}（血量上限 +1${afterLv > 1 && afterLv % 3 === 1 ? '、攻擊力 +1' : ''}）`, 3200);
  if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel();   // 面板開著就同步進度條
}
function grantExp(n, x, y, reason) {     // 拿經驗值：金色 +N XP 飄字；升級＝金光演出＋回滿血（升級獎勵感）
  if (xpServer()) {                      // 登入者：伺服器記帳，等 xp 回覆再演出。擊倒非主動怪要上報事件（server 無法驗證，夾頻防灌分）；採集／釣魚伺服器自己知道，連訊息都不用送
    if (reason === 'mob') S.net?.xpEvent?.('mob', n);   // 會反擊的野怪給的 XP 不是 1（＝島主經驗 1/10），事件要帶數量（伺服器夾 1～25）
    return;
  }
  const p = S.players[0], before = lvInfo(S.profile.xp).lv;
  S.profile.xp = Math.max(0, S.profile.xp + n);
  saveProfile();
  const after = lvInfo(S.profile.xp);
  S.floaters.push({ x: x, y: y, v: `+${n} XP`, life: .9, xpGain: true });
  if (after.lv > before) levelUpFx(p, after.lv);
}
function loseExp() {                     // 倒地 10% 機率扣 XP：扣「升這級還需要的 XP」5%（整數、至少 1、最低扣到 0 不掉級）
  if (xpServer()) return;                // 登入者：伺服器看 state.dead 自己知道並抽 10%（本機不記，避免改存檔灌分）
  const i = lvInfo(S.profile.xp);
  if (Math.random() >= .1 || i.cur <= 0) return;
  const loss = Math.min(i.cur, Math.max(1, Math.ceil(i.need * .05)));
  S.profile.xp -= loss;
  saveProfile();
  S.floaters.push({ x: S.players[0].x, y: S.players[0].y - 46, v: `−${loss} XP`, life: 1.2, xpLoss: true });
}
// 伺服器回來的 XP 記帳結果（不廣播、只給本人）：以伺服器為準更新本機映像＋飄字；k＝init（登入時同步存檔）只更新不演出
function onNetXp(m) {
  if (typeof m.xp !== 'number') return;
  if (m.k === 'init') {
    S.profile.xp = Math.max(0, Math.floor(m.xp));
    saveProfile();
    if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel();
    return;
  }
  const d = Math.round(m.d || 0);
  if (!d) return;
  if (m.k === 'game' && d > 0) tableXpLine(d);   // 玩小遊戲得到的 XP：登入者由伺服器記，這裡把提示放進牌桌下方的系統訊息
  const p = S.players[0], before = lvInfo(S.profile.xp).lv;
  S.profile.xp = Math.max(0, Math.floor(m.xp));
  saveProfile();
  if (d > 0) S.floaters.push({ x: p.x, y: p.y - 60, v: `+${d} XP`, life: .9, xpGain: true });
  else S.floaters.push({ x: p.x, y: p.y - 46, v: `−${-d} XP`, life: 1.2, xpLoss: true });
  const after = lvInfo(S.profile.xp);
  if (after.lv > before) levelUpFx(p, after.lv);
}
// me 回覆（net.js 轉）：登入成功才走伺服器記帳；伺服器沒有紀錄時把本機存檔一次性上繳（2026-11-07 使用者定 (a)：上繳＋之後以伺服器為準）
function onNetMe(m) {
  if (!(m.auth && typeof m.uid === 'string')) return;
  if (m.xpKnown !== false || S.xpMigrated) return;   // 伺服器已有紀錄（會另送 xp init 覆寫本機映像）；這個分頁已上繳過就不再送
  S.xpMigrated = true;
  const v = Math.max(0, Math.floor(S.profile.xp || 0));
  if (v > 0) S.net?.xpSync?.(v);         // 0 就不用送：之後第一筆記帳會在伺服器開紀錄
}
const HEAL_RADIUS = 110;  // 補師打倒動物／群療時的治療半徑（約 3.4 格；2026-11-05 由 96 調大，與月環內圈安全區同大）
// 自己看「造型」面板選的職業（S.me.job）；別人看 state 封包同步的 job（舊客戶端的 tank／healer／dps 照 legacy 轉）；NPC 沒有職業（回 null）
const jobOf = p => JOBS[jobIdOf(p === S.players[0] ? S.me.job : p.job)] || null;
// 血量上限：有職業用職業的上限，沒有（NPC／未設定）就 PLAYER_HP；等級每級 +1（等級跟著人走，換職業繼承）
const hpCap = p => (jobOf(p)?.hpMax ?? PLAYER_HP) + (p.npc ? 0 : levelOf(p) - 1);
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
  const bon = ownerDmgBonus(a.lvl ?? 1);   // 島主等級傷害加成：每 2 級 +1（單機看本地模擬、連線看事件的 lvl）
  const hurt = dmg => {
    if (me.dead || !(dmg > 0)) return;
    playerDamage(me, dmg + bon, `${def.name}的${nm}`);
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
  if (hit(me)) { playerDamage(me, OWNER_BEAM_DMG + ownerDmgBonus(a.lvl ?? 1), def.name); S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 }); }
  for (const r of S.remotes.values()) if (hit(r)) S.floaters.push({ x: r.x, y: r.y - 24, ring: true, life: .35 });   // 遠端由對方自判，這裡只演出
  toast(`${def.name} 的波動砲發射了！`, 2000);
}

// ---- 命令（壓力山大的攻擊，atk: "command"）：不瞬移，原地讀條 2 秒 → 下達「行動命令」或「靜止命令」----
// 讀條結束的瞬間檢查玩家：「行動命令」＝最近 0.5 秒內有移動輸入、「靜止命令」＝最近 0.5 秒完全沒動；不服從就強制倒地（不看血量）。
// 判定在各人自己的畫面（跟龍衝／石化同源）；伺服器只決定時間點與命令種類。台詞招式（lineSkills 的 act／still）與普攻共用同一套讀條檢定
// （a.command 牆鐘，單機與連線同構）；p.lastMoveAt 在 stepPlayer／stepRemote 隨移動輸入更新（石化／擊飛／坐睡中不更新＝視為靜止）。
function startCommandCheck(a, kind, castMs, mv) {   // 開始一次命令讀條（kind＝'act'｜'still'）；mv＝台詞招式的命令（讀條中照伺服器移動，不釘在原地）
  const def = mobDef(a.id);
  a.command = { t0ms: Date.now(), castMs, kind, x: a.x, y: a.y, mv: !!mv };
  a.wleg = null; a.z = 0; a.fly = false;
  toast(kind === 'act'
    ? `${def.name} 下達了行動命令——讀條結束前開始移動！`
    : `${def.name} 下達了靜止命令——立刻停住不動！`, 2600);
}
function stepCommandCheck(a, def) {   // 命令讀條推進（牆鐘與伺服器同軸）：到點就本地檢定
  const c = a.command, el = Date.now() - c.t0ms;
  if (!c.mv) { a.x = c.x; a.y = c.y; a.z = 0; a.fly = false; }   // 正規命令：島主原地不動；台詞招式的命令照伺服器追殺走（再釘住＝檢定結束瞬間瞬移）
  a.cast = Math.max(0, (c.castMs - el) / 1000);   // 給倒數條沿用既有繪製（cast > 0 且 bar:true 就會畫）
  if (el >= c.castMs) commandFire(a, def);
}
function commandFire(a, def) {   // 讀條結束：檢定（自己＝真判定；遠端＝只畫演出，由對方畫面自判）
  const kind = a.command?.kind;
  a.command = null; a.cast = 0;
  a.rageCd = S.t + OWNER_CD;
  const me = S.players[0];
  // 判定用「真實時鐘」的移動輸入（me.lastInputWall：keydown 含 OS 重複鍵＋stepPlayer 每幀都會刷新），檢定窗與讀條同一條牆鐘軸。
  // 2026-11-06 修正：原本用遊戲時間 S.t——Discord webview 的 rAF 被節流時 S.t 落後真實時間、節流期間的輸入又沒被記錄，造成「該中沒中」
  const stationary = me.pose || me.knock || S.t < (me.petUntil ?? 0);   // 石化／被擊飛／坐著睡著＝視為靜止（原設計；避免按住的鍵被 OS 重複鍵出賣）
  const moving = !stationary && me.lastInputWall != null && Date.now() - me.lastInputWall < OWNER_CMD_LEEWAY * 1000;
  if (!me.dead) {
    if (kind === 'act' && !moving) killPlayer(me, def.name, '行動命令');
    if (kind === 'still' && moving) killPlayer(me, def.name, '靜止命令');
  }
  for (const r of S.remotes.values()) {   // 遠端只畫演出（由對方畫面自判）；這裡用對方回報的 moving 大概估
    if (r.dead) continue;
    const rmoving = r.lastMoveAt != null && (S.t - r.lastMoveAt) < OWNER_CMD_LEEWAY;
    if ((kind === 'act' && !rmoving) || (kind === 'still' && rmoving)) S.floaters.push({ x: r.x, y: r.y - 40, v: '……', life: .8 });
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
// 單機本地模擬的島主／魚人擊倒玩家等級（第 3 步；session 內記憶體累積、不寫存檔）：與兩份伺服器的 creditMobKill 同一套數值。
// 島主：擊倒得 XP＝10＋2×受害者等級、每級血量上限 +25（順手回一點血）；魚人：每殺 1 人 +1 級、上限 +5。只在本機玩家扣到 0 的那一擊記
function ownerLocalKillCredit(a, t) {
  if (a.proxy || t !== S.players[0] || !t.dead) return;
  const def = mobDef(a.id);
  if (def.owner) {
    a.xp = (a.xp ?? 0) + 10 + 2 * levelOf(t);
    const lv = dlLvOf(a.xp);
    if (lv !== (a.lvl ?? 1)) { a.maxHp = (a.maxHp ?? def.hp) + dlHpUp * (lv - (a.lvl ?? 1)); a.lvl = lv; }
    a.hp = Math.min(a.maxHp, (a.hp ?? a.maxHp) + dlHpUp);
  } else if (def.lurker) {
    a.lvl = (a.lvl ?? 1) + 1;
    a.maxHp = (a.maxHp ?? def.hp) + lurkHpUp;
    a.hp = Math.min(a.maxHp, (a.hp ?? a.maxHp) + lurkHpUp);
  }
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
S.fx = { cd: {}, guard: 0, kshield: 0, wshield: 0, vamp: 0, wings: 0, seal: null, triple: null, circle: null, care: null, cared: 0, caredBy: null, song: 0, save: 0 };
S.sprint = false;   // 疾走（跑步）：右下角虛擬按鍵或 Shift「切換」（2026-11-06 起 Shift 為切換制，不再按住才跑）
const SHIELD_RADIUS = 300;   // 兩種群盾的範圍（px，約 9 格；使用者定）
const ROLE_DEBUFF = { dur: 10, cd: 30, weakMul: .7 };   // 破綻／降傷：持續 10 秒、冷卻 30 秒、降傷 −30%（與兩份伺服器的 D_DEBUFF_* 一致）
const fxOn = k => S.t < (S.fx[k] || 0);
const skillCdLeft = id => Math.max(0, (S.fx.cd[id] || 0) - S.t);
function myFx() {   // 給 state 的持續型效果清單（id 要符合伺服器的 ID_RE）
  const F = S.fx, out = [];
  for (const k of ['guard', 'kshield', 'wshield', 'vamp', 'wings', 'cared', 'song', 'save']) if (fxOn(k)) out.push(k);   // cared＝被賢者關心中、song＝唱歌加成中、save＝拯救中
  if (F.seal) out.push('seal');
  if (F.triple && F.triple.n > 0 && S.t < F.triple.until) out.push('triple' + F.triple.n);
  out.push(...foodFxIds());   // 餐飲區吃喝的效果（變大／縮小／透明／暈眩／中毒）：別人也看得到
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
  care:     { name: '關心', cd: 20, amt: .5, range: 320, desc: '指定滑鼠方向最近的一位玩家（附近沒人就是自己）：永久有效，賢者每造成 2 次傷害，對方回 1 血；再施放會改關新的對象',
              run(me) {
                const prev = S.fx.care;   // 改關對象前的舊關心（判斷要不要解除自己頭上的愛心）
                const t = pickHealTarget(me, this.range);
                S.fx.care = { id: t === me ? null : String(t.id), self: t === me, name: t === me ? '自己' : t.name, acc: 0 };
                S.floaters.push({ fxk: 'heart', x1: me.x, y1: me.y - 40, x2: t.x, y2: t.y - 30, life: .6 });
                {   // 四座賢具本體一起飛出去繞對象一圈再回來（待機位在 drawNoulithIdle 會暫時全缺席）——手上是賢具才演
                  if ((me.tool || S.me.weapon) === 'tome') {
                    const slots = noulithSlots(me.x, me.y, S.t, noulithSeed(me));
                    S.floaters.push({ fxk: 'carego', sx: slots.map(s => s.x), sy: slots.map(s => s.y), x2: t.x, y2: t.y - 24, p: me, life: .7 });
                  }
                }
                if (t === me) {   // 關心作用在誰身上，誰才有愛心（2026-11-07 使用者定）：關自己＝愛心在自己頭上（永久有效：心形顯示與補血資格沒有時限）
                  S.fx.cared = Infinity;
                } else if (prev && prev.self) {   // 改關別人：解除「自己關自己」的愛心；被其他賢者關心的愛心不動，由那位賢者改關時才解除（收 care 事件那段）
                  S.fx.cared = 0;
                }
                S.net?.skillEvent?.(`care:${S.net?.id}:${t === me ? me.id : t.id}`);   // 廣播新對象（帶賢者 id：原本被這位賢者關心的人收到就解除）
                toast(`關心了 ${S.fx.care.name}（永久，直到改關別人）`, 1400);
                return true;
              } },
  save:     { name: '拯救', cd: 30, dur: 8, plus: 2, desc: '8 秒內關心的回血量變 5 倍：每下傷害回 2.5 血（要先關心一位玩家）',
              usable() { return S.fx.care ? null : '還沒有關心的人'; },
              run() {
                if (!S.fx.care) { toast('先用「關心」指定一位玩家', 1600); return false; }
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
  else if (kind.startsWith('care:') || kind.startsWith('careheal:')) {   // 賢者的關心：care:賢者id:對象id（對象換人／解除）｜careheal:對象id:1
    const heal = kind.startsWith('careheal:');
    if (heal) {
      const [tid, a] = kind.slice(9).split(':');
      if (tid !== String(S.net?.id)) return;
      if (fxOn('cared')) healMe(Math.max(1, Math.min(JOB_SKILLS.care.amt + JOB_SKILLS.save.plus, Math.round(+a) || JOB_SKILLS.care.amt)));   // 回血量由賢者帶（補 1，拯救期間累積較快），夾在合理範圍
    } else {
      const [sid, tid] = kind.slice(5).split(':');
      if (tid === String(S.net?.id)) { S.fx.cared = Infinity; S.fx.caredBy = sid; S.floaters.push({ fxk: 'heart', x1: r.x, y1: r.y - 40, x2: me.x, y2: me.y - 30, life: .6 }); toast(`${r.name} 關心了你（永久）`, 1600); }
      else if (S.fx.caredBy === sid) { S.fx.cared = 0; S.fx.caredBy = null; }   // 這位賢者改關別人了：解除自己身上的關心狀態
    }
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
  if ((me.tool || S.me.weapon) === 'tome') {
    // 賢者（賢具）：四座賢具變藍、分散到東南西北的最大範圍撐起一圈淡光再飛回（取代綠圈；本地演出）
    const slots = noulithSlots(me.x, me.y, S.t, noulithSeed(me));
    S.floaters.push({ fxk: 'healgo', sx: slots.map(s => s.x), sy: slots.map(s => s.y), p: me, life: .65 });
  } else {
    S.floaters.push({ x: me.x, y: me.y - 24, healPulse: true, life: .35 });   // 綠圈從腳下擴散（沒有賢具的補師）
  }
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
// 底部 HUD（#skillBar）＝上排技能格＋下排血量條／經驗條；任一可見就顯示整個容器
const showHpBar = () => S.profile.showHp !== false, showXpBar = () => S.profile.showXp !== false;
function syncHud() {
  const slots = skillUI.slots.length > 0, stat = showHpBar() || showXpBar();
  $('skillBar').classList.toggle('hidden', !slots && !stat);
  $('skillSlots').style.display = slots ? '' : 'none';
  $('statHp').classList.toggle('hidden', !showHpBar());
  $('statXp').classList.toggle('hidden', !showXpBar());
  $('app').classList.toggle('has-skill', slots);
  $('app').classList.toggle('has-stat', stat);
}
function buildSkillBar() {
  const bar = $('skillSlots'); bar.innerHTML = '';
  skillUI.slots = skillSlots().map(sk => {
    const el = document.createElement('div'); el.className = 'skslot';
    el.innerHTML = '<div class="skbtn"><canvas width="40" height="40"></canvas><div class="skcd"></div><div class="sknum"></div><span class="skkey"></span></div><div class="skname"></div>';
    drawSkillIcon(el.querySelector('canvas'), sk.id);
    el.querySelector('.skkey').textContent = sk.key; el.querySelector('.skname').textContent = sk.name;
    el.querySelector('.skbtn').onclick = () => sk.run();
    bar.appendChild(el);
    return { sk, btn: el.querySelector('.skbtn'), cd: el.querySelector('.skcd'), num: el.querySelector('.sknum'), cdLeft: 0, dim: null, ready: null, n: '' };
  });
  syncHud();
}
// 血量條（血條＋數字；30% 以下轉紅）與經驗條（Lv＋這級進度）：每幀呼叫，值沒變就不動 DOM
const statUI = { hp: '', hpPct: -1, hpLow: null, xp: '', xpPct: -1 };
function updateStatBars() {
  const me = S.players[0];
  if (!me) return;
  if (showHpBar()) {
    const cap = Math.max(1, hpCap(me)), hp = Math.max(0, Math.min(cap, me.hp ?? cap));
    const txt = `${hp} / ${cap}`, pct = Math.round(hp / cap * 100), low = hp / cap <= .3;
    if (txt !== statUI.hp) { $('statHp').querySelector('span').textContent = txt; statUI.hp = txt; }
    if (pct !== statUI.hpPct) { $('statHp').querySelector('i').style.width = pct + '%'; statUI.hpPct = pct; }
    if (low !== statUI.hpLow) { $('statHp').classList.toggle('low', low); statUI.hpLow = low; }
  }
  if (showXpBar()) {
    const li = lvInfo(S.profile.xp);
    const txt = `Lv.${li.lv}  ${li.cur} / ${li.need}`, pct = Math.round(li.cur / li.need * 100);
    if (txt !== statUI.xp) { $('statXp').querySelector('span').textContent = txt; statUI.xp = txt; }
    if (pct !== statUI.xpPct) { $('statXp').querySelector('i').style.width = pct + '%'; statUI.xpPct = pct; }
  }
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
        S.floaters.push({ x: (a.x + t.x) / 2, y: (a.y + t.y) / 2 - 24, v: String(OWNER_CLAW_DMG + ownerDmgBonus(a.lvl ?? 1)), life: .8, crit: true });
        S.floaters.push({ x: t.x, y: t.y - 24, ring: true, life: .35 });
      } else {
        playerDamage(t, OWNER_CLAW_DMG + ownerDmgBonus(a.lvl ?? 1), def.name);
        ownerLocalKillCredit(a, t);
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
  if (a.command) {
    const mv = a.command.mv;
    stepCommandCheck(a, def);
    if (!mv) return;   // 正規命令：島主釘在原地（伺服器也在原地）。台詞招式的命令往下走——
    // 伺服器不知道客戶端在讀條，qfire 後照樣排追殺腿朝目標跑；這裡若釘在原地，檢定結束的瞬間就得瞬移去追伺服器位置。
    // 改成讀條中也照伺服器的腿走（全畫面位置一致、過程連續），檢定照常由 stepCommandCheck 牆鐘判定
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
      a.command = null; a.beam = null; a.cast = 0;
      beamFire(a, def);   // castFrom（鎖定方向）由 beamFire 讀完自己清掉；先清的話會退回島主面向的正左／正右，跟預兆方向對不上
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
  // 台詞招式的命令（qfire 後的 2 秒檢定）在伺服器端是 idle（沒有 aim_tms），每個 state tick 的快照若把 a.command 洗掉，
  // 本地檢定就永遠不會跑＝「該中沒中」。所以還沒到點的命令要保留，讓 stepCommandCheck 照牆鐘跑完檢定（2026-11-06 修正）；
  // 命令帶 mv（台詞招式）時下面的 idle 分支會照伺服器追殺更新位置——讀條中不釘在原地，才不會在檢定結束瞬間瞬移。
  // 至於伺服器 ph='cast' 的正規命令，下面 cast 分支會用伺服器時間軸重建，不受影響
  const keepCmd = a.command && Date.now() - a.command.t0ms < a.command.castMs;
  a.hp = o.hp; a.dead = false; a.dieT = 0; a.startle = 0; a.target = null; a.wleg = null; a.cycle = null; a.gaze = null; a.beam = null;
  if (o.lvl != null) a.lvl = o.lvl;   // 快照帶等級與血量上限（島主等級存一起，重生後也保留）
  if (o.max != null) a.maxHp = o.max;
  if (!keepCmd) a.command = null;
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
  if (m.ev === 'hp') {   // 別人（或自己）打到牠：更新血條（連 max／lvl 一起跟上＝升級時的血量上限跳升）
    if (a) { a.hp = m.hp; if (m.max != null) a.maxHp = m.max; if (m.lvl != null) a.lvl = m.lvl; }
    return;
  }
  if (m.ev === 'dead') {   // 被打倒了：原地死亡；重生等伺服器的 spawn 事件，不排本地重生
    if (a && !a.dead) {
      a.dead = true; a.dieT = .6; a.fly = false; a.dashU = null; a.cast = 0; a.castFrom = null; a.rest = 0; a.wleg = null; a.cycle = null; a.gaze = null; a.command = null; a.beam = null; a.aggro = false;
      if (m.x !== undefined) { a.x = m.x; a.y = m.y; }
      S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
      toast(`${mobDef(a.id).name} 被打倒了！30 秒後重生`, 2200);
      titleOwnerDown(a.id);   // 連線：伺服器宣告島主倒下，最近打過牠的人算參與擊倒
      // 擊倒獎勵：登入者由伺服器直給（k="owner"，本機不重複記）；訪客在 30 秒內打過牠就本機記
      if (!xpServer() && S.t - (S.ownerHitAt[a.id] ?? -1e9) <= TITLE_ASSIST) grantExp(ownerKillXp(m.lvl ?? a.lvl ?? 1), a.x, a.y - 46, 'owner');
    }
    return;
  }
  if (m.ev === 'spawn') {   // 重生：在島緣（沒島形時中心）現蹤
    const na = dragonEnsure(m.x, m.y, m.hp);
    if (na) {
      na.dead = false; na.dieT = 0; na.x = m.x; na.y = m.y; na.hp = m.hp; na.z = 0;
      na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.idle = 1.2; na.wleg = null; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.aggro = false;
      if (m.max != null) na.maxHp = m.max;
      if (m.lvl != null) na.lvl = m.lvl;   // 等級存一起：重生不清
    }
    toast(`${mobDef(S.terrains[S.terrain].owner).name} 回來了！`, 1600);
    return;
  }
  if (m.ev === 'say') {   // 島主被激怒：先在原地說台詞（泡泡 3 秒），說完才反擊（龍衝＝瞬移島緣；蛇女＝原地開眼）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.wleg = null;
    na.x = m.x; na.y = m.y;
    if (m.lvl != null) na.lvl = m.lvl;   // 等級跟著事件走（台詞招式的傷害加成看這個）
    ownerSay(na, m.line);   // 台詞招式帶台詞編號（全島同一句）
    return;
  }
  if (m.ev === 'qfire') {   // 台詞招式放出：島主原地不動，範圍與傷害各人自判
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.cycle = null; na.wleg = null; na.fly = false; na.z = 0;
    na.x = m.x; na.y = m.y;
    if (m.lvl != null) na.lvl = m.lvl;
    if (m.skill === 'act' || m.skill === 'still') { startCommandCheck(na, m.skill, m.castMs || OWNER_COMMAND_CAST * 1000, true); return; }   // 命令檢定：讀條 2 秒後本地判定；mv＝台詞招式，讀條中照伺服器走（不釘原地）
    quoteFire(na, m.skill, m.ids, m.x, m.y);
    return;
  }
  if (m.ev === 'command') {   // 壓力山大下達命令：原地讀條（castMs 後本地檢定；行動＝要動、靜止＝不能動）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.command = null; na.beam = null; na.wleg = null;
    na.x = m.x; na.y = m.y; na.z = 0;
    if (m.hp != null) na.hp = m.hp;
    if (m.lvl != null) na.lvl = m.lvl;
    startCommandCheck(na, m.kind || 'act', m.castMs || OWNER_COMMAND_CAST * 1000);
    return;
  }
  if (m.ev === 'gaze') {   // 蛇女開眼：原地石化預警（castMs 後本地發射；發射瞬間面向她的人石化）
    const na = a || dragonEnsure(m.x, m.y);
    if (!na) return;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.rest = 0; na.retHome = false; na.cycle = null; na.wleg = null;
    na.x = m.x; na.y = m.y; na.z = 0;
    if (m.hp != null) na.hp = m.hp;
    if (m.lvl != null) na.lvl = m.lvl;
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
    if (m.lvl != null) na.lvl = m.lvl;
    na.dir = m.tx < na.x ? -1 : 1;
    na.beam = { t0ms: Date.now(), castMs: m.castMs || OWNER_BEAM_CAST * 1000,
                from: { x: m.tx, y: m.ty }, x: m.x, y: m.y, bx: m.bx, by: m.by };
    toast(`${mobDef(na.id).name} 凝聚波動砲——別站在砲口前面！`, 2600);
    return;
  }
  if (m.ev === 'wander') {   // 島主往新路點散步（伺服器帶路；插值與伺服器一致，凍結恢復也正確）
    const na = a || dragonEnsure(m.fx, m.fy);
    if (!na) return;
    // 台詞招式的命令（qfire 後 2 秒檢定）在伺服器端已回 idle、馬上排追殺腿——但客戶端的檢定還在跑，
    // 不能被 wander 事件洗掉（洗掉＝檢定永遠不會發生＝「該中沒中」，2026-11-06 修正）；位置照腿走（命令帶 mv，讀條中不釘在原地）
    const keepCmd = na.command && Date.now() - na.command.t0ms < na.command.castMs;
    na.dead = false; na.dieT = 0; na.fly = false; na.dashU = null; na.cast = 0; na.castFrom = null; na.rest = 0; na.retHome = false; na.cycle = null; na.gaze = null; na.beam = null;
    if (!keepCmd) na.command = null;
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
    if (m.max != null) a.maxHp = m.max;
    if (m.lvl != null) a.lvl = m.lvl;
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
      const keepCmd = a.command && Date.now() - a.command.t0ms < a.command.castMs;   // 讀條中的命令照樣跑完檢定（同 wander 的修正）
      a.aggro = true; a.wleg = null; a.cast = 0; a.castFrom = null;
      a.fly = false; a.dashU = null; a.cycle = null; a.gaze = null; a.beam = null; a.rest = 0; a.retHome = false;
      if (!keepCmd) a.command = null;   // 不能在上一行無條件清：台詞招式放完伺服器馬上送 aggro，會把剛開始的命令讀條洗掉（讀條閃一下就不見、也不檢定）
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
      playerDamage(me, OWNER_CLAW_DMG + ownerDmgBonus(m.lvl ?? 1), mobDef(na.id).name);   // 島主等級傷害：每 2 級 +1
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
              hp: hp ?? def.hp, maxHp: max ?? def.hp, lvl: 1, dead: false, dieT: 0, lurker: true, proxy, seenMs: Date.now() };
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
      playerDamage(t, LURK_CLAW_DMG + lurkDmgBonus(a.lvl ?? 1), def.name);   // 等級傷害：每 3 級 +1（單機模擬）
      ownerLocalKillCredit(a, t);   // 單機：被牠抓到倒地＝+1 級（與伺服器 creditMobKill 同套；session 內記憶體）
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
    Object.assign(a, { x: m.x, y: m.y, hp: m.hp, maxHp: m.max ?? a.maxHp, lvl: m.lvl ?? (a.lvl ?? 1), proxy: true, seenMs: Date.now(), wleg: null });
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
  if (m.ev === 'hp') { a.hp = m.hp; if (m.max != null) a.maxHp = m.max; if (m.lvl != null) a.lvl = m.lvl; return; }
  if (m.ev === 'dead') {
    a.dead = true; a.dieT = .6; a.wleg = null; a.jump = null; a.z = 0;
    if (m.x !== undefined) { a.x = m.x; a.y = m.y; }
    S.floaters.push({ x: a.x, y: a.y - 30, poof: true, life: .55 });
    toast(`${nm} 被打倒了！`, 2200);
    // 擊倒獎勵：登入者由伺服器直給（k="lurk"，本機不重複記）；訪客在 30 秒內打過牠就本機記
    if (!xpServer() && S.t - (S.ownerHitAt[a.id] ?? -1e9) <= TITLE_ASSIST) grantExp(lurkKillXp(m.lvl ?? a.lvl ?? 1), a.x, a.y - 40, 'lurk');
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
      playerDamage(me, LURK_CLAW_DMG + lurkDmgBonus(m.lvl ?? 1), nm);   // 魚人等級傷害：每 3 級 +1
      S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
    }
  }
}

// ---- 反擊型野怪（飛龍／哥布林…；機制統一，每種怪唯一差別是「繼承島主幾分之幾」＝mobs.json 的 ownerFrac）----
// 被打鎖定攻擊者、追殺＋爪擊；30 秒沒再被打就放棄，回去一般漫遊。
// 純客戶端（野外動物刻意不同步）：打野怪的只有本地玩家，爪擊只咬本地玩家、受害者自判（走 playerDamage：坦克減半照算）。
const RETAL_CHASE = 150, RETAL_DROPOUT = 30;   // 追殺速度同魚人：走路逃不掉、跑步甩得掉；30 秒同島主脫離規則
const RETAL_PACK_R = 200;   // 群起半徑：一隻被打，這範圍內的同種一起反擊（2026-11-09 使用者定）
// 飛龍吐火球（2026-11-10 使用者定）：反擊型的遠距攻擊（mobs.json 的 atkStyle: "fireball"，目前只有飛龍）。
// 進射程就站定吐火球、不再是貼身抓咬：射程 250（跑步甩得掉、走路逃不掉）、每 2.5 秒一顆、飛行 260 px/s；
// 鎖定「發射當下」的目標位置直線飛行（不追蹤，衝刺側移可以躲開）；傷害＝def.atk（照回爪擊同强度），命中才扣血（受害者自判，走 playerDamage：坦克減半照算）。
const FIREBALL_RANGE = 250, FIREBALL_CD = 2.5, FIREBALL_SPEED = 260, FIREBALL_SCALE = .65, FIREBALL_HIT_R = 16;   // 射程／間隔／飛行速度／顯示倍率（素材單幀 64px）／命中半徑
function retaliateStep(a, dt, def) {
  // 群攻（swarm：使用者定 2026-11-11，目前骷髏）：場上同種存活數低於門檻＝全體自動追殺本地玩家
  //（不用被打、距離不限；有個人仇恨的照個人仇恨追）。回補到門檻以上（擊倒的約 30 秒重生）就脫離：
  // 群攻期間不刷新 lastHitAt，脫離後只有「真的被打過還在 30 秒內」的繼續追，其餘立即回漫遊
  const swarm = def.swarm && S.mobs.reduce((s, m) => s + (m.id === a.id && !m.dead ? 1 : 0), 0) < def.swarm;
  if (swarm) {
    const me = S.players[0];
    if (!me.dead && !me.npc && !a.aggroT) a.aggroT = me;   // 沒有個人仇恨才補群攻目標
  }
  const t = a.aggroT;
  if (!t || t.dead || (!swarm && S.t - (a.lastHitAt ?? -1e9) > RETAL_DROPOUT)) { a.aggroT = null; return false; }   // 沒仇恨：照一般漫遊
  const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy);
  const rng = 30 + 6 * ((def.big || 1) - 1);   // 貼著判定圈抓：與 hitRadius 同式；火球怪用 FIREBALL_RANGE
  a.face4 = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');   // 方向網格：看向目標
  if (d <= (def.atkStyle === 'fireball' ? FIREBALL_RANGE : rng)) {   // 進圈（火球怪＝射程）：站定攻擊（不漫遊）
    a.target = null; a.wleg = null; a.z = 0;
    if (dx) a.dir = Math.sign(dx);
    if (S.t >= (a.clawAt ?? 0)) {
      a.clawAt = S.t + (def.atkStyle === 'fireball' ? FIREBALL_CD : 1.5);
      if (def.atkStyle === 'fireball') {   // 吐火球：鎖定目標當下位置，直線飛行（不追蹤）
        // 發射點＝口部（依視覺朝向；飛龍 sheet 實測：側向＝口在身前 58px、腳底上方 69px；上飛／下飛＝身體中心線上、前端取高／低）
        const mouth = a.face4 === 'up' ? [0, -110] : a.face4 === 'down' ? [0, -40]
                    : [(dx < 0 ? -1 : 1) * 58, -69];
        const sx = a.x + mouth[0], sy = a.y - a.z + mouth[1], tx = t.x, ty = t.y - 20;   // 射向目標身體中心
        const len = Math.hypot(tx - sx, ty - sy) || 1;
        S.fireballs.push({ x: sx, y: sy, tx, ty, ang: Math.atan2(ty - sy, tx - sx), life: len / FIREBALL_SPEED, life0: len / FIREBALL_SPEED, dmg: def.atk || 1, name: def.name });
        S.floaters.push({ x: sx, y: sy, ring: true, life: .35 });   // 吐球瞬間的小提示圈
      } else {   // 一般反擊怪：貼身抓咬
        S.floaters.push({ x: a.x + dx * .45, y: a.y - 20 + dy * .45, ang: Math.atan2(dy, dx), slash: true, life: .45 });
        playerDamage(t, def.atk || 1, def.name);
        S.floaters.push({ x: t.x, y: t.y - 24, ring: true, life: .35 });
      }
    }
    return true;
  }
  a.target = { x: t.x, y: t.y };   // 追殺：設成目標位置，走下面共用移動（不會飛的被海擋住就追不上＝在岸邊乾瞪眼）
  return false;
}

function stepFireballs(dt) {   // 飛龍火球步進：直線飛向鎖定點，落地爆炸＋命中判定（純客戶端；打野怪的只有本地玩家）
  if (!S.fireballs.length) return;
  const me = S.players[0];
  for (const f of S.fireballs) {
    f.life -= dt;
    if (f.life > 0) continue;
    S.floaters.push({ burst: true, x: f.tx, y: f.ty, life: .45, life0: .45 });   // 命中爆炸（12 幀，floaters 畫）
    if (!me.dead && !me.npc && Math.hypot(me.x - f.tx, me.y - 20 - f.ty) <= FIREBALL_HIT_R) {
      playerDamage(me, f.dmg, f.name);
      S.floaters.push({ x: me.x, y: me.y - 24, ring: true, life: .35 });
    }
  }
  S.fireballs = S.fireballs.filter(f => f.life > 0);
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
  // 反擊型野怪（飛龍／哥布林…）：被打後追咬；站定開咬時不走下面的一般移動
  if (def.retaliate && retaliateStep(a, dt, def)) return;
  // 只有「附近有人揮擊」才會被嚇到（自己或同島的人）；單純走過去、站在旁邊不會嚇跑牠
  // 島主大隻又沉穩：近距離揮擊也不會嚇到（`owner: true`）；會反擊的野怪（`retaliate`）也不嚇跑——被揮到才反咬
  if (!def.owner && !def.retaliate && S.t - (a.scaredAt ?? -9) > .4) {
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
    else for (let t = 0; t < 20; t++) { // 漫一步（限制活動半徑 6 格；2026-11-08 修正：原本誤寫成 ±6「px」，一步不到 1 格，怪物幾乎只是走回自己格子中心＝看起來站著不動）
      const nx = a.x + (Math.random() * 2 - 1) * 6 * CELL, ny = a.y + (Math.random() * 2 - 1) * 6 * CELL;
      const gx = Math.floor(nx / CELL), gy = Math.floor(ny / CELL);
      if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) continue;
      if (S.world.types[gy * COLS + gx] !== 2) continue;
      if (S.occ.get(key(gx, gy)) !== undefined && furnitureDef(S.furnItems[S.occ.get(key(gx, gy))]?.type)?.solid) continue;
      a.target = { x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2 };
      break;
    }
    if (!a.target) { a.idle = .5; return; }
  }
  const chasing = def.retaliate && a.aggroT;   // 追殺中：速度用 RETAL_CHASE（走路逃不掉、跑步甩得掉）
  const sp = (chasing ? RETAL_CHASE : (a.startle ? def.speed * 2.6 : def.speed)) * dt;
  const dx = a.target.x - a.x, dy = a.target.y - a.y, len = Math.hypot(dx, dy) || 1;
  if (dx) a.dir = Math.sign(dx);
  // 視覺朝向（4 方向）：給「方向網格」的怪物挑列用；取移動量大的那一軸（靜止時保留上一次）
  if (dx || dy) a.face4 = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  const nx = clamp(a.x + dx / len * sp, CELL, (COLS - 1) * CELL), ny = clamp(a.y + dy / len * sp, CELL, (ROWS - 1) * CELL);
  const ox = a.x, oy = a.y;
  if (mobCanStand(def, nx, a.y)) a.x = nx;
  if (mobCanStand(def, a.x, ny)) a.y = ny;
  if (Math.hypot(a.x - ox, a.y - oy) < sp * .2) { a.target = null; a.idle = .5; a.z = 0; return; }   // 被海擋住：停下，不要一直頂
  // 彈跳感：走動時上下彈（給沒有走路動畫的小動物用的「跳跳」感覺）
  // mobs.json 標 noBounce: true 的怪不彈（例如殭屍：LPC 本身就有走路動畫，再彈會變成跳兩次、腳離地＝看起來浮起來）
  if (def.noBounce) a.z = 0;
  else {
    const rate = a.startle ? 16 : 8;
    a.bounce += dt * rate;
    a.z = Math.abs(Math.sin(a.bounce * Math.PI)) * 4;
  }
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
  if (tableAtCell(x, y) || propAtCell(x, y)) return true;   // 和平島的遊戲桌、餐飲區擋路
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
// 雙色染色（貓耳用）：pairs＝[原色清單, 目標色] 多組——每組內的顏色依與該組首色的明暗比例映射到目標色；
// 沒列進任何一組的顏色（貓耳的深色輪廓）保留原色。結果同樣進 recolorCache
function duotoneSheet(img, pairs) {
  const key = 'duo|' + img.src + '|' + pairs.map(p => p[1] + '(' + p[0].join(',') + ')').join(' ');
  let cv = S.recolorCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height), p = d.data;
  const map = new Map();
  for (const [dye, hex] of pairs) {
    if (!hex) continue;   // 沒有目標色（沒髮色）＝這組不映射，保留原色
    const T = hexRGB(hex), base = Math.max(1, lum(hexRGB(dye[0])));
    for (const c of dye) {
      const src = hexRGB(c), k = lum(src) / base;
      const out = T.map(v => Math.round(k <= 1 ? v * k : v + (255 - v) * Math.min(1, k - 1)));
      map.set((src[0] << 16) | (src[1] << 8) | src[2], out);
    }
  }
  for (let i = 0; i < p.length; i += 4) {
    if (!p[i + 3]) continue;
    const o = map.get((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    if (o) { p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; }
  }
  g.putImageData(d, 0, 0);
  S.recolorCache.set(key, cv);
  return cv;
}
function dyeSheet(img, dye, hex) {  const key = img.src + '|' + dye.join(',') + '|' + hex;
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
// 動物調色（mobs.json 的 tint）：整張 sheet 依明暗重上色成目標色——一張基準圖就能做各島不同色系、白兔、灰兔……
// baseHex＝基準圖「主色」（亮度當 1.0）：比它暗的等比變暗、比它亮的往白色推，輪廓自然維持深色（跟髮色／眼睛同一套作法）
function tintSheet(img, baseHex, hex, mode) {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height), p = d.data;
  const T = hexRGB(hex), b = Math.max(1, lum(hexRGB(baseHex)));
  for (let i = 0; i < p.length; i += 4) {
    if (!p[i + 3]) continue;
    const l = lum([p[i], p[i + 1], p[i + 2]]);
    if (mode === 'off') {   // 位移法：保留原本的明暗起伏、整體色調平移到目標色（暗色目標用——乘法的話整隻會變全黑）
      for (let c = 0; c < 3; c++) p[i + c] = Math.max(0, Math.min(255, Math.round(T[c] + (l - b))));
    } else {                // 乘法：亮部往白推（一般色系用，如史萊姆、兔子）
      const k = l / b;
      for (let c = 0; c < 3; c++) p[i + c] = Math.round(k <= 1 ? T[c] * k : T[c] + (255 - T[c]) * Math.min(1, k - 1));
    }
  }
  g.putImageData(d, 0, 0);
  return cv;
}
// 取一張 sheet 的「主色」（最常見的中亮度色，排除輪廓與高光）→ tint 沒寫 tintBase 時自動用它當基準
function sheetMainHex(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const p = g.getImageData(0, 0, c.width, c.height).data, cnt = new Map();
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 16) continue;
    const l = lum([p[i], p[i + 1], p[i + 2]]);
    if (l < 45 || l > 235) continue;   // 太暗（輪廓）／太亮（高光）不算
    const k = ((p[i] >> 3) << 10) | ((p[i + 1] >> 3) << 5) | (p[i + 2] >> 3);
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  let best = 0, bn = -1;
  for (const [k, n] of cnt) if (n > bn) { bn = n; best = k; }
  return '#' + [(best >> 10) & 31, (best >> 5) & 31, best & 31].map(v => (v << 3).toString(16).padStart(2, '0')).join('');
}
// 合成一幀（24×24 之類，大小看 frames.w/h），依 (造型, 幀號) 快取。
// look：{skin, hair, hat, top, bottom（顯示用的款式 id，裝備／外觀已在送出前決定好）, hatC／topC／botC（換色色碼，null＝原色）}；
// 沒有 topC／botC 欄位（NPC、舊格式）就用 shirt／pants 顏色編號（shirtColors／pantsColors）
// sheet 的某一格有沒有不透明像素（結果依 (圖, 格子) 快取）
const cellHasCache = new Map();
function sheetCellHas(img, sx, sy, w, h) {
  if (!img || sx + w > img.width || sy + h > img.height) return false;
  const k = img.src + '|' + sx + ',' + sy;
  let v = cellHasCache.get(k);
  if (v === undefined) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    v = false;
    for (let i = 3; i < d.length; i += 4) if (d[i]) { v = true; break; }
    cellHasCache.set(k, v);
  }
  return v;
}
function charSprite(look, fi) {
  const A = S.avatar, F = A.frames;
  const legacy = (key, idx, list) => key in look ? (look[key] || null) : (list[idx || 0] ?? list[0]);
  const shirtHex = legacy('topC', look.shirt, A.shirtColors), pantsHex = legacy('botC', look.pants, A.pantsColors);
  const hatHex = look.hatC || null, shoeHex = look.shoeC || null;
  const skin = lookItem(A.skins, look.skin) || A.skins[0], hair = lookItem(A.hair, look.hair) || A.hair[0];
  const top = lookItem(A.tops, look.top) || A.tops?.[0], bottom = lookItem(A.bottoms, look.bottom) || A.bottoms?.[0];
  const shoe = lookItem(A.shoes, look.shoe);
  let hat = lookItem(A.hats, look.hat);
  const face = lookItem(A.faces, look.face) || A.faces?.[0], eyes = lookItem(A.eyes, look.eyes) || A.eyes?.[0];
  // 性別：素體 sheet 換成女版（char_body_<膚色> → char_body_female_<膚色>）
  const skinSheet = (look.gender === 'female' && skin.sheet) ? skin.sheet.replace('char_body_', 'char_body_female_') : skin.sheet;
  const skinIt = skinSheet === skin.sheet ? skin : { ...skin, sheet: skinSheet };
  const skinHex = skin.base || null;   // 臉型（頭型）跟膚色重上色
  const hairHex = look.hairC || hair.hex || null;    // 髮色主色（貓耳跟髮色重上色用；自訂髮色優先）
  // 調色盤自訂的髮色／眼睛顏色：改用該樣式的棕色底圖（dyeFrom）再依明暗換成自訂色
  const hairIt = look.hairC && hair.dyeFrom ? { ...hair, sheet: hair.dyeFrom } : hair;
  const eyesIt = look.eyeC && eyes?.dyeFrom ? { ...eyes, sheet: eyes.dyeFrom } : eyes;
  const race = lookItem(A.races, look.race) || A.races?.[0] || { id: 'human', scale: 1 };
  // 服裝男女共用一個 id：女角改用 sheetF（沒有就用 sheet）
  const byGender = it => it && look.gender === 'female' && it.sheetF ? { ...it, sheet: it.sheetF } : it;
  const topG = byGender(top), bottomG = byGender(bottom), shoeG = byGender(shoe); hat = byGender(hat);
  const wpn = look.wpn ? A.weapons.find(w => w.id === look.wpn && w.lpc) : null;   // LPC 武器圖層（見 playerSpriteDiv）
  const k = [skin.id, skinSheet, look.gender || '', race.id, hair.id, hat?.id || '', hatHex, top?.id, shirtHex, bottom?.id, pantsHex, shoe?.id || '', shoeHex, face?.id || '', eyes?.id || '', look.hairC || '', look.eyeC || '', wpn?.id || '', fi].join('|');
  let cv = S.charCache.get(k);
  if (cv) return cv;
  // 這一幀屬於哪個動作（看 frames.attacks 的起始列；走路／待機＝LPC 第 8～11 列）：武器在這個動作有超大格
  // （LPC 的 128×128 揮砍、192×192 突刺、128×128 走路的龍槍／弓等）就整張畫布放大，人物畫在正中央
  const ent0 = F.map ? F.map[fi] : null;
  let over = null, overCell = null;
  if (wpn && ent0 && ent0[3]) {   // 工具動作（釣竿）：每一格各自一張超大格，第幾格／方向寫在 map 條目裡
    over = wpn.lpc.over?.[ent0[3]] || null; overCell = [ent0[4], ent0[5]];
  } else if (wpn && ent0 && F.attacks) {
    for (const [an, a] of Object.entries({ ...F.attacks, walk: LPC_WALK_ROWS })) {
      if (ent0[1] >= a.row && ent0[1] < a.row + 4 && wpn.lpc.over?.[an]) {
        over = wpn.lpc.over[an]; overCell = [a.cols.indexOf(ent0[0]), ent0[1] - a.row];
        if (!sheetCellHas(S.charImgs[over.bg] || S.charImgs[over.fg], overCell[0] * over.size, overCell[1] * over.size, over.size, over.size)
            && !sheetCellHas(S.charImgs[over.fg], overCell[0] * over.size, overCell[1] * over.size, over.size, over.size)) over = null;
        break;
      }
    }
  }
  const pad = over ? (over.size - F.w) / 2 : 0;
  cv = document.createElement('canvas'); cv.width = F.w + pad * 2; cv.height = F.h + pad * 2; cv.pad = pad;
  const g = cv.getContext('2d');
  const drawOver = sheet => { const im = sheet && S.charImgs[sheet]; if (im) g.drawImage(im, overCell[0] * over.size, overCell[1] * over.size, over.size, over.size, 0, 0, over.size, over.size); };
  if (over) drawOver(over.bg);   // 超大格武器的後層（在身體後面）
  // 這一幀在 sheet 上的格子：LPC 通用格式看 frames.map（[欄,列,退回幀]）；舊格式＝水平排列（fi, 0）。
  // 攻擊動作的幀帶「退回幀」：素體那一格沒有圖（素材只有走路列）就整個角色改畫退回幀，避免身體消失、只剩頭髮在動
  let ent = F.map ? F.map[fi] : [fi, 0];
  if (ent?.[2] != null && !sheetCellHas(S.charImgs[skinIt.sheet], ent[0] * F.w, ent[1] * F.h, F.w, F.h)) ent = F.map[ent[2]];
  const [cc, cr] = ent, sx = cc * F.w, sy = cr * F.h;
  // 由下往上：身體 → 褲子 → 鞋子 → 衣服 → 臉型(頭) → 眼睛 →（貓耳後層）→ 頭髮 →（精靈耳／貓耳前層）→ 帽子
  const layers = [[skinIt], [bottomG, pantsHex], [shoeG, shoeHex], [topG, shirtHex], [face, skinHex], [eyesIt, look.eyeC || null]];
  if (wpn && !over && wpn.lpc.bg) layers.unshift([{ sheet: wpn.lpc.bg }]);   // 一般格武器的後層（在身體後面）
  const catTint = race.earFur ? hx2 => [[race.earFur, hx2 || null], [['#ffffff'], race.earInner || '#f5b8ad']] : null;
  if (race.earBg) layers.push([{ sheet: race.earBg, tint: catTint, hx: hairHex || null }]);   // 貓耳後層（髮下面；毛色跟髮色、耳內粉肉色）
  if (!hat?.hideHair) layers.push([hairIt, look.hairC || null]);   // 全罩式頭盔（hats 的 hideHair）把頭髮整個蓋住：不畫頭髮，免得從頭盔上方露出來
  if (race.ear) layers.push([{ sheet: race.ear, dye: race.earDye }, skinHex]);   // 精靈耳（跟膚色）：畫在頭髮上面（LPC 的耳朵層 zPos 126 高於頭髮），否則尖耳被頭髮蓋住（2026-11-09 修正）
  if (race.earFg) layers.push([{ sheet: race.earFg, tint: catTint, hx: hairHex || null }]);   // 貓耳前層（髮上面；同上）
  layers.push([hat, hatHex]);
  if (wpn && !over && wpn.lpc.fg) layers.push([{ sheet: wpn.lpc.fg }]);   // 一般格武器的前層（最上面）
  const fbEnt = ent !== (F.map?.[fi]) ? null : (ent?.[2] != null ? F.map[ent[2]] : null);   // 正在畫攻擊動作時，這一幀的退回格（給缺動作的單一圖層用）
  for (const [it, hex] of layers) {
    const img = it && S.charImgs[it.sheet];
    let lx = sx, ly = sy;
    // 攻擊動作：素體有動作、但這一層（例如之後加的服裝只有走路列）沒有這一格 → 這層改畫自己的退回格，避免衣服整件消失
    if (fbEnt && img && !sheetCellHas(img, sx, sy, F.w, F.h)) { lx = fbEnt[0] * F.w; ly = fbEnt[1] * F.h; }
    if (!img || lx + F.w > img.width || ly + F.h > img.height) continue;   // 缺圖／這張 sheet 沒有這一格：這層略過
    let src;
    if (it.tint) src = duotoneSheet(img, it.tint(it.hx));   // 雙色染色（貓耳：毛→髮色、耳內→粉肉色）
    else {
      const dye = dyeList(it);
      src = dye && hex ? dyeSheet(img, dye, hex) : img;
    }
    g.drawImage(src, lx, ly, F.w, F.h, pad, pad, F.w, F.h);
  }
  if (over) drawOver(over.fg);   // 超大格武器的前層（最上面）
  S.charCache.set(k, cv);
  return cv;
}
// 8 方向視覺朝向：移動時依 (dx, dy) 的角度取最近的方向（鍵盤 8 向剛好一一對應）；玩法（石化等）仍看 face
const LPC_SKIN_DYE_JS = ['#f9d5ba', '#e4a47c', '#cc8665', '#99423c', '#faecd7'];   // 精靈耳跟膚色重上色用
function dir8Of(dx, dy) {
  const s = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));   // 扇區：0＝右、2＝下、-2＝上、±4＝左（畫面 y 向下）
  return CHAR_DIR8[((2 - s) % 8 + 8) % 8];
}
// 沒有 d8（舊客戶端／NPC 剛生成）時，從 face＋dir 推
const d8Of = p => p.d8 || (p.face === 'up' ? 'up' : p.face === 'side' ? (p.dir < 0 ? 'left' : 'right') : 'down');
// 這個人現在該畫哪一幀：坐／睡＝sit；否則「朝向_待機或走路」，依遊戲時間循環（每人有自己的起始相位）。
// 幀表沒有這個狀態時：左右對稱的方向改用另一邊再左右翻轉（mirror）；再沒有就退回正上／正下
// 攻擊時身體的動作（LPC 的揮砍／突刺／施法／射擊；武器仍是另外畫的小圖）：
// 詠唱中依讀條進度播「施法」；揮擊／射箭／採集後 ATK_ANIM 秒內播該職業的攻擊動作。只是畫面，不影響傷害與出手頻率（出手時就結算、間隔看 ATK_CD）
const ATK_ANIM = .4;
const LPC_WALK_ROWS = { row: 8, cols: [0, 1, 2, 3, 4, 5, 6, 7, 8] };   // LPC 走路組（待機＝第 0 欄）
// 攻擊動作依武器（2026-11-09 使用者要求「依照武器替換動畫」）：職業武器看 jobs.json 的 atkAnim（LPC 的杖只有突刺、弓是射擊…）；
// 其他武器：遠距＝要詠唱的施法／不用詠唱的射擊，近戰＝揮砍。詠唱中也播同一個動作（依讀條進度），放完不再重播
function atkKind(p) {
  const wid = p === S.players[0] ? (p.tool || S.me.weapon) : p.weapon;
  const wd = S.avatar.weapons.find(w => w.id === wid);
  if (wd && wid === jobOf(p)?.weapon && jobOf(p)?.atkAnim) return jobOf(p).atkAnim;
  if (wd?.ranged) return wd.ranged.cast ? 'spellcast' : 'shoot';
  return 'slash';   // 空手、採集工具、職業沒設定 → 揮砍
}
function atkAnimNow(p) {
  if (p.cast && p === S.players[0]) return { kind: atkKind(p), q: Math.min(.999, (S.t - p.cast.t0) / p.cast.dur) };
  if (p.atkT0 == null || S.t - p.atkT0 >= ATK_ANIM || p.fish) return null;
  return { kind: atkKind(p), q: (S.t - p.atkT0) / ATK_ANIM };
}
// 釣魚的釣竿動作（LPC tool_rod 13 格）：拋竿（剛進入等魚的前 ROD_CAST 秒）2→5、等魚 6～8 輕晃、上鉤 8／9 抖竿、拉竿停在 12（往後拉住）＋輕微抖動。
// 只有拿著 LPC 釣竿（lpc.fishOnly）時才播；回第幾格或 null
const ROD_CAST = .5;
const ROD_FLY = [.25, .65];   // 拋竿動畫：第幾秒開始甩出浮標（釣竿第 4 格往前揮）、第幾秒落水
function rodFrameNow(p) {
  const f = p.fish; if (!f || p.npc) return null;
  const wid = p === S.players[0] ? S.me.weapon : p.weapon;
  if (!S.avatar.weapons.find(w => w.id === wid)?.lpc?.fishOnly) return null;
  const since = S.t - (f.c0 ?? f.t ?? S.t);
  if (f.ph === 'wait' && since < ROD_CAST) return 2 + Math.min(3, Math.floor(since / ROD_CAST * 4));
  if (f.ph === 'wait') return [6, 7, 8, 7][Math.floor(S.t * 2.5) % 4];
  if (f.ph === 'bite') return [8, 9][Math.floor(S.t * 10) % 2];
  return 12;   // reel：竿子往後拉住（第 12 格）＋整個人輕微抖動（drawPerson 的 rodJit），跟原本的拉竿一樣；不播 10～12 來回甩（2026-11-09 使用者要求）
}
function charFrame(p) {
  const F = S.avatar.frames, st = F.states;
  if (p.pose) return { fi: (st.sit || st.down_idle)[0], mirror: false };
  const mode = p.moving ? 'walk' : 'idle', d = d8Of(p);
  const rk = rodFrameNow(p), rl = rk != null && st[`rod_${d}`];
  if (rl) return { fi: rl[rk], mirror: false };
  const ak = atkAnimNow(p), al = ak && st[`${ak.kind}_${d}`];
  if (al) return { fi: al[Math.min(al.length - 1, Math.floor(ak.q * al.length))], mirror: false };
  let list = st[`${d}_${mode}`], mirror = false;
  if (!list && CHAR_MIRROR[d]) { list = st[`${CHAR_MIRROR[d]}_${mode}`]; mirror = !!list; }
  if (!list) list = st[`${d.startsWith('up') ? 'up' : 'down'}_${mode}`] || st.down_idle;
  p.animPhase ??= Math.random() * 4;
  return { fi: list[Math.floor((S.t + p.animPhase) * (F.fps?.[mode] || 6)) % list.length], mirror };
}
// 武器掛點（back／backView／waist／hand）換成相對腳底的畫面座標；frameAnchors 可逐幀覆寫
// 放大倍率＝avatar.json 的 frames.scale（底圖 64px、畫 1 倍；舊 24px 素材是 2 倍），沒寫時退回 2
function charAnchor(fi, kind) {
  const F = S.avatar.frames, a = F.frameAnchors?.[fi]?.[kind] || F.anchors[kind], s = F.scale || 2;
  return [(a[0] - F.w / 2) * s, (a[1] - F.h + (F.footDy || 0)) * s];   // footDy：圖往下挪（腳底貼地），掛點跟著挪
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
  // NPC 與遠端玩家都有自己的 look；自己（players[0]）則用當前職業的裝備＋外觀（myLook）。
  // LPC 武器（avatar.json 武器條目有 lpc）是人物的一層：帶 wpn（武器 id）給 charSprite 一起合成
  if (p.npc) return charSprite(p.look || myLook(), fi);
  const me = p === S.players[0], look = p.look || myLook();
  let wd = me ? (p.tool ? null : lpcWeaponFor(S.me.weapon, look.wlook)) : lpcWeaponFor(p.weapon, look.wlook);
  if (wd?.lpc.fishOnly && !p.fish) wd = null;   // LPC 釣竿只在釣魚時畫（四方向的拋竿／持竿／收線動作），平常照舊背著小圖
  return charSprite(wd ? { ...look, wpn: wd.id } : look, fi);
}
// 拿著的武器有沒有 LPC 圖層：有就回該武器條目（武器外觀有 LPC 圖就用外觀的，外觀沒有 LPC 圖就退回舊的小圖畫法）
function lpcWeaponFor(wid, wlook) {
  const ws = S.avatar?.weapons; if (!ws || !wid) return null;
  const base = ws.find(w => w.id === wid);
  if (wlook && wlook !== wid) {
    const g = ws.find(w => w.id === wlook);
    if (g?.glam && base && g.type === base.type) return g.lpc ? g : null;
  }
  return base?.lpc ? base : null;
}
// 武器的圖：拿著職業武器且有選同類型的武器外觀（glam）時畫外觀的圖；玩法（射程、詠唱等）照拿著的武器
function weaponImgFor(wid, wlook) {
  if (!wid || wid === 'hands') return null;
  if (lpcWeaponFor(wid, wlook) && !lpcWeaponFor(wid, wlook).lpc.fishOnly) return null;   // LPC 武器畫在人物圖層裡（charSprite），不另外畫小圖（釣竿例外：沒在釣魚時背小圖）
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
  // 跳到一半／被擊飛中倒地：一起取消（倒地期間 stepPlayer 不會處理它們，留著的話復活後會被瞬移回落點、觸發落地效果，或在出生點被推一下）
  p.leap = null; p.knock = null; p.z = 0; p.vz = 0;
  S.floaters.push({ x: p.x, y: p.y - 46, v: label || '倒地', life: 1.1, crit: true });
  toast(`${cause} 把你打倒了！${DEAD_SECONDS} 秒後在出生點復活`, 3200);
  loseExp();   // 倒地 10% 機率扣 XP（本機版；同步那步改成伺服器計算，避免本機改存檔灌分）
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
  campfireHeal(p, dt);   // 營火範圍內額外回血（與脫離戰鬥回血並存）
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
  const me = p === S.players[0];
  const pet = S.t < (p.petUntil ?? 0) || (me && ffOn('stun'));   // 吃喝的暈眩：跟石化一樣原地不能動
  const reeling = p.fish?.ph === 'reel';   // 拉竿的 1 秒拉扯中站定（不能走、不能跳，結果揭曉後才能動）
  if (!pet && !reeling) {
    if (keys['a'] || keys['arrowleft']) dx -= 1;
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (keys['w'] || keys['arrowup']) dy -= 1;
    if (keys['s'] || keys['arrowdown']) dy += 1;
    if (me && ffOn('confuse')) { dx = -dx; dy = -dy; }   // 吃喝的混亂：方向顛倒
  }
  p.moving = dx !== 0 || dy !== 0;
  if (p.moving) { p.lastMoveAt = S.t; p.lastInputWall = Date.now(); }   // 命令檢定用（行動命令／靜止命令）：最後一次有移動輸入的時刻（真實時鐘一份、遊戲時間一份）
  // 釣魚中（拉扯以外）：可以走、可以跳，離浮標太遠（FISH_LEASH）才收竿；換掉釣竿、進裝飾模式、被石化也會收竿
  if (p.fish && !reeling) {
    if (Math.hypot(p.fish.x - p.x, p.fish.y - p.y) > FISH_LEASH) stopFishing(p, '離浮標太遠，收竿了');
    else if (S.mode !== 'walk' || !isRod() || pet) stopFishing(p);
  }
  stepFishing(p);
  if (p === S.players[0]) stepCast(p);
  if (p.moving) {
    if (S.mode === 'walk' && S.mouseHeld && S.mouseClient) {   // 按住滑鼠攻擊時，面向跟著游標（四方向；可以一邊朝右攻擊一邊往左退）
      const r = canvas.getBoundingClientRect();
      aimAt(p, S.mouseClient[0] - r.left + S.cam.x, S.mouseClient[1] - r.top + S.cam.y);
    } else {   // 朝向：有往上的分量（含斜上）＝背面、只往下＝正面、其餘有左右分量（左右、斜下）＝側（dir 左右）；站著不動維持上次的朝向
      if (dx !== 0) p.dir = dx;
      p.face = dy < 0 ? 'up' : dx !== 0 ? 'side' : 'down';
      p.d8 = dir8Of(dx, dy);   // 畫面用的 8 方向（玩法仍看 face）
    }
    const len = Math.hypot(dx, dy) || 1, sp = (S.sprint ? 200 : 120) * dt * (me ? foodSpeedMul() : 1);   // 疾走＝右下角虛擬按鍵或 Shift 切換的狀態
    const nx = clamp(p.x + dx / len * sp, 8, COLS * CELL - 8);
    const ny = clamp(p.y + dy / len * sp, 8, ROWS * CELL - 8);
    // 裝飾模式可穿過擺飾（避免被卡住）；已經被家具圍住/壓在家具上時（例如別人把家具擺在你腳下）也一樣可以走出來。水邊照樣擋
    const ig = S.mode === 'decor' || (blocked(p.x, p.y) && !blocked(p.x, p.y, true));
    if (!blocked(nx, p.y, ig)) p.x = nx;
    if (!blocked(p.x, ny, ig)) p.y = ny;
  }
  // 跳躍（走路與裝飾模式都能跳；石化中不能跳）
  if (!pet && !reeling && keys[' '] && p.z === 0 && p.vz === 0) p.vz = me && ffOn('light') ? 330 : 240;   // 吃喝的輕盈：跳更高
  if (p.z > 0 || p.vz > 0) {
    p.z += p.vz * dt; p.vz -= 780 * dt;
    if (p.z <= 0) { p.z = 0; p.vz = 0; }
  }
  if (p.swing > 0) p.swing -= dt;
  if (p.adir && atkActive(p)) { p.d8 = p.adir; p.face = p.adir === 'up' || p.adir === 'down' ? p.adir : 'side'; }   // 攻擊動作中（揮擊／採集／詠唱／射擊）身體轉向攻擊方向（四方向）
  if (p.fish) {   // 釣魚中走動：身體一直面向浮標（倒退著走），釣竿才會指著浮標、釣線不會從背後繞過去；四方向（2026-11-09，可以朝上／朝下釣）
    if (Math.abs(p.fish.x - p.x) > 4) p.dir = Math.sign(p.fish.x - p.x);
    p.d8 = dir4To(p.fish.x - p.x, p.fish.y - p.y, p); p.face = p.d8 === 'up' || p.d8 === 'down' ? p.d8 : 'side';
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
// 賢具（noulith，參考使用者提供的圖）：白色鏢形機身＋深色座艙＋後掠小翼，機尾往後飄兩道藍色能量翼
function drawNoulith(x, y, ang, al, trail, t, seed, sc = 1, tint = false) {   // tint：演出時機身變色（白→賢具藍）
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(sc, sc);
  // 能量翼：先畫（被機身壓住），兩道從尾部往後飄的藍色帶子，會輕輕擺動
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let s = -1; s <= 1; s += 2) {
    const len = trail * (.8 + .25 * Math.sin(t * 9 + seed * 2.4 + s));
    const wob = Math.sin(t * 11 + seed * 1.7 + s * 2) * 2.2;
    const g = ctx.createLinearGradient(-7, 0, -7 - len, 0);
    g.addColorStop(0, `rgba(115,155,255,${.85 * al})`);
    g.addColorStop(1, 'rgba(115,155,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6, s * 1.4);
    ctx.quadraticCurveTo(-7 - len * .5, s * 3.6 + wob, -7 - len, s * 1.8 + wob);
    ctx.quadraticCurveTo(-7 - len * .55, s * 1.2 + wob * .4, -6, s * -.6);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // 後掠小翼（先畫，機身會蓋住根部）
  ctx.fillStyle = tint ? '#7d94e0' : '#d8dde8'; ctx.strokeStyle = '#23272f'; ctx.lineWidth = .8;
  for (let s = -1; s <= 1; s += 2) {
    ctx.beginPath(); ctx.moveTo(1, s * 2.2); ctx.lineTo(-4, s * 5.4); ctx.lineTo(-5.5, s * 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  // 機身：鏢形（尖頭、收尾）——tint 時用賢具藍當對比色
  ctx.beginPath();
  ctx.moveTo(9, 0); ctx.lineTo(3, -2.4); ctx.lineTo(-5, -2); ctx.lineTo(-8, 0); ctx.lineTo(-5, 2); ctx.lineTo(3, 2.4);
  ctx.closePath();
  ctx.fillStyle = tint ? '#8fa6ff' : '#eef1f6'; ctx.fill();
  ctx.save(); ctx.clip();                       // 下半留深一階的陰影面
  ctx.fillStyle = tint ? 'rgba(85,115,205,.6)' : 'rgba(150,160,180,.55)'; ctx.fillRect(-8, .4, 17, 2.2);
  ctx.restore();
  ctx.strokeStyle = '#23272f'; ctx.lineWidth = 1; ctx.stroke();
  // 深色座艙（機身中後段的黑色塊，像參考圖）與尾端噴口
  ctx.fillStyle = '#343b49';
  ctx.beginPath(); ctx.ellipse(-1.5, 0, 2.6, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#5a6474'; ctx.fillRect(-9, -1, 1.6, 2);
  ctx.restore();
}
// 賢具的常駐待機（參考使用者提供的圖）：裝備賢具（tome）的人身邊繞著四座漂浮的賢具＋手前的藍色光環。
// 普攻時本體不動、只射光束（drawFxFloater 'funnels'）；「關心」時 0 號座飛出去繞對象一圈再回來（'carego'）
function noulithSeed(p) {
  let h = 0;
  for (const c of (p.name || '')) h = (h + c.charCodeAt(0) * 7) % 97;
  return h;
}
function noulithSlots(px, py, t, seed) {   // 繞著上半身緩慢繞圈的四個陣位（畫圖與攻擊光束的出發點共用）
  return [0, 1, 2, 3].map(i => {
    const a = t * .55 + i * Math.PI / 2 + seed * .11;
    const rr = 24 + Math.sin(t * 1.3 + i * 2.1) * 3;
    return {
      x: px + Math.cos(a) * rr * 1.15,
      y: py - 26 + Math.sin(a) * rr * .72 + Math.sin(t * 2.1 + i * 1.3) * 2,
      ang: a + Math.PI / 2 + Math.sin(t * .9 + i * 2.4) * .5,   // 大致沿繞行方向、帶一點擺動
    };
  });
}
function drawNoulithIdle(p, wid, part) {   // part：'back'＝畫在人物後面、'front'＝前面（依陣位高低分）
  if (wid !== 'tome' || p.dead) return;
  const t = S.t, seed = noulithSeed(p);
  if (!S.floaters.some(f => f.fxk === 'carego' || f.fxk === 'healgo')) {   // 四座都外出（關心／群療）時待機位全空
    const slots = noulithSlots(p.x, p.y, t, seed);
    for (let i = 0; i < 4; i++) {
      const s = slots[i], behind = s.y < p.y - 24;
      if ((part === 'back') !== behind) continue;
      drawNoulith(s.x, s.y, s.ang, 1, 12, t, seed + i * 13, 1.2);
    }
  }
  if (part === 'front') {                  // 施術焦點：手前的藍色光環（旋轉的光珠圈）
    const rx = p.x + (p.dir || 1) * 5, ry = p.y - 22;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 10; i++) {
      const a = t * 1.8 + i * Math.PI / 5;
      ctx.fillStyle = 'rgba(110,150,255,.7)';
      ctx.beginPath(); ctx.arc(rx + Math.cos(a) * 10, ry + Math.sin(a) * 8, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
// 瞬間特效（S.floaters 裡帶 fxk 的；ctx 在世界座標、外層已 save/restore）
function drawFxFloater(f) {
  const L = { jumpboom: .5, arrow: .2, song: .7, poisonpop: .6, heart: .6, sheal: .5, smoke: .5, after: .6, boom: .6, kshield: .6, wshield: .6, pop: .6, shout: .5, crack: .8, fog: .8, drain: .4, funnels: .45, carego: .7, healgo: .65 }[f.fxk] || .5;
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
    case 'funnels': {   // 賢具普攻：本體在人物身邊待機不動（drawNoulithIdle），四座從陣位依序朝目標射藍色光束
      const A = q < .7 ? 1 : 1 - (q - .7) / .3;
      const cx = f.x2, cy = f.y2;
      for (let i = 0; i < 4; i++) {
        const bq = q - i * .07;                                 // 四座依序開火（每座錯開 0.07 秒）
        if (bq <= 0 || bq >= .22) continue;
        const bl = Math.sin(bq / .22 * Math.PI), [sx, sy] = f.slots[i];
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(100,140,255,${.5 * bl * A})`; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.strokeStyle = `rgba(225,238,255,${.85 * bl * A})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.restore();
      }
      if (q > .3 && q < .58) {                                  // 命中閃光：藍白色爆開＋火花
        const fk = (q - .3) / .28;
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(160,195,255,${.45 * (1 - fk) * A})`;
        ctx.beginPath(); ctx.arc(cx, cy, 6 + fk * 26, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 5; i++) {
          const a2 = i * Math.PI * 2 / 5 + .5, r = 8 + fk * 22;
          ctx.fillStyle = `rgba(210,228,255,${.6 * (1 - fk) * A})`;
          ctx.fillRect(cx + Math.cos(a2) * r - 1.5, cy + Math.sin(a2) * r - 1.5, 3, 3);
        }
        ctx.restore();
      }
      break;
    }
    case 'carego': {   // 關心三段式：四座賢具先合在一起（緊密編隊）飛到對象 → 抵達後分成四座繞一圈 →
                       // 再合在一起飛回待機位，最後落回各自的陣位（愛心照舊）
      const tx = f.x2, ty2 = f.y2;
      const seed = noulithSeed(f.p);
      const homes = noulithSlots(f.p.x, f.p.y, S.t, seed);
      const hx0 = (f.sx[0] + f.sx[1] + f.sx[2] + f.sx[3]) / 4, hy0 = (f.sy[0] + f.sy[1] + f.sy[2] + f.sy[3]) / 4;
      const hx1 = (homes[0].x + homes[1].x + homes[2].x + homes[3].x) / 4, hy1 = (homes[0].y + homes[1].y + homes[2].y + homes[3].y) / 4;
      const ease = k => k * k * (3 - 2 * k);
      for (let i = 0; i < 4; i++) {
        const aCl = i * Math.PI / 2 + seed * .3;                 // 編隊裡自己的方位（合體時的緊密小圈）
        let fx, fy, face, trail = 24;
        if (q < .25) {                                           // 合體飛去：邊收攏邊朝目標飛，收攏好用掉前段
          const k = ease(q / .25), m = Math.min(1, (q / .25) * 2.2);
          const cxp = hx0 + (tx - hx0) * k, cyp = hy0 + (ty2 - hy0) * k;
          const dx = (f.sx[i] - hx0) * (1 - m), dy = (f.sy[i] - hy0) * (1 - m);
          fx = cxp + dx + Math.cos(aCl) * 5 * m; fy = cyp + dy + Math.sin(aCl) * 4 * m;
          face = Math.atan2(ty2 - cyp, tx - cxp);
        } else if (q < .75) {                                    // 分成四座繞目標轉一圈：從編隊攤開成繞行半徑
          const k = (q - .25) / .5;
          const spread = Math.min(1, k * 6) * Math.min(1, (1 - k) * 6);   // 起末快速攤開／收攏
          const r = 5 + 19 * spread;
          const th = aCl + ease(k) * Math.PI * 2;                // 整段轉滿一圈（攤開／收攏主要發生在頭尾）
          fx = tx + Math.cos(th) * r; fy = ty2 + Math.sin(th) * (r * .79);
          face = th + Math.PI / 2; trail = spread > .5 ? 15 : 22;
        } else {                                                 // 合體飛回：編隊朝待機中心飛，最後一段攤回各自的陣位
          const k = ease((q - .75) / .25), m2 = Math.max(0, 1 - (q - .75) / .25 * 2.6);
          const cxp = tx + (hx1 - tx) * k, cyp = ty2 + (hy1 - ty2) * k;
          fx = cxp + Math.cos(aCl) * 5 * m2 + (homes[i].x - hx1) * (1 - m2);
          fy = cyp + Math.sin(aCl) * 4 * m2 + (homes[i].y - hy1) * (1 - m2);
          face = Math.atan2(hy1 - cyp, hx1 - cxp);
        }
        drawNoulith(fx, fy, face, 1, trail, S.t, seed + i * 13, 1.2);
      }
      break;
    }
    case 'healgo': {   // 群療（手上是賢具＝賢者限定演出）：四座賢具變成賢具藍（非黑白的對比色）、分散到東南西北的
                       // 技能最大範圍（HEAL_RADIUS），魔法陣（賢具藍同色系）由腳色所在位置向外擴散長出來、結尾賢具飛回時魔法陣跟著消失。
                       // 取代補師原有的綠圈（沒有賢具的補職照舊綠圈）
      const seed = noulithSeed(f.p);
      const homes = noulithSlots(f.p.x, f.p.y, S.t, seed);
      const rxy = [HEAL_RADIUS, HEAL_RADIUS * .8];            // 地面圈照畫面慣例 y 收 20%（東西南北的落點跟圈同一套）
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];        // 東、南、西、北
      const ease = k => k * k * (3 - 2 * k);
      const ex = ease(Math.min(1, q / .6));                   // 魔法陣擴散：由腳色位置往外長，前 60% 長到最大範圍
      const gl = Math.min(1, Math.max(0, (q - .08) / .14)) * Math.min(1, Math.max(0, (1 - q) / .22));   // 光圈的淡入淡出
      const gd = Math.min(1, Math.max(0, q / .12)) * Math.min(1, Math.max(0, (1 - q) / .24));   // 魔法陣：跟著擴散淡入、收回淡出
      if (gd > 0) {                                           // 魔法陣（畫在賢具下面）：外圈雙環＋符文刻痕帶、內環、
                                                              // 中間上下雙三角（六芒星）、三個符號碟＝太陽／月牙／八角星，整座慢轉
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.translate(f.p.x, f.p.y - 24); ctx.scale(ex, ex); ctx.scale(1, .8); ctx.rotate(-S.t * .6);
        const R = HEAL_RADIUS, c0 = `rgba(143,166,255,${.6 * gd})`, c1 = `rgba(190,215,255,${.65 * gd})`;
        ctx.strokeStyle = c0; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, R - 9, 0, Math.PI * 2); ctx.stroke();
        for (let i = 0; i < 44; i++) {                        // 兩環之間的符文刻痕（長短相間，像外圈的字帶）
          const a = i * Math.PI / 22, r1 = R - (i % 2 ? 2 : 4.5);
          ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R - 9), Math.sin(a) * (R - 9));
          ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(0, 0, R - 18, 0, Math.PI * 2); ctx.stroke();
        for (let s = 0; s < 2; s++) {                         // 上下兩座三角形疊成六芒星
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const a = -Math.PI / 2 + (s ? Math.PI : 0) + k * Math.PI * 2 / 3, r = R - 40;
            if (!k) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath(); ctx.stroke();
        }
        for (let m = 0; m < 3; m++) {                         // 三個符號碟：太陽、月牙、八角星
          const a = -Math.PI / 2 + m * Math.PI * 2 / 3, mx = Math.cos(a) * (R - 26), my = Math.sin(a) * (R - 26);
          ctx.strokeStyle = c1; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(mx, my, 10, 0, Math.PI * 2); ctx.stroke();
          if (m === 0) {                                      // 太陽：中心小圓＋八道微彎光芒
            ctx.beginPath(); ctx.arc(mx, my, 2.8, 0, Math.PI * 2); ctx.stroke();
            for (let k = 0; k < 8; k++) {
              const ra = k * Math.PI / 4, r0 = 4.2, r1 = 7.5 + (k % 2 ? .8 : 0);
              ctx.beginPath(); ctx.moveTo(mx + Math.cos(ra) * r0, my + Math.sin(ra) * r0);
              ctx.quadraticCurveTo(mx + Math.cos(ra + .3) * (r0 + r1) * .55, my + Math.sin(ra + .3) * (r0 + r1) * .55,
                                   mx + Math.cos(ra) * r1, my + Math.sin(ra) * r1);
              ctx.stroke();
            }
          } else if (m === 1) {                               // 月牙：兩道弧接成的弦月輪廓
            ctx.beginPath();
            ctx.arc(mx - 1.6, my, 6, Math.PI * .15, Math.PI * 1.85);
            ctx.arc(mx + 2.4, my, 4.6, Math.PI * 1.7, Math.PI * .3, true);
            ctx.closePath(); ctx.stroke();
          } else {                                            // 八角星：內外交替的十六點星形
            ctx.beginPath();
            for (let k = 0; k < 16; k++) {
              const ra = k * Math.PI / 8 - Math.PI / 16, r = k % 2 ? 3 : 7.5;
              if (!k) ctx.moveTo(mx + Math.cos(ra) * r, my + Math.sin(ra) * r); else ctx.lineTo(mx + Math.cos(ra) * r, my + Math.sin(ra) * r);
            }
            ctx.closePath(); ctx.stroke();
          }
        }
        ctx.restore();
      }
      if (gl > 0) {                                           // 範圍內一圈淡淡的光：賢具藍的柔光圈＋細圈（跟著魔法陣一起往外擴散）
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(115,155,255,${.22 * gl})`; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.ellipse(f.p.x, f.p.y - 24, (rxy[0] - 4) * ex, (rxy[1] - 4) * ex, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(190,215,255,${.4 * gl})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(f.p.x, f.p.y - 24, rxy[0] * ex, rxy[1] * ex, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      for (let i = 0; i < 4; i++) {
        const gx = f.p.x + dirs[i][0] * rxy[0], gy = f.p.y - 24 + dirs[i][1] * rxy[1];
        let fx, fy, face, trail = 24;
        if (q < .22) {                                        // 飛往自己的方位
          const e = ease(q / .22);
          fx = f.sx[i] + (gx - f.sx[i]) * e; fy = f.sy[i] + (gy - f.sy[i]) * e;
          face = Math.atan2(gy - f.sy[i], gx - f.sx[i]); trail = 28;
        } else if (q < .72) {                                 // 定在四方位：輕微浮動，機頭朝外撐住光圈
          fx = gx; fy = gy + Math.sin(S.t * 6 + i * 1.7) * 1.5;
          face = dirs[i][0] ? (dirs[i][0] > 0 ? 0 : Math.PI) : (dirs[i][1] > 0 ? Math.PI / 2 : -Math.PI / 2);
          trail = 10;
        } else {                                              // 飛回待機位（跟著人走）
          const h = homes[i], e = ease((q - .72) / .28);
          fx = gx + (h.x - gx) * e; fy = gy + (h.y - gy) * e;
          face = Math.atan2(h.y - gy, h.x - gx); trail = 28;
        }
        drawNoulith(fx, fy, face, 1, trail, S.t, seed + i * 13, 1.2, true);
      }
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
      const F = S.avatar.frames, fi = (F.states[`${f.d8}_idle`] || F.states.down_idle)[0], cs = F.scale || 2;
      ctx.globalAlpha = .4 * al; ctx.filter = 'brightness(1.6) saturate(.3)';
      ctx.drawImage(charSprite(myLook(), fi), f.x - F.w * cs / 2, f.y - (F.h - (F.footDy || 0)) * cs, F.w * cs, F.h * cs);
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
  const race = (p === S.players[0] ? S.me.race : p.look?.race) || 'human';
  const ffx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);   // 吃喝的效果（巨大化／縮小／透明／暈眩／中毒）
  const raceScale = ((S.avatar.races?.find(r => r.id === race)?.scale) || 1) * foodScaleOf(ffx);   // 種族倍率：拉拉肥 0.5／巨人 1.5（整個模組一起縮）；吃喝的巨大化／縮小再乘上去
  let nameY = p.y - p.z - Math.round(52 * raceScale);   // 名牌跟著身高（種族倍率）移
  if (pose === 'sleep') {
    drawSleeper(p);
    nameY = p.y - Math.round(46 * raceScale);
  } else {
    if (!pose) {   // 影子（跳起來時縮小變淡）；坐著的不畫（會蓋在椅子上）
      const shs = 1 - Math.min(.55, p.z / 80);
      ctx.fillStyle = `rgba(10,14,20,${.32 * shs + .04})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 11 * shs * raceScale, 4 * shs * raceScale, 0, 0, Math.PI * 2); ctx.fill();
    }
    const cf = charFrame(p), img = playerSpriteDiv(p, cf.fi), F = S.avatar.frames;   // 方向已畫在幀裡，只有借用另一邊的幀時才左右翻轉
    charAnch = { back: charAnchor(cf.fi, 'back'), backView: charAnchor(cf.fi, 'backView'), waist: charAnchor(cf.fi, 'waist'), hand: charAnchor(cf.fi, 'hand') };
    const pet = S.t < (p.petUntil ?? 0);   // 石化：身體灰階（自己的石化即時同步；遠端玩家的石化由光束事件就地推斷，純演出）
    if (pet) { ctx.save(); ctx.filter = 'grayscale(1) brightness(.92)'; }
    const ghost = ffx?.includes('fghost');   // 吃喝的透明化：整個人半透明
    if (ghost) ctx.globalAlpha = .35;
    p.rodJit = p.fish?.ph === 'reel' && rodFrameNow(p) != null ? Math.round(Math.sin(S.t * 30)) : 0;   // 拉竿：竿子往後拉住、整個人左右抖 1px（原本拉竿時竿尖抖動的感覺）
    ctx.save(); ctx.translate(p.x + p.rodJit, p.y - p.z);
    // 武器（背在背上／掛在腰間；揮擊時畫在身前）；坐著時不拿；釣魚時釣竿拋向前方
    const fish = wi && !pose && p.fish ? p.fish : null;
    const carry = wi && !pose && !fish && !(p.swing > 0) && !p.cast;   // 不拿在手上（詠唱中高舉法杖）
    const backView = d8Of(p).startsWith('up');                // 背面（往上、斜上）：背著的武器疊在身體上面，其餘方向被身體擋住
    // 掛著的武器畫在左右翻轉之外：固定在同一側，人物轉向時不會跟著換邊
    const drawCarry = onBack => wi.carry === 'waist' ? drawWeaponWaist(wi) : drawWeaponBack(wi, onBack);
    if (carry && !backView) drawCarry(false);
    const pfx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);   // 技能效果（自己看本地狀態，別人看 state 同步的 fx）
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'back');
    const swingV = wi && !pose && !fish && p.swing > 0 ? face4(p) : null;   // 小圖武器（wi；LPC 武器畫在人物圖層裡、wi 是 null）往上／往下揮
    if (swingV === 'up') drawWeaponSwing(wi, p.swing, 1, 'up');   // 往上揮：武器在身體後面
    ctx.save();
    if (cf.mirror) ctx.scale(-1, 1);
    const cs = (F.scale || 2) * raceScale;   // 錨點＝腳底中央；放大＝frames.scale × 種族倍率
    const pad = img.pad || 0;   // 超大格（LPC 武器揮砍）：畫布四周多出 pad，人物仍以腳底中央對齊
    // footDy：LPC 的腳底在格子第 60～62 列，不往下挪的話腳和影子之間有空隙（看起來像飄在空中）
    ctx.drawImage(img, (-F.w / 2 - pad) * cs, (-F.h - pad + (F.footDy || 0)) * cs, img.width * cs, img.height * cs);
    ctx.restore();
    if (carry && backView) drawCarry(true);
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'front');
    if (swingV === 'down') drawWeaponSwing(wi, p.swing, 1, 'down');   // 往下揮：武器在身前
    if (p.dir < 0) ctx.scale(-1, 1);                          // 揮擊、拋竿朝面向那側（要翻轉）
    if (wi && !pose && !fish && p.swing > 0 && swingV !== 'up' && swingV !== 'down') drawWeaponSwing(wi, p.swing, p.dir < 0 ? -1 : 1);
    const rodTip = fish ? lpcRodTip(p, cf, cs, img.pad || 0) : null;   // LPC 釣竿：竿尖的世界座標（畫在人物圖層裡，不畫舊小圖）
    if (fish && !rodTip) drawRodCast(wi, rodAngle(fish));
    if (wi && !pose && !fish && p.cast) drawStaffRaise(wi, Math.min(1, (S.t - p.cast.t0) / p.cast.dur));
    ctx.restore();
    if (pet) ctx.restore();
    if (ghost) ctx.globalAlpha = 1;
    if (ffx?.length) drawFoodOverhead(p, ffx, nameY);   // 暈眩的星星、中毒的泡泡
    if (fish) drawLineAndBobber(p, wi, fish, rodTip);
    if (pose) nameY = p.y - 46;
  }
  // 名牌（FFXIV 感：白字黑邊）
  ctx.font = '10px "Microsoft JhengHei"';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.8)';
  ctx.strokeText(p.name, p.x, nameY);
  ctx.fillStyle = nameColor;
  ctx.fillText(p.name, p.x, nameY);
  // 等級：名字旁邊的金色 Lv.N（本人＝設定可關；同島的人＝等 state 同步的 lvl，同步那步之前先不顯示）
  const lvTxt = p.npc ? null
    : p === S.players[0] ? (S.profile.showLv === false ? null : `Lv.${lvInfo(S.profile.xp).lv}`)
    : p.lvl != null ? `Lv.${p.lvl}` : null;
  if (lvTxt) {
    const nameW = ctx.measureText(p.name).width;
    ctx.font = '9px "Microsoft JhengHei"';
    ctx.textAlign = 'left';
    ctx.strokeText(lvTxt, p.x + nameW / 2 + 4, nameY);
    ctx.fillStyle = '#ffd86b';
    ctx.fillText(lvTxt, p.x + nameW / 2 + 4, nameY);
    ctx.textAlign = 'center';
    ctx.font = '10px "Microsoft JhengHei"';   // 後面還有用這個字型量寬的地方
  }
  const tblTag = tableTag(p);   // 和平島：入座中的人，名牌後面加狀態
  if (tblTag) {
    const nameW = ctx.measureText(p.name).width;
    ctx.font = '9px "Microsoft JhengHei"';
    const lvW = lvTxt ? ctx.measureText(lvTxt).width + 4 : 0;
    ctx.textAlign = 'left';
    ctx.strokeText(`〔${tblTag}〕`, p.x + nameW / 2 + 4 + lvW, nameY);
    ctx.fillStyle = tblTag === '遊戲中' ? '#7fe0a8' : '#c8d8ff';
    ctx.fillText(`〔${tblTag}〕`, p.x + nameW / 2 + 4 + lvW, nameY);
    ctx.textAlign = 'center';
    ctx.font = '10px "Microsoft JhengHei"';
  }
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
  const F = S.avatar.frames, s = F.scale || 2, img = playerSpriteDiv(p, (F.states.down_idle || [0])[0]);   // 用正面待機的第 1 幀切出頭與肩膀
  // 頭與肩膀那塊：由底圖實測——人佔幀內 x 22..40、y 20..63（高 44），頭約在上 30%
  const sw = Math.round(F.w * .30), sh = Math.round(F.h * .21), sx = Math.round(F.w * .36), sy = Math.round(F.h * .30);
  ctx.drawImage(img, sx, sy, sw, sh, p.x - sw * s / 2, p.y - 33, sw * s, sh * s);   // 頭的水平中心對準枕頭（單人床中央）
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
  if (S.t < (me.petUntil ?? 0)) { toast('被石化了，動彈不得', 1200); return; }   // 石化中不能傳送（否則等於繞過「不能移動」）
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
// 島主放招倒數條：固定畫在視窗上方置中（不畫在島主頭上——島主很高，會被名牌／泡泡／其他物件蓋住，也常常跑出畫面外）。
// 大小是 drawCastBar 的三倍（216×18）；黃色由左往右填，填滿就放招，右上角是招式名稱。
function drawOwnerCastBar(frac, name) {
  const w = 216, h = 18, x = Math.round(canvas.width / 2 - w / 2), y = 84;
  frac = Math.max(0, Math.min(1, frac));
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,.78)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);   // 底
  ctx.fillStyle = '#f3c93e'; ctx.fillRect(x, y, w * frac, h);                      // 黃色倒數
  ctx.fillStyle = 'rgba(255,246,200,.55)'; ctx.fillRect(x, y, w * frac, 6);        // 上緣亮線
  ctx.strokeStyle = 'rgba(214,180,96,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x - .5, y - .5, w + 1, h + 1);   // 細金邊
  if (name) {
    ctx.font = 'bold 20px "Microsoft JhengHei"'; ctx.textAlign = 'right';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,10,14,.85)';
    ctx.strokeText(name, x + w, y - 6);
    ctx.fillStyle = '#ffe08a'; ctx.fillText(name, x + w, y - 6);
  }
  ctx.restore();
}
// 島主台詞的固定字幕（2026-11-08，使用者要求）：島主頭上的泡泡照舊，另外在視窗上方置中（讀條下方）固定顯示同一句，
// 避免玩家離島主太遠、泡泡跑出畫面就看不到。多隻島主同時說話只顯示最晚說的那一句；台詞裡的換行照換，
// 單行太寬（超過視窗）時在全形空白（台詞裡刻意的停頓）換行。
function drawOwnerLineBanner() {
  let best = null;
  for (const a of S.mobs) if (a.say && S.t < a.say.until && !a.dead && (!best || a.say.until > best.say.until)) best = a;
  if (!best) return;
  const NL = String.fromCharCode(10), name = mobDef(best.id)?.name || '', alpha = Math.min(1, (best.say.until - S.t) / .4);
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = 'bold 16px "Microsoft JhengHei"'; ctx.textAlign = 'center';
  const maxW = canvas.width - 80, rows = [];
  for (const r of String(best.say.text).split(NL)) {
    if (ctx.measureText(r).width <= maxW) rows.push(r);
    else rows.push(...r.split(String.fromCharCode(0x3000)).filter(Boolean));
  }
  const lh = 22, w = Math.ceil(Math.max(...rows.map(r => ctx.measureText(r).width), ctx.measureText(name).width)) + 28, h = 22 + rows.length * lh;
  const x = Math.round(canvas.width / 2 - w / 2), y = 110;   // 讀條（y=84～102）正下方
  ctx.fillStyle = 'rgba(8,10,14,.78)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(214,180,96,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  ctx.font = 'bold 11px "Microsoft JhengHei"'; ctx.fillStyle = '#ffe08a'; ctx.fillText(name, canvas.width / 2, y + 14);
  ctx.font = 'bold 16px "Microsoft JhengHei"'; ctx.fillStyle = '#fff6e0';
  rows.forEach((r, i) => ctx.fillText(r, canvas.width / 2, y + 20 + (i + 1) * lh - 6));
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
  return x >= 0 && y >= 0 && x < COLS && y < ROWS && S.world.types[y * COLS + x] === 0 && inRoom(x, y) && !(S.floorMap && floorAt(S.floorMap, x, y) >= 0);   // 鋪了地板的水面不能拋竿；室內房間外不是水
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
    p.fish = { ph: 'wait', x: Math.round(pt.x), y: Math.round(pt.y), t: S.t, c0: S.t, biteAt: S.t + FISH_WAIT[0] + Math.random() * (FISH_WAIT[1] - FISH_WAIT[0]) };
    if (Math.abs(pt.x - p.x) > 4) p.dir = Math.sign(pt.x - p.x);
    p.d8 = dir4To(pt.x - p.x, pt.y - p.y, p); p.face = p.d8 === 'up' || p.d8 === 'down' ? p.d8 : 'side'; p.tool = null;
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
  if (db.lurker && !(db.noLurker || []).includes(terrain) && mobDef(db.lurker) && !S.mobs.some(v => v.lurker && !v.dead) && Math.random() < (db.lurkerChance || 0))   // noLurker：和平島不會釣到
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
  for (const e of S.craftDB?.sources.fish || []) if ((!e.terrains || e.terrains.includes(m.terrain)) && Math.random() < (e.chance ?? 1)) collectMaterial(e.item, p.x, p.y);   // 合成素材：釣魚偶爾得到
  grantExp(isNew ? 5 : 1, p.x, p.y - 80, 'fish');   // 釣到魚 +1 XP；圖鑑首捕 +5（登入者由伺服器記帳——牠自己抽的魚自己知道）
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
  const [hx, hy] = charAnch.hand, s = wi.wscale || 2;
  ctx.save(); ctx.translate(hx, hy - 10); ctx.rotate(Math.sin(S.t * 9) * .05);
  ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s);
  const ty = -(wi.height - 3) * s;   // 杖頂
  ctx.globalCompositeOperation = 'lighter';
  const r = 3 + 7 * q + Math.sin(S.t * 24) * 1.2;
  const g = ctx.createRadialGradient(0, ty, 0, 0, ty, r);
  g.addColorStop(0, `rgba(190,255,200,${.55 + .4 * q})`); g.addColorStop(1, 'rgba(120,230,160,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, ty, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// 畫拋出去的釣竿（ctx 已 translate 到角色腳底並依 dir 翻轉；轉軸同揮擊＝握把）
function drawRodCast(wi, a) {
  const s = wi.wscale || 2;
  ctx.save(); ctx.translate(charAnch.hand[0], charAnch.hand[1]); ctx.rotate(a);
  ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();
}
// 釣線與浮標（世界座標）：從竿尖拉到浮標；上鉤時浮標沉下去、水面起漣漪；拉扯時浮標往人這邊收
// LPC 釣竿（avatar.json 的 lpc.tips＝每方向每格的竿尖，格內像素）：這一幀是釣竿動作就回竿尖的世界座標，否則 null
function lpcRodTip(p, cf, cs, pad) {
  const F = S.avatar.frames, ent = F.map?.[cf.fi];
  if (!ent || ent[3] !== 'rod') return null;
  const wid = p === S.players[0] ? S.me.weapon : p.weapon, tips = S.avatar.weapons.find(w => w.id === wid)?.lpc?.tips;
  const t = tips?.[ent[5]]?.[ent[4]]; if (!t) return null;
  const size = 128;   // 釣竿超大格邊長；人物畫在正中央（pad＝(size−64)/2）
  return { x: p.x + (p.rodJit || 0) + (t[0] - size / 2) * cs, y: p.y - p.z + (t[1] - (F.h + pad) + (F.footDy || 0)) * cs };
}
function drawLineAndBobber(p, wi, f, tip) {
  let tx, ty;
  if (tip) { tx = tip.x; ty = tip.y; }
  else {
    const a = rodAngle(f), L = (wi.height - 3) * (wi.wscale || 2) - 2, dir = p.dir < 0 ? -1 : 1;
    tx = p.x + dir * (charAnch.hand[0] + L * Math.sin(a)); ty = p.y - p.z + charAnch.hand[1] - L * Math.cos(a);
  }
  let bx = f.x, by = f.y;
  const since = S.t - (f.t ?? S.t);
  // 拋竿動畫（2026-11-09）：竿子往後揚時浮標掛在竿尖，往前甩（拋竿後 ROD_FLY[0] 秒）時沿拋物線飛到落點、釣線跟著拉出去，落水濺一圈漣漪。
  // 只是畫面：浮標的落點與等魚計時照舊從拋竿那一刻算；別人看到的從收到「等魚」狀態那一刻開始播
  const cast = f.ph === 'wait' ? S.t - (f.c0 ?? f.t ?? S.t) : Infinity;
  let flying = false, sag = f.ph === 'wait' ? 18 : 4;     // 等魚時線鬆鬆的，上鉤／拉扯時繃緊
  if (cast < ROD_FLY[0]) { bx = tx; by = ty + 7; sag = 0; flying = true; }   // 還沒甩出去：浮標垂在竿尖下
  else if (cast < ROD_FLY[1]) {
    const q = (cast - ROD_FLY[0]) / (ROD_FLY[1] - ROD_FLY[0]), e = 1 - (1 - q) * (1 - q);   // 先快後慢
    const d = Math.hypot(f.x - tx, f.y - ty), h = 18 + d * .25;   // 拋物線高度：拋越遠飛越高
    bx = tx + (f.x - tx) * e; by = ty + (f.y - ty) * e - Math.sin(Math.PI * q) * h;
    sag = 2 + 10 * q; flying = true;
  } else if (f.ph === 'reel') {   // 拉竿：浮標沿水面直直拉向人（跟原本一樣，不往上甩）
    const q = Math.min(1, since / FISH_REEL);
    bx += (p.x - bx) * q * .6; by += (p.y - 10 - by) * q * .6;
  }
  else if (f.ph === 'wait') by += Math.sin(S.t * 3) * 1.5;
  else by += 3;
  ctx.save();
  ctx.strokeStyle = 'rgba(240,240,232,.85)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo((tx + bx) / 2, Math.max(ty, by) + sag, bx, by - 3); ctx.stroke();
  const splash = cast - ROD_FLY[1];
  if (splash >= 0 && splash < .45) {       // 落水：一圈較大的水花
    const q = splash / .45;
    ctx.strokeStyle = `rgba(240,250,255,${.8 * (1 - q)})`;
    ctx.beginPath(); ctx.ellipse(f.x, f.y + 1, 5 + q * 16, 2 + q * 5, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(240,250,255,${.8 * (1 - q)})`;
    for (let i = 0; i < 5; i++) {   // 濺起的水珠
      const a = Math.PI * (.15 + .7 * i / 4), r = 4 + q * 10;
      ctx.fillRect(f.x + Math.cos(a) * r * (i % 2 ? 1 : -1) - .5, f.y - 2 - Math.sin(Math.PI * q) * 8 * Math.sin(a), 1.5, 1.5);
    }
  }
  if (f.ph !== 'reel' && !flying) {        // 水面漣漪
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
// 圖鑑視窗（2026-11-09 使用者要求：合成併進來）：上方大頁籤＝魚類圖鑑／素材圖鑑／合成／配方筆記（S.dexMain）；
// 魚類圖鑑底下再分地形頁籤，合成三頁沿用 buildCraft（S.craftTab）。S.craftOpen＝圖鑑開著且在合成那三頁（解鎖時要不要重畫）
const DEX_MAIN = [['fish', '魚類圖鑑'], ['dex', '素材圖鑑'], ['make', '合成'], ['notes', '配方筆記']];   // 2026-11-09 使用者要求素材圖鑑與合成交換位置
function openDex(main) {
  S.dexOpen = true; S.dexTab ||= S.fishDB?.terrains[S.terrain] ? S.terrain : TERRAIN_IDS[0];
  if (main) S.dexMain = main;
  S.dexMain ||= 'fish';
  if (S.dexMain !== 'fish' && !S.craftDB) S.dexMain = 'fish';
  buildDexMain(); $('dexBox').classList.remove('hidden');
}
function closeDex() { S.dexOpen = false; S.craftOpen = false; $('dexBox').classList.add('hidden'); }
function buildDexMain() {
  const tabs = $('dexMainTabs'); tabs.innerHTML = '';
  for (const [id, name] of DEX_MAIN) {
    if (id !== 'fish' && !S.craftDB) continue;
    const b = document.createElement('button');
    b.className = 'ff-btn small' + (S.dexMain === id ? ' active' : '');
    b.textContent = name;
    b.onclick = () => { S.dexMain = id; S.craftMsg = ''; buildDexMain(); };
    tabs.appendChild(b);
  }
  const fish = S.dexMain === 'fish';
  $('dexFish').classList.toggle('hidden', !fish); $('dexCraft').classList.toggle('hidden', fish);
  S.craftOpen = S.dexOpen && !fish;
  if (fish) buildDex();
  else { S.craftTab = S.dexMain; buildCraft(); }
}
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

// ---- 合成：素材圖鑑／合成／配方筆記（2026-11-07，使用者要求）----
// 資料在 assets/craft/craft.json（手寫）。素材「採集過一次就解鎖進圖鑑、之後無限使用（不消耗）」；合成出的素材／家具同樣解鎖。
// 成功猜出新配方就記進配方筆記。解鎖紀錄 S.craft = { mat:{素材id:時間}, furn:{家具id:時間}, rec:{配方id:時間} }：
// 登入者以伺服器為準（craftdb／craft／craftsync，見 notes 的「合成」），訪客／單機存 localStorage（dcisland.m0.craft）。解鎖純客戶端判斷（信任客戶端，使用者定）。
const CRAFT_KINDS = ['mat', 'furn', 'rec'];
function craftNorm(c) { const o = {}; for (const k of ['mat', 'furn', 'rec']) o[k] = (c && typeof c[k] === 'object' && c[k] && !Array.isArray(c[k])) ? { ...c[k] } : {}; return o; }   // function 宣告（S 初始化時要用到）
const craftSave = () => lsSet('dcisland.m0.craft', S.craft);
const matDef = id => S.craftDB?.matById.get(id) || null;
const recipeKey = ids => [...ids].sort().join('+');
function initCraft(db) {
  if (!db || !Array.isArray(db.materials)) return;
  db.matById = new Map(db.materials.map(m => [m.id, m]));
  db.recipeByKey = new Map(db.recipes.map(r => [recipeKey(r.in), r]));
  S.craftDB = db;
}
// 解鎖一筆；回傳 true＝這次才解鎖。登入者順手通知伺服器（訪客／沒連線 net 會自己略過）
function unlockCraft(k, id) {
  if (S.craft[k][id]) return false;
  S.craft[k][id] = Date.now();
  craftSave();
  S.net?.craftUnlock?.(k, id);
  if (S.craftOpen) buildCraft();
  if (k === 'furn' && S.mode === 'decor') buildFurnPanel();
  return true;
}
// 撿到／得到素材：新的就解鎖並提示，已解鎖的只在頭上飄一下名字
function collectMaterial(id, x, y) {
  const m = matDef(id); if (!m) return;
  if (unlockCraft('mat', id)) toast(`解鎖素材：${m.name}！已記入素材圖鑑，之後可無限使用`, 2800);
  else S.floaters.push({ x, y: y - 50, v: m.name, life: .8 });
}
// 擲一次掉落表：[{item,min,max,chance}] → 回傳 [{item, n}]
function rollCraftDrops(list) {
  const out = [];
  for (const e of list || []) {
    if (!matDef(e.item) || Math.random() >= (e.chance ?? 1)) continue;
    const lo = e.min ?? 1, n = lo + Math.floor(Math.random() * ((e.max ?? lo) - lo + 1));
    if (n > 0) out.push({ item: e.item, n });
  }
  return out;
}
// 地形物件的掉落表：「地形/圖檔」（各島專屬，例如 beach/rock.png）優先於「圖檔」
const craftDecoDrops = sprite => S.craftDB?.sources.deco[`${S.terrain}/${sprite}`] || S.craftDB?.sources.deco[sprite];
function spawnCraftDrops(list, x, y) {   // 掉在地上、走過去自動撿（與 tools.json 的 drops 同一套）
  for (const { item, n } of rollCraftDrops(list)) for (let i = 0; i < n; i++) S.drops.push({ item, x: x + Math.random() * 30 - 15, y: y + Math.random() * 16 - 4, born: S.t });
}
const furnAvailable = it => !it.craft || !!S.craft.furn[it.id];   // furniture.json 標 craft 的家具要合成解鎖才能擺

// 把素材／家具的圖畫進一個 canvas（家具取第 1 幀、置中縮放）
function craftIcon(kind, id, size) {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  if (kind === 'furn') {
    const spr = S.furnImgs[id];
    if (spr) { const s2 = Math.min(size / spr.fw, size / spr.fh); const w = spr.fw * s2, h = spr.fh * s2; g.drawImage(spr.img, 0, 0, spr.fw, spr.fh, (size - w) / 2, size - h, w, h); }
  } else {
    const im = S.craftImgs[id]; if (im) g.drawImage(im, 0, 0, size, size);
  }
  return cv;
}
function craftSilhouette(cv) { const g = cv.getContext('2d'); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#07090c'; g.fillRect(0, 0, cv.width, cv.height); return cv; }
const outName = o => o.kind === 'furniture' ? (furnitureDef(o.id)?.name || o.id) : (matDef(o.id)?.name || o.id);
const outKey = o => o.kind === 'furniture' ? 'furn' : 'mat';

function openCraft(tab) { S.craftMsg = ''; openDex(tab || S.craftTab || 'make'); }   // 合成已併進圖鑑視窗
function closeCraft() { closeDex(); }
function craftAddSlot(id) {
  if (S.craftSlots.length >= (S.craftDB.maxInputs || 3)) { S.craftMsg = '放不下了：最多 ' + (S.craftDB.maxInputs || 3) + ' 個素材'; buildCraft(); return; }
  S.craftSlots.push(id); S.craftMsg = ''; buildCraft();
}
function tryCraft() {
  const ids = S.craftSlots;
  if (ids.length < 2) { S.craftMsg = '至少要放 2 個素材'; buildCraft(); return; }
  const r = S.craftDB.recipeByKey.get(recipeKey(ids));
  if (!r) { S.craftMsg = '什麼都沒發生……（素材不會消耗，換個組合試試）'; S.craftFail = true; buildCraft(); S.craftFail = false; return; }
  const newRec = unlockCraft('rec', r.id), newOut = unlockCraft(outKey(r.out), r.out.id);
  const nm = outName(r.out);
  S.craftMsg = `合成成功：${nm}！` + (newRec ? '（新配方已記進配方筆記）' : '（已經會這個配方了）') + (newOut ? (r.out.kind === 'furniture' ? ' 家具已解鎖，可在裝飾模式無限擺放。' : ' 素材已解鎖，可無限使用。') : '');
  if (newRec) toast(`新配方：${r.in.map(i => matDef(i)?.name || i).join(' + ')} → ${nm}`, 3200);
  S.craftSlots = [];
  buildCraft();
}
function buildCraft() {
  const db = S.craftDB; if (!db) return;
  const tabs = $('craftTabs'); tabs.innerHTML = '';
  for (const [id, name] of [['make', '合成'], ['dex', '素材圖鑑'], ['notes', '配方筆記']]) {
    const b = document.createElement('button'); b.className = 'ff-btn small' + (S.craftTab === id ? ' active' : ''); b.textContent = name;
    b.onclick = () => { S.craftTab = id; S.dexMain = id; S.craftMsg = ''; buildDexMain(); }; tabs.appendChild(b);
  }
  const nMat = db.materials.filter(m => S.craft.mat[m.id]).length, nRec = db.recipes.filter(r => S.craft.rec[r.id]).length;
  $('craftHint').textContent = `素材 ${nMat}／${db.materials.length} · 配方 ${nRec}／${db.recipes.length}` + (S.net?.uid ? ' · 以 Discord 帳號保存' : ' · 訪客／未連線：只存在這台電腦');
  const body = $('craftBody'), keepScroll = body.dataset.tab === S.craftTab ? body.scrollTop : 0;   // 同一頁重畫（例如點素材放進合成格）時維持捲動位置
  body.innerHTML = ''; body.dataset.tab = S.craftTab;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  if (S.craftTab === 'make') {
    const head = mk('div', 'craft-head');   // 合成格＋說明：固定在捲動區上方（2026-11-09 使用者要求：像凍結窗格，只捲素材）
    const row = mk('div', 'craft-slots');
    const max = db.maxInputs || 3;
    for (let i = 0; i < max; i++) {
      const id = S.craftSlots[i], sl = mk('div', 'craft-slot' + (id ? ' full' : '') + (S.craftFail ? ' fail' : ''));
      if (id) { sl.appendChild(craftIcon('mat', id, 40)); sl.title = matDef(id)?.name + '（點一下取下）'; sl.onclick = () => { S.craftSlots.splice(i, 1); S.craftMsg = ''; buildCraft(); }; }
      row.appendChild(sl);
      if (i < max - 1) row.appendChild(mk('span', 'craft-op', '+'));
    }
    const go = mk('button', 'ff-btn', '合成'); go.onclick = tryCraft;
    const clr = mk('button', 'ff-btn small', '清空'); clr.onclick = () => { S.craftSlots = []; S.craftMsg = ''; buildCraft(); };
    row.append(mk('span', 'craft-op', '→'), go, clr);
    head.append(row, mk('div', 'craft-msg', S.craftMsg || '點下面的素材放進合成格（2～' + max + ' 個，不分順序），猜對配方就能做出新東西。素材用不完，錯誤的組合也不會消耗。'));
    body.appendChild(head);
    const grid = mk('div', 'craft-grid');
    const have = db.materials.filter(m => S.craft.mat[m.id]);
    for (const m of have) {
      const card = mk('div', 'craft-card'); card.append(craftIcon('mat', m.id, 40), mk('div', 'craft-name', m.name));
      card.onclick = () => craftAddSlot(m.id); grid.appendChild(card);
    }
    if (!have.length) grid.appendChild(mk('div', 'craft-empty', '還沒有素材：去採集（砍樹、敲石頭）、釣魚或打野外動物，蒐集到的素材會解鎖在這裡。'));
    body.appendChild(grid);
  } else if (S.craftTab === 'dex') {
    for (const g of db.groups) {
      const list = db.materials.filter(m => m.group === g.id); if (!list.length) continue;
      body.appendChild(mk('div', 'craft-group', `${g.name}　${list.filter(m => S.craft.mat[m.id]).length}／${list.length}`));
      const grid = mk('div', 'craft-grid');
      for (const m of list) {
        const got = !!S.craft.mat[m.id], card = mk('div', 'craft-card' + (got ? '' : ' unknown'));
        const cv = craftIcon('mat', m.id, 40); card.append(got ? cv : craftSilhouette(cv), mk('div', 'craft-name', got ? m.name : '？？？'));
        if (got) card.append(mk('div', 'craft-how', m.how));
        grid.appendChild(card);
      }
      body.appendChild(grid);
    }
  } else {
    const list = db.recipes.filter(r => S.craft.rec[r.id]).sort((a, b) => S.craft.rec[a.id] - S.craft.rec[b.id]);
    for (const r of list) {
      const row = mk('div', 'craft-note');
      row.title = '點一下：跳到合成頁並排好素材';
      row.onclick = () => { S.craftTab = 'make'; S.craftSlots = [...r.in]; S.craftMsg = `已排好「${outName(r.out)}」的素材，按合成即可`; buildCraft(); };   // 筆記裡的配方：一鍵排進合成格
      r.in.forEach((id, i) => { if (i) row.appendChild(mk('span', 'craft-op', '+')); const c = mk('div', 'craft-mini'); c.append(craftIcon('mat', id, 28), mk('span', null, matDef(id)?.name || id)); row.appendChild(c); });
      row.appendChild(mk('span', 'craft-op', '→'));
      const o = mk('div', 'craft-mini out'); o.append(craftIcon(outKey(r.out), r.out.id, 28), mk('span', null, outName(r.out) + (r.out.kind === 'furniture' ? '（家具）' : '')));
      row.appendChild(o); body.appendChild(row);
    }
    body.appendChild(mk('div', 'craft-empty', list.length ? `還有 ${db.recipes.length - list.length} 個配方沒發現` : '還沒有發現任何配方：到「合成」分頁試試看吧。'));
  }
  body.scrollTop = keepScroll;
}
// 伺服器送來的解鎖紀錄（登入後、craftsync 之後）：和本機取聯集（訪客時期的進度併進帳號），本機有伺服器沒有的補傳
function onNetCraftDb(c) {
  const srv = craftNorm(c), merged = craftNorm(S.craft), up = { mat: [], furn: [], rec: [] };
  for (const k of CRAFT_KINDS) {
    for (const [id, t] of Object.entries(srv[k])) if (!merged[k][id] || merged[k][id] > t) merged[k][id] = t;
    for (const id of Object.keys(S.craft[k])) if (!srv[k][id]) up[k].push(id);
  }
  S.craft = merged; craftSave();
  if (up.mat.length || up.furn.length || up.rec.length) S.net?.craftSync?.(up);
  if (S.craftOpen) buildCraft();
  if (S.mode === 'decor') buildFurnPanel();
}

// ---- 和平島遊戲桌（2026-11-08，使用者要求）：走近按 F／點桌子進入遊戲畫面（全螢幕），Esc 離開；桌滿人後其他人觀戰 ----
// 桌子是島上固定物件（terrain.json 的 tables；遊戲定義在 assets/games/games.json）。牌局由伺服器權威（tbl／table／tblinfo 訊息，
// 見 notes「和平島與遊戲桌」）：客戶端只畫畫面、送操作，手牌只有伺服器給本人的那份。
const TABLE_RANGE = 56;   // 離桌邊多近才能互動（px）
const tablesHere = () => S.terrains[S.terrain]?.tables || [];
const tableRect = tb => ({ x: tb.cell[0] * CELL, y: tb.cell[1] * CELL, w: (tb.w || 3) * CELL, h: (tb.h || 2) * CELL });
function tableAtCell(x, y) {   // 這格被桌子占著（桌子擋路、也不能擺家具）
  for (const tb of tablesHere()) if (x >= tb.cell[0] && x < tb.cell[0] + (tb.w || 3) && y >= tb.cell[1] && y < tb.cell[1] + (tb.h || 2)) return tb;
  return null;
}
function tableDist(tb, px, py) {   // 點到桌子矩形的距離
  const r = tableRect(tb), dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function tableNear(p) {   // F 鍵：身邊（桌邊 TABLE_RANGE 內）最近的桌子
  let best = null, bd = TABLE_RANGE;
  for (const tb of tablesHere()) { const d = tableDist(tb, p.x, p.y); if (d < bd) { bd = d; best = tb; } }
  return best;
}
function tableAtPoint(wx, wy) {
  return tablesHere().find(tb => { const r = tableRect(tb); return wx >= r.x && wx < r.x + r.w && wy >= r.y && wy < r.y + r.h; }) || null;
}
const gameDef = id => S.gamesDB?.games?.[id] || null;
function openTable(tb) {
  if (!netOn()) { toast('遊戲桌需要連線才能玩（單機模式不能玩）', 2400); return; }
  if (!gameDef(tb.game)) return;
  for (const k of Object.keys(keys)) keys[k] = false;   // 放開所有按住的鍵（畫面蓋住後收不到 keyup，不然回來還在跑）
  S.mouseHeld = false;
  S.tableOpen = true; S.tableId = tb.id; S.tableView = null; S.gmStep = null; S.bk = null; S.tg = null; S.gamePlayed = false; S.tableLocalLog = [];
  const inf = S.tblInfo?.[tb.id];
  S.tableCab = tb.cab ?? -1; S.ar = null; S.arOpp = {};   // 俄羅斯方塊：4 台共用一張桌，坐哪一台由 cab 決定
  if (tb.game === 'arcade' ? !inf?.cabs?.[tb.cab] : (!inf || (!inf.play && inf.n < inf.max))) S.tableChoice = true;   // 還有位子（街機：這台空著）：先讓玩家選「入座」或「觀戰」（沒滿人也可以選觀戰）
  else S.net.tbl({ a: 'join', id: tb.id, role: 'spec', cab: S.tableCab });             // 滿人或已開局（街機：這台有人）：直接觀戰
  buildTable(); $('tableBox').classList.remove('hidden');
}
function closeTable(sendLeave = true) {
  if (sendLeave) S.net?.tbl?.({ a: 'leave' });
  S.tableOpen = false; S.tableId = null; S.tableView = null; S.tableChoice = false; dodgeStop(); mageStop(); typingStop(); arStop(); mzStop(); hkStop(); unStopTimer(); bkStopTimer(); itStopTimer(); S.unPick = null; S.itSel = -1; S.itMode = null;
  rulesShow(false); leaveAsk(false);
  $('tableBox').classList.add('hidden');
}
// 使用者主動離開（離開按鈕／Esc）：我是入座玩家而且牌局進行中 → 先跳確認（離開會直接中斷這一局或放棄成績）；觀戰、還沒開局就直接離開
function leaveAsk(on) {
  const box = $('leaveBox'); box.classList.toggle('hidden', !on);
  if (on) $('leaveStay').focus();   // 預設停在「繼續遊戲」，連點空白鍵也不會誤退出
}
function leaveTable() {
  const box = $('leaveBox');
  if (!box.classList.contains('hidden')) { leaveAsk(false); return; }   // Esc 再按一次＝取消確認，繼續遊戲
  const v = S.tableView;
  if (v && v.phase === 'playing' && v.role === 'seat') leaveAsk(true); else closeTable();
}
// 規則說明視窗：遊戲定義有 guide（分段規則）的遊戲才有按鈕；入座／觀戰／遊戲中都能開關，不影響牌局畫面
function rulesGuide() { const tb = tablesHere().find(t => t.id === S.tableId); return tb && gameDef(tb.game)?.guide || null; }
// 規則說明／角色介紹共用同一個浮動視窗，由標題列的兩顆按鈕各自開關（tab＝'rules'｜'chars'）；角色介紹視窗高度固定，上一位／下一位按鈕位置不會跳
function rulesShow(on, tab) {
  const g = on ? rulesGuide() : null, box = $('rulesBox');
  if (!g) { box.classList.add('hidden'); return; }
  const tb = tablesHere().find(t => t.id === S.tableId), chars = tb && gameDef(tb.game)?.characters;
  const was = S.rulesTab;
  S.rulesTab = tab === 'chars' && chars ? 'chars' : 'rules';
  if (S.rulesTab === 'chars' && was !== 'chars' && box.classList.contains('hidden') && !S.rulesKeep) S.rulesChar = null;   // 重新打開角色介紹：從選單開始
  $('rulesTitle').textContent = S.rulesTab === 'chars' ? '角色介紹' : (g.title || '規則說明');
  const body = $('rulesBody'); body.innerHTML = '';
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const panel = box.querySelector('.rules-panel'); panel.classList.toggle('chars', S.rulesTab === 'chars');
  if (S.rulesTab === 'chars') {
    const ids = Object.keys(chars), cur = ids.indexOf(S.rulesChar);
    if (cur < 0) {   // 選單：每個角色一顆按鈕（置中、等寬），點了看詳細介紹
      body.appendChild(mk('div', 'rules-hint', '每人開局拿 1 張身分牌和 2 張角色卡，選 1 張當本局角色。公開型選完就翻開，隱藏型保持覆蓋。「咒術勝利條件」只有咒術師身分才用；沒開「角色卡」模式時不會用到這些。點角色名稱看詳細介紹。'));
      const menu = mk('div', 'char-menu');
      for (const id of ids) { const b = mk('button', 'ff-btn char-menu-btn', chars[id].name); b.onclick = () => { S.rulesChar = id; rulesShow(true, 'chars'); }; menu.appendChild(b); }
      body.appendChild(menu);
    } else {   // 詳細介紹：上方左右切換、中間卡片（高度固定、內容多就在卡片區捲動）、下方回到選單
      const wrap = mk('div', 'char-view');
      const bar = mk('div', 'char-nav');
      const go = d => { S.rulesChar = ids[(cur + d + ids.length) % ids.length]; rulesShow(true, 'chars'); };
      const prev = mk('button', 'ff-btn small', '◀ 上一位'); prev.onclick = () => go(-1);
      const next = mk('button', 'ff-btn small', '下一位 ▶'); next.onclick = () => go(1);
      bar.appendChild(prev); bar.appendChild(mk('span', 'char-nav-pos', `${cur + 1} / ${ids.length}`)); bar.appendChild(next);
      wrap.appendChild(bar);
      const one = mk('div', 'char-detail'); one.appendChild(itCharCardEl(ids[cur], mk)); wrap.appendChild(one);
      const back = mk('div', 'char-nav'); const bb = mk('button', 'ff-btn small', '回到選單'); bb.onclick = () => { S.rulesChar = null; rulesShow(true, 'chars'); }; back.appendChild(bb); wrap.appendChild(back);
      body.appendChild(wrap);
    }
  } else for (const sec of g.sections) {
    const d = mk('div', 'rules-sec'); d.appendChild(mk('h4', null, sec.h));
    const ul = mk('ul');
    for (const t of sec.li) { const li = mk('li', /^\d+\. /.test(t) ? 'num' : null); t.split('**').forEach((part, k) => { if (k % 2) li.appendChild(mk('b', null, part)); else li.append(part); }); ul.appendChild(li); }   // **字** ＝粗體
    d.appendChild(ul); body.appendChild(d);
  }
  box.classList.remove('hidden');
}
const rulesToggle = tab => { const open = !$('rulesBox').classList.contains('hidden'); if (open && S.rulesTab === tab) rulesShow(false); else rulesShow(true, tab); };   // 再點同一顆按鈕關閉，點另一顆切換內容
function onNetTable(m) {   // 伺服器給我的牌桌畫面（v＝null：我已離開這桌）
  if (!S.tableOpen || m.id !== S.tableId) return;
  if (m.v === null) { closeTable(false); return; }
  // 玩小遊戲得 XP：登入者由伺服器記（收到 xp 訊息飄字）；訪客（本機記帳）在這裡依 result.xp 補發。只算「我自己坐著打完的那一局」
  if (m.v.phase === 'playing') S.tableLocalLog = [];   // 新的一局開始：清掉上一局的 XP 提示
  if (m.v.phase === 'playing' && m.v.role === 'seat') S.gamePlayed = true;
  const rs = m.v.result;
  if (S.gamePlayed && rs && rs.rid && rs.rid !== S.gameXpSeen && m.v.phase !== 'playing') {
    S.gameXpSeen = rs.rid; S.gamePlayed = false;
    const n = rs.xp?.[m.v.me] || 0, gs = rs.gs?.[m.v.me];
    if (gs && !xpServer()) gstatsLocalApply(m.v.game, gs);   // 訪客：戰績（稱號用）本機累加；登入者由伺服器記並送 gstats
    if (n > 0 && !xpServer()) { const p0 = S.players[0]; grantExp(n, p0.x, p0.y - 60, 'game'); tableXpLine(n); }   // 訪客：本機補發，提示放進牌桌下方的系統訊息
  }
  S.tableView = m.v; buildTable();
}
// 牌桌下方的系統訊息：伺服器的紀錄（新的在上）＋本機加的「你獲得 N XP」（放最上面；新的一局開始就清掉）
function tableXpLine(n) { (S.tableLocalLog ||= []).unshift(`你獲得 ${n} XP`); if (S.tableOpen && S.tableView) buildTable(); }
const tableLogLines = v => [...(S.tableLocalLog || []), ...[...v.log].reverse()];
function onNetTblInfo(info) { S.tblInfo = info || {}; }
// 名牌後面的牌桌狀態：入座中的人顯示「入座中」（還沒開局）或「遊戲中」（牌局進行中），讓同島的人知道他們在玩（只看這座地形的桌子）
function tableTag(p) {
  if (p.npc) return null;
  const id = p === S.players[0] ? S.net?.id : p.id;
  if (id == null) return null;
  for (const tb of tablesHere()) { const inf = S.tblInfo?.[tb.id]; if (inf?.seated?.includes(id)) return (inf.playing ? inf.playing.includes(id) : inf.play) ? '遊戲中' : '入座中'; }   // 俄羅斯方塊：每台各自在不在玩（playing）
  return null;
}
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
function cardEl(c) {   // 牌面：c＝'S7'／'H13'／'JK'；null＝牌背
  const e = document.createElement('div');
  if (!c) { e.className = 'tcard back'; return e; }
  if (c === 'JK') { e.className = 'tcard joker'; e.textContent = '鬼'; return e; }
  const r = Number(c.slice(1));
  e.className = 'tcard' + (c[0] === 'H' || c[0] === 'D' ? ' red' : '');
  e.textContent = SUIT_SYM[c[0]] + ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[r] || r);
  return e;
}
function buildTable() {
  const box = $('tableBody'); box.innerHTML = '';
  const tb = tablesHere().find(t => t.id === S.tableId), gd = tb && gameDef(tb.game), v = S.tableView;
  $('tableTitle').textContent = gd ? gd.name : '遊戲桌';
  $('tableRulesBtn').classList.toggle('hidden', !gd?.guide);
  $('tableCharsBtn').classList.toggle('hidden', !gd?.characters);
  if (!(v && v.phase === 'playing' && v.role === 'seat')) leaveAsk(false);   // 牌局結束／被移出座位：確認視窗不留著
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  if (S.tableChoice) {   // 剛走到桌邊：選入座還是觀戰
    const inf = S.tblInfo?.[S.tableId];
    if (S.tableCab >= 0) box.appendChild(mk('div', 'table-status', `${gd ? gd.name : '遊戲桌'}　${S.tableCab + 1} 號機（空機台）${inf?.n ? `，其他機台 ${inf.n} 人` : ''}${inf?.s ? `，${inf.s} 人觀戰` : ''}`));   // 俄羅斯方塊：4 台共用一張桌，說是哪一台
    else box.appendChild(mk('div', 'table-status', `${gd ? gd.name : '遊戲桌'}　目前 ${inf ? `${inf.n}/${inf.max} 人入座` : '還沒有人入座'}${inf?.s ? `，${inf.s} 人觀戰` : ''}`));
    if (gd?.story) box.appendChild(mk('div', 'it-story', gd.story));   // 有故事背景的遊戲（秘藥情報戰）：先看故事
    box.appendChild(mk('div', 'table-tag', '要加入遊戲，還是先在旁邊看？（觀戰不用等滿人，之後想玩可以再按「入座」）'));
    const bs = mk('div', 'table-btns');
    for (const [label, role] of [['入座', 'seat'], ['觀戰', 'spec']]) {
      const b = mk('button', 'ff-btn', label);
      b.onclick = () => { S.tableChoice = false; S.net?.tbl?.({ a: 'join', id: S.tableId, role, cab: S.tableCab }); buildTable(); };
      bs.appendChild(b);
    }
    const lv = mk('button', 'ff-btn small', '離開（Esc）'); lv.onclick = () => leaveTable(); bs.appendChild(lv);
    box.appendChild(bs);
    if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
    return;
  }
  if (!v) { box.appendChild(mk('div', 'table-status', '連線中…')); return; }
  if (tb?.game === 'arcade') { buildArcade(box, v, mk, gd); return; }   // 俄羅斯方塊有自己的畫面（盤面＋聯機）
  if (tb?.game === 'gomoku') { buildGomoku(box, v, mk); return; }   // 五子棋有自己的畫面（棋盤）
  if (tb?.game === 'trigon') { buildTrigon(box, v, mk, gd); return; }   // Blokus Trigon有自己的畫面（三角格棋盤＋方塊托盤）
  if (tb?.game === 'blokus') { buildBlokus(box, v, mk, gd); return; }   // Blokus有自己的畫面（棋盤＋方塊托盤）
  if (tb?.game === 'mage') { buildMage(box, v, mk, gd); return; }   // 見習驅魔師有自己的畫面（畫符號的場地）
  if (tb?.game === 'dodge') { buildDodge(box, v, mk, gd); return; }   // 躲彈幕有自己的畫面（即時場地）
  if (tb?.game === 'maze') { buildMaze(box, v, mk, gd); return; }   // 豆豆迷宮有自己的畫面（迷宮）
  if (tb?.game === 'hockey') { buildHockey(box, v, mk, gd); return; }   // 空氣曲棍球有自己的畫面（球場）
  if (tb?.game === 'uno') { buildUno(box, v, mk, gd); return; }   // UNO 有自己的畫面（牌桌）
  if (tb?.game === 'typing' || tb?.game === 'zhtyping') { buildTyping(box, v, mk, gd); return; }   // 英打／中文打字競賽有自己的畫面（題目＋分數）
  if (tb?.game === 'intel') { buildIntel(box, v, mk, gd); return; }     // 秘藥情報戰有自己的畫面（情報區＋密函）
  const playing = v.phase === 'playing', myTurn = playing && v.role === 'seat' && v.turn === v.me;
  // 狀態列
  let status;
  if (playing) status = v.role === 'spec' ? `觀戰中 · 輪到 ${v.seats[v.turn]?.name} 抽牌` : myTurn ? `輪到你：點 ${v.seats[v.target]?.name} 的一張牌抽走` : `輪到 ${v.seats[v.turn]?.name} 抽牌`;
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.appendChild(mk('div', 'table-status' + (myTurn ? ' mine' : ''), status));
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  // 座位：每個人一格（名字、狀態、牌背）；輪到我時，被抽牌的那位的牌背可以點
  const row = mk('div', 'table-seats');
  v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (s.out ? ' out' : ''));
    const tag = !playing ? (s.ready ? '已準備' : '未準備') : s.out ? '已過關' : v.turn === i ? '抽牌中' : (myTurn && v.target === i ? '被抽牌' : '');
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
    seat.appendChild(mk('div', 'table-tag', tag));
    const cards = mk('div', 'table-cards');
    const drawable = myTurn && v.target === i;
    if (playing && v.hands) for (const c of v.hands[i] || []) cards.appendChild(cardEl(c));   // 觀戰：每個人的牌都翻開
    else if (playing) for (let k = 0; k < s.n; k++) {
      const c = cardEl(null);
      if (drawable) { c.classList.add('pick'); c.title = '抽這張'; c.onclick = () => S.net?.tbl?.({ a: 'draw', idx: k }); }
      cards.appendChild(c);
    }
    seat.appendChild(cards);
    if (playing) seat.appendChild(mk('div', 'table-count', s.out ? '' : `${s.n} 張`));
    row.appendChild(seat);
  });
  for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  // 我的手牌
  if (v.role === 'seat' && playing) {
    const hand = mk('div', 'table-hand');
    hand.appendChild(mk('div', 'table-label', '你的手牌（順序就是對手看到的牌背順序：他點第幾張，抽走的就是你從左數第幾張）'));
    const cs = mk('div', 'table-cards big');
    for (const c of v.hand || []) cs.appendChild(cardEl(c));
    if (!(v.hand || []).length) cs.appendChild(mk('span', 'table-tag', '手牌出完了，安全過關！'));
    hand.appendChild(cs);
    if ((v.hand || []).length > 1) { const sh = mk('button', 'ff-btn small', '洗牌'); sh.onclick = () => S.net?.tbl?.({ a: 'shuffle' }); sh.title = '把手牌順序打亂，讓對手猜不到鬼牌在哪'; hand.appendChild(sh); }
    box.appendChild(hand);
  }
  // 按鈕
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  // 紀錄與規則
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 五子棋畫面：15×15 棋盤（canvas）；輪到自己時點交叉點下子，滑過會顯示淡淡的預覽棋子 ----
const GM_N = 15, GM_CELL = 26, GM_MARGIN = 16;   // 2026-11-13 使用者要求盤面縮小到約 80%（原本 32／20）
function gomokuDraw(cv, v, hover, rep) {   // rep＝復盤：{board, last, line, nums（到這一步為止的每一手座標，棋子上畫手數）}
  const g = cv.getContext('2d'), size = GM_MARGIN * 2 + GM_CELL * (GM_N - 1);
  g.fillStyle = '#d8a860'; g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(70,40,10,.8)'; g.lineWidth = 1;
  for (let i = 0; i < GM_N; i++) {
    const p = GM_MARGIN + i * GM_CELL + .5;
    g.beginPath(); g.moveTo(GM_MARGIN, p); g.lineTo(size - GM_MARGIN, p); g.stroke();
    g.beginPath(); g.moveTo(p, GM_MARGIN); g.lineTo(p, size - GM_MARGIN); g.stroke();
  }
  g.fillStyle = 'rgba(70,40,10,.9)';
  for (const sx of [3, 7, 11]) for (const sy of [3, 7, 11]) { g.beginPath(); g.arc(GM_MARGIN + sx * GM_CELL + .5, GM_MARGIN + sy * GM_CELL + .5, 3, 0, Math.PI * 2); g.fill(); }
  const stone = (x, y, color, alpha = 1) => {
    const cx = GM_MARGIN + x * GM_CELL + .5, cy = GM_MARGIN + y * GM_CELL + .5, r = GM_CELL * .45;
    g.globalAlpha = alpha;
    const gr = g.createRadialGradient(cx - r * .35, cy - r * .35, r * .1, cx, cy, r);
    if (color === 1) { gr.addColorStop(0, '#6a6a74'); gr.addColorStop(1, '#14141a'); } else { gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#c8c4b8'); }
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.stroke(); g.globalAlpha = 1;
  };
  const board = rep ? rep.board : (v.board || '');
  for (let i = 0; i < board.length; i++) if (board[i] !== '0') stone(i % GM_N, Math.floor(i / GM_N), Number(board[i]));
  if (rep?.nums) {   // 復盤：每顆棋子上寫第幾手
    g.font = 'bold 10px "Microsoft JhengHei"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    rep.nums.forEach(([x, y], k) => { g.fillStyle = board[y * GM_N + x] === '1' ? '#f4f0e4' : '#1e1e24'; g.fillText(String(k + 1), GM_MARGIN + x * GM_CELL + .5, GM_MARGIN + y * GM_CELL + 1); });
    g.textBaseline = 'alphabetic';
  }
  if (hover && !(board[hover.y * GM_N + hover.x] > 0)) stone(hover.x, hover.y, v.black === v.me ? 1 : 2, .45);   // 預覽：自己的顏色
  const line = rep ? rep.line : v.line, last = rep ? rep.last : v.last;
  if (line) {   // 連成五子：紅圈標出來
    g.strokeStyle = '#e8402a'; g.lineWidth = 3;
    for (const [x, y] of line) { g.beginPath(); g.arc(GM_MARGIN + x * GM_CELL + .5, GM_MARGIN + y * GM_CELL + .5, GM_CELL * .5, 0, Math.PI * 2); g.stroke(); }
  }
  if (last && !rep?.nums) { g.fillStyle = '#e8402a'; g.beginPath(); g.arc(GM_MARGIN + last[0] * GM_CELL + .5, GM_MARGIN + last[1] * GM_CELL + .5, 4, 0, Math.PI * 2); g.fill(); }   // 最後一手
  else if (last) { g.strokeStyle = '#e8402a'; g.lineWidth = 2; g.strokeRect(GM_MARGIN + last[0] * GM_CELL - GM_CELL * .4, GM_MARGIN + last[1] * GM_CELL - GM_CELL * .4, GM_CELL * .8 + 1, GM_CELL * .8 + 1); }   // 復盤：目前這一手用紅框
}
function buildGomoku(box, v, mk) {
  const playing = v.phase === 'playing', myTurn = playing && v.role === 'seat' && v.turn === v.me;
  const colorName = i => (v.black == null ? '' : i === v.black ? '黑棋' : '白棋');
  let status;
  if (playing) status = v.role === 'spec' ? `觀戰中 · 輪到 ${v.seats[v.turn]?.name}（${colorName(v.turn)}）下子` : myTurn ? `輪到你下子（${colorName(v.me)}）` : `輪到 ${v.seats[v.turn]?.name}（${colorName(v.turn)}）下子`;
  else status = v.seats.length < v.min ? `等待玩家入座（需要 ${v.min} 人）` : '雙方按「準備」就開始（開局隨機決定誰執黑）';
  box.appendChild(mk('div', 'table-status' + (myTurn ? ' mine' : ''), status));
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  const row = mk('div', 'table-seats');
  v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : ''));
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
    seat.appendChild(mk('div', 'table-tag', (v.board ? (i === v.black ? '● 黑棋' : '○ 白棋') + ' · ' : '') + (!playing ? (s.ready ? '已準備' : '未準備') : v.turn === i ? '思考中' : '')));
    row.appendChild(seat);
  });
  for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  // 復盤：對局結束後（有結果、不是中途離開）可以用上一步／下一步看剛剛的棋局；新的一局開始就回到即時畫面
  const moves = v.moves || [], canReplay = !playing && v.board && moves.length > 0;
  if (!canReplay) S.gmStep = null;
  else if (S.gmStep == null || S.gmStep > moves.length) S.gmStep = moves.length;
  let rep = null;
  if (canReplay) {
    const arr = new Array(GM_N * GM_N).fill('0');
    moves.slice(0, S.gmStep).forEach(([x, y], k) => { arr[y * GM_N + x] = k % 2 === 0 ? '1' : '2'; });   // 第 0 手＝黑棋
    rep = { board: arr.join(''), last: S.gmStep ? moves[S.gmStep - 1] : null, line: S.gmStep === moves.length ? v.line : null, nums: moves.slice(0, S.gmStep) };
  }
  if (v.board) {   // 棋盤（結束後也留著，到下一局開始才清掉）
    const size = GM_MARGIN * 2 + GM_CELL * (GM_N - 1), cv = document.createElement('canvas');
    cv.width = size; cv.height = size; cv.className = 'gomoku-board';
    gomokuDraw(cv, v, null, rep);
    const at = e => {
      const r = cv.getBoundingClientRect(), k = size / r.width;
      const x = Math.round(((e.clientX - r.left) * k - GM_MARGIN - .5) / GM_CELL), y = Math.round(((e.clientY - r.top) * k - GM_MARGIN - .5) / GM_CELL);
      return x >= 0 && x < GM_N && y >= 0 && y < GM_N ? { x, y } : null;
    };
    if (myTurn) {
      cv.classList.add('mine');
      cv.onmousemove = e => gomokuDraw(cv, v, at(e));
      cv.onmouseleave = () => gomokuDraw(cv, v, null);
      cv.onclick = e => { const p = at(e); if (p && v.board[p.y * GM_N + p.x] === '0') S.net?.tbl?.({ a: 'move', x: p.x, y: p.y }); };
    }
    box.appendChild(cv);
  }
  if (canReplay) {   // 復盤控制列（也可以用鍵盤 ← → Home End）
    const bar = mk('div', 'table-btns gomoku-replay'), N = moves.length, go = k => { S.gmStep = Math.max(0, Math.min(N, k)); buildTable(); };
    for (const [label, k, tip] of [['⏮', () => 0, '回到開局（Home）'], ['◀ 上一步', () => S.gmStep - 1, '上一步（←）']]) { const b = mk('button', 'ff-btn small', label); b.title = tip; b.onclick = () => go(k()); bar.appendChild(b); }
    const who = S.gmStep ? `${(S.gmStep - 1) % 2 === 0 ? '黑' : '白'}棋 (${moves[S.gmStep - 1][0] + 1}, ${moves[S.gmStep - 1][1] + 1})` : '開局';
    bar.appendChild(mk('span', 'table-tag', `復盤：第 ${S.gmStep}／${N} 手 · ${who}`));
    for (const [label, k, tip] of [['下一步 ▶', () => S.gmStep + 1, '下一步（→）'], ['⏭', () => N, '跳到最後一手（End）']]) { const b = mk('button', 'ff-btn small', label); b.title = tip; b.onclick = () => go(k()); bar.appendChild(b); }
    box.appendChild(bar);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  const gd = gameDef('gomoku'); if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- Blokus（第十一桌 t11；2026-11-13，使用者要求）：20×20 棋盤（canvas）＋我的方塊托盤。選方塊 → 旋轉（R／滾輪／右鍵）、翻面（F）→ 在棋盤上點一下放。
// 合法與否在本機先判（只用來顯示預覽與標出可接的角），最後以伺服器為準（和 worker 的 bkLegal 同一套規則）。棋盤、各人用掉的方塊都是公開資訊，觀戰者也看得到 ----
const BK_N = 20, BK_CELL = 24, BK_TURN_SEC = 45;
const BK_SHAPES = [['#'], ['##'], ['###'], ['##', '#.'], ['####'], ['##', '##'], ['###', '.#.'], ['###', '#..'], ['.##', '##.'],
  ['.##', '##.', '.#.'], ['#####'], ['####', '#...'], ['##..', '.###'], ['##', '##', '#.'], ['###', '.#.', '.#.'], ['#.#', '###'],
  ['#..', '#..', '###'], ['#..', '##.', '.##'], ['.#.', '###', '.#.'], ['####', '.#..'], ['##.', '.#.', '.##']];   // 與兩份伺服器同一組 21 塊
const BK_PC = BK_SHAPES.map(rows => { const c = []; rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') c.push([x, y]); })); return c; });
const BK_CORNERS = [[0, 0], [BK_N - 1, 0], [BK_N - 1, BK_N - 1], [0, BK_N - 1]];
const BK_COL = ['#3b78e8', '#f0c020', '#e04848', '#3cb45a'], BK_CNAME = ['藍', '黃', '紅', '綠'];
const BK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]], BK_DIAGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
// 第 p 塊轉 rot 次（每次 90 度）、flip＝先左右翻面；回傳 {cells（左上對齊）, pv（滑鼠指著的那一格＝最靠近中心的格）}
function bkShape(p, rot, flip) {
  let c = BK_PC[p].map(([x, y]) => [flip ? -x : x, y]);
  for (let i = 0; i < rot; i++) c = c.map(([x, y]) => [-y, x]);
  const mx = Math.min(...c.map(q => q[0])), my = Math.min(...c.map(q => q[1]));
  c = c.map(([x, y]) => [x - mx, y - my]);
  const cx = c.reduce((a, q) => a + q[0], 0) / c.length, cy = c.reduce((a, q) => a + q[1], 0) / c.length;
  let pv = c[0], best = 1e9;
  for (const q of c) { const d = (q[0] - cx) ** 2 + (q[1] - cy) ** 2; if (d < best) { best = d; pv = q; } }
  return { cells: c, pv };
}
const bkAt = (b, x, y, n = BK_N) => (x >= 0 && y >= 0 && x < n && y < n ? b[y * n + x] : '#');   // 出界回 '#'
// 2 人局是 Blokus Duo（14×14、起始格 (4, 4)／(9, 9)），3～4 人是 20×20、四個角落：大小與各座位的起始格由伺服器隨 v.bk 給（舊版伺服器沒給就當 20×20、角落）
const bkN = v => v.bk.size || BK_N, bkStartOf = (v, k) => v.bk.start?.[k] || BK_CORNERS[v.bk.col[k]], bkCellPx = v => (bkN(v) <= 14 ? 32 : BK_CELL);
function bkLegalC(v, cells) {   // 我（座位 v.me）放這些格子（絕對座標）合不合法
  const b = v.bk.board, N = bkN(v), ci = v.bk.col[v.me], col = String(ci + 1), first = v.bk.used[v.me].length === 0, [sx, sy] = bkStartOf(v, v.me);
  let corner = false, start = false;
  for (const [x, y] of cells) {
    if (bkAt(b, x, y, N) !== '0') return false;
    if (x === sx && y === sy) start = true;
    for (const [dx, dy] of BK_DIRS) if (bkAt(b, x + dx, y + dy, N) === col) return false;
    for (const [dx, dy] of BK_DIAGS) if (bkAt(b, x + dx, y + dy, N) === col) corner = true;
  }
  return first ? start : corner;
}
function bkAnchors(v) {   // 我下一塊可以接的角（空格、斜對角有我的方塊、四邊沒有我的方塊）；第一塊就是起始角落
  const b = v.bk.board, N = bkN(v), ci = v.bk.col[v.me], col = String(ci + 1), out = [];
  if (v.bk.used[v.me].length === 0) { const [sx, sy] = bkStartOf(v, v.me); return bkAt(b, sx, sy, N) === '0' ? [[sx, sy]] : []; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y * N + x] !== '0') continue;
    if (BK_DIRS.some(([dx, dy]) => bkAt(b, x + dx, y + dy, N) === col)) continue;
    if (BK_DIAGS.some(([dx, dy]) => bkAt(b, x + dx, y + dy, N) === col)) out.push([x, y]);
  }
  return out;
}
function bkPreview(v) {   // 目前選的方塊放在滑鼠位置的格子；沒有選或滑鼠不在棋盤上回 null
  const o = S.bk;
  if (!o || o.sel == null || o.hx == null) return null;
  const { cells, pv } = bkShape(o.sel, o.rot, o.flip), abs = cells.map(([x, y]) => [x - pv[0] + o.hx, y - pv[1] + o.hy]);
  return { cells: abs, ok: bkLegalC(v, abs) };
}
function bkDraw(cv, v) {
  const g = cv.getContext('2d'), N = bkN(v), C = bkCellPx(v), size = N * C, b = v.bk.board;
  g.fillStyle = '#141a2a'; g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
  for (let i = 0; i <= N; i++) { g.beginPath(); g.moveTo(i * C + .5, 0); g.lineTo(i * C + .5, size); g.stroke(); g.beginPath(); g.moveTo(0, i * C + .5); g.lineTo(size, i * C + .5); g.stroke(); }
  v.bk.col.forEach((ci, k) => {   // 各色的起始格（角落或 Duo 的 (4, 4)／(9, 9)）：淡淡的色框
    const [sx, sy] = bkStartOf(v, k); g.strokeStyle = BK_COL[ci]; g.globalAlpha = .55; g.lineWidth = 2; g.strokeRect(sx * C + 2, sy * C + 2, C - 4, C - 4); g.globalAlpha = 1;
  });
  for (let i = 0; i < b.length; i++) {
    if (b[i] === '0') continue;
    const x = i % N, y = Math.floor(i / N);
    g.fillStyle = BK_COL[Number(b[i]) - 1]; g.fillRect(x * C + 1, y * C + 1, C - 1, C - 1);
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x * C + 1, y * C + 1, C - 1, 3); g.fillRect(x * C + 1, y * C + 1, 3, C - 1);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x * C + 1, y * C + C - 3, C - 1, 2); g.fillRect(x * C + C - 3, y * C + 1, 2, C - 1);
  }
  if (v.bk.last) {   // 最後一手：白框
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    for (const [x, y] of v.bk.last.cells) g.strokeRect(x * C + 2, y * C + 2, C - 3, C - 3);
  }
  const seat = v.phase === 'playing' && v.role === 'seat', mine = seat && v.turn === v.me;
  if (mine) {   // 輪到我：可以接的角用小圓點標出來
    g.fillStyle = 'rgba(255,255,255,.55)';
    for (const [x, y] of bkAnchors(v)) { g.beginPath(); g.arc(x * C + C / 2 + .5, y * C + C / 2 + .5, 3, 0, Math.PI * 2); g.fill(); }
  }
  const pv = seat ? bkPreview(v) : null;
  if (pv) {   // 預覽：合法＝我的顏色半透明＋白邊；不合法＝紅色
    g.globalAlpha = .7; g.fillStyle = pv.ok ? BK_COL[v.bk.col[v.me]] : '#ff3030';
    for (const [x, y] of pv.cells) if (x >= 0 && y >= 0 && x < N && y < N) g.fillRect(x * C + 1, y * C + 1, C - 1, C - 1);
    g.globalAlpha = 1;
    if (pv.ok) { g.strokeStyle = '#fff'; g.lineWidth = 2; for (const [x, y] of pv.cells) g.strokeRect(x * C + 2, y * C + 2, C - 3, C - 3); }
  }
}
function bkPieceCanvas(p, color, rot, flip) {   // 托盤裡的小圖（5×5 格的框）
  const cv = document.createElement('canvas'), K = 9, { cells } = bkShape(p, rot, flip);
  cv.width = K * 5; cv.height = K * 5;
  const g = cv.getContext('2d'), w = Math.max(...cells.map(c => c[0])) + 1, h = Math.max(...cells.map(c => c[1])) + 1, ox = Math.floor((5 - w) * K / 2), oy = Math.floor((5 - h) * K / 2);
  g.fillStyle = color;
  for (const [x, y] of cells) { g.fillRect(ox + x * K, oy + y * K, K - 1, K - 1); }
  return cv;
}
function bkStopTimer() { if (S.bkTimer) { clearInterval(S.bkTimer); S.bkTimer = 0; } }
function bkStartTimer(v) {
  bkStopTimer();
  S.bkOff = (v.bk || v.tg).sn - Date.now();   // 伺服器時間 − 本機時間（毫秒，忽略單程延遲）
  S.bkTimer = setInterval(() => {
    const cur = S.tableView;
    if (!S.tableOpen || !cur || (cur.game !== 'blokus' && cur.game !== 'trigon') || cur.phase !== 'playing') { bkStopTimer(); return; }
    const left = ((cur.bk || cur.tg).deadline - (Date.now() + S.bkOff)) / 1000;
    const el = $('bkTimer'); if (el) { el.textContent = left > 0 ? `${Math.ceil(left)} 秒` : '時間到'; el.classList.toggle('urgent', left <= 10); }
    if (left <= 0 && cur.role === 'seat' && Date.now() - (S.bkTimeoutAt || 0) > 1000) { S.bkTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }
  }, 250);
}
function bkHint(text) {   // 放不下的提示（遊戲畫面蓋住了 toast，所以放在托盤下面）
  const el = $('bkMsg'); if (!el) return;
  el.textContent = text; clearTimeout(S.bkMsgT); S.bkMsgT = setTimeout(() => { el.textContent = ''; }, 3500);
}
function bkSelect(p) {   // 選方塊；再點一次已選的＝旋轉
  const o = (S.bk ||= { sel: null, rot: 0, flip: false, hx: null, hy: null });
  if (o.sel === p) o.rot = (o.rot + 1) % 4; else { o.sel = p; o.rot = 0; o.flip = false; }
  buildTable();
}
function bkRotate(d) { const o = S.bk; if (!o || o.sel == null) return; o.rot = (o.rot + d + 4) % 4; buildTable(); }
function bkFlip() { const o = S.bk; if (!o || o.sel == null) return; o.flip = !o.flip; buildTable(); }
function bkKey(e) {   // 遊戲畫面開著且在玩Blokus：R 旋轉、F 翻面
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); bkRotate(e.shiftKey ? -1 : 1); } else if (k === 'f') { e.preventDefault(); bkFlip(); }
}
function buildBlokus(box, v, mk, gd) {
  const playing = v.phase === 'playing', seat = v.role === 'seat', myTurn = playing && seat && v.turn === v.me, bk = v.bk;
  if (!playing) bkStopTimer();
  const o = (S.bk ||= { sel: null, rot: 0, flip: false, hx: null, hy: null });
  if (!playing || !seat || (o.sel != null && bk.used[v.me]?.includes(o.sel))) { o.sel = null; o.hx = o.hy = null; }   // 用掉的方塊／不是我的局：取消選取
  const cname = k => BK_CNAME[bk.col[k]];
  let status;
  if (playing) {
    const who = v.seats[v.turn]?.name;
    status = !seat ? `觀戰中 · 輪到 ${who}（${cname(v.turn)}）` : myTurn ? `輪到你（${cname(v.me)}）：選一塊方塊，點棋盤放下` : `輪到 ${who}（${cname(v.turn)}）`;
  } else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始（每手限時 45 秒）';
  const st = mk('div', 'table-status' + (myTurn ? ' mine' : ''), status);
  if (playing) { const tm = mk('span', 'bk-timer'); tm.id = 'bkTimer'; st.appendChild(tm); }
  box.appendChild(st);
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  // 座位
  const row = mk('div', 'table-seats bk-seats');
  v.seats.forEach((s, i) => {
    const seatEl = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (playing && (s.left || bk.done[i]) ? ' out' : ''));
    const nameEl = mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : ''));
    if (playing) { const sw = mk('span', 'bk-swatch'); sw.style.background = BK_COL[bk.col[i]]; nameEl.prepend(sw); }
    seatEl.appendChild(nameEl);
    seatEl.appendChild(mk('div', 'table-tag', playing ? `${cname(i)} · 剩 ${s.rem} 格${s.left ? '' : bk.done[i] ? ' · 無處可放' : v.turn === i ? ' · 思考中' : ''}` : (s.ready ? '已準備' : '未準備')));
    row.appendChild(seatEl);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  // 上一局的成績
  if (!playing && v.result?.players) {
    const sc = mk('div', 'bk-score');
    [...v.result.players].map((p, k) => ({ p, k })).sort((a, b) => b.p.score - a.p.score).forEach(({ p, k }) => {
      const line = mk('div', 'bk-score-line' + (v.result.winners.includes(k) ? ' win' : ''));
      const sw = mk('span', 'bk-swatch'); sw.style.background = BK_COL[p.col]; line.appendChild(sw);
      line.appendChild(document.createTextNode(`${p.name}${p.left ? '（離開）' : p.forfeit ? '（棄權）' : ''}　剩 ${p.rem} 格${p.rem === 0 ? '，全部放完' : ''}　${p.score} 分`));
      sc.appendChild(line);
    });
    box.appendChild(sc);
  }
  // 棋盤＋托盤
  if (bk) {
    const main = mk('div', 'bk-main'), CP = bkCellPx(v), size = bkN(v) * CP, cv = document.createElement('canvas');
    cv.width = size; cv.height = size; cv.className = 'bk-board' + (myTurn ? ' mine' : '');
    bkDraw(cv, v);
    if (playing && seat) {
      const at = e => { const r = cv.getBoundingClientRect(), k = size / r.width; return { x: Math.floor((e.clientX - r.left) * k / CP), y: Math.floor((e.clientY - r.top) * k / CP) }; };
      cv.onmousemove = e => { const p = at(e); if (p.x !== o.hx || p.y !== o.hy) { o.hx = p.x; o.hy = p.y; bkDraw(cv, v); } };
      cv.onmouseleave = () => { o.hx = o.hy = null; bkDraw(cv, v); };
      cv.onwheel = e => { if (o.sel == null) return; e.preventDefault(); bkRotate(e.deltaY > 0 ? 1 : -1); };
      cv.oncontextmenu = e => { e.preventDefault(); bkRotate(1); };
      cv.onclick = e => {
        if (!myTurn || o.sel == null) return;
        const p = at(e); o.hx = p.x; o.hy = p.y;
        const pv = bkPreview(v);
        if (!pv) return;
        if (!pv.ok) { bkHint('這裡放不下：要角對角接到自己的方塊、不能邊對邊（第一塊要蓋住自己的角落）'); return; }
        S.net?.tbl?.({ a: 'place', p: o.sel, c: pv.cells });
        o.sel = null; o.hx = o.hy = null; buildTable();
      };
    }
    main.appendChild(cv);
    if (seat && playing) {
      const side = mk('div', 'bk-side'), used = bk.used[v.me] || [], ci = bk.col[v.me];
      side.appendChild(mk('div', 'table-label', `你的方塊（${BK_CNAME[ci]}）：點選 → 滑到棋盤上 → 點一下放下`));
      const tray = mk('div', 'bk-tray');
      for (let p = 0; p < BK_PC.length; p++) {
        const isUsed = used.includes(p), el = mk('div', 'bk-pc' + (isUsed ? ' used' : '') + (o.sel === p ? ' sel' : ''));
        el.appendChild(bkPieceCanvas(p, BK_COL[ci], o.sel === p ? o.rot : 0, o.sel === p ? o.flip : false));
        if (!isUsed) el.onclick = () => bkSelect(p);
        tray.appendChild(el);
      }
      side.appendChild(tray);
      const ctl = mk('div', 'table-btns');
      const rb = mk('button', 'ff-btn small', '↻ 旋轉（R／滾輪／右鍵）'), fb = mk('button', 'ff-btn small', '⇋ 翻面（F）');
      rb.onclick = () => bkRotate(1); fb.onclick = () => bkFlip(); rb.disabled = fb.disabled = o.sel == null;
      ctl.appendChild(rb); ctl.appendChild(fb); side.appendChild(ctl);
      side.appendChild(mk('div', 'table-tag', '圓點是你可以接的角。連續兩次超時會視為棄權。'));
      const hint = mk('div', 'bk-msg'); hint.id = 'bkMsg'; side.appendChild(hint);
      main.appendChild(side);
    }
    box.appendChild(main);
    if (playing) bkStartTimer(v);
  }
  const btns = mk('div', 'table-btns');
  if (seat && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const sb = mk('button', 'ff-btn small', '改為觀戰'); sb.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(sb);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- Blokus Trigon（第十二桌 t12；2026-11-13，使用者要求）：正六邊形的三角格棋盤（邊長 9，486 格）＋我的方塊托盤（22 塊，1～6 個三角形）。
// 操作同Blokus：點選方塊 → 旋轉 60 度（R／滾輪／右鍵）、翻面（F）→ 在棋盤上點一下放。座標系與規則同 worker 的 tg*（三角形 (x, y)，(x + y) 偶數＝朝上；頂點 (i, j)，i + j 偶數）。
// 滑鼠指到的是「最近的格點（頂點）」，方塊上最靠近中心的那個頂點對齊它——頂點之間的平移一定保持三角形的方向，所以不用管朝上朝下 ----
const TG_N = 9, TG_CX = 19, TG_W = 39, TG_ROWS = 18, TG_S = 26, TG_MARGIN = 14;   // TG_S：三角形邊長（像素）
const TG_PIECES = [[[0,0]],[[0,0],[0,1]],[[0,0],[-1,1],[0,1]],[[0,0],[-1,1],[0,1],[-1,2]],[[0,0],[-1,1],[0,1],[1,1]],[[0,0],[-2,1],[-1,1],[0,1]],[[0,0],[-1,1],[0,1],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2]],[[0,0],[1,0],[0,1],[1,1],[2,1]],[[0,0],[-1,1],[0,1],[-1,2],[0,2],[0,3]],[[0,0],[-1,1],[0,1],[-1,2],[0,2],[1,2]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2],[-2,3]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[-3,2],[-2,2],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2],[1,2]],[[0,0],[-1,1],[0,1],[1,1],[2,1],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[2,1],[1,2]],[[0,0],[-2,1],[-1,1],[0,1],[-2,2],[-1,2]],[[0,0],[-3,1],[-2,1],[-1,1],[0,1],[-3,2]],[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]]];   // 與兩份伺服器同一份：22 塊 polyiamond（三角形的 [x, y]，已正規化）
const TG_CORNERS = [[TG_CX - TG_N, 0], [TG_CX + TG_N, 0], [TG_CX + 2 * TG_N, TG_N], [TG_CX + TG_N, 2 * TG_N], [TG_CX - TG_N, 2 * TG_N], [TG_CX - 2 * TG_N, TG_N]];
const tgVerts = (x, y) => (((x + y) & 1) === 0 ? [[x, y], [x - 1, y + 1], [x + 1, y + 1]] : [[x - 1, y], [x + 1, y], [x, y + 1]]);
const tgLeft = j => (j <= TG_N ? TG_CX - TG_N - j : TG_CX - 3 * TG_N + j), tgRight = j => (j <= TG_N ? TG_CX + TG_N + j : TG_CX + 3 * TG_N - j);
const tgInV = (i, j) => j >= 0 && j <= 2 * TG_N && i >= tgLeft(j) && i <= tgRight(j);
const tgCellOk = (x, y) => x >= 0 && x < TG_W && y >= 0 && y < TG_ROWS && tgVerts(x, y).every(([i, j]) => tgInV(i, j));
const tgEdge = (x, y) => [[x - 1, y], [x + 1, y], [x, ((x + y) & 1) === 0 ? y + 1 : y - 1]];
const tgAround = (i, j) => [[i, j], [i + 1, j - 1], [i - 1, j - 1], [i + 1, j], [i - 1, j], [i, j - 1]];   // 共用頂點 (i, j) 的 6 個三角形
function tgFromVerts(vs) {
  const jm = Math.min(...vs.map(v => v[1])), top = vs.filter(v => v[1] === jm);
  return top.length === 2 ? [vs.find(v => v[1] !== jm)[0], jm] : [top[0][0], jm];
}
function tgXform(c, rot, flip) {   // 轉 rot × 60 度、flip＝左右翻面
  return tgFromVerts(tgVerts(c[0], c[1]).map(([i, j]) => {
    let a = (i - j) / 2, b = j;
    for (let r = 0; r < rot; r++) [a, b] = [-b, a + b];
    if (flip) [a, b] = [-a - b, b];
    return [2 * a + b, b];
  }));
}
// 第 p 塊轉 rot、翻面 flip 之後：回傳 {cells（平移保持方向後的三角形）, pv（對齊滑鼠的頂點：最靠近中心的那個）}
function tgShape(p, rot, flip) {
  const c = TG_PIECES[p].map(q => tgXform(q, rot, flip));
  const vs = new Map(); let cx = 0, cy = 0;
  for (const [x, y] of c) { const vv = tgVerts(x, y); cx += (vv[0][0] + vv[1][0] + vv[2][0]) / 3; cy += (vv[0][1] + vv[1][1] + vv[2][1]) / 3 * Math.sqrt(3); for (const [i, j] of vv) vs.set(i + ',' + j, [i, j]); }
  cx /= c.length; cy /= c.length;
  let pv = null, best = 1e9;
  for (const [i, j] of [...vs.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) { const d = (i - cx) ** 2 + (j * Math.sqrt(3) - cy) ** 2; if (d < best - 1e-9) { best = d; pv = [i, j]; } }
  return { cells: c, pv };
}
const tgAt = (b, x, y) => (tgCellOk(x, y) ? b[y * TG_W + x] : '#');   // 不在棋盤上回 '#'
function tgLegalC(v, cells) {   // 我（座位 v.me）放這些格子（絕對座標）合不合法
  const b = v.tg.board, ci = v.tg.col[v.me], col = String(ci + 1), first = v.tg.used[v.me].length === 0, [sx, sy] = TG_CORNERS[v.tg.corner[v.me]];
  let touch = false, start = false;
  for (const [x, y] of cells) {
    if (tgAt(b, x, y) !== '0') return false;
    for (const [a, c] of tgEdge(x, y)) if (tgAt(b, a, c) === col) return false;
    for (const [i, j] of tgVerts(x, y)) {
      if (i === sx && j === sy) start = true;
      if (!touch) for (const [a, c] of tgAround(i, j)) if ((a !== x || c !== y) && tgAt(b, a, c) === col) touch = true;
    }
  }
  return first ? start : touch;
}
function tgAnchors(v) {   // 我下一塊可以接的格子（空格、和我的方塊共用頂點、四邊沒有我的方塊）；第一塊就是自己頂點旁的格子
  const b = v.tg.board, col = String(v.tg.col[v.me] + 1), out = [], seen = new Set();
  if (v.tg.used[v.me].length === 0) { const [sx, sy] = TG_CORNERS[v.tg.corner[v.me]]; return tgAround(sx, sy).filter(([x, y]) => tgAt(b, x, y) === '0'); }
  for (let y = 0; y < TG_ROWS; y++) for (let x = 0; x < TG_W; x++) {
    if (b[y * TG_W + x] !== col) continue;
    for (const [i, j] of tgVerts(x, y)) for (const [a, c] of tgAround(i, j)) {
      if (tgAt(b, a, c) !== '0' || seen.has(a + ',' + c)) continue;
      seen.add(a + ',' + c);
      if (tgEdge(a, c).some(([e, f]) => tgAt(b, e, f) === col)) continue;
      out.push([a, c]);
    }
  }
  return out;
}
const tgPx = (i, j) => [TG_MARGIN + i * TG_S / 2 - (TG_CX - 2 * TG_N) * TG_S / 2, TG_MARGIN + j * TG_S * Math.sqrt(3) / 2];   // 頂點 → 畫面座標（左邊界對齊 TG_MARGIN）
const TG_CW = TG_MARGIN * 2 + 4 * TG_N * TG_S / 2, TG_CH = Math.ceil(TG_MARGIN * 2 + 2 * TG_N * TG_S * Math.sqrt(3) / 2);
function tgPreview(v) {
  const o = S.tg;
  if (!o || o.sel == null || o.hi == null) return null;
  const { cells, pv } = tgShape(o.sel, o.rot, o.flip), dx = o.hi - pv[0], dy = o.hj - pv[1], abs = cells.map(([x, y]) => [x + dx, y + dy]);
  return { cells: abs, ok: tgLegalC(v, abs) };
}
function tgTri(g, x, y) { const vv = tgVerts(x, y); g.beginPath(); vv.forEach(([i, j], k) => { const [px, py] = tgPx(i, j); if (k) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); }
function tgDraw(cv, v) {
  const g = cv.getContext('2d'), b = v.tg.board;
  g.fillStyle = '#141a2a'; g.fillRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < TG_ROWS; y++) for (let x = 0; x < TG_W; x++) {   // 棋盤：每格一個三角形，格線淡淡的
    if (!tgCellOk(x, y)) continue;
    const c = b[y * TG_W + x];
    tgTri(g, x, y);
    g.fillStyle = c === '0' ? ((x + y) & 1 ? '#1a2136' : '#182033') : BK_COL[Number(c) - 1]; g.fill();
    g.strokeStyle = c === '0' ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke();
  }
  v.tg.col.forEach((ci, k) => {   // 各色的起始頂點：該色的圓點
    const [px, py] = tgPx(...TG_CORNERS[v.tg.corner[k]]);
    g.fillStyle = BK_COL[ci]; g.globalAlpha = .9; g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
  });
  if (v.tg.last) { g.strokeStyle = '#fff'; g.lineWidth = 2; for (const [x, y] of v.tg.last.cells) { tgTri(g, x, y); g.stroke(); } }
  const seat = v.phase === 'playing' && v.role === 'seat', mine = seat && v.turn === v.me;
  if (mine) {   // 輪到我：可以接的格子用小圓點標出來
    g.fillStyle = 'rgba(255,255,255,.6)';
    for (const [x, y] of tgAnchors(v)) { const vv = tgVerts(x, y), cx = vv.reduce((a, q) => a + tgPx(...q)[0], 0) / 3, cy = vv.reduce((a, q) => a + tgPx(...q)[1], 0) / 3; g.beginPath(); g.arc(cx, cy, 2.5, 0, Math.PI * 2); g.fill(); }
  }
  const pv = seat ? tgPreview(v) : null;
  if (pv) {   // 預覽：合法＝我的顏色半透明＋白邊；不合法＝紅色
    for (const [x, y] of pv.cells) { if (!tgCellOk(x, y)) continue; tgTri(g, x, y); g.globalAlpha = .72; g.fillStyle = pv.ok ? BK_COL[v.tg.col[v.me]] : '#ff3030'; g.fill(); g.globalAlpha = 1; if (pv.ok) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); } }
  }
}
function tgPieceCanvas(p, color, rot, flip) {   // 托盤裡的小圖
  const cv = document.createElement('canvas'), { cells } = tgShape(p, rot, flip), W = 64, H = 54, pts = [];
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of cells) for (const [i, j] of tgVerts(x, y)) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
  const sc = Math.min((W - 6) / ((x1 - x0) || 1), (H - 6) / (((y1 - y0) * Math.sqrt(3)) || 1), 6.5), ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * Math.sqrt(3) * sc) / 2;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = color; g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1;
  for (const [x, y] of cells) { g.beginPath(); tgVerts(x, y).forEach(([i, j], k) => { const px = ox + (i - x0) * sc, py = oy + (j - y0) * Math.sqrt(3) * sc; if (k) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); g.fill(); g.stroke(); }
  return cv;
}
function tgSelect(p) {   // 選方塊；再點一次已選的＝旋轉
  const o = (S.tg ||= { sel: null, rot: 0, flip: false, hi: null, hj: null });
  if (o.sel === p) o.rot = (o.rot + 1) % 6; else { o.sel = p; o.rot = 0; o.flip = false; }
  buildTable();
}
function tgRotate(d) { const o = S.tg; if (!o || o.sel == null) return; o.rot = (o.rot + d + 6) % 6; buildTable(); }
function tgFlip() { const o = S.tg; if (!o || o.sel == null) return; o.flip = !o.flip; buildTable(); }
function tgKey(e) {   // 遊戲畫面開著且在玩Blokus Trigon：R 旋轉、F 翻面
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); tgRotate(e.shiftKey ? -1 : 1); } else if (k === 'f') { e.preventDefault(); tgFlip(); }
}
function tgNearestVertex(px, py) {   // 畫面座標 → 最近的格點 (i, j)（i + j 為偶數）
  const u = (px - TG_MARGIN) / (TG_S / 2) + (TG_CX - 2 * TG_N), jf = (py - TG_MARGIN) / (TG_S * Math.sqrt(3) / 2);
  let best = null, bd = 1e9;
  for (let j = Math.floor(jf) - 1; j <= Math.ceil(jf) + 1; j++) for (let i = Math.floor(u) - 2; i <= Math.ceil(u) + 2; i++) {
    if (((i + j) & 1) !== 0) continue;
    const d = (i - u) ** 2 + ((j - jf) * Math.sqrt(3)) ** 2;
    if (d < bd) { bd = d; best = [i, j]; }
  }
  return best;
}
function buildTrigon(box, v, mk, gd) {
  const playing = v.phase === 'playing', seat = v.role === 'seat', myTurn = playing && seat && v.turn === v.me, tg = v.tg;
  if (!playing) bkStopTimer();
  const o = (S.tg ||= { sel: null, rot: 0, flip: false, hi: null, hj: null });
  if (!playing || !seat || (o.sel != null && tg.used[v.me]?.includes(o.sel))) { o.sel = null; o.hi = o.hj = null; }   // 用掉的方塊／不是我的局：取消選取
  const cname = k => BK_CNAME[tg.col[k]];
  let status;
  if (playing) {
    const who = v.seats[v.turn]?.name;
    status = !seat ? `觀戰中 · 輪到 ${who}（${cname(v.turn)}）` : myTurn ? `輪到你（${cname(v.me)}）：選一塊方塊，點棋盤放下` : `輪到 ${who}（${cname(v.turn)}）`;
  } else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始（每手限時 45 秒）';
  const st = mk('div', 'table-status' + (myTurn ? ' mine' : ''), status);
  if (playing) { const tm = mk('span', 'bk-timer'); tm.id = 'bkTimer'; st.appendChild(tm); }
  box.appendChild(st);
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  const row = mk('div', 'table-seats bk-seats');
  v.seats.forEach((s, i) => {
    const seatEl = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (playing && (s.left || tg.done[i]) ? ' out' : ''));
    const nameEl = mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : ''));
    if (playing) { const sw = mk('span', 'bk-swatch'); sw.style.background = BK_COL[tg.col[i]]; nameEl.prepend(sw); }
    seatEl.appendChild(nameEl);
    seatEl.appendChild(mk('div', 'table-tag', playing ? `${cname(i)} · 剩 ${s.rem} 格${s.left ? '' : tg.done[i] ? ' · 無處可放' : v.turn === i ? ' · 思考中' : ''}` : (s.ready ? '已準備' : '未準備')));
    row.appendChild(seatEl);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  if (!playing && v.result?.players) {   // 上一局的成績
    const sc = mk('div', 'bk-score');
    [...v.result.players].map((p, k) => ({ p, k })).sort((a, b) => b.p.score - a.p.score).forEach(({ p, k }) => {
      const line = mk('div', 'bk-score-line' + (v.result.winners.includes(k) ? ' win' : ''));
      const sw = mk('span', 'bk-swatch'); sw.style.background = BK_COL[p.col]; line.appendChild(sw);
      line.appendChild(document.createTextNode(`${p.name}${p.left ? '（離開）' : p.forfeit ? '（棄權）' : ''}　剩 ${p.rem} 格${p.rem === 0 ? '，全部放完' : ''}　${p.score} 分`));
      sc.appendChild(line);
    });
    box.appendChild(sc);
  }
  if (tg) {   // 棋盤＋托盤
    const main = mk('div', 'bk-main'), cv = document.createElement('canvas');
    cv.width = TG_CW; cv.height = TG_CH; cv.className = 'bk-board' + (myTurn ? ' mine' : '');
    tgDraw(cv, v);
    if (playing && seat) {
      const at = e => { const r = cv.getBoundingClientRect(), k = TG_CW / r.width; return tgNearestVertex((e.clientX - r.left) * k, (e.clientY - r.top) * k); };
      cv.onmousemove = e => { const p = at(e); if (p && (p[0] !== o.hi || p[1] !== o.hj)) { o.hi = p[0]; o.hj = p[1]; tgDraw(cv, v); } };
      cv.onmouseleave = () => { o.hi = o.hj = null; tgDraw(cv, v); };
      cv.onwheel = e => { if (o.sel == null) return; e.preventDefault(); tgRotate(e.deltaY > 0 ? 1 : -1); };
      cv.oncontextmenu = e => { e.preventDefault(); tgRotate(1); };
      cv.onclick = e => {
        if (!myTurn || o.sel == null) return;
        const p = at(e); if (!p) return;
        o.hi = p[0]; o.hj = p[1];
        const pv = tgPreview(v);
        if (!pv) return;
        if (!pv.ok) { bkHint('這裡放不下：要「點對點」接到自己的方塊、不能邊對邊（第一塊要蓋住自己的頂點圓點）'); return; }
        S.net?.tbl?.({ a: 'place', p: o.sel, c: pv.cells });
        o.sel = null; o.hi = o.hj = null; buildTable();
      };
    }
    main.appendChild(cv);
    if (seat && playing) {
      const side = mk('div', 'bk-side'), used = tg.used[v.me] || [], ci = tg.col[v.me];
      side.appendChild(mk('div', 'table-label', `你的方塊（${BK_CNAME[ci]}）：點選 → 滑到棋盤上 → 點一下放下`));
      const tray = mk('div', 'bk-tray tg-tray');
      for (let p = 0; p < TG_PIECES.length; p++) {
        const isUsed = used.includes(p), el = mk('div', 'bk-pc' + (isUsed ? ' used' : '') + (o.sel === p ? ' sel' : ''));
        el.appendChild(tgPieceCanvas(p, BK_COL[ci], o.sel === p ? o.rot : 0, o.sel === p ? o.flip : false));
        if (!isUsed) el.onclick = () => tgSelect(p);
        tray.appendChild(el);
      }
      side.appendChild(tray);
      const ctl = mk('div', 'table-btns');
      const rb = mk('button', 'ff-btn small', '↻ 旋轉 60°（R／滾輪／右鍵）'), fb = mk('button', 'ff-btn small', '⇋ 翻面（F）');
      rb.onclick = () => tgRotate(1); fb.onclick = () => tgFlip(); rb.disabled = fb.disabled = o.sel == null;
      ctl.appendChild(rb); ctl.appendChild(fb); side.appendChild(ctl);
      side.appendChild(mk('div', 'table-tag', '大圓點是各色的起始頂點，小圓點是你可以接的格子。連續兩次超時會視為棄權。'));
      const hint = mk('div', 'bk-msg'); hint.id = 'bkMsg'; side.appendChild(hint);
      main.appendChild(side);
    }
    box.appendChild(main);
    if (playing) bkStartTimer(v);
  }
  const btns = mk('div', 'table-btns');
  if (seat && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const sb = mk('button', 'ff-btn small', '改為觀戰'); sb.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(sb);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 躲彈幕（第五桌 t5）：即時遊戲。彈幕由「伺服器給的 seed＋開始時間 t0」決定性地在每個畫面各自產生（所有人看到的彈幕一樣，不用同步彈幕）；
// 自己的移動與碰撞在本機算，被打到回報 hit，命數／淘汰／評分以伺服器為準；其他人的位置由 tpos 訊息轉發（約 8 次／秒，客戶端內插）----
const DG_W = 640, DG_H = 400, DG_PLAYER_R = 5, DG_SPEED = 190, DG_INV = 1.5;
const DG_COLORS = ['#7ae8d0', '#ffb347', '#a8c8ff', '#ff8ab8', '#c8f070', '#d8a8ff', '#ffe08a', '#8affb8'];
const DG_KEYS = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
// 決定性的彈幕產生器：同一個 seed 永遠產生同一批彈幕。彈幕＝{ts（出現時間 s）, x0, y0, vx, vy, r, c（顏色編號 0～2）}，位置＝起點＋速度×(t−ts)
// 所有彈幕一律從場外出發（2026-11-08，使用者要求）：起點都在場地外，才不會剛好出在玩家身上來不及躲
const DG_BULLET_SPEED = 1.25;   // 彈幕速度倍率（使用者要求比原本快約 1.25 倍）
const DG_BULLET_COLORS = [['#ff5a5a', '#ffe0d0'], ['#ffb347', '#fff2c8'], ['#5ab8ff', '#d8f0ff'], ['#c070ff', '#f3d8ff']];   // 第 4 種（紫）＝準星道具的子彈（只會打到別人）；   // 三種顏色：紅、橘黃、藍（外圈、內點）；只是好看，不影響判定
function dodgeGen(seed) {
  const rng = mulberry32(seed >>> 0);
  const rnd = (a, b) => a + rng() * (b - a), pick = n => Math.floor(rng() * n);
  const bullets = []; let tw = 2.5;   // 第一波出現的時間（開局後 2.5 秒，讓大家先站好）
  const add = (ts, x0, y0, vx, vy, r, c) => bullets.push({ ts, x0, y0, vx, vy, r: r || 4, c });
  const cx = DG_W / 2, cy = DG_H / 2, OUT = 16;
  // 場外的發射點：side 0 上、1 右、2 下、3 左；u（0～1）＝沿那一邊的位置；回傳 {x, y, a}（a＝從發射點朝場地中心的角度）
  const edge = (side, u) => {
    const x = side === 1 ? DG_W + OUT : side === 3 ? -OUT : u * DG_W, y = side === 0 ? -OUT : side === 2 ? DG_H + OUT : u * DG_H;
    return { x, y, a: Math.atan2(cy - y, cx - x) };
  };
  return {
    bullets,
    fill(until) {   // 產生到時間 until（秒）為止的彈幕；隨時間加快、變密
      while (tw < until) {
        const d = Math.min(1, tw / 300), sp = (70 + 110 * d) * DG_BULLET_SPEED, kind = pick(4), c = pick(3);
        if (kind === 0) {   // 扇形：從場外一點朝場內散開
          const e = edge(pick(4), rnd(.15, .85)), n = 8 + Math.floor(12 * d), spread = rnd(.5, .9);
          for (let i = 0; i < n; i++) { const a = e.a + (n > 1 ? (i / (n - 1) - .5) * 2 * spread : 0); add(tw, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, 4, c); }
        } else if (kind === 1) {   // 雨：從某一邊的場外整排落進來（略帶側飄）
          const side = pick(4), n = 5 + Math.floor(7 * d), vert = side === 0 || side === 2, sgn = side === 0 || side === 3 ? 1 : -1;
          for (let i = 0; i < n; i++) {
            const along = rnd(10, (vert ? DG_W : DG_H) - 10), drift = rnd(-12, 12) * DG_BULLET_SPEED, v = (sp * 1.1 + rnd(0, 30)) * sgn;
            if (vert) add(tw, along, side === 0 ? -8 : DG_H + 8, drift, v, 4, c); else add(tw, side === 3 ? -8 : DG_W + 8, along, v, drift, 4, c);
          }
        } else if (kind === 2) {   // 彈牆：左或右側（或上或下）整排橫掃，留一個缺口
          const side = pick(4), vert = side === 0 || side === 2, gap = rnd(40, (vert ? DG_W : DG_H) - 40), gw = 52 - 16 * d, step = 26 - 6 * d;
          const len = vert ? DG_W : DG_H, sgn = side === 0 || side === 3 ? 1 : -1;
          for (let u = 8; u < len; u += step) if (Math.abs(u - gap) > gw / 2) {
            if (vert) add(tw, u, side === 0 ? -8 : DG_H + 8, 0, sgn * sp * .95, 5, c); else add(tw, side === 3 ? -8 : DG_W + 8, u, sgn * sp * .95, 0, 5, c);
          }
        } else {   // 螺旋：場外一個發射點，邊掃過場內的方向邊發（每顆的出現時間錯開）
          const e = edge(pick(4), rnd(.2, .8)), n = 14 + Math.floor(10 * d), dir = rng() < .5 ? 1 : -1, step = 2.4 / n;
          for (let i = 0; i < n; i++) { const a = e.a + dir * (i - n / 2) * step; add(tw + i * .07, e.x, e.y, Math.cos(a) * sp * .9, Math.sin(a) * sp * .9, 4, c); }
        }
        tw += 1.5 - 1.0 * d + rnd(0, .25);   // 下一波：從 1.5 秒間隔逐漸縮到 0.5 秒
      }
    },
  };
}
// 道具（2026-11-12，使用者要求；與 worker 的 dgItem、dev_server 的 dg_item 同一套）：位置、出現時間、種類由 seed 與編號 n 決定性地算出，
// 撿到時回報 pick {n}，伺服器驗證後結算並把 taken／fx 放進 table.dg
const DG_ITEM_LIFE = 9, DG_ITEM_GAP = 4, DG_ITEM_R = 9, DG_SLOW_F = .55;
const DG_ITEM_ICON = { coin: ['🪙', '+10 分'], heart: ['❤️', '回血'], skull: ['💀', '領先者 −10'], slow: ['🐌', '他人減速'], bul: ['🎯', '只打他人的子彈'] };
function dodgeHash(a, b) {
  let x = (Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(((b >>> 0) + 0x7f4a7c15) >>> 0, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0; x ^= x >>> 15;
  return x >>> 0;
}
function dodgeItem(seed, n, players) {
  const h = k => dodgeHash(seed, n * 8 + k), r = h(3) % 100;
  const kind = players <= 1 ? (r < 70 ? 'coin' : 'heart') : r < 38 ? 'coin' : r < 55 ? 'heart' : r < 70 ? 'skull' : r < 85 ? 'slow' : 'bul';
  return { n, ts: 3 + DG_ITEM_GAP * n + (h(0) % 2000) / 1000, x: 30 + h(1) % (DG_W - 60), y: 30 + h(2) % (DG_H - 60), kind };
}
function dodgeFxBullets(seed, fx) {   // 準星：fx.from～fx.until 之間每 0.45 秒從場外朝場內隨機一點射 2 顆（own＝吃道具的人，他不會被打到）；每個 fx 只算一次
  if (fx._b) return fx._b;
  const rng = mulberry32(dodgeHash(seed, 100000 + fx.n)), rnd = (a, b) => a + rng() * (b - a), bl = [], sp = 170 * DG_BULLET_SPEED;
  for (let ts = fx.from + .5; ts < fx.until; ts += .45) {
    const side = Math.floor(rng() * 4), u = rnd(.1, .9), x = side === 1 ? DG_W + 16 : side === 3 ? -16 : u * DG_W, y = side === 0 ? -16 : side === 2 ? DG_H + 16 : u * DG_H;
    const a = Math.atan2(rnd(40, DG_H - 40) - y, rnd(40, DG_W - 40) - x);
    for (const da of [-.12, .12]) bl.push({ ts, x0: x, y0: y, vx: Math.cos(a + da) * sp, vy: Math.sin(a + da) * sp, r: 4, c: 3, own: fx.by });
  }
  return (fx._b = bl);
}
function dodgeStart(v) {   // 一局開始（伺服器給了 dg）：重置本機狀態
  const dg = v.dg, me = v.me;
  S.dg = {
    id: S.tableId, seed: dg.seed, t0: dg.t0, dur: dg.dur, off: dg.sn - Date.now(),   // off：伺服器時間 − 本機時間（毫秒，忽略單程延遲）
    gen: dodgeGen(dg.seed), act: [],           // act：目前在場上的彈幕
    pos: [], me, x: DG_W / 2 + (me - (v.seats.length - 1) / 2) * 30, y: DG_H * .75, inv: 0, lives: 3, sent: 0, finished: false, last: 0,
    keys: {}, hitFlash: 0, picked: new Map(),
  };
  S.dg.pos = v.seats.map(() => null);
  if (!S.dgRaf) { S.dgLast = performance.now(); S.dgRaf = requestAnimationFrame(dodgeFrame); }
}
function dodgeStop() { S.dg = null; if (S.dgRaf) { cancelAnimationFrame(S.dgRaf); S.dgRaf = 0; } }
const dodgeNow = () => (Date.now() + S.dg.off - S.dg.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function dodgeFrame(ts) {
  const D = S.dg, v = S.tableView;
  if (!D || !S.tableOpen || !v || v.phase !== 'playing' || v.game !== 'dodge') { S.dgRaf = 0; if (S.tableOpen && v?.game === 'dodge') buildTable(); return; }
  S.dgRaf = requestAnimationFrame(dodgeFrame);
  const dt = Math.max(0, Math.min(.05, (ts - S.dgLast) / 1000)); S.dgLast = ts;   // 第一幀的 ts 可能比 dgLast 早（同主迴圈，見 notes.md「環境與部署地雷」）
  const t = dodgeNow(), mySeat = v.role === 'seat' ? v.seats[v.me] : null, alive = mySeat && !mySeat.out;
  // 自己移動（開局前也可以先動；出局後不能）
  if (alive) {
    const k = D.keys;
    let dx = (k.right ? 1 : 0) - (k.left ? 1 : 0), dy = (k.down ? 1 : 0) - (k.up ? 1 : 0);
    if (dx && dy) { dx *= .7071; dy *= .7071; }
    const slowF = (v.dg?.fx || []).some(f => f.k === 'slow' && f.by !== D.me && t >= f.from && t <= f.until) ? DG_SLOW_F : 1;   // 蝸牛：被別人吃到的減速
    D.slow = slowF < 1;
    D.x = Math.max(DG_PLAYER_R, Math.min(DG_W - DG_PLAYER_R, D.x + dx * DG_SPEED * slowF * dt));
    D.y = Math.max(DG_PLAYER_R, Math.min(DG_H - DG_PLAYER_R, D.y + dy * DG_SPEED * slowF * dt));
    if (performance.now() - D.sent > 125) { D.sent = performance.now(); S.net?.tbl?.({ a: 'pos', x: Math.round(D.x * 10) / 10, y: Math.round(D.y * 10) / 10 }); }
  }
  // 彈幕：產生到 t+3 秒、挑出目前在場上的
  if (t > -1) {
    D.gen.fill(Math.max(0, t) + 3);
    const bl = D.gen.bullets;
    D.act = [];
    for (let i = 0; i < bl.length; i++) {
      const b = bl[i], age = t - b.ts;
      if (age < 0) continue;
      const x = b.x0 + b.vx * age, y = b.y0 + b.vy * age;
      if (x < -20 || x > DG_W + 20 || y < -20 || y > DG_H + 20) { if (age > 12) { bl.splice(i, 1); i--; } continue; }   // 出界很久的丟掉，陣列不會越長越大
      D.act.push({ x, y, r: b.r, c: b.c });
    }
    for (const f of v.dg?.fx || []) if (f.k === 'bul') for (const b of dodgeFxBullets(D.seed, f)) {   // 準星的子彈
      const age = t - b.ts; if (age < 0 || age > 8) continue;
      D.act.push({ x: b.x0 + b.vx * age, y: b.y0 + b.vy * age, r: b.r, c: b.c, own: b.own });
    }
    // 道具：目前在場上、沒被吃掉的；碰到就回報 pick
    const taken = new Set((v.dg?.taken || []).map(x => x.n)), n0 = Math.max(0, Math.floor((t - 3 - DG_ITEM_LIFE) / DG_ITEM_GAP) - 1), n1 = Math.floor((t - 3) / DG_ITEM_GAP) + 1;
    D.items = [];
    for (let n = n0; n <= n1; n++) {
      const it = dodgeItem(D.seed, n, v.dg?.n || 1);
      if (t < it.ts || t > it.ts + DG_ITEM_LIFE || taken.has(n) || (D.picked.get(n) || 0) > performance.now() - 1200) continue;   // 回報過的 1.2 秒內不重送（被伺服器駁回就會重試）
      D.items.push(it);
      if (alive && (it.x - D.x) ** 2 + (it.y - D.y) ** 2 < (DG_ITEM_R + DG_PLAYER_R) ** 2) { D.picked.set(n, performance.now()); S.net?.tbl?.({ a: 'pick', n, x: Math.round(D.x * 10) / 10, y: Math.round(D.y * 10) / 10 }); }
    }
  } else { D.act = []; D.items = []; }
  // 碰撞：只有自己、已開局、沒在無敵時間內
  D.inv = Math.max(0, D.inv - dt);
  if (alive && t >= 0 && D.inv <= 0) {
    for (const b of D.act) {
      if (b.own === D.me) continue;   // 自己吃準星射出的子彈打不到自己
      const dx = b.x - D.x, dy = b.y - D.y, rr = b.r + DG_PLAYER_R - 1;
      if (dx * dx + dy * dy < rr * rr) { D.inv = DG_INV; D.hitFlash = .35; S.net?.tbl?.({ a: 'hit' }); break; }
    }
  }
  D.hitFlash = Math.max(0, D.hitFlash - dt);
  // 時間到：請伺服器結算（伺服器核對時鐘；每秒最多重送一次直到收到結果）
  if (t >= D.dur && performance.now() - D.last > 1000) { D.last = performance.now(); S.net?.tbl?.({ a: 'finish' }); }
  // 其他人的位置內插
  for (const p of D.pos) if (p) { p.x += (p.tx - p.x) * Math.min(1, dt * 14); p.y += (p.ty - p.y) * Math.min(1, dt * 14); }
  dodgeDraw(t, mySeat);
  const tm = $('dgTime'); if (tm) tm.textContent = t < 0 ? `開始倒數 ${Math.ceil(-t)}` : `${Math.min(D.dur, t).toFixed(1)} 秒` + (mySeat && !mySeat.out ? `　${Math.max(0, Math.floor(t) + (mySeat.bonus || 0))} 分` : '') + (D.slow ? '　🐌 減速中' : '');
}
function onNetTpos(m) {   // 其他人的位置回報（i＝座位編號）
  const D = S.dg; if (!D || m.i === D.me) return;
  const p = D.pos[m.i];
  if (!p) D.pos[m.i] = { x: m.x, y: m.y, tx: m.x, ty: m.y }; else { p.tx = m.x; p.ty = m.y; }
}
function dodgeDraw(t, mySeat) {
  const cv = $('dgCanvas'); if (!cv) return;
  const g = cv.getContext('2d'), D = S.dg, v = S.tableView;
  g.fillStyle = '#0c1020'; g.fillRect(0, 0, DG_W, DG_H);
  g.strokeStyle = 'rgba(120,140,200,.12)'; g.lineWidth = 1;
  for (let x = 0; x <= DG_W; x += 40) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, DG_H); g.stroke(); }
  for (let y = 0; y <= DG_H; y += 40) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(DG_W, y + .5); g.stroke(); }
  // 彈幕
  for (const b of D.act) {
    if (b.own != null) {   // 準星的子彈：外圈用發射者的玩家顏色；自己的（打不到自己）畫成半透明空心圈，別人的是實心紫色（會打到你）
      const col = DG_COLORS[b.own % 8];
      if (b.own === D.me) { g.globalAlpha = .4; g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.arc(b.x, b.y, b.r + 1, 0, 6.2832); g.stroke(); g.globalAlpha = 1; }
      else { g.fillStyle = '#c070ff'; g.beginPath(); g.arc(b.x, b.y, b.r, 0, 6.2832); g.fill(); g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.arc(b.x, b.y, b.r + 1.5, 0, 6.2832); g.stroke(); }
      continue;
    }
    const bc = DG_BULLET_COLORS[b.c] || DG_BULLET_COLORS[0];
    g.fillStyle = bc[0]; g.beginPath(); g.arc(b.x, b.y, b.r, 0, 6.2832); g.fill();
    g.fillStyle = bc[1]; g.beginPath(); g.arc(b.x, b.y, b.r * .45, 0, 6.2832); g.fill();
  }
  // 道具（最後 2 秒閃爍）
  g.font = '16px "Segoe UI Emoji","Apple Color Emoji",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const it of D.items || []) {
    const left = it.ts + DG_ITEM_LIFE - t; if (left < 2 && Math.floor(left * 8) % 2) continue;
    const bad = it.kind === 'skull' || it.kind === 'slow' || it.kind === 'bul';
    g.fillStyle = bad ? 'rgba(255,90,90,.25)' : 'rgba(255,224,138,.25)'; g.beginPath(); g.arc(it.x, it.y, DG_ITEM_R + 3, 0, 6.2832); g.fill();
    g.strokeStyle = bad ? '#ff8a8a' : '#ffe08a'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#fff'; g.fillText(DG_ITEM_ICON[it.kind][0], it.x, it.y + 1);
  }
  g.textBaseline = 'alphabetic';
  // 玩家：自己（有無敵閃爍）、其他人（內插位置）、已出局的變灰
  v.seats.forEach((s, i) => {
    const isMe = i === D.me && v.role === 'seat', p = isMe ? { x: D.x, y: D.y } : D.pos[i];
    if (!p) return;
    const out = s.out || s.left, col = DG_COLORS[i % 8];
    if (isMe && D.inv > 0 && Math.floor(D.inv * 12) % 2 === 0) return;   // 無敵時間閃爍
    g.globalAlpha = out ? .25 : 1;
    g.fillStyle = out ? '#8a8a98' : col; g.beginPath(); g.arc(p.x, p.y, DG_PLAYER_R, 0, 6.2832); g.fill();
    g.strokeStyle = isMe ? '#ffffff' : 'rgba(255,255,255,.4)'; g.lineWidth = isMe ? 2 : 1; g.stroke();
    g.globalAlpha = out ? .4 : 1; g.font = '10px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillStyle = '#e8e4d8';
    g.fillText(s.name, p.x, p.y - 10); g.globalAlpha = 1;
    if (!out && (v.dg?.fx || []).some(f => f.k === 'slow' && f.by !== i && t >= f.from && t <= f.until)) { g.fillText('🐌', p.x + 11, p.y + 4); }   // 被減速中
  });
  if (D.hitFlash > 0) { g.fillStyle = `rgba(255,60,60,${D.hitFlash})`; g.fillRect(0, 0, DG_W, DG_H); }
  if (t < 0) { g.fillStyle = 'rgba(8,10,20,.55)'; g.fillRect(0, 0, DG_W, DG_H); g.fillStyle = '#ffe08a'; g.font = 'bold 56px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillText(String(Math.ceil(-t)), DG_W / 2, DG_H / 2 + 18); }
  if (mySeat?.out && v.role === 'seat') { g.fillStyle = 'rgba(8,10,20,.5)'; g.fillRect(0, DG_H / 2 - 36, DG_W, 72); g.fillStyle = '#ffb347'; g.font = 'bold 24px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillText(`你出局了：${Math.max(0, Math.floor(mySeat.died ?? 0) + (mySeat.bonus || 0))} 分（存活 ${mySeat.died ?? '—'} 秒）`, DG_W / 2, DG_H / 2 + 8); }
}
// 排行榜（前三名；英文打字競賽、中文打字競賽、躲彈幕）：伺服器每次結算後更新，table 畫面帶 board（[{name, score, ts}]）；只在大廳與結算畫面顯示
function boardBlock(box, v, mk, fmt) {
  const b = v.board || [], el = mk('div', 'table-board');
  el.appendChild(mk('div', 'table-board-title', '🏆 排行榜（前三名）'));
  if (!b.length) el.appendChild(mk('div', 'table-board-row empty', '還沒有紀錄'));
  b.forEach((e, i) => el.appendChild(mk('div', 'table-board-row', `${['🥇', '🥈', '🥉'][i] || i + 1 + '.'} ${e.name}　${fmt(e.score)}`)));
  box.appendChild(el);
}
function buildDodge(box, v, mk, gd) {
  const playing = v.phase === 'playing', mySeat = v.role === 'seat' ? v.seats[v.me] : null;
  if (playing && (!S.dg || S.dg.id !== S.tableId || S.dg.t0 !== v.dg?.t0)) dodgeStart(v);   // 新的一局（或剛進來觀戰一局進行中的）：重置本機狀態
  if (!playing) dodgeStop();
  let status;
  if (playing) status = mySeat ? (mySeat.out ? '你已出局' : '挑戰中：WASD／方向鍵移動，躲開彈幕、吃道具') : '觀戰中';
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.appendChild(mk('div', 'table-status' + (playing && mySeat && !mySeat.out ? ' mine' : ''), status));
  if (v.result && !playing) {   // 結算：依分數排名（存活秒數＋道具分）
    box.appendChild(mk('div', 'table-result', v.result.text));
    const rk = mk('div', 'dodge-rank');
    v.result.ranking.forEach((r, i) => rk.appendChild(mk('div', null, `${i + 1}. ${r.name}　${r.score} 分（存活 ${r.sec} 秒${r.bonus ? `，道具 ${r.bonus > 0 ? '+' : ''}${r.bonus}` : ''}）${r.left ? '（中途離開）' : ''}`)));
    box.appendChild(rk);
  }
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分`);
  const row = mk('div', 'table-seats dodge-seats');   // 每位玩家：名字、命數（♥）、存活秒數
  v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && s.out ? ' out' : ''));
    seat.style.borderColor = playing ? DG_COLORS[i % 8] : '';
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : '')));
    seat.appendChild(mk('div', 'table-tag', playing ? (s.out ? `出局 · ${Math.max(0, Math.floor(s.died ?? 0) + (s.bonus || 0))} 分` : '♥'.repeat(Math.max(0, s.lives)) + '♡'.repeat(Math.max(0, 3 - s.lives)) + ` · ${Math.max(0, Math.floor(Math.max(0, S.dg ? dodgeNow() : 0)) + (s.bonus || 0))} 分`) : (s.ready ? '已準備' : '未準備')));
    row.appendChild(seat);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  if (playing) {   // 場地
    const wrap = mk('div', 'dodge-wrap'), cv = document.createElement('canvas');
    cv.id = 'dgCanvas'; cv.width = DG_W; cv.height = DG_H; cv.className = 'dodge-canvas';
    wrap.appendChild(cv); wrap.appendChild(mk('div', 'dodge-time')); wrap.lastChild.id = 'dgTime';
    box.appendChild(wrap);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 空氣曲棍球（t15／t16，2026-11-13，使用者要求）：2～8 人分藍紅兩隊（入座順序輪流：座位 0、2、4、6 藍隊在左，1、3、5、7 紅隊在右），人數要偶數 ----
// 用滑鼠（或 WASD／方向鍵）移動自己的握把，只能在自己的半場；把圓盤打進對方球門得 1 分，先得 7 分或 3 分鐘到時分數高的贏。
// **物理在桌主（座位 0）那台**：圓盤的移動、反彈、碰撞、進球、結束都在那台算，約 12 次／秒送快照 hs（伺服器轉成 ths）；
// 每個人約 12 次／秒送自己握把的位置 hp（伺服器轉成 thp）。桌主用收到的位置算碰撞，別人打到圓盤的判定會晚一點點（網路延遲）。
const HK_W = 640, HK_H = 320, HK_PR = 18, HK_BR = 11, HK_GOAL = 120, HK_SEND_MS = 80;   // 場地、握把半徑、圓盤半徑、球門寬、回報間隔
const HK_MAX_PAD = 900, HK_MAX_PUCK = 950, HK_KEY_SPD = 420;                           // 握把最快速度、圓盤最快速度、鍵盤移動速度（px／秒）
const HK_TEAM_COL = ['#3b78e8', '#e04848'], HK_TEAM_NAME = ['藍隊', '紅隊'];
const HK_KEYS = { arrowup: 'u', w: 'u', arrowdown: 'd', s: 'd', arrowleft: 'l', a: 'l', arrowright: 'r', d: 'r' };
function hkHome(i, n) {   // 第 i 位的開球位置：同隊依序排成一直排（4 人以上排兩直排）
  const team = i % 2, k = Math.floor(i / 2), m = n / 2, cols = m > 2 ? 2 : 1, col = k % cols, row = Math.floor(k / cols), rows = Math.ceil(m / cols);
  const x = 60 + col * 110, y = HK_H * (row + 1) / (rows + 1);
  return [team ? HK_W - x : x, y];
}
function hkStartLocal(v) {
  const z = v.hk, n = v.seats.length, me = v.role === 'seat' ? v.me : -1;
  S.hk = {
    key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), lim: z.lim / 1000, goals: z.goals, n, me, host: me === 0,
    pads: v.seats.map((_, i) => { const [x, y] = hkHome(i, n); return { x, y, tx: x, ty: y, vx: 0, vy: 0, at: 0 }; }),
    puck: { x: HK_W / 2, y: HK_H / 2, vx: 0, vy: 0 }, view: { x: HK_W / 2, y: HK_H / 2 }, snapAt: 0, snapPerf: 0,
    sa: 0, sb: 0, f: 0, mx: null, my: null, keys: {}, sendAt: 0, hsAt: 0, over: false, last: performance.now(), flash: null,
  };
  if (!S.hkRaf) S.hkRaf = requestAnimationFrame(hkFrame);
}
function hkStop() { S.hk = null; if (S.hkRaf) { cancelAnimationFrame(S.hkRaf); S.hkRaf = 0; } }
const hkNow = H => (Date.now() + H.off - H.t0) / 1000;
function hkClampPad(p, team) {
  p.x = Math.max(team ? HK_W / 2 + HK_PR : HK_PR, Math.min(team ? HK_W - HK_PR : HK_W / 2 - HK_PR, p.x));
  p.y = Math.max(HK_PR, Math.min(HK_H - HK_PR, p.y));
}
function hkMoveMine(H, dt) {   // 自己的握把：跟著滑鼠（有最快速度），按住方向鍵時改用鍵盤
  const p = H.pads[H.me], k = H.keys, ox = p.x, oy = p.y;
  const kx = (k.r ? 1 : 0) - (k.l ? 1 : 0), ky = (k.d ? 1 : 0) - (k.u ? 1 : 0);
  if (kx || ky) { const l = Math.hypot(kx, ky); p.x += kx / l * HK_KEY_SPD * dt; p.y += ky / l * HK_KEY_SPD * dt; H.mx = null; }
  else if (H.mx != null) {
    const dx = H.mx - p.x, dy = H.my - p.y, d = Math.hypot(dx, dy), step = HK_MAX_PAD * dt;
    if (d <= step) { p.x = H.mx; p.y = H.my; } else { p.x += dx / d * step; p.y += dy / d * step; }
  }
  hkClampPad(p, H.me % 2);
  p.vx = dt > 0 ? (p.x - ox) / dt : 0; p.vy = dt > 0 ? (p.y - oy) / dt : 0;
}
function hkFaceoff(H, toTeam) {   // 進球後：圓盤放在失分那隊的半場、停 1 秒
  H.puck = { x: toTeam === 0 ? HK_W / 2 - 70 : HK_W / 2 + 70, y: HK_H / 2, vx: 0, vy: 0 };
  H.f = 1;
}
function hkPhysics(H, dt) {   // 桌主：圓盤
  const P = H.puck;
  if (H.f > 0) { H.f -= dt; return; }
  P.x += P.vx * dt; P.y += P.vy * dt;
  const fr = Math.max(0, 1 - .25 * dt); P.vx *= fr; P.vy *= fr;
  if (P.y < HK_BR) { P.y = HK_BR; P.vy = Math.abs(P.vy) * .9; }
  if (P.y > HK_H - HK_BR) { P.y = HK_H - HK_BR; P.vy = -Math.abs(P.vy) * .9; }
  const inGoal = Math.abs(P.y - HK_H / 2) < HK_GOAL / 2 - HK_BR * .3;
  if (P.x < HK_BR && !inGoal) { P.x = HK_BR; P.vx = Math.abs(P.vx) * .9; }
  if (P.x > HK_W - HK_BR && !inGoal) { P.x = HK_W - HK_BR; P.vx = -Math.abs(P.vx) * .9; }
  if (P.x < -HK_BR) { H.sb++; H.flash = { team: 1, until: performance.now() + 1200 }; hkFaceoff(H, 0); return; }   // 紅隊得分
  if (P.x > HK_W + HK_BR) { H.sa++; H.flash = { team: 0, until: performance.now() + 1200 }; hkFaceoff(H, 1); return; }   // 藍隊得分
  H.pads.forEach((p, i) => {   // 握把撞圓盤：推出去、照相對速度反彈
    const dx = P.x - p.x, dy = P.y - p.y, d = Math.hypot(dx, dy), md = HK_PR + HK_BR;
    if (d >= md || d < 1e-6) return;
    const nx = dx / d, ny = dy / d;
    P.x = p.x + nx * md; P.y = p.y + ny * md;
    const pvx = i === H.me ? p.vx : p.vx || 0, pvy = i === H.me ? p.vy : p.vy || 0;
    const rvx = P.vx - pvx, rvy = P.vy - pvy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { P.vx -= 1.9 * vn * nx; P.vy -= 1.9 * vn * ny; }
    P.vx += nx * 40; P.vy += ny * 40;
  });
  const sp = Math.hypot(P.vx, P.vy); if (sp > HK_MAX_PUCK) { P.vx *= HK_MAX_PUCK / sp; P.vy *= HK_MAX_PUCK / sp; }
}
function hkFrame() {
  const H = S.hk, v = S.tableView;
  if (!H || !S.tableOpen || !v || v.phase !== 'playing' || v.game !== 'hockey') { S.hkRaf = 0; if (S.tableOpen && v?.game === 'hockey') buildTable(); return; }
  S.hkRaf = requestAnimationFrame(hkFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - H.last) / 1000)); H.last = now;
  const t = hkNow(H);
  if (H.me >= 0 && t >= 0 && !H.over) {
    hkMoveMine(H, dt);
    // 自己的握把位置（桌主的夾在下面的 hs 裡送：hp 與 hs 共用同一個限流）
    if (!H.host && now - H.sendAt >= HK_SEND_MS) { H.sendAt = now; const p = H.pads[H.me]; S.net?.tbl?.({ a: 'hp', x: Math.round(p.x), y: Math.round(p.y) }); }
  }
  H.pads.forEach((p, i) => {   // 別人的握把：往收到的位置平滑移動（速度用兩次回報的差估計，桌主算碰撞用）
    if (i === H.me) return;
    const a = 1 - Math.exp(-dt * 18); p.x += (p.tx - p.x) * a; p.y += (p.ty - p.y) * a;
  });
  if (H.host && t >= 0 && !H.over) {
    for (let k = 0; k < 4; k++) hkPhysics(H, dt / 4);
    if (now - H.hsAt >= HK_SEND_MS) { H.hsAt = now; const P = H.puck; const me = H.pads[0]; S.net?.tbl?.({ a: 'hs', x: Math.round(P.x), y: Math.round(P.y), vx: Math.round(P.vx), vy: Math.round(P.vy), sa: H.sa, sb: H.sb, f: Math.round(Math.max(0, H.f) * 1000), px: Math.round(me.x), py: Math.round(me.y) }); }
    if (H.sa >= H.goals || H.sb >= H.goals || t >= H.lim) { H.over = true; S.net?.tbl?.({ a: 'hend', sa: H.sa, sb: H.sb }); }
    H.view.x = H.puck.x; H.view.y = H.puck.y;
  } else if (!H.host) {   // 其他人：圓盤＝最後一次快照往前推算（碰到上下牆反彈），再平滑
    const P = H.puck, age = Math.min(.25, (now - H.snapPerf) / 1000);
    let x = P.x + (H.f > 0 ? 0 : P.vx * age), y = P.y + (H.f > 0 ? 0 : P.vy * age);
    if (y < HK_BR) y = 2 * HK_BR - y; if (y > HK_H - HK_BR) y = 2 * (HK_H - HK_BR) - y;
    const a = 1 - Math.exp(-dt * 20), V = H.view;
    if (Math.hypot(x - V.x, y - V.y) > 80) { V.x = x; V.y = y; } else { V.x += (x - V.x) * a; V.y += (y - V.y) * a; }
  }
  hkDraw(H, t, v);
}
function onNetThp(m) {   // 別人的握把位置（i＝座位）
  const H = S.hk; if (!H || m.i === H.me || !H.pads[m.i]) return;
  const p = H.pads[m.i], now = performance.now(), dt = (now - (p.at || now)) / 1000;
  if (p.at && dt > .01 && dt < .5) { p.vx = Math.max(-HK_MAX_PAD, Math.min(HK_MAX_PAD, (m.x - p.tx) / dt)); p.vy = Math.max(-HK_MAX_PAD, Math.min(HK_MAX_PAD, (m.y - p.ty) / dt)); }
  else { p.vx = 0; p.vy = 0; }
  p.tx = m.x; p.ty = m.y; p.at = now;
}
function onNetThs(m) {   // 桌主的圓盤快照
  const H = S.hk; if (!H || H.host) return;
  if (m.sa > H.sa) H.flash = { team: 0, until: performance.now() + 1200 };
  if (m.sb > H.sb) H.flash = { team: 1, until: performance.now() + 1200 };
  H.puck = { x: m.x, y: m.y, vx: m.vx, vy: m.vy }; H.sa = m.sa; H.sb = m.sb; H.f = m.f / 1000; H.snapPerf = performance.now();
}
function hkKey(e, down) {   // 遊戲中的方向鍵（回 true＝已處理）
  const H = S.hk, k = HK_KEYS[e.key.toLowerCase()];
  if (!H || H.me < 0 || !k) return false;
  if (down) e.preventDefault();
  H.keys[k] = down;
  return true;
}
function hkDraw(H, t, v) {
  const cv = $('hkCanvas'); if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now(), Y0 = 34;
  g.fillStyle = '#0c1424'; g.fillRect(0, 0, cv.width, cv.height);
  // 分數列
  g.font = 'bold 18px "Microsoft JhengHei"'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillStyle = HK_TEAM_COL[0]; g.fillText(`藍隊 ${H.sa}`, HK_W / 2 - 70, 17);
  g.fillStyle = '#ffe08a'; g.fillText(':', HK_W / 2, 17);
  g.fillStyle = HK_TEAM_COL[1]; g.fillText(`${H.sb} 紅隊`, HK_W / 2 + 70, 17);
  const rem = Math.max(0, Math.ceil(H.lim - Math.max(0, t)));
  g.font = '13px "Microsoft JhengHei"'; g.fillStyle = rem <= 30 ? '#ff7a6a' : '#b8c4dc'; g.textAlign = 'right';
  g.fillText(`剩 ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}　先得 ${H.goals} 分獲勝`, HK_W - 8, 17);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.save(); g.translate(0, Y0);
  // 場地
  g.fillStyle = '#eef6fa'; g.fillRect(0, 0, HK_W, HK_H);
  g.fillStyle = '#d8e8f0'; for (let y = 12; y < HK_H; y += 16) for (let x = 12 + (y / 16 % 2) * 8; x < HK_W; x += 16) g.fillRect(x, y, 2, 2);   // 出風小孔
  g.strokeStyle = '#e04848'; g.lineWidth = 3; g.beginPath(); g.moveTo(HK_W / 2, 0); g.lineTo(HK_W / 2, HK_H); g.stroke();
  g.beginPath(); g.arc(HK_W / 2, HK_H / 2, 46, 0, Math.PI * 2); g.stroke();
  for (const [x, c] of [[0, HK_TEAM_COL[0]], [HK_W, HK_TEAM_COL[1]]]) {   // 球門前的半圓與球門
    g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.arc(x, HK_H / 2, 70, x ? Math.PI / 2 : -Math.PI / 2, x ? Math.PI * 1.5 : Math.PI / 2); g.stroke();
    g.fillStyle = '#1a1a22'; g.fillRect(x ? HK_W - 6 : 0, HK_H / 2 - HK_GOAL / 2, 6, HK_GOAL);
  }
  if (H.me >= 0) { g.fillStyle = H.me % 2 ? 'rgba(224,72,72,.06)' : 'rgba(59,120,232,.06)'; g.fillRect(H.me % 2 ? HK_W / 2 : 0, 0, HK_W / 2, HK_H); }   // 自己的半場
  // 圓盤
  const V = H.host ? H.puck : H.view;
  g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.arc(V.x + 2, V.y + 3, HK_BR, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2a2a30'; g.beginPath(); g.arc(V.x, V.y, HK_BR, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#5a5a68'; g.lineWidth = 2; g.beginPath(); g.arc(V.x, V.y, HK_BR - 3, 0, Math.PI * 2); g.stroke();
  // 握把
  H.pads.forEach((p, i) => {
    const c = HK_TEAM_COL[i % 2], s = v.seats[i];
    g.fillStyle = 'rgba(0,0,0,.2)'; g.beginPath(); g.arc(p.x + 2, p.y + 3, HK_PR, 0, Math.PI * 2); g.fill();
    g.fillStyle = c; g.beginPath(); g.arc(p.x, p.y, HK_PR, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(p.x, p.y, HK_PR - 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = c; g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(p.x - 2, p.y - 2, 3, 0, Math.PI * 2); g.fill();
    if (i === H.me) { g.strokeStyle = '#ffe08a'; g.lineWidth = 2.5; g.beginPath(); g.arc(p.x, p.y, HK_PR + 3, 0, Math.PI * 2); g.stroke(); }
    g.font = 'bold 11px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.9)'; g.fillStyle = c;
    const nm = i === H.me ? '你' : s?.name || '?'; g.strokeText(nm, p.x, p.y - HK_PR - 5); g.fillText(nm, p.x, p.y - HK_PR - 5); g.textAlign = 'left';
  });
  // 倒數／得分
  let msg = null, col = '#ffe08a';
  if (t < 0) msg = String(Math.ceil(-t));
  else if (H.flash && H.flash.until > now) { msg = `${HK_TEAM_NAME[H.flash.team]}得分！`; col = HK_TEAM_COL[H.flash.team]; }
  else if (t < .8) msg = '開始！';
  if (msg) { g.font = 'bold 34px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.95)'; g.fillStyle = col; g.strokeText(msg, HK_W / 2, HK_H / 2 + 12); g.fillText(msg, HK_W / 2, HK_H / 2 + 12); g.textAlign = 'left'; }
  g.restore();
}
function buildHockey(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.hk;
  if (playing && z && (!S.hk || S.hk.key !== z.seed + ':' + z.t0)) hkStartLocal(v);
  if (!playing) hkStop();
  const n = v.seats.length, mine = v.role === 'seat' ? v.me : -1;
  let status;
  if (playing) status = mine >= 0 ? `你是${HK_TEAM_NAME[mine % 2]}：用滑鼠（或 WASD／方向鍵）移動握把，把圓盤打進對方球門！` : '觀戰中';
  else if (n < v.min) status = `等待玩家入座（2～${v.max} 人，人數要是偶數）`;
  else if (n % 2) status = `目前 ${n} 人：人數要是偶數（2、4、6、8）才能開始`;
  else status = `${n / 2} 對 ${n / 2}：全員按「準備」就開始`;
  box.appendChild(mk('div', 'table-status' + (playing && mine >= 0 ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing) {
    box.appendChild(mk('div', 'table-result', r.text));
    if (r.ranking) {
      const rk = mk('div', 'dodge-rank');
      for (const team of [0, 1]) rk.appendChild(mk('div', null, `${HK_TEAM_NAME[team]}：${r.ranking.filter(x => x.team === team).map(x => x.name).join('、') || '—'}`));
      box.appendChild(rk);
    }
  }
  if (!playing) {
    const row = mk('div', 'table-seats');
    v.seats.forEach((s, i) => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : ''));
      seat.style.borderColor = HK_TEAM_COL[i % 2];
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', `${HK_TEAM_NAME[i % 2]} · ${s.ready ? '已準備' : '未準備'}`));
      row.appendChild(seat);
    });
    for (let i = n; i < v.max; i++) { const e = mk('div', 'table-seat empty', `空位（${HK_TEAM_NAME[i % 2]}）`); row.appendChild(e); }
    box.appendChild(row);
  } else {
    box.appendChild(mk('div', 'table-tag', [0, 1].map(team => `${HK_TEAM_NAME[team]}：${v.seats.filter((_, i) => i % 2 === team).map(s => s.name).join('、')}`).join('　')));
    const wrap = mk('div', 'mz-wrap'), cv = document.createElement('canvas');
    cv.id = 'hkCanvas'; cv.width = HK_W; cv.height = HK_H + 34; cv.className = 'hk-canvas';
    const at = e => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * cv.width / b.width, (e.clientY - b.top) * cv.height / b.height - 34]; };
    cv.onmousemove = e => { if (S.hk) [S.hk.mx, S.hk.my] = at(e); };
    wrap.appendChild(cv); box.appendChild(wrap);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && n < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 豆豆迷宮（吃豆迷宮類；第十四桌 t14，2026-11-13，使用者要求）：1～5 人，一人當「豆豆」吃光迷宮裡的豆子，其他人當「幽靈」抓豆豆 ----
// 1 人＝單人：自己當豆豆、對 4 隻電腦幽靈，一關接一關到命用完，分數進排行榜；2～5 人＝對抗：桌主指定誰當豆豆，其他人當幽靈（不足 4 隻由電腦補），
// 豆子吃光豆豆方贏、命用完或時間到幽靈方贏。**豆豆那台是權威**：豆子、能量、被抓、吃幽靈、電腦幽靈都在那台算，約 10 次／秒送快照 ms（伺服器轉成 tms）；
// 幽靈玩家各自在本機移動、送位置 mp（伺服器轉成 tmp）；豆豆那台用收到的位置判斷碰撞（延遲大時偶爾「明明沒碰到卻被抓」，使用者接受）。
// 迷宮、角色外型都是原創（不是任何現有遊戲的關卡／角色）；協定與欄位見 notes「和平島與遊戲桌」。
const MZ_MAP = [
  '#####################',
  '#o.......###.......o#',
  '#.##.###.###.###.##.#',
  '#...................#',
  '#.##.#.#######.#.##.#',
  '#....#....#....#....#',
  '####.####.#.####.####',
  '####.#.........#.####',
  '####.#.###-###.#.####',
  '.......#GGGGG#.......',
  '####.#.#######.#.####',
  '####.#.........#.####',
  '####.#.#######.#.####',
  '#.........#.........#',
  '#.##.####.#.####.##.#',
  '#o.#.............#.o#',
  '##.#.#.#######.#.#.##',
  '#....#....#....#....#',
  '#.#######.#.#######.#',
  '#...................#',
  '#####################',
];
const MZ_W = 21, MZ_H = 21, MZ_T = 20, MZ_HUD = 30;   // 迷宮 21×21 格、每格 20px、上方 30px 的分數列
const MZ_DX = [0, 1, 0, -1], MZ_DY = [-1, 0, 1, 0];   // 方向 0 上、1 右、2 下、3 左
const MZ_TUN_Y = 9, MZ_PAC0 = [10, 15], MZ_FRUIT = [10, 11];   // 左右相通的隧道列、豆豆起點、獎勵果實的位置
const MZ_GHOST0 = [[10, 7], [9, 9], [10, 9], [11, 9]];        // 4 隻幽靈的起點（第 1 隻在門外，其他在家裡）
const MZ_GCOL = ['#ff6a6a', '#b07aff', '#5aa8ff', '#ffb050'];  // 小紅、小紫、小藍、小橘
const MZ_GNAME = ['小紅', '小紫', '小藍', '小橘'];
const MZ_SCATTER = [[20, -2], [0, -2], [20, 22], [0, 22]];      // 電腦幽靈「散開」時各自去的角落
const MZ_PHASES = [6, 20, 5, 20, 5, 1e9];                       // 電腦幽靈：散開／追擊交替的秒數
const MZ_KEYS = { arrowup: 0, w: 0, arrowright: 1, d: 1, arrowdown: 2, s: 2, arrowleft: 3, a: 3 };
const MZ_SNAP_MS = 100, MZ_LIVES = 3, MZ_HIT = .7;              // 快照／位置回報間隔、命數、碰撞距離（格）
const MZ_DOTS = [], MZ_DOT_IDX = new Map();                     // 豆子清單 [x, y, 是不是能量豆]；格子 → 編號（快照的點陣順序）
for (let y = 0; y < MZ_H; y++) for (let x = 0; x < MZ_W; x++) {
  const c = MZ_MAP[y][x];
  if ((c === '.' || c === 'o') && !(x === MZ_PAC0[0] && y === MZ_PAC0[1])) { MZ_DOT_IDX.set(y * MZ_W + x, MZ_DOTS.length); MZ_DOTS.push([x, y, c === 'o']); }
}
const mzCell = (x, y) => { if (y === MZ_TUN_Y) x = ((x % MZ_W) + MZ_W) % MZ_W; return x < 0 || x >= MZ_W || y < 0 || y >= MZ_H ? '#' : MZ_MAP[y][x]; };
// 能不能往 dir 方向走進 (x, y)：牆不行；幽靈的家只有幽靈能進；家門只有往上（出門）或被吃掉的眼睛（回家）能過
function mzPass(x, y, ghost, eyes, dir) {
  const c = mzCell(x, y);
  if (c === '#') return false;
  if (c === '-') return ghost && (eyes || dir === 0);
  if (c === 'G') return ghost;
  return true;
}
function mzField(tx, ty, eyes) {   // 到 (tx, ty) 的步數（BFS）：眼睛回家、從家裡出門用
  const f = new Array(MZ_W * MZ_H).fill(1e9), q = [[tx, ty]];
  f[ty * MZ_W + tx] = 0;
  while (q.length) {
    const [x, y] = q.shift(), d = f[y * MZ_W + x];
    for (let k = 0; k < 4; k++) {
      let nx = x + MZ_DX[k]; const ny = y + MZ_DY[k];
      if (ny === MZ_TUN_Y) nx = (nx + MZ_W) % MZ_W;
      if (nx < 0 || nx >= MZ_W || ny < 0 || ny >= MZ_H || mzCell(nx, ny) === '#' || !mzPass(x, y, true, eyes, (k + 2) % 4)) continue;
      const i = ny * MZ_W + nx; if (f[i] > d + 1) { f[i] = d + 1; q.push([nx, ny]); }
    }
  }
  return f;
}
const MZ_F_HOME = mzField(10, 9, true), MZ_F_EXIT = mzField(10, 7, false);
const mzEnt = (x, y, d = -1) => ({ tx: x, ty: y, d, p: 0, want: -1, moving: false, eyes: false, fr: false, rel: 0 });
const mzPos = e => (e.d >= 0 ? [e.tx + MZ_DX[e.d] * e.p, e.ty + MZ_DY[e.d] * e.p] : [e.tx, e.ty]);
function mzWrapX(e) { if (e.tx < 0) e.tx += MZ_W; else if (e.tx >= MZ_W) e.tx -= MZ_W; }
function mzReverse(e) { if (e.d < 0) return; if (e.p > 0) { e.tx += MZ_DX[e.d]; e.ty += MZ_DY[e.d]; mzWrapX(e); e.p = 1 - e.p; } e.d = (e.d + 2) % 4; }
// 沿格子移動 sp 格／秒：走到格子中心才決定下一步（think 回方向或 −1＝停）；onTile＝每到一格中心呼叫一次
function mzMove(e, sp, dt, think, ghost, onTile) {
  let rem = sp * dt;
  for (let g = 0; g < 12 && rem > 1e-9; g++) {
    if (e.p === 0) {
      const nd = think(e);
      if (nd < 0 || !mzPass(e.tx + MZ_DX[nd], e.ty + MZ_DY[nd], ghost, e.eyes, nd)) { e.moving = false; return; }
      e.d = nd; e.moving = true;
    }
    const need = 1 - e.p;
    if (rem < need) { e.p += rem; return; }
    rem -= need; e.tx += MZ_DX[e.d]; e.ty += MZ_DY[e.d]; e.p = 0; mzWrapX(e);
    if (onTile) onTile(e);
  }
}
// 玩家操作的角色：按的方向能走就轉（可以提前按，到路口才轉），不能走就照原方向，撞牆就停
const mzSteer = ghost => e => (e.want >= 0 && mzPass(e.tx + MZ_DX[e.want], e.ty + MZ_DY[e.want], ghost, e.eyes, e.want) ? e.want : e.d >= 0 && mzPass(e.tx + MZ_DX[e.d], e.ty + MZ_DY[e.d], ghost, e.eyes, e.d) ? e.d : -1);
function mzFieldDir(e, f, eyes) {
  let best = -1, bd = f[e.ty * MZ_W + e.tx];
  for (let k = 0; k < 4; k++) {
    let nx = e.tx + MZ_DX[k]; const ny = e.ty + MZ_DY[k];
    if (ny === MZ_TUN_Y) nx = (nx + MZ_W) % MZ_W;
    if (nx < 0 || nx >= MZ_W || ny < 0 || ny >= MZ_H || !mzPass(nx, ny, true, eyes, k)) continue;
    const d = f[ny * MZ_W + nx]; if (d < bd) { bd = d; best = k; }
  }
  return best;
}
const mzInHouse = e => { const c = mzCell(e.tx, e.ty); return c === 'G' || c === '-'; };
function mzTarget(M, k) {   // 電腦幽靈的目標格：散開時去自己的角落；追擊時各有個性（直追／包抄前方／從後面堵／離遠才追）
  if (M.phase % 2 === 0) return MZ_SCATTER[k];
  const P = M.pac, d = P.d >= 0 ? P.d : 3, px = P.tx, py = P.ty, e = M.ghosts[k];
  if (k === 1) return [px + MZ_DX[d] * 4, py + MZ_DY[d] * 4];
  if (k === 2) return [px - MZ_DX[d] * 3, py - MZ_DY[d] * 3];
  if (k === 3 && Math.hypot(e.tx - px, e.ty - py) < 6) return MZ_SCATTER[3];
  return [px, py];
}
function mzGhostThink(M, k, e) {
  if (e.eyes) return mzFieldDir(e, MZ_F_HOME, true);
  if (mzInHouse(e)) return M.clock >= e.rel ? mzFieldDir(e, MZ_F_EXIT, false) : -1;
  const opts = [];
  for (const k2 of [0, 3, 2, 1]) if (k2 !== (e.d + 2) % 4 && mzPass(e.tx + MZ_DX[k2], e.ty + MZ_DY[k2], true, false, k2)) opts.push(k2);
  if (!opts.length) return (e.d + 2) % 4;
  if (e.fr) return opts[Math.floor(Math.random() * opts.length)];
  const [gx, gy] = mzTarget(M, k);
  let best = opts[0], bd = 1e9;
  for (const k2 of opts) { const nx = e.tx + MZ_DX[k2], ny = e.ty + MZ_DY[k2], d = (nx - gx) ** 2 + (ny - gy) ** 2; if (d < bd) { bd = d; best = k2; } }
  return best;
}
const mzLvMul = M => 1 + Math.min(.3, (M.lvl - 1) * .05);
const mzTunnel = (x, y) => y === MZ_TUN_Y && (x <= 4 || x >= 16);
function mzGhostSpd(M, e, fr) { const [x, y] = mzPos(e); if (e.eyes) return 11; let s = fr ? 3.3 : 5.5 * mzLvMul(M); if (mzTunnel(Math.round(x), Math.round(y))) s *= .55; return s; }
const mzPowerDur = M => (M.solo ? Math.max(2.5, 7 - (M.lvl - 1) * .8) : 6);
const mzRelDelay = (M, k) => (M.solo ? [0, 2, 5, 8][k] * Math.max(.3, 1 - (M.lvl - 1) * .15) : [0, 1.5, 3, 4.5][k]);
function mzDotsHex(d) { let s = ''; for (let i = 0; i < d.length; i += 4) { let v = 0; for (let b = 0; b < 4; b++) if (d[i + b]) v |= 1 << b; s += v.toString(16); } return s; }
function mzDotsFromHex(h, d) { for (let i = 0; i < d.length; i++) d[i] = (parseInt(h[i >> 2] || '0', 16) >> (i & 3)) & 1; }
const mzNow = M => (Date.now() + M.off - M.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
const mzRec = (x, y) => ({ x, y, tx: x, ty: y, d: -1, m: 0, has: false });
function mzRecSet(r, x, y, d, m) { r.tx = x; r.ty = y; if (!r.has || Math.abs(x - r.x) > 3 || Math.abs(y - r.y) > 3) { r.x = x; r.y = y; } r.d = d; r.m = m; r.has = true; }
function mzRecStep(r, dt) { const a = 1 - Math.exp(-dt * 14); r.x += (r.tx - r.x) * a; r.y += (r.ty - r.y) * a; }
// 一局開始（伺服器給了 mz）：建立本機狀態。role＝pac（我是豆豆，權威）／ghost（我是幽靈玩家）／spec（觀戰或還沒輪到）
function mzStart(v) {
  const z = v.mz, me = v.role === 'seat' ? v.me : -1;
  const role = me >= 0 && me === z.pac ? 'pac' : me >= 0 && z.gh.includes(me) ? 'ghost' : 'spec';
  const M = S.mz = {
    key: z.seed + ':' + z.t0, role, solo: z.solo, t0: z.t0, off: z.sn - Date.now(), lim: (z.lim || 240000) / 1000, gh: [...z.gh], myK: z.gh.indexOf(me),
    dots: new Uint8Array(MZ_DOTS.length).fill(1), left: MZ_DOTS.length, eaten: 0, sc: 0, lv: MZ_LIVES, lvl: 1, pw: 0, chain: 0, fz: 0, dead: 0, clear: 0,
    clock: 0, modeT: 0, phase: 0, rs: 0, ct: [0, 0, 0, 0], bonus: 0, bonusN: 0, extra: false, over: false, snapAt: 0, anim: 0, pops: [], last: performance.now(),
    pac: mzEnt(...MZ_PAC0, 3), ghosts: MZ_GHOST0.map(([x, y]) => mzEnt(x, y, -1)),
    hm: MZ_GHOST0.map(([x, y]) => ({ x, y, d: -1, rm: 0, mode: 0, saw: false, t: 0, has: false })),   // 豆豆那台：幽靈玩家的最新位置與狀態
    rPac: mzRec(...MZ_PAC0), rG: MZ_GHOST0.map(([x, y]) => mzRec(x, y)), rH: MZ_GHOST0.map(([x, y]) => mzRec(x, y)),   // 其他人：畫面上的位置（平滑）
    mine: role === 'ghost' ? mzEnt(...MZ_GHOST0[z.gh.indexOf(me)], -1) : null, myMode: 0, reviveAt: -9, fzShow: 0,
  };
  M.ghosts.forEach((e, k) => { e.rel = mzRelDelay(M, k); });
  if (!S.mzRaf) S.mzRaf = requestAnimationFrame(mzFrame);
}
function mzStop() { S.mz = null; if (S.mzRaf) { cancelAnimationFrame(S.mzRaf); S.mzRaf = 0; } }
function mzResetPos(M) {   // 被抓後／過關：大家回起點
  M.pac = mzEnt(...MZ_PAC0, 3);
  M.ghosts = MZ_GHOST0.map(([x, y], k) => { const e = mzEnt(x, y, -1); e.rel = M.clock + mzRelDelay(M, k); return e; });
  M.hm.forEach((h, k) => { h.x = MZ_GHOST0[k][0]; h.y = MZ_GHOST0[k][1]; h.mode = 0; h.saw = false; });
  M.pw = 0; M.chain = 0; M.phase = 0; M.modeT = 0; M.rs++; M.fz = 1.5;
}
function mzEnd(M, win, tu) {
  if (M.over) return;
  M.over = true; mzSnap(M, true);
  S.net?.tbl?.({ a: 'over', sc: M.sc, lvl: M.lvl, win: !!win, tu: !!tu, ct: M.ct.map(n => Math.min(99, n)) });
}
function mzPower(M) {
  M.pw = mzPowerDur(M); M.chain = 0;
  M.ghosts.forEach((e, k) => { if (M.gh[k] < 0 && !e.eyes) { e.fr = true; if (!mzInHouse(e)) mzReverse(e); } });
  M.hm.forEach((h, k) => { if (M.gh[k] >= 0 && h.mode !== 2) h.mode = 1; });
}
function mzEat(M, e) {   // 豆豆走到一格的中心：吃豆子／能量豆／獎勵果實
  const i = MZ_DOT_IDX.get(e.ty * MZ_W + e.tx);
  if (i != null && M.dots[i]) {
    M.dots[i] = 0; M.left--; M.eaten++;
    if (MZ_DOTS[i][2]) { M.sc += 50; mzPower(M); } else M.sc += 10;
    if (M.eaten === 70 || M.eaten === 140) { M.bonus = M.clock + 9; M.bonusN++; }
    if (M.left <= 0) { if (M.solo) M.clear = 2; else mzEnd(M, true); }
  }
  if (M.bonus > M.clock && e.tx === MZ_FRUIT[0] && e.ty === MZ_FRUIT[1]) {
    const pts = M.solo ? 100 * M.lvl : 300; M.sc += pts; M.bonus = 0;
    M.pops.push({ x: e.tx, y: e.ty, t: `+${pts}`, until: performance.now() + 1000 });
  }
  if (M.solo && !M.extra && M.sc >= 10000) { M.extra = true; M.lv = Math.min(9, M.lv + 1); M.pops.push({ x: e.tx, y: e.ty - 1, t: '多一條命！', until: performance.now() + 1500 }); }
}
const mzDist = (ax, ay, bx, by) => { let dx = Math.abs(ax - bx); if (dx > MZ_W / 2) dx = MZ_W - dx; return Math.hypot(dx, ay - by); };
function mzPacStep(M, dt) {   // 我是豆豆：整局的權威模擬
  if (M.over) return;
  if (M.dead > 0) {   // 被抓的動畫
    M.dead -= dt;
    if (M.dead <= 0) { M.dead = 0; if (M.lv <= 0) mzEnd(M, false); else mzResetPos(M); }
    return;
  }
  if (M.clear > 0) {   // 過關（單人）：迷宮閃一下，下一關
    M.clear -= dt;
    if (M.clear <= 0) { M.clear = 0; M.lvl++; M.dots.fill(1); M.left = MZ_DOTS.length; M.eaten = 0; M.bonus = 0; mzResetPos(M); }
    return;
  }
  if (M.fz > 0) { M.fz -= dt; return; }
  M.clock += dt;
  if (!M.solo && mzNow(M) >= M.lim) { mzEnd(M, false, true); return; }
  if (M.pw > 0) { M.pw -= dt; if (M.pw <= 0) { M.pw = 0; M.ghosts.forEach(e => { e.fr = false; }); M.hm.forEach(h => { if (h.mode === 1) h.mode = 0; }); } }
  else { M.modeT += dt; if (M.modeT >= MZ_PHASES[M.phase]) { M.modeT = 0; M.phase = Math.min(M.phase + 1, MZ_PHASES.length - 1); } }
  const P = M.pac;
  if (P.p > 0 && P.want === (P.d + 2) % 4) mzReverse(P);
  mzMove(P, 6 * mzLvMul(M) * (M.pw > 0 ? 1.1 : 1), dt, mzSteer(false), false, e => mzEat(M, e));
  if (P.moving) M.anim += dt;
  if (M.over || M.clear > 0) return;
  M.ghosts.forEach((e, k) => {
    if (M.gh[k] >= 0) return;
    mzMove(e, mzGhostSpd(M, e, e.fr), dt, ee => mzGhostThink(M, k, ee), true);
    if (e.eyes && e.tx === 10 && e.ty === 9 && e.p === 0) { e.eyes = false; e.fr = false; e.rel = 0; }
  });
  M.hm.forEach(h => { if (h.mode === 2 && M.clock - h.t > 12) { h.mode = 0; h.saw = false; } });   // 沒收到「回到家」的回報：12 秒後當作已復活
  const [px, py] = mzPos(P);
  for (let k = 0; k < 4; k++) {
    let gx, gy, mode;
    if (M.gh[k] < 0) { const e = M.ghosts[k]; [gx, gy] = mzPos(e); mode = e.eyes ? 2 : e.fr ? 1 : 0; }
    else { const h = M.hm[k]; if (!h.has) continue; gx = h.x; gy = h.y; mode = h.rm === 2 ? 2 : h.mode; }
    if (mode === 2 || mzDist(px, py, gx, gy) >= MZ_HIT) continue;
    if (mode === 1) {   // 吃掉害怕中的幽靈
      const pts = 200 << Math.min(M.chain, 3); M.chain++; M.sc += pts;
      M.pops.push({ x: gx, y: gy, t: String(pts), until: performance.now() + 900 });
      if (M.gh[k] < 0) { M.ghosts[k].eyes = true; M.ghosts[k].fr = false; } else { const h = M.hm[k]; h.mode = 2; h.saw = false; h.t = M.clock; }
      M.fz = .35;
      return;
    }
    M.lv--; M.ct[k]++; M.dead = 1.4; M.pw = 0;   // 被抓
    return;
  }
  if (M.bonus && M.bonus <= M.clock) M.bonus = 0;
}
function mzSnap(M, force) {   // 豆豆那台：快照給幽靈玩家與觀戰者
  const now = performance.now();
  if (!force && now - M.snapAt < MZ_SNAP_MS) return;
  M.snapAt = now;
  const r10 = n => Math.round(n * 10), [px, py] = mzPos(M.pac);
  const g = M.ghosts.map((e, k) => {
    if (M.gh[k] < 0) { const [x, y] = mzPos(e); return [r10(x), r10(y), e.d, e.eyes ? 2 : e.fr ? 1 : 0]; }
    const h = M.hm[k]; return [r10(h.x), r10(h.y), h.d, h.mode];
  });
  S.net?.tbl?.({ a: 'ms', p: [r10(px), r10(py), M.pac.d], g, d: mzDotsHex(M.dots), pw: Math.round(M.pw * 1000), sc: M.sc, lv: Math.max(0, M.lv), lvl: M.lvl,
    rs: M.rs, fz: Math.min(10000, Math.round(Math.max(M.fz, M.dead, M.clear) * 1000)), bn: M.bonus > M.clock ? 1 : 0 });
}
function mzGhostStep(M, dt) {   // 我是幽靈玩家：自己移動、回報位置；被吃掉就變成眼睛自動回家
  const e = M.mine;
  if (M.fz > 0) { M.fz -= dt; }
  else {
    const fr = M.myMode === 1 && !e.eyes;
    if (!e.eyes && e.p > 0 && e.want === (e.d + 2) % 4) mzReverse(e);
    mzMove(e, mzGhostSpd(M, e, fr), dt, e.eyes ? ee => mzFieldDir(ee, MZ_F_HOME, true) : mzSteer(true), true);
    if (e.eyes && e.tx === 10 && e.ty === 9 && e.p === 0) { e.eyes = false; M.reviveAt = performance.now(); }
  }
  const now = performance.now();
  if (now - M.snapAt >= MZ_SNAP_MS) {
    M.snapAt = now;
    const [x, y] = mzPos(e);
    S.net?.tbl?.({ a: 'mp', x: Math.round(x * 10), y: Math.round(y * 10), d: e.d, m: e.eyes ? 2 : 0 });
  }
}
function onNetTms(m) {   // 豆豆的快照（幽靈玩家與觀戰者才收到）
  const M = S.mz; if (!M || M.role === 'pac') return;
  M.sc = m.sc; M.lv = m.lv; M.lvl = m.lvl; M.pw = m.pw / 1000; M.bn = m.bn;
  mzDotsFromHex(m.d, M.dots);
  mzRecSet(M.rPac, m.p[0] / 10, m.p[1] / 10, m.p[2], 0);
  m.g.forEach((g, k) => mzRecSet(M.rG[k], g[0] / 10, g[1] / 10, g[2], g[3]));
  if (m.fz > 0) M.fzShow = m.fz / 1000;
  if (M.role === 'ghost') {
    const mine = m.g[M.myK], e = M.mine;
    if (m.rs !== M.rs) {   // 豆豆被抓後／過關：回起點、凍結
      M.rs = m.rs; M.mine = mzEnt(...MZ_GHOST0[M.myK], -1); M.mine.want = e.want; M.fz = Math.max(M.fz, m.fz / 1000);
    } else {
      if (m.fz > 0) M.fz = Math.max(M.fz, m.fz / 1000);
      if (mine[3] === 2 && !e.eyes && performance.now() - M.reviveAt > 1000) e.eyes = true;   // 被豆豆吃掉了
    }
    M.myMode = mine[3];
  } else M.rs = m.rs;
}
function onNetTmp(m) {   // 幽靈玩家的位置（k＝第幾隻幽靈）
  const M = S.mz; if (!M || m.k < 0 || m.k > 3) return;
  if (M.role === 'pac') {
    const h = M.hm[m.k];
    h.x = m.x / 10; h.y = m.y / 10; h.d = m.d; h.rm = m.m; h.has = true;
    if (h.mode === 2) { if (m.m === 2) h.saw = true; else if (h.saw) { h.mode = 0; h.saw = false; } }   // 看過「眼睛」之後又回到一般＝回到家復活了
  } else if (m.k !== M.myK) mzRecSet(M.rH[m.k], m.x / 10, m.y / 10, m.d, m.m);
}
function mzKey(e) {   // 遊戲畫面開著時的按鍵（回 true＝已處理）
  const M = S.mz, d = MZ_KEYS[e.key.toLowerCase()];
  if (!M || d == null || M.role === 'spec') return false;
  e.preventDefault();
  (M.role === 'pac' ? M.pac : M.mine).want = d;
  return true;
}
function mzFrame(ts) {
  const M = S.mz, v = S.tableView;
  if (!M || !S.tableOpen || !v || v.phase !== 'playing' || v.game !== 'maze') { S.mzRaf = 0; if (S.tableOpen && v?.game === 'maze') buildTable(); return; }
  S.mzRaf = requestAnimationFrame(mzFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - M.last) / 1000)); M.last = now;
  const t = mzNow(M);
  if (t >= 0) {
    if (M.role === 'pac') { mzPacStep(M, dt); if (!M.over) mzSnap(M, false); }
    else if (M.role === 'ghost') mzGhostStep(M, dt);
  }
  if (M.fzShow > 0) M.fzShow -= dt;
  for (const r of [M.rPac, ...M.rG, ...M.rH]) mzRecStep(r, dt);
  if (M.role !== 'pac' && Math.hypot(M.rPac.tx - M.rPac.x, M.rPac.ty - M.rPac.y) > .02) M.anim += dt;
  mzDraw(M, t, v);
}
// ---- 畫面 ----
let MZ_WALLS = null;
function mzWallLayer() {   // 迷宮牆（只畫一次）：深色牆面＋貼著通道那一側的亮青色線
  if (MZ_WALLS) return MZ_WALLS;
  const c = document.createElement('canvas'); c.width = MZ_W * MZ_T; c.height = MZ_H * MZ_T;
  const g = c.getContext('2d');
  g.fillStyle = '#06101c'; g.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < MZ_H; y++) for (let x = 0; x < MZ_W; x++) {
    const ch = MZ_MAP[y][x], X = x * MZ_T, Y = y * MZ_T;
    if (ch === '-') { g.fillStyle = '#ff8ad8'; g.fillRect(X, Y + MZ_T / 2 - 2, MZ_T, 4); continue; }
    if (ch !== '#') continue;
    g.fillStyle = '#0e2a3a'; g.fillRect(X, Y, MZ_T, MZ_T);
    g.fillStyle = '#2fc8b0';
    const open = (nx, ny) => nx >= 0 && nx < MZ_W && ny >= 0 && ny < MZ_H && MZ_MAP[ny][nx] !== '#';
    if (open(x, y - 1)) g.fillRect(X, Y, MZ_T, 2);
    if (open(x, y + 1)) g.fillRect(X, Y + MZ_T - 2, MZ_T, 2);
    if (open(x - 1, y)) g.fillRect(X, Y, 2, MZ_T);
    if (open(x + 1, y)) g.fillRect(X + MZ_T - 2, Y, 2, MZ_T);
  }
  return (MZ_WALLS = c);
}
const mzPx = (x, y) => [(x + .5) * MZ_T, MZ_HUD + (y + .5) * MZ_T];
function mzDrawBean(g, x, y, d, open, scale = 1) {   // 豆豆：圓滾滾的黃色小雞（2026-11-13 使用者選的方案 B）：橘色尖嘴朝前進方向一開一合、翅膀在背後、頭上一撮呆毛
  const [cx, cy] = mzPx(x, y), s = scale, R = 8 * s, fx = d >= 0 ? MZ_DX[d] : -1, fy = d >= 0 ? MZ_DY[d] : 0, side = fx || 1;
  g.save();
  g.strokeStyle = '#f0b830'; g.lineWidth = 1.4 * s; g.beginPath(); g.moveTo(cx - side * 1 * s, cy - R + 1 * s); g.quadraticCurveTo(cx - side * 2 * s, cy - R - 3 * s, cx + side * 1 * s, cy - R - 2.5 * s); g.stroke();   // 呆毛
  g.fillStyle = '#ffd860'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#d8a020'; g.lineWidth = 1; g.stroke();
  g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.arc(cx - side * 3 * s, cy - 3.5 * s, 2 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f0b830'; g.beginPath(); g.ellipse(fx ? cx - fx * 3 * s : cx - 3.5 * s, cy + 2 * s, 3.2 * s, 2.2 * s, fx ? -.4 * fx : -.3, 0, Math.PI * 2); g.fill();   // 翅膀（背後）
  if (s > .3) {
    const eyes = fx ? [[cx + fx * 3.2 * s, cy - 2.5 * s]] : [[cx - 2.8 * s, cy - 1.5 * s + fy * 2 * s], [cx + 2.8 * s, cy - 1.5 * s + fy * 2 * s]];
    for (const [ex, ey] of eyes) {
      g.fillStyle = '#1a1a22'; g.beginPath(); g.arc(ex, ey, 1.9 * s, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ex - .6 * s, ey - .7 * s, .7 * s, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#ffa0a0'; g.beginPath(); g.ellipse(fx ? cx + fx * 4.2 * s : cx, fx ? cy + 1.6 * s : cy + fy * 1 * s + 2 * s, 1.4 * s, .9 * s, 0, 0, Math.PI * 2); g.fill();   // 腮紅
  }
  const bx = cx + (fx || 0) * 6 * s, by = cy + (fy || 0) * 6 * s, nx = -(fy || 0), ny = fx || 0, w = (.6 + 1.6 * open) * s;   // 尖嘴：嘴根在身體邊緣、往前進方向尖出去
  g.fillStyle = '#ff9a30'; g.beginPath(); g.moveTo(bx + nx * w, by + ny * w); g.lineTo(bx + (fx || 0) * 5 * s, by + (fy || 0) * 5 * s); g.lineTo(bx - nx * w, by - ny * w); g.fill();
  if (open > .5) { g.strokeStyle = '#b05a10'; g.lineWidth = .8 * s; g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + (fx || 0) * 4 * s, by + (fy || 0) * 4 * s); g.stroke(); }
  g.restore();
}
function mzDrawWisp(g, x, y, d, col, mode, flash, t) {   // 小幽靈：圓頭＋往後飄的尾巴（水滴形）；害怕時變深藍、快結束時閃白；被吃掉只剩眼睛
  const [cx, cy] = mzPx(x, y), fx = d >= 0 ? MZ_DX[d] : 0, fy = d >= 0 ? MZ_DY[d] : 1;
  const tx = d >= 0 ? -fx : 0, ty = d >= 0 ? -fy : 1, nx = -ty, ny = tx, wig = Math.sin(t * 10) * 2.5;
  g.save();
  if (mode !== 2) {
    g.fillStyle = mode === 1 ? (flash ? '#e8eeff' : '#3a4ad8') : col;
    g.beginPath();
    g.moveTo(cx + nx * 7.5, cy + ny * 7.5);
    g.quadraticCurveTo(cx + tx * 9 + nx * 4, cy + ty * 9 + ny * 4, cx + tx * 14 + nx * wig, cy + ty * 14 + ny * wig);
    g.quadraticCurveTo(cx + tx * 9 - nx * 4, cy + ty * 9 - ny * 4, cx - nx * 7.5, cy - ny * 7.5);
    g.fill();
    g.beginPath(); g.arc(cx, cy, 7.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.3)'; g.beginPath(); g.arc(cx - 2.5, cy - 3, 2, 0, Math.PI * 2); g.fill();
  }
  if (mode === 1) {   // 害怕：小小的眼睛＋波浪嘴
    g.fillStyle = flash ? '#d03a3a' : '#ffe0a0';
    g.fillRect(cx - 3.5, cy - 2.5, 2, 2); g.fillRect(cx + 1.5, cy - 2.5, 2, 2);
    g.strokeStyle = g.fillStyle; g.lineWidth = 1.2; g.beginPath();
    for (let i = 0; i <= 6; i++) { const px = cx - 4 + i * 1.33, py = cy + 2.5 + (i % 2 ? -1 : 1); i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke();
  } else {
    for (const sx of [-3, 3]) {
      const ex = cx + sx + fx * 1.5, ey = cy - 1.5 + (d >= 0 ? fy : 0) * 1.5;
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(ex, ey, 2.3, 2.8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = mode === 2 ? '#3a4ad8' : '#1a1a2a'; g.beginPath(); g.arc(ex + fx * 1.1, ey + (d >= 0 ? fy : 0) * 1.1, 1.2, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
}
function mzDraw(M, t, v) {
  const cv = $('mzCanvas'); if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now(), W = MZ_W * MZ_T;
  g.fillStyle = '#0a0e18'; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(mzWallLayer(), 0, MZ_HUD);
  if (M.clear > 0 && Math.floor(M.clear * 6) % 2) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, MZ_HUD, W, MZ_H * MZ_T); }
  // 豆子
  const pulse = .75 + .25 * Math.sin(now / 160);
  MZ_DOTS.forEach(([x, y, pw], i) => {
    if (!M.dots[i]) return;
    const [cx, cy] = mzPx(x, y);
    g.fillStyle = pw ? '#ffd04a' : '#ffe0a0'; g.beginPath(); g.arc(cx, cy, pw ? 5.5 * pulse : 2.4, 0, Math.PI * 2); g.fill();
  });
  const bonusOn = M.role === 'pac' ? M.bonus > M.clock : !!M.bn;
  if (bonusOn) {   // 獎勵果實：椰子
    const [cx, cy] = mzPx(...MZ_FRUIT);
    g.fillStyle = '#8a5a34'; g.beginPath(); g.arc(cx, cy + 1, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5a3a1e'; for (const [ox, oy] of [[-2, -1], [2, -1], [0, 2]]) { g.beginPath(); g.arc(cx + ox, cy + oy, 1.2, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#3cb45a'; g.beginPath(); g.ellipse(cx + 4, cy - 7, 5, 2, -.6, 0, Math.PI * 2); g.fill();
  }
  // 幽靈
  const fl = M.pw > 0 && M.pw < 2 && Math.floor(now / 200) % 2 === 0;
  for (let k = 0; k < 4; k++) {
    let x, y, d, mode, isMe = false;
    if (M.role === 'pac') {
      if (M.gh[k] < 0) { const e = M.ghosts[k]; [x, y] = mzPos(e); d = e.d; mode = e.eyes ? 2 : e.fr ? 1 : 0; }
      else { const h = M.hm[k]; x = h.x; y = h.y; d = h.d; mode = h.rm === 2 ? 2 : h.mode; }
    } else if (M.role === 'ghost' && k === M.myK) { const e = M.mine; [x, y] = mzPos(e); d = e.d; mode = e.eyes ? 2 : M.myMode === 1 ? 1 : 0; isMe = true; }
    else { const r = M.gh[k] >= 0 && M.rH[k].has ? M.rH[k] : M.rG[k]; x = r.x; y = r.y; d = r.d; mode = r.m === 2 || M.rG[k].m === 2 ? 2 : M.rG[k].m; }
    mzDrawWisp(g, x, y, d, MZ_GCOL[k], mode, fl, now / 1000 + k);
    const seat = M.gh[k] >= 0 ? v.seats[M.gh[k]] : null;
    if (seat || isMe) {   // 玩家控制的幽靈：頭上寫名字（自己的加白圈）
      const [cx, cy] = mzPx(x, y);
      if (isMe) { g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.5; g.setLineDash([3, 3]); g.beginPath(); g.arc(cx, cy, 12, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
      g.font = 'bold 10px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.fillStyle = isMe ? '#fff' : MZ_GCOL[k];
      const nm = isMe ? '你' : seat.name; g.strokeText(nm, cx, cy - 13); g.fillText(nm, cx, cy - 13); g.textAlign = 'left';
    }
  }
  // 豆豆
  let px, py, pd;
  if (M.role === 'pac') { [px, py] = mzPos(M.pac); pd = M.pac.d; } else { px = M.rPac.x; py = M.rPac.y; pd = M.rPac.d; }
  const dying = M.role === 'pac' && M.dead > 0;
  mzDrawBean(g, px, py, pd, (Math.sin(M.anim * 18) + 1) / 2, dying ? Math.max(0, M.dead / 1.4) : 1);
  if (M.role === 'pac' && v.mz && !v.mz.solo) { const [cx, cy] = mzPx(px, py); g.font = 'bold 10px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.fillStyle = '#fff'; g.strokeText('你', cx, cy - 14); g.fillText('你', cx, cy - 14); g.textAlign = 'left'; }
  M.pops = M.pops.filter(p => p.until > now);
  for (const p of M.pops) { const [cx, cy] = mzPx(p.x, p.y); g.font = 'bold 12px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillStyle = '#7ae8ff'; g.fillText(p.t, cx, cy - 4); g.textAlign = 'left'; }
  // 分數列
  g.fillStyle = '#121a2a'; g.fillRect(0, 0, W, MZ_HUD);
  g.font = 'bold 14px "Microsoft JhengHei"'; g.fillStyle = '#ffe08a'; g.textBaseline = 'middle';
  g.fillText(`分數 ${M.sc}`, 8, MZ_HUD / 2);
  g.textAlign = 'center';
  if (M.solo) g.fillText(`第 ${M.lvl} 關`, W / 2, MZ_HUD / 2);
  else { const rem = Math.max(0, Math.ceil(M.lim - Math.max(0, t))); g.fillStyle = rem <= 30 ? '#ff7a6a' : '#ffe08a'; g.fillText(`剩 ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`, W / 2, MZ_HUD / 2); }
  g.textAlign = 'left';
  for (let i = 0; i < Math.max(0, M.lv); i++) mzDrawBean(g, (W - 18 - i * 20) / MZ_T - .5, -1.25, 3, .3, .6);
  g.textBaseline = 'alphabetic';
  // 倒數／準備
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t));
  else if (M.role === 'pac' ? M.clear > 0 : false) msg = '過關！';
  else if (M.role === 'pac' ? (M.fz > .5 && M.dead <= 0) : M.fzShow > .5) msg = '準備！';
  else if (t < .8) msg = '開始！';
  if (M.over) msg = '結束';
  if (msg) {
    g.font = 'bold 30px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.fillStyle = '#ffe08a';
    const [cx, cy] = mzPx(10, 11); g.strokeText(msg, cx, cy + 10); g.fillText(msg, cx, cy + 10); g.textAlign = 'left';
  }
}
function buildMaze(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.mz;
  if (playing && z && (!S.mz || S.mz.key !== z.seed + ':' + z.t0)) mzStart(v);
  if (!playing) mzStop();
  const M = S.mz;
  if (M && z) {   // 幽靈玩家中途離開：那隻改由電腦控制（豆豆那台從牠最後的位置接手）
    z.gh.forEach((c, k) => {
      if (c >= 0 || M.gh[k] < 0) return;
      M.gh[k] = -1;
      if (M.role === 'pac') { const h = M.hm[k], e = mzEnt(Math.round(h.x), Math.round(h.y), -1); e.eyes = h.mode === 2; e.fr = h.mode === 1; e.rel = 0; if (mzCell(e.tx, e.ty) === '#') { e.tx = MZ_GHOST0[k][0]; e.ty = MZ_GHOST0[k][1]; } M.ghosts[k] = e; }
    });
  }
  const pacName = v.seats[v.pac]?.name || '?', solo1 = v.seats.length <= 1;
  let status;
  if (playing && M) status = M.role === 'pac' ? (M.solo ? '單人挑戰：方向鍵／WASD 移動，吃光豆子進下一關' : '你是豆豆：方向鍵／WASD 移動，吃光所有豆子就贏！') : M.role === 'ghost' ? `你是幽靈（${MZ_GNAME[M.myK]}）：方向鍵／WASD 移動，抓住豆豆！` : '觀戰中';
  else if (playing) status = '觀戰中';
  else status = v.seats.length < v.min ? `等待玩家入座（1～${v.max} 人）` : solo1 ? '1 人＝單人挑戰（分數進排行榜）；全員按「準備」就開始' : `${v.seats.length} 人對抗：${pacName} 當豆豆，其他人當幽靈；全員按「準備」就開始`;
  box.appendChild(mk('div', 'table-status' + (playing && M && M.role !== 'spec' ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing && !r.aborted) {
    box.appendChild(mk('div', 'table-result', r.text));
    if (!r.solo && r.ranking) {
      const rk = mk('div', 'dodge-rank');
      r.ranking.forEach(x => rk.appendChild(mk('div', null, `${x.role === 'pac' ? '豆豆' : '幽靈'}　${x.name}　${x.role === 'pac' ? `${x.score} 分` : `抓到 ${x.score} 次`}${x.left ? '（中途離開）' : ''}`)));
      box.appendChild(rk);
    }
  } else if (r?.aborted && !playing) box.appendChild(mk('div', 'table-result', r.text));
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分（單人）`);
  if (playing && z && !z.solo) {   // 遊戲中：座位卡片改成一行（讓迷宮放得下；名字也畫在迷宮裡）
    const roles = [`豆豆：${pacName}`, ...z.gh.map((c, k) => (c >= 0 ? `${MZ_GNAME[k]}：${v.seats[c]?.name || '?'}` : null)).filter(Boolean)];
    box.appendChild(mk('div', 'table-tag', roles.join('　') + (z.gh.some(c => c < 0) ? '　（其他幽靈由電腦控制）' : '')));
  }
  const row = mk('div', 'table-seats');
  if (!playing) v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
    const k = playing && z ? z.gh.indexOf(i) : -1;
    if (k >= 0) seat.style.borderColor = MZ_GCOL[k]; else if (i === v.pac && !solo1) seat.style.borderColor = '#7ad048';
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : '')));
    const role = solo1 && !playing ? '' : i === v.pac ? '豆豆' : k >= 0 ? `幽靈・${MZ_GNAME[k]}` : '幽靈';
    seat.appendChild(mk('div', 'table-tag', playing ? role : `${role ? role + ' · ' : ''}${s.ready ? '已準備' : '未準備'}`));
    if (!playing && !solo1 && v.role === 'seat' && v.me === 0 && i !== v.pac) {   // 桌主：指定誰當豆豆
      const b = mk('button', 'ff-btn small', '改由他當豆豆'); b.onclick = () => S.net?.tbl?.({ a: 'mpac', v: i }); seat.appendChild(b);
    }
    row.appendChild(seat);
  });
  if (!playing) { for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位')); box.appendChild(row); }
  if (!playing && !solo1) box.appendChild(mk('div', 'table-tag', v.me === 0 && v.role === 'seat' ? '你是桌主：可以指定誰當豆豆（改了大家要重新準備）' : `由桌主 ${v.seats[0]?.name || ''} 指定誰當豆豆`));
  if (playing) {
    const wrap = mk('div', 'mz-wrap'), cv = document.createElement('canvas');
    cv.id = 'mzCanvas'; cv.width = MZ_W * MZ_T; cv.height = MZ_HUD + MZ_H * MZ_T; cv.className = 'mz-canvas';
    wrap.appendChild(cv); box.appendChild(wrap);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 見習驅魔師（第十桌 t10；2026-11-12，使用者要求）：1～4 人合作。玩家在場地正中央，幽靈從四面八方飄向中央，用滑鼠畫出幽靈身上的符號消除它；
// 3 波小怪＋1 隻 Boss（Boss 有血條，一直畫符號直到血條清空）。幽靈由「伺服器給的 seed」決定性地產生（與 worker 的 mgGen、dev_server 的 mg_gen 同一套，隨機只用 dodgeHash）；
// 符號辨識（$P 點雲比對）在本機，畫對就回報 kill {i}／boss {k}，血量／擊殺／Boss 血量／勝負以伺服器為準，客戶端每秒送 sync 讓伺服器結算沒被消除的幽靈 ----
const MG_CX = 320, MG_CY = 200, MG_R0 = 390, MG_R_HIT = 28, MG_GRACE = .8, MG_WAVE_START = 3, MG_WAVE_LEN = 28, MG_WAVE_GAP = 4, MG_BOSS_START = 99, MG_HP = 5;
const MG_N_SYMS = 10, MG_SYMS = [[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6]], MG_INTERVAL = [2.6, 2.6, 2.6, 2.6], MG_SPEED = [38, 46, 55, 66], MG_WAVE_MULT = [1.0, .85, .7, 1.8];
const MG_DIFF_NAMES = ['簡易', '中等', '困難', '超難'];
const MG_SYM_NAMES = ['橫線 —', '直線 |', '圓圈 ○', '尖角 ∧', 'V 字', 'Z 字', 'U 字', '波浪 ~', 'L 字', 'M 字'];
// 符號範本（單筆畫，0～1 的方格內，y 向下）；順序＝出現的先後（越前面越容易辨識）
const MG_SYM_POLY = (() => {
  const circle = [], wave = [];
  for (let k = 0; k <= 24; k++) { const a = k / 24 * Math.PI * 2 - Math.PI / 2; circle.push([.5 + .5 * Math.cos(a), .5 + .5 * Math.sin(a)]); }
  for (let k = 0; k <= 20; k++) wave.push([k / 20, .5 - .3 * Math.sin(k / 20 * Math.PI * 2)]);
  return [[[0, .5], [1, .5]], [[.5, 0], [.5, 1]], circle, [[0, 1], [.5, 0], [1, 1]], [[0, 0], [.5, 1], [1, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [0, 1], [1, 1], [1, 0]], wave, [[0, 0], [0, 1], [1, 1]], [[0, 1], [0, 0], [.5, .65], [1, 0], [1, 1]]];
})();
// 辨識用的範本變體：真人畫的 U 有圓底／方底、寬窄不一，波浪的起伏有大有小、可能先下後上，Z 有寬窄、橫線斜、轉角圓（只用來辨識；畫在幽靈身上的還是上面那組標準形狀）
const MG_SYM_VARIANTS = (() => {
  const v = MG_SYM_POLY.map(p => [p]);
  for (const amp of [.18, .25, .32, .4]) for (const ph of [0, Math.PI]) { const w = []; for (let k = 0; k <= 20; k++) w.push([k / 20, .5 - amp * Math.sin(k / 20 * Math.PI * 2 + ph)]); v[7].push(w); }
  for (const wd of [.5, .8, 1.3, 1.7]) for (const [a1, a2] of [[1, 1], [1, .7], [.7, 1]]) v[4].push([[0, 1 - a1], [wd / 2, 1], [wd, 1 - a2]]);   // V：寬窄、兩臂不一樣長（跟 U 分開靠尖底）
  for (const wd of [.5, .8, 1.1, 1.4]) {   // U：方底（兩臂可不一樣長）、直臂＋半圓底
    for (const [a1, a2] of [[1, 1], [1, .7], [.7, 1]]) v[6].push([[0, 1 - a1], [0, 1], [wd, 1], [wd, 1 - a2]]);
    for (const L of [.25, .5]) { const r = [[0, 0], [0, L]]; for (let k = 1; k <= 12; k++) { const t = Math.PI * k / 12; r.push([wd / 2 - wd / 2 * Math.cos(t), L + wd / 2 * Math.sin(t)]); } r.push([wd, L - .3]); v[6].push(r); }
  }
  for (const dep of [.4, .6, .8, 1.1, 1.5]) { const r = []; for (let k = 0; k <= 16; k++) { const u = k / 16; r.push([u, dep * (1 - 4 * (u - .5) * (u - .5))]); } v[6].push(r); }   // 拋物線型的 U
  for (const dep of [.4, .7, 1]) { const r = []; for (let k = 0; k <= 16; k++) { const a = Math.PI * k / 16; r.push([.5 - .5 * Math.cos(a), dep * Math.pow(Math.sin(a), .6)]); } v[6].push(r); }   // 圓弧型的 U
  for (const wd of [.7, 1, 1.4]) for (const sl of [-.15, 0, .15]) for (const rd of [false, true]) {   // Z：寬窄、上下橫線有沒有斜、轉角圓不圓
    const p = [[0, 0], [wd, sl], [0, 1], [wd, 1 + sl]], cut = (A, B, f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
    v[5].push(rd ? [p[0], cut(p[0], p[1], .85), p[1], cut(p[1], p[2], .12), cut(p[1], p[2], .88), p[2], cut(p[2], p[3], .15), p[3]] : p);
  }
  // O：真人畫的圓常是橢圓、沒收口（缺一塊）、畫過頭（多繞一點）——不加這些會被當成 U
  const arcPts = (rx, ry, a0, len, n = 28, shrink = 0) => { const r = []; for (let k = 0; k <= n; k++) { const t = a0 + len * k / n, f = 1 - shrink * k / n; r.push([.5 + rx * f * Math.cos(t), .5 + ry * f * Math.sin(t)]); } return r; };
  for (const [rx, ry] of [[.3, .5], [.4, .5], [.5, .4], [.5, .3]]) v[2].push(arcPts(rx, ry, -Math.PI / 2, Math.PI * 2));   // 橢圓（直扁、橫扁）
  for (const gap of [-90, -45, 0, 45, 90, 135, 180, -135]) for (const [rx, ry] of [[.5, .5], [.4, .5]]) v[2].push(arcPts(rx, ry, (gap + 20) * Math.PI / 180, Math.PI * 2 * .86));   // 沒收口：缺 14%，缺口在各個方向
  v[2].push(arcPts(.5, .5, -Math.PI / 2, Math.PI * 2 * 1.18, 34, .12));   // 畫過頭：多繞一點、半徑略縮（螺旋）
  v[2].push(arcPts(.5, .5, Math.PI / 2, Math.PI * 2 * 1.18, 34, .12));
  // L：夾角不是剛好 90 度、腳比腿長或短、轉角圓
  for (const ang of [-.28, 0, .28]) for (const foot of [.5, .7, 1.4, 1.9]) for (const rd of [false, true]) {
    const A = [0, 0], B = [Math.sin(ang) * .15, 1], C = [B[0] + foot * Math.cos(ang), B[1] - foot * Math.sin(ang)], cutL = (P, Q, f) => [P[0] + (Q[0] - P[0]) * f, P[1] + (Q[1] - P[1]) * f];
    v[8].push(rd ? [A, cutL(A, B, .85), cutL(A, B, .94), cutL(B, C, Math.min(.5, .12 / foot)), cutL(B, C, Math.min(.7, .24 / foot)), C] : [A, B, C]);
  }
  // Z 再加：很寬很扁（寬高比到 2.3）、很窄很高（0.6）——一個人可能畫得扁扁的或瘦瘦的
  for (const wd of [.6, 1.9, 2.3]) for (const sl of [-.12, 0, .12]) for (const rd of [false, true]) {
    const p = [[0, 0], [wd, sl], [0, 1], [wd, 1 + sl]], cutZ = (A, B, f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
    v[5].push(rd ? [p[0], cutZ(p[0], p[1], .85), p[1], cutZ(p[1], p[2], .12), cutZ(p[1], p[2], .88), p[2], cutZ(p[2], p[3], .15), p[3]] : p);
  }
  // Z 再加：斜體（整個向右傾斜）、上下橫線不一樣長
  for (const sk of [-.3, .3]) for (const wd of [.6, 1]) v[5].push([[0 + sk * 0, 0], [wd, 0], [0 - sk * 0 + sk, 1], [wd + sk, 1]].map(([x, y], i) => [i < 2 ? x : x - sk, y]).map(([x, y]) => [x + sk * y, y]));
  for (const [w1, w2] of [[1, .6], [.6, 1]]) v[5].push([[0, 0], [w1, 0], [0, 1], [w2, 1]]);
  // M：中間的谷深淺不一、外腳外八或收攏、尖或圓
  for (const dep of [.3, .6, 1]) for (const sp of [0, .2]) for (const rd of [false, true]) {
    const P = [[0, 1], [sp * .3, 0], [.5, dep], [1 - sp * .3, 0], [1, 1]];
    if (!rd) { v[9].push(P); continue; }
    const q = []; for (let i = 1; i < P.length; i++) for (let k = 0; k < 6; k++) q.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * k / 6, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * k / 6]);
    q.push(P[4]); v[9].push(q.map((p, i, arr) => (i > 0 && i < arr.length - 1 ? [(arr[i - 1][0] + p[0] * 2 + arr[i + 1][0]) / 4, (arr[i - 1][1] + p[1] * 2 + arr[i + 1][1]) / 4] : p)));
  }
  return v;
})();
const MG_PTS = 32;
function mgResample(pts, n = MG_PTS) {   // 沿路徑等距取 n 點
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len <= 0) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const step = len / (n - 1), out = [[pts[0][0], pts[0][1]]], p = pts.map(q => [q[0], q[1]]); let acc = 0;
  for (let i = 1; i < p.length; i++) {
    let d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d, q = [p[i - 1][0] + t * (p[i][0] - p[i - 1][0]), p[i - 1][1] + t * (p[i][1] - p[i - 1][1])];
      out.push(q); p.splice(i, 0, q); d = Math.hypot(p[i + 1][0] - q[0], p[i + 1][1] - q[1]); acc = 0; i++;
    }
    acc += d;
  }
  while (out.length < n) out.push([p[p.length - 1][0], p[p.length - 1][1]]);
  return out;
}
function mgNormalize(pts) {   // 等比例縮放到最大邊＝1、質心移到原點
  const r = mgResample(pts);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const q of r) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  const s = Math.max(x1 - x0, y1 - y0, 1e-6); let cx = 0, cy = 0;
  const n = r.map(q => [(q[0] - x0) / s, (q[1] - y0) / s]); for (const q of n) { cx += q[0]; cy += q[1]; }
  cx /= n.length; cy /= n.length; return n.map(q => [q[0] - cx, q[1] - cy]);
}
function mgCloud(a, b, start) {   // $P：貪婪點雲距離
  const n = a.length, used = new Array(n).fill(false); let sum = 0, i = start;
  do {
    let best = 1e9, bj = -1; for (let j = 0; j < n; j++) if (!used[j]) { const d = Math.hypot(a[i][0] - b[j][0], a[i][1] - b[j][1]); if (d < best) { best = d; bj = j; } }
    used[bj] = true; sum += (1 - ((i - start + n) % n) / n) * best; i = (i + 1) % n;
  } while (i !== start);
  return sum;
}
let MG_TMPL = null;
function mgRecognize(points) {   // 回傳 {id, d, second}（d 越小越像）或 null（太短）；筆畫太短就不辨識
  if (points.length < 4) return null;
  let len = 0; for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  if (len < 40) return null;
  if (!MG_TMPL) MG_TMPL = MG_SYM_VARIANTS.map(vs => vs.map(p => mgNormalize(p)));
  const q = mgNormalize(points), step = Math.floor(Math.sqrt(MG_PTS)), res = [];
  MG_TMPL.forEach((vs, id) => { let d = 1e9; for (const t of vs) for (let i = 0; i < MG_PTS; i += step) d = Math.min(d, mgCloud(q, t, i), mgCloud(t, q, i)); res.push({ id, d }); });
  res.sort((a, b) => a.d - b.d);
  if ((res[0].id === 4 && res[1].id === 6) || (res[0].id === 6 && res[1].id === 4)) {   // U 和 V 很像：看底部寬不寬（U 的底是平的／圓的，V 是尖的）
    let y0 = 1e9, y1 = -1e9, x0 = 1e9, x1 = -1e9; for (const p of points) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
    const band = y1 - (y1 - y0) * .2; let bx0 = 1e9, bx1 = -1e9; for (const p of points) if (p[1] >= band) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); }
    const wide = (bx1 - bx0) / Math.max(1, x1 - x0) >= MG_UV_BAND;
    return { id: wide ? 6 : 4, d: Math.min(res[0].d, res[1].d), second: res[2].d };
  }
  return { id: res[0].id, d: res[0].d, second: res[1].d };
}
const MG_UV_BAND = 0.32;   // U／V 分辨：筆畫最底下 20% 高度內，點的橫向範圍佔整個筆畫寬度的比例，≥ 這個值就是 U（底是平的或圓的），否則是 V（尖底）
const MG_ACCEPT = 2.6, MG_MARGIN = 0.85, MG_GAP = 0.15;   // 接受門檻（點雲距離總和，越小越像）與「第一名比第二名好多少」的最小比例（太接近＝不確定，不判）
function mgGenC(g, upto) {   // 客戶端的幽靈產生器（與 worker mgGen 同一套；多算了 sp、ang 供畫面用）
  const d = g.diff, n = g.n, seed = g.seed;
  for (;;) {
    let t = g.cur;
    if (t < MG_BOSS_START) {
      const k = Math.floor((t - MG_WAVE_START) / (MG_WAVE_LEN + MG_WAVE_GAP));
      if ((t - MG_WAVE_START) - k * (MG_WAVE_LEN + MG_WAVE_GAP) >= MG_WAVE_LEN) t = MG_WAVE_START + (k + 1) * (MG_WAVE_LEN + MG_WAVE_GAP);
    }
    if (t >= MG_BOSS_START && t < MG_BOSS_START + 2) t = MG_BOSS_START + 2;
    g.cur = t;
    if (t > upto) return;
    const i = g.gh.length, w = t >= MG_BOSS_START ? 3 : Math.floor((t - MG_WAVE_START) / (MG_WAVE_LEN + MG_WAVE_GAP));
    const m = w === 3 ? MG_SYMS[d][0] : MG_SYMS[d][w];
    const h = j => dodgeHash(seed, 10000 + i * 16 + j), u = j => h(j) / 4294967296;
    const sp = MG_SPEED[d] * (0.85 + 0.3 * u(2)) * (w === 3 ? 0.9 : 1.0) / (1 + 0.3 * (m - 1));
    g.gh.push({ i, ts: t, syms: Array.from({ length: m }, (_, j) => h(8 + j) % MG_N_SYMS), sp, arr: t + (MG_R0 - MG_R_HIT) / sp, ang: (w === 3 || t + (MG_R0 - 82) / sp > MG_BOSS_START) ? -Math.PI / 4 + u(0) * Math.PI * 1.5 : u(0) * Math.PI * 2, w });   // 不從正上方（Boss 在那裡，會被蓋住）出來、避開上方 90 度的扇形：Boss 戰的小鬼，以及出場後還會飛過 Boss 位置（上方距中心 82 以外）的小鬼（2026-11-13）
    g.cur = t + MG_INTERVAL[d] * MG_WAVE_MULT[w] / (1 + 0.5 * (n - 1)) * (0.7 + 0.6 * u(4)) * (1 + 0.3 * (m - 1));
  }
}
const mgBossSymC = (seed, k, diff) => dodgeHash(seed, 5000 + k) % MG_N_SYMS;
function mgStart(v) {   // 一局開始：重置本機狀態
  const m = v.mg;
  S.mg = { id: S.tableId, seed: m.seed, t0: m.t0, off: m.sn - Date.now(), diff: m.diff, n: m.n, g: { seed: m.seed, diff: m.diff, n: m.n, cur: MG_WAVE_START, gh: [] },
    localKilled: new Set(), localProg: new Map(), lastDmg: 0, shake: 0, stroke: null, fb: null, flash: 0, lastHp: null, lastSync: 0, fx: [], bossLocal: 0, bossAt: 0, hitFlash: 0 };
  if (!S.mgRaf) S.mgRaf = requestAnimationFrame(mgFrame);
}
function mageStop() { S.mg = null; if (S.mgRaf) { cancelAnimationFrame(S.mgRaf); S.mgRaf = 0; } }
const mgNow = () => (Date.now() + S.mg.off - S.mg.t0) / 1000;
function mgDrawSym(g, id, cx, cy, size, col, lw = 2) {   // 把符號範本畫在 (cx,cy) 為中心、邊長 size 的方格內
  const p = MG_SYM_POLY[id]; g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
  p.forEach((q, k) => { const x = cx + (q[0] - .5) * size, y = cy + (q[1] - .5) * size; if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
}
function mgFrame() {
  const M = S.mg, v = S.tableView;
  if (!M || !S.tableOpen || !v || v.phase !== 'playing' || v.game !== 'mage') { S.mgRaf = 0; if (S.tableOpen && v?.game === 'mage') buildTable(); return; }
  S.mgRaf = requestAnimationFrame(mgFrame);
  const t = mgNow(), mySeat = v.role === 'seat' ? v.seats[v.me] : null;
  mgGenC(M.g, Math.max(0, t) + 12);
  if (v.mg && v.mg.dmg > M.lastDmg) { M.lastDmg = v.mg.dmg; M.shake = performance.now() + 350; mgSay('−1', '#ff7a7a', 320, 118); }
  if (mySeat) { if (M.lastHp != null && mySeat.hp < M.lastHp) M.hitFlash = .4; M.lastHp = mySeat.hp; }
  M.hitFlash = Math.max(0, M.hitFlash - .016);
  if (t >= 0 && performance.now() - M.lastSync > 1000) { M.lastSync = performance.now(); S.net?.tbl?.({ a: 'sync' }); }   // 讓伺服器結算沒被消除的幽靈
  M.t = t; M.vis = v.mg ? mgGhostsNow(t, v.mg) : []; M.bossId = v.mg && mgBossActive(t, v.mg) ? mgBossSymC(M.seed, performance.now() - M.bossAt < 1500 ? Math.max(v.mg.hits, M.bossLocal) : v.mg.hits, M.diff) : -1;   // （自動測試與除錯用：目前時間、場上幽靈、Boss 目前的符號）
  mgDraw(t, mySeat);
  const tm = $('mgTime'); if (tm) tm.textContent = t < 0 ? `開始倒數 ${Math.ceil(-t)}` : t < MG_BOSS_START ? `第 ${Math.min(3, Math.floor((t - MG_WAVE_START) / (MG_WAVE_LEN + MG_WAVE_GAP)) + 1)} 波` : 'BOSS';
}
const mgProg = (M, m, i) => Math.max(((m.prog || []).find(x => x[0] === i) || [0, 0])[1], M.localProg.get(i) || 0);   // 幽靈 i 已畫完幾個符號（伺服器的與本機預測的取大）
function mgBossActive(t, m) { return t >= MG_BOSS_START + 1.5 && m && m.dmg < m.boss; }
function mgGhostsNow(t, m) {   // 目前在場上的幽靈（還沒被消除、還沒抵達太久）
  const M = S.mg, killed = new Set(m.killed || []);
  return M.g.gh.filter(x => x.ts <= t && x.arr + .25 > t && !killed.has(x.i) && !M.localKilled.has(x.i));
}
function mgDraw(t, mySeat) {
  const cv = $('mgCanvas'); if (!cv) return;
  const g = cv.getContext('2d'), M = S.mg, v = S.tableView, m = v.mg, now = performance.now();
  const shaking = M.shake > now, sh = shaking ? (M.shake - now) / 350 * 7 : 0;
  g.save(); if (shaking) g.translate((Math.random() - .5) * 2 * sh, (Math.random() - .5) * 2 * sh);   // 打中 Boss：畫面震動
  g.fillStyle = '#0b0a1a'; g.fillRect(-10, -10, 660, 420);
  const grad = g.createRadialGradient(MG_CX, MG_CY, 10, MG_CX, MG_CY, 300); grad.addColorStop(0, 'rgba(120,90,220,.28)'); grad.addColorStop(1, 'rgba(10,10,26,0)'); g.fillStyle = grad; g.fillRect(0, 0, 640, 400);
  g.strokeStyle = 'rgba(160,130,255,.25)'; g.lineWidth = 1; g.beginPath(); g.arc(MG_CX, MG_CY, MG_R_HIT, 0, 6.2832); g.stroke();
  // 幽靈：有臉；要畫的符號飄在頭上（一隻有好幾個就排成一列，畫完的變暗、目前要畫的亮黃色）
  g.textAlign = 'center';
  for (const x of mgGhostsNow(t, m)) {
    const r = MG_R0 - x.sp * (t - x.ts), px = MG_CX + Math.cos(x.ang) * r, py = MG_CY + Math.sin(x.ang) * r;
    if (px < -40 || px > 680 || py < -50 || py > 440) continue;
    const near = r < 130, bob = Math.sin(t * 3 + x.i) * 2, gy = py + bob, prog = mgProg(M, m, x.i);
    g.fillStyle = near ? '#ffd8e0' : '#e8ecff'; g.beginPath(); g.arc(px, gy - 2, 15, Math.PI, 0); g.lineTo(px + 15, gy + 12);
    for (let k = 3; k >= -3; k--) g.lineTo(px + k * 5, gy + 12 + (k % 2 ? 0 : 4)); g.lineTo(px - 15, gy + 12); g.closePath(); g.fill();
    g.fillStyle = '#20204a';   // 眼睛與嘴巴（靠近中央時變成生氣的臉）
    g.beginPath(); g.arc(px - 5, gy - 3, 2.4, 0, 6.2832); g.arc(px + 5, gy - 3, 2.4, 0, 6.2832); g.fill();
    if (near) { g.strokeStyle = '#c02040'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px - 9, gy - 9); g.lineTo(px - 2, gy - 6); g.moveTo(px + 9, gy - 9); g.lineTo(px + 2, gy - 6); g.stroke(); g.fillStyle = '#c02040'; g.beginPath(); g.ellipse(px, gy + 6, 3.5, 2.6, 0, 0, 6.2832); g.fill(); }
    else { g.strokeStyle = '#20204a'; g.lineWidth = 1.5; g.beginPath(); g.arc(px, gy + 3, 3, .15, Math.PI - .15); g.stroke(); }
    const n = x.syms.length, sz = 17, gap = 3, w0 = n * sz + (n - 1) * gap, y0 = gy - 32;
    g.fillStyle = 'rgba(12,8,30,.72)'; g.beginPath(); g.roundRect ? g.roundRect(px - w0 / 2 - 3, y0 - sz / 2 - 3, w0 + 6, sz + 6, 5) : g.rect(px - w0 / 2 - 3, y0 - sz / 2 - 3, w0 + 6, sz + 6); g.fill();
    x.syms.forEach((id, k) => { const sx = px - w0 / 2 + sz / 2 + k * (sz + gap); mgDrawSym(g, id, sx, y0, sz - 4, k < prog ? 'rgba(160,160,180,.35)' : k === prog ? '#ffe08a' : '#b8c0ff', k === prog ? 2.4 : 1.6); });
  }
  // Boss
  if (t >= MG_BOSS_START && m) {
    const bx = MG_CX, by = 78, hpFrac = Math.max(0, (m.boss - m.dmg) / m.boss), enter = Math.min(1, (t - MG_BOSS_START) / 1.5), wob = Math.sin(t * 2) * 4;
    const hurt = M.shake > now; g.globalAlpha = enter; g.fillStyle = hurt ? '#ff4a4a' : '#7a2a8a'; g.beginPath(); g.arc(bx + (hurt ? (Math.random() - .5) * 6 : 0), by + wob, 38, Math.PI, 0); g.lineTo(bx + 38, by + wob + 34);
    for (let k = 4; k >= -4; k--) g.lineTo(bx + k * 9.5, by + wob + 34 + (k % 2 ? 0 : 8)); g.lineTo(bx - 38, by + wob + 34); g.closePath(); g.fill();
    g.fillStyle = '#ffe08a'; g.beginPath(); g.arc(bx - 13, by + wob - 2, 6, 0, 6.2832); g.arc(bx + 13, by + wob - 2, 6, 0, 6.2832); g.fill();
    g.fillStyle = '#2a0a30'; g.beginPath(); g.arc(bx - 13, by + wob - 1, 2.5, 0, 6.2832); g.arc(bx + 13, by + wob - 1, 2.5, 0, 6.2832); g.fill();
    g.strokeStyle = '#2a0a30'; g.lineWidth = 2; g.beginPath(); if (hurt) { g.arc(bx, by + wob + 16, 7, Math.PI, 0); } else { g.arc(bx, by + wob + 10, 8, .2, Math.PI - .2); } g.stroke();   // 嘴（受傷時張嘴）
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(160, 10, 320, 12); g.fillStyle = hpFrac > .3 ? '#d84a6a' : '#ff9a3a'; g.fillRect(161, 11, 318 * hpFrac, 10);
    g.strokeStyle = '#ffe08a'; g.lineWidth = 1; g.strokeRect(160.5, 10.5, 319, 11);
    if (mgBossActive(t, m)) {   // 目前要畫的符號
      const k = performance.now() - M.bossAt < 1500 ? Math.max(m.hits, M.bossLocal) : m.hits, id = mgBossSymC(M.seed, k, M.diff);
      g.fillStyle = 'rgba(20,10,40,.85)'; g.beginPath(); g.arc(bx, by + 56 + wob, 21, 0, 6.2832); g.fill(); g.strokeStyle = '#ffe08a'; g.lineWidth = 2; g.stroke();
      mgDrawSym(g, id, bx, by + 56 + wob, 22, '#ffe08a', 3);
    }
  }
  // 中央的驅魔師們
  const al = v.seats.length;
  v.seats.forEach((s, i) => {
    const a = al > 1 ? i / al * 6.2832 - 1.5708 : 0, px = MG_CX + (al > 1 ? Math.cos(a) * 11 : 0), py = MG_CY + (al > 1 ? Math.sin(a) * 11 : 0), col = DG_COLORS[i % 8], dead = s.dead || s.left;
    g.globalAlpha = dead ? .3 : 1; g.fillStyle = col; g.beginPath(); g.arc(px, py - 4, 6, 0, 6.2832); g.fill();
    g.fillStyle = dead ? '#777' : '#e8e4f4'; g.beginPath(); g.moveTo(px - 8, py + 8); g.lineTo(px, py - 4); g.lineTo(px + 8, py + 8); g.closePath(); g.fill();   // 魔法袍
    g.fillStyle = dead ? '#777' : '#f4f0e0'; g.fillRect(px - 4, py - 15, 8, 11); g.fillStyle = dead ? '#777' : '#d02a2a'; g.fillRect(px - 1, py - 14, 2, 8);   // 額頭的符紙
    g.globalAlpha = 1;
  });
  // 筆跡與回饋
  if (M.stroke && M.stroke.length > 1) { g.strokeStyle = 'rgba(255,240,150,.9)'; g.lineWidth = 3; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath(); M.stroke.forEach((q, k) => { if (k) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke(); }
  for (const f of M.fx) { const a = Math.max(0, 1 - (performance.now() - f.at) / 700); if (a <= 0) continue; g.globalAlpha = a; g.fillStyle = f.col; g.font = 'bold 16px "Microsoft JhengHei"'; g.fillText(f.text, f.x, f.y - (1 - a) * 24); g.globalAlpha = 1; }
  M.fx = M.fx.filter(f => performance.now() - f.at < 700);
  if (M.hitFlash > 0) { g.fillStyle = `rgba(255,60,60,${M.hitFlash})`; g.fillRect(0, 0, 640, 400); }
  if (M.shake > now) { g.fillStyle = `rgba(255,40,40,${(M.shake - now) / 350 * .22})`; g.fillRect(0, 0, 640, 400); }   // 打中 Boss：畫面泛紅
  g.restore();
  if (t < 0) { g.fillStyle = 'rgba(8,10,20,.55)'; g.fillRect(0, 0, 640, 400); g.fillStyle = '#ffe08a'; g.font = 'bold 56px "Microsoft JhengHei"'; g.fillText(String(Math.ceil(-t)), MG_CX, MG_CY + 18); }
  if (mySeat?.dead && v.role === 'seat') { g.fillStyle = 'rgba(8,10,20,.5)'; g.fillRect(0, MG_CY - 28, 640, 56); g.fillStyle = '#ffb347'; g.font = 'bold 22px "Microsoft JhengHei"'; g.fillText('你倒下了（隊友還在戰鬥）', MG_CX, MG_CY + 8); }
}
function mgPointer(e, type) {   // 在場地上按住滑鼠畫符號；放開時辨識
  const M = S.mg, v = S.tableView; if (!M || !v || v.phase !== 'playing') return;
  const cv = $('mgCanvas'); if (!cv) return;
  const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * 640 / r.width, y = (e.clientY - r.top) * 400 / r.height;
  const me = v.role === 'seat' ? v.seats[v.me] : null;
  if (type === 'down') { if (!me || me.dead) return; M.stroke = [[x, y]]; cv.setPointerCapture?.(e.pointerId); }
  else if (type === 'move') { if (M.stroke) { const l = M.stroke[M.stroke.length - 1]; if (Math.hypot(x - l[0], y - l[1]) >= 2) M.stroke.push([x, y]); } }
  else if (M.stroke) { const pts = M.stroke; M.stroke = null; mgAct(pts, x, y); }
}
function mgSay(text, col, x, y) { S.mg.fx.push({ text, col, x: Math.max(60, Math.min(580, x)), y, at: performance.now() }); }
function mgAct(pts, ex, ey) {   // 辨識筆畫 → 消除幽靈或打 Boss
  const M = S.mg, v = S.tableView, m = v.mg, t = mgNow(); if (!m || t < 0) return;
  const rec = mgRecognize(pts); if (!rec) return;
  if (rec.d > MG_ACCEPT || !(rec.d <= rec.second * MG_MARGIN || rec.second - rec.d >= MG_GAP)) { mgSay('？', '#ff9a9a', ex, ey); return; }   // 太不像、或和第二名差不多（不確定）就不判
  const id = rec.id, bossOn = mgBossActive(t, m), bossK = performance.now() - M.bossAt < 1500 ? Math.max(m.hits, M.bossLocal) : m.hits;
  const cands = mgGhostsNow(t, m).filter(x => x.syms[mgProg(M, m, x.i)] === id).sort((a, b) => a.arr - b.arr);   // 場上「目前要畫的符號就是你畫的」的幽靈：全部一起消除（2026-11-13，使用者要求）
  const hitBoss = bossOn && id === mgBossSymC(M.seed, bossK, M.diff);   // Boss 現在要的符號也一樣就一起打（不再因為有快到的幽靈而讓位）
  if (hitBoss) {
    M.bossLocal = bossK + 1; M.bossAt = performance.now(); M.shake = performance.now() + 350; M.lastDmg = Math.max(M.lastDmg, m.dmg + 1);
    S.net?.tbl?.({ a: 'boss', k: bossK }); mgSay('命中 Boss！', '#ffe08a', MG_CX, 150);
  }
  for (const gh of cands) {   // 每隻各送一則 kill（伺服器逐隻驗證，規則沒變；每條連線每秒 40 則的上限遠大於場上同時出現的幽靈數）
    const r = MG_R0 - gh.sp * (t - gh.ts), p = mgProg(M, m, gh.i);
    M.localProg.set(gh.i, p + 1); if (p + 1 >= gh.syms.length) M.localKilled.add(gh.i);
    S.net?.tbl?.({ a: 'kill', i: gh.i, p });
    mgSay(p + 1 >= gh.syms.length ? '✦' : '✧', '#9affb8', MG_CX + Math.cos(gh.ang) * r, MG_CY + Math.sin(gh.ang) * r - 30);
  }
  if (!hitBoss && !cands.length) mgSay('沒有這個符號的幽靈', '#bbbbbb', ex, ey);
}
function buildMage(box, v, mk, gd) {
  const playing = v.phase === 'playing', mySeat = v.role === 'seat' ? v.seats[v.me] : null, diff = v.diff || 0;
  if (playing && (!S.mg || S.mg.id !== S.tableId || S.mg.t0 !== v.mg?.t0)) mgStart(v);
  if (!playing) mageStop();
  let status;
  if (playing) status = mySeat ? (mySeat.dead ? '你倒下了' : `${MG_DIFF_NAMES[v.mg?.diff ?? diff]}模式：按住滑鼠畫出幽靈身上的符號消除它，別讓幽靈碰到中央`) : '觀戰中';
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.appendChild(mk('div', 'table-status' + (playing && mySeat && !mySeat.dead ? ' mine' : ''), status));
  if (v.result && !playing) {
    box.appendChild(mk('div', 'table-result', v.result.text));
    const rk = mk('div', 'dodge-rank');
    v.result.ranking.forEach((r, i) => rk.appendChild(mk('div', null, `${r.name}　畫對 ${r.syms} 個符號　${r.dead ? '倒下' : `剩 ${r.hp} 滴血`}${r.left ? '（中途離開）' : ''}`)));
    if (v.result.win) rk.appendChild(mk('div', null, `本局分數：${v.result.score}${v.result.solo ? '（單人，記入排行榜）' : '（多人不進排行榜）'}`));
    box.appendChild(rk);
  }
  if (!playing) {
    const dr = mk('div', 'table-btns'); dr.appendChild(mk('span', 'table-tag', '難度：'));
    MG_DIFF_NAMES.forEach((nm, k) => { const b = mk('button', 'ff-btn small' + (diff === k ? ' active' : ''), nm); if (v.role === 'seat' && v.me === 0) b.onclick = () => S.net?.tbl?.({ a: 'mdiff', v: k }); else b.disabled = true; dr.appendChild(b); });
    box.appendChild(dr);
    if (v.role !== 'seat' || v.me !== 0) box.appendChild(mk('div', 'table-tag', '難度由桌主（第一位入座的人）選擇'));
    boardBlock(box, v, mk, sc => `${sc} 分`);
    box.appendChild(mk('div', 'table-tag', '排行榜只記單人模式的勝利分數'));
  }
  const row = mk('div', 'table-seats dodge-seats');
  v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && s.dead ? ' out' : ''));
    seat.style.borderColor = playing ? DG_COLORS[i % 8] : '';
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : '')));
    seat.appendChild(mk('div', 'table-tag', playing ? (s.dead ? `倒下 · 擊殺 ${s.kills}` : '♥'.repeat(Math.max(0, s.hp)) + '♡'.repeat(Math.max(0, MG_HP - s.hp)) + ` · 擊殺 ${s.kills}`) : (s.ready ? '已準備' : '未準備')));
    row.appendChild(seat);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  if (playing) {
    const wrap = mk('div', 'dodge-wrap'), cv = document.createElement('canvas');
    cv.id = 'mgCanvas'; cv.width = 640; cv.height = 400; cv.className = 'dodge-canvas'; cv.style.touchAction = 'none'; cv.style.cursor = 'crosshair';
    cv.onpointerdown = e => { e.preventDefault(); mgPointer(e, 'down'); }; cv.onpointermove = e => mgPointer(e, 'move'); cv.onpointerup = e => mgPointer(e, 'up'); cv.onpointercancel = e => mgPointer(e, 'up');
    wrap.appendChild(cv); wrap.appendChild(mk('div', 'dodge-time')); wrap.lastChild.id = 'mgTime';
    box.appendChild(wrap);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 英文打字競賽（第七桌 t7）：題目由「伺服器給的 seed」決定性地從 games.json 的 typing.words 抽（大家同一串單字）；
// 打字判定、錯字鎖定 0.7 秒都在本機，每打完一個字回報 word {n}（n＝目前總分），其他人的分數由 tsc 訊息轉發；時間到後送 finish 請伺服器結算 ----
const TY_LOCK_MS = 700;      // 打錯後不能輸入的時間（使用者定）
const TY_PROG_GAP_MS = 250;   // 兩次打字進度回報（給觀戰者看）的最短間隔；伺服器的限流是 200ms
const TY_SEND_GAP_MS = 70;   // 兩次分數回報的最短間隔（伺服器的限流是 60ms；太快的那次留給下一個 tick 補送）
const TY_SETTLE_S = 1;       // 時間到後多久才請伺服器結算（與伺服器的 TY_SETTLE_MS 一致：讓最後一個字的回報先到）
function typingWords(seed, game = 'typing') {   // 同一個 seed 永遠產生同一串單字（中文打字競賽＝zhtyping.words 的詞）；不會連續出同一個字
  const words = gameDef(game)?.words || ['typing'], rng = mulberry32(seed >>> 0), list = [];
  return k => {
    while (list.length <= k) {
      let w = words[Math.floor(rng() * words.length)];
      if (words.length > 1 && w === list[list.length - 1]) w = words[(words.indexOf(w) + 1) % words.length];
      list.push(w);
    }
    return list[k];
  };
}
function typingStart(v) {   // 一局開始（伺服器給了 ty）：重置本機狀態
  typingStop();
  S.ty = {
    id: S.tableId, t0: v.ty.t0, dur: v.ty.dur, off: v.ty.sn - Date.now(),   // off：伺服器時間 − 本機時間（毫秒，忽略單程延遲）
    game: v.game, zh: v.game === 'zhtyping', word: typingWords(v.ty.seed, v.game), idx: 0, pos: 0, score: 0, sent: 0, lastSend: 0, lockUntil: 0, errPos: -1,
    finishAt: 0, ime: false, scores: v.seats.map(s => s.score || 0), wordKey: '',
  };
  S.ty.timer = setInterval(typingTick, 100);
}
function typingStop() { if (S.ty?.timer) clearInterval(S.ty.timer); S.ty = null; }
const typingNow = () => (Date.now() + S.ty.off - S.ty.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function typingSend() {   // 有還沒回報的分數就送（太快的留給 tick 補送）
  const T = S.ty;
  if (!T || T.score <= T.sent || performance.now() - T.lastSend < TY_SEND_GAP_MS) return;
  T.lastSend = performance.now(); T.sent = T.score;
  S.net?.tbl?.({ a: 'word', n: T.score });
}
function typingKey(e) {
  const T = S.ty, v = S.tableView;
  if (!T || !v || v.role !== 'seat' || v.phase !== 'playing') return;
  if (T.zh) return;   // 中文打字：交給輸入框（輸入法），不攔截按鍵
  if (e.key === 'Process' || e.isComposing) { T.ime = true; typingRender(); return; }   // 中文輸入法開著：提示切換成英文
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  e.preventDefault();
  const t = typingNow();
  if (t < 0 || t >= T.dur || performance.now() < T.lockUntil) return;   // 倒數中、時間到、打錯鎖定中
  T.ime = false;
  const w = T.word(T.idx), ch = e.key.toLowerCase();
  if (ch === w[T.pos]) {
    T.pos++; T.errPos = -1;
    if (T.pos >= w.length) { T.idx++; T.pos = 0; T.score++; if (v.me >= 0) T.scores[v.me] = T.score; typingSend(); }   // 打完最後一個字母：自動得分、換下一個字
  } else { T.lockUntil = performance.now() + TY_LOCK_MS; T.errPos = T.pos; T.wordKey = ''; S.net?.tbl?.({ a: 'miss' }); }   // 打錯（並通知對手的畫面閃紅）：該打的字母變紅震動，鎖 0.7 秒；不用刪除
  typingRender();
}
// 中文打字競賽：輸入框收到「輸入法送出的文字」（不含組字中）才比對；對得上題目的前綴就算打對的部分，整個詞對了自動 +1 分；
// 送出的字和題目不符：保留對的前綴、第一個錯字變紅震動、鎖 0.7 秒（鎖定中送出的字一律清掉）；不用刪除、不扣分
function typingZhCheck(e) {
  const T = S.ty, v = S.tableView, inp = $('tyZh');
  if (!T || !T.zh || !inp || !v || v.role !== 'seat' || v.phase !== 'playing' || (e && e.isComposing)) return;
  const t = typingNow(), w = T.word(T.idx), val = inp.value;
  if (!val) return;
  if (t < 0 || t >= T.dur) { inp.value = ''; return; }
  if (performance.now() < T.lockUntil) { inp.value = w.slice(0, T.pos); return; }   // 打錯鎖定中
  if (w.startsWith(val)) {
    T.errPos = -1;
    if (val.length >= w.length) { T.idx++; T.pos = 0; T.score++; inp.value = ''; if (v.me >= 0) T.scores[v.me] = T.score; typingSend(); }   // 整個詞對了：自動得分、換下一個
    else T.pos = val.length;
  } else {
    let k = 0; while (k < val.length && val[k] === w[k]) k++;
    T.pos = k; T.errPos = k; T.lockUntil = performance.now() + TY_LOCK_MS; T.wordKey = ''; inp.value = w.slice(0, k); S.net?.tbl?.({ a: 'miss' });
  }
  typingRender();
}
function typingSendProgress(v) {   // 有人在觀戰才送打字進度（約每 250ms 最多一次、有變化才送）；沒人觀戰就一個訊息都不送
  const T = S.ty;
  if (v.role !== 'seat' || !(v.specs > 0)) { T.pKey = ''; return; }
  const e = T.errPos >= 0 ? 1 : 0, key = `${T.idx}|${T.pos}|${e}`;
  if (key === T.pKey || performance.now() - (T.pAt || 0) < TY_PROG_GAP_MS) return;
  T.pKey = key; T.pAt = performance.now();
  S.net?.tbl?.({ a: 'typ', n: T.idx, p: T.pos, e });
}
function typingTick() {
  const T = S.ty, v = S.tableView;
  if (!T || !S.tableOpen || !v || (v.game !== 'typing' && v.game !== 'zhtyping') || v.phase !== 'playing') { typingStop(); return; }
  typingSend();
  typingSendProgress(v);
  const t = typingNow();
  // 時間到：留 1 秒讓最後的分數先到，再請伺服器結算（伺服器核對時鐘；每秒最多重送一次直到收到結果）
  if (v.role === 'seat' && t >= T.dur + TY_SETTLE_S && performance.now() - T.finishAt > 1000) { T.finishAt = performance.now(); S.net?.tbl?.({ a: 'finish' }); }
  if (T.errPos >= 0 && performance.now() >= T.lockUntil) T.errPos = -1;   // 鎖定結束：紅字恢復
  typingRender();
}
function onNetTpg(m) {   // 觀戰者才會收到：各座位目前的打字進度（i＝座位編號）
  const T = S.ty; if (!T) return;
  (T.prog ||= {})[m.i] = { n: m.n, p: m.p, e: m.e };
  typingRender();
}
function onNetTsc(m) {   // 其他人的分數（i＝座位編號）；分數變高＝對手打對一個字，分數框閃綠
  const T = S.ty; if (!T) return;
  if (m.n > (T.scores[m.i] ?? 0)) (T.flash ||= {})[m.i] = { c: 'ok', until: performance.now() + TY_FLASH_MS };
  T.scores[m.i] = m.n;
  typingRender();
}
function onNetTmx(m) {   // 對手剛打錯一次：分數框閃紅（看不到字）
  const T = S.ty; if (!T) return;
  (T.flash ||= {})[m.i] = { c: 'bad', until: performance.now() + TY_FLASH_MS };
  typingRender();
}
const TY_FLASH_MS = 450;   // 對手打對／打錯時分數框閃一下的時間
function typingRender() {
  const T = S.ty, v = S.tableView;
  if (!T || !v) return;
  const t = typingNow(), seated = v.role === 'seat';
  const tm = $('tyTime'); if (tm) tm.textContent = t < 0 ? `開始倒數 ${Math.ceil(-t)}` : t >= T.dur ? '時間到！' : `剩 ${(T.dur - t).toFixed(1)} 秒`;
  const cd = $('tyCount'); if (cd) { cd.textContent = t < 0 ? String(Math.ceil(-t)) : ''; cd.classList.toggle('hidden', t >= 0); }
  const ot = $('tyOthers');   // 上方：其他參賽者的分數（觀戰者看全部）
  if (ot) {
    ot.innerHTML = '';
    v.seats.forEach((s, i) => {
      if (seated && i === v.me) return;
      const fl = T.flash?.[i], e = document.createElement('div'); e.className = 'typing-other' + (s.left ? ' left' : '') + (fl && fl.until > performance.now() ? ` flash-${fl.c}` : '');
      e.textContent = `${s.name}${s.left ? '（已離開）' : ''}　${T.scores[i] ?? 0}`;
      if (!seated && !s.left) {   // 觀戰者：多顯示這個人正在打的單字與打到哪（伺服器只送給觀戰者，tpg）
        const pr = T.prog?.[i], n = Math.max(T.scores[i] ?? 0, pr?.n ?? 0), p = pr && pr.n === n ? pr.p : 0, w = T.word(n);
        const ww = document.createElement('div'); ww.className = 'typing-other-word';
        [...w].forEach((c, k) => { const sp = document.createElement('span'); sp.textContent = c; sp.className = k < p ? 'done' : k === p && pr && pr.n === n && pr.e ? 'err' : ''; ww.appendChild(sp); });
        e.appendChild(ww);
      }
      ot.appendChild(e);
    });
    if (!ot.childElementCount) ot.appendChild(Object.assign(document.createElement('div'), { className: 'typing-other solo', textContent: '只有你一個人參賽' }));
  }
  const sc = $('tyScore'); if (sc) sc.textContent = seated ? `分數 ${T.score}` : '觀戰中';
  const wd = $('tyWord'), inp = $('tyInput'), w = T.word(T.idx);
  const showWord = seated && t >= 0 && t < T.dur;
  const key = showWord ? `${T.idx}|${T.pos}|${T.errPos}` : `-|${t < 0 ? 'cd' : 'end'}`;
  if (wd && key !== T.wordKey) {   // 題目有變才重畫（不然錯字的震動動畫會一直重來）
    T.wordKey = key; wd.innerHTML = '';
    if (showWord) {
      [...w].forEach((c, k) => {
        const e = document.createElement('span');
        e.className = k < T.pos ? 'done' : k === T.errPos ? 'err' : k === T.pos ? 'cur' : '';
        e.textContent = c; wd.appendChild(e);
      });
    } else wd.textContent = !seated ? '' : t < 0 ? '準備…' : '時間到！等待結算…';
  }
  if (inp) inp.textContent = showWord ? w.slice(0, T.pos) : '';
  const zi = $('tyZh'); if (zi) { zi.disabled = !showWord; if (showWord && document.activeElement !== zi) zi.focus(); }   // 中文打字：輸入框保持聚焦，玩家直接用輸入法打字
  const hint = $('tyHint'); if (hint) hint.textContent = T.zh ? (showWord ? '請切換成中文輸入法（例如注音），打出上面的詞，選字送出後自動計分' : '') : T.ime ? '偵測到中文輸入法：請切換成英文輸入（例如按 Shift）' : '';
}
function buildTyping(box, v, mk, gd) {
  const playing = v.phase === 'playing', mySeat = v.role === 'seat' ? v.seats[v.me] : null;
  if (playing && v.ty && (!S.ty || S.ty.id !== S.tableId || S.ty.t0 !== v.ty.t0)) typingStart(v);   // 新的一局（或剛進來觀戰一局進行中的）：重置本機狀態
  else if (playing && S.ty) S.ty.scores = v.seats.map((s, i) => (i === v.me && v.role === 'seat' ? S.ty.score : Math.max(s.score || 0, S.ty.scores[i] || 0)));
  if (!playing) typingStop();
  let status;
  if (playing) status = mySeat ? (v.game === 'zhtyping' ? '比賽中：照著打出畫面中央的詞（不用按 Enter）' : '比賽中：照著打出畫面中央的單字（不用按 Enter）') : '觀戰中';
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.appendChild(mk('div', 'table-status' + (playing && mySeat ? ' mine' : ''), status));
  if (v.result && !playing && v.result.ranking) {   // 結算：依分數排名（同分同名次）
    box.appendChild(mk('div', 'table-result', v.result.text));
    const rk = mk('div', 'dodge-rank'), rs = v.result.ranking;
    rs.forEach(r => rk.appendChild(mk('div', null, `${1 + rs.filter(o => o.score > r.score).length}. ${r.name}　${r.score} ${v.game === 'zhtyping' ? '個詞' : '個單字'}${r.left ? '（中途離開）' : ''}`)));
    box.appendChild(rk);
  }
  if (!playing) boardBlock(box, v, mk, sc => `${sc} ${v.game === 'zhtyping' ? '個詞' : '個單字'}`);
  if (playing) {   // 比賽畫面：上方其他人的分數、中央題目與自己的分數、下方自己打的內容
    const wrap = mk('div', 'typing-wrap');
    wrap.appendChild(mk('div', 'typing-others')).id = 'tyOthers';
    wrap.appendChild(mk('div', 'typing-time')).id = 'tyTime';
    wrap.appendChild(mk('div', 'typing-word' + (v.game === 'zhtyping' ? ' zh' : ''))).id = 'tyWord';
    wrap.appendChild(mk('div', 'typing-score')).id = 'tyScore';
    if (v.game === 'zhtyping' && mySeat) {   // 中文打字：真的輸入框（要靠輸入法組字、選字）；組字中不比對，送出（compositionend／input）才比對
      const zi = mk('input', 'typing-zh'); zi.id = 'tyZh'; zi.type = 'text'; zi.autocomplete = 'off'; zi.spellcheck = false; zi.placeholder = '在這裡用中文輸入法打字';
      zi.addEventListener('input', typingZhCheck); zi.addEventListener('compositionend', () => setTimeout(typingZhCheck, 0));
      wrap.appendChild(zi);
    } else wrap.appendChild(mk('div', 'typing-input')).id = 'tyInput';
    wrap.appendChild(mk('div', 'typing-hint')).id = 'tyHint';
    wrap.appendChild(mk('div', 'typing-count hidden')).id = 'tyCount';
    box.appendChild(wrap);
  } else {   // 大廳：座位（名字、準備狀態）
    const row = mk('div', 'table-seats dodge-seats');
    v.seats.forEach(s => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : ''));
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(seat);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  }
  const btns = mk('div', 'table-btns');
  if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
  if (S.ty) { S.ty.wordKey = ''; typingRender(); }
}
// ---- 秘藥情報戰（第八桌 t8）：規則與狀態全在伺服器（見 worker 的 it*），客戶端只畫畫面、送 isend／itake／ifwd／iact／timeout ----
// 密函編碼「印記.行動.投遞方式」：印記 Y 黃（沙都）／B 藍（水都）／K 黑（咒函），雙色＝兩個字母（沒有灰）；行動 P 截閱／S 調包／F 鎖定（原押送）／X 焚信／H 搜身／W 洗白／C 識破／I 攔截／T 轉移／B 阻擋／N 無人倖免；投遞方式 s 密函／p 公開情報／d 直達情報
const IT_FILL = { Y: '#e8b820', B: '#2f66d8', K: '#3a2050' };   // 灰（廢紙）已移除（2026-11-11）
const IT_CNAME = { Y: '黃', B: '藍', K: '黑' };
const IT_ACT = { P: '截閱', S: '調包', F: '鎖定', X: '焚信', H: '搜身', W: '洗白', C: '識破', I: '攔截', T: '轉移', B: '阻擋', N: '無人倖免', V: '查驗', D: '補給', R: '竊取' };
const IT_KIND = { seal: '密函', pub: '公開情報', direct: '直達情報' };   // 投遞方式（由卡面決定，不是玩家選）：蓋著照座位傳／翻開照座位傳／指定一人（對方必須收下）
const IT_KIND_CODE = { s: 'seal', p: 'pub', d: 'direct' }, IT_KIND_SYM = { seal: '✉', pub: '👁', direct: '➤' };   // 卡面左上角的符號
const itKindOf = c => IT_KIND_CODE[c.split('.')[2]] || 'seal';   // 牌＝印記.行動.投遞方式（例 YB.F.p）
const IT_ACT_TIP = { P: '蓋著的密函在你手上時：偷看它的內容（公開情報、已被調包公開的不能用）；也可以先宣告一個顏色，宣告就公開這封情報，猜對（雙色只要包含）抽 1 張', S: '蓋著的密函在你手上時：換上你的另一張手牌，換上去的牌公開，被換掉的牌丟棄（投遞方式不變）', F: '只有輪到的人（投遞前或傳遞中）：鎖定一位玩家，本回情報到他手上就必須收下（他正拿著就立刻收下；優先於阻擋，他也不能用轉移丟給別人）', X: '情報傳遞中：把它燒掉', H: '你的回合：偷看一人的 2 張手牌', W: '任何階段：丟掉任何一位玩家情報區裡一封含黑的情報', C: '別人的行動（含識破）生效前：取消它（識破也能被識破）', I: '別人拿著情報時：攔到自己手上（不能攔自己發的）；攔到後可收下，或不收：蓋著／公開的照座位傳給下一位、直達情報退回發信者', T: '情報傳到你面前時：轉移給另一位玩家，他不能拒收（被阻擋的人不能當對象；你被鎖定時不能用）', B: '情報傳遞中（自己或別人的）：指定一位玩家，本回他不能收下情報（沒有人可轉、只能收下時不生效；鎖定優先於阻擋）', N: '你的回合、投遞之前：從你開始，照座位順序從牌堆頂各拿一張直接放進每個人的情報區，有人勝利就停', V: '你的回合：查驗一位玩家的陣營，只有你看得到結果（之後有些身分可以謊報或不透露）', D: '你的回合、投遞之前：抽 2 張', R: '你的回合、投遞之前：從一位玩家手上隨機拿 1 張到你手上（他會看到被拿走哪張）' };
const IT_ROLE = { sand: ['沙都', '#e8b820', '任一位沙都玩家集滿 3 張黃色密函'], water: ['水都', '#5a8af0', '任一位水都玩家集滿 3 張藍色密函'], mage: ['咒術師', '#b07ae8', '自己集滿 3 張黑色咒函（你不會因為黑函出局）'] };
const itCols = c => c.split('.')[0], itActOf = c => c.split('.')[1];
const itLabel = c => [...itCols(c)].map(x => IT_CNAME[x]).join('') + '·' + IT_ACT[itActOf(c)];
function itCardEl(c, opts = {}) {   // c＝'YB.F'；null＝牌背
  const e = document.createElement('div');
  e.className = 'icard' + (opts.small ? ' small' : '') + (opts.sel ? ' sel' : '');
  if (!c) { e.classList.add('back'); e.textContent = '✉'; return e; }
  const cols = [...itCols(c)].map(x => IT_FILL[x]);
  e.style.background = cols.length > 1 ? `linear-gradient(135deg, ${cols[0]} 50%, ${cols[1]} 50%)` : cols[0];
  e.textContent = opts.small ? '' : IT_ACT[itActOf(c)];
  if (!opts.small) { const kb = document.createElement('span'); kb.className = 'ikind'; kb.textContent = IT_KIND_SYM[itKindOf(c)]; e.appendChild(kb); }   // 左上角：這張牌的投遞方式
  e.title = itLabel(c) + (opts.small ? '' : `（投遞：${IT_KIND[itKindOf(c)]}）：${IT_ACT_TIP[itActOf(c)]}`);
  return e;
}
const itAliveN = v => v.seats.filter(x => !x.out && !x.left).length;
function itStopTimer() { if (S.itTimer) { clearInterval(S.itTimer); S.itTimer = 0; } }
function itStartTimer() {
  if (S.itTimer) return;
  S.itTimer = setInterval(() => {
    const cur = S.tableView, it = cur?.it;
    if (!S.tableOpen || !cur || cur.game !== 'intel' || cur.phase !== 'playing' || !it) { itStopTimer(); return; }
    if (it.untimed) { const el0 = $('itTimer'); if (el0) el0.textContent = it.pend ? `等大家按「準備繼續」（${it.pend.ok.length + 1}/${itAliveN(cur)}）` : it.ack ? `等大家按「準備繼續」（${it.ack.ok.length + 1}/${itAliveN(cur)}）` : it.arrive ? `等大家按「準備繼續」（${it.arrive.ok.length + 1}/${itAliveN(cur)}）` : '不限時'; return; }   // 不限時：沒有倒數，也不送 timeout
    const end = it.pend ? it.pend.until : it.deadline, left = (end - (Date.now() + S.itOff)) / 1000;
    const ex = it.ext, extOn = !!ex?.by.length && !ex.by.every(j => ex.skip.includes(j));   // 這段倒數有人加時（還沒全部跳過）
    const el = $('itTimer'); if (el) { el.textContent = left > 0 ? `${extOn ? '⏳ 加時中 · ' : ''}${it.pend ? '識破倒數' : '剩'} ${Math.ceil(left)} 秒` : '…'; el.classList.toggle('ext', extOn); }
    if (left <= 0 && Date.now() - (S.itTimeoutAt || 0) > 1000) { S.itTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }   // 時間到：請伺服器核對時鐘並處理
  }, 250);
}
const itNextSeat = (v, i) => { const n = v.seats.length; for (let k = 1; k < n; k++) { const j = (i + k) % n; if (!v.seats[j].out && !v.seats[j].left) return j; } return -1; };
// 角色卡（資料在 games.json 的 intel.characters；2026-11-11）：第 0 階段只有選角與咒術師身分的勝利條件，技能還沒啟用（卡面標「尚未啟用」）
const itCharDef = id => gameDef('intel')?.characters?.[id] || null;
// 點座位上的職業：開角色介紹（同一個浮動視窗，直接顯示那位角色）；再點同一個職業、Esc 或「關閉」關掉
function itCharPop(id) {
  const open = !$('rulesBox').classList.contains('hidden');
  if (open && S.rulesTab === 'chars' && S.rulesChar === id) { rulesShow(false); return; }
  S.rulesChar = id; S.rulesKeep = true; rulesShow(true, 'chars'); S.rulesKeep = false;
}
function itCharCardEl(id, mk, opts = {}) {
  const c = itCharDef(id), el = mk('div', 'char-card' + (c?.type === 'hidden' ? ' hidden-type' : '') + (opts.sel ? ' sel' : ''));
  if (!c) { el.textContent = id; return el; }
  const hd = mk('div', 'char-head'); hd.appendChild(mk('span', 'char-name', c.name)); hd.appendChild(mk('span', 'char-type', c.type === 'hidden' ? '隱藏' : '公開')); el.appendChild(hd);
  el.appendChild(mk('div', 'char-win', '咒術勝利條件：' + c.win));
  for (const k of c.skills) { const d = mk('div', 'char-skill' + (k.once ? ' once' : '') + (k.on ? '' : ' off')); d.appendChild(mk('b', null, k.n + (k.once ? '（一局一次）' : '') + '：')); d.append(k.t); if (!k.on) d.appendChild(mk('span', 'char-off', '（尚未啟用）')); el.appendChild(d); }
  return el;
}
// ---- 角色技能 UI（第 1 階段）：技能面板（主動技能按鈕）與暫停時的選擇面板（保命／順水推舟／併購／搜刮） ----
// 技能的實作與規則見 docs/intel-characters.md；伺服器訊息：tbl {a:'iskill', k, ...}（主動技能）、{a:'iprompt', ...}（回答暫停中的選擇；no:true＝不用）
const itBlackIdx = intel => (intel || []).map((c, k) => k).filter(k => itCols(intel[k]).includes('K'));
function itHandPick(box, mk, hand, sel, max, onToggle) {   // 自己的手牌：點選／取消點選（最多 max 張）
  const hw = mk('div', 'it-hand pick');
  hand.forEach((c, k) => { const e = itCardEl(c, { sel: sel.includes(k) }); e.onclick = () => onToggle(k); hw.appendChild(e); });
  box.appendChild(hw);
}
function itSkillPanel(box, v, mk, send, cx) {
  const { me, it, L, pend, nm, alive } = cx, sm = v.seats[me], id = sm.char, cd = itCharDef(id);
  if (!cd || !alive(me) || it.step === 'pick') return;
  const hand = v.hand || [], used = !!sm.used, idle = !pend && !it.ask && !it.prompt, atMe = idle && it.step === 'pass' && L && L.at === me, canSee = L && L.kind !== 'pub' && !L.open;
  const myTurnIdle = idle && it.step === 'turn' && v.turn === me && !L, blk = itBlackIdx(sm.intel);
  const root = pend ? (pend.chain && pend.chain[0]) || { a: pend.a, tgt: pend.tgt } : null;
  const others = v.seats.map((x, i) => i).filter(i => i !== me && alive(i));
  const wrap = mk('div', 'it-skills'), sk = S.itSk;
  wrap.appendChild(mk('div', 'table-tag', `【${cd.name}】技能　角色卡：${sm.up ? '已公開' : '覆蓋中'}`));
  const row = (k, name, tip, btn) => {   // 一個技能一行：名稱＋說明＋按鈕（沒有按鈕＝自動觸發或在選擇時發動）
    const r = mk('div', 'it-skill-row' + (cd.skills[k].on ? '' : ' off')); r.appendChild(mk('b', null, name)); r.appendChild(mk('span', 'it-skill-tip', tip));
    if (btn) { const b = mk('button', 'ff-btn small', btn.label); if (btn.on) b.onclick = btn.fn; else b.disabled = true; r.appendChild(b); }
    wrap.appendChild(r);
  };
  const ONCE = k => cd.skills[k].once ? (used ? '（已用過）' : '（一局一次）') : '';
  const washBtn = (k, cond) => ({ label: '使用', on: cond && hand.length >= 2 && blk.length > 0, fn: () => { S.itSk = { kind: 'wash', k, hand: [], intel: -1 }; buildTable(); } });
  if (id === 'cautious') {
    row(0, '審慎', '蓋著的密函在你手上時偷看（不算行動牌）', { label: '偷看', on: atMe && canSee, fn: () => send({ a: 'iskill', k: 0 }) });
    row(1, '避險', '棄 2 張手牌，洗白自己情報區的一張咒函', washBtn(1, idle));
    row(2, '絕對謹慎' + ONCE(2), '被鎖定／被轉移選為你時取消（識破時間內）', { label: '取消', on: !used && !!pend && !!root && (root.a === 'F' || root.a === 'T') && root.tgt === me, fn: () => send({ a: 'iskill', k: 2 }) });
  } else if (id === 'doubleagent') {
    row(0, '雙面', '收下雙色情報時自動抽 1 張', null);
    row(1, '偷天換日', '點一張雙色手牌，在手牌下方按「當作調包使用」（可被識破）', null);
    row(2, '雙面人生' + ONCE(2), '從牌堆找一張雙色牌加入手牌，然後洗牌', { label: '使用', on: !used && idle && (v.deckDouble || []).length > 0, fn: () => { S.itSk = { kind: 'deck' }; buildTable(); } });
  } else if (id === 'fencesitter') {
    row(0, '兩邊倒', '收下含咒函的情報時自動抽 1 張', null);
    row(1, '調節', '自己回合、投遞前：棄 2 張手牌，洗白自己情報區的一張咒函', washBtn(1, myTurnIdle));
    row(2, '保命' + ONCE(2), '將收下第 3 張咒函時會問你要不要棄 2 張手牌、改為燒掉它', null);
  } else if (id === 'collector') {
    row(0, '鑑識', '使用截閱並宣告成功時自動額外抽 1 張', null);
    row(1, '搜刮', '有人出局時會問你要不要拿他 1 張手牌', null);
    row(2, '偽造遺囑' + ONCE(2), '有人出局時（搜刮的選擇裡）把他情報區全部納為手牌', null);
  } else if (id === 'broker') {
    row(0, '囤貨', '手牌少於 5 張時，抽牌階段自動多抽 1 張', null);
    row(1, '順水推舟', '收到咒函時會問你要不要看並拿別人的 1 張手牌', null);
    row(2, '併購' + ONCE(2), '指定一位玩家，看他全部手牌，拿走 1 張再給他 1 張', { label: '使用', on: !used && idle && hand.length > 0 && others.some(i => v.seats[i].n > 0), fn: () => { S.itSk = { kind: 'merge' }; buildTable(); } });
  } else if (id) {   // 第 2 階段起的角色：已啟用的技能有按鈕或自動觸發；還沒啟用的照卡面顯示（灰色）
    const T = k => cd.skills[k].t, judgeTg = others.filter(i => (v.seats[i].intel || []).filter(c => itCols(c).includes('K')).length >= 2);
    const most = Math.max(0, ...others.map(i => v.seats[i].n)), aimTg = others.filter(i => v.seats[i].n > 0 && v.seats[i].n === most);
    const btn = { judge0: { label: '使用', on: idle && judgeTg.length > 0, fn: () => { S.itSk = { kind: 'judge' }; buildTable(); } },
      sniper0: { label: '使用', on: myTurnIdle && !v.aimed && aimTg.length > 0, fn: () => { S.itSk = { kind: 'aim' }; buildTable(); } },
      blackcollector2: { label: '使用', on: !used && idle && others.length > 0, fn: () => { S.itSk = { kind: 'grab' }; buildTable(); } },
      desperate1: { label: '使用', on: idle && hand.length >= 4 && others.some(i => (v.seats[i].intel || []).length > 0), fn: () => { S.itSk = { kind: 'trade', hand: [], tgt: -1, intel: -1 }; buildTable(); } },
      healer0: { label: '公開並攔截', on: !sm.up && idle && it.step === 'pass' && !!L && v.turn !== me && L.at !== me && L.from !== me, fn: () => send({ a: 'iskill', k: 0 }) },
      healer2: { label: '使用', on: !used && idle && others.length > 0, fn: () => { S.itSk = { kind: 'expose' }; buildTable(); } },
      fisher0: { label: '公開並使用', on: !sm.up && idle && it.step === 'pass' && !!L && others.some(i => (v.seats[i].intel || []).length > 0), fn: () => { S.itSk = { kind: 'ambush', tgt: -1 }; buildTable(); } },
      fisher2: { label: '使用', on: !used && idle && v.turn !== me && (it.step === 'turn' || it.step === 'pass') && others.some(i => !(it.locked || []).includes(i)), fn: () => { S.itSk = { kind: 'net' }; buildTable(); } },
      assassin2: { label: '使用', on: !used && idle && it.step === 'pass' && !!L, fn: () => { S.itSk = { kind: 'smoke', sel: [] }; buildTable(); } },
      outsider1: { label: '使用', on: myTurnIdle && hand.length >= 2 && (sm.intel || []).some(c => !itCols(c).includes('K')), fn: () => { S.itSk = { kind: 'clear', hand: [], intel: -1 }; buildTable(); } },
      usurper0: { label: '使用', on: sm.up && idle && it.step === 'pass' && !!L && others.some(i => !(it.blocked || []).includes(i)), fn: () => { S.itSk = { kind: 'hinder' }; buildTable(); } },
      usurper1: { label: '使用', on: !sm.up && idle && hand.length === 0, fn: () => send({ a: 'iskill', k: 1 }) },
      usurper2: { label: '使用', on: !used && idle, fn: () => send({ a: 'iskill', k: 2 }) },
      sniper1: { label: '使用', on: myTurnIdle && !v.shot && others.length > 0, fn: () => { S.itSk = { kind: 'shots', sel: [] }; buildTable(); } } };
    const auto = { poisoner0: '（自動：獲得咒函時抽 3 張，再選 1 張放回牌庫頂）', desperate0: '（自動）', helper0: '（自動）', blackcollector1: '（自動）', assassin1: '（抽牌階段會問你）', blackcollector0: '（抽牌階段會問你）',
      healer1: '（自動：角色卡翻開後）', fisher1: '（有人出局時會問你，從手牌放）', killer1: '（點一張密函手牌，在下方按「當作鎖定使用」）', killer2: '（點任一張手牌，在下方按「死亡預告」）', assassin0: '（即將收下情報時會問你）', sniper2: '（點一張含黑的手牌，在下方按「殺意」）',
      poisoner1: '（觸發時會問你，從手牌放）', poisoner2: '（觸發時會問你，從手牌放）', judge1: '（自動抽 2，再問你要不要從手牌放咒函）', judge2: '（自動：收到第 3 張咒函時多審判一次）', desperate2: '（出局時會問你）', killer0: '（自動抽 2，再問你要不要從手牌放咒函）', helper1: '（出局時會問你）', helper2: '（有人將出局時會問你）',
      harmonizer0: '（點一張鎖定手牌，可在他人的回合使用）', harmonizer1: '（你獲勝時會問你要不要指定一位玩家一同勝利）', harmonizer2: '（點一張直達手牌，在下方按「調和」）', outsider0: '（自動：情報區 1 張以下時，不會被搜身、竊取、查驗指定）', outsider2: '（將收下情報時會問你）' };
    const flipK = k => (k === 0 && (id === 'healer' || id === 'fisher')) || (k === 1 && id === 'usurper');   // 求知慾、埋伏：「公開角色牌」的技能＝只有覆蓋中能用（翻開後就不能再用）
    cd.skills.forEach((sk2, k) => { let b = sk2.on ? btn[id + k] || null : null; if (b && !sm.up && !flipK(k)) b = { ...b, on: false }; row(k, sk2.n + (sk2.once ? ONCE(k) : ''), T(k) + (sk2.on ? auto[id + k] || '' : '') + (!sm.up && sk2.on && !flipK(k) && !btn[id + k] ? '（角色卡翻開後才有效）' : ''), b); });
  }
  if (sk) {   // 技能的選擇步驟
    const box2 = mk('div', 'it-skill-pick');
    if (sk.kind === 'wash') {
      box2.appendChild(mk('div', 'table-tag', `選 2 張要棄掉的手牌（已選 ${sk.hand.length}/2），再選要洗白的咒函：`));
      itHandPick(box2, mk, hand, sk.hand, 2, k => { sk.hand = sk.hand.includes(k) ? sk.hand.filter(x => x !== k) : sk.hand.length < 2 ? [...sk.hand, k] : sk.hand; buildTable(); });
      const ib = mk('div', 'table-btns'); blk.forEach(k => { const b = mk('button', 'ff-btn small' + (sk.intel === k ? ' active' : ''), itLabel(sm.intel[k])); b.onclick = () => { sk.intel = k; buildTable(); }; ib.appendChild(b); }); box2.appendChild(ib);
      const ok = mk('button', 'ff-btn', '確定'); ok.disabled = !(sk.hand.length === 2 && sk.intel >= 0); ok.onclick = () => send({ a: 'iskill', k: sk.k, hand: sk.hand, intel: sk.intel }); box2.appendChild(ok);
    } else if (sk.kind === 'deck') {
      box2.appendChild(mk('div', 'table-tag', '牌堆裡的雙色牌，選一張加入手牌：'));
      const hw = mk('div', 'it-hand'); (v.deckDouble || []).forEach(c => { const e = itCardEl(c); e.onclick = () => send({ a: 'iskill', k: 2, c }); hw.appendChild(e); }); box2.appendChild(hw);
    } else if (sk.kind === 'judge' || sk.kind === 'aim' || sk.kind === 'grab') {   // 旁聽／瞄準／搶購：選一位玩家
      const most = Math.max(0, ...others.map(i => v.seats[i].n));
      const list = sk.kind === 'judge' ? others.filter(i => (v.seats[i].intel || []).filter(c => itCols(c).includes('K')).length >= 2) : sk.kind === 'aim' ? others.filter(i => v.seats[i].n > 0 && v.seats[i].n === most) : others;
      const k = sk.kind === 'grab' ? 2 : 0;
      box2.appendChild(mk('div', 'table-tag', { judge: '旁聽：要檢視誰的手牌？（只列出情報區有 2 張以上咒函的人）', aim: '瞄準：要偷看誰？（只列出手牌最多的人）', grab: '搶購（一局一次）：要搶誰的純黑手牌？' }[sk.kind]));
      const ib = mk('div', 'table-btns'); list.forEach(i => { const b = mk('button', 'ff-btn small', `${nm(i)}（手牌 ${v.seats[i].n}）`); b.onclick = () => send({ a: 'iskill', k, tgt: i }); ib.appendChild(b); }); box2.appendChild(ib);
    } else if (sk.kind === 'expose' || sk.kind === 'net') {   // 公開／灑網：選一位玩家
      const list = sk.kind === 'net' ? others.filter(i => !(it.locked || []).includes(i)) : others;
      box2.appendChild(mk('div', 'table-tag', sk.kind === 'expose' ? '公開（一局一次）：暴露你的陣營，並指定一人也暴露他的陣營' : '灑網（一局一次）：指定一人被鎖定（本回情報到他手上就必須收下）'));
      const ib = mk('div', 'table-btns'); list.forEach(i => { const b = mk('button', 'ff-btn small', nm(i)); b.onclick = () => send({ a: 'iskill', k: 2, tgt: i }); ib.appendChild(b); }); box2.appendChild(ib);
    } else if (sk.kind === 'ambush') {   // 埋伏：選人，再選他情報區的一張
      box2.appendChild(mk('div', 'table-tag', '埋伏：把一位其他玩家情報區的 1 張情報放回牌庫頂'));
      const ib = mk('div', 'table-btns'); others.filter(i => (v.seats[i].intel || []).length > 0).forEach(i => { const b = mk('button', 'ff-btn small' + (sk.tgt === i ? ' active' : ''), nm(i)); b.onclick = () => { sk.tgt = i; buildTable(); }; ib.appendChild(b); }); box2.appendChild(ib);
      if (sk.tgt >= 0) { const ib2 = mk('div', 'table-btns'); (v.seats[sk.tgt].intel || []).forEach((c, k) => { const b = mk('button', 'ff-btn small', itLabel(c)); b.onclick = () => send({ a: 'iskill', k: 0, tgt: sk.tgt, intel: k }); ib2.appendChild(b); }); box2.appendChild(ib2); }
    } else if (sk.kind === 'smoke' || sk.kind === 'shots') {   // 煙霧彈（阻擋）／亂槍打鳥（鎖定）：選任意數量的玩家
      const list = sk.kind === 'smoke' ? v.seats.map((x, i) => i).filter(i => alive(i)) : others;
      box2.appendChild(mk('div', 'table-tag', sk.kind === 'smoke' ? '煙霧彈（一局一次）：選要阻擋的玩家（可以多選）' : '亂槍打鳥：選要鎖定的玩家（可以多選）'));
      const ib = mk('div', 'table-btns'); list.forEach(i => { const b = mk('button', 'ff-btn small' + (sk.sel.includes(i) ? ' active' : ''), nm(i)); b.onclick = () => { sk.sel = sk.sel.includes(i) ? sk.sel.filter(x => x !== i) : [...sk.sel, i]; buildTable(); }; ib.appendChild(b); }); box2.appendChild(ib);
      const ok = mk('button', 'ff-btn', '確定'); ok.disabled = !sk.sel.length; ok.onclick = () => send({ a: 'iskill', k: sk.kind === 'smoke' ? 2 : 1, tgts: sk.sel }); box2.appendChild(ok);
    } else if (sk.kind === 'trade') {   // 交易：選 4 張手牌、對象、他情報區的一張情報
      box2.appendChild(mk('div', 'table-tag', `交易：選 4 張要交給他的手牌（已選 ${sk.hand.length}/4）`));
      itHandPick(box2, mk, hand, sk.hand, 4, k => { sk.hand = sk.hand.includes(k) ? sk.hand.filter(x => x !== k) : sk.hand.length < 4 ? [...sk.hand, k] : sk.hand; buildTable(); });
      const ib = mk('div', 'table-btns'); ib.appendChild(mk('span', 'table-tag', '交給誰：'));
      others.filter(i => (v.seats[i].intel || []).length > 0).forEach(i => { const b = mk('button', 'ff-btn small' + (sk.tgt === i ? ' active' : ''), nm(i)); b.onclick = () => { sk.tgt = i; sk.intel = -1; buildTable(); }; ib.appendChild(b); }); box2.appendChild(ib);
      if (sk.tgt >= 0) { const ib2 = mk('div', 'table-btns'); ib2.appendChild(mk('span', 'table-tag', '拿走他的哪一張情報（放進你的手牌）：')); (v.seats[sk.tgt].intel || []).forEach((c, k) => { const b = mk('button', 'ff-btn small' + (sk.intel === k ? ' active' : ''), itLabel(c)); b.onclick = () => { sk.intel = k; buildTable(); }; ib2.appendChild(b); }); box2.appendChild(ib2); }
      const ok = mk('button', 'ff-btn', '確定交易'); ok.disabled = !(sk.hand.length === 4 && sk.tgt >= 0 && sk.intel >= 0); ok.onclick = () => send({ a: 'iskill', k: 1, hand: sk.hand, tgt: sk.tgt, intel: sk.intel }); box2.appendChild(ok);
    } else if (sk.kind === 'clear') {   // 撇清：棄 2 張手牌，丟棄自己情報區的一張非咒函
      box2.appendChild(mk('div', 'table-tag', `撇清：選 2 張要棄掉的手牌（已選 ${sk.hand.length}/2），再選要丟棄的情報（不能是咒函）：`));
      itHandPick(box2, mk, hand, sk.hand, 2, k => { sk.hand = sk.hand.includes(k) ? sk.hand.filter(x => x !== k) : sk.hand.length < 2 ? [...sk.hand, k] : sk.hand; buildTable(); });
      const ib = mk('div', 'table-btns'); (sm.intel || []).forEach((c, k) => { if (itCols(c).includes('K')) return; const b = mk('button', 'ff-btn small' + (sk.intel === k ? ' active' : ''), itLabel(c)); b.onclick = () => { sk.intel = k; buildTable(); }; ib.appendChild(b); }); box2.appendChild(ib);
      const ok = mk('button', 'ff-btn', '確定'); ok.disabled = !(sk.hand.length === 2 && sk.intel >= 0); ok.onclick = () => send({ a: 'iskill', k: 1, hand: sk.hand, intel: sk.intel }); box2.appendChild(ok);
    } else if (sk.kind === 'hinder') {   // 妨礙：覆蓋角色卡，指定一位玩家被阻擋
      box2.appendChild(mk('div', 'table-tag', '妨礙：覆蓋你的角色卡，並指定一位玩家本回不能收下情報'));
      const ib = mk('div', 'table-btns'); others.filter(i => !(it.blocked || []).includes(i)).forEach(i => { const b = mk('button', 'ff-btn small', nm(i)); b.onclick = () => send({ a: 'iskill', k: 0, tgt: i }); ib.appendChild(b); }); box2.appendChild(ib);
    } else if (sk.kind === 'merge') {
      box2.appendChild(mk('div', 'table-tag', '併購：要指定誰？'));
      const ib = mk('div', 'table-btns'); others.filter(i => v.seats[i].n > 0).forEach(i => { const b = mk('button', 'ff-btn small', nm(i)); b.onclick = () => send({ a: 'iskill', k: 2, tgt: i }); ib.appendChild(b); }); box2.appendChild(ib);
    }
    const cn = mk('button', 'ff-btn small', '取消'); cn.onclick = () => { S.itSk = null; buildTable(); }; box2.appendChild(cn);
    wrap.appendChild(box2);
  }
  box.appendChild(wrap);
}
// 暫停中的選擇（別人在選時只顯示狀態）。選擇狀態放 S.itPr，換一個暫停就重設
function itPromptPanel(box, v, mk, send, cx) {
  const { me, it, nm } = cx, pr = it.prompt;
  if (!pr) { S.itPr = null; return; }
  const key = pr.kind + ':' + pr.seat; if (!S.itPr || S.itPr.key !== key) S.itPr = { key, take: -1, give: -1, dest: 'hand', will: false, pick: [] };
  const st = S.itPr, d = v.prompt;
  if (pr.seat !== me || !d) { box.appendChild(mk('div', 'table-tag it-prompt-wait', `等 ${nm(pr.seat)} 做技能決定…`)); return; }
  const w = mk('div', 'it-prompt'), no = (label = '不用') => { const b = mk('button', 'ff-btn small', label); b.onclick = () => send({ a: 'iprompt', no: true }); return b; };
  const cards = (arr, selIdx, onPick) => { const hw = mk('div', 'it-hand'); arr.forEach((c, k) => { const e = itCardEl(c, { sel: selIdx === k }); e.onclick = () => onPick(k); hw.appendChild(e); }); return hw; };
  if (pr.kind === 'savelife') {
    w.appendChild(mk('div', 'table-status mine', `你將收下第 3 張咒函：${itLabel(d.card)}。要發動【保命】嗎？（棄 2 張手牌，把這封情報燒掉）`));
    w.appendChild(mk('div', 'table-tag', `選 2 張要棄掉的手牌（已選 ${st.pick.length}/2）：`));
    itHandPick(w, mk, v.hand || [], st.pick, 2, k => { st.pick = st.pick.includes(k) ? st.pick.filter(x => x !== k) : st.pick.length < 2 ? [...st.pick, k] : st.pick; buildTable(); });
    const ok = mk('button', 'ff-btn', '發動保命'); ok.disabled = st.pick.length !== 2; ok.onclick = () => send({ a: 'iprompt', yes: true, idx: st.pick }); w.appendChild(ok); w.appendChild(no('不用（照常收下）'));
  } else if (pr.kind === 'dig') {
    w.appendChild(mk('div', 'table-status mine', '【順水推舟】你收到咒函了：可以看任一玩家的手牌，拿 1 張當自己的手牌'));
    d.hands.forEach((h, i) => { if (!h.length) return; w.appendChild(mk('div', 'table-tag', `${nm(i)} 的手牌（點一張拿走）：`)); w.appendChild(cards(h, -1, k => send({ a: 'iprompt', tgt: i, idx: k }))); });
    w.appendChild(no());
  } else if (pr.kind === 'merge') {
    w.appendChild(mk('div', 'table-status mine', `【併購】${nm(d.tgt)} 的全部手牌：選 1 張拿走，再選你自己的 1 張給他`));
    w.appendChild(cards(d.hand, st.take, k => { st.take = k; buildTable(); }));
    w.appendChild(mk('div', 'table-tag', '你要給他的牌：'));
    w.appendChild(cards(v.hand || [], st.give, k => { st.give = k; buildTable(); }));
    const ok = mk('button', 'ff-btn', '確定併購'); ok.disabled = st.take < 0 || st.give < 0; ok.onclick = () => send({ a: 'iprompt', take: st.take, give: st.give }); w.appendChild(ok); w.appendChild(no('取消'));
  } else if (pr.kind === 'loot') {
    w.appendChild(mk('div', 'table-status mine', `【收藏家】${nm(d.victim)} 出局了：可以搜刮他的 1 張手牌，也可以偽造遺囑`));
    if (d.hand.length) { w.appendChild(mk('div', 'table-tag', '搜刮：點一張他的手牌（再點一次取消）'));
      w.appendChild(cards(d.hand, st.take, k => { st.take = st.take === k ? -1 : k; buildTable(); }));
      const dr = mk('div', 'table-btns'); for (const [val, lab] of [['hand', '放進我的手牌'], ['intel', '放進我的情報區']]) { const b = mk('button', 'ff-btn small' + (st.dest === val ? ' active' : ''), lab); b.onclick = () => { st.dest = val; buildTable(); }; dr.appendChild(b); } w.appendChild(dr); }
    if (d.will && d.intel.length) { w.appendChild(mk('div', 'table-tag', `偽造遺囑（一局一次）：把他情報區的 ${d.intel.length} 張情報全部納為你的手牌`));
      const b = mk('button', 'ff-btn small' + (st.will ? ' active' : ''), st.will ? '✔ 要偽造遺囑' : '偽造遺囑'); b.onclick = () => { st.will = !st.will; buildTable(); }; w.appendChild(b); }
    const ok = mk('button', 'ff-btn', '確定'); ok.onclick = () => send({ a: 'iprompt', take: st.take >= 0 ? st.take : null, dest: st.dest, will: st.will }); w.appendChild(ok); w.appendChild(no('什麼都不拿'));
  } else if (pr.kind === 'layout') {   // 布局
    w.appendChild(mk('div', 'table-status mine', `【暗殺者】布局：你即將收下這封情報${d.card ? `（${itLabel(d.card)}）` : ''}，要直接放進別人的情報區嗎？`));
    const tb = mk('div', 'table-btns'); v.seats.forEach((x, i) => { if (i === me || x.out || x.left) return; const b = mk('button', 'ff-btn small', x.name); b.onclick = () => send({ a: 'iprompt', tgt: i }); tb.appendChild(b); }); w.appendChild(tb);
    w.appendChild(no('不用（自己收下）'));
  } else if (pr.kind === 'burn') {   // 無關緊要
    w.appendChild(mk('div', 'table-status mine', `【局外人】無關緊要（一局一次）：你即將收下這封情報${d.card ? `（${itLabel(d.card)}）` : ''}，要改為燒掉它嗎？`));
    const ok = mk('button', 'ff-btn', '燒掉'); ok.onclick = () => send({ a: 'iprompt', yes: true }); w.appendChild(ok); w.appendChild(no('不用（照常收下）'));
  } else if (pr.kind === 'rescue') {   // 救助
    w.appendChild(mk('div', 'table-status mine', '【調和者】救助：你獲勝了！可以指定一位玩家一同勝利'));
    const tb = mk('div', 'table-btns'); (d.cands || []).forEach(i => { const b = mk('button', 'ff-btn small', nm(i)); b.onclick = () => send({ a: 'iprompt', tgt: i }); tb.appendChild(b); }); w.appendChild(tb);
    w.appendChild(no('不指定'));
  } else if (pr.kind === 'profit') {   // 得利
    w.appendChild(mk('div', 'table-status mine', `【漁翁】得利：${nm(d.victim)} 出局了，可以從手牌放最多 2 張咒函到另一位玩家的情報區`));
    const hand = v.hand || [], blk = hand.map((c, k) => k).filter(k => itCols(hand[k]).includes('K'));
    const hw = mk('div', 'it-hand'); blk.forEach(k => { const e = itCardEl(hand[k], { sel: st.pick.includes(k) }); e.onclick = () => { st.pick = st.pick.includes(k) ? st.pick.filter(x => x !== k) : st.pick.length < 2 ? [...st.pick, k] : st.pick; buildTable(); }; hw.appendChild(e); }); w.appendChild(hw);
    const tb = mk('div', 'table-btns'); tb.appendChild(mk('span', 'table-tag', '放到誰的情報區：'));
    v.seats.forEach((x, i) => { if (i === d.victim || x.out || x.left) return; const b = mk('button', 'ff-btn small' + (st.give === i ? ' active' : ''), x.name); b.onclick = () => { st.give = i; buildTable(); }; tb.appendChild(b); }); w.appendChild(tb);
    const ok = mk('button', 'ff-btn', `放 ${st.pick.length} 張`); ok.disabled = !st.pick.length || st.give < 0; ok.onclick = () => send({ a: 'iprompt', tgt: st.give, idx: st.pick }); w.appendChild(ok); w.appendChild(no('不放'));
  } else if (pr.kind === 'judge' || pr.kind === 'mark' || pr.kind === 'chase') {   // 從手牌放 1 張咒函
    const title = { judge: '【審判者】審判：可以從手牌放 1 張咒函到任一玩家的情報區', mark: `【毒藥師】製毒：${nm(d.tgt)} 獲得了你傳出的黃／藍情報，可以從手牌放 1 張咒函到他的情報區`, chase: `【殺手】追殺：${nm(d.tgt)} 獲得了你傳出的咒函，可以從手牌再放 1 張咒函到他的情報區` }[pr.kind];
    w.appendChild(mk('div', 'table-status mine', title));
    const hand = v.hand || [], blk = hand.map((c, k) => k).filter(k => itCols(hand[k]).includes('K'));
    w.appendChild(mk('div', 'table-tag', '選一張手牌裡的咒函：'));
    const hw = mk('div', 'it-hand'); blk.forEach(k => { const e = itCardEl(hand[k], { sel: st.take === k }); e.onclick = () => { st.take = k; buildTable(); }; hw.appendChild(e); }); w.appendChild(hw);
    if (pr.kind === 'judge') {
      const tb = mk('div', 'table-btns'); tb.appendChild(mk('span', 'table-tag', '放到誰的情報區：'));
      v.seats.forEach((x, i) => { if (x.out || x.left) return; const b = mk('button', 'ff-btn small' + (st.give === i ? ' active' : ''), x.name); b.onclick = () => { st.give = i; buildTable(); }; tb.appendChild(b); }); w.appendChild(tb);
    }
    const ok = mk('button', 'ff-btn', '放咒函'); ok.disabled = st.take < 0 || (pr.kind === 'judge' && st.give < 0); ok.onclick = () => send({ a: 'iprompt', idx: st.take, tgt: st.give }); w.appendChild(ok); w.appendChild(no('不放'));
  } else if (pr.kind === 'venom') {   // 劇毒：最多 2 張
    w.appendChild(mk('div', 'table-status mine', `【毒藥師】劇毒（一局一次）：${nm(d.tgt)} 識破了你的查驗，可以從手牌放最多 2 張咒函到他的情報區`));
    const hand = v.hand || [], blk = hand.map((c, k) => k).filter(k => itCols(hand[k]).includes('K'));
    const hw = mk('div', 'it-hand'); blk.forEach(k => { const e = itCardEl(hand[k], { sel: st.pick.includes(k) }); e.onclick = () => { st.pick = st.pick.includes(k) ? st.pick.filter(x => x !== k) : st.pick.length < 2 ? [...st.pick, k] : st.pick; buildTable(); }; hw.appendChild(e); }); w.appendChild(hw);
    const ok = mk('button', 'ff-btn', `放 ${st.pick.length} 張`); ok.disabled = !st.pick.length; ok.onclick = () => send({ a: 'iprompt', idx: st.pick }); w.appendChild(ok); w.appendChild(no('不用'));
  } else if (pr.kind === 'sub') {   // 替死
    w.appendChild(mk('div', 'table-status mine', `【助人者】替死（一局一次）：${nm(d.victim)} 將因這張咒函出局（${itLabel(d.card)}），要改放進你的情報區嗎？`));
    const ok = mk('button', 'ff-btn', '替他收下'); ok.onclick = () => send({ a: 'iprompt', yes: true }); w.appendChild(ok); w.appendChild(no('不用'));
  } else if (pr.kind === 'will') {   // 遺言：先選人
    w.appendChild(mk('div', 'table-status mine', '【絕望者】遺言：你出局了。指定一位玩家，看他的手牌並拿走其中 2 張（丟進棄牌堆）'));
    const tb = mk('div', 'table-btns'); v.seats.forEach((x, i) => { if (i === me || x.out || x.left || !x.n) return; const b = mk('button', 'ff-btn small', `${x.name}（手牌 ${x.n}）`); b.onclick = () => send({ a: 'iprompt', tgt: i }); tb.appendChild(b); }); w.appendChild(tb); w.appendChild(no('不用'));
  } else if (pr.kind === 'will2') {
    w.appendChild(mk('div', 'table-status mine', `【絕望者】遺言：${nm(d.tgt)} 的手牌，選 ${Math.min(2, d.hand.length)} 張拿走（已選 ${st.pick.length}）`));
    const need = Math.min(2, d.hand.length), hw = mk('div', 'it-hand');
    d.hand.forEach((c, k) => { const e = itCardEl(c, { sel: st.pick.includes(k) }); e.onclick = () => { st.pick = st.pick.includes(k) ? st.pick.filter(x => x !== k) : st.pick.length < need ? [...st.pick, k] : st.pick; buildTable(); }; hw.appendChild(e); }); w.appendChild(hw);
    const ok = mk('button', 'ff-btn', '拿走'); ok.disabled = st.pick.length !== need; ok.onclick = () => send({ a: 'iprompt', idx: st.pick }); w.appendChild(ok);
  } else if (pr.kind === 'martyr') {   // 殉道
    w.appendChild(mk('div', 'table-status mine', '【助人者】殉道：你出局了。可以洗白任一玩家情報區的一張咒函'));
    d.intels.forEach((ks, i) => { if (!ks.length) return; const row2 = mk('div', 'table-btns'); row2.appendChild(mk('span', 'table-tag', `${nm(i)}：`)); ks.forEach(k => { const c = v.seats[i].intel[k], b = mk('button', 'ff-btn small', itLabel(c)); b.onclick = () => send({ a: 'iprompt', tgt: i, idx: k }); row2.appendChild(b); }); w.appendChild(row2); });
    w.appendChild(no('不用'));
  } else if (pr.kind === 'taste') {
    w.appendChild(mk('div', 'table-status mine', '【毒藥師】試毒：你抽了這幾張，選 1 張放回牌庫頂'));
    w.appendChild(cards(d.cards, -1, k => send({ a: 'iprompt', idx: k })));
  } else if (pr.kind === 'scheme') {
    w.appendChild(mk('div', 'table-status mine', '【暗殺者】暗計：要放棄這次抽牌，改拿一張別人（或自己）情報區的咒函到手牌嗎？'));
    d.intels.forEach((ks, i) => { if (!ks.length) return; const row2 = mk('div', 'table-btns'); row2.appendChild(mk('span', 'table-tag', `${nm(i)}：`)); ks.forEach(k => { const c = v.seats[i].intel[k], b = mk('button', 'ff-btn small', itLabel(c)); b.onclick = () => send({ a: 'iprompt', tgt: i, idx: k }); row2.appendChild(b); }); w.appendChild(row2); });
    w.appendChild(no('不用（照常抽牌）'));
  } else if (pr.kind === 'gather') {
    w.appendChild(mk('div', 'table-status mine', '【咒函蒐集者】採集：要改為翻開牌堆頂 3 張（純黑的全拿，其餘放到牌堆底）嗎？'));
    const ok = mk('button', 'ff-btn', '採集'); ok.onclick = () => send({ a: 'iprompt', yes: true }); w.appendChild(ok); w.appendChild(no('不用（照常抽牌）'));
  }
  box.appendChild(w);
}
function buildIntel(box, v, mk, gd) {
  const playing = v.phase === 'playing', it = v.it, me = v.role === 'seat' ? v.me : -1;
  const L = it?.letter, pend = it?.pend, nm = i => v.seats[i]?.name ?? '?';
  const alive = i => v.seats[i] && !v.seats[i].out && !v.seats[i].left;
  const send = m => { S.itSel = -1; S.itMode = null; S.itSk = null; S.itPr = null; S.itAsS = false; S.itAs = null; S.net?.tbl?.(m); };
  if (!playing) { itStopTimer(); S.itSel = -1; S.itMode = null; S.itSk = null; S.itPr = null; }
  else {
    if (S.itSn !== it.sn) { S.itSn = it.sn; S.itOff = it.sn - Date.now(); }   // 伺服器時間 − 本機時間：只在收到新畫面時算（本機重畫用舊的 sn 會越算越偏）
    itStartTimer();
  }
  const myTurn = playing && !pend && !it.ask && !it.prompt && it.step === 'turn' && v.turn === me && me >= 0;   // 等查驗回答時不能投遞／出牌
  const holding = playing && !pend && !it.arrive && !it.prompt && it.step === 'pass' && L && L.at === me;
  // 狀態列
  let status;
  if (playing) {
    const kn = L ? IT_KIND[L.kind] : '密函';
    if (pend) {   // 識破串：最底下是真正的行動，後面每一個都是識破
      const ch = pend.chain || [{ a: pend.a, by: pend.by, tgt: pend.tgt }];
      status = ch.map((c, k) => k === 0 ? `${nm(c.by)} 使用了${IT_ACT[c.a]}${['F', 'H', 'V', 'R', 'T', 'B', 'W'].includes(c.a) ? `（對 ${nm(c.tgt)}）` : c.col ? `（宣告${IT_CNAME[c.col]}色）` : c.a === 'I' && L ? `（對 ${nm(L.at)}）` : ''}` : `${nm(c.by)} 識破`).join(' ← ') + '——生效前可以識破';
    }
    else if (it.step === 'pick') status = v.choices ? '選擇你的角色卡（2 選 1，另一張棄掉）' : me >= 0 ? `已選好，等其他人（${v.seats.filter(x => x.picked).length}/${v.seats.filter(x => !x.left).length}）` : `選角中（${v.seats.filter(x => x.picked).length}/${v.seats.filter(x => !x.left).length}）`;
    else if (it.prompt) status = it.prompt.seat === me ? '輪到你做技能的決定（見下方）' : `等 ${nm(it.prompt.seat)} 做技能的決定`;
    else if (it.ask) status = it.ask.tgt === me ? `${nm(it.ask.by)} 查驗了你：選擇要怎麼回答` : `等 ${nm(it.ask.tgt)} 回答 ${nm(it.ask.by)} 的查驗`;
    else if (it.arrive && it.step === 'pass') status = `${kn}到了 ${nm(L.at)} 手上
大家按「準備繼續」後他才能決定
（這時可以出鎖定（輪到的人）／攔截／焚信／阻擋）`;
    else if (it.step === 'ack') status = `${nm(it.ack.by)} 收下了情報
大家看清楚後按「準備繼續」`;
    else if (it.step === 'turn') status = myTurn ? '輪到你：可以先用行動牌，再選一張手牌投遞' : `輪到 ${nm(v.turn)} 投遞`;
    else status = holding ? (L.kind === 'direct' && L.next < 0 ? '直達情報交到你手上：必須收下' : L.next < 0 ? `${kn}在你手上：${L.at === L.from ? '大家都不收，退回到你手上，必須收下' : '只能收下'}` : L.next === L.from ? `${kn}在你手上：收下，或退回給發信者 ${nm(L.next)}（發信者必須收下）` : `${kn}在你手上：${(it.blocked || []).includes(me) ? '你被阻擋，本回不能收下，只能傳給 ' + nm(L.next) : '收下，或傳給 ' + nm(L.next)}`) : `${kn}在 ${nm(L?.at)} 手上`;
    if (v.role === 'spec') status = '觀戰中 · ' + status;
  } else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  const st = mk('div', 'table-status' + (myTurn || holding ? ' mine' : ''), status); st.style.whiteSpace = 'pre-line';   // 狀態文字裡的 
 要換行
  if (playing) { const tm = mk('span', 'it-timer'); tm.id = 'itTimer'; st.appendChild(tm); }
  box.appendChild(st);
  // 加時（限時模式）：倒數中任何活著的入座玩家可以按「加時」（這段倒數變成上限 ×5，同一段最多 2 人、每人每局 3 次）；加時的人可以按「跳過」，全部跳過就縮回 3 秒
  if (playing && !it.untimed && (it.step === 'turn' || it.step === 'pass')) {
    const ex = it.ext || { by: [], skip: [] }, row = mk('div', 'table-btns it-ext');
    if (ex.by.length) row.appendChild(mk('span', 'table-tag', '加時：' + ex.by.map(j => nm(j) + (ex.skip.includes(j) ? '（已跳過）' : '')).join('、')));
    if (me >= 0 && alive(me)) {
      const left = v.seats[me].ext ?? 0;
      if (ex.by.includes(me)) {
        if (!ex.skip.includes(me)) { const b = mk('button', 'ff-btn small', '跳過'); b.title = '我不行動了：所有加時的人都跳過，倒數就縮回 3 秒'; b.onclick = () => S.net?.tbl?.({ a: 'iskip' }); row.appendChild(b); }
      } else {
        const b = mk('button', 'ff-btn small', `加時（剩 ${left} 次）`);
        b.disabled = left <= 0 || ex.by.length >= 2;
        b.title = ex.by.length >= 2 ? '這段倒數已經有 2 個人加時' : left <= 0 ? '本局的加時次數用完了' : '這段倒數變成上限的 5 倍（識破 25 秒、收／轉 75 秒、投遞 150 秒）';
        b.onclick = () => S.net?.tbl?.({ a: 'iext' }); row.appendChild(b);
      }
    }
    if (row.childElementCount) box.appendChild(row);
  }
  if (playing && it.chars) itPromptPanel(box, v, mk, send, { me, it, nm });   // 技能暫停中的選擇
  // 結算：翻開所有人的身分與情報區
  if (v.result && !playing) {
    box.appendChild(mk('div', 'table-result', v.result.text));
    if (v.result.reveal) {
      const rv = mk('div', 'it-reveal');
      for (const r of v.result.reveal) {
        const row = mk('div', 'it-reveal-row' + (r.win ? ' win' : ''));
        const rr = IT_ROLE[r.role] || ['?', '#888'];
        const badge = mk('span', 'it-role', rr[0]); badge.style.background = rr[1]; row.appendChild(badge);
        row.appendChild(mk('span', null, `${r.name}${r.char && itCharDef(r.char) ? `【${itCharDef(r.char).name}】` : ''}${r.win ? '　🏆' : ''}${r.out ? '（出局）' : ''}${r.left ? '（中途離開）' : ''}`));
        const ic = mk('span', 'it-intel'); for (const c of r.intel) ic.appendChild(itCardEl(c, { small: true })); row.appendChild(ic);
        rv.appendChild(row);
      }
      box.appendChild(rv);
    }
  }
  if (!playing && gd?.story) box.appendChild(mk('div', 'it-story', gd.story));   // 開局前：故事背景（有結算時放在結算下面）
  // 自己的身分
  if (playing && me >= 0 && v.seats[me]?.role) {
    const rr = IT_ROLE[v.seats[me].role], line = mk('div', 'it-me');
    const badge = mk('span', 'it-role', rr[0]); badge.style.background = rr[1];
    const mc = it.chars && v.seats[me].role === 'mage' ? itCharDef(v.seats[me].char) : null;   // 角色卡模式：咒術師改用角色卡的勝利條件（沒選完前先不顯示條件）
    line.append('你的身分：', badge, `　勝利條件：${it.chars && v.seats[me].role === 'mage' ? (mc ? mc.win + `（【${mc.name}】）` : '看你選的角色卡') : rr[2]}`);
    box.appendChild(line);
    if (it.chars && v.seats[me].char && me >= 0 && alive(me)) itSkillPanel(box, v, mk, send, { me, it, L, pend, nm, alive });
  }
  // 選角：每人 2 張選 1 張（觀戰者看得到所有人的候選）
  if (playing && it.step === 'pick') {
    if (v.choices) {
      const pr = mk('div', 'char-pick');
      v.choices.forEach(id => { const w = mk('div', 'char-pick-one'); w.appendChild(itCharCardEl(id, mk, { noNote: true })); const b = mk('button', 'ff-btn', '選這張'); b.onclick = () => S.net?.tbl?.({ a: 'ipick', c: id }); w.appendChild(b); pr.appendChild(w); });
      box.appendChild(pr);
      box.appendChild(mk('div', 'table-tag', '角色卡提供勝利條件（咒術師身分才用）與技能；公開型選完就翻開，隱藏型保持覆蓋。'));
    } else if (v.role === 'spec') {
      for (const s of v.seats) if (s.choices) { const w = mk('div', 'char-pick-spec'); w.appendChild(mk('div', 'table-tag', `${s.name}（${s.picked ? '已選' : '選角中'}）的候選：`)); const pr = mk('div', 'char-pick'); s.choices.forEach(id => pr.appendChild(itCharCardEl(id, mk, { noNote: true }))); w.appendChild(pr); box.appendChild(w); }
    }
  }
  // 座位：名字、身分（看得到才有）、手牌張數、情報區
  const row = mk('div', 'table-seats it-seats');
  v.seats.forEach((s, i) => {
    const cls = ['table-seat'];
    if (s.you) cls.push('you');
    if (playing && it.step === 'turn' && v.turn === i) cls.push('turn');
    if (playing && (s.out || s.left)) cls.push('out');
    const seat = mk('div', cls.join(' '));
    const head = mk('div', 'table-name', s.name + (s.you ? '（你）' : ''));
    if (playing && s.role) { const rr = IT_ROLE[s.role], b = mk('span', 'it-role small', rr[0]); b.style.background = rr[1]; head.appendChild(b); }
    if (playing && it.chars) {   // 角色卡：公開型翻開後大家看得到名稱；隱藏型覆蓋（自己與觀戰者看得到）
      const cd = s.char ? itCharDef(s.char) : null, tg = mk('span', 'it-char' + (s.char && !s.up ? ' covered' : ''), cd ? `【${cd.name}】${s.up ? '' : '（覆蓋）'}` : s.picked ? '🂠 角色卡' : '選角中');
      if (cd) { tg.title = '點一下看角色介紹'; tg.style.cursor = 'pointer'; tg.onclick = e => { e.stopPropagation(); itCharPop(s.char); }; }
      head.appendChild(tg);
    }
    seat.appendChild(head);
    if (playing) {
      const tags = [`手牌 ${s.n}`];
      if (L && L.at === i) tags.push(`✉ 拿著${IT_KIND[L.kind]}`);
      else if (L && L.seen.includes(i)) tags.push('碰過');
      if ((it.blocked || []).includes(i)) tags.push('🚫 本回不能收');
      if ((it.locked || []).includes(i)) tags.push('🔒 本回被鎖定');
      if (s.out) tags.push('出局'); if (s.left) tags.push('已離開');
      seat.appendChild(mk('div', 'table-tag', tags.join(' · ')));
      const ic = mk('div', 'it-intel'); for (const c of s.intel || []) ic.appendChild(itCardEl(c, { small: true }));
      seat.appendChild(ic);
      if (v.hands?.[i]) { const hh = mk('div', 'it-intel spec'); for (const c of v.hands[i]) hh.appendChild(itCardEl(c, { small: true })); seat.appendChild(hh); }   // 觀戰者：看得到手牌
    } else seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
    row.appendChild(seat);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  if (playing) {
    // 傳遞中的密函
    const mid = mk('div', 'it-mid');
    mid.appendChild(mk('div', 'table-tag', `牌堆 ${it.deck} 張 · 棄牌 ${it.discard} 張`));
    if (L) {
      const lt = mk('div', 'it-letter');
      lt.appendChild(itCardEl(L.card || null));
      lt.appendChild(mk('div', null, `${nm(L.from)} 投遞了${IT_KIND[L.kind]} → 現在在 ${nm(L.at)} 手上${L.icpt != null ? `（${nm(L.icpt)} 攔截過）` : ''}${L.kind === 'pub' ? '（公開，大家都看得到）' : L.open ? '（被調包，內容已公開）' : ''}${L.kind === 'direct' ? '　直達：目標可以不收，退回發信者' : ''}`));
      mid.appendChild(lt);
    }
    if (v.stolen) {   // 被竊取的提示：到下一階段（投遞出情報、換下一位）就消失
      const st2 = mk('div', 'it-note it-stolen');
      st2.append(`${v.stolen.by} 從你手上竊取了：`); st2.appendChild(itCardEl(v.stolen.card, { small: true })); st2.append(itLabel(v.stolen.card));
      mid.appendChild(st2);
    }
    if (v.note) {   // 自己偷看到的東西（截閱／搜身），到下次輪到自己時清掉
      const nt = mk('div', 'it-note');
      if (v.note.k === 'steal') { nt.append(`你從 ${v.note.tgt} 手上竊取了：`); nt.appendChild(itCardEl(v.note.card, { small: true })); nt.append(itLabel(v.note.card)); }
      else if (v.note.k === 'verify') {   // 查驗結果（對方可以謊報的話，這是他自己選的回答）
        nt.append(`你查驗了 ${v.note.tgt}：`);
        if (v.note.ans === 'hide') nt.append('對方不透露');
        else { const rr = IT_ROLE[v.note.ans] || ['?', '#888'], b = mk('span', 'it-role small', rr[0]); b.style.background = rr[1]; nt.appendChild(b); }
      } else if (v.note.k === 'view') { nt.append(`【旁聽】${v.note.tgt} 的全部手牌：`); for (const c of v.note.cards) { nt.appendChild(itCardEl(c, { small: true })); nt.append(itLabel(c) + '　'); } if (!v.note.cards.length) nt.append('（他沒有手牌）'); }
      else if (v.note.k === 'aim') { nt.append(`【瞄準】你偷看到 ${v.note.tgt} 的一張手牌：`); nt.appendChild(itCardEl(v.note.card, { small: true })); nt.append(itLabel(v.note.card)); }
      else if (v.note.k === 'peek') { nt.append('你截閱到的密函：'); nt.appendChild(itCardEl(v.note.card, { small: true })); nt.append(itLabel(v.note.card)); }
      else { nt.append(`你搜到 ${v.note.tgt} 的手牌：`); for (const c of v.note.cards) { nt.appendChild(itCardEl(c, { small: true })); nt.append(itLabel(c) + '　'); } if (!v.note.cards.length) nt.append('（他沒有手牌）'); }
      mid.appendChild(nt);
    }
    box.appendChild(mid);
  }
  const btns = mk('div', 'table-btns');
  if (playing && me >= 0 && alive(me) && it.step !== 'pick' && !it.prompt) {   // 選角階段不顯示手牌操作
    const hand = v.hand || [];
    // 識破：別人的行動生效前，手上有識破牌就能出
    if (pend && pend.by !== me) {
      const ci = hand.findIndex(c => itActOf(c) === 'C');
      if (ci >= 0) { const b = mk('button', 'ff-btn', '識破！'); b.onclick = () => send({ a: 'iact', idx: ci }); btns.appendChild(b); }
      if (it.untimed) {   // 不限時：所有活人按「準備繼續」才生效（出牌的人自動算）
        const done = pend.ok.includes(me), b = mk('button', 'ff-btn' + (done ? ' small' : ''), done ? '已準備（等其他人）' : '準備繼續');
        if (done) b.disabled = true; else b.onclick = () => send({ a: 'iok' });
        btns.appendChild(b);
      }
    }
    if (playing && it.arrive && !pend && it.untimed && L && L.at !== me) {   // 不限時：情報到達新持有者手上，所有活人按「準備繼續」他才能決定
      const done = it.arrive.ok.includes(me), b = mk('button', 'ff-btn' + (done ? ' small' : ''), done ? '已準備（等其他人）' : '準備繼續');
      if (done) b.disabled = true; else b.onclick = () => send({ a: 'iok' });
      btns.appendChild(b);
    }
    if (playing && it.step === 'ack' && it.untimed && it.ack.by !== me) {   // 不限時：收下情報後，所有活人按「準備繼續」才換下一位（收下的人自動算）
      const done = it.ack.ok.includes(me), b = mk('button', 'ff-btn' + (done ? ' small' : ''), done ? '已準備（等其他人）' : '準備繼續');
      if (done) b.disabled = true; else b.onclick = () => send({ a: 'iok' });
      btns.appendChild(b);
    }
    if (it.ask && it.ask.tgt === me) {   // 被查驗、而且可以自己決定回答（之後的身分牌技能）：沙都／水都／咒術師／不透露
      btns.appendChild(mk('span', 'table-tag', `回答 ${nm(it.ask.by)} 的查驗：`));
      for (const [k, label] of [['sand', '沙都'], ['water', '水都'], ['mage', '咒術師'], ['hide', '不透露']]) { const b = mk('button', 'ff-btn small', label); b.onclick = () => send({ a: 'ians', v: k }); btns.appendChild(b); }
    }
    if (holding) {   // 收下／轉手：只能傳給座位順序的下一位（直達情報：攔截者退回給發信者）
      const blockedMe = (it.blocked || []).includes(me) && L.next >= 0, tk = mk('button', 'ff-btn', blockedMe ? '收下（本回被阻擋）' : '收下');
      if (blockedMe) tk.disabled = true; else tk.onclick = () => send({ a: 'itake' });
      btns.appendChild(tk);
      if (L.next >= 0) { const b = mk('button', 'ff-btn small', `${L.kind === 'direct' ? '不收，退回給' : L.next === L.from ? '不收，退回給發信者' : '傳給'} ${nm(L.next)}`); b.onclick = () => send({ a: 'ifwd' }); btns.appendChild(b); }
    }
    // 手牌：點一張選取，再選要投遞或使用
    const hw = mk('div', 'it-hand');
    hand.forEach((c, k) => {
      const e = itCardEl(c, { sel: k === S.itSel });
      e.onclick = () => {
        if (S.itMode === 'S' && k !== S.itSel) { send({ a: 'iact', idx: S.itSel, sel: k, ...(S.itAsS ? { as: 'S' } : {}) }); return; }   // 調包：選換進去的那張（偷天換日：用雙色牌當調包）
        S.itSel = k === S.itSel ? -1 : k; S.itMode = null; S.itWTgt = -1; S.itAsS = false; S.itAs = null; buildTable();
      };
      hw.appendChild(e);
    });
    const sel = S.itSel >= 0 && S.itSel < hand.length ? hand[S.itSel] : null;
    const opts = mk('div', 'table-btns it-opts');
    if (sel) {
      const act = itActOf(sel), passing = !pend && it.step === 'pass' && L, atMe = passing && L.at === me, canSee = L && L.kind !== 'pub' && !L.open;
      const others = v.seats.map((x, i) => i).filter(i => alive(i) && i !== me), tTargets = others.filter(i => !(it.blocked || []).includes(i)), fTargets = others.filter(i => !(it.locked || []).includes(i)), bTargets = v.seats.map((x, i) => i).filter(i => alive(i) && !(it.blocked || []).includes(i));
      const blackIn = v.seats.map((x, i) => i).filter(i => alive(i) && (v.seats[i].intel || []).some(c => itCols(c).includes('K')));
      const usable = { P: atMe && canSee, S: atMe && canSee && hand.length > 1, F: (v.turn === me || (v.seats[me].char === 'harmonizer' && v.seats[me].up)) && !it.ask && ((it.step === 'turn' && !L && (myTurn || (v.seats[me].char === 'harmonizer' && v.seats[me].up))) || passing) && fTargets.length > 0, X: passing, I: passing && L.at !== me && L.from !== me, H: myTurn, V: myTurn, D: myTurn && !L, R: myTurn && !L && others.length > 0, W: !pend && blackIn.length > 0, T: atMe && !(it.locked || []).includes(me) && tTargets.length > 0, B: passing && bTargets.length > 0, N: myTurn && !L, C: false }[act];
      opts.appendChild(mk('span', 'table-tag', `${itLabel(sel)}：${IT_ACT_TIP[act]}`));
      if (myTurn) {   // 投遞方式由卡面決定：密函（蓋著）／公開情報（翻開）依座位順序傳給下一位；直達要指定一人（對方必須收下）
        const kind = itKindOf(sel), nn = nm(itNextSeat(v, me));
        if (kind === 'direct') { const b = mk('button', 'ff-btn', '投遞這張（直達情報：指定一人，對方不收會退回給你）'); b.onclick = () => { S.itMode = 'direct'; buildTable(); }; opts.appendChild(b); }
        else { const b = mk('button', 'ff-btn', `投遞這張（${IT_KIND[kind]}：${kind === 'pub' ? '翻開' : '蓋著'}傳給 ${nn}）`); b.onclick = () => send({ a: 'isend', idx: S.itSel }); opts.appendChild(b); }
      }
      if (atMe && canSee && hand.length > 1 && itCols(sel).length === 2 && v.seats[me].char === 'doubleagent' && act !== 'S') {   // 雙面間諜「偷天換日」：雙色牌當作調包使用
        const b = mk('button', 'ff-btn', '當作調包使用（偷天換日）'); b.onclick = () => { S.itMode = 'S'; S.itAsS = true; buildTable(); }; opts.appendChild(b);
      }
      const myCh = v.seats[me].char, chUp = !!v.seats[me].up, chUsed = !!v.seats[me].used;
      const canLock = v.turn === me && !it.ask && ((myTurn && !L) || passing) && fTargets.length > 0;
      if (myCh === 'killer' && chUp && canLock) {   // 殺手：標記目標（密函當作鎖定，可被識破）／死亡預告（任一張當作鎖定，一局一次，不能被識破）
        if (itKindOf(sel) === 'seal' && act !== 'F') { const b = mk('button', 'ff-btn', '當作鎖定使用（標記目標）'); b.onclick = () => { S.itMode = 'F'; S.itAs = 'F'; buildTable(); }; opts.appendChild(b); }
        if (!chUsed) { const b = mk('button', 'ff-btn', '死亡預告：當作鎖定（不能被識破）'); b.onclick = () => { S.itMode = 'F'; S.itAs = 'F!'; buildTable(); }; opts.appendChild(b); }
      }
      if (myCh === 'harmonizer' && chUp && !chUsed && itKindOf(sel) === 'direct' && !it.ask && ((it.step === 'turn' && !L) || passing) && fTargets.length > 0) {   // 調和者「調和」（一局一次）：直達當作鎖定，不能被識破
        const b = mk('button', 'ff-btn', '調和：當作鎖定（不能被識破）'); b.onclick = () => { S.itMode = 'F'; S.itAs = 'F!'; buildTable(); }; opts.appendChild(b);
      }
      if (myCh === 'sniper' && chUp && !chUsed && myTurn && itCols(sel).includes('K')) {   // 狙擊手「殺意」（一局一次）：咒函當作直達送出
        const b = mk('button', 'ff-btn', '殺意：當作直達送出'); b.onclick = () => { S.itMode = 'direct'; S.itAs = 'direct'; buildTable(); }; opts.appendChild(b);
      }
      if (usable) {
        const b = mk('button', 'ff-btn', act === 'P' ? '使用截閱（自己偷看）' : `使用${IT_ACT[act]}`);
        b.onclick = () => { if (act === 'F' || act === 'H' || act === 'V' || act === 'R' || act === 'W' || act === 'S' || act === 'T' || act === 'B') { S.itMode = act; S.itWTgt = -1; buildTable(); } else send({ a: 'iact', idx: S.itSel }); };
        opts.appendChild(b);
        if (act === 'P') {   // 截閱：宣告一個顏色＝一定公開這封情報；猜對（雙色只要包含）抽 1 張，猜錯只是不能抽
          opts.appendChild(mk('span', 'table-tag', '或宣告顏色並公開：'));
          for (const c of ['Y', 'B', 'K']) { const bc = mk('button', 'ff-btn small', `宣告${IT_CNAME[c]}`); bc.title = `公開這封情報；含${IT_CNAME[c]}色就抽 1 張`; bc.onclick = () => send({ a: 'iact', idx: S.itSel, col: c }); opts.appendChild(bc); }
        }
      }
      // 選對象
      const pickBtns = (title, list, fn) => { opts.appendChild(mk('span', 'table-tag it-opt-title', title)); list.forEach(i => { const b = mk('button', 'ff-btn small', v.seats[i].name); b.onclick = () => fn(i); opts.appendChild(b); }); };
      if (S.itMode === 'direct') pickBtns('直達給誰？（對方不收會退回給你，你必須收下）', others, i => send({ a: 'isend', idx: S.itSel, to: i, ...(S.itAs === 'direct' ? { as: 'direct' } : {}) }));
      else if (S.itMode === 'H') pickBtns('搜誰的身？', others, i => send({ a: 'iact', idx: S.itSel, tgt: i }));
      else if (S.itMode === 'V') pickBtns('查驗誰？', others, i => send({ a: 'iact', idx: S.itSel, tgt: i }));
      else if (S.itMode === 'R') pickBtns('竊取誰的手牌？', others, i => send({ a: 'iact', idx: S.itSel, tgt: i }));
      else if (S.itMode === 'F') pickBtns('鎖定誰？（本回情報到他手上就必須收下）', fTargets, i => send({ a: 'iact', idx: S.itSel, tgt: i, ...(S.itAs ? { as: S.itAs } : {}) }));
      else if (S.itMode === 'T') pickBtns('轉移給誰？（他不能拒收）', tTargets, i => send({ a: 'iact', idx: S.itSel, tgt: i }));
      else if (S.itMode === 'B') pickBtns('阻擋誰？（本回他不能收下情報）', bTargets, i => send({ a: 'iact', idx: S.itSel, tgt: i }));
      else if (S.itMode === 'W' && !(S.itWTgt >= 0)) pickBtns('洗誰的情報區？（只列出有黑的人）', blackIn, i => { S.itWTgt = i; buildTable(); });
      else if (S.itMode === 'W') {
        opts.appendChild(mk('span', 'table-tag it-opt-title', `洗掉 ${nm(S.itWTgt)} 的哪一封？`));
        (v.seats[S.itWTgt].intel || []).forEach((c, k) => {
          if (!itCols(c).includes('K')) return;
          const b = mk('button', 'ff-btn small', itLabel(c)); b.onclick = () => send({ a: 'iact', idx: S.itSel, tgt: S.itWTgt, sel: k }); opts.appendChild(b);
        });
      } else if (S.itMode === 'S') opts.appendChild(mk('span', 'table-tag', '點另一張手牌，把它換進密函'));
    } else if (hand.length) opts.appendChild(mk('span', 'table-tag', myTurn ? '點一張手牌：投遞或使用' : '點手牌可以看說明、使用行動'));
    box.appendChild(hw); box.appendChild(opts);
  }
  if (!playing) {   // 模式：限時（預設）／不限時（沒有倒數，每次行動都要所有活人按「準備繼續」）；桌主（第一位入座的人）在開局前選
    const isHost = v.role === 'seat' && v.me === 0, md = mk('div', 'table-btns');
    for (const [m, desc] of [['timed', '限時'], ['untimed', '不限時']]) {
      const b = mk('button', 'ff-btn small' + ((!!v.untimed) === (m === 'untimed') ? ' active' : ''), desc);
      if (isHost) b.onclick = () => S.net?.tbl?.({ a: 'imode', v: m }); else b.disabled = true;
      md.appendChild(b);
    }
    box.appendChild(md);
    const cm = mk('div', 'table-btns');   // 角色卡：開（每人 2 張角色卡選 1，咒術師改用角色卡的勝利條件；第 0 階段技能尚未啟用）／關（照原本規則）
    for (const [on, desc] of [[false, '角色卡：關'], [true, '角色卡：開']]) {
      const b = mk('button', 'ff-btn small' + ((!!v.chars) === on ? ' active' : ''), desc);
      if (isHost) b.onclick = () => S.net?.tbl?.({ a: 'ichars', v: on }); else b.disabled = true;
      cm.appendChild(b);
    }
    box.appendChild(cm);
    box.appendChild(mk('div', 'table-tag', v.chars ? '角色卡開啟：開局每人拿 2 張角色卡選 1 張；咒術師不再靠集滿 3 張咒函獲勝，改用角色卡的勝利條件，而且也會因收到第 3 張咒函出局。' : '角色卡關閉：維持原本規則（咒術師集滿 3 張咒函獲勝）。'));
    box.appendChild(mk('div', 'table-tag', (isHost ? '你是桌主，可以選模式。' : '模式由桌主（第一位入座的人）選。') + (v.untimed ? ' 不限時：沒有倒數，每次使用行動牌後要所有活人按「準備繼續」才生效。' : ' 限時：投遞 30 秒、收轉 15 秒、識破 5 秒。')));
  }
  if (v.role === 'seat' && !playing) {
    const m = v.seats[v.me], b = mk('button', 'ff-btn', m.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !m.ready }); btns.appendChild(b);
    const sd = mk('button', 'ff-btn small', '改為觀戰'); sd.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(sd);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- UNO（第六桌 t6）：牌面用 DOM 畫（原創設計：圓角色塊＋大符號）；規則與狀態全在伺服器，客戶端只畫畫面、送 play／draw／pass／uno／catch／timeout／mode ----
const UN_FILL = { R: '#d83a3a', Y: '#e8b820', G: '#2ea84a', B: '#2f66d8' };
const UN_CNAME = { R: '紅', Y: '黃', G: '綠', B: '藍' };
function unCardEl(c, opts = {}) {   // c＝'R5'／'Gs'／'Br'／'Yd'／'W'／'F'；null＝牌背
  const e = document.createElement('div');
  if (!c) { e.className = 'ucard back'; return e; }
  e.className = 'ucard' + (opts.big ? ' big' : '');
  const wild = c === 'W' || c === 'F', v = wild ? c : c.slice(1);
  if (wild) e.classList.add('wild'); else e.style.background = UN_FILL[c[0]];
  const sym = { s: '⊘', r: '⇄', d: '+2', W: '★', F: '+4' }[v] || v;
  e.textContent = sym;
  if (opts.color && wild) e.style.boxShadow = `inset 0 0 0 4px ${UN_FILL[opts.color]}`;   // 變色牌打出後，用邊框顯示選的顏色
  return e;
}
const unSortKey = c => (c === 'W' || c === 'F' ? 9 : 'RYGB'.indexOf(c[0])) * 100 + ({ s: 10, r: 11, d: 12 }[c.slice(1)] ?? (c === 'W' ? 20 : c === 'F' ? 21 : Number(c.slice(1))));
function unStopTimer() { if (S.unTimer) { clearInterval(S.unTimer); S.unTimer = 0; } }
function unStartTimer(v) {
  unStopTimer();
  S.unOff = v.un.sn - Date.now();   // 伺服器時間 − 本機時間（毫秒，忽略單程延遲）
  S.unTimer = setInterval(() => {
    const cur = S.tableView;
    if (!S.tableOpen || !cur || cur.game !== 'uno' || cur.phase !== 'playing') { unStopTimer(); return; }
    const left = (cur.un.deadline - (Date.now() + S.unOff)) / 1000;
    const el = $('unTimer'); if (el) el.textContent = left > 0 ? `${Math.ceil(left)} 秒` : '時間到';
    if (left <= 0 && Date.now() - (S.unTimeoutAt || 0) > 1000) { S.unTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }
  }, 250);
}
function buildUno(box, v, mk, gd) {
  const playing = v.phase === 'playing', mySeat = v.role === 'seat' ? v.seats[v.me] : null, un = v.un;
  const myTurn = playing && v.role === 'seat' && v.turn === v.me;
  const modeName = m => (m === 'wild' ? '無限制玩法' : '傳統玩法');
  if (!playing) unStopTimer();
  // 狀態列
  let status;
  if (playing) {
    const who = v.seats[v.turn]?.name;
    status = v.role === 'spec' ? `觀戰中 · 輪到 ${who}` : myTurn ? '輪到你出牌' : `輪到 ${who}`;
    if (un.pending > 0) status += `　累積 ${un.pending} 張，${myTurn ? '接著出 + 牌傳下去，或吃下' : '等他決定'}`;
    else if (un.skip) status += `　${myTurn ? '你被跳過了：可以出跳過牌傳下去，或放棄' : '被跳過中'}`;
    else if (myTurn && un.drawn) status += '　抽到的牌可以出，或放棄';
  } else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.appendChild(mk('div', 'table-status' + (myTurn ? ' mine' : ''), status));
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  // 玩法（開局前由桌主＝第一位入座者選）
  if (!playing) {
    const mrow = mk('div', 'table-btns');
    const isHost = v.role === 'seat' && v.me === 0;
    for (const [m, desc] of [['classic', '傳統玩法'], ['wild', '無限制玩法']]) {
      const b = mk('button', 'ff-btn small' + (v.mode === m ? ' active' : ''), desc);
      if (isHost) b.onclick = () => S.net?.tbl?.({ a: 'mode', v: m }); else b.disabled = true;
      mrow.appendChild(b);
    }
    box.appendChild(mrow);
    box.appendChild(mk('div', 'table-tag', (isHost ? '你是桌主，可以選玩法。' : '玩法由桌主（第一位入座的人）選。') + (v.mode === 'wild' ? ' 無限制：+2／+4 可以無限累積傳遞、跳過可以傳遞、沒牌可出時可以一直抽牌。' : ' 傳統：+2／+4 不可疊加、沒牌可出時抽 1 張。')));
  }
  // 座位
  const row = mk('div', 'table-seats');
  v.seats.forEach((s, i) => {
    const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (s.left ? ' out' : ''));
    seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : '')));
    seat.appendChild(mk('div', 'table-tag', playing ? (s.left ? '' : `${s.n} 張${s.n === 1 ? ' · UNO!' : ''}${v.turn === i ? ' · 出牌中' : ''}`) : (s.ready ? '已準備' : '未準備')));
    if (playing && !s.left) {
      const cards = mk('div', 'table-cards');
      if (v.hands) for (const c of v.hands[i] || []) cards.appendChild(unCardEl(c));   // 觀戰：每個人的牌都翻開
      else if (!s.you) for (let k = 0; k < Math.min(s.n, 14); k++) cards.appendChild(unCardEl(null));
      seat.appendChild(cards);
    }
    row.appendChild(seat);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  // 桌面：最上面一張、目前顏色、方向、牌堆張數、倒數
  if (playing) {
    const mid = mk('div', 'uno-mid');
    const pile = mk('div', 'uno-pile'); pile.appendChild(unCardEl(un.top, { big: true, color: (un.top === 'W' || un.top === 'F') ? un.color : null }));
    mid.appendChild(pile);
    const info = mk('div', 'uno-info');
    const col = mk('div', 'uno-color', `目前顏色：${UN_CNAME[un.color]}`); col.style.color = UN_FILL[un.color]; info.appendChild(col);
    info.appendChild(mk('div', 'table-tag', `方向：${un.dir > 0 ? '順時針 ↻' : '逆時針 ↺'}　牌堆剩 ${un.deck} 張`));
    const tm = mk('div', 'uno-timer'); tm.id = 'unTimer'; info.appendChild(tm);
    mid.appendChild(info); box.appendChild(mid);
    unStartTimer(v);
  }
  // 我的手牌（照顏色與點數排列；每張帶原本的位置編號 idx，出牌時送給伺服器）
  if (v.role === 'seat' && playing) {
    const hand = mk('div', 'table-hand'), cs = mk('div', 'table-cards big uno-hand');
    const order = (v.hand || []).map((c, idx) => ({ c, idx })).sort((a, b) => unSortKey(a.c) - unSortKey(b.c));
    for (const { c, idx } of order) {
      const el = unCardEl(c, { big: true }), ok = myTurn && (v.playable || []).includes(idx);
      el.classList.add(ok ? 'playable' : 'dim');
      if (ok) el.onclick = () => {
        if (c === 'W' || c === 'F' || v.hand.length === 2) { S.unPick = { idx, color: null }; buildTable(); return; }   // 變色牌要先選顏色；剩 2 張時要選「出牌」或「出牌並喊 UNO」
        S.net?.tbl?.({ a: 'play', idx });
      };
      cs.appendChild(el);
    }
    hand.appendChild(cs); box.appendChild(hand);
    const pickCard = S.unPick ? (v.hand || [])[S.unPick.idx] : null;
    if (pickCard && myTurn) {
      const pk = mk('div', 'table-btns'), wildPick = pickCard === 'W' || pickCard === 'F';
      const send = (uno) => { const { idx, color } = S.unPick; S.unPick = null; S.net?.tbl?.({ a: 'play', idx, color: color || undefined, uno: uno || undefined }); };
      if (wildPick && !S.unPick.color) {   // 選顏色
        pk.appendChild(mk('span', 'table-tag', '選一個顏色：'));
        for (const c of 'RYGB') {
          const b = mk('button', 'ff-btn small', UN_CNAME[c]); b.style.background = UN_FILL[c]; b.style.color = '#fff';
          b.onclick = () => { S.unPick.color = c; if (v.hand.length === 2) buildTable(); else send(false); };
          pk.appendChild(b);
        }
      } else {   // 剩 2 張：出牌後只剩 1 張，可以直接「出牌並喊 UNO」
        pk.appendChild(Object.assign(mk('button', 'ff-btn small', '出牌'), { onclick: () => send(false) }));
        pk.appendChild(Object.assign(mk('button', 'ff-btn small uno-alert', '出牌並喊 UNO！'), { onclick: () => send(true) }));
      }
      const cancel = mk('button', 'ff-btn small', '取消'); cancel.onclick = () => { S.unPick = null; buildTable(); }; pk.appendChild(cancel);
      box.appendChild(pk);
    } else S.unPick = null;
  } else S.unPick = null;
  // 操作按鈕：遊戲動作靠右、「離開」靠左，避免連點時誤按到離開
  const btns = mk('div', 'table-btns uno-bar'), acts = mk('div', 'uno-acts');
  if (v.role === 'seat' && playing) {
    if (v.canDraw) acts.appendChild(Object.assign(mk('button', 'ff-btn', un.pending > 0 ? `吃下 ${un.pending} 張` : '抽牌'), { onclick: () => S.net?.tbl?.({ a: 'draw' }) }));
    if (v.canPass) acts.appendChild(Object.assign(mk('button', 'ff-btn', un.skip ? '接受被跳過' : '放棄'), { onclick: () => S.net?.tbl?.({ a: 'pass' }) }));
    if (un.pend === v.me) acts.appendChild(Object.assign(mk('button', 'ff-btn uno-alert', 'UNO！'), { onclick: () => S.net?.tbl?.({ a: 'uno' }) }));   // 出到剩 1 張忘了喊：補喊（被抓之前）
    if (un.pend >= 0 && un.pend !== v.me) acts.appendChild(Object.assign(mk('button', 'ff-btn uno-alert', `抓！${v.seats[un.pend]?.name} 沒喊 UNO`), { onclick: () => S.net?.tbl?.({ a: 'catch' }) }));
  } else if (v.role === 'seat' && !playing) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); acts.appendChild(b);
    const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); acts.appendChild(st);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); acts.appendChild(b);
  }
  btns.appendChild(acts);   // 小遊戲下方不放離開按鈕（避免玩到一半誤按），離開只留右上角與 Esc
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 俄羅斯方塊（t13，2026-11-13，使用者要求）：場地上方 4 台街機共用一張邏輯桌，每台一個人玩 ----
// 單人模式：各自一局，分數進排行榜；聯機模式：發起後其他機台的人收到邀請（最多 4 人），一般模式（各玩各的、全員出局後依分數排名）
// 或對戰模式（一次消 2／3／4 行送每個對手 1／2／4 行垃圾，使用者定）。方塊遊戲在本機跑（信任客戶端），伺服器只給 seed、轉發盤面快照與垃圾行。
// 協定見 notes「和平島與遊戲桌」：tbl {a:'solo'|'link'|'lmode'|'ljoin'|'lno'|'lquit'|'lstart'|'tb'|'clr'|'over'}；s→c ttb（盤面快照）、tgb（垃圾行）
const AR_W = 10, AR_H = 22, AR_VIS = 20, AR_CELL = 20;   // 盤面 10×22（最上面 2 列在畫面外，方塊從那裡生出來）
const AR_COLORS = ['', '#40c8e0', '#f0c020', '#a060e0', '#3cb45a', '#e04848', '#3b78e8', '#e8902a', '#7a7f8c'];   // 1 I、2 O、3 T、4 S、5 Z、6 J、7 L、8 垃圾
const AR_CAB_COLORS = ['#d84a4a', '#3b78e8', '#3cb45a', '#9a5ad8'];   // 4 台機台的外殼主色（同 gen_assets.py 的 ARCADE_COLORS）
const AR_BASE = {   // 每種方塊的初始方向：[盒子大小, 格子 [x, y]]（y 往下）
  1: [4, [[0, 1], [1, 1], [2, 1], [3, 1]]], 2: [2, [[0, 0], [1, 0], [0, 1], [1, 1]]], 3: [3, [[1, 0], [0, 1], [1, 1], [2, 1]]],
  4: [3, [[1, 0], [2, 0], [0, 1], [1, 1]]], 5: [3, [[0, 0], [1, 0], [1, 1], [2, 1]]], 6: [3, [[0, 0], [0, 1], [1, 1], [2, 1]]], 7: [3, [[2, 0], [0, 1], [1, 1], [2, 1]]],
};
const AR_ROT = {};   // AR_ROT[種類][方向 0～3]＝格子（在盒子裡順時針轉）
for (const [k, [n, cells]] of Object.entries(AR_BASE)) {
  const r = [cells];
  for (let d = 1; d < 4; d++) r.push(r[d - 1].map(([x, y]) => [n - 1 - y, x]));
  AR_ROT[k] = r;
}
// 轉向的踢牆位移（常見的 SRS 表；表上 y 往上，套用時 y 取負）
const AR_KICK = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const AR_KICK_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};
const AR_LINE_PTS = [0, 100, 300, 500, 800];   // 一次消 1～4 行 × 等級
const AR_DAS = 150, AR_ARR = 40, AR_LOCK = 500, AR_LOCK_RESETS = 15, AR_SNAP_MS = 250;
const AR_KEYS = { arrowleft: 'L', arrowright: 'R', arrowdown: 'D', arrowup: 'CW', x: 'CW', z: 'CCW', ' ': 'HD', c: 'HOLD', shift: 'HOLD' };
const arFall = lv => Math.max(30, 1000 * Math.pow(0.8 - (lv - 1) * 0.007, lv - 1));   // 每格落下的毫秒（等級越高越快）
function arRng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function arNew(seed, t0, off, key) {
  const A = { key, t0, off, rng: arRng(seed), bag: [], queue: [], board: Array.from({ length: AR_H }, () => new Array(AR_W).fill(0)),
    cur: null, hold: 0, held: false, sc: 0, ln: 0, lv: 1, dead: false, fallAcc: 0, lockT: 0, resets: 0, keys: {}, das: {}, gq: 0,
    last: performance.now(), snapAt: 0, snapStr: '', flash: null, started: false };
  for (let i = 0; i < 5; i++) A.queue.push(arDraw(A));
  return A;
}
function arDraw(A) {   // 7 種一袋輪流抽（同一個 seed＝同一串方塊，聯機時大家拿到的方塊一樣）
  if (!A.bag.length) { A.bag = [1, 2, 3, 4, 5, 6, 7]; for (let i = 6; i > 0; i--) { const j = Math.floor(A.rng() * (i + 1)); [A.bag[i], A.bag[j]] = [A.bag[j], A.bag[i]]; } }
  return A.bag.pop();
}
const arCells = p => AR_ROT[p.k][p.r].map(([x, y]) => [p.x + x, p.y + y]);
function arFits(A, p) {
  for (const [x, y] of arCells(p)) if (x < 0 || x >= AR_W || y >= AR_H || (y >= 0 && A.board[y][x])) return false;
  return true;
}
function arSpawn(A, k) {
  const p = { k, r: 0, x: k === 2 ? 4 : 3, y: 1 };
  A.cur = p; A.lockT = 0; A.resets = 0; A.fallAcc = 0;
  if (!arFits(A, p)) arGameOver(A);
}
function arNext(A) { const k = A.queue.shift(); A.queue.push(arDraw(A)); arSpawn(A, k); }
function arGrounded(A) { const p = A.cur; return !arFits(A, { ...p, y: p.y + 1 }); }
function arMove(A, dx) {
  const p = A.cur, q = { ...p, x: p.x + dx };
  if (!arFits(A, q)) return false;
  A.cur = q; arTouch(A); return true;
}
function arRotate(A, dir) {   // dir＝1 順時針、−1 逆時針
  const p = A.cur; if (p.k === 2) return;
  const to = (p.r + dir + 4) % 4, kicks = (p.k === 1 ? AR_KICK_I : AR_KICK)[`${p.r}${to}`];
  for (const [dx, dy] of kicks) {
    const q = { ...p, r: to, x: p.x + dx, y: p.y - dy };
    if (arFits(A, q)) { A.cur = q; arTouch(A); return; }
  }
}
function arTouch(A) { if (A.lockT > 0 && A.resets < AR_LOCK_RESETS) { A.lockT = 0; A.resets++; } }   // 落地後還在移動／轉向：重新計算鎖定時間（有次數上限）
function arHardDrop(A) {
  let n = 0;
  while (arFits(A, { ...A.cur, y: A.cur.y + 1 })) { A.cur.y++; n++; }
  A.sc += n * 2; arLock(A);
}
function arHold(A) {
  if (A.held) return;
  const k = A.cur.k;
  if (A.hold) arSpawn(A, A.hold); else arNext(A);
  A.hold = k; A.held = true;
}
function arLock(A) {
  const cells = arCells(A.cur);
  for (const [x, y] of cells) if (y >= 0) A.board[y][x] = A.cur.k;
  if (cells.every(([, y]) => y < AR_H - AR_VIS)) { arGameOver(A); return; }   // 整塊停在畫面外：頂到了
  const full = [];
  for (let y = 0; y < AR_H; y++) if (A.board[y].every(c => c)) full.push(y);
  if (full.length) {
    for (const y of full) { A.board.splice(y, 1); A.board.unshift(new Array(AR_W).fill(0)); }
    A.sc += AR_LINE_PTS[full.length] * A.lv; A.ln += full.length; A.lv = Math.min(20, 1 + Math.floor(A.ln / 10));
    A.flash = { n: full.length, until: performance.now() + 900 };
    const lk = S.tableView?.link;
    if (full.length >= 2 && lk?.phase === 'playing' && lk.mode === 'battle') S.net?.tbl?.({ a: 'clr', n: full.length });   // 對戰模式：讓伺服器送對手垃圾行
  }
  if (A.gq > 0) {   // 收到的垃圾行在方塊放好時才推上來（同一批的缺口在同一欄）
    const n = Math.min(A.gq, AR_H), hole = Math.floor(Math.random() * AR_W);
    A.gq = 0;
    const over = A.board.slice(0, n).some(r => r.some(c => c));
    A.board.splice(0, n);
    for (let i = 0; i < n; i++) { const r = new Array(AR_W).fill(8); r[hole] = 0; A.board.push(r); }
    if (over) { arGameOver(A); return; }
  }
  A.held = false;
  arNext(A);
  arSnap(A, true);
}
function arGameOver(A) {
  if (A.dead) return;
  A.dead = true; A.cur = null;
  arSnap(A, true);
  S.net?.tbl?.({ a: 'over', sc: A.sc, ln: A.ln });
}
function arBoardStr(A) {   // 畫面上的 20 列（含正在落下的方塊），每格一個數字
  const b = A.board.slice(AR_H - AR_VIS).map(r => [...r]);
  if (A.cur) for (const [x, y] of arCells(A.cur)) { const yy = y - (AR_H - AR_VIS); if (yy >= 0) b[yy][x] = A.cur.k; }
  return b.map(r => r.join('')).join('');
}
function arSnap(A, force) {   // 盤面快照給觀戰者與聯機對手看（約 4 次／秒、有變化才送）
  const now = performance.now();
  if (!force && now - A.snapAt < AR_SNAP_MS) return;
  const s = arBoardStr(A);
  if (!force && s === A.snapStr) return;
  A.snapAt = now; A.snapStr = s;
  S.net?.tbl?.({ a: 'tb', b: s, sc: A.sc, ln: A.ln });
}
function arStep(A) {
  const now = performance.now(), dt = Math.min(100, now - A.last);
  A.last = now;
  if (A.dead) return;
  if (Date.now() + A.off < A.t0) return;   // 開局倒數中
  if (!A.started) { A.started = true; arNext(A); if (A.dead) return; }
  for (const d of ['L', 'R']) {   // 按住左右：先等 AR_DAS 再每 AR_ARR 移一格
    if (!A.keys[d]) continue;
    const st = A.das[d] ||= { t: 0, rep: 0 };
    st.t += dt;
    if (st.t >= AR_DAS) { st.rep += dt; while (st.rep >= AR_ARR) { st.rep -= AR_ARR; if (!arMove(A, d === 'L' ? -1 : 1)) break; } }
  }
  const fall = A.keys.D ? Math.min(arFall(A.lv), 35) : arFall(A.lv);
  if (arGrounded(A)) {
    A.lockT += dt;
    if (A.lockT >= AR_LOCK) arLock(A);
  } else {
    A.fallAcc += dt;
    while (A.fallAcc >= fall && !arGrounded(A)) { A.fallAcc -= fall; A.cur.y++; if (A.keys.D) A.sc += 1; }
    if (arGrounded(A)) A.fallAcc = 0;
  }
  if (!A.dead) arSnap(A, false);
}
function arKey(e) {   // 遊戲畫面開著時的按鍵（回 true＝已處理）
  const A = S.ar, act = AR_KEYS[e.key.toLowerCase()];
  if (!A || A.dead || !act) return false;
  e.preventDefault();
  if (!A.started || !A.cur) return true;
  if (act === 'L' || act === 'R') { if (!A.keys[act]) { A.keys[act] = true; A.das[act] = { t: 0, rep: 0 }; A.keys[act === 'L' ? 'R' : 'L'] = false; arMove(A, act === 'L' ? -1 : 1); } }
  else if (act === 'D') A.keys.D = true;
  else if (e.repeat) return true;
  else if (act === 'CW') arRotate(A, 1);
  else if (act === 'CCW') arRotate(A, -1);
  else if (act === 'HD') arHardDrop(A);
  else if (act === 'HOLD') arHold(A);
  return true;
}
function arKeyUp(k) { const A = S.ar, act = AR_KEYS[k]; if (A && (act === 'L' || act === 'R' || act === 'D')) A.keys[act] = false; }
function onNetTtb(m) { (S.arOpp ||= {})[m.cab] = { b: m.b, sc: m.sc, ln: m.ln }; }   // 別台的盤面快照（觀戰者、同一場聯機的對手才收到）
function onNetTgb(m) {   // 對戰模式：被送垃圾行
  const A = S.ar; if (!A || A.dead) return;
  A.gq += m.n; A.hit = { n: m.n, from: m.from, until: performance.now() + 1200 };
}
function arStop() { if (S.arRaf) cancelAnimationFrame(S.arRaf); S.arRaf = 0; S.ar = null; S.arOpp = {}; }
function arLoop() {
  S.arRaf = 0;
  const v = S.tableView;
  if (!S.tableOpen || !v || v.game !== 'arcade') { arStop(); return; }
  if (S.ar) arStep(S.ar);
  arDrawAll();
  S.arRaf = requestAnimationFrame(arLoop);
}
const arCabName = cab => `${cab + 1} 號機`;
function arDrawCell(g, x, y, c, cs, alpha = 1) {
  const col = AR_COLORS[c] || '#888';
  g.globalAlpha = alpha; g.fillStyle = col; g.fillRect(x, y, cs, cs);
  if (cs >= 8) { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x, y, cs, 2); g.fillRect(x, y, 2, cs); g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x, y + cs - 2, cs, 2); g.fillRect(x + cs - 2, y, 2, cs); }
  g.globalAlpha = 1;
}
function arDrawMini(g, k, ox, oy, cs) {   // 預覽（下一個／暫存）：方塊置中畫在 4×2 格的框裡
  const cells = AR_ROT[k][0], xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
  const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
  const bx = ox + (4 - w) * cs / 2 - Math.min(...xs) * cs, by = oy + (2 - h) * cs / 2 - Math.min(...ys) * cs;
  for (const [x, y] of cells) arDrawCell(g, bx + x * cs, by + y * cs, k, cs);
}
function arDrawMain() {   // 自己的盤面：左邊暫存、中間盤面（含落點預覽）、右邊下一個／分數
  const cv = $('arMain'), A = S.ar; if (!cv || !A) return;
  const g = cv.getContext('2d'), L = 100, BW = AR_W * AR_CELL, BH = AR_VIS * AR_CELL, top = AR_H - AR_VIS;
  g.fillStyle = '#0d1424'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#060a14'; g.fillRect(L, 10, BW, BH);
  g.strokeStyle = 'rgba(120,150,200,.12)'; g.lineWidth = 1;
  for (let x = 1; x < AR_W; x++) { g.beginPath(); g.moveTo(L + x * AR_CELL + .5, 10); g.lineTo(L + x * AR_CELL + .5, 10 + BH); g.stroke(); }
  for (let y = 1; y < AR_VIS; y++) { g.beginPath(); g.moveTo(L, 10 + y * AR_CELL + .5); g.lineTo(L + BW, 10 + y * AR_CELL + .5); g.stroke(); }
  for (let y = top; y < AR_H; y++) for (let x = 0; x < AR_W; x++) if (A.board[y][x]) arDrawCell(g, L + x * AR_CELL, 10 + (y - top) * AR_CELL, A.board[y][x], AR_CELL);
  if (A.cur) {
    let gy = A.cur.y; while (arFits(A, { ...A.cur, y: gy + 1 })) gy++;
    for (const [x, y] of arCells({ ...A.cur, y: gy })) if (y >= top) arDrawCell(g, L + x * AR_CELL, 10 + (y - top) * AR_CELL, A.cur.k, AR_CELL, .25);   // 落點預覽
    for (const [x, y] of arCells(A.cur)) if (y >= top) arDrawCell(g, L + x * AR_CELL, 10 + (y - top) * AR_CELL, A.cur.k, AR_CELL);
  }
  if (A.gq > 0) { g.fillStyle = '#e04848'; const h = Math.min(BH, A.gq * AR_CELL); g.fillRect(L - 6, 10 + BH - h, 4, h); }   // 等著推上來的垃圾行
  g.strokeStyle = '#5a6a90'; g.lineWidth = 2; g.strokeRect(L - 1, 9, BW + 2, BH + 2);
  g.fillStyle = '#c8d4f0'; g.font = 'bold 13px "Microsoft JhengHei"'; g.textAlign = 'left';
  g.fillText('暫存 C', 12, 28); if (A.hold) arDrawMini(g, A.hold, 10, 38, 18);
  const R = L + BW + 14;
  g.fillText('下一個', R, 28);
  A.queue.slice(0, 3).forEach((k, i) => arDrawMini(g, k, R, 38 + i * 50, i ? 14 : 18));
  const stat = [['分數', A.sc], ['行數', A.ln], ['等級', A.lv]];
  stat.forEach(([lbl, n], i) => { g.fillStyle = '#8fa0c8'; g.font = '12px "Microsoft JhengHei"'; g.fillText(lbl, R, 210 + i * 46); g.fillStyle = '#ffe08a'; g.font = 'bold 18px "Microsoft JhengHei"'; g.fillText(String(n), R, 230 + i * 46); });
  g.textAlign = 'center';
  const wait = A.t0 - (Date.now() + A.off);
  const msg = (txt, sub, col = '#ffe08a') => {
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(L, 10 + BH / 2 - 44, BW, 80);
    g.fillStyle = col; g.font = 'bold 30px "Microsoft JhengHei"'; g.fillText(txt, L + BW / 2, 10 + BH / 2);
    if (sub) { g.fillStyle = '#fff'; g.font = '14px "Microsoft JhengHei"'; g.fillText(sub, L + BW / 2, 10 + BH / 2 + 24); }
  };
  if (A.dead) msg('GAME OVER', `${A.sc} 分 · ${A.ln} 行`, '#ff7a6a');
  else if (wait > 0) msg(String(Math.ceil(wait / 1000)), '準備……');
  else if (A.flash && performance.now() < A.flash.until) { g.fillStyle = '#fff6c0'; g.font = 'bold 20px "Microsoft JhengHei"'; g.fillText(['', '', '雙消！', '三消！', '四行消除！'][A.flash.n] || '', L + BW / 2, 44); }
  if (A.hit && performance.now() < A.hit.until) { g.fillStyle = '#ff8a7a'; g.font = 'bold 15px "Microsoft JhengHei"'; g.fillText(`${arCabName(A.hit.from)} 送來 ${A.hit.n} 行！`, L + BW / 2, 10 + BH - 12); }
  g.textAlign = 'left';
}
function arDrawSmall(cv, snap, dead) {   // 別台的盤面（快照）
  const g = cv.getContext('2d'), cs = cv.width / AR_W;
  g.fillStyle = '#060a14'; g.fillRect(0, 0, cv.width, cv.height);
  const b = snap?.b || '';
  for (let i = 0; i < b.length; i++) if (b[i] !== '0') arDrawCell(g, (i % AR_W) * cs, Math.floor(i / AR_W) * cs, Number(b[i]), cs);
  if (dead) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#ff7a6a'; g.font = `bold ${Math.round(cs * 1.4)}px "Microsoft JhengHei"`; g.textAlign = 'center'; g.fillText('出局', cv.width / 2, cv.height / 2); g.textAlign = 'left'; }
}
function arDrawAll() {
  arDrawMain();
  for (const cv of document.querySelectorAll('canvas.ar-oppcv')) {
    const cab = Number(cv.dataset.cab), snap = S.arOpp?.[cab], v = S.tableView, s = v?.seats.find(x => x.cab === cab);
    arDrawSmall(cv, snap, s?.dead);
    const sc = document.getElementById('arOppSc' + cab); if (sc && snap) sc.textContent = `${snap.sc} 分 · ${snap.ln} 行`;
  }
}
function buildArcade(box, v, mk, gd) {
  const me = v.role === 'seat' ? v.seats[v.me] : null, lk = v.link, playing = v.phase === 'playing';
  const off = (v.sn || Date.now()) - Date.now();
  // 新的一局：單人看自己的 tt、聯機看 link 的 seed（大家同一串方塊）
  const want = playing ? (me.st === 'solo' && v.tt ? { key: 's' + v.tt.seed + ':' + v.tt.t0, seed: v.tt.seed, t0: v.tt.t0 } : lk?.phase === 'playing' ? { key: 'l' + lk.seed + ':' + lk.t0, seed: lk.seed, t0: lk.t0 } : null) : null;
  if (want && (!S.ar || S.ar.key !== want.key)) { S.ar = arNew(want.seed, want.t0, off, want.key); S.arOpp = {}; }
  if (!playing && S.ar && !S.ar.dead) S.ar = null;   // 被結束了（例如聯機取消）：本機這局作廢
  if (!S.arRaf) S.arRaf = requestAnimationFrame(arLoop);
  const hostName = lk ? v.seats.find(s => s.cab === lk.host)?.name || arCabName(lk.host) : '';
  const modeName = m => (m === 'battle' ? '對戰模式' : '一般模式');
  let status;
  if (!me) status = '觀戰中（要玩的話，走到空著的機台按 F）';
  else if (playing) status = me.st === 'solo' ? '單人模式：←→ 移動、↓ 加速、↑／X 旋轉（順時針）、Z 旋轉（逆時針）、空白鍵落到底、C 暫存' : `聯機${modeName(lk.mode)}：${S.ar?.dead ? '你已出局，等其他人結束' : '撐到最後、分數越高越好'}`;
  else if (me.st === 'link') status = lk.host === me.cab ? `你發起了聯機（${modeName(lk.mode)}），等其他機台的人接受邀請` : `已加入 ${hostName} 的聯機，等他開始`;
  else status = `${arCabName(me.cab)}：選擇單人模式或聯機模式`;
  box.appendChild(mk('div', 'table-status' + (playing && !S.ar?.dead ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing && r.link && (me ? r.cabs?.includes(me.cab) : true)) {   // 聯機結算：依分數排名
    box.appendChild(mk('div', 'table-result', r.text));
    const ul = mk('div', 'table-ranking');
    r.ranking.forEach((x, k) => ul.appendChild(mk('div', 'table-board-row', `${k + 1}. ${x.name}　${x.score} 分 · ${x.lines} 行${x.left ? '（中途離開）' : ''}`)));
    box.appendChild(ul);
  }
  if (me && !playing && me.last && me.st === 'idle' && !(r?.link && r.cabs?.includes(me.cab))) box.appendChild(mk('div', 'table-result', `上一局（單人）：${me.last.sc} 分、${me.last.ln} 行`));
  // 邀請：我閒置中、有人在等聯機、還有位子、我沒拒絕過
  if (me && me.st === 'idle' && lk?.phase === 'invite' && lk.mem.length < 4 && !lk.no.includes(me.cab)) {
    const inv = mk('div', 'ar-invite');
    inv.appendChild(mk('div', null, `${hostName}（${arCabName(lk.host)}）發起了聯機（${modeName(lk.mode)}，目前 ${lk.mem.length}/4 人）`));
    inv.appendChild(mk('div', 'ar-invite-q', '要接受聯機邀請嗎？'));
    const bs = mk('div', 'table-btns');
    const yes = mk('button', 'ff-btn', '接受'); yes.onclick = () => S.net?.tbl?.({ a: 'ljoin' });
    const no = mk('button', 'ff-btn small', '拒絕'); no.onclick = () => S.net?.tbl?.({ a: 'lno' });
    bs.appendChild(yes); bs.appendChild(no); inv.appendChild(bs); box.appendChild(inv);
  }
  if (me && me.st === 'link' && lk?.phase === 'invite') {   // 聯機等待室
    const room = mk('div', 'ar-room');
    room.appendChild(mk('div', 'table-label', `聯機成員（${lk.mem.length}/4）`));
    const row = mk('div', 'table-seats');
    for (const c of lk.mem) {
      const s = v.seats.find(x => x.cab === c), seat = mk('div', 'table-seat' + (c === me.cab ? ' you' : ''));
      seat.style.borderColor = AR_CAB_COLORS[c];
      seat.appendChild(mk('div', 'table-name', (s?.name || '?') + (c === me.cab ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', arCabName(c) + (c === lk.host ? ' · 發起人' : '')));
      row.appendChild(seat);
    }
    room.appendChild(row);
    const isHost = lk.host === me.cab, bs = mk('div', 'table-btns');
    if (isHost) {
      for (const m of ['normal', 'battle']) { const b = mk('button', 'ff-btn small' + (lk.mode === m ? ' on' : ''), (lk.mode === m ? '● ' : '') + modeName(m)); b.onclick = () => S.net?.tbl?.({ a: 'lmode', v: m }); bs.appendChild(b); }
      const st = mk('button', 'ff-btn', lk.mem.length < 2 ? '開始（至少 2 人）' : '開始'); st.disabled = lk.mem.length < 2; st.onclick = () => S.net?.tbl?.({ a: 'lstart' }); bs.appendChild(st);
      const cc = mk('button', 'ff-btn small', '取消邀請'); cc.onclick = () => S.net?.tbl?.({ a: 'lquit' }); bs.appendChild(cc);
    } else {
      bs.appendChild(mk('span', 'table-tag', `模式：${modeName(lk.mode)}（由 ${hostName} 決定）`));
      const q = mk('button', 'ff-btn small', '退出聯機'); q.onclick = () => S.net?.tbl?.({ a: 'lquit' }); bs.appendChild(q);
    }
    room.appendChild(bs);
    room.appendChild(mk('div', 'table-tag', lk.mode === 'battle' ? '對戰模式：一次消 2／3／4 行，其他對手最下面多 1／2／4 行垃圾；最後還活著的人最有利。' : '一般模式：大家拿到一樣的方塊順序，各自玩到出局，全員出局後依分數排名。'));
    box.appendChild(room);
  }
  if (me && me.st === 'idle') {   // 選模式
    const bs = mk('div', 'table-btns');
    const solo = mk('button', 'ff-btn', '單人模式'); solo.onclick = () => S.net?.tbl?.({ a: 'solo' }); bs.appendChild(solo);
    const link = mk('button', 'ff-btn', '聯機模式'); link.disabled = !!lk; link.title = lk ? '已經有一場聯機了（同時只能有一場）' : '邀請其他機台的人一起玩（最多 4 人）';
    link.onclick = () => S.net?.tbl?.({ a: 'link' }); bs.appendChild(link);
    box.appendChild(bs);
  }
  if (me && playing) {   // 遊戲畫面：自己的盤面＋聯機對手的小盤面
    const wrap = mk('div', 'ar-play');
    const cv = document.createElement('canvas'); cv.id = 'arMain'; cv.width = 100 + AR_W * AR_CELL + 110; cv.height = AR_VIS * AR_CELL + 20; cv.className = 'ar-main';
    wrap.appendChild(cv);
    if (me.st === 'link' && lk) {
      const opps = mk('div', 'ar-opps');
      for (const c of lk.mem) if (c !== me.cab) opps.appendChild(arOppEl(v, c, mk, 12));
      for (const x of lk.gone || []) opps.appendChild(mk('div', 'ar-opp gone', `${x.name}\n中途離開（${x.score} 分）`));
      wrap.appendChild(opps);
    }
    box.appendChild(wrap);
  }
  if (!me) {   // 觀戰：每台正在玩的機台
    const opps = mk('div', 'ar-opps spec');
    const live = v.seats.filter(s => s.play);
    for (const s of live) opps.appendChild(arOppEl(v, s.cab, mk, 14));
    if (!live.length) opps.appendChild(mk('div', 'table-tag', '目前沒有人在玩'));
    box.appendChild(opps);
  }
  // 4 台機台的狀態
  const cabs = mk('div', 'ar-cabs');
  for (let c = 0; c < 4; c++) {
    const s = v.seats.find(x => x.cab === c), el = mk('div', 'ar-cab' + (me && c === me.cab ? ' you' : ''));
    el.style.borderColor = AR_CAB_COLORS[c];
    const st = !s ? '空機台' : s.play ? (s.st === 'solo' ? '單人遊玩中' : s.dead ? '聯機・出局' : '聯機遊玩中') : s.st === 'link' ? '聯機等待中' : '閒置';
    el.appendChild(mk('div', 'table-name', arCabName(c)));
    el.appendChild(mk('div', 'table-tag', s ? `${s.name} · ${st}` : st));
    cabs.appendChild(el);
  }
  box.appendChild(cabs);
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分（單人）`);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
function arOppEl(v, cab, mk, cs) {
  const s = v.seats.find(x => x.cab === cab), el = mk('div', 'ar-opp');
  el.style.borderColor = AR_CAB_COLORS[cab];
  el.appendChild(mk('div', 'table-name', `${s?.name || '?'} · ${arCabName(cab)}`));
  const cv = document.createElement('canvas'); cv.className = 'ar-oppcv'; cv.dataset.cab = cab; cv.width = AR_W * cs; cv.height = AR_VIS * cs;
  el.appendChild(cv);
  const sc = mk('div', 'table-tag', `${S.arOpp?.[cab]?.sc ?? s?.sc ?? 0} 分`); sc.id = 'arOppSc' + cab; el.appendChild(sc);
  return el;
}
// ---- 和平島餐飲區（2026-11-13，使用者要求）：右上角的自助飲料機與點心吧，走近按 F（或點它）吃喝 ----
// 每次吃喝隨機得到一個幾秒的增益／減益，或什麼事都沒發生。**遊戲裡刻意不寫任何「吃喝會有效果」的說明**（使用者定），
// 效果只顯示在左上角武器列下方的小圖示（滑鼠移上去只看到名稱）。純客戶端：別人看得到的部分（變大／縮小／透明／暈眩的星星／中毒的泡泡）
// 走既有的 state.fx 轉發（id 前面加 f，見 myFx），伺服器不用改。物件位置在 terrain.json 的 props（gen_assets.py 的 PROPS_BY_TERRAIN）。
const PROP_RANGE = 48;   // 離物件邊多近才能互動（px）
const propsHere = () => S.terrains[S.terrain]?.props || [];
const propRect = pr => ({ x: pr.cell[0] * CELL, y: pr.cell[1] * CELL, w: pr.w * CELL, h: pr.h * CELL });
const propUse = pr => pr.kind === 'drink' || pr.kind === 'food';   // 能互動（吃喝）的物件；deco（隔板）只擋路、rug（地毯）畫在地板層
function propAtCell(x, y) {   // 這格被物件占著（擋路、不能擺家具；地毯不算）
  for (const pr of propsHere()) if (pr.kind !== 'rug' && x >= pr.cell[0] && x < pr.cell[0] + pr.w && y >= pr.cell[1] && y < pr.cell[1] + pr.h) return pr;
  return null;
}
function propDist(pr, px, py) { const r = propRect(pr), dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h)); return Math.hypot(dx, dy); }
function propNear(p) { let best = null, bd = PROP_RANGE; for (const pr of propsHere()) { if (!propUse(pr)) continue; const d = propDist(pr, p.x, p.y); if (d < bd) { bd = d; best = pr; } } return best; }
function propAtPoint(wx, wy) { return propsHere().find(pr => { if (!propUse(pr)) return false; const r = propRect(pr); return wx >= r.x && wx < r.x + r.w && wy >= r.y && wy < r.y + r.h; }) || null; }
// 效果（name 只用在圖示的滑鼠提示；bad＝減益，圖示紅框）。dur＝秒數
const FOOD_FX = {
  hurt:    { name: '扣血', bad: 1, icon: '💔', dur: 1.5 },
  poison:  { name: '中毒', bad: 1, icon: '🤢', dur: 9 },
  stun:    { name: '暈眩', bad: 1, icon: '💫', dur: 3 },
  blind:   { name: '致盲', bad: 1, icon: '🌑', dur: 7 },
  gray:    { name: '視覺受損', bad: 1, icon: '🌫️', dur: 9 },
  nausea:  { name: '噁心', bad: 1, icon: '🤮', dur: 7 },
  weak:    { name: '虛弱', bad: 1, icon: '🐌', dur: 9 },
  confuse: { name: '混亂', bad: 1, icon: '🌀', dur: 7 },
  hiccup:  { name: '打嗝', bad: 1, icon: '💭', dur: 9 },
  haste:   { name: '加速', icon: '👟', dur: 10 },
  swift:   { name: '神速', icon: '⚡', dur: 6 },
  fresh:   { name: '神清氣爽', icon: '✨', dur: 12 },
  big:     { name: '巨大化', icon: '🍄', dur: 12 },
  tiny:    { name: '縮小', icon: '🐜', dur: 12 },
  heal:    { name: '回復', icon: '💚', dur: 1.5 },
  light:   { name: '輕盈', icon: '🎈', dur: 12 },
  ghost:   { name: '透明化', icon: '👻', dur: 10 },
};
const FOOD_GROUP = { haste: ['swift', 'weak'], swift: ['haste', 'weak'], weak: ['haste', 'swift'], big: ['tiny'], tiny: ['big'] };   // 互斥：後吃到的蓋掉前一個
// 抽獎權重（none＝什麼都沒發生）：飲料偏速度／清爽／打嗝，點心偏回復／體型／肚子痛
const FOOD_POOL = {
  drink: { none: 30, haste: 8, swift: 4, fresh: 8, nausea: 6, hiccup: 8, gray: 5, blind: 4, confuse: 5, stun: 4, ghost: 5, light: 5, heal: 4, hurt: 3, poison: 3, weak: 4, big: 3, tiny: 3 },
  food:  { none: 30, heal: 7, big: 7, tiny: 6, poison: 6, hurt: 5, weak: 6, stun: 4, nausea: 6, fresh: 5, haste: 4, swift: 2, light: 4, ghost: 3, hiccup: 4, gray: 3, blind: 3, confuse: 3 },
};
const FOOD_NAMES = { drink: ['可樂', '柳橙汁', '綠茶', '奶茶', '紅茶', '汽水', '冰咖啡', '熱可可', '檸檬紅茶', '蘋果西打'], food: ['薯條', '熱狗', '爆米花', '關東煮', '布丁', '鬆餅', '雞塊', '泡麵', '洋芋片', '飯糰'] };
const FOOD_CD = 1.5;   // 兩次吃喝的最短間隔（秒）
S.foodFx = {}; S.foodCdUntil = 0; S.foodNext = { poison: 0, hiccup: 0 };
const ffOn = k => S.t < (S.foodFx[k] || 0);
function foodPick(kind) {
  const pool = FOOD_POOL[kind] || FOOD_POOL.drink, tot = Object.values(pool).reduce((a, b) => a + b, 0);
  let r = Math.random() * tot;
  for (const [k, w] of Object.entries(pool)) { r -= w; if (r < 0) return k; }
  return 'none';
}
function useProp(pr) {
  const p = S.players[0];
  if (p.dead) return;
  if (S.t < S.foodCdUntil) { toast(pr.kind === 'food' ? '還在吃…' : '還在喝…', 900); return; }
  S.foodCdUntil = S.t + FOOD_CD;
  const names = FOOD_NAMES[pr.kind] || FOOD_NAMES.drink, nm = names[Math.floor(Math.random() * names.length)];
  toast(pr.kind === 'food' ? `你吃了${nm}` : `你喝了一杯${nm}`, 1600);
  S.floaters.push({ x: p.x, y: p.y - 50, v: pr.kind === 'food' ? '嚼嚼…' : '咕嚕咕嚕…', life: 1 });
  const k = foodPick(pr.kind);
  if (k !== 'none') foodApply(k);
}
function foodApply(k) {
  const d = FOOD_FX[k], p = S.players[0], cap = hpCap(p);
  for (const o of FOOD_GROUP[k] || []) delete S.foodFx[o];
  S.foodFx[k] = S.t + d.dur;
  if (k === 'hurt') { const n = 2 + Math.floor(Math.random() * 2), was = p.hp ?? cap; p.hp = Math.max(1, was - n); if (was > p.hp) S.floaters.push({ x: p.x, y: p.y - 46, v: `-${was - p.hp}`, life: 1 }); }   // 吃喝扣血不會死（最少留 1 滴，助手定）
  if (k === 'heal') { const was = p.hp ?? cap; p.hp = cap; if (cap > was) S.floaters.push({ x: p.x, y: p.y - 46, v: `+${cap - was}`, life: 1, xpGain: true }); }
  if (k === 'poison') S.foodNext.poison = S.t + 1.5;
  if (k === 'hiccup') S.foodNext.hiccup = S.t + .6;
  buffBarBuild();
}
function foodFxIds() {   // 給 state.fx：別人也要畫的效果
  const out = [];
  for (const k of ['big', 'tiny', 'ghost', 'stun', 'poison']) if (ffOn(k)) out.push('f' + k);
  return out;
}
const foodSpeedMul = () => (ffOn('swift') ? 1.9 : ffOn('haste') ? 1.4 : ffOn('weak') ? .55 : 1);
function foodScaleOf(list) { return list?.includes('fbig') ? 1.6 : list?.includes('ftiny') ? .55 : 1; }
// 每幀（只對自己）：中毒每 1.5 秒扣 1（最少留 1）、打嗝不定時小跳一下、過期的圖示拿掉、畫面濾鏡
function stepFood(p) {
  if (p.dead) { if (Object.keys(S.foodFx).length) { S.foodFx = {}; buffBarBuild(); } foodScreenFilter(); return; }
  if (ffOn('poison') && S.t >= S.foodNext.poison) {
    S.foodNext.poison = S.t + 1.5;
    if ((p.hp ?? hpCap(p)) > 1) { p.hp = (p.hp ?? hpCap(p)) - 1; S.floaters.push({ x: p.x, y: p.y - 46, v: '-1', life: .9 }); }
  }
  if (ffOn('hiccup') && S.t >= S.foodNext.hiccup) {
    S.foodNext.hiccup = S.t + 1.1 + Math.random() * 1.4;
    if (p.z === 0 && p.vz === 0 && !p.pose) p.vz = 130;
    S.floaters.push({ x: p.x + 10, y: p.y - 48, v: '嗝！', life: .8 });
  }
  let gone = false;
  for (const [k, u] of Object.entries(S.foodFx)) if (S.t >= u) { delete S.foodFx[k]; gone = true; }
  if (gone) buffBarBuild(); else buffBarTick();
  foodScreenFilter();
}
// 左上角（武器列下方）的增減益圖示：滑鼠移上去只顯示名稱（title），右下角是剩幾秒
function buffBarBuild() {
  const bar = $('buffBar'); if (!bar) return;
  bar.innerHTML = '';
  const ks = Object.keys(S.foodFx).filter(ffOn);
  for (const k of ks) {
    const d = FOOD_FX[k], el = document.createElement('div');
    el.className = 'buff' + (d.bad ? ' bad' : ' good'); el.title = d.name; el.dataset.k = k;
    el.innerHTML = `<span class="bi">${d.icon}</span><span class="bt"></span>`;
    bar.appendChild(el);
  }
  bar.classList.toggle('hidden', !ks.length);
  buffBarTick(true);
}
let buffTickAt = 0;
function buffBarTick(force) {
  if (!force && S.t - buffTickAt < .2) return;
  buffTickAt = S.t;
  for (const el of document.querySelectorAll('#buffBar .buff')) { const left = (S.foodFx[el.dataset.k] || 0) - S.t; el.querySelector('.bt').textContent = left > 0 ? Math.ceil(left) : ''; }
}
// 畫面濾鏡：視覺受損＝黑白、噁心＝畫面扭曲（SVG 位移濾鏡，波動跟著時間變）、神清氣爽＝亮一點、飽和一點
let foodFilterKey = '';
function foodScreenFilter() {
  const parts = [];
  if (ffOn('nausea')) {
    foodWarpEnsure();
    const t = S.t, tb = document.getElementById('ffTurb'), dm = document.getElementById('ffDisp');
    if (tb) tb.setAttribute('baseFrequency', `${(0.008 + 0.004 * Math.sin(t * 1.3)).toFixed(4)} ${(0.012 + 0.005 * Math.cos(t * 1.7)).toFixed(4)}`);
    if (dm) dm.setAttribute('scale', String(Math.round(12 + 7 * Math.sin(t * 2.1))));
    parts.push('url(#ffWarp)', `hue-rotate(${Math.round(25 * Math.sin(t * 1.5))}deg)`);
  }
  if (ffOn('gray')) parts.push('grayscale(1)');
  if (ffOn('fresh')) parts.push('brightness(1.08) saturate(1.3)');
  const key = parts.join(' ');
  if (key !== foodFilterKey) { foodFilterKey = key; canvas.style.filter = key; }
}
function foodWarpEnsure() {
  if (document.getElementById('ffWarp')) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  box.innerHTML = '<svg width="0" height="0"><filter id="ffWarp" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence id="ffTurb" type="turbulence" baseFrequency="0.01 0.014" numOctaves="2" seed="3"/><feDisplacementMap id="ffDisp" in="SourceGraphic" scale="20" xChannelSelector="R" yChannelSelector="G"/></filter></svg>';
  document.body.appendChild(box);
}
// 螢幕空間的效果（世界畫完之後）：致盲＝只看得到自己身邊一小圈、神清氣爽＝畫面上閃亮的小星點
function drawFoodScreen() {
  const p = S.players[0]; if (!p) return;
  if (ffOn('blind')) {
    const sx = p.x - S.cam.x, sy = p.y - p.z - 20 - S.cam.y, R = 70;
    const g = ctx.createRadialGradient(sx, sy, R * .55, sx, sy, R * 1.5);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.97)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (ffOn('fresh')) {
    ctx.save();
    for (let i = 0; i < 26; i++) {   // 每顆星點各自的位置與閃爍相位（決定性，不用存狀態）
      const h = Math.sin(i * 91.7) * 43758.5, u = h - Math.floor(h), h2 = Math.sin(i * 37.3) * 12345.6, v = h2 - Math.floor(h2);
      const ph = (S.t * (0.6 + u * .8) + i * .37) % 1, a = Math.sin(ph * Math.PI);
      const x = u * canvas.width, y = ((v + S.t * .02 * (1 + u)) % 1) * canvas.height, r = 1.5 + 2.5 * a;
      ctx.globalAlpha = .75 * a; ctx.fillStyle = i % 3 ? '#fffbe0' : '#c8f4ff';
      ctx.beginPath(); ctx.moveTo(x, y - r * 2); ctx.lineTo(x + r * .5, y); ctx.lineTo(x, y + r * 2); ctx.lineTo(x - r * .5, y); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - r * 2, y); ctx.lineTo(x, y + r * .5); ctx.lineTo(x + r * 2, y); ctx.lineTo(x, y - r * .5); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}
// 頭上的效果（自己與別人都畫，看 fx 清單）：暈眩＝繞圈的星星、中毒＝冒綠泡泡
function drawFoodOverhead(p, list, headY) {
  if (list.includes('fstun')) {
    ctx.save(); ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const a = S.t * 4 + i * Math.PI * 2 / 3, x = p.x + Math.cos(a) * 13, y = headY - 14 + Math.sin(a) * 4;   // 名牌上方
      ctx.globalAlpha = Math.sin(a) > 0 ? 1 : .6; ctx.fillStyle = '#ffe04a'; ctx.fillText('★', x, y);
    }
    ctx.restore();
  }
  if (list.includes('fpoison')) {
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const ph = (S.t * .9 + i / 3) % 1, x = p.x - 8 + i * 8 + Math.sin(S.t * 3 + i) * 2, y = headY - 12 - ph * 16;
      ctx.globalAlpha = 1 - ph; ctx.fillStyle = '#7ad04a'; ctx.strokeStyle = '#2f6a1a';
      ctx.beginPath(); ctx.arc(x, y, 2 + ph * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}
// 島上物件的繪製：圖＋名稱（離得近、而且是最近的那個才提示按 F）
function propDrawEntries(list) {
  const ims = S.tImages[S.terrain] || {};
  for (const pr of propsHere()) {
    if (pr.kind === 'rug') continue;   // 地毯在地板層畫（draw() 裡畫 tMan.props 的那一行）
    const r = propRect(pr), img = ims[pr.img];
    list.push({
      y: r.y + r.h, draw: () => {
        ctx.imageSmoothingEnabled = false;
        if (img) drawSpr(img, 0, r.x, r.y, r.w, r.h); else { ctx.fillStyle = '#8a5a34'; ctx.fillRect(r.x, r.y, r.w, r.h); }
        if (!pr.name) return;   // 隔板之類：沒有名稱標籤
        const p = S.players[0], cx = r.x + r.w / 2;
        ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
        ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.fillStyle = '#ffe08a';
        ctx.strokeText(pr.name || '', cx, r.y - 6); ctx.fillText(pr.name || '', cx, r.y - 6);
        if (!S.tableOpen && propNear(p) === pr) {
          const t = pr.kind === 'food' ? '按 F 吃點心' : '按 F 喝飲料';
          ctx.font = '11px "Microsoft JhengHei"'; ctx.fillStyle = '#fff6e0'; ctx.strokeText(t, cx, r.y - 20); ctx.fillText(t, cx, r.y - 20);
        }
        ctx.restore();
      }
    });
  }
}
// 島上桌子的繪製：圖＋人數標籤（離得近時提示按 F）
function tableDrawEntries(list) {
  for (const tb of tablesHere()) {
    const img = S.tableImgs[tb.img] || S.tableImgs[tb.game], r = tableRect(tb), gd = gameDef(tb.game);
    list.push({
      y: r.y + r.h, draw: () => {
        ctx.imageSmoothingEnabled = false;
        if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
        else { ctx.fillStyle = '#2f8a5a'; ctx.fillRect(r.x, r.y, r.w, r.h); }
        const inf = S.tblInfo?.[tb.id], p = S.players[0];
        if (tb.game === 'arcade') { arcadeLabel(tb, r, inf, p); return; }
        const txt = `${gd?.name || '遊戲桌'} ${inf ? `${inf.n}/${inf.max}${inf.play ? ' 遊戲中' : ''}${inf.s ? ` · ${inf.s} 人觀戰` : ''}` : ''}`;
        ctx.save(); ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#ffe08a';
        ctx.strokeText(txt, r.x + r.w / 2, r.y - 6); ctx.fillText(txt, r.x + r.w / 2, r.y - 6);
        if (!S.tableOpen && tableDist(tb, p.x, p.y) < TABLE_RANGE) {
          ctx.font = '11px "Microsoft JhengHei"'; ctx.fillStyle = '#fff6e0';
          ctx.strokeText('按 F 或點擊入座', r.x + r.w / 2, r.y - 20); ctx.fillText('按 F 或點擊入座', r.x + r.w / 2, r.y - 20);
        }
        ctx.restore();
      }
    });
  }
}

// 俄羅斯方塊的機台標籤：每台頭上一行（玩家名字／空機台），有人在等聯機時空機台與閒置中的機台多一行「聯機邀請中」
function arcadeLabel(tb, r, inf, p) {
  const c = inf?.cabs?.[tb.cab], cx = r.x + r.w / 2;
  const lines = [];
  lines.push([c ? `${c.n}${c.st === 'solo' || c.st === 'link' ? ' 遊戲中' : ''}` : '空機台', c ? '#fff6e0' : '#b8c4dc', '11px']);
  lines.push([gameDef(tb.game)?.name || '街機', '#ffe08a', 'bold 12px']);   // 遊戲名稱（同其他桌子的標籤）
  if (inf?.inv && (!c || c.st === 'idle')) lines.push(['聯機邀請中！', '#ff9ad0', 'bold 11px']);
  if (!S.tableOpen && tableDist(tb, p.x, p.y) < TABLE_RANGE && !tableNearOther(tb, p)) lines.push([c ? '按 F 觀戰' : '按 F 開始玩', '#fff6e0', '11px']);
  ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
  lines.forEach(([t, col, font], k) => { ctx.font = `${font} "Microsoft JhengHei"`; ctx.fillStyle = col; const y = r.y - 6 - k * 14; ctx.strokeText(t, cx, y); ctx.fillText(t, cx, y); });
  ctx.restore();
}
const tableNearOther = (tb, p) => tableNear(p) !== tb;   // 4 台挨得很近：只在最近的那台顯示「按 F」

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
    case 'stat': {   // 小遊戲戰績（見 docs/notes.md「小遊戲戰績與稱號」）：game＝遊戲 id（'*'＝全部加總）、key＝戰績鍵、op 'le'＝取最小值的鍵要 ≤ n
      const G = S.gstats || S.gstatsLocal || {}, val = c.game === '*' ? Object.values(G).reduce((a, m) => a + (m[c.key] || 0), 0) : G[c.game]?.[c.key];
      if (c.op === 'le') return { cur: val !== undefined && val <= c.n ? 1 : 0, need: 1 };
      return { cur: val || 0, need: c.n || 1 };
    }
    case 'played': return { cur: Object.values(S.gstats || S.gstatsLocal || {}).filter(m => (m.p || 0) >= 1).length, need: c.n || 1 };   // 玩過幾種小遊戲
    case 'all': { const l = c.conds || []; return { cur: l.filter(x => titleMet(x, depth + 1)).length, need: Math.max(1, l.length) }; }   // 全部子條件達成
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
    if (!silent) setTimeout(() => toast(`獲得稱號 ${fresh.map(titleText).join('')}！可在「角色」的稱號設定中使用`, 3600), 2000);
  }
  // 外觀：解鎖條件與稱號同一套（avatar.json 各件的 unlock）；剛解鎖的跳提示（比稱號晚一點，不要疊在一起）
  const gk = new Set(S.titleBook.glams || []), gFresh = allGlams().filter(it => it.unlock && glamUnlocked(it) && !gk.has(it.id));
  if (gFresh.length) {
    S.titleBook.glams = [...gk, ...gFresh.map(it => it.id)];
    lsSet('dcisland.m0.titles', S.titleBook);
    if (!silent) setTimeout(() => toast(`解鎖外觀「${gFresh.map(it => it.name).join('」「')}」！可在「角色」的裝備與外觀中使用`, 3600), 4200);
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
// 擊倒島主紀錄跟著帳號（2026-11-09，使用者要求）：伺服器存 {有島主的地形: 時間}，這裡換成島主 id（terrain.json 的 owner）併進 titleBook.kills。
// 只有伺服器親眼看到的擊倒會進帳號；之前只記在這台電腦的不上傳（使用者定：重打就重打），但在這台電腦照樣算
function onNetKills(k) {
  const kills = S.titleBook.kills ||= {}, srv = k && typeof k === 'object' ? k : {};
  let changed = false;
  for (const t of Object.keys(srv)) { const mob = S.terrains[t]?.owner; if (mob && !kills[mob]) { kills[mob] = 1; changed = true; } }
  if (changed) lsSet('dcisland.m0.titles', S.titleBook);
  checkTitles(true);   // 重算稱號與外觀解鎖（不跳提示：換電腦登入時一次補回來）
}
// 小遊戲戰績（2026-11-13）：登入者由伺服器記進帳號（Registry 的 gstats:<uid>），結算後與登入時送來整份；訪客在這裡依 result.gs 本機累加（存 localStorage，不上傳，登入後看的是帳號的）
function onNetGstats(g) {
  const first = S.gstatsSrc !== 'server';
  S.gstats = g && typeof g === 'object' ? g : {}; S.gstatsSrc = 'server';
  checkTitles(first);   // 第一次（登入後補回來）不跳提示；之後每局結算送來的才跳「獲得稱號」
}
function gstatsLocalApply(game, gs) {   // 訪客：把這局的戰績增量併進本機戰績（與伺服器的 gstats 同一套規則）
  const G = S.gstatsLocal, m = G[game] ||= {};
  for (const [mode, src] of [['add', gs.add], ['max', gs.max], ['min', gs.min]]) for (const [k, raw] of Object.entries(src || {})) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const v = Math.max(0, Math.min(1000000, Math.floor(raw)));
    if (mode === 'add') m[k] = Math.min(1000000, (m[k] || 0) + v); else if (mode === 'max') m[k] = Math.max(m[k] || 0, v); else m[k] = m[k] === undefined ? v : Math.min(m[k], v);
  }
  lsSet('dcisland.m0.gstats', G);
  if (S.gstatsSrc !== 'server') { S.gstats = G; checkTitles(false); }
}
function setTitle(id) {
  S.me.title = id; saveAvatar();
  toast(id ? `稱號設定為 ${titleText(id)}` : '不顯示稱號', 1600);
  buildTitles(); buildAvatarPanel();
}
function openTitles() { S.titleOpen = true; buildTitles(); $('titleBox').classList.remove('hidden'); }
function closeTitles() { S.titleOpen = false; $('titleBox').classList.add('hidden'); }
const TITLE_TABS = ['battle', 'fishing', 'game'];
function buildTitles() {
  const all = S.titlesDB?.titles || [], got = unlockedTitles(), tab = TITLE_TABS.includes(S.titleTab) ? S.titleTab : 'battle';
  const list = all.filter(t => (t.cat || 'fishing') === tab);   // 分頁：戰鬥（擊倒島主）／釣魚（圖鑑）／遊戲（小遊戲戰績）；稱號 cat 沒寫當釣魚
  document.querySelectorAll('#titleTabs button').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.onclick = () => { S.titleTab = b.dataset.tab; buildTitles(); }; });
  $('titleHint').textContent = `此分頁 ${list.filter(t => got.has(t.id)).length}／${list.length}（全部 ${got.size}／${all.length}）` + (S.dexSource === 'server' ? ' · 以 Discord 帳號保存' : ' · 訪客／未連線：圖鑑、擊倒島主與遊戲戰績只存在這台電腦');
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
  const [ax, ay] = onBack ? charAnch.backView : charAnch.back, s = wi.wscale || 2, wb = WEAPON_BACK_BOTTOM * s / 2;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(-.55);
  if (wi.hiltUp) { ctx.scale(1, -1); ctx.drawImage(wi, -wi.width * s / 2, WEAPON_HILT_LIFT * s / 2 - wb, wi.width * s, wi.height * s); }
  else ctx.drawImage(wi, -wi.width * s / 2, wb - wi.height * s, wi.width * s, wi.height * s);
  ctx.restore();
}
// 掛在腰間（avatar.json 的 carry: "waist"）：握把在腰的掛點，武器頭朝下、往身後斜（劍柄朝上，像插在腰帶上）
function drawWeaponWaist(wi) {
  const [ax, ay] = charAnch.waist, s = wi.wscale || 2;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.PI + .45);
  ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();   // 轉軸＝離圖底 3 格的握把
}
// 揮擊：握住劍柄（以握把為轉軸）、刀刃朝外，由後上方往前下方揮，畫在身體之後（身前）
// 劍柄朝上背著的（hiltUp）或掛腰間的：前 35% 手從掛著的位置（背上劍柄＝back 掛點往左上 2,3；腰間＝waist 掛點）移到手的掛點，看起來是拔出來再揮。
// 掛著的武器不隨人物翻轉（固定在畫面左側），ctx 卻已依面向翻轉，所以起點 x 要乘上 dir 換回同一側
const SWING_HILT_DRAW = .35;
// v＝'up'／'down'（四方向攻擊的上下）：不翻轉，往下＝從右上劈到身前下方、往上＝在頭頂由左往右掃（畫在身體後面）
const SWING_ARC = { side: [-.9, 2.8], down: [.2, 2.9], up: [-1.5, 3] };
function drawWeaponSwing(wi, swing, dir = 1, v = null) {
  const q = 1 - swing / ATK_T;
  let [px, py] = charAnch.hand;
  if (wi.hiltUp || wi.carry === 'waist') {
    const from = wi.carry === 'waist' ? charAnch.waist : [charAnch.back[0] - 2, charAnch.back[1] - 3];
    const k = Math.min(1, q / SWING_HILT_DRAW), fx = from[0] * dir;
    px = fx + (px - fx) * k; py = from[1] + (py - from[1]) * k;
  }
  const s = wi.wscale || 2;
  const [a0, da] = SWING_ARC[v || 'side'];
  ctx.save(); ctx.translate(px, py); ctx.rotate(a0 + q * da);
  ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();   // 轉軸＝離圖底 3 格的握把
}

// 營火的橘紅色光暈：地面壓扁的橢圓（透視），半徑＝CAMPFIRE_R（補血範圍），帶一點閃爍；外圈淡淡的範圍線
function drawCampfireGlow(c) {
  const pul = .5 + .5 * Math.sin(S.t * 6) + .12 * Math.sin(S.t * 13.7);
  const gy = c.y - 6;
  ctx.save();
  ctx.translate(c.x, gy); ctx.scale(1, .62);
  const g = ctx.createRadialGradient(0, 0, 3, 0, 0, CAMPFIRE_R);
  g.addColorStop(0, `rgba(255,178,80,${.30 + .07 * pul})`);
  g.addColorStop(.45, `rgba(236,112,42,${.17 + .05 * pul})`);
  g.addColorStop(1, 'rgba(200,60,20,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, CAMPFIRE_R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = `rgba(255,152,72,${.10 + .05 * pul})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(c.x, gy, CAMPFIRE_R, CAMPFIRE_R * .62, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ---------------- 天氣（2026-11-12；純客戶端畫面，零同步） ----------------
// 決定論：天氣＝雜湊(地形, 時刻槽) 對該地形的天氣表加權抽籤——每個人自己算、算出來都一樣，不用同步、玩家也影響不了。
// 之後的交互作用（掛點）：特殊怪照天氣條件出現（mobs.json 的 spawnIf）、植物生長受天氣影響（動工前先查採集重生是本機還是伺服器）。
const WEATHER_SLOT_MIN = 8;      // 一個時刻槽幾分鐘：槽內天氣不變、槽與槽之間用 WEATHER_TRANS_SEC 淡入淡出
const WEATHER_TRANS_SEC = 40;    // 換槽時，前一個天氣 → 新天氣的色罩與粒子密度過渡秒數
const WEATHERS = {   // id → 名稱／色罩（rgba 三元組＋最濃不透明度）／粒子（kind＋數量＋速度等；n＝滿量時的顆數）
  clear:   { name: '晴' },
  rain:    { name: '雨',   tint: [40, 62, 92],    alpha: .16, part: { kind: 'rain',    n: 110, vy: 520, vx: -64, len: 13 } },
  snow:    { name: '雪',   tint: [226, 236, 250], alpha: .13, part: { kind: 'snow',    n: 90,  vy: 46,  vx: 20, sway: 26, r: 1.6 } },
  // 霧（2026-11-13 使用者定：要有「一片濛濛、能見度越遠越低」的縱深霧感，參考 FF14 起霧）：
  // depth: true → 不用全畫面平均色罩，改畫以玩家為中心的徑向漸層：身邊（near）幾乎清楚、中距離（mid）、
  // 遠處（far）到能見度半徑（vis×畫面短邊）以外（alpha）整片白濛；core＝身邊這個比例內維持最清楚的濃度
  fog:     { name: '霧',   tint: [230, 237, 244], alpha: .95, near: .05, mid: .4, far: .75, core: .1, vis: .8, depth: true, part: { kind: 'fog', n: 24, vx: 12, r: 120 } },
  sand:    { name: '沙暴', tint: [222, 190, 122], alpha: .15, part: { kind: 'sand',    n: 70,  vy: 26,  vx: -215, len: 9 } },
  ember:   { name: '落灰', tint: [255, 118, 42],  alpha: .09, part: { kind: 'ember',   n: 60,  vy: -34, vx: 16, r: 1.8 } },
  leaf:    { name: '落葉', part: { kind: 'leaf', n: 24, vy: 42, vx: -34, sway: 42, r: 2.6 } },
  firefly: { name: '螢光', tint: [30, 36, 70],    alpha: .08, part: { kind: 'firefly', n: 26,  vy: -12, vx: 8, r: 1.4 } },
};
// 各地形的天氣表（id＝權重）。和平島是室內房間：不做天氣（永遠晴）
const TERRAIN_WEATHER = {
  grass:   [['clear', 6], ['rain', 2], ['leaf', 1], ['fog', 1]],
  beach:   [['clear', 6], ['rain', 2], ['sand', 1], ['fog', 1]],
  forest:  [['clear', 5], ['rain', 2], ['leaf', 2], ['fog', 1]],
  snow:    [['clear', 5], ['snow', 3], ['fog', 1]],
  night:   [['clear', 5], ['rain', 1], ['fog', 2], ['firefly', 2]],
  volcano: [['clear', 5], ['ember', 3], ['fog', 2]],
  machine: [['clear', 6], ['rain', 2], ['fog', 2]],
  peace:   [['clear', 1]],
};
function weatherHash(s) {   // FNV-1a：純整數運算，各瀏覽器結果一致（決定論的關鍵）
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function weatherSlot() { return Math.floor(Date.now() / 60000 / WEATHER_SLOT_MIN); }   // 時刻槽：現在用現實時鐘，之後接遊戲時間時只改這裡
function weatherPick(T, slot) {   // 同一（地形, 槽）永遠同一種天氣
  const tab = TERRAIN_WEATHER[T] || TERRAIN_WEATHER.grass;
  let r = weatherHash(T + ':' + slot) % tab.reduce((s, w) => s + w[1], 0);
  for (const [id, w] of tab) { if ((r -= w) < 0) return id; }
  return tab[0][0];
}
function weatherBlend() {   // 槽內經過率 0→1：色罩與粒子數在槽剛開始的 WEATHER_TRANS_SEC 內從上一個天氣過來
  return Math.min(1, (S.t - S.weather.t0) / WEATHER_TRANS_SEC);
}
function stepWeather(dt) {   // 換槽／換地形時切天氣；粒子池在 drawWeather 維護（每幀順手補齊）；dt 留給 drawWeather 的粒子步進
  S.weatherDt = dt;
  const T = S.terrain, slot = weatherSlot();
  if (!S.weather || S.weather.T !== T)   // 進新地形：從「晴」淡入當前天氣
    S.weather = { T, slot, prev: 'clear', cur: weatherPick(T, slot), t0: S.t, parts: [] };
  else if (S.weather.slot !== slot) {
    S.weather.prev = S.weather.cur;
    S.weather.cur = weatherPick(T, slot);
    S.weather.slot = slot; S.weather.t0 = S.t;
  }
}
function weatherSpawn(p, kind) {   // 粒子出生位置：下雨／雪／沙／葉從畫面上緣外落下，灰燼／螢光從下緣升上來，霧在畫面裡橫飄
  p.kind = kind;
  if (kind === 'ember' || kind === 'firefly') { p.x = Math.random() * canvas.width; p.y = canvas.height + 8; }
  else if (kind === 'fog') { p.x = Math.random() * canvas.width; p.y = Math.random() * canvas.height; }
  else { p.x = Math.random() * (canvas.width + 160) - 80; p.y = -8 - Math.random() * 40; }
  p.vx = 0; p.vy = 0; p.ph = Math.random() * Math.PI * 2;
}
// 色罩：一般人天氣是全畫面平均色罩；`depth: true`（霧）改畫「距離越遠越濃」的徑向漸層——
// 以玩家腳邊為圓心、到畫面角落為霧最濃處（近＝near、中＝mid、邊緣＝alpha）。
// mul＝過渡權重（前一個天氣淡出用 1-bl、當前淡入用 bl），同一層就能平滑交叉。
function weatherMask(def, mul) {
  if (!def || !def.tint || mul <= 0) return;
  const [r, g, b] = def.tint;
  const fill = a => `rgba(${r},${g},${b},${(a * mul).toFixed(3)})`;
  if (!def.alpha) return;
  if (!def.depth) { ctx.fillStyle = fill(def.alpha); ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
  const me = S.players[0];
  const cx = me ? me.x - S.cam.x : canvas.width / 2;                 // 玩家在畫面上的位置（鏡頭跟隨，通常在畫面中央偏下）
  const cy = me ? me.y - 24 - S.cam.y : canvas.height / 2;
  // 霧最濃處＝「能見度半徑」R：以畫面短邊換算（約 0.8 個短邊），超過就整片白濛——
  // 所以看得出來的距離有限、愈遠愈看不清（2026-11-13 使用者要「一片濛濛，能見度越遠越低」，參考 FF14 起霧）
  const R = Math.min(canvas.width, canvas.height) * (def.vis ?? .8);
  const gr = ctx.createRadialGradient(cx, cy, R * def.core, cx, cy, R);
  gr.addColorStop(0,   fill(def.near ?? .1));
  gr.addColorStop(.5,  fill(def.mid ?? (def.alpha * .5)));
  gr.addColorStop(.82, fill(def.far ?? (def.alpha * .85)));
  gr.addColorStop(1,   fill(def.alpha));
  ctx.fillStyle = gr; ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function drawWeather() {
  const w = S.weather; if (!w) return;
  const P0 = WEATHERS[w.prev], P1 = WEATHERS[w.cur], bl = weatherBlend(), dt = Math.min(.05, S.weatherDt || .016);
  // 色罩：前一個天氣淡出、當前天氣淡入（兩層各畫一次，顏色不同也能平滑交叉）
  weatherMask(P0, 1 - bl);
  weatherMask(P1, bl);
  // 粒子池：目標顆數在過渡期跟著 blend 從前一個天氣的量走向當前的量
  const n0 = P0.part ? P0.part.n : 0, n1 = P1.part ? P1.part.n : 0;
  let target = Math.round(n0 + (n1 - n0) * bl);
  if (w.cur === 'clear' && bl >= 1) target = 0;
  const parts = w.parts;
  while (parts.length < target) { const p = {}; weatherSpawn(p, (n1 >= n0 ? P1.part.kind : P0.part.kind)); parts.push(p); }
  if (parts.length > target) parts.length = target;
  if (!parts.length) return;
  for (const p of parts) {
    const d = P1.part && P1.part.kind === p.kind ? P1.part : (P0.part || P1.part);
    p.ph += dt * 1.7;
    if (d.kind === 'rain') { p.x += d.vx * dt; p.y += d.vy * dt; }
    else if (d.kind === 'sand') { p.x += d.vx * dt; p.y += d.vy * dt + Math.sin(p.ph) * 14 * dt; }
    else if (d.kind === 'fog') { p.x += d.vx * dt; }
    else {   // snow／leaf／ember／firefly：飄＋左右搖（sway；沒有 sway 的就是直線）
      p.x += (d.vx + Math.sin(p.ph) * (d.sway || 0)) * dt;
      p.y += d.vy * dt;
    }
    // 出畫就繞回來（落下型回上緣、上升型回下緣、霧繞橫向）
    if (p.y > canvas.height + 10) weatherSpawn(p, d.kind);
    else if (p.y < -12 && (d.kind === 'ember' || d.kind === 'firefly')) weatherSpawn(p, d.kind);
    else if (d.kind === 'fog') { if (p.x - d.r > canvas.width) p.x = -d.r; }
    else if (p.x < -90) p.x = canvas.width + 80;
    // 畫
    ctx.save();
    if (d.kind === 'rain') {
      ctx.strokeStyle = `rgba(178,208,238,${.34 + .2 * Math.sin(p.ph * 3)})`; ctx.lineWidth = 1;
      const l = d.len * (d.vy / (Math.hypot(d.vx, d.vy) || 1)), lx = d.len * (d.vx / (Math.hypot(d.vx, d.vy) || 1));
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + lx, p.y + l); ctx.stroke();
    } else if (d.kind === 'sand') {
      ctx.strokeStyle = 'rgba(238,206,150,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - d.len, p.y + d.len * .3); ctx.stroke();
    } else if (d.kind === 'fog') {
      ctx.fillStyle = `rgba(236,242,248,${.055 + .035 * Math.sin(p.ph)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, d.r * (0.8 + .2 * Math.sin(p.ph * .7)), 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'ember') {
      ctx.fillStyle = `rgba(255,${140 + 60 * Math.sin(p.ph) | 0},70,${.5 + .3 * Math.sin(p.ph * 2)})`;
      ctx.fillRect(p.x, p.y, d.r, d.r);
    } else if (d.kind === 'firefly') {
      const a = .3 + .45 * (Math.sin(p.ph * 2.2) * .5 + .5);
      ctx.fillStyle = `rgba(190,255,190,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, d.r, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'leaf') {
      ctx.fillStyle = `rgba(${150 + 70 * Math.sin(p.ph) | 0},170,80,.75)`;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ph);
      ctx.fillRect(-d.r, -d.r * .4, d.r * 2, d.r * .8); ctx.restore();
    } else {   // snow
      ctx.fillStyle = `rgba(245,248,252,${.55 + .3 * Math.sin(p.ph * 2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
// ---------------- 小地圖（2026-11-13，使用者要求；樣式仿使用者提供的範例圖：羊皮紙地圖＋青銅雕花圓框＋指北針＋天氣＋座標） ----------------
// 直接畫在主畫布右上角（畫布座標，跟著遊戲一起縮放，不會跑到畫面外；2026-11-13 使用者回饋：原本的獨立 DOM canvas 會落在畫布外）。
const MINI_COLORS = {   // 各地形縮圖配色（地＝uiColor 加深一階、水／岸手調；和平島是室內，房間外畫暗色不是海）
  grass:   { ground: '#5d9e50', water: '#2e5f8e', shore: '#c8b878' },
  beach:   { ground: '#dcc788', water: '#2e6f9e', shore: '#efe0ac' },
  forest:  { ground: '#4d7c3e', water: '#285688', shore: '#a8985e' },
  snow:    { ground: '#dbe4ec', water: '#33628e', shore: '#b8c2cc' },
  night:   { ground: '#5d659c', water: '#1c2438', shore: '#464e66' },
  volcano: { ground: '#5e4c4a', water: '#33343e', shore: '#8a6a50' },
  machine: { ground: '#7c8694', water: '#2e3e52', shore: '#9aa2ac' },
  peace:   { ground: '#c4b088', water: '#2e5f8e', shore: '#a8906a', room: '#14171e' },
};
let mmBase = null, mmBaseFor = '';
function buildMinimapBase() {   // 換地形（＝genWorld 重生成）時重畫一次：types（0 水／1 岸／2 地）一格一像素
  const T = S.terrain, c = MINI_COLORS[T] || MINI_COLORS.grass, room = S.terrains[T]?.layout === 'room';
  mmBase = document.createElement('canvas');
  mmBase.width = COLS; mmBase.height = ROWS;
  const g = mmBase.getContext('2d');
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const t = S.world.types[y * COLS + x];
    g.fillStyle = t === 2 ? c.ground : t === 1 ? c.shore : room ? c.room : c.water;
    g.fillRect(x, y, 1, 1);
  }
  mmBaseFor = T;
}
function drawMiniWeatherIcon(c, kind, x, y) {   // 資訊條左端的極簡向量天氣圖示（約 14px）
  c.save(); c.translate(x, y); c.lineCap = 'round';
  if (kind === 'clear') {   // 晴：太陽（圓＋八道光芒）
    c.fillStyle = '#ffd86b'; c.beginPath(); c.arc(0, 0, 3, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#ffd86b'; c.lineWidth = 1.2;
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; c.beginPath(); c.moveTo(Math.cos(a) * 4.6, Math.sin(a) * 4.6); c.lineTo(Math.cos(a) * 6.6, Math.sin(a) * 6.6); c.stroke(); }
  } else if (kind === 'rain') {   // 雨：三道斜線
    c.strokeStyle = '#9cc8ec'; c.lineWidth = 1.6;
    for (const dx of [-4, 0, 4]) { c.beginPath(); c.moveTo(dx + 1, -4); c.lineTo(dx - 1.5, 5); c.stroke(); }
  } else if (kind === 'snow') {   // 雪：三線雪花
    c.strokeStyle = '#eef4fb'; c.lineWidth = 1.4;
    for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; c.beginPath(); c.moveTo(-Math.cos(a) * 5.5, -Math.sin(a) * 5.5); c.lineTo(Math.cos(a) * 5.5, Math.sin(a) * 5.5); c.stroke(); }
  } else if (kind === 'fog') {   // 霧：三條橫線
    c.strokeStyle = '#cfd6de'; c.lineWidth = 1.6;
    for (const dy of [-4, 0, 4]) { c.beginPath(); c.moveTo(-5.5, dy); c.lineTo(5.5, dy); c.stroke(); }
  } else if (kind === 'sand') {   // 沙暴：三道斜沙
    c.strokeStyle = '#e8ce96'; c.lineWidth = 1.6;
    for (const dx of [-4, 0, 4]) { c.beginPath(); c.moveTo(dx + 2, -4); c.lineTo(dx - 2, 5); c.stroke(); }
  } else if (kind === 'ember') {   // 落灰：小火苗
    c.fillStyle = '#ff9a4a';
    c.beginPath(); c.moveTo(0, -6); c.quadraticCurveTo(5, -1, 0, 6); c.quadraticCurveTo(-5, -1, 0, -6); c.fill();
    c.fillStyle = '#ffd86b'; c.beginPath(); c.arc(0, 2, 1.8, 0, Math.PI * 2); c.fill();
  } else if (kind === 'leaf') {   // 落葉：斜葉片＋葉脈
    c.fillStyle = '#8fbf5a'; c.beginPath(); c.ellipse(0, 0, 5.5, 2.4, -Math.PI / 4, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#5d8a3a'; c.lineWidth = 1; c.beginPath(); c.moveTo(-3.5, 3.5); c.lineTo(3.5, -3.5); c.stroke();
  } else {   // firefly：螢光兩點＋光暈
    c.fillStyle = 'rgba(190,255,190,.35)'; c.beginPath(); c.arc(0, 0, 6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c8f0a8';
    c.beginPath(); c.arc(-2, 1.5, 1.8, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(3, -2, 1.4, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
function drawMinimap() {   // 掛點：draw() 的 drawWeather() 之後（螢幕空間；島主倒數條之下）
  if (!S.world) return;
  if (mmBaseFor !== S.terrain) buildMinimapBase();
  // 整體縮放（2026-11-13 使用者定：縮到 60%）：以畫布右上角為基準等比縮放——座標、字級、線寬、
  // 鉚釘、資訊條一起縮，貼齊右上角的位置與構圖不變（函式最後那個 ctx.restore() 就是收這一層）
  const MM_K = .6;
  ctx.save();
  ctx.translate(canvas.width, 0); ctx.scale(MM_K, MM_K); ctx.translate(-canvas.width, 0);
  const cx = canvas.width - 100, cy = 106, R = 80;   // 圓心與半徑：貼著畫布右上角內側
  const wd = WEATHERS[S.weather?.cur || 'clear'];
  // 地圖：整座島等比塞進圓內（平滑縮放＋multiply 暖色，仿範例圖的羊皮紙感）
  const mw = 140, mh = mw * ROWS / COLS, sc = mw / COLS, ox = cx - mw / 2, oy = cy - mh / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R - 3, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#3c5468'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);   // 海
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mmBase, ox, oy, mw, mh);
  ctx.globalCompositeOperation = 'multiply';   // 羊皮紙暖色：陸地偏黃、海偏墨綠，像舊地圖
  ctx.fillStyle = '#d8c8a0'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.globalCompositeOperation = 'source-over';
  // 天氣色罩（跟世界同一份，小地圖也看得出天氣）。上限 0.45：霧這種濃天氣 alpha 很高（.95），
  // 直接乘會把小地圖整張塗白、看不到島形（2026-11-13 霧改成縱深霧時發現）
  if (wd.tint) { ctx.fillStyle = `rgba(${wd.tint.join(',')},${Math.min(.45, (wd.alpha || 0) * 1.2).toFixed(3)})`; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); }
  // 點：營火（橘，集合點）、其他玩家（金）、自己（白＋深色描邊放最上）
  const dot = (wx, wy, col, r) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ox + wx / CELL * sc, oy + wy / CELL * sc, r, 0, Math.PI * 2); ctx.fill(); };
  if (S.campfire) dot(S.campfire.x, S.campfire.y, '#ff9a4a', 2);
  for (const r of S.remotes.values()) if (r.x != null) dot(r.x, r.y, '#e8c86a', 1.6);
  const me = S.players[0];
  if (me) { dot(me.x, me.y, '#14100a', 3.2); dot(me.x, me.y, '#f4f8fc', 2); }
  ctx.restore();
  // 外框與資訊條畫在 clip 外（資訊條壓在圓框下緣、一部分在圓外，clip 內畫會被裁掉——2026-11-13 使用者回饋天氣圖示看不到就是這個原因）
  // 外框：深青銅粗環＋金環＋內圈暗環＋四顆斜角鉚釘（仿範例圖的雕花框；中央指針使用者說不用，拿掉了）
  ctx.lineWidth = 6; ctx.strokeStyle = '#2c2012'; ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2.5; ctx.strokeStyle = '#8a6a34'; ctx.beginPath(); ctx.arc(cx, cy, R - 5, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = '#e8c878'; ctx.beginPath(); ctx.arc(cx, cy, R - 7, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#241a0e'; ctx.beginPath(); ctx.arc(cx, cy, R - 9, 0, Math.PI * 2); ctx.stroke();
  for (const a of [Math.PI / 4, -Math.PI / 4, Math.PI * 3 / 4, -Math.PI * 3 / 4]) {
    const rx = cx + Math.cos(a) * (R - 5), ry = cy + Math.sin(a) * (R - 5);
    const rg = ctx.createRadialGradient(rx - 1.5, ry - 1.5, .5, rx, ry, 4.5);
    rg.addColorStop(0, '#f0d890'); rg.addColorStop(1, '#7a5c28');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(rx, ry, 4.5, 0, Math.PI * 2); ctx.fill();
  }
  // N 指北針字（上緣，深描邊金字）
  ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(12,8,4,.9)'; ctx.strokeText('N', cx, cy - R + 10);
  ctx.fillStyle = '#e8c878'; ctx.fillText('N', cx, cy - R + 10);
  // 底部資訊條（圓角銅牌，壓在圓框下緣）：左＝天氣徽章（圖示）＋名稱、右＝座標（格）
  const bw = 150, bh = 26, bx = cx - bw / 2, by = cy + R - 14, rr = 7;
  ctx.fillStyle = '#241a0e';
  ctx.beginPath();
  ctx.moveTo(bx + rr, by); ctx.arcTo(bx + bw, by, bx + bw, by + bh, rr); ctx.arcTo(bx + bw, by + bh, bx, by + bh, rr);
  ctx.arcTo(bx, by + bh, bx, by, rr); ctx.arcTo(bx, by, bx + bw, by, rr); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#c8a44a'; ctx.stroke();
  // 天氣圖示：圓形徽章底（深底金框），讓圖示壓在任何地圖色上都看得到
  ctx.fillStyle = '#3a2a18'; ctx.beginPath(); ctx.arc(bx + 16, by + bh / 2, 9, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = '#c8a44a'; ctx.stroke();
  drawMiniWeatherIcon(ctx, S.weather?.cur || 'clear', bx + 16, by + bh / 2);
  ctx.textAlign = 'left'; ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.fillStyle = '#f4e8c8';
  ctx.fillText(wd.name, bx + 26, by + bh / 2 + 1);
  ctx.textAlign = 'right'; ctx.font = '12px "Microsoft JhengHei"'; ctx.fillStyle = '#e2d8bc';
  if (me) ctx.fillText(`X ${Math.floor(me.x / CELL)} Y ${Math.floor(me.y / CELL)}`, bx + bw - 9, by + bh / 2 + 1);
  ctx.restore();   // 收掉 drawMinimap 開頭的整體縮放 save（縮放前的畫布狀態還原）
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
  if (tMan.layout === 'room' && tMan.roomBox) { ctx.fillStyle = '#10131a'; ctx.fillRect(0, 0, canvas.width, canvas.height); }   // 室內房間：畫面不會每幀清空，房間外沒畫東西會殘留上一幀的畫面（像場景延伸、飄移），先塗黑
  ctx.save();
  // 室內房間每幀先填黑底，鏡頭座標有小數時磚與磚的邊會半透明、透出黑底，變成地板上一條條灰色細線 → 房間地形把鏡頭取整數像素再畫
  if (tMan.layout === 'room' && tMan.roomBox) ctx.translate(-Math.round(S.cam.x), -Math.round(S.cam.y)); else ctx.translate(-S.cam.x, -S.cam.y);
  // 底：地面／岸邊／水（可動畫：每種磚這一幀先算好，整張地圖同步；stagger 的各格再錯開）
  const tiles = [ims[tMan.water], ims[tMan.edge], ims[tMan.ground]], tileFi = tiles.map(s => s ? sprFrame(s) : 0), groundRep = tMan.groundRepeat || 1, roomBox = tMan.layout === 'room' && tMan.roomBox;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = S.world.types[y * COLS + x], spr = tiles[t];
    if (!spr || (roomBox && !inRoom(x, y))) continue;   // 室內地形：房間外留黑
    if (t === 2 && groundRep > 1) {   // 地面圖是 n×n 格的大圖（和平島室內地板的方磚放大 n 倍）：每格畫其中對應的一塊
      const fw = spr.fw / groundRep, fh = spr.fh / groundRep;
      ctx.drawImage(spr.img, (x % groundRep) * fw, (y % groundRep) * fh, fw, fh, x * CELL, y * CELL, CELL, CELL);
      continue;
    }
    drawSpr(spr, spr.stagger ? (tileFi[t] + x * 7 + y * 13) % spr.frames : tileFi[t], x * CELL, y * CELL, CELL, CELL);
  }
  if (roomBox && tMan.walls) drawRoomWalls(tMan.walls, ims, roomBox);   // 室內房間的東北西三面牆（房間外，畫在地面之後、物件之前）
  for (const pr of tMan.props || []) if (pr.kind === 'rug' && ims[pr.img]) { const r = propRect(pr); drawSpr(ims[pr.img], 0, r.x, r.y, r.w, r.h); }   // 地毯（餐飲區）：地板層、角色與物件之下
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
  // 島主放招倒數條：在下面物件繪製時記錄，最後統一畫在視窗上方置中（同一時間只有自己地形的一位島主在放招）
  let ownerBar = null;
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
  // 營火本體（世界物件，跟其他東西一起 y 排序；影子貼在腳底）
  if (S.campfire && S.campfireSpr) {
    const c = S.campfire, spr = S.campfireSpr, size = CELL * 1.5;
    list.push({
      y: c.y, draw: () => {
        // 素材（32×32）的木柴底在第 28 列、內容偏左 2 格：圖往下挪 4 格、往右挪 2 格（×1.5 倍），木柴底才貼在影子上（2026-11-09 使用者回報看起來飄在空中）
        const k = size / 32, ox = 2 * k, oy = 4 * k;
        ctx.fillStyle = 'rgba(10,14,20,.28)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y - 2, size * .42, size * .14, 0, 0, Math.PI * 2); ctx.fill();
        drawSpr(spr, sprFrame(spr, cellPhase(c.cell[0], c.cell[1])), c.x - size / 2 + ox, c.y - size + oy, size, size);
      }
    });
  }
  tableDrawEntries(list);   // 和平島遊戲桌
  propDrawEntries(list);    // 和平島餐飲區
  // 掉落物
  for (const dr of S.drops) {
    const def = S.toolsDB.items[dr.item] || matDef(dr.item), icon = S.craftImgs[dr.item];
    list.push({
      y: dr.y, draw: () => {
        const bob = Math.sin(S.t * 5 + dr.x) * 2;
        ctx.fillStyle = 'rgba(10,14,20,.3)';
        ctx.beginPath(); ctx.ellipse(dr.x, dr.y, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
        if (icon) { ctx.imageSmoothingEnabled = false; ctx.drawImage(icon, dr.x - 10, dr.y - 22 - bob, 20, 20); return; }
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
  // 營火的橘紅色光暈（地上，先畫＝在所有角色腳底下；半徑就是 200px 的補血範圍）
  if (S.campfire) drawCampfireGlow(S.campfire);
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
        // 方向網格（an.rowDir）：依視覺朝向挑列、素材沒畫的方向用對向列鏡像；否則沿用舊規則（往左就左右翻轉）
        let flip = (a.dir < 0) !== !!def.faceLeft, row = 0;
        if (an?.rowDir) { const rr = mobRowFor(an, a.face4 || 'down'); row = rr.row; flip = rr.flip; }
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
        // footDy：素材每格底部留白（產生器自動量測寫進 mobs.json）——把圖往下挪，腳／底部才會踩到地面（影子在 a.y）。
        // 飛行中的怪物不挪（牠本來就離地）。footDx 則同舊：腳底中心不在圖正中時往反方向挪。
        const fdx = def.footDx || 0, fdy = a.fly ? 0 : (def.footDy || 0);
        if (an) drawSpr(an, animFrame(a, an), -W / 2 - fdx, -H + fdy, W, H, row);
        else ctx.drawImage(img, -W / 2 - fdx, -H + fdy, W, H);
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
        if (a.command) {   // 命令讀條：行人號誌風圖示畫在身上（與石化之瞳的大眼睛同位置）＋身上持續冒白蒸汽（蒸氣停＝命令結束）
          if (!a.nextSteam || S.t >= a.nextSteam) {
            a.nextSteam = S.t + 1 / 18;   // 每秒 18 顆（使用者定，2026-11-05）
            S.floaters.push({ steam: true, x: a.x + (Math.random() * W * .56 - W * .28), y: a.y - H * (.1 + Math.random() * .4), r: 3 + Math.random() * 4, life: .9 });
          }
          const ic = CMD_ICONS[a.command.kind] || CMD_ICONS.act;
          if (ic.complete && ic.naturalWidth) {
            const pul = .7 + .3 * (Math.sin(S.t * 10) * .5 + .5);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = pul;
            ctx.drawImage(ic, a.x - 32, a.y - H * .62 - 32, 64, 64);
            ctx.restore();
          } else {   // 圖示還沒載入（或載入失敗）的保險：畫文字，保證一定有提示
            const act = a.command.kind === 'act';
            ctx.save();
            ctx.font = 'bold 15px "Microsoft JhengHei"'; ctx.textAlign = 'center';
            ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,10,14,.85)';
            const txt = act ? '↑ 行動！' : '✕ 靜止！';
            const wy = Math.max(top - 34, S.cam.y + 8);
            ctx.strokeText(txt, a.x, wy);
            ctx.fillStyle = act ? 'rgba(122,216,140,.9)' : 'rgba(240,110,90,.9)';
            ctx.fillText(txt, a.x, wy);
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
        // 等級：名字右邊的金色 Lv.N（島主／魚人；跟玩家名牌同款式。Lv 1 不顯示，有長進才看得到）
        if ((def.owner || def.lurker) && (a.lvl ?? 1) > 1) {
          const nameW = ctx.measureText(def.name).width;
          ctx.font = '9px "Microsoft JhengHei"'; ctx.textAlign = 'left';
          ctx.strokeText(`Lv.${a.lvl}`, a.x + nameW / 2 + 4, top);
          ctx.fillStyle = '#ffd86b'; ctx.fillText(`Lv.${a.lvl}`, a.x + nameW / 2 + 4, top);
          ctx.textAlign = 'center';
          ctx.font = (bs > 1 ? 'bold 12px ' : '9px ') + '"Microsoft JhengHei"'; ctx.fillStyle = def.owner ? '#ffd86b' : '#ff8f7a';   // 之後可能還有用這個字型量寬的地方
        }
        // 島主的台詞泡泡（被打反擊前隨機一句；與 NPC 泡泡同款，畫在名牌上方）
        if (a.say && S.t < a.say.until) drawBubble(a.x, top - 8, a.say.text, Math.min(1, (a.say.until - S.t) / .4));
        // 島主放招倒數條（skills.json 標 bar 的招式）：這裡只記錄進度與招名，畫面最後統一疊在視窗上方置中（drawOwnerCastBar）
        if (def.owner && a.cast > 0 && ownerSkill(def).bar)
          ownerBar = { frac: 1 - a.cast / ownerCastTotal(def),
                       name: a.command ? quoteName(a.command.kind) : ownerSkill(def).name };
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
        // 賢具不畫手持/腰間的武器圖（腰間那座看起來像殘影）：待機的四座漂浮賢具就是它的樣子（drawNoulithIdle）
        const wi = !p.npc && wid !== 'tome' ? weaponImgFor(wid, p.tool ? null : myLook().wlook) : null;
        drawNoulithIdle(p, p.npc ? null : wid, 'back');
        drawPerson(p, wi, p.npc ? (p.guide ? '#ffd86b' : '#bcd8e8') : '#ffffff');
        drawNoulithIdle(p, p.npc ? null : wid, 'front');
      }
    });
  }
  // M2：同島的其他玩家
  for (const r of S.remotes.values()) {
    if (r.dead) { list.push(tombEntry(r.x, r.y, r.name, DEAD_SECONDS - (performance.now() - (r.deadAt || performance.now())) / 1000)); continue; }
    list.push({
      y: r.y + (r.pose ? 2 : 0),
      draw: () => {   // 同島的人用暖金色名牌區分；賢具同樣不畫腰間武器圖
        drawNoulithIdle(r, r.weapon, 'back');
        drawPerson(r, r.weapon === 'tome' ? null : weaponImgFor(r.weapon, r.look?.wlook), '#ffe9a8');
        drawNoulithIdle(r, r.weapon, 'front');
      }
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
  if (S.fireballs.length && S.fireballSpr) {   // 飛龍火球：直線飛向鎖定點（世界座標；stepFireballs 負責命中）
    for (const f of S.fireballs) {
      const q = 1 - Math.max(0, f.life) / f.life0, x = f.x + (f.tx - f.x) * q, y = f.y + (f.ty - f.y) * q;
      const fr = sprFrame(S.fireballSpr) % 8, w = 64 * FIREBALL_SCALE, h = 64 * FIREBALL_SCALE;
      ctx.save(); ctx.translate(x, y); ctx.rotate(f.ang);
      ctx.drawImage(S.fireballSpr.img, fr * 64, 0, 64, 64, -w / 2, -h / 2, w, h);   // 朝右的圖隨彈道角旋轉
      ctx.restore();
    }
  }
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
    if (f.burst) {   // 火球命中爆炸（LPC explosions 2 的 fireball1）：12 幀由火花長成火球再淡出（0.45 秒）
      const fr = Math.min(11, Math.floor((1 - f.life / f.life0) * 12)), s2 = 32 * FIREBALL_SCALE;
      if (S.burstSpr) ctx.drawImage(S.burstSpr.img, fr * 32, 0, 32, 32, -s2 / 2, -s2 / 2, s2, s2);
      ctx.restore(); continue;
    }
    if (f.gold) {   // 升級金光：金環擴散＋繞圈小光點（0.7 秒，固定在腳下）
      const q = 1 - f.life / .7;
      ctx.strokeStyle = `rgba(255,216,107,${(1 - q) * .95})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 6 + q * 72, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(255,236,170,${(1 - q) * .85})`;
      for (let i = 0; i < 8; i++) {
        const an = i * Math.PI / 4 + q * 1.6, r = 6 + q * 44;
        ctx.fillRect(Math.cos(an) * r - 1.5, Math.sin(an) * r - 1.5, 3, 3);
      }
    } else if (f.fishImg) {   // 釣到的東西：從頭上浮起來再淡出
      ctx.globalAlpha = Math.min(1, f.life / .5);
      ctx.drawImage(f.fishImg, -24, -24, 48, 48);
    } else if (f.punch) {   // 空手揍人的衝擊星：黃白色放射線＋圈，快速擴散淡出
      const q = 1 - f.life / .3;
      ctx.strokeStyle = `rgba(255,236,150,${1 - q})`; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let i = 0; i < 8; i++) {
        const an = i * Math.PI / 4 + .4, r0 = 6 + q * 10, r1 = 14 + q * 20;
        ctx.beginPath(); ctx.moveTo(Math.cos(an) * r0, Math.sin(an) * r0); ctx.lineTo(Math.cos(an) * r1, Math.sin(an) * r1); ctx.stroke();
      }
      ctx.strokeStyle = `rgba(255,255,255,${1 - q})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 4 + q * 12, 0, Math.PI * 2); ctx.stroke();
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
    } else if (f.steam) {   // 蒸汽：白圓上升擴大淡出（壓力山大下命令時持續冒，蒸氣停＝命令結束）
      const q = 1 - f.life / .9;
      ctx.strokeStyle = `rgba(240,244,248,${(1 - q) * .6})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, -q * 30, f.r + q * 8, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(240,244,248,${(1 - q) * .25})`;
      ctx.beginPath(); ctx.arc(0, -q * 30, (f.r + q * 8) * .55, 0, Math.PI * 2); ctx.fill();
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
      ctx.font = (f.crit ? 'bold 13px' : f.xpGain || f.xpLoss ? 'bold 9px' : 'bold 11px') + ' "Microsoft JhengHei"';
      ctx.textAlign = 'center';
      ctx.fillStyle = f.xpGain ? '#ffd86b' : f.xpLoss ? '#ff8f7a' : f.crit ? '#ffb347' : '#ffffff';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
      const pop = f.life > .66 ? (0.8 - f.life) * 15 : 0; // 初段放大
      ctx.strokeText(f.crit ? f.v + ' !' : f.v, 0, -pop);
      ctx.fillText(f.crit ? f.v + ' !' : f.v, 0, -pop);
    }
    ctx.restore();
  }
  ctx.restore();
  drawWeather();   // 天氣色罩與粒子（螢幕空間，蓋在世界與名牌上、島主倒數條之下）
  drawFoodScreen();   // 吃喝的效果：致盲的黑幕、神清氣爽的星點（螢幕空間）
  drawMinimap();   // 小地圖（螢幕空間右上角；圖鑑／角色等 DOM 面板天然蓋在畫布上層）
  if (ownerBar) drawOwnerCastBar(ownerBar.frac, ownerBar.name);   // 島主讀條固定在視窗上方置中（世界座標還原後畫，永遠在最上層）
  drawOwnerLineBanner();   // 島主台詞：除了頭上的泡泡，也固定顯示在視窗上方（離島主太遠、泡泡在畫面外也看得到）
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
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS || !groundAt(xx, yy, floor) || tableAtCell(xx, yy) || propAtCell(xx, yy)) return false;
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
  if (S.sel && !furnAvailable(furnitureDef(S.sel) || {})) S.sel = null;   // 合成家具還沒解鎖就不能預選
  S.sel = S.sel || S.furn.items.find(it => S.furnImgs[it.id] && !it.legacy && furnAvailable(it))?.id || null;   // 缺圖／legacy 的種類不列出、也不預選
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
    if (!img || it.legacy || !furnAvailable(it)) continue;       // 合成家具要解鎖才列出； 缺圖的家具不列出；legacy＝已改成別的東西（例如地毯改為地板），舊存檔照畫但不能再擺
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
const SLOTS = [['hat', '帽子'], ['top', '上衣'], ['bottom', '褲子'], ['shoe', '鞋子'], ['weapon', '武器']];
const slotList = s => s === 'hat' ? S.avatar.hats : s === 'top' ? S.avatar.tops : s === 'bottom' ? S.avatar.bottoms : s === 'shoe' ? S.avatar.shoes : S.avatar.weapons;
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
  if (e.glam.weapon === 'goldsword') e.glam.weapon = 'sword_gold';   // 舊的「金劍」外觀（2026-11-09 拿掉）→ 長劍的金黃發光版（解鎖條件同樣是打倒黃金肥龍）
  return e;
}
// 某部位現在顯示哪一件（外觀優先；外觀失效＝沒解鎖／不適用就退回裝備）
function shownItem(slot, job = S.me.job) {
  const g = wardrobe(job).glam[slot], it = g && lookItem(slotList(slot), g);
  if (it && glamFits(slot, it, job) && glamUnlocked(it)) return it;
  if (slot === 'weapon') return jobWeaponDef(job);
  const list = slotList(slot) || [], gid = JOBS[job]?.gear?.[slot];
  return lookItem(list, gid);   // 服裝男女共用一個 id（女角在 charSprite 改用 sheetF）
}
// 自己的顯示造型（畫自己、送給同島的人都用這個；外觀與裝備在這裡就決定好，別人只看結果）
function myLook() {
  const c = wardrobe().color, w = shownItem('weapon');
  return { skin: S.me.skin, hair: S.me.hair, gender: S.me.gender || 'male', race: S.me.race || 'human',
           hat: shownItem('hat')?.id || null, top: shownItem('top')?.id || null, bottom: shownItem('bottom')?.id || null,
           shoe: shownItem('shoe')?.id || null,
           face: S.me.face || 'normal', eyes: lookItem(S.avatar.eyes, S.me.eyes) ? S.me.eyes : 'default_brown',
           hairC: S.me.hairC || null, eyeC: S.me.eyeC || null,   // 調色盤自訂的髮色／眼睛顏色（null＝用選的那一色）
           hatC: c.hat || null, topC: c.top || null, botC: c.bottom || null, shoeC: c.shoe || null,
           wlook: w && w.id !== JOBS[S.me.job]?.weapon ? w.id : null,
           shirt: 0, pants: 0 };   // shirt／pants：給舊客戶端的顏色編號（舊版只認這兩個）
}

function closeHairColors() {}   // 外貌頁已改成攤開的文字鈕／色塊（2026-11-09），沒有彈出選單了；保留空函式給舊的呼叫點
function buildAvatarPanel() {
  // 分頁：頁1「角色」＝等級/職業/稱號/裝備；頁2「外貌」＝性別/膚色/髮型
  const tabs = [...document.querySelectorAll('#avTabs .avtab')];
  const showTab = n => {
    document.getElementById('avPage1').classList.toggle('hidden', n !== '1');
    document.getElementById('avPage2').classList.toggle('hidden', n !== '2');
    for (const t of tabs) t.classList.toggle('active', t.dataset.avtab === n);   // 樣式跟其他視窗的頁籤一樣（ff-tabs／ff-btn active）
    S.avTab = n;
  };
  for (const t of tabs) t.onclick = () => { showTab(t.dataset.avtab); closeHairColors(); };
  showTab(S.avTab || '1');
  // ---- 外貌頁（2026-11-09 重新設計，使用者要求一致）：樣式＝一排文字鈕（lookChips）、顏色＝一排色塊（lookSwatches），全部攤開、沒有彈出選單 ----
  const redraw = () => { saveAvatar(); S.charCache.clear(); buildAvatarPanel(); };
  const lookChips = (host, items, curId, onPick) => {
    host.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('div');
      o.className = 'opt name' + (it.id === curId ? ' sel' : '');
      o.textContent = it.name; if (it.title) o.title = it.title;
      o.onclick = () => { onPick(it.id); redraw(); };
      host.appendChild(o);
    }
  };
  const lookSwatches = (host, items, curId, onPick) => {
    host.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('div');
      o.className = 'opt swatch' + (it.id === curId ? ' sel' : '');
      o.style.background = it.hex; o.title = it.name;
      o.onclick = () => { onPick(it.id); redraw(); };
      host.appendChild(o);
    }
  };
  // 樣式＋顏色兩層的項目（髮型、眼睛）：清單裡每一項是「某樣式的某顏色」；換樣式保留顏色。
  // 顏色＝樣式那排最後的「換色」鈕（2026-11-09 使用者要求跟裝備的換色一樣）：開選色視窗，上排是這個樣式的預設色、下面調色盤自訂
  const twoLevel = (list, curId, field, styleHost, cfield) => {
    const cur = list.find(x => x.id === curId) || list[0]; if (!cur) return;
    const styles = [];
    for (const it of list) if (!styles.some(s2 => s2.id === it.style)) styles.push({ id: it.style, name: it.styleName || it.style });
    lookChips(styleHost, styles, cur.style, sid => {
      const pick = list.find(x => x.style === sid && x.color === cur.color) || list.find(x => x.style === sid);
      if (pick) S.me[field] = pick.id;
    });
    const b = document.createElement('button'); b.className = 'ff-btn small dye-btn'; b.title = LOOK_COLOR[cfield];
    const sw = document.createElement('span'); sw.className = 'dye-sw'; sw.style.background = S.me[cfield] || cur.hex || '#888';
    b.append(sw, document.createTextNode('換色'));
    b.onclick = () => toggleColor(cfield, cur);
    styleHost.appendChild(b);
  };
  lookChips($('raceOpts'), (S.avatar.races || []).map(r => ({ id: r.id, name: r.name, title: r.scale && r.scale !== 1 ? `體型 ×${r.scale}` : '' })),
            S.me.race || 'human', v => { S.me.race = v; });
  // 性別（男／女）：換素體與對應性別的服裝
  lookChips($('genderOpts'), [{ id: 'male', name: '男' }, { id: 'female', name: '女' }], S.me.gender || 'male', v => { S.me.gender = v; });
  // 等級：XP 進度條（無上限，每級需求 10 + 5×(Lv−1)；來源＝怪物／釣竿／首捕／採集，2026-11-06）
  const li = lvInfo(S.profile.xp);
  $('lvCur').textContent = `Lv.${li.lv}`;
  $('lvFill').style.width = Math.min(100, Math.round(li.cur / li.need * 100)) + '%';
  $('lvRow').title = `經驗值 ${li.cur} / ${li.need}`;
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
  lookSwatches($('skinOpts'), S.avatar.skins.map(s2 => ({ id: s2.id, name: s2.name, hex: s2.base })), S.me.skin, v => { S.me.skin = v; });
  // 髮型／髮色、臉型、眼神／眼睛顏色
  twoLevel(S.avatar.hair, S.me.hair, 'hair', $('hairOpts'), 'hairC');
  lookChips($('faceOpts'), S.avatar.faces || [], S.me.face || 'normal', v => { S.me.face = v; });
  twoLevel(S.avatar.eyes || [], lookItem(S.avatar.eyes, S.me.eyes) ? S.me.eyes : 'default_brown', 'eyes', $('eyesOpts'), 'eyeC');
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
    gb.onclick = () => { if (S.glamOpen && glamSlot === slot) closeGlams(); else openGlams(slot); };   // 同一個部位再點一次＝關閉；點別的部位＝切過去
    row.appendChild(gb);
    if (slot !== 'weapon') {   // 換色：顯示中的那件有可染色的顏色才能換
      const b = document.createElement('button'); b.className = 'ff-btn small dye-btn';
      const dye = dyeList(cur);
      b.disabled = !dye;
      b.title = dye ? '換色' : '這件不能換色';
      const sw = document.createElement('span'); sw.className = 'dye-sw';
      sw.style.background = wr.color[slot] || dye?.[0] || 'transparent';
      b.append(sw, document.createTextNode('換色'));
      b.onclick = () => toggleColor(slot, cur);
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
// 選色的對象：服裝（hat／top／bottom／shoe，存在 wardrobe 的 color，每個職業各一套）或外貌（hairC／eyeC，存在 S.me，不分職業）
const LOOK_COLOR = { hairC: '髮色', eyeC: '眼睛顏色' }, LOOK_FIELD = { hairC: 'hair', eyeC: 'eyes' };   // 外貌換色：自訂色存 S.me[hairC]，預設色＝換 S.me.hair 那一項
function colorGet(slot) { return LOOK_COLOR[slot] ? (S.me[slot] || null) : (wardrobe().color[slot] || null); }
function colorSet(slot, hex) {
  const o = LOOK_COLOR[slot] ? S.me : wardrobe().color;
  if (hex) o[slot] = hex; else delete o[slot];
}
// 換色鈕：同一個再點一次＝關閉（保留目前選的顏色，跟按「確定」一樣；選色是即時套用的）；點別的換色鈕＝切過去
function toggleColor(slot, item) { if (S.colorOpen && colorUI.slot === slot) closeColor(true); else openColor(slot, item); }
function openColor(slot, item) {
  const dye = dyeList(item); if (!dye) return;
  const look = !!LOOK_COLOR[slot];
  const orig = look ? (item.hex || dye[0]) : dye[0];   // 外貌：「原色」＝目前選的那一色
  colorUI.slot = slot; colorUI.before = colorGet(slot); colorUI.orig = orig;
  colorUI.beforeItem = look ? S.me[LOOK_FIELD[slot]] : null;
  Object.assign(colorUI, hex2hsv(colorGet(slot) || orig));
  $('colorTitle').textContent = look ? LOOK_COLOR[slot] : `${SLOTS.find(x => x[0] === slot)[1]}換色：${item.name}`;
  const ps = $('colorPresets'); ps.innerHTML = '';
  if (look) {   // 外貌：預設色＝同樣式的各顏色（LPC 原本的配色，點了是換成那一項、清掉自訂色）
    const field = LOOK_FIELD[slot], list = field === 'hair' ? S.avatar.hair : S.avatar.eyes;
    for (const it of list.filter(x => x.style === item.style && x.hex)) {
      const o = document.createElement('div'); o.className = 'opt'; o.style.background = it.hex; o.title = it.name;
      o.onclick = () => { S.me[field] = it.id; colorUI.orig = it.hex; S.charCache.clear(); Object.assign(colorUI, hex2hsv(it.hex)); colorApply(); };
      ps.appendChild(o);
    }
  } else for (const hex of [dye[0], ...new Set([...S.avatar.shirtColors, ...S.avatar.pantsColors])]) {
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
  colorSet(colorUI.slot, hex.toLowerCase() === colorUI.orig.toLowerCase() ? null : hex);   // 選回原色＝不換色
}
function closeColor(ok) {
  if (!S.colorOpen) return;
  if (!ok) {
    colorSet(colorUI.slot, colorUI.before);
    if (LOOK_COLOR[colorUI.slot]) { S.me[LOOK_FIELD[colorUI.slot]] = colorUI.beforeItem; S.charCache.clear(); }   // 外貌：預設色換過的那一項也還原
  }
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
const wheelBlocked = () => S.mode !== 'walk' || S.helpOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.colorOpen || S.glamOpen || S.signOpen || S.confirmOpen;
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
  if (id !== 'sage' && S.fx.care) {   // 轉職離開賢者：永久關心跟著解除（告知原本被關心的人）；「自己關自己」的愛心也一起拿掉（被其他賢者關心的愛心不動）
    if (S.fx.care.self) S.fx.cared = 0;
    S.fx.care = null;
    S.net?.skillEvent?.(`care:${S.net?.id}:-`);
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
const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (S.signOpen) {                                             // 看板視窗開著：Esc 取消、Ctrl+Enter 儲存，其他鍵留給輸入框
    if (k === 'escape') { e.preventDefault(); closeSign(); }
    else if (k === 'enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveSign(); }
    return;
  }
  if (S.tableOpen) {   // 遊戲畫面開著：Esc 離開；五子棋復盤時 ←／→／Home／End 切換步數；其他鍵都不處理（不能走路）
    if (k === 'escape') { e.preventDefault(); if (!$('rulesBox').classList.contains('hidden')) rulesShow(false); else leaveTable(); }   // 規則視窗開著：Esc 先關；離開確認開著：Esc＝取消規則
    else if (S.dg && DG_KEYS[k]) { e.preventDefault(); S.dg.keys[DG_KEYS[k]] = true; }   // 躲彈幕：WASD／方向鍵移動
    else if (S.ar && arKey(e)) { /* 俄羅斯方塊：方向鍵／X／Z／空白鍵／C／Shift */ }
    else if (S.mz && mzKey(e)) { /* 豆豆迷宮：方向鍵／WASD */ }
    else if (S.hk && hkKey(e, true)) { /* 空氣曲棍球：方向鍵／WASD */ }
    else if (S.ty) typingKey(e);   // 英文打字競賽：英文字母
    else if (S.tableView?.game === 'blokus' && S.tableView.phase === 'playing' && S.tableView.role === 'seat') bkKey(e);
    else if (S.tableView?.game === 'trigon' && S.tableView.phase === 'playing' && S.tableView.role === 'seat') tgKey(e);   // Blokus Trigon：R 旋轉 60 度、F 翻面   // Blokus：R 旋轉、F 翻面
    else if (S.gmStep != null && S.tableView?.moves && ['arrowleft', 'arrowright', 'home', 'end'].includes(k)) {
      e.preventDefault();
      const N = S.tableView.moves.length;
      S.gmStep = k === 'arrowleft' ? Math.max(0, S.gmStep - 1) : k === 'arrowright' ? Math.min(N, S.gmStep + 1) : k === 'home' ? 0 : N;
      buildTable();
    }
    return;
  }
  const tg = e.target;   // 在輸入框打字（例如選色視窗的色碼）：除了 Esc 之外都不是遊戲按鍵，否則打 a／d／s／w 會讓角色跟著走
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA') && k !== 'escape') return;
  keys[k] = true;
  if (MOVE_KEYS.includes(k)) {                                  // 命令檢定：移動輸入記在真實時鐘——keydown（含按住的 OS 重複鍵）
    const me = S.players[0];                                    // 即使 rAF 被 Discord webview 凍結也記得到（2026-11-06 修正「該中沒中」）
    if (me) me.lastInputWall = Date.now();
  }
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (S.listOpen) { if (k === 'escape' || k === 'l') closeList(); return; }                // 線上列表開著：Esc / L 關閉
  if (S.dexOpen) { if (k === 'escape') closeDex(); return; }                               // 圖鑑開著：Esc 關閉（仍可走路）
  if (S.titleOpen) { if (k === 'escape') closeTitles(); return; }                          // 稱號一覽開著：Esc 關閉（仍可走路）
  if (S.colorOpen) { if (k === 'escape') closeColor(false); return; }                      // 選色視窗開著：Esc 取消
  if (S.glamOpen) { if (k === 'escape') closeGlams(); return; }                            // 外觀一覽開著：Esc 關閉（仍可走路）
  if (S.helpOpen) { if (k === 'escape' || k === 'enter') closeHelp(); return; }       // 操作說明開著：Esc / Enter 關閉，其他鍵不處理
  if (S.confirmOpen) { if (k === 'escape') closeConfirm(); return; }   // 「要保存嗎？」開著時：Esc＝繼續編輯，其他鍵不處理
  if (k === 'escape' && !$('avatarPanel').classList.contains('hidden')) { closeAvatar(); return; }   // 造型面板開著：Esc 先關面板（不會同時離開裝飾模式）；其他鍵照常
  if (k === 'e' && !e.repeat) {
    if (S.mode === 'decor') requestExitDecor();                       // 離開不受死亡影響
    else if (S.mode === 'walk') { if (S.players[0].dead) toast('你在墓碑裡動不了', 1400); else enterDecor(); }
  }
  if (k === 'escape' && S.mode === 'decor') requestExitDecor();     // Esc 也能離開裝飾模式
  if (k === 'l' && !e.repeat && S.mode === 'walk' && !S.confirmOpen) openList();
  if (k === 'f' && !e.repeat) doAttack(true);
  if (k === 'r' && !e.repeat) roleSkill()?.run();   // R：職能技能（坦克＝挑釁、補師＝群療、近戰輸出＝破綻、遠程輸出＝降傷）
  if ((k === '1' || k === '2') && !e.repeat) tryJobSkill(+k - 1);   // 1／2：職業技能
  if (k === 'shift' && !e.repeat) toggleSprint();   // Shift：切換疾走／步行（與右下角虛擬按鍵同一個開關）
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; arKeyUp(e.key.toLowerCase()); if (S.hk) hkKey(e, false); if (e.key.toLowerCase() === 'f') S.holdSkipF = false; if (S.dg && DG_KEYS[e.key.toLowerCase()]) S.dg.keys[DG_KEYS[e.key.toLowerCase()]] = false; });
// ---------------- 疾走虛擬按鍵（畫面右下角）----------------
// 圓形＋跑步像素小人；點擊或按 Shift 切換疾走／步行（2026-11-06 使用者要求：點擊後持續生效，再點擊或再按 Shift 切回步行）
function toggleSprint() {
  S.sprint = !S.sprint;
  toast(S.sprint ? '切換為疾走' : '切換為步行', 900);
}
const SPRINT_COLORS = { h: '#e8c39a', b: '#7fb2e5', t: '#5b8ec9', p: '#4a5a74', s: '#2c3648' };   // 膚色／上衣／袖／褲／鞋
const SPRINT_MAPS = {   // 像素小人（10×12，每格 2px）：步行＝站立；疾走＝兩幀跑步循環
  stand: [
    '..hhhhhh..',
    '..hhhhhh..',
    '..hhhhhh..',
    '...bbbb...',
    '..tbbbbt..',
    '..tbbbbt..',
    '...bbbb...',
    '...pppp...',
    '...p..p...',
    '...p..p...',
    '...p..p...',
    '...s..s...',
  ],
  run0: [   // 跨步：四肢張開
    '..hhhhhh..',
    '..hhhhhh..',
    '..hhhhhh..',
    '...bbbb...',
    '..tbbbb.t.',
    '..tbbbb.t.',
    '...bbbb...',
    '...pppp...',
    '..pp..pp..',
    '.pp....pp.',
    '.s......s.',
    '..........',
  ],
  run1: [   // 收腿：四肢收攏交替
    '..hhhhhh..',
    '..hhhhhh..',
    '..hhhhhh..',
    '...bbbb...',
    '...bbbb...',
    '..tbbbbt..',
    '...bbbb...',
    '...pppp...',
    '....pp....',
    '....pp....',
    '...s..s...',
    '..........',
  ],
};
function drawSprintBtn() {   // 每幀重畫（52×52 小畫布，成本可忽略）：疾走時小人兩幀交替跑起來、外框亮金
  const c = $('sprintIcon'); if (!c) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 52, 52);
  g.beginPath(); g.arc(26, 26, 24, 0, Math.PI * 2);
  g.fillStyle = 'rgba(8,10,14,.78)'; g.fill();
  g.lineWidth = 2; g.strokeStyle = S.sprint ? '#f3c93e' : '#8a7536'; g.stroke();
  const map = SPRINT_MAPS[S.sprint ? (Math.floor(S.t * 8) % 2 ? 'run0' : 'run1') : 'stand'];
  for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
    const ch = map[y][x]; if (ch === '.') continue;
    g.fillStyle = SPRINT_COLORS[ch];
    g.fillRect(16 + x * 2, 13 + y * 2, 2, 2);
  }
}
// 切走視窗時放開所有按住的鍵，避免卡住一直揮擊/走路
addEventListener('blur', () => { for (const k in keys) keys[k] = false; S.mouseHeld = false; S.paint = null; if (S.dg) S.dg.keys = {}; });
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
    const pr = propAtPoint(wx, wy);
    if (pr) { if (propDist(pr, S.players[0].x, S.players[0].y) < PROP_RANGE) useProp(pr); else toast('走近一點', 1200); return; }   // 點餐飲區
    const tb = tableAtPoint(wx, wy);
    if (tb) { if (tableDist(tb, S.players[0].x, S.players[0].y) < TABLE_RANGE) openTable(tb); else toast('走近一點再入座', 1200); return; }   // 點遊戲桌
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
  doAttack(false, wx, wy);   // 面向在 doAttack 裡依點的位置轉（四方向）
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
  if (S.mode !== 'walk' || S.helpOpen || S.listOpen || S.signOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.players[0].pose || S.t - S.players[0].lastAtk < ATK_CD) return;
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
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.tableOpen) return;
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
  if (S.confirmOpen || S.helpOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.tableOpen) return;
  if (S.mode === 'walk') {   // 右鍵和左鍵一樣：點椅子/沙發/床就坐下/躺下，再點一次起身；點遊戲桌就入座／觀戰（2026-11-12 使用者要求）
    const r = canvas.getBoundingClientRect(), wx = e.clientX - r.left + S.cam.x, wy = e.clientY - r.top + S.cam.y;
    const f = furnAtPoint(wx, wy), tb = tableAtPoint(wx, wy), pr = propAtPoint(wx, wy);
    if (pr) { if (propDist(pr, S.players[0].x, S.players[0].y) < PROP_RANGE) useProp(pr); else toast('走近一點', 1200); }   // 右鍵點餐飲區
    else if (f && furnitureDef(f.type)?.use) usePose(f);
    else if (f && furnitureDef(f.type)?.text) openSign(f);
    else if (tb) { if (tableDist(tb, S.players[0].x, S.players[0].y) < TABLE_RANGE) openTable(tb); else toast('走近一點再入座', 1200); }
    else { const n = npcAt(wx, wy); if (n) talkTo(n); }
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
$('btnSettings').onclick = () => $('settingsMenu').classList.toggle('hidden');   // 右上齒輪：開／收設定選單（操作說明等收在裡面，之後的設定項目也加這）
$('menuHelp').onclick = () => { $('settingsMenu').classList.add('hidden'); openHelp(); };   // 設定 → 操作說明（同嚮導的說明視窗）
const menuLvLabel = () => $('menuLv').textContent = `名牌等級：${S.profile.showLv === false ? '隱藏' : '顯示'}`;
menuLvLabel();   // 開先把開關文字對齊存檔
$('menuLv').onclick = () => {   // 設定 → 名牌等級顯示開關（2026-11-06，使用者定）
  S.profile.showLv = S.profile.showLv === false;
  saveProfile(); menuLvLabel();
  $('settingsMenu').classList.add('hidden');
};
const menuHpLabel = () => $('menuHp').textContent = `血量條：${S.profile.showHp === false ? '隱藏' : '顯示'}`;
const menuXpLabel = () => $('menuXp').textContent = `經驗條：${S.profile.showXp === false ? '隱藏' : '顯示'}`;
menuHpLabel(); menuXpLabel();   // 開先把開關文字對齊存檔
$('menuHp').onclick = () => {   // 設定 → 底部血量條顯示開關
  S.profile.showHp = S.profile.showHp === false;
  saveProfile(); menuHpLabel(); syncHud();
  $('settingsMenu').classList.add('hidden');
};
$('menuXp').onclick = () => {   // 設定 → 底部經驗條顯示開關
  S.profile.showXp = S.profile.showXp === false;
  saveProfile(); menuXpLabel(); syncHud();
  $('settingsMenu').classList.add('hidden');
};
// ---- 暱稱（2026-11-13，使用者要求）：設定 → 暱稱設定，只改「顯示名稱」。登入者存在伺服器（Registry，跟著帳號；S.nick 由伺服器的 nick 訊息給，空＝用 Discord 名稱），
// 訪客存本機 localStorage；身分（uid）不變，排行榜等以 uid 為準。不擋撞名 ----
const NICK_MAX = 12;
const cleanNick = v => String(v || '').replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, NICK_MAX);
const guestNick = () => { if (S.guestNickMem != null) return S.guestNickMem; try { return cleanNick(localStorage.getItem('dcisland.m0.nick')); } catch { return ''; } };   // guestNickMem：存不了 localStorage 時至少這次有效
const nickCanSet = () => !S.discordUser || !!(S.net?.connected && S.net.uid);   // 有 Discord 身分就要連線登入才能存到伺服器
function applyMyName() {   // 自己的顯示名稱：登入者＝暱稱或 Discord 名稱；訪客＝本機暱稱或「訪客」
  const me = S.players?.[0]; if (!me) return;
  me.name = S.discordUser ? (S.nick || S.discordUser.name || '未命名') : (guestNick() || '訪客');
}
function openNick() {
  $('settingsMenu').classList.add('hidden');
  const inp = $('nickInput'), can = nickCanSet();
  $('nickHint').textContent = S.discordUser
    ? (can ? `只改顯示名稱，跟著你的帳號（你的 Discord 名稱：${S.discordUser.name}）。最多 ${NICK_MAX} 字，留空＝用 Discord 名稱。` : '要連線並用 Discord 登入後才能改暱稱。')
    : `只存在這台裝置上（用 Discord 登入後會跟著帳號）。最多 ${NICK_MAX} 字，留空＝「訪客」。`;
  inp.value = S.discordUser ? (S.nick || '') : guestNick(); inp.placeholder = S.discordUser ? S.discordUser.name : '訪客';
  inp.disabled = $('nickSave').disabled = $('nickReset').disabled = !can;
  $('nickBox').classList.remove('hidden'); inp.focus(); inp.select();
}
const closeNick = () => $('nickBox').classList.add('hidden');
function saveNick(raw) {
  if (!nickCanSet()) return;
  const v = cleanNick(raw);
  if (S.discordUser) S.net.nick(v);   // 伺服器存好後回 nick 訊息，才會換掉名字
  else { try { if (v) localStorage.setItem('dcisland.m0.nick', v); else localStorage.removeItem('dcisland.m0.nick'); } catch { /* 存不了就只有這次有效 */ } S.guestNickMem = v; applyMyName(); }
  closeNick();
  toast(v ? `暱稱改成「${v}」` : '已恢復預設名稱', 1800);
}
$('menuNick').onclick = openNick;
$('nickSave').onclick = () => saveNick($('nickInput').value);
$('nickReset').onclick = () => saveNick('');
$('nickCancel').onclick = closeNick;
$('nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveNick($('nickInput').value); } else if (e.key === 'Escape') { e.preventDefault(); closeNick(); } });
document.addEventListener('click', e => {   // 點齒輪與選單以外的地方就收起來
  if (!(e.target instanceof Element) || !e.target.closest('#settingsBox')) $('settingsMenu')?.classList.add('hidden');
});
// 視窗的父子關係（2026-11-13，使用者要求）：從某個視窗裡面打開的視窗是它的「子視窗」，**關掉父視窗時子視窗要跟著關**（反過來關子視窗不影響父視窗），
// 這樣不用一個一個關。目前：造型面板（角色）→ 稱號一覽、外觀一覽、選色視窗。之後新增「從某視窗裡開的視窗」，把它的關閉函式加進該父視窗的 closeXxx。
function closeAvatar() { closeColor(false); closeGlams(); closeTitles(); $('avatarPanel').classList.add('hidden'); }
$('btnAvatar').onclick = () => { if ($('avatarPanel').classList.contains('hidden')) { $('avatarPanel').classList.remove('hidden'); buildAvatarPanel(); } else closeAvatar(); };   // 再按一次＝關閉（子視窗一起關）
$('avatarClose').onclick = closeAvatar;
$('tableClose').onclick = () => leaveTable();
$('leaveStay').onclick = () => leaveAsk(false);
$('leaveGo').onclick = () => { leaveAsk(false); closeTable(); };
$('tableRulesBtn').onclick = () => rulesToggle('rules');   // 再點一下關閉
$('tableCharsBtn').onclick = () => rulesToggle('chars');
$('rulesClose').onclick = () => rulesShow(false);
$('btnDex').onclick = () => { if (S.dexOpen) closeDex(); else if (S.fishDB) openDex(); };   // 右上「圖鑑」：魚類圖鑑＋素材圖鑑／合成／配方筆記
$('dexClose').onclick = closeDex;
$('btnTitles').onclick = () => { if (S.titleOpen) closeTitles(); else openTitles(); };   // 造型面板的「稱號設定」：稱號一覽
$('titleClose').onclick = closeTitles;
$('sprintBtn').onclick = toggleSprint;   // 右下角疾走虛擬按鍵：點擊切換跑步／步行（Shift 同一個開關）

// ---------------- 資源載入 ----------------
async function ensureTerrain(id) {
  if (S.tImages[id]) return;
  const man = S.terrains[id];
  const files = new Set([man.ground, man.edge, man.water]);
  for (const d of man.deco) files.add(d.sprite);
  if (man.walls) for (const k of ['n', 'w', 'e']) if (man.walls[k]) files.add(man.walls[k]);   // 室內房間的牆
  for (const pr of man.props || []) if (pr.img) files.add(pr.img);   // 固定小物件（餐飲區）
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
  const [tjson, furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB, craftDB, gamesDB] = await Promise.all([
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
    loadJSON('assets/craft/craft.json').catch(() => null),   // 合成素材與配方；讀不到就沒有合成功能
    loadJSON('assets/games/games.json').catch(() => null),   // 和平島遊戲桌的遊戲定義；讀不到就沒有遊戲桌
  ]);
  TERRAIN_IDS.forEach((id, i) => S.terrains[id] = tjson[i]);
  Object.assign(S, { furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB });
  loadJobs(jobsDB);
  initCraft(craftDB);
  S.gamesDB = gamesDB;
  S.myLook = myLook;   // net.js 送 state 時用（自己的顯示造型）
  S.myLvl = () => lvInfo(S.profile.xp).lv;   // net.js 送 state 時用（自己的等級；登入者由伺服器覆寫）
  S.floorSizes = new Map(floors.items.map(f => [f.id, { w: f.w || 1, h: f.h || 1 }]));   // 地板占幾格（地毯 2×2，其餘 1×1）
  S.me.job = jobIdOf(S.me.job) || DEFAULT_JOB;   // 舊存檔的坦克／補師／輸出照 legacy 轉成騎士／白魔法師／忍者；沒有或不合法＝忍者
  if (S.me.title && !titleDef(S.me.title)) S.me.title = null;   // 稱號已從清單移除：不顯示
  // 2026-11-09 和平島加了魚種：「勾人心魄」「魚譜大成」改成每座島（含和平島）都要；「魚太公」「煙波釣徒」「釣場之王」（所有魚種）也自動包含和平島的魚。
  // 之前拿到的拔掉（戴著的卸下、從已提示清單移除，重新達成會再跳提示）；條件本身是即時算的，沒達成就是未解鎖
  if ((S.titleBook.rev || 0) < 1) {
    const revoked = ['heart_hook', 'world_angler', 'taigong', 'yanbo', 'fishing_king'];
    if (revoked.includes(S.me.title)) { S.me.title = null; saveAvatar(); }
    S.titleBook.known = (S.titleBook.known || []).filter(id => !revoked.includes(id));
    S.titleBook.rev = 1; lsSet('dcisland.m0.titles', S.titleBook);
  }
  checkTitles(true);                       // 依現有紀錄算一次已解鎖的稱號（不跳提示）
  if (!S.me.weapon || !weaponAllowed(S.me.job, S.me.weapon)) S.me.weapon = JOBS[S.me.job].weapon || 'hands';   // 舊存檔的武器（例如圓盾）這個職業不能用／沒武器欄：換成職業武器
  // 圖片：同樣全部並行（含目前所在地形的圖）。只有角色身體是必要的（缺了畫不出人），其餘缺圖就略過該項
  await Promise.all([
    ...S.floors.items.map(async f => S.floorImgs[f.id] = await loadSpr(`assets/floors/${f.sprite}`, f.anim)),
    ...S.mobsDB.mobs.filter(a => a.sprite).map(async a => S.mobImgs[a.id] = await optImg(`assets/mobs/${a.sprite}`)),   // 外部素材為主的島主可以沒有 sprite（沒有圖可退回）
    ...S.mobsDB.mobs.filter(a => a.anim?.sheet).map(async a => {   // 多幀動畫：sheet 載入失敗就退回單張 sprite
      const sh = await optImg(`assets/${a.anim.sheet}`);
      if (!sh) return;
      const an = loadAnim(sh, a.anim);
      if (a.tint) an.img = tintSheet(an.img, a.tintBase || sheetMainHex(an.img), a.tint, a.tintMode);   // 調色：一張基準圖 → 各島不同色系
      S.mobAnims[a.id] = an;
    }),
    ...S.toolsDB.tools.map(async t => { const im = await optImg(`assets/tools/${t.sprite}`); if (im) im.wscale = 2; S.weaponImgs[t.id] = im; }),   // 採集工具仍是舊 24px 規格（畫 2 倍）；換成 64px 模組時改 wscale
    optImg('assets/tombstone.png').then(im => S.tombImg = im),   // 死亡墓碑（島主龍衝打倒後原地出現）
    optImg('assets/external/img2pixel/campfire_sheet.png').then(im => { if (im) S.campfireSpr = makeSpr(im, { frames: 8, fps: 8 }); }),   // 營火 8 幀（使用者提供的外部素材；缺圖就只是不畫）
    optImg('assets/external/img2pixel/fireball_sheet.png').then(im => { if (im) S.fireballSpr = makeSpr(im, { frames: 8, fw: 64, fh: 64, fps: 12 }); }),   // 飛龍火球 8 幀（LPC 系素材；缺圖就只是不畫）
    optImg('assets/external/img2pixel/fireball_burst.png').then(im => { if (im) S.burstSpr = makeSpr(im, { frames: 12, fw: 32, fh: 32 }); }),   // 火球命中爆炸 12 幀（LPC explosions 2，CC0）
    ...S.furn.items.map(async it => S.furnImgs[it.id] = await loadSpr(`assets/furniture/${it.sprite}`, it.anim)),
    // 人物分層 sheet：軀幹（膚色）是必要的（缺了畫不出人），頭髮／衣服／褲子／帽子缺圖就略過那一層
    ...S.avatar.skins.flatMap(s => {   // 素體 sheet：男版＋女版（性別切換用）
      const files = [s.sheet, (s.sheet || '').replace('char_body_', 'char_body_female_')];
      return files.filter((f, i) => f && files.indexOf(f) === i)
        .map(async f => S.charImgs[f] = await loadImg(`assets/avatar/${f}`));
    }),
    ...[...S.avatar.hair, ...(S.avatar.tops || []), ...(S.avatar.bottoms || []), ...(S.avatar.shoes || []), ...(S.avatar.faces || []), ...(S.avatar.eyes || []), ...(S.avatar.hats || [])]
      .flatMap(it => [it.sheet, it.sheetF, it.dyeFrom]).filter((f, i, a) => f && a.indexOf(f) === i)   // 沒有圖的（不戴帽子的 nohat）不用載；服裝的女版 sheetF 也要載
      .map(async f => S.charImgs[f] = await optImg(`assets/avatar/${f}`)),
    ...S.avatar.weapons.filter(w => w.lpc).flatMap(w => [w.lpc.bg, w.lpc.fg, ...Object.values(w.lpc.over || {}).flatMap(o => [o.bg, o.fg])])   // LPC 武器圖層
      .filter(Boolean).map(async f => S.charImgs[f] = await optImg(`assets/avatar/${f}`)),
    ...(S.avatar.races || []).flatMap(r => [r.ear, r.earBg, r.earFg]).filter(Boolean)   // 種族耳朵圖層（精靈耳／貓耳前後層）
      .map(async f => S.charImgs[f] = await loadImg(`assets/avatar/${f}`)),
    ...S.avatar.weapons.filter(w => w.sprite).map(async w => {
      const im = await optImg(`assets/avatar/${w.sprite}`);
      if (im && w.back === 'hilt') im.hiltUp = true;   // 背在背上時劍柄朝上（drawWeaponBack 看這個旗標）
      if (im) im.carry = w.carry === 'waist' ? 'waist' : 'back';   // 不拿在手上時掛哪裡
      if (im) im.wscale = w.scale || (S.avatar.frames.scale || 2);   // 畫幾倍：新 64px 模組預設與人物同倍率（1），舊 placeholder 標 scale: 2
      S.weaponImgs[w.id] = im;
    }),
    ...Object.values(S.fishDB.terrains).flat().map(async f => S.fishImgs[f.id] = await optImg(`assets/fish/${f.sprite}`)),
    ...(S.craftDB?.materials || []).map(async m => S.craftImgs[m.id] = await optImg(`assets/craft/${m.id}.png`)),
    ...Object.entries(S.gamesDB?.games || {}).map(async ([id, g]) => S.tableImgs[id] = await optImg(`assets/games/${g.sprite}`)),
    ...Object.values(S.gamesDB?.games || {}).flatMap(g => g.sprites || []).map(async f => S.tableImgs[f] = await optImg(`assets/games/${f}`)),   // 俄羅斯方塊：4 台各自的配色（terrain.json 的 tables[].img）
    ensureTerrain(S.terrain),
  ]);

  genWorld(S.terrain);
  loadLayout();
  buildTerrainChips();

  S.players = [makePlayer('訪客', { dx: -40, dy: 10 })];
  applyMyName();   // 訪客的暱稱存在本機
  spawnNPCs();

  fetch('version.json', { cache: 'no-store' }).then(r => r.json()).then(v => { if (v.commit) $('verTag').textContent = v.commit; }).catch(() => {});   // 左上角顯示版本（commit 前 7 碼）

  let last = performance.now();
  function loop(now) {
    if (now - last > 2000) S.net?.requestDragonSnap?.();   // 分頁被凍結過（切視窗回來）：要一份島主即時快照，別用舊位置打人
    // rAF 給的 now 是「這一幀開始的時刻」，第一幀可能比上面記的 performance.now() 還早 → dt 變負、S.t 掉到 0 以下，
    // 所有「S.t < (xxUntil ?? 0)」的判斷都會誤判成生效中（例如剛進島就跳「石化解除了！」），所以夾在 0 以上
    const dt = Math.max(0, Math.min(.05, (now - last) / 1000)); last = now;
    try {
      S.t += dt;
      stepWeather(dt);   // 天氣：時刻槽抽籤與過渡（純客戶端、零同步；詳見 draw() 前的天氣區塊）
      updateCampfire();   // 換時段／換地形就重擲營火位置（每 3 分鐘）
      stepFireballs(dt);  // 飛龍火球：步進與落地命中（純客戶端投射物）
      autoAttack();
      for (const p of S.players) stepPlayer(p, dt);
      stepFood(S.players[0]);   // 餐飲區吃喝的效果：中毒扣血、打嗝、過期、畫面濾鏡
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
            if (!a.proxy && !a.lurker) S.respawn.push({ id: a.id, terrain: S.terrain, at: S.t + (S.mobsDB.respawn || 30) });   // 島主（proxy）重生由伺服器的 spawn 事件驅動；釣上來的怪物不重生
          }
          continue;
        }
        stepMob(a, dt);
      }
      for (let i = S.respawn.length - 1; i >= 0; i--) {
        const r = S.respawn[i];
        if (S.t >= r.at) { S.respawn.splice(i, 1); if (r.terrain === S.terrain) respawnMob(r.id); }   // 只在擊倒牠的那座島重生
      }
      stepDecos(dt); stepDrops(dt);
      for (let i = S.floaters.length - 1; i >= 0; i--) {
        const f = S.floaters[i];
        f.life -= dt;
        if (!f.slash && !f.beam && !f.beamLine && !f.healPulse && !f.orb && !f.aoe && !f.fxk && !f.steam && !f.gold && !f.burst) f.y -= 34 * dt;   // 爪擊/光束/綠圈/蒸汽/升級金光固定在原座標，不隨飄字上浮（蒸汽自己在渲染時上升）
        if (f.life <= 0) S.floaters.splice(i, 1);
      }
      stepSkills();
      updateSkillBar();
      updateStatBars();
      updateWeaponBar();
      drawSprintBtn();
      draw();
    } catch (e) { console.error('loop:', e); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.S = S; // debug / discord.js 接線用
  window.toast = toast;
  // 進島只提示歡迎；操作方式看右上齒輪（設定）選單裡的「操作說明」或問嚮導
  const welcomeMs = 3000;
  welcomeUntil = performance.now() + welcomeMs;           // 歡迎訊息顯示期間，不讓「已連上島」把它蓋掉
  toast('歡迎來到 DC島！', welcomeMs);
  import('./discord.js').then(m => m.hookDiscord()).catch(err => console.warn('hookDiscord:', err));
  // M2：多人同步（同語音頻道＝同島；本機則 ?room= 或預設 local:local）
  import('./net.js').then(m => m.connectNet(S, {
    onFurn: onNetFurn,
    onFloor: onNetFloor,
    onHeal: onNetHeal,       // 補師的群補事件（各客戶端自判自己是否在半徑內）
    onPunch: punchFx,        // 別人空手出拳：算打到誰、畫衝擊星（純特效）
    onSkillEvent,            // 職業技能事件（群盾自判、別人畫面上的特效）
    onAdmin: v => { S.admin = !!v; updateDecorUI(); },
    onMe: onNetMe,           // 登入結果：決定 XP 記帳走伺服器；伺服器沒紀錄時一次性上繳本機存檔
    onXp: onNetXp,           // 伺服器的 XP 記帳結果（更新本機映像＋飄字／升級演出）
    onCommitResult: onCommitResult,
    onDecos: onNetDecos,
    onDeco: onNetDeco,
    onDragon: onNetDragon,   // 島主事件（aim/hp/dead/spawn/state 快照）
    onLurker: onNetLurker,   // 釣上來的敵對怪物（spawn/wander/claw/aggro/hp/dead/gone/state 快照）
    onFishResult,            // 釣魚結果（伺服器抽的魚；登入的人已記進伺服器的圖鑑）
    onTable: onNetTable,       // 和平島遊戲桌：伺服器給我的牌桌畫面
    onTpos: onNetTpos,         // 躲彈幕：其他玩家的位置
    onTpg: onNetTpg,           // 英文打字競賽：觀戰者看到的其他玩家打字進度
    onTsc: onNetTsc,           // 英文打字競賽：其他玩家的分數
    onTmx: onNetTmx,           // 英文／中文打字競賽：對手剛打錯（分數框閃紅）
    onTtb: onNetTtb,           // 俄羅斯方塊：別台的盤面快照
    onTgb: onNetTgb,           // 俄羅斯方塊（對戰模式）：被送垃圾行
    onTms: onNetTms,           // 豆豆迷宮：豆豆的快照
    onTmp: onNetTmp,           // 豆豆迷宮：幽靈玩家的位置
    onThp: onNetThp,           // 空氣曲棍球：別人的握把位置
    onThs: onNetThs,           // 空氣曲棍球：桌主的圓盤快照
    onTblInfo: onNetTblInfo,   // 和平島各桌的人數／狀態
    onCraftDb: onNetCraftDb,   // 登入後伺服器送來的合成解鎖紀錄（素材圖鑑／配方筆記）
    onKills: onNetKills,       // 登入後／擊倒島主時伺服器送來的擊倒紀錄（跟著帳號）
    onNick: nick => { S.nick = nick || ''; applyMyName(); },
    onGstats: onNetGstats,   // 登入後／每局結算後伺服器送來的遊戲戰績（跟著帳號，稱號用）   // 登入後／改暱稱後伺服器送來的暱稱（跟著帳號）
    onDex: dex => { S.dex = dex || {}; S.dexSource = 'server'; if (S.dexOpen) buildDex(); checkTitles(true); },   // 登入後伺服器送來的圖鑑（稱號跟著重算，不跳提示）
    onOpen: net => {
      if (S.tableOpen) closeTable(false);   // 重連：伺服器已當作我離開牌桌，畫面跟著關
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
