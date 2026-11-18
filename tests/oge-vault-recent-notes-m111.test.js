import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { commitVaultNoteBatch } from '../lib/oge-vault-batch.js';
import { listVaultNotePage, readVaultNote } from '../lib/oge-vault-notes.js';
import {
  isVaultNoteId, recentVaultNotesKey, readRecentVaultNoteIds,
  rememberRecentVaultNote, mergeRecentVaultNotes,
} from '../lib/oge-vault-recent-notes.js';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const subjectId = 'abcdefff-1234-4123-8123-123456789abc';
const recentId = 'f0000000-0000-4000-8000-000000000001';
const idAt = (number) =>
  number.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001';

function fakeLocalStorage() {
  const data = new Map();
  return {
    data, getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

function fakeGitHub() {
  let branchHead = sha1('initial-commit');
  const emptyTree = sha1('initial-tree');
  const commits = new Map([[branchHead, {
    sha: branchHead, tree: { sha: emptyTree }, parents: [],
  }]]);
  const trees = new Map([[emptyTree, new Map()]]);
  const blobs = new Map();
  let nextTree = 0, nextCommit = 0;
  const client = {
    branch: 'main',
    async call(path, opts = {}) {
      if (path === '/git/ref/heads/main' && !opts.method)
        return { object: { sha: branchHead } };
      if (path === '/git/ref/heads/main' && opts.method === 'PATCH') {
        const candidate = commits.get(opts.body.sha);
        if (!candidate || !candidate.parents.includes(branchHead) ||
            opts.body.force !== false)
          throw Error('Invalid fake GitHub update');
        branchHead = candidate.sha;
        return { object: { sha: branchHead } };
      }
      if (path.startsWith('/git/commits/') && !opts.method) {
        return commits.get(path.slice('/git/commits/'.length));
      }
      if (path.startsWith('/git/trees/') && !opts.method) {
        const sha = path.slice('/git/trees/'.length).split('?')[0];
        return { truncated: false, tree: [...(trees.get(sha) || [])]
          .map(([filePath, blob]) => ({
            path: filePath, type: 'blob', sha: blob.sha, size: Buffer.byteLength(blob.text),
          })) };
      }
      if (path === '/git/trees' && opts.method === 'POST') {
        const files = new Map(trees.get(opts.body.base_tree));
        for (const change of opts.body.tree) {
          if (change.sha === null) files.delete(change.path);
          else {
            const sha = sha1(change.content);
            blobs.set(sha, change.content);
            files.set(change.path, { sha, text: change.content });
          }
        }
        const sha = sha1('test-tree-' + nextTree++);
        trees.set(sha, files);
        return { sha };
      }
      if (path === '/git/commits' && opts.method === 'POST') {
        const sha = sha1('test-commit-' + nextCommit++);
        commits.set(sha, { sha, tree: { sha: opts.body.tree },
          message: opts.body.message, parents: opts.body.parents });
        return { sha };
      }
      if (path.startsWith('/contents/')) {
        const key = path.slice('/contents/'.length).split('?')[0];
        const currentTree = trees.get(commits.get(branchHead).tree.sha);
        const record = currentTree.get(key);
        if (!record) throw Error('Missing fake committed file: ' + key);
        return { type: 'file', encoding: 'base64', sha: record.sha,
          content: Buffer.from(record.text).toString('base64') };
      }
      if (path.startsWith('/git/blobs/')) {
        const sha = path.slice('/git/blobs/'.length);
        const data = blobs.get(sha);
        if (!data) throw Error('Missing fake blob: ' + sha);
        return { encoding: 'base64', content: Buffer.from(data).toString('base64') };
      }
      throw Error('Unexpected GitHub fixture request: ' + path);
    },
  };
  return client;
}

test('M111 IDs-only browser hints are scoped, bounded, deduplicated and recover after a tab reload', () => {
  const storage = fakeLocalStorage();
  const key = recentVaultNotesKey('owner-A', 9876);
  const other = recentVaultNotesKey('owner-B', 9876);
  const otherRepo = recentVaultNotesKey('owner-A', 99);
  assert.notEqual(key, other);
  assert.notEqual(key, otherRepo);
  for (let i = 0; i < 9; i += 1)
    rememberRecentVaultNote(storage, key, idAt(i + 1));
  const saved = readRecentVaultNoteIds(storage, key);
  assert.deepEqual(saved, [9, 8, 7, 6, 5].map(idAt));
  assert.deepEqual(readRecentVaultNoteIds(storage, other), []);
  assert.deepEqual(readRecentVaultNoteIds(storage, otherRepo), []);
  rememberRecentVaultNote(storage, key, idAt(7));
  assert.equal(readRecentVaultNoteIds(storage, key)[0], idAt(7));
  assert.equal(JSON.parse(storage.getItem(key)).length, 5);
  assert.doesNotMatch(storage.getItem(key), /heading|answer|private|GitHub token/i);
});

test('M111 corrupt or inaccessible local storage never supplies unvalidated IDs or note content', () => {
  const storage = fakeLocalStorage();
  const key = recentVaultNotesKey('owner-A', 45);
  storage.setItem(key, JSON.stringify(['not-an-id', recentId, recentId, 'a'.repeat(100000)]));
  assert.deepEqual(readRecentVaultNoteIds(storage, key), [recentId]);
  storage.setItem(key, '{ broken json');
  assert.deepEqual(readRecentVaultNoteIds(storage, key), []);
  assert.deepEqual(readRecentVaultNoteIds({
    getItem: () => { throw Error('Storage blocked'); },
  }, key), []);
  assert.throws(() => rememberRecentVaultNote(storage, key, 'bad'), TypeError);
  assert.throws(() => recentVaultNotesKey('', 1), TypeError);
  assert.throws(() => recentVaultNotesKey('owner', 0), TypeError);
  assert.equal(isVaultNoteId(recentId), true);
  assert.equal(isVaultNoteId('../private-notes'), false);
});

test('M111 confirmed GitHub create → reload → edit remains visible past first 20 UUIDs', async () => {
  const client = fakeGitHub();
  const storage = fakeLocalStorage();
  const key = recentVaultNotesKey('test-owner', 234);
  // Existing Notes have low UUIDs; recent random-ish UUID appears
  // after the first GitHub page despite being the newest commit.
  const older = Array.from({ length: 24 }, (_, i) => ({
    action: 'create', id: idAt(i+1), note: {
      subjectId, heading: 'Older ' + i, answer: 'From old class',
    },
  }));
  for (let i = 0; i < older.length; i += 12)
    await commitVaultNoteBatch(client, older.slice(i, i+12));

  const pageBefore = await listVaultNotePage(client, { limit: 20 });
  assert.equal(pageBefore.notes.length, 20);
  const created = await commitVaultNoteBatch(client, [{
    action: 'create', id: recentId, note: {
      subjectId, heading: 'Newest study note', answer: 'My new GitHub Note',
    },
  }]);
  rememberRecentVaultNote(storage, key, created.results[0].id);

  // Simulate a complete browser reload: no Notes state or cached bodies,
  // only the persisted Note UUID list and a fresh provider read.
  const firstPage = await listVaultNotePage(client, { limit: 20 });
  assert.equal(firstPage.total, 25);
  assert.equal(firstPage.notes.some((note) => note.id === recentId), false);
  const recentlySaved = await Promise.all(readRecentVaultNoteIds(storage, key)
    .map((id) => readVaultNote(client, id)));
  const visible = mergeRecentVaultNotes(firstPage.notes, recentlySaved);
  assert.equal(visible.length, 21);
  assert.equal(visible[0].id, recentId);
  assert.equal(visible[0].answer, 'My new GitHub Note');
  assert.equal(visible[0].subjectId, subjectId);

  const edited = await commitVaultNoteBatch(client, [{
    action: 'update', id: recentId, sha: recentlySaved[0].sha,
    note: { subjectId, heading: 'Newest study note',
      answer: 'Updated on GitHub after editing' },
  }]);
  assert.equal(edited.results[0].answer, 'Updated on GitHub after editing');
  // Another fresh reload also fetches updated Note body from GitHub, not
  // any stale localStorage note-content copy.
  const reread = await readVaultNote(client, readRecentVaultNoteIds(storage,key)[0]);
  assert.equal(reread.answer, 'Updated on GitHub after editing');
  assert.equal(JSON.parse(storage.getItem(key))[0], recentId);
});

test('M111 direct extension deep-link and client/recent-note wiring are present', async () => {
  const notes = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const quick = await readFile(new URL('../app/vault/capture/vault-quick-capture-client.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const widget = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  assert.match(notes, /readRecentVaultNoteIds\(window\.localStorage, key\)/);
  assert.match(notes, /mergeRecentVaultNotes\(noteList, recentNotes\)/);
  assert.match(notes, /rememberRecentVaultNote\(window\.localStorage/);
  assert.match(notes, /new URLSearchParams\(window\.location\.search\)\.get\('note'\)/);
  assert.match(quick, /rememberRecentVaultNote\(window\.localStorage/);
  assert.match(worker, /message\.type === 'OPEN_VAULT_NOTE'/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: origin \+ '\/vault\/notes\?note='/);
  assert.match(widget, /data-open-saved-vault-note/);
  assert.match(widget, /send\('OPEN_VAULT_NOTE', \{ id: lastSavedVaultNoteId \}\)/);
  assert.match(route, /legacyVaultNote\(await readVaultNote\(ctx\.client, id\.toLowerCase\(\)\)\)/);
});
