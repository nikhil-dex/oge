import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  exportVaultNotesSnapshot as exportNotes, MAX_VAULT_BACKUP_EXPORT_BYTES,
} from '../lib/oge-vault-backup-export.js';

const H = (text) => createHash('sha1').update(text).digest('hex');
const subjectId = randomUUID(), head = H('export-commit'), treeSha = H('export-tree');
const exportVaultNotesSnapshot = (client, options = {}) =>
  exportNotes(client, { subjectVerifier: async () => true, ...options });


function fixture({ count = 3, changeHead = false, truncated = false,
  customTree, corruptBlob = false, oversized = false } = {}) {
  const notes = Array.from({ length: count }, (_, index) => {
    const id = randomUUID();
    const note = validatedNote({
      subjectId, heading: 'Fixture ' + index,
      answer: oversized ? 'x'.repeat(2300) : 'Synthetic private answer ' + index,
      tags: ['unit'], favorite: false,
    }, { id, now: '2026-11-16T00:00:00.000Z' });
    const sha = H('blob-' + id);
    return { note, id, sha };
  });
  const bySha = new Map(notes.map((entry) => [entry.sha, entry]));
  let headCalls = 0, blobCalls = 0;
  const calls = [];
  const client = {
    branch: 'main', vault: { repoId: 501 },
    async call(path, options = {}) {
      assert.ok(!options.method || options.method === 'GET',
        'Export must never send GitHub write requests');
      calls.push(path);
      if (path === '/git/ref/heads/main')
        return { object: { sha: changeHead && ++headCalls > 1 ? H('different-head') : head } };
      if (path === '/git/commits/' + head) return { tree: { sha: treeSha } };
      if (path === '/git/trees/' + treeSha + '?recursive=1')
        return { truncated, tree: customTree ?? [
          { path: 'notes', type: 'tree', sha: H('notes-tree') },
          ...notes.map(({ id, sha, note }) => ({
            path: 'notes/' + id + '.json', mode: '100644', type: 'blob',
            sha, size: Buffer.byteLength(JSON.stringify(note)),
          })),
        ] };
      if (path.startsWith('/git/blobs/')) {
        blobCalls++;
        const entry = bySha.get(path.slice('/git/blobs/'.length));
        if (!entry) throw Error('Invalid blob');
        const data = corruptBlob ? { ...entry.note, version: 9 } : entry.note;
        return { encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      }
      throw Error('Unexpected GitHub path: ' + path);
    },
  };
  return { client, notes, calls,
    get blobCalls() { return blobCalls; },
    get headCalls() { return headCalls; } };
}

test('D3b cannot export any note content without an explicit owner-subject verifier', async () => {
  await assert.rejects(exportNotes(fixture().client), TypeError);
});

test('D3b exports every current GitHub Note from a stable tree with explicit Notes-only coverage', async () => {
  const f = fixture();
  let checkedSubjectIds;
  const backup = await exportVaultNotesSnapshot(f.client, {
    subjectVerifier: async (ids) => { checkedSubjectIds = ids; return true; },
  });
  assert.equal(backup.format, 'oge-vault-notes-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.scope, 'current-github-notes-only');
  assert.equal(backup.snapshot, head);
  assert.equal(backup.totalNotes, 3);
  assert.equal(backup.notes.length, 3);
  assert.deepEqual(checkedSubjectIds, [subjectId]);
  assert.deepEqual(backup.notes.map((item) => item.id).sort(),
    f.notes.map((item) => item.id).sort());
  assert.ok(backup.notes.every((item) => item.answer.startsWith('Synthetic private')));
  assert.equal(backup.coverage.notes, 'complete-at-snapshot');
  assert.equal(backup.coverage.historicalRevisions, 'not-included');
  assert.equal(backup.coverage.encryptedDrafts, 'not-included');
  assert.equal(backup.coverage.quickNotes, 'not-included');
  assert.equal(f.blobCalls, 3);
  assert.equal(f.headCalls, 0); // Fixture only increments on simulated drift.
  assert.equal(f.calls.filter((p) => p === '/git/ref/heads/main').length, 2);
  assert.ok(f.calls.every((p) => !p.startsWith('/contents/')));
});

test('D3b does not arbitrarily cap export at the B6 derivative index 500-note limit', async () => {
  const f = fixture({ count: 501 });
  const backup = await exportVaultNotesSnapshot(f.client, {
    subjectVerifier: async (ids) => ids.length === 1 && ids[0] === subjectId,
  });
  assert.equal(backup.totalNotes, 501);
  assert.equal(f.blobCalls, 501);
  assert.equal(backup.notes.length, 501);
});

test('D3b empty notes namespace produces a verified complete, empty Notes-only archive', async () => {
  const f = fixture({ count: 0 });
  const result = await exportVaultNotesSnapshot(f.client);
  assert.equal(result.totalNotes, 0);
  assert.deepEqual(result.notes, []);
  assert.equal(result.coverage.notes, 'complete-at-snapshot');
});

test('D3b never returns an incomplete archive after a HEAD change or a truncated tree', async () => {
  await assert.rejects(exportVaultNotesSnapshot(fixture({ changeHead: true }).client),
    /vault-backup-head-changed/);
  await assert.rejects(exportVaultNotesSnapshot(fixture({ truncated: true }).client),
    /vault-backup-tree-incomplete/);
});

test('D3b fails closed on duplicate paths, foreign files and invalid Git tree modes', async () => {
  const valid = fixture();
  const item = {
    path: 'notes/' + valid.notes[0].id + '.json', mode: '100644',
    type: 'blob', sha: valid.notes[0].sha, size: 100,
  };
  for (const tree of [
    [item, item], [{ ...item, path: 'notes/../secrets.json' }],
    [{ ...item, mode: '120000' }], [{ ...item, type: 'tree' }],
    [{ ...item, size: 32769 }], [{ ...item, sha: 'invalid' }],
  ]) {
    await assert.rejects(exportVaultNotesSnapshot(
      fixture({ customTree: tree }).client),
    /vault-backup-note-tree-invalid/);
  }
});

test('D3b rejects corrupted note JSON, missing subject ownership and excessive archive bytes', async () => {
  await assert.rejects(exportVaultNotesSnapshot(fixture({ corruptBlob: true }).client),
    (error) => error instanceof VaultGitHubError &&
      error.message === 'vault-note-corrupt');
  await assert.rejects(exportVaultNotesSnapshot(fixture().client, {
    subjectVerifier: async () => false,
  }), /vault-backup-subject-unverified/);
  await assert.rejects(exportVaultNotesSnapshot(fixture({ oversized: true }).client, {
    maxBytes: 1024,
  }), /vault-backup-export-too-large/);
  assert.equal(MAX_VAULT_BACKUP_EXPORT_BYTES, 8 * 1024 * 1024);
});

test('D3b a GitHub read rate limit is never disguised as a complete archive', async () => {
  const f = fixture();
  let called = 0;
  const client = { ...f.client, async call(path, options) {
    if (path.startsWith('/git/blobs/')) {
      called++;
      throw new VaultGitHubError('github-rate-limited', 429);
    }
    return f.client.call(path, options);
  } };
  await assert.rejects(exportVaultNotesSnapshot(client), (error) =>
    error instanceof VaultGitHubError && error.status === 429);
  assert.ok(called >= 1);
});

test('D3b API is default-off, owner-scoped, non-mutating and never imports notes into MongoDB', async () => {
  const route = await readFile(new URL('../app/api/vault/backup-export/route.js', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../lib/oge-vault-backup-export.js', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_BACKUP_EXPORT_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /slug: \{ \$in: subjectIds \}/);
  assert.match(route, /Cache-Control': 'private, no-store'/);
  assert.match(route, /Content-Disposition': 'attachment/);
  assert.match(route, /exportVaultNotesSnapshot/);
  assert.match(route, /error\.status/);
  assert.match(route, /429/);
  assert.doesNotMatch(route, /export async function POST|\.collection\('notes'\)|insertOne\(|updateOne\(|deleteOne\(/);
  assert.doesNotMatch(engine, /\.collection\(|\bMongoClient\b|insertOne\(|updateOne\(|deleteOne\(/);
  assert.doesNotMatch(legacy, /exportVaultNotesSnapshot/);
});
