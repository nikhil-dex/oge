import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  standaloneCapturePath, validatedStandaloneCapture,
} from '../lib/oge-vault-standalone-captures.js';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

test('M126 /airnotes renders original Oge panel instead of redirecting to Quick Capture', async () => {
  const layout = await read('../app/airnotes/layout.js');
  const page = await read('../app/airnotes/page.js');
  const panel = await read('../app/components/personal-quick-notes-panel.js');

  assert.match(layout, /standaloneNotesDestination\(account\)/);
  assert.match(layout, /destination !== '\/vault\/capture'/);
  assert.match(layout, /if \(destination && destination !== '\/vault\/capture'\) redirect\(destination\)/);
  assert.match(page, /<PersonalQuickNotesPanel fullPage apiPath=\{apiPath\}/);
  assert.match(page, /apiPath = '\/api\/personal-quick-notes'/);
  assert.match(page, /apiPath = '\/api\/vault\/airnotes'/);
  assert.match(page, /vaultCaptureAvailable\(account\)/);
  assert.match(page, /account\?\.notesStorage !== 'mongodb'/);
  assert.match(panel, /quick-notes-heading-row/);
  assert.match(panel, /Air<span>Notes\.<\/span>/);
  assert.match(panel, /airnote-library-card/);
  assert.match(panel, /airnote-edit-dialog/);
  assert.match(panel, /<SiteNavbar \/>/);
});

test('M126 AirNotes uses the SAME original create, read, update and delete UI with SHA in GitHub mode', async () => {
  const panel = await read('../app/components/personal-quick-notes-panel.js');
  assert.match(panel, /apiPath = '\/api\/personal-quick-notes'/);
  assert.match(panel, /fetch\(apiPath, \{ cache: 'no-store' \}\)/);
  assert.match(panel, /vaultBacked = apiPath === '\/api\/vault\/airnotes'/);
  assert.match(panel, /crypto\.randomUUID\(\)/);
  assert.match(panel, /id: pendingCreateId\.current/);
  assert.match(panel, /vaultBacked \? \{ sha: editingNote\.sha \} : \{\}/);
  assert.match(panel, /vaultBacked \? '&sha='/);
  assert.doesNotMatch(panel, /\/vault\/capture/);
});

test('M126 GitHub AirNotes API scopes access to signed owner and cannot write permanent MongoDB content', async () => {
  const route = await read('../app/api/vault/airnotes/route.js');
  const vaultLibrary = await read('../lib/oge-vault-standalone-captures.js');
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
    assert.match(route, new RegExp('export async function ' + method));
  assert.match(route, /await auth\(\)/);
  assert.match(route, /ownerMutationFilter\(identity\.ownerId, \{ sessionVersion: identity\.sessionVersion \}\)/);
  assert.match(route, /vaultCaptureAvailable\(user\)/);
  assert.match(route, /getVaultNoteClient\(db, identity, \{ readOnly \}\)/);
  assert.match(route, /listVaultStandaloneCaptures\(ctx\.client, 'airnotes'\)/);
  assert.match(route, /getVaultStandaloneCapture\(/);
  assert.match(route, /commitVaultStandaloneCapture\(ctx\.client/);
  assert.match(route, /withVaultOwnerDraftWrite\(ctx\.db, scope/);
  assert.doesNotMatch(route, /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)|insertOne\(|updateOne\(|deleteOne\(/);
  assert.match(vaultLibrary, /const updateRefPath = '\/git\/refs\/heads\/'/);
  assert.match(vaultLibrary, /await client\.call\(updateRefPath, \{ method: 'PATCH'/);
  assert.match(vaultLibrary, /const refPath = '\/git\/ref\/heads\/'/);
  assert.match(vaultLibrary, /path: 'airnotes\/'/);
});

test('M126 GitHub AirNote files retain Oge content, title and timestamps', () => {
  const id = randomUUID();
  const note = validatedStandaloneCapture('airnotes',
    { content: 'AirNote idea\nMore explanation' },
    { id, now: '2026-11-19T12:00:00.000Z' });
  assert.equal(standaloneCapturePath('airnotes', id), 'airnotes/' + id + '.json');
  assert.equal(note.id, id);
  assert.equal(note.title, 'AirNote idea');
  assert.equal(note.content, 'AirNote idea\nMore explanation');
  assert.equal(note.format, 'ogenotes-airnote');
  assert.equal(note.createdAt, note.updatedAt);
});
