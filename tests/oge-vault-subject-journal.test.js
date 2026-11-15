import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { journalVaultSubjectInspection, inspectVaultSubjectRecovery } from '../lib/oge-vault-subject-journal.js';
import { withVaultSubjectWrite } from '../lib/oge-vault-subject-fence.js';

const ownerId = 'journal-owner';
const repoId = 123;
const subjectId = randomUUID();
const identity = { ownerId, repoId, subjectId };

function store() {
  const subject = { ownerId, slug: subjectId, vaultActiveWriters: 0 };
  const records = new Map();
  let blockRelease = false;
  const db = { collection(name) {
    if (name === 'subjects') return {
      async findOne() { return { ...subject }; },
      async updateOne(filter, update) {
        if (filter.ownerId !== ownerId || filter.slug !== subjectId)
          return { matchedCount: 0 };
        if (filter.vaultDeletionState?.$ne === 'locked' &&
            subject.vaultDeletionState === 'locked') return { matchedCount: 0 };
        if (filter.vaultDeletionState === 'locked' &&
            subject.vaultDeletionState !== 'locked') return { matchedCount: 0 };
        if (filter.vaultDeletionOperationId &&
            filter.vaultDeletionOperationId !== subject.vaultDeletionOperationId)
          return { matchedCount: 0 };
        if (filter.$or && subject.vaultActiveWriters !== 0)
          return { matchedCount: 0 };
        if (filter.vaultActiveWriters?.$gt === 0 &&
            subject.vaultActiveWriters <= 0) return { matchedCount: 0 };
        if (blockRelease && update.$unset) return { matchedCount: 0 };
        if (update.$set) Object.assign(subject, update.$set);
        if (update.$inc) subject.vaultActiveWriters += update.$inc.vaultActiveWriters;
        if (update.$unset) for (const field of Object.keys(update.$unset)) delete subject[field];
        return { matchedCount: 1 };
      },
    };
    if (name === 'vault_drafts') return { countDocuments: async () => 0 };
    if (name === 'vault_subject_inspections') return {
      async insertOne(value) {
        if (records.has(value.operationId)) throw Error('duplicate');
        records.set(value.operationId, { ...value });
      },
      async updateOne(filter, update) {
        const value = records.get(filter.operationId);
        if (!value || value.ownerId !== filter.ownerId ||
            value.repoId !== filter.repoId || value.subjectId !== filter.subjectId ||
            (typeof filter.state === 'string' && value.state !== filter.state))
          return { matchedCount: 0 };
        Object.assign(value, update.$set);
        return { matchedCount: 1 };
      },
      async findOne(filter) { return records.get(filter.operationId) || null; },
    };
    throw Error('Unexpected collection ' + name);
  } };
  return { db, records, subject, setBlockRelease(value) { blockRelease = value; } };
}

test('journal records a locked snapshot inspection with no note contents', async () => {
  const { db, records, subject } = store();
  const result = await journalVaultSubjectInspection(db, {}, identity, {
    inspector: async () => {
      assert.equal(subject.vaultDeletionState, 'locked');
      await assert.rejects(withVaultSubjectWrite(db, ownerId, subjectId, async () => {}),
        /vault-subject-locked-or-missing/);
      return { safeToDelete: true, reason: 'empty-at-snapshot', snapshot: 'a'.repeat(40) };
    },
  });
  assert.equal(result.advisoryOnly, true);
  assert.equal(subject.vaultDeletionState, undefined);
  const journal = records.get(result.operationId);
  assert.equal(journal.state, 'released');
  assert.equal(journal.snapshot, 'a'.repeat(40));
  assert.equal(JSON.stringify(journal).includes('heading'), false);
  assert.equal((await inspectVaultSubjectRecovery(db, identity, result.operationId)).action, 'none');
});

test('journal records denied lock attempts without exposing a deletion endpoint', async () => {
  const { db, subject, records } = store();
  subject.vaultActiveWriters = 1;
  const result = await journalVaultSubjectInspection(db, {}, identity);
  assert.equal(result.safeToDelete, false);
  assert.equal(records.get(result.operationId).state, 'blocked');
  assert.equal(subject.vaultDeletionState, undefined);
});

test('failed inspection releases lock, records failure and propagates error', async () => {
  const { db, records, subject } = store();
  const operationId = randomUUID();
  await assert.rejects(journalVaultSubjectInspection(db, {}, identity, {
    operationId, inspector: async () => { throw Error('github-down'); },
  }), /github-down/);
  assert.equal(subject.vaultDeletionState, undefined);
  assert.equal(records.get(operationId).state, 'released');
  assert.equal(records.get(operationId).outcome, 'inspection-failed');
});

test('uncertain release produces a durable manual-recovery state, never success', async () => {
  const { db, subject, records, setBlockRelease } = store();
  const operationId = randomUUID();
  setBlockRelease(true);
  await assert.rejects(journalVaultSubjectInspection(db, {}, identity, {
    operationId, inspector: async () => ({ safeToDelete: true, reason: 'empty-at-snapshot' }),
  }), /vault-subject-preflight-release-unconfirmed/);
  assert.equal(subject.vaultDeletionState, 'locked');
  assert.equal(records.get(operationId).state, 'needs-recovery');
  assert.deepEqual(await inspectVaultSubjectRecovery(db, identity, operationId), {
    found: true, operationId, state: 'needs-recovery', ownsLock: true, action: 'manual-review',
  });
});

test('journal remains metadata-only and connected Vault deletion remains blocked', async () => {
  const journal = await readFile(new URL('../lib/oge-vault-subject-journal.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  assert.doesNotMatch(journal, /deleteOne\(|deleteMany\(/);
  assert.match(journal, /manual-review/);
  assert.match(route, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
  assert.match(mongo, /vault_subject_inspections.*unique: true/);
  assert.doesNotMatch(mongo, /vault_subject_inspections.*expireAfterSeconds/);
});
