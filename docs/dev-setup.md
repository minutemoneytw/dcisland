# 換一台電腦開發（新機器設定）

> 目的：在**任何一台電腦**（例如辦公室的電腦）五分鐘內接到專案、跑起來、能推版。
> 專案程式、文件、協作規範（`AGENTS.md`）都在 GitHub，新機器不需要從舊機器複製程式。

## 0. 先決條件

| 需要 | 用途 | 沒有也可以嗎 |
|---|---|---|
| **Git** | 抓程式、推版 | ❌ 必要 |
| **Python 3.10+** | `tools/dev_server.py`（本機伺服器）、`tools/gen_assets.py`（素材產生器） | ❌ 必要（本機開發/玩） |
| **Node 22+** | 只有 `wrangler dev`（本機預覽 Cloudflare Worker 版）需要 | ✅ 可略（推版由 CI 自動部署） |
| **Discord 桌面版** | 測真實 Activity | ✅ 可略（本機 `?mock=1` 可測） |

安裝（Windows，PowerShell）：

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.12 -e
winget install --id OpenJS.NodeJS.LTS -e     # 只有要跑 wrangler dev 才需要
```

macOS：

```bash
brew install git python node
```

## 1. 抓程式

```bash
git clone https://github.com/minutemoneytw/dcisland.git
cd dcisland
```

公開 repo，clone 不用登入。**第一次要推版時**才會要你登入 GitHub（會開瀏覽器授權），順手設定提交身分：

```bash
git config user.name "你的名字"
git config user.email "你的 Email 或 GitHub noreply"
```

## 2. 憑證（只有要測「真的 Discord 身分」才需要）

`tools/dev_config.json` 內含 `client_secret`，**不在 repo 裡**（`.gitignore` 排除）。新機器有兩條路：

- **只想本機開發/玩**：不用做任何事，直接跳到第 3 步（純本機模式不需要憑證）。
- **要測真 Discord 身分**：把舊機器的 `tools/dev_config.json` 內容補上（建議從密碼管理員複製，不要用聊天軟體傳）：

  ```bash
  cp tools/dev_config.example.json tools/dev_config.json
  # 然後填入 client_id 與 client_secret
  ```

  兩把值的來源：Discord Developer Portal → 你的 App → General Information（Application ID）與 OAuth2（Client Secret）。

> Cloudflare 的兩把 secret（`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）**只存在 Cloudflare**，新機器不需要、也拿不到；部署由 CI 進行。

## 3. 跑起來

```bash
python tools/dev_server.py        # Windows 若 python 是商店空殼，改用 python3
# 開 http://localhost:8787
```

- 純本機玩：直接開網址
- 多人測試：開**兩個瀏覽器分頁**，同一個 `?room=xxx` 就會看到彼此
- 模擬 Discord 身分：`http://localhost:8787/index.html?mock=1`
- Worker 版本機預覽（需 Node 22+）：`cd worker && npx wrangler dev --port 8790`（本機預覽**不需要** Cloudflare 登入）

## 4. 推版＝上線

```bash
git pull                          # 動手前先同步（三位維護者同時在推）
# …改程式…
git add -A && git commit -m "說明"
git push                          # GitHub Actions 自動部署到正式站（約 1 分鐘）
```

- 只有改到 `client/**`、`worker/**`、`.github/workflows/deploy.yml` 才會觸發部署；純改 `docs/` 不會
- **新機器不需要 Cloudflare 帳號或 wrangler 登入**（CI 用 repo secrets 部署）
- 部署結果：https://github.com/minutemoneytw/dcisland/actions

## 5. 給這台電腦的 AI agent

開新對話時請它先讀：`AGENTS.md`（協作規範與地雷）→ `README.md` → `docs/spec.md`。
`AGENTS.md` 會告訴它：同步協定有兩份實作要一起改、推版等於上線、機密不准進 repo 等。

## 常見地雷

| 症狀 | 原因 / 解法 |
|---|---|
| `python` 跳出 Microsoft Store | 用 `py -3`（Windows 的 Python 啟動器）或 `python3`，或用安裝路徑（如 `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`） |
| `wrangler` 跑不動 | Node 版本 < 22；裝 LTS 後開新終端機 |
| 改了 JS 但畫面沒變 | 本機伺服器已送 `Cache-Control: no-store`；瀏覽器請用新分頁或硬重新整理 |
| 推不上去 | 先 `git pull`（遠端有別人的提交），解完衝突再推 |
| `worker/.wrangler/` 出現在 git status | 它是本機工具狀態，已在 `.gitignore`，不要 commit |
| 忘了帶 `dev_config.json` | 純本機開發用不到它；要測真 Discord 再從密碼管理員補 |
