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
- [ ] Define the browser extension's supported browser(s), permissions, saved-content behavior, and sign-in flow.
- [ ] Authenticate extension API requests independently and apply the same per-user authorization checks.

**Exit criteria:** these features work without weakening authentication, exposing API keys, or exceeding provider terms.

### Phase 5 — Security, privacy, and resilience

- [ ] Validate and safely render all user-generated content, including Markdown and saved URLs.
- [ ] Apply CSRF protections to state-changing cookie-authenticated endpoints and security headers including a suitable Content Security Policy.
- [ ] Add rate limits, request-size limits, pagination, query bounds, and safe error responses.
- [ ] Redact credentials, tokens, session values, and sensitive note content from logs.
- [ ] Add dependency vulnerability scanning and secret scanning to CI.
- [ ] Verify environment secrets are never included in client bundles, logs, commits, or public build artifacts.
- [ ] Configure database backups and perform a restore test.
- [ ] Define data export, account deletion, retention, and handling of backups after deletion.
- [ ] Add monitoring and alerts for errors, abnormal request rates, database capacity, and provider/API failures.
- [ ] Test session expiration, logout, account switching, malformed inputs, XSS, CSRF, access-control bypass, and rate limiting.

**Exit criteria:** documented test results for security and recovery; no unresolved critical/high findings that block release.

### Phase 6 — Private deployment and release readiness

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

**Current state: planning baseline only.**