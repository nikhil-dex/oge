import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildVaultFileIndexSnapshot, diffVaultFileIndexSnapshot,
} from '../lib/oge-vault-file-index.js';

const ownerId = 'file-index-owner', repoId = 123;
const subjectId = randomUUID();
const sha = (character) => character.repeat(40);
const head = sha('a');
const scope = { ownerId, repoId };
const note = (subject = subjectId) => ({
  id: randomUUID(), subjectId: subject, sha: sha('b'),
  heading: 'SECRET TITLE', answer: 'SECRET BODY', tags: ['secret'], favorite: true,
});

test('B6 scans every GitHub page, stores only opaque file metadata', async () => {
  const notes = [...Array.from({ length: 25 }, () => note()), note()];
  const calls = [];
  const result = await buildVaultFileIndexSnapshot({}, scope, {
    pageReader: async (_client, { cursor, limit }) => {
      calls.push([cursor, limit]);
      return cursor ? { snapshot: head, total: 26, nextCursor: null, notes: notes.slice(25) } :
        { snapshot: head, total: 26, nextCursor: 'page-2', notes: notes.slice(0, 25) };
    },
    headReader: async () => head,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.totalNotes, 26);
  assert.equal(result.snapshot, head);
  assert.equal(result.files.length, 26);
  assert.deepEqual(Object.keys(result.files[0]).sort(),
    ['blobSha', 'noteId', 'ownerId', 'path', 'repoId', 'subjectId']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET TITLE|SECRET BODY|secret/);
  assert.ok(result.files.every((file) => file.path === 'notes/' + file.noteId + '.json'));
});

test('B6 accepts genuinely empty repositories but checks GitHub head', async () => {
  const result = await buildVaultFileIndexSnapshot({}, scope, {
    pageReader: async () => ({ notes: [], total: 0, snapshot: head, nextCursor: null }),
    headReader: async () => head,
  });
  assert.deepEqual(result.files, []);
  assert.equal(result.totalNotes, 0);
});

test('B6 rejects truncated, stale and duplicate GitHub pagination', async () => {
  const first = note();
  for (const bad of [
    { notes: [first], total: 2, snapshot: head, nextCursor: null },
    { notes: [], total: 1, snapshot: head, nextCursor: 'bad' },
    { notes: [first, first], total: 2, snapshot: head, nextCursor: null },
    { notes: [first], total: 501, snapshot: head, nextCursor: null },
  ]) {
    await assert.rejects(buildVaultFileIndexSnapshot({}, scope, {
      pageReader: async () => bad, headReader: async () => head,
    }), /vault-file-index-/);
  }
  await assert.rejects(buildVaultFileIndexSnapshot({}, scope, {
    pageReader: async () => ({ notes: [first], total: 1, snapshot: head, nextCursor: null }),
    headReader: async () => sha('f'),
  }), /vault-file-index-head-changed/);
});

test('B6 produces a non-destructive diff for updates and external removals', async () => {
  const id = randomUUID();
  const unchangedId = randomUUID();
  const removedId = randomUUID();
  const next = { ownerId, repoId, noteId: id, subjectId, path: 'notes/' + id + '.json',
    blobSha: sha('e') };
  const unchanged = { ownerId, repoId, noteId: unchangedId, subjectId,
    path: 'notes/' + unchangedId + '.json', blobSha: sha('b') };
  const result = diffVaultFileIndexSnapshot({ ...scope, advisoryOnly: true,
    files: [next, unchanged] }, [
    { ...next, blobSha: sha('b'), status: 'present' },
    { ...unchanged, status: 'present' },
    { ownerId, repoId, noteId: removedId, status: 'present' },
  ]);
  assert.deepEqual(result.upserts, [next]);
  assert.deepEqual(result.missing, [removedId]);
  assert.equal(result.unchanged, 1);
  assert.equal(result.advisoryOnly, true);
});

test('B6 metadata audit enforces no MongoDB note bodies or destructive operations', async () => {
  const source = await readFile(new URL('../lib/oge-vault-file-index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /deleteOne\(|deleteMany\(|updateOne\(|bulkWrite\(/);
  assert.doesNotMatch(source, /content: note\.|heading: note\.|answer: note\./);
  assert.match(source, /advisoryOnly: true/);
});
