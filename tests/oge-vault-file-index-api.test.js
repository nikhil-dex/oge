import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('B6 file-index API remains opt-in, owner scoped and metadata-only', async () => {
  const api = await readFile(new URL('../app/api/vault/file-index/route.js', import.meta.url), 'utf8');
  assert.match(api, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(api, /OGE_VAULT_FILE_INDEX_PREVIEW !== 'true'/);
  assert.match(api, /ownerMutationFilter\(ownerId/);
  assert.match(api, /getVaultNoteClient\(ctx\.db/);
  assert.match(api, /synchronizeVaultFileIndex\(ctx\.db, client/);
  assert.match(api, /lastKnownOnly: true/);
  assert.match(api, /projection: \{ _id: 0, noteId: 1, subjectId: 1, path: 1/);
  assert.match(api, /limit\(100\)/);
  assert.match(api, /checkOwnerMutationLimit/);
  assert.doesNotMatch(api, /export async function DELETE|deleteOne\(|deleteMany\(/);
  assert.doesNotMatch(api, /answer:|heading:|content:|tags:/);
});

test('B6 index does not change legacy Notes or Vault subject deletion routes', async () => {
  const notes = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  const subject = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(notes, /synchronizeVaultFileIndex/);
  assert.match(subject, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});
