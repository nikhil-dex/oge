import { ownerMutationFilter } from './active-owner-mutation.js';
import { noteFilePath } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE = /^Restore OgeNotes backup [a-f0-9]{64}$/;
const HISTORY_LIMIT = 20;
const TREE_LIMIT = 30000;

const report = (status, extras = {}) => ({
  check: 'oge-vault-import-attempt-evidence',
  version: 1, status, ...extras,
  readOnly: true, contentDownloaded: false,
  importedContentVerified: false, safeToRetryAutomatically: false,
  automaticUnlockAuthorized: false, operatorUnlockAuthorized: false,
  notesChanged: false, encryptedDraftsChanged: false,
  consistentSnapshot: false,
});

function scopeFilter(ownerId, sessionVersion, repoId) {
  return { $and: [
    ownerMutationFilter(ownerId, { sessionVersion }),
    { 'vault.status': 'connected', 'vault.repoId': repoId },
  ] };
}

function validLock(lock, identity) {
  if (!lock || lock.operationId !== identity.expectedOperationId ||
      lock.repoId !== identity.repoId ||
      lock.state !== 'github-write-possible' ||
      !MESSAGE.test(lock.commitMarker || '') ||
      !SHA.test(lock.approvedHead || '') ||
      !Array.isArray(lock.selectedIds) ||
      lock.selectedIds.length < 1 || lock.selectedIds.length > 12 ||
      lock.selectedIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(lock.selectedIds).size !== lock.selectedIds.length ||
      !(lock.startedAt instanceof Date) ||
      !(lock.attemptedAt instanceof Date) ||
      !Number.isFinite(lock.startedAt.getTime()) ||
      !Number.isFinite(lock.attemptedAt.getTime()) ||
      lock.attemptedAt < lock.startedAt)
    return false;
  return true;
}

function ownerMatches(row, client, repoId) {
  const a = row?.vault, b = client?.vault;
  return a?.status === 'connected' && a.repoId === repoId &&
    b?.repoId === repoId &&
    a.installationId === b.installationId &&
    a.githubAccountId === b.githubAccountId &&
    a.githubLogin === b.githubLogin &&
    a.repoName === b.repoName;
}

/** Leaf blobs and submodules must remain identical outside approved additions. */
function leaves(tree) {
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > TREE_LIMIT)
    throw new VaultGitHubError('vault-import-attempt-tree-incomplete', 409);
  const result = new Map(), seen = new Set();
  for (const item of tree.tree) {
    if (!item || typeof item.path !== 'string' || !item.path ||
        seen.has(item.path) || !SHA.test(item.sha || '') ||
        !['tree', 'blob', 'commit'].includes(item.type))
      throw new VaultGitHubError('vault-import-attempt-tree-invalid', 409);
    seen.add(item.path);
    if (item.path.startsWith('notes/')) {
      const id = item.path.slice(6, -5);
      let validPath = false;
      try { validPath = item.path.endsWith('.json') &&
        noteFilePath(id) === item.path; }
      catch { /* reject malformed or noncanonical note paths */ }
      if (!validPath || item.type !== 'blob' ||
          item.mode !== '100644')
        throw new VaultGitHubError('vault-import-attempt-note-invalid', 409);
    }
    if (item.type !== 'tree')
      result.set(item.path, [item.type, item.mode || '', item.sha].join(':'));
  }
  return result;
}

/**
 * Milestone #48: independent metadata-only operator evidence of an ambiguous
 * create-only GitHub import. NEVER a receipt, unlock authorization, proof that
 * imported bytes match the original archive, or evidence of worker quiescence.
 * The strict original archive reconciliation endpoint is still needed to
 * verify complete note content. Use only the signed private Vault client.
 */
export async function inspectVaultImportAttemptEvidenceReadOnly(db, identity, client) {
  if (!db || typeof db.collection !== 'function' ||
      typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      identity.sessionVersion === undefined ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId < 1 ||
      typeof identity.expectedOperationId !== 'string' ||
      !UUID.test(identity.expectedOperationId) ||
      typeof client?.call !== 'function' ||
      typeof client.branch !== 'string')
    throw new TypeError('Exact signed Vault evidence scope required');

  const users = db.collection('users');
  const filter = scopeFilter(identity.ownerId, identity.sessionVersion, identity.repoId);
  const projection = { _id: 0, vault: 1, vaultImportLock: 1 };
  const initial = await users.findOne(filter, { projection });
  if (!initial || !ownerMatches(initial, client, identity.repoId))
    return report('OWNER_OR_REPOSITORY_NOT_VERIFIED');
  if (!initial.vaultImportLock ||
      initial.vaultImportLock.operationId !== identity.expectedOperationId)
    return report('NO_MATCHING_IMPORT_LOCK');
  if (initial.vaultImportLock.state !== 'github-write-possible')
    return report('NOT_A_RECORDED_REMOTE_WRITE');
  if (!validLock(initial.vaultImportLock, identity))
    return report('DURABLE_IMPORT_EVIDENCE_INVALID');

  const lock = initial.vaultImportLock;
  const fingerprint = JSON.stringify(lock);
  const pathSet = new Set(lock.selectedIds.map((id) => noteFilePath(id)));
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const current = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(current || ''))
    throw new VaultGitHubError('vault-import-attempt-head-unavailable', 503);

  let cursor = current, found = null, commitsAfter = 0, status;
  const visited = new Set();
  for (let n = 0; n < HISTORY_LIMIT; n++) {
    if (cursor === lock.approvedHead) {
      status = 'APPROVED_HEAD_WITHOUT_CONFIRMED_IMPORT';
      break;
    }
    if (!SHA.test(cursor || '') || visited.has(cursor))
      throw new VaultGitHubError('vault-import-attempt-ancestry-invalid', 409);
    visited.add(cursor);
    const commit = await client.call('/git/commits/' + cursor);
    if (!SHA.test(commit?.tree?.sha || '') ||
        !Array.isArray(commit.parents) || commit.parents.length !== 1) {
      status = 'NONLINEAR_OR_INCOMPLETE_HISTORY';
      break;
    }
    const parent = typeof commit.parents[0] === 'string'
      ? commit.parents[0] : commit.parents[0]?.sha;
    if (!SHA.test(parent || '') || parent === cursor)
      throw new VaultGitHubError('vault-import-attempt-ancestry-invalid', 409);
    if (parent === lock.approvedHead &&
        commit.message === lock.commitMarker) {
      found = commit;
      commitsAfter = n;
      break;
    }
    cursor = parent;
  }
  if (!status && !found) status = 'IMPORT_NOT_PROVEN_IN_BOUNDED_HISTORY';

  if (found) {
    const base = await client.call('/git/commits/' + lock.approvedHead);
    if (!SHA.test(base?.tree?.sha || ''))
      throw new VaultGitHubError('vault-import-attempt-base-unavailable', 503);
    const [baseTree, importTree] = await Promise.all([
      client.call('/git/trees/' + base.tree.sha + '?recursive=1'),
      client.call('/git/trees/' + found.tree.sha + '?recursive=1'),
    ]);
    const before = leaves(baseTree), after = leaves(importTree);
    const selectedOnly = [...pathSet].every((path) =>
      !before.has(path) && after.has(path)) &&
      [...before].every(([path, signature]) =>
        pathSet.has(path) || after.get(path) === signature) &&
      [...after.keys()].every((path) =>
        pathSet.has(path) || before.has(path));
    status = selectedOnly
      ? 'MATCHING_IMPORT_COMMIT_METADATA_ONLY'
      : 'MATCHING_COMMIT_HAS_UNEXPECTED_TREE_CHANGES';
  }

  const endingHead = (await client.call(refPath))?.object?.sha;
  const ending = await users.findOne(filter, { projection });
  if (endingHead !== current || !ending ||
      !ownerMatches(ending, client, identity.repoId) ||
      !validLock(ending.vaultImportLock, identity) ||
      JSON.stringify(ending.vaultImportLock) !== fingerprint)
    return report('HEAD_OR_OWNER_LOCK_CHANGED_DURING_INSPECTION');

  return report(status, {
    matchingCommitMetadataFound: status === 'MATCHING_IMPORT_COMMIT_METADATA_ONLY',
    commitsAfterCandidate: status === 'MATCHING_IMPORT_COMMIT_METADATA_ONLY'
      ? commitsAfter : null,
    branchHeadStable: true,
    ownerLockStable: true,
    originalArchiveRequiredForContentProof: true,
    workerQuiescenceVerified: false,
  });
}
