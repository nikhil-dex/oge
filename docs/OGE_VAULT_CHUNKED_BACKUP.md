# Oge Vault — Milestone #53: Chunked Notes-only backup preview

**Status:** implemented behind separate default-off preview gates; synthetic
large-vault tests included. **Not live authenticated staging signoff,
full-resource backup, chunk restore/import or a production cutover.**

## Why this exists

The existing `GET /api/vault/backup-export` generates one complete
Notes-only JSON archive with an **8 MiB** cap. It rightly returns HTTP 413
rather than silently truncating a larger vault. This behavior is preserved.

Milestone #53 introduces `GET /api/vault/backup-export/chunk` for a private
owner to download **bounded Notes-only parts** without holding the complete
archive in one response. This endpoint still scans the entire, strictly
validated Git tree; it never relies on the separate 500-note Contents API
listing. It reads immutable blobs for just the selected page.

Use only an **isolated staging deployment and disposable accounts**. The
new `OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW=true` flag additionally
requires `OGE_VAULT_MAIN_PREVIEW=true` and
`OGE_VAULT_BACKUP_EXPORT_PREVIEW=true`. All flags remain unset/off by
default. The endpoint requires the signed owner session and a verified
private GitHub App **contents:read** installation token; it rechecks
GitHub HEAD, owner session, repository installation and selected subject
ownership before returning a response.

## Sequence contract

1. Send a signed `GET /api/vault/backup-export/chunk` without query
   parameters. Receive a single `oge-vault-notes-backup-chunk` object.
2. Each part has up to **64 current GitHub notes** and a **4 MiB** complete
   JSON response bound. The `snapshot` is the current branch HEAD, the
   `totalNotes` is the count of all verified Notes in that Git tree,
   `inventorySha256` is SHA-256 of the entire sorted ID/blob-SHA list,
   `chunkSha256` is SHA-256 of the page's serialized `notes` array,
   and `offset`/`count` identify the exact page.
3. When `hasMore=true`, use the returned `snapshot` and `nextAfterId`
   in the next signed request:
   `GET /api/vault/backup-export/chunk?snapshot=<40-character-sha>&after=<note-UUID>`.
   A continuation cannot request an arbitrary historical commit. The
   branch must **still be at the original snapshot HEAD**.
4. Continue until `hasMore=false`, and verify every page is present,
   ordered, correctly checksummed and from the same snapshot and inventory.
   The pure local `createVaultNotesChunkSequenceVerifier()` helper
   supports incremental `accept(chunk)` then `finish()` while retaining
   **only hashes, counters and cursor state**, not note bodies. This avoids
   a second in-memory copy of the complete archive just for verification.
5. Protect the **downloaded** part files: each contains readable private
   note text. Store them in encrypted private storage. Never put them in
   project GitHub repositories, CI logs, issue comments or shared tickets.

A single part always declares `completeBackup:false`,
`importableAsLegacyBackup:false`, and
`coverage.notes='partial-immutable-snapshot-chunk'`. Even after a
verified complete **Notes** sequence, it does **not** include historical
revisions, Quick Notes, AirNotes, encrypted unsaved drafts or learning
progress. The ordinary one-shot import validator deliberately rejects
individual chunks, and **there is no production-ready chunk assembly/
restore/import workflow yet**.

## Safety and failure behavior

- Reject noncanonical/duplicate Notes paths, oversized or truncated Git
  trees, symlinks, corrupt blobs and subjects outside the owner's scope
- Reject missing/nonexistent continuation UUIDs, changed HEAD or inconsistent
  snapshot parameters with 400/409, and reject oversize single chunks with 413
- Preserve provider 429 rather than treating missing data as a complete page
- Do not automatically resume against a new HEAD. A new backup sequence must
  restart at its new snapshot; never mix parts from different revisions
- The verifier rejects skipped pages, reordering, modified note content,
  missing pages and mismatching global inventory SHA-256. Checksums are
  integrity evidence, not an alternative to a signed GitHub owner session
- No permanent Notes content, chunk text or backup payload is written to
  MongoDB. No GitHub writes and no automatic release of an import lock

The tests include a synthetic **520-note, over-8-MiB** collection that
cannot use the old one-shot response but passes the complete multi-part
SHA-256 verifier. No real user accounts or private notes are test fixtures.

## Milestone #54 — Read-only large-vault restore conflict planning

After downloading **all** chunks from the same source Notes-only Git
snapshot, an authorized operator can run an **advisory, read-only**
restore-conflict plan against a signed owner's **destination** GitHub Vault.
This does **not** reconstruct a large in-memory full archive or permit any
GitHub write.

The helper `planVaultNotesChunkRestoreReadOnly(client, chunks, checks)`
accepts an async iterable of private chunk objects. It verifies the
entire ordered sequence, per-chunk SHA-256 content and global inventory
digest **before** requesting the destination Git tree. It retains only
note UUIDs and subject UUIDs (at most 30,000 entries), not headings,
answers, source blob texts, draft contents or a combined plaintext archive.
The target side uses the full validated immutable Git tree and bounded
100-UUID lookups to distinguish absent IDs, already existing GitHub Notes,
and temporary encrypted draft conflicts, including cross-subject IDs.
The current target HEAD and signed owner/session/repo mapping are
rechecked at the end. Result output has only totals and up to 12
preview IDs/statuses; it always says `canCommit:false` and
`requiresFreshOwnerApproval:true`.

The private local operator command is:

```sh
npm run vault:chunk:restore-plan
```

It requires `OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY=
YES_VERIFIED_NOTES_CHUNKS_ONLY` as a single environment value, the
exact `OGE_VAULT_INSPECT_OWNER_ID`,
`OGE_VAULT_INSPECT_SESSION_VERSION`,
`OGE_VAULT_INSPECT_REPO_ID`, explicit database credentials, and
`OGE_VAULT_CHUNK_PLAN_DIRECTORY` set to an **absolute, 0700
operator-owned directory**. Place downloaded JSON as
`part-0001.json`, `part-0002.json`, etc. Each file must be
operator-owned, regular, non-symlink, **0600 permissions**, and
no larger than 4 MiB. Unknown names, gaps, missing pages or unsafe
permissions are blocked. File attributes are checked before MongoDB
connections or GitHub credential minting, and each part is reread
one at a time with `O_NOFOLLOW` and change detection. Output is
metadata-only; error messages never include private note text or paths.

**Critical authentication distinction:** SHA-256 checksums in these
downloaded pages can catch ordinary corruption, omissions and accidental
reordering, but the checksums are themselves part of the supplied
download. They are **not a signature** and do not prove the original
GitHub source identity or original Git blob content. The user must
independently protect/validate the backup's source provenance before
approving any future import. No authenticating source-snapshot proof,
large-vault GitHub batch write, cross-chunk resume token, or operator
unlock is provided in Milestone #54.

A positive conflict plan is not import authorization. The existing
create-only import still independently approves at most 12 notes, uses
an unchanged 8 MiB archive bound, fresh CAS locks, and refuses these
chunk objects as an archive. Do not automatically convert planner
results into writes, auto-retry failed commits, delete MongoDB drafts,
or claim these partial Notes-only files contain Quick Notes/AirNotes.

Synthetic tests cover the original **520-note >8 MiB** collection,
mixed/conflicted target IDs, missing/reordered/tampered pages, moving
HEAD, stale owner sessions, unauthorized subjects, local file
permissions/symlinks and real disposable MongoDB encrypted draft
preservation. No real production user content was accessed.

## Milestone #55 — Independently checked GitHub current-source provenance

The #54 read-only restore planner verifies downloaded SHA-256 checksums,
ordering and destination conflicts but cannot tell whether an attacker
created a **self-consistent forged backup**. SHA-256 fields included inside
an untrusted file are not a source signature. Milestone #55 adds a separate
read-only, owner-scoped source proof:

```sh
npm run vault:chunk:verify-source
```

Configure the same exact signed owner/session/private GitHub repo, explicit
MongoDB database and 0700 private directory of contiguous 0600
`part-0001.json` files from the #54 operator CLI. The **new, unset-by-default**
opt-in is
`OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY=YES_CURRENT_GITHUB_HEAD_ONLY`.
The script checks the local files before any database connection or
GitHub App credential mint. It requests **contents:read** access to only
the connected private GitHub Vault. It never writes notes or exposes
private note text or credentials in the output.

The new `verifyVaultNotesChunkGitHubSourceReadOnly()` helper:

1. Fully verifies each chunk in order and the final inventory hash before
   contacting GitHub, with a limit of **1,024 current Notes across 16 parts**.
   Only each note's UUID, blob SHA and normalized-content SHA-256 digest
   are retained, not a combined archive of note contents.
2. Rechecks the signed owner session/repo and requires the **downloaded
   snapshot to equal the connected source GitHub branch's CURRENT HEAD**.
   A stale, unrelated or unavailable source commit fails closed. The
   complete Git tree must match all downloaded note IDs and blob SHAs.
3. Independently downloads the source's immutable blobs named in that
   verified Git tree, five at a time. For **every** blob it recalculates
   Git's raw blob SHA-1 (`blob <length>\\0` plus raw bytes), strictly
   validates the note JSON schema, and compares all canonical note fields
   with the downloaded part's SHA-256 content digest.
4. Rechecks HEAD and signed owner mapping, then returns only a redacted
   count and nonauthorizing status. All GitHub operations are GETs.

A positive check is stronger than untrusted page checksums: it
confirms that these source note bytes actually appear in the **currently
connected owner's Git tree**, as seen with the signed GitHub App.
It is NOT a digital signature of a backup that would remain valid after
GitHub access is lost, does NOT support verifying a historical source
snapshot after HEAD moves, and does NOT prove the destination owner has
approved a restore. Git uses SHA-1 for object IDs; source provider
authentication and account authorization are separate requirements.

If source content was deleted, the original branch moved, the source
installation is revoked, the backup exceeds 1,024 notes, or GitHub
rate limits interrupt verification, this narrow proof cannot approve
anything. Preserve the backup privately and use the future historical
provenance/restore design, not an unsafe override.

The existing #54 destination conflict planner remains **read-only** and
still reports `canCommit:false`. Even after positive #55 provenance,
there is no authorized chunk restore write path, no automatic GitHub retry,
and no encrypted MongoDB draft deletion. Tests cover >8 MiB/520 notes,
forged JSON with recalculated local SHA-256, forged inventory/blob hashes,
corrupted raw blobs, stale HEAD, revoked owner session, rate limits,
missing pages and unsafe local files.

## Remaining release blockers

An explicitly approved assembly and restore workflow (including
cross-chunk approval/conflict handling and immutable Git CAS), real
authenticated two-device GitHub staging, 429/backoff and browser download
acceptance, complete multi-resource export, retention/privacy review and
owner-facing recovery are **still required before production**.

**Do not merge PR #35 or enable preview flags in production.**
