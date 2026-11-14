#!/usr/bin/env node
// Run after `next build`. Supply synthetic CI-only canaries; NEVER real secrets.
import { scanClientArtifacts } from '../lib/client-artifact-scan.js';

const canaryNames = [
  'AUTH_SECRET',
  'AUTH_GOOGLE_SECRET',
  'OGE_HEALTHCHECK_TOKEN',
  'OGE_CI_PRIVATE_CANARY',
];
const canaries = canaryNames.map((name) => process.env[name]);
if (canaries.some((value) => typeof value !== 'string' || value.length < 16)) {
  console.error('Client asset check requires synthetic 16+ character secrets for all CI canary variables.');
  process.exitCode = 1;
} else {
  try {
    const { filesScanned, failures } = await scanClientArtifacts('.next', canaries);
    if (failures.length) {
      // Only filenames are printed. Never log any credential or substring.
      console.error('Client artifact secret canary check failed in ' + failures.length + ' artifacts.');
      for (const file of failures.slice(0, 20)) console.error('Affected artifact: ' + file);
      process.exitCode = 1;
    } else {
      console.log('Client artifact canary check passed (' + filesScanned + ' files).');
    }
  } catch (error) {
    console.error('Client artifact scan unavailable:', error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  }
}
