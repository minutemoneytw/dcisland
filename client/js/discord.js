// DC島 — Discord Embedded App SDK 接線（M1）
// 三模式：本機 / ?mock=1 / 真Discord(iframe 有 frame_id)
// SDK 優先載入自家託管的單檔 bundle（client/vendor/），失敗才退回 esm.sh（需 Portal 的 /sdk 對應）。

export async function hookDiscord() {
  const S = window.S;
  if (!S) return 'no-state';
  const q = new URLSearchParams(location.search);
  const beacon = (tag, extra) => {
    try {
      fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, extra: extra ?? null }) });
    } catch { /* 信標失敗不影響本體 */ }
  };

  // ---- mock：僅本機測 DC 分支 ----
  if (q.get('mock') === '1') {
    applyUser({ name: '撲馬（Mock）', id: 'mock-0000', discord: true });
    return 'mock';
  }

  // ---- 真的 Discord ----
  if (!q.has('frame_id')) return 'local';
  beacon('dc-enter', '有 frame_id');
  try {
    // 載入 SDK：優先自家託管的單檔 bundle（免外部 CDN、免 URL Mapping），
    // 失敗才退回 esm.sh（需要 Portal 的 /sdk -> esm.sh 對應）
    let DiscordSDK;
    try {
      ({ DiscordSDK } = await import('/vendor/embedded-app-sdk-2.5.0.bundle.mjs'));
      beacon('sdk-imported', 'vendor');
    } catch (e1) {
      beacon('sdk-vendor-failed', String(e1 && e1.message || e1));
      ({ DiscordSDK } = await import('/sdk/@discord/embedded-app-sdk@2.5.0/es2022/embedded-app-sdk.bundle.mjs'));
      beacon('sdk-imported', 'esm.sh');
    }
    const clientId = q.get('client_id') || (await (await fetch('/api/config')).json()).client_id;
    if (!clientId) throw new Error('缺少 client_id');
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    beacon('sdk-ready');

    // PKCE 授權（SDK 在隱藏 iframe 中完成，需 portal 設 Redirects）
    // 只請求 identify：我們只用它讀顯示名稱（伺服器端拿 token 問 /users/@me）。
    // 多加 guilds / applications.commands 會讓每次啟動都跳「新增至伺服器」的授權畫面。
    // prompt: 'none'：已授權過就不跳畫面，所以重新授權（憑證過期）也是無感的
    const login = async () => {
      const { code } = await sdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        prompt: 'none',
        scope: ['identify'],
      });
      if (!code) throw new Error('authorize 未回 code');
      const tok = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, client_id: clientId }),
      }).then(r => r.json());
      if (!tok.access_token) throw new Error('token 兌換失敗: ' + JSON.stringify(tok).slice(0, 180));
      // 名字由 /api/token 一併回傳（伺服器端已用 token 問過 Discord），
      // 沙盒內不用再打外部網址，免 URL Mapping
      if (!tok.user) throw new Error('伺服器未回傳使用者資料');
      return tok;
    };
    const tok = await login();
    beacon('token-ok');
    await sdk.commands.authenticate({ access_token: tok.access_token, client_id: clientId });
    beacon('after-authenticate');
    applyUser({ name: tok.user.name, id: tok.user.id, discord: true, sdk, session: tok.session });
    // 憑證（12 小時）過期後重連，伺服器的 me 會回 auth:false → net.js 呼叫這裡重新授權拿新憑證再送 hello。
    // 同一時間只跑一次、失敗後 60 秒內不重試（避免伺服器一直拒絕時無限重試）
    let reauthing = false, reauthAt = 0;
    S.reauth = async () => {
      if (reauthing || Date.now() - reauthAt < 60000) return;
      reauthing = true; reauthAt = Date.now();
      try {
        const t = await login();
        S.session = t.session || null;
        beacon('reauth-ok');
        S.net?.hello?.();
      } catch (e) {
        beacon('reauth-fail', String(e && e.message || e));
        window.toast?.('Discord 身分已過期，重新開啟活動即可恢復', 4000);
      } finally { reauthing = false; }
    };
    return 'discord';
  } catch (e) {
    beacon('dc-fail', String(e && e.stack || e.message || e));
    console.warn('Discord init failed:', e);
    window.toast?.('Discord 連線失敗，先進入本機模式');
    return 'discord-failed:' + (e.message || e);
  }
}

function applyUser(u) {
  const S = window.S;
  if (!S) return;
  S.discordUser = u;
  S.session = u.session || null;      // 伺服器簽發的身分憑證，連線時用 hello 出示
  S.net?.hello?.();                   // 連線比 Discord 授權早完成時，補送一次
  const me = S.players && S.players[0];
  if (me) me.name = u.name || '未命名';
  window.toast?.(`🏠 ${u.name} 上島囉（Discord 身分）`, 3200);
}
