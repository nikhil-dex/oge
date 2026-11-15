#!/usr/bin/env node
/**
 * Read-only authenticated staging HTML/CSP regression check.
 * Uses two disposable, already-onboarded Google test sessions.
 * Never run against production. Does not print response bodies or cookies.
 */
const raw = process.env.OGE_STAGING_URL;
const host = process.env.OGE_STAGING_HOST;
const cookies = [process.env.OGE_STAGING_COOKIE_A, process.env.OGE_STAGING_COOKIE_B];
function check(ok, description) { if (!ok) throw new Error(description); }
check(raw && host && cookies.every(Boolean) && cookies[0] !== cookies[1],
  'Set staging URL, exact host, and two distinct disposable test session cookies.');
const origin = new URL(raw);
check(origin.hostname === host && /(?:staging|preview|localhost|127\.0\.0\.1)/i.test(host),
  'Host must exactly match a staging/preview/localhost hostname.');
check(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(host)),
  'HTTPS is required except for localhost.');
check(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
  'Use a bare staging origin without credentials, paths or query strings.');

async function inspect(path, cookie) {
  const response = await fetch(new URL(path, origin), {
    headers: { Cookie: cookie, Accept: 'text/html', 'Cache-Control': 'no-cache' },
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  check(response.status === 200, path + ' did not render HTTP 200; confirm test account onboarding and staging access.');
  const contentType = response.headers.get('content-type') || '';
  check(contentType.includes('text/html'), path + ' returned a non-HTML response.');
  const policy = response.headers.get('content-security-policy-report-only') || '';
  const nonce = policy.match(/'nonce-([A-Za-z0-9+/_=-]{16,128})'/)?.[1];
  check(Boolean(nonce), path + ' is missing report-only CSP nonce.');
  check(!response.headers.has('content-security-policy'), path + ' unexpectedly enforces CSP.');
  const html = await response.text();
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]));
  check(inlineScripts.length > 0, path + ' had no inline scripts to validate.');
  for (const script of inlineScripts) {
    const value = script[1].match(/\bnonce\s*=\s*["']([^"']+)["']/i)?.[1];
    check(value === nonce, path + ' includes an inline script with missing/mismatched nonce.');
  }
  const cache = response.headers.get('cache-control') || '';
  // Report this, do not mistake a local response for verification of real CDN caching.
  console.log('PASS: ' + path + ' authenticated HTML, report-only CSP and ' + inlineScripts.length + ' inline script nonces match.');
  console.log('INFO: ' + path + ' cache-control=' +
    (cache ? (/public|s-maxage/i.test(cache) ? 'REVIEW-PUBLIC-CACHE-DIRECTIVE' : 'present') : 'absent; review CDN behavior'));
  return nonce;
}
try {
  for (let account = 0; account < cookies.length; account++) {
    const first = await inspect('/notes', cookies[account]);
    const second = await inspect('/notes', cookies[account]);
    check(first !== second, 'Repeated /notes document GETs reused a CSP nonce.');
    await inspect('/settings', cookies[account]);
    console.log('PASS: disposable test account ' + (account + 1) + ' private navigation nonce rotation.');
  }
  console.log('PASS: authenticated staging HTML CSP checks completed; no data mutations attempted.');
  console.log('NOTE: This does not verify OAuth callbacks, browser RSC navigation, CDN caching or cross-account isolation.');
} catch {
  // Do not surface underlying network errors containing URLs or sensitive headers.
  console.error('FAIL: authenticated staging HTML CSP check. Review account onboarding, host and headers privately.');
  process.exitCode = 1;
}
