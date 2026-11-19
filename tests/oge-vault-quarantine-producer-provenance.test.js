import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, randomUUID, sign,
} from 'node:crypto';
import {
  mkdtemp, mkdir, writeFile, chmod, rm, unlink, symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  quarantineAttestationSigningBytes,
} from '../lib/oge-vault-quarantine-dual-review.js';
import {
  QUARANTINE_ARTIFACT_NAMES,
} from '../lib/oge-vault-quarantine-artifact-integrity.js';
import {
  quarantineProducerSigningBytes,
  verifyQuarantineEvidenceProducerProvenance,
} from '../lib/oge-vault-quarantine-producer-provenance.js';

const SHA = (x) => createHash('sha256').update(x).digest('hex');
const NOW = Date.now();
const CLI = new URL('../scripts/verify-vault-quarantine-producer-provenance.mjs',
  import.meta.url).pathname;
const CONTENT = Object.freeze({
  writerShutdownSha256: 'REDACTED simulated worker shutdown observation\n',
  outstandingGitHubRequestsSha256: 'REDACTED simulated GitHub in-flight request observation\n',
  encryptedDraftPreservationSha256: 'REDACTED simulated protected drafts observation\n',
});
const ROLES = Object.keys(CONTENT);

function makeSigner() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey: pair.privateKey, publicKey: publicKey.toString('base64'),
    fingerprint: SHA(publicKey),
  };
}
function signBytes(actor, bytes) {
  return {
    keyFingerprint: actor.fingerprint,
    signature: sign(null, bytes, actor.privateKey).toString('base64url'),
  };
}
function makeFixture() {
  const operator = makeSigner(), reviewer = makeSigner();
  const producers = Object.fromEntries(ROLES.map(role => [role, makeSigner()]));
  const expectedScope = {
    incidentId: randomUUID(), operationId: randomUUID(),
    ownerScopeSha256: SHA('m81 synthetic signed owner incarnation'),
    repoId: 913, installationId: 1173,
  };
  const issuedAt = new Date(NOW - 1000).toISOString();
  const claim = {
    format: 'oge-vault-standalone-quarantine-attestation',
    version: 1,
    ...expectedScope,
    kind: 'quick-notes', selectedCount: 2,
    reviewFingerprint: SHA('m81 synthetic immutable M78 review'),
    reviewStatus: 'HOLD_REMOTE_OUTCOME_UNPROVEN',
    evidenceHashes: Object.fromEntries(
      ROLES.map(role => [role, SHA(CONTENT[role])])),
    issuedAt, expiresAt: new Date(NOW - 1000 + 15 * 60000).toISOString(),
    confirmation: 'ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE',
  };
  const m79 = quarantineAttestationSigningBytes(claim);
  const dossier = {
    claim, signatures: {
      operator: signBytes(operator, m79),
      reviewer: signBytes(reviewer, m79),
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
    gitWritesPerformed: false, noteContentStoredInMongo: false,
    blockers: [
      'prior-github-worker-quiescence-not-independently-proven',
      'separate-independent-incident-approval-required',
      'postwrite-lock-release-not-implemented',
      'original-archive-source-authenticity-not-proven',
    ],
  };
  const attestations = {};
  for (const role of ROLES) {
    const producerClaim = {
      format: 'oge-vault-quarantine-producer-evidence',
      version: 1, role, ...expectedScope,
      reviewFingerprint: claim.reviewFingerprint,
      reviewStatus: claim.reviewStatus,
      artifactSha256: claim.evidenceHashes[role],
      capturedAt: new Date(NOW - 2000).toISOString(),
      confirmation: 'ATTEST_EVIDENCE_DIGEST_ONLY_NO_UNLOCK',
    };
    attestations[role] = {
      claim: producerClaim,
      signature: signBytes(producers[role],
        quarantineProducerSigningBytes(producerClaim)),
    };
  }
  return {
    dossier, review, expectedScope,
    publicKeys: {
      operator: operator.publicKey, reviewer: reviewer.publicKey,
    },
    producerManifest: {
      format: 'oge-vault-quarantine-three-producer-attestations',
      version: 1, attestations,
    },
    producerPublicKeys: Object.fromEntries(
      ROLES.map(role => [role, producers[role].publicKey])),
    actors: { operator, reviewer, producers },
  };
}
async function withFiles(cb) {
  const f = makeFixture();
  const parent = await mkdtemp(join(tmpdir(), 'oge-m81-'));
  const artifactsDirectory = join(parent, 'artifacts');
  const dossierFile = join(parent, 'dossier.json');
  const reviewFile = join(parent, 'review.json');
  const producerFile = join(parent, 'producers.json');
  try {
    await chmod(parent, 0o700);
    await mkdir(artifactsDirectory, { mode: 0o700 });
    await chmod(artifactsDirectory, 0o700);
    for (const [role, filename] of Object.entries(QUARANTINE_ARTIFACT_NAMES))
      await writeFile(join(artifactsDirectory, filename),
        CONTENT[role], { mode: 0o600 });
    for (const [path, item] of [
      [dossierFile, f.dossier],
      [reviewFile, f.review],
      [producerFile, f.producerManifest],
    ]) await writeFile(path, JSON.stringify(item), { mode: 0o600 });
    return await cb({
      ...f, parent, artifactsDirectory, dossierFile, reviewFile, producerFile,
      inspect: (overrides = {}) => verifyQuarantineEvidenceProducerProvenance({
        ...f, artifactsDirectory, now: NOW, ...overrides,
      }),
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('M81 three independent trusted role-signatures and actual M80 bytes verify; report permanently HOLD', async () => {
  await withFiles(async f => {
    const report = await f.inspect();
    assert.equal(report.status,
      'THREE_PRODUCER_SIGNATURES_AND_ARTIFACT_HASHES_MATCH_HOLD');
    assert.equal(report.independentlyPinnedProducerPublicKeys, true);
    assert.equal(report.producerKeysDistinctFromReviewers, true);
    assert.equal(report.threeSignedProducerClaimsVerified, true);
    assert.equal(report.threeActualLocalEvidenceHashesVerified, true);
    assert.equal(report.cryptographicClaimToLocalBytesBindingVerified, true);
    for (const flag of [
      'realProducerIdentityIndependentlyAuthenticated',
      'captureSourceAuthenticatedByExternalSystem',
      'evidenceTruthVerified',
      'allWorkersQuiescedVerified',
      'allOutstandingGitHubRequestsSettledVerified',
      'draftSafetyExternallyVerified',
      'operatorUnlockAuthorized',
      'automaticUnlockAuthorized',
      'safeToRetryAutomatically',
      'quarantineReleasePerformed',
      'gitWritesPerformed',
      'mongoWritesPerformed',
      'privateEvidenceBytesReturned',
    ]) assert.equal(report[flag], false, flag);
    const output = JSON.stringify(report);
    for (const secret of [
      f.expectedScope.incidentId, f.expectedScope.operationId,
      f.expectedScope.ownerScopeSha256, f.parent,
      ...Object.values(CONTENT), ...Object.values(f.producerPublicKeys),
    ]) assert.equal(output.includes(secret), false);
  });
});

test('M81 wrong assigned trust key, repeated producers or reviewer-producer duplicate keys reject before file proof', async () => {
  await withFiles(async f => {
    const changed = { ...f.producerPublicKeys,
      outstandingGitHubRequestsSha256:
        f.producerPublicKeys.writerShutdownSha256 };
    await assert.rejects(f.inspect({ producerPublicKeys: changed }), TypeError);
    await assert.rejects(f.inspect({
      producerPublicKeys: { ...f.producerPublicKeys,
        writerShutdownSha256: f.publicKeys.operator },
    }), TypeError);
    await assert.rejects(f.inspect({
      producerPublicKeys: { ...f.producerPublicKeys,
        writerShutdownSha256: 'bad' },
    }), TypeError);
  });
});

test('M81 altered producer role, file hash, incident, repo, missing/extra claim, signature all reject', async () => {
  await withFiles(async f => {
    const role = ROLES[0];
    for (const changed of [
      { role: ROLES[1] },
      { incidentId: randomUUID() },
      { operationId: randomUUID() },
      { repoId: 444 },
      { installationId: 999 },
      { ownerScopeSha256: SHA('wrong owner') },
      { reviewFingerprint: SHA('wrong review') },
      { artifactSha256: SHA('tampered evidence') },
      { confirmation: 'RELEASE_IMPORT_LOCK' },
      { unexpected: true },
      { capturedAt: new Date(NOW - 21 * 60000).toISOString() },
      { capturedAt: new Date(NOW + 60000).toISOString() },
    ]) {
      const manifest = structuredClone(f.producerManifest);
      manifest.attestations[role].claim = {
        ...manifest.attestations[role].claim, ...changed,
      };
      await assert.rejects(f.inspect({ producerManifest: manifest }));
    }
    const missing = structuredClone(f.producerManifest);
    delete missing.attestations[role];
    await assert.rejects(f.inspect({ producerManifest: missing }));
    const extra = structuredClone(f.producerManifest);
    extra.attestations.unexpectedSigner = f.producerManifest.attestations[role];
    await assert.rejects(f.inspect({ producerManifest: extra }));
    const forged = structuredClone(f.producerManifest);
    forged.attestations[role].signature.signature = 'A'.repeat(86);
    await assert.rejects(f.inspect({ producerManifest: forged }));
  });
});

test('M81 mutated M79 reviewer proof, signed hashes or actual local evidence bytes reject', async () => {
  await withFiles(async f => {
    await assert.rejects(f.inspect({
      dossier: { ...f.dossier, claim: {
        ...f.dossier.claim,
        evidenceHashes: {
          ...f.dossier.claim.evidenceHashes,
          writerShutdownSha256: SHA('forged hash'),
        },
      } },
    }));
    await assert.rejects(f.inspect({
      review: { ...f.review, operatorUnlockAuthorized: true },
    }));
    const p = join(f.artifactsDirectory,
      QUARANTINE_ARTIFACT_NAMES.writerShutdownSha256);
    await writeFile(p, 'REDACTED but bytes modified\n', { mode: 0o600 });
    await assert.rejects(f.inspect(), TypeError);
  });
});

test('M81 malicious local source symlink, extra file, expired claim or changed reviewer key refuse', async () => {
  await withFiles(async f => {
    const p = join(f.artifactsDirectory,
      QUARANTINE_ARTIFACT_NAMES.encryptedDraftPreservationSha256);
    await unlink(p);
    await symlink('/dev/null', p);
    await assert.rejects(f.inspect(), TypeError);
  });
  await withFiles(async f => {
    await writeFile(join(f.artifactsDirectory, 'unexpected.txt'),
      'UNEXPECTED PRIVATE EVIDENCE\n', { mode: 0o600 });
    await assert.rejects(f.inspect(), TypeError);
  });
  await withFiles(async f => {
    await assert.rejects(f.inspect({ now: NOW + 16 * 60000 }));
    await assert.rejects(f.inspect({ publicKeys: {
      operator: f.publicKeys.reviewer,
      reviewer: f.publicKeys.operator,
    } }));
  });
});

test('M81 offline command opt-in, three producer keys and actual evidence: HOLD exit=2, bad key exit=1', async () => {
  await withFiles(async f => {
    const base = {
      ...process.env,
      OGE_STAGING_URL: 'https://vault-staging.example.test',
      MONGODB_DB: 'oge_vault_restore_staging_m81',
      OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
      OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
      OGE_ACCOUNT_DELETION_ENABLED: 'false',
      OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
      OGE_VAULT_QUARANTINE_DOSSIER_FILE: f.dossierFile,
      OGE_VAULT_QUARANTINE_M78_REVIEW_FILE: f.reviewFile,
      OGE_VAULT_QUARANTINE_EVIDENCE_DIRECTORY: f.artifactsDirectory,
      OGE_VAULT_QUARANTINE_PRODUCER_MANIFEST_FILE: f.producerFile,
      OGE_VAULT_QUARANTINE_EXPECTED_INCIDENT_ID: f.expectedScope.incidentId,
      OGE_VAULT_QUARANTINE_EXPECTED_OPERATION_ID: f.expectedScope.operationId,
      OGE_VAULT_QUARANTINE_EXPECTED_OWNER_SCOPE_SHA256:
        f.expectedScope.ownerScopeSha256,
      OGE_VAULT_QUARANTINE_EXPECTED_REPO_ID: String(f.expectedScope.repoId),
      OGE_VAULT_QUARANTINE_EXPECTED_INSTALLATION_ID:
        String(f.expectedScope.installationId),
      OGE_VAULT_QUARANTINE_OPERATOR_PUBLIC_KEY_DER_BASE64:
        f.publicKeys.operator,
      OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64:
        f.publicKeys.reviewer,
      OGE_VAULT_QUARANTINE_WORKER_PRODUCER_PUBLIC_KEY_DER_BASE64:
        f.producerPublicKeys.writerShutdownSha256,
      OGE_VAULT_QUARANTINE_GITHUB_REQUESTS_PRODUCER_PUBLIC_KEY_DER_BASE64:
        f.producerPublicKeys.outstandingGitHubRequestsSha256,
      OGE_VAULT_QUARANTINE_DRAFTS_PRODUCER_PUBLIC_KEY_DER_BASE64:
        f.producerPublicKeys.encryptedDraftPreservationSha256,
      OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW:
        'YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY',
      OGE_VAULT_QUARANTINE_ARTIFACT_HASH_REVIEW:
        'YES_OFFLINE_PRIVATE_SIGNED_THREE_ARTIFACTS_ONLY',
    };
    const run = (changes) => spawnSync(process.execPath, [CLI], {
      env: { ...base, ...changes }, encoding: 'utf8', timeout: 12000,
    });
    const off = run({ OGE_VAULT_QUARANTINE_PRODUCER_REVIEW: 'NO' });
    assert.equal(off.status, 1);
    assert.equal(off.stdout, '');
    const gate = 'YES_OFFLINE_THREE_DISTINCT_SIGNED_PRODUCERS_ONLY';
    const ok = run({ OGE_VAULT_QUARANTINE_PRODUCER_REVIEW: gate });
    assert.equal(ok.status, 2, ok.stderr);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.status,
      'THREE_PRODUCER_SIGNATURES_AND_ARTIFACT_HASHES_MATCH_HOLD');
    assert.equal(report.operatorUnlockAuthorized, false);
    assert.equal(report.captureSourceAuthenticatedByExternalSystem, false);
    assert.equal(report.quarantineReleasePerformed, false);
    assert.equal(ok.stdout.includes(f.expectedScope.incidentId), false);
    assert.equal(ok.stdout.includes(f.producerFile), false);
    const wrong = run({
      OGE_VAULT_QUARANTINE_PRODUCER_REVIEW: gate,
      OGE_VAULT_QUARANTINE_WORKER_PRODUCER_PUBLIC_KEY_DER_BASE64:
        f.producerPublicKeys.outstandingGitHubRequestsSha256,
    });
    assert.equal(wrong.status, 1);
    assert.equal(wrong.stdout, '');
  });
});
