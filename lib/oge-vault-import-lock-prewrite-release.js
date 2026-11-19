import { withAtomicBackupImport } from './atomic-backup-import.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deny = (reason) => new VaultGitHubError(reason, 409);

/**
 * Milestone #47: the ONLY unlock allowed by this primitive is an EXACT
 * pre-GitHub-write lock (state: acquired), never one with a possible
 * remote mutation. All GitHub writers first persist state:
 * github-write-possible using an atomic CAS before making a network write.
 *
 * Must only be called by an offline, maintenance-only, LOCAL DISPOSABLE
 * staging CLI after independent incident approval. A boolean alone does NOT
 * provide actual operator authorization and this helper is not exposed via
 * any HTTP endpoint. It cannot unlock legacy unknown-state locks.
 *
 * Transactionally CAS-clear the exact account lock and insert a metadata-only
 * audit receipt. No Note data, drafts, subjects, GitHub ref, or other account
 * fields are changed. An uncertain transaction result is NOT retried by this
 * implementation. No TTL or age threshold is used.
 */
export async function releasePreWriteVaultImportLockInStaging(db, identity, {
  incidentId, startedAt, maintenanceConfirmed = false,
  independentReviewConfirmed = false, now = new Date(),
} = {}) {
  if (!db || !db.client || typeof db.collection !== 'function' ||
      typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      !Number.isSafeInteger(identity?.repoId) || identity.repoId < 1 ||
      typeof identity?.expectedOperationId !== 'string' ||
      !UUID.test(identity.expectedOperationId) ||
      typeof incidentId !== 'string' || !UUID.test(incidentId) ||
      typeof startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAt) ||
      !Number.isFinite(Date.parse(startedAt)) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      Date.parse(startedAt) > now.getTime() ||
      maintenanceConfirmed !== true || independentReviewConfirmed !== true)
    throw new TypeError('Approved isolated-staging prewrite import recovery scope required');

  const { ownerId, repoId, expectedOperationId } = identity;
  const signed = ownerMutationFilter(ownerId, {
    sessionVersion: identity.sessionVersion,
  });
  const userFilter = { $and: [
    signed,
    { 'vault.status': 'connected', 'vault.repoId': repoId },
    {
      'vaultImportLock.operationId': expectedOperationId,
      'vaultImportLock.repoId': repoId,
      'vaultImportLock.startedAt': new Date(startedAt),
      'vaultImportLock.state': 'acquired',
    },
    { $or: [
      { vaultActiveDraftWriters: 0 },
      { vaultActiveDraftWriters: { $exists: false } },
    ] },
  ] };

  const auditId = 'vault-import-prewrite-release:' +
    ownerId + ':' + repoId + ':' + expectedOperationId;
  return withAtomicBackupImport(db, async (session) => {
    // A subject writer may still hold a deletion fence. Refuse administrative
    // release until those writers have been independently investigated.
    const subjects = await db.collection('subjects').countDocuments({
      ownerId, vaultActiveWriters: { $gt: 0 },
    }, { session, limit: 1 });
    if (subjects !== 0) throw deny('vault-import-recovery-active-subject-writers');

    const cleared = await db.collection('users').updateOne(userFilter, {
      $unset: { vaultImportLock: '' },
    }, { session });
    if (cleared.matchedCount !== 1)
      throw deny('vault-import-recovery-lock-not-exactly-prewrite');

    // One immutable audit event per owner/repo/import operation; the receipt
    // is not an authorization token and cannot resurrect or clear the lock.
    await db.collection('vault_import_lock_recovery_audit').insertOne({
      _id: auditId,
      ownerId, repoId, operationId: expectedOperationId, incidentId,
      recoveryKind: 'pre-github-write-only',
      startedAt: new Date(startedAt), reviewedAt: now,
      notesChanged: false, encryptedDraftsChanged: false,
      githubWriteProvenAbsentByMarker: true,
      operatorAttestationsExternallyVerified: false,
    }, { session });

    return {
      check: 'oge-vault-staging-prewrite-lock-recovery',
      version: 1, status: 'PREWRITE_LOCK_RELEASED',
      lockReleased: true,
      notesChanged: false, encryptedDraftsChanged: false,
      productionRecoveryAuthorized: false,
      githubMutationPerformed: false,
      incidentAuditRecorded: true,
    };
  });
}
