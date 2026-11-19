#!/usr/bin/env node
/**
 * Read-only B7 GitHub Vault staging preflight.
 * Inspects provided environment variables in memory only. No network calls,
 * credential output, GitHub writes, MongoDB writes or deployment changes.
 */
import { checkVaultStagingReadiness } from '../lib/oge-vault-staging-preflight.js';

const report = checkVaultStagingReadiness(process.env);
console.log('Oge Vault B7 — isolated staging configuration preflight');
for (const item of report.failures)
  console.error('FAIL [' + item.code + '] ' + item.message);
for (const item of report.warnings)
  console.warn('NOTE [' + item.code + '] ' + item.message);
console.log(report.ok
  ? 'PASS: configuration prerequisites met. Authenticated live staging remains unverified.'
  : 'BLOCKED: configuration prerequisites missing. No live staging actions were attempted.');
if (!report.ok) process.exitCode = 1;
