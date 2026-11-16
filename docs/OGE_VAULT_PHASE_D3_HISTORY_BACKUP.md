# Oge Vault — Phase D3: GitHub revision history and backup architecture

**Status: bounded revision read/restore, Notes-only export, read-only import
planning, owner-approved create-only import and read-only bounded Git ancestry
recovery previews implemented. All import routes are default-off and untested
with live authenticated staging. Full-resource backup, owner-facing recovery
and production cutover remain pending.**

## Staging-only revision preview

Configure only on an **isolated** test environment with disposable notes:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_REVISION_PREVIEW=true
```

Both flags default to false. This does not replace the existing production
`/api/revision-history` endpoint or rewrite the revision-history UI.

### Read a single private note's recent history

`GET /api/vault/revision-history?id=<note-UUID>`

- Requires the signed Oge owner and a verified GitHub App repository-scoped
  installation token. The note's subject must still belong to that owner.
- Reads **at most five** path-scoped GitHub commits for that one note, verifies
  each candidate's immutable Git tree and note blob, and checks the branch
  HEAD again before returning. Any 429 is preserved to the caller.
- Returns the historical `heading` and `answer` from GitHub only. No note
  content, revisions or snapshots are persisted in MongoDB.
- The `limited: true` field is intentional: this is a bounded preview,
  **not** a complete history explorer. A deleted revision may be omitted and
  `moreMayExist` signals that more history may require a later pagination
  implementation.
- Malformed blobs, truncated Git trees, changed branch HEAD and cross-subject
  UUID reuse fail closed. The endpoint never reads the old `notes` collection.

### Restore one verified historical version

`POST /api/vault/revision-history`

```json
{
  "id": "<note-UUID>",
  "sha": "<expected-current-git-blob-sha>",
  "commitSha": "<listed-historical-commit-sha>",
  "sourceSha": "<listed-historical-blob-sha>"
}
```

- All values are checked against a newly loaded **server-side** history. An
  arbitrary historical commit cannot be submitted without being in the bounded
  path-scoped list.
- The target subject is owner-checked and locked with the Vault subject-write
  fence. If an encrypted unsynced draft exists for this note, restore returns
  **409** and does not commit; the draft is never deleted by this endpoint.
- A second GitHub note read verifies the expected current blob SHA. A single
  `commitVaultNoteBatch` update then applies the historical **heading and
  answer**, preserving current tags/favorite and creation date.
- A competing GitHub commit or stale note SHA fails with **409** rather than
  overwriting the newer note. A lost GitHub write response never causes a blind
  replay: the underlying batch writer must confirm the commit before returning
  success.
- No MongoDB note body or revision history is written.

The new endpoint has no public UI integration yet. It is an independently
disabled preview API, **not** a completed cross-device revision experience.

## Phase D3b1: GitHub-only Notes export preview

On **isolated staging only**, set:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_BACKUP_EXPORT_PREVIEW=true
```

The flags default to false. An authenticated test owner may use:

`GET /api/vault/backup-export`

The response is a JSON download named `oge-vault-notes.json`, with
`private, no-store` and `nosniff` headers. It contains **only current
committed GitHub Notes** and their original immutable blob SHAs.

- The server authenticates a signed owner and validates its exact private
  GitHub App installation/repository. It never takes a repo identifier or
  arbitrary file path from the request.
- It reads the branch HEAD and one commit's recursively listed Git tree,
  validates every path beneath `notes/`, and loads each note from the
  immutable Git blob SHA with at most five concurrent reads. All note
  subjects must match that owner's MongoDB **subject metadata**.
- After building the entire archive it verifies that GitHub HEAD and the
  signed owner's Vault mapping remain unchanged. Any incomplete tree, corrupt
  blob, missing subject or moved HEAD is an error; **no partial backup** is
  returned. No committed note bodies are written to MongoDB.
- The output has an **8 MiB JSON response cap** and a Git tree limit of
  30,000 entries. It is not limited to 500 notes; synthetic tests cover
  501. Vaults exceeding the response limit receive HTTP **413**, not an
  incomplete download. Large-vault chunked export remains future work.
- The export `coverage` field states that historical revisions,
  Quick Notes, AirNotes, encrypted temporary drafts and learning-progress
  metadata are **not included**. It is *not a complete Oge backup*, and
  it cannot substitute for an export covering all those resources.
- GitHub blob SHAs in the JSON are advisory source metadata, not proof that
  an uploaded backup has been independently authenticated. Import must
  never trust them without validation and fresh remote conflict checks.
- No export is stored server-side. Downloaded JSON contains **private note
  text** and must be stored securely by the owner; do not copy it to CI logs,
  error reports or public GitHub issues.

The existing legacy `/api/backup` remains unchanged. During D1 staging,
connected Vault accounts are blocked from using it, rather than exporting
or importing permanent MongoDB copies.

## Phase D3b2a: Notes-only import validation and conflict preview

On **isolated staging only**, set:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW=true
```

Submit the previously downloaded Notes-only JSON backup as the **entire
JSON request body** to:

`POST /api/vault/backup-import/plan`

This is **read-only conflict planning, not an import action**. There is no
endpoint that can commit the archive or reuse the returned plan as write
authorization. The operation validates the owner session and private GitHub
App Vault mapping, parses at most an **8 MiB** JSON archive in memory, and
rejects legacy/unknown formats, extra fields, corrupted note data, duplicate
or invalid UUIDs, malformed source SHA metadata and misleading coverage
claims. The source GitHub snapshot and blob SHAs are never trusted as
authorization to write to the destination repository.

A complete, snapshot-pinned scan of the **target** private GitHub tree
checks its current note IDs, including nested, noncanonical and duplicated
paths. It then checks owner-scoped MongoDB subject **metadata** and the
presence of encrypted temporary drafts scoped to the exact signed owner,
GitHub repository and note IDs, using bounded query chunks. It finally
rechecks GitHub HEAD and the owner/repository mapping.

The response provides only note IDs and conservative statuses:

- `create-candidate`: the note ID is absent from the destination GitHub
  snapshot and no encrypted draft was found. It is **not** approved to write
- `existing-note-conflict`: the destination already has that UUID; it is
  never overwritten, even when a source SHA appears to match
- `draft-conflict`: a temporary encrypted unsynced draft exists for that
  UUID; it must be reviewed rather than deleted

The plan includes `targetHead`, summary counts, `readOnly: true`,
`canCommit: false` and `requiresFreshApproval: true`. It does not echo
headings, answers or private note text, store uploaded content or create a
GitHub commit. As an advisory snapshot, it can become stale as soon as
another device writes; a future import executor must **recalculate every
conflict, draft and HEAD check within its own lock before committing**.

The test suite includes over 500 notes, malformed or tampered archives,
unowned subjects, GitHub drift/429, duplicate files and protected drafts.
No authenticated live staging import has been performed.

## Phase D3b2b1: Explicit owner-approved create-only Notes import

**Isolated staging with disposable accounts only. Do not enable in production.**
The optional write API has its own independent default-off flag and requires
all four conditions below:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW=true
OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW=true
```

After reviewing the **fresh read-only** `POST /api/vault/backup-import/plan`
results, the authenticated owner can explicitly call
`POST /api/vault/backup-import/commit` with an `application/json` body:

```json
{
  "archive": "<the full, unmodified Notes-only backup JSON object>",
  "expectedTargetHead": "<the exact targetHead from the latest plan>",
  "selectedIds": ["<one to twelve create-candidate note UUIDs>"],
  "confirmation": "IMPORT_SELECTED_NEW_NOTES"
}
```

The `archive` field above is a nested JSON **object**, not a string.
No UI currently provides this flow. This is a staging-only API capability,
not a production-ready recovery experience.

- A selected UUID must be in the validated archive and must remain a **new
  create-candidate** after independent fresh target-tree, owner-scoped subject
  and encrypted draft checks inside the selected subject-write fences. A
  conflicting ID cannot be overwritten, even with the correct source SHA.
- The exact owner-approved target HEAD is rechecked by both the planner
  and the existing GitHub batch writer. A changed HEAD, deleted subject,
  modified session/repository mapping, draft or GitHub 429 fails closed.
  More than 12 selected notes, repeated IDs or absent approval are rejected.
- The existing verified non-fast-forward **one Git commit** writer preserves
  archive heading/body/tags/favorite and both original timestamps. It verifies
  the GitHub ref, commit ancestry and saved blobs. An ambiguous response is
  **never blindly replayed**. The API responds only with imported UUIDs,
  counts and the verified commit SHA; it does not echo private note content.
- The selected batch can be smaller than the archive. Additional batches
  require a **new plan and new approval HEAD**, not automatic continuation.
  Existing destination Notes and encrypted drafts are never deleted or
  modified by the import path. MongoDB is used only for permitted owner,
  subject and encrypted-draft metadata/fencing.
- The tests are **synthetic**; real signed OAuth/GitHub-App staging,
  simultaneous draft creation and cross-request uncertain-result recovery
  still require review. In-flight draft writers are not an exclusive
  multi-subject lock, so concurrent draft races need dedicated acceptance
  testing before any deployment. This route must remain disabled elsewhere.

This limited API **does not** import historical revisions, Quick Notes,
AirNotes, progress, unsynced browser drafts or an archive larger than
8 MiB. It does not resolve conflicting existing Notes. A successful
Notes-only import must never be presented as a full Oge restoration.

## Phase D3b2b2: Race fence and read-only import reconciliation

**Default-off staging implementations; not authenticated provider acceptance.**

The approved `POST /api/vault/backup-import/commit` now obtains a signed
exclusive lock on the owner's MongoDB `users` row in addition to the existing
selected-subject write fences. The owner row contains only the operation ID,
repository ID, timestamp and active draft-writer count, **not uploaded content**.
Every hybrid draft PUT and verified draft-cleanup mutation increments/decrements
that same owner-row counter while performing the operation, including when a
caller tries to use a different subject for the selected note UUID. Import
cannot start until all draft writers finish; autosave during import returns 409
and must preserve the local recovery copy.

The exclusive lock **does not auto-expire**. If its release is uncertain, the
lock is left fail-closed and requires an authorized operator to inspect the
exact signed account, GitHub state, encrypted drafts and import operation
before any recovery. No automatic unlock or deletion is implemented. Owner
lock is intentionally broader than one subject: it temporarily blocks all
draft mutations for the owner during this bounded import.

Each successful import commit now carries a SHA-256 marker calculated from
the selected canonical notes and owner-approved target GitHub HEAD, rather
than private text in the commit message. For a lost HTTP response, submit
**exactly the same** approval body used for the import to:

`POST /api/vault/backup-import/reconcile`

The read-only endpoint has the same four default-off preview gates as the
commit endpoint. It requires the signed account and repository, validates the
archive and selected UUIDs, checks current subject ownership and pins the
current GitHub HEAD. It walks at most **20 Git commits**, requiring a linear,
single-parent history to find the exact approved import commit. The import
commit's direct parent must be the previously approved target HEAD; its
content-derived SHA-256 marker must match; complete immutable Git trees must
prove that only the selected note files were newly added; and all imported
blobs must match the canonical archived notes. A later modification or
deletion does not erase proof of the **historical** import.

The result returns only metadata: `commitSha` is the verified historical
import commit (not the current branch HEAD), `currentHead` is the HEAD
pinned for this check, `commitsAfterImport` counts newer commits, and
`currentNotesUnchanged` / `currentNotesChanged` distinguish unchanged
current Notes from later edits/deletions. The branch HEAD and signed owner
mapping must still match before confirming. No private note text is returned;
no permanent MongoDB note content, drafts, receipts or GitHub files are
modified by the recovery endpoint.

When the target commit lies beyond the 20-commit window, the history is
merged/nonlinear, or the approved commit is not proven, the result is
`confirmed: false`, **not proof the import failed**. Invalid Git trees,
cycles and provider limits fail closed. Every result includes
`safeToRetryAutomatically: false`; this remains true even when import was
historically confirmed. Do not replay an uncertain import, overwrite newer
edits or retire encrypted drafts. Owner-facing UI, safe operator lock release,
signed live two-device/staging tests, merge-aware/deep history and local-only
browser draft protection remain unimplemented. This is not full Oge backup
restoration.

## Phase D3b2b2c2 / Milestone #46: Redacted operator import-lock inspection

For a Vault import that may have crashed or lost its response, an authorized
operator can run an explicit, **read-only** inspection in a private terminal:

`npm run vault:import-lock:inspect`

This is **not an HTTP endpoint** and provides no regular user-facing unlock.
A separate `OGE_VAULT_IMPORT_LOCK_INSPECT_READ_ONLY=YES_REDACTED_ONLY`
acknowledgment and exact existing owner/session/repository/lock UUID scope
must be supplied together with an explicit database and verified GitHub App
configuration. The CLI uses direct `MongoClient` reads rather than
`getDatabase()`, which would initialize indexes.

Inspection compares two projected account-row lock snapshots, bounded
`vault_drafts`/subject-active-writer **existence** counts, and two private
GitHub HEAD readings. The only output is a redacted result status,
boolean safety observations and a broad age band. The CLI does **not**
download, decrypt or store any note body, read draft ciphertext, write MongoDB
or write GitHub notes, include owner IDs/GitHub SHAs in the report, set TTLs
or unlock a fenced operation.

This metadata is **not a transactionally consistent snapshot** and cannot
prove quiescence: a seemingly idle/old lock might still belong to a delayed
GitHub writer. `automaticUnlockAuthorized` and
`operatorUnlockAuthorized` always remain `false`. Existing imported-note
reconciliation should be performed separately with the signed owner's own
archive and the read-only API, acknowledging its 20-commit linear-history
window; a missing proof is an unknown outcome, never permission to replay.

**Detailed incident steps and blockers:**
`docs/OGE_VAULT_IMPORT_LOCK_OPERATOR_RUNBOOK.md`.

The tool includes synthetic redaction, scope, provider-failure and race tests
plus disposable MongoDB replica-set inspection tests. Milestone #47 adds a
strictly disposable-local pre-GitHub-write lock release tool and preserves
uncertain GitHub writes under a durable quarantine marker. **No production
release of a possibly-started GitHub write, owner-facing recovery, or live
signed staging is implemented.** PR #35 stays draft and all import preview
gates remain disabled outside isolated staging.

## Phase D3b2b2c3 / Milestone #47: Durable write quarantine and narrow recovery

The approved import route now persists a scoped, metadata-only
`vaultImportLock.state='github-write-possible'`, approved SHA-256 commit
marker and timestamp **before** the first GitHub batch write can occur. The
marker is written with an exact signed owner/session/repo/operation compare
and swap. If it is not acknowledged, GitHub is never called. Any exception
after a successful marker retains the lock, even if the commit might already
have succeeded; later autosaves/imports receive 409 until independently
investigated. No blind retry and no TTL exists. On verified success the
original request still releases its own matching lock.

For safely controlled synthetic recovery **only**, the standalone
`npm run vault:import-lock:release-prewrite-staging` command can clear
`state='acquired'` (no GitHub write begun) using an exact-operation,
exact-start-time CAS and a metadata-only audit receipt in a **single MongoDB
majority-committed transaction**. The CLI hard-refuses production/Atlas/remote
databases and accepts only localhost:27017 replica sets with the explicitly
disposable `oge_vault_recovery_staging_*` database name. It additionally
requires full owner/session/repo/operation IDs and separate maintenance and
review attestations, none of which are cryptographically verified. It does
not touch encrypted drafts, subject records, GitHub files or note content.

A legacy lock without the explicit state, or any
`state='github-write-possible'`, is **never eligible** for this command,
regardless of GitHub HEAD stability or age. Such incidents require a future
operator-reviewed, verified-quiescence process. No HTTP release route or
production unlock is provided.

See `docs/OGE_VAULT_IMPORT_LOCK_OPERATOR_RUNBOOK.md` for the exact
disposable staging procedure and remaining blockers.

## Phase D3b2b2c4a / Milestone #48: Read-only GitHub import-attempt evidence

A safe, **metadata-only** operator inspection supplements the previous
owner-approved full-archive reconciliation. Before a selected create-only
GitHub import can write, its durable owner-row lock now also stores the
approved `expectedHead` as `approvedHead` and canonical `selectedIds`
(up to 12) along with its SHA-256 commit message fingerprint. This is
ownership-scoped UUID and commit metadata only: **no note bodies, headings,
archive text or GitHub blobs are stored in MongoDB**.

The independent opt-in operator CLI is
`npm run vault:import-attempt:inspect`, requiring
`OGE_VAULT_IMPORT_EVIDENCE_READ_ONLY=YES_METADATA_ONLY`, a specific
MongoDB database, exact owner/session/repo/operation scope and the verified
private GitHub App installation. It is **not a user-facing HTTP endpoint**
and does not release locks, delete drafts, or write to GitHub. Both private operator-inspection commands request GitHub installation tokens scoped to **contents:read** and metadata:read; the ordinary Save/import writer retains its separate write-capable token.

The read-only checker verifies the owner mapping and exact
`github-write-possible` lock, takes a pinned GitHub HEAD, walks at most
20 single-parent commits, and checks that the candidate commit is directly
based on the approved target HEAD with the expected SHA-256 commit marker.
The complete original/import Git tree leaf delta must consist solely of
newly created selected Notes paths; HEAD and account lock are rechecked
before reporting. Unexpected GitHub changes, nonlinear histories, missing
or invalid metadata, stale sessions and unverified provider state fail
closed. Results never include private owner IDs, note IDs, GitHub SHAs,
credentials, ciphertext or note content.

A result of `MATCHING_IMPORT_COMMIT_METADATA_ONLY` is **candidate
evidence, not verification of the original archived note bytes**, and
never establishes worker quiescence or permission to unlock or retry.
The original owner-approved archive and separate signed read-only
`POST /api/vault/backup-import/reconcile` still provide the stronger
canonical content comparison. No production recovery for possible GitHub
writes is enabled. This implementation remains subject to live signed
two-device/staging acceptance and security review.

## Phase D3b2b2c4b / Milestone #49: Archive-bound content proof for a quarantined import

The read-only #48 operator checker can identify a GitHub commit matching
stored metadata; it cannot independently verify what note text the owner
approved. Milestone #49 implements a **separate, opt-in, read-only**
`npm run vault:import-archive:prove` CLI and a signed,
`github-write-possible` lock-bound proof engine.

The CLI requires the exact original four-field owner-approved request in
a local, operator-owned regular JSON file with `0600` permissions,
no symlink following, a verified stable file size and the existing strict
8MiB+request-overhead limit. It requires a specific MongoDB database, exact
owner/session/repository/operation identity, verified private GitHub App,
and `OGE_VAULT_IMPORT_ARCHIVE_PROOF_READ_ONLY=YES_EXACT_ARCHIVE_ONLY`.
The private note text is loaded only into the process for canonical proof;
it is never logged, returned, or stored in MongoDB.

Before accessing GitHub blobs, the helper verifies the durable lock's
approved GitHub HEAD, exact selected IDs and SHA-256 commit fingerprint
match the canonical approval. It then reuses the existing 20-commit,
single-parent, immutable-blob reconciliation including original note
contents, complete tree delta, owned subjects and branch-head stability.
The exact signed owner and lock are checked again after reconciliation.
Only redacted historical-confirmation status and counts are reported.
Selected encrypted draft **existence only** is observed; drafts and
confirmed GitHub files are never modified.

This **can prove historical content equality** when all evidence remains
available, unlike #48's candidate-only metadata inspection. It still
cannot prove the old worker has stopped, cannot authorize a production
unlock, cannot claim notes are unchanged today if later commits modified
them, and cannot allow automatic retries or draft deletion. The operator
CLI has no HTTP route and uses GitHub `contents:read` permissions; the
read-only client now also rejects non-GET content calls.

Synthetic and disposable MongoDB replica-set tests cover altered archive,
wrong owner/session/operation, corrupt immutable blobs, changed GitHub
HEAD, moved owner lock, draft preservation, redacted results, unsafe local
file permissions and symlink rejection. Live GitHub authenticated
two-device acceptance and full recovery approval remain pending.

## Phase D3b2b2c4c / Milestone #50: Deterministic two-device staging acceptance

New `tests/mongodb-vault-two-device.test.js` runs in the isolated
`localhost:27017` disposable Mongo replica-set CI gate with a
`oge_ci_multidevice_*` auto-dropped database. The test harness combines
**real MongoDB account/subject/draft synchronization**, signed owner-epoch
checks, create-only approved import re-planning and exact immutable
archive-content reconciliation with a **synthetic GitHub ref/commit/blob
provider**. No real GitHub accounts or note bodies are touched.

The three acceptance scenarios check:
1. an in-flight encrypted draft autosave blocks a simultaneous selected-note
   import; once the draft finishes, fresh import re-planning refuses to
   overwrite its note ID;
2. a signed import already holding `github-write-possible` blocks another
   device's autosave (no draft mutation), then returns to normal encrypted
   autosave after the import is confirmed and its lock released;
3. an ambiguous GitHub acknowledgment after a simulated persisted commit
   leaves durable owner quarantine. New autosave and import remain blocked
   while read-only original-archive immutable-blob verification may still
   confirm historical note contents without deleting drafts, retrying the
   remote write or releasing the lock.

The tests verify no private plaintext is inserted into permanent MongoDB
owner records, preserve encrypted drafts, and use unique per-test databases
with no network access to GitHub. See
`docs/OGE_VAULT_TWO_DEVICE_STAGING_ACCEPTANCE.md` for test commands and a
separate acceptance matrix.

**This is synthetic provider acceptance, not complete live authenticated
two-browser/OAuth/GitHub-App staging signoff.** Subject deletion interactions,
cross-subject edits, real GitHub throttling/conflicting refs, session
revocation and browser sessionStorage recovery require further signed
staging. Production flags are still disabled. No production migration or
merge is authorized.

## Phase D3b2b2c4d / Milestone #51: Late owner revocation and staging readiness

The owner-approved create-only import executor now checks the same signed
account incarnation and connected GitHub Vault mapping **again**, after its
durable `github-write-possible` marker and immediately before the GitHub
batch writer. A changed owner session or revoked/replaced GitHub
installation at this point blocks the remote writer. The outer import lock
remains in conservative quarantine rather than treating a no-write failure
as permission for automatic unlock. This reduces one important
time-of-check/time-of-use window; it does **not** provide a cross-service
atomic guarantee against a later provider revocation.

New real disposable MongoDB replica-set acceptance tests use simulated
GitHub content and two concurrent devices to verify the account-wide
import/draft fence **across different subjects**, including a different
subject for the same note UUID. A draft written before import remains
encrypted and causes a fresh conflict, while a draft attempted during
another subject's import receives 409. The tests also revoke the DB
installation mapping or change the signed session epoch between the
durable marker and the GitHub writer; no remote note content is written
and the lock stays protected.

`npm run vault:import:staging-preflight` is a separate, **no-network,
no-database, configuration-only** readiness check for an isolated
**synthetic-account** import rehearsal. It verifies all required preview
gates, disabled destructive/recovery controls, dedicated staging
credentials and an explicit acknowledgment. It does **not** enable any
flag, mint a GitHub token, test actual provider permissions or certify
live OAuth/browser acceptance. See
`docs/OGE_VAULT_TWO_DEVICE_STAGING_ACCEPTANCE.md` for the remaining
real two-browser GitHub installation and mobile/429/revocation cases.

## Next: Full import recovery and backup coverage (not implemented)

A safe GitHub-backed replacement must:

1. Extend the implemented strict archive and target validation with live
   authenticated write-path, draft-race and stale-plan acceptance tests.
2. Integrate accessible owner approval into the UI and safe recovery UX.
   Never treat an uploaded source SHA or previous plan as write authority.
3. Extend the bounded create-only commits with complete multi-batch
   recovery and evidence that concurrent temporary drafts remain intact.
4. Extend exports to complete, verifiable pagination for larger vaults,
   and separately cover revision history, Quick Notes, AirNotes, subject
   metadata, progress and explicit retention requirements.
5. **Never** import confirmed note content into MongoDB, even via the
   legacy backup JSON format; note bodies belong in the owner's GitHub Vault.
6. Specify interrupted-commit reconciliation, partial-batch rollback and
   session/repository revocation behavior, with no blind GitHub write retry.
7. Pass signed staging GitHub/MongoDB, two-device conflict, mobile recovery,
   large-vault rate-limit and privacy acceptance before any production release.

No migration or cleanup of existing data is authorized by this document.

## Current evidence and release blockers

- Automated unit tests exercise valid history reads, immutable blobs, HEAD
  drift, invalid trees, deleted revisions, subject mismatch and expected-SHA
  restore conflicts.
- CI browser smoke remains anonymous; signed OAuth and live GitHub App history
  restoration have **not** been exercised.
- The revision preview is capped to recent note history, the current-Notes
  export is size bounded, and Notes-only import has a **read-only planner and
  separately disabled create-only approved commit API**. Full history, multi-resource export, large-vault
  pagination, conflict resolution, merge-aware/deep-history recovery and
  owner-facing import recovery and production release of uncertain GitHub write locks remain unimplemented.
- PR #35 remains draft. Keep `OGE_VAULT_REVISION_PREVIEW=false` outside
  isolated staging until security and explicit release approval.
