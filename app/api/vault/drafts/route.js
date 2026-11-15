import { auth } from '../../../../auth.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import {
  draftKey, validatedHybridDraft, putHybridDraft, getHybridDraft,
} from '../../../../lib/oge-vault-hybrid-drafts.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store' },
});

// Only usable after both the main Vault preview and explicit hybrid draft
// flag have been enabled in a protected staging environment.
async function context() {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true') return { disabled: true };
  const session = await auth();
  if (!session?.user?.id) return { unauthorized: true };
  const db = await getDatabase();
  // Enforces the signed sessionVersion and connected owner-owned private repo.
  const client = await getVaultNoteClient(db, {
    ownerId: session.user.id, sessionVersion: session.user.sessionVersion,
  });
  return { db, client, ownerId: session.user.id, repoId: client.vault.repoId };
}

function failure(error) {
  if (error instanceof VaultGitHubError) return json({ error: error.message },
    error.status === 401 ? 401 : error.status === 409 ? 409 : 503);
  if (error?.code === 11000 || error?.message === 'vault-draft-revision-conflict')
    return json({ error: 'vault-draft-revision-conflict' }, 409);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid draft request.' }, 400);
  console.error('Hybrid vault draft operation failed:', error?.name);
  return json({ error: 'Draft operation unavailable. Keep your local copy.' }, 503);
}

async function authorizedContext() {
  const ctx = await context();
  if (ctx.disabled) return { response: json({ error: 'Hybrid drafts disabled.' }, 404) };
  if (ctx.unauthorized) return { response: json({ error: 'Sign in required.' }, 401) };
  return { ctx };
}

export async function GET(request) {
  try {
    const { ctx, response } = await authorizedContext();
    if (response) return response;
    const noteId = new URL(request.url).searchParams.get('id');
    const scope = draftKey(ctx.ownerId, ctx.repoId, noteId);
    return json({ item: await getHybridDraft(ctx.db.collection('vault_drafts'), scope) });
  } catch (error) { return failure(error); }
}

export async function PUT(request) {
  try {
    const { ctx, response } = await authorizedContext();
    if (response) return response;
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const input = JSON.parse(await readLimitedBody(request, 32768));
    const scope = draftKey(ctx.ownerId, ctx.repoId, input?.id);
    const draft = validatedHybridDraft(input?.draft);
    const subject = await ctx.db.collection('subjects').findOne({
      ownerId: ctx.ownerId, slug: draft.subjectId,
    }, { projection: { _id: 1 } });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    // A draft never claims to have been written to GitHub.
    const result = await putHybridDraft(ctx.db.collection('vault_drafts'),
      scope, input.revision, draft);
    return json({ ...result, savedTo: 'temporary-draft' });
  } catch (error) { return failure(error); }
}
