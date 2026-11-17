import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import { exportVaultCurrentResourcesSnapshot } from '../lib/oge-vault-backup-current-resources.js';
import {
  fingerprintStandaloneRestoreSelection,
  markerStandaloneRestoreSelection,
  validateStandaloneRestoreSelection,
} from '../lib/oge-vault-standalone-restore-approval.js';
import { standaloneRestoreApprovalBinding } from '../lib/oge-vault-standalone-restore-ticket.js';
import {
  reconcileStandaloneRestoreReadOnly,
  MAX_STANDALONE_RESTORE_RECONCILE_COMMITS,
} from '../lib/oge-vault-standalone-restore-reconcile.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const H = (value) => createHash('sha1').update(value).digest('hex');
const H256 = (value) => createHash('sha256')
  .update(value).digest('hex');
const BASE = H('m77-base'), BASE_TREE = H('m77-base-tree');
const COMMIT = H('m77-import'), COMMIT_TREE = H('m77-import-tree');
const NEWER = H('m77-newer'), NEWER_TREE = H('m77-newer-tree');
const NOW = '2026-11-17T00:00:00.000Z';
const VAULT = {
  repoId: 381, installationId: 791, repoName: 'ogenotes-vault',
  githubAccountId: '91', githubLogin: 'm77-test-user',
};

async function archiveFixture(kind = 'quick-notes') {
  const id = randomUUID();
  const capture = validatedStandaloneCapture(kind, {
    content: 'PRIVATE M77 IMMUTABLE BLOB TEXT',
    createdAt: '2026-11-16T22:00:00.000Z',
  }, { id, now: NOW });
  const sourceHead = H('m77-source-head');
  const sourceTree = H('m77-source-tree');
  const sourceSha = H('m77-source-blob');
  const path = kind + '/' + id + '.json';
  const source = {
    branch: 'main', readOnly: true, vault: VAULT,
    async call(url, opts = {}) {
      assert.equal(opts.method || 'GET', 'GET');
      if (url === '/git/ref/heads/main')
        return { object: { sha: sourceHead } };
      if (url === '/git/commits/' + sourceHead)
        return { tree: { sha: sourceTree } };
      if (url === '/git/trees/' + sourceTree + '?recursive=1')
        return { truncated: false, tree: [{
          path, type: 'blob', mode: '100644', sha: sourceSha,
          size: Buffer.byteLength(JSON.stringify(capture)),
        }] };
      throw Error('Unexpected source call ' + url);
    },
  };
  const archive = await exportVaultCurrentResourcesSnapshot(source, {
    subjectVerifier: async (ids) => ids.length === 0,
    noteReader: async () => { throw Error('No Notes expected'); },
    standaloneReader: async (_source, inputKind, requestedId, sha) => {
      assert.equal(inputKind, kind);
      assert.equal(requestedId, id);
      assert.equal(sha, sourceSha);
      return { ...capture, sha: sourceSha };
    },
  });
  const raw = {
    archive, kind, selectedIds: [id],
    expectedTargetHead: BASE,
    expectedSelectionFingerprint: 'a'.repeat(64),
    confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
  };
  const approved = validateStandaloneRestoreSelection(raw, { commit: true });
  const request = {
    ...raw,
    expectedSelectionFingerprint:
      fingerprintStandaloneRestoreSelection(approved),
  };
  const chosen = validateStandaloneRestoreSelection(
    request, { commit: true });
  return {
    archive, request, selected: chosen,
    marker: markerStandaloneRestoreSelection(chosen,
      request.expectedSelectionFingerprint),
    originalPath: path, canonical: capture,
  };
}

function evidence(fixture, {
  current = 'import', badLeaf = false, alteredBlob = false,
  alteredOtherLeaf = false, currentFile = 'same',
  nonlinear = false, movingHead = false,
  ownerRevokedAt = 0, changedLock = false, badReceipt = false,
  receiptState = 'claimed',
} = {}) {
  const operationId = randomUUID();
  const restoredSha = H('m77-restored-blob');
  const readOptions = { selected: fixture.selected };
  const marker = fixture.marker;
  const approvedHead = fixture.request.expectedTargetHead;
  const approved = fixture.request;
  const baseRows = [{
    path: 'README.md', type: 'blob', mode: '100644', sha: H('m77-readme'),
  }];
  const candidateRow = {
    path: fixture.originalPath, type: 'blob', mode: '100644',
    sha: restoredSha, size: Buffer.byteLength(
      JSON.stringify(fixture.canonical)),
  };
  const importedTree = [
    ...baseRows.map((r) => alteredOtherLeaf ?
      { ...r, sha: H('m77-other-change') } : r),
    badLeaf ? { ...candidateRow, mode: '120000' } : candidateRow,
  ];
  const currentRows = currentFile === 'deleted' ? [...baseRows] :
    currentFile === 'changed' ?
      [...baseRows, { ...candidateRow, sha: H('m77-edited-blob') }] :
      importedTree;
  const fingerprint = H256(JSON.stringify(
    standaloneRestoreApprovalBinding(approved)));
  let lockReads = 0, ownerReads = 0, receiptReads = 0, refs = 0;
  const calls = [];
  const lock = {
    operationId, repoId: VAULT.repoId,
    startedAt: new Date('2026-11-17T00:00:00.000Z'),
    state: 'github-write-possible', commitMarker: marker,
    approvedHead, selectedIds: approved.selectedIds,
    attemptedAt: new Date('2026-11-17T00:00:01.000Z'),
  };
  const currentHead = current === 'base' ? BASE :
    current === 'later' ? NEWER : COMMIT;
  const client = {
    branch: 'main', readOnly: true, vault: VAULT,
    async call(url, opts = {}) {
      assert.equal(opts.method || 'GET', 'GET',
        'Read-only reconciliation cannot invoke a writer');
      calls.push(url);
      if (url === '/git/ref/heads/main') {
        refs++;
        return { object: { sha:
          movingHead && refs > 1 ? H('m77-raced-head') : currentHead } };
      }
      if (url === '/git/commits/' + NEWER)
        return { tree: { sha: NEWER_TREE },
          parents: [{ sha: COMMIT }], message: 'later unrelated save' };
      if (url === '/git/commits/' + COMMIT)
        return { tree: { sha: COMMIT_TREE },
          parents: nonlinear ?
            [{ sha: BASE }, { sha: H('m77-second-parent') }] :
            [{ sha: BASE }], message: marker };
      if (url === '/git/commits/' + BASE)
        return { tree: { sha: BASE_TREE },
          parents: [{ sha: H('m77-earlier') }] };
      if (url === '/git/trees/' + BASE_TREE + '?recursive=1')
        return { truncated: false, tree: baseRows };
      if (url === '/git/trees/' + COMMIT_TREE + '?recursive=1')
        return { truncated: false, tree: importedTree };
      if (url === '/git/trees/' + NEWER_TREE + '?recursive=1')
        return { truncated: false, tree: currentRows };
      if (url === '/git/blobs/' + restoredSha) {
        const content = JSON.stringify(alteredBlob
          ? { ...fixture.canonical, content: 'TAMPERED PRIVATE CONTENT' }
          : fixture.canonical);
        return { sha: restoredSha, encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
          size: Buffer.byteLength(content) };
      }
      throw Error('Unexpected signed GitHub call: ' + url);
    },
  };
  const safeguards = {
    expectedOperationId: operationId,
    ownerVerifier: async () => {
      ownerReads++;
      return ownerReads !== ownerRevokedAt;
    },
    lockReader: async () => {
      lockReads++;
      return {
        lock: changedLock && lockReads > 1 ?
          { ...lock, selectedIds: [randomUUID()] } : lock,
        activeDraftWriters: 0,
      };
    },
    receiptReader: async (hash) => {
      receiptReads++;
      assert.equal(hash, fingerprint);
      return badReceipt ? [] : [{
        nonceHash: 'e'.repeat(64), approvalHash: fingerprint,
        state: receiptState,
      }];
    },
  };
  return {
    client, safeguards, calls, operationId, readOptions,
    get lockReads() { return lockReads; },
    get ownerReads() { return ownerReads; },
    get receiptReads() { return receiptReads; },
  };
}
const run = (f, fixture) =>
  reconcileStandaloneRestoreReadOnly(f.client, fixture.request, f.safeguards);

test('M77 exact signed incident proves one historical Quick Note create without leaking private text or authorizing retry', async () => {
  const fixture = await archiveFixture();
  const f = evidence(fixture);
  const report = await run(f, fixture);
  assert.equal(report.format, 'oge-vault-standalone-restore-reconciliation');
  assert.equal(report.status, 'HISTORICAL_CREATE_CONTENT_VERIFIED');
  assert.equal(report.candidateCommitSha, COMMIT);
  assert.equal(report.observedTargetHead, COMMIT);
  assert.deepEqual(report.currentSelectedFiles,
    { unchanged: 1, changed: 0, missing: 0 });
  assert.equal(report.receiptState, 'claimed');
  assert.equal(report.historicalSelectedContentVerified, true);
  assert.equal(report.sourceGitHubIdentityAuthenticated, false);
  assert.equal(report.independentWriterQuiescenceVerified, false);
  assert.equal(report.operatorUnlockAuthorized, false);
  assert.equal(report.automaticUnlockAuthorized, false);
  assert.equal(report.safeToRetryAutomatically, false);
  assert.equal(report.gitWritesPerformed, false);
  assert.equal(report.mongoWritesPerformed, false);
  assert.equal(report.readOnly, true);
  assert.equal(report.ownerLockStable, true);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.equal(f.ownerReads, 2);
  assert.equal(f.lockReads, 2);
  assert.equal(f.receiptReads, 2);
  assert.equal(f.calls.every((url) => url.startsWith('/git/')), true);
});

test('M77 AirNotes and later GitHub edits/deletions preserve historical create proof but distinguish current state', async () => {
  const fixture = await archiveFixture('airnotes');
  for (const [currentFile, expected] of [
    ['same', { unchanged: 1, changed: 0, missing: 0 }],
    ['changed', { unchanged: 0, changed: 1, missing: 0 }],
    ['deleted', { unchanged: 0, changed: 0, missing: 1 }],
  ]) {
    const f = evidence(fixture, { current: 'later', currentFile,
      receiptState: 'confirmed' });
    const report = await run(f, fixture);
    assert.equal(report.status, 'HISTORICAL_CREATE_CONTENT_VERIFIED');
    assert.deepEqual(report.currentSelectedFiles, expected);
    assert.equal(report.newerCommitsSinceCandidate, 1);
    assert.equal(report.receiptState, 'confirmed');
    assert.equal(report.operatorUnlockAuthorized, false);
  }
});

test('M77 still treats unchanged HEAD and nonlinear history as UNKNOWN, never absence proof or retry', async () => {
  const fixture = await archiveFixture();
  for (const [settings, status] of [
    [{ current: 'base' }, 'APPROVED_HEAD_UNCHANGED'],
    [{ nonlinear: true }, 'NONLINEAR_OR_INCOMPLETE_HISTORY'],
  ]) {
    const f = evidence(fixture, settings);
    const report = await run(f, fixture);
    assert.equal(report.status, status);
    assert.equal(report.historicalSelectedContentVerified, false);
    assert.equal(report.safeToRetryAutomatically, false);
    assert.equal(report.operatorUnlockAuthorized, false);
  }
});

test('M77 rejects candidate with unrelated Git file mutation or forged private blob bytes', async () => {
  const fixture = await archiveFixture();
  for (const [settings, status] of [
    [{ alteredOtherLeaf: true }, 'CANDIDATE_CONTENT_DELTA_UNVERIFIED'],
    [{ alteredBlob: true }, 'CANDIDATE_PRIVATE_BLOBS_UNVERIFIED'],
  ]) {
    const f = evidence(fixture, settings);
    const report = await run(f, fixture);
    assert.equal(report.status, status);
    assert.equal(report.candidateCommitSha, null);
    assert.equal(report.historicalSelectedContentVerified, false);
    assert.equal(report.operatorUnlockAuthorized, false);
  }
  const invalidFile = evidence(fixture, { badLeaf: true });
  await assert.rejects(run(invalidFile, fixture), (err) =>
    err instanceof VaultGitHubError && err.status === 409);
});

test('M77 untrusted/tampered archive or selection rejected before reading ANY private owner/GitHub data', async () => {
  const fixture = await archiveFixture();
  for (const request of [
    { ...fixture.request, expectedSelectionFingerprint: 'f'.repeat(64) },
    { ...fixture.request,
      archive: { ...fixture.archive, archiveSha256: 'f'.repeat(64) } },
    { ...fixture.request, kind: 'airnotes' },
    { ...fixture.request, selectedIds: [randomUUID()] },
  ]) {
    const f = evidence(fixture);
    await assert.rejects(reconcileStandaloneRestoreReadOnly(
      f.client, request, f.safeguards), (err) =>
      err instanceof VaultGitHubError && [400, 409].includes(err.status));
    assert.equal(f.calls.length, 0);
    assert.equal(f.ownerReads, 0);
    assert.equal(f.receiptReads, 0);
  }
});

test('M77 exact durable lock/operation receipt gates deny cross-incident or missing claim before provider reads', async () => {
  const fixture = await archiveFixture();
  for (const settings of [
    { ownerRevokedAt: 1 }, { badReceipt: true },
  ]) {
    const f = evidence(fixture, settings);
    await assert.rejects(run(f, fixture), (err) =>
      err instanceof VaultGitHubError && err.status === 409);
    assert.equal(f.calls.length, 0);
  }
  const f = evidence(fixture);
  f.safeguards.expectedOperationId = randomUUID();
  await assert.rejects(run(f, fixture), (err) =>
    err instanceof VaultGitHubError && err.status === 409);
  assert.equal(f.calls.length, 0);
});

test('M77 moving GitHub HEAD, revoked signed owner or changed lock after reading fail closed', async () => {
  const fixture = await archiveFixture();
  for (const settings of [
    { movingHead: true }, { ownerRevokedAt: 2 }, { changedLock: true },
  ]) {
    const f = evidence(fixture, settings);
    await assert.rejects(run(f, fixture), (err) =>
      err instanceof VaultGitHubError && err.status === 409);
  }
});

test('M77 readOnly token is mandatory, no writer callback, and history bound is 20', async () => {
  const fixture = await archiveFixture();
  const f = evidence(fixture);
  f.client.readOnly = false;
  await assert.rejects(run(f, fixture), TypeError);
  assert.equal(f.calls.length, 0);
  assert.equal(MAX_STANDALONE_RESTORE_RECONCILE_COMMITS, 20);
});

test('M77 protected staging HTTP route is exact owner operation readOnly, no unlock/writer and default OFF', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-current-resources/reconcile/route.js',
    import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-reconcile.js',
    import.meta.url), 'utf8');
  const gate = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-staging.js',
    import.meta.url), 'utf8');
  assert.match(route, /standaloneRestoreStagingAllowed\(request, \{ reconcile: true \}\)/);
  assert.match(gate, /OGE_VAULT_STANDALONE_RESTORE_RECONCILE_PREVIEW !== 'true'/);
  assert.match(route, /signedStandaloneRestoreContext\(\)/);
  assert.match(route, /ownerMutationFilter\(identity\.ownerId/);
  assert.match(route, /ownerLockReader/);
  assert.match(route, /vault_standalone_restore_approvals/);
  assert.match(route, /state: \{ \$in: \['claimed', 'confirmed'\] \}/);
  assert.match(route, /reconcileStandaloneRestoreReadOnly/);
  assert.match(route, /expectedOperationId/);
  assert.match(core, /MAX_STANDALONE_RESTORE_RECONCILE_COMMITS = 20/);
  assert.match(core, /readVaultStandaloneBlob/);
  assert.match(core, /operatorUnlockAuthorized: false/);
  assert.match(core, /automaticUnlockAuthorized: false/);
  assert.match(core, /gitWritesPerformed: false/);
  assert.match(core, /mongoWritesPerformed: false/);
  assert.doesNotMatch(route + core,
    /updateOne\(|deleteOne\(|insertOne\(|findOneAndUpdate\(|markGitHubWriteAttempt|withVaultOwnerImportExclusive|force: false|releasePreWriteVaultImportLock|commitVaultStandaloneCapture/);
  assert.doesNotMatch(route,
    /export async function GET|export async function DELETE|export async function PUT/);
});
