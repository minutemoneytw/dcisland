# 巴哈姆特飛行素材（已接線：草島島主「黃金肥龍」的外觀）

`client/assets/animals/animals.json` 的 `gold_dragon.anim` 指向 `bahamut_fly_sheet.png`（6 幀、8 fps、龍衝 16 fps、畫面上 1 像素畫 4px＝352×236）；判定圈、龍衝碰撞等玩法仍看 `big: 5`，沒有改。

使用者**自製**的像素素材（用 `img2pixel` 轉換工具製作，來源圖自繪），預計取代草島島主「黃金肥龍」的造型。

## 內容

| 檔案 | 說明 |
|---|---|
| `sprite_fly_01.png` | 飛行幀（生成幀 #1） |
| `sprite_fly_02.png` | 飛行幀（生成幀 #2） |
| `sprite_fly_02c.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_02c-2.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_02c-3.png` | 生成幀 #2 的**手改複製版** |
| `sprite_fly_03.png` | 飛行幀（生成幀 #3） |
| `bahamut_fly_sheet.png` | 上列 6 幀的水平 sprite sheet（528×59，每幀 88×59，等寬可直接切格） |

## 規格

- 每幀 88×59、1x 真實像素
- ⚠️ **背景其實是不透明的白色**（254,254,254，約佔七成像素），不是透明底。遊戲載入時用 `anim.keyBg: true` 從圖邊把相連的背景色去掉（`main.js` 的 `keyBackground`）；之後若重新匯出成透明底，把 `keyBg` 拿掉即可
- 授權：**自製，無授權限制**（記錄於 `docs/assets-license.md`）

## 使用前待辦（重要）

1. ~~動物多幀動畫系統~~：**已做**（`animals.json` 的 `anim` 欄位；`main.js` 的 `loadAnim`／`keyBackground`／`animFrame`）。
2. 尺寸：改用 `anim.scale` 控制畫面大小（目前 4 → 352×236），與玩法用的 `big` 分開，所以不必動判定圈與伺服器 `D_RANGE`。

## 幀序（使用者已排定）

**sheet 由左至右＝動畫播放順序，循環播放**：
`sprite_fly_01 → sprite_fly_02 → sprite_fly_02c → sprite_fly_02c-2 → sprite_fly_02c-3 → sprite_fly_03 →（回 01）`
（02c 系列是使用者手改的變化幀，位置就是設計好的循環順序，不需再挑）

## 維護備註

- 此資料夾**不由 `tools/gen_assets.py` 管理**（外部素材暫存區）；若日後重跑產生器把這裡清掉，從 git 歷史還原。
- 是否把自製素材納入 `gen_assets.py` 產生流程，待使用者與其他開發者討論後再定。
