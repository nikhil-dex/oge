import { auth } from '../../../../auth.js';
import { cookies } from 'next/headers';
import { getDatabase } from '../../../../lib/mongodb.js';
import { NextResponse } from 'next/server';
import {
  VAULT_STATE_COOKIE, exchangeVaultOAuthCode, provisionVault,
  vaultBaseUrl, vaultConfigured, VaultGitHubError,
} from '../../../../lib/oge-vault-github.js';
import { consumeVaultAuthorization, connectProvisionedVault } from '../../../../lib/oge-vault-state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function vaultRedirect(result) {
  const url = new URL('/vault', vaultBaseUrl());
  url.searchParams.set('result', result);
  return NextResponse.redirect(url, 303);
}

/** Authorize the student as the owner of the GitHub account explicitly approved
 * for this vault. This is separate from the OAuth login provider, and never
 * uses a user's browser-supplied repository, owner, or installation ID.
 */
export async function GET(request) {
  if (!vaultConfigured()) return Response.json({ error: 'Oge Vault is not configured.' }, { status: 503 });
  const jar = await cookies();
  const cookieState = jar.get(VAULT_STATE_COOKIE)?.value;
  jar.delete(VAULT_STATE_COOKIE);
  const params = new URL(request.url).searchParams;
  if (params.get('error')) return vaultRedirect('permission-denied');
  const code = params.get('code');
  const state = params.get('state');
  const session = await auth();
  if (!session?.user?.id || !code || !state) return vaultRedirect('session-required');
  try {
    const db = await getDatabase();
    const challenge = await consumeVaultAuthorization(db, {
      state, cookieState, ownerId: session.user.id,
      sessionVersion: session.user.sessionVersion,
    });
    if (!challenge) return vaultRedirect('invalid-state');
    const token = await exchangeVaultOAuthCode(code);
    const connection = await provisionVault(token);
    await connectProvisionedVault(db, {
      ownerId: challenge.ownerId, sessionVersion: challenge.sessionVersion,
      connection,
    });
    return vaultRedirect('connected');
  } catch (error) {
    const type = error instanceof VaultGitHubError ? error.message : 'vault-setup-failed';
    const allowed = [
      'unsupported-github-owner', 'github-permission-denied',
      'github-repository-conflict', 'vault-app-installation-required',
      'vault-all-repositories-installation-required', 'vault-privacy-verification-failed',
    ];
    console.error('Vault OAuth callback failed:', error?.name);
    return vaultRedirect(allowed.includes(type) ? type : 'vault-setup-failed');
  }
}
