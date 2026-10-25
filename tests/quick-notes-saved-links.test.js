import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Quick Notes API derives ownership from the session and scopes all mutations', async () => {
  const route = await readFile(new URL('../app/api/quick-notes/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /find\(\{ ownerId: ctx\.ownerId \}\)/);
  assert.match(route, /ownerId: ctx\.ownerId/);
  assert.match(route, /_id: id, ownerId: ctx\.ownerId/);
  assert.match(route, /readLimitedBody\(request, 32 \* 1024\)/);
});

test('Saved Links API scopes reads, updates, deletes and reordering to the owner', async () => {
  const route = await readFile(new URL('../app/api/saved-links/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /find\(\{ ownerId: ctx\.ownerId \}\)/);
  assert.match(route, /_id: id, ownerId: ctx\.ownerId/);
  assert.match(route, /ownerId: ctx\.ownerId, _id: \{ \$in: ids \}/);
  assert.match(route, /Only HTTP and HTTPS links are allowed/);
});
