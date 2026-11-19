import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import {
  m102OwnerBindingServerEnabled, m102OwnerBindingTag,
} from '../../../../../lib/oge-learning-track-m102-owner-binding.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const respond = (data, status = 200) => Response.json(data, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Cookie',
  },
});

/**
 * M102: isolated staging only. Server-derived HMAC commitment to the exact
 * active signed account/session version + Vault mapping + operator-declared run.
 * Neither the account ID, repository ID, server HMAC key nor session leaves.
 * This is a point-in-time server assertion, not independent identity proof.
 */
export async function GET(request) {
  const env = process.env;
  if (!m102OwnerBindingServerEnabled(env))
    return respond({ error: 'Staging owner-binding check disabled.' }, 404);
  try {
    const url = new URL(request.url);
    if (url.origin !== env.OGE_STAGING_URL ||
        request.headers.get('origin') !== env.OGE_STAGING_URL ||
        url.searchParams.size !== 1 ||
        url.searchParams.getAll('run').length !== 1 ||
        url.searchParams.get('run') !== env.OGE_LEARNING_TRACK_M101_RUN_ID)
      return respond({ error: 'Invalid staging acceptance scope.' }, 400);
    const session = await auth();
    if (!session?.user?.id)
      return respond({ error: 'Active signed owner session required.' }, 401);
    const db = await getDatabase();
    // A revoked session cannot reuse an old HMAC binding.
    const identity = {
      ownerId: session.user.id,
      sessionVersion: session.user.sessionVersion,
    };
    const account = await db.collection('users').findOne(
      ownerMutationFilter(identity.ownerId, { sessionVersion: identity.sessionVersion }),
      { projection: { vault: 1 } });
    if (!account) return respond({ error: 'Current owner session is unavailable.' }, 401);
    const limit = await checkRateLimit(db, {
      scope: 'learning-track-m102-binding',
      identifier: identity.ownerId, limit: 8, windowMs: 3600000,
    });
    if (!limit.allowed) return rateLimitResponse(limit);
    const bindingSha256 = m102OwnerBindingTag(identity, account, env);
    return respond({
      status: 'OWNER_VAULT_SESSION_MAPPING_OBSERVED_HOLD',
      bindingSha256,
      releaseAuthorized: false,
    });
  } catch {
    // Do not expose session identifiers, provider responses or signing errors.
    return respond({ error: 'Cannot establish a safe staging owner binding.' }, 503);
  }
}
