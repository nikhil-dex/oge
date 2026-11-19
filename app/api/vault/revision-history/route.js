import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import {
  listVaultNoteRevisions, restoreVaultNoteRevision,
} from '../../../../lib/oge-vault-revision-history.js';
import { noteFilePath } from '../../../../lib/oge-vault-notes.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import {
  withVaultSubjectWrite, VaultSubjectLockedError,
} from '../../../../lib/oge-vault-subject-fence.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function fail(error) {
  if (error instanceof SyntaxError || error instanceof TypeError)
    return json({ error: 'Invalid GitHub revision request.' }, 400);
  if (error instanceof VaultSubjectLockedError)
    return json({ error: 'Vault subject is locked.' }, 409);
  if (error instanceof VaultGitHubError) {
    const status = error.status === 401 ? 401 : error.status === 404 ? 404 :
      error.status === 429 ? 429 : error.status === 409 ? 409 : 503;
    return json({ error: error.message }, status);
  }
  console.error('Vault revision history preview failed:', error?.name);
  return json({ error: 'GitHub revision history could not be verified.' }, 503);
}

async function authorized() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const ownerId = session.user.id;
  const client = await getVaultNoteClient(db, {
    ownerId, sessionVersion: session.user.sessionVersion,
  });
  return { db, ownerId, client };
}

async function subjectIsOwned(ctx, subjectId) {
  return Boolean(await ctx.db.collection('subjects').findOne({
    ownerId: ctx.ownerId, slug: subjectId,
  }, { projection: { _id: 1 } }));
}

async function requestContext() {
  // No production note endpoint, old revision queue or backup reader is
  // changed. This is an independently default-off GitHub-only preview.
  if (process.env.OGE_VAULT_REVISION_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_MAIN_PREVIEW !== 'true')
    return { response: json({ error: 'GitHub revision preview disabled.' }, 404) };
  const ctx = await authorized();
  if (!ctx) return { response: json({ error: 'Sign in to view revisions.' }, 401) };
  const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
  if (!throttle.allowed) return { response: rateLimitResponse(throttle) };
  return { ctx };
}

export async function GET(request) {
  try {
    const { ctx, response } = await requestContext();
    if (response) return response;
    const id = new URL(request.url).searchParams.get('id');
    noteFilePath(id); // Reject paths and malformed note IDs.
    const history = await listVaultNoteRevisions(ctx.client, id);
    if (!await subjectIsOwned(ctx, history.subjectId))
      return json({ error: 'Subject not found.' }, 404);
    return json(history);
  } catch (error) { return fail(error); }
}

/**
 * Explicit, bounded restore of one prior GitHub note revision. No MongoDB
 * note body/revision is read or written. The current expected blob SHA,
 * historical commit and historical blob SHA must all match a fresh server
 * snapshot. This never silently replays an uncertain GitHub mutation.
 */
export async function POST(request) {
  try {
    const { ctx, response } = await requestContext();
    if (response) return response;
    const data = JSON.parse(await readLimitedBody(request, 4096));
    const id = data?.id, sha = data?.sha;
    const commitSha = data?.commitSha, sourceSha = data?.sourceSha;
    noteFilePath(id);
    if (![sha, commitSha, sourceSha].every((value) =>
      typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)))
      return json({ error: 'Expected current and historical GitHub revisions are required.' }, 400);

    const history = await listVaultNoteRevisions(ctx.client, id);
    if (!await subjectIsOwned(ctx, history.subjectId))
      return json({ error: 'Subject not found.' }, 404);
    if (history.currentSha !== sha.toLowerCase())
      return json({ error: 'Note changed. Refresh the GitHub revision history.' }, 409);

    return await withVaultSubjectWrite(ctx.db, ctx.ownerId, history.subjectId, async () => {
      // A temporary encrypted draft might contain edits newer than the last
      // GitHub commit. Refuse restoration until the user resolves that draft.
      const pending = await ctx.db.collection('vault_drafts').findOne({
        ownerId: ctx.ownerId, repoId: ctx.client.vault.repoId, noteId: id.toLowerCase(),
      }, { projection: { _id: 1 } });
      if (pending) return json({
        error: 'Unsynced draft exists. Review or save it before restoring a historical version.',
      }, 409);

      const result = await restoreVaultNoteRevision(ctx.client, history, {
        id, sha, commitSha, sourceSha,
      });
      const note = result.note;
      return json({
        id: note.id, sha: note.sha,
        subjectSlug: note.subjectId, heading: note.heading, answer: note.answer,
        tags: note.tags, favorite: note.favorite,
        createdAt: note.createdAt, updatedAt: note.updatedAt,
        restoredFromCommit: result.restoredFromCommit,
        commitSha: result.commitSha,
      });
    });
  } catch (error) { return fail(error); }
}
