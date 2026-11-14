/**
 * Phase 6 private-staging configuration checks. This pure function never logs,
 * returns, serializes or persists secret values. It is intentionally a
 * pre-deployment guard, not a substitute for provider-side isolation review.
 */
export function checkStagingConfiguration(env) {
  const failures = [];
  const warnings = [];
  const fail = (code, message) => failures.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  const value = (name) => typeof env[name] === 'string' ? env[name].trim() : '';

  const rawUrl = value('OGE_STAGING_URL');
  let site;
  try {
    site = new URL(rawUrl);
    if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' ||
        site.search || site.hash || site.port || !/(?:^|[.-])(staging|preview)(?:[.-]|$)/i.test(site.hostname)) {
      throw new Error('Not an isolated HTTPS staging origin');
    }
  } catch {
    fail('staging-url', 'OGE_STAGING_URL must be a plain HTTPS staging/preview origin with no credentials, path or query.');
  }

  const authUrl = value('AUTH_URL');
  let authOrigin;
  try {
    const parsed = new URL(authUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid URL');
    authOrigin = parsed.origin;
  } catch {
    fail('auth-url', 'AUTH_URL must be the plain HTTPS origin of the staging deployment.');
  }
  if (site && authOrigin && authOrigin !== site.origin) {
    fail('auth-origin-mismatch', 'AUTH_URL must match OGE_STAGING_URL exactly.');
  }

  const dbName = value('MONGODB_DB');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(dbName) || !/(?:staging|preview|test)/i.test(dbName)) {
    fail('staging-database-name', 'MONGODB_DB must explicitly name a staging/preview/test database.');
  }
  if (dbName === 'oge_notes') fail('default-database', 'Do not use the production/default oge_notes database.');
  const uri = value('MONGODB_URI');
  try {
    const parsed = new URL(uri);
    const secureSrv = parsed.protocol === 'mongodb+srv:' && parsed.hostname &&
      !/(?:localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    const secureSeed = parsed.protocol === 'mongodb:' && parsed.hostname &&
      parsed.searchParams.get('tls') === 'true' && parsed.searchParams.get('replicaSet');
    if (!secureSrv && !secureSeed) throw new Error('Insecure MongoDB configuration');
    if (/localhost|127\.0\.0\.1|\.local$/.test(parsed.hostname)) throw new Error('Local MongoDB');
  } catch {
    fail('staging-mongodb-uri', 'MONGODB_URI must use a secure replica-set/Atlas connection, not a local or standalone server.');
  }

  for (const key of ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'AUTH_SECRET']) {
    const candidate = value(key);
    if (!candidate || /(?:placeholder|example|change.?me|your.?secret|dummy|ci-only)/i.test(candidate)) {
      fail('missing-' + key.toLowerCase().replaceAll('_', '-'), key + ' must be configured with a staging-only non-placeholder value.');
    }
  }
  if (value('AUTH_SECRET').length < 32) fail('short-auth-secret', 'AUTH_SECRET must be at least 32 characters.');
  if (value('AUTH_GOOGLE_SECRET').length < 16) fail('short-google-secret', 'AUTH_GOOGLE_SECRET is missing or too short.');
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(value('AUTH_GOOGLE_ID'))) {
    fail('google-client-id', 'AUTH_GOOGLE_ID must be a Google web OAuth client ID.');
  }

  const healthToken = value('OGE_HEALTHCHECK_TOKEN');
  if (healthToken.length < 32 || /(?:placeholder|example|change.?me|dummy|ci-only)/i.test(healthToken)) {
    fail('health-token', 'OGE_HEALTHCHECK_TOKEN must be a staging-only unpredictable token of at least 32 characters.');
  }

  if (value('OGE_ACCOUNT_DELETION_ENABLED') === 'true') {
    fail('account-deletion', 'Keep account deletion disabled in initial staging; enable only for an explicitly approved disposable-account drill.');
  }
  if (value('OGE_ENFORCE_CSP') === 'true') {
    fail('csp-enforcement', 'Begin staging with CSP report-only; enable enforcement only during the dedicated browser compatibility drill.');
  }
  if (value('NEXT_PUBLIC_MONGODB_URI') || value('NEXT_PUBLIC_AUTH_SECRET') || value('NEXT_PUBLIC_AUTH_GOOGLE_SECRET')) {
    fail('public-secrets', 'Never define server secrets with NEXT_PUBLIC_ prefixes.');
  }
  if (value('GEMINI_KEY_ENCRYPTION_SECRET') && value('GEMINI_KEY_ENCRYPTION_SECRET').length < 32) {
    fail('gemini-encryption-secret', 'If configured, GEMINI_KEY_ENCRYPTION_SECRET must be at least 32 characters.');
  }
  if (!value('GEMINI_KEY_ENCRYPTION_SECRET')) {
    warn('gemini-disabled', 'Gemini BYOK needs a separate stable staging encryption secret before testing that feature.');
  }
  if (value('NODE_ENV') && value('NODE_ENV') !== 'production') {
    warn('node-env', 'A deployed Next.js staging build normally runs with NODE_ENV=production.');
  }
  warn('manual-isolation', 'Manually verify separate Google OAuth client, MongoDB project/user/network rules and independent staging secrets; this cannot be proven from environment variables alone.');
  warn('private-access', 'Restrict staging access to invited testers and verify deployment protection before sharing its URL.');
  return { ok: failures.length === 0, failures, warnings };
}
