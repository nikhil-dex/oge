# Oge Vault — E7 / Milestone #75: isolated owner-reviewed one-kind create-only restore

**Status:** staging-only create-only Quick Notes OR AirNotes single-batch import
with a separately reviewed intent, signed owner import fence, durable
GitHub write-possible marker, precise Git ref CAS and readback. All flags
are **DEFAULT OFF**. **Not production-ready, not complete-account recovery,
not externally authenticated source provenance, not live GitHub App acceptance.**

## Strict scope

The M73 archive is untrusted, holds private plaintext and must be independently
reviewed. Only **one resource kind** (either `quick-notes` OR `airnotes`)
and **1–12 distinct existing UUIDs from the supplied archive** may be
restored per request. No Notes, legacy MongoDB data, uncommitted encrypted
drafts, history or account metadata are imported by this path.

This is intentionally NOT a bulk auto-restoration engine and never overwrites
or deletes existing GitHub files or MongoDB drafts. Original Quick Note or
AirNote **content, title, UUID, createdAt and updatedAt** are preserved in
the private GitHub Vault. No note body is persisted to MongoDB or logs.

## Default-off configuration (disposable staging only)

```sh
OGE_VAULT_STANDALONE_RESTORE_INTENT_PREVIEW=false
OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW=false
OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK=NO
```

**Never enable the write endpoint in production.** For an isolated,
operator-approved disposable staging drill only, an administrator must
individually set all prerequisite M70/M71/M73/M74 staging preview flags,
the two standalone restore flags, a disposable
`MONGODB_DB=oge_vault_restore_staging_<disposable>`, exact
`AUTH_URL=OGE_STAGING_URL`, and only after reviewing the staging
credentials and source archive explicitly set
`OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK=YES_DISPOSABLE_SIGNED_STAGING_ONLY`.

The `checkVaultStagingReadiness` gate must pass with an isolated HTTPS
origin, `OGE_VAULT_BASE_URL` on the same origin, a matching HTTPS request
URL and matching request `Origin` header, Auth.js signed and current owner
session incarnation, exact verified private GitHub App repository and
strictly disabled destructive/cutover flags.

## Two separate HTTP actions

### 1. Prepare a read-only selection intent

`POST /api/vault/backup-current-resources/intent`

Request `application/json` with precisely:

```json
{
  "archive": "<entire M73 JSON object; NOT a pathname>",
  "kind": "quick-notes",
  "selectedIds": ["<existing UUID from backup>"],
  "expectedTargetHead": "<40-character HEAD from M74 plan>",
  "confirmation": "PREPARE_SELECTED_STANDALONE_CREATE_ONLY"
}
```

The `archive` value above is explanatory: it must be the actual complete
M73 JSON *object*, not a JSON string. A separately obtained M74 read-only
plan must have identified the target branch HEAD before initiating this
step; its output is not itself permission to write.

The endpoint validates every schema, byte size, item count, checksum
and source field, then performs a **fresh signed-owner M74 read-only
three-kind target/draft plan**, a **second exact selected-kind GitHub tree
scan**, and an **exact selected-kind MongoDB encrypted draft-ID check**.
It rejects a conflicting UUID even when that UUID is beyond the 18-entry
M74 preview. Rechecks target HEAD and user incarnation. Returns only
kind, selected UUIDs, target HEAD, source snapshot/checksum, a SHA-256
`selectionFingerprint`, and `canCommit:false`. Never returns Note text.

The fingerprint binds selected resource bodies and timestamps internally,
but it is **NOT** a trusted signature, OAuth grant, bearer token, or
source-GitHub authenticity proof. Only an operator who has independently
verified the source backup should proceed.

### 2. Explicitly commit that one reviewed batch

`POST /api/vault/backup-current-resources/commit`

Send the same `archive`, `kind`, `selectedIds` and
`expectedTargetHead`, with these distinct fields:

```json
{
  "archive": "<the same complete M73 JSON object>",
  "kind": "quick-notes",
  "selectedIds": ["<same approved UUID>"],
  "expectedTargetHead": "<same target GitHub HEAD>",
  "expectedSelectionFingerprint": "<SHA-256 from step 1>",
  "confirmation": "COMMIT_SELECTED_STANDALONE_CREATE_ONLY"
}
```

The commit endpoint is independently disabled unless the operator sets
the explicit special write acknowledgment in isolated staging. It also
requires the exact same signed-owner HTTPS `Origin` and active session.
It refuses changed archive, kind, content, timestamps, selection,
fingerprint, target HEAD, existing GitHub file, source subject ownership
or unsaved drafts.

Before any GitHub POST, the route acquires the EXISTING exclusive
`withVaultOwnerImportExclusive` owner-account fence. It re-verifies the
entire M74 plan, chosen kind and selected IDs **under that lock** (blocking
concurrent signed Oge Vault autosaves/edits), creates a distinct SHA-256
commit marker containing no source text, and durably records the
`github-write-possible` state, approved HEAD and selected UUIDs in the
existing `vaultImportLock` account metadata. This marker **does not
persist the kind as a separate field**; the kind is bound inside the
commit-marker hash, so operator reconciliation MUST review the original
approved M75 request/record before releasing an ambiguous lock.

The one-kind GitHub writer rechecks that old HEAD has not moved and that
none of the selected filenames exist, validates the complete chosen
directory and 300-per-kind/30k-tree capacity, and makes **one** GitHub
tree POST, **one** GitHub commit POST and **one** force:false ref PATCH.
It never retries the PATCH after an unknown HTTP response. It reads back
HEAD, commit message/tree/parent, every newly created immutable blob,
their original content and timestamps, then HEAD again before returning
success. Any mismatch or unknown provider result after the durable
write marker leaves the import quarantine **held for independent
operator reconciliation**; no automatic second attempt or unlock.

The response includes only resource kind, restored UUIDs, commit SHA and
metadata flags. It never echoes source private note content. The
`withVaultOwnerImportExclusive` implementation inherited from D3
releases its fence after a fully verified successful operation; an
unverified outcome is retained.

## Release and disaster-recovery limitations

- The M75 stage API is a **prototype**, not a production owner-facing
  restoration UI and not a signed one-time human receipt. The two-stage
  fingerprint is source-integrity binding, not independent source
  authentication.
- An externally supplied backup's SHA-256 can be forged together with its
  contents. Do NOT import an untrusted third-party archive without
  comparing the source against an independently authenticated GitHub
  owner/snapshot.
- The commit protocol assumes **all Oge write paths honor the existing
  owner import fence**; outside GitHub collaborators may still race and
  are handled by target HEAD/CAS and the quarantine. Reconcile ambiguous
  commits manually with the existing import lock operator tools.
- Existing Notes-only imports, M74 advisory planner and legacy Quick
  Notes/AirNotes production routes remain unchanged.
- No bulk loops, hard delete, overwrite, update, migration, complete
  revision history, permanent MongoDB content or draft retirement.
- No live OAuth/App two-device provider success evidence, encrypted
  offline source authentication, full-account snapshot, security audit,
  formal one-time receipt or actual user launch. Merge and production
  rollout remain blocked by those acceptance requirements.

## Automated regression checks

```sh
node --test tests/oge-vault-standalone-restore-approval.test.js
npm run lint
npm test
npm run build
```

New tests exercise prepare intent with no writes, exact kind/UUID/snapshot
and source-field fingerprint, owner revocation, existing file/draft
conflict, selected-ID tampering, complete canonical timestamp
preservation, one GitHub PATCH, verified read-only recovery of a lost
PATCH acknowledgment, unknown outcome quarantine and separate
staging gates. Existing Phase C dynamic collection audit requires
**statically named** `vault_drafts` and
`vault_standalone_drafts` reads and no unreviewed MongoDB content paths.

**PR #35 stays DRAFT and UNMERGED, flags remain OFF, and no live
user Notes or production data are touched by development/testing.**

## E8 / M76 independent signed one-time restore approval

The M75 standalone commit endpoint now also REQUIRES an independently
enabled HMAC-SHA256 10-minute one-time ticket obtained from
`POST /api/vault/backup-current-resources/authorize`. The issuer checks
the signed owner, complete M73 source, original kind/selected UUIDs,
fresh GitHub HEAD/draft safety and the exact M75 selection fingerprint.
The authenticated same-origin `/commit` verifies this ticket before
the owner import lock, then atomically claims it exactly once **inside**
that lock before any GitHub writer. A validated remote commit is recorded
against the hashed receipt before the lock releases. An unresolved claimed
receipt, including a previously pending second ticket, cannot authorize
another write; uncertain outcomes leave the owner import quarantine
in place. No private note text/raw ticket is stored in MongoDB.
The HMAC does not authenticate an externally supplied backup or enable
production restoration. See
`docs/OGE_VAULT_STANDALONE_ONE_TIME_APPROVAL_E8.md`.
