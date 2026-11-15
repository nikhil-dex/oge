#!/usr/bin/env node
/**
 * Read-only production/staging preflight for switching to GitHub-only notes.
 * Emits counts only, never private note titles or content.
 *
 * Running this does not authorize deletion. Any nonzero content blocks cutover
 * until the operator verifies its origin and approves cleanup separately.
 */
import { getDatabase } from '../lib/mongodb.js';

const fields = [
  { name: 'notes', filter: {} },
  { name: 'quickNotes', filter: {} },
  { name: 'personalQuickNotes', filter: {} },
];
try {
  const db = await getDatabase();
  const counts = {};
  for (const { name, filter } of fields) {
    counts[name] = await db.collection(name).countDocuments(filter);
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  process.stdout.write(JSON.stringify({
    check: 'oge-vault-mongodb-content-inventory', counts, total,
    result: total > 0 ? 'BLOCKED_OPERATOR_REVIEW_REQUIRED' : 'NO_LEGACY_NOTE_RECORDS',
    deleted: false,
  }, null, 2) + '\n');
  if (total > 0) process.exitCode = 2;
} catch (error) {
  process.stderr.write('Vault legacy data inventory unavailable: ' +
    (error instanceof Error ? error.name : 'UnknownError') + '\n');
  process.exitCode = 1;
}
