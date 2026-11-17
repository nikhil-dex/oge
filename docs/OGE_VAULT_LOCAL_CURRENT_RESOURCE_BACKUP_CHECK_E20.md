# Oge Vault — E20 / Milestone #88: private local backup verification in Recovery Center

**Status:** Implemented; staging-only owner-facing browser file picker, no upload, no import. M87 Recovery Center remains independently DEFAULT OFF. The M88 reader does not fetch GitHub, OAuth, MongoDB, private Notes, or an arbitrary URL, and never mutates a Vault. PR #35 stays DRAFT/UNMERGED; no production deployment, restore, or postwrite quarantine unlock.

## User experience

In the existing authenticated disposable-staging-only \`/vault/recovery\` page,
the owner may choose an existing downloaded **current three-resource GitHub
snapshot** JSON file using the browser's native file picker. The browser
checks it locally. A passing result shows **only** the number of Notes,
Quick Notes and AirNotes and a warning that integrity is **not source
authentication**. The UI never displays titles, IDs, Git SHAs, Note
bodies, blob SHA1 hashes, downloaded filename, raw file text, keys,
owner IDs, or backup contents.

No new GET or POST backend API was added. A file is not uploaded or
saved in React state, session/local storage, IndexedDB or Oge/MongoDB.
Input element is cleared immediately; the JS object is held only within
the active verification call. The verifier discards references after
processing and zeroes its byte buffer on a best-effort basis.
**Browsers cannot guarantee secure erasure of decoded strings and JS
heap copies**. A selected archive may contain sensitive *plaintext*
Note content, so use a trusted device and store external backups in
protected, preferably encrypted storage.

The picker is useful even if the current snapshot-download feature is
disabled, since a user may have previously downloaded a file. It remains
behind the current Recovery Center signed-owner and isolated staging
checks; the snapshot-download link continues to use its OWN additional
backend-specific feature flags.

## What is actually verified

\`lib/oge-vault-current-resource-local-verify.js\` uses browser WebCrypto
\`subtle.digest('SHA-256', ...)\` and a bounded file read. It precisely
reproduces the existing **E5/M73** backend's canonical contents and
inventory SHA-256 calculations. It rejects files with any of:

- More than **8 MiB** (the existing M73 export's maximum size), invalid
  UTF-8, malformed JSON, noncanonical output (including duplicate JSON
  keys or unexpected whitespace), unexpected fields/types/coverage,
  importable/completeAccountBackup claims, invalid Git commit/tree
  identifier shape, or invalid SHA-256 syntax
- Counts inconsistent with the actual three resource arrays; extra
  Note fields, malformed canonical Note IDs/tags/timestamps/content;
  invalid standalone type/content/title/timestamp/IDs; unsorted or
  repeated record IDs; resource row byte bounds exceeded
- An inventory digest mismatch. The index is computed from the exact
  ordered \`notes/<uuid>.json:<blob-sha>\`,
  \`quick-notes/<uuid>.json:<blob-sha>\` and
  \`airnotes/<uuid>.json:<blob-sha>\` strings with the backend's domain
  separator and terminal newline, including the **zero-resource**
  inventory corner case
- An archive digest mismatch. This is computed from the original
  canonical JSON object **without** the two SHA-256 fields, with the
  inventory SHA-256 appended, exactly matching the M73 exporter

It supports the backend's current-format **version 1** archive only,
not the older Notes-only chunk files or encrypted backup parts.

Both hashes are **embedded in the file they claim to check**, so a
person who changes its contents can recompute them. An archive with
self-consistent values is not necessarily true, authentic or complete.
The \`sha\` field on a resource is a *claimed* Git blob ID; this local
tool **does not authenticate it with GitHub**. No current branch/head,
GitHub App, installation, owner account, archive origin, source
authority or absence of undisclosed resources is proven. The M73
server authenticated its owner and HEAD when exporting, but a local
file alone does not preserve that trust relationship.

**Never use this result to authorize import/restore, GitHub writes,
auto-retry, postwrite-lock release, data deletion or production launch.**

The redacted success code is:
\`LOCAL_EMBEDDED_HASHES_MATCH_SOURCE_UNAUTHENTICATED\`.

Every report sets
\`sourceAuthenticated:false\`,
\`gitBlobShaVerifiedAgainstGitHub:false\`,
\`immutableGitHeadIndependentlyVerified:false\`,
\`privateGitHubRepoOwnershipVerified:false\`,
\`fullAccountBackup:false\`,
\`canRestore:false\`,
\`canAuthorizeImport:false\`,
\`canReleaseImportLock:false\`,
\`safeToRetryAutomatically:false\`,
\`networkRequestsPerformed:false\`,
\`serverUploadsPerformed:false\`,
\`browserPersistentStorageWritesPerformed:false\`, and
\`notesOrIdentifiersReturned:false\`.

## Coverage limitations

The existing M73 archive includes the **current committed GitHub
snapshot only** of the following: Notes, Quick Notes and AirNotes.

It does **NOT** include historical revisions, unsaved encrypted draft
content, legacy MongoDB Notes or Learning Tracks progress. A locally
matching checksum does not change those omissions, establish a
complete account backup, ensure a downloaded copy was durably saved,
or certify that encrypted drafts will survive a device loss.

## Build and regression

\`\`\`sh
node --test tests/oge-vault-current-resource-local-verify.test.js
npm run lint
npm test
npm run build
\`\`\`

The tests construct actual canonical resource records with existing
server \`validatedNote\` and \`validatedStandaloneCapture\`, seal them
with M73's current inventory and archive digests, and independently
compare both the server archive verifier and M88 browser verifier.
They exercise a valid archive with all three types, **zero-resource**
backup, local browser file interface, whitespace and duplicate-key
rejection, invalid UTF-8 and oversize files, title/content/ID/size,
counts and SHA tampering. A deliberately *forged but recomputed*
self-consistent archive must still report that GitHub ownership was
NOT authenticated. Static route/UI tests assert signed owner/staging
gating and no network/upload/import/mutation code paths.

## Remaining

A future approved milestone could include an independently
authenticated operator-signed source manifest and GitHub App
read-only source verification, but **not** infer authority from
the embedded self-hashes. Full-account backup/history/drafts,
real OAuth App two-physical-device acceptance, provider fault
injection on approved disposable data, audited owner-facing restore
UX, extension/Learning Tracks cutover, external writer quiescence
proof and independent security audit all remain pending.

No real user Notes modified. No staging or production flags enabled.
