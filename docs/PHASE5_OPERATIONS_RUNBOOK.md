# Phase 5 operations: staging CSP, backup recovery and data lifecycle

**Status: procedure only — not evidence of a completed deployment test.**
Use isolated test users and a dedicated, non-production MongoDB database. Keep
access tokens, connection strings, backup archives and personal data out of Git,
PR descriptions and CI logs.

## Staging auth and CSRF drill

A non-destructive script at `scripts/verify-staging-auth-guards.mjs` verifies
that private API reads refuse missing or invalid sessions, cross-origin
mutations are rejected, and the health endpoint requires its monitor token.
It uses two distinct, disposable authenticated staging sessions, issues only
invalid mutation payloads, and never exports note content. See
`PHASE5_SECURITY_VERIFICATION.md` for the environment setup.

**This test has not been run in staging.** It does not prove race-free account
deletion, production OAuth configuration, or full multi-device logout.

## CSP enforcement rollout

OgeNotes sends `Content-Security-Policy-Report-Only` by default.
To opt a deployment into enforcing the same policy, set
`OGE_ENFORCE_CSP=true` in that deployment's environment **before its build**
and redeploy. Set `OGE_ENFORCE_CSP=false` (or remove the variable) and redeploy
to revert to report-only. Do not switch this on for public traffic before
verifying the current policy: it may block inline scripts/styles or external
resources that Next.js and Google sign-in need.

1. Deploy to a private staging URL with separate OAuth, database, and secret values.
2. Open browser DevTools and confirm the response header changes from
   `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
3. Test sign-in, sign-out, registration, navigation, note editing/preview,
   dashboard hydration, appearance controls, extension setup, news and
   dictionary in Chrome and Firefox. Test a hard refresh and a new session.
4. Review CSP reports for blocked directives; collector intentionally excludes
   URL and code data from logs. Document necessary, narrowly scoped sources
   before tightening broad `https:` policies. Prefer nonce/hash-based Next.js
   integration for scripts rather than `unsafe-inline`.
5. Only enable enforcement in production after a full successful staging
   verification, a documented rollback, and a release-owner approval.

## JSON backup import atomicity

The app's JSON backup import uses a MongoDB transaction spanning Subjects,
Notes, Saved Links, Quick Notes, AirNotes and account preferences. It is an
all-or-nothing operation: errors trigger rollback instead of leaving a
partially restored workspace. A missing or concurrently deleted account also
prevents commit.

**Operational requirement:** MongoDB must be deployed as an Atlas cluster or
replica set with transaction support. A standalone MongoDB instance cannot
complete imports. This behavior is intentional; do not bypass it by retrying
writes outside the transaction. Test importing both valid and deliberately
conflicting backups into **disposable staging accounts**. Force a failure
after the first successful collection insert and verify the entire import
rolls back. Also test a concurrent account deletion while importing and
confirm no orphaned owner documents remain.

JSON import atomicity does not replace an isolated snapshot restoration drill.

## MongoDB Atlas backup and restore drill

Application JSON exports are **not** substitutes for database-level backups,
and current application backup export intentionally caps records. Before public
registration, configure Atlas backups or an approved scheduled encrypted
snapshot strategy for the chosen cluster tier. Review recovery point objective
(RPO), recovery time objective (RTO), retention, costs, geographic residency,
and who can read restore artifacts.

1. Confirm backups are scheduled and retained as documented, and create a
   non-production restore target **not** connected to the production app.
2. Restore a snapshot to that isolated target. Never overwrite production.
3. Connect with a least-privilege test account. Verify subjects, notes,
   savedLinks, quickNotes, personalQuickNotes, users, revision data and indexes.
4. Check every sample document's ownerId/user linkage. Ensure hashed extension
   tokens and encrypted Gemini-key blobs have not been logged or exported to
   insecure locations. Do not reuse restored tokens or secrets on a public host.
5. Record elapsed restore time, snapshot age, counts, errors, retention dates
   and approval privately. Remove/secure the isolated restore when complete.
6. Repeat after changes to backup schedules, database topology or schema.

## User data lifecycle and deletion — staging verification pending

The JSON export endpoint currently exports Subjects, Notes, Saved Links, Quick
Notes, AirNotes, news interests, and bounded note revision snapshots/review
schedules. It does **not** guarantee export of all account preferences or
provider-related state. Do not advertise it as an exhaustive data portability
export until those omissions are resolved.

A feature-flagged account-deletion endpoint and Settings control are now
implemented behind `OGE_ACCOUNT_DELETION_ENABLED=true`, **disabled by
default**. When enabled, it requires a Google sign-in within five minutes,
two user confirmations, same-origin mutation protection, rate limiting,
MongoDB transactions and owner-scoped deletion. Removing the user record
invalidates other browser JWTs because every session checks the persisted
account version; new sign-ins are issued a different account session version.

**Do not enable this flag on public production yet.** Run staging tests using
disposable accounts on an Atlas replica set. Verify transaction rollback under
a forced failure, duplicate concurrent attempts, requests in flight while
deletion happens, existing sessions on two devices, extension tokens and
recreation after a fresh Google sign-in. Document the data-retention policy
and backup treatment before allowing production deletion.

### Disposable staging deletion drill

A destructive check is available at `scripts/verify-staging-account-deletion.mjs`.
It **permanently deletes the disposable test account**, so never use your actual
Google identity or a staging deployment pointed at production data. The staging
database must support MongoDB transactions and contain no valuable test data.
The script refuses accounts with existing notes, links, Quick Notes, AirNotes
or more than one preexisting default subject. It also requires two distinct
browser sessions belonging to **the same disposable account**.

Enable `OGE_ACCOUNT_DELETION_ENABLED=true` **only on isolated staging** and
deploy. Sign in on two independent browser profiles using the same throwaway
Google identity; the first cookie must be from a fresh Google sign-in within
five minutes. Pass the values as private shell environment variables (never
commit them, paste them into an issue, or store them in workflow logs):

```bash
export OGE_STAGING_URL='https://your-staging.example'
export OGE_STAGING_HOST='your-staging.example'
export OGE_STAGING_COOKIE_A='<first authenticated staging Cookie header>'
export OGE_STAGING_COOKIE_B='<second authenticated staging Cookie header>'
export OGE_STAGING_DELETION_CONFIRM='DELETE DISPOSABLE STAGING ACCOUNT'
node scripts/verify-staging-account-deletion.mjs
unset OGE_STAGING_COOKIE_A OGE_STAGING_COOKIE_B OGE_STAGING_DELETION_CONFIRM
```

The drill creates one temporary subject, confirms the two cookies belong to
the same account, deletes the account, and checks neither browser session can
still list private subjects. If the drill fails, inspect and clean up staging
manually. A passing result is **not** full deletion sign-off: also verify
rollback on forced database failure, no orphaned records, extension token
rejection, in-flight writes, account recreation, and backup retention.

Before enabling a permanent deletion flow, finish these release gates:

- Verify the recently implemented Google-login window, explicit confirmation,
  proxy same-origin protections and database transaction in a real browser.
- Verify existing JWTs and extension tokens become unusable on **all** devices
  immediately after the user record is deleted and again after re-registration.
- Verify all known owner-scoped collections, user profile, revisions, preferences
  and encrypted provider keys are removed; audit any new collection added later.
- Test rollback and idempotence for failures, plus concurrent requests or
  account recreation; production rollout remains blocked until this passes.
- Document backup retention and natural expiry for deleted records. A backup
  restoration must not silently resurrect data from deleted accounts.
- Publish the privacy notice, retention periods, support route and handling of
  deletion requests. Obtain legal and operational review as applicable.

## Monitoring and alerts — integration pending

An authenticated readiness endpoint exists at `GET /api/health`. It checks
MongoDB connectivity using a ping and returns only a generic status (HTTP
200 `ok`, HTTP 503 `unavailable`, or HTTP 401 `unauthorized`).
The endpoint does not use the browser session or expose DB details.

To enable monitoring, generate a random high-entropy value of at least 32
characters, store it as the **server-only** environment variable
`OGE_HEALTHCHECK_TOKEN` and configure an HTTPS uptime monitor to send
`Authorization: Bearer <your monitoring token>` as a request header.
Never store this credential in a URL, client environment variable, source
code, workflow logs, or public status-page configuration. A missing or
short secret causes every request to return HTTP 401.

Configure alerts on HTTP 5xx and failed requests with a reasonable interval;
ensure the uptime provider supports private request headers and does not
record them in diagnostics. Rotate this token if exposed. This HTTP endpoint
tests app/database readiness, not the completion of a backup snapshot,
OAuth login, the news provider, or all account operations.

**Still required:** connect a real monitor, choose alert recipients/escalation,
test notification delivery, track abnormal 429s and database capacity,
and verify Atlas backup-failure and upstream provider alerts. Do not treat
the existence of this endpoint as a monitoring setup completion.



Add provider-side metrics and alerts for 5xx and 429 trends, invalid sessions,
database capacity, snapshot failures and Google/Gemini/news/dictionary outages.
Monitor only sanitized counts, status classes and route templates: never raw
notes, query strings, cookies, bearer tokens, encrypted key blobs or backup
archives. Test the alert escalation and incident rollback path in staging.

## Browser asset / secret leak verification

CI injects synthetic (non-credential) canary values into selected server-only
environment settings during `next build`, then runs
`node scripts/verify-client-artifacts.mjs`. The scanner checks emitted
browser files and prerendered HTML/response artifacts. It prints only paths to
affected files and never prints secret values. Its tests include deliberate
leaks to verify that detection works.

Passing this gate is **not** proof that real deployment secrets are safe.
Before launch, inspect deployed JavaScript bundles, publicly reachable build
artifacts, rendered HTML, network responses and runtime logs using *dummy*
secrets on an isolated staging environment. Never insert real tokens into
frontend bundles merely to test them. A server-only build chunk may contain
server variables legitimately, so do not treat scanning only server chunks as
a client leak test. Public source maps must also be reviewed.

## Verification log template

Keep a private record of environment, date, tester, revision SHA, each scenario
(pass/fail), evidence without credentials, defect links and final approver.
Passing unit tests alone is not completion evidence for the above tasks.
