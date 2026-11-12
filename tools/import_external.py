#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 — img2pixel 外部素材導入（一條龍）：
#   zip／資料夾（逐幀 PNG）、現成 sprite sheet PNG（自動切格）、GIF（逐幀，需 Pillow）
#   → 檢查 → 透明區 RGB 正規化 → 等寬水平 sheet（多列方向網格保留列結構）
#   → 寫進 client/assets/external/img2pixel/，並印出 gen_assets.py／assets-license.md 的登記草稿
# 用法:
#   python tools/import_external.py <zip／資料夾／sheet.png／.gif> <輸出.png> [--skip N] [--frames N] [--fw W] [--rows N] [--fps N]
#   例: python tools/import_external.py 究極神兵.zip my_boss_sheet.png        （逐幀 zip）
#       python tools/import_external.py 下載的_sheet.png my_mob_sheet.png     （現成 sheet：自動切格）
#       python tools/import_external.py 下載的_sheet.png my_mob_sheet.png --fw 32 --rows 4   （連在一起的幀切不出格線時手動指定）
#       python tools/import_external.py walk.gif my_mob_sheet.png             （GIF 逐幀）
# 說明:
#   - zip／資料夾：第一層 .png 按檔名排序＝幀序；--skip 跳過開頭幾張（封面、示意圖）、--frames 只用前 N 張
#   - sheet PNG：切格重拼成等寬水平 sheet（多列＝方向網格，列結構保留）；幀與幀**相連**（沒有整欄透明分隔）的
#     sheet 偵測不出格線，要手動給 --fw（之後每列幀數＝寬 ÷ fw）；多列方向網格再給 --rows
#   - GIF：每個影格＝一幀；GIF 是索引色，會自動轉 8-bit RGBA（需要 Pillow：pip install pillow），並依影格時長建議 fps
#   - 每張幀都要 8-bit RGBA（不是的話有 Pillow 會自動轉）；不是透明底時遊戲端要設 keyBg，屆時在 gen_assets.py 登記
#   - 每格底部留白不用裁：產生器會量測補 footDy（見 docs/notes.md「野外動物」的新增怪物規範）
#   - 內容感知寫檔：像素與既有 sheet 一模一樣就不重寫（與 gen_assets.py 同一套）
#   - 工具只印登記草稿、不代改程式碼（避免機器改壞 manifest 的註解與排版）
import argparse, glob, os, statistics, sys
# Windows 主控台常見 cp950：印不出 ⚠ 等符號會直接 UnicodeEncodeError 崩潰 → 無法編碼的字元以替代符號輸出
try:
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_assets as g

def pil_rgba(im):
    """PIL Image → (w, h, RGBA bytes)"""
    im = im.convert("RGBA")
    return im.width, im.height, im.tobytes()

def decode_any_png(data):
    """8-bit RGBA 直接解；不是的話（索引色等）用 Pillow 自動轉 RGBA 再解（沒有 Pillow 就印手動轉檔指令）"""
    d = g.decode_png_bytes(data)
    if d is not None:
        return d
    try:
        import io
        from PIL import Image
    except ImportError:
        sys.exit("這張 PNG 不是 8-bit RGBA（索引色／調色盤）。請先用 Pillow 轉檔再導入：\n"
                 '  python -c "from PIL import Image; Image.open(\'來源.png\').convert(\'RGBA\').save(\'輸出.png\')"\n'
                 "（或先 pip install pillow，之後本工具會自動轉）")
    return pil_rgba(Image.open(io.BytesIO(data)))

def norm_transparent(fw, fh, pix):
    """透明像素（alpha=0）的 RGB 一律正規化為 0（img2pixel 匯出批次不同會在透明區留 RGB 雜訊，正規化後每次導入一致）"""
    pix = bytearray(pix)
    for k in range(3, len(pix), 4):
        if pix[k] == 0 and (pix[k - 3] or pix[k - 2] or pix[k - 1]):
            pix[k - 3] = pix[k - 2] = pix[k - 1] = 0
    return fw, fh, pix

def load_frames_zip_or_dir(src, skip, only):
    """zip／資料夾：第一層 PNG 按檔名排序＝幀序。回傳 (frames, suggested_fps)"""
    items = []
    if src.lower().endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(src) as z:
            items = [(os.path.basename(i.filename), z.read(i)) for i in z.infolist()
                     if not i.is_dir() and "/" not in i.filename and i.filename.lower().endswith(".png")]
    else:
        for p in glob.glob(os.path.join(src, "*.png")):
            items.append((os.path.basename(p), open(p, "rb").read()))
    items.sort(key=lambda kv: kv[0])
    if len(items) <= skip:
        sys.exit(f"找不到可用的 PNG（共 {len(items)} 張，--skip {skip}）")
    items = items[skip:][:only or None]
    if len(items) < 2:
        sys.exit("少於 2 張幀圖就沒有動畫可言，直接手放單張圖到 external/img2pixel/ 即可")
    frames = []
    for name, data in items:
        fw, fh, pix = decode_any_png(data)
        if frames and (fw, fh) != (frames[0][0], frames[0][1]):
            sys.exit(f"  {name}: 尺寸 {fw}x{fh} 與第一張 {frames[0][0]}x{frames[0][1]} 不同（全部幀都要同尺寸）")
        frames.append(norm_transparent(fw, fh, pix))
    return frames, 0

def load_frames_gif(src, skip, only):
    """GIF：每個影格＝一幀（自動轉 RGBA），依影格時長的中位數建議 fps。回傳 (frames, suggested_fps)"""
    try:
        from PIL import Image, ImageSequence
    except ImportError:
        sys.exit("GIF 導入需要 Pillow（pip install pillow），或先把 GIF 轉成逐幀 PNG 再用 zip／資料夾導入")
    im = Image.open(src)
    durs, frames = [], []
    for f in ImageSequence.Iterator(im):
        durs.append(f.info.get("duration", 100))
        frames.append(norm_transparent(*pil_rgba(f)))
    if len(frames) <= skip:
        sys.exit(f"這個 GIF 只有 {len(frames)} 個影格（--skip {skip} 跳光了）")
    frames = frames[skip:][:only or None]
    if len(frames) < 2:
        sys.exit("剩下少於 2 個影格就沒有動畫可言")
    fps = round(1000 / statistics.median(durs)) if durs and min(durs) > 0 else 0
    return frames, max(1, min(30, fps))

def detect_grid(w, h, pix, fw_arg, rows_arg):
    """sheet 切格：--fw／--rows 照用；沒給則靠「整欄／整列透明」的格線偵測。回傳 (fw, fh, cols, rows)"""
    def col_transparent(x):
        return all(pix[(y * w + x) * 4 + 3] == 0 for y in range(h))
    def row_transparent(y):
        return all(pix[(y * w + x) * 4 + 3] == 0 for x in range(w))
    # 幀寬：候選＝能整除寬、且每個格界欄整欄透明（有分隔線才切得準）
    if fw_arg:
        fw = fw_arg
        if w % fw: sys.exit(f"--fw {fw} 無法整除 sheet 寬 {w}")
    else:
        cands = [c for c in range(8, w // 2 + 1) if w % c == 0
                 and all(col_transparent(k * c) for k in range(1, w // c))]
        if not cands:
            facs = [c for c in range(8, w // 2 + 1) if w % c == 0]
            sys.exit(f"切不出格線（幀與幀相連、沒有整欄透明的分隔）。請手動指定 --fw；\n"
                     f"sheet 寬 {w} 的可用因數：{facs or '無（寬度是質數？）'}")
        fw = min(cands)   # 最小候選＝幀數最多的切法
    cols = w // fw
    # 列數：--rows 照用；沒給則把「有內容的列」依透明帶分組，n 組且每組完整落在 h/n 的格帶內才採用
    if rows_arg:
        rows = rows_arg
        if h % rows: sys.exit(f"--rows {rows} 無法整除 sheet 高 {h}")
    else:
        content_rows = [y for y in range(h) if not row_transparent(y)]
        groups = []
        for y in content_rows:
            if groups and y == groups[-1][1] + 1: groups[-1][1] = y
            else: groups.append([y, y])
        n = len(groups)
        rows = 1
        if n > 1 and h % n == 0:
            fh_try = h // n
            if all(s // fh_try == (e - 1) // fh_try for s, e in groups):
                rows = n
    fh = h // rows
    if rows == 1 and h > 2.5 * fw:
        print(f"⚠ sheet 高 {h} 是幀寬 {fw} 的 {h / fw:.1f} 倍——若這其實是多列方向網格，請加 --rows 重跑")
    return fw, fh, cols, rows

def sheet_cells(w, h, pix, fw, fh, cols, rows):
    """切出每格（逐列由左至右），檢查每格都有內容；回傳 [(fw, fh, pix), …]（同一列內）與每格內容 bbox 高度"""
    cells, warns = [], []
    content_h = 0
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * fw, r * fh
            cell = bytearray()
            for y in range(y0, y0 + fh):
                cell += pix[(y * w + x0) * 4:(y * w + x0 + fw) * 4]
            has = any(cell[k + 3] > 0 for k in range(0, len(cell), 4))
            if not has:
                warns.append(f"  ⚠ 第 {r} 列第 {c} 格全透明（多餘的空格；登記時用 row0／rows 跳過即可）")
            for k in range(3, len(cell), 4):
                if cell[k] == 0: cell[k - 3] = cell[k - 2] = cell[k - 1] = 0
            rows_with = [yy for yy in range(fh) if any(cell[(yy * fw + xx) * 4 + 3] > 0 for xx in range(fw))]
            if rows_with: content_h = max(content_h, rows_with[-1] - rows_with[0] + 1)
            cells.append((fw, fh, cell))
    return cells, content_h, warns

def main():
    ap = argparse.ArgumentParser(description="外部素材 → img2pixel 水平 sheet（zip／資料夾／sheet PNG／GIF）")
    ap.add_argument("src", help="來源：逐幀 PNG 的 zip／資料夾、現成 sprite sheet 的 PNG、或 GIF")
    ap.add_argument("name", help="輸出檔名（.png，放進 client/assets/external/img2pixel/），例：my_mob_sheet.png")
    ap.add_argument("--skip", type=int, default=0, help="（zip／資料夾／GIF）先跳過幾張")
    ap.add_argument("--frames", type=int, default=0, help="（zip／資料夾／GIF）只用前 N 張")
    ap.add_argument("--fw", type=int, default=0, help="（sheet）幀寬 px（幀相連切不出格線時必給）")
    ap.add_argument("--rows", type=int, default=0, help="（sheet）列數（多列方向網格；預設 1）")
    ap.add_argument("--fps", type=int, default=0, help="登記草稿裡 anim 的 fps 建議值（預設 8；GIF 會依影格時長建議）")
    a = ap.parse_args()
    warns = []
    if not a.name.lower().endswith(".png"):
        sys.exit("輸出檔名要用 .png 結尾")
    if "/" in a.name or "\\" in a.name or ".." in a.name:
        sys.exit("輸出檔名只要檔名本身（會固定放進 client/assets/external/img2pixel/）")

    src_lower = a.src.lower()
    if src_lower.endswith(".gif"):
        frames, sugg_fps = load_frames_gif(a.src, a.skip, a.frames)
        rows, cols = 1, len(frames)
        fw, fh = frames[0][0], frames[0][1]
        src_desc = f"GIF {len(frames)} 影格"
    elif src_lower.endswith(".png"):
        w, h, pix = decode_any_png(open(a.src, "rb").read())
        fw, fh, cols, rows = detect_grid(w, h, pix, a.fw, a.rows)
        frames, content_h, warns = sheet_cells(w, h, pix, fw, fh, cols, rows)
        sugg_fps = 0
        src_desc = f"sheet {w}x{h} 切成 {cols} 幀 × {rows} 列（每格 {fw}x{fh}）"
    else:
        frames, sugg_fps = load_frames_zip_or_dir(a.src, a.skip, a.frames)
        rows, cols = 1, len(frames)
        fw, fh = frames[0][0], frames[0][1]
        src_desc = f"{len(frames)} 張逐幀 PNG"

    # 尺寸一致性（sheet 切格本來就等大；zip／資料夾已在載入時檢查）
    if rows == 1 and cols > 1 and any((f[0], f[1]) != (fw, fh) for f in frames):
        sys.exit("幀尺寸不一致（不應發生；請回報）")

    # 水平拼 sheet（多列＝方向網格，每列 rows、每列 cols 幀）
    sheet_w, sheet_h = fw * cols, fh * rows
    sheet_path = os.path.join(g.ASSETS, "external", "img2pixel", a.name)
    pix_out = bytearray()
    for r in range(rows):
        for y in range(fh):
            for c in range(cols):
                cell = frames[r * cols + c][2]
                pix_out += cell[y * fw * 4:(y + 1) * fw * 4]
    g.write_png(sheet_path, sheet_w, sheet_h, lambda x, y: pix_out[(y * sheet_w + x) * 4:(y * sheet_w + x) * 4 + 4])

    has_alpha = any(f[2][k + 3] == 0 for f in frames for k in range(0, len(f[2]), 4))
    keybg = "false（透明底）" if has_alpha else "true（整張不透明）"
    rel = f"external/img2pixel/{a.name}"
    rows_txt = f", rows={rows}" if rows > 1 else ""
    rowdir_hint = ("\n   多列方向網格：anim 再補 rowDir（例：rowDir=[\"up\",\"right\",\"down\",\"left\"]），"
                   "素材沒畫的方向用對向列鏡像——見 docs/notes.md「野外動物」的新增怪物規範") if rows > 1 else ""
    fps = a.fps or sugg_fps or 8
    # 建議 scale：實際內容高 × scale ≈ 20–30px（小動物；AGENTS.md 慣例 10：先量內容大小再定 scale）
    if src_lower.endswith(".png"):
        ch = content_h
    else:
        ch = 0
        for f in frames:
            rows_with = [yy for yy in range(fh) if any(f[2][(yy * fw + xx) * 4 + 3] > 0 for xx in range(fw))]
            if rows_with: ch = max(ch, rows_with[-1] - rows_with[0] + 1)
    scales = [f"{s}（畫面高 {ch * s}px）" for s in (2, 3, 4, 5) if 18 <= ch * s <= 40] or ["自行依內容大小調整"]
    for wmsg in warns: print(wmsg)
    print(f"""
已寫出：client/{rel}（{src_desc}；共 {cols * rows} 格，每格 {fw}x{fh}，內容高約 {ch}px）

登記草稿（工具不代改程式碼，照著貼）：
1) tools/gen_assets.py 的 EXTERNAL_BUNDLES 加一條：
     dict(sheet="{rel}", frames={cols}, fw={fw}, fh={fh}{rows_txt}, what="這張 sheet 是什麼"),
2) 是動物／島主：MOB_MANIFEST 該條目加 anim（是島主再登記 OWNER_BY_TERRAIN）：
     anim=dict(sheet="{rel}", frames={cols}, fps={fps}, scale=<見下>, keyBg={'True' if not has_alpha else 'False'}),{rowdir_hint}
   keyBg 此時建議：{keybg}
   scale 建議（內容高 {ch}px、小動物畫面約 20–30px）：{('、'.join(scales))}
3) docs/assets-license.md 補一列（來源／授權要自己填）：
     | `client/{rel}` | <範圍：{cols * rows} 格（{rows} 列 × {cols} 幀），每格 {fw}x{fh}> | <來源 URL>（<授權>，作者 <名字>） | <引入日期、怎麼切的、接線到哪> |
""")

if __name__ == "__main__":
    main()
