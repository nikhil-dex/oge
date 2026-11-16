import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import {
  exportVaultCurrentResourcesSnapshot, verifyVaultCurrentResourcesArchive,
} from '../lib/oge-vault-backup-current-resources.js';
import {
  planVaultCurrentResourcesRestoreReadOnly,
} from '../lib/oge-vault-backup-current-resources-plan.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (value) => createHash('sha1').update(value).digest('hex');
const SUBJECT = randomUUID();
const HEAD = H('m74-target-head');
const TREE = H('m74-target-tree');
const NOW = '2026-11-17T00:00:00.000Z';
const KINDS = [
  ['notes', 'notes'],
  ['quickNotes', 'quick-notes'],
  ['airNotes', 'airnotes'],
];

async function sourceArchive({ notes = 2, quickNotes = 2, airNotes = 2 } = {}) {
  const records = [];
  for (const [key, path] of KINDS) {
    const count = { notes, quickNotes, airNotes }[key];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const content = 'PRIVATE M74 TEST BODY ' + key + ' ' + i;
      const data = key === 'notes'
        ? validatedNote({
          subjectId: SUBJECT, heading: 'Private title ' + i,
          answer: content, tags: [], favorite: false,
        }, { id, now: NOW })
        : validatedStandaloneCapture(path, { content }, { id, now: NOW });
      records.push({
        key, path, id, data,
        sha: H('m74-source-blob-' + path + '/' + id),
      });
    }
  }
  const sourceHead = H('m74-source-head');
  const sourceTree = H('m74-source-tree');
  const files = records.map((row) => ({
    path: row.path + '/' + row.id + '.json',
    type: 'blob', mode: '100644', sha: row.sha,
    size: Buffer.byteLength(JSON.stringify(row.data)),
  }));
  const reader = async (_client, id, sha) => {
    const row = records.find((item) =>
      item.key === 'notes' && item.id === id && item.sha === sha);
    if (!row) throw Error('Unexpected source note');
    return { ...row.data, sha };
  };
  const standaloneReader = async (_client, kind, id, sha) => {
    const row = records.find((item) =>
      item.path === kind && item.id === id && item.sha === sha);
    if (!row) throw Error('Unexpected source capture');
    return { ...row.data, sha };
  };
  const source = {
    readOnly: true, branch: 'main', vault: { repoId: 22 },
    async call(path, options = {}) {
      assert.equal(options.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main')
        return { object: { sha: sourceHead } };
      if (path === '/git/commits/' + sourceHead)
        return { tree: { sha: sourceTree } };
      if (path === '/git/trees/' + sourceTree + '?recursive=1')
        return { truncated: false, tree: files };
      throw Error('Unexpected export source GitHub call ' + path);
    },
  };
  const archive = await exportVaultCurrentResourcesSnapshot(source, {
    noteReader: reader, standaloneReader,
    subjectVerifier: async (ids) => ids.every((id) => id === SUBJECT),
  });
  return archive;
}

function target({ archive, existing = {}, draftIds = {},
  badTree = null, movingHead = false, revokedOwnerAt = 0,
  unownedSubjects = false, extraDraft = false, truncated = false,
  throwRateLimit = false } = {}) {
  const calls = [], draftCalls = [], subjectCalls = [];
  let headReads = 0, ownerChecks = 0;
  const paths = KINDS.flatMap(([key, path]) =>
    (existing[key] || []).map((id) => ({
      path: path + '/' + id + '.json', type: 'blob',
      mode: '100644', sha: H('m74-target-blob:' + path + ':' + id),
      size: 300,
    })));
  const entryList = badTree === null ? paths : badTree(paths);
  const client = {
    readOnly: true, branch: 'main',
    vault: { repoId: 777 },
    async call(path, options = {}) {
      assert.equal(options.method || 'GET', 'GET',
        'M74 must never write GitHub');
      calls.push(path);
      if (throwRateLimit) throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main') {
        headReads++;
        return { object: {
          sha: movingHead && headReads >= 2
            ? H('m74-competing-head') : HEAD,
        } };
      }
      if (path === '/git/commits/' + HEAD)
        return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { truncated, tree: entryList };
      throw Error('Unexpected target GitHub request ' + path);
    },
  };
  const options = {
    ownerVerifier: async () => {
      ownerChecks++;
      return revokedOwnerAt !== ownerChecks;
    },
    subjectVerifier: async (ids) => {
      subjectCalls.push(ids);
      return !unownedSubjects && ids.every((id) => id === SUBJECT);
    },
    pendingDraftIds: async (kind, ids) => {
      draftCalls.push({ kind, ids });
      const found = ids.filter((id) => (draftIds[kind] || []).includes(id));
      return extraDraft ? [...found, randomUUID()] : found;
    },
  };
  return {
    client, options, calls, draftCalls, subjectCalls,
    get ownerChecks() { return ownerChecks; },
    get headReads() { return headReads; },
  };
}
const plan = (targetFixture, archive) =>
  planVaultCurrentResourcesRestoreReadOnly(
    targetFixture.client, archive, targetFixture.options);

test('M74 mixed resource conflicts, including typed drafts, have exact per-type counts and no private bodies', async () => {
  const archive = await sourceArchive();
  const existing = {
    notes: [archive.notes[0].id],
    quickNotes: [archive.quickNotes[0].id],
    airNotes: [archive.airNotes[1].id],
  };
  const draftIds = {
    notes: [archive.notes[1].id],
    'quick-notes': [archive.quickNotes[0].id],
    airnotes: [archive.airNotes[0].id],
  };
  const f = target({ archive, existing, draftIds });
  const result = await plan(f, archive);
  assert.equal(result.format, 'oge-vault-current-resources-restore-plan');
  assert.deepEqual(result.summary, {
    total: 6, createCandidates: 1,
    existingConflicts: 2, draftConflicts: 3,
  });
  assert.deepEqual(result.byKind.notes, {
    total: 2, createCandidates: 0,
    existingConflicts: 1, draftConflicts: 1,
  });
  assert.deepEqual(result.byKind.quickNotes, {
    total: 2, createCandidates: 1,
    existingConflicts: 0, draftConflicts: 1,
  });
  assert.deepEqual(result.byKind.airNotes, {
    total: 2, createCandidates: 0,
    existingConflicts: 1, draftConflicts: 1,
  });
  assert.deepEqual(result.preview.map((x) => x.kind),
    ['notes', 'notes', 'quick-notes', 'quick-notes', 'airnotes', 'airnotes']);
  assert.equal(result.previewTruncated, false);
  assert.equal(result.sourcePrivateTextReturned, false);
  assert.equal(result.canCommit, false);
  assert.equal(result.canRestore, false);
  assert.equal(result.writesToGitHub, false);
  assert.equal(result.writesToMongo, false);
  assert.equal(result.sourceGitHubIdentityAuthenticated, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE M74 TEST BODY'), false);
  assert.equal(JSON.stringify(result).includes('Private title'), false);
  assert.equal(f.calls.length, 4);
  assert.equal(f.ownerChecks, 2);
  assert.equal(f.headReads, 2);
  assert.deepEqual(f.draftCalls.map((item) => item.kind),
    ['notes', 'quick-notes', 'airnotes']);
});

test('M74 fully empty source is a no-op advisory preview, not import authorization', async () => {
  const archive = await sourceArchive({
    notes: 0, quickNotes: 0, airNotes: 0,
  });
  const f = target({ archive });
  const result = await plan(f, archive);
  assert.deepEqual(result.summary, {
    total: 0, createCandidates: 0,
    existingConflicts: 0, draftConflicts: 0,
  });
  assert.deepEqual(result.preview, []);
  assert.equal(result.canCommit, false);
  assert.equal(f.draftCalls.length, 0);
  assert.equal(f.subjectCalls.length, 0);
});

test('M74 invalid archive is rejected BEFORE any target GitHub/subject/draft/owner queries', async () => {
  const original = await sourceArchive();
  const variants = [
    { ...original, archiveSha256: 'f'.repeat(64) },
    { ...original, quickNotes: original.quickNotes.slice(1) },
    { ...original, scope: 'any-private-repository' },
    { ...original, importable: true },
  ];
  for (const archive of variants) {
    const f = target({ archive });
    await assert.rejects(plan(f, archive),
      (err) => err instanceof VaultGitHubError && err.status === 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.ownerChecks, 0);
    assert.equal(f.subjectCalls.length, 0);
    assert.equal(f.draftCalls.length, 0);
  }
});

test('M74 signed owner and subject verifier block the target before GitHub inventory', async () => {
  const archive = await sourceArchive();
  for (const args of [
    { revokedOwnerAt: 1 }, { unownedSubjects: true },
  ]) {
    const f = target({ archive, ...args });
    await assert.rejects(plan(f, archive), (err) =>
      err instanceof VaultGitHubError && err.status === 409);
    assert.equal(f.calls.length, 0);
    assert.equal(f.draftCalls.length, 0);
  }
});

test('M74 revoked owner AFTER metadata checks or moving GitHub HEAD invalidates entire preview', async () => {
  const archive = await sourceArchive();
  for (const settings of [
    { revokedOwnerAt: 2 }, { movingHead: true },
  ]) {
    const f = target({ archive, ...settings });
    await assert.rejects(plan(f, archive), (err) =>
      err instanceof VaultGitHubError && err.status === 409);
    assert.equal(f.calls.filter((value) =>
      value === '/git/ref/heads/main').length, 2);
  }
});

test('M74 rejects truncated/oversized/untrusted target tree and keeps source text out of output', async () => {
  const archive = await sourceArchive();
  const broken = [
    { truncated: true },
    { badTree: (items) => [...items, {
      path: 'quick-notes/folder/entry.json', type: 'blob',
      mode: '100644', sha: H('nested'),
    }] },
    { badTree: (items) => [...items, {
      path: 'airnotes/stray.txt', type: 'blob',
      mode: '100644', sha: H('stray'),
    }] },
    { badTree: (items) => [...items, {
      path: 'notes/' + randomUUID() + '.json', type: 'blob',
      mode: '120000', sha: H('symlink'),
    }] },
    { badTree: (items) => [...items, {
      path: 'airnotes/' + randomUUID() + '.json', type: 'blob',
      mode: '100644', sha: H('oversized'), size: 32769,
    }] },
    { badTree: (items) => [...items, {
      path: 'notes', type: 'blob', mode: '100644', sha: H('badroot'),
    }] },
    { badTree: (items) => [...items, {
      path: 'airnotes/' + randomUUID() + '.json', type: 'tree',
      mode: '040000', sha: H('nested'),
    }] },
  ];
  for (const args of broken) {
    const f = target({ archive, ...args });
    await assert.rejects(plan(f, archive), (error) =>
      error instanceof VaultGitHubError && error.status === 409);
    assert.equal(f.draftCalls.length, 0);
  }
});

test('M74 detects duplicate target files and 301 standalone target entries without truncation', async () => {
  const archive = await sourceArchive({ notes: 0, quickNotes: 0, airNotes: 0 });
  const id = randomUUID();
  const duplicate = target({
    archive, existing: { quickNotes: [id, id] },
  });
  await assert.rejects(plan(duplicate, archive), e =>
    e instanceof VaultGitHubError && e.status === 409);
  const many = target({
    archive,
    existing: { airNotes: Array.from({ length: 301 }, () => randomUUID()) },
  });
  await assert.rejects(plan(many, archive), e =>
    e instanceof VaultGitHubError && e.status === 413);
});

test('M74 rejects unscoped/malformed MongoDB draft inventory; no false create candidates', async () => {
  const archive = await sourceArchive();
  const f = target({ archive, extraDraft: true });
  await assert.rejects(plan(f, archive), (e) =>
    e instanceof VaultGitHubError && e.status === 409);
  assert.equal(f.headReads, 1);
  const none = target({ archive });
  none.options.pendingDraftIds = async () => ['other-user-draft'];
  await assert.rejects(plan(none, archive), (e) =>
    e instanceof VaultGitHubError && e.status === 409);
});

test('M74 reports bounded 18-ID preview for >100 Notes and enforces <=100 draft-ID checks', async () => {
  const archive = await sourceArchive({
    notes: 103, quickNotes: 2, airNotes: 2,
  });
  const f = target({ archive });
  const report = await plan(f, archive);
  assert.equal(report.summary.total, 107);
  assert.equal(report.summary.createCandidates, 107);
  assert.equal(report.preview.length, 18);
  assert.equal(report.previewTruncated, true);
  assert.deepEqual(f.draftCalls.map((item) => item.ids.length),
    [100, 3, 2, 2]);
  assert.equal(JSON.stringify(report).includes('PRIVATE M74 TEST BODY'), false);
});

test('M74 immutable target read token is mandatory, and 429 is propagated untouched', async () => {
  const archive = await sourceArchive();
  const f = target({ archive });
  f.client.readOnly = false;
  await assert.rejects(plan(f, archive), TypeError);
  assert.equal(f.calls.length, 0);
  const rate = target({ archive, throwRateLimit: true });
  await assert.rejects(plan(rate, archive), (e) =>
    e instanceof VaultGitHubError && e.status === 429);
});

test('M74 route requires separate default-OFF protected staging, reads typed encrypted drafts and offers NO writer', async () => {
  const api = await readFile(new URL(
    '../app/api/vault/backup-current-resources/plan/route.js',
    import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-backup-current-resources-plan.js', import.meta.url),
    'utf8');
  for (const match of [
    /OGE_VAULT_CURRENT_RESOURCE_RESTORE_PLAN_PREVIEW === 'true'/,
    /OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true'/,
    /OGE_VAULT_STANDALONE_PREVIEW === 'true'/,
    /OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true'/,
    /oge_vault_restore_staging_/,
    /env\.OGE_STAGING_URL === env\.AUTH_URL/,
    /checkVaultStagingReadiness\(env\)\.ok/,
    /const session = await auth\(\)/,
    /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/,
    /readLimitedBody\(/,
    /MAX_VAULT_RESOURCE_BACKUP_BYTES/,
    /verifyVaultCurrentResourcesArchive\(archive\)/,
    /getVaultNoteClient\(db/,
    /readOnly: true/,
    /collection\('vault_drafts'\)/,
    /collection\('vault_standalone_drafts'\)/,
    /kind,\s*captureId: \{ \$in: ids \}/,
    /ownerId, repoId: client\.vault\.repoId/,
    /ownerVerifier/,
    /planVaultCurrentResourcesRestoreReadOnly/,
  ]) assert.match(api, match);
  assert.match(core, /sourcePrivateTextReturned: false/);
  assert.match(core, /canCommit: false, canRestore: false/);
  assert.match(core, /writesToGitHub: false, writesToMongo: false/);
  assert.doesNotMatch(api + core,
    /insertOne\(|updateOne\(|deleteOne\(|commitVaultNoteBatch|commitVaultStandaloneCapture|force: false|readFile\(/);
  assert.doesNotMatch(api, /export async function GET|export async function PUT|export async function DELETE/);
});

test('M74 offline M73 archive still cannot be imported through legacy Notes-only validator', async () => {
  const archive = await sourceArchive();
  verifyVaultCurrentResourcesArchive(archive);
  assert.equal(archive.importable, false);
  const f = target({ archive });
  const result = await plan(f, archive);
  assert.equal(result.sourceShaTrustedAsAuthorization, false);
  assert.equal(result.sourceGitHubIdentityAuthenticated, false);
  assert.equal(result.sourceNoteBlobProvenanceVerified, false);
  assert.equal(result.requiresIndependentOwnerApproval, true);
  assert.equal(result.needsFreshTargetAndDraftRecheckBeforeAnyWrite, true);
});
