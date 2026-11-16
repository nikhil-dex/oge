import { draftKey, clearConfirmedDraft } from './oge-vault-hybrid-drafts.js';
import { readVaultNote } from './oge-vault-notes.js';
import { inspectVaultDraftGitHubSave } from './oge-vault-save-recovery.js';

const SHA = /^[a-f0-9]{40}$/i;
const pending = (reason) => ({ confirmed: false, cleared: false, reason });

/**
 * B7: explicitly finish an already-confirmed Save that lost its HTTP reply.
 * This function NEVER creates another GitHub commit. It only CAS-clears the
 * specific encrypted temporary draft revision, after GitHub verification.
 *
 * The returned note is read from GitHub; no committed note content is put in
 * MongoDB. The server route additionally gates this on a signed Oge session,
 * its repo mapping and the subject's active-writer fence.
 */
export async function reconcileConfirmedVaultDraft(drafts, client, identity, revision, expectedSha, {
  inspector = inspectVaultDraftGitHubSave,
  noteReader = readVaultNote,
  clear = clearConfirmedDraft,
} = {}) {
  const scope = draftKey(identity?.ownerId, identity?.repoId, identity?.noteId);
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      !SHA.test(expectedSha || ''))
    throw new TypeError('Invalid confirmed Save reconciliation request');
  const verified = await inspector(drafts, client, scope, revision);
  if (verified?.confirmed !== true || verified?.sha !== expectedSha.toLowerCase())
    return pending(verified?.reason || 'github-revision-unconfirmed');

  let note;
  try { note = await noteReader(client, scope.noteId); }
  catch { return pending('github-note-unavailable'); }
  if (note?.sha !== verified.sha || note.id !== scope.noteId)
    return pending('github-note-changed');

  // The inspector compares every persisted note field against the draft.
  // The CAS delete cannot remove a newer autosave, including one written
  // between the second GitHub read and this operation.
  const cleared = await clear(drafts, scope, revision);
  return { confirmed: true, cleared, revision, sha: verified.sha,
    commitSha: verified.commitSha, note };
}
