import { auth } from '../../../../../../auth.js';
import { getDatabase } from '../../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../../lib/active-owner-mutation.js';
import { checkVaultStagingReadiness } from '../../../../../../lib/oge-vault-staging-preflight.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const HASH = /^[a-f0-9]{64}$/;
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

/**
 * M59 authenticated, metadata-only status lookup for ONE signed staging
 * batch. A claimed receipt might represent an in-flight or uncertain GitHub
 * mutation; it is NEVER permission for a retry, lock release or next batch.
 * This endpoint has NO GitHub token and NO mutation capability.
 */
export async function GET(request) {
  const env = process.env;
  if (env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
        env.MONGODB_DB || '') ||
      !checkVaultStagingReadiness(env).ok)
    return json({ error: 'Staging restore status unavailable.' }, 404);
  try {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.OGE_STAGING_URL).origin ||
        [...url.searchParams.keys()].length !== 1 ||
        !HASH.test(url.searchParams.get('receiptId') || ''))
      return json({ error: 'Invalid restore receipt ID.' }, 400);
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to inspect your restore.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const owner = await db.collection('users').findOne({
      ...ownerMutationFilter(ownerId, { sessionVersion }),
      'vault.status': 'connected',
      'vault.repoName': 'ogenotes-vault',
    }, { projection: { vault: 1 } });
    const vault = owner?.vault;
    if (!Number.isSafeInteger(vault?.repoId) ||
        !Number.isSafeInteger(vault?.installationId))
      return json({ error: 'Signed Vault account unavailable.' }, 409);
    const record = await db.collection('vault_restore_approvals').findOne({
      _id: url.searchParams.get('receiptId'),
      ownerId, sessionVersion,
      repoId: vault.repoId,
      installationId: vault.installationId,
    }, { projection: {
      _id: 0, state: 1, expiresAt: 1,
      claimedAt: 1, confirmedAt: 1, commitSha: 1,
    } });
    if (!record || !['pending', 'claimed', 'confirmed'].includes(record.state))
      return json({ error: 'Restore batch receipt unavailable.' }, 404);
    return json({
      format: 'oge-vault-staging-single-batch-status',
      version: 1,
      status: record.state === 'pending' ? 'PENDING_APPROVAL_CLAIM'
        : record.state === 'confirmed' ? 'GITHUB_BATCH_CONFIRMED'
          : 'CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED',
      expiresAt: record.expiresAt?.toISOString() || null,
      ...(record.state === 'confirmed' && /^[a-f0-9]{40}$/.test(
        record.commitSha || '') ? { confirmedCommitSha: record.commitSha } : {}),
      signedOwnerSessionBound: true,
      sourceNoteContentReturned: false,
      nextBatchAutomaticallyStarted: false,
      canRetryAutomatically: false,
      canUnlockImport: false,
      operatorReviewRequiredIfInterrupted: record.state === 'claimed',
    });
  } catch (error) {
    console.error('Vault staging restore status failed:', error?.name);
    return json({ error: 'Unable to verify restore batch status.' }, 503);
  }
}
