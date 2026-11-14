import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = [
  { path: '../app/api/revision/route.js', scope: 'revision-rating', limit: 120, windowMs: '60 * 1000' },
  { path: '../app/api/revision-history/route.js', scope: 'revision-restore', limit: 30, windowMs: '60 * 60 * 1000' },
];

test('revision rating and history restore use separate owner-scoped rate limits', async () => {
  for (const item of cases) {
    const source = await readFile(new URL(item.path, import.meta.url), 'utf8');
    const mutation = source.slice(source.indexOf('export async function POST('));
    assert.ok(mutation.includes("scope: '" + item.scope + "'"), item.path);
    assert.ok(mutation.includes('identifier: ownerId'), item.path);
    assert.ok(mutation.includes('limit: ' + item.limit), item.path);
    assert.ok(mutation.includes('windowMs: ' + item.windowMs), item.path);
    assert.ok(mutation.includes('if (!throttle.allowed) return rateLimitResponse(throttle);'), item.path);
    assert.ok(mutation.indexOf('await checkRateLimit(') < mutation.indexOf('withActiveOwnerMutation('),
      item.path + ': the limiter must run before starting a transaction');
  }
});

test('limits do not apply to reading revision queue or history', async () => {
  for (const item of cases) {
    const source = await readFile(new URL(item.path, import.meta.url), 'utf8');
    const get = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
    assert.doesNotMatch(get, /checkRateLimit\(/);
  }
});
