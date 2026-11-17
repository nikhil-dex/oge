import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVaultRecoverySnapshots,
  previewVaultRecoveryFiles,
} from '../lib/oge-vault-restore-preview.js';

const row = (id, sha) => ({ id, sha });
const snapshot = (notes = [], quickNotes = [], airNotes = []) => ({
  notes, quickNotes, airNotes,
});

test('M90 classifies additions, SHA conflicts, unchanged and current-only without returning IDs', () => {
  const a = snapshot([
    row('a', '111'), row('b', '222'), row('c', '333'),
  ], [row('q', '111')]);
  const b = snapshot([
    row('b', '222'), row('c', '444'), row('d', '555'),
  ], [row('q', '111')], [row('air', '777')]);
  const plan = compareVaultRecoverySnapshots(a, b);
  assert.deepEqual(
    [plan.totalAdd, plan.totalConflict, plan.totalUnchanged, plan.totalPreserve],
    [1, 1, 2, 2],
  );
  assert.equal(plan.canRestore, false);
  assert.equal(plan.canAuthorizeImport, false);
  assert.equal(plan.canReleaseImportLock, false);
  assert.equal(plan.canRetryUnknownWrite, false);
  assert.equal(plan.networkRequestsPerformed, false);
  assert.equal(JSON.stringify(plan).includes('"id"'), false);
  assert.equal(JSON.stringify(plan).includes('555'), false);
});

test('M90 rejects missing or duplicate resource IDs and malformed inputs', () => {
  assert.throws(() => compareVaultRecoverySnapshots(null, snapshot()));
  assert.throws(() => compareVaultRecoverySnapshots(
    snapshot([row('a', '1'), row('a', '2')]), snapshot()));
  assert.throws(() => compareVaultRecoverySnapshots(
    snapshot(), snapshot([row('a', '1'), row('a', '2')])));
  assert.throws(() => compareVaultRecoverySnapshots({ notes: [] }, snapshot()));
});

test('M90 rejects any selection other than two files before reading', async () => {
  await assert.rejects(previewVaultRecoveryFiles([]));
  await assert.rejects(previewVaultRecoveryFiles([{}, {}, {}]));
});
