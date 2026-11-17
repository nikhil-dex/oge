#!/usr/bin/env node
/**
 * M85/E17: deterministic OFFLINE in-memory fault matrix ONLY.
 * No HTTP, provider credentials, MongoDB client, GitHub App or real
 * repository. A successful run exits 2 (HOLD for real acceptance), never 0.
 */
import { runVaultSyntheticProviderFaultMatrix } from
  '../lib/oge-vault-provider-fault-matrix-offline.js';

const env = process.env;
const allowed =
  env.OGE_VAULT_OFFLINE_PROVIDER_FAULT_MATRIX ===
    'YES_TWELVE_SYNTHETIC_NO_NETWORK_SCENARIOS_ONLY' &&
  env.MONGODB_DB === 'oge_vault_restore_staging_faultmatrix' &&
  env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' &&
  !env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK &&
  env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
  env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
  env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
  env.OGE_VAULT_ACCOUNT_DELETION_INTERNAL !== 'true';

if (!allowed) {
  console.error('BLOCKED: synthetic-only Vault failure matrix requires explicit isolated opt-in.');
  process.exitCode = 1;
} else {
  try {
    const report = await runVaultSyntheticProviderFaultMatrix();
    if (report.syntheticScenarioCount !== 12 ||
        report.allSyntheticInvariantsVerified !== true ||
        report.noRealGitHubOrMongoClientsUsed !== true ||
        report.operatorUnlockAuthorized !== false ||
        report.canEnableProduction !== false)
      throw new TypeError('Incomplete synthetic matrix');
    console.log(JSON.stringify(report, null, 2));
    // HOLD: synthetic pass is not actual GitHub App/OAuth acceptance.
    process.exitCode = 2;
  } catch {
    console.error('BLOCKED: a synthetic provider write or import-fence invariant failed.');
    process.exitCode = 1;
  }
}
