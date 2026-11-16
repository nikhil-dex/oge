import { auth } from '../../../../auth.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { getVaultNoteClient, readVaultNote } from '../../../../lib/oge-vault-notes.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { withVaultSubjectWrite, VaultSubjectLockedError } from '../../../../lib/oge-vault-subject-fence.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import {
  draftKey, validatedHybridDraft, putHybridDraft, getHybridDraft, clearConfirmedDraft, unsealDraft,
} from '../../../../lib/oge-vault-hybrid-drafts.js';
import { inspectVaultDraftGitHubSave } from '../../../../lib/oge-vault-save-recovery.js';
import { readConfirmedVaultSaveReceipt } from '../../../../lib/oge-vault-save-receipt.js';
import { reconcileConfirmedVaultDraft } from '../../../../lib/oge-vault-save-finalize.js';

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
  // Autosaving a temporary draft must not require GitHub to be online.
  // Enforce the original signed account incarnation and verified vault
  // mapping from MongoDB. Final Save and cleanup re-verify with GitHub.
  const user = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1 } },
  );
  if (!user) throw new VaultGitHubError('session-expired', 401);
  const vault = user.vault;
  if (vault?.status !== 'connected' || !Number.isSafeInteger(vault.repoId) ||
      vault.repoId < 1 || !Number.isSafeInteger(vault.installationId) ||
      vault.installationId < 1) throw new VaultGitHubError('vault-not-connected', 409);
  return { db, ownerId: session.user.id, repoId: vault.repoId,
    sessionVersion: session.user.sessionVersion };
}

function failure(error) {
  if (error instanceof VaultSubjectLockedError) return json({ error: error.message }, 409);
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
    const params = new URL(request.url).searchParams;
    if (params.get('new') === 'true') {
      const subjectId = params.get('subject');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subjectId || ''))
        return json({ error: 'Invalid draft subject.' }, 400);
      // Recover by subject even if sessionStorage has been cleared. Never
      // enumerate another owner's or another repository's draft bodies.
      const candidates = await ctx.db.collection('vault_drafts')
        .find({ ownerId: ctx.ownerId, repoId: ctx.repoId, isNew: true })
        .sort({ updatedAt: -1 }).limit(20).toArray();
      const items = candidates.map((record) => ({
        id: record.noteId, revision: record.revision,
        draft: unsealDraft(record.encrypted),
      })).filter((item) => item.draft.subjectId === subjectId);
      return json({ items, limited: candidates.length === 20 });
    }
    const noteId = params.get('id');
    const scope = draftKey(ctx.ownerId, ctx.repoId, noteId);
    if (params.get('confirm') === 'true') {
      const revision = Number(params.get('revision'));
      if (!Number.isSafeInteger(revision) || revision < 1)
        return json({ error: 'A valid draft revision is required.' }, 400);
      // An explicit recovery scan can read several GitHub resources. Apply
      // the normal owner note-rate limit, even though this never mutates data.
      const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
      if (!throttle.allowed) return rateLimitResponse(throttle);
      const client = await getVaultNoteClient(ctx.db, {
        ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion,
      });
      const current = await getHybridDraft(ctx.db.collection('vault_drafts'), scope);
      if (!current) {
        return json(await readConfirmedVaultSaveReceipt(ctx.db, client, scope, revision));
      }
      return json(await inspectVaultDraftGitHubSave(
        ctx.db.collection('vault_drafts'), client, scope, revision));
    }
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
    // The subject row fences autosaves against a deletion lock.
    // A draft never claims to have been written to GitHub.
    const result = await withVaultSubjectWrite(ctx.db, ctx.ownerId, draft.subjectId,
      () => putHybridDraft(ctx.db.collection('vault_drafts'),
        scope, input.revision, draft));
    return json({ ...result, savedTo: 'temporary-draft' });
  } catch (error) { return failure(error); }
}

/**
 * Explicit B7 reconciliation for a Save whose original response was lost.
 * This never attempts another GitHub write; it checks the immutable blob,
 * scopes the CAS draft cleanup to one revision and respects subject fences.
 */
export async function POST(request) {
  try {
    const { ctx, response } = await authorizedContext();
    if (response) return response;
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const input = JSON.parse(await readLimitedBody(request, 4096));
    const scope = draftKey(ctx.ownerId, ctx.repoId, input?.id);
    if (!Number.isSafeInteger(input?.revision) || input.revision < 1 ||
        typeof input?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(input.sha))
      return json({ error: 'Draft revision and confirmed GitHub SHA required.' }, 400);
    const current = await getHybridDraft(ctx.db.collection('vault_drafts'), scope);
    if (current && current.revision !== input.revision)
      return json({ confirmed: false, cleared: false, reason: 'newer-draft-present' }, 409);
    const client = await getVaultNoteClient(ctx.db, {
      ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion,
    });
    if (!current) {
      // The original CAS cleanup may have committed even when its HTTP
      // response was lost. Read GitHub again; an old receipt by itself is
      // never proof that the note is still saved.
      const note = await readVaultNote(client, scope.noteId);
      const result = await withVaultSubjectWrite(
        ctx.db, ctx.ownerId, note.subjectId,
        () => readConfirmedVaultSaveReceipt(ctx.db, client, scope, input.revision));
      if (result.confirmed && result.sha !== input.sha.toLowerCase())
        return json({ confirmed: false, cleared: false, reason: 'receipt-sha-mismatch' }, 409);
      return json(result, result.confirmed ? 200 : 409);
    }
    const result = await withVaultSubjectWrite(
      ctx.db, ctx.ownerId, current.draft.subjectId,
      () => reconcileConfirmedVaultDraft(
        ctx.db.collection('vault_drafts'), client, scope, input.revision, input.sha, {
          db: ctx.db, credential: { sessionVersion: ctx.sessionVersion },
        }));
    return json(result, result.confirmed ? 200 : 409);
  } catch (error) { return failure(error); }
}

/**
 * Delete only the exact saved revision, and only after reading its committed
 * contents from GitHub. A newer MongoDB autosave cannot be cleared by a slow
 * completion from an older Save request.
 */
export async function DELETE(request) {
  try {
    const { ctx, response } = await authorizedContext();
    if (response) return response;
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const input = JSON.parse(await readLimitedBody(request, 4096));
    const scope = draftKey(ctx.ownerId, ctx.repoId, input?.id);
    if (!Number.isSafeInteger(input?.revision) || input.revision < 1 ||
        typeof input?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(input.sha))
      return json({ error: 'Revision and confirmed GitHub SHA are required.' }, 400);
    const current = await getHybridDraft(ctx.db.collection('vault_drafts'), scope);
    if (!current || current.revision !== input.revision)
      return json({ cleared: false, reason: 'newer-or-absent-draft' }, 409);
    const client = await getVaultNoteClient(ctx.db, {
      ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion,
    });
    const remote = await readVaultNote(client, scope.noteId);
    const draft = current.draft;
    if (remote.sha !== input.sha || remote.subjectId !== draft.subjectId ||
        remote.heading !== draft.heading.trim() ||
        remote.answer !== draft.answer.trim() ||
        JSON.stringify(remote.tags) !== JSON.stringify(draft.tags) ||
        remote.favorite !== draft.favorite)
      return json({ cleared: false, reason: 'github-content-mismatch' }, 409);
    return json({ cleared: await clearConfirmedDraft(
      ctx.db.collection('vault_drafts'), scope, input.revision,
    ) });
  } catch (error) { return failure(error); }
}
