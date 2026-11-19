import { createPrivateKey } from 'node:crypto';
import { checkStagingConfiguration } from './staging-preflight.js';

/**
 * Read-only B7 staging configuration gate. It never creates a repo, issues an
 * installation token, connects to MongoDB, or returns any credential values.
 * A passing report is a prerequisite, NOT proof that real GitHub OAuth or
 * authenticated browser tests have succeeded.
 */
export function checkVaultStagingReadiness(env = {}) {
  const base = checkStagingConfiguration(env);
  const failures = [...base.failures];
  const warnings = [...base.warnings];
  const fail = (code, message) => failures.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  const value = (key) => typeof env[key] === 'string' ? env[key].trim() : '';
  const validSecret = (v, min = 16) => v.length >= min &&
    !/(?:placeholder|example|change.?me|dummy|ci-only|test.?only)/i.test(v);

  for (const key of ['OGE_VAULT_GITHUB_CLIENT_ID', 'OGE_VAULT_GITHUB_CLIENT_SECRET',
    'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET']) {
    if (!validSecret(value(key), key.endsWith('SECRET') ? 16 : 8))
      fail('vault-missing-' + key.toLowerCase().replaceAll('_', '-'),
        key + ' must use a separate non-placeholder staging credential.');
  }

  const appId = value('OGE_VAULT_GITHUB_APP_ID');
  if (!/^[1-9][0-9]{0,18}$/.test(appId))
    fail('vault-github-app-id', 'A valid dedicated GitHub App ID is required.');
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(value('OGE_VAULT_GITHUB_APP_SLUG')))
    fail('vault-github-app-slug', 'A valid staging GitHub App slug is required.');

  // Check the signing key without ever including any key material in reports.
  // The key must be parseable as an RSA private key for GitHub App JWTs.
  try {
    const encoded = value('OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64');
    if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded))
      throw new TypeError('Missing key');
    const key = createPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'));
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048)
      throw new TypeError('Invalid signing key');
  } catch {
    fail('vault-signing-key', 'A parseable 2048-bit-or-stronger staging GitHub App RSA key is required.');
  }

  if (!/^[a-fA-F0-9]{64}$/.test(value('OGE_VAULT_DRAFT_KEY')))
    fail('vault-draft-key', 'Use an independent 32-byte hex staging key for temporary AES-256-GCM drafts.');

  // The Vault App callback must point to the exact isolated staging origin.
  try {
    const site = new URL(value('OGE_STAGING_URL'));
    const vault = new URL(value('OGE_VAULT_BASE_URL'));
    if (vault.protocol !== 'https:' || vault.username || vault.password ||
        vault.pathname !== '/' || vault.search || vault.hash ||
        vault.origin !== site.origin)
      throw new TypeError('Wrong vault callback origin');
  } catch {
    fail('vault-callback-origin', 'OGE_VAULT_BASE_URL must equal the isolated HTTPS OGE_STAGING_URL origin.');
  }

  if (value('OGE_VAULT_MAIN_PREVIEW') !== 'true' ||
      value('OGE_VAULT_HYBRID_DRAFT_PREVIEW') !== 'true')
    fail('vault-preview-gates', 'Enable both Vault main and hybrid-draft preview flags only in isolated staging for this acceptance drill.');

  for (const key of ['OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL',
    'OGE_VAULT_SUBJECT_RETIRE_INTERNAL', 'OGE_ACCOUNT_DELETION_ENABLED']) {
    if (value(key) === 'true')
      fail('vault-destructive-flag', 'All Vault and account destructive flags must remain disabled during the Save drill.');
  }
  for (const key of ['NEXT_PUBLIC_OGE_VAULT_DRAFT_KEY',
    'NEXT_PUBLIC_OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64',
    'NEXT_PUBLIC_OGE_VAULT_GITHUB_CLIENT_SECRET',
    'NEXT_PUBLIC_AUTH_GITHUB_SECRET']) {
    if (value(key))
      fail('vault-public-secret', 'Never expose Vault or OAuth credentials through NEXT_PUBLIC_ variables.');
  }

  warn('vault-github-app-scope',
    'Manually verify GitHub App installation ownership, private repository permissions and disposable staging identities. Environment variables cannot prove provider-side isolation.');
  warn('vault-authenticated-checks-pending',
    'Passing configuration checks does not verify real OAuth, GitHub commits, multiple-device recovery or mobile browsers. Complete the B7 staging acceptance matrix separately.');

  return { ok: failures.length === 0, failures, warnings,
    evidence: 'configuration-only', liveProviderVerified: false,
    authenticatedBrowserVerified: false };
}
