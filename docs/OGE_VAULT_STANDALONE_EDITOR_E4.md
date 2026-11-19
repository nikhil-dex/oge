# Oge Vault — E4 / Milestone #72: Standalone Quick Notes and AirNotes staging editor

**Status:** optional signed-owner staging browser integration implemented for the
M70 GitHub CRUD and M71 temporary encrypted drafts. **Not production,
not a migration, not independently authenticated real-provider acceptance.**

## What this pilot allows

The isolated owner page `/vault/standalone-editor` has a separate,
**default-OFF** staging-only flag:

```sh
OGE_VAULT_STANDALONE_EDITOR_PREVIEW=true
```

This is effective only when all existing M70/M71 gates are also enabled:

```sh
OGE_VAULT_STANDALONE_PREVIEW=true
OGE_VAULT_STANDALONE_DRAFT_PREVIEW=true
OGE_VAULT_MAIN_PREVIEW=true
OGE_VAULT_NOTE_API_PREVIEW=true
OGE_VAULT_HYBRID_DRAFT_PREVIEW=true
MONGODB_DB=oge_vault_restore_staging_<disposable>
```

The complete `checkVaultStagingReadiness` check must pass, the signed
`AUTH_URL` must exactly match `OGE_STAGING_URL`, the signed account/session
incarnation must match, and the user must have a connected verified private
GitHub App repository. All destructive internal flags stay OFF. Never enable
on production or point it at a real user's private Notes.

1. Choose **Quick Notes** or **AirNotes**. Fetch a verified complete
   GitHub list from `GET /api/vault/standalone?kind=...`.
   Lists above 300 entries fail closed rather than truncate.
2. Select an existing committed GitHub entry (its current immutable blob SHA
   is rechecked), or choose **New capture**, which assigns a browser-generated
   stable opaque UUID. This UI pilots create/edit/list; **delete remains
   deliberately unavailable in the preview UI**.
3. Editing retains an isolated best-effort `sessionStorage` recovery record
   keyed by signed owner, connected repository ID, kind and capture UUID.
   This **is plaintext in the local browser tab's session storage**, never a
   remote MongoDB shadow copy. XSS, shared-device access and browser crashes
   remain risks; the local record may disappear with the browser session.
   The encoding allowlists only type, ID, content and base GitHub SHA.
4. After an 800 ms debounce, changes are autosaved to
   `PUT /api/vault/standalone-drafts` as **temporary encrypted MongoDB
   drafts** with strict revision-by-revision CAS, original GitHub blob SHA
   and authenticated owner/repository/type/ID/revision AES-GCM AAD.
   This is **NOT a GitHub commit**. Any ambiguous/failed autosave blocks
   further writes; the browser keeps its recovery copy.
5. The **Save to GitHub** button first drains the pending autosave and
   flushes the exact current editor snapshot to an encrypted draft. Only
   then does it send exactly one `POST` (new) or `PUT` (existing) to the
   verified M70 GitHub capture endpoint, with the same stable UUID and
   original GitHub revision SHA. No other UI action writes to GitHub.
6. A response is only acknowledged after checking GitHub format, kind, ID,
   expected changed blob SHA and exact content. The M71 cleanup POST
   obtains a separate `contents:read` owner/repo-scoped installation token
   and verifies the exact GitHub content again before deleting that exact
   encrypted draft revision. Only then does the UI clear the local
   pending-draft copy.
7. If the GitHub POST/PUT response is lost or cleanup is uncertain, the
   editor **locks** and offers **Check GitHub Save (read-only)**. That reads
   the current GitHub file for the same ID and resource kind, checks its
   contents and exact new SHA, then attempts only the M71 verified draft
   cleanup. It **does not issue another GitHub write**. Matching current
   bytes is not proof which device issued the previous write.
8. The editor can recover a bounded list of unfinished new captures and
   exact existing-entry drafts. Local-vs-server draft disagreement requires
   explicit user acknowledgment. The browser must not silently overwrite a
   newer draft revision or change GitHub base SHA. After an ambiguous draft
   PUT, **Re-read exact encrypted draft** unblocks only when server
   content and base SHA exactly match the browser copy.

## Safety and operational limitations

- No legacy standalone MongoDB permanent collection is read, written,
  migrated or deleted by this page. Production `/quick-notes`,
  `/airnotes`, `/api/quick-notes`,
  `/api/personal-quick-notes` and extension capture are unchanged.
  There is no extension-token-to-GitHub authorization bridge.
- The previous M70 backend supports create/update/delete, but destructive
  deletion is intentionally not wired to this initial UI.
- Browser session storage is **not encrypted** and must be reviewed for
  shared-device and XSS exposure before launch. The server-side AES-256-GCM
  draft key stays out of browser bundles.
- A complete resource-wide backup, historical revision UX, metadata-only
  idempotent receipt for a lost M71 cleanup response, owner-visible manual
  conflict resolution, cross-tab synchronization and robust offline
  recovery remain pending.
- Independent **real two-physical-device GitHub OAuth/App acceptance**,
  external evidence attestation, provider failure injection and security
  review have not been completed. CI/browser smoke tests do not authorize
  release or merge.
- No live provider credentials or real user Notes were changed. PR #35
  stays **DRAFT / UNMERGED** and all production flags default OFF.

## Tests

```sh
node --test tests/oge-vault-standalone-editor.test.js
npm run lint
npm test
npm run build
```

The E4 tests cover owner/repository/type/UUID browser recovery isolation,
canonical browser payloads, invalid/oversized content, read-only GitHub
identity/format/content/revision confirmation, signed staging page gates,
explicit one-call GitHub Save and preservation of legacy APIs.
