import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';
import {
  VAULT_RESOURCE_BACKUP_COVERAGE,
} from './oge-vault-backup-current-resources.js';

const isolation = /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/;
const forbidden = Object.freeze([
  'OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW',
  'OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW',
  'OGE_VAULT_CUTOVER_GUARD_PREVIEW',
  'OGE_VAULT_ACCOUNT_DELETION_INTERNAL',
  'OGE_ACCOUNT_DELETION_ENABLED',
  'OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
  'OGE_VAULT_SUBJECT_RETIRE_INTERNAL',
]);

/**
 * M87 / E19: Owner-facing informational page ONLY. A genuine Auth.js
 * session and current owner-scoped private GitHub installation are
 * checked in the page BEFORE this model can be displayed.
 *
 * This gate is deliberately stricter than the current-resource download:
 * no restore commit/import ACK, cutover, or destructive flag may be on.
 * No GitHub or MongoDB client is created by this pure capability model.
 */
export function vaultRecoveryCenterStagingAllowed(
  env = {}, readiness = checkVaultStagingReadiness,
) {
  if (env.OGE_VAULT_RECOVERY_CENTER_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      env.OGE_VAULT_NOTE_API_PREVIEW !== 'true' ||
      env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true' ||
      !isolation.test(env.MONGODB_DB || '') ||
      forbidden.some(key => env[key] === 'true') ||
      Boolean(env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK) ||
      typeof readiness !== 'function')
    return false;
  try {
    const staging = new URL(env.OGE_STAGING_URL);
    const auth = new URL(env.AUTH_URL);
    const vault = new URL(env.OGE_VAULT_BASE_URL);
    return staging.protocol === 'https:' &&
      staging.origin === env.OGE_STAGING_URL &&
      !staging.port && !staging.username && !staging.password &&
      staging.pathname === '/' && !staging.search && !staging.hash &&
      /(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(staging.hostname) &&
      staging.hostname !== 'localhost' &&
      staging.hostname !== '127.0.0.1' &&
      auth.origin === staging.origin &&
      env.AUTH_URL === env.OGE_STAGING_URL &&
      vault.origin === staging.origin &&
      env.OGE_VAULT_BASE_URL === env.OGE_STAGING_URL &&
      readiness(env)?.ok === true;
  } catch { return false; }
}

/**
 * The returned object intentionally has no user IDs, Note bodies, Git SHA,
 * credentials, branch name, provider status or approval token. Config gates
 * mean "may REQUEST the existing authenticated download endpoint"—NOT
 * proof that the endpoint will succeed or that an archive is complete.
 */
export function buildVaultRecoveryCenterModel(env = {}, {
  readiness = checkVaultStagingReadiness,
} = {}) {
  if (!vaultRecoveryCenterStagingAllowed(env, readiness))
    throw new TypeError('Private recovery preview unavailable outside isolated staging');

  const backupRequestEnabled =
    env.OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true' &&
    env.OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_PREVIEW === 'true';

  const labels = Object.freeze([
    ['notes', 'Notes'],
    ['quickNotes', 'Quick Notes'],
    ['airNotes', 'AirNotes'],
  ]);
  const resources = labels.map(([key, label]) => {
    if (VAULT_RESOURCE_BACKUP_COVERAGE[key] !==
        'complete-current-github-head')
      throw new TypeError('Current resource backup coverage changed');
    return Object.freeze({
      key, label,
      coverage: 'Current committed GitHub snapshot',
      requestEnabled: backupRequestEnabled,
      contentVerifiedAtRender: false,
    });
  });
  const exclusions = Object.freeze([
    ['historicalRevisions', 'Historical revisions'],
    ['encryptedDrafts', 'Uncommitted encrypted drafts'],
    ['legacyMongoNotes', 'Legacy MongoDB Notes'],
    ['learningProgress', 'Learning Tracks progress'],
  ].map(([key, label]) => {
    if (VAULT_RESOURCE_BACKUP_COVERAGE[key] !== 'not-included')
      throw new TypeError('Current resource backup exclusion changed');
    return Object.freeze({ key, label, included: false });
  }));

  return Object.freeze({
    format: 'oge-vault-owner-recovery-center-readiness',
    version: 1,
    status: 'STAGING_INFORMATION_ONLY_NO_RECOVERY_AUTHORIZATION',
    environment: 'disposable-staging',
    backupRequestEnabled,
    backupRequestNotEquivalentToVerifiedDownload: true,
    resources: Object.freeze(resources),
    exclusions,
    privatePlaintextDownloadedArchiveRequiresProtection: true,
    ownerMustVerifyDownloadedFile: true,
    sourceArchiveIdentityIndependentlyAuthenticated: false,
    entireAccountBackupAvailable: false,
    encryptedDraftsIncluded: false,
    historicalVersionsIncluded: false,
    authenticatedSourceRestorationAvailableHere: false,
    productionRestoreEnabled: false,
    realOAuthTwoPhysicalDeviceAcceptanceComplete: false,
    realGitHubProviderFailureAcceptanceComplete: false,
    uncertainGitHubWriteQuiescenceProven: false,
    operatorUnlockAuthorized: false,
    safeToRetryAutomatically: false,
    quarantineReleasePerformed: false,
    privateNoteContentReadWhileRendering: false,
    githubWritesPerformed: false,
    mongodbWritesPerformed: false,
    secretsOrUserIdentifiersReturned: false,
  });
}
