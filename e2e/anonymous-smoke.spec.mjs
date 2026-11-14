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
