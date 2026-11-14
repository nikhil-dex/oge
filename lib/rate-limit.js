import { createHash } from 'node:crypto';

const MAX_SCOPE_LENGTH = 64;

/**
 * Shared MongoDB-backed fixed-window limiter. Atomic upserts enforce the limit
 * across application instances; TTL removes old buckets asynchronously.
 * Fail closed on database errors rather than bypassing an abuse control.
 */
export async function checkRateLimit(db, { scope, identifier, limit, windowMs, now = Date.now() }) {
  if (!/^[a-z0-9:_-]{1,64}$/i.test(scope) || scope.length > MAX_SCOPE_LENGTH ||
      typeof identifier !== 'string' || !identifier ||
      !Number.isSafeInteger(limit) || limit < 1 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1000) {
    throw new TypeError('Invalid rate limit configuration');
  }
  const window = Math.floor(now / windowMs);
  const key = createHash('sha256').update(scope + '\\0' + identifier + '\\0' + window).digest('hex');
  const collection = db.collection('rateLimitBuckets');
  const expiresAt = new Date((window + 2) * windowMs);
  try {
    const result = await collection.findOneAndUpdate(
      { _id: key, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: 'after', projection: { count: 1 } },
    );
    if (!result) throw new Error('Rate limit bucket update returned no result');
    return { allowed: true, remaining: Math.max(0, limit - result.count), retryAfter: 0 };
  } catch (error) {
    // A duplicate key occurs when the existing bucket reached its limit.
    if (error?.code !== 11000) throw error;
    return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000)) };
  }
}

/**
 * Shared burst protection for owner-scoped CRUD mutations. This is distinct
 * from stricter limits on costly third-party integrations and credential APIs.
 */
export function checkOwnerMutationLimit(db, ownerId, resource) {
  if (!['notes', 'subjects', 'quick-notes', 'airnotes', 'saved-links'].includes(resource)) {
    throw new TypeError('Unknown mutation resource');
  }
  return checkRateLimit(db, {
    scope: 'mutation-' + resource,
    identifier: ownerId,
    limit: 120,
    windowMs: 60 * 1000,
  });
}

export function rateLimitResponse(result) {
  return Response.json(
    { error: 'Too many requests. Try again later.' },
    { status: 429, headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfter),
      'X-RateLimit-Remaining': '0',
    } },
  );
}
