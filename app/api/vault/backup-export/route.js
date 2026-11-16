import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { exportVaultNotesSnapshot } from '../../../../lib/oge-vault-backup-export.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff' } });

function errorResponse(error) {
  if (error instanceof VaultGitHubError) {
    const status = [401, 404, 409, 413, 429].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: 'Invalid GitHub Vault export request.' }, 400);
  console.error('Vault notes backup preview failed:', error?.name);
  return json({ error: 'Could not verify a complete GitHub Notes export.' }, 503);
}

/**
 * Phase D3b, preview-only: download *current* GitHub Notes content from a
 * complete, immutable Git tree. This does not include historical revisions,
 * Quick Notes, AirNotes or encrypted drafts, and is NOT the old Oge backup.
 * No import endpoint exists here; requests cannot mutate GitHub/MongoDB.
 */
export async function GET() {
  if (process.env.OGE_VAULT_BACKUP_EXPORT_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub Notes export preview disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Sign in to export your notes.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const client = await getVaultNoteClient(db, { ownerId, sessionVersion });
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const archive = await exportVaultNotesSnapshot(client, {
      subjectVerifier: async (subjectIds) => {
        if (subjectIds.length === 0) return true;
        const owned = await db.collection('subjects').find({
          ownerId, slug: { $in: subjectIds },
        }, { projection: { _id: 0, slug: 1 } }).toArray();
        const found = new Set(owned.map((item) => item.slug));
        return found.size === subjectIds.length &&
          subjectIds.every((subjectId) => found.has(subjectId));
      },
    });

    // Owner/session and Vault mapping must still be the same when the full
    // GitHub snapshot has been read. Revoked sessions cannot receive content.
    const account = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } },
    );
    if (!account || account.vault?.status !== 'connected' ||
        account.vault.repoId !== client.vault.repoId ||
        account.vault.installationId !== client.vault.installationId)
      return json({ error: 'Vault session or repository changed during export.' }, 409);

    return Response.json(archive, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="oge-vault-notes.json"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) { return errorResponse(error); }
}
