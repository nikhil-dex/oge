import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import {
  planVaultNotesImport,
} from '../../../../../lib/oge-vault-backup-import-plan.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from '../../../../../lib/oge-vault-backup-export.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff' },
});
const errorResponse = (error) => {
  if (error?.status === 413) return json({ error: 'Backup archive exceeds the safe preview limit.' }, 413);
  if (error instanceof VaultGitHubError) {
    const status = [400, 401, 404, 409, 413, 429].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid Notes-only backup archive.' }, 400);
  console.error('Vault import planning preview failed:', error?.name);
  return json({ error: 'GitHub import conflicts could not be verified.' }, 503);
};

/**
 * Read-only Phase D3b2 upload/preview. NO import execution exists.
 * Uploaded note content is validated in memory and never persisted to
 * MongoDB or GitHub. Output is IDs/outcomes only, not note bodies/titles.
 */
export async function POST(request) {
  if (process.env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub backup import planning disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to review a backup.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON backup archives are accepted.' }, 415);

    const archive = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_BACKUP_EXPORT_BYTES));
    const client = await getVaultNoteClient(db, { ownerId, sessionVersion });
    const plan = await planVaultNotesImport(client, archive, {
      subjectVerifier: async (subjectIds) => {
        for (let offset = 0; offset < subjectIds.length; offset += 100) {
          const chunk = subjectIds.slice(offset, offset + 100);
          const owned = await db.collection('subjects').find({
            ownerId, slug: { $in: chunk },
          }, { projection: { _id: 0, slug: 1 } }).toArray();
          const found = new Set(owned.map((item) => item.slug));
          if (found.size !== chunk.length ||
              chunk.some((id) => !found.has(id))) return false;
        }
        return true;
      },
      pendingDraftIds: async (noteIds) => {
        const pending = [];
        for (let offset = 0; offset < noteIds.length; offset += 100) {
          const chunk = noteIds.slice(offset, offset + 100);
          const rows = await db.collection('vault_drafts').find({
            ownerId, repoId: client.vault.repoId, noteId: { $in: chunk },
          }, { projection: { _id: 0, noteId: 1 } }).toArray();
          pending.push(...rows.map((row) => row.noteId));
        }
        return pending;
      },
    });
    // Do not let a revoked session, reconnected Vault or repo switch leak a
    // fresh remote inventory. Never authorize a write from this response.
    const account = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } },
    );
    if (!account || account.vault?.status !== 'connected' ||
        account.vault.repoId !== client.vault.repoId ||
        account.vault.installationId !== client.vault.installationId)
      return json({ error: 'Vault session changed during import preview.' }, 409);
    return json(plan);
  } catch (error) { return errorResponse(error); }
}
