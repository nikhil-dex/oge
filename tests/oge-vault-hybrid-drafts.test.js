import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  draftKey, sealDraft, unsealDraft, putHybridDraft, clearConfirmedDraft,
} from '../lib/oge-vault-hybrid-drafts.js';

const key = randomBytes(32).toString('hex');
const scope = { ownerId: 'owner-test', repoId: 42, noteId: randomUUID() };
const subjectId = randomUUID();
const draft = () => ({ subjectId, heading: 'Study heading',
  answer: 'private test content', tags: ['networks'], favorite: false, baseSha: null });

test('draft ciphertext is authenticated and stores no plaintext field', () => {
  const sealed = sealDraft(draft(), key);
  assert.equal(JSON.stringify(sealed).includes('private test content'), false);
  assert.deepEqual(unsealDraft(sealed, key), draft());
  const tampered = { ...sealed, ciphertext: Buffer.from('fake').toString('base64') };
  assert.throws(() => unsealDraft(tampered, key));
});

test('reject invalid repo scope, invalid revisions and missing encryption key', () => {
  assert.throws(() => draftKey('owner', 0, scope.noteId));
  assert.throws(() => sealDraft(draft(), 'bad'));
  assert.throws(() => sealDraft({ ...draft(), answer: 'x'.repeat(20001) }, key));
});

test('revision-fenced updates reject stale writes and cleanup cannot remove new drafts', async () => {
  const documents = new Map();
  const id = JSON.stringify(draftKey(scope.ownerId, scope.repoId, scope.noteId));
  const collection = {
    async insertOne(document) {
      if (documents.has(id)) { const error = new Error('duplicate'); error.code = 11000; throw error; }
      documents.set(id, document);
      return { insertedId: id };
    },
    async updateOne(filter, update) {
      const previous = documents.get(id);
      if (!previous || filter.revision !== previous.revision) return { matchedCount: 0 };
      documents.set(id, { ...previous, ...update.$set });
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      const previous = documents.get(id);
      if (!previous || previous.revision !== filter.revision) return { deletedCount: 0 };
      documents.delete(id);
      return { deletedCount: 1 };
    },
  };
  await putHybridDraft(collection, scope, 1, draft(), { key });
  assert.equal(documents.get(id).isNew, true);
  assert.equal(documents.get(id).encrypted.ciphertext.includes('private test content'), false);
  await putHybridDraft(collection, scope, 2, { ...draft(), answer: 'newer' }, { key });
  await assert.rejects(putHybridDraft(collection, scope, 2, draft(), { key }),
    /vault-draft-revision-conflict/);
  assert.equal(await clearConfirmedDraft(collection, scope, 1), false);
  assert.equal(unsealDraft(documents.get(id).encrypted, key).answer, 'newer');
  assert.equal(await clearConfirmedDraft(collection, scope, 2), true);
});

test('draft routes are preview-gated and production Notes remains separate', async () => {
  const api = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  assert.match(api, /OGE_VAULT_HYBRID_DRAFT_PREVIEW/);
  assert.match(api, /getVaultNoteClient/);
  assert.match(api, /ownerMutationFilter\(session\.user\.id/);
  assert.match(api, /repoId: vault\.repoId/);
  assert.match(api, /reconcileConfirmedVaultDraft\(/);
  assert.match(api, /readConfirmedVaultSaveReceipt\(/);
  assert.match(api, /readLimitedBody\(request, 32768\)/);
  assert.match(mongo, /vault_drafts.*createIndex/);
  assert.match(mongo, /vault_files.*createIndex/);
  assert.doesNotMatch(mongo, /vault_drafts.*expireAfterSeconds/);
});

test('familiar Notes hybrid editor is opt-in and preserves legacy production mode', async () => {
  const page = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const vaultPage = await readFile(new URL('../app/vault/notes/page.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  assert.match(page, /hybridDrafts = false/);
  assert.match(page, /fetch\('\/api\/vault\/drafts/);
  assert.match(page, /window\.sessionStorage\.setItem/);
  assert.match(page, /Draft saved/);
  assert.match(page, /An unsynced draft exists/);
  assert.match(page, /Browser and server drafts differ/);
  assert.match(page, /crypto\.randomUUID\(\)/);
  assert.match(page, /recoverNewHybridDraft\(activeSubject, generation\)/);
  assert.match(page, /newDraftPointerKey\(subjectId\)/);
  assert.match(page, /sessionStorage\.getItem\(newDraftPointerKey\(subjectId\)\)/);
  assert.match(page, /hybridDrafts \? \{ \.\.\.payload, id: newDraftId \} : payload/);
  assert.match(api, /params\.get\('new'\) === 'true'/);
  assert.match(api, /isNew: true/);
  const notesAdapter = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  assert.match(notesAdapter, /const suppliedId = data\?\.id/);
  assert.match(notesAdapter, /OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.match(notesAdapter, /suppliedId \? \{ id: suppliedId \} : \{\}/);
  assert.match(page, /Server recovery unavailable\. Restore the browser draft/);
  assert.ok(page.includes("if (!navigator.onLine)"));
  assert.ok(page.includes("stillLatest ? 'Draft saved' : 'Draft pending'"));
  assert.ok(page.includes("disabled={hybridDrafts && (!hybridReady || saving)}"));
  assert.match(page, /if \(hybridDrafts && saving\) return;/);
  assert.match(page, /const submittedEditor = JSON\.stringify/);
  assert.match(page, /JSON\.stringify\(liveEditorRef\.current\) !== submittedEditor/);
  assert.match(page, /JSON\.stringify\(local\) === JSON\.stringify\(confirmedDraft\)/);
  assert.match(page, /window\.addEventListener\('online', resume\)/);
  assert.match(page, /Retry draft autosave/);
  assert.match(page, /hybridConflictRef\.current = true/);
  assert.match(page, /if \(hybridConflictRef\.current\) return undefined/);
  assert.match(page, /received\.item\.revision/);
  assert.match(page, /Draft server unavailable\. Restore this browser copy/);
  assert.match(page, /if \(generation !== hybridGenerationRef\.current\) return/);


  assert.match(page, /Flush the exact editor snapshot before final GitHub Save/);
  assert.match(page, /const revision = hybridRevisionRef\.current \+ 1/);
  assert.match(page, /attemptedGitHubSave = \{/);
  assert.match(page, /revision: hybridRevisionRef\.current/);
  assert.match(page, /submittedDraft:/);
  assert.match(page, /&confirm=true&revision=/);
  assert.match(page, /checked\.confirmed === true/);
  assert.match(page, /method: 'POST'/);
  assert.match(page, /sha: checked\.sha/);
  assert.match(page, /reconciled\?\.confirmed && reconciled\.cleared/);
  assert.match(page, /JSON\.stringify\(attemptedGitHubSave\.submittedDraft\)/);
  assert.match(page, /Note saved successfully — GitHub commit recovered/);
  assert.match(page, /newer or unchecked draft retained/);
  assert.match(page, /hybridGenerationRef\.current \+= 1/);
  assert.match(page, /GitHub Save confirmed — newer or unchecked draft retained/);
  assert.match(page, /Draft pending — GitHub confirmation needed/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(vaultPage, /OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.match(vaultPage, /vaultOwnerId=\{session\.user\.id\}/);
  assert.match(api, /reconcileConfirmedVaultDraft\(/);
  assert.match(api, /readConfirmedVaultSaveReceipt\(/);
  assert.match(api, /export async function DELETE\(request\) \{/);
  assert.match(api, /return POST\(request\)/);
  assert.match(page, /cleaned\?\.confirmed !== true \|\| cleaned\.cleared !== true/);
  assert.match(page, /GitHub saved — draft cleanup pending/);
  assert.match(page, /GitHub saved — newer browser draft retained/);
});
