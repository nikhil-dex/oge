import { noteFilePath, MAX_VAULT_BATCH_ITEMS } from './oge-vault-notes.js';
import { validateVaultNotesImportArchive, planVaultNotesImport } from './oge-vault-backup-import-plan.js';
import { commitVaultNoteBatch } from './oge-vault-batch.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[0-9a-f]{40}$/;
const APPROVAL = 'IMPORT_SELECTED_NEW_NOTES';
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const sameKeys = (value, expected) =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort());

/**
 * A fresh, explicit, create-only approval. Importing is NOT authorized by the
 * advisory planner alone. The owner must select at most one Git batch (12)
 * and submit the exact target HEAD previously displayed by the planner.
 * A later step always performs a second live conflict/draft/ownership check.
 */
export function validateVaultNotesImportApproval(request) {
  if (!sameKeys(request, ['archive', 'expectedTargetHead', 'selectedIds', 'confirmation']) ||
      request.confirmation !== APPROVAL ||
      typeof request.expectedTargetHead !== 'string' ||
      !SHA.test(request.expectedTargetHead) ||
      !Array.isArray(request.selectedIds) ||
      request.selectedIds.length < 1 ||
      request.selectedIds.length > MAX_VAULT_BATCH_ITEMS)
    throw fail('vault-import-approval-invalid', 400);

  const { notes } = validateVaultNotesImportArchive(request.archive);
  const all = new Map(notes.map((note) => [note.id, note]));
  const seen = new Set();
  const selected = [];
  for (const id of request.selectedIds) {
    try {
      if (noteFilePath(id).slice(6, -5) !== id || !all.has(id) || seen.has(id))
        throw new TypeError('Unapproved or duplicate note ID');
    } catch {
      throw fail('vault-import-selection-invalid', 400);
    }
    selected.push(all.get(id));
    seen.add(id);
  }
  return { archive: request.archive, expectedTargetHead: request.expectedTargetHead,
    selected, selectedIds: [...request.selectedIds] };
}

/**
 * This MUST be called under withVaultSubjectsWrite for ALL selected subjects.
 * The route must also provide a signed-owner/repository recheck immediately
 * before the write. No imported note text is stored in MongoDB, and neither
 * an existing GitHub note nor an encrypted unsynced draft is overwritten.
 * A GitHub ref mutation is never retried blindly after an unknown response.
 */
export async function executeApprovedVaultNotesImport(client, request, {
  subjectVerifier, pendingDraftIds, ownerVerifier,
  batchWriter = commitVaultNoteBatch,
} = {}) {
  const approval = validateVaultNotesImportApproval(request);
  if (!client || typeof client.call !== 'function' ||
      typeof subjectVerifier !== 'function' ||
      typeof pendingDraftIds !== 'function' ||
      typeof ownerVerifier !== 'function' ||
      typeof batchWriter !== 'function')
    throw new TypeError('Signed owner and import protections are required');

  // The plan returned here is deliberately advisory. Never trust an earlier
  // plan or a source SHA; recalculate from a fresh, complete target Git tree.
  const plan = await planVaultNotesImport(client, approval.archive, {
    subjectVerifier, pendingDraftIds,
  });
  if (plan.targetHead !== approval.expectedTargetHead)
    throw fail('vault-import-target-head-changed');
  const fresh = new Map(plan.entries.map((entry) => [entry.id, entry.outcome]));
  if (approval.selectedIds.some((id) => fresh.get(id) !== 'create-candidate'))
    throw fail('vault-import-selected-note-conflict');
  if (!await ownerVerifier())
    throw fail('vault-import-owner-or-repository-changed');

  const operations = approval.selected.map((note) => ({
    action: 'create', id: note.id, note,
  }));
  const committed = await batchWriter(client, operations, {
    expectedHead: approval.expectedTargetHead,
    preserveImportTimestamps: true,
  });
  if (!SHA.test(committed?.commitSha || '') ||
      !Array.isArray(committed?.results) ||
      committed.results.length !== approval.selected.length)
    throw fail('vault-import-commit-unconfirmed', 503);

  // Confirm exact canonical archive content, including original timestamps.
  // The underlying batch writer separately verifies GitHub HEAD, ancestry and
  // every committed blob; this guard protects the import adapter's contract.
  for (let i = 0; i < approval.selected.length; i++) {
    const expected = approval.selected[i];
    const actual = committed.results[i];
    if (!actual || actual.action !== 'create' ||
        typeof actual.sha !== 'string' || !SHA.test(actual.sha) ||
        Object.keys(expected).some((key) =>
          JSON.stringify(actual[key]) !== JSON.stringify(expected[key])))
      throw fail('vault-import-commit-unconfirmed', 503);
  }
  return {
    format: 'oge-vault-notes-import-result', version: 1,
    commitSha: committed.commitSha,
    importedIds: approval.selectedIds,
    importedCount: approval.selectedIds.length,
    remainingArchiveNotes: plan.summary.total - approval.selectedIds.length,
    overwritePerformed: false, encryptedDraftsChanged: false,
    scope: 'current-github-notes-only',
  };
}
