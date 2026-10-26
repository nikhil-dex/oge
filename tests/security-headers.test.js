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
