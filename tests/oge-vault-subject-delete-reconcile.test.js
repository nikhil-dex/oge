import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reconcileVaultSubjectGitHubDeletion } from '../lib/oge-vault-subject-delete-reconcile.js';

const identity = { ownerId: 'reconciler-owner', repoId: 55, subjectId: randomUUID() };
const operationId = randomUUID();
const sha = (character) => character.repeat(40);

function fixture({ state = 'commit-intent', head = sha('d'),
  tree = sha('c'), parent = sha('a'), locked = true, githubDown = false } = {}) {
  const job = { ...identity, operationId, state, destructiveEnabled: true,
    baseCommitSha: sha('a'), targetCommitSha: sha('d'),
    targetTreeSha: sha('c'), manifestFingerprint: 'e'.repeat(64) };
  const subject = { vaultDeletionState: locked ? 'locked' : 'unlocked',
    vaultDeletionOperationId: operationId, vaultActiveWriters: 0 };
  let patches = 0;
  const db = { collection(name) {
    if (name === 'vault_subject_deletion_jobs') return {
      async findOne() { return { ...job }; },
      async updateOne(filter, update) {
        if (filter.state !== job.state || filter.targetCommitSha !== job.targetCommitSha)
          return { matchedCount: 0 };
        Object.assign(job, update.$set);
        return { matchedCount: 1 };
      },
    };
    if (name === 'subjects') return { async findOne() { return { ...subject }; } };
    throw Error('Unexpected collection ' + name);
  } };
  const client = { branch: 'main', async call(path, opts = {}) {
    if (opts.method === 'PATCH') { patches++; throw Error('Forbidden mutation'); }
    if (githubDown) throw Error('GitHub unavailable');
    if (path === '/git/ref/heads/main') return { object: { sha: head } };
    if (path === '/git/commits/' + sha('d')) return {
      tree: { sha: tree }, parents: [{ sha: parent }],
    };
    throw Error('Unexpected call ' + path);
  } };
  return { db, client, job, subject, get patches() { return patches; } };
}

test('committed GitHub head and parent/tree reconcile uncertain deletion intent', async () => {
  const f = fixture();
  assert.deepEqual(await reconcileVaultSubjectGitHubDeletion(
    f.db, f.client, identity, operationId),
  { confirmed: true, action: 'none', retainedLock: true });
  assert.equal(f.job.state, 'github-confirmed');
  assert.equal(f.subject.vaultDeletionState, 'locked');
  assert.equal(f.patches, 0);
});

test('branch advance, wrong tree or wrong commit parent all require review', async () => {
  for (const options of [
    { head: sha('f') }, { tree: sha('f') }, { parent: sha('f') },
    { githubDown: true },
  ]) {
    const f = fixture(options);
    const status = await reconcileVaultSubjectGitHubDeletion(
      f.db, f.client, identity, operationId);
    assert.equal(status.confirmed, false);
    assert.equal(status.action, 'manual-review');
    assert.equal(f.job.state, 'commit-intent');
    assert.equal(f.subject.vaultDeletionState, 'locked');
    assert.equal(f.patches, 0);
  }
});

test('unowned subject lock and missing commit intent fail closed', async () => {
  for (const options of [{ locked: false }, { state: 'planned' }]) {
    const f = fixture(options);
    await assert.rejects(reconcileVaultSubjectGitHubDeletion(
      f.db, f.client, identity, operationId), /vault-deletion-recovery-unsafe/);
  }
});

test('already-confirmed result is idempotent but still requires owned lock', async () => {
  const owned = fixture({ state: 'github-confirmed' });
  const result = await reconcileVaultSubjectGitHubDeletion(
    owned.db, owned.client, identity, operationId);
  assert.equal(result.confirmed, true);
  const unowned = fixture({ state: 'github-confirmed', locked: false });
  await assert.rejects(reconcileVaultSubjectGitHubDeletion(
    unowned.db, unowned.client, identity, operationId),
  /vault-deletion-recovery-unsafe/);
});

test('reconciler cannot retry PATCH, unlock or delete subject metadata', async () => {
  const source = await readFile(new URL('../lib/oge-vault-subject-delete-reconcile.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../app/api/vault/subjects/preflight/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /method: 'PATCH'|deleteOne\(|deleteMany\(|releaseVaultSubjectPreflight/);
  assert.doesNotMatch(preview, /reconcileVaultSubjectGitHubDeletion/);
  assert.match(route, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});
