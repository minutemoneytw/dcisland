# topdown_fantasy_forest（aamatniekss「Free Topdown Fantasy - Forest」）

來源：itch.io <https://aamatniekss.itch.io/topdown-fantasy-forest>（下載檔 `TopDownFantasy_Forest_v1.zip`，2026-11-15 取得）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `Decorations.png` | 256×256 裝飾精靈圖集（樹、灌木、倒木、蘑菇、石頭、蘆葦、草叢；每組多有「帶草影／去影」兩版） |
| `Tileset.png` | 128×240 地表 tile（16px 網格、無 padding；草地／土／懸崖／水） |

`Mockup*.png`（效果示意圖）沒有放進 repo，需要時從原始 zip 取。

## 授權（頁面原文要點）

- 可免費使用於**商業與非商業**專案，可修改。
- **不必標註**（但歡迎；本 repo 有記錄在 `docs/assets-license.md`）。
- **不得單獨散布或重新打包散布素材本身**（含 NFT、單純圖檔包）。
- 素材不得用於生成式 AI 的訓練或產出。

⚠️ 本 repo 是 public、正式站也直接提供 `assets/**`——原始 PNG 任何人可下載，接近授權禁止的「單獨散布」。使用者 2026-11-15 知情後決定先用；若日後要改成 CC0 素材，`docs/assets-license.md` 有替代包清單。

## 接線

切片座標寫死在 `tools/gen_assets.py` 的 `TPFF_RECTS`（註解附座標），由產生器切進 `client/assets/terrain/grass/`；地表只採用了水 tile（`tpff_water_sheet()`：切 `Tileset.png` 的 (1,11) 純水＋(0,11) 的波光，拼成 4 幀 64×16 sheet），草地與土圈維持程式畫的版本（2026-11-15 使用者看過兩種效果後決定）。**不要直接改輸出的 PNG**（重跑會被產生器蓋掉）。
