import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeLockedVaultSubjectGitHubDeletion } from '../lib/oge-vault-subject-delete-executor.js';

const scope = { ownerId: 'executor-owner', repoId: 933, subjectId: randomUUID() };
const operationId = randomUUID();
const sha = (character) => character.repeat(40);
const base = sha('a');
const baseTree = sha('b');
const newTree = sha('c');
const nextHead = sha('d');
const noteId = randomUUID();
const file = { noteId, path: 'notes/' + noteId + '.json', sha: sha('e') };
const enabled = { OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'true' };

function fixture({ plan = { ready: true, advisoryOnly: true, snapshot: base,
  files: [file] }, head = base, patch = 'ok', locked = true, jobState = 'commit-authorized',
  deletedFileSha = file.sha } = {}) {
  const job = { ...scope, operationId, state: jobState, destructiveEnabled: true };
  const subject = { ownerId: scope.ownerId, slug: scope.subjectId,
    vaultDeletionState: locked ? 'locked' : 'unlocked',
    vaultDeletionOperationId: operationId, vaultActiveWriters: 0 };
  let branchHead = head;
  const calls = [];
  const db = { collection(name) {
    if (name === 'vault_subject_deletion_jobs') return {
      async findOne() { return { ...job }; },
      async updateOne(filter, update) {
        if (filter.state !== job.state || (filter.targetCommitSha &&
            filter.targetCommitSha !== job.targetCommitSha)) return { matchedCount: 0 };
        Object.assign(job, update.$set);
        return { matchedCount: 1 };
      },
    };
    if (name === 'subjects') return { async findOne() { return { ...subject }; } };
    if (name === 'vault_drafts') return { async countDocuments() { return 0; } };
    throw Error('Unexpected collection ' + name);
  } };
  const client = { branch: 'main', async call(path, options = {}) {
    calls.push({ path, options });
    if (path === '/git/ref/heads/main') {
      if (options.method === 'PATCH') {
        if (patch === 'conflict') {
          const err = Error('branch conflict'); err.name = 'VaultGitHubError'; err.status = 409;
          // Real application throws the class; this test uses a genuine error
          // below to ensure status handling remains appropriately conservative.
          throw err;
        }
        branchHead = nextHead;
        if (patch === 'timeout-after-write') throw Error('response lost');
        return { object: { sha: nextHead } };
      }
      if (patch === 'timeout-after-write-unknown' && branchHead === nextHead)
        throw Error('ref read unavailable');
      return { object: { sha: branchHead } };
    }
    if (path === '/git/commits/' + base) return { tree: { sha: baseTree } };
    if (path === '/git/trees/' + baseTree + '?recursive=1')
      return { tree: [{ type: 'blob', path: file.path, sha: deletedFileSha }] };
    if (path === '/git/trees' && options.method === 'POST') {
      assert.equal(options.body.base_tree, baseTree);
      assert.deepEqual(options.body.tree, [{ path: file.path,
        mode: '100644', type: 'blob', sha: null }]);
      return { sha: newTree };
    }
    if (path === '/git/commits' && options.method === 'POST') {
      assert.deepEqual(options.body.parents, [base]);
      assert.equal(options.body.tree, newTree);
      return { sha: nextHead };
    }
    if (path === '/git/commits/' + nextHead) return { tree: { sha: newTree } };
    throw Error('Unexpected GitHub call ' + path);
  } };
  return { db, client, job, subject, calls, plan: async () => plan };
}

test('internal executor requires disabled-by-default independent feature flag', async () => {
  const { db, client, calls } = fixture();
  await assert.rejects(executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: {} }), /vault-destructive-delete-disabled/);
  assert.equal(calls.length, 0);
});

test('executor rejects jobs without exact operation-owned lock', async () => {
  const { db, client, calls } = fixture({ locked: false });
  await assert.rejects(executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: enabled }), /vault-deletion-lock-or-authorization-missing/);
  assert.equal(calls.length, 0);
});

test('executor commits all subject deletions atomically, records intent and keeps lock', async () => {
  const { db, client, job, subject, calls, plan } = fixture();
  const result = await executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: enabled, planner: plan });
  assert.deepEqual(result, { commitSha: nextHead, deletedFileCount: 1, githubConfirmed: true });
  assert.equal(job.state, 'github-confirmed');
  assert.equal(job.targetCommitSha, nextHead);
  assert.equal(job.baseCommitSha, base);
  assert.match(job.manifestFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(subject.vaultDeletionState, 'locked');
  assert.equal(calls.filter((entry) => entry.options.method === 'PATCH').length, 1);
  assert.equal(calls.some((entry) => entry.path.includes('/contents/')), false);
});

test('stale GitHub head and stale file blob reject without creating a commit', async () => {
  const staleHead = fixture({ head: sha('f') });
  await assert.rejects(executeLockedVaultSubjectGitHubDeletion(
    staleHead.db, staleHead.client, scope, operationId,
    { env: enabled, planner: staleHead.plan }), /vault-deletion-head-changed/);
  assert.equal(staleHead.calls.filter((entry) => entry.options.method === 'POST').length, 0);

  const staleBlob = fixture({ deletedFileSha: sha('f') });
  await assert.rejects(executeLockedVaultSubjectGitHubDeletion(
    staleBlob.db, staleBlob.client, scope, operationId,
    { env: enabled, planner: staleBlob.plan }), /vault-deletion-blob-changed/);
  assert.equal(staleBlob.calls.filter((entry) => entry.options.method === 'POST').length, 0);
});

test('ambiguous PATCH that actually succeeded is confirmed by GitHub ref and tree', async () => {
  const { db, client, job, plan } = fixture({ patch: 'timeout-after-write' });
  const result = await executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: enabled, planner: plan });
  assert.equal(result.githubConfirmed, true);
  assert.equal(job.state, 'github-confirmed');
});

test('ambiguous/failed PATCH leaves durable commit-intent and lock for reconciliation', async () => {
  const { db, client, job, subject, plan } = fixture({ patch: 'conflict' });
  await assert.rejects(executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: enabled, planner: plan }),
    /vault-deletion-commit-unconfirmed/);
  assert.equal(job.state, 'commit-intent');
  assert.equal(subject.vaultDeletionState, 'locked');
  assert.equal(job.targetCommitSha, nextHead);
});

test('empty subject is verified but MongoDB subject remains untouched and locked', async () => {
  const { db, client, job, subject } = fixture();
  const result = await executeLockedVaultSubjectGitHubDeletion(
    db, client, scope, operationId, { env: enabled,
      planner: async () => ({ ready: true, advisoryOnly: true, snapshot: base, files: [] }) });
  assert.equal(result.deletedFileCount, 0);
  assert.equal(job.state, 'github-confirmed');
  assert.equal(subject.vaultDeletionState, 'locked');
});

test('the executor is not exposed by a public route or deletion API', async () => {
  const module = await readFile(new URL('../lib/oge-vault-subject-delete-executor.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../app/api/vault/subjects/preflight/route.js', import.meta.url), 'utf8');
  assert.match(module, /OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL/);
  assert.match(module, /state: 'commit-intent'/);
  assert.doesNotMatch(preflight, /executeLockedVaultSubjectGitHubDeletion/);
  assert.match(route, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});
