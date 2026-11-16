import { draftKey, getHybridDraft } from './oge-vault-hybrid-drafts.js';
import { noteFilePath, readVaultNoteBlob } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/i;
const MAX_TREE_ENTRIES = 30000;
const pending = (reason) => ({ confirmed: false, reason, advisoryOnly: true });

/**
 * B7: read-only confirmation of the EXACT encrypted draft revision against
 * an immutable GitHub tree and blob. Nothing here writes note content,
 * clears a draft, or treats a matching metadata index as a saved note.
 *
 * Used only when the original Save response was missing/ambiguous. A stale
 * or unavailable GitHub response is never assumed to mean "Saved".
 */
export async function inspectVaultDraftGitHubSave(drafts, client, identity, revision, {
  draftReader = getHybridDraft,
  blobReader = readVaultNoteBlob,
} = {}) {
  const key = draftKey(identity?.ownerId, identity?.repoId, identity?.noteId);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError('Invalid Save recovery revision');
  if (client?.vault?.repoId !== key.repoId)
    throw new VaultGitHubError('vault-save-recovery-repository-mismatch', 409);

  const current = await draftReader(drafts, key);
  if (!current || current.revision !== revision)
    return pending('draft-revision-changed');
  const draft = current.draft;
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(head || ''))
    return pending('github-head-unavailable');
  const commit = await client.call('/git/commits/' + head);
  if (!SHA.test(commit?.tree?.sha || ''))
    return pending('github-tree-unavailable');
  const listing = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(listing?.tree) || listing.truncated === true ||
      listing.tree.length > MAX_TREE_ENTRIES)
    return pending('github-tree-incomplete');
  const path = noteFilePath(key.noteId);
  const matches = listing.tree.filter((item) => item?.path === path);
  if (matches.length !== 1 || matches[0].type !== 'blob' ||
      !SHA.test(matches[0].sha || ''))
    return pending('github-note-unavailable');
  const blobSha = matches[0].sha.toLowerCase();
  if (draft.baseSha !== null && blobSha === draft.baseSha.toLowerCase())
    return pending('github-revision-unchanged');

  const note = await blobReader(client, key.noteId, blobSha);
  const canonicalTags = [...new Set(draft.tags.map((tag) =>
    tag.trim().toLowerCase()))];
  if (note?.sha !== blobSha || note.id !== key.noteId ||
      note.subjectId !== draft.subjectId ||
      note.heading !== draft.heading.trim() ||
      note.answer !== draft.answer.trim() ||
      note.favorite !== draft.favorite ||
      JSON.stringify(note.tags) !== JSON.stringify(canonicalTags))
    return pending('github-content-mismatch');

  // Two independent fences: the branch cannot have moved during the scan,
  // and the server-side draft revision cannot have advanced during recovery.
  const checkedHead = (await client.call(refPath))?.object?.sha;
  if (checkedHead !== head) return pending('github-head-changed');
  const checkedDraft = await draftReader(drafts, key);
  if (!checkedDraft || checkedDraft.revision !== revision ||
      JSON.stringify(checkedDraft.draft) !== JSON.stringify(draft))
    return pending('draft-revision-changed');

  return { confirmed: true, revision, sha: blobSha, commitSha: head,
    advisoryOnly: true };
}
