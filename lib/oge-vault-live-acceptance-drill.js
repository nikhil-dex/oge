import { randomBytes } from 'node:crypto';
import {
  assertVaultSignedDeviceObservation,
} from './oge-vault-two-device-acceptance-readiness.js';

/**
 * E16/M84: operator-directed, ACTUAL protected HTTPS staging READ drill.
 * Calls only the existing M82 POST with two operator-provided signed-in
 * session states. It does not sign into OAuth, prove physical device origin,
 * call GitHub directly, create any Note, or use a provider write token.
 * Remote endpoint may perform normal read telemetry/rate-limit bookkeeping.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STAGING_DB = /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/;
const HOST_STAGING = /(?:^|[.-])(staging|preview)(?:[.-]|$)/i;
const SOURCE = 'oge-vault-signed-acceptance-live-read-only-drill';
const deny = () => { throw new TypeError(
  'Isolated authenticated staging read-only drill unavailable or unsafe'); };
const forbidden = [
  'OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW',
  'OGE_VAULT_CUTOVER_GUARD_PREVIEW',
  'OGE_ACCOUNT_DELETION_ENABLED',
  'OGE_VAULT_ACCOUNT_DELETION_INTERNAL',
  'OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
  'OGE_VAULT_SUBJECT_RETIRE_INTERNAL',
];

/**
 * Validate only operator-supplied STAGING metadata; this cannot verify
 * provider-side flags or deployment origin independently.
 */
export function checkVaultLiveAcceptanceDrillGuard(env = {}) {
  if (env.OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL !==
        'YES_TWO_PRIVATE_STAGING_SESSIONS_READ_ONLY' ||
      env.OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW !== 'true' ||
      !STAGING_DB.test(env.MONGODB_DB || '') ||
      !UUID.test(env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID || '') ||
      forbidden.some((key) => env[key] === 'true') ||
      Boolean(env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK))
    return false;
  try {
    const origin = new URL(env.OGE_STAGING_URL);
    const auth = new URL(env.AUTH_URL);
    const vault = new URL(env.OGE_VAULT_BASE_URL);
    return origin.protocol === 'https:' &&
      origin.origin === env.OGE_STAGING_URL &&
      origin.hostname !== 'localhost' &&
      origin.hostname !== '127.0.0.1' &&
      HOST_STAGING.test(origin.hostname) &&
      !origin.username && !origin.password && !origin.port &&
      !origin.search && !origin.hash && origin.pathname === '/' &&
      auth.origin === origin.origin && env.AUTH_URL === env.OGE_STAGING_URL &&
      vault.origin === origin.origin &&
      env.OGE_VAULT_BASE_URL === env.OGE_STAGING_URL;
  } catch { return false; }
}

/**
 * invoke is a transport callback. On real staging, it is wired only to
 * Playwright APIRequestContext POST /api/vault/acceptance/signed-device-read,
 * with a separate pre-authenticated private storage state for each slot.
 *
 * Returns exact redacted M82 observations and raw RANDOM challenges for
 * saving to two separate private on-disk operator files. Caller MUST NOT
 * emit challenges, credentials or raw HTTP response body to stdout/logs.
 */
export async function executeVaultLiveAcceptanceReadOnlyDrill({
  env, invoke, nonceSource = randomBytes,
} = {}) {
  if (!checkVaultLiveAcceptanceDrillGuard(env) ||
      typeof invoke !== 'function' ||
      typeof nonceSource !== 'function') deny();

  const challengeA = nonceSource(32);
  const challengeB = nonceSource(32);
  if (!Buffer.isBuffer(challengeA) || challengeA.length !== 32 ||
      !Buffer.isBuffer(challengeB) || challengeB.length !== 32 ||
      challengeA.equals(challengeB)) deny();
  const rawA = challengeA.toString('hex');
  const rawB = challengeB.toString('hex');
  const observations = {};
  try {
    for (const [slot, nonce] of [
      ['device-a', rawA], ['device-b', rawB],
    ]) {
      // No retries: provider read races, 401, 403, 429, redirect to OAuth,
      // timeout and 5xx must be treated as inconclusive/failed evidence.
      const response = await invoke(slot, nonce);
      if (!response || response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.contentType || '') ||
          !response.json || typeof response.json !== 'object' ||
          Array.isArray(response.json)) deny();
      assertVaultSignedDeviceObservation(response.json, slot, nonce);
      observations[slot] = response.json;
    }
  } catch { deny(); }

  const runId = env.OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID;
  return {
    pair: {
      format: 'oge-vault-signed-device-acceptance-pair',
      version: 1, runId, origin: env.OGE_STAGING_URL,
      observations,
    },
    operatorChallenges: {
      format: 'oge-vault-read-only-staging-operator-challenges',
      version: 1, runId,
      'device-a': rawA, 'device-b': rawB,
    },
    safeSummary: {
      format: SOURCE, version: 1,
      status: 'TWO_SIGNED_STAGING_SESSION_READS_RECORDED_PENDING_EXTERNAL_REVIEW',
      observedSessionStateCount: 2,
      requestedProviderWrites: false,
      twoStorageStatesMustBeIndependentlyCaptured: true,
      distinctStorageStateCookiesIndependentlyVerifiedByProvider: false,
      twoPhysicalDevicesIndependentlyVerified: false,
      actualOAuthIssuersIndependentlyVerified: false,
      sessionSourceProvenanceVerified: false,
      onDiskM67M68EvidenceMatrixVerified: false,
      realProviderFaultMatrixExecuted: false,
      realGitHubUnknownWriteQuiescenceProven: false,
      completeStagingAcceptanceSignedOff: false,
      productionReady: false, canEnableProduction: false,
      canAuthorizeRestore: false, canReleaseImportLock: false,
      canRetryUnknownWrite: false,
      serverSideReadsObservedOnly: true,
      noteContentsFetched: false,
      browserSessionTokensReturned: false,
      githubWritesPerformed: false,
    },
  };
}
