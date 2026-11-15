import { randomUUID } from 'node:crypto';
import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { normalizeQuickNoteContent, quickNoteTitle, MAX_QUICK_NOTE_LENGTH } from '../../../../lib/quick-notes.js';
import { withActiveOwnerMutation } from '../../../../lib/active-owner-mutation.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_PATTERN = /^oge_[A-Za-z0-9_-]{40,60}$/;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
  'Vary': 'Origin',
};
function json(data, status = 200) {
  return Response.json(data, { status, headers: HEADERS });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

export async function POST(request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!TOKEN_PATTERN.test(token)) return json({ error: 'A valid extension token is required.' }, 401);

  let data;
  try { data = JSON.parse(await readLimitedBody(request, 32 * 1024)); }
  catch (error) {
    return json({ error: error?.status === 413 ? 'Quick note request is too large.' : 'Enter valid JSON.' }, error?.status || 400);
  }
  if (typeof data?.content !== 'string') return json({ error: 'Quick note content must be text.' }, 400);
  const content = normalizeQuickNoteContent(data.content);
  if (!content.trim()) return json({ error: 'Write something before saving.' }, 400);
  if (content.length > MAX_QUICK_NOTE_LENGTH) return json({ error: 'Quick notes must be 20,000 characters or fewer.' }, 400);

  try {
    const db = await getDatabase();
    const tokenHash = hashExtensionToken(token);
    const throttle = await checkRateLimit(db, {
      scope: 'extension-quick-note', identifier: tokenHash, limit: 60, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const user = await db.collection('users').findOne(
      { extensionTokenHash: tokenHash, extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { googleSub: 1 } },
    );
    if (!user?.googleSub) return json({ error: 'This extension connection has expired or been revoked.' }, 401);

    return await withActiveOwnerMutation(db, user.googleSub, async (session) => {
      // Recheck token ownership inside the account transaction, guarding revocation.
      const live = await db.collection('users').findOne({
        googleSub: user.googleSub, extensionTokenHash: tokenHash,
        extensionTokenExpiresAt: { $gt: new Date() },
      }, { session, projection: { _id: 1 } });
      if (!live) return json({ error: 'This extension connection has expired or been revoked.' }, 401);
      const now = new Date();
      const note = {
        _id: randomUUID(), ownerId: user.googleSub, content,
        title: quickNoteTitle(content), createdAt: now, updatedAt: now,
      };
      await db.collection('quickNotes').insertOne(note, { session });
      return json({ id: note._id, title: note.title, createdAt: now }, 201);
    }, { extensionTokenHash: tokenHash });
  } catch (error) {
    console.error('POST /api/extension/quick-note failed:', error?.name);
    return json({ error: 'Could not save this Quick Note.' }, 500);
  }
}
