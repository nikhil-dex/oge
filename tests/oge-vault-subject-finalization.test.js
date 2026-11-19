import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  inspectLockedVaultSubjectFinalization, retireLockedVaultSubjectMetadata,
} from '../lib/oge-vault-subject-finalization.js';

const ownerId = 'finalization-test-owner';
const subjectId = randomUUID();
const operationId = randomUUID();
const sessionVersion = randomUUID();
const repoId = 98;
const identity = { ownerId, subjectId, repoId };
const credential = { sessionVersion };
const sha = (c) => c.repeat(40);
const baseSha = sha('a');
const targetSha = sha('b');
const treeSha = sha('c');
const fingerprint = 'f'.repeat(64);

function fixture({
  drafts = 0, legacy = 0, index = 0, subjects = 2,
  jobState = 'github-confirmed', lock = 'locked', activeWriters = 0,
  accountRepoId = repoId, snapshot = targetSha, githubHead = targetSha,
  tree = treeSha, parent = baseSha, deleted = 2,
} = {}) {
  const job = {
    ownerId, repoId, subjectId, operationId, state: jobState, destructiveEnabled: true,
    targetCommitSha: targetSha, targetTreeSha: treeSha, baseCommitSha: baseSha,
    manifestFingerprint: fingerprint, deletedFileCount: deleted,
  };
  const subject = {
    ownerId, slug: subjectId, vaultDeletionState: lock,
    vaultDeletionOperationId: operationId, vaultActiveWriters: activeWriters,
  };
  let writes = 0, transactionStarted = false, transactionEnded = false;
  const documentCollections = {
    users: {
      async findOne(filter) {
        assert.equal(filter.googleSub, ownerId);
        assert.equal(filter.sessionVersion, sessionVersion);
        return { vault: { status: 'connected', repoId: accountRepoId } };
      },
      async updateOne(filter, update, options) {
        assert.equal(filter.googleSub, ownerId);
        assert.equal(filter['vault.repoId'], repoId);
        assert.ok(options?.session);
        writes += 1;
        return { matchedCount: accountRepoId === repoId ? 1 : 0 };
      },
    },
    vault_subject_deletion_jobs: {
      async findOne(filter) {
        assert.equal(filter.operationId, operationId);
        return { ...job };
      },
      async updateOne(filter, update, options) {
        assert.ok(options?.session);
        if (job.state !== filter.state || job.targetCommitSha !== filter.targetCommitSha)
          return { matchedCount: 0 };
        Object.assign(job, update.$set);
        writes += 1;
        return { matchedCount: 1 };
      },
    },
    subjects: {
      async findOne(filter) {
        assert.equal(filter.slug, subjectId);
        return { ...subject };
      },
      async countDocuments() { return subjects; },
      async updateOne(filter, update, options) {
        assert.ok(options?.session);
        if (subject.vaultDeletionState !== filter.vaultDeletionState ||
            subject.vaultDeletionOperationId !== filter.vaultDeletionOperationId ||
            subject.vaultActiveWriters !== 0)
          return { matchedCount: 0 };
        Object.assign(subject, update.$set);
        writes += 1;
        return { matchedCount: 1 };
      },
    },
    vault_drafts: { async countDocuments() { return drafts; } },
    notes: { async countDocuments() { return legacy; } },
    vault_files: { async countDocuments() { return index; } },
  };
  const db = {
    collection(name) {
      if (!documentCollections[name]) throw Error('Unexpected collection ' + name);
      return documentCollections[name];
    },
    client: { startSession() {
      transactionStarted = true;
      return {
        async withTransaction(action) { return action(); },
        async endSession() { transactionEnded = true; },
      };
    } },
  };
  const calls = [];
  const client = {
    branch: 'main', vault: { repoId },
    async call(path) {
      calls.push(path);
      if (path === '/git/ref/heads/main') return { object: { sha: githubHead } };
      if (path === '/git/commits/' + targetSha)
        return { tree: { sha: tree }, parents: [{ sha: parent }] };
      throw Error('Unexpected GitHub call');
    },
  };
  const planner = async () => ({
    ready: true, advisoryOnly: true, snapshot, files: [],
  });
  return {
    db, client, planner, job, subject, calls,
    get writes() { return writes; },
    get transactionStarted() { return transactionStarted; },
    get transactionEnded() { return transactionEnded; },
  };
}

async function inspect(f) {
  return inspectLockedVaultSubjectFinalization(f.db, f.client, identity, operationId, {
    credential, planner: f.planner,
  });
}

test('finalization review succeeds only for a verified locked empty subject', async () => {
  const f = fixture();
  const result = await inspect(f);
  assert.deepEqual(result, {
    ready: true, reason: 'metadata-retirement-eligible', advisoryOnly: true,
    operationId, githubCommitSha: targetSha,
  });
  assert.equal(f.writes, 0);
  assert.equal(f.transactionStarted, false);
  assert.deepEqual(f.calls, [
    '/git/ref/heads/main', '/git/commits/' + targetSha,
  ]);
});

test('retirement review blocks active writers and unconfirmed jobs', async () => {
  for (const [options, reason] of [
    [{ jobState: 'commit-intent' }, 'job-or-subject-lock-unconfirmed'],
    [{ lock: 'unlocked' }, 'job-or-subject-lock-unconfirmed'],
    [{ activeWriters: 1 }, 'job-or-subject-lock-unconfirmed'],
    [{ accountRepoId: 50 }, 'vault-account-mismatch'],
  ]) {
    const f = fixture(options);
    assert.equal((await inspect(f)).reason, reason);
    assert.equal(f.writes, 0);
  }
});

test('retirement refuses pending drafts, legacy content, stale catalog and last subject', async () => {
  for (const [options, reason] of [
    [{ drafts: 1 }, 'pending-vault-drafts'],
    [{ legacy: 1 }, 'legacy-notes-present'],
    [{ index: 1 }, 'file-index-not-reconciled'],
    [{ subjects: 1 }, 'last-subject'],
  ]) {
    const f = fixture(options);
    assert.deepEqual(await inspect(f), { ready: false, reason, advisoryOnly: true });
    assert.equal(f.calls.length, 0);
  }
});

test('retirement refuses stale GitHub snapshots, new notes, mismatched commit proof', async () => {
  for (const [options, reason] of [
    [{ snapshot: baseSha }, 'github-subject-not-empty-or-head-changed'],
    [{ githubHead: baseSha }, 'github-head-changed'],
    [{ tree: baseSha }, 'github-commit-proof-mismatch'],
    [{ parent: treeSha }, 'github-commit-proof-mismatch'],
  ]) {
    const f = fixture(options);
    assert.equal((await inspect(f)).reason, reason);
  }
  const f = fixture();
  f.planner = async () => ({ ready: true, advisoryOnly: true,
    snapshot: targetSha, files: [{ noteId: randomUUID() }] });
  assert.equal((await inspect(f)).reason, 'github-subject-not-empty-or-head-changed');
});

test('retirement is disabled by default before any database or GitHub calls', async () => {
  const f = fixture();
  await assert.rejects(retireLockedVaultSubjectMetadata(
    f.db, f.client, identity, operationId, { credential, env: {} }),
  /vault-subject-retirement-disabled/);
  assert.equal(f.writes, 0);
  assert.equal(f.calls.length, 0);
});

test('internal metadata retirement is transactional, retains subject and lock', async () => {
  const f = fixture();
  const result = await retireLockedVaultSubjectMetadata(
    f.db, f.client, identity, operationId, {
      credential, env: { OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'true' },
      inspector: async () => ({ ready: true, advisoryOnly: true, githubCommitSha: targetSha }),
    });
  assert.deepEqual(result, { metadataRetired: true, subjectRetained: true,
    lockRetained: true, operationId });
  assert.equal(f.transactionStarted, true);
  assert.equal(f.transactionEnded, true);
  assert.equal(f.job.state, 'metadata-retired');
  assert.equal(f.subject.vaultDeletionState, 'locked');
  assert.equal(f.subject.vaultDeletionOperationId, operationId);
  assert.ok(f.subject.vaultRetiredAt instanceof Date);
});

test('MongoDB recheck blocks drafts without changing subject or deletion journal', async () => {
  const f = fixture({ drafts: 1 });
  await assert.rejects(retireLockedVaultSubjectMetadata(
    f.db, f.client, identity, operationId, {
      credential, env: { OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'true' },
      inspector: async () => ({ ready: true, advisoryOnly: true, githubCommitSha: targetSha }),
    }), /vault-subject-retirement-recheck-failed/);
  assert.equal(f.subject.vaultRetiredAt, undefined);
  assert.equal(f.job.state, 'github-confirmed');
  assert.equal(f.transactionEnded, true);
});

test('finalization has no physical deletion or public API integration', async () => {
  const source = await readFile(new URL('../lib/oge-vault-subject-finalization.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/subjects/preflight/route.js', import.meta.url), 'utf8');
  assert.match(source, /OGE_VAULT_SUBJECT_RETIRE_INTERNAL/);
  assert.doesNotMatch(source, /deleteOne\(|deleteMany\(/);
  assert.doesNotMatch(api, /retireLockedVaultSubjectMetadata/);
  assert.match(route, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});
