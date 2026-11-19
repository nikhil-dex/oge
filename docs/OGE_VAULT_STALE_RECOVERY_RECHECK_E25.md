# Oge Vault — Milestone #93 / Phase E25
## Final read-only current GitHub stale-state recheck and owner decision states

**Prototype only. Disabled by default. No restore, merge, write, approval, or quarantine release.**

### Scope

E24/M92 verifies a bounded historical source and a current reference separately. An intervening writer may advance GitHub HEAD after either check. E25 narrows this exposure by performing a **second independently authenticated M89 current-source comparison** after the M92 historical verification, the first current-source comparison, and the in-browser conflict calculation, but **before displaying** the comparison report.

This is intentionally only an additional observation of CURRENT GitHub. It is not an atomic GitHub transaction, a writer lock, a durable authenticity receipt, or an authorization to write.

### Owner-facing flow

1. In the existing HTTPS staging Recovery Center, the signed-in Vault owner explicitly picks the historical backup and current reference **in two distinct inputs**. Local M88 strict canonical JSON, UTF-8, file size (8 MiB each), resource structure and embedded SHA-256 validation completes for **both** before any request.
2. When all previous isolated flags and the new E25 flag are enabled, issue one M92 read-only historical candidate fingerprint check (up to 20 single-parent Git ancestor edges); no private Note text, title, UUID or file bytes cross the network.
3. Independently issue one M89 authenticated current-reference fingerprint check. A mismatch/error produces a HOLD without conflict counts.
4. Compute the Notes/Quick Notes/AirNotes local conflict counts in temporary browser memory only, **but do not publish them yet**.
5. Issue a **second M89 current-reference check** using the exact same bounded metadata. A HEAD change, unmatched SHA-256, rate limit, provider outage or forged success/unlock flags cause HOLD/error with **no conflict counts**.
6. Only after all three read-only checks pass, disclose aggregate potential additions, conflicts, unchanged and current-only preserved counts. Show a **manual owner review state**, never an approval or restore action.

### Read-only decision states

- `HISTORICAL_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD`: candidate not authenticated against bounded history; no plan.
- `CURRENT_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD`: first current-reference comparison did not match; no plan.
- `CURRENT_PRIVATE_GITHUB_RECHECK_STALE_HOLD`: final current GitHub recheck differed; no plan.
- Network or validation failures: fail closed and show no authenticated counts.
- `MANUAL_CONFLICT_REVIEW_REQUIRED_NO_RESTORE`: one or more same-ID SHA conflicts; human review required, no write.
- `MANUAL_ADDITION_REVIEW_REQUIRED_NO_RESTORE`: no ID conflict but potential additions; human review required, no write.
- `READ_ONLY_REVIEW_REQUIRED_NO_RESTORE`: verified comparison is informational; still no restore permission.

### Rate limits and costs

The M92 history endpoint allows two historical scans per owner/hour. E25 consumes **two of the existing three M89 current-source checks per owner/hour** per successful attempt, and can read many GitHub blobs each time. Do not automatically retry failed or rate-limited checks. Use synthetic data and a dedicated disposable staging Vault.

### Environment

```env
OGE_VAULT_RECOVERY_CENTER_PREVIEW=false
OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW=false
OGE_VAULT_RESTORE_SOURCE_PREVIEW=false
OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW=false
OGE_VAULT_RECOVERY_STALE_RECHECK_PREVIEW=false
```

The last flag is independent, default OFF, and is allowed only when all M92/M91/M89/M87 signed-owner HTTPS isolated-staging gates remain satisfied. There is no new route and no write token.

### Critical limitations

- Any GitHub write immediately **after the final recheck** can stale the screen. The history and current checks are still **non-atomic**. Every future restore proposal would need fresh transactional compare-and-swap protections plus explicit audited owner authorization and independent writer/quarantine controls.
- Only currently committed Notes, Quick Notes and AirNotes are covered; revisions, encrypted drafts, legacy MongoDB notes and Learning Tracks are outside this current-resource archive.
- Private plaintext exists briefly in browser JavaScript memory and cannot be guaranteed to be securely erased. No private Note contents or IDs are uploaded, rendered or stored in React state.
- Current branch authenticity depends on trusted Oge server, owner's scoped GitHub App and HTTPS. Checks are not externally signed receipts or source-independent proofs.
- Tests use synthetic provider clients. Real OAuth/two-device/provider failures and outside security acceptance remain **pending**. No production cutover.

### Next milestone

#94 should prioritize staging-only live OAuth/real GitHub App read acceptance and fault testing with disposable accounts and two physical devices, **without enabling any restoration or GitHub writes**. Do not expand restore power until these release gates pass.
