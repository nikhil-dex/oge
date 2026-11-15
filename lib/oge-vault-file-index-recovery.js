import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';

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
    state.totalNotes <= 500;
  return {
    state: state.state,
    action: recoverable ? 'reconcile-verification' :
      state.state === 'syncing' || state.state === 'verifying'
        ? 'manual-review' : 'none',
    operationId: UUID.test(state.operationId || '') ? state.operationId : null,
    snapshot: SHA.test(state.snapshot || '') ? state.snapshot : null,
    totalNotes: Number.isSafeInteger(state.totalNotes) ? state.totalNotes : null,
  };
}

/**
 * Reconcile a transactionally COMMITTED "verifying" snapshot only.
 * We prove the MongoDB metadata population and fresh GitHub head before
 * moving the state forward using operation-ID compare-and-swap. No note
 * content is read from MongoDB and no index row/subject/draft is changed.
 *
 * A "syncing" run remains fail-closed for manual review: attempting to
 * release it could race with an active or ambiguously committed writer.
 * Never retry its transaction or clear its lock automatically.
 */
export async function reconcileVaultFileIndexVerification(db, client, identity, {
  credential,
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
    return { status: current.state, action: ['syncing', 'verifying'].includes(current.state)
      ? 'manual-review' : 'none', advisoryOnly: true };
  if (!UUID.test(current.operationId || '') ||
      !SHA.test(current.snapshot || '') ||
      !Number.isSafeInteger(current.totalNotes) ||
      current.totalNotes < 0 || current.totalNotes > 500)
    return { status: 'verifying', action: 'manual-review', advisoryOnly: true };

  const expected = current.totalNotes;
  const indexed = await db.collection('vault_files').countDocuments({
    ...scope, status: 'present', lastSeenSnapshot: current.snapshot,
  }, { limit: expected + 1 });
  const allPresent = await db.collection('vault_files').countDocuments({
    ...scope, status: 'present',
  }, { limit: expected + 1 });
  if (indexed !== expected || allPresent !== expected)
    return { status: 'verifying', action: 'manual-review',
      reason: 'metadata-count-mismatch', advisoryOnly: true };

  let head;
  try { head = await headReader(client); }
  catch {
    return { status: 'verifying', action: 'manual-review',
      reason: 'github-unavailable', advisoryOnly: true };
  }
  if (!SHA.test(head || ''))
    return { status: 'verifying', action: 'manual-review',
      reason: 'github-head-invalid', advisoryOnly: true };
  const nextState = head.toLowerCase() === current.snapshot.toLowerCase()
    ? 'ready' : 'stale';
  const updated = await states.updateOne({
    ...scope, operationId: current.operationId, state: 'verifying',
    snapshot: current.snapshot, totalNotes: expected,
  }, { $set: { state: nextState,
    reason: nextState === 'ready' ? null : 'github-head-changed',
    checkedAt: new Date(), updatedAt: new Date() } });
  if (updated.matchedCount !== 1)
    throw new VaultGitHubError('vault-file-index-recovery-raced', 409);

  return { status: nextState, action: 'none', advisoryOnly: true,
    snapshot: current.snapshot, indexed: expected };
}
