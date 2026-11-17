# Oge Vault — E9 / Milestone #77: read-only uncertain standalone restore forensics

**Status:** Staging-only, **read-only** signed-owner incident inspection of an
M75/M76 uncertain GitHub create-only Quick Notes or AirNotes restore.
**Never an unlock, automatic retry, commit execution, a valid restored
backup-source signature, proof of worker quiescence, or production recovery.**

## Situation

If a GitHub ref PATCH, GitHub verification, or receipt confirmation returns
an unknown outcome, M75/M76 intentionally retain the durable
`vaultImportLock.state=github-write-possible` owner quarantine, and the
M76 receipt may be `claimed` and unconfirmed. A successful-looking GitHub
HEAD alone cannot prove the exact selected records were created correctly;
absence at one HEAD cannot prove a former mutation never happened.

## Separate default-OFF protected staging endpoint

`POST /api/vault/backup-current-resources/reconcile`

Set `OGE_VAULT_STANDALONE_RESTORE_RECONCILE_PREVIEW=true` only for an
**explicit, private, isolated disposable HTTPS staging incident**. The
M75 `OGE_VAULT_STANDALONE_RESTORE_INTENT_PREVIEW`, M73/M74 prerequisite
preview flags, exact `AUTH_URL=OGE_STAGING_URL`, matching HTTPS
`OGE_VAULT_BASE_URL` and same-origin request `Origin`, signed
Auth.js account session and verified private GitHub App installation, and
`MONGODB_DB=oge_vault_restore_staging_<disposable>` remain mandatory.

The reconciliation flag is **independent of all write/approval flags**,
which may remain OFF during investigation. This endpoint **never** acquires
a write-scoped GitHub token, releases a lock, alters a receipt, marks a
GitHub attempt, replays an uncertain PATCH, or writes note/draft content
into MongoDB. Request throttling can still update rate-limit metadata.

Submit `application/json`, limited to the M73 8-MiB archive plus a small
metadata envelope. The request contains exactly the previously reviewed
M75 **commit request fields**, plus an `expectedOperationId` UUID from
an independently authorized incident record:

```json
{
  "archive": "<the complete original M73 JSON object, not this string>",
  "kind": "quick-notes",
  "selectedIds": ["<approved UUID>"],
  "expectedTargetHead": "<approved prewrite GitHub HEAD SHA>",
  "expectedSelectionFingerprint": "<owner-reviewed M75 SHA-256 fingerprint>",
  "confirmation": "COMMIT_SELECTED_STANDALONE_CREATE_ONLY",
  "expectedOperationId": "<exact vaultImportLock operation UUID>"
}
```

The original source archive may contain private plaintext. Keep it
confidential, do not log its content or upload it to issues or shared CI.
All archive integrity checks, complete M73 schema and selected content
fingerprint are independently recalculated **before any private GitHub
provider or Mongo owner read**. An archive checksum is NOT trustworthy
source provenance; this endpoint cannot validate who authored the source.

### Signed owner and receipt checks

- Inspect only the current Auth.js signed account incarnation and its
  verified private GitHub App repo/installation; do not accept a
  caller-selected repo, branch, token, Git path or subject.
- Require exact `vaultImportLock.operationId`, repo ID,
  `state=github-write-possible`, started/attempted timestamps, selected
  UUIDs, approved prewrite HEAD and **exact recomputed, type-bound M75
  Git commit marker**. The marker is content-free but uniquely commits to
  source selection and kind. A different operation or unsupported lock
  state is rejected.
- Require exactly one M76 `vault_standalone_restore_approvals` receipt
  ledger record with the **same** owner/session/repo/installation and
  SHA-256 of the approved M76 binding, in `claimed` or `confirmed`
  state. A missing/ambiguous record fails closed. The raw 10-minute
  ticket is **not** an authorization for historical reconciliation and
  need not be supplied after expiration.
- After GitHub evidence reads, independently re-verify signed owner,
  the **exact unchanged** locked account-row metadata, receipt state
  and the pinned GitHub HEAD. A changed session, lock, receipt or HEAD
  rejects the entire report.

### Historical Git evidence (up to 20 single-parent commits)

1. Pin a single verified private GitHub HEAD using the contents:read
   GitHub App token. Traverse at most 20 commits in a **linear**
   parent chain, never accepting a merge commit or unrelated source.
2. Locate only a commit whose **immediate parent equals the approved
   prewrite HEAD** and whose commit message exactly matches the durable
   owner-lock marker; no fuzzy message or stale SHA-only guess.
3. Fetch the pinned immutable **complete** before/after Git trees, fail
   closed on truncated, malformed, duplicate, nested resource paths,
   symlinks and oversized entries. Compare ALL non-tree leaves:
   **exactly the approved selected Quick Notes OR AirNotes paths may
   have been created**, no other Git leaf may be added, removed or
   modified by this candidate commit.
4. Read the new selected entries from their immutable Git blob SHAs.
   Validate complete canonical type/version/UUID/contents/title/timestamps
   against the exact approved original M73 source records, without
   printing or persisting those private contents.
5. Independently compare the historical selected Git blob SHAs against
   the pinned **current** Git tree. Report totals
   `unchanged`, `changed`, `missing` to distinguish historical
   restoration from later edits/deletions without reverting them.
6. Recheck Git HEAD, account owner lock and claimed receipt before
   returning the limited report.

### Advisory outcomes

- `HISTORICAL_CREATE_CONTENT_VERIFIED` — bounded Git ancestry, exact
  selected-file leaf delta, immutable canonical contents and lock/receipt
  references matched the **untrusted supplied archive**. This proves
  what GitHub currently exposes in its historical commit; it does NOT
  independently authenticate the original source backup, prove that a
  remote writer has stopped, or authorize lock release.
- `APPROVED_HEAD_UNCHANGED` — the inspected HEAD remains the approved
  prewrite value. **This cannot establish a GitHub PATCH will never finish.**
- `NOT_PROVEN_WITHIN_BOUNDED_HISTORY`,
  `NO_MATCHING_COMMIT_IN_BOUNDED_HISTORY`,
  `NONLINEAR_OR_INCOMPLETE_HISTORY`,
  `CANDIDATE_CONTENT_DELTA_UNVERIFIED`,
  `CANDIDATE_PRIVATE_BLOBS_UNVERIFIED` — unresolved. The absence of
  a verified commit is **NOT** proof it never happened. Never retry or
  release locks based on these reports.
- Changed target, lock, identity, receipt, unexpected private tree data
  or provider 429 **fails closed**; the endpoint does not attempt
  cleanup or downgrade to a false "confirmed" result.

The output carries only selected UUID metadata, Git HEAD/commit hashes,
bounded counts and safety flags. It returns no source title, note body,
draft ciphertext, OAuth secrets, HMAC key, raw ticket, import operation
UUID or owner ID. **Every report includes**
`operatorUnlockAuthorized:false`,
`automaticUnlockAuthorized:false`,
`safeToRetryAutomatically:false`,
`independentWriterQuiescenceVerified:false`,
`gitWritesPerformed:false` and `mongoWritesPerformed:false` (except
separate route rate-limit counters).

## Operational policy

**Do not release a `github-write-possible` owner lock from this report.**
The existing #47 prewrite-release helper explicitly requires
`state=acquired` and will reject this uncertain lock. Separate
human-authorized offline GitHub/App forensics, exact owner/operation review,
writer shutdown/quiescence proof, independent security review, and a
future separately audited narrowly scoped lock-release transaction are
required. These are **NOT implemented** in M77.

The M76 claimed ticket remains consumed, even after expiration or a
successful historical commit. Never mark an uncertain receipt pending,
clear it by TTL-based automation, reissue a restore against the same
unknown target, or silently delete encrypted drafts.

**Limitations:** up to 20 linear Git commits and 30,000 complete tree
entries; returns unknown for older/deeper/merged history. The M73 archive
is still bound by 8 MiB / 300 entries per standalone kind. This is
not complete Oge account recovery and has not passed live two-physical-
device OAuth/App acceptance or independent security/crypto audit.

## Regression tests

```sh
node --test tests/oge-vault-standalone-restore-reconcile.test.js
npm run lint
npm test
npm run build
```

Tests cover historical one-kind Quick Notes and AirNotes proof, later
changes/deletions, unchanged HEAD, merged history, unrelated leaf
changes, forged blobs, suspicious Git trees, archive tampering before
any private reads, exact lock operation/receipt requirements, changing
owner/lock/HEAD, readOnly GitHub token and default-OFF route source checks.

**PR #35 remains DRAFT and UNMERGED; staging gates and production
flags remain OFF; no live user data was modified.**

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
