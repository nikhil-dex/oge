import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  MAX_VAULT_HISTORY_PREVIEW, listVaultNoteRevisions,
  readVaultNoteAtCommit, restoreVaultNoteRevision,
} from '../lib/oge-vault-revision-history.js';

const H = (text) => createHash('sha1').update(text).digest('hex');
const id = randomUUID(), subjectId = randomUUID();
const path = 'notes/' + id + '.json';
const oldCommit = H('old-commit'), latestCommit = H('latest-commit');
const oldBlob = H('old-blob'), latestBlob = H('latest-blob');
const oldNote = { ...validatedNote({
  subjectId, heading: 'Old study note', answer: 'Previous explanation',
  tags: ['old'], favorite: false,
}, { id, now: '2026-11-01T00:00:00.000Z' }), sha: oldBlob };
const latestNote = { ...validatedNote({
  subjectId, heading: 'Current study note', answer: 'Current explanation',
  tags: ['new'], favorite: true,
}, { id, now: '2026-11-15T00:00:00.000Z' }), sha: latestBlob };

function fixture({ commits = [latestCommit, oldCommit], deleted = [], corrupt = false,
  differentSubject = false, changeHead = false, duplicatePath = false } = {}) {
  const notes = new Map([[latestBlob, latestNote], [oldBlob, {
    ...oldNote, ...(differentSubject ? { subjectId: randomUUID() } : {}),
  }]]);
  const commitToTree = new Map([[latestCommit, H('latest-tree')], [oldCommit, H('old-tree')]]);
  const treeToBlob = new Map([[H('latest-tree'), latestBlob], [H('old-tree'), oldBlob]]);
  const deletedSet = new Set(deleted);
  let refReads = 0, writes = 0;
  const calls = [];
  const client = {
    branch: 'main', vault: { repoId: 501 },
    async call(url, options = {}) {
      calls.push({ url, method: options.method || 'GET' });
      if (options.method) { writes++; throw Error('Historical reader must not write'); }
      if (url === '/git/ref/heads/main')
        return { object: { sha: changeHead && ++refReads > 1 ? H('raced') : latestCommit } };
      if (url === '/commits?sha=' + latestCommit + '&path=' +
          encodeURIComponent(path) + '&per_page=6')
        return commits.map((sha) => ({ sha }));
      if (url.startsWith('/git/commits/')) {
        const commitSha = url.slice('/git/commits/'.length);
        return { tree: { sha: commitToTree.get(commitSha) } };
      }
      if (url.startsWith('/git/trees/')) {
        const treeSha = url.slice('/git/trees/'.length).split('?')[0];
        const blobSha = treeToBlob.get(treeSha);
        const entry = { path, type: 'blob', sha: blobSha, size: 500 };
        return { truncated: false, tree: deletedSet.has(treeSha) ? [] :
          duplicatePath ? [entry, entry] : [entry] };
      }
      if (url.startsWith('/git/blobs/')) {
        const blobSha = url.slice('/git/blobs/'.length);
        const note = notes.get(blobSha);
        return { encoding: 'base64', content: Buffer.from(JSON.stringify(
          corrupt ? { ...note, version: 99 } : Object.fromEntries(
            Object.entries(note).filter(([key]) => key !== 'sha'),
          ),
        )).toString('base64') };
      }
      throw Error('Unexpected GitHub history URL ' + url);
    },
  };
  return { client, calls, get writes() { return writes; } };
}

test('D3 GitHub revision reader returns validated historic bodies only from immutable blobs', async () => {
  const f = fixture();
  const history = await listVaultNoteRevisions(f.client, id);
  assert.equal(history.noteId, id);
  assert.equal(history.subjectId, subjectId);
  assert.equal(history.snapshot, latestCommit);
  assert.equal(history.currentSha, latestBlob);
  assert.deepEqual(history.items.map((entry) => entry.heading),
    ['Current study note', 'Old study note']);
  assert.deepEqual(history.items.map((entry) => entry.sha), [latestBlob, oldBlob]);
  assert.equal(history.items[0].isCurrent, true);
  assert.equal(history.items[1].isCurrent, false);
  assert.equal(history.limited, true);
  assert.equal(history.advisoryOnly, true);
  assert.equal(f.writes, 0);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('D3 note histories are bounded, and cannot claim to enumerate every old commit', async () => {
  const f = fixture({ commits: Array.from({ length: MAX_VAULT_HISTORY_PREVIEW + 1 },
    (_, index) => index % 2 === 0 ? latestCommit : oldCommit) });
  await assert.rejects(listVaultNoteRevisions(f.client, id),
    /vault-history-list-invalid/);
  assert.equal(MAX_VAULT_HISTORY_PREVIEW, 5);
  const normal = await listVaultNoteRevisions(fixture().client, id);
  assert.equal(normal.limited, true);
});

test('D3 refuses changed GitHub HEAD, corrupted blobs and cross-subject reused UUIDs', async () => {
  for (const [options, expected] of [
    [{ changeHead: true }, 'vault-history-stale'],
    [{ corrupt: true }, 'vault-note-corrupt'],
    [{ differentSubject: true }, 'vault-history-subject-mismatch'],
    [{ duplicatePath: true }, 'vault-history-file-invalid'],
  ]) {
    await assert.rejects(listVaultNoteRevisions(fixture(options).client, id),
      (error) => error instanceof VaultGitHubError &&
        error.message === expected);
  }
});

test('D3 missing GitHub commit list fails closed despite a present HEAD blob', async () => {
  await assert.rejects(listVaultNoteRevisions(fixture({ commits: [] }).client, id),
    /vault-history-list-invalid/);
});

test('D3 legitimate deleted historical revision is omitted rather than invented', async () => {
  const f = fixture({ deleted: [H('old-tree')] });
  const history = await listVaultNoteRevisions(f.client, id);
  assert.equal(history.items.length, 1);
  assert.equal(history.moreMayExist, true);
});

test('D3 invalid note ID, commit SHA or oversized GitHub tree never produces history', async () => {
  const f = fixture();
  await assert.rejects(readVaultNoteAtCommit(f.client, '../other', oldCommit), TypeError);
  await assert.rejects(readVaultNoteAtCommit(f.client, id, 'not-a-sha'), TypeError);
  const incomplete = {
    ...f.client,
    async call(url, options) {
      if (url.startsWith('/git/trees/')) return { truncated: true, tree: [] };
      return f.client.call(url, options);
    },
  };
  await assert.rejects(readVaultNoteAtCommit(incomplete, id, oldCommit),
    /vault-history-tree-incomplete/);
});

test('D3 explicit restore preserves current tags/favorite and requires immutable source SHA', async () => {
  const history = await listVaultNoteRevisions(fixture().client, id);
  const requests = [];
  const newSha = H('restored-blob'), restoredHead = H('restored-head');
  const result = await restoreVaultNoteRevision({}, history, {
    id, sha: latestBlob, commitSha: oldCommit, sourceSha: oldBlob,
  }, {
    currentReader: async () => latestNote,
    batchWriter: async (_client, operations) => {
      requests.push(operations);
      return { commitSha: restoredHead, results: [{
        ...latestNote, sha: newSha,
        heading: oldNote.heading, answer: oldNote.answer,
      }] };
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0].action, 'update');
  assert.equal(requests[0][0].sha, latestBlob);
  assert.equal(requests[0][0].note.subjectId, subjectId);
  assert.equal(requests[0][0].note.heading, oldNote.heading);
  assert.equal(requests[0][0].note.answer, oldNote.answer);
  assert.deepEqual(requests[0][0].note.tags, latestNote.tags);
  assert.equal(requests[0][0].note.favorite, latestNote.favorite);
  assert.equal(result.note.sha, newSha);
  assert.equal(result.commitSha, restoredHead);
  assert.equal(result.restoredFromCommit, oldCommit);
});

test('D3 stale or spoofed restore requests do not call the GitHub batch writer', async () => {
  const history = await listVaultNoteRevisions(fixture().client, id);
  let called = 0;
  const batchWriter = async () => { called++; throw Error('Should not write'); };
  for (const request of [
    { id, sha: H('stale'), commitSha: oldCommit, sourceSha: oldBlob },
    { id, sha: latestBlob, commitSha: H('unreachable'), sourceSha: oldBlob },
    { id, sha: latestBlob, commitSha: oldCommit, sourceSha: H('fake') },
    { id, sha: latestBlob, commitSha: latestCommit, sourceSha: latestBlob },
  ]) {
    await assert.rejects(restoreVaultNoteRevision({}, history, request, {
      currentReader: async () => latestNote, batchWriter,
    }), /vault-history-restore-stale|vault-history-revision-unavailable/);
  }
  await assert.rejects(restoreVaultNoteRevision({}, history, {
    id, sha: latestBlob, commitSha: oldCommit, sourceSha: oldBlob,
  }, {
    currentReader: async () => ({ ...latestNote, sha: H('newer') }),
    batchWriter,
  }), /vault-note-conflict/);
  await assert.rejects(restoreVaultNoteRevision({}, history, {
    id, sha: latestBlob, commitSha: oldCommit, sourceSha: oldBlob,
  }, {
    currentReader: async () => ({ ...latestNote,
      heading: oldNote.heading, answer: oldNote.answer }),
    batchWriter,
  }), /vault-history-content-unchanged/);
  assert.equal(called, 0);
});

test('D3 new preview API requires auth, rate limit, owner subject and encrypted-draft checks', async () => {
  const route = await readFile(new URL('../app/api/vault/revision-history/route.js', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../lib/oge-vault-revision-history.js', import.meta.url), 'utf8');
  const production = await readFile(new URL('../app/api/revision-history/route.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_REVISION_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db/);
  assert.match(route, /checkOwnerMutationLimit/);
  assert.match(route, /ownerId: ctx\.ownerId, slug: subjectId/);
  assert.match(route, /vault_drafts/);
  assert.match(route, /withVaultSubjectWrite\(/);
  assert.match(route, /restoreVaultNoteRevision\(/);
  assert.match(engine, /commitVaultNoteBatch/);
  assert.doesNotMatch(engine, /collection\(|insertOne\(|deleteOne\(|updateOne\(/);
  assert.doesNotMatch(route, /collection\(['"]notes['"]\)|collection\(['"]quickNotes['"]\)/);
  assert.doesNotMatch(production, /restoreVaultNoteRevision/);
});
