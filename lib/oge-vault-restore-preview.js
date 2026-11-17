import { inspectVaultCurrentResourceArchiveLocally } from './oge-vault-current-resource-local-verify.js';

/**
 * M90: memory-only, NON-AUTHORITATIVE read-only restoration preview.
 * Each input must pass the full M88 canonical verifier. No network, persistence,
 * provider read/write or restore capability is present in this module.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const KINDS = Object.freeze([
  ['notes', 'Notes'],
  ['quickNotes', 'Quick Notes'],
  ['airNotes', 'AirNotes'],
]);
const refuse = () => { throw new TypeError('Restoration preview inputs are invalid'); };

export function compareVaultRecoverySnapshots(backup, current) {
  if (!backup || !current) refuse();
  const resources = KINDS.map(([key, label]) => {
    if (!Array.isArray(backup[key]) || !Array.isArray(current[key])) refuse();
    const existing = new Map();
    for (const row of current[key]) {
      if (typeof row?.id !== 'string' || typeof row.sha !== 'string' ||
          existing.has(row.id)) refuse();
      existing.set(row.id, row.sha);
    }
    let add = 0; let conflict = 0; let unchanged = 0;
    const seen = new Set();
    for (const row of backup[key]) {
      if (typeof row?.id !== 'string' || typeof row.sha !== 'string' ||
          seen.has(row.id)) refuse();
      seen.add(row.id);
      if (!existing.has(row.id)) add++;
      else if (existing.get(row.id) === row.sha) unchanged++;
      else conflict++;
    }
    const preserve = existing.size - unchanged - conflict;
    return Object.freeze({ key, label, add, conflict, unchanged, preserve });
  });
  return Object.freeze({
    format: 'oge-vault-read-only-restore-preview',
    version: 1,
    status: 'LOCAL_COMPARISON_ONLY_NOT_RESTORE_AUTHORIZATION',
    resources: Object.freeze(resources),
    totalAdd: resources.reduce((n, r) => n + r.add, 0),
    totalConflict: resources.reduce((n, r) => n + r.conflict, 0),
    totalUnchanged: resources.reduce((n, r) => n + r.unchanged, 0),
    totalPreserve: resources.reduce((n, r) => n + r.preserve, 0),
    backupSourceAuthenticated: false,
    currentSnapshotAuthenticated: false,
    canRestore: false,
    canAuthorizeImport: false,
    canDeleteExisting: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    githubWritesPerformed: false,
    networkRequestsPerformed: false,
    privateNotesReturned: false,
  });
}

async function loadVerified(file, subtle) {
  if (!file || !Number.isSafeInteger(file.size) ||
      file.size < 256 || file.size > MAX_BYTES ||
      typeof file.arrayBuffer !== 'function') refuse();
  const data = await file.arrayBuffer();
  if (!(data instanceof ArrayBuffer) || data.byteLength !== file.size) refuse();
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const archive = JSON.parse(raw);
  if (raw !== JSON.stringify(archive)) refuse();
  await inspectVaultCurrentResourceArchiveLocally(archive, { subtle });
  return archive;
}

/**
 * User selects exactly two files: backup FIRST, current resource snapshot SECOND.
 * Both are locally validated; current is NOT independently authenticated to GitHub.
 * Never put archives, file objects, IDs or hashes in React state.
 */
export async function previewVaultRecoveryFiles(files, {
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!files || files.length !== 2 || !subtle) refuse();
  const backup = await loadVerified(files[0], subtle);
  const current = await loadVerified(files[1], subtle);
  return compareVaultRecoverySnapshots(backup, current);
}
