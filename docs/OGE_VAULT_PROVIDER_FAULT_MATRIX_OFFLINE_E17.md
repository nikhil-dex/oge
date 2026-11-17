# Oge Vault — E17 / Milestone #85: deterministic provider fault-matrix rehearsal

**Status:** Implemented and independently default-OFF. **This is an OFFLINE
IN-MEMORY rehearsal, not actual GitHub App staging failure injection.**
It exercises the actual production `vaultGithubRequest` REST adapter
and `withVaultOwnerImportExclusive` / `withVaultOwnerDraftWrite` owner
fences with injected local JavaScript-only transports and simulated account
state. Nothing in this milestone makes a real GitHub/MongoDB request,
uses real OAuth or GitHub App credentials, updates a repository, modifies
user Notes, enables production, or authorizes releasing a quarantine.

## Why test the underlying boundary?

A GitHub `PATCH /git/refs/heads/main` with `force:false` can produce
403 permission denied, a 403 secondary rate limit, a 429, a 409 or 422
conflict, a 503, or a network error. Crucially, a PATCH can have actually
**updated the remote ref** before its acknowledgment is lost. A 2xx PATCH
acknowledgment can also be followed by an unavailable readback.

Because the destination head update may have happened, the owner-wide
MongoDB import lock must be DURABLY marked
`github-write-possible` **before** first GitHub mutation. A write
that might have started **must never be retried blindly**, and unknown
results **must never release** the owner import lock. A read-only
HEAD verification may retry a transient provider error without
repeating the writer PATCH.

The M85 test invokes these exact real production adapter/fence
functions, but replaces every network and DB IO operation with closed
in-process simulation fixtures. It checks the result and fence
invariants of every scenario and fails if a dangerous behavior occurs.

## Operator command

```sh
npm run vault:staging:synthetic-provider-fault-matrix
```

Default OFF, explicit opt-in ONLY in a disposable *local* operator test
environment (these values are guards, not real connection settings):

```text
OGE_VAULT_OFFLINE_PROVIDER_FAULT_MATRIX=YES_TWELVE_SYNTHETIC_NO_NETWORK_SCENARIOS_ONLY
MONGODB_DB=oge_vault_restore_staging_faultmatrix
OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW=false
OGE_VAULT_CUTOVER_GUARD_PREVIEW=false
OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL=false
OGE_ACCOUNT_DELETION_ENABLED=false
OGE_VAULT_ACCOUNT_DELETION_INTERNAL=false
```

Do **NOT** pass GitHub tokens or production MongoDB credentials to this
command. The code does not consume them. No staging URL, network
server, browser session or GitHub App installation is required.

The process returns **exit 2**, not 0, when all 12 synthetic assertions
pass. This means **synthetic rehearsal passed, live provider acceptance
still HOLD**. A missing opt-in or failed invariant exits 1, **BLOCKED**.
The output is a metadata-only, sanitized scenario report, not an
operator release ticket.

## Twelve actual code-path scenarios

| Scenario | Injected local response | Expected durable behavior |
|---|---|---|
| Prewrite owner rejection | No GitHub call | Safe prewrite fence released, zero PATCH |
| Permission denied | HTTP 403 | One PATCH attempt; quarantine |
| Rate limited | HTTP 429 | One PATCH attempt; quarantine |
| Secondary rate limit | HTTP 403 + provider rate-limit header | One PATCH attempt; quarantine |
| Ref conflict | HTTP 409 | One PATCH attempt; quarantine |
| Stale ref conflict | HTTP 422 | One PATCH attempt; quarantine |
| Provider unavailable | HTTP 503 | One PATCH attempt; quarantine |
| Network disconnected | Simulated fetcher exception | One PATCH attempt; quarantine |
| **GitHub ref changed, acknowledgment lost** | Mutate *only in-memory* Git HEAD then throw | One PATCH attempt; **quarantine even though fake GitHub changed** |
| PATCH confirmed, GET readback unavailable | Simulated success then GET 503 twice | One PATCH; quarantine |
| PATCH and HEAD verification succeed | Simulated 200 + confirmed HEAD | Synthetic success, release only local in-memory fence |
| PATCH success, transient GET error | Simulated 200, GET 503 then GET 200 | One PATCH; read retry allowed; synthetic verified local fence release |

For all write-attempt cases, the test verifies the exact approved
content-free marker, expected immutable target HEAD and selected UUID
were recorded first. Any uncertain result requires lock state
`github-write-possible`, and follow-up encrypted draft writes and
a new import must be rejected by the **real import-fence functions**.
No second PATCH is permitted. No imported archive or private Note
text is used or stored; inputs are synthetic metadata.

The two successful tests release **only the simulated memory lock**
after a synthetic confirmed readback. They are not examples of a
release path for an existing real `github-write-possible` quarantine,
and do not authorize operators to clear one.

## Why this is NOT real provider acceptance

This test is **not** evidence that GitHub actually responds with
the simulated codes for the exact authorized Vault App setup or
that the application will behave correctly over real network
connections, actual timed-out requests, installation revocation,
GitHub App permissions, concurrent live user sessions or race
conditions. The simulated response-lost-after-write event cannot
prove that all real in-flight GitHub calls have stopped.

The operator must still separately authorize **disposable test-only
data and a dedicated isolated private GitHub staging repository** for
real provider tests. Real tests must check 403 revocation, 429 and
secondary quotas, 409/422 non-force ref conflict, interrupted ACK,
head/tree/blob verification, encrypted draft retention and cross-device
autosave fencing. Tests must ensure no real user content or repo is
changed and demonstrate externally that all old writers are quiescent.

The M85 report explicitly retains:
`real403429409422ScenariosExecuted:false`,
`realOAuthOrAppRevocationTested:false`,
`actualLostGitHubAcknowledgmentInduced:false`,
`independentlyEstablishedWorkerQuiescence:false`,
`signedTwoPhysicalDeviceAcceptanceComplete:false`,
`safeToRetryAutomatically:false`,
`operatorUnlockAuthorized:false`,
`automaticUnlockAuthorized:false`,
`productionReady:false`,
`canEnableProduction:false`,
`canReleaseImportLock:false`, and
`externalWritesPerformed:false`.

No real postwrite lock-release or automatic retry was added. PR #35
remains DRAFT/UNMERGED, staging and production write flags OFF.

## Regression and CI

```sh
node --test tests/oge-vault-provider-fault-matrix-offline.test.js
npm run lint
npm test
npm run build
```

Tests assert all twelve scenarios, marker-before-PATCH ordering,
exactly one write attempt (zero for prewrite-only refusal), no automatic
retry, retained owner quarantine on unknown outcome, blocked drafts and
repeated imports while quarantined, GET-only retry semantics, CLI
default-OFF/HOLD=2, redacted output and no real GitHub/MongoDB clients.

**Next priority:** actual operator-controlled nonproduction GitHub
App/ OAuth acceptance on physical devices and controlled, explicitly
approved disposable-data failure tests. Synthetic green CI cannot
substitute for that real-world validation.

## E18 / Milestone #86 — Disposable private staging repo READ-only preflight

New independently default-OFF operator CLI
`npm run vault:staging:inspect-disposable-fault-repo` requires
owner-private explicit fault-test plan, independent run/owner/repo/
installation and pre-sentinel parent/post-sentinel HEAD pins,
isolated HTTPS staging origin and Mongo replica, existing B7
preflight and read-only GitHub App identity. Two separately scoped
`contents:read` App clients GET private repo metadata, stable
branch/commit/tree and a tiny disposable sentinel blob. The sentinel
contains only metadata including the **parent baseHead**; the
independent operator plan pins the **new commit expectedHead** to
avoid self-referential Git commit hashes. The complete Git tree
must contain only the Vault marker, disposable sentinel and
optional README/.gitignore — no real Note/Quick Note/AirNote files,
symlinks, unexpected directories, public or archived repo. No
Git ref writes, user Notes or Mongo mutations. **Exit 2 is still
HOLD and grants NO fault-injection permission**; CLI has NOT been
run on a real staging repository by CI. See
`docs/OGE_VAULT_DISPOSABLE_FAULT_STAGING_PREFLIGHT_E18.md`.
