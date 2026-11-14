import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { checkRateLimit, rateLimitResponse } from '../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIRMATION = 'DELETE MY ACCOUNT';
const MAX_REAUTH_AGE_MS = 5 * 60 * 1000;
const OWNER_COLLECTIONS = ['notes', 'subjects', 'quickNotes', 'personalQuickNotes', 'savedLinks'];

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function canDeleteAccount(session, now = Date.now()) {
  const authenticatedAt = session?.user?.authenticatedAt;
  return typeof session?.user?.id === 'string' &&
    typeof authenticatedAt === 'number' &&
    Number.isFinite(authenticatedAt) &&
    authenticatedAt <= now &&
    now - authenticatedAt <= MAX_REAUTH_AGE_MS;
}

/**
 * Deliberately opt-in. Production rollout requires Atlas transaction support,
 * a two-account staging drill, CSRF verification and an approved retention policy.
 * All operations must succeed atomically; a standalone MongoDB server that does
 * not support transactions must fail without deleting partial account data.
 */
export async function DELETE(request) {
  if (process.env.OGE_ACCOUNT_DELETION_ENABLED !== 'true') {
    return json({ error: 'Account deletion is not enabled on this deployment.' }, 503);
  }
  const session = await auth();
  if (!session?.user?.id) return json({ error: 'Sign in to delete your account.' }, 401);
  if (!canDeleteAccount(session)) {
    return json({ error: 'Sign out and sign in with Google again before requesting account deletion.' }, 403);
  }
  let payload;
  try {
    payload = JSON.parse(await readLimitedBody(request, 2048));
  } catch (error) {
    return json({ error: error?.status === 413 ? 'Request is too large.' : 'Invalid request body.' }, error?.status === 413 ? 413 : 400);
  }
  if (payload?.confirmation !== CONFIRMATION) {
    return json({ error: 'Type DELETE MY ACCOUNT exactly to confirm.' }, 400);
  }

  try {
    const db = await getDatabase();
    const ownerId = session.user.id;
    const throttle = await checkRateLimit(db, {
      scope: 'account-delete', identifier: ownerId, limit: 2, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return rateLimitResponse(throttle);

    // MongoDB replica-set transactions are required, not optional.
    const transaction = db.client.startSession();
    try {
      await transaction.withTransaction(async () => {
        const user = await db.collection('users').findOne(
          { googleSub: ownerId }, { session: transaction, projection: { _id: 1 } },
        );
        if (!user) throw new Error('Account not found');
        for (const name of OWNER_COLLECTIONS) {
          await db.collection(name).deleteMany({ ownerId }, { session: transaction });
        }
        // The user row owns the extension token and encrypted Gemini key.
        const deleted = await db.collection('users').deleteOne(
          { _id: user._id, googleSub: ownerId }, { session: transaction },
        );
        if (deleted.deletedCount !== 1) throw new Error('Account deletion conflict');
      });
    } finally {
      await transaction.endSession();
    }
    // All other JWTs now fail the persistent user/version check. A later Google
    // sign-in makes a new account with a different sessionVersion.
    return json({ deleted: true });
  } catch (error) {
    // Never log a Google account identifier, note contents or credential values.
    console.error('Account deletion transaction failed:', error?.name);
    return json({ error: 'Account deletion could not be completed. No successful deletion was confirmed.' }, 503);
  }
}
