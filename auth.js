import { randomUUID } from 'node:crypto';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getDatabase } from './lib/mongodb.js';
import { isCurrentSession, sessionVersionOf } from './lib/session-revocation.js';

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
            $setOnInsert: { googleSub: profile.sub, createdAt: now, newsInterests: [], sessionVersion: randomUUID() },
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
        token.authenticatedAt = Date.now();
      }
      if (typeof token.googleSub !== 'string') return null;
      try {
        // JWT logout on one device does not revoke other copies by itself.
        // Check the persisted account on every JWT callback. Missing accounts,
        // revoked versions and database failures all invalidate the session.
        const db = await getDatabase();
        const user = await db.collection('users').findOne(
          { googleSub: token.googleSub },
          { projection: { sessionVersion: 1 } },
        );
        if (!user) return null;
        if (account?.provider === 'google') {
          token.sessionVersion = sessionVersionOf(user);
        }
        if (!isCurrentSession(user, token.sessionVersion)) return null;
        return token;
      } catch (error) {
        console.error('Session version validation failed:', error instanceof Error ? error.name : 'UnknownError');
        return null;
      }
    },
    async session({ session, token }) {
      if (session.user && typeof token.googleSub === 'string') {
        session.user.id = token.googleSub;
        // Timestamp is minted server-side on fresh Google authentication.
        // Old sessions without this claim must reauthenticate for deletion.
        session.user.authenticatedAt = typeof token.authenticatedAt === 'number' ? token.authenticatedAt : null;
      }
      return session;
    },
  },
});
