# Oge Vault — Milestone #96 / Phase E28
## Two-reviewer signed HOLD acknowledgment — NEVER a release ticket

**State:** offline code and synthetic signature tests, NOT real staging OAuth or external human acceptance. PR #35 remains draft and no production user content is involved.

### Security reason for this milestone

M95 establishes integrity of locally supplied evidence and correlates a declared run identifier. Even complete M95 evidence does **not** prove that two physical devices logged in via legitimate OAuth, that the provider issued particular claims, or that the capture producer described actual events. The previous quarantined-write Ed25519 pattern (#79–81) gives us a separate, narrow improvement: authenticate which **independently trusted signing keys** have acknowledged the existing uncertainties without ever treating their signatures as release approval.

### What changed

- M95 offline review command can now **optionally** write its redacted HOLD result to `OGE_VAULT_M95_PRIVATE_REVIEW_FILE` using `O_CREAT|O_EXCL|O_NOFOLLOW`, owner-only 0700 parent and 0600 report file, no overwrite. This is a local output only.
- New `vaultM96HoldReviewSigningBytes(claim)` returns stable domain-separated canonical UTF-8 bytes, so two external, independently administered Ed25519 signers can sign **the identical exact claim** without sharing their private keys with this repository.
- New **default-off** `npm run vault:staging:m96-hold-release-review` checks a private M95 report file and separately provided M96 dossier, verifies the report's entire exact serialized SHA-256 against a trusted out-of-band value, and authenticates two separate signatures to independently pinned public keys.
- The claim covers only **run-binding SHA-256**, **M95 report SHA-256**, exact M95 HOLD status, issue/expiry times and `TWO_REVIEWERS_ACKNOWLEDGE_EVIDENCE_GAPS_HOLD_ONLY`. The signed review validity is **15 minutes**; expired/future/other-run, swapped roles or same key pretending to be two reviewers fail closed.

### Operator expectations

1. Securely obtain the M95 private report from an independent operator in disposable, isolated staging. Run the M95 offline verifier with `OGE_VAULT_M95_PRIVATE_REVIEW_FILE=/absolute/owner-only/dir/m95-report.json`, if evidence is available. DO NOT copy real browser sessions, OAuth secrets, Note bodies or private keys into this repo.
2. Independently calculate the **exact M95 JSON bytes' SHA-256**, e.g. `shasum -a 256 /private/dir/m95-report.json` on Mac. Obtain run ID/origin and verifier public keys via separate trusted channels, not from the submitted dossier itself.
3. Two independent authorized reviewers, using **outside signing systems**, examine the unresolved evidence gaps. They each produce an Ed25519 signature over the identical return value of `vaultM96HoldReviewSigningBytes(claim)`. Their signed confirmation is strictly *HOLD-only*. This repository never generates or handles private signing keys.
4. Store only the narrowly scoped claim and two signatures in an operator-private 0600 file under a 0700 directory. Independently provision two distinct Ed25519 SPKI DER public keys as base64 strings. Do not put reviewer public identities, evidence files, claims, private tokens or hashes in CI logs/issues.
5. Run the following **offline** review command only with complete protected staging environment and no dangerous feature flags:

```bash
export OGE_VAULT_M96_DUAL_HOLD_REVIEW=YES_TWO_INDEPENDENT_ED25519_KEYS_EVIDENCE_HOLD_ONLY
# Also set exact private absolute paths and trusted checksums:
# OGE_VAULT_M96_M95_REVIEW_FILE
# OGE_VAULT_M96_HOLD_DOSSIER_FILE
# OGE_VAULT_M96_EXPECTED_M95_SHA256
# OGE_VAULT_M96_OPERATOR_PUBLIC_KEY_DER_BASE64
# OGE_VAULT_M96_REVIEWER_PUBLIC_KEY_DER_BASE64
# OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID
# OGE_STAGING_URL == AUTH_URL == OGE_VAULT_BASE_URL
# MONGODB_DB=oge_vault_restore_staging_<isolated>
npm run vault:staging:m96-hold-release-review
```

### Exit codes

| Code | Meaning |
|---|---|
| 1 | BLOCKED: invalid trust root, modified report/signature, stale time, unsafe file, wrong run, missing gate or positive authorization claim |
| 2 | TWO KEYS SIGNED EXACT EVIDENCE HOLD; full external manual acceptance STILL PENDING |
| 0 | NEVER emitted; no GitHub write, restore, import, lock release, retry or deployment approval |

### Explicit unresolved release requirements

A signer signature authenticates only possession of the corresponding independently trusted key, not a human's identity or proof that a statement is true. A report SHA-256 proves local bytes match a previously recorded digest, not real OAuth/device/provider provenance. In particular, this review does **not** perform any real GitHub checks, does not force writer quiescence and does not verify historical restoration safety.

Actual disposable staged OAuth flow, two physical-device identity checks, provider 403/429/5xx/timeout handling, independently witnessed authentic evidence capture, backup completeness and full audited restore authorization are still **open**. The review output always has `securityReleaseApprovalGranted: false`, `productionReady: false`, `canAuthorizeRestore: false`, `canReleaseImportLock: false` and `canRetryUnknownWrite: false`.

### Next roadmap choice

More security-report layers cannot substitute for an actual independently operated staging experiment. #97 should resume the **Oge extension / Oge Learning Tracks** product roadmap in a separated workstream while the Vault recovery draft remains in HOLD. Avoid enabling any restoration/production flag without real external acceptance and a separate audited design.
