import { getDatabase } from '../../../lib/mongodb.js';
import { isHealthCheckAuthorized } from '../../../lib/healthcheck-auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reply(status, body) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function GET(request) {
  // Configuration failures do not turn this into a public status endpoint.
  if (!isHealthCheckAuthorized(request.headers.get('authorization'), process.env.OGE_HEALTHCHECK_TOKEN)) {
    return reply(401, { status: 'unauthorized' });
  }
  try {
    const db = await getDatabase();
    await db.command({ ping: 1 }, { maxTimeMS: 3000 });
    return reply(200, { status: 'ok' });
  } catch (error) {
    // Do not leak Mongo connection strings, cluster names, user data or traces.
    console.error('Health dependency check failed:', error instanceof Error ? error.name : 'UnknownError');
    return reply(503, { status: 'unavailable' });
  }
}
