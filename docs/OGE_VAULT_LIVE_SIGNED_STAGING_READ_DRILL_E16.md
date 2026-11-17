# Oge Vault — E16 / Milestone #84: actual signed-session staging READ drill

**Status:** Operator-runnable, independently default-OFF staging-only Playwright
**READ-ONLY authenticated-session-state** harness. Implemented and synthetic
tests added; **no real session-state files, login credentials or physical devices
are available to CI or this development milestone**, so this is NOT a record
of a live OAuth/two-physical-device acceptance test.

## Purpose

M82 added a protected `POST /api/vault/acceptance/signed-device-read` route
requiring a current Auth.js signed-in owner and two independently requested
`contents:read` private GitHub App clients. M83 can correlate separately
captured redacted M82 reports and M67/M68's complete 12-scenario evidence
matrix. **M84 makes the M82 read check operator-executable against an actual
isolated HTTPS staging origin**, using Playwright's request client with
TWO separately provisioned, pre-authenticated private session-state JSON
files. No automatic OAuth login, Note mutation or provider fault injection
is performed.

New files:

- `lib/oge-vault-live-acceptance-drill.js`: pure configuration/response
  validation and injected-transport no-retry orchestration
- `scripts/run-vault-signed-staging-read-drill.mjs`: opt-in real HTTPS
  transport with Playwright APIRequestContext, two separate signed sessions
- `tests/oge-vault-live-acceptance-drill.test.js`: synthetic no-network
  failure/permission/origin/redirect/no-signoff test suite

## Safe prerequisites

Provision an **independently verified disposable staging** hostname with
HTTPS, dedicated GitHub App/OAuth credentials and an isolated staging DB
and private vault repository. Do not use production users, production
cookies, production user Notes or a shared GitHub repository. The
server's M82 read-only route must already be enabled after its own
independent staging preflight.

The operator must obtain and secure TWO **separately acquired**
`Playwright storageState()` JSON files from already signed-in
disposable staging sessions. This script does not create or manage
accounts. Files contain **live bearer session cookies**; protect them
as secrets, use short-lived sessions, revoke after the drill, never
copy them into a chat, commit them to Git, attach them to a PR, log
them, or share them with an operator who lacks access. Two distinct
storage-state files do NOT prove two physical devices. Capturing on
two distinct physical devices and independently verifying their origins
is a separate manual operator responsibility.

Strict input checks: distinct absolute JSON paths, owner-only 0600
single-hardlink nonsymlink regular files in owner-only 0700 folders,
each 80–32768 bytes, with no browser localStorage/origins, at most
15 cookies, **only secure HttpOnly exact staging-host cookies**, and
at least one Auth.js/NextAuth session cookie. File metadata is
rechecked before and after read. Equal session bearer-cookie
fingerprints are rejected; different values still do NOT establish
different real accounts or physical hardware. No raw session cookies
are printed or saved to result files.

The script requires TWO **different**, already-existing owner-private
0700 output directories, distinct from the session-state directories,
and refuses to overwrite existing `m84-observations.json` or
`m84-challenges.json` files.

## Explicit consent and operator environment

Default OFF:

```text
OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL=NO
```

Protected, nonproduction environment values:

```text
OGE_VAULT_LIVE_ACCEPTANCE_READ_DRILL=YES_TWO_PRIVATE_STAGING_SESSIONS_READ_ONLY
OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW=true
OGE_STAGING_URL=https://vault-staging.example.test
AUTH_URL=https://vault-staging.example.test
OGE_VAULT_BASE_URL=https://vault-staging.example.test
MONGODB_DB=oge_vault_restore_staging_<disposable>
OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID=<independently created M67 run UUID>
OGE_VAULT_M84_DEVICE_A_STORAGE_STATE=<absolute private A storageState JSON>
OGE_VAULT_M84_DEVICE_B_STORAGE_STATE=<different private B storageState JSON>
OGE_VAULT_M84_OBSERVATION_OUTPUT_DIR=<absolute owner-only output folder>
OGE_VAULT_M84_CHALLENGE_OUTPUT_DIR=<another owner-only output folder>
```

**EVERY destructive/cutover and standalone restore COMMIT/write ACK flag
must remain OFF.** This is only an operator-side guard; the dedicated
staging deployment independently enforces its own M82 staging checks.
Do not assume local environment values authenticate the live server.

After independently establishing the staging source, signed-in
sessions and private file permissions, run:

```sh
npm run vault:staging:run-signed-read-drill
```

The runner uses Playwright **APIRequestContext** (not a physical-device
browser automation), one context per storageState, and calls only
the pre-existing M82 read-only observation endpoint, one time per
session. It sends a distinct freshly generated 32-byte random
challenge and declared `device-a` or `device-b` label, with
same-Origin credentials and a 15-second timeout. It refuses redirects,
401/403/429/5xx, non-JSON, unexpected fields, missing negative safety
flags, changed challenge fingerprints or a false acceptance assertion.
**No retries**, no local GitHub App secrets or write-scoped tokens.
Although M82 reads are idempotent, normal remote audit or rate-limit
metadata may still be recorded by the staging server.

Output: two owner-private files created exclusively with mode 0600:

- `m84-observations.json`: redacted **M83-compatible pair** with
  run UUID, HTTPS origin and the two full M82 observation objects,
  but no session tokens or raw random challenges
- `m84-challenges.json`: original A/B random challenges, sensitive
  operator correlation material for later M83 review. Keep separately
  restricted; do not attach to public code/CI.

The stdout summary is metadata-only and explicitly
`twoPhysicalDevicesIndependentlyVerified:false`,
`actualOAuthIssuersIndependentlyVerified:false`,
`sessionSourceProvenanceVerified:false`,
`realProviderFaultMatrixExecuted:false`,
`completeStagingAcceptanceSignedOff:false`,
`canEnableProduction:false`,
`canReleaseImportLock:false` and
`canRetryUnknownWrite:false`.

Exit **2** means two redacted responses passed exact schema checks and
were saved; still **HOLD pending independent review**. Exit **1**
means missing credentials, unsafe files/flags, real network 401/403/429,
unexpected redirect or provider failure, mismatched observations, or
other error. **Never exit 0 as a release/acceptance instruction.**

If output creation fails halfway, the already-created file may remain
private and incomplete; the runner refuses overwrites. The operator
must inspect and securely dispose of an incomplete test run, instead
of treating partial output as an accepted two-device pair.

## How to use with M83

After independently collecting the 12 actual disposable staging
scenario observations and running the **M68 actual on-disk hash
verification**, supply `m84-observations.json` as
`OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE`, the original values from
the separately restricted `m84-challenges.json` via M83's
`OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX` and
`OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX`, and the same
operator-issued M67 run UUID. Invoke:

```sh
npm run vault:staging:review-signed-device-pair
```

M83 remains a read-only inventory inspector and never verifies
live source provenance, actual physical devices or actual provider
write-failure scenarios. A complete 12-scenario M67/M68 matrix with
matching M82 observations returns only HOLD **exit 2** for
independent external acceptance review.

## Remaining real acceptance tests

External operators must still verify genuine GitHub OAuth issuer,
two physically distinct signed-in devices and account sessions,
GitHub App installation and revocation, real 403/429/409/422,
read-only permissions, independently captured encryption/backups,
multi-device autosave conflict fencing and ambiguous GitHub writes,
and zero outstanding previous writer executions. Those scenarios
require independently authorized **disposable** data and specific
fault-testing procedures. **This read-only runner does not execute
them**, and it cannot release any `github-write-possible` lock.

## CI

```sh
node --test tests/oge-vault-live-acceptance-drill.test.js
npm run lint
npm test
npm run build
```

CI tests the injected transport and guard in memory, **never using
real authenticated staging session-state files**, never contacting
a remote GitHub/App endpoint and never enabling production flags.
Existing anonymous local Chromium smoke tests remain separate.

**No real user Notes were modified, no production deploy or merge.
PR #35 remains DRAFT/UNMERGED.**
