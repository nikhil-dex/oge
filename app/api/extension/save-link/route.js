import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { normalizeSavedLink } from '../../../../lib/saved-links.js';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Vary': 'Origin' } });
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' } });
}
export async function POST(request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) return json({ error: 'A valid extension token is required.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 24 * 1024)); }
  catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
  const normalized = normalizeSavedLink(data);
  if (normalized.error) return json({ error: normalized.error }, 400);
  try {
    const db = await getDatabase();
    const user = await db.collection('users').findOne(
      { extensionTokenHash: hashExtensionToken(token), extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { googleSub: 1 } },
    );
    if (!user?.googleSub) return json({ error: 'This extension token has expired or been revoked. Generate a new one in OgeNotes settings.' }, 401);
    const collection = db.collection('savedLinks');
    const order = await collection.countDocuments({ ownerId: user.googleSub });
    const now = new Date();
    const link = { _id: randomUUID(), ownerId: user.googleSub, ...normalized.value, order, createdAt: now, updatedAt: now, source: 'browser-extension' };
    await collection.insertOne(link);
    return json({ id: link._id, title: link.title, url: link.url, createdAt: now }, 201);
  } catch (error) {
    console.error('POST /api/extension/save-link failed:', error?.name);
    return json({ error: 'Could not save this link.' }, 500);
  }
}
