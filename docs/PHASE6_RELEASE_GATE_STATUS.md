# Phase 6 — release gate status and handoff (2026-11-15)

This document separates **verified automation** from **unverified real-environment requirements**. It is not a production approval.

## Project isolation

- Active repository: `nikhil-dex/oge`.
- Reference application: `nikhil-dex/ogenotes`, strictly read-only.
- Separate Vercel project created for this repository: `oge-staging` (not deployed).
- Its Vercel Authentication setting protects all deployment targets; automatic preview deployments were disabled.
- Node.js version set to 22.x.
- Safe rollout environment defaults configured for preview and production targets on **oge-staging only**:
  `OGE_ENFORCE_CSP=false` and `OGE_ACCOUNT_DELETION_ENABLED=false`.
- The existing `ogenotes` Vercel project and its domain are **not** staging for `oge`.

## Automated evidence: complete

- Phase 6 PRs #17–#24 were merged into `main`.
- Latest verified post-merge GitHub Actions run for #24: [43703003032](https://github.com/nikhil-dex/oge/actions/runs/43703003032), success.
- CI includes application validation, Chromium anonymous desktop/mobile browser smoke tests, disposable MongoDB replica-set integration, and secret scans.
- CSP nonce generation and spoofing regression checks passed on synthetic local production-mode runs.
- `scripts/verify-staging-authenticated-pages.mjs` checks real authenticated HTML response nonces and disallows explicit `public` or `s-maxage` caching directives. Its fake-session local tests are passing.
- Automated checks do **not** substitute for live staging credentials, real OAuth flow, CDN behavior or backup restore.

## Live verification: blocked / not executed

| Gate | Status | Required evidence |
| --- | --- | --- |
| Isolated Google OAuth client and 2 disposable users | NOT CONFIGURED | callback, login/logout and session expiry |
| Independent MongoDB Atlas staging replica set | NOT CONFIGURED | secure connection, transaction and recovery drills |
| Deploy `oge` to protected `oge-staging` | NOT DEPLOYED | origin, private access and successful deployment |
| HTTP / browser smoke in staging | NOT RUN | `staging:http`, Chrome/Firefox desktop/mobile |
| Authenticated nonce and caching verification | NOT RUN | 2 valid sessions; real CDN headers and behavior |
| Cross-account privacy and CSRF | NOT RUN | owner-scope and denied cross-user actions |
| Backup recovery and destructive account drill | NOT RUN | isolated restoration, rollback, deletion review |
| Provider failures, extension flow and monitoring | NOT RUN | recovery and alert evidence |
| Privacy, retention, support, rollback and approval | NOT SIGNED OFF | documented release owner approval |

## Resume safely

1. Configure a **separate** staging OAuth client and test users, isolated transactional MongoDB database and hosting secrets **privately**. Never copy credentials from `ogenotes`.
2. Set the exact staging hostname and OAuth redirect. Verify Vercel deployment protection does not break the OAuth callback; configure a safe testing route if required, without making staging public.
3. Run `npm ci && npm run staging:preflight` from a private shell. Do not paste credentials into GitHub or chat.
4. Deploy only to the separate, protected `oge-staging` project.
5. Run `npm run staging:http` and the staging checks in `scripts/verify-staging-auth-guards.mjs`, `scripts/verify-staging-authenticated-pages.mjs`, `scripts/verify-staging-isolation.mjs`. Use two disposable users, preserving test cleanup.
6. Verify real Chrome/Firefox OAuth, signed-in client navigation, CDN caching, backups and restoration, monitoring, API failure paths, extension auth and privacy policy.
7. Keep CSP report-only and deletion disabled until their *dedicated* isolated staging drills pass. Sign off security and operational release gates before any public launch.

## Guardrails

- `oge-staging` existing project creation is **not** evidence that a staging app is running.
- No real OAuth secrets, session cookies or MongoDB URIs should enter CI logs, PR comments or documentation.
- Never execute destructive drills on production or personal accounts.
- A CI pass or a green anonymous browser suite does not authorize public release.

Related: [Phase 6 private staging](PHASE6_PRIVATE_STAGING.md), [Phase 5 security verification](PHASE5_SECURITY_VERIFICATION.md), [roadmap](../ROADMAP.md).
