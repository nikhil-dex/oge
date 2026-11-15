'use server';

import { auth, signIn } from '../../auth.js';
import { redirect } from 'next/navigation';
import { getDatabase } from '../../lib/mongodb.js';
import { beginGoogleConnection } from '../../lib/google-account-link.js';
import { checkRateLimit } from '../../lib/rate-limit.js';

/** Explicit user-initiated Google verification, distinct from normal sign-in.
 * No account is linked merely because both providers report the same email.
 */
export async function connectGoogleAccount() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId?.startsWith('github:')) redirect('/profile?google=not-available');
  try {
    const db = await getDatabase();
    const limit = await checkRateLimit(db, {
      scope: 'google-link-start', identifier: ownerId, limit: 5, windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) redirect('/profile?google=limited');
    await beginGoogleConnection(ownerId, session.user.sessionVersion);
  } catch (error) {
    // Do not mask Next.js redirects from the throttle branch.
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error;
    redirect('/profile?google=failed');
  }
  await signIn('google', { redirectTo: '/profile?google=connected' });
}
