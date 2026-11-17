#!/usr/bin/env node
/**
 * E27/M95 — OFFLINE independent private-evidence integrity index.
 * No network, MongoDB, provider token, OAuth login or Notes access.
 *
 * Requires independently supplied expected SHA256 of M94 PRIVATE redacted
 * output, private M82 acceptance pair/challenges, and M67/M68 evidence files.
 * All bytes remain local and only redacted HOLD state is printed.
 *
 * EXIT 2 = hashes/claimed scenarios ready for EXTERNAL HUMAN review (HOLD).
 * EXIT 3 = complete private file integrity but incomplete claimed matrix.
 * EXIT 1 = blocked/malformed/unsafe. Never exit 0 approval.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  verifyVaultTwoDeviceEvidenceArtifacts,
} from '../lib/oge-vault-two-device-artifact-verification.js';
import {
  inspectVaultM95OfflineEvidence,
} from '../lib/oge-vault-m95-evidence-review.js';

const env = process.env;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const STAGE = /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/;
const HOST = /(?:^|[.-])(staging|preview)(?:[.-]|$)/i;
const blocked = () => { throw new TypeError(
  'M95 private offline acceptance evidence blocked or mismatched'); };
const owned = st => Boolean(st && (st.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || st.uid === process.getuid()));
function origin() {
  try {
    const u = new URL(env.OGE_STAGING_URL);
    if (u.protocol !== 'https:' || u.origin !== env.OGE_STAGING_URL ||
        u.pathname !== '/' || u.search || u.hash || u.port ||
        u.username || u.password || !HOST.test(u.hostname) ||
        env.AUTH_URL !== u.origin || env.OGE_VAULT_BASE_URL !== u.origin)
      blocked();
    return u.origin;
  } catch { blocked(); }
}
function allowed() {
  const paths = [
    env.OGE_VAULT_M95_M94_REPORT_FILE,
    env.OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE,
    env.OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE,
    env.OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY,
  ];
  if (env.OGE_VAULT_M95_OFFLINE_EVIDENCE_REVIEW !==
        'YES_VERIFY_PRIVATE_M94_M83_ARTIFACTS_HOLD_ONLY' ||
      env.OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW !==
        'YES_OFFLINE_TWO_SIGNED_DEVICE_OBSERVATIONS_AND_MATRIX_ONLY' ||
      env.OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW !==
        'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY' ||
      !HEX.test(env.OGE_VAULT_M95_EXPECTED_M94_SHA256 || '') ||
      !UUID.test(env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID || '') ||
      !HEX.test(env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX || '') ||
      !HEX.test(env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX || '') ||
      env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX ===
        env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX ||
      !STAGE.test(env.MONGODB_DB || '') ||
      paths.some(p => typeof p !== 'string' || !isAbsolute(p)) ||
      new Set(paths).size !== paths.length ||
      dirname(paths[0]) === paths[3] ||
      dirname(paths[1]) === paths[3] ||
      dirname(paths[2]) === paths[3] ||
      [
        'OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW',
        'OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW',
        'OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW',
        'OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW',
        'OGE_VAULT_CUTOVER_GUARD_PREVIEW',
        'OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
        'OGE_VAULT_SUBJECT_RETIRE_INTERNAL',
        'OGE_ACCOUNT_DELETION_ENABLED',
        'OGE_VAULT_ACCOUNT_DELETION_INTERNAL',
      ].some(k => env[k] === 'true') ||
      env.OGE_VAULT_CHUNK_RESTORE_WRITE_ACK ||
      env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK) blocked();
  return origin();
}

async function privateJson(path, minBytes, maxBytes, expectedHash = null) {
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || !owned(dir)) blocked();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (constants.O_NONBLOCK || 0));
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 ||
        !owned(before) || before.size < minBytes ||
        before.size > maxBytes) blocked();
    const raw = await fd.readFile();
    try {
      const after = await fd.stat();
      if (before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== raw.length || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs) blocked();
      if (expectedHash) {
        const digest = createHash('sha256').update(raw).digest();
        if (!timingSafeEqual(digest, Buffer.from(expectedHash, 'hex')))
          blocked();
      }
      const parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(raw));
      // Exact canonical redacted M94 file generated from trusted runner.
      if (expectedHash && !raw.equals(Buffer.from(
        JSON.stringify(parsed, null, 2) + '\n', 'utf8'))) blocked();
      return parsed;
    } finally { raw.fill(0); }
  } finally { await fd.close(); }
}

async function run() {
  const expectedOrigin = allowed();
  const [report, pair] = await Promise.all([
    privateJson(env.OGE_VAULT_M95_M94_REPORT_FILE, 400, 8192,
      env.OGE_VAULT_M95_EXPECTED_M94_SHA256),
    privateJson(env.OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE, 64, 16384),
  ]);
  const artifacts = await verifyVaultTwoDeviceEvidenceArtifacts({
    manifestFile: env.OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE,
    artifactsDirectory: env.OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY,
    expectedOrigin,
    acceptancePair: {
      pair,
      expectedRunId: env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID,
      deviceAChallenge: env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX,
      deviceBChallenge: env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX,
    },
  });
  const result = inspectVaultM95OfflineEvidence(report, artifacts, {
    expectedOrigin,
    expectedRunId: env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID,
    reportFileHashVerified: true,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.allM67ScenarioClaimsReportedPassed ? 2 : 3;
}
try {
  await run();
} catch {
  console.error('BLOCKED: private M95 evidence, independent hash or signed observation mismatch; no retry or signoff.');
  process.exitCode = 1;
}
