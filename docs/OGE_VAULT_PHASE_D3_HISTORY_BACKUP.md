# Oge Vault — Phase D3: GitHub revision history and backup architecture

**Status: bounded GitHub revision read/restore, current-Notes-only export,
and read-only import conflict planning previews implemented. GitHub import
commits, multi-resource backup and live authenticated staging remain pending.
No production cutover.**

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

## Next: Approved GitHub import commits and full backup coverage (not implemented)

A safe GitHub-backed replacement must:

1. Implement strict archive schema and content validation, ownership and
   UUID checks, original blob provenance and all target-file conflicts.
2. Preview the results before any write and obtain explicit owner approval.
   Import must not rely on the source archive's owner metadata or GitHub SHA.
3. Verify the target GitHub tree and exact note SHAs with bounded,
   non-fast-forward commits; retain encrypted pending drafts in all cases.
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
  export is size bounded, and Notes-only import currently has a **read-only
  conflict planner**. Full history, multi-resource export, large-vault
  pagination and any approved GitHub import commit remain unimplemented.
- PR #35 remains draft. Keep `OGE_VAULT_REVISION_PREVIEW=false` outside
  isolated staging until security and explicit release approval.
