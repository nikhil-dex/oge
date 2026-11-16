import { createHash } from 'node:crypto';
import { scanVaultNotesSnapshotIndex, scanVaultNotesCommitTree } from './oge-vault-backup-export.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from './oge-vault-backup-export-chunk.js';
import { createVaultNotesChunkSequenceVerifier } from './oge-vault-backup-chunk-verifier.js';
import { MAX_VAULT_NOTE_BYTES, validatedNote } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const MAX_SOURCE_PROOF_NOTES = 1024;
const MAX_PAGES = Math.ceil(MAX_SOURCE_PROOF_NOTES / 64);
const MAX_PARALLEL_GITHUB_BLOBS = 5;
export const MAX_VAULT_SOURCE_HISTORY_STEPS = 20;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_SELECTED_NOTES = 12;
const CANONICAL_FIELDS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const digest = (note) => createHash('sha256')
  .update(JSON.stringify(CANONICAL_FIELDS.map((key) => note[key])))
  .digest('hex');

/**
 * M55 defaults to the signed, private owner Vault's CURRENT Git HEAD.
 * M56's explicit historical mode only accepts an independently proven
 * 20-step linear ancestor of that signed current HEAD; never arbitrary
 * caller-supplied revisions or local SHA-256 as GitHub authentication.
 *
 * Chunks are independently validated in full BEFORE provider access.
 * We retain only ID/SHA/content digest, never assembled note bodies.
 * Proof NEVER authorizes restore, import, lock release or retry.
 */
export async function verifyVaultNotesChunkGitHubSourceReadOnly(client, chunks, {
  ownerVerifier, allowBoundedHistory = false,
  privateSelectedIds = null,
} = {}) {
  if (typeof client?.call !== 'function' ||
      typeof client.branch !== 'string' ||
      !client.branch ||
      (!chunks || (typeof chunks[Symbol.asyncIterator] !== 'function' &&
        typeof chunks[Symbol.iterator] !== 'function')) ||
      typeof ownerVerifier !== 'function' ||
      typeof allowBoundedHistory !== 'boolean' ||
      (privateSelectedIds !== null &&
        (!Array.isArray(privateSelectedIds) ||
          privateSelectedIds.length < 1 ||
          privateSelectedIds.length > MAX_SELECTED_NOTES ||
          privateSelectedIds.some((id) =>
            typeof id !== 'string' || !UUID.test(id)) ||
          new Set(privateSelectedIds).size !== privateSelectedIds.length)))
    throw new TypeError('Signed current source GitHub Vault verification required');

  const sequence = createVaultNotesChunkSequenceVerifier();
  const metadata = [];
  let pages = 0;
  for await (const part of chunks) {
    if (++pages > MAX_PAGES || !part ||
        Buffer.byteLength(JSON.stringify(part), 'utf8') >
          MAX_VAULT_BACKUP_CHUNK_BYTES)
      throw fail('vault-chunk-source-proof-bound-exceeded', 413);
    sequence.accept(part);
    for (const note of part.notes)
      metadata.push({
        id: note.id, sha: note.sha, subjectId: note.subjectId,
        contentDigest: digest(note),
      });
    if (metadata.length > MAX_SOURCE_PROOF_NOTES)
      throw fail('vault-chunk-source-proof-bound-exceeded', 413);
  }
  let verified;
  try { verified = sequence.finish(); }
  catch { throw fail('vault-chunk-source-proof-incomplete'); }
  if (await ownerVerifier() !== true)
    throw fail('vault-chunk-source-owner-changed');

  // The ordinary M55 proof remains strictly current-HEAD-only. In the
  // separate explicit M56 historical mode, prove the snapshot is within
  // at most 20 single-parent steps of the SIGNED private branch's pinned
  // current HEAD. Never read the requested immutable commit or its blobs
  // before this ancestry proof; no arbitrary historical commit selector.
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  let pinnedHead = verified.snapshot;
  let commitsAfterSnapshot = 0;
  let index;
  if (!allowBoundedHistory) {
    index = await scanVaultNotesSnapshotIndex(client, {
      expectedHead: verified.snapshot,
    });
  } else {
    pinnedHead = (await client.call(refPath))?.object?.sha;
    if (!SHA.test(pinnedHead || ''))
      throw fail('vault-chunk-source-history-head-unavailable', 503);
    let cursor = pinnedHead;
    const visited = new Set();
    while (cursor !== verified.snapshot) {
      if (commitsAfterSnapshot >= MAX_VAULT_SOURCE_HISTORY_STEPS)
        throw fail('vault-chunk-source-history-beyond-bound');
      if (!SHA.test(cursor || '') || visited.has(cursor))
        throw fail('vault-chunk-source-history-invalid-ancestry');
      visited.add(cursor);
      const commit = await client.call('/git/commits/' + cursor);
      if (!SHA.test(commit?.tree?.sha || '') ||
          !Array.isArray(commit?.parents) || commit.parents.length !== 1)
        throw fail('vault-chunk-source-history-nonlinear-or-incomplete');
      const parent = typeof commit.parents[0] === 'string'
        ? commit.parents[0] : commit.parents[0]?.sha;
      if (!SHA.test(parent || '') || parent === cursor || visited.has(parent))
        throw fail('vault-chunk-source-history-invalid-ancestry');
      cursor = parent;
      commitsAfterSnapshot++;
    }
    index = await scanVaultNotesCommitTree(client, verified.snapshot);
  }
  if (privateSelectedIds !== null) {
    const ids = new Set(metadata.map((item) => item.id));
    if (privateSelectedIds.some((id) => !ids.has(id)))
      throw fail('vault-chunk-source-unlisted-selection');
  }
  if (index.files.length !== metadata.length)
    throw fail('vault-chunk-source-inventory-mismatch');
  for (let i = 0; i < metadata.length; i++)
    if (index.files[i].id !== metadata[i].id ||
        index.files[i].sha !== metadata[i].sha)
      throw fail('vault-chunk-source-inventory-mismatch');

  // Read only the blobs named by the VERIFIED source Git tree. Recompute
  // the actual git blob SHA-1 from raw bytes, not a self-asserted API field.
  // Then validate the OgeNotes schema and the independently supplied note
  // content digest before accepting any private source content match.
  for (let offset = 0; offset < metadata.length; offset += MAX_PARALLEL_GITHUB_BLOBS) {
    await Promise.all(metadata.slice(offset,
      offset + MAX_PARALLEL_GITHUB_BLOBS).map(async (entry) => {
      const blob = await client.call('/git/blobs/' + entry.sha);
      if (blob?.encoding !== 'base64' ||
          typeof blob.content !== 'string' ||
          blob.content.length > MAX_VAULT_NOTE_BYTES * 2)
        throw fail('vault-chunk-source-blob-invalid');
      const encoded = blob.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw fail('vault-chunk-source-blob-invalid');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > MAX_VAULT_NOTE_BYTES ||
          bytes.toString('base64') !== encoded)
        throw fail('vault-chunk-source-blob-invalid');
      const actualSha = createHash('sha1')
        .update(Buffer.from('blob ' + bytes.length + '\0'))
        .update(bytes).digest('hex');
      if (actualSha !== entry.sha)
        throw fail('vault-chunk-source-blob-hash-mismatch');
      let parsed;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        parsed = JSON.parse(text);
        const { sha, ...note } = parsed;
        if (sha !== undefined || note?.id !== entry.id ||
            JSON.stringify(validatedNote(note, {
              id: entry.id, now: note.updatedAt,
            })) !== JSON.stringify(note) ||
            !SHA.test(entry.sha))
          throw new TypeError('Invalid archived note');
      } catch {
        throw fail('vault-chunk-source-blob-content-invalid');
      }
      if (digest({ ...parsed, sha: entry.sha }) !== entry.contentDigest)
        throw fail('vault-chunk-source-content-mismatch');
    }));
  }

  if ((await client.call(refPath))?.object?.sha !== pinnedHead ||
      await ownerVerifier() !== true)
    throw fail('vault-chunk-source-session-or-head-changed');
  return {
    format: 'oge-vault-notes-chunk-github-source-proof', version: 1,
    sourceScope: allowBoundedHistory
      ? 'signed-connected-github-vault-bounded-linear-ancestor'
      : 'signed-connected-github-vault-current-head-only',
    currentSourceGitHubCommitAndAllBlobBytesVerified:
      commitsAfterSnapshot === 0,
    sourceGitHubCommitAndAllBlobBytesVerified: true,
    sourceHistoricalSnapshotVerified: commitsAfterSnapshot > 0,
    commitsAfterSnapshot,
    inventoryAndChunkSequenceVerified: true,
    verifiedNoteCount: verified.totalNotes,
    verifiedPages: verified.pages,
    privateNoteTextReturned: false,
    noteTextStoredInMongoDB: false,
    readOnly: true, canCommit: false,
    canUnlockImport: false, canRetryAutomatically: false,
    authorizesRestore: false,
    historicalSourceSnapshotsSupported: allowBoundedHistory,
    twoDeviceLiveStagingVerified: false,
    // This is PRIVATE, selected-only metadata for an in-process read-only
    // batch-intent verifier. The ordinary operator proof never returns it.
    // Do NOT print/store it or treat it as approval. It contains NO note body.
    ...(privateSelectedIds === null ? {} : {
      privateSelectionEvidence: {
        sourceSnapshot: verified.snapshot,
        sourceInventorySha256: verified.inventorySha256,
        selected: privateSelectedIds.map((id) => {
          const item = metadata.find((entry) => entry.id === id);
          return { ...item };
        }),
      },
    }),
  };
}
