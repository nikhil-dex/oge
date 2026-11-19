import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('M120 Add a note stays clickable when no subject is selected', async () => {
  const page = await read('../app/notes/page.js');
  const actions = page.match(/<button className="add-button" type="button" onClick=\{\(\) => openNewNote\(\)\}[^>]*>/g) || [];
  assert.equal(actions.length, 2, 'Header and empty-state note actions must both be usable');
  for (const action of actions) assert.doesNotMatch(action, /disabled=/);
  assert.doesNotMatch(page, /onClick=\{openNewNote\} disabled=\{!activeSubject\}/);
});

test('M120 clicking Add a note without a subject opens and focuses subject creation', async () => {
  const page = await read('../app/notes/page.js');
  assert.match(page, /function openNewNote\(subjectId = activeSubject\) \{\s*if \(!subjectId\) \{/);
  assert.match(page, /createNoteAfterSubjectRef\.current = true;\s*setShowSubjectForm\(true\)/);
  assert.match(page, /ref=\{subjectInputRef\}/);
  assert.match(page, /subjectInputRef\.current\?\.focus\(\)/);
  assert.match(page, /Create a subject below\. Your new Note will open automatically/);
});

test('M120 successfully creating the first subject opens a note in that subject', async () => {
  const page = await read('../app/notes/page.js');
  assert.match(page, /await load\(subject\.slug\);\s*if \(createNoteAfterSubjectRef\.current\)/);
  assert.match(page, /createNoteAfterSubjectRef\.current = false;\s*openNewNote\(subject\.slug\)/);
  assert.match(page, /recoverNewHybridDraft\(subjectId, generation\)/);
  assert.match(page, /setShowSubjectForm\(false\);\s*createNoteAfterSubjectRef\.current = false;\s*\}\}>Cancel/);
  const subjects = await read('../app/api/subjects/route.js');
  assert.match(subjects, /export async function POST\(request\)/);
  assert.match(subjects, /slug: randomUUID\(\)/);
});

test('M120 note Save still requires a selected subject and GitHub mode retains the provider writer', async () => {
  const page = await read('../app/notes/page.js');
  assert.match(page, /disabled=\{saving \|\| !activeSubject \|\| \(hybridDrafts && !hybridReady\)\}/);
  assert.match(page, /notesApi="\/api\/vault\/notes-main"/) === false; // prop belongs to VaultNotesPage
  const vault = await read('../app/vault/notes/page.js');
  assert.match(vault, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
});
