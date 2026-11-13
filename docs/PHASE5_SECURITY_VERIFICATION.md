# Phase 5: Security and release verification

Status: **IN PROGRESS**. Passing CI is not approval for public launch.
This checklist complements [ROADMAP.md](../ROADMAP.md). Never commit real
credentials, exported user data, or incident logs containing personal data.

## Automated controls now present

- Security headers and report-only CSP, with a sanitized violation collector.
- Same-origin API mutation checks, except the bearer-authenticated extension save endpoint.
- Shared MongoDB fixed-window request limits for Gemini note cleanup (10/hour),
  browser extension saves (60/hour/token), backups (10 exports/hour/account,
  5 imports/hour/account). These are limited controls, **not full API-wide rate limiting**.
- CI node tests, Next.js build, high/critical production dependency audit,
  and a tracked-file credential-pattern check. Pattern matching is **not** an
  exhaustive history scan or substitute for purpose-built secret scanning.

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
