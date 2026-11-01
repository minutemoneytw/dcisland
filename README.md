# DC島（Discord Island）

FF14 玩家群用的 DC 小島：**同一個語音頻道 = 同一座公共島，沒上線頻道時就在自己的島上裝飾**。
2D 點陣風、FFXIV 風 HUD（僅風格參考，不含 SE 素材；目前素材全是自產 placeholder，零授權風險）。

## 現在到哪？（里程碑）

- ✅ **M0 本地可玩 demo**：6 地形（manifest 制）、走路/跑/跳、裝飾模式、造型系統、FF14 致敬小動物（波波羊/圓喙鳥/大肚蛙）、武器攻擊＋動物 HP/死亡/CD 重生
- ✅ **M1 Discord Activity 串接**：真 DC 身分授權（名牌顯示 DC 名稱）、隧道 → Portal 設定流程、測試員可啟動
- 🚧 **M2 多人同步**：本機 WebSocket 版進行中（同語音頻道＝同房間，玩家互相可見）→ 之後搬上 Cloudflare Durable Objects
- ⬜ M3 個人島列表/參觀、鎖島、家具/造型申請審核 bot
- ⬜ M4 公測

## 本地執行

```bash
# 1) 憑證（只有要接 Discord 才需要；純本機玩可跳過）
copy tools\dev_config.example.json tools\dev_config.json   # 再填入 client_id / client_secret

# 2) 啟動（靜態檔 + /api/config + /api/token + /ws 多人同步）
python tools/dev_server.py
```

- 開 http://localhost:8787 直接玩
- 模擬 DC 身分：http://localhost:8787/index.html?mock=1
- 多人測試：**開兩個瀏覽器分頁**就會看到彼此（同一 `?room=` 即同島；不給就落在 `local:local`）

## 接 Discord Activity

你（App 擁有者）要做的 Portal 操作、隧道、測試員加入方式：`docs/m1-discord-setup.md`

```bash
tools\cloudflared.exe tunnel --url http://localhost:8787   # 產生 https 網址填進 Portal
```

## 操作

`WASD/方向鍵` 走 · `Shift` 跑 · `Space` 跳 · **左鍵（或 `F`）攻擊** · `E` 裝飾模式（左鍵放置、右鍵拿取、即時存檔）· 頂部 chip 切地形 · `造型` 換膚色/髮型/上衣/武器。

## 專案結構

```
docs/spec.md                規格書與里程碑
docs/assets-license.md      素材授權記錄（引入外部素材包時補記）
docs/m1-discord-setup.md    Discord Portal 操作指南（含測試員加入）
tools/gen_assets.py         素材產生器（placeholder；改素材先改這裡再重跑）
tools/dev_server.py         本機伺服器：靜態 + /api/token + /ws（多人同步）
tools/dev_config.example.json  憑證範本（複製為 dev_config.json）
client/                     純前端（無 build step）
  js/main.js                遊戲本體（引擎/戰鬥/動物/裝飾/造型）
  js/discord.js             Discord Embedded App SDK 接線（本機/mock/真 DC 三模式）
  assets/
    terrain/<id>/terrain.json + tiles + sprite   ← 加地形＝加資料夾
    furniture/furniture.json + *.png             ← 加家具＝加 manifest 條目＋png
    animals/animals.json + *.png                 ← 加動物＝加 manifest 條目
    avatar/avatar.json + body_* + hair* + 武器    ← 加造型＝加檔案
```

## 機密與安全

- `tools/dev_config.json`（含 `client_secret`）**已列入 .gitignore，不會進版控**；正式部署時 secret 放伺服器端環境變數，不放前端
- 試作期大家連的是「擁有者的電腦 + 隧道」；正式版會搬上 Cloudflare 免費層（Workers + Durable Objects + D1），24/7 不依賴任何人的電腦
