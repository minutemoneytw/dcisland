// 跟隨寵物（2026-11-19，使用者要求：扭蛋抽到寵物就跟著玩家 10 分鐘、最多 5 隻、像火車一樣一隻接一隻、增益圖示右鍵取消）
// 資料在 assets/pets/pets.json（種類／品種名稱、人數上限、時間、間距），圖是 gen_assets.py 的 pet_sheet 畫的（每種一張橫排 10 格：5 品種 × 2 走路幀）。
// 純客戶端：只有自己看得到自己的寵物（別人看不到、不同步）。剩餘時間存在 localStorage（dcisland.m0.pets，記到期的真實時間），重新整理還在。
// 跟隨方式：記下玩家走過的路徑，第 k 隻站在「路徑上往回 (k+1)×gap 像素」的位置，所以轉彎、停下來都是一條線接在後面。
const KEY = 'dcisland.m0.pets';
let DB = null, list = [], seq = 0, onChange = () => { };
const imgs = {};
let trail = [];   // 玩家走過的點，最新的在最後

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
  const last = trail[trail.length - 1];
  list.push({ uid: ++seq, id, until: Date.now() + (DB.minutes ?? 10) * 60000, x: last?.x ?? 0, y: last?.y ?? 0, face: 1, ph: 0, moving: false, fresh: !last });
  save(); onChange();
  return 'ok';
}
export function removePet(uid) {
  const i = list.findIndex(p => p.uid === uid); if (i < 0) return null;
  const [pt] = list.splice(i, 1); save(); onChange();
  return pt;
}

// 每幀：me＝玩家（x,y 是腳底）；過期的拿掉、更新路徑與每隻的位置
export function stepPets(dt, me) {
  if (!DB || !me) return;
  const now = Date.now();
  if (list.some(p => p.until <= now)) { list = list.filter(p => p.until > now); save(); onChange(); }
  const last = trail[trail.length - 1];
  if (!last || Math.hypot(me.x - last.x, me.y - last.y) > 260) trail = [{ x: me.x, y: me.y }];   // 換地圖／傳送：路徑重來，寵物全部疊在玩家身上再慢慢拉開
  else if (Math.hypot(me.x - last.x, me.y - last.y) >= 2) trail.push({ x: me.x, y: me.y });
  const gap = DB.gap ?? 20, need = (petMax() + 1) * gap;
  for (;;) {   // 路徑夠長就丟掉最舊的點（保留到最遠那隻要用到的長度）
    if (trail.length < 3) break;
    let len = 0; for (let i = trail.length - 1; i > 1; i--) len += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
    if (len >= need) trail.shift(); else break;
  }
  list.forEach((pt, k) => {
    const target = (k + 1) * gap;
    let acc = 0, nx = trail[0].x, ny = trail[0].y;
    for (let i = trail.length - 1; i > 0; i--) {
      const a = trail[i], b = trail[i - 1], seg = Math.hypot(a.x - b.x, a.y - b.y);
      if (acc + seg >= target) { const f = seg ? (target - acc) / seg : 0; nx = a.x + (b.x - a.x) * f; ny = a.y + (b.y - a.y) * f; break; }
      acc += seg; nx = b.x; ny = b.y;
    }
    const dx = nx - pt.x, dy = ny - pt.y, mv = Math.hypot(dx, dy);
    pt.moving = mv > .15;
    if (Math.abs(dx) > .05) pt.face = dx > 0 ? 1 : -1;
    pt.x = nx; pt.y = ny;
    pt.ph = pt.moving ? pt.ph + dt : 0;
  });
}

// 畫面：每隻一個 y 排序項目（跟角色、家具一起排）
export function petEntries(entries, ctx) {
  if (!DB) return;
  const sc = DB.scale ?? 2, W = 16 * sc;
  for (const pt of list) {
    const d = petDef(pt.id), im = imgs[d?.sid]; if (!d || !im?.complete || !im.naturalWidth) continue;
    entries.push({
      y: pt.y, draw: () => {
        const fr = pt.moving ? Math.floor(pt.ph * 8) % 2 : 0, sx = (d.vi * 2 + fr) * 16;
        ctx.save(); ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = 'rgba(10,14,20,.28)'; ctx.beginPath(); ctx.ellipse(pt.x, pt.y - 1, W * .3, W * .09, 0, 0, Math.PI * 2); ctx.fill();
        ctx.translate(Math.round(pt.x), Math.round(pt.y));
        if (pt.face < 0) ctx.scale(-1, 1);
        ctx.drawImage(im, sx, 0, 16, 16, -W / 2, -W + 2, W, W);
        ctx.restore();
      }
    });
  }
}
