import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { withAtomicBackupImport } from '../lib/atomic-backup-import.js';
import { withActiveOwnerMutation } from '../lib/active-owner-mutation.js';
import { deleteSubjectAtomically } from '../lib/atomic-subject-deletion.js';
import { deleteAccountDataAtomically, ACCOUNT_OWNER_COLLECTIONS } from '../lib/account-deletion-transaction.js';

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
