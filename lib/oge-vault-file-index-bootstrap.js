import { randomUUID } from 'node:crypto';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { withAtomicBackupImport } from './atomic-backup-import.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { noteFilePath, readVaultNoteBlob } from './oge-vault-notes.js';
import { MAX_INDEX_TREE_ENTRIES } from './oge-vault-file-index-incremental.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const MAX_CHUNK = 100;

function checkedScope(identity) {
  if (typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId < 1)
    throw new TypeError('Invalid Vault index bootstrap scope');
  return { ownerId: identity.ownerId, repoId: identity.repoId };
}
async function authenticated(db, client, identity, credential) {
  const key = checkedScope(identity);
  if (client?.vault?.repoId !== key.repoId)
    throw new VaultGitHubError('vault-index-bootstrap-repository-mismatch', 409);
  const filter = ownerMutationFilter(key.ownerId, credential);
  const account = await db.collection('users').findOne({
    ...filter, 'vault.status': 'connected', 'vault.repoId': key.repoId,
  }, { projection: { _id: 1 } });
  if (!account) throw new VaultGitHubError('vault-index-bootstrap-session-expired', 409);
  return { key, filter };
}

async function checkedTree(client) {
  const ref = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const snapshot = (await client.call(ref))?.object?.sha;
  if (!SHA.test(snapshot || ''))
    throw new VaultGitHubError('vault-index-bootstrap-head-invalid', 409);
  const commit = await client.call('/git/commits/' + snapshot);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw new VaultGitHubError('vault-index-bootstrap-commit-invalid', 409);
  const response = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(response?.tree) || response.truncated === true ||
      response.tree.length > MAX_INDEX_TREE_ENTRIES)
    throw new VaultGitHubError('vault-index-bootstrap-tree-incomplete', 409);
  const notes = [];
  const seen = new Set();
  for (const entry of response.tree) {
    if (typeof entry?.path !== 'string' || !entry.path.startsWith('notes/')) continue;
    if (entry.type !== 'blob' || !/^notes\/[a-f0-9-]{36}\.json$/.test(entry.path) ||
        !SHA.test(entry.sha || '') ||
        (entry.size !== undefined && (!Number.isSafeInteger(entry.size) ||
          entry.size > 32768)))
      throw new VaultGitHubError('vault-index-bootstrap-path-invalid', 409);
    const noteId = entry.path.slice(6, -5);
    if (!UUID.test(noteId) || seen.has(noteId) || noteFilePath(noteId) !== entry.path)
      throw new VaultGitHubError('vault-index-bootstrap-path-invalid', 409);
    seen.add(noteId);
    notes.push({ noteId, path: entry.path, blobSha: entry.sha.toLowerCase() });
  }
  notes.sort((a, b) => a.noteId.localeCompare(b.noteId));
  const after = (await client.call(ref))?.object?.sha;
  if (after !== snapshot)
    throw new VaultGitHubError('vault-index-bootstrap-head-changed', 409);
  return { snapshot, notes };
}

/**
 * INTERNAL ONLY. Claim an operation-owned B6 staging run after verifying
 * GitHub and the authenticated account. Does not alter vault_files or Notes.
 * No HTTP route calls these functions. Even the completed staged state is
 * NOT a published or authoritative index.
 */
export async function beginVaultFileIndexBootstrap(db, client, identity, {
  credential, operationId = randomUUID(), treeReader = checkedTree,
} = {}) {
  const { key } = await authenticated(db, client, identity, credential);
  if (!UUID.test(operationId)) throw new TypeError('Invalid bootstrap operation ID');
  const { snapshot, notes } = await treeReader(client);
  if (!SHA.test(snapshot || '') || !Array.isArray(notes) ||
      notes.length > MAX_INDEX_TREE_ENTRIES ||
      notes.some((note) => !UUID.test(note?.noteId || '') ||
        note.path !== noteFilePath(note.noteId) || !SHA.test(note.blobSha || '')))
    throw new VaultGitHubError('vault-index-bootstrap-tree-invalid', 409);
  const states = db.collection('vault_file_index_state');
  const now = new Date();
  let result;
  try {
    result = await states.updateOne({
      ...key, $or: [{ state: { $exists: false } }, { state: { $in: ['ready', 'stale'] } }],
    }, { $set: { state: 'bootstrapping', operationId,
      snapshot, totalNotes: notes.length, nextOffset: 0,
      startedAt: now, updatedAt: now },
    $setOnInsert: key }, { upsert: true });
  } catch (error) {
    if (error?.code === 11000)
      throw new VaultGitHubError('vault-index-bootstrap-busy', 409);
    throw error;
  }
  if (result.matchedCount !== 1 && result.upsertedCount !== 1)
    throw new VaultGitHubError('vault-index-bootstrap-busy', 409);
  return { operationId, snapshot, totalNotes: notes.length, nextOffset: 0,
    status: 'bootstrapping', advisoryOnly: true };
}

/**
 * A retryable, bounded metadata stage. Every page is pinned to the original
 * GitHub head, and staged rows plus the cursor advance in ONE MongoDB
 * transaction. A crash cannot publish a partially indexed repository.
 * If GitHub changes, the state stays fenced for audited manual review.
 */
export async function advanceVaultFileIndexBootstrap(db, client, identity, {
  credential, operationId, limit = MAX_CHUNK,
  treeReader = checkedTree, reader = readVaultNoteBlob,
} = {}) {
  const { key, filter } = await authenticated(db, client, identity, credential);
  if (!UUID.test(operationId || '') ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHUNK)
    throw new TypeError('Invalid bootstrap cursor/limit');
  const states = db.collection('vault_file_index_state');
  const run = await states.findOne(key);
  if (run?.operationId !== operationId || run.state !== 'bootstrapping' ||
      !SHA.test(run.snapshot || '') ||
      !Number.isSafeInteger(run.totalNotes) ||
      !Number.isSafeInteger(run.nextOffset) || run.nextOffset < 0 ||
      run.nextOffset > run.totalNotes || run.totalNotes > MAX_INDEX_TREE_ENTRIES)
    throw new VaultGitHubError('vault-index-bootstrap-fence-missing', 409);

  const remote = await treeReader(client);
  if (remote.snapshot !== run.snapshot || remote.notes.length !== run.totalNotes)
    throw new VaultGitHubError('vault-index-bootstrap-head-changed', 409);
  const slice = remote.notes.slice(run.nextOffset, run.nextOffset + limit);
  const records = [];
  for (let i = 0; i < slice.length; i += 5) {
    const batch = slice.slice(i, i + 5);
    records.push(...await Promise.all(batch.map(async (entry, offset) => {
      const note = await reader(client, entry.noteId, entry.blobSha);
      if (note?.id !== entry.noteId || !UUID.test(note?.subjectId || '') ||
          note.sha !== entry.blobSha)
        throw new VaultGitHubError('vault-index-bootstrap-note-invalid', 409);
      return { ...key, operationId, ordinal: run.nextOffset + i + offset,
        noteId: entry.noteId, subjectId: note.subjectId.toLowerCase(),
        path: entry.path, blobSha: entry.blobSha };
    })));
  }
  const latest = (await client.call(
    '/git/ref/heads/' + encodeURIComponent(client.branch)))?.object?.sha;
  if (latest !== run.snapshot)
    throw new VaultGitHubError('vault-index-bootstrap-head-changed', 409);

  const nextOffset = run.nextOffset + records.length;
  await withAtomicBackupImport(db, async (session) => {
    const account = await db.collection('users').updateOne({
      ...filter, 'vault.status': 'connected', 'vault.repoId': key.repoId,
    }, { $set: { updatedAt: new Date() } }, { session });
    if (account.matchedCount !== 1)
      throw new VaultGitHubError('vault-index-bootstrap-session-expired', 409);
    if (records.length) await db.collection('vault_file_index_bootstrap').bulkWrite(
      records.map((row) => ({ updateOne: {
        filter: { ...key, operationId, noteId: row.noteId },
        update: { $set: row }, upsert: true,
      } })), { session, ordered: true });
    const updated = await states.updateOne({
      ...key, operationId, state: 'bootstrapping',
      snapshot: run.snapshot, totalNotes: run.totalNotes, nextOffset: run.nextOffset,
    }, { $set: { nextOffset,
      state: nextOffset === run.totalNotes ? 'bootstrap-staged' : 'bootstrapping',
      updatedAt: new Date() } }, { session });
    if (updated.matchedCount !== 1)
      throw new VaultGitHubError('vault-index-bootstrap-cursor-raced', 409);
  });
  return { operationId, snapshot: run.snapshot, totalNotes: run.totalNotes,
    nextOffset, status: nextOffset === run.totalNotes ?
      'bootstrap-staged' : 'bootstrapping', advisoryOnly: true };
}
