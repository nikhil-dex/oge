import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  inspectVaultDisposableFaultStagingReadOnly,
  validateVaultDisposableFaultPlan,
} from '../lib/oge-vault-disposable-fault-staging-preflight.js';

const NOW = Date.now();
const HEAD = 'a'.repeat(40), TREE = 'b'.repeat(40);
const SENTINEL_SHA = 'c'.repeat(40), MARKER_SHA = 'd'.repeat(40);
const NESTED_SHA = 'e'.repeat(40);
const ORIGIN = 'https://vault-staging.example.test';
const scope = {
  origin: ORIGIN,
  runId: 'bd3f91d0-0d08-4fca-a40c-d99d44aa7b71',
  repoId: 8001, installationId: 9002,
  githubAccountId: '100003',
  branch: 'main',
  expectedHead: HEAD,
};
const plan = {
  format: 'oge-vault-disposable-fault-staging-plan',
  version: 1, ...scope,
  expiresAt: new Date(NOW + 25 * 60000).toISOString(),
  operatorReviewSha256: createHash('sha256').update('independent-operator')
    .digest('hex'),
  independentReviewSha256: createHash('sha256').update('independent-review')
    .digest('hex'),
  confirmation: 'INSPECT_DISPOSABLE_FAULT_STAGING_NO_WRITES_OR_UNLOCK',
};
const s = {
  format: 'oge-vault-disposable-fault-sentinel',
  version: 1, ...scope, expiresAt: plan.expiresAt,
  confirmation: 'DISPOSABLE_PRIVATE_GITHUB_VAULT_NO_REAL_USER_NOTES',
};
const secret = Buffer.from(JSON.stringify(s));
const vault = {
  status: 'connected', repoId: scope.repoId,
  installationId: scope.installationId,
  githubAccountId: scope.githubAccountId,
  githubLogin: 'm86-synthetic-staging-account',
  repoName: 'ogenotes-vault',
};

function fake({ publicRepo = false, archived = false, extraNote = false,
  wrongBlob = false, wrongTree = false, unexpectedSymlink = false,
  movedHead = false, differentRepo = false, revoked = false } = {}) {
  const calls = [], state = { owner: 0, refs: 0 };
  const repo = {
    id: scope.repoId, private: !publicRepo,
    archived, disabled: false,
    name: 'ogenotes-vault', default_branch: 'main',
    owner: { id: Number(scope.githubAccountId),
      login: vault.githubLogin },
  };
  const entries = [
    { path: '.ogenotes', type: 'tree', mode: '040000', sha: NESTED_SHA },
    { path: '.ogenotes/vault.json', type: 'blob', mode: '100644',
      sha: MARKER_SHA },
    { path: '.ogenotes/fault-test-sentinel.json',
      type: 'blob', mode: '100644', sha: SENTINEL_SHA, size: secret.length },
    { path: 'README.md', type: 'blob', mode: '100644',
      sha: 'f'.repeat(40), size: 40 },
  ];
  if (extraNote) entries.push({
    path: 'notes/123.json', type: 'blob', mode: '100644',
    sha: '0'.repeat(40),
  });
  if (unexpectedSymlink) entries.push({
    path: '.gitignore', type: 'blob', mode: '120000',
    sha: '0'.repeat(40),
  });
  const client = (name) => ({
    readOnly: true,
    branch: 'main',
    vault: { ...vault, ...(differentRepo && name === 'second'
      ? { repoId: scope.repoId + 1 } : {}) },
    call: async (path, opts = {}) => {
      assert.equal(opts.method || 'GET', 'GET');
      calls.push({ name, path });
      if (path === '/git/ref/heads/main') {
        state.refs++;
        return { object: { sha: movedHead && state.refs >= 2 ?
          '9'.repeat(40) : HEAD } };
      }
      if (path === '/git/commits/' + HEAD)
        return { tree: { sha: TREE } };
      if (path === '') return { ...repo };
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { sha: TREE, truncated: false, tree: wrongTree ? [] : entries };
      if (path === '/git/blobs/' + SENTINEL_SHA)
        return { sha: SENTINEL_SHA, encoding: 'base64',
          size: secret.length,
          content: (wrongBlob ? Buffer.from(
            JSON.stringify({ ...s, repoId: 1 })) : secret)
            .toString('base64') };
      throw new TypeError('Unexpected synthetic GET ' + path);
    },
  });
  return {
    first: client('first'),
    second: client('second'),
    calls, state,
    ownerVerifier: async () => {
      state.owner++;
      return !(revoked && state.owner >= 2);
    },
  };
}
const inspect = (f, changes = {}) =>
  inspectVaultDisposableFaultStagingReadOnly(
    f.first, f.second, plan, {
      expectedScope: scope, ownerVerifier: f.ownerVerifier,
      now: NOW, ...changes,
    });

test('M86 local operator scope and exact sentinel private GitHub tree read-only proof holds', async () => {
  const f = fake();
  const report = await inspect(f);
  assert.equal(report.status,
    'PRIVATE_DISPOSABLE_REPO_METADATA_OBSERVED_FAULT_WRITES_NOT_AUTHORIZED_HOLD');
  assert.equal(report.liveProviderMetadataReadOnlyObserved, true);
  assert.equal(report.exactDisposableSentinelClaimAndBlobMatched, true);
  assert.equal(report.boundedAllowlistedTreeWithoutNotePathsObserved, true);
  assert.equal(report.privateRepoAndInstallationMappingStable, true);
  assert.equal(report.genuineHumanApprovalsIndependentlyVerified, false);
  assert.equal(report.operatorFaultInjectionPermissionGranted, false);
  assert.equal(report.actualGitHubWritesOrFailureInjectionExecuted, false);
  assert.equal(report.pendingAsyncGitHubWritesQuiescedProven, false);
  assert.equal(report.canReleaseImportLock, false);
  assert.equal(report.canEnableProduction, false);
  assert.equal(report.noPrivateNoteBodyRead, true);
  assert.equal(report.githubWritesPerformed, false);
  assert.equal(report.mongoWritesPerformed, false);
  assert.ok(f.calls.every(x => x.path === '' || x.path.startsWith('/git/')));
  assert.equal(f.calls.filter(x => x.path.includes('notes/')).length, 0);
  const output = JSON.stringify(report);
  for (const privateValue of [
    scope.runId, scope.origin, scope.githubAccountId, vault.githubLogin,
    plan.operatorReviewSha256, HEAD, TREE, SENTINEL_SHA,
  ]) assert.equal(output.includes(privateValue), false);
});

test('M86 rejects wrong independently pinned operator scope before ANY private GitHub read', async () => {
  for (const changes of [
    { runId: '30af6eac-5c8a-4481-b345-2b659553321a' },
    { repoId: scope.repoId + 1 },
    { installationId: scope.installationId + 1 },
    { githubAccountId: '30920' },
    { origin: 'https://different-staging.example.test' },
    { branch: 'another' }, { expectedHead: '0'.repeat(40) },
  ]) {
    const f = fake();
    await assert.rejects(inspect(f, {
      expectedScope: { ...scope, ...changes },
    }), TypeError);
    assert.equal(f.calls.length, 0);
  }
});

test('M86 rejects forged local plan, invalid expiry and untrusted review hashes', () => {
  for (const change of [
    { format: 'other' }, { confirmation: 'COMMIT_WRITE' },
    { expiresAt: new Date(NOW - 60000).toISOString() },
    { expiresAt: new Date(NOW + 48 * 3600000).toISOString() },
    { operatorReviewSha256: plan.independentReviewSha256 },
    { extra: true }, { runId: 'INVALID' },
    { origin: 'http://vault-staging.example.test' },
    { origin: 'https://production.example.test' },
    { githubAccountId: '0' }, { repoId: -1 },
    { expectedHead: 'bad' },
  ]) assert.throws(() => validateVaultDisposableFaultPlan(
    { ...plan, ...change }, scope, { now: NOW }), TypeError);
});

test('M86 rejects public/archived repo, Note paths, symlinks, malformed tree, forged sentinel, moved HEAD', async () => {
  for (const options of [
    { publicRepo: true }, { archived: true },
    { extraNote: true }, { wrongTree: true },
    { unexpectedSymlink: true }, { wrongBlob: true },
    { movedHead: true }, { differentRepo: true }, { revoked: true },
  ]) {
    const f = fake(options);
    await assert.rejects(inspect(f), TypeError,
      'failed to reject: ' + JSON.stringify(options));
  }
});

test('M86 rejects same GitHub client twice and write-capable installation client', async () => {
  const f = fake();
  await assert.rejects(inspectVaultDisposableFaultStagingReadOnly(
    f.first, f.first, plan, { expectedScope: scope,
      ownerVerifier: f.ownerVerifier, now: NOW }), TypeError);
  const g = fake();
  g.second.readOnly = false;
  await assert.rejects(inspect(g), TypeError);
});

test('M86 CLI independently opt-in, owner-only private plan and no write-scoped client', async () => {
  const source = await readFile(new URL(
    '../scripts/inspect-vault-disposable-fault-staging.mjs',
    import.meta.url), 'utf8');
  const pure = await readFile(new URL(
    '../lib/oge-vault-disposable-fault-staging-preflight.js',
    import.meta.url), 'utf8');
  assert.match(source, /OGE_VAULT_DISPOSABLE_FAULT_PREFLIGHT/);
  assert.match(source, /readOnly: true/g);
  assert.match(source, /readConcern: \{ level: 'majority' \}/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /vault\.repoId/);
  assert.match(source, /process\.exitCode = 2/);
  assert.match(pure, /inspectVaultProviderReadOnlyPair/);
  assert.match(pure, /checkTree/);
  assert.match(pure, /git\/blobs/);
  assert.doesNotMatch(pure, /method: 'PATCH'|method: 'PUT'|method: 'DELETE'|updateOne\(|deleteOne\(|insertOne\(|releasePreWriteVaultImportLock/);
  assert.doesNotMatch(source, /readOnly: false|releasePreWriteVaultImportLock|method: 'PATCH'|force: false/);
  const cli = new URL('../scripts/inspect-vault-disposable-fault-staging.mjs',
    import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BLOCKED:/);
});
