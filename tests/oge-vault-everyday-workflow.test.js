import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('M104 home routes connected owners to GitHub Notes and exposes Quick Capture directly', async () => {
  const home = await read('../app/page.js');
  assert.match(home, /onboardingComplete: 1, vault: 1/);
  assert.match(home, /const vaultNotesReady = process\.env\.OGE_VAULT_MAIN_PREVIEW === 'true'/);
  assert.match(home, /account\.vault\?\.status === 'connected'/);
  assert.match(home, /const notesHref = vaultNotesReady \? '\/vault\/notes' : '\/notes'/);
  assert.match(home, /<SiteNavbar notesHref=\{notesHref\}/);
  assert.match(home, /item\.href === '\/notes' \? notesHref : item\.href/);
  assert.match(home, /title: 'Quick Capture'/);
  assert.match(home, /href: '\/vault\/capture'/);
  assert.match(home, /captureReady \? \[/);
});

test('M104 Notes navigation stays in GitHub workspace; legacy users keep classic route', async () => {
  const navbar = await read('../app/components/site-navbar.js');
  const notes = await read('../app/notes/page.js');
  const page = await read('../app/vault/notes/page.js');
  assert.match(navbar, /notesHref = '\/notes'/);
  assert.match(navbar, /link\.href === '\/notes' \? notesHref : link\.href/);
  assert.match(navbar, /href=\{href\}/);
  assert.match(notes, /<SiteNavbar notesHref=\{vaultMode \? '\/vault\/notes' : '\/notes'\}/);
  assert.match(notes, /vaultMode && hybridDrafts && <Link className="add-button" href="\/vault\/capture"/);
  assert.match(page, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
});

test('M104 capture uses existing authenticated Notes and draft gates without a separate staging-only switch', async () => {
  const page = await read('../app/vault/capture/page.js');
  const vault = await read('../app/vault/page.js');
  const drafts = await read('../app/api/vault/drafts/route.js');
  assert.match(page, /OGE_VAULT_MAIN_PREVIEW === 'true'/);
  assert.match(page, /OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.doesNotMatch(page, /OGE_VAULT_QUICK_CAPTURE_PREVIEW|OGE_VAULT_NOTE_API_PREVIEW|checkVaultStagingReadiness|oge_vault_restore_staging_/);
  assert.match(page, /ownerMutationFilter/);
  assert.match(page, /vault\?\.status !== 'connected'/);
  assert.match(vault, /const capturePreviewEnabled = mainPreviewEnabled &&\s+process\.env\.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.match(drafts, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(drafts, /OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true'/);
});

test('M104 quick capture lets new users create a subject and write immediately', async () => {
  const client = await read('../app/vault/capture/vault-quick-capture-client.js');
  const page = await read('../app/vault/capture/page.js');
  assert.match(client, /async function createSubject\(event\)/);
  assert.match(client, /method: 'POST', cache: 'no-store'/);
  assert.match(client, /body: JSON\.stringify\(\{ name \}\)/);
  assert.match(client, /await choose\(created\.slug\)/);
  assert.match(client, /setNoteId\(crypto\.randomUUID\(\)\)/);
  assert.match(client, /Start by adding a subject above/);
  assert.match(client, /Ready to write\. A single thought works, or write a title and body/);
  assert.match(client, /subjects\.length !== 1 \|\| subjectId \|\| noteId/);
  assert.match(client, /void choose\(subjects\[0\]\.slug\)/);
  assert.match(page, /notesHref="\/vault\/notes"/);
  assert.match(client, /Saved to GitHub\. Ready for your next note/);
  assert.match(client, /!text\.trim\(\)/);
  assert.match(client, /\/api\/vault\/notes-main/);
  assert.doesNotMatch(client, /\/api\/notes['"?]/);
});
