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
      { session, projection: { _id: 1, sessionVersion: 1 } },
    );
    if (!isCurrentSession(user, sessionVersion)) throw new Error('Account session changed');
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
