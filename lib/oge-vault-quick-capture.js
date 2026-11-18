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
  // A thought should not require two paragraphs to become a saved Note.
  // Keep explicit title + body unchanged when both are present. For a single
  // line or body-only note, use an ordinary title and preserve all the text
  // in the GitHub Note body, without a fake placeholder or duplicated text.
  const hasTitleAndBody = firstLine.length > 0 && firstLine.length <= 160 && !!remaining;
  const heading = hasTitleAndBody ? firstLine : 'Quick note';
  const answer = hasTitleAndBody ? remaining : normalized.trim();
  if (!answer || answer.length > 20000)
    throw new TypeError('Write something before saving your note');
  return Object.freeze({
    subjectId: subjectId.toLowerCase(),
    heading, answer, tags: [], favorite: false, baseSha: null,
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
