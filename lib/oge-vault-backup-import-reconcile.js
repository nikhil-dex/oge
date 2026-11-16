import { validateVaultNotesImportApproval, approvedVaultImportCommitMessage } from './oge-vault-backup-import-commit.js';
import { noteFilePath, readVaultNoteBlob, MAX_VAULT_NOTE_BYTES } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/i;
const MAX_TREE_ENTRIES = 30000;
const error = (reason, status = 409) => new VaultGitHubError(reason, status);
const pending = (reason, approved) => ({
  format: 'oge-vault-notes-import-reconciliation', version: 1,
  confirmed: false, reason, importedCount: 0,
  selectedIds: approved.selectedIds, safeToRetryAutomatically: false,
  readOnly: true, encryptedDraftsChanged: false,
});

/**
 * Compare ALL immutable leaf entries in two complete Git trees. Git directory
 * entries legitimately change SHA when child files are created; they are not
 * independent content changes. Every non-tree entry is compared and duplicated
 * paths, incomplete lists or malformed note paths fail closed.
 */
function leafEntries(tree) {
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw error('vault-import-reconcile-tree-incomplete');
  const seen = new Set(), leaves = new Map();
  for (const entry of tree.tree) {
    if (!entry || typeof entry.path !== 'string' || !entry.path ||
        seen.has(entry.path) || !SHA.test(entry.sha || '') ||
        !['tree', 'blob', 'commit'].includes(entry.type))
      throw error('vault-import-reconcile-tree-invalid');
    seen.add(entry.path);
    if (entry.path.startsWith('notes/')) {
      const id = entry.path.slice(6, -5);
      let validPath = false;
      try {
        validPath = entry.path.endsWith('.json') && noteFilePath(id) === entry.path;
      } catch { /* malformed provider path */ }
      if (!validPath || entry.type !== 'blob' ||
          (entry.mode !== undefined && entry.mode !== '100644') ||
          (entry.size !== undefined && (!Number.isSafeInteger(entry.size) ||
            entry.size < 0 || entry.size > MAX_VAULT_NOTE_BYTES)))
        throw error('vault-import-reconcile-note-invalid');
    }
    if (entry.type !== 'tree')
      leaves.set(entry.path, { sha: entry.sha.toLowerCase(),
        type: entry.type, mode: entry.mode || null });
  }
  return leaves;
}
const sameLeaf = (left, right) => left && right &&
  left.sha === right.sha && left.mode === right.mode && left.type === right.type;

/**
 * Read-only cross-request check after an ambiguous GitHub import response.
 * Confirm only if the current, stable HEAD is a DIRECT child of the exact
 * approved HEAD, its immutable commit message contains the verified archive
 * fingerprint, all and only the approved note files were created, and every
 * selected immutable blob matches the original canonical note exactly.
 * If later GitHub commits have advanced HEAD, confirmation is intentionally
 * unknown rather than falsely claiming the import succeeded.
 */
export async function reconcileApprovedVaultNotesImport(client, request, {
  subjectVerifier, ownerVerifier, blobReader = readVaultNoteBlob,
} = {}) {
  const approved = validateVaultNotesImportApproval(request);
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      typeof subjectVerifier !== 'function' ||
      typeof ownerVerifier !== 'function' ||
      typeof blobReader !== 'function')
    throw new TypeError('Signed Vault import verification required');
  const subjects = [...new Set(approved.selected.map((note) => note.subjectId))];
  if (!await subjectVerifier(subjects))
    throw error('vault-import-reconcile-subject-unverified');

  const ref = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(ref))?.object?.sha;
  if (!SHA.test(head || ''))
    throw error('vault-import-reconcile-head-unavailable', 503);
  if (head === approved.expectedTargetHead) {
    if (!await ownerVerifier()) throw error('vault-import-reconcile-owner-changed');
    return pending('approved-head-unchanged', approved);
  }
  const commit = await client.call('/git/commits/' + head);
  if (!SHA.test(commit?.tree?.sha || '') ||
      !Array.isArray(commit?.parents) || commit.parents.length !== 1 ||
      (commit.parents[0]?.sha || commit.parents[0]) !== approved.expectedTargetHead ||
      commit?.message !== approvedVaultImportCommitMessage(approved)) {
    if (!await ownerVerifier()) throw error('vault-import-reconcile-owner-changed');
    return pending('head-not-the-approved-import-commit', approved);
  }
  const previous = await client.call('/git/commits/' + approved.expectedTargetHead);
  if (!SHA.test(previous?.tree?.sha || ''))
    throw error('vault-import-reconcile-base-tree-unavailable', 503);

  const [baseTree, currentTree] = await Promise.all([
    client.call('/git/trees/' + previous.tree.sha + '?recursive=1'),
    client.call('/git/trees/' + commit.tree.sha + '?recursive=1'),
  ]);
  const before = leafEntries(baseTree);
  const after = leafEntries(currentTree);
  const selectedPaths = new Set(approved.selected.map((note) => noteFilePath(note.id)));
  for (const path of selectedPaths) {
    if (before.has(path)) return pending('approved-note-existed-in-base', approved);
    const entry = after.get(path);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644')
      return pending('approved-note-missing-or-not-canonical', approved);
  }
  for (const [path, entry] of before) {
    if (selectedPaths.has(path)) continue;
    if (!sameLeaf(entry, after.get(path)))
      return pending('unrelated-content-changed', approved);
  }
  for (const path of after.keys()) {
    if (!selectedPaths.has(path) && !before.has(path))
      return pending('unrelated-content-created', approved);
  }

  for (let offset = 0; offset < approved.selected.length; offset += 4) {
    const items = approved.selected.slice(offset, offset + 4);
    const results = await Promise.all(items.map(async (expected) => {
      const target = after.get(noteFilePath(expected.id));
      const fetched = await blobReader(client, expected.id, target.sha);
      return { expected, target, fetched };
    }));
    for (const { expected, target, fetched } of results) {
      if (!fetched || fetched.sha !== target.sha || fetched.id !== expected.id ||
          Object.keys(expected).some((key) =>
            JSON.stringify(expected[key]) !== JSON.stringify(fetched[key])))
        return pending('imported-content-not-exact', approved);
    }
  }
  if ((await client.call(ref))?.object?.sha !== head)
    return pending('github-head-changed', approved);
  if (!await ownerVerifier()) throw error('vault-import-reconcile-owner-changed');

  return {
    format: 'oge-vault-notes-import-reconciliation', version: 1,
    confirmed: true, commitSha: head,
    selectedIds: approved.selectedIds, importedCount: approved.selectedIds.length,
    safeToRetryAutomatically: false, readOnly: true,
    encryptedDraftsChanged: false,
    scope: 'current-github-notes-only',
  };
}
