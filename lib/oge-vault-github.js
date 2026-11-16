import { createHash, createSign, randomBytes, timingSafeEqual } from 'node:crypto';

export const VAULT_REPO_NAME = 'ogenotes-vault';
export const VAULT_MARKER_PATH = '.ogenotes/vault.json';
export const VAULT_STATE_COOKIE = 'oge-vault-oauth-state';
export const VAULT_STATE_AGE_MS = 10 * 60 * 1000;

export function vaultConfigured(env = process.env) {
  return Boolean(env.OGE_VAULT_GITHUB_CLIENT_ID && env.OGE_VAULT_GITHUB_CLIENT_SECRET &&
    env.OGE_VAULT_GITHUB_APP_ID && env.OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64 && env.OGE_VAULT_BASE_URL);
}

export function vaultBaseUrl(env = process.env) {
  const raw = env.OGE_VAULT_BASE_URL;
  if (typeof raw !== 'string') throw new Error('Vault URL not configured');
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      url.pathname !== '/') throw new Error('Invalid vault application URL');
  return url.origin;
}

export function vaultCallbackUrl(env = process.env) {
  return vaultBaseUrl(env) + '/api/vault/callback';
}

export function newVaultOAuthState() {
  return randomBytes(32).toString('base64url');
}

export function stateHash(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid OAuth state');
  return createHash('sha256').update(value).digest('hex');
}

export function stateMatches(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !/^[a-zA-Z0-9_-]{43}$/.test(left) || !/^[a-zA-Z0-9_-]{43}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function githubAppJwt({ env = process.env, now = Date.now() } = {}) {
  const id = String(env.OGE_VAULT_GITHUB_APP_ID || '');
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new Error('Invalid GitHub App ID');
  const pem = Buffer.from(env.OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64 || '', 'base64').toString('utf8');
  if (!pem.startsWith('-----BEGIN ') || !pem.includes('PRIVATE KEY-----')) throw new Error('Missing GitHub App signing key');
  const iat = Math.floor(now / 1000) - 60;
  const payload = { iat, exp: iat + 540, iss: id };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  return data + '.' + signer.sign(pem, 'base64url');
}

export class VaultGitHubError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'VaultGitHubError';
    this.status = status;
  }
}

/**
 * GitHub transport retries only provably read-only requests. GitHub writes
 * (including creation, PATCH ref updates and OAuth token minting) are NEVER
 * blindly repeated: a lost response could conceal a successful mutation.
 * Rate-limit replies always stop, leaving the caller's draft pending.
 */
export async function vaultGithubRequest(path, { token, method = 'GET', body, fetcher = fetch } = {}) {
  if (!/^\/[a-zA-Z0-9_./?=&%-]+$/.test(path) || path.includes('..') || path.includes('//')) {
    throw new TypeError('Invalid GitHub API path');
  }
  const maxAttempts = method === 'GET' ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;
    try {
      response = await fetcher('https://api.github.com' + path, {
        method, cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      // Do not expose tokens, URLs or provider response bodies in errors.
      throw new VaultGitHubError('github-network-unavailable', 503);
    }
    if (!response.ok) {
      const limited = response.status === 429 ||
        (response.status === 403 && (
          response.headers?.get?.('x-ratelimit-remaining') === '0' ||
          response.headers?.get?.('retry-after') != null));
      if (limited) throw new VaultGitHubError('github-rate-limited', 429);
      if ([502, 503, 504].includes(response.status) &&
          attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      throw new VaultGitHubError(
        response.status === 401 ? 'github-auth-expired' :
          response.status === 403 ? 'github-permission-denied' :
            response.status === 422 ? 'github-repository-conflict' :
              'github-api-error', response.status,
      );
    }
    try { return await response.json(); }
    catch { throw new VaultGitHubError('github-response-invalid', 502); }
  }
  throw new VaultGitHubError('github-network-unavailable', 503);
}

export async function exchangeVaultOAuthCode(code, { env = process.env, fetcher = fetch } = {}) {
  if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{8,200}$/.test(code)) throw new Error('Invalid GitHub callback code');
  const response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.OGE_VAULT_GITHUB_CLIENT_ID,
      client_secret: env.OGE_VAULT_GITHUB_CLIENT_SECRET,
      code, redirect_uri: vaultCallbackUrl(env),
    }),
  });
  if (!response.ok) throw new VaultGitHubError('oauth-exchange-failed', response.status);
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !result.access_token ||
      typeof result.expires_in !== 'number' || result.expires_in <= 0) {
    throw new VaultGitHubError('oauth-exchange-failed');
  }
  return result.access_token;
}

/** Create an owned private repository only. Never take over or mutate a same-name
 * existing repository without an explicit, separately reviewed adoption path.
 */
export async function provisionVault(githubUserToken, {
  env = process.env, fetcher = fetch, expectedGitHubId = null,
} = {}) {
  const call = (path, opts = {}) => vaultGithubRequest(path, { token: githubUserToken, fetcher, ...opts });
  const identity = await call('/user');
  if (!Number.isSafeInteger(identity.id) || identity.id < 1 || typeof identity.login !== 'string' ||
      !/^[a-zA-Z0-9-]{1,39}$/.test(identity.login) || identity.type !== 'User') {
    throw new VaultGitHubError('unsupported-github-owner', 400);
  }
  // Install the App for all repositories before creating the vault; an
  // installation limited to selected repos cannot automatically access a new
  // repository and would leave a partially provisioned user-owned vault.
  if (expectedGitHubId && String(identity.id) !== String(expectedGitHubId)) {
    throw new VaultGitHubError('github-account-mismatch', 403);
  }
  const installs = await call('/user/installations?per_page=100');
  const appId = Number(env.OGE_VAULT_GITHUB_APP_ID);
  const install = Array.isArray(installs.installations)
    ? installs.installations.find((i) => i.app_id === appId &&
        i.account?.id === identity.id && i.target_type === 'User')
    : null;
  if (!install || !Number.isSafeInteger(install.id)) {
    throw new VaultGitHubError('vault-app-installation-required', 409);
  }
  if (install.repository_selection !== 'all') {
    throw new VaultGitHubError('vault-all-repositories-installation-required', 409);
  }
  const repo = await call('/user/repos', { method: 'POST', body: {
    name: VAULT_REPO_NAME, private: true, auto_init: true, description: 'Private OgeNotes student notes vault',
    has_issues: false, has_projects: false, has_wiki: false,
  } });
  if (repo.name !== VAULT_REPO_NAME || repo.private !== true || repo.owner?.id !== identity.id ||
      !Number.isSafeInteger(repo.id) || repo.id < 1 || repo.owner?.login !== identity.login) {
    throw new VaultGitHubError('vault-privacy-verification-failed');
  }
  const jwt = githubAppJwt({ env });
  const installationToken = await vaultGithubRequest('/app/installations/' + install.id + '/access_tokens', {
    token: jwt, method: 'POST', fetcher,
    body: { repository_ids: [repo.id], permissions: { contents: 'write', metadata: 'read' } },
  });
  if (typeof installationToken.token !== 'string' || !installationToken.token) {
    throw new VaultGitHubError('vault-installation-token-unavailable');
  }
  const bounded = (path, opts = {}) => vaultGithubRequest(path, {
    token: installationToken.token, fetcher, ...opts,
  });
  const verified = await bounded('/repos/' + identity.login + '/' + VAULT_REPO_NAME);
  if (verified.id !== repo.id || verified.private !== true || verified.owner?.id !== identity.id) {
    throw new VaultGitHubError('vault-privacy-verification-failed');
  }
  const marker = JSON.stringify({ format: 'ogenotes-vault', version: 1, createdBy: 'OgeNotes' }, null, 2) + '\n';
  await bounded('/repos/' + identity.login + '/' + VAULT_REPO_NAME + '/contents/' + VAULT_MARKER_PATH, {
    method: 'PUT', body: { message: 'Initialize private OgeNotes vault', content: Buffer.from(marker).toString('base64') },
  });
  return {
    githubAccountId: String(identity.id), githubLogin: identity.login,
    repoId: repo.id, repoName: VAULT_REPO_NAME, installationId: install.id,
  };
}
