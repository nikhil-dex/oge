import { randomBytes } from 'node:crypto';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { createExtensionToken, hashExtensionToken } from '../../../lib/extension-token.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function owner() {
  const session = await auth();
  return typeof session?.user?.id === 'string' ? session.user.id : null;
}
export async function GET() {
  try {
    const ownerId = await owner();
    if (!ownerId) return json({ error: 'Sign in to manage your browser extension.' }, 401);
    const db = await getDatabase();
    const user = await db.collection('users').findOne({ googleSub: ownerId }, { projection: { extensionTokenHash: 1, extensionTokenExpiresAt: 1, extensionTokenCreatedAt: 1 } });
    const active = Boolean(user?.extensionTokenHash && user.extensionTokenExpiresAt && new Date(user.extensionTokenExpiresAt) > new Date());
    return json({ connected: active, expiresAt: active ? user.extensionTokenExpiresAt : null, createdAt: active ? user.extensionTokenCreatedAt : null });
  } catch (error) {
    console.error('GET /api/extension-token failed:', error?.name);
    return json({ error: 'Could not load extension status.' }, 500);
  }
}
export async function POST() {
  try {
    const ownerId = await owner();
    if (!ownerId) return json({ error: 'Sign in to create an extension token.' }, 401);
    const db = await getDatabase();
    const token = createExtensionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    await db.collection('users').updateOne(
      { googleSub: ownerId },
      { $set: { extensionTokenHash: hashExtensionToken(token), extensionTokenCreatedAt: now, extensionTokenExpiresAt: expiresAt, updatedAt: now } },
    );
    return json({ token, createdAt: now, expiresAt }, 201);
  } catch (error) {
    console.error('POST /api/extension-token failed:', error?.name);
    return json({ error: 'Could not create an extension token.' }, 500);
  }
}
export async function DELETE() {
  try {
    const ownerId = await owner();
    if (!ownerId) return json({ error: 'Sign in to revoke your extension token.' }, 401);
    const db = await getDatabase();
    await db.collection('users').updateOne(
      { googleSub: ownerId },
      { $unset: { extensionTokenHash: '', extensionTokenCreatedAt: '', extensionTokenExpiresAt: '' }, $set: { updatedAt: new Date() } },
    );
    return json({ revoked: true });
  } catch (error) {
    console.error('DELETE /api/extension-token failed:', error?.name);
    return json({ error: 'Could not revoke the extension token.' }, 500);
  }
}
