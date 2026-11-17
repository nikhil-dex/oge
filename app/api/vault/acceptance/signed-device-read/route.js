import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import {
  signedStandaloneRestoreContext,
  standaloneRestoreSafeguards,
} from '../../../../../lib/oge-vault-standalone-restore-staging.js';
import {
  signedDeviceAcceptanceReadAllowed,
  inspectSignedDeviceAcceptanceReadOnly,
} from '../../../../../lib/oge-vault-signed-device-acceptance.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reply = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff' },
});

/**
 * M82: protected disposable staging ONLY, current Auth.js signed owner,
 * one explicit operator nonce per signed-in browser observation, TWO
 * independent contents:read private GitHub App clients, no write token.
 *
 * No self-reported slot can independently prove a physical device, OAuth
 * provider, dual session, or restore/write acceptance. No Note data returned.
 */
export async function POST(request) {
  if (!signedDeviceAcceptanceReadAllowed(request))
    return reply({ error: 'Signed device acceptance observation disabled.' }, 404);
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get('content-type') || ''))
    return reply({ error: 'JSON challenge required.' }, 415);
  try {
    const input = JSON.parse(await readLimitedBody(request, 512));
    if (!input || typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'challenge,deviceSlot')
      return reply({ error: 'Invalid bounded acceptance challenge.' }, 400);

    // Auth/session and GitHub App trust binding established server-side.
    // No caller-selected repo/owner, OAuth token or provider permission.
    const { db, identity, readClient } =
      await signedStandaloneRestoreContext();
    const second = await getVaultNoteClient(
      db, identity, { readOnly: true });
    const { ownerVerifier } = standaloneRestoreSafeguards(
      db, identity, readClient);
    const report = await inspectSignedDeviceAcceptanceReadOnly(
      readClient, second, {
        ownerVerifier, challenge: input.challenge,
        deviceSlot: input.deviceSlot,
      },
    );
    if (!await ownerVerifier())
      return reply({ error: 'Signed Vault owner changed during check.' }, 409);
    return reply(report);
  } catch {
    // Never log or echo signed tokens, private repos, owner IDs, source data,
    // GitHub provider errors, incident IDs or uploaded nonce.
    return reply({ error: 'Private signed acceptance check unavailable.' }, 409);
  }
}
