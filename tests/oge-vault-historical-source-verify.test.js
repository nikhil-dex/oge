import test from 'node:test';
import { vaultRecoveryStaleRecheckAllowed } from '../lib/oge-vault-recovery-stale-guard.js';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import {
  exportVaultCurrentResourcesSnapshot,
} from '../lib/oge-vault-backup-current-resources.js';
import {
  vaultHistoricalResourceSourceCheckAllowed,
  buildVaultHistoricalResourceSourceClaim,
  assertVaultHistoricalResourceSourceClaim,
  compareVaultHistoricalResourceSourceClaim,
} from '../lib/oge-vault-historical-resource-source-verify.js';
import {
  compareVaultCurrentResourceSourceClaim,
} from '../lib/oge-vault-current-resource-source-verify.js';
import {
  previewVaultHistoricallyAuthenticatedRecoveryFiles,
} from '../lib/oge-vault-historical-restore-preview.js';

const sha1 = value => createHash('sha1').update(value).digest('hex');
const HEAD = sha1('m92-head'), HIST = sha1('m92-historical');
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDS = [
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
];
const now = '2026-11-17T00:00:00.000Z';
const snapshot = ({ body }) => {
  const n = validatedNote({
    subjectId: SUBJECT, heading: 'Private research', answer: body,
    tags: ['study'], favorite: false,
  }, { id: IDS[0], now });
  const q = validatedStandaloneCapture('quick-notes', {
    content: 'private quick note',
  }, { id: IDS[1], now });
  const a = validatedStandaloneCapture('airnotes', {
    content: 'private air capture',
  }, { id: IDS[2], now });
  return [n, q, a];
};
const gitSha = value => {
  const raw = Buffer.from(value);
  return createHash('sha1').update('blob ' + raw.length)
    .update(Buffer.from([0])).update(raw).digest('hex');
};
function fixture({ changedHead = false, merge = false,
  wrongBlob = false, brokenTree = false, ancestryLength = 1 } = {}) {
  const source = new Map();
  const trees = new Map();
  const commits = new Map();
  const shaList = [HEAD, ...Array.from({ length: ancestryLength }, (_, i) =>
    i === ancestryLength - 1 ? HIST : sha1('m92-intermediate-' + i))];
  const oldRows = snapshot({ body: 'confidential previous version' });
  const newRows = snapshot({ body: 'confidential current version' });
  for (let i = 0; i < shaList.length; i++) {
    const commitSha = shaList[i];
    const treeSha = sha1('m92-tree-' + commitSha);
    const records = i === 0 ? newRows : oldRows;
    const items = records.map((record, index) => {
      const raw = JSON.stringify(record);
      const sha = gitSha(raw);
      source.set(sha, { sha, encoding: 'base64',
        content: Buffer.from(raw).toString('base64'), size: Buffer.byteLength(raw) });
      const prefix = ['notes/', 'quick-notes/', 'airnotes/'][index];
      return { path: prefix + IDS[index] + '.json',
        sha, type: 'blob', mode: '100644', size: Buffer.byteLength(raw) };
    });
    trees.set(treeSha, { truncated: brokenTree && i === shaList.length - 1,
      tree: items });
    commits.set(commitSha, {
      tree: { sha: treeSha },
      parents: i < shaList.length - 1
        ? [ { sha: shaList[i + 1] }, ...(merge && i === 0
          ? [{ sha: sha1('other-branch') }] : []) ]
        : [],
    });
  }
  let heads = 0;
  const calls = [];
  const client = {
    readOnly: true, branch: 'main',
    async call(path, options = {}) {
      calls.push(path);
      assert.equal(options.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main') {
        heads++;
        return { object: { sha: changedHead && heads > 1
          ? sha1('changed-head') : HEAD } };
      }
      if (path.startsWith('/git/commits/')) {
        const found = commits.get(path.slice('/git/commits/'.length));
        if (!found) throw new TypeError('unknown commit');
        return found;
      }
      if (path.startsWith('/git/trees/')) {
        const found = trees.get(path.slice('/git/trees/'.length).split('?')[0]);
        if (!found) throw new TypeError('unknown tree');
        return found;
      }
      if (path.startsWith('/git/blobs/')) {
        const found = source.get(path.slice('/git/blobs/'.length));
        if (!found) throw new TypeError('unknown blob');
        return wrongBlob ? { ...found,
          content: Buffer.from('malicious replacement').toString('base64'),
          size: Buffer.byteLength('malicious replacement') } : found;
      }
      throw new TypeError('unexpected provider endpoint');
    },
  };
  return { client, calls, get heads() { return heads; },
    subjectVerifier: async ids => ids.every(id => id === SUBJECT) };
}
async function exportFixture(f, historicalSnapshot = null) {
  return exportVaultCurrentResourcesSnapshot(f.client, {
    subjectVerifier: f.subjectVerifier, historicalSnapshot,
  });
}
function file(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}
const origin = 'https://vault-staging.example.test';
const env = {
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
  OGE_STAGING_URL: origin, AUTH_URL: origin, OGE_VAULT_BASE_URL: origin,
  MONGODB_DB: 'oge_vault_restore_staging_m92',
};
const ready = () => ({ ok: true });

test('M92 authenticated private GitHub historical archive, strict SHA1 blob bytes, no private content in result', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const claim = buildVaultHistoricalResourceSourceClaim(old);
  const report = compareVaultHistoricalResourceSourceClaim(claim, old);
  assert.equal(report.historicalSourceMatchedAtCheck, true);
  assert.equal(report.immutableHistoricalArchiveAuthenticated, true);
  assert.equal(report.maxAncestorEdges, 20);
  assert.equal(report.canRestore, false);
  assert.equal(report.canReleaseImportLock, false);
  assert.equal(report.githubWritesPerformed, false);
  assert.equal(f.heads, 2);
  assert.equal(f.calls.filter(p => p.startsWith('/git/blobs/')).length, 3);
  const output = JSON.stringify(report);
  for (const secret of [SUBJECT, ...IDS, old.snapshot, old.treeSha,
    old.inventorySha256, 'confidential']) {
    assert.equal(output.includes(secret), false);
  }
});

test('M92 history must be reachable through <=20 SINGLE parent links; reject merges, bad blob SHA and unstable HEAD', async () => {
  await assert.rejects(exportFixture(fixture({ ancestryLength: 21 }), HIST));
  await exportFixture(fixture({ ancestryLength: 20 }), HIST);
  await assert.rejects(exportFixture(fixture({ merge: true }), HIST));
  await assert.rejects(exportFixture(fixture({ wrongBlob: true }), HIST));
  await assert.rejects(exportFixture(fixture({ brokenTree: true }), HIST));
  await assert.rejects(exportFixture(fixture({ changedHead: true }), HIST));
  await assert.rejects(exportFixture(fixture(), sha1('unreachable')));
  await assert.rejects(exportFixture(fixture(), 'bad'));
});

test('M92 exact historical fingerprint schema, mismatch hold and default-off staging gates', async () => {
  const old = await exportFixture(fixture(), HIST);
  const good = buildVaultHistoricalResourceSourceClaim(old);
  assert.throws(() => assertVaultHistoricalResourceSourceClaim({
    ...good, canRestore: true }));
  assert.throws(() => assertVaultHistoricalResourceSourceClaim({
    ...good, snapshot: 'bad' }));
  assert.throws(() => assertVaultHistoricalResourceSourceClaim({
    ...good, confirmation: 'RESTORE' }));
  assert.throws(() => assertVaultHistoricalResourceSourceClaim({
    ...good, totalNotes: 30001 }));
  const mismatch = compareVaultHistoricalResourceSourceClaim({
    ...good, archiveSha256: '0'.repeat(64),
  }, old);
  assert.equal(mismatch.historicalSourceMatchedAtCheck, false);
  assert.equal(mismatch.canRetryUnknownWrite, false);
  assert.equal(vaultHistoricalResourceSourceCheckAllowed({}, ready), false);
  assert.equal(vaultHistoricalResourceSourceCheckAllowed(env, ready), true);
  for (const altered of [
    { OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RESTORE_SOURCE_PREVIEW: 'false' },
    { OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'false' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { MONGODB_DB: 'oge_production' },
  ]) {
    assert.equal(vaultHistoricalResourceSourceCheckAllowed({
      ...env, ...altered,
    }, ready), false);
  }
});

test('M92 two-file browser flow: verify locally before TWO metadata-only read requests; historical + current both match', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    for (const privateValue of [...IDS, SUBJECT, 'confidential previous', 'Private research']) {
      assert.equal(options.body.includes(privateValue), false);
    }
    if (url.endsWith('/history-check')) {
      const claim = JSON.parse(options.body);
      return Response.json(compareVaultHistoricalResourceSourceClaim(claim, old));
    }
    if (url.endsWith('/source-check')) {
      const claim = JSON.parse(options.body);
      return Response.json(compareVaultCurrentResourceSourceClaim(claim, current));
    }
    throw new TypeError('unexpected URL');
  };
  const result = await previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(current), { subtle: webcrypto.subtle, fetcher });
  assert.equal(requests.length, 2);
  assert.equal(result.status,
    'BOUNDED_HISTORICAL_AND_CURRENT_SOURCES_MATCHED_READ_ONLY');
  assert.equal(result.backupSourceAuthenticated, true);
  assert.equal(result.currentSnapshotAuthenticatedAtCheck, true);
  assert.equal(result.historyAndCurrentChecksWereAtomic, false);
  assert.equal(result.totalConflict, 1);
  assert.equal(result.totalUnchanged, 2);
  assert.equal(result.canRestore, false);
  assert.equal(result.canAuthorizeImport, false);
  assert.equal(result.canReleaseImportLock, false);
  assert.equal(result.restorationAuthorized, false);
  const resultJson = JSON.stringify(result);
  for (const secret of [old.archiveSha256, current.snapshot,
    ...IDS, 'confidential', SUBJECT]) {
    assert.equal(resultJson.includes(secret), false);
  }
});

test('M92 forged or locally tampered backup never receives a positive plan', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  const changed = JSON.parse(JSON.stringify(old));
  changed.notes[0].answer = 'tampered';
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(changed), file(current), { subtle: webcrypto.subtle, fetcher }));
  await assert.rejects(previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(changed), { subtle: webcrypto.subtle, fetcher }));
  assert.equal(calls, 0);
  const forged = async (url, options) => {
    calls++;
    if (url.endsWith('/history-check')) {
      const real = compareVaultHistoricalResourceSourceClaim(
        JSON.parse(options.body), old);
      return Response.json({ ...real, canRestore: true });
    }
    throw new TypeError('should never request current');
  };
  await assert.rejects(previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(current), { subtle: webcrypto.subtle, fetcher: forged }));
  assert.equal(calls, 1);
});

test('M92 UI, route and environment source contracts deny mutation and production', async () => {
  const [route, page, ui, envfile] = await Promise.all([
    readFile(new URL('../app/api/vault/backup-current-resources/history-check/route.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/vault-restore-preview.js', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  assert.match(route, /getVaultNoteClient/);
  assert.match(route, /readOnly: true/);
  assert.match(route, /ownerMutationFilter/);
  assert.match(route, /request.headers.get\('origin'\)/);
  assert.match(route, /readLimitedBody\(request, 512\)/);
  assert.match(route, /vault_historical_resource_check/);
  assert.doesNotMatch(route, /method: ['"]PATCH['"]/);
  assert.match(page, /vaultHistoricalResourceSourceCheckAllowed/);
  assert.match(ui, /previewVaultHistoricallyAuthenticatedRecoveryFiles/);
  assert.match(envfile, /OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW=false/);
});

test('M93 independent default-OFF guard requires complete M92/91/89/87 isolated gates', () => {
  assert.equal(vaultRecoveryStaleRecheckAllowed({}, ready), false);
  assert.equal(vaultRecoveryStaleRecheckAllowed(env, ready), false);
  const complete = { ...env, OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW: 'true' };
  assert.equal(vaultRecoveryStaleRecheckAllowed(complete, ready), true);
  for (const changed of [
    { OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW: 'false' },
    { OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RESTORE_SOURCE_PREVIEW: 'false' },
    { OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'false' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { MONGODB_DB: 'oge_production' },
  ]) {
    assert.equal(vaultRecoveryStaleRecheckAllowed({
      ...complete, ...changed,
    }, ready), false, JSON.stringify(changed));
  }
});

test('M93 final read-only GitHub recheck: 3 ordered metadata-only calls, review state, NO authorization', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    for (const privateValue of [...IDS, SUBJECT, 'confidential', 'Private research']) {
      assert.equal(options.body.includes(privateValue), false);
    }
    if (url.endsWith('/history-check')) {
      return Response.json(compareVaultHistoricalResourceSourceClaim(
        JSON.parse(options.body), old));
    }
    return Response.json(compareVaultCurrentResourceSourceClaim(
      JSON.parse(options.body), current));
  };
  const result = await previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(current),
    { subtle: webcrypto.subtle, fetcher, recheckCurrent: true });
  assert.deepEqual(urls.map(u => u.endsWith('/history-check')
    ? 'history' : 'current'), ['history', 'current', 'current']);
  assert.equal(result.status, 'HISTORICAL_AND_CURRENT_RECHECK_MATCHED_READ_ONLY');
  assert.equal(result.reviewState, 'MANUAL_CONFLICT_REVIEW_REQUIRED_NO_RESTORE');
  assert.equal(result.manualReviewRequired, true);
  assert.equal(result.finalCurrentSourceRecheckPassedAtInspection, true);
  assert.equal(result.currentSourceChecksPerformed, 2);
  assert.equal(result.historyAndCurrentChecksWereAtomic, false);
  assert.equal(result.snapshotMayBecomeStaleAfterCheck, true);
  for (const key of ['recoveryApproved', 'restorationAuthorized',
    'canRestore', 'canAuthorizeImport', 'canReleaseImportLock',
    'canDeleteExisting', 'canRetryUnknownWrite', 'githubWritesPerformed',
    'fileContentsUploaded']) assert.equal(result[key], false, key);
  assert.equal(result.totalConflict, 1);
  const output = JSON.stringify(result);
  for (const secret of [SUBJECT, ...IDS, old.snapshot, old.archiveSha256,
    current.snapshot, 'confidential']) assert.equal(output.includes(secret), false);
});

test('M93 rejects stale FINAL recheck despite matching history and initial current proof', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  let currentCount = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/history-check')) {
      return Response.json(compareVaultHistoricalResourceSourceClaim(
        JSON.parse(options.body), old));
    }
    currentCount++;
    return Response.json(compareVaultCurrentResourceSourceClaim(
      JSON.parse(options.body), currentCount === 1 ? current : old));
  };
  const result = await previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(current),
    { subtle: webcrypto.subtle, fetcher, recheckCurrent: true });
  assert.equal(currentCount, 2);
  assert.equal(result.status, 'CURRENT_PRIVATE_GITHUB_RECHECK_STALE_HOLD');
  assert.equal('resources' in result, false);
  assert.equal('totalConflict' in result, false);
  assert.equal(result.canRestore, false);
  assert.equal(result.canRetryUnknownWrite, false);
});

test('M93 final provider fault and forged unlock response fail closed, without displaying counts', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  for (const fault of ['timeout', 'forged']) {
    let currentCount = 0;
    const fetcher = async (url, options) => {
      if (url.endsWith('/history-check')) {
        return Response.json(compareVaultHistoricalResourceSourceClaim(
          JSON.parse(options.body), old));
      }
      currentCount++;
      if (currentCount === 2 && fault === 'timeout') {
        throw new TypeError('simulated provider timeout');
      }
      const valid = compareVaultCurrentResourceSourceClaim(
        JSON.parse(options.body), current);
      return Response.json(currentCount === 2 && fault === 'forged'
        ? { ...valid, canReleaseImportLock: true }
        : valid);
    };
    await assert.rejects(previewVaultHistoricallyAuthenticatedRecoveryFiles(
      file(old), file(current),
      { subtle: webcrypto.subtle, fetcher, recheckCurrent: true }));
    assert.equal(currentCount, 2);
  }
});

test('M93 invalid selected files fail BEFORE network; UI and docs remain no-write', async () => {
  const f = fixture();
  const old = await exportFixture(f, HIST);
  const current = await exportFixture(f);
  const tampered = JSON.parse(JSON.stringify(current));
  tampered.notes[0].answer = 'unauthenticated edit';
  let calls = 0;
  await assert.rejects(previewVaultHistoricallyAuthenticatedRecoveryFiles(
    file(old), file(tampered), {
      subtle: webcrypto.subtle,
      fetcher: async () => { calls++; throw new Error('unexpected network'); },
      recheckCurrent: true,
    }));
  assert.equal(calls, 0);
  const [page, ui, envfile, module] = await Promise.all([
    readFile(new URL('../app/vault/recovery/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/vault-restore-preview.js', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-historical-restore-preview.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /vaultRecoveryStaleRecheckAllowed/);
  assert.match(ui, /CURRENT_PRIVATE_GITHUB_RECHECK_STALE_HOLD/);
  assert.match(ui, /guardStaleState/);
  assert.match(envfile, /OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW=false/);
  assert.doesNotMatch(module, /\.collection\(|method: ['"]PATCH['"]/);
  assert.doesNotMatch(module, /localStorage|sessionStorage/);
});
