import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, randomUUID, sign,
} from 'node:crypto';
import {
  mkdtemp, writeFile, chmod, rm, symlink, unlink, link, rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  quarantineAttestationSigningBytes,
} from '../lib/oge-vault-quarantine-dual-review.js';
import {
  verifySignedQuarantineEvidenceArtifacts,
  QUARANTINE_ARTIFACT_NAMES,
  MAX_QUARANTINE_EVIDENCE_ARTIFACT_BYTES,
} from '../lib/oge-vault-quarantine-artifact-integrity.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const CLI = new URL('../scripts/verify-vault-quarantine-artifact-hashes.mjs',
  import.meta.url).pathname;
const NOW = Date.now();
const BYTES = Object.freeze({
  writerShutdownSha256: Buffer.from('REDACTED synthetic worker shutdown observations\n'),
  outstandingGitHubRequestsSha256: Buffer.from(
    'REDACTED synthetic outstanding GitHub request observations\n'),
  encryptedDraftPreservationSha256: Buffer.from(
    'REDACTED synthetic encrypted draft preservation observations\n'),
});
function signedReviewFixture() {
  const op = generateKeyPairSync('ed25519');
  const rev = generateKeyPairSync('ed25519');
  const scope = {
    incidentId: randomUUID(), operationId: randomUUID(),
    ownerScopeSha256: sha('m80-private-synthetic-scope'),
    repoId: 981, installationId: 1081,
  };
  const claim = {
    format: 'oge-vault-standalone-quarantine-attestation',
    version: 1, ...scope,
    kind: 'airnotes', selectedCount: 1,
    reviewFingerprint: sha('m80-synthetic-redacted-review'),
    reviewStatus: 'HOLD_REMOTE_OUTCOME_UNPROVEN',
    evidenceHashes: Object.fromEntries(
      Object.entries(BYTES).map(([key, value]) => [key, sha(value)])),
    issuedAt: new Date(NOW - 2000).toISOString(),
    expiresAt: new Date(NOW - 2000 + 15 * 60000).toISOString(),
    confirmation: 'ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE',
  };
  const bytes = quarantineAttestationSigningBytes(claim);
  const signClaim = (pair) => ({
    keyFingerprint: sha(pair.publicKey.export({
      format: 'der', type: 'spki',
    })),
    signature: sign(null, bytes, pair.privateKey).toString('base64url'),
  });
  const dossier = {
    claim, signatures: { operator: signClaim(op), reviewer: signClaim(rev) },
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
    gitWritesPerformed: false, noteContentStoredInMongo: false,
    blockers: [
      'prior-github-worker-quiescence-not-independently-proven',
      'separate-independent-incident-approval-required',
      'postwrite-lock-release-not-implemented',
      'original-archive-source-authenticity-not-proven',
    ],
  };
  const publicKeys = {
    operator: op.publicKey.export({
      format: 'der', type: 'spki',
    }).toString('base64'),
    reviewer: rev.publicKey.export({
      format: 'der', type: 'spki',
    }).toString('base64'),
  };
  return { dossier, review, scope, publicKeys };
}
async function privateFixture(fn) {
  const fixture = signedReviewFixture();
  const parent = await mkdtemp(join(tmpdir(), 'oge-m80-'));
  const filesDir = join(parent, 'evidence');
  const dossierFile = join(parent, 'dossier.json');
  const reviewFile = join(parent, 'review.json');
  try {
    await chmod(parent, 0o700);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(filesDir, { mode: 0o700 });
    await chmod(filesDir, 0o700);
    for (const [key, filename] of Object.entries(QUARANTINE_ARTIFACT_NAMES))
      await writeFile(join(filesDir, filename), BYTES[key], { mode: 0o600 });
    await writeFile(dossierFile, JSON.stringify(fixture.dossier),
      { mode: 0o600 });
    await writeFile(reviewFile, JSON.stringify(fixture.review),
      { mode: 0o600 });
    return await fn({ ...fixture, parent, filesDir, dossierFile, reviewFile,
      run: (extras = {}) => verifySignedQuarantineEvidenceArtifacts({
        dossier: fixture.dossier, review: fixture.review,
        expectedScope: fixture.scope, publicKeys: fixture.publicKeys,
        artifactsDirectory: filesDir, now: NOW, ...extras,
      }),
    });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('M80 three actual signed local artifact bytes match without release or leaking IDs/contents', async () => {
  await privateFixture(async (f) => {
    const report = await f.run();
    assert.equal(report.status,
      'THREE_SIGNED_ARTIFACT_HASHES_MATCH_QUARANTINE_STILL_HELD');
    assert.equal(report.matchedEvidenceArtifactCount, 3);
    assert.equal(report.localEvidenceBytesSha256Verified, true);
    assert.equal(report.signedClaimAndTwoReviewersVerified, true);
    assert.equal(report.externalProducerOrSourceAuthenticated, false);
    assert.equal(report.externalEvidenceStatementsIndependentlyVerified, false);
    assert.equal(report.allApplicationWorkersStoppedProven, false);
    assert.equal(report.outstandingGitHubRequestsSettledProven, false);
    assert.equal(report.draftPreservationMeaningVerified, false);
    assert.equal(report.operatorUnlockAuthorized, false);
    assert.equal(report.safeToRetryAutomatically, false);
    assert.equal(report.quarantineReleasePerformed, false);
    assert.equal(report.gitWritesPerformed, false);
    assert.equal(report.mongoWritesPerformed, false);
    assert.equal(report.privateEvidenceBytesReturned, false);
    const output = JSON.stringify(report);
    for (const secret of [
      f.scope.incidentId, f.scope.operationId, f.filesDir,
      ...Object.values(BYTES).map((b) => b.toString()),
      ...Object.values(f.dossier.claim.evidenceHashes),
    ]) assert.equal(output.includes(secret), false);
  });
});

test('M80 edited artifact bytes, unknown, missing or renamed files all reject', async () => {
  await privateFixture(async (f) => {
    const file = join(f.filesDir, QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256);
    await writeFile(file, Buffer.from('REDACTED changed worker status\n'),
      { mode: 0o600 });
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    await writeFile(join(f.filesDir, 'unexpected-extra.txt'),
      'REDACTED extra synthetic content\n', { mode: 0o600 });
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    await unlink(join(f.filesDir,
      QUARANTINE_ARTIFACT_NAMES.outstandingGitHubRequestsSha256));
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    await rename(join(f.filesDir,
      QUARANTINE_ARTIFACT_NAMES.encryptedDraftPreservationSha256),
    join(f.filesDir, 'wrong-name.txt'));
    await assert.rejects(f.run(), TypeError);
  });
});

test('M80 symlinks, hardlinks, group-readable files and directories are denied', async () => {
  await privateFixture(async (f) => {
    const path = join(f.filesDir, QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256);
    await unlink(path);
    await symlink('/dev/null', path);
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    const path = join(f.filesDir, QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256);
    await link(path, join(f.parent, 'another-hardlink'));
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    await chmod(join(f.filesDir,
      QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256), 0o644);
    await assert.rejects(f.run(), TypeError);
  });
  await privateFixture(async (f) => {
    await chmod(f.filesDir, 0o755);
    await assert.rejects(f.run(), TypeError);
  });
});

test('M80 signed claim tampering, false release review, wrong key and empty/relative paths fail before useful verification', async () => {
  await privateFixture(async (f) => {
    const changed = {
      ...f.dossier, claim: {
        ...f.dossier.claim,
        evidenceHashes: {
          ...f.dossier.claim.evidenceHashes,
          writerShutdownSha256: sha('forged digest'),
        },
      },
    };
    await assert.rejects(f.run({ dossier: changed }));
    await assert.rejects(f.run({
      review: { ...f.review, operatorUnlockAuthorized: true },
    }));
    await assert.rejects(f.run({
      publicKeys: { ...f.publicKeys, reviewer: f.publicKeys.operator },
    }));
    await assert.rejects(f.run({ artifactsDirectory: './evidence' }), TypeError);
  });
});

test('M80 oversized evidence is bounded and never accepted', async () => {
  await privateFixture(async (f) => {
    const path = join(f.filesDir, QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256);
    await writeFile(path, Buffer.alloc(
      MAX_QUARANTINE_EVIDENCE_ARTIFACT_BYTES + 1, 88), { mode: 0o600 });
    await assert.rejects(f.run(), TypeError);
  });
});

test('M80 offline guarded command blocks by default, verified signed artifacts exit HOLD=2, corrupted ones exit 1', async () => {
  await privateFixture(async (f) => {
    const base = {
      ...process.env,
      OGE_STAGING_URL: 'https://vault-staging.example.test',
      MONGODB_DB: 'oge_vault_restore_staging_m80test',
      OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
      OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
      OGE_ACCOUNT_DELETION_ENABLED: 'false',
      OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
      OGE_VAULT_QUARANTINE_DOSSIER_FILE: f.dossierFile,
      OGE_VAULT_QUARANTINE_M78_REVIEW_FILE: f.reviewFile,
      OGE_VAULT_QUARANTINE_EVIDENCE_DIRECTORY: f.filesDir,
      OGE_VAULT_QUARANTINE_EXPECTED_INCIDENT_ID: f.scope.incidentId,
      OGE_VAULT_QUARANTINE_EXPECTED_OPERATION_ID: f.scope.operationId,
      OGE_VAULT_QUARANTINE_EXPECTED_OWNER_SCOPE_SHA256:
        f.scope.ownerScopeSha256,
      OGE_VAULT_QUARANTINE_EXPECTED_REPO_ID: String(f.scope.repoId),
      OGE_VAULT_QUARANTINE_EXPECTED_INSTALLATION_ID:
        String(f.scope.installationId),
      OGE_VAULT_QUARANTINE_OPERATOR_PUBLIC_KEY_DER_BASE64:
        f.publicKeys.operator,
      OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64:
        f.publicKeys.reviewer,
      OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW:
        'YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY',
    };
    const run = (env) => spawnSync(process.execPath, [CLI], {
      env, encoding: 'utf8', timeout: 15000,
    });
    const blocked = run({
      ...base, OGE_VAULT_QUARANTINE_ARTIFACT_HASH_REVIEW: 'NO',
    });
    assert.equal(blocked.status, 1);
    assert.equal(blocked.stdout, '');
    const good = run({
      ...base,
      OGE_VAULT_QUARANTINE_ARTIFACT_HASH_REVIEW:
        'YES_OFFLINE_PRIVATE_SIGNED_THREE_ARTIFACTS_ONLY',
    });
    assert.equal(good.status, 2, good.stderr);
    const report = JSON.parse(good.stdout);
    assert.equal(report.status,
      'THREE_SIGNED_ARTIFACT_HASHES_MATCH_QUARANTINE_STILL_HELD');
    assert.equal(report.operatorUnlockAuthorized, false);
    assert.equal(report.allApplicationWorkersStoppedProven, false);
    assert.equal(report.quarantineReleasePerformed, false);
    assert.equal(good.stdout.includes(f.scope.incidentId), false);
    assert.equal(good.stdout.includes(f.filesDir), false);
    await writeFile(join(f.filesDir,
      QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256),
    Buffer.from('REDACTED but now corrupted\n'), { mode: 0o600 });
    const bad = run({
      ...base,
      OGE_VAULT_QUARANTINE_ARTIFACT_HASH_REVIEW:
        'YES_OFFLINE_PRIVATE_SIGNED_THREE_ARTIFACTS_ONLY',
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
  });
});
