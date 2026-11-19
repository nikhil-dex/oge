import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  standaloneCapturePath, validatedStandaloneCapture,
} from '../lib/oge-vault-standalone-captures.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('M128 app Quick Notes page and home widget are read/delete-only in both storage modes', async () => {
  const page = await read('../app/quick-notes/quick-notes-client.js');
  const panel = await read('../app/components/quick-notes-panel.js');
  const home = await read('../app/page.js');
  assert.match(home, /<QuickNotesPanel apiPath=\{quickNotesApi\}/);
  for (const source of [page, panel]) {
    assert.match(source, /fetch\(apiPath, \{ cache: 'no-store' \}\)/);
    assert.match(source, /method: 'DELETE'/);
    assert.match(source, /vaultBacked \? '&sha='/);
    assert.doesNotMatch(source, /contentEditable|method: 'PUT'|method: 'POST'/);
    assert.doesNotMatch(source, /onClick=\{addNote\}|onClick=\{newNote\}|<form onSubmit/);
  }
  assert.match(page, /readOnly rows=\{12\}/);
  assert.match(panel, /Your notes saved from the browser extension/);
});

test('M128 website Quick Notes POST and PUT explicitly reject creating or editing', async () => {
  for (const path of ['../app/api/quick-notes/route.js',
    '../app/api/vault/quick-notes/route.js']) {
    const api = await read(path);
    assert.match(api, /const WEB_QUICK_NOTE_WRITES_ALLOWED = false/);
    assert.match(api, /if \(!WEB_QUICK_NOTE_WRITES_ALLOWED\)/);
    assert.match(api, /Save new Quick Notes using the Oge browser extension/);
    assert.match(api, /Quick Notes are read-only in the app/);
    assert.match(api, /405/);
    assert.match(api, /export async function GET/);
    assert.match(api, /export async function DELETE/);
  }
});

test('M128 Chrome extension default saves to separate Quick Notes, selected subject to Notes', async () => {
  const widget = await read('../extension/content.js');
  const worker = await read('../extension/service-worker.js');
  const endpoint = await read('../app/api/extension/vault-quick-note/route.js');
  const proxy = await read('../proxy.js');

  assert.match(widget, /quick\.textContent = 'Quick Notes \(default\)'/);
  assert.match(widget, /subjectSelect\.value = ''/);
  assert.match(widget, /if \(!submittedSubject\) \{/);
  assert.match(widget, /send\('CREATE_VAULT_QUICK_NOTE'/);
  assert.match(widget, /send\('CREATE_VAULT_NOTE'/);
  assert.match(widget, /send\('CREATE_QUICK_NOTE'/);
  assert.match(worker, /'CREATE_VAULT_QUICK_NOTE'/);
  assert.match(worker, /apiRequest\('\/api\/extension\/vault-quick-note'/);
  assert.match(worker, /data\.destination !== 'quick-notes'/);
  assert.match(proxy, /pathname === '\/api\/extension\/vault-quick-note'/);
  assert.match(endpoint, /extensionTokenHash: tokenHash/);
  assert.match(endpoint, /extensionTokenExpiresAt: \{ \$gt: new Date\(\) \}/);
  assert.match(endpoint, /vaultCaptureAvailable\(owner\)/);
  assert.match(endpoint, /getVaultNoteClient\(db, \{/);
  assert.match(endpoint, /commitVaultStandaloneCapture\(client, \{/);
  assert.match(endpoint, /kind: 'quick-notes', action: 'create'/);
  assert.match(endpoint, /withVaultOwnerDraftWrite\(db, scope/);
  assert.match(endpoint, /getVaultStandaloneCapture\(client, 'quick-notes', captureId\)/);
  assert.match(endpoint, /existing\.content === content|current\.content === content|verified\?\.content === content/);
  assert.doesNotMatch(endpoint, /collection\('quickNotes'\)|insertOne\(|updateOne\(/);
});

test('M128 Quick Notes files use private GitHub typed path and stable UUID', () => {
  const id = randomUUID();
  assert.equal(standaloneCapturePath('quick-notes', id), 'quick-notes/' + id + '.json');
  const note = validatedStandaloneCapture('quick-notes',
    { content: 'Saved in the extension\nBody' },
    { id, now: '2026-11-19T12:00:00.000Z' });
  assert.equal(note.id, id);
  assert.equal(note.title, 'Saved in the extension');
  assert.equal(note.content, 'Saved in the extension\nBody');
});

test('M128 AirNotes delete is visible in cards, reader and edit dialog', async () => {
  const panel = await read('../app/components/personal-quick-notes-panel.js');
  assert.match(panel, /aria-label=\{'Delete AirNote: ' \+ title\} title="Delete AirNote">Delete/);
  assert.match(panel, /onClick=\{\(\) => deleteNote\(openedNote\)\}/);
  assert.match(panel, /onClick=\{\(\) => deleteNote\(editingNote\)\}/);
  assert.match(panel, /window\.confirm\('Delete "' \+ titleOf\(note\.content\)/);
  assert.match(panel, /setOpenedNote\(null\)/);
  assert.match(panel, /setEditingNote\(null\)/);
  assert.match(panel, /method: 'DELETE'/);
  assert.match(panel, /vaultBacked \? '&sha='/);
});

test('M128 live extension widget handler defaults GitHub Save to Quick Notes and retries the same UUID', async () => {
  const { default: vm } = await import('node:vm');
  const { randomUUID: uuid } = await import('node:crypto');
  const source = await read('../extension/content.js');
  const from = source.indexOf('  function updateNoteButton() {');
  const to = source.indexOf('  const urlSave = ', from);
  assert.ok(from > 0 && to > from);

  const calls = [], statuses = [];
  let attempt = 0, saveHandler;
  const note = { value: 'Captured from the extension' };
  const noteSave = {
    disabled: false, addEventListener(type, fn) {
      if (type === 'click') saveHandler = fn;
    },
  };
  const ctx = {
    note, noteSave, noteNewCapture: { hidden: true, addEventListener() {} },
    noteOpenSaved: { hidden: true },
    subjectSelect: { value: '', addEventListener() {} },
    vaultReady: true,
    pendingSavedUpdate: null, pendingVaultCapture: null,
    savingCapture: false, lastSavedVaultNoteId: null,
    createCaptureId: uuid,
    setStatus: (...message) => statuses.push(message),
    async send(action, payload) {
      calls.push({ action, payload });
      if (action !== 'CREATE_VAULT_QUICK_NOTE') throw new Error('wrong destination');
      if (++attempt === 1) throw new Error('Request interrupted');
      return { destination: 'quick-notes', confirmed: true,
        id: payload.captureId, sha: 'a'.repeat(40), title: 'Captured from the extension' };
    },
  };
  vm.runInNewContext(source.slice(from, to), ctx, { timeout: 2000 });
  await saveHandler();
  assert.equal(noteSave.textContent, 'Save to Quick Notes');
  assert.equal(note.value, 'Captured from the extension');
  await saveHandler();
  assert.equal(note.value, '');
  assert.deepEqual(calls.map(x => x.action),
    ['CREATE_VAULT_QUICK_NOTE', 'CREATE_VAULT_QUICK_NOTE']);
  assert.equal(calls[0].payload.captureId, calls[1].payload.captureId);
  assert.equal(ctx.pendingVaultCapture, null);
  assert.equal(ctx.noteOpenSaved.hidden, true);
  assert.match(statuses.at(-1)[0], /to Quick Notes/);
});
