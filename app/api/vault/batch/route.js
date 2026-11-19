import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { getVaultNoteClient, readVaultNote } from '../../../../lib/oge-vault-notes.js';
import { commitVaultNoteBatch } from '../../../../lib/oge-vault-batch.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultSubjectsWrite, VaultSubjectLockedError } from '../../../../lib/oge-vault-subject-fence.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Staging-only batch endpoint. Existing production note routes remain
 * untouched until the mandatory GitHub-only cutover is complete.
 */
export async function POST(request) {
  if (process.env.OGE_VAULT_NOTE_API_PREVIEW !== 'true') {
    return json({ error: 'GitHub note preview is disabled.' }, 404);
  }
  const session = await auth();
  if (!session?.user?.id) return json({ error: 'Sign in before syncing notes.' }, 401);
  try {
    const db = await getDatabase();
    const ownerId = session.user.id;
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const input = JSON.parse(await readLimitedBody(request, 384 * 1024));
    const items = input?.operations;
    if (!Array.isArray(items) || items.length < 1 || items.length > 12) {
      return json({ error: 'Submit between 1 and 12 note changes.' }, 400);
    }
    const subjectIds = [...new Set(items.filter((op) => op?.action === 'create' ||
      op?.action === 'update').map((op) => op?.note?.subjectId))];
    if (subjectIds.some((id) => typeof id !== 'string')) {
      return json({ error: 'Missing subject identifier.' }, 400);
    }
    // Do not allow arbitrary repository paths or content from another user's
    // subjects. Check before performing any remote GitHub write.
    for (const subjectId of subjectIds) {
      const subject = await db.collection('subjects').findOne({
        ownerId, slug: subjectId,
      }, { projection: { _id: 1 } });
      if (!subject) return json({ error: 'Subject not found.' }, 404);
    }
    const client = await getVaultNoteClient(db, {
      ownerId, sessionVersion: session.user.sessionVersion,
    });
    // Deletes do not carry subject IDs. Resolve their authoritative GitHub
    // subject and fence every touched subject before the atomic batch commit.
    const deletes = items.filter((op) => op?.action === 'delete');
    const deletedSubjects = [];
    for (const operation of deletes) {
      const previous = await readVaultNote(client, operation.id);
      deletedSubjects.push(previous.subjectId);
    }
    const allSubjects = [...new Set([...subjectIds, ...deletedSubjects])];
    const saved = await withVaultSubjectsWrite(db, ownerId, allSubjects,
      () => commitVaultNoteBatch(client, items));
    return json(saved, 200);
  } catch (error) {
    if (error instanceof VaultSubjectLockedError)
      return json({ error: error.message }, 409);
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return json({ error: 'Invalid batch request.' }, 400);
    }
    if (error instanceof VaultGitHubError) {
      const status = error.message === 'vault-note-conflict' ? 409 :
        error.message === 'vault-not-connected' ? 409 :
          error.message === 'session-expired' ? 401 :
            error.status === 404 ? 404 : 503;
      return json({ error: error.message }, status);
    }
    console.error('Oge Vault batch API failed:', error?.name);
    return json({ error: 'GitHub sync unavailable. Changes have not been confirmed.' }, 503);
  }
}
