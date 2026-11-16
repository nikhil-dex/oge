import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportApproval, approvedVaultImportCommitMessage,
} from '../lib/oge-vault-backup-import-commit.js';
import { reconcileApprovedVaultNotesImport } from '../lib/oge-vault-backup-import-reconcile.js';
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

function fixture(body, { head = NEXT, wrongMessage = false, wrongParent = false,
  headDrift = false, unrelatedChange = false, unapprovedExisting = false,
  corrupt = false, truncated = false, invalidSubject = false, ownerChanged = false,
  rateLimited = false, extraNote = false } = {}) {
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
  const client = {
    branch: 'main', vault: { repoId: 8 },
    async call(path, opts = {}) {
      calls.push({ path, method: opts.method || 'GET' });
      if (rateLimited) throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main') {
        headReads++;
        return { object: { sha: headDrift && headReads > 1 ? H('drift') : head } };
      }
      if (path === '/git/commits/' + NEXT) return {
        tree: { sha: NEXT_TREE },
        parents: [{ sha: wrongParent ? H('other-base') : BASE }],
        message: wrongMessage ? 'Unrelated commit' : approvedVaultImportCommitMessage(approved),
      };
      if (path === '/git/commits/' + BASE) return { tree: { sha: BASE_TREE } };
      if (path === '/git/trees/' + BASE_TREE + '?recursive=1')
        return { truncated, tree: baseLeaves };
      if (path === '/git/trees/' + NEXT_TREE + '?recursive=1')
        return { truncated, tree: nextLeaves };
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
  return { client, opts, calls };
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
