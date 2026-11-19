import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import {
  MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from '../../../../../lib/oge-vault-backup-current-resources.js';
import {
  validateStandaloneRestoreSelection,
  prepareVaultStandaloneRestoreIntent,
} from '../../../../../lib/oge-vault-standalone-restore-approval.js';
import {
  standaloneRestoreStagingAllowed, signedStandaloneRestoreContext,
  standaloneRestoreSafeguards, standaloneRestoreHttpError,
} from '../../../../../lib/oge-vault-standalone-restore-staging.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

/**
 * M75 stage 1: independent, same-origin authenticated *read-only* owner
 * selection preview. This never creates an approval ticket or GitHub write.
 * The returned fingerprint and private SHA-256 hash are NOT source proof.
 */
export async function POST(request) {
  if (!standaloneRestoreStagingAllowed(request))
    return json({ error: 'Standalone restore intent staging disabled.' }, 404);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON archive selections are accepted.' }, 415);
    const value = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 4096));
    validateStandaloneRestoreSelection(value);
    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(db,
      identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const safeguards = standaloneRestoreSafeguards(db, identity, readClient);
    const intent = await prepareVaultStandaloneRestoreIntent(
      readClient, value, safeguards);
    if (!await safeguards.ownerVerifier())
      return json({ error: 'Owner or private Vault changed during intent review.' }, 409);
    return json(intent);
  } catch (error) { return standaloneRestoreHttpError(error); }
}
