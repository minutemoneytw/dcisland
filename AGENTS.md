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
| `worker/src/index.js` | **正式環境伺服器**：`/api/token`、`/api/config`、`/api/log`、`/ws` → Durable Object `Island`（一座島一個實例） |
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
9. **語言**：註解、commit 訊息、文件、UI 文字用繁體中文，風格與周邊程式一致。
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
- **野外動物刻意不同步**（使用者決定）：各客戶端自己隨機生成、漫步、被打、重生，每個人看到的位置/血量不同沒關係；別人在附近揮擊也會嚇到自己這邊的野外動物，這是可接受的視覺效果。不要為了「同步」去改它。
- **之後的捕捉/牧養（尚未做）**：被牧養的動物是另一種實體，不是由野外動物升級而來，要由伺服器記錄（屬於誰/哪座島、種類、格子、狀態）並讓所有人看到一致；玩家只透過特定介面（選單/按鈕）與它互動，不靠即時打擊判定，所以位置可用離散格子，不需要伺服器即時模擬（避免讓 Durable Object 一直醒著）。可沿用家具同步的機制（伺服器為權威、廣播整份清單）。
- 家具擺設已同步：伺服器（DO storage，每個地形各一份，編輯者所在地形決定改哪一份）是唯一權威，結果以廣播的 `furn` 清單為準；斷線時才退回 `localStorage`。舊的本機擺設不會自動上傳。伺服器**不判斷水邊**（只有客戶端知道島形）。
- **裝飾模式是「草稿＋保存」**：變動先記成操作清單 `S.draft`（`place`/`remove`/`clear`，畫面立刻看得到，但同島的人看不到），按「完成」（或離開時選「保存」）才用 `commit {ops}` 一批送出；「取消變動」或離開時選「不保存」就丟掉草稿。有未保存變動時按 E/Esc 會跳確認（保存／不保存／繼續編輯），也不能切地形。編輯中別人保存了，會以新清單為底把我的草稿重新疊上去；保存時伺服器逐一驗證，被別人搶先占用的操作會被跳過並回報（`commit_result {applied, rejected, denied}`）。單一 commit 最多處理 100 個操作（客戶端 80 個一批），訊息上限 16KB。舊客戶端的單一 `place/remove/clear` 訊息仍可用，走同一套驗證與權限。
- **家具權限（已做）**：一般家具**開放所有人編輯**（使用者決定，因為只對小群體開放）；**「清空」只有管理員能做**（伺服器強制，客戶端按鈕也會擋）。管理員＝Worker 環境變數 `ADMIN_IDS`（逗號分隔的 Discord 使用者 ID）；沒設就沒有管理員、沒人能清空。本機 `dev_server.py` 讀 `dev_config.json` 的 `admin_ids`，**沒設時所有人（含訪客）都是管理員**，方便本機測試。伺服器在 `init`/`me` 訊息告知 `admin`；管理員需通過身分驗證（`hello` 憑證），所以正式環境要先設好 `SESSION_SECRET`。
- **坐下/睡覺（已做）**：家具 manifest 的 `use: "sit" | "sleep"` 決定（目前椅子、沙發可坐，床可睡；床（一格寬的單人床）另有 `quiltRow` 表示被子從圖的第幾列開始，睡覺時會把被子重畫在人上面）。點家具（或身邊按 F）就坐/躺，再點一次、按移動鍵/跳躍、家具被拿走、換地形都會起身；坐著/睡著不能揮擊。位置直接吸附到座位，狀態用 `state.pose`（`sit|sleep`）+ `state.seat`（家具種類）同步給同地形的人，伺服器不驗證（只轉發）。同一座位有人時不能再坐（只靠客戶端比對遠端玩家位置）。坐姿用 `body_<皮膚>_sit.png`（`gen_assets.py` 的 `body_sit()`，頭與上身整體下移 3 列，頭髮疊圖也下移 3 列）；睡姿沒有專用圖，是把站姿的頭與肩膀貼在枕頭上。新增可坐/可睡的家具＝manifest 加 `use`；椅子圖要比角色寬一點，坐上去才看得到。
- **NPC 對話（已做）**：島上的 NPC（`boot()` 裡的 `makePlayer(..., {npc:true})`，目前三位訪客）可用左鍵/右鍵點、或在旁邊（約 56px）按 F 對話，會從 `client/assets/npcs/npcs.json` 的 `lines` 隨機說一句（不連續重複）並冒泡泡 3 秒；離太遠（`range` 80px）只提示。加台詞＝在 `lines` 加一句。**NPC 與對話只存在各自的畫面，不同步**（和野外動物一樣）。
- **移動與家具碰撞**：裝飾模式也能走（不能跳），且可穿過擺飾（水邊照擋）；走路模式下若人被家具壓住/圍住（例如別人把家具擺在你腳下、或在裝飾模式穿進去後離開），可以走出來，不會被卡死。裝飾預覽的滑鼠格子每幀依鏡頭重算。
- **服裝/裝飾品權限（已定案，部分已做）**：
  - 絕大多數服裝免費；部分裝飾品需人工審核後配發。角色三層：一般成員／配發者／擁有者（擁有者先以 Worker 環境變數寫死 Discord ID）。
  - **配發者只能發「被指派給他的那幾件」受限裝飾品**（不是全部）；擁有者負責指派與撤銷。配發紀錄要留稽核（誰發給誰、哪一件、何時）。
  - `avatar.json` 之後加 `accessories` 類別與 `access: "free" | "granted"`；伺服器要檢查玩家送來的造型，沒擁有的受限品要剝除，不可只靠前端。
  - 儲存計畫：全域 Registry Durable Object（SQLite），不用 D1（現有 CI 即可部署）。配發者面板放遊戲內；審核 bot 留到 M3。
  - 進度：**步驟 1「身分驗證」已完成**（見下）；Registry、裝飾品類別、造型檢查、配發面板**尚未做**。
- **身分驗證**：`/api/token` 成功後簽發 12 小時的 HMAC 憑證（`session`，密鑰為 Worker secret `SESSION_SECRET`；本機為 `dev_config.json` 的 `session_secret`，沒填則每次啟動隨機）。客戶端連 `/ws` 後送 `hello` 出示；驗證成功的連線，`state` 裡的 `name`/`uid` 由伺服器覆寫，訪客的 `uid` 會被拿掉。**沒設 `SESSION_SECRET` 時不簽發、全員視為訪客，行為與以前相同。** 房間鍵（guild:channel）仍來自 URL 參數，尚無法驗證。
- `/ws` 已有基本防護（訊息 ≤16KB、每連線 ≤40 則/秒、一島 ≤64 人、擺設 ≤500 件、地形名白名單）。一般家具編輯不看身分（刻意開放），只有清空要管理員。
- 本機若 `python` 指向 Windows 商店空殼，請用 `python3`（或實際安裝路徑）；本機 Node 版本若 <22 則跑不了 `wrangler dev`，Worker 改動需另找環境驗證。
- Worker 的 `Island` 在連線關閉時只廣播 `leave`；進場計數 `seq` 每次連線都寫儲存，之後若量大要留意。
- `docs/cloudflare-deploy.md` 內含 Cloudflare Account ID；它不是 secret，但新增文件時別再放 token/secret。
- Discord 活動沙盒有 CSP：外部資源要走 Portal 的 URL Mapping，不可直接引用外部網址；SDK 已自託管於 `client/vendor/`，`/sdk`→esm.sh 只是後備。
- `tools/dev_server.py` 刻意用 HTTP/1.1 與 `Cache-Control: no-store`（cloudflared 隧道、Discord webview 快取問題），不要改回預設；POST 一律先讀完 body。

## 動手前的檢查
- 這個改動屬於哪個里程碑？是否在使用者要求範圍內？超出範圍的想法，列在回覆裡，不要順手做。
- 動到同步、授權、token 流程或 `worker/`、`.github/` 時，先說明風險再改——這些會直接影響正式站。
