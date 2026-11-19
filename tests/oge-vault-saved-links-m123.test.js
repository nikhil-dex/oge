import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  VAULT_SAVED_LINKS_PATH, savedLinksStorageMode, parseVaultSavedLinks,
  readVaultSavedLinks, createVaultSavedLink, updateVaultSavedLink,
  deleteVaultSavedLink, reorderVaultSavedLinks,
} from '../lib/oge-vault-saved-links.js';

const sha = (value) => createHash('sha1').update(value).digest('hex');
const example = (i = 1) => ({
  title: 'Bookmark ' + i, url: 'https://example.org/' + i,
  description: 'A helpful resource', category: 'Documentation', tags: ['reference'],
});

function githubFixture() {
  let blob = null;
  let writes = 0;
  const calls = [];
  let beforePut = null;
  const client = {
    branch: 'main',
    async call(path, options = {}) {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      if (path === '/contents/' + VAULT_SAVED_LINKS_PATH + '?ref=main' &&
          !options.method) {
        if (!blob) throw new VaultGitHubError('github-api-error', 404);
        return { type: 'file', sha: blob.sha, encoding: 'base64',
          content: Buffer.from(blob.text).toString('base64') };
      }
      if (path === '/contents/' + VAULT_SAVED_LINKS_PATH &&
          options.method === 'PUT') {
        if (beforePut) {
          const inject = beforePut;
          beforePut = null;
          inject();
        }
        if ((!blob && options.body.sha) ||
            (blob && options.body.sha !== blob.sha))
          throw new VaultGitHubError('github-api-error', 409);
        const text = Buffer.from(options.body.content, 'base64').toString('utf8');
        blob = { text, sha: sha(text) };
        writes++;
        return { content: { sha: blob.sha } };
      }
      throw new Error('Unexpected GitHub request: ' + path);
    },
  };
  return {
    client, calls, getWrites: () => writes,
    getBlob: () => blob,
    changeBlobDuringNextPut: callback => { beforePut = callback; },
    setBlob(text) { blob = { text, sha: sha(text) }; },
  };
}

test('M123 selected storage choice never falls back from GitHub into MongoDB', () => {
  assert.equal(savedLinksStorageMode({ notesStorage: 'mongodb',
    vault: { status: 'connected' } }), 'mongodb');
  assert.equal(savedLinksStorageMode({ notesStorage: 'github',
    vault: { status: 'connected' } }), 'github');
  assert.equal(savedLinksStorageMode({ notesStorage: 'github' }), 'vault-setup-required');
  assert.equal(savedLinksStorageMode({ notesStorage: 'unselected' }), 'choice-required');
  assert.equal(savedLinksStorageMode({ vault: { status: 'connected' } }), 'github');
  assert.equal(savedLinksStorageMode({}), 'mongodb');
});

test('M123 GitHub Saved Links create/read/update/reorder/delete roundtrip', async () => {
  const f = githubFixture();
  assert.deepEqual(await readVaultSavedLinks(f.client), { sha: null, links: [] });
  const firstId = randomUUID(), secondId = randomUUID();
  const a = await createVaultSavedLink(f.client, example(1), { id: firstId });
  const b = await createVaultSavedLink(f.client, example(2), { id: secondId });
  assert.equal(a.id, firstId);
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  assert.equal((await readVaultSavedLinks(f.client)).links.length, 2);
  assert.equal(f.getWrites(), 2);
  assert.equal(JSON.parse(f.getBlob().text).format, 'oge-saved-links');
  assert.deepEqual(JSON.parse(f.getBlob().text).links.map(link => link.id), [firstId, secondId]);

  const updated = await updateVaultSavedLink(f.client, firstId, {
    ...example(1), title: 'Updated title',
  });
  assert.equal(updated.title, 'Updated title');
  assert.equal(updated.createdAt, a.createdAt);
  assert.equal((await readVaultSavedLinks(f.client)).links[0].title, 'Updated title');

  assert.deepEqual(await reorderVaultSavedLinks(f.client, [secondId, firstId]),
    { reordered: 2 });
  assert.deepEqual((await readVaultSavedLinks(f.client)).links.map(link => link.id),
    [secondId, firstId]);

  assert.deepEqual(await deleteVaultSavedLink(f.client, secondId),
    { deleted: secondId });
  assert.deepEqual((await readVaultSavedLinks(f.client)).links.map(link => link.id),
    [firstId]);
  assert.equal((await readVaultSavedLinks(f.client)).links[0].order, 0);
  assert.equal(f.calls.some(call => call.method === 'PUT' &&
    call.path !== '/contents/' + VAULT_SAVED_LINKS_PATH), false);
});

test('M123 lost create acknowledgment retry with same UUID does not duplicate link', async () => {
  const f = githubFixture();
  const id = randomUUID();
  const created = await createVaultSavedLink(f.client, example(), { id });
  assert.deepEqual(await createVaultSavedLink(f.client, example(), { id }), created);
  assert.equal(f.getWrites(), 1);
  await assert.rejects(() => createVaultSavedLink(f.client, example(2), { id }),
    err => err instanceof VaultGitHubError && err.message === 'vault-links-id-conflict');
  assert.equal(f.getWrites(), 1);
});

test('M123 rejects a stale snapshot if another device wrote before GitHub PUT', async () => {
  const f = githubFixture();
  const id = randomUUID();
  const created = await createVaultSavedLink(f.client, example(), { id });
  const previous = f.getBlob().text;
  f.changeBlobDuringNextPut(() => {
    const doc = JSON.parse(previous);
    doc.updatedAt = '2030-01-01T00:00:00.000Z';
    f.setBlob(JSON.stringify(doc));
  });
  await assert.rejects(() => updateVaultSavedLink(f.client, id,
    { ...example(), title: 'New device update' }),
  err => err instanceof VaultGitHubError && err.status === 409);
  assert.equal((await readVaultSavedLinks(f.client)).links[0].title, created.title);
  assert.equal(f.getWrites(), 1);
});

test('M123 invalid saved-link documents and incomplete reorders are rejected', async () => {
  const f = githubFixture();
  const id = randomUUID();
  await createVaultSavedLink(f.client, example(), { id });
  await assert.rejects(() => reorderVaultSavedLinks(f.client, []),
    err => err.message === 'vault-links-order-changed');
  await assert.rejects(() => deleteVaultSavedLink(f.client, randomUUID()),
    err => err.status === 404);
  const badDoc = JSON.stringify({ format: 'oge-saved-links', version: 1,
    updatedAt: new Date().toISOString(), links: [{
      id, ...example(), order: 8,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }] });
  f.setBlob(badDoc);
  await assert.rejects(() => readVaultSavedLinks(f.client),
    err => err.message === 'vault-links-invalid-file');
  assert.throws(() => parseVaultSavedLinks({ type: 'file', sha: 'a'.repeat(40),
    encoding: 'base64', content: Buffer.from('{}').toString('base64') }),
  err => err.message === 'vault-links-invalid-file');
});

test('M123 Saved Links API keeps same routes, chooses GitHub after owner verification, no MongoDB content fallback', async () => {
  const api = await readFile(new URL('../app/api/saved-links/route.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/saved-links/page.js', import.meta.url), 'utf8');
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    assert.match(api, new RegExp('export async function ' + method));
  assert.match(api, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(api, /savedLinksStorageMode\(account\)/);
  assert.match(api, /getVaultNoteClient\(db, \{ ownerId, sessionVersion \}\)/);
  assert.match(api, /ctx\.storage === 'github'/);
  assert.match(api, /readVaultSavedLinks\(ctx\.vaultClient\)/);
  assert.match(api, /createVaultSavedLink\(/);
  assert.match(api, /updateVaultSavedLink\(/);
  assert.match(api, /deleteVaultSavedLink\(/);
  assert.match(api, /reorderVaultSavedLinks\(/);
  assert.match(api, /collection\('savedLinks'\)/);
  assert.match(api, /X-Oge-Saved-Links-Storage/);
  assert.match(page, /setPendingLinkId\(crypto\.randomUUID\(\)\)/);
  assert.match(page, /pendingLinkId \? \{ id: pendingLinkId \}/);
  assert.match(page, /private GitHub Vault/);
});
