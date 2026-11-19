#!/usr/bin/env node
/**
 * M55 current-source proof; M56 independently gated bounded-history proof.
 * Both compare local private chunks with raw Git blobs in the signed
 * owner's Vault, never write MongoDB/GitHub or authorize restore.
 */
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MongoClient } from 'mongodb';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from '../lib/oge-vault-backup-export-chunk.js';
import { verifyVaultNotesChunkGitHubSourceReadOnly } from '../lib/oge-vault-backup-chunk-source-proof.js';

const env = process.env;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
};
const directory = env.OGE_VAULT_CHUNK_PLAN_DIRECTORY;
const currentMode = env.OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY ===
  'YES_CURRENT_GITHUB_HEAD_ONLY';
const historyMode = env.OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY ===
  'YES_20_LINEAR_ANCESTORS_ONLY';
// Exactly one explicit mode is permitted; the older command remains
// current-only unless the distinct historical opt-in is deliberately used.
const allowed = (currentMode !== historyMode) &&
  !((!currentMode && env.OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY) ||
    (!historyMode && env.OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY)) &&
  typeof directory === 'string' && isAbsolute(directory) &&
  typeof env.MONGODB_URI === 'string' && !!env.MONGODB_URI &&
  typeof env.MONGODB_DB === 'string' &&
  /^[a-zA-Z0-9_-]{1,63}$/.test(env.MONGODB_DB) &&
  typeof identity.ownerId === 'string' && !!identity.ownerId &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' && !!identity.sessionVersion)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0;

async function checkPrivateFiles(folder) {
  const dir = await lstat(folder);
  if (!dir.isDirectory() || dir.isSymbolicLink() ||
      (dir.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && dir.uid !== process.getuid()))
    throw new TypeError('Private chunk directory required');
  const names = await readdir(folder);
  // The current provenance proof is bounded to 1024 notes / 16 pages.
  if (!names.length || names.length > 16 ||
      names.some((name) => !/^part-[0-9]{4}\.json$/.test(name)))
    throw new TypeError('Invalid private chunk sequence');
  names.sort();
  for (let i = 0; i < names.length; i++)
    if (names[i] !== 'part-' + String(i + 1).padStart(4, '0') + '.json')
      throw new TypeError('Incomplete chunk sequence');
  for (const name of names) {
    const file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const meta = await file.stat();
      if (!meta.isFile() || meta.size < 2 ||
          meta.size > MAX_VAULT_BACKUP_CHUNK_BYTES ||
          (meta.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && meta.uid !== process.getuid()))
        throw new TypeError('Unsafe private chunk file');
    } finally { await file.close(); }
  }
  return names;
}

async function* privateChunks(folder) {
  const names = await checkPrivateFiles(folder);
  for (const name of names) {
    const file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 2 ||
          before.size > MAX_VAULT_BACKUP_CHUNK_BYTES ||
          (before.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && before.uid !== process.getuid()))
        throw new TypeError('Unsafe private chunk file');
      const data = await file.readFile();
      const after = await file.stat();
      if (data.length !== before.size || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new TypeError('Private chunk changed while reading');
      yield JSON.parse(data.toString('utf8'));
    } finally { await file.close(); }
  }
}

let safeFiles = false;
if (allowed) {
  try { await checkPrivateFiles(directory); safeFiles = true; }
  catch { /* Report only redacted failure, no private file paths */ }
}
if (!allowed || !safeFiles) {
  console.error('BLOCKED: exact owner, private chunk files, and one explicit read-only source mode are required.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(env.MONGODB_URI, {
    appName: 'oge-vault-chunk-source-proof-read-only',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary', readConcern: { level: 'majority' },
  });
  try {
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB);
    const github = await getVaultNoteClient(db, identity, { readOnly: true });
    if (github.vault.repoId !== identity.repoId)
      throw new TypeError('Signed owner/repository scope changed');
    const ownerVerifier = async () => {
      const row = await db.collection('users').findOne({
        $and: [
          ownerMutationFilter(identity.ownerId, {
            sessionVersion: identity.sessionVersion,
          }),
          { 'vault.status': 'connected', 'vault.repoId': identity.repoId },
        ],
      }, { projection: { vault: 1 } });
      const a = row?.vault, b = github.vault;
      return a?.status === 'connected' && a.repoId === b.repoId &&
        a.installationId === b.installationId &&
        a.githubAccountId === b.githubAccountId &&
        a.githubLogin === b.githubLogin && a.repoName === b.repoName;
    };
    const proof = await verifyVaultNotesChunkGitHubSourceReadOnly(
      github, privateChunks(directory), {
        ownerVerifier, allowBoundedHistory: historyMode,
      });
    console.log(JSON.stringify(proof, null, 2));
    // Current or bounded historical proof NEVER authorizes import/retry/unlock.
    process.exitCode = 2;
  } catch (error) {
    console.error('BLOCKED: GitHub source proof unavailable (' +
      (error instanceof Error ? error.name : 'UnknownError') + ').');
    process.exitCode = 1;
  } finally { await mongo.close().catch(() => {}); }
}
