import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/plan-vault-chunk-restore.mjs', import.meta.url).pathname;
const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64);
function request() {
  return { confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH',
    expectedSourceSnapshot: SHA, expectedSourceInventorySha256: HASH,
    expectedTargetHead: SHA, selectedIds: [randomUUID()] };
}
function scope(directory, selectionFile) {
  return { ...process.env,
    MONGODB_URI: 'mongodb://127.0.0.1:27017/',
    MONGODB_DB: 'oge_ci_intent_guard',
    OGE_VAULT_INSPECT_OWNER_ID: 'synthetic-' + randomUUID(),
    OGE_VAULT_INSPECT_SESSION_VERSION: randomUUID(),
    OGE_VAULT_INSPECT_REPO_ID: '452',
    OGE_VAULT_CHUNK_PLAN_DIRECTORY: directory,
    OGE_VAULT_CHUNK_BATCH_SELECTION_FILE: selectionFile,
    OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY: '',
    OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY: 'YES_EXACT_VERIFIED_SELECTION_ONLY',
  };
}
function blocked(env) {
  const result = spawnSync(process.execPath, [script], {
    env, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BLOCKED:/);
  assert.ok(!result.stderr.includes(env.OGE_VAULT_INSPECT_OWNER_ID));
  assert.ok(!result.stderr.includes('PRIVATE CHUNK BODY'));
}

test('M57 private operator requires exclusive read-only batch selection consent', () => {
  const dir = '/tmp/m57-no-private-chunks', file = '/tmp/m57-no-selection';
  blocked({ ...scope(dir, file),
    OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY: '' });
  blocked({ ...scope(dir, file),
    OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY: 'YES_VERIFIED_NOTES_CHUNKS_ONLY' });
  blocked({ ...scope(dir, file),
    OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY: 'YES_RESTORE_NOW' });
  blocked({ ...scope(dir, 'relative/file.json') });
});

test('M57 strict 0600 selection JSON, private 0700 chunk directory and symlink rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oge-m57-private-'));
  const selectionFile = join(dir, 'selection.json');
  const file = join(dir, 'part-0001.json');
  try {
    await chmod(dir, 0o700);
    await writeFile(file, JSON.stringify({ privateNote: 'PRIVATE CHUNK BODY' }),
      { mode: 0o600 });
    await writeFile(selectionFile, JSON.stringify(request()), { mode: 0o600 });
    // The directory should contain ONLY numbered chunks. A separate
    // approval must be outside this directory, not a hidden extra file.
    blocked(scope(dir, selectionFile));
    await rm(selectionFile);
    const selectionParent = await mkdtemp(join(tmpdir(), 'oge-m57-approval-'));
    try {
      await chmod(selectionParent, 0o700);
      const actualApproval = join(selectionParent, 'approval.json');
      await writeFile(actualApproval, JSON.stringify(request()), { mode: 0o600 });
      await chmod(actualApproval, 0o644);
      blocked(scope(dir, actualApproval));
      await chmod(actualApproval, 0o600);
      await chmod(dir, 0o755);
      blocked(scope(dir, actualApproval));
      await chmod(dir, 0o700);
      await chmod(file, 0o644);
      blocked(scope(dir, actualApproval));
      await chmod(file, 0o600);
      const link = join(selectionParent, 'selection-link.json');
      await symlink(actualApproval, link);
      blocked(scope(dir, link));
      await writeFile(actualApproval, JSON.stringify({ ...request(), selectedIds: [] }),
        { mode: 0o600 });
      blocked(scope(dir, actualApproval));
    } finally { await rm(selectionParent, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M57 read-only batch script never mints a write-token or persists note bodies', async () => {
  const file = await readFile(script, 'utf8');
  assert.match(file, /prepareVaultChunkRestoreBatchIntentReadOnly/);
  assert.match(file, /validateVaultChunkRestoreBatchSelection/);
  assert.match(file, /O_NOFOLLOW/);
  assert.ok(file.indexOf('readPrivateSelectionFile(selectionFile)') <
    file.indexOf('new MongoClient('),
  'private selection is checked before database access');
  assert.ok(file.indexOf('checkPrivateChunkDirectory(directory)') <
    file.indexOf('new MongoClient('),
  'private chunk directory is checked before database access');
  assert.match(file, /getVaultNoteClient\(db, identity, \{ readOnly: true \}\)/);
  assert.doesNotMatch(file,
    /\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch\(/);
});
