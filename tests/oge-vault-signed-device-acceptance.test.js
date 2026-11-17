import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  signedDeviceAcceptanceReadAllowed,
  inspectSignedDeviceAcceptanceReadOnly,
} from '../lib/oge-vault-signed-device-acceptance.js';

const H = (data) => createHash('sha1').update(data).digest('hex');
const HEAD = H('m82-head'), TREE = H('m82-tree');
const STAGING = 'https://vault-staging.example.test';
const vault = {
  status: 'connected', repoId: 912, installationId: 17,
  repoName: 'ogenotes-vault',
  githubAccountId: '912111', githubLogin: 'synthetic-m82',
};
const CHALLENGE_A = '1'.repeat(64), CHALLENGE_B = '2'.repeat(64);

function fixture({ headMoves = false, treeMoves = false,
  revoked = false, denied = false } = {}) {
  const calls = [];
  const state = { refs: 0, verified: 0 };
  const client = (tag) => ({
    branch: 'main', readOnly: true, vault: { ...vault },
    async call(path, opts = {}) {
      assert.equal(opts.method || 'GET', 'GET');
      calls.push({ tag, path });
      if (denied) throw new VaultGitHubError('github-permission-denied', 403);
      if (path === '/git/ref/heads/main') {
        state.refs++;
        return { object: { sha: headMoves && state.refs >= 2
          ? H('m82-moved-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD)
        return { tree: { sha: treeMoves && tag === 'second'
          ? H('m82-moved-tree') : TREE } };
      throw Error('Unexpected GitHub provider call: ' + path);
    },
  });
  const ownerVerifier = async () => {
    state.verified++;
    return !(revoked && state.verified >= 2);
  };
  return { first: client('first'), second: client('second'),
    ownerVerifier, calls, state };
}

test('M82 one signed-session observation binds operator challenge, read-only Github repo, yet refuses two-device signoff', async () => {
  const f = fixture();
  const report = await inspectSignedDeviceAcceptanceReadOnly(
    f.first, f.second, {
      ownerVerifier: f.ownerVerifier, challenge: CHALLENGE_A,
      deviceSlot: 'device-a',
    });
  assert.equal(report.format, 'oge-vault-signed-device-acceptance-observation');
  assert.equal(report.version, 1);
  assert.equal(report.declaredDeviceSlot, 'device-a');
  assert.match(report.challengeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.challengeFingerprint.includes(CHALLENGE_A), false);
  assert.equal(report.signedOwnerScopedSessionObserved, true);
  assert.equal(report.privateGitHubAppReadOnlyPairObserved, true);
  assert.equal(report.privateGitHubHeadTreeConsistentDuringCheck, true);
  assert.equal(report.actualOAuthProviderIndependentlyVerified, false);
  assert.equal(report.physicalDeviceIdentityIndependentlyVerified, false);
  assert.equal(report.twoDistinctPhysicalDeviceSessionsVerified, false);
  assert.equal(report.completeStagingAcceptanceSignedOff, false);
  assert.equal(report.canAuthorizeRestore, false);
  assert.equal(report.canReleaseImportLock, false);
  assert.equal(report.canRetryUnknownWrite, false);
  assert.equal(report.githubWritesPerformed, false);
  assert.equal(report.mongodbWritesPerformed, false);
  assert.equal(report.privateNotesRead, false);
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every((call) => call.path.startsWith('/git/')));
  const visible = JSON.stringify(report);
  for (const privateData of [CHALLENGE_A, HEAD, TREE,
    vault.githubLogin, vault.githubAccountId, vault.repoId.toString()])
    assert.equal(visible.includes(privateData), false);
  const g = fixture();
  const other = await inspectSignedDeviceAcceptanceReadOnly(
    g.first, g.second, {
      ownerVerifier: g.ownerVerifier, challenge: CHALLENGE_B,
      deviceSlot: 'device-b',
    });
  assert.notEqual(report.challengeFingerprint, other.challengeFingerprint);
  assert.equal(other.twoDistinctPhysicalDeviceSessionsVerified, false);
});

test('M82 rejects malformed challenge/slot before any private GitHub read or owner verifier', async () => {
  for (const [challenge, deviceSlot] of [
    [CHALLENGE_A, 'operator'], ['a'.repeat(63), 'device-a'],
    ['Z'.repeat(64), 'device-b'], ['', 'device-a'],
    [null, 'device-a'], [CHALLENGE_A, 'device-c'],
  ]) {
    const f = fixture();
    await assert.rejects(inspectSignedDeviceAcceptanceReadOnly(
      f.first, f.second, { ownerVerifier: f.ownerVerifier,
        challenge, deviceSlot }), TypeError);
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.verified, 0);
  }
});

test('M82 race, revocation and provider read denial fail closed, never retry provider requests', async () => {
  for (const options of [
    { headMoves: true }, { treeMoves: true },
    { revoked: true }, { denied: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(inspectSignedDeviceAcceptanceReadOnly(
      f.first, f.second, { ownerVerifier: f.ownerVerifier,
        challenge: CHALLENGE_A, deviceSlot: 'device-a' }));
    assert.ok(f.calls.every((call) => call.path.startsWith('/git/')));
  }
});

test('M82 rejects write-token, same client twice, changed installation or repo mapping', async () => {
  for (const alteration of [
    f => { f.first.readOnly = false; },
    f => { f.second.readOnly = false; },
    f => { f.second = f.first; },
    f => { f.second.vault.repoId++; },
    f => { f.second.vault.githubLogin = 'changed'; },
    f => { f.second.vault.installationId++; },
    f => { f.second.branch = 'other'; },
  ]) {
    const f = fixture();
    alteration(f);
    await assert.rejects(inspectSignedDeviceAcceptanceReadOnly(
      f.first, f.second, { ownerVerifier: f.ownerVerifier,
        challenge: CHALLENGE_A, deviceSlot: 'device-b' }), TypeError);
    assert.equal(f.calls.length, 0);
  }
});

test('M82 isolated staging opt-in rejects production URL, writes, wrong origin and unsafe flags', () => {
  const env = {
    OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'true',
    OGE_VAULT_MAIN_PREVIEW: 'true',
    OGE_VAULT_NOTE_API_PREVIEW: 'true',
    OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
    OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
    OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
    OGE_ACCOUNT_DELETION_ENABLED: 'false',
    OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
    OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
    MONGODB_DB: 'oge_vault_restore_staging_m82',
    OGE_STAGING_URL: STAGING,
    AUTH_URL: STAGING, OGE_VAULT_BASE_URL: STAGING,
  };
  const request = {
    url: STAGING + '/api/vault/acceptance/signed-device-read',
    headers: { get: (name) => name === 'origin' ? STAGING : null },
  };
  const allowed = (changes = {}, overrides = {}, extra = {}) =>
    signedDeviceAcceptanceReadAllowed({
      ...request, ...overrides,
    }, {
      env: { ...env, ...changes },
      readiness: extra.readiness || (() => ({ ok: true })),
    });
  assert.equal(allowed(), true);
  for (const change of [
    { OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'false' },
    { MONGODB_DB: 'oge_prod' },
    { AUTH_URL: 'https://production.example.com' },
    { OGE_STAGING_URL: 'http://vault-staging.example.test' },
    { OGE_VAULT_BASE_URL: 'https://other.example.test' },
    { OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES_DISPOSABLE_SIGNED_STAGING_ONLY' },
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
    { OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'true' },
    { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
  ]) assert.equal(allowed(change), false);
  assert.equal(allowed({}, { url: 'https://evil.example.test/route' }), false);
  assert.equal(signedDeviceAcceptanceReadAllowed({
    ...request, headers: { get: () => 'https://evil.example.test' },
  }, { env, readiness: () => ({ ok: true }) }), false);
  assert.equal(allowed({}, {}, { readiness: () => ({ ok: false }) }), false);
});

test('M82 endpoint checks current Auth.js owner, same-origin, strict nonce and separate read-only GitHub clients', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/acceptance/signed-device-read/route.js',
    import.meta.url), 'utf8');
  const lib = await readFile(new URL(
    '../lib/oge-vault-signed-device-acceptance.js',
    import.meta.url), 'utf8');
  assert.match(route, /signedDeviceAcceptanceReadAllowed\(request\)/);
  assert.match(route, /signedStandaloneRestoreContext\(\)/);
  assert.match(route, /getVaultNoteClient\(\s*db, identity, \{ readOnly: true \}/);
  assert.match(route, /standaloneRestoreSafeguards/);
  assert.match(route, /inspectSignedDeviceAcceptanceReadOnly/);
  assert.match(route, /readLimitedBody\(request, 512\)/);
  assert.match(route, /Cache-Control.*private, no-store/);
  assert.match(lib, /OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW/);
  assert.match(lib, /env\.OGE_STAGING_URL !== env\.AUTH_URL/);
  assert.match(lib, /inspectVaultProviderReadOnlyPair/);
  assert.match(lib, /twoDistinctPhysicalDeviceSessionsVerified: false/);
  assert.match(lib, /completeStagingAcceptanceSignedOff: false/);
  assert.match(lib, /githubWritesPerformed: false/);
  assert.doesNotMatch(route + lib,
    /updateOne\(|deleteOne\(|insertOne\(|findOneAndUpdate\(|withVaultOwnerImportExclusive|commitVaultNote|markGitHubWriteAttempt|releasePreWriteVaultImportLock|method: 'PATCH'|method: 'POST'|force: false/);
});
