import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { MAX_VAULT_RESOURCE_BACKUP_BYTES } from '../../../../../lib/oge-vault-backup-current-resources.js';
import { validateStandaloneRestoreSelection } from '../../../../../lib/oge-vault-standalone-restore-approval.js';
import {
  reconcileStandaloneRestoreReadOnly,
} from '../../../../../lib/oge-vault-standalone-restore-reconcile.js';
import {
  standaloneRestoreIncidentReaders,
} from '../../../../../lib/oge-vault-standalone-restore-incident-readers.js';
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
 * M77: signed-owner isolated HTTPS staging only, POST JSON for an EXACT
 * incident and complete M73 private source archive. Always read-only.
 *
 * No use of a write-scoped GitHub token; no endpoint to release locks,
 * retry PATCH, alter receipt state, discard drafts or restore notes.
 */
export async function POST(request) {
  if (!standaloneRestoreStagingAllowed(request, { reconcile: true }))
    return json({ error: 'Standalone restore forensic inspection disabled.' }, 404);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only full private JSON archive incidents are accepted.' }, 415);
    const supplied = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 8192));
    if (!supplied || typeof supplied !== 'object' ||
        Array.isArray(supplied) || Object.keys(supplied).sort().join(',') !==
        'archive,confirmation,expectedOperationId,expectedSelectionFingerprint,expectedTargetHead,kind,selectedIds')
      return json({ error: 'Exact signed owner restore incident scope required.' }, 400);
    const { expectedOperationId, ...approved } = supplied;
    // Validation before acquiring private GitHub App credentials or
    // touching MongoDB owner-scoped metadata.
    validateStandaloneRestoreSelection(approved, { commit: true });

    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(
      db, identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const safeguards = standaloneRestoreSafeguards(
      db, identity, readClient);
    const { lockReader, receiptReader } =
      standaloneRestoreIncidentReaders(db, identity, readClient);

    const report = await reconcileStandaloneRestoreReadOnly(
      readClient, approved, {
        expectedOperationId,
        ownerVerifier: safeguards.ownerVerifier,
        lockReader,
        receiptReader,
      },
    );
    // No stale account incarnation can receive the private metadata
    // report even if revoked at the very end of the GitHub read.
    if (!await safeguards.ownerVerifier())
      return json({ error: 'Private Vault owner changed during inspection.' }, 409);
    return json(report);
  } catch (error) { return standaloneRestoreHttpError(error); }
}
