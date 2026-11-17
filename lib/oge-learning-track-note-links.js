import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';
import { VaultGitHubError } from './oge-vault-github.js';

// M99: independently default-OFF, disposable staging-only GitHub Notes links.
export function learningTrackNoteLinksEnabled(env = process.env) {
  return env.OGE_LEARNING_TRACKS_PREVIEW === 'true' &&
    env.OGE_LEARNING_TRACK_NOTE_LINK_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_STAGING_URL === env.AUTH_URL &&
    checkVaultStagingReadiness(env).ok;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
export function validLearningTrackNoteSelection(value) {
  return typeof value?.trackId === 'string' && UUID.test(value.trackId) &&
    typeof value.videoId === 'string' && VIDEO.test(value.videoId) &&
    typeof value.noteId === 'string' && UUID.test(value.noteId);
}
export function publicLessonNoteLink(record) {
  return { trackId: record.trackId, videoId: record.videoId,
    noteId: record.noteId, linkedAt: record.linkedAt };
}

/**
 * F4/M100: a manual, read-only point-in-time check. Read the current linked
 * Note, then fence the observation against revocation and a concurrent
 * unlink/relink on another device. No private Note content is returned.
 * Provider failures are unknown, NEVER interpreted as a deleted Note.
 */
export async function verifyLessonNoteLinkReadOnly({
  record, createClient, readNote, sessionStillActive, rereadLink,
}) {
  if (!record || typeof record.noteId !== 'string' || !record._id)
    throw new TypeError('Invalid linked Note snapshot');
  const client = await createClient();
  let status = 'present';
  try {
    await readNote(client, record.noteId);
  } catch (error) {
    if (error instanceof VaultGitHubError && error.status === 404)
      status = 'missing';
    else
      throw error;
  }
  if (!await sessionStillActive()) return 'session-expired';
  const current = await rereadLink();
  if (!current || String(current._id) !== String(record._id) ||
      current.noteId !== record.noteId) return 'changed';
  return status;
}
