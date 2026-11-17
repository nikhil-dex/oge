import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { MAX_VAULT_RESOURCE_BACKUP_BYTES } from '../../../../../lib/oge-vault-backup-current-resources.js';
import { validateStandaloneRestoreSelection } from '../../../../../lib/oge-vault-standalone-restore-approval.js';
import {
  standaloneRestoreStagingAllowed, signedStandaloneRestoreContext,
  standaloneRestoreSafeguards, standaloneRestoreHttpError,
} from '../../../../../lib/oge-vault-standalone-restore-staging.js';
import {
  standaloneRestoreIncidentReaders,
} from '../../../../../lib/oge-vault-standalone-restore-incident-readers.js';
import {
  reviewStandaloneRestoreQuarantineReadOnly,
} from '../../../../../lib/oge-vault-standalone-quarantine-review.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});
const FIELDS = [
  'archive', 'confirmation', 'expectedOperationId',
  'expectedSelectionFingerprint', 'expectedTargetHead', 'incidentId',
  'kind', 'reviewConfirmation', 'selectedIds',
].sort().join(',');

/**
 * E10/M78: Signed-owner disposable staging review of an EXACT uncertain
 * M75/M76 incident. Read-only evidence + safety blockers, NEVER a lock
 * release request, approval token, reissued ticket or GitHub retry.
 */
export async function POST(request) {
  if (!standaloneRestoreStagingAllowed(request, { review: true }))
    return json({ error: 'Vault quarantine recovery review disabled.' }, 404);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON restore review is accepted.' }, 415);
    const data = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 8192));
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).sort().join(',') !== FIELDS ||
        data.reviewConfirmation !==
          'INSPECT_QUARANTINED_STANDALONE_RESTORE_READ_ONLY')
      return json({ error: 'Exact read-only quarantine incident scope required.' }, 400);
    const { incidentId, expectedOperationId,
      reviewConfirmation: _reviewConfirmation, ...approved } = data;
    // Reject malformed archive and selected UUIDs before any private DB
    // or GitHub App credentials are obtained.
    validateStandaloneRestoreSelection(approved, { commit: true });

    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(
      db, identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const { lockReader, receiptReader, auxiliaryReader } =
      standaloneRestoreIncidentReaders(db, identity, readClient);
    const safeguards = standaloneRestoreSafeguards(db, identity, readClient);

    const report = await reviewStandaloneRestoreQuarantineReadOnly(
      readClient, approved, {
        incidentId, expectedOperationId,
        ownerVerifier: safeguards.ownerVerifier,
        lockReader, receiptReader, auxiliaryReader,
      },
    );
    if (!await safeguards.ownerVerifier())
      return json({ error: 'Signed Vault owner changed during review.' }, 409);
    return json(report);
  } catch (error) { return standaloneRestoreHttpError(error); }
}
