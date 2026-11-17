# Oge Vault M100 — F4 Learning Tracks / linked Note staging acceptance

**Status: code-level mock coverage implemented; real provider and two-device acceptance NOT EXECUTED.**
Release state remains HOLD. This document does not authorize user data writes, restoration,
automatic GitHub retries, quarantine unlock, merge, or production deployment.

## Scope

- The owner explicitly links an existing private committed Note to a YouTube video ID.
- A separate owner-clicked **Verify linked Note** requests one read-only GitHub check.
- A check returns only `present` or `missing` at that moment, not Note contents.
- Unknown provider failures show an error; they are not proof of deletion.
- No automatic retries, polling, auto-linking, Note mutations, or MongoDB content copies.
- Existing status is advisory: GitHub Note and YouTube membership can change immediately afterward.

## Preflight (authorized operator, disposable staging only)

1. Confirm all #99 isolated protected staging requirements and the independently
   disabled `OGE_LEARNING_TRACK_NOTE_LINK_PREVIEW` gate before opt-in.
2. Use only disposable account(s), a disposable PRIVATE GitHub App-backed Vault,
   an isolated `oge_vault_restore_staging_*` database, and a public test playlist.
3. Verify protected HTTPS staging origin, exact Auth.js and Vault session binding,
   GitHub App `contents:read` installation scope, rate-limit storage, and audit boundaries.
4. Keep production cutover, destructive deletion, restoration/import, quarantine release,
   automatic GitHub retry and deployment flags disabled. Do not force provider faults
   against production accounts or real Notes.

## Operator acceptance scenarios

| ID | Action | Expected result |
| --- | --- | --- |
| A | On device A, link disposable committed Note to one playlist video | One metadata-only link; no GitHub write |
| B | On device A, explicitly check that link | `present` only at check time; no body/title in HTTP response |
| C | On device B, unlink; on A, verify previously shown link | 409 conflict; refresh links to see updated state |
| D | On device B, unlink and relink the same video to another owned Note | A stale verification may return 409; no mistaken successful change claim |
| E | In disposable Vault only, delete the linked committed Note via existing authorized Notes workflow; verify link on A | `missing` at check time; link stays until owner explicitly unlinks |
| F | Revoke device A session; attempt verify/link/unlink | 401 or safely rejected request; no authorized link mutation |
| G | Remove GitHub App scope or simulate an unavailable provider in a controlled disposable environment | Error/HOLD, never report missing solely from provider setup failure |
| H | Encounter real GitHub 403/429/5xx without harmful fault injection | Error/HOLD, no automatic retry or metadata mutation |
| I | Update playlist so a previously linked video is no longer in a freshly discovered public snapshot | UI warns; no automatic unlink or playlist rewrite |
| J | Two devices try to link the same video simultaneously | At most one owner/track/video link; loser gets 409 and refreshes |
| K | Owner's track deleted while a check is in progress | Stale result must not be portrayed as a current valid link |
| L | Trigger ninth check within an hour for the same owner | Fail-closed 429 limit; no extra GitHub check |

Inspect MongoDB `learningTrackNoteLinks` for ID-only metadata, without exporting Note
contents. Check HTTP bodies for absence of Note headings, bodies, tokens, secrets,
installation details and private GitHub repository paths. Keep captured evidence redacted.

## Limits and evidence

- Current check budget: **8/owner/hour**, per-link, on demand. Existing Note picker
  budget: 12/owner/hour; playlist discovery: 5/owner/hour.
- A 404 from a READ of the exact linked Note after a valid GitHub client is created
  means **not found at check time**. Failure to construct the owner-scoped client
  (even a provider 404) is **unknown/error**, not "missing".
- A subsequent session/version check and link-record re-read narrow obvious races
  but cannot make MongoDB plus GitHub a distributed atomic snapshot. Changes after
  the final check remain possible.
- A link is not authenticated proof of playlist membership or continuing Note existence.
- Unit/mock CI only checks failure handling logic and source guards. To close the gate,
  the operator must collect independently reviewed, redacted evidence from genuine
  physical devices, real OAuth issuance, real GitHub App reads and provider faults,
  including actual HTTP codes, results, timestamps, environment and account isolation.
- Never mark an unexecuted case PASS; record each as PASS / FAIL / BLOCKED with
  redacted, independently reviewable evidence. No source credentials or private Notes
  belong in tickets or CI logs.

## Exit decision

**HOLD by default.** Only an authorized human operator and independent security
reviewer can accept the real staging matrix. M100's code-level tests are not
an OAuth, GitHub provider, physical-device or production release attestation.
