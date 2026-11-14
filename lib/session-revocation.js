/**
 * JWTs are self-contained, so logging out one browser does not revoke them
 * elsewhere. A persisted version makes every existing token invalid once the
 * account version changes. Missing/deleted users fail closed.
 */
export function sessionVersionOf(user) {
  if (!user) return null;
  const value = user.sessionVersion ?? 0;
  return (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) ? value : null;
}

export function isCurrentSession(user, tokenVersion) {
  const expected = sessionVersionOf(user);
  if (expected === null) return false;
  // Legacy JWTs issued before the version field existed are version zero.
  const actual = tokenVersion === undefined ? 0 : tokenVersion;
  return Number.isSafeInteger(actual) && actual === expected;
}
