import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { checkVaultStagingReadiness } from '../../../../lib/oge-vault-staging-preflight.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import {
  checkOwnerMutationLimit, rateLimitResponse,
} from '../../../../lib/rate-limit.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultOwnerDraftWrite } from '../../../../lib/oge-vault-import-fence.js';
import {
  listVaultStandaloneCaptures, getVaultStandaloneCapture,
  commitVaultStandaloneCapture,
} from '../../../../lib/oge-vault-standalone-captures.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});
const kindAllowed = (value) => value === 'quick-notes' || value === 'airnotes';
const validId = (id) => typeof id === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/**
 * E2/M70 standalone GitHub content preview, separate from the existing
 * /api/quick-notes and /api/personal-quick-notes permanent MongoDB APIs.
 * No UI, extension token grants, automatic migration or autosave is enabled.
 * Production must NEVER enable the isolated preview's test credentials.
 */
function previewAllowed(env = process.env) {
  return env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    checkVaultStagingReadiness(env).ok;
}
async function context(readOnly) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const identity = {
    ownerId: session.user.id, sessionVersion: session.user.sessionVersion,
  };
  const client = await getVaultNoteClient(db, identity, { readOnly });
  return { db, identity, client };
}
function respondError(err) {
  if (err instanceof TypeError || err instanceof SyntaxError)
    return json({ error: 'Invalid standalone Vault capture request.' }, 400);
  if (err instanceof VaultGitHubError) {
    const status = err.status === 401 ? 401 :
      err.status === 404 ? 404 : err.status === 429 ? 429 :
        [409, 422].includes(err.status) ? 409 : 503;
    return json({ error: err.message }, status);
  }
  console.error('Standalone Vault preview failed:', err?.name);
  return json({ error: 'Standalone Vault operation cannot be verified.' }, 503);
}
async function parse(request) {
  return JSON.parse(await readLimitedBody(request, 32 * 1024));
}

export async function GET(request) {
  if (!previewAllowed()) return json({ error: 'Staging-only standalone Vault preview disabled.' }, 404);
  try {
    const url = new URL(request.url);
    if (url.searchParams.size > 2 || !kindAllowed(url.searchParams.get('kind')) ||
        [...url.searchParams.keys()].some((key) => !['kind', 'id'].includes(key)))
      return json({ error: 'Select quick-notes or airnotes.' }, 400);
    const ctx = await context(true);
    if (!ctx) return json({ error: 'Sign in to view private Vault entries.' }, 401);
    const kind = url.searchParams.get('kind');
    const id = url.searchParams.get('id');
    if (id !== null)
      return json(await getVaultStandaloneCapture(ctx.client, kind, id));
    return json(await listVaultStandaloneCaptures(ctx.client, kind));
  } catch (error) { return respondError(error); }
}

async function mutate(request, mode) {
  if (!previewAllowed()) return json({ error: 'Staging-only standalone Vault preview disabled.' }, 404);
  try {
    const ctx = await context(false);
    if (!ctx) return json({ error: 'Sign in to edit private Vault entries.' }, 401);
    const data = mode === 'delete' ?
      Object.fromEntries(new URL(request.url).searchParams.entries()) :
      await parse(request);
    if (!data || !kindAllowed(data.kind) || !validId(data.id) ||
        (mode === 'create' ? data.sha !== undefined :
          !validSha(data.sha)) ||
        (mode === 'delete' ? data.content !== undefined :
          typeof data.content !== 'string'))
      return json({ error: 'Capture kind, UUID, content and expected revision required.' }, 400);
    if (mode === 'delete' &&
        [...new URL(request.url).searchParams.keys()].some((key) =>
          !['kind', 'id', 'sha'].includes(key)))
      return json({ error: 'Unsupported delete request.' }, 400);
    const throttle = await checkOwnerMutationLimit(ctx.db,
      ctx.identity.ownerId, data.kind === 'airnotes' ? 'airnotes' : 'quick-notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const scope = {
      ownerId: ctx.identity.ownerId,
      sessionVersion: ctx.identity.sessionVersion,
      repoId: ctx.client.vault.repoId,
    };
    // Preserve account-wide import/restore quarantine across ALL GitHub
    // capture writes, even when a standalone item has no subject.
    const saved = await withVaultOwnerDraftWrite(ctx.db, scope,
      () => commitVaultStandaloneCapture(ctx.client, {
        kind: data.kind, action: mode, id: data.id,
        ...(mode === 'delete' ? {} : { content: data.content }),
        sha: data.sha || null,
      }));
    return json(saved, mode === 'create' ? 201 : 200);
  } catch (error) { return respondError(error); }
}
export async function POST(request) { return mutate(request, 'create'); }
export async function PUT(request) { return mutate(request, 'update'); }
export async function DELETE(request) { return mutate(request, 'delete'); }
