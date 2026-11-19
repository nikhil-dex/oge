import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { noteEditorFeedback } from '../lib/oge-notes-editor-feedback.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('M125 GitHub Notes renders original Oge Notes page directly without duplicate wrapper', async () => {
  const wrapper = await read('../app/vault/notes/page.js');
  const notes = await read('../app/notes/page.js');
  assert.match(wrapper, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
  assert.match(wrapper, /export const metadata = \{ title: 'Oge · Notes' \}/);
  assert.doesNotMatch(wrapper, /Return to Oge Vault|oge-vault-editor-back|workspace preview/);
  assert.doesNotMatch(notes, /GITHUB VAULT PREVIEW|Temporary encrypted drafts autosave to MongoDB|oge-vault-editor-notice/);
  assert.match(notes, /<main className="shell">/);
  assert.match(notes, /YOUR PERSONAL KNOWLEDGE BASE/);
  assert.match(notes, /TOTAL NOTES/);
  assert.match(notes, /editingId \? 'Save changes' : 'Save note'/);
  assert.match(notes, /notesApi = '\/api\/notes', vaultMode = false/);
  assert.match(notes, /notesApi \+ '\?paged=true&limit=20'/);
  assert.match(notes, /<SiteNavbar notesHref=\{vaultMode \? '\/vault\/notes' : '\/notes'\}/);
});

test('M125 capture removes provider debug banners but retains Notes navigation and genuine errors', async () => {
  const page = await read('../app/vault/capture/page.js');
  const capture = await read('../app/vault/capture/vault-quick-capture-client.js');
  assert.doesNotMatch(page, /oge-retro-workspace-ribbon|ENCRYPTED AUTOSAVE · PRIVATE GITHUB/);
  assert.match(page, /YOUR PERSONAL KNOWLEDGE BASE/);
  assert.doesNotMatch(capture, /Quick Capture → Vault|Encrypted draft revision:|Private GitHub on Save|No automatic GitHub pushes/);
  assert.match(capture, /Save note →/);
  assert.match(capture, /Check GitHub Save \(read-only\)/);
  assert.match(capture, /role="alert"/);
  assert.match(capture, /href="\/vault\/notes"/);
});

test('M125 editor preserves visible Save and draft feedback without GitHub marketing copy', () => {
  const saved = noteEditorFeedback({ vaultMode: true,
    message: 'Note saved successfully.', editingId: 'saved-note' });
  assert.deepEqual(saved, { kind: 'saved', label: 'Note saved.' });
  const draft = noteEditorFeedback({ vaultMode: true, hybridDrafts: true,
    editingId: 'saved-note', changed: true, draftStatus: 'Draft saved' });
  assert.equal(draft.kind, 'draft');
  assert.match(draft.label, /press Save to finish/);
  assert.doesNotMatch(draft.label, /GitHub|MongoDB|PREVIEW/);
  const failed = noteEditorFeedback({ vaultMode: true,
    error: 'github-api-error', changed: true });
  assert.equal(failed.kind, 'error');
  assert.match(failed.label, /Save not confirmed/);
});
