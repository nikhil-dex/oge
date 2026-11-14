# Phase 6 — Private staging deployment checklist

**Status: preflight tooling implemented; no staging environment has been provisioned or tested.**

Phase 6 is a release-validation phase, **not a new feature-development phase**.
Do not open public registration or treat passing CI as deployment approval.
Keep Phase 5's account-deletion flag disabled and CSP in report-only mode
until their dedicated staging drills are signed off.

## 1. Provision a private, isolated deployment

1. Create a staging/preview deployment on the chosen hosting provider;
   protect it with tester-only access. Confirm the protection does not
   break Google OAuth callbacks for invited test users.
2. Create a dedicated Google OAuth **web application** client and allow only
   the exact staging callback:
   `https://staging.YOUR_DOMAIN/api/auth/callback/google`.
   Keep its consent screen in testing mode with invited test users.
3. Create a separate MongoDB Atlas staging cluster/project or equivalent
   **transaction-capable isolated database** with its own restricted DB user
   and network rules. Never reuse the production database user or production
   database name. Confirm backup and restore behavior separately.
4. Provide staging-only, server-side environment variables through the
   hosting secret manager. Do not commit `.env.local`, cookies or URI values.
   For the first staging rollout, configure:

   - `OGE_STAGING_URL`: exact public HTTPS staging origin
   - `AUTH_URL`: the **same** HTTPS origin (for Auth.js callback generation)
   - `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`: staging OAuth client
   - `AUTH_SECRET`: independent random value, at least 32 characters
   - `MONGODB_URI`: separate Atlas/secure replica-set URI
   - `MONGODB_DB`: explicit nonproduction name such as `oge_notes_staging`
   - `OGE_HEALTHCHECK_TOKEN`: independent secret token, at least 32 characters
   - `GEMINI_KEY_ENCRYPTION_SECRET`: optional for initial staging; required to test BYOK
   - `OGE_ACCOUNT_DELETION_ENABLED=false`
   - `OGE_ENFORCE_CSP=false`

## 2. Run the read-only preflight

Configure variables in the staging deployment shell (or a private local
environment using **staging credentials only**) and run:

```bash
npm ci
npm run staging:preflight
```

The command performs **local static environment validation only**. It does
not connect to MongoDB, call Google, deploy an app, or print any secret value.
A nonzero exit code blocks staging rollout until the failures are fixed.

The preflight intentionally requires a staging/preview hostname, matching
`AUTH_URL`, an explicitly nonproduction DB name, a TLS-enabled MongoDB
replica-set connection, non-placeholder secrets, and conservative rollout
flags. A passing result cannot prove the staging credentials are distinct
from production; review isolation manually.

## 3. Live private smoke tests (not yet run)

- Verify login, logout, session expiration, account switching, and direct
  HTTP access denial for invalid browser sessions.
- Verify dashboard/Notes/AirNotes/Quick Notes/Saved Links and revision
  history in Chrome and Firefox, including desktop/mobile viewport sizes.
- Create two **disposable** Google test accounts with different identities.
  Run `scripts/verify-staging-auth-guards.mjs` and
  `scripts/verify-staging-isolation.mjs` with their two session cookies,
  carefully following `docs/PHASE5_SECURITY_VERIFICATION.md`.
- Test the extension-token flow and news/dictionary outage handling.
- Export/import a backup for disposable test records; separately restore
  an Atlas snapshot into an isolated recovery target, **never production**.
- Validate actual CSP report-only headers, review browser reports, and
  perform a controlled separate CSP-enforcement drill before switching flags.
- Connect a private health-check monitor using the server-only bearer token,
  test alert delivery, and verify Atlas backup/capacity alerts.
- Publish and approve accurate privacy, terms, contact/support, retention,
  deletion and backup expiry information before enabling public access.

## 4. Release decision

Keep a private verification record of environment, test date, tester, failure
details (without credentials/data), recovery evidence, and approval. Any
critical/high unresolved vulnerability or unverified backup recovery keeps
public release blocked. Phase 5 deployment checks remain mandatory even
though the Phase 5 code was merged into `main`.

**This document is a deployment plan, not proof that staging or recovery has
already been successfully exercised.**
