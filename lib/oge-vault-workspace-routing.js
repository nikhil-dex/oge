/**
 * UI entrypoint decision for existing signed-in owners.
 * No GitHub permission is granted here: every Vault API independently checks
 * the exact owner and repository mapping before writing.
 */
export function vaultCaptureAvailable(account, env = process.env) {
  const vault = account?.vault;
  return env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    vault?.status === 'connected' &&
    Number.isSafeInteger(vault.repoId) && vault.repoId > 0 &&
    Number.isSafeInteger(vault.installationId) && vault.installationId > 0;
}

export function standaloneNotesDestination(account, env = process.env) {
  // Keep disconnected users on the original Quick Notes/AirNotes screens.
  // Connected users should write through the single GitHub-backed capture
  // editor rather than the old permanent MongoDB note writers.
  return vaultCaptureAvailable(account, env) ? '/vault/capture' : null;
}
