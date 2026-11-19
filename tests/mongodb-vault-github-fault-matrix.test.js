import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { executeApprovedVaultNotesImport } from '../lib/oge-vault-backup-import-commit.js';
import { inspectVaultImportArchiveContentReadOnly } from '../lib/oge-vault-import-archive-proof.js';
import { withVaultOwnerImportExclusive, withVaultOwnerDraftWrite } from '../lib/oge-vault-import-fence.js';
import { withVaultSubjectsWrite } from '../lib/oge-vault-subject-fence.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = {
  skip: !uri ? 'Requires disposable localhost MongoDB replica-set CI' : false,
};
const H = (value) => createHash('sha1').update(value).digest('hex');
const BASE = H('m52-provider-base');
const BASE_TREE = H('m52-provider-base-tree');

async function isolatedDatabase(work) {
  if (!uri ||
      !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw new Error('Only an explicitly opted-in disposable local Mongo replica set is permitted');
  const connection = new MongoClient(uri, {
    maxPoolSize: 4, serverSelectionTimeoutMS: 8000,
  });
  await connection.connect();
  const db = connection.db('oge_ci_provider_faults_' + randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw new Error('MongoDB replica set is required');
    await work(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await connection.close();
  }
}

/**
 * A deterministic private Git object store. The actual import adapter and
 * commitVaultNoteBatch run unchanged, including Git tree/commit/ref creation,
 * immutable ancestry checking and final /contents verification. Only HTTP
 * transport is simulated; there are NO live GitHub accounts or external I/O.
 */
function fakeGitHub(mode) {
  let head = BASE;
  let serial = 0;
  let patchCalls = 0, treePosts = 0, commitPosts = 0;
  const events = [];
  const contents = new Map();
  const initial = new Map([['README.md', {
    text: 'synthetic fixture', sha: H('synthetic-readme'), mode: '100644',
  }]]);
  const trees = new Map([[BASE_TREE, initial]]);
  const commits = new Map([[BASE, {
    sha: BASE, tree: { sha: BASE_TREE }, parents: [], message: 'Fixture base',
  }]]);
  let onceAfterPatch = false;
  const client = {
    branch: 'main',
    vault: { status: 'connected', repoId: 5292, installationId: 22,
      githubAccountId: '41', githubLogin: 'synthetic-owner', repoName: 'ogenotes-vault' },
    async call(path, options = {}) {
      const method = options.method || 'GET';
      events.push([method, path]);
      if (mode === 'rate-before-write' && path === '/git/ref/heads/main' &&
          method === 'GET' && patchCalls === 0 && treePosts === 0)
        throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main' && method === 'GET') {
        if (mode === 'postpatch-head-rate' && patchCalls > 0 && !onceAfterPatch) {
          onceAfterPatch = true;
          throw new VaultGitHubError('github-rate-limited', 429);
        }
        return { object: { sha: head } };
      }
      if (path.startsWith('/git/commits/') && method === 'GET') {
        const commit = commits.get(path.slice('/git/commits/'.length));
        if (!commit) throw new VaultGitHubError('github-api-error', 404);
        return commit;
      }
      if (path.startsWith('/git/trees/') && method === 'GET') {
        const tree = trees.get(path.slice('/git/trees/'.length).split('?')[0]);
        if (!tree) throw new VaultGitHubError('github-api-error', 404);
        return { truncated: false, tree: [...tree].map(([filePath, file]) => ({
          path: filePath, type: 'blob', mode: file.mode, sha: file.sha,
          size: Buffer.byteLength(file.text),
        })) };
      }
      if (path === '/git/trees' && method === 'POST') {
        treePosts++;
        if (mode === 'rate-at-tree')
          throw new VaultGitHubError('github-rate-limited', 429);
        const original = trees.get(options.body.base_tree);
        if (!original) throw new Error('Missing base tree in synthetic Git');
        const next = new Map(original);
        for (const change of options.body.tree) {
          if (change.sha === null) next.delete(change.path);
          else next.set(change.path, {
            text: change.content, sha: H(change.content),
            mode: change.mode,
          });
        }
        const sha = H('m52-tree-' + (++serial));
        trees.set(sha, next);
        return { sha };
      }
      if (path === '/git/commits' && method === 'POST') {
        commitPosts++;
        const sha = H('m52-commit-' + (++serial));
        const commit = {
          sha, tree: { sha: options.body.tree },
          parents: [...options.body.parents], message: options.body.message,
        };
        commits.set(sha, commit);
        return { sha };
      }
      if (path === '/git/ref/heads/main' && method === 'PATCH') {
        patchCalls++;
        assert.equal(options.body.force, false, 'only non-force Git ref mutations');
        const commit = commits.get(options.body.sha);
        if (mode === 'competing-ref') {
          // An unrelated GitHub writer advances the HEAD between the
          // approved import plan and the non-fast-forward patch.
          const treeSha = H('m52-external-tree');
          const next = new Map(trees.get(BASE_TREE));
          next.set('README.md', {
            text: 'external user revision', sha: H('external-user-revision'),
            mode: '100644',
          });
          trees.set(treeSha, next);
          head = H('m52-external-commit');
          commits.set(head, { sha: head, tree: { sha: treeSha },
            parents: [BASE], message: 'External unrelated change' });
          throw new VaultGitHubError('github-repository-conflict', 422);
        }
        if (!commit?.parents?.includes(head))
          throw new VaultGitHubError('github-repository-conflict', 422);
        head = options.body.sha;
        if (mode === 'lost-afterwrite')
          throw new VaultGitHubError('github-network-unavailable', 503);
        if (mode === 'conflict-response-afterwrite')
          throw new VaultGitHubError('github-repository-conflict', 422);
        return { object: { sha: head } };
      }
      if (path.startsWith('/contents/') && method === 'GET') {
        if (mode === 'postpatch-contents-rate' && patchCalls > 0 && !onceAfterPatch) {
          onceAfterPatch = true;
          throw new VaultGitHubError('github-rate-limited', 429);
        }
        const filePath = path.slice('/contents/'.length).split('?')[0];
        const file = trees.get(commits.get(head)?.tree?.sha)?.get(filePath);
        if (!file) throw new VaultGitHubError('github-api-error', 404);
        return { type: 'file', encoding: 'base64', sha: file.sha,
          content: Buffer.from(file.text).toString('base64') };
      }
      if (path.startsWith('/git/blobs/') && method === 'GET') {
        const sha = path.slice('/git/blobs/'.length);
        for (const tree of trees.values())
          for (const file of tree.values())
            if (file.sha === sha)
              return { encoding: 'base64',
                content: Buffer.from(file.text).toString('base64') };
        throw new VaultGitHubError('github-api-error', 404);
      }
      throw new Error('Unsupported synthetic Git operation ' + method + ' ' + path);
    },
  };
  return {
    client, events,
    get head() { return head; },
    get treePosts() { return treePosts; },
    get commitPosts() { return commitPosts; },
    get patchCalls() { return patchCalls; },
    get importedFiles() {
      const snapshot = trees.get(commits.get(head)?.tree?.sha);
      return [...(snapshot?.keys() || [])].filter((p) => p.startsWith('notes/'));
    },
    getPlaintextInMongoCandidate() {
      return 'SYNTHETIC_PRIVATE_IMPORT_ANSWER';
    },
  };
}

async function fixture(db, mode) {
  const ownerId = 'm52-owner-' + randomUUID();
  const sessionVersion = randomUUID(), repoId = 5292;
  const subjectId = randomUUID(), noteId = randomUUID();
  const github = fakeGitHub(mode);
  const identity = { ownerId, sessionVersion, repoId };
  await db.collection('users').insertOne({
    googleSub: ownerId, sessionVersion, vault: { ...github.client.vault },
  });
  await db.collection('subjects').insertOne({ ownerId, slug: subjectId });
  const note = validatedNote({ subjectId,
    heading: 'SYNTHETIC_PRIVATE_IMPORT_TITLE',
    answer: 'SYNTHETIC_PRIVATE_IMPORT_ANSWER',
    tags: ['math'], favorite: false,
  }, { id: noteId, now: '2026-11-01T00:00:00.000Z' });
  const approval = {
    archive: {
      format: 'oge-vault-notes-backup', version: 1,
      scope: 'current-github-notes-only', snapshot: H('m52-source-snapshot'),
      totalNotes: 1,
      coverage: {
        notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      },
      notes: [{ ...note, sha: H('source-blob-for-export') }],
    },
    expectedTargetHead: BASE,
    selectedIds: [noteId], confirmation: 'IMPORT_SELECTED_NEW_NOTES',
  };
  const subjectVerifier = async (ids) => {
    const rows = await db.collection('subjects').find({
      ownerId, slug: { $in: ids },
    }, { projection: { _id: 0, slug: 1 } }).toArray();
    return rows.length === ids.length;
  };
  const ownerVerifier = async () => {
    const row = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } });
    return row?.vault?.status === 'connected' &&
      row.vault.repoId === repoId &&
      row.vault.installationId === github.client.vault.installationId &&
      row.vault.githubAccountId === github.client.vault.githubAccountId;
  };
  const pendingDraftIds = async (ids) => (
    await db.collection('vault_drafts').find({
      ownerId, repoId, noteId: { $in: ids },
    }, { projection: { _id: 0, noteId: 1 } }).toArray()
  ).map((x) => x.noteId);
  const perform = async () => withVaultOwnerImportExclusive(db, identity,
    ({ markGitHubWriteAttempt }) => withVaultSubjectsWrite(db, ownerId,
      [subjectId], () => executeApprovedVaultNotesImport(github.client, approval, {
        subjectVerifier, pendingDraftIds, ownerVerifier,
        beforeGitHubWrite: markGitHubWriteAttempt,
        // Deliberately use the PRODUCTION commitVaultNoteBatch default.
      })));
  const readOwner = () => db.collection('users').findOne({ googleSub: ownerId });
  return { identity, noteId, approval, github, perform, readOwner };
}

test('M52 429 during planning performs no GitHub write and releases prewrite fence', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, 'rate-before-write');
    await assert.rejects(f.perform(), (err) => err.status === 429);
    assert.equal(f.github.treePosts, 0);
    assert.equal(f.github.commitPosts, 0);
    assert.equal(f.github.patchCalls, 0);
    assert.equal((await f.readOwner()).vaultImportLock, undefined);
    assert.equal(await db.collection('vault_drafts').countDocuments({}), 0);
  });
});

test('M52 429 on first POST after marker quarantines and never retries the GitHub write', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, 'rate-at-tree');
    await assert.rejects(f.perform(), (err) => err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    assert.equal(f.github.treePosts, 1);
    assert.equal(f.github.commitPosts, 0);
    assert.equal(f.github.patchCalls, 0);
    const lock = (await f.readOwner()).vaultImportLock;
    assert.equal(lock.state, 'github-write-possible');
    assert.deepEqual(lock.selectedIds, [f.noteId]);
    await assert.rejects(f.perform(), (err) => err.status === 409);
    assert.equal(f.github.treePosts, 1);
    await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, async () => {}),
      (err) => err.status === 409);
  });
});

test('M52 competing Git ref 422 preserves external HEAD and leaves ambiguous import quarantined', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await fixture(db, 'competing-ref');
    await assert.rejects(f.perform(), (err) => err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    assert.equal(f.github.treePosts, 1);
    assert.equal(f.github.commitPosts, 1);
    assert.equal(f.github.patchCalls, 1);
    assert.equal(f.github.head, H('m52-external-commit'));
    assert.deepEqual(f.github.importedFiles, []);
    const lock = (await f.readOwner()).vaultImportLock;
    assert.equal(lock.state, 'github-write-possible');
    const proof = await inspectVaultImportArchiveContentReadOnly(db, {
      ...f.identity, expectedOperationId: lock.operationId,
    }, f.github.client, f.approval);
    assert.equal(proof.status, 'ARCHIVE_IMPORT_NOT_CONFIRMED');
    assert.equal(proof.importedContentVerified, false);
    assert.equal(proof.operatorUnlockAuthorized, false);
  });
});

for (const mode of ['lost-afterwrite', 'conflict-response-afterwrite']) {
  test('M52 ' + mode + ' can prove GitHub commit exactly once and release lock on verified success',
    realDatabase, async () => {
      await isolatedDatabase(async (db) => {
        const f = await fixture(db, mode);
        const result = await f.perform();
        assert.equal(result.importedCount, 1);
        assert.deepEqual(result.importedIds, [f.noteId]);
        assert.equal(f.github.treePosts, 1);
        assert.equal(f.github.commitPosts, 1);
        assert.equal(f.github.patchCalls, 1, 'no blind PATCH retry');
        assert.equal(f.github.importedFiles.length, 1);
        assert.equal((await f.readOwner()).vaultImportLock, undefined);
        assert.equal(await db.collection('vault_drafts').countDocuments({}), 0);
        assert.equal(JSON.stringify(await f.readOwner())
          .includes('SYNTHETIC_PRIVATE_IMPORT_ANSWER'), false);
      });
    });
}

for (const mode of ['postpatch-head-rate', 'postpatch-contents-rate']) {
  test('M52 ' + mode + ' after remote commit must quarantine until read-only archival proof',
    realDatabase, async () => {
      await isolatedDatabase(async (db) => {
        const f = await fixture(db, mode);
        await assert.rejects(f.perform(), (err) => err.status === 503 &&
          err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
        assert.equal(f.github.treePosts, 1);
        assert.equal(f.github.commitPosts, 1);
        assert.equal(f.github.patchCalls, 1);
        assert.equal(f.github.importedFiles.length, 1);
        const lock = (await f.readOwner()).vaultImportLock;
        assert.equal(lock.state, 'github-write-possible');
        const proof = await inspectVaultImportArchiveContentReadOnly(db, {
          ...f.identity, expectedOperationId: lock.operationId,
        }, f.github.client, f.approval);
        assert.equal(proof.status, 'ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY');
        assert.equal(proof.importedContentVerified, true);
        assert.equal(proof.operatorUnlockAuthorized, false);
        assert.equal(proof.safeToRetryAutomatically, false);
        assert.equal(f.github.patchCalls, 1, 'proof makes no remote writes');
        assert.equal((await f.readOwner()).vaultImportLock.operationId, lock.operationId);
        const serialized = JSON.stringify(proof);
        for (const value of [f.identity.ownerId, f.noteId,
          'SYNTHETIC_PRIVATE_IMPORT_ANSWER', f.approval.expectedTargetHead])
          assert.equal(serialized.includes(value), false);
      });
    });
}
