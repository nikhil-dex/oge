import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('M124 incomplete Learning Tracks is hidden in normal extension', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  // The prototype remains available in source for a future roadmap milestone,
  // but the shipped extension never presents its controls while this is false.
  assert.match(script, /const LEARNING_TRACKS_EXTENSION_PREVIEW = false;/);
  assert.match(script, /\.\.\.\(LEARNING_TRACKS_EXTENSION_PREVIEW \? \[/);
  assert.match(script, /LEARNING_TRACKS_EXTENSION_PREVIEW \? '<button data-tool="tracks"/);
  assert.match(script, /if \(LEARNING_TRACKS_EXTENSION_PREVIEW\) \{/);
  assert.match(script, /repeat\(' \+ \(LEARNING_TRACKS_EXTENSION_PREVIEW \? 3 : 2\)/);
  assert.match(script, /data-tool="note"/);
  assert.match(script, /data-tool="links"/);
  assert.match(script, /send\('SAVE_CURRENT_TAB'\)/);
  assert.match(script, /send\('CREATE_VAULT_NOTE'/);
  const server = await readFile(new URL('../app/api/extension/learning-track/route.js', import.meta.url), 'utf8');
  assert.match(server, /OGE_LEARNING_TRACKS_PREVIEW !== 'true'/);
});

test('M124 legacy extension remains functional with two tabs', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(script, /panel\.querySelectorAll\('\[data-tool\]'\)/);
  assert.match(script, /setPanel\(button\.dataset\.tool\)/);
  assert.match(script, /const urlSave = panel\.querySelector\('\[data-save-url\]'\)/);
  assert.match(script, /const noteSave = panel\.querySelector\('\[data-save-note\]'\)/);
});
