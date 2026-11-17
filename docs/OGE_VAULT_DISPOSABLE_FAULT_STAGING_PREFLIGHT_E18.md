# Oge Vault — E18 / Milestone #86: disposable GitHub fault-staging read-only verification

**Status:** Implemented a default-OFF **operator-runnable real GitHub App
READ-ONLY preflight** plus mocked regression tests. **Not run against an
actual GitHub App or staging repository by this milestone.** No restore,
fault injection, ref PATCH, GitHub Notes writes, MongoDB writes, quarantine
release or production flag change was performed.

## The problem this solves

M85 verified twelve fault cases using the real HTTP request and import
fence functions with in-memory fakes. M86 checks whether an operator has
provisioned a deliberately empty, **disposable private repository** and
a matching staging owner, account, installation and Git HEAD, before
any independently approved real failure drill could be considered.

M86 cannot authenticate a human merely because a private JSON file
contains two approval SHA-256 strings. These are *declared correlation
digests*, **not signed authorizations**. M86 cannot prove the user has
no real data outside the inspected Git tree, exclude future GitHub
writes, guarantee worker quiescence, run live OAuth or authorize
fault injection. All successful outcomes remain **HOLD**.

## Two distinct sources: operator plan and GitHub sentinel

The operator first provisions a **dedicated disposable** GitHub account
and app installation with the standard private `ogenotes-vault`
repository name. Do NOT point the test at any real account, existing
personal vault, production database, main Oge repo or user Notes. The
operator must *separately* verify real provider identity and ownership.

An authorized separate operator creates the following metadata-only
file **manually** on the disposable GitHub test repo before this
read-only command is run:

`/.ogenotes/fault-test-sentinel.json`

Example with dummy IDs, a SHA and a UUID:

```json
{
  "format": "oge-vault-disposable-fault-sentinel",
  "version": 1,
  "origin": "https://vault-staging.example.test",
  "runId": "8fca11a5-e2ad-4d4f-9948-6b16ac28ff11",
  "repoId": 8001,
  "installationId": 9002,
  "githubAccountId": "100003",
  "branch": "main",
  "baseHead": "1111111111111111111111111111111111111111",
  "expiresAt": "2026-11-18T10:00:00.000Z",
  "confirmation": "DISPOSABLE_PRIVATE_GITHUB_VAULT_NO_REAL_USER_NOTES"
}
```

The sentinel's `baseHead` MUST name the existing, independently
observed **parent Git commit BEFORE the sentinel is added**. An
authorized operator then adds this metadata-only sentinel in a
**single-parent Git commit** in the disposable repository.
The resulting commit will have a DIFFERENT `expectedHead` SHA.
After that commit, the operator obtains its actual SHA from an
independent provider read and uses that value **only in the
separately protected local operator plan and environment**.

M86 checks the resulting commit has exactly one parent equal to
the sentinel's independently provided `baseHead`. It does not try
to embed a commit's own SHA inside its contents. This is a feasible
staging workflow, but the sentinel is still only an operator claim,
not external identity verification, and the preflight has not yet
been executed against a real provider by this milestone.

The allowlist intentionally requires no regular Note content:
- `.ogenotes/vault.json`
- `.ogenotes/fault-test-sentinel.json`
- optional `README.md` or `.gitignore`
- the `.ogenotes` directory

Anything else (including `notes/*`, `quick-notes/*`,
`airnotes/*`, links, another subdirectory, or an additional file)
fails closed. Both GitHub clients must be independently scoped
`contents:read` App installation clients for the exact same owner;
repo must be private, active, have the exact numeric repo ID, owner
account ID and default branch. HEAD, tree and sentinel blob must
remain stable during the check.

## Operator plan, independent scope and CLI

The separately protected local operator JSON plan must have exactly:

```json
{
  "format": "oge-vault-disposable-fault-staging-plan",
  "version": 1,
  "origin": "https://vault-staging.example.test",
  "runId": "8fca11a5-e2ad-4d4f-9948-6b16ac28ff11",
  "repoId": 8001,
  "installationId": 9002,
  "githubAccountId": "100003",
  "branch": "main",
  "baseHead": "1111111111111111111111111111111111111111",
  "expectedHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expiresAt": "2026-11-18T10:00:00.000Z",
  "operatorReviewSha256": "<64 lowercase hex of independent private review>",
  "independentReviewSha256": "<different 64 lowercase hex review>",
  "confirmation": "INSPECT_DISPOSABLE_FAULT_STAGING_NO_WRITES_OR_UNLOCK"
}
```

Review SHA fields are not human signatures or proof the reviews
actually occurred. The operator must determine the origin, run UUID,
numeric repository, installation, GitHub account, branch and expected
HEAD **independently of this JSON** and supply matching expected values
through a protected private environment.

```sh
npm run vault:staging:inspect-disposable-fault-repo
```

Default OFF. Only run after independent staging approval:

```text
OGE_VAULT_DISPOSABLE_FAULT_PREFLIGHT=YES_SIGNED_OWNER_DISPOSABLE_PRIVATE_GITHUB_GETS_ONLY
OGE_STAGING_URL=AUTH_URL=OGE_VAULT_BASE_URL=https://vault-staging.example.test
MONGODB_DB=oge_vault_restore_staging_<disposable>
OGE_VAULT_FAULT_PREFLIGHT_PLAN_FILE=<owner-only absolute private JSON file>
OGE_VAULT_FAULT_PREFLIGHT_RUN_ID=<independently known run UUID>
OGE_VAULT_FAULT_PREFLIGHT_OWNER_ID=<isolated staging account ID>
OGE_VAULT_FAULT_PREFLIGHT_SESSION_VERSION=<staging session UUID>
OGE_VAULT_FAULT_PREFLIGHT_REPO_ID=<independently verified repo numeric ID>
OGE_VAULT_FAULT_PREFLIGHT_INSTALLATION_ID=<independently verified App install ID>
OGE_VAULT_FAULT_PREFLIGHT_GITHUB_ACCOUNT_ID=<independent account ID>
OGE_VAULT_FAULT_PREFLIGHT_BRANCH=<staging default branch>
OGE_VAULT_FAULT_PREFLIGHT_BASE_HEAD=<parent Git SHA before sentinel>
OGE_VAULT_FAULT_PREFLIGHT_HEAD=<independently observed HEAD after sentinel>
```

Requires all existing `checkVaultStagingReadiness` credentials and
protected isolated MongoDB replica-set configuration. All restore
COMMIT/write ACK, cutover/deletion flags remain OFF. Never commit the
private plan, credentials or actual owner/session IDs into Git, a
shared CI job or a public issue.

Input file must be a 0600 owner-only regular non-symlink single-link
private JSON file in a 0700 owner-only directory, with unchanged
size, inode, mtime and ctime and no more than 4096 bytes.

The script reads a MongoDB **projected owner metadata row** using
the independently pinned account scope and majority read. It mints
two separate repository-scoped GitHub App `contents:read` installation
tokens, verifying repository metadata, owner stability, immutable
Git HEAD/tree and tiny sentinel blob with GET requests. Token issuance
uses GitHub's installation-token POST endpoint, but **no GitHub
repository resource writes** are performed. No Note blobs/drafts are
read. It returns only redacted booleans, no owner IDs, Git SHAs or
credentials, and never authorizes a ref write.

Exit **2 = READ-ONLY HOLD**, if all exact checks pass. Exit **1 =
BLOCKED**, if scope/credentials/permissions/repo/plan/sentinel or
private path is unsafe. No exit 0. The pre-sentinel parent SHA and
post-sentinel HEAD are both independently pinned; a positive result
still cannot authorize a real fault-test write.

## Tests

```sh
node --test tests/oge-vault-disposable-fault-staging-preflight.test.js
npm run lint
npm test
npm run build
```

Regression tests use synthetic GitHub read-only clients, private
metadata and a mock sentinel. They reject a public or archived
repository, repo/installation drift, changed HEAD, revoked owner,
unexpected Notes, symlinks, malformed tree, forged sentinel,
incorrect independently expected run scope, bad review digests,
expired/overlong plan, reuse of one GitHub client and write-scoped
client attempts. **No actual provider read was performed by these
automated tests.**

## Hard release blockers

Before any live write/fault test, independently verify the actual
isolated provider repo, authorize only disposable data, run live M82–84
OAuth on two physical devices, establish app-worker quiescence, and
obtain separate explicit operator approval for each real 403/429/409/422/
lost-ACK test. Independent review of any resulting write-possible
lock remains mandatory. M86 adds no recovery/unlock mechanism.

PR #35 remains DRAFT/UNMERGED, no deploy or production flags enabled.
