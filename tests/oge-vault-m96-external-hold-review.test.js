import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, sign,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  vaultM96HoldReviewSigningBytes,
  verifyVaultM96ExternalHoldReview,
} from '../lib/oge-vault-m96-external-hold-review.js';
import { vaultM94RunBindingDigest } from
  '../lib/oge-vault-m94-read-only-acceptance.js';

const SHA = b => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://vault-staging.example.test';
const RUN = 'c9868d1a-0d20-4de6-befe-3494b7a2fba5';
const BINDING = vaultM94RunBindingDigest(RUN, ORIGIN);
const NOW = Date.parse('2026-11-17T16:00:00.000Z');
function m95(complete = true) {
  return {
    format: 'oge-vault-m95-private-acceptance-evidence-review',
    version: 1,
    status: complete
      ? 'CORRELATED_PRIVATE_EVIDENCE_READY_FOR_EXTERNAL_REVIEW_HOLD'
      : 'CORRELATED_PRIVATE_EVIDENCE_INCOMPLETE_HOLD',
    m94PrivateReportSha256RecomputedAndMatched: true,
    m94RunBindingMatchedToIndependentOperatorScope: true,
    signedSessionObservationCount: 2,
    historicalReadClaimCount: 1,
    currentReadClaimCount: 2,
    m67ArtifactsRehashedByM68: true,
    m82SignedSessionPairValidatedByM83: true,
    allM67ScenarioClaimsReportedPassed: complete,
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
  };
}
function fixture(complete = true) {
  const operator = generateKeyPairSync('ed25519');
  const securityReviewer = generateKeyPairSync('ed25519');
  const report = m95(complete);
  const expectedM95ReportSha256 = SHA(
    JSON.stringify(report, null, 2) + '\n');
  const claim = {
    format: 'oge-vault-m96-external-release-hold-claim',
    version: 1,
    runBindingSha256: BINDING,
    m95ReportSha256: expectedM95ReportSha256,
    m95Status: report.status,
    issuedAt: new Date(NOW - 60 * 1000).toISOString(),
    expiresAt: new Date(NOW + 14 * 60 * 1000).toISOString(),
    confirmation: 'TWO_REVIEWERS_ACKNOWLEDGE_EVIDENCE_GAPS_HOLD_ONLY',
  };
  const bytes = vaultM96HoldReviewSigningBytes(claim);
  const key = (k) => k.publicKey.export({
    format: 'der', type: 'spki',
  }).toString('base64');
  const makeSignature = k => ({
    keyFingerprint: SHA(k.publicKey.export({
      format: 'der', type: 'spki',
    })),
    signature: sign(null, bytes, k.privateKey).toString('base64url'),
  });
  const publicKeys = {
    operator: key(operator), securityReviewer: key(securityReviewer),
  };
  const dossier = { claim, signatures: {
    operator: makeSignature(operator),
    securityReviewer: makeSignature(securityReviewer),
  } };
  const verify = (d = dossier, r = report, opts = {}) =>
    verifyVaultM96ExternalHoldReview(d, r, {
      expectedRunBindingSha256: BINDING,
      expectedM95ReportSha256,
      publicKeys, reportBytesVerified: true, now: NOW, ...opts,
    });
  return { operator, securityReviewer, dossier, claim,
    report, publicKeys, verify, expectedM95ReportSha256 };
}

test('M96 two separately pinned Ed25519 signers agree to exact M95 evidence HOLD without authorization', () => {
  const f = fixture();
  const result = f.verify();
  assert.equal(result.status,
    'TWO_INDEPENDENT_KEYS_ATTESTED_EVIDENCE_HOLD_NO_RELEASE');
  assert.equal(result.operatorSignatureVerified, true);
  assert.equal(result.securityReviewerSignatureVerified, true);
  assert.equal(result.twoDistinctPinnedEd25519Keys, true);
  assert.equal(result.evidenceGapAcknowledgmentSigned, true);
  assert.equal(result.exactM95ReportSha256Recomputed, true);
  assert.equal(result.m95ReportedScenarioClaimsComplete, true);
  for (const name of [
    'independentPhysicalReviewerIdentityVerified',
    'independentOAuthIssuerAuthenticated',
    'twoPhysicalDevicesAuthenticated',
    'realGitHubProviderFaultAcceptanceVerified',
    'honestSourceCaptureProvenanceVerified',
    'actualProviderStateRecheckedNow',
    'liveOwnerSessionRecheckedNow',
    'fullAccountRestoreVerified',
    'securityReleaseApprovalGranted',
    'canAuthorizeGitHubWrites','canAuthorizeRestore',
    'canAuthorizeImport','canReleaseImportLock',
    'canRetryUnknownWrite','canEnableProduction',
    'productionReady','githubWritesPerformed',
    'mongodbNoteContentWritesPerformed','privateIdsOrHashesReturned',
  ]) assert.equal(result[name], false, name);
  const redacted = JSON.stringify(result);
  for (const secret of [
    BINDING, f.claim.m95ReportSha256, ORIGIN, RUN,
    f.publicKeys.operator, f.dossier.signatures.operator.signature,
  ]) assert.equal(redacted.includes(secret), false);
});

test('M96 incomplete local evidence is still signable as HOLD, NOT accepted or approved', () => {
  const f = fixture(false);
  const result = f.verify();
  assert.equal(result.m95ReportedScenarioClaimsComplete, false);
  assert.equal(result.canEnableProduction, false);
  assert.equal(result.securityReleaseApprovalGranted, false);
});

test('M96 wrong operator scope, tampering, signature swap and forged claims fail closed', () => {
  const f = fixture();
  for (const claimPatch of [
    { m95ReportSha256: SHA('different report') },
    { runBindingSha256: SHA('another staging run') },
    { confirmation: 'AUTHORIZE_RESTORE' },
    { format: 'unknown' },
    { version: 2 },
    { m95Status: 'PRODUCTION_READY' },
    { canAuthorizeRestore: true },
    { issuedAt: new Date(NOW).toISOString() },
  ]) assert.throws(() => f.verify({
    ...f.dossier, claim: { ...f.claim, ...claimPatch },
  }));
  assert.throws(() => f.verify({
    ...f.dossier, signatures: {
      operator: f.dossier.signatures.securityReviewer,
      securityReviewer: f.dossier.signatures.operator,
    },
  }));
  for (const opts of [
    { expectedRunBindingSha256: SHA('other-run') },
    { expectedM95ReportSha256: SHA('other-report') },
    { reportBytesVerified: false },
    { publicKeys: {
      operator: f.publicKeys.operator,
      securityReviewer: f.publicKeys.operator,
    } },
    { now: NOW + 15 * 60 * 1000 },
  ]) assert.throws(() => f.verify(f.dossier, f.report, opts));
  assert.throws(() => f.verify(f.dossier, {
    ...f.report, canAuthorizeRestore: true,
  }));
  assert.throws(() => f.verify(f.dossier, {
    ...f.report, providerSignedAttestationsVerified: true,
  }));
  assert.throws(() => f.verify(f.dossier, {
    ...f.report, currentReadClaimCount: 3,
  }));
});

test('M96 rejects bad Ed25519 trust roots and changed signed bytes', () => {
  const f = fixture();
  const rsaKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const rsaPublic = rsaKey.publicKey.export({
    format: 'der', type: 'spki',
  }).toString('base64');
  assert.throws(() => f.verify(f.dossier, f.report, {
    publicKeys: {
      operator: f.publicKeys.operator, securityReviewer: rsaPublic,
    },
  }));
  assert.throws(() => f.verify({
    ...f.dossier,
    signatures: {
      ...f.dossier.signatures,
      securityReviewer: {
        ...f.dossier.signatures.securityReviewer,
        signature: 'X'.repeat(86),
      },
    },
  }));
  assert.throws(() => f.verify({
    ...f.dossier,
    signatures: {
      ...f.dossier.signatures,
      operator: {
        ...f.dossier.signatures.operator, signature: 'invalid',
      },
    },
  }));
});

test('M96 CLI and docs are default OFF, private, no-network, no-write, never exit 0 approval', async () => {
  const [cli, module, m95cli, envfile, pkg] = await Promise.all([
    readFile(new URL('../scripts/review-vault-m96-release-gates.mjs',
      import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-m96-external-hold-review.js',
      import.meta.url), 'utf8'),
    readFile(new URL('../scripts/review-vault-m95-private-acceptance.mjs',
      import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  assert.match(cli, /constants\.O_NOFOLLOW/);
  assert.match(cli, /before\.nlink !== 1/);
  assert.match(cli, /timingSafeEqual/);
  assert.match(cli, /process\.exitCode = 2/);
  assert.match(module, /verifySignature\(null/);
  assert.match(module, /canAuthorizeRestore: false/);
  assert.match(module, /canReleaseImportLock: false/);
  assert.match(m95cli, /O_CREAT \|/);
  assert.match(m95cli, /OGE_VAULT_M95_PRIVATE_REVIEW_FILE/);
  assert.match(envfile, /OGE_VAULT_M96_DUAL_HOLD_REVIEW=/);
  assert.match(pkg, /vault:staging:m96-hold-release-review/);
  assert.doesNotMatch(cli + module,
    /\bMongoClient\b|getVaultNoteClient|vaultGithubRequest|\bfetch\(|method:\s*['"]PATCH['"]|insertOne\(/);
  const run = spawnSync(process.execPath, [
    new URL('../scripts/review-vault-m96-release-gates.mjs',
      import.meta.url).pathname,
  ], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /BLOCKED:/);
});
