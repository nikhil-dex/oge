import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  beginVaultFileIndexBootstrap, advanceVaultFileIndexBootstrap,
} from '../lib/oge-vault-file-index-bootstrap.js';

const scope = { ownerId: 'bootstrap-owner', repoId: 77 };
const credential = { sessionVersion: randomUUID() };
const operationId = randomUUID();
const sha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);
const subjectId = randomUUID();
const entries = Array.from({ length: 251 }, () => {
  const noteId = randomUUID();
  return { noteId, path: 'notes/' + noteId + '.json', blobSha };
}).sort((a, b) => a.noteId.localeCompare(b.noteId));
const tree = () => ({ snapshot: sha, notes: entries });

function fixture() {
  let state = null;
  const staged = new Map();
  let publishedWrites = 0;
  const db = {
    client: {
      startSession() {
        return { async withTransaction(work) { return work({}); },
          async endSession() {} };
      },
    },
    collection(name) {
      if (name === 'users') return {
        async findOne(filter) {
          assert.equal(filter.googleSub, scope.ownerId);
          assert.equal(filter.sessionVersion, credential.sessionVersion);
          assert.equal(filter['vault.repoId'], scope.repoId);
          return { _id: 'account' };
        },
        async updateOne(filter, update, opts) {
          assert.ok(opts?.session);
          assert.equal(filter.googleSub, scope.ownerId);
          return { matchedCount: 1 };
        },
      };
      if (name === 'vault_file_index_state') return {
        async findOne() { return state ? { ...state } : null; },
        async updateOne(filter, update) {
          if (filter.$or) {
            if (state && !['ready', 'stale'].includes(state.state)) {
              const conflict = Error('duplicate key'); conflict.code = 11000;
              throw conflict;
            }
          } else if (!state || state.operationId !== filter.operationId ||
              state.state !== filter.state ||
              state.snapshot !== filter.snapshot ||
              state.totalNotes !== filter.totalNotes ||
              state.nextOffset !== filter.nextOffset) {
            return { matchedCount: 0, upsertedCount: 0 };
          }
          const created = !state;
          state = { ...state, ...update.$setOnInsert, ...update.$set };
          return { matchedCount: Number(!created), upsertedCount: Number(created) };
        },
      };
      if (name === 'vault_file_index_bootstrap') return {
        async bulkWrite(ops, opts) {
          assert.ok(opts?.session);
          assert.ok(ops.length <= 100);
          for (const entry of ops) {
            const record = entry.updateOne.update.$set;
            assert.deepEqual(Object.keys(record).sort(), [
              'blobSha', 'noteId', 'operationId', 'ordinal',
              'ownerId', 'path', 'repoId', 'subjectId',
            ]);
            staged.set(record.noteId, { ...record });
          }
        },
      };
      if (name === 'vault_files') return {
        async updateOne() { publishedWrites++; throw Error('cannot publish'); },
      };
      throw Error('Unexpected collection ' + name);
    },
  };
  const client = { branch: 'main', vault: { repoId: scope.repoId },
    async call(path) {
      if (path === '/git/ref/heads/main') return { object: { sha } };
      throw Error('Unexpected client call ' + path);
    } };
  let blobReads = 0;
  const reader = async (_, noteId, revision) => {
    blobReads++;
    return { id: noteId, subjectId, sha: revision,
      heading: 'NEVER STORE', answer: 'PRIVATE BODY', tags: ['private'] };
  };
  return { db, client, staged, reader, get state() { return state; },
    get blobReads() { return blobReads; },
    get publishedWrites() { return publishedWrites; } };
}

test('B6 first-time 251-note bootstrap advances in 100/100/51 metadata-only batches', async () => {
  const f = fixture();
  const started = await beginVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId, treeReader: tree });
  assert.equal(started.totalNotes, 251);
  assert.equal(f.state.nextOffset, 0);
  for (const [nextOffset, status] of [
    [100, 'bootstrapping'], [200, 'bootstrapping'], [251, 'bootstrap-staged'],
  ]) {
    const result = await advanceVaultFileIndexBootstrap(f.db, f.client, scope, {
      credential, operationId, treeReader: tree, reader: f.reader,
    });
    assert.equal(result.nextOffset, nextOffset);
    assert.equal(result.status, status);
  }
  assert.equal(f.staged.size, 251);
  assert.equal(f.blobReads, 251);
  assert.equal(f.publishedWrites, 0);
  assert.equal(f.state.state, 'bootstrap-staged');
  assert.doesNotMatch(JSON.stringify([...f.staged.values()]), /NEVER STORE|PRIVATE BODY|heading|answer|tags/);
});

test('B6 bootstrap refuses duplicate operation, expired run token and invalid bounds', async () => {
  const f = fixture();
  await beginVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId, treeReader: tree });
  await assert.rejects(beginVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, treeReader: tree }), /vault-index-bootstrap-busy/);
  await assert.rejects(advanceVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId: randomUUID(), treeReader: tree }),
  /vault-index-bootstrap-fence-missing/);
  await assert.rejects(advanceVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId, treeReader: tree, limit: 101 }),
  /Invalid bootstrap cursor\/limit/);
  assert.equal(f.staged.size, 0);
});

test('B6 bootstrap does not advance cursor on changed GitHub head', async () => {
  const f = fixture();
  await beginVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId, treeReader: tree });
  await assert.rejects(advanceVaultFileIndexBootstrap(f.db, f.client, scope,
    { credential, operationId, treeReader: async () =>
      ({ snapshot: 'f'.repeat(40), notes: entries }), reader: f.reader }),
  /vault-index-bootstrap-head-changed/);
  assert.equal(f.state.nextOffset, 0);
  assert.equal(f.staged.size, 0);
});

test('B6 bootstrap refuses untrusted duplicate/unsorted tree listings', async () => {
  const f = fixture();
  await assert.rejects(beginVaultFileIndexBootstrap(f.db, f.client, scope, {
    credential, operationId,
    treeReader: async () => ({ snapshot: sha,
      notes: [entries[0], entries[0]] }),
  }), /vault-index-bootstrap-tree-invalid/);
  await assert.rejects(beginVaultFileIndexBootstrap(f.db, f.client, scope, {
    credential, operationId,
    treeReader: async () => ({ snapshot: sha,
      notes: [entries[1], entries[0]] }),
  }), /vault-index-bootstrap-tree-invalid/);
  assert.equal(f.state, null);
});

test('B6 bootstrap never publishes content or destructive note operations', async () => {
  const bootstrap = await readFile(new URL('../lib/oge-vault-file-index-bootstrap.js', import.meta.url), 'utf8');
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  const production = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  assert.match(bootstrap, /vault_file_index_bootstrap/);
  assert.doesNotMatch(bootstrap, /db\.collection\('vault_files'\)/);
  assert.doesNotMatch(bootstrap, /deleteMany\(|deleteOne\(/);
  assert.match(mongo, /vault_file_index_bootstrap.*unique: true/);
  assert.doesNotMatch(production, /beginVaultFileIndexBootstrap/);
});
