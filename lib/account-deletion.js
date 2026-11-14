export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE MY ACCOUNT';
export const ACCOUNT_REAUTH_WINDOW_MS = 5 * 60 * 1000;

export function canDeleteAccount(session, now = Date.now()) {
  const authenticatedAt = session?.user?.authenticatedAt;
  return typeof session?.user?.id === 'string' &&
    typeof authenticatedAt === 'number' &&
    Number.isFinite(authenticatedAt) &&
    authenticatedAt <= now &&
    now - authenticatedAt <= ACCOUNT_REAUTH_WINDOW_MS;
}
