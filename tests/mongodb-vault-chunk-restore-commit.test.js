import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { exportVaultNotesSnapshotChunk } from '../lib/oge-vault-backup-export-chunk.js';
import { prepareVaultChunkRestoreBatchIntentReadOnly } from '../lib/oge-vault-backup-chunk-restore-batch-intent.js';
import { executeApprovedVaultChunkRestoreBatch,
  validateVaultChunkRestoreCommitApproval,
} from '../lib/oge-vault-backup-chunk-restore-execute.js';
import { withVaultOwnerDraftWrite } from '../lib/oge-vault-import-fence.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  issueVaultRestoreApprovalTicket, verifyVaultRestoreApprovalTicket,
  recordVaultRestoreApproval, claimVaultRestoreApprovalOnce,
  confirmVaultRestoreApproval,
} from '../lib/oge-vault-restore-approval-ticket.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = { skip: !uri ? 'Requires disposable localhost Mongo replica set' : false };
const H = (s) => createHash('sha1').update(s).digest('hex');
const gitSha = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const SHA_SOURCE = H('m58-src'), TREE_SOURCE = H('m58-src-tree');
const SHA_TARGET = H('m58-head'), TREE_TARGET = H('m58-head-tree');
const FLAGS = {
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_NOTE_API_PREVIEW: 'true',
  OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW: 'true',
  OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true',
  OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW: 'true',
  OGE_VAULT_CHUNK_RESTORE_WRITE_ACK: 'YES_DISPOSABLE_SIGNED_STAGING_ONLY',
};
const idAt = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

async function isolatedDatabase(work) {
  if (!uri ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw new Error('Only explicitly opted-in disposable local replica set');
  const mongo = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000, maxPoolSize: 4,
  });
  await mongo.connect();
  const db = mongo.db('oge_ci_restore_commit_' + randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw Error('Replica set required');
    await work(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }
}

async function fixture(db, { count = 70, removeIds = [idAt(1), idAt(2)],
  failure = null, initialDraftId = null } = {}) {
  const owner = { ownerId: 'm58-' + randomUUID(), repoId: 9874,
    sessionVersion: randomUUID() };
  const subjectId = randomUUID();
  const vault = { status: 'connected', repoId: owner.repoId,
    installationId: 61, githubAccountId: '321', githubLogin: 'synthetic-user',
    repoName: 'ogenotes-vault' };
  await db.collection('users').insertOne({
    googleSub: owner.ownerId, sessionVersion: owner.sessionVersion, vault,
  });
  await db.collection('subjects').insertOne({
    ownerId: owner.ownerId, slug: subjectId,
  });
  const files = new Map(), blobs = new Map();
  for (let i = 1; i <= count; i++) {
    const id = idAt(i), note = validatedNote({
      subjectId, heading: 'PRIVATE SOURCE HEADING ' + i,
      answer: 'PRIVATE SOURCE ANSWER ' + i,
      tags: [], favorite: false,
    }, { id, now: '2026-11-16T12:00:00.000Z' });
    const bytes = Buffer.from(JSON.stringify(note, null, 2) + '\n');
    const sha = gitSha(bytes);
    files.set('notes/' + id + '.json', {
      mode: '100644', sha, bytes, text: bytes.toString('utf8'),
    });
    blobs.set(sha, bytes);
  }
  const trees = new Map([
    [TREE_SOURCE, files],
    [TREE_TARGET, new Map([...files].filter(([name]) =>
      !removeIds.includes(name.slice(6, -5))))],
  ]);
  let head = SHA_SOURCE, next = 0, refPatches = 0, treePosts = 0, commitPosts = 0;
  const commits = new Map([
    [SHA_SOURCE, { sha: SHA_SOURCE, tree: { sha: TREE_SOURCE },
      parents: [], message: 'Source private backup' }],
    [SHA_TARGET, { sha: SHA_TARGET, tree: { sha: TREE_TARGET },
      parents: [{ sha: SHA_SOURCE }], message: 'Delete selected notes' }],
  ]);
  const events = [];
  const client = { branch: 'main', vault, async call(path, options = {}) {
    const method = options.method || 'GET';
    events.push([method, path]);
    if (path === '/git/ref/heads/main') {
      if (failure === 'lost-head-after-patch' && refPatches > 0)
        throw new VaultGitHubError('github-rate-limited', 429);
      if (method === 'GET') return { object: { sha: head } };
      if (method !== 'PATCH' || options.body.force !== false)
        throw Error('Unsafe Git ref mutation');
      refPatches++;
      const commit = commits.get(options.body.sha);
      if (!commit?.parents?.some((p) => p.sha === head))
        throw new VaultGitHubError('github-repository-conflict', 422);
      head = options.body.sha;
      if (failure === 'lost-patch-ack')
        throw new VaultGitHubError('github-network-unavailable', 503);
      return { object: { sha: head } };
    }
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const result = commits.get(path.slice('/git/commits/'.length));
      if (!result) throw new VaultGitHubError('github-api-error', 404);
      return result;
    }
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const tree = trees.get(path.slice('/git/trees/'.length).split('?')[0]);
      if (!tree) throw Error('Missing expected Git tree');
      return { truncated: false, tree: [...tree].map(([key, file]) => ({
        path: key, type: 'blob', mode: file.mode,
        sha: file.sha, size: file.bytes.length,
      })) };
    }
    if (path.startsWith('/git/blobs/') && method === 'GET') {
      const bytes = blobs.get(path.slice('/git/blobs/'.length));
      if (!bytes) throw Error('Missing original Git blob');
      return { content: bytes.toString('base64'), encoding: 'base64' };
    }
    if (path.startsWith('/contents/') && method === 'GET') {
      const file = trees.get(commits.get(head)?.tree?.sha)
        ?.get(path.slice('/contents/'.length).split('?')[0]);
      if (!file) throw new VaultGitHubError('github-api-error', 404);
      return { type: 'file', sha: file.sha,
        content: file.bytes.toString('base64'), encoding: 'base64' };
    }
    if (path === '/git/trees' && method === 'POST') {
      treePosts++;
      const base = trees.get(options.body.base_tree);
      if (!base) throw Error('Unexpected base tree');
      const output = new Map(base);
      for (const item of options.body.tree) {
        if (item.sha === null) output.delete(item.path);
        else {
          const bytes = Buffer.from(item.content);
          const sha = gitSha(bytes);
          blobs.set(sha, bytes);
          output.set(item.path, { sha, bytes, text: item.content,
            mode: item.mode });
        }
      }
      const sha = H('m58-next-tree-' + ++next);
      trees.set(sha, output);
      return { sha };
    }
    if (path === '/git/commits' && method === 'POST') {
      commitPosts++;
      const sha = H('m58-next-commit-' + ++next);
      commits.set(sha, {
        sha, tree: { sha: options.body.tree },
        parents: options.body.parents.map((p) => ({ sha: p })),
        message: options.body.message,
      });
      return { sha };
    }
    throw Error('Unexpected simulated Git request: ' + method + ' ' + path);
  } };
  const subjectVerifier = async (ids) => ids.length === 1 && ids[0] === subjectId;
  const pendingDraftIds = async (ids) => {
    const rows = await db.collection('vault_drafts').find({
      ownerId: owner.ownerId, repoId: owner.repoId,
      noteId: { $in: ids },
    }, { projection: { _id: 0, noteId: 1 } }).toArray();
    return rows.map((x) => x.noteId);
  };
  const ownerVerifier = async () => {
    const row = await db.collection('users').findOne({
      googleSub: owner.ownerId, sessionVersion: owner.sessionVersion,
    });
    return row?.vault?.installationId === vault.installationId &&
      row.vault.repoId === owner.repoId;
  };
  const parts = [];
  let snapshot = null, afterId = null;
  while (true) {
    const chunk = await exportVaultNotesSnapshotChunk(client, {
      snapshot, afterId, subjectVerifier,
    });
    parts.push(chunk);
    if (!chunk.hasMore) break;
    snapshot = chunk.snapshot;
    afterId = chunk.nextAfterId;
  }
  head = SHA_TARGET;
  events.length = 0;
  if (initialDraftId) await db.collection('vault_drafts').insertOne({
    ownerId: owner.ownerId, repoId: owner.repoId, noteId: initialDraftId,
    revision: 1, encrypted: { ciphertext: 'synthetic encrypted draft' },
  });
  const selection = (ids) => ({
    confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH',
    expectedSourceSnapshot: SHA_SOURCE,
    expectedSourceInventorySha256: parts[0].inventorySha256,
    expectedTargetHead: SHA_TARGET, selectedIds: ids,
  });
  const preview = (ids) =>
    prepareVaultChunkRestoreBatchIntentReadOnly(client, parts, selection(ids), {
      subjectVerifier, pendingDraftIds, ownerVerifier,
    });
  const commitApproval = (ids, fingerprint) => ({
    ...selection(ids),
    confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
    expectedSelectionFingerprint: fingerprint,
  });
  return { owner, client, events, parts, preview, commitApproval,
    get refPatches() { return refPatches; },
    get treePosts() { return treePosts; },
    get commitPosts() { return commitPosts; },
    get head() { return head; },
    get storedNotes() { return [...trees.get(commits.get(head)?.tree.sha)].filter(
      ([name]) => name.startsWith('notes/')); },
  };
}

test('M58 confirmation and staging flags must be distinct from M57 read-only intent', () => {
  const valid = {
    confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
    expectedSourceSnapshot: SHA_SOURCE,
    expectedSourceInventorySha256: 'a'.repeat(64),
    expectedTargetHead: SHA_TARGET,
    selectedIds: [idAt(1)],
    expectedSelectionFingerprint: 'b'.repeat(64),
  };
  assert.deepEqual(validateVaultChunkRestoreCommitApproval(valid).selectedIds,
    valid.selectedIds);
  for (const bad of [
    { ...valid, confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH' },
    { ...valid, confirmation: 'IMPORT_SELECTED_NEW_NOTES' },
    { ...valid, expectedSelectionFingerprint: 'invalid' },
    { ...valid, selectedIds: Array.from({ length: 13 }, (_, i) => idAt(i + 1)) },
    { ...valid, selectedIds: [idAt(1), idAt(1)] },
    { ...valid, extra: true },
  ]) assert.throws(() => validateVaultChunkRestoreCommitApproval(bad),
    (e) => e.status === 400);
});

test('M58 default-off gate refuses any GitHub write or Mongo lock acquisition', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db);
    const intent = await f.preview([idAt(1)]);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      f.commitApproval([idAt(1)], intent.selectionFingerprint)),
    (e) => e.status === 404);
    assert.equal(f.refPatches, 0);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    })).vaultImportLock, undefined);
  });
});

test('M58 actual Git CAS writer creates verified <=12 historical notes once and releases lock', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, { count: 70 });
    const ids = [idAt(1), idAt(2)];
    const intent = await f.preview(ids);
    assert.equal(intent.eligibleForIndependentApproval, true);
    const result = await executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      f.commitApproval(ids, intent.selectionFingerprint), { env: FLAGS });
    assert.equal(result.format, 'oge-vault-chunk-restore-batch-result');
    assert.deepEqual(result.restoredIds, ids);
    assert.equal(result.restoredCount, 2);
    assert.equal(result.remainingSourceNotes, 68);
    assert.equal(result.overwritePerformed, false);
    assert.equal(result.encryptedDraftsChanged, false);
    assert.equal(result.nextBatchAutoStarted, false);
    assert.equal(f.treePosts, 1);
    assert.equal(f.commitPosts, 1);
    assert.equal(f.refPatches, 1);
    assert.equal(f.storedNotes.length, 70);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    })).vaultImportLock, undefined);
    assert.equal(await db.collection('vault_drafts').countDocuments({
      ownerId: f.owner.ownerId,
    }), 0);
    for (const secret of ['PRIVATE SOURCE ANSWER', 'PRIVATE SOURCE HEADING'])
      assert.equal(JSON.stringify(result).includes(secret), false);
    const ownerRow = await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    });
    assert.equal(JSON.stringify(ownerRow).includes('PRIVATE SOURCE ANSWER'), false);
    assert.ok(f.events.some(([method]) => method === 'PATCH'));
  });
});

test('M58 selected existing note or encrypted draft blocks before any Git write', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, { initialDraftId: idAt(1) });
    const ids = [idAt(1), idAt(2)];
    const intent = await f.preview(ids);
    assert.equal(intent.eligibleForIndependentApproval, false);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      f.commitApproval(ids, intent.selectionFingerprint), { env: FLAGS }),
    (e) => e.status === 409);
    assert.equal(f.refPatches, 0);
    assert.equal(f.treePosts, 0);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    })).vaultImportLock, undefined);
    assert.equal(await db.collection('vault_drafts').countDocuments({
      ownerId: f.owner.ownerId,
    }), 1);
  });
});

test('M58 lost HEAD response after successful remote ref update retains durable quarantine and no retry', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, { failure: 'lost-head-after-patch' });
    const ids = [idAt(1)];
    const intent = await f.preview(ids);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      f.commitApproval(ids, intent.selectionFingerprint), { env: FLAGS }),
    (e) => e.status === 503 &&
      e.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    assert.equal(f.treePosts, 1);
    assert.equal(f.commitPosts, 1);
    assert.equal(f.refPatches, 1);
    assert.ok(f.storedNotes.some(([path]) => path ===
      'notes/' + idAt(1) + '.json'));
    const row = await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    });
    assert.equal(row.vaultImportLock.state, 'github-write-possible');
    assert.equal(row.vaultImportLock.approvedHead, SHA_TARGET);
    assert.deepEqual(row.vaultImportLock.selectedIds, ids);
    await assert.rejects(withVaultOwnerDraftWrite(db, f.owner,
      async () => {}), (e) => e.status === 409);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      f.commitApproval(ids, intent.selectionFingerprint), { env: FLAGS }),
    (e) => e.status === 409);
    assert.equal(f.refPatches, 1, 'no blind replay after lost GitHub ack');
  });
});

test('M58 stale fingerprint and changed source/target fail before mutation and unlock safely', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db);
    const ids = [idAt(1)];
    const intent = await f.preview(ids);
    const forged = f.commitApproval(ids, 'f'.repeat(64));
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts, forged, { env: FLAGS }),
    (e) => e.status === 409);
    assert.equal(f.treePosts, 0);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    })).vaultImportLock, undefined);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts,
      { ...f.commitApproval(ids, intent.selectionFingerprint),
        expectedTargetHead: SHA_SOURCE }, { env: FLAGS }),
    (e) => e.status === 409);
    assert.equal(f.refPatches, 0);
  });
});


test('M59 signed one-time browser ticket -> atomic Mongo claim -> real Git CAS creates one safe batch', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db);
    const ids = [idAt(1), idAt(2)];
    const intent = await f.preview(ids);
    const identity = { ...f.owner,
      installationId: f.client.vault.installationId,
      repoName: f.client.vault.repoName };
    const approved = f.commitApproval(ids, intent.selectionFingerprint);
    const key = 'a1'.repeat(32);
    const now = Date.now();
    const receipt = issueVaultRestoreApprovalTicket(identity, approved, {
      secret: key, now,
    });
    const verified = verifyVaultRestoreApprovalTicket(receipt.ticket, identity, {
      secret: key, now: now + 500,
    });
    await recordVaultRestoreApproval(db, identity, receipt);
    const claim = await claimVaultRestoreApprovalOnce(db, identity, verified);
    assert.equal(claim.claimed, true);
    const result = await executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts, verified.approval, { env: FLAGS });
    await confirmVaultRestoreApproval(db, identity, verified, result.commitSha);
    assert.equal(result.restoredCount, 2);
    assert.equal(f.refPatches, 1);
    assert.equal(f.treePosts, 1);
    assert.equal(f.commitPosts, 1);
    assert.equal((await db.collection('vault_restore_approvals').findOne({
      _id: receipt.nonceHash,
    })).state, 'confirmed');
    await assert.rejects(claimVaultRestoreApprovalOnce(
      db, identity, verified), /vault-restore-approval-already-used-or-expired/);
    assert.equal(f.refPatches, 1, 'the receipt cannot cause a second write');
    const records = JSON.stringify(await db.collection('vault_restore_approvals').find({}).toArray());
    assert.equal(records.includes('PRIVATE SOURCE ANSWER'), false);
    assert.equal(records.includes(receipt.ticket), false);
    assert.equal(await db.collection('vault_drafts').countDocuments({}), 0);
  });
});

test('M59 lost GitHub write verification consumes approval and preserves owner quarantine without replay', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, { failure: 'lost-head-after-patch' });
    const ids = [idAt(1)], intent = await f.preview(ids);
    const identity = { ...f.owner,
      installationId: f.client.vault.installationId,
      repoName: f.client.vault.repoName };
    const approval = f.commitApproval(ids, intent.selectionFingerprint);
    const secret = '7c'.repeat(32);
    const receipt = issueVaultRestoreApprovalTicket(identity, approval, { secret });
    const verified = verifyVaultRestoreApprovalTicket(receipt.ticket, identity,
      { secret });
    await recordVaultRestoreApproval(db, identity, receipt);
    await claimVaultRestoreApprovalOnce(db, identity, verified);
    await assert.rejects(executeApprovedVaultChunkRestoreBatch(
      db, f.owner, f.client, f.parts, verified.approval, { env: FLAGS }),
    (e) => e.status === 503 &&
      e.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    assert.equal(f.refPatches, 1);
    assert.equal(f.treePosts, 1);
    assert.equal((await db.collection('vault_restore_approvals').findOne({
      _id: receipt.nonceHash,
    })).state, 'claimed');
    assert.equal((await db.collection('users').findOne({
      googleSub: f.owner.ownerId,
    })).vaultImportLock.state, 'github-write-possible');
    await assert.rejects(claimVaultRestoreApprovalOnce(
      db, identity, verified), /vault-restore-approval-already-used-or-expired/);
    assert.equal(f.refPatches, 1);
  });
});
