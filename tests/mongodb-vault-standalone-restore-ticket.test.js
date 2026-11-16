import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  issueStandaloneRestoreTicket, verifyStandaloneRestoreTicket,
  recordStandaloneRestoreTicket, claimStandaloneRestoreTicketOnce,
  confirmStandaloneRestoreTicket,
} from '../lib/oge-vault-standalone-restore-ticket.js';

const URI = process.env.OGE_TEST_MONGODB_URI;
const onlyReplica = { skip: !URI ? 'Requires disposable local Mongo replica set' : false };
const KEY = 'd2'.repeat(32);
const HEAD = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

async function disposable(work) {
  if (!URI ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(URI) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw Error('Refuse non-disposable MongoDB fixture');
  const mongo = new MongoClient(URI, {
    maxPoolSize: 5, serverSelectionTimeoutMS: 8000,
  });
  await mongo.connect();
  const db = mongo.db('oge_ci_standalone_ticket_' +
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
  const owner = {
    ownerId: 'm76-owner-' + randomUUID(),
    sessionVersion: randomUUID(),
    repoId: 971, installationId: 76,
    repoName: 'ogenotes-vault',
    githubAccountId: '555', githubLogin: 'm76-test-account',
  };
  await db.collection('users').insertOne({
    googleSub: owner.ownerId, sessionVersion: owner.sessionVersion,
    vault: {
      status: 'connected', repoId: owner.repoId,
      installationId: owner.installationId, repoName: owner.repoName,
      githubAccountId: owner.githubAccountId,
      githubLogin: owner.githubLogin,
    },
  });
  const binding = {
    kind: 'quick-notes', selectedIds: [randomUUID()],
    expectedTargetHead: HEAD,
    expectedSelectionFingerprint: 'e'.repeat(64),
    sourceSnapshot: HEAD,
    sourceArchiveSha256: HASH,
    confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
  };
  const now = Date.now();
  const receipt = issueStandaloneRestoreTicket(owner, binding, {
    secret: KEY, now,
  });
  const verified = verifyStandaloneRestoreTicket(
    receipt.ticket, owner, binding, { secret: KEY, now: now + 1 });
  return { owner, binding, receipt, verified, now };
}

test('M76 isolated one-time receipt persists only owner/repo and SHA256 hashes; no backups or secrets', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordStandaloneRestoreTicket(db, f.owner, f.receipt, {
      now: new Date(f.now),
    });
    const ledger = db.collection('vault_standalone_restore_approvals');
    const row = await ledger.findOne({ _id: f.receipt.nonceHash });
    assert.equal(row.state, 'pending');
    assert.equal(row.approvalHash, f.receipt.approvalHash);
    assert.equal(row.ownerId, f.owner.ownerId);
    assert.equal(row.repoId, f.owner.repoId);
    assert.equal(row.installationId, f.owner.installationId);
    assert.equal(row.sessionVersion, f.owner.sessionVersion);
    assert.ok(row.expiresAt instanceof Date);
    assert.deepEqual((await claimStandaloneRestoreTicketOnce(
      db, f.owner, f.verified)).autoRetryAllowed, false);
    await assert.rejects(claimStandaloneRestoreTicketOnce(
      db, f.owner, f.verified), /vault-standalone-ticket-used-or-expired/);
    const confirmation = await confirmStandaloneRestoreTicket(
      db, f.owner, f.verified, 'c'.repeat(40));
    assert.equal(confirmation.confirmed, true);
    assert.equal(confirmation.autoRetryAllowed, false);
    assert.equal((await ledger.findOne({ _id: f.receipt.nonceHash })).state,
      'confirmed');
    const saved = JSON.stringify(await ledger.findOne({
      _id: f.receipt.nonceHash,
    }));
    for (const forbidden of [
      KEY, f.receipt.ticket, 'PRIVATE QUICK CONTENT', 'heading',
      'answer', 'archive', 'content', 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
    ]) assert.equal(saved.includes(forbidden), false);
    const indexes = await ledger.indexes();
    assert.ok(indexes.some((i) =>
      i.name === 'vault_standalone_restore_ticket_expiration_v1' &&
      i.expireAfterSeconds === 7 * 24 * 60 * 60));
    assert.ok(indexes.some((i) =>
      i.name === 'vault_standalone_restore_owner_batches_v1' &&
      i.key.ownerId === 1 && i.key.repoId === 1));
    assert.equal(await db.collection('vault_drafts').countDocuments({}), 0);
  });
});

test('M76 concurrent claims have exactly ONE winner and cannot issue a second use', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordStandaloneRestoreTicket(db, f.owner, f.receipt);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      claimStandaloneRestoreTicketOnce(db, f.owner, f.verified)));
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected').length, 11);
    assert.equal((await db.collection('vault_standalone_restore_approvals')
      .findOne({ _id: f.receipt.nonceHash })).state, 'claimed');
    const second = issueStandaloneRestoreTicket(f.owner, f.binding, {
      secret: KEY,
    });
    await assert.rejects(recordStandaloneRestoreTicket(
      db, f.owner, second),
    /vault-standalone-ticket-previous-batch-unconfirmed/);
  });
});

test('M76 revoked session/install/account, held import lock and duplicate nonce all fail closed', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    const users = db.collection('users');
    await users.updateOne({ googleSub: f.owner.ownerId }, {
      $set: { sessionVersion: randomUUID() },
    });
    await assert.rejects(recordStandaloneRestoreTicket(
      db, f.owner, f.receipt), /vault-standalone-ticket-owner-or-repository-changed/);
    await users.updateOne({ googleSub: f.owner.ownerId }, {
      $set: { sessionVersion: f.owner.sessionVersion,
        'vault.installationId': 707 },
    });
    await assert.rejects(recordStandaloneRestoreTicket(
      db, f.owner, f.receipt), /vault-standalone-ticket-owner-or-repository-changed/);
    await users.updateOne({ googleSub: f.owner.ownerId }, {
      $set: { 'vault.installationId': f.owner.installationId,
        vaultImportLock: { state: 'github-write-possible',
          operationId: randomUUID() } },
    });
    await assert.rejects(recordStandaloneRestoreTicket(
      db, f.owner, f.receipt), /vault-standalone-ticket-owner-or-repository-changed/);
    await users.updateOne({ googleSub: f.owner.ownerId }, {
      $unset: { vaultImportLock: '' },
    });
    await recordStandaloneRestoreTicket(db, f.owner, f.receipt);
    await assert.rejects(recordStandaloneRestoreTicket(db, f.owner, f.receipt),
      (error) => error.code === 11000);
  });
});

test('M76 expiry and wrong owner cannot claim; separate Notes receipt collection untouched', onlyReplica, async () => {
  await disposable(async (db) => {
    const f = await fixture(db);
    await recordStandaloneRestoreTicket(db, f.owner, f.receipt);
    await assert.rejects(claimStandaloneRestoreTicketOnce(
      db, { ...f.owner, repoId: f.owner.repoId + 1 }, f.verified),
    /vault-standalone-ticket-used-or-expired/);
    await assert.rejects(claimStandaloneRestoreTicketOnce(
      db, f.owner, f.verified, {
        now: new Date(f.receipt.expiresAt.getTime()),
      }), /vault-standalone-ticket-used-or-expired/);
    const row = await db.collection('vault_standalone_restore_approvals')
      .findOne({ _id: f.receipt.nonceHash });
    assert.equal(row.state, 'pending');
    assert.equal(await db.collection('vault_restore_approvals')
      .countDocuments({}), 0);
  });
});
