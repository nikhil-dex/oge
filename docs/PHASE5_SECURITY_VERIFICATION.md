# Phase 5: Security and release verification

Status: **IN PROGRESS**. Passing CI is not approval for public launch.
This checklist complements [ROADMAP.md](../ROADMAP.md). Never commit real
credentials, exported user data, or incident logs containing personal data.

## Automated controls now present

- Security headers and default report-only CSP, with a sanitized violation collector.
  An explicit `OGE_ENFORCE_CSP=true` deployment flag switches to enforcement;
  it is **not enabled by default** and must be tested in staging before public use.
- Same-origin API mutation checks, except the bearer-authenticated extension save endpoint.
- Shared MongoDB fixed-window request limits for Gemini note cleanup (10/hour),
  browser extension saves (60/hour/token), extension token creation (10/hour/account),
  Gemini key management (12/hour/account), personalized news (30/minute/account),
  and backups (10 exports/hour/account, 5 imports/hour/account), plus dictionary lookups (40/minute/account). Notes, Subjects, Quick Notes, AirNotes and Saved Links mutations now share 120 requests/minute per account and resource. These are limited controls, **not full API-wide rate limiting**.
- Backup v1 exports and imports now preserve bounded note revision snapshots, revision ratings and due dates, including compatibility with older files without this metadata.
- Backup v1 exports and imports now include AirNotes (personalQuickNotes) with backwards compatibility for older v1 files lacking that field. Backup exports cap each collection at 5,000 records and return an explicit error instead of returning an unlimited number of records. Backup imports already enforce a request-body limit. Gemini-key actions are validated before contacting the provider, and untrusted provider error messages are not reflected.
- Subject listing is capped at 1,000 per user (and subject creation rejects the same per-account limit). CSP report logging is capped per process at 20 directives per minute; add shared edge/WAF limits for anonymous requests before launch.
- A staging-only two-account Notes, Subjects, Quick Notes, AirNotes, Saved Links, Revision, Revision History, and Backup export isolation smoke test is available at `scripts/verify-staging-isolation.mjs`.
- CI scans generated `.next/static` files and prerendered HTML/response assets for synthetic build-time secrets after Next.js build. The gate fails if any canary is found, but does not prove actual deployment secrets or runtime responses cannot leak.
- CI node tests, Next.js build, high/critical production dependency audit,
  plus a dedicated Git-history Gitleaks scan and tracked-file credential-pattern
  check. Gitleaks must pass CI; review any findings and rotate exposed secrets.
  Passing scans do not prove that no secret ever leaked.

For deployment procedures, see [Phase 5 Operations Runbook](PHASE5_OPERATIONS_RUNBOOK.md).

- A guarded **destructive** account deletion drill now exists at `scripts/verify-staging-account-deletion.mjs`; it checks two distinct sessions for the same disposable staging account and rejects nonempty workspaces. It is not executed by CI and must never be used with a real account or production-connected database.
- Account deletion route + Settings control now exist **behind** the default-off `OGE_ACCOUNT_DELETION_ENABLED` flag. It checks recent Google sign-in, uses transactional owner-scoped removal, and persistent JWT version validation; these controls have **not** passed live staging concurrency/rollback/security testing.

## Required deployment verification (unverified)

1. On an isolated staging environment, configure real Google OAuth credentials,
   Auth.js secret, MongoDB Atlas network policies, and least-privilege DB user.
   Verify Google login, logout, session expiry and reauthentication.
2. Exercise registered routes with two independent Google accounts: list, create,
   update, delete, search, revision/history, backup export/import, Gemini cleanup,
   saved links, and browser-extension token lifecycle. Confirm account B cannot
   read or mutate account A's records, even when given A's object identifiers.
3. Inspect CSP reports from real Chrome/Firefox sessions across sign-in,
   dashboard, editor, extension setup, news, and settings. Verify Google sign-in
   and client-side hydration still work with the intended *enforced* CSP before
   enabling enforcement. Do not claim CSP is enforced while report-only.
4. Exercise HTML/Markdown injection payloads and unsafe URL schemes; inspect
   rendered DOM and external-link behavior. Test CSRF requests with Origin,
   Referer, missing headers, and cross-site cookies.
5. Verify API limits, malformed and oversized bodies, pagination maximums,
   backup imports, external-service outage behavior, and stable error responses.
   Add rate limiting to all expensive paths and sensitive actions.
6. Run dedicated secret scanning against Git history and built assets; review
   package lock, dependency alerts and supply-chain changes. Rotate any
   credential accidentally disclosed. Confirm server secrets are absent from
   browser JavaScript and HTTP responses.
7. Configure sanitized structured logging, monitoring/alerts for 5xx rates,
   unusual 401/403/429 traffic, database capacity and third-party outages.
   Avoid collecting note content, tokens, cookies or exported data.
8. Configure Atlas backups with a documented retention and access policy;
   perform an isolated restore and verify record integrity and user ownership.
9. Publish privacy notice, data retention/export/deletion policy, account
   deletion workflow, and backup deletion/expiry procedure, with legal review.
10. Record test date, tester, environment, evidence, defects, mitigations,
    and approval in a private release log. Do not put user data in the log.

## Release blockers

- No measured cross-account isolation results.
- No browser-based CSP compatibility test and enforced CSP.
- No deployment-verified security of session configuration and OAuth flow.
- No tested backup restore or documented operational monitoring.
- No completed secret/history/build-artifact review, privacy/retention review.
- Remaining Phase 5 tasks in ROADMAP.md are not marked complete.

## Run the two-account staging isolation check

This script is **not run by CI**, because it needs two actual signed-in sessions.
Use only disposable **staging test accounts**, never production cookies or records.
Account A needs at least one pre-existing subject so temporary cleanup does not
violate the app's minimum-one-subject rule.

In your local terminal, set these environment variables without committing them:

```bash
export OGE_STAGING_URL="https://staging.example.com"
export OGE_STAGING_HOST="staging.example.com"
export OGE_STAGING_COOKIE_A="<cookie header from account A's staging session>"
export OGE_STAGING_COOKIE_B="<cookie header from account B's staging session>"
node scripts/verify-staging-isolation.mjs
unset OGE_STAGING_COOKIE_A OGE_STAGING_COOKIE_B
```

Replace the example hostname with the actual staging host. The script refuses
a host that does not include `staging` or `preview` (or localhost), verifies
the exact named host, creates temporary data only under account A, verifies
account B cannot view/update/delete it across the supported resources, and tries to clean it up. Verify no
temporary test subject remains. Record results privately without credentials.

This test covers **Notes, Subjects, Quick Notes, AirNotes, Saved Links, Revision, Revision History, and owner-scoped Backup export**.
The roadmap still requires runtime account isolation for backup import,
extension-token workflows, settings and other authenticated
modules, as well as browser session and OAuth testing.

## Non-destructive authentication and CSRF staging drill

The `scripts/verify-staging-auth-guards.mjs` script tests invalid/missing
sessions against private APIs, rejects cross-origin subject mutations, and
requires that the protected health check reject anonymous requests. It sends
only invalid subject creation payloads; it does not create real records.

Run **only** against a separate staging database with two disposable signed-in
accounts and the same private environment variables listed above:

```bash
node scripts/verify-staging-auth-guards.mjs
```

Ensure the accounts and endpoint configurations match the staging test
assumptions. The script is not executed in CI because it requires live
authenticated test sessions. It is **not** a substitute for full browser
OAuth, session expiration, concurrency, or account deletion testing.

## Mutation throttling verification

Use a disposable staging account to make repeated requests to each mutation endpoint. Expect HTTP 429 with `Retry-After` after 120 requests within one minute for the same account/resource. Verify a second account is unaffected and that normal notes autosave works. The rate limiting unit tests and source-coverage checks are not substitutes for runtime concurrency testing. Do not flood a production server.
