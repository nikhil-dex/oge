#!/usr/bin/env node
/**
 * M54: explicit local operator read-only restore planning for private
 * downloaded Notes chunk files. No chunk/notes plaintext is logged, sent
 * to MongoDB, written to GitHub or converted to an import authorization.
 */
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MongoClient } from 'mongodb';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from '../lib/oge-vault-backup-export-chunk.js';
import { planVaultNotesChunkRestoreReadOnly } from '../lib/oge-vault-backup-chunk-restore-plan.js';
import {
  prepareVaultChunkRestoreBatchIntentReadOnly,
  validateVaultChunkRestoreBatchSelection,
} from '../lib/oge-vault-backup-chunk-restore-batch-intent.js';

const env = process.env;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
};
const directory = env.OGE_VAULT_CHUNK_PLAN_DIRECTORY;
const ordinaryPlanMode = env.OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY ===
  'YES_VERIFIED_NOTES_CHUNKS_ONLY';
const batchIntentMode = env.OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY ===
  'YES_EXACT_VERIFIED_SELECTION_ONLY';
const selectionFile = env.OGE_VAULT_CHUNK_BATCH_SELECTION_FILE;
const allowed = ordinaryPlanMode !== batchIntentMode &&
  (!env.OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY || ordinaryPlanMode) &&
  (!env.OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY || batchIntentMode) &&
  (!batchIntentMode ||
    (typeof selectionFile === 'string' && isAbsolute(selectionFile))) &&
  typeof directory === 'string' && isAbsolute(directory) &&
  typeof env.MONGODB_URI === 'string' && !!env.MONGODB_URI &&
  typeof env.MONGODB_DB === 'string' &&
  /^[a-zA-Z0-9_-]{1,63}$/.test(env.MONGODB_DB) &&
  typeof identity.ownerId === 'string' && !!identity.ownerId &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' && !!identity.sessionVersion)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0;

async function checkPrivateChunkDirectory(folder) {
  const dir = await lstat(folder);
  if (!dir.isDirectory() || dir.isSymbolicLink() ||
      (dir.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && dir.uid !== process.getuid()))
    throw new TypeError('Not a private owned chunk directory');
  const names = await readdir(folder);
  // No unlisted/hidden content, symlinks, gaps or duplicate parts allowed.
  if (!names.length || names.length > 469 ||
      names.some((name) => !/^part-[0-9]{4}\.json$/.test(name)))
    throw new TypeError('Invalid chunk sequence directory');
  names.sort();
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== 'part-' + String(i + 1).padStart(4, '0') + '.json')
      throw new TypeError('Missing or unnumbered private chunk part');
  }
  for (const name of names) {
    const file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 2 ||
          stat.size > MAX_VAULT_BACKUP_CHUNK_BYTES ||
          (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
        throw new TypeError('Unsafe private chunk file');
    } finally { await file.close(); }
  }
  return names;
}

async function* readPrivateChunkDirectory(folder) {
  const names = await checkPrivateChunkDirectory(folder);
  for (const name of names) {
    const file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const start = await file.stat();
      if (!start.isFile() || start.size < 2 ||
          start.size > MAX_VAULT_BACKUP_CHUNK_BYTES ||
          (start.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && start.uid !== process.getuid()))
        throw new TypeError('Unsafe private chunk file');
      const bytes = await file.readFile();
      const finish = await file.stat();
      if (bytes.length !== start.size || start.ino !== finish.ino ||
          start.size !== finish.size || start.mtimeMs !== finish.mtimeMs)
        throw new TypeError('Private chunk file changed while reading');
      yield JSON.parse(bytes.toString('utf8'));
    } finally { await file.close(); }
  }
}

let privateFilesReady = false;
if (allowed) {
  try {
    // Reject world-readable, symlinked or missing parts before creating
    // GitHub credentials or opening the MongoDB connection.
    const paths = await checkPrivateChunkDirectory(directory);
    if (batchIntentMode && paths.length > 16)
      throw new TypeError('Batch intent supports a maximum of 16 private chunks');
    privateFilesReady = true;
  } catch { /* sanitized failure below; never print paths or note text */ }
}
async function readPrivateSelectionFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > 4096 ||
        (before.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && before.uid !== process.getuid()))
      throw new TypeError('Invalid private selection');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new TypeError('Private selection changed');
    const selection = JSON.parse(bytes.toString('utf8'));
    validateVaultChunkRestoreBatchSelection(selection);
    return selection;
  } finally { await handle.close(); }
}

let privateSelection = null;
if (allowed && privateFilesReady && batchIntentMode) {
  try {
    privateSelection = await readPrivateSelectionFile(selectionFile);
  } catch { privateFilesReady = false; }
}
if (!allowed || !privateFilesReady) {
  console.error('BLOCKED: exact owner/database scope, private chunk files, and exclusive read-only operator consent (with private selection file when required) are needed.');
  process.exitCode = 1;
} else {
  const mongo = new MongoClient(env.MONGODB_URI, {
    appName: 'oge-vault-chunk-restore-plan-read-only',
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2,
    readPreference: 'primary', readConcern: { level: 'majority' },
  });
  try {
    // Unlike the previous source file iterator, this operation needs an
    // owner-scoped database reader. Nothing may write to the account/drafts.
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB);
    const github = await getVaultNoteClient(db, identity, { readOnly: true });
    if (github.vault.repoId !== identity.repoId)
      throw new TypeError('Signed repository scope changed');
    const ownerVerifier = async () => {
      const row = await db.collection('users').findOne(
        { $and: [
          ownerMutationFilter(identity.ownerId, {
            sessionVersion: identity.sessionVersion }),
          { 'vault.status': 'connected', 'vault.repoId': identity.repoId },
        ] }, { projection: { vault: 1 } });
      const v = row?.vault, expected = github.vault;
      return v?.status === 'connected' && v.repoId === expected.repoId &&
        v.installationId === expected.installationId &&
        v.githubAccountId === expected.githubAccountId &&
        v.githubLogin === expected.githubLogin &&
        v.repoName === expected.repoName;
    };
    const checks = {
        ownerVerifier,
        subjectVerifier: async (ids) => {
          const rows = await db.collection('subjects').find({
            ownerId: identity.ownerId, slug: { $in: ids },
          }, { projection: { _id: 0, slug: 1 } }).toArray();
          const owned = new Set(rows.map(({ slug }) => slug));
          return ids.length === owned.size && ids.every((id) => owned.has(id));
        },
        pendingDraftIds: async (ids) => {
          const rows = await db.collection('vault_drafts').find({
            ownerId: identity.ownerId, repoId: identity.repoId,
            noteId: { $in: ids },
          }, { projection: { _id: 0, noteId: 1 } }).toArray();
          return rows.map(({ noteId }) => noteId);
        },
      };
    const plan = batchIntentMode
      ? await prepareVaultChunkRestoreBatchIntentReadOnly(
        github, readPrivateChunkDirectory(directory), privateSelection, checks)
      : await planVaultNotesChunkRestoreReadOnly(
        github, readPrivateChunkDirectory(directory), checks);
    console.log(JSON.stringify(plan, null, 2));
    // Even a verified, conflict-free selection is NEVER import approval.
    process.exitCode = 2;
  } catch (error) {
    console.error('BLOCKED: private chunk restore planning failed (' +
      (error instanceof Error ? error.name : 'UnknownError') + ').');
    process.exitCode = 1;
  } finally {
    await mongo.close().catch(() => {});
  }
}
