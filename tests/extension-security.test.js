import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Extension token is hashed server-side and expires', async () => {
  const tokenRoute = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../lib/extension-token.js', import.meta.url), 'utf8');
  assert.match(tokenRoute, /extensionTokenExpiresAt/);
  assert.match(tokenRoute, /hashExtensionToken\(token\)/);
  assert.match(helper, /createHash\('sha256'\)/);
});

test('Extension save endpoint uses bearer tokens and derives owner from stored token', async () => {
  const route = await readFile(new URL('../app/api/extension/save-link/route.js', import.meta.url), 'utf8');
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(route, /Bearer /);
  assert.match(route, /extensionTokenHash/);
  assert.match(route, /ownerId: user\.googleSub/);
  assert.match(proxy, /api\/extension\/save-link/);
});
