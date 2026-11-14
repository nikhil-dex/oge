import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerMutationFilter, withActiveOwnerMutation } from '../lib/active-owner-mutation.js';

function mockDb({ matchedCount = 1, workFails = false } = {}) {
  const steps = [];
  const session = {
    async withTransaction(work, options) {
      steps.push('begin');
      assert.equal(options.readConcern.level, 'snapshot');
      assert.equal(options.writeConcern.w, 'majority');
      const result = await work();
      steps.push('commit');
      return result;
    },
    async endSession() { steps.push('closed'); },
  };
  const db = {
    client: { startSession() { steps.push('started'); return session; } },
    collection(name) {
      assert.equal(name, 'users');
      return { async updateOne(filter, update, options) {
        steps.push('check-account');
        assert.deepEqual(filter, { googleSub: 'account-a', sessionVersion: 'e8f311e7-cf6e-4d67-a8f5-8218c2fc74d6' });
        assert.ok(update.$set.updatedAt instanceof Date);
        assert.equal(options.session, session);
        return { matchedCount };
      } };
    },
  };
  const perform = () => withActiveOwnerMutation(db, 'account-a', async (transaction) => {
    steps.push('write');
    assert.equal(transaction, session);
    if (workFails) throw new Error('simulated downstream failure');
    return 'ok';
  }, { sessionVersion: 'e8f311e7-cf6e-4d67-a8f5-8218c2fc74d6' });
  return { steps, perform };
}

test('owner mutation writes user account and record together in a transaction', async () => {
  const { steps, perform } = mockDb();
  assert.equal(await perform(), 'ok');
  assert.deepEqual(steps, ['started', 'begin', 'check-account', 'write', 'commit', 'closed']);
});

test('owner mutation refuses missing/deleted accounts without orphan writes', async () => {
  const { steps, perform } = mockDb({ matchedCount: 0 });
  await assert.rejects(perform(), /Account session no longer exists/);
  assert.ok(!steps.includes('write'));
  assert.ok(!steps.includes('commit'));
  assert.ok(steps.includes('closed'));
});

test('downstream failures abort instead of reporting committed records', async () => {
  const { steps, perform } = mockDb({ workFails: true });
  await assert.rejects(perform(), /simulated downstream failure/);
  assert.ok(!steps.includes('commit'));
  assert.ok(steps.includes('closed'));
});

test('rejects missing credentials and stale account session versions', () => {
  assert.throws(() => ownerMutationFilter('account-a', {}), /Signed session version/);
  assert.throws(() => ownerMutationFilter('account-a', { sessionVersion: 'invalid' }), /Signed session version/);
  assert.deepEqual(ownerMutationFilter('account-a', { sessionVersion: 0 }), {
    googleSub: 'account-a', $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }],
  });
  assert.deepEqual(ownerMutationFilter('account-a', { sessionVersion: 'e8f311e7-cf6e-4d67-a8f5-8218c2fc74d6' }), {
    googleSub: 'account-a', sessionVersion: 'e8f311e7-cf6e-4d67-a8f5-8218c2fc74d6',
  });
  const extension = ownerMutationFilter('account-a', { extensionTokenHash: 'a'.repeat(64) });
  assert.equal(extension.googleSub, 'account-a');
  assert.equal(extension.extensionTokenHash, 'a'.repeat(64));
  assert.ok(extension.extensionTokenExpiresAt.$gt instanceof Date);
  assert.throws(() => ownerMutationFilter('account-a', { extensionTokenHash: 'bad' }), /Signed session version/);
});

