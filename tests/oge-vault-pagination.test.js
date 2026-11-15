import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { listVaultNotePage, validatedNote } from '../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const sha = (text) => createHash('sha1').update(text).digest('hex');
const subjectId = randomUUID();

function fixture(count) {
  const head = { value: sha('commit-1') };
  const treeSha = sha('tree-1');
  const entries = [];
  const blobs = new Map();
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const note = validatedNote({ subjectId, heading: 'Note ' + i, answer: 'GitHub-only body' }, { id });
    const text = JSON.stringify(note);
    const blobSha = sha(text);
    entries.push({ path: 'notes/' + id + '.json', type: 'blob', sha: blobSha, size: Buffer.byteLength(text) });
    blobs.set(blobSha, { encoding: 'base64', content: Buffer.from(text).toString('base64') });
  }
  const requests = [];
  const client = {
    branch: 'main',
    async call(path) {
      requests.push(path);
      if (path === '/git/ref/heads/main') return { object: { sha: head.value } };
      if (path.startsWith('/git/commits/')) return { tree: { sha: treeSha } };
      if (path === '/git/trees/' + treeSha + '?recursive=1') return { truncated: false, tree: entries };
      if (path.startsWith('/git/blobs/')) return blobs.get(path.slice('/git/blobs/'.length));
      throw new Error('Unexpected GitHub call: ' + path);
    },
  };
  return { client, head, entries, blobs, requests };
}

test('Git tree pages traverse 1201 private notes without truncation or duplicate IDs', async () => {
  const f = fixture(1201);
  let cursor = null;
  let total = 0;
  const unique = new Set();
  do {
    const result = await listVaultNotePage(f.client, { cursor, limit: 25 });
    assert.equal(result.total, 1201);
    assert.equal(result.snapshot, sha('commit-1'));
    assert.ok(result.notes.length <= 25);
    for (const note of result.notes) {
      assert.equal(note.answer, 'GitHub-only body');
      assert.ok(!unique.has(note.id));
      unique.add(note.id);
    }
    total += result.notes.length;
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(total, 1201);
  assert.equal(unique.size, 1201);
  assert.equal(f.requests.filter((path) => path.startsWith('/git/blobs/')).length, 1201);
});

test('pagination aborts when GitHub head changed between pages', async () => {
  const f = fixture(3);
  const first = await listVaultNotePage(f.client, { limit: 1 });
  assert.ok(first.nextCursor);
  f.head.value = sha('new-commit');
  await assert.rejects(() => listVaultNotePage(f.client, {
    cursor: first.nextCursor, limit: 1,
  }), (err) => err instanceof VaultGitHubError && err.message === 'vault-page-stale');
  assert.equal(f.requests.filter((path) => path.startsWith('/git/blobs/')).length, 1);
});

test('invalid or out of bounds cursor fails closed', async () => {
  const f = fixture(2);
  for (const cursor of [
    '../danger', 'not_a_cursor', Buffer.from(JSON.stringify(['f'.repeat(40), -1])).toString('base64url'),
    Buffer.from(JSON.stringify(['f'.repeat(40), 999])).toString('base64url'),
  ]) {
    await assert.rejects(() => listVaultNotePage(f.client, { cursor, limit: 1 }),
      (err) => err instanceof TypeError || err instanceof VaultGitHubError);
  }
  await assert.rejects(() => listVaultNotePage(f.client, { limit: 26 }), TypeError);
});

test('truncated, malformed, and oversized Git trees are rejected', async () => {
  const f = fixture(2);
  const original = f.client.call;
  f.client.call = (path) => path.startsWith('/git/trees/')
    ? { truncated: true, tree: f.entries } : original(path);
  await assert.rejects(() => listVaultNotePage(f.client),
    (err) => err.message === 'vault-tree-too-large');
  f.client.call = original;
  f.entries[0].path = 'notes/../escape.json';
  await assert.rejects(() => listVaultNotePage(f.client),
    (err) => err.message === 'vault-note-directory-invalid');
  f.entries[0].path = 'notes/' + randomUUID() + '.json';
  f.entries[0].size = 40000;
  await assert.rejects(() => listVaultNotePage(f.client),
    (err) => err.message === 'vault-note-directory-invalid');
});

test('paged GitHub route stays staging-only and contains no MongoDB note writes', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../app/api/vault/notes/route.js', import.meta.url), 'utf8');
  assert.match(source, /params\.get\('paged'\) === 'true'/);
  assert.match(source, /listVaultNotePage\(ctx\.client, \{ limit, cursor \}\)/);
  assert.match(source, /OGE_VAULT_NOTE_API_PREVIEW === 'true'/);
  assert.doesNotMatch(source, /collection\(['"]notes['"]\)/);
});
