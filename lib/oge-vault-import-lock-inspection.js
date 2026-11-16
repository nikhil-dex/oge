import { ownerMutationFilter } from './active-owner-mutation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

function report(status, fields = {}) {
  return {
    check: 'oge-vault-import-lock-operator-inspection',
    version: 1, status,
    ...fields,
    readOnly: true, noWritesPerformed: true,
    consistentSnapshot: false,
    automaticUnlockAuthorized: false,
    operatorUnlockAuthorized: false,
    importedContentVerified: false,
  };
}

function describe(row, repoId, expectedOperationId, now) {
  const raw = row?.vaultImportLock;
  if (raw === undefined) return { present: false, valid: true, matches: false, fingerprint: 'none' };
  const basic = raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
    UUID.test(raw.operationId || '') && raw.repoId === repoId &&
    raw.startedAt instanceof Date && Number.isFinite(raw.startedAt.getTime()) &&
    raw.startedAt.getTime() <= now + 60000;
  const phase = raw?.state === undefined ? 'legacy-unknown'
    : raw.state === 'acquired' ? 'before-remote-write'
      : raw.state === 'github-write-possible' ? 'remote-write-possible'
        : 'invalid';
  const valid = basic && phase !== 'invalid' &&
    (phase !== 'remote-write-possible' || (
      typeof raw.commitMarker === 'string' &&
      /^Restore OgeNotes backup [a-f0-9]{64}$/.test(raw.commitMarker) &&
      raw.attemptedAt instanceof Date &&
      Number.isFinite(raw.attemptedAt.getTime()) &&
      raw.attemptedAt >= raw.startedAt &&
      raw.attemptedAt.getTime() <= now + 60000
    ));
  const age = valid ? now - raw.startedAt.getTime() : null;
  const ageBand = !valid ? 'invalid' : age < 15 * 60000
    ? 'recent' : age < 24 * 3600000 ? 'under-24-hours' : 'at-least-24-hours';
  // The private operation ID is used only for matching, never emitted.
  return {
    present: true, valid, matches: valid && raw.operationId === expectedOperationId,
    ageBand, phase,
    fingerprint: valid ? [
      raw.operationId, raw.repoId, raw.startedAt.getTime(),
      raw.state || 'legacy-unknown', raw.attemptedAt?.getTime() || '',
      raw.commitMarker || '',
    ].join(':') : 'invalid',
  };
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1)
    throw new TypeError('Invalid bounded Vault safety count');
  return value === 1;
}

/**
 * INTERNAL OPERATOR FORENSICS ONLY. Never call from a browser route.
 *
 * Strictly read-only: no MongoDB updates, draft reads/decryption, remote note
 * contents or GitHub mutations. This is a point-in-time triage, NOT evidence
 * that an abandoned worker has stopped, the import was committed or the lock
 * can be released. A real operator must separately quiesce writers and
 * perform exact-owner GitHub import reconciliation before any manual repair.
 *
 * The supplied GitHub HEAD reader MUST already be scoped to the verified
 * private repository for this exact owner. It is called twice. Only stability
 * is returned: never SHA, owner ID, operation ID or private note text.
 */
export async function inspectVaultImportLockReadOnly(db, {
  ownerId, sessionVersion, repoId, expectedOperationId,
}, { githubHeadReader, now = new Date() } = {}) {
  if (!db || typeof db.collection !== 'function' ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      typeof expectedOperationId !== 'string' || !UUID.test(expectedOperationId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      typeof githubHeadReader !== 'function')
    throw new TypeError('Exact Vault import inspection scope required');
  const scoped = {
    $and: [
      ownerMutationFilter(ownerId, { sessionVersion }),
      { 'vault.status': 'connected', 'vault.repoId': repoId },
    ],
  };
  const projection = { _id: 0, vaultImportLock: 1, vaultActiveDraftWriters: 1 };
  const users = db.collection('users');
  const first = await users.findOne(scoped, { projection });
  if (!first)
    return report('OWNER_OR_REPOSITORY_NOT_VERIFIED');

  const before = describe(first, repoId, expectedOperationId, now.getTime());
  if (!before.present) return report('NO_LOCK_PRESENT');
  if (!before.valid) return report('LOCK_DATA_INVALID', { lockPresent: true });
  if (!before.matches) return report('DIFFERENT_LOCK_OPERATION', { lockPresent: true });

  const writerCount = first.vaultActiveDraftWriters;
  if (writerCount !== undefined &&
      (!Number.isSafeInteger(writerCount) || writerCount < 0))
    return report('DRAFT_WRITER_COUNTER_INVALID', { lockPresent: true });

  // Bounded existence checks: never materialize encrypted drafts or subject
  // documents. These checks are not a transaction and cannot prove quiescence.
  const draftsPresent = safeCount(await db.collection('vault_drafts').countDocuments(
    { ownerId, repoId }, { limit: 1 }));
  const subjectWritersPresent = safeCount(await db.collection('subjects').countDocuments(
    { ownerId, vaultActiveWriters: { $gt: 0 } }, { limit: 1 }));

  let githubHeadStable = false;
  let providerVerified = false;
  try {
    const firstHead = await githubHeadReader();
    const secondHead = await githubHeadReader();
    providerVerified = SHA.test(firstHead || '') && SHA.test(secondHead || '');
    githubHeadStable = providerVerified && firstHead === secondHead;
  } catch {
    // No error strings: provider exceptions can contain secrets or URLs.
  }

  const second = await users.findOne(scoped, { projection });
  const after = second ? describe(second, repoId, expectedOperationId, now.getTime()) : null;
  const snapshotStable = Boolean(after && after.valid && after.matches &&
    after.fingerprint === before.fingerprint &&
    second.vaultActiveDraftWriters === writerCount);

  const blockers = [];
  if (!snapshotStable) blockers.push('scope-or-lock-changed');
  if (before.phase === 'remote-write-possible')
    blockers.push('github-write-outcome-may-be-unknown');
  if (before.phase === 'legacy-unknown')
    blockers.push('legacy-lock-without-write-attempt-state');
  if (writerCount > 0) blockers.push('active-draft-writers');
  if (subjectWritersPresent) blockers.push('active-subject-writers');
  if (draftsPresent) blockers.push('encrypted-drafts-require-review');
  if (!providerVerified || !githubHeadStable)
    blockers.push('github-head-not-verified-stable');
  // Even no blockers cannot establish a crashed process is truly quiesced.
  blockers.push('external-worker-quiescence-and-import-result-unverified');

  return report('MANUAL_OPERATOR_REVIEW_REQUIRED', {
    lockPresent: true,
    expectedOperationMatched: true,
    ageBand: before.ageBand,
    writeAttemptPhase: before.phase,
    githubWriteMayHaveStarted: before.phase === 'remote-write-possible' ||
      before.phase === 'legacy-unknown',
    activeDraftWriterPresent: writerCount > 0,
    activeSubjectWriterPresent: subjectWritersPresent,
    pendingEncryptedDraftPresent: draftsPresent,
    githubHeadStable,
    providerVerified,
    ownerSnapshotStable: snapshotStable,
    blockers,
  });
}
