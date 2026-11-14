import test from 'node:test';
import assert from 'node:assert/strict';
import { applySecurityHeaders } from '../lib/security-headers.js';

function response() {
  return new Response('ok');
}

test('security headers are applied to responses', () => {
  const result = applySecurityHeaders(response());
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(result.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(result.headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
});

test('CSP is report-only while compatibility is evaluated', () => {
  const result = applySecurityHeaders(response());
  const policy = result.headers.get('Content-Security-Policy-Report-Only');
  assert.ok(policy);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(result.headers.get('Content-Security-Policy'), null);
});

test('HSTS is only set for production responses', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.match(applySecurityHeaders(response()).headers.get('Strict-Transport-Security') || '', /max-age=31536000/);
    process.env.NODE_ENV = 'test';
    assert.equal(applySecurityHeaders(response()).headers.get('Strict-Transport-Security'), null);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('CSP reports are directed to the report collector without enforcement', () => {
  const policy = applySecurityHeaders(response()).headers.get('Content-Security-Policy-Report-Only');
  assert.match(policy, /report-uri \/api\/csp-report/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(policy, /connect-src[^;]*https:;/);
});

test('Next.js applies the shared security headers to all routes', async () => {
  const { default: nextConfig } = await import('../next.config.js');
  const rules = await nextConfig.headers();
  assert.deepEqual(rules.map((rule) => rule.source), ['/:path*']);
  const configured = new Map(rules[0].headers.map(({ key, value }) => [key, value]));
  const direct = applySecurityHeaders(response());
  for (const [key, value] of configured) assert.equal(direct.headers.get(key), value);
  assert.ok(configured.has('Content-Security-Policy-Report-Only'));
});

test('CSP report endpoint bypasses sign-in in proxy source', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.ok(source.includes("pathname === '/api/csp-report' && request.method === 'POST'"));
});

test('CSP enforcement requires an explicit opt-in and preserves the policy directives', () => {
  const previous = process.env.OGE_ENFORCE_CSP;
  try {
    delete process.env.OGE_ENFORCE_CSP;
    const report = applySecurityHeaders(response());
    const expected = report.headers.get('Content-Security-Policy-Report-Only');
    assert.ok(expected);

    process.env.OGE_ENFORCE_CSP = 'true';
    const enforced = applySecurityHeaders(response());
    assert.equal(enforced.headers.get('Content-Security-Policy'), expected);
    assert.equal(enforced.headers.get('Content-Security-Policy-Report-Only'), null);

    process.env.OGE_ENFORCE_CSP = 'false';
    const disabled = applySecurityHeaders(response());
    assert.equal(disabled.headers.get('Content-Security-Policy'), null);
    assert.equal(disabled.headers.get('Content-Security-Policy-Report-Only'), expected);
  } finally {
    if (previous === undefined) delete process.env.OGE_ENFORCE_CSP;
    else process.env.OGE_ENFORCE_CSP = previous;
  }
});
