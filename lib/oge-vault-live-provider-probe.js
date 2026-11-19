import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const error = (code) => new VaultGitHubError(code, 409);
const exact = (a) => JSON.stringify({
  repoId: a.repoId, installationId: a.installationId,
  githubAccountId: a.githubAccountId, githubLogin: a.githubLogin,
  repoName: a.repoName, status: a.status,
});

/**
 * M61 — real-provider CAPABILITY probe, not staging acceptance.
 *
 * Caller must construct TWO independent contents:read GitHub App clients
 * from the same signed, isolated staging owner. No note blobs, drafts,
 * commits via PATCH, OAuth identities from devices, or write credentials.
 * Reports only statuses, never owner IDs, Git SHAs or access tokens.
 * Cannot possibly attest to two physical devices or error-injection tests.
 */
export async function inspectVaultProviderReadOnlyPair(first, second, {
  ownerVerifier,
} = {}) {
  if (!first || !second || first === second ||
      !first.readOnly || !second.readOnly ||
      typeof first.call !== 'function' ||
      typeof second.call !== 'function' ||
      typeof first.branch !== 'string' ||
      first.branch !== second.branch ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(first.branch) ||
      first.branch.startsWith('-') ||
      first.branch.includes('..') ||
      first.vault?.status !== 'connected' ||
      first.vault?.repoName !== 'ogenotes-vault' ||
      !Number.isSafeInteger(first.vault?.repoId) ||
      first.vault.repoId <= 0 ||
      !Number.isSafeInteger(first.vault?.installationId) ||
      first.vault.installationId <= 0 ||
      exact(first.vault) !== exact(second.vault) ||
      typeof ownerVerifier !== 'function')
    throw new TypeError('Two independent signed read-only private Vault clients required');

  if (await ownerVerifier() !== true)
    throw error('vault-live-probe-owner-changed');
  const ref = '/git/ref/heads/' + encodeURIComponent(first.branch);
  // Independent clients separately check the same real GitHub branch.
  const one = await first.call(ref);
  const head = one?.object?.sha;
  if (!SHA.test(head || ''))
    throw error('vault-live-probe-head-invalid');
  const commit = await first.call('/git/commits/' + head);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw error('vault-live-probe-tree-invalid');
  const two = await second.call(ref);
  if (two?.object?.sha !== head)
    throw error('vault-live-probe-head-changed');
  const secondCommit = await second.call('/git/commits/' + head);
  if (secondCommit?.tree?.sha !== commit.tree.sha)
    throw error('vault-live-probe-tree-changed');
  if (await ownerVerifier() !== true)
    throw error('vault-live-probe-owner-changed');
  const three = await first.call(ref);
  if (three?.object?.sha !== head)
    throw error('vault-live-probe-head-changed');

  return {
    format: 'oge-vault-live-provider-read-only-probe',
    version: 1,
    signedPrivateRepoMappingObserved: true,
    twoIndependentReadOnlyClientsObserved: true,
    sameGitHubBranchAndCommitTreeObserved: true,
    signedOwnerMappingStable: true,
    ownerIdReturned: false,
    gitCommitShaReturned: false,
    privateNotesRead: false,
    mongoDraftsModified: false,
    githubWritesPerformed: false,
    writeTokenRequested: false,
    physicalTwoDeviceSessionsVerified: false,
    liveOAuthBrowserAcceptanceVerified: false,
    realGitHubWriteFailureMatrixVerified: false,
    completeStagingAcceptanceSignedOff: false,
    canAuthorizeRestore: false,
    canRetryAutomatically: false,
    canReleaseImportLock: false,
  };
}
