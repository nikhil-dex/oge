/**
 * M92: the only browser POST for a fully M88-checked historical backup.
 * The caller MUST validate the whole local file before invoking this module.
 * No plaintext or resource IDs ever leave the browser.
 */
const URL = '/api/vault/backup-current-resources/history-check';
const invalid = () => { throw new TypeError(
  'Bounded private GitHub historical source check failed'); };
const CLAIM_FIELDS = [
  'snapshot', 'treeSha', 'archiveSha256', 'inventorySha256',
  'totalNotes', 'totalQuickNotes', 'totalAirNotes',
];
const RESPONSE_FIELDS = [
  'format','version','status','historicalSourceMatchedAtCheck',
  'immutableHistoricalArchiveAuthenticated',
  'boundedSingleParentLineageVerified','maxAncestorEdges',
  'authenticatedOwnerGitHubReadPerformedByServer','completeAccountBackup',
  'noteDataReturned','fileContentsUploaded',
  'independentOfTrustedServerAndGitHubApp',
  'canRestore','canAuthorizeImport','canReleaseImportLock',
  'canRetryUnknownWrite','productionReady','githubWritesPerformed',
  'mongodbNoteContentWritesPerformed',
];
const NEGATIVE = [
  'completeAccountBackup','noteDataReturned','fileContentsUploaded',
  'independentOfTrustedServerAndGitHubApp',
  'canRestore','canAuthorizeImport','canReleaseImportLock',
  'canRetryUnknownWrite','productionReady','githubWritesPerformed',
  'mongodbNoteContentWritesPerformed',
];
const exact = (value, fields) => Boolean(value &&
  typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(','));

export async function compareVaultHistoricalFingerprintToSource(
  fingerprint, fetcher = globalThis.fetch,
) {
  if (typeof fetcher !== 'function' || !exact(fingerprint, CLAIM_FIELDS) ||
      !/^[a-f0-9]{40}$/.test(fingerprint.snapshot || '') ||
      !/^[a-f0-9]{40}$/.test(fingerprint.treeSha || '') ||
      !/^[a-f0-9]{64}$/.test(fingerprint.archiveSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(fingerprint.inventorySha256 || '') ||
      !Number.isSafeInteger(fingerprint.totalNotes) ||
      fingerprint.totalNotes < 0 || fingerprint.totalNotes > 30000 ||
      !Number.isSafeInteger(fingerprint.totalQuickNotes) ||
      fingerprint.totalQuickNotes < 0 || fingerprint.totalQuickNotes > 300 ||
      !Number.isSafeInteger(fingerprint.totalAirNotes) ||
      fingerprint.totalAirNotes < 0 || fingerprint.totalAirNotes > 300) invalid();

  const claim = {
    format: 'oge-vault-historical-current-resources-source-claim',
    version: 1,
    confirmation: 'READ_ONLY_VERIFY_BOUNDED_PRIVATE_GITHUB_HISTORY',
    ...fingerprint,
  };
  const response = await fetcher(URL, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(claim),
  });
  if (response?.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers?.get('content-type') || '')) invalid();
  const length = response.headers?.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) ||
      Number(length) > 4096)) invalid();
  if (!response.body || typeof response.body.getReader !== 'function') invalid();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel().catch(() => {});
        invalid();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid(); }
  finally { bytes.fill(0); }

  if (!exact(report, RESPONSE_FIELDS) ||
      report.format !== 'oge-vault-historical-resource-source-comparison' ||
      report.version !== 1 ||
      report.boundedSingleParentLineageVerified !== true ||
      report.maxAncestorEdges !== 20 ||
      report.authenticatedOwnerGitHubReadPerformedByServer !== true ||
      NEGATIVE.some(key => report[key] !== false)) invalid();
  const matched = report.historicalSourceMatchedAtCheck;
  if (typeof matched !== 'boolean' ||
      report.immutableHistoricalArchiveAuthenticated !== matched ||
      report.status !== (matched
        ? 'PRIVATE_GITHUB_BOUNDED_HISTORICAL_ARCHIVE_MATCH_READ_ONLY'
        : 'PRIVATE_GITHUB_HISTORICAL_ARCHIVE_DIFFERS_HOLD')) invalid();

  return Object.freeze({
    matched,
    authenticatedBoundedHistoricalSource: matched,
    contentUploaded: false,
    restorationAuthorized: false,
    canReleaseImportLock: false,
  });
}
