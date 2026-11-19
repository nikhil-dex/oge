import { timingSafeEqual } from 'node:crypto';
import { vaultRecoveryCenterStagingAllowed } from './oge-vault-recovery-center.js';
import {
  verifyVaultCurrentResourcesArchive,
} from './oge-vault-backup-current-resources.js';

/**
 * E21/M89: independent live GitHub-backed snapshot fingerprint comparison.
 *
 * Browser supplies ONLY SHA256 hashes, two Git commit IDs and THREE counts
 * after completing M88 canonical local-file verification. The server's
 * signed owner + contents:read GitHub App creates a fresh M73 archive from
 * the CURRENT immutable HEAD. That archive never leaves the server and
 * its Note contents are not sent back to the client.
 *
 * A successful comparison binds these exact local archive digest bytes to
 * the CURRENT authenticated GitHub source at read time (subject to trust in
 * server, GitHub App, SHA256 and HTTPS), NOT an older historical snapshot,
 * NOT full account backup, and NEVER a restore/write/lock-release ticket.
 */
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CLAIM_FIELDS = [
  'format', 'version', 'confirmation', 'snapshot', 'treeSha',
  'archiveSha256', 'inventorySha256',
  'totalNotes', 'totalQuickNotes', 'totalAirNotes',
];
const CONFIRM = 'READ_ONLY_COMPARE_CURRENT_PRIVATE_GITHUB_SOURCE';
const reject = () => { throw new TypeError(
  'Invalid current private GitHub source comparison fingerprint'); };
const exact = (value, fields) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(','));
const equal = (left, right) => (
  typeof left === 'string' && typeof right === 'string' &&
  HEX64.test(left) && HEX64.test(right) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
);
const SCOPED_GATE = [
  'OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW',
  'OGE_VAULT_BACKUP_EXPORT_PREVIEW',
  'OGE_VAULT_STANDALONE_PREVIEW',
];
export function vaultCurrentResourceSourceCheckAllowed(
  env = {}, readiness,
) {
  return env.OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW === 'true' &&
    SCOPED_GATE.every(key => env[key] === 'true') &&
    vaultRecoveryCenterStagingAllowed(env, readiness);
}

export function assertVaultCurrentResourceSourceClaim(claim) {
  if (!exact(claim, CLAIM_FIELDS) ||
      claim.format !== 'oge-vault-current-resources-source-claim' ||
      claim.version !== 1 || claim.confirmation !== CONFIRM ||
      !HEX40.test(claim.snapshot || '') ||
      !HEX40.test(claim.treeSha || '') ||
      !HEX64.test(claim.archiveSha256 || '') ||
      !HEX64.test(claim.inventorySha256 || '') ||
      !Number.isSafeInteger(claim.totalNotes) ||
      claim.totalNotes < 0 || claim.totalNotes > 30000 ||
      !Number.isSafeInteger(claim.totalQuickNotes) ||
      claim.totalQuickNotes < 0 || claim.totalQuickNotes > 300 ||
      !Number.isSafeInteger(claim.totalAirNotes) ||
      claim.totalAirNotes < 0 || claim.totalAirNotes > 300)
    reject();
  return claim;
}

export function buildVaultCurrentResourceSourceClaim(archive) {
  // Called only from the M88 local verifier after canonical JSON SHA256
  // validation. This shape contains no resource IDs or Note content.
  const claim = {
    format: 'oge-vault-current-resources-source-claim',
    version: 1, confirmation: CONFIRM,
    snapshot: archive.snapshot, treeSha: archive.treeSha,
    archiveSha256: archive.archiveSha256,
    inventorySha256: archive.inventorySha256,
    totalNotes: archive.totalNotes,
    totalQuickNotes: archive.totalQuickNotes,
    totalAirNotes: archive.totalAirNotes,
  };
  assertVaultCurrentResourceSourceClaim(claim);
  return Object.freeze(claim);
}

export function compareVaultCurrentResourceSourceClaim(
  untrustedClaim, sourceArchive,
) {
  const claim = assertVaultCurrentResourceSourceClaim(untrustedClaim);
  // The server generated sourceArchive only through the existing M73
  // read-only owner-scoped GitHub App exporter. Validate its own canonical
  // SHA-256 fields before comparing untrusted user metadata.
  verifyVaultCurrentResourcesArchive(sourceArchive);
  const matched =
    claim.snapshot === sourceArchive.snapshot &&
    claim.treeSha === sourceArchive.treeSha &&
    equal(claim.archiveSha256, sourceArchive.archiveSha256) &&
    equal(claim.inventorySha256, sourceArchive.inventorySha256) &&
    claim.totalNotes === sourceArchive.totalNotes &&
    claim.totalQuickNotes === sourceArchive.totalQuickNotes &&
    claim.totalAirNotes === sourceArchive.totalAirNotes;

  return Object.freeze({
    format: 'oge-vault-current-resources-source-comparison',
    version: 1,
    status: matched
      ? 'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_MATCHES_READ_ONLY'
      : 'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_DIFFERS_HOLD',
    currentGitHubSnapshotContentMatchedAtCheck: matched,
    compareAgainstCurrentHeadOnly: true,
    olderSnapshotsCanDifferWithoutBeingCorrupt: true,
    authenticatedOwnerGitHubReadPerformedByServer: true,
    fileContentsUploaded: false,
    privateNoteBodiesReturned: false,
    privateIdsOrShasReturned: false,
    independentOfTrustedServerAndGitHubApp: false,
    immutableHistoricalArchiveAuthenticated: false,
    fullAccountBackup: false,
    encryptedDraftsIncluded: false,
    learningProgressIncluded: false,
    canRestore: false,
    canAuthorizeImport: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    productionReady: false,
    githubWritesPerformed: false,
    mongodbNoteContentWritesPerformed: false,
  });
}
