# 素材授權記錄

| 來源 | 範圍 | 授權 | 備註 |
|---|---|---|---|
| `tools/gen_assets.py` 產出（本 repo 全部 `client/assets/**`） | 地形 tile、樹/石/貝殼等點綴、家具、角色分層、職業裝備與武器 | 自製，無授權限制 | placeholder 品質，之後逐步換成外部素材包 |
| `client/assets/external/`（使用者自製素材暫存區） | 巴哈姆特飛行 6 幀（88×59/幀＋sheet，img2pixel 工具製作） | 自製，無授權限制 | 2026-11-04 引入；已接線為草島島主 `gold_dragon` 的飛行動畫（`bahamut_fly_sheet.png`，`mobs.json` 的 `anim`）。素材背景為不透明白色，靠 `keyBg` 去背 |
| `client/assets/external/img2pixel/snake_queen_sheet.png` | 笨蛋蛇女 4 幀（88×85/幀，水平 sheet 352×85） | 自製，無授權限制 | 2026-11-04 引入；已接線為夜光島島主 `snake_queen` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 3`）。素材是透明底，不需要 `keyBg` |
| `client/assets/external/img2pixel/ultima_weapon_sheet.png` | 蓋老師（究極神兵）6 幀走路圖（88×74/幀，水平 sheet 528×74） | 自製，無授權限制 | 2026-11-05 引入；已接線為熔岩島島主 `ultima_weapon` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 3`）。素材是透明底，不需要 `keyBg`；此島主沒有 `sprite`（純外部素材） |
| `client/assets/external/img2pixel/alexander_idle_sheet.png` | 壓力山大（機械之神）4 幀待機圖（88×77/幀，水平 sheet 352×77） | 自製，無授權限制 | 2026-11-05 引入；已接線為機械島島主 `alexander` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 4`）。素材是透明底，不需要 `keyBg`；此島主沒有 `sprite`（純外部素材） |
| FFXIV 風 HUD（`client/css/style.css`） | UI 色彩/面板語言 | 風格參考 | 不使用任何 SE 素材、圖示、字體或商標 |

## 之後計畫引入的外部素材包（引入時補記錄）

| 素材包 | 用途 | 授權 | 引入狀態 |
|---|---|---|---|
| Kenney（kenney.nl） | 通用 tile/物件/UI | CC0 | 未引入 |
| Sprout Lands 基本（Cup Nooble / itch.io） | 島嶼、農場風 tile+角色 | 免費基本版（非商用） | 未引入 |
| LimeZu Modern Interiors 基本 | 室內家具 | 免費基本版（非商用） | 未引入 |
| Pixel Art Top-Down Basic（Cainos） | 室內 tile | CC0 | 未引入 |

規則：
1. 每引入一批素材，在這裡記錄來源連結、授權、版本與引入日期。
2. 非商用授權素材僅用於社群娛樂用途；未來若涉及商業化，需重新檢視或重製。
3. 成員申請的家具/造型需重繪至 16px 基準、統一調色盤，以本 repo 的 manifest 格式上架。
4. 使用者自製（img2pixel）素材導入流程見 `client/assets/external/img2pixel/README.md`（`tools/import_external.py` → `gen_assets.py` 的 `EXTERNAL_BUNDLES`／`MOB_MANIFEST` 登記 → 在本文件補記錄）。
