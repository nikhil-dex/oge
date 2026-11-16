# Oge Vault — E6 / Milestone #74: read-only three-resource restore conflict planner

**Status:** independently gated, signed-owner target-conflict inspection
for the M73 GitHub-current-resources JSON archive. **Read-only/advisory,
NOT an import/restore operation or authorization.** Existing D3 Notes
import/restore endpoints are unchanged and still refuse M73 archives.

## Boundaries

The source archive may contain **private plaintext Note, Quick Note and
AirNote content**, but M74 processes it **in-memory only** after a strict
8-MiB request limit. It verifies the M73 structure and checksum, including
all three collections and exact coverage fields, **BEFORE** accessing the
destination GitHub Vault. Self-consistent checksums can be recreated by an
attacker; they do not authenticate GitHub provenance or ownership.

The destination must come from the **current Auth.js signed Oge user
session**, its active session incarnation, and a verified private GitHub
App repository-scoped **`contents:read`** installation. A caller cannot
choose a target repository, arbitrary Git ref, branch, GitHub path or
token. It checks source-linked Note subject metadata belongs to that
signed target owner; standalone resources have no subject.

## Default-OFF staging endpoint

`POST /api/vault/backup-current-resources/plan`

Submit the **complete** M73 `oge-vault-current-resources.json` as the
`application/json` request body (not a trusted file path). The POST
is a read-only **preview** despite its HTTP method: it accepts uploaded
JSON but never imports, commits, deletes or rewrites note/draft content.
Rate-limit bookkeeping may still update metadata counters.

On protected, isolated disposable staging **only**, enable:

```sh
OGE_VAULT_CURRENT_RESOURCE_RESTORE_PLAN_PREVIEW=true
OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW=true
OGE_VAULT_BACKUP_EXPORT_PREVIEW=true
OGE_VAULT_STANDALONE_PREVIEW=true
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

The exact signed `AUTH_URL=OGE_STAGING_URL`, full
`checkVaultStagingReadiness` and dedicated GitHub App staging
credentials are also mandatory. Production flags and all destructive
flags stay disabled.

## Conflict inspection algorithm

1. Validate the complete, typed M73 archive and its SHA-256 inventory
   and content checksums. Any malformed, incomplete, reordered,
   duplicate, too-large or mismatched archive returns 400/413.
   **No destination provider read** occurs for an invalid archive.
2. Read the signed owner and verify **all** source subject metadata
   against owner-scoped MongoDB subject records, with 100-item bounds.
3. Read the current private destination GitHub HEAD, its immutable
   commit and **complete recursive Git tree**. Reject truncated trees,
   malformed paths, symlinks, unsupported JSON file shapes and more
   than 300 entries of either standalone type (no silent truncation).
   No Git blobs are downloaded from the target and no mutable Contents
   API calls are made.
4. Read owner/repository-scoped pending AES-GCM **draft IDs only**:
   subject Notes in `vault_drafts` keyed by `ownerId/repoId/noteId`,
   Quick Notes and AirNotes separately in `vault_standalone_drafts`
   keyed by `ownerId/repoId/kind/captureId`. Check each source ID
   batch of at most 100. Draft ciphertext and plaintext are not read.
   Reject unexpected returned IDs or duplicate IDs.
5. Re-read GitHub HEAD and owner session/repository mapping after all
   checks. A moving HEAD, disconnected GitHub App, revoked login,
   unexpected draft selector or incomplete list fails the preview.
6. Report **three separate kind summaries** and overall counts:
   `draft-conflict` (takes precedence), `existing-resource-conflict`
   or `create-candidate`. The report includes at most **18 resource
   type/UUID/outcome tuples**, never source text/titles/tags/contents
   or Git blob SHAs. `previewTruncated:true` means only the display
   sample was bounded; **counts still cover the entire supplied archive**.

Every plan says:

```json
{
  "readOnly": true,
  "advisoryOnly": true,
  "sourceGitHubIdentityAuthenticated": false,
  "sourceShaTrustedAsAuthorization": false,
  "canCommit": false,
  "canRestore": false,
  "writesToGitHub": false,
  "writesToMongo": false,
  "changesEncryptedDrafts": false,
  "requiresIndependentOwnerApproval": true,
  "needsFreshTargetAndDraftRecheckBeforeAnyWrite": true
}
```

Here `writesToMongo:false` means **the planner itself does not modify
note or draft data**; the separate HTTP rate limiter may still update
request counters.

Even a `create-candidate` is **not** a promise that a later write will be
safe. The target may change immediately after this read-only inspection.

## Explicitly NOT implemented or authorized

- **No restoration, GitHub writes, MongoDB note body copy, purge, draft
  discard, auto-merge, owner approval ticket or import lock release.**
- No integration of untrusted M73 archives into the old Notes-only
  import/restore committers; those still reject the new format.
- No independent signature/owner authenticity of an externally sourced
  M73 archive. Its checksum is not authentication.
- No full account backup. Historical revisions, unsaved drafts,
  learning progress, legacy MongoDB data and extension data are still
  excluded by M73.
- No live GitHub OAuth/App provider two-physical-device acceptance,
  security audit, full-size chunked backup or production cutover.

A later create-only GitHub CAS restore **requires independent source
provenance review, fresh owner approval, fresh destination HEAD/draft
rechecks, separate import fencing and rollback/recovery acceptance**.
None of those can be inferred from this advisory preview.

## Synthetic checks

```sh
node --test tests/oge-vault-backup-current-resources-plan.test.js
npm run lint
npm test
npm run build
```

Tests cover source-archive rejection before any destination requests;
mixed type conflicts; subject ownership; typed encrypted draft IDs;
duplicate/foreign draft rows; moved HEAD; revoked owner; truncated
malicious/symlink target paths; 301 AirNotes; more than 100 Notes and
strict 18-entry preview; provider 429; read-only token; and no content
echo or write APIs.

**PR #35 stays draft and unmerged. Never run the preview on production
or submit private user backups to shared issue trackers/CI.**
