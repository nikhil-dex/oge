import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, chmod, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectSignedDeviceAcceptanceReadOnly } from '../lib/oge-vault-signed-device-acceptance.js';
import {
  inspectVaultSignedTwoDeviceAcceptancePair,
} from '../lib/oge-vault-two-device-acceptance-readiness.js';
import {
  verifyVaultTwoDeviceEvidenceArtifacts,
} from '../lib/oge-vault-two-device-artifact-verification.js';
import {
  VAULT_TWO_DEVICE_SCENARIO_IDS,
} from '../lib/oge-vault-two-device-evidence.js';

const ORIGIN = 'https://vault-staging.example.test';
const HEAD = createHash('sha1').update('m83-head').digest('hex');
const TREE = createHash('sha1').update('m83-tree').digest('hex');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const CHALLENGE_A = 'a'.repeat(64), CHALLENGE_B = 'b'.repeat(64);
const CLI = new URL('../scripts/review-vault-signed-two-device-acceptance.mjs', import.meta.url).pathname;
const A = new Set(['oauth-device-a', 'encrypted-backup-reopen', 'physical-file-download-check']);
const B = new Set(['oauth-device-b', 'second-device-autosave-fence']);

async function observation(slot, challenge) {
  const vault = {
    status: 'connected', repoName: 'ogenotes-vault',
    repoId: 911, installationId: 1987,
    githubAccountId: '201', githubLogin: 'staging-m83',
  };
  const make = () => ({
    readOnly: true, branch: 'main', vault: { ...vault },
    call: async (path, options = {}) => {
      assert.equal(options.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main') return { object: { sha: HEAD } };
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      throw new Error('Unexpected synthetic provider read');
    },
  });
  return inspectSignedDeviceAcceptanceReadOnly(make(), make(), {
    ownerVerifier: async () => true, challenge, deviceSlot: slot,
  });
}

async function makeEvidence({ incomplete = false, failed = false } = {}) {
  const at = new Date(Date.now() - 120000).toISOString();
  const timestamp = new Date(Date.now() - 60000).toISOString();
  const idA = randomUUID(), idB = randomUUID(), runId = randomUUID();
  const records = VAULT_TWO_DEVICE_SCENARIO_IDS
    .slice(0, incomplete ? 5 : undefined).map(scenario => ({
      scenario,
      channel: A.has(scenario) ? 'device-a' :
        B.has(scenario) ? 'device-b' : 'operator',
      observedAt: timestamp, outcome: failed && scenario === 'oauth-device-b'
        ? 'observed-fail' : 'observed-pass',
      sessionMarker: A.has(scenario) ? idA : B.has(scenario) ? idB : null,
      evidenceSha256: sha('synthetic evidence bytes ' + scenario),
    }));
  const manifest = {
    format: 'oge-vault-two-device-external-evidence',
    version: 1, runId, origin: ORIGIN, startedAt: at, records,
  };
  const pair = {
    format: 'oge-vault-signed-device-acceptance-pair',
    version: 1, runId, origin: ORIGIN,
    observations: {
      'device-a': await observation('device-a', CHALLENGE_A),
      'device-b': await observation('device-b', CHALLENGE_B),
    },
  };
  const params = {
    expectedOrigin: ORIGIN, expectedRunId: runId,
    deviceAChallenge: CHALLENGE_A, deviceBChallenge: CHALLENGE_B,
    artifactHashesVerified: true,
  };
  return { manifest, pair, params };
}

test('M83 authentic M82 report-shape + M67 all 12 cases yields indexed readiness only, NO real signoff', async () => {
  const f = await makeEvidence();
  const report = inspectVaultSignedTwoDeviceAcceptancePair(
    f.manifest, f.pair, f.params);
  assert.equal(report.status,
    'PAIRED_OBSERVATIONS_AND_HASHED_MATRIX_READY_FOR_MANUAL_REVIEW_HOLD');
  assert.equal(report.pairedBrowserObservationCount, 2);
  assert.equal(report.observedScenarioCount, 12);
  assert.equal(report.requiredScenarioCount, 12);
  assert.equal(report.independentOperatorChallengeHashesMatched, true);
  assert.equal(report.independentChallengesDistinct, true);
  assert.equal(report.reportedSessionMarkersDistinct, true);
  assert.equal(report.bothOAuthScenarioClaimsPresent, true);
  assert.equal(report.localScenarioEvidenceArtifactHashesVerified, true);
  assert.equal(report.allScenarioClaimsPresentAndPassed, true);
  for (const field of [
    'physicalDeviceIdentityIndependentlyVerified',
    'twoAuthenticatedPhysicalDevicesIndependentlyVerified',
    'twoM82ObservationsLinkedToM67SessionMarkersByProvider',
    'actualGitHubOAuthIssuerIndependentlyVerified',
    'artifactCaptureProducerAuthenticated',
    'evidenceTruthIndependentlyVerified',
    'realProviderFaultMatrixIndependentlyVerified',
    'remoteWriteQuiescenceProven',
    'completeStagingAcceptanceSignedOff',
    'productionReady', 'canEnableProduction',
    'canAuthorizeGitHubWrites', 'canAuthorizeRestore',
    'canReleaseImportLock', 'canRetryUnknownWrite',
    'databaseOrGitHubRequestsPerformed',
    'privateArtifactBytesReturned', 'rawChallengesReturned',
    'ownerOrSessionIdsReturned', 'githubWritesPerformed',
    'mongoWritesPerformed',
  ]) assert.equal(report[field], false, field);
  const output = JSON.stringify(report);
  for (const secret of [CHALLENGE_A, CHALLENGE_B,
    f.manifest.runId, ORIGIN, HEAD, TREE,
    f.manifest.records[0].sessionMarker,
    f.pair.observations['device-a'].challengeFingerprint])
    assert.equal(output.includes(secret), false);
});

test('M83 absent or failed provider scenarios remain explicit HOLD, never false approval', async () => {
  for (const options of [{ incomplete: true }, { failed: true }]) {
    const f = await makeEvidence(options);
    const report = inspectVaultSignedTwoDeviceAcceptancePair(
      f.manifest, f.pair, f.params);
    assert.equal(report.status, 'PAIRED_OBSERVATIONS_BUT_INCOMPLETE_MATRIX_HOLD');
    assert.equal(report.allScenarioClaimsPresentAndPassed, false);
    assert.equal(report.completeStagingAcceptanceSignedOff, false);
    assert.equal(report.canEnableProduction, false);
    assert.ok(report.blockers.some(b => b.includes('failure-matrix')));
  }
});

test('M83 wrong independent challenges, swapped browser slots, mixed run, copied observation or forged positive flags reject', async () => {
  const f = await makeEvidence();
  const a = f.pair.observations['device-a'];
  const b = f.pair.observations['device-b'];
  for (const change of [
    { pair: { ...f.pair, runId: randomUUID() } },
    { params: { ...f.params, expectedRunId: randomUUID() } },
    { pair: { ...f.pair, origin: 'https://other-staging.example.test' } },
    { params: { ...f.params, deviceAChallenge: CHALLENGE_B } },
    { params: { ...f.params, deviceBChallenge: CHALLENGE_A } },
    { params: { ...f.params, deviceBChallenge: CHALLENGE_A,
      deviceAChallenge: CHALLENGE_A } },
    { params: { ...f.params, artifactHashesVerified: false } },
    { pair: { ...f.pair, observations: {
      'device-a': b, 'device-b': a,
    } } },
    { pair: { ...f.pair, observations: {
      'device-a': a, 'device-b': a,
    } } },
    { pair: { ...f.pair, observations: {
      'device-a': { ...a, physicalDeviceIdentityIndependentlyVerified: true },
      'device-b': b,
    } } },
    { pair: { ...f.pair, observations: {
      'device-a': { ...a, completeStagingAcceptanceSignedOff: true },
      'device-b': b,
    } } },
    { pair: { ...f.pair, observations: {
      'device-a': { ...a, extra: 'injected' }, 'device-b': b,
    } } },
    { pair: { ...f.pair, observations: {
      'device-a': { ...a, challengeFingerprint: 'f'.repeat(64) },
      'device-b': b,
    } } },
  ]) assert.throws(() => inspectVaultSignedTwoDeviceAcceptancePair(
    f.manifest, change.pair || f.pair,
    change.params || f.params), TypeError);
});

async function privateFiles(action, options = {}) {
  const f = await makeEvidence(options);
  const root = await mkdtemp(join(tmpdir(), 'oge-m83-'));
  const metadata = join(root, 'metadata');
  const artifactsDirectory = join(root, 'artifacts');
  const pairFile = join(metadata, 'two-observations.json');
  const manifestFile = join(metadata, 'matrix.json');
  try {
    await chmod(root, 0o700);
    await mkdir(metadata, { mode: 0o700 });
    await mkdir(artifactsDirectory, { mode: 0o700 });
    for (const record of f.manifest.records)
      await writeFile(join(artifactsDirectory,
        record.scenario + '.redacted.txt'),
      'synthetic evidence bytes ' + record.scenario,
      { mode: 0o600 });
    await writeFile(pairFile, JSON.stringify(f.pair), { mode: 0o600 });
    await writeFile(manifestFile, JSON.stringify(f.manifest), { mode: 0o600 });
    return await action({ ...f, root, metadata,
      artifactsDirectory, manifestFile, pairFile });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('M83 reuse M68 private hashes in SAME manifest read, pair report only after all on-disk SHA matches', async () => {
  await privateFiles(async f => {
    const result = await verifyVaultTwoDeviceEvidenceArtifacts({
      manifestFile: f.manifestFile,
      artifactsDirectory: f.artifactsDirectory,
      expectedOrigin: ORIGIN,
      acceptancePair: { pair: f.pair, ...f.params },
    });
    assert.equal(result.onDiskArtifactHashesRecomputed, true);
    assert.equal(result.matchedArtifactCount, 12);
    assert.equal(result.acceptanceReadiness.allScenarioClaimsPresentAndPassed, true);
    assert.equal(result.acceptanceReadiness.completeStagingAcceptanceSignedOff, false);
    await writeFile(join(f.artifactsDirectory,
      f.manifest.records[0].scenario + '.redacted.txt'),
      'tampered synthetic evidence data', { mode: 0o600 });
    await assert.rejects(verifyVaultTwoDeviceEvidenceArtifacts({
      manifestFile: f.manifestFile,
      artifactsDirectory: f.artifactsDirectory,
      expectedOrigin: ORIGIN,
      acceptancePair: { pair: f.pair, ...f.params },
    }), TypeError);
  });
});

test('M83 offline signed device pair command blocks by default, returns HOLD=2 when indexed, HOLD=3 if incomplete', async () => {
  for (const [options, expectedExit] of [[{}, 2], [{ incomplete: true }, 3]]) {
    await privateFiles(async f => {
      const base = {
        ...process.env,
        OGE_STAGING_URL: ORIGIN,
        MONGODB_DB: 'oge_vault_restore_staging_m83',
        OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
        OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: '',
        OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
        OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
        OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
        OGE_ACCOUNT_DELETION_ENABLED: 'false',
        OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW:
          'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY',
        OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE: f.manifestFile,
        OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY: f.artifactsDirectory,
        OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE: f.pairFile,
        OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: f.manifest.runId,
        OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX: CHALLENGE_A,
        OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX: CHALLENGE_B,
      };
      const run = (updates) => spawnSync(process.execPath, [CLI], {
        env: { ...base, ...updates }, encoding: 'utf8', timeout: 15000,
      });
      const blocked = run({ OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW: 'NO' });
      assert.equal(blocked.status, 1);
      assert.equal(blocked.stdout, '');
      const gate = 'YES_OFFLINE_TWO_SIGNED_DEVICE_OBSERVATIONS_AND_MATRIX_ONLY';
      const good = run({ OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW: gate });
      assert.equal(good.status, expectedExit, good.stderr);
      const report = JSON.parse(good.stdout);
      assert.equal(report.completeStagingAcceptanceSignedOff, false);
      assert.equal(report.twoAuthenticatedPhysicalDevicesIndependentlyVerified, false);
      assert.equal(report.canReleaseImportLock, false);
      assert.equal(good.stdout.includes(f.manifest.runId), false);
      assert.equal(good.stdout.includes(CHALLENGE_A), false);
      const wrong = run({
        OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW: gate,
        OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: randomUUID(),
      });
      assert.equal(wrong.status, 1);
      assert.equal(wrong.stdout, '');
    }, options);
  }
});

test('M83 privacy: owner-only acceptance pair file + no symlink and wrong GitHub commit flags enforced', async () => {
  await privateFiles(async f => {
    const base = {
      ...process.env,
      OGE_STAGING_URL: ORIGIN,
      MONGODB_DB: 'oge_vault_restore_staging_m83',
      OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW:
        'YES_OFFLINE_TWO_SIGNED_DEVICE_OBSERVATIONS_AND_MATRIX_ONLY',
      OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW:
        'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY',
      OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE: f.manifestFile,
      OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY: f.artifactsDirectory,
      OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE: f.pairFile,
      OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: f.manifest.runId,
      OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX: CHALLENGE_A,
      OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX: CHALLENGE_B,
      OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
      OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: '',
      OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
      OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
      OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
      OGE_ACCOUNT_DELETION_ENABLED: 'false',
    };
    const run = (env) => spawnSync(process.execPath, [CLI], {
      env: { ...base, ...env }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(run({
      OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true',
    }).status, 1);
    await chmod(f.pairFile, 0o644);
    assert.equal(run({}).status, 1);
    await chmod(f.pairFile, 0o600);
    await unlink(f.pairFile);
    await symlink('/dev/null', f.pairFile);
    assert.equal(run({}).status, 1);
  });
});
