import { MongoClient } from 'mongodb';

const options = { maxPoolSize: 10, minPoolSize: 0, appName: 'oge-notes' };
let clientPromise;
let indexesPromise;

export async function getDatabase() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB || 'oge_notes';
  if (!uri) throw new Error('MONGODB_URI is not configured on the server.');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new Error('MONGODB_DB contains an invalid database name.');

  if (!globalThis.__ogeMongoClientPromise) {
    const client = new MongoClient(uri, options);
    globalThis.__ogeMongoClientPromise = client.connect().catch((error) => {
      globalThis.__ogeMongoClientPromise = undefined;
      throw error;
    });
  }
  clientPromise = globalThis.__ogeMongoClientPromise;
  const client = await clientPromise;
  const db = client.db(databaseName);

  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection('rateLimitBuckets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('users').createIndex({ googleSub: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }),
      db.collection('users').createIndex({ linkedGoogleSub: 1 }, { unique: true, partialFilterExpression: { linkedGoogleSub: { $type: 'string' } } }),
      db.collection('users').createIndex({ linkedGithubOwnerId: 1 }, { unique: true, partialFilterExpression: { linkedGithubOwnerId: { $type: 'string' } } }),
      db.collection('oauthLinkIntents').createIndex({ secretHash: 1 }, { unique: true }),
      db.collection('oauthLinkIntents').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('vaultOauthIntents').createIndex({ stateHash: 1 }, { unique: true }),
      db.collection('vaultOauthIntents').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('vaultOauthIntents').createIndex({ ownerId: 1, expiresAt: 1 }),
      db.collection('users').createIndex({ 'vault.repoId': 1 }, { unique: true, partialFilterExpression: { 'vault.repoId': { $type: 'number' } } }),
      db.collection('oauthLinkIntents').createIndex({ ownerId: 1, expiresAt: 1 }),
      db.collection('users').createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } }),
      db.collection('users').createIndex({ extensionTokenHash: 1 }, { unique: true, sparse: true }),
      // No TTL on unsynced drafts: expiry could destroy the user's only copy.
      db.collection('vault_drafts').createIndex({ ownerId: 1, repoId: 1, noteId: 1 }, { unique: true }),
      db.collection('vault_drafts').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('vault_drafts').createIndex({ ownerId: 1, repoId: 1, isNew: 1, updatedAt: -1 }),
      // E3/M71: encrypted TEMPORARY standalone Quick Notes/AirNotes drafts.
      // No TTL: an interrupted Save may leave the owner's only recovery copy.
      // Unique scope/revision CAS rejects concurrent first writes and stale tabs.
      db.collection('vault_standalone_drafts').createIndex(
        { ownerId: 1, repoId: 1, kind: 1, captureId: 1 }, { unique: true }),
      db.collection('vault_standalone_drafts').createIndex(
        { ownerId: 1, repoId: 1, kind: 1, isNew: 1, updatedAt: -1 }),
      // B7 idempotent cleanup evidence; metadata only, never note content.
      db.collection('vault_save_receipts').createIndex({ ownerId: 1, repoId: 1, noteId: 1 }, { unique: true }),
      db.collection('vault_files').createIndex({ ownerId: 1, repoId: 1, noteId: 1 }, { unique: true }),
      db.collection('vault_files').createIndex({ ownerId: 1, repoId: 1, subjectId: 1 }),
      db.collection('vault_file_index_state').createIndex({ ownerId: 1, repoId: 1 }, { unique: true }),
      db.collection('vault_file_index_state').createIndex({ state: 1, updatedAt: 1 }),
      // No TTL: an interrupted bootstrap may contain the only auditable
      // progress record. Operation-scope indexes prevent cross-owner mixing.
      db.collection('vault_file_index_bootstrap').createIndex({ ownerId: 1, repoId: 1, operationId: 1, noteId: 1 }, { unique: true }),
      db.collection('vault_file_index_bootstrap').createIndex({ ownerId: 1, repoId: 1, operationId: 1, ordinal: 1 }, { unique: true }),
      db.collection('vault_subject_inspections').createIndex({ ownerId: 1, repoId: 1, subjectId: 1, operationId: 1 }, { unique: true }),
      db.collection('vault_subject_inspections').createIndex({ state: 1, updatedAt: 1 }),
      db.collection('vault_subject_deletion_jobs').createIndex({ ownerId: 1, repoId: 1, subjectId: 1, operationId: 1 }, { unique: true }),
      db.collection('vault_subject_deletion_jobs').createIndex({ state: 1, updatedAt: 1 }),
      db.collection('notes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('notes').createIndex({ ownerId: 1, reviewDueAt: 1 }),
      db.collection('subjects').createIndex({ ownerId: 1, name: 1 }, { unique: true }),
      db.collection('quickNotes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('personalQuickNotes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('savedLinks').createIndex({ ownerId: 1, createdAt: -1 }),
      db.collection('learningTracks').createIndex({ ownerId: 1, playlistId: 1 }, { unique: true }),
      db.collection('learningTracks').createIndex({ ownerId: 1, createdAt: -1 }),
      // M99 stores only links to verified GitHub Note IDs, never Note content.
      db.collection('learningTrackNoteLinks').createIndex({ ownerId: 1, trackId: 1, videoId: 1 }, { unique: true }),
      db.collection('learningTrackNoteLinks').createIndex({ ownerId: 1, noteId: 1 }),
    ]).catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }
  await indexesPromise;
  return db;
}
