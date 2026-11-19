import { ownerMutationFilter } from './active-owner-mutation.js';
import { withAtomicBackupImport } from './atomic-backup-import.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { noteFilePath } from './oge-vault-notes.js';
import {
  readVaultBootstrapTree, validateVaultBootstrapTreeListing,
} from './oge-vault-file-index-bootstrap.js';
import { MAX_INDEX_TREE_ENTRIES } from './oge-vault-file-index-incremental.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const CHUNK = 250;

function keyFor(identity, operationId) {
  const { ownerId, repoId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      !UUID.test(operationId || ''))
    throw new TypeError('Invalid bootstrap promotion scope');
  return { ownerId, repoId, operationId };
}

function verifyStagedRows(staged, tree) {
  if (!Array.isArray(staged) || staged.length !== tree.notes.length)
    throw new VaultGitHubError('vault-index-promotion-incomplete', 409);
  for (let i = 0; i < staged.length; i++) {
    const row = staged[i], entry = tree.notes[i];
    if (row?.ordinal !== i || row?.noteId !== entry.noteId ||
        row.path !== entry.path || row.blobSha !== entry.blobSha ||
        !UUID.test(row.subjectId || '') ||
        row.subjectId !== row.subjectId.toLowerCase())
      throw new VaultGitHubError('vault-index-promotion-metadata-mismatch', 409);
  }
}

/**
 * B6 internal-only staged index promotion. The complete GitHub tree and
 * operation-scoped metadata are verified before publication. One MongoDB
 * transaction writes the index, tombstones missing files and advances the
 * operation-owned state to verifying; it either commits all or none.
 *
 * This cannot authorize a note write and does not change GitHub or drafts.
 * A crash after the transaction can only leave "bootstrap-staged" (retryable)
 * or "verifying" (reconcile using the existing recovery path).
 */
export async function promoteStagedVaultFileIndex(db, client, identity, {
  credential, operationId,
  treeReader = readVaultBootstrapTree,
  headReader = async (github) => (await github.call(
    '/git/ref/heads/' + encodeURIComponent(github.branch)))?.object?.sha,
} = {}) {
  const key = keyFor(identity, operationId);
  const accountFilter = ownerMutationFilter(key.ownerId, credential);
  if (client?.vault?.repoId !== key.repoId)
    throw new VaultGitHubError('vault-index-promotion-repository-mismatch', 409);
  const account = await db.collection('users').findOne({
    ...accountFilter, 'vault.status': 'connected', 'vault.repoId': key.repoId,
  }, { projection: { _id: 1 } });
  if (!account)
    throw new VaultGitHubError('vault-index-promotion-session-expired', 409);

  const scope = { ownerId: key.ownerId, repoId: key.repoId };
  const states = db.collection('vault_file_index_state');
  const run = await states.findOne(scope);
  if (run?.state !== 'bootstrap-staged' || run.operationId !== operationId ||
      !SHA.test(run.snapshot || '') ||
      !Number.isSafeInteger(run.totalNotes) || run.totalNotes < 0 ||
      run.totalNotes > MAX_INDEX_TREE_ENTRIES ||
      run.nextOffset !== run.totalNotes)
    throw new VaultGitHubError('vault-index-promotion-not-staged', 409);

  const tree = validateVaultBootstrapTreeListing(await treeReader(client));
  if (tree.snapshot !== run.snapshot || tree.notes.length !== run.totalNotes)
    throw new VaultGitHubError('vault-index-promotion-head-changed', 409);

  const staged = await db.collection('vault_file_index_bootstrap').find(key, {
    projection: { _id: 0, ownerId: 1, repoId: 1, operationId: 1,
      ordinal: 1, noteId: 1, subjectId: 1, path: 1, blobSha: 1 },
  }).sort({ ordinal: 1 }).limit(run.totalNotes + 1).toArray();
  if (staged.some((row) => row.ownerId !== key.ownerId ||
      row.repoId !== key.repoId || row.operationId !== operationId))
    throw new VaultGitHubError('vault-index-promotion-scope-mismatch', 409);
  verifyStagedRows(staged, tree);

  // A fresh HEAD check immediately before the transaction avoids
  // publishing already-stale metadata in the common case.
  const head = await headReader(client);
  if (head !== run.snapshot)
    throw new VaultGitHubError('vault-index-promotion-head-changed', 409);

  const files = db.collection('vault_files');
  await withAtomicBackupImport(db, async (session) => {
    // The signed account incarnation and repository mapping are fenced
    // inside the same MongoDB snapshot as the metadata changes.
    const ownerWrite = await db.collection('users').updateOne({
      ...accountFilter, 'vault.status': 'connected', 'vault.repoId': key.repoId,
    }, { $set: { updatedAt: new Date() } }, { session });
    if (ownerWrite.matchedCount !== 1)
      throw new VaultGitHubError('vault-index-promotion-session-expired', 409);

    for (let i = 0; i < staged.length; i += CHUNK) {
      const batch = staged.slice(i, i + CHUNK);
      await files.bulkWrite(batch.map((row) => ({
        updateOne: {
          filter: { ...scope, noteId: row.noteId },
          update: {
            $set: { subjectId: row.subjectId, path: noteFilePath(row.noteId),
              blobSha: row.blobSha, status: 'present',
              lastSeenSnapshot: run.snapshot,
              lastIndexOperationId: operationId, updatedAt: new Date() },
            $setOnInsert: { ...scope, noteId: row.noteId, createdAt: new Date() },
          },
          upsert: true,
        },
      })), { session, ordered: true });
    }

    // The unique operation ID also detects removed files when the same
    // GitHub commit was indexed by an earlier operation.
    await files.updateMany({
      ...scope, status: { $ne: 'missing' },
      lastIndexOperationId: { $ne: operationId },
    }, { $set: { status: 'missing', lastSeenSnapshot: run.snapshot,
      lastIndexOperationId: operationId, updatedAt: new Date() } }, { session });

    const advanced = await states.updateOne({
      ...scope, operationId, state: 'bootstrap-staged',
      snapshot: run.snapshot, totalNotes: run.totalNotes, nextOffset: run.totalNotes,
    }, { $set: { state: 'verifying', updatedAt: new Date() } }, { session });
    if (advanced.matchedCount !== 1)
      throw new VaultGitHubError('vault-index-promotion-raced', 409);
  });

  // A lost GitHub read is not proof of success. "verifying" remains fenced
  // and the existing B6 recovery function can independently finish it.
  let checkedHead = null;
  try { checkedHead = await headReader(client); }
  catch { /* Keep verifying for manual reconciliation. */ }
  if (!SHA.test(checkedHead || ''))
    return { status: 'verifying', action: 'reconcile-verification',
      indexed: staged.length, snapshot: run.snapshot, advisoryOnly: true };

  const status = checkedHead === run.snapshot ? 'ready' : 'stale';
  const result = await states.updateOne({
    ...scope, operationId, state: 'verifying',
    snapshot: run.snapshot, totalNotes: run.totalNotes,
  }, { $set: { state: status,
    reason: status === 'ready' ? null : 'github-head-changed',
    checkedAt: new Date(), updatedAt: new Date() } });
  if (result.matchedCount !== 1)
    throw new VaultGitHubError('vault-index-promotion-confirmation-raced', 409);
  return { status, indexed: staged.length, snapshot: run.snapshot,
    advisoryOnly: true };
}
