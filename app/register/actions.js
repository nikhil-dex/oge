'use server';

import { signIn } from '../../auth.js';

export async function signInWithGoogle() {
  await signIn('google', { redirectTo: '/' });
}
