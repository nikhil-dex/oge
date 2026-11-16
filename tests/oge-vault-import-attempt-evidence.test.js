import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectVaultImportAttemptEvidenceReadOnly } from '../lib/oge-vault-import-attempt-evidence.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const h = (v) => createHash('sha1').update(v).digest('hex');
const ownerId = 'synthetic-' + randomUUID();
const sessionVersion = randomUUID();
const repoId = 628;
const operationId = randomUUID(), noteIds = [randomUUID(), randomUUID()];
const baseHead = h('approved-head'), importHead = h('import-commit');
const baseTreeSha = h('approved-tree'), importTreeSha = h('import-tree');
const marker = 'Restore OgeNotes backup ' + 'f'.repeat(64);
const scope = { ownerId, sessionVersion, repoId, expectedOperationId: operationId };
const vault = { status: 'connected', installationId: 31, repoId,
  githubAccountId: '42', githubLogin: 'test-owner', repoName: 'ogenotes-vault' };
const base = [
  { path: 'README.md', type: 'blob', mode: '100644', sha: h('readme') },
];
const newNotes = noteIds.map((id, n) => ({
  path: 'notes/' + id + '.json', type: 'blob', mode: '100644',
  sha: h('canonical-note-' + n),
}));

function fixture({ lockState = 'github-write-possible', wrongOperation = false,
  invalidEvidence = false, missingOwner = false, changedOwner = false,
  changedLock = false, headDrift = false, newer = 0,
  wrongMessage = false, wrongParent = false, unrelatedChange = false,
  missingNote = false, extraNote = false, malformedTree = false,
  merge = false, cycle = false, providerFailure = false } = {}) {
  const lock = {
    operationId: wrongOperation ? randomUUID() : operationId,
    repoId, startedAt: new Date('2026-11-16T08:30:00.000Z'),
    state: lockState, attemptedAt: new Date('2026-11-16T08:31:00.000Z'),
    commitMarker: marker, approvedHead: baseHead, selectedIds: [...noteIds],
  };
  if (invalidEvidence) lock.approvedHead = 'invalid';
  const commits = new Map([
    [baseHead, { tree: { sha: baseTreeSha }, parents: [] }],
    [importHead, { tree: { sha: importTreeSha },
      parents: [{ sha: wrongParent ? h('unrelated') : baseHead }],
      message: wrongMessage ? 'Other commit' : marker }],
  ]);
  const newerCommits = Array.from({ length: newer }, (_, i) => h('later-' + i));
  newerCommits.forEach((sha, i) => commits.set(sha, {
    tree: { sha: h('later-tree-' + i) },
    parents: merge && i === newer - 1
      ? [{ sha: i ? newerCommits[i - 1] : importHead }, { sha: h('merge') }]
      : [{ sha: cycle && i === newer - 1 ? sha :
        (i ? newerCommits[i - 1] : importHead) }],
    message: 'Later note update',
  }));
  const head = newerCommits.at(-1) || importHead;
  const trees = new Map([
    [baseTreeSha, [...base]],
    [importTreeSha, [
      ...(unrelatedChange ? [{ ...base[0], sha: h('changed-readme') }] : base),
      ...(missingNote ? newNotes.slice(1) : newNotes),
      ...(extraNote ? [{ path: 'notes/' + randomUUID() + '.json',
        type: 'blob', mode: '100644', sha: h('extra') }] : []),
    ]],
  ]);
  let readCount = 0, refCount = 0;
  const events = [];
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { async findOne(query, options) {
      events.push('mongo-read');
      readCount++;
      assert.equal(options.projection.vaultImportLock, 1);
      assert.equal(query.$and[1]['vault.repoId'], repoId);
      if (missingOwner) return null;
      return { vault: { ...vault, ...(changedOwner && readCount === 2
        ? { repoId: repoId + 1 } : {}) },
      vaultImportLock: { ...lock, ...(changedLock && readCount === 2
        ? { operationId: randomUUID() } : {}) } };
    } };
  } };
  const client = { vault: { ...vault }, branch: 'main',
    async call(path, options = {}) {
      events.push('github-' + (options.method || 'GET') + '-' + path);
      if (providerFailure) throw new VaultGitHubError('rate-limited', 429);
      if (path === '/git/ref/heads/main') {
        refCount++;
        return { object: { sha: headDrift && refCount > 1
          ? h('different-head') : head } };
      }
      if (path.startsWith('/git/commits/')) return commits.get(
        path.slice('/git/commits/'.length)) ||
        { tree: { sha: h('unknown-tree') }, parents: [{ sha: baseHead }],
          message: 'Unrelated' };
      if (path.startsWith('/git/trees/'))
        return { truncated: malformedTree,
          tree: trees.get(path.slice('/git/trees/'.length).split('?')[0]) };
      throw Error('Unexpected provider call ' + path);
    },
  };
  return { db, client, events, getRefCount: () => refCount };
}

test('M48 identifies exact metadata-only GitHub import without downloading note text', async () => {
  const f = fixture({ newer: 3 });
  const result = await inspectVaultImportAttemptEvidenceReadOnly(f.db, scope, f.client);
  assert.equal(result.status, 'MATCHING_IMPORT_COMMIT_METADATA_ONLY');
  assert.equal(result.matchingCommitMetadataFound, true);
  assert.equal(result.commitsAfterCandidate, 3);
  assert.equal(result.contentDownloaded, false);
  assert.equal(result.importedContentVerified, false);
  assert.equal(result.operatorUnlockAuthorized, false);
  assert.equal(result.safeToRetryAutomatically, false);
  assert.equal(result.workerQuiescenceVerified, false);
  assert.equal(f.getRefCount(), 2);
  assert.ok(f.events.every((event) => event === 'mongo-read' ||
    event.startsWith('github-GET-')));
  assert.equal(f.events.some((event) => /\/git\/blobs\/|\/contents\//.test(event)), false);
  const serialized = JSON.stringify(result);
  for (const secret of [ownerId, sessionVersion, operationId, marker,
    baseHead, importHead, ...noteIds, 'PRIVATE NOTE BODY']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('M48 refuses legacy/acquired or invalid import evidence before touching GitHub', async () => {
  for (const opt of [
    { lockState: 'acquired' }, { lockState: 'legacy-unknown' },
    { wrongOperation: true }, { invalidEvidence: true },
    { missingOwner: true },
  ]) {
    const f = fixture(opt);
    const result = await inspectVaultImportAttemptEvidenceReadOnly(f.db, scope, f.client);
    assert.equal(result.matchingCommitMetadataFound || false, false);
    assert.equal(f.events.filter((event) => event.startsWith('github-')).length, 0);
  }
});

test('M48 never claims full import content verified from a commit marker alone', async () => {
  for (const opt of [
    { wrongMessage: true }, { wrongParent: true },
    { unrelatedChange: true }, { missingNote: true },
    { extraNote: true }, { newer: 2, headDrift: true },
    { newer: 2, changedLock: true }, { newer: 2, changedOwner: true },
  ]) {
    const f = fixture(opt);
    const result = await inspectVaultImportAttemptEvidenceReadOnly(f.db, scope, f.client);
    assert.notEqual(result.status, 'MATCHING_IMPORT_COMMIT_METADATA_ONLY');
    assert.equal(result.importedContentVerified, false);
    assert.equal(result.operatorUnlockAuthorized, false);
  }
});

test('M48 malformed trees and provider errors fail closed rather than unlocking', async () => {
  for (const opt of [{ malformedTree: true }, { providerFailure: true },
    { newer: 1, cycle: true }]) {
    const f = fixture(opt);
    await assert.rejects(
      inspectVaultImportAttemptEvidenceReadOnly(f.db, scope, f.client));
  }
  const merged = fixture({ newer: 2, merge: true });
  const result = await inspectVaultImportAttemptEvidenceReadOnly(
    merged.db, scope, merged.client);
  assert.equal(result.status, 'NONLINEAR_OR_INCOMPLETE_HISTORY');
  assert.equal(result.operatorUnlockAuthorized, false);
});

test('M48 CLI is gated and cannot perform GitHub writes, unlocks or content reads', async () => {
  const script = await readFile(new URL(
    '../scripts/inspect-vault-import-attempt.mjs', import.meta.url), 'utf8');
  const engine = await readFile(new URL(
    '../lib/oge-vault-import-attempt-evidence.js', import.meta.url), 'utf8');
  assert.match(script, /OGE_VAULT_IMPORT_EVIDENCE_READ_ONLY === 'YES_METADATA_ONLY'/);
  assert.match(script, /getVaultNoteClient\(db/);
  assert.match(script, /process\.exitCode = 2/);
  assert.doesNotMatch(script + engine, /\.updateOne\(|\.insertOne\(|\.deleteOne\(/);
  assert.doesNotMatch(engine, /\/git\/blobs\/|\/contents\//);
  assert.doesNotMatch(script, /getDatabase\(/);
});
