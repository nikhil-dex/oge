import test from 'node:test';
import assert from 'node:assert/strict';
import { stagingSmokeOrigin, checkStagingHttp } from '../lib/staging-http-smoke.js';

const staging = 'https://staging.oge.example';
const monitorToken = 'unique-staging-monitor-token-for-testing-00000';

function mockedFetch({ bad = {}, record = [] } = {}) {
  return async (url, options) => {
    record.push({ pathname: url.pathname, method: options.method, redirect: options.redirect,
      authorization: options.headers.Authorization ? 'supplied' : 'none' });
    const redirect = url.pathname === '/settings' ||
      ['/api/subjects', '/api/notes', '/api/backup'].includes(url.pathname);
    const authorizedHealth = url.pathname === '/api/health' && options.headers.Authorization === 'Bearer ' + monitorToken;
    const headers = new Headers(url.pathname === '/register' ? {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000',
      'content-security-policy-report-only': "default-src 'self'",
    } : authorizedHealth ? { 'cache-control': 'no-store' } : redirect ? { location: '/register' } : {});
    const status = url.pathname === '/register' || authorizedHealth ? 200 :
      url.pathname === '/api/health' ? 401 : redirect ? 307 : 404;
    return new Response(null, {
      status: Object.hasOwn(bad, url.pathname) ? bad[url.pathname] : status,
      headers,
    });
  };
}

test('staging URL rejects production, local HTTP, credentials and mismatched hosts', () => {
  assert.equal(stagingSmokeOrigin(staging + '/', 'staging.oge.example'), staging);
  for (const [url, host] of [
    ['https://oge.example', 'oge.example'],
    [staging, 'prod.oge.example'],
    ['http://staging.oge.example', 'staging.oge.example'],
    ['https://username:password@staging.oge.example', 'staging.oge.example'],
    [staging + '/some/path', 'staging.oge.example'],
    [staging + '/?secret=1', 'staging.oge.example'],
  ]) assert.throws(() => stagingSmokeOrigin(url, host));
});

test('healthy private staging denies anonymous access and requires monitor token', async () => {
  const sent = [];
  const report = await checkStagingHttp({ origin: staging, monitorToken, fetcher: mockedFetch({ record: sent }) });
  assert.equal(report.ok, true, JSON.stringify(report.findings.filter(f => !f.pass)));
  assert.ok(sent.some(x => x.pathname === '/api/health' && x.authorization === 'none'));
  assert.ok(sent.some(x => x.pathname === '/api/health' && x.authorization === 'supplied'));
  assert.ok(sent.every(x => x.method === 'GET' && x.redirect === 'manual'));
});

test('private API accidentally returning HTTP 200 fails staging smoke check', async () => {
  const report = await checkStagingHttp({
    origin: staging, monitorToken, fetcher: mockedFetch({ bad: { '/api/notes': 200 } }),
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(x => x.code === 'anonymous--api-notes' && !x.pass));
});

test('incorrect or absent monitoring secret fails closed before sending requests', async () => {
  let requests = 0;
  await assert.rejects(checkStagingHttp({
    origin: staging, monitorToken: 'short',
    fetcher: async () => { requests++; return new Response(); },
  }), /monitor token/);
  assert.equal(requests, 0);
});
