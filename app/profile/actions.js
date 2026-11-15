'use server';

import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { isAllowedAvatar, normalizeProfileDisplayName, normalizeUsername } from '../../lib/profile-settings.js';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function saveProfileSettings(formData) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (typeof ownerId !== 'string' || !ownerId) redirect('/register');

  const username = normalizeUsername(formData.get('username'));
  const displayName = normalizeProfileDisplayName(formData.get('displayName'));
  const avatarId = formData.get('avatarId');
  if (!username || !displayName || !isAllowedAvatar(avatarId)) {
    redirect('/profile?status=invalid');
  }

  const db = await getDatabase();
  const limit = await checkRateLimit(db, {
    scope: 'profile-update', identifier: ownerId, limit: 12, windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) redirect('/profile?status=limited');

  const filter = ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion });
  try {
    const result = await db.collection('users').updateOne(filter, {
      $set: { username, displayName, avatarId, updatedAt: new Date() },
    });
    if (result.matchedCount !== 1) redirect('/register');
  } catch (error) {
    if (error?.code === 11000) redirect('/profile?status=taken');
    throw error;
  }

  revalidatePath('/profile');
  revalidatePath('/settings');
  redirect('/profile?status=saved');
}
