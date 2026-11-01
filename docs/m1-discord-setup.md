# Discord Activity 串接指南（雲端版）

> 現況：**正式站在 Cloudflare**，`https://dcisland.less78518.workers.dev`。
> URL 對應填的就是這條，不需要開隧道、不需要自己的電腦開著。
> 本文件給「新加入的維護者」或「要重建一份自己的 App」時照著做。

## 前置：一組 Discord App

1. https://discord.com/developers/applications → **New Application** → 名稱 `DC島`
2. **General Information** → 複製 **Application ID**（一串數字）
3. **OAuth2** → **Reset Secret** → 複製 **Client Secret**
4. 把兩個值填進 `tools/dev_config.json`：
   ```json
   { "client_id": "你的ApplicationID", "client_secret": "你的Secret" }
   ```
   （`tools/dev_config.example.json` 是範本；這個檔已被 `.gitignore` 排除，**不會進版控**）

## Cloudflare 這邊

- `worker/wrangler.toml` 的 `DISCORD_CLIENT_ID` 要換成你的 Application ID
- 推版後由 CI 自動部署（見 `docs/cloudflare-deploy.md`），或本機 `cd worker && npx wrangler deploy`
- Secret（client secret）只存在 Cloudflare：
  ```bash
  cd worker
  npx wrangler secret put DISCORD_CLIENT_SECRET
  ```

## Portal 要設定的三處

| 位置 | 內容 |
|---|---|
| **活動 → URL 對應 → 根對應** | 前綴 `/`、目標 `dcisland.less78518.workers.dev`（**不要**加 `https://`） |
| **活動 → 設定** | 打開 **Enable Activities** |
| **OAuth2 → 重新導向** | 加一條 `https://dcisland.less78518.workers.dev/` |

> **Proxy 路徑對應不需要任何條目**。SDK 是自家託管的單檔（`client/vendor/`），不用把外部 CDN 對應進來。
> （舊文件寫的 `/sdk → esm.sh` 是早期做法，現在留著無害，但可以刪。）

## 讓測試員／維護者進來

官方限制：**只有 App 擁有者與「開發團隊」成員能啟動未發布的 Activity**。

1. Portal 左側 **團隊（Teams）** → 新增團隊（需帳號已開 **2FA**）
2. 邀請成員（輸入對方 Discord 使用者名稱，對方要在 DC 裡接受）
3. 團隊頁 → **應用程式 → 移轉**：把 `DC島` 移轉給團隊（不移轉，成員看不到）
4. 成員端：DC 桌面版 → 使用者設定 → 進階 → **開發者模式 ON** → 進語音頻道 → 火箭 → 找 `DC島`

## 本機開發（要改程式的人）

```bash
python tools/dev_server.py            # 本機伺服器 + 多人同步（不需要 Node）
# 開 http://localhost:8787
# 多人測試：開兩個分頁，同一 ?room=xxx 就會看到彼此
```

要測試真正的 Discord 串接時，才需要臨時隧道把本機服務對外：

```bash
tools\cloudflared.exe tunnel --url http://localhost:8787
# 把印出的 https 網址填進 Portal 的根對應與重新導向，測完記得改回 workers.dev
```

> ⚠️ 隧道網址每次重開都會變，所以**測試完務必改回正式站**，否則大家會白屏。

## 常見卡點

| 症狀 | 原因 |
|---|---|
| 一片白 | 根對應的目標掛了（隧道關了／網址變了）；改回 `dcisland.less78518.workers.dev` |
| 每次啟動都跳授權 | 授權 scope 含有 guilds / applications.commands；只留 `identify` 就不會再跳 |
| 授權 iframe 沒彈就失敗 | OAuth2 的重新導向沒填 |
| 活動列表找不到 App | 還沒加進團隊；或開發者模式沒開 |
| 讀到名字但 token 失敗 | Cloudflare 的 `DISCORD_CLIENT_SECRET` 舊了（Portal 重置過 secret 的話要重設） |
| 看不到其他人 | 不在同一個語音頻道（房間鍵＝guild:channel） |

## 安全備忘

- `tools/dev_config.json`（含 secret）**永不進版控**
- 雲端的 secret 存在 Cloudflare Worker secrets，前端拿不到
