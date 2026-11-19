#!/usr/bin/env node
/**
 * M68 read-only private evidence ARTIFACT bit-integrity check.
 * Never authenticates capture source, GitHub ownership or device identity;
 * never authorizes a write, release, import lock repair or acceptance signoff.
 */
import { isAbsolute } from 'node:path';
import {
  verifyVaultTwoDeviceEvidenceArtifacts,
} from '../lib/oge-vault-two-device-artifact-verification.js';

const env = process.env;
const file = env.OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE;
const directory = env.OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY;
let origin = null;
try {
  const u = new URL(env.OGE_STAGING_URL);
  if (u.protocol === 'https:' && u.origin === env.OGE_STAGING_URL &&
      !u.port && /(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(u.hostname))
    origin = u.origin;
} catch { /* fail closed */ }

const allowed =
  env.OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW ===
    'YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY' &&
  typeof file === 'string' && isAbsolute(file) &&
  typeof directory === 'string' && isAbsolute(directory) &&
  typeof origin === 'string' &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
    env.MONGODB_DB || '') &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true';

if (!allowed) {
  console.error('BLOCKED: private isolated staging artifact hash inspection consent required.');
  process.exitCode = 1;
} else {
  try {
    const report = await verifyVaultTwoDeviceEvidenceArtifacts({
      manifestFile: file, artifactsDirectory: directory,
      expectedOrigin: origin,
    });
    console.log(JSON.stringify(report, null, 2));
    // Exit 0 means only that local bytes match the supplied untrusted index.
    // No GitHub, physical device, independent redaction or operator signoff.
    if (report.status !== 'ON_DISK_HASHES_MATCH_INDEPENDENT_REVIEW_REQUIRED')
      process.exitCode = 3;
  } catch {
    // Deliberately no private path, note text, token or captured artifact.
    console.error('BLOCKED: missing, unsafe or mismatched private evidence artifacts.');
    process.exitCode = 2;
  }
}
