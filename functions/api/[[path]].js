// Ta-Done! API: sign-in, data sync, and Google + weather tools.
import { json, fail, ensureSchema, kvGet, kvSet, kvDel, COOKIE, makeSession, sessionEmail, sameEmail, setCookie, cookie, g, checkPassword } from '../_lib.js';
import { runTool } from '../_tools.js';

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');
const APP_PATH = '/ta-done/';

export async function onRequest(ctx) {
  const { request: req, env } = ctx;
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  try {
    await ensureSchema(env);
    if (parts[0] === 'auth') return await auth(parts[1], req, env, url);
    const email = await sessionEmail(req, env);
    if (!email) return fail('signed_out', 'Sign in to continue.', 401);
    if (parts[0] === 'db') return await dbApi(parts.slice(1), req, env, url);
    if (parts[0] === 'blob') return await blobApi(parts[1], req, env);
    if (parts[0] === 'tool' && req.method === 'POST') {
      const { server, tool, input } = await req.json();
      const payload = await runTool(env, server, tool, input || {});
      return json({ payload });
    }
    if (parts[0] === 'status') {
      const tok = await kvGet(env, 'google');
      return json({ email: tok && tok.email || '', google: !!(tok && tok.refresh_token), scope: tok && tok.scope || '', links: (await kvGet(env, 'links')) || {} });
    }
    return fail('not_found', 'Unknown endpoint', 404);
  } catch (e) {
    const code = e.code || 'internal';
    const status = code === 'signed_out' ? 401 : code === 'no_database' ? 500 : code === 'server_unavailable' ? 503 : 400;
    return fail(code, e.message || String(e), status);
  }
}

// ---------- Google sign-in ----------
async function auth(step, req, env, url) {
  const origin = url.origin, redirect = origin + '/api/auth/callback';
  if (step === 'password' && req.method === 'POST') {
    const lock = (await kvGet(env, 'pwfail')) || { n: 0, at: 0 };
    if (lock.n >= 8 && Date.now() - lock.at < 15 * 60000) return fail('locked', 'Too many tries. Wait 15 minutes and try again.', 429);
    const body = await req.json().catch(() => ({}));
    if (!(await checkPassword(env, body.password))) {
      await kvSet(env, 'pwfail', { n: (Date.now() - lock.at < 15 * 60000 ? lock.n : 0) + 1, at: Date.now() });
      return fail('wrong_password', 'That\'s not it. Try again.', 401);
    }
    await kvSet(env, 'pwfail', { n: 0, at: 0 });
    return json({ ok: true }, 200, { 'set-cookie': setCookie(COOKIE, await makeSession(env, 'owner'), 180 * 86400) });
  }
  if (step === 'login' || step === 'google') {
    if (!(await sessionEmail(req, env))) return new Response(null, { status: 302, headers: { location: APP_PATH } });
    if (!env.GOOGLE_CLIENT_ID) return new Response('Google sign-in is not set up yet (GOOGLE_CLIENT_ID missing).', { status: 500 });
    const state = crypto.randomUUID();
    const tok = await kvGet(env, 'google');
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
      access_type: 'offline', include_granted_scopes: 'true', state,
      // Ask for consent (which returns a refresh token) the first time, or when asked to reconnect.
      prompt: (!tok || !tok.refresh_token || url.searchParams.get('reconnect')) ? 'consent' : 'select_account',
    });
    if (env.ALLOWED_EMAIL) p.set('login_hint', String(env.ALLOWED_EMAIL).split(',')[0].trim());
    return new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + p, 'set-cookie': setCookie('tadone_st', state, 600) } });
  }
  if (step === 'callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code || !state || state !== cookie(req, 'tadone_st')) return page('Sign-in didn\'t finish. <a href="' + APP_PATH + '">Try again</a>.', 400);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return page('Google didn\'t accept the sign-in. <a href="' + APP_PATH + '">Try again</a>.', 400);
    const who = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + d.access_token } })).json().catch(() => ({}));
    if (!(await sessionEmail(req, env))) return page('Unlock Ta-Done! with your password first. <a href="' + APP_PATH + '">Open Ta-Done!</a>', 401);
    if (!who.email || !who.email_verified || (env.ALLOWED_EMAIL && !sameEmail(who.email, env.ALLOWED_EMAIL))) return page('This Ta-Done! is private. ' + (who.email ? 'The account ' + escapeHtml(who.email) + ' isn\'t allowed.' : '') + ' <a href="/">Back to the website</a>.', 403);
    const old = (await kvGet(env, 'google')) || {};
    await kvSet(env, 'google', { refresh_token: d.refresh_token || old.refresh_token, access_token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, scope: d.scope || old.scope, email: who.email, name: who.name || '', picture: who.picture || '' });
    const h = new Headers({ location: APP_PATH + '#google-connected' });
    h.append('set-cookie', setCookie('tadone_st', '', 0));
    return new Response(null, { status: 302, headers: h });
  }
  if (step === 'me') {
    const email = await sessionEmail(req, env);
    if (!email) return fail('signed_out', 'Sign in to continue.', 401);
    const tok = (await kvGet(env, 'google')) || {};
    return json({ email: tok.email || '', name: tok.name || '', picture: tok.picture || '', google: !!tok.refresh_token, scope: tok.scope || '' });
  }
  if (step === 'logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': setCookie(COOKIE, '', 0) } });
  return fail('not_found', 'Unknown auth step', 404);
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (msg, status) => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Ta-Done!</title><body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto;color:#142033">${msg}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// ---------- Data (one private collection of documents) ----------
const DOC_ID = /^[A-Za-z0-9_\-.:]{1,120}$/;
async function dbApi(parts, req, env, url) {
  const DB = env.DB;
  if (parts[0] === 'snap' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const now = Date.now();
    const docs = await DB.prepare('SELECT id, data, updated FROM docs WHERE updated > ?').bind(since).all();
    const ids = await DB.prepare('SELECT id FROM docs').all();
    const tombs = since ? await DB.prepare('SELECT id FROM tombs WHERE updated > ?').bind(since).all() : { results: [] };
    const max = docs.results.reduce((m, d) => Math.max(m, d.updated), since);
    return json({ now, cursor: Math.max(max, since), docs: docs.results.map(d => ({ id: d.id, updated: d.updated, data: JSON.parse(d.data) })), ids: ids.results.map(x => x.id), deleted: tombs.results.map(x => x.id) });
  }
  if (parts[0] === 'doc' && DOC_ID.test(parts[1] || '')) {
    const id = parts[1];
    if (req.method === 'PUT') {
      const body = await req.json();
      if (!body || typeof body.data !== 'object' || body.data === null) return fail('invalid', 'Missing data');
      const text = JSON.stringify(body.data);
      if (text.length > 1900000) return fail('quota_exceeded', 'This record is too large.', 413);
      const prev = await DB.prepare('SELECT updated FROM docs WHERE id = ?').bind(id).first();
      const updated = Math.max(Date.now(), prev ? prev.updated + 1 : 0);
      await DB.batch([
        DB.prepare('INSERT INTO docs (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(id, text, updated),
        DB.prepare('DELETE FROM tombs WHERE id = ?').bind(id),
      ]);
      return json({ id, updated });
    }
    if (req.method === 'DELETE') {
      const updated = Date.now();
      await DB.batch([
        DB.prepare('DELETE FROM docs WHERE id = ?').bind(id),
        DB.prepare('INSERT INTO tombs (id, updated) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET updated = excluded.updated').bind(id, updated),
      ]);
      return json({ id, updated });
    }
  }
  if (parts[0] === 'import' && req.method === 'POST') {
    const body = await req.json();
    if (!body || body.tadoneImport !== 1 || !body.docs || !body.docs.state) return fail('invalid', 'This isn\'t a Ta-Done! import file.');
    const has = await DB.prepare("SELECT id FROM docs WHERE id = 'state'").first();
    if (has && url.searchParams.get('force') !== '1') return fail('exists', 'There is already data here.', 409);
    const now = Date.now(), stmts = [];
    for (const [id, data] of Object.entries(body.docs)) {
      if (!DOC_ID.test(id) || !data || typeof data !== 'object') continue;
      stmts.push(DB.prepare('INSERT INTO docs (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(id, JSON.stringify(data), now));
    }
    for (const [id, b] of Object.entries(body.blobs || {})) {
      if (!/^[a-f0-9]{8,64}$/.test(id) || !b || !b.b64) continue;
      const bin = Uint8Array.from(atob(b.b64), c => c.charCodeAt(0));
      stmts.push(DB.prepare('INSERT INTO blobs (id, type, data, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data').bind(id, b.type || 'image/png', bin, now));
    }
    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true, count: stmts.length });
  }
  return fail('not_found', 'Unknown data endpoint', 404);
}

// ---------- Images (profile photo, logo) ----------
async function blobApi(id, req, env) {
  if (req.method === 'POST' && !id) {
    const type = (req.headers.get('content-type') || 'image/png').split(';')[0];
    if (!/^image\//.test(type)) return fail('invalid', 'Images only');
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length > 1500000) return fail('quota_exceeded', 'Image is too large.', 413);
    const nid = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare('INSERT INTO blobs (id, type, data, created) VALUES (?, ?, ?, ?)').bind(nid, type, buf, Date.now()).run();
    return json({ id: nid });
  }
  if (req.method === 'DELETE' && id) { await env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(id).run(); return json({ ok: true }); }
  return fail('not_found', 'Unknown image endpoint', 404);
}
