# DC島（Discord Island）

FF14 玩家群用的 DC 小島：**同一個語音頻道 = 同一座公共島，沒上線頻道時就在自己的島上裝飾**。
2D 點陣風、FFXIV 風 HUD（僅風格參考，不含 SE 素材；素材全是自產 placeholder，零授權風險）。

**正式站（跑在 Cloudflare，24/7、不依賴任何人的電腦）：**
`https://dcisland.less78518.workers.dev`

## 里程碑

- ✅ **M0 可玩**：6 地形（manifest 制）、走路/跑/跳、裝飾模式、造型系統、FF14 致敬小動物、武器戰鬥＋動物 CD 重生
- ✅ **M1 Discord Activity**：真 DC 身分（名牌顯示 DC 名稱）、測試員可啟動
- ✅ **M2 多人同步**：同語音頻道＝同一座島，玩家/造型/動作/家具同步；每位玩家可各自切換地形，只有同地形的人看得到彼此；**已部署到 Cloudflare**（Durable Object，一座島＝一個實例）
- ⬜ M3 個人島列表/參觀、鎖島、家具/造型申請審核 bot
- ⬜ M4 公測

## 架構

```
client/          純前端（無 build step），manifest 制素材
  js/main.js     遊戲本體（引擎/戰鬥/動物/裝飾/造型）
  js/discord.js  Discord Embedded App SDK 接線（本機/mock/真 DC）
  js/net.js      多人同步（WebSocket，位置/造型/動作）
  vendor/        SDK 單檔 bundle（自託管，不依賴外部 CDN）
worker/          Cloudflare Worker：靜態檔 + /api/token + /ws（Durable Object 當島）
  wrangler.toml  部署設定（[assets] + Durable Object 綁定）
tools/
  dev_server.py  本機伺服器：靜態 + /api/token + /ws（純 Python，不需 Node）
  gen_assets.py  素材產生器（placeholder；改素材先改這裡再重跑）
  dev_config.example.json  憑證範本
docs/            規格、授權記錄、Discord 串接、Cloudflare 部署
```

## 維護者流程（三人都一樣）

```bash
git pull
# 改 client/ 或 worker/ 的程式
git commit -am "說明改了什麼"
git push              # → GitHub Actions 自動部署（約 1 分鐘）
```

- 部署結果：https://github.com/minutemoneytw/dcisland/actions
- 設定細節：`docs/cloudflare-deploy.md`
- 只改 `docs/` 不會觸發部署

## 本機開發

```bash
python tools/dev_server.py       # 需要 Python 3；不用 Node
# 開 http://localhost:8787
# 多人測試：開兩個分頁，同一 ?room=xxx 就會看到彼此
# 模擬 DC 身分： http://localhost:8787/index.html?mock=1
```

要驗證真正的 Discord 串接，再把本機服務用臨時隧道對外（詳見 `docs/m1-discord-setup.md`），
**測試完務必把 Portal 的根對應改回 `dcisland.less78518.workers.dev`**，否則大家會白屏。

## 操作

`WASD/方向鍵` 走 · `Shift` 跑 · `Space` 跳 · **左鍵（或 `F`）攻擊，長按自動連續揮擊**（點石頭/貝殼自動用鎬子、點樹木/蘑菇自動用斧頭） · 左/右鍵點 NPC 聊天、點椅子/沙發/床（或在旁邊按 `F`）坐下/睡覺，再點一次、按 `F` 或移動就起身 · `E` 裝飾模式（可邊走邊擺、可穿過擺飾；「擺設」分頁左鍵放置、右鍵拿取；「地板」分頁長按左鍵鋪、長按右鍵拆，地毯一次鋪 2×2 且彼此不重疊；地板可鋪在水上，水上要先鋪地板才能放家具、也能走上去，水上地板有家具時要先拿走家具才能拆；按「完成」才保存、「取消變動」可還原，`E` 或 `Esc` 離開時有未保存的變動會先問；「清空」需要管理員）· `L` 線上列表（同一張地圖的人，點名字傳送過去）· **釣魚**：`造型` 把武器換成釣竿，在水邊按 `F` 或點水的方向拋竿，浮標被拉下水、頭上出現「!」後 2 秒內再按一次拉竿 · `圖鑑` 看各島釣過的魚（沒釣過的是剪影）· 頂部 chip 切地形 · `造型` 換膚色/髮型/上衣/褲子/武器 · `操作說明` 開簡易說明（說明／列表視窗開著時仍可走路）。

## 內容擴充（都不用改程式）

| 想加 | 做什麼 |
|---|---|
| 地形 | `client/assets/terrain/<id>/` 加資料夾 + `terrain.json`，並在 `main.js` 的 `TERRAIN_IDS` 登記 |
| 家具 | `client/assets/furniture/furniture.json` 加條目 + png |
| 地板 | `client/assets/floors/floors.json` 加條目 + 16×16 無縫磚 png（`gen_assets.py` 的 `FLOOR_MANIFEST`）；多格地板（如地毯 2×2）加 `"w"`/`"h"`，圖為 16w×16h，邊長最多 4 |
| 動物 | `client/assets/animals/animals.json` 加條目 + png，並在各地形 `terrain.json` 的 `animals` 指定；會游泳/兩棲/會飛的加 `"swim": true`（才能逃到海上）；要多幀動畫就加 `"anim"`（等寬水平 sheet，由左至右循環：`sheet`／`frames`／`fps`／`dashFps`／`scale`／`keyBg`，見 `gen_assets.py` 的 `ANIMAL_MANIFEST` 註解） |
| 造型 | `client/assets/avatar/avatar.json`（＋對應 png）。人物分五層（軀幹＞褲子＞衣服＞頭髮＞帽子，由下往上疊），每層一張照**標準排列**畫的 sheet：每幀 24×24，8 方向（下、右下、右、右上、上、左上、左、左下）×〔待機 4 幀＋走路 4 幀〕＋最後 1 幀坐姿，共 65 幀（幀表在 `avatar.json` 的 `frames`）。換素材＝照排列畫好覆蓋同名檔；加衣服／褲子／帽子款式＝`tops`／`bottoms`／`hats` 加一項（可另設 `recolor` 換色）。產生器在 `gen_assets.py` 的 `char_*` |
| NPC／嚮導／台詞／操作說明 | `client/assets/npcs/npcs.json`（`terrains.<地圖>` 每張地圖各自的 NPC，`help` 是嚮導的說明視窗） |
| 魚（釣魚／圖鑑） | `tools/gen_assets.py` 的 `FISH_TABLE` 加一列（地形、id、名稱、稀有度 `common`/`uncommon`/`rare`、尺寸 cm 範圍、畫圖）再重跑，產生 `client/assets/fish/<id>.png` 與 `fish.json`；稀有度權重與脫鉤率在 `fish_manifest()` |
| 可破壞物件／採集工具／掉落物 | `client/assets/tools/tools.json`（key＝地形 deco 的圖檔名；掉落物目前為空） |
| 島主招式（倒數條／招式名／放招前要不要講台詞） | `client/assets/skills/skills.json`（手寫；key＝`animals.json` 的 `atk` 攻擊樣式）：`name` 招式名稱、`bar: true` 預警時在島主頭上顯示黃色倒數條（右上角是招式名稱）、`say: false` 被打不講台詞直接開始預警。兩份伺服器也讀 `say` |
| 島主 | `terrain.json` 加 `"owner": "<動物id>"`（一張地圖一隻）；動物本體照上面的「動物」方式加，`"owner": true`＋`"big"` 放大倍率。機制見下方「島主」 |
| 動畫（把任何單張圖換成多幀） | 準備**等寬水平排列**的 sheet（由左至右循環），在該圖的 manifest 加 `anim`：`{"sheet": "相對 client/assets/ 的路徑", "frames": 幀數, "fps": 8, "keyBg": false, "stagger": false}`。地形磚／點綴物寫在 `terrain.json` 的 `"anims": {"<檔名>": anim}`（例：`"water.png"`、`"tree.png"`）；家具、地板、動物寫在各自條目的 `"anim"`（動物另有 `dashFps`、`scale`）。不寫 `sheet` 時，原本的 `sprite` 檔本身就當 sheet；sheet 載入失敗會退回單張圖。地形磚／地板預設整張地圖同步換幀，`stagger: true` 各格錯開；點綴物與家具依格子自動錯開。`keyBg` 給不是透明底的素材（從圖邊去背）。由產生器管理的 manifest 要寫進 `gen_assets.py` 對應的表（`TERRAINS` 該地形的 `anims`、`FURN_MANIFEST`／`FLOOR_MANIFEST`／`ANIMAL_MANIFEST` 條目的 `anim`）再重跑，否則下次重跑會被蓋掉。只影響畫面，不用改程式、也不動伺服器 |

## 島主（各島的島主）

- 每座地形可以有自己的島主（`terrain.json` 的 `owner` 指定動物）。目前：**草島＝黃金肥龍**（FF14 巴哈姆特致敬的正面金龍，`big: 5`、HP 200；外觀是使用者自製的 6 幀飛行動畫 `client/assets/external/img2pixel/`，龍衝時拍翅加快）、**夜光島＝笨蛋蛇女**（FF14 T7 蛇女致敬的正面蛇女，紫膚蛇髮金甲蛇尾，`big: 4`、HP 200；外觀是使用者自製的 4 幀動畫 `client/assets/external/img2pixel/snake_queen_sheet.png`）。
- **黃金肥龍（攻擊樣式 `atk: "dash"`）**：打牠 → 瞬間消失 → 在島**隨機邊緣**現蹤鎖定攻擊者 → **預警 1 秒**（金色虛線）→ 龍本體以 560 px/s 直線飛衝過島（被撞到的玩家角色倒地變墓碑，**30 秒**後在出生點復活）→ 衝到對岸落地停 0.7 秒 → 就地接續散步（不回中心）。
- **笨蛋蛇女（攻擊樣式 `atk: "gaze"`）**：不瞬移、**不講台詞**。打她 → 身上浮出**大眼睛 2 秒**，頭上同時出現**黃色倒數條**（由左往右填，右上角寫「石化」；她的頭超出畫面時貼齊畫面上緣），填滿就發射（沒有直線、全地圖判定）→ 發射瞬間**臉朝著蛇女的玩家**（四方向朝向：往上走＝背面、往下走＝正面、左右＝側面；朝向與「到蛇女的方向」夾角小於約 80° 就算面對）**石化 10 秒**（不能移動／跳躍，也不能揮擊／採集／F 互動）且**每秒扣 1 HP**；**背對她／看向另一邊就安全**，距離不影響（扣死照墓碑機制）→ 放完直接接仇恨追殺。
- **閒晃**：島主會在島上四處散步（附近 6～16 格的隨機陸地路點、直線不抄水、走完歇 1.5～4 秒），路點由伺服器挑並廣播，客戶端用牆鐘插值跟著走；沒有人在線時散步停擺省資源，有人進來自動恢復。
- **流程由伺服器權威同步**（`worker/src/index.js` 與 `tools/dev_server.py` 各一份，改流程或常數要兩邊＋`main.js` 一起改）：每座地形的島主狀態、島形位圖（RLE）、被打冷卻、仇恨名單**各自一份**（storage key 帶地形後綴 `dragon:<地形>`／`dragonMap:<地形>`，DO 只有一個鬧鐘、由 `armOwnerAlarm` 統一取最早的醒來時間）。島形位圖由客戶端上傳，每條連線每個地形只傳一次；內容和已存的一樣時 Worker 不重寫儲存。瞬移點與龍衝終點／石化直線的終點由伺服器計算並廣播事件；客戶端只負責演出與「自己有沒有被打到」的判定——所以攻擊可以害死同島的其他玩家（誰被打到誰把自己的死亡寫進 `state.dead`）。石化目前是純客戶端判定（各人在發射瞬間自判「是否面向蛇女」），不進同步協定。
- 打島主：F 鍵與滑鼠點擊都**優先攻擊島主**（勝過腳下的座位／NPC——島主常駐重生點，旁邊常有一堆家具）；判定以**武器尖端**為準（人臉朝向那側 30px 處進了島主腳下的判定圈就打得到，黃金肥龍圈半徑 58、蛇女 52；靠近時腳下會畫出判定圈）；傷害 1～2（暴擊 2），每連線 300ms 冷卻，伺服器驗證距離 ≤100px（`D_RANGE`，涵蓋判定圈＋武器伸出並留延遲），龍衝飛行中打不到。
- 島主被打倒後 30 秒重生（Worker 用 Durable Object 鬧鐘、本機用 timer）。沒連線（單機）時退回客戶端本地模擬，行為相同。帶傷的島主會每秒回 18 HP（滿血才停；單機模擬與兩份伺服器的 `D_REGEN` 同值）——目前調到約 **8 人圍毆才打得死**（7 人打不贏、8 人約 70 秒擊殺）。
- **仇恨追殺（被打就鎖定）**：**一被打就立刻建立仇恨**——反擊照樣先放（說台詞 → 龍衝／石化之瞳），但**放完不用再被打就馬上接著追殺同一個攻擊者**；冷卻期間（12 秒，`D_RAGE_MS`）被打也進仇恨。以 180 px/s 追殺（玩家走路 120 追得上、跑步 200 才能拉開），貼近 36px 就站定**每秒爪擊**（金色抓痕特效，範圍內＋前方扇形的各客戶端自判是否被打）；複數攻擊者每 5 秒隨機換目標、目標倒了也立刻換。**30 秒脫離：從最後一次被打起算**，完全沒人打牠超過 30 秒（`D_DROPOUT`）才冷靜回閒晃（`chill`）；**冷卻一到自動對現在目標放招**。
- **玩家血量**：HP 上限 10（`PLAYER_HP`）——島主爪擊扣 2（5 下倒地）、**龍衝直接倒地**（不看血量）、石化每秒扣 1、殺一隻（單機）動物回 1、脫離戰鬥（場上島主沒在追殺／放招、自己沒被石化）每秒自動回 1（`PLAYER_REGEN`）、復活即滿血；血量走 `state` 封包同步，頭上有掉血才顯示的紅色小血條。
- 島主是「野外動物刻意不同步」原則的**明確例外**（會打死人，必須全島一致）；其他野外動物維持各自畫面模擬。
- **島主＝範本**：之後其他島的島主照這套做；攻擊方式可不同（在 `OWNER_TERRAINS`（兩份伺服器）與 `animals.json` 的 `atk` 登記新樣式），框架（伺服器權威狀態機＋事件廣播）共用。

### 新增其他島的島主（照範本，4 步）
1. **造型**：`tools/gen_assets.py` 畫該島主的正面圖＋重跑（記得用 `git checkout` 還原不相干素材），並在 `client/assets/animals/animals.json` 加條目：`"owner": true`、`"big"` 放大倍率、`"hp"`（目標約 8 人擊殺）、`"atk"`（攻擊樣式：`dash`／`gaze`）、`"line"`（點擊時的描述）、`"ownerLines"`（被激怒的台詞，見第 3 步）
2. **指定**：該島 `client/assets/terrain/<id>/terrain.json` 加 `"owner": "<動物id>"`（一張地圖一隻），並在兩份伺服器的 `OWNER_TERRAINS` 登記該地形的攻擊樣式
3. **台詞與招式**：`client/assets/skills/skills.json` 設定該攻擊樣式的招式名稱、要不要倒數條（`bar`）、要不要先講台詞（`say`）；要講台詞的話寫在 `animals.json` 該島主條目的 `"ownerLines"`（字串陣列；被打觸發反擊前，隨機泡泡說一句；沒寫就不說話）。`animals.json` 由產生器管理，要寫進 `tools/gen_assets.py` 的 `ANIMAL_MANIFEST`，否則下次重跑會被蓋掉
4. **完成**——說台詞、預警、攻擊（照 `atk` 分岔）、歇腳、全島散步、仇恨追殺＋爪擊、死亡重生、泡泡、優先攻擊全部由共用框架處理（伺服器權威；`worker/src/index.js` 與 `tools/dev_server.py` 兩份實作已就緒）

## 機密與安全

- `tools/dev_config.json`（含 Discord client secret）**永不進版控**（`.gitignore` 已排除，repo 只有範本）
- 雲端 secret 存在 Cloudflare Worker secrets（`wrangler secret put`），前端拿不到
- 只有 App 擁有者與 Discord 開發團隊成員能啟動未發布的 Activity（見 `docs/m1-discord-setup.md`）
