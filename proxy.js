import { NextResponse } from 'next/server';
import { auth } from './auth.js';
import { isSameOriginRequest, requiresSameOriginCheck } from './lib/request-origin.js';
import { applySecurityHeaders, securityHeaderEntries } from './lib/security-headers.js';

const PUBLIC_PATHS = new Set(['/register', '/style.css', '/extra.css', '/news.css', '/favicon.svg', '/robots.txt', '/manifest.webmanifest', '/apple-touch-icon.png']);

function secure(response, nonce) {
  return applySecurityHeaders(response, nonce);
}

function nextWithNonce(request) {
  // Next.js reads the nonce from the request CSP and attaches it to
  // framework-generated scripts. Only the report-only header is sent to browsers.
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy',
    securityHeaderEntries(nonce).find(({ key }) => key.endsWith('Report-Only') || key === 'Content-Security-Policy').value);
  return secure(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
}

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/auth/')) return secure(NextResponse.next());
  // Health endpoint authenticates a separate monitor bearer token in its route.
  // Do not redirect anonymous monitors to the Google sign-in page.
  if (pathname === '/api/health' && request.method === 'GET') return secure(NextResponse.next());
  // CSP telemetry is sent without a user session and must not redirect to sign-in.
  if (pathname === '/api/csp-report' && request.method === 'POST') return secure(NextResponse.next());
  // The extension endpoint uses a separately validated bearer token, not cookie auth.
  if (pathname === '/api/extension/save-link' || pathname === '/api/extension/profile-links' || pathname === '/api/extension/quick-note' || pathname === '/api/extension/subjects') return secure(NextResponse.next());
  if (requiresSameOriginCheck(request) && !isSameOriginRequest(request)) {
    return secure(NextResponse.json({ error: 'Cross-origin request blocked.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } }));
  }
  const isPublic = PUBLIC_PATHS.has(pathname);
  if (!request.auth && !isPublic) {
    return secure(NextResponse.redirect(new URL('/register', request.nextUrl.origin)));
  }
  if (request.auth && pathname === '/register') {
    return secure(NextResponse.redirect(new URL('/', request.nextUrl.origin)));
  }
  if (request.method === 'GET' && !pathname.startsWith('/api/')) return nextWithNonce(request);
  return secure(NextResponse.next());
});

export const config = { matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt).*)'] };
