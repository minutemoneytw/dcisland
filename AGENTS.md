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
2. **素材先改 `gen_assets.py` 再重跑**，不要手改 PNG（會被下次產生蓋掉）。
3. **引入外部素材必須在 `docs/assets-license.md` 補記錄**；不得使用 SE/FFXIV 的素材、圖示、字體或商標（HUD 僅風格參考）。
4. **機密**：`tools/dev_config.json`（含 `client_secret`）絕不 commit；任何 secret 不貼進對話、日誌或程式。
5. **同步協定有兩份實作**：`worker/src/index.js`（正式）與 `tools/dev_server.py`（本機）。改訊息格式、房間行為或限制常數（`COLS/ROWS`、`MAX_*`）時兩邊與 `net.js` 要一起改。
6. **房間地形是伺服器端狀態**：預設 `grass`，只由明確的 `terrain` 訊息改變，不從 `state` 封包推斷；客戶端 `state` 不再帶 `terrain`。
7. Discord 授權 scope 目前**只有 `identify`**。多加 scope 會讓每次啟動都跳授權畫面，要加先問使用者。
8. 前端為純 ES module、單一全域狀態物件 `S`（`main.js`）；沿用現有風格，不要為小改動重構整檔。
9. **語言**：註解、commit 訊息、文件、UI 文字用繁體中文，風格與周邊程式一致。
10. `localStorage` key 前綴為 `dcisland.m0.*`，改格式時要考慮舊資料。

## Git
- 不要 force push、不要改寫已有歷史；pull/merge 以快轉或正常 merge 為主。
- commit 訊息用繁體中文，一行摘要＋必要的條列；一個 commit 做一件事。只在使用者要求時 commit / push。
- 不要把無關檔案、log、暫存輸出、本機工具狀態（如 `worker/.wrangler/`，已在 `.gitignore`）放進 repo。`.gitignore` 已列出幾個留在磁碟但不進版控的無關檔案（`LOG_FORMAT.md` 等），不要刪也不要加回來。

## 已知待辦 / 地雷
- 動物在各客戶端各自隨機生成，**尚未同步**（方向：伺服器管存在/HP/重生時間戳，走路改成種子＋共同時間可重現）。
- 家具擺設已同步：伺服器（DO storage，每個地形各一份）是唯一權威，客戶端只送 `place`/`remove`/`clear`，結果以廣播的 `furn` 清單為準；斷線時才退回 `localStorage`。舊的本機擺設不會自動上傳。伺服器**不判斷水邊**（只有客戶端知道島形）。
- 公共島家具**開放所有人編輯**（使用者決定，因為只對小群體開放）。
- **服裝/裝飾品權限（已定案，部分已做）**：
  - 絕大多數服裝免費；部分裝飾品需人工審核後配發。角色三層：一般成員／配發者／擁有者（擁有者先以 Worker 環境變數寫死 Discord ID）。
  - **配發者只能發「被指派給他的那幾件」受限裝飾品**（不是全部）；擁有者負責指派與撤銷。配發紀錄要留稽核（誰發給誰、哪一件、何時）。
  - `avatar.json` 之後加 `accessories` 類別與 `access: "free" | "granted"`；伺服器要檢查玩家送來的造型，沒擁有的受限品要剝除，不可只靠前端。
  - 儲存計畫：全域 Registry Durable Object（SQLite），不用 D1（現有 CI 即可部署）。配發者面板放遊戲內；審核 bot 留到 M3。
  - 進度：**步驟 1「身分驗證」已完成**（見下）；Registry、裝飾品類別、造型檢查、配發面板**尚未做**。
- **身分驗證**：`/api/token` 成功後簽發 12 小時的 HMAC 憑證（`session`，密鑰為 Worker secret `SESSION_SECRET`；本機為 `dev_config.json` 的 `session_secret`，沒填則每次啟動隨機）。客戶端連 `/ws` 後送 `hello` 出示；驗證成功的連線，`state` 裡的 `name`/`uid` 由伺服器覆寫，訪客的 `uid` 會被拿掉。**沒設 `SESSION_SECRET` 時不簽發、全員視為訪客，行為與以前相同。** 房間鍵（guild:channel）仍來自 URL 參數，尚無法驗證。
- `/ws` 已有基本防護（訊息 ≤2KB、每連線 ≤40 則/秒、一島 ≤64 人、擺設 ≤500 件、地形名白名單）。家具編輯目前不看身分（刻意開放）。
- 本機若 `python` 指向 Windows 商店空殼，請用 `python3`（或實際安裝路徑）；本機 Node 版本若 <22 則跑不了 `wrangler dev`，Worker 改動需另找環境驗證。
- Worker 的 `Island` 在連線關閉時只廣播 `leave`；進場計數 `seq` 每次連線都寫儲存，之後若量大要留意。
- `docs/cloudflare-deploy.md` 內含 Cloudflare Account ID；它不是 secret，但新增文件時別再放 token/secret。
- Discord 活動沙盒有 CSP：外部資源要走 Portal 的 URL Mapping，不可直接引用外部網址；SDK 已自託管於 `client/vendor/`，`/sdk`→esm.sh 只是後備。
- `tools/dev_server.py` 刻意用 HTTP/1.1 與 `Cache-Control: no-store`（cloudflared 隧道、Discord webview 快取問題），不要改回預設；POST 一律先讀完 body。

## 動手前的檢查
- 這個改動屬於哪個里程碑？是否在使用者要求範圍內？超出範圍的想法，列在回覆裡，不要順手做。
- 動到同步、授權、token 流程或 `worker/`、`.github/` 時，先說明風險再改——這些會直接影響正式站。
