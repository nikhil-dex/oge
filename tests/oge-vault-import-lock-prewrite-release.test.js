import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

test('D3b2b2c3 runtime blocks Atlas and production-looking targets without network calls', () => {
  const script = new URL('../scripts/release-vault-import-lock-staging.mjs', import.meta.url);
  const env = {
    ...process.env,
    MONGODB_URI: 'mongodb+srv://secretoperator:neverprint@remote-cluster.example/?retryWrites=true',
    MONGODB_DB: 'oge_vault_recovery_staging_safe',
    OGE_VAULT_PREWRITE_RELEASE_STAGING_ONLY: 'YES_DISPOSABLE_PREWRITE_ONLY',
    OGE_VAULT_MAINTENANCE_QUIESCED: 'YES_ALL_WRITERS_STOPPED',
    OGE_VAULT_INDEPENDENT_REVIEW: 'YES_SEPARATE_APPROVER',
    OGE_VAULT_PREWRITE_RELEASE_CONFIRMATION: 'RELEASE_ONLY_PRE_GITHUB_WRITE_LOCK',
    OGE_VAULT_INSPECT_OWNER_ID: owner.ownerId,
    OGE_VAULT_INSPECT_SESSION_VERSION: owner.sessionVersion,
    OGE_VAULT_INSPECT_REPO_ID: String(owner.repoId),
    OGE_VAULT_INSPECT_OPERATION_ID: owner.expectedOperationId,
    OGE_VAULT_RELEASE_STARTED_AT: startedAt,
    OGE_VAULT_RELEASE_INCIDENT_ID: randomUUID(),
  };
  for (const [uri, name] of [
    [env.MONGODB_URI, env.MONGODB_DB],
    ['mongodb://remote.example:27017/', env.MONGODB_DB],
    ['mongodb://127.0.0.1:27017/', 'oge_notes'],
    ['mongodb://localhost:27018/', env.MONGODB_DB],
  ]) {
    const call = spawnSync(process.execPath, [script.pathname], {
      env: { ...env, MONGODB_URI: uri, MONGODB_DB: name },
      encoding: 'utf8', timeout: 8000,
    });
    assert.equal(call.status, 1);
    assert.match(call.stderr, /BLOCKED:/);
    assert.equal(call.stdout, '');
    for (const value of ['secretoperator', owner.ownerId, owner.sessionVersion,
      owner.expectedOperationId]) assert.equal(call.stderr.includes(value), false);
  }
});

test('D3b2b2c3 account deletion retains protected import recovery audit history', async () => {
  const source = await readFile(new URL(
    '../lib/account-deletion-transaction.js', import.meta.url), 'utf8');
  assert.match(source, /vault_import_lock_recovery_audit/);
  assert.match(source, /importLockRecoveryCount/);
});
