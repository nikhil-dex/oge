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
 * the signed owner, not just the selected note IDs. The caller MUST invoke
 * markGitHubWriteAttempt immediately before GitHub's first possible mutation.
 * Any exception after that boundary retains the durable owner lock for
 * operator reconciliation. No expired leases or unreviewed automatic recovery.
 * An owner/session change fails closed.
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
    state: 'acquired',
  };
  const acquired = await users.updateOne({
    ...key, vaultImportLock: { $exists: false },
    $or: [{ vaultActiveDraftWriters: 0 },
      { vaultActiveDraftWriters: { $exists: false } }],
  }, { $set: { vaultImportLock: lock } });
  if (acquired.matchedCount !== 1)
    throw error('vault-import-active-draft-writers-or-import-locked');

  // Mark the exact approved GitHub write boundary DURABLY before calling the
  // GitHub batch writer. A lost MongoDB acknowledgment can leave the marker in
  // place; the subsequent acquired-state release CAS then fails closed.
  // The marker, approved target HEAD and selected UUIDs are metadata only:
  // never store the uploaded archive, heading, answer or note file text.
  let githubWriteMayHaveStarted = false;
  const markGitHubWriteAttempt = async (commitMarker, evidence) => {
    // Only immutable, non-content recovery evidence is retained in MongoDB.
    // A selected note ID is metadata; never persist heading/answer/archive.
    const ids = evidence?.selectedIds;
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (githubWriteMayHaveStarted ||
        typeof commitMarker !== 'string' ||
        !/^Restore OgeNotes backup [a-f0-9]{64}$/.test(commitMarker) ||
        typeof evidence?.expectedHead !== 'string' ||
        !/^[a-f0-9]{40}$/.test(evidence.expectedHead) ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 12 ||
        ids.some((id) => typeof id !== 'string' || !validId.test(id)) ||
        new Set(ids).size !== ids.length ||
        Object.keys(evidence).sort().join(',') !== 'expectedHead,selectedIds')
      throw new TypeError('Invalid or duplicate GitHub import attempt marker');
    const marked = await users.updateOne({
      ...key, 'vaultImportLock.operationId': operationId,
      'vaultImportLock.repoId': owner.repoId,
      'vaultImportLock.state': 'acquired',
    }, { $set: {
      'vaultImportLock.state': 'github-write-possible',
      'vaultImportLock.commitMarker': commitMarker,
      'vaultImportLock.approvedHead': evidence.expectedHead,
      'vaultImportLock.selectedIds': [...ids],
      'vaultImportLock.attemptedAt': new Date(),
    } });
    if (marked.matchedCount !== 1)
      throw new Error('vault-import-write-attempt-fence-unconfirmed');
    githubWriteMayHaveStarted = true;
  };

  let value, workError;
  try { value = await work({ markGitHubWriteAttempt }); }
  catch (failure) { workError = failure; }

  // After the remote mutation boundary, an error may represent an unobserved
  // success. Never release in the same request; demand exact owner/repository
  // reconciliation and controlled maintenance instead. Do not auto-retry.
  if (workError && githubWriteMayHaveStarted)
    throw new VaultGitHubError('vault-import-write-outcome-unconfirmed-lock-retained', 503);

  try {
    const released = await users.updateOne({
      ...key, 'vaultImportLock.operationId': operationId,
      'vaultImportLock.repoId': owner.repoId,
      'vaultImportLock.state': githubWriteMayHaveStarted
        ? 'github-write-possible' : 'acquired',
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
