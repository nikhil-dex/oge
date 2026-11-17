import { createHash } from 'node:crypto';
import { inspectVaultProviderReadOnlyPair } from './oge-vault-live-provider-probe.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANON_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BRANCH = /^[a-zA-Z0-9_.-]{1,100}$/;
const SCOPE_KEYS = [
  'origin', 'runId', 'repoId', 'installationId',
  'githubAccountId', 'branch', 'expectedHead',
];
const PLAN_KEYS = [
  'format', 'version', ...SCOPE_KEYS, 'expiresAt',
  'operatorReviewSha256', 'independentReviewSha256',
  'confirmation',
];
const SENTINEL_KEYS = [
  'format', 'version', ...SCOPE_KEYS, 'expiresAt', 'confirmation',
];
const SENTINEL = '.ogenotes/fault-test-sentinel.json';
const VISIBLE = new Set([
  'README.md', '.gitignore', '.ogenotes/vault.json', SENTINEL,
]);
const SENTINEL_CONFIRM =
  'DISPOSABLE_PRIVATE_GITHUB_VAULT_NO_REAL_USER_NOTES';
const PLAN_CONFIRM =
  'INSPECT_DISPOSABLE_FAULT_STAGING_NO_WRITES_OR_UNLOCK';
const fail = () => { throw new TypeError(
  'Disposable fault staging evidence unsafe or provider mapping inconsistent'); };
const exact = (v, fields) => Boolean(
  v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...fields].sort().join(','));
const time = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) fail();
  const t = Date.parse(v);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== v) fail();
  return t;
};
const validateOrigin = (origin) => {
  try {
    if (typeof origin !== 'string') fail();
    const u = new URL(origin);
    if (u.protocol !== 'https:' || u.origin !== origin ||
        u.username || u.password || u.search || u.hash || u.port ||
        u.pathname !== '/' || !/(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(u.hostname) ||
        ['localhost', '127.0.0.1'].includes(u.hostname)) fail();
  } catch { fail(); }
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Validate narrow operator plan under INDEPENDENT, separately supplied
 * expected scope. These are LOCAL assertions, not authorization or
 * cryptographic proof of genuine human approval.
 */
export function validateVaultDisposableFaultPlan(plan, expectedScope, {
  now = Date.now(),
} = {}) {
  if (!exact(plan, PLAN_KEYS) || !exact(expectedScope, SCOPE_KEYS) ||
      plan.format !== 'oge-vault-disposable-fault-staging-plan' ||
      plan.version !== 1 || plan.confirmation !== PLAN_CONFIRM ||
      !CANON_UUID.test(plan.runId || '') ||
      !Number.isSafeInteger(plan.repoId) || plan.repoId <= 0 ||
      !Number.isSafeInteger(plan.installationId) ||
      plan.installationId <= 0 ||
      !/^[1-9]\d{0,18}$/.test(plan.githubAccountId || '') ||
      !BRANCH.test(plan.branch || '') ||
      plan.branch.startsWith('-') || plan.branch.includes('..') ||
      !SHA.test(plan.expectedHead || '') ||
      !SHA256.test(plan.operatorReviewSha256 || '') ||
      !SHA256.test(plan.independentReviewSha256 || '') ||
      plan.operatorReviewSha256 === plan.independentReviewSha256 ||
      !Number.isSafeInteger(now) ||
      SCOPE_KEYS.some(key => plan[key] !== expectedScope[key]))
    fail();
  validateOrigin(plan.origin);
  const expires = time(plan.expiresAt);
  if (expires <= now || expires > now + 24 * 60 * 60 * 1000) fail();
  return {
    scope: Object.freeze(Object.fromEntries(
      SCOPE_KEYS.map(key => [key, plan[key]]))),
    expiresAt: plan.expiresAt,
  };
}

function readSentinelBlob(blob, expectedSha, plan) {
  if (!blob || blob.sha !== expectedSha ||
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string' ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 120 || blob.size > 2048 ||
      blob.content.length > 4096) fail();
  const raw = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  if (raw.length !== blob.size) fail();
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { fail(); }
  raw.fill(0);
  if (!exact(parsed, SENTINEL_KEYS) ||
      parsed.format !== 'oge-vault-disposable-fault-sentinel' ||
      parsed.version !== 1 || parsed.confirmation !== SENTINEL_CONFIRM ||
      parsed.expiresAt !== plan.expiresAt ||
      SCOPE_KEYS.some(key => parsed[key] !== plan[key])) fail();
  return true;
}

function checkTree(tree, expectedSha) {
  if (!tree || tree.sha !== expectedSha || tree.truncated !== false ||
      !Array.isArray(tree.tree) || tree.tree.length < 3 ||
      tree.tree.length > 6) fail();
  const seen = new Set(), leaves = new Map();
  for (const item of tree.tree) {
    if (!item || typeof item.path !== 'string' ||
        seen.has(item.path)) fail();
    seen.add(item.path);
    if (item.path === '.ogenotes') {
      if (item.type !== 'tree' ||
          (item.mode !== undefined && item.mode !== '040000') ||
          !SHA.test(item.sha || '')) fail();
      continue;
    }
    if (!VISIBLE.has(item.path) ||
        item.type !== 'blob' ||
        (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') ||
        (item.size !== undefined && (
          !Number.isSafeInteger(item.size) ||
          item.size < 0 || item.size > 2048))) fail();
    leaves.set(item.path, item.sha);
  }
  if (!seen.has('.ogenotes') ||
      !leaves.has('.ogenotes/vault.json') ||
      !leaves.has(SENTINEL)) fail();
  return leaves.get(SENTINEL);
}

/**
 * Real read-only provider inspection; requires TWO independent GitHub
 * contents:read clients, independently pinned owner verifier, approved
 * disposable plan and owner/repo/installation values from the operator.
 *
 * GET repository metadata, immutable tree and immutable sentinel blob.
 * Never reads Notes, never obtains write tokens, no import-lock release.
 * Even perfect metadata is ONLY a point-in-time snapshot.
 */
export async function inspectVaultDisposableFaultStagingReadOnly(
  first, second, plan, {
    expectedScope, ownerVerifier, now = Date.now(),
  } = {},
) {
  const approved = validateVaultDisposableFaultPlan(
    plan, expectedScope, { now });
  if (typeof ownerVerifier !== 'function' ||
      !first?.readOnly || !second?.readOnly || first === second ||
      first.branch !== plan.branch || second.branch !== plan.branch ||
      first.vault?.repoName !== 'ogenotes-vault' ||
      first.vault?.repoId !== plan.repoId ||
      first.vault?.installationId !== plan.installationId ||
      first.vault?.githubAccountId !== plan.githubAccountId ||
      second.vault?.repoId !== plan.repoId ||
      second.vault?.installationId !== plan.installationId ||
      second.vault?.githubAccountId !== plan.githubAccountId) fail();

  const observed = await inspectVaultProviderReadOnlyPair(first, second, {
    ownerVerifier,
  });
  if (observed.githubWritesPerformed !== false ||
      observed.sameGitHubBranchAndCommitTreeObserved !== true ||
      observed.signedOwnerMappingStable !== true ||
      observed.canReleaseImportLock !== false) fail();

  const repoA = await first.call('');
  const repoB = await second.call('');
  for (const repo of [repoA, repoB]) {
    if (repo?.id !== plan.repoId || repo.private !== true ||
        repo.archived === true || repo.disabled === true ||
        String(repo.owner?.id) !== plan.githubAccountId ||
        repo.owner?.login !== first.vault.githubLogin ||
        repo.name !== 'ogenotes-vault' ||
        repo.default_branch !== plan.branch) fail();
  }
  const refPath = '/git/ref/heads/' + encodeURIComponent(plan.branch);
  const firstHead = await first.call(refPath);
  if (firstHead?.object?.sha !== plan.expectedHead) fail();
  const commit = await first.call('/git/commits/' + plan.expectedHead);
  const treeSha = commit?.tree?.sha;
  if (!SHA.test(treeSha || '')) fail();
  const gitTree = await first.call('/git/trees/' + treeSha + '?recursive=1');
  const sentinelSha = checkTree(gitTree, treeSha);
  const blob = await second.call('/git/blobs/' + sentinelSha);
  readSentinelBlob(blob, sentinelSha, plan);

  if ((await second.call(refPath))?.object?.sha !== plan.expectedHead ||
      (await first.call(refPath))?.object?.sha !== plan.expectedHead ||
      await ownerVerifier() !== true || time(approved.expiresAt) <= Date.now())
    fail();

  return Object.freeze({
    format: 'oge-vault-disposable-fault-staging-preflight',
    version: 1,
    status: 'PRIVATE_DISPOSABLE_REPO_METADATA_OBSERVED_FAULT_WRITES_NOT_AUTHORIZED_HOLD',
    signedOwnerScopeAndTwoReadOnlyGitHubClientsObserved: true,
    independentOperatorScopeMatchedLocalPlan: true,
    declaredTwoReviewDigestsDistinct: true,
    genuineHumanApprovalsIndependentlyVerified: false,
    privateRepoAndInstallationMappingStable: true,
    defaultBranchImmutableHeadMatchedAtInspection: true,
    exactDisposableSentinelClaimAndBlobMatched: true,
    boundedAllowlistedTreeWithoutNotePathsObserved: true,
    liveProviderMetadataReadOnlyObserved: true,
    actualGitHubWritesOrFailureInjectionExecuted: false,
    realUserDataAbsenceOutsideInspectedGitTreeProven: false,
    pendingAsyncGitHubWritesQuiescedProven: false,
    futureRepoChangesPrevented: false,
    independentActualOAuthAndTwoDeviceAcceptancePassed: false,
    operatorFaultInjectionPermissionGranted: false,
    safeToRetryAutomatically: false,
    operatorUnlockAuthorized: false,
    automaticUnlockAuthorized: false,
    canReleaseImportLock: false,
    canEnableProduction: false,
    readOnly: true,
    noPrivateNoteBodyRead: true,
    noOwnerRepoOrCommitShaReturned: true,
    githubWritesPerformed: false,
    mongoWritesPerformed: false,
  });
}
