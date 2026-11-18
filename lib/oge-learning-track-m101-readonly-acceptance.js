import { createHash } from 'node:crypto';
import { learningTrackNoteLinksEnabled } from './oge-learning-track-note-links.js';

/**
 * M101: operator-only two-session LIVE read-only Learning Tracks observations.
 * No OAuth acquisition, session/device attestation, provider fault induction,
 * Note content upload, GitHub write, MongoDB link mutation or release approval.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const OPT_IN = 'YES_ISOLATED_TWO_SESSION_READS_NO_WRITES';
const REFUSE = () => { throw new TypeError('M101 read-only staging observation blocked'); };
const forbidden = [
  'OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
  'OGE_ACCOUNT_DELETION_ENABLED',
  'OGE_VAULT_CUTOVER_GUARD_PREVIEW',
  'OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW',
  'OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW',
  'OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW',
  'OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW',
  'OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK',
  'OGE_VAULT_CHUNK_RESTORE_WRITE_ACK',
];
function originOnly(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && url.port === '' &&
      !['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.origin === raw;
  } catch { return false; }
}
export function m101ReadOnlyStagingGuard(env = {}, readiness = learningTrackNoteLinksEnabled) {
  return env.OGE_LEARNING_TRACK_M101_READ_ONLY_ACCEPTANCE === OPT_IN &&
    env.OGE_LEARNING_TRACK_M101_OPERATOR_ACK === 'DISPOSABLE_OWNER_TRACK_AND_NOTE_ONLY' &&
    originOnly(env.OGE_STAGING_URL) &&
    env.AUTH_URL === env.OGE_STAGING_URL &&
    env.OGE_VAULT_BASE_URL === env.OGE_STAGING_URL &&
    /^oge_vault_restore_staging_[A-Za-z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    UUID.test(env.OGE_LEARNING_TRACK_M101_RUN_ID || '') &&
    UUID.test(env.OGE_LEARNING_TRACK_M101_TRACK_ID || '') &&
    VIDEO.test(env.OGE_LEARNING_TRACK_M101_VIDEO_ID || '') &&
    forbidden.every((key) => !env[key] || env[key] === 'false') &&
    readiness(env) === true;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function metadataResponse(reply, keys) {
  if (!reply || reply.status !== 200 || reply.noStore !== true ||
      !exactKeys(reply.data, keys)) REFUSE();
  return reply.data;
}
function trackRead(reply, trackId) {
  const data = metadataResponse(reply, ['tracks', 'noteLinkingEnabled']);
  if (data.noteLinkingEnabled !== true || !Array.isArray(data.tracks) ||
      data.tracks.length > 100 ||
      data.tracks.filter((track) => track?.id === trackId).length !== 1) REFUSE();
}
function linkRead(reply, trackId, videoId) {
  const data = metadataResponse(reply, ['links', 'warning']);
  if (!Array.isArray(data.links) || data.links.length > 500 ||
      typeof data.warning !== 'string') REFUSE();
  const matching = data.links.filter((link) =>
    link?.trackId === trackId && link?.videoId === videoId);
  if (matching.length !== 1 || !UUID.test(matching[0]?.noteId || '')) REFUSE();
  // Note ID stays ONLY in private runner stack; never in report/logs.
  return matching[0].noteId;
}
function verifiedRead(reply) {
  const data = metadataResponse(reply, ['status', 'warning']);
  if (data.status !== 'present' || typeof data.warning !== 'string' ||
      !data.warning.includes('Point-in-time')) REFUSE();
}
export function m101RunBindingDigest(runId, origin) {
  if (!UUID.test(runId || '') || !originOnly(origin)) REFUSE();
  return createHash('sha256')
    .update('oge-m101-two-session-readonly-hold-v1\n' + runId + '\n' + origin, 'utf8')
    .digest('hex');
}

export async function executeM101ReadOnlyStagingObservation({
  env = {}, invoke, readiness = learningTrackNoteLinksEnabled,
} = {}) {
  if (!m101ReadOnlyStagingGuard(env, readiness) || typeof invoke !== 'function') REFUSE();
  const trackId = env.OGE_LEARNING_TRACK_M101_TRACK_ID;
  const videoId = env.OGE_LEARNING_TRACK_M101_VIDEO_ID;
  const linksPath = '/api/learning-tracks/note-links?trackId=' + trackId;
  const verifyPath = '/api/learning-tracks/note-links?mode=verify&trackId=' +
    trackId + '&videoId=' + videoId;
  const only = async (slot, path, keys) => {
    if (!['device-a', 'device-b'].includes(slot) ||
        !['/api/learning-tracks', linksPath, verifyPath].includes(path)) REFUSE();
    const reply = await invoke(slot, path);
    if (!reply || reply.status !== 200 || reply.noStore !== true ||
        !exactKeys(reply.data, keys)) REFUSE();
    return reply;
  };
  try {
    for (const slot of ['device-a', 'device-b'])
      trackRead(await only(slot, '/api/learning-tracks', ['tracks', 'noteLinkingEnabled']), trackId);
    const initialA = linkRead(await only('device-a', linksPath, ['links', 'warning']), trackId, videoId);
    const initialB = linkRead(await only('device-b', linksPath, ['links', 'warning']), trackId, videoId);
    if (initialA !== initialB) REFUSE();
    verifiedRead(await only('device-a', verifyPath, ['status', 'warning']));
    verifiedRead(await only('device-b', verifyPath, ['status', 'warning']));
    const finalA = linkRead(await only('device-a', linksPath, ['links', 'warning']), trackId, videoId);
    const finalB = linkRead(await only('device-b', linksPath, ['links', 'warning']), trackId, videoId);
    if (finalA !== initialA || finalB !== initialA) REFUSE();
    return Object.freeze({
      format: 'oge-learning-tracks-m101-readonly-hold',
      version: 1,
      runBindingSha256: m101RunBindingDigest(env.OGE_LEARNING_TRACK_M101_RUN_ID, env.OGE_STAGING_URL),
      status: 'TWO_SESSION_LINK_READS_OBSERVED_HOLD',
      stagingSessionsObserved: 2,
      learningTrackListReads: 2,
      metadataLinkReads: 4,
      ownerTriggeredGithubNoteChecks: 2,
      currentNoteObservedAtCheck: true,
      noteOrLinkWritesPerformed: false,
      githubNotesContentInReport: false,
      githubRetryPerformed: false,
      physicalDeviceProvenanceVerified: false,
      oauthIssuerIndependentlyVerified: false,
      providerFaultMatrixVerified: false,
      concurrentWriteConflictsVerified: false,
      independentlyAudited: false,
      productionReady: false,
      restorationAuthorized: false,
      canReleaseQuarantine: false,
    });
  } catch { REFUSE(); } // Never reveal provider raw data, tokens, IDs or cookies
}
