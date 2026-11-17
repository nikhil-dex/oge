import { createHash } from 'node:crypto';
import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';
import { inspectVaultProviderReadOnlyPair } from './oge-vault-live-provider-probe.js';

/**
 * E14 / M82: one-device-at-a-time signed-owner HTTPS staging browser drill.
 * Configuration check is read-only; no write-scoped provider token, Notes
 * bodies, drafts, OAuth tokens, persistent session/device marker or lock
 * release. The browser-provided device slot is only an UNTRUSTED LABEL.
 */
const CHALLENGE = /^[a-f0-9]{64}$/;
const DEVICE = new Set(['device-a', 'device-b']);
const sha = (value) => createHash('sha256')
  .update('oge-vault-signed-acceptance-read-m82-v1\n')
  .update(value).digest('hex');

/**
 * Check exact dedicated staging origin, isolated DB and opt-in.
 * NO production URL, restore write ACK, cutover, destructive operations.
 */
export function signedDeviceAcceptanceReadAllowed(request, {
  env = process.env,
  readiness = checkVaultStagingReadiness,
} = {}) {
  if (env.OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      env.OGE_VAULT_NOTE_API_PREVIEW !== 'true' ||
      env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true' ||
      env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW === 'true' ||
      env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK ||
      env.OGE_VAULT_CUTOVER_GUARD_PREVIEW === 'true' ||
      env.OGE_VAULT_ACCOUNT_DELETION_INTERNAL === 'true' ||
      env.OGE_ACCOUNT_DELETION_ENABLED === 'true' ||
      env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL === 'true' ||
      env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL === 'true' ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
        env.MONGODB_DB || '') ||
      env.OGE_STAGING_URL !== env.AUTH_URL ||
      !readiness(env)?.ok)
    return false;
  try {
    const target = new URL(env.OGE_STAGING_URL);
    const base = new URL(env.OGE_VAULT_BASE_URL);
    const from = new URL(request.url);
    return target.protocol === 'https:' &&
      !target.username && !target.password &&
      target.pathname === '/' && !target.search && !target.hash &&
      !target.port &&
      target.origin === base.origin &&
      target.origin === from.origin &&
      request.headers.get('origin') === target.origin;
  } catch { return false; }
}

/**
 * Read both independently issued contents:read GitHub App clients.
 * A user-chosen slot and challenge CANNOT prove separate physical devices.
 * Provider proof uses immutable ref/commit/tree reads + owner rechecks.
 */
export async function inspectSignedDeviceAcceptanceReadOnly(
  first, second, { ownerVerifier, challenge, deviceSlot } = {},
) {
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge) ||
      !DEVICE.has(deviceSlot))
    throw new TypeError('Exact 32-byte nonce and declared device slot required');
  const inspected = await inspectVaultProviderReadOnlyPair(
    first, second, { ownerVerifier });
  if (inspected.format !== 'oge-vault-live-provider-read-only-probe' ||
      inspected.version !== 1 ||
      inspected.signedPrivateRepoMappingObserved !== true ||
      inspected.twoIndependentReadOnlyClientsObserved !== true ||
      inspected.sameGitHubBranchAndCommitTreeObserved !== true ||
      inspected.signedOwnerMappingStable !== true ||
      inspected.githubWritesPerformed !== false ||
      inspected.writeTokenRequested !== false ||
      inspected.canReleaseImportLock !== false ||
      inspected.canRetryAutomatically !== false)
    throw new TypeError('Read-only provider observation not fully verified');

  return Object.freeze({
    format: 'oge-vault-signed-device-acceptance-observation',
    version: 1,
    status: 'SIGNED_SESSION_PRIVATE_GITHUB_READ_OBSERVED_PENDING_EXTERNAL_ACCEPTANCE',
    declaredDeviceSlot: deviceSlot,
    deviceSlotProvesPhysicalDevice: false,
    challengeFingerprint: sha(challenge),
    challengeUniquenessAcrossDevicesVerified: false,
    signedOwnerScopedSessionObserved: true,
    privateGitHubAppReadOnlyPairObserved: true,
    privateGitHubHeadTreeConsistentDuringCheck: true,
    ownerAndGitHubInstallationMappingStableDuringCheck: true,
    actualOAuthProviderIndependentlyVerified: false,
    physicalDeviceIdentityIndependentlyVerified: false,
    twoDistinctPhysicalDeviceSessionsVerified: false,
    multiDeviceAutosaveAndConflictFlowVerified: false,
    sourceArchiveIdentityVerified: false,
    unexpectedGitHubWriteOutcomeResolved: false,
    realProviderFaultMatrixVerified: false,
    completeStagingAcceptanceSignedOff: false,
    productionReady: false,
    canAuthorizeGitHubWrites: false,
    canAuthorizeRestore: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    readOnly: true,
    githubWritesPerformed: false,
    mongodbWritesPerformed: false,
    privateNotesRead: false,
    secretsOrOwnerIdReturned: false,
  });
}
