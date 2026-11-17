import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  vaultM94RunBindingDigest,
} from '../lib/oge-vault-m94-read-only-acceptance.js';
import {
  inspectVaultM95OfflineEvidence,
} from '../lib/oge-vault-m95-evidence-review.js';

const ORIGIN = 'https://vault-staging.example.test';
const RUN = 'c9868d1a-0d20-4de6-befe-3494b7a2fba5';
function m94() {
  return {
    format: 'oge-vault-m94-signed-staging-read-only-observation',
    version: 1,
    runBindingSha256: vaultM94RunBindingDigest(RUN, ORIGIN),
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
  };
}
function m83(complete = true) {
  return {
    format: 'oge-vault-two-device-artifact-hash-report',
    version: 1,
    status: complete
      ? 'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED'
      : 'ON_DISK_HASHES_MATCH_INCOMPLETE_EVIDENCE_INDEX',
    onDiskArtifactHashesRecomputed: true,
    noDatabaseOrGitHubRequestsPerformed: true,
    completeStagingAcceptanceSignedOff: false,
    canEnableProduction: false,
    canAuthorizeGitHubWrites: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    physicalDevicesIndependentlyVerified: false,
    sourceCaptureProvenanceVerified: false,
    acceptanceReadiness: {
      format: 'oge-vault-two-device-acceptance-readiness',
      version: 1,
      status: complete
        ? 'PAIRED_OBSERVATIONS_AND_HASHED_MATRIX_READY_FOR_MANUAL_REVIEW_HOLD'
        : 'PAIRED_OBSERVATIONS_BUT_INCOMPLETE_MATRIX_HOLD',
      pairedBrowserObservationCount: 2,
      independentOperatorChallengeHashesMatched: true,
      localScenarioEvidenceArtifactHashesVerified: true,
      allScenarioClaimsPresentAndPassed: complete,
      completeStagingAcceptanceSignedOff: false,
      physicalDeviceIdentityIndependentlyVerified: false,
      actualGitHubOAuthIssuerIndependentlyVerified: false,
      evidenceTruthIndependentlyVerified: false,
      productionReady: false,
      canEnableProduction: false,
      canAuthorizeGitHubWrites: false,
      canAuthorizeRestore: false,
      canReleaseImportLock: false,
      canRetryUnknownWrite: false,
      githubWritesPerformed: false,
    },
  };
}
const review = (obs = m94(), artifacts = m83(), changes = {}) =>
  inspectVaultM95OfflineEvidence(obs, artifacts, {
    expectedOrigin: ORIGIN,
    expectedRunId: RUN,
    reportFileHashVerified: true,
    ...changes,
  });

test('M95 complete privately hashed M94/M83 index still gives external MANUAL REVIEW HOLD, no signoff', () => {
  const result = review();
  assert.equal(result.status,
    'CORRELATED_PRIVATE_EVIDENCE_READY_FOR_EXTERNAL_REVIEW_HOLD');
  assert.equal(result.m94PrivateReportSha256RecomputedAndMatched, true);
  assert.equal(result.m94RunBindingMatchedToIndependentOperatorScope, true);
  assert.equal(result.m67ArtifactsRehashedByM68, true);
  assert.equal(result.m82SignedSessionPairValidatedByM83, true);
  assert.equal(result.allM67ScenarioClaimsReportedPassed, true);
  for (const key of [
    'capturedEvidenceTruthVerified',
    'providerSignedAttestationsVerified',
    'oauthIssuerIndependentlyVerified',
    'twoPhysicalDevicesIndependentlyVerified',
    'realProviderFaultsIndependentlyVerified',
    'independentSecurityReviewerSignedOff',
    'completeStagingAcceptanceSignedOff',
    'canAuthorizeRestore','canAuthorizeGitHubWrites',
    'canAuthorizeImport','canReleaseImportLock','canRetryUnknownWrite',
    'canEnableProduction','productionReady','githubWritesPerformed',
    'databaseOrGitHubRequestsPerformed','privateEvidenceContentsReturned',
  ]) assert.equal(result[key], false, key);
  for (const privateValue of [RUN, ORIGIN, m94().runBindingSha256]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('M95 incomplete claimed M83 artifact matrix returns INCOMPLETE HOLD without optimistic inference', () => {
  const result = review(m94(), m83(false));
  assert.equal(result.status, 'CORRELATED_PRIVATE_EVIDENCE_INCOMPLETE_HOLD');
  assert.equal(result.allM67ScenarioClaimsReportedPassed, false);
  assert.equal(result.canAuthorizeRestore, false);
  assert.equal(result.canReleaseImportLock, false);
});

test('M95 rejects missing independent hash confirmation, mixed-run M94 report, malformed digest and extra fields', () => {
  assert.throws(() => review(m94(), m83(), {
    reportFileHashVerified: false,
  }), TypeError);
  assert.throws(() => review(m94(), m83(), {
    expectedRunId: 'f9868d1a-0d20-4de6-befe-3494b7a2fba5',
  }), TypeError);
  assert.throws(() => review({ ...m94(), runBindingSha256: 'bad' }), TypeError);
  assert.throws(() => review({ ...m94(),
    noteId: 'private-note-must-never-be-returned',
  }), TypeError);
  assert.throws(() => review({ ...m94(), status: 'PRODUCTION_READY' }), TypeError);
});

test('M95 forged report approvals and forged M83 positive claims are rejected', () => {
  const badM94 = [
    { canEnableProduction: true }, { canReleaseImportLock: true },
    { restorationAuthorized: true }, { githubWritesPerformed: true },
    { privateArchiveBodiesUploaded: true },
    { currentSourceChecks: 1 },
    { signedSessionReadObservations: 1 },
    { observedProviderReadsViaStaging: false },
    { twoPhysicalDevicesIndependentlyVerified: true },
    { oauthProviderIssuerIndependentlyVerified: true },
  ];
  for (const change of badM94) {
    assert.throws(() => review({ ...m94(), ...change }), TypeError);
  }
  for (const change of [
    { canEnableProduction: true },
    { sourceCaptureProvenanceVerified: true },
    { physicalDevicesIndependentlyVerified: true },
    { noDatabaseOrGitHubRequestsPerformed: false },
    { onDiskArtifactHashesRecomputed: false },
  ]) {
    assert.throws(() => review(m94(), { ...m83(), ...change }), TypeError);
  }
  assert.throws(() => review(m94(), {
    ...m83(),
    acceptanceReadiness: {
      ...m83().acceptanceReadiness, canAuthorizeRestore: true,
    },
  }), TypeError);
});

test('M95 CLI denies absent opt-in, uses local M68/M83 file hashing and no GitHub/Mongo clients', async () => {
  const [cli, core, m94cli, env] = await Promise.all([
    readFile(new URL('../scripts/review-vault-m95-private-acceptance.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-m95-evidence-review.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/run-vault-m94-readonly-acceptance.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  assert.match(cli, /verifyVaultTwoDeviceEvidenceArtifacts/);
  assert.match(cli, /timingSafeEqual/);
  assert.match(cli, /constants\.O_NOFOLLOW/);
  assert.match(cli, /before\.nlink !== 1/);
  assert.match(cli, /privateJson\(env\.OGE_VAULT_M95_M94_REPORT_FILE/);
  assert.match(cli, /OGE_VAULT_M95_EXPECTED_M94_SHA256/);
  assert.match(cli, /process\.exitCode = result\.allM67ScenarioClaimsReportedPassed \? 2 : 3/);
  assert.match(m94cli, /constants\.O_EXCL/);
  assert.match(m94cli, /OGE_VAULT_M94_PRIVATE_REPORT_FILE/);
  assert.match(m94cli, /await privateReport\(result\)/);
  assert.match(env, /OGE_VAULT_M95_OFFLINE_EVIDENCE_REVIEW=/);
  assert.doesNotMatch(cli + core,
    /\bMongoClient\b|getVaultNoteClient|vaultGithubRequest|\bfetch\(|method:\s*['"]PATCH['"]/);
  const cmd = new URL('../scripts/review-vault-m95-private-acceptance.mjs',
    import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cmd], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BLOCKED:/);
});
