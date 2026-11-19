import { createVaultNotesChunkSequenceVerifier } from './oge-vault-backup-chunk-verifier.js';
import { scanVaultNotesSnapshotIndex } from './oge-vault-backup-export.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from './oge-vault-backup-export-chunk.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const CHECK_BATCH = 100;
const MAX_NOTES = 30000;
const MAX_PAGES = Math.ceil(MAX_NOTES / 64);
const PREVIEW_ITEMS = 12;
const fail = (code, status = 409) => new VaultGitHubError(code, status);

/**
 * Phase D3b2b2c4g: read-only planning for a COMPLETE sequence of private
 * Notes-only chunks. No full-size archive is materialized, and no private
 * note text survives after verifying an individual supplied chunk.
 *
 * Important: This is NOT an import/restore capability and cannot approve
 * any GitHub write. Source SHA/digest is advisory, not proof of ownership.
 * A caller must use a signed owner-scoped Vault client, subject verifier
 * and draft checker, then separately approve any eventual create-only batch.
 */
export async function planVaultNotesChunkRestoreReadOnly(client, chunks, {
  subjectVerifier, pendingDraftIds, ownerVerifier,
} = {}) {
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      !chunks || typeof chunks[Symbol.asyncIterator] !== 'function' &&
        typeof chunks[Symbol.iterator] !== 'function' ||
      typeof subjectVerifier !== 'function' ||
      typeof pendingDraftIds !== 'function' ||
      typeof ownerVerifier !== 'function')
    throw new TypeError('Signed Vault chunk restore planning requires verified owner');

  const sequence = createVaultNotesChunkSequenceVerifier();
  const entries = [];
  const subjectIds = new Set();
  let pages = 0;
  for await (const part of chunks) {
    if (++pages > MAX_PAGES ||
        !part || typeof part !== 'object' ||
        Buffer.byteLength(JSON.stringify(part), 'utf8') >
          MAX_VAULT_BACKUP_CHUNK_BYTES)
      throw fail('vault-chunk-restore-input-too-large', 413);
    // This checks exact shape, immutable Notes schema, per-chunk digest,
    // continuity and canonical UUID order before storing metadata.
    sequence.accept(part);
    for (const note of part.notes) {
      entries.push({ id: note.id, subjectId: note.subjectId });
      subjectIds.add(note.subjectId);
    }
    if (entries.length > MAX_NOTES)
      throw fail('vault-chunk-restore-input-too-large', 413);
  }

  let proof;
  try { proof = sequence.finish(); }
  catch { throw fail('vault-chunk-restore-incomplete-or-invalid', 409); }
  // Nothing touches the destination provider until the COMPLETE supplied
  // backup has passed the source integrity checks and owner verification.
  if (await ownerVerifier() !== true)
    throw fail('vault-chunk-restore-owner-changed');
  const orderedSubjects = [...subjectIds].sort();
  for (let offset = 0; offset < orderedSubjects.length; offset += CHECK_BATCH) {
    if (await subjectVerifier(orderedSubjects.slice(offset,
      offset + CHECK_BATCH)) !== true)
      throw fail('vault-chunk-restore-subject-unverified');
  }

  const { head, refPath, files } = await scanVaultNotesSnapshotIndex(client);
  if (!SHA.test(head)) throw fail('vault-chunk-restore-target-unavailable', 503);
  const existing = new Set(files.map((file) => file.id));
  const draftConflicts = new Set();
  for (let offset = 0; offset < entries.length; offset += CHECK_BATCH) {
    const ids = entries.slice(offset, offset + CHECK_BATCH).map(({ id }) => id);
    const found = await pendingDraftIds(ids);
    const allowed = new Set(ids);
    if (!Array.isArray(found) || found.some((id) =>
      typeof id !== 'string' || !allowed.has(id) ||
      draftConflicts.has(id)) || new Set(found).size !== found.length)
      throw fail('vault-chunk-restore-draft-check-invalid');
    for (const id of found) draftConflicts.add(id);
  }
  if ((await client.call(refPath))?.object?.sha !== head)
    throw fail('vault-chunk-restore-target-head-changed');
  if (await ownerVerifier() !== true)
    throw fail('vault-chunk-restore-owner-changed');

  const summary = { total: entries.length, createCandidates: 0,
    existingConflicts: 0, draftConflicts: 0 };
  const preview = [];
  for (const { id } of entries) {
    const outcome = draftConflicts.has(id) ? 'draft-conflict' :
      existing.has(id) ? 'existing-note-conflict' : 'create-candidate';
    if (outcome === 'draft-conflict') summary.draftConflicts++;
    else if (outcome === 'existing-note-conflict') summary.existingConflicts++;
    else summary.createCandidates++;
    if (preview.length < PREVIEW_ITEMS) preview.push({ id, outcome });
  }

  return {
    format: 'oge-vault-notes-chunk-restore-plan',
    version: 1,
    sourceSnapshot: proof.snapshot,
    sourceInventorySha256: proof.inventorySha256,
    sourcePagesVerified: proof.pages,
    sourceNotesVerified: proof.totalNotes,
    targetHead: head,
    summary, preview,
    previewTruncated: entries.length > PREVIEW_ITEMS,
    readOnly: true, advisoryOnly: true,
    fullSourceVerified: true,
    sourceSequenceChecksumsVerified: true,
    sourceGitHubIdentityAuthenticated: false,
    sourceNoteBlobProvenanceVerified: false,
    sourceNotesContentReturned: false,
    sourceShaTrustedAsAuthorization: false,
    canCommit: false,
    requiresFreshOwnerApproval: true,
    changesEncryptedDrafts: false,
    createsMongoNoteBodies: false,
  };
}
