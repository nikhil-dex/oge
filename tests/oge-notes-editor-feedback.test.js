import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { noteEditorFeedback, noteBodyMetrics } from '../lib/oge-notes-editor-feedback.js';

const mode = { vaultMode: true, hybridDrafts: true, hybridReady: true };
const feedback = (options = {}) => noteEditorFeedback({ ...mode, ...options });

test('M106 never labels a temporary autosaved draft as a GitHub commit', () => {
  const status = feedback({
    changed: true, draftStatus: 'Draft saved', editingId: 'existing-note',
  });
  assert.equal(status.kind, 'draft');
  assert.match(status.label, /Draft autosaved temporarily/);
  assert.match(status.label, /press Save for GitHub/);
  assert.doesNotMatch(status.label, /^Saved to GitHub/);
  assert.equal(feedback({ changed: true, draftStatus: 'Draft pending — offline' }).kind, 'draft');
});

test('M106 saving and failures take priority over stale draft status', () => {
  assert.equal(feedback({ saving: true, changed: true, draftStatus: 'Draft saved' }).kind, 'working');
  const failed = feedback({ error: 'network-down', changed: true, draftStatus: 'Draft saved' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.label, /Save not confirmed/);
  const recovery = feedback({ hybridError: 'draft conflict', changed: true });
  assert.match(recovery.label, /not confirmed on GitHub/);
  assert.match(feedback({ hybridReady: false }).label, /recoverable drafts/);
});

test('M106 existing committed Note, new unsaved Note and confirmed save are distinct', () => {
  assert.match(feedback({ editingId: 'saved-note', changed: false }).label, /Saved version from GitHub/);
  assert.match(feedback({ editingId: '', changed: false }).label, /New note · not saved to GitHub/);
  assert.equal(feedback({
    message: 'Note saved to GitHub successfully.', editingId: 'saved-note',
  }).kind, 'saved');
  assert.match(feedback({ changed: true }).label, /Unsaved changes/);
  assert.equal(noteEditorFeedback({ vaultMode: false, changed: true }).kind, 'draft');
});

test('M106 body counter is stable for empty, whitespace and unicode Notes', () => {
  assert.deepEqual(noteBodyMetrics(''), { characters: 0, words: 0 });
  assert.deepEqual(noteBodyMetrics(' \n\t '), { characters: 4, words: 0 });
  assert.deepEqual(noteBodyMetrics('hello world\nagain'), { characters: 17, words: 3 });
  assert.equal(noteBodyMetrics('नमस्ते दुनिया').words, 2);
  assert.deepEqual(noteBodyMetrics(null), { characters: 0, words: 0 });
});

test('M106 editor has visible reliable Save status, word count and sticky mobile Save CTA', async () => {
  const ui = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../public/extra.css', import.meta.url), 'utf8');
  assert.match(ui, /noteEditorFeedback\(\{/);
  assert.match(ui, /noteBodyMetrics\(answer\)/);
  assert.match(ui, /className=\{'oge-editor-feedback oge-editor-feedback--'/);
  assert.match(ui, /ref=\{headingRef\}/);
  assert.match(ui, /requestAnimationFrame\(\(\) => headingRef\.current\?\.focus\(\)\)/);
  assert.match(ui, /oge-editor-save-footer/);
  assert.match(ui, /Save to GitHub/);
  assert.match(ui, /Temporary draft only — not yet committed/);
  assert.match(ui, /Ctrl\+Enter \(Windows\)/);
  assert.match(style, /\.oge-editor-save-footer\{\s*position:sticky/);
  assert.match(style, /@media\(max-width:640px\)/);
  assert.match(style, /safe-area-inset-bottom/);
});
