import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  checkVaultLiveAcceptanceDrillGuard,
  executeVaultLiveAcceptanceReadOnlyDrill,
} from '../lib/oge-vault-live-acceptance-drill.js';
import {
  inspectSignedDeviceAcceptanceReadOnly,
} from '../lib/oge-vault-signed-device-acceptance.js';
import {
  assertVaultSignedDeviceObservation,
} from '../lib/oge-vault-two-device-acceptance-readiness.js';

const ORIGIN = 'https://vault-staging.example.test';
const RUN = 'c9868d1a-0d20-4de6-befe-3494b7a2fba5';
const SHA = (s) => createHash('sha1').update(s).digest('hex');
const HEAD = SHA('m84-head'), TREE = SHA('m84-tree');
const safeEnv = {
  OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL: 'YES_TWO_PRIVATE_STAGING_SESSIONS_READ_ONLY',
  OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
  OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
  OGE_ACCOUNT_DELETION_ENABLED: 'false',
  OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
  MONGODB_DB: 'oge_vault_restore_staging_m84',
  OGE_STAGING_URL: ORIGIN, AUTH_URL: ORIGIN, OGE_VAULT_BASE_URL: ORIGIN,
  OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: RUN,
};

async function syntheticObservation(deviceSlot, challenge) {
  const vault = {
    status: 'connected', repoName: 'ogenotes-vault',
    repoId: 417, installationId: 912,
    githubAccountId: '1002', githubLogin: 'm84-synthetic',
  };
  const client = () => ({
    branch: 'main', readOnly: true, vault: { ...vault },
    call: async (path, opts = {}) => {
      assert.equal(opts.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main') return { object: { sha: HEAD } };
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      throw new Error('Unexpected private provider read');
    },
  });
  return inspectSignedDeviceAcceptanceReadOnly(client(), client(), {
    ownerVerifier: async () => true, challenge, deviceSlot,
  });
}

test('M84 two separate private staging session reads return exact M82 pair and private-only challenges, with no signoff', async () => {
  const calls = [];
  const nonceSource = (() => {
    let n = 1;
    return () => Buffer.alloc(32, n++);
  })();
  const invoke = async (slot, nonce) => {
    calls.push({ slot, nonce });
    return {
      status: 200, contentType: 'application/json; charset=utf-8',
      json: await syntheticObservation(slot, nonce),
    };
  };
  const result = await executeVaultLiveAcceptanceReadOnlyDrill({
    env: safeEnv, invoke, nonceSource,
  });
  assert.deepEqual(calls.map(x => x.slot), ['device-a', 'device-b']);
  assert.notEqual(calls[0].nonce, calls[1].nonce);
  assert.equal(calls[0].nonce.length, 64);
  assert.equal(result.pair.runId, RUN);
  assert.equal(result.pair.origin, ORIGIN);
  assert.equal(result.pair.format, 'oge-vault-signed-device-acceptance-pair');
  assert.equal(result.pair.observations['device-a'].declaredDeviceSlot, 'device-a');
  assert.equal(result.pair.observations['device-b'].declaredDeviceSlot, 'device-b');
  for (const [slot, nonce] of calls) {
    assertVaultSignedDeviceObservation(result.pair.observations[slot], slot, nonce);
  }
  assert.equal(result.operatorChallenges['device-a'], calls[0].nonce);
  assert.equal(result.operatorChallenges['device-b'], calls[1].nonce);
  assert.equal(result.safeSummary.observedSessionStateCount, 2);
  assert.equal(result.safeSummary.twoPhysicalDevicesIndependentlyVerified, false);
  assert.equal(result.safeSummary.actualOAuthIssuersIndependentlyVerified, false);
  assert.equal(result.safeSummary.sessionSourceProvenanceVerified, false);
  assert.equal(result.safeSummary.realProviderFaultMatrixExecuted, false);
  assert.equal(result.safeSummary.completeStagingAcceptanceSignedOff, false);
  assert.equal(result.safeSummary.canEnableProduction, false);
  assert.equal(result.safeSummary.canReleaseImportLock, false);
  assert.equal(result.safeSummary.canRetryUnknownWrite, false);
  assert.equal(result.safeSummary.githubWritesPerformed, false);
  const visible = JSON.stringify(result.safeSummary);
  for (const sensitive of [
    ...calls.map(x => x.nonce), RUN, ORIGIN, HEAD, TREE,
    vaultMarker(), result.pair.observations['device-a'].challengeFingerprint,
  ]) assert.equal(visible.includes(sensitive), false);
});

function vaultMarker() { return 'm84-synthetic'; }

test('M84 failed M82 response, redirects, denied permissions, malformed JSON and forged signoff stop without retries', async () => {
  const badResponses = [
    () => ({ status: 302, contentType: 'text/html', json: {} }),
    () => ({ status: 401, contentType: 'application/json', json: {} }),
    () => ({ status: 403, contentType: 'application/json', json: {} }),
    () => ({ status: 429, contentType: 'application/json', json: {} }),
    () => ({ status: 503, contentType: 'application/json', json: {} }),
    () => ({ status: 200, contentType: 'text/plain', json: {} }),
    () => ({ status: 200, contentType: 'application/json', json: [] }),
    async (slot, nonce) => ({
      status: 200, contentType: 'application/json',
      json: { ...(await syntheticObservation(slot, nonce)),
        completeStagingAcceptanceSignedOff: true },
    }),
    async (slot, nonce) => ({
      status: 200, contentType: 'application/json',
      json: { ...(await syntheticObservation(slot, nonce)),
        declaredDeviceSlot: 'device-b' },
    }),
  ];
  for (const response of badResponses) {
    let calls = 0, issued = 0;
    const nonceSource = () => Buffer.alloc(32, ++issued);
    await assert.rejects(executeVaultLiveAcceptanceReadOnlyDrill({
      env: safeEnv, nonceSource,
      invoke: async (slot, nonce) => {
        calls++;
        return response(slot, nonce);
      },
    }), TypeError);
    assert.equal(calls, 1, 'provider response failure must never retry');
  }
});

test('M84 second signed-session error stops after exactly two calls and yields no partial response', async () => {
  let calls = 0, issued = 0;
  const nonceSource = () => Buffer.alloc(32, ++issued);
  await assert.rejects(executeVaultLiveAcceptanceReadOnlyDrill({
    env: safeEnv, nonceSource,
    invoke: async (slot, nonce) => {
      calls++;
      if (slot === 'device-b') throw new Error('SYNTHETIC_PRIVATE_COOKIE_MUST_NOT_LEAK');
      return {
        status: 200, contentType: 'application/json',
        json: await syntheticObservation(slot, nonce),
      };
    },
  }), err => err instanceof TypeError &&
    !err.message.includes('SYNTHETIC_PRIVATE_COOKIE_MUST_NOT_LEAK'));
  assert.equal(calls, 2);
});

test('M84 identical or malformed entropy stops before ANY network invocation', async () => {
  for (const nonceSource of [
    () => Buffer.alloc(32, 1),
    () => Buffer.alloc(8, 1),
    () => 'x'.repeat(64),
  ]) {
    let calls = 0;
    await assert.rejects(executeVaultLiveAcceptanceReadOnlyDrill({
      env: safeEnv, nonceSource, invoke: async () => { calls++; },
    }), TypeError);
    assert.equal(calls, 0);
  }
});

test('M84 guard rejects missing opt-in, non-isolated origin/DB, invalid run UUID and GitHub write flags', () => {
  assert.equal(checkVaultLiveAcceptanceDrillGuard(safeEnv), true);
  for (const change of [
    { OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL: 'NO' },
    { OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'false' },
    { OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: 'bad' },
    { MONGODB_DB: 'oge' },
    { OGE_STAGING_URL: 'https://production.example.com' },
    { OGE_STAGING_URL: 'http://vault-staging.example.test' },
    { OGE_STAGING_URL: 'https://localhost' },
    { AUTH_URL: 'https://production.example.com' },
    { OGE_VAULT_BASE_URL: 'https://another-staging.example.test' },
    { OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES_DISPOSABLE_SIGNED_STAGING_ONLY' },
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
    { OGE_VAULT_ACCOUNT_DELETION_INTERNAL: 'true' },
    { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
    { OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'true' },
    { OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'true' },
  ]) assert.equal(checkVaultLiveAcceptanceDrillGuard({
    ...safeEnv, ...change,
  }), false);
});

test('M84 local runner is OFF by default, no external live provider in CI; static private-file, redirect, GET/POST scope safeguards', async () => {
  const source = await readFile(new URL(
    '../scripts/run-vault-signed-staging-read-drill.mjs',
    import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-live-acceptance-drill.js',
    import.meta.url), 'utf8');
  assert.match(source, /from '@playwright\/test'/);
  assert.match(source, /constants\.O_NOFOLLOW/);
  assert.match(source, /statOwned/);
  assert.match(source, /sessionFingerprint === second\.sessionFingerprint/);
  assert.match(source, /maxRedirects: 0/);
  assert.match(source, /\/api\/vault\/acceptance\/signed-device-read/);
  assert.match(source, /O_CREAT \| constants\.O_EXCL/);
  assert.match(source, /m84-observations\.json/);
  assert.match(source, /m84-challenges\.json/);
  assert.match(core, /canEnableProduction: false/);
  assert.match(core, /canReleaseImportLock: false/);
  assert.doesNotMatch(source + core,
    /db\.collection|insertOne\(|updateOne\(|deleteOne\(|withVaultOwnerImportExclusive|force: false|git\/refs\/heads|commitVaultNoteBatch|method:\s*'PATCH'/);
  const run = spawnSync(process.execPath, [
    new URL('../scripts/run-vault-signed-staging-read-drill.mjs',
      import.meta.url).pathname,
  ], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /BLOCKED:/);
});
