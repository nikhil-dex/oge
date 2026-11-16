import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';

/**
 * M51: configuration-only gate for a SYNTHETIC authenticated import rehearsal.
 * The existing Save preflight already enforces isolated staging URLs, RSA
 * signing credentials, the independent encrypted draft key, and disabled
 * destructive routes. This stricter import preflight additionally requires
 * every dependent preview gate and an explicit synthetic-only acknowledgment.
 *
 * This does NOT call GitHub or MongoDB, inspect user data, mint credentials,
 * permit enabling flags in production or constitute authenticated signoff.
 */
export function checkVaultImportStagingReadiness(env = {}) {
  const base = checkVaultStagingReadiness(env);
  const failures = [...base.failures], warnings = [...base.warnings];
  const flag = (key) => env[key] === 'true';
  const required = [
    'OGE_VAULT_NOTE_API_PREVIEW',
    'OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW',
    'OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW',
  ];
  for (const key of required) {
    if (!flag(key)) failures.push({
      code: 'import-gate-' + key.toLowerCase().replaceAll('_', '-'),
      message: key + ' must be enabled ONLY on the isolated synthetic staging deployment.',
    });
  }
  if (env.OGE_VAULT_IMPORT_STAGING_ACK !== 'ISOLATED_SYNTHETIC_ACCOUNTS_ONLY')
    failures.push({
      code: 'import-synthetic-acknowledgment',
      message: 'A deliberate synthetic staging-only acknowledgment is required.',
    });

  for (const key of [
    'OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
    'OGE_VAULT_SUBJECT_RETIRE_INTERNAL',
    'OGE_ACCOUNT_DELETION_ENABLED',
    'OGE_VAULT_PREWRITE_RELEASE_STAGING_ONLY',
  ]) {
    if (env[key] && !['false', ''].includes(env[key]))
      failures.push({
        code: 'import-destructive-or-operator-recovery-enabled',
        message: 'No destructive or manual lock-release controls belong in an import rehearsal.',
      });
  }

  warnings.push({
    code: 'import-real-credentials-and-two-devices-unverified',
    message: 'A passing configuration cannot prove OAuth, private GitHub App installation, two authenticated browsers, real conflict/rate-limit handling, or writer quiescence.',
  });
  return {
    ok: failures.length === 0,
    failures, warnings,
    evidence: 'configuration-only',
    liveProviderVerified: false,
    authenticatedBrowserVerified: false,
    twoDeviceSignedAcceptanceComplete: false,
    productionImportAuthorized: false,
    productionCutoverAuthorized: false,
    importPreviewEnabledHere: required.every(flag),
  };
}
