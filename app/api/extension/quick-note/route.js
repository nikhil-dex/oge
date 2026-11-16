import { randomUUID } from 'node:crypto';
import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { normalizeQuickNoteContent, quickNoteTitle, MAX_QUICK_NOTE_LENGTH } from '../../../../lib/quick-notes.js';
import { withActiveOwnerMutation } from '../../../../lib/active-owner-mutation.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { inspectLegacyCutoverForOwner, legacyCutoverBlockedResponse } from '../../../../lib/oge-vault-cutover-guard.js';

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
  const subjectSlug = data.subjectSlug === undefined || data.subjectSlug === null ? '' : data.subjectSlug;
  if (typeof subjectSlug !== 'string' || subjectSlug.length > 100) {
    return json({ error: 'Choose a valid subject.' }, 400);
  }
  // A subject routes this capture to the full Notes library; without it the
  // existing standalone Quick Notes behavior is unchanged.
  let heading, answer;
  if (subjectSlug) {
    const breakAt = content.indexOf('\n');
    heading = (breakAt < 0 ? content : content.slice(0, breakAt)).trim();
    answer = breakAt < 0 ? '' : content.slice(breakAt + 1).trim();
    if (!heading || heading.length > 160 || !answer || answer.length > 20000) {
      return json({ error: 'For a subject note, write a title on the first line and note content below it.' }, 400);
    }
  }

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
      // An extension token is not GitHub Vault authorization. In staging,
      // never fall back to writing permanent MongoDB content for an account
      // whose own vault is connected or incompletely provisioned.
      const cutover = await inspectLegacyCutoverForOwner(db, user.googleSub,
        { extensionTokenHash: tokenHash }, { session });
      if (cutover.blocked) return legacyCutoverBlockedResponse(cutover);
      const now = new Date();
      if (subjectSlug) {
        const subject = await db.collection('subjects').findOne(
          { ownerId: user.googleSub, slug: subjectSlug },
          { session, projection: { name: 1 } },
        );
        if (!subject) return json({ error: 'Subject not found. Refresh the subject list.' }, 404);
        const note = {
          ownerId: user.googleSub, subjectSlug, heading, answer, tags: [],
          favorite: false, createdAt: now, updatedAt: now, revisions: [],
        };
        const result = await db.collection('notes').insertOne(note, { session });
        return json({ id: String(result.insertedId), title: heading, destination: 'notes', subject: subject.name }, 201);
      }
      const note = {
        _id: randomUUID(), ownerId: user.googleSub, content,
        title: quickNoteTitle(content), createdAt: now, updatedAt: now,
      };
      await db.collection('quickNotes').insertOne(note, { session });
      return json({ id: note._id, title: note.title, destination: 'quick-notes', createdAt: now }, 201);
    }, { extensionTokenHash: tokenHash });
  } catch (error) {
    console.error('POST /api/extension/quick-note failed:', error?.name);
    return json({ error: 'Could not save this Quick Note.' }, 500);
  }
}
