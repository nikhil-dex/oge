import { timingSafeEqual } from 'node:crypto';
import { vaultM94RunBindingDigest } from './oge-vault-m94-read-only-acceptance.js';

/**
 * E27/M95 OFFLINE acceptance evidence CORRELATOR.
 * The wrapper MUST recompute M94 report SHA256 from an owner-only file and
 * call the existing M68/M83 on-disk evidence verifier on the SAME run.
 *
 * This proves byte integrity/correlation only. Neither M94 nor M83 files
 * are provider-signed attestations and two physical devices are NOT proven.
 * Never authorize production, restore, GitHub writes or lock release.
 */
const OBS_FIELDS = Object.freeze([
  'format', 'version', 'runBindingSha256', 'status',
  'signedSessionReadObservations','boundedHistoricalSourceChecks',
  'currentSourceChecks','privateArchiveBodiesUploaded',
  'operatorReadOnlyStagingObservationRecorded','observedProviderReadsViaStaging',
  'twoPhysicalDevicesIndependentlyVerified',
  'oauthProviderIssuerIndependentlyVerified','actualOAuthLoginPerformedByRunner',
  'realProviderFaultMatrixCompleted','actualLostAcknowledgementInduced',
  'operatorStagingSignoffComplete','independentlyAudited',
  'fullAccountBackupValidated','restorationAuthorized','canAuthorizeImport',
  'canRetryUnknownWrite','canReleaseImportLock','canEnableProduction',
  'productionReady','githubWritesPerformed',
]);
const TRUE = Object.freeze([
  'operatorReadOnlyStagingObservationRecorded',
  'observedProviderReadsViaStaging',
]);
const FALSE = OBS_FIELDS.filter(key => ![
  'format','version','runBindingSha256','status',
  'signedSessionReadObservations','boundedHistoricalSourceChecks',
  'currentSourceChecks',...TRUE,
].includes(key));
const exact = (obj, keys) => Boolean(obj && typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...keys].sort().join(','));
const SHA = /^[a-f0-9]{64}$/;
const deny = () => { throw new TypeError(
  'Invalid, mixed-run, forged or incomplete private Vault acceptance evidence'); };

export function inspectVaultM95OfflineEvidence(
  observation, artifactEvidence, {
    expectedRunId, expectedOrigin,
    reportFileHashVerified = false,
  } = {},
) {
  if (!exact(observation, OBS_FIELDS) ||
      observation.format !== 'oge-vault-m94-signed-staging-read-only-observation' ||
      observation.version !== 1 ||
      observation.status !==
        'SIGNED_SESSIONS_AND_READ_ONLY_PROVIDER_CHECKS_OBSERVED_HOLD' ||
      !SHA.test(observation.runBindingSha256 || '') ||
      observation.signedSessionReadObservations !== 2 ||
      observation.boundedHistoricalSourceChecks !== 1 ||
      observation.currentSourceChecks !== 2 ||
      TRUE.some(key => observation[key] !== true) ||
      FALSE.some(key => observation[key] !== false) ||
      reportFileHashVerified !== true) deny();
  const target = vaultM94RunBindingDigest(expectedRunId, expectedOrigin);
  if (!timingSafeEqual(
    Buffer.from(observation.runBindingSha256, 'hex'),
    Buffer.from(target, 'hex'))) deny();

  // This value MUST be the actual return from the existing M68 verifier
  // after hashing every M67 evidence artifact on disk and checking M83.
  // It is not independently authentic if the caller supplies a forged object.
  const paired = artifactEvidence?.acceptanceReadiness;
  if (artifactEvidence?.format !==
      'oge-vault-two-device-artifact-hash-report' ||
      artifactEvidence.version !== 1 ||
      artifactEvidence.onDiskArtifactHashesRecomputed !== true ||
      artifactEvidence.noDatabaseOrGitHubRequestsPerformed !== true ||
      artifactEvidence.completeStagingAcceptanceSignedOff !== false ||
      artifactEvidence.canEnableProduction !== false ||
      artifactEvidence.canAuthorizeGitHubWrites !== false ||
      artifactEvidence.canReleaseImportLock !== false ||
      artifactEvidence.canRetryUnknownWrite !== false ||
      artifactEvidence.physicalDevicesIndependentlyVerified !== false ||
      artifactEvidence.sourceCaptureProvenanceVerified !== false ||
      !paired ||
      paired.format !== 'oge-vault-two-device-acceptance-readiness' ||
      paired.version !== 1 ||
      paired.pairedBrowserObservationCount !== 2 ||
      paired.independentOperatorChallengeHashesMatched !== true ||
      paired.localScenarioEvidenceArtifactHashesVerified !== true ||
      paired.completeStagingAcceptanceSignedOff !== false ||
      paired.physicalDeviceIdentityIndependentlyVerified !== false ||
      paired.actualGitHubOAuthIssuerIndependentlyVerified !== false ||
      paired.evidenceTruthIndependentlyVerified !== false ||
      paired.productionReady !== false ||
      paired.canEnableProduction !== false ||
      paired.canAuthorizeGitHubWrites !== false ||
      paired.canAuthorizeRestore !== false ||
      paired.canReleaseImportLock !== false ||
      paired.canRetryUnknownWrite !== false ||
      paired.githubWritesPerformed !== false) deny();

  const completeIndex = paired.allScenarioClaimsPresentAndPassed === true &&
    artifactEvidence.status ===
      'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED' &&
    paired.status ===
      'PAIRED_OBSERVATIONS_AND_HASHED_MATRIX_READY_FOR_MANUAL_REVIEW_HOLD';
  if (!completeIndex &&
      (paired.allScenarioClaimsPresentAndPassed !== false ||
        paired.status !==
          'PAIRED_OBSERVATIONS_BUT_INCOMPLETE_MATRIX_HOLD' ||
        ![
          'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED',
          'ON_DISK_HASHES_MATCH_INCOMPLETE_EVIDENCE_INDEX',
        ].includes(artifactEvidence.status))) deny();

  return Object.freeze({
    format: 'oge-vault-m95-private-acceptance-evidence-review',
    version: 1,
    status: completeIndex
      ? 'CORRELATED_PRIVATE_EVIDENCE_READY_FOR_EXTERNAL_REVIEW_HOLD'
      : 'CORRELATED_PRIVATE_EVIDENCE_INCOMPLETE_HOLD',
    m94PrivateReportSha256RecomputedAndMatched: true,
    m94RunBindingMatchedToIndependentOperatorScope: true,
    signedSessionObservationCount: 2,
    historicalReadClaimCount: 1,
    currentReadClaimCount: 2,
    m67ArtifactsRehashedByM68: true,
    m82SignedSessionPairValidatedByM83: true,
    allM67ScenarioClaimsReportedPassed: completeIndex,
    privateEvidenceContentsReturned: false,
    capturedEvidenceTruthVerified: false,
    providerSignedAttestationsVerified: false,
    oauthIssuerIndependentlyVerified: false,
    twoPhysicalDevicesIndependentlyVerified: false,
    realProviderFaultsIndependentlyVerified: false,
    independentSecurityReviewerSignedOff: false,
    completeStagingAcceptanceSignedOff: false,
    canAuthorizeRestore: false,
    canAuthorizeGitHubWrites: false,
    canAuthorizeImport: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    canEnableProduction: false,
    productionReady: false,
    githubWritesPerformed: false,
    databaseOrGitHubRequestsPerformed: false,
  });
}
