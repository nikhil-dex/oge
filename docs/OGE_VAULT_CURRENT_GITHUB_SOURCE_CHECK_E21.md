# Oge Vault — E21 / Milestone #89: authenticated CURRENT private GitHub source comparison

**Status:** Implemented as a separately DEFAULT-OFF staging-only owner-authenticated source comparison. Regression uses synthetic GitHub App read-only clients; **not executed on a real live GitHub App, OAuth account or physical device**. No restore or deployment.

## Why it matters

M88 validates SHA-256 digests embedded inside the user's local archive; these are NOT independently authenticated and can be recomputed after someone tampers with a file. M89 makes a separate, authenticated point-in-time comparison against fresh current private GitHub contents read through the existing signed-in owner's GitHub App installation.

The browser FIRST runs the complete M88 strict local JSON and digest validation, then sends ONLY the claimed current commit SHA, tree SHA, archive SHA-256, inventory SHA-256 and three numeric resource counts. No full archive, Note title, Note body, Note ID, subject ID, cookie, GitHub token, or private user identifier is uploaded. The new optional client-side file picker is separate from M88's fully offline checker.

New endpoint: **POST /api/vault/backup-current-resources/source-check**.

It is protected by signed Auth.js session incarnation, exact same-origin HTTPS request Origin, JSON-only bounded 512-byte input, independent default-OFF isolated staging feature gates, and a distributed **3 requests per owner per hour** limit. This limiter modifies transient MongoDB rateLimitBuckets metadata only; it does not store Note contents or drafts. The request's shape and values are validated **before** any DB/GitHub connection.

Using the authenticated user mapping and a freshly scoped GitHub App **contents:read** token, the server reuses the existing M73 exporter: it re-reads CURRENT HEAD, immutable Git tree, ALL bounded Notes, Quick Notes, AirNotes blobs, validates owner-owned Note subjects, then checks current HEAD and signed owner/repo/install binding again. It independently computes the complete canonical content SHA-256 digest and inventory SHA-256 and compares both to the caller's claim with constant-time digest equality. Source content stays ephemeral on the server; **only redacted match/mismatch booleans** return to the browser. No Git branch mutation, Note deletion, restore, import or quarantine release occurs.

## Default OFF setup

- OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW=false
- To explicitly enable in approved staging, set it to true along with existing default-OFF M87 Recovery Center and M73 current-resource backup read flags.
- Require exact protected HTTPS OGE_STAGING_URL=AUTH_URL=OGE_VAULT_BASE_URL, passing B7 staging preflight, isolated MONGODB_DB=oge_vault_restore_staging_<disposable>, and current owner-to-private-GitHub mapping.
- All standalone/backup import COMMIT, GitHub write ACK, cutover and destructive/account/subject deletion flags MUST stay OFF.
- Recovery Center source check asks the user to select the JSON file again; it is NOT automatic and may be costly for large archives.

## What success means and does NOT mean

Positive status: CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_MATCHES_READ_ONLY.

This means the browser's locally validated file's complete SHA-256 digest matched an **independently server-recomputed, signed-owner authenticated current private GitHub App snapshot** at that moment, assuming the authorized server/GitHub App and SHA-256 are trustworthy. This is stronger than local self-hashes.

Negative status: CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_DIFFERS_HOLD.

A negative result means the file does not match the **current** GitHub snapshot. It may be a legitimate older backup after GitHub HEAD changed; mismatch alone is not proof that the backup is malicious or damaged. Provider failures, 429 and HEAD movement are INCONCLUSIVE.

Neither status is an independently signed origin/provenance attestation, an authentication of historical backup content or a whole-account archive. Historical revisions, unsaved encrypted drafts, legacy MongoDB Notes and Learning Tracks remain excluded. The result **never** authorizes restoring, writing, automatic retry, importing, unlocking a github-write-possible quarantine, merging or production deployment.

Both outcomes report canRestore:false, canAuthorizeImport:false, canReleaseImportLock:false, canRetryUnknownWrite:false, productionReady:false, immutableHistoricalArchiveAuthenticated:false and githubWritesPerformed:false. Only redacted comparison flags and no private identifiers are returned. The browser temporarily processes plaintext Notes and may retain copies until GC; do this only on a trusted device.

## Tests and outstanding acceptance

Tests: tests/oge-vault-current-resource-source-verify.test.js, npm test, npm run lint, npm run build; CI also runs MongoDB replica-set integration, Chromium anonymous smoke and Git-history secret scanning.

Tests cover real M73 exporter invoked with synthetic read-only private GitHub calls, full SHA-256 agreement, changed content and HEAD, forged/extra/invalid claim, staging gates, local file validation BEFORE any metadata-only POST, guarded response interpretation and no unlock authority. CI does NOT exercise a real signed-in two-physical-device OAuth setup or actual GitHub provider fault/revocation tests.

Still pending: real independent staging App/OAuth acceptance, historical/source provenance, complete encrypted backup/history/drafts, reviewed owner-facing restore UX, extension and Learning Tracks integration, externally demonstrated GitHub worker quiescence, audited postwrite-lock recovery, independent security review and deployment.

PR #35 stays DRAFT and UNMERGED. No real user Notes were modified.
