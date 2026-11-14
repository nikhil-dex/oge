import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withActiveOwnerMutation } from '../lib/active-owner-mutation.js';

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
        assert.deepEqual(filter, { googleSub: 'account-a' });
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
  });
  return { steps, perform };
}

test('owner mutation writes user account and record together in a transaction', async () => {
  const { steps, perform } = mockDb();
  assert.equal(await perform(), 'ok');
  assert.deepEqual(steps, ['started', 'begin', 'check-account', 'write', 'commit', 'closed']);
});

test('owner mutation refuses missing/deleted accounts without orphan writes', async () => {
  const { steps, perform } = mockDb({ matchedCount: 0 });
  await assert.rejects(perform(), /Account no longer exists/);
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

test('owner-scoped creation routes use account-guard transactions for inserts', async () => {
  const routes = [
    ['../app/api/notes/route.js', "ctx.ownerId"],
    ['../app/api/quick-notes/route.js', "ctx.ownerId"],
    ['../app/api/personal-quick-notes/route.js', "ctx.ownerId"],
    ['../app/api/saved-links/route.js', "ctx.ownerId"],
    ['../app/api/subjects/route.js', "ownerId"],
    ['../app/api/extension/save-link/route.js', "user.googleSub"],
  ];
  for (const [url, owner] of routes) {
    const source = await readFile(new URL(url, import.meta.url), 'utf8');
    assert.ok(source.includes('withActiveOwnerMutation('), url + ' must guard owner existence');
    assert.ok(source.includes('withActiveOwnerMutation(' + (owner === 'ownerId' ? 'db' : owner === 'user.googleSub' ? 'db' : 'ctx.db') + ', ' + owner),
      url + ' must scope the owner guard');
    assert.match(source, /insertOne\([^;]*\{ session \}\)/s, url + ' must insert within transaction');
  }
});
