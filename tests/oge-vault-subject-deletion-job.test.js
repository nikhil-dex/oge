import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareVaultSubjectDeletion, inspectVaultDeletionJob } from '../lib/oge-vault-subject-deletion-job.js';

const ownerId = 'delete-job-owner';
const repoId = 317;
const subjectId = randomUUID();
const identity = { ownerId, repoId, subjectId };
const sha = 'a'.repeat(40);
const files = [{ noteId: randomUUID(), sha: 'b'.repeat(40) }];
files[0].path = 'notes/' + files[0].noteId + '.json';

function fakeDatabase() {
  const row = { ownerId, slug: subjectId, vaultActiveWriters: 0 };
  const jobs = new Map();
  let blockRelease = false;
  const db = { collection(name) {
    if (name === 'vault_drafts') return { countDocuments: async () => 0 };
    if (name === 'subjects') return {
      async findOne() { return { ...row }; },
      async updateOne(filter, update) {
        if (filter.ownerId !== ownerId || filter.slug !== subjectId) return { matchedCount: 0 };
        if (filter.vaultDeletionState?.$ne === 'locked' && row.vaultDeletionState === 'locked')
          return { matchedCount: 0 };
        if (filter.vaultDeletionState === 'locked' && row.vaultDeletionState !== 'locked')
          return { matchedCount: 0 };
        if (filter.vaultDeletionOperationId && filter.vaultDeletionOperationId !== row.vaultDeletionOperationId)
          return { matchedCount: 0 };
        if (filter.$or && row.vaultActiveWriters !== 0) return { matchedCount: 0 };
        if (blockRelease && update.$unset) return { matchedCount: 0 };
        if (update.$set) Object.assign(row, update.$set);
        if (update.$unset) for (const property of Object.keys(update.$unset)) delete row[property];
        return { matchedCount: 1 };
      },
    };
    if (name === 'vault_subject_deletion_jobs') return {
      async insertOne(record) {
        if (jobs.has(record.operationId)) throw Error('duplicate');
        jobs.set(record.operationId, { ...record });
      },
      async findOne(filter) {
        const result = jobs.get(filter.operationId);
        return result?.ownerId === filter.ownerId &&
          result?.repoId === filter.repoId && result?.subjectId === filter.subjectId
          ? { ...result } : null;
      },
      async updateOne(filter, update) {
        const row = jobs.get(filter.operationId);
        if (!row || row.ownerId !== filter.ownerId || row.repoId !== filter.repoId ||
            row.subjectId !== filter.subjectId) return { matchedCount: 0 };
        if (typeof filter.state === 'string' && row.state !== filter.state)
          return { matchedCount: 0 };
        if (filter.state?.$in && !filter.state.$in.includes(row.state))
          return { matchedCount: 0 };
        if (filter.state?.$nin && filter.state.$nin.includes(row.state))
          return { matchedCount: 0 };
        Object.assign(row, update.$set);
        return { matchedCount: 1 };
      },
    };
    throw Error('Unexpected collection ' + name);
  } };
  return { db, row, jobs, setBlockRelease(flag) { blockRelease = flag; } };
}
test('prepares fingerprint under lock, releases lock and never deletes', async () => {
  const { db, row, jobs } = fakeDatabase();
  const result = await prepareVaultSubjectDeletion(db, {}, identity, {
    planner: async () => {
      assert.equal(row.vaultDeletionState, 'locked');
      return { advisoryOnly: true, ready: true, reason: 'notes-require-deletion',
        snapshot: sha, files };
    },
  });
  assert.equal(result.ready, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.fileCount, 1);
  assert.equal(result.advisoryOnly, true);
  assert.equal(row.vaultDeletionState, undefined);
  assert.equal(jobs.get(result.operationId).state, 'released');
  assert.equal((await inspectVaultDeletionJob(db, identity, result.operationId)).action, 'none');
  assert.doesNotMatch(JSON.stringify(jobs.get(result.operationId)), /answer|heading/);
});
test('pending drafts produce blocked preparation without a fingerprint', async () => {
  const { db } = fakeDatabase();
  const result = await prepareVaultSubjectDeletion(db, {}, identity, {
    planner: async () => ({ advisoryOnly: true, ready: false,
      reason: 'pending-vault-drafts', files: [] }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.fingerprint, null);
});
test('active writers block the planning lock without invoking planner', async () => {
  const { db, row } = fakeDatabase();
  row.vaultActiveWriters = 1;
  let inspected = false;
  const result = await prepareVaultSubjectDeletion(db, {}, identity, {
    planner: async () => { inspected = true; },
  });
  assert.equal(result.ready, false);
  assert.equal(inspected, false);
  assert.equal(row.vaultDeletionState, undefined);
});
test('failure releases lock and records inspection failure', async () => {
  const { db, row, jobs } = fakeDatabase();
  const operationId = randomUUID();
  await assert.rejects(prepareVaultSubjectDeletion(db, {}, identity, {
    operationId, planner: async () => { throw Error('github-down'); },
  }), /github-down/);
  assert.equal(row.vaultDeletionState, undefined);
  assert.equal(jobs.get(operationId).state, 'released');
  assert.equal(jobs.get(operationId).reason, 'inspection-failed');
});
test('uncertain unlock remains locked and marks manual recovery', async () => {
  const { db, row, jobs, setBlockRelease } = fakeDatabase();
  const operationId = randomUUID();
  setBlockRelease(true);
  await assert.rejects(prepareVaultSubjectDeletion(db, {}, identity, {
    operationId, planner: async () => ({ advisoryOnly: true, ready: true,
      reason: 'empty-at-snapshot', snapshot: sha, files: [] }),
  }), /vault-subject-preflight-release-unconfirmed/);
  assert.equal(row.vaultDeletionState, 'locked');
  assert.equal(jobs.get(operationId).state, 'needs-recovery');
  assert.equal((await inspectVaultDeletionJob(db, identity, operationId)).action, 'manual-review');
});
test('deployment gate remains closed; implementation has no destructive action', async () => {
  const source = await readFile(new URL('../lib/oge-vault-subject-deletion-job.js', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /deleteOne\(|deleteMany\(|commitVaultNoteBatch\(/);
  assert.match(source, /destructiveEnabled: false/);
  assert.match(legacy, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
  assert.match(mongo, /vault_subject_deletion_jobs.*unique: true/);
});
