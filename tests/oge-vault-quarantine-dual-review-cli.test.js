import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, randomUUID, sign,
} from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  quarantineAttestationSigningBytes,
} from '../lib/oge-vault-quarantine-dual-review.js';

const sha = (value) => createHash('sha256')
  .update(value).digest('hex');
const cmd = new URL('../scripts/review-vault-quarantine-attestations.mjs',
  import.meta.url).pathname;
const NOW = Date.now();

function signedFixture() {
  const op = generateKeyPairSync('ed25519');
  const reviewer = generateKeyPairSync('ed25519');
  const scope = {
    incidentId: randomUUID(), operationId: randomUUID(),
    ownerScopeSha256: sha('m79-cli-signed-owner-scope'),
    repoId: 781, installationId: 991,
  };
  const claim = {
    format: 'oge-vault-standalone-quarantine-attestation',
    version: 1,
    ...scope,
    kind: 'airnotes', selectedCount: 1,
    reviewFingerprint: sha('m79-cli-review-fingerprint'),
    reviewStatus: 'HOLD_REMOTE_OUTCOME_UNPROVEN',
    evidenceHashes: {
      writerShutdownSha256: sha('m79-cli-shutdown-reference'),
      outstandingGitHubRequestsSha256: sha('m79-cli-requests-reference'),
      encryptedDraftPreservationSha256: sha('m79-cli-preservation-reference'),
    },
    issuedAt: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW - 1000 + 15 * 60000).toISOString(),
    confirmation: 'ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE',
  };
  const bytes = quarantineAttestationSigningBytes(claim);
  const attestation = (keyPair) => ({
    keyFingerprint: sha(keyPair.publicKey.export({
      format: 'der', type: 'spki',
    })),
    signature: sign(null, bytes, keyPair.privateKey).toString('base64url'),
  });
  const dossier = {
    claim,
    signatures: {
      operator: attestation(op), reviewer: attestation(reviewer),
    },
  };
  const review = {
    format: 'oge-vault-standalone-quarantine-review',
    version: 1, status: claim.reviewStatus,
    reviewFingerprint: claim.reviewFingerprint,
    kind: claim.kind, selectedCount: claim.selectedCount,
    readOnly: true, blockedBySafetyPolicy: true,
    fingerprintIsSignature: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    isProofPriorWriterStopped: false,
    verifiedOperatorAuthorization: false,
    sourceGitHubIdentityAuthenticated: false,
    gitWritesPerformed: false,
    noteContentStoredInMongo: false,
    blockers: [
      'prior-github-worker-quiescence-not-independently-proven',
      'separate-independent-incident-approval-required',
      'postwrite-lock-release-not-implemented',
      'original-archive-source-authenticity-not-proven',
    ],
  };
  return {
    dossier, review, scope,
    publicKeys: {
      operator: op.publicKey.export({
        format: 'der', type: 'spki',
      }).toString('base64'),
      reviewer: reviewer.publicKey.export({
        format: 'der', type: 'spki',
      }).toString('base64'),
    },
  };
}

test('M79 isolated offline CLI refuses default without opt-in, verifies two private files, and exits HOLD=2', async () => {
  const fixture = signedFixture();
  const dir = await mkdtemp(join(tmpdir(), 'oge-m79-private-'));
  const dossierFile = join(dir, 'dossier.json');
  const reviewFile = join(dir, 'review.json');
  try {
    await chmod(dir, 0o700);
    await writeFile(dossierFile, JSON.stringify(fixture.dossier),
      { mode: 0o600 });
    await writeFile(reviewFile, JSON.stringify(fixture.review),
      { mode: 0o600 });
    await chmod(dossierFile, 0o600);
    await chmod(reviewFile, 0o600);
    const base = {
      ...process.env,
      OGE_STAGING_URL: 'https://vault-staging.example.test',
      MONGODB_DB: 'oge_vault_restore_staging_m79test',
      OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
      OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
      OGE_ACCOUNT_DELETION_ENABLED: 'false',
      OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
      OGE_VAULT_QUARANTINE_DOSSIER_FILE: dossierFile,
      OGE_VAULT_QUARANTINE_M78_REVIEW_FILE: reviewFile,
      OGE_VAULT_QUARANTINE_EXPECTED_INCIDENT_ID: fixture.scope.incidentId,
      OGE_VAULT_QUARANTINE_EXPECTED_OPERATION_ID: fixture.scope.operationId,
      OGE_VAULT_QUARANTINE_EXPECTED_OWNER_SCOPE_SHA256:
        fixture.scope.ownerScopeSha256,
      OGE_VAULT_QUARANTINE_EXPECTED_REPO_ID:
        String(fixture.scope.repoId),
      OGE_VAULT_QUARANTINE_EXPECTED_INSTALLATION_ID:
        String(fixture.scope.installationId),
      OGE_VAULT_QUARANTINE_OPERATOR_PUBLIC_KEY_DER_BASE64:
        fixture.publicKeys.operator,
      OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64:
        fixture.publicKeys.reviewer,
    };
    const run = (env) => spawnSync(process.execPath, [cmd], {
      env, encoding: 'utf8', timeout: 12000,
    });
    const blocked = run({
      ...base, OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW: 'NO',
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /BLOCKED/);
    assert.equal(blocked.stdout, '');

    const verified = run({
      ...base,
      OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW:
        'YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY',
    });
    assert.equal(verified.status, 2, verified.stderr);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.status,
      'TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD');
    assert.equal(report.operatorUnlockAuthorized, false);
    assert.equal(report.automaticUnlockAuthorized, false);
    assert.equal(report.quarantineReleasePerformed, false);
    assert.equal(report.externallyRecordedEvidenceArtifactsVerified, false);
    assert.equal(report.priorGitHubWriterStoppedProven, false);
    for (const privateValue of [
      fixture.scope.incidentId,
      fixture.scope.operationId,
      fixture.scope.ownerScopeSha256,
      fixture.dossier.signatures.operator.signature,
      dossierFile, reviewFile,
    ]) assert.equal(verified.stdout.includes(privateValue), false);

    const wrongKey = run({
      ...base,
      OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW:
        'YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY',
      OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64:
        fixture.publicKeys.operator,
    });
    assert.equal(wrongKey.status, 1);
    assert.equal(wrongKey.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
