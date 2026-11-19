/**
 * Plain writing status for the familiar Oge Notes editor.
 * A temporary draft never counts as a saved Note.
 */
export function noteEditorFeedback({
  vaultMode = false, hybridDrafts = false, saving = false,
  hybridReady = true, editingId = '', changed = false,
  draftStatus = '', hybridError = '', error = '', message = '',
} = {}) {
  if (saving) return { kind: 'working', label: 'Saving note…' };
  if (message && /newer edits|new edits remain|newer draft|browser draft differs/i.test(message))
    return { kind: 'draft', label: 'Earlier version saved · newer changes still need Save' };
  if (message && /saved (?:this version |the submitted version |to GitHub|successfully)|GitHub saved|GitHub confirmed/i.test(message))
    return { kind: 'saved', label: 'Note saved.' };
  if (error) return { kind: 'error', label: 'Save not confirmed. Your text is still here.' };
  if (hybridError) return { kind: 'error',
    label: 'Draft needs attention. Keep your changes before closing.' };
  if (hybridDrafts && !hybridReady)
    return { kind: 'working', label: 'Checking drafts…' };
  if (!changed) return { kind: editingId ? 'saved' : 'idle', label: editingId
    ? 'No unsaved changes' : 'New note' };
  if (vaultMode && hybridDrafts && /^Draft saved$/.test(draftStatus))
    return { kind: 'draft', label: 'Draft autosaved · press Save to finish' };
  if (vaultMode && hybridDrafts && /offline|pending|saving/i.test(draftStatus))
    return { kind: 'draft', label: 'Unsaved changes · draft pending' };
  return { kind: 'draft', label: 'Unsaved changes · press Save' };
}

export function noteBodyMetrics(answer) {
  const text = typeof answer === 'string' ? answer : '';
  return {
    characters: text.length,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
  };
}
