import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  validatedNote, noteFilePath, readVaultNote, listVaultNotes,
  saveVaultNote, deleteVaultNote,
} from '../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const subjectId = randomUUID();
const sha = (char) => char.repeat(40);
function mockClient() {
  const store = new Map();
  let counter = 0;
  let unconfirmed = false;
  const paths = [];
  return {
    store, paths, branch: 'main',
    get unconfirmed() { return unconfirmed; },
    set unconfirmed(v) { unconfirmed = v; },
    async call(path, opts = {}) {
      paths.push({ path, method: opts.method || 'GET', body: opts.body });
      if (path.startsWith('/contents/notes?')) {
        if (!store.size) throw new VaultGitHubError('github-api-error', 404);
        return [...store].map(([filePath, value]) => ({
          name: filePath.split('/')[1],
          path: filePath, type: 'file', sha: value.sha,
        }));
      }
      const filePath = path.split('?')[0].slice('/contents/'.length);
      const current = store.get(filePath);
      if (opts.method === 'PUT') {
        if ((!current && opts.body.sha) || (current && opts.body.sha !== current.sha)) {
          throw new VaultGitHubError('github-api-error', 409);
        }
        counter++;
        const nextSha = sha(counter % 2 ? 'a' : 'b');
        if (!unconfirmed) store.set(filePath, {
          content: Buffer.from(opts.body.content, 'base64').toString('utf8'), sha: nextSha,
        });
        return { content: { sha: nextSha } };
      }
      if (opts.method === 'DELETE') {
        if (!current || current.sha !== opts.body.sha) {
          throw new VaultGitHubError('github-api-error', 409);
        }
        store.delete(filePath);
        return { commit: { sha: sha('c') } };
      }
      if (!current) throw new VaultGitHubError('github-api-error', 404);
      return {
        type: 'file', sha: current.sha, encoding: 'base64',
        content: Buffer.from(current.content).toString('base64'),
      };
    },
  };
}

test('note filenames are opaque UUIDs, never user text or arbitrary paths', () => {
  const id = randomUUID();
  assert.equal(noteFilePath(id), 'notes/' + id + '.json');
  for (const value of ['../../users', 'note.md', '', 'notes/' + id, '💻']) {
    assert.throws(() => noteFilePath(value), TypeError);
  }
  assert.throws(() => validatedNote({
    subjectId, heading: 'Title', answer: 'text', tags: ['fine'], favorite: 'false',
  }), TypeError);
  assert.throws(() => validatedNote({
    subjectId, heading: 'Title', answer: 'text'.repeat(10000),
  }), TypeError);
});

test('GitHub-only create, read, list, update and delete use CAS with confirmed writes', async () => {
  const client = mockClient();
  const created = await saveVaultNote(client, {
    subjectId, heading: 'The first note', answer: 'GitHub only',
    tags: ['Study'], favorite: true,
  });
  assert.equal(created.answer, 'GitHub only');
  assert.equal(created.sha, sha('a'));
  assert.equal(created.tags[0], 'study');
  assert.equal(client.store.size, 1);
  assert.deepEqual(await readVaultNote(client, created.id), created);
  assert.equal((await listVaultNotes(client))[0].heading, 'The first note');
  const changed = await saveVaultNote(client, {
    subjectId, heading: 'Revised note', answer: 'Content lives only on GitHub',
    tags: [], favorite: false,
  }, { id: created.id, sha: created.sha });
  assert.equal(changed.sha, sha('b'));
  assert.equal(changed.createdAt, created.createdAt);
  await assert.rejects(() => saveVaultNote(client, {
    subjectId, heading: 'Stale', answer: 'must fail',
  }, { id: created.id, sha: created.sha }),
  (error) => error.message === 'vault-note-conflict');
  assert.equal((await readVaultNote(client, created.id)).answer, 'Content lives only on GitHub');
  await assert.rejects(() => deleteVaultNote(client, created.id, created.sha),
    (error) => error.message === 'vault-note-conflict');
  assert.deepEqual(await deleteVaultNote(client, created.id, changed.sha),
    { deleted: created.id });
  assert.deepEqual(await listVaultNotes(client), []);
});

test('GitHub-only write is never acknowledged if remote data was not persisted', async () => {
  const client = mockClient();
  client.unconfirmed = true;
  await assert.rejects(() => saveVaultNote(client, {
    subjectId, heading: 'Not persisted', answer: 'No false success',
  }), (error) => error instanceof VaultGitHubError && error.message === 'vault-write-unconfirmed');
  assert.equal(client.store.size, 0);
});

test('reject corrupt or oversized GitHub note file instead of returning content', async () => {
  const client = mockClient();
  const id = randomUUID();
  client.store.set(noteFilePath(id), { sha: sha('a'), content: JSON.stringify({ format: 'wrong', id }) });
  await assert.rejects(() => readVaultNote(client, id),
    (error) => error.message === 'vault-note-corrupt');
  client.store.set(noteFilePath(id), { sha: sha('a'), content: 'x'.repeat(40000) });
  await assert.rejects(() => readVaultNote(client, id),
    (error) => error.message === 'vault-note-too-large');
});

test('experimental GitHub CRUD API does not insert or update note content in MongoDB', async () => {
  const api = await readFile(new URL('../app/api/vault/notes/route.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../lib/oge-vault-notes.js', import.meta.url), 'utf8');
  assert.match(api, /OGE_VAULT_NOTE_API_PREVIEW === 'true'/);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.match(api, new RegExp('export async function ' + method));
  }
  assert.doesNotMatch(api, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(api, /collection\(['"]quickNotes['"]\)/);
  assert.doesNotMatch(api, /collection\(['"]personalQuickNotes['"]\)/);
  assert.doesNotMatch(storage, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(storage, /collection\(['"]quickNotes['"]\)/);
  assert.match(storage, /repository_ids: \[vault.repoId\]/);
  assert.match(storage, /verified\.sha !== newSha/);
});
