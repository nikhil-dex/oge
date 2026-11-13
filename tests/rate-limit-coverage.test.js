import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = [
  ['../app/api/gemini-key/route.js', 'gemini-key-update', 'limit: 12'],
  ['../app/api/extension-token/route.js', 'extension-token-create', 'limit: 10'],
  ['../app/api/news/route.js', 'news-feed', 'limit: 30'],
  ['../app/api/notes/cleanup/route.js', 'gemini-cleanup', 'limit: 10'],
  ['../app/api/extension/save-link/route.js', 'extension-save', 'limit: 60'],
  ['../app/api/backup/route.js', 'backup-export', 'limit: 10'],
  ['../app/api/backup/route.js', 'backup-import', 'limit: 5'],
];

for (const [file, scope, budget] of cases) {
  test('sensitive route uses shared rate limiter: ' + scope, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(source.includes("checkRateLimit"), file);
    assert.ok(source.includes("scope: '" + scope + "'"), file);
    assert.ok(source.includes(budget), file);
    assert.ok(source.includes('rateLimitResponse(throttle)'), file);
  });
}
