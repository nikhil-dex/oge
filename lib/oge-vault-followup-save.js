import { isVaultNoteId, mergeRecentVaultNotes } from './oge-vault-recent-notes.js';

const SHA = /^[a-f0-9]{40}$/i;

/**
 * A confirmed GitHub create/update may finish after the user typed more.
 * Promote the open editor from a new-Note draft to an edit of the committed
 * Note. Its unsaved fields remain untouched in React; only the saved baseline
 * and GitHub revision change. No additional GitHub write happens here.
 */
export function stageVaultFollowupSave(loadedNotes, committedNote, liveEditor) {
  if (!Array.isArray(loadedNotes) || !committedNote ||
      !isVaultNoteId(committedNote.id) ||
      !isVaultNoteId(committedNote.subjectSlug) ||
      typeof committedNote.sha !== 'string' || !SHA.test(committedNote.sha) ||
      typeof committedNote.heading !== 'string' ||
      typeof committedNote.answer !== 'string' ||
      !Array.isArray(committedNote.tags) ||
      !committedNote.tags.every((tag) => typeof tag === 'string') ||
      !liveEditor || typeof liveEditor.heading !== 'string' ||
      typeof liveEditor.answer !== 'string' ||
      typeof liveEditor.tagsText !== 'string')
    throw new TypeError('Invalid committed GitHub Note for continued editing');
  const baseline = {
    heading: committedNote.heading,
    answer: committedNote.answer,
    tags: committedNote.tags.join(', '),
  };
  return {
    notes: mergeRecentVaultNotes(loadedNotes, [committedNote]),
    editingId: committedNote.id,
    newDraftId: '',
    baseline,
    // This browser recovery copy uses the newly confirmed GitHub revision
    // immediately, even if the user reloads before the next autosave timer.
    pendingDraft: {
      subjectId: committedNote.subjectSlug,
      heading: liveEditor.heading,
      answer: liveEditor.answer,
      tags: [...new Set(liveEditor.tagsText.split(',')
        .map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10),
      favorite: Boolean(committedNote.favorite),
      baseSha: committedNote.sha,
    },
  };
}
