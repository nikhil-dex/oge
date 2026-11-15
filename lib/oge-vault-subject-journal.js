import { randomUUID } from 'node:crypto';
import { lockEmptyVaultSubject, releaseVaultSubjectPreflight } from './oge-vault-subject-fence.js';
import { inspectVaultSubject } from './oge-vault-subject-preflight.js';

// Durable, metadata-only audit journal for read-only locked inspection.
// Not a destructive deletion transaction. No note bodies, headings or tags.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['prepared', 'locked', 'inspected', 'released', 'blocked', 'needs-recovery']);

function checkedIdentity(identity, operationId) {
  const { ownerId, repoId, subjectId } = identity || {};
  if (typeof ownerId !== 'string' || !ownerId ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      !UUID.test(subjectId || '') || !UUID.test(operationId || ''))
    throw new TypeError('Invalid Vault subject inspection identity');
  return { ownerId, repoId, subjectId: subjectId.toLowerCase(), operationId };
}

async function transition(records, key, from, to, fields = {}) {
  if (!STATES.has(from) || !STATES.has(to)) throw new TypeError('Invalid inspection state');
  const result = await records.updateOne({ ...key, state: from },
    { $set: { state: to, updatedAt: new Date(), ...fields } });
  if (result.matchedCount !== 1) throw new Error('vault-subject-inspection-state-conflict');
}

/**
 * A durable journal is created before acquiring any subject lock.
 * All lock releases are token-fenced. A crash can leave a locked subject,
 * but the operation ID and journal remain available for audited recovery.
 *
 * This helper is INTERNAL ONLY; never expose it as a delete endpoint.
 */
export async function journalVaultSubjectInspection(db, client, identity, {
  operationId = randomUUID(), inspector = inspectVaultSubject,
} = {}) {
  const key = checkedIdentity(identity, operationId);
  const records = db.collection('vault_subject_inspections');
  const createdAt = new Date();
  await records.insertOne({ ...key, state: 'prepared', createdAt, updatedAt: createdAt });

  const acquired = await lockEmptyVaultSubject(db, key.ownerId, key.subjectId, { operationId });
  if (!acquired) {
    await transition(records, key, 'prepared', 'blocked', { reason: 'subject-locked-or-active' });
    return { safeToDelete: false, reason: 'subject-locked-or-active',
      advisoryOnly: true, operationId };
  }

  let state = 'prepared';
  let inspection = null;
  let failure = null;
  try {
    await transition(records, key, state, 'locked');
    state = 'locked';
    inspection = await inspector(client, db.collection('vault_drafts'), {
      ownerId: key.ownerId, repoId: key.repoId, subjectId: key.subjectId,
    });
    if (typeof inspection?.safeToDelete !== 'boolean')
      throw new Error('vault-subject-inspection-invalid');
    // Store only flags and verified snapshot metadata, never user note text.
    await transition(records, key, state, 'inspected', {
      outcome: inspection.safeToDelete ? 'empty-at-snapshot' : 'blocked',
      reason: inspection.reason || 'unknown',
      snapshot: typeof inspection.snapshot === 'string' ? inspection.snapshot : null,
    });
    state = 'inspected';
  } catch (error) { failure = error; }

  try {
    await releaseVaultSubjectPreflight(db, key.ownerId, key.subjectId, operationId);
    // A released subject can accept writers again: the result is never
    // permission to delete on a later request.
    await transition(records, key, state, 'released', {
      outcome: failure ? 'inspection-failed' : inspection.safeToDelete ? 'empty-at-snapshot' : 'blocked',
    });
  } catch (releaseOrJournalError) {
    // Do not issue an automatic unlock on retry: release may already have
    // happened. The journal+subject must be inspected by an operator.
    try {
      await records.updateOne({ ...key, state: { $ne: 'released' } }, {
        $set: { state: 'needs-recovery', updatedAt: new Date() },
      });
    } catch { /* Preserve original error; never claim success. */ }
    if (failure) releaseOrJournalError.cause = failure;
    throw releaseOrJournalError;
  }
  if (failure) throw failure;
  return { ...inspection, advisoryOnly: true, operationId };
}

/** Read-only operator diagnostic; does not unlock, delete, or retry writes. */
export async function inspectVaultSubjectRecovery(db, identity, operationId) {
  const key = checkedIdentity(identity, operationId);
  const [record, subject] = await Promise.all([
    db.collection('vault_subject_inspections').findOne(key),
    db.collection('subjects').findOne({ ownerId: key.ownerId, slug: key.subjectId },
      { projection: { vaultDeletionState: 1, vaultDeletionOperationId: 1, vaultActiveWriters: 1 } }),
  ]);
  if (!record) return { found: false, action: 'manual-review' };
  const ownsLock = subject?.vaultDeletionState === 'locked' &&
    subject.vaultDeletionOperationId === operationId;
  return {
    found: true, operationId, state: record.state, ownsLock,
    action: record.state === 'released' || record.state === 'blocked'
      ? 'none' : 'manual-review',
  };
}
