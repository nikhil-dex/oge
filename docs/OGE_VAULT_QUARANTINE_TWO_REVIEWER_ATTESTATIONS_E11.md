# Oge Vault — E11 / Milestone #79: offline two-reviewer signed incident evidence

**Status:** implemented as an OFFLINE, local-file-only, **read-only**
cryptographic *attestation verification* prototype. **Not authorization to
release a post-write quarantine**, not proof that a prior GitHub request has
stopped, not a live identity check, and not source-archive authentication.
Production settings remain OFF. PR #35 remains DRAFT.

## Goal and trust boundary

The E10/M78 signed-owner staging review packet is a redacted snapshot of
GitHub history, owner lock, M76 receipt, active writers and encrypted
draft presence. Its `reviewFingerprint` is an ordinary SHA-256 correlation
digest, **not** a cryptographic owner or operator signature. M78 returns
`HOLD_*` in every situation.

M79 lets TWO separately trusted offline Ed25519 public-key holders sign the
**same exact metadata-only incident dossier** and validates both signatures
locally against **independently configured** trust anchors. One signer is the
incident operator, the other an independent reviewer. Both attest to
identical immutable *metadata claims*, not to verified physical presence,
genuine GitHub source identity, absence of in-flight requests, or success of
a locked account recovery. No signature here can authorize a write.

This is deliberately separate from M76's short-lived HMAC user approval.
Neither the original note archive nor the signed user M76 ticket is embedded
in the operator dossier.

## Signed claim: exact schema, stable canonical order

The signed `dossier.claim` has exactly the following fields:

```json
{
  "format": "oge-vault-standalone-quarantine-attestation",
  "version": 1,
  "incidentId": "<exact UUID of separately authorized incident>",
  "operationId": "<exact vaultImportLock operation UUID>",
  "ownerScopeSha256": "<SHA-256 of exact independently established owner scope>",
  "repoId": 12345,
  "installationId": 23456,
  "kind": "quick-notes",
  "selectedCount": 2,
  "reviewFingerprint": "<exact hex SHA256 from original M78 packet>",
  "reviewStatus": "HOLD_HISTORICAL_CREATE_PROVEN_NOT_QUIESCENCE",
  "evidenceHashes": {
    "writerShutdownSha256": "<SHA-256 of external shutdown evidence>",
    "outstandingGitHubRequestsSha256": "<SHA-256 of external in-flight request evidence>",
    "encryptedDraftPreservationSha256": "<SHA-256 of encrypted draft preservation evidence>"
  },
  "issuedAt": "2026-11-17T13:00:00.000Z",
  "expiresAt": "2026-11-17T13:15:00.000Z",
  "confirmation": "ATTEST_INCIDENT_REVIEW_ONLY_NO_RELEASE"
}
```

All UUIDs are canonical lowercase, all SHA-256 values are lowercase 64-hex,
both timestamps must be canonical ISO UTC millisecond timestamps and
`expiresAt - issuedAt` must equal **15 minutes**. Only one-kind
`quick-notes` or `airnotes`, selected count 1–12 and the exact M78
`HOLD_*` classification may be signed. No partial field sets,
unknown fields or request for unlocking are accepted.

The Ed25519 message is exactly
`quarantineAttestationSigningBytes(claim)`, produced by
`lib/oge-vault-quarantine-dual-review.js`, with a dedicated
`oge-vault-quarantine-two-reviewers-m79-v1\n` domain separator and
canonical JSON field order. **Never directly sign a differently serialized
untrusted JSON string.** Externally managed reviewer *private keys* must
never be supplied to Oge or added to Git, MongoDB, .env, CI or incident
archives.

The dossier also carries exactly:

```json
{
  "claim": "<the complete exact claim object above>",
  "signatures": {
    "operator": {
      "keyFingerprint": "<SHA-256 of operator Ed25519 SPKI DER public key>",
      "signature": "<64-byte Ed25519 signature in base64url>"
    },
    "reviewer": {
      "keyFingerprint": "<SHA-256 of reviewer Ed25519 SPKI DER public key>",
      "signature": "<64-byte Ed25519 signature in base64url>"
    }
  }
}
```

The string placeholders above describe actual required types; neither
`claim` nor `signatures` may contain literal placeholder strings.
The two signatures MUST cover **identical** canonical signed bytes.
Keys must be distinct canonical Ed25519 SPKI public keys and matched to
separate trusted roles. RSA, ECDSA, one duplicated key, swapped roles,
forged or noncanonical signature encoding, mismatched incident/owner
scope, stale/future expiry and changed evidence digest all fail closed.

The claim's three external SHA-256 hashes are **declared fingerprints**,
NOT proof that external files have been captured, signed by their original
system, remain available, or establish writer quiescence. M79 deliberately
does not access or attest to those external files. A separate evidence-
provenance and worker-shutdown investigation remains required.

## Offline verification workflow (no HTTP endpoint)

The new `npm run vault:quarantine:verify-two-reviewers` command is
**default disabled**. It accepts TWO private owner-only, nonsymlink files
(a complete redacted M78 review packet and the separately signed
dossier). It refuses non-owner and group/world-readable files or parent
directories, nonabsolute paths, changed-on-read files and oversized JSON.
No Notes, GitHub App credentials, MongoDB URI, raw source archive or
private note bodies are loaded.

Its *expected incident scope* and *trusted Ed25519 public keys* must come
from the access-controlled operator environment, **not from the dossier
it is validating**:

```text
OGE_VAULT_QUARANTINE_SIGNATURE_REVIEW=YES_OFFLINE_SIGNED_TWO_REVIEWERS_ONLY
OGE_VAULT_QUARANTINE_DOSSIER_FILE=<absolute owner-private JSON pathname>
OGE_VAULT_QUARANTINE_M78_REVIEW_FILE=<absolute owner-private M78 JSON pathname>
OGE_VAULT_QUARANTINE_EXPECTED_INCIDENT_ID=<independently known incident UUID>
OGE_VAULT_QUARANTINE_EXPECTED_OPERATION_ID=<independently known lock operation UUID>
OGE_VAULT_QUARANTINE_EXPECTED_OWNER_SCOPE_SHA256=<independently derived owner scope SHA256>
OGE_VAULT_QUARANTINE_EXPECTED_REPO_ID=<exact trusted GitHub repo numeric ID>
OGE_VAULT_QUARANTINE_EXPECTED_INSTALLATION_ID=<exact trusted installation ID>
OGE_VAULT_QUARANTINE_OPERATOR_PUBLIC_KEY_DER_BASE64=<trusted Ed25519 SPKI DER key>
OGE_VAULT_QUARANTINE_REVIEWER_PUBLIC_KEY_DER_BASE64=<different trusted Ed25519 SPKI DER key>
OGE_STAGING_URL=https://<protected dedicated staging origin>
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

The private files, keys and trusted expected values are provisioned by the
operator's protected secret manager/environment rather than Git or a
shell command line. The offline command intentionally refuses production
origin/DB patterns and enabled standalone commit, destructive or cutover
flags. It imports no MongoDB driver, Auth.js or GitHub client.

After provisioning those values, invoke:

```sh
npm run vault:quarantine:verify-two-reviewers
```

**Exit codes:**

- **2:** two cryptographic signatures validated against trusted independent
  public keys and exact independently provided scope; account **still
  quarantined**. A nonzero result prevents success=0 being misinterpreted
  by automation as an instruction to release a lock.
- **1:** missing/unsafe context, invalid files, bad/mismatched/expired
  signatures, unsafe M78 review or other failure; **stay quarantined**.

No code path in M79 has permission to sign an attestation, write to a Git
repository, alter a MongoDB receipt/account lock, call M47 release, decrypt
drafts, issue a new M76 ticket or mark an incident as recovered.

## Strict report semantics

Even after two signatures verify, the *redacted* report explicitly says:

- `TWO_SIGNATURES_VERIFIED_QUARANTINE_STILL_HELD`
- `externallyRecordedEvidenceArtifactsVerified:false`
- `priorGitHubWriterStoppedProven:false`
- `independentPhysicalPersonIdentityVerified:false`
- `privateGitHubRepositoryRecheckedNow:false`
- `operatorUnlockAuthorized:false`
- `automaticUnlockAuthorized:false`
- `safeToRetryAutomatically:false`
- `quarantineReleasePerformed:false`

It returns no owner ID, operation UUID, incident UUID, note content,
GitHub token, reviewer signature or trusted public-key bytes. The
`reportFingerprint` is a comparison SHA-256 digest, **not** an
authorization token. Review records are not persisted in MongoDB.

**A cryptographically signed claim is not automatically a true claim.**
A trusted independent human must still assess the actual owner,
live GitHub/App session, provenance of external evidence, shutdown of
all app instances and in-flight GitHub requests, draft preservation, any
later selected-file edits, and the scope of a distinct recovery procedure.
No post-write lock-release mechanism has been added.

## Tests

```sh
node --test tests/oge-vault-quarantine-dual-review.test.js
node --test tests/oge-vault-quarantine-dual-review-cli.test.js
npm run lint
npm test
npm run build
```

Tests include real ephemeral Ed25519 key pairs, two signatures covering
the same canonical bytes, changed owner/repo/installation/incident/UUID,
tampered report/digests, stale/future and noncanonical timestamps, forged
signatures, swapped/duplicate keys, RSA keys, default-off private CLI
safety, redacted output and the **HOLD=2** return code.

**M78 and M77 read-only staging endpoints remain unchanged, M75 write
and production flags remain OFF, and PR #35 remains DRAFT/UNMERGED.**
