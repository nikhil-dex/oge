import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';

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
