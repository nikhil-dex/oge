import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('News feed requires a signed-in account and uses stored interests with general defaults', async () => {
  const route = await readFile(new URL('../app/api/news/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /newsInterests/);
  assert.match(route, /DEFAULT_TOPICS/);
  assert.match(route, /news\.google\.com\/rss\/search/);
});

test('Dictionary proxy requires a session and validates the word before fetching providers', async () => {
  const route = await readFile(new URL('../app/api/word-meaning/route.js', import.meta.url), 'utf8');
  assert.match(route, /await auth\(\)/);
  assert.match(route, /WORD_PATTERN/);
  assert.match(route, /AbortSignal\.timeout\(8000\)/);
});
