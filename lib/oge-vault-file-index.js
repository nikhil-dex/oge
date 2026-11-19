import { noteFilePath, listVaultNotePage } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_FILE_INDEX_PREVIEW = 500;

function requireScope(identity) {
  const { ownerId, repoId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 120 ||
      !Number.isSafeInteger(repoId) || repoId < 1)
    throw new TypeError('Invalid Vault file-index scope');
  return { ownerId, repoId };
}

/**
 * B6: Scan only a COMPLETE, snapshot-pinned GitHub Notes listing.
 *
 * The reader validates note blobs before returning them, but this scanner
 * immediately discards all note text, titles, tags, and timestamps. The
 * resulting catalog is derivative metadata, NEVER authorization to write.
 * No MongoDB mutations occur in this module.
 */
export async function buildVaultFileIndexSnapshot(client, identity, {
  pageReader = listVaultNotePage,
  headReader = async (github) => (await github.call(
    '/git/ref/heads/' + encodeURIComponent(github.branch)))?.object?.sha,
  maxNotes = MAX_FILE_INDEX_PREVIEW,
} = {}) {
  const scope = requireScope(identity);
  if (!Number.isSafeInteger(maxNotes) || maxNotes < 1 ||
      maxNotes > MAX_FILE_INDEX_PREVIEW)
    throw new TypeError('Invalid Vault file-index bound');

  const files = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let snapshot = null;
  let total = null;
  do {
    const page = await pageReader(client, { cursor, limit: 25 });
    if (!page || !Array.isArray(page.notes) || page.notes.length > 25 ||
        !SHA.test(page.snapshot || '') ||
        !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.total > maxNotes ||
        (snapshot && page.snapshot !== snapshot) ||
        (total !== null && page.total !== total)) {
      throw new VaultGitHubError('vault-file-index-snapshot-invalid', 409);
    }
    snapshot = page.snapshot.toLowerCase();
    total = page.total;
    for (const note of page.notes) {
      if (!UUID.test(note?.id || '') || !UUID.test(note?.subjectId || '') ||
          !SHA.test(note?.sha || '') ||
          seenIds.has(note.id.toLowerCase())) {
        throw new VaultGitHubError('vault-file-index-note-invalid', 409);
      }
      const noteId = note.id.toLowerCase();
      seenIds.add(noteId);
      files.push({
        ownerId: scope.ownerId, repoId: scope.repoId,
        noteId, subjectId: note.subjectId.toLowerCase(),
        path: noteFilePath(noteId), blobSha: note.sha.toLowerCase(),
      });
    }
    if (files.length > total || (page.nextCursor && page.notes.length === 0) ||
        (!page.nextCursor && files.length !== total)) {
      throw new VaultGitHubError('vault-file-index-incomplete', 409);
    }
    cursor = page.nextCursor;
    if (cursor !== null && (typeof cursor !== 'string' ||
        !cursor || seenCursors.has(cursor)))
      throw new VaultGitHubError('vault-file-index-cursor-invalid', 409);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  const currentHead = await headReader(client);
  if (!SHA.test(currentHead || '') || currentHead.toLowerCase() !== snapshot)
    throw new VaultGitHubError('vault-file-index-head-changed', 409);
  files.sort((a, b) => a.noteId.localeCompare(b.noteId));
  return { ...scope, snapshot, totalNotes: total, files, advisoryOnly: true };
}

/**
 * Compare a verified GitHub snapshot with existing derivative MongoDB rows.
 * A missing GitHub file is a proposed tombstone, not a physical delete.
 * Never trust the old index for GitHub write authorization.
 */
export function diffVaultFileIndexSnapshot(snapshot, existing) {
  if (!snapshot || snapshot.advisoryOnly !== true ||
      !Array.isArray(snapshot.files) || !Array.isArray(existing))
    throw new TypeError('Invalid file-index comparison');
  const key = requireScope(snapshot);
  const github = new Map();
  for (const entry of snapshot.files) {
    if (entry.ownerId !== key.ownerId || entry.repoId !== key.repoId ||
        !UUID.test(entry.noteId || '') || !UUID.test(entry.subjectId || '') ||
        !SHA.test(entry.blobSha || '') || entry.path !== noteFilePath(entry.noteId) ||
        github.has(entry.noteId))
      throw new TypeError('Invalid GitHub file-index entry');
    github.set(entry.noteId, entry);
  }

  const rows = new Map();
  for (const row of existing) {
    if (row.ownerId !== key.ownerId || row.repoId !== key.repoId ||
        !UUID.test(row.noteId || '') || rows.has(row.noteId))
      throw new TypeError('Invalid existing file-index row');
    rows.set(row.noteId, row);
  }
  const upserts = [...github.values()].filter((entry) => {
    const previous = rows.get(entry.noteId);
    return !previous || previous.subjectId !== entry.subjectId ||
      previous.path !== entry.path || previous.blobSha !== entry.blobSha ||
      previous.status !== 'present';
  });
  const missing = [...rows.values()].filter((row) =>
    !github.has(row.noteId) && row.status !== 'missing').map((row) => row.noteId);
  return { upserts, missing, indexed: github.size,
    unchanged: github.size - upserts.length, advisoryOnly: true };
}
