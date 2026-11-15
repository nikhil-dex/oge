import { getDatabase } from './mongodb.js';
import { normalizeLoginEmail, verifyAccountPassword } from './password-auth.js';
import { checkRateLimit } from './rate-limit.js';
import { sessionVersionOf } from './session-revocation.js';

/**
 * Credentials authenticate only a pre-existing OAuth-verified account that
 * explicitly opted into password sign-in. Never create or link by email here.
 */
export async function authenticateLinkedPassword(emailInput, passwordInput, { database = getDatabase } = {}) {
  const email = normalizeLoginEmail(emailInput);
  // Avoid user enumeration and unbounded resource usage from huge inputs.
  if (!email || typeof passwordInput !== 'string' || passwordInput.length > 128 ||
      Buffer.byteLength(passwordInput, 'utf8') > 512) return null;
  try {
    const db = await database();
    const limit = await checkRateLimit(db, {
      scope: 'password-login',
      identifier: email,
      limit: 8,
      windowMs: 15 * 60 * 1000,
    });
    if (!limit.allowed) return null;

    // Email is non-unique. Resolve only password-enabled accounts, since a
    // linked GitHub identity may remain as a password-less account stub.
    // Refuse two password-enabled matches instead of guessing ownership.
    const candidates = await db.collection('users').find(
      { email, passwordHash: { $type: 'string' } },
      { projection: { googleSub: 1, email: 1, name: 1, image: 1, passwordHash: 1, sessionVersion: 1 } },
    ).limit(2).toArray();
    const account = candidates.length === 1 ? candidates[0] : null;
    const valid = await verifyAccountPassword(passwordInput, account?.passwordHash);
    if (!valid || typeof account?.googleSub !== 'string') return null;
    const version = sessionVersionOf(account);
    if (version === null) return null;
    return {
      id: account.googleSub, email: account.email,
      name: account.name || '',
      image: account.image || null,
      sessionVersion: version,
    };
  } catch (error) {
    // A failed DB or rate-limit backend must never bypass authentication.
    console.error('Password authentication failed:', error instanceof Error ? error.name : 'UnknownError');
    return null;
  }
}
