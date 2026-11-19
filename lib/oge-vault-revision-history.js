import { noteFilePath, readVaultNote, readVaultNoteBlob } from './oge-vault-notes.js';
import { commitVaultNoteBatch } from './oge-vault-batch.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[0-9a-f]{40}$/i;
export const MAX_VAULT_HISTORY_PREVIEW = 5;
const MAX_TREE_ENTRIES = 30000;

function validSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

/**
 * Read a single note from an immutable GitHub commit's tree. The history
 * implementation never reads/writes MongoDB content or asks the mutable
 * Contents API for an older revision.
 */
export async function readVaultNoteAtCommit(client, id, commitSha, {
  commitReader = async (github, sha) => github.call('/git/commits/' + sha),
  treeReader = async (github, sha) =>
    github.call('/git/trees/' + sha + '?recursive=1'),
  blobReader = readVaultNoteBlob,
} = {}) {
  const path = noteFilePath(id);
  if (!validSha(commitSha)) throw new TypeError('Invalid GitHub commit SHA');
  const commit = await commitReader(client, commitSha);
  if (!validSha(commit?.tree?.sha))
    throw new VaultGitHubError('vault-history-tree-unavailable', 503);
  const tree = await treeReader(client, commit.tree.sha);
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw new VaultGitHubError('vault-history-tree-incomplete', 409);
  const found = tree.tree.filter((entry) => entry?.path === path);
  if (found.length === 0) return null; // A legitimate note deletion.
  if (found.length !== 1 || found[0].type !== 'blob' ||
      !validSha(found[0].sha) ||
      (found[0].size !== undefined &&
        (!Number.isSafeInteger(found[0].size) ||
          found[0].size < 0 || found[0].size > 32768)))
    throw new VaultGitHubError('vault-history-file-invalid', 409);
  const blobSha = found[0].sha.toLowerCase();
  const note = await blobReader(client, id, blobSha);
  if (note?.sha !== blobSha || note.id !== id.toLowerCase())
    throw new VaultGitHubError('vault-history-blob-mismatch', 409);
  return note;
}

/**
 * Read at most five path-scoped commits from the signed owner's private
 * GitHub Vault. Never treat this bounded window as all historical versions.
 *
 * The GitHub commits API proves that candidate commits belong to the
 * chosen branch's history and touched the specific note path. Each blob is
 * independently checked against its commit's tree, and HEAD is rechecked
 * before returning so an interleaved GitHub update cannot mix snapshots.
 */
export async function listVaultNoteRevisions(client, id, {
  headReader = async (github) => (await github.call(
    '/git/ref/heads/' + encodeURIComponent(github.branch)))?.object?.sha,
  commitsReader = async (github, sha, path) => github.call(
    '/commits?sha=' + sha + '&path=' + encodeURIComponent(path) +
    '&per_page=' + (MAX_VAULT_HISTORY_PREVIEW + 1)),
  commitNoteReader = readVaultNoteAtCommit,
} = {}) {
  const path = noteFilePath(id);
  const noteId = id.toLowerCase();
  const head = await headReader(client);
  if (!validSha(head))
    throw new VaultGitHubError('vault-history-head-unavailable', 503);

  const current = await commitNoteReader(client, noteId, head);
  if (!current) throw new VaultGitHubError('vault-note-not-found', 404);

  const commits = await commitsReader(client, head, path);
  if (!Array.isArray(commits) || commits.length === 0 ||
      commits.length > MAX_VAULT_HISTORY_PREVIEW + 1 ||
      commits.some((item) => !validSha(item?.sha)))
    throw new VaultGitHubError('vault-history-list-invalid', 409);

  const seenCommits = new Set();
  const seenBlobs = new Set();
  const items = [];
  let skippedDeletion = false;
  for (const entry of commits.slice(0, MAX_VAULT_HISTORY_PREVIEW)) {
    const commitSha = entry.sha.toLowerCase();
    if (seenCommits.has(commitSha))
      throw new VaultGitHubError('vault-history-list-invalid', 409);
    seenCommits.add(commitSha);
    const note = commitSha === head.toLowerCase()
      ? current : await commitNoteReader(client, noteId, commitSha);
    if (!note) { skippedDeletion = true; continue; }
    // A reused UUID across subjects is not the same logical note.
    if (note.subjectId !== current.subjectId)
      throw new VaultGitHubError('vault-history-subject-mismatch', 409);
    if (seenBlobs.has(note.sha)) continue;
    seenBlobs.add(note.sha);
    items.push({
      commitSha, sha: note.sha,
      heading: note.heading, answer: note.answer,
      updatedAt: note.updatedAt, createdAt: note.createdAt,
      isCurrent: note.sha === current.sha,
    });
  }

  const checkedHead = await headReader(client);
  if (checkedHead !== head)
    throw new VaultGitHubError('vault-history-stale', 409);

  return {
    noteId, subjectId: current.subjectId, snapshot: head,
    currentSha: current.sha, items,
    limited: true, moreMayExist: commits.length > MAX_VAULT_HISTORY_PREVIEW ||
      skippedDeletion,
    advisoryOnly: true,
  };
}

/**
 * Explicit revision restoration uses one new verified GitHub commit.
 * The caller MUST supply a fresh, server-built history plus an owner-scoped
 * subject lock and a check for encrypted pending drafts. No MongoDB content.
 *
 * The expected live blob SHA protects against old-client overwrites, and
 * the batch writer rejects a non-fast-forward branch update.
 */
export async function restoreVaultNoteRevision(client, history, request, {
  currentReader = readVaultNote,
  batchWriter = commitVaultNoteBatch,
} = {}) {
  const id = request?.id;
  noteFilePath(id);
  if (!validSha(request?.sha) || !validSha(request?.commitSha) ||
      !validSha(request?.sourceSha) ||
      history?.noteId !== id.toLowerCase() ||
      history?.currentSha !== request.sha.toLowerCase() ||
      !Array.isArray(history?.items))
    throw new VaultGitHubError('vault-history-restore-stale', 409);

  const source = history.items.find((entry) =>
    entry.commitSha === request.commitSha.toLowerCase() &&
    entry.sha === request.sourceSha.toLowerCase() &&
    entry.sha !== history.currentSha);
  if (!source)
    throw new VaultGitHubError('vault-history-revision-unavailable', 409);

  const current = await currentReader(client, id);
  if (current.sha !== request.sha.toLowerCase() ||
      current.subjectId !== history.subjectId ||
      typeof source.heading !== 'string' ||
      typeof source.answer !== 'string')
    throw new VaultGitHubError('vault-note-conflict', 409);
  if (source.heading === current.heading && source.answer === current.answer)
    throw new VaultGitHubError('vault-history-content-unchanged', 409);

  const saved = await batchWriter(client, [{
    action: 'update', id, sha: current.sha,
    note: {
      subjectId: current.subjectId,
      heading: source.heading, answer: source.answer,
      // Legacy revision restore changes heading and body, not tags or
      // favorite. Preserve current properties and createdAt in GitHub.
      tags: current.tags, favorite: current.favorite,
    },
  }]);
  const restored = saved?.results?.[0];
  if (restored?.id !== id.toLowerCase() ||
      restored.subjectId !== current.subjectId ||
      restored.heading !== source.heading ||
      restored.answer !== source.answer ||
      !validSha(restored.sha) || !validSha(saved.commitSha))
    throw new VaultGitHubError('vault-commit-unconfirmed', 503);
  return { note: restored, commitSha: saved.commitSha,
    restoredFromCommit: source.commitSha, advisoryOnly: false };
}
