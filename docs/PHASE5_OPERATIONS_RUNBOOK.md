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

## User data lifecycle and deletion design — pending implementation

The JSON export endpoint currently exports Subjects, Notes, Saved Links, Quick
Notes, AirNotes, news interests, and bounded note revision snapshots/review
schedules. It does **not** guarantee export of all account preferences or
provider-related state. Do not advertise it as an exhaustive data portability
export until those omissions are resolved.

Account deletion is **not yet implemented**. Before implementing a permanent
deletion flow, design and test all of the following together:

- Require recent Google reauthentication, explicit user confirmation and
  anti-CSRF checks before irreversible deletion.
- Revoke browser-extension tokens and invalidate **all** existing JWT sessions
  across browsers and devices, not just sign out the current tab.
- Remove all owner-scoped records, user profile, preferences, revisions and
  encrypted provider keys; verify that deleting the Google login identity
  alone does not leave accessible orphaned data.
- Define transactional/idempotent behavior for database failure partway
  through deletion and protect against concurrent account recreation.
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
