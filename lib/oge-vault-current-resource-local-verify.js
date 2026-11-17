import {
  validateVaultBrowserCanonicalNote,
} from './oge-vault-restore-local-chunks.js';
import {
  normalizeQuickNoteContent, quickNoteTitle,
} from './quick-notes.js';

/**
 * E20/M88: BROWSER-ONLY current-resource JSON backup consistency check.
 *
 * This is deliberately NOT an independent source-authentication proof:
 * archive SHA-256 values are supplied by the archive itself, GitHub blob
 * SHA-1 fields are not verified with a live provider, and a malicious
 * actor could forge a fully self-consistent archive. No import or write.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_BYTES = 32 * 1024;
const MAX_NOTES = 30000;
const MAX_STANDALONE = 300;
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OUTER_FIELDS = [
  'format', 'version', 'scope', 'snapshot', 'treeSha',
  'totalNotes', 'totalQuickNotes', 'totalAirNotes',
  'coverage', 'notes', 'quickNotes', 'airNotes',
  'inventorySha256', 'archiveSha256', 'importable', 'completeAccountBackup',
];
const COVERAGE = Object.freeze({
  notes: 'complete-current-github-head',
  quickNotes: 'complete-current-github-head',
  airNotes: 'complete-current-github-head',
  historicalRevisions: 'not-included',
  encryptedDrafts: 'not-included',
  legacyMongoNotes: 'not-included',
  learningProgress: 'not-included',
});
const KINDS = Object.freeze([
  ['notes', 'notes/', 'totalNotes', MAX_NOTES],
  ['quickNotes', 'quick-notes/', 'totalQuickNotes', MAX_STANDALONE],
  ['airNotes', 'airnotes/', 'totalAirNotes', MAX_STANDALONE],
]);
const STANDALONE_FIELDS = [
  'format', 'version', 'id', 'content', 'title',
  'createdAt', 'updatedAt', 'sha',
];
const encoder = new TextEncoder();
const reject = () => {
  throw new TypeError('Private Vault backup is invalid or does not match its embedded integrity values.');
};
const exact = (value, fields) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(','));
const canonicalTime = (value) => {
  if (typeof value !== 'string' || !TIME.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) reject();
};
const normalize = (record, withoutSha = false) => {
  const source = { ...record };
  if (withoutSha) delete source.sha;
  return source;
};
const sha256 = async (content, subtle) => {
  const result = await subtle.digest('SHA-256', encoder.encode(content));
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
};

function validateStandalone(row, kind) {
  if (!exact(row, STANDALONE_FIELDS) ||
      Object.keys(row).join(',') !== STANDALONE_FIELDS.join(',') ||
      row.format !== (kind === 'quickNotes'
        ? 'ogenotes-quick-note' : 'ogenotes-airnote') ||
      row.version !== 1 ||
      !UUID.test(row.id || '') || !SHA.test(row.sha || '') ||
      typeof row.content !== 'string' ||
      row.content.length > 20000 ||
      normalizeQuickNoteContent(row.content) !== row.content ||
      typeof row.title !== 'string' ||
      row.title !== quickNoteTitle(row.content)) reject();

  canonicalTime(row.createdAt);
  canonicalTime(row.updatedAt);
  if (Date.parse(row.createdAt) > Date.parse(row.updatedAt) ||
      encoder.encode(JSON.stringify(normalize(row, true))).byteLength >
      MAX_NOTE_BYTES) reject();
}

function validateRows(archive) {
  const inventoryRows = [];
  for (const [key, prefix, countKey, maxCount] of KINDS) {
    const rows = archive[key];
    if (!Array.isArray(rows) || rows.length > maxCount ||
        !Number.isSafeInteger(archive[countKey]) ||
        archive[countKey] !== rows.length) reject();
    let previous = null;
    for (const row of rows) {
      if (key === 'notes') {
        try { validateVaultBrowserCanonicalNote(row); }
        catch { reject(); }
      } else validateStandalone(row, key);
      if (!UUID.test(row.id || '') || !SHA.test(row.sha || '') ||
          (previous !== null && previous >= row.id)) reject();
      previous = row.id;
      inventoryRows.push(prefix + row.id + '.json:' + row.sha);
    }
  }
  return 'oge-vault-current-resource-index-v1\n' +
    inventoryRows.join('\n') + '\n';
}

/**
 * Verify an already-parsed archive, in ephemeral browser memory only.
 * Caller must enforce file byte limit BEFORE loading/JSON.parse.
 * Nothing from the archive's private Notes or IDs is returned.
 */
export async function inspectVaultCurrentResourceArchiveLocally(
  archive, { subtle = globalThis.crypto?.subtle } = {},
) {
  if (!subtle || typeof subtle.digest !== 'function' ||
      !exact(archive, OUTER_FIELDS) ||
      encoder.encode(JSON.stringify(archive)).byteLength > MAX_BYTES ||
      archive.format !== 'oge-vault-current-resources-backup' ||
      archive.version !== 1 ||
      archive.scope !== 'current-github-notes-quick-notes-airnotes-only' ||
      !SHA.test(archive.snapshot || '') ||
      !SHA.test(archive.treeSha || '') ||
      !HEX.test(archive.inventorySha256 || '') ||
      !HEX.test(archive.archiveSha256 || '') ||
      !exact(archive.coverage, Object.keys(COVERAGE)) ||
      Object.keys(COVERAGE).some(key => archive.coverage[key] !== COVERAGE[key]) ||
      archive.importable !== false ||
      archive.completeAccountBackup !== false) reject();

  const inventory = validateRows(archive);
  if (await sha256(inventory, subtle) !== archive.inventorySha256)
    reject();

  // Rebuild in exact M73 contentPayload order: hash fields are removed,
  // then inventorySha256 is appended. No resource bodies leave this module.
  const { archiveSha256: _archiveHash,
    inventorySha256: _inventoryHash, ...content } = archive;
  const whole = JSON.stringify({
    ...content, inventorySha256: archive.inventorySha256,
  });
  if (await sha256(whole, subtle) !== archive.archiveSha256) reject();

  return Object.freeze({
    format: 'oge-vault-current-resources-local-check',
    version: 1,
    status: 'LOCAL_EMBEDDED_HASHES_MATCH_SOURCE_UNAUTHENTICATED',
    totalNotes: archive.totalNotes,
    totalQuickNotes: archive.totalQuickNotes,
    totalAirNotes: archive.totalAirNotes,
    completeCurrentResourceInventoryInFile: true,
    embeddedInventorySha256Matched: true,
    embeddedArchiveSha256Matched: true,
    sourceAuthenticated: false,
    gitBlobShaVerifiedAgainstGitHub: false,
    immutableGitHeadIndependentlyVerified: false,
    privateGitHubRepoOwnershipVerified: false,
    fullAccountBackup: false,
    historicalRevisionsIncluded: false,
    encryptedDraftsIncluded: false,
    legacyMongoNotesIncluded: false,
    learningProgressIncluded: false,
    canRestore: false,
    canAuthorizeImport: false,
    canReleaseImportLock: false,
    safeToRetryAutomatically: false,
    networkRequestsPerformed: false,
    serverUploadsPerformed: false,
    browserPersistentStorageWritesPerformed: false,
    notesOrIdentifiersReturned: false,
  });
}

/**
 * A user-selected File is held ONLY within the calling function.
 * Validate size before read, and verify complete UTF-8 bytes prior to parse.
 * No URL, fetch(), localStorage, upload or server call.
 */
export async function inspectVaultCurrentResourceFileLocally(
  file, { subtle = globalThis.crypto?.subtle } = {},
) {
  if (!file || !Number.isSafeInteger(file.size) ||
      file.size < 256 || file.size > MAX_BYTES ||
      typeof file.arrayBuffer !== 'function') reject();
  let bytes;
  let parsed;
  try {
    const source = await file.arrayBuffer();
    if (!(source instanceof ArrayBuffer) ||
        source.byteLength !== file.size ||
        source.byteLength > MAX_BYTES) reject();
    bytes = new Uint8Array(source);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    // Refuse noncanonical JSON representation, including duplicate keys or
    // extra trailing content. The server's Response.json uses JSON.stringify.
    if (text !== JSON.stringify(parsed)) reject();
    return await inspectVaultCurrentResourceArchiveLocally(parsed, { subtle });
  } catch { reject(); }
  finally {
    // Best effort: mutable copied/borrowed ArrayBuffer bytes are cleared;
    // immutable JS strings/parsed data may persist until browser GC.
    bytes?.fill(0);
    parsed = null;
  }
}
