import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vaultConfigured } from '../lib/oge-vault-github.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('M119 Settings directly offers a discoverable GitHub Vault setup action', async () => {
  const src = await read('../app/settings/page.js');
  assert.match(src, /id="vault-connection"/);
  assert.match(src, /href="#vault-connection"/);
  assert.match(src, /href="\/vault"/);
  assert.match(src, /Set up GitHub Vault/);
  assert.match(src, /Manage my connected GitHub Vault/);
  assert.match(src, /newsInterests: 1, notesStorage: 1, vault: 1/);
  assert.match(src, /vaultConfigured\(\)/);
});

test('M119 Vault connection screen provides real, actionable install and OAuth buttons', async () => {
  const src = await read('../app/vault/page.js');
  assert.match(src, /href=\{installUrl\}/);
  assert.match(src, /Install the GitHub App/);
  assert.match(src, /<form action="\/api\/vault\/start" method="POST">/);
  assert.match(src, /type="submit">Connect GitHub &amp; create my Vault/);
  assert.match(src, /configured \? \(/);
  assert.match(src, /server setup required/);
  assert.match(src, /disabled aria-disabled="true"/);
  assert.match(src, /GitHub App configuration guide/);
  assert.match(src, /Your private Vault is created automatically/);
  assert.match(src, /role="alert"/);
  assert.match(src, /user\.vault\?\.status === 'connected'/);
  assert.doesNotMatch(src, /href="https:\/\/github\.com\/apps\/your_app_name/);
});

test('M119 Connect action is backed by signed GitHub authorization, not an inert button', async () => {
  const src = await read('../app/api/vault/start/route.js');
  assert.match(src, /export async function POST\(\)/);
  assert.match(src, /const session = await auth\(\)/);
  assert.match(src, /if \(!vaultConfigured\(\)\)/);
  assert.match(src, /beginVaultAuthorization\(db,/);
  assert.match(src, /https:\/\/github\.com\/login\/oauth\/authorize/);
  assert.match(src, /NextResponse\.redirect\(url, 303\)/);
  const callback = await read('../app/api/vault/callback/route.js');
  assert.match(callback, /const connection = await provisionVault\(token/);
  assert.match(callback, /connectProvisionedVault\(db/);
});

test('M119 server readiness is based on real integration settings, never login alone', () => {
  assert.equal(vaultConfigured({}), false);
  const env = {
    OGE_VAULT_GITHUB_CLIENT_ID: 'client',
    OGE_VAULT_GITHUB_CLIENT_SECRET: 'secret',
    OGE_VAULT_GITHUB_APP_ID: '123',
    OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: 'key',
    OGE_VAULT_BASE_URL: 'http://localhost:3000/',
  };
  assert.equal(vaultConfigured(env), true);
  for (const name of Object.keys(env)) {
    assert.equal(vaultConfigured({ ...env, [name]: '' }), false, name);
  }
});
