# Oge Vault — E13 / Milestone #81: signed evidence-producer provenance claims

**Status:** implemented **OFFLINE, READ-ONLY, DEFAULT-OFF** three-source
producer signature verification over M79/M80 quarantine evidence. Never a
post-GitHub-write lock-release authorization. PR #35 stays DRAFT, no
deployment, production flags OFF.

## Security problem and answer

M79 proves two independently trusted Ed25519 signing keys agreed on a
metadata-only incident dossier. M80 proves the bytes of three local
evidence files match the signed SHA-256 digests. Neither proves that the
original evidence was created by a trustworthy producer.

M81 adds three **separate role-bound Ed25519 producer attestations**. The
owner-independent/operator-registered public trust anchors are provided
through a separate protected channel. No producer private signing key
is stored in Oge, MongoDB, GitHub, CI or this repository. M81 verifies
producer signatures over the **same incident, owner scope, repository,
restore operation, M78 review fingerprint, status and exact SHA-256**
already bound by M79. M80 independently rehashes the actual three
private files. Signed metadata and bytes must match.

**Crucial distinction:** M81 establishes cryptographic *key possession*
for three independently pinned **key roles**, not independently
authenticated real-world producer identity, the truth of evidence
statements, completeness of app shutdown telemetry, absence of
outstanding GitHub PATCH requests, or permission to unlock. Claims
signed by a configured key could still be inaccurate or malicious.

## Three producer roles

| Role / M79 evidence hash | Local M80 file | Role-specific pinned key |
|---|---|---|
| `writerShutdownSha256` | `writer-shutdown.redacted.txt` | `OGE_VAULT_QUARANTINE_WORKER_PRODUCER_PUBLIC_KEY_DER_BASE64` |
| `outstandingGitHubRequestsSha256` | `outstanding-github-requests.redacted.txt` | `OGE_VAULT_QUARANTINE_GITHUB_REQUESTS_PRODUCER_PUBLIC_KEY_DER_BASE64` |
| `encryptedDraftPreservationSha256` | `encrypted-draft-preservation.redacted.txt` | `OGE_VAULT_QUARANTINE_DRAFTS_PRODUCER_PUBLIC_KEY_DER_BASE64` |

All three trusted **SPKI DER Ed25519** public keys must be distinct
from each other **and** from both M79 operator/reviewer keys. A
producer signature is never accepted for the wrong role. The trusted
keys must come from an authenticated registry/independent operator
channel, not from the submitted producer manifest itself.

## Separate signed producer manifest

`producerManifest` (private local JSON) must contain *exactly* these
fields:

```json
{
  "format": "oge-vault-quarantine-three-producer-attestations",
  "version": 1,
  "attestations": {
    "writerShutdownSha256": {
      "claim": {
        "format": "oge-vault-quarantine-producer-evidence",
        "version": 1,
        "role": "writerShutdownSha256",
        "incidentId": "<same incident UUID as trusted M79 owner scope>",
        "operationId": "<same quarantined operation UUID>",
        "ownerScopeSha256": "<same owner incarnation digest>",
        "repoId": 12345,
        "installationId": 23456,
        "reviewFingerprint": "<same M78 review SHA256>",
        "reviewStatus": "HOLD_REMOTE_OUTCOME_UNPROVEN",
        "artifactSha256": "<same signed M79 writerShutdownSha256>",
        "capturedAt": "2026-11-17T12:58:00.000Z",
        "confirmation": "ATTEST_EVIDENCE_DIGEST_ONLY_NO_UNLOCK"
      },
      "signature": {
        "keyFingerprint": "<SHA256 of trusted role Ed25519 SPKI DER>",
        "signature": "<Ed25519 64-byte signature base64url>"
      }
    },
    "outstandingGitHubRequestsSha256": "<same claim/signature shape, role and artifact digest adjusted>",
    "encryptedDraftPreservationSha256": "<same claim/signature shape, role and artifact digest adjusted>"
  }
}
```

All strings above containing `<...>` are explanatory placeholders;
operational JSON must contain the corresponding actual types. Every
claim is canonicalized and domain-separated with
`oge-vault-quarantine-evidence-producer-m81-v1\n` by
`quarantineProducerSigningBytes(claim)`, then signed with the
**separately held corresponding producer private key**. Do not sign
raw, differently ordered untrusted JSON.

A producer `capturedAt` is a *claim* and must be valid millisecond ISO
UTC, within the **15 minutes prior to the M79 issuedAt timestamp**,
not in the future. This does not prove when the original event happened.
The M79 two-reviewer signed dossier itself must still be valid at
verification time, and any changed scope/claim/signature/file fails
closed.

## Offline operator verification (no app endpoint)

New command:

```sh
npm run vault:quarantine:verify-producer-provenance
```

This command requires **all M79 and M80 existing guards**, including
separate independently trusted incident scope, signed review,
two reviewer public keys, protected staging origin string, isolated
`oge_vault_restore_staging_*` environment marker, disabled commit,
cutover/delete flags and private owner-only source files.

New M81 values are default OFF:

```text
OGE_VAULT_QUARANTINE_PRODUCER_REVIEW=YES_OFFLINE_THREE_DISTINCT_SIGNED_PRODUCERS_ONLY
OGE_VAULT_QUARANTINE_PRODUCER_MANIFEST_FILE=<private absolute JSON path>
OGE_VAULT_QUARANTINE_WORKER_PRODUCER_PUBLIC_KEY_DER_BASE64=<trusted role-specific SPKI DER key>
OGE_VAULT_QUARANTINE_GITHUB_REQUESTS_PRODUCER_PUBLIC_KEY_DER_BASE64=<different trusted role-specific SPKI DER key>
OGE_VAULT_QUARANTINE_DRAFTS_PRODUCER_PUBLIC_KEY_DER_BASE64=<third trusted role-specific SPKI DER key>
```

The producer JSON must be an owner-only, regular, nonsymlink,
one-hardlink, bounded private file inside a private owner-only directory
and separate from the three data files. The M80 evidence directory
still must contain exactly the three fixed-name private regular files,
with byte hashes matching their producer and M79 reviewer signatures.

The command returns **only redacted metadata** and never opens a
GitHub App connection, database or remote service. It does not modify
receipts, Notes or account locks.

**Exit 2 — HOLD:** all five trusted role signatures, incident
bindings and three exact local SHA-256 digests matched. Status:
`THREE_PRODUCER_SIGNATURES_AND_ARTIFACT_HASHES_MATCH_HOLD`.

**Exit 1 — BLOCKED/HOLD:** any invalid scope, signing key, replay,
forgery, missing/extra private file, unsigned or inconsistent digest,
untrusted review, changed local file or unsafe environment.

**Never exit 0 for a verified report.** A positive result remains
quarantined. Explicit report safety flags include:
`realProducerIdentityIndependentlyAuthenticated:false`,
`captureSourceAuthenticatedByExternalSystem:false`,
`allWorkersQuiescedVerified:false`,
`allOutstandingGitHubRequestsSettledVerified:false`,
`operatorUnlockAuthorized:false`,
`safeToRetryAutomatically:false` and
`quarantineReleasePerformed:false`.

## Remaining obligations before any actual incident recovery

An authorized operator must still independently establish **which
real system and individuals actually control these producer keys**,
whether the captured evidence is true and complete, and whether any
old GitHub write or async worker may still execute. Also needed:
fresh owner/repository state, preserved unsaved drafts, trusted archive
source, a separately designed reviewed postwrite-lock recovery
transaction, independent security audit and real OAuth/App two-device
acceptance. A signed claim is not a signed fact about the real world.

## Tests

```sh
node --test tests/oge-vault-quarantine-producer-provenance.test.js
npm run lint
npm test
npm run build
```

Tests use five fresh synthetic Ed25519 key pairs plus real private
files and the guarded offline CLI: valid exact incident signatures,
role swapping, duplicate reviewer/producer keys, claim/body/digest/
operation/repo tampering, wrong timestamps, bad base64 signatures,
missing/extra claims, changed local file, symlink and wrong
independently pinned trust key.

Existing M75–M80 read and write implementations are unchanged.
