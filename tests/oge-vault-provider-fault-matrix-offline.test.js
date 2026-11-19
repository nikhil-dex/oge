import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  runVaultSyntheticProviderFaultMatrix,
} from '../lib/oge-vault-provider-fault-matrix-offline.js';

const EXPECTED = Object.freeze({
  'prewrite-owner-rejected': { patch: 0, quarantined: false, remote: false },
  'patch-permission-403': { patch: 1, quarantined: true, remote: false },
  'patch-rate-limit-429': { patch: 1, quarantined: true, remote: false },
  'patch-secondary-rate-limit-403': { patch: 1, quarantined: true, remote: false },
  'patch-stale-head-409': { patch: 1, quarantined: true, remote: false },
  'patch-stale-head-422': { patch: 1, quarantined: true, remote: false },
  'patch-provider-503': { patch: 1, quarantined: true, remote: false },
  'patch-network-disconnected': { patch: 1, quarantined: true, remote: false },
  'patch-applied-response-lost': { patch: 1, quarantined: true, remote: true },
  'patch-applied-readback-503': { patch: 1, quarantined: true, remote: true },
  'patch-success-verified': { patch: 1, quarantined: false, remote: true },
  'patch-success-read-get-retry': { patch: 1, quarantined: false, remote: true },
});

test('M85 all twelve REAL adapter + import-fence in-memory fault cases pass without any external network/DB', async () => {
  const r = await runVaultSyntheticProviderFaultMatrix();
  assert.equal(r.format, 'oge-vault-provider-fault-matrix-offline');
  assert.equal(r.version, 1);
  assert.equal(r.status,
    'TWELVE_SYNTHETIC_SCENARIOS_VERIFIED_REAL_PROVIDER_PENDING_HOLD');
  assert.equal(r.syntheticScenarioCount, 12);
  assert.deepEqual(r.scenarios.map(s => s.scenario), Object.keys(EXPECTED));
  assert.equal(r.allSyntheticInvariantsVerified, true);
  assert.equal(r.noRealGitHubOrMongoClientsUsed, true);
  for (const sample of r.scenarios) {
    const expected = EXPECTED[sample.scenario];
    assert.equal(sample.syntheticPatchAttemptCount, expected.patch);
    assert.equal(sample.uncertainWriteQuarantineRetained, expected.quarantined);
    assert.equal(sample.syntheticRemoteRefAdvanced, expected.remote);
    assert.equal(sample.simulatedOnly, true);
    assert.equal(sample.failedWriteCanBeRetriedAutomatically, false);
    assert.equal(sample.automaticPostwriteUnlockAuthorized, false);
    assert.equal(sample.realGitHubRequestsPerformed, false);
    assert.equal(sample.realMongoRequestsPerformed, false);
    assert.equal(sample.durableMarkerRecordedBeforePatch,
      expected.patch !== 0);
    assert.equal(sample.syntheticSafePrewriteFenceReleased,
      sample.scenario === 'prewrite-owner-rejected');
    const verified = ['patch-success-verified',
      'patch-success-read-get-retry'].includes(sample.scenario);
    assert.equal(sample.syntheticVerifiedSuccessFenceReleased, verified);
    assert.equal(sample.expectedSuccessVerificationObserved, verified);
  }
  const unknown = r.scenarios.find(s =>
    s.scenario === 'patch-applied-response-lost');
  assert.equal(unknown.syntheticRemoteRefAdvanced, true);
  assert.equal(unknown.uncertainWriteQuarantineRetained, true);
  assert.equal(unknown.syntheticPatchAttemptCount, 1);
  const after = r.scenarios.find(s =>
    s.scenario === 'patch-applied-readback-503');
  assert.equal(after.syntheticReadbackAttempts, 2);
  assert.equal(after.uncertainWriteQuarantineRetained, true);
  const readRetry = r.scenarios.find(s =>
    s.scenario === 'patch-success-read-get-retry');
  assert.equal(readRetry.syntheticReadbackAttempts, 2);
  assert.equal(readRetry.syntheticPatchAttemptCount, 1);
  assert.equal(readRetry.uncertainWriteQuarantineRetained, false);
  for (const name of [
    'real403429409422ScenariosExecuted',
    'realOAuthOrAppRevocationTested',
    'actualLostGitHubAcknowledgmentInduced',
    'independentlyEstablishedWorkerQuiescence',
    'signedTwoPhysicalDeviceAcceptanceComplete',
    'safeToRetryAutomatically',
    'operatorUnlockAuthorized',
    'automaticUnlockAuthorized',
    'productionReady',
    'canEnableProduction',
    'canReleaseImportLock',
    'externalWritesPerformed',
  ]) assert.equal(r[name], false, name);
  const output = JSON.stringify(r);
  for (const secret of ['m85-in-memory-only',
    'synthetic-m85-no-real-user', 'Restore OgeNotes backup'])
    assert.equal(output.includes(secret), false);
});

test('M85 default-OFF command blocks without opt-in, synthetic-only pass returns HOLD=2', () => {
  const cmd = new URL(
    '../scripts/check-vault-provider-fault-matrix-offline.mjs',
    import.meta.url).pathname;
  const base = {
    PATH: process.env.PATH,
    MONGODB_DB: 'oge_vault_restore_staging_faultmatrix',
    OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
    OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
    OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
    OGE_ACCOUNT_DELETION_ENABLED: 'false',
    OGE_VAULT_ACCOUNT_DELETION_INTERNAL: 'false',
  };
  const run = (changes) => spawnSync(process.execPath, [cmd], {
    env: { ...base, ...changes }, encoding: 'utf8', timeout: 20000,
  });
  const off = run({});
  assert.equal(off.status, 1);
  assert.equal(off.stdout, '');
  assert.match(off.stderr, /BLOCKED/);
  const good = run({
    OGE_VAULT_OFFLINE_PROVIDER_FAULT_MATRIX:
      'YES_TWELVE_SYNTHETIC_NO_NETWORK_SCENARIOS_ONLY',
  });
  assert.equal(good.status, 2, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.syntheticScenarioCount, 12);
  assert.equal(report.noRealGitHubOrMongoClientsUsed, true);
  assert.equal(report.canEnableProduction, false);
  assert.equal(report.canReleaseImportLock, false);
  const denied = [
    { MONGODB_DB: 'oge_prod' },
    { OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES' },
    { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
  ];
  for (const unsafe of denied) {
    const rejected = run({
      OGE_VAULT_OFFLINE_PROVIDER_FAULT_MATRIX:
        'YES_TWELVE_SYNTHETIC_NO_NETWORK_SCENARIOS_ONLY',
      ...unsafe,
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
  }
});

test('M85 simulation imports REAL adapter and durable import-fence with only injected local GitHub and MongoDB transports', async () => {
  const adapter = await readFile(new URL(
    '../lib/oge-vault-provider-fault-matrix-offline.js',
    import.meta.url), 'utf8');
  const cli = await readFile(new URL(
    '../scripts/check-vault-provider-fault-matrix-offline.mjs',
    import.meta.url), 'utf8');
  assert.match(adapter, /vaultGithubRequest\(/);
  assert.match(adapter, /withVaultOwnerImportExclusive\(/);
  assert.match(adapter, /withVaultOwnerDraftWrite\(/);
  assert.match(adapter, /fetcher: github\.injectedFetcher/);
  assert.match(adapter, /method: 'PATCH'/);
  assert.match(adapter, /force: false/);
  assert.match(adapter, /durable-marker/);
  assert.match(adapter, /patch-applied-response-lost/);
  assert.match(adapter, /vault-import-write-outcome-unconfirmed-lock-retained/);
  assert.match(cli, /OGE_VAULT_OFFLINE_PROVIDER_FAULT_MATRIX/);
  assert.match(cli, /process\.exitCode = 2/);
  assert.doesNotMatch(adapter + cli,
    /(?:await\s+)?fetch\(|https?\.request|MongoClient\\b|connectToDatabase|getVaultNoteClient|githubAppJwt|process\.env\.GITHUB_TOKEN/);
});
