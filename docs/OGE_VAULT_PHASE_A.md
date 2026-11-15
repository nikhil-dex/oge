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

## Current caveats and planned milestones

**Important:** The provision-and-initialize process spans several GitHub API calls and is not atomic. A failure after repo creation can leave a user-owned private repo while Oge is still unconnected. The app fails closed and never deletes or overwrites it. Phase B must add resumable reconciliation for partially created repositories.

- [x] Implement distinct GitHub App configuration, signed owner/session-scoped OAuth state, and initial provisioning primitives.
- [x] Add Account Profile entry and retro setup screen, with explicit no-migration notice.
- [x] Add owner/privacy verification and server-side storage of the provisioned mapping.
- [ ] Validate with a disposable personal GitHub account and installed App permissions. Local mocks/CI cannot verify live GitHub permission behavior.
- [ ] Provide a **selected-repositories** setup that doesn't require all-repository installation, before general availability.
- [ ] Add safe resumable provisioning/reconnect and handle existing name conflicts, deleted repos, moved/renamed repos, revoked installation and GitHub rate-limit/outage handling.
- [ ] Complete dedicated end-to-end tests against a private staging deployment, and review GitHub rate limits and installation/API costs.
- [ ] Phase B: immutable note IDs and validated GitHub file paths, server-side commit queue, read-after-write verification, pending/retry/conflict statuses and rate-limit-aware batch writes.
- [ ] Phase C: per-user, fully verified MongoDB note migration and rollback, while retaining the source records until authorized deletion.
- [ ] Phase D: opt-in account migration first, then enable the **mandatory GitHub-backed Notes** gate only after the persistence/recovery and cross-account isolation checks pass.
- [ ] Phase E: Quick Notes, AirNotes, revision integration, Learning Tracks topic notes, sharing permissions and extension behavior.

**This feature must not change how existing users sign in, authenticate, read notes or save drafts until migration and recovery are safe.**
