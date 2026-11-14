import { withAtomicBackupImport } from './atomic-backup-import.js';
import { ownerMutationFilter } from './active-owner-mutation.js';

/**
 * Delete a subject and its notes together, so failures cannot leave a subject
 * without its notes (or the inverse). The account write intentionally
 * conflicts with a concurrent account-deletion transaction. This is not a
 * substitute for guarding every other in-flight user mutation.
 */
export async function deleteSubjectAtomically(db, ownerId, slug, credential) {
  const accountFilter = ownerMutationFilter(ownerId, credential);
  return withAtomicBackupImport(db, async (session) => {
    const subjects = db.collection('subjects');
    const subject = await subjects.findOne({ ownerId, slug }, { session });
    if (!subject) return { status: 'not-found' };
    const count = await subjects.countDocuments({ ownerId }, { session });
    if (count <= 1) return { status: 'last-subject' };

    const account = await db.collection('users').updateOne(
      accountFilter,
      { $set: { updatedAt: new Date() } },
      { session },
    );
    if (account.matchedCount !== 1) throw new Error('Account no longer exists');

    await db.collection('notes').deleteMany({ ownerId, subjectSlug: slug }, { session });
    const deleted = await subjects.deleteOne({ _id: subject._id, ownerId, slug }, { session });
    if (deleted.deletedCount !== 1) throw new Error('Subject deletion conflicted');
    return { status: 'deleted' };
  });
}
