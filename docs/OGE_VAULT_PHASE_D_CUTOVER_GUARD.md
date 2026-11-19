# Oge Vault — Phase D1 safe legacy-storage preview fence

**Status: implementation preview only. Not a live GitHub cutover.**
The new server flag `OGE_VAULT_CUTOVER_GUARD_PREVIEW` is **false by default**.
Do not enable it in production or merge PR #35 without explicit release review.

## Why this exists

The current /notes UI and its companion APIs still store permanent text in
MongoDB. Even after an owner connects GitHub Vault, old routes could write a
second permanent copy to MongoDB. Backup restore is especially risky because
it can re-introduce note bodies and historical versions. The browser
extension can similarly bypass the GitHub Save coordinator.

This preview **blocks legacy content routes** for a connected Vault owner;
it does not redirect, migrate, delete, or silently sync any content.
The user must use the separately gated `/vault/notes` preview for GitHub
notes. No existing notes are changed or erased.

## Exact configuration and behavior

Only on an **isolated staging environment**, with staging credentials and
disposable notes, configure all three server-side flags:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
OGE_VAULT_CUTOVER_GUARD_PREVIEW=true
```

- If `OGE_VAULT_CUTOVER_GUARD_PREVIEW` is unset/false, every old route
  preserves its existing behavior. No additional database lookup occurs.
- If true but either required Vault preview is disabled, a legacy API
  returns **503**, without reading/writing note text.
- If the signed account has a complete connected Vault mapping, the old
  endpoint returns **409** and instructs the user to use GitHub Vault.
- If the account has an unknown, pending, revoked or incomplete Vault
  mapping, it returns **503** instead of guessing where to save.
- If the signed account/session cannot be verified, it returns **401**.
- If there is no Vault connection, the old route continues working
  during this *staging-only* preview. It is **not** the final mandatory
  Vault enrollment policy.

The GitHub Vault note API still performs its own owner, session, GitHub
App installation and repository authorization. This guard **never grants
GitHub access** and does not trust matching email addresses for ownership.

## Phase D2: familiar Notes URL routing (staging-only)

With the same `OGE_VAULT_CUTOVER_GUARD_PREVIEW=true` flag, the server
layout for `/notes` now chooses the destination **before rendering** the
legacy browser editor:

- A fully signed-in account with a connected Vault, positive repository ID
  and positive GitHub App installation ID is redirected to `/vault/notes`.
  This reuses the same familiar editor, but with the separate GitHub-only
  `/api/vault/notes-main` API and encrypted temporary draft recovery.
- An account with no Vault connection continues to use the legacy
  `/notes` editor **only for this isolated preview**.
- Incomplete connections, missing signed owner records, disabled required
  previews, or uncertain owner state result in a blocked workspace. They
  are **not** interpreted as permission to open MongoDB Notes.
- A database or GitHub failure is never handled by a fallback to MongoDB.
  The Vault editor and its API independently verify owner and repository
  authorization. Notes are not imported or copied during redirection.
- If the flag is false (the default), the layout immediately returns the
  existing Notes client without an extra database lookup or redirect.

This is a *routing prototype*, not the mandatory production cutover. Other
pages and APIs must continue to be protected by the D1 guard because
third-party clients can call legacy endpoints directly. Existing browser
drafts must be audited during final user-facing rollout, and authenticated
navigation/staging tests remain outstanding.

## Legacy routes fenced

| API route | Covered operations |
| --- | --- |
| `/api/notes` | GET, POST, PUT, PATCH, DELETE |
| `/api/quick-notes` | GET, POST, PUT, DELETE |
| `/api/personal-quick-notes` | GET, POST, PUT, DELETE |
| `/api/backup` | GET export and POST restore |
| `/api/revision` | GET review cards and POST rating |
| `/api/revision-history` | GET history and POST restore |
| `/api/notes/cleanup` | POST legacy-note Gemini cleanup |
| `/api/extension/quick-note` | POST both subject-linked and quick capture |

The extension guard uses the validated token hash **within the account
transaction**, not an arbitrary owner ID supplied by the extension. Legacy
note writers and backup restore repeat the Vault check in a MongoDB
transaction to close the gap where an account connects Vault after the
initial request check. Backup export also rechecks the same signed account
before reading text inside the snapshot transaction.

## Still missing before production cutover

- Real signed OAuth and private GitHub App installation acceptance on an
  isolated staging account, including 429/network-loss and mobile drills.
- GitHub-backed backup export/restore, revision history and learning-track
  operations; these are **blocked** on connected Vault previews, not replaced.
- GitHub-backed Quick Notes, AirNotes, and extension capture with encrypted
  temporary drafts and safe Save confirmation.
- A production-friendly UI that routes connected users to the correct
  GitHub-backed feature without losing unsaved content or breaking navigation.
- Full environment data inventory, explicit disposal approvals and a
  rollback plan that never treats MongoDB metadata as GitHub authority.

## Non-destructive validation

Unit tests verify default-off behavior, signed-session and extension-token
scoping, partially provisioned Vaults and guard response statuses. Repo
contract tests require all old content endpoints to invoke the guard and
all transactional writers to check it again under the same session. The
disposable MongoDB integration test simulates a Vault connection between a
request preflight and its write transaction, and checks that no legacy note
is inserted.

Tests do **not** enable the flag in production, create a real GitHub vault,
migrate old MongoDB content, or approve deployment. PR #35 remains draft.
