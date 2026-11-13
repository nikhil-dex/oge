import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/csp-report/route.js';

function reportRequest(body, contentType = 'application/csp-report') {
  return new Request('https://example.test/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

test('CSP collector accepts violation reports and logs only sanitized directives', async () => {
  const original = console.warn;
  const messages = [];
  console.warn = (...values) => messages.push(values);
  try {
    const response = await POST(reportRequest(JSON.stringify({
      'csp-report': {
        'effective-directive': 'script-src-elem',
        'document-uri': 'https://example.test/private/secret',
        'blocked-uri': 'https://example.test/private/token',
      },
    })));
    assert.equal(response.status, 204);
    assert.deepEqual(messages, [['CSP report-only violation', { directive: 'script-src-elem' }]]);
  } finally {
    console.warn = original;
  }
});

test('CSP collector rejects unsupported or invalid reports', async () => {
  assert.equal((await POST(reportRequest('{}', 'text/plain'))).status, 415);
  assert.equal((await POST(reportRequest('{bad json'))).status, 400);
  assert.equal((await POST(reportRequest('x'.repeat(8193)))).status, 413);
});

test('CSP report logging is bounded under repeated anonymous requests', async () => {
  const original = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await POST(reportRequest(JSON.stringify({
        'csp-report': { 'effective-directive': 'script-src-elem' },
      })));
      assert.equal(response.status, 204);
    }
    assert.ok(warnings <= 20, 'CSP report endpoint must throttle its warning log volume');
  } finally {
    console.warn = original;
  }
});
