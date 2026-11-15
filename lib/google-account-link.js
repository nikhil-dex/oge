import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDatabase } from './mongodb.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { withAtomicBackupImport } from './atomic-backup-import.js';
import { isCurrentSession } from './session-revocation.js';

const COOKIE = 'oge-google-link';
const AGE_MS = 10 * 60 * 1000;
const CONTENT_COLLECTIONS = ['notes', 'subjects', 'quickNotes', 'personalQuickNotes', 'savedLinks'];

async function cookieStore() {
  const { cookies } = await import('next/headers');
  return cookies();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function beginGoogleConnection(ownerId, sessionVersion, { database = getDatabase, cookieJar = cookieStore } = {}) {
  if (!ownerId?.startsWith('github:')) throw new Error('Only GitHub accounts can initiate Google connection');
  const db = await database();
  const account = await db.collection('users').findOne(ownerMutationFilter(ownerId, { sessionVersion }),
    { projection: { googleSub: 1, linkedGoogleSub: 1 } });
  if (!account || account.linkedGoogleSub) throw new Error('Account is already linked or is no longer active');
  const recent = await db.collection('oauthLinkIntents').countDocuments({ ownerId, expiresAt: { $gt: new Date() } });
  if (recent >= 3) throw new Error('Too many pending Google connection attempts');
  const secret = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.collection('oauthLinkIntents').insertOne({
    secretHash: digest(secret), ownerId, sessionVersion,
    createdAt: new Date(now), expiresAt: new Date(now + AGE_MS),
  });
  (await cookieJar()).set(COOKIE, secret, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: '/', maxAge: AGE_MS / 1000,
  });
}

/** Consume an OAuth link challenge once. A valid Google OAuth identity, the
 * pending GitHub-authenticated session and the verified emails are all required.
 * Existing Google account content is NEVER moved or overwritten here.
 */
export async function finishGoogleConnection(googleSub, verifiedEmail, {
  database = getDatabase, cookieJar = cookieStore,
} = {}) {
  const jar = await cookieJar();
  const secret = jar.get(COOKIE)?.value;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return { attempted: false };
  jar.delete(COOKIE);
  const db = await database();
  const intent = await db.collection('oauthLinkIntents').findOneAndDelete({
    secretHash: digest(secret), expiresAt: { $gt: new Date() },
  });
  if (!intent) return { attempted: true, ok: false, reason: 'expired' };
  if (typeof googleSub !== 'string' || !googleSub || typeof verifiedEmail !== 'string') {
    return { attempted: true, ok: false, reason: 'identity' };
  }
  try {
    return await withAtomicBackupImport(db, async (session) => {
      const users = db.collection('users');
      const source = await users.findOne({ googleSub: intent.ownerId },
        { session, projection: { _id: 1, googleSub: 1, email: 1, sessionVersion: 1, linkedGoogleSub: 1 } });
      if (!isCurrentSession(source, intent.sessionVersion) || source.linkedGoogleSub ||
          source.email !== verifiedEmail || !source.googleSub.startsWith('github:')) {
        return { attempted: true, ok: false, reason: 'mismatch' };
      }
      // No account link can be established if the requested Google identity is
      // already linked from another GitHub account.
      const prior = await users.findOne({ linkedGoogleSub: googleSub, googleSub: { $ne: source.googleSub } },
        { session, projection: { _id: 1 } });
      if (prior) return { attempted: true, ok: false, reason: 'mismatch' };
      const target = await users.findOne({ googleSub }, { session,
        projection: { _id: 1, email: 1, linkedGithubOwnerId: 1 } });
      if (target && (target.email !== verifiedEmail ||
          (target.linkedGithubOwnerId && target.linkedGithubOwnerId !== source.googleSub))) {
        return { attempted: true, ok: false, reason: 'mismatch' };
      }
      if (target) {
        // Do not orphan a GitHub user's existing Notes, links or personalized account.
        // A proper migration workflow needs explicit review and will be separate.
        for (const name of CONTENT_COLLECTIONS) {
          if (await db.collection(name).findOne({ ownerId: source.googleSub }, { session, projection: { _id: 1 } })) {
            return { attempted: true, ok: false, reason: 'migration-required' };
          }
        }
        const profile = await users.findOne({ _id: source._id }, { session,
          projection: { username: 1, passwordHash: 1, socialLinks: 1, newsInterests: 1 } });
        if (profile.username || profile.passwordHash || Object.values(profile.socialLinks || {}).some(Boolean) ||
            (Array.isArray(profile.newsInterests) && profile.newsInterests.length)) {
          return { attempted: true, ok: false, reason: 'migration-required' };
        }
        const updated = await users.updateOne({ _id: target._id, email: verifiedEmail,
          $or: [{ linkedGithubOwnerId: { $exists: false } }, { linkedGithubOwnerId: source.googleSub }] },
        { $set: { linkedGithubOwnerId: source.googleSub, updatedAt: new Date() } }, { session });
        if (updated.matchedCount !== 1) throw new Error('Google link conflict');
      }
      const updated = await users.updateOne(
        { _id: source._id, sessionVersion: source.sessionVersion, linkedGoogleSub: { $exists: false } },
        {
          $set: { linkedGoogleSub: googleSub, sessionVersion: randomUUID(), updatedAt: new Date() },
          // If the canonical owner switches to the pre-existing Google record,
          // retire the original GitHub owner's extension bearer token.
          ...(target ? { $unset: {
            extensionTokenHash: '', extensionTokenCreatedAt: '', extensionTokenExpiresAt: '',
          } } : {}),
        },
        { session },
      );
      if (updated.matchedCount !== 1) throw new Error('GitHub link conflict');
      return { attempted: true, ok: true };
    });
  } catch {
    return { attempted: true, ok: false, reason: 'unavailable' };
  }
}

/** Resolve a linked identity to the same canonical Oge account across providers. */
export async function resolveOAuthOwner(db, provider, providerAccountId) {
  if (provider === 'google') {
    const direct = await db.collection('users').findOne({ googleSub: providerAccountId },
      { projection: { googleSub: 1 } });
    if (direct) return direct.googleSub;
    const github = await db.collection('users').findOne({ linkedGoogleSub: providerAccountId },
      { projection: { googleSub: 1 } });
    return github?.googleSub || providerAccountId;
  }
  if (provider === 'github') {
    const githubId = 'github:' + providerAccountId;
    const github = await db.collection('users').findOne({ googleSub: githubId },
      { projection: { googleSub: 1, linkedGoogleSub: 1 } });
    if (github?.linkedGoogleSub) {
      const google = await db.collection('users').findOne({
        googleSub: github.linkedGoogleSub, linkedGithubOwnerId: githubId,
      }, { projection: { googleSub: 1 } });
      if (google) return google.googleSub;
    }
    return githubId;
  }
  return null;
}

export async function googleConnectionRequired(db, ownerId) {
  if (!ownerId?.startsWith('github:')) return false;
  const source = await db.collection('users').findOne({ googleSub: ownerId },
    { projection: { email: 1, linkedGoogleSub: 1 } });
  if (!source || source.linkedGoogleSub || !source.email) return false;
  const match = await db.collection('users').findOne({
    email: source.email, googleSub: { $not: /^github:/ },
  }, { projection: { _id: 1 } });
  return Boolean(match);
}
