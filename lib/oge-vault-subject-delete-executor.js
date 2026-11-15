import { createHash } from 'node:crypto';
import { planVaultSubjectDeletion } from './oge-vault-subject-deletion-plan.js';
import { noteFilePath } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_DELETE_FILES = 200;

function requireScope(identity, operationId) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      !UUID.test(subjectId || '') || !UUID.test(operationId || ''))
    throw new TypeError('Invalid destructive Vault operation scope');
  return { ownerId, repoId, subjectId: subjectId.toLowerCase(), operationId };
}

function validatedManifest(plan) {
  if (plan?.ready !== true || plan.advisoryOnly !== true ||
      !SHA.test(plan.snapshot || '') || !Array.isArray(plan.files) ||
      plan.files.length > MAX_DELETE_FILES)
    throw new VaultGitHubError('vault-subject-deletion-not-ready', 409);
  const seen = new Set();
  const files = plan.files.map((item) => {
    if (!UUID.test(item?.noteId || '') || !SHA.test(item?.sha || '') ||
        noteFilePath(item.noteId) !== item.path || seen.has(item.path))
      throw new VaultGitHubError('vault-deletion-manifest-invalid', 409);
    seen.add(item.path);
    return { noteId: item.noteId.toLowerCase(), path: item.path, sha: item.sha };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { files, snapshot: plan.snapshot,
    fingerprint: createHash('sha256').update(JSON.stringify({
      snapshot: plan.snapshot, files,
    })).digest('hex') };
}

/**
 * PRIVATE, UNWIRED destructive GitHub phase — NOT AVAILABLE TO USERS.
 *
 * No existing route can set "commit-authorized", and the independent server
 * flag is false by default. Never wire this method to a public API until a
 * reviewed, crash-recoverable coordinator holds the operation lock through
 * GitHub reconciliation AND subject metadata removal.
 *
 * On an ambiguous ref update the operation remains commit-intent and locked.
 * Do NOT blindly retry. A separate reconciler must prove the result.
 */
export async function executeLockedVaultSubjectGitHubDeletion(db, client, identity, operationId, {
  planner = planVaultSubjectDeletion,
  env = process.env,
} = {}) {
  if (env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true')
    throw new VaultGitHubError('vault-destructive-delete-disabled', 403);
  const key = requireScope(identity, operationId);
  const journal = db.collection('vault_subject_deletion_jobs');
  const [job, subject] = await Promise.all([
    journal.findOne(key),
    db.collection('subjects').findOne({ ownerId: key.ownerId, slug: key.subjectId },
      { projection: { vaultDeletionState: 1, vaultDeletionOperationId: 1,
        vaultActiveWriters: 1 } }),
  ]);
  if (job?.state !== 'commit-authorized' || job.destructiveEnabled !== true ||
      subject?.vaultDeletionState !== 'locked' ||
      subject.vaultDeletionOperationId !== operationId ||
      subject.vaultActiveWriters !== 0)
    throw new VaultGitHubError('vault-deletion-lock-or-authorization-missing', 409);

  // Re-plan under the STILL-HELD writer lock; no persisted preview authorizes
  // deletion. GitHub external writes are rejected by the head/blob checks.
  const plan = validatedManifest(await planner(client, db.collection('vault_drafts'), identity));
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const initial = await client.call(refPath);
  if (initial?.object?.sha !== plan.snapshot)
    throw new VaultGitHubError('vault-deletion-head-changed', 409);
  const prior = await client.call('/git/commits/' + plan.snapshot);
  if (!SHA.test(prior?.tree?.sha || ''))
    throw new VaultGitHubError('vault-tree-unavailable', 409);
  const oldTree = await client.call('/git/trees/' + prior.tree.sha + '?recursive=1');
  if (!Array.isArray(oldTree?.tree) || oldTree.truncated === true ||
      oldTree.tree.length > 30000)
    throw new VaultGitHubError('vault-tree-too-large', 409);
  const blobs = new Map(oldTree.tree.filter((item) =>
    item.type === 'blob' && typeof item.path === 'string' &&
    item.path.startsWith('notes/')).map((item) => [item.path, item.sha]));
  for (const file of plan.files) {
    if (blobs.get(file.path) !== file.sha)
      throw new VaultGitHubError('vault-deletion-blob-changed', 409);
  }

  // Empty subjects need no GitHub ref mutation. They are still NOT deleted
  // from MongoDB by this method.
  if (plan.files.length === 0) {
    const result = await journal.updateOne({ ...key, state: 'commit-authorized' },
      { $set: { state: 'github-confirmed', baseCommitSha: plan.snapshot,
        targetCommitSha: plan.snapshot, targetTreeSha: prior.tree.sha,
        manifestFingerprint: plan.fingerprint, deletedFileCount: 0,
        confirmedAt: new Date(), updatedAt: new Date() } });
    if (result.matchedCount !== 1)
      throw new Error('vault-deletion-job-transition-conflict');
    return { commitSha: plan.snapshot, deletedFileCount: 0, githubConfirmed: true };
  }

  // Exactly one atomic GitHub tree update: never delete note files one by one.
  const tree = await client.call('/git/trees', {
    method: 'POST', body: { base_tree: prior.tree.sha,
      tree: plan.files.map((file) => ({
        path: file.path, mode: '100644', type: 'blob', sha: null,
      })) },
  });
  if (!SHA.test(tree?.sha || '')) throw new VaultGitHubError('vault-tree-unavailable');
  const commit = await client.call('/git/commits', {
    method: 'POST', body: { message: 'Delete Oge Vault subject notes',
      tree: tree.sha, parents: [plan.snapshot] },
  });
  if (!SHA.test(commit?.sha || ''))
    throw new VaultGitHubError('vault-commit-unavailable');

  // Persist the exact expected ref before PATCH; a crash is observable.
  const recorded = await journal.updateOne({ ...key, state: 'commit-authorized' }, {
    $set: { state: 'commit-intent', baseCommitSha: plan.snapshot,
      targetCommitSha: commit.sha, targetTreeSha: tree.sha,
      manifestFingerprint: plan.fingerprint, deletedFileCount: plan.files.length,
      updatedAt: new Date() },
  });
  if (recorded.matchedCount !== 1)
    throw new Error('vault-deletion-job-transition-conflict');

  let patchFailure = null;
  try {
    await client.call(refPath, { method: 'PATCH',
      body: { sha: commit.sha, force: false } });
  } catch (error) { patchFailure = error; }

  let current;
  try { current = await client.call(refPath); }
  catch { throw new VaultGitHubError('vault-deletion-commit-unconfirmed', 503); }
  if (current?.object?.sha !== commit.sha) {
    if (patchFailure instanceof VaultGitHubError && [409, 422].includes(patchFailure.status))
      throw new VaultGitHubError('vault-deletion-concurrent-github-edit', 409);
    throw new VaultGitHubError('vault-deletion-commit-unconfirmed', 503);
  }
  let verified;
  try { verified = await client.call('/git/commits/' + commit.sha); }
  catch { throw new VaultGitHubError('vault-deletion-commit-unconfirmed', 503); }
  if (verified?.tree?.sha !== tree.sha ||
      !Array.isArray(verified?.parents) ||
      !verified.parents.some((parent) => parent?.sha === plan.snapshot))
    throw new VaultGitHubError('vault-deletion-commit-unconfirmed', 503);

  const completed = await journal.updateOne({ ...key, state: 'commit-intent',
    targetCommitSha: commit.sha }, {
    $set: { state: 'github-confirmed', confirmedAt: new Date(), updatedAt: new Date() },
  });
  if (completed.matchedCount !== 1)
    throw new Error('vault-deletion-job-reconciliation-required');
  // The subject lock remains held! A separate, as-yet-unimplemented
  // MongoDB reconciliation stage must confirm all invariants before removal.
  return { commitSha: commit.sha, deletedFileCount: plan.files.length,
    githubConfirmed: true };
}
