# render-times.jsonl 格式（media 1.51.0）

路徑：`/home/box/shared-docs/logs/render-times.jsonl`（環境變數 `RENDERTIME_LOG` 可改；測試用）。
一行一個 JSON 物件（UTF-8，`ensure_ascii=False`），一個指令跑完寫一行。超過 5 MB 時改名成 `render-times.jsonl.1`（只留一份舊檔），report 要兩份都讀。
壞掉的行（JSON 解不開、缺欄位）要略過，不能讓 report 失敗。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `v` | int | 格式版本，現在是 1 |
| `ts` | str | 開始時間，台北時間 ISO 8601，例 `2026-10-27T20:31:05+08:00` |
| `end_ts` | str | 結束時間，同格式 |
| `command` | str | 指令，例 `longvideo build`、`s2 build`、`fashuo build`、`broll render`、`tts synthesize`、`charts` |
| `stage` | str | 這行的階段。整個指令是 `total`；longvideo 另外把各步驟放在 `stages` |
| `stages` | object | `{步驟名: 秒數(float)}`，可為 `{}`。longvideo 的步驟名來自 build.log 的 step=（tts、render、concat…） |
| `cwd` | str | 執行時的資料夾 |
| `project` | str \| null | 專案/集數資料夾（猜得到才填） |
| `series` | str \| null | 系列（猜得到才填） |
| `user` | str \| null | 環境變數 USER |
| `output` | str \| null | 輸出檔路徑 |
| `output_seconds` | float \| null | 輸出影片/音檔長度（秒），ffprobe 讀不到就是 null |
| `wall_seconds` | float | 實際花的秒數 |
| `ok` | bool | 指令有沒有成功（exit code 0 且沒丟例外） |
| `exit_code` | int \| null | 回傳碼 |
| `load_start` | float | 開始時 1 分鐘 loadavg |
| `load_end` | float | 結束時 1 分鐘 loadavg |
| `load_peak` | float | 執行中取樣到的最高 1 分鐘 loadavg（約每 10 秒取一次；短指令等於 max(start,end)） |
| `nproc` | int | CPU 核心數 |
| `concurrent` | object | 開始時其他行程數：`{"ffmpeg": int, "chromium": int, "hyperframes": int}`（不含自己） |
| `concurrent_jobs` | int | 開始時其他還在跑、也有記錄的重工作數（`longvideo build` 等），report 用它算重疊 |
| `pid` | int | 行程編號 |
| `host` | str | 主機名稱 |

report 建議算法（`rendertime report [--days 7] [--log 路徑]`，繁中輸出）：
- 依 `command`（以及 `stages` 裡每個步驟）加總 `wall_seconds`、次數。
- 渲染比 = sum(wall_seconds) / (sum(output_seconds)/60)，只算 `output_seconds` 非 null 且 `ok` 的行，單位「秒／成片分鐘」。
- 尖峰負載 = max(`load_peak`)，並列出 `nproc`。
- 重疊 = `concurrent_jobs > 0` 的行數與比例；也可依時間區間 [ts, end_ts] 互相比對。
- 只用標準函式庫，不連網。
