import { auth } from '../auth.js';
import { getDatabase } from './mongodb.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { checkVaultStagingReadiness } from './oge-vault-staging-preflight.js';
import { getVaultNoteClient } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * M75: shared same-origin, protected HTTPS, disposable DB staging fence for
 * standalone create-only intent + explicit commit. A distinct irreversible
 * write ACK is mandatory and defaults OFF for the COMMIT endpoint.
 * No production origin or legacy Notes collection may pass this check.
 */
export function standaloneRestoreStagingAllowed(request, {
  env = process.env, write = false,
} = {}) {
  if (env.OGE_VAULT_STANDALONE_RESTORE_INTENT_PREVIEW !== 'true' ||
      env.OGE_VAULT_CURRENT_RESOURCE_RESTORE_PLAN_PREVIEW !== 'true' ||
      env.OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW !== 'true' ||
      env.OGE_VAULT_BACKUP_EXPORT_PREVIEW !== 'true' ||
      env.OGE_VAULT_STANDALONE_PREVIEW !== 'true' ||
      env.OGE_VAULT_STANDALONE_DRAFT_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      env.OGE_VAULT_NOTE_API_PREVIEW !== 'true' ||
      env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true' ||
      env.OGE_VAULT_CUTOVER_GUARD_PREVIEW === 'true' ||
      env.OGE_ACCOUNT_DELETION_ENABLED === 'true' ||
      env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL === 'true' ||
      env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL === 'true' ||
      (write && (env.OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW !== 'true' ||
        env.OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK !==
          'YES_DISPOSABLE_SIGNED_STAGING_ONLY')) ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') ||
      env.OGE_STAGING_URL !== env.AUTH_URL ||
      !checkVaultStagingReadiness(env).ok)
    return false;
  try {
    const staging = new URL(env.OGE_STAGING_URL);
    const requestURL = new URL(request.url);
    const configuredBase = new URL(env.OGE_VAULT_BASE_URL);
    return staging.protocol === 'https:' &&
      staging.origin === configuredBase.origin &&
      staging.origin === requestURL.origin &&
      request.headers.get('origin') === staging.origin;
  } catch { return false; }
}

export async function signedStandaloneRestoreContext() {
  const session = await auth();
  if (!session?.user?.id)
    throw new VaultGitHubError('vault-standalone-restore-session-required', 401);
  const db = await getDatabase();
  const identity = {
    ownerId: session.user.id,
    sessionVersion: session.user.sessionVersion,
  };
  const readClient = await getVaultNoteClient(db, identity, { readOnly: true });
  return { db, identity, readClient };
}

/**
 * No note/draft body, archive, bearer token or upload is stored in MongoDB.
 * All reads are signed-owner/repo scoped; draft selectors return IDs only.
 * The owner verifier is safe for repeated calls inside the exclusive fence.
 */
export function standaloneRestoreSafeguards(db, identity, client) {
  const ownerId = identity.ownerId;
  const repoId = client.vault.repoId;
  return {
    ownerVerifier: async () => {
      const user = await db.collection('users').findOne(
        ownerMutationFilter(ownerId, {
          sessionVersion: identity.sessionVersion,
        }), { projection: { vault: 1 } },
      );
      const v = user?.vault, expected = client.vault;
      return v?.status === 'connected' &&
        v.repoId === expected.repoId &&
        v.installationId === expected.installationId &&
        v.githubAccountId === expected.githubAccountId &&
        v.githubLogin === expected.githubLogin &&
        v.repoName === expected.repoName;
    },
    subjectVerifier: async (subjects) => {
      if (!Array.isArray(subjects) || subjects.length > 100)
        throw new TypeError('Subject check exceeds bounded batch');
      if (!subjects.length) return true;
      const rows = await db.collection('subjects').find({
        ownerId, slug: { $in: subjects },
      }, { projection: { _id: 0, slug: 1 } }).toArray();
      const owned = new Set(rows.map((row) => row.slug));
      return owned.size === subjects.length &&
        subjects.every((id) => owned.has(id));
    },
    pendingDraftIds: async (kind, ids) => {
      if (!Array.isArray(ids) || ids.length > 100 ||
          !['notes', 'quick-notes', 'airnotes'].includes(kind))
        throw new TypeError('Invalid typed draft check');
      if (!ids.length) return [];
      if (kind === 'notes') {
        const rows = await db.collection('vault_drafts').find({
          ownerId, repoId, noteId: { $in: ids },
        }, { projection: { _id: 0, noteId: 1 } }).toArray();
        return rows.map((row) => row.noteId);
      }
      const rows = await db.collection('vault_standalone_drafts').find({
        ownerId, repoId, kind, captureId: { $in: ids },
      }, { projection: { _id: 0, captureId: 1 } }).toArray();
      return rows.map((row) => row.captureId);
    },
  };
}

export function standaloneRestoreHttpError(error) {
  if (error?.status === 413)
    return Response.json({ error: 'Restore archive exceeds safe bounds.' },
      { status: 413, headers: { 'Cache-Control': 'private, no-store' } });
  const code = error instanceof VaultGitHubError ?
    ([400, 401, 404, 409, 413, 429].includes(error.status) ?
      error.status : 503) :
    error instanceof TypeError || error instanceof SyntaxError ? 400 : 503;
  if (code === 503 && !(error instanceof VaultGitHubError))
    console.error('Standalone restore stage failure:', error?.name);
  return Response.json({ error: error instanceof VaultGitHubError ?
    error.message : code === 400 ?
      'Invalid standalone restoration request.' :
      'Owner-approved restore could not be confirmed; retain any import quarantine.' },
  { status: code, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
