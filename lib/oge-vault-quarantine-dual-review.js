import {
  createHash, createPublicKey, verify as verifySignature,
} from 'node:crypto';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E11/M79: OFFLINE, read-only dual-Ed25519 operator attestation validator.
 *
 * This authenticates TWO independently trusted public-key holders'
 * attestations to the SAME narrowly scoped metadata dossier. It does NOT
 * authenticate external quiescence evidence, live GitHub state, original
 * backup provenance, or authorize a MongoDB lock release/retry.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_AGE = 15 * 60 * 1000;
const PREFIX = 'oge-vault-quarantine-two-reviewers-m79-v1\n';
const CONFIRM = 'ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE';
const STATUSES = new Set([
  'HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE',
  'HOLD_HISTORICAL_CREATE_WITH_LATER_EDITS',
  'HOLD_REMOTE_OUTCOME_UNPROVEN',
]);
const MANDATORY_BLOCKERS = [
  'prior-github-worker-quiescence-not-independently-proven',
  'separate-independent-incident-approval-required',
  'postwrite-lock-release-not-implemented',
  'original-archive-source-authenticity-not-proven',
];
const fail = (code) => new VaultGitHubError(code, 409);
const fields = (obj, required) => obj && typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...required].sort().join(',');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isPositive = (x) => Number.isSafeInteger(x) && x > 0;

function iso(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string' && DATE.test(value) &&
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed : null;
}
function validScope(scope) {
  if (!fields(scope, [
    'incidentId', 'operationId', 'ownerScopeSha256',
    'repoId', 'installationId',
  ]) || !UUID.test(scope.incidentId || '') ||
      !UUID.test(scope.operationId || '') ||
      !HASH.test(scope.ownerScopeSha256 || '') ||
      !isPositive(scope.repoId) || !isPositive(scope.installationId))
    throw fail('vault-quarantine-attestation-scope-invalid');
  return scope;
}

function canonicalClaim(input) {
  const required = [
    'format', 'version', 'incidentId', 'operationId',
    'ownerScopeSha256', 'repoId', 'installationId',
    'kind', 'selectedCount', 'reviewFingerprint', 'reviewStatus',
    'evidenceHashes', 'issuedAt', 'expiresAt', 'confirmation',
  ];
  if (!fields(input, required) ||
      input.format !== 'oge-vault-standalone-quarantine-attestation' ||
      input.version !== 1 ||
      !UUID.test(input.incidentId || '') ||
      !UUID.test(input.operationId || '') ||
      !HASH.test(input.ownerScopeSha256 || '') ||
      !isPositive(input.repoId) ||
      !isPositive(input.installationId) ||
      !['quick-notes', 'airnotes'].includes(input.kind) ||
      !Number.isSafeInteger(input.selectedCount) ||
      input.selectedCount < 1 || input.selectedCount > 12 ||
      !HASH.test(input.reviewFingerprint || '') ||
      !STATUSES.has(input.reviewStatus) ||
      input.confirmation !== CONFIRM ||
      !fields(input.evidenceHashes, [
        'writerShutdownSha256', 'outstandingGitHubRequestsSha256',
        'encryptedDraftPreservationSha256',
      ]) ||
      Object.values(input.evidenceHashes).some((value) =>
        !HASH.test(value || '')) ||
      iso(input.issuedAt) === null ||
      iso(input.expiresAt) === null ||
      iso(input.expiresAt) - iso(input.issuedAt) !== MAX_AGE)
    throw fail('vault-quarantine-attestation-claim-invalid');

  // Canonical order is part of the domain-separated Ed25519 signature.
  return {
    format: input.format, version: input.version,
    incidentId: input.incidentId,
    operationId: input.operationId,
    ownerScopeSha256: input.ownerScopeSha256,
    repoId: input.repoId,
    installationId: input.installationId,
    kind: input.kind, selectedCount: input.selectedCount,
    reviewFingerprint: input.reviewFingerprint,
    reviewStatus: input.reviewStatus,
    evidenceHashes: {
      writerShutdownSha256: input.evidenceHashes.writerShutdownSha256,
      outstandingGitHubRequestsSha256:
        input.evidenceHashes.outstandingGitHubRequestsSha256,
      encryptedDraftPreservationSha256:
        input.evidenceHashes.encryptedDraftPreservationSha256,
    },
    issuedAt: input.issuedAt, expiresAt: input.expiresAt,
    confirmation: input.confirmation,
  };
}

/** Exported to permit independently managed/offline Ed25519 signing. */
export function quarantineAttestationSigningBytes(claim) {
  return Buffer.from(PREFIX + JSON.stringify(canonicalClaim(claim)), 'utf8');
}

function trustedPublicKey(derBase64) {
  if (typeof derBase64 !== 'string' || derBase64.length > 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(derBase64))
    throw fail('vault-quarantine-attestation-trust-key-invalid');
  const der = Buffer.from(derBase64, 'base64');
  if (der.toString('base64') !== derBase64 || der.length < 40 ||
      der.length > 200)
    throw fail('vault-quarantine-attestation-trust-key-invalid');
  let key;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch { throw fail('vault-quarantine-attestation-trust-key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519')
    throw fail('vault-quarantine-attestation-trust-key-invalid');
  return { key, fingerprint: hash(key.export({
    format: 'der', type: 'spki',
  })) };
}

function checkSignature(attestation, trusted, bytes) {
  if (!fields(attestation, ['keyFingerprint', 'signature']) ||
      attestation.keyFingerprint !== trusted.fingerprint ||
      typeof attestation.signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(attestation.signature))
    throw fail('vault-quarantine-attestation-signature-invalid');
  const signature = Buffer.from(attestation.signature, 'base64url');
  if (signature.length !== 64 ||
      signature.toString('base64url') !== attestation.signature ||
      !verifySignature(null, bytes, trusted.key, signature))
    throw fail('vault-quarantine-attestation-signature-invalid');
}

function validateReview(review, claim) {
  if (!review || typeof review !== 'object' ||
      review.format !== 'oge-vault-standalone-quarantine-review' ||
      review.version !== 1 ||
      review.reviewFingerprint !== claim.reviewFingerprint ||
      review.status !== claim.reviewStatus ||
      review.kind !== claim.kind ||
      review.selectedCount !== claim.selectedCount ||
      review.readOnly !== true ||
      review.blockedBySafetyPolicy !== true ||
      review.fingerprintIsSignature !== false ||
      review.operatorUnlockAuthorized !== false ||
      review.automaticUnlockAuthorized !== false ||
      review.safeToRetryAutomatically !== false ||
      review.quarantineReleasePerformed !== false ||
      review.isProofPriorWriterStopped !== false ||
      review.verifiedOperatorAuthorization !== false ||
      review.sourceGitHubIdentityAuthenticated !== false ||
      review.gitWritesPerformed !== false ||
      review.noteContentStoredInMongo !== false ||
      !Array.isArray(review.blockers) ||
      MANDATORY_BLOCKERS.some((blocker) =>
        !review.blockers.includes(blocker)))
    throw fail('vault-quarantine-attestation-review-not-matching-or-safe');
}

/**
 * expectedScope and publicKeys MUST come from a separately trusted,
 * offline operator source; do NOT copy them from the uploaded dossier.
 * This is signature verification, not identity-vetting or quiescence proof.
 */
export function verifyQuarantineTwoReviewerAttestations(
  dossier, review, {
    expectedScope, publicKeys, now = Date.now(),
  } = {},
) {
  validScope(expectedScope);
  if (!fields(dossier, ['claim', 'signatures']) ||
      !fields(dossier.signatures, ['operator', 'reviewer']) ||
      !fields(publicKeys, ['operator', 'reviewer']) ||
      !Number.isSafeInteger(now))
    throw fail('vault-quarantine-attestation-dossier-invalid');

  const claim = canonicalClaim(dossier.claim);
  for (const name of Object.keys(expectedScope)) {
    if (claim[name] !== expectedScope[name])
      throw fail('vault-quarantine-attestation-wrong-incident');
  }
  const issued = iso(claim.issuedAt), expires = iso(claim.expiresAt);
  if (issued > now + 5000 || expires <= now)
    throw fail('vault-quarantine-attestation-expired-or-future');
  validateReview(review, claim);
  const operator = trustedPublicKey(publicKeys.operator);
  const reviewer = trustedPublicKey(publicKeys.reviewer);
  if (operator.fingerprint === reviewer.fingerprint)
    throw fail('vault-quarantine-attestation-reviewers-not-independent');
  const bytes = quarantineAttestationSigningBytes(claim);
  checkSignature(dossier.signatures.operator, operator, bytes);
  checkSignature(dossier.signatures.reviewer, reviewer, bytes);

  // A valid signature only authenticates the supplied CLAIMS. External
  // artifact hashes, quiescence and source GitHub identity are NOT verified.
  return {
    format: 'oge-vault-standalone-quarantine-dual-review-verification',
    version: 1,
    status: 'TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD',
    reportFingerprint: hash(bytes),
    exactIncidentAndOwnerScopeMatched: true,
    reviewFingerprintMatched: true,
    independentEd25519PublicKeys: true,
    validOperatorSignature: true,
    validIndependentReviewerSignature: true,
    externallyRecordedEvidenceArtifactsVerified: false,
    priorGitHubWriterStoppedProven: false,
    privateGitHubRepositoryRecheckedNow: false,
    ownerSessionRecheckedNow: false,
    sourceArchiveAuthenticityProven: false,
    independentPhysicalPersonIdentityVerified: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    readOnly: true, gitWritesPerformed: false, mongoWritesPerformed: false,
    noPrivateNoteContentProcessed: true,
  };
}
