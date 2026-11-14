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
const COLS = 108, ROWS = 72;   // 前七座島半徑 ×1.5（2026-11-09）；要與 client/js/main.js、tools/dev_server.py 一致
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
const OWNER_TERRAINS = { grass: "dash", night: "gaze", volcano: "beam", machine: "command" };
const D_CAST_MS = 2000;      // 龍衝的島緣鎖定（預警）持續時間（頭上有讀條，跟石化之瞳一樣 2 秒；與 client 的 OWNER_CAST 一致）
const D_GAZE_CAST_MS = 2000; // 石化之瞳的開眼預警持續時間（與 client 的 OWNER_GAZE_CAST 一致）
const D_BEAM_CAST_MS = 2000; // 波動砲的讀條持續時間（與 client 的 OWNER_BEAM_CAST 一致）
const D_COMMAND_CAST_MS = 2000; // 命令（行動／靜止命令）的讀條持續時間（與 client 的 OWNER_COMMAND_CAST 一致；檢定在各客戶端本地）
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
const D_HIT_SANITY = 1e6;   // 一般攻擊打島主／深海魚人的傷害：2026-11-14 使用者要求取消攻擊上限（信任客戶端，等級／職業／武器加成怎麼算都收），這個只擋 Infinity／亂填的天文數字，不是玩法上限
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
// ground(x,y)＝那格能不能放東西（陸地，或水上鋪了地板）；規則與 client/js/main.js 的 canPlaceIn、dev_server.py 的 edit_furn／commit_furn 一致
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
// 暱稱（2026-11-13，使用者要求）：跟著 Discord 帳號（Registry 的 nick:<uid>），只改「顯示名稱」——state.name 對登入者＝暱稱，沒設就是 Discord 名稱；
// 身分仍是 uid（管理員、XP、圖鑑、排行榜去重都看 uid，與名稱無關）。不擋撞名。與 tools/dev_server.py 的 nick_clean 同一套
const NICK_MAX = 12, NICK_CD_MS = 2000;
const nickClean = v => (typeof v === "string" ? v.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NICK_MAX) : "");
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
      gender: look.gender === "female" ? "female" : "male",   // 性別（素體男女）
      race: ["human", "elf", "cat", "lalafell", "giant"].includes(look.race) ? look.race : "human",   // 種族（人類/精靈/貓族/拉拉肥/巨人）
      hair: idOr(look.hair, pl.hair || "hair1"),
      shirt: Math.round(num(look.shirt, 0, 99, pl.shirt ?? 0)),
      pants: Math.round(num(look.pants, 0, 99, pl.pants ?? 0)),
      hat: idOr(look.hat, null),          // 顯示中的帽子 id（裝備或外觀，客戶端已決定好；null＝沒戴）
      top: idOr(look.top, null),          // 顯示中的上衣 id（null＝預設款）
      bottom: idOr(look.bottom, null),    // 顯示中的褲子 id（null＝預設款）
      shoe: idOr(look.shoe, null),        // 顯示中的鞋子 id（null＝預設款）
      face: idOr(look.face, "normal"),    // 臉型（頭型）id
      eyes: idOr(look.eyes, "default_brown"),   // 眼睛（表情_顏色）id
      hatC: hexOr(look.hatC),             // 換色色碼（null＝原色）
      topC: hexOr(look.topC),
      botC: hexOr(look.botC),
      shoeC: hexOr(look.shoeC),
      wlook: idOr(look.wlook, null),      // 武器外觀 id（同類型才會畫，由客戶端判斷）
      hairC: hexOr(look.hairC),           // 調色盤自訂的髮色（null＝用選的那一色）
      eyeC: hexOr(look.eyeC),             // 調色盤自訂的眼睛顏色
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
    // 等級（名牌顯示用）：登入者由伺服器以存檔的 XP 覆寫；訪客照客戶端報的（只影響顯示）
    lvl: Math.max(1, Math.round(num(s.lvl, 1, 2000, prev.lvl ?? 1))),
  };
}

// ---- 等級與 XP（2026-11-06 規劃；第 2 步：登入者的 XP 由伺服器權威記帳，動值都經 Registry）----
// 非主動怪是「刻意不同步」的本機動物，伺服器驗證不到擊倒屬實：信任事件＋夾頻（XP_MOB_CD_MS，2026-11-07 使用者同意）
const CRAFT_KINDS = ["mat", "furn", "rec"];   // 合成解鎖紀錄的三類：素材／家具／配方（素材圖鑑＋配方筆記；2026-11-07）
const CRAFT_MAX = 300;                    // 每類最多存幾筆（存檔安全閥；客戶端信任事件，不驗證 id 是否真的存在）
const CRAFT_SYNC_MAX = 100;               // craftsync 每類一次最多收幾筆
// 擊倒島主紀錄（2026-11-09，使用者要求跟其他成就一樣跟著帳號）：Registry 的 kills:<uid> = {地形: 時間}（有島主的地形，見 OWNER_TERRAINS）。
// 只有伺服器親眼看到的擊倒才算：島主倒下時 30 秒內的參與者由伺服器記帳（本機舊紀錄不上傳，使用者定：重打就重打）。客戶端用 terrain.json 的 owner 換成島主 id
const isOwnerTerrain = t => Object.prototype.hasOwnProperty.call(OWNER_TERRAINS, String(t));
const XP_MAX = 200000;                  // XP 總量上限（防灌分的保險；等級無上限是設計，這裡只是存檔安全閥）
const XP_MOB_CD_MS = 1000;              // 擊倒非主動怪的 XP 冷卻（每條連線；每來源每秒最多 1 次）
const XP_XPE_MAX = 25;                  // 擊倒非主動怪單次事件的 XP 上限（防亂報；2026-11-09 事件帶 n：會反擊的野怪＝島主經驗 1/10，使用者同意延伸）
const DEATH_CREDIT_MIN_MS = 25000;      // 同一條連線的「倒地記帳」（餵島主 XP／魚人升級）最短間隔：復活要 30 秒，正常玩法不會更密；擋住反覆切 state.dead 灌島主等級
const XP_NEED = lv => 10 + 5 * (lv - 1);   // 每級需求 XP；與 client/js/main.js、dev_server.py 相同（改記得三邊都改）
function xpInfo(xp) {                   // XP 換等級：與 client 的 lvInfo 同演算法
  let lv = 1, rest = Math.max(0, Math.floor(xp ?? 0));
  while (lv < 2000 && rest >= XP_NEED(lv)) { rest -= XP_NEED(lv); lv++; }
  return { lv, cur: rest, need: XP_NEED(lv) };
}
// 死亡扣款（與 client 的 loseExp 同值）：扣「升這級還需要的 XP」5%，整數、至少 1、最低扣到 0 不掉級
const xpDeathLoss = xp => { const i = xpInfo(xp); return Math.min(i.cur, Math.max(1, Math.ceil(i.need * .05))); };

// ---- 島主與深海魚人的等級（第 3 步；與 tools/dev_server.py、client/js/main.js 同式，三邊一起改）----
// 島主：等級跟島主狀態存一起（dragon:<地形> 加 xp 欄位），永不重置、無上限；擊倒玩家得 XP＝10＋2×受害者等級。
// 每級需求 20＋10×(Lv−1)；每級血量上限 +25（基礎 D_HP）；爪擊與台詞招式每 2 級 +1（命令檢定不隨等級變強：倒地不看血量）
const DL_HP_UP = 25;
const dlXpNeed = lv => 20 + 10 * (lv - 1);
function dlLv(xp) {   // XP 無上限直算：XP_MAX 200000 也只到約 200 級，迴圈安全
  let lv = 1, rest = Math.max(0, Math.floor(xp ?? 0));
  while (rest >= dlXpNeed(lv)) { rest -= dlXpNeed(lv); lv++; }
  return lv;
}
const dragonMaxHp = d => D_HP + DL_HP_UP * (dlLv(d.xp) - 1);   // 目前等級的血量上限（回血夾這裡）
const dlDmgBonus = lv => Math.floor((Math.max(1, Math.floor(lv)) - 1) / 2);   // 島主爪擊／台詞招式的等級傷害加成
// 深海魚人：session 制——等級只在「這一隻」存活期成長（每殺 1 人 +1 級），消失／被打倒就重來（只放記憶體，天然重置）。
// 每級血量上限 +5（基礎 L_HP）；爪擊每 3 級 +1
const L_HP_UP = 5;
const lurkDmgBonus = lv => Math.floor((Math.max(1, Math.floor(lv)) - 1) / 3);
const lurkerMaxHp = L => L_HP + L_HP_UP * ((L.lvl || 1) - 1);
// 擊倒獎勵：玩家擊倒島主／魚人由伺服器發 XP 給「30 秒內打過牠、還在線沒死」的所有參與者（與擊倒稱號的參與擊倒同一批；
// 訪客不進 Registry，grantXp 自然跳過，客戶端會在 dead 事件本機補發）
const ownerKillXp = lv => 20 + 5 * lv;
const lurkKillXp = lv => 4 + 2 * lv;
// 一般攻擊打島主／魚人的夾值隨攻擊者等級放寬：每 3 級 +1（與 client 的 lvAtkBonus 同式）
const dlHitMax = lvl => D_HIT_SANITY;   // 不再隨等級夾值（保留函式名讓兩處呼叫不用動）
// 島主 hp 廣播：把等級與血量上限一起帶出（升級時客戶端靠這則跟上）
const dragonHpMsg = d => ({ t: "dragon", ev: "hp", hp: d.hp, lvl: dlLv(d.xp), max: dragonMaxHp(d) });

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

// ============ 和平島：遊戲桌（第一桌：抽鬼牌；2026-11-08，使用者要求）============
// 牌局由伺服器權威：洗牌、發牌、抽牌、判定都在這裡，手牌只送給本人（別人只看得到張數）。
// 與 tools/dev_server.py 的 TABLE_DEFS／om_* 同一套邏輯，改規則兩邊一起改。桌子的位置與外觀在客戶端 terrain.json 的 tables。
// 牌桌狀態存 storage（key `table:<桌 id>`）：DO 會休眠，玩家想牌超過幾秒記憶體就沒了，不存的話牌局會憑空消失。
const TABLE_DEFS = { peace: { t1: "oldmaid", t2: "gomoku", t5: "dodge", t6: "uno", t7: "typing", t8: "intel", t9: "zhtyping", t10: "mage", t11: "blokus", t12: "trigon", t13: "arcade", t14: "maze", t15: "hockey", t16: "hockey", t17: "kingdom", t18: "bigtwo" } };   // 地形 → 桌 id → 遊戲 id（客戶端 terrain.json 的 tables 要一致）
const GAME_LIMITS = { oldmaid: [2, 4], gomoku: [2, 2], dodge: [1, 8], uno: [2, 6], typing: [1, 8], zhtyping: [1, 8], intel: [3, 8], mage: [1, 4], blokus: [2, 4], trigon: [2, 4], arcade: [1, 4], maze: [1, 5], hockey: [2, 4], kingdom: [3, 4], bigtwo: [2, 4] };           // 遊戲 → [開局最少人數, 入座上限]
const TBL_TYP_CD_MS = 200;                       // 英文打字競賽的打字進度回報（typ）：每條連線最短間隔（客戶端約每 250ms 一次）
const TBL_POS_CD_MS = 60;                          // 躲彈幕的位置回報、英文打字競賽的分數回報：每條連線最短間隔（客戶端實際約 8 次／秒）
const TBL_CD_MS = 100;                             // 每條連線兩次牌桌操作的最短間隔
// 玩小遊戲得 XP（2026-11-08，使用者要求；數值是助手先訂的）：對局正常結束（沒人中途離開）時，每位入座者各得一份，寫在 result.xp（依座位順序）
// 輸贏經驗一樣（使用者定）：抽鬼牌每位 +4；五子棋勝／負／平手都 +5（下不到 10 手就結束的不給，擋刷分）。
// 登入者由伺服器記帳（同一帳號兩次得分最短間隔 GAME_XP_CD_MS）；訪客由客戶端看 result.xp 本機補發
const GAME_XP_CD_MS = 30000;
const OM_XP = 4;      // 抽鬼牌：每位入座者（過關者與輸家一樣）
const GM_XP = 5;      // 五子棋：勝／負／平手都一樣
const GM_XP_MIN_MOVES = 10;
// 遊戲戰績（2026-11-13，使用者要求「幫小遊戲設計稱號」）：跟著 Discord 帳號存在 Registry 的 gstats:<uid> = {遊戲 id: {鍵: 數字}}；各遊戲結算時在 result.gs
// （依「結算後留下的座位」順序，與 result.xp 同；null＝這一局不記）帶每位入座者的戰績增量 {add: 累加, max: 取較大, min: 取較小}，伺服器（tableStats）照著寫進 Registry，
// 再把整份 gstats 送給本人；result.gs 不含 uid，訪客由客戶端本機套用。每局都有 p（局數）；其餘鍵見 docs/notes.md「小遊戲戰績與稱號」。與 tools/dev_server.py 的 gs_mk 同一套
const GS_GAMES = new Set(["oldmaid", "gomoku", "dodge", "uno", "typing", "zhtyping", "intel", "mage", "blokus", "trigon", "arcade", "maze", "hockey", "kingdom", "bigtwo"]), GS_KEY_RE = /^[a-z0-9_]{1,12}$/, GS_CAP = 1000000, GS_KEYS_MAX = 24;
const gsMk = (add, mx, mn) => ({ add: { p: 1, ...(add || {}) }, max: mx || {}, min: mn || {} });
const OM_SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const omRank = c => (c === "JK" ? null : Number(c.slice(1)));
const omLabel = c => {
  const r = omRank(c);
  return r === null ? "鬼牌" : OM_SYM[c[0]] + ({ 1: "A", 11: "J", 12: "Q", 13: "K" }[r] || String(r));
};
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// 丟掉成對的牌（同點數兩張一對；鬼牌不成對）。回 [剩下的牌（已洗亂）, 丟掉的牌]
function omDropPairs(hand) {
  const by = new Map(), keep = [], gone = [];
  for (const c of hand) { const r = omRank(c); if (!by.has(r)) by.set(r, []); by.get(r).push(c); }
  for (const [r, cs] of by) {
    if (r === null) { keep.push(...cs); continue; }
    const n = Math.floor(cs.length / 2) * 2;
    gone.push(...cs.slice(0, n)); keep.push(...cs.slice(n));
  }
  return [shuffle(keep), gone];
}
const tblNew = (id, game) => ({ id, game, phase: "lobby", seats: [], specs: [], turn: -1, result: null, log: [], g: null });   // g：遊戲自己的狀態（五子棋的棋盤；抽鬼牌用不到）
function tblFind(t, cid) {
  let i = t.seats.findIndex(s => s.cid === cid);
  if (i >= 0) return ["seat", i];
  i = t.specs.findIndex(s => s.cid === cid);
  return i >= 0 ? ["spec", i] : [null, -1];
}
function tblLog(t, text) { t.log.push(text); if (t.log.length > 8) t.log.splice(0, t.log.length - 8); }
function tblNextActive(t, i) {   // 座位 i 之後（順時針）第一個還沒出局的座位；沒有回 -1
  const n = t.seats.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (!t.seats[j].out) return j; }
  return -1;
}
function tblResetSeats(t) {
  for (const s of t.seats) { s.ready = false; s.hand = []; s.out = false; }
  t.phase = "lobby"; t.turn = -1; t.g = null;
}
// want＝"seat"（有空位且還沒開局才會入座，否則自動觀戰）或 "spec"（使用者自己選觀戰：沒滿人也可以）
function tblJoin(t, cid, name, want, uid) {
  if (tblFind(t, cid)[0]) return;
  const mx = GAME_LIMITS[t.game][1];
  if (want !== "spec" && t.phase === "lobby" && t.seats.length < mx) { t.seats.push({ cid, name, uid: uid || null, ready: false, hand: [], out: false }); tblLog(t, `${name} 入座了`); }
  else { t.specs.push({ cid, name, uid: uid || null }); tblLog(t, `${name} 來觀戰`); }
}
function tblLeave(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (role === "spec") t.specs.splice(i, 1);
  else if (role === "seat") {
    const name = t.seats[i].name;
    if (t.game === "arcade") { arLeave(t, i); return; }   // 俄羅斯方塊：單人局作廢、聯機照當時分數排名，不中斷其他人
    if (t.phase === "playing" && t.game === "trigon") { tgLeave(t, i, Date.now()); return; }   // Blokus Trigon：離開不中斷，棋子留在棋盤上、之後跳過
    if (t.phase === "playing" && t.game === "bigtwo") { btLeave(t, i, Date.now()); return; }   // 大老二：離開者手牌作廢，其餘人繼續（剩不到 2 人就結束）
    if (t.phase === "playing" && t.game === "kingdom") { kgLeave(t, i, Date.now()); return; }   // 列島建國：離開者視同棄權，其餘人繼續（剩不到 2 人就結束）
    if (t.phase === "playing" && t.game === "blokus") { bkLeave(t, i, Date.now()); return; }   // Blokus：離開不中斷，棋子留在棋盤上、之後跳過
    if (t.phase === "playing" && t.game === "mage") { mgLeave(t, i, Date.now()); return; }   // 見習驅魔師：離開不中斷，視同倒下，到場上沒有活人為止
    if (t.phase === "playing" && t.game === "maze") { mzLeave(t, i); return; }   // 豆豆迷宮：幽靈離開改由電腦控制、豆豆離開＝幽靈方贏
    if (t.phase === "playing" && t.game === "dodge") { dgLeave(t, i, Date.now()); return; }   // 躲彈幕：離開不中斷，視同淘汰，到場上沒有活人為止
    if (t.phase === "playing" && t.game === "uno") { unLeave(t, i, Date.now()); return; }   // UNO：離開不中斷，手牌收回牌堆，只剩 1 人時那人獲勝
    if (t.phase === "playing" && isTy(t)) { tyLeave(t, i, Date.now()); return; }   // 英文打字競賽：離開不中斷，照當時分數排名
    if (t.phase === "playing" && t.game === "intel") { itLeave(t, i, Date.now()); return; }   // 秘藥情報戰：離開不中斷，翻開身分，場上只剩一個陣營時結束   // 英文打字競賽：離開不中斷，照當時分數排名
    if (t.phase === "playing") {   // 使用者定：有人離開（含斷線）直接結束這一局
      t.result = { aborted: true, text: `${name} 離開了，這一局結束` };
      tblResetSeats(t);
      tblLog(t, t.result.text);
    } else tblLog(t, `${name} 離開了座位`);
    t.seats.splice(i, 1);
  }
}
function tblSit(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (role !== "spec" || t.phase !== "lobby" || t.seats.length >= GAME_LIMITS[t.game][1] || t.game === "arcade") return;   // 俄羅斯方塊：要入座就走到空機台
  const s = t.specs.splice(i, 1)[0];
  t.seats.push({ cid, name: s.name, uid: s.uid || null, ready: false, hand: [], out: false });
  tblLog(t, `${s.name} 入座了`);
}
function tblReady(t, cid, v) {
  const [role, i] = tblFind(t, cid);
  if (role !== "seat" || t.phase !== "lobby" || t.game === "arcade") return;
  t.seats[i].ready = !!v;
  tblCheckStart(t);
}
function tblCheckStart(t) {
  if (t.phase === "lobby" && t.seats.length >= GAME_LIMITS[t.game][0] && t.seats.every(s => s.ready)) GAME_START[t.game](t);   // 使用者定：全員按「準備」才開始
}
// 入座的人改成觀戰（只有還沒開局時；進行中要離開就是 leave，會結束這一局）。剩下的人若都已準備就開局
function tblStand(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (role !== "seat" || t.phase !== "lobby" || t.game === "arcade") return;
  const s = t.seats.splice(i, 1)[0];
  t.specs.push({ cid, name: s.name, uid: s.uid || null });
  tblLog(t, `${s.name} 改為觀戰`);
  tblCheckStart(t);
}
function omStart(t) {
  const deck = [];
  for (const s of "SHDC") for (let r = 1; r <= 13; r++) deck.push(`${s}${r}`);
  deck.push("JK"); shuffle(deck);
  const n = t.seats.length;
  t.seats.forEach((s, k) => { s.hand = deck.filter((_, j) => j % n === k); s.out = false; s.ready = false; });
  t.result = null; t.phase = "playing";
  tblLog(t, "牌局開始，發牌！");
  for (const s of t.seats) {
    const [keep, gone] = omDropPairs(s.hand);
    s.hand = keep;
    if (gone.length) tblLog(t, `${s.name} 先丟掉了 ${gone.length / 2} 對牌`);
    s.out = !s.hand.length;
  }
  const alive = t.seats.map((s, i) => (s.out ? -1 : i)).filter(i => i >= 0);
  if (alive.length <= 1) { omFinish(t, alive[0]); return; }
  t.turn = alive[Math.floor(Math.random() * alive.length)];
  tblLog(t, `由 ${t.seats[t.turn].name} 先抽牌`);
}
function omFinish(t, loser) {
  const name = t.seats[loser].name;
  t.result = { loser, name, text: `${name} 抽到鬼牌，輸了！`, rid: Math.floor(Math.random() * 4294967296), xp: t.seats.map(() => OM_XP), gs: t.seats.map((s, k) => gsMk(k === loser ? { l: 1 } : { s: 1 })) };
  tblLog(t, t.result.text);
  tblResetSeats(t);
}
function omDraw(t, cid, idx) {
  const [role, i] = tblFind(t, cid);
  if (t.game !== "oldmaid" || role !== "seat" || t.phase !== "playing" || i !== t.turn) return;
  const tgt = tblNextActive(t, i);
  if (tgt < 0 || tgt === i) return;
  const me = t.seats[i], th = t.seats[tgt];
  if (!Number.isInteger(idx) || idx < 0 || idx >= th.hand.length) return;
  const card = th.hand.splice(idx, 1)[0];
  me.hand.splice(Math.floor(Math.random() * (me.hand.length + 1)), 0, card);   // 抽到的牌插在隨機位置（不是固定最右邊，否則對方避開最右邊就不會抽到剛換手的鬼牌）
  tblLog(t, `${me.name} 從 ${th.name} 手上抽了一張牌`);
  if (card !== "JK") {
    const mate = me.hand.find(c => c !== card && omRank(c) === omRank(card));
    if (mate) {
      me.hand.splice(me.hand.indexOf(card), 1);
      me.hand.splice(me.hand.indexOf(mate), 1);
      tblLog(t, `${me.name} 湊成一對（${omLabel(card)}、${omLabel(mate)}）丟掉`);
    }
  }
  // 不自動洗牌：對方點的是「第幾張牌背」，要和這個人畫面上手牌的順序一致，洗牌是玩家自己的心理戰（omShuffle）
  for (const s of [me, th]) if (!s.hand.length && !s.out) { s.out = true; tblLog(t, `${s.name} 的牌出完了，安全過關！`); }
  const alive = t.seats.map((s, k) => (s.out ? -1 : k)).filter(k => k >= 0);
  if (alive.length <= 1) { omFinish(t, alive[0]); return; }
  t.turn = tblNextActive(t, i);
}
// 玩家自己洗牌（心理戰：讓對方猜不到鬼牌在哪）；手牌順序就是對方看到的牌背順序
function omShuffle(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (t.game !== "oldmaid" || role !== "seat" || t.phase !== "playing" || t.seats[i].hand.length < 2) return;
  shuffle(t.seats[i].hand);
  tblLog(t, `${t.seats[i].name} 洗了牌`);
}
// ---- 五子棋（第二桌；2026-11-08，使用者要求）：15×15、兩人、黑棋先下（開局隨機決定誰執黑）、橫直斜連成五子（含以上）就贏、棋盤滿了平手 ----
const GM_N = 15;
function gmStart(t) {
  const black = Math.floor(Math.random() * 2);   // 座位 0／1 誰執黑
  t.g = { board: new Array(GM_N * GM_N).fill(0), black, last: null, line: null, moves: [] };   // board：0 空、1 黑、2 白
  t.result = null; t.phase = "playing"; t.turn = black;   // 黑先
  for (const s of t.seats) s.ready = false;
  tblLog(t, `對局開始，${t.seats[black].name} 執黑先下`);
}
// 剛下在 (x, y) 的棋是否連成五子（含以上）：回連成的那一排（座標清單），沒有回 null
function gmLine(board, x, y, color) {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const cells = [[x, y]];
    for (const sgn of [1, -1]) {
      let cx = x + dx * sgn, cy = y + dy * sgn;
      while (cx >= 0 && cx < GM_N && cy >= 0 && cy < GM_N && board[cy * GM_N + cx] === color) { cells.push([cx, cy]); cx += dx * sgn; cy += dy * sgn; }
    }
    if (cells.length >= 5) return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return null;
}
// 對局結束：winner＝座位編號，null＝平手。棋盤留著給大家看（到下一局開始才清掉）
function gmFinish(t, winner) {
  const g = t.g, nm = (g.moves || []).length, enough = nm >= GM_XP_MIN_MOVES, rid = Math.floor(Math.random() * 4294967296);
  const gs = [0, 1].map(k => (enough ? gsMk(winner === k ? { w: 1 } : {}, {}, winner === k ? { fm: nm } : {}) : null));   // 下不到 10 手的不記（同 XP，擋互刷）；fm＝獲勝時的總手數（取最小）
  if (winner === null) t.result = { draw: true, text: "棋盤下滿了，平手！", rid, xp: [enough ? GM_XP : 0, enough ? GM_XP : 0], gs };
  else { const name = t.seats[winner].name; t.result = { winner, name, text: `${name} 五子連線，獲勝！`, rid, xp: [enough ? GM_XP : 0, enough ? GM_XP : 0], gs }; }
  tblLog(t, t.result.text);
  tblResetSeats(t);
  t.g = g;
}
function gmMove(t, cid, x, y) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "gomoku" || role !== "seat" || t.phase !== "playing" || i !== t.turn || !g) return;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= GM_N || y < 0 || y >= GM_N) return;
  if (g.board[y * GM_N + x]) return;
  const color = i === g.black ? 1 : 2;
  g.board[y * GM_N + x] = color;
  g.last = [x, y];
  (g.moves || (g.moves = [])).push([x, y]);   // （舊存檔的對局沒有 moves：補上）每一手的座標（第 0 手是黑棋；結束後給客戶端復盤）
  const line = gmLine(g.board, x, y, color);
  if (line) { g.line = line; gmFinish(t, i); }
  else if (g.board.every(c => c)) gmFinish(t, null);
  else t.turn = 1 - i;
}
// ---- Blokus（第十一桌 t11；2026-11-13，使用者要求）：2～4 人、20×20、每人 21 塊（1～5 格，共 89 格）、標準規則 ----
// 第一塊要蓋住自己的角落；之後每塊都要「角對角」接到自己的舊方塊，且不能「邊對邊」；碰到別人的不限。放不下的人自動跳過（之後一直跳過），全員放不下就結束。
// 計分＝−剩下的格數；全部放完 +15、最後一塊是單格再 +5。每手限時 BK_TURN_MS（客戶端到時送 timeout，伺服器核對時鐘；連續超時 BK_IDLE_MAX 次視為棄權）。
// 排行榜沒有（使用者定）。與 tools/dev_server.py 的 bk_* 同一套。
const BK_N = 20, BK_TURN_MS = 45000, BK_IDLE_MAX = 2, BK_XP = 6, BK_TOTAL = 89;
const BK_SHAPES = [["#"], ["##"], ["###"], ["##", "#."], ["####"], ["##", "##"], ["###", ".#."], ["###", "#.."], [".##", "##."],
  [".##", "##.", ".#."], ["#####"], ["####", "#..."], ["##..", ".###"], ["##", "##", "#."], ["###", ".#.", ".#."], ["#.#", "###"],
  ["#..", "#..", "###"], ["#..", "##.", ".##"], [".#.", "###", ".#."], ["####", ".#.."], ["##.", ".#.", ".##"]];   // 21 塊：1／2／3×2／4×5／5×12
const BK_PIECES = BK_SHAPES.map(rows => { const c = []; rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "#") c.push([x, y]); })); return c; });
const BK_CORNERS = [[0, 0], [BK_N - 1, 0], [BK_N - 1, BK_N - 1], [0, BK_N - 1]];
// 2 人局用 Blokus Duo 規則（2026-11-13，使用者要求）：14×14 的棋盤，兩人的起始格是 (4, 4) 與 (9, 9)（不是角落）；3～4 人仍是 20×20、四個角落。
// 開局時把棋盤大小 g.size 與各座位的起始格 g.start 記進狀態（舊存檔沒有這兩個欄位：當作 20×20、角落）
const BK_DUO_N = 14, BK_DUO_START = { 0: [4, 4], 2: [9, 9] };   // 顏色 → 起始格（Duo；2 人用顏色 0 與 2）
const bkSize = g => g.size || BK_N, bkStartOf = (g, k) => (g.start ? g.start[k] : BK_CORNERS[g.col[k]]);   // 顏色 0～3 的起始角落（藍左上、黃右上、紅右下、綠左下）
function bkNorm(cells) {
  const mx = Math.min(...cells.map(c => c[0])), my = Math.min(...cells.map(c => c[1]));
  return cells.map(c => [c[0] - mx, c[1] - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
const bkKey = cells => bkNorm(cells).map(c => c.join(",")).join(";");
const BK_ORI = BK_PIECES.map(cells => {   // 每塊的所有不重複方向（旋轉 4 × 翻面 2）
  const seen = new Map(); let c = cells;
  for (let f = 0; f < 2; f++) { for (let r = 0; r < 4; r++) { const n = bkNorm(c); seen.set(bkKey(n), n); c = c.map(([x, y]) => [-y, x]); } c = c.map(([x, y]) => [-x, y]); }
  return [...seen.values()];
});
const BK_ORI_KEYS = BK_ORI.map(os => new Set(os.map(bkKey)));
const BK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]], BK_DIAGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
// 座標 cells（絕對座標）放給座位 k 合不合法
function bkLegal(g, k, cells) {
  const N = bkSize(g), col = g.col[k] + 1, [sx, sy] = bkStartOf(g, k), first = g.sd[k].placed === 0;
  let corner = false, start = false;
  for (const [x, y] of cells) {
    if (x < 0 || y < 0 || x >= N || y >= N || g.board[y * N + x]) return false;
    if (x === sx && y === sy) start = true;
    for (const [dx, dy] of BK_DIRS) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < N && b < N && g.board[b * N + a] === col) return false; }
    for (const [dx, dy] of BK_DIAGS) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < N && b < N && g.board[b * N + a] === col) corner = true; }
  }
  return first ? start : corner;
}
// 座位 k 所有合法放法 [{p, key, cells}]（依 key 排序，測試用）；one＝true 時找到一個就回（判斷有沒有地方放）
function bkMoves(g, k, one) {
  const N = bkSize(g), col = g.col[k] + 1, sd = g.sd[k], out = [], seen = new Set(), anchors = [];
  if (sd.placed === 0) anchors.push(bkStartOf(g, k));
  else {
    const mark = new Set();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (g.board[y * N + x] !== col) continue;
      for (const [dx, dy] of BK_DIAGS) {
        const a = x + dx, b = y + dy;
        if (a < 0 || b < 0 || a >= N || b >= N || g.board[b * N + a] || mark.has(b * N + a)) continue;
        if (BK_DIRS.some(([ex, ey]) => { const c = a + ex, d = b + ey; return c >= 0 && d >= 0 && c < N && d < N && g.board[d * N + c] === col; })) continue;
        mark.add(b * N + a); anchors.push([a, b]);
      }
    }
  }
  for (let p = 0; p < BK_PIECES.length; p++) {
    if (sd.used.includes(p)) continue;
    for (const o of BK_ORI[p]) for (const [cx, cy] of o) for (const [ax, ay] of anchors) {
      const cells = o.map(([x, y]) => [x - cx + ax, y - cy + ay]);
      if (!bkLegal(g, k, cells)) continue;
      const key = p + ":" + cells.map(c => c[1] * N + c[0]).sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key); out.push({ p, key, cells });
      if (one) return out;
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
const bkRem = (g, k) => BK_TOTAL - g.sd[k].used.reduce((a, p) => a + BK_PIECES[p].length, 0);
const bkScore = (g, k) => { const r = bkRem(g, k); return -r + (r === 0 ? 15 + (g.sd[k].mono ? 5 : 0) : 0); };
function bkStart(t) {
  const n = t.seats.length, now = Date.now(), cols = shuffle(n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n));   // 2 人坐對角；顏色隨機分配
  const size = n === 2 ? BK_DUO_N : BK_N;   // 2 人＝Blokus Duo（14×14、起始格 (4, 4)／(9, 9)）
  t.g = { size, start: cols.map(c => (n === 2 ? BK_DUO_START[c] : BK_CORNERS[c])), board: new Array(size * size).fill(0), col: cols, sd: cols.map(() => ({ used: [], placed: 0, done: false, idle: 0, forfeit: false, mono: false })), last: null, moves: 0, deadline: now + BK_TURN_MS };
  t.result = null; t.phase = "playing"; t.turn = cols.indexOf(0);   // 藍色先下
  for (const s of t.seats) { s.ready = false; s.left = false; }
  tblLog(t, `Blokus 開始！${n} 人參加，${t.seats[t.turn].name}（藍）先下`);
}
// 輪到 from 之後的下一位還能下的人；放不下的人標成 done（之後一直跳過）；沒有人能下就結束
function bkAdvance(t, from, now) {
  const g = t.g, n = t.seats.length;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n, sd = g.sd[j];
    if (sd.done) continue;
    if (!bkMoves(g, j, true).length) { sd.done = true; tblLog(t, `${t.seats[j].name} 沒有地方可以放了，之後跳過`); continue; }
    t.turn = j; g.deadline = now + BK_TURN_MS; return;
  }
  bkFinish(t);
}
function bkFinish(t) {
  const g = t.g;
  const players = t.seats.map((s, k) => ({ name: s.name, col: g.col[k], rem: bkRem(g, k), score: bkScore(g, k), left: !!s.left, forfeit: !!g.sd[k].forfeit }));
  const best = Math.max(...players.map(p => p.score)), winners = players.map((p, k) => (p.score === best ? k : -1)).filter(k => k >= 0);
  const stay = t.seats.filter(s => !s.left), active = t.seats.filter((s, k) => !s.left && !g.sd[k].forfeit).length;
  const xp = stay.map(s => (active >= 2 && !g.sd[t.seats.indexOf(s)].forfeit ? BK_XP : 0));
  const names = winners.map(k => players[k].name).join("、");
  const text = winners.length > 1 ? `${names} 同分平手（${best} 分）` : `${names} 獲勝！（${best} 分）`;
  const gs = stay.map(s => { const k = t.seats.indexOf(s), p = players[k]; return active >= 2 && !p.forfeit ? gsMk({ ...(winners.includes(k) ? { w: 1 } : {}), ...(p.rem === 0 ? { all: 1 } : {}), ...(p.rem === 0 && g.sd[k].mono ? { mono: 1 } : {}), ...(winners.includes(k) && bkSize(g) === 14 ? { duo: 1 } : {}) }) : null; });   // all＝21 塊全放完、mono＝最後一塊是單格、duo＝2 人局（Duo）獲勝
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), xp, players, winners, draw: winners.length > 1, gs };
  tblLog(t, text);
  tblResetSeats(t);
  t.g = g;   // 最後的棋盤留著給大家看，到下一局開始才清掉
}
function bkPlace(t, cid, p, cs, now) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "blokus" || role !== "seat" || t.phase !== "playing" || i !== t.turn || !g || now < 0) return;
  if (!Number.isInteger(p) || p < 0 || p >= BK_PIECES.length || g.sd[i].used.includes(p) || !Array.isArray(cs) || cs.length !== BK_PIECES[p].length) return;
  const cells = [];
  for (const c of cs) { if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1])) return; cells.push([c[0], c[1]]); }
  if (!BK_ORI_KEYS[p].has(bkKey(cells)) || !bkLegal(g, i, cells)) return;
  const sd = g.sd[i];
  for (const [x, y] of cells) g.board[y * bkSize(g) + x] = g.col[i] + 1;
  sd.used.push(p); sd.placed++; sd.idle = 0; sd.mono = p === 0;
  g.last = { seat: i, cells }; g.moves++;
  bkAdvance(t, i, now);
}
// 回合限時到了：跳過；連續超時 BK_IDLE_MAX 次視為棄權（不然一個人掛機整桌會一直等）
function bkTimeout(t, now) {
  const g = t.g;
  if (t.game !== "blokus" || t.phase !== "playing" || !g || now < g.deadline - 300) return;
  const i = t.turn, sd = g.sd[i];
  sd.idle++;
  if (sd.idle >= BK_IDLE_MAX) { sd.done = true; sd.forfeit = true; tblLog(t, `${t.seats[i].name} 連續超時，視為棄權`); }
  else tblLog(t, `${t.seats[i].name} 超時，跳過這一手`);
  bkAdvance(t, i, now);
}
function bkLeave(t, i, now) {   // 遊戲進行中有人離開：棋子留在棋盤上、之後跳過；沒人能下就結束
  const s = t.seats[i], g = t.g;
  if (s.left) return;
  s.left = true; s.cid = null; g.sd[i].done = true;
  tblLog(t, `${s.name} 離開了`);
  if (i === t.turn) bkAdvance(t, i, now);
  else if (g.sd.every(d => d.done)) bkFinish(t);
}
// ---- 列島建國（第十七桌 t17；2026-11-14，使用者要求）：3～4 人、引擎構築＋共同目標＋事件牌；規格見 docs/kingdom-spec.md ----
// 規則與 tools/dev_server.py 的 kg_* 是同一套（逐行對照）；牌庫資料在 client/assets/kingdom/cards.json（tools/kingdom_cards.py 產生），由 Island.kgLoad 從 assets 讀進 KG。
// 每回合做一件「主要動作」（拿資源 kt／保留 kr／建造 kb／跳過 kp），另有不佔回合的「交易 kx」「封鎖 kk」。伺服器權威：其他人手上保留的牌只告訴張數。
const KG_TURN_MS = 90000, KG_IDLE_MAX = 2, KG_XP = 10, KG_WIN_VP = 25, KG_RES = "WSFI";
const KG_SUP = { 3: 5, 4: 7 };   // 每種資源的庫存（依人數）
const KG_MSGS = new Set(["kt", "kr", "kb", "kx", "kk", "kp"]);
let KG = null;   // { cards: id → 牌, raw: cards.json }；Island.kgLoad 載入（沒載入時 kg* 不能用）
function kgSetData(raw) {
  const cards = {};
  for (const key of ["buildings", "people", "wonders"]) for (const c of raw[key]) cards[c.id] = c;
  KG = { cards, raw };
}
const kgCard = cid => KG.cards[cid];
const kgNewSd = () => ({ res: { W: 0, S: 0, F: 0, I: 0 }, gold: 0, bld: [], ppl: [], won: [], hand: [], block: null, traded: false, blkUsed: false, idle: 0, done: false, forfeit: false, bonus: 0, firstbld: false });
function kgProd(sd) {
  const c = { W: 0, S: 0, F: 0, I: 0 };
  for (const cid of sd.bld) c[kgCard(cid).gives]++;
  return c;
}
const kgHas = (sd, ab) => sd.ppl.some(p => kgCard(p).ab === ab);
const kgEvent = (g, off = 0) => { const r = g.round - 1 + off; return r < g.evdeck.length ? g.evdeck[r] : "calm"; };
const kgTotal = sd => KG_RES.split("").reduce((a, r) => a + sd.res[r], 0) + sd.gold;
const kgLimit = sd => 10 + (kgHas(sd, "limit") ? 2 : 0);
const kgHandLimit = sd => 3 + (kgHas(sd, "limit") ? 1 : 0);
function kgVp(g, k) {
  const sd = g.sd[k];
  let v = sd.bonus;
  for (const c of [...sd.bld, ...sd.ppl, ...sd.won]) v += kgCard(c).vp;
  for (const cid of sd.bld) {
    const fx = kgCard(cid).fx;
    if (fx && fx.k === "vp_per") {
      const cnt = fx.of === "people" ? sd.ppl.length : fx.of === "wonder" ? sd.won.length : sd.bld.filter(b => kgCard(b).tier === 1).length;
      v += fx.vp * Math.floor(cnt / fx.per);
    }
  }
  return v;
}
// 成本少 1 個資源：扣在剩餘缺口最大的那一種（同量取先出現的）
function kgShave(need) {
  const keys = Object.keys(need);
  if (!keys.length) return;
  let r = keys[0];
  for (const x of keys) if (need[x] > need[r]) r = x;
  if (need[r] > 0) need[r]--;
}
// 扣掉折扣與事件後還要付的資源（kind：b 建築／p 人物／w 奇觀）。人物沒有折扣
function kgCost(g, k, card, kind) {
  const sd = g.sd[k], need = { ...card.cost };
  if (kind === "b" || kind === "w") {
    const prod = kgProd(sd);
    for (const r of Object.keys(need)) need[r] = Math.max(0, need[r] - prod[r]);
  }
  if (kind === "b" && card.tier === 1 && kgHas(sd, "t1disc")) kgShave(need);
  if (kgEvent(g) === "rush") kgShave(need);
  return need;
}
// 能付得起就回 { paid, deficit }（缺的用金幣補），否則 null
function kgPay(sd, need) {
  const paid = {};
  let deficit = 0;
  for (const [r, n] of Object.entries(need)) {
    const have = sd.res[r];
    paid[r] = Math.min(n, have);
    deficit += n - paid[r];
  }
  return deficit <= sd.gold ? { paid, deficit } : null;
}
const kgBlocked = (g, cid) => g.sd.some(s => s.block === cid);
function kgRefill(g) {
  for (const tier of [1, 2, 3]) for (let k = 0; k < 4; k++) if (g.mkt[tier][k] === null && g.decks[tier].length) g.mkt[tier][k] = g.decks[tier].pop();
  for (let k = 0; k < 3; k++) if (g.pmkt[k] === null && g.ppl.length) g.pmkt[k] = g.ppl.pop();
}
// 動作做完後的資源（res／gold）超過上限時，要由 drop 指定丟掉哪些（剛好丟到上限）；通過就寫回座位並把丟掉的還給庫存。不通過什麼都不改
function kgSettle(g, sd, res, gold, drop) {
  const over = KG_RES.split("").reduce((a, r) => a + res[r], 0) + gold - kgLimit(sd), dr = {};
  if (over > 0) {
    if (!drop || typeof drop !== "object" || Array.isArray(drop)) return false;
    let tot = 0;
    for (const [key, n] of Object.entries(drop)) {
      if (!Number.isInteger(n) || n < 0) return false;
      if (key === "G") { if (n > gold) return false; }
      else if (KG_RES.includes(key) && key.length === 1) { if (n > res[key]) return false; }
      else return false;
      tot += n; dr[key] = n;
    }
    if (tot !== over) return false;
  }
  for (const [key, n] of Object.entries(dr)) {
    if (key === "G") { gold -= n; g.gold += n; }
    else { res[key] -= n; g.sup[key] += n; }
  }
  sd.res = res; sd.gold = gold;
  return true;
}
const kgIsRes = x => typeof x === "string" && x.length === 1 && KG_RES.includes(x);
function kgTake(t, i, msg) {
  const g = t.g, sd = g.sd[i], ev = kgEvent(g), rs = msg.r;
  if (!Array.isArray(rs) || rs.length < 1 || rs.length > 3 || !rs.every(kgIsRes)) return false;
  const avail = KG_RES.split("").filter(r => g.sup[r] > 0), gain = {};
  if (rs.length === 2 && rs[0] === rs[1]) {   // 同種：庫存要 ≥4；豐收／人物各多拿 1；乾旱不能拿
    const x = rs[0];
    if (ev === "drought" || g.sup[x] < 4) return false;
    gain[x] = Math.min(2 + (ev === "harvest" ? 1 : 0) + (kgHas(sd, "pair") ? 1 : 0), g.sup[x]);
  } else {   // 不同種：拿 min(3, 庫存還有的種類數) 種
    if (new Set(rs).size !== rs.length || rs.length !== Math.min(3, avail.length) || rs.some(x => g.sup[x] <= 0)) return false;
    for (const x of rs) gain[x] = 1;
  }
  const res = { ...sd.res };
  for (const [x, n] of Object.entries(gain)) res[x] += n;
  if (!kgSettle(g, sd, res, sd.gold, msg.drop)) return false;
  for (const [x, n] of Object.entries(gain)) g.sup[x] -= n;
  tblLog(t, `${t.seats[i].name} 拿了 ` + Object.entries(gain).map(([x, n]) => (n > 1 ? `${x}×${n}` : x)).join("、"));
  return true;
}
function kgReserve(t, i, msg) {
  const g = t.g, sd = g.sd[i], tier = msg.tier, idx = msg.i;   // 欄位不能叫 t：net.tbl 送出時是 { t: "tbl", ...m }，會把訊息類型蓋掉
  if (![1, 2, 3].includes(tier) || !Number.isInteger(idx) || idx < -1 || idx > 3 || sd.hand.length >= kgHandLimit(sd)) return false;
  let cid;
  if (idx === -1) {   // 從牌堆頂保留（別人看不到是什麼）
    if (!g.decks[tier].length) return false;
    cid = g.decks[tier][g.decks[tier].length - 1];
  } else {
    cid = g.mkt[tier][idx];
    if (cid === null || kgBlocked(g, cid)) return false;
  }
  const n = Math.min(1 + (kgEvent(g) === "muse" ? 1 : 0) + (kgHas(sd, "gold2") ? 1 : 0), g.gold);
  if (!kgSettle(g, sd, { ...sd.res }, sd.gold + n, msg.drop)) return false;
  g.gold -= n;
  if (idx === -1) g.decks[tier].pop(); else g.mkt[tier][idx] = null;
  sd.hand.push(cid);
  kgRefill(g);
  tblLog(t, `${t.seats[i].name} 保留了一張${idx === -1 ? "牌堆頂的" : ""}${tier} 階牌`);
  return true;
}
function kgBuild(t, i, msg) {
  const g = t.g, sd = g.sd[i], ev = kgEvent(g), s = msg.s, idx = msg.i, tier = msg.tier;
  if (!Number.isInteger(idx) || !["m", "h", "p", "w"].includes(s)) return false;
  let cid;
  if (s === "m") {
    if (![1, 2, 3].includes(tier) || idx < 0 || idx > 3 || g.mkt[tier][idx] === null) return false;
    cid = g.mkt[tier][idx];
    if (kgBlocked(g, cid) && !kgHas(sd, "unblock")) return false;
  } else if (s === "h") {
    if (idx < 0 || idx >= sd.hand.length) return false;
    cid = sd.hand[idx];
  } else if (s === "p") {
    if (idx < 0 || idx >= 3 || g.pmkt[idx] === null) return false;
    cid = g.pmkt[idx];
  } else {
    if (idx < 0 || idx >= g.wond.length || g.wond[idx] === null) return false;
    cid = g.wond[idx];
  }
  const card = kgCard(cid), kind = cid[0];   // b／p／w
  if (kind === "b" && ev === "storm" && "F" in card.cost) return false;
  if (kind === "p" && sd.bld.length < card.need) return false;
  if (kind === "w") {
    const prod = kgProd(sd);
    if (Object.entries(card.req).some(([r, n]) => prod[r] < n)) return false;
  }
  const plan = kgPay(sd, kgCost(g, i, card, kind));
  if (!plan) return false;
  const { paid, deficit } = plan, res = { ...sd.res };
  for (const [r, n] of Object.entries(paid)) res[r] -= n;
  let gold = sd.gold - deficit, extra = 0;
  const fx = kind === "b" ? card.fx : null, gain = {};
  if (fx && fx.k === "gain") {
    gain[fx.res] = Math.min(fx.n, g.sup[fx.res] + (paid[fx.res] || 0));
    res[fx.res] += gain[fx.res];
  }
  if (kind === "p" && ev === "festival" && g.gold + deficit > 0) { extra = 1; gold += 1; }
  if (!kgSettle(g, sd, res, gold, msg.drop)) return false;
  for (const [r, n] of Object.entries(paid)) g.sup[r] += n;
  g.gold += deficit - extra;
  for (const [r, n] of Object.entries(gain)) g.sup[r] -= n;
  // 取走牌
  if (s === "m") {
    g.mkt[tier][idx] = null;
    for (const o of g.sd) if (o.block === cid) o.block = null;
  } else if (s === "h") sd.hand.splice(idx, 1);
  else if (s === "p") g.pmkt[idx] = null;
  else g.wond[idx] = null;
  kgRefill(g);
  sd[{ b: "bld", p: "ppl", w: "won" }[kind]].push(cid);
  if (kind === "b" && ev === "bounty" && !sd.firstbld) { sd.firstbld = true; sd.bonus++; }
  tblLog(t, `${t.seats[i].name} ${kind === "p" ? "招募了" : "建成了"}${card.name}`);
  kgCheckObj(t, i);
  return true;
}
function kgObjOk(g, k, key) {
  const sd = g.sd[k], prod = kgProd(sd), tiers = sd.bld.map(c => kgCard(c).tier), cnt = n => tiers.filter(x => x === n).length;
  switch (key) {
    case "types3x2": return KG_RES.split("").filter(r => prod[r] >= 2).length >= 3;
    case "build9": return sd.bld.length >= 9;
    case "people3": return sd.ppl.length >= 3;
    case "wonder1": return sd.won.length >= 1;
    case "t3x2": return cnt(3) >= 2;
    case "t1x6": return cnt(1) >= 6;
    case "prod5": return Math.max(...Object.values(prod)) >= 5;
    case "all4x7": return KG_RES.split("").every(r => prod[r] >= 1) && sd.bld.length >= 7;
    case "t2t3x2": return cnt(2) >= 2 && cnt(3) >= 2;
    case "p2w1": return sd.ppl.length >= 2 && sd.won.length >= 1;
    default: return false;
  }
}
function kgCheckObj(t, i) {
  const g = t.g;
  for (const o of g.obj) {
    if (o.by === null && kgObjOk(g, i, o.k)) {
      o.by = i; g.sd[i].bonus += 3;
      tblLog(t, `${t.seats[i].name} 達成共同目標「${o.name}」+3 分`);
    }
  }
}
function kgTrade(t, i, msg) {
  const g = t.g, sd = g.sd[i], ev = kgEvent(g), give = msg.give, get = msg.get;
  if (!kgIsRes(give) || !kgIsRes(get) || give === get || sd.traded || ev === "notrade") return false;
  const rate = ev === "tradewind" || kgHas(sd, "trade") ? 2 : 3;
  if (sd.res[give] < rate || g.sup[get] < 1) return false;
  sd.res[give] -= rate; sd.res[get] += 1; g.sup[give] += rate; g.sup[get] -= 1;
  sd.traded = true;
  tblLog(t, `${t.seats[i].name} 用 ${give}×${rate} 換了 1 個 ${get}`);
  return true;
}
function kgBlock(t, i, msg) {
  const g = t.g, sd = g.sd[i], tier = msg.tier, idx = msg.i, pay = msg.pay;
  if (![1, 2, 3].includes(tier) || !Number.isInteger(idx) || idx < 0 || idx > 3 || sd.blkUsed) return false;
  const cid = g.mkt[tier][idx];
  if (cid === null || kgBlocked(g, cid)) return false;
  if (kgEvent(g) !== "marketday") {
    if (!kgIsRes(pay) || sd.res[pay] < 1) return false;
    sd.res[pay]--; g.sup[pay]++;
  }
  sd.block = cid; sd.blkUsed = true;
  tblLog(t, `${t.seats[i].name} 封鎖了一張 ${tier} 階牌`);
  return true;
}
function kgStart(t) {
  const n = t.seats.length, now = Date.now(), raw = KG.raw;
  const decks = {};
  for (const tier of [1, 2, 3]) decks[tier] = shuffle(raw.buildings.filter(c => c.tier === tier).map(c => c.id));
  const people = shuffle(raw.people.map(c => c.id)), wonders = shuffle(raw.wonders.map(c => c.id)), evdeck = shuffle([...raw.eventDeck]);
  const objs = shuffle([...raw.objectives]).slice(0, 3), start = Math.floor(Math.random() * n);
  const g = { sup: { W: KG_SUP[n], S: KG_SUP[n], F: KG_SUP[n], I: KG_SUP[n] }, gold: 5, decks, mkt: { 1: [null, null, null, null], 2: [null, null, null, null], 3: [null, null, null, null] }, ppl: people, pmkt: [null, null, null],
    wond: wonders.slice(0, 4), evdeck, round: 1, endr: null, passes: 0, start, deadline: now + KG_TURN_MS,
    obj: objs.map(o => ({ id: o.id, name: o.name, text: o.text, k: o.k, by: null })), sd: t.seats.map(() => kgNewSd()) };
  kgRefill(g);
  t.g = g; t.result = null; t.phase = "playing"; t.turn = start;
  for (const s of t.seats) { s.ready = false; s.left = false; }
  tblLog(t, `列島建國開始！${n} 人參加，${t.seats[start].name} 先手`);
}
// 一輪結束（輪回先手）：結算事件的輪末效果；有人到 25 分的那一輪結束就結束遊戲
function kgRoundEnd(t) {
  const g = t.g, ev = kgEvent(g), live = g.sd.map((s, k) => (s.done ? -1 : k)).filter(k => k >= 0);
  const dropOne = sd => {
    let r = KG_RES[0];
    for (const x of KG_RES) if (sd.res[x] > sd.res[r]) r = x;
    if (sd.res[r] > 0) { sd.res[r]--; g.sup[r]++; }
    else if (sd.gold > 0) { sd.gold--; g.gold++; }
  };
  if (ev === "tax") {
    for (const k of live) while (kgTotal(g.sd[k]) > 7) dropOne(g.sd[k]);
    tblLog(t, "稅收：資源超過 7 張的人丟到 7 張");
  } else if (ev === "pirates" && live.length) {
    const top = Math.max(...live.map(k => kgTotal(g.sd[k])));
    if (top > 0) {
      for (const k of live) if (kgTotal(g.sd[k]) === top) { dropOne(g.sd[k]); dropOne(g.sd[k]); }
      tblLog(t, "海盜來襲：資源最多的人丟了 2 張");
    }
  }
  for (const s of g.sd) s.firstbld = false;
  if (g.endr !== null) { kgFinish(t); return; }
  g.round++;
}
function kgAdvance(t, from, now) {
  const g = t.g, n = t.seats.length, active = g.sd.filter(s => !s.done).length;
  if (active < 2 || g.passes >= active) { kgFinish(t); return; }
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n, sd = g.sd[j];
    if (sd.done) continue;
    if (((j - g.start) % n + n) % n <= ((from - g.start) % n + n) % n) {   // 輪回先手＝一輪結束
      kgRoundEnd(t);
      if (t.phase !== "playing") return;
    }
    t.turn = j; g.deadline = now + KG_TURN_MS;
    sd.block = null; sd.traded = false; sd.blkUsed = false;
    return;
  }
  kgFinish(t);
}
function kgEndTurn(t, i, now) {
  const g = t.g;
  g.sd[i].idle = 0;
  if (kgVp(g, i) >= KG_WIN_VP && g.endr === null) { g.endr = g.round; tblLog(t, `${t.seats[i].name} 達到 ${KG_WIN_VP} 分！這一輪結束後比分`); }
  kgAdvance(t, i, now);
}
// 回 true＝動作成立（狀態有變）。主要動作（拿／保留／建造／跳過）做完換下一位；交易與封鎖不換人
function kgAct(t, cid, msg, now) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "kingdom" || role !== "seat" || t.phase !== "playing" || i !== t.turn || !g || g.sd[i].done) return false;
  const a = msg.a;
  if (a === "kx") return kgTrade(t, i, msg);
  if (a === "kk") return kgBlock(t, i, msg);
  if (a === "kp") { g.passes++; tblLog(t, `${t.seats[i].name} 跳過`); }
  else if ((a === "kt" && kgTake(t, i, msg)) || (a === "kr" && kgReserve(t, i, msg)) || (a === "kb" && kgBuild(t, i, msg))) g.passes = 0;
  else return false;
  kgEndTurn(t, i, now);
  return true;
}
// 回合限時到了：自動拿資源（拿不了就跳過）；連續超時 KG_IDLE_MAX 次視為棄權
function kgTimeout(t, now) {
  const g = t.g;
  if (t.game !== "kingdom" || t.phase !== "playing" || !g || now < g.deadline - 300) return;
  const i = t.turn, sd = g.sd[i];
  sd.idle++;
  if (sd.idle >= KG_IDLE_MAX) { sd.done = true; sd.forfeit = true; tblLog(t, `${t.seats[i].name} 連續超時，視為棄權`); kgAdvance(t, i, now); return; }
  tblLog(t, `${t.seats[i].name} 超時`);
  const avail = shuffle(KG_RES.split("").filter(r => g.sup[r] > 0)), idle = sd.idle;
  if (!kgTake(t, i, { a: "kt", r: avail.slice(0, Math.min(3, avail.length)) })) g.passes++; else g.passes = 0;
  kgEndTurn(t, i, now);
  g.sd[i].idle = idle;   // 超時自動動作不重置連續超時計數
}
// 進行中有人離開：離開者視同棄權，其餘人繼續；剩不到 2 人就結束
function kgLeave(t, i, now) {
  const s = t.seats[i], g = t.g;
  if (s.left) return;
  s.left = true; s.cid = null; g.sd[i].done = true;
  tblLog(t, `${s.name} 離開了`);
  if (g.sd.filter(d => !d.done).length < 2) kgFinish(t);
  else if (i === t.turn) kgAdvance(t, i, now);
}
function kgFinish(t) {
  const g = t.g, n = t.seats.length;
  const players = t.seats.map((s, k) => ({ name: s.name, vp: kgVp(g, k), bld: g.sd[k].bld.length, ppl: g.sd[k].ppl.length, won: g.sd[k].won.length, res: kgTotal(g.sd[k]), left: !!s.left, forfeit: !!g.sd[k].forfeit }));
  const elig = []; for (let k = 0; k < n; k++) if (!players[k].left && !players[k].forfeit) elig.push(k);
  const key = k => [players[k].vp, -players[k].bld, players[k].res], cmp = (a, b) => { const x = key(a), y = key(b); for (let q = 0; q < 3; q++) if (x[q] !== y[q]) return x[q] - y[q]; return 0; };
  let winners = [];
  if (elig.length) { let best = elig[0]; for (const k of elig) if (cmp(k, best) > 0) best = k; winners = elig.filter(k => cmp(k, best) === 0); }
  const stay = []; t.seats.forEach((s, k) => { if (!s.left) stay.push([k, s]); });
  const xp = stay.map(([k]) => (elig.length >= 2 && !players[k].forfeit ? KG_XP : 0));
  const gs = stay.map(([k]) => (elig.length >= 2 && !players[k].forfeit ? gsMk({ ...(winners.includes(k) ? { w: 1 } : {}), ...(players[k].won ? { wond: 1 } : {}) }, { vp: players[k].vp }) : null));
  const names = winners.map(k => players[k].name).join("、");
  const text = winners.length ? (winners.length > 1 ? `${names} 同分平手（${players[winners[0]].vp} 分）` : `${names} 獲勝！（${players[winners[0]].vp} 分）`) : "沒有人達成勝利條件";
  t.seats = stay.map(([, s]) => s);
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), xp, players, winners, draw: winners.length > 1, gs };
  tblLog(t, text);
  tblResetSeats(t);
  t.g = g;   // 最後的盤面留著給大家看，到下一局開始才清掉
}
function kgView(t, cid, v) {
  const g = t.g, [role, i] = tblFind(t, cid), playing = t.phase === "playing";
  const sd = g.sd.map((s, k) => ({ res: { ...s.res }, gold: s.gold, bld: [...s.bld], ppl: [...s.ppl], won: [...s.won], nhand: s.hand.length, block: s.block, traded: s.traded, blk: s.blkUsed, bonus: s.bonus, vp: kgVp(g, k), done: s.done, forfeit: s.forfeit, idle: s.idle }));
  const mkt = {}, deck = {};
  for (const k of [1, 2, 3]) { mkt[k] = [...g.mkt[k]]; deck[k] = g.decks[k].length; }
  v.kg = { sup: { ...g.sup }, gold: g.gold, mkt, deck, pmkt: [...g.pmkt], pdeck: g.ppl.length, wond: [...g.wond], ev: kgEvent(g), next: kgEvent(g, 1), round: g.round, endr: g.endr, start: g.start,
    obj: g.obj.map(o => ({ id: o.id, name: o.name, text: o.text, by: o.by })), sd, hand: role === "seat" && i < g.sd.length ? [...g.sd[i].hand] : [], deadline: playing ? g.deadline : 0, sn: Date.now() };
  if (playing) t.seats.forEach((s, k) => { v.seats[k].left = !!s.left; });
}
// ---- 大老二（第十八桌 t18；2026-11-14，使用者要求）：2～4 人、單局、先出完手牌者獲勝（規則與 tools/dev_server.py 的 bt_* 是同一套，逐行對照）----
// 牌：花色 S♠ H♥ D♦ C♣（大小 ♠ > ♥ > ♦ > ♣），點數 3 最小…K、A，2 最大（'S1'＝A、'S2'＝2，同 UNO／抽鬼牌的牌面編碼）。
// 牌型只有 單張／對子／五張（順子 < 同花 < 葫蘆 < 鐵支帶一張 < 同花順）；順子只能 3～A 之間連續（2 不能入順，不繞圈）。
// 同一輪要出同樣張數的牌且比上一手大；可以隨時 pass（不鎖定自己），其他人都 pass 後最後出牌的人重新領出。
// 開局：持有最小牌的人先出且這一手必須含那張（4 人＝梅花 3）；3 人每人 17 張，2／4 人每人 13 張。
const BT_TURN_MS = 45000, BT_IDLE_MAX = 2, BT_XP = 5;
const BT_SUIT = { C: 0, D: 1, H: 2, S: 3 }, BT_SYM = { S: "♠", H: "♥", D: "♦", C: "♣" }, BT_RK = { 1: "A", 11: "J", 12: "Q", 13: "K" };
const btVal = c => { const r = Number(c.slice(1)); return r === 1 ? 14 : r === 2 ? 15 : r; };
const btKey = c => [btVal(c), BT_SUIT[c[0]]];
const btCmpKey = (a, b) => a[0] - b[0] || a[1] - b[1];
const btCmpCard = (a, b) => btCmpKey(btKey(a), btKey(b));
function btCombo(cs) {   // 牌型 → [張數, 五張牌型階級 0～5, [點數, 花色]]；不成牌型回 null
  const n = cs.length;
  if (![1, 2, 5].includes(n) || new Set(cs).size !== n) return null;
  const ks = cs.map(btKey).sort(btCmpKey);
  if (n === 1) return [1, 0, ks[0]];
  if (n === 2) return ks[0][0] === ks[1][0] ? [2, 0, ks[1]] : null;
  const vals = ks.map(k => k[0]), cnt = {};
  for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
  const flush = new Set(ks.map(k => k[1])).size === 1;
  const straight = Object.keys(cnt).length === 5 && vals[4] - vals[0] === 4 && vals[4] <= 14;
  const shape = Object.values(cnt).sort((a, b) => a - b).join(",");
  const of = c => Number(Object.keys(cnt).find(v => cnt[v] === c));
  if (straight && flush) return [5, 5, ks[4]];
  if (shape === "1,4") return [5, 4, [of(4), 0]];
  if (shape === "2,3") return [5, 3, [of(3), 0]];
  if (flush) return [5, 2, ks[4]];
  if (straight) return [5, 1, ks[4]];
  return null;
}
const btBeats = (nw, last) => nw[0] === last[0] && (nw[1] - last[1] || btCmpKey(nw[2], last[2])) > 0;
const btActive = t => { const out = []; t.seats.forEach((s, k) => { if (!s.left && !s.forfeit) out.push(k); }); return out; };
function btSetTurn(t, i, now) { t.turn = i; t.g.deadline = now + BT_TURN_MS; }
function btStart(t) {
  const now = Date.now(), n = t.seats.length;
  const deck = [];
  for (const s of "SHDC") for (let r = 1; r <= 13; r++) deck.push(`${s}${r}`);
  shuffle(deck);
  const per = n === 3 ? 17 : 13;
  t.seats.forEach((s, k) => { s.hand = deck.slice(k * per, (k + 1) * per).sort(btCmpCard); s.out = false; s.ready = false; s.left = false; s.forfeit = false; s.idle = 0; });
  let start = null, first = 0;
  t.seats.forEach((s, k) => { for (const c of s.hand) if (start === null || btCmpCard(c, start) < 0) { start = c; first = k; } });
  t.g = { last: null, passes: 0, first: true, start, deadline: 0 };
  t.result = null; t.phase = "playing";
  btSetTurn(t, first, now);
  tblLog(t, `牌局開始！每人 ${per} 張，由 ${t.seats[first].name} 先出（要含最小的牌）`);
}
const btLabel = cs => [...cs].sort(btCmpCard).map(c => BT_SYM[c[0]] + (BT_RK[Number(c.slice(1))] || Number(c.slice(1)))).join(" ");
function btSettle(t) {   // 其他人都 pass 了：這一手結束（最後出牌的人還在場就是他重新領出；不在了就由下一位活著的人領出）
  const g = t.g;
  if (!g.last) return;
  const act = btActive(t), need = act.length - (act.includes(g.last.seat) ? 1 : 0);
  if (g.passes >= need) { g.last = null; g.passes = 0; }
}
function btAdvance(t, i, now) {
  btSettle(t);
  const n = t.seats.length, act = btActive(t);
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (act.includes(j)) { btSetTurn(t, j, now); return; } }
}
function btFinish(t, winner, xp) {
  const stay = t.seats.filter(s => !s.left), win = t.seats[winner];
  const players = t.seats.map(s => ({ name: s.name, n: s.hand.length, left: !!s.left, forfeit: !!s.forfeit }));
  t.result = { winner, name: win.name, text: `${win.name} 出完手牌，獲勝！`, rid: Math.floor(Math.random() * 4294967296),
               xp: stay.map(s => (xp && !s.forfeit ? BT_XP : 0)), players, gs: stay.map(s => (xp && !s.forfeit ? gsMk(s === win ? { w: 1 } : {}) : null)) };
  tblLog(t, t.result.text);
  t.seats = stay;
  tblResetSeats(t);
  t.g = null;
}
function btCheckLast(t) {   // 剩不到 2 位玩家：剩的那位獲勝（無 XP）；一個人都不剩就清桌
  const act = btActive(t);
  if (t.phase !== "playing" || act.length > 1) return false;
  if (act.length) btFinish(t, act[0], false);
  else { t.seats = []; tblResetSeats(t); t.g = null; }
  return true;
}
function btPlay(t, cid, cs, now, keepIdle) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "bigtwo" || role !== "seat" || t.phase !== "playing" || !g || i !== t.turn) return false;
  return btDoPlay(t, i, cs, now, keepIdle);
}
function btDoPlay(t, i, cs, now, keepIdle) {
  const g = t.g, s = t.seats[i];
  if (!Array.isArray(cs) || cs.length < 1 || cs.length > 5 || !cs.every(c => typeof c === "string" && s.hand.includes(c))) return false;
  const cb = btCombo(cs);
  if (!cb || (g.last && !btBeats(cb, g.last.cb)) || (g.first && !cs.includes(g.start))) return false;
  for (const c of cs) s.hand.splice(s.hand.indexOf(c), 1);
  g.last = { seat: i, cs: [...cs].sort(btCmpCard), cb }; g.passes = 0; g.first = false;
  if (!keepIdle) s.idle = 0;
  tblLog(t, `${s.name} 出 ${btLabel(cs)}`);
  if (!s.hand.length) { btFinish(t, i, true); return true; }
  btAdvance(t, i, now);
  return true;
}
function btPass(t, cid, now, keepIdle) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "bigtwo" || role !== "seat" || t.phase !== "playing" || !g || i !== t.turn || !g.last) return false;
  g.passes++;
  if (!keepIdle) t.seats[i].idle = 0;
  tblLog(t, `${t.seats[i].name} pass`);
  btAdvance(t, i, now);
  return true;
}
function btTimeout(t, now) {   // 回合限時到了：能 pass 就 pass，要領出就出最小的一張（開局那手就出開局牌）；連續超時 BT_IDLE_MAX 次視為棄權
  const g = t.g;
  if (t.game !== "bigtwo" || t.phase !== "playing" || !g || now < g.deadline - 300) return;
  const i = t.turn, s = t.seats[i];
  s.idle++;
  if (s.idle >= BT_IDLE_MAX) {
    s.forfeit = true; s.hand = [];
    tblLog(t, `${s.name} 連續超時，視為棄權`);
    if (!btCheckLast(t)) btAdvance(t, i, now);
    return;
  }
  tblLog(t, `${s.name} 超時`);
  if (g.last) btPass(t, s.cid, now, true);
  else btDoPlay(t, i, [g.first ? g.start : s.hand[0]], now, true);
}
function btLeave(t, i, now) {   // 遊戲進行中有人離開：手牌作廢、其餘人繼續；剩不到 2 人時那位獲勝（無 XP）
  const s = t.seats[i];
  s.left = true; s.cid = null; s.hand = [];
  tblLog(t, `${s.name} 離開了`);
  if (btCheckLast(t)) return;
  if (i === t.turn) btAdvance(t, i, now);
}
function btView(t, cid, v) {
  const g = t.g, playing = t.phase === "playing", [role, i] = tblFind(t, cid);
  if (!(g && playing)) return;
  v.bt = { last: g.last ? { seat: g.last.seat, cs: [...g.last.cs] } : null, passes: g.passes, first: g.first, start: g.start, deadline: g.deadline, sn: Date.now() };
  t.seats.forEach((s, k) => { v.seats[k].left = !!s.left; v.seats[k].fo = !!s.forfeit; });
  v.canPass = role === "seat" && i === t.turn && !!g.last;
}
const BT_MSGS = new Set(["bplay", "bpass"]);
// ---- Blokus Trigon（第十二桌 t12；2026-11-13，使用者要求）：2～4 人、正六邊形的三角格棋盤（邊長 9，共 486 格）、每人 22 塊（1～6 個三角形，共 110 格）----
// 規則同Blokus：第一塊要蓋住自己的角落（這裡是「棋盤六個頂點之一」：塊上有一格以那個頂點為角）；之後每塊要「點對點」接到自己的舊方塊（共用至少一個頂點），且不能「邊對邊」（共用一條邊）；
// 放不下的人自動跳過、全員放不下就結束；計分＝−剩下的格數，全部放完 +15、最後一塊是單格再 +5；每手限時 TG_TURN_MS，連續超時 TG_IDLE_MAX 次視為棄權；沒有排行榜。與 tools/dev_server.py 的 tg_* 同一套。
// 座標：三角形 (x, y)（y＝第幾列，由上往下；x＝水平位置，每個三角形寬 2 個單位）；(x + y) 為偶數＝尖端朝上、奇數＝尖端朝下。頂點是格點 (i, j)（i + j 為偶數）：
// 朝上 (x, y) 的頂點＝(x, y)、(x−1, y+1)、(x+1, y+1)；朝下 (x, y) 的頂點＝(x−1, y)、(x+1, y)、(x, y+1)。邊鄰居＝(x±1, y)，再加朝上的 (x, y+1)／朝下的 (x, y−1)。
// 方向轉換用軸座標 (a, b) ＝ ((i − j) / 2, j)：轉 60 度 (a, b) → (−b, a + b)，左右翻面 (a, b) → (−a − b, b)。
const TG_N = 9, TG_CX = 19, TG_W = 39, TG_ROWS = 18, TG_VW = 41, TG_TURN_MS = 45000, TG_IDLE_MAX = 2, TG_XP = 6, TG_TOTAL = 110;
const TG_PIECES = [[[0,0]],[[0,0],[0,1]],[[0,0],[-1,1],[0,1]],[[0,0],[-1,1],[0,1],[-1,2]],[[0,0],[-1,1],[0,1],[1,1]],[[0,0],[-2,1],[-1,1],[0,1]],[[0,0],[-1,1],[0,1],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2]],[[0,0],[1,0],[0,1],[1,1],[2,1]],[[0,0],[-1,1],[0,1],[-1,2],[0,2],[0,3]],[[0,0],[-1,1],[0,1],[-1,2],[0,2],[1,2]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2],[-2,3]],[[0,0],[-1,1],[0,1],[-2,2],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[-3,2],[-2,2],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2],[0,2]],[[0,0],[-1,1],[0,1],[1,1],[-1,2],[1,2]],[[0,0],[-1,1],[0,1],[1,1],[2,1],[-1,2]],[[0,0],[-1,1],[0,1],[1,1],[2,1],[1,2]],[[0,0],[-2,1],[-1,1],[0,1],[-2,2],[-1,2]],[[0,0],[-3,1],[-2,1],[-1,1],[0,1],[-3,2]],[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]]];   // 22 塊 polyiamond（1／1／1／3／4／12 種，三角形的 [x, y]，已正規化；與客戶端、dev_server 同一份）
function tgVerts(x, y) { return ((x + y) & 1) === 0 ? [[x, y], [x - 1, y + 1], [x + 1, y + 1]] : [[x - 1, y], [x + 1, y], [x, y + 1]]; }
function tgFromVerts(vs) {
  const jm = Math.min(...vs.map(v => v[1])), top = vs.filter(v => v[1] === jm);
  return top.length === 2 ? [vs.find(v => v[1] !== jm)[0], jm] : [top[0][0], jm];
}
function tgXform(c, rot, flip) {
  return tgFromVerts(tgVerts(c[0], c[1]).map(([i, j]) => {
    let a = (i - j) / 2, b = j;
    for (let r = 0; r < rot; r++) [a, b] = [-b, a + b];
    if (flip) [a, b] = [-a - b, b];
    return [2 * a + b, b];
  }));
}
function tgNorm(cells) {   // 平移到最上一列最左的格在 (p, 0)（p＝它的方向：0 朝上、1 朝下；平移必須保持方向，所以 dx + dy 要是偶數）
  const y0 = Math.min(...cells.map(c => c[1])), x0 = Math.min(...cells.filter(c => c[1] === y0).map(c => c[0]));
  const p = (((x0 + y0) % 2) + 2) % 2, dx = -x0 + p, dy = -y0;
  return cells.map(c => [c[0] + dx, c[1] + dy]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
const tgKey = cells => tgNorm(cells).map(c => c.join(",")).join(";");
const TG_ORI = TG_PIECES.map(cells => {   // 每塊的所有不重複方向（轉 6 × 翻面 2）
  const seen = new Map();
  for (let f = 0; f < 2; f++) for (let r = 0; r < 6; r++) { const n = tgNorm(cells.map(c => tgXform(c, r, f))); seen.set(tgKey(n), n); }
  return [...seen.values()];
});
const TG_ORI_KEYS = TG_ORI.map(os => new Set(os.map(tgKey)));
// 棋盤：正六邊形（邊長 N），頂點 (i, j)：0 ≤ j ≤ 2N，左右邊界如下；三角形的三個頂點都在內才算格子
const tgLeft = j => (j <= TG_N ? TG_CX - TG_N - j : TG_CX - 3 * TG_N + j), tgRight = j => (j <= TG_N ? TG_CX + TG_N + j : TG_CX + 3 * TG_N - j);
const tgInV = (i, j) => j >= 0 && j <= 2 * TG_N && i >= tgLeft(j) && i <= tgRight(j);
const TG_CORNERS = [[TG_CX - TG_N, 0], [TG_CX + TG_N, 0], [TG_CX + 2 * TG_N, TG_N], [TG_CX + TG_N, 2 * TG_N], [TG_CX - TG_N, 2 * TG_N], [TG_CX - 2 * TG_N, TG_N]];   // 六個頂點（左上起順時針）
const TG_SLOTS = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4] };   // 各人數用哪幾個頂點（2 人對角、3 人隔一個、4 人兩兩對稱）
const TG_VALID = new Uint8Array(TG_W * TG_ROWS), TG_EDGE = [], TG_CELLV = [], TG_AROUND = new Map();
for (let y = 0; y < TG_ROWS; y++) for (let x = 0; x < TG_W; x++) if (tgVerts(x, y).every(([i, j]) => tgInV(i, j))) TG_VALID[y * TG_W + x] = 1;
for (let y = 0; y < TG_ROWS; y++) for (let x = 0; x < TG_W; x++) {
  const c = y * TG_W + x;
  if (!TG_VALID[c]) continue;
  TG_EDGE[c] = [[x - 1, y], [x + 1, y], [x, ((x + y) & 1) === 0 ? y + 1 : y - 1]].filter(([a, b]) => a >= 0 && a < TG_W && b >= 0 && b < TG_ROWS && TG_VALID[b * TG_W + a]).map(([a, b]) => b * TG_W + a);
  TG_CELLV[c] = tgVerts(x, y).map(([i, j]) => j * TG_VW + i);
  for (const v of TG_CELLV[c]) { if (!TG_AROUND.has(v)) TG_AROUND.set(v, []); TG_AROUND.get(v).push(c); }
}
const tgVid = ([i, j]) => j * TG_VW + i;
// 座位 k 放這些格子（格子編號 y * TG_W + x）合不合法
function tgLegal(g, k, cells) {
  const col = g.col[k] + 1, corner = tgVid(TG_CORNERS[g.corner[k]]), first = g.sd[k].placed === 0, b = g.board;
  let touch = false, start = false;
  for (const c of cells) {
    if (!TG_VALID[c] || b[c]) return false;
    for (const e of TG_EDGE[c]) if (b[e] === col) return false;
    for (const v of TG_CELLV[c]) {
      if (v === corner) start = true;
      if (!touch) for (const t of TG_AROUND.get(v)) if (t !== c && b[t] === col) { touch = true; break; }
    }
  }
  return first ? start : touch;
}
// 座位 k 所有合法放法 [{p, key, cells}]（依 key 排序，測試用）；one＝true 時找到一個就回
function tgMoves(g, k, one) {
  const col = g.col[k] + 1, sd = g.sd[k], b = g.board, out = [], seen = new Set(), anchors = [], mark = new Set();
  if (sd.placed === 0) for (const t of TG_AROUND.get(tgVid(TG_CORNERS[g.corner[k]]))) { if (!b[t]) anchors.push(t); }
  else for (let c = 0; c < b.length; c++) {
    if (b[c] !== col) continue;
    for (const v of TG_CELLV[c]) for (const t of TG_AROUND.get(v)) {
      if (b[t] || mark.has(t) || TG_EDGE[t].some(e => b[e] === col)) continue;
      mark.add(t); anchors.push(t);
    }
  }
  anchors.sort((a, c) => a - c);
  for (let p = 0; p < TG_PIECES.length; p++) {
    if (sd.used.includes(p)) continue;
    for (const o of TG_ORI[p]) for (const [ox, oy] of o) for (const a of anchors) {
      const ax = a % TG_W, ay = Math.floor(a / TG_W);
      if ((((ox + oy) ^ (ax + ay)) & 1) !== 0) continue;   // 方向（朝上／朝下）要一樣，平移才合法
      const dx = ax - ox, dy = ay - oy, cells = [];
      let okb = true;
      for (const [x, y] of o) { const X = x + dx, Y = y + dy; if (X < 0 || X >= TG_W || Y < 0 || Y >= TG_ROWS) { okb = false; break; } cells.push(Y * TG_W + X); }
      if (!okb || !tgLegal(g, k, cells)) continue;
      cells.sort((q, r) => q - r);
      const key = p + ":" + cells.join(",");
      if (seen.has(key)) continue;
      seen.add(key); out.push({ p, key, cells });
      if (one) return out;
    }
  }
  return out.sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0));
}
const tgRem = (g, k) => TG_TOTAL - g.sd[k].used.reduce((a, p) => a + TG_PIECES[p].length, 0);
const tgScore = (g, k) => { const r = tgRem(g, k); return -r + (r === 0 ? 15 + (g.sd[k].mono ? 5 : 0) : 0); };
function tgStart(t) {
  const n = t.seats.length, now = Date.now(), cols = shuffle([0, 1, 2, 3].slice(0, n));   // 顏色隨機分配；顏色 c 固定用第 c 個頂點（TG_SLOTS）
  t.g = { board: new Array(TG_W * TG_ROWS).fill(0), col: cols, corner: cols.map(c => TG_SLOTS[n][c]), sd: cols.map(() => ({ used: [], placed: 0, done: false, idle: 0, forfeit: false, mono: false })), last: null, moves: 0, deadline: now + TG_TURN_MS };
  t.result = null; t.phase = "playing"; t.turn = cols.indexOf(0);   // 藍色先下
  for (const s of t.seats) { s.ready = false; s.left = false; }
  tblLog(t, `Blokus Trigon 開始！${n} 人參加，${t.seats[t.turn].name}（藍）先下`);
}
function tgAdvance(t, from, now) {
  const g = t.g, n = t.seats.length;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n, sd = g.sd[j];
    if (sd.done) continue;
    if (!tgMoves(g, j, true).length) { sd.done = true; tblLog(t, `${t.seats[j].name} 沒有地方可以放了，之後跳過`); continue; }
    t.turn = j; g.deadline = now + TG_TURN_MS; return;
  }
  tgFinish(t);
}
function tgFinish(t) {
  const g = t.g;
  const players = t.seats.map((s, k) => ({ name: s.name, col: g.col[k], rem: tgRem(g, k), score: tgScore(g, k), left: !!s.left, forfeit: !!g.sd[k].forfeit }));
  const best = Math.max(...players.map(p => p.score)), winners = players.map((p, k) => (p.score === best ? k : -1)).filter(k => k >= 0);
  const stay = t.seats.filter(s => !s.left), active = t.seats.filter((s, k) => !s.left && !g.sd[k].forfeit).length;
  const xp = stay.map(s => (active >= 2 && !g.sd[t.seats.indexOf(s)].forfeit ? TG_XP : 0));
  const names = winners.map(k => players[k].name).join("、");
  const text = winners.length > 1 ? `${names} 同分平手（${best} 分）` : `${names} 獲勝！（${best} 分）`;
  const gs = stay.map(s => { const k = t.seats.indexOf(s), p = players[k]; return active >= 2 && !p.forfeit ? gsMk({ ...(winners.includes(k) ? { w: 1 } : {}), ...(p.rem === 0 ? { all: 1 } : {}) }) : null; });
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), xp, players, winners, draw: winners.length > 1, gs };
  tblLog(t, text);
  tblResetSeats(t);
  t.g = g;   // 最後的棋盤留著給大家看，到下一局開始才清掉
}
function tgPlace(t, cid, p, cs, now) {   // cs：這塊佔用的格子的絕對座標 [[x, y], …]
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "trigon" || role !== "seat" || t.phase !== "playing" || i !== t.turn || !g) return;
  if (!Number.isInteger(p) || p < 0 || p >= TG_PIECES.length || g.sd[i].used.includes(p) || !Array.isArray(cs) || cs.length !== TG_PIECES[p].length) return;
  const cells = [], idx = [];
  for (const c of cs) {
    if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) || c[0] < 0 || c[0] >= TG_W || c[1] < 0 || c[1] >= TG_ROWS) return;
    cells.push([c[0], c[1]]); idx.push(c[1] * TG_W + c[0]);
  }
  if (!TG_ORI_KEYS[p].has(tgKey(cells)) || !tgLegal(g, i, idx)) return;
  const sd = g.sd[i];
  for (const c of idx) g.board[c] = g.col[i] + 1;
  sd.used.push(p); sd.placed++; sd.idle = 0; sd.mono = p === 0;
  g.last = { seat: i, cells }; g.moves++;
  tgAdvance(t, i, now);
}
function tgTimeout(t, now) {
  const g = t.g;
  if (t.game !== "trigon" || t.phase !== "playing" || !g || now < g.deadline - 300) return;
  const i = t.turn, sd = g.sd[i];
  sd.idle++;
  if (sd.idle >= TG_IDLE_MAX) { sd.done = true; sd.forfeit = true; tblLog(t, `${t.seats[i].name} 連續超時，視為棄權`); }
  else tblLog(t, `${t.seats[i].name} 超時，跳過這一手`);
  tgAdvance(t, i, now);
}
function tgLeave(t, i, now) {   // 遊戲進行中有人離開：棋子留在棋盤上、之後跳過；沒人能下就結束
  const s = t.seats[i], g = t.g;
  if (s.left) return;
  s.left = true; s.cid = null; g.sd[i].done = true;
  tblLog(t, `${s.name} 離開了`);
  if (i === t.turn) tgAdvance(t, i, now);
  else if (g.sd.every(d => d.done)) tgFinish(t);
}
// ---- 躲彈幕（第五桌 t5；2026-11-08，使用者要求）：1～8 人、每人 3 條命、只能躲不能攻擊，依存活秒數評分 ----
// 彈幕由客戶端用伺服器給的 seed 與開始時間 t0 決定性地各自產生（每個畫面看到的彈幕一樣）；被打到由各客戶端自判並回報 hit（和島主的招式同一原則，信任客戶端），
// 伺服器管命數（被打後 DG_INV_MS 內不重複扣）、淘汰、評分與結束：入座的人全部淘汰、或滿 DG_DUR 秒（客戶端時間到時送 finish，伺服器核對時鐘）就結束；
// 中途離開的人視同在離開那一刻淘汰（照該刻的存活秒數計分），遊戲繼續到場上沒有活人為止。與 tools/dev_server.py 的 dg_* 同一套。
const DG_DUR = 300;          // 最長秒數（使用者定，「暫時」；到了強制結束）
const DG_LIVES = 3;
const DG_INV_MS = 1500;      // 被打到後的無敵時間（與客戶端一致）
const DG_COUNTDOWN_MS = 3000;
const DG_W = 640, DG_H = 400;   // 場地大小（客戶端畫面用；伺服器只用來夾位置）
// 道具（2026-11-12，使用者要求）：分數＝存活秒數×1＋道具分。道具的位置、出現時間、種類由 seed 與編號 n 決定性地算出（客戶端畫面用同一個函式，
// 與 dev_server 的 dg_item／client 的 dodgeItem 同一套）：伺服器只在收到 pick {n} 時驗證（時間、距離、沒被別人先吃）並結算。
// 金幣 +10 分／愛心 +1 命（滿命改 +5 分）／骷髏 領先的對手 −10 分／蝸牛 其他人減速 5 秒／準星 6 秒內場上多出「只會打到別人」的子彈；單人局只有金幣與愛心
const DG_ITEM_LIFE = 9, DG_ITEM_GAP = 4, DG_COIN = 10, DG_SKULL_PTS = 10, DG_HEART_FULL_PTS = 5, DG_SLOW_SEC = 5, DG_BUL_SEC = 6;
function dgHash(a, b) {
  let x = (Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(((b >>> 0) + 0x7f4a7c15) >>> 0, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0; x ^= x >>> 15;
  return x >>> 0;
}
function dgItem(seed, n, players) {   // 第 n 個道具：{ts 出現秒數, x, y, kind}；kind：coin／heart／skull／slow／bul
  const h = k => dgHash(seed, n * 8 + k), r = h(3) % 100;
  const kind = players <= 1 ? (r < 70 ? "coin" : "heart") : r < 38 ? "coin" : r < 55 ? "heart" : r < 70 ? "skull" : r < 85 ? "slow" : "bul";
  return { ts: 3 + DG_ITEM_GAP * n + (h(0) % 2000) / 1000, x: 30 + h(1) % (DG_W - 60), y: 30 + h(2) % (DG_H - 60), kind };
}
const dgScore = s => Math.max(0, Math.floor(s.died ?? 0) + (s.bonus || 0));   // 分數＝存活秒數（取整）＋道具分，最低 0
function dgPick(t, cid, n, now, x, y) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "dodge" || role !== "seat" || t.phase !== "playing" || !g || !Number.isInteger(n) || n < 0 || n > 10000) return;
  const s = t.seats[i];
  if (s.out) return;
  const e = (now - g.t0) / 1000, it = dgItem(g.seed, n, g.n);
  if (e < it.ts - 0.3 || e > it.ts + DG_ITEM_LIFE + 0.6 || g.taken.some(x => x.n === n)) return;
  // 位置驗證：客戶端回報撿到時的座標要在道具旁（半徑 22），且離伺服器最後知道的位置不能太遠（pos 約 8 次／秒，留延遲餘裕 120）
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || (x - it.x) ** 2 + (y - it.y) ** 2 > 22 * 22) return;
  if (s.px != null && (s.px - x) ** 2 + (s.py - y) ** 2 > 120 * 120) return;
  const k = it.kind, nm = s.name;
  g.taken.push({ n, by: i, k });
  if (k === "coin") { s.coins = (s.coins || 0) + 1; s.bonus += DG_COIN; tblLog(t, `${nm} 吃到金幣 +${DG_COIN} 分`); }
  else if (k === "heart") {
    if (s.lives < DG_LIVES) { s.lives += 1; tblLog(t, `${nm} 吃到愛心，回復 1 條命`); }
    else { s.bonus += DG_HEART_FULL_PTS; tblLog(t, `${nm} 吃到愛心（命已滿）+${DG_HEART_FULL_PTS} 分`); }
  } else if (k === "skull") {
    const others = t.seats.filter((x, j) => j !== i && !x.out);
    if (others.length) {
      const lead = others.reduce((a, b) => (Math.floor(e) + b.bonus > Math.floor(e) + a.bonus ? b : a));
      lead.bonus -= DG_SKULL_PTS; tblLog(t, `${nm} 吃到骷髏：領先的 ${lead.name} −${DG_SKULL_PTS} 分`);
    } else tblLog(t, `${nm} 吃到骷髏，但沒有對手`);
  } else if (k === "slow") { g.fx.push({ k: "slow", by: i, from: Math.round(e * 100) / 100, until: Math.round((e + DG_SLOW_SEC) * 100) / 100, n }); tblLog(t, `${nm} 吃到蝸牛：其他人減速 ${DG_SLOW_SEC} 秒`); }
  else { g.fx.push({ k: "bul", by: i, from: Math.round(e * 100) / 100, until: Math.round((e + DG_BUL_SEC) * 100) / 100, n }); tblLog(t, `${nm} 吃到準星：${DG_BUL_SEC} 秒內場上多出只會打到別人的子彈`); }
}
// 存活秒數 → XP：不到 10 秒不給（擋刷分）；之後每 30 秒 +1，起跳 1、上限 10
const dgXp = sec => (sec < 10 ? 0 : Math.min(10, 1 + Math.floor(sec / 30)));
const dgElapsed = (t, now) => Math.max(0, Math.min(DG_DUR, (now - t.g.t0) / 1000));
const round1 = x => Math.round(x * 10) / 10;
function dgStart(t) {
  const now = Date.now();
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: now + DG_COUNTDOWN_MS, n: t.seats.length, taken: [], fx: [] };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) { s.lives = DG_LIVES; s.out = false; s.died = null; s.lastHit = 0; s.left = false; s.ready = false; s.bonus = 0; s.coins = 0; s.px = null; s.py = null; }
  tblLog(t, `挑戰開始！${t.seats.length} 人參加，每人 ${DG_LIVES} 條命`);
}
function dgOut(t, s, now, why) {
  s.out = true; s.died = round1(dgElapsed(t, now));
  tblLog(t, `${s.name} ${why}，存活 ${s.died} 秒`);
}
function dgFinish(t, now) {
  for (const s of t.seats) if (!s.out) { s.out = true; s.died = round1(dgElapsed(t, now)); }   // 時間到還活著的：存活到最後
  const ranking = t.seats.map(s => ({ name: s.name, uid: s.uid || null, sec: s.died, bonus: s.bonus, score: dgScore(s), left: !!s.left })).sort((a, b) => b.score - a.score || b.sec - a.sec);
  const stay = t.seats.filter(s => !s.left);
  const xp = stay.map(s => dgXp(s.died));   // 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
  const top = ranking[0], text = top ? `挑戰結束！第一名 ${top.name}，${top.score} 分` : "挑戰結束";
  const gs = stay.map(s => gsMk({}, { best: Math.max(0, dgScore(s)), bsec: Math.floor(s.died || 0), coin: s.coins || 0 }));   // best＝分數、bsec＝存活秒數、coin＝這局吃到的金幣數（都取最大）
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), ranking, xp, gs };
  tblLog(t, text);
  tblResetSeats(t);
  t.g = null;
}
// 場上沒有活人，或時間到了：結束
function dgCheckEnd(t, now) {
  if (t.game !== "dodge" || t.phase !== "playing" || !t.g) return;
  if (now >= t.g.t0 + DG_DUR * 1000 || t.seats.every(s => s.out)) dgFinish(t, now);
}
function dgHit(t, cid, now) {
  const [role, i] = tblFind(t, cid);
  if (t.game !== "dodge" || role !== "seat" || t.phase !== "playing" || !t.g) return;
  const s = t.seats[i];
  if (s.out || now < t.g.t0 || now - (s.lastHit || 0) < DG_INV_MS - 400) return;   // 還沒開始、已出局、無敵時間內（留 400ms 的網路抖動餘裕）
  s.lastHit = now; s.lives -= 1;
  if (s.lives <= 0) dgOut(t, s, now, "出局");
  dgCheckEnd(t, now);
}
// 遊戲進行中有人離開：視同淘汰（照這一刻的存活秒數計分），遊戲繼續到場上沒有活人為止（使用者定）
function dgLeave(t, i, now) {
  const s = t.seats[i];
  if (!s.out) dgOut(t, s, now, "離開了"); else tblLog(t, `${s.name} 離開了`);
  s.left = true; s.cid = null;
  dgCheckEnd(t, now);
}
// ---- 見習驅魔師（第十桌 t10；2026-11-12，使用者要求）：1～4 人合作，玩家在場地正中央，幽靈從四面八方飄向中央，用滑鼠畫出幽靈身上的符號消除它 ----
// 3 波小怪＋1 隻 Boss；沒被消除的幽靈碰到中央就扣某位玩家 1 滴血，全員死亡失敗、打贏 Boss 勝利。幽靈由 seed 決定性地產生（與 dev_server 的 mg_gen、client 的
// mgGenC 同一套，隨機只用 dgHash，不用 sin/cos，兩邊結果完全一致）；符號辨識在客戶端，伺服器權威管血量、擊殺（先到先得）、Boss 血量與勝負；
// 沒被消除的幽靈扣血由伺服器在收到任何訊息時按時間懶惰結算（mgTick，客戶端每秒送 sync）。只有單人勝利進排行榜。與 dev_server 的 mg_* 同一套。
const MG_HP = 5, MG_WAVE_START = 3, MG_WAVE_LEN = 28, MG_WAVE_GAP = 4;   // 第 k 波＝[3+32k, 3+32k+28)
const MG_BOSS_START = MG_WAVE_START + 3 * (MG_WAVE_LEN + MG_WAVE_GAP), MG_BOSS_LIMIT = 180;   // Boss 出場時間（99 秒）；出場後 1.5 秒才能開始打；打不贏的上限
const MG_R0 = 390, MG_R_HIT = 28, MG_GRACE = 0.8;   // 幽靈出現半徑（場外）、碰到中央的半徑、抵達後多久才結算扣血（容許延遲）
const MG_N_SYMS = 10;   // 符號種類（不分難度、波數，一開始就有全部 10 種；2026-11-13 加了 M）
const MG_SYMS = [[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6]];   // 各難度（簡易／中等／困難／超難）每波「一隻幽靈身上的符號個數」；Boss 戰時的小鬼用第 1 波的個數
const MG_SYM_PTS = 5;   // 計分：每畫對一個符號（小怪身上的、Boss 的都算）+5 分
const MG_INTERVAL = [2.6, 2.6, 2.6, 2.6], MG_SPEED = [38, 46, 55, 66];   // 各難度小怪生成間隔（秒，1 人；2026-11-13 起各難度一樣）、幽靈速度（px/s；難度越高越快，2026-11-13 使用者要求）、幽靈速度（px/s）
const MG_WAVE_MULT = [1.0, 0.85, 0.7, 1.8];   // 各波間隔倍率（第 4 項＝Boss 戰時的小鬼騷擾，比較稀）
const MG_BOSS_HP = [12, 18, 26, 38], MG_MULT = [1.0, 1.5, 2.2, 3.2], MG_XP = [4, 6, 8, 10], MG_DIFF_NAMES = ["簡易", "中等", "困難", "超難"];   // Boss 血量（1 人，每多 1 人 +60%）、分數難度倍率、勝利 XP（失敗 1）
const mgBossHp = (diff, n) => Math.ceil(MG_BOSS_HP[diff] * (1 + 0.6 * (n - 1)) - 1e-9);
const mgElapsed = (t, now) => (now - t.g.t0) / 1000;
const mgAlive = t => t.seats.map((s, i) => (s.dead ? -1 : i)).filter(i => i >= 0);
function mgGen(g, upto) {   // 產生 ts <= upto 的幽靈，附加到 g.gh；每隻 {i, ts, syms（要依序畫的符號）, arr, tgt, w}；g.cur 是下一隻的出現時間。符號個數愈多的幽靈飄得愈慢、出現間隔愈長
  const d = g.diff, n = g.n, seed = g.seed;
  for (;;) {
    let t = g.cur;
    if (t < MG_BOSS_START) {
      const k = Math.floor((t - MG_WAVE_START) / (MG_WAVE_LEN + MG_WAVE_GAP));
      if ((t - MG_WAVE_START) - k * (MG_WAVE_LEN + MG_WAVE_GAP) >= MG_WAVE_LEN) t = MG_WAVE_START + (k + 1) * (MG_WAVE_LEN + MG_WAVE_GAP);   // 波與波之間的空檔：跳到下一波開頭
    }
    if (t >= MG_BOSS_START && t < MG_BOSS_START + 2) t = MG_BOSS_START + 2;
    g.cur = t;
    if (t > upto) return;
    const i = g.gh.length, w = t >= MG_BOSS_START ? 3 : Math.floor((t - MG_WAVE_START) / (MG_WAVE_LEN + MG_WAVE_GAP));
    const m = w === 3 ? MG_SYMS[d][0] : MG_SYMS[d][w];
    const h = j => dgHash(seed, 10000 + i * 16 + j), u = j => h(j) / 4294967296;
    const sp = MG_SPEED[d] * (0.85 + 0.3 * u(2)) * (w === 3 ? 0.9 : 1.0) / (1 + 0.3 * (m - 1));
    g.gh.push({ i, ts: t, syms: Array.from({ length: m }, (_, j) => h(8 + j) % MG_N_SYMS), arr: t + (MG_R0 - MG_R_HIT) / sp, tgt: h(3), w });
    g.cur = t + MG_INTERVAL[d] * MG_WAVE_MULT[w] / (1 + 0.5 * (n - 1)) * (0.7 + 0.6 * u(4)) * (1 + 0.3 * (m - 1));
  }
}
function mgStart(t) {
  const now = Date.now(), diff = [0, 1, 2, 3].includes(t.diff) ? t.diff : 0, n = t.seats.length;
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: now + DG_COUNTDOWN_MS, diff, n, cur: MG_WAVE_START, gh: [], killed: {}, prog: {}, last: {}, rp: {}, boss: mgBossHp(diff, n), dmg: 0, hits: 0, lastBossAt: 0, credit: [], kills: 0 };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) { s.hp = MG_HP; s.dead = false; s.syms = 0; s.left = false; s.ready = false; }
  tblLog(t, `見習驅魔師（${MG_DIFF_NAMES[diff]}）開始！${n} 人參加，每人 ${MG_HP} 滴血`);
}
function mgFinish(t, now, win) {
  const g = t.g, e = Math.max(0, mgElapsed(t, now));
  const hpLeft = t.seats.reduce((a, s) => a + (s.dead ? 0 : s.hp), 0), syms = t.seats.reduce((a, s) => a + (s.syms || 0), 0);
  const score = win ? Math.floor(1000 * MG_MULT[g.diff] + syms * MG_SYM_PTS + hpLeft * 50 + Math.max(0, 240 - e) * 5) : 0;
  const ranking = t.seats.map(s => ({ name: s.name, uid: s.uid || null, syms: s.syms || 0, hp: Math.max(0, s.hp), dead: !!s.dead, left: !!s.left }));
  const stay = t.seats.filter(s => !s.left), solo = g.n === 1;
  const xp = stay.map(() => (win ? MG_XP[g.diff] : 1));
  let text = win ? `驅魔師們打倒了 Boss！${MG_DIFF_NAMES[g.diff]}模式通關，${score} 分` : `驅魔師們全軍覆沒…（${MG_DIFF_NAMES[g.diff]}模式）`;
  if (!win && e >= MG_BOSS_START && mgAlive(t).length) text = `Boss 太強了，撐不住…（${MG_DIFF_NAMES[g.diff]}模式）`;
  const gs = stay.map(s => gsMk({ syms: s.syms || 0, ...(win ? { ["c" + g.diff]: 1, ...(solo ? { solo: 1 } : {}), ...(!s.dead && s.hp >= MG_HP ? { nd: 1 } : {}) } : {}) }));   // syms＝畫對的符號數；c0～c3＝各難度通關；solo＝單人通關；nd＝通關且自己沒掉血
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), ranking, xp, win, score, diff: g.diff, solo, syms, gs };
  tblLog(t, text);
  tblResetSeats(t);
  t.g = null;
}
function mgTick(t, now) {   // 依時間結算：抵達中央卻沒被消除的幽靈扣血、全員死亡或 Boss 戰超時就失敗；回傳這次有沒有改變狀態
  if (t.game !== "mage" || t.phase !== "playing" || !t.g) return false;
  const g = t.g, e = mgElapsed(t, now);
  if (e < 0) return false;
  let changed = false;
  mgGen(g, e + 0.001);
  for (const gh of g.gh) {
    if (g.rp[gh.i] || gh.arr + MG_GRACE > e) continue;
    g.rp[gh.i] = 1;
    delete g.prog[gh.i];
    if (g.killed[gh.i] !== undefined) continue;
    const al = mgAlive(t);
    if (!al.length) continue;
    const s = t.seats[al[gh.tgt % al.length]];
    s.hp -= 1; changed = true;
    if (s.hp <= 0) { s.dead = true; tblLog(t, `${s.name} 倒下了`); }
  }
  if (g.dmg >= g.boss) { mgFinish(t, now, true); return true; }   // Boss 倒下優先於全員倒下（打倒的瞬間就算贏）
  if (!mgAlive(t).length) { mgFinish(t, now, false); return true; }
  if (e >= MG_BOSS_START + MG_BOSS_LIMIT) { mgFinish(t, now, false); return true; }
  return changed;
}
function mgKill(t, cid, i, p, now) {   // 畫對幽靈 i 的第 p 個符號（p＝這隻已完成的符號數）；全部畫完才算消除；同一個符號幾乎同時（700ms 內）畫對的隊友也行（不重複計）
  const [role, k] = tblFind(t, cid), g = t.g;
  if (t.game !== "mage" || role !== "seat" || t.phase !== "playing" || !g || !Number.isInteger(i) || i < 0 || !Number.isInteger(p) || p < 0) return;
  const s = t.seats[k];
  if (s.dead) return;
  const e = mgElapsed(t, now);
  mgGen(g, e + 0.001);
  if (i >= g.gh.length || g.killed[i] !== undefined) return;
  const gh = g.gh[i];
  if (gh.ts > e + 0.3 || e > gh.arr + MG_GRACE) return;
  const cur = g.prog[i] || 0, last = g.last[i];
  if (p === cur) { g.prog[i] = cur + 1; g.last[i] = { at: now, by: [k] }; s.syms += 1; }   // 每畫對一個符號就算一個（計分用）
  else if (p === cur - 1 && last && now - last.at <= 700 && !last.by.includes(k)) { last.by.push(k); s.syms += 1; return; }   // 同一個符號幾乎同時畫對的隊友：接受（不重複前進）
  else return;
  if (g.prog[i] >= gh.syms.length) { g.killed[i] = k; delete g.prog[i]; }   // 最後一個符號畫完：消除
}
function mgBossHit(t, cid, kk, now) {
  const [role, k] = tblFind(t, cid), g = t.g;
  if (t.game !== "mage" || role !== "seat" || t.phase !== "playing" || !g || !Number.isInteger(kk) || t.seats[k].dead) return;
  const e = mgElapsed(t, now);
  if (e < MG_BOSS_START + 1.5 || g.dmg >= g.boss) return;
  if (kk === g.hits) { g.dmg += 1; g.hits += 1; g.lastBossAt = now; g.credit = [k]; }   // 這個符號第一個畫對的人：Boss 換下一個符號
  else if (kk === g.hits - 1 && now - g.lastBossAt <= 700 && !g.credit.includes(k)) { g.dmg += 1; g.credit.push(k); }   // 同一個符號幾乎同時畫對的隊友：也算一次傷害（合作）
  else return;
  t.seats[k].syms += 1;
}
function mgLeave(t, i, now) {   // 遊戲進行中有人離開：視同倒下，遊戲繼續到場上沒有活人為止
  const s = t.seats[i];
  s.dead = true; s.left = true; s.cid = null;
  tblLog(t, `${s.name} 離開了`);
  mgTick(t, now);
  if (t.phase === "playing" && !mgAlive(t).length) mgFinish(t, now, false);
}
function mgSetDiff(t, cid, v) {   // 桌主（第一位入座的人）在開局前選難度；改了大家要重新準備
  const [role, i] = tblFind(t, cid);
  if (t.game !== "mage" || role !== "seat" || i !== 0 || t.phase !== "lobby" || !Number.isInteger(v) || v < 0 || v > 3 || (t.diff || 0) === v) return;
  t.diff = v;
  for (const s of t.seats) s.ready = false;
  tblLog(t, `${t.seats[0].name} 把難度改成${MG_DIFF_NAMES[v]}`);
}
// ---- 英文打字競賽（第七桌 t7；2026-11-10，使用者要求）：1～8 人、倒數 3 秒後 30 秒內比誰打完的英文單字多 ----
// 題目由客戶端用伺服器給的 seed 決定性地產生（大家同一串單字，單字表在 games.json 的 typing.words）；打字與錯字鎖定都在客戶端，
// 每打完一個字回報 word {n}（n＝目前總分，信任客戶端；伺服器只收「比上次多 1～3」的值），伺服器記分、轉發 tsc {i, n} 給同桌其他人。
// 時間到後留 TY_SETTLE_MS 收最後的分數，客戶端再送 finish，伺服器核對時鐘才結算。中途離開不中斷（座位留空殼、照當時分數排名、不給 XP）。
// 與 tools/dev_server.py 的 ty_* 同一套。
// 中文打字競賽（第九桌 t9，2026-11-11，使用者要求）：規則與英打完全一樣（同一套 ty*），只是題目換成 games.json 的 zhtyping.words、
// 客戶端用輸入法「送出選字」後的文字比對（伺服器不管輸入內容，只收分數）；game id＝zhtyping
const isTy = t => t.game === "typing" || t.game === "zhtyping";
const tyUnit = t => (t.game === "zhtyping" ? "詞" : "單字");
// 排行榜（2026-11-12，使用者要求）：英文打字競賽、中文打字競賽、躲彈幕各記前三名（打字＝分數、躲彈幕＝存活秒數）；同一個人只留最好的一筆；
// 記在這座島的 storage（"boards"），每次結算後更新，table 畫面帶 board 給客戶端顯示。與 tools/dev_server.py 的 BOARDS 同一套
const BOARD_GAMES = new Set(["typing", "zhtyping", "dodge", "mage", "arcade", "maze"]), BOARD_N = 3;   // 俄羅斯方塊／豆豆迷宮：只記單人模式（使用者定）
// 躲彈幕 2026-11-12 起改記「分數」（存活秒數＋道具分），舊的秒數紀錄放在 "dodge" 不再使用，分數另記在 "dodge2"，避免單位混在一起
const boardKey = game => (game === "dodge" ? "dodge2" : game);
function boardMerge(list, entries) {
  const best = new Map();
  for (const e of [...(list || []), ...entries]) { const k = e.uid ? "u:" + e.uid : "n:" + e.name, o = best.get(k); if (!o || e.score > o.score) best.set(k, e); }   // 同一個人只留最好的一筆：登入者用 uid（改名也算同一人），訪客用名字
  return [...best.values()].sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, BOARD_N);
}
const TY_DUR = 30;              // 比賽秒數（使用者定）
const TY_COUNTDOWN_MS = 3000;   // 開局倒數（使用者定）
const TY_SETTLE_MS = 1000;      // 時間到後再收分數的寬限（最後一個字的回報可能晚到）
const TY_STEP_MAX = 3;          // 一次回報最多比上次多幾分（漏掉的回報由下一次補上）
const TY_XP = 3, TY_XP_MIN = 5; // 正常打完、至少 TY_XP_MIN 個字的入座者 +TY_XP（助手先訂的數值）
const TY_SAVE_MS = 2000;        // 進行中分數寫 storage 的最短間隔（每個字都寫太頻繁）
function tyStart(t) {
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: Date.now() + TY_COUNTDOWN_MS };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) { s.score = 0; s.out = false; s.left = false; s.ready = false; }
  tblLog(t, `比賽開始！${t.seats.length} 人參加，限時 ${TY_DUR} 秒`);
}
function tyFinish(t) {
  const ranking = t.seats.map(s => ({ name: s.name, uid: s.uid || null, score: s.score || 0, left: !!s.left })).sort((a, b) => b.score - a.score);
  const stay = t.seats.filter(s => !s.left);
  const xp = stay.map(s => ((s.score || 0) >= TY_XP_MIN ? TY_XP : 0));   // 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
  const top = ranking[0], text = top ? `比賽結束！第一名 ${top.name}，打了 ${top.score} 個${tyUnit(t)}` : "比賽結束";
  const gs = stay.map(s => gsMk({}, { best: s.score || 0 }));   // best＝單局最高分（取最大）
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), ranking, xp, gs };
  tblLog(t, text);
  tblResetSeats(t);
}
// 時間到（含寬限），或入座的人全部離開：結算
function tyCheckEnd(t, now) {
  if (!isTy(t) || t.phase !== "playing" || !t.g) return;
  if (now >= t.g.t0 + TY_DUR * 1000 + TY_SETTLE_MS || t.seats.every(s => s.left)) tyFinish(t);
}
// 回報分數：有更新回 true（呼叫端轉發給同桌）
function tyWord(t, cid, n, now) {
  const [role, i] = tblFind(t, cid);
  if (!isTy(t) || role !== "seat" || t.phase !== "playing" || !t.g) return false;
  if (now < t.g.t0 || now > t.g.t0 + TY_DUR * 1000 + TY_SETTLE_MS) return false;
  const s = t.seats[i];
  if (!Number.isInteger(n) || n <= (s.score || 0) || n > (s.score || 0) + TY_STEP_MAX) return false;
  s.score = n;
  return true;
}
function tyLeave(t, i, now) {
  const s = t.seats[i];
  tblLog(t, `${s.name} 離開了（${s.score || 0} 個${tyUnit(t)}）`);
  s.left = true; s.cid = null;
  tyCheckEnd(t, now);
}
// ---- 秘藥情報戰（第八桌 t8；2026-11-10，使用者要求，原創規則）：3～8 人、隱藏身分（沙都／水都／第三方咒術師）、蓋著投遞密函 ----
// 規則（使用者定的部分見 notes「和平島與遊戲桌」）：輪到的人抽 2 張，可以先用行動牌，再把一張手牌蓋著交給任一位玩家；
// 拿到的人選「收下」（翻開放進自己的情報區，公開）或「轉手」給還沒碰過這封的人，所有人都碰過就必須收下。
// 密函＝印記顏色（黃＝沙都、藍＝水都、黑＝咒函、灰＝廢紙，有雙色牌）＋行動效果。勝負：沙都／水都任一人情報區有 3 張自己顏色 → 該國全員獲勝；
// 咒術師情報區有 3 張黑 → 他獲勝；其他人有 3 張黑 → 出局。場上只剩一個陣營 → 該陣營獲勝。牌堆抽完把棄牌堆（沒被收下的牌）洗回去（使用者定）。
// 行動打出後有 IT_PEND_MS 的識破時間，別人可以用「識破」取消；時間到才生效（客戶端送 timeout，伺服器核對時鐘，不用鬧鐘）。與 tools/dev_server.py 的 it_* 同一套。
const IT_TURN_MS = 30000;   // 投遞回合限時（不限時模式沒有任何計時，見 t.untimed）
const IT_HOLD_MS = 15000;   // 收／轉限時
// 加時（2026-11-11，使用者要求；只有限時模式）：倒數中任何活著的入座玩家可以按「加時」，這段倒數變成「該段上限秒數 ×5」（從按下時起算），
// 同一段倒數最多 2 個人加時（後按的人一樣重設成上限 ×5），所有加時的人都按「跳過」才縮回剩 3 秒（原本剩的比 3 秒短就不變）；
// 每人每局 3 次。「一段倒數」＝識破時間（每張出的牌／識破各自一段）、投遞回合、每次有人拿到情報的收／轉；換下一段就重新算
const IT_EXT_MUL = 5, IT_EXT_MAX = 2, IT_EXT_PER = 3, IT_EXT_SKIP_MS = 3000;
const IT_PEND_MS = 5000;    // 行動（含識破）打出後的識破時間（使用者定 5 秒；識破本身也能被識破，每次重新計時）
const IT_WIN = 3, IT_DEATH = 3;
const IT_XP = 6;            // 正常結束：每位入座者 +6（輸贏一樣，同其他桌；助手先訂的數值）
const IT_HAND0 = 4;
const IT_MSGS = new Set(["isend", "itake", "ifwd", "iact", "timeout", "imode", "iok", "iext", "iskip", "ians", "ichars", "ipick", "iskill", "iprompt"]);         // 開局手牌
const IT_ACT = { P: "截閱", S: "調包", F: "鎖定", X: "焚信", H: "搜身", W: "洗白", C: "識破", I: "攔截", T: "轉移", B: "阻擋", N: "無人倖免", V: "查驗", D: "補給", R: "竊取" };
const IT_KIND = { seal: "密函", pub: "公開情報", direct: "直達情報" };   // 投遞方式（由卡面決定，不是玩家選）：蓋著照座位傳／翻開照座位傳／直接指定一人（對方必須收下）
const IT_KIND_CODE = { s: "seal", p: "pub", d: "direct" };
const IT_KIND_CYCLE = "sspsd";   // 牌組依序循環分配投遞方式：密函 60%、公開 20%、直達 20%
const IT_CNAME = { Y: "黃", B: "藍", K: "黑" };   // 2026-11-11 使用者要求移除灰（廢紙）
const IT_ROLE = { sand: "沙都", water: "水都", mage: "咒術師" };
// 牌組 75 張：印記 → 各行動的張數（雙色牌同時算兩種顏色；沒有灰）。2026-11-11 使用者要求重配：黃藍雙色減少、黃黑／藍黑增加；
// 焚信 −4、洗白 +2、搜身 −2、攔截 +2、阻擋 +2，新增補給 D 4 張、竊取 R 3 張（顏色由助手分配）。含黃 35、含藍 35、含黑 33
// （2026-11-11 再改：洗白 +2，加在純黃、純藍各 1 張，共 77 張；含黃 36、含藍 36、含黑 33）
// （2026-11-13 使用者要求：取消黃藍雙色牌，那 6 張平均分給黃黑與藍黑各 3 張——黃黑加 P／S／I、藍黑加 B／V／D，各行動的總張數不變；現在含黃 33、含藍 33、含黑 39）
// 各行動：截閱 8、調包 8、鎖定（原押送）9、焚信 2、搜身 4、洗白 6、識破 11、攔截 6、轉移 4、阻擋 6、無人倖免 2、查驗 4、補給 4、竊取 3
const IT_DECK = { Y: "P2S2F2X1H1W2C3I1T1B1N1V1D1", B: "P2S2F2X1H1W2C3I1T1B1N1V1D1", K: "P1S1F1H1W1C1I1B1V1D1R1", YK: "P2S2F2H1C2I2T1B1R1", BK: "P1S1F2W1C2I1T1B2R1V1D1" };
const IT_PICK_MS = 30000;   // 選角時限（限時模式；逾時沒選的自動選第一張；不限時模式等大家選完）
// 角色卡（2026-11-11 使用者提供規格，完整文字見 docs/intel-characters.md）：桌主在開局前開「角色卡」才會用。每人開局拿 1 張身分＋2 張角色、選 1 張。
// type：public 選完就翻開／hidden 選完仍覆蓋（只有本人與觀戰者看得到）。第 0 階段只做「選角＋咒術師身分的勝利條件＋宣告勝利結算」，技能第 1 階段起才實作
const IT_CHARS = {
  poisoner: ["毒藥師", "public"], healer: ["解藥師", "hidden"], doubleagent: ["雙面間諜", "public"], cautious: ["謹慎者", "public"],
  judge: ["審判者", "public"], fisher: ["漁翁", "hidden"], desperate: ["絕望者", "public"], harmonizer: ["調和者", "public"],
  killer: ["殺手", "public"], collector: ["收藏家", "public"], fencesitter: ["牆頭草", "public"], usurper: ["篡奪者", "public"],
  broker: ["情報商", "public"], assassin: ["暗殺者", "public"], helper: ["助人者", "public"], sniper: ["狙擊手", "public"],
  outsider: ["局外人", "public"], blackcollector: ["咒函蒐集者", "public"],
};
const IT_MAGES = { 3: 1, 4: 0, 5: 1, 6: 2, 7: 1, 8: 2 };   // 人數 → 咒術師人數（使用者定：4 人局 2 對 2）；其餘沙都、水都平分
function itDeck() {   // 牌＝「印記.行動.投遞方式」（例 YB.F.p）；投遞方式 s 密函／p 公開情報／d 直達情報，由卡面決定
  const d = [];
  for (const [col, spec] of Object.entries(IT_DECK)) for (const m of spec.matchAll(/([A-Z])(\d+)/g)) for (let k = 0; k < Number(m[2]); k++) d.push(`${col}.${m[1]}`);
  return d.map((c, k) => `${c}.${IT_KIND_CYCLE[k % IT_KIND_CYCLE.length]}`);
}
const itCols = c => c.split(".")[0];
const itAct = c => c.split(".")[1];
const itKindOf = c => IT_KIND_CODE[c.split(".")[2]] || "seal";
const itCount = (intel, col) => intel.filter(c => itCols(c).includes(col)).length;
const itLabel = c => [...itCols(c)].map(x => IT_CNAME[x]).join("") + "·" + IT_ACT[itAct(c)];
const itAlive = t => t.seats.map((s, i) => (s.out || s.left ? -1 : i)).filter(i => i >= 0);
const itOk = (t, i) => Number.isInteger(i) && i >= 0 && i < t.seats.length && !t.seats[i].out && !t.seats[i].left;
function itNext(t, i) {
  const n = t.seats.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (itOk(t, j)) return j; }
  return -1;
}
// 照座位順序，從 i 往後第一個還沒碰過這封情報（seen）的活人；沒有＝-1
function itNextUntouched(t, i, seen) {
  const n = t.seats.length;
  for (let k = 1; k < n; k++) { const j = (i + k) % n; if (itOk(t, j) && !seen.includes(j)) return j; }
  return -1;
}
// 拿著情報的人能轉給誰（-1＝只能收下）：蓋著／公開＝座位順序的下一個沒碰過的人；直達＝拿著的人（目標本人或攔截者）可以不收、退回給發信者，發信者必須收下
function itFwdTarget(t, L) {
  if (itLocked(t.g, L.at)) return -1;   // 被鎖定的人：情報到他手上就只能收下（不能傳走、不能退回）
  const nx = L.kind === "direct" ? -1 : itNextUntouched(t, L.at, L.seen);   // 直達不照座位傳，不收就直接退回發信者
  if (nx >= 0) return nx;
  return L.at !== L.from && itOk(t, L.from) ? L.from : -1;   // 大家都不收：退回給發信者，發信者必須收下
}
const itDl = (g, now, ms) => { g.ext = null; return g.untimed ? 0 : now + ms; };   // 開始新的一段倒數（清掉上一段的加時）；不限時模式：期限＝0（沒有倒數）
// 牌堆頂一張（牌堆空了就把棄牌堆洗回去）；都沒有＝undefined
function itTop(t) {
  const g = t.g;
  if (!g.deck.length && g.discard.length) { g.deck = shuffle(g.discard); g.discard = []; tblLog(t, "牌堆抽完了，把丟出的密函洗回牌堆"); }
  return g.deck.pop();
}
function itDraw(t, i, n) {
  const hand = t.seats[i].hand;
  for (let k = 0; k < n; k++) { const c = itTop(t); if (c === undefined) break; hand.push(c); }
}
// 阻擋：本回不能「收下」情報的人（g.blocked，換回合就清空）；沒有可轉的人時（只能收下）阻擋不生效，避免卡死；押送優先於阻擋
const itBlocked = (g, i) => (g.blocked || []).includes(i);
// 鎖定（F，原押送；2026-11-11 使用者改）：輪到的人在自己的回合（投遞前或傳遞中）指定一人，本回情報到他手上就必須收下（g.locked，換回合清空）；
// 鎖定的人沒有可轉的對象（itFwdTarget＝-1），所以阻擋對他不生效（鎖定優先於阻擋），也不能用轉移把情報丟給別人
const itLocked = (g, i) => (g.locked || []).includes(i);
const itCanTake = (t, L, i) => !itBlocked(t.g, i) || itFwdTarget(t, L) < 0;
// 鎖定生效（鎖定牌、殺手的標記目標／死亡預告、漁翁的灑網）：他正拿著情報就立刻收下；還沒拿到就標記，本回情報到他手上時只能收下
function itLockApply(t, by, tgt, now) {
  const g = t.g;
  if (!itLocked(g, tgt)) (g.locked || (g.locked = [])).push(tgt);
  if (g.letter && g.step === "pass" && g.letter.at === tgt) { tblLog(t, `${t.seats[tgt].name} 被鎖定，必須收下情報`); g.letter.cause = by; itReceive(t, now); }
  else tblLog(t, `${t.seats[by].name} 鎖定了 ${t.seats[tgt].name}：本回情報到他手上就必須收下`);
}
// 局外人「冷眼旁觀」：情報區 ≤1 張時（角色卡已翻開），不能被搜身、竊取、查驗指定
const itColdEye = (t, i) => !!t.g.chars && itSkillReady(t, i, "outsider") && t.seats[i].intel.length <= 1;
// 篡奪者「死裡逃生」（一局一次）：用的那個回合收到咒函不會出局，回合結束時洗白自己該回合收到的咒函
function itImmuneEnd(t) {
  const g = t.g;
  for (const s of t.seats) {
    if (!s.immuneTurn || s.immuneTurn !== g.turnNo) continue;
    for (const c of s.immuneCards || []) { const k = s.intel.indexOf(c); if (k >= 0) { s.intel.splice(k, 1); g.discard.push(c); } }
    if ((s.immuneCards || []).length) tblLog(t, `${s.name}【篡奪者】死裡逃生：回合結束，洗白了這回合收到的 ${s.immuneCards.length} 封咒函`);
    s.immuneTurn = 0; s.immuneCards = [];
  }
}
// 翻開角色卡（隱藏型用「公開角色牌」的技能時）
function itFlip(t, i) {
  const s = t.seats[i];
  if (s.faceUp) return;
  s.faceUp = true;
  tblLog(t, `${s.name} 翻開了角色卡：【${IT_CHARS[s.char][0]}】`);
}
// ---- 角色卡的勝利條件與「宣告勝利」結算（2026-11-11）：死亡＝出局（只會因收到第 3 張咒函）；咒函＝含黑的情報；純黑＝只有黑色一種印記 ----
// 角色卡模式下：咒術師不再靠集滿 3 張咒函獲勝，也會因收到第 3 張咒函出局；咒術師身分的人用角色卡的勝利條件。沙都／水都不變（集滿 3 張自己顏色）
const itHasK = c => itCols(c).includes("K");
const itBlack = intel => intel.filter(itHasK).length;
const itPureBlack = c => itCols(c) === "K";
// 搜身／竊取能選到的手牌：咒函蒐集者「藏鋒」（角色卡已翻開）不會被選到純黑牌
const itHideBlack = (t, i) => { const h = t.seats[i].hand; return t.g.chars && itSkillReady(t, i, "blackcollector") ? h.filter(c => !itPureBlack(c)) : [...h]; };
// 因咒函出局：記錄出局者、「親手殺掉」的人（killer）、第幾位出局、他出局時是不是手牌最多（或之一）的人（狙擊手用）
function itKill(t, i, cause) {
  const g = t.g, s = t.seats[i], alive = itAlive(t), most = Math.max(...alive.map(j => t.seats[j].hand.length));
  g.deaths.push({ seat: i, killer: cause !== undefined && cause !== i && cause >= 0 ? cause : -1, order: g.deaths.length, maxHand: s.hand.length === most });
  s.out = true;
  if (g.chars && s.faceUp && !s.left) {   // 出局時觸發、要做決定的技能：遺言（絕望者，一局一次）、殉道（助人者）
    if (s.char === "desperate" && !s.onceUsed) (g.dieQ || (g.dieQ = [])).push({ kind: "will", seat: i });
    if (s.char === "helper") (g.dieQ || (g.dieQ = [])).push({ kind: "martyr", seat: i });
  }
  if (g.chars) t.seats.forEach((x, k) => { if (k !== i && itSkillReady(t, k, "fisher")) (g.dieQ || (g.dieQ = [])).push({ kind: "profit", seat: k, victim: i }); });   // 漁翁「得利」：有人出局時，可在另一位玩家面前放最多 2 張咒函
  if (g.chars && t.seats.some((x, k) => k !== i && itSkillReady(t, k, "collector"))) g.lootQ.push(i);   // 收藏家可以搜刮：死者的手牌先留著，等 itLootRun 處理
  else { g.discard.push(...s.hand); s.hand = []; }
  tblLog(t, `${s.name} 收到 ${IT_DEATH} 封咒函，暴露出局！身分是${IT_ROLE[s.role]}`);
}
// 咒術師身分的角色卡勝利條件（自己達成就宣告）。牆頭草／篡奪者／助人者／局外人是「別人宣告時」才生效，見 itDeclare
function itCharWin(t, i) {
  const g = t.g, s = t.seats[i], id = s.char;
  if (!id) return false;
  const intel = s.intel, alive = !s.out && !s.left, cnt = col => itCount(intel, col);
  const diedRole = role => g.deaths.some(d => t.seats[d.seat].role === role);
  const teamOut = role => { const m = t.seats.filter(x => x.role === role); return m.length > 0 && m.every(x => x.out); };
  switch (id) {
    case "poisoner": return alive && cnt("Y") >= 3;
    case "healer": return alive && cnt("B") >= 3;
    case "doubleagent": return alive && intel.filter(c => itCols(c).length === 2).length >= 3;
    case "cautious": return alive && intel.length >= 4 && itBlack(intel) === 0;
    case "judge": case "fisher": return alive && diedRole("sand") && diedRole("water");
    case "desperate": return (g.deaths.length > 0 && g.deaths[0].seat === i) || teamOut("sand") || teamOut("water");
    case "harmonizer": return alive && cnt("Y") >= 2 && cnt("B") >= 2 && cnt("K") >= 2;
    case "killer": return g.deaths.slice(1).some(d => d.killer === i);
    case "collector": return alive && intel.length >= 6;
    case "broker": return alive && s.hand.length >= 10;
    case "assassin": return alive && g.deaths.some(d => d.killer === i) && itBlack(intel) === 0;
    case "sniper": return g.deaths.some(d => d.killer === i && d.maxHand);
    case "blackcollector": return alive && s.hand.filter(itPureBlack).length >= 5;
    default: return false;
  }
}
// 檢查所有咒術師身分的角色卡勝利條件。咒術師各自計算勝利：同一瞬間有多位達成就一起獲勝（除非像篡奪者那樣讓別人落敗，見 itDeclare）。回傳 true＝遊戲結束
function itCharMages(t) { return t.seats.filter((s, i) => s.role === "mage" && !s.left && s.char && itCharWin(t, i)); }
function itCharCheck(t, from = 0) {
  const g = t.g;
  if (!g || !g.chars) return false;
  const n = t.seats.length, ok = itCharMages(t);
  if (!ok.length) return false;
  const first = t.seats.indexOf(ok.sort((a, b) => ((t.seats.indexOf(a) - from + n) % n) - ((t.seats.indexOf(b) - from + n) % n))[0]);
  const text = ok.length === 1 ? `${ok[0].name} 是咒術師，達成了【${IT_CHARS[ok[0].char][0]}】的勝利條件！` : `${ok.map(s => `${s.name}【${IT_CHARS[s.char][0]}】`).join("、")} 同時達成各自的勝利條件，一起獲勝！`;
  return itDeclare(t, first, ok, text);
}
// 宣告勝利（結算勝利的瞬間）：角色卡模式下先看篡奪者（場上無人出局時，別人宣告的瞬間奪走勝利、原宣告者落敗），再加上「一起獲勝」的咒術師身分角色卡
// （局外人：活著且情報區 ≤1；牆頭草：沙都或水都獲勝時活著且情報區有 2 張以上咒函；助人者：已出局且曾洗白獲勝者的咒函）。沒開角色卡就直接結束
function itDeclare(t, i, winners, text) {
  const g = t.g;
  if (!g.chars) return itFinish(t, text, winners, true);
  const n = t.seats.length, first = t.seats[i];
  for (const s of itCharMages(t)) if (!winners.includes(s)) winners = [...winners, s];   // 同一瞬間也達成自己條件的咒術師一起獲勝（各自計算、共同勝利）
  if (g.deaths.length === 0) {
    for (let k = 1; k < n; k++) {
      const j = (i + k) % n, u = t.seats[j];
      if (u.role === "mage" && u.char === "usurper" && !u.out && !u.left) { winners = [u]; text = `${u.name} 是咒術師【篡奪者】，在 ${first.name} 宣告勝利的瞬間奪走了勝利！`; i = j; break; }
    }
  }
  const decl = t.seats[i], win = new Set(winners), joined = [];
  t.seats.forEach(s => {
    if (s.role !== "mage" || s.left || win.has(s) || !s.char) return;
    const alive = !s.out;
    const ok = (s.char === "outsider" && alive && s.intel.length <= 1)
      || (s.char === "fencesitter" && alive && (decl.role === "sand" || decl.role === "water") && itBlack(s.intel) >= 2)
      || (s.char === "helper" && !alive && [...win].some(w => (s.washedFor || []).includes(t.seats.indexOf(w))));
    if (ok) { win.add(s); joined.push(`${s.name}【${IT_CHARS[s.char][0]}】`); }
  });
  const fin = text + (joined.length ? `　${joined.join("、")} 一起獲勝` : "");
  const hz = [...win].find(w => w.char === "harmonizer" && w.faceUp && !w.left);   // 調和者「救助」：獲勝時可以指定一位玩家一同勝利（先暫停問他，回答完才結束）
  if (hz && t.seats.some(x => !win.has(x) && !x.left)) { itPrompt(t, Date.now(), { kind: "rescue", seat: t.seats.indexOf(hz), win: [...win].map(w => t.seats.indexOf(w)), text: fin, cont: null }); return true; }
  return itFinish(t, fin, [...win], true);
}
// 選角：每人 2 張選 1 張，其餘棄掉；全員選完（或逾時自動選第一張）後，公開型的翻開，開始第一個回合
function itPickDone(t, now) {
  const g = t.g;
  for (const s of t.seats) {
    if (s.left || s.char) continue;
    s.char = s.choices[0];
  }
  for (const s of t.seats) {
    if (!s.char) continue;
    s.choices = null; s.faceUp = IT_CHARS[s.char][1] === "public";
    if (s.faceUp) tblLog(t, `${s.name} 的角色卡：【${IT_CHARS[s.char][0]}】`);
  }
  tblLog(t, "選角完成，隱藏型的角色卡維持覆蓋");
  itBeginTurn(t, g.first, now);
}
function itPickCheck(t, now) {
  const g = t.g;
  if (!g || g.step !== "pick") return;
  if (t.seats.every(s => s.left || s.char)) itPickDone(t, now);
}
function itStart(t) {
  const n = t.seats.length, m = IT_MAGES[n] ?? 1, half = (n - m) / 2;
  const roles = shuffle([...Array(half).fill("sand"), ...Array(half).fill("water"), ...Array(m).fill("mage")]), deck = shuffle(itDeck());
  t.seats.forEach((s, k) => { s.hand = deck.splice(deck.length - IT_HAND0, IT_HAND0); s.intel = []; s.role = roles[k]; s.out = false; s.left = false; s.ready = false; s.note = null; s.extLeft = IT_EXT_PER; s.char = null; s.choices = null; s.faceUp = false; s.washedFor = []; s.onceUsed = false; });
  t.g = { deck, discard: [], step: "turn", letter: null, pend: null, arrive: null, blocked: [], deadline: 0, untimed: !!t.untimed, chars: !!t.chars, deaths: [], lootQ: [], prompt: null, first: Math.floor(Math.random() * n) };
  t.result = null; t.phase = "playing";
  tblLog(t, `牌局開始！沙都 ${half} 人、水都 ${half} 人${m ? `、咒術師 ${m} 人` : ""}，每人 ${IT_HAND0} 張${t.untimed ? "（不限時）" : ""}${t.chars ? "（角色卡）" : ""}`);
  if (t.chars) {   // 角色卡：每人 2 張不重複的角色卡，先選角再開始
    const ids = shuffle(Object.keys(IT_CHARS));
    t.seats.forEach((s, k) => { s.choices = [ids[2 * k], ids[2 * k + 1]]; });
    t.g.step = "pick"; t.g.deadline = itDl(t.g, Date.now(), IT_PICK_MS);
    tblLog(t, "請從兩張角色卡中選一張");
    return;
  }
  itBeginTurn(t, t.g.first, Date.now());
}
// 輪到座位 i：抽 2 張；手上沒牌（牌堆也空）就跳過，所有人都沒牌就平手
const itClearStolen = t => { for (const s of t.seats) s.stolen = null; };   // 被竊取的提示：到下一階段（投遞出情報、換下一位）就清掉
function itBeginTurn(t, i, now) {
  const g = t.g;
  for (let k = 0; k < t.seats.length && i >= 0; k++) {
    itImmuneEnd(t);   // 上一個回合結束：死裡逃生的洗白
    t.turn = i; g.step = "turn"; g.letter = null; g.pend = null; g.arrive = null; g.ask = null; g.blocked = []; g.locked = []; itClearStolen(t); g.deadline = itDl(g, now, IT_TURN_MS);
    g.turnNo = (g.turnNo || 0) + 1;   // 第幾個回合（狙擊手「瞄準」每回合一次用）
    t.seats[i].note = null;   // 上一輪偷看到的東西：輪到自己時清掉
    if (g.chars && itDrawChoice(t, i, now)) return;   // 抽牌階段可以改做別的（暗計、採集）：先暫停問他，回答後走 itTurnResume
    if (itTurnDraw(t, i, true)) return;
    tblLog(t, `${t.seats[i].name} 沒有牌可以投遞，跳過`);
    i = itNext(t, i);
  }
  itFinish(t, "沒有人有牌可以投遞了，平手", [], true);
}
// 抽牌階段：draw＝照常抽牌（2 張；囤貨、背水一戰多抽）。回傳 true＝回合繼續（有牌可以投遞，或遊戲已經結束）
function itTurnDraw(t, i, draw) {
  const g = t.g, s = t.seats[i];
  if (draw) {
    let n = 2;
    if (g.chars && itSkillReady(t, i, "broker") && s.hand.length < 5) n += 1;   // 情報商「囤貨」：手牌少於 5 張時多抽 1 張
    if (g.chars && itSkillReady(t, i, "desperate") && itBlack(s.intel) > 0) { n += 1; tblLog(t, `${s.name}【絕望者】背水一戰：情報區有咒函，多抽 1 張`); }
    itDraw(t, i, n);
  }
  if (g.chars && itCharCheck(t, i)) return true;   // 手牌累積型的勝利條件（情報商、咒函蒐集者）
  return s.hand.length > 0;
}
// 抽牌階段的選擇回答完：重新給完整的投遞時間；沒牌可以投遞就換下一位
function itTurnResume(t, now, i, alt) {
  const g = t.g;
  if (!g) return;
  g.deadline = itDl(g, now, IT_TURN_MS);
  if (itTurnDraw(t, i, !alt)) return;
  tblLog(t, `${t.seats[i].name} 沒有牌可以投遞，跳過`);
  itEndLetter(t, now);
}
// 抽牌階段可以改做別的技能：暗殺者「暗計」（場上有咒函時）、咒函蒐集者「採集」。開了暫停就回 true
function itDrawChoice(t, i, now) {
  if (itSkillReady(t, i, "assassin") && t.seats.some((x, k) => itOk(t, k) && itBlack(x.intel) > 0)) { itPrompt(t, now, { kind: "scheme", seat: i, cont: { kind: "draw", seat: i, alt: false } }); return true; }
  if (itSkillReady(t, i, "blackcollector")) { itPrompt(t, now, { kind: "gather", seat: i, cont: { kind: "draw", seat: i, alt: false } }); return true; }
  return false;
}
function itFinish(t, text, winners, xp) {
  const reveal = t.seats.map(s => ({ name: s.name, role: s.role, char: s.char || null, intel: [...(s.intel || [])], win: winners.includes(s), left: !!s.left, out: !!s.out }));
  const stay = t.seats.filter(s => !s.left);
  const gs = xp ? stay.map(s => (winners.includes(s) ? gsMk({ w: 1, ...({ sand: { ws: 1 }, water: { wb: 1 }, mage: { wm: 1 } }[s.role] || {}) }) : gsMk({}))) : null;   // ws／wb／wm＝以沙都／水都／咒術師獲勝；有人中途離開（xp＝false）的局不記
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), xp: stay.map(() => (xp ? IT_XP : 0)), reveal, gs };
  tblLog(t, text);
  t.seats = stay;
  tblResetSeats(t);
  t.g = null;
  return true;
}
// 場上只剩一個陣營（或沒人）：結束。byLeave＝因為有人離開才結束（不給 XP，擋刷分，同 UNO）
function itCheckFaction(t, byLeave) {
  const alive = itAlive(t);
  if (!alive.length) return itFinish(t, "所有人都出局了，平手", [], !byLeave);
  const roles = new Set(alive.map(i => t.seats[i].role));
  if (roles.size > 1) return false;
  const r = [...roles][0];
  if (r === "mage") {   // 咒術師各自計算勝利（使用者 2026-11-11）：場上只剩咒術師不算陣營獲勝，繼續玩到有人達成自己的條件（或沒牌平手）；只剩 1 個人時沒人能傳情報，最後的倖存者獲勝
    if (alive.length > 1) return false;
    const s = t.seats[alive[0]];
    return itFinish(t, `${s.name} 是最後的倖存者，咒術師獲勝！`, [s], !byLeave);
  }
  const winners = t.seats.filter(s => s.role === r);
  return itFinish(t, `場上只剩${IT_ROLE[r]}，${IT_ROLE[r]}陣營獲勝！`, winners, !byLeave);
}
// 座位 i 的情報區變多了：先看有沒有人獲勝，再看有沒有人出局
function itCheckIntel(t, i, cause = -1) {   // cause＝「親手」使他獲得這封情報的人（傳遞者、轉移者、鎖定者、無人倖免的使用者），殺手／暗殺者／狙擊手用
  const s = t.seats[i], chars = !!t.g.chars;
  if (!chars && s.role === "mage" && itCount(s.intel, "K") >= IT_WIN) return itFinish(t, `${s.name} 是咒術師！集滿 ${IT_WIN} 封咒函，獲勝！`, [s], true);
  if (s.role === "sand" && itCount(s.intel, "Y") >= IT_WIN) return itDeclare(t, i, t.seats.filter(x => x.role === "sand"), `${s.name} 集滿 ${IT_WIN} 封黃色密函，沙都陣營獲勝！`);
  if (s.role === "water" && itCount(s.intel, "B") >= IT_WIN) return itDeclare(t, i, t.seats.filter(x => x.role === "water"), `${s.name} 集滿 ${IT_WIN} 封藍色密函，水都陣營獲勝！`);
  if ((chars || s.role !== "mage") && itCount(s.intel, "K") >= IT_DEATH && !s.out) {
    if (chars && s.immuneTurn && s.immuneTurn === t.g.turnNo) { tblLog(t, `${s.name}【篡奪者】死裡逃生：這回合收到咒函不會出局`); return itCharCheck(t, i); }
    itKill(t, i, cause);
    if (itCharCheck(t, i)) return true;   // 先結算勝利（含絕望者「第一個死亡」）再看場上陣營
    return itCheckFaction(t, false);
  }
  return chars ? itCharCheck(t, i) : false;
}
function itEndLetter(t, now) {   // 這次投遞結束：換下一位
  const nx = itNext(t, t.turn);
  if (nx < 0) { itCheckFaction(t, false); return; }
  itBeginTurn(t, nx, now);
}
// ---- 角色技能（第 1 階段，2026-11-11）：謹慎者、雙面間諜、牆頭草、收藏家、情報商（規格見 docs/intel-characters.md）----
// 角色技能預設不能被識破（只有「把 XX 卡當成 OO 卡使用」的偷天換日走行動牌、可被識破）。技能需要角色卡已翻開（s.faceUp）；公開型選完就翻開。
// 自動觸發（抽牌）直接生效；需要玩家決定的觸發用 g.prompt 暫停遊戲（itPrompt／itPromptDone），限時模式 15 秒逾時當作不用，不限時等玩家。
const itCharIs = (t, i, id) => !!(t.g && t.g.chars) && t.seats[i].char === id && !t.seats[i].left;
const itSkillReady = (t, i, id) => itCharIs(t, i, id) && !t.seats[i].out && !!t.seats[i].faceUp;
function itPrompt(t, now, p) { t.g.prompt = { ...p, until: t.g.untimed ? 0 : now + IT_HOLD_MS }; }
// 暫停結束後接著做原本的流程
function itCont(t, now, c) {
  if (!t.g || !c) return;
  if (c.kind === "recv") itRecv(t, now, c);
  else if (c.kind === "recvEnd") itRecvEnd(t, now, c.ack, c.at);
  else if (c.kind === "resolveEnd") itResolveEnd(t, now, c.by);
  else if (c.kind === "draw") itTurnResume(t, now, c.seat, c.alt);
}
// 收下情報的流程（可被暫停）：0 牆頭草「保命」→ 1 放進情報區＋自動技能（雙面、兩邊倒）→ 2 情報商「順水推舟」→ 3 結算勝利／出局 → 4 收藏家「搜刮／偽造遺囑」→ 收尾
function itReceive(t, now, ack = false) {
  const L = t.g.letter;
  itRecv(t, now, { kind: "recv", at: L.at, card: L.card, cause: L.cause ?? L.from, from: L.from, ack, stage: 0 });
}
function itRecv(t, now, r) {
  const g = t.g, s = t.seats[r.at], card = r.card, hasK = itHasK(card);
  if (r.stage === 0 && !r.layoutAsked) {   // 暗殺者「布局」：即將收下情報時，可以直接放進別人的情報區（親手＝暗殺者）
    r.layoutAsked = true;
    if (itSkillReady(t, r.at, "assassin") && itAlive(t).some(k => k !== r.at)) { itPrompt(t, now, { kind: "layout", seat: r.at, card, cont: r }); return; }
  }
  if (r.stage === 0 && !r.burnAsked) {   // 局外人「無關緊要」（一局一次）：一封情報將被你收下時（含鎖定、轉移、布局），改為燒掉
    r.burnAsked = true;
    if (itSkillReady(t, r.at, "outsider") && !s.onceUsed) { itPrompt(t, now, { kind: "burn", seat: r.at, card, cont: r }); return; }
  }
  if (r.stage === 0) {
    r.stage = 1;
    if (hasK && itSkillReady(t, r.at, "fencesitter") && !s.onceUsed && s.hand.length >= 2 && itBlack(s.intel) === 2) { itPrompt(t, now, { kind: "savelife", seat: r.at, cont: r }); return; }
  }
  if (r.stage === 1 && !r.subAsked) {   // 助人者「替死」（一局一次）：一位玩家將因這張咒函出局時，可改放進助人者的情報區
    r.subAsked = true;
    const h = hasK && itBlack(s.intel) >= IT_DEATH - 1 ? t.seats.findIndex((x, k) => k !== r.at && itSkillReady(t, k, "helper") && !x.onceUsed) : -1;
    if (h >= 0) { itPrompt(t, now, { kind: "sub", seat: h, victim: r.at, card, cont: r }); return; }
  }
  if (r.stage === 1) {
    r.stage = 2;
    s.intel.push(card); g.letter = null; g.arrive = null;
    if (hasK && s.immuneTurn && s.immuneTurn === g.turnNo) (s.immuneCards || (s.immuneCards = [])).push(card);   // 篡奪者「死裡逃生」：記下這回合收到的咒函
    tblLog(t, `${s.name} 收下了密函：${itLabel(card)}`);
    if (itSkillReady(t, r.at, "doubleagent") && itCols(card).length === 2) { itDraw(t, r.at, 1); tblLog(t, `${s.name}【雙面間諜】收下雙色情報，抽 1 張`); }
    if (itSkillReady(t, r.at, "fencesitter") && hasK) { itDraw(t, r.at, 1); tblLog(t, `${s.name}【牆頭草】收下含咒函的情報，抽 1 張`); }
    if (itSkillReady(t, r.at, "healer")) { itDraw(t, r.at, 1); tblLog(t, `${s.name}【解藥師】製藥：獲得情報，多抽 1 張`); }
    if (itSkillReady(t, r.at, "judge") && hasK) {   // 審判者「審判」：抽 2 張，等一下可以放 1 張咒函；將因此出局時「最終審判」（一局一次）再多一次
      r.judgeN = 1;
      if (itBlack(s.intel) >= IT_DEATH && !s.onceUsed) { r.judgeN = 2; s.onceUsed = true; tblLog(t, `${s.name}【審判者】最終審判：死前再審判一次`); }
      itDraw(t, r.at, 2 * r.judgeN); tblLog(t, `${s.name}【審判者】審判：獲得咒函，抽 ${2 * r.judgeN} 張`);
    }
    if (itSkillReady(t, r.at, "poisoner") && hasK) {   // 毒藥師「試毒」：抽 3 張，等一下選 1 張放回牌庫頂
      const got = [];
      for (let k = 0; k < 3; k++) { const c = itTop(t); if (c === undefined) break; s.hand.push(c); got.push(c); }
      if (got.length) { r.taste = got; tblLog(t, `${s.name}【毒藥師】試毒：獲得咒函，抽 ${got.length} 張`); }
    }
  }
  if (r.stage === 2) {
    if (r.taste) { const cards = r.taste; r.taste = null; itPrompt(t, now, { kind: "taste", seat: r.at, cards, cont: r }); return; }
    while (r.judgeN > 0) { r.judgeN -= 1; if (s.hand.some(itHasK)) { itPrompt(t, now, { kind: "judge", seat: r.at, cont: r }); return; } }
    const fr = r.from ?? -1;
    if (!r.markAsked) {   // 毒藥師「製毒」：一位玩家獲得毒藥師傳出的黃藍情報（含黃或含藍，使用者 2026-11-12 說明）時，毒藥師可在他面前再放 1 張咒函（從手牌）
      r.markAsked = true;
      if (/[YB]/.test(itCols(card)) && fr >= 0 && fr !== r.at && itSkillReady(t, fr, "poisoner") && t.seats[fr].hand.some(itHasK)) { itPrompt(t, now, { kind: "mark", seat: fr, tgt: r.at, cont: r }); return; }
    }
    if (!r.chaseAsked) {   // 殺手「追殺」：一位玩家獲得殺手傳出的咒函時，殺手抽 2 張，並可在他面前再放 1 張咒函（從手牌）
      r.chaseAsked = true;
      if (hasK && fr >= 0 && fr !== r.at && itSkillReady(t, fr, "killer")) {
        itDraw(t, fr, 2); tblLog(t, `${t.seats[fr].name}【殺手】追殺：${s.name} 獲得了他傳出的咒函，抽 2 張`);
        if (t.seats[fr].hand.some(itHasK)) { itPrompt(t, now, { kind: "chase", seat: fr, tgt: r.at, cont: r }); return; }
      }
    }
    r.stage = 3;
    if (hasK && itSkillReady(t, r.at, "broker") && t.seats.some((x, k) => k !== r.at && x.hand.length)) { itPrompt(t, now, { kind: "dig", seat: r.at, cont: r }); return; }
  }
  if (r.stage === 3) {
    r.stage = 4;
    if (itCheckIntel(t, r.at, r.cause)) return;   // 遊戲結束
  }
  if (r.stage === 4) {
    r.stage = 5;
    if ((g.lootQ.length || (g.dieQ || []).length) && itLootRun(t, now, { kind: "recvEnd", ack: r.ack, at: r.at })) return;
  }
  itRecvEnd(t, now, r.ack, r.at);
}
function itRecvEnd(t, now, ack, at) {
  const g = t.g;
  if (!g) return;
  if (ack && g.untimed) { g.step = "ack"; g.ack = { by: at, ok: [] }; itAckCheck(t, now); return; }   // 不限時模式：收下後要所有活人按「準備繼續」才換下一位
  itEndLetter(t, now);
}
// 行動生效後的收尾：角色卡勝利條件、收藏家搜刮、輪到的人沒牌
function itResolveEnd(t, now, by) {
  const g = t.g;
  if (!g) return;
  if (g.chars && itCharCheck(t, by)) return;
  if ((g.lootQ.length || (g.dieQ || []).length) && itLootRun(t, now, { kind: "resolveEnd", by })) return;
  itNoHand(t, now);
}
// 有人出局後：場上有收藏家就讓他選要不要搜刮（死者的手牌先留著）；沒有就把手牌丟進棄牌堆。回傳 true＝開了暫停
function itLootRun(t, now, cont) {
  const g = t.g;
  while (g.lootQ.length) {
    const vi = g.lootQ.shift(), v = t.seats[vi], ci = t.seats.findIndex((x, k) => k !== vi && itSkillReady(t, k, "collector"));
    if (ci < 0 || (!v.hand.length && !v.intel.length)) { g.discard.push(...v.hand); v.hand = []; continue; }
    itPrompt(t, now, { kind: "loot", seat: ci, victim: vi, cont });
    return true;
  }
  while ((g.dieQ || []).length) {   // 出局者自己的技能：遺言（看一人的手牌拿走 2 張丟棄）、殉道（洗白任一玩家的一張咒函）
    const q = g.dieQ.shift(), v = t.seats[q.seat];
    if (v.left) continue;
    if (q.kind === "will" && t.seats.some((x, k) => k !== q.seat && itOk(t, k) && x.hand.length)) { itPrompt(t, now, { kind: "will", seat: q.seat, cont }); return true; }
    if (q.kind === "martyr" && t.seats.some((x, k) => itOk(t, k) && itBlack(x.intel) > 0)) { itPrompt(t, now, { kind: "martyr", seat: q.seat, cont }); return true; }
    if (q.kind === "profit" && itSkillReady(t, q.seat, "fisher") && v.hand.some(itHasK) && itAlive(t).some(k => k !== q.victim)) { itPrompt(t, now, { kind: "profit", seat: q.seat, victim: q.victim, cont }); return true; }
  }
  return false;
}
// 從自己手牌放一張咒函到某人的情報區（審判、製毒、追殺、劇毒）：放完照常結算勝利／出局（親手＝放的人）。回傳 true＝遊戲結束
function itPlaceBlack(t, from, to, card, label) {
  const s = t.seats[from], o = t.seats[to], k = s.hand.indexOf(card);
  if (k < 0) return false;
  s.hand.splice(k, 1); o.intel.push(card);
  tblLog(t, `${s.name}【${IT_CHARS[s.char][0]}】${label}：在 ${o.name} 的情報區放了一張咒函（${itLabel(card)}）`);
  return !!itCheckIntel(t, to, from);
}
// 暫停中給這位玩家看的資料（只給 p.seat）
function itPromptData(t, p) {
  if (p.kind === "savelife") return { card: p.cont.card };
  if (p.kind === "dig") return { hands: t.seats.map((x, k) => (k === p.seat ? [] : [...x.hand])) };
  if (p.kind === "merge") return { tgt: p.tgt, hand: [...t.seats[p.tgt].hand] };
  if (p.kind === "loot") return { victim: p.victim, hand: [...t.seats[p.victim].hand], intel: [...t.seats[p.victim].intel], will: !t.seats[p.seat].onceUsed };
  if (p.kind === "taste") return { cards: [...p.cards] };
  if (p.kind === "mark" || p.kind === "chase" || p.kind === "venom") return { tgt: p.tgt };
  if (p.kind === "layout" || p.kind === "burn") return { card: p.card };
  if (p.kind === "rescue") return { cands: t.seats.map((x, k) => k).filter(k => !p.win.includes(k) && !t.seats[k].left) };
  if (p.kind === "profit") return { victim: p.victim };
  if (p.kind === "sub") return { victim: p.victim, card: p.card };
  if (p.kind === "will2") return { tgt: p.tgt, hand: [...t.seats[p.tgt].hand] };
  if (p.kind === "martyr") return { intels: t.seats.map((x, k) => (itOk(t, k) ? x.intel.map((c, j) => (itHasK(c) ? j : -1)).filter(j => j >= 0) : [])) };
  if (p.kind === "scheme") return { intels: t.seats.map((x, k) => (itOk(t, k) ? x.intel.map((c, j) => (itHasK(c) ? j : -1)).filter(j => j >= 0) : [])) };
  return {};
}
// 玩家回答（ans＝null：不用／逾時）。答案不合法就回 false、暫停繼續；成功回 true
function itPromptDone(t, ans, now) {
  const g = t.g, p = g.prompt;
  if (!p) return false;
  const s = t.seats[p.seat], okIdx = (k, arr) => Number.isInteger(k) && k >= 0 && k < arr.length;
  if (p.kind === "savelife") {   // 牆頭草「保命」：將收下第 3 張咒函時，棄 2 張手牌，改為燒掉該情報
    if (ans && ans.yes) {
      const hi = Array.isArray(ans.idx) ? [...new Set(ans.idx)] : [];
      if (hi.length !== 2 || !hi.every(k => okIdx(k, s.hand))) return false;
      g.prompt = null;
      hi.sort((a, b) => b - a).forEach(k => g.discard.push(s.hand.splice(k, 1)[0]));
      s.onceUsed = true; g.discard.push(p.cont.card); g.letter = null; g.arrive = null;
      tblLog(t, `${s.name}【牆頭草】發動保命：棄 2 張手牌，把第 3 張咒函燒掉了（${itLabel(p.cont.card)}）`);
      itEndLetter(t, now);
      return true;
    }
    g.prompt = null; itCont(t, now, p.cont); return true;
  }
  if (p.kind === "dig") {   // 情報商「順水推舟」：檢視任一玩家的手牌，選 1 張當自己的手牌
    if (ans && ans.tgt !== undefined) {
      const o = t.seats[ans.tgt];
      if (!o || ans.tgt === p.seat || !okIdx(ans.idx, o.hand)) return false;
      g.prompt = null;
      s.hand.push(o.hand.splice(ans.idx, 1)[0]);
      tblLog(t, `${s.name}【情報商】順水推舟：從 ${o.name} 手上拿了一張牌`);
      itCont(t, now, p.cont); return true;
    }
    g.prompt = null; itCont(t, now, p.cont); return true;
  }
  if (p.kind === "merge") {   // 情報商「併購」：看他的全部手牌，拿走 1 張，再給他自己的 1 張
    if (ans && ans.take !== undefined) {
      const o = t.seats[p.tgt];
      if (!itOk(t, p.tgt) || !okIdx(ans.take, o.hand) || !okIdx(ans.give, s.hand)) return false;
      g.prompt = null;
      const a = o.hand.splice(ans.take, 1)[0], b = s.hand.splice(ans.give, 1)[0];
      s.hand.push(a); o.hand.push(b); s.onceUsed = true;
      tblLog(t, `${s.name}【情報商】併購了 ${o.name}：拿走他的一張牌，再給他一張`);
      if (itCharCheck(t, p.seat)) return true;
      itNoHand(t, now); return true;
    }
    g.prompt = null; return true;
  }
  if (p.kind === "loot") {   // 收藏家：搜刮（選死者 1 張手牌當自己的手牌或放進自己的情報區）／偽造遺囑（一局一次：死者的情報全部納為手牌）
    const v = t.seats[p.victim];
    let take = -1, dest = "hand", will = false;
    if (ans) {
      take = ans.take === undefined || ans.take === null ? -1 : ans.take; dest = ans.dest === "intel" ? "intel" : "hand"; will = !!ans.will;
      if ((take !== -1 && !okIdx(take, v.hand)) || (will && s.onceUsed)) return false;
    }
    g.prompt = null;
    if (will) { s.hand.push(...v.intel); tblLog(t, `${s.name}【收藏家】偽造遺囑：把 ${v.name} 情報區的 ${v.intel.length} 張情報納為手牌`); v.intel = []; s.onceUsed = true; }
    let ended = false;
    if (take !== -1) {
      const c = v.hand.splice(take, 1)[0];
      if (dest === "intel") { s.intel.push(c); tblLog(t, `${s.name}【收藏家】搜刮：把 ${v.name} 的一張牌放進自己的情報區（${itLabel(c)}）`); ended = !!itCheckIntel(t, p.seat, -1); }
      else { s.hand.push(c); tblLog(t, `${s.name}【收藏家】搜刮：拿走 ${v.name} 的一張手牌`); }
    }
    if (!t.g || ended) return true;
    g.discard.push(...v.hand); v.hand = [];   // 死者剩下的手牌丟掉
    if (!itLootRun(t, now, p.cont)) itCont(t, now, p.cont);
    return true;
  }
  if (p.kind === "layout") {   // 暗殺者「布局」：把這封情報直接放進別人的情報區（不用＝自己照常收下）
    if (ans && ans.tgt !== undefined) {
      if (!itOk(t, ans.tgt) || ans.tgt === p.seat) return false;
      g.prompt = null;
      tblLog(t, `${s.name}【暗殺者】布局：把情報直接放進 ${t.seats[ans.tgt].name} 的情報區`);
      const r = p.cont; r.at = ans.tgt; r.cause = p.seat; r.stage = 0;   // 換成對方收下（照常走他的保命／替死／自動技能、結算），親手＝暗殺者
      itCont(t, now, r); return true;
    }
    g.prompt = null; itCont(t, now, p.cont); return true;
  }
  if (p.kind === "profit") {   // 漁翁「得利」：在另一位玩家（不是出局的那位）面前放最多 2 張咒函（從手牌）
    if (ans && ans.tgt !== undefined && Array.isArray(ans.idx) && ans.idx.length) {
      const hi = [...new Set(ans.idx)];
      if (ans.tgt === p.victim || !itOk(t, ans.tgt) || hi.length > 2 || !hi.every(k => okIdx(k, s.hand) && itHasK(s.hand[k]))) return false;
      g.prompt = null;
      for (const c of hi.map(k => s.hand[k])) { if (itPlaceBlack(t, p.seat, ans.tgt, c, "得利")) return true; if (!itOk(t, ans.tgt)) break; }
      if (!t.g) return true;
    } else g.prompt = null;
    if (!itLootRun(t, now, p.cont)) itCont(t, now, p.cont);
    return true;
  }
  if (p.kind === "judge" || p.kind === "mark" || p.kind === "chase") {   // 放 1 張咒函（審判：任一活人；製毒／追殺：獲得情報的那位）。不用＝不放
    if (ans && ans.idx !== undefined) {
      const tg = p.kind === "judge" ? ans.tgt : p.tgt;
      if (!okIdx(ans.idx, s.hand) || !itHasK(s.hand[ans.idx]) || !itOk(t, tg)) return false;
      g.prompt = null;
      if (itPlaceBlack(t, p.seat, tg, s.hand[ans.idx], { judge: "審判", mark: "製毒", chase: "追殺" }[p.kind])) return true;
      if (!t.g) return true;
    } else g.prompt = null;
    itCont(t, now, p.cont); return true;
  }
  if (p.kind === "venom") {   // 毒藥師「劇毒」（一局一次）：識破了你的查驗的人，在他面前放最多 2 張咒函（從手牌）
    if (ans && Array.isArray(ans.idx) && ans.idx.length) {
      const hi = [...new Set(ans.idx)];
      if (hi.length > 2 || !hi.every(k => okIdx(k, s.hand) && itHasK(s.hand[k])) || !itOk(t, p.tgt)) return false;
      g.prompt = null; s.onceUsed = true;
      const cards = hi.map(k => s.hand[k]);
      for (const c of cards) { if (itPlaceBlack(t, p.seat, p.tgt, c, "劇毒")) return true; if (!itOk(t, p.tgt)) break; }
      if (!t.g) return true;
    } else g.prompt = null;
    itCont(t, now, p.cont); return true;
  }
  if (p.kind === "burn") {   // 局外人「無關緊要」（一局一次）：改為燒掉這封情報
    g.prompt = null;
    if (ans && ans.yes) {
      s.onceUsed = true; g.discard.push(p.cont.card); g.letter = null; g.arrive = null;
      tblLog(t, `${s.name}【局外人】無關緊要：把要收下的情報燒掉了（${itLabel(p.cont.card)}）`);
      itEndLetter(t, now); return true;
    }
    itCont(t, now, p.cont); return true;
  }
  if (p.kind === "rescue") {   // 調和者「救助」：獲勝時，指定一位玩家一同勝利
    let extra = -1;
    if (ans && ans.tgt !== undefined) { if (!Number.isInteger(ans.tgt) || p.win.includes(ans.tgt) || !t.seats[ans.tgt] || t.seats[ans.tgt].left) return false; extra = ans.tgt; }
    g.prompt = null;
    const ws = p.win.map(k => t.seats[k]);
    if (extra >= 0) ws.push(t.seats[extra]);
    itFinish(t, p.text + (extra >= 0 ? `　${s.name}【調和者】救助：${t.seats[extra].name} 一起獲勝` : ""), ws, true);
    return true;
  }
  if (p.kind === "sub") {   // 助人者「替死」（一局一次）：改把這張咒函放進自己的情報區
    g.prompt = null;
    if (ans && ans.yes) { s.onceUsed = true; tblLog(t, `${s.name}【助人者】替死：把要讓 ${t.seats[p.victim].name} 出局的咒函收進自己的情報區`); p.cont.at = p.seat; }
    itCont(t, now, p.cont); return true;
  }
  if (p.kind === "will") {   // 絕望者「遺言」（一局一次，出局時）：先指定一位玩家
    if (ans && ans.tgt !== undefined) {
      if (ans.tgt === p.seat || !itOk(t, ans.tgt) || !t.seats[ans.tgt].hand.length) return false;
      s.onceUsed = true;
      g.prompt = null; itPrompt(t, now, { kind: "will2", seat: p.seat, tgt: ans.tgt, cont: p.cont });
      tblLog(t, `${s.name}【絕望者】遺言：檢視 ${t.seats[ans.tgt].name} 的手牌`);
      return true;
    }
    g.prompt = null;
    if (!itLootRun(t, now, p.cont)) itCont(t, now, p.cont);
    return true;
  }
  if (p.kind === "will2") {   // 遺言：拿走他 2 張手牌，丟進棄牌堆（不選／逾時＝拿走前 2 張）
    const o = t.seats[p.tgt], need = Math.min(2, o.hand.length);
    let hi = ans && Array.isArray(ans.idx) ? [...new Set(ans.idx)] : [...Array(need).keys()];
    if (hi.length !== need || !hi.every(k => okIdx(k, o.hand))) return false;
    g.prompt = null;
    hi.sort((a, b) => b - a).forEach(k => g.discard.push(o.hand.splice(k, 1)[0]));
    tblLog(t, `${s.name}【絕望者】遺言：拿走 ${o.name} 的 ${need} 張手牌丟進棄牌堆`);
    if (!itLootRun(t, now, p.cont)) itCont(t, now, p.cont);
    return true;
  }
  if (p.kind === "martyr") {   // 助人者「殉道」（出局時）：洗白任一活人情報區的一張咒函（不需要洗白牌）
    if (ans && ans.tgt !== undefined) {
      const o = t.seats[ans.tgt];
      if (!itOk(t, ans.tgt) || !okIdx(ans.idx, o.intel) || !itHasK(o.intel[ans.idx])) return false;
      g.prompt = null;
      const c = o.intel.splice(ans.idx, 1)[0]; g.discard.push(c);
      if (!s.washedFor.includes(ans.tgt)) s.washedFor.push(ans.tgt);
      tblLog(t, `${s.name}【助人者】殉道：洗白了 ${o.name} 情報區的一封咒函（${itLabel(c)}）`);
      if (itCharCheck(t, ans.tgt)) return true;
    } else g.prompt = null;
    if (!itLootRun(t, now, p.cont)) itCont(t, now, p.cont);
    return true;
  }
  if (p.kind === "taste") {   // 毒藥師「試毒」：剛抽的 3 張選 1 張放回牌庫頂（不選／逾時＝放回第一張）
    const k = ans && Number.isInteger(ans.idx) ? ans.idx : 0;
    if (k < 0 || k >= p.cards.length) return false;
    g.prompt = null;
    const at = s.hand.lastIndexOf(p.cards[k]);
    if (at >= 0) { g.deck.push(s.hand.splice(at, 1)[0]); tblLog(t, `${s.name}【毒藥師】試毒：選了 1 張放回牌庫頂`); }
    itCont(t, now, p.cont); return true;
  }
  if (p.kind === "scheme") {   // 暗殺者「暗計」：放棄抽牌，把任一玩家情報區的一張咒函加入自己的手牌（不用／逾時＝照常抽牌）
    if (ans && ans.tgt !== undefined) {
      const o = t.seats[ans.tgt];
      if (!itOk(t, ans.tgt) || !okIdx(ans.idx, o.intel) || !itHasK(o.intel[ans.idx])) return false;
      g.prompt = null;
      const c = o.intel.splice(ans.idx, 1)[0]; s.hand.push(c);
      tblLog(t, `${s.name}【暗殺者】暗計：放棄抽牌，把 ${o.name} 情報區的一封咒函（${itLabel(c)}）拿進手牌`);
      itTurnResume(t, now, p.seat, true); return true;
    }
    g.prompt = null; itCont(t, now, p.cont); return true;
  }
  if (p.kind === "gather") {   // 咒函蒐集者「採集」：改為翻開牌堆頂 3 張，純黑的全拿，其餘放到牌堆底（不用／逾時＝照常抽牌）
    if (ans && ans.yes) {
      g.prompt = null;
      const got = [], rest = [];
      for (let k = 0; k < 3; k++) { const c = itTop(t); if (c === undefined) break; (itPureBlack(c) ? got : rest).push(c); }
      s.hand.push(...got); g.deck.unshift(...rest);
      tblLog(t, `${s.name}【咒函蒐集者】採集：翻開牌堆頂 ${got.length + rest.length} 張（${[...got, ...rest].map(itLabel).join("、") || "沒有牌"}），拿走 ${got.length} 張純黑，其餘放到牌堆底`);
      itTurnResume(t, now, p.seat, true); return true;
    }
    g.prompt = null; itCont(t, now, p.cont); return true;
  }
  g.prompt = null;
  return true;
}
// 避險／調節：棄 2 張手牌，洗白自己情報區的一張咒函
function itWashOwn(t, i, msg, now, label) {
  const g = t.g, s = t.seats[i], hi = Array.isArray(msg.hand) ? [...new Set(msg.hand)] : [], k = msg.intel;
  if (hi.length !== 2 || !hi.every(x => Number.isInteger(x) && x >= 0 && x < s.hand.length) || !Number.isInteger(k) || k < 0 || k >= s.intel.length || !itHasK(s.intel[k])) return;
  const c = s.intel.splice(k, 1)[0];
  hi.sort((a, b) => b - a).forEach(x => g.discard.push(s.hand.splice(x, 1)[0])); g.discard.push(c);
  if (!s.washedFor.includes(i)) s.washedFor.push(i);
  tblLog(t, `${s.name}【${IT_CHARS[s.char][0]}】${label}：棄 2 張手牌，洗白了自己情報區的一封咒函（${itLabel(c)}）`);
  if (itCharCheck(t, i)) return;
  itNoHand(t, now);
}
// 主動技能：k＝技能編號（0／1 不限次數，2 一局一次）
function itSkill(t, i, msg, now) {
  const g = t.g, s = t.seats[i], k = msg.k, L = g.letter;
  const flipK = ((s.char === "healer" || s.char === "fisher") && k === 0) || (s.char === "usurper" && k === 1);   // 求知慾、埋伏、轉機   // 求知慾、埋伏：「公開角色牌」的技能＝只有覆蓋中能用（用了就翻開；使用者 2026-11-12 定）
  if (flipK && s.faceUp) return;
  if (!g.chars || !s.char || s.out || s.left || (!s.faceUp && !flipK) || g.ask || g.prompt || g.step === "pick") return;
  const idle = !g.pend, mine = g.step === "turn" && t.turn === i && !L;
  if (s.char === "cautious") {
    if (k === 0) {   // 審慎：蓋著的密函傳到你手上時，可偷看內容（不算使用行動牌）
      if (!idle || g.step !== "pass" || !L || L.at !== i || L.kind === "pub" || L.open) return;
      s.note = { k: "peek", card: L.card };
      tblLog(t, `${s.name}【謹慎者】審慎：偷看了手上的密函`);
    } else if (k === 1) { if (idle) itWashOwn(t, i, msg, now, "避險"); }   // 避險：棄 2 張手牌，洗白自己情報區的一張咒函
    else if (k === 2) {   // 絕對謹慎（一局一次）：被鎖定或被轉移選為對象時，取消該效果，情報照一般流程處理（在識破時間內使用）
      if (!g.pend || s.onceUsed) return;
      let r = g.pend; while (r.under) r = r.under;
      if ((r.a !== "F" && r.a !== "T") || r.tgt !== i) return;
      r.void = true; s.onceUsed = true;
      tblLog(t, `${s.name}【謹慎者】絕對謹慎：取消了對自己的${IT_ACT[r.a]}`);
    }
  } else if (s.char === "doubleagent") {
    if (k === 2 && idle && !s.onceUsed) {   // 雙面人生（一局一次）：從牌堆中找一張雙色牌加入手牌，然後洗牌
      const at = g.deck.indexOf(msg.c);
      if (at < 0 || itCols(msg.c).length !== 2) return;
      s.hand.push(g.deck.splice(at, 1)[0]); g.deck = shuffle(g.deck); s.onceUsed = true;
      tblLog(t, `${s.name}【雙面間諜】雙面人生：從牌堆找了一張雙色牌加入手牌，牌堆重洗`);
    }
  } else if (s.char === "fencesitter") {
    if (k === 1 && idle && mine) itWashOwn(t, i, msg, now, "調節");   // 調節：自己回合、投遞前，棄 2 張手牌，洗白自己情報區的一張咒函
  } else if (s.char === "healer") {
    if (k === 0) {   // 求知慾：他人回合的情報傳遞階段，公開角色牌並視為使用了攔截（技能，不能被識破）
      if (!idle || g.step !== "pass" || !L || t.turn === i || L.at === i || L.from === i) return;
      itFlip(t, i);
      tblLog(t, `${s.name}【解藥師】求知慾：視為使用了攔截`);
      itApply(t, { a: "I", by: i }, now);
    } else if (k === 2 && idle && !s.onceUsed && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt)) {   // 公開（一局一次）：暴露自己的陣營，並指定一人也暴露陣營
      const o = t.seats[msg.tgt];
      s.exposed = true; o.exposed = true; s.onceUsed = true;
      tblLog(t, `${s.name}【解藥師】公開：${s.name} 是${IT_ROLE[s.role]}，${o.name} 是${IT_ROLE[o.role]}`);
    }
  } else if (s.char === "fisher") {
    if (k === 0) {   // 埋伏：情報傳遞階段，公開角色牌，把一位其他玩家情報區的 1 張情報放回牌庫頂
      const o = t.seats[msg.tgt];
      if (!idle || g.step !== "pass" || !L || !Number.isInteger(msg.tgt) || msg.tgt === i || !itOk(t, msg.tgt) || !Number.isInteger(msg.intel) || msg.intel < 0 || msg.intel >= o.intel.length) return;
      itFlip(t, i);
      const c = o.intel.splice(msg.intel, 1)[0]; g.deck.push(c);
      tblLog(t, `${s.name}【漁翁】埋伏：把 ${o.name} 情報區的一張情報（${itLabel(c)}）放回牌庫頂`);
      itCharCheck(t, i);
    } else if (k === 2 && idle && !s.onceUsed && t.turn !== i && (g.step === "turn" || g.step === "pass") && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt) && !itLocked(g, msg.tgt)) {   // 灑網（一局一次）：在別人的回合指定一人被鎖定
      s.onceUsed = true;
      tblLog(t, `${s.name}【漁翁】灑網`);
      itLockApply(t, i, msg.tgt, now);
    }
  } else if (s.char === "assassin") {
    const tg = Array.isArray(msg.tgts) ? [...new Set(msg.tgts)] : [];
    if (k === 2 && idle && !s.onceUsed && g.step === "pass" && L && tg.length && tg.every(x => itOk(t, x))) {   // 煙霧彈（一局一次）：情報傳遞階段，指定任意數量的玩家被阻擋
      s.onceUsed = true;
      for (const x of tg) if (!itBlocked(g, x)) g.blocked.push(x);
      tblLog(t, `${s.name}【暗殺者】煙霧彈：${tg.map(x => t.seats[x].name).join("、")} 本回不能收下情報`);
    }
  } else if (s.char === "desperate") {
    const hi = Array.isArray(msg.hand) ? [...new Set(msg.hand)] : [], o = t.seats[msg.tgt];
    if (k === 1 && idle && hi.length === 4 && hi.every(x => Number.isInteger(x) && x >= 0 && x < s.hand.length) && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt) && Number.isInteger(msg.intel) && msg.intel >= 0 && msg.intel < o.intel.length) {   // 交易：4 張手牌交給他，拿走他情報區的一張情報（放進自己手牌）
      const give = hi.sort((a, b) => b - a).map(x => s.hand.splice(x, 1)[0]);
      o.hand.push(...give);
      const c = o.intel.splice(msg.intel, 1)[0]; s.hand.push(c);
      tblLog(t, `${s.name}【絕望者】交易：把 4 張手牌交給 ${o.name}，拿走他情報區的一張情報（${itLabel(c)}）`);
      if (itCharCheck(t, i)) return;
      itNoHand(t, now);
    }
  } else if (s.char === "judge") {
    if (k === 0 && idle && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt) && itBlack(t.seats[msg.tgt].intel) >= 2) {   // 旁聽：情報區有 2 張以上咒函的玩家，檢視他的手牌
      const o = t.seats[msg.tgt];
      s.note = { k: "view", tgt: o.name, cards: [...o.hand] };
      tblLog(t, `${s.name}【審判者】旁聽：檢視了 ${o.name} 的手牌`);
    }
  } else if (s.char === "sniper") {
    const tg = Array.isArray(msg.tgts) ? [...new Set(msg.tgts)] : [];
    if (k === 1 && idle && mine && s.shotTurn !== g.turnNo && tg.length && tg.every(x => x !== i && itOk(t, x))) {   // 亂槍打鳥（自己回合開始時，每回合一次）：指定任意數量的玩家被鎖定
      s.shotTurn = g.turnNo;
      for (const x of tg) if (!itLocked(g, x)) (g.locked || (g.locked = [])).push(x);
      tblLog(t, `${s.name}【狙擊手】亂槍打鳥：${tg.map(x => t.seats[x].name).join("、")} 本回情報到他手上就必須收下`);
      return;
    }
    if (k === 0 && idle && mine && s.aimTurn !== g.turnNo && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt)) {   // 瞄準（自己回合、投遞前，每回合一次）：手牌最多（或之一）的玩家，偷看他 1 張隨機手牌
      const o = t.seats[msg.tgt], most = Math.max(...itAlive(t).filter(j => j !== i).map(j => t.seats[j].hand.length));
      if (!o.hand.length || o.hand.length !== most) return;
      s.aimTurn = g.turnNo;
      s.note = { k: "aim", tgt: o.name, card: o.hand[Math.floor(Math.random() * o.hand.length)] };
      tblLog(t, `${s.name}【狙擊手】瞄準：偷看了 ${o.name} 的一張手牌`);
    }
  } else if (s.char === "blackcollector") {
    if (k === 2 && idle && !s.onceUsed && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt)) {   // 搶購（一局一次）：拿走他所有純黑手牌，再從牌堆頂給他等量的牌
      const o = t.seats[msg.tgt], got = o.hand.filter(itPureBlack);
      o.hand = o.hand.filter(c => !itPureBlack(c)); s.hand.push(...got); s.onceUsed = true;
      let n = 0; for (; n < got.length; n++) { const c = itTop(t); if (c === undefined) break; o.hand.push(c); }
      tblLog(t, `${s.name}【咒函蒐集者】搶購：拿走 ${o.name} 的 ${got.length} 張純黑手牌，再從牌堆頂補給他 ${n} 張`);
      if (itCharCheck(t, i)) return;
      itNoHand(t, now);
    }
  } else if (s.char === "outsider") {
    if (k === 1 && idle && mine) {   // 撇清：自己回合、投遞前，棄 2 張手牌，丟棄自己情報區的一張非咒函
      const hi = Array.isArray(msg.hand) ? [...new Set(msg.hand)] : [], q = msg.intel;
      if (hi.length !== 2 || !hi.every(x => Number.isInteger(x) && x >= 0 && x < s.hand.length) || !Number.isInteger(q) || q < 0 || q >= s.intel.length || itHasK(s.intel[q])) return;
      const c = s.intel.splice(q, 1)[0];
      hi.sort((a, b) => b - a).forEach(x => g.discard.push(s.hand.splice(x, 1)[0])); g.discard.push(c);
      tblLog(t, `${s.name}【局外人】撇清：棄 2 張手牌，丟棄了自己情報區的一張情報（${itLabel(c)}）`);
      if (itCharCheck(t, i)) return;
      itNoHand(t, now);
    }
  } else if (s.char === "usurper") {
    if (k === 0 && idle && g.step === "pass" && L && s.faceUp && Number.isInteger(msg.tgt) && itOk(t, msg.tgt) && !itBlocked(g, msg.tgt)) {   // 妨礙：情報傳遞階段，覆蓋角色卡並指定一位玩家被阻擋（可以再翻開：轉機）
      s.faceUp = false; g.blocked.push(msg.tgt);
      tblLog(t, `${s.name}【篡奪者】妨礙：覆蓋了角色卡，${t.seats[msg.tgt].name} 本回不能收下情報`);
    } else if (k === 1 && idle && !s.faceUp && !s.hand.length) {   // 轉機：沒有手牌時，翻開角色卡並抽 2 張牌
      itFlip(t, i); itDraw(t, i, 2);
      tblLog(t, `${s.name}【篡奪者】轉機：沒有手牌，翻開角色卡並抽 2 張`);
      if (itCharCheck(t, i)) return;
    } else if (k === 2 && idle && !s.onceUsed && !(s.immuneTurn && s.immuneTurn === g.turnNo)) {   // 死裡逃生（一局一次）：這回合收到咒函不會出局，回合結束時洗白這回合收到的咒函
      s.onceUsed = true; s.immuneTurn = g.turnNo; s.immuneCards = [];
      tblLog(t, `${s.name}【篡奪者】死裡逃生：這回合收到咒函不會出局，回合結束時洗白這回合收到的咒函`);
    }
  } else if (s.char === "broker") {
    if (k === 2 && idle && !s.onceUsed && Number.isInteger(msg.tgt) && msg.tgt !== i && itOk(t, msg.tgt) && t.seats[msg.tgt].hand.length && s.hand.length) {   // 併購（一局一次）：先看他的全部手牌
      itPrompt(t, now, { kind: "merge", seat: i, tgt: msg.tgt, cont: null });
    }
  }
}
// 不限時：情報每次「到達」一個人手上（投遞、傳給下一位、被攔截、退回發信者）都先確認：所有活人（持有者自動算）按「準備繼續」，
// 持有者才能決定收下／傳走；期間其他人可以出押送／攔截／焚信（出牌後確認重來），攔截或傳走後在新持有者手上再確認一次
const itArrive = g => { if (g.untimed) g.arrive = { ok: [] }; };
function itArriveCheck(t, now) {
  const g = t.g, L = g && g.letter;
  if (!g || !g.arrive || !L) return;
  if (itAlive(t).every(i => i === L.at || g.arrive.ok.includes(i))) g.arrive = null;
}
// 不限時：收下情報後的確認（所有活人，收下的人自動算）都按了才換下一位
function itAckCheck(t, now) {
  const g = t.g, a = g && g.ack;
  if (!a || g.step !== "ack") return;
  if (itAlive(t).every(i => i === a.by || a.ok.includes(i))) { g.ack = null; itEndLetter(t, now); }
}
// 行動生效：chain 由上（最後出的）往下，識破（C）會取消它底下那一張，被取消的識破就不會取消底下的（識破可以被識破）；最底下是真正的行動
function itResolve(t, now) {
  const g = t.g;
  let p = g.pend, act = true, lastC = -1;
  g.pend = null;
  if (!g.untimed) g.deadline = Math.max(g.deadline, now + 5000);   // 生效後至少留 5 秒給拿著密函／輪到的人反應
  while (p) {
    if (p.a === "C") { act = !act; lastC = p.by; p = p.under; continue; }   // lastC：最後處理到的識破＝緊貼在行動上面那張（行動被取消時，就是他識破的）
    if (act) itApply(t, p, now);
    else {
      tblLog(t, `${t.seats[p.by].name} 的${IT_ACT[p.a]}被識破，沒有生效`);
      const pz = t.seats[p.by];   // 毒藥師「劇毒」（一局一次）：查驗被識破時，可在識破的人面前放最多 2 張咒函
      if (p.a === "V" && lastC >= 0 && lastC !== p.by && itSkillReady(t, p.by, "poisoner") && !pz.onceUsed && itOk(t, lastC) && pz.hand.some(itHasK)) { itPrompt(t, now, { kind: "venom", seat: p.by, tgt: lastC, cont: { kind: "resolveEnd", by: p.by } }); return; }
    }
    itResolveEnd(t, now, p.by);   // 行動可能改變手牌／情報區（竊取、補給、洗白…）：檢查角色卡勝利條件、收藏家搜刮、沒牌跳過
    return;
  }
}
// 輪到的人把最後一張牌當行動用掉、手上沒牌可以投遞：直接換下一位（限時模式靠逾時，不限時模式沒有逾時，一定要在這裡處理）
function itNoHand(t, now) {
  const g = t.g;
  if (!g || t.phase !== "playing" || g.step !== "turn" || g.pend || g.ask || g.letter || t.seats[t.turn].hand.length) return;
  tblLog(t, `${t.seats[t.turn].name} 沒有牌可以投遞，跳過`);
  itEndLetter(t, now);
}
function itApply(t, p, now) {
  const g = t.g, by = t.seats[p.by];
  if (p.void) { tblLog(t, `${by.name} 的${IT_ACT[p.a]}被取消了，情報照一般流程處理`); return; }   // 謹慎者「絕對謹慎」
  if (p.a === "P" && g.letter && g.letter.kind !== "pub" && !g.letter.open) {
    if (p.col) {   // 宣告了顏色：一定公開；猜對（雙色只要包含）就抽 1 張，猜錯只是不能抽（2026-11-11 使用者定）
      const L = g.letter, hit = itCols(L.card).includes(p.col);
      L.open = true;
      tblLog(t, `${by.name} 宣告${IT_CNAME[p.col]}色並公開了密函：${itLabel(L.card)}，${hit ? "猜對了，抽 1 張" : "猜錯了"}`);
      if (hit) { itDraw(t, p.by, 1); if (itSkillReady(t, p.by, "collector")) { itDraw(t, p.by, 1); tblLog(t, `${by.name}【收藏家】鑑識：宣告成功，額外抽 1 張`); } }
    } else { by.note = { k: "peek", card: g.letter.card }; tblLog(t, `${by.name} 截閱了密函`); }
  }
  else if (p.a === "S" && g.letter && g.letter.kind !== "pub" && !g.letter.open) {   // 調包：換上去的牌公開（所有人看得到），被換掉的牌棄掉
    const k = by.hand.indexOf(p.sel);
    if (k < 0) return;
    by.hand.splice(k, 1); g.discard.push(g.letter.card); g.letter.card = p.sel; g.letter.open = true;
    tblLog(t, `${by.name} 調包了密函：換上 ${itLabel(p.sel)}（公開），原本的牌被丟棄`);
  } else if (p.a === "F" && itOk(t, p.tgt)) itLockApply(t, p.by, p.tgt, now);   // 鎖定：他正拿著情報就立刻收下；還沒拿到就標記，情報到他手上時只能收下
  else if (p.a === "X" && g.letter) { g.discard.push(g.letter.card); g.letter = null; tblLog(t, `${by.name} 燒掉了密函`); itEndLetter(t, now); }
  else if (p.a === "I" && g.letter && g.step === "pass" && g.letter.at !== p.by && g.letter.from !== p.by && itOk(t, p.by)) {
    const L = g.letter, was = t.seats[L.at].name;
    L.at = p.by; L.icpt = p.by; if (!L.seen.includes(p.by)) L.seen.push(p.by);
    g.deadline = itDl(g, now, IT_HOLD_MS); itArrive(g);
    tblLog(t, `${by.name} 從 ${was} 手上攔截了${IT_KIND[L.kind]}`);
  } else if (p.a === "H" && itOk(t, p.tgt) && !itColdEye(t, p.tgt)) {
    const th = t.seats[p.tgt], cards = shuffle(itHideBlack(t, p.tgt)).slice(0, 2);
    by.note = { k: "search", tgt: th.name, cards };
    tblLog(t, `${by.name} 搜了 ${th.name} 的身`);
  } else if (p.a === "D" && g.step === "turn" && t.turn === p.by && !g.letter) {   // 補給：自己的回合抽 2 張
    itDraw(t, p.by, 2);
    tblLog(t, `${by.name} 補給，抽了 2 張`);
  } else if (p.a === "R" && g.step === "turn" && t.turn === p.by && !g.letter && itOk(t, p.tgt) && !itColdEye(t, p.tgt)) {   // 竊取：從他手上隨機拿 1 張（只有雙方知道是哪張；被竊取的人到下一階段前看得到提示）
    const th = t.seats[p.tgt], pool = itHideBlack(t, p.tgt);
    if (!pool.length) { tblLog(t, `${th.name} 沒有可以拿的手牌，竊取落空`); return; }
    const card = pool[Math.floor(Math.random() * pool.length)];
    th.hand.splice(th.hand.indexOf(card), 1);
    by.hand.push(card);
    by.note = { k: "steal", tgt: th.name, card };
    th.stolen = { by: by.name, card };
    tblLog(t, `${by.name} 從 ${th.name} 手上竊取了一張牌`);
  } else if (p.a === "V" && itOk(t, p.tgt) && !itColdEye(t, p.tgt)) {   // 查驗：被查驗的人能自己決定回答（itCanLie）就等他回答；否則照實回答
    const th = t.seats[p.tgt];
    tblLog(t, `${by.name} 查驗了 ${th.name}`);
    if (itCanLie(t, p.tgt)) {
      g.ask = { by: p.by, tgt: p.tgt, dl: g.deadline, ext: g.ext || null };   // 暫停投遞回合：記下原本的期限與加時，回答後還原
      g.deadline = itDl(g, now, IT_HOLD_MS);
      tblLog(t, `等 ${th.name} 回答查驗`);
    } else by.note = { k: "verify", tgt: th.name, ans: th.role };
  } else if (p.a === "W" && itOk(t, p.tgt)) {   // 洗白：任何階段，可以對任何人情報區裡含黑的情報使用
    const th = t.seats[p.tgt], k = th.intel.indexOf(p.sel);
    if (k < 0) return;
    th.intel.splice(k, 1); g.discard.push(p.sel);
    if (!(by.washedFor || (by.washedFor = [])).includes(p.tgt)) by.washedFor.push(p.tgt);   // 助人者：曾洗白某位玩家的咒函
    tblLog(t, `${by.name} 洗白了 ${th.name} 情報區的一封情報：${itLabel(p.sel)}`);
    if (itSkillReady(t, p.by, "helper")) { itDraw(t, p.by, 1); tblLog(t, `${by.name}【助人者】援手：使用洗白，抽 1 張`); }
  } else if (p.a === "T" && g.letter && g.step === "pass" && g.letter.at === p.by && itOk(t, p.tgt) && p.tgt !== p.by) {   // 轉移：面前的情報交給另一位，對方不能拒收（被阻擋的人不能當對象）
    if (itBlocked(g, p.tgt)) { tblLog(t, `轉移失敗：${t.seats[p.tgt].name} 被阻擋，不能收下`); return; }
    const L = g.letter;
    tblLog(t, `${by.name} 把情報轉移給 ${t.seats[p.tgt].name}，他不能拒收`);
    L.at = p.tgt; L.cause = p.by; if (!L.seen.includes(p.tgt)) L.seen.push(p.tgt);
    itReceive(t, now, true);
  } else if (p.a === "B" && g.letter && g.step === "pass" && itOk(t, p.tgt)) {   // 阻擋：指定一人，本回（到換下一位投遞前）不能收下情報
    if (!itBlocked(g, p.tgt)) g.blocked.push(p.tgt);
    tblLog(t, `${by.name} 阻擋了 ${t.seats[p.tgt].name}：本回他不能收下情報`);
  } else if (p.a === "N" && g.step === "turn" && t.turn === p.by && !g.letter) {   // 無人倖免：從出牌的人開始，照座位順序從牌堆頂各拿一張直接放進情報區，有人勝利就停
    tblLog(t, `${by.name} 發動了無人倖免！`);
    const n = t.seats.length;
    for (let k = 0; k < n; k++) {
      const j = (p.by + k) % n;
      if (!itOk(t, j)) continue;
      const card = itTop(t);
      if (card === undefined) { tblLog(t, "牌堆沒有牌了，無人倖免結束"); break; }
      t.seats[j].intel.push(card);
      tblLog(t, `${t.seats[j].name} 的情報區多了：${itLabel(card)}`);
      if (itCheckIntel(t, j, p.by)) return;   // 有人勝利（或場上只剩一個陣營）：遊戲結束
    }
    if (t.g && !itOk(t, t.turn)) itEndLetter(t, now);   // 發動的人自己被黑函淘汰：直接換下一位
  }
}
// 時間檢查（每個操作進來先跑；客戶端時間到時送 timeout）：識破時間過了就生效；回合／收轉逾時就自動處理。不限時模式沒有任何計時
function itTick(t, now) {
  const g = t.g;
  if (t.game !== "intel" || t.phase !== "playing" || !g || g.untimed) return;
  if (g.prompt) { if (g.prompt.until && now >= g.prompt.until) itPromptDone(t, null, now); return; }   // 等玩家決定（技能）：逾時當作不用
  if (g.step === "pick") { if (now >= g.deadline) itPickDone(t, now); return; }   // 選角逾時：沒選的自動選第一張
  if (g.pend) { if (now >= g.pend.until) itResolve(t, now); return; }
  if (now < g.deadline) return;
  if (g.ask) { itAnswer(t, null, now); return; }   // 查驗逾時：照實回答
  if (g.step === "pass" && g.letter) {
    const L = g.letter, to = itBlocked(g, L.at) ? itFwdTarget(t, L) : -1;   // 被阻擋的持有者不能收：超時改成自動傳走
    if (to >= 0) { tblLog(t, `${t.seats[L.at].name} 超時（被阻擋），自動把情報傳給 ${t.seats[to].name}`); L.at = to; if (!L.seen.includes(to)) L.seen.push(to); g.deadline = itDl(g, now, IT_HOLD_MS); }
    else { tblLog(t, `${t.seats[L.at].name} 超時，自動收下`); itReceive(t, now); }
  }
  else if (g.step === "turn") {
    const s = t.seats[t.turn];
    if (!s.hand.length) { itEndLetter(t, now); return; }
    const k = Math.floor(Math.random() * s.hand.length), kind = itKindOf(s.hand[k]);   // 投遞方式由卡面決定；直達的目標隨機挑一位
    const others = itAlive(t).filter(j => j !== t.turn), to = kind === "direct" ? others[Math.floor(Math.random() * others.length)] : itNextUntouched(t, t.turn, [t.turn]);
    if (to === undefined || to < 0) { itEndLetter(t, now); return; }
    const card = s.hand.splice(k, 1)[0];
    g.letter = { card, orig: card, from: t.turn, cause: t.turn, at: to, seen: [t.turn, to], kind, icpt: null }; g.step = "pass"; g.deadline = itDl(g, now, IT_HOLD_MS); itClearStolen(t);
    tblLog(t, `${s.name} 超時，自動把一封${IT_KIND[kind]}交給 ${t.seats[to].name}`);
  }
}
// 不限時模式：識破時間不倒數，要所有活人（出牌的人自動算）按「準備繼續」才生效；有人出識破就重新計
function itOkCheck(t, now) {
  const g = t.g, p = g.pend;
  if (!p || !g.untimed) return;
  if (itAlive(t).every(i => i === p.by || p.ok.includes(i))) itResolve(t, now);
}
// 查驗：被查驗的人能不能自己決定回答（謊報／不透露）。目前還沒有身分牌，一律照實回答；之後「可以謊報查驗」的身分牌在這裡回 true
function itCanLie(t, i) { return false; }
const IT_ANS = ["sand", "water", "mage", "hide"];   // 回答：沙都／水都／咒術師／不透露
// 被查驗的人回答（ans＝null：照實回答，逾時或離開時用）
function itAnswer(t, ans, now) {
  const g = t.g, q = g.ask, th = t.seats[q.tgt];
  g.ask = null;
  t.seats[q.by].note = { k: "verify", tgt: th.name, ans: ans || th.role };
  tblLog(t, ans ? `${th.name} 回答了 ${t.seats[q.by].name} 的查驗` : `${th.name} 沒有回答，照實告知查驗結果`);
  g.ext = q.ext; g.deadline = g.untimed ? 0 : Math.max(q.dl, now + 5000);   // 回到投遞回合：還原原本的期限（至少留 5 秒）與加時
  itNoHand(t, now);
}
// 加時：目前這段倒數的加時紀錄（識破時間記在 pend 上、其他記在 g.ext）；make＝沒有就建立
function itExtOf(g, make) {
  const o = g.pend || g;
  if (!o.ext && make) o.ext = { by: [], skip: [] };
  return o.ext || null;
}
function itExtend(t, i, now) {
  const g = t.g, s = t.seats[i];
  if (g.untimed || (s.extLeft ?? 0) <= 0 || (g.step !== "turn" && g.step !== "pass")) return;
  const e = itExtOf(g, true);
  if (e.by.includes(i) || e.by.length >= IT_EXT_MAX) return;
  e.by.push(i); s.extLeft -= 1;
  const base = g.pend ? IT_PEND_MS : g.ask ? IT_HOLD_MS : g.step === "turn" ? IT_TURN_MS : IT_HOLD_MS, until = now + base * IT_EXT_MUL;
  if (g.pend) { g.pend.until = until; g.deadline = Math.max(g.deadline, until + 5000); } else g.deadline = until;
  tblLog(t, `${s.name} 申請加時（${base * IT_EXT_MUL / 1000} 秒，本局還剩 ${s.extLeft} 次）`);
}
function itSkip(t, i, now) {
  const g = t.g, e = itExtOf(g, false);
  if (g.untimed || !e || !e.by.includes(i) || e.skip.includes(i)) return;
  e.skip.push(i);
  tblLog(t, `${t.seats[i].name} 跳過`);
  if (!e.by.every(j => e.skip.includes(j))) return;   // 所有加時的人都跳過才縮回
  if (g.pend) g.pend.until = Math.min(g.pend.until, now + IT_EXT_SKIP_MS); else g.deadline = Math.min(g.deadline, now + IT_EXT_SKIP_MS);
}
// 識破串：由最底下的行動到最上面（最後出的）
function itChain(p) { const c = []; for (; p; p = p.under) c.unshift({ a: p.a, by: p.by, tgt: p.tgt, col: p.col || null }); return c; }
function itMsg(t, cid, msg, now) {
  const [role, i] = tblFind(t, cid), g = t.g, a = msg.a;
  if (a === "imode") {   // 桌主（第一位入座的人）在開局前選：限時／不限時
    if (t.game !== "intel" || role !== "seat" || i !== 0 || t.phase !== "lobby" || (msg.v !== "timed" && msg.v !== "untimed") || !!t.untimed === (msg.v === "untimed")) return;
    t.untimed = msg.v === "untimed";
    for (const s of t.seats) s.ready = false;
    tblLog(t, `${t.seats[0].name} 把模式改成${t.untimed ? "不限時" : "限時"}`);
    return;
  }
  if (a === "ichars") {   // 桌主在開局前開關「角色卡」模式
    if (t.game !== "intel" || role !== "seat" || i !== 0 || t.phase !== "lobby" || typeof msg.v !== "boolean" || !!t.chars === msg.v) return;
    t.chars = msg.v;
    for (const s of t.seats) s.ready = false;
    tblLog(t, `${t.seats[0].name} ${t.chars ? "開啟" : "關閉"}了角色卡`);
    return;
  }
  if (a === "timeout") { itTick(t, now + 300); return; }
  if (t.game !== "intel" || role !== "seat" || t.phase !== "playing" || !g) return;
  if (!itOk(t, i) && !(a === "iprompt" && g.prompt && g.prompt.seat === i && !t.seats[i].left)) return;   // 出局的人只能回答自己的技能選擇（遺言、殉道）
  const s = t.seats[i], L = g.letter;
  if (a === "ipick") {   // 選角：c＝兩張候選之一
    if (g.step !== "pick" || s.char || !s.choices || !s.choices.includes(msg.c)) return;
    s.char = msg.c; itPickCheck(t, now); return;
  }
  if (g.step === "pick") return;   // 選角階段只能選角
  if (a === "iprompt") { if (g.prompt && g.prompt.seat === i) itPromptDone(t, msg.no ? null : msg, now); return; }   // 回答技能的選擇（no：不用）
  if (g.prompt) return;            // 等玩家決定：其他動作都暫停
  if (a === "iskill") { itSkill(t, i, msg, now); return; }   // 角色技能（k＝技能編號）
  if (a === "iext") { itExtend(t, i, now); return; }   // 加時（限時模式）
  if (a === "iskip") { itSkip(t, i, now); return; }    // 加時的人放棄行動：所有加時的人都跳過就縮回 3 秒
  if (a === "ians") { if (g.ask && g.ask.tgt === i && IT_ANS.includes(msg.v)) itAnswer(t, msg.v, now); return; }   // 回答查驗（只有能謊報的人會被問）
  if (g.ask) return;   // 等查驗回答：其他動作都暫停
  if (a === "iok") {   // 不限時：按「準備繼續」（識破時間內沒有要識破；或收下情報後的確認）
    if (g.pend) { if (!g.untimed || g.pend.by === i || g.pend.ok.includes(i)) return; g.pend.ok.push(i); itOkCheck(t, now); return; }
    if (g.arrive && g.untimed && g.letter) { const ar = g.arrive; if (g.letter.at === i || ar.ok.includes(i)) return; ar.ok.push(i); itArriveCheck(t, now); return; }
    if (g.step === "ack" && g.ack && g.untimed) { if (g.ack.by === i || g.ack.ok.includes(i)) return; g.ack.ok.push(i); itAckCheck(t, now); return; }
  } else if (a === "isend") {   // 投遞：idx＝手牌；投遞方式由卡面決定（密函／公開情報照座位順序交給下一位；直達情報要帶 to，對方可以不收、退回給發信者）
    if (g.pend || g.step !== "turn" || i !== t.turn || !Number.isInteger(msg.idx) || msg.idx < 0 || msg.idx >= s.hand.length) return;
    const intent = msg.as === "direct" && itSkillReady(t, i, "sniper") && !s.onceUsed && itHasK(s.hand[msg.idx]);   // 狙擊手「殺意」（一局一次）：一張咒函當作直達送出
    const kind = intent ? "direct" : itKindOf(s.hand[msg.idx]);
    const to = kind === "direct" ? msg.to : itNextUntouched(t, i, [i]);
    if (!itOk(t, to) || to === i) return;
    if (intent) { s.onceUsed = true; tblLog(t, `${s.name}【狙擊手】殺意：把一張咒函當作直達送出`); }
    const card = s.hand.splice(msg.idx, 1)[0];
    g.letter = { card, orig: card, from: i, cause: i, at: to, seen: [i, to], kind, icpt: null }; g.step = "pass"; g.deadline = itDl(g, now, IT_HOLD_MS); itArrive(g); itClearStolen(t);
    tblLog(t, kind === "pub" ? `${s.name} 公開了一則情報（${itLabel(card)}），交給 ${t.seats[to].name}` : kind === "direct" ? `${s.name} 把一封直達情報交給 ${t.seats[to].name}` : `${s.name} 把一封密函交給 ${t.seats[to].name}`);
  } else if (a === "itake") {   // 收下
    if (g.pend || g.arrive || g.step !== "pass" || !L || L.at !== i || !itCanTake(t, L, i)) return;
    itReceive(t, now, true);
  } else if (a === "ifwd") {   // 轉手：只能轉給座位順序的下一個沒碰過的人（直達情報：被攔截的人退回給發信者）
    if (g.pend || g.arrive || g.step !== "pass" || !L || L.at !== i) return;
    const to = itFwdTarget(t, L);
    if (to < 0) return;
    L.at = to; if (!L.seen.includes(to)) L.seen.push(to); g.deadline = itDl(g, now, IT_HOLD_MS); itArrive(g);
    tblLog(t, L.kind === "direct" ? `${s.name} 不收，把直達情報退回給 ${t.seats[to].name}` : `${s.name} 把${IT_KIND[L.kind]}轉給 ${t.seats[to].name}`);
  } else if (a === "iact") {   // 使用行動牌：idx＝手牌；搜身帶 tgt、調包帶 sel（換進去的手牌 idx）、洗白帶 sel（情報區 idx）
    if (!Number.isInteger(msg.idx) || msg.idx < 0 || msg.idx >= s.hand.length) return;
    const card = s.hand[msg.idx];
    const asF = (msg.as === "F" && itSkillReady(t, i, "killer") && itKindOf(card) === "seal") || (msg.as === "F!" && !s.onceUsed && (itSkillReady(t, i, "killer") || (itSkillReady(t, i, "harmonizer") && itKindOf(card) === "direct")));   // 殺手：標記目標（密函）／死亡預告（任一張，一局一次，不能被識破）；調和者「調和」（直達牌，一局一次，不能被識破）
    const act = asF ? "F" : msg.as === "S" && itSkillReady(t, i, "doubleagent") && itCols(card).length === 2 ? "S" : itAct(card);   // 雙面間諜「偷天換日」：雙色牌可當作調包使用（是行動牌，可被識破）
    if (g.pend) {   // 識破時間內只能出識破（不能識破自己出的那張）；識破本身也能被識破，每次重新計時
      if (act !== "C" || g.pend.by === i) return;
      s.hand.splice(msg.idx, 1); g.discard.push(card);
      tblLog(t, `${s.name} 識破了 ${t.seats[g.pend.by].name} 的${IT_ACT[g.pend.a]}！`);
      g.pend = { a: "C", by: i, tgt: -1, sel: null, until: now + IT_PEND_MS, under: g.pend, ok: [] };
      if (!g.untimed) g.deadline = Math.max(g.deadline, now + IT_PEND_MS + 5000);
      itOkCheck(t, now);
      return;
    }
    const pass = g.step === "pass" && L, mine = g.step === "turn" && i === t.turn;
    let tgt = -1, sel = null;
    if (act === "P" || act === "S") { if (!pass || L.at !== i || L.kind === "pub" || L.open) return; }   // 截閱、調包：蓋著的密函（非公開、沒被調包過）在自己手上時
    if (act === "S") { const k = msg.sel; if (!Number.isInteger(k) || k < 0 || k >= s.hand.length || k === msg.idx) return; sel = s.hand[k]; }
    const harm = itSkillReady(t, i, "harmonizer");   // 調和者「平等」：可以在他人的回合使用鎖定（投遞前或傳遞中）
    if (act === "F") { if ((i !== t.turn && !harm) || g.ask || !((g.step === "turn" && !L && (i === t.turn || harm)) || pass) || !itOk(t, msg.tgt) || msg.tgt === i || itLocked(g, msg.tgt)) return; tgt = msg.tgt; }   // 鎖定：輪到的人（或平等的調和者），投遞前或傳遞中，指定另一位玩家
    if (act === "X" && !pass) return;                   // 焚信：情報傳遞中
    if (act === "I" && (!pass || L.at === i || L.from === i)) return;   // 攔截：別人拿著情報時（不能攔自己發出去的）
    if (act === "H" || act === "V") { if (!mine || !itOk(t, msg.tgt) || msg.tgt === i || itColdEye(t, msg.tgt)) return; tgt = msg.tgt; }   // 搜身、查驗：自己的回合（局外人「冷眼旁觀」不能被指定）
    if (act === "W") {   // 洗白：任何階段，對任何活人情報區裡含黑的情報（tgt＝座位、sel＝他情報區的 idx）
      const th = t.seats[msg.tgt], k = msg.sel;
      if (!itOk(t, msg.tgt) || !Number.isInteger(k) || k < 0 || k >= th.intel.length || !itCols(th.intel[k]).includes("K")) return;
      tgt = msg.tgt; sel = th.intel[k];
    }
    if (act === "T") { if (!pass || L.at !== i || itLocked(g, i) || !itOk(t, msg.tgt) || msg.tgt === i || itBlocked(g, msg.tgt)) return; tgt = msg.tgt; }   // 轉移：情報在自己面前時，交給另一位（被阻擋的人不行）
    if (act === "B") { if (!pass || !itOk(t, msg.tgt) || itBlocked(g, msg.tgt)) return; tgt = msg.tgt; }   // 阻擋：情報傳遞中（自己或別人的），指定一人
    if (act === "N" && (!mine || L)) return;   // 無人倖免：自己的回合、發送情報之前
    if (act === "D" && (!mine || L)) return;   // 補給：自己的回合、發送情報之前
    if (act === "R") { if (!mine || L || !itOk(t, msg.tgt) || msg.tgt === i || itColdEye(t, msg.tgt)) return; tgt = msg.tgt; }   // 竊取：自己的回合，指定另一位玩家（局外人「冷眼旁觀」不能被指定）
    const col = act === "P" && ["Y", "B", "K"].includes(msg.col) ? msg.col : null;   // 截閱：可以宣告一個顏色（宣告就公開）
    if (act === "C") return;   // 識破只能在別人的行動生效前出
    if (asF && msg.as === "F!") {   // 死亡預告：不能被識破，直接生效
      s.hand.splice(msg.idx, 1); g.discard.push(card); s.onceUsed = true;
      tblLog(t, s.char === "harmonizer" ? `${s.name}【調和者】調和：把一張直達當作鎖定使用（對 ${t.seats[tgt].name}，不能被識破）` : `${s.name}【殺手】死亡預告：把一張牌當作鎖定使用（對 ${t.seats[tgt].name}，不能被識破）`);
      itLockApply(t, i, tgt, now);
      itResolveEnd(t, now, i);
      return;
    }
    s.hand.splice(msg.idx, 1); g.discard.push(card);
    g.pend = { a: act, by: i, tgt, sel, until: now + IT_PEND_MS, under: null, ok: [] };
    if (g.arrive) g.arrive.ok = [];   // 有人出牌：到達確認重來
    if (g.ack) g.ack.ok = [];         // 收下確認中出牌：確認重來
    if (col) g.pend.col = col;
    const on = act === "F" || act === "H" || act === "V" || act === "R" || act === "W" || act === "T" || act === "B" ? `（對 ${t.seats[tgt].name}）` : act === "I" ? `（對 ${t.seats[L.at].name}）` : col ? `（宣告${IT_CNAME[col]}色）` : "";
    tblLog(t, `${s.name}${asF ? "【殺手】標記目標：把密函當作鎖定" : " 使用了" + IT_ACT[act]}${on}`);
    itOkCheck(t, now);   // 不限時：只剩出牌的人自己活著的極端情況，直接生效
  }
}
// 遊戲進行中有人離開：翻開身分、手牌丟棄，遊戲繼續；場上只剩一個陣營時結束（無 XP）
function itLeave(t, i, now) {
  const g = t.g, s = t.seats[i];
  if (g.prompt && g.prompt.seat === i) { itPromptDone(t, null, now); if (!t.g) return; }   // 他正在做技能選擇：當作不用，先讓流程走完
  g.discard.push(...s.hand); s.hand = []; s.left = true; s.cid = null;
  tblLog(t, `${s.name} 離開了（身分：${IT_ROLE[s.role]}）`);
  g.pend = null;   // 進行中的行動作廢（牌已經丟了）
  if (g.ask && g.ask.tgt === i && g.ask.by !== i && itOk(t, g.ask.by)) itAnswer(t, null, now);   // 被查驗的人離開：照實告知
  else if (g.ask) g.ask = null;
  let advance = g.step === "turn" && t.turn === i;
  if (g.letter && g.letter.at === i) { g.discard.push(g.letter.card); g.letter = null; g.arrive = null; advance = true; tblLog(t, "他手上的密函作廢"); }
  if (itCheckFaction(t, true)) return;
  if (g.step === "pick") { itPickCheck(t, now); return; }   // 選角中有人離開：剩下的人選完就開始
  if (g.chars && itCharCheck(t, i)) return;
  if (g.step === "ack") { itAckCheck(t, now); return; }
  if (g.arrive) itArriveCheck(t, now);   // 不限時：到達確認中有人離開，剩下的人按完就讓持有者決定   // 不限時：有人離開，剩下的人都按了就繼續
  if (advance) itEndLetter(t, now);
}
// ---- UNO（第六桌 t6；2026-11-08，使用者要求，名稱沿用 UNO（商標風險由使用者決定）；牌面是原創繪製）：2～6 人、標準 108 張、手牌剩 1 張要喊 UNO ----
// 與 tools/dev_server.py 的 un_* 同一套（規則說明見那邊）：傳統 classic／無限制 wild（+2／+4 可無限累積傳遞、跳過可傳遞、沒牌可出時抽牌不限次數）。
// 牌的編碼：顏色字母 RYGB＋點數 0～9／s（跳過）／r（反轉）／d（+2），例如 R5、Gs；W＝變色牌、F＝變色 +4。
const UN_COLORS = "RYGB";
const UN_TURN_MS = 30000;
const UN_XP = 5;   // 輸贏一樣（使用者定）：每位入座者 +5
const UN_MODES = ["classic", "wild"];
function unDeck() {
  const d = [];
  for (const c of UN_COLORS) { d.push(c + "0"); for (const v of "123456789srd") d.push(c + v, c + v); }
  return d.concat(Array(4).fill("W"), Array(4).fill("F"));
}
const unCname = c => ({ R: "紅", Y: "黃", G: "綠", B: "藍" }[c] || "");
const unLabel = card => (card === "W" ? "變色牌" : card === "F" ? "變色 +4" : unCname(card[0]) + ({ s: "跳過", r: "反轉", d: "+2" }[card.slice(1)] || card.slice(1)));
const unIsPlus = card => card === "F" || (card !== "W" && card.slice(1) === "d");
const unIsSkip = card => card !== "W" && card !== "F" && card.slice(1) === "s";
// 目前情境下這張牌能不能出（含無限制玩法的累積加牌／跳過傳遞）
function unPlayable(g, hand, card) {
  if (g.pending > 0) return unIsPlus(card);   // 無限制：只能接著出 + 牌（不看顏色）傳下去
  if (g.skip) return unIsSkip(card);          // 無限制：被跳過時只能出跳過牌（不看顏色）傳下去
  if (card === "W") return true;
  if (card === "F") return g.mode === "wild" || !hand.some(c => c !== "W" && c !== "F" && c[0] === g.color);   // 傳統：+4 只能在手上沒有「目前顏色」的牌時出
  return card[0] === g.color || card.slice(1) === g.topval;
}
const unActive = t => t.seats.map((s, i) => (s.left ? -1 : i)).filter(i => i >= 0);
function unNext(t, i, steps = 1) {
  const n = t.seats.length; let j = i, moved = 0;
  while (moved < steps) { j = (j + t.g.dir + n) % n; if (!t.seats[j].left) moved++; }
  return j;
}
function unSetTurn(t, i, now) { t.turn = i; t.g.drawn = false; t.g.deadline = now + UN_TURN_MS; }
function unDrawCards(t, i, n) {
  const g = t.g, hand = t.seats[i].hand;
  for (let k = 0; k < n; k++) {
    if (!g.deck.length) {   // 牌堆空了：把棄牌堆（留最上面那張）洗回去
      const top = g.discard.pop();
      g.deck = shuffle(g.discard); g.discard = [top];
    }
    if (!g.deck.length) break;
    hand.push(g.deck.pop());
  }
}
const unHasPlayable = (t, i) => t.seats[i].hand.some(c => unPlayable(t.g, t.seats[i].hand, c));
function unStart(t) {
  const now = Date.now(), deck = shuffle(unDeck()), n = t.seats.length;
  for (const s of t.seats) { s.hand = deck.splice(deck.length - 7, 7); s.out = false; s.ready = false; s.left = false; s.said = false; }
  while (!("RYGB".includes(deck[deck.length - 1][0]) && "0123456789".includes(deck[deck.length - 1].slice(1)) && deck[deck.length - 1] !== "W" && deck[deck.length - 1] !== "F")) shuffle(deck);   // 起始牌一律是數字牌
  const top = deck.pop(), mode = UN_MODES.includes(t.mode) ? t.mode : "classic";
  t.g = { deck, discard: [top], color: top[0], topval: top.slice(1), dir: 1, drawn: false, pend: -1, deadline: 0, mode, pending: 0, skip: false };   // pending：無限制玩法累積的加牌張數；skip：輪到的人正被跳過、可以傳遞
  t.result = null; t.phase = "playing";
  unSetTurn(t, Math.floor(Math.random() * n), now);
  tblLog(t, `牌局開始（${mode === "wild" ? "無限制玩法" : "傳統玩法"}）！每人 7 張，起始牌 ${unLabel(top)}，由 ${t.seats[t.turn].name} 先出`);
}
function unFinish(t, winner, xp) {
  const name = t.seats[winner].name, stay = t.seats.filter(s => !s.left), win = t.seats[winner], wild = !!(t.g && t.g.mode === "wild");
  const gs = xp ? stay.map(s => gsMk(s === win ? { w: 1, ...(wild ? { ww: 1 } : {}) } : {})) : null;   // ww＝無限制玩法獲勝；有人中途離開（xp＝false）的局不記
  t.result = { winner, name, text: `${name} 出完手牌，獲勝！`, rid: Math.floor(Math.random() * 4294967296), xp: stay.map(() => (xp ? UN_XP : 0)), gs };
  tblLog(t, t.result.text);
  t.seats = stay;
  tblResetSeats(t);
  t.g = null;
}
// 只剩 1 位玩家：那位獲勝（其他人都離開了；無 XP，擋「開了就等別人離開」的刷分）；一個人都不剩就直接清桌
function unCheckLast(t) {
  const act = unActive(t);
  if (t.phase !== "playing" || act.length > 1) return false;
  if (act.length) unFinish(t, act[0], false);
  else { t.seats = []; tblResetSeats(t); t.g = null; }
  return true;
}
// 輪到 v 面對累積加牌／跳過：v 手上沒有能接的牌就直接吃下、換下一位（不用等他按）；有就把決定權交給 v
function unPassOn(t, v, now) {
  const g = t.g, hand = t.seats[v].hand;
  if (g.pending > 0) {
    if (hand.some(unIsPlus)) { unSetTurn(t, v, now); return; }
    const n = g.pending;
    unDrawCards(t, v, n); g.pending = 0;
    tblLog(t, `${t.seats[v].name} 抽 ${n} 張`);
    unSetTurn(t, unNext(t, v), now);
  } else if (g.skip) {
    if (hand.some(unIsSkip)) { unSetTurn(t, v, now); return; }
    g.skip = false;
    tblLog(t, `${t.seats[v].name} 被跳過`);
    unSetTurn(t, unNext(t, v), now);
  } else unSetTurn(t, v, now);
}
function unPlay(t, cid, idx, color, now, say = false) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "uno" || role !== "seat" || t.phase !== "playing" || !g || i !== t.turn) return;
  const s = t.seats[i];
  if (!Number.isInteger(idx) || idx < 0 || idx >= s.hand.length) return;
  if (g.drawn && idx !== s.hand.length - 1) return;   // 傳統：剛抽的牌只能出那一張（或放棄）
  const card = s.hand[idx];
  if (!unPlayable(g, s.hand, card)) return;
  if ((card === "W" || card === "F") && !(typeof color === "string" && color.length === 1 && UN_COLORS.includes(color))) return;   // 變色牌要指定四色之一
  const wild = g.mode === "wild";
  s.hand.splice(idx, 1);
  g.pend = -1;   // 輪到下一個人動作了：上一位忘記喊 UNO 的抓不到了
  g.discard.push(card);
  if (card === "W" || card === "F") { g.color = color; g.topval = card; tblLog(t, `${s.name} 出了 ${unLabel(card)}，選了${unCname(color)}色`); }
  else { g.color = card[0]; g.topval = card.slice(1); tblLog(t, `${s.name} 出了 ${unLabel(card)}`); }
  if (!s.hand.length) { unFinish(t, i, true); return; }   // 出完了：獲勝
  if (s.hand.length === 1) { if (s.said || say) { s.said = false; if (say) tblLog(t, `${s.name} 喊了 UNO！`); } else g.pend = i; }   // say＝「出牌並喊 UNO」   // 還沒喊 UNO：下一個人動作前，任何人可以抓
  g.skip = false;
  if (unIsSkip(card)) {   // 跳過
    const v = unNext(t, i);
    if (wild) { g.skip = true; unPassOn(t, v, now); }
    else { tblLog(t, `${t.seats[v].name} 被跳過`); unSetTurn(t, unNext(t, i, 2), now); }
  } else if (card !== "W" && card !== "F" && card.slice(1) === "r") {   // 反轉（兩人時也是換對方出牌，使用者定）
    g.dir = -g.dir; tblLog(t, "方向反轉");
    unSetTurn(t, unNext(t, i), now);
  } else if (unIsPlus(card)) {   // +2／+4
    const n = card === "F" ? 4 : 2, v = unNext(t, i);
    if (wild) { g.pending += n; tblLog(t, `累積 ${g.pending} 張`); unPassOn(t, v, now); }   // 累積：傳給下一位，他有 + 牌就可以接著傳
    else { unDrawCards(t, v, n); tblLog(t, `${t.seats[v].name} 抽 ${n} 張`); unSetTurn(t, unNext(t, i, 2), now); }
  } else unSetTurn(t, unNext(t, i), now);
}
function unDraw(t, cid, now) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "uno" || role !== "seat" || t.phase !== "playing" || !g || i !== t.turn) return;
  const s = t.seats[i], wild = g.mode === "wild";
  if (wild && g.pending > 0) {   // 無限制：吃下累積的加牌，被跳過這一回合
    const n = g.pending;
    g.pend = -1; unDrawCards(t, i, n); g.pending = 0;
    if (s.hand.length > 2) s.said = false;
    tblLog(t, `${s.name} 抽 ${n} 張`);
    unSetTurn(t, unNext(t, i), now);
    return;
  }
  if (wild && g.skip) return;   // 被跳過要用 pass 放棄，不能抽牌
  if (wild) {   // 無限制：手上沒有能出的牌時可以一直抽（有能出的牌就不能抽）
    if (unHasPlayable(t, i)) return;
    g.pend = -1; unDrawCards(t, i, 1);
    if (s.hand.length > 2) s.said = false;
    tblLog(t, `${s.name} 抽了一張牌`);
    return;
  }
  if (g.drawn) return;
  g.pend = -1; unDrawCards(t, i, 1);
  if (s.hand.length > 2) s.said = false;
  const card = s.hand.length ? s.hand[s.hand.length - 1] : null;
  if (card && unPlayable(g, s.hand, card)) { g.drawn = true; tblLog(t, `${s.name} 抽了一張牌`); }   // 抽到的牌能出：可以出、也可以放棄（pass）
  else { tblLog(t, `${s.name} 抽了一張牌，沒有可以出的牌`); unSetTurn(t, unNext(t, i), now); }
}
function unPass(t, cid, now) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "uno" || role !== "seat" || t.phase !== "playing" || !g || i !== t.turn) return;
  const s = t.seats[i];
  if (g.mode === "wild" && g.skip) { g.pend = -1; g.skip = false; tblLog(t, `${s.name} 被跳過`); unSetTurn(t, unNext(t, i), now); return; }   // 無限制：接受被跳過
  if (g.mode === "wild" && g.pending === 0 && !g.drawn && !unHasPlayable(t, i) && !g.deck.length && g.discard.length <= 1) {   // 牌抽光了、也沒牌可出：只能放棄
    g.pend = -1; tblLog(t, `${s.name} 沒有牌可出也沒牌可抽，放棄`); unSetTurn(t, unNext(t, i), now); return;
  }
  if (!g.drawn) return;
  g.pend = -1; tblLog(t, `${s.name} 放棄出牌`); unSetTurn(t, unNext(t, i), now);
}
// 喊 UNO：剛出到只剩 1 張時（pend）補喊；或手上只剩 1～2 張時先喊好（出到 1 張就不會被抓）
function unSay(t, cid) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "uno" || role !== "seat" || t.phase !== "playing" || !g) return;
  const s = t.seats[i];
  if (g.pend === i) { g.pend = -1; tblLog(t, `${s.name} 喊了 UNO！`); }
  else if (s.hand.length <= 2) { s.said = true; tblLog(t, `${s.name} 喊了 UNO！`); }
}
function unCatch(t, cid) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "uno" || role !== "seat" || t.phase !== "playing" || !g || g.pend < 0 || g.pend === i) return;
  const v = g.pend;
  g.pend = -1; unDrawCards(t, v, 2);
  tblLog(t, `${t.seats[i].name} 抓到 ${t.seats[v].name} 沒喊 UNO，罰抽 2 張`);
}
// 回合限時到了（客戶端送 timeout，伺服器核對時鐘）：有累積加牌就吃下、被跳過就放棄、否則抽 1 張並跳過（剛抽過就直接跳過）
function unTimeout(t, now) {
  const g = t.g;
  if (t.game !== "uno" || t.phase !== "playing" || !g || now < g.deadline - 300) return;
  const i = t.turn, s = t.seats[i];
  g.pend = -1;
  if (g.pending > 0) { const n = g.pending; unDrawCards(t, i, n); g.pending = 0; tblLog(t, `${s.name} 超時，吃下 ${n} 張`); }
  else if (g.skip) { g.skip = false; tblLog(t, `${s.name} 超時，被跳過`); }
  else { if (!g.drawn) unDrawCards(t, i, 1); tblLog(t, `${s.name} 超時，自動${g.drawn ? "" : "抽牌並"}跳過`); }
  unSetTurn(t, unNext(t, i), now);
}
// 遊戲進行中有人離開：手牌收回牌堆，遊戲繼續；只剩 1 人時那人獲勝（無 XP）
function unLeave(t, i, now) {
  const g = t.g, s = t.seats[i];
  g.deck = shuffle(g.deck.concat(s.hand));
  s.hand = []; s.left = true; s.cid = null;
  tblLog(t, `${s.name} 離開了，手牌收回牌堆`);
  if (g.pend === i) g.pend = -1;
  if (unCheckLast(t)) return;
  if (i === t.turn) { g.pending = 0; g.skip = false; unSetTurn(t, unNext(t, i), now); }   // 正在被加牌／被跳過的人離開：累積的懲罰作廢
}
// 桌主（第一位入座者）在開局前選玩法；換玩法會讓大家的「準備」重來
function unSetMode(t, cid, mode) {
  const [role, i] = tblFind(t, cid);
  if (t.game !== "uno" || role !== "seat" || i !== 0 || t.phase !== "lobby" || !UN_MODES.includes(mode) || (t.mode || "classic") === mode) return;
  t.mode = mode;
  for (const s of t.seats) s.ready = false;
  tblLog(t, `${t.seats[0].name} 把玩法改成${mode === "wild" ? "無限制" : "傳統"}`);
}
// ---- 俄羅斯方塊（第十三桌 t13，2026-11-13，使用者要求）：場地上方 4 台街機共用這一張邏輯桌 ----
// 每個座位綁一台機台（cab 0～3；同一台只能坐一個人）。每台都是單人遊玩：
//   單人模式（solo）：各自獨立的一局，結束分數進排行榜；
//   聯機模式（link）：發起的人（host）開邀請，其他機台「閒置中」的人會看到「要接受聯機邀請嗎？」，最多 4 人；
//     host 選「一般模式」（各自玩到全員出局，依分數排名）或「對戰模式」（消 2／3／4 行送每個對手 1／2／4 行垃圾，使用者定），聯機分數不進排行榜。
// 方塊遊戲本身在客戶端跑（信任客戶端，同打字競賽）：伺服器只給 seed／t0、轉發盤面快照（ttb）與垃圾行（tgb）、收結算分數。
// 與 tools/dev_server.py 的 ar_* 同一套，改規則兩邊一起改。
const AR_CABS = 4;
const AR_COUNTDOWN_MS = 3000;        // 聯機開局倒數
const AR_SOLO_COUNTDOWN_MS = 1500;   // 單人開局倒數
const AR_GARBAGE = { 2: 1, 3: 2, 4: 4 };   // 對戰模式：一次消幾行 → 送每個對手幾行垃圾（使用者定；消 1 行本身不送）
// 連擊額外送的垃圾行（2026-11-14 使用者要求）：連擊數 1～2＝0、3～4＝1、5～6＝2、7～8＝3、9～11＝4、12 以上＝5；與 main.js 的 arComboBonus 同一張表
const arComboBonus = c => (c >= 12 ? 5 : c >= 9 ? 4 : c >= 7 ? 3 : c >= 5 ? 2 : c >= 3 ? 1 : 0);
const AR_XP = 4, AR_XP_MIN = 10;     // 一局消了至少 AR_XP_MIN 行的人 +AR_XP（助手先訂的數值）
const AR_SCORE_MAX = 99999999;
const AR_MSGS = new Set(["solo", "link", "lmode", "ljoin", "lno", "lquit", "lstart", "over"]);
const arInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function arSeat(t, cab) { const i = t.seats.findIndex(s => s.cab === cab); return [i, i >= 0 ? t.seats[i] : null]; }
// 走到第 cab 台：那台空著且想入座就坐那台，否則觀戰；已經在這桌觀戰的人也可以藉此坐上空機台
function arJoin(t, cid, name, want, uid, cab) {
  const [role, i] = tblFind(t, cid);
  if (role === "seat") return;
  const free = arInt(cab, 0, AR_CABS - 1) && !arSeat(t, cab)[1];
  if (want !== "spec" && free) {
    if (role === "spec") t.specs.splice(i, 1);
    t.seats.push({ cid, name, uid: uid || null, ready: false, hand: [], out: false, cab, st: "idle", sc: 0, ln: 0, dead: false, last: null });
    tblLog(t, `${name} 坐上了 ${cab + 1} 號機`);
  } else if (!role) { t.specs.push({ cid, name, uid: uid || null }); tblLog(t, `${name} 來觀戰`); }
}
const arPlaying = (t, s) => s.st === "solo" || (s.st === "link" && !!t.g && t.g.phase === "playing");
function arLinkCancel(t, why) {
  for (const s of t.seats) if (s.st === "link") s.st = "idle";
  t.g = null; tblLog(t, why);
}
// 聯機進行中：還在場上的成員全部出局（或都離開了）就結算
function arCheckEnd(t) {
  const g = t.g;
  if (!g || g.phase !== "playing") return;
  const mem = g.mem.map(c => arSeat(t, c)[1]);
  if (mem.some(s => s && !s.dead)) return;
  const rows = [...mem.filter(Boolean).map(s => ({ name: s.name, uid: s.uid || null, score: s.sc, lines: s.ln, left: false, cab: s.cab })), ...g.gone.map(x => ({ ...x, left: true }))];
  rows.sort((a, b) => b.score - a.score);
  const xp = t.seats.map(s => (g.mem.includes(s.cab) && s.ln >= AR_XP_MIN ? AR_XP : 0));
  const top = rows[0], mode = g.mode === "battle" ? "對戰" : "一般";
  const text = top ? `聯機（${mode}模式）結束！第一名 ${top.name}，${top.score} 分` : "聯機結束";
  const gs = t.seats.map(s => (g.mem.includes(s.cab) ? gsMk(top && !top.left && top.cab === s.cab && rows.length >= 2 ? { lw: 1 } : {}, { lines: s.ln }) : null));   // lw＝聯機獲勝（第一名且至少 2 人）、lines＝單局消行（取最大）；依 t.seats 順序（同 xp）
  t.result = { link: true, mode: g.mode, text, rid: Math.floor(Math.random() * 4294967296), ranking: rows, xp, cabs: [...g.mem], gs };
  for (const s of t.seats) if (s.st === "link") { s.st = "idle"; s.dead = false; }
  t.g = null; tblLog(t, text);
}
function arSoloOver(t, i) {
  const s = t.seats[i];
  s.st = "idle"; s.last = { sc: s.sc, ln: s.ln };
  const text = `${s.name}（${s.cab + 1} 號機）單人模式結束：${s.sc} 分、${s.ln} 行`;
  t.result = { solo: true, cab: s.cab, text, rid: Math.floor(Math.random() * 4294967296), xp: t.seats.map((_, k) => (k === i && s.ln >= AR_XP_MIN ? AR_XP : 0)),
    ranking: [{ name: s.name, uid: s.uid || null, score: s.sc, lines: s.ln, left: false }],   // 排行榜由 tableBoard 記（只記單人模式，使用者定）
    gs: t.seats.map((_, k) => (k === i ? gsMk({}, { best: s.sc, lines: s.ln }) : null)) };   // best＝單人最高分、lines＝單局消行（都取最大）
  tblLog(t, text);
}
// 離開機台（Esc、換地形、斷線）：單人局直接作廢（不進排行榜）；聯機中照離開時的分數排名、不中斷其他人
function arLeave(t, i) {
  const s = t.seats.splice(i, 1)[0], g = t.g;
  if (s.st === "link" && g) {
    if (g.phase === "invite") {
      if (g.host === s.cab) arLinkCancel(t, `${s.name} 離開了，聯機邀請取消`);
      else { g.mem.splice(g.mem.indexOf(s.cab), 1); tblLog(t, `${s.name} 離開了聯機`); }
    } else {
      g.mem.splice(g.mem.indexOf(s.cab), 1);
      g.gone.push({ name: s.name, uid: s.uid || null, score: s.sc, lines: s.ln, cab: s.cab });
      tblLog(t, `${s.name} 離開了聯機（${s.sc} 分）`);
      arCheckEnd(t);
    }
  } else {
    if (g && g.no.includes(s.cab)) g.no.splice(g.no.indexOf(s.cab), 1);
    tblLog(t, `${s.name} 離開了 ${s.cab + 1} 號機`);
  }
}
// 回 [畫面有變要通知, 額外要送的訊息 [[cid, msg]…]]
function arMsg(t, cid, msg, now) {
  const [role, i] = tblFind(t, cid), a = msg.a;
  if (t.game !== "arcade" || role !== "seat") return [false, []];
  const s = t.seats[i], g = t.g;
  if (a === "solo") {
    if (s.st !== "idle") return [false, []];
    Object.assign(s, { st: "solo", sc: 0, ln: 0, dead: false, seed: Math.floor(Math.random() * 2147483648), t0: now + AR_SOLO_COUNTDOWN_MS });
    if (g && g.no.includes(s.cab)) g.no.splice(g.no.indexOf(s.cab), 1);
    tblLog(t, `${s.name} 開始了單人模式`);
    return [true, []];
  }
  if (a === "link") {   // 發起聯機邀請（同時只能有一場聯機）
    if (s.st !== "idle" || g) return [false, []];
    t.g = { host: s.cab, mode: "normal", phase: "invite", mem: [s.cab], no: [], gone: [] };
    s.st = "link"; tblLog(t, `${s.name} 發起了聯機邀請`);
    return [true, []];
  }
  if (a === "lmode") {
    if (g && g.phase === "invite" && g.host === s.cab && (msg.v === "normal" || msg.v === "battle") && g.mode !== msg.v) {
      g.mode = msg.v; tblLog(t, `聯機改成${g.mode === "battle" ? "對戰" : "一般"}模式`);
      return [true, []];
    }
    return [false, []];
  }
  if (a === "ljoin") {
    if (g && g.phase === "invite" && s.st === "idle" && g.mem.length < AR_CABS) {
      g.mem.push(s.cab);
      if (g.no.includes(s.cab)) g.no.splice(g.no.indexOf(s.cab), 1);
      s.st = "link"; tblLog(t, `${s.name} 接受了聯機邀請`);
      return [true, []];
    }
    return [false, []];
  }
  if (a === "lno") {
    if (g && g.phase === "invite" && s.st === "idle" && !g.no.includes(s.cab)) { g.no.push(s.cab); return [true, []]; }
    return [false, []];
  }
  if (a === "lquit") {   // 聯機等待中退出（host 退出＝取消邀請）
    if (g && g.phase === "invite" && s.st === "link") {
      if (g.host === s.cab) arLinkCancel(t, `${s.name} 取消了聯機邀請`);
      else { g.mem.splice(g.mem.indexOf(s.cab), 1); s.st = "idle"; tblLog(t, `${s.name} 退出了聯機`); }
      return [true, []];
    }
    return [false, []];
  }
  if (a === "lstart") {
    if (g && g.phase === "invite" && g.host === s.cab && g.mem.length >= 2) {
      Object.assign(g, { phase: "playing", seed: Math.floor(Math.random() * 2147483648), t0: now + AR_COUNTDOWN_MS, no: [] });
      for (const c of g.mem) Object.assign(arSeat(t, c)[1], { sc: 0, ln: 0, dead: false });
      t.result = null;
      tblLog(t, `聯機開始！${g.mem.length} 人，${g.mode === "battle" ? "對戰" : "一般"}模式`);
      return [true, []];
    }
    return [false, []];
  }
  if (a === "clr") {   // 一次消了 n 行：對戰模式送其他還活著的成員垃圾行
    const n = msg.n;
    if (!(arInt(n, 1, 4) && s.st === "link" && g && g.phase === "playing" && g.mode === "battle" && !s.dead && now >= g.t0)) return [false, []];
    const combo = arInt(msg.combo, 0, 1000) ? msg.combo : 0;   // 舊版客戶端沒帶 combo＝0
    const k = (AR_GARBAGE[n] || 0) + arComboBonus(combo), out = [];
    if (k) for (const c of g.mem) { const m = arSeat(t, c)[1]; if (m && c !== s.cab && !m.dead && m.cid != null) out.push([m.cid, { t: "tgb", n: k, from: s.cab }]); }
    return [false, out];
  }
  if (a === "tb") {   // 盤面快照：轉發給觀戰者與同一場聯機的其他成員（不通知整個畫面）
    const b = msg.b, sc = msg.sc, ln = msg.ln;
    if (!(arPlaying(t, s) && !s.dead && typeof b === "string" && b.length === 200 && /^[0-8]+$/.test(b) && arInt(sc, 0, AR_SCORE_MAX) && arInt(ln, 0, 100000))) return [false, []];
    s.sc = sc; s.ln = ln;
    const data = { t: "ttb", cab: s.cab, b, sc, ln }, out = t.specs.filter(m => m.cid != null).map(m => [m.cid, data]);
    if (s.st === "link") for (const c of g.mem) { const m = arSeat(t, c)[1]; if (m && c !== s.cab && m.cid != null) out.push([m.cid, data]); }
    return [false, out];
  }
  if (a === "over") {   // 這局結束（方塊頂到最上面）：回報最後分數
    const sc = msg.sc, ln = msg.ln;
    if (!(arPlaying(t, s) && !s.dead && arInt(sc, 0, AR_SCORE_MAX) && arInt(ln, 0, 100000))) return [false, []];
    s.sc = sc; s.ln = ln;
    if (s.st === "solo") arSoloOver(t, i);
    else { s.dead = true; tblLog(t, `${s.name} 出局了（${sc} 分）`); arCheckEnd(t); }
    return [true, []];
  }
  return [false, []];
}
function arView(t, cid, v) {
  const [role, i] = tblFind(t, cid), g = t.g, me = role === "seat" ? t.seats[i] : null;
  v.phase = me && arPlaying(t, me) ? "playing" : "lobby";
  v.cab = me ? me.cab : -1; v.sn = Date.now();
  t.seats.forEach((s, k) => Object.assign(v.seats[k], { cab: s.cab, st: s.st, sc: s.sc, ln: s.ln, dead: s.dead, last: s.last || null, play: arPlaying(t, s) }));
  if (me && me.st === "solo") v.tt = { seed: me.seed, t0: me.t0 };
  v.link = g ? { host: g.host, mode: g.mode, phase: g.phase, mem: [...g.mem], no: [...g.no], seed: g.seed ?? null, t0: g.t0 ?? null, gone: g.gone.map(x => ({ ...x })) } : null;
  return v;
}
// tblinfo 多帶：每台機台的狀態（島上機台頭上的標籤）、是否有人在等聯機、哪些連線在遊戲中（名牌〔遊戲中〕）
function arInfo(t) {
  const g = t.g, cabs = new Array(AR_CABS).fill(null);
  for (const s of t.seats) cabs[s.cab] = { n: s.name, st: s.st !== "link" ? s.st : (g && g.phase === "playing" ? "link" : "inv") };
  return { cabs, inv: !!(g && g.phase === "invite" && g.mem.length < AR_CABS), playing: t.seats.filter(s => arPlaying(t, s)).map(s => s.cid) };
}
// ---- 豆豆迷宮（吃豆迷宮類；第十四桌 t14，2026-11-13，使用者要求）：1～5 人，一人當豆豆、其他人當幽靈 ----
// 1 人＝單人模式：自己當豆豆、對 4 隻電腦幽靈，一關接一關到命用完，分數進排行榜（使用者定）；
// 2～5 人＝對抗：桌主（第一位入座的人）在開局前指定誰當豆豆（預設自己，使用者定），其他人依序當幽靈、空的幽靈由電腦控制；
//   豆子吃光＝豆豆方贏，3 條命用完（或時間到）＝幽靈方贏，不進排行榜。進行中有人離開不中斷：幽靈離開改由電腦控制、豆豆離開＝幽靈方贏。
// 遊戲本身在客戶端跑：豆豆那台是權威（豆子、能量、被抓、電腦幽靈都由它決定），伺服器只轉發豆豆的快照（ms → tms）與
// 幽靈玩家的位置（mp → tmp），並收結算（over）。與 tools/dev_server.py 的 mz_* 同一套，改規則兩邊一起改。
const MZ_GHOSTS = 4;
const MZ_COUNTDOWN_MS = 3000, MZ_SOLO_COUNTDOWN_MS = 1500;
const MZ_VS_MS = 240000;              // 對抗一局的時間上限（豆豆那台到時間就結算幽靈方贏；伺服器多等 20 秒還沒結算就自己結）
const MZ_XP = 4, MZ_XP_MIN = 3000;    // 單人 ≥ MZ_XP_MIN 分、對抗贏的那一方 +MZ_XP（助手先訂的數值）
const MZ_SCORE_MAX = 99999999;
const MZ_MSGS = new Set(["mpac", "over"]);
const mzInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function mzPacIdx(t) { const i = t.seats.findIndex(s => s.cid != null && s.cid === t.pacCid); return i >= 0 ? i : 0; }
function mzSetPac(t, cid, v) {   // 桌主在開局前指定誰當豆豆；改了大家要重新準備
  const [role, i] = tblFind(t, cid);
  if (t.game !== "maze" || role !== "seat" || i !== 0 || t.phase !== "lobby" || !mzInt(v, 0, t.seats.length - 1) || mzPacIdx(t) === v) return;
  t.pacCid = t.seats[v].cid;
  for (const s of t.seats) s.ready = false;
  tblLog(t, `${t.seats[0].name} 指定 ${t.seats[v].name} 當豆豆`);
}
function mzStart(t) {
  const now = Date.now(), n = t.seats.length, pac = mzPacIdx(t);
  const gh = t.seats.map((_, k) => k).filter(k => k !== pac).slice(0, MZ_GHOSTS);
  while (gh.length < MZ_GHOSTS) gh.push(-1);
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: now + (n === 1 ? MZ_SOLO_COUNTDOWN_MS : MZ_COUNTDOWN_MS), pac, gh, solo: n === 1 };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) { s.ready = false; s.left = false; s.sc = 0; s.lvl = 1; }
  tblLog(t, n === 1 ? `${t.seats[0].name} 開始挑戰（單人）` : `對抗開始！${t.seats[pac].name} 當豆豆，${n - 1} 人當幽靈`);
}
// 結束：solo＝單人（分數進排行榜）；否則 win＝"pac"／"ghost"。ct＝每個幽靈位置抓到豆豆幾次
function mzFinish(t, win, why, ct) {
  const g = t.g;
  if (!g) return;
  const stay = t.seats.filter(s => !s.left), pacSeat = t.seats[g.pac];
  if (g.solo) {
    const s = t.seats[0];
    t.result = s.left ? { aborted: true, text: `${s.name} 離開了，這一局不算` }
      : { solo: true, text: `挑戰結束！${s.name} ${s.sc} 分（第 ${s.lvl} 關）`, rid: Math.floor(Math.random() * 4294967296),
          ranking: [{ name: s.name, uid: s.uid || null, score: s.sc, lvl: s.lvl, left: false }], xp: stay.map(x => (x.sc >= MZ_XP_MIN ? MZ_XP : 0)),
          gs: stay.map(x => gsMk({}, { best: x.sc, lvl: x.lvl })) };   // best＝單人最高分、lvl＝抵達的關卡（都取最大）
  } else {
    const ranking = t.seats.map((s, k) => {
      const gk = g.gh.indexOf(k);
      return { name: s.name, uid: s.uid || null, role: k === g.pac ? "pac" : "ghost", score: k === g.pac ? s.sc : (ct && gk >= 0 ? ct[gk] : 0), left: !!s.left };
    }).sort((a, b) => (a.role === b.role ? 0 : a.role === "pac" ? -1 : 1));
    const xp = stay.map(s => ((s === pacSeat) === (win === "pac") ? MZ_XP : 0));   // 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
    const gs = stay.map(s => gsMk((s === pacSeat) === (win === "pac") ? { w: 1, ...(s === pacSeat ? { wp: 1 } : { wg: 1 }) } : {}));   // w＝對抗獲勝、wp／wg＝以豆豆／幽靈方獲勝
    t.result = { win, text: `${win === "pac" ? "豆豆方獲勝" : "幽靈方獲勝"}！（${why}）`, rid: Math.floor(Math.random() * 4294967296), ranking, xp, gs };
  }
  tblLog(t, t.result.text);
  t.seats = stay;
  tblResetSeats(t);
  t.g = null;
}
function mzTick(t, now) {   // 豆豆那台當掉、沒回報結算：對抗的時間上限過了 20 秒，伺服器自己結（幽靈方贏）
  if (t.game === "maze" && t.phase === "playing" && t.g && !t.g.solo && now > t.g.t0 + MZ_VS_MS + 20000) { mzFinish(t, "ghost", "時間到"); return true; }
  return false;
}
// 遊戲進行中有人離開：幽靈→改由電腦控制，遊戲繼續；豆豆→幽靈方贏（單人＝這局不算）
function mzLeave(t, i) {
  const s = t.seats[i], g = t.g;
  s.left = true; s.cid = null;
  if (i === g.pac) { mzFinish(t, "ghost", `${s.name}（豆豆）離開了`); return; }
  const k = g.gh.indexOf(i); if (k >= 0) g.gh[k] = -1;
  tblLog(t, `${s.name} 離開了，那隻幽靈改由電腦控制`);
}
// 豆豆的快照（約 10 次／秒）：p 豆豆 [x, y, 方向]（格數×10）、g 4 隻幽靈 [x, y, 方向, 狀態 0 一般／1 害怕／2 被吃掉回家中]、
// d 剩下的豆子（16 進位點陣）、pw 能量剩幾毫秒、sc 分數、lv 剩幾條命、lvl 第幾關、rs 重來次數（被抓後大家回起點）、fz 凍結毫秒、bn 獎勵果實在不在
function mzSnap(msg) {
  const p = msg.p, g = msg.g, d = msg.d;
  const pt = v => Array.isArray(v) && mzInt(v[0], -20, 400) && mzInt(v[1], -20, 400) && mzInt(v[2], -1, 3);
  if (!pt(p) || !Array.isArray(g) || g.length !== MZ_GHOSTS || !g.every(x => pt(x) && mzInt(x[3], 0, 3))) return null;
  if (typeof d !== "string" || !/^[0-9a-f]{1,120}$/.test(d)) return null;
  if (!mzInt(msg.pw, 0, 60000) || !mzInt(msg.sc, 0, MZ_SCORE_MAX) || !mzInt(msg.lv, 0, 9) || !mzInt(msg.lvl, 1, 999) || !mzInt(msg.rs, 0, 100000) || !mzInt(msg.fz, 0, 10000) || !mzInt(msg.bn, 0, 1)) return null;
  return { p: p.slice(0, 3), g: g.map(x => x.slice(0, 4)), d, pw: msg.pw, sc: msg.sc, lv: msg.lv, lvl: msg.lvl, rs: msg.rs, fz: msg.fz, bn: msg.bn };
}
// 快照／幽靈位置：回要轉發的 [[cid, msg]…]（給同桌其他人與觀戰者）
function mzRelay(t, cid, msg) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "maze" || role !== "seat" || t.phase !== "playing" || !g) return [];
  let data = null;
  if (msg.a === "ms" && i === g.pac) {
    const d = mzSnap(msg); if (!d) return [];
    t.seats[i].sc = d.sc; t.seats[i].lvl = d.lvl;
    data = { t: "tms", i, ...d };
  } else if (msg.a === "mp" && g.gh.includes(i)) {   // 幽靈玩家的位置（x／y＝格數×10、d＝方向、m＝0 一般／2 被吃掉正在回家）
    if (!(mzInt(msg.x, -20, 400) && mzInt(msg.y, -20, 400) && mzInt(msg.d, -1, 3) && mzInt(msg.m, 0, 3))) return [];
    data = { t: "tmp", i, k: g.gh.indexOf(i), x: msg.x, y: msg.y, d: msg.d, m: msg.m };
  }
  if (!data) return [];
  return [...t.seats, ...t.specs].filter(m => m.cid != null && m.cid !== cid).map(m => [m.cid, data]);
}
// 豆豆那台回報結束：單人＝命用完（帶 lvl）；對抗＝win（豆子吃光）或沒有（命用完／tu 時間到），ct＝各幽靈位置抓到幾次
function mzOver(t, cid, msg) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "maze" || role !== "seat" || t.phase !== "playing" || !g || i !== g.pac || !mzInt(msg.sc, 0, MZ_SCORE_MAX)) return;
  const s = t.seats[i];
  s.sc = msg.sc;
  if (g.solo) { if (mzInt(msg.lvl, 1, 999)) s.lvl = msg.lvl; mzFinish(t, null, "命用完了"); return; }
  const ct = Array.isArray(msg.ct) && msg.ct.length === MZ_GHOSTS && msg.ct.every(x => mzInt(x, 0, 99)) ? msg.ct : null;
  const win = msg.win === true;
  mzFinish(t, win ? "pac" : "ghost", win ? "豆子全部吃光" : msg.tu === true ? "時間到" : "豆豆的命用完了", ct);
}
// ---- 空氣曲棍球（第十五、十六桌 t15／t16，2026-11-13，使用者要求）：2～4 人分藍紅兩隊（座位 0、2 藍隊，1、3 紅隊；2026-11-14 使用者要求最多 2v2，原本 2～8 人），人數要偶數 ----
// 先得 HK_GOALS 分、或 HK_LIM_MS 到時分數高的隊伍贏（同分平手），不進排行榜；有人離開＝這一局結束（一般桌子的規則）。
// 物理在桌主（座位 0）的客戶端跑：桌主送圓盤快照 hs → ths，每個人送自己握把的位置 hp → thp，桌主判斷結束送 hend。
// 與 tools/dev_server.py 的 hk_* 同一套，改規則兩邊一起改。
const HK_W = 640, HK_H = 320, HK_GOALS = 7, HK_LIM_MS = 180000, HK_COUNTDOWN_MS = 3000, HK_XP = 3;
const HK_MSGS = new Set(["hend"]);
const hkNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
function hkStart(t) {
  if (t.seats.length % 2) return;   // 人數要偶數（全員準備了也不開始，畫面會提示）
  const now = Date.now();
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: now + HK_COUNTDOWN_MS, sa: 0, sb: 0 };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) s.ready = false;
  tblLog(t, `比賽開始！${t.seats.length / 2} 對 ${t.seats.length / 2}`);
}
function hkFinish(t, sa, sb, why) {
  const win = sa > sb ? 0 : sb > sa ? 1 : -1;
  const text = `藍隊 ${sa} : ${sb} 紅隊，${win < 0 ? "平手" : win === 0 ? "藍隊獲勝" : "紅隊獲勝"}！${why ? `（${why}）` : ""}`;
  t.result = { text, sa, sb, win, rid: Math.floor(Math.random() * 4294967296), ranking: t.seats.map((s, i) => ({ name: s.name, uid: s.uid || null, team: i % 2, left: false })),
    xp: t.seats.map((_, i) => (i % 2 === win ? HK_XP : 0)), gs: t.seats.map((_, i) => gsMk(i % 2 === win ? { w: 1 } : {})) };   // w＝獲勝（平手沒人記）
  tblLog(t, text);
  tblResetSeats(t);
}
function hkTick(t, now) {   // 桌主那台當掉沒回報：時間上限過了 20 秒，伺服器照最後的比分結算
  if (t.game === "hockey" && t.phase === "playing" && t.g && now > t.g.t0 + HK_LIM_MS + 20000) { hkFinish(t, t.g.sa, t.g.sb, "時間到"); return true; }
  return false;
}
// 握把位置／圓盤快照：回要轉發的 [[cid, msg]…]（給同桌其他人與觀戰者）
function hkRelay(t, cid, msg) {
  const [role, i] = tblFind(t, cid), g = t.g;
  if (t.game !== "hockey" || role !== "seat" || t.phase !== "playing" || !g) return [];
  let data = null;
  if (msg.a === "hp") {   // 自己握把的位置（px）
    if (!hkNum(msg.x, 0, HK_W) || !hkNum(msg.y, 0, HK_H)) return [];
    data = { t: "thp", i, x: Math.round(msg.x), y: Math.round(msg.y) };
  } else if (msg.a === "hs" && i === 0) {   // 桌主：圓盤 x／y／vx／vy、比分 sa／sb、開球前的凍結毫秒 f、桌主自己的握把 px／py
    if (!hkNum(msg.x, -60, HK_W + 60) || !hkNum(msg.y, -60, HK_H + 60) || !hkNum(msg.vx, -3000, 3000) || !hkNum(msg.vy, -3000, 3000)) return [];
    if (!Number.isInteger(msg.sa) || !Number.isInteger(msg.sb) || msg.sa < 0 || msg.sb < 0 || msg.sa > 99 || msg.sb > 99 || !hkNum(msg.f, 0, 5000)) return [];
    g.sa = msg.sa; g.sb = msg.sb;
    data = { t: "ths", x: Math.round(msg.x), y: Math.round(msg.y), vx: Math.round(msg.vx), vy: Math.round(msg.vy), sa: msg.sa, sb: msg.sb, f: Math.round(msg.f) };
  }
  if (!data) return [];
  const to = [...t.seats, ...t.specs].filter(m => m.cid != null && m.cid !== cid), out = to.map(m => [m.cid, data]);
  if (msg.a === "hs" && hkNum(msg.px, 0, HK_W) && hkNum(msg.py, 0, HK_H)) {   // 桌主自己的握把位置也夾在快照裡（hp 與 hs 共用限流，分開送會被吃掉）
    const pd = { t: "thp", i: 0, x: Math.round(msg.px), y: Math.round(msg.py) };
    for (const m of to) out.push([m.cid, pd]);
  }
  return out;
}
function hkEnd(t, cid, msg) {   // 桌主那台回報結束（有一隊到 HK_GOALS 分，或時間到）
  const [role, i] = tblFind(t, cid);
  if (t.game !== "hockey" || role !== "seat" || i !== 0 || t.phase !== "playing" || !t.g) return;
  if (!Number.isInteger(msg.sa) || !Number.isInteger(msg.sb) || msg.sa < 0 || msg.sb < 0 || msg.sa > 99 || msg.sb > 99) return;
  hkFinish(t, msg.sa, msg.sb, msg.sa >= HK_GOALS || msg.sb >= HK_GOALS ? "" : "時間到");
}
const GAME_START = { bigtwo: btStart, kingdom: kgStart, arcade: () => {}, maze: mzStart, hockey: hkStart, oldmaid: omStart, gomoku: gmStart, dodge: dgStart, uno: unStart, typing: tyStart, zhtyping: tyStart, intel: itStart, mage: mgStart, blokus: bkStart, trigon: tgStart };   // 遊戲 → 開局函式（tblReady 全員準備時呼叫）
// 給某條連線看的版本：自己的手牌完整，別人只有張數
function tblView(t, cid) {
  const [role, i] = tblFind(t, cid), [mn, mx] = GAME_LIMITS[t.game], playing = t.phase === "playing";
  const v = {
    id: t.id, game: t.game, phase: t.phase, min: mn, max: mx, role, me: role === "seat" ? i : -1, board: t.board || null,
    seats: t.seats.map((s, k) => ({ name: s.name, n: playing ? s.hand.length : 0, ready: s.ready, out: playing ? s.out : false, you: role === "seat" && k === i })),
    specs: t.specs.length, turn: playing ? t.turn : -1, target: playing ? tblNextActive(t, t.turn) : -1, result: t.result, log: [...t.log],
  };
  if (t.game === "arcade") return arView(t, cid, v);   // 俄羅斯方塊：每台機台的狀態、聯機狀況；phase 依「我自己是不是正在玩」
  if (t.game === "hockey") {   // 空氣曲棍球：進行中附上 seed、開始時間、伺服器時間、時間上限、目標分數
    if (t.g && playing) v.hk = { seed: t.g.seed, t0: t.g.t0, sn: Date.now(), lim: HK_LIM_MS, goals: HK_GOALS };
    return v;
  }
  if (t.game === "maze") {   // 豆豆迷宮：誰當豆豆（開局前＝桌主指定的人）、分數／關卡／離開；進行中附上 seed、開始時間、伺服器時間、幽靈位置分配
    v.pac = playing && t.g ? t.g.pac : mzPacIdx(t);
    t.seats.forEach((s, k) => Object.assign(v.seats[k], { sc: s.sc || 0, lvl: s.lvl || 1, left: !!s.left }));
    if (t.g && playing) v.mz = { seed: t.g.seed, t0: t.g.t0, sn: Date.now(), pac: t.g.pac, gh: [...t.g.gh], solo: t.g.solo, lim: MZ_VS_MS };
    return v;
  }
  if (t.game === "mage") {   // 見習驅魔師：血量／擊殺數／倒下／離開；進行中附上 seed、難度、人數、已擊殺的幽靈編號、Boss 血量與被打中的次數
    v.diff = t.diff || 0;
    t.seats.forEach((s, k) => { v.seats[k].hp = Math.max(0, s.hp || 0); v.seats[k].syms = s.syms || 0; v.seats[k].dead = !!s.dead; v.seats[k].left = !!s.left; });
    if (t.g && playing) v.mg = { seed: t.g.seed, t0: t.g.t0, sn: Date.now(), diff: t.g.diff, n: t.g.n, killed: Object.keys(t.g.killed).map(Number), prog: Object.entries(t.g.prog).map(([x, y]) => [Number(x), y]), boss: t.g.boss, dmg: t.g.dmg, hits: t.g.hits };
  } else if (t.game === "dodge") {   // 躲彈幕：每個座位的命數／淘汰秒數／是否已離開；進行中附上 seed 與開始時間（彈幕由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
    t.seats.forEach((s, k) => { v.seats[k].lives = s.lives || 0; v.seats[k].died = s.died ?? null; v.seats[k].left = !!s.left; v.seats[k].bonus = s.bonus || 0; });
    if (t.g && playing) v.dg = { seed: t.g.seed, t0: t.g.t0, dur: DG_DUR, sn: Date.now(), n: t.g.n, taken: [...t.g.taken], fx: [...t.g.fx] };
  } else if (isTy(t)) {   // 英打／中文打字競賽：每個座位的分數／是否已離開；進行中附上 seed 與開始時間（題目由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
    t.seats.forEach((s, k) => { v.seats[k].score = s.score || 0; v.seats[k].left = !!s.left; });
    if (t.g && playing) v.ty = { seed: t.g.seed, t0: t.g.t0, dur: TY_DUR, sn: Date.now() };
  } else if (t.game === "intel") {   // 秘藥情報戰：情報區公開；身分只給本人、已出局／離開的人、觀戰者（使用者定：觀戰者看得到全部資訊）
    const all = role === "spec";
    t.seats.forEach((s, k) => {
      const vs = v.seats[k];
      vs.intel = playing ? [...(s.intel || [])] : []; vs.left = !!s.left;
      if (playing && (all || s.out || s.left || s.exposed || (role === "seat" && k === i))) vs.role = s.role;   // exposed：被解藥師「公開」暴露的陣營
      if (playing && t.g && t.g.chars) {   // 角色卡：公開型選完就翻開；隱藏型只有本人與觀戰者看得到；選角中只看得到「選好了沒」
        vs.picked = !!s.char; vs.up = !!s.faceUp;
        if (s.char && (all || s.faceUp || (role === "seat" && k === i))) vs.char = s.char;
        if (role === "seat" && k === i && s.choices) v.choices = [...s.choices];
        if (all && s.choices) vs.choices = [...s.choices];
      }
    });
    if (playing && t.g) {
      const g = t.g, L = g.letter;
      v.it = {
        step: g.step, deck: g.deck.length, discard: g.discard.length, deadline: g.deadline, sn: Date.now(),
        untimed: !!g.untimed, blocked: [...(g.blocked || [])], locked: [...(g.locked || [])], arrive: g.arrive && L ? { at: L.at, ok: [...g.arrive.ok] } : null, ack: g.ack ? { by: g.ack.by, ok: [...g.ack.ok] } : null,
        letter: L ? { from: L.from, at: L.at, seen: [...L.seen], kind: L.kind, open: !!L.open, next: itFwdTarget(t, L), icpt: L.icpt ?? null } : null,
        pend: g.pend ? { a: g.pend.a, by: g.pend.by, tgt: g.pend.tgt, until: g.pend.until, ok: [...g.pend.ok], chain: itChain(g.pend) } : null,
      };
      v.it.ask = g.ask ? { by: g.ask.by, tgt: g.ask.tgt } : null;   // 等誰回答查驗
      v.it.chars = !!g.chars; v.it.deaths = g.deaths.map(d => ({ seat: d.seat }));   // 角色卡模式；出局順序（公開）
      v.it.prompt = g.prompt ? { kind: g.prompt.kind, seat: g.prompt.seat, until: g.prompt.until } : null;   // 等誰做技能決定
      if (role === "seat" && g.prompt && g.prompt.seat === i) v.prompt = itPromptData(t, g.prompt);
      t.seats.forEach((s, k) => { if (g.chars && s.char) v.seats[k].used = !!s.onceUsed; });
      if (role === "seat" && g.chars) { v.aimed = t.seats[i].aimTurn === g.turnNo; v.shot = t.seats[i].shotTurn === g.turnNo; }   // 狙擊手：瞄準／亂槍打鳥這回合用過了   // 狙擊手「瞄準」這回合用過了   // 一局一次的技能用過沒（公開）
      if (role === "seat" && g.chars && itSkillReady(t, i, "doubleagent") && !t.seats[i].onceUsed) v.deckDouble = [...new Set(g.deck.filter(c => itCols(c).length === 2))];   // 雙面人生可以找的雙色牌
      const ex = itExtOf(g, false);
      v.it.ext = ex ? { by: [...ex.by], skip: [...ex.skip] } : null;   // 目前這段倒數的加時（誰按了、誰跳過了）
      t.seats.forEach((s, k) => { v.seats[k].ext = s.extLeft ?? 0; });   // 每人本局還剩幾次加時
      if (L && (all || L.kind === "pub" || L.open)) v.it.letter.card = L.card;                 // 觀戰者：看得到密函；公開情報：所有人都看得到
      else if (L && role === "seat" && L.from === i) v.it.letter.card = L.orig;     // 投遞的人：只知道自己送出的是哪張（被調包了也不知道）
      if (role === "seat") { v.hand = [...t.seats[i].hand]; v.note = t.seats[i].note || null; v.stolen = t.seats[i].stolen || null; }
      if (all) v.hands = t.seats.map(s => [...s.hand]);
    }
  } else if (t.g && t.game === "trigon") {   // Blokus Trigon：棋盤（702 個字元：0 空／1～4 顏色，格子編號 y * 39 + x）、各座位顏色、每人用掉的方塊、最後一手、期限；全部公開
    const g = t.g;
    v.tg = { board: g.board.join(""), col: [...g.col], corner: [...g.corner], used: g.sd.map(d => [...d.used]), done: g.sd.map(d => d.done), last: g.last, moves: g.moves, deadline: playing ? g.deadline : 0, sn: Date.now() };
    if (playing) t.seats.forEach((s, k) => { v.seats[k].left = !!s.left; v.seats[k].rem = tgRem(g, k); });
  } else if (t.g && t.game === "bigtwo") {   // 大老二：桌面上最後一手、連續 pass 數、期限；手牌走共通的 hand／hands（觀戰者看得到每個人的牌）
    btView(t, cid, v);
  } else if (t.g && t.game === "kingdom") {   // 列島建國：整個盤面公開（市場、資源、各人的王國），只有自己保留的牌看得到內容
    kgView(t, cid, v);
  } else if (t.g && t.game === "blokus") {   // Blokus：棋盤（400 個字元：0 空／1～4 顏色）、各座位顏色、每人用掉的方塊、最後一手、期限（sn＝伺服器現在時間，客戶端對時用）；全部公開
    const g = t.g;
    v.bk = { size: bkSize(g), start: g.col.map((c, k) => [...bkStartOf(g, k)]), board: g.board.join(""), col: [...g.col], used: g.sd.map(d => [...d.used]), done: g.sd.map(d => d.done), last: g.last, moves: g.moves, deadline: playing ? g.deadline : 0, sn: Date.now() };
    if (playing) t.seats.forEach((s, k) => { v.seats[k].left = !!s.left; v.seats[k].rem = bkRem(g, k); });
  } else if (t.g && t.game === "gomoku") {   // 五子棋：棋盤（225 個字元：0 空／1 黑／2 白）、最後一手、執黑的座位、連線的五子（結束時）；棋盤公開，觀戰者也看得到
    v.board = t.g.board.join(""); v.last = t.g.last; v.black = t.g.black; v.line = t.g.line; v.moves = t.g.moves || [];   // moves：每一手的座標（偶數手＝黑棋）；結束後客戶端用來復盤
  }
  if (t.game === "intel") { v.untimed = !!t.untimed; v.chars = !!t.chars; }   // 模式（桌主在開局前選）：限時／不限時
  if (t.game === "uno") v.mode = t.mode || "classic";   // 玩法（桌主在開局前選）：classic 傳統／wild 無限制
  if (t.game === "uno" && playing && t.g) {   // UNO：目前顏色、方向、最上面一張、牌堆張數、這回合的期限（sn＝伺服器現在時間，客戶端對時用）、誰沒喊 UNO（可以抓）、累積加牌張數、是否正被跳過
    const g = t.g;
    v.un = { color: g.color, dir: g.dir, top: g.discard[g.discard.length - 1], deck: g.deck.length, drawn: g.drawn, pend: g.pend, pending: g.pending, skip: g.skip, deadline: g.deadline, sn: Date.now() };
    t.seats.forEach((s, k) => { v.seats[k].left = !!s.left; });
    if (role === "seat") {
      const me = t.seats[i], mine = i === t.turn;
      v.playable = mine ? me.hand.map((c, k) => k).filter(k => unPlayable(g, me.hand, me.hand[k]) && (!g.drawn || k === me.hand.length - 1)) : [];
      if (g.mode === "wild") {   // 無限制：有累積加牌時可以吃下；沒牌可出時可以一直抽；被跳過時只能出跳過牌或放棄
        v.canDraw = mine && (g.pending > 0 || (!g.skip && !unHasPlayable(t, i)));
        v.canPass = mine && (g.skip || (g.pending === 0 && !unHasPlayable(t, i) && !g.deck.length && g.discard.length <= 1));
      } else { v.canDraw = mine && !g.drawn; v.canPass = mine && g.drawn; }
    }
  }
  if (role === "spec" && playing && (t.game === "oldmaid" || t.game === "uno" || t.game === "bigtwo")) v.hands = t.seats.map(s => [...s.hand]);   // 觀戰者看得到每個人的手牌（使用者要求，2026-11-08），順序＝對手看到的牌背順序
  if (role === "seat" && playing && (t.game === "oldmaid" || t.game === "uno" || t.game === "bigtwo")) {
    v.hand = [...t.seats[i].hand];   // 照伺服器順序（不排序）：對方抽的第 k 張牌背＝這裡從左數第 k 張
  }
  return v;
}
// seated＝入座中的連線編號：客戶端在他們的名牌後面加「入座中／遊戲中」
const tblInfo = t => ({ game: t.game, n: t.seats.length, s: t.specs.length, max: GAME_LIMITS[t.game][1], play: t.phase === "playing", seated: t.seats.map(s => s.cid), ...(t.game === "arcade" ? arInfo(t) : {}) });

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
    this.lastXpMob = new Map();      // ws → 上次擊倒非主動怪的時間（XP 夾頻；2026-11-07）
    this.lastDeathCredit = new Map();   // ws → 上次倒地記帳的時間（DEATH_CREDIT_MIN_MS）
    this.tables = new Map();         // 桌 id → 牌桌狀態（和平島遊戲桌；懶載入 storage，每次變動都寫回）
    this.lastTbl = new Map();        // ws → 上次牌桌操作的時間（TBL_CD_MS）
    this.lastTblPos = new Map();     // ws → 上次躲彈幕位置回報的時間（TBL_POS_CD_MS）
    this.lastTblTyp = new Map();     // ws → 上次英打進度回報的時間（TBL_TYP_CD_MS）
    this.lastGameXp = new Map();     // 帳號 id → 上次玩小遊戲得 XP 的時間（GAME_XP_CD_MS；只放記憶體，休眠後重置無妨）
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
    this.broadcast({ t: "dragon", ev: "say", x: d.pos[0], y: d.pos[1], ms: D_SAY_MS, line: q.line, lvl: dlLv(d.xp) }, null, terrain);
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
      this.broadcast({ t: "dragon", ev: "qfire", skill, i: q.fired, x: d.pos[0], y: d.pos[1], lvl: dlLv(d.xp), ids: this.quoteTargets(terrain, skill, d) }, null, terrain);
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

  // 記一次 XP（登入者）：經 Registry 累加、更新這條連線的 att.xp／state.lvl、回給本人（不廣播）。
  // await 之後要重讀 attachment（hello／state 可能在等 Registry 的期間先到，與 hello 處理同一慣例）
  async grantXp(ws, d, k) {
    const att = ws.deserializeAttachment() || {};
    if (!att.user || !Number.isInteger(d) || d === 0) return;
    const r = await this.registryCall("/addxp", { uid: att.user.id, d });
    if (!r || typeof r.xp !== "number") return;   // Registry 掛了：這次不記不回，等下次事件再算
    const cur = ws.deserializeAttachment() || {};
    cur.xp = r.xp;
    cur.xpKnown = true;
    if (cur.state) cur.state.lvl = xpInfo(r.xp).lv;   // 自己的名牌與之後的 p 廣播即時跟上
    ws.serializeAttachment(cur);
    try { ws.send(JSON.stringify({ t: "xp", xp: r.xp, d, k })); } catch { /* 對方已斷線 */ }
  }
  // 擊倒島主：獎勵 XP 給 D_DROPOUT（30 秒）內打過牠、還在線沒死的所有連線（與擊倒稱號「參與擊倒」同一批人）。
  // 訪客不進 Registry：grantXp 自然跳過，由各客戶端在 dead 事件本機補發
  async rewardOwnerKill(terrain, lv) {
    const amt = ownerKillXp(lv);
    for (const att of this.aggroCandidates(Date.now(), terrain)) {
      const ws = this.socketById(att.id, terrain);   // aggroCandidates 回 attachment：用連線編號找回 socket
      if (!ws) continue;
      await this.grantXp(ws, amt, "owner");
      const a = ws.deserializeAttachment() || {};
      if (a.user) {   // 擊倒島主紀錄跟著帳號（稱號／發光武器外觀換電腦也在）
        const r = await this.registryCall("/kills", { uid: a.user.id, add: [terrain] });
        if (r) try { ws.send(JSON.stringify({ t: "kills", kills: r.kills || {} })); } catch { /* 對方已斷線 */ }
      }
    }
  }
  // 擊倒深海魚人：同上（牠的參與者名單用 lurkHits；獎勵按牠被擊倒當下的等級）
  async rewardLurkerKill(terrain, lv) {
    const amt = lurkKillXp(lv);
    for (const att of this.aggroCandidates(Date.now(), terrain, L_DROPOUT, this.lurkHits)) {
      const ws = this.socketById(att.id, terrain);
      if (ws) await this.grantXp(ws, amt, "lurk");
    }
  }
  // 島主／深海魚人擊倒玩家的等級記帳（第 3 步）：死因都是客戶端自判（state.dead 0→1），伺服器用「誰在追他」推斷凶手——
  // 該地形魚人的 aggro.id 是死者＝牠殺的（session 等級 +1、血量上限 +5 並回一點血）；
  // 否則該地形島主活著就記牠的 XP（爪擊／龍衝／石化／波動砲／台詞招式都可能害死；石化每秒扣 1 的 tick 不隨等級變）。
  // 島主得 XP＝10＋2×受害者等級、順手回一點血；XP 存在 dragon:<地形>（等級存一起、永不重置）
  async creditMobKill(att) {
    const terrain = att.terrain, L = this.lurkers.get(terrain);
    if (L && L.aggro && L.aggro.id === att.id) {
      L.lvl = (L.lvl || 1) + 1;
      L.max = lurkerMaxHp(L);
      L.hp = Math.min(L.max, L.hp + L_HP_UP);
      this.broadcast({ t: "lurker", ev: "hp", hp: L.hp, lvl: L.lvl, max: L.max }, null, terrain);
      return;
    }
    const d = this.dragons.get(terrain);
    if (!d || d.st === "dead") return;   // 沒有島主／已被擊倒：記不到任何人頭上
    // 受害者等級：只有登入、且等級是伺服器存檔算出來的才採用；訪客／還沒有紀錄的人 state.lvl 是客戶端自己報的，一律當 Lv 1（防謊報灌島主 XP）
    const vl = att.user && att.xpKnown ? Math.max(1, Math.floor((att.state && att.state.lvl) || 1)) : 1;
    d.xp = Math.max(0, (d.xp ?? 0)) + 10 + 2 * vl;
    d.hp = Math.min(dragonMaxHp(d), d.hp + DL_HP_UP);
    await this.saveDragonLazy(terrain);
    this.broadcast(dragonHpMsg(d), null, terrain);
  }

  // 玩家等級（打島主／魚人的傷害上限用）：登入且伺服器有存檔才採用存檔等級，其餘一律 Lv 1（不信客戶端自報的 state.lvl）
  playerLvlOf(att) {
    return att && att.user && att.xpKnown && typeof att.xp === "number" ? xpInfo(att.xp).lv : 1;
  }

  // 釣魚：魚上鉤後拉竿成功 → 伺服器抽一條魚回給這條連線；登入的人同時記進 Registry 的圖鑑（帶回最新紀錄）
  async fishCatch(ws, att) {
    const now = Date.now();
    if (now - (this.lastFish.get(ws) || 0) < FISH_CD_MS) return;
    this.lastFish.set(ws, now);
    const db = await this.getFishDB();
    const res = rollFish(db, att.terrain);
    // 極低機率釣到敵對怪物（該地形沒有其他還在的怪物時才會）：不記圖鑑，改成在浮標旁落地追殺釣到牠的人
    if (!res.escaped && db.lurker && !(db.noLurker || []).includes(att.terrain) && !this.lurkers.has(att.terrain) && Math.random() < (db.lurkerChance || 0)   // noLurker：和平島不會釣到
        && await this.spawnLurker(ws, att, String(db.lurker), now)) {
      try { ws.send(JSON.stringify({ t: "fish_result", terrain: att.terrain, lurker: String(db.lurker), saved: false })); } catch { /* 對方已斷線 */ }
      return;
    }
    const out = { t: "fish_result", ...res, saved: false };
    const user = (ws.deserializeAttachment() || {}).user;   // 重讀：hello 可能剛驗證完
    if (!res.escaped && user) {
      const r = await this.registryCall("/catch", { uid: user.id, terrain: res.terrain, id: res.id, size: res.size });
      if (r && r.entry) {
        Object.assign(out, { saved: true, entry: r.entry, isNew: r.isNew, isRecord: r.isRecord });
        await this.grantXp(ws, r.isNew ? 5 : 1, r.isNew ? "first" : "fish");   // 釣到 +1、圖鑑首捕 +5（2026-11-07）
      }
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
    if (att.table) await this.tableLeave(ws);   // 換地形：離開牌桌（牌局進行中就結束這一局）
    att = ws.deserializeAttachment() || att;
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
    if (TABLE_DEFS[v]) ws.send(JSON.stringify(await this.tableInfoMsg(v)));   // 和平島：給這位玩家各桌目前的人數／狀態
    this.broadcast({ t: "join", id: att.id, name: att.state && att.state.name }, ws, v);
    if (att.state) this.broadcast({ t: "p", id: att.id, s: att.state }, ws, v);
  }


  // ---- 和平島遊戲桌 ----
  tableGame(tid) {
    for (const defs of Object.values(TABLE_DEFS)) if (defs[tid]) return defs[tid];
    return null;
  }
  liveIds() { return new Set(this.state.getWebSockets().map(w => (w.deserializeAttachment() || {}).id)); }
  // 載入一桌（沒有就建立空桌）；載入時把已經不在線的連線踢出（DO 重啟／斷線當下沒處理到的）
  // 列島建國的牌庫（client/assets/kingdom/cards.json，模組層級快取；載入失敗回 false，下次再試）
  async kgLoad() {
    if (KG) return true;
    try {
      const res = await this.env.ASSETS.fetch(new Request("https://assets.local/assets/kingdom/cards.json"));
      kgSetData(await res.json());
      return true;
    } catch (e) {
      console.log("[kingdom] cards.json 載入失敗", String(e));
      return false;
    }
  }
  async getTable(tid) {
    let t = this.tables.get(tid);
    if (t) return t;
    const game = this.tableGame(tid);
    if (!game) return null;
    if (game === "kingdom" && !(await this.kgLoad())) return null;   // 列島建國的牌庫要先從 assets 讀進來（載入失敗＝這張桌開不了，其他遊戲不受影響）
    t = (await this.state.storage.get("table:" + tid)) || tblNew(tid, game);
    if (BOARD_GAMES.has(game)) t.board = (await this.getBoards())[boardKey(game)] || [];   // 排行榜（前三名）
    const alive = this.liveIds();
    for (const m of [...t.seats, ...t.specs]) if (!alive.has(m.cid)) tblLeave(t, m.cid);
    this.tables.set(tid, t);
    return t;
  }
  async saveTable(t) {
    if (!t.seats.length && !t.specs.length) { this.tables.delete(t.id); await this.state.storage.delete("table:" + t.id); }
    else await this.state.storage.put("table:" + t.id, t);
  }
  sendToId(cid, msg) {
    const data = JSON.stringify(msg);
    for (const w of this.state.getWebSockets()) {
      if ((w.deserializeAttachment() || {}).id === cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
    }
  }
  tableNotify(t) { for (const m of [...t.seats, ...t.specs]) this.sendToId(m.cid, { t: "table", id: t.id, v: tblView(t, m.cid) }); }
  async tableInfoMsg(terrain) {
    const info = {};
    for (const [tid, game] of Object.entries(TABLE_DEFS[terrain] || {})) {
      const t = await this.getTable(tid);
      info[tid] = t ? tblInfo(t) : { game, n: 0, s: 0, max: GAME_LIMITS[game][1], play: false };
    }
    return { t: "tblinfo", info };
  }
  async tableBroadcastInfo(terrain) { this.broadcast(await this.tableInfoMsg(terrain), undefined, terrain); }
  // 離開牌桌（Esc、換地形、斷線）：牌局進行中就結束這一局
  async tableLeave(ws) {
    const att = ws.deserializeAttachment() || {};
    const tid = att.table;
    if (!tid) return;
    att.table = null;
    try { ws.serializeAttachment(att); } catch { /* 連線已關閉：記憶體裡的 att 已改，不影響後面的清理 */ }
    const t = await this.getTable(tid);
    if (!t) return;
    const resBefore = t.result;
    tblLeave(t, att.id);
    try { ws.send(JSON.stringify({ t: "table", id: tid, v: null })); } catch { /* 已斷線 */ }
    await this.saveTable(t);
    this.tableNotify(t);
    for (const [terr, defs] of Object.entries(TABLE_DEFS)) if (defs[tid]) await this.tableBroadcastInfo(terr);
    await this.tableXp(t, resBefore);   // 躲彈幕：最後一個活人離開會結束遊戲，留下的入座者照常得 XP
    await this.tableStats(t, resBefore);
    await this.tableBoard(t, resBefore);
  }
  // 排行榜：每座島一份，記在 storage 的 boards。2026-11-14 使用者定：今後上線都不清空排行榜（曾有過 BOARDS_REV 一次性清空機制，尚未上線就拿掉了）
  async getBoards() {
    if (!this.boards) this.boards = (await this.state.storage.get("boards")) || {};
    return this.boards;
  }
  // 暱稱改了：排行榜裡有這個 uid 的項目改成新的顯示名稱（有變動才存檔、通知正在看這桌的人）
  async boardRename(uid, name) {
    const boards = await this.getBoards();
    let changed = false;
    for (const list of Object.values(boards)) for (const e of list) if (e.uid === uid && e.name !== name) { e.name = name; changed = true; }
    if (!changed) return;
    await this.state.storage.put("boards", boards);
    for (const t of this.tables.values()) if (BOARD_GAMES.has(t.game)) { t.board = boards[boardKey(t.game)] || []; this.tableNotify(t); }
  }
  // 這個操作結束了一局：更新排行榜（沒離開、成績 > 0 的入座者；有變動才存檔並通知畫面）
  async tableBoard(t, resBefore) {
    const r = t.result;
    if (!BOARD_GAMES.has(t.game) || !r || r === resBefore || r.aborted || !r.ranking) return;
    if ((t.game === "arcade" || t.game === "maze") && !r.solo) return;   // 俄羅斯方塊／豆豆迷宮：聯機／對抗分數不進排行榜（使用者定）
    const ts = Date.now(), entries = t.game === "mage" ? (r.win && r.solo ? [{ name: r.ranking[0].name, uid: r.ranking[0].uid, score: r.score, ts }] : []) : r.ranking.filter(x => !x.left).map(x => ({ name: x.name, uid: x.uid, score: x.score, ts })).filter(e => e.score > 0);   // 見習驅魔師：只有單人勝利進排行榜
    if (!entries.length) return;
    const bk = boardKey(t.game), boards = await this.getBoards(), old = boards[bk] || [], nb = boardMerge(old, entries);
    if (JSON.stringify(nb.map(e => [e.uid, e.name, e.score])) === JSON.stringify(old.map(e => [e.uid, e.name, e.score]))) return;
    boards[bk] = nb; await this.state.storage.put("boards", boards); t.board = nb;
    await this.saveTable(t); this.tableNotify(t);
  }
  // 這個操作結束了一局：登入的入座者把這局的戰績（result.gs）記進帳號，再把整份戰績送給本人（訪客由客戶端本機套用）
  async tableStats(t, resBefore) {
    const r = t.result;
    if (!r || r === resBefore || r.aborted || !Array.isArray(r.gs) || !GS_GAMES.has(t.game)) return;
    for (let i = 0; i < t.seats.length; i++) {
      const gs = r.gs[i], cid = t.seats[i].cid;
      if (!gs || cid == null) continue;
      const ws2 = this.state.getWebSockets().find(w => (w.deserializeAttachment() || {}).id === cid), user = ws2 && (ws2.deserializeAttachment() || {}).user;
      if (!user) continue;
      const res = await this.registryCall("/gstats", { uid: user.id, game: t.game, add: gs.add, max: gs.max, min: gs.min });
      if (res) try { ws2.send(JSON.stringify({ t: "gstats", gstats: res.gstats || {} })); } catch { /* 對方已斷線 */ }
    }
  }
  // 這個操作結束了一局：登入的入座者各得 XP（訪客由客戶端看 result.xp 本機補發）；同一帳號 GAME_XP_CD_MS 內只算一次
  async tableXp(t, resBefore) {
    const r = t.result;
    if (!r || r === resBefore || r.aborted || !r.xp) return;
    for (let i = 0; i < t.seats.length; i++) {
      const n = r.xp[i] || 0, ws2 = n > 0 && t.seats[i].cid != null ? this.state.getWebSockets().find(w => (w.deserializeAttachment() || {}).id === t.seats[i].cid) : null;
      const user = ws2 && (ws2.deserializeAttachment() || {}).user;
      if (!user) continue;
      const nowMs = Date.now();
      if (nowMs - (this.lastGameXp.get(user.id) || 0) < GAME_XP_CD_MS) continue;
      this.lastGameXp.set(user.id, nowMs);
      await this.grantXp(ws2, n, "game");
    }
  }
  async tableMsg(ws, att, msg) {
    const now = Date.now(), a = msg.a;
    if (a === "pos" || a === "word" || a === "tb" || a === "ms" || a === "mp" || a === "hp" || a === "hs") {   // 躲彈幕的位置回報、英文打字競賽的分數回報、豆豆迷宮的快照／幽靈位置：自己的限流，不影響 hit／finish 等操作
      if (now - (this.lastTblPos.get(ws) || 0) < TBL_POS_CD_MS) return;
      this.lastTblPos.set(ws, now);
    } else if (a === "typ" || a === "sync") {   // 英文打字競賽的打字進度（只轉發給觀戰者）、見習驅魔師的每秒對時：自己的限流
      if (now - (this.lastTblTyp.get(ws) || 0) < TBL_TYP_CD_MS) return;
      this.lastTblTyp.set(ws, now);
    } else if (a === "kill" || a === "boss" || a === "clr") {   // 見習驅魔師的擊殺／打 Boss、俄羅斯方塊的消行：不限流（兩次之間本來就隔著一筆畫，限流反而會吃掉擊殺）
    } else {
      if (now - (this.lastTbl.get(ws) || 0) < TBL_CD_MS) return;
      this.lastTbl.set(ws, now);
    }
    const terr = att.terrain;
    if (!terr) return;
    if (a === "join") {
      const tid = String(msg.id || ""), game = (TABLE_DEFS[terr] || {})[tid];
      if (!game) return;
      if (att.table && att.table !== tid) await this.tableLeave(ws);
      const t = await this.getTable(tid);
      if (!t) return;   // 桌子載入失敗（例如列島建國的牌庫讀不到）
      const cur = ws.deserializeAttachment() || {};
      const pname = String((att.state && att.state.name) || (att.user && att.user.name) || `玩家${att.id}`).slice(0, 12);
      if (game === "arcade") arJoin(t, att.id, pname, msg.role === "spec" ? "spec" : "seat", att.user ? att.user.id : null, msg.cab);   // 俄羅斯方塊：坐哪一台由 cab 決定
      else tblJoin(t, att.id, pname, msg.role === "spec" ? "spec" : "seat", att.user ? att.user.id : null);
      cur.table = tid; ws.serializeAttachment(cur);
      await this.saveTable(t);
      this.tableNotify(t);
      await this.tableBroadcastInfo(terr);
      return;
    }
    const tid = (ws.deserializeAttachment() || {}).table;
    if (!tid) return;
    if (a === "leave") { await this.tableLeave(ws); return; }
    const t = await this.getTable(tid);
    if (!t) return;
    if (t.game === "arcade" && (a === "tb" || a === "clr")) {   // 俄羅斯方塊：盤面快照／垃圾行，只轉發（不存檔、不通知整個畫面、不廣播 tblinfo；分數記在記憶體，下一次存檔時一起寫）
      for (const [cid, m] of arMsg(t, att.id, msg, now)[1]) this.sendToId(cid, m);
      return;
    }
    if (t.game === "hockey" && (a === "hp" || a === "hs")) {   // 空氣曲棍球：握把位置／圓盤快照，只轉發（不存檔、不通知畫面）；時間上限過了才順便結算
      for (const [cid, m] of hkRelay(t, att.id, msg)) this.sendToId(cid, m);
      const resBefore = t.result;
      if (hkTick(t, now)) { await this.saveTable(t); this.tableNotify(t); await this.tableBroadcastInfo(terr); await this.tableXp(t, resBefore); }
      return;
    }
    if (t.game === "maze" && (a === "ms" || a === "mp")) {   // 豆豆迷宮：豆豆的快照／幽靈玩家的位置，只轉發（不存檔、不通知畫面）；對抗時間上限過了才順便結算
      for (const [cid, m] of mzRelay(t, att.id, msg)) this.sendToId(cid, m);
      const resBefore = t.result;
      if (mzTick(t, now)) { await this.saveTable(t); this.tableNotify(t); await this.tableBroadcastInfo(terr); await this.tableXp(t, resBefore); }
      return;
    }
    if (a === "pos") {   // 躲彈幕：位置回報，轉發給同桌其他人（不存檔、不通知畫面、不廣播 tblinfo）
      const [role, i] = tblFind(t, att.id);
      if (t.game === "dodge" && role === "seat" && t.phase === "playing" && !t.seats[i].out) {
        const x = Math.max(0, Math.min(DG_W, Number(msg.x) || 0)), y = Math.max(0, Math.min(DG_H, Number(msg.y) || 0));
        t.seats[i].px = x; t.seats[i].py = y;   // 道具撿取驗證用
        const data = JSON.stringify({ t: "tpos", i, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
        for (const m of [...t.seats, ...t.specs]) {
          if (m.cid == null || m.cid === att.id) continue;
          for (const w of this.state.getWebSockets()) if ((w.deserializeAttachment() || {}).id === m.cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
        }
      }
      return;
    }
    if (a === "miss") {   // 英文／中文打字競賽：我剛打錯一次，轉發 tmx {i} 給同桌其他人與觀戰者（對手的分數框閃紅；看不到字）；不存檔、不通知畫面
      const [role, i] = tblFind(t, att.id);
      if (!isTy(t) || role !== "seat" || t.phase !== "playing" || !t.g) return;
      const data = JSON.stringify({ t: "tmx", i });
      for (const m of [...t.seats, ...t.specs]) {
        if (m.cid == null || m.cid === att.id) continue;
        for (const w of this.state.getWebSockets()) if ((w.deserializeAttachment() || {}).id === m.cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
      }
      return;
    }
    if (a === "typ") {   // 英文打字競賽：打字進度 {n 第幾個字, p 已打對幾個字母, e 是否剛打錯}，只轉發給觀戰者（tpg）；不存檔、不通知畫面、沒人觀戰就什麼都不送
      const [role, i] = tblFind(t, att.id);
      const n = msg.n, p = msg.p;
      if (!isTy(t) || role !== "seat" || t.phase !== "playing" || !t.g) return;
      if (!Number.isInteger(n) || n < 0 || n > 100000 || !Number.isInteger(p) || p < 0 || p > 64) return;
      const data = JSON.stringify({ t: "tpg", i, n, p, e: msg.e === 1 ? 1 : 0 });
      for (const m of t.specs) {
        if (m.cid == null) continue;
        for (const w of this.state.getWebSockets()) if ((w.deserializeAttachment() || {}).id === m.cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
      }
      return;
    }
    if (a === "word") {   // 英文打字競賽：分數回報，轉發 tsc 給同桌其他人（不通知整個畫面、不廣播 tblinfo；storage 每 TY_SAVE_MS 才寫一次）
      if (!tyWord(t, att.id, msg.n, now)) return;
      const i = tblFind(t, att.id)[1], data = JSON.stringify({ t: "tsc", i, n: msg.n });
      for (const m of [...t.seats, ...t.specs]) {
        if (m.cid == null || m.cid === att.id) continue;
        for (const w of this.state.getWebSockets()) if ((w.deserializeAttachment() || {}).id === m.cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
      }
      if (now - (t.g.saved || 0) >= TY_SAVE_MS) { t.g.saved = now; await this.saveTable(t); }
      return;
    }
    const resBefore = t.result;
    dgCheckEnd(t, now);   // 時間到了就先結算（下面的動作若是 finish／hit 就只是確認）
    tyCheckEnd(t, now);
    itTick(t, now);   // 秘藥情報戰：識破時間過了就生效、逾時自動處理
    const mgChanged = mgTick(t, now);   // 見習驅魔師：沒被消除的幽靈扣血、勝負
    mzTick(t, now);   // 豆豆迷宮：對抗超過時間上限還沒結算
    hkTick(t, now);   // 空氣曲棍球：超過時間上限還沒結算
    if (t.game === "arcade" && AR_MSGS.has(a)) {   // 俄羅斯方塊：單人／聯機邀請／接受／拒絕／開始／結束
      const [changed, extra] = arMsg(t, att.id, msg, now);
      for (const [cid, m] of extra) this.sendToId(cid, m);
      if (!changed) return;
    }
    else if (t.game === "hockey" && HK_MSGS.has(a)) hkEnd(t, att.id, msg);   // 空氣曲棍球：桌主那台回報結束
    else if (t.game === "maze" && MZ_MSGS.has(a)) { if (a === "mpac") mzSetPac(t, att.id, msg.v); else mzOver(t, att.id, msg); }   // 豆豆迷宮：桌主指定豆豆／豆豆那台回報結束
    else if (t.game === "bigtwo" && BT_MSGS.has(a)) { if (!(a === "bplay" ? btPlay(t, att.id, msg.cs, now) : btPass(t, att.id, now))) return; }   // 大老二：出牌 {cs: [牌]}／pass
    else if (t.game === "kingdom" && KG_MSGS.has(a)) { if (!kgAct(t, att.id, msg, now)) return; }   // 列島建國：拿資源／保留／建造／交易／封鎖／跳過
    else if (t.game === "intel" && IT_MSGS.has(a)) itMsg(t, att.id, msg, now);   // 秘藥情報戰：投遞／收下／轉手／行動牌／逾時
    else if (a === "ready") tblReady(t, att.id, msg.v);
    else if (a === "sit") tblSit(t, att.id);
    else if (a === "stand") tblStand(t, att.id);
    else if (a === "draw") { if (t.game === "uno") unDraw(t, att.id, now); else omDraw(t, att.id, msg.idx); }   // UNO：抽牌；抽鬼牌：抽對方的牌
    else if (a === "shuffle") omShuffle(t, att.id);
    else if (a === "move") gmMove(t, att.id, msg.x, msg.y);
    else if (a === "play") unPlay(t, att.id, msg.idx, msg.color, now, msg.uno === true);   // UNO：出牌（idx、變色牌帶 color）
    else if (a === "pass") unPass(t, att.id, now);
    else if (a === "uno") unSay(t, att.id);
    else if (a === "catch") unCatch(t, att.id);
    else if (a === "timeout") { if (t.game === "bigtwo") btTimeout(t, now); else if (t.game === "kingdom") kgTimeout(t, now); else if (t.game === "blokus") bkTimeout(t, now); else if (t.game === "trigon") tgTimeout(t, now); else unTimeout(t, now); }   // UNO／Blokus：回合限時到了（伺服器核對時鐘）
    else if (a === "place") { if (t.game === "trigon") tgPlace(t, att.id, msg.p, msg.c, now); else bkPlace(t, att.id, msg.p, msg.c, now); }   // Blokus：放方塊 {p 第幾塊, c 佔用的格子座標}
    else if (a === "mode") unSetMode(t, att.id, msg.v);   // UNO：桌主在開局前選玩法（classic／wild）
    else if (a === "hit") dgHit(t, att.id, now);   // 躲彈幕：我被打到（客戶端自判，伺服器管命數與無敵時間）
    else if (a === "kill") mgKill(t, att.id, msg.i, msg.p, now);   // 見習驅魔師：我消除了幽靈 i（符號辨識在客戶端，伺服器驗時間與先到先得）
    else if (a === "boss") mgBossHit(t, att.id, msg.k, now);   // 見習驅魔師：我畫對了 Boss 的第 k 個符號
    else if (a === "mdiff") mgSetDiff(t, att.id, msg.v);   // 見習驅魔師：桌主選難度
    else if (a === "sync") { if (!mgChanged && t.phase === "playing") return; }   // 見習驅魔師：客戶端每秒一次，讓伺服器結算沒被消除的幽靈；沒有變化就不存檔、不通知畫面
    else if (a === "pick") dgPick(t, att.id, msg.n, now, msg.x, msg.y);   // 躲彈幕：我吃到道具 n（客戶端自判，伺服器驗時間／距離／先到先得並結算）
    else if (a === "finish") { dgCheckEnd(t, now + 300); tyCheckEnd(t, now + 300); }   // 躲彈幕／英文打字競賽：客戶端看時間到了請求結算（伺服器核對時鐘，沒到時間不理）
    else return;
    await this.saveTable(t);
    this.tableNotify(t);
    await this.tableBroadcastInfo(terr);
    await this.tableXp(t, resBefore);
    await this.tableStats(t, resBefore);
    await this.tableBoard(t, resBefore);
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
      let cur = ws.deserializeAttachment() || {};
      cur.user = user;
      cur.admin = !!user && isAdminId(this.env, user.id);
      let xpKnown = false;
      if (user) {   // 登入者：把伺服器存檔的 XP 讀回來（之後 state.lvl 與記帳都靠它）
        const r = await this.registryCall("/profile", { uid: user.id });
        cur = ws.deserializeAttachment() || {};   // 重讀：等 Registry 的期間可能有 state／enter 進來改過 attachment（不能用 await 前的舊值蓋掉）
        cur.user = user;
        cur.admin = !!user && isAdminId(this.env, user.id);
        if (r && typeof r.xp === "number") {
          cur.xp = Math.max(0, Math.min(XP_MAX, Math.floor(r.xp)));
          cur.xpKnown = xpKnown = !!r.has;
          if (cur.state) cur.state.lvl = xpInfo(cur.xp).lv;
        }
      }
      if (user) {   // 暱稱：存在 Registry，登入時讀回來（顯示名稱＝暱稱，沒設就是 Discord 名稱）
        const nr = await this.registryCall("/nick", { uid: user.id });
        cur = ws.deserializeAttachment() || {}; cur.user = user; cur.admin = !!user && isAdminId(this.env, user.id);
        cur.nick = nr ? nickClean(nr.nick) : "";
      }
      if (user && cur.state) cur.state = { ...cur.state, name: cur.nick || String(user.name).slice(0, NAME_MAX), uid: user.id };
      ws.serializeAttachment(cur);
      // me 的 uid／xpKnown：客戶端據此決定 XP 記帳走伺服器（xpKnown=false 時要把本機存檔一次性上繳）
      ws.send(JSON.stringify({ t: "me", admin: cur.admin, auth: !!user, uid: user ? user.id : null, xpKnown }));
      if (user) try { ws.send(JSON.stringify({ t: "nick", nick: cur.nick || "" })); } catch { /* 對方已斷線 */ }   // 我的暱稱（客戶端據此顯示自己的名字與設定面板）
      if (user) {   // 登入的人：送他存在伺服器的魚類圖鑑與 XP（XP 只在「伺服器有紀錄」時會收到 init；沒有就等 xpsync 上繳）
        const r = await this.registryCall("/dex", { uid: user.id });
        if (r) try { ws.send(JSON.stringify({ t: "dex", dex: r.dex || {} })); } catch { /* 對方已斷線 */ }
        if (cur.xpKnown) try { ws.send(JSON.stringify({ t: "xp", xp: cur.xp, d: 0, k: "init" })); } catch { /* 對方已斷線 */ }
        const cr = await this.registryCall("/craft", { uid: user.id, add: {} });   // 合成解鎖紀錄（素材圖鑑／配方筆記）
        if (cr) try { ws.send(JSON.stringify({ t: "craftdb", craft: cr.craft || {} })); } catch { /* 對方已斷線 */ }
        const kr = await this.registryCall("/kills", { uid: user.id, add: [] });   // 擊倒島主紀錄
        if (kr) try { ws.send(JSON.stringify({ t: "kills", kills: kr.kills || {} })); } catch { /* 對方已斷線 */ }
        const gr = await this.registryCall("/gstats", { uid: user.id });   // 遊戲戰績（稱號用）
        if (gr) try { ws.send(JSON.stringify({ t: "gstats", gstats: gr.gstats || {} })); } catch { /* 對方已斷線 */ }
      }
    } else if (msg.t === "state") {
      const s = sanitizeState(msg.s && typeof msg.s === "object" ? msg.s : {}, att.state);
      // 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）；等級以伺服器存檔為準（訪客照客戶端報的，只影響名牌）
      if (att.user) {
        s.name = att.nick || String(att.user.name).slice(0, NAME_MAX);
        s.uid = att.user.id;
        if (att.xpKnown && typeof att.xp === "number") s.lvl = xpInfo(att.xp).lv;
      }
      // 倒地扣 XP（2026-11-07）：死因都是客戶端自判（state.dead），伺服器只看「本連線首次 dead」抽 10%
      const wasDead = !!(att.state && att.state.dead);
      att.state = s;
      ws.serializeAttachment(att);
      if (att.terrain) this.broadcast({ t: "p", id: att.id, s }, ws, att.terrain);
      if (att.user && att.xpKnown && !wasDead && s.dead) {   // 0→1 的那一格才判
        const loss = xpDeathLoss(att.xp ?? 0);
        if (loss > 0 && Math.random() < .1) await this.grantXp(ws, -loss, "death");
      }
      if (!wasDead && s.dead && att.terrain) {   // 島主／魚人擊倒玩家的等級記帳（creditMobKill）；同一條連線最短間隔 DEATH_CREDIT_MIN_MS
        const nowD = Date.now();
        if (nowD - (this.lastDeathCredit.get(ws) || 0) >= DEATH_CREDIT_MIN_MS) {
          this.lastDeathCredit.set(ws, nowD);
          await this.creditMobKill(att);
        }
      }
    } else if (msg.t === "nick") {   // 改暱稱 {v}（空字串＝恢復 Discord 名稱）：只有登入者；存 Registry，之後的 state 帶新名字給大家；兩次最短間隔 NICK_CD_MS
      if (!att.user || Date.now() - (att.nickAt || 0) < NICK_CD_MS) return;
      att.nickAt = Date.now(); ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), nickAt: att.nickAt });
      const r = await this.registryCall("/nick", { uid: att.user.id, set: nickClean(msg.v) });
      if (!r) return;
      const cur = ws.deserializeAttachment() || {}, nick = nickClean(r.nick), name = nick || String(att.user.name).slice(0, NAME_MAX);
      cur.nick = nick;
      if (cur.state) cur.state = { ...cur.state, name };
      ws.serializeAttachment(cur);
      try { ws.send(JSON.stringify({ t: "nick", nick })); } catch { /* 對方已斷線 */ }
      await this.boardRename(att.user.id, name);
    } else if (msg.t === "xpsync") {   // 舊存檔一次性上繳（2026-11-07 使用者定 (a)）：伺服器沒有紀錄才收，有就回現值（冪等）
      const user = att.user;
      if (user) {
        const v = Math.max(0, Math.min(XP_MAX, Math.floor(Number(msg.v) || 0)));
        const r = await this.registryCall("/deposit", { uid: user.id, v });
        if (r && typeof r.xp === "number") {
          const cur = ws.deserializeAttachment() || {};
          cur.xp = r.xp;
          cur.xpKnown = true;
          if (cur.state) cur.state.lvl = xpInfo(r.xp).lv;
          ws.serializeAttachment(cur);
          try { ws.send(JSON.stringify({ t: "xp", xp: r.xp, d: 0, k: "init" })); } catch { /* 對方已斷線 */ }
        }
      }
    } else if (msg.t === "tbl") {   // 和平島遊戲桌（join／leave／ready／sit／draw）；牌局邏輯全在伺服器
      await this.tableMsg(ws, att, msg);
    } else if (msg.t === "craft") {   // 合成解鎖一筆（素材／家具／配方；客戶端自判，伺服器只存，不驗證 id 是否存在；訪客略過）
      if (att.user && CRAFT_KINDS.includes(msg.k) && ID_RE.test(String(msg.id))) {
        await this.registryCall("/craft", { uid: att.user.id, add: { [msg.k]: [String(msg.id)] } });
      }
    } else if (msg.t === "craftsync") {   // 補傳本機有、伺服器沒有的解鎖（訪客時期的進度併進帳號）；回整份 craftdb
      if (att.user) {
        const add = {};
        for (const k of CRAFT_KINDS) add[k] = (Array.isArray(msg[k]) ? msg[k] : []).slice(0, CRAFT_SYNC_MAX).map(String).filter(id => ID_RE.test(id));
        const r = await this.registryCall("/craft", { uid: att.user.id, add });
        if (r) try { ws.send(JSON.stringify({ t: "craftdb", craft: r.craft || {} })); } catch { /* 對方已斷線 */ }
      }
    } else if (msg.t === "xpe") {   // 擊倒非主動怪的 XP 事件（伺服器無法驗證：信任事件＋夾頻；2026-11-07 使用者同意）
      if (att.user && att.terrain && (msg.k === "mob" || msg.k === "petkill")) {
        const now = Date.now();
        if (now - (this.lastXpMob.get(ws) || 0) >= XP_MOB_CD_MS) {
          this.lastXpMob.set(ws, now);
          if (msg.k === "mob") {
            // 數量照客戶端帶的（會反擊的野怪＝島主經驗 1/10，2026-11-09 使用者同意延伸）；夾 1～XP_XPE_MAX，防亂報
            const n = Math.min(XP_XPE_MAX, Math.max(1, Math.floor(Number(msg.n) || 1)));
            await this.grantXp(ws, n, "mob");
          } else {   // 和平島殺寵懲罰（2026-11-13 使用者定）：扣「掉一等」＝這級累積＋前一級需求，Lv1 扣到 0。限定和平島；扣量照 Registry 現值自己算，不信任客戶端帶的數字
            if (att.terrain === "peace") {
              const pr = await this.registryCall("/profile", { uid: att.user.id });
              if (pr && typeof pr.xp === "number") {
                const i = xpInfo(pr.xp);
                const loss = i.lv > 1 ? i.cur + XP_NEED(i.lv - 1) : i.cur;
                if (loss > 0) await this.grantXp(ws, -loss, "petkill");
              }
            }
          }
        }
      }
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
    if (e.hp <= 0) await this.grantXp(ws, 1, "mine");   // 採集打壞 +1 XP（只有打壞的這條連線；2026-11-07）
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
      d = { hp: D_HP, st: "idle", pos: [...D_CENTER], aimTms: 0, deadAt: 0, wander: null, cooldownUntil: 0, sayUntil: 0, regenT: 0, aggro: null, lastHitAt: 0, xp: 0 };
      this.dragons.set(terrain, d);
    }
    if (d.xp === undefined) d.xp = 0;   // 第 3 步前的舊存檔沒有等級 XP 欄位
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
  // 依連線編號找回 WebSocket（aggroCandidates 回的是 attachment，獎勵記帳與送訊息需要 socket 本體）
  socketById(id, terrain) {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id === id && att.terrain === terrain && att.state) return ws;
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
    const mx = dragonMaxHp(d);
    if (d.st === "dead" || d.hp >= mx) { d.regenT = now; return; }
    const n = Math.floor((now - d.regenT) / 1000);
    if (n > 0) {
      d.hp = Math.min(mx, d.hp + n * D_REGEN);
      d.regenT = d.hp >= mx ? now : d.regenT + n * 1000;
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
    if (style === "gaze" || style === "beam" || style === "command") {   // 原地施放（石化之瞳開眼／波動砲讀條／命令讀條）：不瞬移不移動，放完就地回 idle
      const castMs = style === "gaze" ? D_GAZE_CAST_MS : style === "beam" ? D_BEAM_CAST_MS : D_COMMAND_CAST_MS;
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
    if (style === "command") return d.aimTms + D_COMMAND_CAST_MS;
    return d.aimTms + D_CAST_MS + d.dashLen / D_DASH * 1000 + D_REST_MS;
  }
  dragonSnapshot(terrain) {
    const now = Date.now();
    this.regenDragon(terrain, now);   // 讀快照前先把該補的血補上（快照帶 hp）
    const [ph, pos, ms] = this.dragonPhase(terrain, now);
    const d = this.dragons.get(terrain);
    const o = { ph, x: pos[0], y: pos[1], hp: d.hp, lvl: dlLv(d.xp), max: dragonMaxHp(d) };
    if (d.aggro) o.aggro = d.aggro.id;   // 仇恨中：附上追殺目標（中途進場的人才知道牠在戰鬥）
    if (ph === "aim") { o.castMs = Math.round(ms); o.tx = d.atk[0]; o.ty = d.atk[1]; o.dx = d.dest[0]; o.dy = d.dest[1]; }
    if (ph === "cast") {
      o.castMs = Math.round(ms);
      if (d.command) o.kind = d.command;   // 命令：行動還是靜止（中途進場的人也要知道）
      else { o.tx = d.atk[0]; o.ty = d.atk[1]; o.bx = d.beam[0]; o.by = d.beam[1]; }   // 石化之瞳：開眼中（直線已鎖定）
    }
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
    let dmg = sk ? sk.dmg : Math.max(1, Math.min(dlHitMax(this.playerLvlOf(att)), Math.round(Number(msg.dmg) || 1)));   // 夾值隨攻擊者等級放寬（dlHitMax）；等級由伺服器決定（訪客 Lv 1，不信 state.lvl）
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
    if (d.hp <= 0) {   // 打倒了：全地形廣播死亡（帶等級，給訪客本機算獎勵用），30 秒後用鬧鐘重生
      const killLv = dlLv(d.xp);   // 獎勵按被擊倒當下的等級；xp 不清零（島主等級存一起、永不重置）
      d.st = "dead"; d.hp = 0; d.pos = [pos[0], pos[1]]; d.aimTms = 0; d.deadAt = now; d.wander = null; d.aggro = null; d.quote = null; d.sayUntil = 0;
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "dead", x: pos[0], y: pos[1], lvl: killLv }, null, terrain);
      await this.rewardOwnerKill(terrain, killLv);   // Registry 的 XP 獎勵（30 秒內的參與者）
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
    this.broadcast(dragonHpMsg(d), null, terrain);
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
      if (st2 !== "gaze" && st2 !== "beam" && st2 !== "command") d.pos = [...d.dest];   // 龍衝落在對岸；石化之瞳／波動砲／命令沒有位移，留在原地
      await this.saveDragon(terrain);
    }
    const dist = Math.hypot(att.state.x - pos[0], att.state.y - pos[1]);
    if (dist <= D_CLAW_RANGE) {   // 進爪擊範圍：站定連抓（每秒一下）；記下位置，快照不會跳回舊點
      d.pos = [pos[0], pos[1]];
      d.wander = null;
      if (now >= ag.clawAt) {
        ag.clawAt = now + D_CLAW_MS;
        await this.saveDragonLazy(terrain);
        this.broadcast({ t: "dragon", ev: "claw", x: pos[0], y: pos[1], tx: att.state.x, ty: att.state.y, lvl: dlLv(d.xp), id: att.id }, null, terrain);
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
    const mx = dragonMaxHp(d);
    if (d.st === "dead" || d.hp >= mx) { this.regenDragon(terrain, now); return false; }
    const before = d.hp;
    this.regenDragon(terrain, now);
    if (d.hp !== before) {
      await this.saveDragonLazy(terrain);
      this.broadcast(dragonHpMsg(d), null, terrain);
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
    if (d.st !== "dead") {   // 帶傷：散步鬧鐘提前到「回滿血時刻」，醒來補滿並廣播一次（滿血＝目前等級的血量上限）
      const mx = dragonMaxHp(d);
      if (d.hp < mx) at = Math.min(at, d.regenT + Math.ceil((mx - d.hp) / D_REGEN) * 1000);
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
    if (style === "gaze" || style === "beam" || style === "command") {   // 原地施放：石化之瞳開眼／波動砲讀條／命令讀條（命令隨機二選一，檢定在各客戶端本地）
      d.command = style === "command" ? (Math.random() < .5 ? "act" : "still") : null;
      if (style !== "command") {   // gaze／beam：直線朝攻擊者方向鎖到島緣對岸（光束幾何）
        const ux = ax - d.pos[0], uy = ay - d.pos[1];
        const ul = Math.hypot(ux, uy) || 1;
        d.unit = [ux / ul, uy / ul];
        d.beam = dragonDashDest(map, d.pos[0], d.pos[1], d.unit[0], d.unit[1]);
      }
      d.aimTms = now;
      const castMs = style === "gaze" ? D_GAZE_CAST_MS : style === "beam" ? D_BEAM_CAST_MS : D_COMMAND_CAST_MS;
      d.cooldownUntil = now + castMs + D_RAGE_MS;
      await this.saveDragon(terrain);
      const ev = style === "gaze" ? "gaze" : style === "beam" ? "beam" : "command";
      const msg = { t: "dragon", ev, x: d.pos[0], y: d.pos[1], castMs, hp: d.hp, lvl: dlLv(d.xp), max: dragonMaxHp(d) };
      if (style === "command") msg.kind = d.command;
      else { msg.tx = ax; msg.ty = ay; msg.bx = d.beam[0]; msg.by = d.beam[1]; }
      this.broadcast(msg, null, terrain);
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
    this.broadcast({ t: "dragon", ev: "aim", x: warp[0], y: warp[1], fx: d.pos[0], fy: d.pos[1], tx: ax, ty: ay, dx: d.dest[0], dy: d.dest[1], castMs: D_CAST_MS, hp: d.hp, lvl: dlLv(d.xp), max: dragonMaxHp(d) }, null, terrain);
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
      d.st = "idle"; d.hp = dragonMaxHp(d); d.pos = pos; d.aimTms = 0; d.wander = null; d.sayUntil = 0; d.aggro = null; d.quote = null; d.command = null;
      await this.saveDragon(terrain);
      this.broadcast({ t: "dragon", ev: "spawn", x: pos[0], y: pos[1], hp: d.hp, lvl: dlLv(d.xp), max: dragonMaxHp(d) }, null, terrain);
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
      if (d.aimTms) {   // 反擊循環剛結束：龍衝落在對岸（dest）清掉 aimTms 讓散步插值生效；石化之瞳／波動砲／命令留在原地
        d.aimTms = 0;
        const style = OWNER_TERRAINS[terrain];
        if (style !== "gaze" && style !== "beam" && style !== "command") d.pos = [...d.dest];
      }
      // 帶傷回血：補血（滿血那一刻醒來廣播一次的事由 wanderWake 的提前量處理，不用定期輪詢）
      const damaged = d.st !== "dead" && d.hp < dragonMaxHp(d);
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
    const now = Date.now(), pos = this.lurkerPos(L, now), o = { mob: L.mob, x: pos[0], y: pos[1], hp: L.hp, max: L.max, lvl: L.lvl || 1, aggro: L.aggro.id };
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
    this.lurkers.set(terrain, { mob, hp: L_HP, max: L_HP, lvl: 1, pos, wander: null, lastHitAt: now,
                                aggro: { id: att.id, rotateAt: now + D_AGGRO_MS, clawAt: now + L_CLAW_MS } });
    this.lurkHits.set(ws, { terrain, t: now });   // 釣到牠的人視同攻擊者（仇恨換人的候選池）
    this.broadcast({ t: "lurker", ev: "spawn", terrain, mob, x: pos[0], y: pos[1], fx, fy, hp: L_HP, max: L_HP, lvl: 1,
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
    L.hp -= sk ? sk.dmg : Math.max(1, Math.min(dlHitMax(this.playerLvlOf(att)), Math.round(Number(msg.dmg) || 1)));   // 夾值隨攻擊者等級放寬（dlHitMax）
    if (L.hp <= 0) {
      const killLv = L.lvl || 1;
      this.lurkers.delete(terrain);
      this.broadcast({ t: "lurker", ev: "dead", x: pos[0], y: pos[1], lvl: killLv }, null, terrain);
      await this.rewardLurkerKill(terrain, killLv);   // Registry 的 XP 獎勵（30 秒內的參與者；訪客由客戶端本機補）
      return;
    }
    this.broadcast({ t: "lurker", ev: "hp", hp: L.hp, lvl: L.lvl || 1, max: lurkerMaxHp(L) }, null, terrain);
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
        this.broadcast({ t: "lurker", ev: "claw", x: pos[0], y: pos[1], tx: att.state.x, ty: att.state.y, lvl: L.lvl || 1, id: att.id }, null, terrain);
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

  async webSocketClose(ws) { await this.tableLeave(ws); this.leave(ws); await this.flushDragons(true); }   // 有人離線就把節流中的島主狀態全部寫掉（之後可能沒人了，DO 隨時會休眠）
  async webSocketError(ws) { await this.tableLeave(ws); this.leave(ws); await this.flushDragons(true); }

  leave(ws) {
    this.rate.delete(ws);
    this.lastHit.delete(ws);
    this.lastSign.delete(ws);
    this.commitBucket.delete(ws);
    this.dragonHits.delete(ws);
    this.debuffs.delete(ws);
    this.skillHits.delete(ws);
    this.lastFish.delete(ws);
    this.lastXpMob.delete(ws);
    this.lastDeathCredit.delete(ws);
    this.lastTbl.delete(ws);
    this.lastTblPos.delete(ws);
    this.lastTblTyp.delete(ws);
    const att = ws.deserializeAttachment() || {};
    if (att.terrain) this.broadcast({ t: "leave", id: att.id }, ws, att.terrain);
  }
}

// ============ 全域 Registry（跨島的玩家資料；魚類圖鑑、腳色等級 XP、合成解鎖、擊倒島主紀錄、暱稱）============
// 全站只有一個實例（idFromName("global")），只由 Island 透過 REGISTRY 綁定呼叫，沒有對外的路由。
// 資料：dex:<Discord 使用者 ID> → { 地形: { 魚id: { max（最大尺寸 cm）, n（釣到次數）, first（第一次釣到的時間） } } }
//       xp:<Discord 使用者 ID> → 總 XP（整數；2026-11-07 腳色等級第 2 步）
//       craft:<Discord 使用者 ID> → { mat: {素材id: 解鎖時間}, furn: {家具id: 時間}, rec: {配方id: 時間} }（合成：素材圖鑑／配方筆記）
//       kills:<Discord 使用者 ID> → { 有島主的地形: 時間 }（擊倒島主紀錄，稱號用）
//       nick:<Discord 使用者 ID> → 暱稱（2026-11-13）
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
    if (url.pathname === "/craft") {   // 合成解鎖：add＝{mat:[id…], furn:[…], rec:[…]} 併進去（已有的不動；每類上限 CRAFT_MAX），回整份；add 空＝只讀
      const ck = "craft:" + uid, craft = (await this.state.storage.get(ck)) || {};
      let changed = false;
      const add = body.add && typeof body.add === "object" ? body.add : {};
      for (const k of CRAFT_KINDS) {
        const m = craft[k] || (craft[k] = {});
        for (const id of Array.isArray(add[k]) ? add[k] : []) {
          if (!ID_RE.test(String(id)) || m[id] || Object.keys(m).length >= CRAFT_MAX) continue;
          m[id] = Date.now(); changed = true;
        }
      }
      if (changed) await this.state.storage.put(ck, craft);
      return json({ craft });
    }
    if (url.pathname === "/nick") {   // 暱稱（跟著帳號）：set 是字串就寫入（空字串＝清除、恢復 Discord 名稱）；回目前暱稱
      const nk = "nick:" + uid;
      if (typeof body.set === "string") { const v = nickClean(body.set); if (v) await this.state.storage.put(nk, v); else await this.state.storage.delete(nk); }
      return json({ nick: nickClean(await this.state.storage.get(nk)) });
    }
    if (url.pathname === "/gstats") {   // 遊戲戰績：有 game 就把 add（累加）／max（取大）／min（取小）併進去，回整份；沒有 game＝只讀
      const gk = "gstats:" + uid, all = (await this.state.storage.get(gk)) || {};
      if (typeof body.game === "string" && GS_GAMES.has(body.game)) {
        const m = all[body.game] || (all[body.game] = {}), val = v => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(GS_CAP, Math.floor(v))) : null);
        for (const [mode, src] of [["add", body.add], ["max", body.max], ["min", body.min]]) {
          for (const [k, raw] of Object.entries(src && typeof src === "object" ? src : {})) {
            const v = val(raw);
            if (v === null || !GS_KEY_RE.test(k) || (m[k] === undefined && Object.keys(m).length >= GS_KEYS_MAX)) continue;
            if (mode === "add") m[k] = Math.min(GS_CAP, (m[k] || 0) + v);
            else if (mode === "max") m[k] = Math.max(m[k] || 0, v);
            else m[k] = m[k] === undefined ? v : Math.min(m[k], v);
          }
        }
        await this.state.storage.put(gk, all);
      }
      return json({ gstats: all });
    }
    if (url.pathname === "/kills") {   // 擊倒島主紀錄：add＝[地形…] 併進去（已有的不動），回整份；add 空＝只讀
      const kk = "kills:" + uid, kills = (await this.state.storage.get(kk)) || {};
      let changed = false;
      for (const t of Array.isArray(body.add) ? body.add : []) {
        if (!isOwnerTerrain(t) || kills[t]) continue;
        kills[t] = Date.now(); changed = true;
      }
      if (changed) await this.state.storage.put(kk, kills);
      return json({ kills });
    }
    // ---- 腳色等級 XP（與 Island 的 grantXp／hello／xpsync 搭配）----
    if (url.pathname === "/profile") {
      const xp = await this.state.storage.get("xp:" + uid);
      return json({ xp: xp === undefined ? 0 : xp, has: xp !== undefined });
    }
    if (url.pathname === "/deposit") {   // 舊存檔一次性上繳：已經有紀錄就不覆蓋（冪等；兩台裝置同時上繳也不會疊加）
      const v = Math.max(0, Math.min(XP_MAX, Math.floor(Number(body.v) || 0)));
      const xk = "xp:" + uid, cur = await this.state.storage.get(xk);
      if (cur === undefined) { await this.state.storage.put(xk, v); return json({ xp: v }); }
      return json({ xp: cur });
    }
    if (url.pathname === "/addxp") {     // 累加（可負＝死亡扣款）：夾在 0..XP_MAX，沒變就不寫 storage
      const d = Math.max(-100000, Math.min(100000, Math.floor(Number(body.d) || 0)));
      const xk = "xp:" + uid, cur = await this.state.storage.get(xk);
      const nv = Math.max(0, Math.min(XP_MAX, (cur === undefined ? 0 : cur) + d));
      if (nv !== cur) await this.state.storage.put(xk, nv);
      return json({ xp: nv });
    }
    return json({ error: "not found" }, 404);
  }
}
