import { createHash } from 'node:crypto';
import {
  noteFilePath, validatedNote, readVaultNoteBlob, MAX_VAULT_NOTE_BYTES,
} from './oge-vault-notes.js';
import {
  standaloneCapturePath, validatedStandaloneCapture, readVaultStandaloneBlob,
} from './oge-vault-standalone-captures.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from './oge-vault-backup-export.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E5/M73: complete *CURRENT committed* private GitHub snapshot of three
 * content resource types, bound to ONE signed owner/repo/branch/HEAD.
 *
 * This is NOT a complete Oge account backup: uncommitted encrypted drafts,
 * historical revisions, learning-progress metadata and legacy MongoDB
 * records are explicitly excluded. There is NO GitHub write or import here.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TYPES = Object.freeze([
  { key: 'notes', prefix: 'notes/', maxCount: 30000,
    maxSize: MAX_VAULT_NOTE_BYTES },
  { key: 'quickNotes', prefix: 'quick-notes/', maxCount: 300,
    maxSize: 32 * 1024 },
  { key: 'airNotes', prefix: 'airnotes/', maxCount: 300,
    maxSize: 32 * 1024 },
]);
const LIMIT = 30000;
const PARALLEL = 5;
export const MAX_VAULT_RESOURCE_BACKUP_BYTES = MAX_VAULT_BACKUP_EXPORT_BYTES;
export const VAULT_RESOURCE_BACKUP_COVERAGE = Object.freeze({
  notes: 'complete-current-github-head',
  quickNotes: 'complete-current-github-head',
  airNotes: 'complete-current-github-head',
  historicalRevisions: 'not-included',
  encryptedDrafts: 'not-included',
  legacyMongoNotes: 'not-included',
  learningProgress: 'not-included',
});
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const sameKeys = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') ===
  [...keys].sort().join(',');
const assertBound = (maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
      maxBytes > MAX_VAULT_RESOURCE_BACKUP_BYTES)
    throw new TypeError('Invalid complete-resource archive byte bound');
};

function canonicalEntry(type, row) {
  if (!sameKeys(row, type.key === 'notes' ?
    ['format', 'version', 'id', 'subjectId', 'heading', 'answer',
      'tags', 'favorite', 'updatedAt', 'createdAt', 'sha'] :
    ['format', 'version', 'id', 'content', 'title',
      'updatedAt', 'createdAt', 'sha']) ||
    !UUID.test(row.id || '') || !SHA.test(row.sha || ''))
    throw fail('vault-resource-backup-entry-invalid', 400);
  try {
    const original = { ...row };
    delete original.sha;
    const validated = type.key === 'notes'
      ? validatedNote(original, { id: row.id, now: row.updatedAt })
      : validatedStandaloneCapture(type.key === 'quickNotes'
        ? 'quick-notes' : 'airnotes', original,
      { id: row.id, now: row.updatedAt });
    if (JSON.stringify(validated) !== JSON.stringify(original) ||
        Buffer.byteLength(JSON.stringify(original), 'utf8') > type.maxSize)
      throw new TypeError('Noncanonical resource');
    return row;
  } catch { throw fail('vault-resource-backup-entry-invalid', 400); }
}

function inventoryPayload(archive) {
  return TYPES.flatMap((type) =>
    archive[type.key].map(({ id, sha }) => type.prefix + id + '.json:' + sha));
}
function inventoryDigest(archive) {
  return hash('oge-vault-current-resource-index-v1\n' +
    inventoryPayload(archive).join('\n') + '\n');
}
function contentPayload(archive) {
  const { archiveSha256: _archiveSha256, inventorySha256: _inventorySha256,
    ...payload } = archive;
  return payload;
}

/**
 * Offline read-only inspection. SHA-256 protects against accidental archive
 * corruption but is NOT authentication of who made the backup, GitHub owner
 * identity, or authorization to restore. The outer archive is never a
 * write-capable restore ticket.
 */
export function verifyVaultCurrentResourcesArchive(archive, {
  maxBytes = MAX_VAULT_RESOURCE_BACKUP_BYTES,
} = {}) {
  assertBound(maxBytes);
  if (!sameKeys(archive, [
    'format', 'version', 'scope', 'snapshot', 'treeSha',
    'totalNotes', 'totalQuickNotes', 'totalAirNotes',
    'coverage', 'notes', 'quickNotes', 'airNotes',
    'inventorySha256', 'archiveSha256', 'importable', 'completeAccountBackup',
  ]) || Buffer.byteLength(JSON.stringify(archive), 'utf8') > maxBytes ||
      archive.format !== 'oge-vault-current-resources-backup' ||
      archive.version !== 1 ||
      archive.scope !== 'current-github-notes-quick-notes-airnotes-only' ||
      !SHA.test(archive.snapshot || '') || !SHA.test(archive.treeSha || '') ||
      archive.importable !== false || archive.completeAccountBackup !== false ||
      !sameKeys(archive.coverage, Object.keys(VAULT_RESOURCE_BACKUP_COVERAGE)) ||
      Object.keys(VAULT_RESOURCE_BACKUP_COVERAGE).some((name) =>
        archive.coverage[name] !== VAULT_RESOURCE_BACKUP_COVERAGE[name]) ||
      !DIGEST.test(archive.inventorySha256 || '') ||
      !DIGEST.test(archive.archiveSha256 || ''))
    throw fail('vault-resource-backup-archive-invalid', 400);
  for (const type of TYPES) {
    const rows = archive[type.key], totalKey =
      type.key === 'notes' ? 'totalNotes' :
      type.key === 'quickNotes' ? 'totalQuickNotes' : 'totalAirNotes';
    if (!Array.isArray(rows) || rows.length > type.maxCount ||
        !Number.isSafeInteger(archive[totalKey]) ||
        archive[totalKey] !== rows.length)
      throw fail('vault-resource-backup-count-invalid', 400);
    let previous = null;
    for (const row of rows) {
      canonicalEntry(type, row);
      if (previous !== null && previous >= row.id)
        throw fail('vault-resource-backup-order-invalid', 400);
      previous = row.id;
    }
  }
  if (archive.inventorySha256 !== inventoryDigest(archive) ||
      archive.archiveSha256 !==
        hash(JSON.stringify({ ...contentPayload(archive),
          inventorySha256: archive.inventorySha256 })))
    throw fail('vault-resource-backup-integrity-invalid', 400);
  return Object.freeze({
    format: archive.format, snapshot: archive.snapshot,
    totalNotes: archive.totalNotes,
    totalQuickNotes: archive.totalQuickNotes,
    totalAirNotes: archive.totalAirNotes,
    inventorySha256: archive.inventorySha256,
    archiveSha256: archive.archiveSha256,
    inspectedCurrentResources: true, completeAccountBackup: false,
    authenticatedSource: false, sourceShaTrustedAsAuthorization: false,
    canRestore: false, canCommit: false, writesToMongo: false,
  });
}

function filesFromTree(entries) {
  if (!Array.isArray(entries) || entries.length > LIMIT)
    throw fail('vault-resource-backup-tree-incomplete');
  const found = Object.fromEntries(TYPES.map((type) => [type.key, []]));
  const seen = new Set();
  let knownBytes = 0;
  for (const item of entries) {
    if (typeof item?.path !== 'string' || !item.path)
      throw fail('vault-resource-backup-tree-invalid');
    // A directory root can be a Git tree, but ANY file/nested path beneath
    // the reserved three namespaces must be a canonical versioned JSON blob.
    const root = TYPES.find((type) => item.path === type.prefix.slice(0, -1));
    if (root) {
      if (item.type !== 'tree' || (item.mode !== undefined && item.mode !== '040000'))
        throw fail('vault-resource-backup-directory-invalid');
      continue;
    }
    const type = TYPES.find((candidate) => item.path.startsWith(candidate.prefix));
    if (!type) continue; // unrelated git metadata (Vault marker, README...)
    const id = item.path.slice(type.prefix.length, -5);
    const path = type.key === 'notes'
      ? (() => { try { return noteFilePath(id); } catch { return null; } })()
      : (() => {
        try { return standaloneCapturePath(type.key === 'quickNotes'
          ? 'quick-notes' : 'airnotes', id); }
        catch { return null; }
      })();
    if (!UUID.test(id) || path !== item.path ||
        item.type !== 'blob' ||
        (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') || seen.has(item.path) ||
        (item.size !== undefined && (!Number.isSafeInteger(item.size) ||
          item.size < 0 || item.size > type.maxSize)))
      throw fail('vault-resource-backup-tree-invalid');
    knownBytes += item.size ?? 0;
    seen.add(item.path);
    found[type.key].push({ id, sha: item.sha });
  }
  for (const type of TYPES) {
    if (found[type.key].length > type.maxCount)
      throw fail('vault-resource-backup-list-too-large', 413);
    found[type.key].sort((a, b) => a.id.localeCompare(b.id));
  }
  return { found, knownBytes };
}

/**
 * Read a single immutable HEAD, then its ONE complete recursive tree and
 * all three resource types from immutable blob SHAs. Every source record
 * is validated against exact path/type/schema and the originally indexed SHA.
 * The final HEAD read and owner/subject checks must succeed BEFORE download.
 *
 * No private content is persisted to MongoDB or a server-side backup queue.
 */
export async function exportVaultCurrentResourcesSnapshot(client, {
  subjectVerifier,
  noteReader = readVaultNoteBlob,
  standaloneReader = readVaultStandaloneBlob,
  maxBytes = MAX_VAULT_RESOURCE_BACKUP_BYTES,
} = {}) {
  assertBound(maxBytes);
  if (!client || typeof client.call !== 'function' ||
      client.readOnly !== true ||
      typeof client.branch !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(client.branch) ||
      client.branch.startsWith('-') || client.branch.includes('..') ||
      typeof subjectVerifier !== 'function' ||
      typeof noteReader !== 'function' ||
      typeof standaloneReader !== 'function')
    throw new TypeError('Signed read-only GitHub Vault source required');
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(head || ''))
    throw fail('vault-resource-backup-head-unavailable', 503);
  const commit = await client.call('/git/commits/' + head);
  const treeSha = commit?.tree?.sha;
  if (!SHA.test(treeSha || ''))
    throw fail('vault-resource-backup-tree-unavailable', 503);
  const response = await client.call('/git/trees/' + treeSha + '?recursive=1');
  if (response?.truncated === true)
    throw fail('vault-resource-backup-tree-incomplete');
  const { found, knownBytes } = filesFromTree(response?.tree);
  if (knownBytes > maxBytes)
    throw fail('vault-resource-backup-too-large', 413);

  const archive = {
    format: 'oge-vault-current-resources-backup', version: 1,
    scope: 'current-github-notes-quick-notes-airnotes-only',
    snapshot: head, treeSha,
    totalNotes: found.notes.length,
    totalQuickNotes: found.quickNotes.length,
    totalAirNotes: found.airNotes.length,
    coverage: { ...VAULT_RESOURCE_BACKUP_COVERAGE },
    notes: [], quickNotes: [], airNotes: [],
    importable: false, completeAccountBackup: false,
  };
  let consumedBytes = 1024;
  const subjects = new Set();
  for (const type of TYPES) {
    const files = found[type.key];
    for (let i = 0; i < files.length; i += PARALLEL) {
      const batch = files.slice(i, i + PARALLEL);
      const results = await Promise.all(batch.map(async ({ id, sha }) => {
        const resource = type.key === 'notes'
          ? await noteReader(client, id, sha)
          : await standaloneReader(client,
            type.key === 'quickNotes' ? 'quick-notes' : 'airnotes', id, sha);
        if (!resource || resource.id !== id || resource.sha !== sha)
          throw fail('vault-resource-backup-blob-sha-invalid');
        return canonicalEntry(type, resource);
      }));
      for (const record of results) {
        if (type.key === 'notes') subjects.add(record.subjectId);
        consumedBytes += Buffer.byteLength(JSON.stringify(record), 'utf8') + 5;
        if (consumedBytes > maxBytes)
          throw fail('vault-resource-backup-too-large', 413);
        archive[type.key].push(record);
      }
    }
  }
  if (!await subjectVerifier([...subjects].sort()))
    throw fail('vault-resource-backup-subject-unverified');

  if ((await client.call(refPath))?.object?.sha !== head)
    throw fail('vault-resource-backup-head-changed');
  archive.inventorySha256 = inventoryDigest(archive);
  archive.archiveSha256 = hash(JSON.stringify({
    ...archive, inventorySha256: archive.inventorySha256,
  }));
  verifyVaultCurrentResourcesArchive(archive, { maxBytes });
  return archive;
}
