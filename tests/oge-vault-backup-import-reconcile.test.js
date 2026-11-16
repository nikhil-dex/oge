import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportApproval, approvedVaultImportCommitMessage,
} from '../lib/oge-vault-backup-import-commit.js';
import {
  reconcileApprovedVaultNotesImport, MAX_VAULT_IMPORT_RECOVERY_COMMITS,
} from '../lib/oge-vault-backup-import-reconcile.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (value) => createHash('sha1').update(value).digest('hex');
const BASE = H('import-base'), NEXT = H('import-head');
const BASE_TREE = H('import-base-tree'), NEXT_TREE = H('import-next-tree');
const SUBJECT = randomUUID();
function request(count = 2) {
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({
      heading: 'Archived ' + i, answer: 'CONFIDENTIAL_CONTENT_' + i,
      subjectId: SUBJECT, tags: ['recovered'], favorite: i % 2 === 0,
    }, { id: randomUUID(), now: '2025-08-09T00:00:00.000Z' }),
    sha: H('source-sha-' + i),
  }));
  return {
    archive: {
      format: 'oge-vault-notes-backup', version: 1,
      scope: 'current-github-notes-only',
      snapshot: H('source-commit'), totalNotes: count,
      coverage: {
        notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      }, notes,
    },
    expectedTargetHead: BASE,
    selectedIds: notes.map((note) => note.id).slice(0, 12),
    confirmation: 'IMPORT_SELECTED_NEW_NOTES',
  };
}

function fixture(body, { head: explicitHead, wrongMessage = false, wrongParent = false,
  headDrift = false, unrelatedChange = false, unapprovedExisting = false,
  corrupt = false, truncated = false, invalidSubject = false, ownerChanged = false,
  rateLimited = false, extraNote = false, laterCommits = 0,
  laterNoteChanged = false, laterNoteDeleted = false, laterOtherFileChanged = false,
  mergeCommit = false, cycle = false } = {}) {
  const approved = validateVaultNotesImportApproval(body);
  const calls = [];
  let headReads = 0;
  const files = approved.selected.map((note, i) => ({
    path: 'notes/' + note.id + '.json', type: 'blob', mode: '100644',
    sha: H('committed-' + i), size: 256,
  }));
  const baseLeaves = [{ path: 'README.md', type: 'blob', mode: '100644', sha: H('readme') }];
  if (unapprovedExisting) baseLeaves.push(files[0]);
  const nextLeaves = [
    ...baseLeaves.filter((item) => !unapprovedExisting || item.path !== files[0].path),
    ...files,
  ];
  if (unrelatedChange) nextLeaves[0] = { ...nextLeaves[0], sha: H('readme-modified') };
  if (extraNote) nextLeaves.push({
    path: 'extra.md', type: 'blob', mode: '100644', sha: H('extra'),
  });

  const laterIds = Array.from({ length: laterCommits }, (_, i) => H('later-' + i));
  const head = explicitHead ?? (laterIds.at(-1) || NEXT);
  const snapshots = new Map([
    [BASE_TREE, baseLeaves], [NEXT_TREE, nextLeaves],
  ]);
  const commits = new Map([
    [BASE, { tree: { sha: BASE_TREE }, parents: [] }],
    [NEXT, {
      tree: { sha: NEXT_TREE },
      parents: [{ sha: wrongParent ? H('other-base') : BASE }],
      message: wrongMessage ? 'Unrelated commit' : approvedVaultImportCommitMessage(approved),
    }],
    [H('other-base'), { tree: { sha: BASE_TREE }, parents: [{ sha: BASE }],
      message: 'Unrelated parent' }],
    [H('new-commit'), { tree: { sha: NEXT_TREE }, parents: [{ sha: BASE }],
      message: 'Unrelated head' }],
  ]);
  for (let i = 0; i < laterIds.length; i++) {
    const previous = i === 0 ? NEXT : laterIds[i - 1];
    const treeSha = H('later-tree-' + i);
    const leaves = nextLeaves.map((entry) => ({ ...entry }));
    if (laterNoteChanged) {
      const notePath = files[0].path;
      const index = leaves.findIndex((item) => item.path === notePath);
      if (index >= 0) leaves[index] = { ...leaves[index], sha: H('edited-current-note') };
    }
    if (laterNoteDeleted) {
      const index = leaves.findIndex((item) => item.path === files[0].path);
      if (index >= 0) leaves.splice(index, 1);
    }
    if (laterOtherFileChanged) {
      leaves[0] = { ...leaves[0], sha: H('readme-later-revision') };
    }
    snapshots.set(treeSha, leaves);
    commits.set(laterIds[i], {
      tree: { sha: treeSha }, parents: mergeCommit && i === laterIds.length - 1
        ? [{ sha: previous }, { sha: H('merge-parent') }]
        : [{ sha: cycle && i === laterIds.length - 1 ? laterIds[i] : previous }],
      message: 'Ordinary GitHub edit ' + i,
    });
  }
  const client = {
    branch: 'main', vault: { repoId: 8 },
    async call(path, opts = {}) {
      calls.push({ path, method: opts.method || 'GET' });
      if (rateLimited) throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main') {
        headReads++;
        return { object: { sha: headDrift && headReads > 1 ? H('drift') : head } };
      }
      if (path.startsWith('/git/commits/'))
        return commits.get(path.slice('/git/commits/'.length)) ||
          { tree: { sha: NEXT_TREE }, parents: [{ sha: BASE }],
            message: 'Unrelated history' };
      if (path.startsWith('/git/trees/'))
        return { truncated,
          tree: snapshots.get(path.slice('/git/trees/'.length).split('?')[0]) };
      throw Error('Unexpected GitHub operation ' + path);
    },
  };
  const opts = {
    subjectVerifier: async () => !invalidSubject,
    ownerVerifier: async () => !ownerChanged,
    blobReader: async (_github, id, sha) => {
      const found = approved.selected.find((note) => note.id === id);
      return { ...found, sha, answer: corrupt ? 'Wrong archived content' : found.answer };
    },
  };
  return { client, opts, calls, laterIds };
}

test('D3b2b2b lost response is confirmed only from approved commit marker, parent and exact immutable blobs', async () => {
  const body = request(3), f = fixture(body);
  const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
  assert.equal(result.confirmed, true);
  assert.equal(result.commitSha, NEXT);
  assert.equal(result.importedCount, 3);
  assert.equal(result.readOnly, true);
  assert.equal(result.safeToRetryAutomatically, false);
  assert.equal(result.encryptedDraftsChanged, false);
  assert.ok(f.calls.every((entry) => entry.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(result), /CONFIDENTIAL_CONTENT_|Archived /);
});

test('D3b2b2b unchanged or advanced GitHub HEAD never claims a successful import', async () => {
  for (const options of [{ head: BASE }, { head: H('new-commit') },
    { wrongMessage: true }, { wrongParent: true }, { headDrift: true }]) {
    const body = request(1), f = fixture(body, options);
    const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
    assert.equal(result.confirmed, false);
    assert.equal(result.safeToRetryAutomatically, false);
  }
});

test('D3b2b2b unapproved data changes, pre-existing note and mismatched blobs fail confirmation', async () => {
  for (const options of [
    { unrelatedChange: true }, { extraNote: true },
    { unapprovedExisting: true }, { corrupt: true },
  ]) {
    const body = request(2), f = fixture(body, options);
    const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
    assert.equal(result.confirmed, false);
  }
});

test('D3b2b2b invalid GitHub tree, wrong account and rate limit fail closed', async () => {
  for (const options of [{ truncated: true }, { invalidSubject: true },
    { ownerChanged: true }, { rateLimited: true }]) {
    const body = request(1), f = fixture(body, options);
    await assert.rejects(() => reconcileApprovedVaultNotesImport(f.client, body, f.opts));
  }
});

test('D3b2b2b digest differs for modified private note content and exact approved HEAD', () => {
  const body = request(1);
  const first = approvedVaultImportCommitMessage(validateVaultNotesImportApproval(body));
  const revised = JSON.parse(JSON.stringify(body));
  revised.archive.notes[0].answer = 'Changed private content';
  const second = approvedVaultImportCommitMessage(validateVaultNotesImportApproval(revised));
  assert.match(first, /^Restore OgeNotes backup [a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(body.archive.notes[0].answer), false);
  const differentBase = { ...body, expectedTargetHead: H('different-destination') };
  assert.notEqual(first, approvedVaultImportCommitMessage(
    validateVaultNotesImportApproval(differentBase)));
});

test('D3b2b2b reconciliation route is read-only, signed and default-off', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-import/reconcile/route.js', import.meta.url), 'utf8');
  const engine = await readFile(new URL(
    '../lib/oge-vault-backup-import-reconcile.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /readLimitedBody/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route + engine,
    /\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
});

test('D3b2b2c advanced HEAD recovers exact import through later GitHub commits', async () => {
  const body = request(3);
  for (const commits of [1, 3, MAX_VAULT_IMPORT_RECOVERY_COMMITS - 1]) {
    const f = fixture(body, { laterCommits: commits });
    const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
    assert.equal(result.confirmed, true);
    assert.equal(result.commitSha, NEXT, 'verified historical import, not the newer HEAD');
    assert.equal(result.currentHead, f.laterIds.at(-1));
    assert.equal(result.commitsAfterImport, commits);
    assert.equal(result.currentNotesUnchanged, 3);
    assert.equal(result.currentNotesChanged, 0);
    assert.equal(result.safeToRetryAutomatically, false);
    assert.ok(f.calls.every((entry) => entry.method === 'GET'));
  }
});

test('D3b2b2c confirmed historical import distinguishes later edits and deletions', async () => {
  for (const options of [
    { laterCommits: 3, laterNoteChanged: true },
    { laterCommits: 1, laterNoteDeleted: true },
    { laterCommits: 2, laterOtherFileChanged: true },
  ]) {
    const body = request(2), f = fixture(body, options);
    const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
    assert.equal(result.confirmed, true);
    assert.equal(result.importedCount, 2);
    assert.equal(result.currentNotesChanged, options.laterOtherFileChanged ? 0 : 1);
    assert.equal(result.currentNotesUnchanged, options.laterOtherFileChanged ? 2 : 1);
    assert.equal(result.currentHead, f.laterIds.at(-1));
  }
});

test('D3b2b2c never confirms a commit beyond the fixed ancestry budget', async () => {
  const body = request(1);
  const f = fixture(body, { laterCommits: MAX_VAULT_IMPORT_RECOVERY_COMMITS });
  const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
  assert.equal(result.confirmed, false);
  assert.equal(result.safeToRetryAutomatically, false);
  assert.equal(result.reason, 'approved-import-not-proven-in-bounded-history');
  assert.ok(f.calls.filter((call) => call.path.startsWith('/git/commits/')).length <=
    MAX_VAULT_IMPORT_RECOVERY_COMMITS);
  assert.equal(f.calls.filter((call) => call.path.startsWith('/git/trees/')).length, 0);
});

test('D3b2b2c rejects merged, cyclic and misattributed GitHub ancestry', async () => {
  const body = request(2);
  const merged = fixture(body, { laterCommits: 2, mergeCommit: true });
  const pending = await reconcileApprovedVaultNotesImport(merged.client, body, merged.opts);
  assert.equal(pending.confirmed, false);
  assert.equal(pending.reason, 'github-ancestry-non-linear-or-incomplete');
  const cycle = fixture(body, { laterCommits: 1, cycle: true });
  await assert.rejects(reconcileApprovedVaultNotesImport(cycle.client, body, cycle.opts),
    /vault-import-reconcile-ancestry-invalid/);
  const wrongParent = fixture(body, { laterCommits: 2, wrongParent: true });
  assert.equal((await reconcileApprovedVaultNotesImport(
    wrongParent.client, body, wrongParent.opts)).confirmed, false);
  const wrongMessage = fixture(body, { laterCommits: 2, wrongMessage: true });
  assert.equal((await reconcileApprovedVaultNotesImport(
    wrongMessage.client, body, wrongMessage.opts)).confirmed, false);
});

test('D3b2b2c catches HEAD drift, rate limit and invalid later trees without false success', async () => {
  const body = request(1);
  for (const options of [{ laterCommits: 2, headDrift: true },
    { laterCommits: 3, rateLimited: true }]) {
    const f = fixture(body, options);
    if (options.rateLimited) {
      await assert.rejects(reconcileApprovedVaultNotesImport(f.client, body, f.opts),
        (error) => error.status === 429);
    } else {
      const result = await reconcileApprovedVaultNotesImport(f.client, body, f.opts);
      assert.equal(result.confirmed, false);
    }
  }
  const broken = fixture(body, { laterCommits: 1, truncated: true });
  await assert.rejects(reconcileApprovedVaultNotesImport(broken.client, body, broken.opts),
    /vault-import-reconcile-tree-incomplete/);
});

