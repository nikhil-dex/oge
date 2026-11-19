#!/usr/bin/env node
/**
 * Milestone #48 — PRIVATE OPERATOR, READ-ONLY GitHub import attempt evidence.
 * Never fetch note blobs, decrypt drafts, write to GitHub or unlock an import.
 * Requires a signed owner session incarnation and exact stored lock UUID.
 *
 * A GitHub installation token mint uses POST but does not modify note files;
 * all repository calls by this command are GETs.
 */
import { MongoClient } from 'mongodb';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { inspectVaultImportAttemptEvidenceReadOnly } from '../lib/oge-vault-import-attempt-evidence.js';

const env = process.env;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
  expectedOperationId: env.OGE_VAULT_INSPECT_OPERATION_ID,
};
const dbName = env.MONGODB_DB;
const allowed = env.OGE_VAULT_IMPORT_EVIDENCE_READ_ONLY === 'YES_METADATA_ONLY' &&
  typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 &&
  typeof dbName === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(dbName) &&
  typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' && identity.sessionVersion.length > 0)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0 &&
  typeof identity.expectedOperationId === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(identity.expectedOperationId);

if (!allowed) {
  console.error('BLOCKED: explicit database, exact signed owner/repository/import scope, and OGE_VAULT_IMPORT_EVIDENCE_READ_ONLY=YES_METADATA_ONLY required.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(env.MONGODB_URI, {
    appName: 'oge-vault-import-evidence-read-only',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary', readConcern: { level: 'majority' },
  });
  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    const github = await getVaultNoteClient(db, {
      ownerId: identity.ownerId,
      sessionVersion: identity.sessionVersion,
    }, { readOnly: true });
    if (github.vault.repoId !== identity.repoId)
      throw new Error('Signed repository scope changed');
    const result = await inspectVaultImportAttemptEvidenceReadOnly(
      db, identity, github);
    console.log(JSON.stringify(result, null, 2));
    // Never turn finding a candidate into an unlock/retry authorization.
    process.exitCode = 2;
  } catch (error) {
    console.error('Vault import evidence inspection blocked: ' +
      (error instanceof Error ? error.name : 'UnknownError'));
    process.exitCode = 1;
  } finally {
    await mongo.close().catch(() => {});
  }
}
