import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  collectVaultStoragePathSources, auditVaultLegacyStoragePaths,
  REVIEWED_LEGACY_CONTENT_SURFACES, REVIEWED_DYNAMIC_COLLECTION_SURFACES,
} from '../lib/oge-vault-storage-path-audit.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Phase C audits every current legacy content path and explicitly blocks cutover', async () => {
  const sources = await collectVaultStoragePathSources(root);
  const result = auditVaultLegacyStoragePaths(sources);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.dynamicUnknown, []);
  assert.equal(result.ok, true);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.cutoverBlockedByLegacyPaths, true);
  assert.equal(result.fullContentAuditCompleted, false);
  assert.equal(result.staticPatternsOnly, true);
  assert.deepEqual(result.reviewedLegacyPaths,
    Object.keys(REVIEWED_LEGACY_CONTENT_SURFACES).sort());
  assert.deepEqual(result.reviewedDynamicPaths,
    [...REVIEWED_DYNAMIC_COLLECTION_SURFACES].sort());
});

test('Phase C catches a new extension note writer not present in the reviewed map', () => {
  const report = auditVaultLegacyStoragePaths({
    'app/api/extension/new-capture/route.js':
      "await db.collection('notes').insertOne({ answer: 'synthetic' });",
  });
  assert.ok(report.unexpected.some((entry) =>
    entry.path === 'app/api/extension/new-capture/route.js'));
  assert.equal(report.ok, false);
  assert.equal(report.cutoverAuthorized, false);
});

test('Phase C catches a new dynamic collection call rather than trusting unknown variables', () => {
  const report = auditVaultLegacyStoragePaths({
    'app/api/extension/new-dynamic/route.js':
      "await db.collection(targetCollection).insertOne({ content: 'synthetic' });",
  });
  assert.ok(report.dynamicUnknown.some((entry) =>
    entry.variable === 'targetCollection'));
  assert.equal(report.ok, false);
});

test('Phase C flags deleted/changed reviewed routes so an old approval cannot cover new behavior', () => {
  const code = "await db.collection('quickNotes').insertOne({ content: 'synthetic' });";
  const report = auditVaultLegacyStoragePaths({ 'app/api/notes/route.js': code });
  assert.ok(report.unexpected.some((entry) =>
    entry.path === 'app/api/notes/route.js'));
  assert.ok(report.missing.includes('app/api/notes/route.js'));
  assert.equal(report.ok, false);
});

test('Phase C manifest explicitly categorizes backup import, review restore and extension capture', () => {
  const manifest = REVIEWED_LEGACY_CONTENT_SURFACES;
  assert.equal(manifest['app/api/backup/route.js'].action,
    'export-and-import-content-with-revisions');
  assert.equal(manifest['app/api/revision-history/route.js'].cutoverBlocker, true);
  assert.equal(manifest['app/api/extension/quick-note/route.js'].cutoverBlocker, true);
  assert.equal(manifest['lib/oge-vault-subject-finalization.js'].cutoverBlocker, false);
  for (const path of ['app/api/notes/route.js', 'app/api/quick-notes/route.js',
    'app/api/personal-quick-notes/route.js', 'app/api/backup/route.js']) {
    assert.equal(manifest[path].cutoverBlocker, true);
  }
});

test('Phase C audit report never copies source text or private note content', () => {
  const privateText = 'INTERNAL_PRIVATE_NOTE_CONTENT_SHOULD_NOT_LEAK';
  const report = auditVaultLegacyStoragePaths({
    'app/api/unknown/route.js':
      "await db.collection('notes').insertOne({ answer: '" + privateText + "' });",
  });
  assert.equal(JSON.stringify(report).includes(privateText), false);
  assert.equal(report.cutoverAuthorized, false);
});
