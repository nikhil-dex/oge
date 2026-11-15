import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { planVaultSubjectDeletion } from '../lib/oge-vault-subject-deletion-plan.js';

const ownerId = 'manifest-owner';
const subjectId = randomUUID();
const repoId = 51;
const scope = { ownerId, repoId, subjectId };
const snapshot = 'a'.repeat(40);
const note = (subject = randomUUID()) => ({
  id: randomUUID(), subjectId: subject, sha: 'b'.repeat(40),
});
const drafts = (found = false) => ({
  async countDocuments(filter, opts) {
    assert.deepEqual(filter, { ownerId, repoId });
    assert.equal(opts.limit, 1);
    return Number(found);
  },
});

test('manifest planner gathers target notes from all pages with immutable blob SHA', async () => {
  const target = note(subjectId);
  const first = Array.from({ length: 25 }, () => note());
  let count = 0;
  const result = await planVaultSubjectDeletion({}, drafts(), scope, {
    pageReader: async (_client, { cursor, limit }) => {
      assert.equal(limit, 25);
      count++;
      return cursor ? {
        notes: [target], snapshot, total: 26, nextCursor: null,
      } : {
        notes: first, snapshot, total: 26, nextCursor: 'second',
      };
    },
  });
  assert.equal(count, 2);
  assert.equal(result.ready, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.totalNotes, 26);
  assert.deepEqual(result.files, [
    { noteId: target.id, path: 'notes/' + target.id + '.json', sha: target.sha },
  ]);
  assert.equal(JSON.stringify(result).includes('answer'), false);
});

test('no remote reads occur when owner/repository has unsynced drafts', async () => {
  let called = false;
  const result = await planVaultSubjectDeletion({}, drafts(true), scope, {
    pageReader: async () => { called = true; throw Error('unexpected'); },
  });
  assert.equal(called, false);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'pending-vault-drafts');
});

test('incomplete and mutated GitHub snapshots fail closed', async () => {
  await assert.rejects(planVaultSubjectDeletion({}, drafts(), scope, {
    pageReader: async () => ({
      snapshot, total: 2, notes: [note()], nextCursor: null,
    }),
  }), /vault-deletion-manifest-incomplete/);
  await assert.rejects(planVaultSubjectDeletion({}, drafts(), scope, {
    pageReader: async (_, { cursor }) => cursor ? ({
      snapshot: 'c'.repeat(40), total: 26, notes: [note()], nextCursor: null,
    }) : ({
      snapshot, total: 26, notes: Array.from({ length: 25 }, () => note()),
      nextCursor: 'second',
    }),
  }), /vault-deletion-manifest-invalid/);
});

test('duplicate note IDs and cyclic page cursors fail closed', async () => {
  const repeated = note();
  await assert.rejects(planVaultSubjectDeletion({}, drafts(), scope, {
    pageReader: async (_, { cursor }) => cursor ? ({
      snapshot, total: 26, notes: [repeated], nextCursor: null,
    }) : ({
      snapshot, total: 26, notes: [repeated,
        ...Array.from({ length: 24 }, () => note())], nextCursor: 'second',
    }),
  }), /vault-deletion-manifest-invalid/);
  await assert.rejects(planVaultSubjectDeletion({}, drafts(), scope, {
    pageReader: async () => ({
      snapshot, total: 30, notes: [note()], nextCursor: 'same',
    }),
  }), /vault-deletion-manifest-cursor-invalid/);
});

test('drafts appearing after scan invalidate previously gathered manifest', async () => {
  let checks = 0;
  const result = await planVaultSubjectDeletion({}, {
    async countDocuments() { return checks++ > 0 ? 1 : 0; },
  }, scope, {
    pageReader: async () => ({
      snapshot, total: 1, notes: [note(subjectId)], nextCursor: null,
    }),
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.files, []);
});

test('deletion planner cannot mutate GitHub, MongoDB or production subject deletion gate', async () => {
  const source = await readFile(new URL('../lib/oge-vault-subject-deletion-plan.js', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /deleteOne\(|deleteMany\(|commitVaultNoteBatch\(|method: 'PATCH'/);
  assert.match(source, /advisoryOnly: true/);
  assert.match(legacy, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});
