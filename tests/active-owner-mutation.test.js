import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('owner-scoped editing and deletion routes use account transactions and session-bound operations', async () => {
  const checks = [
    { file: '../app/api/notes/route.js', collection: 'notes', methods: ['PUT', 'PATCH', 'DELETE'] },
    { file: '../app/api/quick-notes/route.js', collection: 'quickNotes', methods: ['PUT', 'DELETE'] },
    { file: '../app/api/personal-quick-notes/route.js', collection: 'personalQuickNotes', methods: ['PUT', 'DELETE'] },
    { file: '../app/api/saved-links/route.js', collection: 'savedLinks', methods: ['PUT', 'PATCH', 'DELETE'] },
  ];
  for (const { file, methods } of checks) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const method of methods) {
      const start = src.indexOf('export async function ' + method + '(');
      assert.ok(start >= 0, file + ' missing ' + method);
      const next = src.indexOf('export async function ', start + 1);
      const handler = src.slice(start, next < 0 ? undefined : next);
      assert.match(handler, /withActiveOwnerMutation\(ctx\.db, ctx\.ownerId, async \(session\) =>/,
        file + ' ' + method + ' must guard its owning account');
      assert.ok(handler.includes('{ session }') || handler.includes('session }'),
        file + ' ' + method + ' must use the transaction session for mutations');
    }
  }
  const links = await readFile(new URL('../app/api/saved-links/route.js', import.meta.url), 'utf8');
  assert.match(links, /bulkWrite\([\s\S]*?\{ session \}/);
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

test('core mutations pass authenticated session versions and extension uses verified token', async () => {
  for (const file of [
    '../app/api/notes/route.js', '../app/api/quick-notes/route.js',
    '../app/api/personal-quick-notes/route.js', '../app/api/saved-links/route.js',
  ]) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /sessionVersion: session\.user\.sessionVersion/);
    assert.match(src, /\}, \{ sessionVersion: ctx\.sessionVersion \}\)/);
  }
  for (const file of ['../app/api/subjects/route.js', '../app/api/revision/route.js', '../app/api/revision-history/route.js']) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /sessionVersion: session\?\.user\?\.sessionVersion/);
    assert.match(src, /\}, \{ sessionVersion: sessionVersion \}\)/);
  }
  const extension = await readFile(new URL('../app/api/extension/save-link/route.js', import.meta.url), 'utf8');
  assert.match(extension, /\}, \{ extensionTokenHash: hashExtensionToken\(token\) \}\)/);
});
