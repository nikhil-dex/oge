import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readConfirmedVaultSaveReceipt } from '../lib/oge-vault-save-receipt.js';

const scope = { ownerId: 'receipt-unit-owner', repoId: 931, noteId: randomUUID() };
const sha = 'a'.repeat(40), commitSha = 'b'.repeat(40);
const client = { vault: { repoId: scope.repoId }, branch: 'main' };

function fixture({ receipt = { ...scope, revision: 3, sha, commitSha },
  draft = null, remoteSha = sha, addDraftDuringRead = false } = {}) {
  const calls = { draftReads: 0, githubReads: 0, receiptReads: 0 };
  const db = { collection(name) {
    if (name === 'vault_drafts') return { async findOne(filter) {
      assert.deepEqual(filter, scope);
      calls.draftReads++;
      return addDraftDuringRead && calls.draftReads > 1 ? { revision: 4 } : draft;
    } };
    if (name === 'vault_save_receipts') return { async findOne(filter) {
      assert.deepEqual(filter, { ...scope, revision: 3 });
      calls.receiptReads++;
      return receipt;
    } };
    throw Error('Unexpected collection ' + name);
  } };
  const noteReader = async (_, noteId) => {
    assert.equal(noteId, scope.noteId);
    calls.githubReads++;
    return { id: noteId, sha: remoteSha, heading: 'Never copied to MongoDB' };
  };
  return { db, noteReader, calls };
}
const verify = (f) => readConfirmedVaultSaveReceipt(f.db, client, scope, 3,
  { noteReader: f.noteReader });

test('B7 metadata receipt is only accepted after a fresh GitHub SHA match', async () => {
  const f = fixture();
  const result = await verify(f);
  assert.deepEqual({ confirmed: result.confirmed, cleared: result.cleared,
    alreadyCleared: result.alreadyCleared, sha: result.sha, revision: result.revision },
  { confirmed: true, cleared: true, alreadyCleared: true, sha, revision: 3 });
  assert.equal(f.calls.githubReads, 1);
  assert.equal(f.calls.draftReads, 2);
});

test('B7 receipt never overrides an encrypted draft from another device', async () => {
  for (const configuration of [
    { draft: { revision: 4 } }, { addDraftDuringRead: true },
  ]) {
    const f = fixture(configuration);
    const checked = await verify(f);
    assert.equal(checked.confirmed, false);
    assert.equal(checked.reason, 'newer-draft-present');
  }
});

test('B7 missing, corrupted or obsolete receipts fail closed', async () => {
  for (const configuration of [
    { receipt: null }, { receipt: { ...scope, revision: 3, sha: 'bad', commitSha } },
    { remoteSha: 'f'.repeat(40) },
  ]) {
    const f = fixture(configuration);
    assert.equal((await verify(f)).confirmed, false);
  }
  const f = fixture();
  await assert.rejects(readConfirmedVaultSaveReceipt(f.db,
    { vault: { repoId: 999 } }, scope, 3), /vault-save-receipt-repository-mismatch/);
});

test('B7 idempotent receipt never writes GitHub or stores committed note bodies', async () => {
  const code = await readFile(new URL('../lib/oge-vault-save-receipt.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  assert.match(code, /withAtomicBackupImport/);
  assert.match(code, /deleteOne\(/);
  assert.match(code, /revision, sha: sha\.toLowerCase\(\)/);
  assert.doesNotMatch(code, /heading: note|answer: note|content: note|tags: note/);
  assert.doesNotMatch(code, /method: 'PATCH'|method: 'POST'|commitVaultNoteBatch/);
  assert.match(api, /readConfirmedVaultSaveReceipt/);
});
