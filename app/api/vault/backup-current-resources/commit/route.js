import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import {
  MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from '../../../../../lib/oge-vault-backup-current-resources.js';
import {
  validateStandaloneRestoreSelection,
  executeApprovedStandaloneRestoreBatch,
} from '../../../../../lib/oge-vault-standalone-restore-approval.js';
import {
  standaloneRestoreStagingAllowed, signedStandaloneRestoreContext,
  standaloneRestoreSafeguards, standaloneRestoreHttpError,
} from '../../../../../lib/oge-vault-standalone-restore-staging.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { withVaultOwnerImportExclusive } from '../../../../../lib/oge-vault-import-fence.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

/**
 * M75 stage 2: explicit SAME-ORIGIN owner-approved CREATE-ONLY one-kind,
 * max-12 standalone GitHub restore. Disabled even on staging until a
 * separate irreversible write ACK. No legacy Notes import, migration,
 * bulk loop, draft deletion, overwrite or automatic GitHub PATCH replay.
 */
export async function POST(request) {
  if (!standaloneRestoreStagingAllowed(request, { write: true }))
    return json({ error: 'Owner-approved standalone restore write disabled.' }, 404);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only approved JSON restore selections are accepted.' }, 415);

    const value = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 4096));
    // Reject malformed/untrusted archive and selection before ANY GitHub
    // provider access or account-row import fence mutation.
    validateStandaloneRestoreSelection(value, { commit: true });

    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(db,
      identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const safeguards = standaloneRestoreSafeguards(db, identity, readClient);

    // This existing durable import fence blocks other-device autosave and
    // standalone edits across the entire owner's private Vault.
    // markGitHubWriteAttempt persists only exact HEAD, selected UUIDs and
    // content-free marker SHA before the FIRST GitHub mutation. Any error
    // after marking retains the lock for explicit operator reconciliation.
    const result = await withVaultOwnerImportExclusive(db, {
      ...identity, repoId: readClient.vault.repoId,
    }, async ({ markGitHubWriteAttempt }) => {
      const writeClient = await getVaultNoteClient(db, identity);
      return executeApprovedStandaloneRestoreBatch(
        readClient, writeClient, value, safeguards, {
          markGitHubWriteAttempt,
        });
    });

    if (!await safeguards.ownerVerifier())
      return json({ error: 'Owner or private Vault changed after restore.' }, 409);
    return json(result);
  } catch (error) { return standaloneRestoreHttpError(error); }
}
