/**
 * UI entrypoint decision for existing signed-in owners.
 * No GitHub permission is granted here: every Vault API independently checks
 * the exact owner and repository mapping before writing.
 */
// One storage/connection rule for the Vault UI and its API routes.
// Feature-specific preview flags are checked separately where needed.
export function connectedVaultStorageAvailable(account) {
  const vault = account?.vault;
  return account?.notesStorage !== 'mongodb' &&
    account?.notesStorage !== 'unselected' &&
    vault?.status === 'connected' &&
    Number.isSafeInteger(vault.repoId) && vault.repoId > 0 &&
    Number.isSafeInteger(vault.installationId) && vault.installationId > 0;
}

export function vaultNotesAvailable(account, env = process.env) {
  return connectedVaultStorageAvailable(account) &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true';
}

export function vaultCaptureAvailable(account, env = process.env) {
  return vaultNotesAvailable(account, env) &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true';
}

export function standaloneNotesDestination(account, env = process.env) {
  // Keep disconnected users on the original Quick Notes/AirNotes screens.
  // Connected users should write through the single GitHub-backed capture
  // editor rather than the old permanent MongoDB note writers.
  if (account?.notesStorage === 'unselected') return '/onboarding';
  if (account?.notesStorage === 'mongodb') return null;
  if (account?.notesStorage === 'github')
    return vaultCaptureAvailable(account, env) ? '/vault/capture' : '/vault?setup=onboarding';
  return vaultCaptureAvailable(account, env) ? '/vault/capture' : null;
}
