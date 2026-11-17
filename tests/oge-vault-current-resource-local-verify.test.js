import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, webcrypto,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validatedStandaloneCapture,
} from '../lib/oge-vault-standalone-captures.js';
import {
  verifyVaultCurrentResourcesArchive,
} from '../lib/oge-vault-backup-current-resources.js';
import {
  inspectVaultCurrentResourceArchiveLocally,
  inspectVaultCurrentResourceFileLocally,
} from '../lib/oge-vault-current-resource-local-verify.js';

const sha1 = (v) => createHash('sha1').update(v).digest('hex');
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const SHA = sha1('m88-commit');
const TREE = sha1('m88-tree');
const NOW = '2026-11-17T00:00:00.000Z';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDs = Object.freeze({
  notes: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  quickNotes: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  airNotes: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
});
const coverage = Object.freeze({
  notes: 'complete-current-github-head',
  quickNotes: 'complete-current-github-head',
  airNotes: 'complete-current-github-head',
  historicalRevisions: 'not-included',
  encryptedDrafts: 'not-included',
  legacyMongoNotes: 'not-included',
  learningProgress: 'not-included',
});
function makeArchive({ empty = false } = {}) {
  const notes = empty ? [] : [{
    ...validatedNote({
      subjectId: SUBJECT, heading: 'Private study heading',
      answer: 'Sensitive notes must not appear in result',
      tags: ['study'], favorite: false,
    }, { id: IDs.notes, now: NOW }),
    sha: sha1('note-blob'),
  }];
  const quickNotes = empty ? [] : [{
    ...validatedStandaloneCapture('quick-notes', {
      content: 'Quick\nprivate content\n',
    }, { id: IDs.quickNotes, now: NOW }),
    sha: sha1('quick-blob'),
  }];
  const airNotes = empty ? [] : [{
    ...validatedStandaloneCapture('airnotes', {
      content: 'AirNote private',
    }, { id: IDs.airNotes, now: NOW }),
    sha: sha1('air-blob'),
  }];
  const archive = {
    format: 'oge-vault-current-resources-backup', version: 1,
    scope: 'current-github-notes-quick-notes-airnotes-only',
    snapshot: SHA, treeSha: TREE,
    totalNotes: notes.length, totalQuickNotes: quickNotes.length,
    totalAirNotes: airNotes.length, coverage: { ...coverage },
    notes, quickNotes, airNotes,
    importable: false, completeAccountBackup: false,
  };
  seal(archive);
  return archive;
}
function seal(archive) {
  const inv = [
    ...archive.notes.map(({ id, sha }) => 'notes/' + id + '.json:' + sha),
    ...archive.quickNotes.map(({ id, sha }) => 'quick-notes/' + id + '.json:' + sha),
    ...archive.airNotes.map(({ id, sha }) => 'airnotes/' + id + '.json:' + sha),
  ];
  archive.inventorySha256 = sha256(
    'oge-vault-current-resource-index-v1\n' + inv.join('\n') + '\n');
  const { archiveSha256: _old, inventorySha256: _inventory, ...payload } = archive;
  archive.archiveSha256 = sha256(JSON.stringify({
    ...payload, inventorySha256: archive.inventorySha256,
  }));
}
const inspect = (archive) => inspectVaultCurrentResourceArchiveLocally(
  archive, { subtle: webcrypto.subtle });

function mockFile(source, options = {}) {
  const bytes = new TextEncoder().encode(source);
  return {
    size: options.size ?? bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

test('M88 genuine M73-format synthetic archive accepted by BOTH original server and browser verifier, redacted counts only', async () => {
  const a = makeArchive();
  const server = verifyVaultCurrentResourcesArchive(a);
  assert.equal(server.inspectedCurrentResources, true);
  const report = await inspect(a);
  assert.equal(report.format, 'oge-vault-current-resources-local-check');
  assert.equal(report.status, 'LOCAL_EMBEDDED_HASHES_MATCH_SOURCE_UNAUTHENTICATED');
  assert.equal(report.totalNotes, 1);
  assert.equal(report.totalQuickNotes, 1);
  assert.equal(report.totalAirNotes, 1);
  assert.equal(report.embeddedInventorySha256Matched, true);
  assert.equal(report.embeddedArchiveSha256Matched, true);
  for (const flag of [
    'sourceAuthenticated', 'gitBlobShaVerifiedAgainstGitHub',
    'immutableGitHeadIndependentlyVerified', 'privateGitHubRepoOwnershipVerified',
    'fullAccountBackup', 'historicalRevisionsIncluded',
    'encryptedDraftsIncluded', 'legacyMongoNotesIncluded',
    'learningProgressIncluded', 'canRestore', 'canAuthorizeImport',
    'canReleaseImportLock', 'safeToRetryAutomatically',
    'networkRequestsPerformed', 'serverUploadsPerformed',
    'browserPersistentStorageWritesPerformed', 'notesOrIdentifiersReturned',
  ]) assert.equal(report[flag], false, flag);
  const output = JSON.stringify(report);
  for (const secret of [
    'Sensitive notes', 'Quick', 'AirNote',
    IDs.notes, IDs.quickNotes, IDs.airNotes, SHA, TREE,
    a.inventorySha256, a.archiveSha256,
  ]) assert.equal(output.includes(secret), false);
});

test('M88 empty complete current-resource archive uses exact two-newline M73 inventory digest', async () => {
  const a = makeArchive({ empty: true });
  verifyVaultCurrentResourcesArchive(a);
  const report = await inspect(a);
  assert.deepEqual([report.totalNotes, report.totalQuickNotes,
    report.totalAirNotes], [0, 0, 0]);
  assert.equal(report.canRestore, false);
});

test('M88 file-selected local JSON roundtrip; raw file content is never included in result', async () => {
  const a = makeArchive();
  const text = JSON.stringify(a);
  const result = await inspectVaultCurrentResourceFileLocally(
    mockFile(text), { subtle: webcrypto.subtle });
  assert.equal(result.totalNotes, 1);
  assert.equal(result.serverUploadsPerformed, false);
  assert.equal(JSON.stringify(result).includes(a.notes[0].answer), false);
});

test('M88 tamper detection: content, counts, signed inventory, SHA and coverage refuse without network', async () => {
  const cases = [
    a => { a.notes[0].answer = 'altered note'; },
    a => { a.totalNotes++; },
    a => { a.inventorySha256 = 'f'.repeat(64); },
    a => { a.archiveSha256 = 'f'.repeat(64); },
    a => { a.snapshot = 'f'.repeat(40); },
    a => { a.notes[0].sha = 'e'.repeat(40); },
    a => { a.coverage.encryptedDrafts = 'complete-current-github-head'; },
    a => { a.importable = true; },
    a => { a.completeAccountBackup = true; },
    a => { a.extra = 'unexpected'; },
    a => { a.notes[0].extra = 'unexpected'; },
    a => { a.notes[0].heading = ' private untrimmed '; },
    a => { a.quickNotes[0].title = 'wrong title'; },
    a => { a.airNotes[0].content = 'carriage\rreturn'; },
    a => { a.quickNotes[0].id = IDs.notes; },
  ];
  for (const mutate of cases) {
    const archive = makeArchive();
    mutate(archive);
    await assert.rejects(inspect(archive), TypeError);
  }
});

test('M88 all self-declared hashes can be forged: STILL never claim GitHub source authentication or restore authority', async () => {
  const archive = makeArchive();
  archive.notes[0].answer = 'Forged sensitive content with no real GitHub source';
  seal(archive);
  const result = await inspect(archive);
  assert.equal(result.embeddedArchiveSha256Matched, true);
  assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.gitBlobShaVerifiedAgainstGitHub, false);
  assert.equal(result.canAuthorizeImport, false);
  assert.equal(result.canRestore, false);
});

test('M88 bounded file checks reject oversized, noncanonical, malformed, invalid UTF-8 and missing crypto', async () => {
  const original = JSON.stringify(makeArchive());
  const file = mockFile(original);
  for (const suspect of [
    { size: 8 * 1024 * 1024 + 1, arrayBuffer: async () => {
      throw new Error('Should not read oversize');
    } },
    { size: 300, arrayBuffer: async () => new ArrayBuffer(5) },
    mockFile(JSON.stringify(JSON.parse(original), null, 2)),
    mockFile(original + '\n'),
    mockFile(original.replace('"format":', '"format":"wrong","format":')),
    mockFile('{not JSON'),
    { size: 4, arrayBuffer: async () => new Uint8Array([255, 255, 255, 255]).buffer },
    { ...file, size: 0 },
    null,
  ]) {
    await assert.rejects(inspectVaultCurrentResourceFileLocally(
      suspect, { subtle: webcrypto.subtle }), TypeError);
  }
  await assert.rejects(inspectVaultCurrentResourceFileLocally(
    mockFile(original), { subtle: null }), TypeError);
});

test('M88 private Recovery Center picker has no fetch/submit/store or Note/body persistence and is owner staging gated', async () => {
  const [client, page, core] = await Promise.all([
    readFile(new URL(
      '../app/vault/recovery/vault-current-backup-local-check.js',
      import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/page.js', import.meta.url), 'utf8'),
    readFile(new URL(
      '../lib/oge-vault-current-resource-local-verify.js',
      import.meta.url), 'utf8'),
  ]);
  assert.match(client, /^'use client';/);
  assert.match(client, /type="file"/);
  assert.match(client, /onChange=\{inspectFile\}/);
  assert.match(client, /event\.currentTarget\.value = ''/);
  assert.match(client, /setResult\(report\)/);
  assert.match(client, /source.*GitHub|GitHub.*created it/);
  assert.match(page, /vaultRecoveryCenterStagingAllowed\(process\.env\)/);
  assert.match(page, /await auth\(\)/);
  assert.match(page, /VaultCurrentBackupLocalCheck/);
  assert.match(core, /subtle\.digest\('SHA-256'/);
  assert.match(core, /MAX_BYTES = 8 \* 1024 \* 1024/);
  assert.match(core, /text !== JSON\.stringify\(parsed\)/);
  assert.doesNotMatch(client + core,
    /\bfetch\(|\bXMLHttpRequest\b|\bWebSocket\b|navigator\.sendBeacon|navigator\.storage|localStorage|sessionStorage|indexedDB|formData|FormData\(|method: 'POST'|method: 'PATCH'|uploadFile|setItem\(/);
});
