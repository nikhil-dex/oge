# Oge Vault — E27 / Milestone #95
## Private offline evidence integrity and signed acceptance correlation (HOLD)

**Status:** code + synthetic/offline tests only. GitHub PR #35 stays draft. This is NOT real OAuth/physical-device/provider-fault acceptance or production signoff. It creates no OAuth credentials, browser session, network requests, GitHub write permission, import, restore, unlock or auto-retry.

### Prior evidence systems
- M82/M84 can record read-only authenticated session observations on a protected staging server but does not prove the associated physical devices or issuer.
- M67/M68 index and hash redacted external scenario files; actual content and capture authenticity are outside those hashes.
- M83 correlates M82 observations with independently provided challenges and the verified M67/M68 on-disk artifacts. It explicitly returns HOLD.
- M94 performs, only if separately operator-invoked, two signed session reads and one M93 private GitHub read chain (1 bounded history + 2 current) and emits a redacted observation summary. No actual live invocation is performed in CI.

### New M95 workflow
1. An authorized operator, using **only synthetic/disposable signed HTTPS staging accounts**, runs `npm run vault:staging:m94-readonly-acceptance`. Optionally set `OGE_VAULT_M94_PRIVATE_REPORT_FILE` to a private absolute filename inside owner-only 0700 directory; runner creates it once as 0600 using `O_EXCL|O_NOFOLLOW`, containing **only the redacted M94 summary and SHA-256 run/origin binding**. This report is an **observation claim**, not provider-signed evidence. Its run digest cannot prove device identity.
2. A separate, trusted operator obtains the **SHA-256 checksum of the exact private report bytes** out-of-band (for example, on macOS: `shasum -a 256 /private/owner-only/m94.json`). Supply that expected checksum privately to the M95 offline reviewer. Do not paste checksums, paths, session tokens, or evidentiary files into issues/chats.
3. Collect the **existing M83** inputs from a separately reviewed channel: M67 manifest, complete directory of redacted scenario evidence, M82 pair, independent challenge hex values, and expected run ID. M95 verifies report SHA-256 and canonical JSON, private 0700/0600 owner/no-symlink/single-link file safety, and the **SHA-256 run binding** against the independently specified run ID/origin.
4. M95 then calls the *existing* `verifyVaultTwoDeviceEvidenceArtifacts` (M68/M83), which independently rehashes every required on-disk scenario file and checks exact signed-session challenge fingerprints and reported scenario completeness.
5. The M95 output contains **only** the final redacted claim-level HOLD and fixed negative security flags. There is no HTTP request, GitHub/MongoDB client, note body, owner identifier, raw challenge, Git SHA, private hash or file path returned.

### Required operator-only configuration

Use privately held complete existing M83 staging configuration and:

```bash
export OGE_VAULT_M95_OFFLINE_EVIDENCE_REVIEW=YES_VERIFY_PRIVATE_M94_M83_ARTIFACTS_HOLD_ONLY
export OGE_VAULT_M95_M94_REPORT_FILE=/private/dir/m94.json
export OGE_VAULT_M95_EXPECTED_M94_SHA256=<trusted-out-of-band-64hex>
# Existing M83 variables, all private:
# OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW
# OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW
# OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE
# OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY
# OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE
# OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID
# OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX
# OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX
# OGE_STAGING_URL=AUTH_URL=OGE_VAULT_BASE_URL
# MONGODB_DB=oge_vault_restore_staging_<disposable>
npm run vault:staging:m95-review-private-evidence
```

All restoration/import/cutover/delete/write acknowledgment flags MUST be off. The complete expected report hash must come from an independent trusted channel, not blindly copied from the submitted untrusted report.

### CLI exit results

| Exit | Status | Meaning |
|---|---|---|
| 1 | BLOCKED | Unsafe path/permission, tampered hash, unmatched run/challenge, forged approval field, missing evidence, or invalid schema; no automatic retry |
| 3 | INCOMPLETE HOLD | Private hashes/checks intact, reported scenario matrix or signed observations incomplete |
| 2 | READY FOR EXTERNAL MANUAL REVIEW HOLD | Private hashes and reported scenario claims correlate; requires independent human verification |
| 0 | NEVER | No state of this tool authorizes restore/deploy/lock release |

### Explicit trust limitations
- A SHA-256 hash matching a locally submitted report is **not** a digital signature, source provenance, GitHub ownership proof, authentication of the report's producer, or assurance that real provider requests occurred.
- Correlation of an operator-declared M94 run ID with M83 evidence **does not cryptographically bind** the M94 report to the same two physical devices or the precise M82 observations. Source capture must be independently verified by a human/security process.
- M67 evidence descriptions and "observed-pass" assertions can be forged; actual provider 403/429, OAuth issuer identity, two physical-device origin, browser session provenance, and independent reviewer approval are **still unverified**.
- The GitHub reference may change after any read. The workflow is not a durable or atomic restore safety guarantee.
- Real notes are not backed up or restored by this tool; only three current resource kinds appear in previous snapshots. Encrypted drafts, Learning Tracks, historical revisions and legacy Mongo records are still excluded.

### Next
#96 should prioritize **external** staging acceptance and security review with actual independently controlled devices and disposable accounts, **or** return to Oge Extension/Learning Tracks product work while these security gates stay closed. Do not merge/deploy the recovery preview or unlock restoration merely because CI or this offline reviewer returns a HOLD=2.
