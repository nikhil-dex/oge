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
