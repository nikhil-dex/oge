#!/usr/bin/env node
/**
 * Non-destructive staging auth and CSRF verification. Does not create,
 * modify, delete, export or log account data. Never run against production.
 *
 * Provide two authenticated cookies from different disposable Google accounts
 * to distinguish unauthorized requests from a broken staging deployment.
 */
const rawUrl = process.env.OGE_STAGING_URL;
const explicitHost = process.env.OGE_STAGING_HOST;
const cookieA = process.env.OGE_STAGING_COOKIE_A;
const cookieB = process.env.OGE_STAGING_COOKIE_B;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(rawUrl && explicitHost && cookieA && cookieB, 'Set staging URL, exact host, and two disposable test session cookies.');
expect(cookieA !== cookieB, 'Use two independent authenticated test sessions.');
const base = new URL(rawUrl);
expect(base.hostname === explicitHost && /(?:staging|preview|localhost|127\.0\.0\.1)/i.test(base.hostname),
  'Refusing a URL without an explicitly matching staging/preview/localhost hostname.');
expect(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)),
  'Require HTTPS except for local testing.');
expect(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
  'Provide only a plain staging origin (no URL credentials, paths or query strings).');

const endpoints = ['/api/subjects', '/api/notes', '/api/quick-notes',
  '/api/personal-quick-notes', '/api/saved-links', '/api/revision-history',
  '/api/backup', '/api/gemini-key', '/api/extension-token'];

async function request(path, { method = 'GET', cookie, origin, referer, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin !== undefined) headers.Origin = origin;
  if (referer !== undefined) headers.Referer = referer;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    type: response.headers.get('content-type') || '',
  };
}

// A valid session must be able to read an ordinary, owner-scoped collection.
// Avoid exporting backups and credentials as part of this check.
for (const cookie of [cookieA, cookieB]) {
  const allowed = await request('/api/subjects', { cookie });
  expect(allowed.status === 200, 'A staging browser session could not list its own subjects.');
}

// Authentication must be enforced consistently even for an expired/invalid cookie.
// Redirects to login are allowed; successful private responses are not.
const invalidCookies = [undefined, 'authjs.session-token=invalid-staging-session'];
for (const cookie of invalidCookies) {
  for (const path of endpoints) {
    const result = await request(path, { cookie });
    expect(result.status === 401 || result.status === 403 || (result.status >= 300 && result.status < 400),
      'Private API accepted a missing or invalid session: ' + path + ' (HTTP ' + result.status + ')');
  }
}

// This intentionally submits an invalid, non-creating payload to prevent
// any data mutation even if the origin guard malfunctions.
const invalidBody = { __oge_staging_csrf_probe: true };
const badOrigins = [
  { origin: 'https://attacker.invalid' },
  { origin: 'null' },
  { origin: 'not-a-url' },
  {}, // No Origin or Referer is not sufficient for state-changing cookie APIs.
  { referer: 'https://attacker.invalid/bait' },
];
for (const headers of badOrigins) {
  const result = await request('/api/subjects', {
    cookie: cookieA, method: 'POST', body: invalidBody, ...headers,
  });
  expect(result.status === 403,
    'Cross-origin mutation not blocked (HTTP ' + result.status + ').');
}

const goodOrigin = await request('/api/subjects', {
  cookie: cookieA, method: 'POST', origin: base.origin, body: invalidBody,
});
expect(goodOrigin.status === 400,
  'Same-origin request did not reach body validation; investigate session or middleware.');

const monitor = await request('/api/health');
expect(monitor.status === 401, 'Unauthenticated health endpoint exposed operational status.');

console.log('PASS: Staging auth, invalid sessions, cross-origin mutation and private monitor checks.');
console.log('No account records were intentionally changed or exported.');
