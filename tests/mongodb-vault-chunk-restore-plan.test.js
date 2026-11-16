import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { putHybridDraft } from '../lib/oge-vault-hybrid-drafts.js';
import { exportVaultNotesSnapshotChunk } from '../lib/oge-vault-backup-export-chunk.js';
import { planVaultNotesChunkRestoreReadOnly } from '../lib/oge-vault-backup-chunk-restore-plan.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = { skip: !uri ? 'Needs disposable local Mongo replica set' : false };
const H = (v) => createHash('sha1').update(v).digest('hex');
const SOURCE = H('m54-source'), SOURCE_TREE = H('m54-source-tree');
const TARGET = H('m54-target'), TARGET_TREE = H('m54-target-tree');
const noteId = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

async function isolatedDatabase(run) {
  if (!uri ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw new Error('Only disposable localhost:27017 Mongo replica set is permitted');
  const mongo = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: 8000 });
  await mongo.connect();
  const db = mongo.db('oge_ci_chunk_plan_' + randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw new Error('Mongo replica set required');
    await run(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await mongo.close();
  }
}

async function fixture(db) {
  const ownerId = 'm54-owner-' + randomUUID(), sessionVersion = randomUUID();
  const repoId = 9172, subjectA = randomUUID(), subjectB = randomUUID();
  const vault = { status: 'connected', repoId, installationId: 29,
    githubAccountId: '98', githubLogin: 'synthetic-owner',
    repoName: 'ogenotes-vault' };
  await db.collection('users').insertOne({ googleSub: ownerId,
    sessionVersion, vault });
  await db.collection('subjects').insertMany([
    { ownerId, slug: subjectA }, { ownerId, slug: subjectB },
  ]);
  const notes = Array.from({ length: 130 }, (_, i) => {
    const id = noteId(i + 1);
    const note = validatedNote({ subjectId: i % 2 ? subjectA : subjectB,
      heading: 'M54 PRIVATE HEADING ' + i,
      answer: 'M54 PRIVATE ANSWER ' + i, tags: [] },
    { id, now: '2026-11-16T09:00:00.000Z' });
    return { id, note, sha: H('m54-source-note-' + id) };
  });
  const bySha = new Map(notes.map((x) => [x.sha, x]));
  const sourceClient = { branch: 'main', vault,
    async call(path) {
      if (path === '/git/ref/heads/main') return { object: { sha: SOURCE } };
      if (path === '/git/commits/' + SOURCE)
        return { tree: { sha: SOURCE_TREE } };
      if (path === '/git/trees/' + SOURCE_TREE + '?recursive=1')
        return { truncated: false, tree: notes.map(({ id, sha }) => ({
          path: 'notes/' + id + '.json',
          type: 'blob', mode: '100644', sha, size: 250,
        })) };
      throw new Error('Unexpected synthetic source read');
    } };
  const chunks = [];
  let snapshot = null, afterId = null;
  do {
    const part = await exportVaultNotesSnapshotChunk(sourceClient, {
      snapshot, afterId,
      subjectVerifier: async () => true,
      blobReader: async (_client, id, sha) => {
        const row = bySha.get(sha);
        if (row.id !== id) throw new Error('invalid source fixture');
        return { ...row.note, sha };
      },
    });
    chunks.push(part);
    snapshot = part.snapshot;
    afterId = part.nextAfterId;
    if (!part.hasMore) break;
  } while (chunks.length < 10);
  const calls = [];
  const targetClient = { branch: 'main', vault, async call(path, opt = {}) {
    assert.ok(!opt.method || opt.method === 'GET');
    calls.push(path);
    if (path === '/git/ref/heads/main') return { object: { sha: TARGET } };
    if (path === '/git/commits/' + TARGET)
      return { tree: { sha: TARGET_TREE } };
    if (path === '/git/trees/' + TARGET_TREE + '?recursive=1')
      return { truncated: false, tree: [{
        path: 'notes/' + notes[1].id + '.json', type: 'blob',
        mode: '100644', sha: H('already-in-target'), size: 250,
      }] };
    throw new Error('Unexpected synthetic target read');
  } };
  const identity = { ownerId, sessionVersion, repoId };
  const opts = {
    ownerVerifier: async () => {
      const row = await db.collection('users').findOne(
        ownerMutationFilter(ownerId, { sessionVersion }),
        { projection: { vault: 1 } });
      return row?.vault?.status === 'connected' &&
        row.vault.repoId === repoId &&
        row.vault.installationId === vault.installationId;
    },
    subjectVerifier: async (ids) => {
      const rows = await db.collection('subjects').find({
        ownerId, slug: { $in: ids },
      }, { projection: { _id: 0, slug: 1 } }).toArray();
      const set = new Set(rows.map(({ slug }) => slug));
      return set.size === ids.length && ids.every((id) => set.has(id));
    },
    pendingDraftIds: async (ids) => {
      const rows = await db.collection('vault_drafts').find({
        ownerId, repoId, noteId: { $in: ids },
      }, { projection: { _id: 0, noteId: 1 } }).toArray();
      return rows.map(({ noteId }) => noteId);
    },
  };
  return { identity, vault, notes, chunks, targetClient, calls, opts };
}

test('M54 real Mongo signed owner, subjects and encrypted draft conflicts with complete chunk set', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db);
    await putHybridDraft(db.collection('vault_drafts'),
      { ...f.identity, noteId: f.notes[0].id }, 1, {
        subjectId: f.notes[0].note.subjectId, heading: 'PRIVATE UNSAVED DRAFT',
        answer: 'PRIVATE UNSAVED CONTENT', tags: [], favorite: false,
        baseSha: null,
      }, { key: 'a'.repeat(64) });
    const before = await db.collection('users').findOne({
      googleSub: f.identity.ownerId });
    const draftBefore = await db.collection('vault_drafts').findOne({
      ownerId: f.identity.ownerId });
    const plan = await planVaultNotesChunkRestoreReadOnly(
      f.targetClient, f.chunks, f.opts);
    assert.equal(plan.fullSourceVerified, true);
    assert.equal(plan.summary.total, 130);
    assert.equal(plan.summary.draftConflicts, 1);
    assert.equal(plan.summary.existingConflicts, 1);
    assert.equal(plan.summary.createCandidates, 128);
    assert.equal(plan.canCommit, false);
    assert.equal(plan.preview.length, 12);
    assert.equal(plan.preview[0].outcome, 'draft-conflict');
    assert.equal(plan.preview[1].outcome, 'existing-note-conflict');
    assert.deepEqual(await db.collection('users').findOne({
      googleSub: f.identity.ownerId }), before);
    assert.deepEqual(await db.collection('vault_drafts').findOne({
      ownerId: f.identity.ownerId }), draftBefore);
    for (const secret of ['PRIVATE UNSAVED CONTENT',
      'M54 PRIVATE ANSWER', 'M54 PRIVATE HEADING'])
      assert.equal(JSON.stringify(plan).includes(secret), false);
    assert.ok(f.calls.every((path) => !path.startsWith('/contents/')));
  });
});

test('M54 live Mongo stale session fails before GitHub target scan and cannot touch drafts', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db);
    await db.collection('users').updateOne({
      googleSub: f.identity.ownerId,
    }, { $set: { sessionVersion: randomUUID() } });
    await assert.rejects(planVaultNotesChunkRestoreReadOnly(
      f.targetClient, f.chunks, f.opts),
    /vault-chunk-restore-owner-changed/);
    assert.equal(f.calls.length, 0);
    assert.equal(await db.collection('vault_drafts').countDocuments({
      ownerId: f.identity.ownerId }), 0);
  });
});
