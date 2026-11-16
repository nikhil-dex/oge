# Oge Vault — E5 / Milestone #73: Three-resource current GitHub snapshot backup

**Status:** independently gated, read-only current-content export and offline
structural/integrity verifier implemented and tested. **No restore writer or
full Oge account disaster-recovery promise.** Live authenticated GitHub App
two-device acceptance and cryptographic/security review remain pending.

## Current committed resource coverage

A single signed, private repository's exact GitHub HEAD and recursive tree
backs all three namespaces in the new archive:

| Collection | Committed GitHub path | Coverage |
|---|---|---|
| Subject-linked Notes | `notes/<uuid>.json` | Every current canonical Note on this HEAD |
| Standalone Quick Notes | `quick-notes/<uuid>.json` | Every current canonical Quick Note on this HEAD |
| Standalone AirNotes | `airnotes/<uuid>.json` | Every current canonical AirNote on this HEAD |

**EXCLUDED** (explicitly labeled in the JSON `coverage` object): historical
revisions, temporary unsaved AES-256-GCM drafts, legacy MongoDB test Notes,
and Learning Tracks/progress metadata. Therefore `completeAccountBackup`
is always **false**, and neither this download nor its checksum grants
permission to restore or import any content.

The existing `GET /api/vault/backup-export` and its established
`oge-vault-notes-backup` version-1 format stay **Notes-only**, unchanged.
Likewise, existing D3 restore planners/committers do NOT accept this new
archive format.

## New isolated staging endpoint

`GET /api/vault/backup-current-resources`

It is enabled only when ALL of these independently default-OFF flags are
enabled on protected, disposable staging:

```sh
OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW=true
OGE_VAULT_BACKUP_EXPORT_PREVIEW=true
OGE_VAULT_STANDALONE_PREVIEW=true
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

Additionally, the signer must be an active Auth.js owner/session
incarnation, `OGE_STAGING_URL=AUTH_URL`, the complete
`checkVaultStagingReadiness` must pass, Vault App identity/repository
mapping must be verified, and all destructive flags remain OFF.
The GitHub App token is scoped **`contents:read` on the one private
repository**. The caller supplies **no GitHub repository, commit, path or
token**.

The response is an on-demand JSON attachment
`oge-vault-current-resources.json` with `private, no-store` and
`nosniff` headers. The server does **not** save a shadow backup or any
confirmed Note body to MongoDB.

## Read-only verification and failure behavior

1. Read GitHub HEAD once, fetch its immutable commit and **one complete
   recursive Git tree**. Reject truncated trees, over 30,000 entries,
   missing/malformed/noncanonical paths, duplicate IDs, symlinks,
   unexpected directories and large individual files under any of the
   three reserved resource namespaces.
2. Check every tree blob SHA/size before fetching Note content. Download
   each current immutable blob by its exact indexed SHA (max five concurrent
   requests). Validate every Note format, UUID, canonical schema,
   timestamp, Quick Note first-line title, type and original immutable
   blob SHA. Reject corrupt files instead of silently omitting them.
3. Cross-check **all subject-linked Note subject IDs** against metadata
   owned by the current signed user. Quick Notes and AirNotes are correctly
   independent of subject metadata.
4. Enforce an **8 MiB complete JSON archive cap**, and the initial M70
   **300-entry list cap per standalone type**. Oversized archives or 301+
   standalone entries return **413**, not a partial download. The Notes
   list is not limited by the prior 500-note preview index.
5. Verify GitHub HEAD again before returning **any** content. Repeat the
   account session incarnation, GitHub owner, repository and installation
   mapping check after all private reads. If anything changed, fail closed.
6. Include sorted resource arrays, their counts, snapshot and tree SHA,
   deterministic SHA-256 inventory checksum, SHA-256 archive checksum,
   explicit `completeAccountBackup:false` and `importable:false`.
7. `verifyVaultCurrentResourcesArchive()` performs **offline read-only**
   canonical archive/collection/count/checksum inspection. A matching
   checksum only detects mismatch relative to this supplied archive; an
   attacker can regenerate a self-consistent checksum. It does **NOT**
   independently prove GitHub identity, physical-device provenance, source
   authenticity, backup completeness outside the stated namespaces or
   any restore authorization.

This operation does not call GitHub's Contents API for mutable paths, write
Git commits, read legacy MongoDB `notes`/`quickNotes`/
`personalQuickNotes`, delete temporary drafts or attempt to
automatically repair a damaged Vault.

## Still needed before a restore or production approval

- An independent read-only restore-target conflict plan for all three
  resource namespaces and pending drafts; a separately approved,
  create-only/import-safe Git CAS restore writer with real recovery tests
  **must be reviewed and implemented before using this backup to restore**.
- Boundless paginated/chunked backup for resource sets that exceed current
  8 MiB/300-per-type caps.
- Secure owner download persistence confirmation, encrypted offline packaging
  and a trusted source-GitHub-independent disaster-recovery story. The raw
  downloaded JSON contains **private plaintext Note contents**, so store it
  in an owner-controlled encrypted location; never upload it into tickets,
  CI logs, public repositories or shared browser sessions.
- Historic Git revisions, unfinished encrypted MongoDB drafts, Learning
  Tracks, account metadata, extension data and related catalogs remain
  outside this archive; a true account backup requires explicit coverage.
- Real GitHub OAuth/App, two-physical-device browser and 429/403 tests,
  independent encryption/security review, final cutover and merge approval.

## Synthetic verification

```sh
node --test tests/oge-vault-backup-current-resources.test.js
npm run lint
npm test
npm run build
```

The new tests simulate mixed resource trees, 501 Notes, all-empty Vaults,
truncation, unauthorized subjects, malicious/nested paths, wrong kind and
corrupt blobs, provider 429, moved GitHub HEAD, 301 standalone entries,
8 MiB overflow, checksum tampering, dropped/swapped/duplicate entries,
and rejection by the **old Notes-only importer**.

**All production flags default OFF. Do not merge PR #35 or treat
automated CI as live provider or security acceptance.**
