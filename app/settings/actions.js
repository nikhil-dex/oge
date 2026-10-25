'use server';

import { signOut } from '../../auth.js';

export async function signOutOfOgeNotes() {
  await signOut({ redirectTo: '/register' });
}
