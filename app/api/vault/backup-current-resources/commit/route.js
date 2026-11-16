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
import {
  standaloneRestoreApprovalBinding, standaloneRestoreTicketIdentity,
  verifyStandaloneRestoreTicket, claimStandaloneRestoreTicketOnce,
  confirmStandaloneRestoreTicket,
} from '../../../../../lib/oge-vault-standalone-restore-ticket.js';

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
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 8192));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.ticket !== 'string')
      return json({ error: 'A signed one-time owner approval ticket is required.' }, 400);
    const { ticket, ...approved } = value;
    // Fail closed on missing/changed full archive, selection or receipt
    // before any GitHub token or owner lock is acquired.
    validateStandaloneRestoreSelection(approved, { commit: true });

    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(db,
      identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const safeguards = standaloneRestoreSafeguards(db, identity, readClient);
    const ticketIdentity = standaloneRestoreTicketIdentity(identity, readClient);
    const binding = standaloneRestoreApprovalBinding(approved);
    const verified = verifyStandaloneRestoreTicket(
      ticket, ticketIdentity, binding, {
        secret: process.env.OGE_VAULT_STANDALONE_RESTORE_APPROVAL_KEY,
      });

    // This existing durable import fence blocks other-device autosave and
    // standalone edits across the entire owner's private Vault.
    // markGitHubWriteAttempt persists only exact HEAD, selected UUIDs and
    // content-free marker SHA before the FIRST GitHub mutation. Any error
    // after marking retains the lock for explicit operator reconciliation.
    const result = await withVaultOwnerImportExclusive(db, {
      ...identity, repoId: readClient.vault.repoId,
    }, async ({ markGitHubWriteAttempt }) => {
      // Atomic one-time claim is AFTER acquiring the owner-wide lock but
      // BEFORE the first possible GitHub write. Any subsequent failure
      // burns this ticket; a suspected remote write also retains the lock.
      await claimStandaloneRestoreTicketOnce(
        db, ticketIdentity, verified);
      const writeClient = await getVaultNoteClient(db, identity);
      const committed = await executeApprovedStandaloneRestoreBatch(
        readClient, writeClient, approved, safeguards, {
          markGitHubWriteAttempt,
        });
      // Confirm inside the durable exclusive lock. Lost MongoDB receipt
      // confirmation AFTER a GitHub mutation retains owner quarantine.
      await confirmStandaloneRestoreTicket(
        db, ticketIdentity, verified, committed.commitSha);
      return { ...committed, oneTimeApprovalClaimed: true,
        replayAllowed: false };
    });

    if (!await safeguards.ownerVerifier())
      return json({ error: 'Owner or private Vault changed after restore.' }, 409);
    return json(result);
  } catch (error) { return standaloneRestoreHttpError(error); }
}
