import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { withAtomicBackupImport } from '../lib/atomic-backup-import.js';
import { withActiveOwnerMutation } from '../lib/active-owner-mutation.js';
import { deleteSubjectAtomically } from '../lib/atomic-subject-deletion.js';
import { deleteAccountDataAtomically, ACCOUNT_OWNER_COLLECTIONS } from '../lib/account-deletion-transaction.js';
import { promoteStagedVaultFileIndex } from '../lib/oge-vault-file-index-promotion.js';
import { reconcileVaultFileIndexVerification } from '../lib/oge-vault-file-index-recovery.js';
import { reconcileConfirmedVaultDraft } from '../lib/oge-vault-save-finalize.js';
import { retireConfirmedVaultDraftWithReceipt, readConfirmedVaultSaveReceipt } from '../lib/oge-vault-save-receipt.js';
import { inspectVaultLegacyData } from '../lib/oge-vault-legacy-inventory.js';
import { inspectLegacyCutoverForOwner } from '../lib/oge-vault-cutover-guard.js';
import { withVaultOwnerDraftWrite, withVaultOwnerImportExclusive } from '../lib/oge-vault-import-fence.js';
import { inspectVaultImportLockReadOnly } from '../lib/oge-vault-import-lock-inspection.js';
import { releasePreWriteVaultImportLockInStaging } from '../lib/oge-vault-import-lock-prewrite-release.js';
import { inspectVaultImportAttemptEvidenceReadOnly } from '../lib/oge-vault-import-attempt-evidence.js';
import { inspectVaultImportArchiveContentReadOnly } from '../lib/oge-vault-import-archive-proof.js';
import { approvedVaultImportCommitMessage, validateVaultNotesImportApproval } from '../lib/oge-vault-backup-import-commit.js';
import { validatedNote } from '../lib/oge-vault-notes.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = { skip: !uri ? 'Set OGE_TEST_MONGODB_URI for isolated replica-set integration tests' : false };
const epochA = 'a0e31394-d318-4b1e-a01b-e9f74636db6a';
const epochB = 'b8e48f26-640c-4dfa-89d8-d6d68c302809';

async function isolatedDatabase(run) {
  // CI tests only ever connect to a local disposable Docker replica set.
  // Never accept an Atlas or remote URI, even with the opt-in flag.
  if (!uri || !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri)) {
    throw new Error('Use only a disposable local MongoDB replica set on port 27017');
  }
  if (process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE') {
    throw new Error('Set OGE_ALLOW_MONGO_INTEGRATION_TESTS=YES_DISPOSABLE_DATABASE; tests create/drop test databases');
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 4 });
  await client.connect();
  const name = 'oge_ci_' + randomUUID().replaceAll('-', '');
  const db = client.db(name);
  try {
    const hello = await db.admin().command({ hello: 1 });
    assert.ok(hello.setName, 'MongoDB integration tests require a replica set');
    await run(db);
  } finally {
    try { await db.dropDatabase(); } finally { await client.close(); }
  }
}

test('real MongoDB transaction commits owner and note together', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    const result = await withActiveOwnerMutation(db, 'owner-A', async (session) => {
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'good' }, { session });
      return 'saved';
    }, { sessionVersion: epochA });
    assert.equal(result, 'saved');
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 1);
    assert.ok((await db.collection('users').findOne({ googleSub: 'owner-A' })).updatedAt instanceof Date);
  });
});

test('real MongoDB transaction rolls back all collection writes on failure', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    await assert.rejects(withActiveOwnerMutation(db, 'owner-A', async (session) => {
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'should-rollback' }, { session });
      await db.collection('subjects').insertOne({ ownerId: 'owner-A', slug: 'should-rollback' }, { session });
      throw new Error('intentional rollback');
    }, { sessionVersion: epochA }), /intentional rollback/);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 0);
    assert.equal(await db.collection('subjects').countDocuments({ ownerId: 'owner-A' }), 0);
    assert.equal((await db.collection('users').findOne({ googleSub: 'owner-A' })).updatedAt, undefined);
  });
});

test('real MongoDB refuses stale session after account recreation and isolates owners', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertMany([
      { googleSub: 'owner-A', sessionVersion: epochB },
      { googleSub: 'owner-B', sessionVersion: epochA },
    ]);
    await assert.rejects(withActiveOwnerMutation(db, 'owner-A', async (session) => {
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'unauthorized' }, { session });
    }, { sessionVersion: epochA }), /Account session no longer exists/);
    assert.equal(await db.collection('notes').countDocuments({}), 0);
    await withActiveOwnerMutation(db, 'owner-B', async (session) => {
      await db.collection('notes').insertOne({ ownerId: 'owner-B', heading: 'private' }, { session });
    }, { sessionVersion: epochA });
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 0);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-B' }), 1);
  });
});

test('real MongoDB subject cascade deletion removes owned notes atomically', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    await db.collection('subjects').insertMany([
      { _id: 'subject-1', ownerId: 'owner-A', slug: 'first' },
      { _id: 'subject-2', ownerId: 'owner-A', slug: 'second' },
      { _id: 'other-subject', ownerId: 'owner-B', slug: 'first' },
    ]);
    await db.collection('notes').insertMany([
      { ownerId: 'owner-A', subjectSlug: 'first', heading: 'delete me' },
      { ownerId: 'owner-A', subjectSlug: 'second', heading: 'keep me' },
      { ownerId: 'owner-B', subjectSlug: 'first', heading: 'other user' },
    ]);
    assert.deepEqual(await deleteSubjectAtomically(db, 'owner-A', 'first', { sessionVersion: epochA }), { status: 'deleted' });
    assert.equal(await db.collection('subjects').countDocuments({ ownerId: 'owner-A' }), 1);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 1);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-B' }), 1);
    assert.deepEqual(await deleteSubjectAtomically(db, 'owner-A', 'second', { sessionVersion: epochA }), { status: 'last-subject' });
    assert.equal(await db.collection('subjects').countDocuments({ ownerId: 'owner-A' }), 1);
  });
});

test('real MongoDB backup helper rolls back a multi-collection partial restore', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await assert.rejects(withAtomicBackupImport(db, async (session) => {
      await db.collection('subjects').insertOne({ ownerId: 'owner-A', slug: 'restored' }, { session });
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'restored' }, { session });
      throw new Error('restore interrupted');
    }), /restore interrupted/);
    assert.equal(await db.collection('subjects').countDocuments({}), 0);
    assert.equal(await db.collection('notes').countDocuments({}), 0);
  });
});

test('real MongoDB account deletion and re-registration reject an old in-flight session', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'old account note' });

    await withAtomicBackupImport(db, async (session) => {
      await db.collection('notes').deleteMany({ ownerId: 'owner-A' }, { session });
      const deleted = await db.collection('users').deleteOne(
        { googleSub: 'owner-A', sessionVersion: epochA }, { session },
      );
      assert.equal(deleted.deletedCount, 1);
    });
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 0);
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochB });

    await assert.rejects(
      withActiveOwnerMutation(db, 'owner-A', async (session) => {
        await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'stale request' }, { session });
      }, { sessionVersion: epochA }),
      /Account session no longer exists/,
    );
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 0);
    await withActiveOwnerMutation(db, 'owner-A', async (session) => {
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'new account note' }, { session });
    }, { sessionVersion: epochB });
    assert.deepEqual(
      (await db.collection('notes').find({ ownerId: 'owner-A' }).toArray()).map((note) => note.heading),
      ['new account note'],
    );
  });
});

test('real MongoDB snapshot export keeps a consistent view during concurrent writes', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'before snapshot' });

    const snapshot = await withAtomicBackupImport(db, async (session) => {
      const user = await db.collection('users').findOne(
        { googleSub: 'owner-A', sessionVersion: epochA }, { session },
      );
      assert.ok(user);
      const before = await db.collection('notes').find(
        { ownerId: 'owner-A' }, { session },
      ).toArray();
      assert.equal(before.length, 1);

      // A separate connection/operation inserts after the transaction snapshot
      // was established. This write should not appear on the same snapshot.
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'after snapshot' });
      const after = await db.collection('notes').find(
        { ownerId: 'owner-A' }, { session },
      ).toArray();
      return { before, after };
    });
    assert.deepEqual(snapshot.before.map((note) => note.heading), ['before snapshot']);
    assert.deepEqual(snapshot.after.map((note) => note.heading), ['before snapshot']);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 2);
  });
});

test('real account deletion helper removes all owned collections but preserves another user', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertMany([
      { googleSub: 'owner-A', sessionVersion: epochA, geminiApiKey: { encrypted: 'synthetic' } },
      { googleSub: 'owner-B', sessionVersion: epochB },
    ]);
    for (const name of ACCOUNT_OWNER_COLLECTIONS) {
      await db.collection(name).insertMany([
        { ownerId: 'owner-A', marker: 'delete' },
        { ownerId: 'owner-B', marker: 'keep' },
      ]);
    }
    assert.deepEqual(await deleteAccountDataAtomically(db, 'owner-A', epochA), { deleted: true });
    assert.equal(await db.collection('users').countDocuments({ googleSub: 'owner-A' }), 0);
    assert.equal(await db.collection('users').countDocuments({ googleSub: 'owner-B' }), 1);
    for (const name of ACCOUNT_OWNER_COLLECTIONS) {
      assert.equal(await db.collection(name).countDocuments({ ownerId: 'owner-A' }), 0, name);
      assert.equal(await db.collection(name).countDocuments({ ownerId: 'owner-B' }), 1, name);
    }
  });
});

test('real account deletion helper refuses a stale signed session after re-registration', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochB });
    await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'replacement account note' });
    await assert.rejects(deleteAccountDataAtomically(db, 'owner-A', epochA), /Account session changed/);
    assert.equal(await db.collection('users').countDocuments({ googleSub: 'owner-A', sessionVersion: epochB }), 1);
    assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 1);
  });
});

test('real overlapping note insert and deletion cannot commit orphaned data', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    await db.collection('users').insertOne({ googleSub: 'owner-A', sessionVersion: epochA });
    // Keep the mutation transaction open after writing the user account row,
    // while the deletion is initiated from a distinct MongoDB session.
    let signalStarted;
    let releaseMutation;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const proceed = new Promise((resolve) => { releaseMutation = resolve; });
    const mutation = withActiveOwnerMutation(db, 'owner-A', async (session) => {
      signalStarted();
      await proceed;
      await db.collection('notes').insertOne({ ownerId: 'owner-A', heading: 'simultaneous note' }, { session });
      return 'committed note';
    }, { sessionVersion: epochA });
    await started;
    const deletion = deleteAccountDataAtomically(db, 'owner-A', epochA);
    // Both operations have now been launched before either finishes.
    releaseMutation();
    const outcomes = await Promise.allSettled([mutation, deletion]);
    // MongoDB may resolve the write conflict by aborting/retrying one
    // transaction. Both results are acceptable *only* if the invariants hold.
    const user = await db.collection('users').findOne({ googleSub: 'owner-A' });
    const noteCount = await db.collection('notes').countDocuments({ ownerId: 'owner-A' });
    if (!user) assert.equal(noteCount, 0, 'deleted account must have no orphaned notes');
    if (outcomes[1].status === 'fulfilled') {
      assert.equal(user, null, 'successful deletion must remove account');
      assert.equal(noteCount, 0, 'successful deletion must remove concurrent notes');
    } else {
      // A transaction conflict can abort deletion without deleting anything.
      // A fresh retry after the concurrent mutation must cleanly complete.
      assert.ok(user, 'aborted deletion must leave an account to retry');
      assert.deepEqual(await deleteAccountDataAtomically(db, 'owner-A', epochA), { deleted: true });
      assert.equal(await db.collection('notes').countDocuments({ ownerId: 'owner-A' }), 0);
    }
  });
});

/**
 * Real replica-set B6 tests: exercise the SAME MongoDB transaction that
 * publishes staged metadata, not mocked collection semantics.
 * GitHub is stubbed, so these do not claim live GitHub verification.
 */
function fileIndexPromotionFixture(count = 501) {
  const ownerId = 'vault-index-' + randomUUID();
  const repoId = 881;
  const operationId = randomUUID();
  const sessionVersion = randomUUID();
  const subjectId = randomUUID();
  const snapshot = 'a'.repeat(40);
  const notes = Array.from({ length: count }, () => {
    const noteId = randomUUID();
    return { noteId, subjectId, path: 'notes/' + noteId + '.json',
      blobSha: 'b'.repeat(40) };
  }).sort((a, b) => a.noteId.localeCompare(b.noteId));
  const scope = { ownerId, repoId };
  const identity = { ownerId, repoId };
  const client = { branch: 'main', vault: { repoId } };
  const credential = { sessionVersion };
  const treeReader = async () => ({ snapshot, notes });
  const headReader = async () => snapshot;
  const promote = (db, extra = {}) => promoteStagedVaultFileIndex(
    db, client, identity,
    { operationId, credential, treeReader, headReader, ...extra });
  const seed = async (db) => {
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    await db.collection('vault_file_index_state').insertOne({
      ...scope, state: 'bootstrap-staged', operationId, snapshot,
      totalNotes: notes.length, nextOffset: notes.length,
    });
    await db.collection('vault_file_index_bootstrap').insertMany(notes.map((note, ordinal) => ({
      ...scope, operationId, ordinal, ...note,
    })));
    const oldNoteId = randomUUID();
    await db.collection('vault_files').insertOne({
      ...scope, noteId: oldNoteId, subjectId, status: 'present',
      path: 'notes/' + oldNoteId + '.json', blobSha: 'c'.repeat(40),
      lastSeenSnapshot: snapshot,
    });
    return oldNoteId;
  };
  return { scope, identity, client, credential, operationId, snapshot,
    notes, seed, promote };
}

test('real MongoDB commits 501 GitHub-derived metadata rows and tombstone together', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = fileIndexPromotionFixture();
    await db.collection('vault_files').createIndex({ ownerId: 1, repoId: 1, noteId: 1 },
      { unique: true });
    const oldNoteId = await f.seed(db);
    const status = await f.promote(db);
    assert.equal(status.status, 'ready');
    assert.equal(status.indexed, 501);
    assert.equal(await db.collection('vault_files').countDocuments({
      ...f.scope, status: 'present' }), 501);
    const old = await db.collection('vault_files').findOne({
      ...f.scope, noteId: oldNoteId });
    assert.equal(old.status, 'missing');
    assert.equal((await db.collection('vault_file_index_state').findOne(f.scope)).state,
      'ready');
    const documents = await db.collection('vault_files').find(f.scope).toArray();
    assert.ok(documents.every((row) =>
      !Object.hasOwn(row, 'answer') && !Object.hasOwn(row, 'heading') &&
      !Object.hasOwn(row, 'tags') && !Object.hasOwn(row, 'content')));
  });
});

test('real MongoDB aborts all publication rows and state on failure after first 250', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = fileIndexPromotionFixture();
    const oldNoteId = await f.seed(db);
    let bulks = 0;
    const faultDb = {
      client: db.client,
      collection(name) {
        const collection = db.collection(name);
        if (name !== 'vault_files') return collection;
        return new Proxy(collection, {
          get(target, property) {
            if (property === 'bulkWrite') {
              return async (...args) => {
                bulks++;
                if (bulks === 2) throw new Error('synthetic-batch-2-failure');
                return target.bulkWrite(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    await assert.rejects(f.promote(faultDb), /synthetic-batch-2-failure/);
    assert.equal(bulks, 2);
    assert.equal(await db.collection('vault_files').countDocuments(f.scope), 1);
    assert.equal((await db.collection('vault_files').findOne({
      ...f.scope, noteId: oldNoteId })).status, 'present');
    const state = await db.collection('vault_file_index_state').findOne(f.scope);
    assert.equal(state.state, 'bootstrap-staged');
    assert.equal(state.nextOffset, 501);
    // Staged metadata remains so a verified operator retry is possible.
    assert.equal(await db.collection('vault_file_index_bootstrap').countDocuments({
      ...f.scope, operationId: f.operationId }), 501);
  });
});

test('real MongoDB resolves interrupted post-commit verification without rewriting notes', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = fileIndexPromotionFixture(51);
    await f.seed(db);
    let reads = 0;
    const result = await f.promote(db, {
      headReader: async () => {
        if (++reads === 1) return f.snapshot;
        throw new Error('synthetic lost GitHub response');
      },
    });
    assert.equal(result.status, 'verifying');
    assert.equal((await db.collection('vault_file_index_state').findOne(f.scope)).state,
      'verifying');

    const scan = async (_client, scope, { existingRows }) => {
      assert.equal(existingRows.length, 51);
      return { ...scope, snapshot: f.snapshot, totalNotes: 51,
        files: f.notes.map((note) => ({ ...scope,
          noteId: note.noteId, subjectId: note.subjectId,
          path: note.path, blobSha: note.blobSha })),
        advisoryOnly: true };
    };
    const recovery = await reconcileVaultFileIndexVerification(db, f.client,
      f.identity, { credential: f.credential, scanner: scan,
        headReader: async () => f.snapshot });
    assert.equal(recovery.status, 'ready');
    assert.equal((await db.collection('vault_file_index_state').findOne(f.scope)).state,
      'ready');
    assert.equal(await db.collection('vault_files').countDocuments({
      ...f.scope, status: 'present' }), 51);
  });
});

test('real MongoDB account deletion blocks connected GitHub Vaults without removing their mapping', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'vault-owner-' + randomUUID();
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion: epochA,
      vault: { status: 'connected', repoId: 771, installationId: 99 },
    });
    await db.collection('vault_drafts').insertOne({
      ownerId, repoId: 771, noteId: randomUUID(),
      encrypted: { ciphertext: 'synthetic-test-only' },
    });
    await assert.rejects(deleteAccountDataAtomically(db, ownerId, epochA),
      /Vault account deletion is disabled/);
    assert.equal(await db.collection('users').countDocuments({ googleSub: ownerId }), 1);
    assert.equal(await db.collection('vault_drafts').countDocuments({ ownerId }), 1);
  });
});

test('real MongoDB account deletion blocks orphaned drafts and file-index recovery records', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    for (const collectionName of [
      'vault_drafts', 'vault_file_index_state', 'vault_file_index_bootstrap',
      'vault_files', 'vault_subject_inspections', 'vault_subject_deletion_jobs',
      'vault_save_receipts',
    ]) {
      const ownerId = 'orphan-' + randomUUID();
      await db.collection('users').insertOne({ googleSub: ownerId, sessionVersion: epochA });
      await db.collection(collectionName).insertOne({ ownerId, repoId: 812 });
      await assert.rejects(deleteAccountDataAtomically(db, ownerId, epochA),
        /Vault recovery data exists/);
      assert.equal(await db.collection('users').countDocuments({ googleSub: ownerId }), 1);
      assert.equal(await db.collection(collectionName).countDocuments({ ownerId }), 1);
    }
  });
});

test('real MongoDB B7 ambiguous Save cleanup cannot remove a newer draft revision', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'b7-finalize-' + randomUUID(), repoId = 126;
    const noteId = randomUUID(), sha = 'a'.repeat(40);
    const scope = { ownerId, repoId, noteId };
    const drafts = db.collection('vault_drafts');
    await drafts.createIndex({ ownerId: 1, repoId: 1, noteId: 1 }, { unique: true });
    await drafts.insertOne({ ...scope, revision: 3,
      encrypted: { ciphertext: 'synthetic encrypted draft for test' }, status: 'pending' });
    const client = { branch: 'main', vault: { repoId } };
    const noteReader = async () => ({ id: noteId, sha });
    const verified = async () => ({ confirmed: true, sha, commitSha: 'b'.repeat(40) });

    const first = await reconcileConfirmedVaultDraft(drafts, client, scope, 3, sha, {
      inspector: verified, noteReader,
    });
    assert.equal(first.confirmed, true);
    assert.equal(first.cleared, true);
    assert.equal(await drafts.countDocuments(scope), 0);

    await drafts.insertOne({ ...scope, revision: 3,
      encrypted: { ciphertext: 'new synthetic draft' }, status: 'pending' });
    // Emulate a concurrent autosave completing after remote verification
    // but before the cleanup CAS. The older Save must not remove revision 4.
    const raced = await reconcileConfirmedVaultDraft(drafts, client, scope, 3, sha, {
      inspector: verified, noteReader: async () => {
        await drafts.updateOne({ ...scope, revision: 3 },
          { $set: { revision: 4, encrypted: { ciphertext: 'newer synthetic draft' } } });
        return { id: noteId, sha };
      },
    });
    assert.equal(raced.confirmed, true);
    assert.equal(raced.cleared, false);
    const remaining = await drafts.findOne(scope);
    assert.equal(remaining.revision, 4);
    assert.equal(remaining.encrypted.ciphertext, 'newer synthetic draft');
  });
});

test('real MongoDB B7 receipt cleanup is atomic, idempotent and GitHub reverified', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'save-receipt-' + randomUUID();
    const repoId = 389, noteId = randomUUID(), sessionVersion = randomUUID();
    const scope = { ownerId, repoId, noteId };
    const sha = 'a'.repeat(40), commitSha = 'b'.repeat(40);
    const credential = { sessionVersion };
    const client = { vault: { repoId } };
    const drafts = db.collection('vault_drafts');
    await drafts.createIndex({ ownerId: 1, repoId: 1, noteId: 1 }, { unique: true });
    await db.collection('vault_save_receipts').createIndex(
      { ownerId: 1, repoId: 1, noteId: 1 }, { unique: true });
    await db.collection('users').insertOne({ googleSub: ownerId,
      sessionVersion, vault: { status: 'connected', repoId } });
    await drafts.insertOne({ ...scope, revision: 3,
      encrypted: { ciphertext: 'test encrypted draft' } });

    const written = await retireConfirmedVaultDraftWithReceipt(
      db, scope, 3, sha, commitSha, { credential });
    assert.equal(written, true);
    assert.equal(await drafts.countDocuments(scope), 0);
    const receipt = await db.collection('vault_save_receipts').findOne(scope);
    assert.equal(receipt.revision, 3);
    assert.equal(receipt.sha, sha);
    assert.deepEqual(Object.keys(receipt).filter((field) =>
      ['heading', 'answer', 'content', 'tags', 'draft', 'encrypted'].includes(field)), []);

    const checked = await readConfirmedVaultSaveReceipt(db, client, scope, 3,
      { noteReader: async () => ({ id: noteId, sha }) });
    assert.equal(checked.confirmed, true);
    assert.equal(checked.alreadyCleared, true);
    assert.equal(await retireConfirmedVaultDraftWithReceipt(
      db, scope, 3, sha, commitSha, { credential }), false);
    assert.equal(await db.collection('vault_save_receipts').countDocuments(scope), 1);

    // A fresh encrypted autosave always takes precedence over an older receipt.
    await drafts.insertOne({ ...scope, revision: 4,
      encrypted: { ciphertext: 'newer encrypted test draft' } });
    const stale = await readConfirmedVaultSaveReceipt(db, client, scope, 3,
      { noteReader: async () => ({ id: noteId, sha }) });
    assert.equal(stale.confirmed, false);
    assert.equal(await retireConfirmedVaultDraftWithReceipt(
      db, scope, 3, sha, commitSha, { credential }), false);
    assert.equal((await drafts.findOne(scope)).revision, 4);
  });
});

test('real MongoDB B7 receipt update failure rolls back encrypted draft deletion', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'receipt-abort-' + randomUUID();
    const repoId = 390, noteId = randomUUID(), sessionVersion = randomUUID();
    const scope = { ownerId, repoId, noteId };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    await db.collection('vault_drafts').insertOne({
      ...scope, revision: 2, encrypted: { ciphertext: 'must not disappear' },
    });
    const broken = { client: db.client, collection(name) {
      if (name !== 'vault_save_receipts') return db.collection(name);
      return { async updateOne() { throw new Error('synthetic-receipt-write-failure'); } };
    } };
    await assert.rejects(retireConfirmedVaultDraftWithReceipt(broken, scope,
      2, 'a'.repeat(40), 'b'.repeat(40), { credential: { sessionVersion } }),
    /synthetic-receipt-write-failure/);
    const draft = await db.collection('vault_drafts').findOne(scope);
    assert.equal(draft.revision, 2);
    assert.equal(draft.encrypted.ciphertext, 'must not disappear');
    assert.equal(await db.collection('vault_save_receipts').countDocuments(scope), 0);
  });
});

test('real MongoDB Phase C inventory is count-only and preserves notes, drafts and recovery rows', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'inventory-' + randomUUID();
    const otherOwner = 'other-inventory-' + randomUUID();
    const privateBody = 'SYNTHETIC_NOTE_BODY_NEVER_OUTPUT';
    const collections = [
      ['notes', [{ ownerId, heading: 'Sensitive fake heading', answer: privateBody },
        { heading: 'missing owner synthetic test row' }]],
      ['quickNotes', [{ ownerId, content: privateBody }]],
      ['personalQuickNotes', [{ ownerId: otherOwner, content: privateBody }]],
      ['vault_drafts', [{ ownerId, revision: 3, encrypted: { ciphertext: privateBody } }]],
      ['vault_save_receipts', [{ ownerId, revision: 2, sha: 'a'.repeat(40) }]],
      ['vault_files', [{ ownerId, repoId: 501, noteId: randomUUID(), status: 'present' }]],
      ['vault_file_index_state', [{ ownerId, repoId: 501, state: 'verifying' }]],
      ['vault_file_index_bootstrap', [{ ownerId, repoId: 501, operationId: randomUUID() }]],
      ['vault_subject_inspections', [{ ownerId, repoId: 501, operationId: randomUUID() }]],
      ['vault_subject_deletion_jobs', [{ ownerId, repoId: 501, operationId: randomUUID() }]],
    ];
    for (const [name, rows] of collections)
      await db.collection(name).insertMany(rows);

    const first = await inspectVaultLegacyData(db);
    assert.deepEqual(first.counts, { notes: 2, quickNotes: 1, personalQuickNotes: 1 });
    assert.deepEqual(first.missingOwnerCounts,
      { notes: 1, quickNotes: 0, personalQuickNotes: 0 });
    assert.equal(first.total, 4);
    assert.equal(first.protectedTotal, 7);
    assert.equal(first.cleanupAuthorized, false);
    assert.equal(first.cutoverAuthorized, false);
    assert.doesNotMatch(JSON.stringify(first), /SYNTHETIC_NOTE_BODY|Sensitive fake heading|missing owner synthetic test row|inventory-/);

    const second = await inspectVaultLegacyData(db);
    assert.deepEqual(second, first);
    for (const [name, rows] of collections)
      assert.equal(await db.collection(name).countDocuments({}), rows.length);
    assert.equal((await db.collection('notes').findOne({ ownerId })).answer, privateBody);
    assert.equal((await db.collection('vault_drafts').findOne({ ownerId })).encrypted.ciphertext,
      privateBody);
  });
});

test('real MongoDB Phase D preview blocks a legacy write when Vault connects after initial check', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'cutover-preview-' + randomUUID();
    const sessionVersion = randomUUID();
    const env = {
      OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true',
      OGE_VAULT_MAIN_PREVIEW: 'true',
      OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
    };
    const credential = { sessionVersion };
    await db.collection('users').insertOne({ googleSub: ownerId, sessionVersion });

    const before = await inspectLegacyCutoverForOwner(
      db, ownerId, credential, { env });
    assert.equal(before.blocked, false);

    // The user connects a valid GitHub Vault after a browser preflight but
    // before its old MongoDB note request begins a transaction.
    await db.collection('users').updateOne({ googleSub: ownerId },
      { $set: { vault: { status: 'connected',
        repoId: 704, installationId: 29 } } });

    const result = await withActiveOwnerMutation(db, ownerId, async (session) => {
      const inside = await inspectLegacyCutoverForOwner(
        db, ownerId, credential, { env, session });
      if (inside.blocked) return inside.status;
      await db.collection('notes').insertOne({
        ownerId, heading: 'MUST NOT WRITE', answer: 'synthetic legacy note',
      }, { session });
      return 201;
    }, credential);
    assert.equal(result, 409);
    assert.equal(await db.collection('notes').countDocuments({ ownerId }), 0);

    // Disabled guard preserves old production semantics until a deliberate
    // staging/production rollout is authorized.
    assert.equal((await inspectLegacyCutoverForOwner(
      db, ownerId, credential, { env: {} })).blocked, false);
  });
});

test('real MongoDB D3b2b2 import fence waits for an active encrypted draft writer', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'import-race-' + randomUUID(), repoId = 515;
    const sessionVersion = randomUUID(), noteId = randomUUID();
    const owner = { ownerId, repoId, sessionVersion };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    let insideWriter, releaseWriter;
    const entered = new Promise((resolve) => { insideWriter = resolve; });
    const hold = new Promise((resolve) => { releaseWriter = resolve; });
    const writing = withVaultOwnerDraftWrite(db, owner, async () => {
      await db.collection('vault_drafts').insertOne({
        ownerId, repoId, noteId, revision: 1,
        encrypted: { ciphertext: 'encrypted synthetic draft' },
      });
      insideWriter();
      await hold;
    });
    try {
      await entered;
      await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {
        throw new Error('import should never execute during draft write');
      }), (error) => error.status === 409);
    } finally {
      releaseWriter();
      await writing;
    }
    assert.equal(await db.collection('vault_drafts').countDocuments({ ownerId, repoId, noteId }), 1);
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultActiveDraftWriters, 0);
    assert.equal(await withVaultOwnerImportExclusive(db, owner, async () => 'approved'), 'approved');
  });
});

test('real MongoDB D3b2b2 import fence rejects cross-subject draft writes until release', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'import-exclusive-' + randomUUID(), repoId = 516;
    const sessionVersion = randomUUID(), noteId = randomUUID();
    const owner = { ownerId, repoId, sessionVersion };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    let started, done;
    const entered = new Promise((resolve) => { started = resolve; });
    const hold = new Promise((resolve) => { done = resolve; });
    const importing = withVaultOwnerImportExclusive(db, owner, async () => {
      started();
      await hold;
    });
    try {
      await entered;
      await assert.rejects(withVaultOwnerDraftWrite(db, owner, async () => {
        await db.collection('vault_drafts').insertOne({
          ownerId, repoId, noteId,
          encrypted: { ciphertext: 'must never write during import' },
        });
      }), (error) => error.status === 409);
      assert.equal(await db.collection('vault_drafts').countDocuments({ ownerId }), 0);
      const locked = await db.collection('users').findOne({ googleSub: ownerId });
      assert.equal(locked.vaultImportLock.repoId, repoId);
      assert.equal(locked.vaultActiveDraftWriters ?? 0, 0);
    } finally {
      done();
      await importing;
    }
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultImportLock,
      undefined);
  });
});

test('real MongoDB D3b2b2c2 operator lock inspection returns redacted metadata and never unlocks', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'lock-inspection-' + randomUUID();
    const repoId = 702, sessionVersion = randomUUID(), operationId = randomUUID();
    const noteId = randomUUID();
    const lock = { operationId, repoId, startedAt: new Date('2026-11-16T00:00:00.000Z') };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion,
      vault: { status: 'connected', repoId },
      vaultImportLock: lock, vaultActiveDraftWriters: 0,
    });
    await db.collection('vault_drafts').insertOne({
      ownerId, repoId, noteId, revision: 1,
      encrypted: { ciphertext: 'ENCRYPTED_PRIVATE_DRAFT_CONTENT' },
    });
    await db.collection('subjects').insertOne({
      ownerId, slug: randomUUID(), vaultActiveWriters: 1,
    });
    const beforeUser = await db.collection('users').findOne({ googleSub: ownerId });
    const beforeDraft = await db.collection('vault_drafts').findOne({ ownerId, repoId, noteId });
    let githubCalls = 0;
    const report = await inspectVaultImportLockReadOnly(db, {
      ownerId, repoId, sessionVersion, expectedOperationId: operationId,
    }, { now: new Date('2026-11-16T09:30:00.000Z'),
      githubHeadReader: async () => { githubCalls++; return 'a'.repeat(40); },
    });
    assert.equal(report.status, 'MANUAL_OPERATOR_REVIEW_REQUIRED');
    assert.equal(report.ownerSnapshotStable, true);
    assert.equal(report.pendingEncryptedDraftPresent, true);
    assert.equal(report.activeSubjectWriterPresent, true);
    assert.equal(report.githubHeadStable, true);
    assert.equal(report.automaticUnlockAuthorized, false);
    assert.equal(report.operatorUnlockAuthorized, false);
    assert.equal(githubCalls, 2);
    const serialized = JSON.stringify(report);
    for (const privateValue of [
      ownerId, String(repoId), operationId, sessionVersion, noteId,
      'ENCRYPTED_PRIVATE_DRAFT_CONTENT', 'a'.repeat(40),
    ]) assert.equal(serialized.includes(privateValue), false);
    assert.deepEqual(await db.collection('users').findOne({ googleSub: ownerId }), beforeUser);
    assert.deepEqual(await db.collection('vault_drafts').findOne({ ownerId, repoId, noteId }),
      beforeDraft);
    const staleScope = await inspectVaultImportLockReadOnly(db, {
      ownerId, repoId, sessionVersion: randomUUID(), expectedOperationId: operationId,
    }, { githubHeadReader: async () => { throw new Error('must not execute'); } });
    assert.equal(staleScope.status, 'OWNER_OR_REPOSITORY_NOT_VERIFIED');
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultImportLock.operationId,
      operationId);
  });
});

test('real MongoDB D3b2b2c2 live exclusive import lock remains intact after operator read', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'lock-inspection-live-' + randomUUID(), repoId = 703;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const owner = { ownerId, repoId, sessionVersion };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    let started, done;
    const ready = new Promise((resolve) => { started = resolve; });
    const hold = new Promise((resolve) => { done = resolve; });
    const importWork = withVaultOwnerImportExclusive(db, owner, async () => {
      started();
      await hold;
    }, { operationId });
    try {
      await ready;
      const report = await inspectVaultImportLockReadOnly(db, {
        ...owner, expectedOperationId: operationId,
      }, { githubHeadReader: async () => 'b'.repeat(40) });
      assert.equal(report.lockPresent, true);
      assert.equal(report.expectedOperationMatched, true);
      assert.equal(report.operatorUnlockAuthorized, false);
      assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultImportLock.operationId,
        operationId);
    } finally {
      done();
      await importWork;
    }
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultImportLock,
      undefined);
  });
});

test('real MongoDB D3b2b2c3 durable marker survives uncertain GitHub response', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'import-write-uncertain-' + randomUUID(), repoId = 806;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const scope = { ownerId, repoId, sessionVersion };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
    });
    await assert.rejects(withVaultOwnerImportExclusive(db, scope, async ({
      markGitHubWriteAttempt,
    }) => {
      await markGitHubWriteAttempt('Restore OgeNotes backup ' + 'a'.repeat(64), {
        expectedHead: 'a'.repeat(40), selectedIds: [randomUUID()],
      });
      throw new Error('synthetic ambiguous GitHub response');
    }, { operationId }), (err) =>
      err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    const current = await db.collection('users').findOne({ googleSub: ownerId });
    assert.equal(current.vaultImportLock.operationId, operationId);
    assert.equal(current.vaultImportLock.state, 'github-write-possible');
    assert.equal(current.vaultImportLock.commitMarker,
      'Restore OgeNotes backup ' + 'a'.repeat(64));
    await assert.rejects(withVaultOwnerImportExclusive(db, scope, async () => {}),
      (err) => err.status === 409);
    await assert.rejects(withVaultOwnerDraftWrite(db, scope, async () => {}),
      (err) => err.status === 409);
  });
});

test('real MongoDB D3b2b2c3 transaction releases ONLY exact prewrite lock and preserves drafts', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'import-prewrite-release-' + randomUUID(), repoId = 807;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const incidentId = randomUUID(), noteId = randomUUID();
    const start = new Date('2026-11-16T08:00:00.000Z');
    const identity = { ownerId, repoId, sessionVersion, expectedOperationId: operationId };
    const args = { incidentId, startedAt: start.toISOString(),
      maintenanceConfirmed: true, independentReviewConfirmed: true,
      now: new Date('2026-11-16T09:00:00.000Z') };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion,
      vault: { status: 'connected', repoId },
      vaultImportLock: { operationId, repoId, startedAt: start, state: 'acquired' },
      vaultActiveDraftWriters: 0,
    });
    const protectedBody = 'PRIVATE_ENCRYPTED_DRAFT_NEVER_CLEAR';
    await db.collection('vault_drafts').insertOne({
      ownerId, repoId, noteId, revision: 3,
      encrypted: { ciphertext: protectedBody },
    });
    const result = await releasePreWriteVaultImportLockInStaging(db, identity, args);
    assert.equal(result.status, 'PREWRITE_LOCK_RELEASED');
    assert.equal(result.lockReleased, true);
    assert.equal(result.productionRecoveryAuthorized, false);
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId })).vaultImportLock,
      undefined);
    assert.equal((await db.collection('vault_drafts').findOne({ ownerId, repoId, noteId }))
      .encrypted.ciphertext, protectedBody);
    const audit = await db.collection('vault_import_lock_recovery_audit').findOne({
      ownerId, repoId, operationId,
    });
    assert.equal(audit.incidentId, incidentId);
    assert.equal(audit.recoveryKind, 'pre-github-write-only');
    assert.equal(audit.notesChanged, false);
    assert.equal(audit.encryptedDraftsChanged, false);
    await assert.rejects(releasePreWriteVaultImportLockInStaging(db, identity, args),
      (err) => err.status === 409);
    assert.equal(await db.collection('vault_import_lock_recovery_audit').countDocuments({}), 1);
  });
});

test('real MongoDB D3b2b2c3 refuses attempted/legacy locks and cross-owner releases', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'prewrite-deny-' + randomUUID(), repoId = 808;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const startedAt = '2026-11-16T08:00:00.000Z';
    const scope = { ownerId, repoId, sessionVersion, expectedOperationId: operationId };
    const opt = { incidentId: randomUUID(), startedAt,
      maintenanceConfirmed: true, independentReviewConfirmed: true,
      now: new Date('2026-11-16T09:00:00.000Z') };
    const users = db.collection('users');
    await users.insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
      vaultImportLock: { operationId, repoId, startedAt: new Date(startedAt),
        state: 'github-write-possible',
        commitMarker: 'Restore OgeNotes backup ' + 'b'.repeat(64),
        attemptedAt: new Date('2026-11-16T08:01:00.000Z') },
    });
    const denied = [
      scope, { ...scope, sessionVersion: randomUUID() },
      { ...scope, repoId: repoId + 1 },
      { ...scope, expectedOperationId: randomUUID() },
    ];
    for (const identity of denied)
      await assert.rejects(releasePreWriteVaultImportLockInStaging(db, identity, opt),
        (err) => err.status === 409);
    await users.updateOne({ googleSub: ownerId },
      { $unset: { 'vaultImportLock.state': '', 'vaultImportLock.commitMarker': '',
        'vaultImportLock.attemptedAt': '' } });
    await assert.rejects(releasePreWriteVaultImportLockInStaging(db, scope, opt),
      (err) => err.status === 409);
    assert.equal(await db.collection('vault_import_lock_recovery_audit').countDocuments({}), 0);
    assert.equal((await users.findOne({ googleSub: ownerId })).vaultImportLock.operationId, operationId);
  });
});

test('real MongoDB D3b2b2c3 active subject writer rejects manual prewrite release', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'prewrite-subject-' + randomUUID(), repoId = 809;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const startedAt = '2026-11-16T08:00:00.000Z';
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
      vaultImportLock: { operationId, repoId,
        startedAt: new Date(startedAt), state: 'acquired' },
    });
    await db.collection('subjects').insertOne({
      ownerId, slug: randomUUID(), vaultActiveWriters: 1,
    });
    await assert.rejects(releasePreWriteVaultImportLockInStaging(db,
      { ownerId, repoId, sessionVersion, expectedOperationId: operationId }, {
        incidentId: randomUUID(), startedAt,
        maintenanceConfirmed: true, independentReviewConfirmed: true,
        now: new Date('2026-11-16T09:00:00.000Z'),
      }), (err) => err.status === 409);
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId }))
      .vaultImportLock.state, 'acquired');
  });
});

test('real MongoDB D3b2b2c3 audit insertion failure rolls back exact lock release', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'prewrite-audit-failure-' + randomUUID(), repoId = 810;
    const sessionVersion = randomUUID(), operationId = randomUUID();
    const startedAt = '2026-11-16T08:00:00.000Z';
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault: { status: 'connected', repoId },
      vaultImportLock: { operationId, repoId,
        startedAt: new Date(startedAt), state: 'acquired' },
    });
    const broken = { client: db.client, collection(name) {
      if (name !== 'vault_import_lock_recovery_audit') return db.collection(name);
      return { async insertOne() { throw new Error('synthetic-audit-insert-failure'); } };
    } };
    await assert.rejects(releasePreWriteVaultImportLockInStaging(broken,
      { ownerId, repoId, sessionVersion, expectedOperationId: operationId }, {
        incidentId: randomUUID(), startedAt,
        maintenanceConfirmed: true, independentReviewConfirmed: true,
        now: new Date('2026-11-16T09:00:00.000Z'),
      }), /synthetic-audit-insert-failure/);
    assert.equal((await db.collection('users').findOne({ googleSub: ownerId }))
      .vaultImportLock.state, 'acquired');
    assert.equal(await db.collection('vault_import_lock_recovery_audit').countDocuments({}), 0);
  });
});

test('real MongoDB M48 evidence inspection reads only signed metadata and preserves quarantined drafts', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const { createHash } = await import('node:crypto');
    const h = (x) => createHash('sha1').update(x).digest('hex');
    const ownerId = 'import-evidence-' + randomUUID();
    const sessionVersion = randomUUID(), repoId = 866, operationId = randomUUID();
    const noteId = randomUUID();
    const baseHead = h('evidence-base'), nextHead = h('evidence-import');
    const baseTree = h('evidence-base-tree'), nextTree = h('evidence-import-tree');
    const commitMarker = 'Restore OgeNotes backup ' + 'd'.repeat(64);
    const vault = { status: 'connected', repoId, installationId: 56,
      githubAccountId: '88', githubLogin: 'synthetic-owner', repoName: 'ogenotes-vault' };
    const importedLock = {
      operationId, repoId, startedAt: new Date('2026-11-16T08:00:00.000Z'),
      attemptedAt: new Date('2026-11-16T08:01:00.000Z'),
      state: 'github-write-possible', approvedHead: baseHead,
      commitMarker, selectedIds: [noteId],
    };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault,
      vaultImportLock: importedLock, vaultActiveDraftWriters: 0,
    });
    await db.collection('vault_drafts').insertOne({
      ownerId, repoId, noteId: randomUUID(), revision: 2,
      encrypted: { ciphertext: 'ONLY_ENCRYPTED_DRAFT' },
    });
    const before = await db.collection('users').findOne({ googleSub: ownerId });
    const draftBefore = await db.collection('vault_drafts').findOne({ ownerId });
    const originalBlob = { path: 'README.md', type: 'blob',
      mode: '100644', sha: h('readme') };
    const importedBlob = { path: 'notes/' + noteId + '.json',
      type: 'blob', mode: '100644', sha: h('imported-file') };
    const calls = [];
    const client = { vault: { ...vault }, branch: 'main',
      async call(path, options = {}) {
        calls.push({ path, method: options.method || 'GET' });
        if (path === '/git/ref/heads/main') return { object: { sha: nextHead } };
        if (path === '/git/commits/' + nextHead) return {
          tree: { sha: nextTree }, parents: [{ sha: baseHead }],
          message: commitMarker,
        };
        if (path === '/git/commits/' + baseHead) return { tree: { sha: baseTree } };
        if (path === '/git/trees/' + baseTree + '?recursive=1')
          return { truncated: false, tree: [originalBlob] };
        if (path === '/git/trees/' + nextTree + '?recursive=1')
          return { truncated: false, tree: [originalBlob, importedBlob] };
        throw new Error('Unexpected provider GET');
      },
    };
    const result = await inspectVaultImportAttemptEvidenceReadOnly(db, {
      ownerId, sessionVersion, repoId, expectedOperationId: operationId,
    }, client);
    assert.equal(result.status, 'MATCHING_IMPORT_COMMIT_METADATA_ONLY');
    assert.equal(result.matchingCommitMetadataFound, true);
    assert.equal(result.importedContentVerified, false);
    assert.equal(result.operatorUnlockAuthorized, false);
    assert.ok(calls.every((x) => x.method === 'GET'));
    assert.deepEqual(await db.collection('users').findOne({ googleSub: ownerId }), before);
    assert.deepEqual(await db.collection('vault_drafts').findOne({ ownerId }), draftBefore);
    const serialized = JSON.stringify(result);
    for (const sensitive of [ownerId, operationId, noteId, commitMarker,
      baseHead, nextHead, 'ONLY_ENCRYPTED_DRAFT'])
      assert.equal(serialized.includes(sensitive), false);
    const differentOwner = await inspectVaultImportAttemptEvidenceReadOnly(db, {
      ownerId, sessionVersion: randomUUID(), repoId, expectedOperationId: operationId,
    }, client);
    assert.equal(differentOwner.status, 'OWNER_OR_REPOSITORY_NOT_VERIFIED');
  });
});

test('real MongoDB M49 verifies signed import lock and owner subjects without touching drafts', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const ownerId = 'archive-proof-' + randomUUID(), sessionVersion = randomUUID();
    const repoId = 904, subjectId = randomUUID(), noteId = randomUUID();
    const operationId = randomUUID(), sha = 'b'.repeat(40);
    const vault = { status: 'connected', repoId, installationId: 54,
      githubAccountId: '77', githubLogin: 'synthetic-owner', repoName: 'ogenotes-vault' };
    const note = validatedNote({ subjectId, heading: 'PRIVATE HEADING', answer: 'PRIVATE ANSWER' },
      { id: noteId, now: '2026-10-09T00:00:00.000Z' });
    const request = {
      archive: {
        format: 'oge-vault-notes-backup', version: 1,
        scope: 'current-github-notes-only', snapshot: 'a'.repeat(40),
        totalNotes: 1,
        coverage: {
          notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
          quickNotes: 'not-included', airNotes: 'not-included',
          encryptedDrafts: 'not-included', learningProgress: 'not-included',
        },
        notes: [{ ...note, sha: 'c'.repeat(40) }],
      },
      expectedTargetHead: sha, selectedIds: [noteId],
      confirmation: 'IMPORT_SELECTED_NEW_NOTES',
    };
    const commitMarker = approvedVaultImportCommitMessage(
      validateVaultNotesImportApproval(request));
    const lock = {
      operationId, repoId, state: 'github-write-possible',
      approvedHead: sha, commitMarker, selectedIds: [noteId],
      startedAt: new Date('2026-11-16T07:00:00.000Z'),
      attemptedAt: new Date('2026-11-16T07:01:00.000Z'),
    };
    await db.collection('users').insertOne({
      googleSub: ownerId, sessionVersion, vault, vaultImportLock: lock,
    });
    await db.collection('subjects').insertOne({ ownerId, slug: subjectId });
    const draftNoteId = randomUUID(), ciphertext = 'MUST_NOT_BE_EXPOSED';
    await db.collection('vault_drafts').insertOne({
      ownerId, repoId, noteId: draftNoteId,
      encrypted: { ciphertext }, revision: 1,
    });
    const userBefore = await db.collection('users').findOne({ googleSub: ownerId });
    const draftBefore = await db.collection('vault_drafts').findOne({ ownerId });
    const client = { vault: { ...vault }, branch: 'main',
      async call() { throw Error('Injected proven archive reconciler should not call provider'); } };
    const identity = { ownerId, repoId, sessionVersion, expectedOperationId: operationId };
    const evidence = await inspectVaultImportArchiveContentReadOnly(
      db, identity, client, request, { archiveReconciler: async (_c, _r, opts) => {
        assert.equal(await opts.subjectVerifier([subjectId]), true);
        assert.equal(await opts.ownerVerifier(), true);
        return { confirmed: true, importedCount: 1, commitsAfterImport: 0,
          currentNotesUnchanged: 1, currentNotesChanged: 0 };
      } });
    assert.equal(evidence.status, 'ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY');
    assert.equal(evidence.importedContentVerified, true);
    assert.equal(evidence.operatorUnlockAuthorized, false);
    assert.deepEqual(await db.collection('users').findOne({ googleSub: ownerId }), userBefore);
    assert.deepEqual(await db.collection('vault_drafts').findOne({ ownerId }), draftBefore);
    assert.equal(evidence.matchingSelectedDraftPresent, false);
    const serialized = JSON.stringify(evidence);
    for (const secret of [ownerId, operationId, sessionVersion, sha,
      commitMarker, 'PRIVATE ANSWER', ciphertext, noteId])
      assert.equal(serialized.includes(secret), false);
    const wrongSession = await inspectVaultImportArchiveContentReadOnly(
      db, { ...identity, sessionVersion: randomUUID() }, client, request, {
        archiveReconciler: async () => { throw Error('MUST NOT RUN'); },
      });
    assert.equal(wrongSession.status, 'OWNER_OR_REPOSITORY_NOT_VERIFIED');
    const wrongLock = await inspectVaultImportArchiveContentReadOnly(
      db, { ...identity, expectedOperationId: randomUUID() }, client, request, {
        archiveReconciler: async () => { throw Error('MUST NOT RUN'); },
      });
    assert.equal(wrongLock.status, 'ARCHIVE_APPROVAL_OR_IMPORT_LOCK_MISMATCH');
  });
});
