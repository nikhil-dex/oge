import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('subject deletion blocks connected GitHub vault accounts before legacy atomic deletion', async () => {
  const source = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function DELETE'));
  const index = (value) => body.indexOf(value);
  const accountLookup = "ownerMutationFilter(ownerId, { sessionVersion })";
  const gate = "account.vault?.status === 'connected'";
  const legacyDelete = "deleteSubjectAtomically(db, ownerId, slug, { sessionVersion })";
  assert.ok(index(accountLookup) > 0, 'validate session before deletion');
  assert.ok(index(gate) > index(accountLookup), 'validate vault connection');
  assert.ok(index(legacyDelete) > index(gate), 'block before deleting MongoDB metadata');
  assert.match(body, /return json\(\{ error: 'Subject deletion is temporarily disabled for connected Oge Vault accounts/);
  assert.match(body, /if \(!account\) return json\(\{ error: 'Account session expired\.' \}, 401\)/);
});

test('non-vault subject deletion retains transactional legacy implementation', async () => {
  const source = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(source, /await deleteSubjectAtomically\(db, ownerId, slug, \{ sessionVersion \}\)/);
  const legacy = await readFile(new URL('../lib/atomic-subject-deletion.js', import.meta.url), 'utf8');
  assert.match(legacy, /withAtomicBackupImport\(db/);
  assert.match(legacy, /db\.collection\('notes'\)\.deleteMany/);
});
