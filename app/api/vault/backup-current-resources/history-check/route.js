import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import {
  exportVaultCurrentResourcesSnapshot,
} from '../../../../../lib/oge-vault-backup-current-resources.js';
import {
  vaultHistoricalResourceSourceCheckAllowed,
  assertVaultHistoricalResourceSourceClaim,
  compareVaultHistoricalResourceSourceClaim,
} from '../../../../../lib/oge-vault-historical-resource-source-verify.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  },
});

/**
 * E24/M92: isolated staging, separately default-off historical read-only
 * verification. Browser sends ONLY one locally M88-checked archive's
 * fingerprint metadata. No plaintext upload, import, restore or write.
 * Target must belong to at most 20 single-parent ancestry edges from
 * the signed owner's live private GitHub branch HEAD.
 */
export async function POST(request) {
  if (!vaultHistoricalResourceSourceCheckAllowed(process.env) ||
      request.headers.get('origin') !== process.env.OGE_STAGING_URL)
    return json({ error: 'Private historical source preview unavailable.' }, 404);
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get('content-type') || ''))
    return json({ error: 'JSON fingerprint required.' }, 415);

  let claim;
  try {
    claim = assertVaultHistoricalResourceSourceClaim(JSON.parse(
      await readLimitedBody(request, 512)));
  } catch (error) {
    return json({ error: 'Invalid bounded historical fingerprint.' },
      error?.status === 413 ? 413 : 400);
  }

  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to inspect your private Vault history.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    // Historical scans can read every blob from a complete archive:
    // independent hard cap of TWO per hour; transient Mongo metadata only.
    const throttle = await checkRateLimit(db, {
      scope: 'vault_historical_resource_check',
      identifier: ownerId,
      limit: 2, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const client = await getVaultNoteClient(
      db, { ownerId, sessionVersion }, { readOnly: true });
    const source = await exportVaultCurrentResourcesSnapshot(client, {
      historicalSnapshot: claim.snapshot,
      subjectVerifier: async subjectIds => {
        if (subjectIds.length === 0) return true;
        const rows = await db.collection('subjects').find({
          ownerId, slug: { $in: subjectIds },
        }, { projection: { _id: 0, slug: 1 } }).toArray();
        const found = new Set(rows.map(row => row.slug));
        return found.size === subjectIds.length &&
          subjectIds.every(id => found.has(id));
      },
    });

    const account = await db.collection('users').findOne(
      ownerMutationFilter(ownerId, { sessionVersion }),
      { projection: { vault: 1 } },
    );
    const saved = account?.vault;
    if (!saved || saved.status !== 'connected' ||
        saved.repoId !== client.vault.repoId ||
        saved.installationId !== client.vault.installationId ||
        saved.githubAccountId !== client.vault.githubAccountId ||
        saved.githubLogin !== client.vault.githubLogin ||
        saved.repoName !== client.vault.repoName)
      return json({ error: 'Private Vault owner or installation changed.' }, 409);

    // Never return the owner, SHA claims, historical Note IDs, blob or body.
    return json(compareVaultHistoricalResourceSourceClaim(claim, source));
  } catch {
    // Includes absent/missing/truncated history, force-push, merge, head
    // movement, rate/provider faults or unavailable past subject ownership.
    // All are HOLD, not permission to attempt a write or retry.
    return json({ error: 'Private historical source cannot be authenticated.' }, 503);
  }
}
