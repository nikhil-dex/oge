import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const firstSha = 'a'.repeat(40);
const secondSha = 'b'.repeat(40);

async function floatingEditor(send) {
  const events = [];
  let save, startNew;
  const subjectSlug = randomUUID();
  const note = { value: 'Machine learning task' };
  const subjectSelect = { value: subjectSlug, addEventListener() {} };
  const noteNewCapture = { hidden: true, addEventListener(type, listener) {
    assert.equal(type, 'click');
    startNew = listener;
  } };
  const noteSave = {
    disabled: false,
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      save = listener;
    },
  };
  const ctx = {
    note, subjectSelect, noteSave, noteNewCapture,
    noteOpenSaved: { hidden: true },
    lastSavedVaultNoteId: null,
    vaultReady: true,
    savingCapture: false,
    pendingVaultCapture: null,
    pendingSavedUpdate: null,
    setStatus: (message, error) => events.push({ message, error }),
    createCaptureId: () => randomUUID(),
    send,
  };
  const src = await read('../extension/content.js');
  const from = src.indexOf('  function updateNoteButton() {');
  const to = src.indexOf('  const urlSave = ', from);
  assert.ok(from >= 0 && to > from);
  vm.runInNewContext(src.slice(from, to), ctx, { timeout: 2000 });
  return { ctx, note, subjectSelect, events,
    save: () => save(), startNew: () => startNew() };
}

test('M113 typing during Save updates the SAME GitHub Note on next Save', async () => {
  const seen = [];
  let acknowledge;
  const editor = await floatingEditor(async (action, payload) => {
    seen.push({ action, payload });
    if (action === 'CREATE_VAULT_NOTE')
      return new Promise((resolve) => { acknowledge = resolve; });
    if (action === 'UPDATE_VAULT_NOTE')
      return {
        destination: 'vault', confirmed: true,
        id: payload.captureId, sha: secondSha,
        title: 'Machine learning task', subject: 'AI',
      };
    throw Error('Unexpected extension action');
  });
  const first = editor.save();
  const originalId = seen[0].payload.captureId;
  editor.note.value = 'Machine learning task and read chapter two';
  acknowledge({ destination: 'vault', confirmed: true,
    id: originalId, sha: firstSha,
    title: 'Machine learning task', subject: 'AI' });
  await first;
  assert.equal(editor.note.value, 'Machine learning task and read chapter two');
  assert.equal(editor.ctx.pendingSavedUpdate.id, originalId);
  assert.equal(editor.ctx.pendingSavedUpdate.sha, firstSha);
  assert.match(editor.events.at(-1).message, /update the same Note/);

  await editor.save();
  assert.deepEqual(seen.map((call) => call.action),
    ['CREATE_VAULT_NOTE', 'UPDATE_VAULT_NOTE']);
  assert.equal(seen[1].payload.captureId, originalId);
  assert.equal(seen[1].payload.sha, firstSha);
  assert.equal(seen[1].payload.content, 'Machine learning task and read chapter two');
  assert.equal(editor.note.value, '');
  assert.equal(editor.ctx.pendingSavedUpdate, null);
  assert.equal(editor.ctx.lastSavedVaultNoteId, originalId);
  assert.equal(editor.ctx.noteOpenSaved.hidden, false);
});

test('M113 lost UPDATE response retains revision and retries same Note, never creates another', async () => {
  let attempts = 0;
  const calls = [];
  let resolveFirst;
  const editor = await floatingEditor(async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'CREATE_VAULT_NOTE')
      return new Promise((resolve) => { resolveFirst = resolve; });
    if (action === 'UPDATE_VAULT_NOTE') {
      attempts += 1;
      if (attempts === 1) throw Error('Connection interrupted');
      return { destination: 'vault', confirmed: true, id: payload.captureId,
        sha: secondSha, title: 'Machine learning task', subject: 'AI', alreadySaved: true };
    }
    throw Error('Unexpected action');
  });
  const initial = editor.save();
  const id = calls[0].payload.captureId;
  editor.note.value = 'Machine learning task with follow-up';
  resolveFirst({ destination: 'vault', confirmed: true,
    id, sha: firstSha, title: 'Machine learning task', subject: 'AI' });
  await initial;
  await editor.save();
  assert.equal(editor.note.value, 'Machine learning task with follow-up');
  assert.equal(editor.ctx.pendingSavedUpdate.id, id);
  assert.equal(editor.ctx.pendingSavedUpdate.sha, firstSha);
  await editor.save();
  assert.deepEqual(calls.map((call) => call.action),
    ['CREATE_VAULT_NOTE', 'UPDATE_VAULT_NOTE', 'UPDATE_VAULT_NOTE']);
  assert.equal(calls[1].payload.captureId, calls[2].payload.captureId);
  assert.equal(calls[1].payload.sha, calls[2].payload.sha);
  assert.equal(editor.note.value, '');
});

test('M113 changing subject after Save starts an independent new capture', async () => {
  const calls = [];
  let resolveFirst;
  const editor = await floatingEditor(async (action, payload) => {
    calls.push({ action, payload });
    if (calls.length === 1)
      return new Promise((resolve) => { resolveFirst = resolve; });
    return { destination: 'vault', confirmed: true,
      id: payload.captureId, sha: secondSha,
      title: 'New subject thought', subject: 'Other' };
  });
  const first = editor.save();
  const original = calls[0].payload.captureId;
  editor.subjectSelect.value = randomUUID();
  editor.note.value = 'New subject thought';
  resolveFirst({ destination: 'vault', confirmed: true,
    id: original, sha: firstSha, title: 'Machine learning task', subject: 'AI' });
  await first;
  await editor.save();
  assert.deepEqual(calls.map((x) => x.action), ['CREATE_VAULT_NOTE', 'CREATE_VAULT_NOTE']);
  assert.notEqual(calls[1].payload.captureId, original);
});

test('M113 API supports revision-aware updating and no permanent Mongo Note content', async () => {
  const api = await read('../app/api/extension/vault-note/route.js');
  const worker = await read('../extension/service-worker.js');
  assert.match(api, /export const PUT = \(request\) => saveExtensionNote\(request, true\)/);
  assert.match(api, /previous\.sha !== data\.sha\.toLowerCase\(\)/);
  assert.match(api, /action: 'update', id, sha: previous\.sha, note: updatedNote/);
  assert.match(api, /if \(matches\(previous\)\) return receipt\(previous, true\)/);
  assert.match(api, /if \(matches\(recovered\)\) return receipt\(recovered, true\)/);
  assert.match(api, /favorite: previous\.favorite, tags: previous\.tags/);
  assert.doesNotMatch(api, /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)|insertOne\(/);
  assert.match(worker, /'UPDATE_VAULT_NOTE'/);
  assert.match(worker, /method: updating \? 'PUT' : 'POST'/);
  assert.match(worker, /sha: data\.sha/);
});


test('M114 explicit separate-Note choice keeps text but uses a fresh GitHub Note ID', async () => {
  const calls = [];
  let finishFirst;
  const editor = await floatingEditor(async (action, payload) => {
    calls.push({ action, payload });
    if (calls.length === 1)
      return new Promise((resolve) => { finishFirst = resolve; });
    return {
      destination: 'vault', confirmed: true, id: payload.captureId,
      sha: secondSha, title: 'Independent thought', subject: 'AI',
    };
  });
  const saving = editor.save();
  const firstId = calls[0].payload.captureId;
  editor.note.value = 'Independent thought in the same subject';
  finishFirst({
    destination: 'vault', confirmed: true, id: firstId, sha: firstSha,
    title: 'Machine learning task', subject: 'AI',
  });
  await saving;
  assert.equal(editor.ctx.noteNewCapture.hidden, false);
  assert.match(editor.ctx.noteSave.textContent, /Update saved Note/);

  editor.startNew();
  assert.equal(editor.note.value, 'Independent thought in the same subject');
  assert.equal(editor.ctx.pendingSavedUpdate, null);
  assert.equal(editor.ctx.noteNewCapture.hidden, true);
  assert.match(editor.ctx.noteSave.textContent, /Save to selected subject/);
  assert.match(editor.events.at(-1).message, /earlier GitHub Note is unchanged/);

  await editor.save();
  assert.deepEqual(calls.map((c) => c.action),
    ['CREATE_VAULT_NOTE', 'CREATE_VAULT_NOTE']);
  assert.notEqual(calls[1].payload.captureId, firstId);
  assert.equal(calls[1].payload.subjectSlug, calls[0].payload.subjectSlug);
  assert.equal(calls[1].payload.content, 'Independent thought in the same subject');
  assert.equal(editor.note.value, '');
});

test('M114 cannot switch to a new Note while an update is in progress', async () => {
  let firstDone, updateDone;
  const calls = [];
  const editor = await floatingEditor(async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'CREATE_VAULT_NOTE')
      return new Promise((resolve) => { firstDone = resolve; });
    return new Promise((resolve) => { updateDone = resolve; });
  });
  const first = editor.save();
  editor.note.value = 'Updated version';
  firstDone({
    destination: 'vault', confirmed: true, id: calls[0].payload.captureId,
    sha: firstSha, title: 'Machine learning task', subject: 'AI',
  });
  await first;
  const originalId = editor.ctx.pendingSavedUpdate.id;
  const update = editor.save();
  editor.startNew();
  assert.equal(editor.ctx.pendingSavedUpdate.id, originalId);
  updateDone({
    destination: 'vault', confirmed: true, id: originalId,
    sha: secondSha, title: 'Updated version', subject: 'AI',
  });
  await update;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'UPDATE_VAULT_NOTE');
});

test('M114 separate Note option is visible only for the subject of unsaved edits', async () => {
  const calls = [];
  let done;
  const editor = await floatingEditor(async (action, payload) => {
    calls.push({ action, payload });
    return new Promise((resolve) => { done = resolve; });
  });
  const first = editor.save();
  editor.note.value = 'Unsaved edits to a saved Note';
  done({
    destination: 'vault', confirmed: true,
    id: calls[0].payload.captureId, sha: firstSha,
    title: 'Machine learning task', subject: 'AI',
  });
  await first;
  assert.equal(editor.ctx.noteNewCapture.hidden, false);
  const previous = editor.subjectSelect.value;
  editor.subjectSelect.value = randomUUID();
  editor.startNew(); // Explicit option remains safe even if subject changed.
  assert.equal(editor.ctx.pendingSavedUpdate, null);
  assert.equal(editor.note.value, 'Unsaved edits to a saved Note');
  editor.subjectSelect.value = previous;
  assert.equal(editor.ctx.noteNewCapture.hidden, true);
});
