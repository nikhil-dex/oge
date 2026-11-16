import { randomUUID } from 'node:crypto';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';

const error = (reason) => new VaultGitHubError(reason, 409);
const validRepoId = (id) => Number.isSafeInteger(id) && id > 0;

function signedScope(ownerId, repoId, sessionVersion) {
  if (!validRepoId(repoId)) throw new TypeError('Invalid Vault import repository');
  // Preserve the legacy sessionVersion=0 $or when the import also adds its
  // own active-writer $or. Combining them as sibling $or keys would silently
  // overwrite the session-epoch check.
  return { $and: [
    ownerMutationFilter(ownerId, { sessionVersion }),
    { 'vault.status': 'connected', 'vault.repoId': repoId },
  ] };
}

/**
 * Owner-row rendezvous for ALL hybrid draft mutations and the create-only
 * import preview. The atomic account document is shared even when an editor
 * claims a DIFFERENT subject for the same note ID. Using only subject fences
 * would permit that cross-subject draft race.
 *
 * Counters have NO TTL. A failed release blocks import until an operator
 * verifies and repairs the account state; never auto-clear an uncertain fence.
 */
export async function withVaultOwnerDraftWrite(db, owner, work) {
  if (typeof work !== 'function') throw new TypeError('Draft work is required');
  const key = signedScope(owner.ownerId, owner.repoId, owner.sessionVersion);
  const users = db.collection('users');
  const acquired = await users.updateOne({
    ...key, vaultImportLock: { $exists: false },
  }, { $inc: { vaultActiveDraftWriters: 1 } });
  if (acquired.matchedCount !== 1) throw error('vault-import-draft-write-blocked');

  let value, workError;
  try { value = await work(); }
  catch (failure) { workError = failure; }
  try {
    const released = await users.updateOne({
      ...key, vaultActiveDraftWriters: { $gt: 0 },
    }, { $inc: { vaultActiveDraftWriters: -1 } });
    if (released.matchedCount !== 1)
      throw new Error('vault-import-draft-fence-release-unconfirmed');
  } catch (releaseError) {
    if (workError) releaseError.cause = workError;
    throw releaseError;
  }
  if (workError) throw workError;
  return value;
}

/**
 * One exclusive import per signed owner/repository. Acquire only if all
 * participating draft mutations have released the account-row writer fence.
 * Import holds the lock across the full fresh plan, GitHub CAS commit and
 * verification. Other device autosaves fail as 409 and keep local copies.
 *
 * This is deliberately conservative: it briefly blocks ALL draft writes for
 * the signed owner, not just the selected note IDs. No expired leases or
 * unreviewed automatic recovery. An owner/session change fails closed.
 */
export async function withVaultOwnerImportExclusive(db, owner, work, {
  operationId = randomUUID(),
} = {}) {
  if (typeof work !== 'function') throw new TypeError('Import work is required');
  if (typeof operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))
    throw new TypeError('Invalid import fence operation ID');
  const key = signedScope(owner.ownerId, owner.repoId, owner.sessionVersion);
  const users = db.collection('users');
  const lock = {
    operationId, repoId: owner.repoId, startedAt: new Date(),
  };
  const acquired = await users.updateOne({
    ...key, vaultImportLock: { $exists: false },
    $or: [{ vaultActiveDraftWriters: 0 },
      { vaultActiveDraftWriters: { $exists: false } }],
  }, { $set: { vaultImportLock: lock } });
  if (acquired.matchedCount !== 1)
    throw error('vault-import-active-draft-writers-or-import-locked');

  let value, workError;
  try { value = await work(); }
  catch (failure) { workError = failure; }
  try {
    // Do not release any unrelated or replaced import operation. The
    // original lock stays durable on an uncertain release.
    const released = await users.updateOne({
      ...key, 'vaultImportLock.operationId': operationId,
      'vaultImportLock.repoId': owner.repoId,
    }, { $unset: { vaultImportLock: '' } });
    if (released.matchedCount !== 1)
      throw new Error('vault-import-exclusive-fence-release-unconfirmed');
  } catch (releaseError) {
    if (workError) releaseError.cause = workError;
    throw releaseError;
  }
  if (workError) throw workError;
  return value;
}
