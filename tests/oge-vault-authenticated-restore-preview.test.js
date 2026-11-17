import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  compareVaultCurrentResourceSourceClaim,
} from '../lib/oge-vault-current-resource-source-verify.js';
import {
  previewVaultAuthenticatedRecoveryFiles,
} from '../lib/oge-vault-authenticated-restore-preview.js';

const sha1 = value => createHash('sha1').update(value).digest('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const NOW = '2026-11-17T00:00:00.000Z';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTRA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COVERAGE = {
  notes: 'complete-current-github-head',
  quickNotes: 'complete-current-github-head',
  airNotes: 'complete-current-github-head',
  historicalRevisions: 'not-included',
  encryptedDrafts: 'not-included',
  legacyMongoNotes: 'not-included',
  learningProgress: 'not-included',
};
function archive({ note = true, extra = false, body = 'private note',
  snapshot = 'head-current' } = {}) {
  const notes = [];
  for (const [id, text] of [[ID, body], ...(extra ? [[EXTRA, 'other private note']] : [])]) {
    if (!note) break;
    notes.push({
      ...validatedNote({
        subjectId: SUBJECT, heading: 'Sensitive heading',
        answer: text, tags: ['study'], favorite: false,
      }, { id, now: NOW }),
      sha: sha1(id + ':' + text),
    });
  }
  const a = {
    format: 'oge-vault-current-resources-backup',
    version: 1,
    scope: 'current-github-notes-quick-notes-airnotes-only',
    snapshot: sha1(snapshot),
    treeSha: sha1('tree:' + snapshot),
    totalNotes: notes.length,
    totalQuickNotes: 0,
    totalAirNotes: 0,
    coverage: { ...COVERAGE },
    notes, quickNotes: [], airNotes: [],
    importable: false, completeAccountBackup: false,
  };
  const index = [
    ...notes.map(row => 'notes/' + row.id + '.json:' + row.sha),
  ];
  a.inventorySha256 = sha256(
    'oge-vault-current-resource-index-v1\n' + index.join('\n') + '\n');
  a.archiveSha256 = sha256(JSON.stringify({
    ...a,
  }));
  // Above first hash includes the index; archiveSha256 itself not yet present.
  return a;
}
function file(a) {
  const bytes = new TextEncoder().encode(JSON.stringify(a));
  return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}
function server(current, { differ = false, forge = false } = {}) {
  let requests = 0;
  return {
    get requests() { return requests; },
    async fetcher(url, init) {
      requests++;
      assert.equal(url, '/api/vault/backup-current-resources/source-check');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      const claim = JSON.parse(init.body);
      assert.deepEqual(Object.keys(claim).sort(), [
        'format','version','confirmation','snapshot','treeSha',
        'archiveSha256','inventorySha256',
        'totalNotes','totalQuickNotes','totalAirNotes',
      ].sort());
      for (const secret of ['private note', 'Sensitive heading', ID, EXTRA]) {
        assert.equal(init.body.includes(secret), false);
      }
      const report = compareVaultCurrentResourceSourceClaim(
        claim, differ ? archive({ snapshot: 'new head' }) : current);
      return Response.json(forge ? { ...report, canRestore: true } : report);
    },
  };
}

test('M91 locally validates BOTH archives before sending only reference metadata and produces redacted current-authoritative-at-check counts', async () => {
  const old = archive({ body: 'old private version', extra: true, snapshot: 'old' });
  const current = archive({ body: 'new private version' });
  const mock = server(current);
  const result = await previewVaultAuthenticatedRecoveryFiles(
    file(old), file(current), { subtle: webcrypto.subtle, fetcher: mock.fetcher });
  assert.equal(mock.requests, 1);
  assert.equal(result.status,
    'CURRENT_GITHUB_REFERENCE_AUTHENTICATED_AT_CHECK_READ_ONLY');
  assert.equal(result.currentSnapshotAuthenticatedAtCheck, true);
  assert.equal(result.backupSourceAuthenticated, false);
  assert.equal(result.snapshotMayBecomeStaleAfterCheck, true);
  assert.deepEqual(
    [result.totalAdd, result.totalConflict, result.totalUnchanged, result.totalPreserve],
    [1, 1, 0, 0],
  );
  for (const key of [
    'canRestore','canAuthorizeImport','canDeleteExisting',
    'canReleaseImportLock','canRetryUnknownWrite','githubWritesPerformed',
    'fileContentsUploaded','restorationAuthorized',
  ]) assert.equal(result[key], false, key);
  const output = JSON.stringify(result);
  for (const secret of [ID, EXTRA, SUBJECT, 'old private',
    'new private', current.snapshot, current.archiveSha256]) {
    assert.equal(output.includes(secret), false);
  }
});

test('M91 refuses stale reference as an authenticated current plan without marking archive corrupt', async () => {
  const ref = archive();
  const mock = server(ref, { differ: true });
  const report = await previewVaultAuthenticatedRecoveryFiles(
    file(ref), file(ref), { subtle: webcrypto.subtle, fetcher: mock.fetcher });
  assert.equal(mock.requests, 1);
  assert.equal(report.status, 'CURRENT_GITHUB_REFERENCE_DIFFERED_HOLD');
  assert.equal(report.currentSnapshotAuthenticatedAtCheck, false);
  assert.equal(report.canRestore, false);
  assert.equal('resources' in report, false);
});

test('M91 rejects tampered backup or reference BEFORE contacting private GitHub', async () => {
  const base = archive();
  const changed = JSON.parse(JSON.stringify(base));
  changed.notes[0].answer = 'altered without checksum update';
  const mock = server(base);
  for (const input of [[file(changed), file(base)],
    [file(base), file(changed)], [null, file(base)],
    [file(base), null]]) {
    await assert.rejects(previewVaultAuthenticatedRecoveryFiles(
      input[0], input[1],
      { subtle: webcrypto.subtle, fetcher: mock.fetcher }));
  }
  assert.equal(mock.requests, 0);
});

test('M91 rejects forged positive source responses with restore permissions', async () => {
  const base = archive();
  const mock = server(base, { forge: true });
  await assert.rejects(previewVaultAuthenticatedRecoveryFiles(
    file(base), file(base),
    { subtle: webcrypto.subtle, fetcher: mock.fetcher }));
  assert.equal(mock.requests, 1);
});

test('M91 separately labels two inputs, independent staging gate and no write controls', async () => {
  const [ui, page, env, core] = await Promise.all([
    readFile(new URL('../app/vault/recovery/vault-restore-preview.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-authenticated-restore-preview.js', import.meta.url), 'utf8'),
  ]);
  assert.match(ui, /vault-restore-backup-file/);
  assert.match(ui, /vault-restore-reference-file/);
  assert.doesNotMatch(ui, /type="file" multiple/);
  assert.match(page, /OGE_VAULT_RESTORE_SOURCE_PREVIEW === 'true'/);
  assert.match(env, /OGE_VAULT_RESTORE_SOURCE_PREVIEW=false/);
  assert.doesNotMatch(core, /\.collection\(/);
  assert.doesNotMatch(core, /localStorage|sessionStorage|window\.location/);
});
