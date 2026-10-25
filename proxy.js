import { NextResponse } from 'next/server';
import { auth } from './auth.js';

const PUBLIC_PATHS = new Set(['/register', '/style.css', '/extra.css', '/news.css', '/favicon.svg', '/robots.txt', '/manifest.webmanifest', '/apple-touch-icon.png']);

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();
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
