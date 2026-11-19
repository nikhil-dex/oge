import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

function checkedScope(identity, operationId) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      !UUID.test(subjectId || '') || !UUID.test(operationId || ''))
    throw new TypeError('Invalid Vault deletion recovery scope');
  return { ownerId, repoId, subjectId: subjectId.toLowerCase(), operationId };
}

/**
 * B5.3c internal reconciliation only, no destructive mutations.
 * If the GitHub ref now equals the known target commit and its tree + parent
 * match the recorded commit intent, mark GitHub confirmed. Otherwise retain
 * the subject lock and commit-intent for an operator to review. Never retry
 * PATCH automatically or remove a subject from MongoDB.
 */
export async function reconcileVaultSubjectGitHubDeletion(db, client, identity, operationId) {
  const key = checkedScope(identity, operationId);
  const jobs = db.collection('vault_subject_deletion_jobs');
  const [job, subject] = await Promise.all([
    jobs.findOne(key),
    db.collection('subjects').findOne({ ownerId: key.ownerId, slug: key.subjectId },
      { projection: { vaultDeletionState: 1, vaultDeletionOperationId: 1,
        vaultActiveWriters: 1 } }),
  ]);
  if (!['commit-intent', 'github-confirmed'].includes(job?.state) ||
      job.destructiveEnabled !== true ||
      subject?.vaultDeletionState !== 'locked' ||
      subject.vaultDeletionOperationId !== operationId ||
      subject.vaultActiveWriters !== 0 ||
      !SHA.test(job.baseCommitSha || '') ||
      !SHA.test(job.targetCommitSha || '') ||
      !SHA.test(job.targetTreeSha || '') ||
      !/^[a-f0-9]{64}$/i.test(job.manifestFingerprint || ''))
    throw new VaultGitHubError('vault-deletion-recovery-unsafe', 409);
  if (job.state === 'github-confirmed')
    return { confirmed: true, action: 'none', retainedLock: true };

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  let head;
  try { head = (await client.call(refPath))?.object?.sha; }
  catch { return { confirmed: false, action: 'manual-review', retainedLock: true }; }
  if (head !== job.targetCommitSha)
    return { confirmed: false, action: 'manual-review', retainedLock: true };

  let commit;
  try { commit = await client.call('/git/commits/' + job.targetCommitSha); }
  catch { return { confirmed: false, action: 'manual-review', retainedLock: true }; }
  if (commit?.tree?.sha !== job.targetTreeSha ||
      !Array.isArray(commit?.parents) ||
      !commit.parents.some((parent) => parent?.sha === job.baseCommitSha))
    return { confirmed: false, action: 'manual-review', retainedLock: true };

  const result = await jobs.updateOne({
    ...key, state: 'commit-intent', targetCommitSha: job.targetCommitSha,
  }, { $set: { state: 'github-confirmed', confirmedAt: new Date(),
    updatedAt: new Date() } });
  if (result.matchedCount !== 1)
    throw new Error('vault-deletion-recovery-transition-conflict');
  return { confirmed: true, action: 'none', retainedLock: true };
}
