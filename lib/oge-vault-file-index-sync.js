import { randomUUID } from 'node:crypto';
import { withAtomicBackupImport } from './atomic-backup-import.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { buildVaultFileIndexSnapshot } from './oge-vault-file-index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const allowedIdle = ['ready', 'stale'];
const scopeOf = (identity) => {
  const { ownerId, repoId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1)
    throw new TypeError('Invalid file index ownership');
  return { ownerId, repoId };
};

/**
 * B6 internal-only derivative catalog synchronization, not a notes backend.
 * MongoDB writes are atomic; a distinct per-vault operation ID fences runs.
 * A crash or ambiguous transaction leaves "syncing"/"verifying" and requires
 * operator reconciliation, never TTL expiration or unsafe automatic unlock.
 *
 * GitHub can change outside MongoDB transactions. Therefore even "ready"
 * means "verified against GitHub head at the time checked", NOT permission
 * to overwrite a GitHub file, nor guaranteed live freshness.
 */
export async function synchronizeVaultFileIndex(db, client, identity, {
  credential, scanner = buildVaultFileIndexSnapshot,
  operationId = randomUUID(),
  headReader = async (github) => (await github.call(
    '/git/ref/heads/' + encodeURIComponent(github.branch)))?.object?.sha,
} = {}) {
  const scope = scopeOf(identity);
  if (!UUID.test(operationId)) throw new TypeError('Invalid file-index run ID');
  const accountFilter = ownerMutationFilter(scope.ownerId, credential);
  if (client?.vault?.repoId !== scope.repoId)
    throw new VaultGitHubError('vault-file-index-repository-mismatch', 409);

  const states = db.collection('vault_file_index_state');
  const files = db.collection('vault_files');
  const now = new Date();
  try {
    const lock = await states.updateOne({
      ...scope, $or: [{ state: { $exists: false } }, { state: { $in: allowedIdle } }],
    }, {
      $set: { state: 'syncing', operationId, startedAt: now, updatedAt: now },
      $setOnInsert: { ownerId: scope.ownerId, repoId: scope.repoId },
    }, { upsert: true });
    if (lock.matchedCount !== 1 && lock.upsertedCount !== 1)
      throw new Error('vault-file-index-lock-not-acquired');
  } catch (error) {
    if (error?.code === 11000) throw new VaultGitHubError('vault-file-index-sync-busy', 409);
    throw error;
  }

  let snapshot;
  try {
    snapshot = await scanner(client, scope);
    if (snapshot?.advisoryOnly !== true ||
        snapshot.ownerId !== scope.ownerId || snapshot.repoId !== scope.repoId ||
        !SHA.test(snapshot.snapshot || '') ||
        !Array.isArray(snapshot.files) ||
        !Number.isSafeInteger(snapshot.totalNotes) ||
        snapshot.files.length !== snapshot.totalNotes)
      throw new VaultGitHubError('vault-file-index-snapshot-invalid', 409);
  } catch (error) {
    // No indexed rows were changed yet: release known failed scan as stale.
    const unlocked = await states.updateOne({ ...scope, operationId, state: 'syncing' },
      { $set: { state: 'stale', updatedAt: new Date(), reason: 'scan-failed' } });
    if (unlocked.matchedCount !== 1)
      throw new Error('vault-file-index-scan-release-unconfirmed');
    throw error;
  }

  // Do not trust even the full snapshot if it is malformed or cross-scoped.
  const ids = new Set();
  for (const file of snapshot.files) {
    if (file.ownerId !== scope.ownerId || file.repoId !== scope.repoId ||
        !UUID.test(file.noteId || '') || !UUID.test(file.subjectId || '') ||
        file.path !== 'notes/' + file.noteId + '.json' ||
        !SHA.test(file.blobSha || '') || ids.has(file.noteId))
      throw new VaultGitHubError('vault-file-index-entry-invalid', 409);
    ids.add(file.noteId);
  }

  // Transactional metadata snapshot: no note body/title/tags are persisted.
  // If commit is ambiguous, leave state fenced for audited recovery.
  await withAtomicBackupImport(db, async (session) => {
    const account = await db.collection('users').updateOne({
      ...accountFilter, 'vault.status': 'connected', 'vault.repoId': scope.repoId,
    }, { $set: { updatedAt: new Date() } }, { session });
    if (account.matchedCount !== 1)
      throw new VaultGitHubError('vault-file-index-session-expired', 409);

    if (snapshot.files.length) {
      await files.bulkWrite(snapshot.files.map((file) => ({
        updateOne: {
          filter: { ...scope, noteId: file.noteId },
          update: {
            $set: { subjectId: file.subjectId, path: file.path,
              blobSha: file.blobSha, status: 'present',
              lastSeenSnapshot: snapshot.snapshot, updatedAt: new Date() },
            $setOnInsert: { ownerId: scope.ownerId, repoId: scope.repoId,
              noteId: file.noteId, createdAt: new Date() },
          },
          upsert: true,
        },
      })), { session, ordered: true });
    }
    // Soft tombstones only; external GitHub deletions remain auditable.
    await files.updateMany({
      ...scope, noteId: { $nin: [...ids] }, status: { $ne: 'missing' },
    }, { $set: { status: 'missing', lastSeenSnapshot: snapshot.snapshot,
      updatedAt: new Date() } }, { session });

    const updated = await states.updateOne({
      ...scope, operationId, state: 'syncing',
    }, { $set: { state: 'verifying', snapshot: snapshot.snapshot,
      totalNotes: snapshot.totalNotes, updatedAt: new Date() } }, { session });
    if (updated.matchedCount !== 1)
      throw new Error('vault-file-index-run-fence-lost');
  });

  // Recheck GitHub AFTER the Mongo transaction. A stale index must never
  // claim currentness if GitHub changed while the transaction ran.
  let currentHead = null;
  try { currentHead = await headReader(client); }
  catch { /* Mark stale, not ready, if the read is unavailable. */ }
  const ready = currentHead === snapshot.snapshot;
  const state = ready ? 'ready' : 'stale';
  const result = await states.updateOne({
    ...scope, operationId, state: 'verifying', snapshot: snapshot.snapshot,
  }, { $set: { state, reason: ready ? null : 'github-head-changed-or-unavailable',
    checkedAt: new Date(), updatedAt: new Date() } });
  if (result.matchedCount !== 1)
    throw new Error('vault-file-index-verification-unconfirmed');
  return { status: state, indexed: snapshot.totalNotes,
    snapshot: snapshot.snapshot, advisoryOnly: true };
}
