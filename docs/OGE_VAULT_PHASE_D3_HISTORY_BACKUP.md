# Oge Vault — Phase D3: GitHub revision history and backup architecture

**Status: bounded GitHub revision read/restore preview implemented; backup replacement
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

## Next: GitHub-backed backup export/import (not implemented)

The existing `/api/backup` currently exports and restores full legacy
MongoDB note bodies and embedded revision text. Phase D1 blocks that legacy
path for connected Vault owners when explicitly enabled in staging, but it
does **not** yet replace the functionality.

A safe GitHub-backed replacement must:

1. Read all note content from a **verified, stable GitHub tree snapshot**,
   with complete pagination; fail closed on truncated trees, 429s or HEAD
   drift rather than silently exporting an incomplete archive.
2. Ensure the export format is explicit about `notes`, revision history,
   Quick Notes, AirNotes, owner-subject metadata and what remains unsupported.
3. Validate import ownership, note UUIDs, subject UUIDs, file sizes, tags and
   historical commit references; never trust user-supplied Git paths.
4. Preview conflicts and require explicit owner approval before creating a
   GitHub commit. Use bounded, verified batch commits with exact expected
   blob SHAs; no unsynced encrypted draft may be lost or overwritten.
5. **Never** import committed note bodies into MongoDB (even via an older
   backup JSON format). MongoDB can retain owner metadata, approved progress
   metadata and temporary encrypted drafts only.
6. Provide a rollback/reconciliation plan for partial batch acceptance,
   interrupted responses, source account disconnection and account deletion.
7. Pass disposable signed GitHub/MongoDB staging, two-device conflicts,
   mobile browser recovery, large-vault rate-limit and privacy acceptance.

No migration or cleanup of existing data is authorized by this document.

## Current evidence and release blockers

- Automated unit tests exercise valid history reads, immutable blobs, HEAD
  drift, invalid trees, deleted revisions, subject mismatch and expected-SHA
  restore conflicts.
- CI browser smoke remains anonymous; signed OAuth and live GitHub App history
  restoration have **not** been exercised.
- The preview is capped to recent note history. Long-running or full-path
  history traversal and backup import/export still require design and tests.
- PR #35 remains draft. Keep `OGE_VAULT_REVISION_PREVIEW=false` outside
  isolated staging until security and explicit release approval.
