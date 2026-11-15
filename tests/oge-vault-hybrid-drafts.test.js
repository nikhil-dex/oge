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
  assert.match(api, /client\.vault\.repoId/);
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
  assert.match(page, /method: 'DELETE'/);
  assert.match(vaultPage, /OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true'/);
  assert.match(vaultPage, /vaultOwnerId=\{session\.user\.id\}/);
  assert.match(api, /readVaultNote\(ctx\.client, scope\.noteId\)/);
  assert.match(api, /clearConfirmedDraft/);
});
