// DC島 — 遊戲本體（世界生成、移動、繪圖、戰鬥、動物、裝飾、造型、UI）。多人同步在 net.js，連線時以伺服器（Worker／dev_server）為準
import { initPets, addPet, removePet, stepPets, petEntries, syncRemotePets, stepRemotePets, remotePetEntries, petList, petDef, petLeftMs, petIconStyle, petAtPoint, petPat } from './pets.js';   // 扭蛋寵物跟隨（2026-11-19）
const CELL = 32, COLS = 108, ROWS = 72;   // 島放大：鏡頭跟隨（2026-11-09 前七座島半徑 ×1.5：88×56 → 108×72，島心 (43.5,27.5) → (53.5,35.5)；舊家具座標不遷移）
const ISLAND_AREA = 2.25;   // 前七座島的面積倍數（半徑 1.5 倍）：野生動物數量照這個放大，素材（點綴物）本來就是每格機率，自動跟著多
const VIEW_W = 29 * 32, VIEW_H = 17 * 32;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// 把遊戲畫面（canvas）的實際上緣寫進 CSS 變數 --stage-top（2026-11-14 使用者要求自動讀取）：左上的武器列／增減益／角色、外觀、換色面板都照它排（見 style.css 的 #app）。
// 頂部列（#topbar）怎麼改高改矮、字型載入後換行，都會自動跟著；style.css 裡寫的 75px 只是第一幀的預設值
function syncStageTop() {
  const app = canvas.offsetParent;   // #app（position: relative）
  if (!app) return;
  app.style.setProperty('--stage-top', canvas.offsetTop + 'px');
}
syncStageTop();
window.addEventListener('resize', syncStageTop);
if (window.ResizeObserver) { const tb = document.getElementById('topbar'); if (tb) new ResizeObserver(syncStageTop).observe(tb, { box: 'border-box' }); }   // border-box：連內距、邊框改變也算（預設只看內容區）

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
  me: lsObj('dcisland.m0.avatar', null) || { skin: 'light', hair: 'hair1', race: 'human2', shirt: 0, weapon: 'sword' },
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
  chips: lsGet('dcisland.m0.chips', null),   // 籌碼（2026-11-16 使用者定：籌碼＝經驗值×100，賭博系列的下注貨幣）：訪客存本機、登入者以伺服器為準（下面夾值＋老玩家遷移）
  mary: null, maryRaf: 0, maryBets: null, maryBetAmt: 100,   // 小瑪莉：跑馬燈動畫狀態（pos 目前照到的格、spin 進行中的補間）／畫面迴圈／押注中的每格金額／每注金額
  titleForceId: null, titleForceUntil: 0,   // 強制稱號（殺寵懲罰）：本機的生效紀錄在 localStorage 的 dcisland.m0.titleForce
  ownerHitAt: {},                      // 自己最後一次打到各島主／魚人的時刻（S.t；「參與擊倒」＝倒下前 TITLE_ASSIST 秒內打過；訪客的擊倒 XP 獎勵也看這個）
};
// 舊存檔／被亂改的 localStorage 也要夾在安全範圍：與兩份伺服器的 XP_MAX 同值（2026-11-07 檢查時補）
S.profile.xp = Math.max(0, Math.min(200000, Math.floor(Number(S.profile.xp) || 0)));
if (typeof S.profile.showLv !== 'boolean') S.profile.showLv = true;
if (typeof S.profile.showHp !== 'boolean') S.profile.showHp = true;   // 底部 HUD：血量條（設定可關）
if (typeof S.profile.showXp !== 'boolean') S.profile.showXp = true;   // 底部 HUD：經驗條（設定可關）
// 籌碼：夾值；沒有（或壞掉的）紀錄時按本機 XP 一次性補發（籌碼＝經驗值×100；登入者等 hello 的 chips init 蓋掉，訪客就靠這行遷移）
S.chips = typeof S.chips === 'number' && isFinite(S.chips) && S.chips >= 0 ? Math.min(20000000, Math.floor(S.chips)) : Math.max(0, Math.floor(S.profile.xp)) * 100;
if (!lsRaw('dcisland.m0.chips')) lsSet('dcisland.m0.chips', S.chips);   // 遷移補發也寫進本機（之後賭博桌的輸贏各自存）

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
// ---- 和平島的隱藏區（2026-11-24，協作者要求：賭博機台不要太明顯）----
// terrain.json 的 secret＝{box 隱藏房間地板範圍、door 北牆的門洞、curtain 門簾圖、rug 地毯圖}（格座標、含邊界）。房間在北牆後面，
// 平常不畫、裡面的東西（機台、別人）也不畫；自己走進門洞（門簾後面）才打開（S.secretOpen），退回牆外就關。小地圖不畫、不能擺家具／鋪地板。
function secretOf(id = S.terrain) { return S.terrains[id]?.secret || null; }
function secretCell(x, y, id = S.terrain) {   // 這格是隱藏房間或門洞（可以走）
  const sc = secretOf(id); if (!sc) return false;
  const b = sc.box, d = sc.door;
  return (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) || (x >= d[0] && x <= d[2] && y >= d[1] && y <= d[3]);
}
function inSecretArea(x, y, id = S.terrain) {   // 隱藏區含四周的牆（擺設、地板都不行）
  const sc = secretOf(id); if (!sc) return false;
  const b = sc.box;
  return secretCell(x, y, id) || (x >= b[0] - 1 && x <= b[2] + 1 && y >= b[1] - 4 && y <= b[3]);
}
function updateSecret() {   // 每幀：自己走進門簾後面就打開（遲滯：往回退到牆外一點才關，不會在門口閃）
  const sc = secretOf(), me = S.players[0];
  if (!sc || !me) { S.secretOpen = false; return; }
  const y = me.y / CELL, door = sc.door;
  S.secretOpen = S.secretOpen ? y < door[1] + 1.6 : y < door[1] + 1;
}
// ---- 島形（2026-11-14 使用者定：除和平島外，7 座戶外島的形狀彼此明顯不同、大小與現狀差不多）----
// 全部都表示成「d 值」（<.7 陸地、.7~1.1 岸邊、其餘水，門檻與舊橢圓同一套）的形狀函式，可再疊一層「挖洞」
// （bites：橢圓咬痕，洞內是水、洞緣留岸邊）。genWorld 會先掃一次（不含雜訊）數陸格，把形狀等比縮放到
// 與舊橢圓的陸地面積相近（π·43.5·29.25·.7 ≈ 2800 格），所以每座島大小都差不多。決定論：形狀是寫死的
// 常數，同一地形每個人、每次生成都一模一樣。
//   ellipse：基準橢圓（rx/ry/rot 可旋轉）半徑式，可加諧波 f(θ)=1+Σa·cos(kθ+φ) 或葉瓣項
//            leaf:{n,depth,pow,sharp}：f −= depth·(1−min(1,|cos(n/2·θ)|^pow·sharp))——sharp 飽和讓峰變平頂（方齒）、
//            谷是清楚的齒隙（pow 越大齒隙越寬）；pow 1＋sharp 2.2＝十齒齒輪
//   poly   ：多邊形輪廓（pts＝[角度deg, 半徑倍率]，射線與邊求交得 R(θ)）——楓葉、骷髏這種諧波畫不出的輪廓
//   blobs  ：兩個橢圓取聯集（d 取最小）——葫蘆
const MAPLE_PTS = [   // 楓葉輪廓（角度deg遞增、0＝右／90＝下，尾段跨 360 回到第一點）：橫放、尖端朝東——
// 三大瓣（東尖＋南北兩瓣）＋基部兩小瓣、深而窄的葉谷、基部圓窄。直立（尖端朝上）在面積 2800 格下尖端會被地圖上下緣切掉，橫放才放得進 108×72 的地圖
  [0, .9], [11, .8], [19, .45], [27, .78], [48, .85], [68, .6], [76, .42], [84, .55], [112, .6], [138, .48], [178, .48],
  [222, .48], [248, .6], [276, .55], [284, .42], [292, .6], [312, .85], [333, .78], [341, .45], [349, .8],
];
const SKULL_PTS = [   // 骷髏頭輪廓（角度deg遞增，形狀與搜尋假設一致——角度不遞增會讓跨 360 的段對不上、輪廓冒出尖刺）：圓顱、太陽穴微凹、顴骨外凸、下顎收窄、下巴圓平；頭頂略收（面積歸一化會把島放大，頭頂全徑會貼到地圖上緣）
  [14, .925], [38, .885], [58, .805], [78, .775], [90, .765], [102, .775], [122, .805], [142, .885], [168, .925],
  [192, .885], [213, .955], [242, .955], [270, .93], [298, .955], [327, .955], [348, .885],
];
const SHAPE_BY_TERRAIN = {
  grass:   { kind: 'poly', R: 42, pts: MAPLE_PTS },                                                                                 // 草島：楓葉（尖瓣深谷，北端一片尖端朝上）
  beach:   { kind: 'ellipse', rx: 40, ry: 28, rot: -.4, bites: [{ bx: 30, by: -24, brx: 18, bry: 12, brot: 0 }] },   // 沙灘島：新月（咬口中心貼著島緣外側，咬痕才切得穿到海、開口朝東北；離出生／NPC 區遠）
  snow:    { kind: 'ellipse', rx: 40, ry: 30, rot: 0, bites: [{ bx: 31, by: 0, brx: 19, bry: 7, brot: -.08 }] },                    // 雪島：東側切穿的狹長深灣（峽灣；島貼著地圖上下緣，灣開在東邊才切得穿到海）
  night:   { kind: 'poly', R: 38.7, pts: SKULL_PTS,                                                                                // 夜光島：骷髏頭輪廓
             bites: [   // 眼窩兩個（水）、鼻孔（水）、下緣三道牙縫缺口
               { bx: -8, by: -6, brx: 5, bry: 6, brot: 0 }, { bx: 8, by: -6, brx: 5, bry: 6, brot: 0 },
               { bx: 0, by: 8, brx: 2, bry: 3, brot: 0 },
               { bx: -11, by: 23, brx: 2.4, bry: 4, brot: 0 }, { bx: 0, by: 24, brx: 2.4, bry: 4, brot: 0 }, { bx: 11, by: 23, brx: 2.4, bry: 4, brot: 0 },
             ] },
  forest:  { kind: 'blobs', a: { dx: -13, dy: 9, rx: 26, ry: 22, rot: .3 }, b: { dx: 15, dy: -11, rx: 17, ry: 14, rot: -.2 } },     // 森林島：葫蘆（兩坨相連、腰身明顯）
  volcano: { kind: 'ellipse', rx: 35.7, ry: 35.7, rot: 0, harm: [[6, .17, 1.571], [3, .08, 1.0], [12, .05, 0]] },                   // 熔岩島：六道尖角的星形
  machine: { kind: 'ellipse', rx: 35, ry: 35, rot: 0, leaf: { n: 8, depth: .3, pow: 1, sharp: 2.6 } },                              // 機械島：八齒齒輪（平頂方齒、看得見的齒隙）
};
const SHAPE_DEFAULT = { kind: 'ellipse', rx: 43.5, ry: 29.25, rot: 0, harm: [] };   // 沒登記形狀的地形：原本的橢圓
const ISLAND_LAND_TARGET = Math.PI * 43.5 * 29.25 * .7;   // 舊橢圓的陸地面積（格數）：每座島都縮放到這個大小附近

function genWorld(id) {
  const rng = mulberry32(hashStr(id));
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;   // 島心（出生點周圍永遠是陸地：d 在島心＝0）；半徑歷史：26／17.5 →（2026-11-07）29／19.5 →（2026-11-09）43.5／29.25，2026-11-14 起只當面積基準（ISLAND_LAND_TARGET）
  const types = new Uint8Array(COLS * ROWS);
  const room = S.terrains[id]?.layout === 'room';   // 和平島：像室內——整張地圖都是地板，沒有水（2026-11-08 使用者要求移除最外圈的水；地圖邊界本來就走不出去）
  // 室內釣魚池（terrain.json 的 pools；2026-11-09）：池內是水（types 0，可以拋竿），外圍一圈是池邊（types 1，可以走）
  const inPool = (x, y, m) => (S.terrains[id]?.pools || []).some(p => x >= p.cell[0] - m && x < p.cell[0] + p.w + m && y >= p.cell[1] - m && y < p.cell[1] + p.h + m);
  // 該地形形狀的「原始 d 值」（不含雜訊、不含縮放）：橢圓 d=Σ(x/半軸)²；其餘先換成「沿該角度的邊界半徑 R(θ)」再 d=(rr/R)²
  const sh = SHAPE_BY_TERRAIN[id] || SHAPE_DEFAULT;
  const ellD = (e, px, py) => {   // 橢圓的 d 值（中心 e.dx/e.dy、半軸 e.rx/e.ry、旋轉 e.rot）
    const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
    const ax = px - (e.dx ?? cx), ay = py - (e.dy ?? cy);
    const u = ax * c + ay * s, v = -ax * s + ay * c;
    return (u / e.rx) ** 2 + (v / e.ry) ** 2;
  };
  const harms = sh.harm || [];
  const harmF = th => {   // 諧波＋葉瓣項（齒輪用葉瓣：|cos| 乘 sharp 飽和 → 平頂方齒＋清楚的齒隙；pow 越大齒隙越寬）
    let f = 1;
    for (const [k, a, p] of harms) f += a * Math.cos(k * th + p);
    if (sh.leaf) { const L = sh.leaf; const c = Math.abs(Math.cos(L.n / 2 * th)) ** (L.pow ?? 1); f -= L.depth * (1 - Math.min(1, c * (L.sharp || 1))); }
    return f;
  };
  const ellRawD = (x, y) => {   // 基準橢圓（× 諧波／葉瓣）的原始 d：半徑式 R(θ)=e(θ)·f(θ)
    const th = Math.atan2(y - cy, x - cx) - (sh.rot || 0), rr = Math.hypot(x - cx, y - cy);
    const R = 1 / Math.sqrt((Math.cos(th) / sh.rx) ** 2 + (Math.sin(th) / sh.ry) ** 2) * harmF(th);
    return (rr / R) ** 2;
  };
  let rawD;
  let poly = null;   // poly 形：多邊形輪廓（頂點 [角度deg, 半徑倍率]、角度遞增、對島心星狀）——楓葉、骷髏這種諧波畫不出的輪廓
  if (sh.kind === 'poly') {
    const vs = sh.pts.map(([a, r]) => { const t = a * Math.PI / 180; return { x: r * sh.R * Math.cos(t), y: r * sh.R * Math.sin(t), a: (a % 360 + 360) % 360 }; });
    const nv = vs.length;
    poly = (px, py, s) => {   // 點 (px,py) 是否在「以島心為基準、等比縮放 s 倍的多邊形」內——PNPOLY 射線投射法，非凸輪廓也正確
      let c = false;
      for (let i = 0, j = nv - 1; i < nv; j = i++) {
        const x1 = cx + vs[j].x * s, y1 = cy + vs[j].y * s, x2 = cx + vs[i].x * s, y2 = cy + vs[i].y * s;
        if ((y1 > py) !== (y2 > py) && px < (x2 - x1) * (py - y1) / (y2 - y1) + x1) c = !c;
      }
      return c;
    };
  } else if (sh.kind === 'blobs') {   // 兩個橢圓的聯集：d 取最小（各自有自己的岸邊圈）
    const A = { ...sh.a, dx: cx + sh.a.dx, dy: cy + sh.a.dy }, B = { ...sh.b, dx: cx + sh.b.dx, dy: cy + sh.b.dy };
    rawD = (x, y) => Math.min(ellD(A, x, y), ellD(B, x, y));
  } else {   // ellipse（含 SHAPE_DEFAULT）
    rawD = ellRawD;
  }
  // poly 的每格「邊界縮放比 ρ」：該格恰好多邊形邊界上的縮放倍率（對島心星狀 ⇒ 內外對 s 單調，二分搜尋）。
  // d = ρ²/mul：等 d 曲線＝多邊形的等比放大，與橢圓版 d=(rr/R)² 同義，岸邊帶自然沿輪廓走。
  // 舊版「射線與頂點夾角那段求 R」在非凸輪廓（深葉谷）會取錯邊——只取無限線交點、沒驗證落在線段上，
  // 部分角度算出幽靈半徑，陸地被撐到貼地圖邊。改用 PNPOLY 內外判定就沒有這問題。
  let rho = null;
  if (poly) {
    rho = new Float32Array(COLS * ROWS);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (poly(x, y, 4)) {   // 縮放 4 倍早已蓋過全圖；還在裡面才需要真的找邊界（在外面 ⇒ ρ 記 4，d 夠大＝水）
        let lo = 0, hi = 4;
        while (hi - lo > .002) { const m = (lo + hi) / 2; if (poly(x, y, m)) hi = m; else lo = m; }
        rho[y * COLS + x] = hi;
      } else rho[y * COLS + x] = 4;
    }
  }
  // 最終 d 值：原始 d 除以 mul（等比縮放，mul＝縮放比的平方）。挖洞層的分帶要在「縮放後」判（ds 也除以 mul），
  // 洞內是水（1.25）、洞緣留一圈岸邊（1.02）——固定值不再被縮放吃掉，灣才不會隨縮放變成淺灘
  const biteEls = (sh.bites || []).map(b => ({ rx: b.brx, ry: b.bry, rot: b.brot, dx: cx + b.bx, dy: cy + b.by }));
  let mul = 1;
  const dist = (x, y) => {
    let d = poly ? rho[y * COLS + x] * rho[y * COLS + x] / mul : rawD(x, y) / mul;
    for (const b of biteEls) {
      const ds = ellD(b, x, y) / mul;
      if (ds < 1.15) d = Math.max(d, ds < .95 ? 1.25 : 1.02);
    }
    return d;
  };
  // 歸一化把陸格數校到與舊橢圓相近（π·43.5·29.25·.7 ≈ 2800 格）。poly 的 rho 已預算、dist 很便宜，
  // 與其他形狀一樣迭代 3 次收斂（有 bites 的 poly：咬痕吃掉的陸格也要靠縮放補回，不能只算多邊形本身）
  for (let it = 0; it < 3; it++) {
    let land = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (dist(x, y) < .7) land++;
    if (!land) break;
    mul *= ISLAND_LAND_TARGET / land;
  }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (room) {   // 和平島：方形房間 roomBox 內是地板（池另算）；房間外填 0（走不進去，但不畫也不能釣魚，見 inRoom）
      types[y * COLS + x] = secretCell(x, y, id) ? 2 : !inRoom(x, y) ? 0 : inPool(x, y, 0) ? 0 : inPool(x, y, 1) ? 1 : 2;   // 隱藏區（北牆後面）也是地板
      continue;
    }
    let d = dist(x, y);
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
    if (pool.length && rng() < (td.decoDensity ?? .036)) decos.push({ i: decos.length, sprite: pool[Math.floor(rng() * pool.length)], cell: [x, y], flip: rng() < .5 });   // 密度可依地形調（terrain.json 的 decoDensity；大裝飾調低）
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

function spawnWild(id) {   // 找一塊陸地空格生一隻野外動物（生不下就放棄）；夜行怪入夜時也用這支（spawnNightMobs）
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
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
}

function spawnMobs() {
  S.mobs = [];
  S.respawn = [];   // 換島（或重生成世界）時重生佇列清空：新的島自己生一批，別島擊倒的不會跟過來（2026-11-09 修正：會在和平島冒出怪）
  const td = S.terrains[S.terrain];
  if (!S.mobsDB || !td.mobs?.length) return;
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  // 夜行怪（mobs.json 的 night，2026-11-14）：白天的島不生成，入夜後由主迴圈的 stepNightMobs 補上；天亮全數退場
  const allowNight = isNight();
  // mobs.json 標 fixed: N 的種類（例如新怪）：在該島固定生 N 隻（保證一定看得到），不參與下面的隨機池
  const AREA = S.terrains[S.terrain]?.layout === 'room' ? 1 : ISLAND_AREA;
  for (const a of td.mobs) { const d = mobDef(a.id); if (d?.night && !allowNight) continue; const n = Math.round((d?.fixed || 0) * AREA); for (let i = 0; i < n; i++) spawnWild(a.id); }
  // 其他種類照舊：從權重池隨機抽 6 隻
  const pool = [];
  for (const a of td.mobs) { const d = mobDef(a.id); if (!d?.fixed && !(d?.night && !allowNight)) for (let i = 0; i < a.weight; i++) pool.push(a.id); }
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
  if (def.night && !isNight()) return;   // 夜行怪：天亮後擊倒的不重生（夜間倒在夜間、天亮前還在 30 秒內就會爬起來）
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

// ---- 夜行怪（mobs.json 的 night，2026-11-14 使用者定）----
// 入夜（19:00）出現、天亮（04:00）退場；只在「人已經在島上、日夜切換」時靠這裡進退場，
// 換島時由 spawnMobs 自己判斷（白天進島不生夜行怪）。判斷完全靠 gameTime 現算、純客戶端（野外動物本來就不同步）。
function spawnNightMobs() {   // 入夜：夜行怪進場（fixed 補到數量＋從夜行怪的權重池再抽 3 隻）；回傳生了幾隻
  const td = S.terrains[S.terrain];
  if (!S.mobsDB || !td?.mobs?.length) return 0;
  const AREA = td.layout === 'room' ? 1 : ISLAND_AREA;
  let n = 0;
  for (const m of td.mobs) {   // fixed 的夜行怪（例如骷髏 6 隻）補到數量
    const d = mobDef(m.id);
    if (!d?.night) continue;
    const want = Math.round((d.fixed || 0) * AREA);
    const alive = S.mobs.reduce((s, a) => s + (a.id === m.id && !a.dead ? 1 : 0), 0);
    for (let i = alive; i < want; i++) if (spawnWild(m.id)) n++;
  }
  const pool = [];   // 非 fixed 的夜行怪照權重抽（每個人自己抽，位置不同沒關係）
  for (const m of td.mobs) { const d = mobDef(m.id); if (d?.night && !d.fixed) for (let i = 0; i < m.weight; i++) pool.push(m.id); }
  for (let i = 0; i < Math.round(3 * AREA) && pool.length; i++) if (spawnWild(pool[Math.floor(Math.random() * pool.length)])) n++;
  return n;
}
function stepNightMobs() {   // 每幀檢查日夜有沒有翻（便宜：只在變化時做事）
  const night = isNight();
  if (S.lastNight === undefined) { S.lastNight = night; return; }   // 第一次（進島／開場）只記狀態，不做事
  if (night === S.lastNight) return;
  S.lastNight = night;
  if (night) { if (spawnNightMobs()) toast('夜幕降臨，兇暴的怪物出現了！', 2600); }
  else {
    const before = S.mobs.length;
    S.mobs = S.mobs.filter(a => !mobDef(a.id)?.night);   // 天亮：夜行怪全數退場（含剛被打倒還沒清掉的屍體）
    if (S.mobs.length < before) toast('天亮了，夜行的怪物退回了黑暗。', 2600);
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
    if (auto && !quiet) { standUp(p); S.holdSkipF = true; return; }
    if (!(p.pose === 'sit' && isRod() && !auto)) return;   // 例外（2026-11-14 使用者要求）：坐在椅子上、拿著釣竿、用滑鼠點水面＝可以拋竿（躺床不行；F 仍是起身）
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
  const tr0 = S.fx.triple, free = !!(tr0 && tr0.n > 0 && S.t < tr0.until);   // 三重生效中：這一擊不用詠唱，可以邊走邊丟
  if (rg.cast && !free && (p.moving || p.z > 0)) { say('站定才能詠唱'); return; }   // 詠唱時不能移動（移動會中斷）；不用詠唱的弓、三重的攻擊可以邊走邊射
  const aim = castAim(wx, wy);
  let a = null;
  const under = aim ? mobUnder(aim[0], aim[1]) : null;   // 游標點在動物身上：就打牠（超出射程不改選別的）
  if (under) {
    if (!inCastRange(p, under, rg)) { say('目標超出射程'); return; }
    a = under;
  } else a = pickCastTarget(p, rg, aim);
  if (!a) { say('射程內沒有目標'); return; }
  const tr = S.fx.triple, instant = !rg.cast;   // cast 0（豎琴弓）＝不用詠唱，直接射
  if (instant || free) {   // 三重：這一擊不用詠唱
    if (!instant) tr.n--;
    p.lastAtk = S.t; p.swing = 0; p.tool = null; S._hits = 1; p.atkT0 = S.t;
    aimAt(p, a.x, a.y);
    S.net?.notifyAttack?.();
    const ty = a.y - 24 * (mobDef(a.id).big || 1) * .6;
    if (rg.shot === 'arrow') S.floaters.push({ fxk: 'arrow', x1: p.x + p.dir * 8, y1: p.y - 30, x2: a.x, y2: ty, life: .2 });
    else if (rg.shot === 'funnels') S.floaters.push({ fxk: 'funnels', x2: a.x, y2: ty, slots: noulithSlots(p.x, p.y, S.t, noulithSeed(p)).map(s => [s.x, s.y]), life: .45 });   // 賢具普攻：本體待機不動，四座依序從陣位射光束
    else S.floaters.push({ orb: true, x1: p.x + p.dir * 4, y1: p.y - 52, x2: a.x, y2: ty, life: .22 });
    hitMob(p, a, true);
    splashHit(p, a, rg);
    return;
  }
  p.cast = { t0: S.t, dur: rg.cast * castMul(p), a };   // 黑魔法師站在魔法陣內：詠唱 −50%
  aimAt(p, a.x, a.y);
  p.swing = 0; p.tool = null; S._hits = 1;   // 算有互動，點到動物時不要再跳動物的台詞
}
const CAST_SLIDE = 0.3;   // 滑步窗口（秒）：詠唱剩下這麼久時移動／跳躍不再中斷；武器的 ranged.slide 可覆蓋；窗口最多占詠唱的一半（魔法陣內詠唱減半時不會整段都能動）
const castSlideLen = c => Math.min(rangedDef()?.slide ?? CAST_SLIDE, c.dur * .5);
const inCastSlide = c => S.t - c.t0 >= c.dur - castSlideLen(c);
// 咒杖濺射（ranged.splash＝半徑 px）：主目標周圍的其他野生動物吃 60% 傷害（島主／釣上來的怪物由伺服器算血，不濺射）
function splashHit(p, a, rg) {
  if (!rg.splash) return;
  const dmg = Math.max(1, Math.round(((rg.dmg || 2) + (jobOf(p)?.dmgPlus || 0) + lvAtkBonus(levelOf(p)) * (rg.lvMul || 1)) * .6));
  S.floaters.push({ aoe: 'circle', x: a.x, y: a.y, r: rg.splash, life: .35 });
  for (const b of S.mobs.slice()) {
    if (b === a || b.dead || b.fly) continue;
    const bd = mobDef(b.id);
    if (bd.owner || bd.lurker || Math.hypot(b.x - a.x, b.y - a.y) - hitRadius(bd) > rg.splash) continue;
    hitMob(p, b, true, { dmg, splash: true });
  }
}
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
  splashHit(p, a, rg);
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
    if (jd?.dmgPlus && !force) dmg += jd.dmgPlus;   // 輸出：每擊 +1（打島主也算；已無傷害上限）
    if (!force) dmg += lvAtkBonus(levelOf(p)) * (ranged ? (rangedDef()?.lvMul || 1) : 1);   // 等級攻擊加成：每 3 級 +1（兩份伺服器的夾值同式放寬）；詠唱武器的 ranged.lvMul 讓每擊吃更多（咒杖 2：一擊的間隔是普攻的兩倍以上，不然等級成長追不上；打島主時送伺服器的值仍夾在 sendDmg 上限）
    const od = mobDef(a.id);
    const sendDmg = force ? force.dmg : dmg;   // 送給伺服器的值（上限 4＋攻擊者等級加成＝兩份伺服器的 dlHitMax；破綻的 +1 由伺服器自己加）
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
    const heal = force?.dot || force?.splash ? 0 : (jd?.healHit ? jd.healHit + (p === S.players[0] && fxOn('wings') ? 1 : 0) : 0) + (p === S.players[0] && fxOn('vamp') ? skillVal(1, p) : 0);   // 戰士吸血：命中回 1；毒箭的持續傷害不算「命中」
    const care = p === S.players[0] ? S.fx.care : null;   // 賢者關心：永久有效（改關別人／轉職才解除），每造成一次傷害就累積補血量
    if (care) {
      care.acc = (care.acc || 0) + (JOB_SKILLS.care.amt + (fxOn('save') ? JOB_SKILLS.save.plus : 0)) * skillMul(levelOf(p));   // 拯救期間：累積速度變 5 倍（0.5→2.5／下）；再乘等級倍率
      const n = Math.floor(care.acc);                     // 補血量是 0.5／下的零頭：累積湊滿整數才補，畫面與血量都保持整數（一次送出湊到的整數）
      if (n >= 1) {
        care.acc -= n;
        if (care.self) healMe(n);
        else S.net?.skillEvent?.(`careheal:${care.id}:${n}`);
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
      if (p === S.players[0] && isPeacePet(od)) petKillPenalty(od, p);   // 和平島殺寵：不給擊倒 XP、不掉素材，改吃懲罰（掉一等＋強制稱號一小時）
      else if (p === S.players[0] && !od.owner && !od.lurker) { grantExp(mobKillXp(od), p.x, p.y - 60, 'mob'); spawnCraftDrops(S.craftDB?.sources.mob[od.id], a.x, a.y); }   // 合成素材：擊倒野外動物掉落   // 非主動怪（羊／鳥／蛙）：擊倒 +1 XP、會反擊的野怪＝島主經驗 1/10（登入者上報事件由伺服器記；島主／魚人那步由伺服器計）
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
      if (!isPeacePet(od)) toast(od.lurker ? `${od.name} 被打倒了！` : `${mobDef(a.id).name} 被打倒了！${S.mobsDB.respawn || 30} 秒後重生`, 2200);   // 和平島殺寵：改吃 petKillPenalty 的懲罰訊息（不打倒訊息）
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
const jobIdOf = id => (JOBS[id] && !JOBS[id].hidden) ? id : (JOBS[JOB_LEGACY[id]] ? JOB_LEGACY[id] : null);   // 隱藏的職業（jobs.json 的 hidden）也照 legacy 轉成 replaceWith 指定的職業
function loadJobs(db) {
  JOB_LEGACY = { ...(db?.legacy || {}) };
  for (const j of db?.jobs || []) if (ROLES[j.role]) {
    JOBS[j.id] = { ...ROLES[j.role], ...j, roleName: ROLES[j.role].name, color: ROLES[j.role].color };
    if (j.hidden) JOB_LEGACY[j.id] = j.replaceWith || DEFAULT_JOB;   // 暫時隱藏（2026-11-14）：不列在職業選單；存檔裡或別人封包裡是這個職業的，一律當成 replaceWith（沒寫＝預設職業）
  }
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
const lvAtkBonus = lv => Math.floor((lv - 1) / 3);
// 職業技能的等級倍率（2026-11-15 使用者要求：技能也要吃等級加成，不然升等後沒人要放技能）：每 3 級 +50%（Lv 1＝1 倍、Lv 28＝5.5 倍）。
// 傷害技能（火遁／高跳／毒箭）與治療技能（單補／群療／吸血／關心）都乘這個倍率；伺服器算的技能傷害同式（Worker skillLvMul、dev_server skill_lv_mul）
const skillMul = lv => 1 + lvAtkBonus(lv) / 2;
const skillVal = (base, p = S.players[0]) => Math.max(1, Math.round(base * skillMul(levelOf(p))));   // 攻擊加成：每 3 級 +1
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
const chipsSave = () => { if (!xpServer()) lsSet('dcisland.m0.chips', S.chips); };   // 籌碼存本機（訪客／單機）；登入者以伺服器為準，不寫
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
  if (n > 0) { S.chips = Math.min(20000000, S.chips + n * 100); chipsSave(); }   // 籌碼＝經驗值×100（負的不追溯扣）
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
// ---- 和平島殺寵懲罰（2026-11-13 使用者定）：殺貓狗掉一等，並強制掛上稱號一小時 ----
// 稱號看「懲罰生效期間」殺過哪種：殺貓＝《屠貓變態》、殺狗＝《屠狗變態》、兩種都殺過＝《反社會人格變態》；
// 每次殺都重新計時一小時，過期後恢復原本選的稱號（開機還原見 boot 的 titleForce 段）。
// 稱號是本機機制（localStorage 的 dcisland.m0.titleForce，靠 state.title 同步給同島的人看，兩種模式都有效）。
// XP 兩種模式都會掉等：訪客／單機在本機扣；登入連線上報 petkill 事件（xpe），伺服器照現值算扣量後用 xp 回覆演出。
function petKillPenalty(od, p) {
  const f = lsObj('dcisland.m0.titleForce', null), alive = f && f.until > Date.now();
  const kinds = alive && f.kinds ? { ...f.kinds } : {};   // 生效中的紀錄帶著走：這一小時內兩種都殺過就升級
  kinds[od.id.startsWith('cat') ? 'cat' : 'dog'] = 1;
  const id = kinds.cat && kinds.dog ? 'kill_pets' : kinds.cat ? 'kill_cat' : 'kill_dog';
  const until = Date.now() + 3600e3;
  lsSet('dcisland.m0.titleForce', { id, kinds, until, prev: alive && f.prev !== undefined ? f.prev : (S.me.title ?? null) });
  S.titleForceId = id; S.titleForceUntil = until;
  S.me.title = id; saveAvatar();   // 名字正上方立刻換上懲罰稱號；state.title 會同步給同島的人
  // XP：訪客／單機在本機扣；登入連線由伺服器記帳（上報 petkill 事件，伺服器照現值算扣量，等 xp 回覆在 onNetXp 演出）
  const li = lvInfo(S.profile.xp);
  let dropLv = li.lv > 1;   // Lv1 沒等可掉（但仍扣光這級累積）；連線版照本機映像猜，實扣以伺服器為準
  if (xpServer()) {
    S.net?.xpPetKill?.();   // toast 文案等 xp 回覆才準確知道扣量，這裡先照本機等級猜
  } else {
    const loss = li.lv > 1 ? li.cur + xpNeed(li.lv - 1) : li.cur;
    if (loss > 0) {
      S.profile.xp = Math.max(0, S.profile.xp - loss);
      saveProfile();
      S.floaters.push({ x: p.x, y: p.y - 56, v: `−${loss} XP${li.lv > 1 ? '（掉一等）' : ''}`, life: 1.6, xpLoss: true });
    }
  }
  const pens = [dropLv ? '掉 1 等級' : '', `強制戴上《${PET_KILL_TITLES[id]}》一小時`].filter(Boolean);
  toast(`你殺了和平島的${kinds.cat && kinds.dog ? '貓狗' : od.name}！懲罰：${pens.join('，')}`, 4200);
}
const isPeacePet = od => S.terrain === 'peace' && (od.id === 'cat' || od.id === 'dog' || od.id.startsWith('cat_') || od.id.startsWith('dog_'));
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
  else S.floaters.push({ x: p.x, y: p.y - 46, v: `−${-d} XP${m.k === 'petkill' && lvInfo(S.profile.xp).lv < before ? '（掉一等）' : ''}`, life: 1.2, xpLoss: true });
  const after = lvInfo(S.profile.xp);
  if (after.lv > before) levelUpFx(p, after.lv);
}
// 籌碼記帳結果（伺服器權威；跟著 xp 訊息一起來）：更新本機映像。不加飄字（雜訊）——賭博桌畫面自己會顯示
function onNetChips(m) {
  const v = Math.max(0, Math.floor(Number(m.chips) || 0));
  if (v === S.chips) return;
  S.chips = v;
  if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel();
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
  const ao0 = src && jobOf(src)?.healAoE && jobOf(src).healAoE + (src.fx?.includes('wings') ? 1 : 0), ao = ao0 && skillVal(ao0, src);   // 翅膀：治療量 +1；再乘放的人的等級倍率（群療；打倒動物補周遭那段是被動、不吃倍率，在 hitMob）
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
S.myPets = () => petList().map(p => p.id);   // state.pets：自己帶著的跟隨寵物 id 清單，別人的畫面各自模擬跟隨（2026-11-20）

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
  sheal:    { name: '單補', cd: 12, amt: 4, range: 320, desc: '瞬發恢復滑鼠方向上最近的一位玩家血量（基礎 4，隨等級成長；射程 320px；附近沒有別人就補自己；翅膀期間 +1）',
              run(me) {
                const t = pickHealTarget(me, this.range), amt = skillVal(this.amt + (fxOn('wings') ? 1 : 0));   // 隨等級成長（翅膀的 +1 也一起乘）
                S.floaters.push({ fxk: 'sheal', x1: me.x, y1: me.y - 40, x2: t.x, y2: t.y - 24, life: .5 });
                if (t === me) healMe(amt);
                else S.net?.skillEvent?.('sheal:' + t.id);   // 對方收到後自己補（血量由各人自己算，與群療同一原則）
                return true;
              } },
  song:     { name: '唱歌', cd: 40, dur: 15, r: 300, crit: .25, desc: '周圍 300px 內所有人（含自己）15 秒內爆擊率 +25%（遠程攻擊平常不會爆擊，唱歌期間也會）',
              run(me) { S.fx.song = S.t + this.dur; S.net?.skillEvent?.('song'); S.floaters.push({ fxk: 'song', x: me.x, y: me.y, r: this.r, life: .7 }); return true; } },
  poison:   { name: '毒箭', cd: 12, dur: 30, every: 3, dmg: 1, range: 320, desc: '對滑鼠方向的敵人射一支毒箭：射中當下先受到傷害，之後 30 秒內每 3 秒一次（共 10 下；每下基礎 1，隨等級成長）',
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
                hitMob(me, a, true, { dmg: skillVal(this.dmg), sk: 'poison', dot: true });
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
  ninjutsu: { name: '火遁', cd: 20, cast: 1.5, r: 80, reach: 165, dmg: 6, desc: '結印 1.5 秒（可移動、不能攻擊），結完朝最近的敵人（島主優先）噴出火球，命中處 80px 內的敵人各造成傷害（基礎 6，隨等級成長）；附近沒有敵人時不能施放（不會結印、不進冷卻）',
              usable() { return ninjutsuTarget(S.players[0]) ? null : '附近沒有敵人'; },
              run(me) { if (!ninjutsuTarget(me)) { toast('火遁：附近沒有敵人', 1200); return false; } S.fx.seal = { t0: S.t, until: S.t + this.cast }; return true; } },   // 先確認有目標才結印（沒有就不開始、不進冷卻）
  highjump: { name: '高跳', cd: 15, dmg: 5, range: 200, desc: '跳到滑鼠方向 200px 內的敵人身上造成傷害（基礎 5，隨等級成長），再跳回原位',
              usable() { return pickCastTarget(S.players[0], this, castAim()) ? null : '範圍內沒有敵人'; },
              run(me) {
                const a = pickCastTarget(me, this, castAim());
                if (!a) { say('範圍內沒有敵人'); return false; }
                const ux = me.x - a.x, uy = me.y - a.y, l = Math.hypot(ux, uy) || 1;
                const tx = a.x + ux / l * 14, ty = a.y + uy / l * 6;   // 落在敵人身上（稍微偏向自己這側）
                const home = { x: me.x, y: me.y };
                startLeap(me, tx, ty, .42, 120, () => {
                  S.floaters.push({ fxk: 'jumpboom', x: a.x, y: a.y, life: .5 });
                  if (S.mobs.includes(a) && !a.dead) hitMob(me, a, false, { dmg: skillVal(this.dmg), sk: 'jump' });
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
  triple:   { name: '三重', cd: 30, dur: 15, n: 3, desc: '接下來 3 次攻擊不用詠唱，可以邊走邊丟（15 秒內有效）',
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
// 火遁的目標：最近的敵人（島主優先；距離不超過 reach，也在伺服器 170px 驗證範圍內）
function ninjutsuTarget(me) {
  const sk = JOB_SKILLS.ninjutsu;
  let tg = null, tb = Infinity;
  for (const a of S.mobs) {
    if (a.dead || a.fly) continue;
    const d = Math.hypot(a.x - me.x, a.y - me.y), od = mobDef(a.id);
    if (d > sk.reach || d - hitRadius(od) > sk.reach) continue;
    const sc = d - (od.owner ? 1e6 : 0);
    if (sc < tb) { tb = sc; tg = a; }
  }
  return tg;
}
// 每幀：忍術結印完成、三重／法陣過期
function stepSkills() {
  const F = S.fx, me = S.players[0];
  if (S.jobSwapUsed && !ownerEngaged()) S.jobSwapUsed = false;   // 戰鬥結束：戰鬥中換職業的次數重置
  if (F.seal && (me.dead || S.t < (me.petUntil ?? 0))) F.seal = null;
  if (F.seal && S.t >= F.seal.until) {
    F.seal = null;
    const sk = JOB_SKILLS.ninjutsu;
    // 火遁（2026-11-14 使用者要求：由「身邊爆炸」改成「對敵人及周圍造成傷害」）：挑最近的敵人（島主優先；距離不超過 reach，也在伺服器 170px 驗證範圍內），
    // 火球落在牠身上，落點 r 範圍內的敵人各吃 dmg；範圍內沒有敵人就不發動（不扣冷卻以外的東西，冷卻照算）。島主／魚人的傷害走技能路徑由伺服器驗證距離。
    const tg = ninjutsuTarget(me);
    if (!tg) { toast('火遁：目標不見了', 1200); return; }   // 結印期間目標跑遠或被打倒：落空
    const ty = tg.y - 14 * (mobDef(tg.id).big || 1);
    S.floaters.push({ fxk: 'firebomb', x1: me.x, y1: me.y - 30, x: tg.x, y: tg.y, ty, r: sk.r, life: .7 });
    S.net?.skillEvent?.(`ninjutsu:${Math.round(tg.x)}:${Math.round(tg.y)}`);
    for (const a of S.mobs) {
      if (a.dead || a.fly) continue;
      const od = mobDef(a.id);
      if (Math.hypot(a.x - tg.x, a.y - tg.y) - hitRadius(od) > sk.r) continue;
      if ((od.owner || od.lurker) && Math.hypot(a.x - me.x, a.y - me.y) > sk.reach + 5) continue;   // 伺服器權威的目標要在驗證範圍內
      hitMob(me, a, false, { dmg: skillVal(sk.dmg), sk: 'ninjutsu' });
    }
  }
  if (F.triple && (F.triple.n <= 0 || S.t >= F.triple.until)) F.triple = null;
  for (const a of S.mobs) {   // 吟遊詩人的毒箭：每 3 秒跳一次（自己上的毒，自己這邊送）；換掉職業或倒地就停
    const po = a.poison;
    if (!po) continue;
    if (a.dead || S.t >= po.until || me.dead || S.me.job !== 'bard') { a.poison = null; continue; }
    if (S.t >= po.next) { po.next += JOB_SKILLS.poison.every; hitMob(me, a, true, { dmg: skillVal(JOB_SKILLS.poison.dmg), sk: 'poison', dot: true }); }
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
  else if (kind === 'ninjutsu' || kind.startsWith('ninjutsu:')) {   // 火遁：ninjutsu:落點x:落點y（舊版沒帶座標就在施放者身上爆）
    const [, tx, ty] = kind.split(':'), X = tx != null ? +tx : r.x, Y = ty != null ? +ty : r.y;
    S.floaters.push({ fxk: 'firebomb', x1: r.x, y1: r.y - 30, x: X, y: Y, ty: Y - 14, r: JOB_SKILLS.ninjutsu.r, life: .7 });
  }
  else if (kind === 'blink') { S.floaters.push({ fxk: 'smoke', x: r.x, y: r.y, life: .45 }); r.snapNext = true; }
  else if (kind.startsWith('care:') || kind.startsWith('careheal:')) {   // 賢者的關心：care:賢者id:對象id（對象換人／解除）｜careheal:對象id:1
    const heal = kind.startsWith('careheal:');
    if (heal) {
      const [tid, a] = kind.slice(9).split(':');
      if (tid !== String(S.net?.id)) return;
      if (fxOn('cared')) healMe(Math.max(1, Math.min(80, Math.round(+a) || 1)));   // 回血量由賢者帶（隨賢者等級成長，湊到整數才送），夾在合理範圍
    } else {
      const [sid, tid] = kind.slice(5).split(':');
      if (tid === String(S.net?.id)) { S.fx.cared = Infinity; S.fx.caredBy = sid; S.floaters.push({ fxk: 'heart', x1: r.x, y1: r.y - 40, x2: me.x, y2: me.y - 30, life: .6 }); toast(`${r.name} 關心了你（永久）`, 1600); }
      else if (S.fx.caredBy === sid) { S.fx.cared = 0; S.fx.caredBy = null; }   // 這位賢者改關別人了：解除自己身上的關心狀態
    }
  }
  else if (kind.startsWith('sheal:')) {   // 單補：目標是我就補自己（翅膀看放的人 state 的 fx），其他人只畫特效
    const tid = kind.slice(6), t = tid === String(S.net?.id) ? me : [...S.remotes.values()].find(q => String(q.id) === tid);   // 連線編號可能是數字
    if (t) S.floaters.push({ fxk: 'sheal', x1: r.x, y1: r.y - 40, x2: t.x, y2: t.y - 24, life: .5 });
    if (t === me) { healMe(skillVal(JOB_SKILLS.sheal.amt + (r.fx?.includes('wings') ? 1 : 0), r)); toast(`${r.name} 幫你補血`, 1400); }   // 補多少看放的人的等級（r.lvl 隨 state 同步）
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
  const amt = skillVal((JOBS[S.me.job].healAoE || 2) + (fxOn('wings') ? 1 : 0));   // 翅膀：治療量 +1；再乘等級倍率
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
    case 'ninjutsu': bg('#2a1620'); g.fillStyle = '#e8481e'; g.beginPath(); g.moveTo(20, 6); g.quadraticCurveTo(32, 18, 28, 28); g.quadraticCurveTo(24, 35, 20, 34); g.quadraticCurveTo(12, 34, 11, 26); g.quadraticCurveTo(11, 18, 20, 6); g.fill(); g.fillStyle = '#ffb03a'; g.beginPath(); g.moveTo(20, 16); g.quadraticCurveTo(26, 24, 24, 29); g.quadraticCurveTo(21, 33, 18, 31); g.quadraticCurveTo(14, 28, 16, 23); g.quadraticCurveTo(18, 20, 20, 16); g.fill(); break;
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
function updateSkillBar() {
  if (S.skillOpen) {   // 技能說明視窗開著：換職業或升級就刷新內容
    const key = `${S.me.job}|${levelOf(S.players[0])}`;
    if (key !== S.skillInfoKey) { S.skillInfoKey = key; openSkillInfo(); }
  }   // 每幀：換職業就重建三格；更新冷卻扇形與秒數（只在值變了才改 DOM）
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
  // 主動攻擊怪（aggro＝視野半徑，2026-11-14 使用者定：夜晚出現的怪都是這型）：視野內看到本地玩家就主動鎖定追擊，
  // 機制完全沿用反擊型那套（追殺 150、貼圈每 1.5 秒抓一下、30 秒放棄），差別只在「不用被打就開咬」。
  // 等級壓制（筆記既定的主動怪規則）：主動怪不會攻擊等級比牠高的角色——玩家等級比較高就直接無視（被高等玩家打照樣反擊，不受此限）。
  if (def.aggro && !a.aggroT) {
    const me0 = S.players[0];
    if (!me0.dead && !me0.npc && levelOf(me0) <= (def.lv ?? 1) && Math.hypot(me0.x - a.x, me0.y - a.y) < def.aggro) {
      a.aggroT = me0; a.lastHitAt = S.t;
    }
  }
  // 群攻（swarm：使用者定 2026-11-11，目前骷髏）：場上同種存活數低於門檻＝全體自動追殺本地玩家
  //（不用被打、距離不限；有個人仇恨的照個人仇恨追）。回補到門檻以上（擊倒的約 30 秒重生）就脫離：
  // 群攻期間不刷新 lastHitAt，脫離後只有「真的被打過還在 30 秒內」的繼續追，其餘立即回漫遊
  const swarm = def.swarm && S.mobs.reduce((s, m) => s + (m.id === a.id && !m.dead ? 1 : 0), 0) < def.swarm;
  if (swarm) {
    const me = S.players[0];
    if (!me.dead && !me.npc && !a.aggroT) a.aggroT = me;   // 沒有個人仇恨才補群攻目標
  }
  const t = a.aggroT;
  // 主動怪的仇恨保鮮：目標還在視野內就一直鎖著（30 秒倒數要「離開視野」才開始跑）；被甩掉＝跑步甩得掉、躲遠 30 秒後放棄
  if (t && !t.dead && def.aggro && Math.hypot(t.x - a.x, t.y - a.y) <= def.aggro) a.lastHitAt = S.t;
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
  petPlayStep(a, dt, def);   // 和平島貓狗玩耍追逐（內部自判地形；玩耍時兩隻互設目標，之後照下面的一般移動走）
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
  // 玩耍追逐（和平島貓狗）：追的一方比平常快、被追的慢一點，追的人才追得上（追上就換人）
  const sp = (chasing ? RETAL_CHASE : (a.startle ? def.speed * 2.6 : a.play ? def.speed * (a.play.role === 'chase' ? 1.9 : 1.6) : def.speed)) * dt;
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

// ---- 和平島貓狗玩耍追逐（2026-11-13 使用者定）：附近的貓狗會互相追逐玩耍，誰追誰、兩隻還是一群都不一定 ----
// 做法：每隻偶爾「約」附近另一隻一起玩（a.play＝{o: 對方, role: 'chase'／'flee', until}）：追的一方每幀把目標
// 設成對方，貼近就換人追（或隨機改追附近第三隻＝一群接力）並飄一顆愛心；被追的往反方向逃。玩家揮擊嚇到
// （startle）、對方死掉或時間到就散。這裡只挑目標與管狀態，移動照 stepMob 下面的一般流程走。
const PLAY_JOIN_R = 6.5 * CELL, PLAY_CATCH_R = 22, PLAY_FAR_R = 4.5 * CELL;

function petPlayStep(a, dt, def) {
  if (S.terrain !== 'peace') return;   // 只有和平島的貓狗會玩
  if (a.play) {
    const o = a.play.o;
    // 對方死掉／被移除／被嚇到（自己也一樣）／對方已經跟別的配對（理論上不會）：散場
    if (!o || o.dead || !S.mobs.includes(o) || o.startle || a.startle || (o.play && o.play.o !== a)) { petPlayEnd(a); return; }
    if (S.t >= a.play.until) {   // 玩夠了：兩隻都歇一下再回去散步
      petPlayEnd(a);
      a.idle = Math.max(a.idle, .6 + Math.random()); o.idle = Math.max(o.idle, .6 + Math.random());
      return;
    }
    if (a.play.role === 'chase') {
      if (Math.hypot(o.x - a.x, o.y - a.y) < PLAY_CATCH_R) {   // 追上了：飄愛心，換人追（或接力追第三隻）
        S.floaters.push({ fxk: 'heart', x1: a.x, y1: a.y - 26, x2: o.x, y2: o.y - 24, life: .6 });
        const third = Math.random() < .35
          ? S.mobs.find(m => m !== a && m !== o && !m.dead && !m.play && !m.startle && !mobDef(m.id).retaliate && Math.hypot(m.x - a.x, m.y - a.y) < PLAY_JOIN_R)
          : null;
        if (third) { o.play = null; a.play.o = third; third.play = { o: a, role: 'flee', until: a.play.until }; }   // 一群：原本的被追者恢復自由
        else { a.play.role = 'flee'; o.play = { o: a, role: 'chase', until: a.play.until }; }                       // 兩隻互追：換人
      }
      if (a.play.role === 'chase') a.target = o;                                    // 繼續追著對方跑
      else a.target = fleeTarget(a, def, o.x, o.y, 150);                            // 剛被追上：掉頭逃
    } else if (Math.hypot(o.x - a.x, o.y - a.y) < PLAY_FAR_R) {   // 被追：對方靠近就往反方向逃（對方還遠就照常散步）
      const d = Math.hypot((a.target?.x ?? -1e9) - a.x, (a.target?.y ?? -1e9) - a.y);
      if (!a.target || d < 28) a.target = fleeTarget(a, def, o.x, o.y, 150);
    }
    return;
  }
  if (a.startle || a.idle > 0 || Math.random() >= dt * .12) return;   // 平均約 8 秒起一次玩心；嚇到／歇著不約
  const mates = S.mobs.filter(m => m !== a && !m.dead && !m.play && !m.startle && Math.hypot(m.x - a.x, m.y - a.y) < PLAY_JOIN_R);
  if (!mates.length) return;
  const o = mates[Math.floor(Math.random() * mates.length)];   // 對象隨機：誰追誰不一定
  const until = S.t + 3 + Math.random() * 4;
  a.play = { o, role: 'chase', until }; o.play = { o: a, role: 'flee', until };
  a.idle = 0; o.idle = 0;
}

function petPlayEnd(a) {   // 散場：把對方也放掉（對方若正在跟別的玩，代表已被接手，不動）
  const o = a.play?.o; a.play = null;
  if (o?.play?.o === a) o.play = null;
}

function rebuildOcc() {
  S.occ.clear();
  S.furnItems.forEach((it, idx) => {
    const def = S.furn.items.find(f => f.id === it.type);
    if (!def || !Array.isArray(it.cell)) return;   // manifest 沒有的種類／壞格子：略過（本地舊存檔可能有，別讓 boot 當掉）
    const fd = furnDimsOf(def, it.dir || 0);
    for (let dy = 0; dy < fd.h; dy++) for (let dx = 0; dx < fd.w; dx++)
      S.occ.set(key(it.cell[0] + dx, it.cell[1] + dy), idx);
  });
}

function furnitureDef(id) { return S.furn.items.find(f => f.id ===id); }
// 家具佔的格數：rotSwap 的家具（床，2026-11-25）朝左／右（dir 1／3）時寬高互換（左上角不動）；與兩份伺服器（Worker 的 furnDim、dev_server.py 的 furn_dims）一致
const furnDimsOf = (def, dir) => (def?.rotSwap && (dir === 1 || dir === 3)) ? { w: def.h, h: def.w } : { w: def?.w || 1, h: def?.h || 1 };
const itemDims = it => furnDimsOf(furnitureDef(it.type), it.dir || 0);

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
  cv.src = key;   // 換過色的畫布再被換色（新風格同一層依序多條規則）時，recolorCache 的 key 才不會撞
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
// sheet 的某一格裡最下面一排有不透明像素的排號（0～h-1）；整格空的回 -1（結果依 (圖, 格子) 快取）。帽子用：帽沿最低的那排以上的頭髮不畫
const cellBottomCache = new Map();
function cellBottomRow(img, sx, sy, w, h) {
  if (!img || sx + w > img.width || sy + h > img.height) return -1;
  const k = img.src + '|' + sx + ',' + sy;
  let v = cellBottomCache.get(k);
  if (v === undefined) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    v = -1;
    for (let y = h - 1; y >= 0 && v < 0; y--) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { v = y; break; }
    cellBottomCache.set(k, v);
  }
  return v;
}
// 新風格人物（2026-11-21，使用者定案整套換成自製 Q 版像素風格；階段 1）：種族的 own.sheets＝8 個圖層（跟 LPC 同格式的 sheet，只填走路列），
// 由下往上疊；**描邊不在圖層裡**，合成後整個人統一畫一圈 own.outline 色的外框（每層各自描邊，層與層之間會多出不該有的線）。
// 沒有這一格（攻擊、釣魚、坐姿以外的動作）就用 map 條目的退回幀（待機）。武器、服裝選項、換色都還沒做（之後階段）。
// 新風格（整套自製圖層）的種族定義；不是新風格回 null。掛點（背／腰／手）因為身形不同，用 own.anchors 覆寫（依面向 down／up／side 各給一組）
const ownRaceOf = id => { const rs = S.avatar?.races, r = (id && rs?.find(r => r.id === id)) || rs?.[0]; return r?.own ? r : null; };   // 舊種族（human／elf／cat／lalafell／giant／chibi）已刪除：找不到的 id 一律當第一個種族（人類）
const CHIBI_ORDER = ['body', 'bottom', 'shoes', 'top', 'hairbg', 'face', 'hair', 'hat'];
// 新風格的換色：own.dye＝[{slot, layers, colors}]（slot 對應 look 的 hair／top／bottom／shoe／hat 的色碼；colors 第一個是主色，其餘依明暗比例跟著變，見 dyeSheet）
const CHIBI_DYE_FIELD = { hair: 'hairC', top: 'topC', bottom: 'botC', shoe: 'shoeC', hat: 'hatC', eye: 'eyeC' };   // eye＝眼睛顏色（外貌頁的眼睛換色鈕，存在 S.me.eyeC）
// 款式：own.styles.hair／top＝[{id, name, sheets:{圖層: 檔名}}]（第一個是預設，sheets 空＝用基本圖層）；look.hair／look.top 是款式 id 才算，否則用預設
const chibiStyleOf = (own, kind, id) => (own.styles?.[kind] || []).find(x => x.id === id) || own.styles?.[kind]?.[0] || null;
function chibiSprite(race, look, fi, sleep) {   // sleep：睡姿用——body 換成 bodyz（閉眼的頭）、不畫 face（睡在床上時用，見 drawSleeper）
  const fs = chibiStyleOf(race.own, 'face', look?.face), hs = chibiStyleOf(race.own, 'hair', look?.hair), ts = chibiStyleOf(race.own, 'top', look?.top),
        bs = chibiStyleOf(race.own, 'bottom', look?.bottom), ss = chibiStyleOf(race.own, 'shoe', look?.shoe),
        hts = race.own.styles?.hat?.find(x => x.id === look?.hat) || null;   // 帽子款式：只有套裝附的帽子（沒找到＝沒戴帽子；不像髮型／服裝會退回第一個）   // 服裝款式：上衣／褲子／鞋子各一個（look.top／bottom／shoe 是外觀 id，款式 id 跟外觀 id 一樣）
  const skinHex = S.avatar.skins?.find(s2 => s2.id === look?.skin)?.base || null;   // 膚色：look.skin 是 avatar.json skins 的 id，換成它的 base 色碼
  const rules = (race.own.dye || []).filter(r => !r.style || r.style === ts?.id || r.style === bs?.id || r.style === ss?.id || r.style === hts?.id).map(r => ({ ...r, hex: (r.slot === 'skin' ? (skinHex && skinHex.toLowerCase() !== r.colors[0].toLowerCase() ? skinHex : null) : look?.[CHIBI_DYE_FIELD[r.slot]]) || null }));   // 膚色跟原色一樣（預設的「自然」）就不換
  sleep = !!(sleep && race.own.sheets.bodyz);
  const k = (sleep ? 'chibiz:' : 'chibi:') + race.id + ':' + fi + '|' + (hs?.id || '') + '|' + (ts?.id || '') + '|' + (bs?.id || '') + '|' + (ss?.id || '') + '|' + (fs?.id || '') + '|' + (hts?.id || '') + '|' + rules.map(r => r.hex || '').join(',');
  let cv = S.charCache.get(k);
  if (cv) return cv;
  const F = S.avatar.frames, own = race.own;
  const cw = own.cell || F.w, ch = own.cell || F.h;   // 種族自己的格子大小（新巨人 96×96；預設跟 frames 一樣）。邏輯格（F.w×F.h）放在格子的 (ox, oy)，畫的時候 pad／padTop 補回去
  let ent = F.map ? F.map[fi] : [fi, 0];
  const body = S.charImgs[own.sheets.body];
  if (ent?.[2] != null && !sheetCellHas(body, ent[0] * cw, ent[1] * ch, cw, ch)) ent = F.map[ent[2]];
  const [cc, cr] = ent, sx = cc * cw, sy = cr * ch, idleSx = ent[3] != null ? ent[3] * cw : sx;   // ent[3]：這一幀只有腿層（body／bottom／shoes）用 ent[0] 那一欄、其他層用 ent[3] 欄（側面坐姿，見 tools/gen_sit.py）
  cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; cv.pad = own.ox || 0; cv.padTop = own.oy || 0; cv.layerMiss = false;
  const g = cv.getContext('2d');
  // 戴帽子：帽沿最低的那排（這一幀的 hat 圖）以上的頭髮不畫（hairFromHat；帽子蓋住的部分），以下的頭髮照畫（帽沿下面露出來的髮尾、瀏海）
  const hatBottom = hts?.hairFromHat ? cellBottomRow(S.charImgs[hts.sheets?.hat], idleSx, sy, cw, ch) : -1;
  for (const n of CHIBI_ORDER) {
    if (sleep && n === 'face') continue;   // 睡覺閉眼：眼睛已經畫在 bodyz 裡
    const ln = sleep && n === 'body' ? 'bodyz' : n;
    if (n === 'hair' && hts?.hideHair) continue;   // 頭盔（hideHair）：完全不顯示頭髮
    if (n === 'hat' && hts && !hts.hideHair) {   // 戴帽子：種族自己的 hat 層（妖精／貓族的耳朵）先畫，帽子再蓋上去（頭盔連耳朵一起蓋住，不畫）
      const ear = S.charImgs[own.sheets.hat];
      if (ear && idleSx + cw <= ear.width && sy + ch <= ear.height) {   // 帽沿以上的耳朵（貓耳）被帽子蓋住不畫，帽沿以下的（妖精的尖耳）照畫
        const cut = Math.max(0, Math.min(ch, hatBottom + 1 + (hts.hairCutDyByRow?.[cr] ?? hts.hairCutDy ?? 0)));
        g.drawImage(ear, idleSx, sy + cut, cw, ch - cut, 0, cut, cw, ch - cut);
      }
    }
    let img = S.charImgs[hts?.sheets?.[n] || hs?.sheets?.[n] || ts?.sheets?.[n] || bs?.sheets?.[n] || ss?.sheets?.[n] || fs?.sheets?.[n] || own.sheets[ln]];
    const lsx = (n === 'body' || n === 'bottom' || n === 'shoes') ? sx : idleSx;
    if (!img || lsx + cw > img.width || sy + ch > img.height) continue;
    for (const r of rules) if (r.hex && r.layers.includes(ln)) img = dyeSheet(img, r.colors, r.hex);   // 同一張圖可以被多條規則依序換色（例如 bottom 層：圍裙下擺跟上衣、褲子跟褲子）
    if (n === 'hair' && hatBottom >= 0) {
      const cut = Math.max(0, Math.min(ch, hatBottom + 1 + (hts.hairCutDyByRow?.[cr] ?? hts.hairCutDy ?? 0)));   // hairCutDyByRow＝某一列（方向）另外指定的切線位移（賢者貝雷帽正面有垂尾，帽子最低排比背面低很多，要另外拉回跟背面同高）
      g.drawImage(img, lsx, sy + cut, cw, ch - cut, 0, cut, cw, ch - cut);
      continue;
    }
    g.drawImage(img, lsx, sy, cw, ch, 0, 0, cw, ch);
    for (const st of [ts, bs, ss]) {   // 款式帶遮罩（erase）：這一層畫完後把遮罩蓋住的像素擦掉（男式外套／褲子要擦掉身體層自己的手／腿）
      const mk = st?.erase?.[n] && S.charImgs[st.erase[n]];
      if (mk) { g.globalCompositeOperation = 'destination-out'; g.drawImage(mk, sx, sy, cw, ch, 0, 0, cw, ch); g.globalCompositeOperation = 'source-over'; }
    }
  }
  if (own.outline) outlineCanvas(cv, own.outline);   // 外框已經畫在圖層裡的種族（新人類）不設 outline，不再統一畫一圈
  S.charCache.set(k, cv);
  return cv;
}
function outlineCanvas(cv, color) {   // 貼著透明、上下左右有不透明像素的透明格，畫成 color（#rrggbb）
  const w = cv.width, h = cv.height, g = cv.getContext('2d'), id = g.getImageData(0, 0, w, h), d = id.data;
  const r = parseInt(color.slice(1, 3), 16), gg = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16), mark = [];
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) mark.push((y * w + x) * 4);
  for (const i of mark) { d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255; }
  g.putImageData(id, 0, 0);
}
function charSprite(look, fi, sleep) {
  const race = lookItem(S.avatar.races, look.race) || S.avatar.races?.[0];   // 舊種族已刪除（2026-11-23）：找不到的 id 退回第一個種族；整套自製圖層，不吃舊的髮型／服裝清單
  return chibiSprite(race, look, fi, sleep);
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
// 這個人現在的造型有沒有完整的 LPC sit 圖（素體、臉、眼、髮、服裝、帽子每一層都有）：有就回 sit 幀清單，沒有回 null（改用沉進椅子的舊畫法）
function sitReal(p) {
  const st = S.avatar.frames.states, sl = st[`sit_${d8Of(p)}`];
  if (!sl) return null;
  const im = playerSpriteDiv(p, sl[0]);
  return im && !im.layerMiss ? sl : null;
}
// 坐著釣魚（2026-11-15，使用者要求：下半身坐姿、上半身釣魚姿勢）：釣竿那一層沒有 sit 幀，所以把人畫兩次——腰線以下用「不帶釣竿」的 LPC sit 幀、
// 腰線以上用釣魚的站姿幀（帶釣竿）往下挪 SIT_FISH_DY。回 { sl, img }（sit 幀清單與那一幀的圖），造型缺 sit 圖層就回 null（退回舊畫法）
const SIT_FISH_DY = 7, SIT_FISH_WAIST = 22;   // 單位：底圖像素（腰線＝腳底往上 22；上半身下挪 7，大約是 sit 幀軀幹比站姿低的量）
function sitFishBody(p) {
  if (p.pose !== 'sit' || !p.fish || p.npc) return null;
  const sl = S.avatar.frames.states[`sit_${d8Of(p)}`]; if (!sl) return null;
  const look = p.look || myLook(), img = charSprite(look, sl[2]);
  return img && !img.layerMiss ? { sl, img } : null;
}
function charFrame(p) {
  const F = S.avatar.frames, st = F.states;
  if (p.pose === 'sit' && !p.fish) {   // LPC 的 sit 動作（2026-11-15）：所有圖層都有 sit 圖才用（sitReal），固定第 3 幀（雙腳踩地）
    const sl = sitReal(p);
    if (sl) return { fi: sl[2], mirror: false };   // 固定第 3 幀＝雙腳都踩在地上的坐姿（使用者 2026-11-15：不要一直動、要兩腳放地上那個；第 1、2 幀是盤腿／換腿的動作）
  }
  if (p.pose && !(p.pose === 'sit' && p.fish)) {
    const d = p.pose === 'sit' ? d8Of(p) : 'down';   // 坐姿面向椅子的朝向（朝下用 sit 幀；其他方向用該方向的待機幀）
    if (d === 'down' || d.startsWith('down')) return { fi: (st.sit || st.down_idle)[0], mirror: false };
    let l = st[`${d}_idle`], m = false;
    if (!l && CHAR_MIRROR[d]) { l = st[`${CHAR_MIRROR[d]}_idle`]; m = !!l; }
    return l ? { fi: l[0], mirror: m } : { fi: (st.sit || st.down_idle)[0], mirror: false };
  }   // 坐著釣魚時照常播釣魚動作的幀（「坐姿」本來就只是站姿待機幀、人被椅子擋住下半身）
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
    let pos = d.pos ? [d.pos[0] * CELL + CELL / 2, d.pos[1] * CELL + CELL / 2] : null;   // pos＝指定的格子座標（和平島的嚮導）
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
    p.fixed = !!d.fixed;                      // fixed：站著不動（2026-11-14 和平島的嚮導）
    p.lines = d.lines; p.guide = !!d.guide; p.idle = Math.random() * 2;
    out.push(p);
  }
  S.players = [S.players[0], ...out];
}

function playerSpriteDiv(p, fi, sleep) {
  // NPC 與遠端玩家都有自己的 look；自己（players[0]）則用當前職業的裝備＋外觀（myLook）。
  // LPC 武器（avatar.json 武器條目有 lpc）是人物的一層：帶 wpn（武器 id）給 charSprite 一起合成
  if (p.npc) return charSprite(p.look || myLook(), fi, sleep);
  const me = p === S.players[0], look = p.look || myLook();
  let wd = me ? (p.tool ? null : lpcWeaponFor(S.me.weapon, look.wlook, look.race)) : lpcWeaponFor(p.weapon, look.wlook, look.race);
  if (wd?.lpc.fishOnly && !p.fish) wd = null;
  if (p.pose === 'sit' && !p.fish) wd = null;   // 坐著不拿武器（LPC 武器圖層沒有 sit 幀，會害整個造型退回舊畫法）   // LPC 釣竿只在釣魚時畫（四方向的拋竿／持竿／收線動作），平常照舊背著小圖
  return charSprite(wd ? { ...look, wpn: wd.id } : look, fi, sleep);
}
// 拿著的武器有沒有 LPC 圖層：有就回該武器條目（武器外觀有 LPC 圖就用外觀的，外觀沒有 LPC 圖就退回舊的小圖畫法）
function lpcWeaponFor(wid, wlook, raceId) {
  const ws = S.avatar?.weapons; if (!ws || !wid) return null;
  if (ownRaceOf(raceId)) return null;   // 新風格人物：LPC 武器圖層是照 LPC 身形畫的，不能用；改畫小圖武器（掛背上／腰間、揮擊、詠唱舉杖）
  const base = ws.find(w => w.id === wid);
  if (wlook && wlook !== wid) {
    const g = ws.find(w => w.id === wlook);
    if (g?.glam && base && g.type === base.type) return g.lpc ? g : null;
  }
  return base?.lpc ? base : null;
}
// 武器的圖：拿著職業武器且有選同類型的武器外觀（glam）時畫外觀的圖；玩法（射程、詠唱等）照拿著的武器
function weaponImgFor(wid, wlook, raceId) {
  if (!wid || wid === 'hands') return null;
  if (lpcWeaponFor(wid, wlook, raceId) && !lpcWeaponFor(wid, wlook, raceId).lpc.fishOnly) return null;   // LPC 武器畫在人物圖層裡（charSprite），不另外畫小圖（釣竿例外：沒在釣魚時背小圖）
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
    else {
      p.moving = false; p.frame = 0; p.z = 0; p.vz = 0;
      if (p.pose === 'sit') seatFace(p, seatItem(p).dir || 0);   // 椅子被轉了方向：人跟著轉
      if (p.fish) {   // 坐著釣魚（2026-11-14 使用者要求）：等魚／上鉤／拉竿照常推進；換掉釣竿、進裝飾模式、被石化就收竿
        if (S.mode !== 'walk' || S.t < (p.petUntil ?? 0) || (p === S.players[0] && !isRod())) stopFishing(p);
        stepFishing(p, dt);
      }
      return;
    }
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
  } else if (p.fish?.mg && (S.mode !== 'walk' || !isRod() || pet)) stopFishing(p);   // 拉扯小遊戲很長（不像原本只有 1 秒），中途也要能被打斷
  stepFishing(p, dt);
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
  if (p.fixed) { p.moving = false; p.frame = 0; if (p.idle > 0) p.idle -= dt; return; }   // 固定不動的 NPC（說話時仍會轉向玩家，見 talkTo）
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
  if (has('seal')) {   // 忍術結印：頭旁依序浮出三個梵文種子字（見 SEAL_BIJA）
    const own = p === S.players[0] && S.fx.seal, q = own ? Math.min(.999, (t - S.fx.seal.t0) / JOB_SKILLS.ninjutsu.cast) : (t * .67) % 1;
    const k = Math.floor(q * 3);
    for (let i = 0; i <= k; i++) drawSealGlyph(dir * 22, -44 + (i - k) * 3, i, i === k ? (q * 3) % 1 : 1);
  }
}
const SEAL_BIJA = ['ॐ', 'ह्रीं', 'हूँ'];   // 忍術結印的三個梵文種子字（唵、赫利、吽；2026-11-14 使用者要求改用梵文，原本是自創的方／叉／三角）；圖檔 assets/skills/seal_glyphs.png 由 gen_assets.py 的 SEAL_GLYPHS 產生，缺圖才退回系統字型
function drawSealGlyph(x, y, kind, a) {   // 結印時頭旁依序浮出的梵文種子字
  ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.globalAlpha = Math.min(1, a * 2);
  const im = S.sealImg;
  if (im) ctx.drawImage(im, kind * 18, 0, 18, 18, -9, -10, 18, 18);
  else {
    ctx.font = 'bold 15px "Nirmala UI","Noto Sans Devanagari","Kohinoor Devanagari","Mangal",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffb0b0';
    ctx.fillText(SEAL_BIJA[kind] || SEAL_BIJA[0], 0, 1, 20);
  }
  ctx.restore();
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
  if (wid !== 'tome' || p.dead || p.pose === 'sit' || p.pose === 'sleep') return;   // 坐下／睡覺時收起（賢具是賢者的武器，跟其他職業的武器一樣不拿出來）
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
  const L = { jumpboom: .5, arrow: .2, song: .7, poisonpop: .6, heart: .6, sheal: .5, smoke: .5, after: .6, boom: .6, firebomb: .7, kshield: .6, wshield: .6, pop: .6, shout: .5, crack: .8, fog: .8, drain: .4, funnels: .45, carego: .7, healgo: .65 }[f.fxk] || .5;
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
      const im = charSprite(myLook(), fi), pd = im.pad || 0, pt = im.padTop ?? pd;
      ctx.drawImage(im, f.x - (F.w / 2 + pd) * cs, f.y - (F.h + pt - (F.footDy || 0)) * cs, im.width * cs, im.height * cs);
      break;
    }
    case 'firebomb': {   // 火遁：前 30% 火球飛向落點，之後橘紅色火焰爆開（範圍圈＋往上竄的火舌）
      if (q < .3) {
        const k = q / .3, x = f.x1 + (f.x - f.x1) * k, y = f.y1 + (f.ty - f.y1) * k;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, 12);
        gr.addColorStop(0, 'rgba(255,250,200,.95)'); gr.addColorStop(.5, 'rgba(255,140,40,.85)'); gr.addColorStop(1, 'rgba(220,40,20,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
        break;
      }
      const e = (q - .3) / .7, ea = 1 - e;
      ctx.save(); ctx.translate(f.x, f.y); ctx.scale(1, .5);
      ctx.fillStyle = `rgba(255,120,30,${.25 * ea})`; ctx.beginPath(); ctx.arc(0, 0, f.r * (.5 + .5 * Math.min(1, e * 2.5)), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,170,60,${ea})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, f.r * (.5 + .5 * Math.min(1, e * 2.5)), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      for (let i = 0; i < 12; i++) {
        const an = i * Math.PI * 2 / 12 + i * .7, rr = f.r * .75 * Math.min(1, e * 2) * (.4 + (i % 3) * .3), h = 8 + e * 26 + (i % 4) * 4;
        const x = f.x + Math.cos(an) * rr, y = f.y + Math.sin(an) * rr * .5 - e * 14;
        ctx.fillStyle = i % 2 ? `rgba(255,200,70,${.8 * ea})` : `rgba(240,70,30,${.8 * ea})`;
        ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.quadraticCurveTo(x - 4, y - h * .6, x, y - h); ctx.quadraticCurveTo(x + 4, y - h * .6, x + 5, y); ctx.closePath(); ctx.fill();
      }
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

// 找 p 坐／躺的那件家具：本機玩家有 p.seat（含格子）；遠端玩家只有 seatType，用腳下位置反推格子（坐＝家具底邊 −2、躺＝底邊）
function seatItemOf(p) {
  if (p.seat?.cell) return seatItem(p);
  const def = p.seatType && furnitureDef(p.seatType); if (!def) return null;
  // 別人的座標是平滑追過去的（永遠差一點點）：坐下的 y 剛好落在格線上（椅子 y＋h 格底邊 −2px），floor 會在「差一點」時算到上面那一格、找不到椅子，
  // 整個人就沒有椅背遮擋／沉進椅子的處理（機率性穿模、跟自己看到的不一樣）→ 改四捨五入到最近的格線
  const cx = Math.floor(p.x / CELL), by = Math.round((p.y + (p.pose === 'sit' ? 2 : 0)) / CELL);
  return S.furnItems.find(o => o.type === p.seatType && (furnCovers(o, [cx, by - def.h]) || (def.rotSwap && furnCovers(o, [cx, by - def.w])))) || null;   // 床橫放時 h 是 w（不知道遠端的床朝哪，兩種都試）
}
// 坐姿（2026-11-15，使用者要求改善）：LPC 素材沒有坐姿幀，所以讓人「陷進椅子」——往下沉 seat.drop px，從椅面前緣（背面時是椅背頂）那一列以下的部分裁掉，
// 再把家具那一截重畫在人身上，看起來就是坐在椅子裡（腿被椅面擋住）。seat 參數在 furniture.json（gen_assets.py 的 FURN_SEATS 算出來）
function drawPerson(p, wi, nameColor) {
  const it = p.pose === 'sit' ? seatItemOf(p) : null, def = it && furnitureDef(it.type), im = it && furnImg(it.type, it.dir);
  const sitOk = !!(it && (sitReal(p) || sitFishBody(p)));
  if (!it || !def?.seat || !im || sitOk) {   // 沒有座位資料，或有真的 LPC sit 幀就直接畫
    p.seatDrop = 0; drawPersonBase(p, wi, nameColor);
    if (it && def?.seat && im && (it.dir || 0) === 2 && sitOk) {   // 椅子朝上（背對畫面）：椅背在人前面，把椅背那一截重畫在人身上（不然人整個壓在椅背上，只剩一團頭髮）
      const rows = im.height - def.seat.back, sc = S.furn.scale || 2, bottom = (it.cell[1] + def.h) * CELL;
      ctx.drawImage(im.img, 0, def.seat.back, im.fw, rows, it.cell[0] * CELL, bottom - rows * sc, im.width * sc, rows * sc);
    }
    return;
  }
  p.seatDrop = def.seat.drop;
  const from = (it.dir || 0) === 2 ? def.seat.back : def.seat.front, rows = im.height - from;
  const sc = S.furn.scale || 2, bottom = (it.cell[1] + def.h) * CELL, cutY = bottom - rows * sc;
  ctx.save();
  ctx.beginPath(); ctx.rect(p.x - 80, p.y - 320, 160, cutY - (p.y - 320)); ctx.clip();   // 只畫裁切線以上
  ctx.translate(0, def.seat.drop);
  drawPersonBase(p, wi, nameColor);
  ctx.restore();
  ctx.drawImage(im.img, 0, from, im.fw, rows, it.cell[0] * CELL, bottom - rows * sc, im.width * sc, rows * sc);   // 前景：椅面前緣（或椅背）蓋在人身上
}
const SIT_BACK_SHIFT = { human2: 2, elf2: 2, cat2: 2, dwarf2: 4, giant2: 1 };   // 側面坐姿往椅背挪幾格（1 格＝2px）
function drawPersonBase(p, wi, nameColor) {
  const pose = p.pose === 'sit' || p.pose === 'sleep' ? p.pose : null;
  const race = ownRaceOf(p === S.players[0] ? S.me.race : p.look?.race)?.id || 'human2';
  const ffx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);   // 吃喝的效果（巨大化／縮小／透明／暈眩／中毒）
  const raceDef = S.avatar.races?.find(r => r.id === race);
  const raceScale = (raceDef?.scale || 1) * foodScaleOf(ffx);   // 種族倍率：拉拉肥 0.5／巨人 1.5（整個模組一起縮）；吃喝的巨大化／縮小再乘上去
  let nameY = p.y - p.z - Math.round((raceDef?.nameH || 52) * raceScale);   // 名牌跟著身高（種族倍率）移；種族可以用 nameH 指定名牌離腳底多高（新人類系列頭頂有耳朵，要再高一點）
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
    const ownA = ownRaceOf(race)?.own.anchors;
    if (ownA) {   // 新風格：掛點照新身形（每個值可以是 [x,y]，或依面向分 down／up／side 的物件）
      const dd = d8Of(p), fk = dd.startsWith('up') ? 'up' : dd.startsWith('down') && dd !== 'down_left' && dd !== 'down_right' ? 'down' : 'side';
      for (const [kind, a0] of Object.entries(ownA)) {
        const a = Array.isArray(a0) ? a0 : (a0[fk] || a0.down);
        charAnch[kind] = [(a[0] - F.w / 2) * (F.scale || 2), (a[1] - F.h + (F.footDy || 0)) * (F.scale || 2)];
      }
    }
    const pet = S.t < (p.petUntil ?? 0);   // 石化：身體灰階（自己的石化即時同步；遠端玩家的石化由光束事件就地推斷，純演出）
    if (pet) { ctx.save(); ctx.filter = 'grayscale(1) brightness(.92)'; }
    const ghost = ffx?.includes('fghost');   // 吃喝的透明化：整個人半透明
    if (ghost) ctx.globalAlpha = .35;
    p.rodJit = p.fish?.ph === 'reel' && rodFrameNow(p) != null ? Math.round(Math.sin(S.t * 30)) : 0;   // 拉竿：竿子往後拉住、整個人左右抖 1px（原本拉竿時竿尖抖動的感覺）
    // 側面坐姿（sit_left／sit_right）：整個人往椅背方向挪（使用者微調 2026-11-25，單位＝2px 一格）：人類／妖精／貓族 2 格、矮人 4 格、巨人 1；朝左的人往左、朝右的人往右（往面向的方向挪；使用者說第一版往椅背挪「反了」）
    const sitD8 = d8Of(p), sitDx = pose === 'sit' && !p.fish && (sitD8 === 'left' || sitD8 === 'right') && sitReal(p) ? (SIT_BACK_SHIFT[race] ?? 2) * 2 * (sitD8 === 'left' ? -1 : 1) : 0;   // 只有側面（朝左／朝右）；正面、背面不挪（原本也被套到，偏了 4px）
    ctx.save(); ctx.translate(p.x + p.rodJit + sitDx, p.y - p.z);
    // 武器（背在背上／掛在腰間；揮擊時畫在身前）；坐著時不拿；釣魚時釣竿拋向前方
    const fish = wi && (!pose || (pose === 'sit' && p.fish)) && p.fish ? p.fish : null;
    const carry = wi && !pose && !fish && !(p.swing > 0) && !p.cast;   // 不拿在手上（詠唱中高舉法杖）
    const backView = d8Of(p).startsWith('up');                // 背面（往上、斜上）：背著的武器疊在身體上面，其餘方向被身體擋住
    // 掛著的武器畫在左右翻轉之外：固定在同一側，人物轉向時不會跟著換邊
    carryFaceLeft = face4(p) === 'left';   // 背著的武器在背後那側：朝左走時背在右邊（左右鏡射）
    carrySideNow = !backView && ['left', 'right'].includes(face4(p));   // 朝左右走：掛著的武器畫側面版（sideSprite）；背對時畫背面版（rearSprite）
    carryBackNow = backView;
    const drawCarry = (onBack, layer) => wi.carry === 'hips' ? drawWeaponHips(wi, layer) : wi.carry === 'waist' ? drawWeaponWaist(wi) : drawWeaponBack(wi, onBack);
    const frontCarry = wi && (wi.carry === 'waist' || wi.carry === 'hips');   // 掛在腰間的（2026-11-27 使用者要求：劍／短刀掛在腰間看得到）：所有方向都畫在身體前面；背著的才分背面／其他
    // 腰間的劍固定掛在畫面左邊：朝右走時它在身體另一側（最下層）、朝左走時在身體這一側（最上層）；忍者的短刀側面時一把在最下層、一把在最上層
    const waistUnder = frontCarry && carrySideNow && wi.carry === 'waist' && !carryFaceLeft, hipsSide = frontCarry && carrySideNow && wi.carry === 'hips';
    if (carry && !backView && !frontCarry) drawCarry(false);
    if (carry && (waistUnder || hipsSide)) drawCarry(false, 'under');
    const pfx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);   // 技能效果（自己看本地狀態，別人看 state 同步的 fx）
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'back');
    const swingV = wi && !pose && !fish && p.swing > 0 ? face4(p) : null;   // 小圖武器（wi；LPC 武器畫在人物圖層裡、wi 是 null）往上／往下揮
    if (swingV === 'up') drawWeaponSwing(wi, p.swing, 1, 'up');   // 往上揮：武器在身體後面
    ctx.save();
    if (cf.mirror) ctx.scale(-1, 1);
    const cs = (F.scale || 2) * raceScale;   // 錨點＝腳底中央；放大＝frames.scale × 種族倍率
    const pad = img.pad || 0, padTop = img.padTop ?? pad;   // 超大格（LPC 武器揮砍）：畫布四周多出 pad，人物仍以腳底中央對齊；padTop＝上方多出的（新巨人的格子只往上、左右加大，下面沒有）
    // footDy：LPC 的腳底在格子第 60～62 列，不往下挪的話腳和影子之間有空隙（看起來像飄在空中）
    const hyb = sitFishBody(p);
    if (hyb) {   // 坐著釣魚：下半身＝sit 幀（不帶竿），上半身＝釣魚幀往下挪
      const wy = -SIT_FISH_WAIST * cs, dy = SIT_FISH_DY * cs, x0 = (-F.w / 2 - pad) * cs, y0 = (-F.h - padTop + (F.footDy || 0)) * cs;
      ctx.save(); ctx.beginPath(); ctx.rect(-300, wy, 600, 300); ctx.clip();
      ctx.drawImage(hyb.img, (-F.w / 2) * cs, (-F.h + (F.footDy || 0)) * cs, hyb.img.width * cs, hyb.img.height * cs);
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(-300, -400, 600, 400 + wy); ctx.clip();
      ctx.drawImage(img, x0, y0 + dy, img.width * cs, img.height * cs);
      ctx.restore();
    } else
    ctx.drawImage(img, (-F.w / 2 - pad) * cs, (-F.h - padTop + (F.footDy || 0)) * cs, img.width * cs, img.height * cs);
    ctx.restore();
    if (carry && (backView || frontCarry) && !waistUnder) drawCarry(true, 'over');
    if (pfx?.length) drawPersonFx(p, pfx, backView, 'front');
    if (swingV === 'down') drawWeaponSwing(wi, p.swing, 1, 'down');   // 往下揮：武器在身前
    if (p.dir < 0) ctx.scale(-1, 1);                          // 揮擊、拋竿朝面向那側（要翻轉）
    if (wi && !pose && !fish && p.swing > 0 && swingV !== 'up' && swingV !== 'down') drawWeaponSwing(wi, p.swing, p.dir < 0 ? -1 : 1);
    const rodTip = fish ? lpcRodTip(p, cf, cs, img.pad || 0) : null;   // LPC 釣竿：竿尖的世界座標（畫在人物圖層裡，不畫舊小圖）
    if (rodTip && hyb) rodTip.y += SIT_FISH_DY * cs;   // 坐著釣魚：上半身下挪了，竿尖跟著下挪
    if (fish && !rodTip) drawRodCast(wi, rodAngle(fish));
    if (wi && !pose && !fish && p.cast) drawStaffRaise(wi, Math.min(1, (S.t - p.cast.t0) / p.cast.dur));
    ctx.restore();
    if (pet) ctx.restore();
    if (ghost) ctx.globalAlpha = 1;
    if (ffx?.length) drawFoodOverhead(p, ffx, nameY);   // 暈眩的星星、中毒的泡泡
    if (fish) drawLineAndBobber(p, wi, fish, rodTip);
    if (pose && !(pose === 'sit' && !p.fish && sitReal(p))) nameY = p.y - 46 - (p.seatDrop || 0);   // 坐姿整個人下沉時名牌不跟著下沉；有真的側面坐姿幀（頭沒有下沉）就維持站姿的名牌高度（巨人的頭比較高，不然名字會蓋住臉）
  }
  if (p.pose === 'sleep') {   // 睡在床上：名牌移到床頭上方（不蓋在人臉上）
    const sit = seatItemOf(p), sim = sit && furnImg(sit.type, sit.dir);
    if (sim) nameY = p.y - sim.height * (S.furn.scale || 2) - 6;
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
  if (p.emote && S.t < p.emote.until && emoteDraw(p.x, headY - 14, p.emote)) { /* 表情符號：頭上冒出（優先於說話泡泡） */ }
  else if (p.say && S.t < p.say.until) drawBubble(p.x, headY - 14, p.say.text, Math.min(1, (p.say.until - S.t) / .4));
  else if (p.fish?.ph === 'bite') {   // 魚上鉤：頭上跳動的「!」（同地形的人也看得到）
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
    const yy = headY - 14 - Math.abs(Math.sin(S.t * 10)) * 4;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.9)'; ctx.fillStyle = '#ffd84a';
    const tier = tugTier(p.fish);   // 罕見「!!」、稀有「!!!」（顏色也不同）
    if (tier) ctx.fillStyle = tier.color;
    ctx.strokeText(tier?.mark || '!', p.x, yy); ctx.fillText(tier?.mark || '!', p.x, yy);
  } else if (p.fish?.mg) drawTug(p, p.fish.mg, headY);
  else if (p.guide) {   // 嚮導頭上有個會晃動的「？」，提示可以問他
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
// 某種族某一幀的「臉」（face 圖層的不透明像素）在幀畫布座標的外框：{cx, cy, w}；沒有就回 null（結果快取）。睡覺用它把各種族的臉對到同一個位置、同一個大小
const faceBoxCache = new Map();
function faceBoxOf(raceId, fi) {
  const k = raceId + ':' + fi;
  if (faceBoxCache.has(k)) return faceBoxCache.get(k);
  let out = null;
  const own = ownRaceOf(raceId)?.own, F = S.avatar.frames, img = own && S.charImgs[own.sheets.face], ent = F.map?.[fi];
  if (img && ent) {
    const cw = own.cell || F.w, ch = own.cell || F.h, cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d'); g.drawImage(img, ent[0] * cw, ent[1] * ch, cw, ch, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data;
    let x0 = cw, x1 = -1, y0 = ch, y1 = -1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (d[(y * cw + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 >= 0) out = { cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, w: x1 - x0 + 1 };
  }
  faceBoxCache.set(k, out);
  return out;
}
// 睡覺：只畫頭與肩膀躺在枕頭上，再把棉被蓋回去（p.x＝床的水平中心、p.y＝床的底邊）。床直放（朝下，1×2）：頭在上端的枕頭、被子從 quiltRow 蓋到床尾；橫放（朝左／右，2×1）：拿側面的頭與肩膀轉 90 度靠床頭端，臉朝上
// 取框以「臉」為準（2026-11-25）：以人類幀的框（x 16..48、y 0..39，臉在其中）為標準，其他種族依 face 圖層的臉心與臉寬換算成各自幀畫布的框，所以矮人／巨人的臉跟人類一樣大、在同一個位置
function drawSleeper(p) {
  const F = S.avatar.frames, frontFi = (F.states.down_idle || [0])[0], img = playerSpriteDiv(p, frontFi, true);   // 用正面待機的第 1 幀（閉眼的頭）切出頭與肩膀
  const it = seatItemOf(p), sdir = it?.dir || 0;
  const race = ownRaceOf(p === S.players[0] ? S.me.race : p.look?.race)?.id || 'human2', ffx = p.npc ? null : (p === S.players[0] ? myFx() : p.fx);
  const k = Math.min(1.2, foodScaleOf(ffx));   // 畫在床上的倍率：吃喝的巨大化／縮小有效，種族體型不算（臉要一樣大）；躺著的頭 1 倍（0.75 倍時最近鄰會把 1 像素粗的閉眼線抽掉）
  if (sdir === 2) { drawZzz(p); return; }   // 背面（從床頭看）：人在床頭板後面，只留 Zzz
  const RX = 16, RW = 32, RH = 39;                 // 人類幀的取框（寬 32、高 39；底邊含一點肩膀，會被被子蓋住）
  const f0 = faceBoxOf('human2', frontFi), f1 = faceBoxOf(race, frontFi), u = f0 && f1 ? f1.w / f0.w : 1;   // u＝這個種族的幀畫布一個人類像素等於幾個像素
  // 取框：回 [來源 x, y, w, h]（race 幀畫布座標）與臉心在框內的位置 [dx, dy]（單位＝人類像素）
  const crop = fi => {
    const a0 = faceBoxOf('human2', fi), a1 = faceBoxOf(race, fi);
    if (!a0 || !a1) return { r: [RX, 0, RW, RH], fx: 16, fy: 24 };
    return { r: [a1.cx - (a0.cx - RX) * u, a1.cy - a0.cy * u, RW * u, RH * u], fx: a0.cx - RX, fy: a0.cy };
  };
  const def = furnitureDef(p.seatType || 'bed'), bed = furnImg(p.seatType || 'bed', sdir);
  if (sdir === 1 || sdir === 3) {   // 橫放的床（2×1）
    const left = sdir === 1, x0 = it.cell[0] * CELL, bottom = (it.cell[1] + 1) * CELL, qs = def?.quiltSide;
    const sideFi = (F.states.left_idle || [0])[0], side = playerSpriteDiv(p, sideFi, true), c = crop(sideFi), dw = RW * k, dh = RH * k;
    // 切面（頭與肩膀取框最底下那一排，身體被切掉的地方）的上端要貼齊被子的上緣，不然切面會露在被子上面、看起來像頭穿過床板：
    // 量那一排不透明像素的範圍，算出切面上端離臉心多遠，再把人往下／往上挪到切面上端剛好在被子上緣
    const cutRow = Math.min(side.height - 1, Math.floor(c.r[1] + c.r[3] - 1)), cx0 = Math.max(0, Math.floor(c.r[0])), cx1 = Math.min(side.width, Math.ceil(c.r[0] + c.r[2]));
    const cd = side.getContext('2d').getImageData(cx0, cutRow, Math.max(1, cx1 - cx0), 1).data;
    let ca = -1, cb = -1; for (let i = 0; i < cd.length / 4; i++) if (cd[i * 4 + 3]) { if (ca < 0) ca = i; cb = i; }
    const sc = dw / c.r[2], lxOf = col => -c.fx * k + (col - c.r[0]) * sc;   // 來源欄 → 轉向前的橫向位置（臉心＝0）
    const upOff = ca < 0 ? -dw / 2 : (left ? -lxOf(cx0 + cb + 1) : lxOf(cx0 + ca));   // 切面上端（螢幕上方那一頭）離臉心的距離（往下為正）
    const quiltTopY = bottom - (bed.height - (qs ? qs[1] + 1 : 10)) * 2;             // 被子上緣（被子方塊的第一排不透明列）
    ctx.save();
    // 頭頂貼著床頭端（床圖 x＝4，頭不會穿過床頭板）；肩膀那端在被子下面（被子從床圖 x＝17 開始，取框長 39px 一定蓋得到）（朝右的床：床圖鏡像）
    ctx.translate(left ? x0 + 4 * 2 - 2 * 2 : x0 + bed.width * 2 - 4 * 2 + 2 * 2, quiltTopY - upOff - (left ? 4 : 1) * 2);   // 使用者微調（2026-11-25，單位＝床圖 1 格＝2px）：床頭在左的人往左 2、往上 4；床頭在右的人往右 2、往上 1
    ctx.rotate(left ? -Math.PI / 2 : Math.PI / 2);
    if (left) ctx.scale(-1, 1);   // 臉朝上（床是側面圖，人仰躺＝臉朝畫面上方）：朝左的床轉 -90° 要翻面、朝右的床轉 +90° 直接用（朝右的幀跟朝左的是同一張圖，畫的時候才鏡像）
    ctx.drawImage(side, c.r[0], c.r[1], c.r[2], c.r[3], -c.fx * k, 0, dw, dh);
    ctx.restore();
    // 被子那一塊（左向圖座標 [x, y, w, h]；朝右是鏡像）蓋回去，遮住身體被切掉的那條線
    if (bed && qs) {
      const qx = left ? qs[0] : bed.width - qs[0] - qs[2];
      ctx.drawImage(bed.img, qx, qs[1], qs[2], qs[3], x0 + qx * 2, bottom - (bed.height - qs[1]) * 2, qs[2] * 2, qs[3] * 2);
    }
    drawZzz(p);
    return;
  }
  if (bed && def?.quiltRow) {   // 直放的床（1×2）：被子從 quiltRow 開始蓋到床尾；頭與肩膀的底邊墊在被子上緣下面 2px（切線被被子蓋住、對得準）
    const rows = bed.height - def.quiltRow, fi = sprFrame(bed, p.seat ? cellPhase(p.seat.cell[0], p.seat.cell[1]) : 0), quiltTop = p.y - rows * 2;
    const c = crop(frontFi), dw = RW * k, dh = RH * k;
    ctx.drawImage(img, c.r[0], c.r[1], c.r[2], c.r[3], p.x - c.fx * k, quiltTop + 2 - dh + 4 * 2, dw, dh);   // 正面睡：使用者微調往下 4 格（2026-11-25，1 格＝2px）
    ctx.drawImage(bed.img, fi * bed.fw, def.quiltRow, bed.fw, rows, p.x - bed.width, quiltTop, bed.width * 2, rows * 2);
  }
  drawZzz(p);
}
function drawZzz(p) {   // Zzz 飄字
  const ph = (S.t * 1.2) % 1;
  ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = `rgba(190,215,255,${1 - ph})`; ctx.strokeStyle = `rgba(8,10,14,${.8 * (1 - ph)})`; ctx.lineWidth = 3;
  ctx.strokeText('Z', p.x + 6 + ph * 14, p.y - 40 - ph * 16); ctx.fillText('Z', p.x + 6 + ph * 14, p.y - 40 - ph * 16);
}

// ---------------- 坐下 / 睡覺（家具 manifest 的 use: "sit" | "sleep"）----------------
function seatItem(p) {      // 現在坐/睡的那件家具（家具被拿走或換地形就找不到）
  return p.seat && S.furnItems.find(it => it.type === p.seat.type && it.cell[0] === p.seat.cell[0] && it.cell[1] === p.seat.cell[1]);
}
// 家具朝向（2026-11-15，使用者要求）：dir 0 正面（朝下，原本那張圖）、1 朝左、2 背面（朝上）、3 朝右；項目上沒有 dir＝0。
// 有方向性的家具 manifest 有 dirs（朝向 1／2／3 的圖，gen_assets.py 的 furn_variants 產生），沒有 dirs＝4 個朝向共用同一張圖
const FURN_DIR_NAME = ['朝下', '朝左', '朝上', '朝右'];
const furnImg = (type, dir) => (dir && S.furnImgs[`${type}@${dir}`]) || S.furnImgs[type];
function furnAtPoint(wx, wy) {   // 世界座標點到哪件家具（依繪製範圍，後放的在上面）
  for (let i = S.furnItems.length - 1; i >= 0; i--) {
    const it = S.furnItems[i], def = furnitureDef(it.type), img = furnImg(it.type, it.dir);
    if (!def || !img) continue;
    const fd = itemDims(it), sc = S.furn.scale || 2, x0 = it.cell[0] * CELL, y1 = (it.cell[1] + fd.h) * CELL;
    if (wx >= x0 && wx <= x0 + Math.max(fd.w * CELL, img.width * sc) && wy >= y1 - img.height * sc && wy <= y1) return it;
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
  n.d8 = dir8Of(me.x - n.x, me.y - n.y);   // 轉向玩家（2026-11-27 使用者回報：原本只分左右，玩家在上方／下方也只看左右；改成 8 方向，人在上面就轉背面、在下面就轉正面）
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

// ---------------- 職業技能說明視窗（P 開關；2026-11-14 使用者要求）----------------
// 內容全部由目前職業動態算出：1／2 鍵技能、R 職能技能（說明＋冷卻）、職能特性、以及「現在這個等級」的各種傷害數值。公式與 hitMob／splashHit 一致。
const ROLE_SKILL_TEXT = {
  provoke:   n => `把島主的仇恨拉到自己身上（龍衝仍直接倒地）。要在島主 ${OWNER_PROVOKE_RANGE}px 內才能用。`,
  groupHeal: n => `補周遭所有人（含自己）${skillVal(n.healAoE)} 血（翅膀期間 ${skillVal(n.healAoE + 1)}；隨等級成長，每 3 級 +50%）。`,
  vuln:      n => `島主 ${ROLE_DEBUFF.dur} 秒內受到的傷害每擊 +1，所有人打都算。要在島主 ${OWNER_PROVOKE_RANGE}px 內才能用。`,
  weak:      n => `島主 ${ROLE_DEBUFF.dur} 秒內對所有人造成的傷害 −30%。要在島主 ${OWNER_PROVOKE_RANGE}px 內才能用。`,
};
function skillInfoData() {
  const jd = JOBS[S.me.job], me = S.players[0], lv = levelOf(me), bonus = lvAtkBonus(lv);
  const wd = S.avatar?.weapons.find(w => w.id === jd?.weapon), rg = wd?.ranged || null, plus = jd?.dmgPlus || 0;
  const sec = [];
  // 1) 技能
  const sk = [];
  jobSkillIds().forEach((id, i) => {
    const d = JOB_SKILLS[id]; if (!d) return;
    let nums = '';
    const mul = skillMul(lv), sv = b => skillVal(b), tail = `（基礎 %B，技能每 3 級 +50%，現在 ×${mul}）`;
    if (id === 'ninjutsu') nums = `火球傷害 ${sv(d.dmg)}` + tail.replace('%B', d.dmg);
    else if (id === 'highjump') nums = `落地傷害 ${sv(d.dmg)}` + tail.replace('%B', d.dmg);
    else if (id === 'poison') nums = `每跳 ${sv(d.dmg)}，共 ${Math.round(d.dur / d.every)} 下，總計 ${sv(d.dmg) * Math.round(d.dur / d.every)}` + tail.replace('%B', d.dmg);
    else if (id === 'sheal') nums = `補 ${sv(d.amt)} 血（翅膀期間 ${sv(d.amt + 1)}）` + tail.replace('%B', d.amt);
    else if (id === 'care') nums = `賢者每造成一次傷害，對方回 ${(d.amt * mul).toFixed(1)} 血；拯救期間回 ${((d.amt + JOB_SKILLS.save.plus) * mul).toFixed(1)} 血` + tail.replace('%B', d.amt);
    else if (id === 'vamp') nums = `命中回 ${sv(1)} 血` + tail.replace('%B', 1);
    sk.push({ key: String(i + 1), name: d.name, cd: d.cd, desc: d.desc, nums });
  });
  const rs = ROLE_SKILLS[jd?.role];
  if (rs) sk.push({ key: 'R', name: rs.name, cd: rs.total(), desc: ROLE_SKILL_TEXT[rs.id]?.({ healAoE: jd.healAoE || 2, wings: false }) || '', nums: '', role: true });
  sec.push({ title: '技能', skills: sk });
  // 2) 職能特性
  const role = ROLES[jd?.role];
  sec.push({ title: `作為${role?.name || ''}的特性`, lines: [`血量上限 ${hpCap(me)}（職能 ${role?.hpMax}＋等級加成 ${lv - 1}）`, (role?.desc.replace(/；R＝.*$/, '').replace(/^血量上限 \d+、/, '') || '')].filter(Boolean) });
  // 3) 目前傷害
  const L = [`目前等級 Lv ${lv}：等級攻擊加成每 3 級 +1，現在 +${bonus}${rg?.lvMul > 1 ? `（${wd.name}每擊吃 ×${rg.lvMul}，等於 +${bonus * rg.lvMul}）` : ''}`];
  if (rg) {
    const dmg = (rg.dmg || 2) + plus + bonus * (rg.lvMul || 1), cyc = (rg.cast || 0) + (rg.cast ? (rg.gap ?? ATK_CD) : ATK_CD);
    L.push(`${wd.name}一般攻擊：每發 ${dmg}（遠程不會暴擊）${rg.cast ? `，詠唱 ${rg.cast} 秒、射程 ${rg.range}px，必須站定` : `，不用詠唱可邊走邊打、射程 ${rg.range}px`}`);
    L.push(`持續輸出約 ${(dmg / cyc).toFixed(1)}／秒（單一目標）`);
    if (rg.splash) L.push(`濺射：命中點周圍 ${rg.splash}px 的野生動物各吃 ${Math.max(1, Math.round(dmg * .6))}（60%）`);
  } else {
    const dmg = 1 + plus + bonus, crit = 2 + plus + bonus;
    L.push(`${wd?.name || '武器'}一般攻擊：每下 ${dmg}，暴擊（機率 18%）${crit}`);
    L.push(`持續輸出約 ${(dmg / ATK_CD).toFixed(1)}／秒（單一目標，不計暴擊）`);
  }
  if (plus) L.push(`上面的數字已包含輸出職能的每擊 +${plus}`);
  sec.push({ title: `現在的傷害數值`, lines: L });
  return { title: `${jd?.name || ''}　技能說明`, sec };
}
function openSkillInfo() {
  if (!JOBS[S.me.job]) return;
  S.skillInfoKey = `${S.me.job}|${levelOf(S.players[0])}`;
  const d = skillInfoData(), body = $('skillBody'); body.innerHTML = '';
  $('skillTitle').textContent = d.title;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  for (const s of d.sec) {
    body.appendChild(mk('div', 'help-sec', s.title));
    if (s.skills) for (const k of s.skills) {
      const box = mk('div', 'sk-item'), head = mk('div', 'sk-head');
      head.appendChild(mk('span', 'sk-key', k.key)); head.appendChild(mk('span', 'sk-name', k.name)); head.appendChild(mk('span', 'sk-cd', `冷卻 ${k.cd} 秒${k.role ? '・職能技能' : ''}`));
      box.appendChild(head); box.appendChild(mk('div', 'sk-desc', k.desc));
      if (k.nums) box.appendChild(mk('div', 'sk-num', k.nums));
      body.appendChild(box);
    }
    if (s.lines) { const ul = mk('ul'); for (const l of s.lines) ul.appendChild(mk('li', null, l)); body.appendChild(ul); }
  }
  S.skillOpen = true; $('skillBox').classList.remove('hidden');
}
function closeSkillInfo() { S.skillOpen = false; $('skillBox').classList.add('hidden'); }

// ---- 線上列表（L）：列出同地形的線上玩家，點名字傳送到他的位置（伺服器只告知同地形的人，所以只列得到同一座地形的）----
function buildPlayerList() {
  const body = $('listBody');
  const rs = [...S.remotes.values()];
  const sig = S.terrain + '#' + rs.map(r => r.id + '|' + r.name + '|' + !!r.dead).join(',');   // 地形也算進去：換島後就算名單剛好一樣也要重畫標題
  if (sig === S.listSig && body.children.length === rs.length) return;   // 名單沒變就不重建，免得點擊到一半元素被換掉
  S.listSig = sig; body.innerHTML = '';
  const tn = S.terrains[S.terrain]?.name || '';
  $('listHint').textContent = rs.length ? `${tn}：點選玩家名字，傳送到他身邊` : `${tn}目前沒有其他玩家`;
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
// ── 表情符號（2026-11-23，使用者要求）：素材 DibbelGames「16x16 Emotes Pack」（授權記錄見 docs/assets-license.md），資料 assets/emotes/emotes.json。
// 右上「表情」按鈕開選單，選了之後 p.emote＝{id, until, t0, n} 在頭上冒出 3 秒；狀態欄位 state.emote＝{id, n}（n 每用一次加一，對方靠它分辨「又發了一次」）。
const EMOTE_MS = 3, EMOTE_CD = .6;
const EMO = { def: null, img: new Image() };
fetch('assets/emotes/emotes.json').then(r => r.json()).then(d => { EMO.def = d; EMO.img.src = 'assets/emotes/emotes.png'; EMO.img.onload = () => buildEmoteMenu(); }).catch(() => {});
const emoteIdx = id => EMO.def ? EMO.def.list.findIndex(e => e.id === id) : -1;
function emoteDraw(x, y, em) {   // x,y＝泡泡尾巴要指的點（頭上）；回 false＝素材還沒載好，交給後面的畫法
  const i = emoteIdx(em.id); if (i < 0 || !EMO.img.complete || !EMO.img.naturalWidth) return false;
  const cell = EMO.def.cell, k = Math.min(1, (S.t - em.t0) / .18), left = em.until - S.t;
  const sc = 2 * (k < 1 ? .4 + .6 * (1 - Math.pow(1 - k, 3)) : 1), sz = cell * sc;   // 冒出來：由小彈到 2 倍
  ctx.save(); ctx.globalAlpha = Math.min(1, left / .3); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(EMO.img, (i % EMO.def.cols) * cell, Math.floor(i / EMO.def.cols) * cell, cell, cell, Math.round(x - sz / 2), Math.round(y + 3 - sz - Math.sin(Math.min(1, (S.t - em.t0) / 1.2) * 3.14) * 0), sz, sz);
  ctx.restore(); return true;
}
function emoteSay(id) {   // 我自己發一個表情
  const me = S.players[0]; if (!me || emoteIdx(id) < 0 || S.t < (S.emoteNext ?? 0)) return;
  S.emoteNext = S.t + EMOTE_CD; S.emoteN = (S.emoteN || 0) + 1;
  me.emote = { id, t0: S.t, until: S.t + EMOTE_MS, n: S.emoteN };
}
S.myEmote = () => { const e = S.players[0]?.emote; return e && S.t < e.until ? { id: e.id, n: e.n } : null; };
function buildEmoteMenu() {
  const m = $('emoteMenu'); if (!m || !EMO.def || m.childElementCount) return;
  const c = EMO.def.cell * 2;
  EMO.def.list.forEach((e, i) => {
    const b = document.createElement('button'); b.className = 'emote-item'; b.title = e.name;
    b.style.backgroundImage = 'url(assets/emotes/emotes.png)'; b.style.backgroundSize = `${EMO.def.cols * c}px auto`;
    b.style.backgroundPosition = `${-(i % EMO.def.cols) * c}px ${-Math.floor(i / EMO.def.cols) * c}px`;
    b.onclick = () => { emoteSay(e.id); m.classList.add('hidden'); };
    m.appendChild(b);
  });
}
function drawSecretRoom(sc, W, ims) {   // 隱藏房間：地毯、北／東／西牆，南面沿用主房間的北牆（門洞那段由門簾蓋住）
  const [bx0, by0, bx1, by1] = sc.box, d = sc.door;
  if (ims[sc.rug]) drawSpr(ims[sc.rug], 0, bx0 * CELL, by0 * CELL, (bx1 - bx0 + 1) * CELL, (by1 - by0 + 1) * CELL);
  if (W) drawRoomWalls({ ...W, h: 3 }, ims, sc.box);
  // 南面直接沿用主房間的北牆（2026-11-24 使用者回報：進隱藏房間後簾子同一側的牆壁會消失——原本在這裡把北牆整條蓋成深色背面，拿掉了；牆照常畫、門洞由門簾蓋住）
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
    const fd = itemDims(it), d = Math.hypot((it.cell[0] + fd.w / 2) * CELL - p.x, (it.cell[1] + fd.h / 2) * CELL - p.y);
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
  const fd = itemDims(it), cx = (it.cell[0] + fd.w / 2) * CELL, cy = (it.cell[1] + fd.h / 2) * CELL;
  if (Math.hypot(cx - p.x, cy - p.y) > 80) { say(`靠近一點再${def.use === 'sit' ? '坐' : '躺'}`); return; }
  const sx = cx, sy = (it.cell[1] + fd.h) * CELL - (def.use === 'sit' ? 2 : 0);
  for (const r of S.remotes.values()) if (r.pose && Math.abs(r.x - sx) < 10 && Math.abs(r.y - sy) < 10) { say('這裡有人了'); return; }
  p.pose = def.use; p.seat = { type: it.type, cell: [it.cell[0], it.cell[1]] }; p.seatType = it.type; p.face = 'down'; p.d8 = 'down';
  if (def.use === 'sit') seatFace(p, it.dir || 0);
  p.x = sx; p.y = sy; p.z = 0; p.vz = 0; p.moving = false; p.frame = 0; p.swing = 0; p.tool = null;
  say(def.use === 'sit' ? '坐下了（移動、F 或再點一次起身）' : '晚安～（移動、F 或再點一次起身）', 1800);
}
// 坐的時候面向椅子的朝向（朝向 0 下／1 左／2 上／3 右）；face／d8／dir 會隨 state 同步給別人，所以不用新欄位
function seatFace(p, dir) {
  p.face = dir === 2 ? 'up' : dir === 0 ? 'down' : 'side';
  p.d8 = ['down', 'left', 'up', 'right'][dir];
  if (dir === 1) p.dir = -1; else if (dir === 3) p.dir = 1;
}
function standUp(p) {
  if (!p.pose) return;
  const seat = p.seat;
  p.pose = null; p.seat = null; p.seatType = null;
  if (seat) {   // 起身時站到家具前面（前面有東西擋就原地，仍可走出來）
    const sit = S.furnItems.find(o => o.type === seat.type && o.cell[0] === seat.cell[0] && o.cell[1] === seat.cell[1]), ny = (seat.cell[1] + (sit ? itemDims(sit).h : (furnitureDef(seat.type)?.h || 1))) * CELL + 6;
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
// 拉扯小遊戲（2026-11-17 使用者要求）：依上鉤那條魚的稀有度分級（TUG.tier）——常見＝照舊按一下就釣上來（頭上「!」）；
// 罕見＝「!!」、控線約 2 秒、魚不會掙扎；稀有＝「!!!」、完整的拉扯（魚會掙扎）。音效也各不相同。
// 拉扯：按住 F／左鍵收線（張力上升）、放開放線（張力下降）：張力待在中段進度才會漲；頂到上限太久＝斷線，鬆弛累計太久＝魚跑掉。
// 稀有魚會在「喘息」與「掙扎」之間切換，掙扎時按住張力暴漲，要放線。有小遊戲的魚不算脫鉤（escape）。
const TUG = {
  slack: .25, danger: .85,          // 張力條：低於 slack＝鬆弛區；高於 danger＝警戒區（只是提示色，頂到 1 才算斷線時間）
  up: [.6, 1.6], down: [.75, .35],  // 每秒張力變化：按住［喘息, 掙扎］、放開［喘息, 掙扎］
  snapAfter: .4, loseAfter: 1.5,    // 張力頂在上限累計幾秒斷線；鬆弛累計幾秒魚跑掉（回到安全區會慢慢消退）
  drop: .08,                        // 鬆弛區每秒進度倒退
  calm: [1.2, 2.4], surge: [.7, 1.3],   // 喘息／掙扎各持續幾秒（隨機）
  // 各稀有度的分級（沒列的＝沒有小遊戲）：mark＝上鉤時頭上的字、gain＝每秒進度［安全區下緣, 上緣］、surge＝魚會不會掙扎
  tier: {
    uncommon: { mark: '!!', color: '#7ab8f0', sfx: 'SFX_BITE_UNCOMMON', gain: [.42, .5], surge: false },   // 待在安全區約 2 秒
    rare: { mark: '!!!', color: '#ff9a3a', sfx: 'SFX_BITE_RARE', gain: [.1, .3], surge: true },
  },
};
const tugTier = f => TUG.tier[f?.rar] || null;
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
    if (netOn()) S.net.fishHook();   // 伺服器現在就抽好這一竿的魚，用 fish_hook 回稀有度（onFishHook）；沒回＝當常見魚處理
    toast('拋竿了，等魚上鉤…（再按一次收竿）', 1800);
  } else if (f.ph === 'wait') stopFishing(p, '收竿了');
  else if (f.ph === 'bite') {
    f.ph = 'reel'; f.t = S.t; f.result = null;
    if (tugTier(f)) { f.mg = { tier: tugTier(f), T: .45, prog: .12, over: 0, slack: 0, surge: false, next: S.t + 1 + Math.random() * .8, t0: S.t }; return; }   // 罕見／稀有魚：先拉扯，贏了才揭曉（stepTug）
    if (netOn()) S.net.fishCatch();            // 伺服器抽魚並記進圖鑑，結果由 fish_result 回來
    else f.result = f.pre || rollFish(S.terrain, f);
  }
}
// 拉扯小遊戲每幀（只有自己的角色有 f.mg；別人看到的就是一直在拉竿）
function stepTug(p, f, dt) {
  const g = f.mg, hold = !!(keys['f'] || S.mouseHeld), k = g.surge ? 1 : 0;
  const gain = g.tier.gain;
  if (g.tier.surge && S.t >= g.next) {   // 喘息 ↔ 掙扎（只有稀有魚）
    g.surge = !g.surge;
    const r = g.surge ? TUG.surge : TUG.calm;
    g.next = S.t + r[0] + Math.random() * (r[1] - r[0]);
    if (g.surge) sfxTones(SFX_TUG_SURGE);
  }
  g.T = Math.max(0, Math.min(1, g.T + (hold ? TUG.up[k] : -TUG.down[k]) * dt));
  g.over = g.T >= 1 ? g.over + dt : Math.max(0, g.over - dt * .5);
  if (g.T < TUG.slack) { g.slack += dt; g.prog = Math.max(0, g.prog - TUG.drop * dt); }
  else {
    g.slack = Math.max(0, g.slack - dt * .5);
    g.prog += (gain[0] + (gain[1] - gain[0]) * (g.T - TUG.slack) / (1 - TUG.slack)) * dt;
  }
  if (g.over >= TUG.snapAfter) { sfxTones(SFX_TUG_FAIL); stopFishing(p, '拉太緊，魚線斷了！'); }
  else if (g.slack >= TUG.loseAfter) { sfxTones(SFX_TUG_FAIL); stopFishing(p, '線太鬆，魚跑掉了…'); }
  else if (g.prog >= 1) {   // 贏了：這時才請伺服器抽魚（單機用上鉤時先抽好的 f.pre），短暫收尾後揭曉
    f.mg = null; f.won = true; f.t = S.t - FISH_REEL + .3;
    if (netOn()) S.net.fishCatch(); else f.result = f.pre;
  }
}
function stopFishing(p, msg) {
  if (!p.fish) return;
  if (p === S.players[0] && p.fish.ph !== 'wait' && netOn()) S.net.fishDrop();   // 上鉤後沒釣上來（沒拉、小遊戲輸了、被打斷）：伺服器把那條魚丟掉；等魚時收竿不丟，重拋還是同一條
  p.fish = null;
  if (msg) toast(msg, 1800);
}
// 每幀：等魚 → 上鉤 → 逾時跑掉；拉扯動畫結束時揭曉結果
function stepFishing(p, dt) {
  const f = p.fish;
  if (!f) return;
  if (f.ph === 'wait' && S.t >= f.biteAt) {
    f.ph = 'bite'; f.t = S.t;
    if (p === S.players[0]) {
      if (!netOn()) { f.pre = rollFish(S.terrain, f); f.rar = f.pre.rarity; }   // 單機：上鉤時就抽好，才知道稀有度（決定有沒有小遊戲）
      sfxTones(SFX_BITES[tugTier(f)?.sfx] || SFX_BITE);   // 魚上鉤：除了頭上的「!」再響一聲（只有自己的；2026-11-16 使用者要求）；罕見／稀有各有自己的音效
    }
  }
  else if (f.ph === 'bite' && S.t - f.t > FISH_BITE) stopFishing(p, '魚逃走了…');
  else if (f.ph === 'reel' && f.mg) stepTug(p, f, dt);
  else if (f.ph === 'reel' && S.t - f.t >= FISH_REEL) {
    if (f.result) { p.fish = null; showCatch(p, f.result); }
    else if (S.t - f.t > FISH_REEL + FISH_RESULT_WAIT) stopFishing(p, '連線不穩，魚跑掉了…');
  }
}
// 單機抽魚（與 Worker 的 rollFish、dev_server 的 roll_fish 同演算法）：先脫鉤判定，再依權重抽稀有度，
// 從該地形同稀有度的魚裡平均抽一種；尺寸越大越難（範圍內取 r^1.6）
function rollFish(terrain, bob) {
  const db = S.fishDB, fc = db?.foreignChance?.[terrain], home = terrain;   // 和平島等：極低機率改釣別座島的魚（圖鑑記在那座島；怪物判定仍看自己這座島）
  if (fc && Math.random() < fc) { const others = Object.keys(db.terrains).filter(k => k !== terrain && db.terrains[k].length); if (others.length) terrain = others[Math.floor(Math.random() * others.length)]; }
  const list = db?.terrains[terrain] || [];
  if (!list.length) return { terrain, escaped: true };
  const esc = Math.random() < db.escape;   // 脫鉤：抽到有拉扯小遊戲的稀有度（罕見／稀有）就不算（2026-11-17 使用者定），所以要等稀有度抽完才判
  // 極低機率釣到敵對怪物（場上已經有一隻就照常釣魚）；與兩份伺服器的 fishCatch 同規則
  if (!esc && db.lurker && !(db.noLurker || []).includes(home) && mobDef(db.lurker) && !S.mobs.some(v => v.lurker && !v.dead) && Math.random() < (db.lurkerChance || 0))   // noLurker：和平島不會釣到
    return { terrain, lurker: db.lurker, bx: bob?.x, by: bob?.y };
  const rars = Object.entries(db.rarity).filter(([k]) => list.some(f => f.rarity === k));
  let r = Math.random() * rars.reduce((s, [, v]) => s + v.weight, 0), rar = rars[rars.length - 1][0];
  for (const [k, v] of rars) { if ((r -= v.weight) < 0) { rar = k; break; } }
  if (esc && !TUG.tier[rar]) return { terrain, escaped: true };
  const cands = list.filter(f => f.rarity === rar), f = cands[Math.floor(Math.random() * cands.length)];
  const size = Math.round((f.size[0] + (f.size[1] - f.size[0]) * Math.random() ** 1.6) * 10) / 10;
  return { terrain, id: f.id, size, rarity: rar };
}
// 伺服器回這一竿的稀有度（拋竿時送 fish_hook 問的）：記在 f.rar，上鉤時決定頭上的驚嘆號、音效與要不要玩拉扯小遊戲
function onFishHook(m) {
  const f = S.players[0].fish;
  if (f && f.ph === 'wait' && typeof m.rar === 'string') f.rar = m.rar;
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
  const foreign = m.terrain !== S.terrain ? S.terrains[m.terrain]?.name : null;   // 和平島偶爾釣到別座島的魚：提示來自哪座島（圖鑑記在那座島）
  toast(`釣到了 ${def.name}！${m.size} cm（${rar?.name || ''}）${foreign ? ` · 來自${foreign}` : ''}${big ? ' · 大尺寸！' : ''}${isNew ? ' · 新發現！' : isRecord ? ' · 尺寸新紀錄！' : ''}`, 3400);
  if (S.dexOpen) buildDex();
  checkTitles(false);
}
// 拉扯小遊戲的張力條（畫在自己頭上，世界座標）：橫條左＝鬆、右＝緊，藍＝鬆弛區、綠＝安全區、紅＝警戒區，白色指針＝目前張力；
// 下面細的金色條＝收線進度；離失敗（斷線／魚跑掉）越近，外框越紅
function drawTug(p, g, headY) {
  const w = 72, h = 7, x = Math.round(p.x - w / 2), y = Math.round(headY - 30);
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,.8)'; ctx.fillRect(x - 2, y - 2, w + 4, h + 10);
  ctx.fillStyle = '#4a7ab0'; ctx.fillRect(x, y, w * TUG.slack, h);
  ctx.fillStyle = '#58b868'; ctx.fillRect(x + w * TUG.slack, y, w * (TUG.danger - TUG.slack), h);
  ctx.fillStyle = '#d8503c'; ctx.fillRect(x + w * TUG.danger, y, w * (1 - TUG.danger), h);
  const risk = Math.max(g.over / TUG.snapAfter, g.slack / TUG.loseAfter);
  if (risk > 0) { ctx.strokeStyle = `rgba(255,90,70,${.35 + .65 * Math.min(1, risk)})`; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y - 1, w + 2, h + 2); }
  const mx = x + Math.round(w * g.T) + (g.surge ? Math.round(Math.sin(S.t * 40)) : 0);
  ctx.fillStyle = '#10141c'; ctx.fillRect(mx - 2, y - 2, 5, h + 4);
  ctx.fillStyle = '#fff'; ctx.fillRect(mx - 1, y - 1, 3, h + 2);
  ctx.fillStyle = '#3a3428'; ctx.fillRect(x, y + h + 3, w, 3);
  ctx.fillStyle = '#ffd84a'; ctx.fillRect(x, y + h + 3, w * Math.min(1, g.prog), 3);
  const tip = g.surge ? '魚在掙扎！放線' : S.t - g.t0 < 3 ? '按住收線・放開放線' : '';
  if (tip) {
    ctx.font = 'bold 10px "Microsoft JhengHei"'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = g.surge ? '#ff9a7a' : '#fff6e0';
    ctx.strokeText(tip, p.x, y - 6); ctx.fillText(tip, p.x, y - 6);
  }
  ctx.restore();
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
    const q = f.mg ? f.mg.prog : f.won ? 1 : Math.min(1, since / FISH_REEL);   // 拉扯小遊戲：浮標跟著進度一點一點收回來
    bx += (p.x - bx) * q * .6; by += (p.y - 10 - by) * q * .6;
    if (f.mg) { sag = 14 * (1 - f.mg.T); if (f.mg.surge) { bx += Math.sin(S.t * 38) * 2; by += Math.cos(S.t * 31) * 1.2; } }   // 線越鬆垂越低；魚掙扎時浮標亂竄
  }
  else if (f.ph === 'wait') by += Math.sin(S.t * 3) * 1.5;
  else by += 3;
  ctx.save();
  ctx.strokeStyle = f.mg && f.mg.T > TUG.danger ? (Math.floor(S.t * 12) % 2 ? '#ff5a4a' : '#ffd0c0') : 'rgba(240,240,232,.85)'; ctx.lineWidth = 1;   // 快斷了：釣線閃紅
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
  if (f.mg?.surge) {                       // 魚在掙扎：浮標旁濺水
    const q = (S.t * 3) % 1;
    ctx.strokeStyle = `rgba(240,250,255,${.8 * (1 - q)})`;
    ctx.beginPath(); ctx.ellipse(bx, by, 4 + q * 12, 1.5 + q * 4, 0, 0, Math.PI * 2); ctx.stroke();
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
  S.tableOpen = true; S.tableId = tb.id; S.tableView = null; S.gmStep = null; S.bk = null; S.tg = null; S.kg = null; S.gamePlayed = false; S.tableLocalLog = [];
  const inf = S.tblInfo?.[tb.id];
  S.tableCab = tb.cab ?? -1; S.ar = null; S.arOpp = {}; S.plSpec = {};   // 俄羅斯方塊：4 台共用一張桌，坐哪一台由 cab 決定
  if (tb.cab != null ? !inf?.cabs?.[tb.cab] : (!inf || (!inf.play && inf.n < inf.max))) S.tableChoice = true;   // 還有位子（街機：這台空著）：先讓玩家選「入座」或「觀戰」（沒滿人也可以選觀戰）
  else S.net.tbl({ a: 'join', id: tb.id, role: 'spec', cab: S.tableCab });             // 滿人或已開局（街機：這台有人）：直接觀戰
  buildTable(); $('tableBox').classList.remove('hidden');
}
function closeTable(sendLeave = true) {
  if (sendLeave) S.net?.tbl?.({ a: 'leave' });
  S.pgSeen = null; S.tableOpen = false; S.tableId = null; S.tableView = null; S.tableChoice = false; S.tblFinal = null; brkStop(); bubStop(); tfStop(); plStop(); dodgeStop(); mageStop(); typingStop(); arStop(); mzStop(); pbStop(); maryStop(); hkStop(); unStopTimer(); bkStopTimer(); kgStopTimer(); btStopTimer(); itStopTimer(); S.unPick = null; S.itSel = -1; S.itMode = null;
  rulesShow(false); leaveAsk(false); settleHide();
  $('tableBox').classList.add('hidden');
}
// 使用者主動離開（離開按鈕／Esc）：我是入座玩家而且牌局進行中 → 先跳確認（離開會直接中斷這一局或放棄成績）；觀戰、還沒開局就直接離開
// 主動中途退出機台小遊戲＝用當下的分數結算（2026-11-19 使用者要求：有的遊戲死不掉）：彈珠台／打磚塊／泡泡射手／2048 的玩法都在客戶端算，
// 所以離開前補送一個 over（跟打完一樣的結算；伺服器不用改）。分數是 0（倒數中、還沒得分）就不結算，照一般規則這一局不算。
const QUIT_SCORE_GAMES = ['pinball', 'breakout', 'bubble', 'g2048', 'planet'];
function quitScoreNow() {
  const v = S.tableView;
  if (!v || v.phase !== 'playing' || v.role !== 'seat' || !QUIT_SCORE_GAMES.includes(v.game)) return false;
  const cap = n => Math.min(99999999, Math.round(n));
  if (v.game === 'pinball') { const P = S.pb; if (P && P.role === 'seat' && !P.over && P.score > 0) { P.over = true; P.st = 3; tblFinal({ a: 'over', sc: cap(P.score) }); pbSnap(P, true); return true; } }
  else if (v.game === 'breakout') { const B = S.brk; if (B && B.role === 'seat' && !B.over && B.score > 0) { B.over = true; brkSnap(B, true); tblFinal({ a: 'over', sc: cap(B.score), lv: B.lv }); return true; } }
  else if (v.game === 'bubble') { const B = S.bub; if (B && B.role === 'seat' && !B.over && B.score > 0) { B.over = true; B.fly = null; bubSnap(B, true); tblFinal({ a: 'over', sc: cap(B.score), lv: Math.min(999, B.lv) }); return true; } }
  else if (isPlGame(v.game)) { const B = S.pl; if (B && B.role === 'seat' && !B.over && !B.vs && B.score > 0) { B.over = true; plSnap(B, true); tblFinal({ a: 'over', sc: cap(B.score), mx: Math.max(1, Math.min(11, B.mx)) }); return true; } }
  else if (v.game === 'g2048') { const B = S.tf; if (B && B.role === 'seat' && !B.over && B.score > 0) { B.over = true; tfSnap(B, true); tblFinal({ a: 'over', sc: Math.min(TF_SCORE_MAX_C, Math.round(B.score)), mx: Math.min(17, B.mx) }); return true; } }
  return false;
}
function leaveAsk(on) {
  const box = $('leaveBox'); box.classList.toggle('hidden', !on);
  if (on) { const v = S.tableView, sub = box.querySelector('.leave-sub'); if (sub) { if (!sub.dataset.def) sub.dataset.def = sub.textContent; sub.textContent = v && QUIT_SCORE_GAMES.includes(v.game) && !(isPlGame(v.game) && S.pl?.vs) ? '離開會用你目前的分數結算這一局（還沒得分就不算）。' : sub.dataset.def; } }
  if (on) $('leaveStay').focus();   // 預設停在「繼續遊戲」，連點空白鍵也不會誤退出
}
// 結算畫面（2026-11-20，使用者要求「所有遊戲都有個結算畫面，而不是直接跳回等待大廳」）：我坐著打完一局（result 新的 rid、不是作廢）就蓋一層，
// 內容複製自大廳剛畫好的結算區（`.table-result` 結算文字、`.dodge-rank`／`.table-ranking` 名次、`.table-board` 排行榜），所以各遊戲原本的結算文字不用再寫一份。
// 剛結算 0.7 秒內按鈕不能按（免得還在連按空白／方向鍵的人一下就關掉）；按「回到大廳」或 Esc 關閉。
let settleTimer = 0;
function showSettle(v, xp) {
  const box = $('settleBox'), body = $('settleBody'), src = $('tableBody');
  body.textContent = '';
  const keep = [...src.querySelectorAll('.table-result, .dodge-rank, .table-ranking, .table-board')];
  if (!keep.length) return;   // 這個遊戲的大廳沒有任何結算區（理論上不會）：不蓋
  $('settleTitle').textContent = `${gameDef(v.game)?.name || '遊戲'}　結算`;
  for (const el of keep) body.appendChild(el.cloneNode(true));
  if (xp > 0) { const x = document.createElement('div'); x.className = 'settle-xp'; x.textContent = `獲得 ${xp} XP`; body.insertBefore(x, body.querySelector('.table-board')); }
  const ok = $('settleOk'); ok.disabled = true;
  clearTimeout(settleTimer); settleTimer = setTimeout(() => { ok.disabled = false; ok.focus(); }, 700);
  box.classList.remove('hidden');
}
function settleHide() { clearTimeout(settleTimer); $('settleBox').classList.add('hidden'); }
function leaveTable() {
  if (!$('settleBox').classList.contains('hidden')) { if (!$('settleOk').disabled) settleHide(); return; }   // 結算畫面開著：Esc 先關結算（剛結算 0.7 秒內不理）
  const box = $('leaveBox');
  if (!box.classList.contains('hidden')) { leaveAsk(false); return; }   // Esc 再按一次＝取消確認，繼續遊戲
  const v = S.tableView;
  if (v && v.phase === 'playing' && v.role === 'seat' && (v.game !== 'blackjack' || bjAtRisk(v))) leaveAsk(true); else closeTable();   // 21 點：只有發牌後、手上有注才問（下注階段離座會退注）
}
// 規則說明視窗：每個遊戲都有按鈕（有 guide 用分段規則，沒有就用 rules 拆句）；入座／觀戰／遊戲中都能開關，不影響牌局畫面
// 沒有分段 guide 的遊戲：把簡短規則（rules）依句號拆成條列，一樣有「規則說明」按鈕
const gdGuide = gd => gd?.guide || (gd?.rules ? { title: '規則說明', sections: [{ h: gd.name, li: gd.rules.split(/(?<=[。！？])/).map(x => x.trim()).filter(Boolean) }] } : null);
function rulesGuide() { const tb = tablesHere().find(t => t.id === S.tableId); return tb && gdGuide(gameDef(tb.game)) || null; }
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
// ---- 回合提示音（2026-11-16，使用者要求）：有回合時限的遊戲（Blokus／Blokus Trigon／列島建國／大老二／秘藥情報戰／UNO），輪到自己時響一聲，
// 自己的回合剩 30／10／5／4／3／2／1 秒時再各提醒一次（越接近越急）。純客戶端；聲音用 Web Audio 現場合成（沒有音檔，不用記授權）。
// 設定選單可以關（S.profile.sfx === false）。瀏覽器要有過使用者操作才能出聲，所以第一次點擊／按鍵時把 AudioContext 叫醒。
const TURN_WARN = [30, 10, 5, 4, 3, 2, 1];   // 剩幾秒時提醒（4～1 秒是 2026-11-16 使用者追加：最後五秒每秒都響）
let sfxCtx = null;
function sfxWake() { try { sfxCtx ||= new (window.AudioContext || window.webkitAudioContext)(); if (sfxCtx.state === 'suspended') sfxCtx.resume(); } catch { sfxCtx = null; } }
addEventListener('pointerdown', sfxWake, true); addEventListener('keydown', sfxWake, true);
function sfxTones(list) {   // list＝[[頻率 Hz, 開始秒, 長度秒]…]：一串短促的正弦音
  if (S.profile?.sfx === false || !sfxCtx || sfxCtx.state !== 'running') return;
  const t0 = sfxCtx.currentTime + .01;
  for (const [f, at, len] of list) {
    const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(.09, t0 + at + .012); g.gain.exponentialRampToValueAtTime(.0008, t0 + at + len);
    o.connect(g).connect(sfxCtx.destination); o.start(t0 + at); o.stop(t0 + at + len + .02);
  }
}
const SFX_BITE_RARE = [[1320, 0, .06], [1760, .07, .06], [2217, .14, .06], [2637, .21, .26]];   // 稀有魚上鉤：一路往上的四聲（跟平常的「叮鈴」分得出來）
const SFX_BITE_UNCOMMON = [[1320, 0, .06], [1760, .07, .06], [2093, .14, .2]];   // 罕見魚上鉤：三聲
const SFX_BITES = { SFX_BITE_UNCOMMON, SFX_BITE_RARE };   // TUG.tier 的 sfx 用名字查（TUG 宣告得比音效早）
const SFX_TUG_SURGE = [[520, 0, .05], [390, .05, .08]];   // 拉扯小遊戲：魚開始掙扎（往下的兩聲）
const SFX_TUG_FAIL = [[330, 0, .1], [220, .1, .22]];      // 拉扯失敗（斷線／魚跑掉）
const SFX_BITE = [[1320, 0, .07], [1760, .07, .16]];   // 釣魚上鉤：短促的兩聲高音「叮鈴」（跟回合提示音共用設定選單的開關）
const SFX_TURN = { start: [[660, 0, .16], [880, .13, .24]], 30: [[520, 0, .2]], 10: [[700, 0, .12], [700, .18, .12]], 5: [[900, 0, .09], [900, .13, .09], [900, .26, .09]], 4: [[900, 0, .1]], 3: [[900, 0, .1]], 2: [[900, 0, .1]], 1: [[1100, 0, .16]] };
function turnAlertInfo(v) {   // 現在這桌的回合：回 { mine＝是不是輪到我要動作, end＝期限（伺服器時間毫秒）, off＝伺服器時間 − 本機時間 }；沒有時限的遊戲／狀態回 null
  if (!v || v.phase !== 'playing' || v.role !== 'seat') return null;
  const me = v.me, turn = v.turn === me;
  if (v.game === 'blokus' || v.game === 'trigon') { const z = v.bk || v.tg; return z ? { mine: turn, end: z.deadline, off: S.bkOff } : null; }
  if (v.game === 'kingdom') return v.kg ? { mine: turn, end: v.kg.deadline, off: S.kgOff } : null;
  if (v.game === 'purify') return v.pg ? { mine: turn, end: v.pg.deadline, off: S.pgOff } : null;
  if (v.game === 'bigtwo') return v.bt ? { mine: turn, end: v.bt.deadline, off: S.btOff } : null;
  if (v.game === 'uno') return v.un ? { mine: turn, end: v.un.deadline, off: S.unOff } : null;
  if (v.game === 'intel') {   // 秘藥情報戰：輪到我投遞、密函在我手上要決定、要我做技能決定、被查驗要回答（識破倒數是所有人的，不算「我的回合」）
    const it = v.it; if (!it || it.untimed || it.step === 'pick') return null;
    const L = it.letter;
    const mine = !it.pend && (it.prompt ? it.prompt.seat === me : it.ask ? it.ask.tgt === me : it.step === 'turn' ? turn : it.step === 'pass' && !it.arrive && !!L && L.at === me);
    return { mine, end: it.deadline, off: S.itOff };
  }
  return null;
}
function turnAlertTick() {
  const v = S.tableOpen ? S.tableView : null, a = turnAlertInfo(v), P = S.turnAlert;
  if (!a || !Number.isFinite(a.end) || !Number.isFinite(a.off)) { S.turnAlert = null; return; }
  const left = (a.end - (Date.now() + a.off)) / 1000;
  const fresh = !P || P.tid !== S.tableId || !P.mine || a.end > P.end + 3000;   // 剛輪到我，或同樣是我但期限往後跳了一大段＝新的一回合
  if (a.mine && fresh) sfxTones(SFX_TURN.start);
  else if (a.mine) for (const w of TURN_WARN) if (P.left > w && left <= w && left > w - 2) { sfxTones(SFX_TURN[w]); break; }
  S.turnAlert = { tid: S.tableId, mine: a.mine, end: a.end, left };
}
setInterval(turnAlertTick, 200);
// 只送一次的結算回報（空氣曲棍球 hend、豆豆迷宮／彈珠台／打磚塊 over）：記下來，剛好在斷線的那一瞬間送不出去的話，回座（rejoin）後補送一次；
// 不然伺服器那邊這一局永遠不會結束。收到「不是進行中」的牌桌畫面（＝伺服器已經結算）就清掉。
function tblFinal(m) { S.tblFinal = { id: S.tableId, m }; S.net?.tbl?.(m); }
function onNetTable(m) {   // 伺服器給我的牌桌畫面（v＝null：我已離開這桌）
  if (!S.tableOpen || m.id !== S.tableId) return;
  if (m.v === null) { closeTable(false); return; }
  if (m.v.phase !== 'playing') S.tblFinal = null;
  // 玩小遊戲得 XP：登入者由伺服器記（收到 xp 訊息飄字）；訪客（本機記帳）在這裡依 result.xp 補發。只算「我自己坐著打完的那一局」
  if (m.v.phase === 'playing') S.tableLocalLog = [];   // 新的一局開始：清掉上一局的 XP 提示
  if (m.v.phase === 'playing' && m.v.role === 'seat') S.gamePlayed = true;
  const rs = m.v.result;
  let settle = null;
  if (S.gamePlayed && rs && rs.rid && rs.rid !== S.gameXpSeen && m.v.phase !== 'playing') {
    S.gameXpSeen = rs.rid; S.gamePlayed = false;
    const n = rs.xp?.[m.v.me] || 0, gs = rs.gs?.[m.v.me];
    if (gs && !xpServer()) gstatsLocalApply(m.v.game, gs);   // 訪客：戰績（稱號用）本機累加；登入者由伺服器記並送 gstats
    if (n > 0 && !xpServer()) { const p0 = S.players[0]; grantExp(n, p0.x, p0.y - 60, 'game'); tableXpLine(n); }   // 訪客：本機補發，提示放進牌桌下方的系統訊息
    settle = !rs.aborted ? { n: xpServer() ? 0 : n } : null;   // 結算畫面（中途作廢的局不跳）；登入者的 XP 由伺服器另外飄字，這裡不重複寫
  }
  S.tableView = m.v; buildTable();
  if (settle) showSettle(m.v, settle.n);
  else if (m.v.phase === 'playing') settleHide();
}
// 牌桌下方的系統訊息：伺服器的紀錄（新的在上）＋本機加的「你獲得 N XP」（放最上面；新的一局開始就清掉）
function tableXpLine(n) { (S.tableLocalLog ||= []).unshift(`你獲得 ${n} XP`); if (S.tableOpen && S.tableView) buildTable(); }
const tableLogLines = v => [...(S.tableLocalLog || []), ...[...v.log].reverse()];
function onNetTblInfo(info) { S.tblInfo = info || {}; }
function onNetTblErr(m) { if (m?.id && m.id !== S.tableId) return; toast(m?.text || '操作無效', 2200); }   // 小瑪莉等機台的操作被拒（籌碼不足／沒押注…）：只提示本人
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
  const box = $('tableBody'), keep = typingKeepWrap();
  if (keep) { for (const c of [...box.children]) if (c !== keep) c.remove(); } else box.innerHTML = '';   // 中文打字比賽中：留著輸入框那一塊，其餘照常重畫
  const tb = tablesHere().find(t => t.id === S.tableId), gd = tb && gameDef(tb.game), v = S.tableView;
  $('tableTitle').textContent = gd ? gd.name : '遊戲桌';
  $('tableRulesBtn').classList.toggle('hidden', !gdGuide(gd));
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
      b.onclick = () => { S.tableChoice = false; S.net?.tbl?.({ a: 'join', id: S.tableId, role, cab: S.tableCab, chips: S.chips }); buildTable(); };   // 小瑪莉：訪客把本機籌碼帶上機台（登入者伺服器不理這個欄位）
      bs.appendChild(b);
    }
    const lv = mk('button', 'ff-btn small', '離開（Esc）'); lv.onclick = () => leaveTable(); bs.appendChild(lv);
    box.appendChild(bs);
    return;
  }
  if (!v) { box.appendChild(mk('div', 'table-status', '連線中…')); return; }
  if (tb?.game === 'arcade') { buildArcade(box, v, mk, gd); return; }   // 俄羅斯方塊有自己的畫面（盤面＋聯機）
  if (tb?.game === 'gomoku') { buildGomoku(box, v, mk); return; }   // 五子棋有自己的畫面（棋盤）
  if (tb?.game === 'purify') { buildPurify(box, v, mk, gd); return; }   // 淨土守護戰有自己的畫面（5×5 的島、手牌、行動）
  if (tb?.game === 'bigtwo') { buildBigTwo(box, v, mk, gd); return; }   // 大老二有自己的畫面（桌面最後一手＋手牌選牌）
  if (tb?.game === 'kingdom') { buildKingdom(box, v, mk, gd); return; }   // 列島建國有自己的畫面（市場、事件、目標、各人的王國）
  if (tb?.game === 'trigon') { buildTrigon(box, v, mk, gd); return; }   // Blokus Trigon有自己的畫面（三角格棋盤＋方塊托盤）
  if (tb?.game === 'blokus') { buildBlokus(box, v, mk, gd); return; }   // Blokus有自己的畫面（棋盤＋方塊托盤）
  if (tb?.game === 'mage') { buildMage(box, v, mk, gd); return; }   // 見習驅魔師有自己的畫面（畫符號的場地）
  if (tb?.game === 'dodge') { buildDodge(box, v, mk, gd); return; }   // 躲彈幕有自己的畫面（即時場地）
  if (isPlGame(tb?.game)) { buildPlanet(box, v, mk, gd); return; }   // 星球合成有自己的畫面
  if (tb?.game === 'breakout') { buildBreakout(box, v, mk, gd); return; }   // 打磚塊有自己的畫面
  if (tb?.game === 'g2048') { buildG2048(box, v, mk, gd); return; }   // 2048 有自己的畫面
  if (tb?.game === 'bubble') { buildBubble(box, v, mk, gd); return; }   // 泡泡射手有自己的畫面
  if (tb?.game === 'pinball') { buildPinball(box, v, mk, gd); return; }   // 彈珠台有自己的畫面（球檯）
  if (tb?.game === 'slots') { buildSlots(box, v, mk, gd); return; }   // 吃角子老虎機有自己的畫面（三個轉輪）
  if (tb?.game === 'roulette') { buildRoulette(box, v, mk, gd); return; }   // 輪盤有自己的畫面（下注盤）
  if (tb?.game === 'blackjack') { buildBlackjack(box, v, mk, gd); return; }   // 21 點有自己的畫面（莊家、各人的牌、下注與操作）
  if (tb?.game === 'mary') { buildMary(box, v, mk, gd); return; }   // 小瑪莉有自己的畫面（跑馬燈＋押注）
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
}
// ---- 列島建國（第十七桌 t17；2026-11-14，使用者要求）：引擎構築＋共同目標＋事件牌。規則在伺服器（worker 的 kg*、dev_server 的 kg_*）；規格見 docs/kingdom-spec.md。
// 這裡只負責畫面與「預估」：卡面用文字＋顏色（沒有圖）；成本預估 kgcCost 與伺服器的 kgCost 同一套算法，只用來決定按鈕能不能按、超過上限時要丟哪些，最後以伺服器判定為準。
// 協定（tbl）：kt {r, drop?} 拿資源／kr {tier, i（-1＝牌堆頂）, drop?} 保留／kb {s: m 市場 h 手上 p 人物 w 奇觀, tier?, i, drop?} 建造／kx {give, get} 交易／kk {tier, i, pay} 封鎖／kp 跳過；逾時送 timeout。階的欄位不能叫 t（net.tbl 送出是 {t:'tbl', ...m}，會被蓋掉）。
const KG_WIN_VP = 25;   // 勝利分數（要和兩份伺服器的 KG_WIN_VP 一致）
const KG_RN = { W: '木', S: '石', F: '魚', I: '鐵', G: '金' };
const KG_RC = { W: '#a9743f', S: '#8d939b', F: '#4aa8d8', I: '#c0603a', G: '#e8c030' };
function kgLoadData() {   // 牌庫（assets/kingdom/cards.json）：第一次打開這桌時讀，讀完重畫
  if (S.kgData || S.kgLoading) return;
  S.kgLoading = true;
  loadJSON('assets/kingdom/cards.json').then(d => {
    const cards = {};
    for (const k of ['buildings', 'people', 'wonders']) for (const c of d[k]) cards[c.id] = c;
    S.kgData = { cards, events: Object.fromEntries(d.events.map(e => [e.id, e])) };
    S.kgLoading = false; if (S.tableOpen && S.tableView?.game === 'kingdom') buildTable();
  }).catch(() => { S.kgLoading = false; });
}
const kgCardOf = cid => S.kgData?.cards[cid];
function kgStopTimer() { if (S.kgTimer) { clearInterval(S.kgTimer); S.kgTimer = 0; } }
function kgStartTimer(v) {
  kgStopTimer();
  if (S.kgSn !== v.kg.sn) { S.kgSn = v.kg.sn; S.kgOff = v.kg.sn - Date.now(); }   // 伺服器時間 − 本機時間；只在收到新的伺服器畫面時校準（點牌、選資源也會重畫但沒有新畫面，那時 sn 是舊的，重算會讓倒數跳回舊值）
  S.kgTimer = setInterval(() => {
    const cur = S.tableView;
    if (!S.tableOpen || !cur || cur.game !== 'kingdom' || cur.phase !== 'playing') { kgStopTimer(); return; }
    const left = (cur.kg.deadline - (Date.now() + S.kgOff)) / 1000, el = $('kgTimer');
    if (el) { el.textContent = left > 0 ? `${Math.ceil(left)} 秒` : '時間到'; el.classList.toggle('urgent', left <= 15); }
    if (left <= 0 && cur.role === 'seat' && Date.now() - (S.kgTimeoutAt || 0) > 1000) { S.kgTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }
  }, 250);
}
const kgcProd = sd => { const c = { W: 0, S: 0, F: 0, I: 0 }; for (const id of sd.bld) c[kgCardOf(id).gives]++; return c; };
const kgcHas = (sd, ab) => sd.ppl.some(p => kgCardOf(p).ab === ab);
const kgcTotal = sd => sd.res.W + sd.res.S + sd.res.F + sd.res.I + sd.gold;
const kgcLimit = sd => 10 + (kgcHas(sd, 'limit') ? 2 : 0);
function kgcShave(need) { let r = null; for (const k of Object.keys(need)) if (r === null || need[k] > need[r]) r = k; if (r && need[r] > 0) need[r]--; }
// 預估：kind＝b／p／w 的牌，扣掉折扣與事件後要付的資源，以及付得起付不起
function kgcCost(v, cid) {
  const sd = v.kg.sd[v.me], card = kgCardOf(cid), kind = cid[0], need = { ...card.cost };
  if (kind !== 'p') { const prod = kgcProd(sd); for (const r of Object.keys(need)) need[r] = Math.max(0, need[r] - prod[r]); }
  if (kind === 'b' && card.tier === 1 && kgcHas(sd, 't1disc')) kgcShave(need);
  if (v.kg.ev === 'rush') kgcShave(need);
  let deficit = 0; const paid = {};
  for (const [r, n] of Object.entries(need)) { paid[r] = Math.min(n, sd.res[r]); deficit += n - paid[r]; }
  return { need, paid, deficit, can: deficit <= sd.gold };
}
// 這張牌現在能不能建（回 null＝可以，否則回原因）
function kgcWhyNot(v, cid, src) {
  const g = v.kg, sd = g.sd[v.me], card = kgCardOf(cid), kind = cid[0];
  if (v.phase !== 'playing' || v.role !== 'seat' || v.turn !== v.me) return '還沒輪到你';
  if (src === 'm' && g.sd.some(s => s.block === cid) && !kgcHas(sd, 'unblock')) return '被封鎖了';
  if (kind === 'b' && g.ev === 'storm' && 'F' in card.cost) return '風暴：這輪不能蓋含魚獲成本的建築';
  if (kind === 'p' && sd.bld.length < card.need) return `要先有 ${card.need} 棟建築（你有 ${sd.bld.length} 棟）`;
  if (kind === 'w') { const prod = kgcProd(sd); const miss = Object.entries(card.req).filter(([r, n]) => prod[r] < n); if (miss.length) return '前置不足：' + miss.map(([r, n]) => `${KG_RN[r]}產出 ${n} 棟（你有 ${prod[r]}）`).join('、'); }
  const c = kgcCost(v, cid);
  if (!c.can) return `資源不足（還差 ${c.deficit - sd.gold} 個）`;
  return null;
}
// 動作做完後的資源（預估）：{ res, gold }；用來判斷有沒有超過上限
function kgcAfter(v, act) {
  const sd = v.kg.sd[v.me], res = { ...sd.res }; let gold = sd.gold;
  if (act.a === 'kt') {
    if (act.r.length === 2 && act.r[0] === act.r[1]) res[act.r[0]] += Math.min(2 + (v.kg.ev === 'harvest' ? 1 : 0) + (kgcHas(sd, 'pair') ? 1 : 0), v.kg.sup[act.r[0]]);
    else for (const r of act.r) res[r] += 1;
  }
  else if (act.a === 'kr') gold += Math.min(1 + (v.kg.ev === 'muse' ? 1 : 0) + (kgcHas(sd, 'gold2') ? 1 : 0), v.kg.gold);
  else if (act.a === 'kb') {
    const cid = act.cid, c = kgcCost(v, cid), card = kgCardOf(cid);
    for (const [r, n] of Object.entries(c.paid)) res[r] -= n;
    gold -= c.deficit;
    if (cid[0] === 'b' && card.fx?.k === 'gain') res[card.fx.res] += Math.min(card.fx.n, v.kg.sup[card.fx.res] + (c.paid[card.fx.res] || 0));
    if (cid[0] === 'p' && v.kg.ev === 'festival' && v.kg.gold + c.deficit > 0) gold += 1;
  }
  return { res, gold };
}
// 送出主要動作；超過資源上限就先開「要丟哪些」的選擇
function kgSend(v, act) {
  const o = S.kg, { res, gold } = kgcAfter(v, act), sd = v.kg.sd[v.me], over = res.W + res.S + res.F + res.I + gold - kgcLimit(sd);
  const msg = { ...act }; delete msg.cid;
  if (over > 0) { o.pend = { msg, over, res, gold, drop: {} }; buildTable(); return; }
  S.net?.tbl?.(msg); o.sel = null; o.take = []; o.pend = null;
}
function kgEvText(id) { const e = S.kgData?.events[id]; return e ? `${e.name}：${e.text}` : ''; }
function kgFxText(c) {
  if (!c.fx) return '';
  if (c.fx.k === 'gain') return `建造時拿 ${KG_RN[c.fx.res]}×${c.fx.n}`;
  return c.fx.of === 'people' ? '每位人物 +1 分' : c.fx.of === 'wonder' ? '每座奇觀 +1 分' : '每 2 棟一階建築 +1 分';
}
function kgChips(map, mk) {   // 資源小方塊：{ W: 2, S: 1 } → 「木2 石1」
  const box = mk('span', 'kg-chips');
  for (const r of ['W', 'S', 'F', 'I', 'G']) if (map[r] > 0) { const c = mk('span', 'kg-chip', `${KG_RN[r]}${map[r]}`); c.style.background = KG_RC[r]; box.appendChild(c); }
  return box;
}
// 卡面（建築／人物／奇觀）。src＝來源（m 市場、h 手上、p 人物、w 奇觀），用來決定能不能點、有沒有選取
function kgCardEl(v, cid, src, t, i, mk) {
  const o = S.kg, card = kgCardOf(cid), kind = cid[0], blocked = src === 'm' && v.kg.sd.some(s => s.block === cid);
  const sel = o.sel && o.sel.cid === cid && o.sel.s === src;
  const why = v.role === 'seat' && v.phase === 'playing' ? kgcWhyNot(v, cid, src) : '不是你的回合';
  const el = mk('div', `kg-card k${kind}${kind === 'b' ? ' t' + card.tier : ''}${sel ? ' sel' : ''}${blocked ? ' blocked' : ''}${why === null ? ' afford' : ''}`);
  if (kind === 'b') el.style.borderLeftColor = KG_RC[card.gives];
  const top = mk('div', 'kg-ct');
  if (kind === 'b') { const g = mk('span', 'kg-gv', KG_RN[card.gives]); g.style.background = KG_RC[card.gives]; g.title = `永久折扣：${KG_RN[card.gives]}`; top.appendChild(g); }
  top.appendChild(mk('span', 'kg-cn', card.name));
  if (card.vp) top.appendChild(mk('span', 'kg-vp', String(card.vp)));
  el.appendChild(top);
  el.appendChild(kgChips(card.cost, mk));
  if (kind === 'p') el.appendChild(mk('div', 'kg-fx', `需 ${card.need} 棟建築 · ${card.text}`));
  else if (kind === 'w') el.appendChild(mk('div', 'kg-fx', '前置：' + Object.entries(card.req).map(([r, n]) => `${KG_RN[r]}產出≥${n}`).join(' ')));
  else if (card.fx) el.appendChild(mk('div', 'kg-fx', kgFxText(card)));
  if (blocked) el.appendChild(mk('div', 'kg-lock', '🔒 封鎖中'));
  el.title = why === null ? '可以建造' : why;
  if (v.role === 'seat' && v.phase === 'playing') el.onclick = () => { o.sel = sel ? null : { s: src, t, i, cid }; o.take = []; buildTable(); };
  return el;
}
function buildKingdom(box, v, mk, gd) {
  kgLoadData();
  const playing = v.phase === 'playing', seat = v.role === 'seat', myTurn = playing && seat && v.turn === v.me, g = v.kg;
  if (!playing) kgStopTimer();
  const o = (S.kg ||= { sel: null, take: [], pend: null, give: 'W', get: 'S' });
  if (!playing || !seat) { o.sel = null; o.take = []; o.pend = null; }
  let status;
  if (playing) status = !seat ? `觀戰中 · 輪到 ${v.seats[v.turn]?.name}` : myTurn ? '輪到你：拿資源、保留一張牌，或建造／招募' : `輪到 ${v.seats[v.turn]?.name}`;
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始（每回合限時 90 秒）';
  const st = mk('div', 'table-status' + (myTurn ? ' mine' : ''), status);
  if (playing) { const tm = mk('span', 'bk-timer'); tm.id = 'kgTimer'; st.appendChild(tm); }
  box.appendChild(st);
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  if (!playing && gd?.story) box.appendChild(mk('div', 'it-story', gd.story));   // 開局前：故事背景
  if (!playing) {   // 開局前：座位列（誰入座、誰準備好了），和其他遊戲一樣；開局後改看下面各人的王國
    const row = mk('div', 'table-seats');
    v.seats.forEach(s => {
      const e = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
      e.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      e.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(e);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  }
  if (!S.kgData) { box.appendChild(mk('div', 'table-status', '載入牌庫中…')); }
  else if (g) {
    // 事件（左）＋共同目標（右）併成一列，省高度
    const top = mk('div', 'kg-top');
    if (playing) {
      const ev = mk('div', 'kg-events');
      ev.appendChild(mk('div', 'kg-ev now', `第 ${g.round} 輪　${kgEvText(g.ev)}`));
      ev.appendChild(mk('div', 'kg-ev next', `下一輪　${kgEvText(g.next)}`));
      const n = v.seats.length, ord = Array.from({ length: n }, (_, k) => (g.start + k) % n);   // 出牌順序：從先手開始依座位輪，每一輪都從先手開始
      ev.appendChild(mk('div', 'kg-ev', '順序　' + ord.map((k, j) => `${v.turn === k ? '▶' : ''}${j + 1}.${v.seats[k].name}${v.seats[k].you ? '（你）' : ''}`).join(' → ') + '（每輪從 1 開始）'));
      ev.appendChild(mk('div', 'kg-ev', `人物市場：第 ${Math.ceil(g.round / 5) * 5} 輪結束時整排換新`));   // 與伺服器的 KG_PEOPLE_REFRESH（5）同步
      if (g.endr !== null) ev.appendChild(mk('div', 'kg-ev end', `有人到 ${KG_WIN_VP} 分，這一輪結束後比分`));
      top.appendChild(ev);
    }
    const obj = mk('div', 'kg-objs');
    for (const ob of g.obj) {
      const e = mk('div', 'kg-obj' + (ob.by !== null ? ' done' : ''));
      e.appendChild(mk('b', null, ob.name)); e.appendChild(mk('span', null, ob.text));
      e.appendChild(mk('div', 'kg-obj-by', ob.by !== null ? `✔ ${v.seats[ob.by]?.name || ''} +3 分` : '先達成 +3 分'));
      obj.appendChild(e);
    }
    top.appendChild(obj);
    box.appendChild(top);
    // 市場（左：三階建築＋一排奇觀）＋人物（右）
    const main = mk('div', 'kg-main'), left = mk('div', 'kg-market'), right = mk('div', 'kg-side');
    for (const tier of [3, 2, 1]) {
      const row = mk('div', 'kg-row');
      const dk = mk('div', 'kg-deck', `${['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][tier]} 階
剩 ${g.deck[tier]}`);
      if (myTurn && g.deck[tier] > 0 && g.sd[v.me].nhand < 3 + (kgcHas(g.sd[v.me], 'limit') ? 1 : 0)) { dk.classList.add('pick'); dk.title = '保留牌堆頂（看不到內容，拿 1 枚金幣）'; dk.onclick = () => kgSend(v, { a: 'kr', tier, i: -1 }); }
      row.appendChild(dk);
      g.mkt[tier].forEach((cid, i) => row.appendChild(cid ? kgCardEl(v, cid, 'm', tier, i, mk) : mk('div', 'kg-card empty')));
      left.appendChild(row);
    }
    const wrow = mk('div', 'kg-row');
    const wl = mk('div', 'kg-deck', '奇觀'); wl.title = '每座只有一人能蓋'; wrow.appendChild(wl);
    g.wond.forEach((cid, i) => wrow.appendChild(cid ? kgCardEl(v, cid, 'w', 0, i, mk) : mk('div', 'kg-card empty')));
    left.appendChild(wrow);
    right.appendChild(mk('div', 'table-label', `人物（剩 ${g.pdeck} 張）`));
    g.pmkt.forEach((cid, i) => right.appendChild(cid ? kgCardEl(v, cid, 'p', 0, i, mk) : mk('div', 'kg-card empty')));
    main.appendChild(left); main.appendChild(right); box.appendChild(main);
    // 庫存列：點資源挑要拿的（3 張不同，或同一種點兩次＝拿 2 張）
    const sup = mk('div', 'kg-supply');
    sup.appendChild(mk('span', 'table-label', '庫存（點選要拿的資源）：'));
    for (const r of ['W', 'S', 'F', 'I']) {
      const b = mk('button', 'kg-res' + (o.take.filter(x => x === r).length ? ' on' : ''), `${KG_RN[r]} ${g.sup[r]}${o.take.filter(x => x === r).length ? ` ×${o.take.filter(x => x === r).length}` : ''}`);
      b.style.borderColor = KG_RC[r]; b.disabled = !myTurn || g.sup[r] <= 0;
      b.onclick = () => {
        const n = o.take.filter(x => x === r).length;
        if (n >= 1 && o.take.length === 1 && g.sup[r] >= 4 && g.ev !== 'drought') o.take = [r, r];   // 第二次點同一種＝拿 2 張同種
        else if (n >= 1) {
          if (o.take.length === 1) toast(g.ev === 'drought' ? '乾旱：這輪不能拿 2 張同種' : `${KG_RN[r]}庫存只剩 ${g.sup[r]}，要有 4 張以上才能拿 2 張同種（已取消選取）`, 2600);   // 點第二次沒變成 2 張時說明原因，不要默默取消
          o.take = o.take.filter(x => x !== r);
        }
        else if (o.take.length === 2 && o.take[0] === o.take[1]) o.take = [r];
        else if (o.take.length < 3) o.take = [...o.take, r];
        o.sel = null; buildTable();
      };
      sup.appendChild(b);
    }
    sup.appendChild(mk('span', 'table-label', `　金幣 ${g.gold}（保留時才拿得到）`));
    box.appendChild(sup);
    // 動作列（我的回合）
    if (myTurn) {
      const act = mk('div', 'kg-actions'), sd = g.sd[v.me];
      const avail = ['W', 'S', 'F', 'I'].filter(r => g.sup[r] > 0), need = Math.min(3, avail.length);
      const pair = o.take.length === 2 && o.take[0] === o.take[1];
      const takeOk = o.take.length > 0 && (pair || (new Set(o.take).size === o.take.length && o.take.length === need));
      if (o.take.length) {
        const b = mk('button', 'ff-btn', pair ? `拿 2 張 ${KG_RN[o.take[0]]}` : `拿 ${o.take.map(r => KG_RN[r]).join('、')}`);
        b.disabled = !takeOk; b.onclick = () => kgSend(v, { a: 'kt', r: o.take });
        act.appendChild(b);
        if (!takeOk) act.appendChild(mk('span', 'table-tag', `要拿 ${need} 種不同的，或同一種點兩次（庫存 ≥4）`));
      }
      if (o.sel) {
        const cid = o.sel.cid, card = kgCardOf(cid), why = kgcWhyNot(v, cid, o.sel.s), c = kgcCost(v, cid);
        act.appendChild(mk('b', 'kg-selname', card.name));
        act.appendChild(mk('span', 'table-tag', '實付：'));
        act.appendChild(Object.values(c.need).some(n => n > 0) ? kgChips(c.need, mk) : mk('span', 'table-tag', '免費'));
        if (c.deficit) act.appendChild(mk('span', 'table-tag', `（用 ${c.deficit} 枚金幣補）`));
        const bb = mk('button', 'ff-btn', cid[0] === 'p' ? '招募' : '建造'); bb.disabled = why !== null; bb.title = why || '';
        const sl = o.sel; bb.onclick = () => kgSend(v, { a: 'kb', s: sl.s, tier: sl.t, i: sl.i, cid });   // 先把選取存起來：kgSend 送出後會清掉 o.sel
        act.appendChild(bb);
        if (why) act.appendChild(mk('span', 'table-tag', why));
        if (o.sel.s === 'm') {
          const rb = mk('button', 'ff-btn small', '保留'), blocked = g.sd.some(s => s.block === cid);
          rb.disabled = blocked || sd.nhand >= 3 + (kgcHas(sd, 'limit') ? 1 : 0); rb.title = '收進手上（最多 3 張），拿 1 枚金幣';
          rb.onclick = () => kgSend(v, { a: 'kr', tier: sl.t, i: sl.i });
          const kb = mk('button', 'ff-btn small', g.ev === 'marketday' ? '封鎖（免費）' : '封鎖（付 1 資源）');
          const pay = ['W', 'S', 'F', 'I'].sort((a, b) => sd.res[b] - sd.res[a])[0];
          kb.disabled = blocked || sd.blk || (g.ev !== 'marketday' && sd.res[pay] < 1); kb.title = '到你下個回合開始前，別人不能買也不能保留這張牌（你自己也不能買）';
          kb.onclick = () => { S.net?.tbl?.({ a: 'kk', tier: sl.t, i: sl.i, pay }); o.sel = null; buildTable(); };
          act.appendChild(rb); act.appendChild(kb);
        }
      }
      // 銀行交易（每回合一次，不佔回合）
      const rate = g.ev === 'tradewind' || kgcHas(sd, 'trade') ? 2 : 3, tr = mk('span', 'kg-trade');
      tr.appendChild(mk('span', 'table-tag', `交易（${rate}:1）`));
      const mkSel = (key) => { const s = document.createElement('select'); for (const r of ['W', 'S', 'F', 'I']) { const op = document.createElement('option'); op.value = r; op.textContent = KG_RN[r]; if (o[key] === r) op.selected = true; s.appendChild(op); } s.onchange = () => { o[key] = s.value; }; return s; };
      tr.appendChild(mkSel('give')); tr.appendChild(mk('span', 'table-tag', '→')); tr.appendChild(mkSel('get'));
      const tb = mk('button', 'ff-btn small', '交易'); tb.disabled = sd.traded || g.ev === 'notrade'; tb.title = g.ev === 'notrade' ? '封港：這輪不能交易' : sd.traded ? '這回合已交易過' : '';
      tb.onclick = () => S.net?.tbl?.({ a: 'kx', give: o.give, get: o.get }); tr.appendChild(tb);
      act.appendChild(tr);
      const pb = mk('button', 'ff-btn small', '跳過'); pb.onclick = () => S.net?.tbl?.({ a: 'kp' }); act.appendChild(pb);
      box.appendChild(act);
      // 超過上限：選要丟哪些
      if (o.pend) {
        const p = o.pend, pd = mk('div', 'kg-drop'), dropped = Object.values(p.drop).reduce((a, b) => a + b, 0);
        pd.appendChild(mk('div', 'table-status mine', `手上會超過上限，請選 ${p.over} 張丟掉（已選 ${dropped}）`));
        const row = mk('div', 'kg-supply');
        for (const r of ['W', 'S', 'F', 'I', 'G']) {
          const have = (r === 'G' ? p.gold : p.res[r]) - (p.drop[r] || 0);
          if ((r === 'G' ? p.gold : p.res[r]) <= 0) continue;
          const b = mk('button', 'kg-res', `${KG_RN[r]} ${have}${p.drop[r] ? `（丟 ${p.drop[r]}）` : ''}`); b.style.borderColor = KG_RC[r];
          b.onclick = () => { if (dropped < p.over && have > 0) p.drop[r] = (p.drop[r] || 0) + 1; buildTable(); };
          b.oncontextmenu = e => { e.preventDefault(); if (p.drop[r]) { p.drop[r]--; if (!p.drop[r]) delete p.drop[r]; } buildTable(); };
          row.appendChild(b);
        }
        pd.appendChild(row);
        const bs = mk('div', 'table-btns'), ok = mk('button', 'ff-btn', '確定'), no = mk('button', 'ff-btn small', '取消'), rs = mk('button', 'ff-btn small', '重選');
        ok.disabled = dropped !== p.over; ok.onclick = () => { S.net?.tbl?.({ ...p.msg, drop: p.drop }); o.sel = null; o.take = []; o.pend = null; buildTable(); };
        no.onclick = () => { o.pend = null; buildTable(); }; rs.onclick = () => { p.drop = {}; buildTable(); };
        bs.appendChild(ok); bs.appendChild(rs); bs.appendChild(no); pd.appendChild(bs); box.appendChild(pd);
      }
    }
    // 各人的王國
    const boards = mk('div', 'kg-boards');
    v.seats.forEach((s, k) => {
      const sd = g.sd[k], you = s.you, e = mk('div', 'kg-board' + (you ? ' you' : '') + (playing && v.turn === k ? ' turn' : '') + (sd.done ? ' out' : ''));
      const nm = mk('div', 'kg-bn', `${playing ? `${(k - g.start + v.seats.length) % v.seats.length + 1}. ` : ''}${s.name}${you ? '（你）' : ''}${playing && k === g.start ? '（先手）' : ''}${s.left ? '（已離開）' : sd.forfeit ? '（棄權）' : ''}`);
      nm.appendChild(mk('span', 'kg-bvp', `${sd.vp} 分`)); e.appendChild(nm);
      const rr = mk('div', 'kg-brow'); rr.appendChild(mk('span', 'table-tag', '資源：')); rr.appendChild(kgChips({ ...sd.res, G: sd.gold }, mk));
      if (!kgcTotal(sd)) rr.appendChild(mk('span', 'table-tag', '（空）')); e.appendChild(rr);
      const pr = kgcProd(sd), dr = mk('div', 'kg-brow'); dr.appendChild(mk('span', 'table-tag', '折扣：')); dr.appendChild(kgChips(pr, mk)); if (!Object.values(pr).some(n => n)) dr.appendChild(mk('span', 'table-tag', '（無）')); e.appendChild(dr);
      const list = (ids, label) => { if (!ids.length) return; const d = mk('div', 'kg-brow'); d.appendChild(mk('span', 'table-tag', label)); for (const id of ids) { const c = kgCardOf(id), t = mk('span', 'kg-mini', c.name + (c.vp ? ` ${c.vp}` : '')); if (id[0] === 'b') t.style.borderLeftColor = KG_RC[c.gives]; t.title = id[0] === 'p' ? c.text : id[0] === 'b' ? `${['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][c.tier]} 階建築${c.fx ? '：' + kgFxText(c) : ''}` : (c.fx ? kgFxText(c) : ''); d.appendChild(t); } e.appendChild(d); };
      list(sd.bld, `建築 ${sd.bld.length}：`); list(sd.ppl, '人物：'); list(sd.won, '奇觀：');
      if (g.hands?.[k]?.length) list(g.hands[k], `保留 ${g.hands[k].length} 張：`);   // 觀戰者（含大螢幕）看得到每個人保留的牌
      else if (sd.nhand && !you) e.appendChild(mk('div', 'table-tag', `保留 ${sd.nhand} 張`));
      if (sd.block) e.appendChild(mk('div', 'table-tag', `🔒 封鎖了「${kgCardOf(sd.block)?.name || ''}」`));
      if (you && g.hand.length) {
        const d = mk('div', 'kg-hand'); d.appendChild(mk('div', 'table-label', '你保留的牌（點選可建造）'));
        g.hand.forEach((cid, i) => d.appendChild(kgCardEl(v, cid, 'h', 0, i, mk)));
        e.appendChild(d);
      }
      boards.appendChild(e);
    });
    box.appendChild(boards);
    if (playing) kgStartTimer(v);
  }
  // 上一局的成績
  if (!playing && v.result?.players) {
    const sc = mk('div', 'bk-score');
    [...v.result.players].map((p, k) => ({ p, k })).sort((a, b) => b.p.vp - a.p.vp).forEach(({ p, k }) => {
      sc.appendChild(mk('div', 'bk-score-line' + (v.result.winners.includes(k) ? ' win' : ''), `${p.name}${p.left ? '（離開）' : p.forfeit ? '（棄權）' : ''}　${p.vp} 分　建築 ${p.bld}・人物 ${p.ppl}・奇觀 ${p.won}`));
    });
    box.appendChild(sc);
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
  const log = mk('div', 'table-log kg-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
}
// ---- 大老二（第十八桌 t18；2026-11-14，使用者要求）：2～4 人、單局。規則在伺服器（worker 的 bt*、dev_server 的 bt_*）；這裡只負責畫面與「預估」：
// btCombo／btBeats 與伺服器同一套，只用來決定「出牌」鈕能不能按，最後以伺服器判定為準。
// 協定（tbl）：bplay {cs: [牌]} 出牌／bpass pass；逾時送 timeout。牌面編碼同 UNO／抽鬼牌（'S1'＝A、'S2'＝2），大小 3 < … < K < A < 2，花色 ♣ < ♦ < ♥ < ♠。
const BT_SUIT = { C: 0, D: 1, H: 2, S: 3 };
const btVal = c => { const r = Number(c.slice(1)); return r === 1 ? 14 : r === 2 ? 15 : r; };
const btKey = c => [btVal(c), BT_SUIT[c[0]]];
const btCmpKey = (a, b) => a[0] - b[0] || a[1] - b[1];
const btCmpCard = (a, b) => btCmpKey(btKey(a), btKey(b));
function btCombo(cs) {   // → [張數, 五張牌型階級 0～5, [點數, 花色]]；不成牌型回 null
  const n = cs.length;
  if (![1, 2, 5].includes(n) || new Set(cs).size !== n) return null;
  const ks = cs.map(btKey).sort(btCmpKey);
  if (n === 1) return [1, 0, ks[0]];
  if (n === 2) return ks[0][0] === ks[1][0] ? [2, 0, ks[1]] : null;
  const vals = ks.map(k => k[0]), cnt = {};
  for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
  const flush = new Set(ks.map(k => k[1])).size === 1;
  const straight = Object.keys(cnt).length === 5 && vals[4] - vals[0] === 4 && vals[4] <= 14;
  const shape = Object.values(cnt).sort((a, b) => a - b).join(',');
  const of = c => Number(Object.keys(cnt).find(v => cnt[v] === c));
  if (straight && flush) return [5, 5, ks[4]];
  if (shape === '1,4') return [5, 4, [of(4), 0]];
  if (shape === '2,3') return [5, 3, [of(3), 0]];
  if (flush) return [5, 2, ks[4]];
  if (straight) return [5, 1, ks[4]];
  return null;
}
const btBeats = (nw, last) => nw[0] === last[0] && (nw[1] - last[1] || btCmpKey(nw[2], last[2])) > 0;
const BT_COMBO_NAME = { 1: '單張', 2: '對子' }, BT_FIVE_NAME = ['', '順子', '同花', '葫蘆', '鐵支', '同花順'];
const btComboName = cb => (cb ? (cb[0] === 5 ? BT_FIVE_NAME[cb[1]] : BT_COMBO_NAME[cb[0]]) : '');
function btStopTimer() { if (S.btTimer) { clearInterval(S.btTimer); S.btTimer = 0; } }
function btStartTimer(v) {
  btStopTimer();
  S.btOff = v.bt.sn - Date.now();   // 伺服器時間 − 本機時間
  S.btTimer = setInterval(() => {
    const cur = S.tableView;
    if (!S.tableOpen || !cur || cur.game !== 'bigtwo' || cur.phase !== 'playing') { btStopTimer(); return; }
    const left = (cur.bt.deadline - (Date.now() + S.btOff)) / 1000, el = $('btTimer');
    if (el) { el.textContent = left > 0 ? `${Math.ceil(left)} 秒` : '時間到'; el.classList.toggle('urgent', left <= 10); }
    if (left <= 0 && cur.role === 'seat' && Date.now() - (S.btTimeoutAt || 0) > 1000) { S.btTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }
  }, 250);
}
function buildBigTwo(box, v, mk, gd) {
  const playing = v.phase === 'playing', seat = v.role === 'seat', myTurn = playing && seat && v.turn === v.me, g = v.bt;
  if (!playing) btStopTimer();
  const o = (S.bt ||= { sel: [], turn: -1 });
  if (!playing || !seat || !myTurn || o.turn !== v.turn || (g && o.last !== (g.last ? g.last.cs.join() : ''))) o.sel = [];   // 換人、換上一手、不是自己的回合：選取歸零
  o.sel = o.sel.filter(c => (v.hand || []).includes(c));
  o.turn = v.turn; o.last = g?.last ? g.last.cs.join() : '';
  let status;
  if (playing) status = !seat ? `觀戰中 · 輪到 ${v.seats[v.turn]?.name}` : myTurn ? (g.last ? `輪到你：壓過 ${v.seats[g.last.seat]?.name} 的${btComboName(btCombo(g.last.cs))}，或 pass` : g.first ? `輪到你：第一手要含 ${SUIT_SYM[g.start[0]]}${g.start.slice(1) === '1' ? 'A' : g.start.slice(1)}` : '輪到你：領出任何牌型') : `輪到 ${v.seats[v.turn]?.name}`;
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始（每回合限時 45 秒）';
  const st = mk('div', 'table-status' + (myTurn ? ' mine' : ''), status);
  if (playing) { const tm = mk('span', 'bk-timer'); tm.id = 'btTimer'; st.appendChild(tm); }
  box.appendChild(st);
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  // 座位
  const row = mk('div', 'table-seats');
  v.seats.forEach((s, i) => {
    const e = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (s.left || s.fo ? ' out' : ''));
    e.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : s.fo ? '（棄權）' : '')));
    e.appendChild(mk('div', 'table-tag', playing ? (s.left || s.fo ? '' : `${s.n} 張${s.n <= 3 ? ' ⚠' : ''}${v.turn === i ? ' · 出牌中' : ''}`) : (s.ready ? '已準備' : '未準備')));
    if (playing && v.hands && !s.left && !s.fo) {   // 觀戰：每個人的牌都翻開
      const cs = mk('div', 'table-cards bt-spec');
      for (const c of v.hands[i] || []) cs.appendChild(cardEl(c));
      e.appendChild(cs);
    }
    row.appendChild(e);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  // 桌面：最後一手
  if (playing) {
    const mid = mk('div', 'bt-mid');
    if (g.last) {
      mid.appendChild(mk('div', 'table-tag', `${v.seats[g.last.seat]?.name || ''} 出了${btComboName(btCombo(g.last.cs))}${g.passes ? `（已 ${g.passes} 人 pass）` : ''}`));
      const cs = mk('div', 'table-cards big');
      for (const c of g.last.cs) cs.appendChild(cardEl(c));
      mid.appendChild(cs);
    } else mid.appendChild(mk('div', 'table-tag', g.first ? `開局：持有最小牌的人先出，這一手要含 ${SUIT_SYM[g.start[0]]}${g.start.slice(1) === '1' ? 'A' : g.start.slice(1)}` : '新的一手：誰出都行（單張、對子、五張牌型）'));
    box.appendChild(mid);
    btStartTimer(v);
  }
  // 我的手牌：點一下選起來（再點取消）
  if (seat && playing) {
    const hand = mk('div', 'table-hand'), cs = mk('div', 'table-cards big bt-hand');
    for (const c of v.hand || []) {
      const el = cardEl(c), on = o.sel.includes(c);
      el.classList.add('bt-card'); if (on) el.classList.add('bt-sel');
      el.onclick = () => { o.sel = on ? o.sel.filter(x => x !== c) : [...o.sel, c]; buildTable(); };
      cs.appendChild(el);
    }
    hand.appendChild(cs); box.appendChild(hand);
  }
  // 操作按鈕
  const btns = mk('div', 'table-btns');
  if (seat && playing) {
    const cb = o.sel.length ? btCombo(o.sel) : null;
    let why = '';
    if (!myTurn) why = '還沒輪到你';
    else if (!o.sel.length) why = '先點選要出的牌';
    else if (!cb) why = '不是合法牌型（單張、對子、五張：順子／同花／葫蘆／鐵支／同花順）';
    else if (g.first && !o.sel.includes(g.start)) why = '第一手要含開局牌';
    else if (g.last && !btBeats(cb, btCombo(g.last.cs))) why = g.last.cs.length === o.sel.length ? '要比桌面上那手大' : `要出 ${g.last.cs.length} 張`;
    const play = mk('button', 'ff-btn', cb ? `出牌（${btComboName(cb)}）` : '出牌');
    play.disabled = !!why; play.title = why;
    play.onclick = () => { S.net?.tbl?.({ a: 'bplay', cs: o.sel }); o.sel = []; };
    btns.appendChild(play);
    const pass = mk('button', 'ff-btn', 'pass'); pass.disabled = !v.canPass; pass.title = v.canPass ? '' : myTurn ? '領出時不能 pass' : '還沒輪到你';
    pass.onclick = () => S.net?.tbl?.({ a: 'bpass' });
    btns.appendChild(pass);
    if (o.sel.length) { const clr = mk('button', 'ff-btn small', '取消選取'); clr.onclick = () => { o.sel = []; buildTable(); }; btns.appendChild(clr); }
  } else if (seat) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const sb = mk('button', 'ff-btn small', '改為觀戰'); sb.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(sb);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  // 上一局：每人剩幾張
  if (!playing && v.result?.players) {
    const sc = mk('div', 'bk-score');
    v.result.players.forEach((p, k) => sc.appendChild(mk('div', 'bk-score-line' + (v.result.winner === k ? ' win' : ''), `${p.name}${p.left ? '（離開）' : p.forfeit ? '（棄權）' : ''}　${v.result.winner === k ? '出完了' : p.left || p.forfeit ? '' : `剩 ${p.n} 張`}`)));
    box.appendChild(sc);
  }
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
}
// ---- 淨土守護戰（第二十一桌 t21；2026-11-17，使用者要求）：2～4 人合作。規則全在伺服器（worker 的 pg*、dev_server 的 pg_*）；這裡只畫畫面與「預估」：
// pgNbrs 與伺服器同一套，只用來標出「可以點的格子」，最後以伺服器判定為準。協定（tbl）：pmove {to}／pclean {tiles}／pgive {to, c}／pcollect／psynth／
// puse {c:'Ispray', tile}／{c:'Itele', from, to}／pdiscard {c}／pend；逾時送 timeout。v.pg：tiles（'g0'＝區域＋狀態 0 乾淨／1 污染／2 荒廢）、pawn、role、got、hands⋯⋯
const PG_REGIONS = ['g', 'f', 'm', 'w'];
const PG_RNAME = { g: '草原', f: '森林', m: '礦區', w: '濕地', L: '研究院' };
const PG_RCOL = { g: '#5aa84a', f: '#2f7a4a', m: '#8a8f98', w: '#3a8fb8', L: '#e8f0f0' };
const PG_ROLE = {
  medic: ['防疫員', '可以穿過荒廢的土地'], chemist: ['化學師', '一次行動清潔兩格'], courier: ['通訊員', '不必同格就能給牌'],
  sampler: ['採樣員', '3 張採樣牌就能取素材'], scout: ['偵察兵', '可以斜向移動、清潔'], weather: ['氣象員', '看得到擴散牌庫頂的下一張'],
};
const PG_SEATCOL = ['#4aa8ff', '#ffd24a', '#ff6a6a', '#6aff9a'];
const PG_D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]], PG_D8 = [...PG_D4, [1, -1], [1, 1], [-1, 1], [-1, -1]];
const pgCardName = c => (c === 'Ispray' ? '淨化噴霧' : c === 'Itele' ? '傳送器' : `${PG_RNAME[c[1]]}採樣`);
// 污染等級量表（2026-11-17 使用者要求：放左邊做成垂直的量表）：由下往上 1～7 級，每級旁邊寫每回合翻幾張擴散牌，最上面是 8＝輸；目前的等級亮起
// 螢幕中央的大提示（kind＝boom 紅／lock 橘）：掛在 body 上不受牌桌重畫影響，3.2 秒後自己消失；爆發時整個牌桌震一下
function pgBanner(kind, title, sub) {
  const b = mk2('div', 'pg-banner ' + kind); b.appendChild(mk2('b', null, title)); b.appendChild(mk2('span', null, sub));
  let box = $('pgBanners'); if (!box) { box = mk2('div'); box.id = 'pgBanners'; document.body.appendChild(box); }   // 同時有爆發＋封鎖時上下排開，不疊在一起
  box.appendChild(b); setTimeout(() => b.remove(), 3200);
  if (kind === 'boom') { const tb = $('tableBox'); tb.classList.remove('pg-shake'); void tb.offsetWidth; tb.classList.add('pg-shake'); setTimeout(() => tb.classList.remove('pg-shake'), 600); }
}
function pgGauge(g) {
  const box = mk2('div', 'pg-gauge');
  box.appendChild(mk2('div', 'pg-g-top', '☠ 8\n輸'));
  for (let l = g.lose - 1; l >= 1; l--) {
    const draws = PG_LV_DRAWS[l] ?? 5, seg = mk2('div', 'pg-g-seg' + (l === g.lvl ? ' cur' : '') + (l < g.lvl ? ' past' : '') + (l >= g.lose - 2 ? ' hot' : ''));
    seg.appendChild(mk2('b', null, String(l))); seg.appendChild(mk2('small', null, `翻${draws}`));
    seg.title = `污染等級 ${l}：每回合翻 ${draws} 張擴散牌${l === g.lvl ? '（現在）' : ''}`;
    box.appendChild(seg);
  }
  box.appendChild(mk2('div', 'pg-g-lbl', '污染\n等級'));
  return box;
}
const PG_LV_DRAWS = [0, 2, 2, 3, 3, 4, 4, 5];   // 與兩份伺服器的 PG_LV_DRAWS 一致
const mk2 = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// 上一次翻出的擴散牌（2026-11-17 使用者要求：放右邊上面）：最新的一張放大，後面是更早的幾張；牌上寫打到哪一格（伺服器記錄翻牌當下打到的格子 g.rc）
function pgLastCards(v, g, mk) {
  const box = mk('div', 'pg-last'), rc = [...(g.rc || [])].reverse();
  box.appendChild(mk('div', 'pg-sd-h', '上一次翻出的擴散牌'));
  if (!rc.length) { box.appendChild(mk('div', 'table-tag', '還沒有翻過')); return box; }
  const tn = i => { if (i < 0) return '那一條已經沒有格子'; const t = pgTile(v, i); return `${PG_RNAME[t.r]}(${i % 5 + 1},${Math.floor(i / 5) + 1})`; };
  const [c0, i0] = rc[0], big = mk('div', 'pg-last-big');
  big.appendChild(mk('div', 'pg-last-dir', pgDirName(c0)));
  big.appendChild(mk('div', 'pg-last-hit', i0 < 0 ? tn(i0) : `→ 打在${tn(i0)}`));
  box.appendChild(big);
  if (rc.length > 1) {
    const row = mk('div', 'pg-last-row');
    for (const [c, i] of rc.slice(1)) { const e = mk('div', 'pg-last-s', pgDirName(c)); e.title = i < 0 ? tn(i) : `打在${tn(i)}`; row.appendChild(e); }
    box.appendChild(row);
  }
  return box;
}
// 擴散牌一覽（2026-11-17 使用者要求「介面上展示事件牌，只靠上下的小字不方便看」）：20 張牌排成 4 個方向 × 5 條線的表，翻過的（＝棄牌堆）變暗並標第幾張翻出、最近一張金框、氣象員看到的下一張藍框；
// 滑鼠停在格子上會寫出這張牌現在會打到哪一格（pgHitTile 與伺服器 pgHit 同一套）。污染爆發時棄牌堆會洗回牌庫頂，所以暗的那些就是「馬上會再被打一次」的地方。
const pgHitTile = (v, c) => { const d = c[0], l = +c[1]; for (let k = 0; k < 5; k++) { const i = d === 'N' ? k * 5 + l : d === 'S' ? (4 - k) * 5 + l : d === 'W' ? l * 5 + k : l * 5 + (4 - k); if (pgTile(v, i).s !== 2) return i; } return -1; };
function pgSpreadPanel(v, g, mk) {
  const box = mk('div', 'pg-sd'), order = new Map(); g.sdd.forEach((c, k) => order.set(c, k + 1));
  box.appendChild(mk('div', 'pg-sd-h', `擴散牌（牌庫 ${g.sd} 張・已翻 ${g.sdd.length} 張）　數字＝第幾條線；暗＝已翻過（#是第幾張翻出，污染爆發時洗回牌庫頂）；金框＝最近一張${g.peek ? '・藍框＝氣象員偵測的下一張' : ''}`));
  const grid = mk('div', 'pg-sd-grid');
  for (const d of 'NSWE') {
    grid.appendChild(mk('div', 'pg-sd-lbl', `${{ N: '北', S: '南', W: '西', E: '東' }[d]}（${'NS'.includes(d) ? '欄' : '列'}）`));
    for (let l = 0; l < 5; l++) {
      const c = d + l, n = order.get(c), hit = pgHitTile(v, c), tt = hit < 0 ? null : pgTile(v, hit);
      const el = mk('div', 'pg-sd-c' + (n ? ' used' : '') + (n && n === g.sdd.length ? ' last' : '') + (g.peek === c ? ' peek' : ''), String(l + 1));
      if (n) el.appendChild(mk('small', null, `#${n}`));
      el.title = `${pgDirName(c)}：${tt ? `會打在${PG_RNAME[tt.r]}(${hit % 5 + 1},${Math.floor(hit / 5) + 1})` : '這一條已經沒有格子了'}${n ? `（第 ${n} 張翻出）` : ''}`;
      grid.appendChild(el);
    }
  }
  box.appendChild(grid); return box;
}
const pgDirName = c => `${{ N: '北', S: '南', W: '西', E: '東' }[c[0]]}${'NS'.includes(c[0]) ? '第' + (Number(c[1]) + 1) + '欄' : '第' + (Number(c[1]) + 1) + '列'}`;
const pgTile = (v, i) => ({ r: v.pg.tiles[i][0], s: Number(v.pg.tiles[i][1]) });
function pgNbrs(v, seat, from, through) {   // 與伺服器 pgNbrs 同一套
  const role = v.pg.role[seat], dirs = role === 'scout' ? PG_D8 : PG_D4, out = new Set(), seen = new Set([from]), q = [from];
  while (q.length) {
    const c = q.shift(), cx = c % 5, cy = (c - cx) / 5;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx > 4 || ny > 4) continue;
      const n = ny * 5 + nx;
      if (pgTile(v, n).s !== 2) out.add(n);
      else if (through && role === 'medic' && !seen.has(n)) { seen.add(n); q.push(n); }
    }
  }
  out.delete(from);
  return [...out];
}
function pgStopTimer() { if (S.pgTimer) { clearInterval(S.pgTimer); S.pgTimer = 0; } }
function pgStartTimer(v) {
  pgStopTimer();
  S.pgOff = v.pg.sn - Date.now();   // 伺服器時間 − 本機時間
  S.pgTimer = setInterval(() => {
    const cur = S.tableView;
    if (!S.tableOpen || !cur || cur.game !== 'purify' || cur.phase !== 'playing') { pgStopTimer(); return; }
    const left = (cur.pg.deadline - (Date.now() + S.pgOff)) / 1000, el = $('pgTimer');
    if (el) { el.textContent = left > 0 ? `${Math.ceil(left)} 秒` : '時間到'; el.classList.toggle('urgent', left <= 15); }
    if (left <= 0 && cur.role === 'seat' && Date.now() - (S.pgTimeoutAt || 0) > 1000) { S.pgTimeoutAt = Date.now(); S.net?.tbl?.({ a: 'timeout' }); }
  }, 250);
}
function buildPurify(box, v, mk, gd) {
  const playing = v.phase === 'playing', seat = v.role === 'seat', g = v.pg, myTurn = playing && seat && v.turn === v.me;
  if (!playing) pgStopTimer();
  // 污染爆發／鄰國封鎖的醒目提示（2026-11-18 使用者要求）：用狀態變化偵測（日誌只留 8 行，一回合可能蓋掉），第一次看到的牌局只記基準、不跳提示
  if (playing && g) {
    const ps = S.pgSeen;
    if (ps && ps.id === S.tableId) {
      if (g.lvl > ps.lvl) pgBanner('boom', `☣ 污染爆發！`, `污染等級 ${ps.lvl} → ${g.lvl}　每回合翻 ${PG_LV_DRAWS[g.lvl] ?? 5} 張擴散牌`);
      if (g.block >= 0 && g.block !== ps.block) { const bt = pgTile(v, g.block); pgBanner('lock', `🔒 鄰國封鎖！`, `${PG_RNAME[bt.r]}(${g.block % 5 + 1},${Math.floor(g.block / 5) + 1}) 一輪內不能清潔`); }
    }
    S.pgSeen = { id: S.tableId, lvl: g.lvl, block: g.block };
  } else S.pgSeen = null;
  const o = (S.pgUi ||= { mode: 'move', sel: [], card: null, from: null });
  if (!playing || (!myTurn && ['move', 'clean', 'give'].includes(o.mode))) { o.mode = 'move'; o.sel = []; o.card = null; o.from = null; }   // 道具（噴霧／傳送器）不限回合，其餘模式只有自己的回合才留著
  let status;
  if (playing) {
    const who = v.seats[v.turn]?.name;
    status = !seat ? `觀戰中 · 輪到 ${who}` : g.step === 'discard' ? (myTurn ? `手牌超過 5 張：點一張要丟掉的牌` : `輪到 ${who}：丟牌中`) : g.hands.some(h => h.length > 5) ? (g.hands[v.me]?.length > 5 ? '你的手牌超過 5 張：點一張要丟掉的牌（或用掉道具）' : `${v.seats[g.hands.findIndex(h => h.length > 5)].name} 手牌超過 5 張，丟牌中⋯`) : myTurn ? `輪到你：還有 ${g.acts} 點行動` : `輪到 ${who}`;
  } else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始（每回合限時 120 秒）';
  const st = mk('div', 'table-status' + (myTurn ? ' mine' : ''), status);
  if (playing) { const tm = mk('span', 'bk-timer'); tm.id = 'pgTimer'; st.appendChild(tm); }
  box.appendChild(st);
  if (v.result && !playing) box.appendChild(mk('div', 'table-result', v.result.text));
  if (!playing && gd?.story) box.appendChild(mk('div', 'it-story', gd.story));   // 開局前：故事背景
  // 座位：職業、手牌（公開）
  const row = mk('div', 'table-seats');
  v.seats.forEach((s, i) => {
    const e = mk('div', 'table-seat' + (s.you ? ' you' : '') + (playing && v.turn === i ? ' turn' : '') + (s.left || s.fo ? ' out' : ''));
    const nm = mk('div', 'table-name', s.name + (s.you ? '（你）' : '') + (s.left ? '（已離開）' : s.fo ? '（棄權）' : ''));
    if (playing) nm.style.color = PG_SEATCOL[i];
    e.appendChild(nm);
    if (playing && g.role[i]) { const r = mk('div', 'table-tag', PG_ROLE[g.role[i]][0]); r.title = PG_ROLE[g.role[i]][1]; e.appendChild(r); e.appendChild(mk('div', 'pg-skill', PG_ROLE[g.role[i]][1])); }
    else e.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
    if (playing && !s.left && !s.fo) {
      const cs = mk('div', 'pg-hand');
      let selUsed = false;   // 同種牌有好幾張時只亮第一張（選的是「這種牌」，給出去哪一張都一樣）
      for (const c of g.hands[i] || []) {
        const ch = mk('span', 'pg-card' + (c[0] === 'I' ? ' item' : ''), pgCardName(c));
        if (c[0] === 'S') ch.style.borderColor = PG_RCOL[c[1]];
        if (i === v.me && ((myTurn && g.step === 'discard') || (g.step === 'act' && g.hands[i].length > 5 && c[0] !== 'I'))) { ch.classList.add('click'); ch.onclick = () => S.net?.tbl?.({ a: 'pdiscard', c }); }   // 被給牌而超過 5 張時，不分回合都能點牌丟掉（道具牌改用「使用」來減少，點了是選取）
        else if (i === v.me && myTurn && g.step === 'act' && o.mode === 'give') { ch.classList.add('click'); if (o.card === c && !selUsed) { ch.classList.add('sel'); selUsed = true; } ch.onclick = () => { o.card = o.card === c ? null : c; buildTable(); }; }
        else if (i === v.me && seat && c[0] === 'I') { ch.classList.add('click'); if (o.card === c && !selUsed) { ch.classList.add('sel'); selUsed = true; } ch.onclick = () => { o.card = o.card === c ? null : c; o.mode = o.card === 'Ispray' ? 'spray' : o.card === 'Itele' ? 'tele1' : 'move'; o.from = null; buildTable(); }; }
        cs.appendChild(ch);
      }
      e.appendChild(cs);
    }
    row.appendChild(e);
  });
  if (!playing) for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
  box.appendChild(row);
  if (playing) {
    // 儀表：污染等級、素材、牌庫
    const info = mk('div', 'pg-info');
    PG_REGIONS.forEach((r, k) => { const m = mk('span', 'pg-got' + (g.got[k] ? ' on' : ''), `${g.got[k] ? '✔' : '○'} ${PG_RNAME[r]}素材`); m.style.borderColor = PG_RCOL[r]; info.appendChild(m); });
    info.appendChild(mk('span', 'table-tag', `補給牌庫 ${g.sup}・擴散牌庫 ${g.sd}`));
    box.appendChild(info);
    if (g.peek) box.appendChild(mk('div', 'table-tag pg-peek', `氣象員偵測：下一張擴散牌是「${pgDirName(g.peek)}」`));
    // 棋盤
    const me = seat ? v.me : -1, mine = myTurn && g.step === 'act' && g.acts > 0;
    const near = new Set();
    if (mine && o.mode === 'move') for (const c of pgNbrs(v, me, g.pawn[me], true)) near.add(c);
    if (mine && o.mode === 'clean') for (const c of [g.pawn[me], ...pgNbrs(v, me, g.pawn[me], false)]) if (pgTile(v, c).s === 1 && g.block !== c) near.add(c);
    if (seat && o.mode === 'spray') for (let c = 0; c < 25; c++) if (pgTile(v, c).s === 1 && g.block !== c) near.add(c);
    if (seat && o.mode === 'tele1') for (let c = 0; c < 25; c++) if (g.pawn.some((p, k) => p === c && !v.seats[k].left && !v.seats[k].fo)) near.add(c);
    if (seat && o.mode === 'tele2') for (let c = 0; c < 25; c++) if (pgTile(v, c).s !== 2 && c !== o.from) near.add(c);
    const bd = mk('div', 'pg-board');
    for (let i = 0; i < 25; i++) {
      const t = pgTile(v, i), el = mk('div', 'pg-tile s' + t.s + (near.has(i) ? ' ok' : '') + (o.sel.includes(i) || o.from === i ? ' sel' : ''));
      el.style.background = t.s === 2 ? '#1a1a1e' : PG_RCOL[t.r];
      el.appendChild(mk('div', 'pg-tname', t.s === 2 ? '荒廢' : PG_RNAME[t.r]));
      if (t.s === 1) el.appendChild(mk('div', 'pg-mark', '☣'));
      if (g.block === i) {
        el.classList.add('blocked');
        el.appendChild(mk('div', 'pg-lock', '🔒')).title = '鄰國封鎖：這一格一輪內不能清潔（淨化噴霧也不行）。\n「一輪」＝場上每位玩家各結束一次回合，之後自動解除。\n擴散牌照常會打到這一格。';
      }
      const pw = mk('div', 'pg-pawns');
      g.pawn.forEach((p, k) => { if (p === i && !v.seats[k].left && !v.seats[k].fo) { const d = mk('span', 'pg-pawn', v.seats[k].name.slice(0, 1)); d.style.background = PG_SEATCOL[k]; d.title = v.seats[k].name; pw.appendChild(d); } });
      el.appendChild(pw);
      el.onclick = () => {
        if (!near.has(i)) return;
        if (o.mode === 'move') S.net?.tbl?.({ a: 'pmove', to: i });
        else if (o.mode === 'clean') {
          if (g.role[me] === 'chemist') { o.sel = o.sel.includes(i) ? o.sel.filter(x => x !== i) : [...o.sel, i].slice(-2); buildTable(); }
          else S.net?.tbl?.({ a: 'pclean', tiles: [i] });
        } else if (o.mode === 'spray') { S.net?.tbl?.({ a: 'puse', c: 'Ispray', tile: i }); o.mode = 'move'; o.card = null; }
        else if (o.mode === 'tele1') { o.from = i; o.mode = 'tele2'; buildTable(); }
        else if (o.mode === 'tele2') { S.net?.tbl?.({ a: 'puse', c: 'Itele', from: o.from, to: i }); o.mode = 'move'; o.card = null; o.from = null; }
      };
      bd.appendChild(el);
    }
    // 版面（2026-11-17 使用者要求）：左邊垂直的污染等級量表、中間棋盤、右邊上面「上一次翻出的牌」、右邊下面擴散牌一覽
    const main = mk('div', 'pg-main'), side = mk('div', 'pg-side');
    side.appendChild(pgLastCards(v, g, mk)); side.appendChild(pgSpreadPanel(v, g, mk));
    main.appendChild(pgGauge(g)); main.appendChild(bd); main.appendChild(side);
    box.appendChild(main);
  }
  // 操作按鈕
  const btns = mk('div', 'table-btns');
  if (seat && playing) {
    const me = v.me, acts = myTurn && g.step === 'act' && g.acts > 0 && !g.hands.some(h => h.length > 5);
    const mode = (key, label, why) => {
      const b = mk('button', 'ff-btn small' + (o.mode === key ? ' active' : ''), label);
      b.disabled = !!why; b.title = why || '';
      b.onclick = () => { o.mode = o.mode === key ? 'move' : key; o.sel = []; o.card = null; o.from = null; buildTable(); };
      btns.appendChild(b);
    };
    const over = g.hands.findIndex(h => h.length > 5);   // 被給牌而超過上限的人：要先丟牌（禁忌之島規則）
    const noAct = !myTurn ? '還沒輪到你' : g.step !== 'act' ? '現在不能行動' : over >= 0 ? `${v.seats[over].name} 手牌超過 5 張，要先丟一張` : g.acts <= 0 ? '行動點用完了' : '';
    mode('move', '移動', noAct); mode('clean', g.role[me] === 'chemist' ? '清潔（最多 2 格）' : '清潔', noAct); mode('give', '給牌', noAct);
    const reg = PG_REGIONS.indexOf(pgTile(v, g.pawn[me]).r), need = g.role[me] === 'sampler' ? 3 : 4;
    let why = noAct;
    if (!why) why = reg < 0 ? '要站在草原／森林／礦區／濕地的土地上' : g.got[reg] ? '這個區域的素材已經取得了' : g.hands[me].filter(c => c === 'S' + PG_REGIONS[reg]).length < need ? `要 ${need} 張「${PG_RNAME[PG_REGIONS[reg]]}採樣」` : '';
    const col = mk('button', 'ff-btn small', '取素材'); col.disabled = !!why; col.title = why;
    col.onclick = () => S.net?.tbl?.({ a: 'pcollect' }); btns.appendChild(col);
    if (o.mode === 'clean' && o.sel.length) { const c = mk('button', 'ff-btn small', `清潔 ${o.sel.length} 格`); c.onclick = () => { S.net?.tbl?.({ a: 'pclean', tiles: o.sel }); o.sel = []; }; btns.appendChild(c); }
    if (o.mode === 'give') {   // 選一張牌，再選要給誰
      const ok = v.seats.map((s, k) => k !== me && !s.left && !s.fo && (g.role[me] === 'courier' || g.pawn[k] === g.pawn[me]));
      v.seats.forEach((s, k) => { if (k === me) return; const b = mk('button', 'ff-btn small', `給 ${s.name}`); b.disabled = !acts || !o.card || !ok[k]; b.title = !o.card ? '先點選上面自己的一張牌' : ok[k] ? '' : '要在同一格；對方手牌滿了也能給，他要立刻丟一張'; b.onclick = () => { S.net?.tbl?.({ a: 'pgive', to: k, c: o.card }); o.card = null; }; btns.appendChild(b); });
    }
    const end = mk('button', 'ff-btn' + (myTurn && g.step === 'act' && g.acts <= 0 ? ' active' : ''), '結束行動');
    end.disabled = !(myTurn && g.step === 'act'); end.title = end.disabled ? noAct : `抽 ${g.sdraw ?? 2} 張補給牌，然後污染擴散`;
    end.onclick = () => S.net?.tbl?.({ a: 'pend' }); btns.appendChild(end);
    const synth = g.got.every(Boolean) && g.pawn.every((p, k) => p === 12 || v.seats[k].left || v.seats[k].fo);
    const sb = mk('button', 'ff-btn' + (synth ? ' active' : ''), '合成解藥'); sb.disabled = !synth; sb.title = synth ? '' : '四種素材都取得，而且全員在研究院才能合成';
    sb.onclick = () => S.net?.tbl?.({ a: 'psynth' }); btns.appendChild(sb);
    if (o.mode === 'spray' || o.mode === 'tele1' || o.mode === 'tele2') btns.appendChild(mk('span', 'table-tag', o.mode === 'spray' ? '點一格污染的土地' : o.mode === 'tele1' ? '點要送走的那一格（那格所有人一起走）' : '點目的地'));
  } else if (seat) {
    const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
    b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
    const sb = mk('button', 'ff-btn small', '改為觀戰'); sb.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(sb);
  } else if (v.role === 'spec' && !playing && v.seats.length < v.max) {
    const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit' }); btns.appendChild(b);
  }
  box.appendChild(btns);
  if (playing) pgStartTimer(v);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
}
// ---- 大螢幕（和平島左上角的圍觀休息區；2026-11-14，使用者要求）：全島共用一個頻道，轉播某一桌的畫面 ----
// 伺服器（worker 的 scr*、dev_server 的 _scr_*）推 {t:'scr', id, game, v}（v＝那桌「觀戰者視角」的 tbl view，手牌全翻開；id＝null＝螢幕關閉）給不在牌桌裡的人；
// 這裡把它畫進一張離屏 canvas（S.scrCv，收到新畫面才重畫一次），島上的螢幕物件（terrain.json props 的 kind:'screen'）每幀只是 drawImage。
// 走到螢幕旁按 F（或點它）→ scr_list 取得「進行中或有人入座」的桌 → 點選切換（scr_pick，所有人共用）。
const SCR_W = 496, SCR_H = 272;
const SCR_FONT = '"Microsoft JhengHei", sans-serif';
function onNetScr(msg) {
  if ((msg.id || null) !== (S.scr?.id || null)) S.scrTb = {};   // 換台：舊的盤面快照作廢
  if (msg.game === 'video') { S.scr = null; vidOnMsg(msg); scrRender(); return; }   // 螢幕在播影片：沒有遊戲畫面，影片由 vidTick 畫
  if (S.vid) vidStop();   // 轉播遊戲或關閉：影片停掉
  S.scr = msg.id ? msg : null;
  scrRender();
}
function onNetScrTb(msg) {   // 俄羅斯方塊的盤面快照（每台約 4 次／秒）：存起來，下一次畫螢幕時一起重畫
  (S.scrTb ||= {})[msg.cab] = { b: msg.b, sc: msg.sc, ln: msg.ln };
  S.scrDirty = true;
}
function onNetScrMz(m) {   // 大螢幕轉播豆豆迷宮／彈珠台：套到螢幕自己的那份狀態（螢幕沒開這桌就忽略）
  if (m.w === 'tpb') { onNetScrPb(m); return; }
  if (m.w === 'ttf') { if (S.scrTf) { tfApplySnap(S.scrTf, m); S.scrDirty = true; } return; }
  if (m.w === 'tbu') { if (S.scrBub) { bubApplySnap(S.scrBub, m); S.scrDirty = true; } return; }
  if (m.w === 'tpl') { if (S.scr?.game === 'planet' && Number.isInteger(m.cab)) { const sp = ((S.scrPl ||= {})[m.cab] ||= plMakeSpec()); if (!sp.frozen) plApplySnap(sp, m); S.scrDirty = true; } return; }
  const M = S.scrMz; if (!M) return;
  if (m.w === 'tms') mzApplyTms(M, m); else if (m.w === 'tmp') mzApplyTmp(M, m);
  S.scrDirty = true;
}
function onNetScrPb(m) { if (S.scrPb) { pbApplySnap(S.scrPb, m); S.scrDirty = true; } }
// 大螢幕：豆豆迷宮——整張迷宮縮小畫在左邊（跟牌桌觀戰同一份 mzDraw，只吃快照），右邊座位欄是各人的分數
function scrMaze(g, v, MX, MY, MW, MH) {
  const z = v.mz, key = z.seed + ':' + z.t0;
  if (!S.scrMz || S.scrMz.key !== key) S.scrMz = mzMake({ ...v, role: 'spec', me: -1 });
  const M = S.scrMz, now = performance.now(), dt = Math.max(0, Math.min(.05, (now - M.last) / 1000)); M.last = now;
  for (const r of [M.rPac, ...M.rG, ...M.rH]) mzRecStep(r, dt);
  if (Math.hypot(M.rPac.tx - M.rPac.x, M.rPac.ty - M.rPac.y) > .02) M.anim += dt;
  const cv = (S.scrMzCv ||= Object.assign(document.createElement('canvas'), { width: MZ_W * MZ_T, height: MZ_HUD + MZ_H * MZ_T }));
  mzDraw(M, mzNow(M), v, cv);
  const k = Math.min(MW / cv.width, MH / cv.height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cv, MX + (MW - cv.width * k) / 2, MY + (MH - cv.height * k) / 2, cv.width * k, cv.height * k);
}
// 大螢幕：彈珠台——整台縮小畫在左邊（同一個 pbDraw，只吃快照），右邊座位欄是分數
function scrPinball(g, v, MX, MY, MW, MH) {
  const key = v.pb.seed + ':' + v.pb.t0;
  if (!S.scrPb || S.scrPb.key !== key) S.scrPb = pbMake({ ...v, role: 'spec' });
  const P = S.scrPb, now = performance.now(), dt = Math.max(0, Math.min(.05, (now - P.last) / 1000)); P.last = now;
  pbAdvance(P, dt);
  const cv = (S.scrPbCv ||= Object.assign(document.createElement('canvas'), { width: PB_W, height: PB_H }));
  pbDraw(P, cv, pbNow(P));
  const k = Math.min(MW / PB_W, MH / PB_H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cv, MX + (MW - PB_W * k) / 2, MY + (MH - PB_H * k) / 2, PB_W * k, PB_H * k);
}
// 大螢幕：泡泡射手——整盤縮小畫在左邊（同一個 bubDraw，只吃快照），右邊座位欄是分數
function scrBubble(g, v, MX, MY, MW, MH) {
  const key = v.bu.seed + ':' + v.bu.t0;
  if (!S.scrBub || S.scrBub.key !== key) S.scrBub = bubMake({ ...v, role: 'spec' });
  const B = S.scrBub, now = performance.now(), dt = Math.max(0, Math.min(.05, (now - B.last) / 1000)); B.last = now;
  bubAdvance(B, dt);
  const cv = (S.scrBubCv ||= Object.assign(document.createElement('canvas'), { width: BUB_W, height: BUB_H }));
  bubDraw(B, cv, bubNow(B));
  const k = Math.min(MW / BUB_W, MH / BUB_H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cv, MX + (MW - BUB_W * k) / 2, MY + (MH - BUB_H * k) / 2, BUB_W * k, BUB_H * k);
}
function onNetScrTp(msg) {   // 打字競賽的進度（大螢幕轉播中才會收到）：i＝座位、n＝第幾個字（＝分數）、p＝已打對幾個字母、e＝剛打錯
  const T = (S.scrTy ||= { key: '', prog: {} });
  T.prog[msg.i] = { n: msg.n, p: msg.p, e: msg.e, at: performance.now() };
  S.scrDirty = true;
}
// 大螢幕：列島建國——市場（三階建築各 4 張）、人物、奇觀、資源庫存；右側座位欄另外畫各人的資源與保留的牌
function scrKingdom(g, v, MX, MY, MW) {
  kgLoadData();
  const K = v.kg, ev = S.kgData?.events;
  g.textAlign = 'left'; g.fillStyle = '#e8ecf8'; g.font = `bold 13px ${SCR_FONT}`;
  g.fillText(`第 ${K.round} 輪　${ev?.[K.ev]?.name || ''}`, MX, MY + 13);
  g.fillStyle = '#9fb0d8'; g.font = `11px ${SCR_FONT}`; g.fillText(`下一輪：${ev?.[K.next]?.name || ''}`, MX + 150, MY + 13);
  // 庫存
  let x = MX; g.font = `bold 11px ${SCR_FONT}`;
  for (const r of ['W', 'S', 'F', 'I', 'G']) {
    const n = r === 'G' ? K.gold : K.sup[r], txt = `${KG_RN[r]} ${n}`, w = 46;
    g.fillStyle = KG_RC[r]; g.fillRect(x, MY + 20, w, 15); g.fillStyle = '#10141f'; g.textAlign = 'center'; g.fillText(txt, x + w / 2, MY + 32); x += w + 4;
  }
  // 一格小牌：左邊細條＝建築產出的資源色、名字、右上分數；被封鎖的名字泛紅
  const cell = (cx, cy, cw, id) => {
    g.fillStyle = id ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.04)'; g.fillRect(cx, cy, cw, 19);
    if (!id) return;
    const c = kgCardOf(id); if (!c) return;
    if (c.gives) { g.fillStyle = KG_RC[c.gives]; g.fillRect(cx, cy, 3, 19); }
    g.fillStyle = K.sd.some(d => d.block === id) ? '#ff9a8a' : '#e8ecf8'; g.font = `11px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText(c.name, cx + 6, cy + 14, cw - (c.vp ? 22 : 8));
    if (c.vp) { g.fillStyle = '#ffe08a'; g.textAlign = 'right'; g.font = `bold 11px ${SCR_FONT}`; g.fillText(String(c.vp), cx + cw - 3, cy + 14); }
  };
  const CW = 78, GAP = 3; let y = MY + 40;
  for (const tier of [3, 2, 1]) {
    g.fillStyle = '#7f8cb0'; g.font = `10px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText(['', '一', '二', '三'][tier], MX, y + 13);
    (K.mkt[tier] || []).forEach((id, q) => cell(MX + 12 + q * (CW + GAP), y, CW, id));
    y += 22;
  }
  g.fillStyle = '#7f8cb0'; g.font = `10px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText('人', MX, y + 13);
  (K.pmkt || []).forEach((id, q) => cell(MX + 12 + q * (CW + GAP), y, CW, id));
  y += 22; g.fillStyle = '#7f8cb0'; g.textAlign = 'left'; g.fillText('奇', MX, y + 13);
  (K.wond || []).forEach((id, q) => cell(MX + 12 + q * (CW + GAP), y, CW, id));
  y += 34;
  (K.obj || []).forEach((o, q) => {
    g.fillStyle = o.by != null ? '#7fe08a' : '#9fb0d8'; g.font = `10px ${SCR_FONT}`; g.textAlign = 'left';
    g.fillText(`目標：${o.name}${o.by != null ? `（${v.seats[o.by]?.name || ''} +3）` : ''}`, MX, y + q * 12, MW);
  });
}
// 大螢幕：秘藥情報戰——整個畫面寬度，一人一列：名字、陣營（螢幕是觀戰者，看得到）、角色卡、情報區的牌、手牌；上面是牌堆／輪到誰／傳遞中的密函
function scrIntel(g, v, MX, MY, MW) {
  const it = v.it, L = it.letter, nm = i => v.seats[i]?.name || '';
  const sq = (x, y, c, w = 13, h = 15) => {   // 一張小牌：顏色（雙色左右各半）＋行動的第一個字；null＝牌背
    if (!c) { g.fillStyle = '#3a4468'; g.fillRect(x, y, w, h); return; }
    const cols = [...itCols(c)].map(k => IT_FILL[k]);
    g.fillStyle = cols[0]; g.fillRect(x, y, cols.length > 1 ? w / 2 : w, h);
    if (cols.length > 1) { g.fillStyle = cols[1]; g.fillRect(x + w / 2, y, w / 2, h); }
    g.fillStyle = '#fff'; g.font = `bold 9px ${SCR_FONT}`; g.textAlign = 'center'; g.fillText((IT_ACT[itActOf(c)] || '?')[0], x + w / 2, y + 11);
  };
  g.textAlign = 'left'; g.fillStyle = '#e8ecf8'; g.font = `bold 12px ${SCR_FONT}`;
  const turnName = it.step === 'turn' && v.turn >= 0 ? `輪到 ${nm(v.turn)}` : it.step === 'pick' ? '選角中' : '進行中';
  g.fillText(turnName, MX, MY + 12);
  g.fillStyle = '#9fb0d8'; g.font = `11px ${SCR_FONT}`; g.fillText(`牌堆 ${it.deck} · 棄牌 ${it.discard}`, MX + 110, MY + 12);
  if (L) {
    g.fillStyle = '#ffe08a'; g.fillText(`✉ ${IT_KIND[L.kind]}：${nm(L.from)} → 現在在 ${nm(L.at)}`, MX + 210, MY + 12, MW - 230);
    sq(MX + MW - 16, MY + 1, L.card || null);
  }
  const n = v.seats.length, RH = Math.min(21, Math.floor((196 - 20) / Math.max(1, n)));
  v.seats.forEach((s, i) => {
    const y = MY + 20 + i * RH, out = s.out || s.left, turn = it.step === 'turn' && v.turn === i;
    g.fillStyle = turn ? 'rgba(255,224,138,.22)' : 'rgba(255,255,255,.06)'; g.fillRect(MX, y, MW, RH - 2);
    g.textAlign = 'left'; g.fillStyle = out ? '#6f7ea8' : '#e8ecf8'; g.font = `bold 11px ${SCR_FONT}`;
    g.fillText((s.name || '').slice(0, 5), MX + 4, y + RH - 6, 58);
    let x = MX + 66;
    const rr = s.role && IT_ROLE[s.role];
    if (rr) { g.fillStyle = rr[1]; g.fillRect(x, y + 2, 28, RH - 6); g.fillStyle = '#10141f'; g.font = `bold 10px ${SCR_FONT}`; g.textAlign = 'center'; g.fillText(rr[0], x + 14, y + RH - 7); }
    x += 32;
    const cd = it.chars && s.char ? itCharDef(s.char) : null;
    g.textAlign = 'left'; g.fillStyle = '#c9a0f0'; g.font = `10px ${SCR_FONT}`; if (cd) g.fillText(cd.name, x, y + RH - 7, 44); x += 46;
    let tag = s.out ? '出局' : s.left ? '離開' : L && L.at === i ? '✉ 手上' : '';
    g.fillStyle = '#ffb070'; g.fillText(tag, x, y + RH - 7, 40); x += 42;
    g.fillStyle = '#7f8cb0'; g.fillText('情報', x, y + RH - 7); x += 26;
    (s.intel || []).forEach((c, q) => sq(x + q * 15, y + 2, c, 13, RH - 6));
    x += 15 * 6 + 4;
    g.fillStyle = '#7f8cb0'; g.textAlign = 'left'; g.font = `10px ${SCR_FONT}`; g.fillText('手牌', x, y + RH - 7); x += 26;
    const hd = v.hands?.[i] || []; (hd.length ? hd : Array(s.n || 0).fill(null)).forEach((c, q) => sq(x + q * 15, y + 2, c, 13, RH - 6));
  });
}
// 大螢幕：打字競賽——每位玩家的分數與正在打的單字（綠＝已打對、紅＝剛打錯）；單字由 seed 算出來，進度來自 sttp
function scrTyping(g, v, MX, MY, MW) {
  const key = `${v.ty.seed}|${v.ty.t0}|${v.game}`, T = (S.scrTy ||= { key: '', prog: {} });
  if (T.key !== key) { T.key = key; T.prog = {}; T.word = typingWords(v.ty.seed, v.game); T.off = v.ty.sn - Date.now(); }
  const t = (Date.now() + T.off - v.ty.t0) / 1000, left = v.ty.dur - t;
  g.textAlign = 'left'; g.fillStyle = '#e8ecf8'; g.font = `bold 13px ${SCR_FONT}`;
  g.fillText(t < 0 ? `開始倒數 ${Math.ceil(-t)}` : left > 0 ? `剩 ${left.toFixed(1)} 秒` : '時間到！等待結算…', MX, MY + 14);
  const rowH = Math.min(44, (196 - 24) / Math.max(1, v.seats.length));
  v.seats.forEach((s, k) => {
    const y = MY + 24 + k * rowH, pr = T.prog[k], n = Math.max(s.score || 0, pr?.n || 0), p = pr && pr.n === n ? pr.p : 0;
    g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(MX, y, MW, rowH - 4);
    g.fillStyle = s.left ? '#6f7ea8' : '#e8ecf8'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText((s.name || '').slice(0, 6), MX + 6, y + 16, 64);
    g.fillStyle = '#ffe08a'; g.textAlign = 'right'; g.fillText(`${n} 分`, MX + MW - 6, y + 16);
    if (s.left || t < 0 || left <= 0) return;
    const w = T.word(n); g.font = `bold 15px ui-monospace, Consolas, ${SCR_FONT}`; g.textAlign = 'left';
    let cx = MX + 6;
    [...w].forEach((c, q) => {
      g.fillStyle = q < p ? '#7fe08a' : q === p && pr && pr.n === n && pr.e ? '#ff6a6a' : '#9fb0d8';
      g.fillText(c, cx, y + 35); cx += g.measureText(c).width + 1;
    });
  });
}
// 俄羅斯方塊（4 台機台一字排開；所有機台一樣大，聯機同場的加金框並標示模式）
function scrArcade(g, v) {
  const seatOf = cab => v.seats.find(s => s.cab === cab), mem = v.link && v.link.phase === 'playing' ? v.link.mem : [];
  const SLW = 118, GAP = 6, X0 = 3, Y0 = 30, SLH = 216, CELL = 9;
  if (mem.length) {
    g.fillStyle = '#ffe08a'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'center';
    g.fillText(`聯機${v.link.mode === 'battle' ? '對戰' : '一般'}：${mem.length} 台同場`, SCR_W / 2, 21);
  }
  for (let cab = 0; cab < 4; cab++) {
    const x = X0 + cab * (SLW + GAP), s = seatOf(cab), linked = mem.includes(cab), playing = !!(s && s.play), tb = playing || (s && s.dead) ? S.scrTb?.[cab] : null;
    g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(x, Y0, SLW, SLH);
    g.strokeStyle = linked ? '#ffe08a' : playing ? '#5a78c8' : 'rgba(255,255,255,.15)'; g.lineWidth = linked ? 2 : 1; g.strokeRect(x + .5, Y0 + .5, SLW - 1, SLH - 1);
    g.fillStyle = '#e8ecf8'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'left';
    g.fillText(`${cab + 1} 號機${s ? '　' + (s.name || '').slice(0, 4) : ''}`, x + 6, Y0 + 15, SLW - 10);
    const bx = x + (SLW - 10 * CELL) / 2, by = Y0 + 22;
    g.fillStyle = '#0a0e1c'; g.fillRect(bx - 1, by - 1, 10 * CELL + 2, 20 * CELL + 2);
    if (tb) {
      for (let i = 0; i < 200; i++) {
        const ch = tb.b.charCodeAt(i) - 48; if (ch <= 0) continue;
        g.fillStyle = AR_COLORS[ch] || '#888'; g.fillRect(bx + (i % 10) * CELL, by + Math.floor(i / 10) * CELL, CELL - 1, CELL - 1);
      }
      if (s.dead) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(bx, by, 10 * CELL, 20 * CELL); }
    }
    const note = !s ? '空機台' : s.dead ? '出局' : playing ? '' : s.st === 'link' ? '聯機等待中' : s.st === 'solo' ? '準備中' : '待機';
    if (note) { g.fillStyle = '#7f8cb0'; g.font = `13px ${SCR_FONT}`; g.textAlign = 'center'; g.fillText(note, bx + 5 * CELL, by + 10 * CELL); }
    if (s) {
      g.fillStyle = '#ffe08a'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'left';
      g.fillText(`${(tb ? tb.sc : s.sc) || 0} 分`, x + 6, Y0 + SLH - 8); g.fillStyle = '#9fb0d8'; g.textAlign = 'right'; g.fillText(`${(tb ? tb.ln : s.ln) || 0} 行`, x + SLW - 6, Y0 + SLH - 8);
    }
  }
}
// 走近螢幕才訂閱畫面（scr_watch）：伺服器只推給在看的人。「近」＝螢幕邊緣 SCR_WATCH_DIST 以內（約等於螢幕在視窗裡）；進牌桌、換島、斷線都會取消。
const SCR_WATCH_DIST = 520;
function scrWatchTick() {
  if (S.t < (S.scrWatchNext || 0)) return;
  S.scrWatchNext = S.t + .5;
  const pr = S.terrain === 'peace' ? propsHere().find(p => p.kind === 'screen') : null;
  const want = !!pr && !S.tableOpen && !S.players[0].dead && (!!S.scrView || propDist(pr, S.players[0].x, S.players[0].y) <= SCR_WATCH_DIST);   // 觀看視角開著：離得遠也要收畫面
  if (want !== !!S.scrWatching || (want && S.t > (S.scrBeat || 0))) {   // 狀態變了就通知；在看的時候每 10 秒補送一次（伺服器重啟也撐得住）
    S.scrWatching = want; S.scrBeat = S.t + 10;
    S.net?.tbl?.({ a: 'scr_watch', on: want });
    if (!want && S.scr) { S.scr = null; scrRender(); }   // 走遠了：畫面不再更新，先清掉免得顯示過期內容
  }
}
// ---- 大螢幕播放自己放的影片（2026-11-19；取代 YouTube 試播——YouTube 在 Discord 裡載不起來）----
// 影片檔放 assets/screen/video/，清單在 assets/screen/videos.json。**全島共用**（2026-11-19 使用者要求「大家一起看」）：選影片／關閉都送伺服器（scr_vid／scr_close，跟轉播同一個頻道與冷卻），
// 伺服器只記「播哪一支、從什麼時候開始（t0，伺服器時間）」，每個人用 t0 與伺服器時間差算出現在播到哪，所以大家看到同一段。
// 影片直接畫進螢幕的畫布（同網域、沒有 iframe），人物自然畫在上面。走近螢幕（或開觀看視角）才播、離開就暫停；聲音隨距離變小。
// 控制面板（進度條／暫停／快轉／音量；直的）只在「點眼睛觀看」時出現，放在螢幕左邊不擋畫面。**暫停、繼續、快轉／倒退、拖進度條都是全島共用**（2026-11-19 使用者定：任何人都能控制、
// 每次操作全島共用 5 秒冷卻、沒有「只影響自己」）：送 scr_ctl {op, pos}，伺服器改狀態再廣播，所有人一起動；靜音與音量只影響自己。
// 螢幕在播影片時，新開局的遊戲**不會**自動跳過去；只有螢幕關著的時候，新遊戲開始才會自動打開（伺服器的 scrAfter 處理）。
async function vidDB() { if (!S.vidCfg) { try { S.vidCfg = await loadJSON('assets/screen/videos.json'); } catch { S.vidCfg = { videos: [] }; } } return S.vidCfg; }
function vidStop() {
  const v = S.vid; if (v) { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); }
  S.vid = null; if (S.vidPanelEl) S.vidPanelEl.style.display = 'none';
}
function vidStart(def, t0, off, paused, pos) {   // 開始播（伺服器說螢幕現在在播這支）；t0＝伺服器時間的起點、off＝伺服器時間 − 本機時間；paused／pos＝共用的暫停狀態與暫停位置（秒）
  vidStop();
  const el = document.createElement('video'); el.playsInline = true; el.loop = true; el.preload = 'auto'; el.src = /^(blob:|https?:)/.test(def.file) ? def.file : `assets/screen/video/${def.file}`;
  S.vid = { def, el, t0, off, paused: !!paused, pos: pos || 0, needSync: true };
  el.volume = S.vidVol ?? .6; el.muted = !!S.vidMuted;
  el.addEventListener('error', () => { toast('影片載入失敗', 1800); if (S.vid?.el === el) vidStop(); });
}
function vidOnMsg(msg) {   // 伺服器的 scr 訊息：螢幕在播影片
  if (S.vidCfg && !S.vidCfg.enabled) return;   // 功能先關著：忽略（videos.json 的 enabled）
  const v = msg.vid, off = msg.now - Date.now();
  const cur = S.vid;
  if (cur && cur.def.id === v.id) {   // 同一支影片：只更新共用狀態（暫停／跳轉／走近時重送），不重來
    cur.off = off;
    if (cur.t0 !== v.t0 || cur.paused !== !!v.paused || cur.pos !== v.pos) { cur.t0 = v.t0; cur.paused = !!v.paused; cur.pos = v.pos || 0; cur.needSync = true; }
    return;
  }
  vidDB().then(db => {
    if (!db.enabled) return;   // 功能先關著
    const def = (db.videos || []).find(x => x.id === v.id);
    if (!def) { toast('大螢幕在播的影片這個版本找不到', 2000); return; }
    vidStart(def, v.t0, off, v.paused, v.pos);
  });
}
const vidClock = v => { const d = v.el.duration || v.def.duration || 1; return v.paused ? v.pos % d : (((Date.now() + v.off - v.t0) / 1000) % d + d) % d; };
function vidCtl(op, pos) {   // 暫停／繼續／跳轉：送伺服器（全島共用、5 秒冷卻）；畫面等伺服器廣播回來才動
  if (Date.now() < (S.vidCtlCdAt || 0)) { toast(`影片剛操作過，${Math.ceil((S.vidCtlCdAt - Date.now()) / 1000)} 秒後才能再操作`, 1600); return; }
  S.vidCtlCdAt = Date.now() + 5000;
  S.net?.tbl?.({ a: 'scr_ctl', op, pos });
}
function scrClose() {   // 螢幕上的關閉按鈕：送伺服器（全島共用）；有新的遊戲開始時，只有螢幕關著才會自動打開
  S.net?.tbl?.({ a: 'scr_close' });
}
function vidPanel() {   // 直的面板：放在螢幕左邊（進度條、時間、倒退／暫停／快轉、靜音、音量）
  if (S.vidPanelEl) return S.vidPanelEl;
  const el = document.createElement('div'); el.id = 'vidPanel';
  el.style.cssText = 'position:fixed;z-index:25;display:none;flex-direction:column;align-items:stretch;gap:5px;width:118px;padding:6px 8px;background:rgba(14,16,24,.9);border:1px solid #8a7536;font:12px "Microsoft JhengHei",sans-serif;color:#e8e4d8;box-sizing:border-box';
  const mkb = (txt, tip, fn) => { const b = document.createElement('button'); b.className = 'ff-btn small'; b.textContent = txt; b.title = tip; b.onclick = fn; b.style.cssText = 'flex:1 1 0;min-width:0;padding:3px 0;margin:0;white-space:nowrap'; return b; };   // 三顆按鈕平分一列、不超出面板
  const lab = txt => { const d = document.createElement('div'); d.textContent = txt; d.style.cssText = 'color:#a09a86;font-size:11px;display:flex;justify-content:space-between'; return d; };
  const B = S.vidB = {
    back: mkb('−10', '倒退 10 秒（大家的螢幕一起）', () => { const v = S.vid; if (v) vidCtl('seek', Math.max(0, v.el.currentTime - 10)); }),
    play: mkb('⏸', '暫停／播放（大家的螢幕一起）', () => { const v = S.vid; if (v) vidCtl(v.paused ? 'play' : 'pause', v.el.currentTime); }),
    fwd: mkb('+10', '快轉 10 秒（大家的螢幕一起）', () => { const v = S.vid; if (v) vidCtl('seek', (v.el.currentTime + 10) % (v.el.duration || 1e9)); }),
    mute: mkb('🔊 靜音', '靜音／開聲音', () => { S.vidMuted = !S.vidMuted; if (S.vid) S.vid.el.muted = S.vidMuted; }),
  };
  const seek = B.seek = document.createElement('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0; seek.title = '進度（拖曳跳到想看的地方，大家的螢幕一起）'; seek.style.cssText = 'width:100%;margin:0;box-sizing:border-box';
  seek.onchange = () => { const v = S.vid; if (v && v.el.duration) vidCtl('seek', seek.value / 1000 * v.el.duration); seek.blur(); };   // 放開才送（拖曳中不送），送完把焦點放掉讓進度條跟回伺服器的狀態
  const vol = B.vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = Math.round((S.vidVol ?? .6) * 100); vol.title = '音量'; vol.style.cssText = 'width:100%;margin:0;box-sizing:border-box';
  vol.oninput = () => { S.vidVol = +vol.value / 100; S.vidMuted = false; if (S.vid) { S.vid.el.muted = false; } };
  B.time = document.createElement('span'); B.volTxt = document.createElement('span');
  const l1 = lab('進度'), l2 = lab('音量'); l1.appendChild(B.time); l2.appendChild(B.volTxt); B.time.style.fontVariantNumeric = 'tabular-nums';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:4px;width:100%'; row.append(B.back, B.play, B.fwd);
  el.append(l1, seek, row, B.mute, l2, vol);
  for (const ev of ['mousedown', 'click', 'contextmenu', 'wheel']) el.addEventListener(ev, e => e.stopPropagation());   // 點面板不算遊戲裡的點擊
  document.body.appendChild(el); return S.vidPanelEl = el;
}
const vidFmt = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function vidTick() {
  const v = S.vid;
  if (!v) { if (S.vidPanelEl) S.vidPanelEl.style.display = 'none'; return; }
  const pr = S.terrain === 'peace' ? propsHere().find(p => p.kind === 'screen') : null;
  const d = pr ? propDist(pr, S.players[0].x, S.players[0].y) : 1e9;
  const near = !!pr && !S.tableOpen && !S.players[0].dead && (!!S.scrView || d <= SCR_WATCH_DIST);
  const el = v.el;
  if (!near) { if (!el.paused) { el.pause(); v.needSync = true; } if (S.vidPanelEl) S.vidPanelEl.style.display = 'none'; return; }
  if (v.needSync && el.readyState >= 1) { el.currentTime = vidClock(v); v.needSync = false; }
  if (v.paused) { if (!el.paused) el.pause(); }   // 共用暫停：全部停在同一格
  else if (el.paused && !v.needSync) el.play().catch(() => { el.muted = true; S.vidMuted = true; el.play().catch(() => { }); });   // 被瀏覽器擋掉有聲音的自動播放：先靜音播
  el.volume = Math.max(0, Math.min(1, (S.vidVol ?? .6) * (S.scrView ? 1 : 1 - Math.max(0, d - 200) / (SCR_WATCH_DIST - 200))));   // 離螢幕越遠越小聲
  if (!S.scrView) { if (S.vidPanelEl) S.vidPanelEl.style.display = 'none'; return; }   // 控制面板只在點眼睛觀看時出現
  const pn = vidPanel(), B = S.vidB, rc = canvas.getBoundingClientRect(), k = rc.width / canvas.width, r = propRect(pr);
  const x = rc.left + (r.x + (r.w - SCR_W) / 2 - S.cam.x) * k, y = rc.top + (r.y + 8 - S.cam.y) * k;   // 螢幕畫面的左上角；面板放在它的左邊（使用者定：做成直的放左邊，不擋畫面）
  const pw = 118, left = x - pw - 12;
  pn.style.display = left < rc.left || y + 170 > rc.bottom ? 'none' : 'flex'; pn.style.left = left + 'px'; pn.style.top = y + 'px';
  B.play.textContent = v.paused ? '▶' : '⏸'; B.mute.textContent = S.vidMuted || el.muted ? '🔇 開聲音' : '🔊 靜音';
  const dur = el.duration || v.def.duration || 1;
  if (document.activeElement !== B.seek) B.seek.value = Math.round(el.currentTime / dur * 1000);   // 拖曳時不被覆蓋
  if (document.activeElement !== B.vol) B.vol.value = Math.round((S.vidVol ?? .6) * 100);
  B.time.textContent = `${vidFmt(el.currentTime)} / ${vidFmt(dur)}`; B.volTxt.textContent = `${Math.round((S.vidVol ?? .6) * 100)}%`;
}
function onNetScrCd(msg) {
  if (msg.ctl) { S.vidCtlCdAt = Date.now() + msg.left; toast(`影片剛操作過，${Math.ceil(msg.left / 1000)} 秒後才能再操作`, 1600); return; }
  toast(`大螢幕剛切換過，${Math.ceil(msg.left / 1000)} 秒後才能再切`, 1800);
}
function onNetScrList(msg) {
  S.scrList = msg; S.scrCdAt = Date.now() + (msg.cd || 0);
  if (S.scrPickOpen) buildScrPick();
}
// 大螢幕：淨土守護戰——左邊 5×5 的島（污染＝紫、荒廢＝黑、人偶＝座位色圓點），右邊污染等級、四種素材、牌庫與剛打過的擴散牌
function scrPurify(g, v, MX, MY, MW) {
  const z = v.pg, C = 36, bx = MX + 4, by = MY + 8;
  for (let i = 0; i < 25; i++) {
    const t = pgTile(v, i), x = bx + (i % 5) * C, y = by + Math.floor(i / 5) * C;
    g.fillStyle = t.s === 2 ? '#1a1a1e' : PG_RCOL[t.r]; g.fillRect(x, y, C - 2, C - 2);
    if (t.s === 1) { g.fillStyle = 'rgba(138,79,184,.7)'; g.fillRect(x, y, C - 2, C - 2); g.fillStyle = '#fff'; g.font = `bold 16px ${SCR_FONT}`; g.textAlign = 'center'; g.fillText('☣', x + C / 2 - 1, y + C / 2 + 6); }
    if (z.block === i) { g.font = `11px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText('🔒', x + 1, y + 12); }
    z.pawn.forEach((p, k) => { if (p === i && !v.seats[k].left && !v.seats[k].fo) { g.fillStyle = PG_SEATCOL[k]; g.beginPath(); g.arc(x + 8 + (k % 2) * 13, y + C - 11 - (k > 1 ? 11 : 0), 5, 0, 7); g.fill(); } });
  }
  const X = MX + 196;
  g.textAlign = 'left'; g.fillStyle = z.lvl >= z.lose - 2 ? '#ff7a6a' : '#e8ecf8'; g.font = `bold 13px ${SCR_FONT}`;
  g.fillText(`污染等級 ${z.lvl}／${z.lose - 1}`, X, MY + 18); g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.fillText(`每回合翻 ${z.draws} 張擴散牌`, X, MY + 34);
  PG_REGIONS.forEach((r, k) => { g.fillStyle = z.got[k] ? PG_RCOL[r] : '#4a5578'; g.fillText(`${z.got[k] ? '✔' : '○'} ${PG_RNAME[r]}素材`, X, MY + 58 + k * 18); });
  g.fillStyle = '#9fb0d8'; g.fillText(`補給 ${z.sup}・擴散 ${z.sd}`, X, MY + 142);
  g.fillText(`剛打過：${[...z.sdd].reverse().slice(0, 2).map(pgDirName).join('、')}`, X, MY + 160, 125);
  g.fillStyle = '#ffe08a'; g.fillText(`${v.seats[v.turn]?.name || ''} 行動中（${z.acts} 點）`, X, MY + 182, 125);
}
function scrTmp(w, h) { const c = (S.scrTmp ||= document.createElement('canvas')); c.width = w; c.height = h; return c; }
function scrMiniCard(g, x, y, c, kind) {   // 22×30 的小牌；kind＝'uno' 用 UNO 牌面，否則一般撲克牌；c＝null 畫牌背
  const w = 22, h = 30;
  if (kind === 'uno' && c) {
    const wild = c === 'W' || c === 'F', v = wild ? c : c.slice(1);
    g.fillStyle = wild ? '#22222c' : UN_FILL[c[0]]; g.fillRect(x, y, w, h);
    g.strokeStyle = '#f6f2e6'; g.lineWidth = 1.5; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = '#fff'; g.font = `bold 13px ${SCR_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText({ s: '⊘', r: '⇄', d: '+2', W: '★', F: '+4' }[v] || v, x + w / 2, y + h / 2 + 1);
    g.textBaseline = 'alphabetic'; return;
  }
  g.fillStyle = c ? '#f6f2e6' : '#a83a38'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#1a1612'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
  if (!c) return;
  g.textAlign = 'left'; g.fillStyle = c === 'JK' ? '#6a2a8a' : (c[0] === 'H' || c[0] === 'D') ? '#d83a3a' : '#1e1e24';
  if (c === 'JK') { g.font = `bold 12px ${SCR_FONT}`; g.fillText('鬼', x + 5, y + 19); return; }
  const r = Number(c.slice(1));
  g.font = `bold 12px ${SCR_FONT}`; g.fillText(({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[r] || String(r), x + 2, y + 12);
  g.font = `13px ${SCR_FONT}`; g.fillText(SUIT_SYM[c[0]], x + 2, y + 26);
}
// 每位玩家一列手牌（疊起來，放不下就縮小間距）：名字在左邊，牌在右邊
function scrHands(g, v, x, y, w, rowH, kind) {
  v.seats.forEach((s, k) => {
    const cy = y + k * rowH, hand = (v.hands && v.hands[k]) || [];
    g.fillStyle = v.turn === k && v.phase === 'playing' ? '#ffe08a' : '#cfd6e8'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'left';
    g.fillText((s.name || '').slice(0, 6), x, cy + 20, 54);
    const n = hand.length, step = n > 1 ? Math.min(24, (w - 60 - 22) / (n - 1)) : 0;
    hand.forEach((c, q) => scrMiniCard(g, x + 58 + q * step, cy + 2, c, kind));
  });
}
function scrSeatTag(v, s, k) {
  if (v.game === 'planet') return s.play ? `${Math.max(s.sc ?? 0, S.scrPl?.[s.cab]?.score ?? 0)} 分` : s.st === 'link' ? '對戰等待中' : '閒置';   // 星球合成：旁觀者的 phase 永遠是 lobby，改看這台有沒有在玩
  if (v.phase !== 'playing') return s.ready ? '已準備' : '未準備';
  const gm = v.game;
  if (s.left) return '離開';
  if (gm === 'oldmaid' || gm === 'uno' || gm === 'bigtwo' || gm === 'purify') return s.fo ? '棄權' : `${s.n} 張`;
  if (gm === 'kingdom') return `${v.kg?.sd?.[k]?.vp ?? 0} 分`;
  if (gm === 'blokus' || gm === 'trigon') return s.rem != null ? `剩 ${s.rem}` : '';
  if (gm === 'gomoku') return v.black == null ? '' : (k === v.black ? '黑棋' : '白棋');
  if (gm === 'dodge') return s.out ? '淘汰' : `${s.lives ?? ''} 命`;
  if (gm === 'mage') return s.dead ? '倒下' : `HP ${s.hp ?? ''}`;
  if (gm === 'typing' || gm === 'zhtyping') return `${Math.max(s.score ?? 0, S.scrTy?.prog?.[k]?.n ?? 0)} 分`;
  if (gm === 'maze') return `${s.sc ?? 0} 分`;
  if (gm === 'pinball') return `${Math.max(s.sc ?? 0, S.scrPb?.score ?? 0)} 分`;
  if (gm === 'g2048') return `${Math.max(s.sc ?? 0, S.scrTf?.score ?? 0)} 分`;
  if (gm === 'bubble') return `${Math.max(s.sc ?? 0, S.scrBub?.score ?? 0)} 分`;
  if (isPlGame(gm)) return `${Math.max(s.sc ?? 0, S.scrPl?.[s.cab]?.score ?? 0)} 分`;   // 星球合成：大螢幕上最新的快照分數
  if (gm === 'breakout') return `${s.sc ?? 0} 分`;
  if (gm === 'intel') return s.out ? '出局' : '';
  return '';
}
function scrRender() {
  const cv = (S.scrCv ||= Object.assign(document.createElement('canvas'), { width: SCR_W, height: SCR_H })), g = cv.getContext('2d');
  g.imageSmoothingEnabled = false; g.textBaseline = 'alphabetic';
  g.fillStyle = '#0b1020'; g.fillRect(0, 0, SCR_W, SCR_H);
  const sc = S.scr;
  if (sc?.game !== 'mary') S.scrMary = null;   // 小瑪莉轉播的動畫狀態：換台就丟掉
  if (!sc) {   // 關閉：暗底＋掃描線，提示怎麼打開
    g.fillStyle = 'rgba(120,150,220,.08)'; for (let y = 0; y < SCR_H; y += 4) g.fillRect(0, y, SCR_W, 1);
    g.fillStyle = '#6f7ea8'; g.textAlign = 'center'; g.font = `bold 22px ${SCR_FONT}`; g.fillText('大螢幕', SCR_W / 2, 118);
    g.font = `14px ${SCR_FONT}`; g.fillText('目前沒有轉播。有人入座遊戲桌之後，走到螢幕旁按 F 選擇', SCR_W / 2, 148);
    return;
  }
  const v = { ...sc.v, game: sc.game }, gd = gameDef(sc.game), isAr = sc.game === 'arcade';
  const playing = isAr || sc.game === 'planet' ? v.seats.some(s => s.play) : v.phase === 'playing';   // 星球合成：兩台機台，有任何一台在玩就算進行中（旁觀者的 phase 永遠是 lobby）
  // 標題列
  g.fillStyle = '#16224a'; g.fillRect(0, 0, SCR_W, 26);
  g.fillStyle = '#ffe08a'; g.font = `bold 15px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText(`${gd?.name || '遊戲'}　${v.id ? '' : ''}`, 10, 19);
  g.textAlign = 'right'; g.fillStyle = playing ? '#7fe08a' : v.result ? '#ffb070' : '#9fb0d8'; g.font = `13px ${SCR_FONT}`;
  g.fillText(playing ? '進行中' : v.result && !isAr ? '結算' : isAr ? '待機' : `等待開始 ${v.seats.length}/${v.max}`, SCR_W - 10, 18);
  if (isAr) { scrArcade(g, v); return; }
  // 右側：座位
  const SX = 340, SW = 148, wideIntel = sc.game === 'intel' && playing && v.it;   // 秘藥情報戰進行中：整個畫面一人一列（scrIntel），不畫右側座位欄
  if (!wideIntel) v.seats.forEach((s, k) => {
    const RH = v.game === 'kingdom' && v.kg ? 52 : 30, y = 34 + k * RH;
    g.fillStyle = playing && v.turn === k ? 'rgba(255,224,138,.22)' : 'rgba(255,255,255,.06)'; g.fillRect(SX, y, SW, RH - 4);
    g.fillStyle = '#e8ecf8'; g.font = `bold 12px ${SCR_FONT}`; g.textAlign = 'left'; g.fillText((s.name || '').slice(0, 6), SX + 6, y + 17, 70);
    g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.textAlign = 'right'; g.fillText(scrSeatTag(v, s, k), SX + SW - 6, y + 17);
    if (v.game === 'kingdom' && v.kg && playing) {   // 列島建國：第二行資源（含金幣），第三行保留的牌
      const sd = v.kg.sd[k]; let cx = SX + 6; g.font = `bold 10px ${SCR_FONT}`; g.textAlign = 'left';
      for (const r of ['W', 'S', 'F', 'I', 'G']) { const n = r === 'G' ? sd.gold : sd.res[r]; g.fillStyle = n ? KG_RC[r] : '#4a5578'; g.fillText(`${KG_RN[r]}${n}`, cx, y + 31); cx += 27; }
      g.fillStyle = '#9fb0d8'; g.font = `10px ${SCR_FONT}`;
      const hd = (v.kg.hands?.[k] || []).map(id => kgCardOf(id)?.name || '').join('、');
      g.fillText(hd ? `留：${hd}` : sd.nhand ? `留 ${sd.nhand} 張` : '', SX + 6, y + 44, SW - 10);
    }
  });
  // 左側：主畫面（316×196）
  const MX = 8, MY = 32, MW = 322, MH = 196;
  const fit = (src, w, h) => { const k = Math.min(MW / w, MH / h); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, MX + (MW - w * k) / 2, MY + (MH - h * k) / 2, w * k, h * k); g.imageSmoothingEnabled = false; };   // 縮小要平滑，不然 1px 的格線會被丟掉
  let drew = false;
  try {
    if (sc.game === 'gomoku' && v.board) { const t = scrTmp(GM_MARGIN * 2 + GM_CELL * (GM_N - 1), GM_MARGIN * 2 + GM_CELL * (GM_N - 1)); gomokuDraw(t, v, null, null); fit(t, t.width, t.height); drew = true; }
    else if (sc.game === 'blokus' && v.bk) { const n = bkN(v) * bkCellPx(v), t = scrTmp(n, n); bkDraw(t, v); fit(t, n, n); drew = true; }
    else if (sc.game === 'trigon' && v.tg) { const t = scrTmp(TG_CW, TG_CH); tgDraw(t, v); fit(t, TG_CW, TG_CH); drew = true; }
    else if (sc.game === 'uno' && v.un) {
      scrHands(g, v, MX, MY, 250, 44, 'uno');
      scrMiniCard(g, MX + 262, MY + 8, v.un.top, 'uno'); g.fillStyle = UN_FILL[v.un.color] || '#fff'; g.font = `bold 13px ${SCR_FONT}`; g.textAlign = 'left';
      g.fillText(`${UN_CNAME[v.un.color] || ''}色`, MX + 262, MY + 56); g.fillStyle = '#9fb0d8'; g.fillText(v.un.dir > 0 ? '↻ 順時針' : '↺ 逆時針', MX + 262, MY + 74);
      drew = true;
    } else if (sc.game === 'bigtwo' && v.bt) {
      scrHands(g, v, MX, MY, MW, 34, null);
      const base = MY + v.seats.length * 34 + 12;
      g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.textAlign = 'left';
      g.fillText(v.bt.last ? `${v.seats[v.bt.last.seat]?.name || ''} 出了：` : '新的一手（誰出都行）', MX, base + 18);
      if (v.bt.last) v.bt.last.cs.forEach((c, q) => scrMiniCard(g, MX + 110 + q * 26, base, c, null));
      drew = true;
    } else if (sc.game === 'oldmaid' && playing) { scrHands(g, v, MX, MY, MW, 44, null); drew = true; }
    else if (sc.game === 'kingdom' && v.kg) { scrKingdom(g, v, MX, MY, MW); drew = true; }
    else if (sc.game === 'purify' && v.pg) { scrPurify(g, v, MX, MY, MW); drew = true; }
    else if (sc.game === 'maze' && playing && v.mz) { scrMaze(g, v, MX, MY, MW, MH); drew = true; }
    else if (sc.game === 'pinball' && playing && v.pb) { scrPinball(g, v, MX, MY, MW, MH); drew = true; }
    else if (sc.game === 'g2048' && playing && v.tf) { scrG2048(g, v, MX, MY, MW, MH); drew = true; }
    else if (sc.game === 'bubble' && playing && v.bu) { scrBubble(g, v, MX, MY, MW, MH); drew = true; }
    else if (sc.game === 'mary' && playing && v.ma) { scrMary(g, v, MX, MY, MW, MH); drew = true; }
    else if (sc.game === 'planet' && playing) { scrPlanet(g, v, MX, MY, MW, MH); drew = true; }
    else if (wideIntel) { scrIntel(g, v, MX, MY, SCR_W - MX * 2); drew = true; }
    else if ((sc.game === 'typing' || sc.game === 'zhtyping') && playing && v.ty) { scrTyping(g, v, MX, MY, MW); drew = true; }
    } catch (e) { drew = false; }
  if (!drew) {   // 沒有專屬畫面的遊戲（即時遊戲、秘藥情報戰…）或還沒開始：大字狀態
    g.fillStyle = '#9fb0d8'; g.textAlign = 'center'; g.font = `bold 20px ${SCR_FONT}`;
    g.fillText(playing ? '對戰進行中' : v.result ? '本局結束' : '等待玩家入座、準備', MX + MW / 2, MY + MH / 2);
    g.font = `13px ${SCR_FONT}`; g.fillText(playing ? '（這個遊戲只顯示對戰名單與分數）' : '', MX + MW / 2, MY + MH / 2 + 24);
  }
  // 結算橫幅
  if (!playing && v.result?.text) {
    g.fillStyle = 'rgba(10,16,40,.88)'; g.fillRect(MX, MY + MH - 40, MW, 40);
    g.strokeStyle = '#ffe08a'; g.lineWidth = 1.5; g.strokeRect(MX + .5, MY + MH - 39.5, MW - 1, 39);
    g.fillStyle = '#ffe08a'; g.textAlign = 'center'; g.font = `bold 15px ${SCR_FONT}`; g.fillText(v.result.text, MX + MW / 2, MY + MH - 14, MW - 12);
  }
  // 最近兩行紀錄
  g.textAlign = 'left'; g.fillStyle = '#7f8cb0'; g.font = `11px ${SCR_FONT}`;
  (v.log || []).slice(-2).forEach((l, q) => g.fillText(l, 10, SCR_H - 18 + q * 14, SCR_W - 20));
}
// 轉播清單視窗
function openScrPick() {
  S.net?.tbl?.({ a: 'scr_list' });
  S.scrPickOpen = true; $('scrBox').classList.remove('hidden');
  buildScrPick();
}
function closeScrPick() { S.scrPickOpen = false; $('scrBox').classList.add('hidden'); }
function buildScrPick() {
  const body = $('scrBody'); body.innerHTML = '';
  const lst = S.scrList?.list || [];
  if (!S.scrList) { body.textContent = '讀取中…'; return; }
  if (!S.vidCfg) vidDB().then(() => { if (S.scrPickOpen) buildScrPick(); });
  for (const def of S.vidCfg?.enabled ? S.vidCfg.videos || [] : []) {   // 影片（videos.json 的 enabled＝false 時整個功能先不顯示，使用者定 2026-11-19）
    const row = document.createElement('div'); row.className = 'scr-opt' + (S.vid?.def.id === def.id ? ' cur' : '');
    row.innerHTML = `<span class="scr-name">▶ ${def.name}</span><span class="scr-st">影片　${S.vid?.def.id === def.id ? '播放中　' : ''}大家的螢幕都會播</span>`;
    row.onclick = () => {
      if (Date.now() < (S.scrCdAt || 0)) { toast(`大螢幕剛切換過，${Math.ceil((S.scrCdAt - Date.now()) / 1000)} 秒後才能再切`, 1800); return; }
      S.net?.tbl?.({ a: 'scr_vid', id: def.id }); closeScrPick();
    };
    body.appendChild(row);
  }
  if (!lst.length) { const e = document.createElement('div'); e.className = 'ff-panel-hint'; e.textContent = '目前沒有進行中、或有人入座的遊戲。有人入座之後再來選。'; body.appendChild(e); return; }
  for (const it of lst) {
    const gd = gameDef(it.game), row = document.createElement('div');
    row.className = 'scr-opt' + (S.scr && S.scr.id === it.id ? ' cur' : '');
    const a = document.createElement('span'); a.className = 'scr-name'; a.textContent = `${gd?.name || it.game}${it.game === 'hockey' ? `（${it.id === 't15' ? '左' : '右'}桌）` : ''}`;
    const b = document.createElement('span'); b.className = 'scr-st'; b.textContent = `${it.play ? '進行中' : '等待開始'}　${it.n}/${it.max}　${(it.names || []).join('、')}`;
    row.appendChild(a); row.appendChild(b);
    row.onclick = () => {
      if (Date.now() < (S.scrCdAt || 0)) { toast(`大螢幕剛切換過，${Math.ceil((S.scrCdAt - Date.now()) / 1000)} 秒後才能再切`, 1800); return; }
      S.net?.tbl?.({ a: 'scr_pick', id: it.id }); closeScrPick();
    };
    body.appendChild(row);
  }
}
// 島上的螢幕物件：外框＋離屏 canvas 的內容（沒收到過畫面時先畫成關閉的樣子）
function drawScreenProp(pr, r) {
  if (!S.scrCv || S.scrDirty || (S.scr && (S.scr.v?.ty || S.scr.game === 'maze' || S.scr.game === 'pinball' || S.scr.game === 'bubble' || S.scr.game === 'g2048') && S.scr.v.phase === 'playing') || (S.scr?.game === 'planet' && S.scr.v?.seats?.some(x => x.play)) || (S.scr?.game === 'mary' && S.scr.v?.phase === 'playing' && (S.scrMary?.spin || S.scrMary?.showPlay))) { S.scrDirty = false; scrRender(); }   // 小瑪莉：跑馬燈／勇者演出播放中每幀重畫   // 打字競賽進行中：每幀重畫（倒數的秒數會動）
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#12141c'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#2a2e3c'; ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
  const ix = r.x + (r.w - SCR_W) / 2, iy = r.y + 8;
  const vd = S.vid && S.vid.el.readyState >= 2 ? S.vid.el : null;
  if (vd) {   // 播自己的影片：保持比例、黑邊置中
    ctx.fillStyle = '#000'; ctx.fillRect(ix, iy, SCR_W, SCR_H);
    const ar = vd.videoWidth / vd.videoHeight, W = ar > SCR_W / SCR_H ? SCR_W : SCR_H * ar, H = ar > SCR_W / SCR_H ? SCR_W / ar : SCR_H;
    ctx.imageSmoothingEnabled = true; ctx.drawImage(vd, ix + (SCR_W - W) / 2, iy + (SCR_H - H) / 2, W, H); ctx.imageSmoothingEnabled = false;
  } else {
    ctx.drawImage(S.scrCv, ix, iy, SCR_W, SCR_H);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(ix, iy, SCR_W, 70);   // 玻璃反光
  }
  ctx.fillStyle = S.scr || vd ? '#5ae07a' : '#c85a5a'; ctx.fillRect(r.x + r.w - 20, r.y + r.h - 7, 5, 3);   // 電源燈
  if (S.scr || S.vid) {   // 關閉按鈕（眼睛按鈕上面）：有在轉播或播影片才有
    const c = scrCloseRect(pr), cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    ctx.save(); ctx.fillStyle = '#12141c'; ctx.fillRect(c.x, c.y, c.w, c.h); ctx.fillStyle = '#2a2e3c'; ctx.fillRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
    ctx.strokeStyle = '#e07a68'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - 7, cy - 7); ctx.lineTo(cx + 7, cy + 7); ctx.moveTo(cx + 7, cy - 7); ctx.lineTo(cx - 7, cy + 7); ctx.stroke();
    ctx.textAlign = 'center'; ctx.font = '10px "Microsoft JhengHei"'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = '#fff6e0'; ctx.strokeText('關閉', cx, c.y + c.h + 11); ctx.fillText('關閉', cx, c.y + c.h + 11);
    ctx.restore();
  }
  // 眼睛按鈕（觀看視角）：螢幕右下角外側
  const b = scrEyeRect(pr), on = !!S.scrView, ex = b.x + b.w / 2, ey = b.y + b.h / 2;
  ctx.save();
  ctx.fillStyle = on ? '#ffe08a' : '#12141c'; ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = on ? '#3a2e12' : '#2a2e3c'; ctx.fillRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
  ctx.strokeStyle = on ? '#ffe08a' : '#d8dcec'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ex - 10, ey); ctx.quadraticCurveTo(ex, ey - 10, ex + 10, ey); ctx.quadraticCurveTo(ex, ey + 10, ex - 10, ey); ctx.stroke();   // 眼眶
  ctx.fillStyle = on ? '#ffe08a' : '#d8dcec'; ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, Math.PI * 2); ctx.fill();   // 瞳孔
  ctx.textAlign = 'center'; ctx.font = '10px "Microsoft JhengHei"'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)'; ctx.fillStyle = on ? '#ffe08a' : '#fff6e0';
  const lb = on ? '觀看中' : '觀看'; ctx.strokeText(lb, ex, b.y + b.h + 11); ctx.fillText(lb, ex, b.y + b.h + 11);
  ctx.restore();
}
// 觀看視角（2026-11-16，使用者要求）：螢幕旁邊的眼睛按鈕，按下去角色不動、鏡頭拉到以螢幕為中心；角色一移動（或再按一次、換島、倒下）就回到跟隨角色。
// 純客戶端：S.scrView＝按下時角色的位置（null＝沒開），鏡頭在 draw() 裡用 S.scrViewK（0～1）平滑過去；開著的時候不管離多遠都訂閱螢幕畫面（scrWatchTick）。
function scrCloseRect(pr) { const r = propRect(pr); return { x: r.x + r.w + 8, y: r.y + r.h - 96, w: 32, h: 32 }; }   // 關閉按鈕：眼睛按鈕上面
function scrCloseAt(wx, wy) {
  const pr = S.terrain === 'peace' ? propsHere().find(p => p.kind === 'screen') : null; if (!pr || !(S.scr || S.vid)) return false;
  const b = scrCloseRect(pr); return wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h + 12;
}
function scrEyeRect(pr) { const r = propRect(pr); return { x: r.x + r.w + 8, y: r.y + r.h - 46, w: 32, h: 32 }; }
function scrEyeAt(wx, wy) {
  const pr = S.terrain === 'peace' ? propsHere().find(p => p.kind === 'screen') : null; if (!pr) return false;
  const b = scrEyeRect(pr); return wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h + 12;
}
function scrViewToggle() {
  const p = S.players[0];
  S.scrView = S.scrView || !p ? null : { x: p.x, y: p.y };
  S.scrWatchNext = 0;   // 馬上重算要不要訂閱螢幕畫面
  if (S.scrView) {
    toast('觀看大螢幕中：移動角色就回到原本的視角', 2200);
    const pr = propsHere().find(q => q.kind === 'screen');
    if (pr && p) { const r = propRect(pr); aimAt(p, r.x + r.w / 2, r.y + r.h / 2); }   // 點觀看：角色自動轉向面對大螢幕（使用者要求）
  }
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
function boardBlock(box, v, mk, fmt, key = 'board', title = '🏆 排行榜（前三名）') {   // key／title：星球合成另有「對戰排行榜」（v.board2）
  const b = v[key] || [], el = mk('div', 'table-board');
  el.appendChild(mk('div', 'table-board-title', title));
  if (!b.length) el.appendChild(mk('div', 'table-board-row empty', '還沒有紀錄'));
  b.forEach((e, i) => {   // 兩欄對齊：名字（含名次圖示）靠右、分數靠左，中間留一條對齊的空隙
    const row = mk('div', 'table-board-row pair');
    row.appendChild(mk('span', 'tb-name', `${['🥇', '🥈', '🥉'][i] || i + 1 + '.'} ${e.name}`));
    row.appendChild(mk('span', 'tb-score', fmt(e.score)));
    el.appendChild(row);
  });
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
}
// ---- 空氣曲棍球（t15／t16，2026-11-13，使用者要求）：2～4 人分藍紅兩隊（入座順序輪流：座位 0、2 藍隊在左，1、3 紅隊在右；2026-11-14 使用者要求最多 2v2，原本 2～8 人），人數要偶數 ----
// 用滑鼠（或 WASD／方向鍵）移動自己的握把，只能在自己的半場；把圓盤打進對方球門得 1 分，先得 7 分或 3 分鐘到時分數高的贏。
// **物理在桌主（座位 0）那台**：圓盤的移動、反彈、碰撞、進球、結束都在那台算，約 12 次／秒送快照 hs（伺服器轉成 ths）；
// 每個人約 12 次／秒送自己握把的位置 hp（伺服器轉成 thp）。桌主用收到的位置算碰撞，別人打到圓盤的判定會晚一點點（網路延遲）。
const HK_W = 640, HK_H = 320, HK_PR = 18, HK_BR = 11, HK_GOAL = 120, HK_SEND_MS = 80;   // 場地、握把半徑、圓盤半徑、球門寬、回報間隔
const HK_MAX_PAD = 1700, HK_MAX_PUCK = 600, HK_KEY_SPD = 600, HK_STEP_PX = 10;          // 握把最快速度、圓盤最快速度、鍵盤移動速度（px／秒）、桌主算碰撞時握把每小段最多移動幾 px
// 圓盤最快速度 950→600（2026-11-14 使用者要求降低圓盤速度；握把變快後快甩的擊球太容易直接打到最高速）
// 手感調整（2026-11-14 使用者說「手感有點差、增加靈敏度」）：握把最快速度 900→1700（快甩滑鼠時握把不再落在滑鼠後面）、鍵盤 420→600、別人的握把追蹤 18→28；
// 握把變快後一個畫格會移動很遠，所以桌主算碰撞時把這一格內握把的移動切成小段（每段不超過 HK_STEP_PX），避免高速握把穿過圓盤
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
    hit: false, hitT: 0, ackT: -1, pend: null, faceT: 0, vo: { x: 0, y: 0 }, snapT: null,
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
  H.f = 1; H.faceT = hkNow(H) * 1000; H.vo.x = H.vo.y = 0;
}
// 擊球只算一次（2026-11-16，使用者說紅隊跟藍隊像在不同世界線：球過中線就大幅瞬移、穿過握把打不到）：原本非桌主的本機預測與桌主各自算同一次擊球
// （握把位置、速度兩邊不一樣），結果對不上。現在**誰的握把打到圓盤就由那台回報結果**（hp 夾帶 h），桌主照用、不再算別人握把的碰撞。
// 回報在路上的這段時間桌主那邊的圓盤會繼續往前，所以：收到回報後照時間戳往前推算（hkAdvance）；圓盤進了「有非桌主防守」的球門先等 HK_GOAL_WAIT 秒才記分，
// 這段時間內收到防守方「其實有打到」的回報就取消。
const HK_GOAL_WAIT = .25, HK_HIT_FWD = .25;   // 進球等待秒數、擊球回報最多往前推算幾秒
function hkWalls(L) {   // 牆壁反彈（球門口不擋）
  if (L.y < HK_BR) { L.y = HK_BR; L.vy = Math.abs(L.vy) * .9; }
  if (L.y > HK_H - HK_BR) { L.y = HK_H - HK_BR; L.vy = -Math.abs(L.vy) * .9; }
  const inGoal = Math.abs(L.y - HK_H / 2) < HK_GOAL / 2 - HK_BR * .3;
  if (L.x < HK_BR && !inGoal) { L.x = HK_BR; L.vx = Math.abs(L.vx) * .9; }
  if (L.x > HK_W - HK_BR && !inGoal) { L.x = HK_W - HK_BR; L.vx = -Math.abs(L.vx) * .9; }
}
function hkAdvance(L, sec) {   // 只照牆壁與摩擦往前推算 sec 秒（不算握把）
  for (let left = Math.max(0, sec); left > 1e-4; left -= .016) {
    const dt = Math.min(.016, left);
    L.x += L.vx * dt; L.y += L.vy * dt;
    const fr = Math.max(0, 1 - .25 * dt); L.vx *= fr; L.vy *= fr;
    hkWalls(L);
  }
}
function hkScore(H, team) {   // 桌主：team 那隊得分
  if (team) H.sb++; else H.sa++;
  H.flash = { team, until: performance.now() + 1200 }; H.pend = null;
  hkFaceoff(H, 1 - team);
}
function hkApplyHit(H, i, h) {   // 桌主：採用座位 i 回報的擊球結果 h＝[x, y, vx, vy, 遊戲時間毫秒, 還貼著圓盤 1／0]
  const nowMs = hkNow(H) * 1000;
  if (H.over || h[4] <= H.faceT || h[4] <= H.ackT) return;   // 上一次進球之前的、比已採用的還舊的：不理
  if (H.pend) { if (H.pend.team === i % 2) return; H.pend = null; }   // 等待記分中：只有防守方的回報能取消
  else if (H.f > 0) return;
  const P = H.puck, ox = P.x + H.vo.x, oy = P.y + H.vo.y;
  P.x = h[0]; P.y = h[1]; P.vx = h[2]; P.vy = h[3];
  if (!h[5]) hkAdvance(P, Math.min(HK_HIT_FWD, (nowMs - h[4]) / 1000));   // 握把已經離開圓盤：照時間戳補上回報在路上的時間（還貼著的話不推算，下一份回報很快就來）
  H.vo.x = ox - P.x; H.vo.y = oy - P.y;   // 桌主畫面上的圓盤從原本的位置滑過去，不直接跳
  H.ackT = h[4];
}
function hkPhysics(H, dt) {   // 桌主：圓盤
  const P = H.puck;
  if (H.pend) { H.pend.left -= dt; if (H.pend.left <= 0) hkScore(H, H.pend.team); return; }   // 等防守方的擊球回報
  if (H.f > 0) { H.f -= dt; return; }
  P.x += P.vx * dt; P.y += P.vy * dt;
  const fr = Math.max(0, 1 - .25 * dt); P.vx *= fr; P.vy *= fr;
  hkWalls(P);
  if (P.x < -HK_BR || P.x > HK_W + HK_BR) {   // 進球：左邊球門＝紅隊得分、右邊＝藍隊得分；防守方有非桌主的人就先等一下
    const team = P.x < 0 ? 1 : 0, wait = team === 0 || H.n > 2;
    if (wait) H.pend = { team, left: HK_GOAL_WAIT }; else hkScore(H, team);
    return;
  }
  H.pads.forEach((p, i) => {   // 自己（桌主）的握把撞圓盤：推出去、照相對速度反彈；別人的握把由他們自己那台回報（hkApplyHit）
    if (i !== H.me) return;
    const dx = P.x - p.x, dy = P.y - p.y, d = Math.hypot(dx, dy), md = HK_PR + HK_BR;
    if (d >= md || d < 1e-6) return;
    const nx = dx / d, ny = dy / d;
    P.x = p.x + nx * md; P.y = p.y + ny * md;
    const pvx = i === H.me ? p.vx : p.vx || 0, pvy = i === H.me ? p.vy : p.vy || 0;
    const rvx = P.vx - pvx, rvy = P.vy - pvy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { P.vx -= 1.9 * vn * nx; P.vy -= 1.9 * vn * ny; }
    P.vx += nx * 40; P.vy += ny * 40; H.hsNow = true;
  });
  const sp = Math.hypot(P.vx, P.vy); if (sp > HK_MAX_PUCK) { P.vx *= HK_MAX_PUCK / sp; P.vy *= HK_MAX_PUCK / sp; }
}
// 非桌主的本機預測（2026-11-15，使用者說紅隊手感超怪、實際碰撞比看到的位置慢半秒）：圓盤的物理在桌主那台，自己的握把位置要經過「送到桌主＋桌主算完＋快照送回來」
// 才會看到圓盤反應（兩趟網路加上 80ms 取樣加上平滑，約 0.3～0.5 秒）。所以自己的畫面上先用自己的握把預測圓盤（只算跟自己握把的碰撞、牆壁反彈），打到圓盤立刻就有反應；
// 桌主的快照照常來，打到之後 PRED_GRACE 秒內不拉回（等桌主收到我的握把位置、算出同一擊），過了才慢慢對齊；進球／開球凍結時直接照快照。
const HK_PRED_GRACE = .7;
function hkPredict(H, L, dt) {
  L.x += L.vx * dt; L.y += L.vy * dt;
  const fr = Math.max(0, 1 - .25 * dt); L.vx *= fr; L.vy *= fr;
  hkWalls(L);
  const p = H.pads[H.me]; if (!p) return false;
  const dx = L.x - p.x, dy = L.y - p.y, d = Math.hypot(dx, dy), md = HK_PR + HK_BR;
  if (d >= md || d < 1e-6) return false;
  const nx = dx / d, ny = dy / d;
  L.x = p.x + nx * md; L.y = p.y + ny * md;
  const rvx = L.vx - (p.vx || 0), rvy = L.vy - (p.vy || 0), vn = rvx * nx + rvy * ny;
  if (vn < 0) { L.vx -= 1.9 * vn * nx; L.vy -= 1.9 * vn * ny; }
  L.vx += nx * 40; L.vy += ny * 40;
  const sp = Math.hypot(L.vx, L.vy); if (sp > HK_MAX_PUCK) { L.vx *= HK_MAX_PUCK / sp; L.vy *= HK_MAX_PUCK / sp; }
  return true;
}
function hkFrame() {
  const H = S.hk, v = S.tableView;
  if (!H || !S.tableOpen || !v || v.phase !== 'playing' || v.game !== 'hockey') { S.hkRaf = 0; if (S.tableOpen && v?.game === 'hockey') buildTable(); return; }
  S.hkRaf = requestAnimationFrame(hkFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - H.last) / 1000)); H.last = now;
  const t = hkNow(H);
  H.pads.forEach(p => { p.x0 = p.x; p.y0 = p.y; });   // 這一格開始時的位置（桌主切小段算碰撞用）
  if (H.me >= 0 && t >= 0 && !H.over) {
    hkMoveMine(H, dt);
    // 自己的握把位置（桌主的夾在下面的 hs 裡送：hp 與 hs 共用同一個限流）
    // 打到圓盤時夾帶「現在預測的圓盤」h（擊球回報），而且不等 80ms、過了伺服器的 60ms 限流就送
    if (!H.host && now - H.sendAt >= (H.hit || H.rel ? 64 : HK_SEND_MS)) {
      H.sendAt = now; const p = H.pads[H.me], m = { a: 'hp', x: Math.round(p.x), y: Math.round(p.y) }, L = H.pp;
      // h 的第 6 個＝1 還貼著圓盤（推著走／壓在牆邊）、0 已經離開：貼著的時候圓盤被握把擋著，桌主不能自己往前推算；離開後的那一份才是自由飛行，桌主照時間戳往前推算
      if ((H.hit || H.rel) && L) { H.hitT = Math.max(1, Math.round(t * 1000)); m.h = [Math.round(L.x), Math.round(L.y), Math.round(L.vx), Math.round(L.vy), H.hitT, H.hit ? 1 : 0]; H.pgrace = now + HK_PRED_GRACE * 1000; }
      H.rel = H.hit; H.hit = false;
      S.net?.tbl?.(m);
    }
  }
  H.pads.forEach((p, i) => {   // 別人的握把：往收到的位置平滑移動（速度用兩次回報的差估計，桌主算碰撞用）
    if (i === H.me) return;
    const a = 1 - Math.exp(-dt * 28); p.x += (p.tx - p.x) * a; p.y += (p.ty - p.y) * a;
  });
  if (H.host && t >= 0 && !H.over) {
    const mv = Math.max(...H.pads.map(p => Math.hypot(p.x - p.x0, p.y - p.y0))), n = Math.max(4, Math.min(24, Math.ceil(mv / HK_STEP_PX)));   // 這一格握把最多移動 mv px → 切成 n 小段
    const fin = H.pads.map(p => [p.x, p.y]);
    for (let k = 1; k <= n; k++) {
      H.pads.forEach((p, i) => { p.x = p.x0 + (fin[i][0] - p.x0) * k / n; p.y = p.y0 + (fin[i][1] - p.y0) * k / n; });   // 握把走到這一小段的位置
      hkPhysics(H, dt / n);
    }
    H.pads.forEach((p, i) => { p.x = fin[i][0]; p.y = fin[i][1]; });
    if (now - H.hsAt >= (H.hsNow ? 64 : HK_SEND_MS)) { H.hsAt = now; H.hsNow = false; const P = H.puck;   // 桌主自己剛打到圓盤：不等 80ms，過了伺服器的 60ms 限流就送（別人早一點看到球被打回來）
      const me = H.pads[0]; S.net?.tbl?.({ a: 'hs', x: Math.round(P.x), y: Math.round(P.y), vx: Math.round(P.vx), vy: Math.round(P.vy), sa: H.sa, sb: H.sb, f: Math.round(Math.max(0, H.f) * 1000), px: Math.round(me.x), py: Math.round(me.y), ts: Math.max(0, Math.round(t * 1000)), k: Math.max(0, H.ackT) }); }
    if (H.sa >= H.goals || H.sb >= H.goals || t >= H.lim) { H.over = true; tblFinal({ a: 'hend', sa: H.sa, sb: H.sb }); }
    const da = Math.exp(-dt * 14); H.vo.x *= da; H.vo.y *= da;   // 採用別人的擊球回報時的位置修正，滑過去
    H.view.x = H.puck.x + H.vo.x; H.view.y = H.puck.y + H.vo.y;
  } else if (!H.host) {   // 其他人：圓盤＝最後一次快照往前推算（碰到上下牆反彈），再平滑
    const P = H.puck, age = H.snapT != null ? Math.max(0, Math.min(.3, t - H.snapT)) : Math.min(.25, (now - H.snapPerf) / 1000);   // 快照帶時間戳：照真正的延遲往前推算
    const E = { x: P.x, y: P.y, vx: P.vx, vy: P.vy }; if (H.f <= 0) hkAdvance(E, age);   // 推算時照牆壁反彈與摩擦（原本只算上下牆，球會先穿過左右牆再被拉回來）
    const x = E.x, y = E.y;
    const V = H.view, L = (H.pp ||= { x: V.x, y: V.y, vx: P.vx, vy: P.vy });
    if (H.me < 0 || H.f > 0 || H.snapReset || t < 0) { L.x = x; L.y = y; L.vx = P.vx; L.vy = P.vy; H.snapReset = false; }   // 觀戰者／開球凍結／剛進球：照快照
    else {
      const mv = Math.hypot(H.pads[H.me].x - H.pads[H.me].x0, H.pads[H.me].y - H.pads[H.me].y0), n = Math.max(1, Math.min(12, Math.ceil(mv / HK_STEP_PX)));
      const fin = [H.pads[H.me].x, H.pads[H.me].y], me = H.pads[H.me]; let hit = false;
      for (let k = 1; k <= n; k++) { me.x = me.x0 + (fin[0] - me.x0) * k / n; me.y = me.y0 + (fin[1] - me.y0) * k / n; if (hkPredict(H, L, dt / n)) hit = true; }
      me.x = fin[0]; me.y = fin[1];
      if (hit) { H.pgrace = now + HK_PRED_GRACE * 1000; H.hit = true; }   // 打到了：下一次 hp 夾帶回報；桌主確認採用（快照的 k）之前不拉回，最多等 PRED_GRACE 秒
      if (now > (H.pgrace || 0)) {   // 沒有剛打過：緊跟桌主的快照（速度直接照用、位置快速滑過去；原本 8／秒太慢，桌主一擊球這邊就落後一大段再瞬移）
        const a = 1 - Math.exp(-dt * 20);
        if (Math.hypot(x - L.x, y - L.y) > 260) { L.x = x; L.y = y; }
        else { L.x += (x - L.x) * a; L.y += (y - L.y) * a; }
        L.vx = E.vx; L.vy = E.vy;
      }
    }
    V.x = L.x; V.y = L.y;
  }
  hkDraw(H, t, v);
}
function onNetThp(m) {   // 別人的握把位置（i＝座位）
  const H = S.hk; if (!H || m.i === H.me || !H.pads[m.i]) return;
  const p = H.pads[m.i], now = performance.now(), dt = (now - (p.at || now)) / 1000;
  if (p.at && dt > .01 && dt < .5) { p.vx = Math.max(-HK_MAX_PAD, Math.min(HK_MAX_PAD, (m.x - p.tx) / dt)); p.vy = Math.max(-HK_MAX_PAD, Math.min(HK_MAX_PAD, (m.y - p.ty) / dt)); }
  else { p.vx = 0; p.vy = 0; }
  p.tx = m.x; p.ty = m.y; p.at = now;
  if (H.host && Array.isArray(m.h) && m.h.length === 6) hkApplyHit(H, m.i, m.h);   // 擊球回報：桌主照用
}
function onNetThs(m) {   // 桌主的圓盤快照
  const H = S.hk; if (!H || H.host) return;
  if (m.sa > H.sa) H.flash = { team: 0, until: performance.now() + 1200 };
  if (m.sb > H.sb) H.flash = { team: 1, until: performance.now() + 1200 };
  if (m.sa !== H.sa || m.sb !== H.sb) H.snapReset = true;   // 進球：預測的圓盤作廢，照快照
  H.puck = { x: m.x, y: m.y, vx: m.vx, vy: m.vy }; H.sa = m.sa; H.sb = m.sb; H.f = m.f / 1000; H.snapPerf = performance.now();
  H.snapT = typeof m.ts === 'number' ? m.ts / 1000 : null;
  if (!H.hit && !H.rel && H.hitT && typeof m.k === 'number' && m.k >= H.hitT) H.pgrace = 0;   // 桌主已經照我回報的擊球算了：可以開始對齊快照
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
  const V = H.view;
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
function mzMake(v) {   // 一局的本機狀態（玩家／觀戰者／大螢幕共用；大螢幕那份 v.role 是 spec，只吃快照）
  const z = v.mz, me = v.role === 'seat' ? v.me : -1;
  const role = me >= 0 && me === z.pac ? 'pac' : me >= 0 && z.gh.includes(me) ? 'ghost' : 'spec';
  const M = {
    key: z.seed + ':' + z.t0, role, solo: z.solo, t0: z.t0, off: z.sn - Date.now(), lim: (z.lim || 240000) / 1000, gh: [...z.gh], myK: z.gh.indexOf(me),
    dots: new Uint8Array(MZ_DOTS.length).fill(1), left: MZ_DOTS.length, eaten: 0, sc: 0, lv: MZ_LIVES, lvl: 1, pw: 0, chain: 0, fz: 0, dead: 0, clear: 0,
    clock: 0, modeT: 0, phase: 0, rs: 0, ct: [0, 0, 0, 0], bonus: 0, bonusN: 0, extra: false, over: false, snapAt: 0, anim: 0, pops: [], last: performance.now(),
    pac: mzEnt(...MZ_PAC0, 3), ghosts: MZ_GHOST0.map(([x, y]) => mzEnt(x, y, -1)),
    hm: MZ_GHOST0.map(([x, y]) => ({ x, y, d: -1, rm: 0, mode: 0, saw: false, t: 0, has: false })),   // 豆豆那台：幽靈玩家的最新位置與狀態
    rPac: mzRec(...MZ_PAC0), rG: MZ_GHOST0.map(([x, y]) => mzRec(x, y)), rH: MZ_GHOST0.map(([x, y]) => mzRec(x, y)),   // 其他人：畫面上的位置（平滑）
    mine: role === 'ghost' ? mzEnt(...MZ_GHOST0[z.gh.indexOf(me)], -1) : null, myMode: 0, reviveAt: -9, fzShow: 0,
  };
  M.ghosts.forEach((e, k) => { e.rel = mzRelDelay(M, k); });
  return M;
}
function mzStart(v) {
  S.mz = mzMake(v);
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
  tblFinal({ a: 'over', sc: M.sc, lvl: M.lvl, win: !!win, tu: !!tu, ct: M.ct.map(n => Math.min(99, n)) });
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
function onNetTms(m) { mzApplyTms(S.mz, m); }   // 豆豆的快照（幽靈玩家與觀戰者才收到）
function mzApplyTms(M, m) {
  if (!M || M.role === 'pac') return;
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
function onNetTmp(m) { mzApplyTmp(S.mz, m); }   // 幽靈玩家的位置（k＝第幾隻幽靈）
function mzApplyTmp(M, m) {
  if (!M || m.k < 0 || m.k > 3) return;
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
function mzDraw(M, t, v, cv = $('mzCanvas')) {
  if (!cv) return;
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
// ---- 彈珠台（第十九桌 t19，2026-11-15，使用者要求）：單人、3 顆球、分數進排行榜 ----
// 2026-11-16 依使用者給的設計圖重做成「海底」版面：水母／海膽彈跳器、魚群／丑魚標靶、旋轉門、貝殼洞、寶箱、珍珠、入口燈、線道燈、鯨魚軌道、左反彈器、右閘門、救援柱、救球燈（規則見 docs/notes.md）。
// 物理全在客戶端跑（固定 240Hz 小步進：重力、牆／導軌的線段碰撞、圓形物件、會動的擋板）；伺服器只開局、收最後分數（over）、把快照 pbs 轉給觀戰者與大螢幕。
// 觀戰者與大螢幕只吃快照（球的位置、擋板有沒有按、分數、剩球、狀態、閃光與各種燈／標靶的狀態，打包在 f），畫面用同一個 pbDraw。
const PB_W = 300, PB_H = 600, PB_R = 6, PB_G = 760, PB_DT = 1 / 240, PB_BALLS = 3, PB_SNAP_MS = 100;
const PB_LANE_X = 275, PB_LANE_Y = 532;                     // 發球道：球停在這裡等拉桿
const PB_FLIP = { L: 47, REST: 26 * Math.PI / 180, UP: -30 * Math.PI / 180, SPD: 24, TH: 5, pl: [77.5, 543], pr: [197.5, 543] };   // 擋板：長度、休息／舉起的角度（往下為正）、轉速（弧度／秒）、半厚、左右轉軸
// 座標＝設計圖座標換算（x＝10＋(x'−390)×0.5、y＝8＋(y'−30)×0.45）；以下 x、y、半徑都是畫布座標
const PB_BUMPERS = [[100.5, 148, 20, 330, 100], [170.5, 148, 20, 330, 100], [135.5, 202, 20, 330, 100],   // 水母（大）：踢力強、100 分
  [135.5, 122, 9, 160, 25], [215.5, 167, 9, 160, 25], [60.5, 180, 9, 160, 25], [100.5, 257, 9, 160, 25], [175.5, 262, 9, 160, 25]];   // 海膽（小 5 個）：25 分，魚群標靶全倒後 ×2。閃光位元 0～2 水母、3～7 海膽
const PB_FISH = [[40, 326], [40, 345], [40, 364]];     // 魚群標靶（左）：50 分，打到就倒；全倒 +500、海膽 ×2、左反彈器充能
const PB_UGLY = [[238.5, 326], [238.5, 345], [238.5, 364]];  // 丑魚標靶（右）：50 分；全倒 +500、貝殼洞開啟（1000 分）、右閘門關上
const PB_ENT = [215, 245, 275, 305].map(d => { const a = d * Math.PI / 180; return [150 + 125 * Math.cos(a), 148 + 125 * Math.sin(a), a]; });   // 入口燈：沿著上方弧形外框斜著排（離牆 15）；球貼著外框滾過去就亮，4 顆全亮＝鯨魚軌道雙倍計分
const PB_LANEL = [[19.5, 410], [39.5, 410], [231.5, 410], [251.5, 410]];   // 內外線道燈：球滾過就亮，全亮 +300
const PB_SPIN = [[54, 211, 11, -.12, 40], [67, 154, 11, .56, 40], [114, 112, 11, 1.1, 40], [174, 94, 11, 1.44, 40], [275, 215, 10, 0, 12], [275, 259, 10, 0, 12], [275, 301, 10, 0, 12]];   // 旋轉門（球穿過去會轉，每轉一圈 10 分）：x、y、半寬、擺放角度（弧度）、被球帶動的最大轉速。2026-11-16 使用者給的圖：鯨魚軌道上 4 條（斜的、垂直於軌道，球走鯨魚軌道時會一路帶轉）、發球道裡 3 條（轉速上限低，不然每次發球都白拿一堆分）。觀戰者的閃光位元只有兩個（11、12），照「第幾個 % 2」共用
const PB_SHELLS = [{ x: 198.5, y: 356, v: [-40, 120] }];   // 貝殼洞（2026-11-16 使用者要求刪掉左邊那個，只剩右邊）：球掉進去關 0.8 秒再彈出（250 分，開啟時 1000），並升起一次救援柱。彈出方向＝落在同側擋板上（原本往場中央丟，會直接掉進兩個擋板中間的排水口）
const PB_POSTS = [[70.5, 311, 6], [200.5, 311, 6]];                // 珊瑚柱（橡膠立柱）：只讓球改變方向
const PB_PEARLS = [[100.5, 342], [135.5, 342], [170.5, 342]];      // 珍珠標靶：30 分；三顆都亮送一顆球（+500）。2026-11-16 使用者要求往上移（原本在擋板正上方 y＝460，球一打就被彈回排水口）
const PB_CHEST = [136.5, 266, 136.5, 304];                             // 寶箱標靶：打到倍率 +1（最高 ×5，掉球歸 1）。2026-11-16 使用者說正中間的橫板很礙事，改成貼著右邊發球道隔板的直板（左擋板自然出球的路線上，跟左牆的隧道對稱；貼牆是為了不讓球卡在板子上面）
const PB_RAMP = [[88, 264], [24, 230], [40, 95], [205, 92]], PB_RAMP_T = 1.1;   // 鯨魚軌道（貝茲曲線，球從左邊入口被帶到上面右邊的出口）。2026-11-16 使用者說原本出口往右（球直衝最右邊掉進右外線道，模擬 100% 兩三秒內死掉），改成出口往左下、丟回水母群：出口 [205,92]、速度（−40～−100, 60）隨機，四秒內掉光的比例降到約 2 成
const PB_RESCUE = [135.5, 579, 7], PB_RESCUE_S = 12;               // 救援柱位置；救球燈：發射後 12 秒內掉進排水口，重發同一顆
const PB_SLOW = .7;                                                 // 整台的時間倍率（2026-11-16 使用者說球太快看不到就死了）：物理照原本的數值算，只是每秒只前進 0.7 秒，軌跡不變、整體慢動作
const PB_ZOOM = 1.4;                                                // 牌桌上的顯示倍率（2026-11-16 使用者要求放大，先 1.2 後再加大到 1.4；物理座標不變，pbDraw 依 canvas 寬度自己縮放）
const PB_LGATE = [260, 109, 271.2, 78];                             // 發球道出口的擋板：球射出、離開出口後關上（球不會再掉回發球道），回到等拉桿時打開
const PB_PEARL_S = 2.5;                                                 // 珍珠燈號亮著的秒數（2026-11-18 使用者說太好拿：原本亮到這顆球結束，改成 4 秒內三顆都要打亮，超過就熄；到最後 1 秒會閃）
const PB_JACK_MS = 3200;                                             // 深海寶藏（隧道滿 3 次）的全場燈效長度：場上所有會亮的東西輪流閃（老機台那種「能用的燈都拿來閃」）
const PB_TUN = { x: 30, y: 285, r: 17, t: 1, n: 3, out: [135.5, 46, 25, 60], pts: 1000, jack: 5000 };   // 海底隧道（主要目標）：左牆的洞口，在右擋板自然出球的路線上，球碰到洞口就算、任何角度（2026-11-16 使用者要求，判定範圍＝畫出來的半橢圓加球半徑；原本要往上衝才算）；1 秒後從上方掉進水母群。每次 1000 分，集滿 3 次＝深海寶藏 +5000（跨球保留）
const PB_TRIS = [[[50.5, 428], [78.5, 510], [50.5, 494]], [[220.5, 428], [192.5, 510], [220.5, 494]]];   // 珊瑚彈弓（三角形）的三個頂點：第一點→第二點那條是朝場內的踢球邊，其他兩條只是實心牆
const PB_SLINGS = PB_TRIS.map(t => [t[0][0], t[0][1], t[1][0], t[1][1]]);   // 彈弓：打到會被踢回去，得 10 分
const PB_ARCH = (() => {   // 外框：左牆往上、上方半圓（圓心 [150,148]、半徑 140）、右牆往下
  const p = [[10, 585], [10, 148]];
  for (let k = 1; k <= 40; k++) { const a = Math.PI + k * Math.PI / 40; p.push([150 + 140 * Math.cos(a), 148 + 140 * Math.sin(a)]); }
  p.push([290, 585]); return p;
})();
const PB_SEGS = (() => {   // 牆與導軌：[x1, y1, x2, y2]
  const s = [];
  for (let k = 0; k + 1 < PB_ARCH.length; k++) s.push([PB_ARCH[k][0], PB_ARCH[k][1], PB_ARCH[k + 1][0], PB_ARCH[k + 1][1]]);
  s.push([260, 109, 260, 585], [260, 585, 290, 585]);                                  // 發球道的隔板與底
  s.push([14, 228, 75, 283]);                                                          // 隧道上方從左牆斜下來的擋板（使用者給的圖；2026-11-16 使用者說發球直接進隧道，加長到蓋住洞口上方：模擬發球直進隧道的比例 39% → 1%，擋板打上來進隧道約 23% → 19%）
  s.push([28.5, 392, 28.5, 495], [28.5, 495, 75, 541], [242.5, 392, 242.5, 495], [242.5, 495, 200, 541]);   // 左右外線道的內牆，再斜下去把球送到擋板
  for (const t of PB_TRIS) s.push([t[1][0], t[1][1], t[2][0], t[2][1]], [t[2][0], t[2][1], t[0][0], t[0][1]]);   // 三角彈弓的另外兩條邊
  return s;
})();
const pbBez = (c, s) => { const u = 1 - s, a = u * u * u, b = 3 * u * u * s, d = 3 * u * s * s, e = s * s * s; return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]]; };
function pbNewBall(P) {   // 下一顆球：回發球道，這一顆的狀態歸零（珍珠也歸零：2026-11-17 使用者說太好湊，改成同一顆球內打滿三顆才送球）
  const b = P.ball; b.x = PB_LANE_X; b.y = PB_LANE_Y; b.vx = b.vy = 0;
  P.st = 0; P.power = 0; P.mult = 1; P.ent = [0, 0, 0, 0]; P.lane = [0, 0, 0, 0]; P.fish = [0, 0, 0]; P.ugly = [0, 0, 0]; P.pearl = [0, 0, 0]; P.pearlT = [0, 0, 0]; P.hole = null;
  P.gate = P.shell = P.post = P.whale = P.u2 = P.lg = 0; P.kick = 1; P.ramp = P.cap = null; P.rescued = 0; P.ballT = 0;
}
function pbMake(v) {
  const z = v.pb, me = v.role === 'seat';
  const P = {
    key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), role: me ? 'seat' : 'spec', over: false,
    balls: PB_BALLS, score: 0, mult: 1, st: 0, power: 0, calm: 0, ballT: 0, pearl: [0, 0, 0], tun: 0, resc: 0, note: null,
    ball: { x: PB_LANE_X, y: PB_LANE_Y, vx: 0, vy: 0 },
    fl: { a: PB_FLIP.REST }, fr: { a: PB_FLIP.REST }, keys: { l: 0, r: 0, p: 0 }, flash: new Array(16).fill(0), sp: PB_SPIN.map(() => ({ a: 0, w: 0, acc: 0 })), jack: 0,
    snap: null, snapAt: 0, last: performance.now(), acc: 0,
  };
  pbNewBall(P); return P;
}
function pbStart(v) {
  pbStop(); S.pb = pbMake(v);
  S.pbRaf = requestAnimationFrame(pbFrame);
}
function pbStop() { S.pb = null; if (S.pbRaf) { cancelAnimationFrame(S.pbRaf); S.pbRaf = 0; } }
const pbNow = P => (Date.now() + P.off - P.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function pbKey(e, down) {   // 彈珠台的按鍵：左擋板 ← A Z／右擋板 → D ／ M／拉桿 空白 ↓ S（回 true＝已處理）
  const P = S.pb, v = S.tableView; if (!P || !v || v.game !== 'pinball' || P.role !== 'seat') return false;
  const k = e.key.toLowerCase(), l = ['arrowleft', 'a', 'z'].includes(k), r = ['arrowright', 'd', '/', 'm'].includes(k), p = [' ', 'arrowdown', 's'].includes(k);
  if (!l && !r && !p) return false;
  e.preventDefault();
  if (l) P.keys.l = down ? 1 : 0; if (r) P.keys.r = down ? 1 : 0; if (p) P.keys.p = down ? 1 : 0;
  return true;
}
function pbHitSeg(b, x1, y1, x2, y2, e, th) {   // 球撞線段（th＝線的半厚）：回 true＝撞到
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  let t = L2 ? ((b.x - x1) * dx + (b.y - y1) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const px = x1 + dx * t, py = y1 + dy * t; let nx = b.x - px, ny = b.y - py, d = Math.hypot(nx, ny);
  const rr = PB_R + th; if (d >= rr) return false;
  if (d < 1e-6) { nx = -dy; ny = dx; d = Math.hypot(nx, ny) || 1; }
  nx /= d; ny /= d; b.x = px + nx * rr; b.y = py + ny * rr;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
  return true;
}
function pbCirc(b, cx, cy, r, e, kick) {   // 球撞圓形物件（e＝彈性、kick＝額外踢力）：回 true＝撞到
  const dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy), rr = r + PB_R;
  if (d >= rr || d < 1e-6) return false;
  const nx = dx / d, ny = dy / d; b.x = cx + nx * rr; b.y = cy + ny * rr;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
  if (kick) { b.vx += nx * kick; b.vy += ny * kick; }
  return true;
}
function pbFlipperSeg(P, left) {   // 擋板現在的線段 [x1, y1, x2, y2]（轉軸→尖端）與尖端的移動速度要用的角速度
  const f = left ? P.fl : P.fr, pv = left ? PB_FLIP.pl : PB_FLIP.pr, s = left ? 1 : -1;
  return [pv[0], pv[1], pv[0] + s * PB_FLIP.L * Math.cos(f.a), pv[1] + PB_FLIP.L * Math.sin(f.a), f];
}
function pbNote(P, t, now) { P.note = { t, until: now + 2200 }; }
function pbStep(P, dt) {   // 往前模擬 dt 秒（只有自己的局）
  const now = performance.now();
  // 擋板
  for (const left of [true, false]) {
    const f = left ? P.fl : P.fr, want = (left ? P.keys.l : P.keys.r) ? PB_FLIP.UP : PB_FLIP.REST, old = f.a;
    f.a += Math.max(-PB_FLIP.SPD * dt, Math.min(PB_FLIP.SPD * dt, want - f.a)); f.w = (f.a - old) / dt;
  }
  const b = P.ball;
  if (P.st === 0) {   // 球在發球道等拉桿：按住蓄力、放開發射
    b.x = PB_LANE_X; b.y = PB_LANE_Y; b.vx = b.vy = 0;
    if (P.keys.p) P.power = Math.min(1, P.power + dt / .9);
    else if (P.power > 0) { b.vy = -(620 + 520 * P.power); P.power = 0; P.st = 1; P.ballT = 0; }
    return;
  }
  if (P.st !== 1) return;
  P.ballT += dt;
  for (let i = 0; i < 3; i++) if (P.pearl[i] && (P.pearlT[i] -= dt) <= 0) P.pearl[i] = 0;   // 珍珠燈號時限
  P.sp.forEach((s, i) => {   // 旋轉門：每轉一圈 10 分
    s.a += s.w * dt; s.w *= Math.exp(-1.2 * dt);
    if (s.w < .3) { s.w = 0; return; }
    P.flash[11 + i % 2] = now + 140;
    s.acc += s.w * dt; while (s.acc >= Math.PI * 2) { s.acc -= Math.PI * 2; P.score += 10 * P.mult; }
  });
  if (P.ramp) {   // 鯨魚軌道：球沿著曲線走，到終點從出口射出
    P.ramp.t += dt; const p = pbBez(PB_RAMP, Math.min(1, P.ramp.t / PB_RAMP_T)); b.x = p[0]; b.y = p[1]; b.vx = b.vy = 0;
    PB_SPIN.forEach(([x, y, hw, , cap], i) => { if (Math.hypot(b.x - x, b.y - y) < hw + 5) P.sp[i].w = Math.max(P.sp[i].w, Math.min(cap, 24)); });   // 沿軌道走過的旋轉門一路帶轉
    if (P.ramp.t >= PB_RAMP_T) { P.ramp = null; b.vx = -40 - Math.random() * 60; b.vy = 60; P.rampCd = 1; }
    return;
  }
  if (P.cap) {   // 在貝殼洞裡：球不見，時間到彈出來
    P.cap.t -= dt;
    if (P.cap.i === 2 && !P.hole && P.cap.t <= .4) P.hole = { h: 0 };   // 隧道出口：球掉出來前 0.4 秒先開洞（畫面特效，只有自己這台有）
    if (P.cap.t <= 0) {
      if (P.cap.i === 2) [b.x, b.y, b.vx, b.vy] = PB_TUN.out;   // 海底隧道：從上方出口掉出來
      else { const sh = PB_SHELLS[P.cap.i]; b.vx = sh.v[0]; b.vy = sh.v[1]; }
      P.cap = null; P.capCd = .8;
    }
    return;
  }
  if (P.rampCd > 0) P.rampCd -= dt;
  if (P.capCd > 0) P.capCd -= dt;
  if (P.chestCd > 0) P.chestCd -= dt;
  b.vy += PB_G * dt; b.x += b.vx * dt; b.y += b.vy * dt;
  const sp = Math.hypot(b.vx, b.vy); if (sp > 1100) { b.vx *= 1100 / sp; b.vy *= 1100 / sp; }
  for (const s of PB_SEGS) pbHitSeg(b, s[0], s[1], s[2], s[3], .5, 1);
  if (P.lg) pbHitSeg(b, PB_LGATE[0], PB_LGATE[1], PB_LGATE[2], PB_LGATE[3], .5, 1);   // 發球道出口的擋板（關著）
  else {   // 球整顆到了擋板的場內那一側就關上
    const gx = PB_LGATE[2] - PB_LGATE[0], gy = PB_LGATE[3] - PB_LGATE[1];
    if (((b.x - PB_LGATE[0]) * gy - (b.y - PB_LGATE[1]) * gx) / Math.hypot(gx, gy) > PB_R + 3) P.lg = 1;
  }
  PB_BUMPERS.forEach(([bx, by, br, kick, pts], i) => {   // 水母（0～2）、海膽（3～7）
    if (!pbCirc(b, bx, by, br, 1, kick)) return;
    P.score += pts * P.mult * (i >= 3 && P.u2 ? 2 : 1); P.flash[i] = now + 140;
  });
  PB_FISH.forEach(([x, y], i) => {
    if (P.fish[i] || !pbCirc(b, x, y, 7, .8, 0)) return;
    P.fish[i] = 1; P.score += 50 * P.mult; P.kick = 1;
    if (P.fish.every(Boolean)) {   // 魚群全倒：+500、海膽 ×2、水母連鎖加分
      P.fish = [0, 0, 0]; P.u2 = 1; P.score += (500 + 300) * P.mult; for (let k = 0; k < 3; k++) P.flash[k] = now + 400;
      pbNote(P, '魚群全倒！海膽 ×2', now);
    }
  });
  PB_UGLY.forEach(([x, y], i) => {
    if (P.ugly[i] || !pbCirc(b, x, y, 7, .8, 0)) return;
    P.ugly[i] = 1; P.score += 50 * P.mult;
    if (P.ugly.every(Boolean)) { P.ugly = [0, 0, 0]; P.shell = 1; P.gate = 1; P.score += 500 * P.mult; pbNote(P, '丑魚全倒！貝殼洞開啟、右閘門關上', now); }
  });
  PB_ENT.forEach(([x, y], i) => {   // 入口燈：球經過燈附近就亮
    if (P.ent[i] || Math.hypot(b.x - x, b.y - y) > 12) return;
    P.ent[i] = 1; P.score += 10 * P.mult;
    if (P.ent.every(Boolean)) { P.ent = [0, 0, 0, 0]; P.whale = 1; P.score += 100 * P.mult; pbNote(P, '鯨魚軌道 雙倍計分！', now); }
  });
  PB_LANEL.forEach(([x, y], i) => {
    if (P.lane[i] || Math.hypot(b.x - x, b.y - y) > 9) return;
    P.lane[i] = 1; P.score += 20 * P.mult;
    if (P.lane.every(Boolean)) { P.lane = [0, 0, 0, 0]; P.score += 300 * P.mult; pbNote(P, '線道燈全亮 +300', now); }
  });
  PB_SPIN.forEach(([x, y, hw, , cap], i) => { if (Math.hypot(b.x - x, b.y - y) < hw + 2) P.sp[i].w = Math.max(P.sp[i].w, Math.min(cap, Math.hypot(b.vx, b.vy) * .06)); });
  if (!(P.rampCd > 0) && b.vy < -120 && Math.hypot(b.x - PB_RAMP[0][0], b.y - PB_RAMP[0][1]) < 13) { P.ramp = { t: 0 }; P.score += 200 * (P.whale ? 2 : 1) * P.mult; return; }
  if (!(P.capCd > 0)) PB_SHELLS.forEach((sh, i) => {
    if (P.cap || Math.hypot(b.x - sh.x, b.y - sh.y) > 8) return;
    P.cap = { i, t: .8 }; P.score += (P.shell ? 1000 : 250) * P.mult; P.post = 1; P.flash[8 + i] = now + 300; b.x = sh.x; b.y = sh.y; b.vx = b.vy = 0;
  });
  if (!P.cap && !(P.capCd > 0) && ((b.x - 11) / 27) ** 2 + ((b.y - PB_TUN.y) / 23) ** 2 < 1) {   // 海底隧道：球碰到洞口（畫出來的半橢圓、外加球半徑）就算，任何角度（2026-11-16 使用者要求；原本要 vy < −150 往上衝才算）
    P.cap = { i: 2, t: PB_TUN.t }; P.tun++; P.score += PB_TUN.pts * P.mult; P.flash[15] = now + 400; b.x = PB_TUN.x; b.y = PB_TUN.y; b.vx = b.vy = 0;
    if (P.tun >= PB_TUN.n) { P.tun = 0; P.score += PB_TUN.jack * P.mult; P.jack = now + PB_JACK_MS; for (const sp of P.sp) sp.w = Math.max(sp.w, 26); pbNote(P, `深海寶藏！+${PB_TUN.jack * P.mult}`, now); }
    else pbNote(P, `海底隧道 ${P.tun}／${PB_TUN.n}`, now);
  }
  if (P.cap) return;
  for (const [px, py, pr] of PB_POSTS) pbCirc(b, px, py, pr, .75, 0);   // 珊瑚柱
  PB_PEARLS.forEach(([x, y], i) => {
    if (!pbCirc(b, x, y, 6, .6, 0) || P.pearl[i]) return;
    P.pearl[i] = 1; P.pearlT[i] = PB_PEARL_S; P.score += 30 * P.mult;
    if (P.pearl.every(Boolean)) { P.pearl = [0, 0, 0]; P.pearlT = [0, 0, 0]; P.balls = Math.min(5, P.balls + 1); P.score += 500 * P.mult; pbNote(P, '珍珠集滿：免費一球！', now); }
  });
  if (pbHitSeg(b, PB_CHEST[0], PB_CHEST[1], PB_CHEST[2], PB_CHEST[3], .6, 4.5) && !(P.chestCd > 0)) {   // 寶箱：倍率 +1
    P.chestCd = .35; if (P.mult < 5) P.mult++; P.score += 50 * P.mult; P.flash[10] = now + 200;
  }
  if (P.post && pbCirc(b, PB_RESCUE[0], PB_RESCUE[1], PB_RESCUE[2], 1, 0)) { b.vy -= 350; P.post = 0; }   // 救援柱：擋住排水口、球被彈回擋板，只用一次
  if (P.kick && b.x < 29 && b.y > 516) { b.vy = -900; b.vx = 20; b.y = 515; P.kick = 0; }          // 左反彈器：把掉進左外線道的球踢回去（一次）
  if (P.gate && b.x > 242 && b.x < 260 && b.y > 516) { b.vy = -800; b.vx = -160; b.y = 515; }      // 右閘門（關著）：擋住右外線道，球被彈回內線道
  for (let i = 0; i < PB_SLINGS.length; i++) {   // 彈弓：撞到被踢出去（沿法線加速）＋得分
    const s = PB_SLINGS[i];
    if (pbHitSeg(b, s[0], s[1], s[2], s[3], .6, 2)) {
      let nx = (s[3] - s[1]), ny = -(s[2] - s[0]); const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
      if (nx * (b.x - s[0]) + ny * (b.y - s[1]) < 0) { nx = -nx; ny = -ny; }
      if (b.vx * nx + b.vy * ny < 330) { b.vx += nx * 300; b.vy += ny * 300; P.score += 10 * P.mult; P.flash[13 + i] = now + 120; }
    }
  }
  for (const left of [true, false]) {   // 擋板：球相對擋板表面速度反彈，再加回表面速度（舉起的擋板把球打出去）
    const [x1, y1, x2, y2, f] = pbFlipperSeg(P, left), dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    let t = ((b.x - x1) * dx + (b.y - y1) * dy) / L2; t = Math.max(0, Math.min(1, t));
    const px = x1 + dx * t, py = y1 + dy * t; let nx = b.x - px, ny = b.y - py, d = Math.hypot(nx, ny), rr = PB_R + PB_FLIP.TH;
    if (d >= rr) continue;
    if (d < 1e-6) { nx = 0; ny = -1; d = 1; }
    nx /= d; ny /= d; b.x = px + nx * rr; b.y = py + ny * rr;
    const w = f.w || 0, rx = px - (left ? PB_FLIP.pl[0] : PB_FLIP.pr[0]), ry = py - (left ? PB_FLIP.pl[1] : PB_FLIP.pr[1]);
    const vsx = left ? -w * ry : w * ry, vsy = left ? w * rx : -w * rx;   // 擋板表面在這一點的速度（角速度 × 半徑；右擋板是鏡像）
    const rvx = b.vx - vsx, rvy = b.vy - vsy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { b.vx = rvx - 1.35 * vn * nx + vsx; b.vy = rvy - 1.35 * vn * ny + vsy; }
  }
  // 卡在發球道：球慢下來停在道內（拉桿沒蓄夠力）→ 回到等拉桿
  if (b.x > 262 && b.y > 480 && Math.hypot(b.vx, b.vy) < 25) { P.st = 0; P.lg = 0; return; }
  // 卡住：太久沒怎麼動就輕推一下
  if (Math.hypot(b.vx, b.vy) < 12) { P.calm += dt; if (P.calm > 3) { b.vx += (Math.random() - .5) * 200; b.vy -= 160; P.calm = 0; } } else P.calm = 0;
  if ((b.y > 600 && b.x < 262) || b.y > PB_H + 20) {   // 掉進排水口
    if (P.ballT < PB_RESCUE_S && !P.rescued) {   // 救球燈：發射後 12 秒內掉進去，重發同一顆
      P.rescued = 1; P.st = 0; P.lg = 0; P.power = 0; b.x = PB_LANE_X; b.y = PB_LANE_Y; b.vx = b.vy = 0; P.ramp = P.cap = null; pbNote(P, '救球燈！重發這一顆', now); return;
    }
    P.balls--;
    if (P.balls <= 0) { P.st = 3; P.over = true; tblFinal({ a: 'over', sc: P.score }); pbSnap(P, true); }
    else pbNewBall(P);
  }
}
function pbBits(P, now) {   // 快照的 f：閃光（16 位）＋各種燈／標靶狀態（24 位）＋倍率（3 位）＋發球道擋板（1 位）＋隧道次數（2 位）；剛好用到 2^46（兩份伺服器的上限）
  let fl = 0; P.flash.forEach((u, i) => { if (u > now) fl += 2 ** i; });
  const st = [...P.ent, ...P.lane, ...P.fish, ...P.ugly, ...P.pearl, P.gate, P.shell, P.post, P.kick, P.whale, P.u2, P.st === 1 && P.ballT < PB_RESCUE_S && !P.rescued ? 1 : 0];
  let n = 0; st.forEach((v, i) => { if (v) n += 2 ** i; });
  return fl + n * 65536 + Math.max(1, Math.min(7, P.mult)) * 2 ** 40 + (P.lg ? 2 ** 43 : 0) + Math.max(0, Math.min(3, P.tun)) * 2 ** 44;
}
function pbUnbits(P, f, now) {
  const fl = f % 65536, n = Math.floor(f / 65536) % 2 ** 24, bit = i => Math.floor(n / 2 ** i) % 2;
  for (let i = 0; i < 16; i++) if (Math.floor(fl / 2 ** i) % 2) P.flash[i] = now + 140;
  P.ent = [0, 1, 2, 3].map(i => bit(i)); P.lane = [0, 1, 2, 3].map(i => bit(4 + i)); P.fish = [0, 1, 2].map(i => bit(8 + i)); P.ugly = [0, 1, 2].map(i => bit(11 + i)); P.pearl = [0, 1, 2].map(i => bit(14 + i));
  P.gate = bit(17); P.shell = bit(18); P.post = bit(19); P.kick = bit(20); P.whale = bit(21); P.u2 = bit(22); P.resc = bit(23);
  const hi = Math.floor(f / 2 ** 40); P.mult = Math.max(1, hi % 8); P.lg = Math.floor(hi / 8) % 2;
  const tn = Math.floor(hi / 16) % 4; if (tn < P.tun) P.jack = now + PB_JACK_MS;   // 隧道次數歸零＝剛開出深海寶藏：觀戰者也放全場光效
  P.tun = tn;
}
function pbSnap(P, force) {   // 自己的局：快照給觀戰者與大螢幕（約 10 次／秒）
  const now = performance.now();
  if (!force && now - P.snapAt < PB_SNAP_MS) return;
  P.snapAt = now;
  S.net?.tbl?.({ a: 'pbs', x: Math.round(P.ball.x * 10) / 10, y: Math.round(P.ball.y * 10) / 10, sc: Math.min(99999999, Math.round(P.score)), b: Math.max(0, Math.min(9, P.balls)), st: P.st, l: P.keys.l ? 1 : 0, r: P.keys.r ? 1 : 0, f: pbBits(P, now) });
}
function pbApplySnap(P, m) {   // 觀戰者／大螢幕：套用快照（球的位置平滑追過去）
  P.snap = m; P.score = m.sc; P.balls = m.b; P.st = m.st; P.keys.l = m.l; P.keys.r = m.r;
  pbUnbits(P, m.f, performance.now());
  if (!P.snapSeen) { P.ball.x = m.x; P.ball.y = m.y; P.snapSeen = true; }
}
function pbAdvance(P, dt) {   // 每一幀：自己的局跑物理＋送快照；旁觀的局讓球和擋板追上最新快照
  if (P.role === 'seat') {
    const t = pbNow(P);
    if (t >= 0 && !P.over) { P.acc += dt * PB_SLOW; let n = 0; while (P.acc >= PB_DT && n++ < 20) { pbStep(P, PB_DT); P.acc -= PB_DT; } if (n >= 20) P.acc = 0; pbSnap(P, false); }
    else P.acc = 0;
  } else {
    if (P.snap) { const a = 1 - Math.exp(-dt * 16); P.ball.x += (P.snap.x - P.ball.x) * a; P.ball.y += (P.snap.y - P.ball.y) * a; }
    for (const left of [true, false]) {
      const f = left ? P.fl : P.fr, want = (left ? P.keys.l : P.keys.r) ? PB_FLIP.UP : PB_FLIP.REST;
      f.a += Math.max(-PB_FLIP.SPD * dt, Math.min(PB_FLIP.SPD * dt, want - f.a));
    }
    const now = performance.now(); P.sp.forEach((s, i) => { s.a += (P.flash[11 + i % 2] > now ? 14 : 0) * dt; });   // 旋轉門：閃光位元亮著就轉
  }
}
function pbFrame() {
  const P = S.pb, v = S.tableView;
  if (!P || !S.tableOpen || !v || v.game !== 'pinball') { S.pbRaf = 0; return; }
  S.pbRaf = requestAnimationFrame(pbFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - P.last) / 1000)); P.last = now;
  if (P.hole) { P.hole.h += dt; if (P.hole.h >= 1.05) P.hole = null; }   // 洞的動畫跟遊戲時間走（跟球在洞裡的倒數同一個 dt，卡頓時兩邊一起慢）
  pbAdvance(P, dt);
  pbDraw(P, $('pbCanvas'), pbNow(P));
}
function pbRR(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function pbDraw(P, cv, t) {   // 畫整台（牌桌、螢幕共用）：cv 是 PB_W×PB_H 的 canvas
  if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now(), TAU = Math.PI * 2, zk = cv.width / PB_W;
  g.setTransform(zk, 0, 0, zk, 0, 0);   // canvas 比 PB_W×PB_H 大（牌桌放大顯示）就整個放大畫，座標照舊
  // 燈亮不亮：平常照各自的狀態；深海寶藏期間全場的燈輪流閃——先一排一排由下往上跑、再棋盤格交錯、最後全部一起閃
  const jk = P.jack > now, jms = jk ? PB_JACK_MS - (P.jack - now) : 0;
  const L = (on, x, y) => {
    if (!jk) return !!on;
    if (jms < PB_JACK_MS * .45) return (y / 45 + jms / 110) % 4 < 1.4;
    if (jms < PB_JACK_MS * .75) return (Math.floor(x / 28) + Math.floor(y / 28) + Math.floor(jms / 130)) % 2 === 0;
    return Math.floor(jms / 110) % 2 === 0;
  };
  const circ = (x, y, r, fill, stroke, lw = 2) => { g.beginPath(); g.arc(x, y, r, 0, TAU); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
  g.fillStyle = '#0d1030'; g.fillRect(0, 0, PB_W, PB_H);
  const gr = g.createLinearGradient(0, 0, 0, PB_H); gr.addColorStop(0, '#1b2f5e'); gr.addColorStop(1, '#122040');
  g.fillStyle = gr; g.beginPath(); PB_ARCH.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill();
  g.strokeStyle = '#9db4f4'; g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of PB_SEGS) { g.beginPath(); g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); g.stroke(); }
  // 發球道出口的擋板（關上才實心）
  g.strokeStyle = P.lg ? '#5ad0aa' : 'rgba(90,208,170,.25)'; g.lineWidth = 3; g.beginPath(); g.moveTo(PB_LGATE[0], PB_LGATE[1]); g.lineTo(PB_LGATE[2], PB_LGATE[3]); g.stroke();
  // 海底隧道：左牆的洞口＋進度燈＋指向洞口的箭頭（閃爍）
  {
    const T = PB_TUN, hit = L(P.flash[15] > now, 11, T.y), bl = Math.floor(now / 350) % 2;
    g.beginPath(); g.ellipse(11, T.y, 24, 20, 0, -Math.PI / 2, Math.PI / 2); g.closePath(); g.fillStyle = hit ? '#fff6c0' : '#05060f'; g.fill(); g.strokeStyle = '#ffd060'; g.lineWidth = 2.5; g.stroke();
    for (let i = 0; i < T.n; i++) { const a = (i - (T.n - 1) / 2) * .85; circ(11 + 31 * Math.cos(a), T.y + 28 * Math.sin(a), 3.2, L(i < P.tun, 40, T.y + 28 * Math.sin(a)) ? '#ffd060' : 'rgba(255,208,96,.18)', '#c08a10', 1); }
    g.strokeStyle = bl ? '#ffd060' : 'rgba(255,208,96,.35)'; g.lineWidth = 2;
    for (const ax of [48, 55]) { g.beginPath(); g.moveTo(ax + 5, T.y - 5); g.lineTo(ax, T.y); g.lineTo(ax + 5, T.y + 5); g.stroke(); }
    g.font = 'bold 9px "Microsoft JhengHei"'; g.fillStyle = hit ? '#05060f' : '#ffd060'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('隧道', 13, T.y);
  }
  // 鯨魚軌道（虛線；雙倍計分時變金色）
  g.setLineDash([6, 5]); g.strokeStyle = P.whale ? '#ffd060' : 'rgba(170,185,230,.55)'; g.lineWidth = 2; g.beginPath();
  for (let k = 0; k <= 24; k++) { const p = pbBez(PB_RAMP, k / 24); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
  g.stroke(); g.setLineDash([]);
  { const e = PB_RAMP[3], d = [-.76, .65], n = [-d[1], d[0]]; g.fillStyle = P.whale ? '#ffd060' : 'rgba(170,185,230,.75)'; g.beginPath(); g.moveTo(e[0] + d[0] * 9, e[1] + d[1] * 9); g.lineTo(e[0] - d[0] * 2 + n[0] * 5, e[1] - d[1] * 2 + n[1] * 5); g.lineTo(e[0] - d[0] * 2 - n[0] * 5, e[1] - d[1] * 2 - n[1] * 5); g.closePath(); g.fill(); }   // 箭頭朝出口的方向（左下）
  // 入口燈（4 顆綠色膠囊）
  PB_ENT.forEach(([x, y, a], i) => { g.save(); g.translate(x, y); g.rotate(a + Math.PI / 2); pbRR(g, -13, -5, 26, 10, 5); g.fillStyle = L(P.ent[i], x, y) ? '#8bf050' : '#dff0c8'; g.fill(); g.strokeStyle = '#4a8a20'; g.lineWidth = 1.5; g.stroke(); g.restore(); });
  // 水母（大）／海膽（小）彈跳器
  PB_BUMPERS.forEach(([bx, by, br], i) => {
    const lit = L(P.flash[i] > now, bx, by);
    if (i < 3) { circ(bx, by, br, lit ? '#ffffff' : '#d4f1e8', '#2e9c82', 2.5); circ(bx, by, br * .42, lit ? '#ffd8c8' : '#f6c6b6', '#b4583c', 1.5); }
    else { circ(bx, by, br, lit ? '#ffffff' : (P.u2 ? '#ffe6a0' : '#dcd8ff'), P.u2 ? '#c08a10' : '#6a5acd', 2); }
  });
  // 旋轉門
  PB_SPIN.forEach(([x, y, hw, ang], i) => { const s = P.sp[i], th = 1.5 + 4.5 * Math.abs(Math.cos(s.a)); g.save(); g.translate(x, y); g.rotate(ang); pbRR(g, -hw, -th / 2, hw * 2, th, Math.min(th / 2, 3)); g.fillStyle = '#cfe6ff'; g.fill(); g.strokeStyle = '#2a6ab8'; g.lineWidth = 1.5; g.stroke(); g.restore(); });
  // 魚群標靶（左，橘）／丑魚標靶（右，粉紅）：倒下的變淡
  PB_FISH.forEach(([x, y], i) => { g.globalAlpha = P.fish[i] && !jk ? .22 : 1; pbRR(g, x - 6.5, y - 7, 13, 14, 3); g.fillStyle = L(0, x, y) ? '#ffffff' : '#f8e0bc'; g.fill(); g.strokeStyle = '#c07a30'; g.lineWidth = 1.5; g.stroke(); g.globalAlpha = 1; });
  PB_UGLY.forEach(([x, y], i) => { g.globalAlpha = P.ugly[i] && !jk ? .22 : 1; pbRR(g, x - 6.5, y - 7, 13, 14, 3); g.fillStyle = L(0, x, y) ? '#ffffff' : '#f8d4cc'; g.fill(); g.strokeStyle = '#c0583c'; g.lineWidth = 1.5; g.stroke(); g.globalAlpha = 1; });
  // 貝殼洞
  PB_SHELLS.forEach((sh, i) => { circ(sh.x, sh.y, 12.5, L(P.flash[8 + i] > now, sh.x, sh.y) ? '#fff6c0' : '#ece8dc', P.shell ? '#f0b020' : '#777', P.shell ? 3 : 2); circ(sh.x, sh.y, 6, '#05060f'); });
  // 珊瑚柱、珍珠、寶箱
  for (const [px, py, pr] of PB_POSTS) circ(px, py, pr, '#f4cfc8', '#c0583c', 1.5);
  PB_PEARLS.forEach(([x, y], i) => circ(x, y, 6, L(P.pearl[i] && !(P.pearlT && P.pearlT[i] < 1 && Math.floor(now / 110) % 2), x, y) ? '#ff7fb8' : '#f6c8dc', '#b04070', 1.5));
  { const c = PB_CHEST; pbRR(g, Math.min(c[0], c[2]) - 4.5, Math.min(c[1], c[3]) - 1, Math.abs(c[2] - c[0]) + 9, Math.abs(c[3] - c[1]) + 2, 3); g.fillStyle = L(P.flash[10] > now, c[0], (c[1] + c[3]) / 2) ? '#ffffff' : '#f7d9b0'; g.fill(); g.strokeStyle = '#b8701c'; g.lineWidth = 1.5; g.stroke(); }
  // 線道燈
  PB_LANEL.forEach(([x, y], i) => circ(x, y, 5, L(P.lane[i], x, y) ? '#8bf050' : '#dff0c8', '#4a8a20', 1.5));
  // 左反彈器（綠，有電才亮）／右閘門（青，關上才實心）
  g.globalAlpha = P.kick ? 1 : .35; pbRR(g, 12, 517, 15, 15, 3); g.fillStyle = '#e4f4d8'; g.fill(); g.strokeStyle = '#4a8a20'; g.lineWidth = 1.5; g.stroke(); g.globalAlpha = 1;
  pbRR(g, 244, 517, 15, 15, 3); g.fillStyle = P.gate ? '#5ad0aa' : 'rgba(216,242,234,.35)'; g.fill(); g.strokeStyle = '#2a8a6a'; g.lineWidth = 1.5; g.stroke();
  // 珊瑚彈弓
  for (let i = 0; i < PB_TRIS.length; i++) { const tr = PB_TRIS[i]; g.beginPath(); g.moveTo(tr[0][0], tr[0][1]); g.lineTo(tr[1][0], tr[1][1]); g.lineTo(tr[2][0], tr[2][1]); g.closePath(); g.fillStyle = L(P.flash[13 + i] > now, tr[0][0], 470) ? 'rgba(255,200,170,.6)' : 'rgba(240,130,100,.22)'; g.fill(); g.strokeStyle = '#e8805e'; g.lineWidth = 2.5; g.stroke(); }
  // 救球燈、救援柱
  const resc = P.role === 'seat' ? (P.st === 1 && P.ballT < PB_RESCUE_S && !P.rescued) : !!P.resc;
  circ(135.5, 507, 5, L(resc, 135.5, 507) ? '#ffc060' : 'rgba(255,192,96,.2)', '#c08a30', 1.5);
  if (P.post) circ(PB_RESCUE[0], PB_RESCUE[1], PB_RESCUE[2], '#bfeee0', '#2a8a6a', 2); else circ(PB_RESCUE[0], PB_RESCUE[1], PB_RESCUE[2], null, 'rgba(90,200,170,.35)', 1.5);
  // 擋板
  for (const left of [true, false]) {
    const [x1, y1, x2, y2] = pbFlipperSeg(P, left);
    g.strokeStyle = '#2c5cb0'; g.lineWidth = PB_FLIP.TH * 2; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.fillStyle = '#9ec0f4'; g.beginPath(); g.arc(x1, y1, 3, 0, TAU); g.fill();
  }
  // 拉桿（蓄力時往下縮）
  if (P.st === 0 || P.power > 0) {
    const pull = P.power * 20;
    g.fillStyle = '#9a9aa8'; g.fillRect(PB_LANE_X - 3, PB_LANE_Y + PB_R + pull, 6, 22); g.fillStyle = '#d84a4a'; g.fillRect(PB_LANE_X - 6, PB_LANE_Y + PB_R + 20 + pull, 12, 4);
  }
  // 隧道出口的艙門（2026-11-21 使用者要求更像機械，不要虛空冒出一個洞）：平常就是機台上一個關著的金屬艙口（外框＋兩片門板中間一道縫，沒有鉚釘：2026-11-21 使用者說鉚釘醜）；
  // 球要出來前 0.4 秒兩片門板往左右滑開、露出下面黑黑的洞（洞口透出暖光）、球掉出來、約 0.3 秒後門板滑回關上（0～0.4 s 開、0.4～0.7 s 全開、0.7～1.0 s 關）。觀戰者／大螢幕只看得到關著的艙口
  {
    const [hx, hy] = PB_TUN.out, hw = 15, hh = 8, h = P.hole ? P.hole.h : -1;
    const k = h < 0 ? 0 : h < .4 ? h / .4 : h < .7 ? 1 : h < 1 ? 1 - (h - .7) / .3 : 0;   // 開口程度：0＝關、1＝全開
    g.save();
    pbRR(g, hx - hw - 2.5, hy - hh - 2.5, hw * 2 + 5, hh * 2 + 5, 4); g.fillStyle = '#2a3a70'; g.fill(); g.strokeStyle = '#9db4f4'; g.lineWidth = 1.5; g.stroke();   // 外框（凹槽）
    g.beginPath(); g.rect(hx - hw, hy - hh, hw * 2, hh * 2); g.clip();
    g.fillStyle = '#05060f'; g.fillRect(hx - hw, hy - hh, hw * 2, hh * 2);   // 洞
    if (k > 0) { const gl = g.createRadialGradient(hx, hy, 1, hx, hy, hw); gl.addColorStop(0, `rgba(255,208,96,${.55 * k})`); gl.addColorStop(1, 'rgba(255,208,96,0)'); g.fillStyle = gl; g.fillRect(hx - hw, hy - hh, hw * 2, hh * 2); }
    for (const dir of [-1, 1]) {   // 左右兩片門板：各蓋一半，往外滑 k×半寬
      const x0 = dir < 0 ? hx - hw - k * hw : hx + k * hw;
      g.fillStyle = '#6f82b8'; g.fillRect(x0, hy - hh, hw, hh * 2);
      g.fillStyle = '#9fb2e0'; g.fillRect(x0, hy - hh, hw, 2);                        // 上緣反光
      g.fillStyle = '#4a5a90'; g.fillRect(x0, hy + hh - 2, hw, 2);                    // 下緣陰影
      g.fillStyle = '#c8d4f4'; g.fillRect(x0 + (dir < 0 ? hw - 2 : 0), hy - hh, 2, hh * 2);   // 合縫那一側的邊
    }
    g.restore();
  }
  // 球
  if (P.st !== 3 && t >= -1 && !P.cap) {
    const b = P.ball, bg = g.createRadialGradient(b.x - 2, b.y - 2, 1, b.x, b.y, PB_R);
    bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#a8aec0'); g.fillStyle = bg; g.beginPath(); g.arc(b.x, b.y, PB_R, 0, TAU); g.fill();
  }
  // HUD
  g.textBaseline = 'middle'; g.font = 'bold 14px "Microsoft JhengHei"'; g.fillStyle = '#ffe08a'; g.textAlign = 'left'; g.fillText(String(Math.round(P.score)), 12, 14);
  g.font = 'bold 12px "Microsoft JhengHei"'; g.fillStyle = '#9fb0d8'; g.textAlign = 'left'; g.fillText(P.mult > 1 ? `×${P.mult}` : '', 12, 29);   // 倍率放在分數正下方（2026-11-17 使用者要求，原本在右上角球數下面）
  const nb = Math.max(PB_BALLS, P.balls);   // 剩餘球數靠右排：掉一顆就從最左邊那顆開始變暗（使用者要求）
  for (let i = 0; i < nb; i++) { g.fillStyle = i >= nb - P.balls ? '#e8ecf8' : 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(285 - (nb - 1 - i) * 11, 14, 3.8, 0, TAU); g.fill(); }
  g.textAlign = 'center';
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t));
  else if (P.st === 3) msg = '遊戲結束';
  else if (P.st === 0 && P.role === 'seat') msg = P.power > 0 ? '放開發射！' : '按住空白蓄力、放開發射';
  else if (P.note && P.note.until > now) msg = P.note.t;
  if (msg) { g.font = 'bold 15px "Microsoft JhengHei"'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.85)'; g.fillStyle = '#ffe08a'; g.strokeText(msg, 140, 404); g.fillText(msg, 140, 404); }   // 寶箱與彈弓之間的空位（原本 y＝340，珍珠移上來後會蓋到）
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.setTransform(1, 0, 0, 1, 0, 0);
}
function buildPinball(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.pb;
  if (playing && z && (!S.pb || S.pb.key !== z.seed + ':' + z.t0)) pbStart(v);
  if (!playing) pbStop();
  const P = S.pb;
  let status;
  if (playing && P) status = P.role === 'seat' ? '彈珠台：← ／ A ／ Z 左擋板，→ ／ D ／ M 右擋板，空白（按住蓄力、放開發射）' : '觀戰中';
  else status = v.seats.length < v.min ? '等待玩家入座（單人）' : '按「準備」就開始（3 顆球，分數進排行榜）';
  box.appendChild(mk('div', 'table-status' + (playing && P?.role === 'seat' ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing && !r.aborted) box.appendChild(mk('div', 'table-result', r.text));
  else if (r?.aborted && !playing) box.appendChild(mk('div', 'table-result', r.text));
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分`);
  if (!playing) {
    const row = mk('div', 'table-seats');
    v.seats.forEach(s => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(seat);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  } else {
    const wrap = mk('div', 'pb-wrap'), cv = document.createElement('canvas');
    cv.id = 'pbCanvas'; cv.width = PB_W * PB_ZOOM * 2; cv.height = PB_H * PB_ZOOM * 2; cv.className = 'pb-canvas';   // 顯示 420×840（CSS），內部解析度再 ×2 讓放大後不糊
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
}
function onNetTpb(m) { const P = S.pb; if (P && P.role === 'spec') pbApplySnap(P, m); }   // 觀戰者：玩家那台的快照
// ---- 小瑪莉（第九十九桌 t99，2026-11-16，使用者要求：北牆最左邊的經典水果盤賭博機台，籌碼經濟的第一個客人；2026-11-18 撞號改編 t99——t21／t22／t23 連續被遠端的新機台用掉，使用者定低號留給遠端；並照台灣經典機台範例圖重排：大獎在頂排中間、左右兩側中間各一格 ONCE MORE〔開到＝送燈：押注維持、機台自動免費多開 1～5 次〕）----
// 押注與開獎都是伺服器權威（mspin 先原子扣總注、加權 RNG 開獎、比倍抽牌都在伺服器，動作鏈見兩份伺服器的 ma_*）；客戶端只做押注 UI 與跑馬燈減速動畫。
// 外圈 28 格、押注列（8 種圖案）與賠率以伺服器 v.ma.ring／cols／pay 為單一真相（機率與視覺分布脫鉤，權重表 MARY_WEIGHT 在兩份伺服器）。
// 2026-11-16 使用者定：圖案＝島上現有的怪物（越稀有賠率越高，最大獎是島主黃金肥龍），中間藍色區畫島主；
// 押注是「一種圖案一注」（8 注），外圈只是跑馬燈。機台在和平島，畫面上的怪物純裝飾、不會生成任何敵人。
// 離座（含斷線）獎池由伺服器自動領回（登入者入帳 Registry、訪客在這裡用「機台餘額＋獎池」同步回本機）。
// 2026-11-16 使用者再定：中間藍色區改成入座開局時隨機跳一位島主（伺服器 v.ma.owner 帶 id，名字用 MARY_OWNERS_NM）；
// 跑完一輪再按「開始」＝照上一次的押注直接再開（S.maryBets 不清，籌碼不夠時伺服器會擋、這裡也先檢查）；
// 獎池可以「兌換」成角色經驗值（1 經驗值＝100 籌碼，真兌換：XP 不回饋籌碼）——登入者由伺服器記帳，
// 訪客的 XP 在本機（S.profile.xp），這裡直接加＋演出；離座時的虧損由伺服器換成入座抽到的島主的經驗值。
const MARY_W = 320, MARY_H = 480;   // 機台畫面（CSS px；畫布內部再 ×2，放大不糊）
const MARY_SHOW_MS = 5400;   // 勇者挑戰＋拉霸演出的總時長（0～1.2s 揮砍、1.2～2.2s 打倒、2.2～4.2s 拉霸轉動〔3.4s 起逐格停〕、4.2s 起亮結果）
const MARY_DBL_S = 2;        // 猜大小的轉燈：左右兩個 ONCE MORE 輪流閃 2 秒才開牌（2026-11-22 使用者定：燈效停止後才扣錢／發籌碼）
const MARY_DBL_TAIL = 1.2;   // 開牌後亮邊再脈動 1.2 秒（之後定格亮著，直到下一次開獎／領出）
const MARY_AMTS = [10, 50, 100, 500, 1000, 5000];   // 每注金額鈕
const MARY_OWNERS_NM = { gold_dragon: '黃金肥龍', snake_queen: '笨蛋蛇女', ultima_weapon: '蓋老師', alexander: '壓力山大' };   // 中間藍色區的島主（開局時伺服器隨機抽一位，v.ma.owner 帶 id；與兩份伺服器的 MARY_OWNERS 同一套）
const MARY_CW = 28, MARY_RCOLS = 9, MARY_RROWS = 7;   // 外圈跑馬燈：9×7 的邊框＝28 格（2026-11-22 使用者定：左右各多一格、ONCE MORE 下面 3 格、大獎移到正中央）
const MARY_RING_X = 34, MARY_RING_Y = 84;             // 外圈左上角（CSS px）
const MARY_BET_X = 40, MARY_BET_Y = 290, MARY_COL_W = 30;   // 押注列（8 欄，每欄一種圖案）
const MARY_SEG = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' };   // 復古七段顯示器
const maryCellPos = k => (k < 9 ? [k, 0] : k < 14 ? [8, k - 8] : k < 23 ? [22 - k, 6] : [0, 28 - k]);   // 第 k 格（0～27）的 [欄, 列]：頂排 9、右欄 5、底排 9、左欄 5
const maryCellAt = (px, py) => {   // 畫布座標 → 外圈格子編號；沒有回 -1
  const c = Math.floor((px - MARY_RING_X) / MARY_CW), r = Math.floor((py - MARY_RING_Y) / MARY_CW);
  if (c < 0 || c >= MARY_RCOLS || r < 0 || r >= MARY_RROWS) return -1;
  for (let k = 0; k < 28; k++) { const p = maryCellPos(k); if (p[0] === c && p[1] === r) return k; }
  return -1;
};
const maryColAt = px => { const i = Math.floor((px - MARY_BET_X) / MARY_COL_W); return i >= 0 && i < 8 ? i : -1; };   // 押注列第幾欄
const MARY_AMT_BTNS = MARY_AMTS.map((a, i) => ({ a, x: 21 + i * 40, y: 358, w: 38, h: 22 })).concat([{ a: -1, x: 21 + 6 * 40, y: 358, w: 38, h: 22 }]);   // a＝-1 是「清空」
const MARY_ACT_BTNS = ['spin', 'collect', 'big', 'small'].map((id, i) => ({ id, x: 24 + i * 71, y: 390, w: 66, h: 34 }));   // 機台 4 顆：開始／領出／猜大／猜小（兌換經驗值是面板上離開鍵下面的 DOM 按鈕，2026-11-16 使用者定）
function maryDig(g, x, y, w, h, ch, col) {   // 一個七段數字
  const segs = MARY_SEG[ch] ?? '', t = Math.max(1.3, h * .11), on = s => segs.includes(s);
  g.fillStyle = col;
  if (on('a')) g.fillRect(x + t, y, w - 2 * t, t);
  if (on('g')) g.fillRect(x + t, y + h / 2 - t / 2, w - 2 * t, t);
  if (on('d')) g.fillRect(x + t, y + h - t, w - 2 * t, t);
  if (on('f')) g.fillRect(x, y + t, t, h / 2 - t * 1.5);
  if (on('b')) g.fillRect(x + w - t, y + t, t, h / 2 - t * 1.5);
  if (on('e')) g.fillRect(x, y + h / 2 + t / 2, t, h / 2 - t * 1.5);
  if (on('c')) g.fillRect(x + w - t, y + h / 2 + t / 2, t, h / 2 - t * 1.5);
}
function marySeg(g, x, y, h, text, col, align = 'left') {   // 一串七段數字（align＝left／center／right，x 是對齊點）
  const w = h * .62, sp = h * .2, tw = String(text).length * (w + sp) - sp;
  let px = align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x;
  for (const ch of String(text)) { maryDig(g, px, y, w, h, ch, col); px += w + sp; }
  return tw;
}
function maryMob(g, id, cx, cy, size, frame = 0) {   // 用現成的怪物素材畫一隻（外圈／押注列；中間的島主用同一招）
  const an = S.mobAnims?.[id], im = S.mobImgs?.[id];
  let img = null, sx = 0, sy = 0, sw = 0, sh = 0;
  if (an) {   // 多幀動畫：用「面向下」那一列（沒有就用第一列），靜態圖案取第 0 幀
    const rd = an.rowDir || [], row = Math.max(0, rd.indexOf('down'));
    img = an.img; sw = an.fw; sh = an.fh; sx = (frame % an.frames) * an.fw; sy = (an.row0 + row) * an.fh;
  } else if (im) { img = im; sw = im.width; sh = im.height; }
  if (!img) { g.fillStyle = '#8a90a8'; g.fillRect(cx - size / 2, cy - size / 2, size, size); return; }
  const sc = size / Math.max(sw, sh), w = sw * sc, h = sh * sc;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, sx, sy, sw, sh, cx - w / 2, cy - h / 2, w, h);
}
function maryPaint(cvIn) {   // 畫整台小瑪莉（靜態重建與開獎動畫的每一格都用這個；cvIn＝指定畫到別張畫布，大螢幕轉播用）
  const cv = cvIn || document.getElementById('maryCanvas'); if (!cv) return;
  const v = S.tableView, ma = v?.ma; if (!ma) return;
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.setTransform(2, 0, 0, 2, 0, 0);   // 之後都用 CSS px 座標（MARY_W×MARY_H）
  g.textBaseline = 'alphabetic';
  const M = S.mary, spin = !!M?.spin, cur = M ? Math.floor(M.pos) % 28 : -1;
  const seat = v.role === 'seat', cols = ma.cols || [], nm = ma.nm || {};
  const seat0 = v.role === 'seat', who = v.seats[0]?.name || '';   // 觀戰者看玩家的押注（ma.bets）與名字；只有玩家自己用本機的 S.maryBets（觀戰者自己以前押過的不能混進來）
  const bets = seat0 ? (S.maryBets || ma.bets || []) : (ma.bets || []);
  const owner = ma.owner || 'gold_dragon', ownerNm = MARY_OWNERS_NM[owner] || '島主';   // 開局時伺服器隨機抽的莊家
  // 猜大小的轉燈（2026-11-22 使用者定）：左右兩個 ONCE MORE 輪流閃紅燈 2 秒（紅＝跳到的位置），開大左邊紅、開小右邊紅；燈效結束前不扣錢也不發籌碼
  const dbl = M?.dbl, dblT = dbl ? (performance.now() - dbl.t0) / 1000 : 0;
  const dblHold = !!dbl && dblT < MARY_DBL_S;   // 轉燈中：WIN／JP／獎池全部凍結在比倍前
  const dblSide = dbl && dblT >= MARY_DBL_S ? (dbl.card >= 8 ? 'L' : dbl.card <= 6 ? 'R' : '') : '';   // 左＝大、右＝小；7 兩邊都不亮（莊家贏）
  // 機身
  g.fillStyle = '#5a1420'; g.fillRect(0, 0, MARY_W, MARY_H);
  g.fillStyle = '#7a2030'; g.fillRect(0, 0, MARY_W, 7);
  // 最上面：累積獎池（JP）華麗橫幅（2026-11-19 使用者定：移到最上面、華麗顯眼；金框與星星慢閃）
  const jpBlink = Math.floor(S.t * 3) % 2 === 0;
  const jpGrad = g.createLinearGradient(8, 0, 312, 0);
  jpGrad.addColorStop(0, '#3a2008'); jpGrad.addColorStop(.5, '#6a4210'); jpGrad.addColorStop(1, '#3a2008');
  g.fillStyle = jpGrad; g.fillRect(8, 8, 304, 28);
  g.strokeStyle = jpBlink ? '#ffd24a' : '#b8862a'; g.lineWidth = 2; g.strokeRect(9.5, 9.5, 301, 25);
  g.fillStyle = jpBlink ? '#ffe9a0' : '#ffd24a';
  for (const [sx, sy] of [[22, 22], [302, 22]]) { g.beginPath(); g.arc(sx, sy, 3.5, 0, 7); g.fill(); }   // 兩側閃爍的獎池燈
  g.fillStyle = '#ffd24a'; g.font = 'bold 15px "Microsoft JhengHei"'; g.textAlign = 'left';
  g.fillText('JP', 34, 29);
  g.fillStyle = '#e8c060'; g.font = 'bold 8px "Microsoft JhengHei"';
  g.fillText('累積獎池', 62, 19);
  const jpVal = Math.floor(dblHold ? (M.jpShown ?? ma.jp ?? 0) : (ma.jp || 0));   // 轉燈中先不亮新的 JP（不然一閃就知道輸了）
  marySeg(g, 291, 13, 18, String(Math.min(jpVal, 99999999)), '#ffe14a', 'right');   // 右緣留給右邊的獎池燈（2026-11-23：數字會跟燈重疊）
  // 上方橘色顯示板：WIN（獎池）／CREDIT（籌碼）
  g.fillStyle = '#e8781e'; g.fillRect(10, 37, 300, 38);
  g.fillStyle = '#f89840'; g.fillRect(10, 37, 300, 4);
  g.strokeStyle = '#a04c10'; g.lineWidth = 2; g.strokeRect(11, 38, 298, 36);
  const chainRun = !!(S.mary?.chainHold && (S.mary?.spin || ma.lights > 0));   // 送燈鏈進行中（含最後一格的動畫）：WIN 凍結在送燈前的值，跑完燈再亮總獎
  const showHold = !!(S.mary?.showPlay || S.mary?.showPending);   // 拉霸有演出排隊或播放中：WIN 凍結（跑馬燈轉動的 4.8 秒也涵蓋——不然獎金會先亮出來、演出開始又消失，2026-11-19 使用者回饋）
  const spinHold = !!spin;   // 一般開獎：跑馬燈停格才亮 WIN（經典機台行為）
  const win = Math.floor(dblHold ? (M.potShown || 0) : chainRun ? (S.mary.chainPot || 0) : showHold || spinHold ? (S.mary.potShown || 0) : (ma.pot || 0)), cred = Math.floor(seat ? (ma.chips || 0) : (S.chips || 0));
  for (const [bx, label, val] of [[30, 'WIN', win], [172, seat ? 'CREDIT' : 'PLAYER', cred]]) {
    g.fillStyle = '#140a08'; g.fillRect(bx, 42, 118, 30);
    g.strokeStyle = '#3a2018'; g.lineWidth = 1; g.strokeRect(bx + .5, 42.5, 117, 29);
    g.fillStyle = '#f0a060'; g.font = 'bold 9px "Microsoft JhengHei"'; g.textAlign = 'left';
    g.fillText(label, bx + 7, 53);
    if (label === 'PLAYER') {   // 觀戰：玩家的籌碼餘額只有本人看得到（伺服器不送），這格改顯示玩家名字
      g.fillStyle = '#ffd8a0'; g.font = 'bold 13px "Microsoft JhengHei"'; g.textAlign = 'right';
      g.fillText((who || '（無人）').slice(0, 9), bx + 112, 66);
    } else marySeg(g, bx + 112, 50, 16, String(Math.min(val, 99999999)), '#ff3020', 'right');
  }
  // 外圈跑馬燈底盤
  g.fillStyle = '#e8dcc0'; g.fillRect(28, 78, 264, 208);
  g.strokeStyle = '#8a6a30'; g.lineWidth = 2; g.strokeRect(29, 79, 262, 206);
  // 中間藍色遊戲區：上方三格拉霸（勇者打倒島主時啟動）、島主、左下累積獎池（JP）
  const ix = 62, iy = 112, iw = 196, ih = 140;
  const sky = g.createLinearGradient(0, iy, 0, iy + ih);
  sky.addColorStop(0, '#5aa0f0'); sky.addColorStop(.58, '#2f6ad0'); sky.addColorStop(.58, '#2f8a3a'); sky.addColorStop(1, '#1d5f26');
  g.fillStyle = sky; g.fillRect(ix, iy, iw, ih);
  const sp2 = S.mary?.showPlay, st2 = sp2 ? (performance.now() - sp2.t0) / 1000 : 0;
  g.save(); g.beginPath(); g.rect(ix + 2, iy + 2, iw - 4, ih - 4); g.clip();       // 島主與勇者只畫在藍色區裡
  maryMob(g, owner, ix + iw / 2, iy + 46 + (ih - 46) * .58, 70, Math.floor(S.t * 6) % 6);   // 島主（幀會動；入座開局時隨機跳一位）——上方讓位給拉霸
  if (sp2 && st2 < 2.2) {   // 勇者挑戰島主：從左邊滑進來揮砍（打倒時島主金光閃爍）
    const hx = ix + 22 + Math.min(1, st2 / .5) * 16, hy = iy + 92;
    const heroImg = S.charImgs?.['char_body_light.png'];
    if (heroImg) g.drawImage(heroImg, 0, 0, 64, 64, hx - 14, hy - 22, 28, 44);
    else { g.fillStyle = '#e8c8a8'; g.fillRect(hx - 8, hy - 16, 16, 32); }
    g.fillStyle = '#ffffff'; g.font = 'bold 9px "Microsoft JhengHei"'; g.textAlign = 'center';
    g.fillText('勇者', hx, hy + 12);
    if (st2 > .5 && st2 < 1.0) {   // 揮砍特效
      g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.globalAlpha = 1 - (st2 - .5) / .5;
      g.beginPath(); g.moveTo(hx + 26, hy - 30); g.lineTo(hx + 50, hy + 4); g.stroke();
      g.globalAlpha = 1;
    }
    if (sp2.heroWin && st2 >= 1.2 && Math.floor(S.t * 8) % 2 === 0) { g.fillStyle = 'rgba(255,240,160,.4)'; g.fillRect(ix + 2, iy + 40, iw - 4, ih - 42); }
  }
  g.restore();
  g.strokeStyle = '#123a6a'; g.lineWidth = 2; g.strokeRect(ix + 1, iy + 1, iw - 2, ih - 2);
  // 三格拉霸（島主上方）：平常暗暗顯示上一次的結果；演出時轉動、一格一格停
  const rw = 44, rh = 32, rgap = 6, rx0 = ix + (iw - (rw * 3 + rgap * 2)) / 2, ry = iy + 6;
  for (let i = 0; i < 3; i++) {
    const rx = rx0 + i * (rw + rgap);
    g.fillStyle = '#140a08'; g.fillRect(rx, ry, rw, rh);
    g.strokeStyle = '#3a2018'; g.lineWidth = 1; g.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
    let sym;
    if (sp2 && sp2.heroWin) sym = st2 >= 3.4 + i * .4 ? sp2.reels[i] : cols[(Math.floor(S.t * 15) + i * 3) % 8];   // 打倒島主才轉拉霸：轉動中快速跳格，依序停格（cols＝伺服器送來的 8 種圖案）
    else sym = (sp2 ? sp2.reels : ma.show?.reels)?.[i] || ['chicken', 'bunny', 'frog'][i];   // 戰敗／平常：暗暗顯示上一次的結果（戰敗的 reels 是 null）
    if (!sp2) g.globalAlpha = .5;
    maryMob(g, sym, rx + rw / 2, ry + rh / 2, rh - 6);
    g.globalAlpha = 1;
  }
  if (sp2 && sp2.triple && st2 >= 4.2 && Math.floor(S.t * 6) % 2 === 0) {   // 三同：拉霸窗外框金光閃爍
    g.strokeStyle = '#ffd24a'; g.lineWidth = 2; g.strokeRect(rx0 - 3.5, ry - 3.5, rw * 3 + rgap * 2 + 7, rh + 7);
  }
  g.font = 'bold 9px "Microsoft JhengHei"'; g.fillStyle = '#e8f0ff'; g.textAlign = 'right';
  g.fillText(ownerNm, ix + iw - 6, iy + ih - 8);   // 中間這隻的名字
  // 中間下方的提示／上一注結果（押注會保留，開過獎不能用 S.maryBets 判斷：以 S.mary.res 記「這格是這一輪的結果」）
  const fresh = S.mary?.res === ma.seq;
  let note = '', noteCol = '#ffe08a';
  if (dblHold) { note = '比倍轉燈中…'; noteCol = '#ffd24a'; }   // 燈效沒跑完不開牌、不亮輸贏
  else if (ma.dcard >= 0) { note = `${ma.pot > 0 ? '猜對！' : '猜錯！'}開 ${ma.dcard}${ma.dcard >= 8 ? '（大）' : ma.dcard <= 6 ? '（小）' : '（莊家贏）'}${ma.pot > 0 ? '翻倍' : '歸零'}`; noteCol = ma.pot > 0 ? '#a8f0b8' : '#ffb0b0'; }   // 講清楚輸贏：歸零後領出／猜大小變暗是正常（沒獎金），不是卡死（2026-11-23 使用者回饋）
  else if (S.mary?.showPlay) { note = maryShowNote(S.mary.showPlay, nm); noteCol = '#a8f0b8'; }   // 勇者／拉霸演出的字幕
  else if (chainRun) { note = `送燈中…（剩 ${ma.lights} 個燈）`; noteCol = '#a8f0b8'; }   // 燈還沒跑完：先不亮每格的輸贏（2026-11-18 使用者回饋）
  else if (!spin && ma.last >= 0 && fresh) {
    const sym = ma.ring[ma.last];
    if (S.mary?.chainEnd === ma.seq) { note = ma.pot > 0 ? `送燈結束！共贏 ${ma.pot.toLocaleString('en-US')}` : '送燈結束！'; noteCol = '#a8f0b8'; }   // 燈全部跑完：一次顯示總獎
    else if (ma.allwin) { note = `全中獎！七種怪物全中，贏 ${(ma.win || 0).toLocaleString('en-US')}`; noteCol = '#ffd24a'; }   // 開到黃金肥龍的低機率大滿貫
    else if (sym === 'more') { note = `ONCE MORE！送 ${ma.lights} 個燈`; noteCol = '#a8f0b8'; }   // 開到 ONCE MORE＝送燈：押注維持、自動免費多開
    else {
      const b = bets[cols.indexOf(sym)] || 0, w = ma.win || b * (ma.pay[sym] || 1);
      note = w > 0 ? `${nm[sym] || sym} 贏 ${w.toLocaleString('en-US')}` : `${nm[sym] || sym}　沒押中`;
      noteCol = w > 0 ? '#a8f0b8' : '#e8f0ff';
    }
  } else if (!spin && seat && ma.lights > 0) note = `送燈中：免費多開 ${ma.lights} 次`;
  else if (!spin && seat && ma.pot <= 0) note = S.maryBets ? '按「開始」轉跑馬燈' : '點下面的圖案押注';
  else if (!spin && !seat) note = who ? `${who} 遊玩中` : '觀戰中';
  if (note) { g.font = 'bold 11px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.72)'; g.strokeText(note, ix + iw / 2, iy + ih - 8); g.fillStyle = noteCol; g.fillText(note, ix + iw / 2, iy + ih - 8); }
  // 外圈 28 格（怪物圖案；大獎格外框是靜態金框、ONCE MORE 是綠底白字格；開到 ONCE MORE 的瞬間全部的燈一起閃）
  const flashAll = !!S.mary?.chainFlash, blink = Math.floor(S.t * 6) % 2 === 1;
  for (let k = 0; k < 28; k++) {
    const sym = ma.ring[k], p = maryCellPos(k), x = MARY_RING_X + p[0] * MARY_CW, y = MARY_RING_Y + p[1] * MARY_CW;
    const isLast = ma.last === k && !spin && fresh, isCur = spin && cur === k, hot = isLast || isCur;
    if (sym === 'more') {   // ONCE MORE 格（範例圖左右兩側的跳燈）：停在上面＝送燈（押注維持、自動免費多開 1～5 次）
      // 猜大小的轉燈：左（k25）＝大、右（k11）＝小；轉燈中左右輪流閃紅燈（紅＝跳到的位置），開牌後中獎那一邊定著紅燈（2026-11-22 使用者定：改紅色）
      const isL = k === 25, isR = k === 11;
      const dblOn = !!dbl && (isL || isR) && (dblT < MARY_DBL_S ? Math.floor(dblT / .2) % 2 === (isL ? 0 : 1) : dblSide === (isL ? 'L' : 'R'));
      const hotCell = hot || dblOn;
      g.fillStyle = dblOn ? '#ff4038' : hot ? (isCur ? '#d8ffe0' : '#b8f0c4') : flashAll && blink ? '#7fd89a' : '#2f8a4a';
      g.fillRect(x + 1, y + 1, MARY_CW - 2, MARY_CW - 2);
      g.strokeStyle = dblOn ? '#8a1414' : hot ? '#ff9020' : '#1d5f2e'; g.lineWidth = hotCell ? 2 : 1;
      g.strokeRect(x + 1.5, y + 1.5, MARY_CW - 3, MARY_CW - 3);
      if (dblOn) {   // 紅燈的外圈紅色光暈（轉燈中與開牌後都慢慢脈動）
        g.strokeStyle = `rgba(255,70,50,${.35 + .35 * Math.sin(S.t * 14)})`; g.lineWidth = 2;
        g.strokeRect(x - 1.5, y - 1.5, MARY_CW + 3, MARY_CW + 3);
      }
      g.fillStyle = dblOn ? '#ffffff' : hotCell ? '#14532a' : '#eafff0'; g.font = 'bold 8px "Microsoft JhengHei"'; g.textAlign = 'center';
      g.fillText('ONCE', x + MARY_CW / 2, y + 13); g.fillText('MORE', x + MARY_CW / 2, y + 22);
      continue;
    }
    g.fillStyle = hot ? (isCur ? '#fff0a0' : '#ffe08a') : flashAll && blink ? '#ffe9a0' : '#f6eed8';
    g.fillRect(x + 1, y + 1, MARY_CW - 2, MARY_CW - 2);
    g.strokeStyle = hot ? '#ff9020' : '#c0a878'; g.lineWidth = hot ? 2 : 1;
    g.strokeRect(x + 1.5, y + 1.5, MARY_CW - 3, MARY_CW - 3);
    maryMob(g, sym, x + MARY_CW / 2, y + MARY_CW / 2, MARY_CW - 8, isCur ? Math.floor(S.t * 12) : 0);
    if (sym === 'gold_dragon' && !hot) {   // 大獎（頂排正中央 k4）外框：靜態金框（2026-11-18 使用者回饋「莫名其妙一直有燈亮」，拿掉閃燈）
      g.strokeStyle = '#c89a30'; g.lineWidth = 2;
      g.strokeRect(x - .5, y - .5, MARY_CW + 1, MARY_CW + 1);
    }
  }
  // 押注列：一欄一種圖案（賠率窗／圖案／押注板）
  for (let i = 0; i < 8; i++) {
    const sym = cols[i]; if (!sym) continue;
    const x = MARY_BET_X + i * MARY_COL_W;
    g.fillStyle = '#140a08'; g.fillRect(x + 1, MARY_BET_Y, MARY_COL_W - 2, 16);
    g.strokeStyle = '#3a2018'; g.lineWidth = 1; g.strokeRect(x + 1.5, MARY_BET_Y + .5, MARY_COL_W - 3, 15);
    g.fillStyle = '#ff8a6a'; g.font = 'bold 8px "Microsoft JhengHei"'; g.textAlign = 'left'; g.fillText('×', x + 3, MARY_BET_Y + 12);
    marySeg(g, x + MARY_COL_W - 3, MARY_BET_Y + 3, 10, String(ma.pay[sym] || 1), '#ff3020', 'right');
    maryMob(g, sym, x + MARY_COL_W / 2, MARY_BET_Y + 28, 20);
    const b = bets[i] || 0;
    g.fillStyle = b > 0 ? '#3a2410' : '#241a10'; g.fillRect(x + 1, MARY_BET_Y + 41, MARY_COL_W - 2, 18);
    g.strokeStyle = b > 0 ? '#ffb020' : '#8a6a30'; g.lineWidth = 1; g.strokeRect(x + 1.5, MARY_BET_Y + 41.5, MARY_COL_W - 3, 17);
    if (b > 0) { g.fillStyle = '#ffd24a'; g.font = 'bold 10px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillText(b >= 1000 ? `${b / 1000}k` : String(b), x + MARY_COL_W / 2, MARY_BET_Y + 55); }
  }
  // 下方控制盤
  g.fillStyle = '#e8781e'; g.fillRect(8, 352, 304, 122);
  g.fillStyle = '#f89840'; g.fillRect(8, 352, 304, 4);
  g.strokeStyle = '#a04c10'; g.lineWidth = 2; g.strokeRect(9, 353, 302, 120);
  const press = (b, label, on, big) => {   // 按鈕（暗＝不能按）
    g.fillStyle = !on ? '#9a5a20' : big ? '#f0b050' : '#f0d0a0';
    g.fillRect(b.x, b.y, b.w, b.h);
    g.fillStyle = 'rgba(255,255,255,.30)'; g.fillRect(b.x, b.y, b.w, 3);
    g.strokeStyle = '#7a3a10'; g.lineWidth = 1; g.strokeRect(b.x + .5, b.y + .5, b.w - 1, b.h - 1);
    g.fillStyle = on ? '#3a1a08' : '#6a4a28'; g.font = `bold ${big ? 14 : 12}px "Microsoft JhengHei"`; g.textAlign = 'center';
    g.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + (big ? 5 : 4));
  };
  const canBet = seat && v.phase === 'playing' && ma.pot <= 0 && !spin;
  MARY_AMT_BTNS.forEach((b, i) => press(b, i < MARY_AMTS.length ? MARY_AMTS[i] >= 1000 ? `${MARY_AMTS[i] / 1000}k` : `${MARY_AMTS[i]}` : '清空',
    canBet && (i >= MARY_AMTS.length || S.maryBetAmt === b.a || (i >= MARY_AMTS.length)), false));
  const hasBet = (S.maryBets || []).some(x => x > 0);
  MARY_ACT_BTNS.forEach(b => {
    const label = b.id === 'spin' ? (spin ? '停止' : '開始') : b.id === 'collect' ? '領出' : b.id === 'exch' ? '兌換' : b.id === 'big' ? '猜大' : '猜小';
    const on = seat && v.phase === 'playing' && (b.id === 'spin' ? (spin || (ma.pot <= 0 && hasBet)) : ma.pot > 0);
    press(b, label, on, b.id === 'spin');
  });
  // 資訊列：總注／提示
  const total = (seat ? (S.maryBets || []) : (ma.bets || [])).reduce((a, b) => a + b, 0);   // 觀戰者看到的是玩家的總注
  g.font = 'bold 11px "Microsoft JhengHei"'; g.textAlign = 'left'; g.fillStyle = '#3a1a08';
  g.fillText(`本注 ${total.toLocaleString('en-US')}`, 22, 436);
  g.textAlign = 'right'; g.fillStyle = '#5a2a10';
  g.fillText(v.phase === 'playing' ? (seat ? '一種圖案一注' : '觀戰中') : '入座後按「準備」開始', 298, 436);
  g.textAlign = 'left';
}
function marySpinTo(to, win, more) {   // 開獎：跑馬燈從目前位置多繞兩圈、減速停格（ease-out cubic；減速全程 4.8 秒——2026-11-18 使用者要求改成原本 2.4 秒的兩倍）
  const M = S.mary; if (!M) return;
  sfxWake();
  const from = M.pos, laps = 2 * 28 + ((to - from) % 28 + 28) % 28;
  M.spin = { from, to: from + laps, t0: performance.now(), dur: 4800, end: to, win, more: !!more };
  M.lastFrame = performance.now();   // 動畫起點：避免上一段動畫的舊 lastFrame 把這段往後推
  maryArmWatchdog(M.spin.dur + 6000);
  if (!S.maryRaf) S.maryRaf = requestAnimationFrame(maryFrame);
}
function maryArmWatchdog(ms) {   // 看門狗（2026-11-22 使用者回報 DC 贏了就卡死）：rAF 整個停掉的話動畫永遠不會結束＝機台永久鎖死，
  const M = S.mary; if (!M) return;   // 這裡用 setTimeout（計時器在 DC 的 iframe 裡不會被節流到完全停擺）時間一到就強制收尾，機台絕不卡死。
  clearTimeout(M.watchdog); M.watchdog = setTimeout(() => {
    const M2 = S.mary; if (!M2) return;
    if (M2.spin && performance.now() - M2.spin.t0 >= M2.spin.dur) { M2.lastFrame = performance.now(); marySkip(); maryArmWatchdog(8000); }
    else if (M2.showPlay && performance.now() - M2.showPlay.t0 > MARY_SHOW_MS) { M2.showSeq = M2.showPlay.seq; M2.showPlay = null; M2.potShown = S.tableView?.ma?.pot || M2.potShown; maryLightsNext(); maryArmWatchdog(8000); }
    else if (M2.dbl && !M2.dbl.done && performance.now() - M2.dbl.t0 >= MARY_DBL_S * 1000 + 1000) { M2.lastFrame = performance.now(); maryDblReveal(); maryPaint(); }
  }, ms);
}
function maryDblReveal() {   // 比倍開牌（燈效結束）：金額跟上＋音效＋狀態行重建（原本在 maryFrame 裡，看門狗也要叫）
  const M = S.mary; if (!M?.dbl || M.dbl.done) return;
  M.dbl.done = true;
  const ma2 = S.tableView?.ma;
  if (ma2) { M.potShown = ma2.pot || 0; M.jpShown = ma2.jp || 0; M.jpSeen = ma2.jp || 0; }
  sfxTones(M.dbl.card >= 8 || M.dbl.card <= 6 ? [[700, 0, .07], [980, .07, .12]] : [[240, 0, .26]]);   // 開大／開小＝升音；7＝莊家贏的低音
  // 輸贏講清楚（2026-11-23 使用者回饋「猜大小之後領出也不能按」＝猜錯歸零後按鈕變暗被當成卡死）：
  // 歸零後領出／猜大小本來就會暗（沒獎金可領／可賭），押注保留、按「開始」就能再玩——用 toast 明確講出來
  if (ma2) toast(ma2.pot > 0 ? `猜對！開 ${M.dbl.card}，獎池翻倍 ${ma2.pot.toLocaleString('en-US')}——可領出、兌換或再比` : `猜錯！開 ${M.dbl.card}，獎池歸零——押注保留，按「開始」再玩一局`, 3200);
  buildTable();   // 狀態行在面板重建時才會更新：開牌瞬間重建一次，「比倍轉燈中…」換成開牌後的提示（不然燈停了還寫著轉燈中）
}
function maryFrame() {
  const M = S.mary; if (!M) { S.maryRaf = 0; return; }
  const now = performance.now();
  if (M.lastFrame && now - M.lastFrame > 2000) {   // 真的切走（分頁隱藏、rAF 整個停了）回來才補償：把動畫起點往後推，跑馬燈與演出把看得見的部分完整跑完（不然會一次跳到終點＝「不跑燈直接開結果」，2026-11-19 使用者回饋）。
    // 門檻 250ms 太低（2026-11-22 使用者回報 DC 送完燈卡死）：DC 的 iframe 掉幀／節流時每幀間隔都 >250ms，t0 每幀被往後推同樣的間隔＝動畫進度永不前進（now - t0 恆等於上一幀的值）＝機台永久鎖死。
    // 改 2 秒：切走回來補一次完整 gap；只是變慢的每照常推進真實經過的時間，動畫會慢慢跑完、不會凍結。
    const gap = now - M.lastFrame;
    if (M.spin) M.spin.t0 += gap;
    if (M.showPlay) M.showPlay.t0 += gap;
    if (M.dbl) M.dbl.t0 += gap;   // 比倍轉燈同理：切回來也要把 2 秒完整跑完
  }
  M.lastFrame = now;
  if (M.dbl) {   // 猜大小的轉燈：2 秒一到才把獎池／JP 的金額跟上（燈效停止後才扣錢／發籌碼，2026-11-22 使用者定；maryDblReveal＝開牌收尾，看門狗也會叫）
    const t = (performance.now() - M.dbl.t0) / 1000;
    if (t < MARY_DBL_S) {
      const side = Math.floor(t / .2) % 2;   // 左右輪流閃的答答聲
      if (M.dbl.side !== side) { M.dbl.side = side; sfxTones([[side ? 640 : 520, 0, .03]]); }
    } else if (!M.dbl.done) maryDblReveal();
  }
  if (M.showPlay && performance.now() - M.showPlay.t0 > MARY_SHOW_MS) {   // 勇者／拉霸演出結束：WIN 亮出總獎、解除鎖定
    const ma2 = S.tableView?.ma;
    if (ma2) M.potShown = ma2.pot || 0;
    M.showSeq = M.showPlay.seq; M.showPlay = null;
    maryLightsNext();   // 送燈的鏈等演出結束才接著跑
  }
  if (M.spin) {
    const sp = M.spin, t = Math.min(1, (performance.now() - sp.t0) / sp.dur), e = 1 - Math.pow(1 - t, 3);
    const prev = Math.floor(M.pos) % 28;
    M.pos = sp.from + (sp.to - sp.from) * e;
    const cur = Math.floor(M.pos) % 28;
    if (cur !== prev) sfxTones([[500 + (cur % 5) * 70, 0, .03]]);   // 過格的答答聲（每一格一聲，減速時自然變慢）
    if (t >= 1) {
      M.spin = null; M.pos = sp.end;
      sfxTones(sp.more ? [[520, 0, .08], [780, .08, .08], [1040, .16, .14]] : sp.win ? [[660, 0, .09], [880, .09, .09], [1180, .18, .2]] : [[220, 0, .28]]);   // ONCE MORE＝輕快三連音；開出獎＝三連升音；沒中＝低音
      const ma2 = S.tableView?.ma;
      if (M.showPending && ma2) { M.showPlay = { ...M.showPending, t0: performance.now() }; M.showPending = null; M.lastFrame = performance.now(); maryArmWatchdog(MARY_SHOW_MS + 8000); }   // 勇者／拉霸演出接著播
      else if (ma2) M.potShown = ma2.pot || 0;   // 動畫停格：WIN 才跟上這一注的結果
      if (M.chainHold && ma2 && !(ma2.lights > 0)) { M.chainHold = false; M.chainEnd = ma2.seq; }   // 燈全部跑完：解除凍結、記下要顯示「送燈結束」的 seq
      maryLightsNext();   // 送燈：動畫跑完自動免費多開下一個燈
    }
  }
  maryPaint();
  const dblRun = !!(S.mary?.dbl && performance.now() - S.mary.dbl.t0 < (MARY_DBL_S + MARY_DBL_TAIL) * 1000);
  if (S.mary?.spin || S.mary?.showPlay || dblRun) S.maryRaf = requestAnimationFrame(maryFrame); else S.maryRaf = 0;   // 演出播放中也要連續重畫
}
function maryStop() { if (S.maryRaf) { cancelAnimationFrame(S.maryRaf); S.maryRaf = 0; } if (maryGlowTimer) { clearTimeout(maryGlowTimer); maryGlowTimer = 0; } if (S.mary?.watchdog) clearTimeout(S.mary.watchdog); if (S.mary?.chainTick) clearInterval(S.mary.chainTick); S.mary = null; }
function marySkip() {   // 「停止」：直接把跑馬燈跳到伺服器開出的那一格（動畫只是表演，結果早就是伺服器定的）
  const M = S.mary; if (!M?.spin) return;
  const sp = M.spin;
  M.pos = sp.end; M.spin = null;
  sfxTones(sp.more ? [[520, 0, .08], [780, .08, .08], [1040, .16, .14]] : sp.win ? [[660, 0, .09], [880, .09, .09], [1180, .18, .2]] : [[220, 0, .28]]);
  if (S.maryRaf) { cancelAnimationFrame(S.maryRaf); S.maryRaf = 0; }
  const ma2 = S.tableView?.ma;
  if (M.showPending && ma2) { M.showPlay = { ...M.showPending, t0: performance.now() }; M.showPending = null; M.lastFrame = performance.now(); maryArmWatchdog(MARY_SHOW_MS + 8000); }
  else if (ma2) M.potShown = ma2.pot || 0;
  if (M.chainHold && ma2 && !(ma2.lights > 0)) { M.chainHold = false; M.chainEnd = ma2.seq; }   // 燈全部跑完：解除凍結
  maryPaint();
  if (M.showPlay) S.maryRaf = requestAnimationFrame(maryFrame);   // 演出接著播
  maryLightsNext();   // 送燈：跳到結果也照樣接著自動多開（演出中會自動等）
}
function maryLightsNext(delay = 700) {   // 送燈：這次開獎的動畫結束後，自動免費多開下一個燈（押注維持、不能改注）。700ms 停頓讓玩家看到每個燈的結果；
  const v = S.tableView, ma = v?.ma;   // 伺服器對 light:1 的開獎在燈已用完時會安靜略過（手動開獎搶先消掉最後一個燈也不會誤扣款）
  if (v?.game !== 'mary' || v.phase !== 'playing' || v.role !== 'seat' || !S.mary || !ma || !(ma.lights > 0)) return;
  setTimeout(() => {
    const v2 = S.tableView, ma2 = v2?.ma;
    if (v2?.game !== 'mary' || v2.phase !== 'playing' || v2.role !== 'seat' || !S.mary || S.mary?.spin || !ma2 || !(ma2.lights > 0)) return;
    if (S.mary?.showPlay) return;   // 勇者／拉霸演出中先不送（演出結束的 maryLightsNext 會再叫一次）
    // 防雙發改成「時間窗」（2026-11-23）：同一格 2.5 秒內不重送；超過 2.5 秒 seq 還沒動＝上次請求可能被伺服器丟掉，允許重送（鏈自愈）。
    // 舊版「記下 seq 就永遠不重送」會讓丟包後整條鏈永久卡死＝機台全鎖。
    if (S.mary.lightsSeq === ma2.seq && performance.now() - (S.mary.lightsSentAt || 0) < 2500) return;
    S.mary.lightsSeq = ma2.seq; S.mary.lightsSentAt = performance.now();
    S.net?.tbl?.({ a: 'mspin', bets: S.maryBets, light: 1 });
  }, delay);
}
function maryChainTick(on) {   // 送燈鏈巡檢（2026-11-23）：每 2 秒叫一次 maryLightsNext(0)——丟包時靠它重送；燈跑完自動停。
  const M = S.mary; if (!M) return;   // 不用看門狗強制解鎖（那會讓燈沒跑完就亮總獎）；chainHold 只在燈真的跑完時解除。
  if (on) { if (!M.chainTick) M.chainTick = setInterval(() => { const v = S.tableView; if (!v?.ma || !(v.ma.lights > 0)) { maryChainTick(false); return; } maryLightsNext(0); }, 2000); }
  else if (M.chainTick) { clearInterval(M.chainTick); M.chainTick = 0; }
}
let maryGlowTimer = 0;
function maryGlow() {   // JP 橫幅的閃爍：桌面開著時每 0.5 秒重畫（spin／演出中由 maryFrame 自己畫，這裡跳過）；面板關了就不再排
  maryGlowTimer = 0;
  if (!S.tableOpen || S.tableView?.game !== 'mary' || !document.getElementById('maryCanvas')) return;
  if (!S.mary?.spin && !S.mary?.showPlay && !(S.mary?.dbl && performance.now() - S.mary.dbl.t0 < (MARY_DBL_S + MARY_DBL_TAIL) * 1000)) maryPaint();
  maryGlowTimer = setTimeout(maryGlow, 500);
}
function maryShowNote(sp, nm) {   // 勇者挑戰＋拉霸演出的字幕（照時間軸換句）
  const t = (performance.now() - sp.t0) / 1000;
  if (!sp.heroWin) return t < 1.2 ? '勇者現身，挑戰島主！' : '勇者挑戰失敗…';
  if (t < 1.2) return '勇者現身，挑戰島主！';
  if (t < 2.2) return '勇者打倒了島主！拉霸啟動！';
  if (t < 4.2) return '';   // 拉霸轉動中（畫面自己說話）
  if (sp.triple === 'gold_dragon') return `三個黃金肥龍！獨得獎池 ${sp.prize.toLocaleString('en-US')}！`;
  if (sp.triple) return `三同 ${nm[sp.triple] || sp.triple}！贏 ${sp.prize.toLocaleString('en-US')}`;
  return '拉霸沒有中…';
}
function maryAddBet(i) {   // 這一欄（圖案）加一注
  const v = S.tableView, ma = v?.ma; if (!v || v.game !== 'mary' || !ma || v.role !== 'seat' || v.phase !== 'playing') return;
  if (ma.pot > 0 || S.mary?.spin) return;
  if (ma.lights > 0) { toast('送燈中，押注不能改', 1600); return; }   // 送燈：押注維持（伺服器也會擋改注）
  const n = (ma.cols || []).length || 8, bets = (S.maryBets ||= new Array(n).fill(0));
  const amt = S.maryBetAmt, maxBet = ma.maxBet || 10000;
  if (!amt) { toast('先點下面的金額鈕再押注', 1500); return; }   // 按「清空」會連金額一起清掉：要先重選金額
  if ((bets[i] || 0) + amt > maxBet) { toast(`每種圖案最多押 ${maxBet.toLocaleString('en-US')}`, 1800); return; }
  if (bets.reduce((a, b) => a + b, 0) + amt > Math.floor(ma.chips || 0)) { toast('籌碼不足', 1800); return; }
  bets[i] = (bets[i] || 0) + amt;
  if (S.mary) S.mary.res = -1;   // 開始新一輪的押注：上一輪的結果高亮／提示收掉
  sfxTones([[760, 0, .05]]);
  buildTable();
}
function maryExchange() {   // 兌換經驗值（面板「離開（Esc）」正下方的按鈕，2026-11-16 使用者定）：獎池 → 角色經驗值（1 經驗值＝100 籌碼，真兌換、XP 不回饋籌碼）
  const v = S.tableView, ma = v?.ma; if (!v || v.game !== 'mary' || !ma || v.role !== 'seat' || v.phase !== 'playing') return;
  if (ma.pot <= 0 || S.mary?.spin || (S.mary?.dbl && !S.mary.dbl.done)) return;
  const pot = Math.floor(ma.pot);
  if (!xpServer()) {   // 訪客：XP 在本機（S.profile.xp），這裡直接加＋演出；伺服器只負責把獎池燒掉
    const xp = Math.floor(pot / 100);
    if (xp <= 0) { toast(`獎池 ${pot} 籌碼不足 100，不能兌換`, 1800); return; }
    const p = S.players[0], before = lvInfo(S.profile.xp).lv;
    S.profile.xp = Math.max(0, S.profile.xp + xp); saveProfile();
    S.floaters.push({ x: p.x, y: p.y, v: `+${xp} XP`, life: .9, xpGain: true });
    const after = lvInfo(S.profile.xp);
    if (after.lv > before) levelUpFx(p, after.lv);
  }
  S.net?.tbl?.({ a: 'mxp' });   // 登入者：伺服器記進 Registry（不回饋籌碼）、回 xp 訊息演出
}
function maryClick(px, py, trusted = true) {   // 機台畫布的點擊：控制盤 → 金額鈕 → 押注列／外圈
  const v = S.tableView, ma = v?.ma; if (!v || v.game !== 'mary' || !ma) return;
  const seat = v.role === 'seat', playing = v.phase === 'playing';
  const hit = b => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  if (!seat || !playing) return;
  if (S.mary?.chainHold && (S.mary?.spin || ma.lights > 0)) return;   // 送燈鏈進行中：全機台鎖定，一個一個跑完才能操作（2026-11-18 使用者定）
  if (S.mary?.showPlay) return;   // 勇者／拉霸演出中：鎖定（2026-11-19 使用者定）
  if (S.mary?.dbl && !S.mary.dbl.done) return;   // 比倍轉燈中：鎖住機台（燈效停止才扣錢／發籌碼，2026-11-22 使用者定）
  const spin = !!S.mary?.spin;
  for (const b of MARY_ACT_BTNS) {
    if (!hit(b)) continue;
    if (b.id === 'spin') {
      if (spin) { marySkip(); return; }
      if (ma.pot > 0) return;
      const bets = S.maryBets; if (!bets || !bets.some(x => x > 0)) { toast('先押注再開始', 1600); return; }
      const total = bets.reduce((a, b) => a + b, 0);
      if (total > Math.floor(ma.chips || 0)) { toast('籌碼不足', 1800); return; }   // 照上一次的押注重開：餘額不夠先擋（伺服器也會原子扣款擋一次）
      S.net?.tbl?.({ a: 'mspin', bets }); buildTable();   // 押注保留：再按「開始」就照這份押注直接再開
    } else if (b.id === 'collect') { if (ma.pot > 0) S.net?.tbl?.({ a: 'mcol' }); }
    else if (b.id === 'big') { if (ma.pot > 0 && trusted) S.net?.tbl?.({ a: 'mdbl', big: 1 }); }   // 比大小只接受真人點擊：合成事件（isTrusted false）一律忽略，杜絕幽靈輸入（2026-11-19 使用者回饋）
    else if (b.id === 'small') { if (ma.pot > 0 && trusted) S.net?.tbl?.({ a: 'mdbl', big: 0 }); }
    return;
  }
  if (ma.pot > 0 || spin) return;   // 獎金還躺在獎池時不能再押（要先領出或比倍）
  for (const b of MARY_AMT_BTNS) {
    if (!hit(b)) continue;
    if (b.a < 0) { if (ma.lights > 0) { toast('送燈中，押注不能改', 1600); return; } S.maryBets = null; S.maryBetAmt = null; if (S.mary) S.mary.res = -1; } else S.maryBetAmt = b.a;   // 清空連選好的金額也清掉（不然金額鈕還亮著會誤會沒清乾淨，2026-11-22 使用者回饋）
    buildTable(); return;
  }
  const ci = maryColAt(px);
  if (ci >= 0 && py >= MARY_BET_Y && py < MARY_BET_Y + 60) { maryAddBet(ci); return; }
  const k = maryCellAt(px, py);
  if (k >= 0) { const ci2 = (ma.cols || []).indexOf(ma.ring[k]); if (ci2 >= 0) maryAddBet(ci2); }
}
// ── 21 點（t98，2026-11-24，使用者要求：隱藏區的賭博桌、1～8 位玩家、莊家用隨機島主）──
// 規則與結算全在伺服器（worker/src/index.js 的 bj*、tools/dev_server.py 的 bj_*）；這裡只畫 v.bj 並送操作：bbet {n}（加注）／bclr（清空）／bok（確定）／bhit／bstand／bdbl，
// 逾時（下注／輪到的人／結果顯示完）由每個在桌邊的客戶端每秒送 timeout，伺服器核對時鐘。籌碼：登入者以伺服器為準；訪客的 S.chips＝機台餘額＋下注階段已下的注（離座退注）。
const BJ_AMTS = [10, 50, 100, 500, 1000, 5000];
function bjTimerTick() {
  const v = S.tableView;
  if (!S.tableOpen || v?.game !== 'blackjack' || !v.bj) { clearInterval(S.bjTimer); S.bjTimer = 0; return; }
  const left = Math.max(0, S.bjDl - performance.now()), el = document.getElementById('bjCount');
  if (el) el.textContent = `${Math.ceil(left / 1000)} 秒`;
  if (left <= 0 && performance.now() - (S.bjSentAt || 0) > 1200) { S.bjSentAt = performance.now(); S.net?.tbl?.({ a: 'timeout' }); }   // 時間到：請伺服器推進（任何人都能送，只有第一個有效）
}
const bjAtRisk = v => !!(v?.game === 'blackjack' && v.bj && v.role === 'seat' && v.bj.stage === 'play' && v.bj.p[v.me]?.bet > 0 && ['play', 'stand', 'bj'].includes(v.bj.p[v.me].st));   // 發牌後離座＝放棄這一局的注（離開確認只在這時問）
function buildBlackjack(box, v, mk, gd) {
  const b = v.bj, seat = v.role === 'seat', me = v.me;
  if (!b) {   // 還沒有人入座（桌子沒開）：觀戰者可以當第一個坐下的人
    box.appendChild(mk('div', 'table-status', '桌子還沒開，有人入座就開桌'));
    const bs = mk('div', 'table-btns'), sb = mk('button', 'ff-btn', '入座'); sb.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); bs.appendChild(sb); box.appendChild(bs);
    return;
  }
  const my = seat ? b.p[me] : null;
  if (seat && typeof b.chips === 'number') {   // 籌碼同步：登入者＝機台上的餘額；訪客＝餘額＋下注階段已下的注（離座退注）
    const nv = Math.floor(b.chips) + (!xpServer() && b.stage === 'bet' ? (my?.bet || 0) : 0);
    if (nv !== S.chips) { S.chips = nv; chipsSave(); if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel(); }
  }
  S.bjDl = performance.now() + b.left;
  if (!S.bjTimer) S.bjTimer = setInterval(bjTimerTick, 250);
  // 狀態列＋倒數
  let st;
  if (b.stage === 'bet') st = seat ? (my.bet > 0 ? '已下注：可以再加碼，按「確定發牌」（全員確定就提早發牌）' : '下注時間：點金額加注（單局最多 ' + b.maxBet + '）') : '下注時間（觀戰中）';
  else if (b.stage === 'play') st = b.turn < 0 ? '發牌中…' : seat && b.turn === me ? '輪到你：要牌、停牌或雙倍' : `輪到 ${v.seats[b.turn]?.name || '玩家'}`;
  else st = '本局結算，稍後自動開始下一局';
  const stat = mk('div', 'table-status' + (seat && b.stage === 'play' && b.turn === me ? ' mine' : ''), st + '　');
  const cnt = mk('span', 'bj-count', ''); cnt.id = 'bjCount'; cnt.textContent = `${Math.ceil(b.left / 1000)} 秒`; stat.appendChild(cnt);
  box.appendChild(stat);
  // 莊家（隨機島主）
  const dl = mk('div', 'bj-dealer'), cv = document.createElement('canvas'); cv.width = cv.height = 64; cv.className = 'bj-owner';
  maryMob(cv.getContext('2d'), b.owner, 32, 34, 60, 0);
  dl.appendChild(cv);
  const di = mk('div', 'bj-dealer-info');
  di.appendChild(mk('div', 'table-name', `莊家：${MARY_OWNERS_NM[b.owner] || '島主'}`));
  const dc = mk('div', 'table-cards bj-hand'); for (const c of b.dealer) dc.appendChild(cardEl(c)); di.appendChild(dc);
  di.appendChild(mk('div', 'table-tag', b.dealer.length ? (b.dealer.includes(null) ? `明牌 ${b.dt}` : b.dt > 21 ? `${b.dt} 爆牌` : `${b.dt} 點`) : '等待發牌'));
  dl.appendChild(di); box.appendChild(dl);
  // 玩家座位
  const row = mk('div', 'table-seats bj-seats');
  v.seats.forEach((s, k) => {
    const p = b.p[k], turn = b.stage === 'play' && b.turn === k;
    const el = mk('div', 'table-seat bj-seat' + (s.you ? ' you' : '') + (turn ? ' turn' : '') + (['out', 'wait'].includes(p.st) ? ' out' : ''));
    el.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
    const hand = mk('div', 'table-cards bj-hand'); for (const c of p.cards) hand.appendChild(cardEl(c)); el.appendChild(hand);
    let tag;
    if (b.stage === 'bet') tag = p.bet > 0 ? `下注 ${p.bet}${p.ok ? '　✔ 已確定' : ''}` : '尚未下注';
    else if (p.st === 'out') tag = '本局觀望';
    else if (p.st === 'wait') tag = '下一局加入';
    else if (b.stage === 'result' && p.res) tag = p.res === 'win' ? `贏 +${p.pay - p.bet}` : p.res === 'bj' ? `Blackjack！+${p.pay - p.bet}` : p.res === 'push' ? '平手（退注）' : `輸 -${p.bet}`;
    else tag = p.st === 'bj' ? 'Blackjack！' : p.st === 'bust' ? '爆牌' : p.st === 'stand' ? (p.dbl ? '雙倍・停牌' : '停牌') : turn ? '行動中' : '等待';
    const tot = p.cards.length ? `${p.tot} 點　` : '';
    const good = b.stage === 'result' && (p.res === 'win' || p.res === 'bj'), bad = b.stage === 'result' && p.res === 'lose';
    el.appendChild(mk('div', 'table-tag' + (good ? ' bj-win' : bad ? ' bj-lose' : ''), `${tot}${tag}`));
    if (b.stage !== 'bet' && p.bet > 0) el.appendChild(mk('div', 'table-label', `注 ${p.bet}`));
    row.appendChild(el);
  });
  box.appendChild(row);
  // 操作區
  if (seat) {
    box.appendChild(mk('div', 'table-tag bj-chips', `我的籌碼：${Math.floor(b.chips || 0).toLocaleString('en-US')}（單局最多押 ${b.maxBet}）`));
    const bs = mk('div', 'table-btns bj-btns');
    if (b.stage === 'bet') {
      for (const a of BJ_AMTS) {
        const bt = mk('button', 'ff-btn small', a >= 1000 ? `${a / 1000}k` : `${a}`);
        bt.disabled = my.bet + a > b.maxBet || (b.chips || 0) < a;
        bt.onclick = () => S.net?.tbl?.({ a: 'bbet', n: a });
        bs.appendChild(bt);
      }
      const cl = mk('button', 'ff-btn small', '清空'); cl.disabled = !(my.bet > 0); cl.onclick = () => S.net?.tbl?.({ a: 'bclr' }); bs.appendChild(cl);
      const ok = mk('button', 'ff-btn', '確定發牌'); ok.disabled = !(my.bet > 0) || my.ok; ok.onclick = () => S.net?.tbl?.({ a: 'bok' }); bs.appendChild(ok);
    } else {
      const mine = b.stage === 'play' && b.turn === me && my.st === 'play';
      const hit = mk('button', 'ff-btn', '要牌'), stand = mk('button', 'ff-btn', '停牌'), dbl = mk('button', 'ff-btn small', '雙倍');
      hit.disabled = stand.disabled = !mine;
      dbl.disabled = !mine || my.cards.length !== 2 || (b.chips || 0) < my.bet;
      hit.onclick = () => S.net?.tbl?.({ a: 'bhit' }); stand.onclick = () => S.net?.tbl?.({ a: 'bstand' }); dbl.onclick = () => S.net?.tbl?.({ a: 'bdbl' });
      bs.append(hit, stand, dbl);
    }
    box.appendChild(bs);
  } else if (v.seats.length < v.max) {
    const bs = mk('div', 'table-btns'), sb = mk('button', 'ff-btn', '入座'); sb.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); bs.appendChild(sb); box.appendChild(bs);
  }
  const lg = mk('div', 'table-log'); for (const l of tableLogLines(v)) lg.appendChild(mk('div', '', l)); box.appendChild(lg);
}
// ── 吃角子老虎機（t97）與輪盤（t96）（2026-11-24，使用者要求：隱藏區的賭博機台）──
// 規則與結算全在伺服器（worker/src/index.js 的 sl*／ro*、tools/dev_server.py 的 sl_*／ro_*）；客戶端只畫 v.sl／v.ro 並送操作。動畫都用 setTimeout／setInterval，
// 不靠 rAF（DC 的 iframe 會把 rAF 壓到幾乎停擺，小瑪莉就因此卡過）：結果早就定了，動畫只是表演，計時器一到一定收尾、解鎖。
const SL_NM = { chicken: '咕咕雞', bunny: '跳跳兔', frog: '大肚蛙', slime_grass: '史萊姆', goblin_grass: '哥布林', gold_dragon: '黃金肥龍' };
const SL_ANIM_MS = 2400, SL_STOP0 = 900, SL_STOP_GAP = 500;
function slDrawReels() {   // 三個轉輪畫布：動畫中沒停的轉輪快速換圖，停了的定在結果
  const cvs = document.querySelectorAll('canvas.sl-reel'), M = S.sl; if (!cvs.length || !M) return;
  const now = performance.now(), syms = M.syms || Object.keys(SL_NM);
  cvs.forEach((cv, i) => {
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#f4f0e4'; g.fillRect(0, 0, cv.width, cv.height);
    const a = M.anim, fin = M.last?.reels?.[i];
    let sym = fin;
    if (a && now - a.t0 < SL_STOP0 + i * SL_STOP_GAP) sym = syms[Math.floor((now - a.t0) / 70 + i * 3) % syms.length];
    if (sym) maryMob(g, sym, cv.width / 2, cv.height / 2, cv.width - 12, 0);
    else { g.fillStyle = '#9a8a70'; g.font = 'bold 36px sans-serif'; g.textAlign = 'center'; g.fillText('?', cv.width / 2, cv.height / 2 + 12); }
    g.strokeStyle = '#7a6a50'; g.lineWidth = 2; g.strokeRect(1, 1, cv.width - 2, cv.height - 2);
  });
}
function slFinish() {   // 動畫結束：解鎖、顯示結果與餘額（計時器收尾，不靠 rAF）
  const M = S.sl; if (!M) return;
  M.anim = null; clearInterval(M.iv); M.iv = 0; clearTimeout(M.to); M.to = 0;
  if (S.tableOpen && S.tableView?.game === 'slots') buildTable();
}
function buildSlots(box, v, mk, gd) {
  const sl = v.sl, seat = v.role === 'seat', playing = v.phase === 'playing';
  const M = (S.sl ||= { seq: sl ? sl.seq : 0, anim: null });
  M.syms = sl?.syms; M.last = sl?.last || null;
  if (playing && sl && sl.seq !== M.seq) {   // 新的一次拉霸：開始轉
    M.seq = sl.seq;
    if (sl.last) {
      M.anim = { t0: performance.now() };
      clearInterval(M.iv); clearTimeout(M.to);
      M.iv = setInterval(slDrawReels, 70);
      M.to = setTimeout(slFinish, SL_ANIM_MS);   // 一定收尾
      sfxWake(); sfxTones([[520, 0, .04], [620, .12, .04], [720, .24, .04]]);
    }
  }
  const spinning = !!M.anim, my = sl?.last, pay = my ? my.pay : 0;
  if (seat && typeof sl?.chips === 'number' && sl.chips !== S.chips && !xpServer()) { S.chips = Math.floor(sl.chips); chipsSave(); if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel(); }
  let status;
  if (playing && seat) status = spinning ? '轉動中…' : my ? (pay > 0 ? `${my.reels.map(s => SL_NM[s]).join('・')}　贏 ${pay.toLocaleString('en-US')}！` : `${my.reels.map(s => SL_NM[s]).join('・')}　沒中`) : '選好金額，按「拉霸」';
  else if (playing) status = `觀戰中：${v.seats[0]?.name || '玩家'} 正在玩（餘額只有本人看得到）`;
  else status = v.seats.length < v.min ? '等待玩家入座（單人機台）' : '按「準備」就開始（用籌碼下注）';
  box.appendChild(mk('div', 'table-status' + (playing && seat ? ' mine' : '') + (!spinning && pay > 0 ? ' sl-win' : ''), status));
  const row = mk('div', 'sl-reels');
  for (let i = 0; i < 3; i++) { const cv = document.createElement('canvas'); cv.className = 'sl-reel'; cv.width = cv.height = 96; row.appendChild(cv); }
  box.appendChild(row);
  slDrawReels();
  if (playing && seat) {
    const shown = Math.floor(sl.chips || 0) - (spinning ? pay : 0) + (spinning && my ? my.bet : 0) * 0;   // 轉動中先不顯示這次贏的錢（扣款已在餘額裡）
    box.appendChild(mk('div', 'table-tag bj-chips', `我的籌碼：${shown.toLocaleString('en-US')}`));
    const bs = mk('div', 'table-btns');
    S.slBet = (sl.bets || []).includes(S.slBet) ? S.slBet : 100;
    for (const a of sl.bets || []) {
      const b = mk('button', 'ff-btn small' + (S.slBet === a ? ' active' : ''), a >= 1000 ? `${a / 1000}k` : `${a}`);
      b.disabled = spinning; b.onclick = () => { S.slBet = a; buildTable(); };
      bs.appendChild(b);
    }
    const go = mk('button', 'ff-btn', '拉霸'); go.disabled = spinning || (sl.chips || 0) < S.slBet;
    go.onclick = () => { go.disabled = true; S.net?.tbl?.({ a: 'sspin', bet: S.slBet }); };
    bs.appendChild(go);
    box.appendChild(bs);
  }
  const pt = mk('div', 'table-tag sl-pay');   // 賠率表（含本金總賠率）
  pt.textContent = `三個一樣：${(sl?.syms || []).map(s => `${SL_NM[s]}×${sl.triple[s]}`).join('　')}　｜　左邊兩個一樣：${(sl?.syms || []).map(s => `${SL_NM[s]}×${sl.pair[s]}`).join('　')}`;
  box.appendChild(pt);
  const btns = mk('div', 'table-btns');
  if (!playing) {
    if (seat) {
      const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
      b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
      const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
    } else if (v.role === 'spec' && v.seats.length < v.max) {
      const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); btns.appendChild(b);
    }
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
}
// ── 輪盤 ──
const RO_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const roCol = n => n === 0 ? 'green' : RO_RED.has(n) ? 'red' : 'black';
const RO_AMTS = [10, 50, 100, 500, 1000, 5000], RO_ANIM_MS = 3600;
function roMultC(key, n) {   // 與伺服器 roMult／ro_mult 同一套：這個下注鍵在開出 n 時的總賠率（客戶端只拿來亮出中獎格）
  if (key[0] === 'n') return Number(key.slice(1)) === n ? 36 : 0;
  if (n === 0) return 0;
  const red = RO_RED.has(n);
  return ({ red: red ? 2 : 0, black: red ? 0 : 2, odd: n % 2 === 1 ? 2 : 0, even: n % 2 === 0 ? 2 : 0, low: n <= 18 ? 2 : 0, high: n >= 19 ? 2 : 0,
    d1: n <= 12 ? 3 : 0, d2: n >= 13 && n <= 24 ? 3 : 0, d3: n >= 25 ? 3 : 0, c1: n % 3 === 1 ? 3 : 0, c2: n % 3 === 2 ? 3 : 0, c3: n % 3 === 0 ? 3 : 0 })[key] || 0;
}
function roTimerTick() {
  const v = S.tableView;
  if (!S.tableOpen || v?.game !== 'roulette' || !v.ro) { clearInterval(S.roTimer); S.roTimer = 0; return; }
  const left = Math.max(0, S.roDl - performance.now()), el = document.getElementById('roCount');
  if (el) el.textContent = `${Math.ceil(left / 1000)} 秒`;
  if (left <= 0 && performance.now() - (S.roSentAt || 0) > 1200) { S.roSentAt = performance.now(); S.net?.tbl?.({ a: 'timeout' }); }
}
function roBallTick() {   // 開球動畫：號碼快速跳動，時間到定在結果（setInterval，到時一定收尾並重建畫面亮出結算）
  const R = S.ro, el = document.getElementById('roBall'); if (!R?.anim) return;
  const dt = performance.now() - R.anim.t0;
  if (dt >= RO_ANIM_MS) { clearInterval(R.iv); R.iv = 0; R.anim = null; if (S.tableOpen && S.tableView?.game === 'roulette') buildTable(); return; }
  if (el) { const n = Math.floor(Math.random() * 37); el.textContent = n; el.className = `ro-ball ${roCol(n)} spin`; }
}
function buildRoulette(box, v, mk, gd) {
  const r = v.ro, seat = v.role === 'seat', me = v.me;
  if (!r) {
    box.appendChild(mk('div', 'table-status', '桌子還沒開，有人入座就開桌'));
    const bs = mk('div', 'table-btns'), sb = mk('button', 'ff-btn', '入座'); sb.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); bs.appendChild(sb); box.appendChild(bs);
    return;
  }
  const R = (S.ro ||= { round: 0, anim: null });
  if (r.stage === 'result' && R.round !== r.round) {   // 新的一次開球：剛開出的才轉（中途進來、結果已經顯示一陣子的不轉）
    R.round = r.round; clearInterval(R.iv); R.iv = 0;
    if (r.left > 5000) { R.anim = { t0: performance.now() }; R.iv = setInterval(roBallTick, 90); sfxWake(); sfxTones([[440, 0, .05], [520, .15, .05], [600, .3, .05]]); } else R.anim = null;
  } else if (r.stage === 'bet') { R.round = r.round; R.anim = null; clearInterval(R.iv); R.iv = 0; }
  const my = seat ? r.p[me] : null, spinning = !!R.anim, revealed = r.stage === 'result' && !spinning;
  if (seat && typeof r.chips === 'number') {   // 籌碼同步：登入者＝機台餘額；訪客＝餘額＋下注階段已下的注（離座退注）
    const nv = Math.floor(r.chips) + (!xpServer() && r.stage === 'bet' ? (my?.bet || 0) : 0);
    if (nv !== S.chips) { S.chips = nv; chipsSave(); if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel(); }
  }
  S.roDl = performance.now() + r.left;
  if (!S.roTimer) S.roTimer = setInterval(roTimerTick, 250);
  let st;
  if (r.stage === 'bet') st = seat ? (my.bet > 0 ? `已下注 ${my.bet}：可再加碼，按「確定」（全員確定就提早開球）` : '下注時間：選金額，點下注盤上的格子') : '下注時間（觀戰中）';
  else st = spinning ? '輪盤轉動中…' : `開出 ${r.result}（${{ red: '紅', black: '黑', green: '綠' }[roCol(r.result)]}）`;
  const stat = mk('div', 'table-status' + (seat && r.stage === 'bet' ? ' mine' : ''), st + '　');
  const cnt = mk('span', 'bj-count', ''); cnt.id = 'roCount'; cnt.textContent = `${Math.ceil(r.left / 1000)} 秒`; stat.appendChild(cnt);
  box.appendChild(stat);
  // 球（開出的號碼）＋歷史
  const top = mk('div', 'ro-top');
  const ball = mk('div', `ro-ball ${r.result == null || spinning ? 'idle' : roCol(r.result)}`, r.result == null ? '·' : spinning ? '0' : String(r.result)); ball.id = 'roBall';
  top.appendChild(ball);
  const hist = mk('div', 'ro-hist');
  for (const n of [...r.hist].reverse()) hist.appendChild(mk('span', `ro-h ${roCol(n)}`, String(n)));
  top.appendChild(hist); box.appendChild(top);
  // 下注盤（歐式：0＋3 列×12 欄＋三直欄＋三打＋外圍注）
  const board = mk('div', 'ro-board'), mine = my ? my.bets : {};
  const cell = (key, label, cls, col, row, colSpan = 1, rowSpan = 1) => {
    const b = mk('button', `ro-cell ${cls}` + (revealed && r.result != null && roMultC(key, r.result) > 0 ? ' ro-hit' : ''), label);
    b.style.gridColumn = `${col} / span ${colSpan}`; b.style.gridRow = `${row} / span ${rowSpan}`;
    if (mine[key]) b.appendChild(mk('span', 'ro-chip', mine[key] >= 1000 ? `${mine[key] / 1000}k` : String(mine[key])));
    b.disabled = !(seat && r.stage === 'bet');
    b.onclick = () => S.net?.tbl?.({ a: 'rbet', k: key, n: S.roAmt || 100 });
    board.appendChild(b);
  };
  cell('n0', '0', 'green', 1, 1, 1, 3);
  for (let k = 1; k <= 36; k++) { const colIdx = Math.ceil(k / 3), rowIdx = 3 - ((k - 1) % 3); cell(`n${k}`, String(k), roCol(k), colIdx + 1, rowIdx); }
  cell('c3', '2:1', 'outside', 14, 1); cell('c2', '2:1', 'outside', 14, 2); cell('c1', '2:1', 'outside', 14, 3);
  cell('d1', '1st 12', 'outside', 2, 4, 4); cell('d2', '2nd 12', 'outside', 6, 4, 4); cell('d3', '3rd 12', 'outside', 10, 4, 4);
  cell('low', '1-18', 'outside', 2, 5, 2); cell('even', '雙', 'outside', 4, 5, 2); cell('red', '紅', 'red', 6, 5, 2); cell('black', '黑', 'black', 8, 5, 2); cell('odd', '單', 'outside', 10, 5, 2); cell('high', '19-36', 'outside', 12, 5, 2);
  box.appendChild(board);
  // 座位
  const rowS = mk('div', 'table-seats bj-seats');
  v.seats.forEach((s, k) => {
    const p = r.p[k], el = mk('div', 'table-seat bj-seat' + (s.you ? ' you' : '') + (p.st === 'out' && r.stage === 'result' ? ' out' : ''));
    el.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
    let tag;
    if (r.stage === 'bet') tag = p.bet > 0 ? `下注 ${p.bet}${p.ok ? '　✔' : ''}` : p.ok ? '本局不下注' : '尚未下注';
    else if (!revealed) tag = p.bet > 0 ? `下注 ${p.bet}` : '本局觀望';
    else if (p.st === 'out') tag = '本局觀望';
    else tag = p.res === 'win' ? `贏 +${p.pay - p.bet}` : p.res === 'push' ? '平手（退注）' : `輸 -${p.bet - p.pay}`;
    el.appendChild(mk('div', 'table-tag' + (revealed && p.res === 'win' ? ' bj-win' : revealed && p.res === 'lose' ? ' bj-lose' : ''), tag));
    rowS.appendChild(el);
  });
  box.appendChild(rowS);
  if (seat) {
    box.appendChild(mk('div', 'table-tag bj-chips', `我的籌碼：${Math.floor(r.chips || 0).toLocaleString('en-US')}（單格最多 ${r.maxSpot}、一局最多 ${r.maxTotal}）`));
    const bs = mk('div', 'table-btns bj-btns');
    S.roAmt = RO_AMTS.includes(S.roAmt) ? S.roAmt : 100;
    for (const a of RO_AMTS) { const b = mk('button', 'ff-btn small' + (S.roAmt === a ? ' active' : ''), a >= 1000 ? `${a / 1000}k` : `${a}`); b.onclick = () => { S.roAmt = a; buildTable(); }; bs.appendChild(b); }
    const bet = r.stage === 'bet';
    const cl = mk('button', 'ff-btn small', '清空'); cl.disabled = !bet || !(my.bet > 0); cl.onclick = () => S.net?.tbl?.({ a: 'rclr' }); bs.appendChild(cl);
    const rp = mk('button', 'ff-btn small', '重複上局'); rp.disabled = !bet || my.bet > 0 || !r.canRep; rp.onclick = () => S.net?.tbl?.({ a: 'rrep' }); bs.appendChild(rp);
    const ok = mk('button', 'ff-btn', my.bet > 0 || !my.ok ? '確定' : '本局不下注'); ok.disabled = !bet || my.ok; ok.onclick = () => S.net?.tbl?.({ a: 'rok' }); bs.appendChild(ok);
    box.appendChild(bs);
  } else if (v.seats.length < v.max) {
    const bs = mk('div', 'table-btns'), sb = mk('button', 'ff-btn', '入座'); sb.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); bs.appendChild(sb); box.appendChild(bs);
  }
  const lg = mk('div', 'table-log'); for (const l of tableLogLines(v)) lg.appendChild(mk('div', '', l)); box.appendChild(lg);
}
function buildMary(box, v, mk, gd) {
  const playing = v.phase === 'playing', ma = v.ma;
  if (playing && v.role === 'seat') {   // 兌換經驗值按鈕：放在面板「離開（Esc）」的正下方（tableBody 的第一列）
    const bs = mk('div', 'table-btns');
    const b = mk('button', 'ff-btn small', '兌換經驗值');
    b.disabled = !(ma.pot > 0) || !!(S.mary?.chainHold && (S.mary?.spin || ma.lights > 0)) || !!S.mary?.showPlay || !!(S.mary?.dbl && !S.mary.dbl.done);   // 獎池有錢才能兌換；送燈鏈、演出與比倍轉燈中鎖定（每次畫面更新會重建、狀態自動跟上）
    b.onclick = maryExchange;
    bs.appendChild(b);
    box.appendChild(bs);
  }
  if (playing && ma) {
    // 籌碼同步（我的座位）：登入者＝機台上的餘額（Registry 是真相，獎池另計）；訪客＝機台餘額＋獎池（離座時伺服器不代管，靠這裡併回本機）
    if (v.role === 'seat' && typeof ma.chips === 'number') {
      const nv = Math.floor(ma.chips) + (!xpServer() ? Math.floor(ma.pot || 0) : 0);
      if (nv !== S.chips) { S.chips = nv; chipsSave(); if (!$('avatarPanel').classList.contains('hidden')) buildAvatarPanel(); }
    }
    if (!S.mary) S.mary = { pos: ma.last >= 0 ? ma.last : 0, seq: ma.seq, last: ma.last, spin: null, lightsSeq: 0, chainHold: false, chainEnd: 0, chainPot: 0, potShown: ma.pot || 0, showSeq: 0, showPlay: null, showPending: null, lastFrame: 0, dbl: null, jpSeen: ma.jp || 0, jpShown: ma.jp || 0 };
    else if (ma.seq !== S.mary.seq) {   // 伺服器開獎／比倍／領出／兌換了：跑馬燈轉到新的位置（押注保留，再按「開始」照上一次的押注直接再開）
      const spun = ma.last >= 0 && ma.dcard < 0 && ma.rseq === ma.seq;   // 開獎（rseq＝最後一次開獎的 seq，開到同一格也算）才算結果：領出／兌換／比倍也會 ++seq 但不會更新 rseq
      const gambled = !spun && ma.dcard >= 0;   // 比倍：伺服器只在猜大小時把 dcard 設成開出的牌（開獎／領出／兌換都清成 -1）
      S.mary.seq = ma.seq; S.mary.last = ma.last;
      if (spun) S.mary.res = ma.seq;
      if (spun) marySpinTo(ma.last, ma.pot > 0, ma.ring[ma.last] === 'more');   // 只有真的開獎才跑跑馬燈（領出／兌換／比倍不再自動多跑一次：2026-11-19 使用者回饋）
      if (spun && ma.lights > 0) maryChainTick(true);   // 還有燈＝鏈進行中：巡檢每 2 秒確認鏈有在跑，丟包會重送（2026-11-23）
      if (spun && !(ma.lights > 0)) maryChainTick(false);
      if (spun) S.mary.dbl = null;   // 新一注：上一場比倍的亮燈收掉
      else if (gambled) {   // 比倍：先跑 2 秒左右轉燈，燈停了才更新金額（2026-11-22 使用者定）
        S.mary.dbl = { t0: performance.now(), card: ma.dcard, seq: ma.seq, done: false, side: -1 };
        maryArmWatchdog(MARY_DBL_S * 1000 + 8000);   // 轉燈開牌也上看門狗：rAF 停掉照樣會開牌
        S.mary.jpShown = S.mary.jpSeen;   // JP 也凍結在比倍前的值
        S.mary.lastFrame = performance.now();
        if (!S.maryRaf) S.maryRaf = requestAnimationFrame(maryFrame);
      }
      else { S.mary.dbl = null; S.mary.potShown = ma.pot || 0; S.mary.jpShown = ma.jp || 0; }   // 非開獎、非比倍的 seq 變更（領出／兌換）：WIN 直接跟上
      if (spun && ma.ring[ma.last] === 'more') { S.mary.chainHold = true; S.mary.chainPot = S.mary.potShown; maryArmWatchdog(8000); }   // 送燈開始：WIN 凍結在送燈前的值，燈全部跑完再一次顯示（2026-11-18 使用者回饋）；看門狗盯著整條鏈
      S.mary.chainFlash = spun && ma.ring[ma.last] === 'more';   // 開到 ONCE MORE 的瞬間全部的燈一起閃（慶祝）；開始一個一個開就不閃
      if (ma.show && ma.show.seq !== S.mary.showSeq) S.mary.showPending = ma.show;   // 勇者／拉霸演出：等跑馬燈跑完再播
    }
    if (!S.mary.dbl || S.mary.dbl.done) { S.mary.jpSeen = ma.jp || 0; S.mary.jpShown = ma.jp || 0; }   // 平常 JP 跟著伺服器；比倍轉燈中先凍結
  }
  if (!playing) maryStop();
  let status;
  if (playing && v.role === 'seat') status = ma?.lights > 0 ? `送燈中：押注維持，機台自動免費多開 ${ma.lights} 次` : ma?.pot > 0 ? (S.mary?.dbl && !S.mary.dbl.done ? '比倍轉燈中…（燈停才開牌）' : ma.dcard >= 0 ? '比倍中：猜大（8～13）或猜小（1～6），7 是莊家贏' : '有獎金在獎池：先「領出」入袋，或玩「猜大小」比倍') : '點下面的圖案押注，按「開始」轉跑馬燈';
  else if (playing) status = `觀戰中：${v.seats[0]?.name || '玩家'} 正在玩（看得到他的押注與開獎，籌碼餘額只有本人看得到）`;
  else status = v.seats.length < v.min ? '等待玩家入座（單人機台）' : '按「準備」就開始（用籌碼下注）';
  box.appendChild(mk('div', 'table-status' + (playing && v.role === 'seat' ? ' mine' : ''), status));
  // 整台機台都畫在同一張大畫布上（上方 WIN／CREDIT 七段顯示、外圈跑馬燈、中間島主、下方賠率列與控制盤）；點擊用同一套座標判定
  const cv = document.createElement('canvas');
  cv.id = 'maryCanvas'; cv.width = MARY_W * 2; cv.height = MARY_H * 2;   // 內部解析度 ×2，放大後不糊
  cv.className = 'mary-canvas'; cv.style.width = MARY_W + 'px'; cv.style.maxWidth = '100%';
  cv.onclick = e => {
    const r = cv.getBoundingClientRect();
    maryClick((e.clientX - r.left) * MARY_W / r.width, (e.clientY - r.top) * MARY_H / r.height, e.isTrusted);
  };
  box.appendChild(cv);
  maryPaint();   // 建立後先畫一次（不然要等第一次開獎的動畫才會出現畫面）
  if (!maryGlowTimer) maryGlowTimer = setTimeout(maryGlow, 500);   // JP 橫幅閃爍的慢速重畫（maryStop／關面板時清掉）
  const btns = mk('div', 'table-btns');
  if (!playing) {
    if (v.role === 'seat') {
      const me = v.seats[v.me], b = mk('button', 'ff-btn', me.ready ? '取消準備' : '準備');
      b.onclick = () => S.net?.tbl?.({ a: 'ready', v: !me.ready }); btns.appendChild(b);
      const st = mk('button', 'ff-btn small', '改為觀戰'); st.onclick = () => S.net?.tbl?.({ a: 'stand' }); btns.appendChild(st);
    } else if (v.role === 'spec' && v.seats.length < v.max) {
      const b = mk('button', 'ff-btn', '入座'); b.onclick = () => S.net?.tbl?.({ a: 'sit', chips: S.chips }); btns.appendChild(b);   // 小瑪莉：訪客把本機籌碼帶上機台
    }
  }
  box.appendChild(btns);
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
  if (gd?.rules) box.appendChild(mk('div', 'table-rules', gd.rules));
}
// ---- 打磚塊（第二十桌 t20，2026-11-16，使用者要求：畫面右側牆邊、餐飲區下方放一台面向左的機台）：單人、3 條命、一關接一關、分數進排行榜 ----
// 跟彈珠台同一套做法：**物理全在自己這台算**（沒有要跟別人即時共用的球，延遲不影響手感），伺服器只開局、收結算分數；進行中約 8 次／秒送快照 brs（伺服器轉成 tbr）給觀戰者。
// 用滑鼠（或 ← → ／ A D）移動板子，空白／點一下把球發出去；磚塊打光進下一關（球變快、磚塊變硬）。打掉磚塊偶爾掉道具：寬（板子變寬）、多（每顆球變三顆）、慢（球變慢）、命（多一條命）。
// 關卡版面由 seed＋關卡算出（原創版面，不是任何現有遊戲的關卡）；協定與欄位見 notes「和平島與遊戲桌」。
const BRK_W = 480, BRK_H = 540, BRK_HUD = 32, BRK_COLS = 12, BRK_ROWS = 9, BRK_BW = 36, BRK_BH = 16, BRK_PX = 38, BRK_PY = 18, BRK_X0 = 13, BRK_Y0 = 60;
const BRK_PAD_Y = 500, BRK_PAD_H = 10, BRK_PAD_W = 76, BRK_PAD_WIDE = 118, BRK_R = 6, BRK_LIVES = 3, BRK_LIVES_MAX = 5, BRK_KEY_SPD = 560, BRK_DT = 1 / 240, BRK_SNAP_MS = 120, BRK_BALLS_MAX = 27;   // 場上最多幾顆球（快照的 bl 也是這個上限，兩份伺服器的 BR_BALLS_MAX 要一致）
const BRK_ROW_COL = ['#e04848', '#f08030', '#f0c020', '#3cb45a', '#40c8e0', '#3b78e8', '#9a5ad8', '#e868a8', '#b8c4dc'];
const BRK_DROPS = { W: ['寬', '#3b78e8'], M: ['多', '#e08a20'], S: ['慢', '#3cb45a'], L: ['命', '#e04848'] };
const brkSpeed = lv => Math.min(640, 330 + 28 * (lv - 1));   // 第 lv 關的球速（px／秒）（2026-11-21 使用者說沒難度：原本 290＋22／關、上限 520）
const brkPadW = lv => Math.max(48, BRK_PAD_W - 4 * (lv - 1));   // 第 lv 關的板子寬度：每關窄 4px、最窄 48（寬板道具是它的 1.5 倍）
const brkRally = B => 1 + Math.min(.3, (B.rally || 0) * .015);   // 這顆球發出後板子每接一次，球速 +1.5%、最多 +30%（掉球換新球就歸零）
function brkLevel(seed, lv) {   // 第 lv 關的磚塊（每格的耐打次數 0～3）：五種版面輪流，左右對稱；關卡越後面排數越多、越硬
  const R = mulberry32((seed + lv * 7919) >>> 0), m = new Uint8Array(BRK_COLS * BRK_ROWS), rows = Math.min(BRK_ROWS, 6 + Math.floor(lv / 3)), kind = (lv - 1) % 5;
  for (let r = 0; r < rows; r++) for (let c = 0; c < BRK_COLS / 2; c++) {
    let on = true;
    if (kind === 1) on = (r + c) % 2 === 0;                    // 棋盤
    else if (kind === 2) on = c >= Math.max(0, 5 - r);         // 倒金字塔（上窄下寬）
    else if (kind === 3) on = c % 3 !== 2;                     // 直條
    else if (kind === 4) on = Math.abs(c - 2.5) + Math.abs(r - (rows - 1) / 2) < 4.2;   // 兩顆菱形
    if (on && lv > 1 && kind !== 1 && R() < .07) on = false;   // 隨機挖幾個洞
    if (!on) continue;
    const hp = Math.max(1, Math.min(3, 1 + Math.floor((lv - 1) / 2) + (r < 2 ? 1 : 0) - (R() < .25 ? 1 : 0)));
    m[r * BRK_COLS + c] = hp; m[r * BRK_COLS + (BRK_COLS - 1 - c)] = hp;
  }
  return m;
}
function brkNewBall(B) {   // 一顆黏在板子上的新球；板子、道具效果歸零
  B.balls = [{ x: B.pad.x, y: BRK_PAD_Y - BRK_R, vx: 0, vy: 0, stuck: true }];
  B.drops = []; B.wideT = 0; B.slowT = 0; B.combo = 0; B.pad.w = brkPadW(B.lv || 1); B.rally = 0;
}
function brkMake(v) {
  const z = v.br, me = v.role === 'seat';
  const B = {
    key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), seed: z.seed, role: me ? 'seat' : 'spec', over: false,
    lives: BRK_LIVES, score: 0, lv: 1, bricks: brkLevel(z.seed, 1), pad: { x: BRK_W / 2, w: brkPadW(1) }, balls: [], drops: [], wideT: 0, slowT: 0, combo: 0,
    mx: null, keys: { l: 0, r: 0 }, note: null, snap: null, snapAt: 0, last: performance.now(), acc: 0, rnd: mulberry32((z.seed ^ 0x5bd1e995) >>> 0),
  };
  brkNewBall(B); return B;
}
function brkStart(v) { brkStop(); S.brk = brkMake(v); S.brkRaf = requestAnimationFrame(brkFrame); }
function brkStop() { S.brk = null; if (S.brkRaf) { cancelAnimationFrame(S.brkRaf); S.brkRaf = 0; } }
const brkNow = B => (Date.now() + B.off - B.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function brkLaunch(B) {   // 把黏在板子上的球發出去（稍微偏一點，不要直上直下）
  if (B.role !== 'seat' || B.over || brkNow(B) < 0) return;
  for (const b of B.balls) if (b.stuck) { const a = (B.rnd() - .5) * .7, s = brkSpeed(B.lv); b.stuck = false; b.vx = Math.sin(a) * s; b.vy = -Math.cos(a) * s; }
}
function brkKey(e, down) {   // 打磚塊的按鍵：← A／→ D 移動板子，空白 ↑ W 發球（回 true＝已處理）
  const B = S.brk, v = S.tableView; if (!B || !v || v.game !== 'breakout' || B.role !== 'seat') return false;
  const k = e.key.toLowerCase(), l = k === 'arrowleft' || k === 'a', r = k === 'arrowright' || k === 'd', go = k === ' ' || k === 'arrowup' || k === 'w';
  if (!l && !r && !go) return false;
  e.preventDefault();
  if (l) B.keys.l = down ? 1 : 0; if (r) B.keys.r = down ? 1 : 0; if (go && down) brkLaunch(B);
  return true;
}
function brkNote(B, t) { B.note = { t, until: performance.now() + 1600 }; }
function brkDrop(B, x, y) {   // 打掉磚塊：8% 掉道具（2026-11-21 使用者說沒難度：原本 12%；命比較少見，滿命時不掉）
  if (B.rnd() >= .08) return;
  const r = B.rnd(), k = r < .35 ? 'W' : r < .65 ? 'M' : r < .9 ? 'S' : 'L';
  if (k === 'L' && B.lives >= BRK_LIVES_MAX) return;
  B.drops.push({ x, y, k });
}
function brkTake(B, k) {   // 板子接到道具
  if (k === 'W') { B.wideT = 12; B.pad.w = Math.round(brkPadW(B.lv) * 1.5); brkNote(B, '板子變寬！'); }
  else if (k === 'S') { B.slowT = 8; brkNote(B, '球變慢！'); }
  else if (k === 'L') { B.lives = Math.min(BRK_LIVES_MAX, B.lives + 1); brkNote(B, '多一條命！'); }
  else if (k === 'M') {
    // 倍數成長（2026-11-16 使用者要求）：場上**每一顆**球都分裂成三顆（3 顆 → 9 顆），上限 BRK_BALLS_MAX；原本只多兩顆、最多 3 顆
    const s = brkSpeed(B.lv);
    for (const b of B.balls) if (b.stuck) { b.stuck = false; b.vx = 0; b.vy = -s; }
    for (const src of B.balls.slice()) for (const d of [-.45, .45]) {
      if (B.balls.length >= BRK_BALLS_MAX) break;
      const a = Math.atan2(src.vx, -src.vy) + d;   // 原本的方向往兩邊各偏一點
      B.balls.push({ x: src.x, y: src.y, vx: Math.sin(a) * s, vy: -Math.cos(a) * s, stuck: false });
    }
    brkNote(B, `多球 ×3！`);
  }
  B.score += 20;
}
function brkHitBricks(B, b) {   // 球撞磚塊（一小步最多撞一塊）：回 true＝撞到
  const c0 = Math.max(0, Math.floor((b.x - BRK_R - BRK_X0) / BRK_PX)), c1 = Math.min(BRK_COLS - 1, Math.floor((b.x + BRK_R - BRK_X0) / BRK_PX));
  const r0 = Math.max(0, Math.floor((b.y - BRK_R - BRK_Y0) / BRK_PY)), r1 = Math.min(BRK_ROWS - 1, Math.floor((b.y + BRK_R - BRK_Y0) / BRK_PY));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const i = r * BRK_COLS + c; if (!B.bricks[i]) continue;
    const bx = BRK_X0 + c * BRK_PX, by = BRK_Y0 + r * BRK_PY;
    const nx = Math.max(bx, Math.min(bx + BRK_BW, b.x)), ny = Math.max(by, Math.min(by + BRK_BH, b.y)), dx = b.x - nx, dy = b.y - ny, d2 = dx * dx + dy * dy;
    if (d2 >= BRK_R * BRK_R) continue;
    if (d2 < 1e-6) {   // 球心在磚塊裡：照進來的方向退回去
      if (Math.abs(b.vx) > Math.abs(b.vy)) { b.x = b.vx > 0 ? bx - BRK_R : bx + BRK_BW + BRK_R; b.vx = -b.vx; } else { b.y = b.vy > 0 ? by - BRK_R : by + BRK_BH + BRK_R; b.vy = -b.vy; }
    } else {
      const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
      b.x = nx + ux * BRK_R; b.y = ny + uy * BRK_R;
      if (Math.abs(ux) > Math.abs(uy)) b.vx = Math.abs(b.vx) * Math.sign(ux); else b.vy = Math.abs(b.vy) * Math.sign(uy);
    }
    if (--B.bricks[i] === 0) { B.combo = Math.min(20, B.combo + 1); B.score += 10 + 5 * (B.lv - 1) + B.combo * 2; brkDrop(B, bx + BRK_BW / 2, by + BRK_BH / 2); }
    else B.score += 5;
    return true;
  }
  return false;
}
function brkStep(B, dt) {   // 往前模擬 dt 秒（只有自己的局）
  const pad = B.pad, kx = B.keys.r - B.keys.l;
  if (kx) { pad.x += kx * BRK_KEY_SPD * dt; B.mx = null; } else if (B.mx != null) pad.x = B.mx;
  if (B.wideT > 0 && (B.wideT -= dt) <= 0) pad.w = brkPadW(B.lv);
  if (B.slowT > 0) B.slowT -= dt;
  pad.x = Math.max(pad.w / 2, Math.min(BRK_W - pad.w / 2, pad.x));
  const s = brkSpeed(B.lv) * brkRally(B) * (B.slowT > 0 ? .65 : 1);
  for (const b of B.balls) {
    if (b.stuck) { b.x = pad.x; b.y = BRK_PAD_Y - BRK_R; continue; }
    const sp = Math.hypot(b.vx, b.vy) || 1; b.vx *= s / sp; b.vy *= s / sp;
    if (Math.abs(b.vy) < s * .3) { b.vy = (b.vy < 0 ? -1 : 1) * s * .3; b.vx = Math.sign(b.vx || 1) * Math.sqrt(s * s - b.vy * b.vy); }   // 不要幾乎水平地來回彈
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.x < BRK_R) { b.x = BRK_R; b.vx = Math.abs(b.vx); }
    if (b.x > BRK_W - BRK_R) { b.x = BRK_W - BRK_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BRK_HUD + BRK_R) { b.y = BRK_HUD + BRK_R; b.vy = Math.abs(b.vy); }
    if (b.vy > 0 && b.y + BRK_R >= BRK_PAD_Y && b.y - BRK_R <= BRK_PAD_Y + BRK_PAD_H && Math.abs(b.x - pad.x) <= pad.w / 2 + BRK_R) {   // 板子：打到越旁邊彈得越斜
      const a = Math.max(-1, Math.min(1, (b.x - pad.x) / (pad.w / 2))) * 1.05;
      b.y = BRK_PAD_Y - BRK_R; b.vx = Math.sin(a) * s; b.vy = -Math.cos(a) * s; B.combo = 0; B.rally = (B.rally || 0) + 1;
    }
    brkHitBricks(B, b);
  }
  B.balls = B.balls.filter(b => b.y < BRK_H + BRK_R * 2);
  for (const d of B.drops) {
    d.y += 130 * dt;
    if (!d.got && d.y + 8 >= BRK_PAD_Y && d.y - 8 <= BRK_PAD_Y + BRK_PAD_H && Math.abs(d.x - pad.x) <= pad.w / 2 + 12) { d.got = true; brkTake(B, d.k); }
  }
  B.drops = B.drops.filter(d => !d.got && d.y < BRK_H + 12);
  if (!B.balls.length) {   // 球全掉了：少一條命
    if (--B.lives <= 0) { B.lives = 0; B.over = true; brkSnap(B, true); tblFinal({ a: 'over', sc: Math.min(99999999, Math.round(B.score)), lv: B.lv }); return; }
    brkNewBall(B); brkNote(B, `剩 ${B.lives} 條命`);
  } else if (!B.bricks.some(h => h > 0)) {   // 磚塊打光：下一關
    B.score += 300 * B.lv; B.lv++; B.bricks = brkLevel(B.seed, B.lv); brkNewBall(B); brkNote(B, `第 ${B.lv} 關`);
  }
}
function brkSnap(B, force) {   // 自己的局：快照給觀戰者
  const now = performance.now();
  if (!force && now - B.snapAt < BRK_SNAP_MS) return;
  B.snapAt = now;
  const bl = []; for (const b of B.balls.slice(0, BRK_BALLS_MAX)) bl.push(Math.round(b.x), Math.round(b.y));
  S.net?.tbl?.({ a: 'brs', bl, p: Math.round(B.pad.x), pw: B.pad.w, sc: Math.min(99999999, Math.round(B.score)), b: Math.max(0, Math.min(9, B.lives)), lv: B.lv, m: Array.from(B.bricks).join('') });
}
function brkApplySnap(B, m) {   // 觀戰者：套用快照（球和板子平滑追過去）
  B.snap = m; B.score = m.sc; B.lives = m.b; B.lv = m.lv; B.pad.w = m.pw;
  for (let i = 0; i < B.bricks.length; i++) B.bricks[i] = +m.m[i] || 0;
  const n = m.bl.length / 2;
  while (B.balls.length < n) B.balls.push({ x: m.bl[B.balls.length * 2], y: m.bl[B.balls.length * 2 + 1], vx: 0, vy: 0 });
  B.balls.length = n;
}
function brkAdvance(B, dt) {   // 每一幀：自己的局跑物理＋送快照；旁觀的局讓球和板子追上最新快照
  if (B.role === 'seat') {
    if (brkNow(B) >= 0 && !B.over) { B.acc += dt; let n = 0; while (B.acc >= BRK_DT && n++ < 20 && !B.over) { brkStep(B, BRK_DT); B.acc -= BRK_DT; } if (n >= 20) B.acc = 0; if (!B.over) brkSnap(B, false); }
    else B.acc = 0;
  } else if (B.snap) {
    const a = 1 - Math.exp(-dt * 18), m = B.snap;
    B.pad.x += (m.p - B.pad.x) * a;
    B.balls.forEach((b, i) => { b.x += (m.bl[i * 2] - b.x) * a; b.y += (m.bl[i * 2 + 1] - b.y) * a; });
  }
}
function brkFrame() {
  const B = S.brk, v = S.tableView;
  if (!B || !S.tableOpen || !v || v.game !== 'breakout') { S.brkRaf = 0; return; }
  S.brkRaf = requestAnimationFrame(brkFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - B.last) / 1000)); B.last = now;
  brkAdvance(B, dt);
  brkDraw(B, $('brkCanvas'), brkNow(B));
}
function brkDraw(B, cv, t) {
  if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now();
  g.fillStyle = '#0c1424'; g.fillRect(0, 0, BRK_W, BRK_H);
  g.fillStyle = '#101c34'; for (let y = BRK_HUD + 14; y < BRK_H; y += 28) for (let x = 14 + (y / 28 % 2) * 14; x < BRK_W; x += 28) g.fillRect(x, y, 2, 2);   // 背景的小點
  g.fillStyle = '#16203a'; g.fillRect(0, 0, BRK_W, BRK_HUD);
  g.font = 'bold 15px "Microsoft JhengHei"'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#ffe08a'; g.fillText(`${Math.round(B.score)} 分`, 10, BRK_HUD / 2);
  g.textAlign = 'center'; g.fillStyle = '#b8c4dc'; g.fillText(`第 ${B.lv} 關`, BRK_W / 2, BRK_HUD / 2);
  for (let i = 0; i < B.lives; i++) { g.fillStyle = '#e8e8f0'; g.fillRect(BRK_W - 26 - i * 24, BRK_HUD / 2 - 3, 18, 6); }   // 剩幾條命（小板子）
  for (let r = 0; r < BRK_ROWS; r++) for (let c = 0; c < BRK_COLS; c++) {
    const hp = B.bricks[r * BRK_COLS + c]; if (!hp) continue;
    const x = BRK_X0 + c * BRK_PX, y = BRK_Y0 + r * BRK_PY;
    g.fillStyle = BRK_ROW_COL[r % BRK_ROW_COL.length]; g.fillRect(x, y, BRK_BW, BRK_BH);
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x, y, BRK_BW, 3);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x, y + BRK_BH - 3, BRK_BW, 3);
    if (hp >= 2) { g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.5; g.strokeRect(x + 3.5, y + 3.5, BRK_BW - 7, BRK_BH - 7); }   // 要打 2 下：白框
    if (hp >= 3) { g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(x + BRK_BW / 2 - 4, y + BRK_BH / 2 - 2, 8, 4); }                     // 要打 3 下：再加一顆鉚釘
  }
  for (const d of B.drops) {   // 掉落中的道具
    const [ch, col] = BRK_DROPS[d.k];
    g.fillStyle = col; g.beginPath(); g.arc(d.x, d.y, 10, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 11px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillText(ch, d.x, d.y + 1);
  }
  const p = B.pad;   // 板子
  g.fillStyle = B.wideT > 0 ? '#6aa0ff' : '#e8e8f0'; g.fillRect(p.x - p.w / 2, BRK_PAD_Y, p.w, BRK_PAD_H);
  g.fillStyle = '#e04848'; g.fillRect(p.x - p.w / 2, BRK_PAD_Y, 8, BRK_PAD_H); g.fillRect(p.x + p.w / 2 - 8, BRK_PAD_Y, 8, BRK_PAD_H);
  g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(p.x - p.w / 2, BRK_PAD_Y, p.w, 2);
  for (const b of B.balls) {
    g.fillStyle = B.slowT > 0 ? '#9af0b0' : '#ffffff'; g.beginPath(); g.arc(b.x, b.y, BRK_R, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,.2)'; g.beginPath(); g.arc(b.x + 1.5, b.y + 1.5, BRK_R - 3, 0, Math.PI * 2); g.fill();
  }
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t));
  else if (B.over) msg = '遊戲結束';
  else if (B.note && B.note.until > now) msg = B.note.t;
  else if (B.role === 'seat' && B.balls.some(b => b.stuck)) msg = '空白鍵／點一下發球';
  if (msg) { g.font = 'bold 22px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.fillStyle = '#ffe08a'; g.strokeText(msg, BRK_W / 2, 330); g.fillText(msg, BRK_W / 2, 330); }
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
}
function buildBreakout(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.br;
  if (playing && z && (!S.brk || S.brk.key !== z.seed + ':' + z.t0)) brkStart(v);
  if (!playing) brkStop();
  const B = S.brk;
  let status;
  if (playing && B) status = B.role === 'seat' ? '打磚塊：滑鼠（或 ← → ／ A D）移動板子，空白鍵／點一下發球' : '觀戰中';
  else status = v.seats.length < v.min ? '等待玩家入座（單人）' : '按「準備」就開始（3 條命，分數進排行榜）';
  box.appendChild(mk('div', 'table-status' + (playing && B?.role === 'seat' ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing) box.appendChild(mk('div', 'table-result', r.text));
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分`);
  if (!playing) {
    const row = mk('div', 'table-seats');
    v.seats.forEach(s => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(seat);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  } else {
    const wrap = mk('div', 'pb-wrap'), cv = document.createElement('canvas');
    cv.id = 'brkCanvas'; cv.width = BRK_W; cv.height = BRK_H; cv.className = 'brk-canvas';
    cv.onmousemove = e => { const b = cv.getBoundingClientRect(); if (S.brk?.role === 'seat') S.brk.mx = (e.clientX - b.left) * cv.width / b.width; };
    cv.onmousedown = e => { if (S.brk) { e.preventDefault(); brkLaunch(S.brk); } };
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
}
function onNetTbr(m) { const B = S.brk; if (B && B.role === 'spec') brkApplySnap(B, m); }   // 觀戰者：玩家那台的快照
// ---- 星球合成（第二十四桌 t24，2026-11-20，使用者要求：做一款類似西瓜遊戲的，隕石→冥王星→月球→火星→地球→海王星→土星→木星→太陽→紅巨星→黑洞）：單人、分數進排行榜 ----
// 跟打磚塊同一套做法：**物理全在自己這台算**，伺服器只開局、收結算分數；進行中約 8 次／秒送快照 pls（伺服器轉成 tpl）給觀戰者（沒有大螢幕轉播）。
// 玩法：從上方左右移動、放下手上的星體；兩顆相同的星體碰在一起就合成下一級（兩顆黑洞碰在一起會一起消失、得大量分數）。
// 星體堆過頂線超過 PL_OVER_S 秒＝結束。掉下來的只會是前 5 級（隕石～地球），順序由 seed 決定。協定與欄位見 notes「和平島與遊戲桌」。
const isPlGame = g => g === 'planet';   // 星球合成（t24：兩台機台，單人或邀請對戰）
const PL_W = 360, PL_H = 600, PL_HUD = 44, PL_L = 20, PL_R = 340, PL_FLOOR = 536, PL_LINE = 104, PL_DROP_Y = 66;
const PL_NAMES = ['', '隕石', '冥王星', '月球', '火星', '地球', '海王星', '土星', '木星', '太陽', '紅巨星', '黑洞'];
const PL_RAD = [0, 12, 17, 22, 27, 33, 39, 46, 53, 61, 69, 78];
const PL_PTS = [0, 0, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121], PL_BH_BONUS = 500;   // 合成出第 k 級的得分；兩顆黑洞碰在一起的額外分數
const PL_G = 900, PL_DT = 1 / 120, PL_CD = .55, PL_OVER_S = 2.2, PL_SNAP_MS = 120, PL_BODIES_MAX = 150, PL_KEY_SPD = 240, PL_PX = 3;
const PL_SCORE_MAX_C = 99999999;
function plHash(x, y, k) { let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
// 每一級星體的點陣圖：以小畫布（每點 PL_PX 像素）畫出來再放大，所以是像素風格；(u, v)＝圓內的座標 -1～1、lit＝打光（0～1）
function plColor(k, u, v, lit, x, y) {
  const r2 = u * u + v * v, n = plHash(x, y, k), sh = c => c.map(a => Math.max(0, Math.min(255, a * (.55 + lit * .65))));
  let c;
  switch (k) {
    case 1: c = n < .12 || (Math.abs(u + .3) < .22 && Math.abs(v - .2) < .2) ? [92, 86, 80] : [150, 142, 132]; if (r2 > .75) c = [118, 110, 102]; break;   // 隕石：灰褐、坑洞
    case 2: c = (Math.hypot(u - .1, v - .1) < .4 && v < .1 + Math.abs(u - .1) * -.1 + .15) ? [236, 214, 190] : (n < .3 ? [150, 118, 96] : [190, 156, 126]); break;   // 冥王星：米白的心形區
    case 3: c = Math.hypot(u + .3, v + .1) < .22 || Math.hypot(u - .35, v - .3) < .28 || Math.hypot(u - .1, v + .5) < .15 ? [132, 132, 142] : [186, 186, 194]; break;   // 月球：灰、環形山
    case 4: c = n < .2 ? [160, 62, 38] : [206, 92, 56]; break;   // 火星：紅橘（不畫白色極冠，會像白邊）
    case 5: { const land = Math.sin(u * 4 + 1) * Math.cos(v * 5) + Math.sin(v * 3 - u * 2) > .55; c = land ? [74, 160, 84] : [52, 112, 212]; break; }   // 地球（不畫白色極冠）
    case 6: c = Math.abs(v - .15) < .12 ? [120, 160, 255] : (n < .1 ? [60, 90, 190] : [48, 78, 200]); break;   // 海王星：深藍、亮帶
    case 7: { const b = Math.sin(v * 9); c = b > .2 ? [232, 206, 140] : [204, 172, 108]; break; }   // 土星（環另外畫）
    case 8: { const b = Math.sin(v * 7 + Math.sin(u * 3) * .6); c = b > .35 ? [224, 206, 172] : b > -.3 ? [214, 150, 90] : [172, 108, 66]; if (Math.hypot(u - .3, v - .35) < .2) c = [190, 70, 50]; break; }   // 木星：橫紋、大紅斑
    case 9: c = n < .15 ? [255, 250, 190] : (r2 > .6 ? [255, 190, 50] : [255, 224, 90]); return c;   // 太陽：自己發亮，不打光
    case 10: c = n < .16 ? [120, 20, 20] : (r2 > .55 ? [200, 50, 30] : [232, 84, 44]); return sh(c).map((a, i) => a * .5 + c[i] * .5);   // 紅巨星
    case 11: { const rim = Math.sqrt(r2); c = rim > .8 ? [150, 90, 230] : rim > .62 ? [60, 30, 110] : [4, 2, 10]; return c; }   // 黑洞：黑心＋紫色邊
    default: c = [200, 200, 200];
  }
  return sh(c);
}
const PL_CACHE = {};
function plSprite(k) {   // 第 k 級的點陣圖（畫一次快取）：cv＝底圖（會跟著星體轉）、ov＝陰影／高光層（不轉，光永遠從左上來）、size＝含光暈／環的邊長（像素）
  if (PL_CACHE[k]) return PL_CACHE[k];
  const r = PL_RAD[k], pad = k === 7 ? Math.round(r * .55) : k >= 9 ? Math.round(r * .3) : 0, n = Math.ceil((r + pad) * 2 / PL_PX), cv = document.createElement('canvas'), ov = document.createElement('canvas');
  cv.width = cv.height = ov.width = ov.height = n; const g = cv.getContext('2d'), go = ov.getContext('2d'), c0 = (n - 1) / 2, rr = r / PL_PX;
  const put = (x, y, c) => { g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; g.fillRect(x, y, 1, 1); };
  if (k >= 9) {   // 太陽／紅巨星／黑洞：外圍一圈光暈
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - c0, y - c0) / rr; if (d <= 1 || d > 1 + pad / r) continue;
      const base = k === 9 ? [255, 180, 40] : k === 10 ? [230, 70, 40] : [170, 110, 255];
      if (plHash(x, y, k + 40) < (k === 11 ? .5 : .35) * (1 - (d - 1) / (pad / r))) put(x, y, base);
    }
  }
  if (k === 7) {   // 土星的環（後半先畫）
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = (x - c0) / (rr * 1.55), dy = (y - c0 - 0) / (rr * .5), d = Math.hypot(dx, dy);
      if (d > .82 && d < 1 && (y - c0) < 0) put(x, y, [210, 184, 120]);
    }
  }
  const lit0 = .75, m0 = .55 + lit0 * .65;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x - c0) / rr, v = (y - c0) / rr; if (u * u + v * v > 1) continue;
    put(x, y, plColor(k, u, v, lit0, x, y));
    if (k >= 9) continue;
    const lit = Math.max(0, Math.min(1, .5 + (-u * .5 - v * .55) * .6)), f = (.55 + lit * .65) / m0;   // 左上亮、右下暗
    const r2 = u * u + v * v, rim = r2 > .7 ? (r2 - .7) / .3 * .38 : 0;   // 邊緣加一圈暗色（淺色的星體才不會像有白邊）
    go.fillStyle = f < 1 || rim ? `rgba(0,0,0,${Math.min(.85, Math.max(0, 1 - f) + rim).toFixed(3)})` : `rgba(255,255,255,${((f - 1) * .6).toFixed(3)})`; go.fillRect(x, y, 1, 1);
  }
  if (k === 7) {   // 環的前半
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = (x - c0) / (rr * 1.55), dy = (y - c0) / (rr * .5), d = Math.hypot(dx, dy);
      if (d > .82 && d < 1 && (y - c0) >= 0) put(x, y, [232, 204, 140]);
    }
  }
  return (PL_CACHE[k] = { cv, ov, size: n * PL_PX });
}
function plRoll(B) { const w = [0, 5, 5, 4, 3, 2], t = w.reduce((a, b) => a + b, 0); let x = B.rnd() * t, k = 1; for (; k < 5; k++) { x -= w[k]; if (x < 0) break; } return k; }   // 掉下來的只有前 5 級，小的比較常出現
function plMake(v) {
  const z = v.pl;
  const B = {
    key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), seed: z.seed, role: 'seat', cab: v.cab, over: false, score: 0, mx: 1,
    bodies: [], cx: (PL_L + PL_R) / 2, cur: 1, nx: 1, cd: 0, danger: 0, mxT: null, keys: { l: 0, r: 0 }, fx: [], note: null,
    snap: null, snapAt: 0, last: performance.now(), acc: 0, rnd: mulberry32((z.seed ^ 0x7f4a7c15) >>> 0),
    vs: !!z.vs, end: null, frozen: false, bh: false, endTimer: 0, banner: null, label: '',
  };
  B.cur = plRoll(B); B.nx = plRoll(B);
  return B;
}
function plMakeSpec() {   // 只靠快照更新的盤面（觀戰者看的、對戰時對手的）
  return { role: 'spec', t0: 0, off: 0, over: false, score: 0, mx: 1, bodies: [], cx: (PL_L + PL_R) / 2, cur: 1, nx: 1, cd: 0, danger: 0, fx: [], note: null, snap: null, last: performance.now(), acc: 0, banner: null, label: '', vs: false, end: null, frozen: false };
}
function plStart(v) { plStopMine(); S.pl = plMake(v); }
function plStopMine() { if (S.pl?.endTimer) clearInterval(S.pl.endTimer); S.pl = null; }   // 只結束自己這一局（畫面還開著、動畫迴圈照跑）
function plStop() { plStopMine(); S.plSpec = {}; if (S.plRaf) { cancelAnimationFrame(S.plRaf); S.plRaf = 0; } }   // 牌桌關掉
const plNow = B => (Date.now() + B.off - B.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function plNote(B, t) { B.note = { t, until: performance.now() + 1600 }; }
function plDrop(B) {   // 放下手上這顆（冷卻中、倒數中、結束後不能放）
  if (B.role !== 'seat' || B.over || B.frozen || plNow(B) < 0 || B.cd > 0) return;
  const k = B.cur, r = PL_RAD[k], x = Math.max(PL_L + r, Math.min(PL_R - r, B.cx));
  B.bodies.push({ k, x, y: PL_DROP_Y, vx: 0, vy: 40, a: Math.random() * Math.PI * 2, w: 0, age: 0, pop: 1 });   // 角度用 Math.random（不影響 seed 決定的掉落順序）
  B.cur = B.nx; B.nx = plRoll(B); B.cd = PL_CD;
}
function plKey(e, down) {   // 星球合成的按鍵：← A／→ D 移動，空白 ↓ S 放下（回 true＝已處理）
  const B = S.pl, v = S.tableView; if (!B || !v || !isPlGame(v.game) || B.role !== 'seat' || B.frozen) return false;
  const k = e.key.toLowerCase(), l = k === 'arrowleft' || k === 'a', r = k === 'arrowright' || k === 'd', go = k === ' ' || k === 'arrowdown' || k === 's';
  if (!l && !r && !go) return false;
  e.preventDefault();
  if (l) B.keys.l = down ? 1 : 0; if (r) B.keys.r = down ? 1 : 0; if (go && down && !e.repeat) plDrop(B);
  return true;
}
function plBlast(B, x, y, R, power, skip) {   // 合成瞬間的衝力：把附近的星體往外彈開（小的被彈得比較遠），順便讓它們轉一下
  for (const o of B.bodies) {
    if (o === skip) continue;
    const ro = PL_RAD[o.k], dx = o.x - x, dy = o.y - y, d = Math.hypot(dx, dy) || 1, gap = Math.max(0, d - R - ro), reach = R * .9;   // gap＝兩者表面的距離（貼著＝0）
    if (gap >= reach) continue;
    const f = 1 - gap / reach, s = f * power * Math.min(1, R / ro);
    o.vx += dx / d * s; o.vy += dy / d * s * .8; o.w += (Math.random() - .5) * 6 * f;
  }
}
function plMerge(B, a, b) {   // 兩顆同級碰在一起：合成下一級（黑洞＝一起消失、變回一顆隕石、加大量分數）
  const ra = PL_RAD[a.k] ** 2, rb = PL_RAD[b.k] ** 2, x = (a.x * ra + b.x * rb) / (ra + rb), y = (a.y * ra + b.y * rb) / (ra + rb);
  B.bodies = B.bodies.filter(o => o !== a && o !== b);
  if (a.k >= 11) {
    B.score += PL_BH_BONUS; B.fx.push({ x, y, k: 11, t: 0, big: 1 }); plNote(B, `黑洞互相吞噬，變回隕石！＋${PL_BH_BONUS}`);
    const m = { k: 1, x, y, vx: 0, vy: 0, a: Math.random() * Math.PI * 2, w: 0, age: Math.max(a.age, b.age), pop: 1 };
    B.bodies.push(m); plBlast(B, x, y, PL_RAD[11], 520, m); return;
  }
  const k = a.k + 1; B.score += PL_PTS[k]; B.mx = Math.max(B.mx, k);
  if (k >= 11 && B.vs && B.role === 'seat') B.bh = true;   // 對戰：先合成出黑洞的人獲勝（這一步結束時回報，畫面停在黑洞出現的當下）
  const m = { k, x, y, vx: (a.vx + b.vx) / 2, vy: (a.vy + b.vy) / 2, a: a.a, w: (a.w + b.w) / 2, age: Math.max(a.age, b.age), pop: 1 };
  B.bodies.push(m); B.fx.push({ x, y, k, t: 0 });
  plBlast(B, x, y, PL_RAD[k], 200 + k * 15, m);
}
function plStep(B, dt) {   // 往前模擬 dt 秒（只有自己的局）
  const bs = B.bodies;
  for (const b of bs) { b.vy += PL_G * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.w * dt; b.w *= 1 - .5 * dt; b.age += dt; if (b.pop > 0) b.pop = Math.max(0, b.pop - dt * 5); }
  for (let it = 0; it < 3; it++) {
    for (const b of bs) {   // 牆與地板
      const r = PL_RAD[b.k];
      if (b.x - r < PL_L) { b.x = PL_L + r; if (b.vx < 0) b.vx *= -.2; }
      if (b.x + r > PL_R) { b.x = PL_R - r; if (b.vx > 0) b.vx *= -.2; }
      if (b.y + r > PL_FLOOR) { b.y = PL_FLOOR - r; if (b.vy > 0) b.vy *= -.15; const slip = b.vx - b.w * r; b.vx -= slip * .5 / 3; b.w += 2 * slip * .5 / (3 * r); }   // 地板：滾動摩擦（不打滑時 w＝vx／r）
    }
    let pair = null;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j], dx = b.x - a.x, dy = b.y - a.y, rs = PL_RAD[a.k] + PL_RAD[b.k], d2 = dx * dx + dy * dy;
      if (d2 >= rs * rs) continue;
      if (a.k === b.k && !pair) { pair = [a, b]; continue; }   // 同級：這一步稍後合成（一步只合一對，避免一堆同時動）
      if (a.k === b.k) continue;
      const d = Math.sqrt(d2) || .001, nx = dx / d, ny = dy / d, ma = PL_RAD[a.k] ** 2, mb = PL_RAD[b.k] ** 2, push = rs - d;
      a.x -= nx * push * mb / (ma + mb); a.y -= ny * push * mb / (ma + mb); b.x += nx * push * ma / (ma + mb); b.y += ny * push * ma / (ma + mb);
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn < 0) {
        const inv = 1 / ma + 1 / mb, j2 = -(1 + .1) * vn / inv, tx = -ny, ty = nx, ra2 = PL_RAD[a.k], rb2 = PL_RAD[b.k];
        const vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty - b.w * rb2 - a.w * ra2;   // 接觸點的相對切向速度（含自轉）
        const jt = Math.max(-.4 * j2, Math.min(.4 * j2, -vt / (3 * inv)));   // 摩擦衝量：同時改變移動與自轉（實心圓盤，轉動慣量 ½mr²）
        a.vx -= (nx * j2 + tx * jt) / ma; a.vy -= (ny * j2 + ty * jt) / ma; b.vx += (nx * j2 + tx * jt) / mb; b.vy += (ny * j2 + ty * jt) / mb;
        a.w -= 2 * jt / (ma * ra2); b.w -= 2 * jt / (mb * rb2);
      }
    }
    if (pair) { plMerge(B, pair[0], pair[1]); break; }
  }
  for (const b of bs) { b.vx *= 1 - 1.2 * dt; if (Math.abs(b.vx) < 2 && b.y + PL_RAD[b.k] >= PL_FLOOR - 1) b.vx = 0; }
  B.cd = Math.max(0, B.cd - dt);
  let top = false; for (const b of bs) if (b.age > 1.3 && b.y - PL_RAD[b.k] < PL_LINE) { top = true; break; }
  B.danger = top ? B.danger + dt : Math.max(0, B.danger - dt * 2);
  for (const f of B.fx) f.t += dt; B.fx = B.fx.filter(f => f.t < .5);
  if (B.bh && !B.over) { B.over = true; plSnap(B, true); tblFinal({ a: 'over', sc: Math.min(PL_SCORE_MAX_C, Math.round(B.score)), mx: 11, bh: true }); return; }   // 對戰：我合成出黑洞了
  if (B.danger >= PL_OVER_S) { B.over = true; plSnap(B, true); tblFinal({ a: 'over', sc: Math.min(PL_SCORE_MAX_C, Math.round(B.score)), mx: Math.max(1, Math.min(11, B.mx)) }); }
}
function plSnap(B, force) {   // 自己的局：快照給觀戰者
  const now = performance.now();
  if (!force && now - B.snapAt < PL_SNAP_MS) return;
  B.snapAt = now;
  const b = []; for (const o of B.bodies.slice(0, PL_BODIES_MAX)) b.push(o.k, Math.round(o.x), Math.round(o.y), Math.round((((o.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) * 180 / Math.PI) % 360);   // [編號, x, y, 角度（度）]
  S.net?.tbl?.({ a: 'pls', b, cur: B.cur, nx: B.nx, cx: Math.round(B.cx), sc: Math.min(PL_SCORE_MAX_C, Math.round(B.score)), mx: Math.max(0, Math.min(11, B.mx)) });
}
function plApplySnap(B, m) {   // 觀戰者：套用快照（同級的星體平滑追過去，不同級就直接換）
  B.snap = m; B.score = m.sc; B.mx = m.mx; B.cur = m.cur; B.nx = m.nx; B.cx = m.cx;
  const n = m.b.length / 4, d2r = Math.PI / 180;
  while (B.bodies.length < n) { const i = B.bodies.length * 4; B.bodies.push({ k: m.b[i], x: m.b[i + 1], y: m.b[i + 2], a: m.b[i + 3] * d2r, pop: 0 }); }
  B.bodies.length = n;
  for (let i = 0; i < n; i++) { const o = B.bodies[i]; if (o.k !== m.b[i * 4]) { o.k = m.b[i * 4]; o.x = m.b[i * 4 + 1]; o.y = m.b[i * 4 + 2]; o.a = m.b[i * 4 + 3] * d2r; o.pop = 1; } }
}
function plAdvance(B, dt) {   // 每一幀：自己的局跑物理＋送快照；旁觀的局讓星體追上最新快照
  if (B.role === 'seat') {
    if (plNow(B) >= 0 && !B.over && !B.frozen) {
      const kx = (B.keys.r - B.keys.l) * PL_KEY_SPD * dt;
      if (kx) { B.cx += kx; B.mx0 = null; } else if (B.mx0 != null) B.cx = B.mx0;
      B.cx = Math.max(PL_L, Math.min(PL_R, B.cx));
      B.acc += dt; let n = 0; while (B.acc >= PL_DT && n++ < 10 && !B.over) { plStep(B, PL_DT); B.acc -= PL_DT; } if (n >= 10) B.acc = 0;
      if (!B.over) plSnap(B, false);
    } else B.acc = 0;
  } else if (B.snap && !B.frozen) {
    const a = 1 - Math.exp(-dt * 18), m = B.snap;
    B.bodies.forEach((o, i) => { o.x += (m.b[i * 4 + 1] - o.x) * a; o.y += (m.b[i * 4 + 2] - o.y) * a; let da = m.b[i * 4 + 3] * Math.PI / 180 - o.a; da -= Math.round(da / (Math.PI * 2)) * Math.PI * 2; o.a += da * a; if (o.pop > 0) o.pop = Math.max(0, o.pop - dt * 5); });
  }
}
function plFrame() {
  const v = S.tableView;
  if (!S.tableOpen || !v || !isPlGame(v.game)) { S.plRaf = 0; return; }
  S.plRaf = requestAnimationFrame(plFrame);
  const B = S.pl, now = performance.now();
  if (B) { const dt = Math.max(0, Math.min(.05, (now - B.last) / 1000)); B.last = now; plAdvance(B, dt); plBanners(B, v); plDraw(B, $('plCanvas'), plNow(B)); }
  for (const cv of document.querySelectorAll('canvas.pl-speccv')) {   // 別台的盤面（對手／觀戰）：靠快照
    const sp = S.plSpec?.[Number(cv.dataset.cab)]; if (!sp) continue;
    const dt = Math.max(0, Math.min(.05, (now - sp.last) / 1000)); sp.last = now; plAdvance(sp, dt); plDraw(sp, cv, 1);
  }
}
function plBanners(B, v) {   // 對戰分出勝負後：自己的盤面停住、跳出勝負訊息與倒數（倒數到了由 endTimer 通知伺服器結算）
  const en = B.end;
  if (!en) return;
  const nm = c => v.seats.find(x => x.cab === c)?.name || '?', lo = c => v.link?.mem?.find(m => m !== c);
  const left = Math.max(0, Math.ceil((en.at - (Date.now() + B.off)) / 1000));
  const win = en.w === B.cab;
  B.banner = { title: win ? '你獲勝！' : '你輸了…', sub: en.why === 'bh' ? `${nm(en.w)} 先合成出黑洞` : `${nm(lo(en.w))} 的星球堆過頂線了`, left, win };
}
function plIcon(g, k, x, y, diam, ang) {   // 在 (x, y) 為中心畫第 k 級星體，直徑約 diam 像素、轉 ang 弧度（陰影層不轉）
  const sp = plSprite(k), w = sp.size * diam / (PL_RAD[k] * 2); g.imageSmoothingEnabled = false;
  if (ang) {   // 轉動時，沒有光暈／環的星體用圓形裁一下，免得點陣轉一個角度後邊緣一格一格的
    g.save(); g.translate(x, y); if (k !== 7 && k < 9) { g.beginPath(); g.arc(0, 0, diam / 2 - 1, 0, Math.PI * 2); g.clip(); }
    g.rotate(ang); g.drawImage(sp.cv, -w / 2, -w / 2, w, w); g.restore();
  } else g.drawImage(sp.cv, x - w / 2, y - w / 2, w, w);
  if (k < 9) g.drawImage(sp.ov, x - w / 2, y - w / 2, w, w);
}
function plDraw(B, cv, t) {
  if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now(); g.imageSmoothingEnabled = false;
  g.fillStyle = '#080a1e'; g.fillRect(0, 0, PL_W, PL_H);
  for (let i = 0; i < 70; i++) { const sx = plHash(i, 1, 3) * PL_W, sy = plHash(i, 2, 3) * PL_H; g.fillStyle = plHash(i, 3, 3) < .2 ? '#8a94d0' : '#3a4270'; g.fillRect(Math.round(sx), Math.round(sy), 2, 2); }   // 星空
  g.fillStyle = '#10163a'; g.fillRect(0, 0, PL_W, PL_HUD);
  g.font = 'bold 16px "Microsoft JhengHei"'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#ffe08a'; g.fillText(`${Math.round(B.score)} 分`, 10, PL_HUD / 2);
  if (B.label) { g.textAlign = 'center'; g.fillStyle = '#9fb0e8'; g.font = 'bold 13px "Microsoft JhengHei"'; g.fillText(B.label, PL_W / 2 - 14, PL_HUD / 2); }
  g.textAlign = 'right'; g.fillStyle = '#b8c4dc'; g.font = '12px "Microsoft JhengHei"'; g.fillText('下一顆', PL_W - 58, PL_HUD / 2); plIcon(g, B.nx, PL_W - 30, PL_HUD / 2, Math.min(30, PL_RAD[B.nx] * 2));
  g.fillStyle = '#141a40'; g.fillRect(PL_L, PL_HUD, PL_R - PL_L, PL_FLOOR - PL_HUD);   // 容器
  g.fillStyle = '#6a78c8'; g.fillRect(PL_L - 4, PL_HUD, 4, PL_FLOOR - PL_HUD + 4); g.fillRect(PL_R, PL_HUD, 4, PL_FLOOR - PL_HUD + 4); g.fillRect(PL_L - 4, PL_FLOOR, PL_R - PL_L + 8, 4);
  const warn = B.danger > 0; g.strokeStyle = warn && Math.floor(now / 160) % 2 ? '#ff5a5a' : 'rgba(255,120,120,.45)'; g.setLineDash([8, 6]); g.lineWidth = 2;
  g.beginPath(); g.moveTo(PL_L, PL_LINE); g.lineTo(PL_R, PL_LINE); g.stroke(); g.setLineDash([]);   // 頂線
  if (B.role === 'seat' && !B.over && t >= 0 && B.cd <= 0) {   // 手上這顆與落點線
    const k = B.cur, r = PL_RAD[k], x = Math.max(PL_L + r, Math.min(PL_R - r, B.cx));
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, PL_DROP_Y + r); g.lineTo(x, PL_FLOOR); g.stroke();
    plIcon(g, k, x, PL_DROP_Y, r * 2);
  } else if (B.role !== 'seat' && B.cur) { const r = PL_RAD[B.cur], x = Math.max(PL_L + r, Math.min(PL_R - r, B.cx)); plIcon(g, B.cur, x, PL_DROP_Y, r * 2); }
  for (const b of B.bodies) {
    const k = b.k, r = PL_RAD[k] * (1 + (b.pop || 0) * .18); plIcon(g, k, b.x, b.y, r * 2, b.a);
  }
  for (const f of B.fx) {   // 合成的光環
    g.strokeStyle = `rgba(255,255,255,${.7 * (1 - f.t / .5)})`; g.lineWidth = 3; g.beginPath(); g.arc(f.x, f.y, PL_RAD[f.k] * (1 + f.t * 1.2), 0, Math.PI * 2); g.stroke();
  }
  g.fillStyle = '#10163a'; g.fillRect(0, PL_FLOOR + 6, PL_W, PL_H - PL_FLOOR - 6);   // 底下的進化順序
  for (let k = 1; k <= 11; k++) { const x = 18 + (k - 1) * 32.4; plIcon(g, k, x, PL_FLOOR + 30, Math.min(24, 8 + k * 2)); if (k < 11) { g.fillStyle = '#4a5490'; g.fillRect(x + 15, PL_FLOOR + 29, 3, 2); } }
  g.font = '12px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillStyle = B.mx >= 1 ? '#8a94d0' : '#5a6490'; g.fillText(B.mx >= 2 ? `目前最大：${PL_NAMES[B.mx]}` : '隕石→冥王星→月球→…→黑洞', PL_W / 2, PL_FLOOR + 56);
  const bn = B.banner;
  if (bn) {   // 對戰分出勝負：停在最後的畫面，蓋上勝負訊息與倒數
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 170, PL_W, bn.small ? 110 : 190);
    g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.9)';
    if (bn.small) { g.font = 'bold 34px "Microsoft JhengHei"'; g.fillStyle = bn.mark === '勝利' ? '#ffe08a' : '#9aa4c8'; g.strokeText(bn.mark, PL_W / 2, 230); g.fillText(bn.mark, PL_W / 2, 230); }
    else {
      g.font = 'bold 34px "Microsoft JhengHei"'; g.fillStyle = bn.win ? '#ffe08a' : '#ff9a9a'; g.strokeText(bn.title, PL_W / 2, 215); g.fillText(bn.title, PL_W / 2, 215);
      g.font = 'bold 16px "Microsoft JhengHei"'; g.fillStyle = '#e8eeff'; g.strokeText(bn.sub, PL_W / 2, 255); g.fillText(bn.sub, PL_W / 2, 255);
      g.font = '15px "Microsoft JhengHei"'; g.fillStyle = '#b8c4dc'; g.fillText(`${bn.left} 秒後回到大廳`, PL_W / 2, 295);
    }
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    return;
  }
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t));
  else if (B.over) msg = B.vs ? '等待結果…' : '遊戲結束';
  else if (B.note && B.note.until > now) msg = B.note.t;
  else if (B.role === 'seat' && B.bodies.length === 0) msg = '滑鼠移動、點一下放下';
  if (msg) { g.font = 'bold 22px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.fillStyle = '#ffe08a'; g.strokeText(msg, PL_W / 2, 250); g.fillText(msg, PL_W / 2, 250); }
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
}
function buildPlanet(box, v, mk, gd) {
  const me = v.role === 'seat' ? v.seats[v.me] : null, lk = v.link, playing = v.phase === 'playing', z = v.pl;
  const cabName = c => `${c + 1} 號機`, nameOf = c => v.seats.find(x => x.cab === c)?.name || cabName(c);
  if (playing && z && (!S.pl || S.pl.key !== z.seed + ':' + z.t0)) plStart(v);
  if (!playing) plStopMine();
  if (!S.plRaf) S.plRaf = requestAnimationFrame(plFrame);
  const B = S.pl, end = lk?.phase === 'playing' ? lk.end : null;   // end＝對戰分出勝負（兩邊停住、倒數 10 秒）
  if (B && B.vs && end && !B.end) {
    B.end = end; B.frozen = true;
    B.endTimer = setInterval(() => { if (S.pl !== B) { clearInterval(B.endTimer); return; } if (Date.now() + B.off >= B.end.at) S.net?.tbl?.({ a: 'timeout' }); }, 1000);   // 10 秒到了就通知伺服器結算（不靠畫面的動畫迴圈；到了之後每秒補送，直到畫面離開對戰）
  }
  // 別台的盤面：自己在對戰＝只看對手；自己沒在玩（觀戰／閒置）＝每台正在玩的機台
  const shown = B ? (B.vs && lk ? lk.mem.filter(c => c !== v.cab) : []) : v.seats.filter(x => x.play && x.cab !== v.cab).map(x => x.cab);
  S.plSpec ||= {};
  for (const c of Object.keys(S.plSpec)) if (!v.seats.some(x => x.play && x.cab === Number(c))) delete S.plSpec[c];
  for (const c of shown) {
    const sp = (S.plSpec[c] ||= plMakeSpec());
    sp.label = nameOf(c); sp.frozen = !!end; sp.banner = end ? { small: true, mark: end.w === c ? '勝利' : '落敗' } : null;
  }
  let status;
  if (!me) status = '觀戰中（要玩的話，走到空著的機台按 F）';
  else if (playing) status = B?.vs ? '星球合成對戰：先合成出黑洞的人獲勝，先堆過頂線的人落敗！' : '星球合成：滑鼠（或 ← →／A D）移動，空白鍵／點一下放下；兩顆相同的會合成下一級';
  else if (me.st === 'link') status = lk.host === me.cab ? '你發起了對戰邀請，等另一台的人接受' : `已接受 ${nameOf(lk.host)} 的邀請，等他按開始`;
  else status = `${cabName(me.cab)}：選擇單人模式或發起對戰邀請`;
  if (!me && end) status = `${nameOf(end.w)} 獲勝！（${end.why === 'bh' ? '先合成出黑洞' : '對手先堆過頂線'}）`;
  box.appendChild(mk('div', 'table-status' + (playing && me ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing && r.link && (me ? r.cabs?.includes(me.cab) : true)) box.appendChild(mk('div', 'table-result', r.text));
  if (me && !playing && me.last && me.st === 'idle' && !(r?.link && r.cabs?.includes(me.cab))) box.appendChild(mk('div', 'table-result', `上一局（單人）：${me.last.sc} 分`));
  if (!playing) { boardBlock(box, v, mk, sc => `${sc} 分`); boardBlock(box, v, mk, sc => `${sc} 勝`, 'board2', '⚔ 對戰排行榜（勝場數前三名）'); }
  // 邀請：我閒置中、有人在等對戰、還有位子、我沒拒絕過
  if (me && me.st === 'idle' && lk?.phase === 'invite' && lk.mem.length < 2 && !lk.no.includes(me.cab)) {
    const inv = mk('div', 'ar-invite');
    inv.appendChild(mk('div', null, `${nameOf(lk.host)}（${cabName(lk.host)}）發起了對戰邀請`));
    inv.appendChild(mk('div', 'ar-invite-q', '要接受對戰邀請嗎？（先合成出黑洞，或對手先堆過頂線的人獲勝）'));
    const bs = mk('div', 'table-btns');
    const yes = mk('button', 'ff-btn', '接受'); yes.onclick = () => S.net?.tbl?.({ a: 'ljoin' });
    const no = mk('button', 'ff-btn small', '拒絕'); no.onclick = () => S.net?.tbl?.({ a: 'lno' });
    bs.appendChild(yes); bs.appendChild(no); inv.appendChild(bs); box.appendChild(inv);
  }
  if (me && me.st === 'link' && lk?.phase === 'invite') {   // 對戰等待室
    const room = mk('div', 'ar-room');
    room.appendChild(mk('div', 'table-label', `對戰成員（${lk.mem.length}/2）`));
    const row = mk('div', 'table-seats');
    for (const c of lk.mem) {
      const seat = mk('div', 'table-seat' + (c === me.cab ? ' you' : ''));
      seat.appendChild(mk('div', 'table-name', nameOf(c) + (c === me.cab ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', cabName(c) + (c === lk.host ? ' · 發起人' : '')));
      row.appendChild(seat);
    }
    room.appendChild(row);
    const bs = mk('div', 'table-btns');
    if (lk.host === me.cab) {
      const st = mk('button', 'ff-btn', lk.mem.length < 2 ? '開始（要有對手接受）' : '開始對戰'); st.disabled = lk.mem.length < 2; st.onclick = () => S.net?.tbl?.({ a: 'lstart' }); bs.appendChild(st);
      const cc = mk('button', 'ff-btn small', '取消邀請'); cc.onclick = () => S.net?.tbl?.({ a: 'lquit' }); bs.appendChild(cc);
    } else {
      const q = mk('button', 'ff-btn small', '退出對戰'); q.onclick = () => S.net?.tbl?.({ a: 'lquit' }); bs.appendChild(q);
    }
    room.appendChild(bs);
    room.appendChild(mk('div', 'table-tag', '對戰：兩人同一串隕石、即時看到對方的盤面；先合成出黑洞的人獲勝，有人先堆過頂線就是對手獲勝。勝負出來後畫面停 10 秒再回大廳。'));
    box.appendChild(room);
  }
  if (me && me.st === 'idle') {   // 選模式
    const bs = mk('div', 'table-btns');
    const solo = mk('button', 'ff-btn', '單人模式'); solo.onclick = () => S.net?.tbl?.({ a: 'solo' }); bs.appendChild(solo);
    const link = mk('button', 'ff-btn', '發起對戰邀請'); link.disabled = !!lk; link.title = lk ? '已經有一場對戰了（同時只能有一場）' : '邀請另一台機台的人對戰';
    link.onclick = () => S.net?.tbl?.({ a: 'link' }); bs.appendChild(link);
    box.appendChild(bs);
  }
  if (B || shown.length) {   // 遊戲畫面：自己的盤面＋對手（或各台）的小盤面
    const wrap = mk('div', 'pb-wrap' + (shown.length ? ' pl-vs' : ''));
    if (B) {
      const cv = document.createElement('canvas');
      cv.id = 'plCanvas'; cv.width = PL_W; cv.height = PL_H; cv.className = 'pl-canvas' + (shown.length ? ' pl-half' : '');
      cv.onmousemove = e => { const b = cv.getBoundingClientRect(); if (S.pl) S.pl.mx0 = (e.clientX - b.left) * cv.width / b.width; };
      cv.onmousedown = e => { if (S.pl) { e.preventDefault(); const b = cv.getBoundingClientRect(); S.pl.mx0 = (e.clientX - b.left) * cv.width / b.width; plDrop(S.pl); } };
      wrap.appendChild(cv);
    }
    for (const c of shown) { const c2 = document.createElement('canvas'); c2.width = PL_W; c2.height = PL_H; c2.dataset.cab = c; c2.className = 'pl-canvas pl-speccv pl-half' + (B ? ' pl-opp' : ''); wrap.appendChild(c2); }
    box.appendChild(wrap);
  } else if (!me) box.appendChild(mk('div', 'table-tag', '目前沒有人在玩'));
  if (v.specs) box.appendChild(mk('div', 'table-tag', `${v.specs} 人觀戰中`));
  const log = mk('div', 'table-log');
  for (const l of tableLogLines(v)) log.appendChild(mk('div', l.startsWith('你獲得') ? 'table-xp' : null, l));
  box.appendChild(log);
}
function onNetTpl(m) {   // 快照：另一台（對戰的對手、或觀戰時各台）的盤面，m.cab＝哪一台
  const v = S.tableView; if (!v || !isPlGame(v.game) || !Number.isInteger(m.cab) || (S.pl && S.pl.cab === m.cab)) return;
  const sp = ((S.plSpec ||= {})[m.cab] ||= plMakeSpec());
  if (!sp.frozen) plApplySnap(sp, m);
}
// ---- 泡泡射手（第二十二桌 t22，2026-11-17，使用者要求：畫面右側牆邊、彈珠台下方放一台面向左的機台）：單人、一條命、一關接一關、分數進排行榜 ----
// 跟彈珠台／打磚塊同一套做法：**物理全在自己這台算**（沒有要跟別人即時共用的東西，延遲不影響手感），伺服器只開局、收結算分數；進行中約 8 次／秒送快照 bus（伺服器轉成 tbu）給觀戰者。
// 玩法（原創規則，常見的「泡泡龍」類型）：蜂巢排列的彩色泡泡從上方垂下來，滑鼠（或 ← →）瞄準、空白／↑／W／點一下發射；泡泡碰到牆會反彈，碰到別的泡泡或天花板就黏住；
// 同色 3 個以上連在一起就爆掉，爆掉後沒有連到天花板的泡泡跟著掉下來。連續幾發都沒爆，天花板就多垂下一排；泡泡垂到底線就結束。清光盤面進下一關（排數、顏色變多、垂得更快）。
// 盤面格子：BUB_COLS 欄，第 r 排是否右移半格由 (r + par) & 1 決定（右移的排少一格）；天花板多垂一排時整盤下移一排、par 翻面，所有泡泡的相對位置不變。協定與欄位見 notes「和平島與遊戲桌」。
const BUB_W = 384, BUB_H = 560, BUB_HUD = 32, BUB_R = 16, BUB_DX = 32, BUB_DY = 28, BUB_COLS = 12, BUB_ROWS = 14, BUB_X0 = 16, BUB_Y0 = 48, BUB_LOSE = 12;
const BUB_SX = BUB_W / 2, BUB_SY = 518, BUB_SPD = 900, BUB_DT = 1 / 240, BUB_SNAP_MS = 120, BUB_ANG_MAX = 1.35, BUB_KEY_SPD = 1.7;
const BUB_COL = ['', '#e04848', '#f0c020', '#3cb45a', '#3b78e8', '#9a5ad8', '#40c8e0'];
const bubLim = lv => Math.max(2, 7 - Math.floor((lv + 1) / 2));   // 連續幾發沒爆掉，天花板就垂下一排（2026-11-21 使用者說關卡越後面難度不變：每兩關少一發，第 1～2 關 6 發、第 3～4 關 5 發、第 5～6 關 4 發、第 7～8 關 3 發、第 9 關起 2 發）
const bubOff = (B, r) => ((r + B.par) & 1) * BUB_R;
const bubOk = (B, r, c) => r >= 0 && r < BUB_ROWS && c >= 0 && c < BUB_COLS - ((r + B.par) & 1);
const bubXY = (B, r, c) => [BUB_X0 + c * BUB_DX + bubOff(B, r), BUB_Y0 + r * BUB_DY];
function bubNbrs(B, r, c) {   // 相鄰的六格（只回有效的格子）
  const o = (r + B.par) & 1, out = [];
  for (const [dr, dc] of [[0, -1], [0, 1], [-1, o ? 0 : -1], [-1, o ? 1 : 0], [1, o ? 0 : -1], [1, o ? 1 : 0]]) if (bubOk(B, r + dr, c + dc)) out.push([r + dr, c + dc]);
  return out;
}
function bubLevel(B, seed, lv) {   // 第 lv 關的起始盤面（排數、顏色數隨關卡增加）；回傳顏色數
  B.bag = []; B.dry = {};   // 新的一關：顏色組成變了，洗牌袋與「多久沒出」的計數清掉重來
  const R = mulberry32((seed + lv * 104729) >>> 0), rows = Math.min(9, 5 + Math.floor((lv - 1) / 2)), nc = Math.min(6, 3 + Math.floor((lv + 1) / 2));
  B.g = new Uint8Array(BUB_ROWS * BUB_COLS); B.par = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < BUB_COLS - (r & 1); c++) {
    let col = 1 + Math.floor(R() * nc);
    if (c > 0 && R() < .4) col = B.g[r * BUB_COLS + c - 1]; else if (r > 0 && R() < .25) col = B.g[(r - 1) * BUB_COLS + c];
    B.g[r * BUB_COLS + c] = col;
  }
  return nc;
}
function bubColors(B) {   // 盤面上現有的顏色（新泡泡只會從這裡面挑，不然會發出沒人接得上的顏色）
  const has = new Set(); for (const v of B.g) if (v) has.add(v);
  return has.size ? [...has] : [1, 2, 3, 4];
}
// 下一顆的顏色用「洗牌袋」（2026-11-21 使用者要求：第 8 關起只剩 3 發就垂下一排，純隨機連 10 顆不出某個顏色〔6 色時約 16%〕就只能白白多三排）：
// 袋子裡盤面上現有的每個顏色各一顆、洗牌後依序抽，抽完再裝一袋，所以每個顏色最多隔 2 袋（約 2×顏色數 − 1 顆）一定會出現；袋子裡的顏色已經從盤面消失就跳過。
function bubPick(B) {
  const cs = bubColors(B), bag = (B.bag ||= []);
  for (;;) {
    if (!bag.length) { const a = cs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(B.rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } bag.push(...a); }
    const c = bag.pop();
    if (!cs.includes(c)) continue;
    // 再加一道保險：某個顏色已經連續 cs.length 顆沒出了（袋子洗牌剛好把它排在兩袋的最前最後）就硬插它，最多等 cs.length＋1 顆左右
    const dry = (B.dry ||= {}), need = cs.filter(k => (dry[k] || 0) >= cs.length).sort((x, y) => dry[y] - dry[x])[0];
    const pick = need ?? c;
    if (pick !== c) bag.push(c);
    for (const k of cs) dry[k] = k === pick ? 0 : (dry[k] || 0) + 1;
    return pick;
  }
}
function bubMake(v) {
  const z = v.bu, me = v.role === 'seat';
  const B = {
    key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), seed: z.seed, role: me ? 'seat' : 'spec', over: false,
    score: 0, lv: 1, miss: 0, par: 0, g: null, ang: 0, cur: 1, nx: 1, fly: null, fx: [], mx: null, my: null, keys: { l: 0, r: 0 },
    note: null, snap: null, snapAt: 0, last: performance.now(), acc: 0, rnd: mulberry32((z.seed ^ 0x2545f491) >>> 0), sh: 0,
  };
  bubLevel(B, z.seed, 1); B.cur = bubPick(B); B.nx = bubPick(B); return B;
}
function bubStart(v) { bubStop(); S.bub = bubMake(v); S.bubRaf = requestAnimationFrame(bubFrame); }
function bubStop() { S.bub = null; if (S.bubRaf) { cancelAnimationFrame(S.bubRaf); S.bubRaf = 0; } }
const bubNow = B => (Date.now() + B.off - B.t0) / 1000;   // 開局後的秒數（開局前是負的＝倒數）
function bubNote(B, t) { B.note = { t, until: performance.now() + 1600 }; }
function bubFire(B) {   // 發射現在這顆（飛行中、倒數中、結束後不能發）
  if (B.role !== 'seat' || B.over || bubNow(B) < 0 || B.fly) return;
  const a = B.ang; B.fly = { x: BUB_SX, y: BUB_SY, vx: Math.sin(a) * BUB_SPD, vy: -Math.cos(a) * BUB_SPD, c: B.cur };
  B.cur = B.nx; B.nx = bubPick(B); B.sh++;
}
function bubKey(e, down) {   // 泡泡射手的按鍵：← A／→ D 轉動瞄準，空白 ↑ W 發射（回 true＝已處理）
  const B = S.bub, v = S.tableView; if (!B || !v || v.game !== 'bubble' || B.role !== 'seat') return false;
  const k = e.key.toLowerCase(), l = k === 'arrowleft' || k === 'a', r = k === 'arrowright' || k === 'd', go = k === ' ' || k === 'arrowup' || k === 'w';
  if (!l && !r && !go) return false;
  e.preventDefault();
  if (l) B.keys.l = down ? 1 : 0; if (r) B.keys.r = down ? 1 : 0; if (go && down && !e.repeat) bubFire(B);
  return true;
}
function bubSnapTo(B, x, y) {   // 飛行中的泡泡停下來：黏在最近的空格（要貼著天花板或別的泡泡）；回 [r, c]
  let best = null, bd = 1e9;
  for (let r = 0; r < BUB_ROWS; r++) for (let c = 0; c < BUB_COLS; c++) {
    if (!bubOk(B, r, c) || B.g[r * BUB_COLS + c]) continue;
    const [cx, cy] = bubXY(B, r, c), d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d >= bd) continue;
    if (r > 0 && !bubNbrs(B, r, c).some(([a, b]) => B.g[a * BUB_COLS + b])) continue;
    best = [r, c]; bd = d;
  }
  return best;
}
function bubPlace(B, r, c, col) {   // 放下泡泡 → 結算：爆掉、掉落、天花板下降、結束／過關
  B.g[r * BUB_COLS + c] = col;
  const seen = new Set([r * BUB_COLS + c]), st = [[r, c]];
  while (st.length) { const [a, b] = st.pop(); for (const [p, q] of bubNbrs(B, a, b)) { const k = p * BUB_COLS + q; if (!seen.has(k) && B.g[k] === col) { seen.add(k); st.push([p, q]); } } }
  let popped = 0;
  if (seen.size >= 3) {
    for (const k of seen) { const [x, y] = bubXY(B, Math.floor(k / BUB_COLS), k % BUB_COLS); B.fx.push({ x, y, vx: 0, vy: 0, c: B.g[k], t: 0, pop: 1 }); B.g[k] = 0; }
    popped = seen.size; B.score += 10 * popped + (popped > 3 ? 15 * (popped - 3) : 0);
    const keep = new Set(), q = [];   // 還連著天花板的泡泡
    for (let c2 = 0; c2 < BUB_COLS; c2++) if (bubOk(B, 0, c2) && B.g[c2]) { keep.add(c2); q.push([0, c2]); }
    while (q.length) { const [a, b] = q.pop(); for (const [p, q2] of bubNbrs(B, a, b)) { const k = p * BUB_COLS + q2; if (!keep.has(k) && B.g[k]) { keep.add(k); q.push([p, q2]); } } }
    let fell = 0;
    for (let k = 0; k < B.g.length; k++) if (B.g[k] && !keep.has(k)) { const [x, y] = bubXY(B, Math.floor(k / BUB_COLS), k % BUB_COLS); B.fx.push({ x, y, vx: (B.rnd() - .5) * 120, vy: -60 - B.rnd() * 80, c: B.g[k], t: 0 }); B.g[k] = 0; fell++; }
    if (fell) { B.score += 20 * fell; bubNote(B, `掉落 ${fell} 顆！`); }
    B.miss = 0;
  } else B.miss++;
  if (!B.g.some(Boolean)) {   // 清光：過關
    B.score += 500 * B.lv; B.lv++; B.miss = 0; B.fly = null; bubLevel(B, B.seed, B.lv); B.cur = bubPick(B); B.nx = bubPick(B); bubNote(B, `第 ${B.lv} 關`);
    return;
  }
  if (B.miss >= bubLim(B.lv)) {   // 天花板垂下一排：整盤下移一排、par 翻面，最上面補一排新的
    B.miss = 0; B.g.copyWithin(BUB_COLS, 0, (BUB_ROWS - 1) * BUB_COLS); B.par ^= 1;
    const cs = bubColors(B);
    for (let c2 = 0; c2 < BUB_COLS; c2++) B.g[c2] = bubOk(B, 0, c2) ? cs[Math.floor(B.rnd() * cs.length)] : 0;
    bubNote(B, '天花板下降！');
  }
  const cs = bubColors(B); if (!cs.includes(B.cur)) B.cur = bubPick(B); if (!cs.includes(B.nx)) B.nx = bubPick(B);   // 手上那兩顆的顏色已經沒有了就換掉
  for (let k = BUB_LOSE * BUB_COLS; k < B.g.length; k++) if (B.g[k]) {   // 垂到底線：結束
    B.over = true; B.fly = null; bubSnap(B, true); tblFinal({ a: 'over', sc: Math.min(99999999, Math.round(B.score)), lv: Math.min(999, B.lv) }); return;
  }
}
function bubStep(B, dt) {   // 往前模擬 dt 秒（只有自己的局）
  const kx = B.keys.r - B.keys.l;
  if (kx) { B.ang += kx * BUB_KEY_SPD * dt; B.mx = null; }
  else if (B.mx != null) B.ang = Math.atan2(B.mx - BUB_SX, BUB_SY - B.my);
  B.ang = Math.max(-BUB_ANG_MAX, Math.min(BUB_ANG_MAX, B.ang));
  for (const f of B.fx) { f.t += dt; if (!f.pop) { f.vy += 900 * dt; f.x += f.vx * dt; f.y += f.vy * dt; } }
  B.fx = B.fx.filter(f => f.pop ? f.t < .25 : f.y < BUB_H + 30);
  const f = B.fly; if (!f) return;
  f.x += f.vx * dt; f.y += f.vy * dt;
  if (f.x < BUB_R) { f.x = BUB_R; f.vx = Math.abs(f.vx); } else if (f.x > BUB_W - BUB_R) { f.x = BUB_W - BUB_R; f.vx = -Math.abs(f.vx); }
  let hit = f.y <= BUB_Y0;   // 撞到天花板
  if (!hit) for (let r = 0; r < BUB_ROWS && !hit; r++) for (let c = 0; c < BUB_COLS; c++) {
    if (!bubOk(B, r, c) || !B.g[r * BUB_COLS + c]) continue;
    const [cx, cy] = bubXY(B, r, c);
    if ((cx - f.x) ** 2 + (cy - f.y) ** 2 < (BUB_R * 1.75) ** 2) { hit = true; break; }
  }
  if (!hit) return;
  B.fly = null;
  const cell = bubSnapTo(B, f.x, Math.max(BUB_Y0, f.y));
  if (cell) bubPlace(B, cell[0], cell[1], f.c);
}
function bubSnap(B, force) {   // 自己的局：快照給觀戰者
  const now = performance.now();
  if (!force && now - B.snapAt < BUB_SNAP_MS) return;
  B.snapAt = now;
  S.net?.tbl?.({ a: 'bus', m: Array.from(B.g).join(''), par: B.par, cur: B.cur, nx: B.nx, an: Math.round(B.ang * 1800 / Math.PI), bx: B.fly ? Math.round(B.fly.x) : -1, by: B.fly ? Math.round(B.fly.y) : -1,
    sc: Math.min(99999999, Math.round(B.score)), lv: Math.min(999, B.lv), f: Math.max(0, bubLim(B.lv) - B.miss) });
}
function bubApplySnap(B, m) {   // 觀戰者：套用快照（盤面直接換、瞄準線和飛行中的泡泡平滑追過去）
  const was = B.cur;
  B.snap = m; B.score = m.sc; B.lv = m.lv; B.par = m.par; B.cur = m.cur; B.nx = m.nx; B.f = m.f;
  for (let i = 0; i < B.g.length; i++) B.g[i] = +m.m[i] || 0;
  if (m.bx >= 0) { if (!B.fly) B.fly = { x: m.bx, y: m.by, vx: 0, vy: 0, c: was }; B.fly.tx = m.bx; B.fly.ty = m.by; } else B.fly = null;
}
function bubAdvance(B, dt) {   // 每一幀：自己的局跑物理＋送快照；旁觀的局讓瞄準線和泡泡追上最新快照
  if (B.role === 'seat') {
    if (bubNow(B) >= 0 && !B.over) { B.acc += dt; let n = 0; while (B.acc >= BUB_DT && n++ < 20 && !B.over) { bubStep(B, BUB_DT); B.acc -= BUB_DT; } if (n >= 20) B.acc = 0; if (!B.over) bubSnap(B, false); }
    else B.acc = 0;
  } else if (B.snap) {
    const a = 1 - Math.exp(-dt * 18);
    B.ang += (B.snap.an * Math.PI / 1800 - B.ang) * a;
    if (B.fly) { B.fly.x += (B.fly.tx - B.fly.x) * a; B.fly.y += (B.fly.ty - B.fly.y) * a; }
  }
}
function bubFrame() {
  const B = S.bub, v = S.tableView;
  if (!B || !S.tableOpen || !v || v.game !== 'bubble') { S.bubRaf = 0; return; }
  S.bubRaf = requestAnimationFrame(bubFrame);
  const now = performance.now(), dt = Math.max(0, Math.min(.05, (now - B.last) / 1000)); B.last = now;
  bubAdvance(B, dt);
  bubDraw(B, $('bubCanvas'), bubNow(B));
}
function bubBall(g, x, y, col, a = 1) {   // 一顆泡泡
  g.globalAlpha = a; g.fillStyle = BUB_COL[col]; g.beginPath(); g.arc(x, y, BUB_R - 1, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.arc(x, y, BUB_R - 1, .2, Math.PI - .2); g.lineTo(x, y); g.fill();
  g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(x - 5, y - 5, 4, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, BUB_R - 1, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1;
}
function bubDraw(B, cv, t) {
  if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now();
  const bg = g.createLinearGradient(0, 0, 0, BUB_H); bg.addColorStop(0, '#142a4a'); bg.addColorStop(1, '#0c1830'); g.fillStyle = bg; g.fillRect(0, 0, BUB_W, BUB_H);
  g.fillStyle = '#16203a'; g.fillRect(0, 0, BUB_W, BUB_HUD);
  g.font = 'bold 15px "Microsoft JhengHei"'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#ffe08a'; g.fillText(`${Math.round(B.score)} 分`, 10, BUB_HUD / 2);
  g.textAlign = 'center'; g.fillStyle = '#b8c4dc'; g.fillText(`第 ${B.lv} 關`, BUB_W / 2, BUB_HUD / 2);
  const left = B.role === 'seat' ? Math.max(0, bubLim(B.lv) - B.miss) : (B.f ?? bubLim(B.lv)), lim = bubLim(B.lv);   // 離下一排還有幾發：畫成右上角的小方塊
  for (let i = 0; i < lim; i++) { g.fillStyle = i < left ? (left <= 2 ? '#ff6a5a' : '#e8e8f0') : 'rgba(255,255,255,.18)'; g.fillRect(BUB_W - 14 - i * 12, BUB_HUD / 2 - 5, 8, 10); }
  g.fillStyle = '#243656'; g.fillRect(0, BUB_HUD, BUB_W, BUB_Y0 - BUB_R - BUB_HUD + 2);   // 天花板
  g.strokeStyle = 'rgba(255,90,90,.55)'; g.lineWidth = 1.5; g.setLineDash([6, 6]); const ly = BUB_Y0 + (BUB_LOSE - 1) * BUB_DY + BUB_R;
  g.beginPath(); g.moveTo(0, ly); g.lineTo(BUB_W, ly); g.stroke(); g.setLineDash([]);   // 底線
  for (let r = 0; r < BUB_ROWS; r++) for (let c = 0; c < BUB_COLS; c++) { const col = B.g[r * BUB_COLS + c]; if (col) { const [x, y] = bubXY(B, r, c); bubBall(g, x, y, col); } }
  for (const f of B.fx) { if (f.pop) { g.strokeStyle = BUB_COL[f.c]; g.lineWidth = 2; g.globalAlpha = 1 - f.t / .25; g.beginPath(); g.arc(f.x, f.y, BUB_R - 1 + f.t * 40, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; } else bubBall(g, f.x, f.y, f.c); }
  const a = B.ang, ok = !B.over && t >= 0;   // 瞄準線（碰牆反彈一次）
  if (ok && !B.fly) {
    g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 2; g.setLineDash([3, 8]); g.beginPath();
    let x = BUB_SX, y = BUB_SY, dx = Math.sin(a), dy = -Math.cos(a); g.moveTo(x, y);
    for (let k = 0; k < 2; k++) {
      const tw = dx > 0 ? (BUB_W - BUB_R - x) / dx : dx < 0 ? (BUB_R - x) / dx : 1e9, tt = (BUB_Y0 - y) / dy, s = Math.min(tw, tt);
      x += dx * s; y += dy * s; g.lineTo(x, y); if (s === tt) break; dx = -dx;
    }
    g.stroke(); g.setLineDash([]);
  }
  g.save(); g.translate(BUB_SX, BUB_SY); g.rotate(a); g.fillStyle = '#c8d4f0'; g.fillRect(-4, -34, 8, 34); g.fillStyle = '#8aa0d8'; g.fillRect(-6, -36, 12, 5); g.restore();   // 砲管
  g.fillStyle = '#243656'; g.beginPath(); g.arc(BUB_SX, BUB_SY + 6, 22, Math.PI, 0); g.fill(); g.strokeStyle = '#4a6aa8'; g.lineWidth = 2; g.stroke();
  if (!B.over) { bubBall(g, BUB_SX, BUB_SY, B.cur); g.font = '12px "Microsoft JhengHei"'; g.fillStyle = '#9fb0d8'; g.textAlign = 'center'; g.fillText('下一顆', BUB_SX + 62, BUB_SY + 20); bubBall(g, BUB_SX + 62, BUB_SY, B.nx); }
  if (B.fly) bubBall(g, B.fly.x, B.fly.y, B.fly.c ?? B.cur);
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t));
  else if (B.over) msg = '遊戲結束';
  else if (B.note && B.note.until > now) msg = B.note.t;
  else if (B.role === 'seat' && B.sh === 0) msg = '滑鼠瞄準、點一下發射';
  if (msg) { g.font = 'bold 22px "Microsoft JhengHei"'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.fillStyle = '#ffe08a'; g.strokeText(msg, BUB_W / 2, 440); g.fillText(msg, BUB_W / 2, 440); }
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
}
function buildBubble(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.bu;
  if (playing && z && (!S.bub || S.bub.key !== z.seed + ':' + z.t0)) bubStart(v);
  if (!playing) bubStop();
  const B = S.bub;
  let status;
  if (playing && B) status = B.role === 'seat' ? '泡泡射手：滑鼠（或 ← →）瞄準，空白鍵／點一下發射' : '觀戰中';
  else status = v.seats.length < v.min ? '等待玩家入座（單人）' : '按「準備」就開始（一條命，分數進排行榜）';
  box.appendChild(mk('div', 'table-status' + (playing && B?.role === 'seat' ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing) box.appendChild(mk('div', 'table-result', r.text));
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分`);
  if (!playing) {
    const row = mk('div', 'table-seats');
    v.seats.forEach(s => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(seat);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  } else {
    const wrap = mk('div', 'pb-wrap'), cv = document.createElement('canvas');
    cv.id = 'bubCanvas'; cv.width = BUB_W; cv.height = BUB_H; cv.className = 'bub-canvas';
    cv.onmousemove = e => { const b = cv.getBoundingClientRect(); if (S.bub?.role === 'seat') { S.bub.mx = (e.clientX - b.left) * cv.width / b.width; S.bub.my = (e.clientY - b.top) * cv.height / b.height; } };
    cv.onmousedown = e => { const B2 = S.bub; if (B2) { e.preventDefault(); if (B2.role === 'seat') { cv.onmousemove(e); bubStep(B2, 0); bubFire(B2); } } };
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
}
function onNetTbu(m) { const B = S.bub; if (B && B.role === 'spec') bubApplySnap(B, m); }   // 觀戰者：玩家那台的快照
// ---- 2048（第二十三桌 t23，2026-11-17，使用者要求：泡泡射手下方再放一台）：單人、4×4 滑動合併、分數進排行榜；跟泡泡射手同一套做法 ----
// 玩法全在自己這台算，新方塊由 seed 決定性產生（B.rnd）；伺服器只開局、收結算（分數 sc、最大方塊指數 mx）、把每一步的盤面 tfs 轉成 ttf 給觀戰者與大螢幕。
// 盤面 B.g＝16 格（由左上起一列一列），每格存方塊的指數（0＝空、1＝2、2＝4…）；快照字串 m＝每格一個 base36 字元。合併得分＝合出來的方塊數字；湊出 2048 以後可以繼續玩，無法再移動就結束。
const TF_W = 360, TF_H = 412, TF_HUD = 62, TF_X0 = 20, TF_Y0 = 70, TF_CS = 74, TF_GAP = 8, TF_SNAP_MS = 1000;
const TF_COL = ['#2c3552', '#5b7fb8', '#4f9fc0', '#3fb0a0', '#5cba7a', '#a8c860', '#e0c050', '#f0a840', '#f08850', '#e86a6a', '#c860b0', '#9a5ad8', '#ffe08a', '#ffe08a', '#ffe08a', '#ffe08a', '#ffe08a', '#ffe08a'];   // 配合介面的深藍＋金色：由冷色（小數字）漸層到暖色、紫色（2048）、金色（更大）
const tfNow = B => (Date.now() + B.off - B.t0) / 1000;
function tfMake(v) {
  const z = v.tf, me = v.role === 'seat';
  const B = { key: z.seed + ':' + z.t0, t0: z.t0, off: z.sn - Date.now(), role: me ? 'seat' : 'spec', over: false, g: new Uint8Array(16), score: 0, mx: 1,
    rnd: mulberry32((z.seed ^ 0x6a09e667) >>> 0), pop: new Float64Array(16), moves: 0, won: false, note: null, snapAt: 0, last: performance.now(), swipe: null };
  tfSpawn(B); tfSpawn(B); B.mx = Math.max(...B.g); return B;
}
function tfStart(v) { tfStop(); S.tf = tfMake(v); S.tfRaf = requestAnimationFrame(tfFrame); }
function tfStop() { S.tf = null; if (S.tfRaf) { cancelAnimationFrame(S.tfRaf); S.tfRaf = 0; } }
function tfSpawn(B) {   // 在空格補一個新方塊（90% 是 2、10% 是 4）
  const e = []; for (let i = 0; i < 16; i++) if (!B.g[i]) e.push(i);
  if (!e.length) return;
  const i = e[Math.floor(B.rnd() * e.length)]; B.g[i] = B.rnd() < .9 ? 1 : 2; B.pop[i] = performance.now();
}
function tfCanMove(B) {
  for (let i = 0; i < 16; i++) { if (!B.g[i]) return true; const r = i >> 2, c = i & 3; if ((c < 3 && B.g[i + 1] === B.g[i]) || (r < 3 && B.g[i + 4] === B.g[i])) return true; }
  return false;
}
function tfMove(B, d) {   // d：0 左、1 右、2 上、3 下；回 true＝有動
  if (B.role !== 'seat' || B.over || tfNow(B) < 0) return false;
  const g = B.g, ng = new Uint8Array(16), merged = []; let gain = 0, moved = false;
  for (let l = 0; l < 4; l++) {
    const idx = []; for (let k = 0; k < 4; k++) idx.push(d === 0 ? l * 4 + k : d === 1 ? l * 4 + 3 - k : d === 2 ? k * 4 + l : (3 - k) * 4 + l);
    const vals = idx.map(i => g[i]).filter(x => x), out = [];
    for (let k = 0; k < vals.length; k++) { if (k + 1 < vals.length && vals[k] === vals[k + 1]) { out.push([vals[k] + 1, true]); gain += 2 ** (vals[k] + 1); k++; } else out.push([vals[k], false]); }
    out.forEach(([x, m], k) => { ng[idx[k]] = x; if (m) merged.push(idx[k]); });
  }
  for (let i = 0; i < 16; i++) if (ng[i] !== g[i]) { moved = true; break; }
  if (!moved) return false;
  B.g = ng; B.score += gain; B.moves++;
  const now = performance.now(); for (const i of merged) B.pop[i] = now;
  tfSpawn(B);
  B.mx = Math.max(B.mx, ...B.g);
  if (!B.won && B.mx >= 11) { B.won = true; B.note = { t: '2048！可以繼續玩', until: now + 2200 }; }
  if (!tfCanMove(B)) { B.over = true; tfSnap(B, true); tblFinal({ a: 'over', sc: Math.min(TF_SCORE_MAX_C, Math.round(B.score)), mx: Math.min(17, B.mx) }); return true; }
  tfSnap(B, true); return true;
}
const TF_SCORE_MAX_C = 99999999;
function tfKey(e, down) {   // 2048 的按鍵：方向鍵／WASD（回 true＝已處理）
  const B = S.tf, v = S.tableView; if (!B || !v || v.game !== 'g2048' || B.role !== 'seat') return false;
  const k = e.key.toLowerCase(), d = k === 'arrowleft' || k === 'a' ? 0 : k === 'arrowright' || k === 'd' ? 1 : k === 'arrowup' || k === 'w' ? 2 : k === 'arrowdown' || k === 's' ? 3 : -1;
  if (d < 0) return false;
  e.preventDefault(); if (down && !e.repeat) tfMove(B, d);
  return true;
}
function tfSnap(B, force) {   // 自己的局：盤面快照給觀戰者（每一步一次，另外每秒補一次讓中途來的觀戰者看得到）
  const now = performance.now();
  if (!force && now - B.snapAt < TF_SNAP_MS) return;
  B.snapAt = now;
  S.net?.tbl?.({ a: 'tfs', m: Array.from(B.g).map(x => x.toString(36)).join(''), sc: Math.min(TF_SCORE_MAX_C, Math.round(B.score)), mx: Math.min(17, B.mx) });
}
function tfApplySnap(B, m) {   // 觀戰者：套用快照
  B.score = m.sc; B.mx = m.mx; const now = performance.now();
  for (let i = 0; i < 16; i++) { const x = parseInt(m.m[i], 36) || 0; if (x !== B.g[i]) B.pop[i] = now; B.g[i] = x; }
}
function tfFrame() {
  const B = S.tf, v = S.tableView;
  if (!B || !S.tableOpen || !v || v.game !== 'g2048') { S.tfRaf = 0; return; }
  S.tfRaf = requestAnimationFrame(tfFrame);
  if (B.role === 'seat' && !B.over && tfNow(B) >= 0) tfSnap(B, false);
  tfDraw(B, $('tfCanvas'), tfNow(B));
}
function tfDraw(B, cv, t) {
  if (!cv) return;
  const g = cv.getContext('2d'), now = performance.now();
  g.fillStyle = '#182034'; g.fillRect(0, 0, TF_W, TF_H);
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.font = 'bold 20px "Microsoft JhengHei"'; g.fillStyle = '#ffe08a'; g.fillText(`${Math.round(B.score)} 分`, 14, 26);
  g.font = '14px "Microsoft JhengHei"'; g.fillStyle = '#b8c4dc'; g.fillText(`最大方塊 ${2 ** B.mx}`, 14, 50);
  g.textAlign = 'right'; g.fillText(B.role === 'seat' ? '方向鍵／WASD／滑動' : '觀戰中', TF_W - 14, 26);
  g.fillStyle = '#222c48'; g.beginPath(); g.roundRect(TF_X0 - 8, TF_Y0 - 8, TF_CS * 4 + TF_GAP * 3 + 16, TF_CS * 4 + TF_GAP * 3 + 16, 8); g.fill();
  for (let i = 0; i < 16; i++) {
    const x = TF_X0 + (i & 3) * (TF_CS + TF_GAP), y = TF_Y0 + (i >> 2) * (TF_CS + TF_GAP), e = B.g[i];
    g.fillStyle = '#2c3552'; g.beginPath(); g.roundRect(x, y, TF_CS, TF_CS, 6); g.fill();
    if (!e) continue;
    const a = Math.min(1, (now - B.pop[i]) / 140), k = a < 1 ? .6 + .4 * a + .12 * Math.sin(a * Math.PI) : 1, s = TF_CS * k, ox = x + (TF_CS - s) / 2, oy = y + (TF_CS - s) / 2;
    g.fillStyle = TF_COL[e] || '#ffe08a'; g.beginPath(); g.roundRect(ox, oy, s, s, 6); g.fill();
    const n = 2 ** e; g.fillStyle = e >= 5 && e <= 7 || e >= 12 ? '#1a2030' : '#fff'; g.textAlign = 'center';
    g.font = `bold ${(n < 100 ? 34 : n < 1000 ? 30 : n < 10000 ? 24 : 19) * k}px "Microsoft JhengHei"`; g.fillText(String(n), x + TF_CS / 2, y + TF_CS / 2 + 2);
  }
  let msg = null;
  if (t < 0) msg = String(Math.ceil(-t)); else if (B.over) msg = '遊戲結束'; else if (B.note && B.note.until > now) msg = B.note.t;
  if (msg) { g.fillStyle = 'rgba(20,24,32,.55)'; g.fillRect(0, TF_H / 2 - 20, TF_W, 56); g.font = 'bold 26px "Microsoft JhengHei"'; g.textAlign = 'center'; g.fillStyle = '#ffe08a'; g.fillText(msg, TF_W / 2, TF_Y0 + 4 * TF_CS / 2 + 24); }
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
}
function buildG2048(box, v, mk, gd) {
  const playing = v.phase === 'playing', z = v.tf;
  if (playing && z && (!S.tf || S.tf.key !== z.seed + ':' + z.t0)) tfStart(v);
  if (!playing) tfStop();
  const B = S.tf;
  let status;
  if (playing && B) status = B.role === 'seat' ? '2048：方向鍵／WASD（或在畫面上滑動）移動方塊，相同數字撞在一起會合併' : '觀戰中';
  else status = v.seats.length < v.min ? '等待玩家入座（單人）' : '按「準備」就開始（分數進排行榜）';
  box.appendChild(mk('div', 'table-status' + (playing && B?.role === 'seat' ? ' mine' : ''), status));
  const r = v.result;
  if (r && !playing) box.appendChild(mk('div', 'table-result', r.text));
  if (!playing) boardBlock(box, v, mk, sc => `${sc} 分`);
  if (!playing) {
    const row = mk('div', 'table-seats');
    v.seats.forEach(s => {
      const seat = mk('div', 'table-seat' + (s.you ? ' you' : '') + (s.left ? ' out' : ''));
      seat.appendChild(mk('div', 'table-name', s.name + (s.you ? '（你）' : '')));
      seat.appendChild(mk('div', 'table-tag', s.ready ? '已準備' : '未準備'));
      row.appendChild(seat);
    });
    for (let i = v.seats.length; i < v.max; i++) row.appendChild(mk('div', 'table-seat empty', '空位'));
    box.appendChild(row);
  } else {
    const wrap = mk('div', 'pb-wrap'), cv = document.createElement('canvas');
    cv.id = 'tfCanvas'; cv.width = TF_W; cv.height = TF_H; cv.className = 'tf-canvas';
    cv.style.touchAction = 'none';
    cv.onpointerdown = e => { if (S.tf?.role === 'seat') S.tf.swipe = [e.clientX, e.clientY]; };
    cv.onpointerup = e => {   // 滑動＝移動（手機／滑鼠都可以）
      const B2 = S.tf; if (!B2?.swipe) return;
      const dx = e.clientX - B2.swipe[0], dy = e.clientY - B2.swipe[1]; B2.swipe = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      tfMove(B2, Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 0 : 1) : (dy < 0 ? 2 : 3));
    };
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
}
function onNetTtf(m) { const B = S.tf; if (B && B.role === 'spec') tfApplySnap(B, m); }   // 觀戰者：玩家那台的快照
// 大螢幕：2048——盤面縮小畫在左邊（同一個 tfDraw，只吃快照），右邊座位欄是分數
function scrG2048(g, v, MX, MY, MW, MH) {
  const key = v.tf.seed + ':' + v.tf.t0;
  if (!S.scrTf || S.scrTf.key !== key) S.scrTf = tfMake({ ...v, role: 'spec' });
  const B = S.scrTf, cv = (S.scrTfCv ||= Object.assign(document.createElement('canvas'), { width: TF_W, height: TF_H }));
  tfDraw(B, cv, tfNow(B));
  const k = Math.min(MW / TF_W, MH / TF_H), FW = SCR_W - MX * 2;   // 盤面窄，置中在整個螢幕寬度（不是只有左半邊；右邊座位欄不會被蓋到）
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cv, MX + (FW - TF_W * k) / 2, MY + (MH - TF_H * k) / 2, TF_W * k, TF_H * k);
}
// 大螢幕：小瑪莉（2026-11-23，使用者要求）——不用改伺服器：螢幕收到的 scr 畫面（tblView 的 SCR_CID 版）本來就帶 v.ma（獎池／押注／開獎格／勇者演出，只有籌碼餘額不送）。
// 機台畫面直接重用 maryPaint（暫時把 S.mary／S.tableView／S.maryBets 換成螢幕自己的，畫完換回來）畫到離屏畫布再縮小；
// 跑馬燈與勇者演出的動畫狀態是螢幕自己維護的一份（scrMaryTick，簡化版的 maryFrame：不出聲音、不處理比倍轉燈與送燈鏈，比倍只直接顯示結果）。
function scrMaryTick(M, ma) {
  const now = performance.now();
  if (M.seq == null || ma.seq < M.seq) {   // 剛開螢幕、或換了一場（seq 重來）：直接停在目前狀態，不補播
    Object.assign(M, { seq: ma.seq, pos: ma.last >= 0 ? ma.last : 0, spin: null, showPlay: null, showPending: null, showSeq: ma.show ? ma.show.seq : 0, res: ma.rseq === ma.seq ? ma.seq : -1, last: ma.last,
      potShown: ma.pot || 0, jpShown: ma.jp || 0, jpSeen: ma.jp || 0, chainHold: false, chainFlash: false, chainEnd: 0, chainPot: 0, dbl: null, lastFrame: now });
  } else if (ma.seq !== M.seq) {
    const spun = ma.last >= 0 && ma.dcard < 0 && ma.rseq === ma.seq;   // 同牌桌的判斷：只有真的開獎才跑跑馬燈（領出／兌換／比倍不跑）
    M.seq = ma.seq; M.last = ma.last;
    if (spun) {
      M.res = ma.seq; M.dbl = null;
      const from = ((M.pos % 28) + 28) % 28, laps = 2 * 28 + ((ma.last - from) % 28 + 28) % 28;
      M.spin = { from, to: from + laps, t0: now, dur: 4800, end: ma.last, win: ma.pot > 0, more: ma.ring[ma.last] === 'more' };
      if (M.spin.more) { M.chainHold = true; M.chainPot = M.potShown; }
      M.chainFlash = M.spin.more;
      if (ma.show && ma.show.seq !== M.showSeq) M.showPending = ma.show;
    } else { M.dbl = null; M.potShown = ma.pot || 0; M.jpShown = ma.jp || 0; }
  }
  if (!M.spin) { M.jpSeen = ma.jp || 0; M.jpShown = ma.jp || 0; }
  if (M.showPlay && now - M.showPlay.t0 > MARY_SHOW_MS) { M.potShown = ma.pot || 0; M.showSeq = M.showPlay.seq; M.showPlay = null; }   // 勇者／拉霸演出結束
  if (M.spin) {
    const sp = M.spin, t = Math.min(1, (now - sp.t0) / sp.dur), e = 1 - Math.pow(1 - t, 3);
    M.pos = sp.from + (sp.to - sp.from) * e;
    if (t >= 1) {
      M.spin = null; M.pos = sp.end;
      if (M.showPending) { M.showPlay = { ...M.showPending, t0: now }; M.showPending = null; } else M.potShown = ma.pot || 0;
      if (M.chainHold && !(ma.lights > 0)) { M.chainHold = false; M.chainEnd = ma.seq; }
    }
  }
  if (M.chainHold && !M.spin && !(ma.lights > 0)) { M.chainHold = false; M.chainEnd = ma.seq; }
  M.lastFrame = now;
}
function scrMary(g, v, MX, MY, MW, MH) {
  const ma = v.ma; if (!ma || !ma.ring) return;
  const M = (S.scrMary ||= { seq: null });
  scrMaryTick(M, ma);
  const cvm = (S.scrMaryCv ||= Object.assign(document.createElement('canvas'), { width: MARY_W * 2, height: MARY_H * 2 })), sv = [S.mary, S.tableView, S.maryBets];
  S.mary = M; S.tableView = { ...v, role: 'spec' }; S.maryBets = null;
  try { maryPaint(cvm); } finally { [S.mary, S.tableView, S.maryBets] = sv; }
  const k = MH / 352, dw = MARY_W * k;   // 只取機台上半部（到押注列，控制盤對觀眾沒用），縮到主畫面的高度
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cvm, 0, 0, MARY_W * 2, 352 * 2, MX, MY, dw, MH);
  g.imageSmoothingEnabled = false;
  // 右邊：玩家、獎池、本注、這一注的結果（機台上的字太小，在這裡用大字再寫一次）
  const x0 = MX + dw + 10, w = MW - dw - 10, nm = ma.nm || {}, cols = ma.cols || [];
  const who = v.seats[0]?.name || '', bets = ma.bets || [], total = bets.reduce((a, b) => a + b, 0);
  const spin = !!M.spin, hold = spin || !!M.showPlay || !!M.showPending, win = Math.floor(hold ? (M.potShown || 0) : (ma.pot || 0));
  g.textAlign = 'left';
  g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.fillText('玩家', x0, MY + 14);
  g.fillStyle = '#e8ecf8'; g.font = `bold 15px ${SCR_FONT}`; g.fillText(who.slice(0, 8), x0, MY + 33, w);
  g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.fillText('獎池 WIN', x0, MY + 58);
  g.fillStyle = '#ff6a50'; g.font = `bold 20px ${SCR_FONT}`; g.fillText(win.toLocaleString('en-US'), x0, MY + 80, w);
  g.fillStyle = '#9fb0d8'; g.font = `12px ${SCR_FONT}`; g.fillText('本注', x0, MY + 104);
  g.fillStyle = '#ffd24a'; g.font = `bold 16px ${SCR_FONT}`; g.fillText(total.toLocaleString('en-US'), x0, MY + 124, w);
  let note = '', col = '#ffe08a';
  if (spin) note = '開獎中…';
  else if (M.showPlay) { note = maryShowNote(M.showPlay, nm); col = '#a8f0b8'; }
  else if (ma.dcard >= 0) { note = `${ma.pot > 0 ? '猜對！' : '猜錯！'}開 ${ma.dcard}${ma.dcard >= 8 ? '（大）' : ma.dcard <= 6 ? '（小）' : '（莊家贏）'}${ma.pot > 0 ? '翻倍' : '歸零'}`; col = ma.pot > 0 ? '#a8f0b8' : '#ffb0b0'; }
  else if (ma.lights > 0) { note = `送燈中：剩 ${ma.lights} 個`; col = '#a8f0b8'; }
  else if (ma.last >= 0 && M.res === ma.seq) {
    const sym = ma.ring[ma.last], b = bets[cols.indexOf(sym)] || 0, wn = ma.win || b * (ma.pay[sym] || 1);
    if (ma.allwin) { note = `全中獎！贏 ${(ma.win || 0).toLocaleString('en-US')}`; col = '#ffd24a'; }
    else if (sym === 'more') { note = 'ONCE MORE！送燈'; col = '#a8f0b8'; }
    else { note = wn > 0 ? `${nm[sym] || sym} 贏 ${wn.toLocaleString('en-US')}` : `${nm[sym] || sym} 沒押中`; col = wn > 0 ? '#a8f0b8' : '#e8ecf8'; }
  } else note = ma.pot > 0 ? '獎池待領出／比倍' : '等待下注開獎';
  g.fillStyle = col; g.font = `bold 13px ${SCR_FONT}`; g.fillText(note, x0, MY + 152, w);
  g.fillStyle = '#9fb0d8'; g.font = `11px ${SCR_FONT}`; g.fillText(`累積獎池 JP ${Math.floor(ma.jp || 0).toLocaleString('en-US')}`, x0, MY + 178, w);
}
// 大螢幕：星球合成（2026-11-20，使用者要求）——正在玩的每一台各畫一個縮小盤面並排（單人＝兩台各玩各的、對戰＝兩邊對打；對戰分出勝負後停住並標「勝利／落敗」），
// 吃快照（sttm w:'tpl'，帶 cab），跟牌桌觀戰同一份 plDraw／plAdvance
function scrPlanet(g, v, MX, MY, MW, MH) {
  const cabs = v.seats.filter(x => x.play).map(x => x.cab).sort(), end = v.link?.end, now = performance.now();
  const sp0 = (S.scrPl ||= {}), cvs = (S.scrPlCv ||= {});
  for (const c of Object.keys(sp0)) if (!cabs.includes(Number(c))) { delete sp0[c]; delete cvs[c]; }
  const n = Math.max(1, cabs.length), gap = 10, k = Math.min((MW - gap * (n - 1)) / n / PL_W, MH / PL_H), w = PL_W * k, h = PL_H * k, x0 = MX + (MW - (w * n + gap * (n - 1))) / 2;
  cabs.forEach((c, i) => {
    const sp = (sp0[c] ||= plMakeSpec()), cv = (cvs[c] ||= Object.assign(document.createElement('canvas'), { width: PL_W, height: PL_H }));
    sp.label = v.seats.find(x => x.cab === c)?.name || `${c + 1} 號機`;
    sp.frozen = !!end && !!v.link?.mem?.includes(c); sp.banner = sp.frozen ? { small: true, mark: end.w === c ? '勝利' : '落敗' } : null;
    const dt = Math.max(0, Math.min(.05, (now - sp.last) / 1000)); sp.last = now; plAdvance(sp, dt); plDraw(sp, cv, 1);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cv, x0 + i * (w + gap), MY + (MH - h) / 2, w, h);
  });
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
  if (v.mg && v.mg.dmg > M.lastDmg) { M.lastDmg = v.mg.dmg; M.shake = performance.now() + 350; mgSay('−1', '#ffe08a', 320, 118); }   // M.shake 現在只當「Boss 變紅」的計時（2026-11-15 使用者要求：取消畫面晃動、紅色只留 Boss，不然像玩家受傷）
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
  g.save();   // （打中 Boss 不再晃動畫面）
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
    const hurt = M.shake > now; g.globalAlpha = enter; g.fillStyle = hurt ? '#ff4a4a' : '#7a2a8a'; g.beginPath(); g.arc(bx, by + wob, 38, Math.PI, 0); g.lineTo(bx + 38, by + wob + 34);
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
    seat.appendChild(mk('div', 'table-tag', playing ? (s.dead ? `倒下 · 畫對 ${s.syms}` : '♥'.repeat(Math.max(0, s.hp)) + '♡'.repeat(Math.max(0, MG_HP - s.hp)) + ` · 畫對 ${s.syms}`) : (s.ready ? '已準備' : '未準備')));
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
  const t = typingNow(), w = T.word(T.idx);
  // 半形字元＝輸入法還沒接手（輸入框剛聚焦）或在英文模式時漏進來的按鍵：題目全是中文，直接丟掉、不算打錯
  if (/[\x20-\x7e]/.test(inp.value)) inp.value = inp.value.replace(/[\x20-\x7e]/g, '');
  const val = inp.value;
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
function typingSendProgress(v) {   // 送打字進度（約每 250ms 最多一次、有變化才送）；伺服器只轉給觀戰者與大螢幕，沒人看就丟掉
  const T = S.ty;
  if (v.role !== 'seat') { T.pKey = ''; return; }   // （2026-11-15：不再看 v.specs——大螢幕不算觀戰者，原本只有大螢幕在看時玩家不會送進度）
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
  // 中文打字：輸入框保持聚焦，玩家直接用輸入法打字。倒數中就啟用並聚焦（倒數中送出的字會被 typingZhCheck 清掉）——
  // 等開始才啟用的話，輸入法要一小段時間才接手，第一個字的按鍵會以英文字母漏進輸入框、被判成打錯
  const zi = $('tyZh'); if (zi) { zi.disabled = !seated || t >= T.dur; if (!zi.disabled && document.activeElement !== zi) zi.focus(); }
  const hint = $('tyHint'); if (hint) hint.textContent = T.zh ? (seated && t < T.dur ? '請切換成中文輸入法（例如注音），打出上面的詞，選字送出後自動計分' : '') : T.ime ? '偵測到中文輸入法：請切換成英文輸入（例如按 Shift）' : '';
}
// 中文打字比賽進行中、同一局、我坐著：伺服器重送畫面（有人進來觀戰／中途離開）時，回傳現有的 .typing-wrap 讓 buildTable 留著不重建——
// 輸入框一重建，組字到一半的字與已打對的前綴都會不見（T.pos 卻還在），接著打剩下的字會被判錯
function typingKeepWrap() {
  const T = S.ty, v = S.tableView, zi = $('tyZh');
  if (!zi || !T || !T.zh || !v || S.tableChoice || v.phase !== 'playing' || v.role !== 'seat' || v.game !== 'zhtyping' || T.id !== S.tableId || T.t0 !== v.ty?.t0) return null;
  return zi.closest('.typing-wrap');
}
function buildTyping(box, v, mk, gd) {
  const old = box.querySelector('.typing-wrap');   // buildTable 留下來的比賽畫面（見 typingKeepWrap）；沒有就是 null
  const playing = v.phase === 'playing', mySeat = v.role === 'seat' ? v.seats[v.me] : null;
  if (playing && v.ty && (!S.ty || S.ty.id !== S.tableId || S.ty.t0 !== v.ty.t0)) typingStart(v);   // 新的一局（或剛進來觀戰一局進行中的）：重置本機狀態
  else if (playing && S.ty) S.ty.scores = v.seats.map((s, i) => (i === v.me && v.role === 'seat' ? S.ty.score : Math.max(s.score || 0, S.ty.scores[i] || 0)));
  if (!playing) typingStop();
  let status;
  if (playing) status = mySeat ? (v.game === 'zhtyping' ? '比賽中：照著打出畫面中央的詞（不用按 Enter）' : '比賽中：照著打出畫面中央的單字（不用按 Enter）') : '觀戰中';
  else status = v.seats.length < v.min ? `等待玩家入座（至少 ${v.min} 人，最多 ${v.max} 人）` : '全員按「準備」就開始';
  box.insertBefore(mk('div', 'table-status' + (playing && mySeat ? ' mine' : ''), status), old);   // old＝null 時等於 appendChild
  if (v.result && !playing && v.result.ranking) {   // 結算：依分數排名（同分同名次）
    box.appendChild(mk('div', 'table-result', v.result.text));
    const rk = mk('div', 'dodge-rank'), rs = v.result.ranking;
    rs.forEach(r => rk.appendChild(mk('div', null, `${1 + rs.filter(o => o.score > r.score).length}. ${r.name}　${r.score} ${v.game === 'zhtyping' ? '個詞' : '個單字'}${r.left ? '（中途離開）' : ''}`)));
    box.appendChild(rk);
  }
  if (!playing) boardBlock(box, v, mk, sc => `${sc} ${v.game === 'zhtyping' ? '個詞' : '個單字'}`);
  if (playing && old) { /* 沿用現有的比賽畫面，內容由下面的 typingRender 更新 */ }
  else if (playing) {   // 比賽畫面：上方其他人的分數、中央題目與自己的分數、下方自己打的內容
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
// 連擊（combo／REN，2026-11-14 使用者要求）：看「連續幾塊方塊落下都有消行」（不是幾秒內），一塊沒消到就歸零。
// 單人加分：第 N 次連續消行額外 50 × (N−1) × 等級；對戰額外送垃圾行（連擊數 1～2＝0、3～4＝1、5～6＝2、7～8＝3、9～11＝4、12 以上＝5，每個對手各吃一份，加在一次消行本身送的行數上）。
// 伺服器照同一張表算（兩份伺服器的 arComboBonus／ar_combo_bonus 要一致）
const arComboBonus = c => (c >= 12 ? 5 : c >= 9 ? 4 : c >= 7 ? 3 : c >= 5 ? 2 : c >= 3 ? 1 : 0);
const AR_DAS = 150, AR_ARR = 40, AR_LOCK = 500, AR_LOCK_RESETS = 15, AR_SNAP_MS = 250;
const AR_KEYS = { arrowleft: 'L', arrowright: 'R', arrowdown: 'D', arrowup: 'CW', x: 'CW', z: 'CCW', ' ': 'HD', c: 'HOLD', shift: 'HOLD' };
const arFall = lv => Math.max(30, 1000 * Math.pow(0.8 - (lv - 1) * 0.007, lv - 1));   // 每格落下的毫秒（等級越高越快）
function arRng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const AR_LIVES = 5;   // 對戰模式每人幾條命（2026-11-16 使用者要求）：頂到就扣一命、清空盤面（含等著推上來的垃圾），5 條都用完才出局；其中一人出局，整場立刻結束（伺服器判）
function arNew(seed, t0, off, key, battle) {
  const A = { key, t0, off, battle: !!battle, lives: battle ? AR_LIVES : 1, lifeMsg: null, rng: arRng(seed), bag: [], queue: [], board: Array.from({ length: AR_H }, () => new Array(AR_W).fill(0)),
    cur: null, hold: 0, held: false, sc: 0, ln: 0, lv: 1, combo: 0, dead: false, fallAcc: 0, lockT: 0, resets: 0, keys: {}, das: {}, gq: 0,
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
  A.cur = p; A.lockT = 0; A.resets = 0; A.fallAcc = 0; A.lowY = p.y;
  if (!arFits(A, p) && !arGameOver(A)) arSpawn(A, k);   // 對戰模式還有命：清空盤面後重新生這一塊
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
  if (cells.every(([, y]) => y < AR_H - AR_VIS)) {   // 整塊停在畫面外：頂到了（對戰模式還有命：這一塊作廢、清掉垃圾行、繼續）
    if (A.lives > 1) for (const [x, y] of cells) if (y >= 0) A.board[y][x] = 0;
    if (arGameOver(A)) return;
  }
  const full = [];
  for (let y = 0; y < AR_H; y++) if (A.board[y].every(c => c)) full.push(y);
  if (full.length) {
    for (const y of full) { A.board.splice(y, 1); A.board.unshift(new Array(AR_W).fill(0)); }
    A.combo++;   // 連擊：連續幾塊都有消行
    A.sc += AR_LINE_PTS[full.length] * A.lv + 50 * (A.combo - 1) * A.lv; A.ln += full.length; A.lv = Math.min(20, 1 + Math.floor(A.ln / 10));
    A.flash = { n: full.length, combo: A.combo, until: performance.now() + 900 };
    const lk = S.tableView?.link;
    if (lk?.phase === 'playing' && lk.mode === 'battle') S.net?.tbl?.({ a: 'clr', n: full.length, combo: A.combo });   // 對戰模式：讓伺服器依消行數＋連擊算要送對手幾行垃圾（消 1 行本身不送，但連擊夠高會送）
  } else A.combo = 0;
  if (A.gq > 0) {   // 收到的垃圾行在方塊放好時才推上來（同一批的缺口在同一欄）
    const n = Math.min(A.gq, AR_H);
    A.gq = 0;
    const over = A.board.slice(0, n).some(r => r.some(c => c));
    A.board.splice(0, n);
    let hole = A.gHole ?? -1;   // 每一行的缺口各自亂數，而且跟上一行不同欄（2026-11-16 使用者說同一批缺口都在同一欄，對面一根直條就一次消回好幾行）
    for (let i = 0; i < n; i++) { let h; do h = Math.floor(Math.random() * AR_W); while (h === hole); hole = h; const r = new Array(AR_W).fill(8); r[hole] = 0; A.board.push(r); }
    A.gHole = hole;
    if (over && arGameOver(A)) return;
  }
  A.held = false;
  arNext(A);
  arSnap(A, true);
}
function arGameOver(A) {   // 回 true＝真的結束了；false＝對戰模式扣一命、盤面清空，呼叫的人要接著生下一塊
  if (A.dead) return true;
  if (A.lives > 1) {
    A.lives--; A.gq = 0; A.combo = 0; A.cur = null; A.lockT = 0; A.keys = {}; A.das = {};
    // 只清垃圾行（含垃圾格的整行拿掉、上面的自己的方塊落下來），自己堆的方塊留著；如果拿掉後自己的方塊還堆在生成區（最上面 4 列），才整個盤面清空，不然下一塊一生出來又頂到、連扣好幾命
    const rows = A.board.filter(r => !r.includes(8));
    while (rows.length < AR_H) rows.unshift(new Array(AR_W).fill(0));
    A.board = rows.slice(0, 4).some(r => r.some(c => c)) ? Array.from({ length: AR_H }, () => new Array(AR_W).fill(0)) : rows;
    A.lifeMsg = { text: `失去一命！剩 ${A.lives} 命`, until: performance.now() + 1800 };
    arSnap(A, true);
    return false;
  }
  A.lives = 0; A.dead = true; A.cur = null;
  arSnap(A, true);
  S.net?.tbl?.({ a: 'over', sc: A.sc, ln: A.ln });
  return true;
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
  S.net?.tbl?.({ a: 'tb', b: s, sc: A.sc, ln: A.ln, ...(A.battle ? { lv: A.lives } : {}) });
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
    A.lockT = 0;   // 沒踩在東西上：鎖定計時歸零（2026-11-15 使用者說有時瞬間判定落地、沒辦法 T 轉：原本滑進凹洞再落下時還帶著上一次踩地累積的時間，一落地就鎖了）
    A.fallAcc += dt;
    while (A.fallAcc >= fall && !arGrounded(A)) { A.fallAcc -= fall; A.cur.y++; if (A.keys.D) A.sc += 1; }
    if (arGrounded(A)) A.fallAcc = 0;
  }
  if (A.cur && A.cur.y > A.lowY) { A.lowY = A.cur.y; A.resets = 0; }   // 掉到更低的一列：移動／轉向的重置次數重新算（標準的 move reset 鎖定）
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
function onNetTtb(m) { (S.arOpp ||= {})[m.cab] = { b: m.b, sc: m.sc, ln: m.ln, lv: m.lv }; }   // 別台的盤面快照（觀戰者、同一場聯機的對手才收到）
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
  if (A.battle) stat.push(['命', '♥'.repeat(A.lives) + '♡'.repeat(AR_LIVES - A.lives)]);
  stat.forEach(([lbl, n], i) => { g.fillStyle = '#8fa0c8'; g.font = '12px "Microsoft JhengHei"'; g.fillText(lbl, R, 210 + i * 46); g.fillStyle = lbl === '命' ? '#ff6a7a' : '#ffe08a'; g.font = lbl === '命' ? 'bold 14px "Microsoft JhengHei"' : 'bold 18px "Microsoft JhengHei"'; g.fillText(String(n), R, 230 + i * 46); });
  g.textAlign = 'center';
  const wait = A.t0 - (Date.now() + A.off);
  const msg = (txt, sub, col = '#ffe08a') => {
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(L, 10 + BH / 2 - 44, BW, 80);
    g.fillStyle = col; g.font = 'bold 30px "Microsoft JhengHei"'; g.fillText(txt, L + BW / 2, 10 + BH / 2);
    if (sub) { g.fillStyle = '#fff'; g.font = '14px "Microsoft JhengHei"'; g.fillText(sub, L + BW / 2, 10 + BH / 2 + 24); }
  };
  if (A.dead) msg('GAME OVER', `${A.sc} 分 · ${A.ln} 行`, '#ff7a6a');
  else if (wait > 0) msg(String(Math.ceil(wait / 1000)), '準備……');
  else if (A.flash && performance.now() < A.flash.until) { g.fillStyle = '#fff6c0'; g.font = 'bold 20px "Microsoft JhengHei"'; g.fillText(['', '', '雙消！', '三消！', '四行消除！'][A.flash.n] || '', L + BW / 2, 44); if (A.flash.combo >= 2) { g.fillStyle = '#ffb04a'; g.font = 'bold 16px "Microsoft JhengHei"'; g.fillText(`${A.flash.combo} 連擊！`, L + BW / 2, 66); } }
  if (A.lifeMsg && performance.now() < A.lifeMsg.until) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(L, 10 + BH / 2 - 22, BW, 44); g.fillStyle = '#ff7a8a'; g.font = 'bold 20px "Microsoft JhengHei"'; g.fillText(A.lifeMsg.text, L + BW / 2, 10 + BH / 2 + 7); }
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
    const sc = document.getElementById('arOppSc' + cab); if (sc && snap) sc.textContent = `${snap.sc} 分 · ${snap.ln} 行${snap.lv != null ? ' · ' + '♥'.repeat(snap.lv) : ''}`;
  }
}
function buildArcade(box, v, mk, gd) {
  const me = v.role === 'seat' ? v.seats[v.me] : null, lk = v.link, playing = v.phase === 'playing';
  const off = (v.sn || Date.now()) - Date.now();
  // 新的一局：單人看自己的 tt、聯機看 link 的 seed（大家同一串方塊）
  const want = playing ? (me.st === 'solo' && v.tt ? { key: 's' + v.tt.seed + ':' + v.tt.t0, seed: v.tt.seed, t0: v.tt.t0 } : lk?.phase === 'playing' ? { key: 'l' + lk.seed + ':' + lk.t0, seed: lk.seed, t0: lk.t0 } : null) : null;
  if (want && (!S.ar || S.ar.key !== want.key)) { S.ar = arNew(want.seed, want.t0, off, want.key, lk?.phase === 'playing' && lk.mode === 'battle' && me.st === 'link'); S.arOpp = {}; }
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
    room.appendChild(mk('div', 'table-tag', lk.mode === 'battle' ? '對戰模式：每人 5 條命（頂到就扣 1 命、清掉垃圾行）；一次消 2／3／4 行，其他對手最下面多 1／2／4 行垃圾，連擊夠高再多送。只要有人 5 條命用完，整場立刻結束，還活著的人贏。' : '一般模式：大家拿到一樣的方塊順序，各自玩到出局，全員出局後依分數排名。'));
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
const propUse = pr => pr.kind === 'drink' || pr.kind === 'food' || pr.kind === 'screen' || pr.kind === 'gacha' || pr.kind === 'claw';   // 能互動（吃喝）的物件；deco（隔板）只擋路、rug（地毯）畫在地板層
// ---- 扭蛋機（2026-11-19，使用者要求；畫面與動畫在 client/js/gacha.js，資料在 assets/gacha/gacha.json）----
// 目前只有框架：抽的條件（貨幣）與獎品內容還沒決定。**之後要補的地方就是下面兩個函式**：
//   gachaCanPull(M, n)  → { ok, reason }  能不能抽 n 顆（扣錢／次數限制寫這裡）
//   gachaGrant(M, results)                抽到的獎品清單（寫進背包／衣櫥、同步伺服器寫這裡）
// 抽籤本身目前在客戶端；獎品有價值之後要搬到伺服器（見 gacha.js 開頭）。
const gachaCanPull = (M, n) => ({ ok: true });
function gachaGrant(M, results) {   // 抽到寵物就跟著玩家；已經 5 隻時照樣抽到、但不會出現，並提示
  const notes = []; let full = false;
  for (const pz of results) {
    if (!pz.pet) { notes.push(null); continue; }
    if (addPet(pz.pet) === 'full') { full = true; notes.push({ short: '已達上限', title: '跟隨寵物已達上限' }); } else notes.push(null);
  }
  if (full) { toast('跟隨寵物已達上限', 2000); return { notes, msg: '跟隨寵物已達上限' }; }
  return { notes };
}
function openGachaProp(pr) {
  for (const k of Object.keys(keys)) keys[k] = false;   // 畫面蓋住後收不到 keyup，先放開按住的鍵
  S.mouseHeld = false;
  import('./gacha.js').then(async m => {
    S.gacha = m;
    const ok = await m.openGacha(pr.id, { toast, sfx: sfxTones, canPull: gachaCanPull, grant: gachaGrant, onClose: () => { S.gachaOpen = false; } });
    S.gachaOpen = ok;
  }).catch(err => { console.warn('gacha:', err); toast('扭蛋機現在壞掉了', 1800); });
}
// ---- 夾娃娃機（2026-11-19，使用者要求先預做框架；畫面與玩法在 client/js/claw.js，資料在 assets/claw/claw.json）----
// **之後要補的就是這兩個掛鉤**：clawCanPlay(M)＝能不能玩一次（貨幣／次數）、clawGrant(M, prize)＝夾到獎品之後怎麼發（背包／衣櫥、同步伺服器）。目前都是空的。
const clawCanPlay = M => ({ ok: true });
const clawGrant = (M, prize) => ({});
function openClawProp(pr) {
  for (const k of Object.keys(keys)) keys[k] = false;   // 畫面蓋住後收不到 keyup，先放開按住的鍵
  S.mouseHeld = false;
  import('./claw.js').then(async m => {
    const ok = await m.openClaw(pr.id, { toast, sfx: sfxTones, canPlay: clawCanPlay, grant: clawGrant, onClose: () => { S.clawOpen = false; } });
    S.clawOpen = ok;
  }).catch(err => { console.warn('claw:', err); toast('夾娃娃機現在壞掉了', 1800); });
}
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
  if (pr.kind === 'screen') { openScrPick(); return; }   // 大螢幕：開轉播清單
  if (pr.kind === 'gacha') { openGachaProp(pr); return; }   // 扭蛋機：開抽獎畫面
  if (pr.kind === 'claw') { openClawProp(pr); return; }   // 夾娃娃機：開夾娃娃畫面
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
  for (const pt of petList()) {   // 跟隨寵物：每隻一個增益圖示（右鍵取消跟隨）；效果還沒決定，現在只有圖示
    const d = petDef(pt.id), el = document.createElement('div');
    el.className = 'buff good pet'; el.title = d.name; el.dataset.pid = pt.uid;
    el.innerHTML = `<span class="bp" style="${petIconStyle(d)}"></span><span class="bt"></span>`;
    bar.appendChild(el);
  }
  bar.classList.toggle('hidden', !ks.length && !petList().length);
  buffBarTick(true);
}
let buffTickAt = 0;
function buffBarTick(force) {
  if (!force && S.t - buffTickAt < .2) return;
  buffTickAt = S.t;
  for (const el of document.querySelectorAll('#buffBar .buff')) {
    if (el.dataset.pid) {   // 寵物：剩幾分鐘（最後一分鐘改顯示秒）
      const pt = petList().find(p => p.uid === +el.dataset.pid), ms = pt ? petLeftMs(pt) : 0;
      el.querySelector('.bt').textContent = ms > 60000 ? `${Math.ceil(ms / 60000)}m` : Math.ceil(ms / 1000);
      continue;
    }
    const left = (S.foodFx[el.dataset.k] || 0) - S.t; el.querySelector('.bt').textContent = left > 0 ? Math.ceil(left) : '';
  }
}
$('buffBar').addEventListener('contextmenu', e => {   // 右鍵寵物圖示＝取消跟隨（寵物消失）
  e.preventDefault();
  const el = e.target.closest?.('.buff.pet'); if (!el) return;
  const pt = removePet(+el.dataset.pid);
  if (pt) toast(`${petDef(pt.id)?.name ?? '寵物'}離開了`, 1400);
});
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
        if (pr.kind === 'screen') drawScreenProp(pr, r);
        else if (img) drawSpr(img, 0, r.x, r.y, r.w, r.h); else { ctx.fillStyle = '#8a5a34'; ctx.fillRect(r.x, r.y, r.w, r.h); }
        if (!pr.name) return;   // 隔板之類：沒有名稱標籤
        const p = S.players[0], cx = r.x + r.w / 2;
        ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
        ctx.font = 'bold 12px "Microsoft JhengHei"'; ctx.fillStyle = '#ffe08a';
        ctx.strokeText(pr.name || '', cx, r.y - 6); ctx.fillText(pr.name || '', cx, r.y - 6);
        if (!S.tableOpen && propNear(p) === pr) {
          const t = pr.kind === 'screen' ? '按 F 選擇轉播的遊戲' : pr.kind === 'gacha' ? '按 F 轉扭蛋' : pr.kind === 'claw' ? '按 F 夾娃娃' : pr.kind === 'food' ? '按 F 吃點心' : '按 F 喝飲料';
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
        if (tb.cab != null) { arcadeLabel(tb, r, inf, p); return; }   // 機台類（俄羅斯方塊、星球合成）：每台頭上一行
        if (gd?.kind === 'machine') { machineLabel(tb, r, inf, p, gd); return; }   // 單人機台（彈珠台、打磚塊、泡泡射手、2048）：空著寫「空機台」，不寫 0/1（2026-11-20 使用者要求）
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
  if (inf?.inv && (!c || c.st === 'idle')) lines.push([tb.game === 'planet' ? '對戰邀請中！' : '聯機邀請中！', '#ff9ad0', 'bold 11px']);
  if (!S.tableOpen && tableDist(tb, p.x, p.y) < TABLE_RANGE && !tableNearOther(tb, p)) lines.push([c ? '按 F 觀戰' : '按 F 開始玩', '#fff6e0', '11px']);
  ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
  lines.forEach(([t, col, font], k) => { ctx.font = `${font} "Microsoft JhengHei"`; ctx.fillStyle = col; const y = r.y - 6 - k * 14; ctx.strokeText(t, cx, y); ctx.fillText(t, cx, y); });
  ctx.restore();
}
function machineLabel(tb, r, inf, p, gd) {
  const cx = r.x + r.w / 2, busy = !!inf?.n, lines = [];
  lines.push([busy ? `${inf.play ? '遊戲中' : '入座中'}${inf.s ? ` · ${inf.s} 人觀戰` : ''}` : inf?.s ? `空機台 · ${inf.s} 人觀戰` : '空機台', busy ? '#fff6e0' : '#b8c4dc', '11px']);
  lines.push([gd.name, '#ffe08a', 'bold 12px']);
  if (!S.tableOpen && tableDist(tb, p.x, p.y) < TABLE_RANGE) lines.push([busy ? '按 F 觀戰' : '按 F 開始玩', '#fff6e0', '11px']);
  ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.85)';
  lines.forEach(([t, col, font], k) => { ctx.font = `${font} "Microsoft JhengHei"`; ctx.fillStyle = col; const y = r.y - 6 - k * 14; ctx.strokeText(t, cx, y); ctx.fillText(t, cx, y); });
  ctx.restore();
}
const tableNearOther = (tb, p) => tableNear(p) !== tb;   // 4 台挨得很近：只在最近的那台顯示「按 F」

// ---- 稱號：達成條件就解鎖（assets/titles/titles.json），在造型面板的「稱號設定」選一個顯示在名字上方 ----
// 解鎖純客戶端判斷（與職業同樣信任客戶端）：釣魚類從圖鑑推算（登入的人用伺服器存的圖鑑）；擊倒島主記在 localStorage 的 dcisland.m0.titles。
// 同步只送稱號 id（state.title），文字由各畫面查 titles.json。
const TITLE_ASSIST = 30;   // 島主倒下前幾秒內打過牠算「參與擊倒」
// 殺寵懲罰的強制稱號（petKillPenalty）：不在 titles.json 清單裡（不能自己選、也不會「解鎖」），titleDef 查得到就好
const PET_KILL_TITLES = { kill_cat: '屠貓變態', kill_dog: '屠狗變態', kill_pets: '反社會人格變態' };
const titleDef = id => (id && (S.titlesDB?.titles?.find(t => t.id === id)
  || (PET_KILL_TITLES[id] ? { id, name: PET_KILL_TITLES[id], cond: null } : null))) || null;
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
    case 'played': {   // 玩過幾種小遊戲。group＝'table'（桌上遊戲）／'machine'（機台，games.json 的 kind）：need 自動＝該類現有遊戲數（新增遊戲會自動變多）；新增遊戲後已得到的稱號也會被收回（使用者說可以）
      const G = S.gstats || S.gstatsLocal || {};
      if (c.group) {
        const ids = Object.entries(S.gamesDB?.games || {}).filter(([, v]) => (v.kind || 'table') === c.group).map(([k]) => k);
        const cur = ids.filter(k => (G[k]?.p || 0) >= 1).length, need = Math.max(1, ids.length);
        return { cur, need };
      }
      return { cur: Object.values(G).filter(m => (m.p || 0) >= 1).length, need: c.n || 1 };
    }
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
  // 新增遊戲後被收回的「常客」稱號：戴著的卸下（只在戰績已載入、遊戲清單已讀到時判斷，免得開機時資料還沒到就誤卸）
  if (S.me.title && ['table_regular', 'arcade_regular'].includes(S.me.title) && S.gstats && S.gamesDB?.games && !got.has(S.me.title)) {
    S.me.title = null; saveAvatar(); if (!silent) toast('新增了遊戲，「常客」稱號需要補玩才算，已自動卸下', 3600);
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
  // 強制稱號（殺寵懲罰）生效中：不能自己換（「無」也算換）
  if (S.titleForceUntil > Date.now() && S.titleForceId) { toast(`懲罰稱號《${PET_KILL_TITLES[S.titleForceId]}》生效中，還不能自己換稱號`, 2200); return; }
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
let carrySideNow = false, carryFaceLeft = false, carryBackNow = false;
const carryImgOf = w0 => (carrySideNow && w0.sideImg) || (carryBackNow && w0.rearImg) || w0.carryImg || w0;   // 掛著時用的圖（2026-11-27）：側面走用側面版（sideSprite）、背對用背面版（rearSprite，沒有就用正面）、其餘用正面版（carrySprite；劍／短刀只剩劍柄／刀柄）或手上那張
function drawWeaponBack(w0, onBack) {
  const wi = carryImgOf(w0), [ax, ay] = onBack ? charAnch.backView : charAnch.back, s = wi.wscale || 2, wb = WEAPON_BACK_BOTTOM * s / 2;
  ctx.save(); if (carryFaceLeft && !onBack) ctx.scale(-1, 1);   // 朝左（側面）：鏡射到右邊＝背後那側
  ctx.translate(ax, ay + 2 * (S.avatar.frames.scale || 1)); ctx.rotate(-.55);   // 背著的武器比掛點再往下 2 格（使用者要求）
  if (wi.hiltUp) { ctx.scale(1, -1); ctx.drawImage(wi, -wi.width * s / 2, WEAPON_HILT_LIFT * s / 2 - wb, wi.width * s, wi.height * s); }
  else ctx.drawImage(wi, -wi.width * s / 2, wb - wi.height * s, wi.width * s, wi.height * s);
  ctx.restore();
}
// 掛在腰間（avatar.json 的 carry: "waist"）：握把在腰的掛點，武器頭朝下、往身後斜（劍柄朝上，像插在腰帶上）
function drawWeaponWaist(w0) {
  const wi = carryImgOf(w0), [ax, ay] = charAnch.waist, s = wi.wscale || 2;
  ctx.save(); if (carrySideNow && carryFaceLeft) ctx.scale(-1, 1);   // 側面：劍柄朝前、劍尖朝後（朝左時鏡射）
  ctx.translate(ax, ay); ctx.rotate(Math.PI + .45);
  ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();   // 轉軸＝離圖底 3 格的握把
}
// 左右腰各一把（avatar.json 的 carry: "hips"，忍者的短刀）：左腰在 waist 掛點往外 3 格、右腰對稱，刀尖朝下往身後斜（左右各斜一邊）
// 正面只看到刀柄、背面只看到刀尖（兩把同一個方向）；側面兩把疊在同一處：刀柄朝前上、刀尖朝後下，一把在身體最下層（layer 'under'）、一把在最上層（'over'）
function drawWeaponHips(w0, layer) {
  const wi = carryImgOf(w0), s = wi.wscale || 2, wy = charAnch.waist[1], hx = Math.abs(charAnch.waist[0]) + 4;
  if (carrySideNow) {
    ctx.save(); if (carryFaceLeft) ctx.scale(-1, 1);
    ctx.translate(charAnch.waist[0] + (layer === 'under' ? -2 : 1), wy + (layer === 'under' ? 1 : 0)); ctx.rotate(Math.PI + .45);
    ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();
    return;
  }
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(side * hx, wy); ctx.rotate(Math.PI + side * .5);
    ctx.drawImage(wi, -wi.width * s / 2, -(wi.height - 3) * s, wi.width * s, wi.height * s); ctx.restore();
  }
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
  if (wi.hiltUp || wi.carry === 'waist' || wi.carry === 'hips') {
    const from = wi.carry === 'waist' || wi.carry === 'hips' ? charAnch.waist : [charAnch.back[0] - 2, charAnch.back[1] - 3];
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
// ---- 遊戲時間（決定論、零同步；2026-11-13 使用者定）----
// 用 Date.now() 換算：現實 24 分鐘＝遊戲一天（1 遊戲小時＝現實 1 分鐘）、一季 7 天、一年 4 季；所有人算出來都一樣、
// 重開分頁也不會跳（與天氣的決定論同一套哲學）。時間只影響畫面（色調、日夜明暗、時鐘）與天氣抽籤，不動同步與伺服器。
const TIME_DAY_MS = 24 * 60e3;               // 一個遊戲日＝現實 24 分鐘
const TIME_DAYS_PER_SEASON = 7;              // 一季 7 個遊戲日（一年＝28 日）
const SEASONS = [['spring', '春'], ['summer', '夏'], ['autumn', '秋'], ['winter', '冬']];
const TIME_EPOCH_MS = Date.UTC(2026, 0, 1);  // 「第 1 年第 1 天（春・第 1 天）」的起點＝現實 2026-01-01 00:00 UTC
function gameTime() {   // 現在是遊戲裡的哪一年／哪一季第幾天／幾點（無狀態，每次都從 Date.now() 現算）
  const t = Date.now() - TIME_EPOCH_MS, perYear = TIME_DAYS_PER_SEASON * 4;
  const days = Math.floor(t / TIME_DAY_MS);
  const inYear = ((days % perYear) + perYear) % perYear;
  const si = Math.floor(inYear / TIME_DAYS_PER_SEASON);
  const frac = ((t % TIME_DAY_MS) + TIME_DAY_MS) % TIME_DAY_MS / TIME_DAY_MS;   // 一天內進度 0..1（0＝00:00）
  const hh = frac * 24;
  return { year: Math.floor(days / perYear) + 1, si, season: SEASONS[si][0], seasonName: SEASONS[si][1],
           day: inYear % TIME_DAYS_PER_SEASON + 1, hour: Math.floor(hh), min: Math.floor((hh % 1) * 60) };
}

// 現在是不是夜晚（2026-11-14 使用者定：19:00~04:00）——夜行怪（mobs.json 的 night）只在這個時段出現，天亮全數退場。
// 跟畫面全暗的時段一致（nightDark(h)===1 的範圍）；清晨 4-6、黃昏 17-19 的漸變時段不算夜晚。
const isNight = () => { const h = gameTime().hour; return h >= 19 || h < 4; };

// 決定論：天氣＝雜湊(地形, 時刻槽) 對該地形的天氣表加權抽籤——每個人自己算、算出來都一樣，不用同步、玩家也影響不了。
// 之後的交互作用（掛點）：特殊怪照天氣條件出現（mobs.json 的 spawnIf）、植物生長受天氣影響（動工前先查採集重生是本機還是伺服器）。
const WEATHER_SLOT_MIN = 8;      // 一個時刻槽幾分鐘：槽內天氣不變、槽與槽之間用 WEATHER_TRANS_SEC 淡入淡出
const WEATHER_TRANS_SEC = 40;    // 換槽時，前一個天氣 → 新天氣的色罩與粒子密度過渡秒數
const WEATHERS = {   // id → 名稱／色罩（rgba 三元組＋最濃不透明度）／粒子（kind＋數量＋速度等；n＝滿量時的顆數）
  clear:   { name: '晴' },
  rain:    { name: '雨',   tint: [40, 62, 92],    alpha: .16, part: { kind: 'rain',    n: 110, vy: 520, vx: -64, len: 13 } },
  // 雪（2026-11-13 使用者回報看不到：白雪片落在全白雪地上零對比）——色罩改成「結冰感」的冰藍
  // 漸層（同日使用者定：參考結冰圖，畫面周邊冰藍、越遠越濃；腳色周邊保持清楚 → depth 徑向漸層）；
  // 雪片用柔邊漸層加大（實心小點在白地上仍不夠明顯）
  snow:    { name: '雪',   tint: [148, 182, 220], alpha: .55, near: .03, mid: .16, far: .34, core: .1, vis: .85, depth: true,
             part: { kind: 'snow', n: 120, vy: 52, vx: 18, sway: 26, r: 2.6 } },
  // 霧（2026-11-13 使用者定：要有「一片濛濛、能見度越遠越低」的縱深霧感，參考 FF14 起霧）：
  // depth: true → 不用全畫面平均色罩，改畫以玩家為中心的徑向漸層：身邊（near）幾乎清楚、中距離（mid）、
  // 遠處（far）到能見度半徑（vis×畫面短邊）以外（alpha）整片白濛；core＝身邊這個比例內維持最清楚的濃度
  fog:     { name: '霧',   tint: [230, 237, 244], alpha: .95, near: .05, mid: .4, far: .75, core: .1, vis: .8, depth: true, part: { kind: 'fog', n: 24, vx: 12, r: 120 } },
  // 沙暴（2026-11-13 使用者定：跟霧一樣改玩家中心的徑向漸層——黃沙色、越遠越看不清；濃度比霧低很多，是沙塵感不是白牆）
  sand:    { name: '沙暴', tint: [224, 196, 128], alpha: .78, near: .02, mid: .14, far: .42, core: .1, vis: .85, depth: true, part: { kind: 'sand', n: 70, vy: 26, vx: -215, len: 9 } },
  // 落灰（2026-11-13 使用者定「再明顯一點」：原 tint .09＋1.8px 小方點在暗紅地形上幾乎看不到）：
  // 橘紅色罩加深；粒子兩種——亮橘火點往上飄＋同款柔邊的黑灰往下落（同日使用者定）
  ember:   { name: '落灰', tint: [255, 96, 30],   alpha: .16, parts: [
             { kind: 'ember', n: 80, vy: -34, vx: 16, r: 2.2 },
             { kind: 'ash',   n: 46, vy: 46,  vx: 10, sway: 18, r: 2.4 }] },
  leaf:    { name: '落葉', part: { kind: 'leaf', n: 24, vy: 42, vx: -34, sway: 42, r: 2.6 } },
  firefly: { name: '螢光', tint: [30, 36, 70],    alpha: .08, part: { kind: 'firefly', n: 26,  vy: -12, vx: 8, r: 1.4 } },
};
// 各地形的天氣表（id＝權重）。和平島是室內房間：不做天氣（永遠晴）
// 草原／沙灘／森林／機械島各自多列一條 ['snow', …]：非冬天被季節倍率乘成 0（永遠抽不到），冬天才下雪（四季感）
const TERRAIN_WEATHER = {
  grass:   [['clear', 6], ['rain', 2], ['leaf', 1], ['fog', 1], ['snow', 3]],
  beach:   [['clear', 6], ['rain', 2], ['sand', 1], ['fog', 1], ['snow', 2]],
  forest:  [['clear', 5], ['rain', 2], ['leaf', 2], ['fog', 1], ['snow', 3]],
  snow:    [['clear', 5], ['snow', 3], ['fog', 1]],
  night:   [['clear', 5], ['rain', 1], ['fog', 2], ['firefly', 2]],
  volcano: [['clear', 5], ['ember', 3], ['fog', 2]],
  machine: [['clear', 6], ['rain', 2], ['fog', 2], ['snow', 2]],
  peace:   [['clear', 1]],
};
function weatherHash(s) {   // FNV-1a：純整數運算，各瀏覽器結果一致（決定論的關鍵）
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// 時刻槽＝遊戲時間的 8 小時一格（＝現實 8 分鐘，一天 3 槽）。起點對齊遊戲日，所以槽界線與日／季界線重合：換季只在槽界線發生
function weatherSlot() { return Math.floor((Date.now() - TIME_EPOCH_MS) / 60000 / WEATHER_SLOT_MIN); }
// 季節加權：同一（地形, 槽）在四季抽出的天氣不同——冬天下雪、夏天炎熱／落灰、秋天落葉、春天多雨與螢火
// （倍率＝乘在原表權重上；0＝該季節永遠抽不到。乘成小數沒關係，各瀏覽器浮點運算結果一致，維持決定論）
const SEASON_WX = {
  clear:   { spring: 1.1, summer: 1.2, autumn: 1.0, winter: .6 },
  rain:    { spring: 1.6, summer: .7,  autumn: 1.3, winter: .5 },
  snow:    { spring: 0,   summer: 0,   autumn: 0,   winter: 1 },
  fog:     { spring: 1.2, summer: .5,  autumn: 1.7, winter: 1.1 },
  sand:    { spring: .7,  summer: 1.6, autumn: 1.0, winter: .4 },
  ember:   { spring: .4,  summer: 2,   autumn: .7,  winter: .3 },
  leaf:    { spring: .3,  summer: 0,   autumn: 4,   winter: .1 },
  firefly: { spring: 2.2, summer: 2.6, autumn: .7,  winter: 0 },
};
const seasonMul = (id, season) => SEASON_WX[id] ? (SEASON_WX[id][season] ?? 1) : 1;
function weatherPick(T, slot, season) {   // 同一（地形, 槽, 季節）永遠同一種天氣
  const tab = TERRAIN_WEATHER[T] || TERRAIN_WEATHER.grass;
  const wts = tab.map(([id, w]) => [id, w * seasonMul(id, season)]);
  const sum = wts.reduce((s, w) => s + w[1], 0);
  if (sum <= 0) return tab[0][0];   // 保險：全部被乘成 0 就退回晴（正常不會發生，clear 的倍率不為 0）
  let r = weatherHash(T + ':' + slot + ':' + season) % sum;
  for (const [id, w] of wts) { if ((r -= w) < 0) return id; }
  return wts[0][0];
}
function weatherBlend() {   // 槽內經過率 0→1：色罩與粒子數在槽剛開始的 WEATHER_TRANS_SEC 內從上一個天氣過來
  return Math.min(1, (S.t - S.weather.t0) / WEATHER_TRANS_SEC);
}
function stepWeather(dt) {   // 換槽／換地形時切天氣；粒子池在 drawWeather 維護（每幀順手補齊）；dt 留給 drawWeather 的粒子步進
  S.weatherDt = dt;
  const T = S.terrain, slot = weatherSlot(), season = gameTime().season;
  if (!S.weather || S.weather.T !== T)   // 進新地形：從「晴」淡入當前天氣
    S.weather = { T, slot, prev: 'clear', cur: weatherPick(T, slot, season), t0: S.t, parts: [] };
  else if (S.weather.slot !== slot) {   // 換槽（含換季，時格對齊遊戲日／季界線）
    S.weather.prev = S.weather.cur;
    S.weather.cur = weatherPick(T, slot, season);
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
  // 粒子池：目標顆數在過渡期跟著 blend 從前一個天氣的量走向當前的量；
  // 天氣可以有多種粒子（parts 陣列，例如落灰＝火點往上＋黑灰往下；單種的照舊寫 part）
  const PA0 = P0.parts || (P0.part ? [P0.part] : []), PA1 = P1.parts || (P1.part ? [P1.part] : []);
  const nOf = A => A.reduce((s, d) => s + d.n, 0);
  const n0 = nOf(PA0), n1 = nOf(PA1);
  let target = Math.round(n0 + (n1 - n0) * bl);
  if (w.cur === 'clear' && bl >= 1) target = 0;
  const pickDef = A => { let r = Math.random() * nOf(A); for (const d of A) { if ((r -= d.n) < 0) return d; } return A[A.length - 1]; };
  const parts = w.parts;
  while (parts.length < target) { const def = pickDef(n1 >= n0 ? PA1 : PA0); const p = {}; weatherSpawn(p, def.kind); parts.push(p); }
  if (parts.length > target) parts.length = target;
  if (!parts.length) return;
  for (const p of parts) {
    const d = PA1.find(x => x.kind === p.kind) || PA0.find(x => x.kind === p.kind) || PA1[0] || PA0[0];
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
    } else if (d.kind === 'sand') {   // 沙線：沿線方向漸層、兩端淡出到透明（實心線兩端會看出「明顯的邊緣」，2026-11-13 使用者定）
      const g2 = ctx.createLinearGradient(p.x, p.y, p.x - d.len, p.y + d.len * .3);
      g2.addColorStop(0, 'rgba(238,206,150,0)');
      g2.addColorStop(.45, 'rgba(238,206,150,.34)');
      g2.addColorStop(1, 'rgba(238,206,150,0)');
      ctx.strokeStyle = g2; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - d.len, p.y + d.len * .3); ctx.stroke();
    } else if (d.kind === 'fog') {   // 霧團：徑向漸層（中心稍濃、往外淡到透明），看不出圓形輪廓（2026-11-13 使用者定：實心圓會被看出「圓圓的白色」）
      const r = d.r * (0.8 + .2 * Math.sin(p.ph * .7)), a = .075 + .04 * Math.sin(p.ph);
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, `rgba(236,242,248,${(a * .9).toFixed(3)})`);
      gr.addColorStop(.5, `rgba(236,242,248,${(a * .55).toFixed(3)})`);
      gr.addColorStop(.8, `rgba(236,242,248,${(a * .18).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(236,242,248,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'ember') {   // 落灰：亮橘火點＋柔光暈（原本 1.8px 實心小方點，太暗看不出來；2026-11-13 使用者定再明顯一點）
      const tw = Math.sin(p.ph * 2) * .5 + .5;   // 明滅 0→1
      const rr = d.r * 3.2;
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      gr.addColorStop(0, `rgba(255,${170 + 55 * tw | 0},80,${(.25 + .55 * tw).toFixed(3)})`);
      gr.addColorStop(.4, `rgba(255,120,40,${(.28 * tw + .06).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(255,100,30,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'ash') {   // 黑灰：跟火點同款的柔邊做法、但暗色往下落（2026-11-13 使用者定，跟落灰的火點一起出現）
      const a = .34 + .16 * Math.sin(p.ph);
      const rr = d.r * 2.2;
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      gr.addColorStop(0, `rgba(26,24,26,${a.toFixed(3)})`);
      gr.addColorStop(.55, `rgba(34,30,30,${(a * .55).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(34,30,30,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'firefly') {
      const a = .3 + .45 * (Math.sin(p.ph * 2.2) * .5 + .5);
      ctx.fillStyle = `rgba(190,255,190,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, d.r, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'leaf') {
      ctx.fillStyle = `rgba(${150 + 70 * Math.sin(p.ph) | 0},170,80,.75)`;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ph);
      ctx.fillRect(-d.r, -d.r * .4, d.r * 2, d.r * .8); ctx.restore();
    } else {   // snow：柔邊漸層雪片（白芯 → 淡藍邊 → 透明；實心小圓在白地上對比不夠，2026-11-13 使用者回報看不到）
      const a = .62 + .25 * Math.sin(p.ph * 2);
      const rr = d.r * 1.6;
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      gr.addColorStop(0, `rgba(250,252,255,${a.toFixed(3)})`);
      gr.addColorStop(.55, `rgba(238,244,252,${(a * .7).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(225,234,246,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
// 季節色調與日夜明暗（2026-11-13 使用者定；螢幕空間，蓋在世界與名牌上、天氣之下）：
// 季節＝淡淡的氛圍色罩（春夏秋冬各一色），日夜＝遊戲時刻的明暗（深夜最暗，黎明 4-6 點、黃昏 17-19 點過渡，
// 過渡到一半時疊一層暖橙＝朝霞／晚霞）。和平島是室內房間：照明固定，兩者都不套。
const SEASON_TINT = {   // [r, g, b, alpha]
  spring: [120, 190, 130, .05],
  summer: [255, 205, 110, .06],
  autumn: [235, 150, 70, .07],
  winter: [150, 190, 235, .08],
};
const NIGHT_ALPHA = .42;   // 深夜最濃的暗度（0＝不變暗；調太高會看不清路）
function nightDark(h) {    // 幾點 → 暗度 0（白天）～1（深夜）；清晨 4-6、黃昏 17-19 線性過渡
  if (h < 4) return 1;
  if (h < 6) return (6 - h) / 2;
  if (h < 17) return 0;
  if (h < 19) return (h - 17) / 2;
  return 1;
}
function drawTimeTint() {
  if (S.terrain === 'peace') return;   // 室內：不套季節色調與日夜明暗
  const g = gameTime(), st = SEASON_TINT[g.season];
  if (st) { ctx.fillStyle = `rgba(${st[0]},${st[1]},${st[2]},${st[3]})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  const dk = nightDark(g.hour + g.min / 60);
  if (dk > 0) { ctx.fillStyle = `rgba(12,18,48,${(dk * NIGHT_ALPHA).toFixed(3)})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  const warm = 1 - Math.abs(dk - .5) * 2;   // 暗度到一半（黎明／黃昏）時最濃的暖橙
  if (warm > 0) { ctx.fillStyle = `rgba(255,140,70,${(warm * .1).toFixed(3)})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
}
// 左上角的遊戲時鐘（每次 loop 更新；文字沒變就不動 DOM）：顯示「年 季・第幾天 時:分」，季節各自一色
const SEASON_COLOR = { spring: '#8fd18f', summer: '#f0c46a', autumn: '#e79a63', winter: '#9fc4f0' };
let lastClockText = '';
function updateClock() {
  const g = gameTime();
  const txt = `${g.seasonName}・第${g.day}天 ${String(g.hour).padStart(2, '0')}:${String(g.min).padStart(2, '0')}`;
  if (txt === lastClockText) return;
  lastClockText = txt;
  const el = $('gameClock'); if (!el) return;
  el.textContent = txt;
  el.style.color = SEASON_COLOR[g.season] || '';
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
    const t = secretCell(x, y, T) ? 0 : S.world.types[y * COLS + x];   // 隱藏區不畫在小地圖上
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
  const hid = (px, py) => inSecretArea(Math.floor(px / CELL), Math.floor(py / CELL));   // 在隱藏區裡的人不上小地圖
  for (const r of S.remotes.values()) if (r.x != null && !hid(r.x, r.y)) dot(r.x, r.y, '#e8c86a', 1.6);
  const me = S.players[0];
  if (me && !hid(me.x, me.y)) { dot(me.x, me.y, '#14100a', 3.2); dot(me.x, me.y, '#f4f8fc', 2); }
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
  updateSecret();
  // 鏡頭跟隨（任何人多時也可提供跟隨對象）
  const me = S.players[0] || { x: 0, y: 0 };
  let camX = me.x - canvas.width / 2, camY = me.y - canvas.height * .58;
  // 大螢幕的觀看視角（眼睛按鈕）：角色動了、換島、倒下就取消；鏡頭在跟隨角色與「以螢幕為中心」之間平滑移動
  if (S.scrView && (Math.abs(me.x - S.scrView.x) > 1 || Math.abs(me.y - S.scrView.y) > 1 || T !== 'peace' || me.dead)) { S.scrView = null; S.scrWatchNext = 0; }
  const camNow = performance.now(), camDt = Math.min(.1, (camNow - (S.camAt || camNow)) / 1000); S.camAt = camNow;
  S.scrViewK = clamp((S.scrViewK || 0) + (S.scrView ? 1 : -1) * camDt * 3.5, 0, 1);
  if (S.scrViewK > 0) {
    const spr = T === 'peace' ? propsHere().find(p => p.kind === 'screen') : null;
    if (!spr) S.scrViewK = 0;
    else { const r = propRect(spr), k = S.scrViewK * S.scrViewK * (3 - 2 * S.scrViewK); camX += (r.x + r.w / 2 - canvas.width / 2 - camX) * k; camY += (r.y + r.h / 2 - canvas.height / 2 - camY) * k; }
  }
  S.cam.x = clamp(camX, 0, COLS * CELL - canvas.width);
  S.cam.y = clamp(camY, 0, ROWS * CELL - canvas.height);
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
    if (!spr || (roomBox && !inRoom(x, y) && !(S.secretOpen && secretCell(x, y)))) continue;   // 室內地形：房間外留黑（隱藏區打開時才畫）
    if (t === 2 && groundRep > 1) {   // 地面圖是 n×n 格的大圖（和平島室內地板的方磚放大 n 倍）：每格畫其中對應的一塊
      const fw = spr.fw / groundRep, fh = spr.fh / groundRep;
      ctx.drawImage(spr.img, (x % groundRep) * fw, (y % groundRep) * fh, fw, fh, x * CELL, y * CELL, CELL, CELL);
      continue;
    }
    drawSpr(spr, spr.stagger ? (tileFi[t] + x * 7 + y * 13) % spr.frames : tileFi[t], x * CELL, y * CELL, CELL, CELL);
  }
  if (roomBox && tMan.walls) drawRoomWalls(tMan.walls, ims, roomBox);   // 室內房間的東北西三面牆（房間外，畫在地面之後、物件之前）
  const secret = tMan.secret;
  if (secret && S.secretOpen) drawSecretRoom(secret, tMan.walls, ims);   // 隱藏區：只有走進門簾後面才畫
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
  petEntries(list, ctx);    // 跟隨寵物
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
    const def = furnitureDef(it.type), img = furnImg(it.type, it.dir); if (!img) return;
    const fd = furnDimsOf(def, it.dir || 0);
    if (offView(it.cell[0] * CELL, (it.cell[1] + fd.h) * CELL, Math.max(fd.w * CELL, img.width * SC), img.height * SC, def.text ? 90 : 4)) return;
    list.push({
      y: (it.cell[1] + fd.h) * CELL - 1,
      draw: () => {
        ctx.save();
        if (idx === S.pickedIdx) ctx.globalAlpha = .5;
        drawSpr(img, sprFrame(img, cellPhase(it.cell[0], it.cell[1])), it.cell[0] * CELL, (it.cell[1] + fd.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
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
        const wi = !p.npc && wid !== 'tome' ? weaponImgFor(wid, p.tool ? null : myLook().wlook, S.me.race) : null;
        drawNoulithIdle(p, p.npc ? null : wid, 'back');
        drawPerson(p, wi, p.npc ? (p.guide ? '#ffd86b' : '#bcd8e8') : '#ffffff');
        drawNoulithIdle(p, p.npc ? null : wid, 'front');
      }
    });
  }
  // M2：同島的其他玩家
  for (const r of S.remotes.values()) {
    if (r.dead) { list.push(tombEntry(r.x, r.y, r.name, DEAD_SECONDS - (performance.now() - (r.deadAt || performance.now())) / 1000)); continue; }
    remotePetEntries(list, ctx, r);   // 對方的跟隨寵物（各自模擬）
    list.push({
      y: r.y + (r.pose ? 2 : 0),
      draw: () => {   // 同島的人用暖金色名牌區分；賢具同樣不畫腰間武器圖
        drawNoulithIdle(r, r.weapon, 'back');
        drawPerson(r, r.weapon === 'tome' ? null : weaponImgFor(r.weapon, r.look?.wlook, r.look?.race), '#ffe9a8');
        drawNoulithIdle(r, r.weapon, 'front');
      }
    });
  }
  if (secret && ims[secret.curtain]) {   // 門簾：蓋住北牆的門洞，排序鍵＝牆腳（走進門洞的人會被簾子擋住）
    const d = secret.door;
    list.push({ y: (d[3] + 1) * CELL, draw: () => drawSpr(ims[secret.curtain], 0, d[0] * CELL, d[1] * CELL, (d[2] - d[0] + 1) * CELL, (d[3] - d[1] + 1) * CELL) });
  }
  const shown = secret && !S.secretOpen ? list.filter(o => o.y >= secret.door[1] * CELL) : list;   // 隱藏區沒打開：裡面的機台、別人、名牌一律不畫
  shown.sort((a, b) => a.y - b.y).forEach(o => o.draw());

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
    const def = furnitureDef(S.sel), img = furnImg(S.sel, S.rot || 0);
    const fd = furnDimsOf(def, S.rot || 0), [mx, my] = S.mouseCell, w = fd.w * CELL, h = fd.h * CELL;
    const valid = canPlace(S.sel, mx, my, S.rot || 0);
    ctx.fillStyle = valid ? 'rgba(90,220,120,.28)' : 'rgba(220,80,80,.3)';
    ctx.fillRect(mx * CELL, my * CELL, w, h);
    ctx.globalAlpha = .75;
    drawSpr(img, sprFrame(img), mx * CELL, (my + fd.h) * CELL - img.height * SC, img.width * SC, img.height * SC);
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
  drawTimeTint();   // 季節色調與日夜明暗（螢幕空間，蓋在世界與名牌上、天氣之下）
  drawWeather();   // 天氣色罩與粒子（螢幕空間，蓋在世界與名牌上、島主倒數條之下）
  drawFoodScreen();   // 吃喝的效果：致盲的黑幕、神清氣爽的星點（螢幕空間）
  drawMinimap();   // 小地圖（螢幕空間右上角；圖鑑／角色等 DOM 面板天然蓋在畫布上層）
  if (ownerBar) drawOwnerCastBar(ownerBar.frac, ownerBar.name);   // 島主讀條固定在視窗上方置中（世界座標還原後畫，永遠在最上層）
  drawOwnerLineBanner();   // 島主台詞：除了頭上的泡泡，也固定顯示在視窗上方（離島主太遠、泡泡在畫面外也看得到）
}

const MAX_FURN = 500;   // 每個地形的擺設上限（與兩份伺服器的 MAX_FURN 一致）
function canPlace(typeId, x, y, dir = 0) {
  const def = furnDimsOf(furnitureDef(typeId), dir);
  for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) return false;
    if (!groundAt(xx, yy) || inSecretArea(xx, yy)) return false;   // 水上要先鋪地板；隱藏區不能擺
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
const floorCellOk = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !inSecretArea(x, y);   // 地板可以鋪在水上
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
const cloneFurn = list => list.map(it => { const o = { type: it.type, cell: [it.cell[0], it.cell[1]] }; if (it.text) o.text = it.text; if (it.dir) o.dir = it.dir; return o; });
const furnCovers = (it, cell) => {
  const d = itemDims(it);
  return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
};
// 在指定清單上能不能放（範圍、水邊〔水上要有地板 floor〕、與清單內家具重疊）；規則與兩份伺服器一致
function canPlaceIn(list, typeId, x, y, floor = S.floorMap, dir = 0) {
  if (!furnitureDef(typeId)) return false;
  const def = furnDimsOf(furnitureDef(typeId), dir);
  for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS || !groundAt(xx, yy, floor) || inSecretArea(xx, yy) || tableAtCell(xx, yy) || propAtCell(xx, yy)) return false;
  }
  return !list.some(it => { const d = itemDims(it);
    return x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h; });
}
// 把一個家具操作套到清單上（直接改 list；不合法的略過）
function applyFurnOpTo(list, op, floor = S.floorMap) {
  if (op.t === 'clear') list.length = 0;
  else if (op.t === 'remove') { const i = list.findIndex(it => furnCovers(it, op.cell)); if (i >= 0) list.splice(i, 1); }
  else if (op.t === 'place' && canPlaceIn(list, op.type, op.cell[0], op.cell[1], floor, op.dir || 0)) {
    const o = { type: op.type, cell: [op.cell[0], op.cell[1]] }; if (op.dir) o.dir = op.dir; list.push(o);
  } else if (op.t === 'rotate') {   // 旋轉已擺好的家具（點到它的任一格）；dir 0＝正面（不存欄位）
    const it = list.find(o => furnCovers(o, op.cell));
    if (it) {
      const od = itemDims(it), nd = furnDimsOf(furnitureDef(it.type), op.dir || 0);
      if ((od.w !== nd.w || od.h !== nd.h) && !canPlaceIn(list.filter(o => o !== it), it.type, it.cell[0], it.cell[1], floor, op.dir || 0)) return;   // 寬高互換（床）：新佔到的格子被擋住就不轉
      if (op.dir) it.dir = op.dir; else delete it.dir;
    }
  }
}
// 裝飾模式按 R：游標指著已擺好的家具就轉那一件（記成草稿，按「完成」才保存）；沒指著就轉「下一件要放的」預覽方向
function decorRotate() {
  if (S.mode !== 'decor' || S.decorTab !== 'furn') return;
  const it = S.mouseCell && S.furnItems.find(o => furnCovers(o, S.mouseCell));
  if (it) {
    const nd = ((it.dir || 0) + 1) % 4;
    if (S.draft.length >= 300) { toast('未保存的變動太多了，請先按「完成」保存'); return; }
    stageOp({ t: 'rotate', cell: [it.cell[0], it.cell[1]], dir: nd });
    toast(`${furnitureDef(it.type)?.name || '家具'}：${FURN_DIR_NAME[nd]}`, 900);
  } else {
    S.rot = ((S.rot || 0) + 1) % 4;
    toast(`下一件要放的方向：${FURN_DIR_NAME[S.rot]}`, 900);
  }
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
  S.mode = 'decor'; S.rot = 0; S.draft = []; S.baseFurn = cloneFurn(S.furnItems); S.baseFloor = new Map(S.floorMap); S.paint = null;
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
    S.scr = null; S.scrList = null; S.scrWatching = false; vidStop(); closeScrPick(); scrRender();   // 大螢幕只在和平島；走近螢幕時才會送 scr_watch 收畫面
    if (S.listOpen) { S.listSig = null; buildPlayerList(); }   // 線上列表開著：馬上清掉舊島的人，新島的人到了由計時器補上
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
                                       : '左鍵放置／右鍵移除 · R 旋轉（指著已擺的家具轉那一件）· 按「完成」才會保存 · E／Esc 離開';
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
    div.onclick = () => { S.sel = it.id; S.rot = 0; buildFurnPanel(); };   // 每次選取家具都從正面開始（朝向 0）
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
// 預設外觀（2026-11-23 使用者定）：新人類系列現在整套衣服是「外觀」（2026-11-25 預設改男式西裝外套／西裝褲／皮鞋；女式西裝仍可在外觀選），
// 職業裝備沒有自己的圖時，每個職業預設顯示這三件。**2026-11-27 簡化**：預設只在「顯示時」判斷（見 shownItem），不再寫進存檔——存檔的 glam 只放使用者真的選過的外觀，
// glamOff＝使用者按了「不使用外觀」（才會回到職業裝備）。（之前把預設寫進存檔，跟使用者自己選的長得一模一樣，後來要清掉舊的只能用「等於預設就刪」去猜，結果把使用者選的男式西裝也刪了。）
const DEFAULT_GLAM = { top: 'suit_jacket_m', bottom: 'suit_pants_m', shoe: 'leather_shoes_m' };
function wardrobe(job = S.me.job) {
  const w = (S.me.wardrobe && typeof S.me.wardrobe === 'object') ? S.me.wardrobe : (S.me.wardrobe = {});
  const e = w[job] && typeof w[job] === 'object' ? w[job] : (w[job] = {});
  e.glam ||= {}; e.color ||= {}; e.glamOff ||= {};
  if (!e.glamV) {   // 舊存檔只清一次：舊版把預設外觀自動寫進存檔；職業裝備後來有了自己的圖（keepGear），那些自動寫入的要拿掉，不然永遠蓋住新裝備
    e.glamV = 2;
    for (const [slot, gid] of Object.entries(DEFAULT_GLAM)) if (e.glam[slot] === gid && lookItem(slotList(slot), JOBS[job]?.gear?.[slot])?.keepGear) delete e.glam[slot];
  }
  if (e.glam.weapon === 'goldsword') e.glam.weapon = 'sword_gold';   // 舊的「金劍」外觀（2026-11-09 拿掉）→ 長劍的金黃發光版（解鎖條件同樣是打倒黃金肥龍）
  return e;
}
// 某部位現在顯示哪一件（外觀優先；外觀失效＝沒解鎖／不適用就退回裝備）
function shownItem(slot, job = S.me.job) {
  const g = wardrobe(job).glam[slot], it = g && lookItem(slotList(slot), g);
  if (it && glamFits(slot, it, job) && glamUnlocked(it)) return it;
  if (slot === 'weapon') return jobWeaponDef(job);
  const list = slotList(slot) || [], gear = lookItem(list, JOBS[job]?.gear?.[slot]);   // 服裝男女共用一個 id（女角在 charSprite 改用 sheetF）
  if (gear?.keepGear) return gear;   // 沒選外觀、職業裝備有自己的圖：顯示裝備
  const def = DEFAULT_GLAM[slot] && !wardrobe(job).glamOff[slot] ? lookItem(list, DEFAULT_GLAM[slot]) : null;   // 裝備沒有自己的圖：顯示預設外觀（除非使用者按了「不使用外觀」）
  return def && glamFits(slot, def, job) && glamUnlocked(def) ? def : gear;
}
// 自己的顯示造型（畫自己、送給同島的人都用這個；外觀與裝備在這裡就決定好，別人只看結果）
function myLook() {
  const c = wardrobe().color, w = shownItem('weapon');
  const own = ownRaceOf(S.me.race);   // 新風格：髮型／服裝款式放進 look.hair／look.top（款式 id，同步不用改伺服器）
  const ownHair = own && chibiStyleOf(own.own, 'hair', S.me.cHair)?.id;
  return { skin: S.me.skin, hair: ownHair || S.me.hair, race: own?.id || 'human2',
           hat: shownItem('hat')?.id || null, top: shownItem('top')?.id || null, bottom: shownItem('bottom')?.id || null,
           shoe: shownItem('shoe')?.id || null,
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
  lookChips($('raceOpts'), (S.avatar.races || []).map(r => ({ id: r.id, name: r.name, title: r.scale && r.scale !== 1 ? `體型 ×${r.scale}` : '' })),
            ownRaceOf(S.me.race)?.id, v => { S.me.race = v; });
  // 等級：XP 進度條（無上限，每級需求 10 + 5×(Lv−1)；來源＝怪物／釣竿／首捕／採集，2026-11-06）
  const li = lvInfo(S.profile.xp);
  $('lvCur').textContent = `Lv.${li.lv}`;
  $('lvFill').style.width = Math.min(100, Math.round(li.cur / li.need * 100)) + '%';
  $('lvRow').title = `經驗值 ${li.cur} / ${li.need}`;
  $('chipsCur').textContent = `${S.chips.toLocaleString('en-US')} 枚`;
  $('chipsRow').title = '籌碼＝經驗值×100（賭博遊戲下注用）';
  // 職業：jobs.json（職能＝圓點顏色；滑鼠停留顯示職能說明）
  const jb = $('jobOpts'); jb.innerHTML = '';
  for (const id of Object.keys(JOBS)) {
    if (JOBS[id].hidden) continue;   // 暫時隱藏的職業不列
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
  const ownRace = ownRaceOf(S.me.race);
  if (ownRace?.own.styles?.hair) {   // 新風格：髮型款式（自己畫的），髮色用同一個換色鈕
    const hairHost = $('hairOpts');
    lookChips(hairHost, ownRace.own.styles.hair, chibiStyleOf(ownRace.own, 'hair', S.me.cHair)?.id, v => { S.me.cHair = v; });
    const hb = document.createElement('button'); hb.className = 'ff-btn small dye-btn'; hb.title = LOOK_COLOR.hairC;
    const hsw = document.createElement('span'); hsw.className = 'dye-sw'; hsw.style.background = S.me.hairC || ownRace.own.dye.find(r => r.slot === 'hair').colors[0];
    hb.append(hsw, document.createTextNode('換色'));
    hb.onclick = () => toggleColor('hairC', { name: '髮色', hex: ownRace.own.dye.find(r => r.slot === 'hair').colors[0], dye: ownRace.own.dye.find(r => r.slot === 'hair').colors });
    hairHost.appendChild(hb);
  }
  const eyeDye = ownRace?.own.dye?.find(r => r.slot === 'eye');
  if (eyeDye) {   // 自己畫眼睛的種族（新人類）：LPC 的眼神樣式用不到，只留一個換色鈕（換眼珠的灰色）
    const eh = $('eyesOpts'); eh.innerHTML = '';
    const eb = document.createElement('button'); eb.className = 'ff-btn small dye-btn'; eb.title = LOOK_COLOR.eyeC;
    const esw = document.createElement('span'); esw.className = 'dye-sw'; esw.style.background = S.me.eyeC || eyeDye.colors[0];
    eb.append(esw, document.createTextNode('換色'));
    eb.onclick = () => toggleColor('eyeC', { name: '眼睛顏色', hex: eyeDye.colors[0], dye: eyeDye.colors });
    eh.appendChild(eb);
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
    o.className = 'title-row' + (ok ? '' : ' locked') + ((id ? cur?.id === id && cur?.id !== gearIt?.id : cur?.id === gearIt?.id) ? ' sel' : '');
    const nm = document.createElement('div'); nm.className = 'title-name'; nm.textContent = name;
    const ds = document.createElement('div'); ds.className = 'title-desc'; ds.textContent = desc;
    o.append(nm, ds);
    if (ok) o.onclick = () => { if (id) { wr.glam[slot] = id; delete wr.glamOff[slot]; } else { delete wr.glam[slot]; wr.glamOff[slot] = true; } saveAvatar(); buildAvatarPanel(); buildGlams(); };
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
  if (look) {   // 外貌（髮色、眼睛顏色）：沒有預設色，只有原色（目前選的那一色）與下面的調色盤
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
const wheelBlocked = () => S.gachaOpen || S.clawOpen || S.mode !== 'walk' || S.helpOpen || S.skillOpen || S.scrPickOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.colorOpen || S.glamOpen || S.signOpen || S.confirmOpen;
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
  if (S.clawOpen) return;   // 夾娃娃機開著：按鍵由 claw.js 自己處理（Esc 關閉），不能走路
  if (S.gachaOpen) { if (k === 'escape') { e.preventDefault(); S.gacha?.escape(); } return; }   // 扭蛋機開著：Esc 快轉／關閉，其他鍵不處理（不能走路）
  if (S.tableOpen) {   // 遊戲畫面開著：Esc 離開；五子棋復盤時 ←／→／Home／End 切換步數；其他鍵都不處理（不能走路）
    if (k === 'escape') { e.preventDefault(); if (!$('rulesBox').classList.contains('hidden')) rulesShow(false); else leaveTable(); }   // 規則視窗開著：Esc 先關；離開確認開著：Esc＝取消規則
    else if (S.dg && DG_KEYS[k]) { e.preventDefault(); S.dg.keys[DG_KEYS[k]] = true; }   // 躲彈幕：WASD／方向鍵移動
    else if (S.ar && arKey(e)) { /* 俄羅斯方塊：方向鍵／X／Z／空白鍵／C／Shift */ }
    else if (S.mz && mzKey(e)) { /* 豆豆迷宮：方向鍵／WASD */ }
    else if (S.pb && pbKey(e, true)) { /* 彈珠台：← → 空白 */ }
    else if (S.brk && brkKey(e, true)) { /* 打磚塊：← → 空白 */ }
    else if (S.pl && plKey(e, true)) { /* 星球合成：← → 空白 */ }
    else if (S.tf && tfKey(e, true)) { /* 2048：方向鍵／WASD */ }
    else if (S.bub && bubKey(e, true)) { /* 泡泡射手：← → 空白 */ }
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
  if (S.scrPickOpen) { if (k === 'escape') closeScrPick(); return; }                           // 大螢幕選台視窗開著：Esc 關閉（仍可走路）
  if (S.skillOpen) { if (k === 'escape' || k === 'p') closeSkillInfo(); return; }                // 職業技能說明開著：Esc / P 關閉（仍可走路）
  if (S.helpOpen) { if (k === 'escape' || k === 'enter') closeHelp(); return; }       // 操作說明開著：Esc / Enter 關閉，其他鍵不處理
  if (S.confirmOpen) { if (k === 'escape') closeConfirm(); return; }   // 「要保存嗎？」開著時：Esc＝繼續編輯，其他鍵不處理
  if (k === 'escape' && !$('avatarPanel').classList.contains('hidden')) { closeAvatar(); return; }   // 造型面板開著：Esc 先關面板（不會同時離開裝飾模式）；其他鍵照常
  if (k === 'e' && !e.repeat) {
    if (S.mode === 'decor') requestExitDecor();                       // 離開不受死亡影響
    else if (S.mode === 'walk') { if (S.players[0].dead) toast('你在墓碑裡動不了', 1400); else enterDecor(); }
  }
  if (k === 'escape' && S.mode === 'decor') requestExitDecor();     // Esc 也能離開裝飾模式
  if (k === 'l' && !e.repeat && S.mode === 'walk' && !S.confirmOpen) openList();
  if (k === 'p' && !e.repeat && S.mode === 'walk' && !S.confirmOpen) openSkillInfo();   // P：職業技能說明
  if (k === 'f' && !e.repeat) doAttack(true);
  if (k === 'r' && !e.repeat) { if (S.mode === 'decor') decorRotate(); else roleSkill()?.run(); }   // 裝飾模式：R＝旋轉家具   // R：職能技能（坦克＝挑釁、補師＝群療、近戰輸出＝破綻、遠程輸出＝降傷）
  if ((k === '1' || k === '2') && !e.repeat) tryJobSkill(+k - 1);   // 1／2：職業技能
  if (k === 'shift' && !e.repeat) toggleSprint();   // Shift：切換疾走／步行（與右下角虛擬按鍵同一個開關）
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; arKeyUp(e.key.toLowerCase()); if (S.pb) pbKey(e, false); if (S.brk) brkKey(e, false); if (S.pl) plKey(e, false); if (S.bub) bubKey(e, false); if (S.hk) hkKey(e, false); if (e.key.toLowerCase() === 'f') S.holdSkipF = false; if (S.dg && DG_KEYS[e.key.toLowerCase()]) S.dg.keys[DG_KEYS[e.key.toLowerCase()]] = false; });
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
  // 空手點寵物：玩家不揮拳，寵物被壓一下再彈回去＋愛心（長按自動連擊時不重複觸發、也不揮拳）
  if (!onOwner && S.me.weapon === 'hands') { const pt = petAtPoint(wx, wy); if (pt) { if (!quiet) { aimAt(S.players[0], pt.x, pt.y); petPat(pt); } return; } }   // 摸的時候轉身面向寵物
  // 點到可坐/可睡的家具（椅子、沙發、床）→ 坐下/躺下；再點一次起身。長按自動連擊時不處理，避免反覆切換
  if (!onOwner && !quiet) {
    if (scrEyeAt(wx, wy)) { S.mouseHeld = false; scrViewToggle(); return; }   // 大螢幕旁的眼睛按鈕：觀看視角（不用走近）。mousedown 已經把 mouseHeld 設成 true，不放掉的話「按住滑鼠面向游標」會把剛轉向螢幕的角色轉去游標方向
    if (scrCloseAt(wx, wy)) { S.mouseHeld = false; scrClose(); return; }   // 螢幕的關閉按鈕
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
  if (S.players[0].pose && !(S.players[0].pose === 'sit' && isRod())) return;   // 坐著/睡著不能揮擊（例外：坐椅子拿釣竿可以點水面拋竿）
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
  if (S.mode !== 'walk' || S.helpOpen || S.skillOpen || S.scrPickOpen || S.listOpen || S.signOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.players[0].pose || S.t - S.players[0].lastAtk < ATK_CD) return;
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
  if (S.confirmOpen || S.helpOpen || S.skillOpen || S.scrPickOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.tableOpen) return;
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
  if (canPlace(S.sel, x, y, S.rot || 0)) { stageOp(S.rot ? { t: 'place', type: S.sel, cell: [x, y], dir: S.rot } : { t: 'place', type: S.sel, cell: [x, y] }); toast('放置'); }
  else toast('這裡放不下（水上要先鋪地板／已占用）');
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.confirmOpen || S.helpOpen || S.skillOpen || S.scrPickOpen || S.listOpen || S.dexOpen || S.craftOpen || S.titleOpen || S.tableOpen) return;
  if (S.mode === 'walk') {   // 右鍵和左鍵一樣：點椅子/沙發/床就坐下/躺下，再點一次起身；點遊戲桌就入座／觀戰（2026-11-12 使用者要求）
    const r = canvas.getBoundingClientRect(), wx = e.clientX - r.left + S.cam.x, wy = e.clientY - r.top + S.cam.y;
    const f = furnAtPoint(wx, wy), tb = tableAtPoint(wx, wy), pr = propAtPoint(wx, wy);
    if (scrEyeAt(wx, wy)) scrViewToggle();   // 右鍵點眼睛按鈕也一樣
    else if (scrCloseAt(wx, wy)) scrClose();
    else if (pr) { if (propDist(pr, S.players[0].x, S.players[0].y) < PROP_RANGE) useProp(pr); else toast('走近一點', 1200); }   // 右鍵點餐飲區
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
$('skillClose').onclick = closeSkillInfo;
$('scrClose').onclick = closeScrPick;
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
const menuSfxLabel = () => $('menuSfx').textContent = `提示音效：${S.profile.sfx === false ? '關' : '開'}`;
menuHpLabel(); menuXpLabel(); menuSfxLabel();   // 開先把開關文字對齊存檔
$('menuSfx').onclick = () => {   // 設定 → 提示音效開關（回合提示音＋釣魚上鉤；開的時候順便響一聲試聽）
  S.profile.sfx = S.profile.sfx === false;
  saveProfile(); menuSfxLabel(); sfxWake(); sfxTones(SFX_TURN.start);
};
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
$('settleOk').onclick = settleHide;
$('leaveGo').onclick = () => {
  leaveAsk(false);
  // 伺服器對每條連線的牌桌操作有 100 ms 的最短間隔（TBL_CD）：結算 over 後馬上送 leave 會被丟掉（座位卡在「入座中」），所以結算有送出就等 0.4 秒再關桌子（2026-11-20 修正）
  if (quitScoreNow()) { const id = S.tableId; setTimeout(() => { if (S.tableOpen && S.tableId === id) closeTable(); }, 400); } else closeTable();
};
$('tableRulesBtn').onclick = () => rulesToggle('rules');   // 再點一下關閉
$('tableCharsBtn').onclick = () => rulesToggle('chars');
$('rulesClose').onclick = () => rulesShow(false);
$('btnEmote').onclick = e => { e.stopPropagation(); $('emoteMenu').classList.toggle('hidden'); $('settingsMenu').classList.add('hidden'); };
addEventListener('pointerdown', e => { const m = $('emoteMenu'); if (!m.classList.contains('hidden') && !m.contains(e.target) && e.target.id !== 'btnEmote') m.classList.add('hidden'); });
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
  if (man.secret) { files.add(man.secret.curtain); files.add(man.secret.rug); }   // 隱藏區的門簾與地毯
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
  const [tjson, furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB, craftDB, gamesDB, petsDB] = await Promise.all([
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
    loadJSON('assets/pets/pets.json').catch(() => null),     // 扭蛋寵物（種類／品種／上限）；讀不到就沒有寵物
  ]);
  TERRAIN_IDS.forEach((id, i) => S.terrains[id] = tjson[i]);
  Object.assign(S, { furn, floors, mobsDB, npcDB, toolsDB, avatar, fishDB, skillsDB, titlesDB, jobsDB });
  S.sealImg = await optImg('assets/skills/seal_glyphs.png');   // 忍術結印的梵文字（3 格 18×18）；缺圖就畫文字
  loadJobs(jobsDB);
  initCraft(craftDB);
  S.gamesDB = gamesDB;
  initPets(petsDB, buffBarBuild);   // 還原上次還沒過期的寵物
  S.myLook = myLook;   // net.js 送 state 時用（自己的顯示造型）
  S.myLvl = () => lvInfo(S.profile.xp).lv;   // net.js 送 state 時用（自己的等級；登入者由伺服器覆寫）
  S.floorSizes = new Map(floors.items.map(f => [f.id, { w: f.w || 1, h: f.h || 1 }]));   // 地板占幾格（地毯 2×2，其餘 1×1）
  S.me.job = jobIdOf(S.me.job) || DEFAULT_JOB;   // 舊存檔的坦克／補師／輸出照 legacy 轉成騎士／白魔法師／忍者；沒有或不合法＝忍者
  if (S.me.title && !titleDef(S.me.title)) S.me.title = null;   // 稱號已從清單移除：不顯示
  // 強制稱號（殺寵懲罰）：還有效就重新戴上（分頁重開也接得上）；過期了就恢復本來選的稱號
  const tf = lsObj('dcisland.m0.titleForce', null);
  if (tf && tf.until > Date.now() && PET_KILL_TITLES[tf.id]) {
    S.titleForceId = tf.id; S.titleForceUntil = tf.until;
    if (S.me.title !== tf.id) { S.me.title = tf.id; saveAvatar(); }
  } else if (tf) {
    lsSet('dcisland.m0.titleForce', null);
    if (S.me.title && PET_KILL_TITLES[S.me.title]) { S.me.title = tf.prev ?? null; saveAvatar(); }
  }
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
    ...S.furn.items.flatMap(it => (it.dirs || []).map(async (f, k) => { const im = await loadSpr(`assets/furniture/${f}`, it.anim).catch(() => null); if (im) S.furnImgs[`${it.id}@${k + 1}`] = im; })),   // 朝向 1／2／3 的圖；缺圖就退回正面那張
    // 人物分層 sheet：軀幹（膚色）是必要的（缺了畫不出人），頭髮／衣服／褲子／帽子缺圖就略過那一層
    ...[...(S.avatar.tops || []), ...(S.avatar.bottoms || []), ...(S.avatar.shoes || []), ...(S.avatar.hats || [])]
      .flatMap(it => [it.sheet, it.sheetF, it.dyeFrom]).filter((f, i, a) => f && a.indexOf(f) === i)   // 沒有圖的（不戴帽子的 nohat）不用載；服裝的女版 sheetF 也要載
      .map(async f => S.charImgs[f] = await optImg(`assets/avatar/${f}`)),
    ...S.avatar.weapons.filter(w => w.lpc).flatMap(w => [w.lpc.bg, w.lpc.fg, ...Object.values(w.lpc.over || {}).flatMap(o => [o.bg, o.fg])])   // LPC 武器圖層
      .filter(Boolean).map(async f => S.charImgs[f] = await optImg(`assets/avatar/${f}`)),
    ...(S.avatar.races || []).flatMap(r => [r.ear, r.earBg, r.earFg, ...Object.values(r.own?.sheets || {}), ...Object.values(r.own?.styles || {}).flat().flatMap(x => [...Object.values(x.sheets || {}), ...Object.values(x.erase || {})])]).filter(Boolean)   // 種族耳朵圖層（精靈耳／貓耳前後層）、新風格人物的圖層
      .map(async f => S.charImgs[f] = await loadImg(`assets/avatar/${f}`)),
    ...S.avatar.weapons.filter(w => w.sprite).map(async w => {
      const im = await optImg(`assets/avatar/${w.sprite}`);
      if (im && w.back === 'hilt') im.hiltUp = true;   // 背在背上時劍柄朝上（drawWeaponBack 看這個旗標）
      if (im) im.carry = w.carry === 'waist' ? 'waist' : w.carry === 'hips' ? 'hips' : 'back';   // 不拿在手上時掛哪裡（back 背上、waist 左腰、hips 左右腰各一把）
      if (im && w.carrySprite) { const ci = await optImg(`assets/avatar/${w.carrySprite}`); if (ci) ci.wscale = w.scale || (S.avatar.frames.scale || 2); im.carryImg = ci; }
      if (im && w.rearSprite) { const ri = await optImg(`assets/avatar/${w.rearSprite}`); if (ri) { ri.wscale = w.scale || (S.avatar.frames.scale || 2); im.rearImg = ri; } }   // 背面版（背對時畫這張：劍／短刀只剩劍柄／刀尖）
      if (im && w.sideSprite) { const si = await optImg(`assets/avatar/${w.sideSprite}`); if (si) { si.wscale = w.scale || (S.avatar.frames.scale || 2); im.sideImg = si; } }   // 側面版（掛著、朝左右走時畫這張）   // 掛著時畫另一張圖（例如劍鞘裡的劍）；沒有就用手上那張
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
      stepPets(dt, S.players[0]);   // 跟隨寵物：串火車、過期
      if (S.mouseCell && S.mouseClient) {      // 裝飾模式邊走邊擺：鏡頭在動，滑鼠指的格子要跟著重算
        const r = canvas.getBoundingClientRect();
        S.mouseCell = [Math.floor((S.mouseClient[0] - r.left + S.cam.x) / CELL), Math.floor((S.mouseClient[1] - r.top + S.cam.y) / CELL)];
      }
      paintFloor();                            // 地板模式長按中：游標掃過的格子持續鋪/拆
      for (const r of S.remotes.values()) { stepRemote(r, dt); syncRemotePets(r); stepRemotePets(r, dt); }
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
      scrWatchTick();
      vidTick();   // 大螢幕播放自己放的影片
      updateSkillBar();
      updateStatBars();
      updateClock();     // 左上角的遊戲時間（時鐘、日期、季節）
      stepNightMobs();   // 夜行怪的入夜出現／天亮退場（日夜切換時才做事）
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
    onChips: onNetChips,     // 伺服器的籌碼記帳結果（init／XP 加碼同步；登入者以伺服器為準）
    onCommitResult: onCommitResult,
    onDecos: onNetDecos,
    onDeco: onNetDeco,
    onDragon: onNetDragon,   // 島主事件（aim/hp/dead/spawn/state 快照）
    onLurker: onNetLurker,   // 釣上來的敵對怪物（spawn/wander/claw/aggro/hp/dead/gone/state 快照）
    onFishHook,              // 釣魚：這一竿的稀有度（伺服器拋竿時就抽好）
    onFishResult,            // 釣魚結果（伺服器抽的魚；登入的人已記進伺服器的圖鑑）
    onTable: onNetTable,       // 和平島遊戲桌：伺服器給我的牌桌畫面
    onTblErr: onNetTblErr,     // 和平島遊戲桌：我的操作被拒（小瑪莉的籌碼不足／沒押注…）
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
    onScr: onNetScr, onScrList: onNetScrList, onScrTb: onNetScrTb, onScrTp: onNetScrTp, onScrMz: onNetScrMz, onTpb: onNetTpb, onTbr: onNetTbr, onTpl: onNetTpl, onTbu: onNetTbu, onTtf: onNetTtf, onScrCd: onNetScrCd,   // 和平島大螢幕
    onCraftDb: onNetCraftDb,   // 登入後伺服器送來的合成解鎖紀錄（素材圖鑑／配方筆記）
    onKills: onNetKills,       // 登入後／擊倒島主時伺服器送來的擊倒紀錄（跟著帳號）
    onNick: nick => { S.nick = nick || ''; applyMyName(); },
    onGstats: onNetGstats,   // 登入後／每局結算後伺服器送來的遊戲戰績（跟著帳號，稱號用）   // 登入後／改暱稱後伺服器送來的暱稱（跟著帳號）
    onDex: dex => { S.dex = dex || {}; S.dexSource = 'server'; if (S.dexOpen) buildDex(); checkTitles(true); },   // 登入後伺服器送來的圖鑑（稱號跟著重算，不跳提示）
    onOpen: net => {
      // 重連（2026-11-16 斷線保留座位）：牌局進行中而且我坐在位子上 → 伺服器保留座位 20 秒，帶回座代碼接回去（接不回去伺服器回 v:null，onNetTable 會關掉牌桌）；
      // 其他情況（觀戰、還沒開局、俄羅斯方塊機台）伺服器已當作我離開，畫面跟著關。稍等一下再送：要排在 enter（宣告我在哪個地形）處理完之後
      const tv = S.tableView;
      if (S.tableOpen && tv && tv.phase === 'playing' && tv.role === 'seat' && tv.game !== 'arcade') { const tid = S.tableId; setTimeout(() => { if (!S.tableOpen || S.tableId !== tid) return; net.tbl({ a: 'rejoin', id: tid }); setTimeout(() => { if (S.tableOpen && S.tblFinal?.id === tid) net.tbl(S.tblFinal.m); }, 600); }, 300); }   // 斷線那一瞬間沒送出去的結算回報也補送（隔 0.6 秒：牌桌訊息有限流，緊接著送會被丟掉）
      else if (S.tableOpen) closeTable(false);
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
