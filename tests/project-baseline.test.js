import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package uses the expected Next.js and React stack', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies.next);
  assert.ok(pkg.dependencies.react);
  assert.ok(pkg.dependencies.mongodb);
});

test('roadmap and scope documentation remain present', async () => {
  const roadmap = await readFile(new URL('../ROADMAP.md', import.meta.url), 'utf8');
  assert.match(roadmap, /No PDF, image, attachment/);
  assert.match(roadmap, /cross-user isolation/i);
  assert.match(roadmap, /browser extension/i);
});
