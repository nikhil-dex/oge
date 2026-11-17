#!/usr/bin/env node
/**
 * E18/M86 operator-run read-only GITHUB APP/owner metadata inspection.
 * This script connects only to an isolated staging Mongo replica
 * (projected account identity) and requests contents:read installation
 * GitHub tokens, then GETs only metadata/HEAD/tree/a tiny sentinel blob.
 * No user Notes, draft bodies, Git ref updates, test-fault writes or lock
 * release. Requires separate trusted inputs from an authorized operator.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { MongoClient } from 'mongodb';
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import {
  inspectVaultDisposableFaultStagingReadOnly,
} from '../lib/oge-vault-disposable-fault-staging-preflight.js';

const env = process.env;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const allowed =
  env.OGE_VAULT_DISPOSABLE_FAULT_PREFLIGHT ===
    'YES_SIGNED_OWNER_DISPOSABLE_PRIVATE_GITHUB_GETS_ONLY' &&
  env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' &&
  !env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK &&
  env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
  env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
  env.OGE_VAULT_ACCOUNT_DELETION_INTERNAL !== 'true' &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
  env.OGE_STAGING_URL === env.AUTH_URL &&
  env.OGE_STAGING_URL === env.OGE_VAULT_BASE_URL &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
  typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 &&
  typeof env.OGE_VAULT_FAULT_PREFLIGHT_PLAN_FILE === 'string' &&
  isAbsolute(env.OGE_VAULT_FAULT_PREFLIGHT_PLAN_FILE) &&
  UUID.test(env.OGE_VAULT_FAULT_PREFLIGHT_RUN_ID || '') &&
  typeof env.OGE_VAULT_FAULT_PREFLIGHT_OWNER_ID === 'string' &&
  env.OGE_VAULT_FAULT_PREFLIGHT_OWNER_ID.length > 0 &&
  env.OGE_VAULT_FAULT_PREFLIGHT_OWNER_ID.length <= 200 &&
  UUID.test(env.OGE_VAULT_FAULT_PREFLIGHT_SESSION_VERSION || '') &&
  /^[1-9]\d{0,18}$/.test(env.OGE_VAULT_FAULT_PREFLIGHT_GITHUB_ACCOUNT_ID || '') &&
  SHA.test(env.OGE_VAULT_FAULT_PREFLIGHT_HEAD || '') &&
  Number.isSafeInteger(Number(env.OGE_VAULT_FAULT_PREFLIGHT_REPO_ID)) &&
  Number(env.OGE_VAULT_FAULT_PREFLIGHT_REPO_ID) > 0 &&
  Number.isSafeInteger(Number(env.OGE_VAULT_FAULT_PREFLIGHT_INSTALLATION_ID)) &&
  Number(env.OGE_VAULT_FAULT_PREFLIGHT_INSTALLATION_ID) > 0 &&
  typeof env.OGE_VAULT_FAULT_PREFLIGHT_BRANCH === 'string' &&
  checkVaultStagingReadiness(env).ok;

const no = () => { throw new TypeError('Private isolated staging fault-preflight unavailable'); };
const owned = (s) => s && (s.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || s.uid === process.getuid());
async function privatePlan(path) {
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || !owned(dir)) no();
  const handle = await open(path, constants.O_RDONLY |
    constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 ||
        !owned(before) || before.size < 200 || before.size > 4096) no();
    const buf = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || buf.length !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) no();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } finally { await handle.close(); }
}

if (!allowed) {
  console.error('BLOCKED: independently pinned disposable private staging read-only environment required.');
  process.exitCode = 1;
} else {
  let mongo;
  try {
    const plan = await privatePlan(env.OGE_VAULT_FAULT_PREFLIGHT_PLAN_FILE);
    const expectedScope = {
      origin: env.OGE_STAGING_URL,
      runId: env.OGE_VAULT_FAULT_PREFLIGHT_RUN_ID,
      repoId: Number(env.OGE_VAULT_FAULT_PREFLIGHT_REPO_ID),
      installationId: Number(env.OGE_VAULT_FAULT_PREFLIGHT_INSTALLATION_ID),
      githubAccountId: env.OGE_VAULT_FAULT_PREFLIGHT_GITHUB_ACCOUNT_ID,
      branch: env.OGE_VAULT_FAULT_PREFLIGHT_BRANCH,
      expectedHead: env.OGE_VAULT_FAULT_PREFLIGHT_HEAD,
    };
    const identity = {
      ownerId: env.OGE_VAULT_FAULT_PREFLIGHT_OWNER_ID,
      sessionVersion: env.OGE_VAULT_FAULT_PREFLIGHT_SESSION_VERSION,
      repoId: expectedScope.repoId,
    };
    // Fail untrusted plan immediately before obtaining any private
    // Mongo or GitHub credentials.
    const { validateVaultDisposableFaultPlan } = await import(
      '../lib/oge-vault-disposable-fault-staging-preflight.js');
    validateVaultDisposableFaultPlan(plan, expectedScope);

    mongo = new MongoClient(env.MONGODB_URI, {
      appName: 'oge-vault-m86-disposable-readonly-fault-preflight',
      serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
      readPreference: 'primary', readConcern: { level: 'majority' },
    });
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB);
    if (!(await db.admin().command({ hello: 1 })).setName) no();
    let pinnedVault = null;
    const ownerVerifier = async () => {
      const account = await db.collection('users').findOne({
        ...ownerMutationFilter(identity.ownerId, {
          sessionVersion: identity.sessionVersion,
        }),
        'vault.status': 'connected',
        'vault.repoId': expectedScope.repoId,
        'vault.installationId': expectedScope.installationId,
        'vault.repoName': 'ogenotes-vault',
        'vault.githubAccountId': expectedScope.githubAccountId,
      }, { projection: { vault: 1 } });
      const v = account?.vault;
      if (!v || v.status !== 'connected' ||
          v.repoId !== expectedScope.repoId ||
          v.installationId !== expectedScope.installationId ||
          v.githubAccountId !== expectedScope.githubAccountId ||
          v.repoName !== 'ogenotes-vault' ||
          typeof v.githubLogin !== 'string') return false;
      const identityDigest = JSON.stringify([
        v.repoId, v.installationId, v.githubAccountId, v.githubLogin,
        v.repoName,
      ]);
      if (pinnedVault !== null && pinnedVault !== identityDigest)
        return false;
      pinnedVault = identityDigest;
      return true;
    };
    if (!await ownerVerifier()) no();
    // getVaultNoteClient mints separate contents:read App installation
    // tokens (POST /access_tokens), but only GETs repository resources.
    const first = await getVaultNoteClient(db, identity, { readOnly: true });
    const second = await getVaultNoteClient(db, identity, { readOnly: true });
    const report = await inspectVaultDisposableFaultStagingReadOnly(
      first, second, plan, { expectedScope, ownerVerifier });
    if (report.githubWritesPerformed !== false ||
        report.operatorFaultInjectionPermissionGranted !== false ||
        report.canReleaseImportLock !== false) no();
    console.log(JSON.stringify(report, null, 2));
    // A valid read-only provider snapshot is NOT operator approval to
    // inject provider errors or mutate even a disposable Git branch.
    process.exitCode = 2;
  } catch {
    console.error('BLOCKED: disposable private staging owner, sentinel, tree or read-only GitHub inspection failed.');
    process.exitCode = 1;
  } finally {
    await mongo?.close().catch(() => {});
  }
}
