import { noteFilePath, readVaultNoteBlob } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
export const MAX_INDEX_TREE_ENTRIES = 30000;
export const MAX_INDEX_CHANGED_BLOBS = 500;

function scope(identity) {
  if (typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId < 1)
    throw new TypeError('Invalid Vault file index scope');
  return { ownerId: identity.ownerId, repoId: identity.repoId };
}

/**
 * Incremental index scan pinned to a GitHub commit. The only network reads
 * besides the Git tree are the blobs whose SHA is not already indexed.
 * No heading, answer, tags or note body is returned or persisted.
 *
 * The Git tree endpoint has its own bounded size and truncated flag.
 * More than MAX_INDEX_CHANGED_BLOBS changed/unindexed files deliberately
 * requires a future resumable bootstrap; never publish a partial index.
 */
export async function buildIncrementalVaultFileIndexSnapshot(client, identity, {
  existingRows = [], reader = readVaultNoteBlob,
  maxChanged = MAX_INDEX_CHANGED_BLOBS,
} = {}) {
  const key = scope(identity);
  if (!Array.isArray(existingRows) ||
      existingRows.length > MAX_INDEX_TREE_ENTRIES ||
      !Number.isSafeInteger(maxChanged) || maxChanged < 1 ||
      maxChanged > MAX_INDEX_CHANGED_BLOBS)
    throw new TypeError('Invalid incremental index parameters');

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const ref = await client.call(refPath);
  const snapshot = ref?.object?.sha;
  if (!SHA.test(snapshot || ''))
    throw new VaultGitHubError('vault-file-index-head-unavailable', 409);
  const commit = await client.call('/git/commits/' + snapshot);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw new VaultGitHubError('vault-file-index-tree-unavailable', 409);
  const directory = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(directory?.tree) || directory.truncated === true ||
      directory.tree.length > MAX_INDEX_TREE_ENTRIES)
    throw new VaultGitHubError('vault-file-index-tree-too-large', 409);

  const indexed = new Map();
  for (const row of existingRows) {
    if (row?.ownerId !== key.ownerId || row.repoId !== key.repoId ||
        !NOTE_ID.test(row.noteId || '') || indexed.has(row.noteId))
      throw new VaultGitHubError('vault-file-index-cache-invalid', 409);
    indexed.set(row.noteId, row);
  }

  const seen = new Set();
  const files = [];
  const changes = [];
  for (const entry of directory.tree) {
    if (typeof entry?.path !== 'string' || !entry.path.startsWith('notes/')) continue;
    // Folder entries are allowed only as the top-level notes/ directory.
    if (entry.path === 'notes' || entry.path === 'notes/') continue;
    if (entry.type !== 'blob' ||
        !/^notes\/[a-f0-9-]{36}\.json$/.test(entry.path) ||
        !SHA.test(entry.sha || '') ||
        (entry.size !== undefined && (!Number.isSafeInteger(entry.size) ||
          entry.size > 32768)))
      throw new VaultGitHubError('vault-file-index-tree-invalid', 409);
    const noteId = entry.path.slice(6, -5);
    if (!NOTE_ID.test(noteId) || seen.has(noteId))
      throw new VaultGitHubError('vault-file-index-tree-invalid', 409);
    seen.add(noteId);
    const stored = indexed.get(noteId);
    const row = { ...key, noteId, path: noteFilePath(noteId),
      blobSha: entry.sha.toLowerCase() };
    if (stored?.status === 'present' && stored.path === row.path &&
        stored.blobSha === row.blobSha && NOTE_ID.test(stored.subjectId || '') &&
        stored.subjectId === stored.subjectId.toLowerCase()) {
      files.push({ ...row, subjectId: stored.subjectId });
    } else {
      changes.push(row);
    }
  }
  if (changes.length > maxChanged)
    throw new VaultGitHubError('vault-file-index-bootstrap-batch-required', 409);

  // Five concurrent immutable blob reads per batch. An unknown or malformed
  // note fails closed instead of writing a guessed subject ID to MongoDB.
  for (let i = 0; i < changes.length; i += 5) {
    const batch = changes.slice(i, i + 5);
    const notes = await Promise.all(batch.map(async (row) => {
      const note = await reader(client, row.noteId, row.blobSha);
      if (note?.id !== row.noteId || !NOTE_ID.test(note?.subjectId || '') ||
          note.sha !== row.blobSha)
        throw new VaultGitHubError('vault-file-index-note-invalid', 409);
      return { ...row, subjectId: note.subjectId.toLowerCase() };
    }));
    files.push(...notes);
  }

  const latest = (await client.call(refPath))?.object?.sha;
  if (latest !== snapshot)
    throw new VaultGitHubError('vault-file-index-head-changed', 409);
  files.sort((a, b) => a.noteId.localeCompare(b.noteId));
  return { ...key, snapshot, totalNotes: files.length, files,
    reusedFiles: files.length - changes.length, changedBlobs: changes.length,
    advisoryOnly: true };
}
