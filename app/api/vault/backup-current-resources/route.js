import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { checkVaultStagingReadiness } from '../../../../lib/oge-vault-staging-preflight.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import {
  exportVaultCurrentResourcesSnapshot,
} from '../../../../lib/oge-vault-backup-current-resources.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function enabled(env = process.env) {
  return env.OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true' &&
    env.OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    env.OGE_STAGING_URL === env.AUTH_URL &&
    checkVaultStagingReadiness(env).ok;
}

function errorResponse(error) {
  if (error instanceof VaultGitHubError)
    return json({ error: error.message },
      [401, 404, 409, 413, 429].includes(error.status) ? error.status : 503);
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: 'Invalid GitHub resource backup request.' }, 400);
  console.error('Current GitHub resource backup preview failed:', error?.name);
  return json({ error: 'Could not verify a complete current GitHub resource snapshot.' }, 503);
}

/**
 * M73: signed-owner, isolated staging-only, GET-only download.
 * No repo/HEAD/path argument, no arbitrary commit browsing, no server-side
 * backup persistence, no Mongo note content reads, no new restore authority.
 */
export async function GET() {
  if (!enabled())
    return json({ error: 'Current resource backup staging preview disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to export private GitHub resources.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const client = await getVaultNoteClient(db,
      { ownerId, sessionVersion }, { readOnly: true });
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const archive = await exportVaultCurrentResourcesSnapshot(client, {
      subjectVerifier: async (subjectIds) => {
        if (subjectIds.length === 0) return true;
        const subjects = await db.collection('subjects').find({
          ownerId, slug: { $in: subjectIds },
        }, { projection: { _id: 0, slug: 1 } }).toArray();
        const found = new Set(subjects.map((subject) => subject.slug));
        return found.size === subjectIds.length &&
          subjectIds.every((id) => found.has(id));
      },
    });
    // Signed session incarnation and connected GitHub App installation
    // must remain identical after reading all private content.
    const user = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } },
    );
    if (!user || user.vault?.status !== 'connected' ||
        user.vault.repoId !== client.vault.repoId ||
        user.vault.installationId !== client.vault.installationId ||
        user.vault.githubAccountId !== client.vault.githubAccountId ||
        user.vault.githubLogin !== client.vault.githubLogin ||
        user.vault.repoName !== client.vault.repoName)
      return json({ error: 'Vault owner or private repository changed during export.' }, 409);

    return Response.json(archive, {
      status: 200, headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition':
          'attachment; filename="oge-vault-current-resources.json"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) { return errorResponse(error); }
}
