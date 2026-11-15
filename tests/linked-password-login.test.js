import test from 'node:test';
import assert from 'node:assert/strict';
import { hashAccountPassword } from '../lib/password-auth.js';
import { authenticateLinkedPassword } from '../lib/linked-password-login.js';

function fakeDatabase(users) {
  const state = { attempts: 0 };
  return {
    state,
    db: {
      collection(name) {
        if (name === 'rateLimitBuckets') {
          return {
            async findOneAndUpdate() {
              state.attempts++;
              if (state.attempts > 8) {
                const error = new Error('Duplicate key');
                error.code = 11000;
                throw error;
              }
              return { count: state.attempts };
            },
          };
        }
        if (name === 'users') {
          return {
            find(filter) {
              return {
                limit(max) {
                  return { async toArray() { return users.filter(u => u.email === filter.email).slice(0, max); } };
                },
              };
            },
          };
        }
        throw new Error('Unexpected collection');
      },
    },
  };
}

test('password login maps to existing stable Google subject and version', async () => {
  const passwordHash = await hashAccountPassword('correct horse battery staple');
  const { db } = fakeDatabase([{
    googleSub: 'google-sub-123', email: 'student@gmail.com', sessionVersion: 0,
    name: 'Student', passwordHash,
  }]);
  const result = await authenticateLinkedPassword(' STUDENT@gmail.com ', 'correct horse battery staple', { database: async () => db });
  assert.equal(result.id, 'google-sub-123');
  assert.equal(result.sessionVersion, 0);
  assert.equal(result.passwordHash, undefined);
});
test('password login does not create accounts or select ambiguous email owners', async () => {
  const passwordHash = await hashAccountPassword('correct horse battery staple');
  const a = { googleSub: 'one', email: 'student@gmail.com', sessionVersion: 0, passwordHash };
  const b = { googleSub: 'two', email: 'student@gmail.com', sessionVersion: 0, passwordHash };
  for (const users of [[], [a, b]]) {
    const { db } = fakeDatabase(users);
    assert.equal(await authenticateLinkedPassword('student@gmail.com', 'correct horse battery staple', { database: async () => db }), null);
  }
});
test('wrong password and rate-limit failures never issue sessions', async () => {
  const passwordHash = await hashAccountPassword('correct horse battery staple');
  const { db, state } = fakeDatabase([{ googleSub: 'one', email: 'student@gmail.com', sessionVersion: 0, passwordHash }]);
  for (let i = 0; i < 9; i++) {
    assert.equal(await authenticateLinkedPassword('student@gmail.com', 'not-the-password', { database: async () => db }), null);
  }
  assert.equal(state.attempts, 9);
});
