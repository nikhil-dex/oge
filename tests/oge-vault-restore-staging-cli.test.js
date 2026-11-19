import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';

const script = new URL('../scripts/commit-vault-chunk-restore-staging.mjs',
  import.meta.url).pathname;
const generatedKey = Buffer.from(generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey.export({
  type: 'pkcs8', format: 'pem',
})).toString('base64');

const staging = (folder, ticketFile) => ({
  ...process.env,
  OGE_STAGING_URL: 'https://staging.oge.example',
  AUTH_URL: 'https://staging.oge.example',
  OGE_VAULT_BASE_URL: 'https://staging.oge.example/',
  MONGODB_URI: 'mongodb+srv://synthetic-user:synthetic-pass@staging.mongodb.example.net/?retryWrites=true',
  MONGODB_DB: 'oge_vault_restore_staging_ci',
  AUTH_GOOGLE_ID: '111222333-staging.apps.googleusercontent.com',
  AUTH_GOOGLE_SECRET: 'safe-synthetic-google-oauth-secret-12345',
  AUTH_SECRET: 'staging-local-test-secret-with-32-characters',
  AUTH_GITHUB_ID: 'synthetic-staging-login-client-id',
  AUTH_GITHUB_SECRET: 'synthetic-staging-login-client-secret',
  OGE_HEALTHCHECK_TOKEN: 'staging-local-synthetic-private-monitor-token',
  OGE_VAULT_GITHUB_CLIENT_ID: 'synthetic-staging-app-client-id',
  OGE_VAULT_GITHUB_CLIENT_SECRET: 'synthetic-staging-app-client-secret',
  OGE_VAULT_GITHUB_APP_ID: '18293',
  OGE_VAULT_GITHUB_APP_SLUG: 'oge-staging-test',
  OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: generatedKey,
  OGE_VAULT_DRAFT_KEY: 'a'.repeat(64),
  OGE_VAULT_CHUNK_RESTORE_APPROVAL_KEY: '6c'.repeat(32),
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
  OGE_VAULT_NOTE_API_PREVIEW: 'true',
  OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW: 'true',
  OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true',
  OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW: 'true',
  OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW: 'true',
  OGE_VAULT_CHUNK_RESTORE_WRITE_ACK: 'YES_DISPOSABLE_SIGNED_STAGING_ONLY',
  OGE_VAULT_CHUNK_RESTORE_STAGING_OPERATOR: 'YES_ONE_SIGNED_BATCH_ONLY',
  OGE_VAULT_CHUNK_RESTORE_STAGING_ACK: 'YES_SEPARATE_SYNTHETIC_STAGING_DATABASE',
  OGE_ACCOUNT_DELETION_ENABLED: 'false',
  OGE_ENFORCE_CSP: 'false',
  NODE_ENV: 'production',
  OGE_VAULT_INSPECT_OWNER_ID: 'synthetic-owner-' + randomUUID(),
  OGE_VAULT_INSPECT_SESSION_VERSION: randomUUID(),
  OGE_VAULT_INSPECT_REPO_ID: '38572',
  OGE_VAULT_INSPECT_INSTALLATION_ID: '71',
  OGE_VAULT_CHUNK_PLAN_DIRECTORY: folder,
  OGE_VAULT_CHUNK_RESTORE_TICKET_FILE: ticketFile,
  OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY: '',
  OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY: '',
});

function blocked(env) {
  const result = spawnSync(process.execPath, [script], {
    env, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(result.status, 1, 'rejected BEFORE provider/database access');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BLOCKED:/);
  for (const privateText of ['SENSITIVE_PRIVATE_BACKUP_ANSWER',
    env.OGE_VAULT_INSPECT_OWNER_ID, env.MONGODB_URI])
    assert.equal(result.stderr.includes(privateText), false);
}

test('M59 local CLI uses same isolated staging configuration and cannot use production DB', () => {
  const env = staging('/tmp/oge-m59-no-chunks', '/tmp/oge-m59-no-ticket');
  assert.equal(checkVaultStagingReadiness(env).ok, true);
  blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_STAGING_OPERATOR: '' });
  blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_STAGING_ACK: '' });
  blocked({ ...env, MONGODB_DB: 'oge_notes' });
  blocked({ ...env, MONGODB_URI: 'mongodb://localhost:27017/' });
  blocked({ ...env, OGE_STAGING_URL: 'https://oge.example' });
  blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW: 'false' });
  blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY:
    'YES_VERIFIED_NOTES_CHUNKS_ONLY' });
  blocked({ ...env, OGE_VAULT_INSPECT_INSTALLATION_ID: 'invalid' });
});

test('M59 signed operator refuses public files, extra filenames, symlinks and invalid receipt without connecting', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'oge-m59-chunks-'));
  const parent = await mkdtemp(join(tmpdir(), 'oge-m59-approval-'));
  const chunk = join(folder, 'part-0001.json');
  const ticket = join(parent, 'signed-ticket.json');
  try {
    await chmod(folder, 0o700);
    await chmod(parent, 0o700);
    await writeFile(chunk, JSON.stringify({
      answer: 'SENSITIVE_PRIVATE_BACKUP_ANSWER',
    }), { mode: 0o600 });
    await writeFile(ticket, JSON.stringify({ ticket: 'invalid' }),
      { mode: 0o600 });
    const env = staging(folder, ticket);
    blocked(env);
    await chmod(chunk, 0o644);
    blocked(env);
    await chmod(chunk, 0o600);
    await chmod(folder, 0o755);
    blocked(env);
    await chmod(folder, 0o700);
    await chmod(ticket, 0o644);
    blocked(env);
    await chmod(ticket, 0o600);
    await writeFile(join(folder, 'part-0003.json'), '{}', { mode: 0o600 });
    blocked(env);
    await rm(join(folder, 'part-0003.json'));
    const link = join(parent, 'link.json');
    await symlink(ticket, link);
    blocked({ ...env, OGE_VAULT_CHUNK_RESTORE_TICKET_FILE: link });
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('M59 all privacy and mutation conditions are behind private receipt claim', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /verifyVaultRestoreApprovalTicket/);
  assert.match(source, /claimVaultRestoreApprovalOnce/);
  assert.match(source, /confirmVaultRestoreApproval/);
  assert.match(source, /executeApprovedVaultChunkRestoreBatch/);
  assert.match(source, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /getVaultNoteClient/);
  assert.match(source, /oge_vault_restore_staging_/);
  assert.ok(source.indexOf('verifyVaultRestoreApprovalTicket(obj.ticket') <
    source.indexOf('await mongo.connect()'));
  assert.ok(source.indexOf('await claimVaultRestoreApprovalOnce(') <
    source.indexOf('const github = await getVaultNoteClient('));
  assert.ok(source.indexOf('await claimVaultRestoreApprovalOnce(') <
    source.indexOf('await executeApprovedVaultChunkRestoreBatch('));
  assert.doesNotMatch(source, /deleteOne\(|dropDatabase\(|releasePreWriteVaultImportLock/);
});
