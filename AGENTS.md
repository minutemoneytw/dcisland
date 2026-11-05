# AGENTS.md — DC島 協作指南（給所有 AI agent）

> 這份每次都會載入，所以刻意保持精簡。各功能的詳細說明與地雷在 **`docs/notes.md`**（見最下方索引）。
> 有衝突時以使用者當下的指示為準；發現本文件或 `docs/notes.md` 與程式不符，請更新。

## 硬性規則（每次動手前逐條對照）
1. **先 `git pull`**，看 `git log` 有沒有別人的新改動（多位維護者同時推版）。
2. **改到某功能前，先讀 `docs/notes.md` 對應段落**（索引在本檔最下方）。
3. **動到 `worker/`、`.github/`、同步協定、授權或 token 流程：先列出風險、等使用者同意再改。** 這些會直接影響正式站。
4. **只做使用者要求的範圍**（也想一下屬於哪個里程碑）。順手想到的修正或改進，列在回覆裡讓使用者決定，不要直接做。
5. **一個 commit 只做一件事。** 一次改了好幾件事，就分成好幾個 commit（必要時邊改邊提交）。只在使用者要求時 commit。
6. **沒有使用者同意不 push。** push 到 `main` 就會自動上線。
7. **改完用瀏覽器實際跑過才說「完成」**；沒驗證到的部分（例如 Worker 版、真 Discord）要明講。
8. **同步協定有兩份實作**：`worker/src/index.js`（正式）與 `tools/dev_server.py`（本機）。改訊息格式、房間行為或限制常數（`COLS/ROWS`、`MAX_*`、`D_*` 等）時，兩邊與 `client/js/net.js` 要一起改。
9. **語言**：對話、註解、commit 訊息、文件、UI 文字都用繁體中文，風格與周邊程式一致；檔名、函式名、指令照原文。
10. **機密**：`tools/dev_config.json`（含 `client_secret`）絕不 commit；任何 secret 不貼進對話、日誌或程式。

## 專案是什麼
Discord Activity 小遊戲：2D 點陣島，**同一個語音頻道＝同一座公共島**。
正式站跑在 Cloudflare（`https://dcisland.less78518.workers.dev`）。
里程碑（詳見 `docs/spec.md`）：M0 本機 demo、M1 Discord 串接、M2 多人同步 已完成；M3（個人島/參觀/鎖島/審核 bot）、M4（公測）未開始。

## 部署
- **推到 `main` 且改到 `client/**`、`worker/**` 或 `.github/workflows/deploy.yml`，GitHub Actions 會自動部署到正式站**（只改 `docs/` 不會）。
- `DISCORD_CLIENT_SECRET` 存在 Cloudflare Worker secrets，CI 與 repo 都不應出現它。
- Portal 的根對應必須指向 `dcisland.less78518.workers.dev`（用臨時隧道測完要改回去，否則大家白屏）。

## 指令
```bash
python tools/dev_server.py            # 本機：靜態檔 + /api/token + /ws，http://localhost:8787（不需 Node）
python tools/gen_assets.py            # 重新產生 client/assets 下的 PNG（placeholder 素材）
python tools/import_external.py <zip 或資料夾> <輸出.png>   # 使用者自製（img2pixel）逐幀素材 → 水平 sheet，放進 client/assets/external/img2pixel/
cd worker && npx wrangler dev --port 8790   # 本機預覽 Worker 版（含 Durable Object；需 Node ≥22）
```
- 多人測試：開兩個分頁（同 `?room=` 即同島）；模擬 DC 身分：`/index.html?mock=1`
- **沒有自動化測試**，也沒有前端 build step。
- `tools/` 只用 Python 標準庫；前端不要引入 npm/打包工具（除非使用者同意）。

## 架構
| 路徑 | 職責 |
|---|---|
| `client/js/main.js` | 遊戲本體：世界生成、移動/跳躍、繪圖、戰鬥、動物、裝飾、造型、UI |
| `client/js/net.js` | 多人同步客戶端（WebSocket）。介面保持穩定 |
| `client/js/discord.js` | Discord Embedded App SDK 接線（本機 / mock / 真 DC 三模式） |
| `client/vendor/` | 自託管的 SDK 單檔 bundle（不依賴外部 CDN，勿手改） |
| `worker/src/index.js` | **正式環境伺服器**：`/api/token`、`/api/config`、`/api/log`、`/ws` → Durable Object `Island`（一座島一個實例）；全域 Durable Object `Registry`（跨島的玩家資料，目前是魚類圖鑑） |
| `worker/wrangler.toml` | Worker 設定（assets 指向 `../client`、DO 綁定、`DISCORD_CLIENT_ID`） |
| `tools/dev_server.py` | 本機開發用伺服器，行為要與 Worker 版**保持一致** |
| `tools/gen_assets.py` | 素材的唯一來源 |
| `client/assets/**` | 由 manifest（各 `*.json`）驅動 |
| `docs/` | 規格、實作筆記（`notes.md`）、Discord 設定、Cloudflare 部署、素材授權記錄 |

## 慣例
1. **加內容走 manifest，不改程式**：新家具/動物/造型＝manifest 加條目＋圖檔。新地形＝`assets/terrain/<id>/` 資料夾＋在 `main.js` 的 `TERRAIN_IDS` 登記（見 README「內容擴充」）。
2. **素材先改 `gen_assets.py` 再重跑**，不要手改 PNG。產生器採**內容感知寫檔**：PNG（像素）與 manifest（JSON，一律 LF）一模一樣就不重寫，重跑後 `git status` 只會列出真的改到的檔案，不需要再 `git checkout` 還原不相干素材。`assets/tools/tools.json`、`assets/skills/skills.json` 是手寫資料，不由產生器產生。
3. **引入外部素材必須在 `docs/assets-license.md` 補記錄**；不得使用 SE/FFXIV 的素材、圖示、字體或商標（HUD 僅風格參考）。使用者自製（img2pixel）素材的導入流程：先 `python tools/import_external.py` 拼 sheet 放進 `client/assets/external/img2pixel/`，再到 `tools/gen_assets.py` 的 `EXTERNAL_BUNDLES` 登記（重跑開頭會健檢尺寸）並接好 `MOB_MANIFEST` 的 `anim`（島主再加 `OWNER_BY_TERRAIN`）；細節見該資料夾的 `README.md`。
4. **地形是「每位玩家各自在哪」**，不是房間共用狀態；廣播只給同地形的連線（細節見 `docs/notes.md`「同步協定與伺服器」）。
5. Discord 授權 scope **只有 `identify`**。多加 scope 會讓每次啟動都跳授權畫面，要加先問使用者。
6. 前端為純 ES module、單一全域狀態物件 `S`（`main.js`）；沿用現有風格，不要為小改動重構整檔。
7. `localStorage` key 前綴為 `dcisland.m0.*`，改格式時要考慮舊資料。
8. **使用者做過的設計決定**（例如野外動物刻意不同步、家具開放所有人編輯）記在 `docs/notes.md`，不要自行「修正」。

## Git
- 不要 force push、不要改寫已有歷史；pull/merge 以快轉或正常 merge 為主。
- commit 訊息用繁體中文，一行摘要＋必要的條列。
- 不要把無關檔案、log、暫存輸出、本機工具狀態（如 `worker/.wrangler/`）放進 repo。`.gitignore` 已列出幾個留在磁碟但不進版控的無關檔案（`LOG_FORMAT.md` 等），不要刪也不要加回來。

## `docs/notes.md` 索引（改到這些地方前先讀對應段落）
| 要改的東西 | 讀哪一段 |
|---|---|
| `net.js`、兩份伺服器的訊息／房間／限流、可破壞物件、家具同步、裝飾草稿 | 同步協定與伺服器 |
| `/api/token`、`hello`、`SESSION_SECRET`、管理員、服裝配發 | 身分驗證與權限 |
| 島主（`OWNER_*`、`D_*`）、仇恨、玩家血量、**職業（`JOBS`、R 技能：挑釁／群療、技能列）**、**法杖遠距詠唱**、**武器列**、新增島主 | 島主與戰鬥 |
| `mobs.json`、動物游泳、捕捉/牧養規劃 | 野外動物 |
| 裝飾模式、地板、看板、坐下/睡覺、家具碰撞 | 裝飾、家具、地板、看板 |
| 採集工具、釣魚與圖鑑、NPC、操作說明 | 玩法：採集、釣魚、NPC |
| `makeSpr`／`drawSpr`、`anim`、人物分層 sheet、`avatar.json` 的 `frames` | 美術：多幀動畫與人物分層 |
| 本機 Python／Node 環境、Discord CSP、`dev_server.py` 的 HTTP 設定 | 環境與部署地雷 |
