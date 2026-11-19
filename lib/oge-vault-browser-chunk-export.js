import {
  vaultBrowserSha256, validateVaultBrowserCanonicalNote,
  isVaultBrowserChunkCoverage,
} from './oge-vault-restore-local-chunks.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_NOTES = 1024;
const PAGE_NOTES = 64;
const MAX_PARTS = 16;
export const MAX_VAULT_BROWSER_EXPORT_PART_BYTES = 4 * 1024 * 1024;
const EXPECTED_CHUNK_KEYS = [
  'format', 'version', 'scope', 'snapshot', 'totalNotes',
  'inventorySha256', 'offset', 'count', 'afterId', 'nextAfterId',
  'hasMore', 'coverage', 'notes', 'chunkSha256', 'completeBackup',
  'importableAsLegacyBackup',
].sort().join(',');
const fail = () => {
  throw new TypeError('A private backup chunk is invalid or incomplete. Stop this export.');
};

/**
 * Fail-closed browser response reader. Limit bytes DURING streaming,
 * not after Response.text() has already allocated unbounded input.
 * Returns the exact JSON response body for later numbered local download.
 */
export async function readLimitedVaultBrowserExportResponse(response) {
  if (!response?.ok || response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers?.get('content-type') || ''))
    fail();
  const header = response.headers?.get('content-length');
  if (header !== null && (!/^\d+$/.test(header) ||
      Number(header) > MAX_VAULT_BROWSER_EXPORT_PART_BYTES))
    fail();
  if (!response.body || typeof response.body.getReader !== 'function')
    fail();

  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array))
        fail();
      bytes += part.value.byteLength;
      if (bytes > MAX_VAULT_BROWSER_EXPORT_PART_BYTES) {
        await reader.cancel().catch(() => {});
        fail();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes < 2) fail();
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const part of chunks) {
    raw.set(part, offset);
    offset += part.byteLength;
  }
  let text, chunk;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    chunk = JSON.parse(text);
  } catch { fail(); }
  return { text, chunk };
}

/**
 * Browser-side complete source sequence proof. Re-validates the strict
 * canonical chunk format as each page arrives and retains ONLY counters,
 * one bounded ID/blob-SHA inventory string and the immutable snapshot ID.
 * The returned evidence is local integrity only, NOT signed GitHub source
 * authentication, not a durable offline copy, and not import approval.
 */
export function createVaultBrowserChunkDownloadVerifier({
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!subtle || typeof subtle.digest !== 'function')
    fail();
  let head = null, inventorySha = null, totalNotes = null;
  let previous = null, received = 0, pages = 0, complete = false;
  let inventory = 'oge-vault-notes-inventory-v1\n';
  let closed = false;

  async function accept(chunk) {
    if (complete || closed || pages >= MAX_PARTS ||
        !chunk || typeof chunk !== 'object' || Array.isArray(chunk) ||
        Object.keys(chunk).sort().join(',') !== EXPECTED_CHUNK_KEYS ||
        chunk.format !== 'oge-vault-notes-backup-chunk' ||
        chunk.version !== 1 || chunk.scope !== 'current-github-notes-only' ||
        !SHA.test(chunk.snapshot || '') ||
        !DIGEST.test(chunk.inventorySha256 || '') ||
        !DIGEST.test(chunk.chunkSha256 || '') ||
        !Number.isSafeInteger(chunk.totalNotes) ||
        chunk.totalNotes < 0 || chunk.totalNotes > MAX_NOTES ||
        !Number.isSafeInteger(chunk.offset) || chunk.offset !== received ||
        !Number.isSafeInteger(chunk.count) || chunk.count < 0 ||
        chunk.count > PAGE_NOTES ||
        !Array.isArray(chunk.notes) || chunk.notes.length !== chunk.count ||
        chunk.count !== Math.min(PAGE_NOTES, chunk.totalNotes - chunk.offset) ||
        chunk.afterId !== previous || typeof chunk.hasMore !== 'boolean' ||
        chunk.hasMore !== (chunk.offset + chunk.count < chunk.totalNotes) ||
        chunk.nextAfterId !== (chunk.hasMore
          ? chunk.notes.at(-1)?.id : null) ||
        chunk.completeBackup !== false ||
        chunk.importableAsLegacyBackup !== false ||
        !isVaultBrowserChunkCoverage(chunk.coverage) ||
        (pages > 0 && (chunk.snapshot !== head ||
          chunk.inventorySha256 !== inventorySha ||
          chunk.totalNotes !== totalNotes)))
      fail();

    if (await vaultBrowserSha256(JSON.stringify(chunk.notes), subtle) !==
        chunk.chunkSha256)
      fail();

    // Do NOT update durable running totals until this page is canonical.
    let current = previous;
    let inventoryAddition = '';
    for (const note of chunk.notes) {
      validateVaultBrowserCanonicalNote(note);
      if (current !== null && note.id <= current) fail();
      current = note.id;
      inventoryAddition += note.id + ':' + note.sha + '\n';
    }
    if (pages === 0) {
      head = chunk.snapshot;
      inventorySha = chunk.inventorySha256;
      totalNotes = chunk.totalNotes;
    }
    previous = current;
    received += chunk.count;
    pages++;
    inventory += inventoryAddition;
    complete = !chunk.hasMore;
    return {
      accepted: true, partNumber: pages,
      count: chunk.count, notesReceived: received,
      complete, snapshot: head,
      nextAfterId: complete ? null : previous,
    };
  }

  async function finish() {
    if (!complete || closed || pages === 0 ||
        received !== totalNotes ||
        await vaultBrowserSha256(inventory, subtle) !== inventorySha)
      fail();
    closed = true;
    return {
      format: 'oge-vault-notes-browser-export-integrity',
      version: 1,
      verifiedCompleteCurrentNotesSequence: true,
      notesVerified: received,
      partsVerified: pages,
      sourceSnapshot: head,
      inventorySha256: inventorySha,
      savedToDiskVerified: false,
      filesUploaded: false,
      signedGitHubSourceProvenanceByThisCheck: false,
      historicalRevisionsIncluded: false,
      quickNotesIncluded: false,
      airNotesIncluded: false,
      draftsIncluded: false,
      authorizesRestore: false,
      automaticRetryAllowed: false,
    };
  }
  return { accept, finish };
}

/**
 * Exact cursor construction; never allow arbitrary revision or GitHub repo.
 * The first page must not carry any query string.
 */
export function vaultBrowserChunkExportURL(page) {
  if (page === null) return '/api/vault/backup-export/chunk';
  if (!page || !SHA.test(page.snapshot || '') ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        page.nextAfterId || ''))
    fail();
  return '/api/vault/backup-export/chunk?snapshot=' +
    encodeURIComponent(page.snapshot) + '&after=' +
    encodeURIComponent(page.nextAfterId);
}
