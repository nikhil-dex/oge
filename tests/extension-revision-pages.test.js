import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extension setup explains token lifecycle and keeps token actions available', async () => {
  const page = await readFile(new URL('../app/extension/page.js', import.meta.url), 'utf8');
  assert.ok(page.includes('/api/extension-token'));
  assert.match(page, /Generate token/);
  assert.match(page, /Rotate token/);
  assert.match(page, /Revoke token/);
  assert.match(page, /chrome:\/\/extensions/);
  assert.match(page, /Saved Links/);
});

test('revision history can restore only a selected version belonging to the signed-in owner', async () => {
  const page = await readFile(new URL('../app/revision-history/page.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/revision-history/route.js', import.meta.url), 'utf8');
  assert.match(page, /revisionIndex: selected\.revisionIndex/);
  assert.match(page, /Restore this version/);
  assert.match(route, /const ownerId = session\?\.user\?\.id/);
  assert.match(route, /findOne\(\{ _id: new ObjectId\(noteId\), ownerId \}\)/);
  assert.match(route, /updatedRevisions = \[\.\.\.revisions/);
  assert.match(route, /restoreFilter\.updatedAt = note\.updatedAt/);
});

test('revision queue has subject filtering, a non-destructive skip, and recall ratings', async () => {
  const page = await readFile(new URL('../app/revision/page.js', import.meta.url), 'utf8');
  assert.match(page, /revision-subject-filter/);
  assert.match(page, /setNotes\(\(current\) =>/);
  assert.match(page, /Skipped cards return to the end of your queue/);
  for (const rating of ['again', 'hard', 'good', 'easy']) assert.ok(page.includes("value: '" + rating + "'"));
  assert.ok(page.includes('/api/revision'));
});
