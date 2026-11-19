import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { reconcileApprovedVaultNotesImport } from '../../../../../lib/oge-vault-backup-import-reconcile.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from '../../../../../lib/oge-vault-backup-export.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function fail(error) {
  if (error?.status === 413) return json({ error: 'Import request too large.' }, 413);
  if (error instanceof VaultGitHubError) {
    const status = [400, 401, 404, 409, 429].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid import reconciliation request.' }, 400);
  console.error('Vault import reconciliation failed:', error?.name);
  return json({ error: 'GitHub import result could not be verified.' }, 503);
}

/**
 * Read-only, cross-request recovery from an ambiguous GitHub import response.
 * The same signed approval body is required, but NO mutation or draft cleanup
 * is performed. There is no blind retry, receipt authority or fallback to
 * permanent MongoDB note-content storage.
 */
export async function POST(request) {
  if (process.env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_NOTE_API_PREVIEW !== 'true')
    return json({ error: 'GitHub import reconciliation disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to verify your import.' }, 401);
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const db = await getDatabase();
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON backup archives are accepted.' }, 415);

    const requestBody = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_BACKUP_EXPORT_BYTES + 4096));
    const client = await getVaultNoteClient(db, { ownerId, sessionVersion });
    const result = await reconcileApprovedVaultNotesImport(client, requestBody, {
      subjectVerifier: async (subjectIds) => {
        for (let offset = 0; offset < subjectIds.length; offset += 100) {
          const chunk = subjectIds.slice(offset, offset + 100);
          const rows = await db.collection('subjects').find({
            ownerId, slug: { $in: chunk },
          }, { projection: { _id: 0, slug: 1 } }).toArray();
          const found = new Set(rows.map((item) => item.slug));
          if (found.size !== chunk.length || chunk.some((id) => !found.has(id)))
            return false;
        }
        return true;
      },
      ownerVerifier: async () => {
        const user = await db.collection('users').findOne(
          ownerMutationFilter(ownerId, { sessionVersion }),
          { projection: { vault: 1 } });
        const v = user?.vault;
        return v?.status === 'connected' &&
          v.repoId === client.vault.repoId &&
          v.installationId === client.vault.installationId &&
          v.githubAccountId === client.vault.githubAccountId &&
          v.githubLogin === client.vault.githubLogin &&
          v.repoName === client.vault.repoName;
      },
    });
    return json(result);
  } catch (error) { return fail(error); }
}
