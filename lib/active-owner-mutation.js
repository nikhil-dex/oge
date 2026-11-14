import { withAtomicBackupImport } from './atomic-backup-import.js';

/**
 * Link each owner-scoped INSERT to a write on its owning account in the
 * same transaction. Deleting the account touches/deletes the same user row,
 * so concurrent creation and deletion cannot both commit independently.
 *
 * Callers MUST pass the session to every MongoDB operation in the callback.
 * This does not cover other routes until they adopt the helper.
 */
export async function withActiveOwnerMutation(db, ownerId, work) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error('Owner is required');
  }
  return withAtomicBackupImport(db, async (session) => {
    const account = await db.collection('users').updateOne(
      { googleSub: ownerId },
      { $set: { updatedAt: new Date() } },
      { session },
    );
    if (account.matchedCount !== 1) throw new Error('Account no longer exists');
    return work(session);
  });
}
