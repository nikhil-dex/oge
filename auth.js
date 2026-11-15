import { randomUUID } from 'node:crypto';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { authenticateLinkedPassword } from './lib/linked-password-login.js';
import { getDatabase } from './lib/mongodb.js';
import { isCurrentSession, sessionVersionOf } from './lib/session-revocation.js';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google, Credentials({
    name: 'OgeNotes password',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      return authenticateLinkedPassword(credentials?.email, credentials?.password);
    },
  })],
  pages: { signIn: '/register' },
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === 'credentials') {
        // The credentials provider only returns an existing verified Google
        // account after password validation. No separate user is created.
        return true;
      }
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
    async jwt({ token, account, user }) {
      if (account?.provider === 'google' && typeof account.providerAccountId === 'string') {
        token.googleSub = account.providerAccountId;
        token.authenticatedAt = Date.now();
        delete token.passwordSignedInAt;
      }
      if (account?.provider === 'credentials') {
        if (typeof user?.id !== 'string' || !user.id ||
            (typeof user.sessionVersion !== 'string' && user.sessionVersion !== 0)) return null;
        token.googleSub = user.id;
        token.sessionVersion = user.sessionVersion;
        // Credentials sign-in is not evidence of recent Google reauthentication.
        token.authenticatedAt = null;
        // A shared-device password session expires after 8 hours even if
        // the general Google-authenticated JWT lifetime is longer.
        token.passwordSignedInAt = Date.now();
      }
      if (token.passwordSignedInAt !== undefined &&
          (!Number.isSafeInteger(token.passwordSignedInAt) ||
           token.passwordSignedInAt > Date.now() ||
           Date.now() - token.passwordSignedInAt > 8 * 60 * 60 * 1000)) return null;
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
        // This is a signed JWT claim, never a browser-provided account version.
        // Sensitive account operations compare it against the current DB row.
        session.user.sessionVersion = token.sessionVersion ?? 0;
        // Timestamp is minted server-side on fresh Google authentication.
        // Old sessions without this claim must reauthenticate for deletion.
        session.user.authenticatedAt = typeof token.authenticatedAt === 'number' ? token.authenticatedAt : null;
      }
      return session;
    },
  },
});
