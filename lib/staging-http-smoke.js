/**
 * Read-only HTTP smoke checks for a privately deployed staging instance.
 * Never follows redirects; never reads or logs response bodies. The monitor
 * token is sent only to the exact, validated staging origin.
 */
export function stagingSmokeOrigin(rawUrl, explicitHost) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Set a valid staging HTTPS origin.'); }
  if (url.protocol !== 'https:' || !url.hostname ||
      url.hostname !== explicitHost || !/(?:^|[.-])(?:staging|preview)(?:[.-]|$)/i.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Refusing a non-staging or mismatched HTTPS origin.');
  }
  return url.origin;
}

export async function checkStagingHttp({ origin, monitorToken, fetcher = fetch }) {
  if (typeof monitorToken !== 'string' || monitorToken.length < 32) {
    throw new Error('A private staging monitor token of at least 32 characters is required.');
  }
  const findings = [];
  const check = (pass, code, detail) => findings.push({ code, pass: Boolean(pass), detail });
  async function probe(path, headers = {}) {
    const target = new URL(path, origin);
    if (target.origin !== origin) throw new Error('Refusing a cross-origin probe.');
    const response = await fetcher(target, {
      method: 'GET', headers, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    return response;
  }

  // Public register page confirms the deployed app/middleware and its headers.
  const register = await probe('/register');
  check(register.status === 200, 'register-page', 'Registration entrypoint must be reachable (HTTP 200).');
  const headers = register.headers;
  check(headers.get('x-content-type-options') === 'nosniff', 'nosniff', 'X-Content-Type-Options must be nosniff.');
  check(headers.get('x-frame-options') === 'DENY', 'frame-denial', 'X-Frame-Options must deny embedding.');
  check(headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
    'referrer', 'Expected restrictive referrer policy.');
  check(Boolean(headers.get('strict-transport-security')), 'hsts', 'Production-mode staging HTTPS must send HSTS.');
  check(Boolean(headers.get('content-security-policy-report-only')) &&
    !headers.get('content-security-policy'), 'csp-report-only',
  'Initial staging must have report-only CSP, not enforced CSP.');

  // Cookie-free private access may return 401/403 or redirect; HTTP 200 is unsafe.
  for (const path of ['/api/subjects', '/api/notes', '/api/backup', '/settings']) {
    const response = await probe(path);
    const denied = [401, 403].includes(response.status) || [301, 302, 303, 307, 308].includes(response.status);
    const redirectTo = response.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    let safeRedirect = !isRedirect;
    if (isRedirect && redirectTo) {
      try {
        const url = new URL(redirectTo, origin);
        safeRedirect = url.origin === origin && url.pathname === '/register';
      } catch { safeRedirect = false; }
    }
    check(denied && safeRedirect, 'anonymous-' + path.replaceAll('/', '-'),
      path + ' must deny unauthenticated reads or redirect only to local registration.');
  }

  const anonymousHealth = await probe('/api/health');
  check(anonymousHealth.status === 401, 'health-unauthenticated', 'Anonymous health checks must be denied.');
  const health = await probe('/api/health', { Authorization: 'Bearer ' + monitorToken });
  check(health.status === 200, 'health-authorized',
    'Authenticated health must return HTTP 200 (including successful DB ping).');
  check(/no-store/i.test(health.headers.get('cache-control') || ''), 'health-no-store',
    'Health responses must be uncacheable.');

  return { ok: findings.every((f) => f.pass), findings };
}
