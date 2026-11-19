import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import { exportVaultCurrentResourcesSnapshot } from '../lib/oge-vault-backup-current-resources.js';
import {
  validateStandaloneRestoreSelection,
  prepareVaultStandaloneRestoreIntent,
  executeApprovedStandaloneRestoreBatch,
  commitCreateOnlyStandaloneRestores,
} from '../lib/oge-vault-standalone-restore-approval.js';

const H = (v) => createHash('sha1').update(v).digest('hex');
const HEAD = H('m75-synthetic-head');
const TREE = H('m75-synthetic-tree');
const COMMIT = H('m75-new-commit');
const NEXT_TREE = H('m75-next-tree');
const SUBJECT = randomUUID();
const NOW = '2026-11-17T00:00:00.000Z';
const VAULT = Object.freeze({
  repoId: 178, installationId: 251,
  githubAccountId: '348', githubLogin: 'm75-disposable-user',
  repoName: 'ogenotes-vault',
});

async function sourceArchive({ quick = 2, air = 2 } = {}) {
  const rows = [
    ...Array.from({ length: quick }, (_, i) => {
      const id = randomUUID();
      return {
        kind: 'quick-notes', id,
        note: validatedStandaloneCapture('quick-notes', {
          content: 'PRIVATE QUICK DATA ' + i,
          createdAt: '2026-11-16T00:00:00.000Z',
        }, { id, now: NOW }),
      };
    }),
    ...Array.from({ length: air }, (_, i) => {
      const id = randomUUID();
      return {
        kind: 'airnotes', id,
        note: validatedStandaloneCapture('airnotes', {
          content: 'PRIVATE AIR DATA ' + i,
        }, { id, now: NOW }),
      };
    }),
  ].map((row) => ({ ...row,
    sha: H('m75-source-sha:' + row.kind + ':' + row.id) }));
  const indexed = rows.map((row) => ({
    path: row.kind + '/' + row.id + '.json', type: 'blob',
    mode: '100644', sha: row.sha,
    size: Buffer.byteLength(JSON.stringify(row.note)),
  }));
  const source = {
    branch: 'main', readOnly: true, vault: VAULT,
    async call(path, options = {}) {
      assert.equal(options.method || 'GET', 'GET');
      if (path === '/git/ref/heads/main')
        return { object: { sha: H('m75-source-head') } };
      if (path === '/git/commits/' + H('m75-source-head'))
        return { tree: { sha: H('m75-source-tree') } };
      if (path === '/git/trees/' + H('m75-source-tree') + '?recursive=1')
        return { tree: indexed, truncated: false };
      throw Error('Unexpected M75 source request ' + path);
    },
  };
  return exportVaultCurrentResourcesSnapshot(source, {
    subjectVerifier: async (ids) => ids.length === 0,
    noteReader: async () => { throw Error('No linked Notes'); },
    standaloneReader: async (_client, kind, id, sha) => {
      const row = rows.find((entry) => entry.kind === kind &&
        entry.id === id && entry.sha === sha);
      if (!row) throw Error('Missing source fixture');
      return { ...row.note, sha };
    },
  });
}

function destination({
  existing = [], drafts = {}, drift = false,
  throwPatchAfterSuccess = false, dropPatch = false,
  ownerRevokedAt = 0, denySubject = false,
  changedCommit = false, failBlob = false,
} = {}) {
  const calls = [], events = [];
  const blob = new Map(), initial = [...existing], added = [];
  let currentHead = HEAD, marker = null, modifiedTree = null;
  let finalCommit = null, ownerReads = 0, patches = 0, marked = 0;
  const treeEntries = () => [
    ...initial.map((entry) => ({
      path: entry.kind + '/' + entry.id + '.json',
      type: 'blob', mode: '100644',
      sha: H('m75-old-' + entry.kind + entry.id), size: 200,
    })),
    ...added.map((entry) => ({
      path: entry.path, type: 'blob', mode: '100644',
      sha: entry.sha, size: entry.bytes.length,
    })),
  ];
  const call = async (readOnly, path, opts = {}) => {
    const method = opts.method || 'GET';
    if (readOnly && method !== 'GET')
      throw new TypeError('Read-only client tried writing');
    calls.push({ readOnly, path, method });
    events.push(method + ' ' + path);
    if (path === '/git/ref/heads/main' && method === 'GET')
      return { object: { sha: drift ? H('drift') : currentHead } };
    if (path === '/git/commits/' + HEAD)
      return { tree: { sha: TREE } };
    if (path === '/git/trees/' + TREE + '?recursive=1')
      return { truncated: false, tree: treeEntries() };
    if (path === '/git/trees' && method === 'POST') {
      assert.equal(opts.body.base_tree, TREE);
      modifiedTree = opts.body.tree;
      assert.ok(modifiedTree.length <= 12);
      assert.ok(modifiedTree.every((entry) =>
        entry.mode === '100644' && entry.type === 'blob' &&
        typeof entry.content === 'string' && !('sha' in entry)));
      added.splice(0);
      for (const entry of modifiedTree) {
        const bytes = Buffer.from(entry.content, 'utf8');
        const sha = H('written:' + entry.path + ':' + entry.content);
        blob.set(sha, bytes);
        added.push({ path: entry.path, sha, bytes });
      }
      return { sha: NEXT_TREE };
    }
    if (path === '/git/commits' && method === 'POST') {
      assert.equal(opts.body.tree, NEXT_TREE);
      assert.deepEqual(opts.body.parents, [HEAD]);
      assert.match(opts.body.message, /^Restore OgeNotes backup [a-f0-9]{64}$/);
      finalCommit = {
        tree: { sha: NEXT_TREE },
        message: changedCommit ? 'forged commit' : opts.body.message,
        parents: [{ sha: HEAD }],
      };
      return { sha: COMMIT };
    }
    if (path === '/git/ref/heads/main' && method === 'PATCH') {
      patches++;
      assert.equal(opts.body.sha, COMMIT);
      assert.equal(opts.body.force, false);
      if (!dropPatch) currentHead = COMMIT;
      if (throwPatchAfterSuccess)
        throw new VaultGitHubError('synthetic-lost-http-ack', 503);
      return { object: { sha: currentHead } };
    }
    if (path === '/git/commits/' + COMMIT)
      return finalCommit;
    if (path === '/git/trees/' + NEXT_TREE + '?recursive=1')
      return { tree: treeEntries(), truncated: false };
    if (path.startsWith('/git/blobs/')) {
      if (failBlob) throw Error('Synthetic blob lost');
      const sha = path.slice('/git/blobs/'.length);
      const bytes = blob.get(sha);
      if (!bytes) throw Error('Unknown new immutable blob');
      return { sha, encoding: 'base64', content: bytes.toString('base64'),
        size: bytes.length };
    }
    throw Error('Unexpected GitHub request ' + method + ' ' + path);
  };
  const readClient = {
    branch: 'main', readOnly: true, vault: VAULT,
    call: (path, opts) => call(true, path, opts),
  };
  const writeClient = {
    branch: 'main', readOnly: false, vault: VAULT,
    call: (path, opts) => call(false, path, opts),
  };
  const safeguards = {
    ownerVerifier: async () => {
      ownerReads++;
      return ownerRevokedAt !== ownerReads;
    },
    subjectVerifier: async (ids) => !denySubject && ids.every((id) =>
      id === SUBJECT),
    pendingDraftIds: async (kind, ids) =>
      ids.filter((id) => (drafts[kind] || []).includes(id)),
  };
  const markGitHubWriteAttempt = async (value, evidence) => {
    marked++;
    events.push('DURABLE MARKER');
    assert.match(value, /^Restore OgeNotes backup [a-f0-9]{64}$/);
    assert.equal(value.includes('PRIVATE'), false);
    assert.equal(evidence.expectedHead, HEAD);
    assert.equal(evidence.selectedIds.length, 1);
    assert.equal(Object.keys(evidence).sort().join(','),
      'expectedHead,selectedIds');
    marker = { value, evidence };
  };
  return {
    readClient, writeClient, safeguards, calls, events,
    markGitHubWriteAttempt,
    get head() { return currentHead; },
    get patches() { return patches; },
    get marked() { return marked; },
    get marker() { return marker; },
    get ownerReads() { return ownerReads; },
    get inserted() { return added; },
  };
}

function prep(archive, id = archive.quickNotes[0]?.id,
  kind = 'quick-notes', targetHead = HEAD) {
  return {
    archive, kind, selectedIds: [id],
    expectedTargetHead: targetHead,
    confirmation: 'PREPARE_SELECTED_STANDALONE_CREATE_ONLY',
  };
}
function commitRequest(prepared, intent) {
  return {
    ...prepared,
    confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
    expectedSelectionFingerprint: intent.selectionFingerprint,
  };
}

test('M75 read-only intent binds exact kind, content, IDs and expected target HEAD without returning private text', async () => {
  const archive = await sourceArchive();
  const f = destination();
  const selected = prep(archive);
  const intent = await prepareVaultStandaloneRestoreIntent(
    f.readClient, selected, f.safeguards);
  assert.equal(intent.format, 'oge-vault-standalone-create-only-intent');
  assert.equal(intent.selectedCount, 1);
  assert.equal(intent.kind, 'quick-notes');
  assert.equal(intent.targetHead, HEAD);
  assert.match(intent.selectionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(intent.canCommit, false);
  assert.equal(intent.noPrivateContentReturned, true);
  assert.equal(intent.sourceGitHubIdentityAuthenticated, false);
  assert.equal(JSON.stringify(intent).includes('PRIVATE'), false);
  assert.equal(f.calls.every((c) => c.method === 'GET'), true);
  assert.equal(f.patches, 0);
  assert.equal(f.marked, 0);
});

test('M75 explicit create-only standalone restore verifies immutable written content and timestamps', async () => {
  const archive = await sourceArchive();
  const f = destination();
  const selected = prep(archive);
  const intent = await prepareVaultStandaloneRestoreIntent(
    f.readClient, selected, f.safeguards);
  const output = await executeApprovedStandaloneRestoreBatch(
    f.readClient, f.writeClient, commitRequest(selected, intent),
    f.safeguards, { markGitHubWriteAttempt: f.markGitHubWriteAttempt });
  assert.equal(output.importedCount, 1);
  assert.deepEqual(output.importedIds, selected.selectedIds);
  assert.equal(output.kind, 'quick-notes');
  assert.equal(output.commitSha, COMMIT);
  assert.equal(output.overwritePerformed, false);
  assert.equal(output.encryptedDraftsChanged, false);
  assert.equal(output.nextBatchAutomaticallyStarted, false);
  assert.equal(output.noPermanentMongoContent, true);
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
  assert.equal(f.marked, 1);
  assert.equal(f.patches, 1);
  const firstWrite = f.events.findIndex((value) =>
    value.startsWith('POST /git/trees'));
  assert.ok(f.events.indexOf('DURABLE MARKER') < firstWrite);
  assert.equal(f.inserted.length, 1);
  const written = JSON.parse(f.inserted[0].bytes.toString('utf8'));
  const { sha: _sha, ...source } = archive.quickNotes[0];
  assert.deepEqual(written, source);
  assert.equal(written.createdAt, '2026-11-16T00:00:00.000Z');
  assert.equal(written.updatedAt, NOW);
});

test('M75 AirNotes use separate namespace, never mix a Quick Notes writer', async () => {
  const archive = await sourceArchive();
  const f = destination();
  const selected = prep(archive, archive.airNotes[0].id, 'airnotes');
  const intent = await prepareVaultStandaloneRestoreIntent(
    f.readClient, selected, f.safeguards);
  const result = await executeApprovedStandaloneRestoreBatch(
    f.readClient, f.writeClient, commitRequest(selected, intent),
    f.safeguards, { markGitHubWriteAttempt: f.markGitHubWriteAttempt });
  assert.equal(result.kind, 'airnotes');
  assert.equal(f.inserted.length, 1);
  assert.ok(f.inserted[0].path.startsWith('airnotes/'));
});

test('M75 malicious selections, stale IDs, changed source or mismatched fingerprint never make GitHub writes', async () => {
  const archive = await sourceArchive();
  const f = destination();
  const selected = prep(archive);
  const intent = await prepareVaultStandaloneRestoreIntent(
    f.readClient, selected, f.safeguards);
  const base = commitRequest(selected, intent);
  const invalid = [
    { ...base, confirmation: 'PREPARE_SELECTED_STANDALONE_CREATE_ONLY' },
    { ...base, kind: 'notes' },
    { ...base, expectedTargetHead: H('incorrect-head') },
    { ...base, selectedIds: [randomUUID()] },
    { ...base, selectedIds: [base.selectedIds[0], base.selectedIds[0]] },
    { ...base, selectedIds: Array.from({ length: 13 }, () => randomUUID()) },
    { ...base, selectedIds: [base.selectedIds[0].toUpperCase()] },
    { ...base, expectedSelectionFingerprint: 'f'.repeat(64) },
    { ...base, archive: { ...archive, archiveSha256: 'f'.repeat(64) } },
    { ...base, unapproved: true },
  ];
  for (const invalidRequest of invalid) {
    const dest = destination();
    await assert.rejects(executeApprovedStandaloneRestoreBatch(
      dest.readClient, dest.writeClient, invalidRequest,
      dest.safeguards, { markGitHubWriteAttempt: dest.markGitHubWriteAttempt }),
    (error) => error instanceof VaultGitHubError && [400, 409].includes(error.status));
    assert.equal(dest.marked, 0);
    assert.equal(dest.patches, 0);
    assert.equal(dest.calls.every((c) => c.method === 'GET'), true);
  }
});

test('M75 pending standalone drafts and existing GitHub entries fail BEFORE durable marker', async () => {
  const archive = await sourceArchive();
  for (const variant of [
    { existing: [{ kind: 'quick-notes', id: archive.quickNotes[0].id }] },
    { drafts: { 'quick-notes': [archive.quickNotes[0].id] } },
  ]) {
    const f = destination(variant);
    const request = prep(archive);
    await assert.rejects(prepareVaultStandaloneRestoreIntent(
      f.readClient, request, f.safeguards), (e) =>
      e instanceof VaultGitHubError && e.status === 409);
    assert.equal(f.marked, 0);
  }
});

test('M75 missing owner, mismatched repo clients and unapproved direct commits fail closed', async () => {
  const archive = await sourceArchive();
  const f = destination({ ownerRevokedAt: 1 });
  await assert.rejects(prepareVaultStandaloneRestoreIntent(
    f.readClient, prep(archive), f.safeguards), (e) =>
    e instanceof VaultGitHubError && e.status === 409);
  const other = destination();
  await assert.rejects(executeApprovedStandaloneRestoreBatch(
    other.readClient,
    { ...other.writeClient, vault: { ...VAULT, repoId: 99 } },
    { ...prep(archive), confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
      expectedSelectionFingerprint: 'f'.repeat(64) },
    other.safeguards, { markGitHubWriteAttempt: other.markGitHubWriteAttempt },
  ), TypeError);
  await assert.rejects(commitCreateOnlyStandaloneRestores(
    other.readClient, 'quick-notes', [archive.quickNotes[0]], {
      expectedHead: HEAD, commitMessage: 'Restore OgeNotes backup ' + 'a'.repeat(64),
    }), TypeError);
  assert.equal(other.marked, 0);
});

test('M75 lost ref PATCH acknowledgement is recovered READ-ONLY, with ONE GitHub PATCH only', async () => {
  const archive = await sourceArchive();
  const f = destination({ throwPatchAfterSuccess: true });
  const requested = prep(archive);
  const intent = await prepareVaultStandaloneRestoreIntent(
    f.readClient, requested, f.safeguards);
  const result = await executeApprovedStandaloneRestoreBatch(
    f.readClient, f.writeClient, commitRequest(requested, intent),
    f.safeguards, { markGitHubWriteAttempt: f.markGitHubWriteAttempt });
  assert.equal(result.commitSha, COMMIT);
  assert.equal(f.patches, 1);
  assert.equal(f.marked, 1);
});

test('M75 ambiguous ref response or commit verification failure is NEVER retried and retains outside fence quarantine', async () => {
  const archive = await sourceArchive();
  for (const variant of [
    { dropPatch: true, throwPatchAfterSuccess: true },
    { changedCommit: true },
    { failBlob: true },
  ]) {
    const f = destination(variant);
    const requested = prep(archive);
    const intent = await prepareVaultStandaloneRestoreIntent(
      f.readClient, requested, f.safeguards);
    await assert.rejects(executeApprovedStandaloneRestoreBatch(
      f.readClient, f.writeClient, commitRequest(requested, intent),
      f.safeguards, { markGitHubWriteAttempt: f.markGitHubWriteAttempt }),
    (e) => e instanceof VaultGitHubError && [409, 503].includes(e.status));
    assert.equal(f.marked, 1, 'uncertainty marker was durably placed');
    assert.equal(f.patches, 1, 'no automatic replay of unknown provider write');
  }
});

test('M75 standalone restore gate is default-OFF, HTTPS same-origin, signed and explicitly double acknowledged', async () => {
  const src = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-staging.js', import.meta.url), 'utf8');
  const intent = await readFile(new URL(
    '../app/api/vault/backup-current-resources/intent/route.js', import.meta.url), 'utf8');
  const commit = await readFile(new URL(
    '../app/api/vault/backup-current-resources/commit/route.js', import.meta.url), 'utf8');
  const code = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-approval.js', import.meta.url), 'utf8');
  for (const pattern of [
    /OGE_VAULT_STANDALONE_RESTORE_INTENT_PREVIEW !== 'true'/,
    /OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true'/,
    /OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK !==/,
    /YES_DISPOSABLE_SIGNED_STAGING_ONLY/,
    /OGE_VAULT_CURRENT_RESOURCE_RESTORE_PLAN_PREVIEW !== 'true'/,
    /oge_vault_restore_staging_/,
    /checkVaultStagingReadiness\(env\)\.ok/,
    /env\.OGE_STAGING_URL !== env\.AUTH_URL/,
    /staging\.protocol === 'https:'/,
    /request\.headers\.get\('origin'\) === staging\.origin/,
    /ownerMutationFilter\(ownerId/,
    /sessionVersion: identity\.sessionVersion/,
    /collection\('vault_drafts'\)|'vault_drafts'/,
    /'vault_standalone_drafts'/,
    /repoId, kind, captureId: \{ \$in: ids \}/,
  ]) assert.match(src, pattern);
  assert.match(intent, /prepareVaultStandaloneRestoreIntent/);
  assert.match(intent, /signedStandaloneRestoreContext/);
  assert.doesNotMatch(intent, /withVaultOwnerImportExclusive|markGitHubWriteAttempt|getVaultNoteClient/);
  assert.match(commit, /withVaultOwnerImportExclusive/);
  assert.match(commit, /markGitHubWriteAttempt/);
  assert.match(commit, /getVaultNoteClient/);
  assert.match(commit, /executeApprovedStandaloneRestoreBatch/);
  assert.match(code, /markGitHubWriteAttempt\(marker/);
  assert.match(code, /force: false/);
  assert.match(code, /readVaultStandaloneBlob/);
  assert.doesNotMatch(code + commit,
    /deleteOne\(|insertOne\(|updateOne\(|collection\(['"]notes['"]\)|commitVaultStandaloneCapture/);
  assert.doesNotMatch(commit, /export async function GET|export async function PUT|export async function DELETE/);
});
