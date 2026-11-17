import {
  loadVaultRecoveryVerifiedFile,
  compareVaultRecoverySnapshots,
} from './oge-vault-restore-preview.js';
import {
  compareVaultHistoricalFingerprintToSource,
} from './oge-vault-historical-source-check-browser.js';
import {
  compareVaultVerifiedFingerprintToSource,
} from './oge-vault-current-resource-source-check-browser.js';

/**
 * M92/E24: full M88 local checks first, then two independent owner-scoped
 * GitHub reads: bounded LINEAR historical candidate and current reference.
 * Does not return archives, Note/subject IDs, titles, bodies or SHA values.
 */
const fingerprint = a => ({
  snapshot: a.snapshot, treeSha: a.treeSha,
  archiveSha256: a.archiveSha256, inventorySha256: a.inventorySha256,
  totalNotes: a.totalNotes,
  totalQuickNotes: a.totalQuickNotes,
  totalAirNotes: a.totalAirNotes,
});
const hold = (status) => Object.freeze({
  status,
  backupSourceAuthenticated: false,
  currentSnapshotAuthenticatedAtCheck: false,
  restorationAuthorized: false,
  canRestore: false,
  canAuthorizeImport: false,
  canDeleteExisting: false,
  canReleaseImportLock: false,
  canRetryUnknownWrite: false,
  githubWritesPerformed: false,
  fileContentsUploaded: false,
  snapshotMayBecomeStaleAfterCheck: true,
});

export async function previewVaultHistoricallyAuthenticatedRecoveryFiles(
  backupFile, referenceFile, {
    subtle = globalThis.crypto?.subtle,
    fetcher = globalThis.fetch,
    recheckCurrent = false,
  } = {},
) {
  if (!subtle || typeof fetcher !== 'function' ||
      typeof recheckCurrent !== 'boolean' ||
      !backupFile || !referenceFile) {
    throw new TypeError('Historical restore preview requires exactly two files');
  }
  // No network until BOTH archives pass the complete bounded M88 verifier.
  const backup = await loadVaultRecoveryVerifiedFile(backupFile, subtle);
  const current = await loadVaultRecoveryVerifiedFile(referenceFile, subtle);

  const historical = await compareVaultHistoricalFingerprintToSource(
    fingerprint(backup), fetcher);
  if (!historical.matched) {
    return hold('HISTORICAL_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD');
  }

  // A second independently authenticated CURRENT source snapshot is needed
  // to interpret candidate-versus-target additions and conflicts.
  const currentCheck = await compareVaultVerifiedFingerprintToSource(
    fingerprint(current), fetcher);
  if (!currentCheck.matched) {
    return hold('CURRENT_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD');
  }

  const plan = compareVaultRecoverySnapshots(backup, current);
  // M93/E25: optional final live source recheck, AFTER history and conflict
  // inspection but BEFORE disclosing any conflict counts in a positive plan.
  // This costs another bounded M89 source inspection (2 of 3 hourly calls).
  // It narrows the stale-view window; it does NOT acquire a writer lock or
  // prove the branch remained unchanged after the last read.
  if (recheckCurrent) {
    const finalCheck = await compareVaultVerifiedFingerprintToSource(
      fingerprint(current), fetcher);
    if (!finalCheck.matched) {
      return hold('CURRENT_PRIVATE_GITHUB_RECHECK_STALE_HOLD');
    }
  }
  const reviewState = !recheckCurrent
    ? 'READ_ONLY_UNGUARDED_HISTORICAL_PREVIEW'
    : plan.totalConflict > 0
      ? 'MANUAL_CONFLICT_REVIEW_REQUIRED_NO_RESTORE'
      : plan.totalAdd > 0
        ? 'MANUAL_ADDITION_REVIEW_REQUIRED_NO_RESTORE'
        : 'READ_ONLY_REVIEW_REQUIRED_NO_RESTORE';
  return Object.freeze({
    ...plan,
    status: recheckCurrent
      ? 'HISTORICAL_AND_CURRENT_RECHECK_MATCHED_READ_ONLY'
      : 'BOUNDED_HISTORICAL_AND_CURRENT_SOURCES_MATCHED_READ_ONLY',
    reviewState,
    manualReviewRequired: true,
    finalCurrentSourceRecheckPassedAtInspection: recheckCurrent,
    currentSourceChecksPerformed: recheckCurrent ? 2 : 1,
    recoveryApproved: false,
    backupSourceAuthenticated: true,
    currentSnapshotAuthenticatedAtCheck: true,
    authenticatedBoundedGitHubHistoryReadPerformed: true,
    historicalReachabilityMaxAncestorEdges: 20,
    onlyFingerprintsUploaded: true,
    fileContentsUploaded: false,
    snapshotMayBecomeStaleAfterCheck: true,
    // These are two separate non-atomic read-only operations.
    historyAndCurrentChecksWereAtomic: false,
    completeAccountBackup: false,
    restorationAuthorized: false,
    canRestore: false,
    canAuthorizeImport: false,
    canDeleteExisting: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    githubWritesPerformed: false,
    networkRequestsPerformed: true,
    privateNotesReturned: false,
  });
}
