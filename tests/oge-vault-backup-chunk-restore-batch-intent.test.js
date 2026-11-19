import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { exportVaultNotesSnapshotChunk } from '../lib/oge-vault-backup-export-chunk.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  prepareVaultChunkRestoreBatchIntentReadOnly,
  validateVaultChunkRestoreBatchSelection,
} from '../lib/oge-vault-backup-chunk-restore-batch-intent.js';

const H = (value) => createHash('sha1').update(value).digest('hex');
const HASH = (value) => createHash('sha256').update(value).digest('hex');
const GIT_BLOB = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const SOURCE = H('m57-source-head'), SOURCE_TREE = H('m57-source-tree');
const CURRENT = H('m57-current-head'), CURRENT_TREE = H('m57-current-tree');
const SUBJECT = randomUUID();
const idFor = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

function fixture({ count = 130, answerSize = 120, laterCommits = 1,
  revoked = false, movedHead = false, corruptBlob = false,
  drafts = [], conflictIds = [],
} = {}) {
  const notes = Array.from({ length: count }, (_, i) => {
    const id = idFor(i + 1);
    const note = validatedNote({ subjectId: SUBJECT,
      heading: 'SYNTHETIC PRIVATE TITLE ' + i,
      answer: 'SYNTHETIC PRIVATE BODY ' + 'x'.repeat(answerSize),
      tags: [], favorite: false,
    }, { id, now: '2026-11-15T10:00:00.000Z' });
    const bytes = Buffer.from(JSON.stringify(note, null, 2) + '\n', 'utf8');
    return { id, note, bytes, sha: GIT_BLOB(bytes) };
  });
  const bySha = new Map(notes.map((item) => [item.sha, item]));
  let head = SOURCE, refReads = 0, ownerChecks = 0, changed = false;
  const calls = [];
  const commits = new Map([[SOURCE, {
    tree: { sha: SOURCE_TREE }, parents: [],
  }]]);
  const available = new Set(notes.filter((note) =>
    !conflictIds.includes(note.id)).map((note) => note.id));
  const client = {
    branch: 'main', vault: { repoId: 57 },
    async call(path, options = {}) {
      const method = options.method || 'GET';
      assert.equal(method, 'GET', 'No GitHub mutation is ever allowed');
      calls.push({ path, method });
      if (path === '/git/ref/heads/main') {
        refReads++;
        return { object: { sha: movedHead && changed && refReads > 2
          ? H('m57-branch-moved') : head } };
      }
      if (path.startsWith('/git/commits/')) {
        const row = commits.get(path.slice('/git/commits/'.length));
        if (!row) throw new VaultGitHubError('github-api-error', 404);
        return row;
      }
      if (path === '/git/trees/' + SOURCE_TREE + '?recursive=1' ||
          path === '/git/trees/' + CURRENT_TREE + '?recursive=1') {
        const isSource = path.includes(SOURCE_TREE);
        const entries = notes.filter((item) =>
          isSource || available.has(item.id)).map((item) => ({
          path: 'notes/' + item.id + '.json', type: 'blob',
          mode: '100644', sha: item.sha, size: item.bytes.length,
        }));
        return { truncated: false, tree: entries };
      }
      if (path.startsWith('/git/blobs/')) {
        const item = bySha.get(path.slice('/git/blobs/'.length));
        if (!item) throw new VaultGitHubError('github-api-error', 404);
        const bytes = corruptBlob && changed
          ? Buffer.from(JSON.stringify({ ...item.note, answer: 'FORGED' }))
          : item.bytes;
        return { encoding: 'base64', content: bytes.toString('base64') };
      }
      throw Error('Unexpected signed Git request ' + path);
    },
  };
  const subjectVerifier = async (subjects) =>
    subjects.length === 1 && subjects[0] === SUBJECT;
  const pendingDraftIds = async (ids) => ids.filter((id) => drafts.includes(id));
  const ownerVerifier = async () => {
    ownerChecks++;
    return !(revoked && changed && ownerChecks > 1);
  };
  async function* pages() {
    let snapshot = null, afterId = null;
    do {
      const part = await exportVaultNotesSnapshotChunk(client, {
        snapshot, afterId, subjectVerifier,
      });
      yield part;
      if (!part.hasMore) break;
      snapshot = part.snapshot;
      afterId = part.nextAfterId;
    } while (true);
  }
  async function exportPages() {
    const all = [];
    for await (const part of pages()) all.push(part);
    calls.length = 0;
    return all;
  }
  function advance() {
    let parent = SOURCE;
    for (let i = 0; i < laterCommits; i++) {
      const sha = i === laterCommits - 1 ? CURRENT : H('m57-later-' + i);
      commits.set(sha, {
        tree: { sha: i === laterCommits - 1 ? CURRENT_TREE : SOURCE_TREE },
        parents: [{ sha: parent }],
      });
      parent = sha;
    }
    head = laterCommits > 0 ? parent : SOURCE;
    refReads = 0; ownerChecks = 0; changed = true; calls.length = 0;
  }
  return { client, notes, calls, subjectVerifier, pendingDraftIds,
    ownerVerifier, exportPages, advance,
    get ownerChecks() { return ownerChecks; },
    get head() { return head; } };
}
function approval(f, pages, selectedIds) {
  return {
    confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH',
    expectedSourceSnapshot: pages[0].snapshot,
    expectedSourceInventorySha256: pages[0].inventorySha256,
    expectedTargetHead: f.head,
    selectedIds,
  };
}

test('M57 historical, verified 130-note archive yields bounded eligible create-only intent, never a write', async () => {
  const f = fixture({ count: 130, conflictIds: [idFor(1), idFor(5)] });
  const parts = await f.exportPages();
  f.advance();
  const req = approval(f, parts, [idFor(1), idFor(5)]);
  const report = await prepareVaultChunkRestoreBatchIntentReadOnly(
    f.client, parts, req, f);
  assert.equal(report.signedSourceGitBlobProofVerified, true);
  assert.equal(report.signedSourceHistoricalDepth, 1);
  assert.equal(report.sourceNotesCount, 130);
  assert.equal(report.selectedNoteCount, 2);
  assert.equal(report.summary.createCandidates, 2);
  assert.equal(report.summary.existingConflicts, 0);
  assert.equal(report.summary.draftConflicts, 0);
  assert.equal(report.eligibleForIndependentApproval, true);
  assert.equal(report.canCommit, false);
  assert.equal(report.commitAuthorized, false);
  assert.equal(report.unlockAuthorized, false);
  assert.equal(report.requiresFreshUserApproval, true);
  assert.equal(report.requiresIndependentWriteRecovery, true);
  assert.equal(report.notesChanged, false);
  assert.equal(report.draftsDeleted, false);
  assert.match(report.selectionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.ownerChecks, 3);
  assert.ok(f.calls.every((entry) => entry.method === 'GET'));
  for (const value of ['SYNTHETIC PRIVATE TITLE',
    'SYNTHETIC PRIVATE BODY', SUBJECT])
    assert.equal(JSON.stringify(report).includes(value), false);
});

test('M57 single approved batch blocks existing GitHub IDs and pending encrypted drafts', async () => {
  const f = fixture({ count: 70, drafts: [idFor(3)],
    conflictIds: [idFor(1), idFor(3)] });
  const parts = await f.exportPages(); f.advance();
  const report = await prepareVaultChunkRestoreBatchIntentReadOnly(
    f.client, parts, approval(f, parts, [idFor(1), idFor(2), idFor(3)]), f);
  assert.equal(report.summary.createCandidates, 1);
  assert.equal(report.summary.existingConflicts, 1);
  assert.equal(report.summary.draftConflicts, 1);
  assert.deepEqual(report.selections.map(({ outcome }) => outcome),
    ['create-candidate', 'existing-note-conflict', 'draft-conflict']);
  assert.equal(report.eligibleForIndependentApproval, false);
  assert.equal(report.canCommit, false);
});

test('M57 rejects forged selection, mismatched source inventory, target HEAD and wrong confirmation', async () => {
  const f = fixture({ count: 70, conflictIds: [idFor(1)] });
  const parts = await f.exportPages(); f.advance();
  const base = approval(f, parts, [idFor(1)]);
  for (const candidate of [
    { ...base, confirmation: 'IMPORT_SELECTED_NEW_NOTES' },
    { ...base, confirmation: 'RESTORE_SELECTED_NOTES' },
    { ...base, selectedIds: [] },
    { ...base, selectedIds: [idFor(1), idFor(1)] },
    { ...base, selectedIds: [idFor(999)] },
    { ...base, selectedIds: Array.from({ length: 13 }, (_, i) => idFor(i + 1)) },
    { ...base, expectedSourceSnapshot: H('forged-source') },
    { ...base, expectedSourceInventorySha256: HASH('forged-inventory') },
    { ...base, expectedTargetHead: H('obsolete-target') },
    { ...base, unknownKey: true },
  ]) {
    await assert.rejects(prepareVaultChunkRestoreBatchIntentReadOnly(
      f.client, parts, candidate, f));
  }
  assert.ok(f.calls.every((entry) => entry.method === 'GET'));
});

test('M57 missing or tampered source page is refused before any signed GitHub reads', async () => {
  const f = fixture({ count: 130, conflictIds: [idFor(1)] });
  const parts = await f.exportPages(); f.advance();
  const req = approval(f, parts, [idFor(1)]);
  for (const tampered of [
    parts.slice(0, 1),
    [parts[1], parts[0], parts[2]],
    [parts[0], parts[0], parts[2]],
    (() => { const changed = structuredClone(parts); changed[0].notes[0].answer =
      'EVIL'; return changed; })(),
  ]) {
    const before = f.calls.length;
    await assert.rejects(prepareVaultChunkRestoreBatchIntentReadOnly(
      f.client, tampered, req, f));
    assert.equal(f.calls.length, before);
  }
});

test('M57 invalid draft results, revoked session, wrong subject and drift fail closed', async () => {
  for (const { options, mutations } of [
    { options: {}, mutations: { pendingDraftIds: async () => [idFor(999)] } },
    { options: {}, mutations: { pendingDraftIds: async () => [idFor(1), idFor(1)] } },
    { options: { revoked: true }, mutations: {} },
    { options: {}, mutations: { subjectVerifier: async () => false } },
    { options: { movedHead: true }, mutations: {} },
    { options: { corruptBlob: true }, mutations: {} },
  ]) {
    const f = fixture({ count: 70, conflictIds: [idFor(1)], ...options });
    const parts = await f.exportPages(); f.advance();
    await assert.rejects(prepareVaultChunkRestoreBatchIntentReadOnly(
      f.client, parts, approval(f, parts, [idFor(1)]), { ...f, ...mutations }));
  }
});

test('M57 supports private 520-note backup >8MiB but selects only 12 notes', async () => {
  const f = fixture({
    count: 520, answerSize: 16500,
    conflictIds: Array.from({ length: 12 }, (_, i) => idFor(i + 1)),
  });
  const parts = await f.exportPages(); f.advance();
  assert.ok(parts.reduce((total, part) =>
    total + Buffer.byteLength(JSON.stringify(part), 'utf8'), 0) > 8 * 1024 * 1024);
  const approvedIds = Array.from({ length: 12 }, (_, i) => idFor(i + 1));
  const report = await prepareVaultChunkRestoreBatchIntentReadOnly(
    f.client, parts, approval(f, parts, approvedIds), f);
  assert.equal(report.sourceNotesCount, 520);
  assert.equal(report.selectedNoteCount, 12);
  assert.equal(report.summary.createCandidates, 12);
  assert.equal(report.eligibleForIndependentApproval, true);
  assert.equal(report.canCommit, false);
  assert.equal(JSON.stringify(report).includes('SYNTHETIC PRIVATE BODY'), false);
});

test('M57 selection fingerprint changes with target SHA, ordered IDs, or source commit', async () => {
  const f = fixture({ count: 70, conflictIds: [idFor(1), idFor(2)] });
  const parts = await f.exportPages(); f.advance();
  const a = await prepareVaultChunkRestoreBatchIntentReadOnly(
    f.client, parts, approval(f, parts, [idFor(1), idFor(2)]), f);
  const b = await prepareVaultChunkRestoreBatchIntentReadOnly(
    f.client, parts, approval(f, parts, [idFor(2), idFor(1)]), f);
  assert.notEqual(a.selectionFingerprint, b.selectionFingerprint);
});

test('M57 intent has no GitHub commit, Mongo note write, draft retirement or approval capability', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL(
    '../lib/oge-vault-backup-chunk-restore-batch-intent.js', import.meta.url),
  'utf8');
  assert.match(source, /verifyVaultNotesChunkGitHubSourceReadOnly/);
  assert.match(source, /scanVaultNotesSnapshotIndex/);
  assert.match(source, /canCommit: false/);
  assert.match(source, /requiresFreshUserApproval: true/);
  assert.doesNotMatch(source,
    /\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
});
