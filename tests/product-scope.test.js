import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard exposes all nine agreed modules across its sections', async () => {
  const page = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
  for (const label of ['Notes', 'AirNotes', 'Quick Notes', 'Saved Links', 'Browser Extension', 'Revision History', 'Dictionary', 'News', 'Revision']) {
    assert.ok(page.includes(label), `Missing dashboard module: ${label}`);
  }
  assert.match(page, /HomeNewsFeed/);
  assert.match(page, /oge-airnotes-preview/);
  assert.match(page, /oge-quick-notes-bottom/);
});

test('initial release excludes file-storage providers', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@vercel/blob'], undefined);
  assert.equal(pkg.dependencies['@aws-sdk/client-s3'], undefined);
});

test('Google authentication and per-user data foundation exist', async () => {
  const auth = await readFile(new URL('../auth.js', import.meta.url), 'utf8');
  const db = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  assert.match(auth, /providers: \[Google\]/);
  assert.match(auth, /googleSub/);
  assert.match(db, /ownerId/);
});
