import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspace settings keep organization, appearance, news and data while profile owns account security', async () => {
  const page = await readFile(new URL('../app/settings/page.js', import.meta.url), 'utf8');
  const client = await readFile(new URL('../app/settings/settings-client.js', import.meta.url), 'utf8');
  const profile = await readFile(new URL('../app/profile/page.js', import.meta.url), 'utf8');
  for (const section of ['organization', 'appearance', 'pixel-strip', 'news-preferences', 'data']) {
    assert.ok(page.includes('#' + section) || page.includes('id="' + section + '"') || client.includes('id="' + section + '"'), 'Missing settings section: ' + section);
  }
  assert.match(page, /saveNewsInterests/);
  assert.match(page, /href="\/profile"/);
  assert.match(profile, /signOutOfOgeNotes/);
  assert.match(profile, /setLinkedPassword/);
  assert.ok(client.includes('/api/subjects'));
  assert.match(client, /ogenotes-pixel-strip-settings/);
  assert.match(client, /Restore from backup/);
  assert.doesNotMatch(page, /onClick=/, 'Server-rendered settings page should not pass event handlers from a Server Component.');
});

test('backup API scopes exports and restores to the authenticated owner', async () => {
  const route = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  assert.match(route, /format: 'oge-notes-backup'/);
  assert.match(route, /find\(\{ ownerId: ctx\.ownerId \}, \{ session \}\)/);
  assert.match(route, /find\(\{ ownerId \}, \{ session \}\)/);
  assert.match(route, /insertOne\(\{\s*ownerId,/);
  assert.match(route, /normalizeSavedLink/);
  assert.match(route, /MAX_BACKUP_BYTES/);
});
