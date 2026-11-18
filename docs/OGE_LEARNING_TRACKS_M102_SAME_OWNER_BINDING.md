# Milestone #102 — F6 Staging-only authenticated same-owner Vault binding

**State: code-level safety check implemented, external staging execution NOT performed.**
Release, restoration and merge remain on HOLD. This is NOT OAuth issuer or
physical-device attestation and is not a substitute for a human security review.

## Gap addressed

M101 independently observes two different signed session cookies viewing the same
Track, video and committed Note. That does not prove two sessions originated from
the same active owner account and private Vault installation. M102 brackets the
existing M101 observations with an additional server-derived HMAC commitment
to the account identity, current signed JWT generation and connected private Vault
mapping. It compares only opaque HMAC values in a protected operator process.
**No raw owner, repo, Note IDs, cookie, GitHub token or HMAC output is persisted
in the final redacted report.**

## Server-side opt-in

- On an intentionally isolated HTTPS **staging/preview** hostname with a disposable
  private GitHub App-backed Vault and isolated `oge_vault_restore_staging_*` DB,
  enable the existing M99 and M101 protected preview flags. Set exact M101
  run/track/video identifiers and acknowledgments for the single authorized drill.
- Independently set `OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW=true` **on
  the staging server**, and provide a randomly generated 32-byte hex
  `OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY` in its secret manager. Never
  expose it to the browser (`NEXT_PUBLIC_*`), operator test files, Git, CI
  logs, chat, or reports. Keep it separate from GitHub App/Note draft keys.
- The new fixed authenticated endpoint is
  `GET /api/learning-tracks/acceptance/owner-binding?run=<UUID>`.
  It requires exact same-origin `Origin`, the selected private run ID, a
  currently signed Auth.js account whose persisted session-version matches,
  connected Vault metadata, and a fail-closed distributed 8/owner/hour rate limit.
  It returns only `status`, a 64-character HMAC commitment and
  `releaseAuthorized:false`, with `private, no-store` cache headers.
  The HMAC is bound to the run ID, isolated origin, owner, session version,
  GitHub account/repo and installation mapping. There is no GitHub write,
  Note content read, or permission escalation in this endpoint.

## Operator read-only drill

With two different operator-protected 0600 signed session-state files already
captured, use the existing `npm run vault:staging:m101-learning-track-readonly`
command, additionally setting in the **operator shell**:
- `OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW=true`
- `OGE_LEARNING_TRACK_M102_OPERATOR_ACK=YES_COMPARE_EXISTING_DISPOSABLE_SESSIONS_READ_ONLY`

**Do not put the HMAC key in the operator shell.** The runner performs two
initial binding GETs (session A then B), all eight existing M101 Track/link/
GitHub-read verification GETs, and two final binding GETs (A then B). The four
opaque tags MUST match; any request failure, inactive session, changed Vault
mapping, missing linked Note, 429/redirect, unsafe staging origin, malformed
payload, forged release flag, or unexpected result blocks the entire drill.
No automatic retries or link mutations occur. Each run consumes four of the
8/owner/hour HMAC-check allowance and two of the 8/owner/hour GitHub-linked
Note verification allowance.

- Exit **1**: BLOCKED / inconclusive. No release success, no raw data logs.
- Exit **2**: same account/session-generation/Vault mapping was observed by
  the trusted staging app at four check points, **HOLD for external review**.
- Exit **0**: never produced as an approval.

The HMAC is an authenticated *server assertion*, not independent proof that the
staging server is uncompromised, two distinct human-operated devices were used,
a Google/GitHub OAuth issuer actually issued the sessions, or that a provider
failure scenario occurred. M101's and M102's reads are not one atomic snapshot;
changes can happen just after the final GET.

## Mandatory outstanding human acceptance

Follow `docs/OGE_LEARNING_TRACKS_STAGING_ACCEPTANCE_F4.md` (A–L) and
`docs/OGE_LEARNING_TRACKS_M101_TWO_SESSION_READONLY.md`, using actual
disposable provider identities and two independently documented physical
devices. Independently review redacted provider/issuer/failure observations,
session provenance, owner scoping, concurrent link mutations, account
revocation, GitHub 403/429/5xx, Note deletion, and playlist membership changes.
Do not invent PASS outcomes or mark real acceptance complete from synthetic CI.

**Production readiness: BLOCKED.** No restoration, merge, deployment,
quarantine unlock, or automatic GitHub retry is authorized.
