# Oge Vault — Milestone #59: Signed staging restore bridge

**Status:** code and synthetic/disposable-Mongo acceptance only. **NOT real authenticated GitHub staging signoff or production authorization.** PR #35 remains draft; all preview flags remain off outside isolated staging. Never use production user notes or the production database.

## Design and trust boundaries

The M58 internal executor can safely write one create-only batch of 1–12 Notes from an authenticated, reachable same-owner GitHub backup. M59 bridges the signed Auth.js browser owner and a local private-file operator process **without uploading plaintext backup chunks through HTTP**:

1. The signed owner explicitly approves the previously reviewed M57 1–12-note fingerprint and source/target HEAD through a separately default-off staging HTTPS route.
2. The route issues a **10-minute HMAC-SHA256 receipt** tied to exact owner, signed session incarnation, private GitHub repo/installation, selected IDs, source snapshot/inventory, destination HEAD, and M57 fingerprint. The receipt contains no titles, bodies, chunk text or GitHub tokens.
3. A separate operator command verifies the HMAC and local 0700/0600 private chunk/ticket files before connecting to a **shared isolated staging MongoDB database**. That database MUST be exactly the same for the Auth.js browser and the operator.
4. MongoDB atomically transitions the metadata-only receipt from **pending** to **claimed** before the operator obtains a GitHub write token. A consumed ticket is **never automatically retryable**. The existing M58 executor then rechecks authenticated source Git blobs and conflicts behind owner/subject locks before exactly one Git CAS write.
5. After verified success the record is marked **confirmed**. A lost/ambiguous response remains claimed and may retain the durable owner import quarantine. No automatic next batch, replay or unlock.

The **vault_restore_approvals** MongoDB collection stores only signed owner/repo/session metadata, SHA-256 nonce and approval fingerprints, timestamps, state and an optional confirmed Git commit SHA. Its unique _id is the nonce hash; a seven-day-after-expiry TTL index bounds ordinary record retention. Expiry is enforced independently on each claim.

## Staging prerequisites (never enable in production)

Use a protected HTTPS hostname containing staging or preview, exact matching AUTH_URL, OGE_STAGING_URL and OGE_VAULT_BASE_URL, dedicated OAuth and GitHub App credentials, a private synthetic connected repository and a **secure Atlas/replica-set** database named **oge_vault_restore_staging_***. The normal Vault staging preflight must pass. Manually verify external GitHub App installation scope, deployment access restrictions and synthetic-account isolation; configuration checks cannot prove them.

The browser route and the operator process must use the same isolated MONGODB_URI, MONGODB_DB and a **separate unpredictable 32-byte hexadecimal OGE_VAULT_CHUNK_RESTORE_APPROVAL_KEY** (e.g. generated locally with openssl rand -hex 32). Never expose secrets through NEXT_PUBLIC_ variables, GitHub issues, CI logs or chat.

Existing Vault main, hybrid draft, Notes API and import plan/commit preview flags plus M58 OGE_VAULT_CHUNK_RESTORE_COMMIT_PREVIEW=true and OGE_VAULT_CHUNK_RESTORE_WRITE_ACK=YES_DISPOSABLE_SIGNED_STAGING_ONLY are still required in staging. The new default-off browser flag is **OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW=true**.

## Step 1 — Prepare and review

Securely download all chunk parts for one same-owner GitHub snapshot; source verification supports up to 1,024 current Notes / 16 private parts and 20 newer linear Git commits. Store in an operator-owned directory with 0700 permissions, each contiguous part-0001.json ... file as owner-only 0600. Run the M57 read-only batch intent planner and independently review the create/existing/draft conflicts, exact destination HEAD and selectionFingerprint. **A positive preview is not authorization to commit.**

## Step 2 — The signed owner approves exactly one batch

The authenticated staging browser sends a same-origin JSON POST to:

**/api/vault/backup-import/chunk/authorize**

~~~json
{
  "confirmation": "COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY",
  "expectedSourceSnapshot": "<40 lowercase hex Git commit>",
  "expectedSourceInventorySha256": "<64 lowercase hex checksum>",
  "expectedTargetHead": "<40 lowercase hex current HEAD>",
  "selectedIds": ["<one to twelve distinct lowercase note UUIDs>"],
  "expectedSelectionFingerprint": "<64 lowercase hex M57 fingerprint>"
}
~~~

Only the same-origin signed Auth.js session can authorize a receipt; the route checks owner mutation throttle, read-only private GitHub installation and the unchanged destination HEAD. It never reads/upload chunks or invokes GitHub writes. It returns **ticket**, **receiptId**, expiry and **immediatelyExecutesRestore:false**.

Save the returned ticket privately to a **separate 0600 regular JSON file**, outside the chunks directory:

~~~json
{ "ticket": "<exact signed issued ticket>" }
~~~

Keep the receipt file private; it is short-lived authorization material.

## Step 3 — Separate operator command for one batch only

The local operator sets the exact signed ownerId, sessionVersion, repoId and GitHub App installationId; all normal staging credentials; the same **secure staging DB** and receipt key; plus these separate opt-ins:

~~~sh
# Staging-only variable examples, NOT an executable production setup:
# OGE_VAULT_CHUNK_RESTORE_STAGING_OPERATOR=YES_ONE_SIGNED_BATCH_ONLY
# OGE_VAULT_CHUNK_RESTORE_STAGING_ACK=YES_SEPARATE_SYNTHETIC_STAGING_DATABASE
# OGE_VAULT_CHUNK_RESTORE_TICKET_FILE=/absolute/private/signed-ticket.json
# OGE_VAULT_CHUNK_PLAN_DIRECTORY=/absolute/private/oge-notes-chunks
# OGE_VAULT_INSPECT_OWNER_ID=<exact signed account ID>
# OGE_VAULT_INSPECT_SESSION_VERSION=<signed session incarnation>
# OGE_VAULT_INSPECT_REPO_ID=<private GitHub repo ID>
# OGE_VAULT_INSPECT_INSTALLATION_ID=<GitHub App installation ID>
npm run vault:chunk:restore-staging
~~~

The executable refuses localhost, production/default MongoDB names, insecure DB URIs, a bad staging origin, mismatched session/repo/installation, missing HMAC, expired or replayed receipt, non-owned/unsafe file permissions and missing pages. The server-side signed approval is atomically **claimed once** before the GitHub contents:write token is acquired. M58 then re-verifies source note bodies, current Git HEAD, owner, subjects and encrypted drafts and performs one non-force Git ref CAS.

A verified success prints only redacted batch counts. An unknown outcome prints no credentials or note contents and leaves the receipt claimed; a potentially started GitHub write retains the owner quarantine. No automatic retry or lock release.

## Step 4 — Read-only owner status

As the same signed staging account:

**GET /api/vault/backup-import/chunk/status?receiptId=the-receiptId**

The owner-scoped route returns one of:

- **PENDING_APPROVAL_CLAIM** — not yet consumed; unusable after expiry.
- **CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED** — claimed, in progress, or uncertain. This is **not proof of a failed or successful GitHub write**. Do not retry.
- **GITHUB_BATCH_CONFIRMED** — GitHub write was verified, and the receipt confirmation was stored.

Every status explicitly says no automatic retry, no lock release, no automatic next batch. A second batch requires a new signed browser approval and a new reviewed fingerprint at the NEW current target HEAD.

## Remaining release blockers

M59 automated synthetic Git and real disposable MongoDB tests are NOT real signed two-device provider staging; no actual independent staging session has been signed off. The signed route issues one-time approval receipts but no finished owner-facing UI for managing private backup downloads. Automatic multi-batch progress/resumption, verified operator quiescence and dual approval for uncertain lock repair, recovery after source repository loss, Quick Notes, AirNotes, extension integration, privacy review and production cutover remain incomplete.

**Do not merge PR #35 or enable production restore flags.**
