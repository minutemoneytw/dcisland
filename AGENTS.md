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
5. **同步協定有兩份實作**：`worker/src/index.js`（正式）與 `tools/dev_server.py`（本機）。改訊息格式或房間行為時兩邊與 `net.js` 要一起改。
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
- 動物在各客戶端各自隨機生成，**尚未同步**；家具擺設只存 `localStorage`，**尚未同步**（計畫進 D1）。
- Worker 的 `/ws` 沒有訊息大小/頻率/房間人數限制，也不驗證 Discord 身分；房間鍵來自 URL 參數可被偽造。對外開放前必須補。
- Worker 的 `Island` 在連線關閉時只廣播 `leave`；進場計數 `seq` 每次連線都寫儲存，之後若量大要留意。
- `docs/cloudflare-deploy.md` 內含 Cloudflare Account ID；它不是 secret，但新增文件時別再放 token/secret。
- Discord 活動沙盒有 CSP：外部資源要走 Portal 的 URL Mapping，不可直接引用外部網址；SDK 已自託管於 `client/vendor/`，`/sdk`→esm.sh 只是後備。
- `tools/dev_server.py` 刻意用 HTTP/1.1 與 `Cache-Control: no-store`（cloudflared 隧道、Discord webview 快取問題），不要改回預設；POST 一律先讀完 body。

## 動手前的檢查
- 這個改動屬於哪個里程碑？是否在使用者要求範圍內？超出範圍的想法，列在回覆裡，不要順手做。
- 動到同步、授權、token 流程或 `worker/`、`.github/` 時，先說明風險再改——這些會直接影響正式站。
