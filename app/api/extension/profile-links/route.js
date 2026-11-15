import { hashExtensionToken } from '../../../../lib/extension-token.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { normalizeSocialLink } from '../../../../lib/profile-settings.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_PATTERN = /^oge_[A-Za-z0-9_-]{40,60}$/;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Vary': 'Origin',
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

/**
 * Read-only, token-scoped access to the three explicitly saved social links.
 * Extension tokens are already granted access to owner-scoped link creation.
 * Never return account email, username, user ID or the token itself.
 */
export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!TOKEN_PATTERN.test(token)) return json({ error: 'A valid extension token is required.' }, 401);

  try {
    const db = await getDatabase();
    const tokenHash = hashExtensionToken(token);
    const limit = await checkRateLimit(db, {
      scope: 'extension-profile-links',
      identifier: tokenHash,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) return rateLimitResponse(limit);

    const user = await db.collection('users').findOne(
      { extensionTokenHash: tokenHash, extensionTokenExpiresAt: { $gt: new Date() } },
      { projection: { socialLinks: 1 } },
    );
    if (!user) return json({ error: 'This extension connection expired or was revoked. Reconnect it in OgeNotes.' }, 401);

    const raw = user.socialLinks || {};
    const links = {};
    for (const kind of ['github', 'linkedin', 'portfolio']) {
      const link = normalizeSocialLink(kind, raw[kind] || '');
      if (typeof link === 'string') links[kind] = link;
    }
    return json({ links });
  } catch (error) {
    console.error('GET /api/extension/profile-links failed:', error?.name);
    return json({ error: 'Could not load your profile links.' }, 500);
  }
}
