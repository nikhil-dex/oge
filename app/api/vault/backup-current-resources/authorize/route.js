import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';
import {
  MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from '../../../../../lib/oge-vault-backup-current-resources.js';
import {
  validateStandaloneRestoreSelection,
  prepareVaultStandaloneRestoreIntent,
} from '../../../../../lib/oge-vault-standalone-restore-approval.js';
import {
  issueStandaloneRestoreTicket, recordStandaloneRestoreTicket,
  standaloneRestoreTicketIdentity,
  standaloneRestoreApprovalBinding,
} from '../../../../../lib/oge-vault-standalone-restore-ticket.js';
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
 * M76: owner-initiated, one-time 10-minute signed receipt for a PREVIOUSLY
 * reviewed M75 intent. No GitHub writer. Uploaded private backup stays only
 * in memory; ledger stores owner/repo, nonce+approval HASHES, state and TTL.
 */
export async function POST(request) {
  if (!standaloneRestoreStagingAllowed(request, { authorize: true }))
    return json({ error: 'Standalone restore signed approval staging disabled.' }, 404);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON restore approvals are accepted.' }, 415);
    const value = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES + 4096));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.confirmation !== 'AUTHORIZE_SELECTED_STANDALONE_CREATE_ONLY')
      return json({ error: 'Explicit standalone restore approval required.' }, 400);
    const commitApproval = {
      ...value, confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
    };
    validateStandaloneRestoreSelection(commitApproval, { commit: true });
    const previewRequest = {
      archive: commitApproval.archive,
      kind: commitApproval.kind,
      selectedIds: commitApproval.selectedIds,
      expectedTargetHead: commitApproval.expectedTargetHead,
      confirmation: 'PREPARE_SELECTED_STANDALONE_CREATE_ONLY',
    };
    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const throttle = await checkOwnerMutationLimit(
      db, identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const safeguards = standaloneRestoreSafeguards(db, identity, readClient);
    const intent = await prepareVaultStandaloneRestoreIntent(
      readClient, previewRequest, safeguards);
    // Fresh signed owner/target/draft scan rather than trusting the
    // earlier M75 preview or even an archived source checksum.
    if (intent.selectionFingerprint !==
        commitApproval.expectedSelectionFingerprint)
      throw new VaultGitHubError('vault-standalone-ticket-intent-changed', 409);
    if (!await safeguards.ownerVerifier())
      throw new VaultGitHubError('vault-standalone-ticket-owner-changed', 409);

    const ticketIdentity = standaloneRestoreTicketIdentity(identity, readClient);
    const binding = standaloneRestoreApprovalBinding(commitApproval);
    const issued = issueStandaloneRestoreTicket(ticketIdentity, binding, {
      secret: process.env.OGE_VAULT_STANDALONE_RESTORE_APPROVAL_KEY,
    });
    await recordStandaloneRestoreTicket(db, ticketIdentity, issued);
    if (!await safeguards.ownerVerifier())
      throw new VaultGitHubError('vault-standalone-ticket-owner-changed', 409);

    return json({
      format: 'oge-vault-standalone-signed-restore-approval',
      version: 1,
      ticket: issued.ticket,
      expiresAt: issued.expiresAt.toISOString(),
      kind: binding.kind,
      selectedIds: binding.selectedIds,
      selectedCount: binding.selectedIds.length,
      targetHead: binding.expectedTargetHead,
      selectionFingerprint: binding.expectedSelectionFingerprint,
      oneTimeClaimRequired: true,
      signedOwnerSessionAndRepositoryBound: true,
      sourceGitHubIdentityAuthenticated: false,
      immediatelyExecutesRestore: false,
      productionRestoreAuthorized: false,
    });
  } catch (error) { return standaloneRestoreHttpError(error); }
}
