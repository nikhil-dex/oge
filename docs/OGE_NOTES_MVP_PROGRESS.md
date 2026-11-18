# Oge Notes — implementation progress scorecard

**Updated 18 November 2026, after milestone #116 code changes.**
This progress measure is deliberately about the practical note-taking MVP,
not the previous uncalibrated ~96% prototype number.

## Progress snapshot

- **Implementation checkpoints: 8/10 (80%) implemented in the draft branch.**
  Checkpoint #8 covers **new captures** from Quick Notes, AirNotes and
  extension. It does NOT claim that historical MongoDB notes were migrated.
  This is a count of agreed deliverables, NOT a percentage estimate of
  engineering effort, production readiness, or operational reliability.
- **Real-account end-to-end journeys independently verified here: 0/3 (0%).**
  Automated CI, synthetic MongoDB integration and browser smoke tests do not
  prove that signing in and committing to GitHub work on a deployed site.
- **Production released: No.** PR #35 remains draft and unmerged. Deployment
  is the last item. Check the current GitHub Actions run before declaring
  final CI success.

## Exactly what 8/10 means

| # | Concrete user outcome / delivery checkpoint | Implementation | Live connected-account proof |
| --- | --- | --- | --- |
| 1 | Sign in and connect a personal private GitHub Vault | Built | Pending |
| 2 | Create, read, edit, favorite and delete committed GitHub Notes | Built | Pending |
| 3 | Create and select study subjects | Built | Pending |
| 4 | Temporary draft autosave plus explicit GitHub Save | Built | Pending |
| 5 | Quick Capture: single-line thoughts or title + body, auto-pick sole subject, ready next note | M108 usability improvements | Pending |
| 6 | Find Notes beyond first 20 via progressive GitHub page loading | Built | Pending |
| 7 | Visible draft-versus-GitHub Save state, word counts, direct reader Edit, accessible Save and keyboard shortcut | M106 implemented | Pending |
| 8 | **New** Quick Notes/AirNotes/extension captures use the GitHub Vault for connected owners | M107 built (legacy records not migrated) | Pending |
| 9 | Real-account create/edit/save/reload/recover/search/mobile journeys verified | Not yet | Pending |
| 10 | Production cutover, merge and deployment with no lost Notes | Not yet | Pending |

The original Notes and independent Quick Notes/AirNotes/extension endpoints
still exist for unconnected accounts. M107 routes connected users' new
standalone captures through the existing GitHub Quick Capture editor, and
the updated extension uses a dedicated owner-connected GitHub writer.
**Historical MongoDB records are untouched and not migrated.** This is not a
promise that all prior AirNotes and Quick Notes appear in the Vault.

## Milestone #108 usability improvements (does not increase the denominator)

- A one-line thought is now enough to create a valid GitHub Note. Its
  first nonempty line becomes a recognizable short title, while the full
  original thought stays in the Note body. Explicit title + body still works.
- For accounts with only one subject, Quick Capture automatically selects it,
  while preserving the existing unfinished-draft recovery path.
- Quick Capture's **Notes** navbar now points to the connected GitHub Notes
  editor instead of the older MongoDB workspace.
- The floating extension shares the same one-line conversion and now explains
  it in the editor. No change to destination, authorization or data store.
- Real GitHub and Chrome verification remains pending. This is polish on
  existing checkpoint #5, so the implementation score remains **8/10 (80%)**
  and real account verification remains **0/3**.

## Milestone #109 — Do not lose text during Save or draft recovery

- **Quick Capture draft recovery:** Preserve the exact text typed in the
  browser, including a one-line capture, when its normalized heading/body
  matches the acknowledged temporary encrypted draft. Previously a one-line
  capture could be reconstructed as two duplicate lines after reopening.
  Divergent browser text still requires an explicit recovery choice.
- **Extension Save response:** Snapshot submitted text and subject at the
  moment of clicking Save. A slow GitHub response cannot erase newer typing
  or a changed subject. Show that the earlier version was saved and newer
  edits still need Save; failed responses preserve the editor copy.
- **Duplicate click prevention:** A concurrent click during an in-flight
  request is ignored, including if subject reload inadvertently reenables
  the button. Unconfirmed GitHub Save retains the original capture UUID for
  a retry with unchanged input.
- **Executable regression tests:** Use a Node VM harness to execute the
  extension's real click handler under delayed, failed and duplicate
  response scenarios. Test one-line/two-line/whitespace draft recovery
  equivalence and divergent local copies.
- **No change in the MVP checkpoint count:** 8/10 (80%) implemented,
  0/3 real connected-account journeys verified. This is an existing
  workflow correctness fix, not a new product feature or release gate.

## Milestone #110 — Recover a browser-only note into a writable editor

- **Bug fixed:** Previously, if sessionStorage held a locally typed Note but
  the MongoDB temporary draft was not yet created (e.g. a page reload before
  the 900 ms autosave), Quick Capture offered recovery but then *blocked
  writing and Save indefinitely*. Now it restores a writable capture and
  preserves the original local text.
- **Read one GitHub Note by ID:** The already-authenticated
  `/api/vault/notes-main?id=<note UUID>` GET checks whether a stale local
  pointer was committed earlier. If yes and text matches, report the Note
  already saved instead of creating a duplicate. If the Note differs,
  preserve the newer local edits under a new UUID.
- **Offline/unconfirmed read:** When GitHub cannot confirm the earlier ID,
  retain the browser copy under a new UUID, allow editing, and warn the
  user to check previously saved Notes before committing.
- **Tests:** Executable unit scenarios in
  `tests/oge-vault-browser-recovery-m110.test.js` for absent, saved,
  edited-since-save, offline, mismatched subject, malformed and partial
  drafts. The endpoint is read-only and uses the existing signed owner
  Vault session.
- **Practical live testing:** `docs/OGE_NOTES_LIVE_ACCEPTANCE.md`
  documents the exact Save/reload, browser-only recovery and Chrome/
  mobile tasks. They are **NOT RUN** against real credentials here;
  browser access was unavailable from this conversation.
- **Progress unchanged:** 8/10 (80%) implementation checkpoints built
  and 0/3 real account journeys independently verified. This repairs
  checkpoint #5's recovery UX; it does not satisfy checkpoint #9.

## Milestone #111 — After Save, actually find your Note again

The GitHub directory's paged list is ordered by filename UUID, so a newly
saved Note could be absent from the first page immediately after Save.
The Notes and Quick Capture editors now remember only the last five
confirmed Note IDs in browser localStorage, scoped by owner and repository,
and read the real Note contents from GitHub on reload. The Chrome widget
also offers an explicit user-clicked **View last saved GitHub Note** action
that opens the specific saved Note's deep link in Oge.

The new test fixture exercises 25 GitHub Notes with the most recently saved
Note outside page one, then verifies a fresh **create → reload → edit →
reload** roundtrip. Local storage holds no permanent Note body or GitHub
credentials. On a different device, full pagination/search remains the
supported discovery path until a chronological provider index exists.

**MVP score unchanged:** 8/10 checkpoints (80%) implemented; 0/3 real
connected-account user journeys verified. Simulated GitHub provider tests
are not live GitHub account acceptance.

## Milestone #112 — Saved Note link opens the reader

The Chrome extension's **View last saved GitHub Note** action now opens
that Note in the actual reading panel, not merely the correct subject.
The user can immediately tap **Edit note**. Reloading the list after Save
does not reopen the same reader unexpectedly. If the requested UUID cannot
be retrieved, the Notes page shows an actionable message.

This adds a deterministic link-resolution and reader-wiring regression
test; it does **not** prove real connected account behavior. **Progress
stays 8/10 (80%) implemented and 0/3 live user journeys verified.**

## Milestone #113 — Follow-up extension Save updates the original Note

Previously, if someone continued typing while a floating-widget Save was
in progress, pressing Save again created a *second* GitHub Note.
The extension now keeps the confirmed Note's ID and GitHub SHA while the
newer text remains unsaved; a subsequent Save updates that Note instead.
The existing GitHub Note metadata is preserved, and a failed response
retains the same ID/revision so a retry does not create another file.

The backend gained a selected-owner `PUT /api/extension/vault-note`
operation. New executable simulated widget tests cover the two-Save
sequence, a lost Update response, and subject changes.

**No live account was tested here.** Implementation remains **8/10 (80%)**,
and independent real-account journey verification remains **0/3**.

## Milestone #114 — Explicit separate-Note option in the floating extension

When the first GitHub Save finishes but the user has typed newer text,
the extension now labels the main button **Update saved GitHub Note**
and displays **Save this as a separate Note instead**. Selecting the
second action preserves the newer text and makes the next Save create
a distinct GitHub Note in the same subject. The earlier committed
Note stays unchanged. No extra GitHub commit happens until Save.

The updated VM test harness exercises the actual extension Save/button
handlers and the new choice, including in-flight Save protection.
Connected Chrome and live GitHub acceptance are still **NOT RUN**.
The implementation score remains **8/10 (80%)**, with **0/3
independent real-account user journeys verified**.

## Milestone #115 — Find existing subject Notes across GitHub pages

A subject may appear empty when its Notes are not in the initial first
20 UUID-ordered GitHub files. The Notes page now explains that there
may be older pages and offers **Find older Notes in this subject**.
The button scans additional pages, stops when a Note in that subject
is found, and can be used again for large Vaults. It does not create
Notes or save any content automatically.

Runnable tests cover a subject hidden on later pages, no-match results,
and bounded/resumable scanning. This is a product usability fix, not
a real connected-account test. **8/10 (80%) implemented, 0/3 live
journeys verified; no production deployment.**

## Milestone #116 — Main Notes Save while continuing to write

Previously, if typing continued while a **new** GitHub Note was being
saved, the editor preserved the newer words but still treated the
next Save as **Create**. GitHub then rejected the duplicate Note ID.
Editing an existing Note during Save could similarly reuse its old SHA.

Now a confirmed Save stages the open editor as an edit of that same
committed Note, with the fresh GitHub revision and saved-text baseline.
The newer text remains in the editor, and pressing Save again uses
**Update** rather than a duplicate Create. The fast-reload browser
recovery copy also adopts the newly confirmed base SHA immediately.

The regression exercises a simulated GitHub create/edit/read roundtrip,
different revisions and source integration. **No real signed-in GitHub
or Chrome acceptance was possible from this conversation.** The
score remains **8/10 implementation checkpoints (80%)** and
**0/3 independently verified live journeys**; no production release.

## The three mandatory live journeys

1. **Committed Note roundtrip:** Connect real GitHub Vault, create subject,
   write Note, Save, reload/sign in again, edit and confirm GitHub Note content.
2. **Draft interruption and recovery:** Type an unsaved draft, interrupt the
   connection or reload, confirm the draft is recoverable, then explicitly
   Save without claiming GitHub success prematurely.
3. **Large library and mobile editing:** Search for an older Note beyond the
   first 20, Stop/Continue as needed, open in reader, tap Edit, change
   content on mobile, Save, reload and verify the Note.

Record actual environment, reproduction, expected/actual results, and
pass/fail for each live run. No extra cryptographic attestation required.

## Next work, in order

1. Finish merging the everyday GitHub Notes paths from the existing feature
   branch after a successful live smoke run.
2. Verify connected Quick Notes / AirNotes entry and extension subject Save
   with a real account and browser; ensure old extension versions clearly
   reject legacy writes for connected owners. Historical MongoDB records stay
   intact unless a separately requested migration is needed.
3. Fix genuine reported editor/mobile defects, and handle the existing
   legacy-note history if it turns out not to be disposable test data.
   Perform production cutover last.

**Rule:** Do not inflate implementation progress after adding tests or
documentation alone. Advance a checkpoint only after its user-facing
function exists in code. Live acceptance is separately recorded.
