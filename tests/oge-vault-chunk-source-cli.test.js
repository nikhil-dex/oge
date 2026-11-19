import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../scripts/verify-vault-chunk-source.mjs',
  import.meta.url).pathname;
const scope = (folder) => ({
  ...process.env,
  MONGODB_URI: 'mongodb://127.0.0.1:27017/',
  MONGODB_DB: 'oge_ci_no_source_access',
  OGE_VAULT_INSPECT_OWNER_ID: 'test-owner-' + randomUUID(),
  OGE_VAULT_INSPECT_SESSION_VERSION: randomUUID(),
  OGE_VAULT_INSPECT_REPO_ID: '482',
  OGE_VAULT_CHUNK_PLAN_DIRECTORY: folder,
  OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY: 'YES_CURRENT_GITHUB_HEAD_ONLY',
});
const expectBlocked = (env) => {
  const r = spawnSync(process.execPath, [cli], {
    env, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /BLOCKED:/);
  for (const value of [env.OGE_VAULT_INSPECT_OWNER_ID,
    'PRIVATE NEVER PRINT', env.MONGODB_URI])
    assert.equal(r.stderr.includes(value), false);
};

test('M55 CLI needs explicit read-only opt-in and exact owner scope before network', () => {
  expectBlocked({ ...scope('/tmp/never-present-source'),
    OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY: '' });
  expectBlocked({ ...scope('/tmp/never-present-source'),
    OGE_VAULT_INSPECT_REPO_ID: 'invalid' });
  expectBlocked(scope('relative/private'));
});

test('M55 source proof preflights 0700 directory, 0600 files, contiguous names and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oge-m55-private-'));
  const file = join(dir, 'part-0001.json');
  try {
    await chmod(dir, 0o700);
    await writeFile(file, JSON.stringify({ note: 'PRIVATE NEVER PRINT' }),
      { mode: 0o600 });
    await chmod(file, 0o644);
    expectBlocked(scope(dir));
    await chmod(file, 0o600);
    await chmod(dir, 0o755);
    expectBlocked(scope(dir));
    await chmod(dir, 0o700);
    await rm(file);
    await writeFile(join(dir, 'part-0002.json'), '{}', { mode: 0o600 });
    expectBlocked(scope(dir));
    await rm(join(dir, 'part-0002.json'));
    await writeFile(join(dir, 'target.json'), '{}', { mode: 0o600 });
    await symlink(join(dir, 'target.json'), file);
    expectBlocked(scope(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M55 source verifier cannot write GitHub, alter MongoDB notes or authorize restore', async () => {
  const cliSource = await readFile(cli, 'utf8');
  const engine = await readFile(new URL(
    '../lib/oge-vault-backup-chunk-source-proof.js', import.meta.url), 'utf8');
  assert.match(cliSource, /getVaultNoteClient\(db, identity, \{ readOnly: true \}\)/);
  assert.match(cliSource, /ownerMutationFilter/);
  assert.match(cliSource, /O_NOFOLLOW/);
  assert.match(cliSource, /checkPrivateFiles\(directory\)/);
  assert.match(engine, /scanVaultNotesSnapshotIndex/);
  assert.match(engine, /createHash\('sha1'\)/);
  assert.match(engine, /sourceGitHubCommitAndAllBlobBytesVerified: true/);
  assert.match(engine, /currentSourceGitHubCommitAndAllBlobBytesVerified:/);
  assert.match(engine, /historicalSourceSnapshotsSupported: allowBoundedHistory/);
  assert.match(engine, /authorizesRestore: false/);
  assert.match(engine, /canCommit: false/);
  assert.doesNotMatch(cliSource + engine,
    /\.updateOne\(|\.insertOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
});

test('M56 historical source CLI consent is exclusive and never bypasses private files', async () => {
  const bothModes = scope('/tmp/m56-missing-chunks');
  bothModes.OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY = 'YES_CURRENT_GITHUB_HEAD_ONLY';
  bothModes.OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY = 'YES_20_LINEAR_ANCESTORS_ONLY';
  expectBlocked(bothModes);
  const historyOnly = scope('/tmp/m56-missing-chunks');
  historyOnly.OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY = '';
  historyOnly.OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY =
    'YES_20_LINEAR_ANCESTORS_ONLY';
  expectBlocked(historyOnly);
  expectBlocked({
    ...historyOnly, OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY:
      'YES_ARBITRARY_REVISION_HISTORY',
  });
  const source = await readFile(cli, 'utf8');
  assert.match(source, /currentMode !== historyMode/);
  assert.match(source, /allowBoundedHistory: historyMode/);
  assert.match(source, /OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY/);
  assert.doesNotMatch(source, /force: true|method: 'POST'|method: 'PATCH'/);
});
