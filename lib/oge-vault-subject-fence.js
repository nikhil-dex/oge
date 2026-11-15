/**
 * MongoDB subject-row fencing for the Vault's eventual cross-store deletion.
 *
 * Every note/draft writer must acquire this fence before touching a subject.
 * MongoDB performs each increment and deletion-state check atomically on the
 * same row. The destructive delete workflow MUST hold a lock until GitHub and
 * MongoDB have been reconciled; it is NOT enabled by this module.
 *
 * Counters intentionally have no TTL: a crashed writer fails closed and
 * requires audited operator recovery, not silent expiration.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class VaultSubjectLockedError extends Error {
  constructor() { super('vault-subject-locked-or-missing'); this.name = 'VaultSubjectLockedError'; }
}

function scope(ownerId, subjectId) {
  if (typeof ownerId !== 'string' || !ownerId ||
      typeof subjectId !== 'string' || !UUID.test(subjectId))
    throw new TypeError('Invalid Vault subject write scope');
  return { ownerId, slug: subjectId.toLowerCase() };
}

export async function withVaultSubjectWrite(db, ownerId, subjectId, work) {
  const key = scope(ownerId, subjectId);
  if (typeof work !== 'function') throw new TypeError('Subject write operation required');
  const subjects = db.collection('subjects');
  const acquired = await subjects.updateOne({
    ...key, vaultDeletionState: { $ne: 'locked' },
  }, { $inc: { vaultActiveWriters: 1 } });
  if (acquired.matchedCount !== 1) throw new VaultSubjectLockedError();

  let result;
  let workError;
  try { result = await work(); }
  catch (error) { workError = error; }
  try {
    const released = await subjects.updateOne({
      ...key, vaultActiveWriters: { $gt: 0 },
    }, { $inc: { vaultActiveWriters: -1 } });
    if (released.matchedCount !== 1) throw new Error('vault-subject-fence-release-unconfirmed');
  } catch (releaseError) {
    // Never mask a possible unaccounted writer: release failure is a
    // release-integrity incident requiring operator reconciliation.
    if (workError) releaseError.cause = workError;
    throw releaseError;
  }
  if (workError) throw workError;
  return result;
}

export async function withVaultSubjectsWrite(db, ownerId, subjectIds, work) {
  if (!Array.isArray(subjectIds) || subjectIds.length < 1 || subjectIds.length > 12)
    throw new TypeError('Invalid Vault subject batch');
  const sorted = [...new Set(subjectIds.map((id) => scope(ownerId, id).slug))].sort();
  const run = (index) => index === sorted.length
    ? work()
    : withVaultSubjectWrite(db, ownerId, sorted[index], () => run(index + 1));
  return run(0);
}

/**
 * Internal-only lock primitive, not exposed as an HTTP delete endpoint.
 * It atomically blocks new fenced writes if no in-flight writer exists.
 * No automatic unlock or subject removal is provided; recovery is manual.
 */
export async function lockEmptyVaultSubject(db, ownerId, subjectId) {
  const key = scope(ownerId, subjectId);
  const result = await db.collection('subjects').updateOne({
    ...key,
    vaultDeletionState: { $ne: 'locked' },
    $or: [{ vaultActiveWriters: 0 }, { vaultActiveWriters: { $exists: false } }],
  }, { $set: { vaultDeletionState: 'locked', vaultDeletionLockedAt: new Date() } });
  return result.matchedCount === 1;
}
