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

## Milestone #56 — Bounded historical GitHub source provenance

Milestone #55 only verified a downloaded chunk set while its GitHub
source snapshot was still the signed owner's **current HEAD**. To
support a backup taken shortly before a later Save, #56 provides
a **separately opt-in, read-only** historical source verifier:

```sh
# Set the explicit operator-only flag in the PRIVATE terminal, not
# in production environment or committed application config:
# OGE_VAULT_CHUNK_SOURCE_HISTORY_READ_ONLY=YES_20_LINEAR_ANCESTORS_ONLY
npm run vault:chunk:verify-history
```

Use the same exact `OGE_VAULT_INSPECT_OWNER_ID`,
`OGE_VAULT_INSPECT_SESSION_VERSION`,
`OGE_VAULT_INSPECT_REPO_ID`, private GitHub App and explicit
`MONGODB_URI`/`MONGODB_DB` as the #55 source checker.
`OGE_VAULT_CHUNK_PLAN_DIRECTORY` still requires one operator-owned
**0700 directory** with contiguous, owner-only **0600** private chunk
files. **Unset** the older
`OGE_VAULT_CHUNK_SOURCE_PROOF_READ_ONLY` flag: #56 refuses missing,
ambiguous or simultaneous current/historical operator consent.

For a complete self-consistent chunk set (at most **1,024 current Notes
across 16 parts**), the verifier first checks the exact signed account
and pinned HEAD of its **connected private source GitHub Vault**.
It follows that HEAD's **single-parent Git commit chain**, at most
**20 newer commits**, until it reaches the backup's original snapshot.
Invalid/cyclic history, merge commits, a detached/unreachable snapshot,
expired source installation, or history beyond the 20-step bound cannot
be accepted as proof. Only after establishing this ancestry does it
read the complete **historical Git tree** and verify all note IDs,
Git blob SHAs and canonical note contents against raw immutable
GitHub blob bytes. It checks that branch HEAD and the signed owner
mapping are still unchanged at the end.

The report contains only redacted counts, `commitsAfterSnapshot`,
`sourceHistoricalSnapshotVerified` and non-authorizing verification
fields. It does **not** report owner IDs, private note text, commit SHAs
or GitHub tokens. It has `canCommit:false`,
`authorizesRestore:false`, `canUnlockImport:false` and
`canRetryAutomatically:false`. The previous
`npm run vault:chunk:verify-source` behavior remains current-only
unless the independent #56 opt-in is deliberately provided.

**Historical provenance does not imply the notes still exist in current
GitHub HEAD.** A newer commit may have edited or deleted some Notes.
It does not constitute a durable signed backup, proof after repo
deletion, authorization to import, a recovery/quiescence assessment,
or a full multi-resource archive. There is no #56 GitHub write,
MongoDB plaintext cache, chunk restore approval or automatic replay.

Automated synthetic tests exercise 0, 1, 3, 19, and 20 newer commits,
21-commit rejection, merges, cycles, detached history, a forged note
body with recomputed local checksums, shifted branch HEAD, revoked
signed account and a 520-Note, over-8-MiB historical backup.
**Real authenticated GitHub App/two-device staging is not signed off.**

## Milestone #57 — Authenticated, create-only single-batch intent (NO RESTORE WRITE)

The #56 historical source proof can show that downloaded Notes chunks match
the signed owner's own private GitHub Vault, even after up to 20 *linear*
newer commits. #54's destination planner can report existing note/draft
conflicts. Milestone #57 **connects these checks** to a deliberately
non-authorizing, bounded selection for preparing a future restore.

An operator with exact signed owner/repo context can run:

```sh
npm run vault:chunk:batch-intent
```

This uses the existing private chunk planning script in a **separate,
explicitly opt-in** mode:
`OGE_VAULT_CHUNK_BATCH_INTENT_READ_ONLY=YES_EXACT_VERIFIED_SELECTION_ONLY`.
Leave `OGE_VAULT_CHUNK_RESTORE_PLAN_READ_ONLY` **unset**. Both flags or
missing consent are refused. The source and destination must be the
**same signed owner-connected GitHub Vault**. Cross-account, disconnected
source, arbitrary detached revision and source deletion are unsupported.

Point `OGE_VAULT_CHUNK_PLAN_DIRECTORY` at the existing operator-owned
0700 directory containing sequential 0600 `part-0001.json`, etc.
Provide `OGE_VAULT_CHUNK_BATCH_SELECTION_FILE` as an **absolute path** to
a separate owner-only 0600 regular, non-symlink JSON file, no more than
4 KiB, with exactly these fields:

```json
{
  "confirmation": "PREPARE_CREATE_ONLY_RESTORE_BATCH",
  "expectedSourceSnapshot": "<40 lowercase hex Git commit SHA>",
  "expectedSourceInventorySha256": "<64 lowercase hex inventory digest>",
  "expectedTargetHead": "<40 lowercase hex current destination HEAD>",
  "selectedIds": ["<one to twelve unique lowercase note UUIDs>"]
}
```

The values must be explicitly selected from an earlier **read-only**
plan, and the destination HEAD must be the owner-reviewed current Git
revision. The command checks private permissions, file structure and
scope **before MongoDB or GitHub access**. For this phase the signed
GitHub installation is read-only (`contents:read`), and the process
never calls a GitHub mutation or changes a MongoDB draft or owner lock.

The `prepareVaultChunkRestoreBatchIntentReadOnly()` engine first validates
the entire source chunk sequence and **all** immutable raw GitHub note
blobs (up to 1,024 notes) against the signed current or bounded historical
source tree. It binds the selected 1–12 note IDs to their exact source
blob SHAs and canonical note-content SHA-256 digests without retaining
note plaintext. Then it checks the selected subjects belong to the
signed owner, the **entire** current destination Git tree is canonical,
the destination HEAD has not changed, and none of the selected IDs would
overwrite an existing GitHub note or collide with an unsaved encrypted
MongoDB draft. An encrypted draft conflict takes precedence over an
existing GitHub note conflict.

The result contains only the selected note UUIDs and their
`create-candidate`, `existing-note-conflict`, or `draft-conflict`
statuses, the bounded counts and a deterministic **SHA-256 intent
fingerprint**. That fingerprint binds the checked *source content
metadata, selection order and destination HEAD*. It is a review aid,
**not a signature, approval token, bearer capability or authorization
to write**. `eligibleForIndependentApproval:true` means only that
no known conflict was present at inspection time; it never means a
write was authorized. Every response explicitly says
`canCommit:false`, `commitAuthorized:false`,
`requiresFreshUserApproval:true`, and
`requiresIndependentWriteRecovery:true`.

**There is NO large-vault create-only commit or multi-batch restore
executor in M57.** Do not pass the returned fingerprint to the ordinary
import route, bypass the existing 12-note approval, automatically retry
a lost GitHub acknowledgment, release an uncertain import lock, or
delete drafts. Actual safe writes require a new signed owner approval,
reverification inside an exclusive MongoDB owner/subject fence, an
atomic Git non-force ref CAS, durable metadata-only recovery evidence,
and a verified post-write reconciliation for each bounded batch.

Synthetic tests cover 130- and 520-note downloaded source backups,
forged SHA/inventory/selection, current target HEAD drift,
same-ID GitHub and encrypted draft conflicts, selected-subject and
session revocation, stable fingerprint binding and refusal to mutate
GitHub. Private CLI tests check invalid opt-ins, unsafe permissions,
directory extras and symlinked approval files.

## Milestone #58 — One verified restore batch with real Git CAS (internal only)

Milestone #57 prepared a fully source-verified, create-only single-batch
**intent** but could not write. Milestone #58 introduces a separate
`executeApprovedVaultChunkRestoreBatch` internal backend that can
execute exactly **one 1–12 Note GitHub commit**, guarded by the existing
signed owner's import-exclusive and subject-specific fences.

**No HTTP route, operator CLI, background job, or production user UI
invokes this executor.** The module refuses to operate unless all
existing Vault Notes/import preview flags and independent
`OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW=true` and
`OGE_VAULT_CHUNK_RESTORE_WRITE_ACK=YES_DISPOSABLE_SIGNED_STAGING_ONLY`
are supplied by a trusted application caller. They remain **OFF** and
must not be configured in production. A staging browser/owner-approval
entrypoint remains future work.

The distinct, exact six-key application approval is:

```json
{
  "confirmation": "COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY",
  "expectedSourceSnapshot": "<40 lowercase Git commit SHA>",
  "expectedSourceInventorySha256": "<64 lowercase SHA-256>",
  "expectedTargetHead": "<40 lowercase current Git branch HEAD>",
  "selectedIds": ["<1–12 unique lower-case UUIDs>"],
  "expectedSelectionFingerprint": "<64 lowercase M57 intent digest>"
}
```

The M57 preview digest is a review fingerprint, **not** a signature or
bearer credential. The M58 backend requires this **separate explicit
commit confirmation** and re-computes it with all current trusted
context before any GitHub write. It is not interchangeable with the
M57 read-only confirmation or the original 8-MiB one-shot import.

Within the existing durable owner-exclusive import lock (which
blocks all concurrent draft writes), it validates the **whole**
downloaded Notes sequence (up to 1,024 current Notes, 16 chunks),
pins the same signed private source GitHub Vault at current HEAD or
within 20 linear ancestors, independently verifies every raw
historical Git blob SHA-1 and canonical note body, and checks the
exact selected fingerprint, destination HEAD, target subject
ownership, and MongoDB encrypted-draft conflicts. The selected
1–12 note blobs are reread by immutable Git SHA and canonical
content SHA-256 after proof.

The backend then acquires the selected subject locks and reuses
the **existing** `executeApprovedVaultNotesImport` path with a
temporary <=12-note, <=8-MiB source-verified miniarchive in
process memory. The existing executor performs **fresh** owner,
subject, draft, target HEAD and Git tree create-only checks, then
durably marks the exact metadata-only
`vaultImportLock.state='github-write-possible'` before invoking
`commitVaultNoteBatch`. This real writer uses GitHub's non-force
branch-ref CAS and verifies the resulting commit, ancestry, HEAD
and note contents. No permanent note text is stored in MongoDB.

A verified single-batch success releases the exact matching
owner lock and returns only selected UUIDs, commit SHA and
counts. If a provider response is lost after a Git mutation
**might have started**, the owner lock is deliberately retained,
other device autosaves/imports remain blocked, and the system
does **not** retry, automatically resume, clear the lock, or
delete any encrypted draft. Real operator reconciliation and
maintenance quiescence are still a separate release gate.

M58 integration tests use a **disposable real MongoDB replica set**
with a **synthetic GitHub object store and actual production Git batch
writer**. Tests verify one successful create-only commit, no
replay after an ambiguous post-commit HEAD response, retained owner
quarantine, selected draft conflicts, wrong target SHA/fingerprint,
unchanged owner records and default-off refusal. These are NOT
authenticated live GitHub staging tests or authorization to activate
this executor for actual user accounts.

**Still pending:** a separately signed browser/CLI restore entrypoint,
independently confirmed user consent, multiple-batch resume
and partial-progress ledger, exact historical recovery from
disconnected/deleted repositories, safe operator resolution of
uncertain locks, Quick Notes/AirNotes/full-resource backup and
production cutover.

## Remaining release blockers

An explicitly approved assembly and restore workflow (including
cross-chunk approval/conflict handling and immutable Git CAS), real
authenticated two-device GitHub staging, 429/backoff and browser download
acceptance, complete multi-resource export, retention/privacy review and
owner-facing recovery are **still required before production**.

**Do not merge PR #35 or enable preview flags in production.**
