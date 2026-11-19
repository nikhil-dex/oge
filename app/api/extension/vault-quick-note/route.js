import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { vaultCaptureAvailable } from '../../../../lib/oge-vault-workspace-routing.js';
import { withVaultOwnerDraftWrite } from '../../../../lib/oge-vault-import-fence.js';
import {
  standaloneCapturePath, getVaultStandaloneCapture,
  commitVaultStandaloneCapture,
} from '../../../../lib/oge-vault-standalone-captures.js';
import { normalizeQuickNoteContent, MAX_QUICK_NOTE_LENGTH } from '../../../../lib/quick-notes.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TOKEN = /^oge_[A-Za-z0-9_-]{40,60}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Vary': 'Origin',
};
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
export const OPTIONS = () => new Response(null, { status: 204, headers: HEADERS });

export async function POST(request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!TOKEN.test(token)) return json({ error: 'Connect the Oge extension first.' }, 401);

  let data;
  try { data = JSON.parse(await readLimitedBody(request, 32 * 1024)); }
  catch (error) {
    return json({ error: error?.status === 413 ? 'Quick Note is too large.' : 'Enter valid JSON.' },
      error?.status === 413 ? 413 : 400);
  }
  const id = data?.captureId;
  if (!UUID.test(id || '') || typeof data?.content !== 'string')
    return json({ error: 'Write a Quick Note before saving.' }, 400);
  const content = normalizeQuickNoteContent(data.content);
  if (!content.trim() || content.length > MAX_QUICK_NOTE_LENGTH)
    return json({ error: 'Write a Quick Note of up to 20,000 characters.' }, 400);

  try {
    const db = await getDatabase();
    const tokenHash = hashExtensionToken(token);
    const limit = await checkRateLimit(db, {
      scope: 'extension-vault-quick-note', identifier: tokenHash,
      limit: 60, windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) return rateLimitResponse(limit);
    const owner = await db.collection('users').findOne({
      extensionTokenHash: tokenHash,
      extensionTokenExpiresAt: { $gt: new Date() },
    }, { projection: { googleSub: 1, sessionVersion: 1, vault: 1, notesStorage: 1 } });
    if (!owner?.googleSub) return json({ error: 'Extension connection expired. Reconnect it.' }, 401);
    if (owner.notesStorage === 'mongodb' || !vaultCaptureAvailable(owner))
      return json({ error: 'Connect GitHub Vault to save a Quick Note here.' }, 409);

    const client = await getVaultNoteClient(db, {
      ownerId: owner.googleSub, sessionVersion: owner.sessionVersion ?? 0,
    });
    // Stable UUID is owned by this extension capture, never a GitHub path.
    const captureId = id.toLowerCase();
    standaloneCapturePath('quick-notes', captureId);
    const confirmed = (note, alreadySaved) => json({
      id: note.id, sha: note.sha, title: note.title,
      destination: 'quick-notes', confirmed: true, alreadySaved,
    }, alreadySaved ? 200 : 201);

    const current = await getVaultStandaloneCapture(client, 'quick-notes', captureId)
      .catch(error => {
        if (error instanceof VaultGitHubError && error.status === 404) return null;
        throw error;
      });
    if (current)
      return current.content === content ? confirmed(current, true)
        : json({ error: 'This Quick Note changed. Start a new capture.' }, 409);

    const scope = {
      ownerId: owner.googleSub, sessionVersion: owner.sessionVersion ?? 0,
      repoId: client.vault.repoId,
    };
    try {
      const saved = await withVaultOwnerDraftWrite(db, scope, () =>
        commitVaultStandaloneCapture(client, {
          kind: 'quick-notes', action: 'create', id: captureId, content,
        }));
      return confirmed(saved, false);
    } catch (error) {
      // Unknown provider response: read the exact current UUID; never blindly
      // replay the write or copy Quick Note content into MongoDB.
      const verified = await getVaultStandaloneCapture(client, 'quick-notes', captureId)
        .catch(() => null);
      if (verified?.content === content) return confirmed(verified, true);
      throw error;
    }
  } catch (error) {
    if (error instanceof VaultGitHubError) {
      const status = [401, 404, 409, 413, 429].includes(error.status)
        ? error.status : 503;
      return json({ error: error.message }, status);
    }
    console.error('Extension Quick Note Save failed:', error?.name);
    return json({ error: 'Quick Note Save could not be confirmed. Your text remains in the extension.' }, 503);
  }
}
