import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  inspectVaultFileIndexRecovery, reconcileVaultFileIndexVerification,
} from '../lib/oge-vault-file-index-recovery.js';

const scope = { ownerId: 'index-recovery-owner', repoId: 348 };
const version = randomUUID();
const operationId = randomUUID();
const sha = (c) => c.repeat(40);
const snapshot = sha('a');
const laterHead = sha('f');
const subjectId = randomUUID();
const noteId = randomUUID();
const file = { ...scope, noteId, subjectId,
  path: 'notes/' + noteId + '.json', blobSha: sha('b') };
const remote = () => ({ ...scope, snapshot, totalNotes: 1,
  files: [{ ...file }], advisoryOnly: true });

function fixture({ state = 'verifying', row = null, changed = false,
  revision = operationId, missingOwner = false } = {}) {
  const current = { ...scope, state, operationId: revision, snapshot, totalNotes: 1 };
  const rows = row || [{ noteId, subjectId, path: file.path,
    blobSha: file.blobSha, lastSeenSnapshot: snapshot }];
  const updates = [];
  let reads = 0;
  let githubReads = 0;
  const db = { collection(name) {
    if (name === 'users') return {
      async findOne(filter) {
        assert.equal(filter.googleSub, scope.ownerId);
        assert.equal(filter.sessionVersion, version);
        assert.equal(filter['vault.repoId'], scope.repoId);
        return missingOwner ? null : { _id: 'owner' };
      },
    };
    if (name === 'vault_file_index_state') return {
      async findOne() { reads++; return { ...current }; },
      async updateOne(filter, update) {
        updates.push({ filter, update });
        if (filter.operationId !== current.operationId ||
            filter.state !== current.state || filter.snapshot !== current.snapshot)
          return { matchedCount: 0 };
        Object.assign(current, update.$set);
        return { matchedCount: 1 };
      },
    };
    if (name === 'vault_files') return {
      find(filter) {
        assert.equal(filter.ownerId, scope.ownerId);
        assert.equal(filter.repoId, scope.repoId);
        assert.equal(filter.status, 'present');
        return { limit(n) {
          assert.equal(n, 2);
          return { async toArray() { return rows.map((v) => ({ ...v })); } };
        } };
      },
    };
    throw Error('Recovery cannot touch collection ' + name);
  } };
  const client = { vault: { repoId: scope.repoId } };
  return { db, client, current, updates, rows,
    get reads() { return reads; },
    get githubReads() { return githubReads; },
    scanner: async () => {
      githubReads++;
      return { ...remote(), ...(changed ? { snapshot: laterHead } : {}) };
    },
  };
}

async function reconcile(f, options = {}) {
  return reconcileVaultFileIndexVerification(f.db, f.client, scope, {
    credential: { sessionVersion: version },
    scanner: f.scanner, headReader: async () => snapshot, ...options,
  });
}

test('B6 recovery verifies exact metadata, current GitHub snapshot, then releases verifying fence', async () => {
  const f = fixture();
  const result = await reconcile(f);
  assert.deepEqual(result, {
    status: 'ready', action: 'none', snapshot, indexed: 1, advisoryOnly: true,
  });
  assert.equal(f.current.state, 'ready');
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].filter.operationId, operationId);
  assert.equal(f.githubReads, 1);
});

test('B6 recovery rejects same-count but wrong metadata without clearing its lock', async () => {
  for (const mismatch of [
    { blobSha: sha('f') }, { subjectId: randomUUID() },
    { path: 'notes/other.json' }, { lastSeenSnapshot: laterHead },
  ]) {
    const f = fixture({ row: [{ noteId, subjectId, path: file.path,
      blobSha: file.blobSha, lastSeenSnapshot: snapshot, ...mismatch }] });
    const result = await reconcile(f);
    assert.equal(result.action, 'manual-review');
    assert.equal(result.reason, 'metadata-mismatch');
    assert.equal(f.current.state, 'verifying');
    assert.equal(f.updates.length, 0);
  }
});

test('B6 recovery marks an outdated verified snapshot stale', async () => {
  const f = fixture({ changed: true });
  const result = await reconcile(f);
  assert.equal(result.status, 'stale');
  assert.equal(f.current.state, 'stale');
});

test('B6 recovery preserves uncertain syncing state and makes no GitHub calls', async () => {
  const f = fixture({ state: 'syncing' });
  const result = await reconcile(f);
  assert.equal(result.status, 'syncing');
  assert.equal(result.action, 'manual-review');
  assert.equal(f.githubReads, 0);
  assert.equal(f.updates.length, 0);
});

test('B6 recovery never marks ready during an unavailable or changed GitHub head', async () => {
  const offline = fixture();
  const failure = await reconcile(offline, {
    headReader: async () => { throw Error('network down'); },
  });
  assert.equal(failure.action, 'manual-review');
  assert.equal(offline.current.state, 'verifying');
  const changed = fixture();
  const result = await reconcile(changed, { headReader: async () => laterHead });
  assert.equal(result.status, 'stale');
});

test('B6 recovery rejects expired Oge sessions and incorrect repository mappings', async () => {
  const expired = fixture({ missingOwner: true });
  await assert.rejects(reconcile(expired), /vault-file-index-session-expired/);
  assert.equal(expired.updates.length, 0);
  const mismatch = fixture();
  await assert.rejects(reconcileVaultFileIndexVerification(mismatch.db,
    { vault: { repoId: 999 } }, scope, {
      credential: { sessionVersion: version }, scanner: mismatch.scanner,
    }), /vault-file-index-repository-mismatch/);
});

test('B6 operator diagnosis is read-only and identifies reconcilable operations', async () => {
  const f = fixture();
  const info = await inspectVaultFileIndexRecovery(f.db, scope);
  assert.equal(info.action, 'reconcile-verification');
  assert.equal(info.operationId, operationId);
  assert.equal(f.updates.length, 0);
  const source = await readFile(new URL('../lib/oge-vault-file-index-recovery.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /deleteOne\(|deleteMany\(|bulkWrite\(/);
  assert.doesNotMatch(source, /answer:|heading:|tags:/);
});
