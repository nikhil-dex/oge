import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { vaultNotesInventorySha256 } from '../lib/oge-vault-backup-export-chunk.js';
import { verifyVaultRestoreLocalChunkFiles } from '../lib/oge-vault-restore-local-chunks.js';
import {
  createVaultOfflineEncryptSession, openVaultOfflineEncryptedFiles,
  VAULT_OFFLINE_KDF_ITERATIONS, MAX_VAULT_OFFLINE_ENVELOPE_BYTES,
} from '../lib/oge-vault-offline-backup-crypto.js';

const sha = (x) => createHash('sha1').update(x).digest('hex');
const hash = (x) => createHash('sha256').update(x).digest('hex');
const SUBJECT = randomUUID(), SOURCE = sha('m65-source'), TARGET = sha('m65-target');
const PASSWORD = 'Several-word private recovery passphrase with length 64!';
const ID = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');
const META_KEYS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
function bytesFile(name, text) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    name, size: bytes.length,
    async arrayBuffer() {
      const copy = Buffer.from(bytes);
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
  };
}
function fixture({ count = 130, answerSize = 100,
  selected = [ID(1), ID(65)] } = {}) {
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({
      subjectId: SUBJECT, heading: 'SECRET TITLE ' + i,
      answer: 'PRIVATE ANSWER ' + 'x'.repeat(answerSize),
      tags: ['notes'], favorite: false,
    }, { id: ID(i + 1), now: '2026-11-16T17:00:00.000Z' }),
    sha: sha('real-blob-' + i),
  }));
  const inventory = vaultNotesInventorySha256(notes.map(
    ({ id, sha: noteSha }) => ({ id, sha: noteSha })));
  const parts = [];
  for (let offset = 0; offset < notes.length || offset === 0; offset += 64) {
    const part = notes.slice(offset, offset + 64);
    const hasMore = offset + part.length < notes.length;
    parts.push({
      format: 'oge-vault-notes-backup-chunk', version: 1,
      scope: 'current-github-notes-only',
      snapshot: SOURCE, totalNotes: notes.length,
      inventorySha256: inventory,
      offset, count: part.length,
      afterId: offset ? notes[offset - 1].id : null,
      nextAfterId: hasMore ? part.at(-1).id : null,
      hasMore,
      coverage: {
        notes: 'partial-immutable-snapshot-chunk',
        historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      },
      notes: part, chunkSha256: hash(JSON.stringify(part)),
      completeBackup: false, importableAsLegacyBackup: false,
    });
  }
  const selection = selected.map((id) => {
    const note = notes.find((item) => item.id === id);
    return {
      id, sha: note.sha,
      contentDigest: hash(JSON.stringify(
        META_KEYS.map((key) => note[key]))),
      subjectId: note.subjectId,
    };
  });
  const review = {
    sourceSnapshot: SOURCE, inventoryDigest: inventory,
    targetHead: TARGET, selectedIdsText: selected.join('\n'),
    fingerprint: hash(JSON.stringify({
      sourceSnapshot: SOURCE, sourceInventorySha256: inventory,
      targetHead: TARGET, selected: selection,
    })),
  };
  return { parts, review };
}
async function encryptParts(parts, passphrase = PASSWORD) {
  const session = await createVaultOfflineEncryptSession(passphrase, {
    webCrypto: webcrypto,
  });
  try {
    const saved = [];
    for (let i = 0; i < parts.length; i++) {
      const sealed = await session.seal(JSON.stringify(parts[i]), i + 1);
      saved.push(bytesFile(sealed.filename, sealed.text));
    }
    return saved;
  } finally { session.close(); }
}

test('M65 AES-256-GCM encrypts, authenticates and locally decrypts every chunk without any plaintext disk file', async () => {
  const f = fixture();
  const encrypted = await encryptParts(f.parts);
  assert.equal(encrypted.length, 3);
  for (let i = 0; i < encrypted.length; i++) {
    assert.equal(encrypted[i].name, 'part-' +
      String(i + 1).padStart(4, '0') + '.oge.json');
    const text = Buffer.from(await encrypted[i].arrayBuffer()).toString('utf8');
    const envelope = JSON.parse(text);
    assert.equal(envelope.format, 'oge-vault-offline-encrypted-notes-part');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.kdf, 'PBKDF2-SHA-256');
    assert.equal(envelope.iterations, VAULT_OFFLINE_KDF_ITERATIONS);
    assert.equal(envelope.algorithm, 'AES-256-GCM');
    assert.match(envelope.salt, /^[a-f0-9]{32}$/);
    assert.match(envelope.iv, /^[a-f0-9]{24}$/);
    assert.equal(envelope.part, i + 1);
    assert.equal(text.includes('PRIVATE ANSWER'), false);
    assert.equal(text.includes('SECRET TITLE'), false);
    assert.equal(text.includes(f.parts[i].notes[0].id), false);
    assert.equal(text.includes(SOURCE), false);
    assert.equal(text.includes(PASSWORD), false);
  }
  const opened = await openVaultOfflineEncryptedFiles(
    [...encrypted].reverse(), PASSWORD, { webCrypto: webcrypto });
  assert.deepEqual(opened.map((x) => x.name),
    ['part-0001.json', 'part-0002.json', 'part-0003.json']);
  const result = await verifyVaultRestoreLocalChunkFiles(opened, f.review,
    { subtle: webcrypto.subtle });
  assert.equal(result.completeLocalSequenceVerified, true);
  assert.equal(result.reviewedSelectionFingerprintMatches, true);
  assert.equal(result.locallyVerifiedNoteCount, 130);
  assert.equal(result.importApprovedByLocalCheck, false);
  assert.equal(result.signedGitHubSourceAuthenticated, false);
  assert.equal(result.filesUploaded, false);
});

test('M65 wrong password fails AES-GCM rather than exposing note content', async () => {
  const f = fixture({ count: 1, selected: [ID(1)] });
  const files = await encryptParts(f.parts);
  const decoded = await openVaultOfflineEncryptedFiles(files,
    'a completely different recovery password', { webCrypto: webcrypto });
  await assert.rejects(decoded[0].arrayBuffer(),
    /Private offline backup is invalid/);
  await assert.rejects(verifyVaultRestoreLocalChunkFiles(decoded, f.review,
    { subtle: webcrypto.subtle }), TypeError);
});

test('M65 changed encrypted ciphertext, nonce, salt, part, length and weak KDF must fail closed', async () => {
  const f = fixture({ count: 1, selected: [ID(1)] });
  const files = await encryptParts(f.parts);
  const original = JSON.parse(Buffer.from(
    await files[0].arrayBuffer()).toString('utf8'));
  const changes = [
    (e) => { e.ciphertext = e.ciphertext.slice(0, -2) + 'AB'; },
    (e) => { e.iv = 'a'.repeat(24); },
    (e) => { e.salt = 'a'.repeat(32); },
    (e) => { e.plainBytes -= 1; },
    (e) => { e.algorithm = 'AES-128-GCM'; },
    (e) => { e.iterations = 1; },
    (e) => { e.kdf = 'SHA-1'; },
    (e) => { e.part = 2; },
    (e) => { e.extra = 'malicious'; },
    (e) => { e.version = 9; },
  ];
  for (const change of changes) {
    const envelope = structuredClone(original);
    change(envelope);
    const file = bytesFile(files[0].name, JSON.stringify(envelope));
    try {
      const decoded = await openVaultOfflineEncryptedFiles([file],
        PASSWORD, { webCrypto: webcrypto });
      await assert.rejects(decoded[0].arrayBuffer(), TypeError);
    } catch (error) {
      assert.equal(error instanceof TypeError, true);
    }
  }
});

test('M65 incomplete, duplicate, mixed-salt and renamed encrypted sets cannot become a verified backup', async () => {
  const f = fixture();
  const files = await encryptParts(f.parts);
  const other = await encryptParts(f.parts);
  for (const bad of [
    [files[0], files[2]],
    [files[0], files[0], files[2]],
    [files[0], { ...files[1], name: 'part-0004.oge.json' }, files[2]],
    [files[0], other[1], files[2]],
    [{ ...files[0], name: '../part-0001.oge.json' }, files[1], files[2]],
    [{ ...files[0], size: MAX_VAULT_OFFLINE_ENVELOPE_BYTES + 1 },
      files[1], files[2]],
  ]) await assert.rejects((async () => {
    const opened = await openVaultOfflineEncryptedFiles(
      bad, PASSWORD, { webCrypto: webcrypto });
    return verifyVaultRestoreLocalChunkFiles(opened, f.review,
      { subtle: webcrypto.subtle });
  })(), TypeError);
});

test('M65 fresh random salt and IV; closed sessions, weak passwords and repeated file parts refused', async () => {
  const a = await createVaultOfflineEncryptSession(PASSWORD,
    { webCrypto: webcrypto });
  const b = await createVaultOfflineEncryptSession(PASSWORD,
    { webCrypto: webcrypto });
  const one = JSON.parse((await a.seal('{"ok":true}', 1)).text);
  const two = JSON.parse((await b.seal('{"ok":true}', 1)).text);
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.iv, two.iv);
  await assert.rejects(a.seal('{"ok":true}', 1), TypeError);
  await assert.rejects(a.seal('{"ok":true}', 3), TypeError);
  a.close();
  await assert.rejects(a.seal('{"ok":true}', 2), TypeError);
  b.close();
  for (const weak of ['', 'short', 'x'.repeat(257)]) {
    await assert.rejects(createVaultOfflineEncryptSession(weak,
      { webCrypto: webcrypto }), TypeError);
  }
});

test('M65 encrypted 520-note (>8 MiB plaintext) backup decrypts into existing 9-part M63 verifier', async () => {
  const f = fixture({
    count: 520, answerSize: 16500,
    selected: [ID(1), ID(520)],
  });
  assert.ok(f.parts.reduce((sum, p) =>
    sum + Buffer.byteLength(JSON.stringify(p)), 0) > 8 * 1024 * 1024);
  const files = await encryptParts(f.parts);
  assert.equal(files.length, 9);
  assert.ok(files.every((file) =>
    file.name.endsWith('.oge.json') &&
    file.size <= MAX_VAULT_OFFLINE_ENVELOPE_BYTES));
  const opened = await openVaultOfflineEncryptedFiles(
    files, PASSWORD, { webCrypto: webcrypto });
  const result = await verifyVaultRestoreLocalChunkFiles(opened, f.review,
    { subtle: webcrypto.subtle });
  assert.equal(result.locallyVerifiedNoteCount, 520);
  assert.equal(result.locallyVerifiedPages, 9);
  assert.equal(result.requiresIndependentSignedOperatorProof, true);
});

test('M65 encrypted offline backup implementation is self-contained, no backend write or browser persistence', async () => {
  const { readFile } = await import('node:fs/promises');
  const code = await readFile(new URL(
    '../lib/oge-vault-offline-backup-crypto.js', import.meta.url), 'utf8');
  assert.match(code, /VAULT_OFFLINE_KDF_ITERATIONS = 600_000/);
  assert.match(code, /AES-256-GCM/);
  assert.match(code, /additionalData: aad/);
  assert.match(code, /tagLength: 128/);
  assert.match(code, /getRandomValues\(iv\)/);
  assert.match(code, /getRandomValues\(salt\)/);
  assert.doesNotMatch(code, /node:crypto|node:fs|fetch\(|MongoClient|localStorage|sessionStorage|indexedDB|commitVaultNoteBatch/);
});
