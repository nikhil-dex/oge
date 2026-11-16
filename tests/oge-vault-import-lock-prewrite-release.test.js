import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { releasePreWriteVaultImportLockInStaging } from '../lib/oge-vault-import-lock-prewrite-release.js';

const owner = {
  ownerId: 'synthetic-owner-' + randomUUID(),
  repoId: 605, sessionVersion: randomUUID(), expectedOperationId: randomUUID(),
};
const startedAt = '2026-11-16T09:00:00.000Z';
const approval = {
  startedAt, incidentId: randomUUID(),
  maintenanceConfirmed: true, independentReviewConfirmed: true,
  now: new Date('2026-11-16T10:00:00.000Z'),
};
const db = { collection() { throw new Error('No database access authorized'); } };

test('D3b2b2c3 rejects any prewrite release without the two explicit maintenance approvals', async () => {
  for (const change of [
    { maintenanceConfirmed: false }, { independentReviewConfirmed: false },
    { incidentId: 'not-a-uuid' }, { startedAt: 'yesterday' },
    { startedAt: '2026-11-17T09:00:00.000Z' },
    { startedAt: '2026-11-16' },
  ]) {
    await assert.rejects(releasePreWriteVaultImportLockInStaging(db, owner,
      { ...approval, ...change }), TypeError);
  }
});

test('D3b2b2c3 rejects broad, missing or cross-account release scopes before database access', async () => {
  for (const changed of [
    { ...owner, ownerId: '' },
    { ...owner, repoId: 0 },
    { ...owner, expectedOperationId: randomUUID().slice(0, 32) },
    { ...owner, sessionVersion: undefined },
  ]) {
    await assert.rejects(releasePreWriteVaultImportLockInStaging(db, changed,
      approval), TypeError);
  }
});

test('D3b2b2c3 release CLI cannot point at Atlas, production or remote MongoDB', async () => {
  const cli = await readFile(new URL(
    '../scripts/release-vault-import-lock-staging.mjs', import.meta.url), 'utf8');
  const engine = await readFile(new URL(
    '../lib/oge-vault-import-lock-prewrite-release.js', import.meta.url), 'utf8');
  assert.match(cli, /OGE_VAULT_PREWRITE_RELEASE_STAGING_ONLY === 'YES_DISPOSABLE_PREWRITE_ONLY'/);
  assert.match(cli, /OGE_VAULT_MAINTENANCE_QUIESCED === 'YES_ALL_WRITERS_STOPPED'/);
  assert.match(cli, /OGE_VAULT_INDEPENDENT_REVIEW === 'YES_SEPARATE_APPROVER'/);
  assert.match(cli, /OGE_VAULT_PREWRITE_RELEASE_CONFIRMATION === 'RELEASE_ONLY_PRE_GITHUB_WRITE_LOCK'/);
  assert.match(cli, /localhost\|127/);
  assert.match(cli, /oge_vault_recovery_staging_/);
  assert.match(cli, /hello\.setName/);
  assert.doesNotMatch(cli, /getDatabase\(/);
  assert.doesNotMatch(cli, /getVaultNoteClient|vaultGithubRequest|fetch\(/);
  assert.match(engine, /'vaultImportLock\.state': 'acquired'/);
  assert.match(engine, /'vaultImportLock\.startedAt': new Date\(startedAt\)/);
  assert.match(engine, /withAtomicBackupImport\(db/);
  assert.match(engine, /vault_import_lock_recovery_audit/);
  assert.doesNotMatch(engine, /\.deleteOne\(|\.deleteMany\(|commitVaultNoteBatch|collection\(['"]notes['"]\)/);
});
