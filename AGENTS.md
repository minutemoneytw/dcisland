# AGENTS.md — DC島 協作指南（給所有 AI agent）

> 所有 agent（Claude、Codex、Cursor…）開工前先讀這份，再讀 `README.md` 與 `docs/spec.md`。
> 有衝突時以使用者當下的指示為準；發現本文件與程式不符，請順手更新本文件。
> 本專案有多位維護者同時在推版：**動手前先 `git pull`，看一下 `git log` 有沒有別人的新改動。**

## 專案是什麼
Discord Activity 小遊戲：2D 點陣島，**同一個語音頻道＝同一座公共島**。
正式站跑在 Cloudflare（`https://dcisland.less78518.workers.dev`）。進度見 `README.md`「里程碑」：M0、M1、M2 完成，M3（個人島/參觀/鎖島/審核 bot）未開始。

## 部署（重要）
- **推到 `main` 且改到 `client/**`、`worker/**` 或 `.github/workflows/deploy.yml`，GitHub Actions 會自動部署到正式站**（只改 `docs/` 不會）。
- 因此：`push` 等於上線。不要未經使用者同意就 push；改動前先在本機驗證。
- `DISCORD_CLIENT_SECRET` 存在 Cloudflare Worker secrets，CI 與 repo 都不應出現它。Portal 的根對應必須指向 `dcisland.less78518.workers.dev`（用臨時隧道測完要改回去，否則大家白屏）。

## 指令
```bash
python tools/dev_server.py            # 本機：靜態檔 + /api/token + /ws，http://localhost:8787（不需 Node）
python tools/gen_assets.py            # 重新產生 client/assets 下的 PNG（placeholder 素材）
cd worker && npx wrangler dev --port 8790   # 本機預覽 Worker 版（含 Durable Object）
```
- 多人測試：開兩個分頁（同 `?room=` 即同島）；模擬 DC 身分：`/index.html?mock=1`
- 目前**沒有自動化測試**，也沒有前端 build step；改完請用瀏覽器實際跑過再說「完成」。
- `tools/` 只用 Python 標準庫；前端不要引入 npm/打包工具（除非使用者同意）。

## 架構與分工
| 路徑 | 職責 |
|---|---|
| `client/js/main.js` | 遊戲本體：世界生成、移動/跳躍、繪圖、戰鬥、動物、裝飾、造型、UI |
| `client/js/net.js` | 多人同步客戶端（WebSocket）。介面保持穩定 |
| `client/js/discord.js` | Discord Embedded App SDK 接線（本機 / mock / 真 DC 三模式） |
| `client/vendor/` | 自託管的 SDK 單檔 bundle（不依賴外部 CDN，勿手改） |
| `worker/src/index.js` | **正式環境伺服器**：`/api/token`、`/api/config`、`/api/log`、`/ws` → Durable Object `Island`（一座島一個實例）；全域 Durable Object `Registry`（全站一個實例，跨島的玩家資料，目前是魚類圖鑑） |
| `worker/wrangler.toml` | Worker 設定（assets 指向 `../client`、DO 綁定、`DISCORD_CLIENT_ID`） |
| `tools/dev_server.py` | 本機開發用伺服器，行為要與 Worker 版**保持一致**（見下方） |
| `tools/gen_assets.py` | 素材的唯一來源 |
| `client/assets/**` | 由 manifest（各 `*.json`）驅動 |
| `docs/` | 規格、Discord 設定、Cloudflare 部署、素材授權記錄 |

## 慣例（請遵守）
1. **加內容走 manifest，不改程式**：新家具/動物/造型＝manifest 加條目＋圖檔。新地形＝`assets/terrain/<id>/` 資料夾＋在 `main.js` 的 `TERRAIN_IDS` 登記（見 README「內容擴充」）。
2. **素材先改 `gen_assets.py` 再重跑**，不要手改 PNG（會被下次產生蓋掉）。⚠️ 目前整支重跑會連帶改到三十幾個不相干的既有素材（產生器與已 commit 的素材有落差）；只想更新單一素材時，重跑後用 `git checkout` 還原其他檔案，只留要改的那幾個。`assets/tools/tools.json` 是手寫資料，不由產生器產生。
3. **引入外部素材必須在 `docs/assets-license.md` 補記錄**；不得使用 SE/FFXIV 的素材、圖示、字體或商標（HUD 僅風格參考）。
4. **機密**：`tools/dev_config.json`（含 `client_secret`）絕不 commit；任何 secret 不貼進對話、日誌或程式。
5. **同步協定有兩份實作**：`worker/src/index.js`（正式）與 `tools/dev_server.py`（本機）。改訊息格式、房間行為或限制常數（`COLS/ROWS`、`MAX_*`）時兩邊與 `net.js` 要一起改。
6. **地形是「每位玩家各自在哪」**，不是房間共用狀態：客戶端送 `enter {v}` 宣告自己進入某地形，伺服器回 `enter {terrain, players, furn}`（同地形其他人的快照與該地形擺設）。`p`/`join`/`leave`/`event`/`furn` 都只廣播給**同地形**的連線；剛連上、尚未 `enter` 的連線看不到也不被看到。切地形只有自己過去。`state` 封包不帶 `terrain`。舊的 `terrain` 訊息名仍當作 `enter` 處理。換地形時，舊地形的人收到帶 `to` 的 `leave`、新地形的人收到帶 `name` 的 `join`，客戶端據此顯示「XXX 移動到了OO區域」／「XXX 進入OO區域」；斷線的 `leave` 不帶 `to`，不提示。客戶端連線時要先送 `state` 再送 `enter`（join 才有名字）。
7. Discord 授權 scope 目前**只有 `identify`**。多加 scope 會讓每次啟動都跳授權畫面，要加先問使用者。
8. 前端為純 ES module、單一全域狀態物件 `S`（`main.js`）；沿用現有風格，不要為小改動重構整檔。
9. **語言**：與使用者的對話（含進度說明與總結）、註解、commit 訊息、文件、UI 文字都用繁體中文，風格與周邊程式一致；檔名、函式名、指令等技術名詞照原文。
10. `localStorage` key 前綴為 `dcisland.m0.*`，改格式時要考慮舊資料。

## Git
- 不要 force push、不要改寫已有歷史；pull/merge 以快轉或正常 merge 為主。
- commit 訊息用繁體中文，一行摘要＋必要的條列；一個 commit 做一件事。只在使用者要求時 commit / push。
- 不要把無關檔案、log、暫存輸出、本機工具狀態（如 `worker/.wrangler/`，已在 `.gitignore`）放進 repo。`.gitignore` 已列出幾個留在磁碟但不進版控的無關檔案（`LOG_FORMAT.md` 等），不要刪也不要加回來。

## 已知待辦 / 地雷
- **採集工具（已做）**：`client/assets/tools/tools.json` 決定哪些地形物件可破壞（key＝地形 deco 的圖檔名）、用什麼工具（`pickaxe`/`axe`）、血量、重生秒數、掉落物。點到可破壞物件（且點的位置沒有動物）就自動換工具打它，離太遠（`range` 72px）只提示；F 鍵會自動打前方最近的可破壞物件；其餘情況仍用劍。工具圖放進 `S.weaponImgs`，與武器共用同一套繪製（圖方向：工具頭在上、握柄在下，轉軸在離圖底 3 格處）；手上拿的工具會隨 `state.weapon` 同步給同地形的人。**掉落物目前刻意為空**（`drops: []`、`items: {}`）：機制已就緒——在 `items` 定義物品、在目標的 `drops` 加 `{item,min,max,chance}` 即會掉落、走過去自動撿進背包（`S.inv`，存 `localStorage`）。
- **可破壞物件已同步**：同地形的人看到同樣的血量與破壞狀態。連線時客戶端只送 `hit {i, sprite, cell}`（`i`＝物件在 `S.world.decos` 的編號，由地形種子確定性產生；`decos.push` 的順序/亂數呼叫次數不能隨便改，否則各客戶端編號會對不上），伺服器扣血後廣播 `deco {i, hp, ttl, by}`（`ttl`＝還要多少毫秒重生，只在壞掉時有值）；進地形時 `enter.decos` 帶完整的受損/已破壞清單。伺服器每個地形只存「受損或已破壞」的物件（`deco:<地形>`）。伺服器驗證：編號/格子範圍、圖檔必須在 `tools.json` 的 targets、玩家離目標 ≤140px、每連線 300ms 冷卻；**不重建世界，所以無法驗證該編號真的是那種物件**（小社群可接受，之後要嚴謹得把 `genWorld` 移植到 Worker）。沒連線時退回本機單機計算。掉落物只給「打壞它的人」（本機實體，不同步）。
- **重生規則**：壞掉後 60 秒（`tools.json` 的 `respawn`）重生，**但該格有家具就不重生，等家具被拿走才重生**（伺服器於進場/被打時惰性判斷，客戶端每幀判斷，不需要計時器）。
- **動物能不能進海**由 `animals.json` 的 `swim: true` 決定（旗標名叫 swim，語意是「能到海上」＝會游泳或會飛；目前是大肚蛙與圓喙鳥，羊只在陸地/岸邊）。逃跑時不會游泳的被海擋住就停下或繞開，能到海上的逃進海後會自己回到最近的陸地。新增動物要記得想一下它會不會游泳；`gen_assets.py` 的動物清單也要同步（目前產生器的 `ANIMAL_MANIFEST` 已含 `swim`）。
- **野外動物刻意不同步**（使用者決定）：各客戶端自己隨機生成、漫步、被打、重生，每個人看到的位置/血量不同沒關係；別人在附近揮擊也會嚇到自己這邊的野外動物，這是可接受的視覺效果。不要為了「同步」去改它。（唯一例外：島主，見下一條）
- **島主由伺服器權威同步**（使用者要求，2026）：島主會打死人，流程必須全島一致——`worker/src/index.js` 與 `tools/dev_server.py` 各有一份實作，改流程或常數（`D_*`，含每秒回血 `D_REGEN`、仇恨追殺 `D_CHASE`/`D_CLAW_*`/`D_AGGRO_MS`/`D_DROPOUT`、龍衝 `D_DASH`/`D_RAGE_MS`、石化之瞳開眼 `D_GAZE_CAST_MS`）時兩邊與 `main.js`（`OWNER_*` 常數）要一起改。**每座地形可以有自己的島主**：`OWNER_TERRAINS`（兩份伺服器各一份小表：地形 → 攻擊樣式 `dash`＝龍衝／`gaze`＝石化之瞳）與 client `terrain.json` 的 `owner`、`animals.json` 的 `atk` 要一致；島主狀態/島形位圖/被打冷卻/仇恨名單都以地形為 key（Worker storage key 帶地形後綴 `dragon:<地形>`／`dragonMap:<地形>`，草島舊資料會自動搬到新 key；DO 只有一個鬧鐘，由 `armOwnerAlarm` 取所有島主最早的醒來時間；本機版每地形各自的 timer）。島形位圖由客戶端進有島主的地形時上傳（RLE 字串，存 DO storage，休眠不會消失；客戶端 `uploadLandMap` 每條連線每個地形只傳一次，Worker 比對內容相同就不重寫 storage），瞬移點、龍衝終點、石化直線終點、idle 散步路點都由伺服器計算並廣播事件。客戶端只負責演出與「自己有沒有被打到」的判定（受害者自己判死／自判石化扣血，走既有 `state.dead` 同步），所以攻擊可以害死同島的其他玩家；**石化目前是純客戶端判定**：蛇女開眼 2 秒後發射，**全地圖、不看距離、沒有直線**——發射瞬間「朝向與到蛇女的方向夾角小於約 80°」的人（`facingGazer`，朝向見下）自判石化（10 秒不能動、**不能揮擊／採集／F 互動**＋每秒扣 1 HP），背對她就安全；遠端玩家的灰階演出用同一函式推斷。**四方向朝向**：`p.face`＝`'up'`（背面：有往上的分量，含斜上）／`'down'`（正面：只往下走或坐下）／`'side'`（左右、斜下、按住滑鼠、揮擊或釣魚時；左右看 `dir`；側面與正面用同一張圖，只差左右翻轉），站著不動維持上次朝向；背著的武器不隨人物左右翻轉（固定背在畫面左側肩後，背面時疊在身體上），木劍拔劍起手的 x 要乘 `dir` 換回同一側；人物圖是分層 sheet（見「人物分層」），背面就是 sheet 裡朝上的幀（目前 placeholder：正面身體＋整顆蓋住臉的頭髮）；`face` 走 `state` 同步給同地形的人（伺服器不驗證、只轉發；舊客戶端沒送就當正面）。朝向向量：up＝(0,-1)、down＝(0,1)、side＝(dir,0)。攻擊判定仍只看左右（武器點用 `dir`）。伺服器仍帶 `gaze` 事件的光束終點（`bx/by`，舊協定遺留、客戶端不再用來判定），不進同步協定。島主被打倒 30 秒後重生（Worker 用 DO 鬧鐘、本機用 timer）。**按住滑鼠時面向跟著游標**（走路不會改面向，可以朝右攻擊同時往左退；沒按滑鼠時面向才跟著移動方向）。**玩家攻擊以武器尖端為準、不看面向**：武器點＝人臉朝向那側 `WEAPON_REACH`（30px）處，怪物腳底中心 + 判定圈（半徑 `hitRadius`＝34＋6×(big−1)，黃金肥龍 58、蛇女 52、小動物 34），武器點進圈就打得到（`inHit`，打動物與 F 的「島主優先」都用它；伺服器 `D_RANGE`＝100 要涵蓋 58＋30，改這幾個常數兩邊要一起改）。**島主腳下畫有判定圈**（靠近約 220px 且裝備了武器才顯示，空手不顯示；另畫一個小圓圈標出武器點）：綠色實線＝武器在圈內（打得到）、黃色虛線＝人在圈內但武器在圈外（轉向）、白色虛線＝圈外。F／點擊對範圍內的島主**優先攻擊**（勝過座位／NPC，島主常駐重生點）。沒連線（單機）時退回客戶端本地模擬，行為相同。
- **島主仇恨（被打就鎖定，龍衝落地接著追殺，2026）**：**一被打就立刻建立仇恨**（廣播 `aggro {id,name}`）——龍衝照樣先放（說台詞→瞬移島緣→龍衝），但**落地後不用再被打就馬上接著追殺同一個攻擊者**；龍衝冷卻期間（`D_RAGE_MS`＝12 秒）被打也進仇恨。追殺以 `D_CHASE`=180 px/s（玩家走路 120／跑步 200），貼近 `D_CLAW_RANGE`=36 就站定每秒一抓（廣播 `claw {x,y,tx,ty}`，各客戶端自判是否被打、扣 2 HP，並畫三道金色抓痕掃向目標）；複數攻擊者時每 5 秒（`D_AGGRO_MS`）隨機換人、仇恨目標死了也立刻換。**30 秒脫離規則：從最後一次被打起算**（每次被打重置計時），超過 `D_DROPOUT`＝30 秒完全沒有人打牠才脫離仇恨回閒晃（廣播 `chill`）；龍衝 CD 一到**自動**對現在目標放龍衝（仇恨保持）。追腿沿用 wander 事件插值（0.6 秒重瞄＋避水截斷，不會追進海裡）。單機版在 `main.js` 的 `ownerAggro*` 系列。
- **玩家血量（2026）**：HP 上限 10（`PLAYER_HP`）——島主爪擊扣 2、**龍衝直接倒地**（不看血量）、殺一隻（單機）動物回 1、脫離戰鬥（`ownerEngaged()` 為假且沒被石化）每秒自動回 1（`PLAYER_REGEN`）、復活即滿血；血量走 `state` 封包同步（`hp` 欄位），頭上有掉血才顯示的紅色小血條。被打倒仍是既有墓碑 30 秒機制。
- **島主是範本（使用者定調）**：之後其他島要加島主照同樣原則——`terrain.json` 的 `owner` 指定動物＋`animals.json` 加造型（`atk` 標攻擊樣式），台詞加進 `main.js` 的 `OWNER_LINES`（**per 島主 id 的字典**，發動反擊前隨機說一句，泡泡 3 秒），並在兩份伺服器的 `OWNER_TERRAINS` 登記該地形；不同島主可換攻擊方式（目前 `dash` 龍衝／`gaze` 石化之瞳），但伺服器權威狀態機（觸發→說台詞→攻擊→歇腳→全島散步）與事件廣播框架共用，不要另起爐灶。
- **之後的捕捉/牧養（尚未做）**：被牧養的動物是另一種實體，不是由野外動物升級而來，要由伺服器記錄（屬於誰/哪座島、種類、格子、狀態）並讓所有人看到一致；玩家只透過特定介面（選單/按鈕）與它互動，不靠即時打擊判定，所以位置可用離散格子，不需要伺服器即時模擬（避免讓 Durable Object 一直醒著）。可沿用家具同步的機制（伺服器為權威、廣播整份清單）。
- 家具擺設已同步：伺服器（DO storage，每個地形各一份，編輯者所在地形決定改哪一份）是唯一權威，結果以廣播的 `furn` 清單為準；斷線時才退回 `localStorage`。舊的本機擺設不會自動上傳。伺服器**不判斷水邊**（只有客戶端知道島形）。
- **裝飾模式是「草稿＋保存」**：變動先記成操作清單 `S.draft`（`place`/`remove`/`clear`，畫面立刻看得到，但同島的人看不到），按「完成」（或離開時選「保存」）才用 `commit {ops}` 一批送出；「取消變動」或離開時選「不保存」就丟掉草稿。有未保存變動時按 E/Esc 會跳確認（保存／不保存／繼續編輯），也不能切地形。編輯中別人保存了，會以新清單為底把我的草稿重新疊上去；保存時伺服器逐一驗證，被別人搶先占用的操作會被跳過並回報（`commit_result {applied, rejected, denied}`）。單一 commit 最多處理 100 個操作（客戶端 80 個一批），訊息上限 16KB。舊客戶端的單一 `place/remove/clear` 訊息仍可用，走同一套驗證與權限。
- **地板層（已做）**：裝飾面板上方有「擺設／地板」兩個分頁。地板是**獨立於家具的一層**（畫在地面之上、家具與角色之下；不占格、不擋路、家具可以擺在地板上）；地板分頁只能鋪/拆：長按左鍵鋪選中的地板、長按右鍵拆（游標掃過的格子持續套用；水上不能鋪）。種類由 `assets/floors/floors.json`＋16×16 無縫磚決定（目前木紋 `wood`、石製 `stone`、地毯 `rug`；`gen_assets.py` 的 `FLOOR_MANIFEST`），加地板＝manifest 加條目＋圖檔。**多格地板**：manifest 標 `w`/`h`（地毯 2×2，圖 32×32）就一次鋪 w×h 格，只在錨點格（左上）存一筆 `[x,y,id]`，其餘格子視為被它蓋住；規則（三份實作一致：`main.js`／Worker 的 `applyFloorOp`、`dev_server.py` 的 `edit_floor`）：多格地板彼此不重疊、單格地板不能鋪在多格地板上、鋪多格地板會取代範圍內的單格地板、拆除點到任一格就整塊拆；找「誰蓋住這格」往左上回找 `FLOOR_MAX`（4）格，多格地板邊長不能超過它。地毯原本是家具，已改為地板：`furniture.json` 的 `rug` 標 `legacy: true`（不列在面板、不能再擺，但舊存檔已擺的照畫、可以拿走）。走同一套草稿＋保存：草稿操作 `{t:'floor', cell:[x,y], type:id|null}`（`null`＝拆除），走既有 `commit {ops}`（`commit_result` 的 applied/rejected 也計入地板）；伺服器每個地形存 `floor:<地形>`（`[[x,y,id],…]`），進場時 `enter.floor` 帶整份，有變動就廣播 `{t:'floor', items}`。地板操作**不看身分**（與一般家具同樣開放）、「清空」**不會清地板**（清空按鈕在地板分頁隱藏）；伺服器只驗證範圍與種類，**不判斷水邊**。草稿上限 1200 項（擺設仍 300）。沒連線時存 `localStorage` 的 `dcisland.m0.floor.<地形>`。
- **看板（已做）**：家具 manifest 標 `"text": true` 的種類（目前只有看板 `sign`）可寫字。擺好後在走路模式點它（左/右鍵）或旁邊按 F，離它約 90px 內會開編輯視窗（`#signBox`，最多 100 字，Ctrl+Enter 儲存、Esc 取消；開著時鍵盤整個交給輸入框、不能走路）。文字存在擺設項目上：`{type, cell, text}`，**所有人都能改**（使用者決定，與一般家具同樣開放）。客戶端送 `sign {cell, text}`，伺服器只接受 manifest 標了 `text` 的家具、過濾控制字元、截 100 字，空字串＝清除，改完廣播整份 `furn`（Worker 的 `editSign`、dev_server 的 `edit_sign`，兩邊要一起改）。走近約 4 格內，看板上方會顯示第一行前 16 字。擺設草稿的 `cloneFurn` 要帶著 `text`，否則別人保存時會把字弄丟。貓已從擺設清單移除（`cat.png` 與產生器的 `cat()` 留著，之後給寵物用）；舊存檔／伺服器裡已擺的貓因 manifest 沒有而不再顯示。
- **釣魚與魚類圖鑑（已做）**：造型的武器選「釣竿」（`avatar.json` 的 weapon 標 `fishing: true`，拿著時左鍵／F 是釣魚、不能攻擊，點石頭／樹仍自動換工具）。在水邊按 F 或點擊就拋竿（`castPoint`：點到範圍內的水面就拋到那裡；否則朝游標方向／F 的面向找 36～140px 內的水；那個方向沒水就在身邊每 15° 找一圈，挑最接近想拋方向的水面；四周都沒水才提示，不必點得很準） → 浮標上下飄 → 3～8 秒後上鉤（浮標拉下水＋頭上「!」）→ **2 秒內**再按一次拉竿（1 秒拉扯動畫，期間不能動）→ 揭曉；超過 2 秒魚跑掉。釣魚中可以走動、跳躍（使用者決定），離浮標超過 5 格（`FISH_LEASH`）才自動收竿；再按一次（等魚時）、換武器、進裝飾模式、被石化、死亡、換地形也收竿。常數在 `main.js` 的 `FISH_*`。**魚的內容**：`client/assets/fish/fish.json`（由 `gen_assets.py` 的 `FISH_TABLE`／`fish_manifest()` 產生，圖也是）——每座地形 10 種（常見 5／罕見 3／稀有 2），稀有度權重 60／35／5、脫鉤率 `escape` 1%。**抽魚由伺服器權威**：客戶端拉竿成功送 `fish`，伺服器（Worker 的 `rollFish`、dev_server 的 `roll_fish`，與單機的 `main.js` `rollFish` 同演算法：先脫鉤、再依權重抽稀有度、同稀有度平均抽一種、尺寸取範圍內 r^1.6）回 `fish_result {terrain,id,size,rarity|escaped, saved, entry?, isNew?, isRecord?}`；每連線冷卻 2.5 秒。**圖鑑依 Discord 帳號存在伺服器**：`hello` 驗證成功後伺服器送 `dex {dex}`；登入的人釣到時由 Island 呼叫全域 `Registry` DO（`/dex`、`/catch`，key `dex:<uid>` → `{地形:{魚id:{max,n,first}}}`）記錄並把最新紀錄帶回；訪客／沒連線存 `localStorage` 的 `dcisland.m0.fishdex`（`S.dexSource` 標 `local`/`server`）。本機 dev_server 的圖鑑只存在記憶體。**同步**：`state.fish = {x,y,ph}`（`ph`＝`wait`/`bite`/`reel`）只用來讓同地形的人畫浮標、釣線與「!」，兩份伺服器的 state 白名單都有它；釣到什麼不廣播。圖鑑 UI：右上「圖鑑」（`#dexBox`），每個地形一頁，沒釣過的是黑色剪影＋「？？？」，釣過的顯示圖、名稱、稀有度、最大尺寸與次數；開著時仍可走路，Esc 關閉。
- **家具權限（已做）**：一般家具**開放所有人編輯**（使用者決定，因為只對小群體開放）；**「清空」只有管理員能做**（伺服器強制，客戶端按鈕也會擋）。管理員＝Worker 環境變數 `ADMIN_IDS`（逗號分隔的 Discord 使用者 ID）；沒設就沒有管理員、沒人能清空。本機 `dev_server.py` 讀 `dev_config.json` 的 `admin_ids`，**沒設時所有人（含訪客）都是管理員**，方便本機測試。伺服器在 `init`/`me` 訊息告知 `admin`；管理員需通過身分驗證（`hello` 憑證），所以正式環境要先設好 `SESSION_SECRET`。
- **坐下/睡覺（已做）**：家具 manifest 的 `use: "sit" | "sleep"` 決定（目前椅子、沙發可坐，床可睡；床（一格寬的單人床）另有 `quiltRow` 表示被子從圖的第幾列開始，睡覺時會把被子重畫在人上面）。點家具（或身邊按 F）就坐/躺，再點一次、按移動鍵/跳躍、家具被拿走、換地形都會起身；坐著/睡著不能揮擊。位置直接吸附到座位，狀態用 `state.pose`（`sit|sleep`）+ `state.seat`（家具種類）同步給同地形的人，伺服器不驗證（只轉發）。同一座位有人時不能再坐（只靠客戶端比對遠端玩家位置）。坐姿＝人物分層 sheet 的 `sit` 幀（目前 placeholder 由 `gen_assets.py` 的 `body_sit()` 轉出：頭與上身整體下移 3 列，頭髮也下移 3 列）；睡姿沒有專用圖，是把正面待機第 1 幀的頭與肩膀貼在枕頭上。新增可坐/可睡的家具＝manifest 加 `use`；椅子圖要比角色寬一點，坐上去才看得到。
- **NPC（已做）**：`client/assets/npcs/npcs.json` 的 `terrains` 決定**每張地圖各自的 NPC**（目前每張 2 位一般 NPC + 1 位嚮導，各有名字、造型 `look`、個性台詞 `lines`（每位至少 7 句））。切換地圖時 `spawnNPCs()` 換成新地圖的 NPC，上一張的不會跟著走；NPC 只在出生點附近走動（嚮導範圍更小）。左鍵/右鍵點 NPC、或在旁邊（約 56px）按 F 會從**該 NPC 自己的** `lines` 隨機說一句（不連續重複）並冒泡泡 3 秒；離太遠（`range` 80px）只提示。**嚮導**（`guide: true`，金色名牌、頭上有「？」）先說話，約 1.5 秒後才跳出 `help` 的簡易操作說明視窗（讓台詞先看得到）（右上角「造型」左邊的「操作說明」按鈕開的是同一個視窗；進島的提示只有「歡迎來到 DC島！」，不再列操作方式）（Esc／Enter／「知道了」關閉）。**操作說明、線上列表（L）等視窗開著時仍可走路／跑／跳**（使用者決定），只有畫布點擊、揮擊（含長按 F）與其他快捷鍵暫停；唯一例外是看板編輯視窗，鍵盤整個交給輸入框、不能走路。加 NPC/台詞/說明＝只改這個檔；**操作方式改了要記得同步更新 `help` 文字**。NPC 與對話只存在各自的畫面，不同步（和野外動物一樣）。
- **移動與家具碰撞**：裝飾模式也能走、也能跳，且可穿過擺飾（水邊照擋）；走路模式下若人被家具壓住/圍住（例如別人把家具擺在你腳下、或在裝飾模式穿進去後離開），可以走出來，不會被卡死。裝飾預覽的滑鼠格子每幀依鏡頭重算。
- **服裝/裝飾品權限（已定案，部分已做）**：
  - 絕大多數服裝免費；部分裝飾品需人工審核後配發。角色三層：一般成員／配發者／擁有者（擁有者先以 Worker 環境變數寫死 Discord ID）。
  - **配發者只能發「被指派給他的那幾件」受限裝飾品**（不是全部）；擁有者負責指派與撤銷。配發紀錄要留稽核（誰發給誰、哪一件、何時）。
  - `avatar.json` 之後加 `accessories` 類別與 `access: "free" | "granted"`；伺服器要檢查玩家送來的造型，沒擁有的受限品要剝除，不可只靠前端。
  - 儲存計畫：全域 Registry Durable Object（SQLite），不用 D1（現有 CI 即可部署）。**`Registry` 已建立**（`wrangler.toml` 的 `REGISTRY` 綁定、migration `v2`；目前只存魚類圖鑑），配發資料之後加在同一個實例。配發者面板放遊戲內；審核 bot 留到 M3。
  - 進度：**步驟 1「身分驗證」已完成**（見下）；Registry、裝飾品類別、造型檢查、配發面板**尚未做**。
- **身分驗證**：`/api/token` 成功後簽發 12 小時的 HMAC 憑證（`session`，密鑰為 Worker secret `SESSION_SECRET`；本機為 `dev_config.json` 的 `session_secret`，沒填則每次啟動隨機）。客戶端連 `/ws` 後送 `hello` 出示；驗證成功的連線，`state` 裡的 `name`/`uid` 由伺服器覆寫，訪客的 `uid` 會被拿掉。**沒設 `SESSION_SECRET` 時不簽發、全員視為訪客，行為與以前相同。** 房間鍵（guild:channel）仍來自 URL 參數，尚無法驗證。
- `/ws` 已有基本防護（訊息 ≤16KB、每連線 ≤40 則/秒、一島 ≤64 人、擺設 ≤500 件、地形名白名單）。一般家具編輯不看身分（刻意開放），只有清空要管理員。
- 本機若 `python` 指向 Windows 商店空殼，請用 `py -3` 或 `python3`（或實際安裝路徑）；本機 Node 版本若 <22 則跑不了 `wrangler dev`，Worker 改動需另找環境驗證。
- Worker 的 `Island` 在連線關閉時只廣播 `leave`；進場計數 `seq` 每次連線都寫儲存，之後若量大要留意。
- `docs/cloudflare-deploy.md` 內含 Cloudflare Account ID；它不是 secret，但新增文件時別再放 token/secret。
- Discord 活動沙盒有 CSP：外部資源要走 Portal 的 URL Mapping，不可直接引用外部網址；SDK 已自託管於 `client/vendor/`，`/sdk`→esm.sh 只是後備。
- `tools/dev_server.py` 刻意用 HTTP/1.1 與 `Cache-Control: no-store`（cloudflared 隧道、Discord webview 快取問題），不要改回預設；POST 一律先讀完 body。
- **多幀動畫（已做，2026-11-04；目前素材仍是單張圖）**：地形磚（地面/岸邊/水）、地形點綴物、家具、地板、動物都走同一套「可動畫的圖」——`main.js` 的 `makeSpr`／`loadSpr`／`sprFrame`／`drawSpr`（描述物件 `{img, frames, fps, stagger, fw, fh, width, height}`，`width/height`＝**單幀**大小，讓原本讀圖片大小的點擊範圍、擺放計算不用改；`S.tImages`／`S.furnImgs`／`S.floorImgs` 存的是描述物件，不是 Image，畫圖一律 `drawSpr`）。沒有 `anim`＝1 幀 sheet，畫法相同；之後換素材只要在 manifest 加 `anim`（格式見 README「內容擴充」）：地形寫 `terrain.json` 的 `anims: {檔名: anim}`、其他寫條目的 `anim`；由產生器管理的 manifest 要寫進 `gen_assets.py` 對應的表再重跑（`TERRAINS` 的 `anims` 已會傳到 terrain.json）。相位：地形磚／地板預設全圖同步（`stagger` 錯開），點綴物與家具依格子 `cellPhase` 錯開，動物每隻隨機；床的被子從同一幀切出。純畫面，不涉及同步與伺服器。人物另見下一條「人物分層」。**目前只有草島島主 `gold_dragon` 真的用到動畫**：`animals.json` 的 `anim`（另有 `dashFps`＝龍衝／飛行（`a.fly`）時、`scale`＝1 個 sheet 像素畫幾 px，**只管外觀**，判定圈 `hitRadius`、龍衝碰撞 20×big、影子等玩法仍看 `big`），外觀是使用者自製的巴哈姆特 6 幀飛行圖（`client/assets/external/img2pixel/bahamut_fly_sheet.png`，8 fps、龍衝 16 fps、`scale: 4`＝352×236；**素材背景其實是不透明白色**，靠 `keyBg` 去背；自製授權，見 `docs/assets-license.md`）。`external/` 資料夾不由產生器管理；要不要把自製素材納入產生流程仍待討論。
- **人物分層（已做，2026-11-04；目前素材是由舊圖轉出的 placeholder）**：人物＝五層由下往上疊：軀幹（膚色）→ 褲子 → 衣服 → 頭髮 → 帽子，每層一張**標準排列**的水平 sheet，所有層幀號一致、同步切換（`main.js` 的 `charSprite` 依 (造型, 幀號) 合成並快取）。排列寫在 `avatar.json` 的 `frames`：每幀 `w×h`＝24×24（比舊的 16×24 左右各多 4px 給寬帽子；**碰撞與點擊都看腳底點，與幀大小無關**），8 方向（`dirs`＝down, down_right, right, up_right, up, up_left, left, down_left）× [待機 4 幀, 走路 4 幀]＝64 幀＋第 64 號坐姿＝65 幀；`states` 是「狀態名（如 `up_left_walk`、`sit`）→ 幀號」，`fps`＝待機 4／走路 6。幀表沒有某狀態時，左右對稱的方向借另一邊左右翻轉，再沒有就退回正上／正下。**之後換素材：照標準排列畫好每一層、覆蓋同名檔**（`char_body_<膚色>.png`、`char_hair<n>.png`、`char_top_<款>.png`、`char_bottom_<款>.png`、帽子），不用改程式；要改排列就改 `gen_assets.py` 的 `CHAR_*`／`char_states()` 並重跑。目前 placeholder 由 `gen_assets.py` 的 `char_*_sheet` 把舊 `body()` 依顏色拆層（`SHIRT`／`PANTS` 的顏色歸衣服／褲子，其餘含輪廓歸軀幹），沒有圖的方向沿用舊規則（上、斜上＝背面頭髮，其餘＝正面，左邊＝右邊翻轉），待機 4 幀是同一張。`avatar.json`：`skins[].sheet`、`hair[].sheet`、`tops`／`bottoms`／`hats`（每款一張 sheet，可選 `recolor: {base, shade}` 再換色＝兩者並用；顏色仍用 `shirtColors`／`pantsColors` 的編號，帽子暫用衣服顏色）、武器 `carry: "back" | "waist"`。**武器掛點** `frames.anchors`（sheet 座標，腳底＝(w/2,h)）：`back` 背上、`backView` 背面時、`waist` 腰間、`hand` 揮擊／拋竿轉軸，`frameAnchors` 可逐幀覆寫讓武器跟著身體晃；預設值等於以前寫死的常數。造型面板的帽子／上衣款式／褲子款式列，可選的不到 2 種就不顯示（帽子要至少一頂）。**同步**：`look` 多帶 `hat`／`top`／`bottom`（款式 id，null＝沒戴／預設款）、`state` 多帶 `d8`（畫面用的 8 方向；玩法〔石化等〕仍看 `face`），兩份伺服器白名單都有。舊的 `body_*_a/b/sit.png`、`hair*.png` 已刪除。

## 動手前的檢查
- 這個改動屬於哪個里程碑？是否在使用者要求範圍內？超出範圍的想法，列在回覆裡，不要順手做。
- 動到同步、授權、token 流程或 `worker/`、`.github/` 時，先說明風險再改——這些會直接影響正式站。
