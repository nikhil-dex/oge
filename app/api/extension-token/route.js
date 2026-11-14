import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { createExtensionToken, hashExtensionToken } from '../../../lib/extension-token.js';
import { checkRateLimit, rateLimitResponse } from '../../../lib/rate-limit.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function owner() {
  const session = await auth();
  return typeof session?.user?.id === 'string'
    ? { ownerId: session.user.id, sessionVersion: session.user.sessionVersion }
    : null;
}
export async function GET() {
  try {
    const account = await owner();
    if (!account) return json({ error: 'Sign in to manage your browser extension.' }, 401);
    const { ownerId, sessionVersion } = account;
    const accountFilter = ownerMutationFilter(ownerId, { sessionVersion });
    const db = await getDatabase();
    const user = await db.collection('users').findOne(accountFilter, { projection: { extensionTokenHash: 1, extensionTokenExpiresAt: 1, extensionTokenCreatedAt: 1 } });
    const active = Boolean(user?.extensionTokenHash && user.extensionTokenExpiresAt && new Date(user.extensionTokenExpiresAt) > new Date());
    return json({ connected: active, expiresAt: active ? user.extensionTokenExpiresAt : null, createdAt: active ? user.extensionTokenCreatedAt : null });
  } catch (error) {
    console.error('GET /api/extension-token failed:', error?.name);
    return json({ error: 'Could not load extension status.' }, 500);
  }
}
export async function POST() {
  try {
    const account = await owner();
    if (!account) return json({ error: 'Sign in to create an extension token.' }, 401);
    const { ownerId, sessionVersion } = account;
    const accountFilter = ownerMutationFilter(ownerId, { sessionVersion });
    const db = await getDatabase();
    const throttle = await checkRateLimit(db, { scope: 'extension-token-create', identifier: ownerId, limit: 10, windowMs: 60 * 60 * 1000 });
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const token = createExtensionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const result = await db.collection('users').updateOne(
      accountFilter,
      { $set: { extensionTokenHash: hashExtensionToken(token), extensionTokenCreatedAt: now, extensionTokenExpiresAt: expiresAt, updatedAt: now } },
    );
    if (result.matchedCount !== 1) return json({ error: 'Your account is no longer available. Sign in again.' }, 401);
    return json({ token, createdAt: now, expiresAt }, 201);
  } catch (error) {
    console.error('POST /api/extension-token failed:', error?.name);
    return json({ error: 'Could not create an extension token.' }, 500);
  }
}
export async function DELETE() {
  try {
    const account = await owner();
    if (!account) return json({ error: 'Sign in to revoke your extension token.' }, 401);
    const { ownerId, sessionVersion } = account;
    const accountFilter = ownerMutationFilter(ownerId, { sessionVersion });
    const db = await getDatabase();
    const throttle = await checkRateLimit(db, {
      scope: 'extension-token-revoke', identifier: ownerId, limit: 30, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const result = await db.collection('users').updateOne(
      accountFilter,
      { $unset: { extensionTokenHash: '', extensionTokenCreatedAt: '', extensionTokenExpiresAt: '' }, $set: { updatedAt: new Date() } },
    );
    if (result.matchedCount !== 1) return json({ error: 'Your account is no longer available. Sign in again.' }, 401);
    return json({ revoked: true });
  } catch (error) {
    console.error('DELETE /api/extension-token failed:', error?.name);
    return json({ error: 'Could not revoke the extension token.' }, 500);
  }
}
