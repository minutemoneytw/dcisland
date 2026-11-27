# tools/hand/ — 使用者手畫／手改的像素圖

產生器會直接讀這裡的圖（8 位元 RGBA PNG，整張 sheet 的尺寸），取代規則畫出來的版本；矮人／巨人由人類版縮放而來。**改圖＝改這個檔再重跑 `python tools/gen_assets.py`**，不要手改 `client/assets/avatar/` 底下的 PNG。

- `wmage_top_human.png`：人類白魔法師長袍（top 層）。2026-11-27 使用者給了一張 536×220 的長袍圖（走路列 4 個方向 × 9 欄，裁自整張 sheet 的 (20, 538)），1:1 疊在舊版上存成整張 sheet；`tools/gen_wmage.py` 的 `wm_sheets()` 讀它。
