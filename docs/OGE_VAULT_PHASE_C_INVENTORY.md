# Oge Vault — Phase C Legacy Data Inventory and Cleanup Gate

**Status: read-only inventory implemented, environment audit and cleanup approval pending.**
This is not a migration plan, deletion authorization, or release clearance. The
operator has indicated that legacy MongoDB note rows may be test fixtures, but
the inventory cannot classify any real record as disposable by assumption.

## Read-only operator command

In the correctly scoped environment, after reviewing its database URI and
database name outside the terminal recording:

```sh
OGE_VAULT_INVENTORY_READ_ONLY=YES_COUNTS_ONLY npm run vault:inventory
```

`MONGODB_URI` and an explicit `MONGODB_DB` are required. Missing settings
prevent the command from connecting. It opens a **direct MongoDB client** rather
than the normal `getDatabase()` initializer, which creates indexes. The audit
only issues `countDocuments` reads and closes the connection. It does not
write, create indexes, copy note content, decrypt drafts, call GitHub, delete
collections, run a migration, or change preview flags.

The JSON report contains aggregated counts only:

- `counts`: known legacy permanent content collections `notes`,
  `quickNotes`, and `personalQuickNotes`
- `missingOwnerCounts`: records in those collections with absent, null, or
  empty `ownerId`; these require special investigation, not auto-deletion
- `protectedCounts`: encrypted `vault_drafts`, metadata-only
  `vault_save_receipts`, `vault_files`, `vault_file_index_state`,
  `vault_file_index_bootstrap`, `vault_subject_inspections`, and
  `vault_subject_deletion_jobs`

The program never prints note titles, bodies, owner IDs, repo IDs, database
URLs, OAuth credentials or encryption keys.

## Interpreting results

| Result | Meaning | Action |
| --- | --- | --- |
| `BLOCKED_OPERATOR_REVIEW_REQUIRED` | One or more records exist in known legacy note collections | Determine owner, provenance and retention needs through a separately approved investigation; **do not delete** |
| `NO_LEGACY_NOTE_RECORDS_IN_KNOWN_COLLECTIONS` | Only the three named legacy content stores had zero records at scan time | Continue the *broader* storage-path audit; no cutover or cleanup approval implied |
| Inventory error or inconsistent counts | A read or cross-collection count failed, or data changed while scanning | Treat the environment as unverified; retry only the read-only inventory after investigation |

CLI exit status: **0** when the known legacy note-store count is zero,
**2** when nonzero known legacy note records require operator review, and
**1** on invalid configuration or an inventory error.

Protected Vault counts are **never disposable content counts**. An encrypted
unsynced draft can be the only remaining recoverable copy of a user's edits.
No count, including zero, constitutes proof of a complete, consistent
database snapshot: new notes may be written concurrently, and other
collections, legacy backups, revisions, exports or extension storage may
still contain content.

## Required Phase C follow-up before cleanup

1. Audit **all** application writers, backup/import and history paths to
   discover every place capable of holding note titles or bodies, not just
   the three known legacy collections above
2. Record environment-specific sanitized counts and whether each nonzero row
   is a test fixture, active user data, or ambiguous, without copying content
3. Verify pending encrypted drafts and in-flight Vault recovery operations
   are retained; never delete user data on the basis of a test-fixture label
4. Obtain explicit owner/operator retention and deletion approval for each
   scoped cleanup operation, then separately design transactional rollback
   and recovery checks
5. Re-run a complete inventory and end-to-end GitHub cutover acceptance
   against isolated staging; do not infer production readiness from CI

**Phase C cannot be marked complete until the environment-specific operator
review and broader storage audit have passed.** PR #35 remains draft and
unmerged, with the existing production Notes path unchanged.
