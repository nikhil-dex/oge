#!/usr/bin/env node
/**
 * #49: private, opt-in, READ-ONLY archive-based proof of a quarantined import.
 * The input file is the SAME four-key owner-approved import request, not
 * simply a backup archive or an untrusted advisory plan. No HTTP endpoint,
 * GitHub mutation, lock release, draft retirement, or note-content logging.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MongoClient } from 'mongodb';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from '../lib/oge-vault-backup-export.js';
import { inspectVaultImportArchiveContentReadOnly } from '../lib/oge-vault-import-archive-proof.js';

const env = process.env;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
  expectedOperationId: env.OGE_VAULT_INSPECT_OPERATION_ID,
};
const approvalPath = env.OGE_VAULT_IMPORT_APPROVAL_FILE;
const dbName = env.MONGODB_DB;
const validScope = env.OGE_VAULT_IMPORT_ARCHIVE_PROOF_READ_ONLY === 'YES_EXACT_ARCHIVE_ONLY' &&
  typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 &&
  typeof dbName === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(dbName) &&
  typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' && identity.sessionVersion.length > 0)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0 &&
  typeof identity.expectedOperationId === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(identity.expectedOperationId) &&
  typeof approvalPath === 'string' && isAbsolute(approvalPath);

/**
 * Enforce a private local file (0600 or stricter), no symlink, explicit size
 * bound and stable file stat while read. No file path or contents in errors.
 * Do not use fs.readFile(path), which could follow an unexpected symlink.
 */
async function loadPrivateApproval(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 ||
        before.size > MAX_VAULT_BACKUP_EXPORT_BYTES + 4096 ||
        (before.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && before.uid !== process.getuid()))
      throw new Error('Invalid private approval file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size ||
        before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size)
      throw new Error('Private approval file changed during read');
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await handle.close();
  }
}

if (!validScope) {
  console.error('BLOCKED: exact owner/import scope, explicit database, private approval file and opt-in read-only consent required.');
  process.exitCode = 1;
} else {
  // Validate the private input before any provider/network access.
  let request;
  try { request = await loadPrivateApproval(approvalPath); }
  catch {
    console.error('BLOCKED: approval file must be an owned, private, regular, stable JSON file within the 8 MiB bound.');
    process.exitCode = 1;
  }
  if (request !== undefined) {
    const mongo = new MongoClient(env.MONGODB_URI, {
      appName: 'oge-vault-import-archive-proof-read-only',
      serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
      readPreference: 'primary', readConcern: { level: 'majority' },
    });
    try {
      await mongo.connect();
      const db = mongo.db(dbName);
      const client = await getVaultNoteClient(db, {
        ownerId: identity.ownerId, sessionVersion: identity.sessionVersion,
      }, { readOnly: true });
      if (client.vault.repoId !== identity.repoId)
        throw new Error('Signed repo mismatch');
      const evidence = await inspectVaultImportArchiveContentReadOnly(
        db, identity, client, request);
      console.log(JSON.stringify(evidence, null, 2));
      // A read-only finding NEVER implies permission to unlock or replay.
      process.exitCode = 2;
    } catch (error) {
      // Only the error class is safe; provider error bodies may contain text.
      console.error('Vault private archive proof blocked: ' +
        (error instanceof Error ? error.name : 'UnknownError'));
      process.exitCode = 1;
    } finally {
      await mongo.close().catch(() => {});
    }
  }
}
