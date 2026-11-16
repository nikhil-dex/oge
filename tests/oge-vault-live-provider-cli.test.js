import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const cli = new URL('../scripts/probe-vault-live-provider-readonly.mjs',
  import.meta.url).pathname;
const key = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
function config() {
  return {
    ...process.env,
    NODE_ENV: 'production',
    OGE_STAGING_URL: 'https://staging.oge.example',
    AUTH_URL: 'https://staging.oge.example',
    OGE_VAULT_BASE_URL: 'https://staging.oge.example/',
    MONGODB_URI: 'mongodb+srv://synthetic:synthetic@staging.mongo.example.net/?retryWrites=true',
    MONGODB_DB: 'oge_vault_restore_staging_ci',
    AUTH_GOOGLE_ID: '111222333.apps.googleusercontent.com',
    AUTH_GOOGLE_SECRET: 'synthetic-private-google-staging-secret',
    AUTH_SECRET: 'synthetic-private-auth-secret-minimum-32-bytes',
    AUTH_GITHUB_ID: 'synthetic-staging-github-client',
    AUTH_GITHUB_SECRET: 'synthetic-staging-github-secret-32-bytes',
    OGE_HEALTHCHECK_TOKEN: 'synthetic-staging-healthcheck-token',
    OGE_VAULT_GITHUB_CLIENT_ID: 'synthetic-vault-client-id',
    OGE_VAULT_GITHUB_CLIENT_SECRET: 'synthetic-vault-secret-client',
    OGE_VAULT_GITHUB_APP_ID: '723',
    OGE_VAULT_GITHUB_APP_SLUG: 'oge-staging',
    OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: key,
    OGE_VAULT_DRAFT_KEY: 'a'.repeat(64),
    OGE_VAULT_MAIN_PREVIEW: 'true',
    OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
    OGE_VAULT_NOTE_API_PREVIEW: 'true',
    OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW: 'true',
    OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY: '',
    OGE_ACCOUNT_DELETION_ENABLED: 'false',
    OGE_ENFORCE_CSP: 'false',
    OGE_VAULT_INSPECT_OWNER_ID: 'synthetic-' + randomUUID(),
    OGE_VAULT_INSPECT_SESSION_VERSION: randomUUID(),
    OGE_VAULT_INSPECT_REPO_ID: '357',
    OGE_VAULT_INSPECT_INSTALLATION_ID: '42',
  };
}
function blocked(env) {
  const result = spawnSync(process.execPath, [cli], {
    env, encoding: 'utf8', timeout: 7000,
  });
  assert.equal(result.status, 1, 'must block before contacting provider');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BLOCKED:/);
  for (const privateValue of [env.MONGODB_URI,
    env.OGE_VAULT_INSPECT_OWNER_ID, env.OGE_VAULT_GITHUB_CLIENT_SECRET])
    assert.equal(result.stderr.includes(privateValue), false);
}

test('M61 live provider probe disabled by default; no MongoDB or GitHub calls', () => {
  const env = config();
  blocked(env);
  blocked({ ...env, OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY: 'yes' });
  blocked({ ...env, OGE_VAULT_REAL_PROVIDER_PROBE_WRITE_ACK: 'YES' });
});

test('M61 read-only probe rejects production DB and origin, invalid session and installation before network', () => {
  const env = { ...config(),
    OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY:
      'YES_ISOLATED_PRIVATE_STAGING_GETS_ONLY' };
  blocked({ ...env, MONGODB_DB: 'oge_notes' });
  blocked({ ...env, OGE_STAGING_URL: 'https://oge.example' });
  blocked({ ...env, OGE_VAULT_INSPECT_REPO_ID: 'not-a-repository' });
  blocked({ ...env, OGE_VAULT_INSPECT_INSTALLATION_ID: '0' });
  blocked({ ...env, OGE_VAULT_INSPECT_SESSION_VERSION: 'invalid' });
  blocked({ ...env, OGE_VAULT_MAIN_PREVIEW: 'false' });
  blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW: 'false' });
});

test('M61 probe only reads Git refs and tree IDs; never touches source notes or stores content', async () => {
  const source = await readFile(cli, 'utf8');
  assert.match(source, /getVaultNoteClient\(db, identity, \{ readOnly: true \}\)/);
  assert.match(source, /pinnedVault = first\.vault/);
  assert.match(source, /v\.githubAccountId === pinnedVault\.githubAccountId/);
  assert.match(source, /inspectVaultProviderReadOnlyPair/);
  assert.match(source, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.doesNotMatch(source,
    /executeApprovedVaultChunkRestoreBatch|commitVaultNoteBatch|\.insertOne\(|\.updateOne\(|\.deleteOne\(/);
});
