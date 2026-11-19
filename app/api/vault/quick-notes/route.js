import { randomUUID } from 'node:crypto';
import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { vaultCaptureAvailable } from '../../../../lib/oge-vault-workspace-routing.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { withVaultOwnerDraftWrite } from '../../../../lib/oge-vault-import-fence.js';
import {
  listVaultStandaloneCaptures, getVaultStandaloneCapture,
  commitVaultStandaloneCapture,
} from '../../../../lib/oge-vault-standalone-captures.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

function asQuickNote(note) {
  return {
    id: note.id, title: note.title, content: note.content,
    createdAt: note.createdAt, updatedAt: note.updatedAt, sha: note.sha,
  };
}

async function context({ readOnly = false } = {}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const identity = {
    ownerId: session.user.id, sessionVersion: session.user.sessionVersion,
  };
  const user = await db.collection('users').findOne(
    ownerMutationFilter(identity.ownerId, { sessionVersion: identity.sessionVersion }),
    { projection: { vault: 1, notesStorage: 1 } },
  );
  // Quick Notes must never fall back to permanent MongoDB content for a
  // GitHub user, even if the Vault installation or provider becomes unavailable.
  if (!user) throw new VaultGitHubError('session-expired', 401);
  if (user.notesStorage === 'mongodb' || user.notesStorage === 'unselected')
    throw new VaultGitHubError('quick-notes-storage-choice-mismatch', 409);
  if (!vaultCaptureAvailable(user))
    throw new VaultGitHubError('vault-storage-not-ready', 409);
  const client = await getVaultNoteClient(db, identity, { readOnly });
  return { db, identity, client };
}

function fail(error) {
  if (error instanceof VaultGitHubError) {
    const status = [400, 401, 404, 409, 413, 429].includes(error.status)
      ? error.status : error.status === 422 ? 409 : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: 'Enter valid QuickNote text and ID.' }, 400);
  console.error('GitHub Quick Notes failed:', error?.name);
  return json({ error: 'Could not confirm Quick Notes save. Keep your text before retrying.' }, 503);
}

async function readJson(request) {
  try {
    return JSON.parse(await readLimitedBody(request, 32 * 1024));
  } catch (error) {
    throw new VaultGitHubError(
      error?.status === 413 ? 'Quick Note request too large' : 'Enter valid QuickNote JSON',
      error?.status === 413 ? 413 : 400,
    );
  }
}

export async function GET() {
  try {
    const ctx = await context({ readOnly: true });
    if (!ctx) return json({ error: 'Sign in to view Quick Notes.' }, 401);
    return json((await listVaultStandaloneCaptures(ctx.client, 'quick-notes'))
      .map(asQuickNote));
  } catch (error) { return fail(error); }
}

async function mutate(request, action) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to manage Quick Notes.' }, 401);
    const data = action === 'delete'
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await readJson(request);
    const id = typeof data?.id === 'string' ? data.id.toLowerCase() :
      action === 'create' ? randomUUID() : '';
    const sha = typeof data?.sha === 'string' ? data.sha.toLowerCase() : null;
    if (!UUID.test(id) ||
        (action !== 'create' && !SHA.test(sha || '')) ||
        (action === 'create' && data?.sha !== undefined) ||
        (action === 'delete' ? data?.content !== undefined :
          typeof data?.content !== 'string' || data.content.length > 20000)) {
      return json({ error: 'Valid QuickNote ID, content and revision are required.' }, 400);
    }
    const limit = await checkOwnerMutationLimit(ctx.db, ctx.identity.ownerId, 'quick-notes');
    if (!limit.allowed) return rateLimitResponse(limit);

    const scope = {
      ...ctx.identity, repoId: ctx.client.vault.repoId,
    };
    // This fence stops Quick Notes writes during import/restore; its MongoDB
    // records contain operational metadata, not QuickNote content.
    try {
      const saved = await withVaultOwnerDraftWrite(ctx.db, scope, () =>
        commitVaultStandaloneCapture(ctx.client, {
          kind: 'quick-notes', action, id,
          ...(action === 'delete' ? {} : { content: data.content }),
          sha: sha || null,
        }));
      return json(action === 'delete' ? { deleted: saved.id } : asQuickNote(saved),
        action === 'create' ? 201 : 200);
    } catch (error) {
      // A GitHub response may be lost AFTER a commit. Confirm this exact
      // UUID/content from the private default branch before reporting Save;
      // never issue a second GitHub write to guess the outcome.
      if (action !== 'delete') {
        const existing = await getVaultStandaloneCapture(
          ctx.client, 'quick-notes', id).catch(() => null);
        if (existing && existing.content === data.content &&
            (action === 'create' || existing.sha !== sha))
          return json(asQuickNote(existing), 200);
      }
      throw error;
    }
  } catch (error) {
    return fail(error);
  }
}

const WEB_QUICK_NOTE_WRITES_ALLOWED = false;

export async function POST(request) {
  // Quick Notes are extension-only captures. The website can list and
  // delete, but cannot create or edit, even with direct API requests.
  if (!WEB_QUICK_NOTE_WRITES_ALLOWED)
    return json({ error: 'Save new Quick Notes using the Oge browser extension.' }, 405); return mutate(request, 'create'); }
export async function PUT(request) {
  if (!WEB_QUICK_NOTE_WRITES_ALLOWED)
    return json({ error: 'Quick Notes are read-only in the app. Use the extension to capture.' }, 405);
  return mutate(request, 'update');
}
export async function DELETE(request) { return mutate(request, 'delete'); }
