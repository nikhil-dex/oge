import { buildVaultRestoreReviewApproval } from './oge-vault-restore-review.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_PARTS = 16;
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_NOTES = 1024;
const MAX_NOTE_BYTES = 32 * 1024;
const NOTE_KEYS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer', 'tags',
  'favorite', 'updatedAt', 'createdAt', 'sha',
].sort().join(',');
const CHUNK_KEYS = [
  'format', 'version', 'scope', 'snapshot', 'totalNotes',
  'inventorySha256', 'offset', 'count', 'afterId', 'nextAfterId',
  'hasMore', 'coverage', 'notes', 'chunkSha256', 'completeBackup',
  'importableAsLegacyBackup',
].sort().join(',');
const COVERAGE_KEYS = [
  'notes', 'historicalRevisions', 'quickNotes', 'airNotes',
  'encryptedDrafts', 'learningProgress',
].sort().join(',');
const FINGERPRINT_KEYS = [
  'format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha',
];
const encoder = new TextEncoder();
const reject = () => {
  throw new TypeError('Private chunk integrity mismatch. Do not request a restore receipt.');
};
async function sha256(value, subtle) {
  const digest = await subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}
function canonicalNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note) ||
      Object.keys(note).sort().join(',') !== NOTE_KEYS ||
      note.format !== 'ogenotes-note' || note.version !== 1 ||
      !UUID.test(note.id || '') || !UUID.test(note.subjectId || '') ||
      !SHA.test(note.sha || '') ||
      typeof note.heading !== 'string' ||
      note.heading.length < 1 || note.heading.length > 160 ||
      note.heading !== note.heading.trim() ||
      typeof note.answer !== 'string' ||
      note.answer.length < 1 || note.answer.length > 20000 ||
      note.answer !== note.answer.trim() ||
      typeof note.favorite !== 'boolean' ||
      typeof note.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(note.updatedAt)) ||
      typeof note.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(note.createdAt)) ||
      !Array.isArray(note.tags) || note.tags.length > 10 ||
      note.tags.some((tag) => typeof tag !== 'string' ||
        !tag || tag.length > 40 || tag !== tag.trim().toLowerCase()) ||
      new Set(note.tags).size !== note.tags.length)
    reject();
  const savedNote = { ...note };
  delete savedNote.sha;
  if (encoder.encode(JSON.stringify(savedNote)).byteLength > MAX_NOTE_BYTES ||
      encoder.encode(JSON.stringify(note)).byteLength > MAX_NOTE_BYTES + 80)
    reject();
  // The server's validatedNote writes keys in exactly this canonical
  // order. Do not mistake a self-declared SHA for GitHub authentication.
  if (Object.keys(note).join(',') !== FINGERPRINT_KEYS.join(','))
    reject();
}
function canonicalCoverage(coverage) {
  return Boolean(coverage && typeof coverage === 'object' &&
    !Array.isArray(coverage) &&
    Object.keys(coverage).sort().join(',') === COVERAGE_KEYS &&
    coverage.notes === 'partial-immutable-snapshot-chunk' &&
    Object.entries(coverage).every(([key, value]) =>
      key === 'notes' || value === 'not-included'));
}
/**
 * M63 client-only, memory-bounded integrity preflight. File contents and
 * selected canonical note digests stay in ephemeral browser memory.
 * No fetch, database, storage or GitHub authentication takes place here.
 *
 * Unlike the M55–M57 trusted server proof, this check CANNOT establish
 * GitHub ownership or that a claimed Git commit holds these exact bytes.
 * The M58 operator still verifies ALL blobs with its signed App client.
 */
// Shared read-only browser validators. These never authenticate provider identity.
export {
  sha256 as vaultBrowserSha256,
  canonicalNote as validateVaultBrowserCanonicalNote,
  canonicalCoverage as isVaultBrowserChunkCoverage,
};

export async function verifyVaultRestoreLocalChunkFiles(files, review, {
  subtle = globalThis.crypto?.subtle,
} = {}) {
  const selected = buildVaultRestoreReviewApproval(review);
  if (!subtle || typeof subtle.digest !== 'function' ||
      !files || typeof files.length !== 'number' ||
      files.length < 1 || files.length > MAX_PARTS)
    reject();
  const ordered = Array.from(files).sort((a, b) =>
    String(a?.name).localeCompare(String(b?.name), 'en'));
  for (let i = 0; i < ordered.length; i++) {
    const file = ordered[i];
    if (file?.name !== 'part-' + String(i + 1).padStart(4, '0') + '.json' ||
        !Number.isSafeInteger(file.size) || file.size < 2 ||
        file.size > MAX_PART_BYTES ||
        typeof file.arrayBuffer !== 'function')
      reject();
  }
  const selectedIds = new Set(selected.selectedIds);
  const selectedMetadata = new Map();
  let sourceSnapshot = null, inventorySha = null, totalNotes = null;
  let received = 0, pages = 0, cursor = null, finished = false;
  let inventoryInput = 'oge-vault-notes-inventory-v1\n';
  for (const file of ordered) {
    if (finished) reject();
    let chunk;
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_PART_BYTES)
        reject();
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      chunk = JSON.parse(content);
    } catch { reject(); }

    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) ||
        Object.keys(chunk).sort().join(',') !== CHUNK_KEYS ||
        chunk.format !== 'oge-vault-notes-backup-chunk' ||
        chunk.version !== 1 || chunk.scope !== 'current-github-notes-only' ||
        !SHA.test(chunk.snapshot || '') ||
        !DIGEST.test(chunk.inventorySha256 || '') ||
        !DIGEST.test(chunk.chunkSha256 || '') ||
        !Number.isSafeInteger(chunk.totalNotes) ||
        chunk.totalNotes < 0 || chunk.totalNotes > MAX_NOTES ||
        !Number.isSafeInteger(chunk.offset) || chunk.offset !== received ||
        !Number.isSafeInteger(chunk.count) ||
        chunk.count < 0 || chunk.count > 64 ||
        !Array.isArray(chunk.notes) || chunk.notes.length !== chunk.count ||
        chunk.count !== Math.min(64, chunk.totalNotes - chunk.offset) ||
        chunk.afterId !== cursor || typeof chunk.hasMore !== 'boolean' ||
        chunk.hasMore !== (chunk.offset + chunk.count < chunk.totalNotes) ||
        chunk.nextAfterId !== (chunk.hasMore
          ? chunk.notes.at(-1)?.id : null) ||
        chunk.completeBackup !== false ||
        chunk.importableAsLegacyBackup !== false ||
        !canonicalCoverage(chunk.coverage) ||
        (pages > 0 && (chunk.snapshot !== sourceSnapshot ||
          chunk.inventorySha256 !== inventorySha ||
          chunk.totalNotes !== totalNotes)))
      reject();

    if ((await sha256(JSON.stringify(chunk.notes), subtle)) !==
        chunk.chunkSha256)
      reject();
    for (const note of chunk.notes) {
      canonicalNote(note);
      if (cursor !== null && note.id <= cursor) reject();
      cursor = note.id;
      inventoryInput += note.id + ':' + note.sha + '\n';
      if (selectedIds.has(note.id)) {
        if (selectedMetadata.has(note.id)) reject();
        const canonicalDigest = await sha256(JSON.stringify(
          FINGERPRINT_KEYS.map((key) => note[key])), subtle);
        selectedMetadata.set(note.id, {
          id: note.id, sha: note.sha,
          contentDigest: canonicalDigest, subjectId: note.subjectId,
        });
      }
    }
    if (pages === 0) {
      sourceSnapshot = chunk.snapshot;
      inventorySha = chunk.inventorySha256;
      totalNotes = chunk.totalNotes;
    }
    received += chunk.count;
    pages++;
    finished = !chunk.hasMore;
  }

  if (!finished || received !== totalNotes ||
      sourceSnapshot !== selected.expectedSourceSnapshot ||
      inventorySha !== selected.expectedSourceInventorySha256 ||
      selectedMetadata.size !== selected.selectedIds.length ||
      (await sha256(inventoryInput, subtle)) !== inventorySha)
    reject();

  const selectedInReviewOrder = selected.selectedIds.map((id) =>
    selectedMetadata.get(id));
  const fingerprint = await sha256(JSON.stringify({
    sourceSnapshot, sourceInventorySha256: inventorySha,
    targetHead: selected.expectedTargetHead, selected: selectedInReviewOrder,
  }), subtle);
  if (fingerprint !== selected.expectedSelectionFingerprint)
    reject();

  return {
    format: 'oge-vault-local-chunk-integrity-review', version: 1,
    locallyVerifiedPages: pages, locallyVerifiedNoteCount: received,
    selectedNoteCount: selected.selectedIds.length,
    completeLocalSequenceVerified: true,
    reviewedSelectionFingerprintMatches: true,
    privateNoteTextReturned: false,
    permanentBrowserStorageUsed: false,
    filesUploaded: false,
    signedGitHubSourceAuthenticated: false,
    destinationGitHubHeadVerified: false,
    importApprovedByLocalCheck: false,
    canWriteGitHub: false,
    requiresIndependentSignedOperatorProof: true,
  };
}
