#!/usr/bin/env node
/**
 * M61 operator-only real GitHub App READ probe. Never writes GitHub or DB.
 * An observed read-only provider result is NOT browser/two-device signoff.
 */
import { MongoClient } from 'mongodb';
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { inspectVaultProviderReadOnlyPair } from '../lib/oge-vault-live-provider-probe.js';

const env = process.env;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
  installationId: Number(env.OGE_VAULT_INSPECT_INSTALLATION_ID),
  repoName: 'ogenotes-vault',
};
const allowed =
  env.OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY ===
    'YES_ISOLATED_PRIVATE_STAGING_GETS_ONLY' &&
  env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW === 'true' &&
  env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
  env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
  env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
  env.OGE_VAULT_ACCOUNT_DELETION_INTERNAL !== 'true' &&
  !env.OGE_VAULT_REAL_PROVIDER_PROBE_WRITE_ACK &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
  typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 &&
  typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
  identity.ownerId.length <= 200 &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' &&
      UUID.test(identity.sessionVersion))) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0 &&
  Number.isSafeInteger(identity.installationId) && identity.installationId > 0 &&
  checkVaultStagingReadiness(env).ok;

if (!allowed) {
  console.error('BLOCKED: isolated signed staging account and explicit read-only real-provider consent required.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(env.MONGODB_URI, {
    appName: 'oge-vault-signed-real-provider-readonly-probe',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary', readConcern: { level: 'majority' },
  });
  try {
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB);
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw new TypeError('Secure staging Mongo replica set required');
    const ownerVerifier = async () => {
      const account = await db.collection('users').findOne({
        ...ownerMutationFilter(identity.ownerId, {
          sessionVersion: identity.sessionVersion,
        }),
        'vault.status': 'connected',
        'vault.repoId': identity.repoId,
        'vault.installationId': identity.installationId,
        'vault.repoName': identity.repoName,
      }, { projection: { vault: 1 } });
      const v = account?.vault;
      return v?.status === 'connected' &&
        v.repoId === identity.repoId &&
        v.installationId === identity.installationId &&
        v.repoName === identity.repoName &&
        typeof v.githubAccountId === 'string' &&
        typeof v.githubLogin === 'string';
    };
    if (!await ownerVerifier())
      throw new TypeError('Owner staging scope unavailable');
    // Each call requests a separately scoped contents:read installation.
    // No contents:write token is obtained here.
    const first = await getVaultNoteClient(db, identity, { readOnly: true });
    const second = await getVaultNoteClient(db, identity, { readOnly: true });
    if (first.vault.repoId !== identity.repoId ||
        second.vault.installationId !== identity.installationId)
      throw new TypeError('Private GitHub installation scope changed');
    const report = await inspectVaultProviderReadOnlyPair(first, second, {
      ownerVerifier,
    });
    console.log(JSON.stringify(report, null, 2));
    // Exit 0 means this READ-only probe passed, not staging acceptance.
  } catch (error) {
    // Provider request failures must be redacted (never print tokens/owner).
    console.error('BLOCKED: signed GitHub read-only provider probe failed (' +
      (error instanceof Error ? error.name : 'UnknownError') + ').');
    process.exitCode = 2;
  } finally {
    await mongo.close().catch(() => {});
  }
}
