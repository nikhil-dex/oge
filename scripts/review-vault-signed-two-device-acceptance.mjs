#!/usr/bin/env node
/**
 * E15/M83: OFFLINE private M82 observation pair + M67/M68 actual hashes.
 * An index READY result is NOT actual physical-device or OAuth signoff.
 * Explicit opt-in, disposable stage, NO GitHub/Mongo connections or writes.
 * Exit 2 = indexed for MANUAL REVIEW, 3 = incomplete, 1 = blocked;
 * NEVER exit 0 as though production acceptance were authorized.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  verifyVaultTwoDeviceEvidenceArtifacts,
} from '../lib/oge-vault-two-device-artifact-verification.js';

const env = process.env;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const manifestFile = env.OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE;
const artifactsDirectory = env.OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY;
const pairFile = env.OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE;
const expectedRunId = env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID;
const challengeA = env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX;
const challengeB = env.OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX;
const optIn = 'YES_OFFLINE_TWO_SIGNED_DEVICE_OBSERVATIONS_AND_MATRIX_ONLY';
let origin = null;
try {
  const target = new URL(env.OGE_STAGING_URL);
  if (target.protocol === 'https:' && !target.port &&
      target.origin === env.OGE_STAGING_URL &&
      /(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(target.hostname))
    origin = target.origin;
} catch { /* deny */ }

const allowed = env.OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW === optIn &&
  env.OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW ===
    'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY' &&
  typeof manifestFile === 'string' && isAbsolute(manifestFile) &&
  typeof artifactsDirectory === 'string' && isAbsolute(artifactsDirectory) &&
  typeof pairFile === 'string' && isAbsolute(pairFile) &&
  pairFile !== manifestFile &&
  dirname(pairFile) !== artifactsDirectory &&
  dirname(manifestFile) !== artifactsDirectory &&
  UUID.test(expectedRunId || '') &&
  HEX.test(challengeA || '') && HEX.test(challengeB || '') &&
  challengeA !== challengeB &&
  typeof origin === 'string' &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
    env.MONGODB_DB || '') &&
  env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' &&
  !env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK &&
  env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
  env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true';

function ownerOnly(st) {
  return Boolean(st && (st.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || st.uid === process.getuid()));
}
async function privatePairFile(path) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || !ownerOnly(parent))
    throw new TypeError('Unsafe acceptance pair directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 ||
        !ownerOnly(before) || before.size < 64 || before.size > 16 * 1024)
      throw new TypeError('Unsafe acceptance pair evidence file');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || data.length !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs)
      throw new TypeError('Acceptance pair file changed while reading');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } finally { await handle.close(); }
}

if (!allowed) {
  console.error('BLOCKED: independently scoped private read-only staging acceptance review opt-in required.');
  process.exitCode = 1;
} else {
  try {
    const pair = await privatePairFile(pairFile);
    const result = await verifyVaultTwoDeviceEvidenceArtifacts({
      manifestFile, artifactsDirectory, expectedOrigin: origin,
      acceptancePair: {
        pair, expectedRunId,
        deviceAChallenge: challengeA,
        deviceBChallenge: challengeB,
      },
    });
    // Only metadata, observed scenario labels and explicit false
    // signoff flags. Never IDs, raw nonces, repo SHAs or private file bytes.
    const report = result.acceptanceReadiness;
    if (result.onDiskArtifactHashesRecomputed !== true || !report ||
        report.canEnableProduction !== false ||
        report.completeStagingAcceptanceSignedOff !== false)
      throw new TypeError('Unverified acceptance evidence report');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.allScenarioClaimsPresentAndPassed ? 2 : 3;
  } catch {
    console.error('BLOCKED: unsafe, mixed-run or altered private two-device acceptance evidence.');
    process.exitCode = 1;
  }
}
