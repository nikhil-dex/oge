# Oge Vault — E19 / Milestone #87: owner-facing Recovery Center and staging acceptance handoff

**Status:** Implemented a new signed-owner informational **staging-only** 
Recovery Center under \`/vault/recovery\`, plus operator handoff matrix.
It does not download content on render, sign anything, restore notes,
release a lock, retry a GitHub write or attest to production readiness.
**No real OAuth, two-device or disposable GitHub fault test was performed
by this milestone. PR #35 stays DRAFT/UNMERGED.**

## Owner-facing Recovery Center

Two components:

- \`lib/oge-vault-recovery-center.js\` uses the actual
  \`VAULT_RESOURCE_BACKUP_COVERAGE\` exported by the backend to generate
  a fixed content-free capability model. A config flag says only
  whether a signed user can **REQUEST** the existing staging backup
  endpoint; it is not a checked/downloaded/verified archive.
- \`app/vault/recovery/page.js\` and scoped CSS show a familiar
  retro-themed signed-in owner-only page. Linked from \`/vault\`
  ONLY when the page is enabled. No Note body, draft, GitHub token,
  owner ID or Git SHA is passed to the client. Signed Auth.js session
  incarnation and exact connected private vault are looked up using
  projected owner metadata. Outside isolated staging this route is
  404, including when not connected.

Default-OFF staging flag:

\`\`\`text
OGE_VAULT_RECOVERY_CENTER_PREVIEW=false
\`\`\`

The page only becomes visible with this flag explicitly \`true\` and
existing \`OGE_VAULT_MAIN_PREVIEW=true\`,
\`OGE_VAULT_NOTE_API_PREVIEW=true\`,
\`OGE_VAULT_HYBRID_DRAFT_PREVIEW=true\`, exact **HTTPS**
\`OGE_STAGING_URL=AUTH_URL=OGE_VAULT_BASE_URL\`, a staging/preview
hostname, isolated \`MONGODB_DB=oge_vault_restore_staging_*\`, and a
passing existing \`checkVaultStagingReadiness\` verification. All
standalone restore COMMIT/write ACK, backup import COMMIT, cutover,
account deletion, Vault destructive delete and subject-retire flags
MUST remain OFF. This stricter gate is for **an informational
read-only page** and is not an operator authorization.

The page shows three resource types with the exact existing snapshot
coverage: current **committed GitHub HEAD** versions of **Notes,
Quick Notes and AirNotes**. It makes exclusions prominent:
**historical revisions, uncommitted encrypted drafts, legacy
MongoDB Notes and Learning Tracks progress**. The download is
potentially PLAINTEXT private Note data; only display the
existing \`GET /api/vault/backup-current-resources\` link when
**all three** independent snapshot flags
\`OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW=true\`,
\`OGE_VAULT_BACKUP_EXPORT_PREVIEW=true\` and
\`OGE_VAULT_STANDALONE_PREVIEW=true\` are present. The endpoint
continues to enforce its own authenticated owner, read-only
GitHub and resource validation. No prefetch, upload or restore form.

**NEVER suggest this current-resource snapshot is full account
recovery.** An encrypted local copy and independent verification of
a downloaded archive are the operator/user's responsibility.

## Staging acceptance handoff (read-only preparation vs real proof)

The following is the required handoff for an authorized
nonproduction operator. Only metadata should enter issue trackers;
store sensitive captures and session states in a restricted
separate location, not Git/PR/CI/chat.

| Concern | Existing runnable command or route | What it proves; what remains |
|---|---|---|
| Dedicated OAuth/App/Mongo config | \`npm run vault:staging:preflight\` | Local configuration shape only; does NOT prove provider identity |
| Signed read-only private GitHub App owner/repo | \`npm run vault:staging:provider-probe\` | Real owner and GitHub HEAD/tree **reads**, when actually run; no multi-device OAuth signoff |
| Two authenticated staging session reads | \`npm run vault:staging:run-signed-read-drill\` | Two preauthenticated storage-state requests; no physical-device provenance |
| Read-only case inventory | \`npm run vault:staging:two-device-evidence\` | 12 declared scenarios and two separate claimed session markers, not their truth |
| Private redacted artifact hashes | \`npm run vault:staging:verify-evidence-files\` | Local SHA-256 bytes, not authenticated capture origin |
| Strict browser pair + all scenario hashes | \`npm run vault:staging:review-signed-device-pair\` | Indexed **HOLD** for manual review, never automatic OAuth/fault signoff |
| Real disposable GitHub repository suitability | \`npm run vault:staging:inspect-disposable-fault-repo\` | Configured read-only repo metadata/sentinel/allowlisted tree, when actually run; no permission to write |
| 12 synthetic failure scenarios | \`npm run vault:staging:synthetic-provider-fault-matrix\` | In-memory 403/429/409/422/lost-ACK **rehearsal**, NOT real provider |
| Uncertain incident/quarantine review | M77/M78 read-only endpoints, M79–M81 offline evidence tools | Signature and local evidence correlation; NOT old worker quiescence, unlock or retry |
| Owner's current GitHub resource backup | \`/vault/recovery\` informational staging page | Exact declared coverage; no full backup, restore, draft recovery or history |

### Stop conditions

Stop and capture redacted evidence without retrying/continuing on
**any** repo ID/install/account mismatch, unexpectedly public/archived
repository, Notes/Quick Notes/AirNotes or other unapproved contents
inside the purported disposable Git tree, unexpected new Git HEAD,
invalid/changed sentinel or plan, revoked Auth.js session,
untrusted OAuth issuer, unexpected 401/403/429/409/422, write or
readback uncertainty, delayed provider PATCH acknowledgment,
unsynced draft, concurrent writer, unverified live fault scenario,
missing private evidence, changed SHA or signed review, or
unapproved real-user data access. A write-possible owner lock
remains locked; there is **NO approved post-write release**.

### What must happen outside this branch before live acceptance

1. An authorized operator creates distinct **physical browser
   devices** and independently vetted nonproduction OAuth identities,
   a clean isolated GitHub App installation and private disposable
   \`ogenotes-vault\` repository. Ensure there is **NO actual user
   Note content** and record provider ownership and key custody
   outside the repo. Do not paste session cookies or API tokens
   into issues or chats.
2. Inspect the read-only GitHub repo with M86 after committing the
   sentinel under a separate pinned prior parent HEAD. Compare the
   current private tree, owner/app installation and staging origin
   against independent operator channels. **This still does not
   authorize mutating the repository.**
3. Run authenticated M82–84 reads from separately observed real
   browser devices. Independently validate actual OAuth issuer,
   session origin and physical device ownership, plus offline
   M67/M68/M83 evidence. A synthetic CI green result does not
   satisfy this requirement.
4. Only after **separate documented approval for disposable writes**,
   establish bounded real test cases for 403/429, stale 409/422,
   lost ACK, two-device autosave conflicts and encrypted draft
   retention. Record observed private Git state and cancel tests
   immediately on ambiguity. M87 **does not provide an automatic
   fault-write launcher**.
5. Independently demonstrate that no old GitHub requests or worker
   tasks can finish after recovery, verify immutable snapshot and
   source provenance, and subject any proposed postwrite-lock
   recovery transaction to dedicated independent security review.
   Do not use M47 prewrite-only recovery for a postwrite lock.
6. Address owner-facing real import/restore UX, **complete account
   backup/history/drafts**, extension and Learning Tracks GitHub-only
   cutover, production security and deploy/rollback acceptance.
   These are still **UNFINISHED**.

## Regression

\`\`\`sh
node --test tests/oge-vault-recovery-center.test.js
npm run lint
npm test
npm run build
\`\`\`

Tests cover strict isolated staging origin, read-only flags, exact
backend three-resource coverage, excluded history/drafts/legacy/
Learning Tracks, independent disabled-download behavior, signed
owner session and current repo DB projection, static no-write
page and responsive stylesheet. **No real private Vault data is
used in this test.**

### Milestone boundary

M87 creates **one practical owner-facing recovery coverage screen**
and consolidates the existing operator test matrix. It **does not**
enable restoration, download automatically, establish real
OAuth/device/provider acceptance, mutate a Git branch or permit
quarantine release. Production flags remain OFF, no merge/deploy,
and PR #35 stays DRAFT.

## E20 / Milestone #88 — Browser-only local backup checksum inspection

The existing default-OFF signed-owner `/vault/recovery` page now
offers a user-selected private local JSON file picker. It verifies
the exact M73 inventory SHA-256 and outer archive SHA-256 using
browser WebCrypto, strict canonical record types and 8MiB size cap.
No file is uploaded, no Note text/ID is returned in status, and no
backup is fetched automatically; only bounded current counts for
committed Notes, Quick Notes and AirNotes are displayed. Even a
success is **LOCAL HASH AGREEMENT ONLY**: a forged archive can
recompute its own SHA-256 values. No source identity/authentication,
GitHub SHA/owner proof, complete account backup, encrypted drafts,
historical revisions, Learning Tracks progress, restore/import
grant or release of `github-write-possible` quarantine is implied.
The page and local picker are still hidden outside owner-authenticated
isolated staging. Real signed two-physical-device OAuth and provider
fault acceptance remain unperformed. See
`docs/OGE_VAULT_LOCAL_CURRENT_RESOURCE_BACKUP_CHECK_E20.md`.
