#!/usr/bin/env node
/**
 * Milestone #47: DISPOSABLE LOCAL REPLICA SET ONLY.
 * One narrow, audited manual recovery of a lock proven to be before the
 * durable GitHub write-attempt marker. Never enable in a production worker
 * or run against a real customer's database.
 *
 * This CLI deliberately refuses Atlas/remote MongoDB, non-disposable DB
 * names, missing exact operation scope, or incomplete human assertions.
 * It does not access GitHub or decrypt, delete or export note contents.
 */
import { MongoClient } from 'mongodb';
import { releasePreWriteVaultImportLockInStaging } from '../lib/oge-vault-import-lock-prewrite-release.js';

const env = process.env;
const dbName = env.MONGODB_DB;
const uri = env.MONGODB_URI;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
  expectedOperationId: env.OGE_VAULT_INSPECT_OPERATION_ID,
};
const enabled =
  env.OGE_VAULT_PREWRITE_RELEASE_STAGING_ONLY === 'YES_DISPOSABLE_PREWRITE_ONLY' &&
  env.OGE_VAULT_MAINTENANCE_QUIESCED === 'YES_ALL_WRITERS_STOPPED' &&
  env.OGE_VAULT_INDEPENDENT_REVIEW === 'YES_SEPARATE_APPROVER' &&
  env.OGE_VAULT_PREWRITE_RELEASE_CONFIRMATION === 'RELEASE_ONLY_PRE_GITHUB_WRITE_LOCK' &&
  typeof uri === 'string' &&
  /^mongodb:\/\/(?:localhost|127\.0\.0\.1):27017\/(?:\?|$)/.test(uri) &&
  typeof dbName === 'string' &&
  /^oge_vault_recovery_staging_[a-zA-Z0-9_]{1,36}$/.test(dbName) &&
  typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
  (identity.sessionVersion === 0 || typeof identity.sessionVersion === 'string') &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0 &&
  typeof identity.expectedOperationId === 'string' &&
  typeof env.OGE_VAULT_RELEASE_STARTED_AT === 'string' &&
  typeof env.OGE_VAULT_RELEASE_INCIDENT_ID === 'string';

if (!enabled) {
  console.error('BLOCKED: disposal-only localhost replica set, exact owner/operation, separate reviewer and maintenance acknowledgments are mandatory.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(uri, {
    appName: 'oge-vault-disposable-prewrite-recovery',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary',
  });
  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    const hello = await db.admin().command({ hello: 1 });
    if (typeof hello.setName !== 'string' || !hello.setName)
      throw new Error('Replica set required');
    const result = await releasePreWriteVaultImportLockInStaging(db, identity, {
      incidentId: env.OGE_VAULT_RELEASE_INCIDENT_ID,
      startedAt: env.OGE_VAULT_RELEASE_STARTED_AT,
      maintenanceConfirmed: true, independentReviewConfirmed: true,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('NOTE: local disposable staging only. No production unlock has been authorized.');
  } catch (error) {
    // Never emit driver/provider text: could expose secrets or owner identity.
    console.error('Blocked prewrite Vault lock recovery: ' +
      (error instanceof Error ? error.name : 'UnknownError'));
    process.exitCode = 2;
  } finally {
    await mongo.close().catch(() => {});
  }
}
