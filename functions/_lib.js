// Shared helpers for Ta-Done's backend (Cloudflare Pages Functions + D1).
// Env: DB (D1 binding), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL, optional SESSION_SECRET
const sessKey = env => env.SESSION_SECRET || env.GOOGLE_CLIENT_SECRET;

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export const fail = (code, message, status = 400) => json({ error: { code, message } }, status);

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw Object.assign(new Error('Database is not connected. Add a D1 binding named DB.'), { code: 'no_database' });
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tombs (id TEXT PRIMARY KEY, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL)'),
  ]);
  schemaReady = true;
}
export async function kvGet(env, k) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? JSON.parse(r.v) : null; }
export async function kvSet(env, k, v) { await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run(); }
export async function kvDel(env, k) { await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(k).run(); }

// ---------- Signed session cookie ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
export const COOKIE = 'tadone_s';
export async function makeSession(env, email) {
  const exp = Date.now() + 180 * 864e5, body = b64u(enc.encode(JSON.stringify({ e: email, x: exp })));
  return body + '.' + await hmac(sessKey(env), body);
}
export function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
export async function sessionEmail(req, env) {
  const v = cookie(req, COOKIE); if (!v || !sessKey(env)) return null;
  const [body, sig] = v.split('.'); if (!body || !sig) return null;
  if (await hmac(sessKey(env), body) !== sig) return null;
  try {
    const d = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (!d.x || d.x < Date.now()) return null;
    return d.e || 'owner';
  } catch (e) { return null; }
}
export const sameEmail = (a, b) => !!a && !!b && String(b).split(',').map(x => x.trim().toLowerCase()).includes(String(a).trim().toLowerCase());
export const setCookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---------- Google access token (refreshed from the stored refresh token) ----------
export async function googleToken(env, force) {
  const tok = await kvGet(env, 'google');
  if (!tok || !tok.refresh_token) throw Object.assign(new Error('Google isn\'t connected yet.'), { code: 'server_not_connected' });
  if (!force && tok.access_token && tok.exp > Date.now() + 60000) return tok.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (d.error === 'invalid_grant') throw Object.assign(new Error('Google sign-in expired.'), { code: 'needs_reauth' });
    throw Object.assign(new Error('Google didn\'t respond.'), { code: 'server_unavailable' });
  }
  tok.access_token = d.access_token; tok.exp = Date.now() + (d.expires_in || 3600) * 1000;
  if (d.scope) tok.scope = d.scope;
  await kvSet(env, 'google', tok);
  return tok.access_token;
}

// Call a Google API with automatic token refresh and readable error codes.
export async function g(env, url, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await googleToken(env, attempt > 0);
    const headers = Object.assign({ authorization: 'Bearer ' + token }, opts.headers || {});
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && typeof body !== 'string') { body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const r = await fetch(url, { method: opts.method || 'GET', headers, body });
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 204) return {};
    const text = await r.text(); let d = {}; try { d = text ? JSON.parse(text) : {}; } catch (e) { d = { raw: text }; }
    if (r.ok) return d;
    const msg = (d.error && (d.error.message || d.error)) || r.statusText;
    if (r.status === 401) throw Object.assign(new Error('Google sign-in expired.'), { code: 'needs_reauth' });
    if (r.status === 403 && /insufficient|scope|permission/i.test(String(msg))) throw Object.assign(new Error(String(msg)), { code: 'needs_reauth' });
    if (r.status === 404) throw Object.assign(new Error(String(msg)), { code: 'not_found', status: 404 });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(String(msg)), { code: 'server_unavailable' });
    throw Object.assign(new Error(String(msg)), { code: 'tool_error' });
  }
}

// ---------- Password (the only way in) ----------
// The password's PBKDF2-SHA256 hash lives only in the TADONE_PASSWORD_HASH secret ("salt$hash", base64), never in this code.
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function checkPassword(env, pw) {
  if (!env.TADONE_PASSWORD_HASH) return false;
  const [salt, want] = String(env.TADONE_PASSWORD_HASH).trim().split('$');
  if (!salt || !want) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
  const w = fromB64(want); if (w.length !== bits.length) return false;
  let diff = 0; for (let i = 0; i < w.length; i++) diff |= w[i] ^ bits[i];
  return diff === 0;
}
