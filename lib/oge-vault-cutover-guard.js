import { ownerMutationFilter } from './active-owner-mutation.js';

/**
 * Phase D: staging-only "no dual permanent content backends" fence.
 *
 * Never use this check to grant access to GitHub or to choose a user's vault.
 * It only denies legacy MongoDB content endpoints for a signed account that
 * already has a connected/recoverable Vault. GitHub endpoints have separate
 * signed owner/repository authorization.
 *
 * Default OFF. Enabling this without the GitHub Notes+hybrid draft previews
 * is a misconfiguration; fail closed instead of redirecting or accepting
 * plaintext note writes. No note content or owner IDs are returned.
 */
export function vaultLegacyCutoverPreviewEnabled(env = process.env) {
  return env.OGE_VAULT_CUTOVER_GUARD_PREVIEW === 'true';
}

export function vaultLegacyCutoverDecision(account, { env = process.env } = {}) {
  if (!vaultLegacyCutoverPreviewEnabled(env)) return { blocked: false, mode: 'legacy' };
  if (env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true') {
    return {
      blocked: true, status: 503, code: 'vault-cutover-preview-incomplete',
      error: 'Vault cutover preview is not fully configured. No legacy note storage was changed.',
    };
  }
  if (!account) return {
    blocked: true, status: 401, code: 'vault-cutover-owner-unverified',
    error: 'Account session changed. Sign in again.',
  };
  const vault = account.vault;
  if (!vault || (!vault.status && vault.repoId == null &&
      vault.installationId == null) ||
      (vault.status === 'disconnected' && vault.repoId == null &&
        vault.installationId == null))
    return { blocked: false, mode: 'legacy' };

  // Any partially provisioned/recoverable Vault is blocked from fallback,
  // even if the provider mapping has become inconsistent. Do not infer a
  // repository from an OAuth login or matching email.
  if (vault.status || vault.repoId != null || vault.installationId != null) {
    if (vault.status !== 'connected' || !Number.isSafeInteger(vault.repoId) ||
        vault.repoId < 1 || !Number.isSafeInteger(vault.installationId) ||
        vault.installationId < 1) {
      return {
        blocked: true, status: 503, code: 'vault-cutover-connection-incomplete',
        error: 'Vault connection needs recovery before editing notes.',
      };
    }
    return {
      blocked: true, status: 409, code: 'vault-cutover-legacy-disabled',
      error: 'Use your GitHub Vault for notes. Legacy note content storage is disabled in this preview.',
    };
  }
  return { blocked: false, mode: 'legacy' };
}

/**
 * Signed identity and optional active transaction must match the account
 * before deciding whether a legacy API is safe. This is not a migration,
 * automatic fallback, note read, or authorization to change GitHub state.
 */
export async function inspectLegacyCutoverForOwner(db, ownerId, credential, {
  env = process.env, session,
} = {}) {
  if (!vaultLegacyCutoverPreviewEnabled(env))
    return { blocked: false, mode: 'legacy' };
  const filter = ownerMutationFilter(ownerId, credential);
  const account = await db.collection('users').findOne(filter, {
    projection: { _id: 1, vault: 1 }, ...(session ? { session } : {}),
  });
  return vaultLegacyCutoverDecision(account, { env });
}

/** No owner information or note content in a blocked response. */
export function legacyCutoverBlockedResponse(decision, { headers = {} } = {}) {
  if (!decision?.blocked) return null;
  return Response.json({ error: decision.error, code: decision.code }, {
    status: decision.status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}
