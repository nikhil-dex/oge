import { noteFilePath, readVaultNoteBlob, MAX_VAULT_NOTE_BYTES } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NOTE_PREFIX = 'notes/';
const MAX_TREE_ENTRIES = 30000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_READS = 5;
export const MAX_VAULT_BACKUP_EXPORT_BYTES = MAX_EXPORT_BYTES;

const failure = (reason, status = 409) => new VaultGitHubError(reason, status);

/**
 * Phase D3b: export a COMPLETE current-GitHub-Notes snapshot (and explicitly
 * nothing else). This reader does not use the 500-note derivative index,
 * mutable Contents API, or MongoDB note content. Git tree verification and
 * the HEAD fence happen before any data is returned to the caller.
 *
 * A response-size bound is necessary for a single HTTP JSON export. A larger
 * vault is rejected rather than silently returning a partial archive; later
 * work can introduce verified cursor/chunk export with a signed manifest.
 */
export async function exportVaultNotesSnapshot(client, {
  blobReader = readVaultNoteBlob,
  maxBytes = MAX_EXPORT_BYTES,
  subjectVerifier,
} = {}) {
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
      maxBytes > MAX_EXPORT_BYTES ||
      typeof subjectVerifier !== 'function')
    throw new TypeError('Invalid GitHub Vault export options');

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(head || '')) throw failure('vault-backup-head-unavailable', 503);
  const commit = await client.call('/git/commits/' + head);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw failure('vault-backup-tree-unavailable', 503);
  const tree = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw failure('vault-backup-tree-incomplete');

  const files = [];
  const seen = new Set();
  let knownBlobBytes = 0;
  for (const item of tree.tree) {
    if (!item || typeof item.path !== 'string' || !item.path)
      throw failure('vault-backup-tree-incomplete');
    if (!item.path.startsWith(NOTE_PREFIX)) continue;
    // The notes/ namespace is exclusively reserved for note JSON blobs.
    // Reject all foreign paths, symlinks, subdirectories, or duplicate IDs.
    const noteId = item.path.slice(NOTE_PREFIX.length, -5);
    if (!item.path.endsWith('.json') || !UUID.test(noteId) ||
        noteFilePath(noteId) !== item.path ||
        item.type !== 'blob' ||
        (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') || seen.has(noteId) ||
        (item.size !== undefined &&
          (!Number.isSafeInteger(item.size) || item.size < 0 ||
            item.size > MAX_VAULT_NOTE_BYTES)))
      throw failure('vault-backup-note-tree-invalid');
    seen.add(noteId);
    // A GitHub tree can omit size. Exact JSON byte size is still checked
    // incrementally and again before publishing the archive.
    knownBlobBytes += item.size ?? 0;
    if (knownBlobBytes > maxBytes)
      throw failure('vault-backup-export-too-large', 413);
    files.push({ id: noteId, sha: item.sha.toLowerCase() });
  }
  files.sort((a, b) => a.id.localeCompare(b.id));

  const notes = [];
  let estimatedBytes = 512;
  const subjectIds = new Set();
  for (let offset = 0; offset < files.length; offset += MAX_CONCURRENT_READS) {
    const group = files.slice(offset, offset + MAX_CONCURRENT_READS);
    const results = await Promise.all(group.map(async ({ id, sha }) => {
      const note = await blobReader(client, id, sha);
      if (!note || note.id !== id || note.sha !== sha ||
          !UUID.test(note.subjectId || ''))
        throw failure('vault-backup-blob-invalid');
      return note;
    }));
    for (const note of results) {
      subjectIds.add(note.subjectId);
      estimatedBytes += Buffer.byteLength(JSON.stringify(note), 'utf8') + 5;
      if (estimatedBytes > maxBytes)
        throw failure('vault-backup-export-too-large', 413);
      notes.push(note);
    }
  }

  // Subjects are metadata-only MongoDB records. The caller checks that all
  // referenced subjects belong to this signed owner; missing ownership must
  // block export rather than leak or misclassify private note content.
  if (!await subjectVerifier([...subjectIds].sort()))
    throw failure('vault-backup-subject-unverified');

  if ((await client.call(refPath))?.object?.sha !== head)
    throw failure('vault-backup-head-changed');

  const archive = {
    format: 'oge-vault-notes-backup', version: 1,
    scope: 'current-github-notes-only',
    snapshot: head, totalNotes: notes.length,
    coverage: {
      notes: 'complete-at-snapshot',
      historicalRevisions: 'not-included',
      quickNotes: 'not-included',
      airNotes: 'not-included',
      encryptedDrafts: 'not-included',
      learningProgress: 'not-included',
    },
    notes,
  };
  if (Buffer.byteLength(JSON.stringify(archive), 'utf8') > maxBytes)
    throw failure('vault-backup-export-too-large', 413);
  return archive;
}
