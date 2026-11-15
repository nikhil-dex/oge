import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Vary': 'Origin',
};
function json(data, status = 200) {
  return Response.json(data, { status, headers: HEADERS });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}
export async function GET(request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) return json({ error: 'A valid extension token is required.' }, 401);
  try {
    const db = await getDatabase();
    const hash = hashExtensionToken(token);
    const limit = await checkRateLimit(db, { scope: 'extension-subject-list', identifier: hash, limit: 120, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return rateLimitResponse(limit);
    const user = await db.collection('users').findOne(
      { extensionTokenHash: hash, extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { googleSub: 1 } },
    );
    if (!user?.googleSub) return json({ error: 'Extension connection expired or revoked.' }, 401);
    const subjects = await db.collection('subjects')
      .find({ ownerId: user.googleSub }, { projection: { _id: 0, slug: 1, name: 1 } })
      .sort({ createdAt: 1 }).limit(1000).toArray();
    return json({ subjects });
  } catch (error) {
    console.error('GET /api/extension/subjects failed:', error?.name);
    return json({ error: 'Could not load your subjects.' }, 500);
  }
}
