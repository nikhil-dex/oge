import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { buildIncrementalVaultFileIndexSnapshot, MAX_INDEX_TREE_ENTRIES } from './oge-vault-file-index-incremental.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;

function checkedScope(identity) {
  const { ownerId, repoId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1)
    throw new TypeError('Invalid Vault file-index recovery scope');
  return { ownerId, repoId };
}

/**
 * Read-only scoped diagnosis. Never auto-release "syncing", because a server
 * may still be writing or its transaction outcome may be ambiguous.
 */
export async function inspectVaultFileIndexRecovery(db, identity) {
  const scope = checkedScope(identity);
  const state = await db.collection('vault_file_index_state').findOne(scope, {
    projection: { _id: 0, ownerId: 1, repoId: 1, state: 1, operationId: 1,
      snapshot: 1, totalNotes: 1, updatedAt: 1, reason: 1 },
  });
  if (!state) return { state: 'not-indexed', action: 'refresh' };
  const recoverable = state.state === 'verifying' &&
    UUID.test(state.operationId || '') &&
    SHA.test(state.snapshot || '') &&
    Number.isSafeInteger(state.totalNotes) && state.totalNotes >= 0 &&
    state.totalNotes <= MAX_INDEX_TREE_ENTRIES;
  return {
    state: state.state,
    action: recoverable ? 'reconcile-verification' :
      ['syncing', 'verifying', 'bootstrapping', 'bootstrap-staged'].includes(state.state)
        ? 'manual-review' : 'none',
    operationId: UUID.test(state.operationId || '') ? state.operationId : null,
    snapshot: SHA.test(state.snapshot || '') ? state.snapshot : null,
    totalNotes: Number.isSafeInteger(state.totalNotes) ? state.totalNotes : null,
  };
}

/**
 * A "verifying" state means the metadata transaction already committed.
 * Rebuild the authoritative GitHub snapshot, validate the EXACT metadata
 * rows (not just counts), and CAS the state to ready/stale.
 *
 * Never retry writes, touch drafts or subjects, or release a "syncing" lock.
 * An interrupted "syncing" transaction is ambiguous and needs manual review.
 */
export async function reconcileVaultFileIndexVerification(db, client, identity, {
  credential,
  scanner = buildIncrementalVaultFileIndexSnapshot,
  headReader = async (github) => (await github.call(
    '/git/ref/heads/' + encodeURIComponent(github.branch)))?.object?.sha,
} = {}) {
  const scope = checkedScope(identity);
  const accountFilter = ownerMutationFilter(scope.ownerId, credential);
  if (client?.vault?.repoId !== scope.repoId)
    throw new VaultGitHubError('vault-file-index-repository-mismatch', 409);
  const owner = await db.collection('users').findOne({
    ...accountFilter, 'vault.status': 'connected', 'vault.repoId': scope.repoId,
  }, { projection: { _id: 1 } });
  if (!owner) throw new VaultGitHubError('vault-file-index-session-expired', 409);

  const states = db.collection('vault_file_index_state');
  const current = await states.findOne(scope);
  if (!current) return { status: 'not-indexed', action: 'refresh', advisoryOnly: true };
  if (current.state !== 'verifying')
    return { status: current.state,
      action: ['syncing', 'bootstrapping', 'bootstrap-staged'].includes(current.state)
        ? 'manual-review' : 'none', advisoryOnly: true };
  if (!UUID.test(current.operationId || '') ||
      !SHA.test(current.snapshot || '') ||
      !Number.isSafeInteger(current.totalNotes) ||
      current.totalNotes < 0 || current.totalNotes > MAX_INDEX_TREE_ENTRIES)
    return { status: 'verifying', action: 'manual-review', advisoryOnly: true };

  // Load only metadata; a failed/mismatched recovery is advisory. The
  // GitHub tree is independently read and no user notes are changed.
  const stored = await db.collection('vault_files').find({
    ...scope, status: 'present',
  }, { projection: { _id: 0, ownerId: 1, repoId: 1, noteId: 1,
    subjectId: 1, path: 1, blobSha: 1, status: 1, lastSeenSnapshot: 1 },
  }).limit(current.totalNotes + 1).toArray();
  let remote;
  try { remote = await scanner(client, scope, { existingRows: stored }); }
  catch {
    return { status: 'verifying', action: 'manual-review',
      reason: 'github-scan-unavailable', advisoryOnly: true };
  }
  if (remote?.advisoryOnly !== true || remote.ownerId !== scope.ownerId ||
      remote.repoId !== scope.repoId || !SHA.test(remote.snapshot || '') ||
      !Array.isArray(remote.files) ||
      !Number.isSafeInteger(remote.totalNotes) ||
      remote.totalNotes < 0 || remote.totalNotes > MAX_INDEX_TREE_ENTRIES ||
      remote.files.length !== remote.totalNotes)
    return { status: 'verifying', action: 'manual-review',
      reason: 'invalid-github-snapshot', advisoryOnly: true };

  let newState = remote.snapshot.toLowerCase() === current.snapshot.toLowerCase()
    ? 'ready' : 'stale';
  if (newState === 'ready') {
    const expected = new Map(remote.files.map((file) => [file.noteId, file]));
    if (expected.size !== current.totalNotes || stored.length !== expected.size ||
        stored.some((row) => {
          const file = expected.get(row.noteId);
          return !file || row.subjectId !== file.subjectId ||
            row.path !== file.path || row.blobSha !== file.blobSha ||
            row.lastSeenSnapshot !== current.snapshot;
        })) {
      return { status: 'verifying', action: 'manual-review',
        reason: 'metadata-mismatch', advisoryOnly: true };
    }
  }

  // A post-verification ref check detects a concurrent external GitHub edit.
  // It can only turn ready into stale, never authorize a GitHub write.
  let finalHead;
  try { finalHead = await headReader(client); }
  catch {
    return { status: 'verifying', action: 'manual-review',
      reason: 'github-head-unavailable', advisoryOnly: true };
  }
  if (!SHA.test(finalHead || ''))
    return { status: 'verifying', action: 'manual-review',
      reason: 'github-head-invalid', advisoryOnly: true };
  if (finalHead.toLowerCase() !== current.snapshot.toLowerCase())
    newState = 'stale';

  const result = await states.updateOne({
    ...scope, operationId: current.operationId, state: 'verifying',
    snapshot: current.snapshot, totalNotes: current.totalNotes,
  }, { $set: {
    state: newState, reason: newState === 'ready' ? null : 'github-head-changed',
    checkedAt: new Date(), updatedAt: new Date(),
  } });
  if (result.matchedCount !== 1)
    throw new VaultGitHubError('vault-file-index-recovery-raced', 409);
  return { status: newState, action: 'none',
    snapshot: current.snapshot, indexed: current.totalNotes, advisoryOnly: true };
}
