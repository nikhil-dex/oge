import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoginEmail, validAccountPassword, hashAccountPassword,
  verifyAccountPassword, isRecentGoogleAuthentication } from '../lib/password-auth.js';

test('email is normalized but ownership is not derived from email', () => {
  assert.equal(normalizeLoginEmail(' Student@Gmail.com '), 'student@gmail.com');
  assert.equal(normalizeLoginEmail('invalid'), null);
  assert.equal(normalizeLoginEmail(''), null);
});
test('password hashes use random salts and fail closed', async () => {
  assert.equal(validAccountPassword('short'), false);
  assert.equal(validAccountPassword('correct horse battery staple'), true);
  const a = await hashAccountPassword('correct horse battery staple');
  const b = await hashAccountPassword('correct horse battery staple');
  assert.notEqual(a, b);
  assert.equal(await verifyAccountPassword('correct horse battery staple', a), true);
  assert.equal(await verifyAccountPassword('incorrect-password', a), false);
  assert.equal(await verifyAccountPassword('correct horse battery staple', undefined), false);
  assert.equal(await verifyAccountPassword('correct horse battery staple', 'scrypt-v1$broken'), false);
});
test('setting a linked password needs a recent Google login', () => {
  const now = 2000000;
  assert.equal(isRecentGoogleAuthentication({ user: { authenticatedAt: now - 1000 } }, now), true);
  assert.equal(isRecentGoogleAuthentication({ user: { authenticatedAt: now - 11 * 60000 } }, now), false);
  assert.equal(isRecentGoogleAuthentication({ user: { authenticatedAt: now + 1000 } }, now), false);
  assert.equal(isRecentGoogleAuthentication(null, now), false);
});
