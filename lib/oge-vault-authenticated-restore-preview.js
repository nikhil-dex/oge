import {
  loadVaultRecoveryVerifiedFile,
  compareVaultRecoverySnapshots,
} from './oge-vault-restore-preview.js';
import {
  compareVaultVerifiedFingerprintToSource,
} from './oge-vault-current-resource-source-check-browser.js';

/**
 * M91 / E23 — authenticated CURRENT-reference restoration comparison.
 *
 * Select two separately labelled files. Both are locally checked with the
 * M88 canonical strict parser before *any* network call. ONLY the reference
 * archive's M89 metadata-only claim is sent to the already signed, read-only,
 * three-per-owner-per-hour private GitHub source endpoint.
 *
 * A match authenticates the entire reference archive against the CURRENT
 * owner's GitHub HEAD AT INSPECTION TIME. The candidate recovery backup
 * remains self-attested; older backup provenance is NOT established.
 * Never returns Note IDs, SHAs, titles, contents or either archive.
 */
export async function previewVaultAuthenticatedRecoveryFiles(
  backupFile, referenceFile, {
    subtle = globalThis.crypto?.subtle,
    fetcher = globalThis.fetch,
  } = {},
) {
  if (!subtle || typeof fetcher !== 'function' ||
      !backupFile || !referenceFile) {
    throw new TypeError('Authenticated restore preview requires two files');
  }
  const backup = await loadVaultRecoveryVerifiedFile(backupFile, subtle);
  const current = await loadVaultRecoveryVerifiedFile(referenceFile, subtle);
  const source = await compareVaultVerifiedFingerprintToSource({
    snapshot: current.snapshot,
    treeSha: current.treeSha,
    archiveSha256: current.archiveSha256,
    inventorySha256: current.inventorySha256,
    totalNotes: current.totalNotes,
    totalQuickNotes: current.totalQuickNotes,
    totalAirNotes: current.totalAirNotes,
  }, fetcher);

  if (!source.matched) {
    // A stale but intact reference is NOT corrupt; never show invented
    // authoritative conflict counts if current HEAD verification failed.
    return Object.freeze({
      status: 'CURRENT_GITHUB_REFERENCE_DIFFERED_HOLD',
      currentSnapshotAuthenticatedAtCheck: false,
      backupSourceAuthenticated: false,
      restorationAuthorized: false,
      canRestore: false,
      canAuthorizeImport: false,
      canReleaseImportLock: false,
      canRetryUnknownWrite: false,
      githubWritesPerformed: false,
      fileContentsUploaded: false,
      snapshotMayBecomeStaleAfterCheck: true,
    });
  }

  const plan = compareVaultRecoverySnapshots(backup, current);
  return Object.freeze({
    ...plan,
    status: 'CURRENT_GITHUB_REFERENCE_AUTHENTICATED_AT_CHECK_READ_ONLY',
    currentSnapshotAuthenticatedAtCheck: true,
    backupSourceAuthenticated: false,
    authenticatedGitHubReadPerformed: true,
    onlyReferenceFingerprintMetadataUploaded: true,
    snapshotMayBecomeStaleAfterCheck: true,
    // Difference from M90 local-only preview: exactly one M89 POST.
    networkRequestsPerformed: true,
    fileContentsUploaded: false,
    restorationAuthorized: false,
    canRestore: false,
    canAuthorizeImport: false,
    canDeleteExisting: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    githubWritesPerformed: false,
    privateNotesReturned: false,
  });
}
