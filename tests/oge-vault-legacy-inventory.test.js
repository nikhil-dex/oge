import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  inspectVaultLegacyData, LEGACY_NOTE_COLLECTIONS, PROTECTED_VAULT_COLLECTIONS,
} from '../lib/oge-vault-legacy-inventory.js';

function fixture(overrides = {}) {
  const visits = [];
  const samples = {
    notes: { total: 3, orphaned: 1 },
    quickNotes: { total: 2, orphaned: 0 },
    personalQuickNotes: { total: 1, orphaned: 1 },
    vault_drafts: { total: 2 },
    vault_save_receipts: { total: 1 },
    vault_files: { total: 6 },
    vault_file_index_state: { total: 1 },
    vault_file_index_bootstrap: { total: 3 },
    vault_subject_inspections: { total: 2 },
    vault_subject_deletion_jobs: { total: 1 },
    ...overrides,
  };
  const db = {
    collection(name) {
      assert.ok([...LEGACY_NOTE_COLLECTIONS, ...PROTECTED_VAULT_COLLECTIONS].includes(name));
      return {
        async countDocuments(filter) {
          visits.push({ name, filter });
          return Object.hasOwn(filter, '$or') ? (samples[name]?.orphaned ?? 0) :
            (samples[name]?.total ?? 0);
        },
        async find() { throw Error('Must never read note content'); },
        async findOne() { throw Error('Must never fetch note content'); },
        async updateOne() { throw Error('Must never mutate'); },
        async deleteOne() { throw Error('Must never delete'); },
      };
    },
  };
  return { db, visits };
}

test('Phase C count-only inventory separates legacy note stores from protected Vault metadata', async () => {
  const f = fixture();
  const report = await inspectVaultLegacyData(f.db);
  assert.deepEqual(report.counts,
    { notes: 3, quickNotes: 2, personalQuickNotes: 1 });
  assert.deepEqual(report.missingOwnerCounts,
    { notes: 1, quickNotes: 0, personalQuickNotes: 1 });
  assert.equal(report.total, 6);
  assert.equal(report.missingOwnerTotal, 2);
  assert.equal(report.protectedCounts.vault_drafts, 2);
  assert.equal(report.protectedCounts.vault_file_index_bootstrap, 3);
  assert.equal(report.protectedTotal, 16);
  assert.equal(report.result, 'BLOCKED_OPERATOR_REVIEW_REQUIRED');
  assert.equal(report.cleanupAuthorized, false);
  assert.equal(report.cutoverAuthorized, false);
  assert.equal(report.deleted, false);
  assert.equal(report.fullContentAuditCompleted, false);
  assert.equal(report.consistentSnapshot, false);
  assert.equal(f.visits.length, LEGACY_NOTE_COLLECTIONS.length * 2 +
    PROTECTED_VAULT_COLLECTIONS.length);
  assert.ok(f.visits.every(({ filter }) => Object.keys(filter).length <= 1));
  assert.ok(f.visits.every(({ filter }) => !Object.hasOwn(filter, 'heading')));
});

test('Phase C empty known legacy stores do not imply a full MongoDB content audit', async () => {
  const f = fixture(Object.fromEntries(LEGACY_NOTE_COLLECTIONS.map(
    (name) => [name, { total: 0, orphaned: 0 }])));
  const report = await inspectVaultLegacyData(f.db);
  assert.equal(report.total, 0);
  assert.equal(report.result, 'NO_LEGACY_NOTE_RECORDS_IN_KNOWN_COLLECTIONS');
  assert.equal(report.knownCollectionsOnly, true);
  assert.equal(report.fullContentAuditCompleted, false);
  assert.equal(report.cutoverAuthorized, false);
  assert.equal(report.protectedCounts.vault_drafts, 2);
});

test('Phase C aborts rather than reporting a false zero when MongoDB counts are inconsistent', async () => {
  await assert.rejects(inspectVaultLegacyData(fixture(
    { notes: { total: 0, orphaned: 1 } }).db), /Inconsistent MongoDB inventory/);
  await assert.rejects(inspectVaultLegacyData(fixture(
    { quickNotes: { total: -1, orphaned: 0 } }).db), /invalid count/);
  await assert.rejects(inspectVaultLegacyData(fixture(
    { vault_drafts: { total: Number.NaN } }).db), /invalid count/);
});

test('Phase C scanner and CLI contain no content fetch, migration, writes or getDatabase initialization', async () => {
  const scanner = await readFile(new URL('../lib/oge-vault-legacy-inventory.js', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../scripts/check-vault-legacy-notes.mjs', import.meta.url), 'utf8');
  assert.match(scanner, /countDocuments\(/);
  assert.doesNotMatch(scanner, /\.find\(|\.findOne\(|\.aggregate\(|\.deleteOne\(|\.updateOne\(|\.insertOne\(/);
  assert.doesNotMatch(cli, /await getDatabase\(|\.deleteMany\(|\.dropDatabase\(|\.updateOne\(/);
  assert.match(cli, /OGE_VAULT_INVENTORY_READ_ONLY/);
  assert.match(cli, /YES_COUNTS_ONLY/);
  assert.doesNotMatch(cli, /console\.log\(uri\)|console\.log\(error\)/);
});
