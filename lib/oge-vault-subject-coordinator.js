import { randomUUID } from 'node:crypto';
import { lockEmptyVaultSubject, releaseVaultSubjectPreflight } from './oge-vault-subject-fence.js';
import { inspectVaultSubject } from './oge-vault-subject-preflight.js';

/**
 * Non-destructive locked preflight for B5.3c.
 *
 * The lock prevents all subject-fenced writes while we inspect GitHub and
 * temporary drafts. The result is ADVISORY ONLY; we ALWAYS release the lock
 * after inspection. No caller may treat the result as an authorization to
 * delete later, because another writer can enter immediately after release.
 *
 * The eventual destructive coordinator must keep a durable operation ID and
 * the lock for its entire cross-store transaction/recovery. It is not enabled.
 */
export async function inspectLockedVaultSubject(db, client, identity, {
  inspector = inspectVaultSubject, operationId = randomUUID(),
} = {}) {
  const { ownerId, repoId, subjectId } = identity ?? {};
  const key = { ownerId, repoId, subjectId };
  const acquired = await lockEmptyVaultSubject(db, ownerId, subjectId, { operationId });
  if (!acquired) return { safeToDelete: false, reason: 'subject-locked-or-active',
    advisoryOnly: true };

  let inspection;
  let scanError;
  try {
    // Never rely on cached vault_files metadata or a partial GitHub listing.
    inspection = await inspector(client, db.collection('vault_drafts'), key);
  } catch (error) {
    scanError = error;
  }

  try {
    await releaseVaultSubjectPreflight(db, ownerId, subjectId, operationId);
  } catch (releaseError) {
    if (scanError) releaseError.cause = scanError;
    // An uncertain lock release must never be represented as an empty subject.
    throw releaseError;
  }
  if (scanError) throw scanError;
  return { ...inspection, advisoryOnly: true };
}
