# M1 — Discord Activity 串接指南（你手上要點的， only）

> 目標：在 DC 語音頻道點開「DC島」，遊戲認得你的 DC 身分。
> 你負責：Developer Portal 上的操作（需要你的帳號）。我負責：其餘程式。

## 步驟 1：建立 Application

1. 開 https://discord.com/developers/applications → 右上 **New Application** → 名稱填 `DC島`。
2. 左側 **General Information** 頁，把 **Application ID**（一串數字）複製起來。
3. 打開 `tools/dev_config.json`，把那串數字填到 `client_id`。

## 步驟 2：拿 Secret（給本機 token 兌換用）

1. 左側 **OAuth2** 頁 → **Client Secret** 旁的 **Reset Secret** → 複製。
2. 填到 `dev_config.json` 的 `client_secret`。（這個像密碼一樣，別貼去群組。）
3. 同頁下方 **Redirects**：新增兩個：
   - 開發用你稍後的隧道網址（例 `https://xxxx.trycloudflare.com/`）
   - 若已有正式網址也加上
   > 沒有 Redirects 的話 SDK 授權 iframe 會靜默失敗。

## 步驟 3：開啟 Activity 功能

1. 左側（特定版面可能在 General 或單獨頁籤）**Activities**：
   - 打開 **Enable Activities**
2. **URL Mappings**：
   - Root Path `/` → 你的網址（本機測試填隧道網址）
   - 就這一條就夠（之後再加 path 隨意）

## 步驟 3.5：讓測試員也能進來（重要）

官方限制：**只有 App 擁有者與「開發團隊」成員能在活動架上看到並啟動未發布的 Activity**。所以測試員不是「加進群就好」，必須加進團隊：

1. Portal 左側 **團隊（Teams）** → **新建團隊**（建立團隊要求你的 Discord 帳號已開 **2FA**）
2. 團隊頁 → 邀請成員：輸入測試員的 **Discord 使用者名稱**，他們要在 DC 裡接受邀請
3. 團隊頁 → **應用程式 → 移轉**：把 `DC島` 移轉給這個團隊（不移轉的話團員看不到）
   - 之後新開的 App 直接就建在團隊底下最省事
4. 測試員端的前置：
   - DC 桌面版 → 使用者設定 → 進階 → **開發者模式 ON**（活動架需要它）
   - 要在 App 已安裝的那個群裡（見步驟 4 的群安裝）
   - 進語音頻道 → 火箭 → 架上找 `DC島` → 點開 → 首次授權（選群 + 同意）→ 名牌變成他的 DC 名稱
5. **你的電腦＋dev_server＋隧道必須開著**（試作期大家連的是你這台）；你關機＝島關門，這就是之後要搬上 Cloudflare 的理由

> 想開放給「非團隊成員」的一般群友：那是另一階段的 **App 認證（Verification）**，要到處都是公開測試時再申請，非試作期的事。

## 步驟 4：把 App 加進你的伺服器 & 測試

1. OAuth2 → URL Generator：勾 `activities` + `applications.commands`（視版本顯示為 `guilds.activities` 等），下方.sessions先給 **Install to Guild**
2. 產生授權連結 → 你開瀏覽器貼上 → 選你的群 → 授權（Bot 權限可全不勾）。
3. DC 客戶端（**桌面版**）：
   - 使用者設定 → 進階 → 打開 **開發者模式**
   - 進任何語音頻道 → 左下**火箭**圖示 → 活動列表應該出現 `DC島`（開發中的）
   - 點它：Discord 會載入 URL Mappings 的網址，分個框，島就出現
4. 首次應該會跳「授權 Access」。同意後島上你的小人就可改為 DC display 名称。

## 開發測試流程（上線會跑程式的流程）

```bash
# 我這邊的本地伺服器（Python，處理 /api/token 兌換）
python tools/dev_server.py

# 開一條 HTTPS 隧道（Cloudflare 免費、免帳號）
cloudflared tunnel --url http://localhost:8787
# 把印出的 https://xxx.trycloudflare.com 填進 Portal 的 URL Mappings + Redirects
```

- **mock 測試（不經 Discord）**：`http://localhost:8787/index.html?mock=1`
- 在 Activity 裡：程式會偵測 `frame_id` → 啟動 SDK → 授權 → 你的 DC 名字變成小人名牌

## 常見卡點（照樣除雷）

| 症狀 | 原因 |
|---|---|
| Activity 載入後空白卡死 | URL Mappings 網址與隧道不一致；或 https 憑證失敗 |
| 授權 iframe 沒彈即頁面錯誤 | Redirects 沒填 |
| 活動列表找不到 App | 步驟 4-2 授權連結還沒加進群；或活動還未開啟 |
| 讀到名字但 token 失敗 | `dev_config.json` 的 secret 舊了（Portal 重置過） |

## 安全備忘

- `dev_config.json`：「**never** push 到公開 repo」（正式部署一樣把 secret 放 Cloudflare Worker 的 secrets，不放前端）。
