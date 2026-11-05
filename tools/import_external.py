#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DC島 — img2pixel 外部素材導入：逐幀 PNG（zip 或資料夾）→ 檢查 → 水平拼成一張 sheet → 寫進 client/assets/external/img2pixel/
# 用法:
#   python tools/import_external.py <zip 或資料夾> <輸出檔名.png> [--skip N] [--frames N]
#   例: python tools/import_external.py 究極神兵.zip my_boss_sheet.png
# 說明:
#   - 來源是第一層的全部 .png（zip 內檔名排序＝幀序、資料夾內也是）；--skip 跳過開頭幾張（封面、示意圖）、--frames 只用前 N 張
#   - 每張都要是 8-bit RGBA（img2pixel 匯出的透明底 PNG）；不是透明底時遊戲端要設 keyBg，屆時在 gen_assets.py 登記
#   - 全部幀都要同尺寸（水平排列才成立）
#   - 內容感知寫檔：像素與既有 sheet 一模一樣就不重寫（與 gen_assets.py 同一套）
# 拼完之後還要手動登記（工具不代改程式）:
#   1. tools/gen_assets.py 的 EXTERNAL_BUNDLES 加一條 dict
#   2. 是動物／島主：MOB_MANIFEST 該條目加 anim（sheet／frames／fps／scale／keyBg）；是島主再登記 OWNER_BY_TERRAIN
#   3. docs/assets-license.md 記素材來源與授權
import argparse, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_assets as g

def main():
    ap = argparse.ArgumentParser(description="img2pixel 逐幀素材 → 水平 sheet（純 Python 標準庫）")
    ap.add_argument("src", help="逐幀 PNG 的 zip 或資料夾（只看第一層）")
    ap.add_argument("name", help="輸出檔名（.png，放進 client/assets/external/img2pixel/），例：my_boss_sheet.png")
    ap.add_argument("--skip", type=int, default=0, help="檔名排序後先跳過幾張（預設 0）")
    ap.add_argument("--frames", type=int, default=0, help="只用前 N 張（預設全部）")
    a = ap.parse_args()
    if not a.name.lower().endswith(".png"):
        sys.exit("輸出檔名要用 .png 結尾")
    if "/" in a.name or "\\" in a.name or ".." in a.name:
        sys.exit("輸出檔名只要檔名本身（會固定放進 client/assets/external/img2pixel/）")

    # 收集幀：zip 取第一層 PNG 位元組、資料夾取 PNG 檔；兩種都按檔名排序排幀序
    items = []
    if a.src.lower().endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(a.src) as z:
            items = [(os.path.basename(i.filename), z.read(i)) for i in z.infolist()
                     if not i.is_dir() and "/" not in i.filename and i.filename.lower().endswith(".png")]
    else:
        for p in glob.glob(os.path.join(a.src, "*.png")):
            items.append((os.path.basename(p), open(p, "rb").read()))
    items.sort(key=lambda kv: kv[0])
    if len(items) <= a.skip:
        sys.exit(f"找不到可用的 PNG（共 {len(items)} 張，--skip {a.skip}）")
    items = items[a.skip:]
    if a.frames:
        items = items[:a.frames]
    if len(items) < 2:
        sys.exit("少於 2 張幀圖就沒有動畫可言，直接手放單張圖到 external/img2pixel/ 即可")

    # 逐幀解碼＋尺寸檢查；透明像素（alpha=0）的 RGB 一律正規化為 0
    # （img2pixel 的匯出有時會在透明區留 RGB 雜訊，畫面看不出差別、二進位卻因匯出批次不同而抖動；正規化後同素材每次導入都一致）
    frames = []
    for name, data in items:
        d = g.decode_png_bytes(data)
        if d is None:
            sys.exit(f"  {name}: 不是 8-bit RGBA 非交錯 PNG，請在 img2pixel 匯出成透明底 PNG 再導入")
        fw, fh, pix = d
        pix = bytearray(pix)
        for k in range(3, len(pix), 4):
            if pix[k] == 0 and (pix[k - 3] or pix[k - 2] or pix[k - 1]):
                pix[k - 3] = pix[k - 2] = pix[k - 1] = 0
        if frames and (fw, fh) != (frames[0][0], frames[0][1]):
            sys.exit(f"  {name}: 尺寸 {fw}x{fh} 與第一張 {frames[0][0]}x{frames[0][1]} 不同（全部幀都要同尺寸）")
        frames.append((fw, fh, pix))
    fw, fh = frames[0][0], frames[0][1]
    has_alpha = any(f[2][k + 3] == 0 for f in frames for k in range(0, len(f[2]), 4))
    if not has_alpha:
        print("⚠ 這批幀完全沒有透明像素（或是動作本身貼到底）：遊戲端登記時可能需要 keyBg=true")

    # 水平拼 sheet（等寬對齊，每張左→右循環；解碼出來的每列本來就是 RGBARGBA…，直接串列）
    sheet_w = fw * len(frames)
    sheet_path = os.path.join(g.ASSETS, "external", "img2pixel", a.name)
    pix = bytearray()
    for y in range(fh):
        for _, _, fp in frames:
            pix += fp[y * fw * 4:(y + 1) * fw * 4]
    g.write_png(sheet_path, sheet_w, fh, lambda x, y: pix[(y * sheet_w + x) * 4:(y * sheet_w + x) * 4 + 4])

    # 印出後續要手動登記的內容（工具不代改程式碼，避免機器改壞 manifest 的註解與排版）
    keybg = "false（透明底）" if has_alpha else "true（整張不透明）"
    rel_sheet = f"external/img2pixel/{a.name}"
    print(f"""
接下來手動登記（三處）：
1) tools/gen_assets.py 的 EXTERNAL_BUNDLES 加一條：
     dict(sheet="{rel_sheet}", frames={len(frames)}, fw={fw}, fh={fh}, what="這張 sheet 是什麼"),
2) 動物／島主接線：MOB_MANIFEST 該條目加（是島主再登記 OWNER_BY_TERRAIN）：
     anim=dict(sheet="{rel_sheet}", frames={len(frames)}, fps=8, scale=3, keyBg=True／False),
   keyBg 此時建議：{keybg}
3) docs/assets-license.md 補素材來源與授權
""")

if __name__ == "__main__":
    main()
