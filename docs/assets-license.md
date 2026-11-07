# 素材授權記錄

| 來源 | 範圍 | 授權 | 備註 |
|---|---|---|---|
| `tools/gen_assets.py` 產出（本 repo 全部 `client/assets/**`） | 地形 tile、樹/石/貝殼等點綴、家具、角色分層、職業裝備與武器 | 自製，無授權限制 | placeholder 品質，之後逐步換成外部素材包 |
| `client/assets/external/`（使用者自製素材暫存區） | 巴哈姆特飛行 6 幀（88×59/幀＋sheet，img2pixel 工具製作） | 自製，無授權限制 | 2026-11-04 引入；已接線為草島島主 `gold_dragon` 的飛行動畫（`bahamut_fly_sheet.png`，`mobs.json` 的 `anim`）。素材背景為不透明白色，靠 `keyBg` 去背 |
| `client/assets/external/img2pixel/snake_queen_sheet.png` | 笨蛋蛇女 4 幀（88×85/幀，水平 sheet 352×85） | 自製，無授權限制 | 2026-11-04 引入；已接線為夜光島島主 `snake_queen` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 3`）。素材是透明底，不需要 `keyBg` |
| `client/assets/external/img2pixel/ultima_weapon_sheet.png` | 蓋老師（究極神兵）6 幀走路圖（88×74/幀，水平 sheet 528×74） | 自製，無授權限制 | 2026-11-05 引入；已接線為熔岩島島主 `ultima_weapon` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 3`）。素材是透明底，不需要 `keyBg`；此島主沒有 `sprite`（純外部素材） |
| `client/assets/external/img2pixel/alexander_idle_sheet.png` | 壓力山大（機械之神）4 幀待機圖（88×77/幀，水平 sheet 352×77） | 自製，無授權限制 | 2026-11-05 引入；已接線為機械島島主 `alexander` 的動畫（`mobs.json` 的 `anim`，8 fps、`scale: 4`）。素材是透明底，不需要 `keyBg`；此島主沒有 `sprite`（純外部素材） |
| `client/assets/external/img2pixel/campfire_sheet.png` | 營火 8 幀（32×32/幀，水平 sheet 256×32；使用者提供，`物件/campfire.7z`，逐幀 `fire1..fire8.png` 以 `tools/import_external.py` 拼成） | 使用者提供（授權待確認，見備註） | 2026-11-07 引入；用於島上隨機營火的動畫（`main.js` 直接載入 `S.campfireSpr`，不經 manifest、不是動物）。素材是透明底，不需要 `keyBg`。**來源授權尚未確認**：由使用者於 2026-11-07 提供（來源不明，可能是自製或免費素材包），使用前請使用者確認授權 |
| `client/assets/external/img2pixel/char_base_walk.png` | 人物底圖：像素小人 4 方向 × 2 幀走路（256×256，每格 64×64＝列0 正面、列1 朝右、列2 朝左、列3 背面；透明底、單層、褲子畫在身上、腳下有烘進去的影子） | 自製，無授權限制 | 2026-11-07 引入（使用者自製，來源檔 `素材/人物/腳色/sheet_walk.png`，直接複製為 `char_base_walk.png`）。**用途**：`gen_assets.py` 讀它拆出「軀幹（膚色）＋褲子」兩層、重排成 65 幀、並現地生成衣服／頭髮／帽子 placeholder，取代舊的 24px placeholder 人物（見 `docs/notes.md`「人物分層」）。**這是編輯底稿，不直接給遊戲載入**；遊戲載入的是產生器輸出到 `client/assets/avatar/char_*.png` 的 64px 分層 sheet |
| `client/assets/external/img2pixel/hair_kidol/` | 「[LPC] Korean Idol Hairstyle (Male) with 12 colors」12 色（每張 832×1344＝13 欄 × 21 列、每格 64×64 的 LPC 通用格式髮型 sheet） | **CC0 1.0（Public Domain，公眾領域）** | 2026-11-07 引入。來源：[OpenGameArt.org](https://opengameart.org/) 的「[LPC] Korean Idol Hairstyle (Male) with 12 colors」，作者 **theciclekli**，2021-01-02 上傳，授權 **CC0**（可自由使用）。**用途**：LPC 通用格式髮型（見 `docs/notes.md`「髮型模組（LPC）」）。CC0 不強制標註，但仍在此記錄出處 |
| `client/assets/external/img2pixel/lpc/` | LPC 素材（走路 9 幀 × 4 向，576×256）：素體 `base_body_walk.png`／`base_head_walk.png`／`base_eyes_walk.png`（男）、`base_body_female.png`／`base_head_female.png`（女）、基本服裝 `top_tshirt_m/f.png`／`bottom_pants_m/f.png`／`shoes_m/f.png` | **CC-BY-SA 3.0 ＋ GPL 3.0**（LPC） | 2026-11-08 引入。來源：[Universal-LPC-Spritesheet-Character-Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator)（`body/bodies/*`、`head/heads/human/*`、`eyes/human/adult/neutral/walk/brown.png`、`torso/clothes/shortsleeve/tshirt/*`、`legs/pants/*`、`feet/shoes/basic/*`）。LPC 作者群（Redshrike、wulax、bigbeargames、makrohn、Nila122 等，詳見 repo CREDITS）。**用途**：`gen_assets.py` 疊成角色素體與基本服裝（LPC 通用格式 832×1344）。**CC-BY-SA/GPL 需標註來源**；已轉成 RGBA |
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
