#!/usr/bin/env node
/**
 * Milestone #46: explicit, read-only operator inspection of a stuck Vault
 * import lock. This tool NEVER unlocks, edits or decrypts user content.
 *
 * Avoid the application's index-creating database initializer. Only
 * reads owner-scoped MongoDB metadata, mints a scoped GitHub App token, and
 * checks the branch ref twice. No GitHub note reads or writes occur.
 *
 * Env values containing private owner, account version and operation IDs
 * are never printed. Output contains only safety booleans and reason codes.
 */
import { MongoClient } from 'mongodb';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { inspectVaultImportLockReadOnly } from '../lib/oge-vault-import-lock-inspection.js';

const env = process.env;
const ownerId = env.OGE_VAULT_INSPECT_OWNER_ID;
const sessionVersion = env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
  ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION;
const expectedOperationId = env.OGE_VAULT_INSPECT_OPERATION_ID;
const repoId = Number(env.OGE_VAULT_INSPECT_REPO_ID);
const dbName = env.MONGODB_DB;
const allowed = env.OGE_VAULT_IMPORT_LOCK_INSPECT_READ_ONLY === 'YES_REDACTED_ONLY' &&
  typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 &&
  typeof dbName === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(dbName) &&
  typeof ownerId === 'string' && ownerId.length > 0 &&
  (typeof sessionVersion === 'string' || sessionVersion === 0) &&
  typeof expectedOperationId === 'string' && expectedOperationId.length > 0 &&
  Number.isSafeInteger(repoId) && repoId > 0;

if (!allowed) {
  console.error('BLOCKED: provide an explicit database and complete exact-owner import-lock scope, plus OGE_VAULT_IMPORT_LOCK_INSPECT_READ_ONLY=YES_REDACTED_ONLY.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(env.MONGODB_URI, {
    appName: 'oge-vault-import-lock-inspection-read-only',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary', readConcern: { level: 'majority' },
  });
  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    let vaultClient;
    const report = await inspectVaultImportLockReadOnly(db, {
      ownerId, sessionVersion, repoId, expectedOperationId,
    }, {
      githubHeadReader: async () => {
        if (!vaultClient) {
          vaultClient = await getVaultNoteClient(db, { ownerId, sessionVersion });
          if (vaultClient.vault.repoId !== repoId)
            throw new Error('Vault repo mismatch');
        }
        return (await vaultClient.call(
          '/git/ref/heads/' + encodeURIComponent(vaultClient.branch)))?.object?.sha;
      },
    });
    console.log(JSON.stringify(report, null, 2));
    // A match is NEVER an approval to release the lock. Exit 2 forces the
    // operator to follow the separate manual incident/recovery runbook.
    process.exitCode = report.status === 'NO_LOCK_PRESENT' ? 0 : 2;
  } catch (error) {
    console.error('Vault import-lock inspection blocked: ' +
      (error instanceof Error ? error.name : 'UnknownError'));
    process.exitCode = 1;
  } finally {
    await mongo.close().catch(() => {});
  }
}
