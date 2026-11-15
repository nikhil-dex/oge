import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const script = new URL('../scripts/verify-staging-authenticated-pages.mjs', import.meta.url);

async function runProbe(mode) {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (!['/notes', '/settings'].includes(req.url) || !['session-a', 'session-b'].includes(req.headers.cookie)) {
      res.writeHead(403); res.end(); return;
    }
    if (mode === 'redirect') {
      res.writeHead(307, { Location: '/register' }); res.end(); return;
    }
    const nonce = mode === 'reused' ? 'a'.repeat(32) : calls.toString(16).padStart(32, '0');
    const inlineNonce = mode === 'mismatch' ? 'b'.repeat(32) : nonce;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'",
      ...(mode === 'enforced' ? { 'Content-Security-Policy': "script-src 'self'" } : {}),
      'Cache-Control': mode === 'public-cache' ? 'public, max-age=60' : mode === 'shared-cache' ? 'private, s-maxage=600' : 'private, no-store',
    });
    res.end('<!doctype html><html><head><script nonce="' + inlineNonce + '">void 0;</script></head><body>test</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script.pathname], {
        env: {
          ...process.env,
          OGE_STAGING_URL: 'http://localhost:' + address.port,
          OGE_STAGING_HOST: 'localhost',
          OGE_STAGING_COOKIE_A: 'session-a',
          OGE_STAGING_COOKIE_B: 'session-b',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', s => { stdout += s; });
      child.stderr.on('data', s => { stderr += s; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    return { ...output, calls };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('authenticated staging CSP checker passes with distinct full-document nonces', async () => {
  const result = await runProbe('valid');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /authenticated staging HTML CSP checks completed/);
  assert.equal(result.calls, 6);
});

for (const mode of ['mismatch', 'reused', 'redirect', 'enforced', 'public-cache', 'shared-cache']) {
  test('authenticated staging CSP checker fails closed for ' + mode, async () => {
    const result = await runProbe(mode);
    assert.notEqual(result.code, 0, 'checker must fail for ' + mode);
    assert.match(result.stderr, /FAIL: authenticated staging HTML CSP check/);
    assert.doesNotMatch(result.stderr, /session-a|session-b/);
  });
}
