import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { commitVaultNoteBatch } from '../lib/oge-vault-batch.js';
import { readVaultNote, listVaultNotePage } from '../lib/oge-vault-notes.js';
import { stageVaultFollowupSave } from '../lib/oge-vault-followup-save.js';
import { validatedHybridDraft } from '../lib/oge-vault-hybrid-drafts.js';

const sha1 = (value) => createHash('sha1').update(value).digest('hex');
const subjectId = 'abcdefff-1234-4123-8123-123456789abc';
const noteId = 'f0000000-0000-4000-8000-000000000001';

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
      if (path === '/git/refs/heads/main' && opts.method === 'PATCH') {
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


test('M116 create → type during Save → next Save UPDATEs the same GitHub Note', async () => {
  const client = fakeGitHub();
  // First Save submits a snapshot while the user continues typing.
  const created = (await commitVaultNoteBatch(client, [{
    action: 'create', id: noteId, note: {
      subjectId, heading: 'Computer networks', answer: 'Chapter 1',
      tags: ['study'], favorite: false,
    },
  }])).results[0];
  const stored = await readVaultNote(client, noteId);
  assert.equal(stored.answer, 'Chapter 1');
  assert.equal(created.id, noteId);

  const newerText = { heading: 'Computer networks', answer: 'Chapter 1 and 2',
    tagsText: 'study, exam' };
  const transition = stageVaultFollowupSave([], {
    ...created, subjectSlug: created.subjectId,
  }, newerText);
  assert.equal(transition.editingId, noteId);
  assert.equal(transition.newDraftId, '');
  assert.equal(transition.baseline.answer, 'Chapter 1');
  assert.equal(transition.pendingDraft.answer, 'Chapter 1 and 2');
  assert.equal(transition.pendingDraft.baseSha, created.sha);
  assert.deepEqual(transition.pendingDraft.tags, ['study', 'exam']);
  assert.equal(validatedHybridDraft(transition.pendingDraft).baseSha, created.sha);
  assert.equal(transition.notes.length, 1);
  assert.equal(transition.notes[0].sha, created.sha);

  // Second explicit Save uses the confirmed GitHub revision and the same
  // Note UUID. The old create path would conflict instead.
  const updated = (await commitVaultNoteBatch(client, [{
    action: 'update', id: transition.editingId,
    sha: transition.notes[0].sha,
    note: { subjectId, heading: newerText.heading, answer: newerText.answer,
      tags: transition.pendingDraft.tags, favorite: false },
  }])).results[0];
  assert.equal(updated.id, created.id);
  assert.notEqual(updated.sha, created.sha);
  assert.equal((await readVaultNote(client, noteId)).answer, 'Chapter 1 and 2');
  const page = await listVaultNotePage(client, { limit: 20 });
  assert.equal(page.total, 1, 'no duplicate Note or second ID was created');
  assert.equal(page.notes.length, 1);
  assert.equal(page.notes[0].answer, 'Chapter 1 and 2');
});

test('M116 editing an existing Note replaces stale loaded SHA but preserves unsaved typing', () => {
  const old = {
    id: noteId, subjectSlug: subjectId, sha: 'a'.repeat(40),
    heading: 'Python', answer: 'Old version', tags: ['practice'], favorite: true,
  };
  const saved = { ...old, sha: 'b'.repeat(40),
    answer: 'Saved version', tags: ['practice', 'ml'] };
  const editor = { heading: 'Python', answer: 'Newer unsaved version',
    tagsText: 'practice, ml, 2026' };
  const result = stageVaultFollowupSave([old], saved, editor);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].sha, saved.sha);
  assert.equal(result.baseline.answer, 'Saved version');
  assert.equal(result.pendingDraft.answer, editor.answer);
  assert.equal(result.pendingDraft.baseSha, saved.sha);
  assert.equal(result.pendingDraft.favorite, true);
  assert.deepEqual(result.pendingDraft.tags, ['practice', 'ml', '2026']);
  // A fast reload can safely restore this browser copy against the just
  // confirmed Note revision instead of rejecting the old baseSha.
  const storage = new Map();
  storage.set(noteId, JSON.stringify({ draft: result.pendingDraft }));
  assert.equal(JSON.parse(storage.get(noteId)).draft.baseSha, saved.sha);
});

test('M116 refuses missing GitHub revision or malformed confirmed Notes', () => {
  const good = { id: noteId, subjectSlug: subjectId, sha: 'f'.repeat(40),
    heading: 'Data', answer: 'Saved', favorite: false, tags: [] };
  const editor = { heading: 'Data', answer: 'Still writing', tagsText: '' };
  for (const invalid of [
    { ...good, sha: '' }, { ...good, id: 'not-id' },
    { ...good, subjectSlug: 'invalid' },
    { ...good, tags: 'tags' },
  ]) assert.throws(() => stageVaultFollowupSave([], invalid, editor), TypeError);
  assert.throws(() => stageVaultFollowupSave([], good, null), TypeError);
  assert.throws(() => stageVaultFollowupSave(null, good, editor), TypeError);
});

test('M116 real Notes page promotes a confirmed first Save to editable PUT state', async () => {
  const ui = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  assert.match(ui, /stageVaultFollowupSave\(notes, note, liveEditorRef\.current\)/);
  assert.match(ui, /setNotes\(\(existing\) => mergeRecentVaultNotes\(existing, \[note\]\)\)/);
  assert.match(ui, /setEditingId\(followup\.editingId\)/);
  assert.match(ui, /setNewDraftId\(followup\.newDraftId\)/);
  assert.match(ui, /editorInitialRef\.current = followup\.baseline/);
  assert.match(ui, /setEditorBaseline\(followup\.baseline\)/);
  assert.match(ui, /JSON\.stringify\(\{ draft: followup\.pendingDraft \}\)/);
  assert.match(ui, /method: editingId \? 'PUT' : 'POST'/);
  assert.match(ui, /current\.sha/);
  assert.match(ui, /press Save again to update the same Note/);
  assert.match(ui, /if \(hybridDrafts && vaultMode &&\s+JSON\.stringify\(liveEditorRef\.current\) !== submittedEditor\)/);
});
