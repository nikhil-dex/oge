const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONFIRMATION = 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY';
const AVAILABLE = new Set([
  'NO_RESTORE_BATCHES_FOUND', 'CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED',
  'EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW',
]);
const KNOWN = new Set([
  ...AVAILABLE, 'PENDING_UNCONSUMED_APPROVAL',
  'BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED',
  'BLOCKED_IMPORT_LOCK_PRESENT',
  'BLOCKED_INCOMPLETE_HISTORY_WINDOW',
  'BLOCKED_INVALID_HISTORY_METADATA',
]);

/**
 * M62 browser validation of *reviewed metadata*, never backup contents.
 * The signed server revalidates exact fields and GitHub HEAD independently.
 */
export function buildVaultRestoreReviewApproval({
  sourceSnapshot, inventoryDigest, targetHead, fingerprint, selectedIdsText,
}) {
  if (typeof selectedIdsText !== 'string' ||
      selectedIdsText.length < 1 || selectedIdsText.length > 600)
    throw new TypeError('Enter between 1 and 12 reviewed note IDs.');
  const selectedIds = selectedIdsText.split(/[\s,]+/).filter(Boolean);
  if (selectedIds.length < 1 || selectedIds.length > 12 ||
      selectedIds.some((id) => !UUID.test(id)) ||
      new Set(selectedIds).size !== selectedIds.length)
    throw new TypeError('Use 1–12 unique lowercase note UUIDs.');
  if (!SHA.test(sourceSnapshot || '') ||
      !SHA.test(targetHead || '') ||
      !DIGEST.test(inventoryDigest || '') ||
      !DIGEST.test(fingerprint || ''))
    throw new TypeError('Exact lowercase Git revisions and SHA-256 proof are required.');
  return {
    confirmation: CONFIRMATION,
    expectedSourceSnapshot: sourceSnapshot,
    expectedSourceInventorySha256: inventoryDigest,
    expectedTargetHead: targetHead,
    selectedIds,
    expectedSelectionFingerprint: fingerprint,
  };
}

/**
 * The history endpoint is an observation only, not a commit capability.
 * Unknown or malformed states always disable browser approval.
 */
export function classifyVaultRestoreReviewHistory(report) {
  if (!report || report.format !== 'oge-vault-restore-batch-history-read-only' ||
      report.version !== 1 ||
      typeof report.status !== 'string' ||
      !KNOWN.has(report.status) ||
      report.readOnly !== true ||
      report.automaticRetryAuthorized !== false ||
      report.automaticNextBatchAuthorized !== false ||
      report.operatorLockReleaseAuthorized !== false ||
      report.currentGitHubHeadVerified !== false ||
      report.historicalTotalsProven !== false ||
      report.historyTruncated !== false ||
      !Array.isArray(report.batches))
    return { canRequestReceipt: false, label: 'History cannot be verified. No approval can be issued from this page.' };

  const canRequestReceipt = AVAILABLE.has(report.status);
  const labels = {
    NO_RESTORE_BATCHES_FOUND: 'No previous restore batches are visible. Review the source and destination externally before approving.',
    CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED: 'Earlier GitHub batches were confirmed. Every new batch still needs a fresh independent review.',
    EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW: 'An older receipt expired. A new owner review and target HEAD are required.',
    PENDING_UNCONSUMED_APPROVAL: 'A prior approval is pending. Do not create another ticket until it expires or has been investigated.',
    BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED: 'A previous batch may have written to GitHub. Stop and request independent operator review.',
    BLOCKED_IMPORT_LOCK_PRESENT: 'The Vault is quarantined by an import lock. Do not retry or release it from the browser.',
    BLOCKED_INCOMPLETE_HISTORY_WINDOW: 'The visible history is incomplete. Independent review is required.',
    BLOCKED_INVALID_HISTORY_METADATA: 'Historical receipt metadata is invalid. Stop and investigate.',
  };
  return { canRequestReceipt, label: labels[report.status] };
}
