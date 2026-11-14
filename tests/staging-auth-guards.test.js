import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('staging auth guard drill refuses public/production-looking targets', async () => {
  const source = await readFile(new URL('../scripts/verify-staging-auth-guards.mjs', import.meta.url), 'utf8');
  assert.match(source, /OGE_STAGING_URL/);
  assert.match(source, /OGE_STAGING_HOST/);
  assert.match(source, /base\.hostname === explicitHost/);
  assert.match(source, /base\.protocol === 'https:'/);
  assert.match(source, /redirect: 'manual'/);
  assert.match(source, /AbortSignal\.timeout/);
});

test('staging auth guard drill checks private reads and disallowed mutations without changing user data', async () => {
  const source = await readFile(new URL('../scripts/verify-staging-auth-guards.mjs', import.meta.url), 'utf8');
  for (const path of ['/api/subjects', '/api/notes', '/api/quick-notes',
    '/api/personal-quick-notes', '/api/saved-links', '/api/revision-history',
    '/api/backup', '/api/gemini-key', '/api/extension-token']) {
    assert.ok(source.includes("'" + path + "'"), 'must verify private endpoint ' + path);
  }
  assert.match(source, /invalid-staging-session/);
  assert.match(source, /__oge_staging_csrf_probe/);
  assert.match(source, /result\.status === 403/);
  assert.match(source, /goodOrigin\.status === 400/);
  assert.match(source, /monitor\.status === 401/);
  assert.doesNotMatch(source, /method:\s*'DELETE'/);
  assert.doesNotMatch(source, /await request\('\/api\/backup',\s*\{/);
  assert.doesNotMatch(source, /process\.env\.MONGODB_URI/);
});
