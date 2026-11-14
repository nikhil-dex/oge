#!/usr/bin/env node
/**
 * Read-only staging HTTP verification. Does not transmit cookies or data.
 * Never log credentials, URLs containing credentials, or HTTP response bodies.
 */
import { stagingSmokeOrigin, checkStagingHttp } from '../lib/staging-http-smoke.js';

try {
  const origin = stagingSmokeOrigin(process.env.OGE_STAGING_URL, process.env.OGE_STAGING_HOST);
  const report = await checkStagingHttp({
    origin,
    monitorToken: process.env.OGE_HEALTHCHECK_TOKEN,
  });
  for (const result of report.findings) {
    const status = result.pass ? 'PASS' : 'FAIL';
    console.log(status + ' [' + result.code + '] ' + result.detail);
  }
  if (!report.ok) {
    console.error('Staging HTTP verification failed; review the failing checks before release.');
    process.exitCode = 1;
  } else {
    console.log('PASS: read-only staging HTTP checks succeeded. OAuth and two-account checks still require live browser testing.');
  }
} catch (error) {
  // Tool-specific exceptions can contain underlying URLs or headers; never print them.
  console.error('Staging HTTP verification could not complete: ' +
    (error?.message === 'Set a valid staging HTTPS origin.' ||
      error?.message === 'Refusing a non-staging or mismatched HTTPS origin.' ||
      error?.message === 'A private staging monitor token of at least 32 characters is required.'
      ? error.message : 'Network/deployment check failed.'));
  process.exitCode = 1;
}
