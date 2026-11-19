import { createHash } from 'node:crypto';
import { noteFilePath, MAX_VAULT_NOTE_BYTES } from './oge-vault-notes.js';
import { standaloneCapturePath, readVaultStandaloneBlob } from './oge-vault-standalone-captures.js';
import {
  validateStandaloneRestoreSelection,
  fingerprintStandaloneRestoreSelection,
  markerStandaloneRestoreSelection,
} from './oge-vault-standalone-restore-approval.js';
import { standaloneRestoreApprovalBinding } from './oge-vault-standalone-restore-ticket.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E9/M77: FOR FORENSIC TRIAGE ONLY. One exact signed owner/import-lock
 * operation and claimed M76 receipt, one immutable bounded linear Git
 * ancestry, complete base/candidate Git leaf diff and selected immutable
 * standalone Git blob contents. Never write Mongo, Git, or unlock anything.
 *
 * The supplied M73 archive is UNTRUSTED, though fully checksum validated.
 * Positive Git content correspondence is NOT GitHub source authenticity,
 * proof the old writer has stopped, or authority to remove the owner lock.
 */
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TREE_ENTRIES = 30000;
export const MAX_STANDALONE_RESTORE_RECONCILE_COMMITS = 20;
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function evidence(status, {
  kind, selectedIds, expectedHead, head = null,
  commitSha = null, commitsAfterRestore = null,
  selectedCurrent = null, receiptState = null,
  historyContentVerified = false,
  ownerLockStable = false,
} = {}) {
  return {
    format: 'oge-vault-standalone-restore-reconciliation',
    version: 1, status, kind,
    selectedCount: selectedIds.length,
    selectedIds,
    expectedTargetHead: expectedHead,
    observedTargetHead: head,
    candidateCommitSha: commitSha,
    newerCommitsSinceCandidate: commitsAfterRestore,
    receiptState,
    historicalSelectedContentVerified: historyContentVerified,
    currentSelectedFiles: selectedCurrent,
    ownerLockStable,
    readOnly: true,
    fullAccountRecoveryReady: false,
    sourceGitHubIdentityAuthenticated: false,
    observedContentMatchesUntrustedSuppliedArchive: historyContentVerified,
    independentWriterQuiescenceVerified: false,
    draftChangesPerformed: false,
    gitWritesPerformed: false,
    mongoWritesPerformed: false,
    automaticUnlockAuthorized: false,
    operatorUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    canCommit: false, canRestore: false,
  };
}
function result(status, selected, ctx = {}) {
  return evidence(status, {
    kind: selected.kind, selectedIds: selected.selectedIds,
    expectedHead: selected.expectedTargetHead, ...ctx,
  });
}
function validLock(raw, expectedOperationId, selected, marker, repoId) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) &&
    raw.operationId === expectedOperationId &&
    UUID.test(raw.operationId || '') &&
    raw.repoId === repoId &&
    raw.state === 'github-write-possible' &&
    raw.commitMarker === marker &&
    raw.approvedHead === selected.expectedTargetHead &&
    Array.isArray(raw.selectedIds) &&
    JSON.stringify(raw.selectedIds) === JSON.stringify(selected.selectedIds) &&
    raw.startedAt instanceof Date &&
    Number.isFinite(raw.startedAt.getTime()) &&
    raw.attemptedAt instanceof Date &&
    Number.isFinite(raw.attemptedAt.getTime()) &&
    raw.attemptedAt >= raw.startedAt;
}
function lockFingerprint(lock, activeDraftWriters) {
  return JSON.stringify({
    operationId: lock.operationId, repoId: lock.repoId,
    state: lock.state, commitMarker: lock.commitMarker,
    approvedHead: lock.approvedHead, selectedIds: lock.selectedIds,
    startedAt: lock.startedAt.toISOString(),
    attemptedAt: lock.attemptedAt.toISOString(),
    activeDraftWriters: activeDraftWriters ?? null,
  });
}
function parentSha(value) {
  return typeof value === 'string' ? value : value?.sha;
}

/** Validate BOTH trees, every path and all leaf types, not only selected. */
function leavesFromCompleteTree(response) {
  if (!Array.isArray(response?.tree) || response.truncated === true ||
      response.tree.length > MAX_TREE_ENTRIES)
    throw fail('vault-standalone-reconcile-tree-incomplete');
  const seen = new Set(), leaves = new Map();
  for (const item of response.tree) {
    if (!item || typeof item.path !== 'string' || !item.path ||
        seen.has(item.path) || !SHA.test(item.sha || '') ||
        !['tree', 'blob', 'commit'].includes(item.type))
      throw fail('vault-standalone-reconcile-tree-invalid');
    seen.add(item.path);
    if (item.type === 'tree' &&
        item.mode !== undefined && item.mode !== '040000')
      throw fail('vault-standalone-reconcile-tree-invalid');
    const root = ['notes', 'quick-notes', 'airnotes'].includes(item.path);
    if (root && (item.type !== 'tree' ||
        (item.mode !== undefined && item.mode !== '040000')))
      throw fail('vault-standalone-reconcile-tree-invalid');
    const kind = item.path.startsWith('notes/') ? 'notes' :
      item.path.startsWith('quick-notes/') ? 'quick-notes' :
      item.path.startsWith('airnotes/') ? 'airnotes' : null;
    if (kind) {
      const id = item.path.endsWith('.json')
        ? item.path.slice(kind.length + 1, -5) : '';
      let canonical = false;
      try {
        canonical = (kind === 'notes' ? noteFilePath(id) :
          standaloneCapturePath(kind, id)) === item.path;
      } catch { /* invalid path */ }
      if (!canonical || item.type !== 'blob' ||
          (item.mode !== undefined && item.mode !== '100644') ||
          (item.size !== undefined &&
            (!Number.isSafeInteger(item.size) || item.size < 0 ||
            item.size > (kind === 'notes' ? MAX_VAULT_NOTE_BYTES : 32 * 1024))))
        throw fail('vault-standalone-reconcile-target-file-invalid');
    }
    if (item.type !== 'tree')
      leaves.set(item.path, {
        sha: item.sha, type: item.type, mode: item.mode ?? null,
      });
  }
  return leaves;
}
const sameLeaf = (left, right) =>
  Boolean(left && right && left.sha === right.sha &&
    left.type === right.type && left.mode === right.mode);

function selectedTreeDelta(before, after, selectedPaths) {
  for (const path of selectedPaths) {
    if (before.has(path)) return false;
    const next = after.get(path);
    if (!next || next.type !== 'blob' ||
        (next.mode !== null && next.mode !== '100644'))
      return false;
  }
  for (const [path, item] of before) {
    if (selectedPaths.has(path)) continue;
    if (!sameLeaf(item, after.get(path))) return false;
  }
  for (const path of after.keys()) {
    if (!selectedPaths.has(path) && !before.has(path)) return false;
  }
  return true;
}

/**
 * The caller supplies:
 * - read-only exact-owner private GitHub App client;
 * - exact scoped lock reader (raw metadata ONLY, no private user contents);
 * - exact scoped one-time receipt lookup (max two metadata records);
 * - signed owner/repo/session verifier checked before and after;
 * - expectedOperationId from a separately authorized incident.
 *
 * There is deliberately NO browser endpoint for unlocking and NO writer.
 */
export async function reconcileStandaloneRestoreReadOnly(client, request, {
  expectedOperationId, ownerVerifier, lockReader, receiptReader,
  blobReader = readVaultStandaloneBlob,
} = {}) {
  // Untrusted uploaded JSON is validated in full BEFORE provider/DB reads.
  const selected = validateStandaloneRestoreSelection(request, { commit: true });
  if (!UUID.test(expectedOperationId || '') ||
      client?.readOnly !== true || typeof client.call !== 'function' ||
      !Number.isSafeInteger(client.vault?.repoId) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(client.branch || '') ||
      client.branch.startsWith('-') || client.branch.includes('..') ||
      typeof ownerVerifier !== 'function' ||
      typeof lockReader !== 'function' ||
      typeof receiptReader !== 'function' ||
      typeof blobReader !== 'function')
    throw new TypeError('Read-only signed owner and exact incident scope required');

  const fingerprint = fingerprintStandaloneRestoreSelection(selected);
  if (fingerprint !== request.expectedSelectionFingerprint)
    throw fail('vault-standalone-reconcile-source-selection-changed');
  const marker = markerStandaloneRestoreSelection(selected, fingerprint);
  const binding = standaloneRestoreApprovalBinding(request);
  const expectedApprovalHash = sha256(JSON.stringify(binding));
  if (!await ownerVerifier())
    throw fail('vault-standalone-reconcile-owner-changed');
  const first = await lockReader();
  const lock = first?.lock;
  if (!validLock(lock, expectedOperationId, selected, marker,
    client.vault.repoId))
    throw fail('vault-standalone-reconcile-lock-not-exact');
  if (first.activeDraftWriters !== undefined &&
      (!Number.isSafeInteger(first.activeDraftWriters) ||
       first.activeDraftWriters < 0))
    throw fail('vault-standalone-reconcile-writer-counter-invalid');
  const originalLock = lockFingerprint(lock, first.activeDraftWriters);

  const receipts = await receiptReader(expectedApprovalHash);
  if (!Array.isArray(receipts) || receipts.length > 2 ||
      receipts.some((row) => typeof row !== 'object' || !row ||
        !HASH.test(row.approvalHash || '') ||
        row.approvalHash !== expectedApprovalHash ||
        !HASH.test(row.nonceHash || '') ||
        !['claimed', 'confirmed'].includes(row.state)))
    throw fail('vault-standalone-reconcile-receipt-data-invalid');
  const receipt = receipts.length === 1 ? receipts[0] : null;
  if (!receipt)
    throw fail('vault-standalone-reconcile-receipt-absent-or-ambiguous');

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(head || ''))
    throw fail('vault-standalone-reconcile-head-unavailable', 503);
  let status = 'NOT_PROVEN_WITHIN_BOUNDED_HISTORY';
  let candidate = null, afterCount = null, before = null, after = null;
  let candidateCommitSha = null, currentSelected = null;
  const visited = new Set();
  let cursor = head;

  if (head === selected.expectedTargetHead) {
    status = 'APPROVED_HEAD_UNCHANGED';
  } else {
    for (let depth = 0; depth < MAX_STANDALONE_RESTORE_RECONCILE_COMMITS;
      depth++) {
      if (!SHA.test(cursor || '') || visited.has(cursor))
        throw fail('vault-standalone-reconcile-git-ancestry-invalid');
      if (cursor === selected.expectedTargetHead) {
        status = 'NO_MATCHING_COMMIT_IN_BOUNDED_HISTORY';
        break;
      }
      visited.add(cursor);
      const commit = await client.call('/git/commits/' + cursor);
      if (!SHA.test(commit?.tree?.sha || '') ||
          !Array.isArray(commit?.parents) || commit.parents.length !== 1) {
        status = 'NONLINEAR_OR_INCOMPLETE_HISTORY';
        break;
      }
      const parent = parentSha(commit.parents[0]);
      if (!SHA.test(parent || '') || parent === cursor)
        throw fail('vault-standalone-reconcile-git-ancestry-invalid');
      if (parent === selected.expectedTargetHead &&
          commit.message === marker) {
        candidate = commit;
        candidateCommitSha = cursor;
        afterCount = depth;
        break;
      }
      cursor = parent;
    }
  }
  if (candidate) {
    const base = await client.call(
      '/git/commits/' + selected.expectedTargetHead);
    if (!SHA.test(base?.tree?.sha || ''))
      throw fail('vault-standalone-reconcile-base-unavailable', 503);
    const [baseTree, candidateTree] = await Promise.all([
      client.call('/git/trees/' + base.tree.sha + '?recursive=1'),
      client.call('/git/trees/' + candidate.tree.sha + '?recursive=1'),
    ]);
    before = leavesFromCompleteTree(baseTree);
    after = leavesFromCompleteTree(candidateTree);
    const selectedPaths = new Set(selected.selectedIds.map((id) =>
      standaloneCapturePath(selected.kind, id)));
    if (!selectedTreeDelta(before, after, selectedPaths)) {
      status = 'CANDIDATE_CONTENT_DELTA_UNVERIFIED';
      candidateCommitSha = null;
    } else {
      let matched = true;
      for (const row of selected.selected) {
        const entry = after.get(standaloneCapturePath(selected.kind, row.id));
        let checked;
        try {
          checked = await blobReader(client, selected.kind, row.id, entry.sha);
        } catch {
          // Fail closed; do NOT echo GitHub error messages or decrypted text.
          matched = false;
          break;
        }
        const original = { ...row };
        delete original.sha;
        const remote = { ...checked };
        delete remote.sha;
        if (checked.id !== row.id || checked.sha !== entry.sha ||
            JSON.stringify(remote) !== JSON.stringify(original)) {
          matched = false;
          break;
        }
      }
      if (!matched) {
        status = 'CANDIDATE_PRIVATE_BLOBS_UNVERIFIED';
        candidateCommitSha = null;
      } else {
        // Verify file presence at pinned CURRENT HEAD separately from the
        // *historical* committed creation: later edits/deletions may exist.
        const currentCommit = await client.call('/git/commits/' + head);
        if (!SHA.test(currentCommit?.tree?.sha || ''))
          throw fail('vault-standalone-reconcile-current-tree-unavailable', 503);
        const pinned = currentCommit.tree.sha === candidate.tree.sha ?
          after : leavesFromCompleteTree(await client.call(
            '/git/trees/' + currentCommit.tree.sha + '?recursive=1'));
        const counts = { unchanged: 0, changed: 0, missing: 0 };
        for (const path of selectedPaths) {
          const current = pinned.get(path);
          if (!current) counts.missing++;
          else if (sameLeaf(current, after.get(path))) counts.unchanged++;
          else counts.changed++;
        }
        currentSelected = counts;
        status = 'HISTORICAL_CREATE_CONTENT_VERIFIED';
      }
    }
  }

  // Never report even advisory proof when signed identity, owner lock or
  // private target HEAD changed while checking immutable provider evidence.
  if ((await client.call(refPath))?.object?.sha !== head)
    throw fail('vault-standalone-reconcile-head-changed');
  if (!await ownerVerifier())
    throw fail('vault-standalone-reconcile-owner-changed');
  const second = await lockReader();
  if (!validLock(second?.lock, expectedOperationId, selected, marker,
      client.vault.repoId) ||
      lockFingerprint(second.lock, second.activeDraftWriters) !== originalLock)
    throw fail('vault-standalone-reconcile-owner-lock-changed');
  const again = await receiptReader(expectedApprovalHash);
  if (!Array.isArray(again) || again.length !== 1 ||
      again[0]?.nonceHash !== receipt.nonceHash ||
      again[0]?.state !== receipt.state ||
      again[0]?.approvalHash !== expectedApprovalHash)
    throw fail('vault-standalone-reconcile-receipt-changed');
  return result(status, selected, {
    head,
    commitSha: status === 'HISTORICAL_CREATE_CONTENT_VERIFIED'
      ? candidateCommitSha : null,
    commitsAfterRestore: status === 'HISTORICAL_CREATE_CONTENT_VERIFIED'
      ? afterCount : null,
    selectedCurrent: status === 'HISTORICAL_CREATE_CONTENT_VERIFIED'
      ? currentSelected : null,
    receiptState: receipt.state,
    historyContentVerified: status === 'HISTORICAL_CREATE_CONTENT_VERIFIED',
    ownerLockStable: true,
  });
}
