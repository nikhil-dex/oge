import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getDatabase } from './lib/mongodb.js';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  pages: { signIn: '/register' },
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== 'google' || typeof account.providerAccountId !== 'string') return false;
      if (typeof profile?.sub !== 'string' || profile.sub !== account.providerAccountId) return false;
      if (profile.email_verified !== true || typeof profile.email !== 'string') return false;
      try {
        const db = await getDatabase();
        const now = new Date();
        await db.collection('users').updateOne(
          { googleSub: profile.sub },
          {
            $set: {
              email: profile.email.toLowerCase(),
              name: typeof profile.name === 'string' ? profile.name.slice(0, 120) : '',
              image: typeof profile.picture === 'string' ? profile.picture.slice(0, 2048) : null,
              lastLoginAt: now,
              updatedAt: now,
            },
            $setOnInsert: { googleSub: profile.sub, createdAt: now, newsInterests: [] },
          },
          { upsert: true },
        );
        return true;
      } catch (error) {
        // Fail closed: do not issue a session if the account cannot be persisted.
        console.error('Google sign-in account persistence failed.', error instanceof Error ? error.name : 'UnknownError');
        return false;
      }
    },
    async jwt({ token, account }) {
      if (account?.provider === 'google' && typeof account.providerAccountId === 'string') {
        token.googleSub = account.providerAccountId;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.googleSub === 'string') {
        session.user.id = token.googleSub;
      }
      return session;
    },
  },
});
