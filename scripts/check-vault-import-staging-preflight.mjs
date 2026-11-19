#!/usr/bin/env node
/**
 * Configuration inspection only. Never enable flags, mint GitHub tokens,
 * connect to MongoDB or verify a real account. Safe to run without secrets
 * appearing in output; no production cutover is authorized by this tool.
 */
import { checkVaultImportStagingReadiness } from '../lib/oge-vault-import-staging-preflight.js';

const report = checkVaultImportStagingReadiness(process.env);
console.log('Oge Vault M51 — synthetic import staging configuration preflight');
for (const item of report.failures) console.error('FAIL [' + item.code + '] ' + item.message);
for (const item of report.warnings) console.warn('NOTE [' + item.code + '] ' + item.message);
console.log(report.ok
  ? 'PASS: isolated staging configuration only. Signed two-device GitHub acceptance remains UNVERIFIED.'
  : 'BLOCKED: synthetic import staging prerequisites missing. No external actions were attempted.');
if (!report.ok) process.exitCode = 1;
