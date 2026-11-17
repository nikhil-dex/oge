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
  } = {},
) {
  if (!subtle || typeof fetcher !== 'function' ||
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
  return Object.freeze({
    ...plan,
    status: 'BOUNDED_HISTORICAL_AND_CURRENT_SOURCES_MATCHED_READ_ONLY',
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
