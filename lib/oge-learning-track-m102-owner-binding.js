import { createHmac, timingSafeEqual } from 'node:crypto';
import { learningTrackNoteLinksEnabled } from './oge-learning-track-note-links.js';
import { m101ReadOnlyStagingGuard, m101RunBindingDigest } from './oge-learning-track-m101-readonly-acceptance.js';

/**
 * M102: server-derived opaque, run-scoped comparison of two signed sessions.
 * This proves only that the trusted staging server resolved the SAME active
 * account/session generation and currently mapped Vault across observations.
 * It is not a physical-device, OAuth issuer, or independently signed proof.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECRET = /^[a-f0-9]{64}$/i;
const HEX = /^[a-f0-9]{64}$/;
const REFUSE = () => { throw new TypeError('M102 owner binding HOLD: incomplete or unsafe'); };
const OPT_IN = 'YES_COMPARE_EXISTING_DISPOSABLE_SESSIONS_READ_ONLY';

const STAGING_HOST = /(?:^|[.-])(staging|preview)(?:[.-]|$)/i;
function explicitlyStaging(origin) {
  try { return STAGING_HOST.test(new URL(origin).hostname); }
  catch { return false; }
}
export function m102OwnerBindingServerEnabled(env = process.env, readiness = learningTrackNoteLinksEnabled) {
  return env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW === 'true' &&
    explicitlyStaging(env.OGE_STAGING_URL) &&
    m101ReadOnlyStagingGuard(env, readiness) &&
    SECRET.test(env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY || '');
}
export function m102OperatorBindingEnabled(env = {}, readiness) {
  return env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW === 'true' &&
    explicitlyStaging(env.OGE_STAGING_URL) &&
    env.OGE_LEARNING_TRACK_M102_OPERATOR_ACK === OPT_IN &&
    m101ReadOnlyStagingGuard(env, readiness);
}
function validOwnerRecord(identity, owner, env) {
  return UUID.test(env.OGE_LEARNING_TRACK_M101_RUN_ID || '') &&
    typeof identity?.ownerId === 'string' &&
    identity.ownerId.length > 0 && identity.ownerId.length <= 200 &&
    (identity.sessionVersion === 0 ||
      (typeof identity.sessionVersion === 'string' && UUID.test(identity.sessionVersion))) &&
    owner?.vault?.status === 'connected' &&
    Number.isSafeInteger(owner.vault.repoId) && owner.vault.repoId > 0 &&
    Number.isSafeInteger(owner.vault.installationId) && owner.vault.installationId > 0 &&
    typeof owner.vault.githubAccountId === 'string' &&
    /^[1-9][0-9]*$/.test(owner.vault.githubAccountId) &&
    owner.vault.repoName === 'ogenotes-vault' &&
    typeof owner.vault.githubLogin === 'string' &&
    /^[a-zA-Z0-9-]{1,39}$/.test(owner.vault.githubLogin);
}
export function m102OwnerBindingTag(identity, owner, env = {}, readiness = learningTrackNoteLinksEnabled) {
  if (!m102OwnerBindingServerEnabled(env, readiness) || !validOwnerRecord(identity, owner, env))
    REFUSE();
  // Structured encoding avoids delimiter ambiguity. The key never leaves
  // the staging server. A run ID alone cannot authorize account access.
  const components = [
    'oge-learning-track-m102-binding-v1',
    env.OGE_STAGING_URL,
    env.OGE_LEARNING_TRACK_M101_RUN_ID,
    identity.ownerId,
    String(identity.sessionVersion),
    String(owner.vault.repoId),
    String(owner.vault.installationId),
    owner.vault.githubAccountId,
    owner.vault.githubLogin,
    owner.vault.repoName,
  ];
  return createHmac('sha256', Buffer.from(env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY, 'hex'))
    .update(JSON.stringify(components)).digest('hex');
}
function bindingResponse(reply) {
  if (!reply || reply.status !== 200 || reply.noStore !== true ||
      !reply.data || typeof reply.data !== 'object' ||
      Array.isArray(reply.data) ||
      Object.keys(reply.data).sort().join(',') !== 'bindingSha256,releaseAuthorized,status' ||
      reply.data.status !== 'OWNER_VAULT_SESSION_MAPPING_OBSERVED_HOLD' ||
      reply.data.releaseAuthorized !== false ||
      typeof reply.data.bindingSha256 !== 'string' ||
      !HEX.test(reply.data.bindingSha256)) REFUSE();
  return reply.data.bindingSha256;
}
function sameTag(left, right) {
  return HEX.test(left || '') && HEX.test(right || '') &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Run M101 unchanged between before/after binding observations. No additional
 * GitHub requests or writes: four bounded owner-binding GETs + M101's 8 GETs.
 * This narrows active owner/installation mapping races but cannot create
 * an atomic snapshot across provider, MongoDB, or session state.
 */
export async function executeM102StagingOwnerBinding({
  env = {}, invokeBinding, executeM101, readiness,
} = {}) {
  if (!m102OperatorBindingEnabled(env, readiness) ||
      typeof invokeBinding !== 'function' ||
      typeof executeM101 !== 'function') REFUSE();
  try {
    const beforeA = bindingResponse(await invokeBinding('device-a'));
    const beforeB = bindingResponse(await invokeBinding('device-b'));
    if (!sameTag(beforeA, beforeB)) REFUSE();
    const core = await executeM101();
    if (core?.status !== 'TWO_SESSION_LINK_READS_OBSERVED_HOLD' ||
        core?.productionReady !== false ||
        core?.noteOrLinkWritesPerformed !== false ||
        core?.githubRetryPerformed !== false ||
        core?.restorationAuthorized !== false ||
        core?.canReleaseQuarantine !== false ||
        core?.physicalDeviceProvenanceVerified !== false ||
        core?.oauthIssuerIndependentlyVerified !== false) REFUSE();
    const afterA = bindingResponse(await invokeBinding('device-a'));
    const afterB = bindingResponse(await invokeBinding('device-b'));
    if (!sameTag(beforeA, afterA) || !sameTag(beforeA, afterB)) REFUSE();
    return Object.freeze({
      format: 'oge-learning-track-m102-same-owner-vault-hold',
      version: 1,
      status: 'SAME_ACTIVE_OWNER_VAULT_MAPPING_OBSERVED_HOLD',
      runBindingSha256: m101RunBindingDigest(
        env.OGE_LEARNING_TRACK_M101_RUN_ID, env.OGE_STAGING_URL),
      ownerBindingReads: 4,
      learningTrackReads: 2,
      linkMetadataReads: 4,
      githubNoteVerificationReads: 2,
      stagingSessionsObserved: 2,
      sameActiveOwnerVaultMappingObservedAtChecks: true,
      actualOAuthIssuerVerified: false,
      twoPhysicalDevicesIndependentlyVerified: false,
      concurrentMutationAcceptanceVerified: false,
      providerFailureAcceptanceVerified: false,
      independentSecurityReviewCompleted: false,
      noteOrLinkWritesPerformed: false,
      githubRetryPerformed: false,
      restorationAuthorized: false,
      canReleaseQuarantine: false,
      productionReady: false,
    });
  } catch { REFUSE(); } // No raw identifier, HMAC tag, session or provider error in logs
}
