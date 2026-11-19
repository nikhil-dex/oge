import { createHash } from 'node:crypto';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { withVaultOwnerImportExclusive } from './oge-vault-import-fence.js';
import { withVaultSubjectsWrite } from './oge-vault-subject-fence.js';
import { readVaultNoteBlob, MAX_VAULT_BATCH_ITEMS } from './oge-vault-notes.js';
import {
  prepareVaultChunkRestoreBatchIntentReadOnly,
  validateVaultChunkRestoreBatchSelection,
} from './oge-vault-backup-chunk-restore-batch-intent.js';
import { executeApprovedVaultNotesImport } from './oge-vault-backup-import-commit.js';
import { commitVaultNoteBatch } from './oge-vault-batch.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONFIRMATION = 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY';
const EXACT_FIELDS = [
  'confirmation', 'expectedSelectionFingerprint', 'expectedSourceSnapshot',
  'expectedSourceInventorySha256', 'expectedTargetHead', 'selectedIds',
].sort();
const COVERAGE = Object.freeze({
  notes: 'complete-at-snapshot',
  historicalRevisions: 'not-included',
  quickNotes: 'not-included',
  airNotes: 'not-included',
  encryptedDrafts: 'not-included',
  learningProgress: 'not-included',
});
const NOTE_FIELDS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);
const digest = (note) => createHash('sha256').update(
  JSON.stringify(NOTE_FIELDS.map((key) => note[key])),
  'utf8').digest('hex');

/**
 * A NEW, distinct confirmation, never the read-only M57 preview and never
 * the ordinary one-shot archive approval. The fingerprint is not a signed
 * bearer token: it is a value the owner must have independently reviewed.
 * The executor re-derives the fingerprint AND every source blob under the
 * exclusive owner fence before it may make the first GitHub mutation.
 */
export function validateVaultChunkRestoreCommitApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXACT_FIELDS) ||
      value.confirmation !== CONFIRMATION ||
      !DIGEST.test(value.expectedSelectionFingerprint || ''))
    throw fail('vault-chunk-restore-approval-invalid', 400);
  const selected = validateVaultChunkRestoreBatchSelection({
    confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH',
    expectedSourceSnapshot: value.expectedSourceSnapshot,
    expectedSourceInventorySha256: value.expectedSourceInventorySha256,
    expectedTargetHead: value.expectedTargetHead,
    selectedIds: value.selectedIds,
  });
  return { ...selected,
    expectedSelectionFingerprint: value.expectedSelectionFingerprint };
}

function stagingGate(env) {
  return env?.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW === 'true' &&
    env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW === 'true' &&
    env.OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW === 'true' &&
    env.OGE_VAULT_CHUNK_RESTORE_WRITE_ACK ===
      'YES_DISPOSABLE_SIGNED_STAGING_ONLY';
}

/**
 * M58 SINGLE BATCH restore executor — no HTTP entrypoint, and disabled by
 * default. The caller must supply a trusted signed owner DB and a private
 * GitHub write client. Source/destination are the SAME signed Vault.
 *
 * 1. Acquire the *existing* durable owner-exclusive import fence first,
 *    blocking all competing device autosaves.
 * 2. Reverify the complete bounded historic source (<=1024 Notes, 20 linear
 *    commits), match the owner-reviewed <=12-note SHA-256 intent, and reread
 *    only selected immutable source blobs.
 * 3. Acquire ALL selected subject locks. Re-run ordinary create-only import
 *    planning/owner/draft checks against the exact current target HEAD.
 * 4. Reuse the existing durable before-GitHub-write marker and real CAS
 *    batch writer; failed/ambiguous writes retain the owner quarantine.
 *
 * No implicit multi-batch loop, retry, automatic lock repair, saved archive
 * body, or draft retirement. An interrupted import MUST be reconciled by
 * a separately authorized operator workflow.
 */
export async function executeApprovedVaultChunkRestoreBatch(
  db, owner, client, chunks, request, {
    env = process.env,
    batchWriter = commitVaultNoteBatch,
  } = {},
) {
  if (!stagingGate(env))
    throw fail('vault-chunk-restore-commit-disabled', 404);
  const approved = validateVaultChunkRestoreCommitApproval(request);
  if (!db || typeof db.collection !== 'function' ||
      !owner || typeof owner.ownerId !== 'string' || !owner.ownerId ||
      !(Number.isSafeInteger(owner.repoId) && owner.repoId > 0) ||
      (typeof owner.sessionVersion !== 'string' &&
        owner.sessionVersion !== 0) ||
      typeof client?.call !== 'function' ||
      client.vault?.repoId !== owner.repoId ||
      client.vault?.status !== 'connected' ||
      typeof batchWriter !== 'function' ||
      !chunks || (typeof chunks[Symbol.iterator] !== 'function' &&
        typeof chunks[Symbol.asyncIterator] !== 'function') ||
      approved.selectedIds.length > MAX_VAULT_BATCH_ITEMS)
    throw new TypeError('Signed private Vault restore context required');

  const users = db.collection('users');
  const drafts = db.collection('vault_drafts');
  const subjects = db.collection('subjects');
  const ownerVerifier = async () => {
    const row = await users.findOne(ownerMutationFilter(owner.ownerId, {
      sessionVersion: owner.sessionVersion,
    }), { projection: { vault: 1 } });
    const current = row?.vault, expected = client.vault;
    return current?.status === 'connected' &&
      current.repoId === owner.repoId &&
      current.repoId === expected.repoId &&
      current.installationId === expected.installationId &&
      current.githubAccountId === expected.githubAccountId &&
      current.githubLogin === expected.githubLogin &&
      current.repoName === expected.repoName;
  };
  const subjectVerifier = async (ids) => {
    const found = await subjects.find({
      ownerId: owner.ownerId, slug: { $in: ids },
    }, { projection: { _id: 0, slug: 1 } }).toArray();
    const seen = new Set(found.map((row) => row.slug));
    return seen.size === ids.length && ids.every((id) => seen.has(id));
  };
  const pendingDraftIds = async (ids) => {
    const found = await drafts.find({
      ownerId: owner.ownerId, repoId: owner.repoId,
      noteId: { $in: ids },
    }, { projection: { _id: 0, noteId: 1 } }).toArray();
    return found.map((row) => row.noteId);
  };

  return withVaultOwnerImportExclusive(db, owner,
    async ({ markGitHubWriteAttempt }) => {
      let selectedEvidence = null;
      const intent = await prepareVaultChunkRestoreBatchIntentReadOnly(
        client, chunks, {
          confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH',
          selectedIds: approved.selectedIds,
          expectedSourceSnapshot: approved.expectedSourceSnapshot,
          expectedSourceInventorySha256:
            approved.expectedSourceInventorySha256,
          expectedTargetHead: approved.expectedTargetHead,
        }, {
          ownerVerifier, subjectVerifier, pendingDraftIds,
          onVerifiedPrivateSelection: (verified) => {
            selectedEvidence = verified;
          },
        });

      if (!intent.eligibleForIndependentApproval ||
          !intent.signedSourceGitBlobProofVerified ||
          intent.selectedNoteCount !== approved.selectedIds.length ||
          intent.selectionFingerprint !== approved.expectedSelectionFingerprint ||
          intent.targetHead !== approved.expectedTargetHead ||
          !Array.isArray(selectedEvidence) ||
          selectedEvidence.length !== approved.selectedIds.length)
        throw fail('vault-chunk-restore-batch-conflict-or-unapproved');

      // M55/M56 already verified the entire source, its Git ancestry and
      // every raw blob. Read the small selected subset once more, checking
      // exact SHA, immutable canonical content digest and subject again.
      // No private note text is returned to the client until the actual
      // GitHub write has been verified by the reused ordinary executor.
      const chosen = [];
      for (let i = 0; i < selectedEvidence.length; i++) {
        const item = selectedEvidence[i];
        if (item.id !== approved.selectedIds[i] ||
            !SHA.test(item.sha || '') || !DIGEST.test(item.contentDigest || ''))
          throw fail('vault-chunk-restore-source-selection-changed');
        const note = await readVaultNoteBlob(client, item.id, item.sha);
        if (note.id !== item.id || note.sha !== item.sha ||
            note.subjectId !== item.subjectId ||
            digest(note) !== item.contentDigest)
          throw fail('vault-chunk-restore-source-content-changed');
        chosen.push(note);
      }

      if (!await ownerVerifier())
        throw fail('vault-chunk-restore-owner-changed');
      const subjectIds = [...new Set(chosen.map(
        (note) => note.subjectId))].sort();
      return withVaultSubjectsWrite(db, owner.ownerId, subjectIds,
        async () => {
          // Reuse the *ordinary* fully verified 12-note archive import,
          // but only after the new source-fingerprint approval. It always
          // performs fresh create-only GitHub/draft/subject and owner checks.
          const smallArchive = {
            format: 'oge-vault-notes-backup',
            version: 1, scope: 'current-github-notes-only',
            snapshot: approved.expectedSourceSnapshot,
            totalNotes: chosen.length,
            coverage: { ...COVERAGE },
            notes: chosen,
          };
          const result = await executeApprovedVaultNotesImport(client, {
            archive: smallArchive,
            expectedTargetHead: approved.expectedTargetHead,
            selectedIds: approved.selectedIds,
            confirmation: 'IMPORT_SELECTED_NEW_NOTES',
          }, {
            subjectVerifier, pendingDraftIds, ownerVerifier,
            beforeGitHubWrite: markGitHubWriteAttempt,
            batchWriter,
          });
          return {
            format: 'oge-vault-chunk-restore-batch-result',
            version: 1, commitSha: result.commitSha,
            restoredIds: result.importedIds,
            restoredCount: result.importedCount,
            remainingSourceNotes: intent.sourceNotesCount -
              result.importedCount,
            overwritePerformed: false, encryptedDraftsChanged: false,
            singleBatchOnly: true, nextBatchAutoStarted: false,
            sourceSnapshot: approved.expectedSourceSnapshot,
            selectionFingerprint: intent.selectionFingerprint,
          };
        });
    });
}
