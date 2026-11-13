'use strict';
// Explicitly enabled, read-only audit of the *Main Branch* Meta Page credential.
// Do not log access tokens, app secrets, Graph error bodies, or customer data.
// This has no dependency on /data, booking, Cavite, or customer reply controls.
async function auditMainToken(env, log, fetcher = fetch) {
  const token = String(env.PAGE_ACCESS_TOKEN || '');
  const expected = String(env.PAGE_ID || '').trim();
  const appId = String(env.APP_ID || '').trim();
  const appSecret = String(env.APP_SECRET || '');
  if (!token || !expected) {
    log.warn('MAIN_TOKEN_AUDIT=blocked missing page id or token');
    return;
  }
  const numeric = (v) => /^\d{5,25}$/.test(String(v || '')) ? String(v) : 'unknown';
  const version = /^v\d+\.\d+$/.test(String(env.GRAPH_API_VERSION || '')) ? env.GRAPH_API_VERSION : 'v26.0';
  const base = 'https://graph.facebook.com/' + version;
  const read = async (url, headers) => {
    try {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(8000) });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    } catch {
      return { status: 'network', body: {} };
    }
  };
  let debug = { status: 'skipped', body: {} };
  if (appId && appSecret) {
    const u = new URL(base + '/debug_token');
    u.searchParams.set('input_token', token);
    u.searchParams.set('access_token', appId + '|' + appSecret);
    debug = await read(u);
  }
  const meta = debug.body?.data || {};
  const type = ['PAGE', 'USER', 'APP', 'SYSTEM_USER'].includes(meta.type) ? meta.type : 'unknown';
  const meUrl = new URL(base + '/me');
  meUrl.searchParams.set('fields', 'id,name,category');
  const me = await read(meUrl, { Authorization: 'Bearer ' + token });
  const pageId = type === 'PAGE' || (me.status === 200 && Boolean(me.body?.category))
    ? numeric(me.body?.id || meta.profile_id) : 'unknown';
  const nameMatchesMain = typeof me.body?.name === 'string'
    && /^jmag['’]?s appliances$/i.test(me.body.name.trim());
  const conversationUrl = new URL(base + '/' + encodeURIComponent(expected) + '/conversations');
  conversationUrl.searchParams.set('fields', 'id');
  conversationUrl.searchParams.set('limit', '1');
  const conversation = await read(conversationUrl, { Authorization: 'Bearer ' + token });
  // Read-only managed Page ID verification. Never request or log Page tokens.
  const accountsUrl = new URL(base + '/me/accounts');
  accountsUrl.searchParams.set('fields', 'id,name');
  accountsUrl.searchParams.set('limit', '100');
  const accounts = await read(accountsUrl, { Authorization: 'Bearer ' + token });
  const managedMainPages = (Array.isArray(accounts.body?.data) ? accounts.body.data : [])
    .filter((p) => typeof p?.name === 'string' && /^jmag['’]?s appliances$/i.test(p.name.trim()));
  const managedMainId = managedMainPages.length === 1 ? numeric(managedMainPages[0].id) : 'unknown';
  const scopes = Array.isArray(meta.scopes) ? meta.scopes : [];
  const authId = numeric(meta.app_id);
  const appMatch = authId !== 'unknown' ? String(authId === appId) : 'unknown';
  const pageMatch = pageId !== 'unknown' ? String(pageId === expected) : 'unknown';
  const msg = [
    'MAIN_TOKEN_AUDIT',
    'token_valid=' + (meta.is_valid === true ? 'true' : meta.is_valid === false ? 'false' : 'unknown'),
    'type=' + type,
    'debug_http=' + debug.status,
    'app_id=' + authId,
    'app_match=' + appMatch,
    'page_id=' + pageId,
    'expected_page_id=' + numeric(expected),
    'page_match=' + pageMatch,
    'main_name_match=' + nameMatchesMain,
    'managed_pages_http=' + accounts.status,
    'managed_main_page_id=' + managedMainId,
    'managed_main_matches_expected=' + (managedMainId !== 'unknown' ? String(managedMainId === expected) : 'unknown'),
    'pages_show_list=' + (scopes.includes('pages_show_list') ? 'present' : 'unconfirmed'),
    'pages_messaging=' + (scopes.includes('pages_messaging') ? 'present' : 'unconfirmed'),
    'pages_manage_metadata=' + (scopes.includes('pages_manage_metadata') ? 'present' : 'unconfirmed'),
    'me_http=' + me.status,
    'conversations_http=' + conversation.status,
  ].join(' ');
  log.info(msg);
}
module.exports = { auditMainToken };
