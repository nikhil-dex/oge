import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findLinkedVaultNote, mergeRecentVaultNotes } from '../lib/oge-vault-recent-notes.js';

const linkedId = 'f0000000-0000-4000-8000-000000000001';
const oldId = '00000001-0000-4000-8000-000000000001';
const secondId = '00000002-0000-4000-8000-000000000001';
const subjectId = 'abcdefff-1234-4123-8123-123456789abc';
const note = (id, heading = 'My GitHub Note') => ({
  id, subjectSlug: subjectId, heading, answer: 'Real note body',
  tags: [], favorite: false, sha: 'f'.repeat(40),
});

test('M112 deep link resolves a Note outside the initial first page', () => {
  const firstPage = [note(oldId), note(secondId)];
  const deepRead = note(linkedId, 'Note from Chrome extension');
  const merged = mergeRecentVaultNotes(firstPage, [deepRead]);
  const selected = findLinkedVaultNote(linkedId, merged);
  assert.deepEqual(selected, deepRead);
  assert.equal(selected.subjectSlug, subjectId);
  assert.equal(selected.answer, 'Real note body');
  assert.equal(firstPage.some((item) => item.id === linkedId), false);
});

test('M112 link only resolves an existing loaded Note, not an arbitrary query ID', () => {
  const loaded = [note(oldId)];
  assert.equal(findLinkedVaultNote(linkedId, loaded), null);
  assert.equal(findLinkedVaultNote('not-a-uuid', loaded), null);
  assert.equal(findLinkedVaultNote('../../../notes', loaded), null);
  assert.equal(findLinkedVaultNote(null, loaded), null);
  assert.equal(findLinkedVaultNote(oldId, null), null);
  assert.equal(findLinkedVaultNote(oldId.toUpperCase(), loaded)?.id, oldId);
  assert.equal(findLinkedVaultNote(oldId, [{ ...loaded[0], id: 'invalid' }]), null);
});

test('M112 open-once semantics prevent Save reload from re-opening a reader', () => {
  const loaded = [note(linkedId)];
  let lastOpened = null;
  const opened = [];
  function handleLoad(requestedId) {
    const selected = findLinkedVaultNote(requestedId, loaded);
    if (selected && lastOpened !== selected.id) {
      lastOpened = selected.id;
      opened.push(selected.id);
    }
  }
  handleLoad(linkedId);
  handleLoad(linkedId); // refresh after editing; URL still includes ?note=
  handleLoad(linkedId);
  assert.deepEqual(opened, [linkedId]);
});

test('M112 actual Notes page opens the reader, selects subject, and reports unavailable links', async () => {
  const src = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  assert.match(src, /findLinkedVaultNote\(linkId, loadedNotes\)/);
  assert.match(src, /setActiveSubject\(\(current\) => preferredSubject \|\| direct\?\.subjectSlug/);
  assert.match(src, /openedDeepLinkRef\.current !== direct\.id/);
  assert.match(src, /setReaderNote\(direct\)/);
  assert.match(src, /setShareMenuOpen\(false\)/);
  assert.match(src, /Could not open the linked GitHub Note/);
  assert.match(src, /role="dialog" aria-modal="true" aria-labelledby="readerTitle"/);
  assert.match(src, /onClick=\{\(\) => editNote\(readerNote\)\}/);
});

test('M112 extension passes only a validated note ID, and its shortcut is user-clicked', async () => {
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(worker, /if \(message\.type === 'OPEN_VAULT_NOTE'\)/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: origin \+ '\/vault\/notes\?note='/);
  assert.match(ui, /noteOpenSaved\.addEventListener\('click', async \(\) =>/);
  assert.match(ui, /send\('OPEN_VAULT_NOTE', \{ id: lastSavedVaultNoteId \}\)/);
  assert.match(ui, /noteOpenSaved\.hidden = false/);
  assert.match(ui, /\[data-open-saved-vault-note\]\[hidden\]/);
  assert.match(ui, /\[data-new-vault-note\]\[hidden\]\{display:none\}/);
});
