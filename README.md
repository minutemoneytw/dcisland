# DC島（Discord Island）

FF14 玩家群用的 Discord Activity 小遊戲：**同一個語音頻道＝同一座公共島**，大家在 2D 點陣小島上散步、裝飾、釣魚、打島主、玩桌遊。
HUD 是 FFXIV 風格（僅風格參考，**不使用任何 SE／FFXIV 的素材、圖示、字體或商標**）。

**正式站（Cloudflare，24/7、不依賴任何人的電腦）：** `https://dcisland.less78518.workers.dev`

> 給維護者與 AI agent：協作規則看 [`AGENTS.md`](AGENTS.md)，各功能的實作細節、地雷與使用者做過的決定看 [`docs/notes.md`](docs/notes.md)。

## 目錄

- [目前有什麼](#目前有什麼)
- [里程碑](#里程碑)
- [架構](#架構)
- [本機開發](#本機開發)
- [部署（維護者流程）](#部署維護者流程)
- [操作](#操作)
- [內容擴充](#內容擴充大多不用改程式)
- [島主](#島主)
- [素材與授權](#素材與授權)
- [機密與安全](#機密與安全)
- [文件索引](#文件索引)

## 目前有什麼

- **8 座島**（頂部切換，每個人各自在哪座島，只看得到同島的人）：

  | 島 | 島主 | 野外動物 |
  |---|---|---|
  | 草島 | 黃金肥龍 | 波波羊、圓喙鳥、大肚蛙、咕咕雞、史萊姆、哥布林 |
  | 沙灘島 | — | 圓喙鳥、大肚蛙、跳跳兔、史萊姆、飛龍 |
  | 雪島 | — | 波波羊、圓喙鳥、跳跳兔、史萊姆、殭屍 |
  | 夜光島 | 笨蛋蛇女 | 大肚蛙、波波羊、史萊姆、飛龍、殭屍 |
  | 森林島 | — | 波波羊、圓喙鳥、咕咕雞、史萊姆、哥布林 |
  | 熔岩島 | 蓋老師 | 大肚蛙、圓喙鳥、史萊姆、飛龍 |
  | 機械島 | 壓力山大 | 跳跳兔、史萊姆、殭屍 |
  | 和平島 | — | （室內房間，**沒有任何敵對單位**；有遊戲桌與室內釣魚池） |

  飛龍、哥布林、殭屍是**反擊型野怪**（被打會反擊、附近同種群起），其餘被打只會逃。野外動物是各自畫面的模擬，刻意不同步。
- **8 個職業**：騎士／戰士（坦克）、白魔法師／賢者（補師）、忍者／龍騎士（近戰輸出）、吟遊詩人／黑魔法師（遠程輸出）。每個職業有固定的 LPC 裝備、唯一的職業武器、`1`／`2` 兩個職業技能與 `R` 職能技能。
- **腳色等級**：打怪、採集、釣魚、玩小遊戲得 XP；升級加血量上限、每 3 級加攻擊。登入 Discord 的人等級跟著帳號（伺服器記帳），訪客只存在這台裝置。
- **島主戰**：四隻島主各有不同攻擊樣式，由伺服器權威同步，會打死人；島主也會升級。見下方[島主](#島主)。
- **釣魚與圖鑑**：每座島 30 種魚（含和平島），有稀有度與大尺寸；極低機率釣上會追殺人的「深海魚人」（和平島釣不到）。
- **合成**：採集素材解鎖進素材圖鑑（不消耗），組合 2～3 種猜配方，可合成素材與家具。
- **稱號**：圖鑑收集、大尺寸、參與擊倒島主等條件解鎖，顯示在名字上方。
- **裝飾**：擺家具、鋪地板（可鋪在水上）、寫看板，所有人都能編輯（清空要管理員）；可坐椅子、睡床。
- **和平島遊戲桌**：抽鬼牌、五子棋（含復盤）、躲彈幕（1～8 人）、UNO（傳統／無限制兩種玩法），牌局由伺服器權威。
- **其他**：營火（範圍內回血，每 3 分鐘換位置）、NPC 與嚮導、玩家列表傳送、空手出拳（純特效）。

## 里程碑

- ✅ **M0 本機可玩 demo**：多地形（manifest 制）、走路／跑／跳、裝飾模式、造型系統、戰鬥與動物
- ✅ **M1 Discord Activity**：真 DC 身分（名牌顯示 DC 名稱）、測試員可啟動
- ✅ **M2 多人同步**：同語音頻道＝同一座島，玩家／造型／動作／家具同步；**已部署到 Cloudflare**（Durable Object，一座島＝一個實例）
- ⬜ M3 個人島列表／參觀、鎖島、家具／造型申請審核 bot
- ⬜ M4 公測

詳細規格見 [`docs/spec.md`](docs/spec.md)。

## 架構

```
client/              純前端（ES module，無 build step），內容由 manifest（assets/**/*.json）驅動
  js/main.js         遊戲本體：世界生成、移動、繪圖、戰鬥、動物、裝飾、造型、職業與技能、UI
  js/net.js          多人同步客戶端（WebSocket）
  js/discord.js      Discord Embedded App SDK 接線（本機／mock／真 DC 三模式）
  vendor/            SDK 單檔 bundle（自託管，不依賴外部 CDN，勿手改）
  assets/            素材與 manifest（多數由 tools/gen_assets.py 產生，部分手寫，見「內容擴充」）
worker/              正式環境伺服器（Cloudflare Worker）
  src/index.js       靜態檔 + /api/token、/api/config、/api/log + /ws
                     → Durable Object Island（一座島一個實例：玩家、家具、島主、牌桌）
                     → Durable Object Registry（全站一個：跟著 Discord 帳號的圖鑑、XP、合成解鎖、擊倒紀錄）
  wrangler.toml      部署設定（[assets] 指向 ../client、DO 綁定）
tools/
  dev_server.py      本機伺服器（純 Python 標準庫，不需 Node）；行為與 Worker 版保持一致
  gen_assets.py      素材的唯一來源（改素材先改這裡再重跑；內容感知寫檔，沒變的檔不會重寫）
  import_external.py 外部逐幀素材（zip 或資料夾）→ 拼成水平 sheet
  dev_config.example.json  本機憑證範本
docs/                規格、實作筆記、Discord 串接、Cloudflare 部署、素材授權
```

同步協定有兩份實作（`worker/src/index.js` 正式、`tools/dev_server.py` 本機），改訊息格式或限制常數時兩邊與 `client/js/net.js` 要一起改。

## 本機開發

```bash
python tools/dev_server.py       # 需要 Python 3；不用 Node。開 http://localhost:8787
```

- 多人測試：開兩個分頁，同一個 `?room=xxx` 就會看到彼此
- 模擬 DC 身分：`http://localhost:8787/index.html?mock=1`
- Windows 若 `python` 指向商店空殼，改用 `py -3`
- 預覽 Worker 版（含 Durable Object，需 Node ≥ 22）：`cd worker && npx wrangler dev --port 8790`
- 重新產生素材：`python tools/gen_assets.py`
- 沒有自動化測試，改完請實際開瀏覽器跑過

要驗證真正的 Discord 串接，把本機服務用臨時隧道對外（見 [`docs/m1-discord-setup.md`](docs/m1-discord-setup.md)）。
**測試完務必把 Portal 的根對應改回 `dcisland.less78518.workers.dev`**，否則大家會白屏。

## 部署（維護者流程）

```bash
git pull
# 改程式，一個 commit 只做一件事
git commit -m "說明改了什麼"
git push              # 推到 main → GitHub Actions 自動部署（約 1 分鐘）
```

- 只有改到 `client/**`、`worker/**` 或 `.github/workflows/deploy.yml` 才會觸發部署；只改 `docs/` 不會
- 部署結果：https://github.com/minutemoneytw/dcisland/actions
- 設定細節：[`docs/cloudflare-deploy.md`](docs/cloudflare-deploy.md)

## 操作

| 操作 | 按鍵／方式 |
|---|---|
| 移動／跳 | `WASD` 或方向鍵／`Space` |
| 跑步 | `Shift` 或右下角圓形按鍵**切換**跑步／步行 |
| 攻擊、採集、互動 | 左鍵或 `F`（長按自動連續揮擊）。點石頭／貝殼自動用鎬子、點樹木／蘑菇自動用斧頭；在 NPC、椅子／床、看板、遊戲桌旁按 `F` 或點它就互動 |
| 技能 | `1`／`2` 職業技能、`R` 職能技能（坦克＝挑釁、補師＝群療、近戰輸出＝破綻、遠程輸出＝降傷）；畫面底部有技能列與冷卻 |
| 換武器 | 左上角武器列：在遊戲畫面上**滾滑鼠滾輪**或直接點，在職業武器／空手／釣竿之間切換 |
| 遠距武器 | 自動瞄準滑鼠指的目標（射程 320px）。法杖、咒杖要**詠唱**（不能移動，移動或目標出射程就中斷）；賢具、豎琴弓不用詠唱，可以邊走邊射 |
| 釣魚 | 換成釣竿，在水邊按 `F` 或點水面拋竿；浮標被拉下水、頭上出現「!」後 2 秒內再按一次拉竿 |
| 坐下／睡覺 | 點椅子／沙發／床（或旁邊按 `F`）；再點一次、按 `F` 或移動就起身 |
| 裝飾模式 | `E`。「擺設」分頁左鍵放、右鍵拿；「地板」分頁長按左鍵鋪、長按右鍵拆。按「完成」才保存、「取消變動」還原；`E`／`Esc` 離開時有未保存的變動會先問 |
| 玩家列表 | `L`（同島的人，點名字傳送過去） |
| 切換島 | 頂部 chip（倒地中、戰鬥中不能換） |
| 遊戲桌（和平島） | 走到桌邊按 `F` 或點桌子，選入座或觀戰；`Esc` 離開 |
| 面板 | 右上：`圖鑑`（魚類圖鑑／素材圖鑑／合成／配方筆記）、`角色`（職業、裝備、外觀、換色、稱號設定）、齒輪選單（操作說明、名牌等級／血量條／經驗條顯示開關） |

規則與數值（石化、命令、血量、技能細節等）見 [`docs/notes.md`](docs/notes.md) 與 [`docs/spec.md`](docs/spec.md) 第 9 節。遊戲內嚮導 NPC 與「操作說明」也有簡易說明（來源是 `client/assets/npcs/npcs.json` 的 `help`，操作方式改了要同步更新）。

## 內容擴充（大多不用改程式）

由產生器管理的 manifest（`mobs.json`、`furniture.json`、`floors.json`、`terrain.json`、`fish.json`、`avatar.json`）要改 `tools/gen_assets.py` 對應的表再重跑，直接改 JSON 會在下次重跑時被蓋掉。標「手寫」的檔案則直接改。

| 想加 | 做什麼 |
|---|---|
| 地形 | `client/assets/terrain/<id>/` 加資料夾＋`terrain.json`（產生器的 `TERRAINS`），並在 `main.js` 的 `TERRAIN_IDS` 登記 |
| 家具 | `furniture.json` 加條目＋圖（產生器的 `FURN_MANIFEST`）；`use: "sit"／"sleep"` 可坐／睡，`text: true` 可寫字 |
| 地板 | `floors.json` 加條目＋16×16 無縫磚（`FLOOR_MANIFEST`）；多格地板加 `w`／`h`，邊長最多 4 |
| 動物／怪物（mobs） | 外部逐幀素材先用 `import_external.py` 拼成 sheet 放進 `client/assets/external/img2pixel/`，再在 `gen_assets.py` 的 `EXTERNAL_BUNDLES` 登記、`MOB_MANIFEST` 加條目、`MOBS_BY_TERRAIN` 指定島與權重。常用欄位：`anim`（含方向網格 `rows`／`rowDir`、`scale`）、`tint`（一張圖做多色系）、`fixed`（每島固定幾隻）、`swim`、`noBounce`、`retaliate`＋`ownerFrac`（反擊型，數值＝島主的 1/N）。**先量大小**：人物畫面上約 46px 高，野外小動物約 20～30px。完整規範見 [`docs/notes.md`](docs/notes.md)「野外動物」與 `client/assets/external/img2pixel/README.md` |
| 人物造型／服裝／武器 | **只用 LPC 素材**（Universal-LPC-Spritesheet-Character-Generator），每個部位一張 832×1344 的 LPC 通用格式 sheet，由 `gen_assets.py` 產生 `avatar.json`（`tops`／`bottoms`／`hats`、`dye` 可換色、`glam` 可當外觀、`unlock` 解鎖條件）。做法見 [`docs/notes.md`](docs/notes.md)「美術：多幀動畫與人物分層」 |
| 職業 | `client/assets/jobs/jobs.json`（手寫）：`role`、職業武器、`gear`、`skills`；技能效果在 `main.js` 的 `JOB_SKILLS`；**兩份伺服器的 `JOB_ROLE` 也要加** |
| NPC／嚮導／操作說明 | `client/assets/npcs/npcs.json`（手寫；`terrains.<地圖>` 各地圖的 NPC，`help` 是說明視窗） |
| 魚 | `gen_assets.py` 的 `FISH_TABLE` 加一列再重跑；稀有度權重、脫鉤率、大尺寸門檻在 `fish_manifest()`。加新島的魚要一併補該島的兩個釣魚稱號 |
| 稱號 | `client/assets/titles/titles.json`（手寫）：`id`、`name`、`desc`、`cond`（`owner`／`dex`／`big`／`titles`）；新的條件類型才要改 `main.js` 的 `titleProgress` |
| 合成素材／配方／合成家具 | `client/assets/craft/craft.json`（手寫）：`materials`、`sources`（掉落）、`recipes`；圖示在 `gen_assets.py` 的 `MATERIAL_ICONS`，合成家具在 `FURN_MANIFEST` 標 `craft=True` |
| 可破壞物件／採集工具 | `client/assets/tools/tools.json`（手寫；key＝地形點綴物的圖檔名） |
| 遊戲桌 | `client/assets/games/games.json`（手寫）＋`gen_assets.py` 的 `TABLES_BY_TERRAIN` 與桌子圖＋兩份伺服器實作該遊戲的狀態機並登記 `TABLE_DEFS` |
| 島主招式設定 | `client/assets/skills/skills.json`（手寫；key＝攻擊樣式）：`name`、`bar`（視窗上方的倒數條）、`say`（放招前要不要講台詞，兩份伺服器也讀） |
| 島主 | 見下方「新增其他島的島主」 |
| 動畫 | 任何單張圖都能換成等寬水平 sheet：在該 manifest 條目加 `anim`（`sheet`／`frames`／`fps`／`keyBg`／`stagger`）；地形磚／點綴物寫在 `terrain.json` 的 `anims` |

## 島主

每座地形最多一隻島主（`terrain.json` 的 `owner`）。四隻都是 HP 200、會升級（等級永不重置，每級血量上限 +25），**約 8 人圍毆才打得死**（帶傷每秒回 18 HP）。被打倒 30 秒後重生；擊倒時 30 秒內打過牠的人算參與（稱號與 XP）。

- **草島＝黃金肥龍**（`atk: "dash"`）：被激怒時 **80% 台詞招式、20% 龍衝**。台詞招式依台詞關鍵字依序放招、沒有預警：月環（環形，貼身或很遠安全）、鋼鐵（周圍圓形＋擊飛）、月華衝（仇恨目標身邊大傷害）、隕石流（每人身上一圈，疊在一起會死）、離子砲（隨機一人，旁邊的人可分攤）。龍衝：瞬移到島緣鎖定攻擊者 → 讀條 2 秒（金色虛線）→ 以 560 px/s 衝過島，撞到的人直接倒地。
- **夜光島＝笨蛋蛇女**（`atk: "gaze"`）：不講台詞，原地開眼讀條 2 秒 → 發射瞬間**臉朝著她的人**（不看距離、全地圖）石化 10 秒（不能動、不能攻擊，每秒扣 1 HP）。**背對她就安全**。
- **熔岩島＝蓋老師**（`atk: "beam"`）：先照順序說一句台詞（共 18 句，照使用者提供的原文）→ 讀條 2 秒，朝攻擊者畫出跟牠一樣寬的帶狀預警 → 發射波動砲，範圍內扣 4 HP。
- **機械島＝壓力山大**（`atk: "command"`）：80% 台詞招式、20% 直接下命令。讀條 2 秒（行人號誌圖示：綠色走路小人＝**行動命令**、紅色站立小人＝**靜止命令**）→ 結束瞬間檢定：行動命令要最近 0.5 秒有移動、靜止命令要最近 0.5 秒完全沒動，**不服從直接倒地**。擊倒牠解鎖稱號《完美》。

共通機制：

- **仇恨追殺**：一被打就鎖定攻擊者，放完招接著以 180 px/s 追殺（走路逃不掉、跑步拉得開），貼身每秒爪擊扣 2；多人時每 5 秒隨機換目標；**30 秒沒人打才脫離**。
- **閒晃**：沒在戰鬥時會在島上散步（路點由伺服器挑），沒人在線時停擺。
- **打島主**：`F`／點擊優先打島主；近戰以武器尖端進牠腳下的判定圈為準（靠近時會畫出判定圈），伺服器驗證距離與冷卻。
- **玩家血量**：上限依職業（坦克 20、補師 10、輸出 8）＋(等級−1)；脫離戰鬥每秒回 1、營火範圍內另外回血；倒地 30 秒後在出生點復活。
- **伺服器權威**：島主狀態、島形、仇恨、招式時序都由伺服器決定並廣播；「自己有沒有被打到」由各客戶端判定（所以攻擊會害死同島的其他人）。島主是「野外動物不同步」原則的明確例外。數值與實作細節見 [`docs/notes.md`](docs/notes.md)「島主與戰鬥」。

### 新增其他島的島主（照範本，4 步）

1. **造型**：外部自製素材用 `python tools/import_external.py <zip 或資料夾> <輸出.png>` 拼成 sheet 放進 `client/assets/external/img2pixel/`，在 `gen_assets.py` 的 `EXTERNAL_BUNDLES` 登記，並在 `MOB_MANIFEST` 加條目：`owner: true`、`big`、`hp`、`atk`（`dash`／`gaze`／`beam`／`command`）、`line`、`anim`（登記步驟見該資料夾的 README）
2. **指定**：`gen_assets.py` 的 `OWNER_BY_TERRAIN` 指定該地形的島主（產生 `terrain.json` 的 `owner`），並在**兩份伺服器的 `OWNER_TERRAINS`** 登記攻擊樣式
3. **台詞與招式**：`skills.json` 設定招式名稱、`bar`、`say`；台詞寫在 `MOB_MANIFEST` 該條目的 `ownerLines`（加 `ownerLinesSeq: true` 改成照順序說）
4. **重跑產生器**——說台詞、預警、攻擊、仇恨追殺、死亡重生、等級等都由共用框架處理（兩份伺服器已就緒）

## 素材與授權

- **人物、服裝、武器**：LPC 素材（Universal-LPC-Spritesheet-Character-Generator，CC-BY-SA 3.0／GPL 3.0／OGA-BY 3.0 等，需標示作者）
- **島主、營火與部分怪物**：使用者自製或提供的素材（img2pixel），以及 OpenGameArt 素材（CC0／CC-BY-SA 等）
- **其餘**（地形、家具、地板、魚、素材圖示、UI 圖示）：`tools/gen_assets.py` 畫的 placeholder
- 每一項的來源與授權逐條記在 [`docs/assets-license.md`](docs/assets-license.md)；**引入外部素材一定要補記錄**

## 機密與安全

- `tools/dev_config.json`（含 Discord client secret）**永不進版控**（`.gitignore` 已排除，repo 只有範本 `dev_config.example.json`）
- 雲端 secret（`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）存在 Cloudflare Worker secrets（`wrangler secret put`），前端拿不到
- 管理員（可清空家具）＝Worker 環境變數 `ADMIN_IDS`
- 只有 App 擁有者與 Discord 開發團隊成員能啟動未發布的 Activity（見 [`docs/m1-discord-setup.md`](docs/m1-discord-setup.md)）

## 文件索引

| 文件 | 內容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 協作規則（給所有維護者與 AI agent） |
| [`docs/notes.md`](docs/notes.md) | 各功能的實作筆記、地雷、使用者做過的決定 |
| [`docs/spec.md`](docs/spec.md) | 產品規格與里程碑 |
| [`docs/dev-setup.md`](docs/dev-setup.md) | 本機開發環境 |
| [`docs/m1-discord-setup.md`](docs/m1-discord-setup.md) | Discord Application 設定與隧道測試 |
| [`docs/cloudflare-deploy.md`](docs/cloudflare-deploy.md) | Cloudflare 部署設定 |
| [`docs/assets-license.md`](docs/assets-license.md) | 素材授權記錄 |
