import {
  createHash, createPublicKey, timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

/**
 * E28/M96: offline two-role Ed25519 signatures over one M95 report digest.
 *
 * This proves independently pinned signing key POSSESSION only, NOT two
 * verified human identities, live OAuth provenance, actual physical devices,
 * provider faults, evidence truth, or authorization for restore/deployment.
 * The review result is ALWAYS a HOLD and never consumed as a write ticket.
 */
const SHA = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOMAIN = 'oge-vault-m96-external-hold-review-v1\n';
const CONFIRM = 'TWO_REVIEWERS_ACKNOWLEDGE_EVIDENCE_GAPS_HOLD_ONLY';
const MAX_AGE_MS = 15 * 60 * 1000;
const M95 = [
  'format','version','status','m94PrivateReportSha256RecomputedAndMatched',
  'm94RunBindingMatchedToIndependentOperatorScope',
  'signedSessionObservationCount','historicalReadClaimCount',
  'currentReadClaimCount','m67ArtifactsRehashedByM68',
  'm82SignedSessionPairValidatedByM83',
  'allM67ScenarioClaimsReportedPassed','privateEvidenceContentsReturned',
  'capturedEvidenceTruthVerified','providerSignedAttestationsVerified',
  'oauthIssuerIndependentlyVerified','twoPhysicalDevicesIndependentlyVerified',
  'realProviderFaultsIndependentlyVerified','independentSecurityReviewerSignedOff',
  'completeStagingAcceptanceSignedOff','canAuthorizeRestore',
  'canAuthorizeGitHubWrites','canAuthorizeImport','canReleaseImportLock',
  'canRetryUnknownWrite','canEnableProduction','productionReady',
  'githubWritesPerformed','databaseOrGitHubRequestsPerformed',
];
const POSITIVE_M95 = [
  'm94PrivateReportSha256RecomputedAndMatched',
  'm94RunBindingMatchedToIndependentOperatorScope',
  'm67ArtifactsRehashedByM68','m82SignedSessionPairValidatedByM83',
];
const NEGATIVE_M95 = M95.filter(k => ![
  'format','version','status','signedSessionObservationCount',
  'historicalReadClaimCount','currentReadClaimCount',
  'allM67ScenarioClaimsReportedPassed',...POSITIVE_M95,
].includes(k));
const CLAIM_KEYS = [
  'format','version','runBindingSha256','m95ReportSha256',
  'm95Status','issuedAt','expiresAt','confirmation',
];
const exact = (o, keys) => Boolean(o && typeof o === 'object' &&
  !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(','));
const deny = () => { throw new TypeError(
  'Invalid, stale, mixed-scope or unauthorized M96 HOLD reviewer attestation'); };
const digest = v => createHash('sha256').update(v).digest('hex');
function utc(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s ? ms : null;
}
function canonicalClaim(c) {
  if (!exact(c, CLAIM_KEYS) ||
      c.format !== 'oge-vault-m96-external-release-hold-claim' ||
      c.version !== 1 || !SHA.test(c.runBindingSha256 || '') ||
      !SHA.test(c.m95ReportSha256 || '') ||
      !['CORRELATED_PRIVATE_EVIDENCE_READY_FOR_EXTERNAL_REVIEW_HOLD',
        'CORRELATED_PRIVATE_EVIDENCE_INCOMPLETE_HOLD'].includes(c.m95Status) ||
      utc(c.issuedAt) === null || utc(c.expiresAt) === null ||
      utc(c.expiresAt) - utc(c.issuedAt) !== MAX_AGE_MS ||
      c.confirmation !== CONFIRM) deny();
  return {
    format: c.format, version: c.version,
    runBindingSha256: c.runBindingSha256,
    m95ReportSha256: c.m95ReportSha256,
    m95Status: c.m95Status, issuedAt: c.issuedAt,
    expiresAt: c.expiresAt, confirmation: c.confirmation,
  };
}
/** Stable domain-separated bytes for EXTERNALLY controlled private signers. */
export function vaultM96HoldReviewSigningBytes(claim) {
  return Buffer.from(DOMAIN + JSON.stringify(canonicalClaim(claim)), 'utf8');
}
function pinnedKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 512 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) deny();
  const der = Buffer.from(encoded, 'base64');
  if (der.length < 40 || der.length > 200 ||
      der.toString('base64') !== encoded) deny();
  let key;
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { deny(); }
  if (key.asymmetricKeyType !== 'ed25519' ||
      !Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(der))
    deny();
  return { key, fingerprint: digest(der) };
}
function verifyRole(sig, pinned, bytes) {
  if (!exact(sig, ['keyFingerprint','signature']) ||
      sig.keyFingerprint !== pinned.fingerprint ||
      typeof sig.signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(sig.signature)) deny();
  const raw = Buffer.from(sig.signature, 'base64url');
  if (raw.length !== 64 || raw.toString('base64url') !== sig.signature ||
      !verifySignature(null, bytes, pinned.key, raw)) deny();
}
function assertM95(r) {
  if (!exact(r, M95) ||
      r.format !== 'oge-vault-m95-private-acceptance-evidence-review' ||
      r.version !== 1 ||
      r.signedSessionObservationCount !== 2 ||
      r.historicalReadClaimCount !== 1 || r.currentReadClaimCount !== 2 ||
      POSITIVE_M95.some(k => r[k] !== true) ||
      NEGATIVE_M95.some(k => r[k] !== false) ||
      typeof r.allM67ScenarioClaimsReportedPassed !== 'boolean' ||
      r.status !== (r.allM67ScenarioClaimsReportedPassed
        ? 'CORRELATED_PRIVATE_EVIDENCE_READY_FOR_EXTERNAL_REVIEW_HOLD'
        : 'CORRELATED_PRIVATE_EVIDENCE_INCOMPLETE_HOLD')) deny();
}

export function verifyVaultM96ExternalHoldReview(
  dossier, report, {
    expectedRunBindingSha256, expectedM95ReportSha256,
    publicKeys, reportBytesVerified = false,
    now = Date.now(),
  } = {},
) {
  if (!SHA.test(expectedRunBindingSha256 || '') ||
      !SHA.test(expectedM95ReportSha256 || '') ||
      !exact(publicKeys, ['operator','securityReviewer']) ||
      !exact(dossier, ['claim','signatures']) ||
      !exact(dossier.signatures, ['operator','securityReviewer']) ||
      reportBytesVerified !== true ||
      !Number.isSafeInteger(now)) deny();
  assertM95(report);
  const claim = canonicalClaim(dossier.claim);
  if (!timingSafeEqual(Buffer.from(claim.runBindingSha256, 'hex'),
        Buffer.from(expectedRunBindingSha256, 'hex')) ||
      !timingSafeEqual(Buffer.from(claim.m95ReportSha256, 'hex'),
        Buffer.from(expectedM95ReportSha256, 'hex')) ||
      claim.m95Status !== report.status ||
      utc(claim.issuedAt) > now + 5000 ||
      utc(claim.expiresAt) <= now) deny();

  const operator = pinnedKey(publicKeys.operator);
  const reviewer = pinnedKey(publicKeys.securityReviewer);
  if (operator.fingerprint === reviewer.fingerprint) deny();
  const signed = vaultM96HoldReviewSigningBytes(claim);
  verifyRole(dossier.signatures.operator, operator, signed);
  verifyRole(dossier.signatures.securityReviewer, reviewer, signed);

  return Object.freeze({
    format: 'oge-vault-m96-external-release-hold-review',
    version: 1,
    status: 'TWO_INDEPENDENT_KEYS_ATTESTED_EVIDENCE_HOLD_NO_RELEASE',
    exactM95ReportSha256Recomputed: true,
    independentRunAndEvidenceScopeMatched: true,
    twoDistinctPinnedEd25519Keys: true,
    operatorSignatureVerified: true,
    securityReviewerSignatureVerified: true,
    evidenceGapAcknowledgmentSigned: true,
    m95ReportedScenarioClaimsComplete: report.allM67ScenarioClaimsReportedPassed,
    independentPhysicalReviewerIdentityVerified: false,
    independentOAuthIssuerAuthenticated: false,
    twoPhysicalDevicesAuthenticated: false,
    realGitHubProviderFaultAcceptanceVerified: false,
    honestSourceCaptureProvenanceVerified: false,
    actualProviderStateRecheckedNow: false,
    liveOwnerSessionRecheckedNow: false,
    fullAccountRestoreVerified: false,
    securityReleaseApprovalGranted: false,
    canAuthorizeGitHubWrites: false,
    canAuthorizeRestore: false,
    canAuthorizeImport: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    canEnableProduction: false,
    productionReady: false,
    githubWritesPerformed: false,
    mongodbNoteContentWritesPerformed: false,
    privateIdsOrHashesReturned: false,
  });
}
