import { createHash } from 'node:crypto';
import { VaultGitHubError } from './oge-vault-github.js';
import {
  reconcileStandaloneRestoreReadOnly,
} from './oge-vault-standalone-restore-reconcile.js';

/**
 * E10 / M78: incident-scoped, READ-ONLY operator recovery review packet.
 * A positive M77 historical proof + zero observed active workers still
 * CANNOT prove an abandoned GitHub PATCH has stopped. This component
 * DOES NOT issue a release token or permit any automatic lock removal.
 *
 * The complete untrusted M73 archive stays in process memory only.
 * Hashes in this report are content-free review correlation, NOT signatures.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const fail = (message, status = 409) => new VaultGitHubError(message, status);
const hash = (payload) => createHash('sha256')
  .update('oge-vault-standalone-quarantine-review-m78-v1\n')
  .update(JSON.stringify(payload)).digest('hex');

function boundedCount(number) {
  if (!Number.isSafeInteger(number) || number < 0 || number > 2)
    throw fail('vault-standalone-review-count-invalid');
  return number;
}
function activitySnapshot(activity) {
  if (!activity || typeof activity !== 'object' ||
      Array.isArray(activity) || Object.keys(activity).sort().join(',') !==
      'activeSubjectWriters,pendingNoteDrafts,pendingStandaloneDrafts,unresolvedStandaloneReceipts')
    throw fail('vault-standalone-review-activity-invalid');
  return Object.fromEntries(Object.entries(activity)
    .map(([key, value]) => [key, boundedCount(value)]));
}
function lockSnapshot(value) {
  const raw = value?.lock;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !UUID.test(raw.operationId || '') ||
      !SHA.test(raw.approvedHead || '') ||
      typeof raw.commitMarker !== 'string' ||
      !/^Restore OgeNotes backup [a-f0-9]{64}$/.test(raw.commitMarker) ||
      raw.state !== 'github-write-possible' ||
      !Array.isArray(raw.selectedIds) ||
      !(raw.startedAt instanceof Date) ||
      !(raw.attemptedAt instanceof Date) ||
      !Number.isFinite(raw.startedAt.getTime()) ||
      !Number.isFinite(raw.attemptedAt.getTime()))
    throw fail('vault-standalone-review-lock-invalid');
  const writers = value.activeDraftWriters ?? 0;
  if (!Number.isSafeInteger(writers) || writers < 0)
    throw fail('vault-standalone-review-draft-writer-count-invalid');
  return JSON.stringify({
    operationId: raw.operationId, repoId: raw.repoId,
    state: raw.state, commitMarker: raw.commitMarker,
    approvedHead: raw.approvedHead, selectedIds: raw.selectedIds,
    startedAt: raw.startedAt.toISOString(),
    attemptedAt: raw.attemptedAt.toISOString(),
    draftWriters: writers,
  });
}
function safeOptions(options) {
  return typeof options?.ownerVerifier === 'function' &&
    typeof options?.lockReader === 'function' &&
    typeof options?.receiptReader === 'function' &&
    typeof options?.auxiliaryReader === 'function';
}

/**
 * A separate incident ID is an OPERATOR CORRELATION VALUE (not an access
 * credential). The provider and Mongo read callbacks MUST already be scoped
 * to the exact Auth.js account/private repo; M77 rechecks the signed owner,
 * exact operation, one-time M76 receipt and immutable Git content.
 */
export async function reviewStandaloneRestoreQuarantineReadOnly(
  client, approvedRequest, {
    incidentId, expectedOperationId, ownerVerifier,
    lockReader, receiptReader, auxiliaryReader,
    reconcileReader = reconcileStandaloneRestoreReadOnly,
  } = {},
) {
  if (!UUID.test(incidentId || '') ||
      !UUID.test(expectedOperationId || '') ||
      client?.readOnly !== true ||
      typeof client?.call !== 'function' ||
      !safeOptions({ ownerVerifier, lockReader, receiptReader, auxiliaryReader }) ||
      typeof reconcileReader !== 'function')
    throw new TypeError('Signed read-only incident review context required');

  if (!await ownerVerifier())
    throw fail('vault-standalone-review-owner-changed');
  const beforeLock = lockSnapshot(await lockReader());
  const before = activitySnapshot(await auxiliaryReader());

  // M77 validates the full untrusted source, canonical selection/marker,
  // exactly matched owner lock, claimed/confirmed receipt, at most 20
  // linear Git commits, complete tree delta, immutable blob contents, and
  // rechecks head + lock + receipt + signed identity before returning.
  const checked = await reconcileReader(client, approvedRequest, {
    expectedOperationId, ownerVerifier, lockReader, receiptReader,
  });
  if (checked?.format !== 'oge-vault-standalone-restore-reconciliation' ||
      checked?.version !== 1 || checked.readOnly !== true ||
      checked.ownerLockStable !== true ||
      checked.operatorUnlockAuthorized !== false ||
      checked.automaticUnlockAuthorized !== false ||
      checked.safeToRetryAutomatically !== false ||
      checked.gitWritesPerformed !== false ||
      checked.mongoWritesPerformed !== false ||
      checked.sourceGitHubIdentityAuthenticated !== false ||
      checked.independentWriterQuiescenceVerified !== false ||
      !['quick-notes', 'airnotes'].includes(checked.kind) ||
      !Array.isArray(checked.selectedIds) ||
      checked.selectedIds.length < 1 || checked.selectedIds.length > 12 ||
      !SHA.test(checked.expectedTargetHead || '') ||
      !SHA.test(checked.observedTargetHead || ''))
    throw fail('vault-standalone-review-evidence-invalid');

  const after = activitySnapshot(await auxiliaryReader());
  const afterLock = lockSnapshot(await lockReader());
  if (beforeLock !== afterLock || JSON.stringify(before) !== JSON.stringify(after))
    throw fail('vault-standalone-review-snapshot-changed');

  // A changed owner or GitHub HEAD invalidates all observations, even when
  // individual M77 evidence was once historically true.
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (head !== checked.observedTargetHead ||
      !await ownerVerifier())
    throw fail('vault-standalone-review-owner-or-head-changed');

  const draftWriters = JSON.parse(afterLock).draftWriters;
  const proven = checked.status === 'HISTORICAL_CREATE_CONTENT_VERIFIED' &&
    checked.historicalSelectedContentVerified === true &&
    SHA.test(checked.candidateCommitSha || '');
  const changed = proven && checked.currentSelectedFiles &&
    (checked.currentSelectedFiles.changed > 0 ||
      checked.currentSelectedFiles.missing > 0);
  const blockers = [
    'prior-github-worker-quiescence-not-independently-proven',
    'separate-independent-incident-approval-required',
    'postwrite-lock-release-not-implemented',
    'original-archive-source-authenticity-not-proven',
  ];
  if (!proven) blockers.push('historical-github-create-not-proven');
  if (changed) blockers.push('selected-content-changed-since-historical-create');
  if (checked.receiptState !== 'confirmed')
    blockers.push('standalone-receipt-not-confirmed');
  if (draftWriters > 0)
    blockers.push('active-draft-writer-counter-nonzero');
  if (after.activeSubjectWriters > 0)
    blockers.push('active-subject-writers-present');
  if (after.pendingNoteDrafts > 0)
    blockers.push('encrypted-note-drafts-require-preservation-review');
  if (after.pendingStandaloneDrafts > 0)
    blockers.push('encrypted-standalone-drafts-require-preservation-review');
  if (after.unresolvedStandaloneReceipts > 1)
    blockers.push('multiple-unresolved-standalone-receipts');

  const reviewStatus = !proven ? 'HOLD_REMOTE_OUTCOME_UNPROVEN' :
    changed ? 'HOLD_HISTORICAL_CREATE_WITH_LATER_EDITS' :
      'HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE';
  const metadata = {
    incidentId, expectedOperationId,
    kind: checked.kind, selectedIds: checked.selectedIds,
    expectedHead: checked.expectedTargetHead,
    currentHead: checked.observedTargetHead,
    candidateCommitSha: checked.candidateCommitSha,
    receiptState: checked.receiptState,
    activity: after,
    draftWriters,
    reviewStatus,
  };
  return {
    format: 'oge-vault-standalone-quarantine-review',
    version: 1, status: reviewStatus,
    reviewFingerprint: hash(metadata),
    fingerprintIsSignature: false,
    incidentIdDisclosed: false, operationIdDisclosed: false,
    kind: checked.kind, selectedCount: checked.selectedIds.length,
    historicalCreateVerifiedAgainstUntrustedArchive: proven,
    selectedCurrentFiles: proven ? checked.currentSelectedFiles : null,
    receiptState: checked.receiptState,
    observedActiveDraftWriters: draftWriters > 0,
    observedActiveSubjectWriters: after.activeSubjectWriters > 0,
    pendingEncryptedNoteDraftsPresent: after.pendingNoteDrafts > 0,
    pendingEncryptedStandaloneDraftsPresent:
      after.pendingStandaloneDrafts > 0,
    multipleUnresolvedReceiptsPresent:
      after.unresolvedStandaloneReceipts > 1,
    observedGitHubHeadStable: true,
    observedOwnerLockStable: true,
    observedAuxiliaryMetadataStable: true,
    blockers,
    blockedBySafetyPolicy: true,
    operatorNextAction: 'KEEP_QUARANTINE_AND_ESCALATE_INDEPENDENT_REVIEW',
    isProofPriorWriterStopped: false,
    verifiedOperatorAuthorization: false,
    sourceGitHubIdentityAuthenticated: false,
    canCommit: false, canRestore: false,
    readOnly: true, gitWritesPerformed: false,
    noteContentStoredInMongo: false,
    importedDraftsDeleted: false,
    automaticUnlockAuthorized: false,
    operatorUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
  };
}
