'use server';

import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';

export const NEWS_TOPICS = [
  'Technology', 'Artificial Intelligence', 'Science', 'Business & Finance',
  'World News', 'India News', 'Politics', 'Health', 'Education', 'Startups',
  'Gaming', 'Anime & Entertainment', 'Sports', 'Environment', 'Space & Astronomy',
];

export async function saveNewsInterests(formData) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (typeof ownerId !== 'string' || !ownerId) redirect('/register');

  const action = formData.get('action');
  const submitted = action === 'skip' ? [] : formData.getAll('interest');
  if (submitted.length > 10) throw new Error('Choose no more than 10 news interests.');
  const interests = [...new Set(submitted.filter((item) => typeof item === 'string' && NEWS_TOPICS.includes(item)))];
  if (interests.length !== submitted.length) throw new Error('One or more selected interests are invalid. Please try again.');

  const db = await getDatabase();
  await db.collection('users').updateOne(
    { googleSub: ownerId },
    { $set: { newsInterests: interests, onboardingComplete: true, updatedAt: new Date() } },
  );
  redirect(formData.get('returnTo') === '/settings' ? '/settings' : '/');
}
