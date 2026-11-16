import { createHash } from 'node:crypto';
import { scanVaultNotesSnapshotIndex } from './oge-vault-backup-export.js';
import { noteFilePath, readVaultNoteBlob } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const MAX_VAULT_BACKUP_CHUNK_NOTES = 64;
export const MAX_VAULT_BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PARALLEL_BLOBS = 5;
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A content-free, deterministic checksum of the FULL Git tree note inventory.
 * Callers must verify the same checksum, owner, snapshot, count and cursor
 * across every chunk. A checksum is an integrity signal, not authentication.
 */
export function vaultNotesInventorySha256(files) {
  if (!Array.isArray(files) ||
      files.some((item) => !UUID.test(item?.id || '') ||
        !SHA.test(item?.sha || '')))
    throw new TypeError('Invalid vault inventory metadata');
  const hash = createHash('sha256');
  hash.update('oge-vault-notes-inventory-v1\n');
  for (const item of files) hash.update(item.id + ':' + item.sha + '\n');
  return hash.digest('hex');
}

/**
 * A single read-only bounded PART of a signed owner's GitHub Notes backup.
 * Re-scan the complete Git tree every time; never use the 500-note Contents
 * listing or trust a caller-supplied Git SHA as a freely readable revision.
 *
 * Only the branch HEAD at request time is eligible. The follow-up cursor is
 * an exact, canonical note ID from that HEAD and MUST be accompanied by the
 * snapshot SHA from the prior response. Stale heads/missing IDs fail closed.
 *
 * This does NOT make any one response a complete backup, and there is no
 * automatic import of these chunks. Never store private note text in MongoDB.
 */
export async function exportVaultNotesSnapshotChunk(client, {
  snapshot = null, afterId = null,
  subjectVerifier, blobReader = readVaultNoteBlob,
  maxBytes = MAX_VAULT_BACKUP_CHUNK_BYTES,
} = {}) {
  if (typeof subjectVerifier !== 'function' ||
      typeof blobReader !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
      maxBytes > MAX_VAULT_BACKUP_CHUNK_BYTES ||
      !((snapshot === null && afterId === null) ||
        (typeof snapshot === 'string' && SHA.test(snapshot) &&
          typeof afterId === 'string' && UUID.test(afterId) &&
          noteFilePath(afterId) === 'notes/' + afterId + '.json')))
    throw new TypeError('Invalid signed Vault chunk request');

  const { head, refPath, files } = await scanVaultNotesSnapshotIndex(client);
  if (snapshot !== null && snapshot !== head)
    throw fail('vault-backup-chunk-snapshot-stale');
  const index = afterId === null
    ? -1 : files.findIndex((file) => file.id === afterId);
  if (afterId !== null && (index < 0 || index === files.length - 1))
    throw fail('vault-backup-chunk-cursor-invalid');

  const start = index + 1;
  const slice = files.slice(start, start + MAX_VAULT_BACKUP_CHUNK_NOTES);
  const noteCount = slice.length;
  const hasMore = start + noteCount < files.length;
  const notes = [];
  const subjects = new Set();
  for (let offset = 0; offset < slice.length; offset += MAX_PARALLEL_BLOBS) {
    const fetched = await Promise.all(
      slice.slice(offset, offset + MAX_PARALLEL_BLOBS)
        .map(async ({ id, sha }) => {
          const note = await blobReader(client, id, sha);
          if (!note || note.id !== id || note.sha !== sha ||
              !UUID.test(note.subjectId || ''))
            throw fail('vault-backup-chunk-blob-invalid');
          return note;
        }));
    for (const note of fetched) {
      subjects.add(note.subjectId);
      notes.push(note);
    }
  }

  if (!await subjectVerifier([...subjects].sort()))
    throw fail('vault-backup-chunk-subject-unverified');
  if ((await client.call(refPath))?.object?.sha !== head)
    throw fail('vault-backup-chunk-head-changed');

  const chunk = {
    format: 'oge-vault-notes-backup-chunk',
    version: 1, scope: 'current-github-notes-only',
    snapshot: head,
    totalNotes: files.length,
    inventorySha256: vaultNotesInventorySha256(files),
    offset: start,
    count: notes.length,
    afterId,
    nextAfterId: hasMore ? slice.at(-1).id : null,
    hasMore,
    coverage: {
      notes: 'partial-immutable-snapshot-chunk',
      historicalRevisions: 'not-included',
      quickNotes: 'not-included',
      airNotes: 'not-included',
      encryptedDrafts: 'not-included',
      learningProgress: 'not-included',
    },
    notes,
    chunkSha256: sha256(JSON.stringify(notes)),
    completeBackup: false,
    importableAsLegacyBackup: false,
  };
  if (Buffer.byteLength(JSON.stringify(chunk), 'utf8') > maxBytes)
    throw fail('vault-backup-chunk-too-large', 413);
  return chunk;
}
