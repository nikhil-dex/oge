import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { vaultCaptureAvailable, standaloneNotesDestination } from '../lib/oge-vault-workspace-routing.js';
import { vaultCaptureFields } from '../lib/oge-vault-quick-capture.js';
import { validatedNote } from '../lib/oge-vault-notes.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const activeEnv = {
  OGE_VAULT_MAIN_PREVIEW: 'true', OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
};
const connected = {
  vault: { status: 'connected', repoId: 101, installationId: 201 },
};

test('M107 new Quick Notes and AirNotes share GitHub capture only when connected', () => {
  assert.equal(vaultCaptureAvailable(connected, activeEnv), true);
  assert.equal(standaloneNotesDestination(connected, activeEnv), '/vault/capture');
  assert.equal(standaloneNotesDestination(connected, {}), null);
  for (const bad of [
    null, {}, { vault: { status: 'provisioning', repoId: 101, installationId: 201 } },
    { vault: { status: 'connected', repoId: null, installationId: 201 } },
    { vault: { status: 'connected', repoId: 101, installationId: 0 } },
  ]) assert.equal(standaloneNotesDestination(bad, activeEnv), null);
  assert.equal(standaloneNotesDestination(connected, {
    ...activeEnv, OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'false',
  }), null);
});

test('M107 both existing legacy pages route by signed server owner without rewriting their original APIs', async () => {
  const files = await Promise.all([
    read('../app/quick-notes/layout.js'),
    read('../app/airnotes/layout.js'),
  ]);
  for (const src of files) {
    assert.match(src, /await auth\(\)/);
    assert.match(src, /ownerMutationFilter\(session\.user\.id/);
    assert.match(src, /sessionVersion: session\.user\.sessionVersion/);
    assert.match(src, /standaloneNotesDestination\(account\)/);
    if (src.includes("M126: GitHub Vault users keep the ORIGINAL /airnotes screen."))
      assert.match(src, /if \(destination && destination !== '\/vault\/capture'\) redirect\(destination\)/);
    else assert.match(src, /if \(destination\) redirect\(destination\)/);
    assert.match(src, /return children/);
    assert.doesNotMatch(src, /insertOne\(|commitVaultNoteBatch\(|collection\('notes'\)/);
  }
  for (const path of ['../app/api/quick-notes/route.js',
    '../app/api/personal-quick-notes/route.js']) {
    const src = await read(path);
    assert.match(src, /inspectLegacyCutoverForOwner/);
    assert.doesNotMatch(src, /getVaultNoteClient|commitVaultNoteBatch/);
  }
});

test('M107 extension explicitly selects GitHub destination without double MongoDB note writers', async () => {
  const api = await read('../app/api/extension/vault-note/route.js');
  const old = await read('../app/api/extension/quick-note/route.js');
  const worker = await read('../extension/service-worker.js');
  const widget = await read('../extension/content.js');
  const proxy = await read('../proxy.js');
  const subjects = await read('../app/api/extension/subjects/route.js');
  assert.match(proxy, /pathname === '\/api\/extension\/vault-note'/);
  assert.match(api, /hashExtensionToken\(token\)/);
  assert.match(api, /vaultCaptureFields\(data\?\.content, data\?\.subjectSlug\)/);
  assert.match(api, /noteFilePath\(data\?\.captureId\)/);
  assert.match(api, /vaultCaptureAvailable\(owner\)/);
  assert.match(api, /getVaultNoteClient\(db/);
  assert.match(api, /readVaultNote\(client, id\)/);
  assert.match(api, /commitVaultNoteBatch\(client, \[\{ action: 'create', id, note \}\]\)/);
  assert.match(api, /withVaultSubjectWrite\(db, owner\.googleSub/);
  assert.match(api, /alreadySaved: true/);
  assert.doesNotMatch(api, /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)|insertOne\(|updateOne\(/);
  assert.match(subjects, /vaultReady: vaultCaptureAvailable\(user\)/);
  assert.match(worker, /'CREATE_VAULT_NOTE'/);
  assert.match(worker, /'\/api\/extension\/vault-note'/);
  assert.match(worker, /vaultReady: data\.vaultReady === true/);
  assert.match(widget, /send\('CREATE_VAULT_NOTE'/);
  assert.match(widget, /id: createCaptureId\(\), content: submittedContent/);
  assert.match(widget, /subjectSlug: submittedSubject/);
  assert.match(widget, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(widget, /noteSave\.disabled = true/);
  assert.match(widget, /vaultReady === null/);
  assert.match(widget, /Save to GitHub Vault/);
  assert.match(widget, /send\('CREATE_QUICK_NOTE'/);
  assert.match(old, /inspectLegacyCutoverForOwner/);
  assert.doesNotMatch(old, /commitVaultNoteBatch/);
});

test('M107 existing Quick Capture begins an actual draft when selecting an empty subject', async () => {
  const ui = await read('../app/vault/capture/vault-quick-capture-client.js');
  assert.match(ui, /A fresh subject with no pending draft should be writable immediately/);
  assert.match(ui, /setNoteId\(crypto\.randomUUID\(\)\)/);
  assert.doesNotMatch(ui, /else setStatus\('Start a new capture to write\.'\)/);
  const subjectId = randomUUID();
  const fields = vaultCaptureFields('First note\nUseful body', subjectId);
  const validated = validatedNote(fields);
  assert.equal(validated.subjectId, subjectId);
  assert.equal(validated.heading, 'First note');
  assert.equal(validated.answer, 'Useful body');
  const quick = vaultCaptureFields('One line only', subjectId);
  assert.equal(quick.heading, 'One line only');
  assert.equal(quick.answer, 'One line only');
  assert.equal(validatedNote(quick).answer, 'One line only');
});
