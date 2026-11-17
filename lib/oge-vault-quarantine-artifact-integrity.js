/**
 * E12 / M80: OFFLINE SHA-256 byte verification of THREE separately
 * supplied private evidence files, against the TWO independently trusted
 * Ed25519 signatures validated by E11/M79.
 *
 * Integrity of local evidence bytes != provenance, truth, worker
 * quiescence, GitHub identity or authorization to release a Vault lock.
 * This module does not open any database or GitHub connections.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { verifyQuarantineTwoReviewerAttestations } from './oge-vault-quarantine-dual-review.js';

export const MAX_QUARANTINE_EVIDENCE_ARTIFACT_BYTES = 128 * 1024;
export const QUARANTINE_ARTIFACT_NAMES = Object.freeze({
  writerShutdownSha256: 'writer-shutdown.redacted.txt',
  outstandingGitHubRequestsSha256: 'outstanding-github-requests.redacted.txt',
  encryptedDraftPreservationSha256: 'encrypted-draft-preservation.redacted.txt',
});
const deny = () => { throw new TypeError(
  'Unsafe, missing, changing or hash-mismatched quarantine evidence'); };
const owned = (s) => s && (s.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || s.uid === process.getuid());
const same = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

async function evidenceDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) deny();
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) deny();
  return stat;
}

async function privateEvidenceSha256(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
      (constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !owned(before) ||
        before.size < 16 ||
        before.size > MAX_QUARANTINE_EVIDENCE_ARTIFACT_BYTES) deny();
    const digest = createHash('sha256');
    const bytes = Buffer.alloc(16 * 1024);
    let total = 0;
    try {
      while (total < before.size) {
        const { bytesRead } = await handle.read(bytes, 0,
          Math.min(bytes.length, before.size - total), total);
        if (bytesRead <= 0) deny();
        digest.update(bytes.subarray(0, bytesRead));
        total += bytesRead;
      }
      const tail = await handle.read(bytes, 0, 1, total);
      if (tail.bytesRead !== 0) deny();
    } finally { bytes.fill(0); }
    const after = await handle.stat();
    if (!same(before, after) || total !== before.size) deny();
    return digest.digest();
  } catch { deny(); }
  finally { await handle?.close().catch(() => {}); }
}

/**
 * Expected incident scope and trusted public keys MUST come from a separate
 * operator channel, NEVER from the untrusted signed dossier.
 *
 * Caller must use two private owner-only local dossier/review files.
 * Only three exact fixed-name, owner-only non-symlink regular files in
 * a private directory are read, hashed in bounded chunks and discarded.
 * Returns redacted status flags only, no content, paths, hashes or IDs.
 */
export async function verifySignedQuarantineEvidenceArtifacts({
  dossier, review, expectedScope, publicKeys, artifactsDirectory,
  now = Date.now(),
} = {}) {
  if (typeof artifactsDirectory !== 'string' ||
      !isAbsolute(artifactsDirectory)) deny();

  // Authenticate scope, review and both signatures first;
  // private artifact bytes are not read before this succeeds.
  const verified = verifyQuarantineTwoReviewerAttestations(
    dossier, review, { expectedScope, publicKeys, now });
  if (verified.status !== 'TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD' ||
      verified.operatorUnlockAuthorized !== false ||
      verified.quarantineReleasePerformed !== false) deny();

  const first = await evidenceDirectory(artifactsDirectory);
  const observed = (await readdir(artifactsDirectory)).sort();
  const expected = Object.values(QUARANTINE_ARTIFACT_NAMES).sort();
  if (observed.length !== expected.length ||
      observed.some((name, i) => name !== expected[i])) deny();

  for (const [field, filename] of Object.entries(QUARANTINE_ARTIFACT_NAMES)) {
    const expectedHash = Buffer.from(dossier.claim.evidenceHashes[field], 'hex');
    if (expectedHash.length !== 32) deny();
    const actual = await privateEvidenceSha256(
      join(artifactsDirectory, filename));
    if (!timingSafeEqual(actual, expectedHash)) deny();
  }
  const second = await evidenceDirectory(artifactsDirectory);
  if (!same(first, second)) deny();
  const afterNames = (await readdir(artifactsDirectory)).sort();
  if (afterNames.length !== expected.length ||
      afterNames.some((name, i) => name !== expected[i])) deny();

  return Object.freeze({
    format: 'oge-vault-quarantine-evidence-artifact-integrity',
    version: 1,
    status: 'THREE_SIGNED_ARTIFACT_HASHES_MATCH_QUARANTINE_STILL_HELD',
    signedClaimAndTwoReviewersVerified: true,
    matchedEvidenceArtifactCount: 3,
    localEvidenceBytesSha256Verified: true,
    localEvidenceFilesUnchangedDuringIndividualReads: true,
    externalProducerOrSourceAuthenticated: false,
    externalEvidenceStatementsIndependentlyVerified: false,
    allApplicationWorkersStoppedProven: false,
    outstandingGitHubRequestsSettledProven: false,
    draftPreservationMeaningVerified: false,
    ownerSessionRevalidatedNow: false,
    privateGitHubRepositoryRevalidatedNow: false,
    sourceArchiveAuthenticityProven: false,
    independentPhysicalReviewerIdentityVerified: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    noteContentStoredInMongo: false,
    readOnly: true,
    gitWritesPerformed: false,
    mongoWritesPerformed: false,
    privateEvidenceBytesReturned: false,
  });
}
