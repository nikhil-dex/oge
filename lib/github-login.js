/** GitHub OAuth identities must not collide with Google's numeric OIDC sub values. */
export function githubOwnerId(providerAccountId) {
  const id = String(providerAccountId ?? '');
  return /^[1-9][0-9]{0,19}$/.test(id) ? 'github:' + id : null;
}

/** Verify email using GitHub's authenticated /user/emails endpoint.
 * Do not trust the public profile email, which can be unverified or absent.
 */
export async function getVerifiedGitHubEmail(accessToken, { fetcher = fetch } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) return null;
  try {
    const response = await fetcher('https://api.github.com/user/emails', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const emails = await response.json();
    if (!Array.isArray(emails) || emails.length > 100) return null;
    const entry = emails.find((item) => item?.primary === true && item.verified === true &&
      typeof item.email === 'string' && item.email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email));
    return entry ? entry.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
