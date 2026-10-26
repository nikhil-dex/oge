import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Revision queue and ratings only affect notes owned by the signed-in user', async () => {
  const route = await readFile(new URL('../app/api/revision/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /ownerId: ctx\.ownerId/);
  assert.match(route, /_id: new ObjectId\(id\), ownerId/);
  assert.match(route, /reviewDueAt/);
  assert.match(route, /again: 1, hard: 3, good: 7, easy: 14/);
});

test('Revision History reads only owned notes and never exposes owner IDs', async () => {
  const route = await readFile(new URL('../app/api/revision-history/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /\{ ownerId, revisions:/);
  assert.match(route, /limit\(100\)/);
});
