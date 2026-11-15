import { test, expect } from '@playwright/test';

test('anonymous registration renders without OAuth or database access', async ({ page }) => {
  const response = await page.goto('/register');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: /keep what matters/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle(/OgeNotes/);
});

test('private pages redirect anonymous browsers back to registration', async ({ page }) => {
  for (const path of ['/', '/notes', '/settings', '/saved-links', '/airnotes']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  }
});

test('private APIs do not allow an anonymous successful response', async ({ request }) => {
  for (const path of ['/api/notes', '/api/subjects', '/api/backup', '/api/quick-notes']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308, 401, 403], path).toContain(response.status());
    if (response.status() >= 300 && response.status() < 400) {
      const location = new URL(response.headers()['location'], 'http://127.0.0.1:3100');
      expect(location.pathname).toBe('/register');
    }
  }
});

test('registration page emits baseline security headers without CSP enforcement', async ({ request }) => {
  const response = await request.get('/register');
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['content-security-policy-report-only']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toBeUndefined();
});

test('registration stays within viewport and avoids horizontal overflow', async ({ page }) => {
  await page.goto('/register');
  await page.evaluate(() => document.fonts.ready);
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport + 1);
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeInViewport();
});

// Inspect report-only CSP on an actual production build, without collecting
// document URLs, referrers, source code, or credential-bearing blocked URLs.
test('registration records sanitized report-only CSP compatibility signals', async ({ page }) => {
  await page.addInitScript(() => {
    window.__ogeCspDiagnostics = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      const blockedType = event.blockedURI === 'inline' ? 'inline'
        : event.blockedURI === 'eval' ? 'eval'
          : event.blockedURI === 'data' ? 'data' : 'other';
      window.__ogeCspDiagnostics.push({
        directive: event.effectiveDirective,
        disposition: event.disposition,
        blockedType,
      });
    });
  });
  await page.goto('/register');
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  const reports = await page.evaluate(() => window.__ogeCspDiagnostics || []);
  const summary = [...new Set(reports.map((report) =>
    report.directive + ':' + report.blockedType + ':' + report.disposition))].sort();
  // This is diagnostic telemetry; do not assert that violations must remain.
  console.log('[CSP diagnostic] ' + (summary.join(', ') || 'no violations observed'));
  expect(reports.every((report) => report.disposition === 'report')).toBe(true);
});

// Nonce prototype contract: a fresh report-only header must authorize every
// inline script on the production-rendered registration page.
test('registration inline scripts carry the response CSP nonce', async ({ page }) => {
  const response = await page.goto('/register');
  expect(response?.status()).toBe(200);
  const policy = response.headers()['content-security-policy-report-only'] || '';
  const nonce = policy.match(/'nonce-([A-Za-z0-9+/_=-]+)'/)?.[1];
  expect(nonce, 'response must include a CSP nonce').toBeTruthy();
  const scriptStats = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script:not([src])')];
    return { total: scripts.length, withoutNonce: scripts.filter((script) => !script.nonce).length,
      mismatched: scripts.filter((script) => script.nonce && script.nonce !== document.querySelector('script[nonce]')?.nonce).length };
  });
  console.log('[Nonce diagnostic] inline count=' + scriptStats.total + ', missing=' + scriptStats.withoutNonce + ', mismatch=' + scriptStats.mismatched);
  expect(scriptStats.withoutNonce).toBe(0);
  expect(scriptStats.mismatched).toBe(0);
});


test('separate registration responses use distinct nonces without enabling CSP enforcement', async ({ request }) => {
  const first = await request.get('/register');
  const second = await request.get('/register');
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  const getNonce = (response) => (response.headers()['content-security-policy-report-only'] || '')
    .match(/'nonce-([A-Za-z0-9+/_=-]+)'/)?.[1];
  expect(getNonce(first)).toBeTruthy();
  expect(getNonce(second)).toBeTruthy();
  expect(getNonce(first)).not.toBe(getNonce(second));
  expect(first.headers()['content-security-policy']).toBeUndefined();
  expect(second.headers()['content-security-policy']).toBeUndefined();
});
