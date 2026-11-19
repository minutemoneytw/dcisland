// 夾娃娃機（2026-11-19，使用者要求先預做框架；獎品與玩的條件之後再補）
// 資料在 assets/claw/claw.json；玩的條件與發獎是 main.js 傳進來的掛鉤：
//   deps.canPlay(M)            → { ok, reason }   能不能玩一次（之後接貨幣／次數）
//   deps.grant(M, prize)       夾到獎品（發放：寫進背包／衣櫥、同步伺服器）；回 { note } 可顯示在結果卡
//   deps.sfx(list)             提示音（可省略）
//   deps.toast(msg, ms)
// 玩法：←／→（A／D）或按鈕移動爪子，空白／↓／「下爪」放下去；爪子對得越準越容易夾起來、夾起來之後還有機率中途掉回去。
// 目前夾不夾得到在客戶端決定（沒有任何東西會被帶走）；獎品有價值之後要搬到伺服器（Worker＋dev_server 兩份），不然改封包就能指定結果。
// 純 DOM＋canvas，不碰同步協定。畫面用 240×200 的小畫布放大 2 倍、關掉平滑（像素風）。
let DB = null, M = null, deps = null, box = null, ui = null, raf = 0, G = null;
const sheets = {};   // 獎品圖（sheet 路徑 → Image）

const W = 240, H = 200, FLOOR = 176, RAIL = 20, CHUTE = 46, X_MIN = 58, X_MAX = 226;   // 畫布大小、地板、軌道高度、出口右緣、爪子可走的左右範圍
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const loadSheet = src => sheets[src] || (sheets[src] = Object.assign(new Image(), { src }));

function newRound() {   // 擺 8 個獎品：依權重抽（可重複）、橫向打散
  const total = M.prizes.reduce((s, p) => s + (p.weight ?? 1), 0), list = [];
  for (let i = 0; i < (M.slots || 8); i++) {
    let t = Math.random() * total, pick = M.prizes[M.prizes.length - 1];
    for (const p of M.prizes) { t -= p.weight ?? 1; if (t < 0) { pick = p; break; } }
    list.push(pick);
  }
  const span = X_MAX - X_MIN, step = span / list.length;
  const items = list.map((p, i) => ({ p, x: X_MIN + step * (i + .5) + (Math.random() - .5) * step * .6, y: FLOOR - 16 - (Math.random() < .3 ? 8 : 0), grabbed: false, vy: 0 }));
  return { items, cx: 140, cy: RAIL + 6, st: 'idle', t: 0, held: null, slipAt: -1, keys: {}, msg: '' };
}

function sfx(list) { deps?.sfx?.(list); }

// ---- 動作 ----
function drop() { if (G.st !== 'idle') return; const c = deps?.canPlay ? deps.canPlay(M) : { ok: true }; if (!c?.ok) { setMsg(c?.reason || '現在不能玩'); return; } G.st = 'down'; G.msg = ''; setMsg(''); sfx([[300, 0, .05]]); }
function setMsg(t) { if (ui) ui.msg.textContent = t || ''; }

function step(dt) {
  const g = G;
  if (g.st === 'idle') { const dx = ((g.keys.right ? 1 : 0) - (g.keys.left ? 1 : 0)) * 70 * dt; g.cx = Math.max(X_MIN, Math.min(X_MAX, g.cx + dx)); }
  else if (g.st === 'down') {
    g.cy += 90 * dt;
    const floorY = FLOOR - 26;   // 爪子最低能到哪
    if (g.cy >= floorY) { g.cy = floorY; g.st = 'close'; g.t = 0; }
  } else if (g.st === 'close') {
    g.t += dt;
    if (g.t >= .4) {   // 閉爪：看離得最近的獎品多準
      let best = null, bd = 1e9;
      for (const it of g.items) if (!it.grabbed) { const d = Math.abs(it.x - g.cx); if (d < bd) { bd = d; best = it; } }
      const chance = bd <= 8 ? .8 : bd <= 16 ? .5 : bd <= 26 ? .2 : 0;
      if (best && Math.random() < chance) { best.grabbed = true; g.held = best; g.slipAt = Math.random() < .3 ? .25 + Math.random() * .6 : -1; g.slipFrom = g.cx; }   // 30% 的機率會在半路掉下去
      g.st = 'up'; g.t = 0; sfx([[220, 0, .06]]);
    }
  } else if (g.st === 'up') {
    g.cy -= 60 * dt;
    if (g.held) { g.held.x = g.cx; g.held.y = g.cy + 22; }
    if (g.held && g.slipAt >= 0 && (FLOOR - 26 - g.cy) / (FLOOR - 26 - (RAIL + 6)) >= g.slipAt) { g.held.grabbed = false; g.held.vy = 0; g.held = null; g.slipAt = -1; g.msg = '掉下去了…'; sfx([[330, 0, .05], [220, .05, .1]]); }
    if (g.cy <= RAIL + 6) { g.cy = RAIL + 6; g.st = 'carry'; }
  } else if (g.st === 'carry') {
    if (!g.held) { g.st = 'back'; return; }
    g.cx -= 80 * dt; g.held.x = g.cx; g.held.y = g.cy + 22;
    if (g.cx <= 26) { g.cx = 26; g.st = 'release'; g.t = 0; }
  } else if (g.st === 'release') {
    g.t += dt;
    if (g.t >= .3 && g.held) { g.held.grabbed = false; g.held.vy = 0; g.held.fall = true; g.won = g.held; g.held = null; }
    if (g.won?.gone) g.st = 'back';   // 獎品掉進出口了，爪子回中間
  } else if (g.st === 'back') {
    g.cx += 90 * dt; if (g.cx >= 140) { g.cx = 140; finish(); }
  }
  for (const it of g.items) {   // 掉落的獎品：往地板掉（出口那邊掉進出口後消失）
    if (it.grabbed) continue;
    const rest = it.fall ? FLOOR - 4 : FLOOR - 16;
    if (it.y < rest) { it.vy += 400 * dt; it.y = Math.min(rest, it.y + it.vy * dt); if (it.y >= rest) { it.vy = 0; if (it.fall) it.gone = true; } }
  }
}
function finish() {
  const g = G, won = g.won; G.st = 'done'; g.won = null;
  if (won) {
    G.items = G.items.filter(i => i !== won);
    let info = {}; try { info = deps?.grant?.(M, won.p) || {}; } catch (e) { console.warn('claw grant:', e); }
    sfx([[660, 0, .08], [880, .08, .08], [1175, .16, .2]]);
    showResult(won.p, info);
  } else { setMsg(g.msg || '沒夾到…再試一次'); G.st = 'idle'; G.msg = ''; }
}

// ---- 畫面 ----
function draw() {
  const c = ui.cv.getContext('2d'); c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#2a1f3d'; c.fillRect(0, 0, W, H);                      // 櫃內背景
  c.fillStyle = '#3b2c57'; for (let y = 0; y < H; y += 8) c.fillRect(0, y, W, 1);
  c.fillStyle = '#1a1226'; c.fillRect(0, FLOOR, W, H - FLOOR);          // 地板
  c.fillStyle = '#5a4378'; c.fillRect(0, FLOOR, W, 2);
  c.fillStyle = '#0c0814'; c.fillRect(0, FLOOR - 4, CHUTE, H - FLOOR + 4); c.fillStyle = '#e07a68'; c.fillRect(0, FLOOR - 6, CHUTE, 2); c.fillStyle = '#fff6e0'; c.font = '8px sans-serif'; c.fillText('出口', 10, FLOOR + 14);   // 出口
  c.fillStyle = '#8a7536'; c.fillRect(0, RAIL - 6, W, 4); c.fillStyle = '#c8aa4f'; c.fillRect(0, RAIL - 6, W, 1);   // 軌道
  for (const it of G.items) {   // 獎品
    if (it.gone) continue;
    const p = it.p, im = loadSheet(p.sheet);
    if (im.complete && im.naturalWidth) { const [cw, ch] = p.cell; c.drawImage(im, (p.idx || 0) * cw, 0, cw, ch, Math.round(it.x - cw / 2), Math.round(it.y), cw, ch); }
    else { c.fillStyle = '#c85a5a'; c.fillRect(Math.round(it.x - 8), Math.round(it.y), 16, 16); }
  }
  const cx = Math.round(G.cx), cy = Math.round(G.cy), open = G.st === 'idle' || G.st === 'down' || G.st === 'release' || G.st === 'back';
  c.fillStyle = '#d8dcec'; c.fillRect(cx - 1, RAIL - 4, 2, cy - (RAIL - 4));    // 吊線
  c.fillStyle = '#a0a8c0'; c.fillRect(cx - 5, cy, 10, 4);                       // 爪座
  c.fillStyle = '#d8dcec';                                                      // 兩根爪（張開／閉合）
  const sp = open ? 9 : 4;
  c.fillRect(cx - sp - 1, cy + 4, 2, 12); c.fillRect(cx + sp - 1, cy + 4, 2, 12);
  c.fillRect(cx - sp - 1 + (open ? -2 : 2), cy + 14, 4, 2); c.fillRect(cx + sp - 3 + (open ? 2 : -2), cy + 14, 4, 2);
  if (G.st === 'idle') { c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(cx - 1, cy + 16, 2, FLOOR - cy - 16); }   // 對準線（淡淡的）
}
function loop(now) {
  if (!box || box.classList.contains('hidden')) { raf = 0; return; }
  const dt = Math.min(.05, (now - (G.last || now)) / 1000); G.last = now;
  if (G.st !== 'done' && G.st !== 'result') step(dt);
  draw();
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
  const again = el('button', 'ff-btn', '再玩一次'); again.onclick = () => { ui.result.classList.add('hidden'); start(); };
  const close_ = el('button', 'ff-btn', '關閉'); close_.onclick = () => close();
  const row = el('div', 'cl-btns'); row.append(again, close_); card.appendChild(row);
  ui.result.appendChild(card); ui.result.classList.remove('hidden');
}

function start() {
  G = newRound(); setMsg('');
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
  start(); box.classList.remove('hidden');
  return true;
}
export function close() { if (!box) return; box.classList.add('hidden'); G = null; deps?.onClose?.(); }
export const isOpen = () => !!box && !box.classList.contains('hidden');
