const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requiresSameOriginCheck(request) {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith('/api/')
    && !pathname.startsWith('/api/auth/')
    && pathname !== '/api/extension/save-link'
    && STATE_CHANGING_METHODS.has(request.method.toUpperCase());
}

export function isSameOriginRequest(request) {
  let expectedOrigin;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return origin !== 'null' && new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}
