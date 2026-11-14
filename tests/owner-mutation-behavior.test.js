import test from 'node:test';
import assert from 'node:assert/strict';
import { withActiveOwnerMutation } from '../lib/active-owner-mutation.js';

/**
 * Small stateful MongoDB transaction double. Unlike source-regex assertions,
 * these tests run production functions and assert committed state, isolation,
 * and abort behavior when a user changes incarnation.
 */
function databaseFor(user) {
  const state = { account: { ...user }, records: [], committed: 0, aborted: 0, closed: 0 };
  const matches = (filter) => {
    const account = state.account;
    if (!account || account.googleSub !== filter.googleSub) return false;
    if (filter.sessionVersion !== undefined && account.sessionVersion !== filter.sessionVersion) return false;
    if (filter.$or && !filter.$or.some((option) =>
      option.sessionVersion === account.sessionVersion ||
      (option.sessionVersion?.$exists === false && !Object.hasOwn(account, 'sessionVersion')))) return false;
    if (filter.extensionTokenHash !== undefined &&
      filter.extensionTokenHash !== account.extensionTokenHash) return false;
    if (filter.extensionTokenExpiresAt?.$gt &&
      !(account.extensionTokenExpiresAt > filter.extensionTokenExpiresAt.$gt)) return false;
    return true;
  };
  let working = null;
  const session = {
    async withTransaction(work) {
      working = { account: state.account ? { ...state.account } : null, records: [...state.records] };
      try {
        const result = await work();
        state.account = working.account;
        state.records = working.records;
        state.committed += 1;
        return result;
      } catch (error) {
        state.aborted += 1;
        throw error;
      } finally {
        working = null;
      }
    },
    async endSession() { state.closed += 1; },
  };
  const db = {
    client: { startSession() { return session; } },
    collection(name) {
      if (name === 'users') return {
        async updateOne(filter, update, options) {
          assert.equal(options.session, session);
          assert.ok(working, 'account update must be transactional');
          if (!matches(filter)) return { matchedCount: 0 };
          working.account = { ...working.account, ...update.$set };
          return { matchedCount: 1 };
        },
      };
      if (name === 'notes') return {
        async insertOne(note, options) {
          assert.equal(options.session, session);
          assert.ok(working, 'note insertion must be transactional');
          working.records.push(note);
          return { insertedId: note._id };
        },
      };
      throw Error('Unexpected collection');
    },
  };
  return { db, state };
}

const epochA = '11c9dfe2-3052-4c87-b30f-1984cad13aac';
const epochB = '64580aac-8247-4c7b-af22-ec6d0ea79fa3';
const insertNote = (db, version, id) => withActiveOwnerMutation(db, 'google-user', async (session) => {
  await db.collection('notes').insertOne({ _id: id, ownerId: 'google-user' }, { session });
  return id;
}, { sessionVersion: version });

test('matching signed session commits a record and closes transaction', async () => {
  const { db, state } = databaseFor({ googleSub: 'google-user', sessionVersion: epochA });
  assert.equal(await insertNote(db, epochA, 'first-note'), 'first-note');
  assert.deepEqual(state.records.map((r) => r._id), ['first-note']);
  assert.equal(state.committed, 1);
  assert.equal(state.aborted, 0);
  assert.equal(state.closed, 1);
});

test('stale session cannot write into a deleted and re-created account', async () => {
  const { db, state } = databaseFor({ googleSub: 'google-user', sessionVersion: epochB });
  await assert.rejects(insertNote(db, epochA, 'old-note'), /Account session no longer exists/);
  assert.deepEqual(state.records, []);
  assert.equal(state.account.sessionVersion, epochB);
  assert.equal(state.committed, 0);
  assert.equal(state.aborted, 1);
  assert.equal(state.closed, 1);
  assert.equal(await insertNote(db, epochB, 'new-note'), 'new-note');
  assert.deepEqual(state.records.map((r) => r._id), ['new-note']);
});

test('a failed downstream write aborts both record and account touch', async () => {
  const { db, state } = databaseFor({ googleSub: 'google-user', sessionVersion: epochA });
  await assert.rejects(withActiveOwnerMutation(db, 'google-user', async (session) => {
    await db.collection('notes').insertOne({ _id: 'partial-note' }, { session });
    throw new Error('injected failure');
  }, { sessionVersion: epochA }), /injected failure/);
  assert.deepEqual(state.records, []);
  assert.equal(state.account.updatedAt, undefined);
  assert.equal(state.committed, 0);
  assert.equal(state.aborted, 1);
});

test('legacy signed version zero only matches a legacy account', async () => {
  const legacy = databaseFor({ googleSub: 'google-user' });
  assert.equal(await insertNote(legacy.db, 0, 'legacy-note'), 'legacy-note');
  const recreated = databaseFor({ googleSub: 'google-user', sessionVersion: epochB });
  await assert.rejects(insertNote(recreated.db, 0, 'stale-legacy'), /Account session no longer exists/);
  assert.deepEqual(recreated.state.records, []);
});

test('extension token can be revoked or expired before a transaction begins', async () => {
  const token = 'a'.repeat(64);
  const valid = databaseFor({
    googleSub: 'google-user',
    sessionVersion: epochB,
    extensionTokenHash: token,
    extensionTokenExpiresAt: new Date(Date.now() + 86400000),
  });
  const create = (db) => withActiveOwnerMutation(db, 'google-user',
    async (session) => db.collection('notes').insertOne({ _id: 'extension-note' }, { session }),
    { extensionTokenHash: token });
  await create(valid.db);
  assert.equal(valid.state.records.length, 1);
  valid.state.account.extensionTokenHash = null;
  await assert.rejects(create(valid.db), /Account session no longer exists/);
  assert.equal(valid.state.records.length, 1);
  valid.state.account.extensionTokenHash = token;
  valid.state.account.extensionTokenExpiresAt = new Date(Date.now() - 86400000);
  await assert.rejects(create(valid.db), /Account session no longer exists/);
  assert.equal(valid.state.records.length, 1);
});
