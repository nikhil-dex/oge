import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { getVaultNoteClient, listVaultNotes, listVaultNotePage, readVaultNote, saveVaultNote, deleteVaultNote } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultSubjectWrite, VaultSubjectLockedError } from '../../../../lib/oge-vault-subject-fence.js';

// Isolated experimental API; it does NOT replace any existing MongoDB note
// endpoint until all note paths, extension saves, and migration are verified.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorResponse(error) {
  if (error instanceof VaultSubjectLockedError) return json({ error: error.message }, 409);
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return json({ error: 'Invalid vault note request.' }, 400);
  }
  if (error instanceof VaultGitHubError) {
    const status = error.message === 'vault-not-connected' ? 409 :
      error.message === 'session-expired' ? 401 :
        error.message === 'vault-note-conflict' ? 409 :
          error.status === 404 ? 404 :
            error.status === 409 || error.status === 422 ? 409 : 503;
    return json({ error: error.message }, status);
  }
  console.error('Oge Vault notes API error:', error?.name);
  return json({ error: 'Vault notes service unavailable.' }, 503);
}

async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const identity = { ownerId: session.user.id, sessionVersion: session.user.sessionVersion };
  return { db, identity, client: await getVaultNoteClient(db, identity) };
}

function previewEnabled() {
  return process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true';
}

export async function GET(request) {
  if (!previewEnabled()) return json({ error: 'GitHub note preview is not enabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in first.' }, 401);
    const params = new URL(request.url).searchParams;
    const id = params.get('id');
    if (id) return json(await readVaultNote(ctx.client, id));
    if (params.get('paged') === 'true') {
      const limit = params.has('limit') ? Number(params.get('limit')) : 20;
      const cursor = params.get('cursor');
      return json(await listVaultNotePage(ctx.client, { limit, cursor }));
    }
    return json(await listVaultNotes(ctx.client));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  if (!previewEnabled()) return json({ error: 'GitHub note preview is not enabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in first.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const data = JSON.parse(await readLimitedBody(request, 32 * 1024));
    // The subject ID must be a validated, owner-owned subject, never an
    // arbitrary browser-supplied GitHub path.
    const subject = await ctx.db.collection('subjects').findOne({
      ownerId: ctx.identity.ownerId, slug: data?.subjectId,
    }, { projection: { _id: 1 } });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    const saved = await withVaultSubjectWrite(ctx.db, ctx.identity.ownerId, data.subjectId,
      () => saveVaultNote(ctx.client, {
        subjectId: data.subjectId, heading: data.heading, answer: data.answer,
        tags: data.tags, favorite: data.favorite,
      }));
    return json(saved, 201);
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request) {
  if (!previewEnabled()) return json({ error: 'GitHub note preview is not enabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in first.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const data = JSON.parse(await readLimitedBody(request, 32 * 1024));
    if (typeof data?.id !== 'string' || typeof data?.sha !== 'string') {
      return json({ error: 'Note ID and GitHub revision SHA are required.' }, 400);
    }
    const previous = await readVaultNote(ctx.client, data.id);
    const subject = await ctx.db.collection('subjects').findOne({
      ownerId: ctx.identity.ownerId, slug: previous.subjectId,
    }, { projection: { _id: 1 } });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    if (data.subjectId !== undefined && data.subjectId !== previous.subjectId) {
      return json({ error: 'Changing subjects is not yet supported.' }, 400);
    }
    const saved = await withVaultSubjectWrite(ctx.db, ctx.identity.ownerId, previous.subjectId,
      () => saveVaultNote(ctx.client, {
        subjectId: previous.subjectId, heading: data.heading, answer: data.answer,
        tags: data.tags, favorite: data.favorite ?? previous.favorite,
      }, { id: data.id, sha: data.sha }));
    return json(saved);
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request) {
  if (!previewEnabled()) return json({ error: 'GitHub note preview is not enabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in first.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const sha = url.searchParams.get('sha');
    const previous = await readVaultNote(ctx.client, id);
    return json(await withVaultSubjectWrite(ctx.db, ctx.identity.ownerId, previous.subjectId,
      () => deleteVaultNote(ctx.client, id, sha)));
  } catch (error) { return errorResponse(error); }
}
