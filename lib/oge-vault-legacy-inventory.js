/**
 * Phase C: read-only, metadata-only inventory of *known* legacy MongoDB
 * note stores and protected Oge Vault recovery state. The collected counts
 * are NEVER proof that an arbitrary database contains no other note bodies.
 *
 * This function does not inspect, decrypt, download, copy or return note text,
 * titles, user IDs, repository IDs or credentials. No deletion is authorized.
 */
export const LEGACY_NOTE_COLLECTIONS = Object.freeze([
  'notes', 'quickNotes', 'personalQuickNotes',
]);

export const PROTECTED_VAULT_COLLECTIONS = Object.freeze([
  'vault_drafts',
  'vault_save_receipts',
  'vault_files',
  'vault_file_index_state',
  'vault_file_index_bootstrap',
  'vault_subject_inspections',
  'vault_subject_deletion_jobs',
]);

const OWNER_MISSING = { $or: [
  { ownerId: { $exists: false } }, { ownerId: null }, { ownerId: '' },
] };

function checkedCount(count) {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('MongoDB inventory returned an invalid count');
  return count;
}

/**
 * Deliberately perform only countDocuments operations. Avoid getDatabase():
 * that initializer creates indexes and is not read-only.
 *
 * Counts are point-in-time observations, not one atomic snapshot; another
 * actor may write during this audit. They cannot independently authorize
 * data deletion, migration, or GitHub-only production cutover.
 */
export async function inspectVaultLegacyData(db) {
  if (!db || typeof db.collection !== 'function')
    throw new TypeError('MongoDB database required');

  const counts = Object.create(null);
  const missingOwnerCounts = Object.create(null);
  const protectedCounts = Object.create(null);
  let total = 0;
  let missingOwnerTotal = 0;
  let protectedTotal = 0;

  for (const name of LEGACY_NOTE_COLLECTIONS) {
    const collection = db.collection(name);
    const amount = checkedCount(await collection.countDocuments({}));
    const missingOwner = checkedCount(await collection.countDocuments(OWNER_MISSING));
    if (missingOwner > amount) throw new Error('Inconsistent MongoDB inventory counts');
    counts[name] = amount;
    missingOwnerCounts[name] = missingOwner;
    total += amount;
    missingOwnerTotal += missingOwner;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(missingOwnerTotal))
      throw new Error('MongoDB inventory count overflow');
  }

  for (const name of PROTECTED_VAULT_COLLECTIONS) {
    const amount = checkedCount(await db.collection(name).countDocuments({}));
    protectedCounts[name] = amount;
    protectedTotal += amount;
    if (!Number.isSafeInteger(protectedTotal))
      throw new Error('MongoDB inventory count overflow');
  }

  return {
    check: 'oge-vault-mongodb-content-inventory',
    counts: { ...counts }, total,
    missingOwnerCounts: { ...missingOwnerCounts }, missingOwnerTotal,
    protectedCounts: { ...protectedCounts }, protectedTotal,
    result: total > 0 ? 'BLOCKED_OPERATOR_REVIEW_REQUIRED' :
      'NO_LEGACY_NOTE_RECORDS_IN_KNOWN_COLLECTIONS',
    knownCollectionsOnly: true,
    consistentSnapshot: false,
    fullContentAuditCompleted: false,
    cutoverAuthorized: false,
    cleanupAuthorized: false,
    deleted: false,
  };
}
