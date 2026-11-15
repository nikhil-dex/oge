import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { checkRateLimit } from '../../../../lib/rate-limit.js';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { beginVaultAuthorization } from '../../../../lib/oge-vault-state.js';
import { VAULT_STATE_COOKIE, vaultCallbackUrl, vaultConfigured, VAULT_STATE_AGE_MS } from '../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: 'Sign in before setting up Oge Vault.' }, { status: 401 });
  if (!vaultConfigured()) return NextResponse.redirect(new URL('/vault?result=not-configured', vaultCallbackUrlSafe()), 303);
  try {
    const db = await getDatabase();
    const throttle = await checkRateLimit(db, {
      scope: 'vault-authorization', identifier: session.user.id, limit: 6, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return NextResponse.redirect(new URL('/vault?result=limited', vaultCallbackUrl()), 303);
    const state = await beginVaultAuthorization(db, {
      ownerId: session.user.id, sessionVersion: session.user.sessionVersion,
    });
    (await cookies()).set(VAULT_STATE_COOKIE, state, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', path: '/api/vault', maxAge: VAULT_STATE_AGE_MS / 1000,
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', process.env.OGE_VAULT_GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', vaultCallbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return NextResponse.redirect(url, 303);
  } catch (error) {
    console.error('Vault authorization start failed:', error?.name);
    return NextResponse.redirect(new URL('/vault?result=start-failed', vaultCallbackUrl()), 303);
  }
}

function vaultCallbackUrlSafe() {
  // No untrusted Host header in redirect targets, even when environment
  // configuration is incomplete: use an application-relative fallback.
  return 'http://localhost:3000';
}
