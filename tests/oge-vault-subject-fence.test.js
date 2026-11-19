import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  withVaultSubjectWrite, withVaultSubjectsWrite, lockEmptyVaultSubject, VaultSubjectLockedError,
} from '../lib/oge-vault-subject-fence.js';

const ownerId = 'owner-test';
const subjectId = randomUUID();

function subjectCollection() {
  const rows = new Map();
  const add = (id) => rows.set(id, { ownerId, slug: id, vaultActiveWriters: 0 });
  add(subjectId);
  return {
    rows, add,
    db: { collection(name) {
      assert.equal(name, 'subjects');
      return { async updateOne(filter, update) {
        const row = rows.get(filter.slug);
        if (!row || row.ownerId !== filter.ownerId) return { matchedCount: 0 };
        if (filter.vaultDeletionState?.$ne === 'locked' && row.vaultDeletionState === 'locked')
          return { matchedCount: 0 };
        if (filter.vaultActiveWriters?.$gt === 0 && row.vaultActiveWriters <= 0)
          return { matchedCount: 0 };
        if (filter.$or && row.vaultActiveWriters !== 0)
          return { matchedCount: 0 };
        if (update.$inc) row.vaultActiveWriters += update.$inc.vaultActiveWriters;
        if (update.$set) Object.assign(row, update.$set);
        return { matchedCount: 1 };
      } };
    } },
  };
}

test('active writer prevents locking until it has finished and released', async () => {
  const { db, rows } = subjectCollection();
  let release;
  const work = withVaultSubjectWrite(db, ownerId, subjectId, () =>
    new Promise((resolve) => { release = resolve; }));
  assert.equal(rows.get(subjectId).vaultActiveWriters, 1);
  assert.equal(await lockEmptyVaultSubject(db, ownerId, subjectId), false);
  release('saved');
  assert.equal(await work, 'saved');
  assert.equal(rows.get(subjectId).vaultActiveWriters, 0);
  assert.equal(await lockEmptyVaultSubject(db, ownerId, subjectId), true);
  await assert.rejects(withVaultSubjectWrite(db, ownerId, subjectId, async () => {}),
    VaultSubjectLockedError);
});

test('failed write always releases fence; lock remains fail closed', async () => {
  const { db, rows } = subjectCollection();
  await assert.rejects(withVaultSubjectWrite(db, ownerId, subjectId,
    async () => { throw new Error('github-offline'); }), /github-offline/);
  assert.equal(rows.get(subjectId).vaultActiveWriters, 0);
  assert.equal(await lockEmptyVaultSubject(db, ownerId, subjectId), true);
  assert.equal(await lockEmptyVaultSubject(db, ownerId, subjectId), false);
});

test('multi-subject batch fences every subject with canonical ordering', async () => {
  const { db, rows, add } = subjectCollection();
  const second = randomUUID();
  add(second);
  await withVaultSubjectsWrite(db, ownerId, [second, subjectId, second], async () => {
    assert.equal(rows.get(subjectId).vaultActiveWriters, 1);
    assert.equal(rows.get(second).vaultActiveWriters, 1);
    assert.equal(await lockEmptyVaultSubject(db, ownerId, second), false);
  });
  assert.equal(rows.get(subjectId).vaultActiveWriters, 0);
  assert.equal(rows.get(second).vaultActiveWriters, 0);
});

test('Vault API mutators are fenced but connected production subject deletion stays disabled', async () => {
  const files = ['../app/api/vault/drafts/route.js',
    '../app/api/vault/notes-main/route.js', '../app/api/vault/notes/route.js',
    '../app/api/vault/batch/route.js'];
  for (const path of files) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /withVaultSubject(?:s)?Write\(/);
    assert.match(source, /VaultSubjectLockedError/);
  }
  const legacy = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(legacy, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
  const fence = await readFile(new URL('../lib/oge-vault-subject-fence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fence, /expireAfterSeconds/);
});
