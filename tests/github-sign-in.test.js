import test from 'node:test';
import assert from 'node:assert/strict';
import { githubOwnerId, getVerifiedGitHubEmail } from '../lib/github-login.js';
import { isRecentOAuthAuthentication, isRecentGoogleAuthentication } from '../lib/password-auth.js';
import { readFile } from 'node:fs/promises';

test('GitHub owner IDs are separate from existing Google owner IDs', () => {
  assert.equal(githubOwnerId('123456789'), 'github:123456789');
  for (const invalid of ['', '0', '-1', 'abc', '12/34', '1'.repeat(21)]) {
    assert.equal(githubOwnerId(invalid), null);
  }
});

test('GitHub OAuth requires a verified primary email from the authenticated API', async () => {
  const fetcher = async (url, init) => {
    assert.equal(url, 'https://api.github.com/user/emails');
    assert.equal(init.headers.Authorization, 'Bearer opaque-test-token');
    return { ok: true, async json() {
      return [{ email: 'unverified@example.com', primary: true, verified: false },
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'Student@Example.com', primary: true, verified: true }];
    } };
  };
  assert.equal(await getVerifiedGitHubEmail('opaque-test-token', { fetcher }), 'student@example.com');
  assert.equal(await getVerifiedGitHubEmail('', { fetcher }), null);
  assert.equal(await getVerifiedGitHubEmail('token', { fetcher: async () => ({ ok: false }) }), null);
  assert.equal(await getVerifiedGitHubEmail('token', { fetcher: async () => ({ ok: true, json: async () => [{ email: 'unverified@example.com', primary: true, verified: false }] }) }), null);
  assert.equal(await getVerifiedGitHubEmail('token', { fetcher: async () => { throw new Error('offline'); } }), null);
});

test('GitHub sessions may reauthenticate for password setup without impersonating Google', () => {
  const now = Date.now();
  const github = { user: { authenticatedAt: now, authProvider: 'github' } };
  assert.equal(isRecentOAuthAuthentication(github, now), true);
  assert.equal(isRecentGoogleAuthentication(github, now), false);
  assert.equal(isRecentOAuthAuthentication({ user: { authenticatedAt: now - 11 * 60 * 1000, authProvider: 'github' } }, now), false);
  assert.equal(isRecentOAuthAuthentication({ user: { authenticatedAt: now, authProvider: 'credentials' } }, now), false);
});

test('GitHub login is a separate OAuth provider, never email-linked implicitly or a vault grant', async () => {
  const auth = await readFile(new URL('../auth.js', import.meta.url), 'utf8');
  const register = await readFile(new URL('../app/register/page.js', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../app/register/actions.js', import.meta.url), 'utf8');
  assert.match(auth, /GitHub\(\{ authorization:/);
  assert.match(auth, /providerAccountId/);
  assert.match(auth, /githubOwnerId\(account.providerAccountId\)/);
  assert.match(auth, /getVerifiedGitHubEmail\(account.access_token\)/);
  assert.match(auth, /\{ googleSub: ownerId \}/);
  assert.match(auth, /identityProvider: account.provider/);
  assert.match(auth, /token.authProvider = account.provider/);
  assert.doesNotMatch(auth, /findOne\(\{ email: verifiedEmail \}/);
  assert.doesNotMatch(auth, /repo|user:repo|Contents/);
  assert.match(register, /Continue with Google/);
  assert.match(register, /Continue with GitHub/);
  assert.match(actions, /signIn\('github'/);
});
