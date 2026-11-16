# Oge Vault — Milestone #59: Signed staging restore bridge

**Status:** code and synthetic/disposable-Mongo acceptance only. **NOT real authenticated GitHub staging signoff or production authorization.** PR #35 remains draft; all preview flags remain off outside isolated staging. Never use production user notes or the production database.

## Design and trust boundaries

The M58 internal executor can safely write one create-only batch of 1–12 Notes from an authenticated, reachable same-owner GitHub backup. M59 bridges the signed Auth.js browser owner and a local private-file operator process **without uploading plaintext backup chunks through HTTP**:

1. The signed owner explicitly approves the previously reviewed M57 1–12-note fingerprint and source/target HEAD through a separately default-off staging HTTPS route.
2. The route issues a **10-minute HMAC-SHA256 receipt** tied to exact owner, signed session incarnation, private GitHub repo/installation, selected IDs, source snapshot/inventory, destination HEAD, and M57 fingerprint. The receipt contains no titles, bodies, chunk text or GitHub tokens.
3. A separate operator command verifies the HMAC and local 0700/0600 private chunk/ticket files before connecting to a **shared isolated staging MongoDB database**. That database MUST be exactly the same for the Auth.js browser and the operator.
4. MongoDB atomically transitions the metadata-only receipt from **pending** to **claimed** before the operator obtains a GitHub write token. A consumed ticket is **never automatically retryable**. The existing M58 executor then rechecks authenticated source Git blobs and conflicts behind owner/subject locks before exactly one Git CAS write.
5. After verified success the record is marked **confirmed**. A lost/ambiguous response remains claimed and may retain the durable owner import quarantine. No automatic next batch, replay or unlock.

The **vault_restore_approvals** MongoDB collection stores only signed owner/repo/session metadata, SHA-256 nonce and approval fingerprints, timestamps, state and an optional confirmed Git commit SHA. Its unique _id is the nonce hash; a seven-day-after-expiry TTL index bounds ordinary record retention. Expiry is enforced independently on each claim.

## Staging prerequisites (never enable in production)

Use a protected HTTPS hostname containing staging or preview, exact matching AUTH_URL, OGE_STAGING_URL and OGE_VAULT_BASE_URL, dedicated OAuth and GitHub App credentials, a private synthetic connected repository and a **secure Atlas/replica-set** database named **oge_vault_restore_staging_***. The normal Vault staging preflight must pass. Manually verify external GitHub App installation scope, deployment access restrictions and synthetic-account isolation; configuration checks cannot prove them.

The browser route and the operator process must use the same isolated MONGODB_URI, MONGODB_DB and a **separate unpredictable 32-byte hexadecimal OGE_VAULT_CHUNK_RESTORE_APPROVAL_KEY** (e.g. generated locally with openssl rand -hex 32). Never expose secrets through NEXT_PUBLIC_ variables, GitHub issues, CI logs or chat.

Existing Vault main, hybrid draft, Notes API and import plan/commit preview flags plus M58 OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW=true and OGE_VAULT_CHUNK_RESTORE_WRITE_ACK=YES_DISPOSABLE_SIGNED_STAGING_ONLY are still required in staging. The new default-off browser flag is **OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW=true**.

## Step 1 — Prepare and review

Securely download all chunk parts for one same-owner GitHub snapshot; source verification supports up to 1,024 current Notes / 16 private parts and 20 newer linear Git commits. Store in an operator-owned directory with 0700 permissions, each contiguous part-0001.json ... file as owner-only 0600. Run the M57 read-only batch intent planner and independently review the create/existing/draft conflicts, exact destination HEAD and selectionFingerprint. **A positive preview is not authorization to commit.**

## Step 2 — The signed owner approves exactly one batch

The authenticated staging browser sends a same-origin JSON POST to:

**/api/vault/backup-import/chunk/authorize**

~~~json
{
  "confirmation": "COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY",
  "expectedSourceSnapshot": "<40 lowercase hex Git commit>",
  "expectedSourceInventorySha256": "<64 lowercase hex checksum>",
  "expectedTargetHead": "<40 lowercase hex current HEAD>",
  "selectedIds": ["<one to twelve distinct lowercase note UUIDs>"],
  "expectedSelectionFingerprint": "<64 lowercase hex M57 fingerprint>"
}
~~~

Only the same-origin signed Auth.js session can authorize a receipt; the route checks owner mutation throttle, read-only private GitHub installation and the unchanged destination HEAD. It never reads/upload chunks or invokes GitHub writes. It returns **ticket**, **receiptId**, expiry and **immediatelyExecutesRestore:false**.

Save the returned ticket privately to a **separate 0600 regular JSON file**, outside the chunks directory:

~~~json
{ "ticket": "<exact signed issued ticket>" }
~~~

Keep the receipt file private; it is short-lived authorization material.

## Step 3 — Separate operator command for one batch only

The local operator sets the exact signed ownerId, sessionVersion, repoId and GitHub App installationId; all normal staging credentials; the same **secure staging DB** and receipt key; plus these separate opt-ins:

~~~sh
# Staging-only variable examples, NOT an executable production setup:
# OGE_VAULT_CHUNK_RESTORE_STAGING_OPERATOR=YES_ONE_SIGNED_BATCH_ONLY
# OGE_VAULT_CHUNK_RESTORE_STAGING_ACK=YES_SEPARATE_SYNTHETIC_STAGING_DATABASE
# OGE_VAULT_CHUNK_RESTORE_TICKET_FILE=/absolute/private/signed-ticket.json
# OGE_VAULT_CHUNK_PLAN_DIRECTORY=/absolute/private/oge-notes-chunks
# OGE_VAULT_INSPECT_OWNER_ID=<exact signed account ID>
# OGE_VAULT_INSPECT_SESSION_VERSION=<signed session incarnation>
# OGE_VAULT_INSPECT_REPO_ID=<private GitHub repo ID>
# OGE_VAULT_INSPECT_INSTALLATION_ID=<GitHub App installation ID>
npm run vault:chunk:restore-staging
~~~

The executable refuses localhost, production/default MongoDB names, insecure DB URIs, a bad staging origin, mismatched session/repo/installation, missing HMAC, expired or replayed receipt, non-owned/unsafe file permissions and missing pages. The server-side signed approval is atomically **claimed once** before the GitHub contents:write token is acquired. M58 then re-verifies source note bodies, current Git HEAD, owner, subjects and encrypted drafts and performs one non-force Git ref CAS.

A verified success prints only redacted batch counts. An unknown outcome prints no credentials or note contents and leaves the receipt claimed; a potentially started GitHub write retains the owner quarantine. No automatic retry or lock release.

## Step 4 — Read-only owner status

As the same signed staging account:

**GET /api/vault/backup-import/chunk/status?receiptId=the-receiptId**

The owner-scoped route returns one of:

- **PENDING_APPROVAL_CLAIM** — not yet consumed; unusable after expiry.
- **CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED** — claimed, in progress, or uncertain. This is **not proof of a failed or successful GitHub write**. Do not retry.
- **GITHUB_BATCH_CONFIRMED** — GitHub write was verified, and the receipt confirmation was stored.

Every status explicitly says no automatic retry, no lock release, no automatic next batch. A second batch requires a new signed browser approval and a new reviewed fingerprint at the NEW current target HEAD.

## Milestone #60 — Bounded read-only history across independent batches

A single M59 receipt has its own read-only status, but restorations may
need several **separately reviewed** batches. M60 adds a signed-owner,
staging-only HTTP GET that reports recent receipt metadata without
contacting GitHub or exposing backup contents:

`GET /api/vault/backup-import/chunk/history`

This endpoint requires the same **disabled-by-default** staging
approval feature flag, valid Auth.js owner/session, exact connected
private GitHub repo/installation and approved HTTPS staging database.
It checks the signed owner context **twice**, before and after reading
only matching approval documents. A dedicated compound MongoDB index
serves the latest **25 receipts** in descending creation order.
No note IDs, titles, answers, private chunks, full approval ticket,
user identifier or HMAC secret appear in the response. Confirmed
GitHub commit SHA and opaque hashed receipt IDs may be returned.

The report includes counts **only within the visible window**, one
status per receipt and explicit limits:

- `CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED`: confirmed recent batches
  exist; this is **not** proof of the current Git HEAD or permission to
  start another batch.
- `PENDING_UNCONSUMED_APPROVAL` or
  `EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW`: a ticket has not been
  consumed; a fresh signed owner review is still needed.
- `BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED`: a prior claimed receipt
  may have committed at GitHub, even without a successful local
  confirmation. **Do not retry or issue another restore approval.**
- `BLOCKED_IMPORT_LOCK_PRESENT`: MongoDB holds an import fence,
  potentially due to a write with unknown remote outcome. It cannot
  be cleared automatically.
- `BLOCKED_INCOMPLETE_HISTORY_WINDOW`: more than 25 receipt records
  exist. The displayed subset is **not a complete restore ledger**.
- `BLOCKED_INVALID_HISTORY_METADATA`: malformed historical metadata
  was found; treat the ledger as unsafe to use for recovery decisions.

M60 also refuses new signed approval receipts when a prior claimed
batch remains unresolved or the owner Vault import lock is present.
Only an independently confirmed, nonquarantined previous batch can
be followed by a **new M57 read-only plan**, exact current HEAD and
a completely **new Auth.js owner approval and 10-minute ticket**.
Concurrent new browser approvals are not by themselves a multi-batch
commit sequence; each one-time ticket is checked independently and
the GitHub CAS/exclusive owner import lock still prevents unsafe
writes.

**No automatic continuation exists.** In all status reports:
`automaticNextBatchAuthorized:false`,
`automaticRetryAuthorized:false`,
`operatorLockReleaseAuthorized:false`,
`historicalTotalsProven:false` and
`currentGitHubHeadVerified:false`. Ordinary TTL cleanup means an
older receipt might no longer be present; this read-only window
cannot prove the number or provenance of all earlier restore commits.

Real MongoDB replica-set tests cover multiple verified receipts,
unknown outcomes, expired approval, more than 25 rows, import lock
presence, malformed rows, revoked session and GitHub App mapping.
A standalone signed staging acceptance with a real GitHub installation
and two authenticated devices **has not been executed**.

## Milestone #61 — Isolated real GitHub provider READ probe and acceptance matrix

M61 introduces an opt-in **read-only operator probe** that can be run
against an independently authorized **disposable staging** GitHub App
installation. This command does **not** create notes, move Git refs,
request a GitHub write token, or verify two physical devices. **It has
not been run against live credentials in this development milestone.**

### Read-only operator invocation

Only in a protected staging operator environment, set the **existing**
isolated Vault/Hybrid/Notes/restore-approval preview prerequisites and
the exact signed staging account scope from the dedicated secure staging
database. Explicitly set:

```sh
# Operator-only opt-in; do not commit credentials or use production accounts
# OGE_VAULT_REAL_PROVIDER_PROBE_READ_ONLY=YES_ISOLATED_PRIVATE_STAGING_GETS_ONLY
# MONGODB_DB=oge_vault_restore_staging_<disposable-database>
# OGE_VAULT_INSPECT_OWNER_ID=<signed-test-owner-id>
# OGE_VAULT_INSPECT_SESSION_VERSION=<signed-session-version>
# OGE_VAULT_INSPECT_REPO_ID=<disposable-private-GitHub-repository-id>
# OGE_VAULT_INSPECT_INSTALLATION_ID=<disposable-GitHub-App-installation-id>
npm run vault:staging:provider-probe
```

The preflight checks `OGE_STAGING_URL`, `AUTH_URL`,
`OGE_VAULT_BASE_URL`, private GitHub App and OAuth configuration,
the dedicated `oge_vault_restore_staging_*` MongoDB name, exact
signed user/session/repo/installation and default-off opt-in **before**
connecting to MongoDB or GitHub. Never run with a production MongoDB
URI or real user account, even if the database name resembles staging.
Staging account/deployment isolation must also be independently
confirmed by an operator; configuration matching alone is not proof.

The command independently requests **two** restricted
`contents:read` GitHub App installation clients from the same
owner-connected private repo. It verifies the full signed GitHub
account mapping including login/account ID, matches branch HEAD,
immutable HEAD commit's tree SHA, rechecks branch HEAD and owner
mapping, and outputs only redacted booleans. It fetches **no Notes
blobs**. A provider 401/403/429, changed HEAD/tree or revoked
owner/session prevents a positive probe. No write-scope token is
minted and the command never executes a restore.

A positive read probe means only that **this exact GET-only scope
could be observed**. The result explicitly declares
`physicalTwoDeviceSessionsVerified:false`,
`liveOAuthBrowserAcceptanceVerified:false`,
`realGitHubWriteFailureMatrixVerified:false` and
`completeStagingAcceptanceSignedOff:false`. Two independently
requested installation tokens are **not two independent browser
devices**, and a verified read-only GitHub response is not
authorization to restore or to clear an uncertain owner import lock.

### Deterministic transport error matrix covered in CI

Automated tests invoke the production `vaultGithubRequest`
transport using controlled synthetic fetchers to verify fail-closed
behavior for GitHub 401 auth expiry, 403 permission revocation,
403 rate-limit headers, 429 throttling, 409 conflict, 422 Git
non-fast-forward/conflict and network failure. For GitHub POST/PATCH
writes, **there is one attempt even if the reply is 429/409/422/503
or the network response is lost**. A lost HTTP response cannot be
treated as proof that the remote write failed; the M58 owner import
quarantine and M59 consumed receipt remain in force. These tests are
deterministic transport simulations, **not actual provider fault
injections or signed two-device tests**.

### Required external acceptance checklist (NOT signed off)

Before any proposal to merge/enable restore, a qualified operator
must document independent, dated, redacted evidence that all of the
following were actually observed with *only* disposable test data:

1. Dedicated OAuth/Auth.js login of **two real separate browser/device
   sessions** for the same disposable owner; verify stale/revoked
   signed sessions cannot inspect or modify another account.
2. GitHub App installation provenance: exact private owned repo ID,
   same signed GitHub account, **contents:read** token isolation,
   denial of writes through read-only client, and separate constrained
   **contents:write** token only for an authorized staged batch.
3. Real GitHub CAS: one create-only 1–12-note restore commit on a
   disposable private Vault, verified revision and note byte content,
   no MongoDB permanent note body, and no encrypted draft deletion.
4. Actual stale-HEAD, 409/422, 429/secondary-rate-limit, 403/revoked
   installation and network-timeout responses observed and recorded
   **without retrying a possibly executed write**. Do not deliberately
   corrupt or delete an existing real user's GitHub repository.
5. With two actual devices, verify the owner import-exclusive fence
   prevents concurrent drafts and secondary restore writes, and the
   unknown-outcome state requires separate human reconciliation.
6. Observe receipt expiry, one-time claim, incomplete history and
   owner-locked state; verify no automatic next batch/lock release.
7. Operator independently confirms staging database/host/credentials
   are isolated, no sensitive data leaked into CI logs, and production
   feature flags have never been enabled.

**No automated script may mark this external checklist complete
merely because unit tests, a GET-only probe or GitHub Actions passed.**
No actual provider observation/signoff is currently recorded here.

## Milestone #62 — Owner-facing staging-only restore review (no GitHub writes)

A previously reviewed M57 source/target selection can now be entered
through a responsive, retro-styled staging page:

`/vault/restore-staging`

The page is **404 outside the exact isolated staging environment**:
it requires `OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW=true`, an
`oge_vault_restore_staging_*` database, matching HTTPS
`OGE_STAGING_URL` and `OGE_VAULT_BASE_URL`, successful Vault
staging configuration preflight, and a signed Auth.js browser session.
The link is only visible from the owner's connected `/vault` page
when the same isolated gating checks pass. All flags are **OFF by
default**; this is not a production restore feature.

The staged reviewer first retrieves its own bounded signed-owner
receipt history through the existing read-only endpoint. Missing,
unparseable, incomplete or unknown history, a pending/claimed batch,
an import quarantine, and invalid or truncated records **disable**
approval in the browser. A previously confirmed batch or an expired
pending receipt does **not** prove current GitHub HEAD; it only lets
the owner start a *new independent review*. The server re-checks
authoritative owner/session, source/target requirements and GitHub
HEAD before issuing a receipt, so a stale browser cannot bypass the
existing server-side gates.

The form accepts **only exact metadata** from a separately verified
M57 source and destination review:

- The 40-hex Git source snapshot and target current HEAD.
- The 64-hex backup inventory digest and M57 selection fingerprint.
- Between 1 and 12 **distinct lowercase note UUIDs**.

No note bodies, chunk files, GitHub credentials, permanent backups
or original plaintext archives can be uploaded through this form.
The user must select an explicit independent-review acknowledgment
and type **APPROVE ONE BATCH** before its POST is enabled. The
request still **only issues a ten-minute signed one-use receipt**;
it never uploads a backup or writes a GitHub commit.

The returned secret ticket is held in temporary React component
memory, **not** shown by default, stored in localStorage,
sessionStorage or added to the URL. The only transfer control is an
explicit **Copy private ticket JSON to clipboard** user action.
The owner should immediately save it to an owned 0600 file outside
the chunks directory, pass it to the isolated M59 operator, and
clear the clipboard. A failed or lost response is not automatically
replayed, and the UI asks for manual read-only history review
before any further request. The owner may separately query the
individual receipt's pending/claimed/confirmed state, but can
**never retry**, release an import quarantine or start another
GitHub batch automatically through this page.

**UX limits:** M62 does not fetch or verify the complete private
backup inside the browser, display note contents, create a portable
encrypted offline backup, or turn the UI into an authorized
GitHub restore executor. The owner/operator must independently
produce and review the M53–M57 source proof and exact target HEAD.
This staging page is an accessible review-and-receipt bridge, **not
the final consumer backup/restore experience**.

Automated validation includes strict field and UUID selection tests,
history-state fail-closed policy, signed and isolated server gate
checks, no persistent browser ticket storage, no GitHub writes
from the UI, Next.js production build, lint and existing
Chromium desktop/mobile smoke. The standard browser smoke does not
authenticate two real staging devices or exercise a real GitHub
restore through the new page. **Actual GitHub App OAuth/two-device
acceptance remains unsigned**.

## Milestone #63 — Local private backup integrity check in the staging browser

The M62 staging review page now has a **mandatory local file review**
before it can issue an M59 signed one-time approval. This closes a
previous UX gap in which an owner had to manually copy a source checksum
and selection fingerprint but could not independently check the
downloaded chunk files in the browser.

After preparing a M57 **signed source/target** intent using the
existing trusted operator tooling, open `/vault/restore-staging` from
a **trusted disposable staging computer**. Supply the exact M57
source commit, full inventory SHA-256, current target HEAD, selection
fingerprint and the selected 1–12 UUIDs **in their approved order**.
Choose the complete `part-0001.json` through final
`part-NNNN.json` source chunk files using the local file picker,
then explicitly press **Verify local chunks and reviewed fingerprint**.
Only 1–16 numbered JSON parts of **at most 4 MiB each** are accepted,
covering **at most 1,024 Notes**. The browser reads the files
sequentially with the local File API; no file is submitted to an
HTTP request or placed into browser local/session storage.

The browser's Web Crypto SHA-256 verifier checks all these properties:

- Exact part filenames, file bounds, canonical chunk format and
  Notes-only coverage (no Quick Notes, AirNotes, encrypted drafts or
  historical revisions).
- Canonical Note structure/field ordering, note-size limits,
  UTF-8 validity, unique ascending UUIDs, chunk offsets, cursor
  continuity, complete page count, and per-part SHA-256.
- **Full inventory SHA-256** over each note ID + Git blob SHA
  from every part, matching the exact originally reviewed source
  snapshot/inventory checksum.
- The SHA-256 of canonical selected note metadata (including actual
  local heading/answer bytes) mapped to each of the **1–12 chosen
  Note IDs** in owner-selected order, matching the reviewed M57
  `selectionFingerprint` for the exact destination HEAD.

The UI shows **only number of parts, total Notes and selected Notes**
on success. It does not render private note headings or answers,
store a backup, send notes to MongoDB, request a GitHub token,
or commit a GitHub change. Any corrupt, missing, duplicated,
forged or mismatched file blocks the browser's receipt request.
Changing any reviewed field or selected local files invalidates
the local proof and requires another explicit check. The owner
still must acknowledge the independent conflict review and type
`APPROVE ONE BATCH`.

**Local integrity is not GitHub authentication.** Source commit
SHA and blob SHA fields inside downloaded JSON are self-reported
metadata until independently verified against the *signed private
GitHub App installation* by the M55–M58 operator source proof.
A matching local SHA-256 is neither a signed approval nor evidence
that GitHub currently contains these notes; it also says nothing
about the latest target HEAD or MongoDB encrypted-draft conflicts.
The M59 browser approval API rechecks the HEAD independently,
and the M58 operator re-reads and verifies every Git blob and
target conflict behind its durable owner/subject locks.

If the signed browser POST fails or loses its response **after
submission**, the staging page now permanently disables that
form for the current review session rather than allowing a
second POST. Inspect the read-only owner history; a claimed or
pending result might indicate an approval was already created.
No automatic retry, multi-batch continuation, import-lock release
or silent draft deletion was added.

**Privacy caution:** these downloaded chunks contain the
owner's *plaintext* Notes. Choose files only on a trusted device
and an isolated, authorized staging origin. The browser handles
the file bytes in memory while checking them; JavaScript running
on a compromised origin or browser extension could potentially
access them. No automatic copy, upload, persistence or local
backup is performed by this feature.

Unit tests match the server's canonical chunk verifier on
130 Notes and a **520-note, >8-MiB** backup; check incomplete
parts, reordering, forged checksums, modified local bodies,
unsupported fields, mismatched selection order/HEAD/inventory
and no-network/no-storage operation. These tests run with
synthetic data, not a real signed GitHub staging account.
The existing Chromium desktop/mobile smoke is a general
app check; it is **not** a live authenticated test of this
file-picker workflow or any real restoration.

## Milestone #64 — Owner-initiated, bounded private Notes chunk download

The hidden, authenticated `/vault/restore-staging` page now has a
**Download private Notes chunks** action above the M63 local-file
review. The download button is independently **disabled** unless the
existing **read-only** export gates
`OGE_VAULT_BACKUP_EXPORT_PREVIEW=true` and
`OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW=true` are both set on an
authorized isolated staging deployment. The page itself continues
to require its stricter signed connected-owner, private Vault,
MongoDB staging and restore-approval gates. **No production flags
were enabled.**

After a deliberate owner click, the browser fetches the existing
signed, private `GET /api/vault/backup-export/chunk` endpoint with
`credentials:'same-origin'`, `cache:'no-store'`, and no custom
repository or arbitrary revision selectors. Subsequent GETs use
**only** the previous verified response's `snapshot` and
`nextAfterId` parameters. The server rechecks the signed owner,
selected subjects and connected GitHub HEAD on every part; a changed
HEAD causes the download sequence to stop rather than mixing revisions.

The new browser verifier checks each response **while it streams**,
with a strict maximum of **4 MiB per response**, then validates
UTF-8/JSON, complete strict Notes-only schema, 64-note pagination,
ascending canonical UUIDs, continuous offset/cursor, stable HEAD,
per-part SHA-256, and the **complete** id/blob-SHA inventory digest.
It accepts **at most 16 parts / 1,024 current Notes**. Only a page
that has passed these checks is offered as a temporary
`Blob` download named `part-0001.json`, `part-0002.json`, etc.
Temporary object URLs are revoked. No Note text, chunks or receipts
are sent to another HTTP endpoint, saved in MongoDB, or persisted to
browser local/session storage. No GitHub write API is involved.

A completed sequence only means **all server responses passed the
browser-side integrity check**; it does **not** mean every file has
actually been written to the user's device. Mobile/desktop browsers
can block or require permission for repeated automatic downloads.
The user must **confirm the full numbered set exists on disk**, then
choose those actual files in the **separate M63 local File picker**
below. The local M63 verifier independently repeats whole-sequence
and reviewed selection-fingerprint checks against the selected files.

An HTTP 429, malformed page, oversized response, moved HEAD, missing
part, cancelled request or browser download error **stops** the
attempt. The UI never retries automatically, never mixes existing
partial files with a new snapshot, and disables a second attempt
for the same review session. Discard any partial files, begin a
fresh review of the live source and store complete backups in
**private encrypted storage**. The downloaded JSON parts are
**plaintext**; they are not themselves encrypted, and browser
integrity hashes are NOT digital signatures or durable independent
GitHub provenance evidence. The signed M55–M58 operator must still
independently authenticate original raw Git blobs before restoration.

**Coverage limits:** this export contains current Notes only. It
does not include historical revisions, Quick Notes, AirNotes,
temporary encrypted drafts, or learning progress. Its read-only
URL does not make it a production backup service, durable retention
solution or permission to restore. No live GitHub OAuth/two-device
staging drill or authenticated browser permission acceptance was
performed. The synthetic tests exercise complete 130-note and
520-note (>8 MiB) sequences and interrupted/corrupt cases against
the existing trusted Node verifier; passing those tests is not a
claim that an actual browser saved all files.

## Milestone #65 — Offline AES-GCM encrypted Notes parts

M64's owner download now saves **encrypted part-NNNN.oge.json files only**:
browser Web Crypto derives a 256-bit AES-GCM key from a strong 16+
character unique passphrase using PBKDF2-SHA-256 (600,000 iterations)
and a fresh per-backup 128-bit random salt. Each verified 4-MiB-or-
smaller source JSON part has its own random 96-bit IV, authenticated
format/part/size metadata, and AES-GCM authentication tag. The
downloadable Blob contains **only ciphertext plus bounded metadata**;
the page does not save or offer plaintext source JSON.

The owner must **confirm and securely retain the password**, since Oge
has no escrow, reset or recovery key. Password guessing is possible
offline for weak passphrases; device/browser compromise can reveal
plaintext or the passphrase while in use. The original protected GitHub
GET still delivers plaintext to the signed browser *over HTTPS*:
this is client-side **offline file at-rest encryption**, not end-to-end
encryption against an untrusted service.

In the M63 restore review, choose every numbered encrypted file and
enter the same password. The browser opens only transient decrypted
file-like views and verifies all original Notes chunks and the exact
M57 source inventory/selected-note fingerprint. The passphrase input
is cleared after review. Wrong passwords, altered ciphertext/metadata,
different backup salts and missing/mixed parts fail closed.
Legacy plaintext part-NNNN.json files can still be selected for
controlled historical staging review, but are no longer offered by
the owner download button.

**Operator workflow limitation:** the separate M58/M59 staging CLI still
requires protected private plaintext 0600 chunk files. It CANNOT
directly consume encrypted .oge.json files yet. A security-reviewed
operator conversion with no exposed password, independent signed
GitHub source verification and safe temporary-file cleanup is a
future milestone. Do **not** bypass the owner import lock, assume
an encrypted file authenticates GitHub, or treat a local green review
as permission for a GitHub write.

Full versioned format, password-loss and source-deletion caveats:
docs/OGE_VAULT_ENCRYPTED_OFFLINE_BACKUP.md.
No real OAuth/two-device provider staging or cryptographic audit
has been completed.

## Remaining release blockers

M59 automated synthetic Git and real disposable MongoDB tests are NOT real signed two-device provider staging; no actual independent staging session has been signed off. The signed route issues one-time approval receipts but no completed, live-accepted production offline backup and restore experience. Automatic multi-batch progress/resumption, verified operator quiescence and dual approval for uncertain lock repair, recovery after source repository loss, Quick Notes, AirNotes, extension integration, privacy review and production cutover remain incomplete.

**Do not merge PR #35 or enable production restore flags.**
