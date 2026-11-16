import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { checkVaultStagingReadiness } from '../../../../lib/oge-vault-staging-preflight.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { withVaultOwnerDraftWrite } from '../../../../lib/oge-vault-import-fence.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import {
  standaloneDraftScope, putStandaloneDraft, readStandaloneDraft,
  openStandaloneDraft, reconcileStandaloneDraft,
} from '../../../../lib/oge-vault-standalone-drafts.js';

/**
 * E3/M71 — temporary encrypted autosave drafts for standalone Quick Notes
 * and AirNotes. NEVER a permanent MongoDB note content endpoint.
 *
 * GET: read / recover; PUT: only encrypted draft CAS; POST: read-only GitHub
 * verification + CAS draft cleanup. NO GitHub content mutation here.
 *
 * Disabled unless E2 and independently E3 previews are explicitly enabled
 * with complete isolated staging preflight and disposable test database.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff' },
});
const KINDS = new Set(['quick-notes', 'airnotes']);

function enabled(env = process.env) {
  return env.OGE_VAULT_STANDALONE_DRAFT_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    checkVaultStagingReadiness(env).ok;
}

function failure(error) {
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid standalone draft request.' }, 400);
  if (error instanceof VaultGitHubError) {
    const status = error.status === 401 ? 401 :
      error.status === 404 ? 404 : error.status === 429 ? 429 :
        [409, 422].includes(error.status) ? 409 : 503;
    return json({ error: error.message }, status);
  }
  if (error?.code === 11000)
    return json({ error: 'vault-standalone-draft-revision-conflict' }, 409);
  console.error('Standalone encrypted Vault draft operation failed:', error?.name);
  return json({ error: 'Temporary draft service unavailable. Keep your local copy.' }, 503);
}

async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const identity = {
    ownerId: session.user.id, sessionVersion: session.user.sessionVersion,
  };
  const db = await getDatabase();
  // Draft autosave MUST keep working while GitHub is offline. Authenticate
  // signed owner + repo mapping from account row; only reconciliation
  // requires a fresh private contents:read GitHub App installation token.
  const user = await db.collection('users').findOne(
    ownerMutationFilter(identity.ownerId, {
      sessionVersion: identity.sessionVersion,
    }), { projection: { vault: 1 } },
  );
  if (!user) throw new VaultGitHubError('session-expired', 401);
  if (user.vault?.status !== 'connected' ||
      !Number.isSafeInteger(user.vault.repoId) || user.vault.repoId < 1 ||
      !Number.isSafeInteger(user.vault.installationId) ||
      user.vault.installationId < 1)
    throw new VaultGitHubError('vault-not-connected', 409);
  return { db, identity, repoId: user.vault.repoId };
}

function scope(ctx, kind, id) {
  return standaloneDraftScope(ctx.identity.ownerId, ctx.repoId, kind, id);
}
function validQuery(params, names) {
  return params.size === names.length && names.every((name) =>
    params.has(name)) && [...params.keys()].every((name) =>
    names.includes(name));
}

export async function GET(request) {
  if (!enabled()) return json({ error: 'Standalone encrypted drafts disabled.' }, 404);
  try {
    const params = new URL(request.url).searchParams;
    const kind = params.get('kind');
    if (!KINDS.has(kind))
      return json({ error: 'Invalid standalone draft kind.' }, 400);
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to recover private drafts.' }, 401);
    if (validQuery(params, ['kind', 'new']) && params.get('new') === 'true') {
      const rows = await ctx.db.collection('vault_standalone_drafts')
        .find({ ownerId: ctx.identity.ownerId, repoId: ctx.repoId,
          kind, isNew: true })
        .sort({ updatedAt: -1 }).limit(21).toArray();
      if (rows.length > 20) {
        // No implicit truncated or ambiguous list; use one exact UUID
        // or owner-directed recovery instead of returning a partial list.
        return json({ items: [], limited: true, needsManualRecovery: true }, 409);
      }
      return json({
        items: rows.map((row) => {
          const key = scope(ctx, kind, row.captureId);
          const draft = openStandaloneDraft(key, row.revision, row.encrypted);
          if (draft.baseSha !== null || row.status !== 'pending')
            throw new TypeError('Unexpected non-new draft');
          return { id: key.captureId, revision: row.revision, draft };
        }), limited: false,
      });
    }
    if (!validQuery(params, ['kind', 'id']))
      return json({ error: 'An exact draft UUID is required.' }, 400);
    return json({ item: await readStandaloneDraft(
      ctx.db.collection('vault_standalone_drafts'), scope(ctx, kind, params.get('id')),
    ) });
  } catch (error) { return failure(error); }
}

export async function PUT(request) {
  if (!enabled()) return json({ error: 'Standalone encrypted drafts disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to autosave drafts.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId,
      'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const data = JSON.parse(await readLimitedBody(request, 32768));
    if (!data || !KINDS.has(data.kind))
      return json({ error: 'Invalid standalone draft kind.' }, 400);
    const key = scope(ctx, data.kind, data.id);
    const outcome = await withVaultOwnerDraftWrite(ctx.db, {
      ...ctx.identity, repoId: ctx.repoId,
    }, () => putStandaloneDraft(
      ctx.db.collection('vault_standalone_drafts'),
      key, data.revision, data.draft,
    ));
    return json(outcome);
  } catch (error) { return failure(error); }
}

export async function POST(request) {
  if (!enabled()) return json({ error: 'Standalone encrypted drafts disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to confirm GitHub Save.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId,
      'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const data = JSON.parse(await readLimitedBody(request, 4096));
    if (!data || !KINDS.has(data.kind))
      return json({ error: 'Invalid standalone draft kind.' }, 400);
    const key = scope(ctx, data.kind, data.id);
    // This is a fresh, verified contents:read GitHub token, never a content
    // writer. All cleanup happens behind the owner import/write fence.
    const client = await getVaultNoteClient(ctx.db, ctx.identity,
      { readOnly: true });
    const result = await withVaultOwnerDraftWrite(ctx.db, {
      ...ctx.identity, repoId: ctx.repoId,
    }, () => reconcileStandaloneDraft(
      ctx.db.collection('vault_standalone_drafts'),
      client, key, data.revision, data.sha,
    ));
    return json(result, result.confirmed && result.cleared ? 200 : 409);
  } catch (error) { return failure(error); }
}
