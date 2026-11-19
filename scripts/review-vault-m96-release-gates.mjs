#!/usr/bin/env node
/**
 * E28/M96 — OFFLINE two independently pinned Ed25519 reviewer signatures
 * over a private, exact M95 report SHA256. No keys generated, no signing,
 * no provider/GitHub/MongoDB requests, no approval to restore or deploy.
 *
 * EXIT 2: valid HOLD-only key signatures over matched private evidence claim.
 * EXIT 1: blocked/invalid. EXIT 0 is NEVER approval.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { vaultM94RunBindingDigest } from
  '../lib/oge-vault-m94-read-only-acceptance.js';
import { verifyVaultM96ExternalHoldReview } from
  '../lib/oge-vault-m96-external-hold-review.js';

const env = process.env;
const HEX = /^[a-f0-9]{64}$/;
const STAGE = /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/;
const HOST = /(?:^|[.-])(staging|preview)(?:[.-]|$)/i;
const fail = () => { throw new TypeError('Invalid independent M96 reviewer HOLD evidence'); };
const owned = st => Boolean(st && (st.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || st.uid === process.getuid()));

function trustedOrigin() {
  try {
    const u = new URL(env.OGE_STAGING_URL);
    if (u.protocol !== 'https:' || u.origin !== env.OGE_STAGING_URL ||
        u.pathname !== '/' || u.search || u.hash || u.port ||
        u.username || u.password || !HOST.test(u.hostname) ||
        env.AUTH_URL !== u.origin || env.OGE_VAULT_BASE_URL !== u.origin)
      fail();
    return u.origin;
  } catch { fail(); }
}

function allowed() {
  const paths = [
    env.OGE_VAULT_M96_M95_REVIEW_FILE,
    env.OGE_VAULT_M96_HOLD_DOSSIER_FILE,
  ];
  if (env.OGE_VAULT_M96_DUAL_HOLD_REVIEW !==
        'YES_TWO_INDEPENDENT_ED25519_KEYS_EVIDENCE_HOLD_ONLY' ||
      !STAGE.test(env.MONGODB_DB || '') ||
      !HEX.test(env.OGE_VAULT_M96_EXPECTED_M95_SHA256 || '') ||
      paths.some(p => typeof p !== 'string' || !isAbsolute(p)) ||
      paths[0] === paths[1] ||
      typeof env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID !== 'string' ||
      typeof env.OGE_VAULT_M96_OPERATOR_PUBLIC_KEY_DER_BASE64 !== 'string' ||
      typeof env.OGE_VAULT_M96_REVIEWER_PUBLIC_KEY_DER_BASE64 !== 'string' ||
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
      env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK) fail();
  return trustedOrigin();
}

async function privateFile(path, expectedHash) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || !owned(parent)) fail();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (constants.O_NONBLOCK || 0));
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 ||
        !owned(before) || before.size < 64 || before.size > 24576) fail();
    const raw = await fd.readFile();
    try {
      const after = await fd.stat();
      if (before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== raw.length || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs) fail();
      if (expectedHash) {
        const actual = createHash('sha256').update(raw).digest();
        if (!timingSafeEqual(
          actual, Buffer.from(expectedHash, 'hex'))) fail();
      }
      const value = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(raw));
      if (expectedHash && !raw.equals(
        Buffer.from(JSON.stringify(value, null, 2) + '\n'))) fail();
      return value;
    } finally { raw.fill(0); }
  } finally { await fd.close(); }
}

async function main() {
  const origin = allowed();
  const [report, dossier] = await Promise.all([
    privateFile(env.OGE_VAULT_M96_M95_REVIEW_FILE,
      env.OGE_VAULT_M96_EXPECTED_M95_SHA256),
    privateFile(env.OGE_VAULT_M96_HOLD_DOSSIER_FILE, null),
  ]);
  const result = verifyVaultM96ExternalHoldReview(dossier, report, {
    expectedRunBindingSha256: vaultM94RunBindingDigest(
      env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID, origin),
    expectedM95ReportSha256: env.OGE_VAULT_M96_EXPECTED_M95_SHA256,
    publicKeys: {
      operator: env.OGE_VAULT_M96_OPERATOR_PUBLIC_KEY_DER_BASE64,
      securityReviewer: env.OGE_VAULT_M96_REVIEWER_PUBLIC_KEY_DER_BASE64,
    },
    reportBytesVerified: true,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 2;
}

try {
  await main();
} catch {
  console.error('BLOCKED: M96 external HOLD-only review invalid; no release, retry or signoff.');
  process.exitCode = 1;
}
