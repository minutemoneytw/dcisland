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
const SIGN_MAX = 100;        // 看板文字上限（字）
const MAX_MSG = 16384;       // 單則訊息長度上限（字元）；裝飾模式的 commit 會一次帶多個操作
const MAX_OPS = 100;         // 一次 commit 最多處理幾個操作（超過的忽略，客戶端會分批送）
const MAX_PLAYERS = 64;      // 一座島同時在線上限
const RATE_MAX = 40;         // 每條連線每秒最多處理幾則訊息（state 約 12 則/秒）
const TERRAIN_RE = /^[a-z0-9_-]{1,24}$/;
const CELL = 32;             // 與 client/js/main.js 一致
const HIT_RANGE = 140;       // 打可破壞物件時，玩家離目標最遠幾 px（客戶端範圍 72，留給延遲）
const HIT_CD_MS = 300;       // 同一條連線兩次打擊最短間隔
const SIGN_CD_MS = 1000;     // 同一條連線兩次改看板的最短間隔（每次都寫 storage＋廣播整份擺設）
// 保存擺設的令牌桶：每次 commit 都寫 storage＋廣播整份清單。客戶端一次保存最多分成約 19 批（草稿上限 1500 項／每批 80），
// 所以容許一次連發 COMMIT_BURST 批，之後每 COMMIT_REFILL_MS 回一批。dev_server.py 有同款（改一邊要改另一邊）
const COMMIT_BURST = 20;
const COMMIT_REFILL_MS = 500;

// ---- 島主（伺服器端同步）----
// 野外動物維持刻意不同步；島主會打死人，流程必須全島一致，由伺服器權威模擬：
// 被打 → 說台詞 → 反擊（樣式照 OWNER_TERRAINS：dash＝瞬移島緣＋龍衝；gaze＝原地開眼＋石化；beam＝原地讀條＋波動砲直線）→ 仇恨追殺 → 冷靜回閒晃。
// 客戶端只負責演出（移動插值、預警虛線）和自己有沒有被打到的判定（受害者自己死／自己石化，走既有 state.dead 同步）。
// 伺服器本來不知道島的形狀（世界由前端種子生成），由玩家上傳陸地位圖（RLE）；各客戶端的島相同，誰上傳都一樣。
// 每座地形各自的島主（地形 → 攻擊樣式；要與 client assets 的 terrain.json owner／mobs.json atk 一致）：
const OWNER_TERRAINS = { grass: "dash", night: "gaze", volcano: "beam" };
const D_CAST_MS = 2000;      // 龍衝的島緣鎖定（預警）持續時間（頭上有讀條，跟石化之瞳一樣 2 秒；與 client 的 OWNER_CAST 一致）
const D_GAZE_CAST_MS = 2000; // 石化之瞳的開眼預警持續時間（與 client 的 OWNER_GAZE_CAST 一致）
const D_BEAM_CAST_MS = 2000; // 波動砲的讀條持續時間（與 client 的 OWNER_BEAM_CAST 一致）
const D_DASH = 560;          // 龍衝速度 px/s（比仇恨追殺的 180 更快：高速掠過才有威嚇感）
const D_REST_MS = 700;       // 衝到底落地的停留時間
const D_WALK = 34;           // 閒晃散步速度 px/s（與 client 的 OWNER_WALK_SPEED 一致）
const D_WANDER_PAUSE = [1500, 4000];   // 每個路點之間站著休息的時間範圍 ms
const D_RAGE_MS = 12000;     // 龍衝冷卻：到點才能再觸發龍衝；冷卻期間被打進入仇恨追殺
const D_SAY_MS = 3000;       // 被打後先在原地說台詞的時間（說完才瞬移反擊）
// 台詞招式（黃金肥龍：skills.json 的 quoteChance＋mobs.json 的 lineSkills）：說完台詞後每 Q_GAP_MS 放一招（第一招在說完後 Q_GAP_MS）。
// 放招期間島主原地不動；範圍與傷害由各客戶端自判（main.js 的 QUOTE_*），伺服器只決定時間點與目標
const Q_GAP_MS = 3000;
const D_RESPAWN_MS = 30000;  // 島主被打倒後的重生秒數
const D_HP = 200;
const D_REGEN = 18;      // 島主每秒回血（用牆鐘 lazy 計算，DO 休眠也照補；約 7 人打不贏、8 人圍毆約 70 秒擊殺，client 的 OWNER_REGEN 與本機 dev_server 的 D_REGEN 要同值）
const D_CHASE = 180;         // 仇恨追殺速度 px/s（玩家走路 120／跑步 200：走路逃不掉，跑步才能拉開）
const D_CLAW_RANGE = 36;     // 爪擊範圍（前方扇形；約黃金肥龍大圖的 1/4）
const D_CLAW_MS = 1000;      // 爪擊間隔（每秒一下）
const D_CLAW_DMG = 2;        // 爪擊傷害（扣玩家 HP；被打倒由各客戶端自判，伺服器只廣播爪擊事件）
const D_AGGRO_MS = 5000;     // 仇恨換人週期：打牠的人有複數時，隨機換下一個攻擊者
const D_DROPOUT = 30000;     // 超過這時間沒有人攻擊島主：脫離仇恨回閒晃
const D_RANGE = 100;         // 玩家打島主的攻擊距離（客戶端以武器尖端為準：判定圈 58 + 武器伸出 30 = 88，留延遲）
const D_DRIFT_TOLER = 600;   // 客戶端宣稱的龍位置與伺服器的最大容差（漏接一個路點事件的落後量）
const D_STAFF_RANGE = 440;   // 法杖（遠距詠唱）打島主的最大距離：客戶端射程 320 + 判定圈 58 + 緩衝；只有 state.weapon＝staff 的連線才適用
const D_CD_MS = 300;         // 同一條連線兩次打島主的最短間隔
const D_HIT_MAX = 4;         // 一般攻擊打島主／深海魚人的傷害上限（客戶端算好送來；最高＝遠程輸出 2＋1＋唱歌爆擊 1。2026-11-05 由 2 放寬，使用者定：信任客戶端）
const D_PROVOKE_CD_MS = 15000;   // 挑釁冷卻（每條連線；與 dev_server.py 的 D_PROVOKE_CD 一致）
const D_DEBUFF_MS = 10000;        // 破綻／降傷的持續時間（與 client 的 ROLE_DEBUFF.dur 一致）
const D_DEBUFF_CD_MS = 30000;     // 破綻／降傷冷卻（每條連線、每種各算）
// 職業技能打島主／深海魚人：技能標記 sk＋職業驗證＋每條連線的冷卻（略短於客戶端，吸收延遲）；不受一般攻擊的 D_CD_MS 限制
// range＝玩家到島主（或我們看到的島主位置）的最大距離。與 client 的 JOB_SKILLS 數值一致
const SKILL_HITS = {
  ninjutsu: { job: "ninja", dmg: 6, cdMs: 19000, range: 170 },       // 忍術：身邊 80px＋判定圈 58＋緩衝
  jump: { job: "dragoon", dmg: 5, cdMs: 14000, range: 170 },        // 龍騎士高跳：落在敵人身上
  poison: { job: "bard", dmg: 1, cdMs: 2700, range: 2000 },          // 吟遊詩人上毒：每 3 秒跳一次（每跳都送一次；持續傷害不看距離）
};
const D_PROVOKE_RANGE = 240;     // 挑釁距離（比攻擊距離寬：把島主拉過來的是「聲東擊西」，不需要貼臉）
const D_SAVE_MS = 2000;      // 熱路徑（被打／爪擊／追腿／回血）寫 storage 的最短間隔；其餘變動標 dirty，由鬧鐘補寫
const SEQ_BLOCK = 50;        // 連線編號一次預留幾個再寫 storage（不必每次連線都寫）
const D_CENTER = [(COLS / 2 - .5) * CELL, (ROWS / 2 - .5) * CELL];

// ---- 釣上來的敵對怪物（lurker；fish.json 的 lurker／lurkerChance 決定是誰、多常出現）----
// 拉竿成功時極低機率釣到牠：落在浮標旁最近的陸地，直接追殺釣到牠的人（仇恨換人、爪擊與島主同一套規則），
// L_DROPOUT 內沒人打牠就原地消失；被打倒也消失，不重生。每個地形同時最多一隻；沒有人在該地形時直接消失。
// 只放記憶體不存 storage：牠存在時一定在追殺（鬧鐘每 1 秒內就醒一次），DO 不會休眠；部署重啟弄丟了，客戶端幾秒沒收到事件也會自己移除。
// 常數與 dev_server.py 的 L_* 一致（改一邊要改另一邊）；client/js/main.js 的 LURK_* 也要一起看
// 強度以「一個人也打得倒」為準（釣魚通常是單人）：一般揮擊約 8 秒打死；貼身時每 1.5 秒抓一下、每下只扣 1（client 的 LURK_CLAW_DMG）
const L_HP = 20;              // 血量（與 mobs.json 的 hp 一致；以伺服器為準，spawn 事件會帶 max）
const L_CHASE = 150;          // 追殺速度 px/s（玩家走路 120 逃不掉、跑步 200 甩得掉；比島主慢一點）
const L_CLAW_RANGE = 30;      // 爪擊範圍
const L_CLAW_MS = 1500;       // 爪擊間隔（比島主的 1 秒慢）
const L_DROPOUT = 30000;      // 多久沒人打牠就原地消失（從最後一次被打起算；剛釣上來也算一次）
const L_RANGE = 90;           // 玩家打牠的最大距離（判定圈 40 + 武器伸出 30，留延遲）
const L_STAFF_RANGE = 400;    // 法杖打牠的最大距離（射程 320 + 判定圈 40 + 緩衝）
const jsRound = v => Math.floor(v + .5);   // 與前端 Math.round 同義（明寫以防其他語言實作四捨五入規則不同）

function dragonLand(v) {   // RLE 位圖 → Uint8Array（1＝陸地）；回 null 表示格式錯
  if (typeof v !== "string" || v.length > 20000) return null;
  const p = v.split(":");
  const land = new Uint8Array(COLS * ROWS);
  let val = p[0] === "1" ? 1 : 0, i = 0;
  for (let k = 1; k < p.length; k++) {
    const n = Number(p[k]);
    if (!(n > 0) || i + n > COLS * ROWS) return null;
    land.fill(val, i, i + n); i += n; val ^= 1;
  }
  return i === COLS * ROWS ? land : null;
}
// 島心沿角度找最後一格陸地（島緣）；演算法與 client/js/main.js 相同，兩邊結果一致
function dragonEdge(map, angle) {
  const cx = COLS / 2 - .5, cy = ROWS / 2 - .5;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let last = [cx, cy];
  for (let r = 1; r <= 44; r++) {
    const x = jsRound(cx + ux * r), y = jsRound(cy + uy * r);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
    if (!map[y * COLS + x]) break;
    last = [x, y];
  }
  return [last[0] * CELL + CELL / 2, last[1] * CELL + CELL / 2];
}
// 龍衝終點：沿方向找最後一格陸地（島邊緣對岸）
function dragonDashDest(map, fx, fy, ux, uy) {
  const gx = Math.floor(fx / CELL), gy = Math.floor(fy / CELL);
  let last = [gx, gy];
  for (let r = 1; r <= 50; r++) {
    const x = jsRound(gx + ux * r), y = jsRound(gy + uy * r);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
    if (!map[y * COLS + x]) break;
    last = [x, y];
  }
  return [last[0] * CELL + CELL / 2, last[1] * CELL + CELL / 2];
}

// 追殺腿的終點（釣上來的怪物用）：在陸地上時，直線前方連續 3 格是水就截在海邊（下一腿重新瞄準會繼續沿岸繞）。
// 規則與島主 aggroTick 裡的追腿相同（島主那段沒抽出來，避免動到現有島主流程）
function chaseDest(map, pos, tx, ty) {
  if (!map) return [tx, ty];
  const gx0 = Math.floor(pos[0] / CELL), gy0 = Math.floor(pos[1] / CELL);
  const onLand = gx0 >= 0 && gy0 >= 0 && gx0 < COLS && gy0 < ROWS && !!map[gy0 * COLS + gx0];
  if (!onLand) return [tx, ty];
  const steps = Math.max(1, Math.ceil(Math.hypot(tx - pos[0], ty - pos[1]) / CELL));
  let water = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const gx = Math.floor((pos[0] + (tx - pos[0]) * t) / CELL), gy = Math.floor((pos[1] + (ty - pos[1]) * t) / CELL);
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS || !map[gy * COLS + gx]) {
      if (++water >= 3) { const tt = Math.max(0, (s - water) / steps); return [pos[0] + (tx - pos[0]) * tt, pos[1] + (ty - pos[1]) * tt]; }
    } else water = 0;
  }
  return [tx, ty];
}

// 管理員：Worker 環境變數 ADMIN_IDS（逗號分隔的 Discord 使用者 ID）。沒設就沒有管理員
function isAdminId(env, id) {
  return !!id && String(env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).includes(String(id));
}

// 對一份擺設清單套用單一操作（place / remove / clear），成功回 true。清空的權限在呼叫端檢查。
// ground(x,y)＝那格能不能放東西（陸地，或水上鋪了地板）；規則與 client/js/main.js 的 canPlaceIn、dev_server.py 的 apply_furn_op 一致
function applyFurnOp(items, defs, op, ground) {
  const cell = op.cell;
  const validCell = Array.isArray(cell) && cell.length === 2 && Number.isInteger(cell[0]) && Number.isInteger(cell[1]);
  if (op.t === "place") {
    const def = defs.get(String(op.type));
    if (!def || !validCell || items.length >= MAX_FURN) return false;
    const [x, y] = cell;
    if (x < 0 || y < 0 || x + def.w > COLS || y + def.h > ROWS) return false;
    if (ground) for (let dy = 0; dy < def.h; dy++) for (let dx = 0; dx < def.w; dx++) if (!ground(x + dx, y + dy)) return false;   // 水上要有地板
    for (const it of items) {
      const d = defs.get(it.type);
      if (!d) continue;
      if (x < it.cell[0] + d.w && it.cell[0] < x + def.w && y < it.cell[1] + d.h && it.cell[1] < y + def.h) return false;
    }
    items.push({ type: String(op.type), cell: [x, y] });
    return true;
  }
  if (op.t === "remove") {
    if (!validCell) return false;
    const i = items.findIndex(it => {
      const d = defs.get(it.type) || { w: 1, h: 1 };
      return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
    });
    if (i < 0) return false;
    items.splice(i, 1);
    return true;
  }
  if (op.t === "clear") { items.length = 0; return true; }
  return false;
}

// 地板層：每格一種地板（鍵＝y*COLS+x，值＝地板 id）。op＝{t:"floor", cell:[x,y], type:"wood"|null}（null＝拆除）
// 多格地板（floors.json 標 w/h，例如地毯 2×2）只在錨點格（左上）存一筆，其餘格子視為被它蓋住：
// 多格地板彼此不重疊、單格地板不能鋪在多格地板上；鋪多格地板會取代範圍內的單格地板；拆除點到任一格就整塊拆。
// 地板可以鋪在水上；水上那格有家具時不能拆（要先拿走家具），陸地上的地板不受限制。
// 規則與 client/js/main.js 的 applyFloorOp、dev_server.py 的 edit_floor 一致（改一邊要改另一邊）
const FLOOR_MAX = 4;   // 多格地板的最大邊長
function floorAt(floor, sizes, x, y) {   // 蓋住 (x,y) 的地板錨點 key，沒有回 -1
  for (let dy = 0; dy < FLOOR_MAX; dy++) for (let dx = 0; dx < FLOOR_MAX; dx++) {
    const ax = x - dx, ay = y - dy;
    if (ax < 0 || ay < 0) continue;
    const id = floor.get(ay * COLS + ax);
    if (id === undefined) continue;
    const s = sizes.get(id) || { w: 1, h: 1 };
    if (dx < s.w && dy < s.h) return ay * COLS + ax;
  }
  return -1;
}
function applyFloorOp(floor, sizes, op, items, defs, land) {   // land＝島形位圖（1＝陸地），沒有就不檢查水上家具
  const cell = op.cell;
  if (!Array.isArray(cell) || cell.length !== 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return false;
  const [x, y] = cell;
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  if (op.type === null) {
    const k = floorAt(floor, sizes, x, y);
    if (k < 0) return false;
    if (land && items) {   // 拆掉後水上那格會沒有地板：上面有家具就不能拆
      const ax = k % COLS, ay = Math.floor(k / COLS), s = sizes.get(floor.get(k)) || { w: 1, h: 1 };
      for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) {
        const cx = ax + dx, cy = ay + dy;
        if (cx < COLS && cy < ROWS && !land[cy * COLS + cx] && cellHasFurn(items, defs, [cx, cy])) return false;
      }
    }
    return floor.delete(k);
  }
  const s = typeof op.type === "string" && sizes.get(op.type);
  if (!s || x + s.w > COLS || y + s.h > ROWS) return false;
  const cov = [];
  for (let dy = 0; dy < s.h; dy++) for (let dx = 0; dx < s.w; dx++) {
    const k = floorAt(floor, sizes, x + dx, y + dy);
    if (k < 0) continue;
    const t = sizes.get(floor.get(k)) || { w: 1, h: 1 };
    if (t.w * t.h > 1) return false;   // 壓到多格地板（地毯）：不重疊
    cov.push(k);
  }
  if (s.w * s.h === 1 && cov.length === 1 && floor.get(cov[0]) === op.type) return false;   // 同一種，沒變
  for (const k of cov) floor.delete(k);
  floor.set(y * COLS + x, op.type);
  return true;
}
const floorToList = floor => [...floor].map(([k, id]) => [k % COLS, Math.floor(k / COLS), id]);

// 該格有沒有家具（家具佔 w×h 格）
function cellHasFurn(items, defs, cell) {
  return items.some(it => {
    const d = defs.get(it.type) || { w: 1, h: 1 };
    return cell[0] >= it.cell[0] && cell[0] < it.cell[0] + d.w && cell[1] >= it.cell[1] && cell[1] < it.cell[1] + d.h;
  });
}
// ---- 玩家 state 封包白名單：伺服器原樣轉發前先過濾（欄位、型別、範圍、長度）----
// 防灌流量（單則上限 16KB 會被廣播給全島）、防 NaN 座標，也避免超過 DO attachment 的 2KB 上限（寫入會丟例外）。
// 欄位要與 client/js/net.js 的 myState() 一致（改一邊要改另一邊）；dev_server.py 有同款 sanitize_state
const ID_RE = /^[a-z0-9_-]{1,24}$/;
const NAME_MAX = 24;
const D8 = ["down", "down_right", "right", "up_right", "up", "up_left", "left", "down_left"];   // 與 client 的 CHAR_DIR8 一致
const num = (v, lo, hi, fb) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb);
const idOr = (v, fb) => (typeof v === "string" && ID_RE.test(v) ? v : fb);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const hexOr = v => (typeof v === "string" && HEX_RE.test(v) ? v.toLowerCase() : null);
// 職業 → 職能（與 client/assets/jobs/jobs.json 一致；新增職業要在這裡與 dev_server.py 的 JOB_ROLE 一起加，否則會被當成預設職業）
const JOB_ROLE = { knight: "tank", warrior: "tank", whitemage: "healer", sage: "healer", ninja: "melee", dragoon: "melee", bard: "ranged", blackmage: "ranged" };
const JOB_LEGACY = { tank: "knight", healer: "whitemage", dps: "ninja" };   // 舊客戶端的職業 id
const JOB_DEFAULT = "ninja";
const jobOr = v => (JOB_ROLE[v] ? v : JOB_LEGACY[v] || JOB_DEFAULT);
const roleOf = st => JOB_ROLE[st && st.job] || null;
const RANGED_WEAPONS = ["staff", "scepter", "tome", "harpbow"];   // 遠距攻擊的武器（法杖、咒杖、魔導書、豎琴弓）：放寬打島主／深海魚人的距離
const FX_MAX = 8;   // state.fx：持續型技能效果的 id 清單（只轉發給同地形的人畫特效）
function sanitizeState(s, prev) {
  prev = prev || {};
  const look = s.look && typeof s.look === "object" ? s.look : {};
  const pl = prev.look || {};
  return {
    x: num(s.x, 0, COLS * CELL, prev.x ?? D_CENTER[0]),
    y: num(s.y, 0, ROWS * CELL, prev.y ?? D_CENTER[1]),
    dir: s.dir === -1 ? -1 : 1,
    moving: !!s.moving,
    z: num(s.z, 0, 200, 0),
    name: typeof s.name === "string" ? s.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, NAME_MAX) : (prev.name || ""),
    look: {
      skin: idOr(look.skin, pl.skin || "light"),
      hair: idOr(look.hair, pl.hair || "hair1"),
      shirt: Math.round(num(look.shirt, 0, 99, pl.shirt ?? 0)),
      pants: Math.round(num(look.pants, 0, 99, pl.pants ?? 0)),
      hat: idOr(look.hat, null),          // 顯示中的帽子 id（裝備或外觀，客戶端已決定好；null＝沒戴）
      top: idOr(look.top, null),          // 顯示中的上衣 id（null＝預設款）
      bottom: idOr(look.bottom, null),    // 顯示中的褲子 id（null＝預設款）
      hatC: hexOr(look.hatC),             // 換色色碼（null＝原色）
      topC: hexOr(look.topC),
      botC: hexOr(look.botC),
      wlook: idOr(look.wlook, null),      // 武器外觀 id（同類型才會畫，由客戶端判斷）
    },
    d8: D8.includes(s.d8) ? s.d8 : null,  // 畫面用的 8 方向朝向（只轉發；玩法看 face）
    weapon: idOr(s.weapon, "hands"),
    pose: s.pose === "sit" || s.pose === "sleep" ? s.pose : null,
    face: s.face === "up" || s.face === "side" ? s.face : "down",
    seat: idOr(s.seat, null),
    job: jobOr(s.job),                     // 職業：白名單（JOB_ROLE），舊客戶端的 tank/healer/dps 轉成騎士/白魔法師/忍者，不合法＝忍者（挑釁等職能驗證靠這欄）
    fx: Array.isArray(s.fx) ? s.fx.filter(v => typeof v === "string" && ID_RE.test(v)).slice(0, FX_MAX) : [],   // 持續型技能效果（翅膀、護盾…）：只轉發
    circle: s.circle && typeof s.circle === "object"   // 黑魔法師的魔法陣位置（只轉發）
      ? { x: num(s.circle.x, 0, COLS * CELL, 0), y: num(s.circle.y, 0, ROWS * CELL, 0) } : null,
    title: idOr(s.title, null),            // 稱號 id（null＝不顯示；只轉發 id，文字由各客戶端查 titles.json，解鎖與否不驗證）
    hp: Math.round(num(s.hp, 0, 20, 10)),
    dead: s.dead ? 1 : 0,
    // 釣魚：浮標位置與階段（只轉發給同地形的人畫圖；釣到什麼由伺服器的 fish 訊息決定）
    fish: s.fish && typeof s.fish === "object" && FISH_PHASES.includes(s.fish.ph)
      ? { x: num(s.fish.x, 0, COLS * CELL, 0), y: num(s.fish.y, 0, ROWS * CELL, 0), ph: s.fish.ph } : null,
  };
}

// ---- 釣魚（魚類圖鑑）----
// 釣到什麼由伺服器抽（client/assets/fish/fish.json）；登入（hello 驗證過）的人記進全域 Registry（依 Discord 帳號），訪客只回結果。
// 演算法與 client/js/main.js 的 rollFish、dev_server.py 的 roll_fish 一致（改一邊要改另一邊）
const FISH_PHASES = ["wait", "bite", "reel"];
const FISH_CD_MS = 2500;     // 同一條連線兩次釣魚結果的最短間隔（拋竿到上鉤最快 3 秒）
function rollFish(db, terrain) {
  const list = (db.terrains || {})[terrain] || [];
  if (!list.length || Math.random() < (db.escape || 0)) return { terrain, escaped: true };
  const rars = Object.entries(db.rarity || {}).filter(([k]) => list.some(f => f.rarity === k));
  let r = Math.random() * rars.reduce((s, [, v]) => s + v.weight, 0), rar = rars[rars.length - 1][0];
  for (const [k, v] of rars) { if ((r -= v.weight) < 0) { rar = k; break; } }
  const cands = list.filter(f => f.rarity === rar), f = cands[Math.floor(Math.random() * cands.length)];
  const size = Math.round((f.size[0] + (f.size[1] - f.size[0]) * Math.random() ** 1.6) * 10) / 10;
  return { terrain, id: f.id, size, rarity: rar };
}
const SESSION_TTL_MS = 12 * 3600 * 1000;   // 簽章憑證有效期

// ---- 身分憑證：/api/token 兌換成功後簽發，/ws 的 hello 訊息驗證 ----
// 格式：base64url(JSON{id,name,exp}) + "." + base64url(HMAC-SHA256)；密鑰為 env.SESSION_SECRET
// 沒設密鑰時不簽發（維持訪客模式），不影響既有功能。
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signSession(env, user) {
  if (!env.SESSION_SECRET || !user) return null;
  const body = b64u(new TextEncoder().encode(JSON.stringify({ id: String(user.id), name: String(user.name), exp: Date.now() + SESSION_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(body));
  return body + "." + b64u(sig);
}

// 驗證成功回 {id,name}，否則 null
async function verifySession(env, token) {
  if (!env.SESSION_SECRET || typeof token !== "string" || token.length > 1024) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), unb64u(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const u = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!u.id || !u.name || !(u.exp > Date.now())) return null;
    return { id: u.id, name: u.name };
  } catch { return null; }
}

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
  return json({ access_token: tok.access_token, scope: tok.scope, user, session: await signSession(env, user) });
}

// ============ 一座島 ============
// 用 WebSocket Hibernation：沒人講話時 DO 可以休眠，不計費也省資源
export class Island {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rate = new Map();       // ws -> {sec, n}；休眠醒來會重置，無妨
    this.furnDefs = null;        // id -> {w,h}，由 furniture.json 載入
    this.floorDefs = null;       // 地板 id -> {w,h}，由 floors.json 載入
    this.targets = null;         // 可破壞物件定義（tools.json 的 targets）
    this.lastHit = new Map();    // ws -> 上次打擊的時間
    this.lastSign = new Map();   // ws -> 上次改看板的時間
    this.commitBucket = new Map();   // ws -> {n（剩幾批）, t（上次結算時間）}：保存擺設的令牌桶
    this.dragons = new Map();        // 地形 → 島主狀態（每座有島主的地形各一隻，懒載入 storage）
    this.dragonLoaded = new Set();   // 已嘗試從 storage 載過的地形
    this.dragonMaps = new Map();     // 地形 → 陸地位圖（懒載入）——只放記憶體的話 DO 休眠後就沒了，打島主不會反擊
    this.dragonMapLoaded = new Set();
    this.dragonMapRaw = new Map();   // 地形 → storage 裡目前存的島形字串（比對用：內容沒變就不重寫）
    this.fishDB = null;              // 釣魚：fish.json（懶載入）
    this.lastFish = new Map();       // ws → 上次釣魚結果的時間（冷卻）
    this.dragonHits = new Map();     // ws → {terrain, t}：上次打哪座島的島主（冷卻＋仇恨換人用）
    this.provokes = new Map();       // ws → {terrain, t}：上次挑釁哪座島的島主（冷卻只在成功出手時計）
    this.debuffs = new Map();        // ws → {vuln: t, weak: t}：上次放破綻／降傷的時刻（冷卻只在成功時計）
    this.skillHits = new Map();      // ws → {"技能:owner|lurker": t}：職業技能打怪的冷卻
    this.lurkers = new Map();        // 地形 → 釣上來的敵對怪物（每個地形同時最多一隻；只放記憶體，見 L_* 常數的說明）
    this.lurkHits = new Map();       // ws → {terrain, t}：上次打釣上來的怪物（冷卻＋仇恨換人用）
    this.dragonSavedAt = new Map();  // 地形 → 上次真的寫 storage 的時間（saveDragonLazy 節流用）
    this.dragonDirty = new Set();    // 有變動但還沒寫進 storage 的地形
    this.alarmAt = null;             // 目前排著的鬧鐘時間（記憶體；醒來後重置，只用來略過重複的 setAlarm）
    this.seq = 0; this.seqCeil = 0;  // 連線編號：記憶體遞增，storage 只存「預留上限」，重啟後從上限接續，不會重複
    state.blockConcurrencyWhile(async () => {
      this.seqCeil = (await state.storage.get("seq")) || 0;
      this.seq = this.seqCeil;
    });
  }

  // 可破壞物件的血量/重生秒數取自前端 tools.json
  async getTargets() {
    if (this.targets) return this.targets;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/tools/tools.json"));
      this.targets = (await res.json()).targets || {};
    } catch (e) {
      console.log("[deco] tools.json 載入失敗", String(e));
      return {};
    }
    return this.targets;
  }

  // 每個地形一份「受損/已破壞」的可破壞物件：{ 物件編號: {hp, cell, until} }（沒受損的不存）
  async getDecos(terrain) {
    return (await this.state.storage.get("deco:" + terrain)) || {};
  }

  // 已破壞、到了重生時間、且該格沒有家具的 → 回到滿血（移除紀錄）
  async pruneDecos(terrain, map) {
    const items = await this.getFurn(terrain), defs = await this.getFurnDefs();
    let changed = false;
    for (const [i, e] of Object.entries(map)) {
      if (e.hp <= 0 && e.until <= Date.now() && !cellHasFurn(items, defs, e.cell)) { delete map[i]; changed = true; }
    }
    if (changed) await this.state.storage.put("deco:" + terrain, map);
    return map;
  }

  decoList(map) {
    return Object.entries(map).map(([i, e]) => ({ i: Number(i), hp: e.hp, ttl: e.hp <= 0 ? Math.max(0, e.until - Date.now()) : 0 }));
  }

  // 家具尺寸取自前端 manifest，伺服器據此驗證擺放
  async getFurnDefs() {
    if (this.furnDefs) return this.furnDefs;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/furniture/furniture.json"));
      const man = await res.json();
      this.furnDefs = new Map(man.items.map(it => [it.id, { w: it.w, h: it.h, text: !!it.text }]));
    } catch (e) {
      console.log("[furn] manifest 載入失敗", String(e));
      return new Map();          // 載入失敗就不接受擺放，下次再試
    }
    return this.furnDefs;
  }

  // 島主招式設定取自前端 skills.json（key＝攻擊樣式 dash/gaze）。目前伺服器只用 say：false＝被打不講台詞、直接開始預警。
  // 載入失敗就當作全部都要講台詞（與以前行為相同），下次再試
  async getSkillDefs() {
    if (this.skillDefs) return this.skillDefs;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/skills/skills.json"));
      this.skillDefs = (await res.json()).skills || {};
    } catch (e) {
      console.log("[skill] manifest 載入失敗", String(e));
      return {};
    }
    return this.skillDefs;
  }
  async getMobDefs() {   // mobs.json（台詞招式表 lineSkills 用）
    if (this.mobDefs) return this.mobDefs;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/mobs/mobs.json"));
      this.mobDefs = (await res.json()).mobs || [];
    } catch (e) {
      console.log("[mobs] manifest 載入失敗", String(e));
      return [];
    }
    return this.mobDefs;
  }
  // 被激怒時要不要改放台詞招式：skills.json 該樣式的 quoteChance 機率；是的話隨機挑一句（不連續重複）回 {line, skills}，否則 null
  async pickQuote(terrain) {
    const style = OWNER_TERRAINS[terrain];
    const sk = (await this.getSkillDefs())[style];
    if (!sk || !(sk.quoteChance > 0) || Math.random() >= sk.quoteChance) return null;
    const def = (await this.getMobDefs()).find(m => m.owner && m.atk === style && Array.isArray(m.lineSkills));
    if (!def) return null;
    const d = this.dragons.get(terrain);
    const cands = def.lineSkills.map((v, i) => i).filter(i => def.lineSkills[i].length && i !== d.lastLine);
    if (!cands.length) return null;
    const line = cands[Math.floor(Math.random() * cands.length)];
    d.lastLine = line;
    return { line, skills: def.lineSkills[line].slice(0, 3) };
  }
  // 開始台詞招式：原地說台詞 D_SAY_MS，之後每 Q_GAP_MS 放一招（stepQuote 推進）；廣播 say（帶台詞編號，全島同一句）。存檔由呼叫端負責
  startQuote(now, terrain, q, pos) {
    const d = this.dragons.get(terrain);
    d.wander = null; d.aimTms = 0;
    d.pos = [pos[0], pos[1]];
    d.sayUntil = now + D_SAY_MS;
    const fires = q.skills.map((_, i) => d.sayUntil + Q_GAP_MS * (i + 1));
    d.quote = { line: q.line, skills: q.skills, fires, fired: 0 };
    d.cooldownUntil = fires[fires.length - 1] + D_RAGE_MS;
    this.broadcast({ t: "dragon", ev: "say", x: d.pos[0], y: d.pos[1], ms: D_SAY_MS, line: q.line }, null, terrain);
  }
  // 台詞招式的目標（放招當下才挑；客戶端同時顯示範圍並自判傷害）：月華衝＝仇恨目標、隕石流＝場上每個人、離子砲＝隨機一人；月環／鋼鐵以島主為中心不需要
  quoteTargets(terrain, skill, d) {
    const alive = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.terrain === terrain && a.state && !a.state.dead) alive.push(a.id);
    }
    if (!alive.length) return [];
    if (skill === "meteor") return alive;
    if (skill === "dive") return [d.aggro && alive.includes(d.aggro.id) ? d.aggro.id : alive[Math.floor(Math.random() * alive.length)]];
    if (skill === "ion") return [alive[Math.floor(Math.random() * alive.length)]];
    return [];
  }
  // 推進台詞招式：到點的招式依序廣播 qfire；全部放完就結束（仇恨保持，接著追殺）。回傳下一個要醒的時間
  async stepQuote(now, terrain) {
    const d = this.dragons.get(terrain), q = d.quote;
    while (q.fired < q.skills.length && now >= q.fires[q.fired] - 30) {
      const skill = q.skills[q.fired];
      this.broadcast({ t: "dragon", ev: "qfire", skill, i: q.fired, x: d.pos[0], y: d.pos[1], ids: this.quoteTargets(terrain, skill, d) }, null, terrain);
      q.fired++;
    }
    if (q.fired >= q.skills.length) {
      d.quote = null; d.sayUntil = 0;
      await this.saveDragon(terrain);
      return now + 400;   // 最後一招的特效放一下再開始追
    }
    await this.saveDragonLazy(terrain);
    return q.fires[q.fired];
  }
  async ownerSays(terrain) {   // 這座島的島主放招前要不要先講台詞
    const sk = (await this.getSkillDefs())[OWNER_TERRAINS[terrain]];
    return !sk || sk.say !== false;
  }

  // 地板種類與大小取自前端 floors.json：id -> {w,h}（沒標的是 1×1）
  async getFloorDefs() {
    if (this.floorDefs) return this.floorDefs;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/floors/floors.json"));
      this.floorDefs = new Map((await res.json()).items.map(it => [it.id, { w: it.w || 1, h: it.h || 1 }]));
    } catch (e) {
      console.log("[floor] manifest 載入失敗", String(e));
      return new Map();
    }
    return this.floorDefs;
  }

  async getFloor(terrain) {   // 儲存格式 [[x,y,id],…]；記憶體裡用 Map 方便逐格改
    return new Map(((await this.state.storage.get("floor:" + terrain)) || []).map(([x, y, id]) => [y * COLS + x, id]));
  }

  // 釣魚：各地形的魚與稀有度取自前端 fish.json
  async getFishDB() {
    if (this.fishDB) return this.fishDB;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/fish/fish.json"));
      this.fishDB = await res.json();
    } catch (e) {
      console.log("[fish] manifest 載入失敗", String(e));
      return { terrains: {} };
    }
    return this.fishDB;
  }

  // 呼叫全域 Registry（跨島的玩家資料）；沒有綁定或失敗回 null（釣魚照樣能玩，只是圖鑑存不進伺服器）
  async registryCall(path, body) {
    if (!this.env.REGISTRY) return null;
    try {
      const stub = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      const res = await stub.fetch("https://registry" + path, { method: "POST", body: JSON.stringify(body) });
      return res.ok ? await res.json() : null;
    } catch (e) {
      console.log("[registry]", path, String(e));
      return null;
    }
  }

  // 釣魚：魚上鉤後拉竿成功 → 伺服器抽一條魚回給這條連線；登入的人同時記進 Registry 的圖鑑（帶回最新紀錄）
  async fishCatch(ws, att) {
    const now = Date.now();
    if (now - (this.lastFish.get(ws) || 0) < FISH_CD_MS) return;
    this.lastFish.set(ws, now);
    const db = await this.getFishDB();
    const res = rollFish(db, att.terrain);
    // 極低機率釣到敵對怪物（該地形沒有其他還在的怪物時才會）：不記圖鑑，改成在浮標旁落地追殺釣到牠的人
    if (!res.escaped && db.lurker && !this.lurkers.has(att.terrain) && Math.random() < (db.lurkerChance || 0)
        && await this.spawnLurker(ws, att, String(db.lurker), now)) {
      try { ws.send(JSON.stringify({ t: "fish_result", terrain: att.terrain, lurker: String(db.lurker), saved: false })); } catch { /* 對方已斷線 */ }
      return;
    }
    const out = { t: "fish_result", ...res, saved: false };
    const user = (ws.deserializeAttachment() || {}).user;   // 重讀：hello 可能剛驗證完
    if (!res.escaped && user) {
      const r = await this.registryCall("/catch", { uid: user.id, terrain: res.terrain, id: res.id, size: res.size });
      if (r && r.entry) Object.assign(out, { saved: true, entry: r.entry, isNew: r.isNew, isRecord: r.isRecord });
    }
    try { ws.send(JSON.stringify(out)); } catch { /* 對方已斷線 */ }
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
    const seq = ++this.seq;
    if (seq > this.seqCeil) {   // 用完預留的編號才寫一次 storage（舊資料存的是「最後用掉的編號」，語意相容）
      this.seqCeil = seq + SEQ_BLOCK;
      await this.state.storage.put("seq", this.seqCeil);
    }
    server.serializeAttachment({ id: seq });

    this.state.acceptWebSocket(server);

    // 剛連上時還沒進任何地形（terrain 為空）：看不到也不被看到，等客戶端送 enter
    server.send(JSON.stringify({ t: "init", id: seq, admin: false }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // terrain 有給時只送給「目前在該地形」的連線；沒給就是全部
  broadcast(msg, skip, terrain) {
    if (terrain !== undefined && (msg.t === "dragon" || msg.t === "lurker") && msg.terrain === undefined) msg = { ...msg, terrain };   // 島主事件註明是哪座地形的，客戶端才能擋掉切地形空檔收到的舊島事件
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip) continue;
      if (terrain !== undefined && (ws.deserializeAttachment() || {}).terrain !== terrain) continue;
      try { ws.send(data); } catch { /* 對方已斷線 */ }
    }
  }

  // 玩家進入某地形：每個人各自在自己的地形，只有同地形的人看得到彼此
  async enter(ws, att, v) {
    if (!TERRAIN_RE.test(v) || att.terrain === v) return;
    const old = att.terrain;
    // leave 帶 to＝去了哪個地形（讓留下的人顯示「XXX 移動到了OO區域」）；斷線的 leave 不帶
    if (old) this.broadcast({ t: "leave", id: att.id, to: v }, ws, old);
    att.terrain = v;
    ws.serializeAttachment(att);

    const players = {};
    for (const o of this.state.getWebSockets()) {
      if (o === ws) continue;
      const oa = o.deserializeAttachment() || {};
      if (oa.terrain === v && oa.state) players[oa.id] = oa.state;
    }
    await this.getFurnDefs();     // 先載入（pruneDecos 會用到）
    const decos = this.decoList(await this.pruneDecos(v, await this.getDecos(v)));
    let dragon;
    if (OWNER_TERRAINS[v]) {    // 島主同步：進有島主的地形時給一份當下的快照（重算現在的階段）
      await this.getDragon(v);
      dragon = this.dragonSnapshot(v);
      await this.armOwnerAlarm();   // 有人進來了：醒來恢復散步（統一匯總，不會蓋掉別座島更早的排程）
    }
    const lurker = this.lurkerSnapshot(v);   // 釣上來的怪物（沒有就是 null，客戶端據此清掉殘留的）
    ws.send(JSON.stringify({ t: "enter", terrain: v, players, furn: await this.getFurn(v), floor: floorToList(await this.getFloor(v)), decos, dragon, lurker }));
    this.broadcast({ t: "join", id: att.id, name: att.state && att.state.name }, ws, v);
    if (att.state) this.broadcast({ t: "p", id: att.id, s: att.state }, ws, v);
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

    if (msg.t === "hello") {
      // 帶簽章憑證表明身分；驗證失敗就維持訪客
      const user = await verifySession(this.env, msg.s);
      // 驗證期間（await）其他訊息（state／enter）可能已改過 attachment：要重讀再合併，
      // 否則用開頭讀到的舊 att 寫回會蓋掉剛設好的 terrain／state（玩家就會卡在「沒進任何地形」）
      const cur = ws.deserializeAttachment() || {};
      cur.user = user;
      cur.admin = !!user && isAdminId(this.env, user.id);
      if (user && cur.state) cur.state = { ...cur.state, name: String(user.name).slice(0, NAME_MAX), uid: user.id };
      ws.serializeAttachment(cur);
      ws.send(JSON.stringify({ t: "me", admin: cur.admin, auth: !!user }));   // auth＝憑證驗證成功；失敗（例如 12 小時過期）客戶端會重新授權
      if (user) {   // 登入的人：送他存在伺服器的魚類圖鑑
        const r = await this.registryCall("/dex", { uid: user.id });
        if (r) try { ws.send(JSON.stringify({ t: "dex", dex: r.dex || {} })); } catch { /* 對方已斷線 */ }
      }
    } else if (msg.t === "state") {
      const s = sanitizeState(msg.s && typeof msg.s === "object" ? msg.s : {}, att.state);
      // 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）；訪客沒有 uid
      if (att.user) { s.name = String(att.user.name).slice(0, NAME_MAX); s.uid = att.user.id; }
      att.state = s;
      ws.serializeAttachment(att);
      if (att.terrain) this.broadcast({ t: "p", id: att.id, s }, ws, att.terrain);
    } else if (msg.t === "enter" || msg.t === "terrain") {
      // "terrain" 是舊客戶端的訊息名，當作 enter 處理
      await this.enter(ws, att, String(msg.v));
    } else if (msg.t === "hit") {
      await this.hitDeco(ws, att, msg);
    } else if (msg.t === "dragonMap") {   // 陸地位圖（島主路徑＋擺設的水邊驗證；各客戶端島形相同，誰上傳都一樣；後上傳的覆蓋也無妨）。上傳者所在地形決定是哪座島的
      const t = att.terrain;
      if (t) {
        const land = dragonLand(msg.v);
        if (land) {
          this.dragonMaps.set(t, land);
          this.dragonMapLoaded.add(t);
          // 一定要存：DO 休眠會清空記憶體，沒存的話之後打島主不會反擊、擺設也驗不到水邊。
          // 但各客戶端島形相同，絕大多數上傳都是重複的：和已存的內容一樣就不寫（休眠醒來第一次比對要讀一次 storage）
          if (!this.dragonMapRaw.has(t)) this.dragonMapRaw.set(t, await this.state.storage.get("dragonMap:" + t));
          if (this.dragonMapRaw.get(t) !== msg.v) {
            await this.state.storage.put("dragonMap:" + t, msg.v);
            this.dragonMapRaw.set(t, msg.v);
          }
        }
      }
    } else if (msg.t === "dragonSnap") {   // 客戶端凍結恢復：回一份島主即時快照（只給這條連線，走 dragon 事件的 state）
      if (att.terrain && OWNER_TERRAINS[att.terrain]) {
        await this.getDragon(att.terrain);
        ws.send(JSON.stringify({ t: "dragon", ev: "state", terrain: att.terrain, ...this.dragonSnapshot(att.terrain) }));
      }
    } else if (msg.t === "dragonHit") {
      await this.dragonHit(ws, att, msg);
    } else if (msg.t === "lurkerHit") {   // 打釣上來的敵對怪物
      await this.lurkerHit(ws, att, msg);
    } else if (msg.t === "provoke") {   // 挑釁（坦職限定，client 的 R 鍵）：把島主的仇恨拉到自己身上
      await this.provoke(ws, att);
    } else if (msg.t === "debuff") {    // 破綻（近戰輸出）／降傷（遠程輸出）：client 的 R 鍵
      await this.debuff(ws, att, msg);
    } else if (msg.t === "commit" || msg.t === "place" || msg.t === "remove" || msg.t === "clear") {
      // 舊客戶端的單一操作（place/remove/clear）也走同一套驗證與權限
      if (att.terrain) await this.commitFurn(ws, att, msg.t === "commit" ? msg.ops : [msg]);
    } else if (msg.t === "sign") {
      if (att.terrain) await this.editSign(ws, att, msg);
    } else if (msg.t === "event") {
      if (att.terrain) this.broadcast({ t: "event", id: att.id, kind: msg.kind }, ws, att.terrain);
    } else if (msg.t === "fish") {   // 釣魚：拉竿成功，伺服器抽魚
      if (att.terrain) await this.fishCatch(ws, att);
    }
  }

  // 打可破壞物件：血量由伺服器扣，改完廣播給同地形的所有人（含打的人）
  // 物件編號（i）是客戶端依地形種子確定性產生的順序；伺服器不重建世界，只驗證格式、距離與目標種類
  async hitDeco(ws, att, msg) {
    const terrain = att.terrain, cell = msg.cell, i = msg.i;
    if (!terrain || !att.state) return;
    if (!Number.isInteger(i) || i < 0 || i >= 5000) return;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger) || cell[0] < 0 || cell[1] < 0 || cell[0] >= COLS || cell[1] >= ROWS) return;
    const now = Date.now();
    if (now - (this.lastHit.get(ws) || 0) < HIT_CD_MS) return;
    const tgt = (await this.getTargets())[String(msg.sprite)];
    if (!tgt) return;
    const dx = cell[0] * CELL + CELL / 2 - att.state.x, dy = (cell[1] + .5) * CELL - att.state.y;
    if (!(Math.hypot(dx, dy) <= HIT_RANGE)) return;     // 也擋掉 NaN／缺座標
    this.lastHit.set(ws, now);

    await this.getFurnDefs();
    const map = await this.pruneDecos(terrain, await this.getDecos(terrain));
    const e = map[i] || { hp: tgt.hp, cell };
    if (e.hp <= 0) return;                               // 已經壞了
    e.hp -= 1; e.cell = cell;
    const ttl = (tgt.respawn || 60) * 1000;
    if (e.hp <= 0) e.until = now + ttl;
    map[i] = e;
    await this.state.storage.put("deco:" + terrain, map);
    this.broadcast({ t: "deco", i, hp: e.hp, ttl: e.hp <= 0 ? ttl : 0, by: att.id }, null, terrain);
  }

  // ---- 島主（伺服器端同步）----
  async getDragon(terrain) {
    if (!this.dragonLoaded.has(terrain)) {
      this.dragonLoaded.add(terrain);
      let d = await this.state.storage.get("dragon:" + terrain);
      if (d === undefined && terrain === "grass") {   // 舊版存在沒有地形後綴的 key：搬一份到新 key（之後都讀新 key）
        d = await this.state.storage.get("dragon");
        if (d) await this.state.storage.put("dragon:" + terrain, d);
      }
      this.dragons.set(terrain, d || null);
      if (d && d.st === "dead") await this.scheduleDragonRespawn(terrain);   // 休眠醒來仍在死，把鬧鐘補回來
    }
    let d = this.dragons.get(terrain);
    if (!d) {
      d = { hp: D_HP, st: "idle", pos: [...D_CENTER], aimTms: 0, deadAt: 0, wander: null, cooldownUntil: 0, sayUntil: 0, regenT: 0, aggro: null, lastHitAt: 0 };
      this.dragons.set(terrain, d);
    }
    if (d.wander === undefined) d.wander = null;   // 舊存檔沒有這個欄位
    if (d.cooldownUntil === undefined) d.cooldownUntil = 0;
    if (d.sayUntil === undefined) d.sayUntil = 0;
    if (d.regenT === undefined) d.regenT = Date.now();   // 舊存檔從現在起算（不憑空補血）
    if (d.aggro === undefined) d.aggro = null;
    if (d.lastHitAt === undefined) d.lastHitAt = 0;
    if (d.quote === undefined) d.quote = null;
    return d;
  }
  saveDragon(terrain) {
    this.dragonDirty.delete(terrain);
    this.dragonSavedAt.set(terrain, Date.now());
    return this.state.storage.put("dragon:" + terrain, this.dragons.get(terrain));
  }
  // 熱路徑（每次被打、爪擊、追腿、回血都會呼叫）：D_SAVE_MS 內只標 dirty，不重複寫 storage。
  // 關鍵轉換（死亡、重生、開招、仇恨開始／結束）仍用 saveDragon 立即寫；dirty 的由 flushDragons 補寫
  saveDragonLazy(terrain) {
    if (Date.now() - (this.dragonSavedAt.get(terrain) || 0) >= D_SAVE_MS) return this.saveDragon(terrain);
    this.dragonDirty.add(terrain);
    return Promise.resolve();
  }
  // 把 dirty 且已超過節流間隔的寫掉（force＝全部寫）；回傳還沒到期的 dirty 最早要補寫的時間（沒有則 null），讓鬧鐘排得進去
  async flushDragons(force = false) {
    let wake = null;
    for (const terrain of [...this.dragonDirty]) {
      const due = (this.dragonSavedAt.get(terrain) || 0) + D_SAVE_MS;
      if (force || due <= Date.now()) await this.saveDragon(terrain);
      else if (wake === null || due < wake) wake = due;
    }
    return wake;
  }
  // 唯一設定鬧鐘的地方：已經有更早（或同時）的鬧鐘就不重複寫；醒來時會重算，所以不會漏
  async setOwnerAlarm(at) {
    const now = Date.now();
    at = Math.max(now + 60, at);
    if (this.alarmAt && this.alarmAt > now && this.alarmAt <= at) return;
    this.alarmAt = at;
    await this.state.storage.setAlarm(at);
  }
  // ---- 島主仇恨（反擊冷卻期間的追殺行為；client 的演出在 ownerAggro 系列）----
  // D_DROPOUT（30 秒）內在該地形打過島主、還在線上沒死的連線名單（仇恨換人從這裡隨機挑）
  aggroCandidates(now, terrain, win = D_DROPOUT, hits = this.dragonHits) {   // hits＝攻擊紀錄（島主用 dragonHits，釣上來的怪物用 lurkHits）
    const out = [];
    for (const [ws, h] of hits) {
      if (h.terrain !== terrain || now - h.t > win) continue;
      const att = ws.deserializeAttachment?.() || {};
      if (att.terrain === terrain && att.state && !att.state.dead) out.push(att);
    }
    return out;
  }
  // 依連線編號找仇恨目標（斷線／離開該地形／死了就找不到）
  aggroTarget(id, terrain) {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id === id && att.terrain === terrain && att.state && !att.state.dead) return att;
    }
    return null;
  }
  // 開始/切換追殺目標：廣播 aggro 事件（id＝被鎖定的連線編號，客戶端用來鎖定自己）；存檔由呼叫端負責
  startAggro(now, att, terrain) {
    const d = this.dragons.get(terrain);
    d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
    d.wander = null;
    this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, terrain);
  }
  dropAggro(terrain, chill = true) {
    this.dragons.get(terrain).aggro = null;
    if (chill) this.broadcast({ t: "dragon", ev: "chill" }, null, terrain);
  }
  // 回血：每秒回 D_REGEN 點（用牆鐘 lazy 計算，不需要計時器；滿血或死亡時把錨點重置為現在，扣血後才重新開始累積）
  regenDragon(terrain, now) {
    const d = this.dragons.get(terrain);
    if (d.st === "dead" || d.hp >= D_HP) { d.regenT = now; return; }
    const n = Math.floor((now - d.regenT) / 1000);
    if (n > 0) {
      d.hp = Math.min(D_HP, d.hp + n * D_REGEN);
      d.regenT = d.hp >= D_HP ? now : d.regenT + n * 1000;
    }
  }
  // 島形位圖：玩家上傳後存 storage（懒載入）。各客戶端的島相同，誰上傳都一樣。所有地形都有（島主＋擺設的水邊驗證）
  async getDragonMap(terrain) {
    if (!this.dragonMapLoaded.has(terrain)) {
      this.dragonMapLoaded.add(terrain);
      let v = await this.state.storage.get("dragonMap:" + terrain);
      if (!this.dragonMapRaw.has(terrain)) this.dragonMapRaw.set(terrain, v);   // 順便記下 storage 現值（上傳時比對用）
      if (v === undefined && terrain === "grass") v = await this.state.storage.get("dragonMap");   // 舊版 key
      this.dragonMaps.set(terrain, typeof v === "string" ? dragonLand(v) : null);
    }
    return this.dragonMaps.get(terrain) || null;
  }
  // 由 aimTms 推導現在的階段（閒置/說台詞/開眼/瞬移鎖定/龍衝/停留），不需要每幀醒著跑
  dragonPhase(terrain, now) {
    const d = this.dragons.get(terrain);
    if (d.st === "dead") return ["dead", d.pos, 0];
    if (!d.aimTms) {
      if (d.sayUntil && now < d.sayUntil) return ["say", d.pos, d.sayUntil - now];   // 說台詞中：原地不動
      if (d.quote) return ["quote", d.pos, 0];   // 台詞招式放招中：原地不動
      if (!d.wander) return ["idle", d.pos, 0];
      const t = Math.min(1, Math.max(0, (now - d.wander.t0) / d.wander.tms));
      return ["idle", [d.wander.fx + (d.wander.tx - d.wander.fx) * t, d.wander.fy + (d.wander.ty - d.wander.fy) * t], 0];
    }
    const style = OWNER_TERRAINS[terrain];
    if (style === "gaze" || style === "beam") {   // 原地施放（石化之瞳開眼／波動砲讀條）：不瞬移不移動，放完就地回 idle
      const castMs = style === "gaze" ? D_GAZE_CAST_MS : D_BEAM_CAST_MS;
      const dt = now - d.aimTms;
      if (dt < castMs) return ["cast", d.pos, castMs - dt];
      return ["idle", d.pos, 0];
    }
    let dt = now - d.aimTms;
    if (dt < D_CAST_MS) return ["aim", d.warp, D_CAST_MS - dt];
    dt -= D_CAST_MS;
    const dashMs = d.dashLen / D_DASH * 1000;
    if (dt < dashMs) return ["dash", [d.warp[0] + d.unit[0] * (dt / 1000 * D_DASH), d.warp[1] + d.unit[1] * (dt / 1000 * D_DASH)], dashMs - dt];
    dt -= dashMs;
    if (dt < D_REST_MS) return ["rest", d.dest, D_REST_MS - dt];
    return ["idle", d.dest, 0];   // 衝完在對岸就地閒晃（不回中心）
  }
  // idle 開始的時間（沒被觸發過就是 0）；用於 D_RAGE_MS 冷卻
  dragonIdleAt(terrain) {
    const d = this.dragons.get(terrain);
    if (!d.aimTms) return 0;
    const style = OWNER_TERRAINS[terrain];
    if (style === "gaze") return d.aimTms + D_GAZE_CAST_MS;
    if (style === "beam") return d.aimTms + D_BEAM_CAST_MS;
    return d.aimTms + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS;
  }
  dragonSnapshot(terrain) {
    const now = Date.now();
    this.regenDragon(terrain, now);   // 讀快照前先把該補的血補上（快照帶 hp）
    const [ph, pos, ms] = this.dragonPhase(terrain, now);
    const d = this.dragons.get(terrain);
    const o = { ph, x: pos[0], y: pos[1], hp: d.hp };
    if (d.aggro) o.aggro = d.aggro.id;   // 仇恨中：附上追殺目標（中途進場的人才知道牠在戰鬥）
    if (ph === "aim") { o.castMs = Math.round(ms); o.tx = d.atk[0]; o.ty = d.atk[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "cast") { o.castMs = Math.round(ms); o.tx = d.atk[0]; o.ty = d.atk[1]; o.bx = d.beam[0]; o.by = d.beam[1]; }   // 石化之瞳：開眼中（直線已鎖定）
    if (ph === "dash") { o.ux = d.unit[0]; o.uy = d.unit[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "rest") o.restMs = Math.round(ms);
    if (ph === "say") o.sayMs = Math.round(ms);   // 說台詞中：附上剩餘時間
    if (d.quote) o.line = d.quote.line;           // 台詞招式中：哪一句（中途進場的人也看到同一句）
    if (now < (d.vulnUntil || 0)) o.vulnMs = d.vulnUntil - now;   // 破綻／降傷剩餘時間
    if (now < (d.weakUntil || 0)) o.weakMs = d.weakUntil - now;
    if (ph === "idle" && d.wander) {   // 散步中：附上路點與已走時間，客戶端接著插值
      const w = d.wander;
      o.wleg = { fx: w.fx, fy: w.fy, tx: w.tx, ty: w.ty, tms: w.tms, el: Math.max(0, Math.min(w.tms, now - w.t0)) };
    }
    return o;
  }
  // 職業技能的命中（msg.sk）：回 {dmg, range}；不是技能＝null；是技能但不合法（職業不對、冷卻中）＝false（整擊忽略）
  skillHit(ws, att, msg, kind, now) {
    if (!msg.sk) return null;
    const sk = SKILL_HITS[msg.sk];
    if (!sk || att.state.job !== sk.job || att.state.dead) return false;
    const book = this.skillHits.get(ws) || {}, key = msg.sk + ":" + kind;
    if (now - (book[key] || 0) < sk.cdMs) return false;
    book[key] = now; this.skillHits.set(ws, book);
    return { dmg: sk.dmg, range: sk.range };
  }
  // 打到島主：扣血；若在閒置且冷卻過了 → 開始反擊（樣式照 OWNER_TERRAINS）。攻擊者所在地形決定打的是哪座島的島主
  async dragonHit(ws, att, msg) {
    if (!att.state || !att.terrain) return;
    const terrain = att.terrain;
    if (!OWNER_TERRAINS[terrain]) return;
    const d = await this.getDragon(terrain);
    const now = Date.now();
    if (d.st === "dead") return;
    const sk = this.skillHit(ws, att, msg, "owner", now);
    if (sk === false) return;
    const h = this.dragonHits.get(ws);
    if (!sk && now - (h ? h.t : 0) < D_CD_MS) return;   // 一般攻擊的間隔；職業技能另有自己的冷卻
    this.regenDragon(terrain, now);   // 扣血前先把該補的血補上（之後廣播的 hp 是回血後的值）
    let dmg = sk ? sk.dmg : Math.max(1, Math.min(D_HIT_MAX, Math.round(Number(msg.dmg) || 1)));
    if (now < (d.vulnUntil || 0)) dmg += 1;   // 破綻（近戰輸出的職能技能）：每擊 +1
    const [ph, pos] = this.dragonPhase(terrain, now);
    if (ph === "dash") return;     // 龍衝飛行中打不到（開眼/預警/歇腳與散步時都打得到）
    // 客戶端可能漏接一個路點事件（散步腿落後）：只要它宣稱的島主位置離伺服器的不遠、且玩家貼著宣稱的位置，就接受
    const distSrv = Math.hypot(Number(msg.x) - pos[0], Number(msg.y) - pos[1]);
    const cdx = Number(msg.ddx), cdy = Number(msg.ddy);
    const maxR = sk ? sk.range : msg.staff && RANGED_WEAPONS.includes(att.state.weapon) ? D_STAFF_RANGE : D_RANGE;   // 法杖旗標要配上 state 裡真的拿著法杖／咒杖才算
    let near = distSrv <= maxR;
    if (!near && Number.isFinite(cdx) && Number.isFinite(cdy)) {
      near = Math.hypot(Number(msg.x) - cdx, Number(msg.y) - cdy) <= maxR
          && Math.hypot(cdx - pos[0], cdy - pos[1]) <= D_DRIFT_TOLER;
    }
    if (!near) return;
    if (!sk) this.dragonHits.set(ws, { terrain, t: now });
    else if (!h || h.t < now - D_CD_MS) this.dragonHits.set(ws, { terrain, t: now - D_CD_MS });   // 技能命中也算現役攻擊者（進仇恨換人的候選池），但不佔一般攻擊的間隔
    d.lastHitAt = now;   // 仇恨計時：D_DROPOUT 內沒有人再打牠就脫離追殺
    d.hp -= dmg;
    if (d.hp <= 0) {   // 打倒了：全地形廣播死亡，30 秒後用鬧鐘重生
      d.st = "dead"; d.hp = 0; d.pos = [pos[0], pos[1]]; d.aimTms = 0; d.deadAt = now; d.wander = null; d.aggro = null; d.quote = null; d.sayUntil = 0;
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "dead", x: pos[0], y: pos[1] }, null, terrain);
      await this.armOwnerAlarm();
      return;
    }
    // 反擊：閒置且冷卻過了才觸發。一被打就先建立仇恨（30 秒從最後一次被打起算）；
    // 反擊照樣先放：說台詞（skills.json 的 say:false 就跳過）→（龍衝＝瞬移島緣／石化之瞳＝原地開眼），放完不用再被打就馬上接著追殺同一個攻擊者
    const map = await this.getDragonMap(terrain);
    if (ph === "idle" && map && now >= (d.cooldownUntil || 0)) {
      const q = await this.pickQuote(terrain);   // 黃金肥龍：80% 台詞招式（說台詞→依序放招）、20% 照樣式（龍衝）
      if (q) {
        d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
        this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, terrain);
        this.startQuote(now, terrain, q, pos);
        await this.saveDragon(terrain);
        await this.armOwnerAlarm();
        return;
      }
      const says = await this.ownerSays(terrain);
      d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
      d.sayUntil = says ? now + D_SAY_MS : 0;
      d.atk = [Number(msg.x), Number(msg.y)];   // 記住攻擊者位置：龍衝要穿過這裡／石化之瞳要朝這裡射
      d.wander = null;
      d.pos = [pos[0], pos[1]];   // 打斷散步腿：把位置同步到目前插值點（否則之後的追腿會從舊腿起點出發，client 看起來像瞬移）
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, terrain);
      if (says) this.broadcast({ t: "dragon", ev: "say", x: pos[0], y: pos[1], ms: D_SAY_MS }, null, terrain);
      else await this.startCycle(now, terrain);   // 不講台詞：直接開始預警（會自己存檔並廣播 aim/gaze）
      await this.armOwnerAlarm();
      return;
    }
    // 反擊冷卻中：把攻擊者納入仇恨（從 D_DROPOUT 內打過牠的人隨機挑一位開始追殺；已有目標時由 tick 負責換人）
    if (!d.aggro && ph === "idle" && now < (d.cooldownUntil || 0) && map) {
      const cands = this.aggroCandidates(now, terrain);
      if (cands.length) this.startAggro(now, cands[Math.floor(Math.random() * cands.length)], terrain);
    }
    await this.saveDragonLazy(terrain);   // 扣血：節流存（多人圍毆每秒會打很多下；漏掉的最多 D_SAVE_MS 內的血量，由 dirty 補寫）
    this.broadcast({ t: "dragon", ev: "hp", hp: d.hp }, null, terrain);
    await this.armOwnerAlarm();   // 仇恨開始：快點醒來追殺（下一個醒的時間統一在這裡算）
  }
  // 破綻／降傷（R 鍵，近戰／遠程輸出的職能技能）：所在地形島主 D_DEBUFF_MS 內受到的傷害每擊 +1（伺服器加）／
  // 對所有人造成的傷害 −30%（受害者自判，客戶端看 weakUntil）。伺服器驗證職能、距離、每條連線冷卻；記在島主狀態並廣播、進快照
  async debuff(ws, att, msg) {
    if (!att.state || !att.terrain) return;
    const terrain = att.terrain, st = att.state;
    if (!OWNER_TERRAINS[terrain]) return;
    const kind = msg.kind === "vuln" ? "vuln" : msg.kind === "weak" ? "weak" : null;
    if (!kind || st.dead || roleOf(st) !== (kind === "vuln" ? "melee" : "ranged")) return;
    const d = await this.getDragon(terrain);
    const now = Date.now();
    if (d.st === "dead") return;
    const book = this.debuffs.get(ws) || {};
    if (now - (book[kind] || 0) < D_DEBUFF_CD_MS - 1000) return;
    const [, pos] = this.dragonPhase(terrain, now);
    if (Math.hypot(Number(st.x) - pos[0], Number(st.y) - pos[1]) > D_PROVOKE_RANGE) return;   // 距離同挑釁
    book[kind] = now; this.debuffs.set(ws, book);
    if (kind === "vuln") d.vulnUntil = now + D_DEBUFF_MS; else d.weakUntil = now + D_DEBUFF_MS;
    await this.saveDragonLazy(terrain);
    this.broadcast({ t: "dragon", ev: "debuff", kind, ms: D_DEBUFF_MS, id: att.id, name: st.name || "玩家" }, null, terrain);
  }
  // 挑釁（R 鍵，坦職限定，玩家自選）：把島主的仇恨拉到自己身上。
  // 已有仇恨 → 直接換目標；沒有仇恨且 idle → 照「被打」的同一套反擊流程演出（說台詞→反擊，樣式照 OWNER_TERRAINS）。
  // 伺服器驗證職業（信任 state 的 job 欄位）、距離、每條連線冷卻；不扣血。挑釁者所在地形決定挑釁的是哪座島的島主。
  async provoke(ws, att) {
    if (!att.state || !att.terrain) return;
    const terrain = att.terrain;
    if (!OWNER_TERRAINS[terrain]) return;
    const st = att.state;
    if (roleOf(st) !== "tank" || st.dead) return;   // 坦克職能限定（騎士、戰士）；死了無法挑釁（客戶端會擋 R 鍵，這裡再驗一次）
    const d = await this.getDragon(terrain);
    const now = Date.now();
    if (d.st === "dead") return;
    const pr = this.provokes.get(ws);
    if (now - (pr ? pr.t : 0) < D_PROVOKE_CD_MS) return;   // 冷卻中：忽略（冷卻只在成功出手時計）
    const [ph, pos] = this.dragonPhase(terrain, now);
    if (Math.hypot(Number(st.x) - pos[0], Number(st.y) - pos[1]) > D_PROVOKE_RANGE) return;   // 離島主太遠
    this.provokes.set(ws, { terrain, t: now });
    this.dragonHits.set(ws, { terrain, t: now });   // 挑釁者視同現役攻擊者：進仇恨換人的候選池、並重置脫離計時
    d.lastHitAt = now;
    const name = (st && st.name) || "玩家";
    if (d.aggro) {   // 已在追殺別人（含說台詞中）：仇恨直接轉向挑釁者
      d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
      if (d.sayUntil && now < d.sayUntil) d.atk = [Number(st.x), Number(st.y)];   // 還在說台詞：反擊目標改成挑釁者位置
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name }, null, terrain);
      await this.armOwnerAlarm();   // 快點醒來，追殺改鎖定挑釁者
      return;
    }
    const map = await this.getDragonMap(terrain);
    if (ph === "idle" && map && now >= (d.cooldownUntil || 0)) {
      // 沒有仇恨且閒置：照被打的反擊流程（台詞招式，或照樣式：要講台詞就先講再反擊）
      d.aggro = { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + D_CLAW_MS };
      d.atk = [Number(st.x), Number(st.y)];
      d.wander = null;
      d.pos = [pos[0], pos[1]];   // 打斷散步腿：位置同步到目前插值點（同 dragonHit 的理由）
      this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name }, null, terrain);
      const q = await this.pickQuote(terrain);
      if (q) this.startQuote(now, terrain, q, pos);
      else if (await this.ownerSays(terrain)) {
        d.sayUntil = now + D_SAY_MS;
        this.broadcast({ t: "dragon", ev: "say", x: pos[0], y: pos[1], ms: D_SAY_MS }, null, terrain);
      } else await this.startCycle(now, terrain);
      await this.saveDragon(terrain);
      await this.armOwnerAlarm();
      return;
    }
    if (ph === "idle" && map) {   // 反擊冷卻中且沒有仇恨：直接進入追殺（同 dragonHit 的冷卻路徑）
      d.pos = [pos[0], pos[1]];
      this.startAggro(now, att, terrain);
      await this.saveDragon(terrain);
      await this.armOwnerAlarm();
    }
  }
  // 仇恨狀態的 tick（鬧鐘）：追殺目標（每腿重新瞄準目標目前位置）、進爪擊範圍就站定每秒一抓、
  // 目標死了或 5 秒到隨機換攻擊者、反擊 CD 一到自動放招、超過 D_DROPOUT 沒人打就脫離仇恨回閒晃。
  // 回傳下一個要醒的時間（ms 時間戳），鬧鐘統一由 alarm() 匯總安排
  async aggroTick(now, terrain) {
    const d = this.dragons.get(terrain);
    const ag = d.aggro;
    await this.syncRegen(terrain, now);   // 帶傷回血同步：追殺途中沒人打牠時血條也要爬升
    const map = await this.getDragonMap(terrain);
    // 太久沒人攻擊／沒有島形：脫離仇恨；鬧鐘照 一般 idle 路徑（aggro 已清）走散步
    if (!map || now - (d.lastHitAt || 0) > D_DROPOUT) {
      this.dropAggro(terrain);
      await this.saveDragon(terrain);
      return now + 100;
    }
    let att = this.aggroTarget(ag.id, terrain);
    if (!att || now >= ag.rotateAt) {   // 目標死了或 5 秒到：隨機換下一個攻擊者（沒有其他人就維持原目標）
      const cands = this.aggroCandidates(now, terrain).filter(v => v.id !== ag.id);
      if (cands.length) {
        att = cands[Math.floor(Math.random() * cands.length)];
        ag.id = att.id; ag.rotateAt = now + D_AGGRO_MS;
        await this.saveDragon(terrain);
        this.broadcast({ t: "dragon", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, terrain);
      } else if (!att) {   // 目標死了又沒有其他人可換：脫離仇恨
        this.dropAggro(terrain);
        await this.saveDragon(terrain);
        return now + 100;
      }
    }
    // 反擊冷卻到了：直接對現在的仇恨目標放招（龍衝＝瞬移島緣→預警→衝穿牠；石化之瞳＝原地開眼）；仇恨保持，放完接著追殺
    if (now >= (d.cooldownUntil || 0)) {
      const [, pos2] = this.dragonPhase(terrain, now);
      const q = await this.pickQuote(terrain);
      if (q) {   // 台詞招式：原地說台詞後依序放招（stepQuote 接手），仇恨保持
        this.startQuote(now, terrain, q, pos2);
        await this.saveDragon(terrain);
        return now + 100;
      }
      d.wander = null;
      d.pos = [pos2[0], pos2[1]];   // 打斷追腿：位置同步到目前插值點（同 say 的理由）
      d.atk = [att.state.x, att.state.y];
      const ok = await this.startCycle(now, terrain);
      await this.saveDragon(terrain);
      return ok ? this.dragonIdleAt(terrain) + 100 : now + 100;
    }
    const [ph2, pos] = this.dragonPhase(terrain, now);
    if (ph2 === "say") {   // 還在說台詞：說完（鬧鐘接手反擊）再醒，期間不追不抓
      return (d.sayUntil || now) + 80;
    }
    if (ph2 !== "idle") {   // 預警/龍衝/開眼中：不追不抓、不發 wander（避免 client 的演出被 wander 事件打斷），等循環結束再醒
      return Math.max(now + 60, this.dragonIdleAt(terrain) + 80);
    }
    if (d.aimTms) {   // 反擊循環剛結束（仇恨中沒有人清 aimTms）：清掉讓之後的追腿正常插值
      d.aimTms = 0;
      const st2 = OWNER_TERRAINS[terrain];
      if (st2 !== "gaze" && st2 !== "beam") d.pos = [...d.dest];   // 龍衝落在對岸；石化之瞳／波動砲沒有位移，留在原地
      await this.saveDragon(terrain);
    }
    const dist = Math.hypot(att.state.x - pos[0], att.state.y - pos[1]);
    if (dist <= D_CLAW_RANGE) {   // 進爪擊範圍：站定連抓（每秒一下）；記下位置，快照不會跳回舊點
      d.pos = [pos[0], pos[1]];
      d.wander = null;
      if (now >= ag.clawAt) {
        ag.clawAt = now + D_CLAW_MS;
        await this.saveDragonLazy(terrain);
        this.broadcast({ t: "dragon", ev: "claw", x: pos[0], y: pos[1], tx: att.state.x, ty: att.state.y, id: att.id }, null, terrain);
      }
    } else {   // 追殺腿：接着上一腿走完就重新瞄準目標目前位置（ev: wander 重用同一套客户端插值）
      const w = d.wander;
      // 腿走完、或走了 0.6 秒就重新瞄準：緊咬目標現在的位置（否則龍只會抓到幾秒前的舊位置＝抓空氣）
      if (!w || now >= w.t0 + w.tms || now >= w.t0 + 600) {
        let tx = att.state.x, ty = att.state.y;
        // 不走海：龍在陸地時，直線前方連續 3 格是水就截在海邊（0.6 秒後的重新瞄準會繼續沿岸繞）；
        // 龍本來就在水裡（舊狀態卡海）則不截，直線走回陸地
        if (map) {
          const gx0 = Math.floor(pos[0] / CELL), gy0 = Math.floor(pos[1] / CELL);
          const onLand = gx0 >= 0 && gy0 >= 0 && gx0 < COLS && gy0 < ROWS && !!map[gy0 * COLS + gx0];
          const steps = Math.max(1, Math.ceil(Math.hypot(tx - pos[0], ty - pos[1]) / CELL));
          let water = 0;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const gx = Math.floor((pos[0] + (tx - pos[0]) * t) / CELL), gy = Math.floor((pos[1] + (ty - pos[1]) * t) / CELL);
            if (onLand && (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS || !map[gy * COLS + gx])) {
              if (++water >= 3) {   // 連續 3 格水：截在海邊最後的陸地
                const tt = Math.max(0, (s - water) / steps);
                tx = pos[0] + (tx - pos[0]) * tt;
                ty = pos[1] + (ty - pos[1]) * tt;
                break;
              }
            } else water = 0;
          }
        }
        const tms = Math.max(80, Math.round(Math.hypot(tx - pos[0], ty - pos[1]) / D_CHASE * 1000));
        d.wander = { fx: pos[0], fy: pos[1], tx, ty, tms, t0: now, pause: 0 };
        await this.saveDragonLazy(terrain);
        this.broadcast({ t: "dragon", ev: "wander", fx: pos[0], fy: pos[1], tx, ty, tms }, null, terrain);
      }
    }
    // 下一個醒的時間：腿走完／爪擊／換人／反擊 CD／脫離時限，取最近
    const w = d.wander;
    const ends = [ag.rotateAt, d.cooldownUntil || now, (d.lastHitAt || 0) + D_DROPOUT, ag.clawAt];
    if (w) ends.push(w.t0 + w.tms + 60);
    return Math.max(now + 60, Math.min(...ends) + 25);
  }
  // 回血同步：補血後若 hp 有變化就廣播 hp 事件（lazy 回血只在被打／快照時結算，血條會卡住不動）
  async syncRegen(terrain, now) {
    const d = this.dragons.get(terrain);
    if (d.st === "dead" || d.hp >= D_HP) { this.regenDragon(terrain, now); return false; }
    const before = d.hp;
    this.regenDragon(terrain, now);
    if (d.hp !== before) {
      await this.saveDragonLazy(terrain);
      this.broadcast({ t: "dragon", ev: "hp", hp: d.hp }, null, terrain);
      return true;
    }
    return false;
  }
  // 死亡重生：鬧鐘統一由 armOwnerAlarm 依「deadAt + D_RESPAWN_MS」安排（這裡只是觸發重算）
  async scheduleDragonRespawn(terrain) { await this.armOwnerAlarm(); }
  // 該地形上還有沒有人（沒人的話島主停擺省資源，有人進來再恢復散步）
  hasPlayers(terrain) {
    for (const ws of this.state.getWebSockets()) {
      if ((ws.deserializeAttachment() || {}).terrain === terrain) return true;
    }
    return false;
  }
  // idle 時挑一個新路點散步：附近 6～16 格的隨機陸地，直線別太抄水（與 client 的 ownerPickLeg 一致）
  async startWanderLeg(terrain) {
    const d = this.dragons.get(terrain);
    const map = await this.getDragonMap(terrain);
    if (d.st === "dead" || !map) return null;
    const [, pos] = this.dragonPhase(terrain, Date.now());
    let fx = pos[0], fy = pos[1];
    // 卡海自救（舊狀態）：龍在海裡時先拉回最近的陸地，散步才挑得到路點
    const gx0 = Math.floor(fx / CELL), gy0 = Math.floor(fy / CELL);
    if (!(gx0 >= 0 && gy0 >= 0 && gx0 < COLS && gy0 < ROWS && map[gy0 * COLS + gx0])) {
      const land = this.nearestLand(fx, fy, map);
      if (land) { fx = land[0]; fy = land[1]; d.pos = [fx, fy]; }
    }
    for (let tries = 0; tries < 24; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = (6 + Math.random() * 10) * CELL;
      const tx = fx + Math.cos(ang) * dist, ty = fy + Math.sin(ang) * dist;
      const gx = jsRound(tx / CELL - .5), gy = jsRound(ty / CELL - .5);
      if (gx < 1 || gy < 1 || gx >= COLS - 1 || gy >= ROWS - 1) continue;
      if (!map[gy * COLS + gx]) continue;
      const steps = Math.max(1, Math.ceil(dist / CELL));
      let water = 0;
      for (let s = 0; s <= steps; s++) {
        const sx = fx + (tx - fx) * s / steps, sy = fy + (ty - fy) * s / steps;
        if (!map[Math.floor(sy / CELL) * COLS + Math.floor(sx / CELL)]) water++;
      }
      if (water / (steps + 1) > .1) continue;
      d.wander = { fx, fy, tx: gx * CELL + CELL / 2, ty: gy * CELL + CELL / 2,
                   tms: Math.max(1500, Math.round(dist / D_WALK * 1000)), t0: Date.now(),
                   pause: D_WANDER_PAUSE[0] + Math.round(Math.random() * (D_WANDER_PAUSE[1] - D_WANDER_PAUSE[0])) };
      this.broadcast({ t: "dragon", ev: "wander", fx: d.wander.fx, fy: d.wander.fy, tx: d.wander.tx, ty: d.wander.ty, tms: d.wander.tms }, null, terrain);
      return d.wander;
    }
    return null;   // 挑不到合適的路點：原地下次再試
  }
  // 從 (x,y) 找最近的陸地格中心（卡海自救用）；找不到回 null
  nearestLand(x, y, map) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx >= 0 && gy >= 0 && gx < COLS && gy < ROWS && map[gy * COLS + gx]) return [gx * CELL + CELL / 2, gy * CELL + CELL / 2];
    for (let r = 1; r <= 44; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只看外圈
          const nx = gx + dx, ny = gy + dy;
          if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && map[ny * COLS + nx]) {
            return [nx * CELL + CELL / 2, ny * CELL + CELL / 2];
          }
        }
      }
    }
    return null;
  }
  // 散步的下一個醒的時間（回傳給 alarm() 匯總，不直接排鬧鐘）
  wanderWake(terrain) {
    const d = this.dragons.get(terrain);
    const w = d.wander;
    let at = w ? w.t0 + w.tms + w.pause : Date.now() + 2000;   // 挑不到路點：2 秒後再試
    if (d.st !== "dead" && d.hp < D_HP) {   // 帶傷：散步鬧鐘提前到「回滿血時刻」，醒來補滿並廣播一次
      at = Math.min(at, d.regenT + Math.ceil((D_HP - d.hp) / D_REGEN) * 1000);
    }
    return at + 50;
  }
  // 說完台詞：開始反擊循環（龍衝＝瞬移島緣鎖定攻擊者；石化之瞳＝原地開眼直線鎖定）。回傳是否成功啟動
  async startCycle(now, terrain) {
    const d = this.dragons.get(terrain);
    const map = await this.getDragonMap(terrain);
    if (d.st === "dead" || !map) return false;
    d.sayUntil = 0;
    const ax = d.atk[0], ay = d.atk[1];
    const style = OWNER_TERRAINS[terrain];
    if (style === "gaze" || style === "beam") {   // 原地施放：石化之瞳開眼／波動砲讀條；直線朝攻擊者方向鎖到島緣對岸（光束幾何）
      const ux = ax - d.pos[0], uy = ay - d.pos[1];
      const ul = Math.hypot(ux, uy) || 1;
      d.unit = [ux / ul, uy / ul];
      d.beam = dragonDashDest(map, d.pos[0], d.pos[1], d.unit[0], d.unit[1]);
      d.aimTms = now;
      const castMs = style === "gaze" ? D_GAZE_CAST_MS : D_BEAM_CAST_MS;
      d.cooldownUntil = now + castMs + D_RAGE_MS;
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: style === "gaze" ? "gaze" : "beam", x: d.pos[0], y: d.pos[1], tx: ax, ty: ay, bx: d.beam[0], by: d.beam[1], castMs, hp: d.hp }, null, terrain);
      return true;
    }
    const warp = dragonEdge(map, Math.random() * Math.PI * 2);
    const ux = ax - warp[0], uy = ay - warp[1];
    const ul = Math.hypot(ux, uy) || 1;
    d.warp = warp; d.unit = [ux / ul, uy / ul];
    d.dest = dragonDashDest(map, warp[0], warp[1], d.unit[0], d.unit[1]);
    d.dashLen = Math.hypot(d.dest[0] - warp[0], d.dest[1] - warp[1]);
    d.aimTms = now;
    d.cooldownUntil = now + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS + D_RAGE_MS;
    await this.saveDragon(terrain);
    this.broadcast({ t: "dragon", ev: "aim", x: warp[0], y: warp[1], fx: d.pos[0], fy: d.pos[1], tx: ax, ty: ay, dx: d.dest[0], dy: d.dest[1], castMs: D_CAST_MS, hp: d.hp }, null, terrain);
    return true;
  }
  // 島主鬧鐘（唯一一個鬧鐘，多座島共用）：每座有島主的地形各自推進一步（死→重生；說完台詞→反擊；
  // 仇恨→追殺 tick；閒置→推進散步路點），再取所有島主「下一個要醒的時間」的最早值排鬧鐘。
  // 沒有人在線的島停擺（回 null），等有人進該地形的 enter 再恢復。
  async alarm() {
    const now = Date.now();
    this.alarmAt = null;   // 這個鬧鐘已觸發；之後 setOwnerAlarm 才會真的重排
    let next = null;
    for (const terrain of Object.keys(OWNER_TERRAINS)) {
      try {
        const wake = await this.stepOwner(terrain, now);
        if (wake !== null && wake !== undefined && (next === null || wake < next)) next = wake;
      } catch (e) {
        console.error("[dragon] stepOwner 錯誤：", terrain, e);
        const retry = Date.now() + 5000;   // 出錯的島也要排下一次，否則其他島回 null 時整個鬧鐘就斷了，島主停擺
        if (next === null || retry < next) next = retry;
      }
    }
    for (const terrain of [...this.lurkers.keys()]) {   // 釣上來的怪物（與島主共用同一個鬧鐘）
      try {
        const wake = await this.stepLurker(terrain, now);
        if (wake !== null && (next === null || wake < next)) next = wake;
      } catch (e) {
        console.error("[lurker] stepLurker 錯誤：", terrain, e);
        this.lurkers.delete(terrain);   // 出錯就讓牠消失，不要卡住鬧鐘（客戶端幾秒沒收到事件會自己移除）
      }
    }
    const dirtyWake = await this.flushDragons();   // 節流中沒寫的變動：到期的現在補寫，沒到期的把鬧鐘排進去
    if (dirtyWake !== null && (next === null || dirtyWake < next)) next = dirtyWake;
    if (next !== null) await this.setOwnerAlarm(next);
  }
  // 推進某座島的島主一步，回傳該島下一個要醒的時間（null＝停擺／不用排）
  async stepOwner(terrain, now) {
    const d = await this.getDragon(terrain);
    if (d.st === "dead") {
      if (now < d.deadAt + D_RESPAWN_MS - 500) return d.deadAt + D_RESPAWN_MS;
      const map = await this.getDragonMap(terrain);
      const pos = map ? dragonEdge(map, Math.random() * Math.PI * 2) : [...D_CENTER];
      d.st = "idle"; d.hp = D_HP; d.pos = pos; d.aimTms = 0; d.wander = null; d.sayUntil = 0; d.aggro = null; d.quote = null;
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "spawn", x: pos[0], y: pos[1], hp: d.hp }, null, terrain);
      if (!this.hasPlayers(terrain)) return null;   // 沒人看：等 enter 恢復散步
      await this.startWanderLeg(terrain);
      await this.saveDragon(terrain);
      return this.wanderWake(terrain);
    }
    if (!this.hasPlayers(terrain)) return null;   // 沒人看：停擺（enter 時會恢復）
    if (d.quote) return await this.stepQuote(now, terrain);   // 台詞招式：說完台詞後依序放招
    if (d.sayUntil && now >= d.sayUntil - 50) {   // 說完台詞：開始反擊循環
      d.sayUntil = 0;
      const ok = await this.startCycle(now, terrain);
      return ok ? this.dragonIdleAt(terrain) + 100 : now + 100;
    }
    if (d.sayUntil) {   // 還在說台詞：說完再醒
      return d.sayUntil + 50;
    }
    const [ph] = this.dragonPhase(terrain, now);
    if (ph === "idle") {
      if (d.aggro) {   // 仇恨中：追殺（tick 回傳下一個醒的時間）；保險：tick 出錯就清仇恨讓散步接手，不會卡死
        try { return await this.aggroTick(now, terrain); }
        catch (e) { console.error("[dragon] aggroTick 錯誤：", terrain, e); d.aggro = null; await this.saveDragon(terrain); return now + 100; }
      }
      if (d.aimTms) {   // 反擊循環剛結束：龍衝落在對岸（dest）清掉 aimTms 讓散步插值生效；石化之瞳留在原地
        d.aimTms = 0;
        const style = OWNER_TERRAINS[terrain];
        if (style !== "gaze" && style !== "beam") d.pos = [...d.dest];
      }
      // 帶傷回血：補血（滿血那一刻醒來廣播一次的事由 wanderWake 的提前量處理，不用定期輪詢）
      const damaged = d.st !== "dead" && d.hp < D_HP;
      if (damaged) await this.syncRegen(terrain, now);
      const w = d.wander;
      if (w && now < w.t0 + w.tms + w.pause) return this.wanderWake(terrain);   // 腿還沒走完／還在休息：照表再睡
      await this.startWanderLeg(terrain);
      await this.saveDragon(terrain);
      return this.wanderWake(terrain);
    }
    // 反擊循環中：idle 開始時醒來接著散步
    return this.dragonIdleAt(terrain) + 100;
  }
  // 統一的鬧鐘安排：狀態變動後呼叫，重算所有島主下一次要醒的最早時間（單一 DO 鬧鐘，誰先到誰先處理）
  async armOwnerAlarm() {
    const now = Date.now();
    let next = null;
    for (const terrain of Object.keys(OWNER_TERRAINS)) {
      const d = this.dragons.get(terrain);
      if (!d) continue;   // 還沒用過的島主：等 enter／被打時才會需要
      let wake;
      if (d.st === "dead") wake = d.deadAt + D_RESPAWN_MS;   // 死亡重生不受「有沒有人看」影響
      else if (!this.hasPlayers(terrain)) continue;
      else if (d.quote) wake = d.quote.fires[d.quote.fired] ?? now + 60;   // 台詞招式：下一招放出的時間
      else if (d.sayUntil && now < d.sayUntil) wake = d.sayUntil + 50;
      else if (d.aggro) wake = now + 60;   // 仇恨中：快醒（追殺 tick 會自己細排）
      else if (d.aimTms) wake = this.dragonIdleAt(terrain) + 100;
      else wake = this.wanderWake(terrain);
      if (next === null || wake < next) next = wake;
    }
    for (const terrain of this.dragonDirty) {   // 有節流中沒寫的變動：最晚到期時要醒來補寫
      const due = (this.dragonSavedAt.get(terrain) || 0) + D_SAVE_MS;
      if (next === null || due < next) next = due;
    }
    if (this.lurkers.size && (next === null || now + 60 < next)) next = now + 60;   // 有釣上來的怪物：快醒（追殺 tick 會自己細排）
    if (next !== null) await this.setOwnerAlarm(next);
  }

  // ---- 釣上來的敵對怪物（lurker）----
  // 牠現在的位置：沿著目前這一腿插值（與島主散步同一套，客戶端用同一個 wander 插值演出）
  lurkerPos(L, now) {
    const w = L.wander;
    if (!w) return L.pos;
    const t = Math.min(1, Math.max(0, (now - w.t0) / w.tms));
    return [w.fx + (w.tx - w.fx) * t, w.fy + (w.ty - w.fy) * t];
  }
  lurkerSnapshot(terrain) {
    const L = this.lurkers.get(terrain);
    if (!L) return null;
    const now = Date.now(), pos = this.lurkerPos(L, now), o = { mob: L.mob, x: pos[0], y: pos[1], hp: L.hp, max: L.max, aggro: L.aggro.id };
    if (L.wander) o.wleg = { fx: L.wander.fx, fy: L.wander.fy, tx: L.wander.tx, ty: L.wander.ty, tms: L.wander.tms, el: Math.max(0, Math.min(L.wander.tms, now - L.wander.t0)) };
    return o;
  }
  // 釣到怪物：落在浮標旁最近的陸地（沒有島形就落在釣的人旁邊），立刻鎖定釣到牠的人
  async spawnLurker(ws, att, mob, now) {
    const st = att.state || {}, terrain = att.terrain;
    const map = await this.getDragonMap(terrain);
    const bx = Number(st.fish && st.fish.x), by = Number(st.fish && st.fish.y);
    const fx = Number.isFinite(bx) ? bx : Number(st.x), fy = Number.isFinite(by) ? by : Number(st.y);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return false;
    const land = map ? this.nearestLand(fx, fy, map) : null;
    const pos = land || [Number(st.x) || fx, Number(st.y) || fy];
    this.lurkers.set(terrain, { mob, hp: L_HP, max: L_HP, pos, wander: null, lastHitAt: now,
                                aggro: { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + L_CLAW_MS } });
    this.lurkHits.set(ws, { terrain, t: now });   // 釣到牠的人視同攻擊者（仇恨換人的候選池）
    this.broadcast({ t: "lurker", ev: "spawn", terrain, mob, x: pos[0], y: pos[1], fx, fy, hp: L_HP, max: L_HP,
                     id: att.id, name: st.name || "玩家" }, null, terrain);
    await this.armOwnerAlarm();
    return true;
  }
  // 打釣上來的怪物：扣血（伺服器權威），打倒就消失；距離驗證比照島主（容許客戶端漏接一腿的落後）
  async lurkerHit(ws, att, msg) {
    if (!att.state || !att.terrain) return;
    const terrain = att.terrain, L = this.lurkers.get(terrain);
    if (!L) return;
    const now = Date.now(), h = this.lurkHits.get(ws);
    const sk = this.skillHit(ws, att, msg, "lurker", now);
    if (sk === false) return;
    if (!sk && h && h.terrain === terrain && now - h.t < D_CD_MS) return;
    const pos = this.lurkerPos(L, now);
    const maxR = sk ? sk.range : msg.staff && RANGED_WEAPONS.includes(att.state.weapon) ? L_STAFF_RANGE : L_RANGE;
    const px = Number(msg.x), py = Number(msg.y), cdx = Number(msg.lx), cdy = Number(msg.ly);
    let near = Math.hypot(px - pos[0], py - pos[1]) <= maxR;
    if (!near && Number.isFinite(cdx) && Number.isFinite(cdy))
      near = Math.hypot(px - cdx, py - cdy) <= maxR && Math.hypot(cdx - pos[0], cdy - pos[1]) <= D_DRIFT_TOLER;
    if (!near) return;
    if (!sk) this.lurkHits.set(ws, { terrain, t: now });
    else if (!h || h.t < now - D_CD_MS) this.lurkHits.set(ws, { terrain, t: now - D_CD_MS });   // 技能命中也算攻擊者（仇恨候選），但不佔一般攻擊的間隔
    L.lastHitAt = now;
    L.hp -= sk ? sk.dmg : Math.max(1, Math.min(D_HIT_MAX, Math.round(Number(msg.dmg) || 1)));
    if (L.hp <= 0) {
      this.lurkers.delete(terrain);
      this.broadcast({ t: "lurker", ev: "dead", x: pos[0], y: pos[1] }, null, terrain);
      return;
    }
    this.broadcast({ t: "lurker", ev: "hp", hp: L.hp }, null, terrain);
  }
  // 推進一步（鬧鐘）：沒人看／太久沒人打／目標死了又沒人可換 → 原地消失；否則追殺、貼近就每秒爪擊。回傳下一個要醒的時間
  async stepLurker(terrain, now) {
    const L = this.lurkers.get(terrain);
    if (!L) return null;
    if (!this.hasPlayers(terrain)) { this.lurkers.delete(terrain); return null; }   // 沒人在這個地形：直接消失（不用廣播）
    const pos = this.lurkerPos(L, now);
    const gone = () => {
      this.lurkers.delete(terrain);
      this.broadcast({ t: "lurker", ev: "gone", x: pos[0], y: pos[1] }, null, terrain);
      return null;
    };
    if (now - L.lastHitAt > L_DROPOUT) return gone();
    const ag = L.aggro;
    let att = this.aggroTarget(ag.id, terrain);
    if (!att || now >= ag.rotateAt) {   // 目標死了／離開，或 5 秒到：從最近打過牠的人裡隨機換一個
      const cands = this.aggroCandidates(now, terrain, L_DROPOUT, this.lurkHits).filter(v => v.id !== ag.id);
      if (cands.length) {
        att = cands[Math.floor(Math.random() * cands.length)];
        ag.id = att.id; ag.rotateAt = now + D_AGGRO_MS;
        this.broadcast({ t: "lurker", ev: "aggro", id: att.id, name: (att.state && att.state.name) || "玩家" }, null, terrain);
      } else if (!att) return gone();   // 仇恨對象沒了又沒人可換：仇恨消失 → 原地消失
      else ag.rotateAt = now + D_AGGRO_MS;
    }
    const dist = Math.hypot(att.state.x - pos[0], att.state.y - pos[1]);
    if (dist <= L_CLAW_RANGE) {   // 貼近：站定每秒一抓（受害者自判，與島主爪擊同一套）
      L.pos = [pos[0], pos[1]]; L.wander = null;
      if (now >= ag.clawAt) {
        ag.clawAt = now + L_CLAW_MS;
        this.broadcast({ t: "lurker", ev: "claw", x: pos[0], y: pos[1], tx: att.state.x, ty: att.state.y, id: att.id }, null, terrain);
      }
    } else {
      const w = L.wander;
      if (!w || now >= w.t0 + w.tms || now >= w.t0 + 600) {   // 每 0.6 秒重新瞄準目標目前的位置
        const map = await this.getDragonMap(terrain);
        const [tx, ty] = chaseDest(map, pos, att.state.x, att.state.y);
        const tms = Math.max(80, Math.round(Math.hypot(tx - pos[0], ty - pos[1]) / L_CHASE * 1000));
        L.pos = [pos[0], pos[1]];
        L.wander = { fx: pos[0], fy: pos[1], tx, ty, tms, t0: now };
        this.broadcast({ t: "lurker", ev: "wander", fx: pos[0], fy: pos[1], tx, ty, tms }, null, terrain);
      }
    }
    const ends = [ag.rotateAt, L.lastHitAt + L_DROPOUT, ag.clawAt, now + 600];
    if (L.wander) ends.push(L.wander.t0 + L.wander.tms + 60);
    return Math.max(now + 60, Math.min(...ends) + 25);
  }

  // 家具編輯：伺服器是唯一權威。裝飾模式的變動是「草稿」，客戶端按保存才送 commit（一批操作）；
  // 每個操作各自驗證（不合法的跳過，不影響其他），「清空」只有管理員能做。改完把整份清單廣播給同地形的人
  async commitFurn(ws, att, ops) {
    if (!Array.isArray(ops) || !att.terrain) return;
    const now = Date.now();
    let b = this.commitBucket.get(ws) || { n: COMMIT_BURST, t: now };
    b = { n: Math.min(COMMIT_BURST, b.n + (now - b.t) / COMMIT_REFILL_MS), t: now };
    if (b.n < 1) {   // 保存太頻繁：整批不處理，回報給客戶端（畫面會退回伺服器版本）
      this.commitBucket.set(ws, b);
      try { ws.send(JSON.stringify({ t: "commit_result", applied: 0, rejected: Math.min(ops.length, MAX_OPS), denied: false, limited: true })); } catch { /* 對方已斷線 */ }
      return;
    }
    b.n -= 1;
    this.commitBucket.set(ws, b);
    const terrain = att.terrain, defs = await this.getFurnDefs();
    const items = await this.getFurn(terrain);
    // 水邊：家具在水上的格子要有地板；水上有家具的地板不能拆。還沒收到島形時不檢查（退回只靠客戶端擋）
    const floor = await this.getFloor(terrain), floorDefs = await this.getFloorDefs(), land = await this.getDragonMap(terrain);
    const ground = land ? (x, y) => !!land[y * COLS + x] || floorAt(floor, floorDefs, x, y) >= 0 : null;
    let furnApplied = 0, floorApplied = 0;
    let applied = 0, rejected = 0, denied = false;
    for (const op of ops.slice(0, MAX_OPS)) {
      if (!op || typeof op !== "object") { rejected++; continue; }
      if (op.t === "floor") {      // 地板層：不看身分；水上有家具的地板不能拆
        if (applyFloorOp(floor, floorDefs, op, items, defs, land)) { applied++; floorApplied++; } else rejected++;
        continue;
      }
      if (op.t === "clear" && !att.admin) { denied = true; continue; }
      if (applyFurnOp(items, defs, op, ground)) { applied++; furnApplied++; } else rejected++;
    }
    if (furnApplied) {
      await this.state.storage.put("furn:" + terrain, items);
      this.broadcast({ t: "furn", items }, null, terrain);
    }
    if (floorApplied) {
      await this.state.storage.put("floor:" + terrain, floorToList(floor));
      this.broadcast({ t: "floor", items: floorToList(floor) }, null, terrain);
    }
    try { ws.send(JSON.stringify({ t: "commit_result", applied, rejected, denied })); } catch { /* 對方已斷線 */ }
  }

  // 看板改字：所有人都能改（與一般家具同樣開放）。只接受 manifest 標了 text 的家具、文字最多 SIGN_MAX 字，改完廣播整份擺設
  async editSign(ws, att, msg) {
    const cell = msg.cell;
    if (!Array.isArray(cell) || cell.length !== 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) return;
    const now = Date.now();
    if (now - (this.lastSign.get(ws) || 0) < SIGN_CD_MS) return;
    this.lastSign.set(ws, now);
    const defs = await this.getFurnDefs(), items = await this.getFurn(att.terrain);
    const it = items.find(o => {
      const d = defs.get(o.type);
      return d && d.text && cell[0] >= o.cell[0] && cell[0] < o.cell[0] + d.w && cell[1] >= o.cell[1] && cell[1] < o.cell[1] + d.h;
    });
    if (!it) return;
    const text = String(msg.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, SIGN_MAX).trim();
    if (text) it.text = text; else delete it.text;
    await this.state.storage.put("furn:" + att.terrain, items);
    this.broadcast({ t: "furn", items }, null, att.terrain);
  }

  async webSocketClose(ws) { this.leave(ws); await this.flushDragons(true); }   // 有人離線就把節流中的島主狀態全部寫掉（之後可能沒人了，DO 隨時會休眠）
  async webSocketError(ws) { this.leave(ws); await this.flushDragons(true); }

  leave(ws) {
    this.rate.delete(ws);
    this.lastHit.delete(ws);
    this.lastSign.delete(ws);
    this.commitBucket.delete(ws);
    this.dragonHits.delete(ws);
    this.debuffs.delete(ws);
    this.skillHits.delete(ws);
    this.lastFish.delete(ws);
    const att = ws.deserializeAttachment() || {};
    if (att.terrain) this.broadcast({ t: "leave", id: att.id }, ws, att.terrain);
  }
}

// ============ 全域 Registry（跨島的玩家資料；目前只有魚類圖鑑）============
// 全站只有一個實例（idFromName("global")），只由 Island 透過 REGISTRY 綁定呼叫，沒有對外的路由。
// 資料：dex:<Discord 使用者 ID> → { 地形: { 魚id: { max（最大尺寸 cm）, n（釣到次數）, first（第一次釣到的時間） } } }
// 讀寫在同一個請求裡只 await storage，DO 的 input gate 會擋住其他請求插隊，所以同一人同時送兩筆也不會互相覆蓋
const UID_RE = /^[0-9A-Za-z_-]{1,40}$/;
export class Registry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch { /* 空 body */ }
    const uid = String(body.uid || "");
    if (!UID_RE.test(uid)) return json({ error: "uid" }, 400);
    const key = "dex:" + uid;
    if (url.pathname === "/dex") return json({ dex: (await this.state.storage.get(key)) || {} });
    if (url.pathname === "/catch") {
      const terrain = String(body.terrain), id = String(body.id), size = Number(body.size);
      if (!TERRAIN_RE.test(terrain) || !ID_RE.test(id) || !(size > 0 && size < 100000)) return json({ error: "bad" }, 400);
      const dex = (await this.state.storage.get(key)) || {};
      const t = dex[terrain] || (dex[terrain] = {});
      const e = t[id];
      const isNew = !e, isRecord = !e || size > e.max;
      t[id] = { max: e ? Math.max(e.max, size) : size, n: (e ? e.n : 0) + 1, first: e ? e.first : Date.now() };
      await this.state.storage.put(key, dex);
      return json({ entry: t[id], isNew, isRecord });
    }
    return json({ error: "not found" }, 404);
  }
}
