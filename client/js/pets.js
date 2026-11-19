// 跟隨寵物（2026-11-19，使用者要求：扭蛋抽到寵物就跟著玩家 10 分鐘、最多 5 隻、像火車一樣一隻接一隻、增益圖示右鍵取消）
// 資料在 assets/pets/pets.json（種類／品種名稱、人數上限、時間、間距），圖是 gen_assets.py 的 pet_sheet 畫的（每種一張橫排 10 格：5 品種 × 2 走路幀）。
// 純客戶端：只有自己看得到自己的寵物（別人看不到、不同步）。剩餘時間存在 localStorage（dcisland.m0.pets，記到期的真實時間），重新整理還在。
// 跟隨方式（2026-11-19 使用者要求）：每隻只看自己前面那一位（第 1 隻看玩家、第 k 隻看第 k−1 隻），前面的人離開超過 follow（px）才開始追，
// 追到離前面 stop（px）就停下來休息（所以玩家站著不動時整串會停住，走遠一點才一隻接一隻跟上）。走起來有一蹦一蹦的步伐（上下彈跳＋左右搖擺），
// 速度越快步伐越密。
const KEY = 'dcisland.m0.pets';
let DB = null, list = [], seq = 0, onChange = () => { }, me0 = null;   // me0＝最近一次看到的玩家（新寵物先站在最後一隻／玩家身上）
const imgs = {};
const PAT_DUR = .55;   // 被點到的壓一下再彈回去的長度（秒）
const frames = {};   // 每一格先切成自己的小畫布：直接從整張 sheet 切來畫，縮放／位移時會漏出相鄰格的邊（走路時像沒擦乾淨的線）
function frameOf(sid, vi, col) {   // 第 vi 個品種（列）的第 col 格（欄）
  const key = `${sid}:${vi}:${col}`;
  if (!frames[key]) {
    const im = imgs[sid], sp = DB.species[sid]; if (!im?.complete || !im.naturalWidth) return null;
    const [cw, ch] = sp.cell, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(im, col * cw, vi * ch, cw, ch, 0, 0, cw, ch);
    frames[key] = c;
  }
  return frames[key];
}
// 增益列／卡片用的小圖樣式：把「待機那格」縮放塞進 box×box
export function petIconStyle(d, box = 24) {
  const [cw, ch] = d.species.cell, k = Math.min(box / cw, box / ch), sp = d.species;
  return `width:${Math.round(cw * k)}px;height:${Math.round(ch * k)}px;background-image:url(${sp.sheet});background-size:${sp.cols * 100}% ${sp.rows * 100}%;background-position:0 ${sp.rows > 1 ? d.vi / (sp.rows - 1) * 100 : 0}%`;
}

export const petDef = id => {   // 'cat2' → { sid, vi, species, name }
  const m = /^([a-z]+)(\d)$/.exec(id || ''), sp = m && DB?.species?.[m[1]];
  return sp ? { sid: m[1], vi: +m[2], species: sp, name: `${sp.name}・${sp.variants[+m[2]] ?? ''}` } : null;
};
export const petMax = () => DB?.max ?? 5;
export const petList = () => list;
export const petLeftMs = pt => Math.max(0, pt.until - Date.now());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(list.map(p => ({ id: p.id, until: p.until })))); } catch { /* 存不了不影響 */ } };

export function initPets(db, changeCb) {
  DB = db; onChange = changeCb || onChange;
  if (!DB) return;
  for (const [sid, sp] of Object.entries(DB.species)) { const im = new Image(); im.src = sp.sheet; imgs[sid] = im; }
  try {   // 還原上次的寵物（過期的丟掉）
    for (const r of JSON.parse(localStorage.getItem(KEY) || '[]')) if (petDef(r.id) && r.until > Date.now() && list.length < petMax()) list.push({ uid: ++seq, id: r.id, until: r.until, x: 0, y: 0, face: 1, ph: 0, moving: false, fresh: true });
  } catch { /* 壞掉就當沒有 */ }
  onChange();
}

// 加一隻；回 'ok'／'full'（已達上限）／'bad'（沒有這種寵物）
export function addPet(id) {
  if (!petDef(id)) return 'bad';
  if (list.length >= petMax()) return 'full';
  const lead = list[list.length - 1] || me0;
  list.push({ uid: ++seq, id, until: Date.now() + (DB.minutes ?? 10) * 60000, x: lead?.x ?? 0, y: lead?.y ?? 0, face: 1, ph: 0, spd: 0, go: false, moving: false, fresh: !lead });
  save(); onChange();
  return 'ok';
}
export function removePet(uid) {
  const i = list.findIndex(p => p.uid === uid); if (i < 0) return null;
  const [pt] = list.splice(i, 1); save(); onChange();
  return pt;
}

// 每幀：me＝玩家（x,y 是腳底）；過期的拿掉、每隻各自決定要不要追前面那一位
export function stepPets(dt, me) {
  if (!DB || !me) return;
  me0 = { x: me.x, y: me.y };
  const now = Date.now();
  if (list.some(p => p.until <= now)) { list = list.filter(p => p.until > now); save(); onChange(); }
  const FOLLOW0 = DB.follow ?? 56, STOP0 = DB.stop ?? 40, sc = DB.scale ?? 2;
  const wOf = pt => (petDef(pt.id)?.species.cell[0] ?? 16) * sc;   // 寵物畫面寬度（長的寵物要留更寬的間距，不然會疊在一起）
  if (list.length && Math.hypot(me.x - list[0].x, me.y - list[0].y) > 420) for (const pt of list) { pt.x = me.x; pt.y = me.y; pt.go = false; }   // 換地圖／傳送：直接跟過來
  list.forEach((pt, k) => {
    const lead = k ? list[k - 1] : me, dx = lead.x - pt.x, dy = lead.y - pt.y, d = Math.hypot(dx, dy);
    const STOP = Math.max(STOP0, ((k ? wOf(lead) : 32) + wOf(pt)) / 2 + 8), FOLLOW = STOP + (FOLLOW0 - STOP0);
    if (!pt.go && d > FOLLOW) pt.go = true;
    else if (pt.go && d <= STOP) pt.go = false;
    let spd = 0;
    if (pt.go) {   // 離得越遠追得越快（追得上跑步的玩家）；到 STOP 前一點點減速停下
      spd = Math.min(300, 60 + (d - STOP) * 3.2);
      const step = Math.min(spd * dt, d - STOP + 1);
      pt.x += dx / d * step; pt.y += dy / d * step;
      if (Math.abs(dx) > 1) pt.face = dx > 0 ? 1 : -1;
    }
    pt.spd = spd; pt.moving = spd > 0;
    pt.ph = pt.moving ? pt.ph + dt * (3.2 + spd / 38) : 0;   // 步伐相位（蹦跳用）：走路慢慢蹦、跑起來蹦得快
    pt.bob = (pt.bob || 0) + dt;
    if (pt.pat != null) { pt.pat += dt; if (pt.pat > PAT_DUR) pt.pat = null; }   // 被摸：壓扁再彈回
    if (pt.hearts) { for (const h of pt.hearts) h.t += dt; pt.hearts = pt.hearts.filter(h => h.t < 1); }
    const sp = petDef(pt.id)?.species, fl = !!sp?.float;   // 飄浮的寵物（鳳凰／水母／眼球）：站著也一直拍翅／脈動並上下輕飄，不然像貼圖定在空中
    pt.at = pt.moving ? (pt.at || 0) + dt * Math.min(14, 8 + spd / 30) : fl ? (pt.at || 0) + dt * 6 : 0;
    pt.it = pt.moving ? 0 : (pt.it || 0) + dt * (sp?.idleFps ?? 5);   // 站著時的待機動畫幀計時（有多格待機圖的種類：貓坐著、狐狸搖尾巴、松鼠坐著…）   // 走路動畫的幀計時：固定每秒約 8～14 格（跟蹦跳分開算；之前綁在步伐相位上，14 格的狐狸每秒換約 40 格，看起來頭在亂晃）
  });
}

// 畫面：每隻一個 y 排序項目（跟角色、家具一起排）
export function petEntries(entries, ctx) {
  if (!DB) return;
  const sc = DB.scale ?? 2;
  for (const pt of list) {
    const d = petDef(pt.id), im = imgs[d?.sid]; if (!d || !im?.complete || !im.naturalWidth) continue;
    const sp = d.species, [cw, ch] = sp.cell, W = cw * sc, H = ch * sc;
    entries.push({
      y: pt.y, draw: () => {
        const cyc = pt.ph * Math.PI, hop = pt.moving ? Math.abs(Math.sin(cyc)) : 0;
        const col = (pt.moving || sp.float) ? sp.walk[Math.floor(pt.at || 0) % sp.walk.length] : (sp.idle?.length ? sp.idle[Math.floor(pt.it || 0) % sp.idle.length] : 0), lift = Math.round(hop * (2 + Math.min(2, pt.spd / 120))), sway = pt.moving ? Math.round(Math.sin(cyc) * 1.2) : 0;   // 全部取整數像素：不旋轉、不縮放，邊緣才不會糊或漏線
        const fc = frameOf(d.sid, d.vi, col); if (!fc) return;
        ctx.save(); ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = 'rgba(10,14,20,.28)'; ctx.beginPath(); ctx.ellipse(pt.x, pt.y - 1, W * (.34 - hop * .04), Math.max(3, H * .12), 0, 0, Math.PI * 2); ctx.fill();
        const floatY = sp.float ? Math.round(Math.sin((pt.bob || 0) * 2.6) * 2.5) : 0;   // 飄浮：上下輕輕浮動
        ctx.translate(Math.round(pt.x), Math.round(pt.y) - lift - floatY);
        if (pt.face < 0) ctx.scale(-1, 1);
        if (pt.pat != null) {   // 被摸：先壓扁（約 .12 秒）→ 彈高 → 回原狀；以腳底為軸
          const t = pt.pat, sy = t < .12 ? 1 - .35 * (t / .12) : t < .32 ? .65 + .5 * ((t - .12) / .2) : 1.15 - .15 * ((t - .32) / (PAT_DUR - .32)), sx = 1 + (1 - sy) * .6, dr = (sp.drop ?? 0) * sc;
          ctx.translate(0, dr); ctx.scale(sx, sy); ctx.translate(0, -dr);
        }
        ctx.drawImage(fc, 0, 0, cw, ch, -W / 2 + sway, -H + (sp.drop ?? 0) * sc, W, H);
        ctx.restore();
        for (const h of pt.hearts || []) drawHeart(ctx, Math.round(pt.x + h.ox + Math.sin(h.t * 6 + h.ph) * 3), Math.round(pt.y - H - 6 - h.t * 30), h.t);   // 愛心往上飄、後段淡出
      }
    });
  }
}

// ---- 摸寵物（2026-11-19，使用者要求：空手點寵物＝玩家不揮拳，寵物被壓一下再彈回去＋愛心）----
export function petAtPoint(wx, wy) {   // 世界座標點到哪隻寵物（排在前面＝畫在上面的優先）
  if (!DB) return null;
  const sc = DB.scale ?? 2;
  for (const pt of [...list].reverse()) {
    const d = petDef(pt.id); if (!d) continue;
    const [cw, ch] = d.species.cell, W = cw * sc, H = ch * sc, dr = (d.species.drop ?? 0) * sc;
    if (wx >= pt.x - W / 2 && wx <= pt.x + W / 2 && wy >= pt.y - H + dr && wy <= pt.y + dr) return pt;
  }
  return null;
}
export function petPat(pt) {
  pt.pat = 0;
  pt.hearts = (pt.hearts || []).concat([{ ox: Math.round(Math.random() * 10 - 5), t: 0, ph: Math.random() * 6 }]);   // 點一下一顆愛心（使用者定）
}
const HEART = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function drawHeart(ctx, x, y, t) {
  if (t < 0) return;
  ctx.save(); ctx.globalAlpha = t > .7 ? 1 - (t - .7) / .3 : 1;
  const k = 2;   // 一格＝2px 的像素愛心
  for (let r = 0; r < HEART.length; r++) for (let c = 0; c < 7; c++) if (HEART[r][c] === 'X') { ctx.fillStyle = r < 2 && c < 3 ? '#ffb3cf' : '#ff5d8f'; ctx.fillRect(x + (c - 3) * k, y + r * k, k, k); }
  ctx.restore();
}
