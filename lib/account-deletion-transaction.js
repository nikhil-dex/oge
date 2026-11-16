import { isCurrentSession } from './session-revocation.js';
import { withAtomicBackupImport } from './atomic-backup-import.js';

export const ACCOUNT_OWNER_COLLECTIONS = Object.freeze([
  'notes', 'subjects', 'quickNotes', 'personalQuickNotes', 'savedLinks',
]);

/**
 * Atomically delete an exact signed account incarnation and its owned records.
 * The version check prevents a delayed request from deleting a newly created
 * account with the same Google subject. Owner writes touch the user row in
 * their own transactions so concurrent mutations conflict/retry or abort.
 *
 * MongoDB replica-set transactions are mandatory. Nothing is deleted unless
 * the complete transaction commits.
 */
export async function deleteAccountDataAtomically(db, ownerId, sessionVersion) {
  if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('Account owner required');
  return withAtomicBackupImport(db, async (session) => {
    const users = db.collection('users');
    const user = await users.findOne(
      { googleSub: ownerId },
      { session, projection: { _id: 1, sessionVersion: 1, linkedGithubOwnerId: 1, vault: 1 } },
    );
    if (!isCurrentSession(user, sessionVersion)) throw new Error('Account session changed');
    // Until cross-store GitHub deletion and draft recovery are production
    // verified, refuse deleting any account with a connected/pending Vault.
    // Removing just the Oge user row would orphan the private GitHub Vault
    // mapping and could make encrypted unsynced drafts unrecoverable.
    if (user.vault && (user.vault.status === 'connected' ||
        Number.isSafeInteger(user.vault.repoId) ||
        Number.isSafeInteger(user.vault.installationId))) {
      throw new Error('Vault account deletion is disabled until safe cross-store deletion is implemented');
    }
    // Even a disconnected/legacy user row may retain the only encrypted
    // copy of an unsynced note. Abort without deleting anything.
    // MongoDB disallows concurrent operations within the same transaction
    // session; perform these conservative existence checks in sequence.
    const draftCount = await db.collection('vault_drafts').countDocuments(
      { ownerId }, { limit: 1, session });
    const indexStateCount = await db.collection('vault_file_index_state').countDocuments(
      { ownerId }, { limit: 1, session });
    const bootstrapCount = await db.collection('vault_file_index_bootstrap').countDocuments(
      { ownerId }, { limit: 1, session });
    const fileCount = await db.collection('vault_files').countDocuments(
      { ownerId }, { limit: 1, session });
    const inspectionCount = await db.collection('vault_subject_inspections').countDocuments(
      { ownerId }, { limit: 1, session });
    const deletionJobCount = await db.collection('vault_subject_deletion_jobs').countDocuments(
      { ownerId }, { limit: 1, session });
    if (draftCount || indexStateCount || bootstrapCount ||
        fileCount || inspectionCount || deletionJobCount)
      throw new Error('Vault recovery data exists: account deletion requires manual reconciliation');
    // When a GitHub account was explicitly linked into this Google-owned
    // workspace, delete its empty linking stub in the same transaction.
    // Do not leave a second sign-in identity attached to a deleted account.
    if (typeof user.linkedGithubOwnerId === 'string') {
      await users.deleteOne({
        googleSub: user.linkedGithubOwnerId,
        linkedGoogleSub: ownerId,
      }, { session });
      await db.collection('oauthLinkIntents').deleteMany({ ownerId: user.linkedGithubOwnerId }, { session });
    }
    await db.collection('oauthLinkIntents').deleteMany({ ownerId }, { session });
    // The matched owner row is deleted last, but the entire operation is
    // atomic, including credentials stored on that row.
    for (const name of ACCOUNT_OWNER_COLLECTIONS) {
      await db.collection(name).deleteMany({ ownerId }, { session });
    }
    const deleted = await users.deleteOne(
      { _id: user._id, googleSub: ownerId, sessionVersion: user.sessionVersion ?? { $exists: false } },
      { session },
    );
    if (deleted.deletedCount !== 1) throw new Error('Account deletion conflict');
    return { deleted: true };
  });
}
