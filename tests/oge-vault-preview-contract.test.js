import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('B3 preview is a separate feature-flagged authenticated GitHub-only workspace', async () => {
  const page = await readFile(new URL('../app/vault/preview/page.js', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../app/vault/vault-preview-client.js', import.meta.url), 'utf8');
  const autosave = await readFile(new URL('../lib/oge-vault-autosave.js', import.meta.url), 'utf8');
  assert.match(page, /OGE_VAULT_NOTE_API_PREVIEW !== 'true'/);
  assert.match(page, /await auth\(\)/);
  assert.match(page, /ownerMutationFilter\(/);
  assert.match(page, /account\.vault\?\.status !== 'connected'/);
  assert.match(editor, /\/api\/vault\/batch/);
  assert.match(editor, /\/api\/vault\/notes/);
  assert.match(editor, /Promise\.allSettled/);
  assert.match(editor, /\/api\/vault\/notes\?paged=true&limit=20/);
  assert.match(editor, /encodeURIComponent\(nextCursor\)/);
  assert.match(editor, /setNextCursor\(page\.nextCursor \|\| null\)/);
  assert.match(editor, /Load more GitHub notes/);
  assert.match(editor, /error\.status === 409/);

  assert.match(editor, /readVaultDraft\(window\.sessionStorage, key\)/);
  assert.match(editor, /createVaultAutosave\(/);
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /Discard local draft/);
  assert.doesNotMatch(editor, /\/api\/notes['"?]/);
  assert.doesNotMatch(autosave, /fetch\(.*\/api\/notes/);
  assert.doesNotMatch(autosave, /collection\(['"]notes['"]\)/);
});

test('B3 preview does not turn on mandatory GitHub access in legacy Notes editor', async () => {
  const legacy = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../app/vault/preview/page.js', import.meta.url), 'utf8');
  assert.match(legacy, /NotesPage\(\{ notesApi = '\/api\/notes'/);
  assert.match(preview, /VaultPreviewClient/);
});
