# Oge Vault — E15 / Milestone #83: signed-session TWO-device evidence-pair readiness

**Status:** Implemented as a separately default-OFF, **OFFLINE/read-only**
operator acceptance readiness report for M82 signed-in browser observations
combined with the full M67/M68 12-scenario failure matrix and its actual
private file SHA-256 verification. **NOT a live OAuth, physical device,
provider failure, independent evidence provenance or production signoff.**

## Purpose and strict limitations

M82 gives each logged-in *staging* browser a nonce-bound private GitHub
App read-only observation. M67 lists 12 operator-observed scenarios,
including OAuth on device A/B, autosave fencing and GitHub error cases;
M68 hashes every referenced local redacted artifact. None
independently proves the captured observations genuinely came from
the claimed physical device, OAuth issuer, GitHub provider or source
system. M83 pairs those *self-reported* observations with an exact
one-run M67/M68 evidence inventory without falsely issuing signoff.

The result is *metadata completeness for an independent human
operator/security review*, never a production approval or credential.
This milestone is not a browser automation that logs into real devices,
nor is it an automatic GitHub write or provider failure injector.

## Inputs, each from a separate channel

- A protected real staging origin such as
  https://vault-staging.example.test and isolated
  MONGODB_DB=oge_vault_restore_staging_<disposable> marker.
- The existing M67 redacted 12-case evidence manifest from the
  actual, independently run staging drill, and its 12 bounded
  private redacted file artifacts in a separate 0700 directory.
  M68 uses ONE read of that exact manifest to validate its M67
  metadata and all corresponding raw on-disk SHA-256 digests before
  pairing. Unknown, missing, duplicate or altered files fail closed.
- A 0700-private-directory, 0600-owner-only *pair JSON* of two M82
  responses, one with declared device-a and one with declared device-b.
  The pair is NOT a signed attestation or hardware proof.
- An independently obtained M67 run UUID and the TWO **original**
  random M82 32-byte challenge hex values supplied through an
  access-controlled operator environment, not from the pair file.

The pair JSON has EXACTLY this shape:

~~~json
{
  "format": "oge-vault-signed-device-acceptance-pair",
  "version": 1,
  "runId": "<exact independently verified M67 run UUID>",
  "origin": "https://vault-staging.example.test",
  "observations": {
    "device-a": "<the complete ORIGINAL redacted M82 JSON object for A>",
    "device-b": "<the complete ORIGINAL redacted M82 JSON object for B>"
  }
}
~~~

Replace angle-bracketed example strings with real values; the
observations are nested JSON objects, **NOT strings**. The only
permitted observation fields are the exact M82 read-only response
keys. All positive read flags must still be true, and **ALL** M82
safety/false-signoff flags must remain false. Unknown fields, false
read proof, fabricated true production readiness, swapped device
labels, identical responses, duplicate raw challenges or wrong M82
nonce fingerprints reject before any readiness report is issued.

This tool does not copy a user-selected session marker from M82
because M82 exposes no authenticated device/session marker. The M67
self-reported device-a and device-b session markers are checked for
inequality; the M82 observations **cannot independently be bound to
those markers**. An independent operator must review actual
source/browser/network records to establish genuine device identity.

## Offline command

~~~sh
npm run vault:staging:review-signed-device-pair
~~~

**Default OFF.** To opt in, supply all of the following from a
protected operator environment and private evidence files (never
commit credentials, raw challenges, cookies or Notes to the repo):

~~~text
OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_REVIEW=YES_OFFLINE_TWO_SIGNED_DEVICE_OBSERVATIONS_AND_MATRIX_ONLY
OGE_VAULT_TWO_DEVICE_EVIDENCE_HASH_REVIEW=YES_PRIVATE_REDACTED_ARTIFACTS_READ_ONLY
OGE_STAGING_URL=https://vault-staging.example.test
MONGODB_DB=oge_vault_restore_staging_<disposable>
OGE_VAULT_TWO_DEVICE_EVIDENCE_FILE=<absolute owner-private M67 JSON path>
OGE_VAULT_TWO_DEVICE_ARTIFACT_DIRECTORY=<separate private M68 artifacts folder>
OGE_VAULT_SIGNED_ACCEPTANCE_PAIR_FILE=<absolute owner-private pair JSON path>
OGE_VAULT_SIGNED_ACCEPTANCE_EXPECTED_RUN_ID=<independently obtained M67 run UUID>
OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_A_CHALLENGE_HEX=<original random A 64-hex>
OGE_VAULT_SIGNED_ACCEPTANCE_DEVICE_B_CHALLENGE_HEX=<different original B 64-hex>
~~~

All destructive, cutover and standalone restore COMMIT/write ACK flags
must be OFF. The wrapper requires isolated staging origin and DB
markers, an exact M67 run ID and different 64-lowercase-hex nonces.
It securely reads the pair JSON with O_NOFOLLOW from a private
directory, checks owner and file modes, a single link, bounded size,
and inode/size/mtime/ctime stability. M68 verifies the 12 actual
private artifact bytes using the exact same manifest object that is
passed to M83. A replaced or mixed-run manifest fails closed.

Exit codes **never return success 0**:

- **2 — HOLD / READY FOR EXTERNAL REVIEW:** both M82 reports and
  operator-provisioned nonce fingerprints match; all 12 M67
  scenarios appear with reported-pass and matching M68 file bytes.
  Status:
  PAIRED_OBSERVATIONS_AND_HASHED_MATRIX_READY_FOR_MANUAL_REVIEW_HOLD
- **3 — HOLD / INCOMPLETE:** pair and local artifacts match, but some
  M67 cases are missing or reported failed, or two distinct M67
  session markers are not recorded.
  Status:
  PAIRED_OBSERVATIONS_BUT_INCOMPLETE_MATRIX_HOLD
- **1 — BLOCKED / HOLD:** invalid, forged, inconsistent, copied,
  unsafe or cross-run private evidence, changed file hashes,
  missing owner-private paths, unsafe staging or missing opt-in.

Output is redacted: only scenario counts/IDs for missing/failed
tests, booleans and a hold status, no Git hashes, original challenges,
challenge fingerprints, M67 run UUID, user/owner/session IDs,
OAuth tokens, private file paths or evidence bytes.

## Exactly what is and is not established

An indexed result says: two externally provided M82 browser reports
match two **independently provided local operator challenge values**,
and the *same* M67 manifest reported 12 scenario outcomes for
which every corresponding M68 local file digest was verified.

It **DOES NOT independently prove**:
- That the device labels correspond to two different physical devices.
- That the two M82 sessions are linked to the distinct M67 session markers.
- That either M82 JSON actually originated from the genuine staging
  server; reports are unsigned and could be fabricated.
- That the upstream OAuth issuer, user presence or actual physical
  browser sessions were independently authenticated.
- That a PASS observation is truthful or the captured source of each
  redacted local file is trustworthy.
- That the M67 GitHub 403/429/409/422 and lost-write scenarios were
  genuinely executed against a live provider.
- That any outstanding GitHub PATCH has settled or application
  workers are quiescent.
- That complete staging acceptance is approved, production is safe,
  a Vault import lock can be released or a failed write retried.

The response always includes:
physicalDeviceIdentityIndependentlyVerified:false,
twoAuthenticatedPhysicalDevicesIndependentlyVerified:false,
twoM82ObservationsLinkedToM67SessionMarkersByProvider:false,
actualGitHubOAuthIssuerIndependentlyVerified:false,
evidenceTruthIndependentlyVerified:false,
realProviderFaultMatrixIndependentlyVerified:false,
completeStagingAcceptanceSignedOff:false,
canEnableProduction:false,
canAuthorizeRestore:false,
canReleaseImportLock:false and canRetryUnknownWrite:false.

## Real acceptance and operator responsibilities still pending

Using actual isolated, disposable staging resources, independent
operators must sign into real GitHub OAuth on two separate physical
devices, establish independent browser/network evidence provenance,
verify private GitHub App installation and permissions, test
multi-device draft/Autosave + GitHub conflicts, and separately
authorize disposable failure injection for 403 revocation, 429
limits, 409/422 CAS, and lost GitHub PATCH acknowledgments. They
must verify that all suspected writers and outstanding provider
requests have stopped, preserve encrypted drafts and record
independent security acceptance. NONE of these live events can be
performed by the M83 offline evidence checker.

The existing #47 prewrite-only lock release remains unchanged and
still rejects github-write-possible quarantine. M75 create-only
restore writers/M76 approvals/M77–81 inspectors and production
settings remain unchanged. No deployment or merge was performed.

## Regression

~~~sh
node --test tests/oge-vault-two-device-acceptance-readiness.test.js
npm run lint
npm test
npm run build
~~~

Tests cover successful pair indexing with real synthetic M82 report
shapes and all 12 M67/M68 raw files, missing/failed scenarios,
swapped/duplicate device claims, changed independent challenges,
false signoff, mixed run ID/origin, changed disk artifact, private
file permission/symlink and default-OFF CLI with HOLD exits.

## E16 / Milestone #84 — Operator-executed real staging read-only probe

Added a separately default-OFF runnable
`npm run vault:staging:run-signed-read-drill` command that uses TWO
distinct **owner-private, operator-acquired** Playwright Auth.js staging
session storage-state files in independent HTTPS APIRequestContext
clients. Strict staging URL/DB/no-write flags, private single-link
file permissions, no localStorage, exact secure HttpOnly same-origin
session cookies and distinct session cookie fingerprints are required.
Each session sends one fresh generated nonce to existing M82 read-only
owner/private GitHub App endpoint. No automatic login, redirect, retry,
Note content or Git/Mongo writes. The script saves an exclusive
M83-compatible private pair and a separately protected random
challenge file. **Even a successful real read returns exit 2 = HOLD.**
This milestone implemented and synthetically tested the harness:
**NO real OAuth session state, physical two-device execution or actual
provider fault scenario was available to or run by CI.** Two different
cookies are NOT proof of different human users or physical devices.
See `docs/OGE_VAULT_LIVE_SIGNED_STAGING_READ_DRILL_E16.md`.
