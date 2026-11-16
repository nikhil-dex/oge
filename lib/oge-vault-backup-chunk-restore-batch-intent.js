import { createHash } from 'node:crypto';
import { scanVaultNotesSnapshotIndex } from './oge-vault-backup-export.js';
import { verifyVaultNotesChunkGitHubSourceReadOnly } from './oge-vault-backup-chunk-source-proof.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { MAX_VAULT_BATCH_ITEMS } from './oge-vault-notes.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXACT_KEYS = ['confirmation', 'expectedSourceInventorySha256',
  'expectedSourceSnapshot', 'expectedTargetHead', 'selectedIds'].sort();
const CONFIRMATION = 'PREPARE_CREATE_ONLY_RESTORE_BATCH';
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);

/**
 * A deliberately NON-authorizing, content-free owner selection. Approval
 * for actual GitHub mutation MUST be a distinct signed action later, with
 * its own durable recovery semantics. This read-only request cannot trigger
 * GitHub writes, no matter how the caller constructs it.
 */
export function validateVaultChunkRestoreBatchSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXACT_KEYS) ||
      value.confirmation !== CONFIRMATION ||
      !SHA.test(value.expectedSourceSnapshot || '') ||
      !SHA.test(value.expectedTargetHead || '') ||
      !DIGEST.test(value.expectedSourceInventorySha256 || '') ||
      !Array.isArray(value.selectedIds) ||
      value.selectedIds.length < 1 ||
      value.selectedIds.length > MAX_VAULT_BATCH_ITEMS ||
      value.selectedIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(value.selectedIds).size !== value.selectedIds.length)
    throw fail('vault-chunk-batch-selection-invalid', 400);
  return {
    selectedIds: [...value.selectedIds],
    expectedSourceSnapshot: value.expectedSourceSnapshot,
    expectedSourceInventorySha256: value.expectedSourceInventorySha256,
    expectedTargetHead: value.expectedTargetHead,
  };
}

/**
 * M57: Builds a bounded, content-free, NON-WRITING restore batch INTENT.
 * Source and target are the same signed connected private GitHub Vault;
 * only 0-20 step historical recovery is supported. Cross-account restores
 * and disconnected source repos are deliberately NOT available.
 *
 * Every source note (up to 1024) must match a real immutable Git blob before
 * target planning. At most 12 *selected* subject IDs/draft IDs are inspected
 * on the target. The candidate is freshly pinned to current Git HEAD,
 * non-overwriting, and must survive another independent execution/approval
 * step (not implemented). Not a commit token, capability, or permission.
 */
export async function prepareVaultChunkRestoreBatchIntentReadOnly(client,
  chunks, request, {
    ownerVerifier, subjectVerifier, pendingDraftIds,
  } = {}) {
  const selection = validateVaultChunkRestoreBatchSelection(request);
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      typeof ownerVerifier !== 'function' ||
      typeof subjectVerifier !== 'function' ||
      typeof pendingDraftIds !== 'function')
    throw new TypeError('Exact signed owner and read-only draft scope required');

  const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(client, chunks, {
    allowBoundedHistory: true, ownerVerifier,
    privateSelectedIds: selection.selectedIds,
  });
  const evidence = proof.privateSelectionEvidence;
  if (!proof.sourceGitHubCommitAndAllBlobBytesVerified ||
      !proof.inventoryAndChunkSequenceVerified ||
      evidence?.sourceSnapshot !== selection.expectedSourceSnapshot ||
      evidence?.sourceInventorySha256 !==
        selection.expectedSourceInventorySha256 ||
      !Array.isArray(evidence?.selected) ||
      evidence.selected.length !== selection.selectedIds.length ||
      evidence.selected.some((item, i) =>
        item.id !== selection.selectedIds[i] ||
        !SHA.test(item.sha || '') ||
        !DIGEST.test(item.contentDigest || '') ||
        !UUID.test(item.subjectId || '')))
    throw fail('vault-chunk-batch-source-not-approved');

  const subjects = [...new Set(evidence.selected.map(
    (item) => item.subjectId))].sort();
  if (await subjectVerifier(subjects) !== true)
    throw fail('vault-chunk-batch-subject-unverified');

  // The target must still be the EXACT current branch HEAD approved for
  // this selection. Never allow a caller-chosen target Git SHA or alternate
  // repository access. The scanner reads the complete canonical Git tree.
  const target = await scanVaultNotesSnapshotIndex(client, {
    expectedHead: selection.expectedTargetHead,
  });
  const currentIds = new Set(target.files.map((file) => file.id));
  const draftIds = await pendingDraftIds(selection.selectedIds);
  const accepted = new Set(selection.selectedIds);
  if (!Array.isArray(draftIds) || draftIds.some((id) =>
      typeof id !== 'string' || !accepted.has(id)) ||
      new Set(draftIds).size !== draftIds.length)
    throw fail('vault-chunk-batch-draft-scope-invalid');
  const pending = new Set(draftIds);
  const selections = selection.selectedIds.map((id) => ({
    id, outcome: pending.has(id) ? 'draft-conflict' :
      currentIds.has(id) ? 'existing-note-conflict' : 'create-candidate',
  }));
  if ((await client.call(target.refPath))?.object?.sha !== target.head ||
      await ownerVerifier() !== true)
    throw fail('vault-chunk-batch-target-or-owner-changed');

  const candidateCount = selections.filter((item) =>
    item.outcome === 'create-candidate').length;
  const draftConflicts = selections.filter((item) =>
    item.outcome === 'draft-conflict').length;
  const existingConflicts = selections.filter((item) =>
    item.outcome === 'existing-note-conflict').length;

  // This SHA-256 is a deterministic fingerprint of authenticated,
  // selected source blob metadata + approved target revision. It contains
  // no note plaintext and is NOT a capability or an import approval.
  const selectionFingerprint = createHash('sha256')
    .update(JSON.stringify({
      sourceSnapshot: evidence.sourceSnapshot,
      sourceInventorySha256: evidence.sourceInventorySha256,
      targetHead: target.head,
      selected: evidence.selected.map(({ id, sha, contentDigest,
        subjectId }) => ({ id, sha, contentDigest, subjectId })),
    }), 'utf8').digest('hex');
  return {
    format: 'oge-vault-notes-chunk-restore-batch-intent', version: 1,
    signedSourceGitBlobProofVerified: true,
    signedSourceHistoricalDepth: proof.commitsAfterSnapshot,
    sourceNotesCount: proof.verifiedNoteCount,
    selectedNoteCount: selections.length,
    selections,
    summary: { createCandidates: candidateCount,
      existingConflicts, draftConflicts },
    selectionFingerprint,
    targetHead: target.head,
    sourceSnapshot: evidence.sourceSnapshot,
    sourceInventorySha256: evidence.sourceInventorySha256,
    eligibleForIndependentApproval:
      candidateCount === selections.length,
    readOnly: true, canCommit: false,
    commitAuthorized: false, retryAuthorized: false,
    unlockAuthorized: false,
    draftsDeleted: false, notesChanged: false,
    newGitHubCommitCreated: false,
    requiresFreshUserApproval: true,
    requiresIndependentWriteRecovery: true,
    sourcePrivateContentsReturned: false,
  };
}
