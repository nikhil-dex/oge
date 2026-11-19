import { withAtomicBackupImport } from './atomic-backup-import.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { draftKey } from './oge-vault-hybrid-drafts.js';
import { readVaultNote } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/i;

function receiptKey(identity) {
  return draftKey(identity?.ownerId, identity?.repoId, identity?.noteId);
}

/**
 * B7: atomically retire an EXACT encrypted draft revision and remember only
 * its GitHub evidence. If the HTTP response is lost after the transaction
 * commits, the metadata-only receipt enables a safe, read-only recheck.
 *
 * Unlike a note, this receipt contains no heading, answer, tags, or draft.
 * It is one record per note; later confirmations supersede older receipts.
 * This helper is only called after immutable GitHub content was verified.
 */
export async function retireConfirmedVaultDraftWithReceipt(db, identity, revision,
  sha, commitSha, { credential } = {}) {
  const scope = receiptKey(identity);
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      !SHA.test(sha || '') || !SHA.test(commitSha || ''))
    throw new TypeError('Invalid Vault Save confirmation receipt');
  const accountFilter = ownerMutationFilter(scope.ownerId, credential);
  return withAtomicBackupImport(db, async (session) => {
    const active = await db.collection('users').updateOne({
      ...accountFilter, 'vault.status': 'connected', 'vault.repoId': scope.repoId,
    }, { $set: { updatedAt: new Date() } }, { session });
    if (active.matchedCount !== 1)
      throw new VaultGitHubError('vault-save-receipt-session-expired', 409);

    const removed = await db.collection('vault_drafts').deleteOne({
      ...scope, revision,
    }, { session });
    if (removed.deletedCount !== 1) return false;

    await db.collection('vault_save_receipts').updateOne(scope, {
      $set: { revision, sha: sha.toLowerCase(), commitSha: commitSha.toLowerCase(),
        confirmedAt: new Date() },
      $setOnInsert: scope,
    }, { session, upsert: true });
    return true;
  });
}

/**
 * A receipt is NOT proof the note is still saved. It is trustworthy only
 * when current GitHub content is independently read and SHA-matched.
 */
export async function readConfirmedVaultSaveReceipt(db, client, identity, revision, {
  noteReader,
} = {}) {
  const scope = receiptKey(identity);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError('Invalid Vault Save receipt revision');
  if (client?.vault?.repoId !== scope.repoId)
    throw new VaultGitHubError('vault-save-receipt-repository-mismatch', 409);
  // A newer unsynced draft always overrides any older confirmation receipt.
  const pendingDraft = await db.collection('vault_drafts').findOne(scope,
    { projection: { _id: 1 } });
  if (pendingDraft) return { confirmed: false, reason: 'newer-draft-present' };
  const receipt = await db.collection('vault_save_receipts').findOne({
    ...scope, revision,
  }, { projection: { _id: 0, revision: 1, sha: 1, commitSha: 1 } });
  if (!receipt || !SHA.test(receipt.sha || '') || !SHA.test(receipt.commitSha || ''))
    return { confirmed: false, reason: 'no-confirmed-save-receipt' };

  // Never use MongoDB receipt metadata alone to report Saved.
  let note;
  try { note = await (noteReader || readVaultNote)(client, scope.noteId); }
  catch { return { confirmed: false, reason: 'github-note-unavailable' }; }
  if (note?.id !== scope.noteId || note.sha !== receipt.sha)
    return { confirmed: false, reason: 'github-note-changed' };
  const laterDraft = await db.collection('vault_drafts').findOne(scope,
    { projection: { _id: 1 } });
  if (laterDraft) return { confirmed: false, reason: 'newer-draft-present' };
  return { confirmed: true, cleared: true, alreadyCleared: true,
    revision, sha: receipt.sha, commitSha: receipt.commitSha, note };
}
