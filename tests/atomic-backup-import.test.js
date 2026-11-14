import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAtomicBackupImport } from '../lib/atomic-backup-import.js';

test('backup transaction returns result after committing and closes session', async () => {
  const calls = [];
  const db = { client: { startSession() {
    calls.push('open');
    return {
      async withTransaction(fn, options) {
        calls.push('begin');
        assert.equal(options.readConcern.level, 'snapshot');
        assert.equal(options.writeConcern.w, 'majority');
        const result = await fn({ marker: 'session' });
        calls.push('commit');
        return result;
      },
      async endSession() { calls.push('close'); },
    };
  } } };
  const result = await withAtomicBackupImport(db, async (session) => {
    calls.push('write');
    assert.equal(session.marker, 'session');
    return { added: 3 };
  });
  assert.deepEqual(result, { added: 3 });
  assert.deepEqual(calls, ['open', 'begin', 'write', 'commit', 'close']);
});

test('backup transaction propagates failure instead of returning a partial success', async () => {
  const calls = [];
  const db = { client: { startSession() {
    return {
      async withTransaction(fn) {
        try {
          await fn({ marker: 'session' });
        } catch (error) {
          calls.push('abort');
          throw error;
        }
      },
      async endSession() { calls.push('close'); },
    };
  } } };
  await assert.rejects(withAtomicBackupImport(db, async () => {
    calls.push('insert note');
    throw new Error('simulated database failure');
  }), /simulated database failure/);
  assert.deepEqual(calls, ['insert note', 'abort', 'close']);
});

test('backup restore passes session to all collection reads/writes and checks account row', async () => {
  const source = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  const restore = source.slice(source.indexOf('return await withAtomicBackupImport'));
  assert.match(restore, /withAtomicBackupImport\(db, async \(session\) =>/);
  assert.match(restore, /find\(\{ ownerId \}, \{ session \}\)/);
  assert.match(restore, /insertOne\(created, \{ session \}\)/);
  assert.match(restore, /noteCollection\.insertOne\([\s\S]*?\}, \{ session \}\)/);
  assert.match(restore, /linkCollection\.insertOne\([\s\S]*?\}, \{ session \}\)/);
  assert.match(restore, /quickCollection\.insertOne\([\s\S]*?\}, \{ session \}\)/);
  assert.match(restore, /personalCollection\.insertOne\([\s\S]*?\}, \{ session \}\)/);
  assert.match(restore, /userUpdate\.matchedCount !== 1/);
  assert.match(restore, /Account no longer exists/);
});
