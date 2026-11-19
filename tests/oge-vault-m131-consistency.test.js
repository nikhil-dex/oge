import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('GitHub home excludes MongoDB-only revision entry points', () => {
  const home = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(home, /account\.notesStorage !== 'github'/);
  assert.match(home, /item\.href !== '\/revision'/);
  assert.match(home, /item\.href !== '\/revision-history'/);
});

test('Vault file sharing does not copy private links to clipboard', () => {
  const media = readFileSync(new URL('../app/components/media-library.js', import.meta.url), 'utf8');
  assert.match(media, /await downloadFile\(file\);/);
  assert.match(media, /Attach the downloaded file to share it/);
  assert.doesNotMatch(media, /navigator\.clipboard\.writeText\(url\)/);
});

test('Extension documents Quick Notes as its default destination', () => {
  const guide = readFileSync(new URL('../extension/README.md', import.meta.url), 'utf8');
  assert.match(guide, /Quick Notes\*\* is the default destination/);
  assert.match(guide, /Selecting an existing subject saves a regular Note/);
});

test('GitHub standalone pages never fall back to MongoDB routes', () => {
  for (const page of ['quick-notes', 'airnotes']) {
    const source = readFileSync(new URL('../app/' + page + '/page.js', import.meta.url), 'utf8');
    assert.match(source, /if \(!vaultCaptureAvailable\(account\)\) redirect\('\/vault\?setup=onboarding'\)/);
    assert.match(source, /if \(account\.notesStorage !== 'mongodb'\)/);
    assert.match(source, /if \(!account\) redirect\('\/register'\)/);
  }
});

test('Vault settings offers complete GitHub repository ZIP instructions', () => {
  const page = readFileSync(new URL('../app/vault/page.js', import.meta.url), 'utf8');
  assert.match(page, /Code → Download ZIP/);
  assert.match(page, /including Saved Links and My Files/);
  assert.match(page, /not an Oge one-click restore/);
});

test('GitHub Vault navigation includes My Files across existing workspaces', () => {
  const notes = readFileSync(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const airnotes = readFileSync(new URL('../app/components/personal-quick-notes-panel.js', import.meta.url), 'utf8');
  const links = readFileSync(new URL('../app/saved-links/page.js', import.meta.url), 'utf8');
  const quick = readFileSync(new URL('../app/quick-notes/quick-notes-client.js', import.meta.url), 'utf8');
  assert.match(notes, /showFiles=\{vaultMode\}/);
  assert.match(airnotes, /showFiles=\{vaultBacked\}/);
  assert.match(links, /showFiles=\{storage === 'github'\}/);
  assert.match(quick, /vaultBacked && <Link href="\/files">My Files<\/Link>/);
});

test('Vault Quick Notes and AirNotes warn before their 300-item limits', () => {
  const quick = readFileSync(new URL('../app/components/quick-notes-panel.js', import.meta.url), 'utf8');
  const airnotes = readFileSync(new URL('../app/components/personal-quick-notes-panel.js', import.meta.url), 'utf8');
  assert.match(quick, /notes\.length >= 270/);
  assert.match(airnotes, /notes\.length >= 270/);
  assert.match(airnotes, /disabled=\{creating \|\| atVaultLimit\}/);
});
