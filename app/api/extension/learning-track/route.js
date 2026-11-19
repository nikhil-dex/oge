import { randomUUID } from 'node:crypto';
import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { normalizeLearningTrack, publicLearningTrack } from '../../../../lib/learning-tracks.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { withActiveOwnerMutation } from '../../../../lib/active-owner-mutation.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const HEADERS = {
  'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Vary': 'Origin',
};
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
export function OPTIONS() { return new Response(null, { status: 204, headers: HEADERS }); }
export async function POST(request) {
  if (process.env.OGE_LEARNING_TRACKS_PREVIEW !== 'true') return json({ error: 'Learning Tracks preview is disabled.' }, 404);
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) return json({ error: 'A valid extension token is required.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 4096)); }
  catch (error) { return json({ error: error?.status === 413 ? 'Request too large.' : 'Invalid JSON.' }, error?.status || 400); }
  const normalized = normalizeLearningTrack(data);
  if (normalized.error) return json({ error: normalized.error }, 400);
  const tokenHash = hashExtensionToken(token);
  try {
    const db = await getDatabase();
    const limit = await checkRateLimit(db, { scope: 'extension-learning-track', identifier: tokenHash, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return rateLimitResponse(limit);
    const user = await db.collection('users').findOne(
      { extensionTokenHash: tokenHash, extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { googleSub: 1 } });
    if (!user?.googleSub) return json({ error: 'Extension connection expired or revoked.' }, 401);
    return await withActiveOwnerMutation(db, user.googleSub, async (session) => {
      const live = await db.collection('users').findOne({
        googleSub: user.googleSub, extensionTokenHash: tokenHash,
        extensionTokenExpiresAt: { $gt: new Date() },
      }, { session, projection: { _id: 1 } });
      if (!live) return json({ error: 'Extension connection expired or revoked.' }, 401);
      const collection = db.collection('learningTracks');
      if (await collection.findOne({ ownerId: user.googleSub, playlistId: normalized.value.playlistId }, { session, projection: { _id: 1 } }))
        return json({ error: 'You already have a track for this playlist.' }, 409);
      if (await collection.countDocuments({ ownerId: user.googleSub }, { session }) >= 100)
        return json({ error: '100-track preview limit reached.' }, 409);
      const now = new Date();
      const track = { _id: randomUUID(), ownerId: user.googleSub, ...normalized.value, completedVideos: 0, createdAt: now, updatedAt: now };
      await collection.insertOne(track, { session });
      return json({ track: publicLearningTrack(track) }, 201);
    }, { extensionTokenHash: tokenHash });
  } catch (error) {
    if (error?.code === 11000) return json({ error: 'You already have a track for this playlist.' }, 409);
    console.error('Extension Learning Tracks POST failed:', error?.name);
    return json({ error: 'Could not create learning track.' }, 503);
  }
}
