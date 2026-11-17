import { ownerMutationFilter } from './active-owner-mutation.js';

/**
 * M78 exact signed-owner/repository READ-ONLY data readers shared by E9
 * forensic inspection and E10 quarantine review.
 *
 * No dynamic Mongo collection names, note body/decrypted draft reads,
 * account updates, or user-selected repository credentials.
 */
export function standaloneRestoreIncidentReaders(db, identity, readClient) {
  if (!db || typeof db.collection !== 'function' ||
      typeof identity?.ownerId !== 'string' || !identity.ownerId ||
      !Number.isSafeInteger(readClient?.vault?.repoId) ||
      readClient?.readOnly !== true)
    throw new TypeError('Signed read-only incident scope required');

  const ownerId = identity.ownerId, repoId = readClient.vault.repoId;
  const installationId = readClient.vault.installationId;
  const scopedOwner = {
    $and: [
      ownerMutationFilter(ownerId, { sessionVersion: identity.sessionVersion }),
      {
        'vault.status': 'connected', 'vault.repoId': repoId,
        'vault.installationId': installationId,
        'vault.githubAccountId': readClient.vault.githubAccountId,
        'vault.githubLogin': readClient.vault.githubLogin,
        'vault.repoName': readClient.vault.repoName,
      },
    ],
  };
  const lockReader = async () => {
    const row = await db.collection('users').findOne(scopedOwner, {
      projection: {
        _id: 0, vaultImportLock: 1, vaultActiveDraftWriters: 1,
      },
    });
    return row ? {
      lock: row.vaultImportLock,
      activeDraftWriters: row.vaultActiveDraftWriters,
    } : null;
  };
  const receiptReader = async (approvalHash) =>
    db.collection('vault_standalone_restore_approvals').find({
      ownerId, repoId, installationId,
      sessionVersion: identity.sessionVersion,
      approvalHash, state: { $in: ['claimed', 'confirmed'] },
    }, { projection: {
      _id: 0, nonceHash: 1, approvalHash: 1, state: 1,
    } }).limit(2).toArray();
  const count = async (collection, filter) => {
    const number = await db.collection(collection).countDocuments(
      filter, { limit: 2 });
    if (!Number.isSafeInteger(number) || number < 0 || number > 2)
      throw new TypeError('Invalid bounded recovery incident count');
    return number;
  };
  const auxiliaryReader = async () => ({
    activeSubjectWriters: await count('subjects', {
      ownerId, vaultActiveWriters: { $gt: 0 },
    }),
    pendingNoteDrafts: await count('vault_drafts', {
      ownerId, repoId,
    }),
    pendingStandaloneDrafts: await count('vault_standalone_drafts', {
      ownerId, repoId,
    }),
    unresolvedStandaloneReceipts: await count(
      'vault_standalone_restore_approvals', {
        ownerId, repoId, installationId, state: 'claimed',
      }),
  });
  return { lockReader, receiptReader, auxiliaryReader };
}
