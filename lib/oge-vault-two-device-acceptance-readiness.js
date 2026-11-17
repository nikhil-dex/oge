/**
 * E15 / M83: OFFLINE correlation of the M67/M68 evidence matrix with TWO
 * M82 browser observations and independently supplied operator challenges.
 * No cryptographic provenance for downloaded JSON or physical device proof.
 * The caller must pass actual M68-verified artifact evidence, not an
 * unverified, caller-asserted "passed" manifest.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { inspectVaultTwoDeviceEvidenceManifest } from './oge-vault-two-device-evidence.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const SLOTS = Object.freeze(['device-a', 'device-b']);
const FORMAT = 'oge-vault-signed-device-acceptance-observation';
const POSITIVE = 'SIGNED_SESSION_PRIVATE_GITHUB_READ_OBSERVED_PENDING_EXTERNAL_ACCEPTANCE';
const OBS_FIELDS = Object.freeze([
  'format', 'version', 'status', 'declaredDeviceSlot',
  'deviceSlotProvesPhysicalDevice', 'challengeFingerprint',
  'challengeUniquenessAcrossDevicesVerified',
  'signedOwnerScopedSessionObserved',
  'privateGitHubAppReadOnlyPairObserved',
  'privateGitHubHeadTreeConsistentDuringCheck',
  'ownerAndGitHubInstallationMappingStableDuringCheck',
  'actualOAuthProviderIndependentlyVerified',
  'physicalDeviceIdentityIndependentlyVerified',
  'twoDistinctPhysicalDeviceSessionsVerified',
  'multiDeviceAutosaveAndConflictFlowVerified',
  'sourceArchiveIdentityVerified',
  'unexpectedGitHubWriteOutcomeResolved',
  'realProviderFaultMatrixVerified',
  'completeStagingAcceptanceSignedOff',
  'productionReady', 'canAuthorizeGitHubWrites', 'canAuthorizeRestore',
  'canReleaseImportLock', 'canRetryUnknownWrite', 'readOnly',
  'githubWritesPerformed', 'mongodbWritesPerformed', 'privateNotesRead',
  'secretsOrOwnerIdReturned',
]);
const POSITIVE_FLAGS = [
  'signedOwnerScopedSessionObserved',
  'privateGitHubAppReadOnlyPairObserved',
  'privateGitHubHeadTreeConsistentDuringCheck',
  'ownerAndGitHubInstallationMappingStableDuringCheck',
  'readOnly',
];
const NEGATIVE_FLAGS = OBS_FIELDS.filter((field) =>
  !['format', 'version', 'status', 'declaredDeviceSlot',
    'challengeFingerprint', ...POSITIVE_FLAGS].includes(field));
const exact = (obj, fields) => Boolean(
  obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...fields].sort().join(','));
const deny = () => { throw new TypeError(
  'Invalid, untrusted, mixed-run or inconsistent signed acceptance pair'); };
const digest = (challenge) => createHash('sha256')
  .update('oge-vault-signed-acceptance-read-m82-v1\n')
  .update(challenge).digest();

export function assertVaultSignedDeviceObservation(observation, slot, expectedChallenge) {
  if (!exact(observation, OBS_FIELDS) ||
      observation.format !== FORMAT || observation.version !== 1 ||
      observation.status !== POSITIVE ||
      observation.declaredDeviceSlot !== slot ||
      !HEX.test(observation.challengeFingerprint || '') ||
      !HEX.test(expectedChallenge || '') ||
      POSITIVE_FLAGS.some((key) => observation[key] !== true) ||
      NEGATIVE_FLAGS.some((key) => observation[key] !== false))
    deny();
  const observedHash = Buffer.from(observation.challengeFingerprint, 'hex');
  if (!timingSafeEqual(observedHash, digest(expectedChallenge))) deny();
}

/**
 * This is a pure evidence CORRELATOR, not an acceptance authority.
 * M68 is invoked by the trusted offline wrapper, which supplies the EXACT
 * private M67 manifest after verifying its actual matching on-disk files.
 * expectedRunId and challenges MUST come from an independent operator
 * channel and cannot be chosen by the uploaded pair file.
 */
export function inspectVaultSignedTwoDeviceAcceptancePair(
  manifest, pair, {
    expectedOrigin, expectedRunId, deviceAChallenge, deviceBChallenge,
    artifactHashesVerified = false, now = Date.now(),
  } = {},
) {
  if (!exact(pair, ['format', 'version', 'runId', 'origin', 'observations']) ||
      pair.format !== 'oge-vault-signed-device-acceptance-pair' ||
      pair.version !== 1 || !UUID.test(pair.runId || '') ||
      !exact(pair.observations, SLOTS) ||
      !UUID.test(expectedRunId || '') ||
      manifest?.runId !== expectedRunId || pair.runId !== expectedRunId ||
      pair.origin !== expectedOrigin ||
      artifactHashesVerified !== true ||
      !HEX.test(deviceAChallenge || '') ||
      !HEX.test(deviceBChallenge || '') ||
      deviceAChallenge === deviceBChallenge)
    deny();

  const inventory = inspectVaultTwoDeviceEvidenceManifest(manifest, {
    expectedOrigin, now,
  });
  for (const [slot, challenge] of [
    ['device-a', deviceAChallenge], ['device-b', deviceBChallenge],
  ]) assertVaultSignedDeviceObservation(pair.observations[slot], slot, challenge);
  if (pair.observations['device-a'].challengeFingerprint ===
      pair.observations['device-b'].challengeFingerprint) deny();

  const observedOAuth = ['oauth-device-a', 'oauth-device-b'].map((scenario) =>
    manifest.records.find((entry) => entry.scenario === scenario));
  const oauthBothReported = observedOAuth.every((record) =>
    record?.outcome === 'observed-pass');

  const blockers = [];
  if (inventory.missingScenarios.length)
    blockers.push('failure-matrix-scenarios-missing');
  if (inventory.reportedFailedScenarios.length)
    blockers.push('failure-matrix-scenarios-reported-failed');
  if (!oauthBothReported)
    blockers.push('both-device-oauth-scenarios-not-reported-pass');
  if (!inventory.differentSessionMarkersReported)
    blockers.push('different-device-session-markers-not-reported');
  const indexed = inventory.status ===
    'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW' &&
    oauthBothReported && inventory.differentSessionMarkersReported;
  return Object.freeze({
    format: 'oge-vault-two-device-acceptance-readiness',
    version: 1,
    status: indexed
      ? 'PAIRED_OBSERVATIONS_AND_HASHED_MATRIX_READY_FOR_MANUAL_REVIEW_HOLD'
      : 'PAIRED_OBSERVATIONS_BUT_INCOMPLETE_MATRIX_HOLD',
    pairedBrowserObservationCount: 2,
    independentOperatorChallengeHashesMatched: true,
    independentChallengesDistinct: true,
    reportedDeviceSlotsDistinct: true,
    reportedSessionMarkersDistinct: inventory.differentSessionMarkersReported,
    bothOAuthScenarioClaimsPresent: oauthBothReported,
    observedScenarioCount: inventory.observedScenarioCount,
    requiredScenarioCount: inventory.requiredScenarioCount,
    missingScenarios: inventory.missingScenarios,
    reportedFailedScenarios: inventory.reportedFailedScenarios,
    localScenarioEvidenceArtifactHashesVerified: true,
    allScenarioClaimsPresentAndPassed: indexed,
    blockers: [
      ...blockers,
      'independent-physical-device-identity-not-proven',
      'oauth-issuer-and-session-provenance-not-independent',
      'redacted-captured-evidence-authenticity-not-proven',
      'real-provider-fault-injection-not-executed-by-this-review',
      'operator-security-acceptance-not-signed',
    ],
    // M82 device labels are untrusted, and neither M67 source nor M82
    // reports contain cryptographic evidence of physical device identity.
    physicalDeviceIdentityIndependentlyVerified: false,
    twoAuthenticatedPhysicalDevicesIndependentlyVerified: false,
    twoM82ObservationsLinkedToM67SessionMarkersByProvider: false,
    actualGitHubOAuthIssuerIndependentlyVerified: false,
    artifactCaptureProducerAuthenticated: false,
    evidenceTruthIndependentlyVerified: false,
    realProviderFaultMatrixIndependentlyVerified: false,
    remoteWriteQuiescenceProven: false,
    completeStagingAcceptanceSignedOff: false,
    productionReady: false,
    canEnableProduction: false,
    canAuthorizeGitHubWrites: false,
    canAuthorizeRestore: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    readOnly: true,
    databaseOrGitHubRequestsPerformed: false,
    privateArtifactBytesReturned: false,
    rawChallengesReturned: false,
    ownerOrSessionIdsReturned: false,
    githubWritesPerformed: false,
    mongoWritesPerformed: false,
  });
}
