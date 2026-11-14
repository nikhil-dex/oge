# Phase 6 — Local browser smoke testing

**No Vercel deployment and no real Google or MongoDB credentials are required.**

This lightweight first browser milestone checks **anonymous-only** behavior:
registration, desktop/mobile layout, anonymous page/API redirects,
security headers, and the Google sign-in entry button. It does **not**
complete signed-in browser tests or cross-account data isolation.

## Run on your own computer

```bash
npm install
npx playwright install chromium
npm run test:browser
```

Tests start their own local Next.js development server at
`http://127.0.0.1:3100`. Do not configure real secrets for these tests:
the Playwright config injects synthetic sign-in settings and deliberately
avoids database operations. Test registration **without** clicking the
Google button; the real provider authentication flow is not mocked.

The CI browser job installs Chromium and runs desktop and Pixel 7 viewport
projects against this same local server. Browser evidence and traces are
ignored by Git; don't publish browser traces captured with real accounts.

## Evidence and limits

- Anonymous registration must show the main title and Google sign-in button.
- Anonymous visits to private UI routes must land on `/register`.
- Anonymous private API reads must never return HTTP 200.
- Public register responses must have baseline security headers and
  report-only CSP.
- Desktop and mobile registration must avoid horizontal page overflow.
- Real Google OAuth, two-account isolation, signed-in module navigation,
  account deletion, recovery, and full accessibility/performance testing
  still require their own controlled local or staging fixtures.
- The automated browser tests must **pass in CI** before marking this
  sub-milestone as verified.

## Deployment remains last

Continue other local testing and policy preparation before a protected
staging deployment. Staging is still required for actual Google OAuth,
replica-set recovery, monitor delivery and launch approval; passing these
anonymous tests is not public-release sign-off.
