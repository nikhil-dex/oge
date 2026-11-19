import {
  validateVaultNotesImportApproval, approvedVaultImportCommitMessage,
} from './oge-vault-backup-import-commit.js';
import { reconcileApprovedVaultNotesImport } from './oge-vault-backup-import-reconcile.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (reason) => new VaultGitHubError(reason, 409);

const result = (status, data = {}) => ({
  check: 'oge-vault-import-archive-content-proof',
  version: 1, status,
  ...data,
  readOnly: true,
  githubMutationPerformed: false, mongoMutationPerformed: false,
  archivedNoteTextReturned: false,
  encryptedDraftsChanged: false,
  automaticUnlockAuthorized: false, operatorUnlockAuthorized: false,
  safeToRetryAutomatically: false,
  workerQuiescenceVerified: false,
  consistentSnapshot: false,
});

/**
 * Signed owner/repo mapping is the authority. Never accept user-provided
 * GitHub tokens or repo names, and never log full account or archive data.
 */
function vaultMatches(row, client, repoId) {
  const a = row?.vault, b = client?.vault;
  return a?.status === 'connected' && a.repoId === repoId &&
    b?.repoId === repoId &&
    a.installationId === b.installationId &&
    a.githubAccountId === b.githubAccountId &&
    a.githubLogin === b.githubLogin &&
    a.repoName === b.repoName;
}

function lockFingerprint(lock, identity, approval, marker) {
  if (!lock ||
      lock.operationId !== identity.expectedOperationId ||
      lock.repoId !== identity.repoId ||
      lock.state !== 'github-write-possible' ||
      lock.approvedHead !== approval.expectedTargetHead ||
      lock.commitMarker !== marker ||
      !Array.isArray(lock.selectedIds) ||
      JSON.stringify(lock.selectedIds) !== JSON.stringify(approval.selectedIds) ||
      !(lock.startedAt instanceof Date) ||
      !(lock.attemptedAt instanceof Date) ||
      !Number.isFinite(lock.startedAt.getTime()) ||
      !Number.isFinite(lock.attemptedAt.getTime()) ||
      lock.attemptedAt < lock.startedAt)
    return null;
  return JSON.stringify([
    lock.operationId, lock.repoId, lock.state,
    lock.approvedHead, lock.commitMarker, lock.selectedIds,
    lock.startedAt.toISOString(), lock.attemptedAt.toISOString(),
  ]);
}

/**
 * #49: Content-level operator evidence for an uncertain signed GitHub import.
 * The caller must provide the SAME approved archive and selection privately.
 *
 * The existing, independently tested reconciler checks immutable Git blobs,
 * original archive canonical bytes, entire pre/import Git tree delta, bounded
 * linear ancestry, and stable branch HEAD. We additionally pin the exact
 * owner/session/repository/operation lock BEFORE and AFTER reconciliation.
 *
 * A confirmed historical import is not proof that it is still current or
 * that the original writer stopped. NEVER use this result to automatically
 * retry a write, delete drafts, or release a durable import lock.
 */
export async function inspectVaultImportArchiveContentReadOnly(db, identity,
  client, request, {
    archiveReconciler = reconcileApprovedVaultNotesImport,
    blobReader,
  } = {}) {
  if (!db || typeof db.collection !== 'function' ||
      typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      identity.sessionVersion === undefined ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId < 1 ||
      typeof identity.expectedOperationId !== 'string' ||
      !UUID.test(identity.expectedOperationId) ||
      typeof client?.call !== 'function' || typeof client.branch !== 'string' ||
      typeof archiveReconciler !== 'function')
    throw new TypeError('Exact signed import archive inspection scope required');

  // Strict validation may parse sensitive text in process memory, but none is
  // printed, sent to MongoDB, or returned in the report.
  const approved = validateVaultNotesImportApproval(request);
  const marker = approvedVaultImportCommitMessage(approved);
  const users = db.collection('users');
  const accountScope = { $and: [
    ownerMutationFilter(identity.ownerId, { sessionVersion: identity.sessionVersion }),
    { 'vault.status': 'connected', 'vault.repoId': identity.repoId },
  ] };
  const projection = { _id: 0, vault: 1, vaultImportLock: 1 };
  const initial = await users.findOne(accountScope, { projection });
  if (!vaultMatches(initial, client, identity.repoId))
    return result('OWNER_OR_REPOSITORY_NOT_VERIFIED');
  const fingerprint = lockFingerprint(initial.vaultImportLock, identity, approved, marker);
  if (!fingerprint)
    return result('ARCHIVE_APPROVAL_OR_IMPORT_LOCK_MISMATCH');

  // Check subject ownership by exact IDs without reading any subject content.
  const subjectVerifier = async (subjectIds) => {
    for (let offset = 0; offset < subjectIds.length; offset += 100) {
      const ids = subjectIds.slice(offset, offset + 100);
      const found = await db.collection('subjects').find({
        ownerId: identity.ownerId, slug: { $in: ids },
      }, { projection: { _id: 0, slug: 1 } }).toArray();
      const owned = new Set(found.map((item) => item.slug));
      if (owned.size !== ids.length || ids.some((id) => !owned.has(id)))
        return false;
    }
    return true;
  };
  const stillSameOwnerAndLock = async () => {
    const row = await users.findOne(accountScope, { projection });
    return vaultMatches(row, client, identity.repoId) &&
      lockFingerprint(row.vaultImportLock, identity, approved, marker) === fingerprint;
  };

  // This is a bounded existence-only check: no ciphertext is materialized.
  const pendingDraft = await db.collection('vault_drafts').countDocuments({
    ownerId: identity.ownerId, repoId: identity.repoId,
    noteId: { $in: approved.selectedIds },
  }, { limit: 1 });
  if (pendingDraft !== 0 && pendingDraft !== 1)
    throw fail('vault-import-archive-draft-state-unavailable');

  const evidence = await archiveReconciler(client, request, {
    subjectVerifier, ownerVerifier: stillSameOwnerAndLock,
    ...(blobReader ? { blobReader } : {}),
  });
  if (!await stillSameOwnerAndLock())
    return result('OWNER_OR_IMPORT_LOCK_CHANGED_DURING_INSPECTION');

  if (evidence?.confirmed !== true) {
    return result('ARCHIVE_IMPORT_NOT_CONFIRMED', {
      importedContentVerified: false,
      selectedNoteCount: approved.selectedIds.length,
      matchingSelectedDraftPresent: pendingDraft === 1,
      historicalStatus: 'unconfirmed',
    });
  }
  if (evidence.importedCount !== approved.selectedIds.length ||
      !Number.isSafeInteger(evidence.commitsAfterImport) ||
      !Number.isSafeInteger(evidence.currentNotesUnchanged) ||
      !Number.isSafeInteger(evidence.currentNotesChanged) ||
      evidence.currentNotesUnchanged + evidence.currentNotesChanged !==
        approved.selectedIds.length)
    throw fail('vault-import-archive-evidence-invalid');

  return result('ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY', {
    importedContentVerified: true,
    selectedNoteCount: approved.selectedIds.length,
    commitsAfterImport: evidence.commitsAfterImport,
    currentNotesUnchanged: evidence.currentNotesUnchanged,
    currentNotesChanged: evidence.currentNotesChanged,
    matchingSelectedDraftPresent: pendingDraft === 1,
    historicalStatus: 'verified',
  });
}
