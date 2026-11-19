import { listVaultNotePage } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN = 30000;

/**
 * Read-only, fail-closed deletion preflight. Do NOT delete the MongoDB
 * subject based on this snapshot: a concurrent writer may still add a note.
 */
export async function inspectVaultSubject(client, drafts, scope, {
  pageReader = listVaultNotePage, maxScan = MAX_SCAN,
} = {}) {
  if (typeof scope?.ownerId !== 'string' || !scope.ownerId ||
      !Number.isSafeInteger(scope.repoId) || scope.repoId < 1 ||
      !UUID.test(scope.subjectId || '') ||
      !Number.isSafeInteger(maxScan) || maxScan < 1 || maxScan > MAX_SCAN)
    throw new TypeError('Invalid subject deletion scope');
  const query = { ownerId: scope.ownerId, repoId: scope.repoId };
  // The subject is inside the encrypted draft. Query *all* pending drafts
  // for the owner/repo before allowing deletion, rather than trusting the
  // GitHub catalog or an incomplete subject-only metadata filter.
  const pending = await drafts.countDocuments(query, { limit: 1 });
  if (pending) return { safeToDelete: false, reason: 'pending-vault-drafts',
    pendingDrafts: true, githubNotes: null };

  let cursor = null;
  let snapshot = null;
  let count = 0;
  let pages = 0;
  const seenCursors = new Set();
  do {
    const page = await pageReader(client, { cursor, limit: 25 });
    if (!Array.isArray(page?.notes) || page.notes.length > 25 ||
        page.notes.some((note) => !UUID.test(note?.id || '') ||
          !UUID.test(note?.subjectId || '')) ||
        !/^[0-9a-f]{40}$/i.test(page.snapshot || '') ||
        !Number.isSafeInteger(page.total) || page.total < 0 ||
        (snapshot && page.snapshot !== snapshot)) {
      throw new VaultGitHubError('vault-subject-scan-invalid', 409);
    }
    if (!snapshot) snapshot = page.snapshot;
    count += page.notes.length;
    pages += 1;
    if (count > maxScan || pages > Math.ceil(maxScan / 25) + 1)
      throw new VaultGitHubError('vault-subject-scan-too-large', 409);
    if (count > page.total || (page.nextCursor && page.notes.length === 0) ||
        (!page.nextCursor && count !== page.total))
      throw new VaultGitHubError('vault-subject-scan-invalid', 409);
    if (page.notes.some((note) => note.subjectId === scope.subjectId))
      return { safeToDelete: false, reason: 'github-notes-exist',
        pendingDrafts: false, githubNotes: true };
    cursor = page.nextCursor;
    if (cursor !== null && (typeof cursor !== 'string' ||
        seenCursors.has(cursor))) throw new VaultGitHubError('vault-subject-scan-invalid', 409);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  // Read back pending state *after* GitHub scan to reduce the window where
  // a new autosave could make the earlier negative result stale.
  if (await drafts.countDocuments(query, { limit: 1 }))
    return { safeToDelete: false, reason: 'pending-vault-drafts',
      pendingDrafts: true, githubNotes: false };
  return { safeToDelete: true, reason: 'empty-at-snapshot',
    pendingDrafts: false, githubNotes: false, scannedNotes: count, snapshot };
}
