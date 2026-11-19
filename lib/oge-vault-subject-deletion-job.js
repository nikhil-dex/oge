import { createHash, randomUUID } from 'node:crypto';
import { lockEmptyVaultSubject, releaseVaultSubjectPreflight } from './oge-vault-subject-fence.js';
import { planVaultSubjectDeletion } from './oge-vault-subject-deletion-plan.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

function scope(identity, operationId) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
    !Number.isSafeInteger(repoId) || repoId <= 0 ||
    !UUID.test(subjectId || '') || !UUID.test(operationId || ''))
    throw new TypeError('Invalid subject deletion operation scope');
  return { ownerId, repoId, subjectId: subjectId.toLowerCase(), operationId };
}

function manifestDigest(snapshot, files) {
  if (!SHA.test(snapshot || '') || !Array.isArray(files) ||
      files.some((file) => !UUID.test(file?.noteId || '') ||
        !SHA.test(file?.sha || '') || file.path !== 'notes/' + file.noteId + '.json'))
    throw new TypeError('Invalid deletion manifest');
  const canonical = files.map(({ noteId, path, sha }) => ({ noteId, path, sha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify({ snapshot, files: canonical }))
    .digest('hex');
}

/**
 * B5.3c preparation only, deliberately NON-DESTRUCTIVE.
 *
 * Store an immutable manifest fingerprint under an operation ID while holding
 * a writer fence, then release that fence. A later destructive coordinator
 * cannot trust this manifest without acquiring a NEW lock and verifying
 * GitHub's current head and every blob SHA. No note content is journaled.
 * No DELETE route or MongoDB subject mutation is enabled.
 */
export async function prepareVaultSubjectDeletion(db, client, identity, {
  operationId = randomUUID(), planner = planVaultSubjectDeletion,
} = {}) {
  const key = scope(identity, operationId);
  const journal = db.collection('vault_subject_deletion_jobs');
  const now = new Date();
  await journal.insertOne({ ...key, state: 'prepared', createdAt: now, updatedAt: now,
    destructiveEnabled: false });
  const acquired = await lockEmptyVaultSubject(db, key.ownerId, key.subjectId, { operationId });
  if (!acquired) {
    await journal.updateOne({ ...key, state: 'prepared' }, {
      $set: { state: 'blocked', reason: 'subject-locked-or-active', updatedAt: new Date() },
    });
    return { operationId, ready: false, reason: 'subject-locked-or-active',
      advisoryOnly: true };
  }
  let plan;
  let error;
  try {
    const updated = await journal.updateOne({ ...key, state: 'prepared' }, {
      $set: { state: 'inspecting', updatedAt: new Date() },
    });
    if (updated.matchedCount !== 1) throw new Error('vault-deletion-job-transition-conflict');
    plan = await planner(client, db.collection('vault_drafts'), identity);
    if (plan?.advisoryOnly !== true || typeof plan.ready !== 'boolean' ||
        !Array.isArray(plan.files))
      throw new Error('vault-deletion-plan-invalid');
    const fingerprint = plan.ready ? manifestDigest(plan.snapshot, plan.files) : null;
    const committed = await journal.updateOne({ ...key, state: 'inspecting' }, {
      $set: {
        state: 'planned', reason: plan.reason, snapshot: plan.ready ? plan.snapshot : null,
        fileCount: plan.files.length, fingerprint, updatedAt: new Date(),
      },
    });
    if (committed.matchedCount !== 1) throw new Error('vault-deletion-job-transition-conflict');
  } catch (caught) {
    error = caught;
  }
  try {
    await releaseVaultSubjectPreflight(db, key.ownerId, key.subjectId, operationId);
  } catch (caught) {
    try {
      await journal.updateOne({ ...key, state: { $nin: ['blocked', 'released'] } }, {
        $set: { state: 'needs-recovery', reason: 'lock-release-unconfirmed', updatedAt: new Date() },
      });
    } catch { /* Do not hide release uncertainty. */ }
    if (error) caught.cause = error;
    throw caught;
  }
  const result = await journal.updateOne({ ...key,
    state: error ? { $in: ['prepared', 'inspecting'] } : 'planned',
  }, { $set: { state: 'released', reason: error ? 'inspection-failed' : plan.reason,
    updatedAt: new Date() } });
  if (result.matchedCount !== 1)
    throw new Error('vault-deletion-job-reconciliation-required');
  if (error) throw error;
  return { operationId, ready: plan.ready, reason: plan.reason,
    snapshot: plan.ready ? plan.snapshot : null, fileCount: plan.files.length,
    fingerprint: plan.ready ? manifestDigest(plan.snapshot, plan.files) : null,
    advisoryOnly: true };
}

/** Read-only support diagnostics. No replay, unlock or deletion is allowed. */
export async function inspectVaultDeletionJob(db, identity, operationId) {
  const key = scope(identity, operationId);
  const [job, subject] = await Promise.all([
    db.collection('vault_subject_deletion_jobs').findOne(key),
    db.collection('subjects').findOne({ ownerId: key.ownerId, slug: key.subjectId },
      { projection: { vaultDeletionState: 1, vaultDeletionOperationId: 1 } }),
  ]);
  if (!job) return { found: false, action: 'manual-review' };
  const ownsLock = subject?.vaultDeletionState === 'locked' &&
    subject.vaultDeletionOperationId === operationId;
  const completed = ['released', 'blocked'].includes(job.state);
  return { found: true, operationId, state: job.state, ownsLock,
    fileCount: job.fileCount ?? null,
    action: completed && !ownsLock ? 'none' : 'manual-review',
    destructiveEnabled: false };
}
