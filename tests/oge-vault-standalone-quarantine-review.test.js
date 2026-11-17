import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  reviewStandaloneRestoreQuarantineReadOnly,
} from '../lib/oge-vault-standalone-quarantine-review.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const HEAD = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const ID = randomUUID();
const defaultActivity = Object.freeze({
  activeSubjectWriters: 0, pendingNoteDrafts: 0,
  pendingStandaloneDrafts: 0, unresolvedStandaloneReceipts: 1,
});

function fixture({
  evidenceStatus = 'HISTORICAL_CREATE_CONTENT_VERIFIED',
  receiptState = 'confirmed',
  after = defaultActivity, before = defaultActivity,
  changedLock = false, movingHead = false,
  revokedAt = 0, malformed = false,
  current = { unchanged: 1, changed: 0, missing: 0 },
} = {}) {
  const incidentId = randomUUID();
  const expectedOperationId = randomUUID();
  let ownerChecks = 0, lockReads = 0, activityReads = 0, refReads = 0;
  const calls = [];
  const lock = {
    operationId: expectedOperationId,
    repoId: 51, state: 'github-write-possible',
    approvedHead: HEAD, selectedIds: [ID],
    commitMarker: 'Restore OgeNotes backup ' + 'd'.repeat(64),
    startedAt: new Date('2026-11-17T00:00:00.000Z'),
    attemptedAt: new Date('2026-11-17T00:00:01.000Z'),
  };
  const client = {
    readOnly: true, branch: 'main', vault: { repoId: 51 },
    call: async (path, options = {}) => {
      assert.equal(options.method || 'GET', 'GET');
      calls.push(path);
      refReads++;
      assert.equal(path, '/git/ref/heads/main');
      return { object: {
        sha: movingHead && refReads >= 1 ? 'c'.repeat(40) : HEAD,
      } };
    },
  };
  const original = {
    kind: 'quick-notes', selectedIds: [ID],
    expectedTargetHead: HEAD,
  };
  const options = {
    incidentId, expectedOperationId,
    ownerVerifier: async () => {
      ownerChecks++;
      return ownerChecks !== revokedAt;
    },
    lockReader: async () => {
      lockReads++;
      return { lock: changedLock && lockReads > 1 ?
        { ...lock, selectedIds: [randomUUID()] } : lock,
      activeDraftWriters: 0 };
    },
    receiptReader: async () => [{ state: receiptState }],
    auxiliaryReader: async () => {
      activityReads++;
      return activityReads === 1 ? before : after;
    },
    reconcileReader: async (_client, approved, supplied) => {
      assert.equal(approved, original);
      assert.equal(supplied.expectedOperationId, expectedOperationId);
      assert.equal(typeof supplied.lockReader, 'function');
      assert.equal(typeof supplied.receiptReader, 'function');
      assert.equal(typeof supplied.ownerVerifier, 'function');
      return {
        format: 'oge-vault-standalone-restore-reconciliation',
        version: 1,
        status: evidenceStatus,
        readOnly: true, ownerLockStable: true,
        operatorUnlockAuthorized: false,
        automaticUnlockAuthorized: false,
        safeToRetryAutomatically: false,
        gitWritesPerformed: false, mongoWritesPerformed: false,
        sourceGitHubIdentityAuthenticated: false,
        independentWriterQuiescenceVerified: false,
        kind: 'quick-notes', selectedIds: [ID],
        expectedTargetHead: HEAD,
        observedTargetHead: HEAD,
        candidateCommitSha: evidenceStatus ===
          'HISTORICAL_CREATE_CONTENT_VERIFIED' ? COMMIT : null,
        currentSelectedFiles: current,
        historicalSelectedContentVerified: evidenceStatus ===
          'HISTORICAL_CREATE_CONTENT_VERIFIED',
        receiptState,
        ...(malformed ? { operatorUnlockAuthorized: true } : {}),
      };
    },
  };
  return { client, original, options, calls, get counts() {
    return { ownerChecks, lockReads, activityReads, refReads };
  } };
}

test('M78 historically verified immutable restore remains quarantined even with no observed active writers', async () => {
  const f = fixture();
  const review = await reviewStandaloneRestoreQuarantineReadOnly(
    f.client, f.original, f.options);
  assert.equal(review.format, 'oge-vault-standalone-quarantine-review');
  assert.equal(review.status, 'HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE');
  assert.equal(review.historicalCreateVerifiedAgainstUntrustedArchive, true);
  assert.equal(review.selectedCount, 1);
  assert.deepEqual(review.selectedCurrentFiles,
    { unchanged: 1, changed: 0, missing: 0 });
  assert.equal(review.observedActiveDraftWriters, false);
  assert.equal(review.observedActiveSubjectWriters, false);
  assert.equal(review.observedAuxiliaryMetadataStable, true);
  assert.equal(review.observedGitHubHeadStable, true);
  assert.equal(review.blockedBySafetyPolicy, true);
  assert.equal(review.operatorUnlockAuthorized, false);
  assert.equal(review.automaticUnlockAuthorized, false);
  assert.equal(review.safeToRetryAutomatically, false);
  assert.equal(review.quarantineReleasePerformed, false);
  assert.equal(review.isProofPriorWriterStopped, false);
  assert.equal(review.fingerprintIsSignature, false);
  assert.match(review.reviewFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(review).includes(f.options.expectedOperationId), false);
  assert.equal(JSON.stringify(review).includes(f.options.incidentId), false);
  assert.deepEqual(f.counts, {
    ownerChecks: 2, lockReads: 2, activityReads: 2, refReads: 1,
  });
  assert.deepEqual(f.calls, ['/git/ref/heads/main']);
});

test('M78 remote create unproven or later user edits do not become release decisions', async () => {
  const unknown = fixture({ evidenceStatus: 'APPROVED_HEAD_UNCHANGED',
    receiptState: 'claimed' });
  const u = await reviewStandaloneRestoreQuarantineReadOnly(
    unknown.client, unknown.original, unknown.options);
  assert.equal(u.status, 'HOLD_REMOTE_OUTCOME_UNPROVEN');
  assert.ok(u.blockers.includes('historical-github-create-not-proven'));
  assert.ok(u.blockers.includes('standalone-receipt-not-confirmed'));
  assert.equal(u.operatorUnlockAuthorized, false);
  const changed = fixture({ current: {
    unchanged: 0, changed: 1, missing: 0,
  } });
  const c = await reviewStandaloneRestoreQuarantineReadOnly(
    changed.client, changed.original, changed.options);
  assert.equal(c.status, 'HOLD_HISTORICAL_CREATE_WITH_LATER_EDITS');
  assert.ok(c.blockers.includes('selected-content-changed-since-historical-create'));
});

test('M78 unsaved drafts, active subject writers and other unresolved receipts appear as individual blockers', async () => {
  const f = fixture({ before: {
    activeSubjectWriters: 1, pendingNoteDrafts: 1,
    pendingStandaloneDrafts: 2, unresolvedStandaloneReceipts: 2,
  }, after: {
    activeSubjectWriters: 1, pendingNoteDrafts: 1,
    pendingStandaloneDrafts: 2, unresolvedStandaloneReceipts: 2,
  } });
  const r = await reviewStandaloneRestoreQuarantineReadOnly(
    f.client, f.original, f.options);
  assert.equal(r.observedActiveSubjectWriters, true);
  assert.equal(r.pendingEncryptedNoteDraftsPresent, true);
  assert.equal(r.pendingEncryptedStandaloneDraftsPresent, true);
  assert.equal(r.multipleUnresolvedReceiptsPresent, true);
  assert.ok(r.blockers.includes('active-subject-writers-present'));
  assert.ok(r.blockers.includes('encrypted-standalone-drafts-require-preservation-review'));
  assert.equal(r.operatorUnlockAuthorized, false);
});

test('M78 changes in owner lock, active work, Git HEAD or signed user invalidate the packet', async () => {
  for (const opts of [
    { changedLock: true },
    { movingHead: true },
    { revokedAt: 2 },
    { before: defaultActivity, after: {
      ...defaultActivity, pendingStandaloneDrafts: 1,
    } },
  ]) {
    const f = fixture(opts);
    await assert.rejects(reviewStandaloneRestoreQuarantineReadOnly(
      f.client, f.original, f.options),
    e => e instanceof VaultGitHubError && e.status === 409);
  }
});

test('M78 rejects untrusted injected reconciliation and unbounded/activity malformed counts', async () => {
  for (const opts of [
    { malformed: true },
    { before: { ...defaultActivity, pendingNoteDrafts: 3 } },
  ]) {
    const f = fixture(opts);
    await assert.rejects(reviewStandaloneRestoreQuarantineReadOnly(
      f.client, f.original, f.options),
    e => e instanceof VaultGitHubError && e.status === 409);
  }
  const f = fixture();
  f.client.readOnly = false;
  await assert.rejects(reviewStandaloneRestoreQuarantineReadOnly(
    f.client, f.original, f.options), TypeError);
  assert.equal(f.calls.length, 0);
});

test('M78 staging review route has no writer, no lock release, exact incident scope and independent default-off flag', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-current-resources/recovery-review/route.js',
    import.meta.url), 'utf8');
  const gate = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-staging.js',
    import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-standalone-quarantine-review.js',
    import.meta.url), 'utf8');
  assert.match(route, /standaloneRestoreStagingAllowed\(request, \{ review: true \}\)/);
  assert.match(gate, /OGE_VAULT_STANDALONE_QUARANTINE_REVIEW_PREVIEW !== 'true'/);
  assert.match(gate, /OGE_VAULT_STANDALONE_RESTORE_RECONCILE_PREVIEW !== 'true'/);
  assert.match(route, /expectedOperationId/);
  assert.match(route, /incidentId/);
  assert.match(route, /INSPECT_QUARANTINED_STANDALONE_RESTORE_READ_ONLY/);
  assert.match(route, /signedStandaloneRestoreContext\(\)/);
  assert.match(route, /standaloneRestoreIncidentReaders/);
  assert.match(route, /reviewStandaloneRestoreQuarantineReadOnly/);
  assert.match(core, /reconcileStandaloneRestoreReadOnly/);
  assert.match(core, /operatorUnlockAuthorized: false/);
  assert.match(core, /automaticUnlockAuthorized: false/);
  assert.match(core, /quarantineReleasePerformed: false/);
  assert.doesNotMatch(core + route,
    /updateOne\(|deleteOne\(|insertOne\(|findOneAndUpdate\(|withVaultOwnerImportExclusive|markGitHubWriteAttempt|force: false|commitVaultStandaloneCapture|releasePreWriteVaultImportLock/);
});

test('M78 scoped readers use only statically named owner/repo collections with bounded no-content queries', async () => {
  const source = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-incident-readers.js',
    import.meta.url), 'utf8');
  for (const literal of [
    /ownerMutationFilter\(ownerId/,
    /'vault\.installationId': installationId/,
    /'vault\.githubAccountId': readClient\.vault\.githubAccountId/,
    /collection\('vault_standalone_restore_approvals'\)/,
    /collection\('vault_drafts'\)/,
    /collection\('vault_standalone_drafts'\)/,
    /collection\('subjects'\)/,
    /limit: 2/,
  ]) assert.match(source, literal);
  assert.doesNotMatch(source, /updateOne\(|insertOne\(|deleteOne\(|findOneAndUpdate\(/);
});
