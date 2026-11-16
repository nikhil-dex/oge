import { auth } from '../../../../../../auth.js';
import { getDatabase } from '../../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../../lib/active-owner-mutation.js';
import { checkVaultStagingReadiness } from '../../../../../../lib/oge-vault-staging-preflight.js';
import { inspectVaultRestoreBatchHistoryReadOnly } from '../../../../../../lib/oge-vault-restore-batch-history.js';
import { VaultGitHubError } from '../../../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

/**
 * M60: signed-owner, staging-only view of the most recent restore receipts.
 * Does not acquire GitHub credentials, read Notes or perform any mutation.
 * History can NEVER authorize another batch, retry or quarantine release.
 */
export async function GET(request) {
  const env = process.env;
  if (env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
        env.MONGODB_DB || '') ||
      !checkVaultStagingReadiness(env).ok)
    return json({ error: 'Restore history is staging-only.' }, 404);
  try {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.OGE_STAGING_URL).origin ||
        url.searchParams.size !== 0)
      return json({ error: 'Invalid restore history request.' }, 400);
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to inspect restore history.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const account = await db.collection('users').findOne({
      ...ownerMutationFilter(ownerId, { sessionVersion }),
      'vault.status': 'connected',
      'vault.repoName': 'ogenotes-vault',
    }, { projection: { vault: 1 } });
    if (!Number.isSafeInteger(account?.vault?.repoId) ||
        !Number.isSafeInteger(account?.vault?.installationId))
      return json({ error: 'Signed private Vault unavailable.' }, 409);
    const report = await inspectVaultRestoreBatchHistoryReadOnly(db, {
      ownerId, sessionVersion,
      repoId: account.vault.repoId,
      installationId: account.vault.installationId,
      repoName: account.vault.repoName,
    });
    return json(report);
  } catch (error) {
    if (error instanceof VaultGitHubError)
      return json({ error: error.message }, 409);
    console.error('Vault staging restore batch history failed:', error?.name);
    return json({ error: 'Could not inspect restore history.' }, 503);
  }
}
