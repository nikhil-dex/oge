/**
 * E1/M69 — browser-safe conversion of a short subject capture to the
 * EXISTING encrypted Vault hybrid draft schema. No permanent MongoDB Notes.
 * This module never decides owner access or GitHub write authority.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const VAULT_CAPTURE_MAX_CHARS = 20000;

export function vaultCaptureFields(content, subjectId) {
  if (typeof content !== 'string' || content.length > VAULT_CAPTURE_MAX_CHARS ||
      typeof subjectId !== 'string' || !UUID.test(subjectId)) {
    throw new TypeError('Invalid Vault capture subject or length');
  }
  const normalized = content.replace(/\r\n?/g, '\n');
  const split = normalized.indexOf('\n');
  const firstLine = (split === -1 ? normalized : normalized.slice(0, split)).trim();
  const remaining = split === -1 ? '' : normalized.slice(split + 1).trim();
  // One-line thoughts should produce useful, recognizable titles in the
  // library. Keep explicit title+body captures unchanged. Otherwise derive
  // a short title from the first nonempty line and put the COMPLETE original
  // thought in the Note body; never use a meaningless generic list title.
  const hasTitleAndBody = firstLine.length > 0 && firstLine.length <= 160 && !!remaining;
  const fallbackTitle = normalized.split('\n').find((line) => line.trim())?.trim().slice(0, 80).trim();
  const heading = hasTitleAndBody ? firstLine : (fallbackTitle || 'Quick note');
  const answer = hasTitleAndBody ? remaining : normalized.trim();
  if (!answer || answer.length > 20000)
    throw new TypeError('Write something before saving your note');
  return Object.freeze({
    subjectId: subjectId.toLowerCase(),
    heading, answer, tags: [], favorite: false, baseSha: null,
  });
}


/**
 * Reconstruct a temporary capture for editing. GitHub Notes store a heading
 * and body, not the original textarea shape. For a one-line capture,
 * reconstructing heading + newline + body would show that line twice.
 *
 * Prefer the user's exact browser copy ONLY when it maps to the same
 * server-acknowledged heading and body; this is not an overwrite of a newer
 * server draft. Otherwise keep the canonical server reconstruction and let
 * the UI offer an explicit recovery choice for divergent browser edits.
 */
export function vaultCaptureRecoveryText(draft, browserCopy = null) {
  if (!draft || typeof draft.heading !== 'string' ||
      typeof draft.answer !== 'string' ||
      typeof draft.subjectId !== 'string' || !UUID.test(draft.subjectId)) {
    throw new TypeError('Invalid capture recovery draft');
  }
  const serverText = draft.heading + '\n' + draft.answer;
  let matchesBrowserCopy = false;
  if (typeof browserCopy === 'string') {
    try {
      const candidate = vaultCaptureFields(browserCopy, draft.subjectId);
      matchesBrowserCopy = candidate.heading === draft.heading &&
        candidate.answer === draft.answer;
    } catch { /* Incomplete or divergent local text needs explicit recovery. */ }
  }
  return Object.freeze({
    serverText,
    matchesBrowserCopy,
    text: matchesBrowserCopy ? browserCopy : serverText,
  });
}

export function vaultCapturePointer(ownerId, repoId, subjectId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 ||
      ownerId.length > 120 || !Number.isSafeInteger(repoId) || repoId < 1 ||
      typeof subjectId !== 'string' || !UUID.test(subjectId))
    throw new TypeError('Invalid owner/repository/subject draft pointer');
  // Pointer only: never store note body here. The content recovery copy
  // lives under its own scoped sessionStorage key and is never sent to logs.
  return 'oge-vault-capture:v1:' + encodeURIComponent(ownerId) +
    ':' + repoId + ':' + subjectId.toLowerCase();
}

export function vaultCaptureLocalKey(ownerId, repoId, noteId) {
  if (typeof noteId !== 'string' || !UUID.test(noteId))
    throw new TypeError('Invalid Vault capture note ID');
  return 'oge-vault-capture-content:v1:' + encodeURIComponent(ownerId) +
    ':' + repoId + ':' + noteId.toLowerCase();
}
