# Cloudflare 部署（M2 正式層）

目標：島搬到雲端 **24/7**，不再依賴任何人的電腦。
一個 Worker 同時做三件事：前端靜態檔、`/api/token` 兌換、`/ws` 多人同步（Durable Object，一座島＝一個實例）。

## 你會需要的帳號

1. Cloudflare 免費帳號：https://dash.cloudflare.com/sign-up （Email + 密碼，免費，不用信用卡）
2. 免費額度對我們規模（20 人同時說話／60 人在線）非常充足

## 部署步驟

```bash
cd worker

# 1) 登入（會開瀏覽器要你授權）
npx wrangler login

# 2) 放 secret（貼 tools/dev_config.json 裡的 client_secret）
npx wrangler secret put DISCORD_CLIENT_SECRET

# 3) 部署
npx wrangler deploy
```

部署成功會印出一條網址，像：

```
https://dcisland.<你的子域>.workers.dev
```

## 部署後要改 Portal（3 處）

| 位置 | 內容 |
|---|---|
| 活動 → URL 對應 → 根對應（`/`）的**目標** | 改成 `dcisland.<你的子域>.workers.dev`（不帶 `https://`） |
| 活動 → URL 對應 → 可**刪掉** `/sdk` 那條 | SDK 已改為自家託管（`client/vendor/`），不需要外部對應 |
| OAuth2 → 重新導向 | 加上 `https://dcisland.<你的子域>.workers.dev` |

改完**儲存**，重啟 DC 客戶端，活動就會從雲端載入。

## CI/CD：推版自動部署

正式站：**https://dcisland.less78518.workers.dev**

`.github/workflows/deploy.yml` 已設定好：只要有人推版到 `main`，且改動到 `client/**`、`worker/**`，GitHub 就會自動部署。
三個維護者都不需要手動更新伺服器。

需要 repo 的兩把鑰匙（**只設一次**）：

1. Cloudflare → https://dash.cloudflare.com/profile/api-tokens → **Create Token** → 範本 **Edit Cloudflare Workers**
   - Account Resources：選自己的帳號
   - Zone Resources：**All zones**（沒有自己的網域，不能用 Specific zone）
   - Token expiration：No expiration
   - **Continue to summary → Create Token** → 複製（只顯示一次）
2. GitHub → https://github.com/minutemoneytw/dcisland/settings/secrets/actions → 新增兩個 Secret
   - `CLOUDFLARE_API_TOKEN` = 剛剛複製的 token
   - `CLOUDFLARE_ACCOUNT_ID` = `ed19a554b0df8ae63c70585a2bebc6f4`

設好之後，任何 `git push` 到 main 都會自動上線。也可以在 GitHub 的 **Actions** 頁按 **Run workflow** 手動觸發。

> Worker 的 `DISCORD_CLIENT_SECRET` 存在 Cloudflare 上，部署不會覆蓋它，CI 不需要知道這個值。

## 維護者日常流程

```bash
git pull                     # 先同步
# 改 client/ 或 worker/ 的程式
git add -A && git commit -m "說明改了什麼"
git push                     # → GitHub Actions 自動部署（約 1 分鐘）
```

看部署結果：https://github.com/minutemoneytw/dcisland/actions

## 開發期指令

```bash
npx wrangler dev --port 8790    # 本機預覽（含 Durable Object）
npx wrangler tail               # 看雲端即時日誌（前端錯誤信標會出現在這）
npx wrangler deploy             # 更新正式版
```

## 疑難排解

| 症狀 | 檢查 |
|---|---|
| 活動白屏 | `npx wrangler tail` 看有沒有請求進來；Portal 的根對應目標是否正確 |
| 授權失敗 / token 400 | secret 是否設好：`npx wrangler secret list` |
| 看不到其他人 | 是否都在同一語音頻道（房間鍵＝guild:channel）；`wrangler tail` 看 `[ws]` 連線 |
| 前端錯誤 | 前端會把錯誤 POST 到 `/api/log`，用 `wrangler tail` 看 `[beacon]` |

## 資料

- 島的地形存在 Durable Object 儲存（免費層 SQLite 後端），不會因重啟而重置
- 家具擺設也存在 Durable Object 儲存（每個地形各一份），同島的人共用；個人島之後再考慮進 D1（免費層）
