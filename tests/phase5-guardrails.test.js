import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dictionary route applies shared rate limiting before external fetch', async () => {
  const source = await readFile(new URL('../app/api/word-meaning/route.js', import.meta.url), 'utf8');
  assert.ok(source.includes("scope: 'dictionary-lookup'"));
  assert.ok(source.includes('limit: 40'));
  const throttleIndex = source.indexOf('await checkRateLimit(');
  const firstProvider = source.indexOf('const upstream = await fetchWithTimeout(');
  assert.ok(throttleIndex > 0 && firstProvider > throttleIndex);
  assert.ok(source.includes('if (!throttle.allowed) return rateLimitResponse(throttle);'));
});

test('subject listing is capped and creation is subject to the same cap', async () => {
  const source = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(source, /\.limit\(1000\)\.toArray\(\)/);
  assert.ok(source.includes("countDocuments({ ownerId }, { limit: 1000 })"));
  assert.ok(source.includes('Subject limit reached (1,000).'));
});

test('staging isolation test refuses production hosts and uses two distinct cookies', async () => {
  const source = await readFile(new URL('../scripts/verify-staging-isolation.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('OGE_STAGING_COOKIE_A'));
  assert.ok(source.includes('OGE_STAGING_COOKIE_B'));
  assert.ok(source.includes('OGE_STAGING_HOST'));
  assert.ok(source.includes('Refusing to run outside'));
  assert.ok(source.includes("foreignDelete.status === 404 || foreignDelete.status === 403"));
  for (const resource of ['/api/quick-notes', '/api/personal-quick-notes', '/api/saved-links']) {
    assert.ok(source.includes("path: '" + resource + "'"), 'staging test must include ' + resource);
  }
  assert.ok(source.includes('createdResources.reverse()'), 'temporary data must be cleaned up');
  assert.ok(source.includes('Account B can view account A private subject'));
});
