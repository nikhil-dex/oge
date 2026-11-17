# Oge Vault — Milestones #46–49: import-lock triage and GitHub proof

**Status:** #46 read-only operator inspection and #47 disposable-local-only
prewrite lock recovery are implemented in code. **No production release of an
uncertain or post-GitHub-write lock is implemented or authorized.**
Signed live provider staging is still pending.

This runbook is for an authorized incident responder in a controlled,
private environment. It does not give a browser user or an ordinary notes
route access to operator recovery. The default inspection command is **read-only**; a separate exact prewrite
recovery command is restricted by code to a disposable local replica set.

## Why it stays locked

An interrupted import may have already advanced the owner's GitHub branch
even if its HTTP response never arrived. A MongoDB `vaultImportLock` has
**no TTL**. It may represent an active operation, crashed process or failed
release. Even a many-days-old lock, a stable GitHub HEAD and zero active
writer counters cannot prove the original GitHub request has stopped.
Automatically clearing it could permit a duplicate import or conflicting
autosave. Do **not** remove, replace, shorten, expire or reset this lock based
on age or this inspector's output.

## 1. Establish incident scope (offline)

1. Identify the exact owner account incarnation/session version, connected
   private GitHub repository ID and current `vaultImportLock.operationId`
   from a trusted, access-controlled incident record. Do not collect note
   titles, bodies, draft ciphertext, login tokens or full private documents.
2. Check that the operator has permission for this **specific** incident.
   Stop new imports on the isolated staging deployment; arrange a maintenance
   window that **quiesces all application instances and background writers**.
   Do not assume a stopped web request means a GitHub PATCH has stopped.
3. Preserve existing encrypted drafts and owner/repo metadata. Never
   silently discard the browser's unsynced session data.
4. If exact operation/session scope is unknown or conflicting, **STOP**.
   Do not guess it, use a different account's credentials or mass unlock.

## 2. Run redacted metadata inspection

Use a private terminal with an existing, authorized MongoDB URI and GitHub App
configuration. Provide all required environment values through the operator's
secret manager, **not** shell history, committed files or CI logs:

- `MONGODB_URI`, `MONGODB_DB`: explicitly chosen target database; no
  implicit production fallback
- `OGE_VAULT_INSPECT_OWNER_ID`: exact owner record ID
- `OGE_VAULT_INSPECT_SESSION_VERSION`: exact active account session version
  (`0` only for a genuine legacy account incarnation)
- `OGE_VAULT_INSPECT_REPO_ID`: the owner's exact connected Vault repo ID
- `OGE_VAULT_INSPECT_OPERATION_ID`: exact stored import-lock operation UUID
- `OGE_VAULT_IMPORT_LOCK_INSPECT_READ_ONLY=YES_REDACTED_ONLY`

Then run:

```sh
npm run vault:import-lock:inspect
```

The script uses the MongoDB driver **directly**, not `getDatabase()` (which
could create indexes). It reads only projected owner lock and writer counters,
bounded existence checks of encrypted drafts and subject writers, and two
GitHub branch HEAD readings via the verified private GitHub App installation
token. No note blobs, note contents, draft ciphertext, GitHub commits or
remote files are downloaded. GitHub App token issuance may use GitHub's
token-minting POST but **does not mutate GitHub note content**.

Output is limited to status codes, booleans, a broad lock-age band and
reasons for manual review. It must never print the supplied IDs, repo ID,
HEAD SHA, raw user row, operation UUID, tokens, connection string or notes.
The HEAD and MongoDB readings are **not one atomic snapshot**.

Exit codes:

- **0** — `NO_LOCK_PRESENT`: no matching lock was observed; not proof a
  previous import completed successfully
- **2** — `MANUAL_OPERATOR_REVIEW_REQUIRED` or another blocked state;
  do not unlock
- **1** — configuration, database or provider inspection error;
  fail closed and escalate

A `githubHeadStable: true` and
`ownerSnapshotStable: true` remain **advisory only**.
`automaticUnlockAuthorized` and `operatorUnlockAuthorized` always remain
**false** in this inspection tool.

## 3. Investigate before any separate recovery approval

1. Use the owner's original approved archive **privately** with the existing
   read-only `POST /api/vault/backup-import/reconcile` in isolated staging
   (if the exact signed owner and provider configuration is available).
   Note its 20-commit, single-parent window. A result of
   `confirmed: false` is **unknown**, not an invitation to retry.
2. If the import is historically confirmed, compare
   `currentNotesChanged` and `currentHead` with the incident record and
   preserve later user edits. If confirmation is unavailable, escalate to
   a signed GitHub investigation without uploading note content to logs.
3. Identify every still-running writer, orphaned process, pending GitHub
   request, locked subject and encrypted draft. Keep the account quarantined
   until the team can prove quiescence and resolve ambiguous commit responses.
4. Have an authorized second reviewer confirm exact owner, repo, operation,
   incident timeline, and the proposed action. Retain an access-controlled
   audit record **without** private note text or credentials.

Milestone #46 inspection alone never authorizes a release. Only the narrowly
scoped disposable-local #47 prewrite tool documented below may mutate an
`acquired` lock for synthetic staging incidents. Never use an ad hoc,
unscoped MongoDB update to bypass a lock.

## 4. Milestone #47 — Dispose-only prewrite lock recovery

**Not for Atlas, a production database, real user data, or a possibly started
GitHub mutation.** The new import write path persists the
`vaultImportLock.state='github-write-possible'` marker, approved commit
fingerprint and timestamp **before** invoking the GitHub batch writer.
Any error after that point retains the lock. The #46 inspector reports this
only as a redacted phase.

For a **synthetic disposable** incident with exact
`vaultImportLock.state='acquired'` (before a GitHub write):

1. Establish an isolated localhost:27017 MongoDB **replica set** with a new
   dedicated database named `oge_vault_recovery_staging_<identifier>`. This
   CLI refuses `mongodb+srv://`, remote/Atlas MongoDB, other database names
   and non-replica-set servers.
2. Stop all application instances and background writers of that synthetic
   environment and have a separate reviewer inspect the original lock,
   exact signed account session and repository, and the incident record.
   The environment variables asserting maintenance and independent review
   are **human attestations**, not cryptographic identity verification.
3. Provide all exact scope variables from Section 2 plus the
   `OGE_VAULT_RELEASE_STARTED_AT` immutable ISO-8601 millisecond timestamp
   and `OGE_VAULT_RELEASE_INCIDENT_ID` incident UUID, through a private
   secret manager. Do not write them into the repository or shell history.
4. Supply the following deliberate, **non-default** attestations:
   `OGE_VAULT_PREWRITE_RELEASE_STAGING_ONLY=YES_DISPOSABLE_PREWRITE_ONLY`,
   `OGE_VAULT_MAINTENANCE_QUIESCED=YES_ALL_WRITERS_STOPPED`,
   `OGE_VAULT_INDEPENDENT_REVIEW=YES_SEPARATE_APPROVER` and
   `OGE_VAULT_PREWRITE_RELEASE_CONFIRMATION=RELEASE_ONLY_PRE_GITHUB_WRITE_LOCK`.
5. Only within that disposable environment execute
   `npm run vault:import-lock:release-prewrite-staging`.

The transaction atomically checks the exact owner session, connected repo,
operation UUID, start time, `state='acquired'`, no active draft writers and
no active subject writers. It clears only the matching import lock and inserts
one metadata-only `vault_import_lock_recovery_audit` record in the same
majority-committed transaction. If the record insertion fails, the removal
rolls back. Neither GitHub files, imported notes, encrypted drafts nor subject
metadata are touched. Replaying the command cannot release a second lock
because the old operation ID and timestamp must match.

A `legacy-unknown` lock or any `github-write-possible` state **always**
fails this release CAS, regardless of age, apparent HEAD stability, operator
assertions or positive GitHub evidence. For those cases, leave the lock in
place and escalate for stronger provider-backed proof, verified worker
quiescence and a separately reviewed controlled-recovery design. No
production-ready or automatic unlock workflow is shipped.

The `vault_import_lock_recovery_audit` collection is protected by the
account-deletion retention guard. It contains only incident/account/operation
metadata and the recovery type; no note bodies or draft ciphertext.

## 5. Milestone #48 — Independent GitHub import-attempt evidence (read-only)

After an import with `vaultImportLock.state='github-write-possible'`
reports an uncertain response, an authorized operator may inspect whether
GitHub contains an **import-shaped candidate commit** without reading the
owner's archived note bodies. New imports durably save only
`approvedHead`, `selectedIds` (one to twelve UUIDs), the approved SHA-256
commit marker, operation ID and timestamp in the owner-row lock. This is
**non-content incident metadata**, not an independent proof of archived bytes.

Use a private terminal with the same exact `MONGODB_DB`, `MONGODB_URI`,
`OGE_VAULT_INSPECT_OWNER_ID`, `OGE_VAULT_INSPECT_SESSION_VERSION`,
`OGE_VAULT_INSPECT_REPO_ID` and `OGE_VAULT_INSPECT_OPERATION_ID`
from the signed incident; also require the repo-scoped GitHub App credentials.

Opt in with `OGE_VAULT_IMPORT_EVIDENCE_READ_ONLY=YES_METADATA_ONLY`, then:

```sh
npm run vault:import-attempt:inspect
```

This **operator-only**, read-only command checks the signed owner/connected
repository and exact lock. It reads Git commit/tree **metadata only**. It
walks no more than 20 single-parent commits from the current GitHub HEAD,
checks that a candidate import's parent is the owner-approved HEAD and its
commit message has the stored fingerprint, then compares complete immutable
base/import trees: only the approved selected note files may be created.
It rechecks GitHub HEAD and owner lock after inspection.

The CLI mints a **contents:read**, metadata:read, repository-restricted GitHub App token (rather than write-capable note permissions) and prints redacted, non-authorizing status flags only. The status
`MATCHING_IMPORT_COMMIT_METADATA_ONLY` is **not** full verification that
the immutable note file bytes equal the original backup. GitHub commit
metadata, even when apparently matching, cannot prove an old worker has
stopped. It does not write to GitHub, decrypt drafts, remove locks, or
authorize retry. The command always returns nonzero exit status for
an inspected incident; errors are sanitized and a 429 must fail closed.

The original owner-approved archive and signed read-only
`POST /api/vault/backup-import/reconcile` remain necessary for full
canonical note-content reconciliation. Do not automatically retry or
release any `github-write-possible` or legacy lock, even after a positive
candidate metadata check. Deep histories, merges and ambiguous results
require human investigation. Live signed staging, verified operator
quiescence and production recovery remain incomplete.

## 6. Milestone #49 — Read-only canonical archive verification for an uncertain import

Only an authorized operator who possesses the owner's **original four-key
approved import request**, including the selected IDs and full private
backup archive, may perform a stronger content check of a
`github-write-possible` lock. The independent #48 metadata-only check does
not need the archive, but cannot validate original note bytes.

Supply an **absolute path** to a private JSON file containing exactly the
approval body previously sent to the create-only import route
(`archive`, `expectedTargetHead`, `selectedIds`, `confirmation`).
The local file must be owned by the operator, regular, non-symlink, readable
with permission mode `0600` (or stricter), no more than the 8MiB archive
bound plus request overhead, and unchanged during read. Use a private
encrypted-volume/secret-management workflow and never put the JSON or
private note contents into CI logs, shell history, tickets or GitHub commits.

Along with explicit `MONGODB_URI`, `MONGODB_DB`, private GitHub App
credentials and the same exact signed-owner `OGE_VAULT_INSPECT_*` scope
used for #46/#48, supply the *unset-by-default* variables
`OGE_VAULT_IMPORT_ARCHIVE_PROOF_READ_ONLY=YES_EXACT_ARCHIVE_ONLY` and
`OGE_VAULT_IMPORT_APPROVAL_FILE=/absolute/private/approval.json`.

Then execute:

```sh
npm run vault:import-archive:prove
```

This CLI requests a repository-scoped GitHub installation token with
**contents:read** (not write). It refuses a missing/inconsistent lock,
target HEAD, commit digest, selected IDs, owner session or repository
mapping **before GitHub verification**. For an exact match it runs the
existing signed read-only 20-commit-window reconciler: verifies immutable
Git blob bytes against the original canonical archive notes, the approved
commit's parent/digest, complete tree delta, owned subjects and stable
GitHub HEAD. It rechecks the exact MongoDB lock afterwards, and checks only
the **existence** of encrypted drafts for those selected IDs. It never
persists the private archive or prints note text, IDs, credentials, tokens,
GitHub SHAs or draft contents.

Output is a redacted result such as
`ARCHIVE_IMPORT_CONFIRMED_HISTORICALLY` or
`ARCHIVE_IMPORT_NOT_CONFIRMED`, with note counts and later-change counts.
The CLI exits nonzero even on historical confirmation. A mismatch, changed
owner, altered lock or unavailable GitHub state fails closed.

**Historical content verification is not permission to unlock or retry.**
A newer commit may already have changed or deleted a note, and neither a
stable branch HEAD nor the best cryptographic content proof proves the old
worker is quiescent. No post-GitHub-write import-lock release implementation
has been authorized. Keep the lock quarantined until an externally verified,
independently reviewed maintenance and recovery process exists.

## Release gates

- API import/reconciliation flags remain disabled outside isolated staging
- No automatic TTL, lock-age threshold or background unlock
- No note content imported to MongoDB
- No receipt/draft deletion or GitHub write from this operator inspection
- PR #35 stays draft and unmerged until security review and live acceptance

## E9 / Milestone #77: standalone restore uncertain-write inspection

A new **read-only** protected-staging endpoint for **uncertain M75/M76
Quick Notes or AirNotes restore attempts** is documented in
`docs/OGE_VAULT_STANDALONE_RESTORE_RECONCILE_E9.md`. It validates the
exact signed account, owner lock operation ID/marker/approved target HEAD/
selected UUIDs, matching claimed or confirmed M76 receipt, then walks
at most 20 immutable single-parent Git commits and compares complete
before/after leaf diffs and every selected canonical private blob against
the original archived source (held only in memory). It distinguishes
historical creation from later edits/deletions. All reports forbid
automatic retry or unlock and DO NOT prove the original GitHub
worker has stopped, authenticated source provenance, or operator
release authority. The existing #47 prewrite-only release CAS still
refuses any `github-write-possible` lock. All production flags OFF.

## E10 / Milestone #78 — No-release quarantine recovery review

A new independently default-OFF protected staging-only
`POST /api/vault/backup-current-resources/recovery-review` correlates
M77's exact signed-owner historical GitHub/lock/receipt proof with bounded
owner/repo-scoped active draft writer counters, active subject writers,
pending encrypted Notes/Quick Notes/AirNotes drafts and additional
claimed/unresolved M76 receipts. It compares before/after metadata and
rechecks signed owner and GitHub HEAD; inconsistencies fail closed.
The redacted incident review fingerprint is **only for correlation, not
a signature, approval or safe-release token**. Every outcome remains
`HOLD_*` with detailed blockers, no Git/Mongo content writer, no
automatic retry and **no postwrite lock release**.
Even verified historical content does NOT prove a prior GitHub PATCH has
stopped or establish archive-source provenance. The original M47 helper
still releases ONLY `acquired` prewrite staging locks.
See `docs/OGE_VAULT_STANDALONE_QUARANTINE_REVIEW_E10.md`.
