import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  standaloneCapturePath, validatedStandaloneCapture,
  readVaultStandaloneSnapshot, listVaultStandaloneCaptures,
  getVaultStandaloneCapture, commitVaultStandaloneCapture,
} from '../lib/oge-vault-standalone-captures.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (s) => createHash('sha1').update(s).digest('hex');
const blobHash = (text) => H('blob ' + Buffer.byteLength(text) + '\0' + text);
const NOW = '2026-11-16T15:00:00.000Z';
const subjectId = randomUUID();

function fixture() {
  const commits = new Map(), trees = new Map(), blobs = new Map();
  const operations = [];
  let seq = 0;
  let head = H('m70-initial-head'), patchCount = 0, afterRefWriteLost = false;
  let rejectPatch = false, compete = false, forgedParent = false;
  const emptyTree = H('m70-initial-tree');
  trees.set(emptyTree, new Map());
  commits.set(head, {
    tree: { sha: emptyTree }, parents: [], message: 'Initial test commit',
  });
  function makeExternalCommit() {
    const prev = commits.get(head);
    const sha = H('m70-competing-' + (++seq));
    commits.set(sha, { tree: prev.tree, parents: [head] });
    head = sha;
    return sha;
  }
  const client = {
    branch: 'main', readOnly: false,
    vault: { repoId: 1001, repoName: 'ogenotes-vault' },
    async call(path, opts = {}) {
      const method = opts.method || 'GET';
      operations.push({ path, method, body: opts.body });
      if (path === '/git/ref/heads/main') {
        if (method === 'GET') return { object: { sha: head } };
        if (method !== 'PATCH') throw Error('wrong ref verb');
        patchCount++;
        if (compete) {
          compete = false;
          makeExternalCommit();
        }
        const next = opts.body?.sha;
        if (opts.body.force !== false) throw Error('force true forbidden');
        if (rejectPatch || !commits.has(next) ||
            commits.get(next).parents[0] !== head)
          throw new VaultGitHubError('github-repository-conflict', 422);
        head = next;
        if (afterRefWriteLost)
          throw new VaultGitHubError('github-network-unavailable', 503);
        return { object: { sha: head } };
      }
      if (method === 'GET' && path.startsWith('/git/commits/')) {
        const commit = commits.get(path.slice('/git/commits/'.length));
        if (!commit) throw new VaultGitHubError('github-api-error', 404);
        return { ...commit, parents: forgedParent &&
          path.slice('/git/commits/'.length) !== H('m70-initial-head') ?
          [H('unrelated')] : commit.parents };
      }
      if (method === 'GET' && path.startsWith('/git/trees/')) {
        const sha = path.slice('/git/trees/'.length).split('?')[0];
        const tree = trees.get(sha);
        if (!tree) throw Error('unavailable tree');
        return { tree: [...tree].map(([name, item]) => ({
          path: name, type: 'blob', mode: '100644',
          sha: item.sha, size: Buffer.byteLength(item.text),
        })), truncated: false };
      }
      if (path === '/git/trees' && method === 'POST') {
        const base = trees.get(opts.body.base_tree);
        if (!base) throw Error('unknown base tree');
        const next = new Map(base);
        for (const item of opts.body.tree) {
          if (item.mode !== '100644' || item.type !== 'blob') throw Error('bad tree write');
          if (item.sha === null) next.delete(item.path);
          else {
            const sha = blobHash(item.content);
            blobs.set(sha, item.content);
            next.set(item.path, { sha, text: item.content });
          }
        }
        const sha = H('m70-tree-' + (++seq));
        trees.set(sha, next);
        return { sha };
      }
      if (path === '/git/commits' && method === 'POST') {
        const parents = opts.body.parents;
        const sha = H('m70-commit-' + (++seq));
        commits.set(sha, {
          tree: { sha: opts.body.tree }, parents,
          message: opts.body.message,
        });
        return { sha };
      }
      if (path.startsWith('/git/blobs/') && method === 'GET') {
        const sha = path.slice('/git/blobs/'.length), content = blobs.get(sha);
        if (!content) throw new VaultGitHubError('github-api-error', 404);
        return { sha, encoding: 'base64', size: Buffer.byteLength(content),
          content: Buffer.from(content).toString('base64') };
      }
      throw new Error('unexpected GitHub API path: ' + method + ' ' + path);
    },
  };
  return {
    client, operations, trees, blobs, commits,
    get head() { return head; },
    get patchCount() { return patchCount; },
    set afterRefWriteLost(value) { afterRefWriteLost = value; },
    set rejectPatch(value) { rejectPatch = value; },
    set compete(value) { compete = value; },
    set forgedParent(value) { forgedParent = value; },
    makeExternalCommit,
    addRaw(kind, id, payload) {
      const previous = commits.get(head).tree.sha;
      const next = new Map(trees.get(previous));
      const text = payload;
      const sha = blobHash(text);
      blobs.set(sha, text);
      next.set(standaloneCapturePath(kind, id), { sha, text });
      const tree = H('test-external-tree-' + (++seq));
      trees.set(tree, next);
      const commitSha = H('test-external-commit-' + (++seq));
      commits.set(commitSha, { tree: { sha: tree }, parents: [head] });
      head = commitSha;
    },
    removeHeadData() { return trees.get(commits.get(head).tree.sha); },
  };
}

test('M70 standalone type paths are disjoint and never accept arbitrary file paths', () => {
  const id = randomUUID();
  assert.equal(standaloneCapturePath('quick-notes', id),
    'quick-notes/' + id + '.json');
  assert.equal(standaloneCapturePath('airnotes', id), 'airnotes/' + id + '.json');
  for (const invalid of [
    ['notes', id], ['../quick-notes', id], ['quick-notes', '../owner'],
    ['airnotes', 'file.txt'], ['quick-notes', 'not-an-id'],
  ]) assert.throws(() => standaloneCapturePath(...invalid), TypeError);
});

test('M70 canonical Quick Notes/AirNotes text, titles, timestamps and schema are validated', () => {
  const id = randomUUID();
  for (const kind of ['quick-notes', 'airnotes']) {
    const value = validatedStandaloneCapture(kind,
      { content: ' First line \r\n second line ' }, { id, now: NOW });
    assert.equal(value.id, id);
    assert.equal(value.content, ' First line \n second line ');
    assert.equal(value.title, 'First line');
    assert.equal(value.updatedAt, NOW);
    assert.equal(value.createdAt, NOW);
    assert.equal(value.version, 1);
    assert.ok(value.format.startsWith('ogenotes-'));
    assert.equal(validatedStandaloneCapture(kind,
      { content: '' }, { id, now: NOW }).title, 'New note');
    assert.throws(() => validatedStandaloneCapture(kind,
      { content: 'x'.repeat(20001) }, { id, now: NOW }), TypeError);
    assert.throws(() => validatedStandaloneCapture(kind,
      { content: 'a'.repeat(19000) + '🎓'.repeat(1000) },
      { id, now: NOW }), TypeError, 'UTF8 byte bound');
    assert.throws(() => validatedStandaloneCapture(kind,
      { content: 'Valid', createdAt: '2027-01-01T00:00:00.000Z' },
      { id, now: NOW }), TypeError);
  }
});

test('M70 isolated GitHub create/update/delete and read/list preserve correct types and CAS', async () => {
  const f = fixture();
  const quickId = randomUUID(), airId = randomUUID();
  const q = await commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'create', id: quickId, content: 'Quick title\nbody',
  }, { now: NOW });
  assert.equal(q.kind, 'quick-notes');
  assert.equal(q.content, 'Quick title\nbody');
  assert.equal(q.sha.length, 40);
  assert.equal(f.patchCount, 1);
  assert.equal((await getVaultStandaloneCapture(f.client,
    'quick-notes', quickId)).title, 'Quick title');
  assert.equal((await listVaultStandaloneCaptures(f.client, 'airnotes')).length, 0);
  const a = await commitVaultStandaloneCapture(f.client, {
    kind: 'airnotes', action: 'create', id: airId, content: 'Air entry',
  }, { now: NOW });
  assert.equal(a.kind, 'airnotes');
  assert.equal((await listVaultStandaloneCaptures(f.client, 'quick-notes')).length, 1);
  assert.equal((await listVaultStandaloneCaptures(f.client, 'airnotes')).length, 1);
  const revision = await commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'update', id: quickId,
    content: 'Revised quick entry', sha: q.sha,
  }, { now: '2026-11-16T15:01:00.000Z' });
  assert.equal(revision.createdAt, NOW);
  assert.equal(revision.content, 'Revised quick entry');
  assert.notEqual(revision.sha, q.sha);
  await assert.rejects(commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'update', id: quickId,
    content: 'Stale update', sha: q.sha,
  }), e => e instanceof VaultGitHubError && e.status === 409);
  await assert.rejects(commitVaultStandaloneCapture(f.client, {
    kind: 'airnotes', action: 'delete', id: quickId, sha: revision.sha,
  }), e => e instanceof VaultGitHubError && e.status === 409);
  const deleted = await commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'delete', id: quickId, sha: revision.sha,
  });
  assert.equal(deleted.deleted, true);
  assert.equal((await listVaultStandaloneCaptures(f.client, 'quick-notes')).length, 0);
  assert.equal((await listVaultStandaloneCaptures(f.client, 'airnotes')).length, 1);
  await assert.rejects(getVaultStandaloneCapture(f.client, 'quick-notes', quickId),
    e => e instanceof VaultGitHubError && e.status === 404);
});

test('M70 write requires exact stable client-supplied UUID and revision SHA; no mutation on bad input', async () => {
  const f = fixture();
  for (const bad of [
    { kind: 'quick-notes', action: 'create', content: 'no id' },
    { kind: 'quick-notes', action: 'create', id: randomUUID(), sha: 'a'.repeat(40), content: 'invalid' },
    { kind: 'airnotes', action: 'update', id: randomUUID(), content: 'missing sha' },
    { kind: 'airnotes', action: 'delete', id: randomUUID(), sha: 'a'.repeat(40), content: 'no content here' },
    { kind: 'airnotes', action: 'delete', id: '../../../a', sha: 'b'.repeat(40) },
  ]) await assert.rejects(commitVaultStandaloneCapture(f.client, bad));
  assert.equal(f.patchCount, 0);
  const readOnly = { ...f.client, readOnly: true };
  await assert.rejects(commitVaultStandaloneCapture(readOnly, {
    kind: 'airnotes', action: 'create', id: randomUUID(), content: 'X',
  }), TypeError);
  assert.equal(f.patchCount, 0);
});

test('M70 duplicate create, stale editor SHA and fabricated wrong-kind ID fail before write', async () => {
  const f = fixture(), id = randomUUID();
  const save = await commitVaultStandaloneCapture(f.client, {
    kind: 'airnotes', action: 'create', id, content: 'Original',
  });
  const before = f.patchCount;
  await assert.rejects(commitVaultStandaloneCapture(f.client, {
    kind: 'airnotes', action: 'create', id, content: 'Duplicate',
  }), e => e.status === 409);
  await assert.rejects(commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'update', id, sha: save.sha,
    content: 'Cross-type overwrite',
  }), e => e.status === 409);
  assert.equal(f.patchCount, before);
});

test('M70 lost ref PATCH response after successful CAS is verified exactly once', async () => {
  const f = fixture(), id = randomUUID();
  f.afterRefWriteLost = true;
  const saved = await commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'create', id, content: 'Dropped response',
  });
  assert.equal(f.patchCount, 1);
  assert.equal(saved.content, 'Dropped response');
  assert.equal(saved.commitSha, f.head);
});

test('M70 actual ref rejection or external writer non-fast-forward never overwrites winner/retries', async () => {
  for (const mode of ['reject', 'compete']) {
    const f = fixture(), id = randomUUID();
    if (mode === 'reject') f.rejectPatch = true;
    else f.compete = true;
    await assert.rejects(commitVaultStandaloneCapture(f.client, {
      kind: 'airnotes', action: 'create', id, content: 'Must not overwrite',
    }), e => e instanceof VaultGitHubError && e.status === 409);
    assert.equal(f.patchCount, 1);
    assert.equal(f.removeHeadData().has(standaloneCapturePath('airnotes', id)), false);
  }
});

test('M70 commit ancestry mismatch after remote success remains unconfirmed', async () => {
  const f = fixture();
  f.forgedParent = true;
  await assert.rejects(commitVaultStandaloneCapture(f.client, {
    kind: 'quick-notes', action: 'create',
    id: randomUUID(), content: 'Cannot attest',
  }), e => e.status === 503);
  assert.equal(f.patchCount, 1);
});

test('M70 read-only GET verifies all blob schemas, never returns truncated lists or corrupt blobs', async () => {
  const f = fixture(), id = randomUUID();
  f.addRaw('quick-notes', id, '{"untrusted":"private"}');
  await assert.rejects(listVaultStandaloneCaptures(f.client, 'quick-notes'),
    e => e instanceof VaultGitHubError && e.status === 409);
  const s = await readVaultStandaloneSnapshot(f.client, 'quick-notes');
  assert.equal(s.files.size, 1);
  assert.equal((await listVaultStandaloneCaptures(f.client, 'airnotes')).length, 0);
});

test('M70 route is opt-in isolated and signed owner-only; no legacy collection content use', async () => {
  const code = await readFile(new URL(
    '../app/api/vault/standalone/route.js', import.meta.url), 'utf8');
  assert.match(code, /OGE_VAULT_STANDALONE_PREVIEW === 'true'/);
  assert.match(code, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(code, /oge_vault_restore_staging_/);
  assert.match(code, /const session = await auth\(\)/);
  assert.match(code, /getVaultNoteClient\(db, identity, \{ readOnly \}\)/);
  assert.match(code, /withVaultOwnerDraftWrite\(ctx\.db, scope/);
  assert.match(code, /commitVaultStandaloneCapture\(ctx\.client/);
  assert.match(code, /checkOwnerMutationLimit/);
  assert.match(code, /getVaultStandaloneCapture\(ctx\.client/);
  assert.match(code, /listVaultStandaloneCaptures\(ctx\.client/);
  assert.doesNotMatch(code,
    /collection\(['"](?:notes|quickNotes|personalQuickNotes)['"]\)|\.insertOne\(|\.deleteOne\(|\.updateOne\(/);
});

test('M70 GitHub standalone storage never creates MongoDB content, calls extension API or retries writes', async () => {
  const lib = await readFile(new URL(
    '../lib/oge-vault-standalone-captures.js', import.meta.url), 'utf8');
  assert.match(lib, /force: false/);
  assert.match(lib, /Zero MongoDB content writes/);
  assert.match(lib, /'quick-notes\/'/);
  assert.match(lib, /'airnotes\/'/);
  assert.doesNotMatch(lib,
    /MongoClient|collection\(|insertOne\(|updateOne\(|deleteOne\(|localStorage|sessionStorage|Bearer |fetch\(|setTimeout\(/);
  assert.equal(typeof subjectId, 'string');
});
