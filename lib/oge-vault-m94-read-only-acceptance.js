import { createHash, webcrypto } from 'node:crypto';
import {
  checkVaultLiveAcceptanceDrillGuard,
  executeVaultLiveAcceptanceReadOnlyDrill,
} from './oge-vault-live-acceptance-drill.js';
import { vaultRecoveryStaleRecheckAllowed } from './oge-vault-recovery-stale-guard.js';
import { loadVaultRecoveryVerifiedFile } from './oge-vault-restore-preview.js';
import { previewVaultHistoricallyAuthenticatedRecoveryFiles } from './oge-vault-historical-restore-preview.js';

/**
 * E26/M94 operator-initiated signed staging READ-ONLY acceptance drill.
 * Reuses M84's actual signed-session observation format and M93's guarded
 * history/current/current comparison, without adding any provider write path.
 *
 * This does NOT perform OAuth login, attest physical devices, approve restore,
 * test actual lost-write failure, or independently certify provider identity.
 */
const OPT_IN = 'YES_SIGNED_DISPOSABLE_READS_NO_WRITES';
export function vaultM94RunBindingDigest(runId, origin) {
  if (typeof runId !== 'string' || typeof origin !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId) ||
      !/^https:\/\/[a-zA-Z0-9.-]{1,240}$/.test(origin)) {
    throw new TypeError('Invalid private acceptance run binding');
  }
  return createHash('sha256')
    .update('oge-vault-m94-observation-run-v1\n' + runId + '\n' + origin, 'utf8')
    .digest('hex');
}

const refuse = () => { throw new TypeError(
  'M94 protected signed read-only acceptance incomplete or blocked'); };

export function checkVaultM94ReadOnlyAcceptanceGuard(
  env = {}, readiness,
) {
  return env.OGE_VAULT_M94_READ_ONLY_ACCEPTANCE === OPT_IN &&
    env.OGE_VAULT_M94_OPERATOR_ACK === 'NO_REAL_USER_NOTES_OR_GITHUB_WRITES' &&
    checkVaultLiveAcceptanceDrillGuard(env) &&
    vaultRecoveryStaleRecheckAllowed(env, readiness) &&
    env.OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW !== 'true' &&
    env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true' &&
    env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true' &&
    env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' &&
    !env.OGE_VAULT_CHUNK_RESTORE_WRITE_ACK &&
    !env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK;
}

export async function executeVaultM94ReadOnlyAcceptance({
  env, backupFile, referenceFile, invokeSignedRead, invokeSourceRead,
  subtle = webcrypto.subtle, nonceSource, readiness,
} = {}) {
  if (!checkVaultM94ReadOnlyAcceptanceGuard(env, readiness) ||
      !backupFile || !referenceFile ||
      typeof invokeSignedRead !== 'function' ||
      typeof invokeSourceRead !== 'function' ||
      !subtle || typeof subtle.digest !== 'function') refuse();

  try {
    // Both private files MUST pass M88 before even the first M82 signed read.
    // The archive objects are never persisted, returned, uploaded or logged.
    await loadVaultRecoveryVerifiedFile(backupFile, subtle);
    await loadVaultRecoveryVerifiedFile(referenceFile, subtle);

    // M84 returns private challenges and observations to this local stack
    // only; neither is included in the redacted M94 result.
    const pair = await executeVaultLiveAcceptanceReadOnlyDrill({
      env, invoke: invokeSignedRead, ...(nonceSource ? { nonceSource } : {}),
    });
    if (pair.safeSummary?.observedSessionStateCount !== 2 ||
        pair.safeSummary?.completeStagingAcceptanceSignedOff !== false ||
        pair.safeSummary?.twoPhysicalDevicesIndependentlyVerified !== false ||
        pair.safeSummary?.githubWritesPerformed !== false ||
        pair.safeSummary?.canReleaseImportLock !== false) refuse();

    // One M93 comparison on an already signed staging session:
    // 1 bounded historical source read and 2 current source reads.
    // A SECOND full comparison under the same account would exceed the
    // existing 3/owner/hour M89 check limit; do not run it.
    const report = await previewVaultHistoricallyAuthenticatedRecoveryFiles(
      backupFile, referenceFile, {
        subtle, fetcher: invokeSourceRead, recheckCurrent: true,
      });
    if (report?.status !== 'HISTORICAL_AND_CURRENT_RECHECK_MATCHED_READ_ONLY' ||
        report.backupSourceAuthenticated !== true ||
        report.currentSnapshotAuthenticatedAtCheck !== true ||
        report.finalCurrentSourceRecheckPassedAtInspection !== true ||
        report.currentSourceChecksPerformed !== 2 ||
        report.manualReviewRequired !== true ||
        ![
          'MANUAL_CONFLICT_REVIEW_REQUIRED_NO_RESTORE',
          'MANUAL_ADDITION_REVIEW_REQUIRED_NO_RESTORE',
          'READ_ONLY_REVIEW_REQUIRED_NO_RESTORE',
        ].includes(report.reviewState) ||
        report.historyAndCurrentChecksWereAtomic !== false ||
        report.snapshotMayBecomeStaleAfterCheck !== true ||
        report.recoveryApproved !== false ||
        report.restorationAuthorized !== false ||
        report.canRestore !== false ||
        report.canAuthorizeImport !== false ||
        report.canReleaseImportLock !== false ||
        report.canRetryUnknownWrite !== false ||
        report.githubWritesPerformed !== false ||
        report.fileContentsUploaded !== false) refuse();

    return Object.freeze({
      format: 'oge-vault-m94-signed-staging-read-only-observation',
      version: 1,
      // A correlatable opaque digest, NOT a signature or proof of issuer,
      // physical device, capture time, or external provenance.
      runBindingSha256: vaultM94RunBindingDigest(
        env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID,
        env.OGE_STAGING_URL),
      status: 'SIGNED_SESSIONS_AND_READ_ONLY_PROVIDER_CHECKS_OBSERVED_HOLD',
      signedSessionReadObservations: 2,
      boundedHistoricalSourceChecks: 1,
      currentSourceChecks: 2,
      privateArchiveBodiesUploaded: false,
      operatorReadOnlyStagingObservationRecorded: true,
      observedProviderReadsViaStaging: true,
      twoPhysicalDevicesIndependentlyVerified: false,
      oauthProviderIssuerIndependentlyVerified: false,
      actualOAuthLoginPerformedByRunner: false,
      realProviderFaultMatrixCompleted: false,
      actualLostAcknowledgementInduced: false,
      operatorStagingSignoffComplete: false,
      independentlyAudited: false,
      fullAccountBackupValidated: false,
      restorationAuthorized: false,
      canAuthorizeImport: false,
      canRetryUnknownWrite: false,
      canReleaseImportLock: false,
      canEnableProduction: false,
      productionReady: false,
      githubWritesPerformed: false,
    });
  } catch { refuse(); }
}
