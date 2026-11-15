import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectLockedVaultSubject } from '../lib/oge-vault-subject-coordinator.js';
import { withVaultSubjectWrite, releaseVaultSubjectPreflight } from '../lib/oge-vault-subject-fence.js';

const ownerId = 'coordinator-owner';
const repoId = 54;
const subjectId = randomUUID();
const identity = { ownerId, repoId, subjectId };

function fakeDb() {
  const row = { ownerId, slug: subjectId, vaultActiveWriters: 0 };
  let releaseUnavailable = false;
  const subjects = {
    async updateOne(filter, update) {
      if (row.ownerId !== filter.ownerId || row.slug !== filter.slug)
        return { matchedCount: 0 };
      if (filter.vaultDeletionState?.$ne === 'locked' && row.vaultDeletionState === 'locked')
        return { matchedCount: 0 };
      if (filter.vaultDeletionState === 'locked' &&
          row.vaultDeletionState !== 'locked') return { matchedCount: 0 };
      if (filter.vaultDeletionOperationId !== undefined &&
          filter.vaultDeletionOperationId !== row.vaultDeletionOperationId)
        return { matchedCount: 0 };
      if (filter.$or && row.vaultActiveWriters !== 0) return { matchedCount: 0 };
      if (filter.vaultActiveWriters?.$gt === 0 && row.vaultActiveWriters <= 0)
        return { matchedCount: 0 };
      if (releaseUnavailable && update.$unset) return { matchedCount: 0 };
      if (update.$inc) row.vaultActiveWriters += update.$inc.vaultActiveWriters;
      if (update.$set) Object.assign(row, update.$set);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
      return { matchedCount: 1 };
    },
  };
  const db = { collection(name) {
    if (name === 'subjects') return subjects;
    if (name === 'vault_drafts') return { countDocuments: async () => 0 };
    throw Error('Unexpected collection');
  } };
  return { db, row, setReleaseUnavailable(value) { releaseUnavailable = value; } };
}

test('locked preflight denies concurrent subject writes and always unlocks', async () => {
  const { db, row } = fakeDb();
  const result = await inspectLockedVaultSubject(db, {}, identity, {
    inspector: async () => {
      assert.equal(row.vaultDeletionState, 'locked');
      await assert.rejects(withVaultSubjectWrite(db, ownerId, subjectId, async () => {}),
        /vault-subject-locked-or-missing/);
      return { safeToDelete: true, reason: 'empty-at-snapshot' };
    },
  });
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.safeToDelete, true);
  assert.equal(row.vaultDeletionState, undefined);
  await withVaultSubjectWrite(db, ownerId, subjectId, async () => {});
});

test('failed scan releases only its own operation lock', async () => {
  const { db, row } = fakeDb();
  await assert.rejects(inspectLockedVaultSubject(db, {}, identity, {
    inspector: async () => { throw new Error('github-not-reachable'); },
  }), /github-not-reachable/);
  assert.equal(row.vaultDeletionState, undefined);
});

test('active writers and already locked subjects fail closed', async () => {
  const { db, row } = fakeDb();
  row.vaultActiveWriters = 1;
  let inspected = false;
  let result = await inspectLockedVaultSubject(db, {}, identity, {
    inspector: async () => { inspected = true; },
  });
  assert.equal(result.safeToDelete, false);
  assert.equal(result.reason, 'subject-locked-or-active');
  assert.equal(inspected, false);
  row.vaultActiveWriters = 0;
  row.vaultDeletionState = 'locked';
  row.vaultDeletionOperationId = randomUUID();
  result = await inspectLockedVaultSubject(db, {}, identity, {
    inspector: async () => { inspected = true; },
  });
  assert.equal(result.safeToDelete, false);
  assert.equal(inspected, false);
});

test('wrong operation token cannot release someone else\'s lock', async () => {
  const { db, row } = fakeDb();
  const token = randomUUID();
  row.vaultDeletionState = 'locked';
  row.vaultDeletionOperationId = token;
  await assert.rejects(releaseVaultSubjectPreflight(db, ownerId, subjectId, randomUUID()),
    /vault-subject-preflight-release-unconfirmed/);
  assert.equal(row.vaultDeletionState, 'locked');
  await releaseVaultSubjectPreflight(db, ownerId, subjectId, token);
  assert.equal(row.vaultDeletionState, undefined);
});

test('uncertain lock release never returns a positive preflight', async () => {
  const { db, row, setReleaseUnavailable } = fakeDb();
  setReleaseUnavailable(true);
  await assert.rejects(inspectLockedVaultSubject(db, {}, identity, {
    inspector: async () => ({ safeToDelete: true, reason: 'empty-at-snapshot' }),
  }), /vault-subject-preflight-release-unconfirmed/);
  assert.equal(row.vaultDeletionState, 'locked');
});

test('locked preflight remains internal only; connected subject deletion still blocked', async () => {
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const coordinator = await readFile(new URL('../lib/oge-vault-subject-coordinator.js', import.meta.url), 'utf8');
  assert.match(route, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
  assert.doesNotMatch(coordinator, /deleteOne\(|deleteMany\(/);
  assert.match(coordinator, /advisoryOnly: true/);
});
