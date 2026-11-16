/**
 * M68: OFFLINE, read-only SHA-256 verification of the actual redacted files
 * referenced by M67's untrusted two-device evidence index.
 *
 * Hash matching is only a local bit-integrity check. It cannot establish that
 * the evidence came from GitHub, that its contents are true or redacted, or
 * that any two physical devices were ever used. No signoff/write authority.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  inspectVaultTwoDeviceEvidenceManifest,
} from './oge-vault-two-device-evidence.js';

const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024;
const fail = () => {
  throw new TypeError('Unsafe, missing or mismatched external evidence artifacts');
};
const owned = (s) => s && (s.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || s.uid === process.getuid());
const same = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function safeDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) fail();
  return stat;
}

async function privateFile(path, min, max, { hashOnly = false } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !owned(before) || before.size < min ||
        before.size > max) fail();
    const h = createHash('sha256');
    const buffers = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(Math.min(max, 32 * 1024));
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > max || total > before.size) fail();
        h.update(buf.subarray(0, bytesRead));
        if (!hashOnly) buffers.push(Buffer.from(buf.subarray(0, bytesRead)));
      }
    } finally { buf.fill(0); }
    const after = await handle.stat();
    if (total !== before.size || !same(before, after)) fail();
    const digest = h.digest('hex');
    if (hashOnly) return { digest, size: total };
    const data = Buffer.concat(buffers, total);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    finally {
      data.fill(0);
      for (const item of buffers) item.fill(0);
    }
  } catch { fail(); }
  finally { await handle?.close().catch(() => {}); }
}

export async function verifyVaultTwoDeviceEvidenceArtifacts({
  manifestFile, artifactsDirectory, expectedOrigin, now = Date.now(),
} = {}) {
  if (!isAbsolute(manifestFile || '') || !isAbsolute(artifactsDirectory || '') ||
      dirname(manifestFile) === artifactsDirectory) fail();
  await safeDirectory(dirname(manifestFile));
  const manifest = await privateFile(manifestFile, 20, MAX_MANIFEST_BYTES);
  const inventory = inspectVaultTwoDeviceEvidenceManifest(manifest, {
    expectedOrigin, now,
  });
  const beforeDir = await safeDirectory(artifactsDirectory);
  const observedNames = await readdir(artifactsDirectory);
  const expectedNames = manifest.records.map((record) =>
    record.scenario + '.redacted.txt').sort();
  if (observedNames.length !== expectedNames.length ||
      observedNames.sort().some((name, index) => name !== expectedNames[index]))
    fail();

  let bytesChecked = 0;
  for (const record of manifest.records) {
    const name = record.scenario + '.redacted.txt';
    const evidence = await privateFile(join(artifactsDirectory, name), 16,
      MAX_ARTIFACT_BYTES, { hashOnly: true });
    bytesChecked += evidence.size;
    const actual = Buffer.from(evidence.digest, 'hex');
    const asserted = Buffer.from(record.evidenceSha256, 'hex');
    if (actual.length !== 32 || asserted.length !== 32 ||
        !timingSafeEqual(actual, asserted)) fail();
  }
  const afterDir = await safeDirectory(artifactsDirectory);
  if (!same(beforeDir, afterDir)) fail();

  return Object.freeze({
    format: 'oge-vault-two-device-artifact-hash-report',
    version: 1,
    status: inventory.status === 'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW'
      ? 'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED'
      : 'ON_DISK_HASHES_MATCH_INCOMPLETE_EVIDENCE_INDEX',
    matchedArtifactCount: manifest.records.length,
    requiredScenarioCount: inventory.requiredScenarioCount,
    missingScenarios: inventory.missingScenarios,
    reportedFailedScenarios: inventory.reportedFailedScenarios,
    onDiskArtifactHashesRecomputed: true,
    artifactContentsTruthVerified: false,
    artifactRedactionIndependentlyVerified: false,
    sourceCaptureProvenanceVerified: false,
    physicalDevicesIndependentlyVerified: false,
    realGitHubProviderIndependentlyVerified: false,
    externalOperatorAttestationVerified: false,
    completeStagingAcceptanceSignedOff: false,
    canAuthorizeGitHubWrites: false,
    canEnableProduction: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    noDatabaseOrGitHubRequestsPerformed: true,
    privateArtifactBytesReturned: false,
    // Counts of content and byte sizes deliberately omitted.
  });
}
