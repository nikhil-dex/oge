const SHA = /^[a-f0-9]{40}$/;

/**
 * Safe signed-owner staging status. There is no authority to retry, release
 * an import lock, advance to the next batch, or infer a GitHub write from
 * "claimed". MongoDB holds metadata only, never note bodies or chunk data.
 */
export function describeVaultRestoreApprovalStatus(record, {
  now = new Date(),
} = {}) {
  if (!record || typeof record !== 'object' ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(record.expiresAt instanceof Date) ||
      !Number.isFinite(record.expiresAt.getTime()) ||
      !['pending', 'claimed', 'confirmed'].includes(record.state) ||
      (record.state === 'confirmed' &&
        !SHA.test(record.commitSha || '')))
    throw new TypeError('Invalid staging restore approval status');

  return {
    format: 'oge-vault-staging-single-batch-status',
    version: 1,
    status: record.state === 'pending' ? 'PENDING_APPROVAL_CLAIM'
      : record.state === 'confirmed' ? 'GITHUB_BATCH_CONFIRMED'
        : 'CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED',
    expiresAt: record.expiresAt.toISOString(),
    receiptExpired: record.expiresAt <= now,
    ...(record.state === 'confirmed'
      ? { confirmedCommitSha: record.commitSha } : {}),
    signedOwnerSessionBound: true,
    sourceNoteContentReturned: false,
    nextBatchAutomaticallyStarted: false,
    canRetryAutomatically: false,
    canUnlockImport: false,
    operatorReviewRequiredIfInterrupted: record.state === 'claimed',
  };
}
