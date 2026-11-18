import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { vaultCaptureFields } from '../../../../lib/oge-vault-quick-capture.js';
import { noteFilePath, getVaultNoteClient, readVaultNote } from '../../../../lib/oge-vault-notes.js';
import { commitVaultNoteBatch } from '../../../../lib/oge-vault-batch.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultSubjectWrite, VaultSubjectLockedError } from '../../../../lib/oge-vault-subject-fence.js';
import { vaultCaptureAvailable } from '../../../../lib/oge-vault-workspace-routing.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TOKEN = /^oge_[A-Za-z0-9_-]{40,60}$/;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Vary': 'Origin',
};
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
export const OPTIONS = () => new Response(null, { status: 204, headers: HEADERS });

/**
 * M107: explicit NEW extension destination for a selected subject.
 * The existing /api/extension/quick-note legacy behavior is not rewritten.
 * A token selects its existing owner; the server looks up their connected
 * Vault. Only the private GitHub Note batch writer saves permanent content.
 * The browser supplies a stable captureId so a lost response cannot create
 * multiple independent Notes when the user tries the same Save again.
 */
export async function POST(request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!TOKEN.test(token)) return json({ error: 'Connect the OgeNotes extension first.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 32 * 1024)); }
  catch (error) {
    return json({ error: error?.status === 413 ? 'Note is too large.' : 'Enter valid JSON.' },
      error?.status || 400);
  }
  let note;
  try {
    note = vaultCaptureFields(data?.content, data?.subjectSlug);
    noteFilePath(data?.captureId);
  } catch {
    return json({ error: 'Choose a subject, put a title on the first line and write a note below it.' }, 400);
  }
  try {
    const db = await getDatabase();
    const tokenHash = hashExtensionToken(token);
    const limit = await checkRateLimit(db, {
      scope: 'extension-vault-note', identifier: tokenHash,
      limit: 30, windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) return rateLimitResponse(limit);
    const owner = await db.collection('users').findOne({
      extensionTokenHash: tokenHash, extensionTokenExpiresAt: { $gt: new Date() },
    }, { projection: { googleSub: 1, sessionVersion: 1, vault: 1 } });
    if (!owner?.googleSub) return json({ error: 'Extension connection expired. Reconnect the extension.' }, 401);
    if (!vaultCaptureAvailable(owner)) {
      return json({ error: 'Connect your GitHub Vault in Oge Notes before saving from the extension.' }, 409);
    }
    const subject = await db.collection('subjects').findOne({
      ownerId: owner.googleSub, slug: note.subjectId,
    }, { projection: { name: 1 } });
    if (!subject) return json({ error: 'Subject not found. Refresh your subjects.' }, 404);
    // Both the extension token and the GitHub App repository are chosen by the
    // database account, not by the browser page sending the note content.
    const client = await getVaultNoteClient(db, {
      ownerId: owner.googleSub, sessionVersion: owner.sessionVersion ?? 0,
    });
    const id = data.captureId.toLowerCase();
    const alreadySaved = async () => {
      try {
        const existing = await readVaultNote(client, id);
        if (existing.subjectId !== note.subjectId ||
            existing.heading !== note.heading ||
            existing.answer !== note.answer ||
            existing.favorite !== false ||
            existing.tags.length !== 0)
          return json({ error: 'A different Note already uses this capture. Start a new capture.' }, 409);
        return json({
          id, title: existing.heading, subject: subject.name,
          destination: 'vault', confirmed: true, alreadySaved: true,
        });
      } catch (error) {
        if (error instanceof VaultGitHubError && error.status === 404) return null;
        throw error;
      }
    };
    const previous = await alreadySaved();
    if (previous) return previous;
    try {
      const result = await withVaultSubjectWrite(db, owner.googleSub, note.subjectId, () =>
        commitVaultNoteBatch(client, [{ action: 'create', id, note }]));
      return json({
        id, title: result.results[0].heading, subject: subject.name,
        destination: 'vault', confirmed: true,
      }, 201);
    } catch (error) {
      // A network error may occur after GitHub updated its branch. Only an
      // exact read-back of the same owner, Note ID and content may report Save.
      const recovered = await alreadySaved().catch(() => null);
      if (recovered?.status === 200) return recovered;
      throw error;
    }
  } catch (error) {
    if (error instanceof VaultSubjectLockedError)
      return json({ error: error.message }, 409);
    if (error instanceof VaultGitHubError)
      return json({ error: error.message }, error.status === 401 ? 401 :
        error.status === 409 || error.status === 422 ? 409 : 503);
    console.error('POST /api/extension/vault-note failed:', error?.name);
    return json({ error: 'GitHub Save could not be confirmed. Your extension note is still in the editor.' }, 503);
  }
}
