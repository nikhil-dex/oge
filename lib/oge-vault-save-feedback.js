/**
 * Human-readable Save guidance without exposing GitHub tokens, repository
 * identifiers or provider response bodies. A rejected/uncertain HTTP response
 * does not prove the note was never committed.
 */
export function vaultSaveFailureMessage(error) {
  const code = typeof error === 'string' ? error : error?.message;
  const messages = {
    'vault-repository-token-scope-failed':
      'GitHub did not confirm repository access for this Vault connection. Check the GitHub App installation and reconnect if permissions changed.',
    'github-permission-denied':
      'GitHub denied this write. Check that the Oge Vault GitHub App has Contents: Read and write and access to your private Vault repository.',
    'vault-not-connected':
      'This account does not have a verified GitHub Vault connection. Open Oge Vault to reconnect.',
    'vault-ownership-changed':
      'GitHub could not verify ownership of the connected private Vault. Open Oge Vault to review the connection.',
    'github-auth-expired':
      'GitHub authentication for this operation failed. Check the Vault App credentials and installation.',
    'vault-note-conflict':
      'This Note changed in GitHub after it was loaded. Keep your text, reload the Note and review changes before retrying.',
    'vault-subject-locked-or-missing':
      'The selected subject is unavailable. Refresh your subjects and try saving again.',
    'github-rate-limited':
      'GitHub has temporarily limited requests. Keep this draft and try again after the limit resets.',
    'github-network-unavailable':
      'GitHub could not be reached. Your draft is still available; check the repository before repeating Save.',
    'github-repository-conflict':
      'GitHub rejected this change (422). The Note may conflict with an existing file or branch. Check the repository before retrying.',
    'github-api-error':
      'GitHub rejected the Notes request. Verify the GitHub App installation and Contents: Read and write permission.',
    'vault-branch-unavailable':
      'The private GitHub Vault has no usable default branch. Check the repository setup.',
    'vault-head-unavailable':
      'Could not read the current GitHub branch. The Note was not confirmed saved.',
    'vault-tree-unavailable':
      'Could not confirm the GitHub repository tree. The Note was not confirmed saved.',
    'vault-commit-unconfirmed':
      'GitHub may have received this Save, but Oge could not verify it. Check your private repository before retrying; your draft is retained.',
  };
  if (Object.hasOwn(messages, code)) return messages[code];
  // Keep safe, bounded error codes useful for troubleshooting rather than
  // pretending an unknown error was a permissions failure.
  if (typeof code === 'string' && /^[a-z][a-z0-9-]{2,90}$/.test(code))
    return 'GitHub Save could not be confirmed (' + code + '). Your draft is retained. Check the Vault connection before retrying.';
  return 'GitHub Save could not be confirmed. Your draft is retained. Check the Vault connection and try again.';
}
