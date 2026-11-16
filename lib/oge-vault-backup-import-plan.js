import { noteFilePath, validatedNote, MAX_VAULT_NOTE_BYTES } from './oge-vault-notes.js';
import { MAX_VAULT_BACKUP_EXPORT_BYTES } from './oge-vault-backup-export.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[0-9a-f]{40}$/i;
const MAX_TREE_ENTRIES = 30000;
const COVERAGE = Object.freeze({
  notes: 'complete-at-snapshot',
  historicalRevisions: 'not-included',
  quickNotes: 'not-included',
  airNotes: 'not-included',
  encryptedDrafts: 'not-included',
  learningProgress: 'not-included',
});
const NOTE_KEYS = ['format', 'version', 'id', 'subjectId', 'heading', 'answer',
  'tags', 'favorite', 'updatedAt', 'createdAt', 'sha'].sort();

const sameKeys = (value, keys) =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
const error = (reason, status = 409) => new VaultGitHubError(reason, status);

export function validateVaultNotesImportArchive(archive, {
  maxBytes = MAX_VAULT_BACKUP_EXPORT_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
      maxBytes > MAX_VAULT_BACKUP_EXPORT_BYTES)
    throw new TypeError('Invalid Vault import bound');
  if (!archive || typeof archive !== 'object' || Array.isArray(archive) ||
      Buffer.byteLength(JSON.stringify(archive), 'utf8') > maxBytes)
    throw error('vault-import-archive-invalid', 400);
  if (!sameKeys(archive, ['format', 'version', 'scope', 'snapshot',
    'totalNotes', 'coverage', 'notes'].sort()) ||
      archive.format !== 'oge-vault-notes-backup' ||
      archive.version !== 1 || archive.scope !== 'current-github-notes-only' ||
      typeof archive.snapshot !== 'string' || !SHA.test(archive.snapshot) ||
      !sameKeys(archive.coverage, Object.keys(COVERAGE).sort()) ||
      Object.keys(COVERAGE).some((name) => archive.coverage[name] !== COVERAGE[name]) ||
      !Array.isArray(archive.notes) ||
      !Number.isSafeInteger(archive.totalNotes) ||
      archive.totalNotes !== archive.notes.length ||
      archive.notes.length > MAX_TREE_ENTRIES)
    throw error('vault-import-archive-invalid', 400);
  const seen = new Set();
  const notes = [];
  for (const raw of archive.notes) {
    if (!sameKeys(raw, NOTE_KEYS) || typeof raw.sha !== 'string' ||
        !SHA.test(raw.sha))
      throw error('vault-import-note-invalid', 400);
    let canonical;
    try {
      noteFilePath(raw.id);
      canonical = validatedNote(raw, { id: raw.id, now: raw.updatedAt });
    } catch {
      throw error('vault-import-note-invalid', 400);
    }
    const { sha, ...withoutSha } = raw;
    if (JSON.stringify(canonical) !== JSON.stringify(withoutSha) ||
        Buffer.byteLength(JSON.stringify(withoutSha), 'utf8') > MAX_VAULT_NOTE_BYTES ||
        seen.has(raw.id))
      throw error('vault-import-note-invalid', 400);
    seen.add(raw.id);
    // The source SHA and source snapshot are advisory. A caller may edit an
    // archive; neither value proves ownership or authorizes a GitHub write.
    notes.push(canonical);
  }
  return { snapshot: archive.snapshot, notes };
}

/**
 * Phase D3b2 read-only, fail-closed import plan. All target information comes
 * from a signed owner's live GitHub repository. No contents, uploads, draft
 * data or approval tokens are persisted. The archive is never trusted to
 * select a repository, subject or permission scope.
 *
 * Existing note IDs are ALWAYS conflicts, even if a source SHA appears to
 * match. An encrypted draft always blocks import of its note ID, including
 * when that ID is not yet in GitHub. Future commit authorization must use
 * a separate, fresh owner-approved CAS workflow, never this advisory plan.
 */
export async function planVaultNotesImport(client, archive, {
  subjectVerifier,
  pendingDraftIds,
  maxBytes = MAX_VAULT_BACKUP_EXPORT_BYTES,
} = {}) {
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      typeof subjectVerifier !== 'function' ||
      typeof pendingDraftIds !== 'function')
    throw new TypeError('Vault import requires signed owner verification');
  const { notes } = validateVaultNotesImportArchive(archive, { maxBytes });
  const subjectIds = [...new Set(notes.map((note) => note.subjectId))].sort();
  if (!await subjectVerifier(subjectIds))
    throw error('vault-import-subject-unverified', 409);

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const targetHead = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(targetHead || ''))
    throw error('vault-import-target-head-unavailable', 503);
  const commit = await client.call('/git/commits/' + targetHead);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw error('vault-import-target-tree-unavailable', 503);
  const tree = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw error('vault-import-target-tree-incomplete');
  const remote = new Map();
  for (const item of tree.tree) {
    if (!item || typeof item.path !== 'string' || !item.path)
      throw error('vault-import-target-tree-incomplete');
    if (!item.path.startsWith('notes/')) continue;
    let id;
    try {
      id = item.path.endsWith('.json') ? item.path.slice(6, -5) : '';
      if (noteFilePath(id) !== item.path) throw new TypeError('Invalid note path');
    } catch {
      throw error('vault-import-target-note-invalid');
    }
    if (item.type !== 'blob' || (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') ||
        (item.size !== undefined &&
          (!Number.isSafeInteger(item.size) || item.size < 0 ||
            item.size > MAX_VAULT_NOTE_BYTES)) ||
        remote.has(id))
      throw error('vault-import-target-note-invalid');
    remote.set(id, item.sha);
  }

  const drafts = await pendingDraftIds(notes.map((note) => note.id));
  if (!Array.isArray(drafts) || drafts.some((id) =>
    typeof id !== 'string' || !notes.some((note) => note.id === id)))
    throw error('vault-import-draft-check-invalid', 409);
  const pending = new Set(drafts);
  const entries = notes.map(({ id }) => ({
    id,
    outcome: pending.has(id) ? 'draft-conflict' :
      remote.has(id) ? 'existing-note-conflict' : 'create-candidate',
  }));
  if ((await client.call(refPath))?.object?.sha !== targetHead)
    throw error('vault-import-target-head-changed');
  const summary = {
    total: entries.length,
    createCandidates: entries.filter((entry) => entry.outcome === 'create-candidate').length,
    existingConflicts: entries.filter((entry) => entry.outcome === 'existing-note-conflict').length,
    draftConflicts: entries.filter((entry) => entry.outcome === 'draft-conflict').length,
  };
  return {
    format: 'oge-vault-notes-import-plan', version: 1,
    targetHead, summary, entries,
    readOnly: true, advisoryOnly: true,
    requiresFreshApproval: true, canCommit: false,
    sourceShaTrusted: false,
  };
}
