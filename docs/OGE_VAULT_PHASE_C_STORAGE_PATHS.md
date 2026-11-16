# Oge Vault — Phase C static content-storage path audit

**Status: reviewed source-path inventory implemented; cutover remains blocked.**
This is a static source audit, not a production database scan, complete data
lineage proof, automatic migration, or permission to delete legacy records.

## Run the source guard

```sh
npm run vault:storage-path-audit
```

This command reads application, library, extension, and script source files from
the checkout. It does not connect to GitHub, MongoDB, OAuth or the live app;
it does not emit note content. Its guard also runs in unit tests and fails on
a new literal reference to `notes`, `quickNotes` or
`personalQuickNotes` that is not in the reviewed manifest, as well as an
unreviewed variable-based collection call. The checked-in manifest lives in
`lib/oge-vault-storage-path-audit.js`.

Passing this check means the **currently detected** legacy content paths
were mapped. It never authorizes cutover: static string matching cannot
prove there are no computed names, imported helpers, alternative stores,
runtime-generated write targets, external backups, browser storage or
unreachable branches.

## Confirmed content and workflow dependencies

| Source | MongoDB content use | Required action before mandatory Vault |
| --- | --- | --- |
| `app/api/notes/route.js` | Read/create/update/delete full Notes and revisions | Replace legacy CRUD for connected Vault users with GitHub-verified Save and draft recovery |
| `app/api/notes/cleanup/route.js` | Read legacy note identity before Gemini cleanup suggestion | Bind cleanup to the right GitHub note ID/SHA and owner without writing committed content to MongoDB |
| `app/api/backup/route.js` | Export full notes, embedded revision text, Quick Notes and AirNotes; **import their full bodies into MongoDB** | Replace both export and import pathways with GitHub-backed content, avoid reintroducing legacy copies |
| `app/api/revision/route.js` | Read full note text and save study-progress fields to legacy note | Route read to GitHub and place permitted progress metadata in approved owner-scoped storage |
| `app/api/revision-history/route.js` | Read/restore previous full note headings and answers in MongoDB | Use GitHub note history with immutable commit/SHA checks; retain older versions safely |
| `app/api/quick-notes/route.js` | Create/update/delete `quickNotes.content/title` | Move confirmed Quick Notes to GitHub; preserve encrypted temporary drafts |
| `app/api/personal-quick-notes/route.js` | Create/update/delete `personalQuickNotes.content/title` (AirNotes) | Move confirmed AirNotes to GitHub; preserve temporary drafts |
| `app/api/extension/quick-note/route.js` | Subject-linked capture writes full `notes`; standalone capture writes full `quickNotes` | Require extension capture through the Vault coordinator and stable owner/subject mapping |
| `lib/mongodb.js` | Legacy collection **index definitions only** | Review/index cleanup separately; does not itself store note content |
| `lib/atomic-subject-deletion.js` | Legacy MongoDB notes cascade removal | Keep connected Vault deletion fail-closed until GitHub and metadata transactional coordinator is validated |
| `lib/oge-vault-subject-finalization.js` | Read-only check that legacy subject notes are absent | Keep as a safety gate until the legacy note audit is complete |
| `lib/account-deletion-transaction.js` | Dynamically iterates collections for account deletion | Existing connected-Vault guard must stay until safe cross-store lifecycle handling is approved |
| `lib/google-account-link.js` | Dynamically checks whether a GitHub account has legacy content before linking Google | Preserve this non-migration safety check; add Vault owner/repo/draft checks before any future account consolidation |

## Additional related storage

- `lib/backup-note-metadata.js` exports/imports embedded revision heading
  and answer text, so the current backup format carries permanent note
  content outside GitHub.
- `vault_drafts` stores temporary **encrypted** unsaved note bodies.
  This is allowed pending confirmed Save and explicit retention review;
  automatic expiration would risk losing the only recoverable copy.
- `vault_files`, `vault_file_index_state`, `vault_file_index_bootstrap`,
  `vault_save_receipts`, and deletion journals should contain **metadata
  only**, never permanent note content.
- Browser `sessionStorage`, exported backup JSON files, user downloads,
  extension page state, and external backups require separate privacy,
  lifecycle, and owner-consent review. A source-path scan alone cannot
  inspect copies held outside the server.
- Legacy `notes.revisions` contains prior headings and answers embedded
  inside each note document. A collection count does not enumerate those
  individual versions.

## Non-negotiable cutover gates

1. **GitHub-only confirmed content:** every current writer must use the
   authenticated owner GitHub Vault for permanent note text, not MongoDB.
2. **Backup/restore:** must no longer create permanent MongoDB note bodies
   for connected Vault accounts, including older JSON backup formats.
3. **Revision history:** must preserve historical content in GitHub and
   protect restoration against racing branch revisions.
4. **Extension and mobile:** must have safe GitHub/temporary-draft handling,
   including offline/expired-token/permission failures.
5. **Safety:** preserve owner-scoped delete/account guards; do not clean
   unverified test rows or unsynced drafts.
6. **Acceptance:** review the complete storage map, run the read-only
   per-environment inventory, pass signed staging tests and obtain explicit
   approval before enabling mandatory cutover.

**No production endpoints were modified by this Phase C audit.** The existing
`/notes` application continues using the legacy backend until a separately
reviewed, tested cutover. PR #35 remains draft and unmerged.
