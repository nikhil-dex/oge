# Oge Vault — Phase D3: GitHub revision history and backup architecture

**Status: bounded GitHub revision read/restore and complete-current-Notes-only
backup export previews implemented; backup import, multi-resource export,
and live authenticated staging remain pending. No production cutover.**

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

## Next: GitHub-backed import and full backup coverage (not implemented)

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
- The revision preview is capped to recent note history, and the current-Notes
  export is size bounded. Full history, multi-resource export, large-vault
  pagination and any backup import still require design and staging tests.
- PR #35 remains draft. Keep `OGE_VAULT_REVISION_PREVIEW=false` outside
  isolated staging until security and explicit release approval.
