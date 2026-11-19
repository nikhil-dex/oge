import { noteFilePath, listVaultNotePage } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_INVENTORY = 30000;

/**
 * Collect a COMPLETE, snapshot-pinned deletion manifest of metadata only.
 * This is advisory. It does not commit, update a subject, delete a draft,
 * or authorize later writes. The eventual destructive coordinator MUST
 * revalidate the complete manifest under its still-held subject lock.
 */
export async function planVaultSubjectDeletion(client, drafts, identity, {
  pageReader = listVaultNotePage,
  maxInventory = MAX_INVENTORY,
} = {}) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId <= 0 ||
      !UUID.test(subjectId || '') ||
      !Number.isSafeInteger(maxInventory) || maxInventory < 1 ||
      maxInventory > MAX_INVENTORY) throw new TypeError('Invalid deletion plan scope');

  // Draft contents are encrypted: fail closed for ANY pending draft in this
  // repository. This is conservative; no silent deletion is acceptable.
  const query = { ownerId, repoId };
  const pending = await drafts.countDocuments(query, { limit: 1 });
  if (pending) return { ready: false, reason: 'pending-vault-drafts',
    draftPresent: true, advisoryOnly: true, files: [] };

  const files = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let snapshot = null;
  let expectedTotal = null;
  let offset = 0;
  let cursor = null;
  do {
    const page = await pageReader(client, { cursor, limit: 25 });
    if (!page || !Array.isArray(page.notes) || page.notes.length > 25 ||
        !SHA.test(page.snapshot || '') ||
        !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.total > maxInventory ||
        (snapshot && page.snapshot !== snapshot) ||
        (expectedTotal !== null && expectedTotal !== page.total) ||
        page.notes.some((note) => !UUID.test(note?.id || '') ||
          !UUID.test(note?.subjectId || '') || !SHA.test(note?.sha || '') ||
          seenIds.has(note.id.toLowerCase()))) {
      throw new VaultGitHubError('vault-deletion-manifest-invalid', 409);
    }
    snapshot = page.snapshot;
    expectedTotal = page.total;
    for (const note of page.notes) {
      seenIds.add(note.id.toLowerCase());
      if (note.subjectId.toLowerCase() === subjectId.toLowerCase())
        files.push({ noteId: note.id.toLowerCase(),
          path: noteFilePath(note.id), sha: note.sha });
    }
    offset += page.notes.length;
    if (offset > expectedTotal ||
        (page.nextCursor && page.notes.length === 0) ||
        (!page.nextCursor && offset !== expectedTotal))
      throw new VaultGitHubError('vault-deletion-manifest-incomplete', 409);
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || seenCursors.has(cursor)))
      throw new VaultGitHubError('vault-deletion-manifest-cursor-invalid', 409);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  // Recheck after the read: a concurrent draft must invalidate the plan.
  if (await drafts.countDocuments(query, { limit: 1 }))
    return { ready: false, reason: 'pending-vault-drafts',
      draftPresent: true, advisoryOnly: true, files: [] };

  return { ready: true, reason: files.length ? 'notes-require-deletion' : 'empty-at-snapshot',
    draftPresent: false, advisoryOnly: true, snapshot, totalNotes: offset,
    files };
}
