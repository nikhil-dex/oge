import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';

const syntheticKey = Buffer.from(generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const baseline = () => ({
  OGE_STAGING_URL: 'https://staging.oge.example',
  AUTH_URL: 'https://staging.oge.example',
  MONGODB_URI: 'mongodb+srv://synthetic-staging-user:synthetic-pass@cluster.staging.mongodb.net/?retryWrites=true',
  MONGODB_DB: 'oge_notes_staging',
  AUTH_GOOGLE_ID: '111222333-staging.apps.googleusercontent.com',
  AUTH_GOOGLE_SECRET: 'private-staging-google-secret-12345',
  AUTH_SECRET: 'private-staging-auth-secret-32-characters',
  OGE_HEALTHCHECK_TOKEN: 'isolated-staging-monitor-token-characters',
  AUTH_GITHUB_ID: 'staging-github-login-client-id',
  AUTH_GITHUB_SECRET: 'private-staging-github-login-secret-123',
  OGE_VAULT_GITHUB_CLIENT_ID: 'staging-dedicated-vault-client-id',
  OGE_VAULT_GITHUB_CLIENT_SECRET: 'private-staging-dedicated-vault-secret',
  OGE_VAULT_GITHUB_APP_ID: '123456',
  OGE_VAULT_GITHUB_APP_SLUG: 'oge-staging-vault',
  OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: syntheticKey,
  OGE_VAULT_DRAFT_KEY: 'a'.repeat(64),
  OGE_VAULT_BASE_URL: 'https://staging.oge.example/',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
  OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
  OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
  OGE_ACCOUNT_DELETION_ENABLED: 'false',
  OGE_ENFORCE_CSP: 'false',
  NODE_ENV: 'production',
});
const issues = (env) => checkVaultStagingReadiness(env).failures.map((i) => i.code);

test('B7 preflight accepts self-contained staging prerequisites but never claims live verification', () => {
  const report = checkVaultStagingReadiness(baseline());
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.evidence, 'configuration-only');
  assert.equal(report.liveProviderVerified, false);
  assert.equal(report.authenticatedBrowserVerified, false);
  assert.ok(report.warnings.some((w) => w.code === 'vault-authenticated-checks-pending'));
});

test('B7 preflight rejects production OAuth origin, disabled staging flags and destructive toggles', () => {
  for (const flag of ['OGE_VAULT_MAIN_PREVIEW', 'OGE_VAULT_HYBRID_DRAFT_PREVIEW']) {
    assert.ok(issues({ ...baseline(), [flag]: 'false' }).includes('vault-preview-gates'));
  }
  assert.ok(issues({ ...baseline(), OGE_VAULT_BASE_URL: 'https://oge.example/' })
    .includes('vault-callback-origin'));
  assert.ok(issues({ ...baseline(), OGE_STAGING_URL: 'https://oge.example/' })
    .includes('staging-url'));
  for (const flag of ['OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
    'OGE_VAULT_SUBJECT_RETIRE_INTERNAL', 'OGE_ACCOUNT_DELETION_ENABLED']) {
    assert.ok(issues({ ...baseline(), [flag]: 'true' }).includes('vault-destructive-flag'));
  }
});

test('B7 preflight refuses missing OAuth, malformed GitHub App ID and invalid signing keys', () => {
  for (const name of ['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET',
    'OGE_VAULT_GITHUB_CLIENT_ID', 'OGE_VAULT_GITHUB_CLIENT_SECRET']) {
    assert.ok(issues({ ...baseline(), [name]: '' }).includes(
      'vault-missing-' + name.toLowerCase().replaceAll('_', '-')));
  }
  assert.ok(issues({ ...baseline(), OGE_VAULT_GITHUB_APP_ID: 'abc' })
    .includes('vault-github-app-id'));
  assert.ok(issues({ ...baseline(), OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: 'bad' })
    .includes('vault-signing-key'));
  assert.ok(issues({ ...baseline(), OGE_VAULT_DRAFT_KEY: 'too-short' })
    .includes('vault-draft-key'));
});

test('B7 preflight detects browser-visible secrets and never emits private values', () => {
  const secret = 'unique-sensitive-vault-oauth-client-secret-never-output';
  const env = { ...baseline(),
    OGE_VAULT_GITHUB_CLIENT_SECRET: secret,
    OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: 'bad-secret-private-key-material',
    NEXT_PUBLIC_OGE_VAULT_DRAFT_KEY: 'accidentally-exposed',
  };
  const report = checkVaultStagingReadiness(env);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((x) => x.code === 'vault-public-secret'));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('bad-secret-private-key-material'), false);
  assert.equal(serialized.includes('accidentally-exposed'), false);
  assert.equal(serialized.includes(env.AUTH_SECRET), false);
});

test('B7 staging preflight cannot provision vaults, read notes or mutate user databases', async () => {
  const checker = await readFile(new URL('../lib/oge-vault-staging-preflight.js', import.meta.url), 'utf8');
  const script = await readFile(new URL('../scripts/check-vault-staging-preflight.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(checker, /\bfetch\(|getDatabase\(|createFile\(|insertOne\(|updateOne\(|deleteOne\(/);
  assert.doesNotMatch(script, /\bfetch\(|getDatabase\(|createFile\(|insertOne\(|updateOne\(|deleteOne\(/);
  assert.match(script, /checkVaultStagingReadiness\(process\.env\)/);
});
