import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildVaultRecoveryCenterModel,
  vaultRecoveryCenterStagingAllowed,
} from '../lib/oge-vault-recovery-center.js';
import {
  VAULT_RESOURCE_BACKUP_COVERAGE,
} from '../lib/oge-vault-backup-current-resources.js';

const STAGING = 'https://vault-staging.example.test';
const ready = () => ({ ok: true });
const blocked = () => ({ ok: false });
const setup = Object.freeze({
  OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'true',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_NOTE_API_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
  OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW: 'true',
  OGE_VAULT_BACKUP_EXPORT_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
  OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'false',
  OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
  OGE_ACCOUNT_DELETION_ENABLED: 'false',
  OGE_VAULT_ACCOUNT_DELETION_INTERNAL: 'false',
  OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
  OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
  OGE_STAGING_URL: STAGING,
  AUTH_URL: STAGING,
  OGE_VAULT_BASE_URL: STAGING,
  MONGODB_DB: 'oge_vault_restore_staging_m87',
});

test('M87 default-OFF and incomplete staging gates reject before any account or GitHub lookups', () => {
  assert.equal(vaultRecoveryCenterStagingAllowed({}, ready), false);
  assert.equal(vaultRecoveryCenterStagingAllowed(setup, blocked), false);
  assert.throws(() => buildVaultRecoveryCenterModel({}, { readiness: ready }),
    TypeError);
  for (const change of [
    { OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'false' },
    { OGE_VAULT_MAIN_PREVIEW: 'false' },
    { OGE_VAULT_NOTE_API_PREVIEW: 'false' },
    { OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'false' },
    { MONGODB_DB: 'oge_prod' },
    { OGE_STAGING_URL: 'https://production.example.com' },
    { OGE_STAGING_URL: 'http://vault-staging.example.test' },
    { OGE_STAGING_URL: 'https://vault-staging.example.test:444' },
    { AUTH_URL: 'https://other-staging.example.test' },
    { OGE_VAULT_BASE_URL: 'https://other-staging.example.test' },
    { OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
    { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
    { OGE_VAULT_ACCOUNT_DELETION_INTERNAL: 'true' },
    { OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'true' },
    { OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'true' },
  ]) {
    const env = { ...setup, ...change };
    assert.equal(vaultRecoveryCenterStagingAllowed(env, ready), false,
      'Must reject ' + JSON.stringify(change));
    assert.throws(() =>
      buildVaultRecoveryCenterModel(env, { readiness: ready }), TypeError);
  }
});

test('M87 exact backend coverage: only current committed Notes/Quick Notes/AirNotes can request backup', () => {
  const model = buildVaultRecoveryCenterModel(setup, { readiness: ready });
  assert.equal(model.format, 'oge-vault-owner-recovery-center-readiness');
  assert.equal(model.environment, 'disposable-staging');
  assert.equal(model.status,
    'STAGING_INFORMATION_ONLY_NO_RECOVERY_AUTHORIZATION');
  assert.equal(model.backupRequestEnabled, true);
  assert.deepEqual(model.resources.map(r => r.key),
    ['notes', 'quickNotes', 'airNotes']);
  for (const item of model.resources) {
    assert.equal(item.coverage, 'Current committed GitHub snapshot');
    assert.equal(item.requestEnabled, true);
    assert.equal(item.contentVerifiedAtRender, false);
    assert.equal(VAULT_RESOURCE_BACKUP_COVERAGE[item.key],
      'complete-current-github-head');
  }
  assert.deepEqual(model.exclusions.map(item => item.key),
    ['historicalRevisions', 'encryptedDrafts', 'legacyMongoNotes',
      'learningProgress']);
  for (const item of model.exclusions) {
    assert.equal(item.included, false);
    assert.equal(VAULT_RESOURCE_BACKUP_COVERAGE[item.key],
      'not-included');
  }
  for (const field of [
    'sourceArchiveIdentityIndependentlyAuthenticated',
    'entireAccountBackupAvailable', 'encryptedDraftsIncluded',
    'historicalVersionsIncluded',
    'authenticatedSourceRestorationAvailableHere',
    'productionRestoreEnabled',
    'realOAuthTwoPhysicalDeviceAcceptanceComplete',
    'realGitHubProviderFailureAcceptanceComplete',
    'uncertainGitHubWriteQuiescenceProven',
    'operatorUnlockAuthorized', 'safeToRetryAutomatically',
    'quarantineReleasePerformed', 'privateNoteContentReadWhileRendering',
    'githubWritesPerformed', 'mongodbWritesPerformed',
    'secretsOrUserIdentifiersReturned',
  ]) assert.equal(model[field], false, field);
  const text = JSON.stringify(model);
  assert.equal(text.includes(STAGING), false);
  assert.equal(text.includes('MONGODB'), false);
  assert.equal(Object.isFrozen(model), true);
});

test('M87 backup link gate is INDEPENDENT of the Recovery Center page gate', () => {
  for (const change of [
    { OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW: 'false' },
    { OGE_VAULT_BACKUP_EXPORT_PREVIEW: 'false' },
    { OGE_VAULT_STANDALONE_PREVIEW: 'false' },
  ]) {
    const model = buildVaultRecoveryCenterModel(
      { ...setup, ...change }, { readiness: ready });
    assert.equal(model.backupRequestEnabled, false);
    assert.equal(model.resources.every(r => r.requestEnabled === false), true);
    assert.equal(model.authenticatedSourceRestorationAvailableHere, false);
  }
});

test('M87 owner-facing route enforces auth/session + scoped private repository, no mutation and no indexing', async () => {
  const [page, home, style] = await Promise.all([
    readFile(new URL('../app/vault/recovery/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/page.js', import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/recovery-center.module.css',
      import.meta.url), 'utf8'),
  ]);
  assert.match(page, /vaultRecoveryCenterStagingAllowed\(process\.env\)/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /await auth\(\)/);
  assert.match(page, /redirect\('\/register'\)/);
  assert.match(page, /ownerMutationFilter\(session\.user\.id/);
  assert.match(page, /sessionVersion: session\.user\.sessionVersion/);
  assert.match(page, /'vault\.status': 'connected'/);
  assert.match(page, /'vault\.repoName': 'ogenotes-vault'/);
  assert.match(page, /projection: \{ _id: 1 \}/);
  assert.match(page, /index: false, follow: false/);
  assert.match(page, /robots:/);
  assert.match(page, /Cache-Control|dynamic = 'force-dynamic'/);
  assert.match(page, /model\.backupRequestEnabled \?/);
  assert.match(page, /href="\/api\/vault\/backup-current-resources"/);
  assert.match(page, /model\.resources\.map/);
  assert.match(page, /model\.exclusions\.map/);
  assert.match(home, /recoveryCenterVisible && <Link/);
  assert.match(home, /href="\/vault\/recovery"/);
  assert.match(style, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(page + home,
    /releasePreWriteVaultImportLock|markGitHubWriteAttempt|method:\s*'PATCH'|method:\s*'POST'|deleteOne\(|updateOne\(|insertOne\(/);
  assert.doesNotMatch(page, /<form|<input|<textarea|<button/);
});
