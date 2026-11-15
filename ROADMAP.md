# OgeNotes — Product and Engineering Roadmap

> Purpose: keep implementation aligned with the agreed product goal. This roadmap is the source of truth for scope, migration order, security gates, and launch readiness.

## 1. Product goal

Build a production-ready, multi-user personal knowledge and study app by selectively reusing proven code from `ogenotes`, preserving its existing visual design, and adapting the backend for secure user accounts. Do not rewrite the application from scratch.

### Non-negotiable project boundaries

- All new work happens in `oge`.
- `ogenotes` is a read-only reference for code and design; do not change its code, settings, or deployment.
- Inspect existing code before porting it; reuse components and utilities where appropriate, and refactor only when necessary for security or maintainability.
- No PDF, image, attachment, or other file-storage feature in the initial release.
- No Google Drive integration and no user-supplied MongoDB connection strings.
- Do not launch publicly until security, privacy, testing, and operational release gates are met.

## 2. Agreed dashboard scope

The home dashboard should match the visual style and interaction patterns of `ogenotes` and provide access to:

1. Notes
2. AirNotes
3. Quick Notes
4. Saved Links
5. Browser Extension
6. Revision History
7. Dictionary
8. News
9. Revision

Clarification to preserve: Revision History is for viewing past revision/activity records; Revision is the study/review workspace. If repository inspection shows the existing feature semantics differ, document the discrepancy before changing the scope.

### Registration and news personalization

- Users authenticate with Google.
- During onboarding, users may select their news interests.
- Interest selection is optional; skipping it gives the user a general news feed.
- Users can edit or clear their interests later in settings.
- Store interests against the authenticated user and use them only for news personalization.
- Choose a news source/API only after checking availability, licensing, attribution requirements, rate limits, and cost.

## 3. Agreed architecture

### Authentication

- Use Google sign-in; use Google's stable OIDC `sub` claim as the external identity key, not email as the permanent identifier.
- Validate OAuth state, nonce, issuer, audience, callback URL, and token expiry.
- Use secure server-managed sessions and appropriately configured HTTP-only, Secure, SameSite cookies.
- Implement logout/session invalidation and safe account lifecycle behavior.

### Data storage

- Use one project-managed MongoDB Atlas deployment/database for application data across users.
- The database belongs to the project operator; users do not provide database URIs.
- Keep the MongoDB connection string and all privileged credentials in server-only environment secrets or the hosting secret manager.
- Store every user's notes and other personal records with an owner identifier derived from the authenticated server session.
- Enforce ownership on every read, update, delete, search, export, and background operation. Never trust a user ID supplied by the browser as authorization.
- Do not store uploaded files or implement a file-storage provider in the initial release.

### Hosting and external services

- Confirm the hosting provider and deployment topology before finalizing OAuth callbacks, network rules, and secret configuration.
- Keep development, preview, and production environments separate.
- Keep news and dictionary API credentials server-side when required.
- Browser extension is a separately packaged client that must authenticate safely with the application; do not assume dashboard authentication automatically secures extension APIs.

## 4. Phased implementation plan

### Phase 0 — Baseline and inventory

- [x] Confirm this roadmap as the agreed source of truth.
- [ ] Complete the `ogenotes` inventory: routes, components, styles, data models, tests, and deployment assumptions.
- [ ] Create a file-by-file reuse map: reuse unchanged, port with adaptation, replace for security, or omit.
- [x] Review the original README, package manifest, shared-access proxy/authentication, MongoDB helper, homepage, theme toggle, and primary stylesheets; identify shared access as unsuitable for production.
- [ ] Confirm the final dependency lockfile and runtime through a clean install and CI build.
- [x] Keep `ogenotes` untouched; all current changes are confined to `oge`.

**Exit criteria:** a reviewed migration map, identified security-sensitive code, and no production code copied blindly.

### Phase 1 — Repository foundation and visual parity

- [x] Establish the initial Next.js project structure and development instructions in `oge`.
- [x] Port the original primary stylesheets, theme toggle, and favicon; create a responsive dashboard shell with the agreed nine modules.
- [x] Add the first responsive Notes workspace with subject navigation, search, create/edit/delete, tags, favorites, and revision snapshots; advanced features from the original editor are not yet ported.
- [x] Exclude file-storage dependencies from the new package; legacy shared-access code has not been copied.
- [x] Add ESLint configuration, baseline tests, and a GitHub Actions workflow; verify the workflow passes before treating this gate as complete.

**Exit criteria:** the app builds; visual comparison shows the same design language; the reference repository remains unchanged.

### Phase 2 — Secure identity and data foundation

- [ ] Configure Google OAuth/OIDC credentials and exact callback URLs in Google Cloud for local and production environments.
- [x] Add Auth.js Google provider configuration, server-side account upsert using Google's stable `sub`, JWT session callbacks, and a sign-out action; verify full lifecycle in CI and a real OAuth environment.
- [x] Add a server-only MongoDB Atlas connection helper and initial owner-scoped index definitions; configure the production Atlas user/network rules before deployment.
- [x] Define initial account and news-preference fields plus indexes for notes, subjects, quick notes, and saved links; refine schemas during feature porting.
- [ ] Implement reusable server-side authorization helpers and ownership-scoped API access for every feature. Notes and subjects endpoints are now owner-scoped; other feature APIs remain pending.
- [ ] Add integration tests proving User A cannot read, modify, search, export, or delete User B's records; current tests check the presence of owner filters but do not replace runtime isolation tests.
- [ ] Add migration/seed guidance without using real user data or secrets in tests.

**Exit criteria:** Google login works in the test environment; all user data operations are ownership-scoped; cross-user isolation tests pass.

### Phase 3 — Core knowledge features

- [x] Implement baseline Notes and subject CRUD with server-enforced ownership checks and request-size limits; [ ] complete feature parity and cross-account integration testing.
- [x] Implement baseline Quick Notes create, edit, delete, and list flows with owner-scoped storage; autosave and offline support remain future enhancements.
- [x] Implement Saved Links create, edit, delete, search, URL validation, safe external-link rendering, and reasonable field/length limits; ordering UI remains a follow-up.
- [x] Implement a first active-recall Revision queue with owner-scoped due cards and 1/3/7/14-day review intervals, plus a Revision History viewer for stored previous note versions; richer spaced-repetition algorithms remain future work.
- [ ] Port existing flashcard/revision functionality only where it supports the agreed dashboard scope.
- [ ] Preserve existing search and theme behavior where compatible.
- [ ] Ensure all queries and mutations are authenticated and user-scoped.

**Exit criteria:** core features work end-to-end for multiple independent test accounts, with no file-storage paths.

### Phase 4 — AirNotes, dictionary, news, and browser extension

- [x] Inspect the original AirNotes behavior and port its separate personal knowledge workspace, navbar, and pixel-strip component into `oge` with owner-scoped storage.
- [x] Port the original dictionary lookup with dictionaryapi.dev and Wiktionary fallback, timeout handling, and input validation. [ ] Complete a documented provider terms/attribution review before public deployment.
- [ ] Select a news provider/source and verify license, attribution, rate limits, cost, and outage handling.
- [x] Implement optional news-interest onboarding/settings and use the stored interests to personalize the RSS feed; skipped interests receive general topics.
- [ ] Verify that users who skip interests receive a general feed.
- [x] Add a Manifest V3 Chrome extension MVP with active-tab capture, locally stored token, and optional host permissions.
- [x] Authenticate extension saves with a hashed, expiring bearer token; resolve the owner from the token record and enforce owner-scoped Saved Links writes. [ ] Perform a manual end-to-end Chrome test and review token lifecycle before public release.

**Exit criteria:** these features work without weakening authentication, exposing API keys, or exceeding provider terms.

### Phase 5 — Security, privacy, and resilience

- [ ] Validate and safely render all user-generated content, including Markdown and saved URLs.
- [ ] Complete CSRF protections and security headers, including a suitable enforced Content Security Policy. Same-origin `Origin`/`Referer` checks guard state-changing cookie-authenticated API requests in `proxy.js`.
- [x] Add baseline security response headers (`nosniff`, frame denial, referrer and permissions policies) and a CSP in report-only mode to gather compatibility signals.
- [ ] Review CSP reports against the real app and Google sign-in flow, remove unnecessary allowances (especially inline scripts/styles and broad `https:` sources), then enforce a tested CSP. An opt-in `OGE_ENFORCE_CSP=true` deployment flag is available but **not validated or enabled**; HSTS is added only in production.
- [ ] Add rate limits, request-size limits, pagination, query bounds, and safe error responses.
  - In progress: shared MongoDB-backed limits protect Gemini cleanup/key management, extension token creation/revocation/saves, news, dictionary, backup import/export, and owner-scoped mutations for Notes, Subjects, Quick Notes, AirNotes and Saved Links. Subject queries are capped; revision rating mutations have 120/minute/account and history restores 30/hour/account. Runtime load testing and broader API coverage are still needed.
- [ ] Redact credentials, tokens, session values, and sensitive note content from logs.
- [ ] Add dependency vulnerability scanning and secret scanning to CI.
  - CI runs a production dependency audit, a limited tracked-file pattern check and a dedicated Gitleaks Git-history scan; review its CI results, any alerts and public build artifacts before sign-off.
- [ ] Verify environment secrets are never included in client bundles, logs, commits, or public build artifacts.
  - A post-build CI check now scans client and prerendered artifacts for synthetic server-only secret canaries; production deployed bundles and real traffic still require inspection.
- [ ] Configure database backups and perform a restore test.
- [ ] Define data export, account deletion, retention, and handling of backups after deletion.
  - Mutations now fence to the signed Auth.js session version (or validated extension bearer token), preventing an old in-flight request from acting on a newly re-created account with the same Google identity. Backup import and subject deletion are also version-fenced; live concurrency verification remains pending.
  - Subject, Note, Quick Note, AirNote, Saved Link and extension-saved-link creation use transactional account-row guards against deletion races. Note, Quick Note, AirNote and Saved Link edits/deletes, plus Saved Link reorder, now use the same guard; revision rating and history restore now use that guard too. Gemini key changes, extension token issuance/revocation and onboarding preference updates now also require the original signed session version, not just a matching Google identity. Account deletion now rechecks the original signed session version inside its transaction to reject stale deletes after recreation. Other in-flight mutations and staging verification remain outstanding.
  - Subject deletion now atomically removes the subject and its notes in a MongoDB transaction; staging rollback and concurrent-write tests are outstanding.
  - JSON backup exports now read a consistent owner-scoped snapshot and check the signed session version inside that snapshot, avoiding stale-session exports after re-registration; live Atlas tests remain pending.
  - JSON backup restores now require an all-or-nothing MongoDB transaction. Unit tests cover transaction invocation and failure propagation; Atlas rollback and concurrent deletion must still be verified in staging.
  - JSON backup includes AirNotes, note revisions and review schedules while preserving older v1 imports. A feature-flagged account-deletion route and global session version checks exist, and a guarded disposable-account staging drill is available. Deletion remains disabled by default pending actual staging security/rollback tests, backup retention policy, and complete preferences review. See `docs/PHASE5_OPERATIONS_RUNBOOK.md`.
- [ ] Add monitoring and alerts for errors, abnormal request rates, database capacity, and provider/API failures.
  - An authenticated, sanitized `/api/health` endpoint checks app/database readiness with a dedicated server-only bearer token; actual monitor configuration, alert delivery, database-capacity/backup alerts and provider monitoring remain outstanding.
- [ ] Test session expiration, logout, account switching, malformed inputs, XSS, CSRF, access-control bypass, and rate limiting.
  - A staging-only two-account isolation smoke test now covers Notes, Subjects, Quick Notes, AirNotes, Saved Links, Revision/History, and Backup export; it has not yet been executed with real staging credentials.
  - A separate non-destructive staging authentication/CSRF drill now checks private API reads, invalid session rejection and origin guards; it also remains unexecuted without staging accounts. Backup import, extension, settings, OAuth and full multi-module isolation evidence remain required.

**Exit criteria:** documented test results for security and recovery; no unresolved critical/high findings that block release.

### Phase 6 — Private deployment and release readiness

Phase 6 implementation has started with a read-only deployment configuration preflight and a private staging checklist. These are preparation only; **staging is not deployed and no live environment verification has been completed.** See [Phase 6 staging guide](docs/PHASE6_PRIVATE_STAGING.md).

- [ ] Deploy to a private/staging environment using separate credentials and database configuration.
- [ ] Run end-to-end smoke tests on desktop and mobile-sized layouts.
- [ ] Test at least two separate Google accounts and verify data isolation across every feature.
- [ ] Test backup restoration, database failure handling, news/dictionary provider failure, and extension authentication.
- [ ] Publish privacy policy, terms, contact/support path, and clear explanations of what data is stored and why.
- [ ] Complete applicable Google OAuth consent-screen verification and production configuration before public registration.
- [ ] Review hosting costs, Atlas limits, quotas, monitoring, incident response, and rollback procedure.
- [ ] Open registration only after release gates are signed off.

**Exit criteria:** private test is stable; security and privacy requirements are met; release owner explicitly approves public launch.

## 5. Security acceptance criteria

These criteria are release blockers, not optional polish:

- [ ] No shared access string or legacy shared-password gate remains as the production authentication mechanism.
- [ ] All application data access requires a valid session and server-side ownership enforcement.
- [ ] Cross-user isolation tests pass for reads, writes, deletes, search, history, and exports.
- [ ] OAuth flow validates state/nonce and token claims; redirect URIs are restricted to registered values.
- [ ] Session cookies and session invalidation are configured securely for the deployed environment.
- [ ] MongoDB credentials are server-only, least-privilege, and absent from the repository and browser bundles.
- [ ] Inputs and rendered user content are validated/safely rendered; sensitive mutations have CSRF/origin protection.
- [ ] Rate limits and bounded queries prevent straightforward resource-exhaustion abuse.
- [ ] Dependency and secret scanning run automatically; no unresolved critical/high findings remain without documented mitigation.
- [ ] Backups and restoration are tested; data export/deletion and retention behavior are documented.
- [ ] Privacy disclosures accurately describe Google sign-in, stored data, news interests, and third-party providers.

## 6. Explicitly out of scope for the initial release

- PDF uploads, image uploads, attachments, and file storage of any kind.
- Google Drive authorization or Picker.
- User-provided MongoDB Atlas URIs or bring-your-own database support.
- Rewriting the whole app from scratch when existing code can be safely reused.
- Public launch before the security and operational release gates pass.
- Unreviewed changes to the original `ogenotes` repository or its deployment.

## Future milestone — Oge Vault (hybrid draft architecture; draft PR #35)

**Architecture decision — 15 November 2026:** The owner approved a change from absolute GitHub-only note-content storage to **GitHub-authoritative committed notes with temporary MongoDB drafts and browser sessionStorage recovery**. This revises the previous no-content-in-MongoDB contract; the earlier GitHub-only preview code remains valid as a prototype, not proof of the new system. The main `/notes` route and existing legacy notes remain unchanged until an explicitly verified cutover.

### Storage and UI contract

- **GitHub (mandatory private, user-owned vault)** is authoritative for *committed* Notes, Quick Notes, AirNotes, revision history, future Learning Tracks notes, extension/imports/restores. Only a confirmed GitHub write may show **Saved**; GitHub remains the source of truth during reconciliation.
- **MongoDB `vault_drafts`** may temporarily hold authenticated, owner/repository/note-scoped note headings, bodies and tags for responsive autosave and cross-session draft recovery. It is not a permanent notes mirror and must never be read as if it were a confirmed GitHub version. Drafts use monotonic revision fencing and explicit base GitHub blob SHAs; stale writes cannot replace newer drafts. Do not automatically TTL-delete uncommitted drafts. Apply per-owner access, size limits, encryption-at-rest controls, documented backup retention, redacted logging, and deletion-on-confirmation only if the matching draft revision is still current. Audit plaintext exposure and backup policies before staging release.
- **Browser `sessionStorage`** provides a best-effort same-tab recovery layer, not permanent storage. Cross-tab and offline cases need explicit handling. Clearly display *Draft saved*, *Saving…*, *Saved*, *Sync pending*, *Conflict* and *Recovery needed* states, with no false positive success.
- **MongoDB `vault_files`** is an optional metadata index of opaque note ID, subject ID, GitHub file path, repository ID, SHA and sync status. It contains no note titles or bodies; it is a derivative catalog and MUST reconcile with the GitHub tree (including external edits/deletions). Use owner/repository/note unique indexes; never use stale metadata SHA as permission to overwrite GitHub.
- **Save button** (label exactly **Save**, never **Save to GitHub**) requests an immediate final GitHub commit. A server-confirmed result is required for *Saved*. Periodic background synchronization is a separate, opt-in/tested safety layer; an unreliable browser-close event is never the sole commit trigger.
- **Failure safety:** GitHub 409/429, revocation, network timeouts and ambiguous commits preserve pending drafts. A server retry worker (if implemented) needs bounded retries, idempotent reconciliation, and observable pending jobs. No unsafe auto-merge. Protect deletion, subject changes, concurrent edits, account deletion, revisions and rollback across GitHub and MongoDB.
- **Vault mandatory gate:** Google/GitHub login provider is independent of vault authorization. Narrow GitHub App installation permissions/selected-repository scope before release. No automatic email-based account merge.
- **Legacy cleanup:** previous MongoDB note fixtures are disposable *only after per-environment inventory and explicit approval*. Never delete unexpected real records or unsynced drafts. Review backup retention separately.

### Milestones and release gates

- [x] **A — GitHub App and private vault provisioning prototype:** authenticated installation, private repository, account mapping, retro onboarding. Live staging verification and selected-repository least-privilege permission design remain blockers.
- [x] **B1 — GitHub Notes CRUD prototype:** SHA-guarded CRUD against private vault.
- [x] **B2 — Atomic batch synchronization prototype:** Git tree/commit batches and GitHub confirmation.
- [x] **B3 — Original sessionStorage + GitHub autosave preview:** retained as a separate working prototype; does NOT implement hybrid MongoDB drafts.
- [x] **B4 — Familiar Notes staging adapter:** isolated `/vault/notes` and GitHub-only CRUD; production `/notes` unchanged.
- [x] **B5.1 — Subject deletion safeguard:** block unsafe legacy deletion for connected Vault accounts.
- [x] **B5.2 — Snapshot GitHub pagination:** paged tree/blob reads and `/vault/preview` Load More.
- [x] **B5.3a — Familiar Notes pagination/edit warnings:** paged `/vault/notes`, unsaved-change guards; not autosave.
- [ ] **B5.3b — Hybrid draft autosave (existing/new note editor integration and reconnect safety committed; live staging verification pending):** feature-flagged, revision-fenced MongoDB drafts and sessionStorage recovery, preserving local input under offline/retry failure, and no changes to production `/notes`. Owner/session/repository permissions and validation tests required.
- [ ] **B5.3c — GitHub-aware subject deletion (read-only preflight, write fences, reversible lock coordinator and durable inspection journal committed; destructive operation still disabled):** inventory all associated GitHub notes, commit deletions safely with SHA checks, coordinate MongoDB metadata, and recover partial failures. Never delete a subject with unsynced drafts silently.
  - The B5.3c internal locked inspection remains advisory-only and token-fenced. A metadata-only `vault_subject_inspections` journal records prepared/locked/inspected/released/blocked/needs-recovery states, with owner-scoped operation identifiers and no TTL. The staging read-only preflight now records these operations and supports operation-ID diagnostics, including inconsistent lock-state warnings. An optional `plan=true` preview produces a complete snapshot-pinned metadata-only GitHub deletion manifest under a temporary inspection lock, rejecting pending drafts, stale pagination and incomplete scans. A new internal `vault_subject_deletion_jobs` preparation model records operation IDs, snapshot manifest SHA-256 fingerprints, file counts and recovery states without copying note contents; it releases its inspection lock and cannot authorize any later deletion. An **unwired internal GitHub delete executor** now validates an explicitly-authorized, operation-owned lock, a fresh GitHub snapshot and file blob SHAs, and persists commit intent before one atomic non-force Git ref update. Its internal reconciliation helper can confirm a lost response only when the recorded target ref, commit tree and parent match GitHub; otherwise it preserves the journal and lock for manual review. Both are disabled from user routes; the executor also requires an independently disabled server flag and no code grants the required destructive authorization. It **does not delete MongoDB subject metadata**. Ambiguous commits preserve the lock and journal for later reconciliation. An unwired, independently disabled **metadata-retirement** helper now rechecks the signed account/repository mapping, owner-held lock, confirmed GitHub commit and live empty subject, plus absence of temporary drafts, legacy MongoDB notes, unresolved `vault_files` entries, and last-subject deletion. Its MongoDB changes are transactional and retain the subject record and lock as a recoverable tombstone. It does **not** physically delete subject metadata. Live staging tests, complete mutation-path audit, an authorized durable coordinator, external GitHub writer race handling, and eventual safe physical purge remain open. No destructive endpoint is enabled. Ambiguous lock releases require manual review, never automatic deletion or unlock. No cross-store deletion endpoint is authorized. Complete durable destructive-job recovery, all mutation-path audits and live staging races before enabling deletion.
- [ ] **B6 — GitHub file catalog (scanner, transactional metadata sync and staging API implemented; live verification and scale limits pending):** metadata-only `vault_files` and `vault_file_index_state` compound indexes; complete snapshot-pinned, content-discarding GitHub pagination; owner/repository-scoped idempotent upserts, soft tombstones for external removals, per-repository run fence, and post-write GitHub-head revalidation. The staging-only `/api/vault/file-index` GET exposes last-known metadata (never live authority); POST manually refreshes with explicit rate limits and an independent default-off flag. The SHA-cached incremental scanner now supports complete metadata scans up to GitHub's bounded 30,000-entry tree, fetching only changed blobs and using 250-row transactional MongoDB batches. More than 500 changed/uncached blobs still fails closed without partial publication. A new internal resumable first-time bootstrap stages validated metadata in operation-scoped, indexed 100-note batches with a transactional cursor, but does not yet publish into `vault_files` or have a user-facing endpoint. An internal staged-index promotion now validates every staged row against the exact current GitHub tree, publishes bounded metadata batches and soft tombstones inside one MongoDB transaction, then rechecks GitHub HEAD. The resulting `verifying` state is recoverable through the B6 reconciler after an ambiguous final verification; the code remains intentionally unwired from public routes. Live MongoDB transaction stress tests on large repositories, GitHub rate-limit-aware scheduling, and tree-truncation handling remain release blockers. A staging-only diagnostic now inspects sync state; an explicit, authenticated reconciliation verifies exact owner/repository-scoped MongoDB metadata against a freshly scanned GitHub snapshot and GitHub head before releasing a committed `verifying` state to `ready` or `stale`. Unsafe `syncing` states and mismatched metadata remain fenced for manual review. Live staging tests, interrupted `syncing` transaction investigation, and live promotion, interrupted-transaction tests and scaling verification remain pending. This index must NEVER authorize GitHub overwrites or imply permanent note content belongs in MongoDB.
- [ ] **B7 — Reliable final Save:** explicit Save button, atomic GitHub commit/reconciliation, pending-state UX, server retries/failed-sync recovery, post-confirmation conditional draft cleanup; optional periodic commits after testing.
- [ ] **C — Legacy test-data inventory and cleanup:** per-environment validation and explicit operator approval; retain pending vault drafts.
- [ ] **D — Hybrid storage cutover:** mandatory GitHub vault for confirmed note content; route every note/revision/backup operation through hybrid coordinator; privacy documentation, failure-path tests and release gate before enabling.
- [ ] **E — Quick Notes, AirNotes, Learning Tracks and browser extension:** extend hybrid write/recovery and metadata catalog; verify each content path, history, imports and export.
- [ ] **Security and operations:** field encryption strategy, MongoDB draft and backup retention, content audit, data subject deletion, GitHub App permission narrowing, live staging OAuth/installation, 429/backoff stress, browser mobile smoke, Mongo replica-set races and secret scan.

**Do not merge PR #35 or enable mandatory cutover without explicit approval.** Existing MongoDB fixture cleanup remains blocked until reviewed. Implementation notes: [Oge Vault Phase A](docs/OGE_VAULT_PHASE_A.md).
 
## 7. Working rules

1. Read before changing: inspect the existing implementation and tests first.
2. Reuse before rewriting: preserve proven components, but do not carry forward unsafe authentication or data-access patterns.
3. Small, reviewable changes: implement one phase at a time and keep the app buildable.
4. Test each phase: add tests alongside features, not at the end.
5. No secrets in Git: use local environment files that are ignored by Git and deployment secret stores.
6. Update this roadmap when scope changes; record the reason and acceptance impact.
7. Do not claim a feature or security gate is complete until it has been implemented and verified.

## 8. Current status

- [x] Product scope and architecture decisions documented.
- [ ] Phase 0 repository inventory and migration map.
- [ ] Implementation started.
- [ ] Security and release gates passed.
- [ ] Public launch approved.

**Current state: core features and the Phase 5 security implementation are merged into `main`; Phase 6 private staging and release validation are in progress. See `docs/PHASE5_SECURITY_VERIFICATION.md` for the evidence checklist and blockers. The original `ogenotes` repository remains read-only.**