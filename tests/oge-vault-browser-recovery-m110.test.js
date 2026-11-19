import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  vaultCaptureFields, resolveBrowserOnlyCapture, captureMatchesCommittedNote,
} from '../lib/oge-vault-quick-capture.js';

const subjectId = randomUUID();
const pointer = randomUUID();
const newId = randomUUID();

function savedNote(text = 'Study graph theory', id = pointer, subject = subjectId) {
  const fields = vaultCaptureFields(text, subject);
  return { id, subjectSlug: subject, heading: fields.heading, answer: fields.answer,
    sha: 'a'.repeat(40) };
}

test('M110 browser-only note with confirmed absent GitHub UUID can resume under original ID', () => {
  const original = 'Need to check this later';
  const recovered = resolveBrowserOnlyCapture({
    pointer, subjectId, text: original, verifiedMissing: true, newId,
  });
  assert.deepEqual(recovered, { noteId: pointer, text: original, alreadySaved: false,
    reuseId: true });
  assert.equal(vaultCaptureFields(recovered.text, subjectId).answer, original);
});

test('M110 previously committed exact same note does not silently get saved a second time', () => {
  const text = 'Study graph theory';
  const existing = savedNote(text);
  assert.equal(captureMatchesCommittedNote(text, subjectId, pointer, existing), true);
  const recovered = resolveBrowserOnlyCapture({ pointer, subjectId, text, saved: existing, newId });
  assert.deepEqual(recovered, { noteId: newId, text: '', alreadySaved: true, reuseId: false });
});

test('M110 local edits newer than a committed GitHub Note remain writable as a separate note', () => {
  const existing = savedNote('Study graph theory');
  const local = 'Study graph theory and revise formulas';
  const recovered = resolveBrowserOnlyCapture({
    pointer, subjectId, text: local, saved: existing, newId,
  });
  assert.equal(recovered.noteId, newId);
  assert.equal(recovered.text, local);
  assert.equal(recovered.alreadySaved, false);
  assert.equal(captureMatchesCommittedNote(local, subjectId, pointer, existing), false);
});

test('M110 offline or inconclusive GitHub check does not discard local copy or reuse unknown UUID', () => {
  const text = 'Unfinished offline thought';
  const recovered = resolveBrowserOnlyCapture({ pointer, subjectId, text, newId });
  assert.deepEqual(recovered, { noteId: newId, text, alreadySaved: false, reuseId: false });
  assert.equal(vaultCaptureFields(recovered.text, subjectId).heading, text);
});

test('M110 never confuses another saved subject or UUID with the local capture', () => {
  const text = 'Remember these steps';
  assert.equal(captureMatchesCommittedNote(text, subjectId, pointer,
    savedNote(text, randomUUID())), false);
  assert.equal(captureMatchesCommittedNote(text, subjectId, pointer,
    savedNote(text, pointer, randomUUID())), false);
  for (const existing of [savedNote(text, randomUUID()),
    savedNote(text, pointer, randomUUID())]) {
    const recovered = resolveBrowserOnlyCapture({
      pointer, subjectId, text, saved: existing, verifiedMissing: false, newId,
    });
    assert.equal(recovered.alreadySaved, false);
    assert.equal(recovered.text, text);
  }
});

test('M110 handles partial text without requiring immediate valid GitHub Note fields', () => {
  const text = 'Working draft…\n\n';
  const recovered = resolveBrowserOnlyCapture({ pointer, subjectId, text, newId });
  assert.equal(recovered.text, text);
  assert.equal(recovered.noteId, newId);
});

test('M110 rejects empty, overlong, reused and malformed recovery keys', () => {
  for (const props of [
    { pointer: '', subjectId, text: 'hi', newId },
    { pointer, subjectId: 'bad', text: 'hi', newId },
    { pointer, subjectId, text: '', newId },
    { pointer, subjectId, text: ' '.repeat(10), newId },
    { pointer, subjectId, text: 'a'.repeat(20001), newId },
    { pointer, subjectId, text: 'hi', newId: pointer },
    { pointer, subjectId, text: 'hi', newId: 'invalid' },
  ]) assert.throws(() => resolveBrowserOnlyCapture(props), TypeError);
});

test('M110 authenticated Notes read-one endpoint and recovery UI connect to real existing APIs', async () => {
  const route = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../app/vault/capture/vault-quick-capture-client.js', import.meta.url), 'utf8');
  assert.match(route, /const ctx = await context\(\)/);
  assert.match(route, /if \(params\.has\('id'\)\)/);
  assert.match(route, /legacyVaultNote\(await readVaultNote\(ctx\.client, id\.toLowerCase\(\)\)\)/);
  assert.match(ui, /fetch\('\/api\/vault\/notes-main\?id=' \+ encodeURIComponent\(pointer\)/);
  assert.match(ui, /resolveBrowserOnlyCapture\(\{/);
  assert.match(ui, /setContent\(recovery\.text\)/);
  assert.match(ui, /if \(recovery\.alreadySaved\)/);
  assert.doesNotMatch(route, /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)/);
});
