import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('floating toolbelt is injected on websites and retains old Quick Note behavior', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.ok(manifest.content_scripts.some((script) =>
    script.js.includes('content.js') && script.matches.includes('https://*/*')));
  for (const phrase of ["'oge-floating-toolbelt-host'", "attachShadow({ mode: 'closed' })",
    'data-save-note', 'data-save-url', 'data-tool="links"', 'pointermove',
    "['keydown', 'keyup', 'keypress']", "send('CREATE_QUICK_NOTE'",
    "send('SAVE_CURRENT_TAB'", "send('GET_PROFILE_LINKS'", "send('VISIT_PROFILE_LINK'"]) {
    assert.ok(script.includes(phrase), phrase);
  }
  assert.match(script, /textarea maxlength="20000"/);
  assert.match(script, /shadow\.activeElement !== note/);
  assert.match(worker, /sender\.id !== chrome\.runtime\.id/);
  assert.match(worker, /sender\.tab\?\.id/);
  assert.match(worker, /chrome\.permissions\.contains/);
  assert.match(worker, /chrome\.storage\.local\.get\(\['baseUrl', 'token'\]\)/);
  assert.match(worker, /redirect: 'error'/);
  assert.match(worker, /'\/api\/extension\/quick-note'/);
  assert.match(worker, /'\/api\/extension\/save-link'/);
  assert.match(worker, /'\/api\/extension\/profile-links'/);
  assert.doesNotMatch(script, /chrome\.storage\.local/);
  assert.doesNotMatch(script, /Bearer /);
});

test('Quick Note extension API validates data, verifies token and scopes writes to owner', async () => {
  const route = await readFile(new URL('../app/api/extension/quick-note/route.js', import.meta.url), 'utf8');
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /pathname === '\/api\/extension\/quick-note'/);
  assert.match(route, /hashExtensionToken\(token\)/);
  assert.match(route, /extensionTokenExpiresAt: \{ \$gt: new Date\(\) \}/);
  assert.match(route, /withActiveOwnerMutation\(db, user\.googleSub/);
  assert.match(route, /ownerId: user\.googleSub/);
  assert.match(route, /extensionTokenHash: tokenHash/);
  assert.match(route, /normalizeQuickNoteContent\(data\.content\)/);
  assert.match(route, /MAX_QUICK_NOTE_LENGTH/);
  assert.match(route, /quickNoteTitle\(content\)/);
  assert.match(route, /readLimitedBody\(request, 32 \* 1024\)/);
  assert.match(route, /checkRateLimit/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function DELETE/);
});

test('new extension retains existing popup toolbelt and profile links', async () => {
  const popup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(popup, /id="toolSave"/);
  assert.match(popup, /id="toolLinks"/);
  assert.match(popup, /id="toolConnect"/);
});
