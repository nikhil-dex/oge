import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('profile links endpoint is token-scoped and read-only', async () => {
  const route = await readFile(new URL('../app/api/extension/profile-links/route.js', import.meta.url), 'utf8');
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(route, /export async function GET\(request\)/);
  assert.match(route, /hashExtensionToken\(token\)/);
  assert.match(route, /extensionTokenExpiresAt: \{ \$gt: new Date\(\) \}/);
  assert.match(route, /scope: 'extension-profile-links'/);
  assert.match(route, /projection: \{ socialLinks: 1 \}/);
  assert.match(route, /normalizeSocialLink\(kind,/);
  assert.match(route, /'Cache-Control': 'private, no-store'/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(proxy, /pathname === '\/api\/extension\/profile-links'/);
});

test('extension toolbelt preserves save tab and uses a read-only links panel', async () => {
  const popup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../extension/popup.css', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

  for (const id of ['toolSave', 'toolLinks', 'toolConnect', 'savePanel', 'linksPanel', 'connectPanel',
    'linksList', 'refreshLinks', 'saveTab', 'saveSettings']) {
    assert.match(popup, new RegExp('id="' + id + '"'));
  }
  assert.match(script, /fetch\(origin \+ '\/api\/extension\/profile-links'/);
  assert.match(script, /Authorization: 'Bearer ' \+ token/);
  assert.match(script, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(script, /chrome\.tabs\.create\(\{ url: safe\.href \}\)/);
  assert.match(script, /safe\.protocol !== 'https:'/);
  assert.match(script, /address\.textContent = url/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /fetch\(origin \+ '\/api\/extension\/save-link'/);
  assert.match(css, /\.toolbelt\{order:4/);
  assert.ok(manifest.permissions.includes('clipboardWrite'));
  assert.ok(manifest.permissions.includes('activeTab'));
});
