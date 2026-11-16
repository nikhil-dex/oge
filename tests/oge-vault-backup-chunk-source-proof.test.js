import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { exportVaultNotesSnapshotChunk } from '../lib/oge-vault-backup-export-chunk.js';
import { verifyVaultNotesChunkGitHubSourceReadOnly } from '../lib/oge-vault-backup-chunk-source-proof.js';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (s) => createHash('sha1').update(s).digest('hex');
const DIGEST = (v) => createHash('sha256').update(v).digest('hex');
const HEAD = H('m55-current-head'), TREE = H('m55-current-tree');
const SUBJECT = randomUUID();
const idFor = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');
const blobSha = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0'))
  .update(bytes).digest('hex');

function fixture({ count = 130, answerSize = 70, moveHead = false,
  revokeOwner = false, corruptBlob = false, rateLimited = false,
  mismatchedTree = false } = {}) {
  const files = Array.from({ length: count }, (_, i) => {
    const id = idFor(i + 1);
    const note = validatedNote({ subjectId: SUBJECT, heading: 'PRIVATE TITLE ' + i,
      answer: 'PRIVATE ANSWER ' + 'x'.repeat(answerSize), tags: [], favorite: false,
    }, { id, now: '2026-11-16T12:00:00.000Z' });
    const bytes = Buffer.from(JSON.stringify(note, null, 2) + '\n');
    return { id, note, bytes, sha: blobSha(bytes) };
  });
  const bySha = new Map(files.map((file) => [file.sha, file]));
  const calls = []; let heads = 0, ownerChecks = 0;
  const client = { branch: 'main', vault: { repoId: 345 },
    async call(path, opts = {}) {
      assert.ok(!opts.method || opts.method === 'GET');
      calls.push(path);
      if (path === '/git/ref/heads/main') {
        heads++;
        return { object: { sha: moveHead && heads > 1
          ? H('m55-new-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { truncated: false, tree: files.map((file, n) => ({
          path: 'notes/' + file.id + '.json',
          sha: mismatchedTree && n === 0 ? H('other-blob') : file.sha,
          type: 'blob', mode: '100644', size: file.bytes.length,
        })) };
      if (path.startsWith('/git/blobs/')) {
        if (rateLimited) throw new VaultGitHubError('github-rate-limited', 429);
        const file = bySha.get(path.slice('/git/blobs/'.length));
        if (!file) throw new VaultGitHubError('github-api-error', 404);
        const bytes = corruptBlob ?
          Buffer.from(JSON.stringify({ ...file.note, answer: 'FAKE' })) : file.bytes;
        return { encoding: 'base64', content: bytes.toString('base64') };
      }
      throw Error('Unexpected signed Git source call ' + path);
    },
  };
  const ownerVerifier = async () => {
    ownerChecks++;
    return !(revokeOwner && ownerChecks > 1);
  };
  return { client, files, calls, ownerVerifier,
    get ownerChecks() { return ownerChecks; } };
}

async function chunks(f) {
  const all = [];
  let snapshot = null, afterId = null;
  do {
    const page = await exportVaultNotesSnapshotChunk(f.client, {
      snapshot, afterId, subjectVerifier: async () => true,
    });
    all.push(page);
    if (!page.hasMore) break;
    snapshot = page.snapshot; afterId = page.nextAfterId;
  } while (all.length < 17);
  f.calls.length = 0;
  return all;
}

test('M55 signed current Git source verifies ALL real Git SHA-1 blob bytes and content without leaking text', async () => {
  const f = fixture({ count: 130 });
  const parts = await chunks(f);
  assert.equal(parts.length, 3);
  const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts, { ownerVerifier: f.ownerVerifier });
  assert.equal(proof.currentSourceGitHubCommitAndAllBlobBytesVerified, true);
  assert.equal(proof.inventoryAndChunkSequenceVerified, true);
  assert.equal(proof.verifiedNoteCount, 130);
  assert.equal(proof.verifiedPages, 3);
  assert.equal(proof.authorizesRestore, false);
  assert.equal(proof.canCommit, false);
  assert.equal(proof.historicalSourceSnapshotsSupported, false);
  assert.equal(proof.privateNoteTextReturned, false);
  assert.equal(f.ownerChecks, 2);
  assert.equal(f.calls.filter((p) => p.startsWith('/git/blobs/')).length, 130);
  assert.ok(f.calls.every((p) => !p.startsWith('/contents/')));
  const text = JSON.stringify(proof);
  for (const sensitive of [HEAD, SUBJECT, f.files[0].id,
    'PRIVATE ANSWER', 'PRIVATE TITLE']) assert.equal(text.includes(sensitive), false);
});

test('M55 large >8MiB 520-note chunk source is fully verified with bounded metadata', async () => {
  const f = fixture({ count: 520, answerSize: 16500 });
  const parts = await chunks(f);
  assert.equal(parts.length, 9);
  assert.ok(parts.reduce((bytes, p) =>
    bytes + Buffer.byteLength(JSON.stringify(p)), 0) > 8 * 1024 * 1024);
  const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, (async function* () {
      for (const part of parts) yield part;
    })(), { ownerVerifier: f.ownerVerifier });
  assert.equal(proof.verifiedNoteCount, 520);
  assert.equal(proof.verifiedPages, 9);
  assert.equal(proof.canCommit, false);
});

test('M55 checksum-forged private note text cannot pass authenticated Git blob proof', async () => {
  const f = fixture({ count: 68 });
  const parts = await chunks(f);
  const changed = structuredClone(parts);
  changed[0].notes[0].answer = 'ATTACKER REPLACED NOTE BODY';
  changed[0].chunkSha256 = DIGEST(JSON.stringify(changed[0].notes));
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, changed, { ownerVerifier: f.ownerVerifier }),
  (err) => err.status === 409 && err.message === 'vault-chunk-source-content-mismatch');
});

test('M55 forged blob SHA and matching recomputed page/inventory SHA-256 fail before source blob reads', async () => {
  const f = fixture({ count: 68 });
  const parts = await chunks(f);
  const forged = structuredClone(parts);
  forged[0].notes[0].sha = H('attacker-replaced-source-sha');
  const inventory = DIGEST('oge-vault-notes-inventory-v1\n' +
    forged.flatMap((part) => part.notes.map((n) => n.id + ':' + n.sha + '\n')).join(''));
  forged[0].chunkSha256 = DIGEST(JSON.stringify(forged[0].notes));
  for (const p of forged) p.inventorySha256 = inventory;
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, forged, { ownerVerifier: f.ownerVerifier }),
  /vault-chunk-source-inventory-mismatch/);
  assert.equal(f.calls.filter((p) => p.startsWith('/git/blobs/')).length, 0);
});

test('M55 incomplete or swapped private page set fails before GitHub or owner lookup', async () => {
  const f = fixture({ count: 130 });
  const parts = await chunks(f);
  for (const selected of [[parts[0]], [parts[0], parts[2]],
    [parts[1], parts[0], parts[2]]]) {
    const originalCalls = f.calls.length;
    await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
      f.client, selected, { ownerVerifier: f.ownerVerifier }));
    assert.equal(f.calls.length, originalCalls);
    assert.equal(f.ownerChecks, 0);
  }
});

test('M55 changed source HEAD, revoked session, corrupt blob and rate limit fail closed', async () => {
  for (const options of [
    { moveHead: true }, { revokeOwner: true }, { corruptBlob: true },
    { rateLimited: true }, { mismatchedTree: true },
  ]) {
    const f = fixture({ count: 3, ...options });
    const parts = await chunks(f);
    await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
      f.client, parts, { ownerVerifier: f.ownerVerifier }));
  }
});

test('M55 no owner verifier, no notes source and unverified source cannot grant restore', async () => {
  const f = fixture({ count: 0 });
  const parts = await chunks(f);
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts), TypeError);
  const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts, { ownerVerifier: f.ownerVerifier });
  assert.equal(proof.verifiedNoteCount, 0);
  assert.equal(proof.authorizesRestore, false);
});
