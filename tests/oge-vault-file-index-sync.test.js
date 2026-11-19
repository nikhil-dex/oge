import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { synchronizeVaultFileIndex } from '../lib/oge-vault-file-index-sync.js';

const identity = { ownerId: 'index-sync-owner', repoId: 817 };
const sha = (value) => value.repeat(40);
const snapshotSha = sha('a');
const subjectId = randomUUID(), id = randomUUID(), idRemoved = randomUUID();
const accountVersion = randomUUID();
const operationId = randomUUID();
const credential = { sessionVersion: accountVersion };
const note = { ...identity, noteId: id, subjectId,
  path: 'notes/' + id + '.json', blobSha: sha('b') };
const scan = async () => ({ ...identity, snapshot: snapshotSha,
  totalNotes: 1, files: [note], advisoryOnly: true });

function fixture({ initialState = null, staleFile = false } = {}) {
  let state = initialState;
  const records = new Map();
  if (staleFile) records.set(idRemoved, {
    ...identity, noteId: idRemoved, subjectId, status: 'present',
    path: 'notes/' + idRemoved + '.json', blobSha: sha('c'),
  });
  const operations = [];
  const db = {
    client: { startSession() {
      return {
        async withTransaction(work) { return work(); },
        async endSession() {},
      };
    } },
    collection(name) {
      if (name === 'vault_file_index_state') return {
        async updateOne(filter, update, options) {
          if (filter.operationId && filter.operationId !== state?.operationId)
            return { matchedCount: 0, upsertedCount: 0 };
          if (filter.state && typeof filter.state === 'string' &&
              state?.state !== filter.state)
            return { matchedCount: 0, upsertedCount: 0 };
          if (filter.state?.$in && !filter.state.$in.includes(state?.state))
            return { matchedCount: 0, upsertedCount: 0 };
          if (filter.$or) {
            const allowed = !state || ['ready', 'stale'].includes(state.state);
            if (!allowed) {
              const error = Error('duplicate'); error.code = 11000; throw error;
            }
          }
          const inserted = !state;
          state = { ...(state || {}), ...(update.$setOnInsert || {}), ...update.$set };
          return { matchedCount: Number(!inserted), upsertedCount: Number(inserted) };
        },
      };
      if (name === 'users') return {
        async findOne(filter) {
          assert.equal(filter.googleSub, identity.ownerId);
          assert.equal(filter.sessionVersion, accountVersion);
          assert.equal(filter['vault.repoId'], identity.repoId);
          return { _id: 'owner-row' };
        },
        async updateOne(filter, _update, { session } = {}) {
          assert.ok(session);
          assert.equal(filter.googleSub, identity.ownerId);
          assert.equal(filter.sessionVersion, accountVersion);
          assert.equal(filter['vault.repoId'], identity.repoId);
          return { matchedCount: 1 };
        },
      };
      if (name === 'vault_files') return {
        find(filter) {
          assert.equal(filter.ownerId, identity.ownerId);
          assert.equal(filter.repoId, identity.repoId);
          return { limit(n) {
            assert.equal(n, 30001);
            return { async toArray() { return [...records.values()]; } };
          } };
        },
        async bulkWrite(updates, { session } = {}) {
          assert.ok(session);
          operations.push('upsert');
          for (const { updateOne } of updates) {
            const entry = records.get(updateOne.filter.noteId) || updateOne.update.$setOnInsert;
            records.set(updateOne.filter.noteId, { ...entry, ...updateOne.update.$set });
          }
        },
        async updateMany(filter, update, { session } = {}) {
          assert.ok(session);
          operations.push('tombstone');
          for (const [key, value] of records) {
            if (value.lastSeenSnapshot !== filter.lastSeenSnapshot.$ne &&
                value.status !== 'missing')
              records.set(key, { ...value, ...update.$set });
          }
        },
      };
      throw Error('Unexpected collection ' + name);
    },
  };
  const client = { branch: 'main', vault: { repoId: identity.repoId } };
  return { db, client, records, operations, get state() { return state; } };
}

test('B6 persists metadata idempotently and soft-tombstones externally removed files', async () => {
  const f = fixture({ staleFile: true });
  const result = await synchronizeVaultFileIndex(f.db, f.client, identity, {
    credential, scanner: scan, operationId, headReader: async () => snapshotSha,
  });
  assert.deepEqual(result, {
    status: 'ready', indexed: 1, snapshot: snapshotSha, advisoryOnly: true,
  });
  assert.equal(f.state.state, 'ready');
  assert.equal(f.records.get(id).blobSha, sha('b'));
  assert.equal(f.records.get(idRemoved).status, 'missing');
  assert.deepEqual(f.operations, ['upsert', 'tombstone']);
  assert.doesNotMatch(JSON.stringify([...f.records.values()]), /answer|heading|tags/);
});

test('B6 marks index stale rather than ready if GitHub changes during application', async () => {
  const f = fixture();
  const result = await synchronizeVaultFileIndex(f.db, f.client, identity, {
    credential, scanner: scan, operationId, headReader: async () => sha('f'),
  });
  assert.equal(result.status, 'stale');
  assert.equal(f.state.reason, 'github-head-changed-or-unavailable');
  assert.equal(f.records.get(id).status, 'present');
});

test('B6 does not write metadata for a malformed or stale scanner response', async () => {
  const f = fixture();
  await assert.rejects(synchronizeVaultFileIndex(f.db, f.client, identity, {
    credential, operationId, scanner: async () => ({
      ...identity, snapshot: snapshotSha, totalNotes: 2, files: [note], advisoryOnly: true,
    }),
  }), /vault-file-index-snapshot-invalid/);
  assert.equal(f.state.state, 'stale');
  assert.equal(f.records.size, 0);
});

test('B6 refuses concurrent sync and does not touch metadata', async () => {
  const f = fixture({ initialState: { ...identity, state: 'syncing',
    operationId: randomUUID() } });
  await assert.rejects(synchronizeVaultFileIndex(f.db, f.client, identity, {
    credential, operationId, scanner: scan,
  }), /vault-file-index-sync-busy/);
  assert.equal(f.records.size, 0);
});

test('B6 requires signed session and matching repository before acquiring sync lock', async () => {
  const f = fixture();
  await assert.rejects(synchronizeVaultFileIndex(f.db,
    { ...f.client, vault: { repoId: 999 } }, identity,
    { credential, operationId, scanner: scan }), /vault-file-index-repository-mismatch/);
  await assert.rejects(synchronizeVaultFileIndex(f.db, f.client, identity,
    { operationId, scanner: scan }), /Signed session version/);
  assert.equal(f.state, null);
});

test('B6 coordinator does not delete rows or persist note content', async () => {
  const source = await readFile(new URL('../lib/oge-vault-file-index-sync.js', import.meta.url), 'utf8');
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  assert.match(source, /withAtomicBackupImport/);
  assert.match(source, /ownerMutationFilter/);
  assert.match(source, /status: 'missing'/);
  assert.doesNotMatch(source, /deleteMany\(|deleteOne\(|content: note\.|answer: note\.|heading: note\./);
  assert.match(mongo, /vault_file_index_state.*unique: true/);
});
