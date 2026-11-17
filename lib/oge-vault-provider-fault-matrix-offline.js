import { randomUUID } from 'node:crypto';
import {
  vaultGithubRequest, VaultGitHubError,
} from './oge-vault-github.js';
import {
  withVaultOwnerDraftWrite,
  withVaultOwnerImportExclusive,
} from './oge-vault-import-fence.js';

/**
 * E17/M85: strictly IN-MEMORY fault-injection test of the REAL
 * GitHub REST transport + owner-wide Mongo import fence.
 *
 * All GitHub REST requests supply an injected local fetcher. All Mongo
 * updateOne calls use a local JavaScript object. No real token, repo,
 * external network, OAuth client, storage or backend dependency.
 * Passing the matrix is NOT live-provider fault acceptance.
 */
const INITIAL = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const PATH = '/repos/m85-synthetic/ogenotes-vault/git/refs/heads/main';
const URL = 'https://api.github.com' + PATH;
const MARKER = 'Restore OgeNotes backup ' + 'c'.repeat(64);
const ID = '8fca11a5-e2ad-4d4f-9948-6b16ac28ff11';
const OWNER = Object.freeze({
  ownerId: 'synthetic-m85-no-real-user',
  repoId: 85, sessionVersion: '7579aff5-a33a-48df-a7cb-b9310207875c',
});
const SAMPLES = Object.freeze([
  'prewrite-owner-rejected',
  'patch-permission-403',
  'patch-rate-limit-429',
  'patch-secondary-rate-limit-403',
  'patch-stale-head-409',
  'patch-stale-head-422',
  'patch-provider-503',
  'patch-network-disconnected',
  'patch-applied-response-lost',
  'patch-applied-readback-503',
  'patch-success-verified',
  'patch-success-read-get-retry',
]);
const deny = (code) => { throw new TypeError('Synthetic Vault fault matrix: ' + code); };
const ensure = (condition, code) => { if (!condition) deny(code); };

function makeMemoryOwner() {
  const user = {
    googleSub: OWNER.ownerId,
    sessionVersion: OWNER.sessionVersion,
    vault: { status: 'connected', repoId: OWNER.repoId },
    vaultActiveDraftWriters: 0,
  };
  const events = [];
  function match(filter) {
    if (filter.$and && !filter.$and.every(match)) return false;
    if (filter.$or && !filter.$or.some(match)) return false;
    for (const [name, rule] of Object.entries(filter)) {
      if (name === '$and' || name === '$or') continue;
      const actual = name.split('.').reduce((v, field) => v?.[field], user);
      if (rule && typeof rule === 'object' &&
          !(rule instanceof Date)) {
        if (Object.hasOwn(rule, '$exists') &&
            (actual !== undefined) !== rule.$exists) return false;
        if (Object.hasOwn(rule, '$gt') &&
            !(actual > rule.$gt)) return false;
        if (Object.hasOwn(rule, '$ne') &&
            actual === rule.$ne) return false;
      } else if (actual !== rule) return false;
    }
    return true;
  }
  const db = Object.freeze({
    collection(name) {
      if (name !== 'users') deny('unexpected-non-memory-collection');
      return {
        async updateOne(filter, update) {
          if (!match(filter)) return { matchedCount: 0 };
          if (update.$set?.['vaultImportLock.state'] ===
              'github-write-possible') events.push('durable-marker');
          for (const [name, change] of Object.entries(update.$inc || {}))
            user[name] = (user[name] || 0) + change;
          for (const [name, value] of Object.entries(update.$set || {})) {
            const fields = name.split('.'), last = fields.pop();
            let target = user;
            for (const field of fields)
              target = target[field] ||= {};
            target[last] = value;
          }
          for (const name of Object.keys(update.$unset || {})) {
            const fields = name.split('.'), last = fields.pop();
            let target = user;
            for (const field of fields)
              target = target?.[field];
            if (target) delete target[last];
          }
          return { matchedCount: 1 };
        },
      };
    },
  });
  return { db, user, events };
}

function memoryGitHub(mode, events) {
  let head = INITIAL, patchCalls = 0, readCalls = 0;
  const injectedFetcher = async (url, options) => {
    // No function in this module ever uses native fetch. The transport
    // always invokes THIS closed local in-memory fixture.
    ensure(url === URL, 'unexpected-url');
    ensure(options?.headers?.Authorization ===
      'Bearer m85-in-memory-only', 'unexpected-credential');
    const method = options.method;
    if (method === 'GET') {
      readCalls++;
      events.push('read-head');
      if (mode === 'patch-applied-readback-503' ||
          (mode === 'patch-success-read-get-retry' && readCalls === 1))
        return Response.json({ message: 'synthetic' }, { status: 503 });
      return Response.json({ object: { sha: head } });
    }
    ensure(method === 'PATCH', 'unexpected-method');
    patchCalls++;
    events.push('patch-attempt');
    const body = JSON.parse(options.body);
    ensure(Object.keys(body).sort().join(',') === 'force,sha' &&
      body.sha === TARGET && body.force === false,
    'force-or-branch-cas-did-not-match');
    switch (mode) {
      case 'patch-permission-403':
        return Response.json({ message: 'synthetic' }, { status: 403 });
      case 'patch-rate-limit-429':
        return Response.json({ message: 'synthetic' }, {
          status: 429, headers: { 'retry-after': '60' },
        });
      case 'patch-secondary-rate-limit-403':
        return Response.json({ message: 'synthetic' }, {
          status: 403, headers: { 'x-ratelimit-remaining': '0' },
        });
      case 'patch-stale-head-409':
        return Response.json({ message: 'synthetic' }, { status: 409 });
      case 'patch-stale-head-422':
        return Response.json({ message: 'synthetic' }, { status: 422 });
      case 'patch-provider-503':
        return Response.json({ message: 'synthetic' }, { status: 503 });
      case 'patch-network-disconnected':
        throw new TypeError('synthetic transport lost');
      case 'patch-applied-response-lost':
        head = TARGET;
        throw new TypeError('synthetic acknowledgment lost after apply');
      case 'patch-applied-readback-503':
      case 'patch-success-verified':
      case 'patch-success-read-get-retry':
        head = TARGET;
        return Response.json({ object: { sha: head } });
      default:
        deny('unknown-fixture-mode');
    }
  };
  return {
    injectedFetcher,
    get head() { return head; },
    get patchCalls() { return patchCalls; },
    get readCalls() { return readCalls; },
  };
}

async function runScenario(mode) {
  const { db, user, events } = makeMemoryOwner();
  const github = memoryGitHub(mode, events);
  let failure = null, committed = false;
  try {
    await withVaultOwnerImportExclusive(db, OWNER,
      async ({ markGitHubWriteAttempt }) => {
        if (mode === 'prewrite-owner-rejected')
          throw new VaultGitHubError('synthetic-owner-revoked-before-git', 409);
        await markGitHubWriteAttempt(MARKER, {
          expectedHead: INITIAL, selectedIds: [ID],
        });
        await vaultGithubRequest(PATH, {
          token: 'm85-in-memory-only', method: 'PATCH',
          body: { sha: TARGET, force: false },
          fetcher: github.injectedFetcher,
        });
        const current = await vaultGithubRequest(PATH, {
          token: 'm85-in-memory-only', method: 'GET',
          fetcher: github.injectedFetcher,
        });
        if (current?.object?.sha !== TARGET)
          throw new VaultGitHubError('synthetic-readback-unverified', 503);
        committed = true;
        return 'synthetic-verified';
      },
      { operationId: randomUUID() });
  } catch (error) { failure = error; }

  const safePrewrite = mode === 'prewrite-owner-rejected';
  const verified = ['patch-success-verified',
    'patch-success-read-get-retry'].includes(mode);
  const quarantined = !safePrewrite && !verified;
  const lock = user.vaultImportLock;
  ensure(github.patchCalls === (safePrewrite ? 0 : 1),
    'unexpected-patch-retry');
  ensure((failure === null) === verified, 'unexpected-success-or-failure');
  ensure(committed === verified, 'unverified-commit-acknowledged');
  ensure(Boolean(lock) === quarantined, 'unexpected-lock-release');
  ensure(events.filter(e => e === 'durable-marker').length ===
    (safePrewrite ? 0 : 1), 'durable-marker-count');
  if (!safePrewrite)
    ensure(events.indexOf('durable-marker') <
      events.indexOf('patch-attempt'), 'patch-before-durable-marker');
  if (quarantined) {
    ensure(lock.state === 'github-write-possible' &&
      lock.commitMarker === MARKER &&
      lock.approvedHead === INITIAL &&
      lock.selectedIds.length === 1 &&
      lock.selectedIds[0] === ID, 'quarantine-evidence-unmatched');
    ensure(failure instanceof VaultGitHubError &&
      failure.status === 503 &&
      failure.message === 'vault-import-write-outcome-unconfirmed-lock-retained',
    'uncertain-write-did-not-fail-closed');
    await withVaultOwnerDraftWrite(db, OWNER, async () =>
      deny('draft-writer-was-allowed')).then(
      () => deny('draft-write-permitted-under-quarantine'),
      err => ensure(err?.status === 409, 'draft-fence-not-enforced'));
    await withVaultOwnerImportExclusive(db, OWNER, async () =>
      deny('repeat-restore-was-allowed')).then(
      () => deny('repeat-import-permitted-under-quarantine'),
      err => ensure(err?.status === 409, 'repeat-import-not-denied'));
  } else {
    ensure(lock === undefined, 'safe-local-fence-not-cleared');
  }
  ensure(github.patchCalls === (safePrewrite ? 0 : 1),
    'unexpected-patch-after-blocked-retry');
  ensure(user.vaultActiveDraftWriters === 0,
    'draft-counter-corrupted');

  return {
    scenario: mode,
    simulatedOnly: true,
    expectedFailureOrPrewriteDenialObserved: !verified,
    expectedSuccessVerificationObserved: verified,
    syntheticPatchAttemptCount: github.patchCalls,
    syntheticReadbackAttempts: github.readCalls,
    durableMarkerRecordedBeforePatch: !safePrewrite,
    syntheticRemoteRefAdvanced: github.head === TARGET,
    uncertainWriteQuarantineRetained: quarantined,
    syntheticSafePrewriteFenceReleased: safePrewrite,
    syntheticVerifiedSuccessFenceReleased: verified,
    failedWriteCanBeRetriedAutomatically: false,
    automaticPostwriteUnlockAuthorized: false,
    realGitHubRequestsPerformed: false,
    realMongoRequestsPerformed: false,
  };
}

/**
 * No remote service access is possible. This intentionally invokes the
 * production GitHub transport and Mongo import-fence APIs WITH 100%
 * in-memory dependencies and asserts behavior for every fault.
 */
export async function runVaultSyntheticProviderFaultMatrix() {
  const outcomes = [];
  for (const scenario of SAMPLES)
    outcomes.push(await runScenario(scenario));
  return {
    format: 'oge-vault-provider-fault-matrix-offline',
    version: 1,
    status: 'TWELVE_SYNTHETIC_SCENARIOS_VERIFIED_REAL_PROVIDER_PENDING_HOLD',
    syntheticScenarioCount: outcomes.length,
    scenarios: outcomes,
    allSyntheticInvariantsVerified: true,
    noRealGitHubOrMongoClientsUsed: true,
    real403429409422ScenariosExecuted: false,
    realOAuthOrAppRevocationTested: false,
    actualLostGitHubAcknowledgmentInduced: false,
    independentlyEstablishedWorkerQuiescence: false,
    signedTwoPhysicalDeviceAcceptanceComplete: false,
    safeToRetryAutomatically: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    productionReady: false,
    canEnableProduction: false,
    canReleaseImportLock: false,
    externalWritesPerformed: false,
  };
}
