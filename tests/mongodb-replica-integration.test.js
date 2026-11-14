import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { withAtomicBackupImport } from '../lib/atomic-backup-import.js';
import { withActiveOwnerMutation } from '../lib/active-owner-mutation.js';
import { deleteSubjectAtomically } from '../lib/atomic-subject-deletion.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = { skip: !uri ? 'Set OGE_TEST_MONGODB_URI for isolated replica-set integration tests' : false };
const epochA = 'a0e31394-d318-4b1e-a01b-e9f74636db6a';
const epochB = 'b8e48f26-640c-4dfa-89d8-d6d68c302809';

async function isolatedDatabase(run) {
  if (!uri || !/^(mongodb|mongodb\+srv):\/\//.test(uri)) throw new Error('Test MongoDB replica set URI required');
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
