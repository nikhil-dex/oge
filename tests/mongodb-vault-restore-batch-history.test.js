import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { inspectVaultRestoreBatchHistoryReadOnly, VAULT_RESTORE_HISTORY_PAGE_LIMIT } from '../lib/oge-vault-restore-batch-history.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const replica = { skip: !uri ? 'Disposable replica-set database required' : false };
const now = new Date('2026-11-16T15:00:00.000Z');
const id = (value) => createHash('sha256').update(value).digest('hex');

async function isolated(work) {
  if (!uri ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw Error('Only disposable local Mongo replica set allowed');
  const mongo = new MongoClient(uri, {
    maxPoolSize: 4, serverSelectionTimeoutMS: 8000,
  });
  await mongo.connect();
  const db = mongo.db('oge_ci_restore_history_' +
    randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw Error('Mongo replica-set required');
    await work(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }
}

async function seed(db) {
  const identity = {
    ownerId: 'm60-owner-' + randomUUID(),
    sessionVersion: randomUUID(),
    repoId: 650, installationId: 88, repoName: 'ogenotes-vault',
  };
  await db.collection('users').insertOne({
    googleSub: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    vault: {
      status: 'connected', repoId: identity.repoId,
      installationId: identity.installationId,
      repoName: identity.repoName,
      githubLogin: 'synthetic-vault-owner', githubAccountId: '900',
    },
  });
  let count = 0;
  const add = async (state, {
    ageMinutes = 0, expiryMinutes = 10,
    badCommit = false,
  } = {}) => {
    const i = ++count;
    const createdAt = new Date(now.getTime() - ageMinutes * 60000);
    const row = {
      _id: id(identity.ownerId + ':batch:' + i),
      ownerId: identity.ownerId,
      sessionVersion: identity.sessionVersion,
      repoId: identity.repoId,
      installationId: identity.installationId,
      nonceHash: id('nonce-' + i),
      approvalHash: id('approval-' + i),
      state, createdAt,
      expiresAt: new Date(createdAt.getTime() + expiryMinutes * 60000),
    };
    if (state === 'claimed') row.claimedAt =
      new Date(createdAt.getTime() + 1000);
    if (state === 'confirmed') {
      row.claimedAt = new Date(createdAt.getTime() + 1000);
      row.confirmedAt = new Date(createdAt.getTime() + 2000);
      row.commitSha = badCommit ? 'invalid' :
        createHash('sha1').update('git-commit-' + i).digest('hex');
    }
    await db.collection('vault_restore_approvals').insertOne(row);
    return row;
  };
  return { identity, add };
}

test('M60 signed owner sees two distinct confirmed batches without auto continuation', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('confirmed', { ageMinutes: 15 });
    await f.add('confirmed', { ageMinutes: 5 });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.format, 'oge-vault-restore-batch-history-read-only');
    assert.equal(report.visibleBatchCount, 2);
    assert.equal(report.countsWithinWindow.confirmed, 2);
    assert.equal(report.status, 'CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED');
    assert.equal(report.historyTruncated, false);
    assert.equal(report.historicalBatchChainVerified, false);
    assert.equal(report.currentGitHubHeadVerified, false);
    assert.equal(report.automaticNextBatchAuthorized, false);
    assert.equal(report.automaticRetryAuthorized, false);
    assert.equal(report.operatorLockReleaseAuthorized, false);
    assert.ok(report.batches.every((x) =>
      x.state === 'GITHUB_BATCH_CONFIRMED' &&
      /^[a-f0-9]{40}$/.test(x.verifiedCommitSha)));
    const serialized = JSON.stringify(report);
    for (const value of [f.identity.ownerId, f.identity.sessionVersion,
      'synthetic-vault-owner', 'private note answer'])
      assert.equal(serialized.includes(value), false);
  });
});

test('M60 claimed/uncertain batch blocks continuity even when older commit confirmed', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('confirmed', { ageMinutes: 15 });
    await f.add('claimed', { ageMinutes: 3 });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.status, 'BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED');
    assert.equal(report.countsWithinWindow.confirmed, 1);
    assert.equal(report.countsWithinWindow.unresolved, 1);
    assert.equal(report.automaticNextBatchAuthorized, false);
    assert.equal(report.automaticRetryAuthorized, false);
    assert.equal(report.operatorLockReleaseAuthorized, false);
    assert.ok(report.batches.some((x) =>
      x.state === 'CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED'));
  });
});

test('M60 pending and expired receipts never imply next batch approved', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('pending', { ageMinutes: 2 });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.status, 'PENDING_UNCONSUMED_APPROVAL');
    assert.equal(report.countsWithinWindow.pending, 1);
  });
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('pending', { ageMinutes: 30 });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.status, 'EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW');
    assert.equal(report.countsWithinWindow.expired, 1);
    assert.equal(report.automaticNextBatchAuthorized, false);
  });
});

test('M60 more than 25 receipts truncates and fails closed instead of claiming total restore completeness', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    for (let i = 0; i < VAULT_RESTORE_HISTORY_PAGE_LIMIT + 1; i++)
      await f.add('confirmed', { ageMinutes: i + 1 });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.visibleBatchCount, VAULT_RESTORE_HISTORY_PAGE_LIMIT);
    assert.equal(report.historyTruncated, true);
    assert.equal(report.status, 'BLOCKED_INCOMPLETE_HISTORY_WINDOW');
    assert.equal(report.historicalTotalsProven, false);
    assert.equal(report.automaticNextBatchAuthorized, false);
  });
});

test('M60 import quarantine blocks history even with confirmed previous batches', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('confirmed', { ageMinutes: 1 });
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { vaultImportLock: {
      operationId: randomUUID(), state: 'github-write-possible',
      repoId: f.identity.repoId,
    } } });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.status, 'BLOCKED_IMPORT_LOCK_PRESENT');
    assert.equal(report.operatorLockReleaseAuthorized, false);
  });
});

test('M60 invalid historical records, changed owner session and repo fail closed', replica, async () => {
  await isolated(async (db) => {
    const f = await seed(db);
    await f.add('confirmed', { ageMinutes: 3, badCommit: true });
    const report = await inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now });
    assert.equal(report.status, 'BLOCKED_INVALID_HISTORY_METADATA');
    assert.deepEqual(report.batches, []);
    assert.equal(report.automaticNextBatchAuthorized, false);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { sessionVersion: randomUUID() } });
    await assert.rejects(inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now }), (e) => e.status === 409);
  });
  await isolated(async (db) => {
    const f = await seed(db);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { 'vault.installationId': 100 } });
    await assert.rejects(inspectVaultRestoreBatchHistoryReadOnly(
      db, f.identity, { now }), (e) => e.status === 409);
  });
});

test('M60 signed history route cannot fetch GitHub note content or mutate accounts', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL(
    '../app/api/vault/backup-import/chunk/history/route.js', import.meta.url), 'utf8');
  const engine = await readFile(new URL(
    '../lib/oge-vault-restore-batch-history.js', import.meta.url), 'utf8');
  assert.match(source, /const session = await auth\(\)/);
  assert.match(source, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(source, /inspectVaultRestoreBatchHistoryReadOnly/);
  assert.match(source, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(engine, /VAULT_RESTORE_HISTORY_PAGE_LIMIT = 25/);
  assert.match(engine, /\.limit\(VAULT_RESTORE_HISTORY_PAGE_LIMIT \+ 1\)/);
  assert.match(engine, /currentGitHubHeadVerified: false/);
  assert.doesNotMatch(source + engine,
    /getVaultNoteClient|\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch/);
});
