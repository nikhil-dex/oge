#!/usr/bin/env node
/**
 * Phase C static source-path audit. Reads repository JavaScript/TypeScript
 * files only, never connects to production MongoDB, never prints note data.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  collectVaultStoragePathSources, auditVaultLegacyStoragePaths,
} from '../lib/oge-vault-storage-path-audit.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  const sources = await collectVaultStoragePathSources(root);
  const report = auditVaultLegacyStoragePaths(sources);
  console.log(JSON.stringify({
    check: 'oge-vault-legacy-storage-path-audit',
    ...report,
    scannedFiles: Object.keys(sources).length,
  }, null, 2));
  if (!report.ok) {
    console.error('BLOCKED: one or more legacy content paths require code review.');
    process.exitCode = 1;
  } else {
    console.log('PASS: current legacy storage paths are mapped. GitHub-only cutover remains blocked.');
  }
} catch (error) {
  console.error('Storage-path audit unavailable: ' +
    (error instanceof Error ? error.name : 'UnknownError'));
  process.exitCode = 1;
}
