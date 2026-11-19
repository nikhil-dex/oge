import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  quarantineAttestationSigningBytes,
  verifyQuarantineTwoReviewerAttestations,
} from '../lib/oge-vault-quarantine-dual-review.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const NOW = Date.parse('2026-11-17T13:00:00.000Z');
const HOLD = 'HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE';
const MANDATORY = [
  'prior-github-worker-quiescence-not-independently-proven',
  'separate-independent-incident-approval-required',
  'postwrite-lock-release-not-implemented',
  'original-archive-source-authenticity-not-proven',
];

function signer() {
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ format: 'der', type: 'spki' });
  return { keys, publicKey: der.toString('base64'),
    fingerprint: (awaitHash) => awaitHash(der) };
}
function sha(value) {
  return (awaitHashImpl)(value);
}
import { createHash } from 'node:crypto';
const awaitHashImpl = (value) =>
  createHash('sha256').update(value).digest('hex');

function fixture() {
  const operator = signer(), reviewer = signer();
  const expectedScope = {
    incidentId: randomUUID(), operationId: randomUUID(),
    ownerScopeSha256: sha('synthetic signed owner/repo/session'),
    repoId: 9811, installationId: 1329,
  };
  const claim = {
    format: 'oge-vault-standalone-quarantine-attestation',
    version: 1,
    ...expectedScope,
    kind: 'quick-notes', selectedCount: 2,
    reviewFingerprint: sha('synthetic m78 review correlation value'),
    reviewStatus: HOLD,
    evidenceHashes: {
      writerShutdownSha256: sha('synthetic shutdown evidence index'),
      outstandingGitHubRequestsSha256: sha('synthetic external in-flight request index'),
      encryptedDraftPreservationSha256: sha('synthetic encrypted draft retention index'),
    },
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 15 * 60000).toISOString(),
    confirmation: 'ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE',
  };
  const review = {
    format: 'oge-vault-standalone-quarantine-review',
    version: 1, status: HOLD, reviewFingerprint: claim.reviewFingerprint,
    kind: claim.kind, selectedCount: claim.selectedCount,
    readOnly: true, blockedBySafetyPolicy: true,
    fingerprintIsSignature: false,
    operatorUnlockAuthorized: false, automaticUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    isProofPriorWriterStopped: false,
    verifiedOperatorAuthorization: false,
    sourceGitHubIdentityAuthenticated: false,
    gitWritesPerformed: false, noteContentStoredInMongo: false,
    blockers: [...MANDATORY],
  };
  const publicKeys = {
    operator: operator.publicKey,
    reviewer: reviewer.publicKey,
  };
  const bytes = quarantineAttestationSigningBytes(claim);
  const signature = (s) => ({
    keyFingerprint: sha(s.keys.publicKey.export({
      format: 'der', type: 'spki',
    })),
    signature: sign(null, bytes, s.keys.privateKey).toString('base64url'),
  });
  const dossier = { claim, signatures: {
    operator: signature(operator), reviewer: signature(reviewer),
  } };
  const verify = (input = dossier, from = review, opts = {}) =>
    verifyQuarantineTwoReviewerAttestations(input, from, {
      expectedScope, publicKeys, now: NOW + 1000, ...opts,
    });
  return { dossier, review, expectedScope, publicKeys,
    operator, reviewer, verify };
}

test('M79 independent Ed25519 signatures verify same bounded scope yet ALWAYS retain quarantine', () => {
  const f = fixture(), report = f.verify();
  assert.equal(report.status, 'TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD');
  assert.equal(report.exactIncidentAndOwnerScopeMatched, true);
  assert.equal(report.independentEd25519PublicKeys, true);
  assert.equal(report.validOperatorSignature, true);
  assert.equal(report.validIndependentReviewerSignature, true);
  assert.equal(report.externallyRecordedEvidenceArtifactsVerified, false);
  assert.equal(report.priorGitHubWriterStoppedProven, false);
  assert.equal(report.independentPhysicalPersonIdentityVerified, false);
  assert.equal(report.privateGitHubRepositoryRecheckedNow, false);
  assert.equal(report.sourceArchiveAuthenticityProven, false);
  assert.equal(report.operatorUnlockAuthorized, false);
  assert.equal(report.automaticUnlockAuthorized, false);
  assert.equal(report.safeToRetryAutomatically, false);
  assert.equal(report.quarantineReleasePerformed, false);
  assert.equal(report.mongoWritesPerformed, false);
  assert.equal(report.gitWritesPerformed, false);
  assert.match(report.reportFingerprint, /^[a-f0-9]{64}$/);
  const visible = JSON.stringify(report);
  for (const secret of [f.expectedScope.incidentId,
    f.expectedScope.operationId, f.expectedScope.ownerScopeSha256,
    f.dossier.signatures.operator.signature, f.publicKeys.operator])
    assert.equal(visible.includes(secret), false);
});

test('M79 signatures cannot be replayed for another owner, repo, incident, session scope or role', () => {
  const f = fixture();
  const changes = [
    ['incidentId', randomUUID()], ['operationId', randomUUID()],
    ['ownerScopeSha256', sha('different owner scope')],
    ['repoId', 9911], ['installationId', 999],
    ['kind', 'airnotes'], ['selectedCount', 3],
    ['reviewFingerprint', sha('different review')],
    ['reviewStatus', 'HOLD_REMOTE_OUTCOME_UNPROVEN'],
  ];
  for (const [key, value] of changes) {
    const changed = {
      ...f.dossier, claim: { ...f.dossier.claim, [key]: value },
    };
    assert.throws(() => f.verify(changed),
      e => e instanceof VaultGitHubError && e.status === 409);
  }
  const switched = { ...f.dossier, signatures: {
    operator: f.dossier.signatures.reviewer,
    reviewer: f.dossier.signatures.operator,
  } };
  assert.throws(() => f.verify(switched), /vault-quarantine-attestation-signature-invalid/);
});

test('M79 tampered evidence digests, missing evidence fields and changed original review fail closed', () => {
  const f = fixture();
  for (const changes of [
    { writerShutdownSha256: sha('different shutdown') },
    { outstandingGitHubRequestsSha256: sha('different inflight evidence') },
    { encryptedDraftPreservationSha256: sha('changed draft records') },
    { extra: sha('unexpected artifact') },
  ]) {
    assert.throws(() => f.verify({
      ...f.dossier,
      claim: { ...f.dossier.claim,
        evidenceHashes: { ...f.dossier.claim.evidenceHashes, ...changes },
      },
    }));
  }
  const badReview = [
    { ...f.review, reviewFingerprint: sha('replacement m78 review') },
    { ...f.review, status: 'HOLD_REMOTE_OUTCOME_UNPROVEN' },
    { ...f.review, operatorUnlockAuthorized: true },
    { ...f.review, isProofPriorWriterStopped: true },
    { ...f.review, blockers: [] },
    { ...f.review, readOnly: false },
    { ...f.review, safeToRetryAutomatically: true },
  ];
  for (const review of badReview)
    assert.throws(() => f.verify(f.dossier, review));
});

test('M79 same public key masquerading as two reviewers, forged signature, wrong key and algorithm rejected', () => {
  const f = fixture();
  assert.throws(() => f.verify(f.dossier, f.review, {
    publicKeys: {
      operator: f.publicKeys.operator,
      reviewer: f.publicKeys.operator,
    },
  }), /vault-quarantine-attestation-reviewers-not-independent/);
  assert.throws(() => f.verify(f.dossier, f.review, {
    publicKeys: {
      operator: f.publicKeys.reviewer,
      reviewer: f.publicKeys.operator,
    },
  }));
  const forged = { ...f.dossier, signatures: {
    ...f.dossier.signatures,
    reviewer: {
      ...f.dossier.signatures.reviewer,
      signature: 'A'.repeat(86),
    },
  } };
  assert.throws(() => f.verify(forged));
  assert.throws(() => f.verify(f.dossier, f.review, {
    publicKeys: { operator: 'bad', reviewer: f.publicKeys.reviewer },
  }));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => f.verify(f.dossier, f.review, {
    publicKeys: {
      operator: rsa.publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64'),
      reviewer: f.publicKeys.reviewer,
    },
  }));
});

test('M79 expiry, future issuance, noncanonical dates and invalid claim duration fail closed', () => {
  const f = fixture();
  assert.throws(() => f.verify(f.dossier, f.review, {
    now: NOW + 15 * 60000,
  }), /vault-quarantine-attestation-expired-or-future/);
  assert.throws(() => f.verify(f.dossier, f.review, {
    now: NOW - 10000,
  }), /vault-quarantine-attestation-expired-or-future/);
  for (const change of [
    { issuedAt: '2026-11-17T13:00:00Z' },
    { expiresAt: new Date(NOW + 60000).toISOString() },
    { issuedAt: 'not-a-date' },
    { confirmation: 'RELEASE_QUARANTINE' },
  ]) assert.throws(() => f.verify({
    ...f.dossier,
    claim: { ...f.dossier.claim, ...change },
  }));
});

test('M79 missing independently expected scope, extra fields and wrong trust anchors fail closed', () => {
  const f = fixture();
  assert.throws(() => f.verify(f.dossier, f.review, {
    expectedScope: { ...f.expectedScope, ownerScopeSha256: sha('wrong owner') },
  }), /vault-quarantine-attestation-wrong-incident/);
  assert.throws(() => f.verify(f.dossier, f.review, {
    expectedScope: null,
  }));
  assert.throws(() => f.verify({ ...f.dossier, authorizeUnlock: true }));
  assert.throws(() => f.verify({
    ...f.dossier, claim: { ...f.dossier.claim, extra: true },
  }));
  assert.throws(() => f.verify({
    ...f.dossier, signatures: { operator: f.dossier.signatures.operator },
  }));
});

test('M79 offline validator source contains no provider writers, database mutations, or unlock primitive', async () => {
  const source = await readFile(new URL(
    '../lib/oge-vault-quarantine-dual-review.js',
    import.meta.url), 'utf8');
  assert.match(source, /createPublicKey/);
  assert.match(source, /verifySignature\(null, bytes/);
  assert.match(source, /MAX_AGE = 15 \* 60 \* 1000/);
  assert.match(source, /operatorUnlockAuthorized: false/);
  assert.match(source, /quarantineReleasePerformed: false/);
  assert.match(source, /signature only authenticates the supplied CLAIMS/i);
  assert.doesNotMatch(source,
    /fetch\(|getVaultNoteClient|db\.collection|insertOne\(|updateOne\(|findOneAndUpdate\(|deleteOne\(|vaultImportLock:|github-write-possible.*\$unset/);
});
