#!/usr/bin/env node
/**
 * M79 OFFLINE private two-reviewer Ed25519 incident dossier verification.
 * No MongoDB, GitHub, Auth.js, signer, note writer or quarantine release.
 * Success exits 2 (HOLD), never 0 (which automation might treat as release).
 *
 * Expected incident scope and two trust anchors MUST be loaded separately
 * from the untrusted dossier and M78 report, through the operator's secret
 * management / access-controlled maintenance environment.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  verifyQuarantineTwoReviewerAttestations,
} from '../lib/oge-vault-quarantine-dual-review.js';

const env = process.env;
const maxBytes = 24 * 1024;
const privateOwner = (stat) =>
  (stat.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || stat.uid === process.getuid());
const file = env.OGE_VAULT_QUARANTINE_DOSSIER_FILE;
const reviewFile = env.OGE_VAULT_QUARANTINE_M78_REVIEW_FILE;
const originOk = (() => {
  try {
    const url = new URL(env.OGE_STAGING_URL);
    return url.protocol === 'https:' && !url.port &&
      url.origin === env.OGE_STAGING_URL &&
      /(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(url.hostname);
  } catch { return false; }
})();

const allowed = env.OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW ===
    'YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY' &&
  typeof file === 'string' && isAbsolute(file) &&
  typeof reviewFile === 'string' && isAbsolute(reviewFile) &&
  file !== reviewFile && originOk &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
  env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' &&
  env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true';

async function privateJson(path) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || !privateOwner(parent))
    throw new TypeError('Unsafe private review directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !privateOwner(before) ||
        before.size < 15 || before.size > maxBytes)
      throw new TypeError('Unsafe private review evidence');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== bytes.length || after.size !== bytes.length ||
        before.mtimeMs !== after.mtimeMs)
      throw new TypeError('Private review evidence changed while read');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

if (!allowed) {
  console.error('BLOCKED: isolated offline private signature inspection requires explicit guard.');
  process.exitCode = 1;
} else {
  try {
    const dossier = await privateJson(file);
    const review = await privateJson(reviewFile);
    const report = verifyQuarantineTwoReviewerAttestations(
      dossier, review, {
        expectedScope: {
          incidentId: env.OGE_VAULT_QUARANTINE_EXPECTED_INCIDENT_ID,
          operationId: env.OGE_VAULT_QUARANTINE_EXPECTED_OPERATION_ID,
          ownerScopeSha256: env.OGE_VAULT_QUARANTINE_EXPECTED_OWNER_SCOPE_SHA256,
          repoId: Number(env.OGE_VAULT_QUARANTINE_EXPECTED_REPO_ID),
          installationId: Number(env.OGE_VAULT_QUARANTINE_EXPECTED_INSTALLATION_ID),
        },
        publicKeys: {
          operator: env.OGE_VAULT_QUARANTINE_OPERATOR_PUBLIC_KEY_DER_BASE64,
          reviewer: env.OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64,
        },
      },
    );
    // Redacted, content-free report only; no IDs, paths, tokens or artifacts.
    console.log(JSON.stringify(report, null, 2));
    // A cryptographic success is still a QUARANTINE HOLD, never release.
    process.exitCode = 2;
  } catch {
    // Do not expose private file names, owner IDs or source text in errors.
    console.error('BLOCKED: signed quarantine review evidence invalid or untrusted.');
    process.exitCode = 1;
  }
}
