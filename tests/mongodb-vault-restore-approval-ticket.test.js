import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  issueVaultRestoreApprovalTicket, verifyVaultRestoreApprovalTicket,
  recordVaultRestoreApproval, claimVaultRestoreApprovalOnce,
  confirmVaultRestoreApproval,
} from '../lib/oge-vault-restore-approval-ticket.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const onlyReplica = { skip: !uri ? 'Requires disposable local Mongo replica set' : false };
const KEY = '3f'.repeat(32);
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

async function disposable(work) {
  if (!uri ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw Error('Refuse non-disposable MongoDB replica-set fixture');
  const mongo = new MongoClient(uri, {
    maxPoolSize: 5, serverSelectionTimeoutMS: 8000,
  });
  await mongo.connect();
  const db = mongo.db('oge_ci_restore_receipt_' +
    randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw Error('MongoDB replica set required');
    await work(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }
}

async function fixture(db) {
  const identity = {
    ownerId: 'm59-owner-' + randomUUID(),
    sessionVersion: randomUUID(),
    repoId: 5851, installationId: 73,
    repoName: 'ogenotes-vault',
  };
  await db.collection('users').insertOne({
    googleSub: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    vault: { status: 'connected', repoId: identity.repoId,
      installationId: identity.installationId,
      githubAccountId: '731', githubLogin: 'synthetic-owner',
      repoName: identity.repoName },
  });
  const approval = {
    confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
    selectedIds: [randomUUID(), randomUUID()],
    expectedSourceSnapshot: SHA,
    expectedSourceInventorySha256: HASH,
    expectedTargetHead: SHA,
    expectedSelectionFingerprint: 'c'.repeat(64),
  };
  const now = Date.now();
  const receipt = issueVaultRestoreApprovalTicket(identity, approval, {
    secret: KEY, now,
  });
  const verified = verifyVaultRestoreApprovalTicket(
    receipt.ticket, identity, { secret: KEY, now: now + 1 });
  return { identity, approval, receipt, verified, now: new Date(now) };
}

test('M59 metadata-only receipt is atomically claimed once before restore and confirmed once', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    assert.deepEqual(await recordVaultRestoreApproval(
      db, f.identity, f.receipt, { now: f.now }),
      { status: 'pending', expiresAt: f.receipt.expiresAt });
    const before = await db.collection('vault_restore_approvals').findOne({
      _id: f.receipt.nonceHash,
    });
    assert.equal(before.state, 'pending');
    assert.equal(before.approvalHash, f.receipt.approvalHash);
    assert.ok(before.expiresAt instanceof Date);
    assert.equal(before.noteText, undefined);
    const first = await claimVaultRestoreApprovalOnce(db,
      f.identity, f.verified, { now: new Date(f.now.getTime() + 1000) });
    assert.equal(first.claimed, true);
    assert.equal(first.autoRetryAllowed, false);
    await assert.rejects(claimVaultRestoreApprovalOnce(db,
      f.identity, f.verified), (e) =>
      e.message === 'vault-restore-approval-already-used-or-expired');
    const confirmed = await confirmVaultRestoreApproval(db,
      f.identity, f.verified, 'd'.repeat(40));
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.autoRetryAllowed, false);
    assert.equal((await db.collection('vault_restore_approvals').findOne({
      _id: f.receipt.nonceHash,
    })).state, 'confirmed');
    await assert.rejects(claimVaultRestoreApprovalOnce(
      db, f.identity, f.verified), (e) => e.status === 409);
    assert.equal(await db.collection('vault_drafts').countDocuments({}), 0);
    const docs = await db.collection('vault_restore_approvals').find({}).toArray();
    assert.equal(docs.length, 1);
    const saved = JSON.stringify(docs[0]);
    for (const secret of ['PRIVATE_NOTE_BODY', f.receipt.ticket,
      KEY, f.identity.ownerId + '/notes'])
      assert.equal(saved.includes(secret), false);
    const indexes = await db.collection('vault_restore_approvals').indexes();
    assert.ok(indexes.some((i) =>
      i.name === 'vault_restore_approval_expiration_v1' &&
      i.expireAfterSeconds === 7 * 24 * 60 * 60));
    assert.ok(indexes.some((i) =>
      i.name === 'vault_restore_owner_recent_batches_v1' &&
      i.key.ownerId === 1 && i.key.sessionVersion === 1 &&
      i.key.repoId === 1 && i.key.installationId === 1 &&
      i.key.createdAt === -1 && i.key._id === -1));
  });
});

test('M59 concurrent receipt claims yield one winner, never two GitHub writes', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordVaultRestoreApproval(db, f.identity, f.receipt, { now: f.now });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      claimVaultRestoreApprovalOnce(db, f.identity, f.verified)));
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter((x) => x.status === 'rejected').length, 11);
    assert.equal((await db.collection('vault_restore_approvals').findOne({
      _id: f.receipt.nonceHash,
    })).state, 'claimed');
    assert.equal(await db.collection('vault_restore_approvals').countDocuments({}), 1);
  });
});

test('M59 duplicate nonce is rejected by unique Mongo _id and cannot enable duplicate claim', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordVaultRestoreApproval(db, f.identity, f.receipt, { now: f.now });
    await assert.rejects(recordVaultRestoreApproval(
      db, f.identity, f.receipt, { now: f.now }),
    (e) => e.code === 11000);
    assert.equal(await db.collection('vault_restore_approvals').countDocuments({}), 1);
  });
});

test('M59 revoked session or installation mapping fails receipt issuance before ledger insertion', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { sessionVersion: randomUUID() } });
    await assert.rejects(recordVaultRestoreApproval(db,
      f.identity, f.receipt, { now: f.now }),
    /vault-restore-ticket-owner-or-repository-changed/);
    assert.equal(await db.collection('vault_restore_approvals').countDocuments({}), 0);
  });
  await disposable(async (db) => {
    const f = await fixture(db);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { 'vault.installationId': 99999 } });
    await assert.rejects(recordVaultRestoreApproval(db,
      f.identity, f.receipt, { now: f.now }),
    /vault-restore-ticket-owner-or-repository-changed/);
  });
});

test('M59 expired approval cannot claim even before TTL monitor removes metadata', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordVaultRestoreApproval(db, f.identity, f.receipt, { now: f.now });
    await assert.rejects(claimVaultRestoreApprovalOnce(db,
      f.identity, f.verified,
      { now: new Date(f.receipt.expiresAt.getTime() + 1) }),
    /vault-restore-approval-already-used-or-expired/);
    assert.equal((await db.collection('vault_restore_approvals').findOne({
      _id: f.receipt.nonceHash,
    })).state, 'pending');
  });
});

test('M60 no new signed restore ticket while earlier batch is claimed but unconfirmed', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordVaultRestoreApproval(db, f.identity, f.receipt, { now: f.now });
    await claimVaultRestoreApprovalOnce(db, f.identity, f.verified,
      { now: new Date(f.now.getTime() + 10) });
    const next = issueVaultRestoreApprovalTicket(f.identity, {
      ...f.approval, expectedTargetHead: 'd'.repeat(40),
    }, { secret: KEY, now: f.now.getTime() + 20 });
    await assert.rejects(recordVaultRestoreApproval(
      db, f.identity, next, { now: new Date(f.now.getTime() + 20) }),
    /vault-restore-previous-batch-unconfirmed/);
    assert.equal(await db.collection('vault_restore_approvals')
      .countDocuments({ ownerId: f.identity.ownerId }), 1);
    // Once an actual confirmed Git commit has been separately recorded,
    // a NEW signed receipt may be issued, with fresh selection and HEAD.
    await confirmVaultRestoreApproval(db, f.identity, f.verified,
      'e'.repeat(40));
    const result = await recordVaultRestoreApproval(db, f.identity, next,
      { now: new Date(f.now.getTime() + 30) });
    assert.equal(result.status, 'pending');
    assert.equal(await db.collection('vault_restore_approvals')
      .countDocuments({ ownerId: f.identity.ownerId }), 2);
  });
});

test('M60 owner import quarantine rejects issuing a new browser restore ticket', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { vaultImportLock: {
      operationId: randomUUID(),
      state: 'github-write-possible', repoId: f.identity.repoId,
    } } });
    await assert.rejects(recordVaultRestoreApproval(
      db, f.identity, f.receipt, { now: f.now }),
    /vault-restore-ticket-owner-or-repository-changed/);
    assert.equal(await db.collection('vault_restore_approvals')
      .countDocuments({}), 0);
  });
});
