import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { createVaultNotesChunkSequenceVerifier } from '../lib/oge-vault-backup-chunk-verifier.js';
import { vaultNotesInventorySha256 } from '../lib/oge-vault-backup-export-chunk.js';
import { verifyVaultRestoreLocalChunkFiles } from '../lib/oge-vault-restore-local-chunks.js';

const SHA = (v) => createHash('sha1').update(v).digest('hex');
const DIGEST = (v) => createHash('sha256').update(v).digest('hex');
const SOURCE = SHA('m63-source'), TARGET = SHA('m63-target');
const SUBJECT = randomUUID();
const KEY_FIELDS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
const fileOf = (name, value) => {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return { name, size: bytes.length,
    async arrayBuffer() {
      const copy = Buffer.from(bytes);
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
  };
};
const noteId = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

function fixture({ count = 130, answerSize = 100,
  selected = [noteId(1), noteId(65)] } = {}) {
  const notes = Array.from({ length: count }, (_, i) => {
    const id = noteId(i + 1);
    const note = validatedNote({
      subjectId: SUBJECT, heading: 'PRIVATE NOTE TITLE ' + i,
      answer: 'PRIVATE NOTE ANSWER ' + 'z'.repeat(answerSize),
      tags: ['math', 'subject'], favorite: false,
    }, { id, now: '2026-11-16T18:00:00.000Z' });
    return { ...note, sha: SHA('git-blob-' + id) };
  });
  const inventorySha256 = vaultNotesInventorySha256(notes.map((note) => ({
    id: note.id, sha: note.sha,
  })));
  const chunks = [];
  for (let offset = 0; offset < notes.length || offset === 0; offset += 64) {
    const part = notes.slice(offset, offset + 64);
    const hasMore = offset + part.length < notes.length;
    chunks.push({
      format: 'oge-vault-notes-backup-chunk', version: 1,
      scope: 'current-github-notes-only', snapshot: SOURCE,
      totalNotes: notes.length, inventorySha256,
      offset, count: part.length,
      afterId: offset === 0 ? null : notes[offset - 1].id,
      nextAfterId: hasMore ? part.at(-1).id : null,
      hasMore,
      coverage: {
        notes: 'partial-immutable-snapshot-chunk',
        historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      },
      notes: part,
      chunkSha256: DIGEST(JSON.stringify(part)),
      completeBackup: false, importableAsLegacyBackup: false,
    });
  }
  const selectedMeta = selected.map((id) => {
    const note = notes.find((item) => item.id === id);
    if (!note) return null;
    return {
      id, sha: note.sha,
      contentDigest: DIGEST(JSON.stringify(
        KEY_FIELDS.map((key) => note[key]))),
      subjectId: note.subjectId,
    };
  });
  const review = {
    sourceSnapshot: SOURCE,
    inventoryDigest: inventorySha256,
    targetHead: TARGET,
    fingerprint: DIGEST(JSON.stringify({
      sourceSnapshot: SOURCE,
      sourceInventorySha256: inventorySha256,
      targetHead: TARGET,
      selected: selectedMeta,
    })),
    selectedIdsText: selected.join('\n'),
  };
  const files = chunks.map((chunk, i) =>
    fileOf('part-' + String(i + 1).padStart(4, '0') + '.json', chunk));
  return { chunks, files, notes, review };
}
const verify = (files, review) =>
  verifyVaultRestoreLocalChunkFiles(files, review,
    { subtle: webcrypto.subtle });

test('M63 local SHA-256 sequence and reviewed M57 selection fingerprint match server verifier for 130 notes', async () => {
  const f = fixture();
  const server = createVaultNotesChunkSequenceVerifier();
  for (const chunk of f.chunks) server.accept(chunk);
  assert.equal(server.finish().verifiedCompleteNotesSnapshot, true);
  const result = await verify([...f.files].reverse(), f.review);
  assert.equal(result.completeLocalSequenceVerified, true);
  assert.equal(result.reviewedSelectionFingerprintMatches, true);
  assert.equal(result.locallyVerifiedPages, 3);
  assert.equal(result.locallyVerifiedNoteCount, 130);
  assert.equal(result.selectedNoteCount, 2);
  assert.equal(result.privateNoteTextReturned, false);
  assert.equal(result.signedGitHubSourceAuthenticated, false);
  assert.equal(result.destinationGitHubHeadVerified, false);
  assert.equal(result.importApprovedByLocalCheck, false);
  assert.equal(result.canWriteGitHub, false);
  assert.equal(result.filesUploaded, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE NOTE'), false);
});

test('M63 520-note >8 MiB complete private chunk review remains locally bounded', async () => {
  const f = fixture({
    count: 520, answerSize: 16500,
    selected: [noteId(1), noteId(520)],
  });
  assert.ok(f.files.reduce((n, file) => n + file.size, 0) >
    8 * 1024 * 1024);
  assert.equal(f.files.length, 9);
  const result = await verify(f.files, f.review);
  assert.equal(result.locallyVerifiedNoteCount, 520);
  assert.equal(result.locallyVerifiedPages, 9);
});

test('M63 missing, duplicated, renamed, oversized or extra files fail before private file reads', async () => {
  const f = fixture();
  for (const bad of [
    f.files.slice(0, 2),
    [f.files[0], f.files[0], f.files[2]],
    [{ ...f.files[0], name: 'part-0002.json' },
      f.files[1], f.files[2]],
    [{ ...f.files[0], name: '../part-0001.json' },
      f.files[1], f.files[2]],
    [{ ...f.files[0], size: 4 * 1024 * 1024 + 1 },
      f.files[1], f.files[2]],
    [{ ...f.files[0], name: 'part-0001.json.exe' },
      f.files[1], f.files[2]],
    Array.from({ length: 17 }, (_, i) => ({
      ...f.files[0], name: 'part-' +
        String(i + 1).padStart(4, '0') + '.json',
    })),
  ]) await assert.rejects(verify(bad, f.review), TypeError);
});

test('M63 modified note bodies, swapped pages and forged chunk checksums are refused', async () => {
  const f = fixture();
  const edit = structuredClone(f.chunks);
  edit[1].notes[0].answer = 'MODIFIED PRIVATE ANSWER';
  await assert.rejects(verify(
    edit.map((part, i) =>
      fileOf('part-' + String(i + 1).padStart(4, '0') + '.json', part)),
    f.review), TypeError);
  edit[1].chunkSha256 = DIGEST(JSON.stringify(edit[1].notes));
  await assert.rejects(verify(
    edit.map((part, i) =>
      fileOf('part-' + String(i + 1).padStart(4, '0') + '.json', part)),
    f.review), TypeError);
  const swapped = [f.chunks[1], f.chunks[0], f.chunks[2]];
  await assert.rejects(verify(
    swapped.map((part, i) =>
      fileOf('part-' + String(i + 1).padStart(4, '0') + '.json', part)),
    f.review), TypeError);
  const tamperedInventory = structuredClone(f.chunks);
  tamperedInventory[0].inventorySha256 = 'a'.repeat(64);
  await assert.rejects(verify(
    tamperedInventory.map((part, i) =>
      fileOf('part-' + String(i + 1).padStart(4, '0') + '.json', part)),
    f.review), TypeError);
});

test('M63 mismatched target HEAD, selection order, archive source and reviewed fingerprint fail', async () => {
  const f = fixture();
  for (const change of [
    { fingerprint: 'a'.repeat(64) },
    { sourceSnapshot: SHA('wrong-snapshot') },
    { inventoryDigest: 'a'.repeat(64) },
    { targetHead: SHA('different-target') },
    { selectedIdsText: [noteId(65), noteId(1)].join('\n') },
    { selectedIdsText: noteId(140) },
  ]) await assert.rejects(verify(f.files, { ...f.review, ...change }),
    TypeError);
});

test('M63 invalid canonical note fields are rejected even if chunk hash is refreshed', async () => {
  const f = fixture({ count: 1, selected: [noteId(1)] });
  for (const update of [
    (note) => { note.heading = ' trailing '; },
    (note) => { note.tags = ['math', 'math']; },
    (note) => { note.version = 2; },
    (note) => { note.extra = 'injected'; },
    (note) => { note.subjectId = randomUUID().toUpperCase(); },
    (note) => { note.answer = ''; },
  ]) {
    const parts = structuredClone(f.chunks);
    update(parts[0].notes[0]);
    parts[0].chunkSha256 = DIGEST(JSON.stringify(parts[0].notes));
    await assert.rejects(verify([fileOf('part-0001.json', parts[0])],
      f.review), TypeError);
  }
});

test('M63 browser local chunk verifier has no network, storage, filesystem or GitHub dependencies', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL(
    '../lib/oge-vault-restore-local-chunks.js', import.meta.url), 'utf8');
  assert.match(source, /subtle\.digest\('SHA-256'/);
  assert.match(source, /TextDecoder\('utf-8', \{ fatal: true \}\)/);
  assert.match(source, /completeLocalSequenceVerified: true/);
  assert.match(source, /signedGitHubSourceAuthenticated: false/);
  assert.match(source, /requiresIndependentSignedOperatorProof: true/);
  assert.doesNotMatch(source,
    /fetch\(|localStorage|sessionStorage|indexedDB|MongoClient|getVaultNoteClient|commitVaultNoteBatch|node:crypto|node:fs/);
});
