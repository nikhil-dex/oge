import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promoteStagedVaultFileIndex } from '../lib/oge-vault-file-index-promotion.js';

const identity = { ownerId: 'promote-owner', repoId: 961 };
const credential = { sessionVersion: randomUUID() };
const operationId = randomUUID();
const snapshot = 'a'.repeat(40);
const subjectId = randomUUID();
const entries = Array.from({ length: 251 }, () => {
  const noteId = randomUUID();
  return { noteId, path: 'notes/' + noteId + '.json', blobSha: 'b'.repeat(40) };
}).sort((a, b) => a.noteId.localeCompare(b.noteId));
const tree = async () => ({ snapshot, notes: entries });

function fixture({ rows = entries.map((entry, ordinal) => ({
  ...identity, operationId, ordinal, ...entry, subjectId,
})), runState = 'bootstrap-staged' } = {}) {
  const run = { ...identity, operationId, state: runState,
    snapshot, nextOffset: entries.length, totalNotes: entries.length };
  const catalog = new Map();
  const obsoleteId = randomUUID();
  catalog.set(obsoleteId, { ...identity, noteId: obsoleteId,
    status: 'present', lastSeenSnapshot: snapshot });
  const bulkSizes = [];
  const db = {
    client: { startSession() {
      return { async withTransaction(work) { return work({}); },
        async endSession() {} };
    } },
    collection(name) {
      if (name === 'users') return {
        async findOne(filter) {
          assert.equal(filter.googleSub, identity.ownerId);
          assert.equal(filter.sessionVersion, credential.sessionVersion);
          assert.equal(filter['vault.repoId'], identity.repoId);
          return { _id: 'active' };
        },
        async updateOne(filter, _update, { session } = {}) {
          assert.ok(session);
          assert.equal(filter.googleSub, identity.ownerId);
          return { matchedCount: 1 };
        },
      };
      if (name === 'vault_file_index_state') return {
        async findOne() { return { ...run }; },
        async updateOne(filter, update) {
          if (filter.operationId !== run.operationId ||
              filter.state !== run.state || filter.snapshot !== run.snapshot ||
              filter.totalNotes !== run.totalNotes ||
              (filter.nextOffset !== undefined && filter.nextOffset !== run.nextOffset))
            return { matchedCount: 0 };
          Object.assign(run, update.$set);
          return { matchedCount: 1 };
        },
      };
      if (name === 'vault_file_index_bootstrap') return {
        find(filter, { projection }) {
          assert.equal(filter.ownerId, identity.ownerId);
          assert.equal(filter.repoId, identity.repoId);
          assert.equal(filter.operationId, operationId);
          assert.deepEqual(Object.keys(projection).filter((v) => v === 'answer'), []);
          return { sort(order) {
            assert.deepEqual(order, { ordinal: 1 });
            return { limit(count) {
              assert.equal(count, 252);
              return { async toArray() { return rows.map((row) => ({ ...row })); } };
            } };
          } };
        },
      };
      if (name === 'vault_files') return {
        async bulkWrite(ops, { session } = {}) {
          assert.ok(session);
          assert.ok(ops.length <= 250);
          bulkSizes.push(ops.length);
          for (const { updateOne: item } of ops) {
            const key = item.filter.noteId;
            catalog.set(key, { ...catalog.get(key), ...item.update.$set });
          }
        },
        async updateMany(filter, update, { session } = {}) {
          assert.ok(session);
          assert.equal(filter.lastIndexOperationId.$ne, operationId);
          for (const [id, entry] of catalog) {
            if (entry.status !== 'missing' && entry.lastIndexOperationId !== operationId)
              catalog.set(id, { ...entry, ...update.$set });
          }
        },
      };
      throw Error('Unexpected collection ' + name);
    },
  };
  const client = { vault: { repoId: identity.repoId }, branch: 'main' };
  return { db, client, run, catalog, obsoleteId, bulkSizes };
}
const promote = (f, options = {}) => promoteStagedVaultFileIndex(
  f.db, f.client, identity, {
    credential, operationId, treeReader: tree, headReader: async () => snapshot,
    ...options,
  });

test('B6 publishes 251 staged notes in bounded batches, atomically marks obsolete files', async () => {
  const f = fixture();
  const status = await promote(f);
  assert.deepEqual(status, {
    status: 'ready', indexed: 251, snapshot, advisoryOnly: true,
  });
  assert.equal(f.run.state, 'ready');
  assert.deepEqual(f.bulkSizes, [250, 1]);
  assert.equal(f.catalog.size, 252);
  assert.equal(f.catalog.get(f.obsoleteId).status, 'missing');
  assert.ok(entries.every((entry) => f.catalog.get(entry.noteId).status === 'present'));
  assert.doesNotMatch(JSON.stringify([...f.catalog.values()]), /answer|heading|tags/);
});

test('B6 refuses partial or mismatched staged metadata before any publication', async () => {
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => { rows[0].blobSha = 'f'.repeat(40); },
    (rows) => { rows[0].ordinal = 1; },
    (rows) => { rows[0].subjectId = 'not-a-uuid'; },
  ]) {
    const rows = entries.map((entry, ordinal) => ({
      ...identity, operationId, ordinal, ...entry, subjectId,
    }));
    mutate(rows);
    const f = fixture({ rows });
    await assert.rejects(promote(f), /vault-index-promotion-(incomplete|metadata-mismatch)/);
    assert.deepEqual(f.bulkSizes, []);
    assert.equal(f.run.state, 'bootstrap-staged');
    assert.equal(f.catalog.get(f.obsoleteId).status, 'present');
  }
});

test('B6 rejects competing operation IDs and GitHub drift without publishing', async () => {
  const f = fixture();
  await assert.rejects(promote(f, { operationId: randomUUID() }),
    /vault-index-promotion-not-staged/);
  await assert.rejects(promote(f, {
    treeReader: async () => ({ snapshot: 'f'.repeat(40), notes: entries }),
  }), /vault-index-promotion-head-changed/);
  await assert.rejects(promote(f, { headReader: async () => 'f'.repeat(40) }),
    /vault-index-promotion-head-changed/);
  assert.equal(f.run.state, 'bootstrap-staged');
  assert.deepEqual(f.bulkSizes, []);
});

test('B6 after a successful transaction, changed GitHub HEAD returns stale', async () => {
  const f = fixture();
  let checks = 0;
  const result = await promote(f, {
    headReader: async () => ++checks === 1 ? snapshot : 'f'.repeat(40),
  });
  assert.equal(result.status, 'stale');
  assert.equal(f.run.state, 'stale');
});

test('B6 lost verification response keeps an operation-owned recoverable state', async () => {
  const f = fixture();
  let checks = 0;
  const result = await promote(f, {
    headReader: async () => {
      if (++checks === 1) return snapshot;
      throw Error('GitHub unavailable');
    },
  });
  assert.equal(result.status, 'verifying');
  assert.equal(result.action, 'reconcile-verification');
  assert.equal(f.run.state, 'verifying');
});

test('B6 publication stays internal; no note body, GitHub write or destructive routes', async () => {
  const code = await readFile(new URL('../lib/oge-vault-file-index-promotion.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/vault/file-index/route.js', import.meta.url), 'utf8');
  const notes = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  assert.match(code, /withAtomicBackupImport/);
  assert.match(code, /vault_file_index_bootstrap/);
  assert.doesNotMatch(code, /deleteMany\(|deleteOne\(|answer:|heading:|tags:/);
  assert.doesNotMatch(route, /promoteStagedVaultFileIndex/);
  assert.doesNotMatch(notes, /promoteStagedVaultFileIndex/);
});
