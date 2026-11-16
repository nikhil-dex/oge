import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectVaultImportLockReadOnly } from '../lib/oge-vault-import-lock-inspection.js';

const ownerId = 'synthetic-internal-operator-target-' + randomUUID();
const repoId = 853746;
const sessionVersion = randomUUID();
const operationId = randomUUID();
const sha = (value) => createHash('sha1').update(value).digest('hex');
const currentHead = sha('private-github-head');
const scope = { ownerId, repoId, sessionVersion, expectedOperationId: operationId };
const stamp = new Date('2026-11-16T08:30:00.000Z');
const now = new Date('2026-11-16T09:30:00.000Z');

function fixture({ lock = { operationId, repoId, startedAt: stamp },
  draftWriters = 0, drafts = 0, subjectWriters = 0,
  snapshotChange = false, accountMissing = false,
  githubFailure = false, movedHead = false } = {}) {
  const calls = [];
  let userReads = 0, headReads = 0;
  const user = {
    vaultImportLock: lock, vaultActiveDraftWriters: draftWriters,
  };
  const db = { collection(name) {
    if (name === 'users') return {
      async findOne(filter, options) {
        calls.push(['users', 'findOne']);
        assert.equal(options?.projection?.vaultImportLock, 1);
        assert.ok(filter.$and?.some((item) =>
          item.googleSub === ownerId && item.sessionVersion === sessionVersion));
        assert.ok(filter.$and?.some((item) =>
          item['vault.repoId'] === repoId && item['vault.status'] === 'connected'));
        if (accountMissing) return null;
        userReads++;
        return { ...user, vaultImportLock: user.vaultImportLock &&
          { ...user.vaultImportLock,
            operationId: snapshotChange && userReads > 1
              ? randomUUID() : user.vaultImportLock.operationId } };
      },
    };
    if (name === 'vault_drafts' || name === 'subjects') return {
      async countDocuments(filter, opts) {
        calls.push([name, 'countDocuments']);
        assert.equal(opts?.limit, 1);
        if (name === 'vault_drafts') {
          assert.deepEqual(filter, { ownerId, repoId });
          return Math.min(drafts, 1);
        }
        assert.deepEqual(filter, { ownerId, vaultActiveWriters: { $gt: 0 } });
        return Math.min(subjectWriters, 1);
      },
    };
    throw Error('Unexpected collection ' + name);
  } };
  const githubHeadReader = async () => {
    headReads++;
    if (githubFailure) throw Error('SECRET_PROVIDER_ERROR');
    return movedHead && headReads > 1 ? sha('moving-head') : currentHead;
  };
  return { db, githubHeadReader, calls,
    getHeadReads: () => headReads };
}

test('Milestone #46 read-only inspection keeps exact scope and confidential fields out of report', async () => {
  const f = fixture();
  const inspected = await inspectVaultImportLockReadOnly(f.db, scope, {
    githubHeadReader: f.githubHeadReader, now,
  });
  assert.equal(inspected.status, 'MANUAL_OPERATOR_REVIEW_REQUIRED');
  assert.equal(inspected.lockPresent, true);
  assert.equal(inspected.expectedOperationMatched, true);
  assert.equal(inspected.providerVerified, true);
  assert.equal(inspected.githubHeadStable, true);
  assert.equal(inspected.ownerSnapshotStable, true);
  assert.equal(inspected.activeDraftWriterPresent, false);
  assert.equal(inspected.activeSubjectWriterPresent, false);
  assert.equal(inspected.pendingEncryptedDraftPresent, false);
  assert.equal(inspected.ageBand, 'under-24-hours');
  assert.equal(inspected.automaticUnlockAuthorized, false);
  assert.equal(inspected.operatorUnlockAuthorized, false);
  assert.equal(inspected.consistentSnapshot, false);
  assert.equal(inspected.importedContentVerified, false);
  assert.equal(inspected.noWritesPerformed, true);
  assert.deepEqual(f.calls.map((x) => x[1]),
    ['findOne', 'countDocuments', 'countDocuments', 'findOne']);
  assert.equal(f.getHeadReads(), 2);
  const serialized = JSON.stringify(inspected);
  for (const secret of [ownerId, operationId, sessionVersion, currentHead, String(repoId),
    'SECRET_PROVIDER_ERROR', 'Private answer']) assert.equal(serialized.includes(secret), false);
});

test('Milestone #46 never treats an old lock as authorization to unlock', async () => {
  const f = fixture({ lock: { operationId, repoId,
    startedAt: new Date('2026-09-16T00:00:00.000Z') } });
  const report = await inspectVaultImportLockReadOnly(f.db, scope, {
    githubHeadReader: f.githubHeadReader, now,
  });
  assert.equal(report.ageBand, 'at-least-24-hours');
  assert.equal(report.automaticUnlockAuthorized, false);
  assert.equal(report.operatorUnlockAuthorized, false);
  assert.ok(report.blockers.includes('external-worker-quiescence-and-import-result-unverified'));
});

test('Milestone #46 missing owner or lock never triggers remote GitHub checks', async () => {
  for (const values of [
    { accountMissing: true, expected: 'OWNER_OR_REPOSITORY_NOT_VERIFIED' },
    { lock: undefined, expected: 'NO_LOCK_PRESENT' },
    { lock: null, expected: 'LOCK_DATA_INVALID' },
    { lock: { operationId: randomUUID(), repoId, startedAt: stamp },
      expected: 'DIFFERENT_LOCK_OPERATION' },
  ]) {
    const f = fixture(values);
    // undefined default parameter means the default lock in fixture; use
    // an explicit missing-case clone for the no-lock document.
    if (values.expected === 'NO_LOCK_PRESENT') {
      const absent = { collection(name) {
        if (name !== 'users') throw Error('Unneeded collection ' + name);
        return { async findOne() { return {}; } };
      } };
      const report = await inspectVaultImportLockReadOnly(absent, scope, {
        githubHeadReader: f.githubHeadReader, now,
      });
      assert.equal(report.status, 'NO_LOCK_PRESENT');
    } else {
      const report = await inspectVaultImportLockReadOnly(f.db, scope, {
        githubHeadReader: f.githubHeadReader, now,
      });
      assert.equal(report.status, values.expected);
    }
    assert.equal(f.getHeadReads(), 0);
  }
});

test('Milestone #46 active writers and encrypted drafts block any release claim', async () => {
  const f = fixture({ draftWriters: 2, drafts: 1, subjectWriters: 1 });
  const report = await inspectVaultImportLockReadOnly(f.db, scope, {
    githubHeadReader: f.githubHeadReader, now,
  });
  assert.equal(report.activeDraftWriterPresent, true);
  assert.equal(report.activeSubjectWriterPresent, true);
  assert.equal(report.pendingEncryptedDraftPresent, true);
  assert.ok(report.blockers.includes('active-draft-writers'));
  assert.ok(report.blockers.includes('active-subject-writers'));
  assert.ok(report.blockers.includes('encrypted-drafts-require-review'));
  assert.equal(report.operatorUnlockAuthorized, false);
});

test('Milestone #46 changing owner lock, GitHub drift or provider failure never returns safe status', async () => {
  for (const opts of [{ snapshotChange: true }, { movedHead: true },
    { githubFailure: true }]) {
    const f = fixture(opts);
    const result = await inspectVaultImportLockReadOnly(f.db, scope, {
      githubHeadReader: f.githubHeadReader, now,
    });
    assert.equal(result.status, 'MANUAL_OPERATOR_REVIEW_REQUIRED');
    assert.equal(result.automaticUnlockAuthorized, false);
    assert.equal(result.operatorUnlockAuthorized, false);
    if (opts.snapshotChange) assert.equal(result.ownerSnapshotStable, false);
    if (opts.movedHead) assert.equal(result.githubHeadStable, false);
    if (opts.githubFailure) assert.equal(result.providerVerified, false);
  }
});

test('Milestone #46 rejects malformed scopes and broken bounded MongoDB counts', async () => {
  const f = fixture();
  for (const invalid of [
    { ...scope, repoId: 0 }, { ...scope, expectedOperationId: '../arbitrary' },
    { ...scope, sessionVersion: undefined },
  ]) await assert.rejects(inspectVaultImportLockReadOnly(f.db, invalid, {
    githubHeadReader: f.githubHeadReader, now,
  }), TypeError);
  await assert.rejects(inspectVaultImportLockReadOnly(f.db, scope, {
    now, githubHeadReader: undefined,
  }), TypeError);
  const db = { collection(name) {
    if (name === 'users') return { async findOne() {
      return { vaultImportLock: { operationId, repoId, startedAt: stamp },
        vaultActiveDraftWriters: 0 };
    } };
    return { async countDocuments() { return 2; } };
  } };
  await assert.rejects(inspectVaultImportLockReadOnly(db, scope, {
    githubHeadReader: f.githubHeadReader, now,
  }), TypeError);
});

test('Milestone #46 operator CLI requires explicit acknowledgment and cannot mutate note storage', async () => {
  const script = await readFile(new URL(
    '../scripts/inspect-vault-import-lock.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL(
    '../lib/oge-vault-import-lock-inspection.js', import.meta.url), 'utf8');
  assert.match(script, /OGE_VAULT_IMPORT_LOCK_INSPECT_READ_ONLY === 'YES_REDACTED_ONLY'/);
  assert.match(script, /process\.exitCode = report\.status === 'NO_LOCK_PRESENT' \? 0 : 2/);
  assert.match(script, /readPreference: 'primary'/);
  assert.match(script, /getVaultNoteClient/);
  assert.doesNotMatch(script, /getDatabase\(/);
  assert.doesNotMatch(script + helper,
    /\.insertOne\(|\.updateOne\(|\.deleteOne\(|\.deleteMany\(|\.findOneAndUpdate\(|\.createIndex\(/);
  assert.doesNotMatch(script + helper, /clearConfirmedDraft|commitVaultNoteBatch/);
});
