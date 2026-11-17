import {
  assertVaultCurrentResourceSourceClaim,
  compareVaultCurrentResourceSourceClaim,
  vaultCurrentResourceSourceCheckAllowed,
} from './oge-vault-current-resource-source-verify.js';

/**
 * E24/M92 — read-only, owner-signed historical current-resource ARCHIVE
 * provenance for commits on a bounded single-parent private GitHub branch.
 * This does not cover all Git history, encrypted drafts or write permission.
 */
const CLAIM_FORMAT = 'oge-vault-historical-current-resources-source-claim';
const CONFIRM = 'READ_ONLY_VERIFY_BOUNDED_PRIVATE_GITHUB_HISTORY';
const HIST_FIELDS = [
  'format', 'version', 'confirmation', 'snapshot', 'treeSha',
  'archiveSha256', 'inventorySha256',
  'totalNotes', 'totalQuickNotes', 'totalAirNotes',
];
const invalid = () => { throw new TypeError('Invalid private history source claim'); };
const exact = (v, fields) => Boolean(v && typeof v === 'object' &&
  !Array.isArray(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(','));

export function vaultHistoricalResourceSourceCheckAllowed(env = {}, readiness) {
  return env.OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW === 'true' &&
    env.OGE_VAULT_RESTORE_SOURCE_PREVIEW === 'true' &&
    vaultCurrentResourceSourceCheckAllowed(env, readiness);
}

export function assertVaultHistoricalResourceSourceClaim(value) {
  if (!exact(value, HIST_FIELDS) ||
      value.format !== CLAIM_FORMAT || value.version !== 1 ||
      value.confirmation !== CONFIRM) invalid();
  // Exact M89 schema and count/hash checks, translated only in memory.
  assertVaultCurrentResourceSourceClaim({
    ...value,
    format: 'oge-vault-current-resources-source-claim',
    confirmation: 'READ_ONLY_COMPARE_CURRENT_PRIVATE_GITHUB_SOURCE',
  });
  return value;
}

export function buildVaultHistoricalResourceSourceClaim(archive) {
  const claim = {
    format: CLAIM_FORMAT,
    version: 1,
    confirmation: CONFIRM,
    snapshot: archive.snapshot,
    treeSha: archive.treeSha,
    archiveSha256: archive.archiveSha256,
    inventorySha256: archive.inventorySha256,
    totalNotes: archive.totalNotes,
    totalQuickNotes: archive.totalQuickNotes,
    totalAirNotes: archive.totalAirNotes,
  };
  assertVaultHistoricalResourceSourceClaim(claim);
  return Object.freeze(claim);
}

/** sourceArchive MUST originate from independently re-read owner GitHub. */
export function compareVaultHistoricalResourceSourceClaim(claim, sourceArchive) {
  assertVaultHistoricalResourceSourceClaim(claim);
  const internal = compareVaultCurrentResourceSourceClaim({
    ...claim,
    format: 'oge-vault-current-resources-source-claim',
    confirmation: 'READ_ONLY_COMPARE_CURRENT_PRIVATE_GITHUB_SOURCE',
  }, sourceArchive);
  const matched = internal.currentGitHubSnapshotContentMatchedAtCheck;
  return Object.freeze({
    format: 'oge-vault-historical-resource-source-comparison',
    version: 1,
    status: matched
      ? 'PRIVATE_GITHUB_BOUNDED_HISTORICAL_ARCHIVE_MATCH_READ_ONLY'
      : 'PRIVATE_GITHUB_HISTORICAL_ARCHIVE_DIFFERS_HOLD',
    historicalSourceMatchedAtCheck: matched,
    immutableHistoricalArchiveAuthenticated: matched,
    boundedSingleParentLineageVerified: true,
    maxAncestorEdges: 20,
    authenticatedOwnerGitHubReadPerformedByServer: true,
    completeAccountBackup: false,
    noteDataReturned: false,
    fileContentsUploaded: false,
    independentOfTrustedServerAndGitHubApp: false,
    canRestore: false,
    canAuthorizeImport: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    productionReady: false,
    githubWritesPerformed: false,
    mongodbNoteContentWritesPerformed: false,
  });
}
