# Phase 5 operations: staging CSP, backup recovery and data lifecycle

**Status: procedure only — not evidence of a completed deployment test.**
Use isolated test users and a dedicated, non-production MongoDB database. Keep
access tokens, connection strings, backup archives and personal data out of Git,
PR descriptions and CI logs.

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

## Monitoring and alerts — pending service setup

Add provider-side metrics and alerts for 5xx and 429 trends, invalid sessions,
database capacity, snapshot failures and Google/Gemini/news/dictionary outages.
Monitor only sanitized counts, status classes and route templates: never raw
notes, query strings, cookies, bearer tokens, encrypted key blobs or backup
archives. Test the alert escalation and incident rollback path in staging.

## Verification log template

Keep a private record of environment, date, tester, revision SHA, each scenario
(pass/fail), evidence without credentials, defect links and final approver.
Passing unit tests alone is not completion evidence for the above tasks.
