import { NextResponse } from 'next/server';
import { auth } from './auth.js';

const PUBLIC_PATHS = new Set(['/register']);

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();
  const isPublic = PUBLIC_PATHS.has(pathname);
  if (!request.auth && !isPublic) {
    const target = new URL('/register', request.nextUrl.origin);
    return NextResponse.redirect(target);
  }
  if (request.auth && pathname === '/register') {
    return NextResponse.redirect(new URL('/', request.nextUrl.origin));
  }
  return NextResponse.next();
});

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'] };
