import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  standaloneDraftScope, validatedStandaloneDraft,
  sealStandaloneDraft, openStandaloneDraft,
  putStandaloneDraft, readStandaloneDraft, reconcileStandaloneDraft,
} from '../lib/oge-vault-standalone-drafts.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const KEY = randomBytes(32).toString('hex');
const SECOND_KEY = randomBytes(32).toString('hex');
const OWNER = 'test-standalone-owner';
const ID = randomUUID();
const SHA = 'a'.repeat(40);
const SAVED_SHA = 'b'.repeat(40);
const kinds = ['quick-notes', 'airnotes'];

function collectionFixture() {
  const docs = new Map();
  const calls = [];
  const key = (obj) => JSON.stringify([
    obj.ownerId, obj.repoId, obj.kind, obj.captureId,
  ]);
  const matches = (doc, filter) => doc &&
    Object.entries(filter).every(([name, value]) =>
      name === 'encrypted.ciphertext'
        ? doc.encrypted.ciphertext === value
        : doc[name] === value);
  return {
    docs, calls,
    collection: {
      async findOne(filter) {
        calls.push({ action: 'findOne', filter });
        const value = docs.get(key(filter));
        return matches(value, filter) ? structuredClone(value) : null;
      },
      async insertOne(value) {
        calls.push({ action: 'insertOne', value: structuredClone(value) });
        const where = key(value);
        if (docs.has(where)) {
          const duplicate = new Error('duplicate document');
          duplicate.code = 11000;
          throw duplicate;
        }
        docs.set(where, structuredClone(value));
        return { insertedId: 'opaque' };
      },
      async updateOne(filter, update) {
        calls.push({ action: 'updateOne', filter });
        const where = key(filter), current = docs.get(where);
        if (!matches(current, filter)) return { matchedCount: 0 };
        docs.set(where, structuredClone({ ...current, ...update.$set }));
        return { matchedCount: 1 };
      },
      async deleteOne(filter) {
        calls.push({ action: 'deleteOne', filter });
        const where = key(filter), current = docs.get(where);
        if (!matches(current, filter)) return { deletedCount: 0 };
        docs.delete(where);
        return { deletedCount: 1 };
      },
    },
  };
}
const draft = (content = 'Private quick draft') =>
  ({ content, baseSha: null });
const scope = (kind = 'quick-notes', owner = OWNER, repo = 77, id = ID) =>
  standaloneDraftScope(owner, repo, kind, id);
const client = (repo = 77, readOnly = true) =>
  ({ vault: { repoId: repo }, readOnly });
const options = { key: KEY };

test('M71 AES-GCM round trip and mandatory owner/repo/kind/id/revision AAD separation', () => {
  const s = scope();
  const sealed = sealStandaloneDraft(s, 1, draft(), options);
  assert.deepEqual(Object.keys(sealed).sort(),
    ['ciphertext', 'iv', 'tag', 'version']);
  assert.equal(JSON.stringify(sealed).includes('Private quick draft'), false);
  assert.deepEqual(openStandaloneDraft(s, 1, sealed, options), draft());
  assert.notEqual(sealStandaloneDraft(s, 1, draft(), options).ciphertext,
    sealed.ciphertext, 'fresh random IV and ciphertext each autosave');
  for (const wrong of [
    scope('airnotes'), scope('quick-notes', 'other-owner'),
    scope('quick-notes', OWNER, 78), scope('quick-notes', OWNER, 77, randomUUID()),
  ]) assert.throws(() => openStandaloneDraft(wrong, 1, sealed, options), TypeError);
  assert.throws(() => openStandaloneDraft(s, 2, sealed, options), TypeError);
  assert.throws(() => openStandaloneDraft(s, 1, sealed, { key: SECOND_KEY }), TypeError);
  const tampered = { ...sealed, ciphertext: sealed.ciphertext.replace(/^./,
    sealed.ciphertext[0] === 'A' ? 'B' : 'A') };
  assert.throws(() => openStandaloneDraft(s, 1, tampered, options), TypeError);
  assert.throws(() => openStandaloneDraft(s, 1,
    { ...sealed, tag: 'B'.repeat(24) }, options), TypeError);
  assert.throws(() => openStandaloneDraft(s, 1,
    { ...sealed, userToken: 'unsafe' }, options), TypeError);
});

test('M71 rejects invalid typed draft content, GitHub base revisions and malformed scopes', () => {
  for (const kind of kinds) {
    assert.deepEqual(validatedStandaloneDraft(kind,
      { content: ' One\r\nTwo ', baseSha: SHA }, ID),
    { content: ' One\nTwo ', baseSha: SHA });
    for (const bad of [
      { content: 'text' }, { content: 'text', baseSha: 'invalid' },
      { content: 'text', baseSha: null, auth: 'never' },
      { content: 23, baseSha: null },
      { content: 'x'.repeat(20001), baseSha: null },
      { content: '😀'.repeat(7000), baseSha: null },
    ]) assert.throws(() => validatedStandaloneDraft(kind, bad, ID), TypeError);
  }
  for (const args of [
    ['', 1, 'airnotes', ID], [OWNER, 0, 'airnotes', ID],
    [OWNER, 77, 'notes', ID], [OWNER, 77, 'quick-notes', '../evil'],
  ]) assert.throws(() => standaloneDraftScope(...args), TypeError);
  assert.throws(() => sealStandaloneDraft(scope(), 1, draft(), { key: '' }), TypeError);
  assert.throws(() => sealStandaloneDraft(scope(), 0, draft(), options), TypeError);
});

test('M71 first encrypted autosave has no MongoDB plaintext, separate typed owner scoping and is recoverable', async () => {
  const f = collectionFixture();
  for (const kind of kinds) {
    const s = scope(kind);
    const response = await putStandaloneDraft(f.collection, s, 1, draft(kind), options);
    assert.equal(response.savedTo, 'temporary-encrypted-draft');
    assert.equal(response.committedToGitHub, false);
    assert.equal(response.status, 'pending');
    assert.deepEqual((await readStandaloneDraft(f.collection, s, options)).draft,
      draft(kind));
  }
  assert.equal(f.docs.size, 2);
  for (const value of f.docs.values()) {
    assert.equal(Object.hasOwn(value, 'content'), false);
    assert.equal(Object.hasOwn(value, 'title'), false);
    assert.equal(Object.hasOwn(value, 'draft'), false);
    assert.equal(JSON.stringify(value).includes('Private quick draft'), false);
    assert.equal(value.status, 'pending');
  }
  assert.equal((await readStandaloneDraft(f.collection,
    scope('quick-notes', 'other-owner'), options)), null);
  assert.equal((await readStandaloneDraft(f.collection,
    scope('airnotes', OWNER, 78), options)), null);
});

test('M71 revision CAS rejects duplicate starts, stale tabs, changed baseSha and lost history', async () => {
  const f = collectionFixture(), s = scope();
  await putStandaloneDraft(f.collection, s, 1, draft('original'), options);
  await assert.rejects(putStandaloneDraft(f.collection, s, 1, draft('duplicate'), options),
    e => e instanceof VaultGitHubError && e.status === 409);
  await putStandaloneDraft(f.collection, s, 2, draft('newer'), options);
  await assert.rejects(putStandaloneDraft(f.collection, s, 2, draft('stale'), options),
    e => e instanceof VaultGitHubError && e.status === 409);
  await assert.rejects(putStandaloneDraft(f.collection, s, 3,
    { content: 'forged base', baseSha: SHA }, options),
  e => e instanceof VaultGitHubError && e.status === 409);
  await assert.rejects(putStandaloneDraft(f.collection, s, 9, draft('skip'), options),
    e => e instanceof VaultGitHubError && e.status === 409);
  assert.equal((await readStandaloneDraft(f.collection, s, options)).draft.content, 'newer');
  assert.equal((await readStandaloneDraft(f.collection, s, options)).revision, 2);
});

test('M71 confirms only exact current GitHub blob SHA and content; otherwise draft survives', async () => {
  const f = collectionFixture(), s = scope();
  await putStandaloneDraft(f.collection, s, 1, draft('new private text'), options);
  for (const saved of [
    { id: ID, sha: SHA, content: 'changed' },
    { id: randomUUID(), sha: SAVED_SHA, content: 'new private text' },
    { id: ID, sha: SHA, content: 'new private text' },
  ]) {
    const result = await reconcileStandaloneDraft(f.collection, client(), s,
      1, SAVED_SHA, { ...options, reader: async () => saved });
    assert.deepEqual([result.confirmed, result.cleared], [false, false]);
  }
  assert.equal(f.docs.size, 1);
  await assert.rejects(reconcileStandaloneDraft(f.collection, client(88), s,
    1, SAVED_SHA, options), e => e instanceof VaultGitHubError && e.status === 409);
  await assert.rejects(reconcileStandaloneDraft(f.collection, client(77, false), s,
    1, SAVED_SHA, options), e => e instanceof VaultGitHubError && e.status === 409);
  const good = await reconcileStandaloneDraft(f.collection, client(), s,
    1, SAVED_SHA, { ...options, reader: async () =>
      ({ id: ID, sha: SAVED_SHA, content: 'new private text' }) });
  assert.equal(good.confirmed, true);
  assert.equal(good.cleared, true);
  assert.equal(good.safeToRetryGitHubWrite, false);
  assert.equal(good.authority, 'current-github-content-only');
  assert.equal(f.docs.size, 0);
});

test('M71 existing note drafts must demonstrate changed GitHub SHA before clearing', async () => {
  const f = collectionFixture(), s = scope('airnotes');
  const original = { content: 'Edited text', baseSha: SHA };
  await putStandaloneDraft(f.collection, s, 1, original, options);
  const wrong = await reconcileStandaloneDraft(f.collection, client(), s,
    1, SHA, { ...options, reader: async () =>
      ({ id: ID, sha: SHA, content: original.content }) });
  assert.equal(wrong.confirmed, false);
  assert.equal(f.docs.size, 1);
  const good = await reconcileStandaloneDraft(f.collection, client(), s,
    1, SAVED_SHA, { ...options, reader: async () =>
      ({ id: ID, sha: SAVED_SHA, content: original.content }) });
  assert.equal(good.cleared, true);
  assert.equal(f.docs.size, 0);
});

test('M71 GitHub read network failure must not clear draft or attempt any GitHub write', async () => {
  const f = collectionFixture(), s = scope();
  await putStandaloneDraft(f.collection, s, 1, draft(), options);
  let calls = 0;
  const result = await reconcileStandaloneDraft(f.collection, client(),
    s, 1, SAVED_SHA, { ...options, reader: async () => {
      calls++;
      throw new Error('GitHub 429 or disconnect');
    } });
  assert.equal(result.confirmed, false);
  assert.equal(result.cleared, false);
  assert.equal(calls, 1);
  assert.equal(f.docs.size, 1);
});

test('M71 second-device autosave during GitHub read cannot be accidentally deleted', async () => {
  const f = collectionFixture(), s = scope();
  await putStandaloneDraft(f.collection, s, 1, draft('original text'), options);
  const response = await reconcileStandaloneDraft(f.collection, client(),
    s, 1, SAVED_SHA, {
      ...options,
      reader: async () => {
        await putStandaloneDraft(f.collection, s, 2, draft('newer remote autosave'), options);
        return { id: ID, sha: SAVED_SHA, content: 'original text' };
      },
    });
  assert.equal(response.confirmed, true);
  assert.equal(response.cleared, false);
  assert.equal(response.reason, 'newer-draft-present');
  assert.equal((await readStandaloneDraft(f.collection, s, options)).revision, 2);
  assert.equal((await readStandaloneDraft(f.collection, s, options)).draft.content,
    'newer remote autosave');
});

test('M71 no-TTL unique compound scope index and isolated API gates, no legacy permanent MongoDB writes', async () => {
  const mongo = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  const api = await readFile(new URL(
    '../app/api/vault/standalone-drafts/route.js', import.meta.url), 'utf8');
  assert.match(mongo, /vault_standalone_drafts.*createIndex/);
  assert.match(mongo, /ownerId: 1, repoId: 1, kind: 1, captureId: 1/);
  assert.doesNotMatch(mongo, /vault_standalone_drafts.*expireAfterSeconds/);
  for (const expected of [
    /OGE_VAULT_STANDALONE_DRAFT_PREVIEW === 'true'/,
    /OGE_VAULT_STANDALONE_PREVIEW === 'true'/,
    /checkVaultStagingReadiness\(env\)\.ok/,
    /oge_vault_restore_staging_/,
    /ownerMutationFilter\(identity\.ownerId/,
    /sessionVersion: identity\.sessionVersion/,
    /withVaultOwnerDraftWrite\(ctx\.db/,
    /getVaultNoteClient\(ctx\.db, ctx\.identity/,
    /\{ readOnly: true \}/,
    /readLimitedBody\(request, 32768\)/,
    /vault_standalone_drafts/,
    /return json\(result, result\.confirmed && result\.cleared \? 200 : 409\)/,
  ]) assert.match(api, expected);
  assert.doesNotMatch(api,
    /collection\(['"](?:quickNotes|personalQuickNotes|notes)['"]\)|commitVaultStandaloneCapture|\.insertOne\(|\.updateOne\(/);
});

test('M71 standalone draft crypto never echoes or saves plaintext except AES-GCM temporary envelope', async () => {
  const source = await readFile(new URL('../lib/oge-vault-standalone-drafts.js',
    import.meta.url), 'utf8');
  assert.match(source, /aes-256-gcm/);
  assert.match(source, /hkdfSync\('sha256'/);
  assert.match(source, /encrypt\.setAAD\(aad\(id, revision\)\)/);
  assert.match(source, /decrypt\.setAAD\(aad\(scope, revision\)\)/);
  assert.match(source, /'encrypted\.ciphertext': snapshot\.encrypted\.ciphertext/);
  assert.match(source, /safeToRetryGitHubWrite: false/);
  assert.doesNotMatch(source, /commitVaultStandaloneCapture|method: 'PATCH'|localStorage|sessionStorage|writeFile\(/);
});
