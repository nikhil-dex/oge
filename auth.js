import { randomUUID } from 'node:crypto';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { authenticateLinkedPassword } from './lib/linked-password-login.js';
import { isPasswordSessionActive } from './lib/password-auth.js';
import { getDatabase } from './lib/mongodb.js';
import { isCurrentSession, sessionVersionOf } from './lib/session-revocation.js';
import { githubOwnerId, getVerifiedGitHubEmail } from './lib/github-login.js';
import { finishGoogleConnection, resolveOAuthOwner } from './lib/google-account-link.js';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google, GitHub({ authorization: { params: { scope: 'read:user user:email' } } }), Credentials({
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
        // Password login only returns an existing, verified OgeNotes account.
        // It cannot create or implicitly link an OAuth identity.
        return true;
      }
      if (!['google', 'github'].includes(account?.provider) || typeof account.providerAccountId !== 'string') return false;
      const isGoogle = account.provider === 'google';
      if (isGoogle && (typeof profile?.sub !== 'string' || profile.sub !== account.providerAccountId ||
          profile.email_verified !== true || typeof profile.email !== 'string')) return false;
      if (!isGoogle && (!githubOwnerId(account.providerAccountId) ||
          String(profile?.id) !== account.providerAccountId)) return false;
      // GitHub email must be explicitly marked verified by GitHub's emails API.
      const verifiedEmail = isGoogle ? profile.email.toLowerCase() :
        await getVerifiedGitHubEmail(account.access_token);
      if (!verifiedEmail) return false;
      // An explicit profile action creates a short-lived, one-use link intent.
      // Never associate accounts merely because their email addresses match.
      if (isGoogle) {
        const link = await finishGoogleConnection(profile.sub, verifiedEmail);
        if (link.attempted && !link.ok) {
          const reason = ['migration-required', 'mismatch', 'expired'].includes(link.reason) ? link.reason : 'failed';
          return '/profile?google=' + reason;
        }
      }
      try {
        const db = await getDatabase();
        const now = new Date();
        const ownerId = await resolveOAuthOwner(db, account.provider, account.providerAccountId);
        if (!ownerId) return false;
        // Do not let a GitHub login overwrite the canonical Google profile.
        const canonicalProvider = ownerId.startsWith('github:') ? 'github' : 'google';
        const profileFields = canonicalProvider === account.provider ? {
          email: verifiedEmail,
          name: typeof profile.name === 'string' ? profile.name.slice(0, 120) :
            !isGoogle && typeof profile.login === 'string' ? profile.login.slice(0, 120) : '',
          image: typeof (isGoogle ? profile.picture : profile.avatar_url) === 'string' ?
            (isGoogle ? profile.picture : profile.avatar_url).slice(0, 2048) : null,
        } : {};
        await db.collection('users').updateOne(
          { googleSub: ownerId },
          {
            $set: { ...profileFields, lastLoginAt: now, updatedAt: now },
            $setOnInsert: { googleSub: ownerId, identityProvider: canonicalProvider,
              createdAt: now, newsInterests: [], sessionVersion: randomUUID() },
          },
          { upsert: true },
        );
        return true;
      } catch (error) {
        // Fail closed: do not issue a session if the account cannot be persisted.
        console.error('OAuth sign-in account persistence failed.', error instanceof Error ? error.name : 'UnknownError');
        return false;
      }
    },
    async jwt({ token, account, user }) {
      if (['google', 'github'].includes(account?.provider) && typeof account.providerAccountId === 'string') {
        const db = await getDatabase();
        token.googleSub = await resolveOAuthOwner(db, account.provider, account.providerAccountId);
        token.authProvider = account.provider;
        token.authenticatedAt = Date.now();
        delete token.passwordSignedInAt;
      }
      if (account?.provider === 'credentials') {
        if (typeof user?.id !== 'string' || !user.id ||
            (typeof user.sessionVersion !== 'string' && user.sessionVersion !== 0)) return null;
        token.googleSub = user.id;
        token.authProvider = 'credentials';
        token.sessionVersion = user.sessionVersion;
        // Credentials sign-in is not evidence of recent Google reauthentication.
        token.authenticatedAt = null;
        // A shared-device password session expires after 8 hours even if
        // the general Google-authenticated JWT lifetime is longer.
        token.passwordSignedInAt = Date.now();
      }
      if (token.passwordSignedInAt !== undefined &&
          !isPasswordSessionActive(token.passwordSignedInAt)) return null;
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
        if (account?.provider === 'google' || account?.provider === 'github') {
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
        session.user.authProvider = typeof token.authProvider === 'string' ? token.authProvider : null;
      }
      return session;
    },
  },
});
