import { auth } from '../../../../../../auth.js';
import { getDatabase } from '../../../../../../lib/mongodb.js';
import { getVaultNoteClient } from '../../../../../../lib/oge-vault-notes.js';
import { checkVaultStagingReadiness } from '../../../../../../lib/oge-vault-staging-preflight.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../../lib/rate-limit.js';
import { readLimitedBody } from '../../../../../../lib/read-limited-body.js';
import { validateVaultChunkRestoreCommitApproval } from '../../../../../../lib/oge-vault-backup-chunk-restore-execute.js';
import {
  issueVaultRestoreApprovalTicket, recordVaultRestoreApproval,
} from '../../../../../../lib/oge-vault-restore-approval-ticket.js';
import { VaultGitHubError } from '../../../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (value, status = 200) => Response.json(value, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function stagingAllowed(env, request) {
  if (env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true' ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
        env.MONGODB_DB || '') ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      env.OGE_VAULT_NOTE_API_PREVIEW !== 'true' ||
      env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true' ||
      env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true' ||
      !checkVaultStagingReadiness(env).ok)
    return false;
  try {
    const staging = new URL(env.OGE_STAGING_URL);
    const requestURL = new URL(request.url);
    const origin = request.headers.get('origin');
    return staging.protocol === 'https:' &&
      staging.origin === new URL(env.OGE_VAULT_BASE_URL).origin &&
      requestURL.origin === staging.origin &&
      origin === staging.origin;
  } catch { return false; }
}

function failure(error) {
  if (error?.status === 413)
    return json({ error: 'Restore receipt request too large.' }, 413);
  if (error instanceof VaultGitHubError)
    return json({ error: error.message },
      [400, 401, 404, 409, 429].includes(error.status)
        ? error.status : 503);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid selected restore confirmation.' }, 400);
  console.error('Vault staging restore receipt failed:', error?.name);
  return json({ error: 'Could not issue signed restore receipt.' }, 503);
}

/**
 * M59: isolated, authenticated staging browser approval receipt only.
 * NO uploaded Notes, private chunk files, GitHub writes or restore execution.
 * The separate local disposable operator CLI later verifies and atomically
 * consumes this short-lived receipt before invoking the fenced M58 executor.
 */
export async function POST(request) {
  if (!stagingAllowed(process.env, request))
    return json({ error: 'Staging restore approval unavailable.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in before approving a restore.' }, 401);
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON restore approval is accepted.' }, 415);
    const approval = validateVaultChunkRestoreCommitApproval(
      JSON.parse(await readLimitedBody(request, 4096)));
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    // The owner's GitHub App token is restricted to contents:read. No user
    // body can choose a repository or reuse a different signed session.
    const client = await getVaultNoteClient(db, {
      ownerId, sessionVersion,
    }, { readOnly: true });
    const ref = await client.call('/git/ref/heads/' +
      encodeURIComponent(client.branch));
    if (ref?.object?.sha !== approval.expectedTargetHead)
      return json({ error: 'Destination GitHub revision changed. Review again.' }, 409);

    const identity = {
      ownerId, sessionVersion,
      repoId: client.vault.repoId,
      installationId: client.vault.installationId,
      repoName: client.vault.repoName,
    };
    const receipt = issueVaultRestoreApprovalTicket(identity, {
      ...approval, confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
    }, { secret: process.env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_KEY });
    await recordVaultRestoreApproval(db, identity, receipt);
    return json({
      format: 'oge-vault-staging-one-time-restore-receipt',
      version: 1, ticket: receipt.ticket,
      expiresAt: receipt.expiresAt.toISOString(),
      selectedCount: approval.selectedIds.length,
      hasUploadedBackup: false,
      signedOwnerSessionBound: true,
      oneTimeClaimRequired: true,
      immediatelyExecutesRestore: false,
      nextBatchAutomaticallyStarted: false,
      productionRestoreAuthorized: false,
    });
  } catch (error) { return failure(error); }
}
