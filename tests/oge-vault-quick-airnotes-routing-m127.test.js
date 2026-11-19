import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  standaloneCapturePath, validatedStandaloneCapture,
} from '../lib/oge-vault-standalone-captures.js';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('M127 original Quick Notes and AirNotes pages never redirect connected Vault users to Quick Capture', async () => {
  for (const kind of ['quick-notes', 'airnotes']) {
    const layout = await read('../app/' + kind + '/layout.js');
    const page = await read('../app/' + kind + '/page.js');
    assert.match(layout, /destination !== '\/vault\/capture'/);
    assert.match(page, /vaultCaptureAvailable\(account\)/);
    assert.match(page, /notesStorage !== 'mongodb'/);
    assert.match(page, new RegExp('/api/vault/' + kind));
    assert.match(page, new RegExp('/api/' + (kind === 'airnotes'
      ? 'personal-quick-notes' : 'quick-notes')));
  }
  const air = await read('../app/airnotes/page.js');
  const quick = await read('../app/quick-notes/page.js');
  assert.match(air, /<PersonalQuickNotesPanel fullPage apiPath=\{apiPath\}/);
  assert.match(quick, /<QuickNotesClient apiPath=\{apiPath\}/);
});

test('M127 both GitHub-backed APIs use signed owner and separate private file directories', async () => {
  const air = await read('../app/api/vault/airnotes/route.js');
  const quick = await read('../app/api/vault/quick-notes/route.js');
  for (const [kind, route] of [['airnotes', air], ['quick-notes', quick]]) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
      assert.match(route, new RegExp('export async function ' + method));
    assert.match(route, /await auth\(\)/);
    assert.match(route, /ownerMutationFilter\(identity\.ownerId, \{ sessionVersion: identity\.sessionVersion \}\)/);
    assert.match(route, /vaultCaptureAvailable\(user\)/);
    assert.match(route, /getVaultNoteClient\(db, identity, \{ readOnly \}\)/);
    assert.match(route, new RegExp("listVaultStandaloneCaptures\\(ctx\\.client, '" + kind + "'\\)"));
    assert.match(route, new RegExp("kind: '" + kind + "'"));
    assert.match(route, /withVaultOwnerDraftWrite/);
    assert.match(route, /sha: sha \|\| null/);
    assert.doesNotMatch(route, /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)|insertOne\(|updateOne\(|deleteOne\(/);
  }
  const id = randomUUID();
  assert.equal(standaloneCapturePath('airnotes', id), 'airnotes/' + id + '.json');
  assert.equal(standaloneCapturePath('quick-notes', id), 'quick-notes/' + id + '.json');
  const item = validatedStandaloneCapture('quick-notes', { content: 'Heading\nBody' }, {
    id, now: '2026-11-19T12:00:00.000Z',
  });
  assert.equal(item.title, 'Heading');
  assert.equal(item.content, 'Heading\nBody');
});

test('M127 original Quick Notes homepage widget follows selected storage without legacy MongoDB warning', async () => {
  const home = await read('../app/page.js');
  const panel = await read('../app/components/quick-notes-panel.js');
  assert.match(home, /const quickNotesApi = account\.notesStorage === 'github'/);
  assert.match(home, /<QuickNotesPanel apiPath=\{quickNotesApi\}/);
  assert.match(panel, /apiPath = '\/api\/quick-notes'/);
  assert.match(panel, /vaultBacked = apiPath === '\/api\/vault\/quick-notes'/);
  assert.match(panel, /fetch\(apiPath, \{ cache: 'no-store' \}\)/);
  assert.match(panel, /vaultBacked \? '&sha='/);
  assert.match(panel, /method: 'DELETE'/);
  assert.doesNotMatch(panel, /contentEditable|method: 'POST'|method: 'PUT'/);
});

test('M127 original Quick Notes full-page editor keeps existing appearance and GitHub revision updates', async () => {
  const page = await read('../app/quick-notes/quick-notes-client.js');
  assert.match(page, /oge-notes-workspace oge-quick-workspace/);
  assert.match(page, /LIGHTWEIGHT CAPTURE/);
  assert.match(page, /<h1>Quick <span>Notes\.<\/span><\/h1>/);
  assert.match(page, /apiPath = '\/api\/quick-notes'/);
  assert.match(page, /apiPath === '\/api\/vault\/quick-notes'/);
  assert.match(page, /readOnly rows=\{12\}/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /selected\.sha \|\| ''/);
  assert.doesNotMatch(page, /<form onSubmit|pendingCreateId|method: 'POST'|method: 'PUT'/);
  assert.doesNotMatch(page, /\/vault\/capture|Open your GitHub-backed Notes instead/);
});

test('M127 AirNotes autosave advances SHA after GitHub Save and avoids simultaneous writes', async () => {
  const panel = await read('../app/components/personal-quick-notes-panel.js');
  assert.match(panel, /apiPath = '\/api\/personal-quick-notes'/);
  assert.match(panel, /noteRevisionsRef\.current\.set\(id, result\.sha\)/);
  assert.match(panel, /inFlightRef\.current\.has\(id\)/);
  assert.match(panel, /saveCycle/);
  assert.match(panel, /vaultBacked \? \{ sha: editingNote\.sha \}/);
  const guard = await read('../lib/oge-vault-cutover-guard.js');
  assert.match(guard, /Your Notes storage is GitHub Vault\. Open your GitHub-backed Notes instead\./);
  // Keeping the old endpoint blocked is intentional: requests to the new
  // GitHub-backed endpoints avoid it; no old MongoDB content write fallback.
});
