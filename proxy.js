import { NextResponse } from 'next/server';
import { auth } from './auth.js';
import { isSameOriginRequest, requiresSameOriginCheck } from './lib/request-origin.js';
import { applySecurityHeaders } from './lib/security-headers.js';

const PUBLIC_PATHS = new Set(['/register', '/style.css', '/extra.css', '/news.css', '/favicon.svg', '/robots.txt', '/manifest.webmanifest', '/apple-touch-icon.png']);

function secure(response) {
  return applySecurityHeaders(response);
}

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/auth/')) return secure(NextResponse.next());
  // The extension endpoint uses a separately validated bearer token, not cookie auth.
  if (pathname === '/api/extension/save-link') return secure(NextResponse.next());
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
  return secure(NextResponse.next());
});

export const config = { matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt).*)'] };
