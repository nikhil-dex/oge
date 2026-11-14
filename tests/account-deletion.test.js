import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentSession, sessionVersionOf } from '../lib/session-revocation.js';
import { ACCOUNT_DELETE_CONFIRMATION, canDeleteAccount } from '../lib/account-deletion.js';
import { readFile } from 'node:fs/promises';

test('JWT session version checks fail closed for missing and revoked accounts', () => {
  assert.equal(isCurrentSession(null, 0), false);
  assert.equal(isCurrentSession({ sessionVersion: 'bad-value' }, 'bad-value'), false);
  assert.equal(isCurrentSession({ sessionVersion: 3 }, 3), true);
  assert.equal(isCurrentSession({ sessionVersion: 3 }, 2), false);
  assert.equal(isCurrentSession({ sessionVersion: 0 }, undefined), true);
  assert.equal(isCurrentSession({ sessionVersion: 1 }, undefined), false);
  assert.equal(sessionVersionOf({}), 0);
  const next = '9b044299-28c7-44ad-9d66-3f6b77e956a4';
  assert.equal(isCurrentSession({ sessionVersion: next }, next), true);
  assert.equal(isCurrentSession({ sessionVersion: next }, 0), false);
});

test('account deletion requires signed-in user and recent Google authentication', () => {
  const now = 1_800_000_000_000;
  const valid = { user: { id: 'user-a', authenticatedAt: now - 60_000 } };
  assert.equal(canDeleteAccount(valid, now), true);
  assert.equal(canDeleteAccount({ user: { id: 'user-a' } }, now), false);
  assert.equal(canDeleteAccount({ user: { id: 'user-a', authenticatedAt: now - 301_000 } }, now), false);
  assert.equal(canDeleteAccount({ user: { id: 'user-a', authenticatedAt: now + 1000 } }, now), false);
  assert.equal(canDeleteAccount({ user: { authenticatedAt: now } }, now), false);
  assert.equal(ACCOUNT_DELETE_CONFIRMATION, 'DELETE MY ACCOUNT');
});

test('account deletion stays opt-in, transactional and scoped to owner collections', async () => {
  const src = await readFile(new URL('../app/api/account/route.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.OGE_ACCOUNT_DELETION_ENABLED !== 'true'/);
  assert.match(src, /transaction\.withTransaction\(/);
  for (const name of ['notes', 'subjects', 'quickNotes', 'personalQuickNotes', 'savedLinks']) {
    assert.ok(src.includes("'" + name + "'"));
  }
  assert.match(src, /deleteMany\(\{ ownerId \}, \{ session: transaction \}\)/);
  assert.match(src, /deleteOne\([\s\S]*?googleSub: ownerId/);
  assert.match(src, /checkRateLimit\(db/);
});

test('auth issues a unique version on account creation and validates current versions', async () => {
  const src = await readFile(new URL('../auth.js', import.meta.url), 'utf8');
  assert.match(src, /sessionVersion: randomUUID\(\)/);
  assert.match(src, /isCurrentSession\(user, token\.sessionVersion\)/);
  assert.match(src, /token\.authenticatedAt = Date\.now\(\)/);
  assert.match(src, /session\.user\.authenticatedAt/);
});

test('destructive staging deletion drill is restricted to disposable hosts and account data', async () => {
  const script = await readFile(new URL('../scripts/verify-staging-account-deletion.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes('OGE_STAGING_DELETION_CONFIRM'));
  assert.ok(script.includes('DELETE DISPOSABLE STAGING ACCOUNT'));
  assert.ok(script.includes("base.hostname === config.host"));
  assert.ok(script.includes("base.protocol === 'https:'"));
  assert.ok(script.includes("backup.payload[name].length === 0"));
  assert.ok(script.includes("otherSubjects.payload.some"));
  assert.ok(script.includes("result.status === 401"));
  assert.ok(script.includes("extension.payload?.connected === false"));
  assert.ok(script.includes("gemini.payload?.configured === false"));
  assert.ok(script.includes("confirmation: 'DELETE MY ACCOUNT'"));
  assert.ok(!script.includes('process.env.MONGODB_URI'), 'staging script must not read production database credentials');
});

test('account deletion rejects stale signed session versions after account recreation', async () => {
  const source = await readFile(new URL('../app/api/account/route.js', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../auth.js', import.meta.url), 'utf8');
  assert.match(auth, /session\.user\.sessionVersion = token\.sessionVersion \?\? 0/);
  assert.match(source, /projection: \{ _id: 1, sessionVersion: 1 \}/);
  assert.match(source, /!isCurrentSession\(user, session\.user\.sessionVersion\)/);
  assert.match(source, /sessionVersion: user\.sessionVersion \?\? \{ \$exists: false \}/);
  assert.equal(isCurrentSession({ sessionVersion: 'c96a716d-125b-43e9-96dc-992a9b6d34cf' },
    '6ce8be36-9f52-44ad-b66d-690cd7cda25b'), false);
  assert.equal(isCurrentSession({ sessionVersion: 'c96a716d-125b-43e9-96dc-992a9b6d34cf' },
    'c96a716d-125b-43e9-96dc-992a9b6d34cf'), true);
});
