# Oge Vault — Milestone #46 import-lock operator recovery inspection

**Status:** default-off code-path inspection only; **no automated/manual lock
release command is implemented**. Signed live provider staging not completed.

This runbook is for an authorized incident responder in a controlled,
private environment. It does not give a browser user or an ordinary notes
route access to operator recovery. The only new command is **read-only**.

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

**No unlock/update/delete endpoint or CLI is shipped in Milestone #46.**
After this inspection, no import-lock mutation is authorized by the tool.
A separately reviewed, explicitly controlled recovery implementation and live
two-device staging signoff are still required. Never use an ad hoc,
unscoped MongoDB update to bypass the lock.

## Release gates

- API import/reconciliation flags remain disabled outside isolated staging
- No automatic TTL, lock-age threshold or background unlock
- No note content imported to MongoDB
- No receipt/draft deletion or GitHub write from this operator inspection
- PR #35 stays draft and unmerged until security review and live acceptance
