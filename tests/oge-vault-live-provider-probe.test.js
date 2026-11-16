import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectVaultProviderReadOnlyPair } from '../lib/oge-vault-live-provider-probe.js';
import { VaultGitHubError, vaultGithubRequest } from '../lib/oge-vault-github.js';

const H = (v) => createHash('sha1').update(v).digest('hex');
const HEAD = H('m61-head'), TREE = H('m61-tree');
const vault = {
  status: 'connected', repoId: 312, installationId: 9,
  repoName: 'ogenotes-vault', githubAccountId: '701',
  githubLogin: 'test-vault-owner',
};
function fixture({ changeHead = false, changeTree = false,
  ownerRevoked = false, failRate = false, failPermission = false } = {}) {
  const events = [], state = { reads: 0, ownerChecks: 0 };
  const make = (label) => ({
    branch: 'main', vault: { ...vault }, readOnly: true,
    async call(path, opts = {}) {
      assert.equal(opts.method || 'GET', 'GET');
      events.push({ label, path, method: 'GET' });
      if (failRate) throw new VaultGitHubError('github-rate-limited', 429);
      if (failPermission) throw new VaultGitHubError('github-permission-denied', 403);
      if (path === '/git/ref/heads/main') {
        state.reads++;
        return { object: { sha: changeHead && state.reads >= 2 ?
          H('m61-head-moved') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD)
        return { tree: { sha: changeTree && label === 'second'
          ? H('m61-tree-other') : TREE } };
      throw Error('unexpected GitHub GET request');
    },
  });
  const ownerVerifier = async () => {
    state.ownerChecks++;
    return !(ownerRevoked && state.ownerChecks > 1);
  };
  return { first: make('first'), second: make('second'),
    ownerVerifier, events, state };
}

test('M61 two independently scoped read-only GitHub clients verify stable private HEAD/tree without note reads', async () => {
  const f = fixture();
  const report = await inspectVaultProviderReadOnlyPair(
    f.first, f.second, { ownerVerifier: f.ownerVerifier });
  assert.equal(report.signedPrivateRepoMappingObserved, true);
  assert.equal(report.twoIndependentReadOnlyClientsObserved, true);
  assert.equal(report.sameGitHubBranchAndCommitTreeObserved, true);
  assert.equal(report.physicalTwoDeviceSessionsVerified, false);
  assert.equal(report.liveOAuthBrowserAcceptanceVerified, false);
  assert.equal(report.completeStagingAcceptanceSignedOff, false);
  assert.equal(report.canAuthorizeRestore, false);
  assert.equal(report.canReleaseImportLock, false);
  assert.equal(report.writeTokenRequested, false);
  assert.equal(f.state.reads, 3);
  assert.equal(f.state.ownerChecks, 2);
  assert.ok(f.events.every((e) => e.method === 'GET'));
  assert.equal(f.events.some((e) => /blobs|contents|notes\//.test(e.path)), false);
  const text = JSON.stringify(report);
  for (const secret of [HEAD, TREE, vault.githubLogin, vault.githubAccountId])
    assert.equal(text.includes(secret), false);
});

test('M61 changed GitHub branch or tree, revoked owner, denied rights and rate limits fail closed', async () => {
  for (const opt of [
    { changeHead: true }, { changeTree: true },
    { ownerRevoked: true }, { failRate: true },
    { failPermission: true },
  ]) {
    const f = fixture(opt);
    await assert.rejects(inspectVaultProviderReadOnlyPair(
      f.first, f.second, { ownerVerifier: f.ownerVerifier }));
  }
});

test('M61 never accepts a write-scoped client, same client twice or different signed repo mapping', async () => {
  for (const change of [
    (f) => { f.first.readOnly = false; },
    (f) => { f.second.readOnly = false; },
    (f) => { f.second = f.first; },
    (f) => { f.second.vault.repoId++; },
    (f) => { f.second.vault.githubAccountId = 'different'; },
    (f) => { f.second.vault.installationId++; },
    (f) => { f.second.vault.repoName = 'different-vault'; },
    (f) => { f.second.branch = 'other-branch'; },
    (f) => { f.first.branch = '../bad'; },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(inspectVaultProviderReadOnlyPair(
      f.first, f.second, { ownerVerifier: f.ownerVerifier }), TypeError);
    assert.equal(f.events.length, 0);
  }
});

test('M61 GET-only provider boundary maps real 429/403/409/422 and no mutations to denied status', async () => {
  const cases = [
    [429, {}, 'github-rate-limited', 429],
    [403, { 'retry-after': '10' }, 'github-rate-limited', 429],
    [403, {}, 'github-permission-denied', 403],
    [401, {}, 'github-auth-expired', 401],
    [409, {}, 'github-api-error', 409],
    [422, {}, 'github-repository-conflict', 422],
  ];
  for (const [status, headers, code, expectedStatus] of cases) {
    let calls = 0;
    const fake = async (_url, request) => {
      assert.equal(request.method, 'GET');
      calls++;
      return {
        ok: false, status, headers: {
          get: (key) => headers[key.toLowerCase()] ?? null,
        },
      };
    };
    await assert.rejects(vaultGithubRequest('/repos/demo/ogenotes-vault/git/ref/heads/main', {
      token: 'SYNTHETIC_NEVER_PRINT', fetcher: fake,
    }), (err) => err instanceof VaultGitHubError &&
      err.message === code && err.status === expectedStatus);
    assert.equal(calls, 1, 'rate limits/conflicts are never retried');
  }
});

test('M61 write failures never retry HTTP POST or PATCH (including dropped response)', async () => {
  for (const method of ['POST', 'PATCH']) {
    for (const scenario of ['network', 429, 409, 422, 503]) {
      let attempts = 0;
      const fake = async (_url, opts) => {
        attempts++;
        assert.equal(opts.method, method);
        if (scenario === 'network') throw Error('private dropped response');
        return { ok: false, status: scenario,
          headers: { get: () => null } };
      };
      await assert.rejects(vaultGithubRequest('/repos/demo/ogenotes-vault/git/ref/heads/main', {
        token: 'SYNTHETIC_NEVER_PRINT', method,
        body: { force: false }, fetcher: fake,
      }), VaultGitHubError);
      assert.equal(attempts, 1);
    }
  }
});

test('M61 read-only operator preflight contains no write route, user Notes, DB changes or false two-device signoff', async () => {
  const script = await readFile(new URL(
    '../scripts/probe-vault-live-provider-readonly.mjs', import.meta.url), 'utf8');
  const probe = await readFile(new URL(
    '../lib/oge-vault-live-provider-probe.js', import.meta.url), 'utf8');
  assert.match(script, /OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY/);
  assert.match(script, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(script, /getVaultNoteClient\(db, identity, \{ readOnly: true \}\)/);
  assert.match(script, /oge_vault_restore_staging_/);
  assert.match(probe, /physicalTwoDeviceSessionsVerified: false/);
  assert.match(probe, /liveOAuthBrowserAcceptanceVerified: false/);
  assert.match(probe, /completeStagingAcceptanceSignedOff: false/);
  assert.doesNotMatch(script + probe,
    /commitVaultNoteBatch\(|\.updateOne\(|\.insertOne\(|\.deleteOne\(|method: 'PATCH'|method: 'POST'/);
});
