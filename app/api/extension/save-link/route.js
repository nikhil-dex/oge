import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { normalizeSavedLink } from '../../../../lib/saved-links.js';
import { randomUUID } from 'node:crypto';
import { withActiveOwnerMutation } from '../../../../lib/active-owner-mutation.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { savedLinksStorageMode, createVaultSavedLink } from '../../../../lib/oge-vault-saved-links.js';

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
    const throttle = await checkRateLimit(db, { scope: 'extension-save', identifier: hashExtensionToken(token), limit: 60, windowMs: 60 * 60 * 1000 });
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const user = await db.collection('users').findOne(
      { extensionTokenHash: hashExtensionToken(token), extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { googleSub: 1, sessionVersion: 1, notesStorage: 1, vault: 1 } },
    );
    if (!user?.googleSub) return json({ error: 'This extension token has expired or been revoked. Generate a new one in OgeNotes settings.' }, 401);
    const storage = savedLinksStorageMode(user);
    if (storage === 'choice-required')
      return json({ error: 'Choose your Notes storage before saving links.' }, 409);
    if (storage === 'vault-setup-required')
      return json({ error: 'Finish connecting your GitHub Vault before saving links.' }, 409);
    if (storage === 'github') {
      // Extension token identifies the owner; the GitHub App writes only to
      // that owner's private Vault. Never fall back to MongoDB for a GitHub user.
      const live = await db.collection('users').findOne({
        googleSub: user.googleSub,
        extensionTokenHash: hashExtensionToken(token),
        extensionTokenExpiresAt: { $gt: new Date() },
      }, { projection: { _id: 1, sessionVersion: 1, notesStorage: 1, vault: 1 } });
      if (!live) return json({ error: 'This extension token was revoked.' }, 401);
      if (savedLinksStorageMode(live) !== 'github')
        return json({ error: 'Link storage changed. Refresh your Oge connection.' }, 409);
      const client = await getVaultNoteClient(db, {
        ownerId: user.googleSub, sessionVersion: live.sessionVersion ?? 0,
      });
      const saved = await createVaultSavedLink(client, normalized.value, {
        id: data?.id || randomUUID(),
      });
      return json({ id: saved.id, title: saved.title, url: saved.url,
        createdAt: saved.createdAt, storage: 'github' }, 201);
    }
    return await withActiveOwnerMutation(db, user.googleSub, async (session) => {
      // Token validity may have changed while the request was in flight.
      const liveUser = await db.collection('users').findOne({
        googleSub: user.googleSub,
        extensionTokenHash: hashExtensionToken(token),
        extensionTokenExpiresAt: { $gt: new Date() },
      }, { session, projection: { _id: 1 } });
      if (!liveUser) return json({ error: 'This extension token has expired or been revoked.' }, 401);
      const collection = db.collection('savedLinks');
      const order = await collection.countDocuments({ ownerId: user.googleSub }, { session });
      const now = new Date();
      const link = { _id: randomUUID(), ownerId: user.googleSub, ...normalized.value, order, createdAt: now, updatedAt: now, source: 'browser-extension' };
      await collection.insertOne(link, { session });
      return json({ id: link._id, title: link.title, url: link.url, createdAt: now }, 201);
    }, { extensionTokenHash: hashExtensionToken(token) });
  } catch (error) {
    if (error instanceof VaultGitHubError)
      return json({ error: error.message },
        [401, 404, 409, 429, 413].includes(error.status) ? error.status : 503);
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    console.error('POST /api/extension/save-link failed:', error?.name);
    return json({ error: 'Could not confirm the link Save. Check Saved Links before retrying.' }, 503);
  }
}
