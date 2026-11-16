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

const env = process.env;
const identity = {
  ownerId: env.OGE_VAULT_INSPECT_OWNER_ID,
  sessionVersion: env.OGE_VAULT_INSPECT_SESSION_VERSION === '0'
    ? 0 : env.OGE_VAULT_INSPECT_SESSION_VERSION,
  repoId: Number(env.OGE_VAULT_INSPECT_REPO_ID),
};
const directory = env.OGE_VAULT_CHUNK_PLAN_DIRECTORY;
const allowed = env.OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY ===
    'YES_VERIFIED_NOTES_CHUNKS_ONLY' &&
  typeof directory === 'string' && isAbsolute(directory) &&
  typeof env.MONGODB_URI === 'string' && !!env.MONGODB_URI &&
  typeof env.MONGODB_DB === 'string' &&
  /^[a-zA-Z0-9_-]{1,63}$/.test(env.MONGODB_DB) &&
  typeof identity.ownerId === 'string' && !!identity.ownerId &&
  (identity.sessionVersion === 0 ||
    (typeof identity.sessionVersion === 'string' && !!identity.sessionVersion)) &&
  Number.isSafeInteger(identity.repoId) && identity.repoId > 0;

async function* readPrivateChunkDirectory(folder) {
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

if (!allowed) {
  console.error('BLOCKED: exact signed owner/repo/database, private chunk directory and explicit read-only acknowledgment required.');
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
    const plan = await planVaultNotesChunkRestoreReadOnly(
      github, readPrivateChunkDirectory(directory), {
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
      });
    console.log(JSON.stringify(plan, null, 2));
    // Even a complete source and zero conflicts is NOT import approval.
    process.exitCode = 2;
  } catch (error) {
    console.error('BLOCKED: private chunk restore planning failed (' +
      (error instanceof Error ? error.name : 'UnknownError') + ').');
    process.exitCode = 1;
  } finally {
    await mongo.close().catch(() => {});
  }
}
