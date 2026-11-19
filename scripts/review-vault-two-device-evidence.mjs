#!/usr/bin/env node
/**
 * M67 read-only review of UNTRUSTED external two-device evidence references.
 * Never connects to GitHub, Auth.js or MongoDB. NEVER marks live signoff.
 * Do not pass secrets, tokens, Note text or private user IDs in this file.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  inspectVaultTwoDeviceEvidenceManifest,
} from '../lib/oge-vault-two-device-evidence.js';

const env = process.env;
const file = env.OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE;
const maxBytes = 32 * 1024;
const privateOwner = (stat) =>
  (stat.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || stat.uid === process.getuid());
let origin = null;
try {
  const url = new URL(env.OGE_STAGING_URL);
  if (url.protocol === 'https:' && !url.port &&
      url.origin === env.OGE_STAGING_URL &&
      /(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(url.hostname))
    origin = url.origin;
} catch { /* fail closed */ }
const allowed =
  env.OGE_VAULT_TWO_DEVICE_EVIDENCE_REVIEW ===
    'YES_REDACTED_EXTERNAL_EVIDENCE_ONLY' &&
  typeof file === 'string' && isAbsolute(file) &&
  typeof origin === 'string' &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
    env.MONGODB_DB || '') &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true';

async function readPrivateManifest() {
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || !privateOwner(parent))
    throw new TypeError('Unsafe evidence directory');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !privateOwner(before) ||
        before.size < 20 || before.size > maxBytes)
      throw new TypeError('Unsafe evidence file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== bytes.length || after.size !== bytes.length ||
        before.mtimeMs !== after.mtimeMs)
      throw new TypeError('Evidence file changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

if (!allowed) {
  console.error('BLOCKED: explicit isolated staging and private redacted evidence required.');
  process.exitCode = 1;
} else {
  try {
    const manifest = await readPrivateManifest();
    const report = inspectVaultTwoDeviceEvidenceManifest(manifest, {
      expectedOrigin: origin,
    });
    console.log(JSON.stringify(report, null, 2));
    // A complete INDEX can only prompt independent external review.
    // Exit 0 NEVER means signed two-device/live GitHub acceptance.
    if (report.status !== 'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW')
      process.exitCode = 3;
  } catch {
    console.error('BLOCKED: invalid, unsafe or unverifiable external evidence metadata.');
    process.exitCode = 2;
  }
}
