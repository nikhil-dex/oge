# Oge Vault B7 — private staging acceptance checklist

**Status: pending human-operated, authenticated staging verification.**
This checklist is not evidence that the checks have passed. The existing CI
Chromium jobs use synthetic anonymous sessions; they cannot prove real
Google/GitHub OAuth, signed account ownership, or live private GitHub writes.

## Safe test boundary

- Use **disposable staging users**, a fresh dedicated private GitHub repository
  belonging to the test user, and a separate MongoDB staging database.
- Never run destructive drills on real users' notes, existing vaults, personal
  GitHub repositories, or production MongoDB collections.
- Never copy, print, attach, or commit GitHub installation tokens, OAuth secrets,
  draft encryption keys, cookies, private keys, private note text, or recordings
  that expose them.
- Leave `OGE_VAULT_MAIN_PREVIEW` and
  `OGE_VAULT_HYBRID_DRAFT_PREVIEW` disabled in production.
- Require an operator's explicit staging authorization. No CI job should
  implicitly turn these flags on or install the GitHub App for a user.
- **Do not merge PR #35** until the remaining security, deletion, provider
  permissions, and release gates have been reviewed and approved.

## Evidence matrix (all pending)

| Scenario | Required observation |
| --- | --- |
| Google-signed owner and linked GitHub-signed identity | Both explicitly linked sign-ins resolve the same intended owner-scoped vault; a second unrelated account cannot read its notes |
| Existing linked-password session | Works for the same account without another GitHub OAuth prompt; unlinked users never inherit a vault by matching email |
| New note Save | One confirmed GitHub commit, same note UUID, correct subject; MongoDB contains no committed title or body |
| Save API response lost after GitHub commit | UI rechecks GitHub and shows Saved only after exact blob/revision confirmation; no duplicate commit |
| Cleanup API response lost after MongoDB commit | GitHub-matched metadata receipt allows one idempotent cleanup replay; no second GitHub note commit |
| GitHub 429 / secondary rate limit | A 429 is surfaced; draft remains pending; no retry loop or blind write replay |
| GitHub offline during Save | Browser and encrypted server draft recovery stay available; no false Saved state |
| Multi-device revision race | A later encrypted draft wins over older revision-CAS cleanup; both devices receive a conflict/recovery path |
| Concurrent GitHub edit on same note | Expected-SHA conflict prevents silent overwrite; preserve the losing device's draft |
| Subject deletion lock during Save | Save and cleanup cannot bypass subject fences; release remains blocked until the cross-store deletion design is approved |
| Page reload, tab close, return online | Pending draft state recovers without inventing GitHub confirmation or dropping newer text |
| Desktop and mobile authenticated browsers | Same results, including zero plaintext note writes to MongoDB and precise pending/Saved labels |
| Account deletion with connected Vault | Fails closed, leaving GitHub mapping and encrypted draft records recoverable |
| Large private test vault | Bounded GitHub calls and metadata-only indexing with explicitly recorded 429/incomplete-tree behavior; no partial index published |

## How to record each staging run

For every row above, capture only: operator initials, UTC date, environment
identifier, synthetic test account alias, scenario name, pass/fail, issue or PR
link, commit SHA and CI run. Store no access tokens or private notes in logs.
Test profiles and repositories should be disposable; only their synthetic
metadata should appear in evidence.

**Completion criterion:** every required row passes on isolated staging,
without exposing secrets, losing drafts, silently changing ownership, writing
committed note bodies to MongoDB, or altering production data. Any failure
returns B7 to an unapproved state and blocks cutover.

## Existing automatic evidence vs missing evidence

- Existing CI covers lint/unit/build, disposable MongoDB replica-set tests,
  anonymous desktop/mobile Chromium smoke, and Git-history secret scanning.
- Synthetic GitHub transport tests cover bounded GET recovery, rate-limit
  classification, and no automatic retries for write acknowledgments.
- **Not yet verified:** true signed GitHub App access in staging, live provider
  outages, authenticated desktop/mobile recovery flows and two-device races.
- This file is a planned acceptance matrix, not a completed staging report.
