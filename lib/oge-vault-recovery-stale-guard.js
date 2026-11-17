import { vaultHistoricalResourceSourceCheckAllowed } from './oge-vault-historical-resource-source-verify.js';

/**
 * E25/M93: a separately default-OFF staging-only UI capability flag.
 * All M92 -> M89 -> M87 owner, TLS, private repo and isolated DB gates
 * must remain satisfied. This controls no commit, import, or unlock route.
 */
export function vaultRecoveryStaleRecheckAllowed(env = {}, readiness) {
  return env.OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW === 'true' &&
    vaultHistoricalResourceSourceCheckAllowed(env, readiness);
}
