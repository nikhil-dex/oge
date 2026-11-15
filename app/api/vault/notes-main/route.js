import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { getVaultNoteClient, listVaultNotes, listVaultNotePage, readVaultNote } from '../../../../lib/oge-vault-notes.js';
import { commitVaultNoteBatch } from '../../../../lib/oge-vault-batch.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultSubjectWrite, VaultSubjectLockedError } from '../../../../lib/oge-vault-subject-fence.js';

// Staging adapter for the existing Notes UI. NEVER falls back to MongoDB
// note-content storage. The production /api/notes route is unchanged.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export function legacyVaultNote(note) {
  return {
    id: note.id, sha: note.sha,
    subjectSlug: note.subjectId, heading: note.heading, answer: note.answer,
    tags: note.tags, favorite: note.favorite,
    createdAt: note.createdAt, updatedAt: note.updatedAt,
  };
}

function vaultError(error) {
  if (error instanceof VaultSubjectLockedError) return json({ error: error.message }, 409);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid note request.' }, 400);
  if (error instanceof VaultGitHubError) {
    const status = error.message === 'vault-note-conflict' ? 409 :
      error.message === 'vault-not-connected' ? 409 :
        error.message === 'session-expired' ? 401 :
          error.status === 404 ? 404 : error.status === 409 || error.status === 422 ? 409 : 503;
    return json({ error: error.message }, status);
  }
  console.error('GitHub Notes UI adapter failure:', error?.name);
  return json({ error: 'Could not confirm GitHub notes operation.' }, 503);
}

async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const ownerId = session.user.id;
  const client = await getVaultNoteClient(db, {
    ownerId, sessionVersion: session.user.sessionVersion,
  });
  return { db, ownerId, client };
}

async function subjectExists(ctx, slug) {
  if (typeof slug !== 'string' || !slug)
    return false;
  return Boolean(await ctx.db.collection('subjects').findOne({
    ownerId: ctx.ownerId, slug,
  }, { projection: { _id: 1 } }));
}

async function mutation(request, execute, maxBytes = 32768) {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub Notes preview disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before editing notes.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const data = request ? JSON.parse(await readLimitedBody(request, maxBytes)) : null;
    return await execute(ctx, data);
  } catch (error) { return vaultError(error); }
}

export async function GET(request) {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub Notes preview disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before reading notes.' }, 401);
    const params = new URL(request.url).searchParams;
    const subject = params.get('subject');
    if (params.get('paged') === 'true') {
      const limit = params.has('limit') ? Number(params.get('limit')) : 20;
      const page = await listVaultNotePage(ctx.client, { limit, cursor: params.get('cursor') });
      return json({ ...page, notes: page.notes
        .filter((note) => !subject || note.subjectId === subject).map(legacyVaultNote) });
    }
    const notes = await listVaultNotes(ctx.client);
    return json(notes.filter((note) => !subject || note.subjectId === subject).map(legacyVaultNote));
  } catch (error) { return vaultError(error); }
}

export async function POST(request) {
  return mutation(request, async (ctx, data) => {
    if (!await subjectExists(ctx, data?.subjectSlug))
      return json({ error: 'Subject not found.' }, 404);
    // Hybrid new-note drafts keep a stable opaque UUID from the first edit
    // through the eventual GitHub commit. Legacy preview creates still let
    // the server generate the ID.
    const hybridCreate = process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true';
    const suppliedId = data?.id;
    if (suppliedId !== undefined && (!hybridCreate ||
        typeof suppliedId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId))) {
      return json({ error: 'Invalid hybrid note ID.' }, 400);
    }
    const change = await withVaultSubjectWrite(ctx.db, ctx.ownerId, data.subjectSlug,
      () => commitVaultNoteBatch(ctx.client, [{
      action: 'create', ...(suppliedId ? { id: suppliedId } : {}), note: {
        subjectId: data.subjectSlug, heading: data.heading, answer: data.answer,
        tags: data.tags, favorite: false,
      },
    }])); 
    return json(legacyVaultNote(change.results[0]), 201);
  });
}

export async function PUT(request) {
  return mutation(request, async (ctx, data) => {
    if (typeof data?.id !== 'string' || typeof data?.sha !== 'string')
      return json({ error: 'Note ID and expected GitHub revision required.' }, 400);
    const previous = await readVaultNote(ctx.client, data.id);
    if (data.subjectSlug !== previous.subjectId ||
        !await subjectExists(ctx, previous.subjectId))
      return json({ error: 'Changing subjects is not supported.' }, 409);
    const change = await withVaultSubjectWrite(ctx.db, ctx.ownerId, previous.subjectId,
      () => commitVaultNoteBatch(ctx.client, [{
        action: 'update', id: data.id, sha: data.sha,
        note: { subjectId: previous.subjectId, heading: data.heading,
          answer: data.answer, tags: data.tags, favorite: previous.favorite },
      }]));
    return json(legacyVaultNote(change.results[0]));
  });
}

export async function PATCH(request) {
  return mutation(request, async (ctx, data) => {
    if (typeof data?.id !== 'string' || typeof data?.sha !== 'string' ||
        typeof data?.favorite !== 'boolean')
      return json({ error: 'Note ID, revision and favorite value required.' }, 400);
    const previous = await readVaultNote(ctx.client, data.id);
    if (!await subjectExists(ctx, previous.subjectId))
      return json({ error: 'Subject not found.' }, 404);
    const change = await withVaultSubjectWrite(ctx.db, ctx.ownerId, previous.subjectId,
      () => commitVaultNoteBatch(ctx.client, [{
        action: 'update', id: data.id, sha: data.sha,
        note: { subjectId: previous.subjectId, heading: previous.heading,
          answer: previous.answer, tags: previous.tags, favorite: data.favorite },
      }]));
    return json(legacyVaultNote(change.results[0]));
  }, 4096);
}

export async function DELETE(request) {
  // Strict revision is required for all destructive operations.
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return json({ error: 'GitHub Notes preview disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before deleting notes.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const sha = url.searchParams.get('sha');
    if (!id || !sha) return json({ error: 'Note ID and revision required.' }, 400);
    const previous = await readVaultNote(ctx.client, id);
    const result = await withVaultSubjectWrite(ctx.db, ctx.ownerId, previous.subjectId,
      () => commitVaultNoteBatch(ctx.client, [{ action: 'delete', id, sha }]));
    return json({ deleted: result.results[0].id });
  } catch (error) { return vaultError(error); }
}
