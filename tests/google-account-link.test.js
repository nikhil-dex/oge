import test from 'node:test';
import assert from 'node:assert/strict';
import { beginGoogleConnection, finishGoogleConnection, resolveOAuthOwner, googleConnectionRequired } from '../lib/google-account-link.js';

function fixture(source, google = null) {
  const users = [{ _id: 'source', ...source }, ...(google ? [{ _id: 'google', ...google }] : [])];
  const intents = [];
  const jar = {
    value: null,
    set(name, value, options) {
      assert.equal(name, 'oge-google-link');
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, 'lax');
      this.value = value;
    },
    get() { return this.value ? { value: this.value } : null; },
    delete() { this.value = null; },
  };
  const matches = (u, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((part) => matches(u, part));
    if (value && typeof value === 'object' && '$not' in value) return !value.$not.test(u[key]);
    if (value && typeof value === 'object' && '$ne' in value) return u[key] !== value.$ne;
    if (value && typeof value === 'object' && '$exists' in value) return (u[key] !== undefined) === value.$exists;
    return u[key] === value;
  });
  const find = (filter) => users.find((u) => matches(u, filter));
  const db = {
    client: { startSession: () => ({ withTransaction: (callback) => callback(), endSession: async () => {} }) },
    collection(name) {
      if (name === 'oauthLinkIntents') return {
        async insertOne(record) { intents.push(record); },
        async countDocuments(filter) { return intents.filter(i => i.ownerId === filter.ownerId).length; },
        async findOneAndDelete(filter) {
          const index = intents.findIndex(i => i.secretHash === filter.secretHash && i.expiresAt > filter.expiresAt.$gt);
          return index < 0 ? null : intents.splice(index, 1)[0];
        },
      };
      if (name === 'users') return {
        findOne: async (filter) => find(filter) || null,
        async updateOne(filter, update) {
          const match = find(filter);
          if (!match) return { matchedCount: 0 };
          Object.assign(match, update.$set);
          for (const key of Object.keys(update.$unset || {})) delete match[key];
          return { matchedCount: 1 };
        },
      };
      return { async findOne() { return null; } };
    },
  };
  return { db, jar, users, intents };
}

test('GitHub matching Google email needs explicit connection and does not auto-link', async () => {
  const { db } = fixture(
    { googleSub: 'github:123', email: 'student@example.com', sessionVersion: '12345678-1234-1234-1234-123456789012' },
    { googleSub: 'google-sub', email: 'student@example.com' },
  );
  assert.equal(await googleConnectionRequired(db, 'github:123'), true);
  assert.equal(await googleConnectionRequired(db, 'google-sub'), false);
  assert.equal(await resolveOAuthOwner(db, 'github', '123'), 'github:123');
  assert.equal(await resolveOAuthOwner(db, 'google', 'google-sub'), 'google-sub');
});

test('verified Google OAuth links an empty GitHub account to existing matching Google account', async () => {
  const version = '12345678-1234-1234-1234-123456789012';
  const { db, jar, users } = fixture(
    { googleSub: 'github:123', email: 'student@example.com', sessionVersion: version, newsInterests: [], extensionTokenHash: 'old-token-hash' },
    { googleSub: 'google-sub', email: 'student@example.com' },
  );
  await beginGoogleConnection('github:123', version, { database: async () => db, cookieJar: async () => jar });
  const done = await finishGoogleConnection('google-sub', 'student@example.com', {
    database: async () => db, cookieJar: async () => jar,
  });
  assert.equal(done.ok, true);
  assert.equal(jar.value, null);
  assert.equal(users[0].linkedGoogleSub, 'google-sub');
  assert.equal(users[1].linkedGithubOwnerId, 'github:123');
  assert.equal(users[0].extensionTokenHash, undefined, 'orphaned extension token must be revoked');
  assert.notEqual(users[0].sessionVersion, version);
  assert.equal(await resolveOAuthOwner(db, 'github', '123'), 'google-sub');
  assert.equal(await googleConnectionRequired(db, 'github:123'), false);
});

test('mismatched verified Google email cannot link and consumes one-time challenge', async () => {
  const version = '12345678-1234-1234-1234-123456789012';
  const { db, jar, users } = fixture(
    { googleSub: 'github:123', email: 'student@example.com', sessionVersion: version },
    { googleSub: 'google-sub', email: 'different@example.com' },
  );
  await beginGoogleConnection('github:123', version, { database: async () => db, cookieJar: async () => jar });
  const result = await finishGoogleConnection('google-sub', 'different@example.com', {
    database: async () => db, cookieJar: async () => jar,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.equal(users[0].linkedGoogleSub, undefined);
  assert.equal(users[1].linkedGithubOwnerId, undefined);
});

test('already populated GitHub notes are preserved rather than silently merged', async () => {
  const version = '12345678-1234-1234-1234-123456789012';
  const { db, jar, users } = fixture(
    { googleSub: 'github:123', email: 'student@example.com', sessionVersion: version, username: 'student' },
    { googleSub: 'google-sub', email: 'student@example.com' },
  );
  await beginGoogleConnection('github:123', version, { database: async () => db, cookieJar: async () => jar });
  const result = await finishGoogleConnection('google-sub', 'student@example.com', {
    database: async () => db, cookieJar: async () => jar,
  });
  assert.equal(result.reason, 'migration-required');
  assert.equal(users[0].linkedGoogleSub, undefined);
  assert.equal(users[1].linkedGithubOwnerId, undefined);
});

test('no Google account requires an optional connection, even for GitHub signup', async () => {
  const { db } = fixture({ googleSub: 'github:123', email: 'student@example.com' });
  assert.equal(await googleConnectionRequired(db, 'github:123'), false);
});
