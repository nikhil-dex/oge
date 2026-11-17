# Oge Vault — E23 / Milestone #91
## Signed-owner, read-only restoration preview against current private GitHub HEAD

**Stage:** prototype, default OFF. **No restoration, import approval, lock release, or GitHub writes.**

### Purpose
The earlier M90 preview compared two locally self-attested downloaded backups without proving which one is the current private source. E23 reuses the independently authenticated M89 comparison of the reference snapshot with a freshly read, owner-scoped private GitHub repository snapshot. The M90 conflict arithmetic stays entirely in browser memory.

### Owner flow
1. The signed-in owner enters the separately gated **isolated HTTPS staging** Recovery Center.
2. Choose the **candidate recovery backup** in its own file input and the **reference current-resource snapshot** in a second, separately labelled input. Neither file's name nor contents are stored in React state.
3. Check each file independently against M88 exact canonical JSON, strict UTF-8, 8-MiB size, schema, counts, and both embedded SHA-256 digests. **No network request occurs before both succeed.**
4. If `OGE_VAULT_RESTORE_SOURCE_PREVIEW=true` AND the existing M89 gate is enabled, post ONLY the reference's M89 existing exact metadata claim: Git snapshot/tree IDs, inventory/archive SHA-256 digests and three resource counts. There is no Note body, title, ID, subject, or complete file upload.
5. The existing signed-owner endpoint re-reads current private GitHub HEAD, verifies canonical blobs against the owner's live GitHub App installation and rechecks binding after the operation, and returns a **redacted match/differ** with no private resource data. It is limited to three source comparisons per owner per hour.
6. On a match, the browser compares the backup to the now-authenticated-at-check reference, producing only totals per Notes, Quick Notes, and AirNotes (would add, conflict, unchanged, current-only preserved). On differ/provider error, no supposedly authoritative plan is shown. A legitimately older reference may differ without being corrupt.

### Trust limitations
- Authentication applies **only to the reference snapshot at M89 inspection time**. The candidate recovery backup is still locally self-consistent but **has no independent historical provenance**.
- The GitHub branch may advance immediately after the check. The preview is **not a transactional merge plan, optimistic lock, restore ticket or permanent GitHub source signature**.
- Browser uses separate inputs to eliminate multi-file picker ordering ambiguity. Parsed local archives exist transiently in JS memory and cannot be securely erased with certainty.
- External provider validation is limited to the existing synthetic tests until explicitly staged real OAuth/App acceptance. No private Notes, provider write permission or release of uncertain GitHub-write quarantine is authorized.
- Excludes history, encrypted drafts, Learning Tracks progress and legacy MongoDB Notes; not a complete account backup.

### Flags
```env
OGE_VAULT_RESTORE_SOURCE_PREVIEW=false
OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW=false
OGE_VAULT_RECOVERY_CENTER_PREVIEW=false
```
All M89/M87/M73 preflight, signed owner, HTTPS origin, isolated database, and forbidden write-flag constraints still apply. E23 does **not** expose a new API route.

### Next
Milestone #92 should focus on authenticated **historical source provenance** for selected candidate backups, beyond comparison with current HEAD, with bounded security review and practical OAuth/provider fault testing. Even successful provenance must not authorize automatic restoration.
