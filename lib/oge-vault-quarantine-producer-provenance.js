/**
 * E13/M81: OFFLINE cryptographic authenticity of three role-specific
 * PRODUCER KEY SIGNATURES over M79/M80 incident evidence byte digests.
 *
 * The three producer public keys are separately trusted by the operator,
 * distinct from each other and from both M79 reviewer keys. This proves
 * signing-key possession, NOT independent verified producer identity, file
 * creation on a claimed source, true statements, or remote quiescence.
 * Every result keeps quarantine and all GitHub/Mongo writes prohibited.
 */
import {
  createHash, createPublicKey, verify as verifySignature,
} from 'node:crypto';
import { verifyQuarantineTwoReviewerAttestations } from './oge-vault-quarantine-dual-review.js';
import { verifySignedQuarantineEvidenceArtifacts } from './oge-vault-quarantine-artifact-integrity.js';

const ROLES = Object.freeze([
  'writerShutdownSha256',
  'outstandingGitHubRequestsSha256',
  'encryptedDraftPreservationSha256',
]);
const DOMAIN = 'oge-vault-quarantine-evidence-producer-m81-v1\n';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AGE_MS = 15 * 60 * 1000;
const deny = () => { throw new TypeError('Invalid or untrusted private evidence producer attestation'); };
const exact = (value, fields) => Boolean(value && typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(','));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function parseTime(value) {
  const time = typeof value === 'string' && UTC.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
function keyFromPinnedDer(value) {
  if (typeof value !== 'string' || value.length > 512 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) deny();
  const der = Buffer.from(value, 'base64');
  if (der.length < 40 || der.length > 200 || der.toString('base64') !== value) deny();
  let key;
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { deny(); }
  if (key.asymmetricKeyType !== 'ed25519' ||
      !key.export({ format: 'der', type: 'spki' }).equals(der)) deny();
  return { key, fingerprint: sha256(der) };
}

/**
 * Stable bytes for a separately protected producer Ed25519 private signer.
 * NEVER receive or store producer private keys in the application.
 */
export function quarantineProducerSigningBytes(claim) {
  const keys = [
    'format', 'version', 'role', 'incidentId', 'operationId',
    'ownerScopeSha256', 'repoId', 'installationId',
    'reviewFingerprint', 'reviewStatus', 'artifactSha256',
    'capturedAt', 'confirmation',
  ];
  if (!exact(claim, keys) ||
      claim.format !== 'oge-vault-quarantine-producer-evidence' ||
      claim.version !== 1 || !ROLES.includes(claim.role) ||
      !UUID.test(claim.incidentId || '') ||
      !UUID.test(claim.operationId || '') ||
      !SHA.test(claim.ownerScopeSha256 || '') ||
      !Number.isSafeInteger(claim.repoId) || claim.repoId < 1 ||
      !Number.isSafeInteger(claim.installationId) || claim.installationId < 1 ||
      !SHA.test(claim.reviewFingerprint || '') ||
      !['HOLD_REMOTE_OUTCOME_UNPROVEN',
        'HOLD_HISTORICAL_CREATE_WITH_LATER_EDITS',
        'HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE'].includes(
        claim.reviewStatus) ||
      !SHA.test(claim.artifactSha256 || '') ||
      parseTime(claim.capturedAt) === null ||
      claim.confirmation !== 'ATTEST_EVIDENCE_DIGEST_ONLY_NO_UNLOCK') deny();
  const canonical = {
    format: claim.format, version: claim.version, role: claim.role,
    incidentId: claim.incidentId, operationId: claim.operationId,
    ownerScopeSha256: claim.ownerScopeSha256,
    repoId: claim.repoId, installationId: claim.installationId,
    reviewFingerprint: claim.reviewFingerprint,
    reviewStatus: claim.reviewStatus,
    artifactSha256: claim.artifactSha256, capturedAt: claim.capturedAt,
    confirmation: claim.confirmation,
  };
  return Buffer.from(DOMAIN + JSON.stringify(canonical), 'utf8');
}

function verifyProducerManifest(manifest, dossier, pinned, reviewerKeys, now) {
  if (!exact(manifest, ['format', 'version', 'attestations']) ||
      manifest.format !== 'oge-vault-quarantine-three-producer-attestations' ||
      manifest.version !== 1 ||
      !exact(manifest.attestations, ROLES) ||
      !exact(pinned, ROLES) ||
      !exact(reviewerKeys, ['operator', 'reviewer'])) deny();

  const claim = dossier.claim;
  const issuedAt = parseTime(claim.issuedAt);
  if (!Number.isSafeInteger(now) || issuedAt === null) deny();
  const reviewerFingerprints = [
    keyFromPinnedDer(reviewerKeys.operator).fingerprint,
    keyFromPinnedDer(reviewerKeys.reviewer).fingerprint,
  ];
  const used = new Set(reviewerFingerprints);
  if (used.size !== 2) deny();
  for (const role of ROLES) {
    const item = manifest.attestations[role];
    if (!exact(item, ['claim', 'signature']) ||
        !exact(item.signature, ['keyFingerprint', 'signature'])) deny();
    const producer = keyFromPinnedDer(pinned[role]);
    if (used.has(producer.fingerprint)) deny();
    used.add(producer.fingerprint);
    const payload = item.claim;
    if (payload.role !== role ||
        payload.incidentId !== claim.incidentId ||
        payload.operationId !== claim.operationId ||
        payload.ownerScopeSha256 !== claim.ownerScopeSha256 ||
        payload.repoId !== claim.repoId ||
        payload.installationId !== claim.installationId ||
        payload.reviewFingerprint !== claim.reviewFingerprint ||
        payload.reviewStatus !== claim.reviewStatus ||
        payload.artifactSha256 !== claim.evidenceHashes[role]) deny();
    const captured = parseTime(payload.capturedAt);
    // Recorded provenance must be tied to this short-lived M79 review
    // window; it does NOT prove that the timestamp reflects real events.
    if (captured === null || captured > now || captured > issuedAt ||
        captured < issuedAt - AGE_MS) deny();

    const signed = quarantineProducerSigningBytes(payload);
    const signature = item.signature;
    if (signature.keyFingerprint !== producer.fingerprint ||
        typeof signature.signature !== 'string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(signature.signature)) deny();
    const raw = Buffer.from(signature.signature, 'base64url');
    if (raw.length !== 64 ||
        raw.toString('base64url') !== signature.signature ||
        !verifySignature(null, signed, producer.key, raw)) deny();
  }
}

/**
 * Cryptographic and byte integrity gate, never release approval.
 * Trust roots must be independent of the uploaded manifest/dossier.
 * Complete real provider/source verification still must occur separately.
 */
export async function verifyQuarantineEvidenceProducerProvenance({
  dossier, review, expectedScope, publicKeys, artifactsDirectory,
  producerManifest, producerPublicKeys, now = Date.now(),
} = {}) {
  // Authenticate M79's exact owner scope and two reviewers first, before
  // trusting the new producer attestations or reading local evidence.
  verifyQuarantineTwoReviewerAttestations(dossier, review,
    { expectedScope, publicKeys, now });
  verifyProducerManifest(producerManifest, dossier, producerPublicKeys,
    publicKeys, now);
  const local = await verifySignedQuarantineEvidenceArtifacts({
    dossier, review, expectedScope, publicKeys, artifactsDirectory, now,
  });
  if (local.status !== 'THREE_SIGNED_ARTIFACT_HASHES_MATCH_QUARANTINE_STILL_HELD' ||
      local.operatorUnlockAuthorized !== false ||
      local.quarantineReleasePerformed !== false) deny();
  return Object.freeze({
    format: 'oge-vault-quarantine-evidence-producer-provenance',
    version: 1,
    status: 'THREE_PRODUCER_SIGNATURES_AND_ARTIFACT_HASHES_MATCH_HOLD',
    independentlyPinnedProducerPublicKeys: true,
    producerKeyRolesCryptographicallyDistinct: true,
    producerKeysDistinctFromReviewers: true,
    threeSignedProducerClaimsVerified: true,
    matchingTwoReviewerSignaturesVerified: true,
    threeActualLocalEvidenceHashesVerified: true,
    cryptographicClaimToLocalBytesBindingVerified: true,
    signingKeyPossessionVerified: true,
    realProducerIdentityIndependentlyAuthenticated: false,
    captureSourceAuthenticatedByExternalSystem: false,
    evidenceTruthVerified: false,
    independentHumanIdentityVerified: false,
    allWorkersQuiescedVerified: false,
    allOutstandingGitHubRequestsSettledVerified: false,
    privateGitHubHeadRecheckedNow: false,
    draftSafetyExternallyVerified: false,
    sourceArchiveAuthenticityProven: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    readOnly: true, gitWritesPerformed: false,
    mongoWritesPerformed: false, privateEvidenceBytesReturned: false,
  });
}
