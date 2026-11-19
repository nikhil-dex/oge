import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  exportVaultCurrentResourcesSnapshot,
  verifyVaultCurrentResourcesArchive, MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from '../lib/oge-vault-backup-current-resources.js';
import { validateVaultNotesImportArchive } from '../lib/oge-vault-backup-import-plan.js';

const H = (text) => createHash('sha1').update(text).digest('hex');
const SUBJECT = randomUUID();
const HEAD = H('m73-synthetic-head');
const TREE = H('m73-synthetic-tree');
const NOW = '2026-11-17T00:00:00.000Z';
const byteCount = (value) => Buffer.byteLength(JSON.stringify(value));

function fixture({
  noteCount = 3, quickCount = 2, airCount = 2,
  noteTextLength = 0, quickTextLength = 0,
  changedHead = false, truncated = false, treeMutator = null,
  blobMutator = null, denySubjects = false, rateLimited = false,
} = {}) {
  const notes = Array.from({ length: noteCount }, (_, i) => {
    const id = randomUUID();
    return {
      kind: 'notes', id, path: 'notes/' + id + '.json',
      data: validatedNote({
        subjectId: SUBJECT, heading: 'Private note ' + i,
        answer: noteTextLength ? 'x'.repeat(noteTextLength) : 'Study content ' + i,
        tags: [], favorite: false,
      }, { id, now: NOW }),
    };
  });
  const standalone = (kind, count, size) =>
    Array.from({ length: count }, (_, i) => {
      const id = randomUUID();
      return { kind, id, path: kind + '/' + id + '.json',
        data: validatedStandaloneCapture(kind, {
          content: size ? 'x'.repeat(size) : kind + ' ' + i,
        }, { id, now: NOW }),
      };
    });
  const entries = [
    ...notes, ...standalone('quick-notes', quickCount, quickTextLength),
    ...standalone('airnotes', airCount, 0),
  ].map((row) => ({ ...row, sha: H('immutable-blob:' + row.path) }));
  const bySha = new Map(entries.map((entry) => [entry.sha, entry]));
  const fullTree = [
    { path: '.ogenotes/vault.json', type: 'blob', mode: '100644',
      sha: H('marker'), size: 100 },
    { path: 'notes', type: 'tree', mode: '040000', sha: H('notes-root') },
    { path: 'quick-notes', type: 'tree', mode: '040000', sha: H('quick-root') },
    { path: 'airnotes', type: 'tree', mode: '040000', sha: H('air-root') },
    ...entries.map(({ path, sha, data }) => ({
      path, sha, type: 'blob', mode: '100644', size: byteCount(data),
    })),
  ];
  const tree = treeMutator ? treeMutator(fullTree) : fullTree;
  let refs = 0, blobReads = 0, maxInFlight = 0, active = 0;
  const calls = [];
  const client = {
    readOnly: true, branch: 'main',
    vault: { repoId: 412, installationId: 712 },
    async call(path, opts = {}) {
      assert.equal(opts.method || 'GET', 'GET', 'M73 never calls a GitHub writer');
      calls.push(path);
      if (path === '/git/ref/heads/main') {
        refs++;
        return { object: { sha: changedHead && refs > 1 ?
          H('m73-competing-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD)
        return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { truncated, tree };
      if (path.startsWith('/git/blobs/')) {
        blobReads++;
        active++;
        maxInFlight = Math.max(active, maxInFlight);
        try {
          if (rateLimited) throw new VaultGitHubError('github-rate-limited', 429);
          const remote = bySha.get(path.slice('/git/blobs/'.length));
          if (!remote) throw new Error('Unknown immutable SHA');
          const value = blobMutator ? blobMutator(remote.data, remote) : remote.data;
          return {
            sha: remote.sha, encoding: 'base64',
            content: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
            size: byteCount(value),
          };
        } finally { active--; }
      }
      throw new Error('Unexpected signed GitHub request ' + path);
    },
  };
  return {
    client, entries, calls,
    subjectVerifier: async (subjectIds) =>
      !denySubjects && subjectIds.every((id) => id === SUBJECT),
    get blobReads() { return blobReads; },
    get headReads() { return refs; },
    get maxConcurrent() { return maxInFlight; },
  };
}

async function backup(f, options = {}) {
  return exportVaultCurrentResourcesSnapshot(f.client, {
    subjectVerifier: f.subjectVerifier, ...options,
  });
}

test('M73 one signed immutable HEAD backs ALL current Notes/Quick Notes/AirNotes, with no remote writes', async () => {
  const f = fixture();
  const archive = await backup(f);
  assert.equal(archive.format, 'oge-vault-current-resources-backup');
  assert.equal(archive.scope, 'current-github-notes-quick-notes-airnotes-only');
  assert.equal(archive.snapshot, HEAD);
  assert.equal(archive.treeSha, TREE);
  assert.equal(archive.totalNotes, 3);
  assert.equal(archive.totalQuickNotes, 2);
  assert.equal(archive.totalAirNotes, 2);
  assert.equal(archive.notes.length, 3);
  assert.equal(archive.quickNotes.length, 2);
  assert.equal(archive.airNotes.length, 2);
  assert.equal(archive.notes[0].format, 'ogenotes-note');
  assert.equal(archive.quickNotes[0].format, 'ogenotes-quick-note');
  assert.equal(archive.airNotes[0].format, 'ogenotes-airnote');
  assert.equal(archive.coverage.notes, 'complete-current-github-head');
  assert.equal(archive.coverage.quickNotes, 'complete-current-github-head');
  assert.equal(archive.coverage.airNotes, 'complete-current-github-head');
  assert.equal(archive.coverage.historicalRevisions, 'not-included');
  assert.equal(archive.coverage.encryptedDrafts, 'not-included');
  assert.equal(archive.completeAccountBackup, false);
  assert.equal(archive.importable, false);
  assert.equal(f.headReads, 2);
  assert.equal(f.blobReads, 7);
  assert.ok(f.calls.every((path) => !path.startsWith('/contents/')));
  assert.equal(f.calls.filter((path) =>
    path === '/git/trees/' + TREE + '?recursive=1').length, 1);
  const report = verifyVaultCurrentResourcesArchive(archive);
  assert.deepEqual([report.totalNotes, report.totalQuickNotes, report.totalAirNotes],
    [3, 2, 2]);
  assert.equal(report.inspectedCurrentResources, true);
  assert.equal(report.canRestore, false);
  assert.equal(report.authenticatedSource, false);
});

test('M73 backup works with no Notes, no standalone captures, and with 501 Notes (not old index cap)', async () => {
  const empty = await backup(fixture({ noteCount: 0, quickCount: 0, airCount: 0 }));
  assert.equal(empty.totalNotes, 0);
  assert.deepEqual(empty.quickNotes, []);
  assert.deepEqual(empty.airNotes, []);
  verifyVaultCurrentResourcesArchive(empty);
  const big = fixture({ noteCount: 501, quickCount: 1, airCount: 1 });
  const exported = await backup(big);
  assert.equal(exported.totalNotes, 501);
  assert.equal(big.blobReads, 503);
  assert.equal(verifyVaultCurrentResourcesArchive(exported).totalNotes, 501);
});

test('M73 export fails closed for moved HEAD, truncated tree, unauthorized subject, provider 429 and missing owner verifier', async () => {
  for (const settings of [
    { changedHead: true }, { truncated: true },
    { denySubjects: true }, { rateLimited: true },
  ]) {
    const f = fixture(settings);
    await assert.rejects(backup(f), (error) =>
      error instanceof VaultGitHubError && [409, 429].includes(error.status));
  }
  await assert.rejects(exportVaultCurrentResourcesSnapshot(fixture().client), TypeError);
  await assert.rejects(backup(fixture({ noteCount: 0 }), {
    maxBytes: 800,
  }), TypeError);
});

test('M73 malformed files, duplicate paths, nested resources, symlinks and huge tree files are not skipped', async () => {
  const invalid = [
    (items) => [...items, items[4]],
    (items) => [...items, { path: 'quick-notes/other.txt', type: 'blob',
      sha: H('other'), mode: '100644' }],
    (items) => [...items, { path: 'airnotes/folder/x.json', type: 'blob',
      sha: H('x'), mode: '100644' }],
    (items) => [...items, { path: 'notes/../evil.json', type: 'blob',
      sha: H('evil'), mode: '100644' }],
    (items) => items.map((item, index) =>
      index === 5 ? { ...item, mode: '120000' } : item),
    (items) => [...items, { path: 'airnotes/' + randomUUID() + '.json',
      type: 'blob', mode: '100644', sha: H('large'), size: 40000 }],
    (items) => [...items, { path: 'notes/' + randomUUID() + '.json',
      type: 'tree', mode: '040000', sha: H('nested') }],
    (items) => items.slice(0, 1).concat({ path: 'quick-notes',
      type: 'blob', mode: '100644', sha: H('badroot') }, items.slice(2)),
  ];
  for (const treeMutator of invalid) {
    const f = fixture({ treeMutator });
    await assert.rejects(backup(f), e =>
      e instanceof VaultGitHubError && e.status === 409);
  }
});

test('M73 invalid Quick Notes/AirNotes blob format, title and extra fields invalidate the WHOLE snapshot', async () => {
  for (const blobMutator of [
    (row, meta) => meta.kind === 'airnotes' ?
      { ...row, version: 2 } : row,
    (row, meta) => meta.kind === 'quick-notes' ?
      { ...row, title: 'forged first-line title' } : row,
    (row, meta) => meta.kind === 'airnotes' ?
      { ...row, ownerToken: 'unsafe' } : row,
    (row, meta) => meta.kind === 'notes' ?
      { ...row, subjectId: randomUUID() } : row,
  ]) {
    const f = fixture({ blobMutator });
    await assert.rejects(backup(f), e =>
      e instanceof VaultGitHubError && [400, 409, 502].includes(e.status));
  }
});

test('M73 strict per-resource cap refuses 301 entries instead of silently dropping an export page', async () => {
  const f = fixture({ noteCount: 0, quickCount: 301, airCount: 0 });
  await assert.rejects(backup(f), e =>
    e instanceof VaultGitHubError && e.status === 413);
  assert.equal(f.blobReads, 0);
});

test('M73 8-MiB total archive cap enforces known tree bytes before downloading any blob', async () => {
  const f = fixture({ noteCount: 430, quickCount: 0, airCount: 0,
    noteTextLength: 20000 });
  await assert.rejects(backup(f), e =>
    e instanceof VaultGitHubError && e.status === 413);
  assert.equal(f.blobReads, 0);
  assert.equal(MAX_VAULT_RESOURCE_BACKUP_BYTES, 8 * 1024 * 1024);
});

test('M73 offline integrity inspector rejects corruption, omitted entries, swaps, duplicates or scope claims', async () => {
  const f = fixture();
  const source = await backup(f);
  const mutants = [
    (obj) => { obj.quickNotes[0].content = 'Tampered PRIVATE quick-note'; },
    (obj) => { obj.notes.pop(); obj.totalNotes--; },
    (obj) => { obj.airNotes = [...obj.airNotes].reverse(); },
    (obj) => { obj.quickNotes.push(obj.quickNotes[0]); obj.totalQuickNotes++; },
    (obj) => { obj.coverage.encryptedDrafts = 'complete-current-github-head'; },
    (obj) => { obj.scope = 'full-account-backup'; },
    (obj) => { obj.importable = true; },
    (obj) => { obj.completeAccountBackup = true; },
    (obj) => { obj.inventorySha256 = 'f'.repeat(64); },
    (obj) => { obj.archiveSha256 = 'e'.repeat(64); },
    (obj) => { obj.notes[0].sha = 'not-a-blob'; },
    (obj) => { obj.airNotes[0].title = 'Inaccurate title'; },
    (obj) => { obj.airNotes[0].content = 'x'.repeat(21000); },
    (obj) => { obj.airNotes[0].anotherField = 1; },
    (obj) => { obj.totalAirNotes++; },
  ];
  for (const mutate of mutants) {
    const copy = structuredClone(source);
    mutate(copy);
    assert.throws(() => verifyVaultCurrentResourcesArchive(copy),
      e => e instanceof VaultGitHubError && e.status === 400);
  }
});

test('M73 offline digest is NOT restore authorization, and old Notes-only import refuses this new format', async () => {
  const archive = await backup(fixture());
  const result = verifyVaultCurrentResourcesArchive(archive);
  assert.equal(result.sourceShaTrustedAsAuthorization, false);
  assert.equal(result.canCommit, false);
  assert.equal(result.canRestore, false);
  assert.equal(result.completeAccountBackup, false);
  assert.equal(result.writesToMongo, false);
  assert.throws(() => validateVaultNotesImportArchive(archive),
    e => e instanceof VaultGitHubError && e.status === 400);
});

test('M73 new stage export route is read-only signed-owner with complete scope and independent flag', async () => {
  const api = await readFile(new URL(
    '../app/api/vault/backup-current-resources/route.js', import.meta.url),
    'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-backup-current-resources.js', import.meta.url), 'utf8');
  const old = await readFile(new URL(
    '../lib/oge-vault-backup-export.js', import.meta.url), 'utf8');
  for (const expected of [
    /OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true'/,
    /OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true'/,
    /OGE_VAULT_STANDALONE_PREVIEW === 'true'/,
    /oge_vault_restore_staging_/,
    /env\.OGE_STAGING_URL === env\.AUTH_URL/,
    /checkVaultStagingReadiness\(env\)\.ok/,
    /const session = await auth\(\)/,
    /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/,
    /readOnly: true/,
    /Content-Disposition/,
    /Cache-Control': 'private, no-store'/,
    /ownerId, slug: \{ \$in: subjectIds \}/,
    /client\.vault\.repoId/,
    /client\.vault\.installationId/,
    /exportVaultCurrentResourcesSnapshot/,
  ]) assert.match(api, expected);
  assert.match(core, /readVaultNoteBlob/);
  assert.match(core, /readVaultStandaloneBlob/);
  assert.match(core, /'not-included'/);
  assert.doesNotMatch(api + core,
    /commitVaultNoteBatch|commitVaultStandaloneCapture|insertOne\(|deleteOne\(|updateOne\(|collection\(['"]notes['"]\)/);
  assert.doesNotMatch(api, /export async function POST|export async function PUT/);
  assert.match(old, /scope: 'current-github-notes-only'/,
    'older Notes-only backup remains exactly scoped, no magic migration');
});
