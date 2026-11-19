# Oge Vault — Milestone #52: GitHub provider failure acceptance

**Evidence level:** automated fault injection with the REAL
`commitVaultNoteBatch` GitHub Git-tree/commit/ref writer, the real MongoDB
owner/subject import fences, approved archive import planning/execution and
the read-only original-archive recovery proof. GitHub is represented by a
**deterministic in-memory private Git object store**; no actual GitHub
installation, OAuth, browser or remote network is involved.

The executable acceptance suite is
`tests/mongodb-vault-github-fault-matrix.test.js`. It connects only to a
disposable local MongoDB replica set at `localhost:27017` (or
`127.0.0.1:27017`) with
`OGE_ALLOW_MONGO_INTEGRATION_TESTS=YES_DISPOSABLE_DATABASE`, then creates
and drops a randomly named test database.

## Failure matrix

| Synthetic GitHub condition | Verified outcome | GitHub write attempts |
|---|---|---|
| 429 at initial read-only plan | No remote mutation; pre-write fence released | 0 trees, 0 commits, 0 ref patches |
| 429 on Git-tree POST after durable marker | Ambiguous potential mutation; durable quarantine retained; next import and draft denied | 1 tree POST, no blind retry |
| Another writer advances HEAD before ref PATCH; PATCH 422 | External winner preserved; no approved import published; owner lock remains until investigated | 1 commit creation, 1 failed ref PATCH |
| Ref PATCH succeeds, its response is lost (503) | Exact HEAD, commit ancestry and note contents verified; report one successful import, release matching lock | 1 ref PATCH |
| Ref PATCH succeeds but responds as conflict (422) | Same exact immutable confirmation before declaring success | 1 ref PATCH |
| Ref PATCH succeeds but HEAD read gets 429 | Unknown outcome; retain owner quarantine; later read-only archive proof can confirm history | 1 ref PATCH, no replay |
| Ref PATCH succeeds but note-content read gets 429 | Unknown outcome; retain owner quarantine; later read-only canonical content proof can confirm | 1 ref PATCH, no replay |

All tests verify that the owner MongoDB record is free of permanent
note plaintext and that no draft is silently retired. A successful
historical proof does not authorize unlocking a possibly-started write
or implicitly replaying a GitHub commit. The synthetic store models
non-force Git ref updates and immutable trees, but it does not claim to
simulate GitHub infrastructure, real rate limiting or token revocation.

## What remains before production

- **Live signed GitHub staging:** dedicated synthetic accounts with real
  private repository, GitHub App installation, OAuth and two browsers
- Actual 429, 403, 409, 422, 5xx and network timeout handling, including
  eventual consistency and provider branch races
- Accessible and secure owner-facing conflict/recovery UI and mobile
  browser sessionStorage restoration
- Verified quiescence and dual-operator approval before any proposed
  `github-write-possible` lock release
- Chunked backup/restore for large vaults and a full Notes, Quick Notes,
  AirNotes, historical revisions, subject metadata and extension path audit

**Do not merge PR #35 or enable import/cutover flags as a result of this
synthetic acceptance alone.** Permanent note bodies stay in GitHub; MongoDB
remains metadata and temporary encrypted draft storage.
