import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

test('familiar GitHub Notes interface uses a separate, mandatory preview flag and owner gate', async () => {
  const page = await read('../app/vault/notes/page.js');
  assert.match(page, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(page, /await auth\(\)/);
  assert.match(page, /ownerMutationFilter\(/);
  assert.match(page, /user\?\.vault\?\.status !== 'connected'/);
  assert.match(page, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
});

test('Notes UI preserves MongoDB production route while GitHub preview passes SHA for edits, favorites and delete', async () => {
  const page = await read('../app/notes/page.js');
  assert.match(page, /NotesPage\(\{ notesApi = '\/api\/notes', vaultMode = false \}/);
  assert.match(page, /fetch\(notesApi, \{ cache: 'no-store' \}\)/);
  assert.match(page, /vaultMode \? \{ sha: current\.sha \} : \{\}/);
  assert.match(page, /vaultMode \? \{ sha: note\.sha \} : \{\}/);
  assert.match(page, /vaultMode \? '&sha=' \+ encodeURIComponent\(note\.sha \|\| ''\)/);
  assert.match(page, /editingId && !vaultMode && <button/);
});

test('GitHub Notes adapter uses only GitHub content calls for all five CRUD verbs', async () => {
  const adapter = await read('../app/api/vault/notes-main/route.js');
  assert.match(adapter, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(adapter, /getVaultNoteClient\(/);
  assert.match(adapter, /ownerId: ctx\.ownerId, slug/);
  assert.match(adapter, /return await execute\(ctx, data\)/);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.match(adapter, new RegExp('export async function ' + method));
  }
  assert.match(adapter, /commitVaultNoteBatch\(/);
  assert.match(adapter, /readVaultNote\(/);
  assert.doesNotMatch(adapter, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(adapter, /insertOne\(/);
  assert.doesNotMatch(adapter, /updateOne\(/);
  assert.doesNotMatch(adapter, /deleteOne\(/);
});

test('familiar vault Notes paginates without changing the legacy production endpoint', async () => {
  const page = await read('../app/notes/page.js');
  const adapter = await read('../app/api/vault/notes-main/route.js');
  assert.match(page, /vaultMode \? notesApi \+ '\?paged=true&limit=20' : notesApi/);
  assert.match(page, /setNextNotesCursor\(vaultMode \? response\.nextCursor \|\| null : null\)/);
  assert.match(page, /encodeURIComponent\(nextNotesCursor\)/);
  assert.match(page, /setNotes\(\(existing\) => \{/);
  assert.match(page, /Load more GitHub notes/);
  assert.match(page, /Search, filters and sorting apply to loaded notes/);
  assert.match(adapter, /params\.get\('paged'\) === 'true'/);
  assert.match(adapter, /listVaultNotePage\(ctx\.client, \{ limit, cursor: params\.get\('cursor'\) \}\)/);
  assert.match(adapter, /note\.subjectId === subject/);
  assert.doesNotMatch(adapter, /collection\(['"]notes['"]\)/);
});

test('GitHub Notes adapter translates GitHub SHA and owner-scoped subject fields for classic UI', async () => {
  const adapter = await read('../app/api/vault/notes-main/route.js');
  assert.match(adapter, /subjectSlug: note\.subjectId/);
  assert.match(adapter, /sha: note\.sha/);
  assert.match(adapter, /Note ID and expected GitHub revision required/);
  assert.match(adapter, /Note ID, revision and favorite value required/);
  assert.match(adapter, /Note ID and revision required/);
  assert.match(adapter, /Changing subjects is not supported/);
});
