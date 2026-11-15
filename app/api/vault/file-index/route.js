import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { synchronizeVaultFileIndex } from '../../../../lib/oge-vault-file-index-sync.js';
import { inspectVaultFileIndexRecovery, reconcileVaultFileIndexVerification } from '../../../../lib/oge-vault-file-index-recovery.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store' },
});

async function context() {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_FILE_INDEX_PREVIEW !== 'true')
    return { response: json({ error: 'Vault file index preview disabled.' }, 404) };
  const session = await auth();
  if (!session?.user?.id) return { response: json({ error: 'Sign in required.' }, 401) };
  const db = await getDatabase();
  const ownerId = session.user.id;
  const account = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1 } },
  );
  if (!account) return { response: json({ error: 'Account session expired.' }, 401) };
  if (account.vault?.status !== 'connected' ||
      !Number.isSafeInteger(account.vault.repoId) || account.vault.repoId < 1)
    return { response: json({ error: 'Vault not connected.' }, 409) };
  return { db, ownerId, repoId: account.vault.repoId,
    sessionVersion: session.user.sessionVersion };
}

function failure(error) {
  if (error instanceof VaultGitHubError)
    return json({ error: error.message }, error.status === 401 ? 401 :
      error.status === 409 ? 409 : 503);
  console.error('Vault file-index operation failed:', error?.name);
  return json({ error: 'Vault file index unavailable. No notes were changed.' }, 503);
}

// Last-known index only, NOT a live GitHub reading and never proof a file
// still exists. Subject-scoped queries are owner/repository scoped.
export async function GET(request) {
  try {
    const ctx = await context();
    if (ctx.response) return ctx.response;
    const params = new URL(request.url).searchParams;
    const scope = { ownerId: ctx.ownerId, repoId: ctx.repoId };
    if (params.get('diagnostic') === 'true')
      return json({ ...(await inspectVaultFileIndexRecovery(ctx.db, scope)),
        lastKnownOnly: true, advisoryOnly: true });
    const subjectId = params.get('subject');
    if (subjectId !== null && !UUID.test(subjectId))
      return json({ error: 'Invalid subject.' }, 400);
    const filter = { ...scope, ...(subjectId ? { subjectId: subjectId.toLowerCase() } : {}) };
    const [state, rows] = await Promise.all([
      ctx.db.collection('vault_file_index_state').findOne(scope, {
        projection: { _id: 0, state: 1, snapshot: 1,
          totalNotes: 1, checkedAt: 1, reason: 1 },
      }),
      ctx.db.collection('vault_files').find(filter, {
        projection: { _id: 0, noteId: 1, subjectId: 1, path: 1,
          blobSha: 1, status: 1, lastSeenSnapshot: 1 },
      }).sort({ noteId: 1 }).limit(100).toArray(),
    ]);
    return json({ state: state || { state: 'not-indexed' },
      files: rows, limited: rows.length === 100,
      lastKnownOnly: true, advisoryOnly: true });
  } catch (error) { return failure(error); }
}

// Explicit manual refresh, not an implicit per-note autosave or destructive
// operation. The user-owned GitHub repository is revalidated before each run.
export async function POST(request) {
  try {
    const ctx = await context();
    if (ctx.response) return ctx.response;
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const client = await getVaultNoteClient(ctx.db, {
      ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion,
    });
    const identity = { ownerId: ctx.ownerId, repoId: ctx.repoId };
    const credential = { sessionVersion: ctx.sessionVersion };
    // The only self-service recovery is a fully committed "verifying" state.
    // A "syncing" state remains fenced for audited operator intervention.
    const reconcile = new URL(request.url).searchParams.get('reconcile') === 'true';
    const result = reconcile
      ? await reconcileVaultFileIndexVerification(ctx.db, client, identity, { credential })
      : await synchronizeVaultFileIndex(ctx.db, client, identity, { credential });
    return json(result);
  } catch (error) { return failure(error); }
}
