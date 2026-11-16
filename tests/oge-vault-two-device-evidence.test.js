import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp, writeFile, chmod, rm, symlink, readFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectVaultTwoDeviceEvidenceManifest,
  VAULT_TWO_DEVICE_SCENARIO_IDS,
} from '../lib/oge-vault-two-device-evidence.js';

const ORIGIN = 'https://staging.oge.example';
const fdA = new Set([
  'oauth-device-a', 'encrypted-backup-reopen',
  'physical-file-download-check',
]);
const fdB = new Set([
  'oauth-device-b', 'second-device-autosave-fence',
]);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = Date.parse('2026-11-16T17:00:00.000Z');
function fixture() {
  const startedAt = new Date(now - 60_000).toISOString();
  const a = randomUUID(), b = randomUUID();
  return {
    format: 'oge-vault-two-device-external-evidence', version: 1,
    runId: randomUUID(), origin: ORIGIN, startedAt,
    records: VAULT_TWO_DEVICE_SCENARIO_IDS.map((scenario) => ({
      scenario,
      channel: fdA.has(scenario) ? 'device-a'
        : fdB.has(scenario) ? 'device-b' : 'operator',
      observedAt: new Date(now - 30_000).toISOString(),
      outcome: 'observed-pass',
      evidenceSha256: sha256('synthetic-external-file-' + scenario),
      sessionMarker: fdA.has(scenario) ? a : fdB.has(scenario) ? b : null,
    })),
  };
}
const inspect = (m) => inspectVaultTwoDeviceEvidenceManifest(m, {
  expectedOrigin: ORIGIN, now,
});

test('M67 complete referenced scenarios produce inventory ONLY, never two-device/live-provider signoff', () => {
  const result = inspect(fixture());
  assert.equal(result.status, 'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW');
  assert.equal(result.observedScenarioCount, 12);
  assert.deepEqual(result.missingScenarios, []);
  assert.equal(result.differentSessionMarkersReported, true);
  for (const key of [
    'evidenceHashesIndependentlyChecked',
    'physicalDevicesIndependentlyVerified',
    'realGitHubProviderIndependentlyVerified',
    'externalOperatorAttestationVerified',
    'completeStagingAcceptanceSignedOff',
    'canAuthorizeGitHubWrites',
    'canEnableProduction',
    'canReleaseImportLock',
    'canRetryUnknownWrite',
    'privacySensitiveValuesReturned',
  ]) assert.equal(result[key], false, key);
  assert.equal(result.noDatabaseOrGitHubRequestsPerformed, true);
  const reportText = JSON.stringify(result);
  const original = fixture();
  assert.equal(reportText.includes(original.origin), false);
  assert.equal(reportText.includes('githubAccountId'), false);
  assert.equal(reportText.includes('sessionMarker'), false);
});

test('M67 incomplete or explicitly failed scenarios cannot be described as live acceptance', () => {
  const missing = fixture();
  missing.records.splice(2);
  const x = inspect(missing);
  assert.equal(x.status, 'EVIDENCE_INCOMPLETE_OR_FAILED');
  assert.equal(x.observedScenarioCount, 2);
  assert.equal(x.completeStagingAcceptanceSignedOff, false);
  assert.equal(x.missingScenarios.length, 10);
  const failed = fixture();
  failed.records[3].outcome = 'observed-fail';
  const y = inspect(failed);
  assert.equal(y.status, 'EVIDENCE_INCOMPLETE_OR_FAILED');
  assert.deepEqual(y.reportedFailedScenarios, [failed.records[3].scenario]);
});

test('M67 refuses synthetic schema tampering, identifiers, duplicate hash and incompatible session evidence', () => {
  const mutations = [
    (m) => { m.secret = 'do-not-accept'; },
    (m) => { m.records[0].githubToken = 'do-not-accept'; },
    (m) => { m.records[0].outcome = 'verified-live'; },
    (m) => { m.records[0].scenario = 'unrecognized'; },
    (m) => { m.records[0].channel = 'operator'; },
    (m) => { m.records.push({ ...m.records[0] }); },
    (m) => { m.records[1].evidenceSha256 = m.records[0].evidenceSha256; },
    (m) => { m.records[2].sessionMarker = randomUUID(); },
    (m) => { m.records[1].sessionMarker = m.records[0].sessionMarker; },
    (m) => { m.records[10].sessionMarker = randomUUID(); },
    (m) => { m.runId = 'not-a-uuid'; },
    (m) => { m.origin = 'http://staging.oge.example'; },
    (m) => { m.origin = 'https://oge.example'; },
    (m) => { m.startedAt = '2025-01-01T00:00:00.000Z'; },
    (m) => { m.records[0].observedAt = '2027-01-01T00:00:00.000Z'; },
    (m) => { m.records[0].observedAt = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => inspect(value), TypeError);
  }
});

test('M67 read-only operator CLI requires isolated staging and a private 0600 evidence file', async () => {
  const cli = new URL('../scripts/review-vault-two-device-evidence.mjs',
    import.meta.url).pathname;
  const folder = await mkdtemp(join(tmpdir(), 'oge-m67-evidence-'));
  const path = join(folder, 'external-evidence.json');
  const env = {
    ...process.env,
    OGE_STAGING_URL: ORIGIN,
    MONGODB_DB: 'oge_vault_restore_staging_ci',
    OGE_VAULT_TWO_DEVICE_EVIDENCE_REVIEW:
      'YES_REDACTED_EXTERNAL_EVIDENCE_ONLY',
    OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE: path,
    OGE_ACCOUNT_DELETION_ENABLED: 'false',
    OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
    TEST_SECRET_NOT_TO_LOG: 'SENSITIVE_DO_NOT_PRINT_M67',
  };
  const run = (overrides) => spawnSync(process.execPath, [cli], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 8000,
  });
  try {
    await chmod(folder, 0o700);
    await writeFile(path, JSON.stringify(fixture()), { mode: 0o600 });
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    const report = JSON.parse(good.stdout);
    assert.equal(report.completeStagingAcceptanceSignedOff, false);
    assert.equal(report.canEnableProduction, false);
    assert.equal(report.status, 'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW');
    assert.equal(good.stdout.includes(env.TEST_SECRET_NOT_TO_LOG), false);
    for (const overrides of [
      { OGE_VAULT_TWO_DEVICE_EVIDENCE_REVIEW: '' },
      { MONGODB_DB: 'oge_notes' },
      { OGE_STAGING_URL: 'https://oge.example' },
      { OGE_STAGING_URL: 'http://staging.oge.example' },
      { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
    ]) {
      const bad = run(overrides);
      assert.equal(bad.status, 1);
      assert.equal(bad.stdout, '');
      assert.match(bad.stderr, /BLOCKED:/);
    }
    await chmod(path, 0o644);
    assert.equal(run().status, 2);
    await chmod(path, 0o600);
    const partial = fixture();
    partial.records.pop();
    await writeFile(path, JSON.stringify(partial));
    const incomplete = run();
    assert.equal(incomplete.status, 3);
    assert.equal(JSON.parse(incomplete.stdout).completeStagingAcceptanceSignedOff,
      false);
    await rm(path);
    const target = join(folder, 'actual-evidence.json');
    await writeFile(target, JSON.stringify(fixture()), { mode: 0o600 });
    await symlink(target, path);
    const link = run();
    assert.equal(link.status, 2);
    assert.equal(link.stdout, '');
    assert.equal(link.stderr.includes(env.TEST_SECRET_NOT_TO_LOG), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('M67 manifest tooling does not connect, upload, write Notes or forge external acceptance', async () => {
  const lib = await readFile(new URL(
    '../lib/oge-vault-two-device-evidence.js', import.meta.url), 'utf8');
  const cli = await readFile(new URL(
    '../scripts/review-vault-two-device-evidence.mjs', import.meta.url), 'utf8');
  assert.match(lib, /completeStagingAcceptanceSignedOff: false/);
  assert.match(lib, /physicalDevicesIndependentlyVerified: false/);
  assert.match(cli, /O_NOFOLLOW/);
  assert.doesNotMatch(lib + cli,
    /MongoClient|getVaultNoteClient|fetch\(|commitVaultNoteBatch|updateOne\(|insertOne\(|deleteOne\(|writeFile\(|localStorage|sessionStorage/);
});
