import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('M125 connected GitHub Notes reuses original Oge interface and Save wording', async () => {
  const vault = await read('../app/vault/notes/page.js');
  const notes = await read('../app/notes/page.js');
  assert.match(vault, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
  assert.match(notes, /<h1>\{globalSearch \? 'Your library'/);
  assert.match(notes, /<SiteNavbar notesHref=\{vaultMode \? '\/vault\/notes' : '\/notes'\}/);
  assert.match(notes, /<span>\{saving \? 'Saving…' : editingId \? 'Save changes' : 'Save note'\}<\/span>/);
  assert.doesNotMatch(notes, /Save to GitHub<\/button>|GITHUB VAULT PREVIEW|Return to Oge Vault/);
  assert.doesNotMatch(notes, /className="add-button" href="\/vault\/capture"/);
  assert.match(notes, /function openNewNote\(subjectId = activeSubject\)/);
});

test('M125 legacy GitHub preview sends connected owners to normal Notes, without touching storage', async () => {
  const page = await read('../app/vault/preview/page.js');
  const dashboard = await read('../app/vault/page.js');
  assert.match(page, /OGE_VAULT_MAIN_PREVIEW === 'true'\)\s+redirect\('\/vault\/notes'\)/);
  assert.match(page, /account\.vault\?\.status !== 'connected'/);
  assert.match(page, /ownerMutationFilter\(/);
  assert.match(dashboard, /previewEnabled && !mainPreviewEnabled/);
  assert.match(dashboard, /href="\/vault\/notes">Open My Notes/);
  const adapter = await read('../app/api/vault/notes-main/route.js');
  assert.match(adapter, /commitVaultNoteBatch\(ctx\.client/);
  assert.doesNotMatch(adapter, /collection\(['"]notes['"]\)/);
});

test('M125 home and Quick Capture remain accessible without preview-themed Notes header', async () => {
  const notes = await read('../app/notes/page.js');
  const quick = await read('../app/vault/capture/page.js');
  assert.match(notes, /<p className="eyebrow">YOUR PERSONAL KNOWLEDGE BASE<\/p>/);
  assert.match(notes, /<footer><span>Built for learning, one note at a time\.<\/span>/);
  assert.match(quick, /<VaultQuickCaptureClient/);
});
