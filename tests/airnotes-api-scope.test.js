import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AirNotes API stores records separately and scopes operations by owner', async () => {
  const route = await readFile(new URL('../app/api/personal-quick-notes/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /collection\('personalQuickNotes'\)/);
  assert.match(route, /find\(\{ ownerId: ctx\.ownerId \}\)/);
  assert.match(route, /_id: id, ownerId: ctx\.ownerId/);
});
