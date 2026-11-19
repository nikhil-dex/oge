import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../scripts/plan-vault-chunk-restore.mjs', import.meta.url).pathname;
const privateScope = (dir) => ({
  ...process.env,
  MONGODB_URI: 'mongodb://127.0.0.1:27017/',
  MONGODB_DB: 'oge_ci_chunk_restore_blocked',
  OGE_VAULT_INSPECT_OWNER_ID: 'test-owner-' + randomUUID(),
  OGE_VAULT_INSPECT_SESSION_VERSION: randomUUID(),
  OGE_VAULT_INSPECT_REPO_ID: '193',
  OGE_VAULT_CHUNK_PLAN_DIRECTORY: dir,
  OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY: 'YES_VERIFIED_NOTES_CHUNKS_ONLY',
});
const blocked = (env) => {
  const r = spawnSync(process.execPath, [cli], {
    env, encoding: 'utf8', timeout: 7000,
  });
  assert.equal(r.status, 1, 'must reject before any MongoDB connection');
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /BLOCKED:/);
  assert.doesNotMatch(r.stderr, /PRIVATE CHUNK TEXT/);
  assert.equal(r.stderr.includes(env.OGE_VAULT_INSPECT_OWNER_ID), false);
  return r;
};

test('M54 local operator CLI rejects missing scope or opt-in before networking', async () => {
  blocked({ ...privateScope('/tmp/does-not-exist'),
    OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY: '' });
  blocked({ ...privateScope('/tmp/does-not-exist'),
    OGE_VAULT_INSPECT_REPO_ID: 'not-a-repo' });
  blocked({ ...privateScope('relative/chunks') });
});

test('M54 local operator CLI refuses world-readable files and directories, gaps and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oge-m54-chunk-'));
  const file = join(directory, 'part-0001.json');
  const hidden = join(directory, 'PRIVATE-SOURCE.json');
  try {
    await chmod(directory, 0o700);
    await writeFile(file, JSON.stringify({ noteText: 'PRIVATE CHUNK TEXT' }), {
      mode: 0o600,
    });
    await chmod(file, 0o644);
    blocked(privateScope(directory));
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    blocked(privateScope(directory));
    await chmod(directory, 0o700);
    await writeFile(hidden, '{}', { mode: 0o600 });
    blocked(privateScope(directory));
    await rm(hidden);
    await rm(file);
    await writeFile(join(directory, 'part-0002.json'), '{}', { mode: 0o600 });
    blocked(privateScope(directory));
    await rm(join(directory, 'part-0002.json'));
    await writeFile(hidden, 'PRIVATE CHUNK TEXT', { mode: 0o600 });
    await symlink(hidden, file);
    blocked(privateScope(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M54 operator plan has no GitHub writes, no MongoDB draft/content writes and limited preview output', async () => {
  const cliSource = await readFile(cli, 'utf8');
  const planner = await readFile(new URL(
    '../lib/oge-vault-backup-chunk-restore-plan.js', import.meta.url), 'utf8');
  assert.match(cliSource, /getVaultNoteClient\(db, identity, \{ readOnly: true \}\)/);
  assert.match(cliSource, /ownerMutationFilter/);
  assert.match(cliSource, /O_NOFOLLOW/);
  assert.match(cliSource, /checkPrivateChunkDirectory\(directory\)/);
  assert.match(planner, /createVaultNotesChunkSequenceVerifier/);
  assert.match(planner, /scanVaultNotesSnapshotIndex/);
  assert.match(planner, /canCommit: false/);
  assert.match(planner, /previewTruncated:/);
  assert.doesNotMatch(cliSource + planner,
    /\.updateOne\(|\.insertOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
});
