import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('notes API authenticates every operation and scopes note queries to the session owner', async () => {
  const route = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /ownerId: ctx\.ownerId/);
  assert.match(route, /subjectSlug/);
  assert.match(route, /new ObjectId\(id\), ownerId: ctx\.ownerId/);
  assert.match(route, /readLimitedBody\(request, 32 \* 1024\)/);
});

test('subjects API scopes list, creation and deletion to the signed-in owner', async () => {
  const route = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /find\(\{ ownerId \}\)/);
  assert.match(route, /ownerId, slug/);
  assert.match(route, /deleteMany\(\{ ownerId, subjectSlug: slug \}\)/);
  assert.match(route, /readLimitedBody\(request, 4 \* 1024\)/);
});
