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
  const calls = []; let heads = 0, ownerChecks = 0, faultActive = false;
  let currentHead = HEAD;
  const historicalCommits = new Map();
  const client = { branch: 'main', vault: { repoId: 345 },
    async call(path, opts = {}) {
      assert.ok(!opts.method || opts.method === 'GET');
      calls.push(path);
      if (path === '/git/ref/heads/main') {
        heads++;
        return { object: { sha: moveHead && faultActive && heads > 1
          ? H('m55-new-head') : currentHead } };
      }
      if (path === '/git/commits/' + HEAD) return {
        tree: { sha: TREE }, parents: [],
      };
      if (path.startsWith('/git/commits/') &&
          historicalCommits.has(path.slice('/git/commits/'.length)))
        return historicalCommits.get(path.slice('/git/commits/'.length));
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { truncated: false, tree: files.map((file, n) => ({
          path: 'notes/' + file.id + '.json',
          sha: mismatchedTree && faultActive && n === 0 ? H('other-blob') : file.sha,
          type: 'blob', mode: '100644', size: file.bytes.length,
        })) };
      if (path.startsWith('/git/blobs/')) {
        if (rateLimited && faultActive) throw new VaultGitHubError('github-rate-limited', 429);
        const file = bySha.get(path.slice('/git/blobs/'.length));
        if (!file) throw new VaultGitHubError('github-api-error', 404);
        const bytes = corruptBlob && faultActive ?
          Buffer.from(JSON.stringify({ ...file.note, answer: 'FAKE' })) : file.bytes;
        return { encoding: 'base64', content: bytes.toString('base64') };
      }
      throw Error('Unexpected signed Git source call ' + path);
    },
  };
  const ownerVerifier = async () => {
    ownerChecks++;
    return !(revokeOwner && faultActive && ownerChecks > 1);
  };
  return { client, files, calls, ownerVerifier,
    advanceHistory(count, { merge = false, cycle = false,
      unrelated = false } = {}) {
      let parent = unrelated ? H('detached-parent') : HEAD;
      for (let i = 0; i < count; i++) {
        const sha = H('historical-newer-' + i);
        historicalCommits.set(sha, {
          tree: { sha: TREE },
          message: 'Later GitHub note edit',
          parents: cycle && i === count - 1
            ? [{ sha }] : merge && i === count - 1
              ? [{ sha: parent }, { sha: H('second-parent') }]
              : [{ sha: parent }],
        });
        parent = sha;
      }
      currentHead = parent;
      heads = 0; calls.length = 0;
    },
    activateFault() { faultActive = true; heads = 0; },
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
    f.activateFault();
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

for (const later of [0, 1, 3, 19, 20]) {
  test('M56 historical source accepts exactly ' + later +
    ' newer linear Git commits with raw blob content proof', async () => {
    const f = fixture({ count: 70 });
    const parts = await chunks(f);
    f.advanceHistory(later);
    const report = await verifyVaultNotesChunkGitHubSourceReadOnly(
      f.client, parts, {
        ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
      });
    assert.equal(report.commitsAfterSnapshot, later);
    assert.equal(report.historicalSourceSnapshotsSupported, true);
    assert.equal(report.sourceGitHubCommitAndAllBlobBytesVerified, true);
    assert.equal(report.sourceHistoricalSnapshotVerified, later !== 0);
    assert.equal(report.currentSourceGitHubCommitAndAllBlobBytesVerified,
      later === 0);
    assert.equal(report.verifiedNoteCount, 70);
    assert.equal(report.canCommit, false);
    assert.equal(report.authorizesRestore, false);
    assert.equal(report.canUnlockImport, false);
    assert.equal(report.canRetryAutomatically, false);
    assert.equal(f.calls.filter((path) => path.startsWith('/git/blobs/')).length, 70);
    assert.equal(f.ownerChecks, 2);
    const serialized = JSON.stringify(report);
    for (const privateData of ['PRIVATE ANSWER', 'PRIVATE TITLE', HEAD,
      SUBJECT, f.files[0].id])
      assert.equal(serialized.includes(privateData), false);
  });
}

test('M56 >20 newer commits fails before reading any private Git blobs', async () => {
  const f = fixture({ count: 70 });
  const parts = await chunks(f);
  f.advanceHistory(21);
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts, {
      ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
    }), /vault-chunk-source-history-beyond-bound/);
  assert.equal(f.calls.some((path) =>
    path.startsWith('/git/blobs/') || path.startsWith('/git/trees/')), false);
});

test('M56 existing current-only M55 proof rejects historic source without explicit opt-in', async () => {
  const f = fixture({ count: 70 });
  const parts = await chunks(f);
  f.advanceHistory(1);
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts, { ownerVerifier: f.ownerVerifier }),
  /vault-backup-chunk-snapshot-stale/);
  assert.equal(f.calls.some((path) => path.startsWith('/git/blobs/')), false);
});

for (const option of [{ merge: true }, { cycle: true }, { unrelated: true }]) {
  test('M56 rejects untrusted non-linear/cyclic/detached Git history ' +
    JSON.stringify(option), async () => {
    const f = fixture({ count: 8 });
    const parts = await chunks(f);
    f.advanceHistory(3, option);
    await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
      f.client, parts, {
        ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
      }));
    assert.equal(f.calls.some((path) =>
      path.startsWith('/git/blobs/') || path.startsWith('/git/trees/')), false);
  });
}

test('M56 forged chunk SHA-256 is rejected against the ancestor Git tree', async () => {
  const f = fixture({ count: 70 });
  const parts = await chunks(f);
  const changed = structuredClone(parts);
  changed[0].notes[0].answer = 'FORGED PRIVATE ARCHIVED CONTENT';
  changed[0].chunkSha256 = DIGEST(JSON.stringify(changed[0].notes));
  f.advanceHistory(3);
  await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, changed, {
      ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
    }), /vault-chunk-source-content-mismatch/);
});

test('M56 changed current branch HEAD or revoked signed owner during historical blob proof fails closed', async () => {
  for (const opt of [{ moveHead: true }, { revokeOwner: true }]) {
    const f = fixture({ count: 6, ...opt });
    const parts = await chunks(f);
    f.advanceHistory(2);
    f.activateFault();
    await assert.rejects(verifyVaultNotesChunkGitHubSourceReadOnly(
      f.client, parts, {
        ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
      }));
  }
});

test('M56 520 notes >8 MiB verify historical source after later Git commits', async () => {
  const f = fixture({ count: 520, answerSize: 16500 });
  const parts = await chunks(f);
  f.advanceHistory(3);
  const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(
    f.client, parts, {
      ownerVerifier: f.ownerVerifier, allowBoundedHistory: true,
    });
  assert.equal(proof.verifiedNoteCount, 520);
  assert.equal(proof.commitsAfterSnapshot, 3);
  assert.equal(proof.canCommit, false);
});
