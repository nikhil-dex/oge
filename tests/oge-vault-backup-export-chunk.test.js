import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import { exportVaultNotesSnapshot } from '../lib/oge-vault-backup-export.js';
import {
  exportVaultNotesSnapshotChunk, MAX_VAULT_BACKUP_CHUNK_NOTES,
  MAX_VAULT_BACKUP_CHUNK_BYTES,
} from '../lib/oge-vault-backup-export-chunk.js';
import { createVaultNotesChunkSequenceVerifier } from '../lib/oge-vault-backup-chunk-verifier.js';
import { validateVaultNotesImportArchive } from '../lib/oge-vault-backup-import-plan.js';
import { planVaultNotesChunkRestoreReadOnly } from '../lib/oge-vault-backup-chunk-restore-plan.js';

const H = (text) => createHash('sha1').update(text).digest('hex');
const DIGEST = (text) => createHash('sha256').update(text).digest('hex');
const SUBJECT = randomUUID(), HEAD = H('chunk-head'), TREE = H('chunk-tree');
const noteId = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

function fixture({ count = 130, answerSize = 80, moveHeadAfter = -1,
  invalidTree = false, duplicate = false, corruptBlob = false,
  denySubject = false, rateLimited = false } = {}) {
  const notes = Array.from({ length: count }, (_, i) => {
    const id = noteId(i + 1);
    const note = validatedNote({ subjectId: SUBJECT,
      heading: 'PRIVATE TITLE ' + i, answer: 'p'.repeat(answerSize),
      tags: ['notes'], favorite: false,
    }, { id, now: '2026-11-16T10:00:00.000Z' });
    return { id, note, sha: H('blob-' + id) };
  });
  const lookup = new Map(notes.map((note) => [note.sha, note]));
  let reads = 0, blobs = 0, maxConcurrent = 0, current = 0;
  const calls = [];
  const client = { branch: 'main', vault: { repoId: 678 },
    async call(path, opts = {}) {
      assert.ok(!opts.method || opts.method === 'GET');
      calls.push(path);
      if (path === '/git/ref/heads/main') {
        reads++;
        return { object: { sha: moveHeadAfter >= 0 && reads > moveHeadAfter
          ? H('external-new-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1') {
        const entries = notes.map((item) => ({
          path: 'notes/' + item.id + '.json', type: 'blob', mode: '100644',
          sha: item.sha, size: Buffer.byteLength(JSON.stringify(item.note)),
        }));
        if (invalidTree) entries[0] = { ...entries[0], mode: '120000' };
        if (duplicate) entries.push(entries[0]);
        return { truncated: false, tree: entries };
      }
      if (path.startsWith('/git/blobs/')) {
        blobs++;
        if (rateLimited) throw new VaultGitHubError('github-rate-limited', 429);
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        try {
          const entry = lookup.get(path.slice('/git/blobs/'.length));
          if (!entry) throw new Error('Synthetic unknown immutable SHA');
          const note = corruptBlob ? { ...entry.note, version: 91 } : entry.note;
          return { encoding: 'base64',
            content: Buffer.from(JSON.stringify(note)).toString('base64') };
        } finally { current--; }
      }
      throw new Error('Unexpected synthetic GitHub path ' + path);
    },
  };
  const subjectVerifier = async (ids) =>
    !denySubject && (count === 0 ? ids.length === 0 :
      ids.length === 1 && ids[0] === SUBJECT);
  return { notes, client, calls, subjectVerifier,
    get blobReads() { return blobs; }, get headReads() { return reads; },
    get maxConcurrent() { return maxConcurrent; } };
}

async function chunks(fixtureObject, opts = {}) {
  const parts = [];
  let afterId = null, snapshot = null;
  do {
    const result = await exportVaultNotesSnapshotChunk(fixtureObject.client, {
      snapshot, afterId,
      subjectVerifier: fixtureObject.subjectVerifier, ...opts,
    });
    parts.push(result);
    if (!result.hasMore) break;
    afterId = result.nextAfterId;
    snapshot = result.snapshot;
  } while (parts.length < 1000);
  return parts;
}

test('M53 exports multiple bounded chunks with consistent snapshot and full note inventory', async () => {
  const f = fixture({ count: 130 });
  const all = await chunks(f);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((part) => part.count), [64, 64, 2]);
  assert.deepEqual(all.map((part) => part.offset), [0, 64, 128]);
  assert.ok(all.every((part) => part.snapshot === HEAD &&
    part.inventorySha256 === all[0].inventorySha256 &&
    part.completeBackup === false && part.importableAsLegacyBackup === false &&
    part.coverage.notes === 'partial-immutable-snapshot-chunk'));
  assert.equal(all[0].afterId, null);
  assert.equal(all[0].hasMore, true);
  assert.equal(all[1].afterId, all[0].nextAfterId);
  assert.equal(all[2].hasMore, false);
  assert.equal(all[2].nextAfterId, null);
  assert.equal(f.blobReads, 130);
  assert.ok(f.calls.every((path) => !path.startsWith('/contents/')));
  assert.equal(MAX_VAULT_BACKUP_CHUNK_NOTES, 64);
  assert.equal(MAX_VAULT_BACKUP_CHUNK_BYTES, 4 * 1024 * 1024);
  const verifier = createVaultNotesChunkSequenceVerifier();
  for (const part of all) assert.equal(verifier.accept(part).accepted, true);
  const final = verifier.finish();
  assert.equal(final.verifiedCompleteNotesSnapshot, true);
  assert.equal(final.totalNotes, 130);
  assert.equal(final.pages, 3);
  assert.equal(final.privateTextStored, false);
  assert.equal(final.includesQuickNotes, false);
  assert.equal(final.notAnImportApproval, true);
  assert.equal(JSON.stringify(final).includes('PRIVATE TITLE'), false);
  for (const part of all)
    assert.throws(() => validateVaultNotesImportArchive(part), /vault-import-archive-invalid/);
});

test('M53 a Vault exceeding the 8 MiB full-archive cap can export verified chunks', async () => {
  const f = fixture({ count: 520, answerSize: 16500 });
  await assert.rejects(exportVaultNotesSnapshot(f.client, {
    subjectVerifier: f.subjectVerifier,
  }), (e) => e.status === 413 && e.message === 'vault-backup-export-too-large');
  assert.equal(f.blobReads, 0, 'full backup must refuse oversized known tree before downloading');
  const all = await chunks(f);
  assert.equal(all.length, 9);
  assert.ok(all.every((part) =>
    Buffer.byteLength(JSON.stringify(part)) < MAX_VAULT_BACKUP_CHUNK_BYTES));
  const verifier = createVaultNotesChunkSequenceVerifier();
  for (const part of all) verifier.accept(part);
  const report = verifier.finish();
  assert.equal(report.verifiedCompleteNotesSnapshot, true);
  assert.equal(report.totalNotes, 520);
  assert.equal(f.blobReads, 520);
  assert.ok(report.inventorySha256.length === 64);
});

test('M53 exported chunks cannot be silently truncated, reordered or swapped', async () => {
  const f = fixture({ count: 135 });
  const [a, b, c] = await chunks(f);
  for (const sequence of [[a], [a, c], [b, a, c], [a, a, c]]) {
    const verifier = createVaultNotesChunkSequenceVerifier();
    assert.throws(() => {
      for (const part of sequence) verifier.accept(part);
      verifier.finish();
    }, TypeError);
  }
  const badInventory = { ...b, inventorySha256: 'f'.repeat(64) };
  assert.throws(() => {
    const verifier = createVaultNotesChunkSequenceVerifier();
    verifier.accept(a);
    verifier.accept(badInventory);
  }, TypeError);
  const modified = structuredClone(b);
  modified.notes[0].sha = 'e'.repeat(40);
  modified.chunkSha256 = DIGEST(JSON.stringify(modified.notes));
  assert.throws(() => {
    const verifier = createVaultNotesChunkSequenceVerifier();
    verifier.accept(a); verifier.accept(modified); verifier.accept(c);
    verifier.finish();
  }, TypeError);
  const tampered = structuredClone(b);
  tampered.notes[0].answer = 'CHANGED PRIVATE BODY';
  assert.throws(() => {
    const verifier = createVaultNotesChunkSequenceVerifier();
    verifier.accept(a);
    verifier.accept(tampered);
  }, TypeError);
});

test('M53 stale snapshot or invalid cursor never exposes a chunk from a different HEAD', async () => {
  const f = fixture({ count: 70 });
  const first = await exportVaultNotesSnapshotChunk(f.client, {
    subjectVerifier: f.subjectVerifier,
  });
  const cursor = { snapshot: first.snapshot, afterId: first.nextAfterId,
    subjectVerifier: f.subjectVerifier };
  assert.equal((await exportVaultNotesSnapshotChunk(f.client, cursor)).count, 6);
  const changed = fixture({ count: 70, moveHeadAfter: 0 });
  await assert.rejects(exportVaultNotesSnapshotChunk(changed.client, cursor),
    /vault-backup-chunk-snapshot-stale/);
  assert.equal(changed.blobReads, 0);
  for (const values of [
    { afterId: first.nextAfterId },
    { snapshot: first.snapshot },
    { snapshot: first.snapshot, afterId: randomUUID() },
    { snapshot: first.snapshot, afterId: 'AAAAAAAA-0000-4000-8000-000000000040' },
  ]) {
    if (values.afterId && values.snapshot && values.afterId !== first.nextAfterId) {
      // Some random UUIDs are well-shaped but absent: rejected after index scan.
      await assert.rejects(exportVaultNotesSnapshotChunk(f.client, {
        ...values, subjectVerifier: f.subjectVerifier,
      }));
    } else {
      await assert.rejects(exportVaultNotesSnapshotChunk(f.client, {
        ...values, subjectVerifier: f.subjectVerifier,
      }), TypeError);
    }
  }
});

test('M53 rejects incomplete Git trees, moving HEAD, bad blobs and unowned subjects', async () => {
  for (const opts of [
    { invalidTree: true }, { duplicate: true }, { moveHeadAfter: 1 },
    { corruptBlob: true }, { denySubject: true }, { rateLimited: true },
  ]) {
    const f = fixture({ count: 10, ...opts });
    await assert.rejects(exportVaultNotesSnapshotChunk(f.client, {
      subjectVerifier: f.subjectVerifier,
    }), (e) => e instanceof VaultGitHubError && [409, 429, 502].includes(e.status));
  }
  const oversized = fixture({ count: 2, answerSize: 2000 });
  await assert.rejects(exportVaultNotesSnapshotChunk(oversized.client, {
    maxBytes: 1024, subjectVerifier: oversized.subjectVerifier,
  }), (e) => e.status === 413);
  await assert.rejects(exportVaultNotesSnapshotChunk(fixture().client),
    TypeError);
});

test('M53 empty tree has one complete, verified zero-note chunk', async () => {
  const f = fixture({ count: 0 });
  const all = await chunks(f);
  assert.equal(all.length, 1);
  assert.equal(all[0].count, 0);
  assert.equal(all[0].hasMore, false);
  assert.deepEqual(all[0].notes, []);
  const verifier = createVaultNotesChunkSequenceVerifier();
  verifier.accept(all[0]);
  assert.equal(verifier.finish().totalNotes, 0);
});

test('M53 new chunk HTTP endpoint is owner-scoped, default-off, non-mutating and read-only', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-export/chunk/route.js', import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-backup-export-chunk.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_BACKUP_EXPORT_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /readOnly: true/);
  assert.match(route, /Content-Disposition': 'attachment/);
  assert.match(route, /Cache-Control': 'private, no-store'/);
  assert.match(route, /repoId !== client\.vault\.repoId/);
  assert.match(route, /installationId !== client\.vault\.installationId/);
  assert.match(route, /slug: \{ \$in: subjectIds \}/);
  assert.doesNotMatch(route + core,
    /\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch|collection\('notes'\)/);
  assert.doesNotMatch(route, /export async function POST|export async function PUT/);
});

function restoreTarget({ existingIds = [], headDrift = false,
  corruptTree = false, rejectOwner = false, draftIds = [],
  rejectSubject = false } = {}) {
  const TARGET = H('synthetic-target-head'), TARGET_TREE = H('synthetic-target-tree');
  const calls = [], checkedDraftChunks = [];
  let heads = 0, owners = 0;
  const client = { branch: 'main', vault: { repoId: 678 },
    async call(path, opts = {}) {
      assert.ok(!opts.method || opts.method === 'GET', 'read-only restore plan');
      calls.push(path);
      if (path === '/git/ref/heads/main')
        return { object: { sha: headDrift && ++heads > 1
          ? H('external-target-change') : TARGET } };
      if (path === '/git/commits/' + TARGET)
        return { tree: { sha: TARGET_TREE } };
      if (path === '/git/trees/' + TARGET_TREE + '?recursive=1')
        return { truncated: corruptTree, tree: existingIds.map((id) => ({
          path: 'notes/' + id + '.json', type: 'blob',
          mode: '100644', sha: H('remote-target-' + id), size: 300,
        })) };
      throw new Error('Unexpected target call: ' + path);
    } };
  return {
    client, calls, checkedDraftChunks,
    subjectVerifier: async (ids) => !rejectSubject &&
      ids.every((id) => id === SUBJECT),
    ownerVerifier: async () => { owners++; return !rejectOwner || owners === 1; },
    pendingDraftIds: async (ids) => {
      checkedDraftChunks.push(ids);
      return ids.filter((id) => draftIds.includes(id));
    },
    get ownerChecks() { return owners; },
  };
}

test('M54 full 520-note >8MiB backup gets a read-only metadata-only target conflict plan', async () => {
  const source = fixture({ count: 520, answerSize: 16500 });
  const parts = await chunks(source);
  const existingIds = [source.notes[0].id, source.notes[2].id];
  const draftIds = [source.notes[2].id, source.notes[3].id];
  const target = restoreTarget({ existingIds, draftIds });
  async function* sourceParts() { for (const part of parts) yield part; }
  const report = await planVaultNotesChunkRestoreReadOnly(
    target.client, sourceParts(), target);
  assert.equal(report.format, 'oge-vault-notes-chunk-restore-plan');
  assert.equal(report.fullSourceVerified, true);
  assert.equal(report.sourcePagesVerified, 9);
  assert.equal(report.sourceNotesVerified, 520);
  assert.equal(report.summary.total, 520);
  assert.equal(report.summary.draftConflicts, 2);
  assert.equal(report.summary.existingConflicts, 1);
  assert.equal(report.summary.createCandidates, 517);
  assert.deepEqual(report.preview.slice(0, 4).map((x) => x.outcome), [
    'existing-note-conflict', 'create-candidate', 'draft-conflict', 'draft-conflict',
  ]);
  assert.equal(report.preview.length, 12);
  assert.equal(report.previewTruncated, true);
  assert.equal(report.canCommit, false);
  assert.equal(report.requiresFreshOwnerApproval, true);
  assert.equal(report.sourceShaTrustedAsAuthorization, false);
  assert.equal(report.changesEncryptedDrafts, false);
  assert.equal(report.createsMongoNoteBodies, false);
  assert.ok(target.checkedDraftChunks.every((items) => items.length <= 100));
  assert.equal(target.ownerChecks, 2);
  assert.ok(target.calls.every((x) => !x.startsWith('/contents/')));
  const text = JSON.stringify(report);
  for (const secret of ['PRIVATE TITLE', 'p'.repeat(40)])
    assert.equal(text.includes(secret), false);
});

test('M54 missing, reordered, modified chunks fail before any destination GitHub read', async () => {
  const source = fixture({ count: 135 });
  const [a, b, c] = await chunks(source);
  const altered = structuredClone(b);
  altered.notes[0].answer = 'PRIVATE ALTERED SOURCE ANSWER';
  const candidates = [[a], [a, c], [b, a, c], [a, b, b], [a, altered, c]];
  for (const parts of candidates) {
    const target = restoreTarget();
    await assert.rejects(planVaultNotesChunkRestoreReadOnly(
      target.client, parts, target));
    assert.equal(target.calls.length, 0);
    assert.equal(target.ownerChecks, 0);
  }
});

test('M54 destination read-only planner rejects stale HEAD, owner changes, tree errors and unowned subjects', async () => {
  const source = fixture({ count: 70 });
  const parts = await chunks(source);
  for (const opt of [
    { headDrift: true }, { rejectOwner: true }, { rejectSubject: true },
    { corruptTree: true },
  ]) {
    const target = restoreTarget(opt);
    await assert.rejects(planVaultNotesChunkRestoreReadOnly(
      target.client, parts, target), (e) =>
        e instanceof VaultGitHubError && e.status === 409);
    assert.ok(target.calls.every((x) => !x.startsWith('/contents/')));
  }
});

test('M54 untrustworthy encrypted-draft responses or source tampering reject plan', async () => {
  const source = fixture({ count: 70 });
  const parts = await chunks(source);
  const wrongDrafts = restoreTarget();
  await assert.rejects(planVaultNotesChunkRestoreReadOnly(
    wrongDrafts.client, parts, {
      ...wrongDrafts, pendingDraftIds: async () => ['unexpected-draft'],
    }), /vault-chunk-restore-draft-check-invalid/);
  const duplicateDrafts = restoreTarget();
  await assert.rejects(planVaultNotesChunkRestoreReadOnly(
    duplicateDrafts.client, parts, {
      ...duplicateDrafts, pendingDraftIds: async (ids) => [ids[0], ids[0]],
    }), /vault-chunk-restore-draft-check-invalid/);
  const malformed = structuredClone(parts[0]);
  malformed.notes[0].subjectId = randomUUID();
  // A changed page with the ORIGINAL digest must fail integrity checks.
  // Client-recomputed digests are not an authentication mechanism, and
  // even a positive plan NEVER grants import/write authorization.
  const target = restoreTarget();
  await assert.rejects(planVaultNotesChunkRestoreReadOnly(
    target.client, [malformed, parts[1]], target));
  assert.equal(target.calls.length, 0);
});

test('M54 isolated read-only planner stores no archived note bodies or Mongo writes', async () => {
  const engine = await readFile(new URL(
    '../lib/oge-vault-backup-chunk-restore-plan.js', import.meta.url), 'utf8');
  assert.match(engine, /createVaultNotesChunkSequenceVerifier/);
  assert.match(engine, /scanVaultNotesSnapshotIndex/);
  assert.match(engine, /canCommit: false/);
  assert.match(engine, /requiresFreshOwnerApproval: true/);
  assert.doesNotMatch(engine,
    /\.updateOne\(|\.insertOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
  assert.doesNotMatch(engine, /notes\.push\(note\)/);
});
