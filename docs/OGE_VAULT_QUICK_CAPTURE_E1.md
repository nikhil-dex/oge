# Oge Vault — E1/Milestone #69: Subject Quick Capture preview

**Implementation status:** browser UI, pure capture adapter, staging gate, and
synthetic tests. This is **not** live GitHub provider/two-device acceptance,
release authorization, full Quick Notes/AirNotes cutover or extension migration.

## Purpose and behavior

The **hidden** owner-authenticated `/vault/capture` page pilots subject-based
Quick Capture into the **existing** GitHub-backed Notes architecture. It
requires a fully connected owner's private Vault and deliberately opens only
on an isolated protected staging deployment when **all** gates below are
enabled; each gate defaults OFF:

```sh
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
OGE_VAULT_QUICK_CAPTURE_PREVIEW=true
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

It additionally requires the existing `checkVaultStagingReadiness` origin,
secrets, deployment and credential preflight, signed Auth.js owner identity,
owner-scoped active session incarnation and connected private GitHub App
repository metadata. Do NOT enable these flags on production or attempt to
use real private notes as staging fixtures.

1. Choose an existing owned subject. The user's **first line** is the note
   title (max 160 characters); remaining trimmed text becomes the body. A
   nonempty title and body, valid subject UUID and maximum 20,000 characters
   are required. This is a **normal GitHub Vault Note**, NOT a standalone
   Quick Note or AirNote; it therefore appears in the existing Notes editor.
2. A new capture receives a stable randomly generated note UUID. The browser
   stores a best-effort **sessionStorage-only** per-owner/repository/subject
   pointer and per-note content recovery copy. Nothing goes in localStorage.
   Browser cache can disappear; the user must keep a manual copy when needed.
3. Complete editor text is autosaved after a 900 ms debounce to the
   **existing** `PUT /api/vault/drafts` with strict incrementing
   `revision`, `baseSha:null`, owner and subject locks and an AES-256-GCM
   **temporary encrypted draft** in MongoDB. A failed or ambiguous autosave
   **blocks subsequent writes**, preserving the browser copy. No permanent
   Note is created on autosave.
4. Only an explicit **Save to GitHub** first flushes the exact editor snapshot
   to the encrypted draft, then sends one `POST /api/vault/notes-main`
   with the same exact note ID and body. The existing GitHub batch writer
   handles owner/repo verification, create-only non-fast-forward CAS and
   provider confirmation. The browser does **not** infer a successful GitHub
   Save from a temporary MongoDB draft.
5. Following a confirmed GitHub response, the browser calls the existing
   `POST /api/vault/drafts` to reconcile the exact encrypted draft
   revision against the GitHub blob and cleanup receipt. Only verified
   cleanup removes the local recovery copy. A lost/uncertain GitHub POST
   leaves the editor locked; **Check GitHub Save** invokes only the
   existing read-only `GET /api/vault/drafts?...confirm=true...`
   proof and verified draft reconciliation. It **never reissues GitHub POST**.
6. On reopening a subject, the app can offer recovered encrypted draft text
   from the existing owner-scoped `GET /api/vault/drafts?new=true`
   or a local sessionStorage copy. Differences require explicit user
   acknowledgment; multiple ambiguous drafts must be reviewed using the
   existing full Vault Notes editor.

## Boundaries and outstanding work

- This M69 page is explicitly **not a replacement** for the legacy
  `/quick-notes`, `/airnotes`, `/api/quick-notes`,
  `/api/personal-quick-notes` or browser extension token endpoints.
  Standalone entries still reside in legacy collections while that mode is
  enabled; the staging cutover guard blocks their fallback when activated.
  No old MongoDB permanent content is read, migrated, overwritten or deleted.
- No separate extension token is elevated into a GitHub write credential,
  and no new permanent MongoDB Note content path is introduced.
- This is a new owner browser flow built on a still-experimental GitHub
  Notes API. It has **no** live OAuth/App or physical two-device verification.
  A lost Save must not be retried without read-only reconciliation; an
  apparently missing Save is not proof it failed.
- Cross-tab, background sync, independent operator recovery, full
  Quick Notes/AirNotes separate GitHub file formats, extension capture,
  archived revision coverage, complete multi-resource backups, and release
  cutover remain future milestones. The M67/M68 evidence audit and external
  acceptance are still pending.
- `PR #35` remains DRAFT/UNMERGED and production flags OFF.

## Local tests

```sh
node --test tests/oge-vault-quick-capture.test.js
npm run lint
npm test
npm run build
```

CI includes disposable MongoDB integration and existing Chromium smoke; these
do **not** amount to signed live provider/two-device acceptance.
