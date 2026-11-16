import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { putHybridDraft } from '../lib/oge-vault-hybrid-drafts.js';
import { executeApprovedVaultNotesImport } from '../lib/oge-vault-backup-import-commit.js';
import { withVaultSubjectsWrite } from '../lib/oge-vault-subject-fence.js';
import {
  withVaultOwnerDraftWrite, withVaultOwnerImportExclusive,
} from '../lib/oge-vault-import-fence.js';
import { inspectVaultImportArchiveContentReadOnly } from '../lib/oge-vault-import-archive-proof.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const uri = process.env.OGE_TEST_MONGODB_URI;
const realDatabase = { skip: !uri ? 'Requires the disposable local MongoDB replica set' : false };
const H = (s) => createHash('sha1').update(s).digest('hex');
const key = 'a'.repeat(64);
const BASE = H('two-device-base'), NEXT = H('two-device-import');
const BASE_TREE = H('two-device-base-tree'), NEXT_TREE = H('two-device-next-tree');
const BLOB = H('two-device-blob');

async function isolatedDatabase(run) {
  if (!uri || !/^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) ||
      process.env.OGE_ALLOW_MONGO_INTEGRATION_TESTS !== 'YES_DISPOSABLE_DATABASE')
    throw Error('Disposable local replica set required');
  const client = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db('oge_ci_multidevice_' + randomUUID().replaceAll('-', ''));
  try {
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw Error('Mongo replica set required');
    await run(db);
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

function draft(subjectId, answer) {
  return { subjectId, heading: 'Private unsynced editor',
    answer, tags: [], favorite: false, baseSha: null };
}

async function environment(db) {
  const ownerId = 'two-device-' + randomUUID(), repoId = 9202;
  const sessionVersion = randomUUID(), subjectId = randomUUID(), noteId = randomUUID();
  const identity = { ownerId, repoId, sessionVersion };
  const vault = { status: 'connected', repoId, installationId: 4,
    githubAccountId: '44', githubLogin: 'synthetic-owner', repoName: 'ogenotes-vault' };
  await db.collection('users').insertOne({
    googleSub: ownerId, sessionVersion, vault,
  });
  await db.collection('subjects').insertOne({ ownerId, slug: subjectId });
  const note = validatedNote({ subjectId,
    heading: 'PRIVATE_IMPORTED_HEADING', answer: 'PRIVATE_IMPORTED_ANSWER',
    tags: ['archive'], favorite: true,
  }, { id: noteId, now: '2026-11-01T08:00:00.000Z' });
  const request = {
    archive: {
      format: 'oge-vault-notes-backup', version: 1,
      scope: 'current-github-notes-only', snapshot: H('source-archive'),
      totalNotes: 1,
      coverage: {
        notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      },
      notes: [{ ...note, sha: H('source-note-blob') }],
    },
    expectedTargetHead: BASE, selectedIds: [noteId],
    confirmation: 'IMPORT_SELECTED_NEW_NOTES',
  };
  let head = BASE, githubWrites = 0;
  const client = { branch: 'main', vault,
    async call(path, options = {}) {
      if (options.method && options.method !== 'GET')
        throw Error('Only simulated batch writer may mutate GitHub');
      if (path === '/git/ref/heads/main') return { object: { sha: head } };
      if (path === '/git/commits/' + BASE)
        return { sha: BASE, tree: { sha: BASE_TREE }, parents: [] };
      if (path === '/git/commits/' + NEXT && head === NEXT)
        return { sha: NEXT, tree: { sha: NEXT_TREE },
          parents: [{ sha: BASE }], message: state.message };
      if (path === '/git/trees/' + BASE_TREE + '?recursive=1')
        return { truncated: false, tree: [
          { path: 'README.md', type: 'blob', mode: '100644', sha: H('readme') },
        ] };
      if (path === '/git/trees/' + NEXT_TREE + '?recursive=1' && head === NEXT)
        return { truncated: false, tree: [
          { path: 'README.md', type: 'blob', mode: '100644', sha: H('readme') },
          { path: 'notes/' + noteId + '.json',
            type: 'blob', mode: '100644', sha: BLOB, size: 500 },
        ] };
      if (path === '/git/blobs/' + BLOB && head === NEXT)
        return { encoding: 'base64',
          content: Buffer.from(JSON.stringify(note), 'utf8').toString('base64') };
      throw Error('Unexpected simulated GitHub read');
    },
  };
  const state = { get head() { return head; }, message: null,
    get writes() { return githubWrites; },
    persist(message) { githubWrites++; state.message = message; head = NEXT; } };
  const subjectVerifier = async (ids) => {
    const subjects = await db.collection('subjects').find({
      ownerId, slug: { $in: ids },
    }, { projection: { _id: 0, slug: 1 } }).toArray();
    return subjects.length === ids.length;
  };
  const pendingDraftIds = async (ids) => {
    const rows = await db.collection('vault_drafts').find({
      ownerId, repoId, noteId: { $in: ids },
    }, { projection: { noteId: 1, _id: 0 } }).toArray();
    return rows.map((x) => x.noteId);
  };
  const ownerVerifier = async () => {
    const row = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }));
    return row?.vault?.status === 'connected' &&
      row.vault.repoId === repoId && row.vault.installationId === vault.installationId;
  };
  async function approvedImport(batchWriter, { afterMark } = {}) {
    return withVaultOwnerImportExclusive(db, identity,
      ({ markGitHubWriteAttempt }) => withVaultSubjectsWrite(
        db, ownerId, [subjectId], () => executeApprovedVaultNotesImport(
          client, request, {
            subjectVerifier, pendingDraftIds, ownerVerifier,
            beforeGitHubWrite: async (...args) => {
              await markGitHubWriteAttempt(...args);
              if (afterMark) await afterMark();
            },
            batchWriter,
          })));
  }
  return { identity, subjectId, noteId, note, request, client, state,
    approvedImport, ownerVerifier, subjectVerifier };
}

function gate() {
  let notify, release;
  return { entered: new Promise((resolve) => { notify = resolve; }),
    finish: new Promise((resolve) => { release = resolve; }),
    notify: () => notify(), release: () => release() };
}
const confirmedWrite = (f, operations, options) => {
  f.state.persist(options.commitMessage);
  return { commitSha: NEXT, results: operations.map((op) =>
    ({ action: 'create', ...op.note, sha: BLOB })) };
};

test('M50 two devices: in-flight encrypted autosave blocks import, and persisted draft causes create conflict', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db), g = gate();
    const draftPromise = withVaultOwnerDraftWrite(db, f.identity, async () => {
      await putHybridDraft(db.collection('vault_drafts'),
        { ...f.identity, noteId: f.noteId }, 1,
        draft(f.subjectId, 'PRIVATE_UNSAVED_DEVICE_B'), { key });
      g.notify();
      await g.finish;
    });
    try {
      await g.entered;
      await assert.rejects(f.approvedImport(async () => {
        throw Error('GitHub must not write');
      }), (err) => err.status === 409);
    } finally { g.release(); await draftPromise; }
    await assert.rejects(f.approvedImport(async () => {
      throw Error('GitHub must not write');
    }), (err) => err.message === 'vault-import-selected-note-conflict');
    assert.equal(f.state.writes, 0);
    const saved = await db.collection('vault_drafts').findOne({
      ownerId: f.identity.ownerId, repoId: f.identity.repoId, noteId: f.noteId,
    });
    assert.equal(saved.revision, 1);
    assert.ok(saved.encrypted.ciphertext);
    assert.equal(JSON.stringify(saved).includes('PRIVATE_UNSAVED_DEVICE_B'), false);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    })).vaultImportLock, undefined);
  });
});

test('M50 two devices: active import denies second autosave, confirmed import then permits encrypted draft', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db), g = gate();
    const importing = f.approvedImport(async (_client, ops, options) => {
      g.notify();
      await g.finish;
      return confirmedWrite(f, ops, options);
    });
    try {
      await g.entered;
      const lock = (await db.collection('users').findOne({
        googleSub: f.identity.ownerId,
      })).vaultImportLock;
      assert.equal(lock.state, 'github-write-possible');
      await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, () =>
        putHybridDraft(db.collection('vault_drafts'),
          { ...f.identity, noteId: randomUUID() }, 1,
          draft(f.subjectId, 'PRIVATE_DEVICE_B_REJECTED'), { key })),
      (err) => err.status === 409);
      assert.equal(await db.collection('vault_drafts').countDocuments({
        ownerId: f.identity.ownerId,
      }), 0);
    } finally { g.release(); }
    const result = await importing;
    assert.equal(result.importedCount, 1);
    assert.equal(f.state.head, NEXT);
    assert.equal(f.state.writes, 1);
    const newId = randomUUID();
    await withVaultOwnerDraftWrite(db, f.identity, () =>
      putHybridDraft(db.collection('vault_drafts'),
        { ...f.identity, noteId: newId }, 1,
        draft(f.subjectId, 'PRIVATE_NEW_DEVICE_B_DRAFT'), { key }));
    const saved = await db.collection('vault_drafts').findOne({ noteId: newId });
    assert.ok(saved.encrypted.ciphertext);
    assert.equal(JSON.stringify(saved).includes('PRIVATE_NEW_DEVICE_B_DRAFT'), false);
    assert.equal(JSON.stringify(await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    })).includes('PRIVATE_IMPORTED_ANSWER'), false);
  });
});

test('M50 two devices: lost GitHub acknowledgment quarantines writes but full archive proves history read-only', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db);
    await assert.rejects(f.approvedImport(async (_client, ops, options) => {
      confirmedWrite(f, ops, options); // Simulated GitHub HEAD advanced.
      throw new VaultGitHubError('synthetic-lost-ack', 503);
    }), (err) => err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    assert.equal(f.state.writes, 1);
    const lock = (await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    })).vaultImportLock;
    assert.equal(lock.state, 'github-write-possible');
    assert.deepEqual(lock.selectedIds, [f.noteId]);
    await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, async () => {}),
      (err) => err.status === 409);
    await assert.rejects(f.approvedImport(async () => {
      throw Error('No second GitHub import should execute');
    }), (err) => err.status === 409);
    const evidence = await inspectVaultImportArchiveContentReadOnly(db, {
      ...f.identity, expectedOperationId: lock.operationId,
    }, f.client, f.request);
    assert.equal(evidence.status, 'ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY');
    assert.equal(evidence.importedContentVerified, true);
    assert.equal(evidence.operatorUnlockAuthorized, false);
    assert.equal(evidence.safeToRetryAutomatically, false);
    assert.equal(f.state.writes, 1);
    assert.equal((await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    })).vaultImportLock.operationId, lock.operationId);
    const serialized = JSON.stringify(evidence);
    for (const privateText of ['PRIVATE_IMPORTED_HEADING',
      'PRIVATE_IMPORTED_ANSWER', f.identity.ownerId, f.noteId])
      assert.equal(serialized.includes(privateText), false);
  });
});

test('M51 two devices: different-subject in-flight draft of same ID blocks approved import', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db), otherSubject = randomUUID(), g = gate();
    await db.collection('subjects').insertOne({
      ownerId: f.identity.ownerId, slug: otherSubject,
    });
    const draftPromise = withVaultOwnerDraftWrite(db, f.identity, () =>
      withVaultSubjectsWrite(db, f.identity.ownerId, [otherSubject], async () => {
        await putHybridDraft(db.collection('vault_drafts'),
          { ...f.identity, noteId: f.noteId }, 1,
          draft(otherSubject, 'PRIVATE_CROSS_SUBJECT_UNSAVED'), { key });
        g.notify();
        await g.finish;
      }));
    try {
      await g.entered;
      await assert.rejects(f.approvedImport(async () => {
        throw Error('GitHub must not write while other subject has draft');
      }), (err) => err.status === 409);
    } finally { g.release(); await draftPromise; }
    await assert.rejects(f.approvedImport(async () => {
      throw Error('GitHub must not overwrite cross-subject draft');
    }), (err) => err.message === 'vault-import-selected-note-conflict');
    const row = await db.collection('vault_drafts').findOne({
      ownerId: f.identity.ownerId, repoId: f.identity.repoId, noteId: f.noteId,
    });
    assert.ok(row.encrypted.ciphertext);
    assert.equal(JSON.stringify(row).includes('PRIVATE_CROSS_SUBJECT_UNSAVED'), false);
    assert.equal(f.state.writes, 0);
  });
});

test('M51 two devices: import in subject A blocks a new draft in unrelated subject B', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db), otherSubject = randomUUID(), g = gate();
    await db.collection('subjects').insertOne({
      ownerId: f.identity.ownerId, slug: otherSubject,
    });
    const importing = f.approvedImport(async (_client, ops, options) => {
      g.notify();
      await g.finish;
      return confirmedWrite(f, ops, options);
    });
    try {
      await g.entered;
      await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, () =>
        withVaultSubjectsWrite(db, f.identity.ownerId, [otherSubject], () =>
          putHybridDraft(db.collection('vault_drafts'),
            { ...f.identity, noteId: randomUUID() }, 1,
            draft(otherSubject, 'PRIVATE_CROSS_SUBJECT_DEVICE_B'), { key }))),
      (err) => err.status === 409);
      assert.equal(await db.collection('vault_drafts').countDocuments({
        ownerId: f.identity.ownerId, repoId: f.identity.repoId,
      }), 0);
    } finally { g.release(); }
    assert.equal((await importing).importedCount, 1);
    assert.equal(f.state.writes, 1);
    const newId = randomUUID();
    await withVaultOwnerDraftWrite(db, f.identity, () =>
      withVaultSubjectsWrite(db, f.identity.ownerId, [otherSubject], () =>
        putHybridDraft(db.collection('vault_drafts'),
          { ...f.identity, noteId: newId }, 1,
          draft(otherSubject, 'PRIVATE_CROSS_SUBJECT_NEW_DRAFT'), { key })));
    assert.ok((await db.collection('vault_drafts').findOne({
      noteId: newId,
    })).encrypted.ciphertext);
  });
});

test('M51 revoked GitHub installation after durable marker blocks import and retains lock', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db);
    const original = await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    });
    await assert.rejects(f.approvedImport(async () => {
      throw Error('No GitHub write permitted after installation revoked');
    }, { afterMark: async () => {
      await db.collection('users').updateOne({
        googleSub: f.identity.ownerId, sessionVersion: f.identity.sessionVersion,
      }, { $set: { 'vault.installationId': original.vault.installationId + 1 } });
    } }), (err) => err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    const row = await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    });
    assert.equal(row.vaultImportLock.state, 'github-write-possible');
    assert.equal(f.state.writes, 0);
    assert.equal(await db.collection('vault_drafts').countDocuments({
      ownerId: f.identity.ownerId,
    }), 0);
    await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, async () => {}),
      (err) => err.status === 409);
    await assert.rejects(f.approvedImport(async () => {
      throw Error('No GitHub write while quarantine active');
    }), (err) => err.status === 409);
  });
});

test('M51 account session incarnation change after marker cannot publish or clear old lock', realDatabase, async () => {
  await isolatedDatabase(async (db) => {
    const f = await environment(db), nextEpoch = randomUUID();
    await assert.rejects(f.approvedImport(async () => {
      throw Error('Stale signed session must not write');
    }, { afterMark: async () => {
      await db.collection('users').updateOne({
        googleSub: f.identity.ownerId, sessionVersion: f.identity.sessionVersion,
      }, { $set: { sessionVersion: nextEpoch } });
    } }), (err) => err.status === 503 &&
      err.message === 'vault-import-write-outcome-unconfirmed-lock-retained');
    const row = await db.collection('users').findOne({
      googleSub: f.identity.ownerId,
    });
    assert.equal(row.sessionVersion, nextEpoch);
    assert.equal(row.vaultImportLock.state, 'github-write-possible');
    assert.equal(f.state.writes, 0);
    assert.equal(await db.collection('vault_drafts').countDocuments({
      ownerId: f.identity.ownerId,
    }), 0);
    await assert.rejects(withVaultOwnerDraftWrite(db, f.identity, async () => {}),
      (err) => err.status === 409);
  });
});
