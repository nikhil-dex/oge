import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp, mkdir, writeFile, chmod, rm, symlink, readFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyVaultTwoDeviceEvidenceArtifacts,
} from '../lib/oge-vault-two-device-artifact-verification.js';
import {
  VAULT_TWO_DEVICE_SCENARIO_IDS,
} from '../lib/oge-vault-two-device-evidence.js';

const ORIGIN = 'https://staging.oge.example';
const A = new Set([
  'oauth-device-a', 'encrypted-backup-reopen',
  'physical-file-download-check',
]);
const B = new Set(['oauth-device-b', 'second-device-autosave-fence']);
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function makeFiles(base, { partial = false, mismatch = false } = {}) {
  const metaDir = join(base, 'manifest');
  const artifactsDirectory = join(base, 'artifacts');
  await mkdir(metaDir, { mode: 0o700 });
  await mkdir(artifactsDirectory, { mode: 0o700 });
  const manifestFile = join(metaDir, 'redacted-evidence.json');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const timestamp = new Date(Date.now() - 30_000).toISOString();
  const markerA = randomUUID(), markerB = randomUUID();
  const cases = partial ? VAULT_TWO_DEVICE_SCENARIO_IDS.slice(0, 3)
    : VAULT_TWO_DEVICE_SCENARIO_IDS;
  const records = [];
  for (const scenario of cases) {
    const artifact = 'Synthetic external review artifact for ' + scenario;
    await writeFile(join(artifactsDirectory,
      scenario + '.redacted.txt'), artifact, { mode: 0o600 });
    records.push({
      scenario, channel: A.has(scenario) ? 'device-a' :
        B.has(scenario) ? 'device-b' : 'operator',
      observedAt: timestamp, outcome: 'observed-pass',
      evidenceSha256: sha(artifact + (mismatch && scenario === cases[0] ? 'X' : '')),
      sessionMarker: A.has(scenario) ? markerA : B.has(scenario) ? markerB : null,
    });
  }
  const manifest = {
    format: 'oge-vault-two-device-external-evidence',
    version: 1, runId: randomUUID(), origin: ORIGIN, startedAt, records,
  };
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  return { metaDir, artifactsDirectory, manifestFile, manifest };
}
async function withFiles(fn, options) {
  const dir = await mkdtemp(join(tmpdir(), 'oge-m68-offline-'));
  try { return await fn(await makeFiles(dir, options), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const check = (f) => verifyVaultTwoDeviceEvidenceArtifacts({
  manifestFile: f.manifestFile, artifactsDirectory: f.artifactsDirectory,
  expectedOrigin: ORIGIN,
});

test('M68 verifies all 12 real local file SHA-256 bytes but NEVER claims external evidence authenticity', async () =>
  withFiles(async (f) => {
    const report = await check(f);
    assert.equal(report.status, 'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED');
    assert.equal(report.matchedArtifactCount, 12);
    assert.equal(report.onDiskArtifactHashesRecomputed, true);
    for (const field of [
      'artifactContentsTruthVerified',
      'artifactRedactionIndependentlyVerified',
      'sourceCaptureProvenanceVerified',
      'physicalDevicesIndependentlyVerified',
      'realGitHubProviderIndependentlyVerified',
      'externalOperatorAttestationVerified',
      'completeStagingAcceptanceSignedOff',
      'canAuthorizeGitHubWrites',
      'canEnableProduction',
      'canReleaseImportLock',
      'canRetryUnknownWrite',
      'privateArtifactBytesReturned',
    ]) assert.equal(report[field], false, field);
    assert.equal(report.noDatabaseOrGitHubRequestsPerformed, true);
    const text = JSON.stringify(report);
    assert.equal(text.includes(f.manifest.runId), false);
    assert.equal(text.includes('Synthetic external review artifact'), false);
    assert.equal(text.includes(f.manifest.records[0].evidenceSha256), false);
    assert.equal(text.includes(ORIGIN), false);
  }));

test('M68 reports incomplete evidence index without promoting release authority', async () =>
  withFiles(async (f) => {
    const x = await check(f);
    assert.equal(x.status, 'ON_DISK_HASHES_MATCH_INCOMPLETE_EVIDENCE_INDEX');
    assert.equal(x.matchedArtifactCount, 3);
    assert.equal(x.missingScenarios.length, 9);
    assert.equal(x.completeStagingAcceptanceSignedOff, false);
  }, { partial: true }));

test('M68 rejects a wrong hash or modified file even with valid metadata', async () => {
  await withFiles(async (f) => {
    await assert.rejects(check(f), TypeError);
  }, { mismatch: true });
  await withFiles(async (f) => {
    const path = join(f.artifactsDirectory,
      'oauth-device-a.redacted.txt');
    await writeFile(path, 'changed redacted capture that should fail hash');
    await assert.rejects(check(f), TypeError);
  });
});

test('M68 rejects missing or extra files, symlink file, public mode and oversized artifact', async () => {
  await withFiles(async (f) => {
    const name = join(f.artifactsDirectory, 'oauth-device-a.redacted.txt');
    await rm(name);
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    await writeFile(join(f.artifactsDirectory, 'extra.redacted.txt'),
      'Unrequested stray artifact', { mode: 0o600 });
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    const name = join(f.artifactsDirectory, 'oauth-device-a.redacted.txt');
    const destination = join(f.metaDir, 'redirect.txt');
    await writeFile(destination, 'unsafe target', { mode: 0o600 });
    await rm(name);
    await symlink(destination, name);
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    await chmod(join(f.artifactsDirectory,
      'oauth-device-a.redacted.txt'), 0o644);
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    await writeFile(join(f.artifactsDirectory,
      'oauth-device-a.redacted.txt'), 'z'.repeat(129 * 1024));
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    await chmod(f.artifactsDirectory, 0o755);
    await assert.rejects(check(f), TypeError);
  });
  await withFiles(async (f) => {
    await chmod(f.manifestFile, 0o644);
    await assert.rejects(check(f), TypeError);
  });
});

test('M68 CLI is default OFF, rejects production/origin, hashes private files only when explicitly enabled', async () =>
  withFiles(async (f) => {
    const cli = new URL('../scripts/verify-vault-two-device-artifacts.mjs',
      import.meta.url).pathname;
    const env = {
      ...process.env,
      OGE_STAGING_URL: ORIGIN,
      MONGODB_DB: 'oge_vault_restore_staging_test',
      OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE: f.manifestFile,
      OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY: f.artifactsDirectory,
      OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW:
        'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY',
      OGE_ACCOUNT_DELETION_ENABLED: 'false',
      OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
      TEST_PRIVATE_TOKEN: 'PRIVATE_M68_DO_NOT_PRINT',
    };
    const run = (extra = {}) => spawnSync(process.execPath, [cli], {
      env: { ...env, ...extra }, encoding: 'utf8', timeout: 7000,
    });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).onDiskArtifactHashesRecomputed, true);
    assert.equal(ok.stdout.includes(env.TEST_PRIVATE_TOKEN), false);
    for (const extra of [
      { OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW: '' },
      { MONGODB_DB: 'oge_notes' },
      { OGE_STAGING_URL: 'https://oge.example' },
      { OGE_STAGING_URL: 'http://staging.oge.example' },
      { OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY: 'relative' },
      { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
    ]) {
      const denied = run(extra);
      assert.equal(denied.status, 1);
      assert.equal(denied.stdout, '');
      assert.match(denied.stderr, /BLOCKED/);
    }
    await writeFile(join(f.artifactsDirectory,
      'oauth-device-a.redacted.txt'), 'modified evidence bytes');
    const blocked = run();
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stdout, '');
    assert.equal(blocked.stderr.includes(env.TEST_PRIVATE_TOKEN), false);
  }));

test('M68 no network, DB, Note-content persistence, secret printing or production authorization', async () => {
  const code = await readFile(new URL(
    '../lib/oge-vault-two-device-artifact-verification.js', import.meta.url),
    'utf8');
  const cli = await readFile(new URL(
    '../scripts/verify-vault-two-device-artifacts.mjs', import.meta.url),
    'utf8');
  assert.match(code, /timingSafeEqual/);
  assert.match(code, /O_NOFOLLOW/);
  assert.match(code, /completeStagingAcceptanceSignedOff: false/);
  assert.doesNotMatch(code + cli,
    /MongoClient|getVaultNoteClient|fetch\(|writeFile\(|createWriteStream|localStorage|sessionStorage|\.insertOne\(|\.updateOne\(|commitVaultNoteBatch\(/);
});
