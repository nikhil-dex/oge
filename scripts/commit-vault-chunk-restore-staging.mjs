#!/usr/bin/env node
/**
 * M59: ISOLATED STAGING ONLY — one signed browser approval
 * and one local <=12-note create-only GitHub restore batch. NEVER production.
 * The private backup stays in local 0700/0600 files, not a web upload.
 * No multi-batch loop, automatic retry, lock release or draft cleanup.
 */
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MongoClient } from 'mongodb';
import {
  readVaultOperatorBackupPassphraseFd3,
  prepareVaultOperatorEncryptedRestore,
} from '../lib/oge-vault-operator-encrypted-chunks.js';
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from '../lib/oge-vault-backup-export-chunk.js';
import {
  verifyVaultRestoreApprovalTicket, claimVaultRestoreApprovalOnce,
  confirmVaultRestoreApproval,
} from '../lib/oge-vault-restore-approval-ticket.js';
import { executeApprovedVaultChunkRestoreBatch } from '../lib/oge-vault-backup-chunk-restore-execute.js';

const env = process.env;
const uri = env.MONGODB_URI;
const dbName = env.MONGODB_DB;
const directory = env.OGE_VAULT_CHUNK_PLAN_DIRECTORY;
const ticketFile = env.OGE_VAULT_CHUNK_RESTORE_TICKET_FILE;
const encryptedMode = env.OGE_VAULT_CHUNK_RESTORE_ENCRYPTED_OPERATOR ===
  'YES_PRIVATE_ENCRYPTED_PARTS_FD3_ONLY';
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0' ? 0 :
    env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
  installationId: Number(env.OGE_VAULT_INSPECT_INSTALLATION_ID),
  repoName: 'ogenotes-vault',
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const allowed =
  env.OGE_VAULT_CHUNK_RESTORE_STAGING_OPERATOR === 'YES_ONE_SIGNED_BATCH_ONLY' &&
  env.OGE_VAULT_CHUNK_RESTORE_STAGING_ACK ===
    'YES_SEPARATE_SYNTHETIC_STAGING_DATABASE' &&
  env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW === 'true' &&
  env.OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW === 'true' &&
  env.OGE_VAULT_CHUNK_RESTORE_WRITE_ACK ===
    'YES_DISPOSABLE_SIGNED_STAGING_ONLY' &&
  env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
  env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
  env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW === 'true' &&
  env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW === 'true' &&
  !env.OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY &&
  !env.OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY &&
  (env.OGE_VAULT_CHUNK_RESTORE_ENCRYPTED_OPERATOR === undefined ||
    encryptedMode) &&
  typeof uri === 'string' &&
  /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(dbName || '') &&
  typeof directory === 'string' && isAbsolute(directory) &&
  typeof ticketFile === 'string' && isAbsolute(ticketFile) &&
  ticketFile !== directory &&
  typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
  (identity.sessionVersion === 0 ||
    typeof identity.sessionVersion === 'string' &&
    UUID.test(identity.sessionVersion)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0 &&
  Number.isSafeInteger(identity.installationId) &&
  identity.installationId > 0 &&
  checkVaultStagingReadiness(env).ok;

function privateFile(stat, maxBytes) {
  return stat?.isFile() && stat.size >= 2 && stat.size <= maxBytes &&
    (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

async function readPrivateFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!privateFile(before, limit))
      throw new TypeError('Unsafe private restore file');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== bytes.length ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new TypeError('Private restore file changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await file.close(); }
}

async function checkPrivateChunks(folder) {
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
    throw new TypeError('Unsafe private chunk directory');
  const names = await readdir(folder);
  if (names.length < 1 || names.length > 16 ||
      names.some((name) => !/^part-[0-9]{4}\.json$/.test(name)))
    throw new TypeError('Invalid private chunk sequence');
  names.sort();
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== 'part-' + String(i + 1).padStart(4, '0') + '.json')
      throw new TypeError('Missing or reordered chunk part');
    const file = await open(join(folder, names[i]),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!privateFile(await file.stat(), MAX_VAULT_BACKUP_CHUNK_BYTES))
        throw new TypeError('Unsafe private chunk part');
    } finally { await file.close(); }
  }
  return names;
}

async function* privateChunks(folder) {
  const names = await checkPrivateChunks(folder);
  for (const name of names)
    yield await readPrivateFile(join(folder, name),
      MAX_VAULT_BACKUP_CHUNK_BYTES);
}

let ticket = null, privateFilesReady = false;
let trustedChunkSource = () => privateChunks(directory);
if (allowed) {
  try {
    // Local permission/format checks and HMAC verification happen BEFORE
    // connecting to MongoDB or minting a contents:write installation token.
    if (!encryptedMode) await checkPrivateChunks(directory);
    const obj = await readPrivateFile(ticketFile, 4096);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
        Object.keys(obj).length !== 1 || typeof obj.ticket !== 'string')
      throw new TypeError('Invalid private signed receipt');
    ticket = verifyVaultRestoreApprovalTicket(obj.ticket, identity, {
      secret: env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_KEY,
    });
    if (encryptedMode) {
      // Complete local review of all ciphertext BEFORE any MongoDB access,
      // claim or GitHub write token. FD3 keeps secret out of argv/env.
      const passphrase = await readVaultOperatorBackupPassphraseFd3();
      const prepared = await prepareVaultOperatorEncryptedRestore(
        directory, passphrase, ticket.approval);
      trustedChunkSource = () => prepared.chunks();
    }
    privateFilesReady = true;
  } catch {
    // NEVER print private file paths, ticket, note content, owner or secrets.
  }
}
if (!allowed || !privateFilesReady) {
  console.error('BLOCKED: shared isolated staging database, exact signed owner scope, private one-time receipt and owner-only chunk files required.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(uri, {
    appName: 'oge-vault-one-batch-staging-restore',
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 3,
    readPreference: 'primary',
    readConcern: { level: 'majority' },
  });
  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    if (!(await db.admin().command({ hello: 1 })).setName)
      throw new TypeError('Staging MongoDB replica set required');
    const user = await db.collection('users').findOne({
      ...ownerMutationFilter(identity.ownerId, {
        sessionVersion: identity.sessionVersion,
      }),
      'vault.status': 'connected',
      'vault.repoId': identity.repoId,
      'vault.installationId': identity.installationId,
      'vault.repoName': identity.repoName,
    }, { projection: { _id: 1 } });
    if (!user) throw new TypeError('Signed Vault owner is no longer connected');

    // Consume the receipt via an atomic pending->claimed CAS exactly ONCE.
    // All later failures leave this claim consumed: no blind GitHub replay.
    await claimVaultRestoreApprovalOnce(db, identity, ticket);
    const github = await getVaultNoteClient(db, {
      ownerId: identity.ownerId, sessionVersion: identity.sessionVersion,
    });
    if (github.vault.repoId !== identity.repoId ||
        github.vault.installationId !== identity.installationId)
      throw new TypeError('GitHub owner or installation changed');
    const result = await executeApprovedVaultChunkRestoreBatch(db, {
      ownerId: identity.ownerId,
      sessionVersion: identity.sessionVersion,
      repoId: identity.repoId,
    }, github, trustedChunkSource(), ticket.approval, { env });
    await confirmVaultRestoreApproval(db, identity, ticket, result.commitSha);
    // Deliberately NEVER output the private approval, chunk text or owner.
    console.log(JSON.stringify({
      status: 'ONE_BATCH_CONFIRMED',
      restoredCount: result.restoredCount,
      singleBatchOnly: true, nextBatchAutomaticallyStarted: false,
      encryptedDraftsChanged: false, requiresFreshNextBatchApproval: true,
    }));
  } catch (error) {
    // An uncertain GitHub result keeps the durable owner lock and consumed
    // approval. Recovery is a separate independent read-only investigation.
    console.error('BLOCKED: staging restore outcome not confirmed (' +
      (error instanceof Error ? error.name : 'UnknownError') + ').');
    process.exitCode = 2;
  } finally { await mongo.close().catch(() => {}); }
}
