import { withAtomicBackupImport } from './atomic-backup-import.js';

/**
 * A Google subject can be reused after a user deletes and recreates an account.
 * Fence each mutation to the exact signed JWT session version (or a validated
 * browser-extension token) rather than only the stable Google subject.
 *
 * Cookie-authenticated callers must provide a version read from Auth.js.
 * Extension callers must provide a token hash validated inside this
 * transaction. No unauthenticated fallback is permitted.
 */
export function ownerMutationFilter(ownerId, credential) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) throw new TypeError('Owner is required');
  if (credential && typeof credential === 'object' && typeof credential.extensionTokenHash === 'string' &&
      /^[a-f0-9]{64}$/i.test(credential.extensionTokenHash)) {
    return {
      googleSub: ownerId,
      extensionTokenHash: credential.extensionTokenHash,
      extensionTokenExpiresAt: { $gt: new Date() },
    };
  }
  const version = credential?.sessionVersion;
  if (version === 0) {
    // Existing accounts created before session-version rollout have no version.
    return { googleSub: ownerId, $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] };
  }
  if (typeof version === 'string' && /^[a-f0-9-]{36}$/i.test(version)) {
    return { googleSub: ownerId, sessionVersion: version };
  }
  throw new TypeError('Signed session version or verified extension token is required');
}

export async function withActiveOwnerMutation(db, ownerId, work, credential) {
  const filter = ownerMutationFilter(ownerId, credential);
  return withAtomicBackupImport(db, async (session) => {
    const account = await db.collection('users').updateOne(
      filter,
      { $set: { updatedAt: new Date() } },
      { session },
    );
    if (account.matchedCount !== 1) throw new Error('Account session no longer exists');
    return work(session);
  });
}
