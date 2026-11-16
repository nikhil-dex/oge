import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportApproval, executeApprovedVaultNotesImport,
} from '../../../../../lib/oge-vault-backup-import-commit.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from '../../../../../lib/oge-vault-backup-export.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';
import { withVaultOwnerImportExclusive } from '../../../../../lib/oge-vault-import-fence.js';
import {
  withVaultSubjectsWrite, VaultSubjectLockedError,
} from '../../../../../lib/oge-vault-subject-fence.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function failure(error) {
  if (error?.status === 413) return json({ error: 'Import request too large.' }, 413);
  if (error instanceof VaultSubjectLockedError)
    return json({ error: 'Vault subject is locked.' }, 409);
  if (error instanceof VaultGitHubError) {
    const status = [400, 401, 404, 409, 429].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid approved Notes import request.' }, 400);
  console.error('Vault approved import preview failed:', error?.name);
  return json({ error: 'GitHub import could not be confirmed.' }, 503);
}

/**
 * D3b2b1: separate default-OFF, create-only, owner-approved GitHub import.
 * Does not call the legacy MongoDB Notes writer, migrate content, overwrite
 * existing GitHub IDs, retire any draft or implicitly approve a conflict.
 */
export async function POST(request) {
  if (process.env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_NOTE_API_PREVIEW !== 'true')
    return json({ error: 'GitHub backup import commits disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Sign in to import a backup.' }, 401);
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const db = await getDatabase();
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON backup archives are accepted.' }, 415);
    const body = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_BACKUP_EXPORT_BYTES + 4096));
    const approval = validateVaultNotesImportApproval(body);
    const subjectIds = [...new Set(approval.selected.map((note) => note.subjectId))];
    const client = await getVaultNoteClient(db, { ownerId, sessionVersion });

    return await withVaultOwnerImportExclusive(db, { ownerId, repoId: client.vault.repoId,
      sessionVersion }, () => withVaultSubjectsWrite(db, ownerId, subjectIds, async () => {
      const result = await executeApprovedVaultNotesImport(client, body, {
        subjectVerifier: async (subjects) => {
          for (let offset = 0; offset < subjects.length; offset += 100) {
            const chunk = subjects.slice(offset, offset + 100);
            const rows = await db.collection('subjects').find({
              ownerId, slug: { $in: chunk },
            }, { projection: { _id: 0, slug: 1 } }).toArray();
            const found = new Set(rows.map((row) => row.slug));
            if (found.size !== chunk.length ||
                chunk.some((id) => !found.has(id))) return false;
          }
          return true;
        },
        pendingDraftIds: async (noteIds) => {
          const found = [];
          for (let offset = 0; offset < noteIds.length; offset += 100) {
            const chunk = noteIds.slice(offset, offset + 100);
            const rows = await db.collection('vault_drafts').find({
              ownerId, repoId: client.vault.repoId, noteId: { $in: chunk },
            }, { projection: { _id: 0, noteId: 1 } }).toArray();
            found.push(...rows.map((row) => row.noteId));
          }
          return found;
        },
        ownerVerifier: async () => {
          const owner = await db.collection('users').findOne(
            ownerMutationFilter(ownerId, { sessionVersion }),
            { projection: { vault: 1 } });
          const current = owner?.vault;
          return current?.status === 'connected' &&
            current.repoId === client.vault.repoId &&
            current.installationId === client.vault.installationId &&
            current.githubAccountId === client.vault.githubAccountId &&
            current.githubLogin === client.vault.githubLogin &&
            current.repoName === client.vault.repoName;
        },
      });
      return json(result, 200);
    }));
  } catch (error) { return failure(error); }
}
