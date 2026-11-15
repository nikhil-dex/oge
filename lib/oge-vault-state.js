import { randomUUID } from 'node:crypto';
import { newVaultOAuthState, stateHash, VAULT_STATE_AGE_MS } from './oge-vault-github.js';
import { ownerMutationFilter } from './active-owner-mutation.js';

export async function beginVaultAuthorization(db, { ownerId, sessionVersion }, now = new Date()) {
  if (typeof ownerId !== 'string' || !ownerId || !sessionVersion) throw new TypeError('Missing owner session');
  const validOwner = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }), { projection: { _id: 1, vault: 1 } },
  );
  if (!validOwner) throw new Error('OgeNotes session expired');
  if (validOwner.vault?.status === 'connected') throw new Error('Vault is already connected');
  const state = newVaultOAuthState();
  await db.collection('vaultOauthIntents').insertOne({
    stateHash: stateHash(state), ownerId, sessionVersion,
    createdAt: now, expiresAt: new Date(now.getTime() + VAULT_STATE_AGE_MS),
  });
  return state;
}

export async function consumeVaultAuthorization(db, {
  state, cookieState, ownerId, sessionVersion, now = new Date(),
}) {
  const { stateMatches } = await import('./oge-vault-github.js');
  if (!stateMatches(state, cookieState) || !ownerId || !sessionVersion) return null;
  const intent = await db.collection('vaultOauthIntents').findOneAndDelete({
    stateHash: stateHash(state), ownerId, sessionVersion,
    expiresAt: { $gt: now },
  });
  if (!intent) return null;
  const user = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }), { projection: { _id: 1, vault: 1 } },
  );
  if (!user || user.vault?.status === 'connected') return null;
  return { ownerId, sessionVersion };
}

export async function connectProvisionedVault(db, {
  ownerId, sessionVersion, connection, githubAuthenticatedId,
}, now = new Date()) {
  if (typeof ownerId !== 'string' || !ownerId || !connection ||
      !/^[1-9][0-9]*$/.test(connection.githubAccountId)) {
    throw new TypeError('Invalid vault connection');
  }
  if (githubAuthenticatedId && githubAuthenticatedId !== connection.githubAccountId) {
    throw new Error('GitHub login identity differs from vault authorization');
  }
  const filter = ownerMutationFilter(ownerId, { sessionVersion });
  const existing = await db.collection('users').findOne(filter,
    { projection: { vault: 1, linkedGithubOwnerId: 1, identityProvider: 1 } });
  if (!existing || existing.vault?.status === 'connected') throw new Error('Account changed during provisioning');
  // A signed-in GitHub account must use its own GitHub identity for the vault,
  // even if it also has a Google sign-in linked.
  const loginId = ownerId.startsWith('github:') ? ownerId.slice(7) :
    existing.linkedGithubOwnerId?.startsWith('github:') ? existing.linkedGithubOwnerId.slice(7) : null;
  if (loginId && loginId !== connection.githubAccountId) throw new Error('GitHub account mismatch');
  const result = await db.collection('users').updateOne(
    { ...filter, 'vault.status': { $ne: 'connected' } },
    { $set: {
      vault: {
        status: 'connected', githubAccountId: connection.githubAccountId,
        githubLogin: connection.githubLogin, repoId: connection.repoId,
        repoName: connection.repoName, installationId: connection.installationId,
        connectedAt: now, contentMigration: 'not-started',
      },
      updatedAt: now,
    } },
  );
  if (result.matchedCount !== 1) throw new Error('Vault account update conflict');
}

export function newVaultConnectionId() {
  return randomUUID();
}
