# Oge Vault — Phase D3: GitHub revision history and backup architecture

**Status: bounded GitHub revision read/restore, Notes-only export, read-only
import planning and separate create-only, explicitly owner-approved import
commit preview implemented. The import route is default-off and untested with
live authenticated staging. Full backup, cross-request recovery and production
cutover remain pending.**

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
archive and selected UUIDs, checks current subject ownership and then pins
the current GitHub HEAD. It confirms only when the HEAD is the **direct child**
of the approved HEAD, the immutable commit has the exact marker, the selected
note paths did not exist in the approved base tree, the new immutable blobs
match the canonical archived notes, and no unrelated files were modified.
The branch HEAD and signed owner mapping are checked again before reporting
success. The result contains only imported note IDs and the commit SHA, with
`confirmed`, `readOnly`, `safeToRetryAutomatically: false` and
`encryptedDraftsChanged: false`. No imported note text is returned.

If GitHub HEAD advanced beyond the direct commit, the original commit
cannot be proven by this bounded recovery endpoint: it reports
`confirmed: false`, not a failed import and not permission to retry. Import
must NEVER be blindly replayed after an unknown response, and encrypted
drafts must NEVER be retired from a reconciliation result. A later milestone
must add evidence-bounded ancestry tracking, owner-facing UI, operator lock
recovery, signed live two-device/staging tests and local-only browser draft
protection. This implementation is not full Oge backup restoration.

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
  pagination, conflict resolution and cross-request import recovery remain unimplemented.
- PR #35 remains draft. Keep `OGE_VAULT_REVISION_PREVIEW=false` outside
  isolated staging until security and explicit release approval.
