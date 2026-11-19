# Oge Vault — E12 / Milestone #80: offline signed evidence artifact integrity

**Status:** implemented read-only in code for **three locally provided
redacted evidence files** whose exact byte-level SHA-256 fingerprints
were bound to the **two distinct independently trusted Ed25519 signatures**
verified in E11/M79. No GitHub/App/DB connection, no restore, no lock
release, no automatic retry. PR #35 stays draft and production flags OFF.

## What this adds to M79

M79 verifies that two independently trusted Ed25519 public-key holders
signed the *same declared evidence digests* and reviewed the same M78
`HOLD_*` incident packet. M79 **did not read** the external evidence
files themselves, so the digest claims were unverified references.

M80 recomputes SHA-256 from the actual three fixed-name local files.
**Only a local bit-integrity match is verified.** Both signatures are
reverified against independently supplied expected incident scope and
trusted role public keys before private evidence bytes are accessed.
The files themselves are never returned, logged or persisted.

The three exact required filenames in one separate private directory:

| M79 signed claim field | M80 local file |
|---|---|
| `writerShutdownSha256` | `writer-shutdown.redacted.txt` |
| `outstandingGitHubRequestsSha256` | `outstanding-github-requests.redacted.txt` |
| `encryptedDraftPreservationSha256` | `encrypted-draft-preservation.redacted.txt` |

**Exact raw bytes** (including newlines, byte-order markers and
encoding) are hashed; no newline normalization, JSON rewriting, text
parsing or partial record matching occurs. The operator must compute
these three digests from the original private evidence files **before**
both reviewers sign the M79 claim. A previously signed M79 claim with
hashes of abstract labels or placeholder text **cannot be reused** to
verify different raw evidence files. Sign a new claim with correct
digests only after the full new incident-specific review.

## Guarded private offline command

The M80 command is independent and default OFF:

```sh
npm run vault:quarantine:verify-artifact-hashes
```

Provision all M79 private, separately authenticated expected incident
scope, two trusted Ed25519 SPKI DER public keys, exact M78 review and
signed M79 dossier paths, matching isolated HTTPS staging origin,
`MONGODB_DB=oge_vault_restore_staging_<disposable>` and disabled
write/cutover/deletion flags. Then explicitly opt into BOTH:

```text
OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW=YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY
OGE_VAULT_QUARANTINE_ARTIFACT_HASH_REVIEW=YES_OFFLINE_PRIVATE_SIGNED_THREE_ARTIFACTS_ONLY
OGE_VAULT_QUARANTINE_EVIDENCE_DIRECTORY=<absolute private directory>
```

Use a protected secret manager/operator runner for these values, not
Git commit history or a shared CI environment.

All three filenames must be present **and there must be no fourth
entry**. The directory must be a private owner-only nonsymlink
directory. Each file must be regular, non-symlink, have exactly one hard
link and no group/world permissions, with a bounded size of **16 bytes
to 128 KiB**. Files are opened with `O_NOFOLLOW`, hashed in at most
16 KiB chunks, and the exact inode/device/size/mtime/ctime and
directory metadata are checked again. A mismatch, changed input,
unexpected file, hard link, symlink, oversized file, unreadable file,
bad Ed25519 signature or wrong independently trusted scope **fails
closed**. This is intended for a controlled, non-hostile operator
environment; it is not a complete defense against a concurrently
privileged local filesystem attacker or malicious OS.

The new module is
`lib/oge-vault-quarantine-artifact-integrity.js` and the CLI is
`scripts/verify-vault-quarantine-artifact-hashes.mjs`.

The command's exit codes intentionally never imply unlock:

- **2:** all **three on-disk hashes match the two-reviewer signed
  claim**. Status:
  `THREE_SIGNED_ARTIFACT_HASHES_MATCH_QUARANTINE_STILL_HELD`.
- **1:** unsafe or incomplete scope, invalid signatures, missing or
  changed evidence, mismatched digests or other error. **HOLD**.

There is **no exit 0** for a verified incident, because a caller must
never treat zero-exit success as recovery authorization.

## Security limitations that remain

A file matching its signed SHA-256 proves only that the local bytes
match the signers' declared values. This **DOES NOT PROVE**:

- The declared file was actually captured from GitHub, MongoDB, the
  scheduler, the original application worker or an independently
  authenticated producer.
- The captured assertions are complete, contemporaneous or true.
- All outstanding GitHub requests have finished or been cancelled;
  a previously sent ref PATCH could still complete later.
- All app instances, async tasks, browser writers or leases are
  quiescent.
- Unsaved encrypted browser or database drafts are safely preserved.
- The original archive was created by the authentic source owner.
- The two independent Ed25519 keys represent two distinct vetted
  human operators.
- The current owner session and private GitHub HEAD are unchanged
  since M77/M78.
- A `github-write-possible` import lock can be removed or that an
  uncertain write may be retried.

The redacted output says these remain unverified and always reports
`operatorUnlockAuthorized:false`,
`automaticUnlockAuthorized:false`,
`safeToRetryAutomatically:false` and
`quarantineReleasePerformed:false`. No content, file path, digest,
incident/operation UUID, Ed25519 signature, token or trusted key
is included in output. No MongoDB or GitHub writer is imported/called.

## Regression checks

```sh
node --test tests/oge-vault-quarantine-artifact-integrity.test.js
npm run lint
npm test
npm run build
```

Tests use temporary independent Ed25519 keypairs, complete M79 signed
claims and three private files. They cover successful local hash
matching, artifact tampering, missing/extra/renamed files, symlinks,
hardlinks, unsafe file/directory permissions, oversized files,
tampered signatures, wrong reviewer key, unsafe source review,
relative paths, default-OFF CLI and successful **HOLD=2** vs invalid
**HOLD=1** exits.

**M75 GitHub writer, M76 approval, M77/M78 staging HTTP routes,
M79 verification command and the older M47 prewrite-only lock-release
procedure remain unchanged. No real user Notes or drafts modified.**

## E13 / Milestone #81 — Independently pinned producer-signature claims

The default-OFF **offline** command
`npm run vault:quarantine:verify-producer-provenance` verifies three
**role-bound and independently pinned Ed25519 public key signatures**
for worker-shutdown, outstanding GitHub requests and encrypted draft
preservation evidence. Each producer signs the exact M79 owner/incident/
operation/repo scope, M78 HOLD review fingerprint/status and its own
M80 raw evidence SHA-256; separate producer keys are required from
each other and both M79 reviewers. M79 operator/reviewer signatures
and M80 on-disk SHA-256 checks are rerun. Successful verification
prints only redacted metadata, **exits 2 = HOLD**, never authorizes
postwrite lock release, safe retry or production cutover. It verifies
key signatures over FILE BYTES, not independent real producer identity,
truth of the underlying observations, complete app worker shutdown or
settlement of old GitHub PATCH. The three new trusted public keys
must be established in an independent protected registry.
See `docs/OGE_VAULT_QUARANTINE_PRODUCER_ATTESTATIONS_E13.md`.
