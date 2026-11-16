# Oge Vault — E3 / Milestone #71: Standalone encrypted autosave and recovery

**Status:** server-side temporary encrypted draft foundation and default-OFF
staging API implemented. **Not** a production Quick Notes/AirNotes cutover,
complete browser integration or live OAuth/GitHub two-device acceptance.

## Storage guarantee

Confirmed Quick Notes and AirNotes still live **only in GitHub** as
`quick-notes/<UUID>.json` and `airnotes/<UUID>.json`. This milestone adds
temporary unsaved-draft storage in a distinct MongoDB collection named
`vault_standalone_drafts`. It contains the signed owner ID, exact private
repo ID, entry kind, UUID, revision and timestamps plus **AES-256-GCM
ciphertext**, never plaintext note content, first-line title or content
revisions.

No automatic TTL is configured. Until a verified Save clears a revision, an
encrypted draft may be the only remaining recovery copy. Deleting it on a
timer or silently ignoring a newer revision would risk permanent data loss.
A retention and deletion policy is still required before release.

The encryption key uses `OGE_VAULT_DRAFT_KEY` (exactly 32 bytes encoded as
64 hexadecimal characters, server-side only) with a **separate HKDF-SHA-256
subkey domain** from subject-linked hybrid drafts. Every encrypted revision
uses a fresh random 96-bit AES-GCM IV; authenticated associated data (AAD)
binds the draft to its owner ID, repo ID, **kind**, capture UUID and
**revision**. Files cannot be moved between accounts, Quick Notes/AirNotes,
IDs or versions without GCM authentication failure. Never commit the key,
ciphertext snapshots or captured plaintext to public GitHub issues or CI logs.

## Strict staging API

The independent **default-OFF** gate is:

```sh
OGE_VAULT_STANDALONE_DRAFT_PREVIEW=true
```

It is effective **only** if the M70
`OGE_VAULT_STANDALONE_PREVIEW=true` gate, Vault main/Notes/hybrid previews,
the complete `checkVaultStagingReadiness` protected HTTPS configuration,
the signed owner session, connected private GitHub Vault and disposable DB
`oge_vault_restore_staging_<disposable>` all pass. Production switches
remain OFF.

The staging-only endpoint `/api/vault/standalone-drafts` supports:

- `GET ?kind=airnotes&id=<UUID>`: recover one precise owner's encrypted
  draft (decrypted only for its authenticated owner). It does **not** call
  GitHub, allowing offline draft recovery when MongoDB is reachable.
- `GET ?kind=quick-notes&new=true`: recover the at-most-20 newest
  **unsaved new-entry** drafts for the authenticated owner/repo and kind.
  More than 20 yields an explicit recovery block, not a silently truncated
  list. Existing-entry drafts are recovered by exact UUID.
- `PUT` with JSON `{"kind":"quick-notes","id":"<UUID>","revision":1,
  "draft":{"content":"private text","baseSha":null}}` to autosave a
  temporary encrypted revision. Increment the CAS revision by **exactly
  one**; a duplicate first write, stale tab, skip or change in base GitHub
  blob SHA returns a conflict. For editing an existing committed GitHub
  capture, set `baseSha` to its exact verified 40-hex blob SHA; the SHA
  must not change mid-draft.
- `POST` with JSON `{"kind":"quick-notes","id":"<UUID>","revision":1,
  "sha":"<verified-current-GitHub-blob-SHA>" }` to **verify** an
  independently saved GitHub capture and retire the exact encrypted draft.
  It obtains an owner-scoped `contents:read` GitHub App token and pins a
  complete current immutable GitHub capture. It deletes the encrypted
  draft only if the current GitHub ID, kind, content and expected SHA
  match the exact original draft revision; existing entries must also
  have a changed blob SHA. A newer autosave revision or changed
  ciphertext prevents cleanup and stays intact.

All `PUT` and `POST` operations use the existing owner-wide
`withVaultOwnerDraftWrite` import/quarantine fence and signed account
session incarnation. No additional GitHub contents:write operation or
new permanent MongoDB content endpoint is introduced.

## Save and uncertain outcomes

1. Autosave is a **temporary encrypted MongoDB draft only**; the response
   always says `committedToGitHub:false` and `savedTo:
   "temporary-encrypted-draft"`. UI integration must also preserve a
   best-effort `sessionStorage` recovery copy while editing.
2. A future explicit Save button will submit the same exact UUID/content
   to the existing M70 `POST/PUT /api/vault/standalone` **once**.
   It will NOT be triggered by autosave, background requests or closing
   the browser. M70 already verifies GitHub CAS and the saved content.
3. A successful GitHub response may then be reconciled with the M71
   standalone draft `POST`, which itself **does only a read-only GitHub
   check and exact MongoDB CAS delete**.
4. A lost GitHub write response is **not proof of failure**; there must
   be **NO automatic retry**. Read the current GitHub capture via M70
   GET, reconcile exact ID/SHA/content, and keep any uncertain or newer
   draft. A matching current GitHub blob verifies **current content
   only**, not provenance of a particular HTTP attempt or independent
   live-provider acceptance. A lost draft cleanup response also cannot
   be construed as signed Save proof; M71 does not yet implement the
   metadata-only idempotent receipt mechanism used by the main Notes editor.

## Still pending

The normal Quick Notes, AirNotes and extension APIs/UI are unchanged and
continue to use the legacy storage paths until their separate staged
migration is approved. **No page-level client autosave wiring or browser
recovery workflow ships in M71.** Future milestones must add a bounded
owner UI with one explicit GitHub Save, optional `sessionStorage`
recovery, read-only unknown-write reconciliation, complete backup/export
coverage of both new resource types, provider 429/403 and mobile tests,
live physical two-device acceptance, and independent encryption/security
review.

No real user Notes, production flags or GitHub App installations were
modified by this implementation. PR #35 stays **DRAFT / UNMERGED**.

## Automated checks

```sh
node --test tests/oge-vault-standalone-drafts.test.js
npm run lint
npm test
npm run build
```

CI includes synthetic GitHub provider faults, disposable MongoDB replica-set
checks, Chromium desktop/mobile smoke and secret scanning. Successful
automated CI does **not** constitute independent authenticated staging or
cryptographic audit.
