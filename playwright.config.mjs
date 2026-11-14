import { defineConfig, devices } from '@playwright/test';

// Local-only anonymous smoke tests; no Google OAuth, MongoDB or Vercel required.
// The server gets intentionally synthetic credentials and no production secrets.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100/register',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      AUTH_SECRET: 'oge-local-browser-smoke-synthetic-secret-value',
      AUTH_GOOGLE_ID: 'local-browser-test.apps.googleusercontent.com',
      AUTH_GOOGLE_SECRET: 'oge-local-browser-test-placeholder-google-secret',
      AUTH_TRUST_HOST: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
