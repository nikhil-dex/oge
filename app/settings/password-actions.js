'use server';

import { randomUUID } from 'node:crypto';
import { auth, signIn } from '../../auth.js';
import { redirect } from 'next/navigation';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { hashAccountPassword, validAccountPassword, isRecentOAuthAuthentication } from '../../lib/password-auth.js';

export async function reauthenticateWithGoogle() {
  await signIn('google', { redirectTo: '/profile' });
}

export async function reauthenticateWithGitHub() {
  await signIn('github', { redirectTo: '/profile' });
}

export async function setLinkedPassword(formData) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');
  if (session.user.googleConnectionRequired) redirect('/profile?google=required');
  if (!isRecentOAuthAuthentication(session)) redirect('/profile?password=reauth');

  const password = formData.get('password');
  const confirm = formData.get('confirmPassword');
  if (password !== confirm || !validAccountPassword(password)) redirect('/profile?password=invalid');

  const db = await getDatabase();
  const limit = await checkRateLimit(db, {
    scope: 'password-setup',
    identifier: ownerId,
    limit: 4,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) redirect('/profile?password=limited');

  const filter = ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion });
  const user = await db.collection('users').findOne(filter, { projection: { email: 1 } });
  if (!user?.email) redirect('/profile?password=failed');

  // Reject ambiguous email identities before enabling the alternate login
  // method. Never merge accounts or trust email as a user ownership key.
  const matchingAccounts = await db.collection('users')
    .find({ email: user.email }, { projection: { googleSub: 1 } }).limit(2).toArray();
  if (matchingAccounts.length !== 1 || matchingAccounts[0].googleSub !== ownerId) {
    redirect('/profile?password=failed');
  }

  const passwordHash = await hashAccountPassword(password);
  const result = await db.collection('users').updateOne(
    filter,
    { $set: { passwordHash, sessionVersion: randomUUID(), passwordUpdatedAt: new Date(), updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1) redirect('/profile?password=failed');
  // Rotated sessionVersion revokes all old sessions, including this one.
  redirect('/register?password=enabled');
}
