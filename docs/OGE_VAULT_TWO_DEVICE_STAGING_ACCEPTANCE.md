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

## Milestone #51 — Cross-subject and revoked-session rehearsal

The same disposable MongoDB + synthetic GitHub provider runner now checks
four more security cases beyond Milestone #50:

- An in-flight encrypted draft belonging to **subject B** uses the same
  note UUID as a planned import into **subject A**. The account-wide fence
  blocks the import while the draft writes; fresh import conflict planning
  rejects the existing draft even though its subject differs.
- An active approved import of a note in **subject A** blocks a second
  device from creating a draft in unrelated **subject B**. Once GitHub
  confirmation releases the fence, normal encrypted drafts can resume.
- A Vault GitHub installation changes **after** the durable
  `github-write-possible` marker but **before** the remote batch writer.
  The import executor re-verifies owner/repo mapping and **never invokes
  the GitHub writer**. The durable owner quarantine remains for audited
  investigation rather than blindly unlocking.
- An account session incarnation changes at the same boundary. The
  stale session cannot publish GitHub content or release the original lock.
  The lock is not a claim that a write occurred; it is a conservative
  barrier until the uncertain state is reviewed.

These are deterministic tests; they do **not** replace real OAuth
revocation and browser session tests. The unavoidable distributed
time-of-check/time-of-use gap between MongoDB, GitHub App authorization
and GitHub ref writes remains subject to live acceptance.

### Import-specific read-only staging preflight

`npm run vault:import:staging-preflight` builds on the existing Vault B7
configuration inspection. It verifies the isolated staging origin, private
RSA signing key shape, temporary encrypted draft key, and all required
**staging-only** flags: `OGE_VAULT_MAIN_PREVIEW`,
`OGE_VAULT_HYBRID_DRAFT_PREVIEW`,
`OGE_VAULT_NOTE_API_PREVIEW`,
`OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW`, and
`OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW`. For this isolated
synthetic-only rehearsal, explicitly set
`OGE_VAULT_IMPORT_STAGING_ACK=ISOLATED_SYNTHETIC_ACCOUNTS_ONLY`.
All destructive/account-deletion and manual lock-release controls must
remain disabled. Do **not** enable these preview flags on production.

This command only reads in-memory configuration and outputs redacted
pass/fail reason codes. It never connects to MongoDB or GitHub, changes
flags, inspects real users, provisions credentials or grants production
authorization. A PASS is strictly **configuration-only**:
`liveProviderVerified=false`,
`authenticatedBrowserVerified=false`,
`twoDeviceSignedAcceptanceComplete=false`, and
`productionImportAuthorized=false`.
No actual isolated-staging credentials, GitHub installation or two
signed browser identities have been verified by the command.

**Open live acceptance:** two separate authenticated browser devices,
actual disposable private GitHub App installation, real 429/409/422 and
late-revocation behavior, sessionStorage recovery on mobile, subject
deletion and save concurrency, operator-reviewed quarantine recovery.

## Milestone #52 — Real batch writer, simulated GitHub provider error matrix

The separate `tests/mongodb-vault-github-fault-matrix.test.js` runner
exercises the actual `commitVaultNoteBatch` Git object/ref writer, not an
injected success stub. It combines exact owner-scoped MongoDB fencing and
the create-only approval with a deterministic synthetic GitHub object
store. Fault cases now cover 429 before marking, 429 during Git tree
creation, non-fast-forward 422 from a competing writer, a 503/422 response
lost **after** a successful Git ref update, and 429 during final HEAD
or imported-note verification.

Verified remote commits are accepted once after exact HEAD, ancestry and
content checks; unknown outcomes retain owner quarantine and are eligible
only for a separate read-only historical proof, never automatic replay.
Tests verify one Git ref PATCH per attempt, preserve external edits and do
not store permanent note bodies in MongoDB.

See `docs/OGE_VAULT_GITHUB_FAILURE_ACCEPTANCE.md` for the complete
failure matrix. **Live two-device staging remains outstanding:** real
GitHub API rate limits, OAuth permissions, provider races, mobile
sessionStorage recovery and independent signed operator signoff have
not been executed by these synthetic tests.


## Milestone #67 — Review-only external two-device acceptance evidence matrix

The private offline tool `npm run vault:staging:two-device-evidence`
validates a **redacted evidence index**, not the actual GitHub/App, OAuth,
screenshots, secure browser or physical devices. This is deliberately
NON-RELEASE-AUTHORIZING: even a complete manifest CANNOT sign off live
acceptance, enable restore or production, retry a GitHub write, release
an uncertain owner quarantine or merge PR #35. It cannot independently
authenticate the underlying external evidence files, signatures or GitHub
provider. A separate qualified operator must inspect genuine
contemporaneous evidence and attest actual physical-device separation.

The matrix requires all of these distinct observed scenarios (each with
its **own** independently retained evidence artifact and SHA-256):

1. `oauth-device-a`: real signed OAuth browser session on physical device A.
2. `oauth-device-b`: a separately signed session on physical device B.
3. `private-app-installation-read`: actual owned, private GitHub App installation mapping and GET-only read.
4. `read-only-app-write-denial`: scoped read-only token provably cannot write.
5. `create-only-git-cas`: explicitly authorized ONE disposable 1–12-note create-only CAS, matching remote tree and content.
6. `stale-git-head-409-422`: real competing-head rejection and no blind replay.
7. `provider-rate-limit-429`: observed real rate-limit/no dangerous retry.
8. `installation-revocation-403`: real revoked/permission-denied behavior.
9. `lost-write-response-quarantine`: verified ambiguous outcome remains fenced; no unsafe resend or manual unlock.
10. `second-device-autosave-fence`: actual second-device encrypted draft remains safe during the owner import lock.
11. `encrypted-backup-reopen`: password-protected file reopened and M63/M57 review passes from saved encrypted files on trusted device.
12. `physical-file-download-check`: actual file sequence saved by browser, not just validated server responses.

**Important:** never deliberately introduce destructive/uncertain writes
in a production Vault. Exercise provider faults only in independently
approved and isolated disposable staging environments with an explicit
preplanned quarantine/reconciliation procedure. Real 429/network timeout
reproduction can depend on external conditions; fabricated status codes
or synthetic CI mocks do not qualify as actual provider observations.

Create a `0700` private directory and a `0600` UTF-8 JSON file (at
most 32 KiB) containing exactly these top-level keys:
`format`, `version`, `runId`, `origin`, `startedAt`, `records`.
Format is `oge-vault-two-device-external-evidence`, version 1.
`runId` must be a fresh UUID. `origin` is the precise isolated
HTTPS staging origin. `startedAt` must be a millisecond UTC ISO
timestamp within 7 days of review. Each record has exactly
`scenario`, `channel`, `observedAt`, `outcome`,
`evidenceSha256` and `sessionMarker`.

- `channel` is `device-a`, `device-b` or `operator` as the matrix dictates.
- `outcome` is only `observed-pass` or `observed-fail`; an observed failure blocks completion.
- `evidenceSha256` is a distinct 64-lowercase-hex reference to a privately retained redacted external artifact; **the CLI never opens that artifact or verifies its hash**. An independent reviewer must hash the original artifact and confirm it came from actual staging.
- `sessionMarker` is the same randomly generated UUID for each record of one browser session, different between A and B. It is NOT an Auth.js token, cookie, device fingerprint, account ID or physical-device attestation. Operator records use `null`.
- `observedAt` is the original millisecond UTC observation timestamp, no earlier than `startedAt` and never future-dated beyond five minutes.

Set only the review variables on a trusted isolated operator host:

```sh
export OGE_STAGING_URL=https://staging.example.org
export MONGODB_DB=oge_vault_restore_staging_disposable
export OGE_VAULT_TWO_DEVICE_EVIDENCE_REVIEW=YES_REDACTED_EXTERNAL_EVIDENCE_ONLY
export OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE=/private/0700-directory/redacted-evidence.json
npm run vault:staging:two-device-evidence
```

The tool uses no MongoDB URI or GitHub credentials and makes NO network
requests. Exit code 1 means configuration denied before any file read,
2 means invalid/unsafe metadata or file, 3 means incomplete/failed
referenced scenarios, and **0 means only that the untrusted index is
ready for independent human examination**, not live signed acceptance.

For clarity, a full 12-row manifest may contain fabricated values;
its completeness is NOT provider proof. Never include note text,
GitHub SHA/repository IDs, provider tokens, passwords, Auth.js session
cookies, real owner identities or screenshots in the JSON manifest.
Retain any independently redacted genuine evidence separately under
approved restrictive access and retention policies.

**Unfinished live blockers:** real two-physical-device OAuth/App staging,
independent immutable evidence validation and operator signoff, browser
download permissions, real GitHub fault observations and scoped
permissions, detached offline provenance after repo loss, security
audit, complete multi-resource export and production release.
