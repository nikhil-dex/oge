# Oge Vault — Milestone #50: Two-device recovery acceptance

**Scope:** automated, fully synthetic GitHub commit/ref simulation combined
with a **real disposable local MongoDB replica set**. This is **NOT** live
signed GitHub/App OAuth acceptance and is **NOT** a production rollout.

## Reproducible automated checks

The isolated tests in `tests/mongodb-vault-two-device.test.js` use the
existing signed owner/session scope, real `users`, `subjects` and
`vault_drafts` collections, the actual account-level import and draft
fences, subject write fences, canonical archive import planner/executor and
the original-archive immutable-content proof engine. Only the remote
GitHub commit/ref/blob responses are synthetic.

1. **Device B autosaves first:** hold a real encrypted MongoDB draft writer
   in-flight while Device A starts an approved import of the same note ID.
   Import fails with 409 before GitHub writes. After B's writer finishes,
   A's fresh import planner detects the encrypted draft as a conflict and
   refuses to overwrite it. The ciphertext is preserved and the note body
   does not appear in the owner record.
2. **Device A imports first:** hold the GitHub batch writer after the
   durable `github-write-possible` marker. Device B attempts a new
   autosave while the import is in-flight and receives 409 without a
   MongoDB draft mutation. After A's verified success and exact lock
   release, B can store a fresh **encrypted** draft. No permanent MongoDB
   Notes content is produced by the import.
3. **GitHub response lost:** simulate a remote commit/ref update that
   persisted, then throw an ambiguous GitHub error. The original import
   retains the owner-row quarantine lock. A second device's autosave and
   import are both blocked. The original archive read-only content proof
   can confirm the historical imported note, but the lock remains in place
   and neither drafts nor GitHub files are rewritten.

The runner connects only to a local `localhost` or `127.0.0.1`
MongoDB replica set on port 27017, and only when
`OGE_ALLOW_MONGO_INTEGRATION_TESTS=YES_DISPOSABLE_DATABASE` is explicitly
set. It creates a random `oge_ci_multidevice_*` database and drops it
after each test. Never point `OGE_TEST_MONGODB_URI` at a real or
remote database.

From an isolated disposable test environment:

```sh
npm test -- tests/mongodb-vault-two-device.test.js
```

The GitHub Actions disposable MongoDB integration job runs the same tests
through the repository's test runner. Ordinary CI passing does not provide
live OAuth/installation security evidence.

## Live signed two-device staging acceptance — still blocked

The following **must** be verified on a separate private staging
deployment before enabling import or cutover flags:

- Two independent authenticated browser sessions to one test owner with a
  correctly scoped private GitHub App installation and actual GitHub repo
- Both same-subject and cross-subject autosaves during an approved import;
  no lost browser/sessionStorage drafts
- Subject deletion lock interaction, stale signed session after account
  re-creation, repository revocation and installation permission changes
- Real GitHub non-fast-forward/429/422 errors, lost HTTP acknowledgments,
  timeouts and concurrent external Git commits; never blind-write again
- Owner-approved source archive preserved privately and metadata-only +
  exact immutable content recovery evaluated without logging secrets
- Accessible desktop/mobile owner-facing conflict and recovery experience;
  no production unlock based on a proof of historical commit alone
- Confirm per-resource MongoDB and GitHub storage-path audits, encryption
  retention and no confirmed note content in MongoDB

Do not use production accounts or private user notes as fixtures. Use only
deliberate synthetic staging accounts. Keep
`OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW=false` and the other import
preview gates disabled in production.

**Release/merge gate:** this automated phase does not authorize enabling
import flags, merging PR #35, production lock release or migrating Note data.
