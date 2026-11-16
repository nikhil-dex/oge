import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { exportVaultNotesSnapshotChunk } from '../../../../lib/oge-vault-backup-export-chunk.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (value, status = 200) => Response.json(value, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function failure(error) {
  if (error instanceof VaultGitHubError) {
    const status = [401, 404, 409, 413, 429].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: 'Invalid Notes chunk export request.' }, 400);
  console.error('Vault chunk export preview failed:', error?.name);
  return json({ error: 'Could not verify GitHub Notes chunk.' }, 503);
}

/**
 * D3b2b2c4f: default-OFF, Notes-only partial export.
 * No POST/PUT, no arbitrary Git revision or repo selector, no note writes.
 * A chunk is not a complete backup or a valid legacy-import payload.
 */
export async function GET(request) {
  if (process.env.OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_BACKUP_EXPORT_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub Notes chunk export disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to export your notes.' }, 401);
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    if (keys.length !== new Set(keys).size ||
        keys.some((key) => !['snapshot', 'after'].includes(key)))
      return json({ error: 'Invalid chunk cursor parameters.' }, 400);
    const snapshot = url.searchParams.get('snapshot');
    const afterId = url.searchParams.get('after');
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    // A read-only installation token has no ability to change GitHub notes.
    const client = await getVaultNoteClient(db,
      { ownerId, sessionVersion }, { readOnly: true });
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const chunk = await exportVaultNotesSnapshotChunk(client, {
      snapshot, afterId,
      subjectVerifier: async (subjectIds) => {
        if (subjectIds.length === 0) return true;
        const owned = await db.collection('subjects').find({
          ownerId, slug: { $in: subjectIds },
        }, { projection: { _id: 0, slug: 1 } }).toArray();
        const seen = new Set(owned.map(({ slug }) => slug));
        return seen.size === subjectIds.length &&
          subjectIds.every((subjectId) => seen.has(subjectId));
      },
    });

    const account = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } },
    );
    if (!account || account.vault?.status !== 'connected' ||
        account.vault.repoId !== client.vault.repoId ||
        account.vault.installationId !== client.vault.installationId ||
        account.vault.githubAccountId !== client.vault.githubAccountId ||
        account.vault.githubLogin !== client.vault.githubLogin ||
        account.vault.repoName !== client.vault.repoName)
      return json({ error: 'Vault session or repository changed during export.' }, 409);

    return Response.json(chunk, { status: 200, headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment; filename="oge-vault-notes-chunk.json"',
    } });
  } catch (error) { return failure(error); }
}
