import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStagingConfiguration } from '../lib/staging-preflight.js';

function valid() {
  return {
    OGE_STAGING_URL: 'https://staging.oge.example',
    AUTH_URL: 'https://staging.oge.example',
    MONGODB_URI: 'mongodb+srv://staging-user:secret@staging-cluster.mongodb.net/?retryWrites=true',
    MONGODB_DB: 'oge_notes_staging',
    AUTH_GOOGLE_ID: '111222333-staging.apps.googleusercontent.com',
    AUTH_GOOGLE_SECRET: 'dedicated-staging-google-oauth-secret',
    AUTH_SECRET: 'a-high-entropy-staging-auth-secret-32-characters',
    OGE_HEALTHCHECK_TOKEN: 'dedicated-unique-staging-health-token-characters',
    OGE_ACCOUNT_DELETION_ENABLED: 'false',
    OGE_ENFORCE_CSP: 'false',
    NODE_ENV: 'production',
  };
}
function issues(config) { return checkStagingConfiguration(config).failures.map((issue) => issue.code); }

test('preflight accepts isolated HTTPS preview configuration while requiring human review', () => {
  const result = checkStagingConfiguration(valid());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.ok(result.warnings.some((w) => w.code === 'manual-isolation'));
  assert.ok(result.warnings.some((w) => w.code === 'private-access'));
});

test('preflight blocks the production/default database and local or standalone MongoDB', () => {
  assert.ok(issues({ ...valid(), MONGODB_DB: 'oge_notes' }).includes('staging-database-name'));
  assert.ok(issues({ ...valid(), MONGODB_DB: 'oge_notes' }).includes('default-database'));
  assert.ok(issues({ ...valid(), MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0' }).includes('staging-mongodb-uri'));
  assert.ok(issues({ ...valid(), MONGODB_URI: 'mongodb://prod.example:27017' }).includes('staging-mongodb-uri'));
});

test('preflight requires an exact staging OAuth origin and disallows public hostnames', () => {
  assert.ok(issues({ ...valid(), AUTH_URL: 'https://oge.example' }).includes('auth-origin-mismatch'));
  assert.ok(issues({ ...valid(), OGE_STAGING_URL: 'https://oge.example' }).includes('staging-url'));
  assert.ok(issues({ ...valid(), OGE_STAGING_URL: 'http://staging.oge.example' }).includes('staging-url'));
  assert.ok(issues({ ...valid(), OGE_STAGING_URL: 'https://staging.oge.example/preview' }).includes('staging-url'));
  assert.ok(issues({ ...valid(), OGE_STAGING_URL: 'https://staging.oge.example/?key=secret' }).includes('staging-url'));
});

test('preflight catches missing secrets and deliberately blocks risky flags', () => {
  assert.ok(issues({ ...valid(), AUTH_SECRET: 'short' }).includes('short-auth-secret'));
  assert.ok(issues({ ...valid(), AUTH_GOOGLE_ID: 'not-a-google-client' }).includes('google-client-id'));
  assert.ok(issues({ ...valid(), AUTH_GOOGLE_SECRET: 'placeholder' }).includes('missing-auth-google-secret'));
  assert.ok(issues({ ...valid(), OGE_HEALTHCHECK_TOKEN: '' }).includes('health-token'));
  assert.ok(issues({ ...valid(), OGE_ACCOUNT_DELETION_ENABLED: 'true' }).includes('account-deletion'));
  assert.ok(issues({ ...valid(), OGE_ENFORCE_CSP: 'true' }).includes('csp-enforcement'));
  assert.ok(issues({ ...valid(), NEXT_PUBLIC_AUTH_SECRET: 'insecure' }).includes('public-secrets'));
});

test('configuration report never serializes credential values', () => {
  const config = valid();
  config.AUTH_SECRET = 'very-private-secret-never-output-123456';
  config.MONGODB_URI = 'mongodb://supersecret:private@localhost:27017';
  const report = JSON.stringify(checkStagingConfiguration(config));
  assert.equal(report.includes('very-private-secret-never-output'), false);
  assert.equal(report.includes('supersecret:private'), false);
});
