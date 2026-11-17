import {
  inspectVaultCurrentResourceFileLocally,
} from './oge-vault-current-resource-local-verify.js';

/**
 * E21/M89: the ONLY browser network action for live source comparison.
 * Triggered by an explicit operator file selection on a separately
 * default-OFF signed-owner staging screen. M88 MUST verify the entire
 * local file BEFORE this callback is allowed to send its metadata.
 * No file content, Note IDs/titles/answers, owner ID or auth token in body.
 *
 * A 200 server comparison is independently sourced from the signed
 * current GitHub HEAD, and is deliberately NOT a restore/lock ticket.
 */
const URL = '/api/vault/backup-current-resources/source-check';
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const invalid = () => { throw new TypeError(
  'Private current GitHub fingerprint check could not be completed'); };
function makeClaim(f) {
  if (!f || typeof f !== 'object' ||
      Object.keys(f).sort().join(',') !== [
        'snapshot', 'treeSha', 'archiveSha256', 'inventorySha256',
        'totalNotes', 'totalQuickNotes', 'totalAirNotes',
      ].sort().join(',') ||
      !SHA.test(f.snapshot || '') ||
      !SHA.test(f.treeSha || '') ||
      !HEX.test(f.archiveSha256 || '') ||
      !HEX.test(f.inventorySha256 || '') ||
      ![f.totalNotes, f.totalQuickNotes, f.totalAirNotes]
        .every(n => Number.isSafeInteger(n) && n >= 0))
    invalid();
  return {
    format: 'oge-vault-current-resources-source-claim',
    version: 1,
    confirmation: 'READ_ONLY_COMPARE_CURRENT_PRIVATE_GITHUB_SOURCE',
    ...f,
  };
}
const FIELDS = [
  'format','version','status',
  'currentGitHubSnapshotContentMatchedAtCheck',
  'compareAgainstCurrentHeadOnly','olderSnapshotsCanDifferWithoutBeingCorrupt',
  'authenticatedOwnerGitHubReadPerformedByServer',
  'fileContentsUploaded','privateNoteBodiesReturned','privateIdsOrShasReturned',
  'independentOfTrustedServerAndGitHubApp',
  'immutableHistoricalArchiveAuthenticated','fullAccountBackup',
  'encryptedDraftsIncluded','learningProgressIncluded',
  'canRestore','canAuthorizeImport','canReleaseImportLock',
  'canRetryUnknownWrite','productionReady','githubWritesPerformed',
  'mongodbNoteContentWritesPerformed',
];
const NEGATIVE = FIELDS.filter(key => ![
  'format','version','status','currentGitHubSnapshotContentMatchedAtCheck',
  'compareAgainstCurrentHeadOnly','olderSnapshotsCanDifferWithoutBeingCorrupt',
  'authenticatedOwnerGitHubReadPerformedByServer',
].includes(key));

async function compareMetadata(f, fetcher) {
  const claim = makeClaim(f);
  const response = await fetcher(URL, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(claim),
  });
  if (response?.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers?.get('content-type') || ''))
    invalid();
  const header = response.headers?.get('content-length');
  if (header !== null &&
      (!/^\d+$/.test(header) || Number(header) > 4096)) invalid();

  // Enforce a byte cap before JSON parsing; avoid unbounded response.text().
  if (!response.body || typeof response.body.getReader !== 'function') invalid();
  const reader = response.body.getReader();
  const parts = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      bytes += value.byteLength;
      if (bytes > 4096) {
        await reader.cancel().catch(() => {});
        invalid();
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const full = new Uint8Array(bytes); let offset = 0;
  for (const part of parts) { full.set(part, offset); offset += part.byteLength; }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(full));
  } catch { invalid(); }
  finally { full.fill(0); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== [...FIELDS].sort().join(',') ||
      data.format !== 'oge-vault-current-resources-source-comparison' ||
      data.version !== 1 ||
      data.compareAgainstCurrentHeadOnly !== true ||
      data.olderSnapshotsCanDifferWithoutBeingCorrupt !== true ||
      data.authenticatedOwnerGitHubReadPerformedByServer !== true ||
      NEGATIVE.some(key => data[key] !== false))
    invalid();
  const matched = data.currentGitHubSnapshotContentMatchedAtCheck;
  if (typeof matched !== 'boolean' ||
      data.status !== (matched
        ? 'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_MATCHES_READ_ONLY'
        : 'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_DIFFERS_HOLD'))
    invalid();

  // Deliberately return no uploaded archive metadata/hashes or private IDs.
  return Object.freeze({
    status: data.status, matched,
    authenticatedCurrentSourceCompared: true,
    onlyFingerprintMetadataTransmitted: true,
    archiveFileUploaded: false, restorationAuthorized: false,
    canReleaseImportLock: false,
  });
}

export async function inspectVaultCurrentResourceFileAndSource(
  file, {
    subtle = globalThis.crypto?.subtle,
    fetcher = globalThis.fetch,
  } = {},
) {
  if (typeof fetcher !== 'function') invalid();
  const verified = await inspectVaultCurrentResourceFileLocally(file, {
    subtle,
    onVerifiedFingerprint: f => compareMetadata(f, fetcher),
  });
  return Object.freeze({
    local: verified.localReport,
    source: verified.sourceReport,
  });
}
