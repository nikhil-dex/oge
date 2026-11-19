# Oge Vault — Milestone #94 / Phase E26
## Real signed staging read-only acceptance harness — OPERATOR RUN REQUIRED

**Current status:** runnable operator tool and mocked regression tests. This milestone does **not** mean anyone has signed into real disposable staging, verified two physical devices, tested a real OAuth issuer, induced actual GitHub provider errors, or approved production. No such live run is performed in ordinary CI or by merely pushing this code.

### What already existed

- M61 GitHub App read-only client pairing probes private repository mapping using an explicitly configured operator scope; no browser OAuth acceptance.
- M82/M84 signed-session observation endpoint + local two-session drill accepts two independently captured private Playwright storage states; does NOT establish physical devices.
- M89/M92/M93 independently check a downloaded reference, a bounded 20-parent historical candidate, and a final current GitHub source read; the matching checks do NOT lock HEAD or authorize restoration.

### What #94 adds

The new `npm run vault:staging:m94-readonly-acceptance` command composes these existing protected read-only actions. It does not mint tokens, bypass OAuth, configure a staging deployment or create data.

1. **Fail closed before any request.** Require the exact independent M94 operator acknowledgment plus all M93/M92/M91/M89/M87 source/staging gates, M84 signed-device flag, a protected dedicated HTTPS staging origin, an isolated `oge_vault_restore_staging_*` Mongo replica set, existing preflight, all restore/import/write/delete/lock-release flags OFF. Never use production accounts.
2. Read two different operator-owned Playwright `storageState` files from absolute paths inside owner-only 0700 folders. Require 0600 regular no-symlink, single-link files (maximum 32 KiB), secure same-origin HttpOnly cookie and **distinct opaque session-token fingerprints**. Cookie hashes never leave the script.
3. Read two distinct private archive JSON files, one older candidate and one current reference, from owned 0700 folders and 0600 regular files (each at most 8 MiB). Both must pass the M88 local strict canonical format and full SHA-256 checks **before network**, with no private Note text printed.
4. Use the two signed staging sessions with the existing M82 **metadata-only signed-device-read** endpoint and two fresh different 32-byte challenges. Reject redirects, expired sessions, 401/403/429/5xx, malformed JSON or an untrusted/forged success. Do not print raw challenge or observation JSON. Two independently signed session reads do not prove two physical devices.
5. On session A only, run the actual M93 read-only workflow using one full historical read check and two current-reference checks. Only archive snapshot/tree hashes, two SHA-256 digests and three numeric counts are posted; never a file, Note body, title, UUID or draft. Strictly allowlisted endpoints, no redirects, TLS verification, bounded JSON results, and **no automatic retry**. Because M89 allows three source checks per owner per hour, a second full M93 flow for the same owner would exceed the limit.
6. Return **redacted metadata-only** `SIGNED_SESSIONS_AND_READ_ONLY_PROVIDER_CHECKS_OBSERVED_HOLD` on observed success; on ANY mismatch/error, return `BLOCKED`. No raw secrets, claim hashes, Note counts or owner identifiers. This is not external acceptance/signoff.

### Operator preparation — never paste secrets into a chat or issue

Only an authorized operator with access to a **disposable, access-restricted staging deployment** should perform these steps.

- Capture two independent logged-in staging Playwright session state JSON files via the trusted staging login flow (actual physical-device evidence must be separately obtained and reviewed).
- Download an existing synthetic/disposable current-resource JSON historical snapshot and a different reference snapshot using the owner-only staging backup endpoint. They must genuinely originate from the same disposable Vault; historical source must be in the bounded linear ancestry.
- Keep all four files on the operator's own machine under directories with mode 0700, with files mode 0600 and no symlinks. Do not commit these files, upload them, publish their names or store them as CI artifacts.
- Configure the required existing M84 and M93 staging environment privately (dedicated OAuth/GitHub App signing keys, isolated Atlas replica set, exact HTTPS origin and blocked write flags). Turn on only the read-only API/UI flags necessary for M82/M89/M92/M93. Confirm all restoration, migration, cutover, account deletion, quarantine release and import commit gates remain OFF.
- Explicitly set the additional M94 values in the private operator environment:

```bash
export OGE_VAULT_M94_READ_ONLY_ACCEPTANCE=YES_SIGNED_DISPOSABLE_READS_NO_WRITES
export OGE_VAULT_M94_OPERATOR_ACK=NO_REAL_USER_NOTES_OR_GITHUB_WRITES
# Also provide exact PRIVATE absolute file locations (never put live values in docs):
# OGE_VAULT_M94_DEVICE_A_STORAGE_STATE
# OGE_VAULT_M94_DEVICE_B_STORAGE_STATE
# OGE_VAULT_M94_HISTORICAL_BACKUP_FILE
# OGE_VAULT_M94_CURRENT_REFERENCE_FILE
npm run vault:staging:m94-readonly-acceptance
```

### Exit semantics

| Exit | Meaning |
|---|---|
| 1 | BLOCKED, unsafe/inconclusive, no automated retry |
| 2 | Real HTTPS read-only observations may have been recorded by an independently run operator command; human signoff remains **HOLD** |
| 0 | Never used for this command; cannot imply restoration or release approval |

The command makes only owner-scoped staging READ requests. The server's existing distributed rate limiter may write **transient request-count metadata**, not Notes. No new GitHub write token, note mutation, restore, import or quarantine release is introduced.

### Still unverified / remaining release blockers

The operator must separately verify OAuth issuer / callback/account boundaries, independent physical device origin, GitHub App repository ownership and permission scope, and provider failure observation (403/429/5xx/network failures) without unsafe real write fault injection. Evidence should be reviewed by an independent security reviewer. A successful read probe is never authority for a future GitHub write, a stale-head recovery, or release from a `github-write-possible` lock.

**Next #95:** independently review bounded, redacted live acceptance evidence and ensure that missing real-provider or physical-device proof always remains a HOLD. Maintain production and restore flags OFF.
