# Oge Vault Milestone #101 — F5 Two-Session Learning Tracks Live READ Drill

**Status:** Operator-only drill code, default OFF. The implementation alone supplies NO
genuine OAuth, GitHub App, YouTube, independent security, or physical-device acceptance.
Every result is **HOLD** even if both authenticated reads succeed.

## What this drill actually checks

With two *already captured* signed Auth.js storage states for one disposable staging
owner, it performs exactly eight bounded HTTPS GET requests and nothing else:

1. GET `/api/learning-tracks` from session A and B; both must see the chosen track,
   with linking enabled.
2. GET the chosen track's `/api/learning-tracks/note-links` from A and B. Both
   must see the **same exact selected video-to-committed-Note ID association**.
3. GET the owner-clicked M100 read-only `mode=verify` endpoint once from A,
   then B. Both must report the Note `present` at check time.
4. Repeat link reads from A and B; the Note ID must be unchanged.

The verification endpoint obtains the private owner-scoped GitHub App
`contents:read` token on the server and consumes 2 of the 8/owner/hour
verification budget. The tester does not handle GitHub tokens or Note bodies.
The saved link may change immediately afterward. Distinct cookie fingerprints
do **not** prove distinct real devices, issuer events, or actual cross-device
write conflicts.

## Required isolated staging preconditions

- Operator has **explicitly authorized** the run with disposable staging
  Auth.js owner accounts, signed sessions, a private disposable GitHub Vault,
  an existing disposable Note, a manually linked playlist video, and isolated
  `oge_vault_restore_staging_*` MongoDB.
- Protected HTTPS staging, exact `OGE_STAGING_URL = AUTH_URL =
  OGE_VAULT_BASE_URL` origin and full independently default-OFF M99 linking
  preflight are configured, including valid server-only GitHub App OAuth keys.
- Keep ALL destructive/delete, cutover, restore/import commit or approval,
  quarantine unlock, automatic retry and production controls disabled.
- Capture two different Playwright storage-state JSON files via authorized
  operator login on **separately documented real devices where available**.
  Keep each owner-only 0600 regular file in its own operator-owned 0700
  directory. All cookies must be secure, HttpOnly and restricted to the exact
  staging hostname; local origins in the state are refused.
- Fresh run ID, existing track ID and linked video ID must be explicitly
  supplied. The run does not discover or pick an arbitrary user/resource.
- Use the variables shown in `.env.example`, then invoke
  `npm run vault:staging:m101-learning-track-readonly` in a protected local
  staging operator shell. Never paste real keys or session state into a ticket,
  chat, CI repository, or log.

Optional `OGE_LEARNING_TRACK_M101_PRIVATE_REPORT_FILE` names a NEW absolute
file in a protected 0700 directory; the runner creates it owner-only 0600,
without following symlinks or overwriting files. It includes only redacted
counts, categorical flags and a run-binding SHA-256 digest, **not credentials,
Note IDs, track IDs, URLs, contents, Git SHAs or raw provider responses**.
The run binding is operator-declared, not an independent attestation.

## Failure and exit semantics

- **Exit 1 — BLOCKED:** preflight fails; sessions are reused, malformed or
  inconsistent; a redirect/401/403/409/429/5xx or unexpected response occurs;
  Note missing, current link changed, or headers/response size are unsafe.
  Raw provider bodies, paths, tokens and IDs are never printed. No retries.
- **Exit 2 — OBSERVATION RECORDED, HOLD:** all eight READ responses match at
  inspection time. This is NOT OAuth issuer proof, provider-fault acceptance,
  two distinct physical devices proof, concurrent-write conflict proof,
  independent audit, restore permission or deployment authority.
- **Exit 0 — NEVER issued** as an acceptance or release approval.

A rate-limited 429 is a legitimate BLOCKED result, not evidence of a bug.
Do not run the drill repeatedly to bypass rate limits; verification limit is
8 per owner per hour, while other scopes have their own limits.

## What the operator must still validate outside this runner

Follow `docs/OGE_LEARNING_TRACKS_STAGING_ACCEPTANCE_F4.md` scenarios A–L,
including on-device **explicit mutations of disposable links only** (if
authorized), real Note deletion from a disposable Vault, account/session
revocation, playlist changes, real provider failure evidence, two physical
devices and distinct provider-issued OAuth login observations. An independent
reviewer must inspect redacted evidence and audit its provenance before any
release decision. This code intentionally does not initiate or automatically
approve any of those operations.

**Release gate:** HOLD. PR #35 stays draft; no production, restore,
quarantine release, imported Note mutation, automatic retry, or merge.
