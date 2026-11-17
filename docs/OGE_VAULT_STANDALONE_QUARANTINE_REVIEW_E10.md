# Oge Vault — E10 / Milestone #78: no-release quarantine recovery review

**Status:** staging-only, signed-owner, read-only, incident-scoped recovery
review packet for an uncertain M75/M76 Quick Notes or AirNotes GitHub
restore. **No post-write lock-release implementation or authorization.**
The default-OFF M78 gate is separate from M75 commit/write flags.

## Why this exists

M75 retains the owner-wide `vaultImportLock` when a GitHub CAS write
might have started but was not completely acknowledged. M76 consumes a
one-time signed approval receipt even if the result remains uncertain.
M77 reconstructs exact historical Git ancestry and verified immutable
selected content but cannot prove the original writer has stopped.
A historical match does not imply that current Notes are unchanged or
that quarantine can safely be released.

M78 adds a **second, independently gated read-only inspection stage**
that correlates M77 with a fresh, bounded, owner-scoped observation of
active writers, encrypted draft presence, receipts and the exact owner
import-lock snapshot. It builds a redacted, tamper-evident-to-comparison
SHA-256 **review fingerprint**, **not a signature or release ticket**.

## Staging API

`POST /api/vault/backup-current-resources/recovery-review`

Independently default OFF:

```sh
OGE_VAULT_STANDALONE_QUARANTINE_REVIEW_PREVIEW=false
```

The operator must explicitly enable this ONLY in an isolated, protected
disposable staging environment, alongside the M77 read-only reconcile
prerequisites (including
`OGE_VAULT_STANDALONE_RESTORE_RECONCILE_PREVIEW=true`), exact
`AUTH_URL=OGE_STAGING_URL`, matching configured HTTPS
`OGE_VAULT_BASE_URL` origin, same-origin request `Origin` header,
a signed current Auth.js owner/repo mapping and an isolated
`MONGODB_DB=oge_vault_restore_staging_<disposable>`.

Do not enable GitHub write, restore-commit or destructive flags for this
review. The route uses only `getVaultNoteClient(..., {readOnly:true})`,
never `withVaultOwnerImportExclusive`, and no postwrite-lock release
primitive is exposed. Rate-limit metadata may be mutated by the
authenticated request throttle.

The request is JSON, bounded to the complete original M73 archive plus a
small envelope; fields are exact:

```json
{
  "archive": "<complete original M73 JSON object, not this string>",
  "kind": "quick-notes",
  "selectedIds": ["<originally approved UUID>"],
  "expectedTargetHead": "<approved GitHub prewrite HEAD>",
  "expectedSelectionFingerprint": "<M75 SHA-256 selected source binding>",
  "confirmation": "COMMIT_SELECTED_STANDALONE_CREATE_ONLY",
  "expectedOperationId": "<exact durable import lock operation UUID>",
  "incidentId": "<separately authorized incident UUID>",
  "reviewConfirmation": "INSPECT_QUARANTINED_STANDALONE_RESTORE_READ_ONLY"
}
```

The **incident ID** and **operation ID** must be obtained from an
access-controlled independent operator record. Neither is accepted as
a password or a stand-in for independent operator authorization.

The route validates source/archive/selection before reading private
owner/ GitHub data, obtains signed-owner-only readers, and runs
`reviewStandaloneRestoreQuarantineReadOnly`:

1. Verify the signed owner/session and read current exact-owner,
   exact-repo, import-lock metadata and bounded activity counters.
2. Invoke M77's full **read-only** reconciliation, including the exact
   durable `github-write-possible` marker/operation/HEAD/selected UUIDs,
   claimed/confirmed M76 one-time receipt record, up to **20 linear Git
   commits**, complete Git tree delta and every selected immutable blob
   against original private archive contents.
3. Bounded read-only metadata existence checks:
   `users.vaultActiveDraftWriters`,
   `subjects.vaultActiveWriters`, `vault_drafts`,
   `vault_standalone_drafts`, and the scoped count of unresolved claimed
   `vault_standalone_restore_approvals`. All collection names are
   **static**, and every query is limited to the signed user/repository.
   At most two rows are counted. No encrypted draft or note text is
   decrypted, read back, exported or stored.
4. After M77's own stable owner/lock/receipt/Git HEAD validation,
   recheck owner-lock and auxiliary activity. Reject inconsistent or
   changed metadata; recheck signed owner and GitHub HEAD again.
5. Return metadata-only classification and explicit blockers. The
   `reviewFingerprint` SHA-256 binds incident/operation/owner-scoped
   observed metadata, but those IDs are never printed. It is not
   HMAC-signed, a bearer token, permission to retry, or a lock-release
   capability.

## Classifications

- `HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE`: selected immutable
  historic Git content matches the **untrusted** supplied source and
  M77 exact receipt/lock/HEAD checks pass. The observed current selected
  resources have not changed since that Git creation. Still **HOLD**.
- `HOLD_HISTORICAL_CREATE_WITH_LATER_EDITS`: historic create is proven
  but selected content is now changed or missing. Never undo user edits,
  restore over existing entries or infer safe release. Still **HOLD**.
- `HOLD_REMOTE_OUTCOME_UNPROVEN`: no complete historical evidence
  within the bounded M77 inspection. An apparently unchanged HEAD,
  non-linear history, invalid commit delta or missing blob is **not**
  proof that the old GitHub request cannot complete. Still **HOLD**.

Every report contains permanent blockers: original remote writer
quiescence has **not** been independently proven; separate incident
operator review is required; no audited postwrite release path exists;
and untrusted source origin is not authenticated. Additional explicit
blockers are present for missing historical proof, changed selected
content, still-claimed receipt, active draft/subject writers, unsaved
encrypted Notes/standalone draft presence, or multiple unresolved
claimed receipts.

Regardless of observed values, every report returns:
`blockedBySafetyPolicy:true`,
`operatorUnlockAuthorized:false`,
`automaticUnlockAuthorized:false`,
`safeToRetryAutomatically:false`,
`quarantineReleasePerformed:false`,
`isProofPriorWriterStopped:false`,
`verifiedOperatorAuthorization:false`,
`sourceGitHubIdentityAuthenticated:false`,
`gitWritesPerformed:false`, and
`noteContentStoredInMongo:false`.

**No release candidate status, automatic repair or unlock command is
exposed.** A clean-looking review packet cannot establish independent
worker shutdown. The existing #47 prewrite-only release procedure
continues to reject every `github-write-possible` lock.

## Future operator recovery acceptance (not done in M78)

A separately reviewed, offline, locked-down operator procedure would
still need: independent incident authorization involving a second
reviewer; exact owner/repo/installation/session and operation UUID;
verifiable quiescence of **all** app instances and outstanding GitHub
mutations; immutable GitHub parent/tree/blob proof or independent
unresolved-write reconciliation; preservation of unsaved browser and
MongoDB encrypted drafts; strict no-overwrite semantics; majority
transactional exact-state CAS with immutable audit metadata; and no
automatic retry of an unknown outcome. These requirements must be
approved and tested before any postwrite-lock release is implemented.

## Checks

```sh
node --test tests/oge-vault-standalone-restore-reconcile.test.js
node --test tests/oge-vault-standalone-quarantine-review.test.js
npm run lint
npm test
npm run build
```

Regression tests cover historical positive evidence **without**
unlock, old/changed current resources, uncertain result, active writers,
unsaved encrypted drafts and additional claimed receipts; changed owner,
lock, activity or Git HEAD; malformed/unbounded counters; read-only
client; and exact default-OFF HTTP route/owner-scoped static Mongo reads.

**No production restore flags enabled, no user data changed, no merge.
PR #35 remains DRAFT.**

## E11 / Milestone #79 — Offline two-reviewer signed incident attestation

Added `lib/oge-vault-quarantine-dual-review.js` and the explicitly
default-OFF, owner-private local-only
`npm run vault:quarantine:verify-two-reviewers` command for checking
two **distinct, independently trusted Ed25519** signatures over the
same canonical 15-minute incident claim. The signed claim binds
independently supplied incident/lock scope, owner-scope digest, exact
private repo/installation ID, kind/count, original M78 `HOLD_*`
classification and `reviewFingerprint`, and hashes of off-platform
writer-shutdown, in-flight GitHub request and encrypted draft-preservation
evidence references. The signature validator also rejects any M78 review
that has lost required NO-UNLOCK and NO-RETRY safety statements.
Trusted public keys and incident scope come from a separate protected
operator channel, not the dossier. Distinct keys can verify cryptographic
attestations **but cannot prove they belong to different physical humans
or that external evidence is genuine**. This step does not read or verify
artifact bodies, live GitHub state or the actual shutdown of old workers;
it never releases the Vault. Even full signature verification returns
`TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD` with process
exit **2** (not success 0). The existing M47 prewrite-only CAS still
cannot release a `github-write-possible` import lock. See
`docs/OGE_VAULT_QUARANTINE_TWO_REVIEWER_ATTESTATIONS_E11.md`.
