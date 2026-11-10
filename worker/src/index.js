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
const D_HIT_MAX = 6;         // 一般攻擊打島主／深海魚人的傷害上限（客戶端算好送來；2026-11-05 由 2 放寬到 4，2026-11-07 再放寬到 6，使用者定：信任客戶端；最高＝黑魔法師咒杖 4＋輸出 1＝5，留 1 的餘裕）。夾值隨攻擊者等級放寬（每 3 級 +1，見 dlHitMax）
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
const dlHitMax = lvl => D_HIT_MAX + Math.floor((Math.max(1, Math.floor(lvl)) - 1) / 3);
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
const TABLE_DEFS = { peace: { t1: "oldmaid", t2: "gomoku", t5: "dodge", t6: "uno", t7: "typing", t8: "intel", t9: "zhtyping" } };   // 地形 → 桌 id → 遊戲 id（客戶端 terrain.json 的 tables 要一致）
const GAME_LIMITS = { oldmaid: [2, 4], gomoku: [2, 2], dodge: [1, 8], uno: [2, 6], typing: [1, 8], zhtyping: [1, 8], intel: [3, 8] };           // 遊戲 → [開局最少人數, 入座上限]
const TBL_TYP_CD_MS = 200;                       // 英打競賽的打字進度回報（typ）：每條連線最短間隔（客戶端約每 250ms 一次）
const TBL_POS_CD_MS = 60;                          // 躲彈幕的位置回報、英打競賽的分數回報：每條連線最短間隔（客戶端實際約 8 次／秒）
const TBL_CD_MS = 100;                             // 每條連線兩次牌桌操作的最短間隔
// 玩小遊戲得 XP（2026-11-08，使用者要求；數值是助手先訂的）：對局正常結束（沒人中途離開）時，每位入座者各得一份，寫在 result.xp（依座位順序）
// 輸贏經驗一樣（使用者定）：抽鬼牌每位 +4；五子棋勝／負／平手都 +5（下不到 10 手就結束的不給，擋刷分）。
// 登入者由伺服器記帳（同一帳號兩次得分最短間隔 GAME_XP_CD_MS）；訪客由客戶端看 result.xp 本機補發
const GAME_XP_CD_MS = 30000;
const OM_XP = 4;      // 抽鬼牌：每位入座者（過關者與輸家一樣）
const GM_XP = 5;      // 五子棋：勝／負／平手都一樣
const GM_XP_MIN_MOVES = 10;
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
function tblJoin(t, cid, name, want) {
  if (tblFind(t, cid)[0]) return;
  const mx = GAME_LIMITS[t.game][1];
  if (want !== "spec" && t.phase === "lobby" && t.seats.length < mx) { t.seats.push({ cid, name, ready: false, hand: [], out: false }); tblLog(t, `${name} 入座了`); }
  else { t.specs.push({ cid, name }); tblLog(t, `${name} 來觀戰`); }
}
function tblLeave(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (role === "spec") t.specs.splice(i, 1);
  else if (role === "seat") {
    const name = t.seats[i].name;
    if (t.phase === "playing" && t.game === "dodge") { dgLeave(t, i, Date.now()); return; }   // 躲彈幕：離開不中斷，視同淘汰，到場上沒有活人為止
    if (t.phase === "playing" && t.game === "uno") { unLeave(t, i, Date.now()); return; }   // UNO：離開不中斷，手牌收回牌堆，只剩 1 人時那人獲勝
    if (t.phase === "playing" && isTy(t)) { tyLeave(t, i, Date.now()); return; }   // 英打競賽：離開不中斷，照當時分數排名
    if (t.phase === "playing" && t.game === "intel") { itLeave(t, i, Date.now()); return; }   // 秘藥情報戰：離開不中斷，翻開身分，場上只剩一個陣營時結束   // 英打競賽：離開不中斷，照當時分數排名
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
  if (role !== "spec" || t.phase !== "lobby" || t.seats.length >= GAME_LIMITS[t.game][1]) return;
  const s = t.specs.splice(i, 1)[0];
  t.seats.push({ cid, name: s.name, ready: false, hand: [], out: false });
  tblLog(t, `${s.name} 入座了`);
}
function tblReady(t, cid, v) {
  const [role, i] = tblFind(t, cid);
  if (role !== "seat" || t.phase !== "lobby") return;
  t.seats[i].ready = !!v;
  tblCheckStart(t);
}
function tblCheckStart(t) {
  if (t.phase === "lobby" && t.seats.length >= GAME_LIMITS[t.game][0] && t.seats.every(s => s.ready)) GAME_START[t.game](t);   // 使用者定：全員按「準備」才開始
}
// 入座的人改成觀戰（只有還沒開局時；進行中要離開就是 leave，會結束這一局）。剩下的人若都已準備就開局
function tblStand(t, cid) {
  const [role, i] = tblFind(t, cid);
  if (role !== "seat" || t.phase !== "lobby") return;
  const s = t.seats.splice(i, 1)[0];
  t.specs.push({ cid, name: s.name });
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
  t.result = { loser, name, text: `${name} 抽到鬼牌，輸了！`, rid: Math.floor(Math.random() * 4294967296), xp: t.seats.map(() => OM_XP) };
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
  const g = t.g, enough = (g.moves || []).length >= GM_XP_MIN_MOVES, rid = Math.floor(Math.random() * 4294967296);
  if (winner === null) t.result = { draw: true, text: "棋盤下滿了，平手！", rid, xp: [enough ? GM_XP : 0, enough ? GM_XP : 0] };
  else { const name = t.seats[winner].name; t.result = { winner, name, text: `${name} 五子連線，獲勝！`, rid, xp: [enough ? GM_XP : 0, enough ? GM_XP : 0] }; }
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
// ---- 躲彈幕（第五桌 t5；2026-11-08，使用者要求）：1～8 人、每人 3 條命、只能躲不能攻擊，依存活秒數評分 ----
// 彈幕由客戶端用伺服器給的 seed 與開始時間 t0 決定性地各自產生（每個畫面看到的彈幕一樣）；被打到由各客戶端自判並回報 hit（和島主的招式同一原則，信任客戶端），
// 伺服器管命數（被打後 DG_INV_MS 內不重複扣）、淘汰、評分與結束：入座的人全部淘汰、或滿 DG_DUR 秒（客戶端時間到時送 finish，伺服器核對時鐘）就結束；
// 中途離開的人視同在離開那一刻淘汰（照該刻的存活秒數計分），遊戲繼續到場上沒有活人為止。與 tools/dev_server.py 的 dg_* 同一套。
const DG_DUR = 300;          // 最長秒數（使用者定，「暫時」；到了強制結束）
const DG_LIVES = 3;
const DG_INV_MS = 1500;      // 被打到後的無敵時間（與客戶端一致）
const DG_COUNTDOWN_MS = 3000;
const DG_W = 640, DG_H = 400;   // 場地大小（客戶端畫面用；伺服器只用來夾位置）
// 存活秒數 → XP：不到 10 秒不給（擋刷分）；之後每 30 秒 +1，起跳 1、上限 10
const dgXp = sec => (sec < 10 ? 0 : Math.min(10, 1 + Math.floor(sec / 30)));
const dgElapsed = (t, now) => Math.max(0, Math.min(DG_DUR, (now - t.g.t0) / 1000));
const round1 = x => Math.round(x * 10) / 10;
function dgStart(t) {
  const now = Date.now();
  t.g = { seed: Math.floor(Math.random() * 2147483648), t0: now + DG_COUNTDOWN_MS };
  t.result = null; t.phase = "playing";
  for (const s of t.seats) { s.lives = DG_LIVES; s.out = false; s.died = null; s.lastHit = 0; s.left = false; s.ready = false; }
  tblLog(t, `挑戰開始！${t.seats.length} 人參加，每人 ${DG_LIVES} 條命`);
}
function dgOut(t, s, now, why) {
  s.out = true; s.died = round1(dgElapsed(t, now));
  tblLog(t, `${s.name} ${why}，存活 ${s.died} 秒`);
}
function dgFinish(t, now) {
  for (const s of t.seats) if (!s.out) { s.out = true; s.died = round1(dgElapsed(t, now)); }   // 時間到還活著的：存活到最後
  const ranking = t.seats.map(s => ({ name: s.name, sec: s.died, left: !!s.left })).sort((a, b) => b.sec - a.sec);
  const stay = t.seats.filter(s => !s.left);
  const xp = stay.map(s => dgXp(s.died));   // 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
  const top = ranking[0], text = top ? `挑戰結束！第一名 ${top.name}，存活 ${top.sec} 秒` : "挑戰結束";
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), ranking, xp };
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
// ---- 英打競賽（第七桌 t7；2026-11-10，使用者要求）：1～8 人、倒數 3 秒後 30 秒內比誰打完的英文單字多 ----
// 題目由客戶端用伺服器給的 seed 決定性地產生（大家同一串單字，單字表在 games.json 的 typing.words）；打字與錯字鎖定都在客戶端，
// 每打完一個字回報 word {n}（n＝目前總分，信任客戶端；伺服器只收「比上次多 1～3」的值），伺服器記分、轉發 tsc {i, n} 給同桌其他人。
// 時間到後留 TY_SETTLE_MS 收最後的分數，客戶端再送 finish，伺服器核對時鐘才結算。中途離開不中斷（座位留空殼、照當時分數排名、不給 XP）。
// 與 tools/dev_server.py 的 ty_* 同一套。
// 中文打字競賽（第九桌 t9，2026-11-11，使用者要求）：規則與英打完全一樣（同一套 ty*），只是題目換成 games.json 的 zhtyping.words、
// 客戶端用輸入法「送出選字」後的文字比對（伺服器不管輸入內容，只收分數）；game id＝zhtyping
const isTy = t => t.game === "typing" || t.game === "zhtyping";
const tyUnit = t => (t.game === "zhtyping" ? "詞" : "單字");
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
  const ranking = t.seats.map(s => ({ name: s.name, score: s.score || 0, left: !!s.left })).sort((a, b) => b.score - a.score);
  const stay = t.seats.filter(s => !s.left);
  const xp = stay.map(s => ((s.score || 0) >= TY_XP_MIN ? TY_XP : 0));   // 中途離開的人不給 XP；result.xp 依「留下來的座位」順序
  const top = ranking[0], text = top ? `比賽結束！第一名 ${top.name}，打了 ${top.score} 個${tyUnit(t)}` : "比賽結束";
  t.seats = stay;
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), ranking, xp };
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
const IT_PEND_MS = 5000;    // 行動（含識破）打出後的識破時間（使用者定 5 秒；識破本身也能被識破，每次重新計時）
const IT_WIN = 3, IT_DEATH = 3;
const IT_XP = 6;            // 正常結束：每位入座者 +6（輸贏一樣，同其他桌；助手先訂的數值）
const IT_HAND0 = 4;
const IT_MSGS = new Set(["isend", "itake", "ifwd", "iact", "timeout", "imode", "iok"]);         // 開局手牌
const IT_ACT = { P: "截閱", S: "調包", F: "押送", X: "焚信", H: "搜身", W: "洗白", C: "識破", I: "攔截", T: "轉移", B: "阻擋", N: "無人倖免" };
const IT_KIND = { seal: "密函", pub: "公開情報", direct: "直達情報" };   // 投遞方式（由卡面決定，不是玩家選）：蓋著照座位傳／翻開照座位傳／直接指定一人（對方必須收下）
const IT_KIND_CODE = { s: "seal", p: "pub", d: "direct" };
const IT_KIND_CYCLE = "sspsd";   // 牌組依序循環分配投遞方式：密函 60%、公開 20%、直達 20%
const IT_CNAME = { Y: "黃", B: "藍", K: "黑" };   // 2026-11-11 使用者要求移除灰（廢紙）
const IT_ROLE = { sand: "沙都", water: "水都", mage: "咒術師" };
// 牌組 65 張：印記 → 各行動的張數（雙色牌同時算兩種顏色；沒有灰）
const IT_DECK = { Y: "P2S2F2X2H2W1C3I1T1B1N1", B: "P2S2F2X2H2W1C3I1T1B1N1", K: "P1S1F2X1H1C2I1T1B1", YB: "P1S1F1X1H1C1I1N1", YK: "P1S1F1C1B1", BK: "P1S1F1C1T1" };
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
  const nx = L.kind === "direct" ? -1 : itNextUntouched(t, L.at, L.seen);   // 直達不照座位傳，不收就直接退回發信者
  if (nx >= 0) return nx;
  return L.at !== L.from && itOk(t, L.from) ? L.from : -1;   // 大家都不收：退回給發信者，發信者必須收下
}
const itDl = (g, now, ms) => (g.untimed ? 0 : now + ms);   // 不限時模式：期限＝0（沒有倒數）
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
const itCanTake = (t, L, i) => !itBlocked(t.g, i) || itFwdTarget(t, L) < 0;
function itStart(t) {
  const n = t.seats.length, m = IT_MAGES[n] ?? 1, half = (n - m) / 2;
  const roles = shuffle([...Array(half).fill("sand"), ...Array(half).fill("water"), ...Array(m).fill("mage")]), deck = shuffle(itDeck());
  t.seats.forEach((s, k) => { s.hand = deck.splice(deck.length - IT_HAND0, IT_HAND0); s.intel = []; s.role = roles[k]; s.out = false; s.left = false; s.ready = false; s.note = null; });
  t.g = { deck, discard: [], step: "turn", letter: null, pend: null, arrive: null, blocked: [], deadline: 0, untimed: !!t.untimed };
  t.result = null; t.phase = "playing";
  tblLog(t, `牌局開始！沙都 ${half} 人、水都 ${half} 人${m ? `、咒術師 ${m} 人` : ""}，每人 ${IT_HAND0} 張${t.untimed ? "（不限時）" : ""}`);
  itBeginTurn(t, Math.floor(Math.random() * n), Date.now());
}
// 輪到座位 i：抽 2 張；手上沒牌（牌堆也空）就跳過，所有人都沒牌就平手
function itBeginTurn(t, i, now) {
  const g = t.g;
  for (let k = 0; k < t.seats.length && i >= 0; k++) {
    t.turn = i; g.step = "turn"; g.letter = null; g.pend = null; g.arrive = null; g.blocked = []; g.deadline = itDl(g, now, IT_TURN_MS);
    t.seats[i].note = null;   // 上一輪偷看到的東西：輪到自己時清掉
    itDraw(t, i, 2);
    if (t.seats[i].hand.length) return;
    tblLog(t, `${t.seats[i].name} 沒有牌可以投遞，跳過`);
    i = itNext(t, i);
  }
  itFinish(t, "沒有人有牌可以投遞了，平手", [], true);
}
function itFinish(t, text, winners, xp) {
  const reveal = t.seats.map(s => ({ name: s.name, role: s.role, intel: [...(s.intel || [])], win: winners.includes(s), left: !!s.left, out: !!s.out }));
  const stay = t.seats.filter(s => !s.left);
  t.result = { text, rid: Math.floor(Math.random() * 4294967296), xp: stay.map(() => (xp ? IT_XP : 0)), reveal };
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
  const r = [...roles][0], winners = r === "mage" ? alive.map(i => t.seats[i]) : t.seats.filter(s => s.role === r);
  return itFinish(t, `場上只剩${IT_ROLE[r]}，${r === "mage" ? winners.map(s => s.name).join("、") + " " : IT_ROLE[r] + "陣營"}獲勝！`, winners, !byLeave);
}
// 座位 i 的情報區變多了：先看有沒有人獲勝，再看有沒有人出局
function itCheckIntel(t, i) {
  const s = t.seats[i];
  if (s.role === "mage" && itCount(s.intel, "K") >= IT_WIN) return itFinish(t, `${s.name} 是咒術師！集滿 ${IT_WIN} 封咒函，獲勝！`, [s], true);
  if (s.role === "sand" && itCount(s.intel, "Y") >= IT_WIN) return itFinish(t, `${s.name} 集滿 ${IT_WIN} 封黃色密函，沙都陣營獲勝！`, t.seats.filter(x => x.role === "sand"), true);
  if (s.role === "water" && itCount(s.intel, "B") >= IT_WIN) return itFinish(t, `${s.name} 集滿 ${IT_WIN} 封藍色密函，水都陣營獲勝！`, t.seats.filter(x => x.role === "water"), true);
  if (s.role !== "mage" && itCount(s.intel, "K") >= IT_DEATH) {
    s.out = true;
    t.g.discard.push(...s.hand); s.hand = [];
    tblLog(t, `${s.name} 收到 ${IT_DEATH} 封咒函，暴露出局！身分是${IT_ROLE[s.role]}`);
    return itCheckFaction(t, false);
  }
  return false;
}
function itEndLetter(t, now) {   // 這次投遞結束：換下一位
  const nx = itNext(t, t.turn);
  if (nx < 0) { itCheckFaction(t, false); return; }
  itBeginTurn(t, nx, now);
}
function itReceive(t, now, ack = false) {
  const g = t.g, L = g.letter, s = t.seats[L.at], at = L.at;
  s.intel.push(L.card); g.letter = null; g.arrive = null;
  tblLog(t, `${s.name} 收下了密函：${itLabel(L.card)}`);
  if (itCheckIntel(t, at)) return;
  if (ack && g.untimed) { g.step = "ack"; g.ack = { by: at, ok: [] }; itAckCheck(t, now); return; }   // 不限時模式：收下後要所有活人按「準備繼續」才換下一位
  itEndLetter(t, now);
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
  let p = g.pend, act = true;
  g.pend = null;
  if (!g.untimed) g.deadline = Math.max(g.deadline, now + 5000);   // 生效後至少留 5 秒給拿著密函／輪到的人反應
  while (p) {
    if (p.a === "C") { act = !act; p = p.under; continue; }
    if (act) itApply(t, p, now);
    else tblLog(t, `${t.seats[p.by].name} 的${IT_ACT[p.a]}被識破，沒有生效`);
    itNoHand(t, now);
    return;
  }
}
// 輪到的人把最後一張牌當行動用掉、手上沒牌可以投遞：直接換下一位（限時模式靠逾時，不限時模式沒有逾時，一定要在這裡處理）
function itNoHand(t, now) {
  const g = t.g;
  if (!g || t.phase !== "playing" || g.step !== "turn" || g.pend || g.letter || t.seats[t.turn].hand.length) return;
  tblLog(t, `${t.seats[t.turn].name} 沒有牌可以投遞，跳過`);
  itEndLetter(t, now);
}
function itApply(t, p, now) {
  const g = t.g, by = t.seats[p.by];
  if (p.a === "P" && g.letter && g.letter.kind !== "pub" && !g.letter.open) { by.note = { k: "peek", card: g.letter.card }; tblLog(t, `${by.name} 截閱了密函`); }
  else if (p.a === "S" && g.letter && g.letter.kind !== "pub" && !g.letter.open) {   // 調包：換上去的牌公開（所有人看得到），被換掉的牌棄掉
    const k = by.hand.indexOf(p.sel);
    if (k < 0) return;
    by.hand.splice(k, 1); g.discard.push(g.letter.card); g.letter.card = p.sel; g.letter.open = true;
    tblLog(t, `${by.name} 調包了密函：換上 ${itLabel(p.sel)}（公開），原本的牌被丟棄`);
  } else if (p.a === "F" && g.letter) { tblLog(t, `${t.seats[g.letter.at].name} 被押送，必須收下密函`); itReceive(t, now); }
  else if (p.a === "X" && g.letter) { g.discard.push(g.letter.card); g.letter = null; tblLog(t, `${by.name} 燒掉了密函`); itEndLetter(t, now); }
  else if (p.a === "I" && g.letter && g.step === "pass" && g.letter.at !== p.by && g.letter.from !== p.by && itOk(t, p.by)) {
    const L = g.letter, was = t.seats[L.at].name;
    L.at = p.by; L.icpt = p.by; if (!L.seen.includes(p.by)) L.seen.push(p.by);
    g.deadline = itDl(g, now, IT_HOLD_MS); itArrive(g);
    tblLog(t, `${by.name} 從 ${was} 手上攔截了${IT_KIND[L.kind]}`);
  } else if (p.a === "H" && itOk(t, p.tgt)) {
    const th = t.seats[p.tgt], cards = shuffle([...th.hand]).slice(0, 2);
    by.note = { k: "search", tgt: th.name, cards };
    tblLog(t, `${by.name} 搜了 ${th.name} 的身`);
  } else if (p.a === "W" && itOk(t, p.tgt)) {   // 洗白：任何階段，可以對任何人情報區裡含黑的情報使用
    const th = t.seats[p.tgt], k = th.intel.indexOf(p.sel);
    if (k < 0) return;
    th.intel.splice(k, 1); g.discard.push(p.sel);
    tblLog(t, `${by.name} 洗白了 ${th.name} 情報區的一封情報：${itLabel(p.sel)}`);
  } else if (p.a === "T" && g.letter && g.step === "pass" && g.letter.at === p.by && itOk(t, p.tgt) && p.tgt !== p.by) {   // 轉移：面前的情報交給另一位，對方不能拒收（被阻擋的人不能當對象）
    if (itBlocked(g, p.tgt)) { tblLog(t, `轉移失敗：${t.seats[p.tgt].name} 被阻擋，不能收下`); return; }
    const L = g.letter;
    tblLog(t, `${by.name} 把情報轉移給 ${t.seats[p.tgt].name}，他不能拒收`);
    L.at = p.tgt; if (!L.seen.includes(p.tgt)) L.seen.push(p.tgt);
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
      if (itCheckIntel(t, j)) return;   // 有人勝利（或場上只剩一個陣營）：遊戲結束
    }
    if (t.g && !itOk(t, t.turn)) itEndLetter(t, now);   // 發動的人自己被黑函淘汰：直接換下一位
  }
}
// 時間檢查（每個操作進來先跑；客戶端時間到時送 timeout）：識破時間過了就生效；回合／收轉逾時就自動處理。不限時模式沒有任何計時
function itTick(t, now) {
  const g = t.g;
  if (t.game !== "intel" || t.phase !== "playing" || !g || g.untimed) return;
  if (g.pend) { if (now >= g.pend.until) itResolve(t, now); return; }
  if (now < g.deadline) return;
  if (g.step === "pass" && g.letter) {
    const L = g.letter, to = itBlocked(g, L.at) ? itFwdTarget(t, L) : -1;   // 被阻擋的持有者不能收：超時改成自動傳走
    if (to >= 0) { tblLog(t, `${t.seats[L.at].name} 超時（被阻擋），自動把情報傳給 ${t.seats[to].name}`); L.at = to; if (!L.seen.includes(to)) L.seen.push(to); g.deadline = now + IT_HOLD_MS; }
    else { tblLog(t, `${t.seats[L.at].name} 超時，自動收下`); itReceive(t, now); }
  }
  else if (g.step === "turn") {
    const s = t.seats[t.turn];
    if (!s.hand.length) { itEndLetter(t, now); return; }
    const k = Math.floor(Math.random() * s.hand.length), kind = itKindOf(s.hand[k]);   // 投遞方式由卡面決定；直達的目標隨機挑一位
    const others = itAlive(t).filter(j => j !== t.turn), to = kind === "direct" ? others[Math.floor(Math.random() * others.length)] : itNextUntouched(t, t.turn, [t.turn]);
    if (to === undefined || to < 0) { itEndLetter(t, now); return; }
    const card = s.hand.splice(k, 1)[0];
    g.letter = { card, orig: card, from: t.turn, at: to, seen: [t.turn, to], kind, icpt: null }; g.step = "pass"; g.deadline = now + IT_HOLD_MS;
    tblLog(t, `${s.name} 超時，自動把一封${IT_KIND[kind]}交給 ${t.seats[to].name}`);
  }
}
// 不限時模式：識破時間不倒數，要所有活人（出牌的人自動算）按「準備繼續」才生效；有人出識破就重新計
function itOkCheck(t, now) {
  const g = t.g, p = g.pend;
  if (!p || !g.untimed) return;
  if (itAlive(t).every(i => i === p.by || p.ok.includes(i))) itResolve(t, now);
}
// 識破串：由最底下的行動到最上面（最後出的）
function itChain(p) { const c = []; for (; p; p = p.under) c.unshift({ a: p.a, by: p.by, tgt: p.tgt }); return c; }
function itMsg(t, cid, msg, now) {
  const [role, i] = tblFind(t, cid), g = t.g, a = msg.a;
  if (a === "imode") {   // 桌主（第一位入座的人）在開局前選：限時／不限時
    if (t.game !== "intel" || role !== "seat" || i !== 0 || t.phase !== "lobby" || (msg.v !== "timed" && msg.v !== "untimed") || !!t.untimed === (msg.v === "untimed")) return;
    t.untimed = msg.v === "untimed";
    for (const s of t.seats) s.ready = false;
    tblLog(t, `${t.seats[0].name} 把模式改成${t.untimed ? "不限時" : "限時"}`);
    return;
  }
  if (a === "timeout") { itTick(t, now + 300); return; }
  if (t.game !== "intel" || role !== "seat" || t.phase !== "playing" || !g || !itOk(t, i)) return;
  const s = t.seats[i], L = g.letter;
  if (a === "iok") {   // 不限時：按「準備繼續」（識破時間內沒有要識破；或收下情報後的確認）
    if (g.pend) { if (!g.untimed || g.pend.by === i || g.pend.ok.includes(i)) return; g.pend.ok.push(i); itOkCheck(t, now); return; }
    if (g.arrive && g.untimed && g.letter) { const ar = g.arrive; if (g.letter.at === i || ar.ok.includes(i)) return; ar.ok.push(i); itArriveCheck(t, now); return; }
    if (g.step === "ack" && g.ack && g.untimed) { if (g.ack.by === i || g.ack.ok.includes(i)) return; g.ack.ok.push(i); itAckCheck(t, now); return; }
  } else if (a === "isend") {   // 投遞：idx＝手牌；投遞方式由卡面決定（密函／公開情報照座位順序交給下一位；直達情報要帶 to，對方可以不收、退回給發信者）
    if (g.pend || g.step !== "turn" || i !== t.turn || !Number.isInteger(msg.idx) || msg.idx < 0 || msg.idx >= s.hand.length) return;
    const kind = itKindOf(s.hand[msg.idx]);
    const to = kind === "direct" ? msg.to : itNextUntouched(t, i, [i]);
    if (!itOk(t, to) || to === i) return;
    const card = s.hand.splice(msg.idx, 1)[0];
    g.letter = { card, orig: card, from: i, at: to, seen: [i, to], kind, icpt: null }; g.step = "pass"; g.deadline = itDl(g, now, IT_HOLD_MS); itArrive(g);
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
    const card = s.hand[msg.idx], act = itAct(card);
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
    if (act === "F" && (!pass || L.at === i)) return;   // 押送：別人拿著情報時
    if (act === "X" && !pass) return;                   // 焚信：情報傳遞中
    if (act === "I" && (!pass || L.at === i || L.from === i)) return;   // 攔截：別人拿著情報時（不能攔自己發出去的）
    if (act === "H") { if (!mine || !itOk(t, msg.tgt) || msg.tgt === i) return; tgt = msg.tgt; }   // 搜身：自己的回合
    if (act === "W") {   // 洗白：任何階段，對任何活人情報區裡含黑的情報（tgt＝座位、sel＝他情報區的 idx）
      const th = t.seats[msg.tgt], k = msg.sel;
      if (!itOk(t, msg.tgt) || !Number.isInteger(k) || k < 0 || k >= th.intel.length || !itCols(th.intel[k]).includes("K")) return;
      tgt = msg.tgt; sel = th.intel[k];
    }
    if (act === "T") { if (!pass || L.at !== i || !itOk(t, msg.tgt) || msg.tgt === i || itBlocked(g, msg.tgt)) return; tgt = msg.tgt; }   // 轉移：情報在自己面前時，交給另一位（被阻擋的人不行）
    if (act === "B") { if (!pass || !itOk(t, msg.tgt) || itBlocked(g, msg.tgt)) return; tgt = msg.tgt; }   // 阻擋：情報傳遞中（自己或別人的），指定一人
    if (act === "N" && (!mine || L)) return;   // 無人倖免：自己的回合、發送情報之前
    if (act === "C") return;   // 識破只能在別人的行動生效前出
    s.hand.splice(msg.idx, 1); g.discard.push(card);
    g.pend = { a: act, by: i, tgt, sel, until: now + IT_PEND_MS, under: null, ok: [] };
    if (g.arrive) g.arrive.ok = [];   // 有人出牌：到達確認重來
    if (g.ack) g.ack.ok = [];         // 收下確認中出牌：確認重來
    const on = act === "H" || act === "W" || act === "T" || act === "B" ? `（對 ${t.seats[tgt].name}）` : act === "F" || act === "I" ? `（對 ${t.seats[L.at].name}）` : "";
    tblLog(t, `${s.name} 使用了${IT_ACT[act]}${on}`);
    itOkCheck(t, now);   // 不限時：只剩出牌的人自己活著的極端情況，直接生效
  }
}
// 遊戲進行中有人離開：翻開身分、手牌丟棄，遊戲繼續；場上只剩一個陣營時結束（無 XP）
function itLeave(t, i, now) {
  const g = t.g, s = t.seats[i];
  g.discard.push(...s.hand); s.hand = []; s.left = true; s.cid = null;
  tblLog(t, `${s.name} 離開了（身分：${IT_ROLE[s.role]}）`);
  g.pend = null;   // 進行中的行動作廢（牌已經丟了）
  let advance = g.step === "turn" && t.turn === i;
  if (g.letter && g.letter.at === i) { g.discard.push(g.letter.card); g.letter = null; g.arrive = null; advance = true; tblLog(t, "他手上的密函作廢"); }
  if (itCheckFaction(t, true)) return;
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
  const name = t.seats[winner].name, stay = t.seats.filter(s => !s.left);
  t.result = { winner, name, text: `${name} 出完手牌，獲勝！`, rid: Math.floor(Math.random() * 4294967296), xp: stay.map(() => (xp ? UN_XP : 0)) };
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
const GAME_START = { oldmaid: omStart, gomoku: gmStart, dodge: dgStart, uno: unStart, typing: tyStart, zhtyping: tyStart, intel: itStart };   // 遊戲 → 開局函式（tblReady 全員準備時呼叫）
// 給某條連線看的版本：自己的手牌完整，別人只有張數
function tblView(t, cid) {
  const [role, i] = tblFind(t, cid), [mn, mx] = GAME_LIMITS[t.game], playing = t.phase === "playing";
  const v = {
    id: t.id, game: t.game, phase: t.phase, min: mn, max: mx, role, me: role === "seat" ? i : -1,
    seats: t.seats.map((s, k) => ({ name: s.name, n: playing ? s.hand.length : 0, ready: s.ready, out: playing ? s.out : false, you: role === "seat" && k === i })),
    specs: t.specs.length, turn: playing ? t.turn : -1, target: playing ? tblNextActive(t, t.turn) : -1, result: t.result, log: [...t.log],
  };
  if (t.game === "dodge") {   // 躲彈幕：每個座位的命數／淘汰秒數／是否已離開；進行中附上 seed 與開始時間（彈幕由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
    t.seats.forEach((s, k) => { v.seats[k].lives = s.lives || 0; v.seats[k].died = s.died ?? null; v.seats[k].left = !!s.left; });
    if (t.g && playing) v.dg = { seed: t.g.seed, t0: t.g.t0, dur: DG_DUR, sn: Date.now() };
  } else if (isTy(t)) {   // 英打／中文打字競賽：每個座位的分數／是否已離開；進行中附上 seed 與開始時間（題目由客戶端決定性地產生）、伺服器現在時間（客戶端對時用）
    t.seats.forEach((s, k) => { v.seats[k].score = s.score || 0; v.seats[k].left = !!s.left; });
    if (t.g && playing) v.ty = { seed: t.g.seed, t0: t.g.t0, dur: TY_DUR, sn: Date.now() };
  } else if (t.game === "intel") {   // 秘藥情報戰：情報區公開；身分只給本人、已出局／離開的人、觀戰者（使用者定：觀戰者看得到全部資訊）
    const all = role === "spec";
    t.seats.forEach((s, k) => {
      const vs = v.seats[k];
      vs.intel = playing ? [...(s.intel || [])] : []; vs.left = !!s.left;
      if (playing && (all || s.out || s.left || (role === "seat" && k === i))) vs.role = s.role;
    });
    if (playing && t.g) {
      const g = t.g, L = g.letter;
      v.it = {
        step: g.step, deck: g.deck.length, discard: g.discard.length, deadline: g.deadline, sn: Date.now(),
        untimed: !!g.untimed, blocked: [...(g.blocked || [])], arrive: g.arrive && L ? { at: L.at, ok: [...g.arrive.ok] } : null, ack: g.ack ? { by: g.ack.by, ok: [...g.ack.ok] } : null,
        letter: L ? { from: L.from, at: L.at, seen: [...L.seen], kind: L.kind, open: !!L.open, next: itFwdTarget(t, L), icpt: L.icpt ?? null } : null,
        pend: g.pend ? { a: g.pend.a, by: g.pend.by, tgt: g.pend.tgt, until: g.pend.until, ok: [...g.pend.ok], chain: itChain(g.pend) } : null,
      };
      if (L && (all || L.kind === "pub" || L.open)) v.it.letter.card = L.card;                 // 觀戰者：看得到密函；公開情報：所有人都看得到
      else if (L && role === "seat" && L.from === i) v.it.letter.card = L.orig;     // 投遞的人：只知道自己送出的是哪張（被調包了也不知道）
      if (role === "seat") { v.hand = [...t.seats[i].hand]; v.note = t.seats[i].note || null; }
      if (all) v.hands = t.seats.map(s => [...s.hand]);
    }
  } else if (t.g && t.game === "gomoku") {   // 五子棋：棋盤（225 個字元：0 空／1 黑／2 白）、最後一手、執黑的座位、連線的五子（結束時）；棋盤公開，觀戰者也看得到
    v.board = t.g.board.join(""); v.last = t.g.last; v.black = t.g.black; v.line = t.g.line; v.moves = t.g.moves || [];   // moves：每一手的座標（偶數手＝黑棋）；結束後客戶端用來復盤
  }
  if (t.game === "intel") v.untimed = !!t.untimed;   // 模式（桌主在開局前選）：限時／不限時
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
  if (role === "spec" && playing && (t.game === "oldmaid" || t.game === "uno")) v.hands = t.seats.map(s => [...s.hand]);   // 觀戰者看得到每個人的手牌（使用者要求，2026-11-08），順序＝對手看到的牌背順序
  if (role === "seat" && playing && (t.game === "oldmaid" || t.game === "uno")) {
    v.hand = [...t.seats[i].hand];   // 照伺服器順序（不排序）：對方抽的第 k 張牌背＝這裡從左數第 k 張
  }
  return v;
}
// seated＝入座中的連線編號：客戶端在他們的名牌後面加「入座中／遊戲中」
const tblInfo = t => ({ game: t.game, n: t.seats.length, s: t.specs.length, max: GAME_LIMITS[t.game][1], play: t.phase === "playing", seated: t.seats.map(s => s.cid) });

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
  async getTable(tid) {
    let t = this.tables.get(tid);
    if (t) return t;
    const game = this.tableGame(tid);
    if (!game) return null;
    t = (await this.state.storage.get("table:" + tid)) || tblNew(tid, game);
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
    if (a === "pos" || a === "word") {   // 躲彈幕的位置回報、英打競賽的分數回報：自己的限流，不影響 hit／finish 等操作
      if (now - (this.lastTblPos.get(ws) || 0) < TBL_POS_CD_MS) return;
      this.lastTblPos.set(ws, now);
    } else if (a === "typ") {   // 英打競賽的打字進度（只轉發給觀戰者）：自己的限流
      if (now - (this.lastTblTyp.get(ws) || 0) < TBL_TYP_CD_MS) return;
      this.lastTblTyp.set(ws, now);
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
      const cur = ws.deserializeAttachment() || {};
      tblJoin(t, att.id, String((att.state && att.state.name) || (att.user && att.user.name) || `玩家${att.id}`).slice(0, 12), msg.role === "spec" ? "spec" : "seat");
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
    if (a === "pos") {   // 躲彈幕：位置回報，轉發給同桌其他人（不存檔、不通知畫面、不廣播 tblinfo）
      const [role, i] = tblFind(t, att.id);
      if (t.game === "dodge" && role === "seat" && t.phase === "playing" && !t.seats[i].out) {
        const x = Math.max(0, Math.min(DG_W, Number(msg.x) || 0)), y = Math.max(0, Math.min(DG_H, Number(msg.y) || 0));
        const data = JSON.stringify({ t: "tpos", i, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
        for (const m of [...t.seats, ...t.specs]) {
          if (m.cid == null || m.cid === att.id) continue;
          for (const w of this.state.getWebSockets()) if ((w.deserializeAttachment() || {}).id === m.cid) { try { w.send(data); } catch { /* 對方已斷線 */ } }
        }
      }
      return;
    }
    if (a === "typ") {   // 英打競賽：打字進度 {n 第幾個字, p 已打對幾個字母, e 是否剛打錯}，只轉發給觀戰者（tpg）；不存檔、不通知畫面、沒人觀戰就什麼都不送
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
    if (a === "word") {   // 英打競賽：分數回報，轉發 tsc 給同桌其他人（不通知整個畫面、不廣播 tblinfo；storage 每 TY_SAVE_MS 才寫一次）
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
    if (t.game === "intel" && IT_MSGS.has(a)) itMsg(t, att.id, msg, now);   // 秘藥情報戰：投遞／收下／轉手／行動牌／逾時
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
    else if (a === "timeout") unTimeout(t, now);
    else if (a === "mode") unSetMode(t, att.id, msg.v);   // UNO：桌主在開局前選玩法（classic／wild）
    else if (a === "hit") dgHit(t, att.id, now);   // 躲彈幕：我被打到（客戶端自判，伺服器管命數與無敵時間）
    else if (a === "finish") { dgCheckEnd(t, now + 300); tyCheckEnd(t, now + 300); }   // 躲彈幕／英打競賽：客戶端看時間到了請求結算（伺服器核對時鐘，沒到時間不理）
    else return;
    await this.saveTable(t);
    this.tableNotify(t);
    await this.tableBroadcastInfo(terr);
    await this.tableXp(t, resBefore);
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
      if (user && cur.state) cur.state = { ...cur.state, name: String(user.name).slice(0, NAME_MAX), uid: user.id };
      ws.serializeAttachment(cur);
      // me 的 uid／xpKnown：客戶端據此決定 XP 記帳走伺服器（xpKnown=false 時要把本機存檔一次性上繳）
      ws.send(JSON.stringify({ t: "me", admin: cur.admin, auth: !!user, uid: user ? user.id : null, xpKnown }));
      if (user) {   // 登入的人：送他存在伺服器的魚類圖鑑與 XP（XP 只在「伺服器有紀錄」時會收到 init；沒有就等 xpsync 上繳）
        const r = await this.registryCall("/dex", { uid: user.id });
        if (r) try { ws.send(JSON.stringify({ t: "dex", dex: r.dex || {} })); } catch { /* 對方已斷線 */ }
        if (cur.xpKnown) try { ws.send(JSON.stringify({ t: "xp", xp: cur.xp, d: 0, k: "init" })); } catch { /* 對方已斷線 */ }
        const cr = await this.registryCall("/craft", { uid: user.id, add: {} });   // 合成解鎖紀錄（素材圖鑑／配方筆記）
        if (cr) try { ws.send(JSON.stringify({ t: "craftdb", craft: cr.craft || {} })); } catch { /* 對方已斷線 */ }
        const kr = await this.registryCall("/kills", { uid: user.id, add: [] });   // 擊倒島主紀錄
        if (kr) try { ws.send(JSON.stringify({ t: "kills", kills: kr.kills || {} })); } catch { /* 對方已斷線 */ }
      }
    } else if (msg.t === "state") {
      const s = sanitizeState(msg.s && typeof msg.s === "object" ? msg.s : {}, att.state);
      // 已驗證身分的人，名字與 uid 以伺服器為準（不能冒名）；等級以伺服器存檔為準（訪客照客戶端報的，只影響名牌）
      if (att.user) {
        s.name = String(att.user.name).slice(0, NAME_MAX);
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
      if (att.user && msg.k === "mob" && att.terrain) {
        const now = Date.now();
        if (now - (this.lastXpMob.get(ws) || 0) >= XP_MOB_CD_MS) {
          this.lastXpMob.set(ws, now);
          // 數量照客戶端帶的（會反擊的野怪＝島主經驗 1/10，2026-11-09 使用者同意延伸）；夾 1～XP_XPE_MAX，防亂報
          const n = Math.min(XP_XPE_MAX, Math.max(1, Math.floor(Number(msg.n) || 1)));
          await this.grantXp(ws, n, "mob");
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

// ============ 全域 Registry（跨島的玩家資料；魚類圖鑑＋腳色等級 XP）============
// 全站只有一個實例（idFromName("global")），只由 Island 透過 REGISTRY 綁定呼叫，沒有對外的路由。
// 資料：dex:<Discord 使用者 ID> → { 地形: { 魚id: { max（最大尺寸 cm）, n（釣到次數）, first（第一次釣到的時間） } } }
//       xp:<Discord 使用者 ID> → 總 XP（整數；2026-11-07 腳色等級第 2 步）
//       craft:<Discord 使用者 ID> → { mat: {素材id: 解鎖時間}, furn: {家具id: 時間}, rec: {配方id: 時間} }（合成：素材圖鑑／配方筆記）
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
