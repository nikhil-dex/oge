#!/usr/bin/env node
/**
 * Read-only private-staging readiness check.
 * Reads environment variables already provided by your deployment shell;
 * never loads, prints, uploads or modifies credential values.
 */
import { checkStagingConfiguration } from '../lib/staging-preflight.js';

const result = checkStagingConfiguration(process.env);
console.log('OgeNotes Phase 6 — private staging preflight');
for (const issue of result.failures) console.error('FAIL [' + issue.code + '] ' + issue.message);
for (const issue of result.warnings) console.warn('NOTE [' + issue.code + '] ' + issue.message);
if (!result.ok) {
  console.error('Preflight blocked: fix the configuration failures before deploying staging.');
  process.exitCode = 1;
} else {
  console.log('PASS: configuration checks passed. Manual isolation review and live staging tests are still required.');
}
