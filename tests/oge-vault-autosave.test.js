import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  vaultDraftKey, readVaultDraft, writeVaultDraft, clearVaultDraft,
  notesMatch, createVaultAutosave,
} from '../lib/oge-vault-autosave.js';

const subjectId = randomUUID();
const id = randomUUID();
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const base = (sha = null) => ({ id, subjectId, heading: 'Title', answer: 'Content',
  tags: [], favorite: false, sha });

function fixture({ online = true, initial = base(), save, remote } = {}) {
  const records = new Map();
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, value); },
    removeItem(key) { records.delete(key); },
  };
  let currentOnline = online;
  let ticks = [];
  const states = [];
  const key = vaultDraftKey('github:999', 74, id);
  const batchCalls = [];
  const batch = async (ops) => {
    batchCalls.push(ops);
    return save ? save(ops) : { results: [{ ...ops[0].note, id, sha: SHA_A }] };
  };
  const read = remote || (async () => {
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  const controls = createVaultAutosave({
    storage, key, initial, batch, read,
    debounceMs: 100, setTimer: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; },
    clearTimer: () => {}, onState: (state) => states.push(state),
    isOnline: () => currentOnline,
  });
  return { controls, states, storage, records, batchCalls, key,
    setOnline(v) { currentOnline = v; },
    async tick() { const item = ticks.shift(); if (item) return item.fn(); },
    get scheduled() { return ticks; },
  };
}

test('draft storage scopes to account and repo, validates content and expires after 24 hours', () => {
  const f = fixture();
  writeVaultDraft(f.storage, f.key, base(), 1_000_000);
  assert.deepEqual(readVaultDraft(f.storage, f.key, 1_000_001), base());
  assert.equal(readVaultDraft(f.storage, f.key, 1_000_000 + 86_400_001), null);
  assert.notEqual(vaultDraftKey('github:999', 74, id), vaultDraftKey('github:1000', 74, id));
  assert.throws(() => vaultDraftKey('github:999', 74, '../../private'), TypeError);
  assert.throws(() => writeVaultDraft(f.storage, f.key, { ...base(), answer: 'x'.repeat(20001) }), TypeError);
  clearVaultDraft(f.storage, f.key);
  assert.equal(f.records.size, 0);
});

test('debounced autosave confirms GitHub persistence and clears recovered draft', async () => {
  const f = fixture();
  assert.equal(f.controls.edit({ answer: 'Updated' }).status, 'pending');
  assert.equal(f.scheduled[0].ms, 100);
  assert.equal(readVaultDraft(f.storage, f.key).answer, 'Updated');
  await f.controls.flush();
  assert.equal(f.batchCalls.length, 1);
  assert.equal(f.batchCalls[0][0].action, 'create');
  assert.equal(f.controls.getState().status, 'synced');
  assert.equal(f.records.size, 0);
  assert.equal(f.controls.getState().draft.sha, SHA_A);
  f.controls.stop();
});

test('offline changes never call GitHub and survive refresh until explicit retry', async () => {
  const f = fixture({ online: false });
  f.controls.edit({ answer: 'Offline edit' });
  assert.equal(f.controls.getState().status, 'offline');
  await f.controls.flush();
  assert.equal(f.batchCalls.length, 0);
  const previous = fixture({ online: true });
  // Simulate reload of the same browser session.
  previous.storage.setItem(previous.key, f.storage.getItem(f.key));
  previous.controls.restore();
  assert.equal(previous.controls.getState().status, 'recovered');
  assert.equal(previous.controls.getState().draft.answer, 'Offline edit');
  previous.controls.retryNow();
  await previous.controls.flush();
  assert.equal(previous.controls.getState().status, 'synced');
});

test('uncertain GitHub response reconciles an already persisted note without duplicate create', async () => {
  const persisted = { ...base(), answer: 'Updated', sha: SHA_A };
  const f = fixture({ save: async () => { throw Object.assign(new Error('timeout'), { status: 503 }); },
    remote: async () => persisted });
  f.controls.edit({ answer: 'Updated' });
  await f.controls.flush();
  assert.equal(f.controls.getState().status, 'synced');
  assert.equal(f.controls.getState().draft.sha, SHA_A);
  assert.equal(f.batchCalls.length, 1);
});

test('a remote update creates an explicit conflict instead of overwriting content', async () => {
  const remote = { ...base(SHA_B), answer: 'Another device wrote this' };
  const f = fixture({ initial: base(SHA_A),
    save: async () => { throw Object.assign(new Error('409'), { status: 409 }); },
    remote: async () => remote });
  f.controls.edit({ answer: 'My local edit' });
  await f.controls.flush();
  assert.equal(f.controls.getState().status, 'conflict');
  assert.equal(f.controls.getState().draft.answer, 'My local edit');
  assert.equal(readVaultDraft(f.storage, f.key).answer, 'My local edit');
  f.controls.discardConflict(remote);
  assert.equal(f.controls.getState().status, 'synced');
  assert.equal(f.controls.getState().draft.answer, remote.answer);
});

test('temporarily failed GitHub saves retry with increasing backoff, without false success', async () => {
  const f = fixture({ save: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); } });
  f.controls.edit({ answer: 'Pending' });
  await f.controls.flush();
  assert.equal(f.controls.getState().status, 'retrying');
  assert.equal(f.scheduled.at(-1).ms, 1000);
  await f.controls.flush();
  assert.equal(f.scheduled.at(-1).ms, 2000);
  assert.equal(readVaultDraft(f.storage, f.key).answer, 'Pending');
});

test('a second edit during an in-flight save is not discarded', async () => {
  let resolveSave;
  const waiting = new Promise((resolve) => { resolveSave = resolve; });
  const f = fixture({ save: async () => waiting });
  f.controls.edit({ answer: 'First' });
  const pending = f.controls.flush();
  f.controls.edit({ answer: 'Second' });
  resolveSave({ results: [{ ...base(SHA_A), answer: 'First' }] });
  await pending;
  assert.equal(f.controls.getState().draft.answer, 'Second');
  assert.equal(f.controls.getState().status, 'pending');
  assert.equal(readVaultDraft(f.storage, f.key).answer, 'Second');
  assert.equal(f.controls.getState().draft.sha, SHA_A);
});

test('a stored recovery draft is not treated as remotely saved content', () => {
  assert.equal(notesMatch({ ...base(SHA_A) }, base()), true);
  assert.equal(notesMatch({ ...base(SHA_A), answer: 'Different' }, base()), false);
});

test('incomplete new notes stay in the tab and are not sent to GitHub', async () => {
  const f = fixture({ initial: { ...base(), heading: '', answer: '' } });
  assert.equal(f.controls.getState().status, 'new');
  f.controls.edit({ heading: 'A title' });
  await f.controls.flush();
  assert.equal(f.batchCalls.length, 0);
  assert.equal(f.controls.getState().status, 'incomplete');
  f.controls.edit({ answer: 'A body' });
  await f.controls.flush();
  assert.equal(f.batchCalls.length, 1);
  assert.equal(f.controls.getState().status, 'synced');
});

test('remote deleted note produces explicit conflict without erasing draft', async () => {
  const f = fixture({ initial: base(SHA_A),
    save: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); },
    remote: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } });
  f.controls.edit({ answer: 'My important content' });
  await f.controls.flush();
  const state = f.controls.getState();
  assert.equal(state.status, 'conflict');
  assert.equal(state.conflict.deleted, true);
  assert.equal(state.draft.answer, 'My important content');
  assert.throws(() => f.controls.discardConflict(), TypeError);
  assert.equal(readVaultDraft(f.storage, f.key).answer, 'My important content');
});
