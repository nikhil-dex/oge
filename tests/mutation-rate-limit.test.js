import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkOwnerMutationLimit } from '../lib/rate-limit.js';

const endpoints = [
  ['notes', ['POST', 'PUT', 'PATCH', 'DELETE']],
  ['subjects', ['POST', 'DELETE']],
  ['quick-notes', ['POST', 'PUT', 'DELETE']],
  ['personal-quick-notes', ['POST', 'PUT', 'DELETE']],
  ['saved-links', ['POST', 'PUT', 'PATCH', 'DELETE']],
];

for (const [path, methods] of endpoints) {
  test(path + ' mutations all use shared owner-scoped protection', async () => {
    const source = await readFile(new URL('../app/api/' + path + '/route.js', import.meta.url), 'utf8');
    for (const method of methods) {
      const start = source.indexOf('export async function ' + method + '(');
      assert.ok(start >= 0, method + ' handler missing');
      const next = source.indexOf('\nexport async function ', start + 1);
      const handler = source.slice(start, next < 0 ? undefined : next);
      assert.match(handler, /await checkOwnerMutationLimit\(/, method + ' must check shared limiter');
      assert.match(handler, /if \(!throttle.allowed\) return rateLimitResponse\(throttle\)/);
    }
  });
}

test('mutation protection only accepts known owner-scoped resources', async () => {
  const db = { collection() { throw Error('Should not access database'); } };
  assert.throws(() => checkOwnerMutationLimit(db, 'alice', 'unexpected'), TypeError);
  assert.throws(() => checkOwnerMutationLimit(db, 'alice', '__proto__'), TypeError);
});

test('mutation protection uses a bounded shared budget', async () => {
  let update;
  const db = { collection(name) {
    assert.equal(name, 'rateLimitBuckets');
    return { async findOneAndUpdate(_filter, value) { update = value; return { count: 1 }; } };
  } };
  const result = await checkOwnerMutationLimit(db, 'alice', 'notes');
  assert.deepEqual(result, { allowed: true, remaining: 119, retryAfter: 0 });
  assert.equal(update.$inc.count, 1);
});
