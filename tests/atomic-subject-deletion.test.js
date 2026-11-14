import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteSubjectAtomically } from '../lib/atomic-subject-deletion.js';

function fakeDb({ subject = { _id: 'subject-id' }, count = 2, accountMatched = 1, deleted = 1, failNoteDelete = false } = {}) {
  const calls = [];
  const session = {
    async withTransaction(work, options) {
      calls.push('begin');
      assert.equal(options.readConcern.level, 'snapshot');
      assert.equal(options.writeConcern.w, 'majority');
      const result = await work();
      calls.push('commit');
      return result;
    },
    async endSession() { calls.push('end'); },
  };
  const db = {
    client: { startSession() { calls.push('start'); return session; } },
    collection(name) {
      if (name === 'subjects') return {
        async findOne(filter, options) {
          calls.push('findSubject');
          assert.deepEqual(filter, { ownerId: 'owner-a', slug: 'subject-a' });
          assert.equal(options.session, session);
          return subject;
        },
        async countDocuments(filter, options) {
          calls.push('countSubjects');
          assert.deepEqual(filter, { ownerId: 'owner-a' });
          assert.equal(options.session, session);
          return count;
        },
        async deleteOne(filter, options) {
          calls.push('deleteSubject');
          assert.deepEqual(filter, { _id: 'subject-id', ownerId: 'owner-a', slug: 'subject-a' });
          assert.equal(options.session, session);
          return { deletedCount: deleted };
        },
      };
      if (name === 'users') return {
        async updateOne(filter, update, options) {
          calls.push('touchAccount');
          assert.deepEqual(filter, { googleSub: 'owner-a' });
          assert.ok(update.$set.updatedAt instanceof Date);
          assert.equal(options.session, session);
          return { matchedCount: accountMatched };
        },
      };
      if (name === 'notes') return {
        async deleteMany(filter, options) {
          calls.push('deleteNotes');
          assert.deepEqual(filter, { ownerId: 'owner-a', subjectSlug: 'subject-a' });
          assert.equal(options.session, session);
          if (failNoteDelete) throw new Error('simulated note deletion failure');
          return { deletedCount: 3 };
        },
      };
      throw new Error('Unexpected collection: ' + name);
    },
  };
  return { db, calls };
}

test('deletes notes and their subject in one transaction after account check', async () => {
  const { db, calls } = fakeDb();
  assert.deepEqual(await deleteSubjectAtomically(db, 'owner-a', 'subject-a'), { status: 'deleted' });
  assert.deepEqual(calls, ['start', 'begin', 'findSubject', 'countSubjects', 'touchAccount', 'deleteNotes', 'deleteSubject', 'commit', 'end']);
});

test('missing or only remaining subject causes no deletion', async () => {
  for (const [options, expected] of [[{ subject: null }, 'not-found'], [{ count: 1 }, 'last-subject']]) {
    const { db, calls } = fakeDb(options);
    assert.deepEqual(await deleteSubjectAtomically(db, 'owner-a', 'subject-a'), { status: expected });
    assert.ok(!calls.includes('deleteNotes'));
    assert.ok(!calls.includes('deleteSubject'));
    assert.ok(calls.includes('end'));
  }
});

test('account removal, DB failure and conflicting subject delete propagate failure', async () => {
  for (const options of [{ accountMatched: 0 }, { failNoteDelete: true }, { deleted: 0 }]) {
    const { db, calls } = fakeDb(options);
    await assert.rejects(deleteSubjectAtomically(db, 'owner-a', 'subject-a'));
    assert.ok(!calls.includes('commit'));
    assert.ok(calls.includes('end'));
  }
});

test('subject deletion endpoint delegates to transactional helper after rate limit', async () => {
  const source = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(source, /await deleteSubjectAtomically\(db, ownerId, slug\)/);
  assert.ok(source.indexOf("checkOwnerMutationLimit(db, ownerId, 'subjects')", source.indexOf('export async function DELETE')) <
    source.indexOf('await deleteSubjectAtomically(db, ownerId, slug)'));
  assert.doesNotMatch(source, /db\.collection\('notes'\)\.deleteMany/);
});
