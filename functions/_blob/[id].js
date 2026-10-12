// Serves Ta-Done! images (profile photo, logo) to the signed-in owner only.
import { ensureSchema, sessionEmail } from '../_lib.js';

export async function onRequestGet({ request, env, params }) {
  if (!(await sessionEmail(request, env))) return new Response('Not found', { status: 404 });
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT type, data FROM blobs WHERE id = ?').bind(String(params.id)).first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(row.data), { headers: { 'content-type': row.type, 'cache-control': 'private, max-age=31536000, immutable' } });
}
