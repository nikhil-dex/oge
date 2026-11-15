import { withAtomicBackupImport } from './atomic-backup-import.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';
import { planVaultSubjectDeletion } from './oge-vault-subject-deletion-plan.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;

function scoped(identity, operationId, credential) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId || !Number.isSafeInteger(repoId) ||
      repoId < 1 || !UUID.test(subjectId || '') || !UUID.test(operationId || ''))
    throw new TypeError('Invalid Vault finalization identity');
  return { key: { ownerId, repoId, subjectId: subjectId.toLowerCase(), operationId },
    accountFilter: ownerMutationFilter(ownerId, credential) };
}

function ownedLock(subject, operationId) {
  return Boolean(subject && subject.vaultDeletionState === 'locked' &&
    subject.vaultDeletionOperationId === operationId &&
    (subject.vaultActiveWriters === undefined || subject.vaultActiveWriters === 0));
}

function confirmedJob(job) {
  return job?.state === 'github-confirmed' && job.destructiveEnabled === true &&
    SHA.test(job.targetCommitSha || '') && SHA.test(job.targetTreeSha || '') &&
    SHA.test(job.baseCommitSha || '') &&
    /^[a-f0-9]{64}$/i.test(job.manifestFingerprint || '') &&
    Number.isSafeInteger(job.deletedFileCount) && job.deletedFileCount >= 0;
}

const blocked = (reason) => ({ ready: false, reason, advisoryOnly: true });

/**
 * INTERNAL-ONLY, READ-ONLY safety review of the MongoDB side of deletion.
 *
 * A confirmed GitHub commit is not sufficient: the old MongoDB subject must
 * still be owned and locked, there must be no unsynced drafts, legacy notes,
 * or unresolved vault_files index entries, and at least one other subject
 * must remain. An external GitHub write still creates a cross-store race;
 * thus this review is NOT authorization to physically delete the subject.
 */
export async function inspectLockedVaultSubjectFinalization(db, client, identity, operationId, {
  credential, planner = planVaultSubjectDeletion,
} = {}) {
  const { key, accountFilter } = scoped(identity, operationId, credential);
  const [job, subject, account] = await Promise.all([
    db.collection('vault_subject_deletion_jobs').findOne(key),
    db.collection('subjects').findOne({ ownerId: key.ownerId, slug: key.subjectId }),
    db.collection('users').findOne(accountFilter, { projection: { vault: 1 } }),
  ]);
  if (!confirmedJob(job) || !ownedLock(subject, operationId))
    return blocked('job-or-subject-lock-unconfirmed');
  if (account?.vault?.status !== 'connected' || account.vault.repoId !== key.repoId ||
      client?.vault?.repoId !== key.repoId)
    return blocked('vault-account-mismatch');

  const [drafts, legacy, indexed, subjectsCount] = await Promise.all([
    db.collection('vault_drafts').countDocuments({ ownerId: key.ownerId, repoId: key.repoId }, { limit: 1 }),
    db.collection('notes').countDocuments({ ownerId: key.ownerId, subjectSlug: key.subjectId }, { limit: 1 }),
    db.collection('vault_files').countDocuments({ ownerId: key.ownerId,
      repoId: key.repoId, subjectId: key.subjectId }, { limit: 1 }),
    db.collection('subjects').countDocuments({ ownerId: key.ownerId }, { limit: 2 }),
  ]);
  if (drafts) return blocked('pending-vault-drafts');
  if (legacy) return blocked('legacy-notes-present');
  if (indexed) return blocked('file-index-not-reconciled');
  if (subjectsCount <= 1) return blocked('last-subject');

  // The GitHub note scanner must see the current target commit, not a cached
  // manifest from preparation. This also detects notes created externally.
  const plan = await planner(client, db.collection('vault_drafts'), identity);
  if (plan?.ready !== true || plan.advisoryOnly !== true ||
      plan.snapshot !== job.targetCommitSha || !Array.isArray(plan.files) ||
      plan.files.length !== 0)
    return blocked('github-subject-not-empty-or-head-changed');

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const ref = await client.call(refPath);
  if (ref?.object?.sha !== job.targetCommitSha)
    return blocked('github-head-changed');

  const commit = await client.call('/git/commits/' + job.targetCommitSha);
  const isEmptyCase = job.deletedFileCount === 0 &&
    job.targetCommitSha === job.baseCommitSha;
  const parentValid = isEmptyCase ||
    (Array.isArray(commit?.parents) &&
      commit.parents.some((parent) => parent?.sha === job.baseCommitSha));
  if (commit?.tree?.sha !== job.targetTreeSha || !parentValid)
    return blocked('github-commit-proof-mismatch');

  return { ready: true, reason: 'metadata-retirement-eligible', advisoryOnly: true,
    operationId, githubCommitSha: job.targetCommitSha };
}

/**
 * INTERNAL, DISABLED, UNWIRED: retain (not delete) the subject as a locked,
 * recoverable tombstone and journal the metadata handoff in one transaction.
 *
 * This intentionally DOES NOT physically remove MongoDB subject metadata,
 * drafts, or legacy content. A later rollout must solve external GitHub
 * writers, account deletion, and subject/index reconciliation before purging.
 */
export async function retireLockedVaultSubjectMetadata(db, client, identity, operationId, {
  credential, env = process.env, inspector = inspectLockedVaultSubjectFinalization,
} = {}) {
  if (env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true')
    throw new VaultGitHubError('vault-subject-retirement-disabled', 403);
  const { key, accountFilter } = scoped(identity, operationId, credential);
  const check = await inspector(db, client, identity, operationId, { credential });
  if (check?.ready !== true || check.advisoryOnly !== true ||
      check.githubCommitSha === undefined)
    throw new VaultGitHubError('vault-subject-retirement-not-ready', 409);

  return withAtomicBackupImport(db, async (session) => {
    const now = new Date();
    const account = await db.collection('users').updateOne({
      ...accountFilter, 'vault.status': 'connected', 'vault.repoId': key.repoId,
    }, { $set: { updatedAt: now } }, { session });
    if (account.matchedCount !== 1)
      throw new Error('vault-subject-retirement-account-conflict');

    // Recheck ALL MongoDB invariants within the same snapshot transaction.
    const [drafts, legacy, indexed, subjectCount] = await Promise.all([
      db.collection('vault_drafts').countDocuments({ ownerId: key.ownerId, repoId: key.repoId },
        { limit: 1, session }),
      db.collection('notes').countDocuments({ ownerId: key.ownerId, subjectSlug: key.subjectId },
        { limit: 1, session }),
      db.collection('vault_files').countDocuments({ ownerId: key.ownerId,
        repoId: key.repoId, subjectId: key.subjectId }, { limit: 1, session }),
      db.collection('subjects').countDocuments({ ownerId: key.ownerId }, { limit: 2, session }),
    ]);
    if (drafts || legacy || indexed || subjectCount <= 1)
      throw new Error('vault-subject-retirement-recheck-failed');

    const subject = await db.collection('subjects').updateOne({
      ownerId: key.ownerId, slug: key.subjectId, vaultDeletionState: 'locked',
      vaultDeletionOperationId: operationId,
      $or: [{ vaultActiveWriters: 0 }, { vaultActiveWriters: { $exists: false } }],
    }, { $set: { vaultRetiredAt: now, vaultDeletionState: 'locked' } }, { session });
    if (subject.matchedCount !== 1)
      throw new Error('vault-subject-retirement-lock-lost');

    const job = await db.collection('vault_subject_deletion_jobs').updateOne({
      ...key, state: 'github-confirmed', destructiveEnabled: true,
      targetCommitSha: check.githubCommitSha,
    }, { $set: { state: 'metadata-retired', metadataRetiredAt: now,
      updatedAt: now } }, { session });
    if (job.matchedCount !== 1)
      throw new Error('vault-subject-retirement-job-conflict');

    return { metadataRetired: true, subjectRetained: true, lockRetained: true,
      operationId };
  });
}
