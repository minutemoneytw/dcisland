# tools/hand/ ——使用者手改過的圖層（產生器直接讀，不再用規則畫）

- `ninja_top_human.png`：人類忍者服上衣（`human2_n_top.png` 的來源）。2026-11-26 使用者用圖片軟體手改過（小幅修改：走路格的幾個像素與側面步 B 的幾格）；`tools/gen_ninja.py` 的 `ninja_sheets()` 偵測到這個檔案就用它當 `top` 層（矮人、巨人的上衣由它縮放而來）。
- **格式**：8 位元 **RGBA** PNG（不要存成索引色／調色盤 PNG；`tools/` 的讀圖工具只讀 RGBA／RGB，圖片軟體存檔時選「32 位元 PNG／RGBA」）。
- 之後想再改這張圖，直接改這個檔案後重跑 `python tools/gen_assets.py`；`client/assets/avatar/human2_n_top.png` 是輸出，不要直接改它（會被重產覆蓋）。
