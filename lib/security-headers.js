const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://accounts.google.com",
  "script-src 'self' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https://accounts.google.com https://*.googleapis.com",
  "frame-src https://accounts.google.com",
  "report-uri /api/csp-report",
].join('; ');

export function cspForNonce(nonce) {
  if (!nonce) return CSP_DIRECTIVES;
  if (!/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new TypeError('Invalid CSP nonce');
  return CSP_DIRECTIVES.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}

export function securityHeaderEntries(nonce) {
  const headers = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    // Enforce only after staging browser/OAuth verification. The default stays
    // report-only; setting this flag affects the next deployed build.
    { key: process.env.OGE_ENFORCE_CSP === 'true'
      ? 'Content-Security-Policy'
      : 'Content-Security-Policy-Report-Only', value: cspForNonce(nonce) },
  ];
  if (process.env.NODE_ENV === 'production') {
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  }
  return headers;
}

export function applySecurityHeaders(response, nonce) {
  for (const { key, value } of securityHeaderEntries(nonce)) response.headers.set(key, value);
  return response;
}
