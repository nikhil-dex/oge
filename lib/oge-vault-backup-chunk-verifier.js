import { createHash } from 'node:crypto';
import { MAX_VAULT_NOTE_BYTES, noteFilePath, validatedNote } from './oge-vault-notes.js';
import { MAX_VAULT_BACKUP_CHUNK_NOTES } from './oge-vault-backup-export-chunk.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_NOTES = 30000;
const CANONICAL_NOTE_KEYS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
].sort();
const reject = () => { throw new TypeError('Invalid or incomplete Vault chunk backup sequence'); };

function canonicalNote(note) {
  try {
    if (!note || typeof note !== 'object' || Array.isArray(note) ||
        !SHA.test(note.sha || '') ||
        JSON.stringify(Object.keys(note).sort()) !==
          JSON.stringify(CANONICAL_NOTE_KEYS))
      reject();
    noteFilePath(note.id);
    const checked = validatedNote(note, { id: note.id, now: note.updatedAt });
    if (Object.keys(checked).some((key) =>
      JSON.stringify(checked[key]) !== JSON.stringify(note[key])) ||
        Buffer.byteLength(JSON.stringify(note), 'utf8') > MAX_VAULT_NOTE_BYTES + 80)
      reject();
  } catch { reject(); }
}

/**
 * Streaming, memory-bounded verifier for a set of downloaded Notes chunks.
 * It retains SHA-256 state and counters only, never the note text. A complete
 * result verifies all pages of ONE snapshot were received in order with
 * matching count/inventory hashes; it is NOT an import approval or a claim
 * about unsupported resource types, provider identity or future HEAD state.
 */
export function createVaultNotesChunkSequenceVerifier() {
  let snapshot = null, inventorySha256 = null, totalNotes = null;
  let nextOffset = 0, lastId = null, finished = false, pages = 0;
  const inventory = createHash('sha256');
  inventory.update('oge-vault-notes-inventory-v1\n');

  function accept(chunk) {
    if (finished || !chunk || typeof chunk !== 'object' ||
        Array.isArray(chunk) ||
        chunk.format !== 'oge-vault-notes-backup-chunk' ||
        chunk.version !== 1 || chunk.scope !== 'current-github-notes-only' ||
        !SHA.test(chunk.snapshot || '') ||
        !DIGEST.test(chunk.inventorySha256 || '') ||
        !DIGEST.test(chunk.chunkSha256 || '') ||
        !Number.isSafeInteger(chunk.totalNotes) || chunk.totalNotes < 0 ||
        chunk.totalNotes > MAX_NOTES ||
        !Number.isSafeInteger(chunk.offset) || chunk.offset !== nextOffset ||
        !Number.isSafeInteger(chunk.count) ||
        chunk.count < 0 || chunk.count > MAX_VAULT_BACKUP_CHUNK_NOTES ||
        !Array.isArray(chunk.notes) || chunk.notes.length !== chunk.count ||
        chunk.completeBackup !== false ||
        chunk.importableAsLegacyBackup !== false ||
        typeof chunk.hasMore !== 'boolean' ||
        chunk.hasMore !== (chunk.offset + chunk.count < chunk.totalNotes) ||
        (chunk.count === 0 && chunk.totalNotes !== 0) ||
        (chunk.count > 0 && chunk.count !== Math.min(
          MAX_VAULT_BACKUP_CHUNK_NOTES, chunk.totalNotes - chunk.offset)) ||
        chunk.afterId !== lastId ||
        (pages > 0 && (chunk.snapshot !== snapshot ||
          chunk.inventorySha256 !== inventorySha256 ||
          chunk.totalNotes !== totalNotes)) ||
        (chunk.hasMore ? chunk.nextAfterId !== chunk.notes.at(-1)?.id
          : chunk.nextAfterId !== null) ||
        !chunk.coverage ||
        chunk.coverage.notes !== 'partial-immutable-snapshot-chunk' ||
        Object.entries(chunk.coverage).some(([key, value]) =>
          key !== 'notes' && value !== 'not-included') ||
        Object.keys(chunk.coverage).sort().join(',') !==
          'airNotes,encryptedDrafts,historicalRevisions,learningProgress,notes,quickNotes' ||
        createHash('sha256').update(JSON.stringify(chunk.notes)).digest('hex') !==
          chunk.chunkSha256)
      reject();

    // Perform every validation before mutating accumulator state.
    let orderedPrevious = lastId;
    for (const note of chunk.notes) {
      canonicalNote(note);
      if (orderedPrevious !== null && note.id <= orderedPrevious) reject();
      orderedPrevious = note.id;
    }

    if (pages === 0) {
      snapshot = chunk.snapshot;
      inventorySha256 = chunk.inventorySha256;
      totalNotes = chunk.totalNotes;
    }
    for (const note of chunk.notes)
      inventory.update(note.id + ':' + note.sha + '\n');
    nextOffset += chunk.count;
    lastId = orderedPrevious;
    pages++;
    finished = !chunk.hasMore;
    return { accepted: true, complete: finished, pages, notesReceived: nextOffset };
  }

  function finish() {
    if (!finished || !pages || nextOffset !== totalNotes ||
        inventory.digest('hex') !== inventorySha256)
      reject();
    return {
      format: 'oge-vault-notes-chunk-sequence-verification',
      version: 1, verifiedCompleteNotesSnapshot: true,
      snapshot, totalNotes, pages, inventorySha256,
      includesHistoricalRevisions: false, includesQuickNotes: false,
      includesAirNotes: false, includesEncryptedDrafts: false,
      notAnImportApproval: true, privateTextStored: false,
    };
  }
  return { accept, finish };
}
