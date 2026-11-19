import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportApproval, approvedVaultImportCommitMessage,
} from '../lib/oge-vault-backup-import-commit.js';
import { inspectVaultImportArchiveContentReadOnly } from '../lib/oge-vault-import-archive-proof.js';

const h = (s) => createHash('sha1').update(s).digest('hex');
const repoId = 811, subjectId = randomUUID();
const identity = {
  ownerId: 'private-owner-' + randomUUID(), sessionVersion: randomUUID(),
  repoId, expectedOperationId: randomUUID(),
};
const vault = { status: 'connected', repoId, installationId: 90,
  githubAccountId: '66', githubLogin: 'private', repoName: 'ogenotes-vault' };

function approval() {
  const note = validatedNote({
    heading: 'NEVER PRINT PRIVATE TITLE', answer: 'NEVER PRINT PRIVATE BODY',
    subjectId, tags: ['unit'], favorite: true,
  }, { id: randomUUID(), now: '2026-10-01T00:00:00.000Z' });
  return {
    archive: { format: 'oge-vault-notes-backup', version: 1,
      scope: 'current-github-notes-only', snapshot: h('source-head'),
      totalNotes: 1, coverage: {
        notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      }, notes: [{ ...note, sha: h('source-note-blob') }],
    },
    expectedTargetHead: h('approved-target'),
    selectedIds: [note.id], confirmation: 'IMPORT_SELECTED_NEW_NOTES',
  };
}

function mock(input, opts = {}) {
  const approved = validateVaultNotesImportApproval(input);
  const marker = approvedVaultImportCommitMessage(approved);
  const lock = {
    operationId: identity.expectedOperationId, repoId,
    state: 'github-write-possible',
    approvedHead: input.expectedTargetHead,
    selectedIds: [...input.selectedIds],
    commitMarker: marker,
    startedAt: new Date('2026-11-16T00:00:00.000Z'),
    attemptedAt: new Date('2026-11-16T00:00:03.000Z'),
  };
  const original = { vault: { ...vault }, vaultImportLock: lock };
  const mutations = [];
  let usersRead = 0, headReads = 0;
  const db = { collection(name) {
    if (name === 'users') return { async findOne() {
      usersRead++;
      if (opts.ownerMissing || (opts.changedOwner && usersRead > 1))
        return null;
      return { ...original, vaultImportLock: {
        ...lock,
        ...(opts.changedLock && usersRead > 1 ?
          { operationId: randomUUID() } : {}),
      } };
    } };
    if (name === 'subjects') return { find(filter) {
      assert.equal(filter.ownerId, identity.ownerId);
      return { async toArray() {
        return opts.noSubject ? [] : [{ slug: subjectId }];
      } };
    } };
    if (name === 'vault_drafts') return { async countDocuments(query, options) {
      assert.equal(query.ownerId, identity.ownerId);
      assert.equal(query.repoId, repoId);
      assert.equal(options.limit, 1);
      return opts.draft ? 1 : 0;
    } };
    throw Error('Unexpected collection: ' + name);
  } };
  const importedHead = h('actual-import-commit'),
    importedTree = h('import-tree'), baseTree = h('base-tree');
  const leaf = { path: 'notes/' + input.selectedIds[0] + '.json',
    type: 'blob', mode: '100644', sha: h('imported-note-blob'), size: 200 };
  const root = { path: 'README.md', type: 'blob',
    mode: '100644', sha: h('readme') };
  const calls = [];
  const client = { vault: { ...vault }, branch: 'main',
    async call(path, options = {}) {
      calls.push({ path, method: options.method || 'GET' });
      if (path === '/git/ref/heads/main') {
        headReads++;
        return { object: { sha: opts.headDrift && headReads > 1
          ? h('changed-head') : importedHead } };
      }
      if (path === '/git/commits/' + importedHead) return {
        tree: { sha: importedTree },
        parents: [{ sha: input.expectedTargetHead }],
        message: opts.wrongMessage ? 'unrelated' : marker,
      };
      if (path === '/git/commits/' + input.expectedTargetHead)
        return { tree: { sha: baseTree } };
      if (path === '/git/trees/' + baseTree + '?recursive=1')
        return { truncated: false, tree: [root] };
      if (path === '/git/trees/' + importedTree + '?recursive=1')
        return { truncated: false, tree: [root, leaf] };
      if (path === '/git/blobs/' + leaf.sha)
        return { encoding: 'base64', content: Buffer.from(JSON.stringify({
          ...approved.selected[0],
          ...(opts.corruptBlob ? { answer: 'MISMATCHED CONTENT' } : {}),
        })).toString('base64') };
      throw Error('Unexpected GitHub request: ' + path);
    },
  };
  return { db, client, lock, calls, mutations, getUserReads: () => usersRead };
}

test('M49 verifies exact immutable archived content while keeping report redacted and non-authorizing', async () => {
  const input = approval(), f = mock(input, { draft: true });
  const output = await inspectVaultImportArchiveContentReadOnly(
    f.db, identity, f.client, input);
  assert.equal(output.status, 'ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY');
  assert.equal(output.importedContentVerified, true);
  assert.equal(output.matchingSelectedDraftPresent, true);
  assert.equal(output.selectedNoteCount, 1);
  assert.equal(output.currentNotesUnchanged, 1);
  assert.equal(output.currentNotesChanged, 0);
  assert.equal(output.automaticUnlockAuthorized, false);
  assert.equal(output.operatorUnlockAuthorized, false);
  assert.equal(output.workerQuiescenceVerified, false);
  assert.equal(output.safeToRetryAutomatically, false);
  assert.equal(output.encryptedDraftsChanged, false);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
  assert.ok(f.calls.some((c) => c.path.startsWith('/git/blobs/')));
  const text = JSON.stringify(output);
  for (const secret of [identity.ownerId, identity.expectedOperationId,
    identity.sessionVersion, input.selectedIds[0], input.expectedTargetHead,
    'NEVER PRINT PRIVATE TITLE', 'NEVER PRINT PRIVATE BODY'])
    assert.equal(text.includes(secret), false);
});

test('M49 mismatched archive, approval and lock cannot query provider', async () => {
  const input = approval(), f = mock(input);
  const changed = structuredClone(input);
  changed.archive.notes[0].answer = 'changed private answer';
  const wrongSelection = structuredClone(input);
  wrongSelection.expectedTargetHead = h('other-branch-head');
  for (const request of [changed, wrongSelection]) {
    const response = await inspectVaultImportArchiveContentReadOnly(
      f.db, identity, f.client, request);
    assert.equal(response.status, 'ARCHIVE_APPROVAL_OR_IMPORT_LOCK_MISMATCH');
    assert.equal(response.importedContentVerified || false, false);
  }
  const badOwner = await inspectVaultImportArchiveContentReadOnly(
    f.db, { ...identity, expectedOperationId: randomUUID() }, f.client, input);
  assert.equal(badOwner.status, 'ARCHIVE_APPROVAL_OR_IMPORT_LOCK_MISMATCH');
  assert.equal(f.calls.length, 0);
});

test('M49 corrupted GitHub blob, changed HEAD or wrong commit marker never confirm history', async () => {
  for (const variant of [
    { corruptBlob: true }, { headDrift: true }, { wrongMessage: true },
  ]) {
    const input = approval(), f = mock(input, variant);
    const output = await inspectVaultImportArchiveContentReadOnly(
      f.db, identity, f.client, input);
    assert.notEqual(output.status, 'ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY');
    assert.equal(output.importedContentVerified || false, false);
    assert.equal(output.operatorUnlockAuthorized, false);
  }
});

test('M49 moving owner lock fails closed even when GitHub import was valid', async () => {
  for (const variant of [{ changedOwner: true }, { changedLock: true },
    { noSubject: true }]) {
    const input = approval(), f = mock(input, variant);
    await assert.rejects(() => inspectVaultImportArchiveContentReadOnly(
      f.db, identity, f.client, input));
  }
});

test('M49 inspector is read-only, and CLI insists on private local JSON approval file', async () => {
  const engine = await readFile(new URL('../lib/oge-vault-import-archive-proof.js',
    import.meta.url), 'utf8');
  const cli = await readFile(new URL('../scripts/inspect-vault-import-archive-proof.mjs',
    import.meta.url), 'utf8');
  assert.match(engine, /reconcileApprovedVaultNotesImport/);
  assert.match(cli, /O_NOFOLLOW/);
  assert.match(cli, /0o077/);
  assert.match(cli, /readOnly: true/);
  assert.doesNotMatch(engine + cli,
    /\.updateOne\(|\.insertOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
  const dir = await mkdtemp(join(tmpdir(), 'oge-vault-proof-test-'));
  try {
    const file = join(dir, 'approval.json'), link = join(dir, 'alias.json');
    await writeFile(file, JSON.stringify(approval()), { mode: 0o600 });
    await chmod(file, 0o644);
    const env = {
      ...process.env,
      OGE_VAULT_IMPORT_ARCHIVE_PROOF_READ_ONLY: 'YES_EXACT_ARCHIVE_ONLY',
      OGE_VAULT_INSPECT_OWNER_ID: identity.ownerId,
      OGE_VAULT_INSPECT_SESSION_VERSION: identity.sessionVersion,
      OGE_VAULT_INSPECT_REPO_ID: String(repoId),
      OGE_VAULT_INSPECT_OPERATION_ID: identity.expectedOperationId,
      MONGODB_DB: 'synthetic-test-db',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/',
      OGE_VAULT_IMPORT_APPROVAL_FILE: file,
    };
    const script = new URL('../scripts/inspect-vault-import-archive-proof.mjs',
      import.meta.url).pathname;
    const insecure = spawnSync(process.execPath, [script], {
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /BLOCKED:/);
    assert.doesNotMatch(insecure.stderr, /NEVER PRINT PRIVATE/);
    await chmod(file, 0o600);
    await symlink(file, link);
    const linked = spawnSync(process.execPath, [script], {
      env: { ...env, OGE_VAULT_IMPORT_APPROVAL_FILE: link },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /BLOCKED:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
