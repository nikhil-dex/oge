import { NextResponse } from 'next/server';
import { auth } from './auth.js';
import { isSameOriginRequest, requiresSameOriginCheck } from './lib/request-origin.js';

const PUBLIC_PATHS = new Set(['/register', '/style.css', '/extra.css', '/news.css', '/favicon.svg', '/robots.txt', '/manifest.webmanifest', '/apple-touch-icon.png']);

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();
  // The extension endpoint uses a separately validated bearer token, not cookie auth.
  if (pathname === '/api/extension/save-link') return NextResponse.next();
  if (requiresSameOriginCheck(request) && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Cross-origin request blocked.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const isPublic = PUBLIC_PATHS.has(pathname);
  if (!request.auth && !isPublic) {
    return NextResponse.redirect(new URL('/register', request.nextUrl.origin));
  }
  if (request.auth && pathname === '/register') {
    return NextResponse.redirect(new URL('/', request.nextUrl.origin));
  }
  return NextResponse.next();
});

export const config = { matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt).*)'] };
