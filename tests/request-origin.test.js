import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest, requiresSameOriginCheck } from '../lib/request-origin.js';

function request({ url = 'https://oge.example/api/notes', method = 'POST', origin, referer } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set('origin', origin);
  if (referer !== undefined) headers.set('referer', referer);
  return { url, method, headers };
}

test('same-origin guard accepts same-origin Origin and Referer headers', () => {
  assert.equal(isSameOriginRequest(request({ origin: 'https://oge.example' })), true);
  assert.equal(isSameOriginRequest(request({ origin: 'https://oge.example:443' })), true);
  assert.equal(isSameOriginRequest(request({ origin: undefined, referer: 'https://oge.example/settings' })), true);
});

test('same-origin guard rejects cross-origin, null, malformed, and missing provenance', () => {
  assert.equal(isSameOriginRequest(request({ origin: 'https://attacker.example' })), false);
  assert.equal(isSameOriginRequest(request({ origin: 'null' })), false);
  assert.equal(isSameOriginRequest(request({ origin: 'not a url' })), false);
  assert.equal(isSameOriginRequest(request()), false);
});

test('guard covers cookie-authenticated API mutations but exempts reads and extension bearer saves', () => {
  assert.equal(requiresSameOriginCheck(request({ method: 'POST' })), true);
  assert.equal(requiresSameOriginCheck(request({ method: 'PATCH' })), true);
  assert.equal(requiresSameOriginCheck(request({ method: 'DELETE' })), true);
  assert.equal(requiresSameOriginCheck(request({ method: 'GET' })), false);
  assert.equal(requiresSameOriginCheck(request({ url: 'https://oge.example/api/auth/signout' })), false);
  assert.equal(requiresSameOriginCheck(request({ url: 'https://oge.example/api/extension/save-link' })), false);
});

test('proxy applies the origin guard before allowing state-changing API requests', async () => {
  const { readFile } = await import('node:fs/promises');
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /requiresSameOriginCheck\(request\) && !isSameOriginRequest\(request\)/);
  assert.match(proxy, /Cross-origin request blocked/);
});
