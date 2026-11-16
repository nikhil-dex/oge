import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { commitVaultNoteBatch } from '../lib/oge-vault-batch.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (value) => createHash('sha1').update(value).digest('hex');
function fixture() {
  const files = new Map();
  let head = H('head-0');
  const commits = new Map([[head, { sha: head, tree: { sha: H('tree-0') } }]]);
  const trees = new Map([[H('tree-0'), new Map()]]);
  const failRef = { value: false };
  const client = {
    branch: 'main',
    async call(path, options = {}) {
      if (path === '/git/ref/heads/main' && !options.method) return { object: { sha: head } };
      if (path === '/git/ref/heads/main' && options.method === 'PATCH') {
        if (failRef.value) throw new VaultGitHubError('github-api-error', 422);
        if (options.body.force !== false || !commits.get(options.body.sha)?.parents.includes(head)) {
          throw new VaultGitHubError('github-api-error', 422);
        }
        head = options.body.sha;
        if (failRef.afterWrite)
          throw new VaultGitHubError('github-api-error', failRef.afterWrite === 'conflict' ? 422 : 503);
        return { object: { sha: head } };
      }
      if (path.startsWith('/git/commits/') && !options.method) return commits.get(path.slice(13));
      if (path.startsWith('/git/trees/') && !options.method) {
        const tree = trees.get(path.slice(11).split('?')[0]);
        return { truncated: false, tree: [...tree].map(([filePath, value]) => ({
          path: filePath, type: 'blob', sha: value.sha,
        })) };
      }
      if (path === '/git/trees' && options.method === 'POST') {
        const copy = new Map(trees.get(options.body.base_tree));
        for (const change of options.body.tree) {
          if (change.sha === null) copy.delete(change.path);
          else copy.set(change.path, { text: change.content, sha: H(change.content) });
        }
        const next = H('tree' + trees.size);
        trees.set(next, copy);
        return { sha: next };
      }
      if (path === '/git/commits' && options.method === 'POST') {
        const next = H('commit' + commits.size);
        commits.set(next, { sha: next, tree: { sha: options.body.tree },
          parents: options.body.parents });
        return { sha: next };
      }
      if (path.startsWith('/contents/')) {
        const filePath = path.slice(10).split('?')[0];
        const current = trees.get(commits.get(head).tree.sha).get(filePath);
        if (!current) throw new VaultGitHubError('github-api-error', 404);
        return { type: 'file', encoding: 'base64', sha: current.sha,
          content: Buffer.from(current.text).toString('base64') };
      }
      throw new Error('Unexpected GitHub request: ' + path);
    },
  };
  return { client, failRef, files, getHead: () => head, getFiles: () => trees.get(commits.get(head).tree.sha) };
}

test('one Git commit persists multiple notes atomically and verifies all content', async () => {
  const f = fixture();
  const subjectId = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const result = await commitVaultNoteBatch(f.client, [
    { action: 'create', id: a, note: { subjectId, heading: 'One', answer: 'First note' } },
    { action: 'create', id: b, note: { subjectId, heading: 'Two', answer: 'Second note' } },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(f.getFiles().size, 2);
  assert.equal(result.commitSha, f.getHead());
  assert.equal(result.results[0].answer, 'First note');
  assert.equal(result.results[1].answer, 'Second note');
  const changed = await commitVaultNoteBatch(f.client, [
    { action: 'update', id: a, sha: result.results[0].sha,
      note: { subjectId, heading: 'One edited', answer: 'Updated' } },
    { action: 'delete', id: b, sha: result.results[1].sha },
  ]);
  assert.equal(changed.results[0].createdAt, result.results[0].createdAt);
  assert.equal(changed.results[1].deleted, true);
  assert.equal(f.getFiles().size, 1);
});

test('SHA conflicts, duplicate IDs and non-fast-forward updates never publish a bad batch', async () => {
  const f = fixture();
  const subjectId = randomUUID();
  const id = randomUUID();
  const first = await commitVaultNoteBatch(f.client, [
    { action: 'create', id, note: { subjectId, heading: 'Existing', answer: 'A' } },
  ]);
  const originalHead = f.getHead();
  const change = { action: 'update', id, sha: 'f'.repeat(40),
    note: { subjectId, heading: 'Wrong', answer: 'B' } };
  await assert.rejects(() => commitVaultNoteBatch(f.client, [change]),
    (error) => error.message === 'vault-note-conflict');
  assert.equal(f.getHead(), originalHead);
  await assert.rejects(() => commitVaultNoteBatch(f.client, [
    { action: 'create', id, note: { subjectId, heading: 'Duplicate', answer: 'B' } },
  ]), (error) => error.message === 'vault-note-conflict');
  await assert.rejects(() => commitVaultNoteBatch(f.client, [
    { action: 'delete', id, sha: first.results[0].sha },
    { action: 'delete', id, sha: first.results[0].sha },
  ]), TypeError);
  f.failRef.value = true;
  await assert.rejects(() => commitVaultNoteBatch(f.client, [
    { action: 'update', id, sha: first.results[0].sha,
      note: { subjectId, heading: 'Stale', answer: 'B' } },
  ]), (error) => error.message === 'vault-note-conflict');
  assert.equal(f.getHead(), originalHead);
});

test('batch rejects oversized, invalid actions or paths before mutating Github', async () => {
  const f = fixture();
  const subjectId = randomUUID();
  const op = { action: 'create', id: randomUUID(), note: { subjectId, heading: 'X', answer: 'A' } };
  for (const batch of [[], Array(13).fill(op), [{ action: 'drop-database' }],
    [{ action: 'delete', id: '../admin', sha: 'a'.repeat(40) }]]) {
    await assert.rejects(() => commitVaultNoteBatch(f.client, batch), TypeError);
  }
  assert.equal(f.getFiles().size, 0);
});

test('batch API is disabled by default and never writes note content to MongoDB', async () => {
  const source = await readFile(new URL('../app/api/vault/batch/route.js', import.meta.url), 'utf8');
  assert.match(source, /OGE_VAULT_NOTE_API_PREVIEW !== 'true'/);
  assert.match(source, /commitVaultNoteBatch\(client, items\)/);
  assert.match(source, /ownerId, slug: subjectId/);
  assert.doesNotMatch(source, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(source, /insertOne\(/);
  assert.doesNotMatch(source, /\.updateOne\(/);
});

test('B7: GitHub ref PATCH succeeds but response is lost; verified note is saved once', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  f.failRef.afterWrite = 'timeout';
  const saved = await commitVaultNoteBatch(f.client, [{
    action: 'create', id,
    note: { subjectId, heading: 'Confirmed despite timeout', answer: 'Private note' },
  }]);
  assert.equal(saved.results.length, 1);
  assert.equal(saved.results[0].id, id);
  assert.equal(saved.commitSha, f.getHead());
  assert.equal(f.getFiles().size, 1);
});

test('B7: even a conflict-shaped lost GitHub response is verified before rejection', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  f.failRef.afterWrite = 'conflict';
  const saved = await commitVaultNoteBatch(f.client, [{
    action: 'create', id, note: { subjectId, heading: 'Safe', answer: 'Confirmed' },
  }]);
  assert.equal(saved.results[0].answer, 'Confirmed');
  assert.equal(f.getFiles().size, 1);
});

test('B7: confirmed GitHub commit still requires valid commit ancestry', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  const untrusted = { ...f.client, call: async (path, opts = {}) => {
    const response = await f.client.call(path, opts);
    if (path.startsWith('/git/commits/') && path.slice(13) !== H('head-0') &&
        !opts.method) return { ...response, parents: [H('unrelated-parent')] };
    return response;
  } };
  await assert.rejects(commitVaultNoteBatch(untrusted, [{
    action: 'create', id, note: { subjectId, heading: 'Must verify', answer: 'Parent' },
  }]), /vault-commit-unconfirmed/);
  assert.equal(f.getFiles().size, 1, 'a committed file may exist even after unconfirmed result');
});

test('B7 simulated two-device GitHub race preserves the winner and rejects stale writer', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  const first = await commitVaultNoteBatch(f.client, [{
    action: 'create', id, note: { subjectId, heading: 'Original', answer: 'Version 1' },
  }]);
  const originalSha = first.results[0].sha;
  let raceInjected = false;
  let winner;
  const delayedDevice = { ...f.client,
    async call(path, options = {}) {
      // Device B has already prepared its commit, but Device A updates the
      // branch before B's non-fast-forward protection runs.
      if (!raceInjected && path === '/git/ref/heads/main' &&
          options.method === 'PATCH') {
        raceInjected = true;
        winner = await commitVaultNoteBatch(f.client, [{
          action: 'update', id, sha: originalSha,
          note: { subjectId, heading: 'Device A', answer: 'A wins' },
        }]);
      }
      return f.client.call(path, options);
    },
  };
  await assert.rejects(commitVaultNoteBatch(delayedDevice, [{
    action: 'update', id, sha: originalSha,
    note: { subjectId, heading: 'Device B', answer: 'B stale update' },
  }]), (error) => error instanceof VaultGitHubError &&
    error.message === 'vault-note-conflict' && error.status === 409);

  assert.equal(raceInjected, true);
  assert.equal(f.getHead(), winner.commitSha);
  assert.equal(f.getFiles().size, 1);
  const note = await f.client.call('/contents/notes/' + id + '.json?ref=main');
  assert.equal(JSON.parse(Buffer.from(note.content, 'base64').toString()).answer, 'A wins');
  assert.notEqual(JSON.parse(Buffer.from(note.content, 'base64').toString()).answer,
    'B stale update');
});

test('D3b2b1 approved import never writes after a stale expected GitHub HEAD', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  const before = f.getHead();
  await assert.rejects(commitVaultNoteBatch(f.client, [{
    action: 'create', id, note: { subjectId, heading: 'From backup', answer: 'Private' },
  }], { expectedHead: H('an-old-plan-head'), preserveImportTimestamps: true }),
  (error) => error instanceof VaultGitHubError &&
    error.message === 'vault-import-target-head-changed' && error.status === 409);
  assert.equal(f.getHead(), before);
  assert.equal(f.getFiles().size, 0);
});

test('D3b2b1 approved import preserves canonical archived creation and update times', async () => {
  const f = fixture();
  const id = randomUUID(), subjectId = randomUUID();
  const createdAt = '2024-01-01T00:00:00.000Z';
  const updatedAt = '2025-02-02T00:00:00.000Z';
  const saved = await commitVaultNoteBatch(f.client, [{
    action: 'create', id, note: {
      subjectId, heading: 'Restored', answer: 'Archived content',
      tags: [], favorite: false, createdAt, updatedAt,
    },
  }], { expectedHead: f.getHead(), preserveImportTimestamps: true });
  assert.equal(saved.results[0].createdAt, createdAt);
  assert.equal(saved.results[0].updatedAt, updatedAt);
});
