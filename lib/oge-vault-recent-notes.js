/**
 * Local navigation hints for recently saved GitHub Notes.
 *
 * The browser stores ONLY validated UUIDs. Note headings, bodies, tags,
 * GitHub revisions and repository credentials are never copied here.
 * Every displayed note is freshly loaded from the signed owner's GitHub
 * API, even after a tab reload.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECENT = 5;

export function isVaultNoteId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function recentVaultNotesKey(ownerId, repoId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 ||
      ownerId.length > 120 || !Number.isSafeInteger(repoId) || repoId < 1)
    throw new TypeError('Invalid Vault recent note scope');
  return 'oge-vault-recent-note-ids:v1:' +
    encodeURIComponent(ownerId) + ':' + repoId;
}

export function readRecentVaultNoteIds(storage, key) {
  if (typeof key !== 'string' || !key.startsWith('oge-vault-recent-note-ids:v1:'))
    throw new TypeError('Invalid Vault recent key');
  try {
    const stored = JSON.parse(storage?.getItem(key) || '[]');
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter(isVaultNoteId).map((id) => id.toLowerCase()))]
      .slice(0, MAX_RECENT);
  } catch { return []; }
}

export function rememberRecentVaultNote(storage, key, id) {
  if (!isVaultNoteId(id)) throw new TypeError('Invalid saved Vault note ID');
  const ids = [id.toLowerCase(), ...readRecentVaultNoteIds(storage, key)]
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, MAX_RECENT);
  // Storage may be blocked in private/incognito contexts. Caller may catch;
  // this must never affect a confirmed GitHub Save.
  storage?.setItem(key, JSON.stringify(ids));
  return ids;
}

export function mergeRecentVaultNotes(pageNotes, recentNotes) {
  if (!Array.isArray(pageNotes) || !Array.isArray(recentNotes))
    throw new TypeError('Invalid Vault note pages');
  const seen = new Set();
  const out = [];
  for (const note of [...recentNotes, ...pageNotes]) {
    if (!note || !isVaultNoteId(note.id) || seen.has(note.id.toLowerCase()))
      continue;
    seen.add(note.id.toLowerCase());
    out.push(note);
  }
  return out;
}

/**
 * Resolve a user-requested direct Note link only from GitHub-backed Notes
 * actually loaded by the page. A UUID in the query string is not proof
 * that this owner can access that Note.
 */
export function findLinkedVaultNote(requestedId, loadedNotes) {
  if (!isVaultNoteId(requestedId) || !Array.isArray(loadedNotes)) return null;
  const id = requestedId.toLowerCase();
  return loadedNotes.find((note) =>
    note && isVaultNoteId(note.id) && note.id.toLowerCase() === id) || null;
}
