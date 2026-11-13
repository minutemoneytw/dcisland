# 外部素材（img2pixel 資料夾）

不是由 `tools/gen_assets.py` 畫出來的素材都放這裡：最早只有使用者**自製**的島主素材（用 `img2pixel` 轉換工具製作，來源圖自繪），現在也放 OpenGameArt／LPC 的怪物 sheet、營火、火球、`lpc/`（人物、服裝、武器的 LPC 原始圖層）與 `hair_kidol/`（髮型）。此資料夾的檔案不由產生器產生，只在 `gen_assets.py` 的 `EXTERNAL_BUNDLES` 登記與健檢。

下面只詳細記錄幾隻自製島主的規格；**其餘每個檔案的來源、作者與授權逐條記在 `docs/assets-license.md`**，幀數、尺寸與接線看 `gen_assets.py` 的 `EXTERNAL_BUNDLES` 與 `MOB_MANIFEST`。壓力山大（機械島島主，`alexander_idle_sheet.png`）也已接線，規格同樣看那兩處。

## 笨蛋蛇女（夜光島島主，已接線）

| 檔案 | 說明 |
|---|---|
| `snake_queen_sheet.png` | 4 幀水平 sprite sheet（352×85，每幀 88×85，由左至右循環） |

- 透明背景、1x 真實像素，不需要 `keyBg`
- 已接線：`mobs.json` 的 `snake_queen.anim`（8 fps、`scale: 3`）
- 授權：**自製，無授權限制**（記錄於 `docs/assets-license.md`）

## 蓋老師（熔岩島島主，已接線）

| 檔案 | 說明 |
|---|---|
| `ultima_weapon_sheet.png` | 6 幀水平 sprite sheet（528×74，每幀 88×74，由左至右循環） |

- 透明背景、1x 真實像素，不需要 `keyBg`
- 已接線：`mobs.json` 的 `ultima_weapon.anim`（8 fps、`scale: 3`、`big: 5`）
- 攻擊樣式 `beam`（波動砲）：光波寬度＝這張圖的畫面寬（264px）
- 這個島主**沒有 `sprite`**（純外部素材）：`main.js` 載入島主圖時會跳過沒有 `sprite` 的條目
- 2026-11-05 修圖：第 0、2、4 幀的上緣（x＝81～84、y＝0）原本有一條 4 像素的灰色孤立線，其他幀沒有，播放時會閃爍；已移除（只動這 12 個像素，其餘不變）
- 授權：**自製，無授權限制**（記錄於 `docs/assets-license.md`）

## 巴哈姆特飛行（草島島主，已接線）

`client/assets/mobs/mobs.json` 的 `gold_dragon.anim` 指向 `bahamut_fly_sheet.png`（6 幀、8 fps、龍衝 16 fps、畫面上 1 像素畫 4px＝352×236）；判定圈、龍衝碰撞等玩法仍看 `big: 5`，沒有改。

## 內容

### 巴哈姆特

| 檔案 | 說明 |
|---|---|
| `sprite_fly_01.png` | 飛行幀（生成幀 #1） |
| `sprite_fly_02.png` | 飛行幀（生成幀 #2） |
| `sprite_fly_02c.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_02c-2.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_02c-3.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_03.png` | 飛行幀（生成幀 #3） |
| `bahamut_fly_sheet.png` | 上列 6 幀的水平 sprite sheet（528×59，每幀 88×59，等寬可直接切格） |

## 巴哈姆特規格

- 每幀 88×59、1x 真實像素
- ⚠️ **背景其實是不透明的白色**（254,254,254，約佔七成像素），不是透明底。遊戲載入時用 `anim.keyBg: true` 從圖邊把相連的背景色去掉（`main.js` 的 `keyBackground`）；之後若重新匯出成透明底，把 `keyBg` 拿掉即可
- 授權：**自製，無授權限制**（記錄於 `docs/assets-license.md`）

## 巴哈姆特幀序（使用者已排定）

**sheet 由左至右＝動畫播放順序，循環播放**：
`sprite_fly_01 → sprite_fly_02 → sprite_fly_02c → sprite_fly_02c-2 → sprite_fly_02c-3 → sprite_fly_03 →（回 01）`
（02c 系列是使用者手改的變化幀，位置就是設計好的循環順序，不需再挑）

## 導入流程（2026-11-05 起；2026-11-12 支援 sheet PNG／GIF）

1. 把素材交給導入工具，來源有三種：
   - **逐幀 PNG**（img2pixel 匯出的 zip 或資料夾）：`python tools/import_external.py <zip 或資料夾> <輸出檔名>.png`
   - **現成 sprite sheet PNG**（上網抓的多幀整張圖）：`python tools/import_external.py <sheet.png> <輸出檔名>.png` — 自動切格重拼成等寬水平 sheet；多列方向網格（每列一個方向）會保留列結構。幀與幀相連（沒有整欄透明分隔）切不出格線時要手動 `--fw`；多列要再給 `--rows`
   - **GIF**：`python tools/import_external.py <動畫.gif> <輸出檔名>.png` — 每個影格＝一幀（需 Pillow：`pip install pillow`），並依影格時長建議 fps
   → 自動解壓／切格／檢查（8-bit RGBA、全部幀同尺寸，索引色 PNG 有 Pillow 會自動轉，透明區 RGB 正規化為 0）、水平拼成 sheet 寫進本資料夾，並印出接下來要登記的三處草稿（`EXTERNAL_BUNDLES` 條目、`anim` 一行、授權表格列）。
2. **登記三處**（工具只印草稿、不代改程式，避免弄壞 manifest 的註解與排版）：
   - `tools/gen_assets.py` 的 `EXTERNAL_BUNDLES` 加一條（重跑開頭會檢查 sheet 存在與幀數尺寸有沒有對上）；
   - 動物／島主接線：`gen_assets.py` 的 `MOB_MANIFEST` 該條目加 `anim`（島主再登記 `OWNER_BY_TERRAIN`），下次重跑會寫進 `mobs.json`；
   - `docs/assets-license.md` 補素材來源與授權記錄。
3. 工具採內容感知寫檔：同一素材重導入（像素一模一樣）不會重寫檔案。

## 維護備註

- 此資料夾**不由 `tools/gen_assets.py` 產生**（外部素材專區），產生器不會覆蓋或清理這裡的檔案；只負責在 `gen_assets.py` 的 `EXTERNAL_BUNDLES` 登記與健檢。
- sheet 維持「等寬、水平排列、由左至右循環」的慣例；改幀序時逐一幀替換圖塊即可。
