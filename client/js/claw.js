// 夾娃娃機（2026-11-19，使用者要求先預做框架；獎品與玩的條件之後再補）
// 資料在 assets/claw/claw.json；玩的條件與發獎是 main.js 傳進來的掛鉤：
//   deps.canPlay(M)            → { ok, reason }   能不能玩一次（之後接貨幣／次數）
//   deps.grant(M, prize)       夾到獎品（發放：寫進背包／衣櫥、同步伺服器）；回 { note } 可顯示在結果卡
//   deps.sfx(list)             提示音（可省略）
//   deps.toast(msg, ms)
// 玩法：←／→（A／D）或按鈕移動爪子，空白／↓／「下爪」放下去；獎品東倒西歪地疊著（簡單的堆疊物理），爪子下降到碰到最高的獎品為止；
// 夾得穩不穩看「對得準不準」與「獎品歪不歪」（斜斜抓重心不穩，容易在半路掉下來）；爪子升到最上面會先停一下再往出口運。
// 目前夾不夾得到在客戶端決定（沒有任何東西會被帶走）；獎品有價值之後要搬到伺服器（Worker＋dev_server 兩份），不然改封包就能指定結果。
// 純 DOM＋canvas，不碰同步協定。畫面用 240×200 的小畫布放大 2 倍、關掉平滑（像素風）。
let DB = null, M = null, deps = null, box = null, ui = null, raf = 0, G = null;
const sheets = {};   // 獎品圖（sheet 路徑 → Image）

const W = 240, H = 200, FLOOR = 176, RAIL = 20, CHUTE = 46, X_MIN = 58, X_MAX = 226, HOME_X = 26;   // HOME_X＝出口（洞口）的位置：爪子一開始與每次結束都停在這裡（使用者定）   // 畫布大小、地板、軌道高度、出口右緣、爪子可走的左右範圍
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const loadSheet = src => sheets[src] || (sheets[src] = Object.assign(new Image(), { src }));

// ---- 獎品的擺法與簡單物理（2026-11-19 使用者要求「做真實一點：東西東倒西歪、斜斜抓重心不穩會掉」）----
// 每個獎品有位置 x／y（中心）與傾斜角 a；佔的寬高隨傾斜變大（hw／hh）。表面高度＝所有獎品最高處（沒有就是地板），
// 擺放時一個一個丟下去，落在目前的表面上，所以會堆疊、東倒西歪；爪子下降到碰到最高的獎品為止；掉下來的獎品落在新的表面上並再翻一下。
const sizeOf = p => p.cell ? Math.max(p.cell[0], p.cell[1]) : 16;
function extent(it) { const s = sizeOf(it.p) / 2, c = Math.abs(Math.cos(it.a)), n = Math.abs(Math.sin(it.a)); it.hw = s * (c + n) * .92; it.hh = s * (c + n) * .92; }
function surfaceAt(items, x0, x1, skip) {   // [x0, x1] 這段上面最高的東西的頂端（沒有就是地板）
  let top = FLOOR;
  for (const it of items) {
    if (it === skip || it.grabbed || it.gone || it.falling) continue;
    if (it.x + it.hw >= x0 && it.x - it.hw <= x1) top = Math.min(top, it.y - it.hh);
  }
  return top;
}
function addItem(items) {   // 抽一個獎品（依權重）、隨機傾斜，丟到目前的表面上
  const total = M.prizes.reduce((s, p) => s + (p.weight ?? 1), 0);
  let t = Math.random() * total, pick = M.prizes[M.prizes.length - 1];
  for (const p of M.prizes) { t -= p.weight ?? 1; if (t < 0) { pick = p; break; } }
  const it = { p: pick, x: 0, y: 0, a: (Math.random() - .5) * 1.7, vy: 0, grabbed: false, falling: false, gone: false };
  extent(it);
  for (let tries = 0; tries < 12; tries++) {
    it.x = X_MIN + it.hw + Math.random() * (X_MAX - X_MIN - it.hw * 2);
    const top = surfaceAt(items, it.x - it.hw * .7, it.x + it.hw * .7);
    it.y = top - it.hh;
    if (it.y - it.hh > FLOOR - 46) break;   // 堆太高就換個位置
  }
  items.push(it);
}
// 擺獎品：prev＝上一局留下來的（不重刷，使用者定：離開再進來才重新擺；剩太少才補一些）
function newRound(prev) {
  const items = prev ? prev.filter(i => !i.gone) : [];
  const want = M.slots || 10;
  if (!prev) while (items.length < want) addItem(items);
  else if (items.length < Math.min(5, want)) while (items.length < want) addItem(items);   // 快被夾光了：補一批
  return { items, cx: HOME_X, cy: RAIL + 6, st: 'idle', t: 0, held: null, keys: {}, msg: '', pathT: 0 };
}

function sfx(list) { deps?.sfx?.(list); }
function setMsg(t) { if (ui) ui.msg.textContent = t || ''; }
function drop() { if (G.st !== 'idle') return; const c = deps?.canPlay ? deps.canPlay(M) : { ok: true }; if (!c?.ok) { setMsg(c?.reason || '現在不能玩'); return; } G.st = 'down'; G.msg = ''; setMsg(''); sfx([[300, 0, .05]]); }

const CLAW_SPREAD = 9, CLAW_LEN = 18;   // 兩根爪的間距（張開時）、爪長
function releaseHeld(msg) {   // 爪子鬆手：獎品掉下去
  const it = G.held; if (!it) return;
  it.grabbed = false; it.falling = true; it.vy = 0; G.held = null; if (msg) G.msg = msg;
}

function step(dt) {
  const g = G, held = g.held;
  if (g.st === 'idle') { const dx = ((g.keys.right ? 1 : 0) - (g.keys.left ? 1 : 0)) * 70 * dt; g.cx = Math.max(HOME_X, Math.min(X_MAX, g.cx + dx)); }
  else if (g.st === 'down') {   // 往下，碰到最高的獎品（或地板）就停
    g.cy += 90 * dt;
    const surf = surfaceAt(g.items, g.cx - CLAW_SPREAD, g.cx + CLAW_SPREAD);
    if (g.cy + CLAW_LEN >= surf) { g.cy = surf - CLAW_LEN; g.st = 'close'; g.t = 0; }
  } else if (g.st === 'close') {
    g.t += dt;
    if (g.t >= .4) {   // 閉爪：兩爪之間、爪子搆得到的獎品裡，頂端最高的那個；對得準、傾斜小才夾得穩
      let best = null;
      for (const it of g.items) {
        if (it.grabbed || it.gone || it.falling) continue;
        if (Math.abs(it.x - g.cx) <= CLAW_SPREAD + it.hw * .6 && it.y - it.hh <= g.cy + CLAW_LEN + 4 && (!best || it.y - it.hh < best.y - best.hh)) best = it;
      }
      if (best) {
        const dx = Math.abs(best.x - g.cx) / (CLAW_SPREAD + best.hw * .6), tilt = Math.min(Math.abs(best.a), 1.57) / 1.57;
        const q = (.72 - dx * .7 - tilt * .7 + (Math.random() - .5) * .25) * (best.p.grip ?? 1);   // 抓握穩定度（爪子鬆：就算對準、平正也只有 .72 上下）：越偏中心、越歪越低
        if (q >= .3) {
          best.grabbed = true; g.held = best; best.q = q; best.off = best.x - g.cx;
          g.pathT = 0; g.slipAt = Math.random() < Math.max(.1, Math.min(.95, 1.3 - q * 1.1)) ? .3 + Math.random() * 2.8 : -1;   // 爪子鬆：就算夾得準也有約一半會在半路掉；越不穩越容易掉
        } else g.msg = '抓不穩…';
      } else g.msg = '沒夾到…';
      g.st = 'up'; g.t = 0; sfx([[220, 0, .06]]);
    }
  } else if (g.st === 'up') {
    g.cy -= 60 * dt; g.pathT += dt;
    if (g.cy <= RAIL + 6) { g.cy = RAIL + 6; g.st = 'top'; g.t = 0; }   // 升到最上面：先停一下（獎品在晃）
  } else if (g.st === 'top') {
    g.t += dt; g.pathT += dt;
    if (g.t >= .5) g.st = held ? 'carry' : 'back';
  } else if (g.st === 'carry') {
    if (!g.held) { g.st = 'back'; return; }   // 半路掉了：直接回中間
    g.cx -= 80 * dt; g.pathT += dt;
    if (g.cx <= HOME_X) { g.cx = HOME_X; g.st = 'release'; g.t = 0; }
  } else if (g.st === 'release') {
    g.t += dt;
    if (g.t >= .3 && g.held) releaseHeld();
    if (g.t >= .5 && !g.held && !g.items.some(i => i.falling)) g.st = 'back';   // 掉完了（掉進出口的話 won 已經記下）
  } else if (g.st === 'back') {
    g.cx = Math.max(HOME_X, g.cx - 90 * dt); if (g.cx <= HOME_X) { g.cx = HOME_X; finish(); return; }   // 回到洞口
  }
  if (held && g.slipAt >= 0 && g.pathT >= g.slipAt && g.st !== 'release') { releaseHeld('掉下去了…'); sfx([[330, 0, .05], [220, .05, .1]]); g.slipAt = -1; }
  if (g.held) {   // 被夾著的：跟著爪子，歪的獎品掛著晃（越不穩晃越大），偏移慢慢回正
    const it = g.held, sway = Math.sin(performance.now() / 110) * (1 - Math.min(1, it.q)) * .45;
    it.off *= Math.pow(.5, dt * 1.5);
    it.x = g.cx + it.off; it.y = g.cy + CLAW_LEN - 2 + it.hh * .3; it.a += ((sway) - it.a) * Math.min(1, dt * 4);
    extent(it);
  }
  for (const it of g.items) {   // 掉下來的獎品：往下掉，落在新的表面上，再翻一下
    if (!it.falling) continue;
    it.vy += 420 * dt; it.y += it.vy * dt;
    if (it.x < CHUTE - 8) {   // 在出口上面：掉進出口，算夾到
      if (it.y > FLOOR + 10) { it.gone = true; it.falling = false; g.won = it; }
      continue;
    }
    const surf = surfaceAt(g.items, it.x - it.hw * .7, it.x + it.hw * .7, it);
    if (it.y + it.hh >= surf) {
      it.y = surf - it.hh; it.falling = false; it.vy = 0;
      it.a = Math.max(-1.35, Math.min(1.35, it.a + (Math.random() - .5) * 1.3)); extent(it);   // 落地翻一下
      it.y = surfaceAt(g.items, it.x - it.hw * .7, it.x + it.hw * .7, it) - it.hh;
    }
  }
}
function finish() {
  const g = G, won = g.won; g.st = 'done'; g.won = null;
  if (won) {
    g.items = g.items.filter(i => i !== won);
    let info = {}; try { info = deps?.grant?.(M, won.p) || {}; } catch (e) { console.warn('claw grant:', e); }
    sfx([[660, 0, .08], [880, .08, .08], [1175, .16, .2]]);
    showResult(won.p, info);
  } else { setMsg(g.msg || '沒夾到…再試一次'); g.st = 'idle'; g.msg = ''; }
}

// ---- 畫面 ----
function draw() {
  const c = ui.cv.getContext('2d'); c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#2a1f3d'; c.fillRect(0, 0, W, H);                      // 櫃內背景
  c.fillStyle = '#3b2c57'; for (let y = 0; y < H; y += 8) c.fillRect(0, y, W, 1);
  c.fillStyle = '#1a1226'; c.fillRect(0, FLOOR, W, H - FLOOR);          // 地板
  c.fillStyle = '#5a4378'; c.fillRect(0, FLOOR, W, 2);
  c.fillStyle = '#0c0814'; c.fillRect(0, FLOOR - 4, CHUTE, H - FLOOR + 4); c.fillStyle = '#e07a68'; c.fillRect(0, FLOOR - 6, CHUTE, 2);   // 出口
  c.fillStyle = '#8a7536'; c.fillRect(0, RAIL - 6, W, 4); c.fillStyle = '#c8aa4f'; c.fillRect(0, RAIL - 6, W, 1);   // 軌道
  const drawItem = it => {
    if (it.gone) return;
    const p = it.p, im = loadSheet(p.sheet), [cw, ch] = p.cell;
    c.save(); c.translate(Math.round(it.x), Math.round(it.y)); c.rotate(it.a);
    if (im.complete && im.naturalWidth) c.drawImage(im, (p.idx || 0) * cw, 0, cw, ch, -cw / 2, -ch / 2, cw, ch);
    else { c.fillStyle = '#c85a5a'; c.fillRect(-8, -8, 16, 16); }
    c.restore();
  };
  const order = [...G.items].sort((p, q) => p.y - q.y);   // 上面的先畫（下面的壓在後面）…被夾著的最後畫
  for (const it of order) if (!it.grabbed) drawItem(it);
  c.fillStyle = '#0c0814'; c.fillRect(0, FLOOR - 4, CHUTE, 2);          // 出口的洞（蓋掉掉進去的獎品下半）
  const cx = Math.round(G.cx), cy = Math.round(G.cy), open = G.st === 'idle' || G.st === 'down' || G.st === 'release' || G.st === 'back' || (G.st === 'close' && G.t < .15);
  c.fillStyle = '#d8dcec'; c.fillRect(cx - 1, RAIL - 4, 2, cy - (RAIL - 4));    // 吊線
  c.fillStyle = '#a0a8c0'; c.fillRect(cx - 5, cy, 10, 4);                       // 爪座
  c.fillStyle = '#d8dcec';                                                      // 兩根爪（張開／閉合）
  const sp = open ? CLAW_SPREAD : CLAW_SPREAD - 5;
  c.fillRect(cx - sp - 1, cy + 4, 2, 12); c.fillRect(cx + sp - 1, cy + 4, 2, 12);
  c.fillRect(cx - sp - 1 + (open ? -2 : 2), cy + 14, 4, 2); c.fillRect(cx + sp - 3 + (open ? 2 : -2), cy + 14, 4, 2);
  if (G.held) drawItem(G.held);                                                 // 被夾著的畫在爪子前面
  if (G.st === 'idle') { c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(cx - 1, cy + 18, 2, FLOOR - cy - 18); }   // 對準線（淡淡的）
}
function loop(now) {
  if (!box || box.classList.contains('hidden')) { raf = 0; return; }
  if (!G) { raf = requestAnimationFrame(loop); return; }
  const dt = Math.min(.05, (now - (G.last || now)) / 1000); G.last = now;
  if (G.st !== 'done' && G.st !== 'result') step(dt);
  if (G) draw();
  raf = requestAnimationFrame(loop);
}

function showResult(prize, info) {
  G.st = 'result';
  ui.result.innerHTML = '';
  const card = el('div', 'cl-card');
  const [cw, ch] = prize.cell, im = el('div', 'cl-ico'); const k = Math.min(96 / cw, 96 / ch);
  im.style.cssText = `width:${Math.round(cw * k)}px;height:${Math.round(ch * k)}px;background:url(${prize.sheet}) no-repeat;background-size:${prize.cols * 100}% 100%;background-position:${prize.cols > 1 ? (prize.idx || 0) / (prize.cols - 1) * 100 : 0}% 0;image-rendering:pixelated`;
  card.append(el('div', 'cl-get', '夾到了！'), im, el('div', 'cl-name', prize.name));
  if (info.note) card.appendChild(el('div', 'cl-note', info.note));
  const again = el('button', 'ff-btn', '再玩一次'); again.onclick = () => { ui.result.classList.add('hidden'); start(true); };
  const close_ = el('button', 'ff-btn', '關閉'); close_.onclick = () => close();
  const row = el('div', 'cl-btns'); row.append(again, close_); card.appendChild(row);
  ui.result.appendChild(card); ui.result.classList.remove('hidden');
}

function start(keep) {   // keep＝true：沿用上一局留下的獎品（「再玩一次」）；false：重新擺（剛打開機台）
  G = newRound(keep && G ? G.items : null); setMsg('');
  if (!raf) raf = requestAnimationFrame(loop);
}

function build() {
  box = el('div'); box.id = 'clawBox'; box.classList.add('hidden');
  const panel = el('div', 'cl-panel'), head = el('div', 'cl-head'); ui = {};
  ui.title = el('span', 'cl-title'); const x = el('button', 'ff-btn small', '關閉'); x.onclick = () => close(); head.append(ui.title, x);
  ui.cv = el('canvas', 'cl-cv'); ui.cv.width = W; ui.cv.height = H;
  ui.stage = el('div', 'cl-stage'); ui.result = el('div', 'cl-result hidden'); ui.stage.append(ui.cv, ui.result);
  ui.msg = el('div', 'cl-msg');
  const ctl = el('div', 'cl-ctl');
  const hold = (b, key) => { const on = e => { e.preventDefault(); if (G) G.keys[key] = true; }, off = () => { if (G) G.keys[key] = false; }; b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off); };
  const bl = el('button', 'ff-btn cl-mv', '◀'), br = el('button', 'ff-btn cl-mv', '▶'), bd = el('button', 'ff-btn cl-go', '下爪');
  hold(bl, 'left'); hold(br, 'right'); bd.onclick = () => drop();
  ctl.append(bl, bd, br);
  panel.append(head, ui.stage, ui.msg, ctl, el('div', 'cl-hint', '← → 移動　空白／↓ 下爪　Esc 關閉'));
  box.appendChild(panel);
  box.addEventListener('mousedown', e => { if (e.target === box) close(); });
  (document.getElementById('app') || document.body).appendChild(box);
  addEventListener('keydown', e => {
    if (!box || box.classList.contains('hidden') || !G) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { e.preventDefault(); close(); return; }
    if (k === 'arrowleft' || k === 'a') { G.keys.left = true; e.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { G.keys.right = true; e.preventDefault(); }
    else if (k === ' ' || k === 'arrowdown' || k === 's' || k === 'enter') { e.preventDefault(); drop(); }
  });
  addEventListener('keyup', e => { if (!G) return; const k = e.key.toLowerCase(); if (k === 'arrowleft' || k === 'a') G.keys.left = false; if (k === 'arrowright' || k === 'd') G.keys.right = false; });
}

// ---- 對外 ----
export async function openClaw(id, d) {
  deps = d;
  try { DB ||= await fetch('assets/claw/claw.json').then(r => r.json()); } catch { d.toast?.('夾娃娃機現在壞掉了', 1800); return false; }
  M = DB.machines?.[id];
  if (!M) { d.toast?.('這台夾娃娃機還沒開放', 1600); return false; }
  if (!box) build();
  for (const p of M.prizes) loadSheet(p.sheet);
  ui.title.textContent = M.name; ui.result.classList.add('hidden');
  start(false); box.classList.remove('hidden');
  return true;
}
export function close() { if (!box) return; box.classList.add('hidden'); G = null; deps?.onClose?.(); }
export const _debug = () => G;   // 測試用：看目前這局的狀態
export const isOpen = () => !!box && !box.classList.contains('hidden');
