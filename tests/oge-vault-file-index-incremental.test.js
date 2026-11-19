import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildIncrementalVaultFileIndexSnapshot,
  MAX_INDEX_TREE_ENTRIES, MAX_INDEX_CHANGED_BLOBS,
} from '../lib/oge-vault-file-index-incremental.js';

const identity = { ownerId: 'scale-owner', repoId: 725 };
const sha = (c) => c.repeat(40);
const snapshot = sha('a'), treeSha = sha('b'), blobSha = sha('c');
const subjectId = randomUUID();
const notes = Array.from({ length: 1201 }, () => {
  const noteId = randomUUID();
  return { noteId, subjectId, path: 'notes/' + noteId + '.json',
    blobSha, ownerId: identity.ownerId, repoId: identity.repoId,
    status: 'present' };
});

function clientFor(rows, { stale = false, truncated = false } = {}) {
  let heads = 0;
  const calls = [];
  return {
    branch: 'main', calls,
    async call(path) {
      calls.push(path);
      if (path === '/git/ref/heads/main')
        return { object: { sha: ++heads > 1 && stale ? sha('f') : snapshot } };
      if (path === '/git/commits/' + snapshot)
        return { tree: { sha: treeSha } };
      if (path === '/git/trees/' + treeSha + '?recursive=1')
        return { truncated, tree: rows.map((row) => ({
          type: 'blob', path: row.path, sha: row.blobSha, size: 1024,
        })) };
      throw Error('Unexpected GitHub request ' + path);
    },
  };
}

test('B6 scans 1201 unchanged files using one Git tree, without 1201 blob reads', async () => {
  const client = clientFor(notes);
  let blobs = 0;
  const result = await buildIncrementalVaultFileIndexSnapshot(client, identity, {
    existingRows: notes,
    reader: async () => { blobs++; throw Error('unnecessary blob read'); },
  });
  assert.equal(result.totalNotes, 1201);
  assert.equal(result.reusedFiles, 1201);
  assert.equal(result.changedBlobs, 0);
  assert.equal(blobs, 0);
  assert.equal(client.calls.length, 4);
  assert.deepEqual(Object.keys(result.files[0]).sort(),
    ['blobSha', 'noteId', 'ownerId', 'path', 'repoId', 'subjectId']);
});

test('B6 fetches changed note blobs only and updates subject metadata', async () => {
  const changed = notes.map((row, i) => i === 0 ? {
    ...row, blobSha: sha('e'),
  } : row);
  const client = clientFor(changed);
  const reads = [];
  const result = await buildIncrementalVaultFileIndexSnapshot(client, identity, {
    existingRows: notes,
    reader: async (_github, id, revision) => {
      reads.push({ id, revision });
      return { id, sha: revision, subjectId: randomUUID(),
        heading: 'private', answer: 'NEVER STORE THIS', tags: ['private'] };
    },
  });
  assert.equal(reads.length, 1);
  assert.equal(result.reusedFiles, 1200);
  assert.equal(result.changedBlobs, 1);
  assert.doesNotMatch(JSON.stringify(result), /NEVER STORE THIS|heading|answer|tags/);
});

test('B6 fails closed on first-time unbounded imports but allows many cached files', async () => {
  const client = clientFor(notes);
  await assert.rejects(buildIncrementalVaultFileIndexSnapshot(client, identity, {
    existingRows: [], reader: async () => { throw Error('should not fetch'); },
  }), /vault-file-index-bootstrap-batch-required/);
  assert.equal(MAX_INDEX_CHANGED_BLOBS, 500);
  assert.equal(MAX_INDEX_TREE_ENTRIES, 30000);
});

test('B6 rejects stale GitHub HEAD and truncated trees', async () => {
  await assert.rejects(buildIncrementalVaultFileIndexSnapshot(
    clientFor(notes, { stale: true }), identity, { existingRows: notes }),
  /vault-file-index-head-changed/);
  await assert.rejects(buildIncrementalVaultFileIndexSnapshot(
    clientFor(notes, { truncated: true }), identity, { existingRows: notes }),
  /vault-file-index-tree-too-large/);
});

test('B6 prevents unknown note paths and cache scope substitution', async () => {
  const rogue = clientFor([{ ...notes[0], path: 'notes/invalid.json' }]);
  await assert.rejects(buildIncrementalVaultFileIndexSnapshot(rogue, identity),
    /vault-file-index-tree-invalid/);
  const crossed = [{ ...notes[0], ownerId: 'other-owner' }];
  await assert.rejects(buildIncrementalVaultFileIndexSnapshot(
    clientFor([notes[0]]), identity, { existingRows: crossed }),
  /vault-file-index-cache-invalid/);
});

test('incremental scanner never mutates MongoDB or persists note content', async () => {
  const source = await readFile(new URL('../lib/oge-vault-file-index-incremental.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /insertOne\(|updateOne\(|deleteOne\(|deleteMany\(|bulkWrite\(/);
  assert.match(source, /readVaultNoteBlob/);
  assert.match(source, /vault-file-index-bootstrap-batch-required/);
});
