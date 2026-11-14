import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isHealthCheckAuthorized } from '../lib/healthcheck-auth.js';

const monitorToken = 'monitor-secret-that-is-at-least-32-bytes-long';

test('health monitor requires an explicit strong bearer secret', () => {
  assert.equal(isHealthCheckAuthorized('Bearer ' + monitorToken, monitorToken), true);
  assert.equal(isHealthCheckAuthorized('Bearer wrong-secret-that-is-at-least-32-bytes-long', monitorToken), false);
  assert.equal(isHealthCheckAuthorized('Basic ' + monitorToken, monitorToken), false);
  assert.equal(isHealthCheckAuthorized(monitorToken, monitorToken), false);
  assert.equal(isHealthCheckAuthorized('Bearer ' + monitorToken, undefined), false);
  assert.equal(isHealthCheckAuthorized('Bearer ' + monitorToken, 'weak'), false);
  assert.equal(isHealthCheckAuthorized('Bearer ' + monitorToken + '\nextra', monitorToken), false);
  assert.equal(isHealthCheckAuthorized(null, monitorToken), false);
  assert.equal(isHealthCheckAuthorized('Bearer ' + 'x'.repeat(257), monitorToken), false);
});

test('health response is sanitized, private and checks database availability', async () => {
  const route = await readFile(new URL('../app/api/health/route.js', import.meta.url), 'utf8');
  assert.match(route, /isHealthCheckAuthorized\(request\.headers\.get\('authorization'\)/);
  assert.match(route, /db\.command\(\{ ping: 1 \}/);
  assert.match(route, /status: 'ok'/);
  assert.match(route, /status: 'unavailable'/);
  assert.match(route, /status: 'unauthorized'/);
  assert.match(route, /'Cache-Control': 'no-store, max-age=0'/);
  assert.doesNotMatch(route, /JSON\.stringify\(error\)|error\.message/);
});

test('health endpoint bypasses browser sign-in redirects only for GET', async () => {
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /pathname === '\/api\/health' && request\.method === 'GET'/);
  const route = await readFile(new URL('../app/api/health/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /export async function POST/);
});
