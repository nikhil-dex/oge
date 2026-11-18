import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  vaultCaptureFields, vaultCapturePointer, vaultCaptureLocalKey,
  VAULT_CAPTURE_MAX_CHARS,
} from '../lib/oge-vault-quick-capture.js';
import { validatedHybridDraft } from '../lib/oge-vault-hybrid-drafts.js';
import { validatedNote } from '../lib/oge-vault-notes.js';

const subject = randomUUID(), other = randomUUID();

test('M69 first line becomes GitHub note heading, rest is body and valid encrypted hybrid draft schema', () => {
  const draft = vaultCaptureFields('  Idea title  \r\n \r\nFirst paragraph\r\nSecond paragraph ', subject);
  assert.equal(draft.heading, 'Idea title');
  assert.equal(draft.answer, 'First paragraph\nSecond paragraph');
  assert.equal(draft.subjectId, subject);
  assert.equal(draft.favorite, false);
  assert.equal(draft.baseSha, null);
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(validatedHybridDraft(draft), draft);
  const note = validatedNote(draft);
  assert.equal(note.heading, draft.heading);
  assert.equal(note.answer, draft.answer);
  assert.equal(note.subjectId, subject);
  assert.equal(note.favorite, false);
  assert.ok(Object.isFrozen(draft));
});

test('M108 single-line quick thoughts and body-only captures save as real Notes', () => {
  for (const content of ['Buy bread', 'Buy bread\n', '\nBuy bread']) {
    const draft = vaultCaptureFields(content, subject);
    assert.equal(draft.heading, 'Buy bread');
    assert.equal(draft.answer, content.trim());
    assert.deepEqual(validatedHybridDraft(draft), draft);
    assert.equal(validatedNote(draft).answer, content.trim());
  }
  const longFirstLine = 'A'.repeat(161) + '\nMore thoughts';
  const draft = vaultCaptureFields(longFirstLine, subject);
  assert.equal(draft.heading, 'A'.repeat(80));
  assert.equal(draft.answer, longFirstLine);
  assert.equal(validatedNote(draft).answer, longFirstLine);
});

test('M69 capture refuses invalid subjects, empty text, or long content', () => {
  for (const input of [
    ['', subject], [' \n\t ', subject], ['\n\n', subject],
    ['Title\nAnswer', 'not-a-subject'], ['Title\nBody', ''],
    ['Title\nBody', undefined], [null, subject], [33, subject],
    ['Title\nBody'.repeat(5000), subject],
  ]) assert.throws(() => vaultCaptureFields(...input), TypeError);
  assert.equal(VAULT_CAPTURE_MAX_CHARS, 20_000);
  assert.deepEqual(vaultCaptureFields('Title\nBody', other).subjectId, other);
});

test('M69 new subject-specific browser pointers cannot alias another owner/repo/subject/note', () => {
  const owner = 'disposable-owner';
  const a = vaultCapturePointer(owner, 1, subject);
  const b = vaultCapturePointer(owner, 2, subject);
  const c = vaultCapturePointer('another-owner', 1, subject);
  const d = vaultCapturePointer(owner, 1, other);
  assert.equal(new Set([a,b,c,d]).size, 4);
  const content = vaultCaptureLocalKey(owner, 1, randomUUID());
  assert.doesNotMatch(content, /Title|Body/);
  for (const value of [
    () => vaultCapturePointer('', 1, subject),
    () => vaultCapturePointer(owner, -1, subject),
    () => vaultCapturePointer(owner, 1, 'wrong'),
    () => vaultCaptureLocalKey(owner, 1, 'wrong'),
  ]) assert.throws(value, TypeError);
});

test('M104 Quick Capture follows connected GitHub Notes and drafts without separate staging gate', async () => {
  const file = await readFile(new URL(
    '../app/vault/capture/page.js', import.meta.url), 'utf8');
  assert.match(file, /OGE_VAULT_MAIN_PREVIEW === 'true'/);
  assert.match(file, /OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.doesNotMatch(file, /OGE_VAULT_QUICK_CAPTURE_PREVIEW|oge_vault_restore_staging_|checkVaultStagingReadiness/);
  assert.match(file, /ownerMutationFilter\(session\.user\.id/);
  assert.match(file, /sessionVersion: session\.user\.sessionVersion/);
  assert.match(file, /user\?\.vault\?\.status !== 'connected'/);
  assert.match(file, /if \(!enabled\(\)\) notFound\(\)/);
  assert.match(file, /if \(!session\?\.user\?\.id\) redirect\('\/register'\)/);
  assert.doesNotMatch(file, /insertOne\(|updateOne\(|commitVaultNoteBatch|withActiveOwnerMutation/);
});

test('M69 client reuses existing temporary encrypted draft CAS and one explicit GitHub Save; no extension grants', async () => {
  const client = await readFile(new URL(
    '../app/vault/capture/vault-quick-capture-client.js', import.meta.url),
    'utf8');
  assert.match(client, /vaultCaptureFields\(content, subjectId\)/);
  assert.match(client, /async function createSubject\(event\)/);
  assert.match(client, /fetch\('\/api\/subjects', \{/);
  assert.match(client, /await choose\(created\.slug\)/);
  assert.match(client, /setNoteId\(crypto\.randomUUID\(\)\)/);
  assert.match(client, /!text\.trim\(\)/);
  assert.match(client, /Saved to GitHub\. Ready for your next note/);
  assert.match(client, /\/api\/vault\/drafts\?new=true&subject=/);
  assert.match(client, /method: 'PUT', cache: 'no-store'/);
  assert.match(client, /savedTo !== 'temporary-draft'/);
  assert.match(client, /const next = revisionRef\.current \+ 1/);
  assert.match(client, /queueRef\.current\.catch\(\(\) => \{\}\)\.then/);
  assert.match(client, /window\.setTimeout\(\(\) =>/);
  assert.match(client, /\/api\/vault\/notes-main/);
  assert.match(client, /uncertainRef\.current = true; setUncertain\(true\)/);
  assert.match(client, /\/api\/vault\/drafts\?id=/);
  assert.match(client, /&confirm=true&revision=/);
  assert.match(client, /method: 'POST', cache: 'no-store'/);
  assert.match(client, /completeStagingAcceptanceSignedOff|No automatic GitHub pushes/);
  assert.doesNotMatch(client,
    /\/api\/quick-notes|\/api\/personal-quick-notes|\/api\/extension\/quick-note/);
  assert.doesNotMatch(client,
    /collection\('notes'\)|collection\('quickNotes'\)|collection\('personalQuickNotes'\)|Bearer |github\.com\//);
  // M111 uses localStorage exclusively for recent GitHub Note UUID hints,
  // not draft bodies or permanent MongoDB Note content.
  assert.match(client, /recentVaultNotesKey\(ownerId, repoId\)/);
  assert.match(client, /rememberRecentVaultNote\(window\.localStorage/);
});

test('M69 Quick Notes, AirNotes, and extension legacy APIs are not silently rewritten', async () => {
  const quick = await readFile(new URL('../app/api/quick-notes/route.js', import.meta.url), 'utf8');
  const air = await readFile(new URL('../app/api/personal-quick-notes/route.js', import.meta.url), 'utf8');
  const ext = await readFile(new URL('../app/api/extension/quick-note/route.js', import.meta.url), 'utf8');
  for (const src of [quick, air, ext]) {
    assert.match(src, /inspectLegacyCutoverForOwner/);
    assert.doesNotMatch(src, /getVaultNoteClient\(|commitVaultNoteBatch\(/);
  }
});
