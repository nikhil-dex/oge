# Oge Vault — E2 / Milestone #70: Standalone Quick Notes and AirNotes GitHub storage

**Status:** isolated, default-OFF staging API and verified GitHub-only storage
library implemented; **NOT** a production migration, live OAuth/App acceptance
or completed hybrid autosave/browser user experience.

## Model and resource separation

The existing subject Notes stored at `notes/<uuid>.json` remain completely
unchanged. Standalone resources are deliberately **not subject-linked Notes**:

| Resource | Private Git path | Format and contents |
|---|---|---|
| Quick Notes | `quick-notes/<uuid>.json` | `ogenotes-quick-note`, version 1, UUID, content, first-line title, timestamps |
| AirNotes | `airnotes/<uuid>.json` | `ogenotes-airnote`, version 1, UUID, content, first-line title, timestamps |

Each canonical file is at most 32 KiB. Content follows the existing
Quick Notes text normalization and maximum 20,000-character validation.
The title is always derived from the first line (up to 120 characters);
an empty draft is valid to retain the legacy capture semantics.

**Permanent content lives ONLY in the private GitHub Vault.** MongoDB can
hold authorized owner/Vault metadata, import fences, rate-limit state and,
in future phases, strictly temporary AES-256-GCM drafts; this milestone adds
no permanent MongoDB capture storage, cache, or shadow copies. The existing
legacy `quickNotes` and `personalQuickNotes` collections remain unchanged.

## Isolated staging-only API

The new `/api/vault/standalone` route is disabled by default. Enable ONLY
in a protected, disposable isolated staging environment:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
OGE_VAULT_STANDALONE_PREVIEW=true
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

It also requires `checkVaultStagingReadiness` to pass and destructive
preview flags to remain disabled. Every action requires an **Auth.js signed
owner and active account session incarnation**, private Vault mapping from
MongoDB, and a GitHub App installation token scoped ONLY to that private
repository. Read-only GET requests use a `contents:read` token.

Available preview methods:

- `GET /api/vault/standalone?kind=quick-notes` or `kind=airnotes`:
  returns a GitHub snapshot-pinned bounded list (max 300 items).
- `GET /api/vault/standalone?kind=quick-notes&id=<uuid>`:
  returns a single verified GitHub file and its blob SHA.
- `POST /api/vault/standalone`: create with explicit stable client UUID,
  `{ "kind": "quick-notes", "id": "<uuid>", "content": "..." }`.
- `PUT /api/vault/standalone`: update with exact expected
  `{ "kind": "airnotes", "id": "<uuid>", "sha": "<40-hex blob sha>",
  "content": "..." }`.
- `DELETE /api/vault/standalone?kind=airnotes&id=<uuid>&sha=<blob-sha>`:
  delete only the exact verified GitHub blob.

**There is deliberately no browser UI routing to this API in M70**.
The normal Quick Notes and AirNotes pages and extension still call legacy
APIs; the legacy cutover guard blocks permanent MongoDB fallback for a
connected Vault owner when its separate staging guard is enabled.

## Verified GitHub CAS and recovery limitations

1. GET reads one GitHub HEAD, immutable tree and each immutable Git blob.
   Every path, filename, UUID, file mode/size, canonical version/type/fields,
   timestamps and note text are validated; a final HEAD read rejects a
   moving snapshot. Up to five independent blob reads occur concurrently.
   Lists over 300, truncated trees, unexpected nested content or corrupt
   blobs fail closed instead of returning partial data.
2. A create/update/delete validates action/type/UUID and exact old blob SHA
   before writing. The Git HEAD is checked again before a new tree and commit
   are created. A single Git ref PATCH uses `force:false`. If a competing
   commit wins or an expected blob changed, **409** is returned, never an
   overwrite. The owner import quarantine also fences every mutation,
   including these standalone resources with no subject.
3. A GitHub mutation only reports success after verifying the new HEAD,
   commit tree, parent ancestry, final directory state and exact immutable
   blob content (or verified absence on deletion). A lost PATCH response is
   reconciled by **GET only**, without another PATCH.
4. If the Git ref moved but full proof is unavailable, the result remains
   **503 unconfirmed**. That is **not proof the write failed**. Keep the
   original stable UUID and data; never resend automatically. A later
   owner-facing signed read-only recovery flow is required before rollout.
5. GitHub maintains history even after a deleted file disappears from the
   current branch. This route does **not** implement secure data erasure.
   Separate account-deletion and retention policy review remains required.

## What is NOT implemented

- No Quick Notes/AirNotes browser integration, live provider signoff,
  extension-token GitHub authorization, background sync, permanent Mongo
  migration, separate encrypted autosave drafts, sessionStorage recovery
  adapters, full history UI or snapshot-pinned paging beyond 300.
- Notes-only backup/export from Phase D3 does **not** cover these paths.
  A complete Oge backup must include both kinds and their historical
  revisions or clearly mark them **excluded**. The old standalone MongoDB
  content is not copied to GitHub.
- No production flags, real user Notes or physical devices were used.
  PR #35 remains a draft; live GitHub/OAuth two-device testing, detached
  recovery provenance and independent security/cryptographic review remain
  release blockers.

## Synthetic verification

```sh
node --test tests/oge-vault-standalone-captures.test.js
npm run lint
npm test
npm run build
```

GitHub Actions also runs disposable replica-set tests, Chromium desktop
and mobile smoke, and secret scanning. CI passing is not live acceptance.

## E3 / M71 temporary encrypted standalone drafts

The optional separate `vault_standalone_drafts` MongoDB store and
`/api/vault/standalone-drafts` staging API now support versioned,
owner/repo/kind/UUID/revision-bound AES-256-GCM **temporary drafts**. This
is never a second permanent content backend: explicit Save still commits
to the private GitHub repository via M70. Signed GET/PUT support recovery
and CAS autosave; a read-only authenticated GitHub check on POST permits
CAS removal of the exact committed draft while preserving newer remote
autosaves. No silent retry, TTL, normal Quick Notes/AirNotes UI cutover,
extension token grant, complete backups or live provider signoff exists.
See `docs/OGE_VAULT_STANDALONE_ENCRYPTED_DRAFTS_E3.md`.
