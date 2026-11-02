# DC島（Discord Island）

FF14 玩家群用的 DC 小島：**同一個語音頻道 = 同一座公共島，沒上線頻道時就在自己的島上裝飾**。
2D 點陣風、FFXIV 風 HUD（僅風格參考，不含 SE 素材；素材全是自產 placeholder，零授權風險）。

**正式站（跑在 Cloudflare，24/7、不依賴任何人的電腦）：**
`https://dcisland.less78518.workers.dev`

## 里程碑

- ✅ **M0 可玩**：6 地形（manifest 制）、走路/跑/跳、裝飾模式、造型系統、FF14 致敬小動物、武器戰鬥＋動物 CD 重生
- ✅ **M1 Discord Activity**：真 DC 身分（名牌顯示 DC 名稱）、測試員可啟動
- ✅ **M2 多人同步**：同語音頻道＝同一座島，玩家/造型/動作/家具同步；每位玩家可各自切換地形，只有同地形的人看得到彼此；**已部署到 Cloudflare**（Durable Object，一座島＝一個實例）
- ⬜ M3 個人島列表/參觀、鎖島、家具/造型申請審核 bot
- ⬜ M4 公測

## 架構

```
client/          純前端（無 build step），manifest 制素材
  js/main.js     遊戲本體（引擎/戰鬥/動物/裝飾/造型）
  js/discord.js  Discord Embedded App SDK 接線（本機/mock/真 DC）
  js/net.js      多人同步（WebSocket，位置/造型/動作）
  vendor/        SDK 單檔 bundle（自託管，不依賴外部 CDN）
worker/          Cloudflare Worker：靜態檔 + /api/token + /ws（Durable Object 當島）
  wrangler.toml  部署設定（[assets] + Durable Object 綁定）
tools/
  dev_server.py  本機伺服器：靜態 + /api/token + /ws（純 Python，不需 Node）
  gen_assets.py  素材產生器（placeholder；改素材先改這裡再重跑）
  dev_config.example.json  憑證範本
docs/            規格、授權記錄、Discord 串接、Cloudflare 部署
```

## 維護者流程（三人都一樣）

```bash
git pull
# 改 client/ 或 worker/ 的程式
git commit -am "說明改了什麼"
git push              # → GitHub Actions 自動部署（約 1 分鐘）
```

- 部署結果：https://github.com/minutemoneytw/dcisland/actions
- 設定細節：`docs/cloudflare-deploy.md`
- 只改 `docs/` 不會觸發部署

## 本機開發

```bash
python tools/dev_server.py       # 需要 Python 3；不用 Node
# 開 http://localhost:8787
# 多人測試：開兩個分頁，同一 ?room=xxx 就會看到彼此
# 模擬 DC 身分： http://localhost:8787/index.html?mock=1
```

要驗證真正的 Discord 串接，再把本機服務用臨時隧道對外（詳見 `docs/m1-discord-setup.md`），
**測試完務必把 Portal 的根對應改回 `dcisland.less78518.workers.dev`**，否則大家會白屏。

## 操作

`WASD/方向鍵` 走 · `Shift` 跑 · `Space` 跳 · **左鍵（或 `F`）攻擊，長按自動連續揮擊**（點石頭自動用鎬子、點樹木/蘑菇自動用斧頭） · 左/右鍵點 NPC 聊天、點椅子/沙發/床（或在旁邊按 `F`）坐下/睡覺，再點一次、按 `F` 或移動就起身 · `E` 裝飾模式（可邊走邊擺、可穿過擺飾；左鍵放置、右鍵拿取；按「完成」才保存、「取消變動」可還原，`E` 或 `Esc` 離開時有未保存的變動會先問；「清空」需要管理員）· 頂部 chip 切地形 · `造型` 換膚色/髮型/上衣/武器。

## 內容擴充（都不用改程式）

| 想加 | 做什麼 |
|---|---|
| 地形 | `client/assets/terrain/<id>/` 加資料夾 + `terrain.json`，並在 `main.js` 的 `TERRAIN_IDS` 登記 |
| 家具 | `client/assets/furniture/furniture.json` 加條目 + png |
| 動物 | `client/assets/animals/animals.json` 加條目 + png，並在各地形 `terrain.json` 的 `animals` 指定；會游泳/兩棲/會飛的加 `"swim": true`（才能逃到海上） |
| 造型 | `client/assets/avatar/avatar.json`（＋對應 png） |
| NPC 台詞 | `client/assets/npcs/npcs.json` 的 `lines` |
| 可破壞物件／採集工具／掉落物 | `client/assets/tools/tools.json`（key＝地形 deco 的圖檔名；掉落物目前為空） |

## 機密與安全

- `tools/dev_config.json`（含 Discord client secret）**永不進版控**（`.gitignore` 已排除，repo 只有範本）
- 雲端 secret 存在 Cloudflare Worker secrets（`wrangler secret put`），前端拿不到
- 只有 App 擁有者與 Discord 開發團隊成員能啟動未發布的 Activity（見 `docs/m1-discord-setup.md`）
