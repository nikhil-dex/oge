import { ownerMutationFilter } from './active-owner-mutation.js';
import { describeVaultRestoreApprovalStatus } from './oge-vault-restore-progress.js';
import { VaultGitHubError } from './oge-vault-github.js';

export const VAULT_RESTORE_HISTORY_PAGE_LIMIT = 25;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const fail = (reason) => new VaultGitHubError(reason, 409);

function ownerScope(identity) {
  if (!identity || !Number.isSafeInteger(identity.repoId) ||
      identity.repoId < 1 || !Number.isSafeInteger(identity.installationId) ||
      identity.installationId < 1 || identity.repoName !== 'ogenotes-vault')
    throw new TypeError('Exact signed restore history scope required');
  return {
    ...ownerMutationFilter(identity.ownerId, {
      sessionVersion: identity.sessionVersion,
    }),
    'vault.status': 'connected',
    'vault.repoId': identity.repoId,
    'vault.installationId': identity.installationId,
    'vault.repoName': identity.repoName,
  };
}

function ownerFingerprint(doc) {
  if (!doc || doc.vault?.status !== 'connected') return null;
  const vault = doc.vault;
  return JSON.stringify({
    repoId: vault.repoId,
    installationId: vault.installationId,
    repoName: vault.repoName,
    githubAccountId: vault.githubAccountId,
    githubLogin: vault.githubLogin,
    // The import lock is opaque. A present or changing lock is always
    // blocking; its private operation details are NEVER returned.
    lock: doc.vaultImportLock || null,
  });
}

/**
 * M60: Bounded historical RECEIPT read, not a multi-batch executor.
 * Checks signed owner scope before/after the metadata scan. An incomplete
 * window, expired unclaimed receipt, claimed/uncertain batch, current import
 * quarantine or changing account fails closed. Never proves current Git
 * HEAD, source data or permission to authorize the next commit.
 */
export async function inspectVaultRestoreBatchHistoryReadOnly(db, identity, {
  now = new Date(),
} = {}) {
  if (!db || typeof db.collection !== 'function' ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError('Read-only restore batch history context required');
  const filter = ownerScope(identity);
  const users = db.collection('users');
  const projection = {
    _id: 0, vault: 1, vaultImportLock: 1,
  };
  const first = await users.findOne(filter, { projection });
  const before = ownerFingerprint(first);
  if (!before) throw fail('vault-restore-history-owner-changed');

  const query = {
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
  };
  const rows = await db.collection('vault_restore_approvals')
    .find(query, { projection: {
      _id: 1, state: 1, createdAt: 1, expiresAt: 1,
      commitSha: 1, claimedAt: 1, confirmedAt: 1,
    } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(VAULT_RESTORE_HISTORY_PAGE_LIMIT + 1)
    .toArray();
  const truncated = rows.length > VAULT_RESTORE_HISTORY_PAGE_LIMIT;
  const page = rows.slice(0, VAULT_RESTORE_HISTORY_PAGE_LIMIT);
  const batches = [];
  let confirmed = 0, unresolved = 0, pending = 0, expired = 0;
  let metadataInvalid = false;

  for (const row of page) {
    if (!HASH.test(row?._id || '') ||
        !(row.createdAt instanceof Date) ||
        !Number.isFinite(row.createdAt.getTime()) ||
        row.createdAt > now ||
        !(row.expiresAt instanceof Date) ||
        !Number.isFinite(row.expiresAt.getTime()) ||
        row.expiresAt < row.createdAt ||
        (row.state === 'claimed' &&
          (!(row.claimedAt instanceof Date) ||
            !Number.isFinite(row.claimedAt.getTime()))) ||
        (row.state === 'confirmed' &&
          (!(row.confirmedAt instanceof Date) ||
            !Number.isFinite(row.confirmedAt.getTime()) ||
            !SHA.test(row.commitSha || '')))) {
      metadataInvalid = true;
      break;
    }
    let status;
    try {
      status = describeVaultRestoreApprovalStatus(row, { now });
    } catch {
      metadataInvalid = true;
      break;
    }
    if (row.state === 'confirmed') confirmed++;
    else if (row.state === 'claimed') unresolved++;
    else if (status.receiptExpired) expired++;
    else pending++;
    batches.push({
      receiptId: row._id,
      state: status.status,
      receiptExpired: status.receiptExpired,
      ...(row.state === 'confirmed' ? {
        verifiedCommitSha: row.commitSha,
      } : {}),
    });
  }

  // Do not trust a stable user context merely because the first read
  // matched: recheck that signed session and full connected GitHub identity.
  const second = await users.findOne(filter, { projection });
  if (ownerFingerprint(second) !== before)
    throw fail('vault-restore-history-owner-or-import-lock-changed');

  const hasImportQuarantine = Boolean(first.vaultImportLock);
  const status = hasImportQuarantine ? 'BLOCKED_IMPORT_LOCK_PRESENT' :
    metadataInvalid ? 'BLOCKED_INVALID_HISTORY_METADATA' :
      unresolved ? 'BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED' :
        truncated ? 'BLOCKED_INCOMPLETE_HISTORY_WINDOW' :
          pending ? 'PENDING_UNCONSUMED_APPROVAL' :
            expired ? 'EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW' :
              confirmed ? 'CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED' :
                'NO_RESTORE_BATCHES_FOUND';

  return {
    format: 'oge-vault-restore-batch-history-read-only',
    version: 1,
    status,
    batches: metadataInvalid ? [] : batches,
    visibleBatchCount: metadataInvalid ? 0 : batches.length,
    countsWithinWindow: metadataInvalid ? null :
      { confirmed, unresolved, pending, expired },
    historyTruncated: truncated,
    historicalTotalsProven: false,
    currentGitHubHeadVerified: false,
    historicalBatchChainVerified: false,
    sourceContentVerifiedByThisReport: false,
    readOnly: true,
    automaticNextBatchAuthorized: false,
    automaticRetryAuthorized: false,
    operatorLockReleaseAuthorized: false,
    requiresFreshOwnerApproval: true,
    requiresFreshSourceAndTargetVerification: true,
    ownerIdentityReturned: false,
    noteBodiesReturned: false,
    draftsModified: false,
    githubWritesPerformed: false,
  };
}
