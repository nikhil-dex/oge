import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { checkVaultStagingReadiness } from '../../../../../lib/oge-vault-staging-preflight.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../../lib/rate-limit.js';
import { readLimitedBody } from '../../../../../lib/read-limited-body.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';
import {
  MAX_VAULT_RESOURCE_BACKUP_BYTES, verifyVaultCurrentResourcesArchive,
} from '../../../../../lib/oge-vault-backup-current-resources.js';
import {
  planVaultCurrentResourcesRestoreReadOnly,
} from '../../../../../lib/oge-vault-backup-current-resources-plan.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data, status = 200) => Response.json(data, {
  status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

/**
 * M74 independent DEFAULT-OFF GET-free, POST-only *read-only planner*.
 * The POST takes an owner-supplied JSON archive as IN-MEMORY input ONLY.
 * No imported data is persisted, and NO restore or GitHub write exists.
 */
function enabled(env = process.env) {
  return env.OGE_VAULT_CURRENT_RESOURCE_RESTORE_PLAN_PREVIEW === 'true' &&
    env.OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true' &&
    env.OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    env.OGE_STAGING_URL === env.AUTH_URL &&
    checkVaultStagingReadiness(env).ok;
}
function respondError(error) {
  if (error?.status === 413)
    return json({ error: 'Full resource archive exceeds staging preview limits.' }, 413);
  if (error instanceof VaultGitHubError) {
    const status = [400, 401, 404, 409, 413, 429].includes(error.status) ?
      error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: 'Invalid current-resource backup archive.' }, 400);
  console.error('Vault three-resource restore planning failed:', error?.name);
  return json({ error: 'Read-only restore conflict check could not be verified.' }, 503);
}

export async function POST(request) {
  if (!enabled())
    return json({ error: 'Read-only resource restore preview disabled.' }, 404);
  try {
    const session = await auth();
    if (!session?.user?.id)
      return json({ error: 'Sign in to review your private resource archive.' }, 401);
    if (!/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') || ''))
      return json({ error: 'Only JSON archive bodies are accepted.' }, 415);

    const db = await getDatabase();
    const ownerId = session.user.id;
    const sessionVersion = session.user.sessionVersion;
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'notes');
    if (!throttle.allowed) return rateLimitResponse(throttle);

    const archive = JSON.parse(await readLimitedBody(
      request, MAX_VAULT_RESOURCE_BACKUP_BYTES));
    // Fail closed on arbitrary/changed input BEFORE acquiring any GitHub
    // App token or reading any destination private GitHub file.
    verifyVaultCurrentResourcesArchive(archive);

    const client = await getVaultNoteClient(db, {
      ownerId, sessionVersion,
    }, { readOnly: true });

    const ownerVerifier = async () => {
      const current = await db.collection('users').findOne(
        ownerMutationFilter(ownerId, { sessionVersion }),
        { projection: { vault: 1 } },
      );
      return Boolean(current && current.vault?.status === 'connected' &&
        current.vault.repoId === client.vault.repoId &&
        current.vault.installationId === client.vault.installationId &&
        current.vault.githubAccountId === client.vault.githubAccountId &&
        current.vault.githubLogin === client.vault.githubLogin &&
        current.vault.repoName === client.vault.repoName);
    };
    const plan = await planVaultCurrentResourcesRestoreReadOnly(
      client, archive, {
        ownerVerifier,
        subjectVerifier: async (subjectIds) => {
          if (subjectIds.length === 0) return true;
          const owned = await db.collection('subjects').find({
            ownerId, slug: { $in: subjectIds },
          }, { projection: { _id: 0, slug: 1 } }).toArray();
          const exact = new Set(owned.map((item) => item.slug));
          return exact.size === subjectIds.length &&
            subjectIds.every((id) => exact.has(id));
        },
        // IDs are never trusted from MongoDB alone. The core checks that
        // each ID is a member of the current source chunk (max 100), and
        // that no duplicates, unexpected types, or cross-kind IDs leak.
        pendingDraftIds: async (kind, ids) => {
          if (kind === 'notes') {
            const rows = await db.collection('vault_drafts').find({
              ownerId, repoId: client.vault.repoId, noteId: { $in: ids },
            }, { projection: { _id: 0, noteId: 1 } }).toArray();
            return rows.map((row) => row.noteId);
          }
          if (kind !== 'quick-notes' && kind !== 'airnotes')
            throw new TypeError('Unknown Vault resource kind');
          const rows = await db.collection('vault_standalone_drafts').find({
            ownerId, repoId: client.vault.repoId, kind,
            captureId: { $in: ids },
          }, { projection: { _id: 0, captureId: 1 } }).toArray();
          return rows.map((row) => row.captureId);
        },
      },
    );
    // Final independent post-planner signed owner/session check: failure
    // suppresses even the bounded private UUID-only preview.
    if (!await ownerVerifier())
      return json({ error: 'Owner or Vault changed during inspection.' }, 409);
    return json(plan);
  } catch (error) { return respondError(error); }
}
