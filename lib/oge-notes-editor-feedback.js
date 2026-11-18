/**
 * Present a human-readable writing status without confusing a temporary
 * MongoDB/session draft with a committed GitHub Note. Pure UI state only.
 * It never decides whether a Save succeeded; only the Save handler can do that.
 */
export function noteEditorFeedback({
  vaultMode = false, hybridDrafts = false, saving = false,
  hybridReady = true, editingId = '', changed = false,
  draftStatus = '', hybridError = '', error = '', message = '',
} = {}) {
  if (saving) return { kind: 'working', label: vaultMode
    ? 'Saving this version to GitHub…' : 'Saving note…' };
  if (message && /newer edits|new edits remain|newer draft|browser draft differs/i.test(message))
    return { kind: 'draft', label: 'Earlier version saved · newer changes still need Save' };
  if (message && /saved (?:this version |the submitted version |to GitHub|successfully)|GitHub saved|GitHub confirmed/i.test(message))
    return { kind: 'saved', label: vaultMode ? 'GitHub saved this version. Review any remaining draft.' : 'Note saved.' };
  if (error) return { kind: 'error', label: vaultMode
    ? 'Save not confirmed. Your editor text is still here.' : 'Save failed. Try again.' };
  if (hybridError) return { kind: 'error', label:
    'Draft needs attention. Your changes are not confirmed on GitHub.' };
  if (hybridDrafts && !hybridReady)
    return { kind: 'working', label: 'Checking recoverable drafts…' };
  if (!changed) return { kind: editingId ? 'saved' : 'idle', label: editingId
    ? (vaultMode ? 'Saved version from GitHub' : 'No unsaved changes')
    : (vaultMode ? 'New note · not saved to GitHub' : 'New note') };
  if (vaultMode && hybridDrafts && /^Draft saved$/.test(draftStatus))
    return { kind: 'draft', label: 'Draft autosaved temporarily · press Save for GitHub' };
  if (vaultMode && hybridDrafts && /offline|pending|saving/i.test(draftStatus))
    return { kind: 'draft', label: 'Unsaved changes · temporary draft pending' };
  return { kind: 'draft', label: vaultMode
    ? 'Unsaved changes · press Save to commit to GitHub'
    : 'Unsaved changes · press Save' };
}

export function noteBodyMetrics(answer) {
  const text = typeof answer === 'string' ? answer : '';
  return {
    characters: text.length,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
  };
}
