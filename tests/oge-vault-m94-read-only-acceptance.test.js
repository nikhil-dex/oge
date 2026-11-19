import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  inspectSignedDeviceAcceptanceReadOnly,
} from '../lib/oge-vault-signed-device-acceptance.js';
import {
  compareVaultHistoricalResourceSourceClaim,
} from '../lib/oge-vault-historical-resource-source-verify.js';
import {
  compareVaultCurrentResourceSourceClaim,
} from '../lib/oge-vault-current-resource-source-verify.js';
import {
  checkVaultM94ReadOnlyAcceptanceGuard,
  executeVaultM94ReadOnlyAcceptance,
} from '../lib/oge-vault-m94-read-only-acceptance.js';

const sha1 = text => createHash('sha1').update(text).digest('hex');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const origin = 'https://vault-staging.example.test';
const uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const subject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = '2026-11-17T00:00:00.000Z';
const runId = 'c9868d1a-0d20-4de6-befe-3494b7a2fba5';
const env = {
  OGE_VAULT_M94_READ_ONLY_ACCEPTANCE:
    'YES_SIGNED_DISPOSABLE_READS_NO_WRITES',
  OGE_VAULT_M94_OPERATOR_ACK: 'NO_REAL_USER_NOTES_OR_GITHUB_WRITES',
  OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL:
    'YES_TWO_PRIVATE_STAGING_SESSIONS_READ_ONLY',
  OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'true',
  OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID: runId,
  OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW: 'true',
  OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW: 'true',
  OGE_VAULT_RESTORE_SOURCE_PREVIEW: 'true',
  OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW: 'true',
  OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'true',
  OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW: 'true',
  OGE_VAULT_BACKUP_EXPORT_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_PREVIEW: 'true',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_NOTE_API_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
  OGE_STAGING_URL: origin, AUTH_URL: origin,
  OGE_VAULT_BASE_URL: origin,
  MONGODB_DB: 'oge_vault_restore_staging_m94',
};
const ready = () => ({ ok: true });
const coverage = {
  notes: 'complete-current-github-head',
  quickNotes: 'complete-current-github-head',
  airNotes: 'complete-current-github-head',
  historicalRevisions: 'not-included',
  encryptedDrafts: 'not-included',
  legacyMongoNotes: 'not-included',
  learningProgress: 'not-included',
};
function archive(body, version) {
  const n = {
    ...validatedNote({
      subjectId: subject, heading: 'Sensitive heading',
      answer: body, tags: ['study'], favorite: false,
    }, { id: uuid, now }),
    sha: sha1(uuid + ':' + body),
  };
  const a = {
    format: 'oge-vault-current-resources-backup', version: 1,
    scope: 'current-github-notes-quick-notes-airnotes-only',
    snapshot: sha1('snapshot-' + version),
    treeSha: sha1('tree-' + version),
    totalNotes: 1, totalQuickNotes: 0, totalAirNotes: 0,
    coverage: { ...coverage },
    notes: [n], quickNotes: [], airNotes: [],
    importable: false, completeAccountBackup: false,
  };
  a.inventorySha256 = sha256(
    'oge-vault-current-resource-index-v1\nnotes/' +
      uuid + '.json:' + n.sha + '\n');
  a.archiveSha256 = sha256(JSON.stringify(a));
  return a;
}
const old = archive('private earlier research', 'historical');
const current = archive('private new research', 'current');
function file(a) {
  const bytes = new TextEncoder().encode(JSON.stringify(a));
  return {
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
async function signedObservation(slot, challenge) {
  const vault = {
    status: 'connected', repoName: 'ogenotes-vault',
    repoId: 417, installationId: 912,
    githubAccountId: '1002', githubLogin: 'm94-synthetic',
  };
  const client = () => ({
    branch: 'main', readOnly: true, vault: { ...vault },
    async call(path, options = {}) {
      assert.equal(options.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main') {
        return { object: { sha: sha1('head') } };
      }
      if (path === '/git/commits/' + sha1('head')) {
        return { tree: { sha: sha1('tree') } };
      }
      throw new Error('Unexpected mock provider call');
    },
  });
  return inspectSignedDeviceAcceptanceReadOnly(
    client(), client(), {
      ownerVerifier: async () => true, challenge, deviceSlot: slot,
    });
}
function mockDeps({
  currentError = 0, forgedUnlock = false,
  signedError = false,
} = {}) {
  const calls = [];
  let currentReads = 0;
  let nonce = 0;
  return {
    calls,
    nonceSource: () => Buffer.alloc(32, ++nonce),
    invokeSignedRead: async (slot, challenge) => {
      calls.push('signed:' + slot);
      if (signedError) {
        return { status: 403, contentType: 'application/json', json: {} };
      }
      return {
        status: 200, contentType: 'application/json',
        json: await signedObservation(slot, challenge),
      };
    },
    invokeSourceRead: async (url, options) => {
      calls.push(url.endsWith('history-check') ? 'history' : 'current');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      for (const secret of [
        'private earlier', 'private new', uuid,
        subject, 'Sensitive heading',
      ]) assert.equal(options.body.includes(secret), false);
      if (url.endsWith('history-check')) {
        return Response.json(compareVaultHistoricalResourceSourceClaim(
          JSON.parse(options.body), old));
      }
      currentReads++;
      if (currentError === currentReads) {
        return Response.json({ error: 'synthetic denied' }, { status: 429 });
      }
      const report = compareVaultCurrentResourceSourceClaim(
        JSON.parse(options.body), current);
      return Response.json(forgedUnlock && currentReads === 2
        ? { ...report, canReleaseImportLock: true } : report);
    },
  };
}
async function run(deps, changes = {}) {
  return executeVaultM94ReadOnlyAcceptance({
    env: { ...env, ...changes },
    backupFile: file(old), referenceFile: file(current),
    subtle: webcrypto.subtle, readiness: ready, ...deps,
  });
}

test('M94 exactly two signed session observations + one history and two current reads, no PII or authorization', async () => {
  const deps = mockDeps();
  const result = await run(deps);
  assert.deepEqual(deps.calls, [
    'signed:device-a', 'signed:device-b',
    'history', 'current', 'current',
  ]);
  assert.equal(result.status,
    'SIGNED_SESSIONS_AND_READ_ONLY_PROVIDER_CHECKS_OBSERVED_HOLD');
  assert.equal(result.signedSessionReadObservations, 2);
  assert.equal(result.boundedHistoricalSourceChecks, 1);
  assert.equal(result.currentSourceChecks, 2);
  for (const key of [
    'twoPhysicalDevicesIndependentlyVerified',
    'oauthProviderIssuerIndependentlyVerified',
    'actualOAuthLoginPerformedByRunner',
    'realProviderFaultMatrixCompleted',
    'operatorStagingSignoffComplete',
    'canEnableProduction',
    'productionReady','githubWritesPerformed','restorationAuthorized',
    'canReleaseImportLock','canRetryUnknownWrite',
    'privateArchiveBodiesUploaded',
  ]) assert.equal(result[key], false, key);
  for (const secret of [
    uuid, subject, 'private earlier', 'private new',
    old.snapshot, current.snapshot, old.archiveSha256, runId, origin,
  ]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('M94 guard rejects unapproved origins, release/write flags or missing staging read opt-ins', () => {
  assert.equal(checkVaultM94ReadOnlyAcceptanceGuard({}, ready), false);
  assert.equal(checkVaultM94ReadOnlyAcceptanceGuard(env, ready), true);
  const changed = [
    { OGE_VAULT_M94_READ_ONLY_ACCEPTANCE: 'YES' },
    { OGE_VAULT_M94_OPERATOR_ACK: 'YES' },
    { OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL: 'false' },
    { OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW: 'false' },
    { OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW: 'false' },
    { OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RESTORE_SOURCE_PREVIEW: 'false' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES' },
    { OGE_VAULT_CHUNK_RESTORE_WRITE_ACK: 'YES' },
    { MONGODB_DB: 'oge_prod' },
    { OGE_STAGING_URL: 'https://production.example.com' },
  ];
  for (const unsafe of changed) {
    assert.equal(checkVaultM94ReadOnlyAcceptanceGuard({
      ...env, ...unsafe,
    }, ready), false, JSON.stringify(unsafe));
  }
});

test('M94 local file corruption blocks ALL signed and source requests', async () => {
  const tampered = JSON.parse(JSON.stringify(current));
  tampered.notes[0].answer = 'not backed by SHA256';
  const deps = mockDeps();
  await assert.rejects(executeVaultM94ReadOnlyAcceptance({
    env, backupFile: file(old), referenceFile: file(tampered),
    subtle: webcrypto.subtle, readiness: ready, ...deps,
  }), TypeError);
  assert.deepEqual(deps.calls, []);
});

test('M94 fails closed without retries on invalid signed session, provider 429, or forged release permission', async () => {
  for (const change of [
    { signedError: true },
    { currentError: 1 },
    { currentError: 2 },
    { forgedUnlock: true },
  ]) {
    const deps = mockDeps(change);
    await assert.rejects(run(deps), TypeError);
    assert.equal(deps.calls.filter(x => x === 'history').length <= 1, true);
    assert.equal(deps.calls.filter(x => x === 'current').length <= 2, true);
  }
});

test('M94 operator runner blocked by default, has private file guards, no restore or GitHub writer', async () => {
  const [cli, core, envExample] = await Promise.all([
    readFile(new URL('../scripts/run-vault-m94-readonly-acceptance.mjs',
      import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-m94-read-only-acceptance.js',
      import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  assert.match(cli, /constants\.O_NOFOLLOW/);
  assert.match(cli, /owned\(before\)/);
  assert.match(cli, /fingerprint === stateB\.fingerprint/);
  assert.match(cli, /maxRedirects: 0/);
  assert.match(cli, /failOnStatusCode: false/);
  assert.match(cli, /process\.exitCode = 2/);
  assert.match(core, /canEnableProduction: false/);
  assert.match(core, /twoPhysicalDevicesIndependentlyVerified: false/);
  assert.match(envExample, /OGE_VAULT_M94_READ_ONLY_ACCEPTANCE=/);
  assert.doesNotMatch(cli + core,
    /method:\s*['"]PATCH['"]|commitVaultNoteBatch\(|insertOne\(|deleteOne\(/);
  const check = spawnSync(process.execPath, [
    new URL('../scripts/run-vault-m94-readonly-acceptance.mjs',
      import.meta.url).pathname,
  ], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(check.status, 1);
  assert.equal(check.stdout, '');
  assert.match(check.stderr, /BLOCKED:/);
});
