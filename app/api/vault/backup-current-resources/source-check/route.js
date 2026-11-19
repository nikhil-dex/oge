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
  vaultCurrentResourceSourceCheckAllowed,
  assertVaultCurrentResourceSourceClaim,
  compareVaultCurrentResourceSourceClaim,
} from '../../../../../lib/oge-vault-current-resource-source-verify.js';

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
 * E21/M89 owner-authenticated, explicitly default-OFF staging-only read.
 * This POST transports ONLY the locally checked backup fingerprint,
 * commit/tree IDs and three numeric counts; never a Note or archive body.
 * Server uses its own private GitHub App contents:read token and reexports
 * current HEAD bytes, computes SHA256 independently and compares.
 * Rate limiter mutates ONLY transient Mongo metadata (never Notes).
 * A matching result is NOT restoration, permanent source attestation or
 * approval to release an uncertain GitHub-write quarantine.
 */
export async function POST(request) {
  if (!vaultCurrentResourceSourceCheckAllowed(process.env) ||
      request.headers.get('origin') !== process.env.OGE_STAGING_URL)
    return json({ error: 'Current source verification preview unavailable.' }, 404);
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get('content-type') || ''))
    return json({ error: 'JSON fingerprint required.' }, 415);
  let claim;
  try {
    claim = assertVaultCurrentResourceSourceClaim(JSON.parse(
      await readLimitedBody(request, 512)));
  } catch (error) {
    return json({ error: 'Invalid bounded private source fingerprint.' },
      error?.status === 413 ? 413 : 400);
  }

  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to inspect your current private Vault.' }, 401);
    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    // Full M73 exporter may read thousands of private immutable blob files.
    // Strict distributed rate cap: 3 calls per owner per hour. This updates
    // only transient rateLimitBuckets metadata, NOT Note content.
    const throttle = await checkRateLimit(db, {
      scope: 'vault_source_check',
      identifier: ownerId,
      limit: 3, windowMs: 60 * 60 * 1000,
    });
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const client = await getVaultNoteClient(
      db, { ownerId, sessionVersion }, { readOnly: true });
    const source = await exportVaultCurrentResourcesSnapshot(client, {
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
      return json({ error: 'Owner or private repository changed during inspection.' }, 409);

    // Return ONLY comparison booleans. No current Git SHA, digests,
    // owner, Note headings, titles, IDs, or archive plaintext.
    return json(compareVaultCurrentResourceSourceClaim(claim, source));
  } catch {
    // Provider errors, owner IDs, tokens and private Note contents are
    // intentionally neither logged nor echoed.
    return json({ error: 'Private GitHub source check unavailable.' }, 503);
  }
}
