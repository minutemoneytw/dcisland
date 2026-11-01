// DC島 — Discord Embedded App SDK 接線（M1）
// 三模式：本機 / ?mock=1 / 真Discord(iframe 有 frame_id)
// SDK 以 esm.sh 免 build 匯入；正式部署時改為自家 bundle 或 niu 移到 server。

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
    // SDK 走 Portal 的 URL Mapping（/sdk -> esm.sh）載「單檔 bundle 版」，
    // 避開活動沙盒對外部資源的 CSP 封鎖（blocked:csp）
    const SDK_BODY = '/@discord/embedded-app-sdk@2.5.0/es2022/embedded-app-sdk.bundle.mjs';
    const { DiscordSDK } = await import('/sdk' + SDK_BODY);
    beacon('sdk-imported');
    const clientId = q.get('client_id') || (await (await fetch('/api/config')).json()).client_id;
    if (!clientId) throw new Error('缺少 client_id');
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    beacon('sdk-ready');

    // PKCE 授權（SDK 在隱藏 iframe 中完成，需 portal 設 Redirects）
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      prompt: 'none',
      scope: ['identify', 'guilds', 'applications.commands'],
    });
    if (!code) throw new Error('authorize 未回 code');
    beacon('authorize-ok', 'code=' + code.slice(0, 8) + '…');
    const tok = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, client_id: clientId }),
    }).then(r => r.json());
    if (!tok.access_token) throw new Error('token 兌換失敗: ' + JSON.stringify(tok).slice(0, 180));
    beacon('token-ok');
    await sdk.commands.authenticate({ access_token: tok.access_token, client_id: clientId });
    beacon('after-authenticate');
    // 名字由 /api/token 一併回傳（伺服器端已用 token 問過 Discord），
    // 沙盒內不用再打外部網址，免 URL Mapping
    if (!tok.user) throw new Error('伺服器未回傳使用者資料');
    applyUser({ name: tok.user.name, id: tok.user.id, discord: true, sdk });
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
  const me = S.players && S.players[0];
  if (me) me.name = u.name || '未命名';
  window.toast?.(`🏠 ${u.name} 上島囉（Discord 身分）`, 3200);
}
