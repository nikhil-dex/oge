import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, rateLimitResponse } from '../lib/rate-limit.js';

function fakeDb() {
  const records = new Map();
  return {
    collection(name) {
      assert.equal(name, 'rateLimitBuckets');
      return {
        async findOneAndUpdate(filter, update) {
          const key = filter._id;
          const record = records.get(key);
          if (record && record.count >= filter.count.$lt) {
            const error = new Error('duplicate key');
            error.code = 11000;
            throw error;
          }
          const count = (record?.count || 0) + update.$inc.count;
          records.set(key, { count, expiresAt: update.$setOnInsert.expiresAt });
          return { count };
        },
      };
    },
  };
}

test('rate limiter blocks requests after the allowed budget and resets next window', async () => {
  const db = fakeDb();
  const options = { scope: 'test', identifier: 'user-1', limit: 2, windowMs: 60000 };
  assert.deepEqual(await checkRateLimit(db, { ...options, now: 1000 }), { allowed: true, remaining: 1, retryAfter: 0 });
  assert.deepEqual(await checkRateLimit(db, { ...options, now: 2000 }), { allowed: true, remaining: 0, retryAfter: 0 });
  const blocked = await checkRateLimit(db, { ...options, now: 3000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 57);
  assert.equal((await rateLimitResponse(blocked).json()).error, 'Too many requests. Try again later.');
  assert.equal((await checkRateLimit(db, { ...options, now: 61000 })).allowed, true);
});

test('rate limiter separates users and operations', async () => {
  const db = fakeDb();
  const base = { limit: 1, windowMs: 60000, now: 1000 };
  assert.equal((await checkRateLimit(db, { ...base, scope: 'cleanup', identifier: 'alice' })).allowed, true);
  assert.equal((await checkRateLimit(db, { ...base, scope: 'cleanup', identifier: 'bob' })).allowed, true);
  assert.equal((await checkRateLimit(db, { ...base, scope: 'export', identifier: 'alice' })).allowed, true);
});

test('rate limiter fails closed when backing storage fails', async () => {
  const db = { collection() { return { findOneAndUpdate() { throw new Error('database unavailable'); } }; } };
  await assert.rejects(checkRateLimit(db, { scope: 'test', identifier: 'alice', limit: 1, windowMs: 60000 }), /database unavailable/);
  await assert.rejects(checkRateLimit(fakeDb(), { scope: 'bad scope', identifier: 'x', limit: 1, windowMs: 60000 }), TypeError);
});
