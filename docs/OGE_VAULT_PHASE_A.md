# Oge Vault — Phase A: GitHub App provisioning foundation

**Status: draft / private staging only. Not production ready.** Connecting a vault currently creates a new private GitHub repository and records verified repository/install metadata, **but does not sync or migrate any note content**. Notes, Subjects, Quick Notes, AirNotes, history, revision, backup, and the Chrome extension currently still use MongoDB-backed data paths. This is a temporary legacy state, **not the accepted storage architecture**.

## Non-negotiable GitHub-only notes architecture

After migration and before Oge Vault ships, every student's **GitHub private vault is mandatory** for accessing note workspaces. It must be the **sole persistent source of note content** for subject notes, Notes, Quick Notes, AirNotes, revisions and version history, future Learning Tracks topic notes, extension-created notes, and imported/restored note content. There is **no optional MongoDB note-storage mode**, no MongoDB mirror, and no fallback to MongoDB during GitHub outages.

MongoDB remains for identity/session and linked providers; user and GitHub installation/repository mappings; subject and note opaque IDs and path references; friendships, collaboration and sharing permissions; learning progress and study/review schedules; operational sync states and non-content indexes. Avoid note titles in database metadata, filenames, events, logs, queues, or analytics. Git history remains in the private repo, but a private GitHub repository does not guarantee end-to-end encryption.

A save may be acknowledged as GitHub-persisted **only after confirmed remote write**. For connection loss, local unsaved drafts can be temporarily held on the user's device with clear pending/error states, but **no note content can be written into MongoDB, including a retry queue or backup copy**. On reconnect, retry safely with conflict detection and version checks. Private note content must never leak into log entries, metrics, or MongoDB error records.

For accounts with legacy MongoDB note content, preserve source data through a **controlled, owner-scoped and resumable migration**. Verify content, versions and counts in GitHub before switching that user to GitHub-only access. Remove historical MongoDB note bodies, snapshots, old backup formats and other residual content only after explicit policy review and verified recovery; do not destroy data mid-migration. The change is complete only after all note-related API/extension/import/revision paths and backup/export operations are tested to ensure they persist **zero note text, headings, or revision bodies** to MongoDB.

**Release gate:** Mandatory vault access must not be activated until GitHub note reads/writes, recovery, migration and no-MongoDB-content checks are complete. The Phase A connection form is not a functional note editor and cannot be described as enforcing the final architecture.

## Intended student flow

1. Sign in to OgeNotes through Google, GitHub, or an already enabled OgeNotes password.
2. Open **Profile → Oge Vault**.
3. Install OgeNotes' dedicated GitHub App on your **personal** GitHub account (distinct from the GitHub OAuth App used to sign in).
4. Approve the dedicated GitHub App OAuth callback using the **Connect GitHub & create private vault** button.
5. Oge validates the signed OgeNotes session, one-time OAuth state, token identity and the matching user installation, creates a brand-new private `ogenotes-vault` repository, creates a scoped temporary installation token, verifies repository privacy and owner, and initializes `.ogenotes/vault.json`.
6. Oge stores only validated owner/login, repository ID/name, installation ID and a provisioned status in the user row. It does **not** store the short-lived GitHub OAuth access token or installation token.

If `ogenotes-vault` already exists, Oge intentionally refuses to adopt, overwrite, or delete it; that requires a separately reviewed reconnect/adoption flow.

## GitHub App configuration

Create a **GitHub App**, not a classic OAuth App or personal access token:

- Web application flow enabled and callback `https://YOUR_OGE_HOST/api/vault/callback` (for local dev: `http://localhost:3000/api/vault/callback`).
- Installation target **Any account**, subject to individual user's installation approval; this first phase supports **personal** accounts, not organizations.
- Repository permissions: **Contents: Read and write**, **Metadata: Read**, **Repository creation: Read and write**. GitHub may require additional installation capabilities to approve these permissions; confirm with a disposable staging account before public access.
- App installation: **All repositories** is currently required because newly created repos are not automatically added to an existing selected-repositories installation. Even though Oge's minted installation tokens are restricted to `ogenotes-vault`, the App's installed permissions are broader. **This is a privacy/least-privilege release blocker; obtain explicit approval or implement a safe selected-repository install/update flow before a general rollout.**
- Optional install link is derived from `OGE_VAULT_GITHUB_APP_SLUG`, a validated slug, not user input.

Set all of the following server-only secrets in uncommitted `.env.local` or the deployment secret manager:

```env
OGE_VAULT_BASE_URL=http://localhost:3000/
OGE_VAULT_GITHUB_CLIENT_ID=your_app_client_id
OGE_VAULT_GITHUB_CLIENT_SECRET=your_app_client_secret
OGE_VAULT_GITHUB_APP_ID=your_numeric_app_id
OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64=base64_encoded_private_pem
OGE_VAULT_GITHUB_APP_SLUG=your_app_slug
```

The callback origin is explicitly configured and cannot be constructed from untrusted Host headers. Use separate GitHub Apps and databases for staging vs. production. An installation and OAuth code exchange must both work before the private repository can be created. Protect the private key and rotate compromised credentials.

## Data model and safety

MongoDB `users.vault`: `status`, `githubAccountId`, `githubLogin`, `repoId`, `repoName`, `installationId`, `connectedAt`, `contentMigration='not-started'`. No private notes are stored or copied here.

MongoDB `vaultOauthIntents`: SHA-256 hash of a one-time random state token, the authenticated Oge owner and signed session version, and a ten-minute expiration. Exact-state cookie is HttpOnly, SameSite Lax, and Secure on production. All OAuth callbacks consume the state exactly once.

Account ownership uses the stable authenticated Oge owner ID, not supplied GitHub email or repository names. A GitHub-identified Oge account cannot link to a different GitHub account's repository. Existing Google-owned OgeNotes accounts can authorize their own GitHub account after verifying OAuth. Verified emails **never** automatically merge note ownership.

The server refuses a repo that isn't private or isn't owned by the approved GitHub identity. The marker is written only after receiving a scoped installation token for that exact repository ID.

## Phase B1 — GitHub-only Notes storage prototype (implemented, feature-flagged)

The new server-only `lib/oge-vault-notes.js` and `/api/vault/notes` provide a **separate test-only Notes CRUD path** for already connected user-owned private repositories. They do not read from or write to the existing MongoDB `notes` collection. The API is **disabled by default**; enabling `OGE_VAULT_NOTE_API_PREVIEW=true` is for disposable private staging users only.

- `GET /api/vault/notes` lists up to 100 GitHub-stored notes; `GET /api/vault/notes?id=UUID` fetches one.
- `POST /api/vault/notes` creates an opaque UUID-named `notes/{uuid}.json` file under the user's GitHub vault. The `subjectId` must refer to an existing, owner-scoped subject ID in MongoDB; no note content is stored in that database.
- `PUT /api/vault/notes` requires `id`, previous GitHub blob `sha`, heading, answer and tags. Stale edits return a conflict instead of overwriting the new version.
- `DELETE /api/vault/notes?id=UUID&sha=BLOB_SHA` rejects stale deletes and verifies removal from the current branch. Git history retains old content.
- Each operation validates the signed Auth.js user session and vault repository mapping, mints a short-lived **repository-ID-restricted** installation token, and verifies the GitHub repo remains private and owned by the linked account.
- New and updated note files are read back after the GitHub API write to verify content and SHA before acknowledging persistence. Note filenames use opaque IDs, not headings.
- No note text, heading, revision history or queued payload is written into MongoDB by this prototype. MongoDB is used only to validate the account and subject reference and enforce operation rate limits.

**Prototype limitations / release blockers:** Preview currently performs one commit per note mutation and list reads many files from GitHub. It is not yet a durable debounce/batch sync queue and has a temporary 100-note listing cap. No resilient offline autosave, multi-device reconciliation, per-note restore, revision/history migration, subject deletion propagation, bulk import, extension integration, reconnect, or safe legacy migration exists yet. The main `/api/notes` and other note APIs **still use MongoDB**, so do not activate the mandatory vault gate or claim cutover.

**Test requirement:** Unit tests cover the GitHub file contract, normal create/read/update/delete flows, SHA conflicts, invalid payloads, malformed repository content, and unconfirmed writes. Live end-to-end GitHub App tests and multi-account isolation tests are still mandatory.

## Phase B2 — Atomic multi-note synchronization prototype

`lib/oge-vault-batch.js` and the separately flagged `POST /api/vault/batch` endpoint accept **1–12 creates/updates/deletes** in a single Git commit. They read the current Git tree and each existing note's blob SHA, validate opaque IDs and note content, build one tree, create a commit and attempt a non-forced fast-forward of the branch reference. Updates/deletions reject stale SHAs; concurrent branch commits fail rather than overwriting unseen work. The server reads back every changed note and the final branch head before claiming GitHub persistence.

The batch API uses a signed Oge account, verified private repository mapping and server-side installation token. Subject references are validated from owner-scoped MongoDB metadata; **no note bodies, titles, revisions, or retry payloads are stored in MongoDB**. It uses the same staging-only `OGE_VAULT_NOTE_API_PREVIEW=true` feature flag as the initial CRUD preview.

**Still not production sync:** there is no device-side debounce queue, resilient offline draft persistence, retry-with-read reconciliation after ambiguous network errors, multi-device conflict resolution UX, large-repo pagination, or completed Quick Notes/AirNotes integration. This prototype performs a single bounded atomic Git commit, not a complete autosave system. Git history retains deleted content.

## Phase B3 — Browser autosave and recovery preview

The experimental `/vault/preview` page is now visible to an authenticated owner with a provisioned vault only when `OGE_VAULT_NOTE_API_PREVIEW=true`. It is intentionally **separate from `/notes`** and does not change existing note storage, extension APIs or import paths.

- The editor lists notes from the private GitHub repository and writes through the existing feature-flagged `/api/vault/batch` endpoint, not through MongoDB. Subject names and opaque subject IDs remain ordinary MongoDB metadata.
- Changes are debounced for approximately one second; incomplete notes are retained locally rather than sent as invalid GitHub content. Each confirmed save updates the last-known blob SHA.
- Before a GitHub write is confirmed, a recoverable **same-tab sessionStorage draft** holds the content with an account/repository/note-scoped key and a 24-hour maximum age. The active-note UUID is also retained so a not-yet-created note can be recovered after tab reload. The page requires explicit review/retry after recovering a draft.
- On network failures or unknown write status, the coordinator reads the GitHub note first. If GitHub already contains exactly the attempted content, the save is considered confirmed; otherwise it retries with exponential backoff (up to five automatic retries) or shows a conflict. It never silently overwrites a newer remote blob SHA.
- Conflicts preserve the unsynced draft. The UI offers an explicit option to discard a local draft in favor of an existing GitHub version, with a confirmation before unsynced drafts are discarded. A remotely deleted note is treated as a conflict, not silently recreated.
- The UI shows pending, saving, synced, offline, recovered, retrying, conflict and unconfirmed states. It never claims an offline draft is saved to GitHub.
- Session storage is **not an encrypted or durable backup** and can be evicted/cleared by browser or device settings. This preview is not a guarantee against power loss, clearing site data, or tab closure. It is unsuitable for high-value production notes until the offline storage/security approach is reviewed.

**Outstanding B3/B4 gates:** Cross-device conflict merge UX, multi-note timed queue flushes, service outage handling, long-term offline guarantees, 429 rate-limit headers, GitHub App selected-repository scope, replay/idempotency across full page navigation, live OAuth App/staging tests, and removal/replacement of every legacy note-content endpoint. The preview remains optional and disabled by default; mandatory vault enforcement is not yet activated.

## Phase B4 — Familiar Notes UI, GitHub-only compatibility preview

`/vault/notes` now reuses the existing Notes interface through configurable `notesApi="/api/vault/notes-main"`. Both the UI and its separate Notes API adapter require `OGE_VAULT_MAIN_PREVIEW=true`, and the page additionally verifies the signed-in user's connected vault metadata. **The original `/notes` remains on its previous endpoint**; this is an isolated, staging-only route.

- Read, create, edit, delete, and favorite changes in the familiar Notes interface are served by GitHub files. The adapter verifies subject ownership in MongoDB metadata, but stores **no headings, bodies, or revision content in MongoDB**.
- Existing note versions are carried in the response as GitHub blob SHA. Mutating an existing note **requires** its expected SHA; stale changes fail with a conflict rather than overwriting another device's edits.
- A GitHub note is mapped to the familiar `subjectSlug`/note object shape so the existing list, editor, favorite, search, reader, markdown and print UX can be reused. Gemini cleanup through the old Mongo-backed note route is hidden/disabled in this preview.
- The GitHub adapter uses the Phase B2 tree/commit transaction to verify GitHub writes. It does not have a write-to-MongoDB fallback. Existing subject names and opaque IDs still live in MongoDB, as permitted metadata.
- **This B4 view uses an explicit Save action**. The B3 auto-save system remains a separate preview on `/vault/preview`; combining both experiences and draft-conflict warnings is a subsequent step.

**Safety / release blockers:** The classic subject deletion API can still delete MongoDB subject metadata without deleting corresponding GitHub files, so subject deletion must be redesigned before switching production Notes. GitHub listing is capped; the classic Notes editor's current attachment/backup/revision and external extension integrations are not wired to Vault yet. The other MongoDB note-content endpoints still exist, and the production Notes workspace has **not** cut over. Real GitHub App staging and per-user isolation verification are still required.

## Revised rollout — no legacy user-data migration

The project owner confirms that existing MongoDB note records are **disposable app-test fixtures**, not student data requiring preservation. Therefore the prior **copy-and-verify MongoDB-to-GitHub user-content migration milestone is removed from the active launch sequence**. We must not infer this from the database automatically or silently delete unverified records.

A **read-only inventory command** is available: `npm run vault:inventory`. It prints counts of legacy `notes`, `quickNotes`, and `personalQuickNotes` only (never note text). A nonzero count exits with code 2 and blocks cutover until an operator reviews the records. Zero counts are necessary, not sufficient: backup snapshots, revision collections, and every application write path still need audit. The command **does not delete anything**.

Before cutover, a staging/preproduction checklist must:
1. Confirm the intended environment and inventory existing `notes`, `quickNotes`, `personalQuickNotes`, embedded note revisions/history and content-bearing backup/export material.
2. Verify with the operator that these are disposable test fixtures; export or retain any unexpectedly valuable data outside the new permanent design.
3. Explicitly clean up disposable records and note-content backups with a reviewed retention and deletion procedure; check that content-bearing MongoDB collections no longer contain student notes.
4. Convert every production content path to GitHub-only reads/writes (including classic Notes, Quick Notes, AirNotes, extension, revision/history, backup/import) and gate access on an authorized working Vault.
5. Run automated and real staging tests to prove there is **no post-cutover note-content write to MongoDB**, even on failures, retries or disconnected GitHub.
6. Only then activate the mandatory Vault connection gate. Do not gate the app while the old MongoDB-backed API is still the only functional notes editor.

## Current caveats and planned milestones

**Important:** The provision-and-initialize process spans several GitHub API calls and is not atomic. A failure after repo creation can leave a user-owned private repo while Oge is still unconnected. The app fails closed and never deletes or overwrites it. Phase B must add resumable reconciliation for partially created repositories.

- [x] Implement distinct GitHub App configuration, signed owner/session-scoped OAuth state, and initial provisioning primitives.
- [x] Add Account Profile entry and retro setup screen, with explicit no-migration notice.
- [x] Add owner/privacy verification and server-side storage of the provisioned mapping.
- [ ] Validate with a disposable personal GitHub account and installed App permissions. Local mocks/CI cannot verify live GitHub permission behavior.
- [ ] Provide a **selected-repositories** setup that doesn't require all-repository installation, before general availability.
- [ ] Add safe resumable provisioning/reconnect and handle existing name conflicts, deleted repos, moved/renamed repos, revoked installation and GitHub rate-limit/outage handling.
- [ ] Complete dedicated end-to-end tests against a private staging deployment, and review GitHub rate limits and installation/API costs.
- [x] Phase B2 prototype: one bounded atomic Git commit for up to 12 note changes, SHA conflict checks, branch fast-forward validation and read-after-write verification.
- [ ] Phase B production: client-side debounce, recoverable offline drafts, ambiguity-aware retries, conflict UX, pagination and batch-aware rate limits.
- [ ] Phase C: operator-confirmed **disposable test data cleanup**, followed by GitHub-only cutover verification across every content path. No user-content migration is expected for this project; stop if non-test content is discovered.
- [ ] Phase D: opt-in account migration first, then enable the **mandatory GitHub-backed Notes** gate only after the persistence/recovery and cross-account isolation checks pass.
- [ ] Phase E: Quick Notes, AirNotes, revision integration, Learning Tracks topic notes, sharing permissions and extension behavior.

**This feature must not change how existing users sign in, authenticate, read notes or save drafts until migration and recovery are safe.**
