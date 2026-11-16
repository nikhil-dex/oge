import { createHash } from 'node:crypto';
import { scanVaultNotesSnapshotIndex } from './oge-vault-backup-export.js';
import { MAX_VAULT_BACKUP_CHUNK_BYTES } from './oge-vault-backup-export-chunk.js';
import { createVaultNotesChunkSequenceVerifier } from './oge-vault-backup-chunk-verifier.js';
import { MAX_VAULT_NOTE_BYTES, validatedNote } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const MAX_SOURCE_PROOF_NOTES = 1024;
const MAX_PAGES = Math.ceil(MAX_SOURCE_PROOF_NOTES / 64);
const MAX_PARALLEL_GITHUB_BLOBS = 5;
const SHA = /^[a-f0-9]{40}$/;
const CANONICAL_FIELDS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const digest = (note) => createHash('sha256')
  .update(JSON.stringify(CANONICAL_FIELDS.map((key) => note[key])))
  .digest('hex');

/**
 * Only the already signed, private owner Vault's CURRENT Git HEAD is
 * eligible for M55 provenance. Never fetch an arbitrary caller-supplied
 * revision or accept chunk hashes as a GitHub repository signature.
 *
 * The supplied chunks are independently validated in full before any
 * GitHub request. In memory we retain only id/SHA/content-digest metadata,
 * never assembled note bodies. This proof does NOT authorize importing.
 */
export async function verifyVaultNotesChunkGitHubSourceReadOnly(client, chunks, {
  ownerVerifier,
} = {}) {
  if (typeof client?.call !== 'function' ||
      typeof client.branch !== 'string' ||
      !client.branch ||
      (!chunks || (typeof chunks[Symbol.asyncIterator] !== 'function' &&
        typeof chunks[Symbol.iterator] !== 'function')) ||
      typeof ownerVerifier !== 'function')
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
      metadata.push({ id: note.id, sha: note.sha, contentDigest: digest(note) });
    if (metadata.length > MAX_SOURCE_PROOF_NOTES)
      throw fail('vault-chunk-source-proof-bound-exceeded', 413);
  }
  let verified;
  try { verified = sequence.finish(); }
  catch { throw fail('vault-chunk-source-proof-incomplete'); }
  if (await ownerVerifier() !== true)
    throw fail('vault-chunk-source-owner-changed');

  // The scanner validates the FULL tree, canonical paths, uniqueness and
  // trusted SHA refs. The desired snapshot must be the signed repo's
  // current HEAD (no unproven historical revision interpretation).
  const index = await scanVaultNotesSnapshotIndex(client, {
    expectedHead: verified.snapshot,
  });
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

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  if ((await client.call(refPath))?.object?.sha !== verified.snapshot ||
      await ownerVerifier() !== true)
    throw fail('vault-chunk-source-session-or-head-changed');
  return {
    format: 'oge-vault-notes-chunk-github-source-proof', version: 1,
    sourceScope: 'signed-connected-github-vault-current-head-only',
    currentSourceGitHubCommitAndAllBlobBytesVerified: true,
    inventoryAndChunkSequenceVerified: true,
    verifiedNoteCount: verified.totalNotes,
    verifiedPages: verified.pages,
    privateNoteTextReturned: false,
    noteTextStoredInMongoDB: false,
    readOnly: true, canCommit: false,
    canUnlockImport: false, canRetryAutomatically: false,
    authorizesRestore: false,
    historicalSourceSnapshotsSupported: false,
    twoDeviceLiveStagingVerified: false,
  };
}
