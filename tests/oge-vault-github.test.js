import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  stateMatches, newVaultOAuthState, stateHash, githubAppJwt,
  vaultBaseUrl, vaultGithubRequest, provisionVault, VaultGitHubError,
  VAULT_MARKER_PATH,
} from '../lib/oge-vault-github.js';

test('vault OAuth state is unguessable, 1-use compatible and rejects mismatches', () => {
  const a = newVaultOAuthState();
  const b = newVaultOAuthState();
  assert.equal(a.length, 43);
  assert.notEqual(a, b);
  assert.equal(stateMatches(a, a), true);
  assert.equal(stateMatches(a, b), false);
  assert.equal(stateMatches(a, 'bad'), false);
  assert.match(stateHash(a), /^[0-9a-f]{64}$/);
});

test('callback configuration requires HTTPS except loopback development', () => {
  assert.equal(vaultBaseUrl({ OGE_VAULT_BASE_URL: 'https://notes.example.org/' }), 'https://notes.example.org');
  assert.equal(vaultBaseUrl({ OGE_VAULT_BASE_URL: 'http://localhost:3000/' }), 'http://localhost:3000');
  for (const value of ['http://example.org/', 'https://example.org/?redirect=x',
    'https://user:password@example.org/', 'https://example.org/callback']) {
    assert.throws(() => vaultBaseUrl({ OGE_VAULT_BASE_URL: value }));
  }
});

test('GitHub App JWT is signed with private key and bounded to nine minutes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    OGE_VAULT_GITHUB_APP_ID: '123456',
    OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64:
      Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  };
  const jwt = githubAppJwt({ env, now: 1_800_000_000_000 });
  const [head, data, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(data, 'base64url'));
  assert.equal(claims.iss, '123456');
  assert.equal(claims.exp - claims.iat, 540);
  const verify = createVerify('RSA-SHA256');
  verify.update(head + '.' + data);
  verify.end();
  assert.equal(verify.verify(publicKey, signature, 'base64url'), true);
});

test('API helper constrains GitHub host/path and fails closed on API errors', async () => {
  let called = false;
  const fetcher = async () => { called = true; return { ok: false, status: 403 }; };
  await assert.rejects(() => vaultGithubRequest('/user', { token: 't', fetcher }),
    (error) => error instanceof VaultGitHubError && error.message === 'github-permission-denied');
  assert.equal(called, true);
  await assert.rejects(() => vaultGithubRequest('/../../private', { token: 't', fetcher }), TypeError);
  await assert.rejects(() => vaultGithubRequest('https://evil.example.org/path', { token: 't', fetcher }), TypeError);
});

function mockGitHub({ selected = false, privateRepo = true, repoOwner = 77, failMarker = false } = {}) {
  const calls = [];
  const github = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const body = path === '/user'
      ? { id: 77, login: 'student', type: 'User' }
      : path === '/user/installations'
        ? { installations: [{ id: 333, app_id: 999, target_type: 'User',
          repository_selection: selected ? 'selected' : 'all', account: { id: 77 } }] }
        : path === '/user/repos'
          ? { id: 42, name: 'ogenotes-vault', private: privateRepo, owner: { id: repoOwner, login: 'student' } }
          : path === '/app/installations/333/access_tokens'
            ? { token: 'temporary-scoped-installation-token' }
            : path === '/repos/student/ogenotes-vault'
              ? { id: 42, private: privateRepo, owner: { id: repoOwner } }
              : path === '/repos/student/ogenotes-vault/contents/' + VAULT_MARKER_PATH
                ? { content: { path: VAULT_MARKER_PATH } }
                : null;
    if (failMarker && path.endsWith(VAULT_MARKER_PATH)) return { ok: false, status: 403 };
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
  };
  return { calls, github };
}

test('vault setup provisions a new private user-owned repo and marker with repo-scoped token', async () => {
  const mock = mockGitHub();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const env = { OGE_VAULT_GITHUB_APP_ID: '999',
    OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64:
      Buffer.from(key.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  const result = await provisionVault('user-token', { env, fetcher: mock.github });
  assert.deepEqual(result, {
    githubAccountId: '77', githubLogin: 'student', repoId: 42,
    repoName: 'ogenotes-vault', installationId: 333,
  });
  assert.equal(mock.calls.find((x) => x.path === '/user/repos').body.private, true);
  assert.deepEqual(mock.calls.find((x) => x.path === '/app/installations/333/access_tokens').body,
    { repository_ids: [42], permissions: { contents: 'write', metadata: 'read' } });
  const marker = mock.calls.find((x) => x.path.endsWith(VAULT_MARKER_PATH));
  assert.equal(marker.method, 'PUT');
  assert.equal(JSON.parse(Buffer.from(marker.body.content, 'base64')).format, 'ogenotes-vault');
});

test('vault never creates repo before installation checks and never accepts public or wrong-owner repo', async () => {
  const mock = mockGitHub({ selected: true });
  await assert.rejects(() => provisionVault('token', { env: { OGE_VAULT_GITHUB_APP_ID: '999' },
    fetcher: mock.github }), (error) => error.message === 'vault-all-repositories-installation-required');
  assert.equal(mock.calls.some((c) => c.path === '/user/repos'), false);
  for (const options of [{ privateRepo: false }, { repoOwner: 89 }]) {
    const fixture = mockGitHub(options);
    await assert.rejects(() => provisionVault('token', { env: { OGE_VAULT_GITHUB_APP_ID: '999' },
      fetcher: fixture.github }), (error) => error.message === 'vault-privacy-verification-failed');
    assert.equal(fixture.calls.some((c) => c.path.endsWith(VAULT_MARKER_PATH)), false);
  }
});
