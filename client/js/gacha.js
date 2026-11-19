// 扭蛋機（2026-11-19，使用者要求：點了選 1 抽或 10+1 抽，有扭蛋掉出來的動畫與開蛋特效，11 抽是 5+5+1 顆快速照順序全部打開）
// 只做「框架」：抽的條件（貨幣）與獎品內容之後再補。資料在 assets/gacha/gacha.json；抽的條件、發獎都是 main.js 傳進來的掛鉤：
//   deps.canPull(M, n) → { ok, reason }   能不能抽（之後接貨幣）
//   deps.grant(M, results)                抽到的獎品清單（發放；可回 { notes: [每顆的提示 {short, title} 或 null], msg } 顯示在卡片與結算列）
//   deps.sfx(list)                        提示音（[[Hz, 開始秒, 長度秒]…]），可省略
// 目前抽籤在客戶端（沒有任何東西會被帶走）。等獎品真的有價值時，抽籤要搬到伺服器（Worker＋dev_server 兩份），不然改封包就能指定結果。
// 純 DOM＋CSS＋Web Animations，沒有 canvas，也不碰同步協定。

let DB = null;   // gacha.json（第一次開才讀）
let box = null, ui = null, deps = null, M = null;
let busy = false, fast = false, token = 0;   // fast＝點一下跳過動畫；token＝每次抽換一個，舊的動畫流程看到不一樣就停手
const running = new Set();

const CAP_COLORS = 6;   // 蛋殼有幾種顏色（圖是 assets/gacha/cap_halves.png，gen_assets.py 的 gacha_capsules 畫；前 6 格各色上半、第 7 格白色下半）
const PER_ROW = 5;   // 11 抽＝5＋5＋1
const SFX = {
  drop: [[330, 0, .05], [220, .05, .08]],
  N: [[660, 0, .08]],
  R: [[660, 0, .07], [880, .07, .12]],
  SR: [[660, 0, .07], [880, .07, .07], [1175, .14, .16]],
  SSR: [[523, 0, .08], [659, .08, .08], [784, .16, .08], [1047, .24, .08], [1319, .32, .3]],
};

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = ms => new Promise(r => { if (fast || ms <= 0) r(); else setTimeout(r, ms); });
function anim(node, frames, opts) {   // Web Animations 包一層：跳過時立刻跑完
  const a = node.animate(frames, opts);
  running.add(a);
  const done = () => running.delete(a);
  a.finished.then(done, done);
  if (fast) a.finish();
  return a.finished.catch(() => { });
}

// ---- 抽籤 ----
export function rollOne(m, rnd = Math.random) {
  const pool = m.rarities.filter(r => m.prizes.some(p => p.rarity === r.id));
  let t = rnd() * pool.reduce((s, r) => s + r.weight, 0), rar = pool[pool.length - 1];
  for (const r of pool) { t -= r.weight; if (t < 0) { rar = r; break; } }
  const list = m.prizes.filter(p => p.rarity === rar.id);
  let w = rnd() * list.reduce((s, p) => s + (p.weight ?? 1), 0), pick = list[list.length - 1];
  for (const p of list) { w -= p.weight ?? 1; if (w < 0) { pick = p; break; } }
  return pick;
}
export const roll = (m, n, rnd) => Array.from({ length: n }, () => rollOne(m, rnd));
const rarOf = (m, id) => m.rarities.find(r => r.id === id) || m.rarities[0];

// ---- 畫面 ----
function build() {
  box = el('div'); box.id = 'gachaBox'; box.classList.add('hidden');
  const panel = el('div', 'gc-panel');
  const head = el('div', 'gc-head'); ui = {};
  ui.title = el('span', 'gc-title');
  const x = el('button', 'ff-btn small', '關閉'); x.onclick = () => close();
  head.append(ui.title, x);
  ui.stage = el('div', 'gc-stage');
  ui.machine = el('div', 'gc-machine');
  const img = el('img'); img.src = 'assets/terrain/peace/gacha_machine.png'; img.alt = ''; img.draggable = false;
  ui.machine.appendChild(img);
  ui.field = el('div', 'gc-field');
  ui.flash = el('div', 'gc-flash');
  ui.stage.append(ui.machine, ui.field, ui.flash);
  ui.stage.onclick = () => { if (busy) skip(); };   // 動畫中點一下＝快轉到結果
  ui.msg = el('div', 'gc-msg');
  ui.btns = el('div', 'gc-btns');
  panel.append(head, ui.stage, ui.msg, ui.btns);
  box.appendChild(panel);
  box.addEventListener('mousedown', e => { if (e.target === box && !busy) close(); });   // 點旁邊的暗處關閉（動畫中不關）
  (document.getElementById('app') || document.body).appendChild(box);
}

function setMsg(t) { ui.msg.textContent = t || ''; }
function setBusy(b) { busy = b; for (const x of ui.btns.querySelectorAll('button')) x.disabled = b && !x.dataset.keep; ui.stage.classList.toggle('gc-busy', b); }

function buildButtons() {
  ui.btns.innerHTML = '';
  for (const p of M.pulls) {
    if (p.hidden) continue;
    const b = el('button', 'ff-btn gc-pull', p.label); b.onclick = () => pull(p.n);
    ui.btns.appendChild(b);
  }
}

function skip() { fast = true; for (const a of [...running]) { try { a.finish(); } catch { } } }

function layout(n) {   // 每個獎品一格：1 抽一格大的；多抽每列 5 顆，最後一列置中
  ui.field.innerHTML = '';
  ui.field.className = 'gc-field' + (n === 1 ? ' gc-one' : '');
  const slots = [];
  for (let i = 0; i < n; i += PER_ROW) {
    const row = el('div', 'gc-row');
    for (let j = i; j < Math.min(n, i + PER_ROW); j++) { const s = el('div', 'gc-slot'); row.appendChild(s); slots.push(s); }
    ui.field.appendChild(row);
  }
  return slots;
}

function capsule(i) {
  const c = el('div', 'gc-cap'); c.style.setProperty('--ci', i % CAP_COLORS);
  c.append(el('i', 't'), el('i', 'b'));
  return c;
}

// 掉出來：從機台出口拋物線落到格子，落地彈兩下
function dropKeyframes(dx, dy) {
  const f = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    f.push({ offset: t * .7, transform: `translate(${dx * (1 - t)}px, ${dy * (1 - t * t)}px) rotate(${(1 - t) * 260}deg) scale(${.55 + .45 * t})`, opacity: t < .08 ? 0 : 1 });
  }
  f.push({ offset: .8, transform: 'translate(0,-16px)' }, { offset: .88, transform: 'translate(0,0)' }, { offset: .94, transform: 'translate(0,-5px)' }, { offset: 1, transform: 'translate(0,0)' });
  return f;
}

async function dropAll(slots, my) {
  const mr = ui.machine.getBoundingClientRect(), ox = mr.left + mr.width / 2, oy = mr.top + mr.height * .8;
  const caps = [];
  for (let i = 0; i < slots.length; i++) {
    if (my !== token) return caps;
    const c = capsule(i); c.style.opacity = '0'; slots[i].appendChild(c); caps.push(c);
    const sr = slots[i].getBoundingClientRect();
    const dx = ox - (sr.left + sr.width / 2), dy = oy - (sr.top + sr.height / 2);
    ui.machine.classList.remove('gc-shake'); void ui.machine.offsetWidth; ui.machine.classList.add('gc-shake');
    deps.sfx?.(SFX.drop);
    c.style.opacity = '';
    anim(c, dropKeyframes(dx, dy), { duration: slots.length === 1 ? 760 : 620, easing: 'steps(22)', fill: 'backwards' });
    await sleep(slots.length === 1 ? 0 : 125);
  }
  await sleep(slots.length === 1 ? 780 : 560);   // 最後一顆落地
  return caps;
}

// 開蛋：蛋殼兩半飛開、閃光＋放射線、獎品卡跳出來。稀有度越高特效越大（SSR 全畫面閃光＋舞台震動）
async function openCap(slot, cap, prize, big, note) {
  const rar = rarOf(M, prize.rarity), rank = M.rarities.indexOf(rar);
  slot.style.setProperty('--rc', rar.color);
  const burst = el('div', 'gc-burst gc-rk' + Math.min(rank, 3));
  for (let k = 0; k < 8 + rank * 4; k++) { const r = el('i', 'ray'); r.style.setProperty('--a', `${(360 / (8 + rank * 4)) * k}deg`); burst.appendChild(r); }
  burst.append(el('b', 'ring'));
  slot.appendChild(burst);
  deps.sfx?.(SFX[rar.id] || SFX.N);
  const t = cap.querySelector('.t'), b = cap.querySelector('.b');
  anim(t, [{ transform: 'none', opacity: 1 }, { transform: 'translate(-40%,-130%) rotate(-50deg)', opacity: 0 }], { duration: 380, easing: 'steps(6)', fill: 'forwards' });
  anim(b, [{ transform: 'none', opacity: 1 }, { transform: 'translate(40%,80%) rotate(40deg)', opacity: 0 }], { duration: 380, easing: 'steps(6)', fill: 'forwards' });
  anim(burst, [{ opacity: 1, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)', offset: .35 }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 520 + rank * 90, easing: 'steps(7)', fill: 'forwards' });
  if (rank >= 2) {   // SR／SSR：整個舞台閃一下；SSR 再加震動
    anim(ui.flash, [{ opacity: 0 }, { opacity: rank >= 3 ? .85 : .45, offset: .2 }, { opacity: 0 }], { duration: rank >= 3 ? 700 : 420, fill: 'none' });
    ui.flash.style.setProperty('--rc', rar.color);
    if (rank >= 3) { ui.stage.classList.remove('gc-quake'); void ui.stage.offsetWidth; ui.stage.classList.add('gc-quake'); }
  }
  const card = el('div', 'gc-card' + (big ? ' gc-big' : ''));
  card.style.setProperty('--rc', rar.color);
  if (M.rarities.length > 1) card.append(el('div', 'gc-rar', rar.id));   // 只有一種稀有度時不顯示標籤
  if (prize.sheet) {   // 寵物之類的精靈圖：sheet 是橫排格子圖（10 格），cell 是第幾格
    const sp = el('div', 'gc-pet'), [cw, ch] = prize.cell, k = Math.min((big ? 96 : 36) / cw, (big ? 96 : 36) / ch);   // 待機那格，縮放塞進框裡
    sp.style.cssText = `width:${Math.round(cw * k)}px;height:${Math.round(ch * k)}px;background-image:url(${prize.sheet});background-size:${prize.cols * 100}% ${prize.rows * 100}%;background-position:0 ${prize.rows > 1 ? prize.row / (prize.rows - 1) * 100 : 0}%`; card.appendChild(sp);
  } else if (prize.img) { const im = el('img'); im.src = prize.img; im.draggable = false; card.appendChild(im); } else card.appendChild(el('div', 'gc-ico'));
  card.append(el('div', 'gc-name', prize.name));
  if (note) { const n = el('div', 'gc-note', note.short || note); if (note.title) card.title = note.title; card.appendChild(n); }
  card.style.opacity = '0'; slot.appendChild(card);
  await sleep(120);
  card.style.opacity = '';
  anim(card, [{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.18)', opacity: 1, offset: .6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 360, easing: 'steps(6)', fill: 'backwards' });
  setTimeout(() => cap.remove(), 420);
  if (rank >= 2) card.classList.add('gc-glow');
}

async function pull(n) {
  if (busy) return;
  const chk = deps.canPull ? deps.canPull(M, n) : { ok: true };
  if (!chk?.ok) { setMsg(chk?.reason || '現在不能抽'); return; }
  const results = roll(M, n);
  const my = ++token; fast = false;
  setBusy(true); setMsg('');
  let info = {};
  try { info = deps.grant?.(M, results) || {}; } catch (e) { console.warn('gacha grant:', e); }   // 回 { notes: [每顆的提示或 null], msg: 結算列的補充 }
  const slots = layout(n);
  const caps = await dropAll(slots, my);
  if (my !== token) return;
  if (n === 1) {   // 單抽：蛋先搖一搖吊吊胃口（SR 以上先透出稀有度的光）
    const rank = M.rarities.indexOf(rarOf(M, results[0].rarity));
    if (rank >= 2) { caps[0].style.setProperty('--hint', rarOf(M, results[0].rarity).color); caps[0].classList.add('gc-hint'); }
    for (let k = 0; k < 3 && my === token; k++) await anim(caps[0], [{ transform: 'rotate(0)' }, { transform: 'rotate(-14deg)' }, { transform: 'rotate(12deg)' }, { transform: 'rotate(0)' }], { duration: 260 });
    await sleep(120);
  } else await sleep(260);
  for (let i = 0; i < n && my === token; i++) { openCap(slots[i], caps[i], results[i], n === 1, info.notes?.[i]); await sleep(n === 1 ? 0 : 130); }
  await sleep(n === 1 ? 520 : 460);
  if (my !== token) return;
  const cnt = {}; for (const p of results) cnt[p.rarity] = (cnt[p.rarity] || 0) + 1;
  setMsg(`獲得 ${n} 件` + (M.rarities.length > 1 ? '　' + M.rarities.filter(r => cnt[r.id]).map(r => `${r.id}×${cnt[r.id]}`).join('　') : '') + (info.msg ? `　${info.msg}` : ''));
  setBusy(false); fast = false;
}

// ---- 對外 ----
export async function openGacha(id, d) {
  deps = d;
  try { DB ||= await fetch('assets/gacha/gacha.json').then(r => r.json()); } catch { d.toast?.('扭蛋機現在壞掉了', 1800); return false; }
  M = DB.machines?.[id];
  if (!M) { d.toast?.('這台扭蛋機還沒開放', 1600); return false; }
  if (!box) build();
  token++; fast = false; running.clear();
  ui.title.textContent = M.name;
  buildButtons(); setBusy(false);
  ui.field.innerHTML = ''; ui.field.className = 'gc-field gc-idle';
  ui.field.appendChild(el('div', 'gc-hintTxt', '選擇要抽幾顆'));
  setMsg('');
  box.classList.remove('hidden');
  return true;
}
export function close() { if (!box) return; token++; box.classList.add('hidden'); deps?.onClose?.(); }
export const isOpen = () => !!box && !box.classList.contains('hidden');
export function escape() { if (busy) skip(); else close(); }   // Esc：動畫中＝快轉，否則關閉
